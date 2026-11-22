//! Finds an app's entry module by convention: commands take the entry
//! itself or the app's directory (the current one by default), whose
//! `App.tsx` is the entry. The name matches in any case (`app.tsx` too,
//! also on case-sensitive file systems). A directory whose `nsh.json` names
//! a Rust root component (`"root"`) is a Rust app: its entry is that
//! `nsh.json` (`rust_app::is_root`), and its `App.tsx`, if any, is used
//! only when named.

use std::path::{Path, PathBuf};

use anyhow::bail;

/// The entry module of an app directory.
pub(crate) const ENTRY: &str = "App.tsx";

/// The entry module `path` names: the file itself, or the directory's
/// [`ENTRY`].
pub(crate) fn resolve(path: &Path) -> anyhow::Result<PathBuf> {
    if !path.is_dir() {
        if path.exists() {
            return Ok(path.to_owned());
        }
        bail!("{} does not exist", path.display());
    }
    let config = path.join("nsh.json");
    if std::fs::read_to_string(&config)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .is_some_and(|json| json.get("root").is_some())
    {
        return Ok(config);
    }
    let entry = std::fs::read_dir(path)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_file())
        .find(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.eq_ignore_ascii_case(ENTRY))
        });
    match entry {
        Some(entry) => Ok(entry),
        None => bail!(
            "no {ENTRY} in {}: add one, or pass the entry module",
            path.display()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conventional_entry() {
        let dir = std::env::temp_dir().join(format!("nsh-entry-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(resolve(&dir).is_err());
        std::fs::write(dir.join("Other.tsx"), "").unwrap();
        assert!(resolve(&dir).is_err());
        std::fs::write(dir.join("app.tsx"), "").unwrap();
        assert_eq!(resolve(&dir).unwrap(), dir.join("app.tsx"));
        // A file is the entry whatever its name.
        assert_eq!(
            resolve(&dir.join("Other.tsx")).unwrap(),
            dir.join("Other.tsx")
        );
        assert!(resolve(&dir.join("missing.tsx")).is_err());
        // A TSX app whose directory is its crate (`nsh init --template
        // mixed`): with no `"root"`, its `App.tsx`.
        std::fs::write(dir.join("nsh.json"), r#"{ "rust": "." }"#).unwrap();
        assert_eq!(resolve(&dir).unwrap(), dir.join("app.tsx"));
        // A Rust app: its `nsh.json`, unless the TSX entry is named.
        std::fs::write(dir.join("nsh.json"), r#"{ "rust": ".", "root": "App" }"#).unwrap();
        assert_eq!(resolve(&dir).unwrap(), dir.join("nsh.json"));
        assert_eq!(resolve(&dir.join("app.tsx")).unwrap(), dir.join("app.tsx"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
