//! Strips MASP `debug_info` sections from Miden packages embedded in a compiled WASM binary.
//!
//! The protocol crates `include_bytes!` their MAST packages assembled with debug info — ~8MB
//! of rodata in the browser bundle — and expose no build-time knob to turn it off. This tool
//! rewrites each embedded package in place via [`Package::without_debug_info`], padding the
//! result back to its exact original length with a zero-filled custom section (WASM data
//! offsets are baked constants and must not move); wasm-opt's memory-packing pass then drops
//! the zero runs from the emitted file.
//!
//! Wired into production builds via the `WASM_OPT_BIN` shim
//! `crates/web-client/scripts/wasm-opt-with-masp-strip.sh` (see `rollup.config.js`). Dev and
//! fast builds skip it so VM errors keep `assert.err` messages and source spans.

use std::cmp::Ordering;
use std::path::Path;
use std::process::ExitCode;

use miden_core::serde::{ByteReader, Deserializable, DeserializationError, Serializable};
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
        // Default advance: past this magic. Overwritten with the package end on success, so a
        // blob that fails to parse (false-positive magic) is simply skipped.
        search_from = off + MAGIC.len();

        let mut reader = CountingReader::new(&data[off..]);
        let Ok(pkg) = Package::read_from(&mut reader) else {
            continue;
        };
        let orig_len = reader.pos;

        let Ok(stripped) = pkg.without_debug_info() else {
            continue;
        };
        let digest = stripped.digest();
        let lean_len = stripped.to_bytes().len();
        if lean_len >= orig_len {
            // Nothing to gain (already stripped, or debug-free).
            search_from = off + orig_len;
            continue;
        }

        let Some(padded) = pad_to_len(stripped, orig_len) else {
            search_from = off + orig_len;
            continue;
        };

        // The rewritten bytes must re-parse through the same entry point the runtime uses for
        // embedded packages, and describe the same code.
        let reparsed = Package::read_from_bytes_trusted(&padded)
            .map_err(|e| format!("stripped package failed to re-parse: {e}"))?;
        if reparsed.digest() != digest {
            return Err("stripped package digest mismatch".into());
        }

        data[off..off + orig_len].copy_from_slice(&padded);
        count += 1;
        zeroed += orig_len - lean_len;
        search_from = off + orig_len;
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

/// [`ByteReader`] over a slice that tracks how many bytes were consumed, so the length of a
/// package embedded mid-file can be recovered after `Package::read_from`.
struct CountingReader<'a> {
    source: &'a [u8],
    pos: usize,
}

impl<'a> CountingReader<'a> {
    fn new(source: &'a [u8]) -> Self {
        Self { source, pos: 0 }
    }
}

impl ByteReader for CountingReader<'_> {
    fn read_u8(&mut self) -> Result<u8, DeserializationError> {
        self.check_eor(1)?;
        let byte = self.source[self.pos];
        self.pos += 1;
        Ok(byte)
    }

    fn peek_u8(&self) -> Result<u8, DeserializationError> {
        self.check_eor(1)?;
        Ok(self.source[self.pos])
    }

    fn read_slice(&mut self, len: usize) -> Result<&[u8], DeserializationError> {
        self.check_eor(len)?;
        let slice = &self.source[self.pos..self.pos + len];
        self.pos += len;
        Ok(slice)
    }

    fn read_array<const N: usize>(&mut self) -> Result<[u8; N], DeserializationError> {
        self.check_eor(N)?;
        let mut result = [0u8; N];
        result.copy_from_slice(&self.source[self.pos..self.pos + N]);
        self.pos += N;
        Ok(result)
    }

    fn check_eor(&self, num_bytes: usize) -> Result<(), DeserializationError> {
        if self.pos + num_bytes > self.source.len() {
            return Err(DeserializationError::UnexpectedEOF);
        }
        Ok(())
    }

    fn has_more_bytes(&self) -> bool {
        self.pos < self.source.len()
    }
}
