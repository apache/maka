//! Web view downloads: the transport the platforms speak, the decision
//! events an app answers, and the files they write.
//!
//! The platform reports a download it holds with [`DownloadOffer`], its
//! progress with [`DownloadProgress`], and its end with [`DownloadEnd`]
//! (`EventKind::DownloadOffer`, `DownloadProgress`, `DownloadEnd`; payloads
//! made by [`download_offer`], [`download_progress`], [`download_end`]).
//! The core decides everything else here: whether the app chooses the
//! destination ([`WebDownloadPending`]) or the file goes to the app's data
//! directory, where it is staged, when it is published, what is cleaned up
//! and when it is time to give up.
//!
//! Platforms implement two operations ([`crate::webview::WebViewOperation`]): start
//! writing into a staging file the core made a private directory for, and
//! stop writing. Every one is answered with `EventKind::WebViewReply`.
//!
//! The file work happens on a thread of its own ([`files`]): the engine
//! thread never waits for a disk. A staging file is removed only after the
//! platform has said its writer stopped; a published file is never touched
//! again.

use std::{
    fmt,
    path::PathBuf,
    rc::{Rc, Weak},
    time::Duration,
};

use crate::{
    EventPayload, JsonValue, NodeId,
    element::{
        Answer,
        task::{Action, AnswerSlot, Executor},
    },
};

/// Where an accepted download writes.
///
/// The destination's parent directory must exist and its path must be
/// absolute; an existing file is refused unless [`Self::overwrite`] is
/// set. The core writes an owned private directory beside the destination
/// and publishes the file there only when the transfer finishes: without
/// `overwrite` a file that appears meanwhile makes the publish fail without
/// replacing it; failure, cancellation and teardown remove only that
/// private directory, never a file already at the destination.
#[non_exhaustive]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DownloadDestination {
    /// The file's absolute path; its parent directory must exist.
    pub path: PathBuf,
    /// Replace the file at [`Self::path`] (default: refuse an existing
    /// one).
    pub overwrite: bool,
}

impl DownloadDestination {
    /// A destination at `path`, refusing an existing file.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            overwrite: false,
        }
    }

    /// Sets the file's absolute path (the same as [`Self::new`]).
    #[must_use]
    pub fn path(mut self, path: impl Into<PathBuf>) -> Self {
        self.path = path.into();
        self
    }

    /// Replaces an existing file at [`Self::path`] when `overwrite` is
    /// true; a file that appears while the download runs is replaced only
    /// then (the default: the publish fails and leaves it untouched).
    #[must_use]
    pub fn overwrite(mut self, overwrite: bool) -> Self {
        self.overwrite = overwrite;
        self
    }
}

impl From<PathBuf> for DownloadDestination {
    fn from(path: PathBuf) -> Self {
        Self::new(path)
    }
}

/// Who owns a pending download's bytes ([`WebDownloadPending::source`]).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum WebDownloadSource {
    /// The engine's own transfer, continued on accept (WKWebView, WebView2,
    /// WebKitGTK, wry).
    #[default]
    Transfer,
    /// NSH issued the single request itself, inside the app's declared
    /// scope (Android).
    Request,
    /// The page hands the bytes over itself (later; every engine).
    Page,
    /// The response is gone: the download can only be cancelled (Android's
    /// system WebView, the browser).
    None,
}

impl WebDownloadSource {
    /// The name used on the wire (`"transfer"`, `"request"`, `"page"`,
    /// `"none"`).
    pub fn as_str(self) -> &'static str {
        match self {
            WebDownloadSource::Transfer => "transfer",
            WebDownloadSource::Request => "request",
            WebDownloadSource::Page => "page",
            WebDownloadSource::None => "none",
        }
    }

    pub(crate) fn parse(name: &str) -> Option<Self> {
        match name {
            "transfer" => Some(WebDownloadSource::Transfer),
            "request" => Some(WebDownloadSource::Request),
            "page" => Some(WebDownloadSource::Page),
            "none" => Some(WebDownloadSource::None),
            _ => None,
        }
    }
}

impl fmt::Display for WebDownloadSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Why a download was cancelled ([`WebDownload::reason`]).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CancelReason {
    /// The app cancelled it.
    App,
    /// The app never answered a pending download in time.
    Timeout,
    /// The web view went away.
    Teardown,
    /// Nothing listens for downloads (the listener was removed).
    NoListener,
}

impl CancelReason {
    /// The name used in the app's event (`"app"`, `"timeout"`,
    /// `"teardown"`, `"noListener"`).
    pub fn as_str(self) -> &'static str {
        match self {
            CancelReason::App => "app",
            CancelReason::Timeout => "timeout",
            CancelReason::Teardown => "teardown",
            CancelReason::NoListener => "noListener",
        }
    }
}

/// The state of a download ([`WebDownload`]).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum WebDownloadState {
    /// It started writing.
    #[default]
    Started,
    /// It finished writing and its file was published atomically.
    Finished,
    /// It failed; [`WebDownload::code`] and [`WebDownload::message`] say
    /// why.
    Failed,
    /// The app, the offer timeout, the teardown or the loss of every
    /// listener ended it ([`WebDownload::reason`]).
    Cancelled,
}

impl WebDownloadState {
    /// The state named `name` in an app's payload (`"started"`,
    /// `"finished"`, `"failed"`, `"cancelled"`).
    pub(crate) fn parse(name: &str) -> Option<Self> {
        match name {
            "started" => Some(WebDownloadState::Started),
            "finished" => Some(WebDownloadState::Finished),
            "failed" => Some(WebDownloadState::Failed),
            "cancelled" => Some(WebDownloadState::Cancelled),
            _ => None,
        }
    }
}

impl fmt::Display for WebDownloadState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            WebDownloadState::Started => "started",
            WebDownloadState::Finished => "finished",
            WebDownloadState::Failed => "failed",
            WebDownloadState::Cancelled => "cancelled",
        })
    }
}

/// A download a web view's page asked for, waiting for the app to say
/// where it goes ([`crate::EventKind::DownloadPending`], the Rust
/// `WebView::on_download_pending`).
///
/// The event is the same download to every clone: [`accept`](Self::accept)
/// and [`cancel`](Self::cancel) act on the download it was reported for,
/// and never on another view's or another download's. An app can make only
/// the empty [`Default`] value, which names no download: its decisions
/// resolve with an error.
#[derive(Clone, Debug, Default)]
#[non_exhaustive]
pub struct WebDownloadPending {
    /// The download, for matching its [`WebDownload`] lifecycle.
    pub id: String,
    /// The URL it downloads.
    pub url: String,
    /// The name the page gives it (`Content-Disposition`, or the URL's).
    pub filename: String,
    /// Who owns its bytes ([`WebDownloadSource`]).
    pub source: WebDownloadSource,
    /// The content type the engine reported, when it did.
    pub mime_type: Option<String>,
    /// The declared size of the file the transfer will write, when the
    /// engine could state it truthfully.
    pub bytes: Option<u64>,
    /// The request's method (`"GET"` / `"POST"`) when the engine actually
    /// told it; never guessed from the URL.
    pub method: Option<String>,
    /// The view, node and download the decision belongs to; `None` for a
    /// value the app made itself ([`Default`]), whose every decision fails.
    pub(crate) handle: Option<DownloadHandle>,
}

impl WebDownloadPending {
    /// Writes the download to `destination` (a [`PathBuf`] refuses an
    /// existing file; use [`DownloadDestination`] for `overwrite`).
    ///
    /// Await the answer in a task: it settles when the destination is
    /// accepted (or refused), not when the transfer finishes
    /// ([`crate::EventKind::Download`] reports that). Nothing is written
    /// before the destination is accepted.
    pub fn accept(
        &self,
        destination: impl Into<DownloadDestination>,
    ) -> Answer<Result<(), String>> {
        match &self.handle {
            Some(handle) => handle.decide(Decision::Accept(destination.into())),
            None => unbound(),
        }
    }

    /// Cancels the download: a pending one writes nothing; an accepted one
    /// stops, and the core removes only the staging file it wrote.
    /// Await the answer in a task.
    pub fn cancel(&self) -> Answer<Result<(), String>> {
        match &self.handle {
            Some(handle) => handle.decide(Decision::Cancel),
            None => unbound(),
        }
    }
}

impl PartialEq for WebDownloadPending {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
            && self.url == other.url
            && self.filename == other.filename
            && self.source == other.source
            && self.mime_type == other.mime_type
            && self.bytes == other.bytes
            && self.method == other.method
            && match (&self.handle, &other.handle) {
                (Some(a), Some(b)) => a.same_as(b),
                (None, None) => true,
                _ => false,
            }
    }
}

impl Eq for WebDownloadPending {}

/// What a held download is asked to do.
#[derive(Clone, Debug)]
pub(crate) enum Decision {
    Accept(DownloadDestination),
    Cancel,
}

/// The decision handle of a download event: the view's node, the executor
/// that reaches it, and the download's id. Only the core makes one (from
/// the event it dispatched to the view's listener), so a decision cannot
/// be forged into another view.
#[derive(Clone, Debug)]
pub(crate) struct DownloadHandle {
    identity: Rc<DownloadIdentity>,
}

#[derive(Debug)]
struct DownloadIdentity {
    node: NodeId,
    executor: Weak<Executor>,
    id: String,
}

impl DownloadHandle {
    pub(crate) fn new(node: NodeId, executor: Weak<Executor>, id: String) -> Self {
        Self {
            identity: Rc::new(DownloadIdentity { node, executor, id }),
        }
    }

    fn same_as(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.identity, &other.identity)
    }

    /// Sends `decision` to the core, tied to the download this handle was
    /// made for.
    fn decide(&self, decision: Decision) -> Answer<Result<(), String>> {
        let (answer, slot) = Answer::new();
        let Some(executor) = self.identity.executor.upgrade() else {
            deliver(slot, Err(NOT_MOUNTED.to_owned()));
            return answer;
        };
        executor.act(Action::DownloadDecision {
            node: self.identity.node,
            id: self.identity.id.clone(),
            decision,
            answer: slot,
        });
        answer
    }
}

/// What a download did ([`crate::EventKind::Download`], the Rust
/// `WebView::on_download`).
#[non_exhaustive]
#[derive(Clone, Debug, Default)]
pub struct WebDownload {
    /// Where it is in its life.
    pub state: WebDownloadState,
    /// The download's id ([`WebDownloadPending::id`] for one the app
    /// accepted).
    pub id: String,
    /// The URL it downloads.
    pub url: String,
    /// The file's name.
    pub filename: String,
    /// Where it is written: the app's data directory's
    /// `downloads/<id>/<filename>` for an automatic download, or the
    /// destination the app accepted; empty for one cancelled before a
    /// destination was chosen.
    pub path: PathBuf,
    /// Its size in bytes, once finished.
    pub bytes: Option<u64>,
    /// Why it failed, or the platform's reason when it did.
    pub message: Option<String>,
    /// Who owned its bytes.
    pub source: WebDownloadSource,
    /// The stable code on [`WebDownloadState::Failed`] and
    /// [`WebDownloadState::Cancelled`].
    pub code: Option<String>,
    /// Why it was cancelled.
    pub reason: Option<CancelReason>,
    /// The view, node and download the controls belong to.
    pub(crate) handle: Option<DownloadHandle>,
}

impl PartialEq for WebDownload {
    fn eq(&self, other: &Self) -> bool {
        self.state == other.state
            && self.id == other.id
            && self.url == other.url
            && self.filename == other.filename
            && self.path == other.path
            && self.bytes == other.bytes
            && self.message == other.message
            && self.source == other.source
            && self.code == other.code
            && self.reason == other.reason
            && match (&self.handle, &other.handle) {
                (Some(a), Some(b)) => a.same_as(b),
                (None, None) => true,
                _ => false,
            }
    }
}

impl Eq for WebDownload {}

impl WebDownload {
    /// Cancels the download while it is [`WebDownloadState::Started`]: the
    /// core stops it and removes only the staging file it wrote. Await the
    /// answer in a task. Fails with `ERR_NSH_DOWNLOAD_STATE` once it has
    /// finished, failed or been cancelled.
    pub fn cancel(&self) -> Answer<Result<(), String>> {
        match (&self.handle, self.state) {
            (Some(handle), WebDownloadState::Started) => handle.decide(Decision::Cancel),
            (Some(_), _) => {
                let (answer, slot) = Answer::new();
                deliver(slot, Err(crate::element::codes::DOWNLOAD_STATE.to_owned()));
                answer
            }
            (None, _) => unbound(),
        }
    }
}

/// Delivers `result` to a request's answer.
fn deliver(slot: AnswerSlot<Result<(), String>>, result: Result<(), String>) {
    slot.borrow_mut().deliver(result);
}

/// A decision from a [`WebDownloadPending`] no event made ([`Default`]):
/// it names no download, so it fails rather than guess one.
fn unbound() -> Answer<Result<(), String>> {
    let (answer, slot) = Answer::new();
    deliver(slot, Err(UNBOUND.to_owned()));
    answer
}

/// Why a decision failed when it did not come from a download event (a
/// [`WebDownloadPending`] made with [`Default`]).
pub(crate) const UNBOUND: &str = "this download decision is not bound to a pending download";

/// Why a decision failed when the web view is not mounted.
pub(crate) const NOT_MOUNTED: &str = "the web view is not mounted";

/// How long the core waits for the platform to answer a download command
/// (`WebViewReply`). It is not evidence that a writer stopped: a timeout
/// never permits cleaning a staging file.
pub(crate) const REPLY_TIMEOUT: Duration = Duration::from_secs(30);

/// How long an unanswered manual offer may exist before it is cancelled
/// with [`CancelReason::Timeout`].
pub(crate) const OFFER_TIMEOUT: Duration = Duration::from_secs(60);

// --- The platform's events ---------------------------------------------------

/// A download the platform holds ([`crate::EventKind::DownloadOffer`]).
#[doc(hidden)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DownloadOffer {
    /// Stable for this view's download; unique within the view.
    pub id: String,
    /// The URL the engine reports (the final one after redirects).
    pub url: String,
    /// The suggested file name, never a path.
    pub filename: String,
    /// The content type, when the engine reported it.
    pub mime_type: Option<String>,
    /// The declared size of the bytes the file will contain, when it
    /// describes that representation truthfully.
    pub bytes: Option<u64>,
    /// `"GET"` / `"POST"` when the engine exposed the request's method.
    pub method: Option<String>,
    /// Who owns the bytes.
    pub source: WebDownloadSource,
}

/// The bytes a transfer received ([`crate::EventKind::DownloadProgress`]).
#[doc(hidden)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DownloadProgress {
    /// The download.
    pub id: String,
    /// Bytes received so far.
    pub received: u64,
}

/// How a transfer ended ([`crate::EventKind::DownloadEnd`]).
#[doc(hidden)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DownloadEnd {
    /// The download.
    pub id: String,
    /// How it ended.
    pub outcome: DownloadOutcome,
}

/// The end of a transfer ([`DownloadEnd::outcome`]).
#[doc(hidden)]
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DownloadOutcome {
    /// The writer closed after writing exactly `bytes`.
    Finished {
        /// The file's size.
        bytes: u64,
    },
    /// The transfer stopped without success.
    Failed {
        /// A stable code, when the platform has one.
        code: Option<String>,
        /// Why it failed.
        message: String,
    },
}

/// The payload reporting an offer ([`EventKind::DownloadOffer`]).
#[doc(hidden)]
pub fn download_offer(offer: &DownloadOffer) -> EventPayload {
    EventPayload::Json(serde_json::json!({
        "id": offer.id,
        "url": offer.url,
        "filename": offer.filename,
        "mime_type": offer.mime_type,
        "bytes": offer.bytes,
        "method": offer.method,
        "source": offer.source.as_str(),
    }))
}

/// The payload reporting progress ([`EventKind::DownloadProgress`]).
#[doc(hidden)]
pub fn download_progress(progress: &DownloadProgress) -> EventPayload {
    EventPayload::Json(serde_json::json!({
        "id": progress.id,
        "received": progress.received,
    }))
}

/// The payload reporting an end ([`EventKind::DownloadEnd`]).
#[doc(hidden)]
pub fn download_end(end: &DownloadEnd) -> EventPayload {
    let value = match &end.outcome {
        DownloadOutcome::Finished { bytes } => serde_json::json!({
            "id": end.id,
            "outcome": "finished",
            "bytes": bytes,
        }),
        DownloadOutcome::Failed { code, message } => serde_json::json!({
            "id": end.id,
            "outcome": "failed",
            "code": code,
            "message": message,
        }),
    };
    EventPayload::Json(value)
}

fn parse_u64(value: &JsonValue) -> Option<u64> {
    value.as_u64().or_else(|| {
        value
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0 && n.fract() == 0.0)
            .map(|n| n as u64)
    })
}

pub(crate) fn parse_offer(value: &JsonValue) -> Option<DownloadOffer> {
    Some(DownloadOffer {
        id: value.get("id")?.as_str()?.to_owned(),
        url: value.get("url")?.as_str()?.to_owned(),
        filename: value.get("filename")?.as_str()?.to_owned(),
        mime_type: value
            .get("mime_type")
            .and_then(JsonValue::as_str)
            .map(str::to_owned),
        bytes: value.get("bytes").and_then(parse_u64),
        method: value
            .get("method")
            .and_then(JsonValue::as_str)
            .map(str::to_owned),
        source: value
            .get("source")
            .and_then(JsonValue::as_str)
            .and_then(WebDownloadSource::parse)
            .unwrap_or_default(),
    })
}

pub(crate) fn parse_end(value: &JsonValue) -> Option<DownloadEnd> {
    let id = value.get("id")?.as_str()?.to_owned();
    let outcome = match value.get("outcome")?.as_str()? {
        "finished" => DownloadOutcome::Finished {
            bytes: value.get("bytes").and_then(parse_u64).unwrap_or(0),
        },
        "failed" => DownloadOutcome::Failed {
            code: value
                .get("code")
                .and_then(JsonValue::as_str)
                .map(str::to_owned),
            message: value
                .get("message")
                .and_then(JsonValue::as_str)
                .unwrap_or_default()
                .to_owned(),
        },
        _ => return None,
    };
    Some(DownloadEnd { id, outcome })
}

// --- The app's events --------------------------------------------------------

/// The destination an automatic download goes to: the app's data directory's
/// `downloads/<id>/<filename>` (the leaf's parent is made by the file
/// layer). `None` when the app has no data directory.
pub(crate) fn automatic_destination(id: &str, filename: &str) -> Option<DownloadDestination> {
    let dir = crate::element::data_dir()?;
    let mut component = String::with_capacity(id.len().min(64));
    for c in id.chars().take(64) {
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') {
            component.push(c);
        } else {
            component.push('_');
        }
    }
    if component.is_empty() {
        component.push('_');
    }
    let name = std::path::Path::new(filename)
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
        .filter(|name| !name.is_empty() && *name != "." && *name != "..")
        .unwrap_or("download");
    Some(DownloadDestination::new(
        dir.join("downloads").join(component).join(name),
    ))
}

// --- The file layer ----------------------------------------------------------

/// The downloads' files: a private staging directory beside the
/// destination, an atomic publish, and cleanup of exactly what this module
/// made.
pub(crate) mod files {
    #[cfg(unix)]
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    use std::{
        fs, io,
        path::{Path, PathBuf},
    };

    /// A private directory the core made for one download, and the file
    /// inside it the platform (or the engine) writes. The leaf does not
    /// exist until the writer creates it: WKWebView, WebKitGTK and
    /// WebView2 all require a nonexistent destination.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub(crate) struct Staging {
        dir: PathBuf,
        path: PathBuf,
        /// The app's own `downloads/<id>` (automatic): remove it too when
        /// it is left empty.
        owned_parent: bool,
        /// The directory's identity when it was made (Unix): cleanup never
        /// removes a directory that replaced ours.
        #[cfg(unix)]
        identity: (u64, u64),
    }

    impl Staging {
        /// The file the writer creates and fills.
        pub(crate) fn path(&self) -> &Path {
            &self.path
        }

        /// The private directory that holds it.
        #[cfg(test)]
        pub(crate) fn dir(&self) -> &Path {
            &self.dir
        }

        /// A staging directory a host registered with
        /// [`super::DownloadCleanup`] itself.
        pub(crate) fn adopt(dir: PathBuf, path: PathBuf) -> Self {
            #[cfg(unix)]
            let identity = fs::symlink_metadata(&dir)
                .map(|meta| (meta.dev(), meta.ino()))
                .unwrap_or((0, 0));
            Self {
                dir,
                path,
                owned_parent: false,
                #[cfg(unix)]
                identity,
            }
        }
    }

    /// The name a download's private directory gets: the id with path
    /// separators (and anything else unusual) replaced, so it stays one
    /// component.
    fn dir_name(id: &str) -> String {
        let mut name = String::with_capacity(id.len().min(64) + 16);
        name.push_str(".nsh-download-");
        for c in id.chars().take(64) {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') {
                name.push(c);
            } else {
                name.push('_');
            }
        }
        name
    }

    /// Checks a destination and makes the private directory for download
    /// `id`: refused destinations are errors, and an existing staging
    /// directory is one too. The leaf is not created.
    pub(crate) fn stage(
        destination: &Path,
        id: &str,
        overwrite: bool,
        create_parent: bool,
    ) -> Result<Staging, String> {
        if !destination.is_absolute() {
            return Err(format!(
                "`{}` is not an absolute path",
                destination.display()
            ));
        }
        let Some(name) = destination.file_name().filter(|n| !n.is_empty()) else {
            return Err(format!("`{}` does not name a file", destination.display()));
        };
        let Some(parent) = destination.parent() else {
            return Err(format!("`{}` has no directory", destination.display()));
        };
        if !parent.is_dir() {
            if !create_parent {
                return Err(format!(
                    "`{}` is not a directory to write into",
                    parent.display()
                ));
            }
            // The app's own `downloads/<id>` (never an arbitrary parent:
            // only automatic destinations ask for this).
            fs::create_dir_all(parent)
                .map_err(|error| format!("`{}` cannot be made: {error}", parent.display()))?;
        }
        // A directory entry of any kind (a broken symlink too): writing
        // would replace or follow it.
        match fs::symlink_metadata(destination) {
            Ok(meta) => {
                if meta.is_dir() {
                    return Err(format!("`{}` is a directory", destination.display()));
                }
                if !overwrite {
                    return Err(format!(
                        "`{}` exists; pass overwrite to replace it",
                        destination.display()
                    ));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "`{}` cannot be checked: {error}",
                    destination.display()
                ));
            }
        }
        let dir = parent.join(dir_name(id));
        #[cfg(unix)]
        let created = fs::DirBuilder::new().mode(0o700).create(&dir);
        #[cfg(not(unix))]
        let created = fs::create_dir(&dir);
        match created {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                return Err(format!(
                    "a staging area for this download already exists: `{}`",
                    dir.display()
                ));
            }
            Err(error) => {
                return Err(format!("`{}` cannot be made: {error}", dir.display()));
            }
        }
        let path = dir.join(name);
        #[cfg(unix)]
        let identity = {
            let meta = fs::symlink_metadata(&dir)
                .map_err(|error| format!("`{}` cannot be read: {error}", dir.display()))?;
            (meta.dev(), meta.ino())
        };
        Ok(Staging {
            dir,
            path,
            owned_parent: create_parent,
            #[cfg(unix)]
            identity,
        })
    }

    /// Why a staged file could not be published.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub(crate) enum PublishError {
        /// The file's real length is not the declared size.
        Size { actual: u64, declared: u64 },
        /// The destination or the staged file refused the publish.
        Destination(String),
    }

    /// Publishes the staged file at `destination`: the file's real length
    /// is checked against `declared` first (the transport's number is
    /// never trusted for the app's `bytes`), then an atomic no-replace move
    /// or an explicit replacement. Answers the published file's real size.
    /// The staging directory is removed on success.
    pub(crate) fn publish(
        staging: &Staging,
        destination: &Path,
        overwrite: bool,
        declared: Option<u64>,
    ) -> Result<u64, PublishError> {
        let meta = fs::symlink_metadata(staging.path()).map_err(|error| {
            PublishError::Destination(format!(
                "the staged file `{}` is gone: {error}",
                staging.path().display()
            ))
        })?;
        if !meta.file_type().is_file() {
            // A directory, a symlink or a fifo where our writer's file
            // must be: never publish (or follow) it.
            return Err(PublishError::Destination(format!(
                "`{}` is not a regular file",
                staging.path().display()
            )));
        }
        // The real file is the authority for the size the app hears and
        // for the declared size's check.
        let actual = meta.len();
        if let Some(declared) = declared
            && declared != actual
        {
            return Err(PublishError::Size { actual, declared });
        }
        if overwrite {
            fs::rename(staging.path(), destination).map_err(|error| {
                PublishError::Destination(format!(
                    "`{}` cannot be published as `{}`: {error}",
                    staging.path().display(),
                    destination.display()
                ))
            })?;
        } else {
            publish_new(staging.path(), destination).map_err(|error| {
                PublishError::Destination(format!(
                    "`{}` cannot be published as `{}`: {error}",
                    staging.path().display(),
                    destination.display()
                ))
            })?;
        }
        let _ = fs::remove_dir(&staging.dir);
        Ok(actual)
    }

    /// Android restricts hard links even inside app storage. A no-replace
    /// rename preserves the same atomic destination check without a link.
    fn publish_new(from: &Path, to: &Path) -> io::Result<()> {
        #[cfg(any(target_os = "linux", target_os = "android"))]
        {
            use std::{ffi::CString, os::unix::ffi::OsStrExt};

            let from_c = CString::new(from.as_os_str().as_bytes())
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
            let to_c = CString::new(to.as_os_str().as_bytes())
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
            // SAFETY: both paths are live NUL-terminated strings. No pointers
            // are retained; RENAME_NOREPLACE leaves an existing target intact.
            let result = unsafe {
                libc::syscall(
                    libc::SYS_renameat2,
                    libc::AT_FDCWD,
                    from_c.as_ptr(),
                    libc::AT_FDCWD,
                    to_c.as_ptr(),
                    libc::RENAME_NOREPLACE,
                )
            };
            if result == 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if !matches!(
                error.raw_os_error(),
                Some(libc::ENOSYS | libc::EINVAL | libc::EOPNOTSUPP)
            ) {
                return Err(error);
            }
        }
        // An older filesystem may support an atomic link instead. Never
        // fall back to overwrite-capable rename after checking existence.
        fs::hard_link(from, to)?;
        if let Err(error) = fs::remove_file(from) {
            // The destination is already published; cleanup cannot undo it.
            log::warn!("download published, but its staging link could not be removed: {error}");
        }
        Ok(())
    }

    /// Removes only what [`stage`] made. Safe after a failed publish: a
    /// file already at the destination is not touched, and a directory
    /// that replaced ours is never removed with its contents.
    pub(crate) fn cleanup(staging: &Staging) -> Result<(), String> {
        let mut removed = false;
        match fs::symlink_metadata(&staging.dir) {
            Ok(meta) if meta.is_dir() => {
                #[cfg(unix)]
                let ours = (meta.dev(), meta.ino()) == staging.identity;
                #[cfg(not(unix))]
                let ours = true;
                if ours {
                    removed = fs::remove_dir_all(&staging.dir).is_ok();
                } else {
                    log::warn!(
                        "web view download: `{}` is not the directory this download made; left alone",
                        staging.dir.display()
                    );
                }
            }
            Ok(_) => {
                // Not a directory any more (a symlink or a file replaced
                // it): remove only that entry, never follow it.
                removed = fs::remove_file(&staging.dir).is_ok();
            }
            Err(_) => {
                removed = true;
            }
        }
        if staging.owned_parent
            && removed
            && let Some(parent) = staging.dir.parent()
        {
            // Only when nothing (the published file included) is left.
            let _ = fs::remove_dir(parent);
        }
        if removed {
            Ok(())
        } else {
            Err(format!(
                "`{}` could not be removed (it is not this download's directory any more)",
                staging.dir.display()
            ))
        }
    }
}

// --- The coordinator ---------------------------------------------------------

mod coordinator;
mod shutdown;

pub(crate) use coordinator::{Downloads, Effect, Mode};
#[doc(hidden)]
pub use shutdown::DownloadCleanup;
