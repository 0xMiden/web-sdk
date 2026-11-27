use js_export_macro::js_export;
use miden_client::vm::Package as NativeLibrary;

use crate::models::package::Package;

#[js_export]
#[derive(Clone)]
pub struct Library(NativeLibrary);

#[js_export]
impl Library {
    /// Returns the library as a serializable `Package`.
    #[js_export(js_name = "asPackage")]
    pub fn as_package(&self) -> Package {
        self.0.clone().into()
    }
}

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
