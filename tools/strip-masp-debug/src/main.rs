//! Strips MASP `debug_info` sections from Miden packages embedded in a compiled WASM binary.
//!
//! The protocol crates `include_bytes!` their MAST packages assembled with debug info — ~8MB
//! of rodata in the browser bundle — and expose no build-time knob to turn it off. The strip
//! itself is the VM's own [`Package::without_debug_info`]; the work here is locating packages
//! inside the linked binary and rewriting them without moving any bytes: each stripped package
//! is padded back to its exact original length with a zero-filled custom section (WASM data
//! offsets are baked constants), and wasm-opt's memory-packing pass then drops the zero runs
//! from the emitted file.
//!
//! Wired into production builds via the `WASM_OPT_BIN` shim
//! `crates/web-client/scripts/wasm-opt-with-masp-strip.sh` (see `rollup.config.js`). Dev and
//! fast builds skip it so VM errors keep `assert.err` messages and source spans.

use std::cmp::Ordering;
use std::io::Cursor;
use std::path::Path;
use std::process::ExitCode;

use miden_core::serde::{Deserializable, Serializable};
use miden_mast_package::{Package, Section, SectionId};

const MAGIC: &[u8] = b"MASP";
const PAD_SECTION_ID: &str = "web-sdk-padding";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: strip-masp-debug <binary-file>...");
        return ExitCode::from(2);
    }

    let mut failed = false;
    for path in &args {
        match strip_file(Path::new(path)) {
            Ok((count, zeroed)) if count > 0 => {
                println!(
                    "[strip-masp-debug] {path}: stripped {count} packages, zeroed {:.2}MB",
                    zeroed as f64 / 1048576.0
                );
            },
            Ok((..)) => {
                // Zero packages stripped means the MASP encoding drifted and the strip silently
                // stopped working — fail loudly instead of shipping the debug info unnoticed.
                eprintln!(
                    "[strip-masp-debug] ERROR: {path}: no MASP packages stripped — package \
                     format drift after a dependency bump? Rebuild this tool against the new \
                     miden-mast-package or update the build wiring."
                );
                failed = true;
            },
            Err(e) => {
                eprintln!("[strip-masp-debug] ERROR: {path}: {e}");
                failed = true;
            },
        }
    }
    if failed { ExitCode::FAILURE } else { ExitCode::SUCCESS }
}

/// Strips every MASP package found in the file, in place. Returns the number of packages
/// rewritten and the total bytes zeroed.
fn strip_file(path: &Path) -> Result<(usize, usize), String> {
    let mut data = std::fs::read(path).map_err(|e| format!("read failed: {e}"))?;
    let mut count = 0usize;
    let mut zeroed = 0usize;

    let mut search_from = 0usize;
    while let Some(rel) = find(&data[search_from..], MAGIC) {
        let off = search_from + rel;
        // Default advance: past this magic, so a false-positive match is simply skipped.
        search_from = off + MAGIC.len();

        // The package length isn't known up front; parsing from the offset consumes exactly
        // one package, so the cursor position afterwards is the original encoded length.
        let mut cursor = Cursor::new(&data[off..]);
        let Ok(pkg) = Package::read_from(&mut cursor) else {
            continue;
        };
        let orig_len = cursor.position() as usize;
        search_from = off + orig_len;

        let original_digest = pkg.digest();
        let stripped = pkg
            .without_debug_info()
            .map_err(|e| format!("package at byte offset {off} failed to strip: {e}"))?;
        if stripped.digest() != original_digest {
            return Err(format!("package at byte offset {off} changed digest while stripping"));
        }
        let lean_len = stripped.to_bytes().len();
        if lean_len >= orig_len {
            // Nothing to gain (already stripped, or debug-free).
            continue;
        }

        let padded = pad_to_len(stripped, orig_len).ok_or_else(|| {
            format!("package at byte offset {off} could not be padded back to {orig_len} bytes")
        })?;

        // The rewritten bytes must re-parse through the same entry point the runtime uses for
        // embedded packages, and describe the same code.
        let reparsed = Package::read_from_bytes_trusted(&padded)
            .map_err(|e| format!("stripped package failed to re-parse: {e}"))?;
        if reparsed.digest() != original_digest {
            return Err(format!("package at byte offset {off} failed digest verification"));
        }

        data[off..off + orig_len].copy_from_slice(&padded);
        count += 1;
        zeroed += orig_len - lean_len;
    }

    if count > 0 {
        std::fs::write(path, &data).map_err(|e| format!("write failed: {e}"))?;
    }
    Ok((count, zeroed))
}

/// Re-serializes `pkg` padded to exactly `target` bytes with a zero-filled custom section, so
/// baked WASM pointers and `include_bytes!` lengths stay valid while memory-packing drops the
/// zeros from the emitted file.
fn pad_to_len(mut pkg: Package, target: usize) -> Option<Vec<u8>> {
    let id = SectionId::custom(PAD_SECTION_ID).ok()?;
    pkg.sections.push(Section { id, data: Vec::new().into() });
    let base = pkg.to_bytes().len();
    if base > target {
        return None;
    }

    // The section framing encodes the data length as a varint, so growing the padding can grow
    // the framing by a byte or two; iterate until the total lands exactly on target.
    let mut pad_len = target - base;
    for _ in 0..8 {
        pkg.sections.last_mut().expect("padding section was just pushed").data =
            vec![0u8; pad_len].into();
        let bytes = pkg.to_bytes();
        match bytes.len().cmp(&target) {
            Ordering::Equal => return Some(bytes),
            Ordering::Greater => pad_len = pad_len.checked_sub(bytes.len() - target)?,
            Ordering::Less => pad_len += target - bytes.len(),
        }
    }
    None
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

    use miden_core::mast::{BasicBlockNodeBuilder, DenseMastForestBuilder, MastNodeExt};
    use miden_core::operations::Operation;
    use miden_mast_package::{
        Dependency,
        PackageExport,
        PackageId,
        PathBuf as MastPathBuf,
        ProcedureExport,
        TargetType,
        Version,
    };

    use super::*;

    static NEXT_TEMP_FILE: AtomicUsize = AtomicUsize::new(0);

    struct TestFile(PathBuf);

    impl TestFile {
        fn new(bytes: &[u8]) -> Self {
            let id = NEXT_TEMP_FILE.fetch_add(1, AtomicOrdering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("strip-masp-debug-test-{}-{id}.wasm", std::process::id()));
            std::fs::write(&path, bytes).expect("test file should be writable");
            Self(path)
        }
    }

    impl Drop for TestFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    fn empty_package(name: &str) -> Package {
        let mut forest_builder = DenseMastForestBuilder::new();
        let node_id = forest_builder
            .push_node(BasicBlockNodeBuilder::new(vec![Operation::Add]))
            .expect("test node should be valid");
        forest_builder.mark_root(node_id);
        let (forest, remapping) = forest_builder.build_with_id_map().unwrap();
        let node_id = remapping.get(node_id).unwrap();
        let path = MastPathBuf::new("test::proc")
            .unwrap()
            .as_path()
            .to_absolute()
            .unwrap()
            .into_owned();
        let export = ProcedureExport::new(
            Arc::from(path.into_boxed_path()),
            Some(node_id),
            forest[node_id].digest(),
            None,
        );
        Package::create(
            PackageId::from(name),
            Version::new(0, 0, 0),
            TargetType::Library,
            Arc::new(forest),
            [PackageExport::Procedure(export)],
            Vec::<Dependency>::new(),
        )
        .expect("test package should be valid")
    }

    fn package_with_debug(name: &str, debug_len: usize) -> Package {
        let mut package = empty_package(name);
        package
            .sections
            .push(Section::new(SectionId::DEBUG_INFO, vec![0x5a; debug_len]));
        package
    }

    #[test]
    fn strips_multiple_packages_and_preserves_layout_and_digests() {
        let first = package_with_debug("first", 200);
        let second = package_with_debug("second", 20_000);
        let first_digest = first.digest();
        let second_digest = second.digest();
        let first_bytes = first.to_bytes();
        let second_bytes = second.to_bytes();
        let first_lean_len = Package::read_from_bytes(&first_bytes).unwrap().to_bytes().len();
        let second_lean_len = Package::read_from_bytes(&second_bytes).unwrap().to_bytes().len();

        let prefix = b"false MASP match before package: MASP-not-a-package";
        let separator = b"separator MASP-still-not-a-package";
        let mut file_bytes = prefix.to_vec();
        file_bytes.extend_from_slice(&first_bytes);
        file_bytes.extend_from_slice(separator);
        file_bytes.extend_from_slice(&second_bytes);
        let original_len = file_bytes.len();
        let file = TestFile::new(&file_bytes);

        let (count, zeroed) = strip_file(&file.0).expect("strip should succeed");
        assert_eq!(count, 2);
        assert_eq!(
            zeroed,
            first_bytes.len() - first_lean_len + second_bytes.len() - second_lean_len
        );

        let stripped_file = std::fs::read(&file.0).unwrap();
        assert_eq!(stripped_file.len(), original_len);
        let first_offset = prefix.len();
        let second_offset = first_offset + first_bytes.len() + separator.len();
        let reparsed_first = Package::read_from_bytes_trusted(
            &stripped_file[first_offset..first_offset + first_bytes.len()],
        )
        .unwrap();
        let reparsed_second = Package::read_from_bytes_trusted(
            &stripped_file[second_offset..second_offset + second_bytes.len()],
        )
        .unwrap();

        for (reparsed, digest) in [(reparsed_first, first_digest), (reparsed_second, second_digest)]
        {
            assert_eq!(reparsed.digest(), digest);
            assert!(!reparsed.sections.iter().any(|section| section.id.is_debug()));
            assert!(reparsed.sections.iter().any(|section| section.id.as_str() == PAD_SECTION_ID));
        }

        assert_eq!(strip_file(&file.0).unwrap(), (0, 0));
    }

    #[test]
    fn padding_handles_varint_boundaries() {
        for extra in [32, 127, 128, 255, 16_383, 16_384] {
            let package = empty_package("padding");
            let digest = package.digest();
            let target = package.to_bytes().len() + extra;
            let padded = pad_to_len(package, target).expect("padding should converge");
            assert_eq!(padded.len(), target);
            assert_eq!(Package::read_from_bytes_trusted(&padded).unwrap().digest(), digest);
        }
    }

    #[test]
    fn a_package_strip_error_does_not_partially_rewrite_the_file() {
        let valid_bytes = package_with_debug("valid", 200).to_bytes();
        let mut invalid = package_with_debug("invalid", 200);
        invalid
            .sections
            .push(Section::new(SectionId::KERNEL, b"not a package".to_vec()));
        let invalid_bytes = invalid.to_bytes();
        let mut original = valid_bytes;
        original.extend_from_slice(&invalid_bytes);
        let file = TestFile::new(&original);

        let error = strip_file(&file.0).expect_err("invalid embedded kernel should fail stripping");
        assert!(error.contains("failed to strip"), "unexpected error: {error}");
        assert_eq!(std::fs::read(&file.0).unwrap(), original);
    }
}
