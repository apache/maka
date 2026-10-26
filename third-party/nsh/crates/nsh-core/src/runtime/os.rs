//! Pure OS metadata. Returned directory paths confer no filesystem access.
#[cfg(not(target_arch = "wasm32"))]
use std::path::PathBuf;

use crate::element::module;

/// Native OS metadata. Returned paths confer no filesystem access.
#[module]
#[derive(Default)]
#[non_exhaustive]
pub(crate) struct Os;

#[module(flat, default)]
impl Os {
    /// The native platform's line ending.
    pub(crate) const EOL: &'static str = if cfg!(windows) { "\r\n" } else { "\n" };

    /// The native operating system's name, as Rust's `std::env::consts::OS`
    /// and gpui-shell's say it: `"macos"`, `"windows"`, `"linux"`, `"ios"`,
    /// `"android"` (not Node's `"darwin"` / `"win32"`).
    pub(crate) fn platform() -> String {
        std::env::consts::OS.to_owned()
    }

    /// The native CPU architecture's name, as Rust's
    /// `std::env::consts::ARCH` and gpui-shell's say it: `"aarch64"`,
    /// `"x86_64"` (not Node's `"arm64"` / `"x64"`).
    pub(crate) fn arch() -> String {
        std::env::consts::ARCH.to_owned()
    }

    /// The configured absolute native home directory. This grants no file access.
    pub(crate) fn homedir() -> Result<String, String> {
        #[cfg(target_arch = "wasm32")]
        {
            Err("os.homedir(): no absolute native home directory is configured".to_owned())
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            ["HOME", "USERPROFILE"]
                .into_iter()
                .filter_map(std::env::var_os)
                .map(PathBuf::from)
                .find(|path| path.is_absolute())
                .map(|path| path.to_string_lossy().into_owned())
                .ok_or_else(|| {
                    "os.homedir(): no absolute native home directory is configured".to_owned()
                })
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    #[test]
    fn metadata_matches_native_values_without_surface_context() {
        assert_eq!(Os::platform(), std::env::consts::OS);
        assert_eq!(Os::arch(), std::env::consts::ARCH);
        assert_eq!(Os::EOL, if cfg!(windows) { "\r\n" } else { "\n" });
        if let Ok(home) = Os::homedir() {
            assert!(PathBuf::from(home).is_absolute());
        }
    }
    #[test]
    fn registry_generates_os_signatures_from_typed_functions() {
        let registry = crate::runtime::registries()
            .iter()
            .find(|registry| registry.specifier() == Some("os"))
            .unwrap();
        let modules = registry.module_specs();
        let os = modules.iter().find(|module| module.name == "Os").unwrap();
        assert!(os.flat);
        assert_eq!(os.functions.len(), 3);
        for name in ["platform", "arch", "homedir"] {
            let function = os
                .functions
                .iter()
                .find(|function| function.name == name)
                .unwrap();
            assert!(function.params.is_empty());
            assert_eq!(function.returns.as_deref(), Some("string"));
            assert_eq!(function.kind, crate::element::FunctionKind::Sync);
        }
        let declarations = crate::element::declarations(registry, &[]);
        for name in ["platform", "arch", "homedir"] {
            assert!(
                declarations.contains(&format!("function {name}(): string")),
                "{declarations}"
            );
        }
        assert!(declarations.contains("EOL"), "{declarations}");
        assert!(declarations.contains("default"), "{declarations}");
    }
}
