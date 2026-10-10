/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! The reads and the list against a scripted Host. The Host's answers
//! follow the recorded `artifact_files.jsonl` sequence, which a real Host
//! answered for a page, a `get`, a `read_text`, an `unsupported_mime`, a
//! chunk and a delete; it records no `list_continue`, `revision_changed`,
//! `too_large` or image read in several chunks, so the Host here builds
//! those itself in the same shapes (`createPage`, `encodeTextResult` and
//! `readPreparedChunk` in the pinned Host).

use std::cell::Cell;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use futures_lite::future::Boxed;
use gpui_kit::{AppContext as _, Entity, TestAppContext};
use host_protocol::{
    ARTIFACT_PREVIEW_MAX_BYTES, ARTIFACT_READ_CHUNK_MAX_BYTES, ArtifactReadFailureReason,
    HostOperationErrorCode,
};
use serde_json::{Value, json};
use workspace::{HostRequestError, HostSession, HostTransport};

use crate::list::{ArtifactList, ArtifactListEvent, ListLoad, POLL_INTERVAL};
use crate::read::{self, ReadFailure};

pub(crate) type Reply = Result<Value, HostRequestError>;

pub(crate) const SESSION: &str = "s1";
pub(crate) const FIXTURE: &str =
    include_str!("../../host-protocol/fixtures/sequences/artifact_files.jsonl");

/// The `revision` a Host gives a list: any `sha256:` string.
pub(crate) fn revision(n: u64) -> String {
    format!("sha256:{n:064x}")
}

/// A Host holding a Session's Artifacts and their bytes: it pages the
/// list `page_size` at a time, answers `get` with the revision, reads
/// text, binary and chunks with the pinned Host's limits, and deletes what
/// a person may. Scripted replies and held ones come first, per operation
/// kind (`artifact.query:list_start`, `artifact.delete`, …).
#[derive(Default)]
pub(crate) struct ScriptedHost {
    artifacts: Mutex<Vec<Value>>,
    bytes: Mutex<HashMap<String, Vec<u8>>>,
    revision: Mutex<u64>,
    page_size: Mutex<usize>,
    replies: Mutex<HashMap<String, VecDeque<Reply>>>,
    held: Mutex<HashMap<String, VecDeque<async_channel::Receiver<Reply>>>>,
    requests: Mutex<Vec<(String, Value)>>,
}

impl ScriptedHost {
    pub(crate) fn new() -> Arc<Self> {
        let host = Self::default();
        *host.page_size.lock().expect("page") = 128;
        *host.revision.lock().expect("revision") = 1;
        Arc::new(host)
    }

    /// Adds an Artifact with `bytes`, as the newest (the Host lists newest
    /// first), and moves the revision.
    pub(crate) fn add(&self, artifact: Value, bytes: &[u8]) {
        let id = artifact["id"].as_str().expect("id").to_owned();
        self.bytes.lock().expect("bytes").insert(id, bytes.to_vec());
        self.artifacts.lock().expect("artifacts").insert(0, artifact);
        *self.revision.lock().expect("revision") += 1;
    }

    pub(crate) fn remove(&self, id: &str) {
        self.artifacts.lock().expect("artifacts").retain(|artifact| artifact["id"] != id);
        *self.revision.lock().expect("revision") += 1;
    }

    pub(crate) fn set_page_size(&self, size: usize) {
        *self.page_size.lock().expect("page") = size;
    }

    pub(crate) fn reply(&self, key: &str, reply: Reply) {
        self.replies.lock().expect("replies").entry(key.to_owned()).or_default().push_back(reply);
    }

    pub(crate) fn hold(&self, key: &str) -> async_channel::Sender<Reply> {
        let (sender, receiver) = async_channel::bounded(1);
        self.held.lock().expect("held").entry(key.to_owned()).or_default().push_back(receiver);
        sender
    }

    /// The requests of kind `key`, in order.
    pub(crate) fn requests(&self, key: &str) -> Vec<Value> {
        let requests = self.requests.lock().expect("requests");
        requests.iter().filter(|(kind, _)| kind == key).map(|(_, input)| input.clone()).collect()
    }

    fn default_reply(&self, key: &str, input: &Value) -> Reply {
        let revision = revision(*self.revision.lock().expect("revision"));
        let artifacts = self.artifacts.lock().expect("artifacts").clone();
        let page_size = *self.page_size.lock().expect("page");
        let page = |offset: usize| {
            let end = artifacts.len().min(offset + page_size);
            let next = (end < artifacts.len()).then(|| end.to_string());
            json!({"kind": "page", "sessionId": SESSION, "revision": revision,
                   "artifacts": artifacts[offset.min(end)..end], "nextCursor": next})
        };
        let id = input["artifactId"].as_str().unwrap_or_default().to_owned();
        let known = artifacts.iter().any(|artifact| artifact["id"] == id.as_str());
        let bytes = self.bytes.lock().expect("bytes").get(&id).cloned().filter(|_| known);
        let operation_error = |operation: &'static str, code, message: &str| {
            Err(HostRequestError::Operation { operation, code, message: message.into() })
        };
        let unavailable = |reason: &str| json!({"ok": false, "reason": reason});
        match key {
            "artifact.query:list_start" => Ok(page(0)),
            "artifact.query:list_continue" => {
                if input["revision"] != revision.as_str() {
                    return Ok(json!({"kind": "revision_changed",
                                     "expected": input["revision"], "actual": revision}));
                }
                let offset = input["cursor"].as_str().and_then(|c| c.parse().ok()).unwrap_or(0);
                Ok(page(offset))
            }
            "artifact.query:get" => {
                let artifact = artifacts.iter().find(|artifact| artifact["id"] == id.as_str());
                Ok(json!({"kind": "artifact", "sessionId": SESSION, "revision": revision,
                          "artifact": artifact}))
            }
            "artifact.query:read_text" => {
                let preview = match bytes {
                    None => unavailable("not_found"),
                    Some(bytes) if bytes.len() > ARTIFACT_PREVIEW_MAX_BYTES => {
                        unavailable("too_large")
                    }
                    Some(bytes) => json!({"ok": true, "text": String::from_utf8_lossy(&bytes)}),
                };
                Ok(json!({"kind": "text", "sessionId": SESSION, "artifactId": id,
                          "preview": preview}))
            }
            "artifact.query:read_binary" => {
                let preview = match bytes {
                    None => unavailable("not_found"),
                    Some(bytes) if bytes.len() > ARTIFACT_PREVIEW_MAX_BYTES => {
                        unavailable("too_large")
                    }
                    // The Host's sniff: raster and SVG, no AVIF.
                    Some(bytes) => match crate::policy::ImageType::sniff(&bytes) {
                        Some(kind) if kind.is_drawable() => json!({
                            "ok": true,
                            "base64": base64::engine::general_purpose::STANDARD.encode(&bytes),
                            "mimeType": format!("image/{}", kind.extension())
                        }),
                        _ => unavailable("unsupported_mime"),
                    },
                };
                Ok(json!({"kind": "binary", "sessionId": SESSION, "artifactId": id,
                          "preview": preview}))
            }
            "artifact.query:read_chunk" => {
                let Some(bytes) = bytes else {
                    return operation_error(
                        "artifact.query",
                        HostOperationErrorCode::NotFound,
                        "Artifact was not found",
                    );
                };
                let offset =
                    usize::try_from(input["offset"].as_u64().expect("offset")).expect("offset");
                if offset > bytes.len() {
                    return operation_error(
                        "artifact.query",
                        HostOperationErrorCode::InvalidRequest,
                        "Artifact chunk offset is invalid",
                    );
                }
                let end = bytes.len().min(offset + ARTIFACT_READ_CHUNK_MAX_BYTES);
                let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes[offset..end]);
                Ok(json!({
                    "kind": "chunk", "sessionId": SESSION, "artifactId": id,
                    "offset": offset, "totalBytes": bytes.len(), "chunkBase64": encoded,
                    "nextOffset": (end < bytes.len()).then_some(end)
                }))
            }
            "artifact.delete" => {
                let Some(artifact) =
                    artifacts.iter().find(|artifact| artifact["id"] == id.as_str())
                else {
                    return operation_error(
                        "artifact.delete",
                        HostOperationErrorCode::NotFound,
                        "Artifact was not found",
                    );
                };
                if !matches!(artifact["source"].as_str(), Some("tool_result" | "user_upload")) {
                    return operation_error(
                        "artifact.delete",
                        HostOperationErrorCode::OperationConflict,
                        "Runtime-owned evidence cannot be deleted independently of its workflow",
                    );
                }
                self.remove(&id);
                Ok(json!({"kind": "deleted"}))
            }
            other => Err(HostRequestError::Transport(format!("unscripted {other}").into())),
        }
    }
}

impl HostTransport for ScriptedHost {
    fn request(&self, operation: &'static str, input: Value, _: Duration) -> Boxed<Reply> {
        let key = match input["kind"].as_str() {
            Some(kind) if operation == "artifact.query" => format!("{operation}:{kind}"),
            _ => operation.to_owned(),
        };
        self.requests.lock().expect("requests").push((key.clone(), input.clone()));
        let held = self.held.lock().expect("held").get_mut(&key).and_then(VecDeque::pop_front);
        if let Some(held) = held {
            return Box::pin(async move {
                held.recv().await.unwrap_or(Err(HostRequestError::NotConnected))
            });
        }
        let scripted =
            self.replies.lock().expect("replies").get_mut(&key).and_then(VecDeque::pop_front);
        let reply = scripted.unwrap_or_else(|| self.default_reply(&key, &input));
        Box::pin(async move { reply })
    }
}

/// An Artifact of the Session as the Host lists it.
pub(crate) fn artifact(id: &str, name: &str, kind: &str, source: &str, size: usize) -> Value {
    json!({
        "id": id, "sessionId": SESSION, "turnId": "t1", "createdAt": 1_791_590_000_000u64,
        "name": name, "kind": kind, "sizeBytes": size, "source": source
    })
}

/// The window's Host connection over `host`.
pub(crate) fn host_session(
    host: &Arc<ScriptedHost>,
    cx: &mut TestAppContext,
) -> Entity<HostSession> {
    let transport = host.clone();
    cx.new(|_| HostSession::with_transport(PathBuf::from("/tmp/maka-files-tests"), transport))
}

/// The fixture's answers to the operations named `operation`, in order.
fn fixture_results(operation: &str) -> Vec<Value> {
    FIXTURE
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("line"))
        .filter(|line| line["operation"] == operation && line.get("result").is_some())
        .map(|line| line["result"].clone())
        .collect()
}

#[gpui_kit::test]
fn the_recorded_answers_read_as_the_face_reads_them(cx: &mut TestAppContext) {
    let host = ScriptedHost::new();
    let queries = fixture_results("artifact.query");
    let deletes = fixture_results("artifact.delete");
    // In the order the fixture asked: list, get, read_text, read_binary,
    // read_chunk, then the list after the delete.
    for (key, result) in [
        "artifact.query:list_start",
        "artifact.query:get",
        "artifact.query:read_text",
        "artifact.query:read_binary",
        "artifact.query:read_chunk",
        "artifact.query:list_start",
    ]
    .into_iter()
    .zip(queries)
    {
        host.reply(key, Ok(result));
    }
    host.reply("artifact.delete", Ok(deletes[0].clone()));
    let session = host_session(&host, cx);
    let requester = session.read_with(cx, |session, _| session.requester());
    let session_id = "fixture-fa84a3d371b44598bc02543df30d0f97";
    let id = "attachment-20469317fea34779075e724e4293dab3";
    let read = cx.executor().spawn(async move {
        let listing = read::list(&requester, session_id).await.expect("list");
        let probed = read::revision(&requester, session_id, id).await.expect("get");
        let text = read::text(&requester, session_id, id).await.expect("text");
        let binary = read::binary(&requester, session_id, id).await;
        let chunk = read::chunk(&requester, session_id, id, 0).await.expect("chunk");
        read::delete(&requester, session_id, id).await.expect("deleted");
        let after = read::list(&requester, session_id).await.expect("list");
        (listing, probed, text, binary, chunk, after)
    });
    cx.run_until_parked();
    let (listing, probed, text, binary, chunk, after) = futures_lite::future::block_on(read);
    assert_eq!(listing.artifacts.len(), 1);
    // An upload: the face does not show it, and its digest is no summary.
    assert!(!crate::policy::is_user_visible(&listing.artifacts[0]));
    assert_eq!(crate::policy::row_summary(&listing.artifacts[0]), None);
    assert_eq!(probed, listing.revision, "a get answers the list's revision");
    assert_eq!(text, "Notes for the Files panel: the garden gate opens at nine.\n");
    assert_eq!(binary, Err(ReadFailure::Unavailable(ArtifactReadFailureReason::UnsupportedMime)));
    assert_eq!((chunk.bytes.len(), chunk.total, chunk.next), (58, 58, None));
    assert!(after.artifacts.is_empty());
    assert_ne!(after.revision, listing.revision);
}

/// The list over a scripted Host, and how often it notified.
struct Bench {
    host: Arc<ScriptedHost>,
    list: Entity<ArtifactList>,
    notified: Rc<Cell<usize>>,
    changed: Rc<Cell<usize>>,
}

impl Bench {
    fn new(host: Arc<ScriptedHost>, cx: &mut TestAppContext) -> Self {
        let session = host_session(&host, cx);
        let list = cx.new(|cx| ArtifactList::new(session, cx));
        let notified = Rc::new(Cell::new(0));
        let changed = Rc::new(Cell::new(0));
        let (counter, events) = (notified.clone(), changed.clone());
        cx.update(|cx| {
            cx.observe(&list, move |_, _| counter.set(counter.get() + 1)).detach();
            cx.subscribe(&list, move |_, _: &ArtifactListEvent, _| events.set(events.get() + 1))
                .detach();
        });
        Self { host, list, notified, changed }
    }

    fn show(&self, cx: &mut TestAppContext) {
        self.list.update(cx, |list, cx| {
            list.set_session(Some(SESSION.into()), cx);
            list.set_window_active(true, cx);
            list.set_shown(true, cx);
        });
        cx.run_until_parked();
    }

    fn ids(&self, cx: &mut TestAppContext) -> Vec<String> {
        self.list.read_with(cx, |list, _| list.visible().iter().map(|a| a.id.clone()).collect())
    }

    fn reads(&self, cx: &mut TestAppContext) -> usize {
        self.list.read_with(cx, |list, _| list.reads())
    }

    fn tick(&self, cx: &mut TestAppContext) {
        cx.executor().advance_clock(POLL_INTERVAL);
        cx.run_until_parked();
    }
}

/// Three files a person sees, between two they do not.
pub(crate) fn five_files(host: &ScriptedHost) {
    host.add(artifact("a5", "upload.txt", "file", "user_upload", 3), b"abc");
    host.add(artifact("a4", "plan.md", "file", "subagent_writeback", 3), b"abc");
    host.add(artifact("a3", "out.log", "file", "tool_result", 3), b"abc");
    host.add(artifact("a2", "report.html", "html", "tool_result", 3), b"abc");
    host.add(artifact("a1", "brief.md", "file", "deep_research", 3), b"abc");
}

#[gpui_kit::test]
fn the_list_reads_every_page_and_keeps_the_hosts_order(cx: &mut TestAppContext) {
    let host = ScriptedHost::new();
    five_files(&host);
    // The Host orders by time; these times disagree with its order, which
    // the list keeps rather than sorting again.
    host.set_page_size(2);
    let bench = Bench::new(host, cx);
    bench.show(cx);
    assert_eq!(bench.ids(cx), ["a1", "a2", "a4"], "the visible ones, in the Host's order");
    assert_eq!(bench.host.requests("artifact.query:list_start").len(), 1);
    let continues = bench.host.requests("artifact.query:list_continue");
    let cursors: Vec<&str> =
        continues.iter().map(|input| input["cursor"].as_str().expect("cursor")).collect();
    assert_eq!(cursors, ["2", "4"], "each page from the cursor the last one gave");
    assert!(continues.iter().all(|input| input["revision"] == revision(6).as_str()));
    assert_eq!(bench.list.read_with(cx, |list, _| list.load().clone()), ListLoad::Loaded);
}

#[gpui_kit::test]
fn a_list_that_changes_between_pages_is_read_again_from_its_start(cx: &mut TestAppContext) {
    let host = ScriptedHost::new();
    five_files(&host);
    host.set_page_size(2);
    // The second page answers that the list moved on, once.
    host.reply(
        "artifact.query:list_continue",
        Ok(json!({"kind": "revision_changed", "expected": revision(6), "actual": revision(7)})),
    );
    let bench = Bench::new(host, cx);
    bench.show(cx);
    assert_eq!(bench.host.requests("artifact.query:list_start").len(), 2, "started again");
    assert_eq!(bench.ids(cx), ["a1", "a2", "a4"]);
}

#[gpui_kit::test]
fn polling_reads_the_list_only_when_its_revision_moves_and_stops_when_hidden(
    cx: &mut TestAppContext,
) {
    let host = ScriptedHost::new();
    five_files(&host);
    let bench = Bench::new(host, cx);
    bench.show(cx);
    assert_eq!(bench.reads(cx), 1);
    let (notified, changed) = (bench.notified.get(), bench.changed.get());

    // Unchanged: a get of the newest id, no read, nothing drawn.
    bench.tick(cx);
    bench.tick(cx);
    let gets = bench.host.requests("artifact.query:get");
    assert_eq!(gets.len(), 2);
    assert!(gets.iter().all(|input| input["artifactId"] == "a1"), "the newest known id");
    assert_eq!(bench.reads(cx), 1);
    assert_eq!((bench.notified.get(), bench.changed.get()), (notified, changed));

    // A hidden Artifact moves the revision: the list is read, nothing a
    // person sees changed, nothing is drawn.
    bench.host.add(artifact("a6", "projection", "file", "tool_result_projection", 3), b"x");
    bench.tick(cx);
    assert_eq!(bench.reads(cx), 2);
    assert_eq!((bench.notified.get(), bench.changed.get()), (notified, changed));

    // A writeback lands after the turn ended: it shows.
    bench.host.add(artifact("a7", "late.md", "file", "subagent_writeback", 3), b"x");
    bench.tick(cx);
    assert_eq!(bench.ids(cx)[0], "a7");
    assert_eq!(bench.changed.get(), changed + 1);

    // Hidden: no more polls.
    bench.list.update(cx, |list, cx| list.set_shown(false, cx));
    let before = bench.host.requests("artifact.query:get").len();
    bench.tick(cx);
    bench.tick(cx);
    assert_eq!(bench.host.requests("artifact.query:get").len(), before);
    assert!(!bench.list.read_with(cx, |list, _| list.is_polling()));
    // Shown again: read at once and polled; a window in the background
    // pauses the polls.
    bench.list.update(cx, |list, cx| list.set_shown(true, cx));
    cx.run_until_parked();
    assert_eq!(bench.reads(cx), 4);
    bench.list.update(cx, |list, cx| list.set_window_active(false, cx));
    bench.tick(cx);
    assert_eq!(bench.host.requests("artifact.query:get").len(), before);
}

#[gpui_kit::test]
fn an_empty_list_polls_with_any_id_and_a_failed_read_keeps_the_files(cx: &mut TestAppContext) {
    let host = ScriptedHost::new();
    let bench = Bench::new(host, cx);
    bench.show(cx);
    assert!(bench.ids(cx).is_empty());
    bench.tick(cx);
    assert_eq!(bench.host.requests("artifact.query:get")[0]["artifactId"], "none");

    bench.host.add(artifact("a1", "brief.md", "file", "deep_research", 3), b"abc");
    bench.tick(cx);
    assert_eq!(bench.ids(cx), ["a1"]);
    bench.host.reply(
        "artifact.query:list_start",
        Err(HostRequestError::Transport("connection reset".into())),
    );
    bench.list.update(cx, |list, cx| list.refresh(cx));
    cx.run_until_parked();
    assert_eq!(bench.ids(cx), ["a1"], "the files already listed stay");
    assert!(matches!(
        bench.list.read_with(cx, |list, _| list.load().clone()),
        ListLoad::Failed(ReadFailure::Transport(_))
    ));
    bench.list.update(cx, |list, cx| list.retry(cx));
    cx.run_until_parked();
    assert_eq!(bench.list.read_with(cx, |list, _| list.load().clone()), ListLoad::Loaded);
}

#[gpui_kit::test]
fn another_task_drops_the_list_and_an_old_answer(cx: &mut TestAppContext) {
    let host = ScriptedHost::new();
    five_files(&host);
    let held = host.hold("artifact.query:list_start");
    let bench = Bench::new(host, cx);
    bench.show(cx);
    bench.list.update(cx, |list, cx| list.set_session(Some("s2".into()), cx));
    held.try_send(Ok(json!({"kind": "page", "sessionId": SESSION, "revision": revision(9),
                            "artifacts": [artifact("x", "old.md", "file", "deep_research", 1)],
                            "nextCursor": null})))
        .expect("send");
    cx.run_until_parked();
    let session = bench.list.read_with(cx, |list, _| list.session_id().cloned());
    assert_eq!(session.as_deref(), Some("s2"));
    assert!(!bench.ids(cx).contains(&"x".to_owned()), "the first task's answer is dropped");
}

#[gpui_kit::test]
fn a_file_is_read_in_chunks_to_its_end_and_a_changing_size_is_refused(cx: &mut TestAppContext) {
    let host = ScriptedHost::new();
    let big: Vec<u8> =
        (0..ARTIFACT_READ_CHUNK_MAX_BYTES * 2 + 100).map(|n| (n % 251) as u8).collect();
    host.add(artifact("a1", "big.bin", "image", "subagent_writeback", big.len()), &big);
    let session = host_session(&host, cx);
    let requester = session.read_with(cx, |session, _| session.requester());
    let (all, capped) = {
        let requester = requester.clone();
        let read = cx.executor().spawn(async move {
            let all = read::all(&requester, SESSION, "a1", None).await;
            let capped = read::all(&requester, SESSION, "a1", Some(100)).await;
            (all, capped)
        });
        cx.run_until_parked();
        futures_lite::future::block_on(read)
    };
    assert_eq!(all.expect("all"), big);
    assert_eq!(host.requests("artifact.query:read_chunk").len(), 4, "three, then one refused");
    assert_eq!(capped, Err(ReadFailure::TooLarge));

    host.reply(
        "artifact.query:read_chunk",
        Ok(json!({"kind": "chunk", "sessionId": SESSION, "artifactId": "a1", "offset": 0,
                  "totalBytes": 10, "chunkBase64": "AAAA", "nextOffset": 3})),
    );
    host.reply(
        "artifact.query:read_chunk",
        Ok(json!({"kind": "chunk", "sessionId": SESSION, "artifactId": "a1", "offset": 3,
                  "totalBytes": 11, "chunkBase64": "AAAA", "nextOffset": null})),
    );
    let read = cx.executor().spawn(async move { read::all(&requester, SESSION, "a1", None).await });
    cx.run_until_parked();
    assert_eq!(futures_lite::future::block_on(read), Err(ReadFailure::Changed));
}
