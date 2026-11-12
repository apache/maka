//! The file types an app opens (`nsh.json` `"fileTypes"`): the packages
//! declare them to the system (`CFBundleDocumentTypes` on macOS and iOS,
//! the registry on Windows, `MimeType` in the desktop entry on Linux), so
//! the app shows in Open With and opens the files the user double-clicks.
//!
//! A file the system opens the app with comes to the app as a path, apart
//! from its links: TS `Application.on("openFiles", ...)`, Rust
//! [`next_open_files`](crate::element::next_open_files), the files that
//! launched the app included. The platforms report it to the core as a
//! `file://` URL (AppKit's `application:openURLs:` hands both kinds), and
//! the core takes `file:` URLs only when the app declares file types
//! ([`FILE_SCHEME`]).

/// The most files kept while no listener takes them: past it the oldest
/// goes.
pub(crate) const MAX_PENDING: usize = 64;

/// Whether `url` is a `file:` URL (a file the system opened the app with).
pub(crate) fn is_file_url(url: &str) -> bool {
    url.get(..5)
        .is_some_and(|s| s.eq_ignore_ascii_case("file:"))
}

/// The local path of `url`, a `file:` URL; `None` for one of another host
/// or that names no absolute path.
/// The web opens no files.
pub(crate) fn file_path(url: &str) -> Option<std::path::PathBuf> {
    #[cfg(any(unix, windows))]
    {
        url::Url::parse(url).ok()?.to_file_path().ok()
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = url;
        None
    }
}

/// The scheme of the URLs of the files the app opens, which the core lets
/// through when the app declares file types (toolchain use).
#[doc(hidden)]
pub const FILE_SCHEME: &str = "file";

/// One kind of file the app opens.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct FileType {
    /// What the system calls the kind (`"Video"`).
    pub name: String,
    /// The extensions of its files, without the dot, in lower case
    /// (`["mp4", "mov"]`).
    pub extensions: Vec<String>,
    /// Its MIME types (`["video/mp4"]`): Linux finds the app by them, and
    /// Apple platforms read them besides the extensions.
    pub mime_types: Vec<String>,
    /// Its Uniform Type Identifiers on Apple platforms
    /// (`["public.movie"]`), which iOS finds the app by.
    pub content_types: Vec<String>,
    /// What the app does with its files.
    pub role: FileTypeRole,
}

/// What the app does with a kind of file (`CFBundleTypeRole`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum FileTypeRole {
    /// It shows them (`"viewer"`, the default).
    #[default]
    Viewer,
    /// It changes and saves them (`"editor"`).
    Editor,
}

impl FileTypeRole {
    /// Its name in `nsh.json`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Viewer => "viewer",
            Self::Editor => "editor",
        }
    }

    /// Its `CFBundleTypeRole` (toolchain use).
    #[doc(hidden)]
    pub fn apple(self) -> &'static str {
        match self {
            Self::Viewer => "Viewer",
            Self::Editor => "Editor",
        }
    }
}

impl FileType {
    /// Whether `path` names a file of this kind, by its extension.
    pub fn matches(&self, path: &std::path::Path) -> bool {
        path.extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| self.extensions.iter().any(|x| x.eq_ignore_ascii_case(e)))
    }

    /// As `nsh.json` writes it (toolchain use).
    #[doc(hidden)]
    pub fn to_json(&self) -> crate::JsonValue {
        let mut value = serde_json::json!({ "name": self.name });
        let list = |items: &[String]| serde_json::json!(items);
        if !self.extensions.is_empty() {
            value["extensions"] = list(&self.extensions);
        }
        if !self.mime_types.is_empty() {
            value["mimeTypes"] = list(&self.mime_types);
        }
        if !self.content_types.is_empty() {
            value["contentTypes"] = list(&self.content_types);
        }
        if self.role != FileTypeRole::Viewer {
            value["role"] = self.role.as_str().into();
        }
        value
    }
}

/// The file types of `nsh.json`'s `"fileTypes"`, checked. What it cannot
/// take (a value of a form it does not know, a newer NSH's) is left out:
/// an app opens less, never more.
pub fn file_types_from_json(value: &crate::JsonValue) -> Vec<FileType> {
    parse_file_types(value).0
}

/// Whether `"fileTypes"` of `info` (`nsh.json` or a package's `app.json`)
/// declares any file type (toolchain use).
#[doc(hidden)]
pub fn declares_file_types(info: &crate::JsonValue) -> bool {
    info.get("fileTypes")
        .is_some_and(|types| !file_types_from_json(types).is_empty())
}

/// [`file_types_from_json`], with what it left out, which the toolchain
/// warns of.
#[doc(hidden)]
pub fn parse_file_types(value: &crate::JsonValue) -> (Vec<FileType>, Vec<String>) {
    let mut ignored = Vec::new();
    let Some(list) = value.as_array() else {
        ignored.push(format!(
            "fileTypes: {value} is not an array of file types (`[{{ \"name\": \"Video\", \"extensions\": [\"mp4\"] }}]`)"
        ));
        return (Vec::new(), ignored);
    };
    let mut types = Vec::with_capacity(list.len());
    for entry in list {
        match file_type(entry) {
            Ok(file_type) => types.push(file_type),
            Err(e) => ignored.push(format!("fileTypes: {e}")),
        }
    }
    (types, ignored)
}

fn file_type(entry: &crate::JsonValue) -> Result<FileType, String> {
    let name = entry
        .get("name")
        .and_then(|n| n.as_str())
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .ok_or_else(|| format!("{entry} has no `name`"))?
        .to_owned();
    let strings = |key: &str, check: fn(&str) -> bool| -> Result<Vec<String>, String> {
        let Some(value) = entry.get(key) else {
            return Ok(Vec::new());
        };
        let list = value
            .as_array()
            .ok_or_else(|| format!("`{name}`: `{key}` is not an array of strings"))?;
        let mut out: Vec<String> = Vec::with_capacity(list.len());
        for item in list {
            let item = item
                .as_str()
                .filter(|s| check(s))
                .ok_or_else(|| format!("`{name}`: {item} is not valid in `{key}`"))?;
            if !out.iter().any(|o| o.eq_ignore_ascii_case(item)) {
                out.push(item.to_owned());
            }
        }
        Ok(out)
    };
    let extensions = strings("extensions", |e| {
        !e.is_empty()
            && !e.starts_with('.')
            && e.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    })?
    .into_iter()
    .map(|e| e.to_ascii_lowercase())
    .collect::<Vec<_>>();
    let mime_types = strings("mimeTypes", |m| {
        m.split_once('/')
            .is_some_and(|(a, b)| !a.is_empty() && !b.is_empty())
            && !m.chars().any(|c| c.is_whitespace() || c == ';')
    })?;
    let content_types = strings("contentTypes", |t| {
        !t.is_empty()
            && t.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.'))
    })?;
    if extensions.is_empty() && content_types.is_empty() {
        return Err(format!(
            "`{name}` names no files: give `extensions` or `contentTypes`"
        ));
    }
    let role = match entry.get("role").map(|r| r.as_str()) {
        None | Some(Some("viewer")) => FileTypeRole::Viewer,
        Some(Some("editor")) => FileTypeRole::Editor,
        Some(_) => {
            return Err(format!("`{name}`: `role` is `\"viewer\"` or `\"editor\"`"));
        }
    };
    Ok(FileType {
        name,
        extensions,
        mime_types,
        content_types,
        role,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_types_are_read_and_checked() {
        let (types, ignored) = parse_file_types(&serde_json::json!([
            { "name": "Video", "extensions": ["MP4", "mov", "mp4"], "mimeTypes": ["video/mp4"], "role": "editor" },
            { "name": "Movie", "contentTypes": ["public.movie"] },
            { "name": "Bad", "extensions": [".mp4"] },
            { "name": "Empty" },
            { "extensions": ["txt"] },
            { "name": "Role", "extensions": ["x"], "role": "owner" },
        ]));
        assert_eq!(types.len(), 2);
        assert_eq!(types[0].extensions, ["mp4", "mov"]);
        assert_eq!(types[0].mime_types, ["video/mp4"]);
        assert_eq!(types[0].role, FileTypeRole::Editor);
        assert_eq!(types[1].content_types, ["public.movie"]);
        assert_eq!(types[1].role, FileTypeRole::Viewer);
        assert_eq!(ignored.len(), 4, "{ignored:?}");
        assert!(types[0].matches(std::path::Path::new("/a/clip.MOV")));
        assert!(!types[0].matches(std::path::Path::new("/a/clip.txt")));
        assert_eq!(
            file_types_from_json(&serde_json::json!([types[0].to_json()])),
            [types[0].clone()]
        );
        assert!(declares_file_types(
            &serde_json::json!({ "fileTypes": [types[1].to_json()] })
        ));
        assert!(!declares_file_types(
            &serde_json::json!({ "fileTypes": [] })
        ));
    }
}
