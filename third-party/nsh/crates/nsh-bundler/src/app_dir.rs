//! Where an app is: the directory of its `nsh.json`, which names its entry
//! (`"entry"`, relative to it; `App.tsx` beside it when it names none).
//!
//! An app's `nsh.json` may sit above its entry, at the root of a project
//! that also has other code (`"entry": "app/App.tsx"`, next to a
//! `package.json`): the app's directory is then that root. The paths its
//! `nsh.json` names (`theme`, `icon`, `web.host`, `rust`, ...), its
//! translations (`locales/`) and its `.nsh/` are relative to it; the entry
//! and the modules it imports are where `"entry"` says.

use std::path::{Component, Path, PathBuf};

/// An app's configuration file.
pub const CONFIG: &str = "nsh.json";

/// The entry module of an app directory whose `nsh.json` names none.
pub const ENTRY: &str = "App.tsx";

/// The entry `dir`'s `nsh.json` names (`"entry"`), joined to `dir`: `None`
/// when it has no `nsh.json` or names no entry, an error when `"entry"` is
/// not a relative path inside `dir` (a string with no `..`).
pub fn config_entry(dir: &Path) -> Result<Option<PathBuf>, String> {
    let Ok(text) = std::fs::read_to_string(dir.join(CONFIG)) else {
        return Ok(None);
    };
    // An `nsh.json` that is not JSON is reported where it is read.
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Ok(None);
    };
    let Some(value) = json.get("entry") else {
        return Ok(None);
    };
    let Some(entry) = value.as_str() else {
        return Err(r#""entry" must be a path relative to nsh.json, e.g. "app/App.tsx""#.into());
    };
    let path = Path::new(entry);
    if entry.is_empty()
        || !path
            .components()
            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err(format!(
            r#""entry": {entry:?} must be a path inside nsh.json's directory, e.g. "app/App.tsx""#
        ));
    }
    Ok(Some(dir.join(path)))
}

/// The directory of the app whose entry is in `dir`, where its `nsh.json`
/// is:
///
/// - `dir` itself when it has an `nsh.json`;
/// - the nearest directory up with an `nsh.json` whose `"entry"` is in
///   `dir` or above it (`app/` and `app/tests/` of `"entry":
///   "app/App.tsx"`);
/// - `dir` when it has an `App.tsx`;
/// - else the nearest directory up with an `nsh.json`, else the nearest one
///   up with an `App.tsx`, else `dir`.
///
/// An entry a test opens (`tests/MenuApp.tsx`), or the one `nsh test` makes
/// for a test file (`.nsh/test/<file>.run.js`), is so built with its app's
/// theme, translations and the rest of its `nsh.json`, as the app is.
pub fn app_dir(dir: &Path) -> PathBuf {
    let has_config = |d: &Path| d.join(CONFIG).is_file();
    let has_entry = |d: &Path| {
        std::fs::read_dir(d).is_ok_and(|entries| {
            entries.filter_map(Result::ok).any(|e| {
                e.file_name()
                    .to_str()
                    .is_some_and(|n| n.eq_ignore_ascii_case(ENTRY))
            })
        })
    };
    if has_config(dir) {
        return dir.to_owned();
    }
    if let Some(root) = dir.ancestors().skip(1).find(|d| has_config(d))
        && let Ok(Some(entry)) = config_entry(root)
        && let Some(entry_dir) = entry.parent()
        && canonical(dir).starts_with(canonical(entry_dir))
    {
        return root.to_owned();
    }
    if has_entry(dir) {
        return dir.to_owned();
    }
    dir.ancestors()
        .skip(1)
        .find(|d| has_config(d))
        .or_else(|| dir.ancestors().skip(1).find(|d| has_entry(d)))
        .unwrap_or(dir)
        .to_owned()
}

/// The directory of the app whose entry is `entry` ([`app_dir`] of its
/// directory; a Rust app's entry is its `nsh.json`).
pub fn app_dir_of(entry: &Path) -> PathBuf {
    let dir = match entry.parent() {
        Some(d) if !d.as_os_str().is_empty() => d,
        _ => Path::new("."),
    };
    app_dir(dir)
}

/// The directory of the `nsh.json` that describes the app `entry` starts:
/// the entry's directory, or the one above it whose `nsh.json` names it
/// (`"entry"`). Unlike [`app_dir_of`], another module of an app's (an app a
/// test opens, `tests/MenuApp.tsx`) is not the app's entry: its window and
/// lifecycle are its own, and its package metadata is none.
pub fn config_dir_of(entry: &Path) -> PathBuf {
    let dir = match entry.parent() {
        Some(d) if !d.as_os_str().is_empty() => d,
        _ => Path::new("."),
    };
    if dir.join(CONFIG).is_file() {
        return dir.to_owned();
    }
    let app = app_dir(dir);
    match config_entry(&app) {
        Ok(Some(named)) if canonical(&named) == canonical(entry) => app,
        _ => dir.to_owned(),
    }
}

fn canonical(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nsh-app-dir-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dunce::canonicalize(&dir).unwrap()
    }

    #[test]
    fn config_entry_is_relative_and_inside() {
        let dir = temp("entry");
        assert_eq!(config_entry(&dir), Ok(None));
        std::fs::write(dir.join(CONFIG), r#"{ "name": "A" }"#).unwrap();
        assert_eq!(config_entry(&dir), Ok(None));
        std::fs::write(dir.join(CONFIG), r#"{ "entry": "app/App.tsx" }"#).unwrap();
        assert_eq!(config_entry(&dir), Ok(Some(dir.join("app/App.tsx"))));
        for bad in [
            r#"1"#,
            r#""""#,
            r#""../App.tsx""#,
            r#""/App.tsx""#,
            r#""app/../../x.tsx""#,
        ] {
            std::fs::write(dir.join(CONFIG), format!(r#"{{ "entry": {bad} }}"#)).unwrap();
            assert!(config_entry(&dir).is_err(), "{bad}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn config_above_the_entry() {
        let root = temp("above");
        let app = root.join("app");
        std::fs::create_dir_all(app.join("tests")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(app.join("App.tsx"), "").unwrap();
        // Without "entry", `app/` is an app of its own (no nsh.json).
        std::fs::write(root.join(CONFIG), r#"{ "name": "A" }"#).unwrap();
        assert_eq!(app_dir(&app), app);
        // With it, the root is the app's directory, for the entry's
        // directory and those below it.
        std::fs::write(root.join(CONFIG), r#"{ "entry": "app/App.tsx" }"#).unwrap();
        assert_eq!(app_dir(&app), root);
        assert_eq!(app_dir(&app.join("tests")), root);
        assert_eq!(app_dir_of(&app.join("App.tsx")), root);
        assert_eq!(config_dir_of(&app.join("App.tsx")), root);
        // Another entry of the app's (one a test opens) has no nsh.json.
        assert_eq!(
            config_dir_of(&app.join("tests/MenuApp.tsx")),
            app.join("tests")
        );
        assert_eq!(app_dir(&root), root);
        // A directory beside the entry's is not the app's.
        assert_eq!(app_dir(&root.join("src")), root);
        std::fs::write(root.join("src/App.tsx"), "").unwrap();
        assert_eq!(app_dir(&root.join("src")), root.join("src"));
        // An nsh.json of its own wins.
        std::fs::write(app.join(CONFIG), "{}").unwrap();
        assert_eq!(app_dir(&app), app);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
