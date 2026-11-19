//! OS metadata. Returned directory paths confer no filesystem access; the
//! home directory is told only to apps granted `capabilities.homeDir`.
#[cfg(not(target_arch = "wasm32"))]
use std::path::PathBuf;

use crate::element::{JsError, System, codes, module};

/// The native operating system's name (`process.platform`, `os.platform()`):
/// Rust's `std::env::consts::OS`, but `"harmonyos"` on HarmonyOS, whose
/// target (`target_env = "ohos"`) Rust counts as Linux.
pub(crate) const SYSTEM: &str = if cfg!(target_env = "ohos") {
    "harmonyos"
} else {
    std::env::consts::OS
};

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
    /// `"android"` (not Node's `"darwin"` / `"win32"`); `"harmonyos"` on
    /// HarmonyOS, which Rust's target calls Linux.
    pub(crate) fn platform() -> String {
        SYSTEM.to_owned()
    }

    /// The native CPU architecture's name, as Rust's
    /// `std::env::consts::ARCH` and gpui-shell's say it: `"aarch64"`,
    /// `"x86_64"` (not Node's `"arm64"` / `"x64"`).
    pub(crate) fn arch() -> String {
        std::env::consts::ARCH.to_owned()
    }

    /// The configured absolute native home directory, for apps granted
    /// `capabilities.homeDir` (`ERR_ACCESS_DENIED` otherwise). This grants
    /// no file access. Throws `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` where
    /// the platform has none.
    pub(crate) fn homedir(sys: System) -> Result<String, JsError> {
        if !sys.access.allows_home_dir() {
            return Err(JsError::access_denied(
                "os.homedir() is not granted: add `\"homeDir\": true` to capabilities in nsh.json",
                "homeDir",
                "",
            ));
        }
        let none = || {
            JsError::Error("os.homedir(): no absolute native home directory is configured".into())
                .with_code(codes::UNAVAILABLE)
        };
        #[cfg(target_arch = "wasm32")]
        {
            Err(none())
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            ["HOME", "USERPROFILE"]
                .into_iter()
                .filter_map(std::env::var_os)
                .map(PathBuf::from)
                .find(|path| path.is_absolute())
                .map(|path| path.to_string_lossy().into_owned())
                .ok_or_else(none)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::access::{Access, Capabilities};

    fn sys(declared: Capabilities) -> System {
        System::new(
            std::sync::Arc::new(Access {
                declared,
                granted: None,
            }),
            None,
            Default::default(),
            Default::default(),
        )
    }

    #[test]
    fn metadata_matches_native_values_without_surface_context() {
        assert_eq!(Os::platform(), std::env::consts::OS);
        assert_eq!(Os::arch(), std::env::consts::ARCH);
        assert_eq!(Os::EOL, if cfg!(windows) { "\r\n" } else { "\n" });
        if let Ok(home) = Os::homedir(sys(Capabilities::all())) {
            assert!(PathBuf::from(home).is_absolute());
        }
    }

    #[test]
    fn the_home_directory_is_a_capability() {
        let Err(error) = Os::homedir(sys(Default::default())) else {
            panic!("os.homedir() without capabilities.homeDir");
        };
        assert_eq!(error.code(), Some(codes::ACCESS_DENIED));
        assert!(error.message().contains("homeDir"), "{}", error.message());
        let granted = Capabilities {
            home_dir: true,
            ..Default::default()
        };
        let denied =
            |r: Result<String, JsError>| r.is_err_and(|e| e.code() == Some(codes::ACCESS_DENIED));
        assert!(!denied(Os::homedir(sys(granted))));
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
