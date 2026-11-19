//! A web view's downloads: the files its page saves, where an app chooses
//! they go, and the transport every platform speaks.
//!
//! An app that listens for [`crate::EventKind::DownloadPending`]
//! ([`crate::element::WebView::on_download_pending`]) chooses every
//! download's destination itself: the platform holds the transfer and
//! reports it as a [`WebDownloadPending`], whose
//! [`accept`](WebDownloadPending::accept) and
//! [`cancel`](WebDownloadPending::cancel) decide it. An app that listens
//! for [`crate::EventKind::Download`] alone ([`crate::element::WebView::on_download`])
//! has its downloads written into the app's data directory
//! (`downloads/<id>/<filename>`). With neither listener the platform keeps
//! its own behavior.
//!
//! A destination is a [`DownloadDestination`]: an absolute path whose
//! parent directory exists. It refuses an existing file unless
//! [`DownloadDestination::overwrite`] says to replace it. The core writes a
//! private staging directory beside the destination (its leaf does not
//! exist until the engine creates it) and publishes the file atomically
//! only when the transfer finishes, so a failed, cancelled or interrupted
//! download never replaces or corrupts a file at the destination; only the
//! private directory is removed, and only after the platform said its
//! writer stopped.
//!
//! Platforms are transports: they report offers, progress and ends
//! ([`DownloadOffer`], [`DownloadProgress`], [`DownloadEnd`]) and carry out
//! [`WebViewOperation`]s ([`crate::Command::WebViewRequest`]), answering
//! each with [`crate::EventKind::WebViewReply`] and [`reply`]. The state
//! machine, the timeouts, the destination checks, the files and the
//! app-facing events live in [`downloads`], on the engine thread; the disk
//! work runs on a thread of its own.
//!
//! [`WebDownload`] reports an automatic or accepted download's life and
//! [`WebDownload::cancel`] cancels one that is under way. A download a
//! platform cannot own is reported as failed with
//! `ERR_NSH_DOWNLOAD_DISCARDED`.

use std::path::PathBuf;

use crate::{EventPayload, JsonValue};

pub mod downloads;

pub(crate) use downloads::DownloadHandle;
pub use downloads::{
    CancelReason, DownloadDestination, WebDownload, WebDownloadPending, WebDownloadSource,
    WebDownloadState,
};
#[doc(hidden)]
pub use downloads::{
    DownloadCleanup, DownloadEnd, DownloadOffer, DownloadOutcome, DownloadProgress, download_end,
    download_offer, download_progress,
};

/// What a web view is asked to do ([`crate::Command::WebViewRequest`]).
///
/// A platform answers each with [`crate::EventKind::WebViewReply`]:
/// `StartDownload` once it accepted the staging path and its transfer
/// continued, `CancelDownload` only after its writer stopped.
#[doc(hidden)]
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WebViewOperation {
    /// Writes the download `id` into `staging` (a file that does not
    /// exist yet, inside a private directory the core made; its parent
    /// exists).
    StartDownload {
        /// The download ([`WebDownloadPending::id`]).
        id: String,
        /// The file to create and fill.
        staging: PathBuf,
    },
    /// Stops the download `id`: a held transfer is discarded, a running
    /// one stops writing. The answer comes when writing stopped.
    CancelDownload {
        /// The download.
        id: String,
    },
}

/// A request on a web view, carrying the core's request id so the
/// platform's reply names it ([`crate::EventKind::WebViewReply`]).
#[doc(hidden)]
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WebViewRequest {
    /// The request's id, assigned by the core.
    pub id: u64,
    /// What to do.
    pub operation: WebViewOperation,
}

impl Default for WebViewRequest {
    fn default() -> Self {
        Self {
            id: 0,
            operation: WebViewOperation::CancelDownload { id: String::new() },
        }
    }
}

/// The event payload answering [`WebViewRequest`] `id` with `result`
/// ([`crate::EventKind::WebViewReply`]).
#[doc(hidden)]
pub fn reply(id: u64, result: Result<JsonValue, String>) -> EventPayload {
    let value = match result {
        Ok(value) => serde_json::json!({ "id": id, "ok": true, "value": value }),
        Err(error) => serde_json::json!({ "id": id, "ok": false, "error": error }),
    };
    EventPayload::Json(value)
}
