//! The system's share sheet (`nsh`'s `Share.show`,
//! [`crate::element::share`]): the app hands text, a link or local files
//! to the system, and the user picks where they go (a message, mail,
//! another app, AirDrop, saving to files).
//!
//! The flow: the call checks the content ([`ShareRequest::check`]) and the
//! app's `share` capability (a JS call also checks each file against
//! `capabilities.fs.read`); the core sends it to the platform as
//! [`Command::Share`](crate::Command::Share) on the root, naming its
//! anchor view ([`ShareSheet::anchor`]), and the platform shows its share
//! sheet (iOS `UIActivityViewController`,
//! Android's chooser over `Intent.ACTION_SEND`, macOS
//! `NSSharingServicePicker`, the browser's `navigator.share`). It answers
//! with the root's [`EventKind::Share`](crate::EventKind::Share), whose
//! payload [`ShareOutcome::payload`] / [`ShareError::payload`] make and
//! the core reads: shared (with the target the user chose, where the
//! platform names it), dismissed, or why it could not share. A platform
//! answers every request it gets, once. A new share answers the one still
//! showing as dismissed at once; iOS and macOS show the new sheet in the
//! earlier one's place, while on Android and the web the earlier sheet
//! stays until the user closes it (a browser refuses the new share
//! meanwhile).
//!
//! What `shared` means is as much as the platform knows: on iOS the target
//! finished sharing; on macOS the service reported it finished, or it
//! reported nothing and the user came back to the window from it (with a
//! mail draft still open, too); Android tells only which app the user
//! chose; the web, that `navigator.share` resolved.
//!
//! Only platforms whose
//! [`Environment::share`](crate::platform::Environment::share) is set get
//! the command; elsewhere a share fails at once with
//! `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` ([`ShareError::unavailable`]), so
//! no platform pretends to have shared.

use std::path::PathBuf;

use crate::{EventPayload, NodeId, PayloadValue};

/// The most bytes of text (and of a title) one share carries.
pub const MAX_TEXT_BYTES: usize = 1024 * 1024;

/// The most bytes of a shared URL.
pub const MAX_URL_BYTES: usize = 16 * 1024;

/// The most files one share carries.
pub const MAX_FILES: usize = 100;

/// What a share rejects with when the app's capabilities do not grant
/// `share` (`ERR_ACCESS_DENIED`, permission `"share"`).
pub(crate) const NOT_GRANTED: &str =
    "share: the share sheet is not granted: add `\"share\": true` to capabilities in nsh.json";

/// Schemes a shared URL never has: they run code or name the app's own
/// files and data (local files are shared as [`ShareRequest::files`],
/// where the app's grants are checked).
const REFUSED_SCHEMES: &[&str] = &[
    "javascript",
    "vbscript",
    "data",
    "blob",
    "file",
    "about",
    "asset",
];

/// What the app asks the system to share. At least one of
/// [`Self::text`], [`Self::url`] and [`Self::files`] is given.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct ShareRequest {
    /// A title for what is shared: the subject of a mail, the heading of
    /// the share sheet where the platform shows one. An empty one is no
    /// title.
    pub title: Option<String>,
    /// Text to share. An empty one is no text.
    pub text: Option<String>,
    /// A link to share (absolute; not `file:`, `data:`, `javascript:`, ...).
    pub url: Option<String>,
    /// Local files to share, by absolute path.
    pub files: Vec<PathBuf>,
    /// The view the share sheet points at where it shows as a popover
    /// (iPad, macOS); `None`: the middle of the window.
    pub anchor: Option<NodeId>,
}

impl ShareRequest {
    /// An empty request; give it text, a URL or files.
    pub fn new() -> Self {
        Self::default()
    }

    /// Shares `title` as the title of what is shared.
    pub fn title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    /// Shares `text`.
    pub fn text(mut self, text: impl Into<String>) -> Self {
        self.text = Some(text.into());
        self
    }

    /// Shares the link `url`.
    pub fn url(mut self, url: impl Into<String>) -> Self {
        self.url = Some(url.into());
        self
    }

    /// Shares the local file at `path` (absolute), after those given
    /// before.
    pub fn file(mut self, path: impl Into<PathBuf>) -> Self {
        self.files.push(path.into());
        self
    }

    /// Points the share sheet at `anchor` where it shows as a popover; a
    /// ref that names no view yet leaves it at the middle of the window.
    pub fn anchor(mut self, anchor: &crate::element::ElementRef) -> Self {
        self.anchor = anchor.node();
        self
    }

    /// Checks the request: something to share, text and title of at most
    /// [`MAX_TEXT_BYTES`], an absolute URL of a scheme that is shared (not
    /// [`REFUSED_SCHEMES`]) of at most [`MAX_URL_BYTES`], at most
    /// [`MAX_FILES`] files, each by an absolute path. The error says what
    /// is wrong.
    pub fn check(&self) -> Result<(), String> {
        let text = self.text.as_deref().filter(|text| !text.is_empty());
        if text.is_none() && self.url.is_none() && self.files.is_empty() {
            return Err("share: give `text`, `url` or `files`".into());
        }
        for (name, value) in [("title", &self.title), ("text", &self.text)] {
            if value.as_ref().is_some_and(|v| v.len() > MAX_TEXT_BYTES) {
                return Err(format!(
                    "share: `{name}` has at most {MAX_TEXT_BYTES} bytes"
                ));
            }
        }
        if let Some(url) = &self.url {
            check_url(url)?;
        }
        if self.files.len() > MAX_FILES {
            return Err(format!("share: at most {MAX_FILES} files"));
        }
        if let Some(path) = self
            .files
            .iter()
            .find(|path| !crate::access::absolute(path))
        {
            return Err(format!(
                "share: `{}` is not an absolute path",
                path.display()
            ));
        }
        Ok(())
    }
}

/// Checks a shared URL: absolute, at most [`MAX_URL_BYTES`], no whitespace
/// or control characters, of a scheme that is shared.
fn check_url(url: &str) -> Result<(), String> {
    if url.len() > MAX_URL_BYTES {
        return Err(format!("share: a URL has at most {MAX_URL_BYTES} bytes"));
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("share: a URL has no whitespace or control characters".into());
    }
    let parsed = url::Url::parse(url).map_err(|e| format!("share: not a URL: {e} ({url})"))?;
    let scheme = parsed.scheme();
    if REFUSED_SCHEMES.contains(&scheme) {
        return Err(format!(
            "share: `{scheme}:` URLs are not shared (share local files as `files`)"
        ));
    }
    Ok(())
}

/// What the platform shows: the checked content of a [`ShareRequest`],
/// its files as paths, empty text and title left out.
#[derive(Debug, Clone, Default, PartialEq)]
#[non_exhaustive]
pub struct ShareSheet {
    /// The title ([`ShareRequest::title`]).
    pub title: Option<String>,
    /// The text ([`ShareRequest::text`]).
    pub text: Option<String>,
    /// The link ([`ShareRequest::url`]).
    pub url: Option<String>,
    /// The files' absolute paths ([`ShareRequest::files`]).
    pub files: Vec<String>,
    /// The view the sheet points at where it is a popover: the platform
    /// places it at that view's native view, in whatever root view or
    /// window it is. `None`: no anchor, or one not shown, and a popover
    /// points at the middle of the surface.
    pub anchor: Option<NodeId>,
}

impl ShareSheet {
    /// What `request` shows, pointing at `anchor` (a view the core
    /// checked is shown).
    pub(crate) fn new(request: ShareRequest, anchor: Option<NodeId>) -> Self {
        let present = |value: Option<String>| value.filter(|value| !value.is_empty());
        Self {
            title: present(request.title),
            text: present(request.text),
            url: request.url,
            files: request
                .files
                .into_iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
            anchor,
        }
    }

    /// The text a platform that shares one string shares: the text and
    /// the URL, on lines of their own (Android's `EXTRA_TEXT`).
    pub fn combined_text(&self) -> Option<String> {
        match (&self.text, &self.url) {
            (Some(text), Some(url)) if !text.is_empty() => Some(format!("{text}\n{url}")),
            (Some(text), None) => Some(text.clone()),
            (_, Some(url)) => Some(url.clone()),
            (None, None) => None,
        }
    }
}

/// What the user did with the share sheet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub enum ShareAction {
    /// The user shared: the target finished (iOS), the service reported
    /// it finished or the user came back from one that reported nothing
    /// (macOS), the user chose an app (Android).
    Shared,
    /// The user closed the share sheet without sharing (or another share
    /// replaced it).
    #[default]
    Dismissed,
}

impl ShareAction {
    /// Its name in the platforms' payloads and in JS.
    pub fn as_str(self) -> &'static str {
        match self {
            ShareAction::Shared => "shared",
            ShareAction::Dismissed => "dismissed",
        }
    }
}

/// How a share ended.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct ShareOutcome {
    /// Shared or dismissed.
    pub action: ShareAction,
    /// The target the user chose, where the platform names it (iOS's
    /// activity type, `com.apple.UIKit.activity.Mail`; Android's package;
    /// macOS's service title); `None` elsewhere and when dismissed.
    pub target: Option<String>,
}

impl ShareOutcome {
    /// Shared, to `target` where the platform names it.
    pub fn shared(target: Option<String>) -> Self {
        Self {
            action: ShareAction::Shared,
            target,
        }
    }

    /// Dismissed without sharing.
    pub fn dismissed() -> Self {
        Self {
            action: ShareAction::Dismissed,
            target: None,
        }
    }

    /// The root's [`EventKind::Share`](crate::EventKind::Share) payload
    /// answering request `id` with this outcome.
    pub fn payload(&self, id: u32) -> EventPayload {
        let mut fields = vec![
            ("id", PayloadValue::Number(id as f64)),
            ("action", PayloadValue::Str(self.action.as_str().into())),
        ];
        if let Some(target) = &self.target {
            fields.push(("target", PayloadValue::Str(target.clone())));
        }
        EventPayload::Map(fields)
    }
}

/// Why a share could not be shown or finish.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct ShareError {
    /// A stable code the app can branch on
    /// (`ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`, `ERR_ACCESS_DENIED`, an I/O
    /// error's `ENOENT`); `None` for other failures.
    pub code: Option<String>,
    /// What went wrong, in words.
    pub message: String,
}

impl ShareError {
    /// A failure with `message` and no code.
    pub fn failed(message: impl Into<String>) -> Self {
        Self {
            code: None,
            message: message.into(),
        }
    }

    /// The platform has no share sheet, or none for this content (a
    /// browser that shares no files).
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self {
            code: Some(crate::element::codes::UNAVAILABLE.into()),
            message: message.into(),
        }
    }

    /// The root's [`EventKind::Share`](crate::EventKind::Share) payload
    /// answering request `id` with this error.
    pub fn payload(&self, id: u32) -> EventPayload {
        let mut fields = vec![
            ("id", PayloadValue::Number(id as f64)),
            ("error", PayloadValue::Str(self.message.clone())),
        ];
        if let Some(code) = &self.code {
            fields.push(("code", PayloadValue::Str(code.clone())));
        }
        EventPayload::Map(fields)
    }
}

impl std::fmt::Display for ShareError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ShareError {}

/// The request a platform's [`EventKind::Share`](crate::EventKind::Share)
/// payload answers and its answer: an `error` (with its `code`, if any)
/// fails it, else `action` (`"shared"`, with its `target`, or
/// `"dismissed"`; an unknown one is taken as dismissed) ends it. `None`
/// when the payload names no request.
pub(crate) fn answer_from_payload(
    payload: &EventPayload,
) -> Option<(u32, Result<ShareOutcome, ShareError>)> {
    let EventPayload::Map(fields) = payload else {
        return None;
    };
    let text = |key: &str| {
        fields.iter().find_map(|(k, v)| match v {
            PayloadValue::Str(s) if *k == key => Some(s.clone()),
            _ => None,
        })
    };
    let id = fields.iter().find_map(|(k, v)| match v {
        PayloadValue::Number(n) if *k == "id" => Some(*n as u32),
        _ => None,
    })?;
    if let Some(message) = text("error") {
        return Some((
            id,
            Err(ShareError {
                code: text("code"),
                message,
            }),
        ));
    }
    let outcome = match text("action").as_deref() {
        Some("shared") => ShareOutcome::shared(text("target")),
        _ => ShareOutcome::dismissed(),
    };
    Some((id, Ok(outcome)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn absolute(name: &str) -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(format!("C:\\data\\{name}"))
        } else {
            PathBuf::from(format!("/data/{name}"))
        }
    }

    #[test]
    fn a_request_needs_something_to_share() {
        assert!(ShareRequest::new().title("Only a title").check().is_err());
        assert!(ShareRequest::new().text("Hello").check().is_ok());
        assert!(
            ShareRequest::new()
                .url("https://example.com/a")
                .check()
                .is_ok()
        );
        assert!(ShareRequest::new().file(absolute("a.pdf")).check().is_ok());
    }

    #[test]
    fn urls_that_run_code_or_name_local_files_are_refused() {
        for url in [
            "javascript:alert(1)",
            "data:text/plain,hi",
            "file:///etc/hosts",
            "asset:/a.png",
            "relative/path",
            "https://example.com/a b",
        ] {
            assert!(ShareRequest::new().url(url).check().is_err(), "{url}");
        }
        for url in [
            "https://example.com",
            "mailto:a@example.com",
            "myapp://open/1",
        ] {
            assert!(ShareRequest::new().url(url).check().is_ok(), "{url}");
        }
    }

    #[test]
    fn files_are_absolute_and_bounded() {
        assert!(ShareRequest::new().file("a.pdf").check().is_err());
        let mut many = ShareRequest::new();
        for i in 0..=MAX_FILES {
            many = many.file(absolute(&format!("{i}.txt")));
        }
        assert!(many.check().is_err());
        let long = "x".repeat(MAX_TEXT_BYTES + 1);
        assert!(ShareRequest::new().text(long).check().is_err());
    }

    #[test]
    fn payloads_round_trip() {
        let shared = ShareOutcome::shared(Some("com.apple.UIKit.activity.Mail".into()));
        assert_eq!(
            answer_from_payload(&shared.payload(7)),
            Some((7, Ok(shared)))
        );
        let dismissed = ShareOutcome::dismissed();
        assert_eq!(
            answer_from_payload(&dismissed.payload(8)),
            Some((8, Ok(dismissed)))
        );
        let error = ShareError::unavailable("no share sheet");
        assert_eq!(
            answer_from_payload(&error.payload(9)),
            Some((9, Err(error)))
        );
        assert_eq!(answer_from_payload(&EventPayload::None), None);
    }

    #[test]
    fn one_string_carries_the_text_and_the_url() {
        let sheet = ShareSheet::new(
            ShareRequest::new().text("Look").url("https://example.com"),
            None,
        );
        assert_eq!(
            sheet.combined_text().as_deref(),
            Some("Look\nhttps://example.com")
        );
        let only_url = ShareSheet::new(ShareRequest::new().url("https://example.com"), None);
        assert_eq!(
            only_url.combined_text().as_deref(),
            Some("https://example.com")
        );
    }
}
