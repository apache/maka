//! The TSX of an app's nshm (NSH modules): what `nsh.lock` says each
//! installed nshm exports to TSX, by specifier, and where it is installed.
//!
//! The CLI resolves, installs and locks nshm (`crates/nsh-cli/src/nshm`);
//! the bundler only reads the lock, so a build takes the locked copies and
//! nothing else. An nshm's TSX is compiled into the app's bundle as the
//! app's own modules are: it ships in the app's bytecode and its signed
//! packages, never loaded from the installation at run time.

use std::path::{Path, PathBuf};

/// `nsh.lock`, beside the app's `nsh.json`.
pub const LOCK: &str = "nsh.lock";

/// NSH's home: `NSH_HOME`, else `~/.nsh` (`%USERPROFILE%\.nsh` on Windows).
pub fn home() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("NSH_HOME").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    let home = if cfg!(windows) {
        std::env::var_os("USERPROFILE")
    } else {
        std::env::var_os("HOME")
    };
    home.filter(|h| !h.is_empty())
        .map(|h| PathBuf::from(h).join(".nsh"))
}

/// Where nshm are installed, one directory per version, shared by every
/// app on the machine: `<home>/nshms`.
pub fn installed_dir() -> Option<PathBuf> {
    home().map(|h| h.join("nshms"))
}

/// The TSX exports of the nshm the lock in `app` (the directory of
/// `nsh.json`) holds: each specifier with its entry file. Empty without a
/// lock; an error for a lock this NSH cannot read or an export whose file
/// is not installed (`nsh` installs what the lock names before it builds).
pub fn exports(app: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    let Ok(text) = std::fs::read_to_string(app.join(LOCK)) else {
        return Ok(Vec::new());
    };
    let lock: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("{LOCK} is not JSON: {e}"))?;
    let Some(packages) = lock.get("packages").and_then(|p| p.as_array()) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for package in packages {
        let Some(exports) = package.get("exports").and_then(|e| e.as_object()) else {
            continue;
        };
        let name = package["name"].as_str().unwrap_or_default();
        let dir = match (package["path"].as_str(), package["dir"].as_str()) {
            (Some(path), _) => app.join(path),
            (None, Some(dir)) => installed_dir()
                .ok_or("no home directory to find nshm in: set NSH_HOME")?
                .join(dir),
            (None, None) => return Err(format!("{LOCK}: {name} has no \"dir\"")),
        };
        for (specifier, file) in exports {
            let Some(file) = file.as_str() else {
                return Err(format!(
                    "{LOCK}: {name}: exports: {specifier} is not a path"
                ));
            };
            let path = dir.join(file);
            if !path.is_file() {
                return Err(format!(
                    "{name}: {} is not installed (run an nsh command in the app to install what {LOCK} names)",
                    path.display()
                ));
            }
            out.push((specifier.clone(), path));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exports_are_read_from_the_lock() {
        let app = std::env::temp_dir().join(format!("nsh-nshm-exports-{}", std::process::id()));
        let ui = std::env::temp_dir().join("nsh-nshm-exports-ui");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::create_dir_all(ui.join("src")).unwrap();
        std::fs::write(ui.join("src/index.tsx"), "export const x = 1;").unwrap();
        assert!(exports(&app).unwrap().is_empty());
        std::fs::write(
            app.join(LOCK),
            r#"{ "version": 2, "packages": [
                { "name": "acme-ui", "path": "../nsh-nshm-exports-ui", "exports": { "acme-ui": "src/index.tsx" } },
                { "name": "acme-gauge", "path": "../nsh-nshm-exports-ui", "module": "acme-gauge" }
            ] }"#,
        )
        .unwrap();
        let found = exports(&app).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, "acme-ui");
        assert!(found[0].1.ends_with("src/index.tsx"));
        std::fs::write(
            app.join(LOCK),
            r#"{ "version": 2, "packages": [
                { "name": "acme-ui", "path": "../nsh-nshm-exports-ui", "exports": { "acme-ui": "src/missing.tsx" } }
            ] }"#,
        )
        .unwrap();
        assert!(exports(&app).unwrap_err().contains("not installed"));
        std::fs::remove_dir_all(&app).unwrap();
        std::fs::remove_dir_all(&ui).unwrap();
    }
}
