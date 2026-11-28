//! `Share` (feature `share`): the system's share sheet. The app hands it
//! text, a link or local files, and the user picks where they go (a
//! message, mail, another app, AirDrop, saving to files).
//!
//! A share starts with a [`ShareRequest`] ([`show`]; TS: `Share.show`):
//! the module checks the app's `share` capability and the content
//! (something to share, within the limits, a URL that is shared, files
//! by absolute path; a JS call also checks each file as
//! `fs/promises` reads it, `System::readable_file`), and the platform shows
//! its share sheet: iOS's `UIActivityViewController`, macOS'
//! `NSSharingServicePicker`, Android's chooser over `Intent.ACTION_SEND`,
//! the browser's `navigator.share`. The share ends once: shared (with the
//! target the user chose, where the platform names it), dismissed, or why
//! it could not share ([`ShareError`]). One share is open per engine: a
//! new one answers the one still open as dismissed at once. iOS and macOS
//! show the new sheet in the earlier one's place, while on Android and the
//! web the earlier sheet stays until the user closes it (a browser refuses
//! the new share meanwhile).
//!
//! What `shared` means is as much as the platform knows: on iOS the target
//! finished sharing; on macOS the service reported it finished, or it
//! reported nothing and the user came back to the window from it (with a
//! mail draft still open, too); Android tells only which app the user
//! chose; the web, that `navigator.share` resolved.
//!
//! The `share` capability guards it when the app declares capabilities:
//! `Share.show` throws `ERR_ACCESS_DENIED` without it (checked against the
//! calling VM's grant), and a share Rust code starts in an app without it
//! fails with that code (checked against the engine's,
//! [`nsh_core::element::access`]). Rust code that runs on no engine's
//! thread is trusted and not checked.
//!
//! # Platforms
//!
//! Each platform is one file of this directory, on the platform crates'
//! extension points: `ios.rs` (UIKit, presented over the surface's top
//! controller, a popover at the anchor's view on an iPad), `macos.rs`
//! (AppKit's share menu below the anchor's view), `android.rs` (the
//! chooser started for a result, the chosen app heard through a broadcast,
//! files served as `content:` URIs of the app's own storage), `web.rs`
//! (`navigator.share`, through wasm-bindgen). Elsewhere there is no share
//! sheet: [`available`] is false and a share fails with
//! `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`. That is Windows, Linux, GPUI,
//! the terminal host on every OS, and headless runs without the fake.
//!
//! Headless runs (`nsh test`) use the module's fake share sheet, which the
//! test answers through `nsh/test`'s `app.fake("nsh-extra/share", method,
//! args)`: the module gives it as the fake `"nsh-extra/share"`
//! ([`nsh_core::fake`]); its methods are documented in `fake.rs`.
//!
//! The packaged app needs nothing declared for it. An iOS app that lets
//! the user save a shared image to Photos declares
//! `NSPhotoLibraryAddUsageDescription`; without it the sheet does not
//! offer that target.

#[cfg(target_os = "android")]
mod android;
pub(crate) mod fake;
#[cfg(target_os = "ios")]
mod ios;
mod js;
#[cfg(target_os = "macos")]
mod macos;
// Its answers are tested on every target.
#[cfg(any(target_arch = "wasm32", test))]
mod web;

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, LazyLock, Mutex, MutexGuard, RwLock,
        atomic::{AtomicU64, Ordering},
    },
};

use nsh_core::{
    NodeId,
    element::{EngineId, codes},
    prelude::*,
};
use tokio::sync::oneshot;

#[cfg(target_os = "android")]
use self::android as platform;
#[cfg(target_os = "ios")]
use self::ios as platform;
#[cfg(target_os = "macos")]
use self::macos as platform;
#[cfg(not(any(
    target_os = "ios",
    target_os = "macos",
    target_os = "android",
    target_arch = "wasm32"
)))]
use self::none as platform;
#[cfg(target_arch = "wasm32")]
use self::web as platform;
pub(crate) use self::{fake::FakeShare, js::Share};

/// The most bytes of text (and of a title) one share carries.
pub const MAX_TEXT_BYTES: usize = 1024 * 1024;

/// The most bytes of a shared URL.
pub const MAX_URL_BYTES: usize = 16 * 1024;

/// The most files one share carries.
pub const MAX_FILES: usize = 100;

/// Why a share fails when the app's capabilities do not grant `share`
/// (`ERR_ACCESS_DENIED`, permission `"share"`).
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
    pub fn anchor(mut self, anchor: &ElementRef) -> Self {
        self.anchor = anchor.node();
        self
    }

    /// Checks the request: something to share, text and title of at most
    /// [`MAX_TEXT_BYTES`], an absolute URL of a scheme that is shared (not
    /// `javascript:`, `data:`, `file:`, ...) of at most [`MAX_URL_BYTES`],
    /// at most [`MAX_FILES`] files, each by an absolute path. The error
    /// says what is wrong.
    pub(crate) fn check(&self) -> Result<(), String> {
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
        if let Some(path) = self.files.iter().find(|path| !absolute(path)) {
            return Err(format!(
                "share: `{}` is not an absolute path",
                path.display()
            ));
        }
        Ok(())
    }
}

/// Whether `path` is absolute. A page's paths (`${dataDir}` in the
/// browser's storage) have Unix roots, which `Path::is_absolute` does not
/// see on wasm32-unknown-unknown: it has no OS prefix.
fn absolute(path: &std::path::Path) -> bool {
    if cfg!(target_arch = "wasm32") {
        path.has_root()
    } else {
        path.is_absolute()
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
pub(crate) struct ShareSheet {
    pub(crate) title: Option<String>,
    pub(crate) text: Option<String>,
    pub(crate) url: Option<String>,
    /// The files' absolute paths.
    pub(crate) files: Vec<String>,
    /// The view the sheet points at where it is a popover: the platform
    /// places it at that element's native view, in whatever window or
    /// modal it is, when it is in a window. `None`: the middle of the
    /// surface.
    pub(crate) anchor: Option<NodeId>,
}

impl ShareSheet {
    /// What `request` shows.
    fn new(request: ShareRequest) -> Self {
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
            anchor: request.anchor,
        }
    }

    /// The text a platform that shares one string shares: the text and
    /// the URL, on lines of their own (Android's `EXTRA_TEXT`).
    #[cfg_attr(not(any(target_os = "android", test)), allow(dead_code))]
    pub(crate) fn combined_text(&self) -> Option<String> {
        match (&self.text, &self.url) {
            (Some(text), Some(url)) if !text.is_empty() => Some(format!("{text}\n{url}")),
            (Some(text), None) => Some(text.clone()),
            (_, Some(url)) => Some(url.clone()),
            (None, None) => None,
        }
    }
}

/// The type that covers two files' types, for a platform that shares
/// files under one type (Android's `ACTION_SEND`): the same, `image/*` for
/// two images, else any.
#[cfg(any(target_os = "android", test))]
fn common_type(a: &str, b: &str) -> String {
    if a == b {
        return a.to_owned();
    }
    match a.split_once('/') {
        Some((kind, _)) if !kind.is_empty() && b.starts_with(&format!("{kind}/")) => {
            format!("{kind}/*")
        }
        _ => "*/*".to_owned(),
    }
}

/// What the user did with the share sheet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub enum ShareAction {
    /// The user shared: the target finished (iOS), the service reported
    /// it finished or the user came back from one that reported nothing
    /// (macOS), the user chose an app (Android), `navigator.share`
    /// resolved (the web).
    Shared,
    /// The user closed the share sheet without sharing (or another share
    /// replaced it).
    #[default]
    Dismissed,
}

impl ShareAction {
    /// Its name in JS.
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
    pub(crate) fn shared(target: Option<String>) -> Self {
        Self {
            action: ShareAction::Shared,
            target,
        }
    }

    /// Dismissed without sharing.
    pub(crate) fn dismissed() -> Self {
        Self {
            action: ShareAction::Dismissed,
            target: None,
        }
    }
}

/// Why a share could not be shown or finish.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct ShareError {
    /// A stable code the app can branch on
    /// (`ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`, `ERR_ACCESS_DENIED`);
    /// `None` for other failures.
    pub code: Option<String>,
    /// What went wrong, in words.
    pub message: String,
}

impl ShareError {
    /// A failure with `message` and no code.
    pub(crate) fn failed(message: impl Into<String>) -> Self {
        Self {
            code: None,
            message: message.into(),
        }
    }

    /// The platform has no share sheet, or none for this content (a
    /// browser that shares no files).
    pub(crate) fn unavailable(message: impl Into<String>) -> Self {
        Self {
            code: Some(codes::UNAVAILABLE.into()),
            message: message.into(),
        }
    }

    /// The app's capabilities do not grant `share`.
    fn denied() -> Self {
        Self {
            code: Some(codes::ACCESS_DENIED.into()),
            message: NOT_GRANTED.into(),
        }
    }

    /// The error as JS gets it: an `Error` with its `code`.
    pub(crate) fn to_js(&self) -> JsError {
        match self.code.as_deref() {
            Some(codes::ACCESS_DENIED) => JsError::access_denied(self.message.clone(), "share", ""),
            Some(code) => JsError::Error(self.message.clone()).with_code(code),
            None => JsError::Error(self.message.clone()),
        }
    }
}

impl std::fmt::Display for ShareError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ShareError {}

type Answered = Result<ShareOutcome, ShareError>;

/// The answer to one share, which a platform sends once, from any thread:
/// later sends are dropped (the share was replaced, or already answered).
#[derive(Clone)]
pub(crate) struct Reply(Arc<ReplyState>);

struct ReplyState {
    id: u64,
    /// The engine whose share it is ([`OPEN`]).
    owner: Option<EngineId>,
    sender: Mutex<Option<oneshot::Sender<Answered>>>,
}

impl std::fmt::Debug for Reply {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Reply")
            .field("id", &self.0.id)
            .finish_non_exhaustive()
    }
}

impl Reply {
    fn new(owner: Option<EngineId>) -> (Self, oneshot::Receiver<Answered>) {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let (sender, receiver) = oneshot::channel();
        let reply = Reply(Arc::new(ReplyState {
            id: NEXT.fetch_add(1, Ordering::Relaxed),
            owner,
            sender: Mutex::new(Some(sender)),
        }));
        (reply, receiver)
    }

    /// Answers the share, unless it was answered: returns whether this
    /// did. It is then no longer its engine's open share.
    pub(crate) fn send(&self, result: Answered) -> bool {
        let sender = self
            .0
            .sender
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        let Some(sender) = sender else {
            return false;
        };
        let mut open = open();
        if open.get(&self.0.owner).is_some_and(|r| r.0.id == self.0.id) {
            open.remove(&self.0.owner);
        }
        drop(open);
        // The app may have stopped waiting; nothing else to do then.
        let _ = sender.send(result);
        true
    }

    /// Whether the share was answered (or replaced).
    #[cfg_attr(not(any(target_os = "ios", target_os = "macos")), allow(dead_code))]
    pub(crate) fn is_answered(&self) -> bool {
        self.0
            .sender
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_none()
    }
}

/// Each engine's open share, until it is answered or the next one
/// replaces it.
static OPEN: LazyLock<Mutex<HashMap<Option<EngineId>, Reply>>> = LazyLock::new(Default::default);

fn open() -> MutexGuard<'static, HashMap<Option<EngineId>, Reply>> {
    OPEN.lock().unwrap_or_else(|e| e.into_inner())
}

/// What shows the share sheets in place of the platform: the fake of
/// headless runs ([`FakeShare`], installed by the test driver).
static BACKEND: RwLock<Option<FakeShare>> = RwLock::new(None);

fn backend() -> Option<FakeShare> {
    BACKEND.read().unwrap_or_else(|e| e.into_inner()).clone()
}

fn set_backend(backend: Option<FakeShare>) {
    *BACKEND.write().unwrap_or_else(|e| e.into_inner()) = backend;
}

/// Whether the calling engine draws in a terminal (the TUI host, on any
/// OS): no share sheet shows there.
fn in_terminal() -> bool {
    // `idiom` needs an engine's environment, which `try_os` tells is there.
    nsh_core::element::try_os().is_some()
        && nsh_core::element::idiom() == nsh_core::platform::Idiom::Terminal
}

/// Whether the system's share sheet shows here (TS: `Share.available()`):
/// the platform has one (iOS, Android, macOS with AppKit, browsers with
/// `navigator.share`) and the app's capabilities grant `share`. In a task.
pub async fn available() -> bool {
    if nsh_core::element::access().is_some_and(|access| !access.allows_share()) {
        return false;
    }
    match backend() {
        Some(fake) => fake.available(),
        None if in_terminal() => false,
        None => platform::available().await,
    }
}

/// Shows the system's share sheet for `request` (TS: `Share.show`): text,
/// a link or local files the user sends to another app, a message or
/// mail. In a task, on the engine's thread: the [`ShareOutcome`] says
/// whether the user shared or dismissed it. It fails with the
/// [`ShareError`] `ERR_ACCESS_DENIED` where the app's capabilities do not
/// grant `share`, with no code for a request with nothing to share, over
/// the limits ([`MAX_TEXT_BYTES`], [`MAX_URL_BYTES`], [`MAX_FILES`]), with
/// a URL that is not shared (`javascript:`, `data:`, `file:`, relative)
/// or a file by a relative path, or where the platform could not share,
/// and with
/// `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` where the platform shows no share
/// sheet ([`available`]) or none for this content. A share still
/// open in the same engine is answered as dismissed first.
pub async fn show(request: ShareRequest) -> Result<ShareOutcome, ShareError> {
    if nsh_core::element::access().is_some_and(|access| !access.allows_share()) {
        log::warn!(target: "js", "{NOT_GRANTED}");
        return Err(ShareError::denied());
    }
    request.check().map_err(ShareError::failed)?;
    let owner = nsh_core::element::engine_id();
    let (reply, answer) = Reply::new(owner);
    // One sheet at a time: the one still open ends as dismissed, so a
    // sheet the platform never answers cannot hold every later share back.
    let earlier = open().insert(owner, reply.clone());
    if let Some(earlier) = earlier {
        earlier.send(Ok(ShareOutcome::dismissed()));
    }
    let sheet = ShareSheet::new(request);
    // The sheet's part runs on its own, and the share ends with the first
    // answer: a sheet may stay up past it (Android waits for the chooser to
    // close, a browser for `navigator.share` to settle), and the next share
    // answers this one at once while it is still up. The part ends with the
    // owner the share was started under, as the share itself does.
    match backend() {
        Some(fake) => drop(nsh_core::element::spawn(async move {
            fake.show(sheet, reply).await;
        })),
        None if in_terminal() => none::show(sheet, reply),
        // Where no platform sheet exists, `platform` is `none`, which
        // answers at once and has nothing to spawn.
        #[cfg(not(any(
            target_os = "ios",
            target_os = "macos",
            target_os = "android",
            target_arch = "wasm32"
        )))]
        None => platform::show(sheet, reply),
        #[cfg(any(
            target_os = "ios",
            target_os = "macos",
            target_os = "android",
            target_arch = "wasm32"
        ))]
        None => drop(nsh_core::element::spawn(platform::show(sheet, reply))),
    }
    answer
        .await
        .unwrap_or_else(|_| Err(ShareError::failed("share: the share sheet went away")))
}

/// Where NSH shows no share sheet: Windows, Linux, the terminal host on
/// every OS ([`in_terminal`]) and headless runs (whose shares the fake
/// answers when the test installs it, [`FakeShare`]).
mod none {
    use super::{Reply, ShareError, ShareSheet};

    #[cfg_attr(
        any(
            target_os = "ios",
            target_os = "macos",
            target_os = "android",
            target_arch = "wasm32"
        ),
        allow(dead_code)
    )]
    pub(super) async fn available() -> bool {
        false
    }

    pub(super) fn show(_: ShareSheet, reply: Reply) {
        reply.send(Err(ShareError::unavailable(
            "this platform has no share sheet",
        )));
    }
}

#[cfg(test)]
mod tests;
