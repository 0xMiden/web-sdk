use js_export_macro::js_export;
// A library is no longer a distinct protocol type: it is a `Package` that carries a library
// artifact. The JS-facing `Library` class stays as its own wrapper so callers that hold one
// keep working.
use miden_client::vm::Package as NativeLibrary;

#[js_export]
#[derive(Clone)]
pub struct Library(NativeLibrary);

// CONVERSIONS
// ================================================================================================

impl From<NativeLibrary> for Library {
    fn from(native_library: NativeLibrary) -> Self {
        Library(native_library)
    }
}

impl From<&NativeLibrary> for Library {
    fn from(native_library: &NativeLibrary) -> Self {
        Library(native_library.clone())
    }
}

impl From<Library> for NativeLibrary {
    fn from(library: Library) -> Self {
        library.0
    }
}

impl From<&Library> for NativeLibrary {
    fn from(library: &Library) -> Self {
        library.0.clone()
    }
}
