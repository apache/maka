//! What outlives a core: the last stop acknowledgement a platform sends
//! after the engine is gone.
//!
//! When an engine is dropped, its channel closes and a platform that was
//! still holding a download has nowhere to report its writer stopping.
//! [`DownloadCleanup`] is that place: the core registers each private
//! staging directory and the request ids of its cancel commands with it,
//! and the engine's control handle keeps a clone. A `dispatch_event` whose
//! send fails hands the event here instead; a `DownloadEnd` (the writer
//! stopped) or a successful `WebViewReply` to a cancel then removes the
//! private directory asynchronously. The sink holds paths and ids only —
//! no UI, no core, no executor — and never touches the destination.

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use rustc_hash::FxHashMap;

use super::{DownloadEnd, coordinator::Key, files, parse_end};
use crate::{EventKind, EventPayload, JsonValue, NodeId};

/// The staging directories and cancel requests a dead core still owns.
#[doc(hidden)]
#[derive(Clone, Default)]
pub struct DownloadCleanup {
    state: Arc<Mutex<CleanupState>>,
}

#[derive(Default)]
struct CleanupState {
    /// The core is gone: a stop recorded from now on cleans at once.
    closed: bool,
    /// Each download's staging directory and whether its writer stopped.
    /// The core records a stop when it hears one (so a queued event the
    /// engine never consumes is not lost) but cleans normally while it
    /// lives; [`DownloadCleanup::close`] cleans what stopped.
    downloads: FxHashMap<(NodeId, String), Entry>,
    /// The cancel command of each download, by the core's request id.
    requests: FxHashMap<u64, (NodeId, String)>,
}

struct Entry {
    staging: files::Staging,
    stopped: bool,
}

impl DownloadCleanup {
    /// An empty sink.
    pub fn new() -> Self {
        Self::default()
    }

    /// The core stages download `key` in `staging`: it is the sink's to
    /// clean until the core says otherwise.
    pub(crate) fn stage(&self, key: &Key, staging: &files::Staging) {
        self.state
            .lock()
            .expect("download cleanup lock")
            .downloads
            .insert(
                (key.node, key.id.clone()),
                Entry {
                    staging: staging.clone(),
                    stopped: false,
                },
            );
    }

    /// The core heard the writer stop (`DownloadEnd` or a successful
    /// cancel reply). While the core lives this is only recorded: it may
    /// still publish. If the core is already gone, the private directory
    /// is cleaned now.
    pub(crate) fn stop(&self, key: &Key) {
        if let Some(staging) = mark_stopped(&self.state, key.node, &key.id) {
            clean(staging);
        }
    }

    /// The core is gone: clean everything whose writer already stopped;
    /// a later stop (an event already queued, or sent after the channel
    /// closed) cleans its entry when recorded.
    #[doc(hidden)]
    pub fn close(&self) {
        let stopped: Vec<files::Staging> = {
            let mut state = self.state.lock().expect("download cleanup lock");
            state.closed = true;
            let keys: Vec<(NodeId, String)> = state
                .downloads
                .iter()
                .filter(|(_, entry)| entry.stopped)
                .map(|(key, _)| key.clone())
                .collect();
            keys.iter()
                .filter_map(|key| state.downloads.remove(key).map(|entry| entry.staging))
                .collect()
        };
        for staging in stopped {
            clean(staging);
        }
    }

    /// Registers a cancel command's request id as an acknowledgement that
    /// means "the writer of `key` stopped".
    pub(crate) fn track(&self, request: u64, key: &Key) {
        self.state
            .lock()
            .expect("download cleanup lock")
            .requests
            .insert(request, (key.node, key.id.clone()));
    }

    /// The core consumed request `request` itself.
    pub(crate) fn untrack(&self, request: u64) {
        self.state
            .lock()
            .expect("download cleanup lock")
            .requests
            .remove(&request);
    }

    /// The core finished with `key` (published, cleaned or failed): the
    /// sink has nothing left to clean for it.
    pub(crate) fn done(&self, key: &Key) {
        let mut state = self.state.lock().expect("download cleanup lock");
        state.downloads.remove(&(key.node, key.id.clone()));
        state
            .requests
            .retain(|_, (node, id)| *node != key.node || *id != key.id);
    }

    /// A host registering a staging directory itself (the engine's tests;
    /// the core uses [`Self::stage`]).
    #[doc(hidden)]
    pub fn register_staging(&self, node: NodeId, id: &str, dir: PathBuf, leaf: PathBuf) {
        let staging = files::Staging::adopt(dir, leaf);
        self.state
            .lock()
            .expect("download cleanup lock")
            .downloads
            .insert(
                (node, id.to_owned()),
                Entry {
                    staging,
                    stopped: false,
                },
            );
    }

    /// An event the engine could not deliver because it is gone: a stop
    /// acknowledgement cleans what the dead core still owned.
    ///
    /// A `DownloadEnd` (the writer stopped, whatever its outcome) and a
    /// successful `WebViewReply` to a registered cancel command both prove
    /// that no writer can recreate the staging path any more.
    pub fn dispatch(&self, node: NodeId, kind: EventKind, payload: &EventPayload) {
        let EventPayload::Json(value) = payload else {
            return;
        };
        let staging = match kind {
            EventKind::DownloadEnd => {
                let Some(end) = parse_end(value) else {
                    return;
                };
                mark_stopped(&self.state, node, &end.id)
            }
            EventKind::WebViewReply => {
                if value.get("ok").and_then(JsonValue::as_bool) != Some(true) {
                    return;
                }
                let request = value.get("id").and_then(|id| {
                    id.as_u64().or_else(|| {
                        id.as_f64()
                            .filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= 0.0)
                            .map(|n| n as u64)
                    })
                });
                request.and_then(|request| mark_request_stopped(&self.state, node, request))
            }
            _ => None,
        };
        if let Some(staging) = staging {
            clean(staging);
        }
    }

    /// A `DownloadEnd` for `id` on `node` (its writer stopped).
    #[doc(hidden)]
    pub fn stopped(&self, node: NodeId, end: &DownloadEnd) {
        if let Some(staging) = mark_stopped(&self.state, node, &end.id) {
            clean(staging);
        }
    }
}

/// Records that download `id` of `node` stopped; returns its staging
/// directory when the sink is closed (the cleanup is due now).
fn mark_stopped(
    state: &Arc<Mutex<CleanupState>>,
    node: NodeId,
    id: &str,
) -> Option<files::Staging> {
    let mut state = state.lock().expect("download cleanup lock");
    state.requests.retain(|_, (n, i)| *n != node || i != id);
    let closed = state.closed;
    let entry = state.downloads.get_mut(&(node, id.to_owned()))?;
    entry.stopped = true;
    if closed {
        state
            .downloads
            .remove(&(node, id.to_owned()))
            .map(|entry| entry.staging)
    } else {
        None
    }
}

/// A successful reply to cancel `request`: the writer of its download
/// stopped.
fn mark_request_stopped(
    state: &Arc<Mutex<CleanupState>>,
    node: NodeId,
    request: u64,
) -> Option<files::Staging> {
    let mut state = state.lock().expect("download cleanup lock");
    if state.requests.get(&request)?.0 != node {
        return None;
    }
    let (_, id) = state.requests.remove(&request)?;
    state.requests.retain(|_, (n, i)| *n != node || *i != id);
    let closed = state.closed;
    let entry = state.downloads.get_mut(&(node, id.clone()))?;
    entry.stopped = true;
    if closed {
        state
            .downloads
            .remove(&(node, id))
            .map(|entry| entry.staging)
    } else {
        None
    }
}

/// Removes the private directory away from the thread that reported the
/// stop (there may be no engine thread left).
fn clean(staging: files::Staging) {
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = std::thread::Builder::new()
            .name("nsh-download-cleanup".into())
            .spawn(move || {
                let _ = files::cleanup(&staging);
            });
    }
    #[cfg(target_arch = "wasm32")]
    {
        let _ = files::cleanup(&staging);
    }
}

#[cfg(test)]
mod tests {
    use std::{
        path::PathBuf,
        time::{Duration, Instant},
    };

    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("nsh-cleanup-sink-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn wait_gone(path: &std::path::Path) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while path.exists() {
            assert!(Instant::now() < deadline, "the sink did not clean {path:?}");
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    #[test]
    fn a_stop_recorded_while_open_is_cleaned_by_close() {
        let dir = temp("open");
        let staging = files::stage(&dir.join("out"), "d", false, false).unwrap();
        let key = Key {
            node: 1,
            id: "d".into(),
        };
        let sink = DownloadCleanup::new();
        sink.stage(&key, &staging);
        sink.stop(&key);
        assert!(staging.dir().exists(), "a live core may still publish");
        sink.close();
        wait_gone(staging.dir());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stop_after_close_is_cleaned_at_once() {
        let dir = temp("closed");
        let staging = files::stage(&dir.join("out"), "d", false, false).unwrap();
        let key = Key {
            node: 1,
            id: "d".into(),
        };
        let sink = DownloadCleanup::new();
        sink.stage(&key, &staging);
        sink.close();
        assert!(staging.dir().exists(), "no writer stopped yet");
        sink.stop(&key);
        wait_gone(staging.dir());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn done_before_close_leaves_the_staging_to_the_core() {
        let dir = temp("done");
        let staging = files::stage(&dir.join("out"), "d", false, false).unwrap();
        let key = Key {
            node: 1,
            id: "d".into(),
        };
        let sink = DownloadCleanup::new();
        sink.stage(&key, &staging);
        sink.stop(&key);
        sink.done(&key);
        sink.close();
        assert!(
            staging.dir().exists(),
            "the core published/cleaned it itself"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_foreign_stop_reply_cannot_authorize_cleanup() {
        let dir = temp("foreign-reply");
        let staging = files::stage(&dir.join("out"), "d", false, false).unwrap();
        std::fs::write(staging.path(), b"writer still owns this").unwrap();
        let key = Key {
            node: 1,
            id: "d".into(),
        };
        let sink = DownloadCleanup::new();
        sink.stage(&key, &staging);
        sink.track(7, &key);
        let reply = crate::webview::reply(7, Ok(serde_json::Value::Null));
        sink.dispatch(2, EventKind::WebViewReply, &reply);
        assert!(sink.state.lock().unwrap().requests.contains_key(&7));
        sink.close();
        assert_eq!(
            std::fs::read(staging.path()).unwrap(),
            b"writer still owns this"
        );
        sink.dispatch(1, EventKind::WebViewReply, &reply);
        wait_gone(staging.dir());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
