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

//! Minimal, deliberately bounded Windows executor for the #4318 language
//! comparison.  The transport is line-delimited JSON-RPC 2.0 and implements
//! the shared `maka.cu/2` host protocol.  On Windows the UIA calls are made through the
//! IUIAutomation COM interfaces (there is no managed/UIA wrapper).
//!
//! Security properties shared with the C# spike:
//! * only an explicitly supplied HWND is observed or captured;
//! * every observation mints opaque, one-use element tokens;
//! * mutation spends the token before dispatch and revalidates HWND/PID and
//!   the element identity; and
//! * keyboard input is only sent after the quoted top-level HWND, PID,
//!   process-start time, window generation, and focused UIA element are
//!   revalidated; there is no PostMessage, coordinate or screen fallback.

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{create_dir_all, write};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::Arc;
use std::sync::Once;
#[cfg(test)]
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};
mod readback;
mod scroll_readback;

const PROTOCOL: &str = "maka.cu/2";
const MAX_ELEMENTS: usize = 512;
const MAX_SNAPSHOTS: usize = 64;
const MAX_TEXT: usize = 1024;
const MAX_RESPONSE_BYTES: usize = 6 * 1024 * 1024;
const MAX_CAPTURE_PIXELS: i64 = 16_000_000;
const MAX_CAPTURE_PNG_BYTES: usize = 4 * 1024 * 1024;
const SHUTDOWN_GRACE_MS: u64 = 1_000;
static HOST_PID: AtomicU64 = AtomicU64::new(0);
#[cfg(test)]
static HELPER_GENERATION: OnceLock<String> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RpcRequest {
    jsonrpc: Option<String>,
    id: Option<Value>,
    method: Option<String>,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Default)]
struct Registry {
    // Monotonic ids are used only for snapshot bookkeeping. The protocol
    // handshake and session set are owned by the same worker registry so a
    // request cannot bypass the shared lifecycle state.
    next: AtomicU64,
    snapshots: HashMap<String, Snapshot>,
    sessions: HashSet<String>,
    image_dir: Option<PathBuf>,
    host_pid: Option<u32>,
    // Presentation identity is scoped to one target process/window. RuntimeId
    // is used only as the matching key; dispatch still quotes the opaque
    // snapshot token and digest.
    stable_ids: HashMap<(u32, isize), HashMap<Vec<i32>, u64>>,
    // Kept only for historical comparison tests; this field is absent from the
    // production binary so compatibility input cannot be reached there.
    #[cfg(test)]
    compat_authorizations: HashMap<String, CompatAuthorization>,
}

#[derive(Debug, Clone)]
struct Snapshot {
    session: String,
    hwnd: isize,
    pid: u32,
    start_time: u64,
    generation: String,
    elements: HashMap<String, ElementRef>,
}

#[derive(Debug, Clone)]
struct ElementRef {
    automation_id: String,
    name: String,
    control_type: i32,
    runtime_id: Vec<i32>,
    digest: String,
}

#[cfg(test)]
#[allow(dead_code)]
#[derive(Debug, Clone)]
struct CompatAuthorization {
    snapshot_id: String,
    element_token: String,
    hwnd: isize,
    pid: u32,
    start_time: u64,
    generation: String,
    helper_generation: String,
    runtime_id: Vec<i32>,
    op: String,
    payload: String,
    expires_at: Instant,
}

#[derive(Debug)]
struct Work {
    key: String,
    id: Option<Value>,
    method: String,
    params: Value,
    cancelled: Arc<AtomicBool>,
    dispatch_started: Arc<AtomicBool>,
}

#[derive(Debug)]
struct WorkerResult {
    key: String,
    id: Option<Value>,
    result: Result<Value, (i32, &'static str)>,
}

#[derive(Debug)]
struct Pending {
    id: Option<Value>,
    cancelled: Arc<AtomicBool>,
    dispatch_started: Arc<AtomicBool>,
}

fn main() {
    // stdin is read independently so the control plane can still settle a
    // cancel/shutdown while a UIA provider is blocked in the worker.
    let (input_tx, input_rx) = mpsc::channel::<Option<String>>();
    thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            if input_tx.send(line.ok()).is_err() {
                return;
            }
        }
        let _ = input_tx.send(None);
    });

    let (work_tx, work_rx) = mpsc::sync_channel::<Work>(32);
    let (result_tx, result_rx) = mpsc::channel::<WorkerResult>();
    thread::spawn(move || worker_loop(work_rx, result_tx));

    let mut out = RpcOutput::new();
    let mut pending = HashMap::<String, Pending>::new();
    let mut next_key = 0u64;
    let mut input_closed = false;
    let mut eof_deadline = None;
    let mut next_parent_check = Instant::now() + Duration::from_secs(2);

    while !input_closed || !pending.is_empty() {
        while let Ok(result) = result_rx.try_recv() {
            pending.remove(&result.key);
            match result.result {
                Ok(value) => write_rpc(&mut out, result.id, Some(value), None),
                Err((code, message)) => write_rpc(&mut out, result.id, None, Some((code, message))),
            }
        }

        // The stdio pipe is not a sufficient parent-death signal on Windows:
        // a host can crash while another inherited handle keeps the pipe open.
        // Poll the PID declared in host.hello and terminate the native child
        // without leaving UIA/WGC state behind.
        if Instant::now() >= next_parent_check {
            next_parent_check = Instant::now() + Duration::from_secs(2);
            let host_pid = HOST_PID.load(Ordering::Acquire);
            if host_pid != 0 && !platform::process_alive(host_pid as u32) {
                break;
            }
        }

        match input_rx.recv_timeout(Duration::from_millis(10)) {
            Ok(Some(line)) => {
                if line.trim().is_empty() {
                    continue;
                }
                let raw = match serde_json::from_str::<Value>(&line) {
                    Ok(raw) => raw,
                    Err(_) => {
                        write_rpc(&mut out, None, None, Some((-32700, "parse_error")));
                        continue;
                    }
                };
                let request = match serde_json::from_value::<RpcRequest>(raw.clone()) {
                    Ok(request) => request,
                    Err(_) => {
                        write_rpc(
                            &mut out,
                            raw.get("id").cloned(),
                            None,
                            Some((-32600, "invalid_request")),
                        );
                        continue;
                    }
                };
                if request.jsonrpc.as_deref() != Some("2.0") || request.method.is_none() {
                    write_rpc(
                        &mut out,
                        request.id,
                        None,
                        Some((-32600, "invalid_request")),
                    );
                    continue;
                }
                let method = request.method.clone().unwrap_or_default();
                if method == "$/cancel" {
                    handle_cancel(request.id, request.params, &mut pending, &mut out);
                    continue;
                }
                if method == "shutdown" {
                    write_rpc(
                        &mut out,
                        request.id,
                        Some(
                            json!({"ok": true, "graceMs": SHUTDOWN_GRACE_MS, "worker": "detached_after_grace"}),
                        ),
                        None,
                    );
                    let _ = out.flush();
                    break;
                }

                next_key = next_key.wrapping_add(1);
                let key = format!("r{next_key}");
                let cancelled = Arc::new(AtomicBool::new(false));
                let dispatch_started = Arc::new(AtomicBool::new(false));
                pending.insert(
                    key.clone(),
                    Pending {
                        id: request.id.clone(),
                        cancelled: cancelled.clone(),
                        dispatch_started: dispatch_started.clone(),
                    },
                );
                let work = Work {
                    key: key.clone(),
                    id: request.id,
                    method,
                    params: request.params,
                    cancelled,
                    dispatch_started,
                };
                match work_tx.try_send(work) {
                    Ok(()) => {}
                    Err(TrySendError::Full(_)) => {
                        pending.remove(&key);
                        write_rpc(&mut out, None, None, Some((-32003, "worker_queue_full")));
                    }
                    Err(TrySendError::Disconnected(_)) => {
                        pending.remove(&key);
                        write_rpc(&mut out, None, None, Some((-32004, "worker_unavailable")));
                    }
                }
            }
            Ok(None) => {
                input_closed = true;
                eof_deadline = Some(Instant::now() + Duration::from_millis(2_000));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                input_closed = true;
                eof_deadline.get_or_insert_with(|| Instant::now() + Duration::from_millis(2_000));
            }
        }
        if input_closed && eof_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            break;
        }
    }
}

/// Keep stdout off the control thread. A full bounded queue is a typed
/// backpressure failure (exit 2), rather than an unbounded/orphaning write
/// block when the supervising host stops reading.
struct RpcOutput {
    sender: SyncSender<Vec<u8>>,
}

impl RpcOutput {
    fn new() -> Self {
        let (sender, receiver) = mpsc::sync_channel::<Vec<u8>>(64);
        thread::spawn(move || {
            let stdout = io::stdout();
            let mut out = io::BufWriter::new(stdout.lock());
            for chunk in receiver {
                if out.write_all(&chunk).is_err() || out.flush().is_err() {
                    std::process::exit(2);
                }
            }
        });
        Self { sender }
    }
}

impl Write for RpcOutput {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.sender
            .try_send(buf.to_vec())
            .map_err(|error| io::Error::new(io::ErrorKind::BrokenPipe, error.to_string()))?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn handle_cancel(
    response_id: Option<Value>,
    params: Value,
    pending: &mut HashMap<String, Pending>,
    out: &mut impl Write,
) {
    let Some(parameters) = params.as_object() else {
        if let Some(id) = response_id {
            write_rpc(
                out,
                Some(id),
                Some(
                    json!({"cancelled":false,"reason":"invalid_cancel_params","settlement":"original_request_must_settle","graceMs":2000}),
                ),
                None,
            );
        }
        return;
    };
    let requested_id = parameters.get("id");
    let target = pending
        .iter()
        .find(|(_, item)| requested_id.is_none() || item.id.as_ref() == requested_id)
        .map(|(key, _)| key.clone());
    let Some(key) = target else {
        if let Some(id) = response_id {
            write_rpc(
                out,
                Some(id),
                Some(json!({"cancelled":false,"settlement":"no_pending_request","graceMs":2000})),
                None,
            );
        }
        return;
    };
    let item = pending.get(&key).expect("pending key selected");
    item.cancelled.store(true, Ordering::Release);
    let started = item.dispatch_started.load(Ordering::Acquire);
    if let Some(id) = response_id {
        write_rpc(
            out,
            Some(id),
            Some(json!({
                "cancelled": true,
                "pendingRequestId": item.id,
                "dispatchStarted": started,
                "settlement": "original_request_must_settle",
                "graceMs": 2000
            })),
            None,
        );
    }
}

fn worker_loop(work_rx: Receiver<Work>, result_tx: mpsc::Sender<WorkerResult>) {
    #[cfg(windows)]
    platform::initialize_worker();
    let mut registry = Registry::default();
    for work in work_rx {
        let result = if work.cancelled.load(Ordering::Acquire) {
            if work.method == "act" {
                cancel_queued_action(work.params, &mut registry)
            } else {
                Err((-32001, "cancelled"))
            }
        } else {
            work.dispatch_started.store(true, Ordering::Release);
            dispatch(&work.method, work.params, &mut registry, &work.cancelled)
        };
        let _ = result_tx.send(WorkerResult {
            key: work.key,
            id: work.id,
            result,
        });
    }
}

fn cancel_queued_action(
    params: Value,
    registry: &mut Registry,
) -> Result<Value, (i32, &'static str)> {
    let snapshot_id = params
        .get("snapshotId")
        .and_then(Value::as_str)
        .ok_or((-32602, "missing_snapshot"))?;
    let _ = registry
        .snapshots
        .remove(snapshot_id)
        .ok_or((-32001, "snapshot_spent_or_unknown"))?;
    Ok(
        json!({"outcome":{"tier":"cancelled-before-dispatch","path":"none","status":"refused","reason":"cancelled_before_dispatch","effect":"none","snapshotSpent":true,"verification":"no_mutation"}}),
    )
}

fn write_rpc(
    out: &mut impl Write,
    id: Option<Value>,
    result: Option<Value>,
    error: Option<(i32, &str)>,
) {
    let response = if let Some((code, message)) = error {
        json!({"jsonrpc":"2.0", "id":id, "error":{"code":code,"message":message}})
    } else {
        json!({"jsonrpc":"2.0", "id":id, "result":result.unwrap_or_else(|| json!({}))})
    };
    let mut line = serde_json::to_vec(&response).unwrap_or_else(|_| b"{}".to_vec());
    if line.len() > MAX_RESPONSE_BYTES {
        line = serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"error":{"code":-32002,"message":"response_too_large"}})).unwrap();
    }
    if out.write_all(&line).is_err() || out.write_all(b"\n").is_err() {
        std::process::exit(2);
    }
    let _ = out.flush();
}

fn dispatch(
    method: &str,
    params: Value,
    registry: &mut Registry,
    cancelled: &AtomicBool,
) -> Result<Value, (i32, &'static str)> {
    if method == "host.hello" {
        return host_hello(params, registry);
    }
    if registry.image_dir.is_none() {
        return Err((-32001, "handshake_required"));
    }
    match method {
        "session.begin" => session_begin(params, registry),
        "session.end" => session_end(params, registry),
        "window.list" => generic_window_list(),
        "apps.list" => generic_apps_list(),
        "observe" => generic_observe(params, registry),
        "dispatch.element" => generic_dispatch_element(params, registry, cancelled),
        "dispatch.key" => generic_dispatch_key(params, registry, cancelled),
        // The protocol keeps this endpoint for old callers, but coordinate
        // mutation is never a capability and must not resolve or spend a
        // snapshot before refusing.
        "dispatch.point" => Ok(generic_point_refusal(&params)),
        "screen.capture" => generic_screen_capture(params, registry),
        "permissions.check" => Ok(json!({
            "ok": true,
            "accessibility": cfg!(windows),
            "screenRecording": cfg!(windows),
            "prompted": false
        })),
        "apps.launch" => generic_launch(params),
        // Transport regression seam; never used by the model-facing runtime.
        "debug_sleep" => {
            let millis = params
                .get("ms")
                .and_then(Value::as_u64)
                .unwrap_or(100)
                .min(5_000);
            std::thread::sleep(Duration::from_millis(millis));
            Ok(json!({"ok":true,"sleptMs":millis}))
        }
        _ => Err((-32601, "method_not_found")),
    }
}

fn host_hello(params: Value, registry: &mut Registry) -> Result<Value, (i32, &'static str)> {
    if registry.image_dir.is_some() {
        return Err((-32602, "host_hello_must_be_first"));
    }
    let protocol = params
        .get("protocol")
        .and_then(Value::as_str)
        .ok_or((-32602, "missing_protocol"))?;
    if protocol != PROTOCOL {
        return Err((-32000, "protocol_version_mismatch"));
    }
    if params.get("allowGlobalPointer").and_then(Value::as_bool) != Some(false) {
        return Err((-32602, "global_pointer_must_be_false"));
    }
    let host_pid = params
        .get("hostPid")
        .and_then(Value::as_u64)
        .filter(|pid| *pid > 0 && *pid <= u32::MAX as u64)
        .ok_or((-32602, "invalid_host_pid"))? as u32;
    let image_dir = params
        .get("imageDir")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .ok_or((-32602, "invalid_image_dir"))?;
    if !image_dir.is_absolute() {
        return Err((-32602, "image_dir_must_be_absolute"));
    }
    create_dir_all(&image_dir).map_err(|_| (-32603, "image_dir_unavailable"))?;
    let probe = image_dir.join(".maka-cu-write-probe");
    write(&probe, b"maka.cu/2").map_err(|_| (-32603, "image_dir_unwritable"))?;
    let _ = std::fs::remove_file(probe);
    registry.image_dir = Some(image_dir);
    registry.host_pid = Some(host_pid);
    HOST_PID.store(host_pid as u64, Ordering::Release);
    Ok(json!({
        "ok": true,
        "protocol": PROTOCOL,
        "executor": {
            "name": "maka-cu-windows-rust",
            "version": env!("CARGO_PKG_VERSION"),
            "commit": "local"
        },
        "pid": std::process::id(),
        "capabilities": {
            "captureStream": false,
            "elementActions": ["click", "set_value", "select_text", "secondary_action", "scroll"],
            "pointActions": [],
            "keyActions": ["key"],
            "imageFormats": ["png"]
        },
        "limits": {
            "snapshotsPerSession": MAX_SNAPSHOTS,
            "snapshotTtlMs": 120000,
            "maxElements": MAX_ELEMENTS,
            "maxDepth": 64,
            "maxTextChars": 500,
            "maxResponseBytes": MAX_RESPONSE_BYTES,
            "settleCeilingMs": 2500,
            "treeWalkCeilingMs": 6000,
            "shutdownGraceMs": SHUTDOWN_GRACE_MS,
            "imageDirBudgetBytes": 268435456
        }
    }))
}

fn session_id(params: &Value) -> Result<String, (i32, &'static str)> {
    params
        .get("session")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(ToOwned::to_owned)
        .ok_or((-32602, "missing_session"))
}

fn require_session(params: &Value, registry: &Registry) -> Result<String, (i32, &'static str)> {
    let session = session_id(params)?;
    if !registry.sessions.contains(&session) {
        return Err((-32002, "session_unknown"));
    }
    Ok(session)
}

fn session_begin(params: Value, registry: &mut Registry) -> Result<Value, (i32, &'static str)> {
    let session = session_id(&params)?;
    if !registry.sessions.insert(session.clone()) {
        return Err((-32602, "session_already_started"));
    }
    Ok(json!({"ok":true,"session":session,"captureScope":"window"}))
}

fn session_end(params: Value, registry: &mut Registry) -> Result<Value, (i32, &'static str)> {
    let session = session_id(&params)?;
    if !registry.sessions.remove(&session) {
        return Ok(json!({
            "ok":true,
            "session":session,
            "released":{"snapshots":0,"images":0,"streams":0}
        }));
    }
    let released = registry
        .snapshots
        .extract_if(|_, snapshot| snapshot.session == session)
        .count();
    Ok(
        json!({"ok":true,"session":session,"released":{"snapshots":released,"images":0,"streams":0}}),
    )
}

fn generic_domain_error(code: &str, message: &str) -> Value {
    json!({"ok":false,"error":{"code":code,"message":message,"detail":{}}})
}

fn generic_dispatch_refusal(params: &Value, code: &str, message: &str, tier: &str) -> Value {
    json!({
        "ok": false,
        "toolCallId": params.get("toolCallId").cloned().unwrap_or(Value::Null),
        "outcome":"refused",
        "tier":tier,
        "path":"none",
        "effect":"unverifiable",
        "verification":{"method":"none","observedChange":false},
        "error":{"code":code,"message":message,"detail":{}}
    })
}

fn generic_point_refusal(params: &Value) -> Value {
    generic_dispatch_refusal(
        params,
        "unsupported_action",
        "The requested point action is not supported by this executor.",
        "coordinate-background",
    )
}

fn digest_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{:x}", hasher.finalize())
}

fn digest_value(value: &Value) -> String {
    digest_bytes(&serde_json::to_vec(value).unwrap_or_default())
}

fn normalized_action_names(raw: &[&'static str]) -> Vec<String> {
    let mut names = raw
        .iter()
        .filter_map(|action| match *action {
            "click_element" => Some("press"),
            "select" => Some("pick"),
            "toggle" => Some("confirm"),
            "scroll" => Some("scroll_down"),
            _ => None,
        })
        .map(str::to_owned)
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    names
}

fn semantic_role(control_type: &str) -> &'static str {
    match control_type.strip_prefix("UIA.ControlType.") {
        Some("50000") => "button",
        Some("50001") => "calendar",
        Some("50002") => "checkbox",
        Some("50003") => "combobox",
        Some("50004") => "edit",
        Some("50005") => "link",
        Some("50006") => "image",
        Some("50007") => "listitem",
        Some("50008") => "list",
        Some("50009") => "menu",
        Some("50010") => "menubar",
        Some("50011") => "menuitem",
        Some("50012") => "progressbar",
        Some("50013") => "radiobutton",
        Some("50014") => "scrollbar",
        Some("50015") => "slider",
        Some("50016") => "spinner",
        Some("50017") => "statusbar",
        Some("50018") => "tab",
        Some("50019") => "tabitem",
        Some("50020") => "text",
        Some("50021") => "toolbar",
        Some("50022") => "tooltip",
        Some("50023") => "tree",
        Some("50024") => "treeitem",
        Some("50025") => "custom",
        Some("50026") => "group",
        Some("50027") => "thumb",
        Some("50028") => "datagrid",
        Some("50029") => "dataitem",
        Some("50030") => "document",
        Some("50031") => "splitbutton",
        Some("50032") => "window",
        Some("50033") => "pane",
        Some("50034") => "header",
        Some("50035") => "headeritem",
        Some("50036") => "table",
        Some("50037") => "titlebar",
        Some("50038") => "separator",
        Some("50039") => "semanticzoom",
        Some("50040") => "appbar",
        _ => "unknown",
    }
}

fn element_digest_for_observed(element: &ObservedElement, window_bounds: [i32; 4]) -> String {
    let [x, y, width, height] = element.bounds;
    let frame = json!([x - window_bounds[0], y - window_bounds[1], width, height]);
    let value_digest = element
        .value
        .as_deref()
        .map(|value| digest_bytes(value.as_bytes()));
    // This is the single canonical input assembly used by both observe and
    // dispatch revalidation. Ancestors and sibling position come from the
    // same UIA TreeWalker path in both observations; they are not inferred
    // from the flat FindAll index.
    digest_value(&json!([
        format!("UIA.ControlType.{}", element.control_type),
        Value::Null,
        if element.automation_id.is_empty() {
            Value::Null
        } else {
            json!(element.automation_id)
        },
        if element.name.is_empty() {
            Value::Null
        } else {
            json!(element.name)
        },
        Value::Null,
        value_digest,
        frame,
        normalized_action_names(&element.actions),
        &element.ancestor_roles,
        element.sibling_index,
    ]))
}

fn window_digest(elements: &[Value], bounds: &Value, title: &Value) -> String {
    let mut digests = elements
        .iter()
        .filter_map(|element| element.get("digest").and_then(Value::as_str))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    digests.sort();
    digest_value(&json!([digests, bounds, title]))
}

fn rect_value(value: Option<&Value>, fallback: Value) -> Value {
    let Some(array) = value.and_then(Value::as_array) else {
        return fallback;
    };
    if array.len() < 4 {
        return fallback;
    }
    json!({
        "x": array[0].as_f64().unwrap_or(0.0),
        "y": array[1].as_f64().unwrap_or(0.0),
        "width": array[2].as_f64().unwrap_or(0.0),
        "height": array[3].as_f64().unwrap_or(0.0)
    })
}

fn generic_windows() -> Result<Vec<Value>, (i32, &'static str)> {
    let raw = platform::list_windows()?;
    let Some(windows) = raw.get("windows").and_then(Value::as_array) else {
        return Err((-32603, "window_inventory_invalid"));
    };
    let display_id = platform::displays()
        .ok()
        .and_then(|values| {
            values
                .first()
                .and_then(|value| value.get("displayId"))
                .cloned()
        })
        .unwrap_or_else(|| json!("windows-primary"));
    Ok(windows
        .iter()
        .enumerate()
        .filter_map(|(index, window)| {
            let hwnd = window.get("hwnd").and_then(Value::as_i64)?;
            let pid = window.get("pid").and_then(Value::as_u64)?;
            if hwnd <= 0 || pid == 0 || pid > u32::MAX as u64 {
                return None;
            }
            let title = window.get("title").cloned().unwrap_or(Value::Null);
            let bounds = rect_value(
                window.get("bounds"),
                json!({"x":0.0,"y":0.0,"width":1.0,"height":1.0}),
            );
            let app_id = window
                .get("appId")
                .cloned()
                .unwrap_or_else(|| json!(format!("pid:{pid}")));
            Some(json!({
                "pid":pid,
                "windowId":hwnd,
                "appId":app_id,
                "appName":title,
                "title":title,
                "bounds":bounds,
                "layer":0,
                "zIndex":(windows.len() - index) as i64,
                "onScreen":window.get("isOffscreen").and_then(Value::as_bool) != Some(true),
                "displayId":display_id
            }))
        })
        .collect())
}

fn generic_window_list() -> Result<Value, (i32, &'static str)> {
    Ok(json!({"ok":true,"windows":generic_windows()?}))
}

fn generic_launch(params: Value) -> Result<Value, (i32, &'static str)> {
    let app = params
        .get("app")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or((-32602, "missing_app"))?;
    let path = Path::new(app);
    if !path.is_absolute() || !path.is_file() {
        return Ok(generic_domain_error(
            "app_not_found",
            "Windows launch requires an existing absolute executable path.",
        ));
    }
    if path.extension().and_then(|extension| extension.to_str()) != Some("exe") {
        return Ok(generic_domain_error(
            "unsupported_action",
            "Only executable files are launchable by this executor.",
        ));
    }
    let before_foreground = platform::foreground_pid();
    let child = match Command::new(path).spawn() {
        Ok(child) => child,
        Err(_) => {
            return Ok(generic_domain_error(
                "dispatch_refused",
                "The operating system refused to launch the executable.",
            ));
        }
    };
    let pid = child.id();
    // Dropping the child handle deliberately leaves ownership with the
    // launched application. The executor observes it but does not terminate
    // user-owned processes during session teardown.
    drop(child);
    let app_id = format!("win32:{}", app.to_ascii_lowercase());
    let name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(app)
        .to_owned();
    let wait_budget = params.get("waitForWindowMs").and_then(Value::as_u64);
    let started = Instant::now();
    let (windows, reason) = if let Some(budget) = wait_budget {
        let budget = budget.min(120_000);
        loop {
            let windows = launched_windows(pid)?;
            if !windows.is_empty() || started.elapsed() >= Duration::from_millis(budget) {
                let reason = if windows.is_empty() {
                    "timeout"
                } else {
                    "window_appeared"
                };
                break (windows, reason);
            }
            thread::sleep(Duration::from_millis(25));
        }
    } else {
        let windows = launched_windows(pid)?;
        (windows, "not_requested")
    };
    let foreground_taken = platform::foreground_pid()
        .is_some_and(|foreground| Some(foreground) != before_foreground && foreground == pid);
    Ok(json!({
        "ok":true,
        "pid":pid,
        "appId":app_id,
        "name":name,
        "foregroundTaken":foreground_taken,
        "windows":windows,
        "waited":{"ms":started.elapsed().as_millis(),"reason":reason}
    }))
}

fn launched_windows(pid: u32) -> Result<Vec<Value>, (i32, &'static str)> {
    Ok(generic_windows()?
        .into_iter()
        .filter(|window| window.get("pid").and_then(Value::as_u64) == Some(pid as u64))
        .filter_map(|window| {
            Some(json!({
                "windowId":window.get("windowId")?.clone(),
                "title":window.get("title").cloned().unwrap_or(Value::Null)
            }))
        })
        .collect())
}

fn generic_apps_list() -> Result<Value, (i32, &'static str)> {
    let mut apps = HashMap::<String, (u32, String, usize)>::new();
    for window in generic_windows()? {
        let Some(pid) = window.get("pid").and_then(Value::as_u64) else {
            continue;
        };
        let title = window
            .get("appName")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let app_id = window
            .get("appId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let entry = apps.entry(app_id).or_insert((pid as u32, title, 0));
        entry.2 += 1;
    }
    let values = apps
        .into_iter()
        .map(|(app_id, (pid, name, count))| {
            json!({"appId":app_id,"pid":pid,"name":name,"windowCount":count})
        })
        .collect::<Vec<_>>();
    Ok(json!({"ok":true,"apps":values}))
}

fn target_window(params: &Value) -> Result<(isize, u32), (i32, &'static str)> {
    let target = params
        .get("target")
        .and_then(Value::as_object)
        .ok_or((-32602, "missing_target"))?;
    match target.get("kind").and_then(Value::as_str) {
        Some("window") => {
            let pid = target
                .get("pid")
                .and_then(Value::as_u64)
                .filter(|pid| *pid > 0 && *pid <= u32::MAX as u64)
                .ok_or((-32602, "invalid_target_pid"))? as u32;
            let hwnd = target
                .get("windowId")
                .and_then(Value::as_i64)
                .filter(|hwnd| *hwnd > 0)
                .ok_or((-32602, "invalid_target_window"))?;
            Ok((hwnd as isize, pid))
        }
        Some("app") => {
            let app = target
                .get("app")
                .and_then(Value::as_str)
                .ok_or((-32602, "invalid_target_app"))?;
            let windows = generic_windows()?;
            let window = windows
                .iter()
                .filter(|window| window.get("appId").and_then(Value::as_str) == Some(app))
                .find(|window| window.get("onScreen").and_then(Value::as_bool) != Some(false))
                .or_else(|| {
                    windows
                        .iter()
                        .find(|window| window.get("appId").and_then(Value::as_str) == Some(app))
                });
            let window = window.ok_or((-32001, "app_not_found"))?;
            let pid = window
                .get("pid")
                .and_then(Value::as_u64)
                .filter(|pid| *pid > 0 && *pid <= u32::MAX as u64)
                .ok_or((-32001, "app_not_found"))? as u32;
            let hwnd = window
                .get("windowId")
                .and_then(Value::as_i64)
                .ok_or((-32001, "app_not_found"))?;
            Ok((hwnd as isize, pid))
        }
        _ => Err((-32602, "invalid_target_kind")),
    }
}

fn store_capture(
    registry: &Registry,
    image_id: &str,
    raw: Value,
) -> Result<Value, (i32, &'static str)> {
    let frame = raw
        .get("frame")
        .and_then(Value::as_object)
        .ok_or((-32001, "capture_failed"))?;
    let encoded = frame
        .get("base64")
        .and_then(Value::as_str)
        .ok_or((-32001, "capture_failed"))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| (-32001, "capture_failed"))?;
    let directory = registry
        .image_dir
        .as_ref()
        .ok_or((-32001, "handshake_required"))?;
    let safe_id = image_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .collect::<String>();
    let path = directory.join(format!("{safe_id}.png"));
    write(&path, &bytes).map_err(|_| (-32001, "image_write_failed"))?;
    let width = frame.get("width").and_then(Value::as_i64).unwrap_or(0);
    let height = frame.get("height").and_then(Value::as_i64).unwrap_or(0);
    if width <= 0 || height <= 0 {
        return Err((-32001, "capture_failed"));
    }
    Ok(json!({
        "path":path,
        "format":"png",
        "widthPx":width,
        "heightPx":height,
        "byteLength":bytes.len(),
        "sha256":digest_bytes(&bytes),
        "scale":1.0
    }))
}

fn generic_image_for_window(
    registry: &Registry,
    hwnd: isize,
    generation: &str,
    image_id: &str,
) -> Result<Option<Value>, (i32, &'static str)> {
    let raw = platform::capture(json!({
        "hwnd":hwnd,
        "windowGeneration":generation
    }))?;
    if raw.get("status").and_then(Value::as_str) != Some("available") {
        return Ok(None);
    }
    Ok(Some(store_capture(registry, image_id, raw)?))
}

fn generic_observe(params: Value, registry: &mut Registry) -> Result<Value, (i32, &'static str)> {
    let session = require_session(&params, registry)?;
    let (hwnd, requested_pid) = target_window(&params)?;
    let Some(meta) = generic_windows()?.into_iter().find(|window| {
        window.get("windowId").and_then(Value::as_i64) == Some(hwnd as i64)
            && window.get("pid").and_then(Value::as_u64) == Some(requested_pid as u64)
    }) else {
        return Ok(generic_domain_error(
            "window_gone",
            "The requested window is no longer available.",
        ));
    };
    let raw = observe(json!({"hwnd":hwnd}), registry);
    let raw = match raw {
        Ok(raw) => raw,
        Err((-32001, "stale_target_revalidate_failed")) => {
            return Ok(generic_domain_error(
                "process_replaced",
                "The requested window identity changed.",
            ));
        }
        Err((-32001, "target_window_gone")) => {
            return Ok(generic_domain_error(
                "window_gone",
                "The requested window is no longer available.",
            ));
        }
        Err(_) => {
            return Ok(generic_domain_error(
                "capture_failed",
                "The window could not be observed.",
            ))
        }
    };
    let snapshot_id = raw
        .get("snapshotId")
        .and_then(Value::as_str)
        .ok_or((-32603, "snapshot_invalid"))?;
    let generation = raw
        .get("windowGeneration")
        .and_then(Value::as_str)
        .ok_or((-32603, "snapshot_generation_missing"))?;
    let nodes = raw
        .get("tree")
        .and_then(|tree| tree.get("nodes"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let stable_ids = {
        let key = (requested_pid, hwnd);
        let mut assigned = Vec::with_capacity(nodes.len());
        for node in &nodes {
            let runtime = node
                .get("runtimeId")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_i64)
                        .map(|value| value as i32)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if runtime.is_empty() {
                assigned.push(None);
                continue;
            }
            let existing = registry
                .stable_ids
                .get(&key)
                .and_then(|values| values.get(&runtime).copied());
            let stable = existing.unwrap_or_else(|| {
                let value = registry.next.fetch_add(1, Ordering::Relaxed);
                registry
                    .stable_ids
                    .entry(key)
                    .or_default()
                    .insert(runtime, value);
                value
            });
            assigned.push(Some(stable));
        }
        assigned
    };
    let bounds = meta
        .get("bounds")
        .cloned()
        .unwrap_or_else(|| json!({"x":0.0,"y":0.0,"width":1.0,"height":1.0}));
    let origin_x = bounds.get("x").and_then(Value::as_f64).unwrap_or(0.0);
    let origin_y = bounds.get("y").and_then(Value::as_f64).unwrap_or(0.0);
    let elements = nodes
        .iter()
        .enumerate()
        .filter_map(|(index, node)| {
            let token = node.get("token")?.as_str()?;
            let title = node.get("name").cloned().unwrap_or(Value::Null);
            let role = node
                .get("controlType")
                .and_then(Value::as_str)
                .map(semantic_role)
                .unwrap_or("unknown");
            let mut actions = Vec::<Value>::new();
            if node
                .get("actions")
                .and_then(Value::as_array)
                .is_some_and(|values| {
                    values
                        .iter()
                        .any(|value| value.as_str() == Some("click_element"))
                })
            {
                actions.push(json!("press"));
            }
            if node
                .get("actions")
                .and_then(Value::as_array)
                .is_some_and(|values| values.iter().any(|value| value.as_str() == Some("select")))
            {
                actions.push(json!("pick"));
            }
            if node
                .get("actions")
                .and_then(Value::as_array)
                .is_some_and(|values| values.iter().any(|value| value.as_str() == Some("toggle")))
            {
                actions.push(json!("confirm"));
            }
            if node
                .get("actions")
                .and_then(Value::as_array)
                .is_some_and(|values| values.iter().any(|value| value.as_str() == Some("scroll")))
            {
                actions.push(json!("scroll_down"));
            }
            let frame = node
                .get("bounds")
                .and_then(Value::as_array)
                .and_then(|values| {
                    (values.len() >= 4).then(|| {
                        json!({
                            "x":values[0].as_f64().unwrap_or(0.0) - origin_x,
                            "y":values[1].as_f64().unwrap_or(0.0) - origin_y,
                            "width":values[2].as_f64().unwrap_or(0.0),
                            "height":values[3].as_f64().unwrap_or(0.0)
                        })
                    })
                });
            let parent_token = node
                .get("parentRuntimeId")
                .and_then(Value::as_array)
                .and_then(|parent| {
                    nodes.iter().find(|candidate| {
                        candidate
                            .get("runtimeId")
                            .and_then(Value::as_array)
                            == Some(parent)
                    })
                })
                .and_then(|candidate| candidate.get("token"))
                .cloned()
                .unwrap_or(Value::Null);
            Some(json!({
                "token":token,
                "stableId":stable_ids.get(index).and_then(|value| *value).unwrap_or(index as u64),
                "parentToken":parent_token,
                "depth":node.get("depth").and_then(Value::as_u64).unwrap_or(if index == 0 { 0 } else { 1 }),
                "role":role,
                "title":title,
                "axIdentifier":if node.get("automationId").and_then(Value::as_str).is_some_and(|value| !value.is_empty()) { node.get("automationId").cloned().unwrap_or(Value::Null) } else { Value::Null },
                "label":null,
                "value":node.get("value").cloned().unwrap_or(Value::Null),
                "placeholder":null,
                "enabled":node.get("isEnabled").and_then(Value::as_bool).unwrap_or(false),
                "focused":node.get("focused").and_then(Value::as_bool).unwrap_or(false),
                "selected":null,
                "frame":frame,
                "actions":actions,
                "digest":node.get("digest").cloned().unwrap_or(Value::Null),
                "truncated":[]
            }))
        })
        .collect::<Vec<_>>();
    let focused_element_token = nodes.iter().find_map(|node| {
        (node.get("focused").and_then(Value::as_bool) == Some(true))
            .then(|| node.get("token").and_then(Value::as_str))
            .flatten()
    });
    let window_digest = window_digest(
        &elements,
        &bounds,
        &meta.get("title").cloned().unwrap_or(Value::Null),
    );
    let include_image = params
        .get("includeImage")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let image = if include_image {
        generic_image_for_window(registry, hwnd, generation, snapshot_id)?
    } else {
        None
    };
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let mut target = meta.clone();
    if let Some(target) = target.as_object_mut() {
        let process_start_time = raw
            .get("target")
            .and_then(|value| value.get("processStartTimeUtc"))
            .cloned()
            .unwrap_or(Value::Null);
        target.insert("processStartTimeUtc".to_owned(), process_start_time);
        target.insert("windowGeneration".to_owned(), json!(generation));
    }
    let snapshot = json!({
        "snapshotId":snapshot_id,
        "capturedAt":timestamp,
        "target":target,
        "windowDigest":window_digest,
        "focusedElementToken":focused_element_token,
        "selectedText":null,
        "image":image,
        "displays":platform::displays().unwrap_or_default(),
        "obscuringRects":[],
        "elements":elements,
        "truncated":{"elements":raw.get("tree").and_then(|tree| tree.get("truncated")).and_then(Value::as_bool).unwrap_or(false),"depth":false}
    });
    if let Some(stored) = registry.snapshots.get_mut(snapshot_id) {
        stored.session = session;
    }
    Ok(json!({"ok":true,"snapshot":snapshot}))
}

fn generic_dispatch_element(
    params: Value,
    registry: &mut Registry,
    cancelled: &AtomicBool,
) -> Result<Value, (i32, &'static str)> {
    let session = require_session(&params, registry)?;
    let snapshot_id = params
        .get("snapshotId")
        .and_then(Value::as_str)
        .ok_or((-32602, "missing_snapshot_id"))?;
    let token = params
        .get("elementToken")
        .and_then(Value::as_str)
        .ok_or((-32602, "missing_element_token"))?;
    let expected = params
        .get("expectElementDigest")
        .and_then(Value::as_str)
        .ok_or((-32602, "missing_element_digest"))?;
    let Some(quoted) = registry.snapshots.get(snapshot_id).cloned() else {
        return Ok(generic_dispatch_refusal(
            &params,
            "snapshot_unknown",
            "The snapshot is no longer available.",
            "ax",
        ));
    };
    if quoted.session != session {
        return Ok(generic_dispatch_refusal(
            &params,
            "snapshot_unknown",
            "The snapshot does not belong to this session.",
            "ax",
        ));
    }
    let Some(element) = quoted.elements.get(token) else {
        return Ok(generic_dispatch_refusal(
            &params,
            "element_unknown",
            "The element is not in the snapshot.",
            "ax",
        ));
    };
    if expected != element.digest {
        return Ok(generic_dispatch_refusal(
            &params,
            "element_digest_mismatch",
            "The element digest does not match the quoted snapshot.",
            "ax",
        ));
    }
    let action = params
        .get("action")
        .and_then(Value::as_object)
        .ok_or((-32602, "missing_action"))?;
    let kind = action
        .get("kind")
        .and_then(Value::as_str)
        .ok_or((-32602, "missing_action_kind"))?;
    if kind == "click"
        && (action
            .get("button")
            .and_then(Value::as_str)
            .unwrap_or("left")
            != "left"
            || action.get("count").and_then(Value::as_u64).unwrap_or(1) != 1)
    {
        return Ok(generic_dispatch_refusal(
            &params,
            "unsupported_action",
            "This executor supports only one semantic left click.",
            "ax",
        ));
    }
    let (legacy_action, value, direction, amount) = match kind {
        "click" => (
            "click_element",
            String::new(),
            "vertical",
            "small_increment",
        ),
        "set_value" => (
            "set_value",
            action
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            "vertical",
            "small_increment",
        ),
        "scroll" => {
            let pages = action.get("pages").and_then(Value::as_f64).unwrap_or(1.0);
            if !pages.is_finite() || pages <= 0.0 {
                return Ok(generic_dispatch_refusal(
                    &params,
                    "unsupported_action",
                    "Scroll pages must be positive.",
                    "ax",
                ));
            }
            let (direction, amount) = match action.get("direction").and_then(Value::as_str) {
                Some("up") => (
                    "vertical",
                    if pages >= 1.0 {
                        "large_decrement"
                    } else {
                        "small_decrement"
                    },
                ),
                Some("down") => (
                    "vertical",
                    if pages >= 1.0 {
                        "large_increment"
                    } else {
                        "small_increment"
                    },
                ),
                Some("left") => (
                    "horizontal",
                    if pages >= 1.0 {
                        "large_decrement"
                    } else {
                        "small_decrement"
                    },
                ),
                Some("right") => (
                    "horizontal",
                    if pages >= 1.0 {
                        "large_increment"
                    } else {
                        "small_increment"
                    },
                ),
                _ => {
                    return Ok(generic_dispatch_refusal(
                        &params,
                        "unsupported_action",
                        "The scroll direction is not supported by this executor.",
                        "ax",
                    ));
                }
            };
            ("scroll", String::new(), direction, amount)
        }
        "select_text" => {
            let text = action
                .get("text")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or((-32602, "invalid_text_selection"))?;
            if text.chars().count() > MAX_TEXT || text.chars().any(char::is_control) {
                return Ok(generic_dispatch_refusal(
                    &params,
                    "unsupported_action",
                    "The requested text selection is invalid or exceeds the executor limit.",
                    "ax",
                ));
            }
            (
                "select_text",
                text.to_owned(),
                "vertical",
                "small_increment",
            )
        }
        "secondary_action" => {
            let secondary = action
                .get("action")
                .and_then(Value::as_str)
                .ok_or((-32602, "missing_secondary_action"))?;
            match secondary {
                "press" => (
                    "click_element",
                    String::new(),
                    "vertical",
                    "small_increment",
                ),
                "pick" => ("select", String::new(), "vertical", "small_increment"),
                "confirm" => ("toggle", String::new(), "vertical", "small_increment"),
                "scroll_up" => ("scroll", String::new(), "vertical", "large_decrement"),
                "scroll_down" => ("scroll", String::new(), "vertical", "large_increment"),
                "scroll_left" => ("scroll", String::new(), "horizontal", "large_decrement"),
                "scroll_right" => ("scroll", String::new(), "horizontal", "large_increment"),
                _ => {
                    return Ok(generic_dispatch_refusal(
                        &params,
                        "unsupported_action",
                        "The requested secondary action is not exposed by this element.",
                        "ax",
                    ));
                }
            }
        }
        _ => {
            return Ok(generic_dispatch_refusal(
                &params,
                "unsupported_action",
                "The requested semantic action is not supported by this executor.",
                "ax",
            ));
        }
    };
    let raw = if legacy_action == "select_text" {
        let mut report = None;
        match platform::select_text(
            quoted.hwnd,
            element.clone(),
            &value,
            VerificationContext {
                snapshot: &quoted,
                cancelled,
                report: &mut report,
            },
        ) {
            Ok((status, verification)) => {
                // Only a verified mutation or an unknown post-dispatch result
                // spends the quoted frame. A refusal before the mutation
                // boundary must leave it available for an honest retry or
                // inspection by the caller.
                if matches!(status, "verified" | "unknown") {
                    registry.snapshots.remove(snapshot_id);
                }
                Ok(json!({"outcome":{"status":status,"verification":verification}}))
            }
            Err((-32001, "text_pattern_unavailable"))
            | Err((-32001, "text_document_range_unavailable"))
            | Err((-32001, "text_not_found")) => Err((-32602, "unsupported_action")),
            Err(error) => Err(error),
        }
    } else {
        act(
            json!({"snapshotId":snapshot_id,"elementToken":token,"action":legacy_action,"value":value,"direction":direction,"amount":amount}),
            registry,
            cancelled,
        )
    };
    let old = match raw {
        Ok(value) => value,
        Err((-32001, "snapshot_spent_or_unknown")) => {
            return Ok(generic_dispatch_refusal(
                &params,
                "snapshot_unknown",
                "The snapshot is no longer available.",
                "ax",
            ));
        }
        Err((-32001, "element_token_unknown_in_snapshot")) => {
            return Ok(generic_dispatch_refusal(
                &params,
                "element_unknown",
                "The element is not in the snapshot.",
                "ax",
            ));
        }
        Err((-32001, "stale_target_revalidate_failed")) => {
            return Ok(generic_dispatch_refusal(
                &params,
                "process_replaced",
                "The target process or window changed.",
                "ax",
            ));
        }
        Err((-32602, "unsupported_action")) => {
            return Ok(generic_dispatch_refusal(
                &params,
                "element_not_actionable",
                "The element does not expose this action.",
                "ax",
            ));
        }
        Err((
            -32001,
            "element_not_actionable"
            | "element_disabled"
            | "password_field_refused"
            | "value_pattern_readonly",
        )) => {
            return Ok(generic_dispatch_refusal(
                &params,
                "element_not_actionable",
                "The element cannot safely perform this action.",
                "ax",
            ));
        }
        Err(_) => {
            return Ok(generic_dispatch_refusal(
                &params,
                "dispatch_refused",
                "The target refused the action.",
                "ax",
            ))
        }
    };
    let outcome = old
        .get("outcome")
        .and_then(Value::as_object)
        .ok_or((-32603, "dispatch_result_invalid"))?;
    let status = outcome
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let method = match outcome.get("verification").and_then(Value::as_str) {
        Some("value_readback") => "value_readback",
        Some("selection_readback") => "selection_readback",
        Some("toggle_readback") => "tree_delta",
        _ => "action_result",
    };
    let path = match legacy_action {
        "set_value" => "ax_attribute",
        "select" | "select_text" => "ax_select",
        _ => "ax_action",
    };
    if status == "verified" {
        let post = generic_observe(
            json!({
                "session":session,
                "target":{"kind":"window","pid":quoted.pid,"windowId":quoted.hwnd},
                "includeImage":false
            }),
            registry,
        )
        .ok()
        .and_then(|value| value.get("snapshot").cloned());
        return Ok(json!({
            "ok":true,
            "toolCallId":params.get("toolCallId").cloned().unwrap_or(Value::Null),
            "outcome":"ok","tier":"ax","path":path,"effect":"confirmed",
            "verification":{"method":method,"observedChange":true},
            "settle":{"waitedMs":0,"quiesced":true,"reason":"quiesced"},
            "snapshot":post
        }));
    }
    let code = if status == "unknown" {
        "outcome_unknown"
    } else {
        "dispatch_refused"
    };
    Ok(generic_dispatch_refusal(
        &params,
        code,
        if status == "unknown" {
            "The action outcome is unknown."
        } else {
            "The target refused the action."
        },
        "ax",
    ))
}

fn generic_dispatch_key(
    params: Value,
    registry: &mut Registry,
    cancelled: &AtomicBool,
) -> Result<Value, (i32, &'static str)> {
    let session = require_session(&params, registry)?;
    let snapshot_id = params
        .get("snapshotId")
        .and_then(Value::as_str)
        .ok_or((-32602, "missing_snapshot_id"))?;
    let token = params
        .get("focusToken")
        .and_then(Value::as_str)
        .ok_or((-32602, "missing_focus_token"))?;
    let expected = params
        .get("expectElementDigest")
        .and_then(Value::as_str)
        .ok_or((-32602, "missing_element_digest"))?;
    let Some(quoted) = registry.snapshots.get(snapshot_id).cloned() else {
        return Ok(generic_dispatch_refusal(
            &params,
            "snapshot_unknown",
            "The snapshot is no longer available.",
            "coordinate-background",
        ));
    };
    if quoted.session != session {
        return Ok(generic_dispatch_refusal(
            &params,
            "snapshot_unknown",
            "The snapshot does not belong to this session.",
            "coordinate-background",
        ));
    }
    let Some(element) = quoted.elements.get(token) else {
        return Ok(generic_dispatch_refusal(
            &params,
            "element_unknown",
            "The focused element is not in the snapshot.",
            "coordinate-background",
        ));
    };
    if expected != element.digest {
        return Ok(generic_dispatch_refusal(
            &params,
            "element_digest_mismatch",
            "The focused element digest does not match the quoted snapshot.",
            "coordinate-background",
        ));
    }
    let action = params
        .get("action")
        .and_then(Value::as_object)
        .ok_or((-32602, "missing_action"))?;
    if action.get("kind").and_then(Value::as_str) != Some("key") {
        return Ok(generic_dispatch_refusal(
            &params,
            "unsupported_action",
            "This executor supports only the maka.cu/2 key action.",
            "coordinate-background",
        ));
    }
    let key = action
        .get("key")
        .and_then(Value::as_str)
        .ok_or((-32602, "missing_key"))?;
    let modifiers = action
        .get("modifiers")
        .and_then(Value::as_array)
        .ok_or((-32602, "missing_modifiers"))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or((-32602, "invalid_modifier"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let focus_policy = params
        .get("focusPolicy")
        .and_then(Value::as_str)
        .unwrap_or("require");
    if !matches!(focus_policy, "require" | "acquire") {
        return Ok(generic_dispatch_refusal(
            &params,
            "unsupported_action",
            "The focus policy is not supported by this executor.",
            "coordinate-background",
        ));
    }
    if platform::validate_key(key, &modifiers).is_err() {
        return Ok(generic_dispatch_refusal(
            &params,
            "unsupported_action",
            "The requested key or modifier is not supported by this executor.",
            "coordinate-background",
        ));
    }
    registry.snapshots.remove(snapshot_id);
    let mut report = None;
    let (status, verification) = match platform::dispatch_key(
        quoted.hwnd,
        element.clone(),
        key,
        &modifiers,
        focus_policy,
        VerificationContext {
            snapshot: &quoted,
            cancelled,
            report: &mut report,
        },
    ) {
        Ok(value) => value,
        Err((-32001, "stale_target_revalidate_failed")) => {
            return Ok(generic_dispatch_refusal(
                &params,
                "process_replaced",
                "The target process or window changed.",
                "coordinate-background",
            ));
        }
        Err((-32001, "key_unsupported" | "modifier_unsupported")) => {
            return Ok(generic_dispatch_refusal(
                &params,
                "unsupported_action",
                "The requested key or modifier is not supported by this executor.",
                "coordinate-background",
            ));
        }
        Err(error) => {
            return Ok(generic_dispatch_refusal(
                &params,
                "dispatch_refused",
                if error.1 == "cancelled_before_dispatch" {
                    "The keyboard action was cancelled before dispatch."
                } else {
                    "The keyboard action was refused before dispatch."
                },
                "coordinate-background",
            ));
        }
    };
    if status == "verified" {
        return Ok(json!({
            "ok":true,
            "toolCallId":params.get("toolCallId").cloned().unwrap_or(Value::Null),
            "outcome":"ok","tier":"coordinate-background","path":"win32_send_input","effect":"confirmed",
            "verification":{"method":verification,"observedChange":true},
            "settle":{"waitedMs":0,"quiesced":true,"reason":"quiesced"}
        }));
    }
    Ok(json!({
        "ok":false,
        "toolCallId":params.get("toolCallId").cloned().unwrap_or(Value::Null),
        "outcome":"unknown",
        "tier":"coordinate-background",
        "path":"win32_send_input",
        "effect":"unverifiable",
        "verification":{"method":verification,"observedChange":false},
        "error":{"code":"outcome_unknown","message":"The keyboard action outcome is unknown.","detail":report.unwrap_or(Value::Null)}
    }))
}

fn generic_screen_capture(
    params: Value,
    registry: &mut Registry,
) -> Result<Value, (i32, &'static str)> {
    let _session = require_session(&params, registry)?;
    let requested_display = params.get("displayId").and_then(Value::as_str);
    let raw = platform::capture_display(requested_display)?;
    if raw.get("status").and_then(Value::as_str) != Some("available") {
        return Ok(generic_domain_error(
            "capture_failed",
            "The screen could not be captured.",
        ));
    }
    let display_id = raw
        .get("displayId")
        .and_then(Value::as_str)
        .unwrap_or("windows-primary")
        .to_owned();
    let image = store_capture(
        registry,
        &format!(
            "screen-{}-{}",
            display_id,
            registry.next.fetch_add(1, Ordering::Relaxed)
        ),
        raw,
    )?;
    Ok(json!({
        "ok":true,
        "image":image,
        "displayId":display_id,
        "capturedAt":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or_default()
    }))
}

#[cfg(test)]
fn helper_generation() -> String {
    HELPER_GENERATION
        .get_or_init(|| {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default();
            format!("{}-{:x}", std::process::id(), nanos)
        })
        .clone()
}

fn observe(params: Value, registry: &mut Registry) -> Result<Value, (i32, &'static str)> {
    let hwnd = params
        .get("hwnd")
        .and_then(Value::as_i64)
        .ok_or((-32602, "missing_hwnd"))? as isize;
    if hwnd <= 0 {
        return Err((-32602, "invalid_hwnd"));
    }
    if registry.snapshots.len() >= MAX_SNAPSHOTS {
        return Err((-32001, "snapshot_registry_full"));
    }
    let observed = platform::observe(hwnd)?;
    let generation = observed.generation.clone();
    // Reserve a disjoint token range per snapshot. Without this stride,
    // e(N+1) from a later observation could alias e(N) from the prior one.
    let token_seed = registry
        .next
        .fetch_add((MAX_ELEMENTS as u64) + 1, Ordering::Relaxed)
        .wrapping_add(1);
    let snapshot_id = format!("s{:016x}", token_seed);
    let mut elements = HashMap::new();
    let mut rendered = Vec::with_capacity(observed.elements.len());
    let window_bounds = observed.window_bounds;
    for (index, element) in observed.elements.into_iter().enumerate().take(MAX_ELEMENTS) {
        let token = format!("e{:016x}", token_seed.wrapping_add(index as u64 + 1));
        let digest = element_digest_for_observed(&element, window_bounds);
        elements.insert(
            token.clone(),
            ElementRef {
                automation_id: element.automation_id.clone(),
                name: element.name.clone(),
                control_type: element.control_type,
                runtime_id: element.runtime_id.clone(),
                digest: digest.clone(),
            },
        );
        rendered.push(json!({"token":token,"name":element.name,"automationId":element.automation_id,"controlType":element.control_type,"runtimeId":element.runtime_id,"patterns":element.patterns,"actions":element.actions,"isEnabled":element.is_enabled,"focused":element.focused,"value":element.value,"scrollState":element.scroll_state,"bounds":element.bounds,"parentRuntimeId":element.parent_runtime_id,"depth":element.depth,"ancestorRoles":element.ancestor_roles,"siblingIndex":element.sibling_index,"digest":digest}));
    }
    let element_count = rendered.len();
    registry.snapshots.insert(
        snapshot_id.clone(),
        Snapshot {
            session: String::new(),
            hwnd,
            pid: observed.pid,
            start_time: observed.start_time,
            generation: generation.clone(),
            elements,
        },
    );
    let nodes = rendered
        .iter()
        .map(|item| {
            let mut node = item.clone();
            if let Some(object) = node.as_object_mut() {
                // Keep actual provider patterns. ScrollItem is not Scroll,
                // and SelectionItem/Toggle fallback is not Invoke support.
                let control_type = object
                    .get("controlType")
                    .and_then(Value::as_i64)
                    .unwrap_or_default();
                object.insert(
                    "controlType".to_owned(),
                    json!(format!("UIA.ControlType.{control_type}")),
                );
            }
            node
        })
        .collect::<Vec<_>>();
    Ok(
        json!({"snapshotId":snapshot_id,"protocol":PROTOCOL,"hwnd":hwnd,"pid":observed.pid,"windowGeneration":generation,"target":{"hwnd":hwnd,"pid":observed.pid,"processStartTimeUtc":format!("filetime:{}", observed.start_time),"windowGeneration":generation},"elements":rendered,"tree":{"rootToken":null,"nodeCount":element_count,"truncated":observed.truncated,"rawDescendantCount":observed.raw_descendant_count,"elapsedMs":observed.elapsed_ms,"nodes":nodes},"capture":{"path":"capture_rpc","status":"separate"}}),
    )
}

#[cfg(test)]
#[allow(dead_code)]
fn compat_payload(params: &Value, op: &str) -> Result<String, (i32, &'static str)> {
    if !matches!(op, "compat_type_text" | "compat_press_enter") {
        return Err((-32602, "compat_unsupported"));
    }
    if op == "compat_type_text" {
        let value = params
            .get("value")
            .and_then(Value::as_str)
            .ok_or((-32602, "compat_payload_invalid"))?;
        if value.chars().count() > MAX_TEXT || value.chars().any(char::is_control) {
            return Err((-32602, "compat_payload_invalid"));
        }
        Ok(value.to_owned())
    } else if params.get("value").is_some() {
        Err((-32602, "compat_payload_invalid"))
    } else {
        Ok(String::new())
    }
}

#[cfg(test)]
#[allow(dead_code)]
fn authorize_compat(params: Value, registry: &mut Registry) -> Result<Value, (i32, &'static str)> {
    let snapshot_id = params
        .get("snapshotId")
        .and_then(Value::as_str)
        .ok_or((-32602, "compat_authorization_missing"))?;
    let element_token = params
        .get("elementToken")
        .and_then(Value::as_str)
        .ok_or((-32602, "compat_authorization_missing"))?;
    let op = params
        .get("op")
        .and_then(Value::as_str)
        .ok_or((-32602, "compat_authorization_missing"))?;
    let payload = compat_payload(&params, op)?;
    prune_expired_authorizations(registry, Instant::now());
    if !authorization_registry_has_capacity(registry) {
        return Err((-32001, "compat_authorization_registry_full"));
    }
    let snapshot = registry
        .snapshots
        .get(snapshot_id)
        .cloned()
        .ok_or((-32001, "snapshot_spent_or_unknown"))?;
    let element = snapshot
        .elements
        .get(element_token)
        .cloned()
        .ok_or((-32001, "element_token_unknown_in_snapshot"))?;
    if element.runtime_id.is_empty() {
        return Err((-32001, "element_runtime_id_unavailable"));
    }
    let current = platform::identity(snapshot.hwnd)?;
    if current.pid != snapshot.pid
        || current.start_time != snapshot.start_time
        || current.generation != snapshot.generation
    {
        return Err((-32001, "stale_target_revalidate_failed"));
    }
    // Prune abandoned grants before enforcing the bounded registry.  Grants
    // remain one-shot and are still removed on every successful act.
    let token = new_authorization_token()?;
    registry.compat_authorizations.insert(
        token.clone(),
        CompatAuthorization {
            snapshot_id: snapshot_id.to_owned(),
            element_token: element_token.to_owned(),
            hwnd: snapshot.hwnd,
            pid: snapshot.pid,
            start_time: snapshot.start_time,
            generation: snapshot.generation.clone(),
            helper_generation: helper_generation(),
            runtime_id: element.runtime_id.clone(),
            op: op.to_owned(),
            payload,
            expires_at: Instant::now() + Duration::from_secs(5),
        },
    );
    Ok(
        json!({"authorizationToken":token,"snapshotId":snapshot_id,"elementToken":element_token,"op":op,"expiresMs":5000}),
    )
}

#[cfg(test)]
#[allow(dead_code)]
fn compat_act(
    params: Value,
    registry: &mut Registry,
    cancelled: &AtomicBool,
) -> Result<Value, (i32, &'static str)> {
    let auth_token = params
        .get("authorizationToken")
        .and_then(Value::as_str)
        .ok_or((-32602, "compat_authorization_missing"))?;
    let snapshot_id = params
        .get("snapshotId")
        .and_then(Value::as_str)
        .ok_or((-32602, "compat_authorization_missing"))?;
    let element_token = params
        .get("elementToken")
        .and_then(Value::as_str)
        .ok_or((-32602, "compat_authorization_missing"))?;
    let op = params
        .get("op")
        .and_then(Value::as_str)
        .ok_or((-32602, "compat_authorization_missing"))?;
    let payload = compat_payload(&params, op)?;
    let auth = registry
        .compat_authorizations
        .get(auth_token)
        .ok_or((-32001, "compat_authorization_unknown"))?
        .clone();
    if auth.snapshot_id != snapshot_id
        || auth.element_token != element_token
        || auth.op != op
        || auth.payload != payload
    {
        return Err((-32001, "compat_authorization_mismatch"));
    }
    if Instant::now() >= auth.expires_at {
        registry.compat_authorizations.remove(auth_token);
        return Err((-32001, "compat_authorization_expired"));
    }
    // Both capabilities are one-shot. Spend them before foreground/focus or
    // SendInput so a refused/unknown attempt cannot be replayed.
    registry.compat_authorizations.remove(auth_token);
    let snapshot = registry
        .snapshots
        .remove(snapshot_id)
        .ok_or((-32001, "snapshot_spent_or_unknown"))?;
    let element = snapshot
        .elements
        .get(element_token)
        .ok_or((-32001, "element_token_unknown_in_snapshot"))?
        .clone();
    if snapshot.hwnd != auth.hwnd
        || snapshot.pid != auth.pid
        || snapshot.start_time != auth.start_time
        || snapshot.generation != auth.generation
        || auth.helper_generation != helper_generation()
        || element.runtime_id != auth.runtime_id
    {
        return Err((-32001, "stale_target_revalidate_failed"));
    }
    let current = platform::identity(snapshot.hwnd)?;
    if current.pid != snapshot.pid
        || current.start_time != snapshot.start_time
        || current.generation != snapshot.generation
    {
        return Err((-32001, "stale_target_revalidate_failed"));
    }
    let mut readback = None;
    let (status, verification) = platform::compat_input(
        snapshot.hwnd,
        element,
        op,
        &payload,
        snapshot.pid,
        snapshot.start_time,
        &snapshot.generation,
        cancelled,
        &mut readback,
    )?;
    let effect = if status == "verified" {
        "text_set"
    } else if status == "unknown" {
        "possibly_dispatched"
    } else {
        "none"
    };
    Ok(
        json!({"outcome":{"tier":"compatibility","path":"send_input","status":status,"reason":if status == "refused" {Some(verification)} else {None::<&str>},"effect":effect,"snapshotSpent":true,"authorizationSpent":true,"verification":verification,"readback":readback}}),
    )
}

#[cfg(test)]
#[allow(dead_code)]
fn new_authorization_token() -> Result<String, (i32, &'static str)> {
    #[cfg(windows)]
    {
        let guid = unsafe { windows::Win32::System::Com::CoCreateGuid() }
            .map_err(|_| (-32001, "authorization_random_unavailable"))?;
        Ok(format!("auth-{guid:?}"))
    }
    #[cfg(not(windows))]
    {
        Err((-32001, "authorization_random_unavailable"))
    }
}

#[cfg(test)]
#[allow(dead_code)]
fn prune_expired_authorizations(registry: &mut Registry, now: Instant) {
    registry
        .compat_authorizations
        .retain(|_, authorization| authorization.expires_at > now);
}

#[cfg(test)]
#[allow(dead_code)]
fn authorization_registry_has_capacity(registry: &Registry) -> bool {
    registry.compat_authorizations.len() < MAX_SNAPSHOTS
}

fn act(
    params: Value,
    registry: &mut Registry,
    cancelled: &AtomicBool,
) -> Result<Value, (i32, &'static str)> {
    let snapshot_id = params
        .get("snapshotId")
        .and_then(Value::as_str)
        .ok_or((-32602, "missing_snapshot"))?;
    let token = params
        .get("elementToken")
        .or_else(|| params.get("token"))
        .and_then(Value::as_str)
        .ok_or((-32602, "missing_element_token"))?;
    let action = params
        .get("action")
        .or_else(|| params.get("op"))
        .or_else(|| params.get("name"))
        .and_then(Value::as_str)
        .ok_or((-32602, "missing_action"))?;
    // Spend before touching COM. A duplicate action is therefore always refused.
    let snapshot = registry
        .snapshots
        .remove(snapshot_id)
        .ok_or((-32001, "snapshot_spent_or_unknown"))?;
    let element = snapshot
        .elements
        .get(token)
        .ok_or((-32001, "element_token_unknown_in_snapshot"))?
        .clone();
    if !matches!(
        action,
        "set_value" | "click_element" | "select" | "toggle" | "scroll"
    ) {
        return Err((-32602, "unsupported_action"));
    }
    let current = match platform::identity(snapshot.hwnd) {
        Ok(identity) => identity,
        Err((-32001, "target_window_gone")) => {
            return Err((-32001, "stale_target_revalidate_failed"));
        }
        Err(error) => return Err(error),
    };
    if current.pid != snapshot.pid
        || current.start_time != snapshot.start_time
        || current.generation != snapshot.generation
    {
        return Err((-32001, "stale_target_revalidate_failed"));
    }
    let value = params
        .get("value")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let direction = params
        .get("direction")
        .and_then(Value::as_str)
        .unwrap_or("vertical");
    let amount = params
        .get("amount")
        .and_then(Value::as_str)
        .unwrap_or("small_increment");
    if action == "scroll" && !matches!(direction, "horizontal" | "vertical") {
        return Err((-32602, "invalid_scroll_direction"));
    }
    if action == "scroll"
        && !matches!(
            amount,
            "small_increment"
                | "small_decrement"
                | "large_increment"
                | "large_decrement"
                | "no_amount"
        )
    {
        return Err((-32602, "invalid_scroll_amount"));
    }
    if action == "set_value" && value.chars().count() > MAX_TEXT {
        return Err((-32602, "value_too_long"));
    }
    let mut readback = None;
    let (mut status, mut verification) = platform::act(
        snapshot.hwnd,
        element,
        action,
        value,
        direction,
        amount,
        VerificationContext {
            snapshot: &snapshot,
            cancelled,
            report: &mut readback,
        },
    )?;
    let post_dispatch_delay = params
        .get("debugPostDispatchDelayMs")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    if post_dispatch_delay > 3_000 {
        return Err((-32602, "invalid_debugPostDispatchDelayMs"));
    }
    if post_dispatch_delay > 0 && status != "refused" {
        std::thread::sleep(Duration::from_millis(post_dispatch_delay));
    }
    if status != "refused" {
        let post_valid = platform::identity(snapshot.hwnd)
            .map(|after| {
                after.pid == snapshot.pid
                    && after.start_time == snapshot.start_time
                    && after.generation == snapshot.generation
            })
            .unwrap_or(false);
        if !post_valid {
            status = "unknown";
            verification = "post_revalidation_failed";
        }
    }
    let effect = if status == "verified" {
        if action == "set_value" {
            "value_set"
        } else if action == "select" {
            "selected"
        } else if action == "toggle" {
            "toggled"
        } else if action == "scroll" {
            "scrolled"
        } else {
            "invoked"
        }
    } else if status == "unknown" {
        "possibly_dispatched"
    } else {
        "none"
    };
    Ok(
        json!({"outcome":{"tier":"uia-pattern","path":match action { "set_value" => "value_pattern", "click_element" => "invoke_toggle_selection", "select" => "selection_item_pattern", "toggle" => "toggle_pattern", "scroll" => "scroll_pattern", _ => "none" },"status":status,"effect":effect,"snapshotSpent":true,"verification":verification,"readback":readback}}),
    )
}

struct VerificationContext<'a> {
    snapshot: &'a Snapshot,
    cancelled: &'a AtomicBool,
    report: &'a mut Option<Value>,
}

#[derive(Debug)]
struct ObservedElement {
    automation_id: String,
    name: String,
    control_type: i32,
    runtime_id: Vec<i32>,
    actions: Vec<&'static str>,
    patterns: Vec<&'static str>,
    is_enabled: bool,
    value: Option<String>,
    scroll_state: Option<Value>,
    // Absolute screen-pixel bounds from UIA. The protocol façade converts
    // these to window-local logical points exactly once.
    bounds: [i32; 4],
    focused: bool,
    parent_runtime_id: Vec<i32>,
    depth: usize,
    ancestor_roles: Vec<String>,
    sibling_index: usize,
}
#[derive(Debug)]
struct Observed {
    pid: u32,
    start_time: u64,
    generation: String,
    window_bounds: [i32; 4],
    elements: Vec<ObservedElement>,
    raw_descendant_count: i32,
    truncated: bool,
    elapsed_ms: u64,
}
#[derive(Debug)]
struct Identity {
    pid: u32,
    start_time: u64,
    generation: String,
}

#[cfg(not(windows))]
mod platform {
    use super::*;
    pub fn initialize_worker() {}
    pub fn process_alive(pid: u32) -> bool {
        pid == std::process::id()
    }
    pub fn foreground_pid() -> Option<u32> {
        None
    }
    pub fn displays() -> Result<Vec<Value>, (i32, &'static str)> {
        Ok(Vec::new())
    }
    pub fn list_windows() -> Result<Value, (i32, &'static str)> {
        Ok(json!({"windows":[],"platform":"non_windows"}))
    }
    pub fn observe(_: isize) -> Result<Observed, (i32, &'static str)> {
        Err((-32001, "windows_only"))
    }
    pub fn identity(_: isize) -> Result<Identity, (i32, &'static str)> {
        Err((-32001, "windows_only"))
    }
    pub fn act(
        _: isize,
        _: ElementRef,
        _: &str,
        _: &str,
        _: &str,
        _: &str,
        _: VerificationContext<'_>,
    ) -> Result<(&'static str, &'static str), (i32, &'static str)> {
        Err((-32001, "windows_only"))
    }
    pub fn select_text(
        _: isize,
        _: ElementRef,
        _: &str,
        _: VerificationContext<'_>,
    ) -> Result<(&'static str, &'static str), (i32, &'static str)> {
        Err((-32001, "windows_only"))
    }
    pub fn validate_key(_: &str, _: &[String]) -> Result<(), (i32, &'static str)> {
        Err((-32001, "windows_only"))
    }
    pub fn dispatch_key(
        _: isize,
        _: ElementRef,
        _: &str,
        _: &[String],
        _: &str,
        _: VerificationContext<'_>,
    ) -> Result<(&'static str, &'static str), (i32, &'static str)> {
        Err((-32001, "windows_only"))
    }
    #[cfg(test)]
    #[allow(dead_code)]
    pub fn compat_input(
        _: isize,
        _: ElementRef,
        _: &str,
        _: &str,
        _: u32,
        _: u64,
        _: &str,
        _: &AtomicBool,
        _: &mut Option<Value>,
    ) -> Result<(&'static str, &'static str), (i32, &'static str)> {
        Err((-32001, "windows_only"))
    }
    pub fn capture(_: Value) -> Result<Value, (i32, &'static str)> {
        Ok(json!({"status":"unavailable","path":"none","reason":"windows_only"}))
    }
    pub fn capture_display(_: Option<&str>) -> Result<Value, (i32, &'static str)> {
        Ok(json!({"status":"unavailable","path":"none","reason":"windows_only"}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_is_spent_before_platform_dispatch() {
        let mut registry = Registry::default();
        registry.snapshots.insert(
            "s1".to_owned(),
            Snapshot {
                session: String::new(),
                hwnd: 1,
                pid: 1,
                start_time: 1,
                generation: "g".to_owned(),
                elements: HashMap::from([(
                    "e1".to_owned(),
                    ElementRef {
                        automation_id: "a".to_owned(),
                        name: "n".to_owned(),
                        control_type: 50000,
                        runtime_id: vec![1],
                        digest: String::new(),
                    },
                )]),
            },
        );
        let params = json!({"snapshotId":"s1","elementToken":"e1","op":"click_element"});
        let _ = act(params.clone(), &mut registry, &AtomicBool::new(false));
        assert!(!registry.snapshots.contains_key("s1"));
        let second = act(params, &mut registry, &AtomicBool::new(false)).unwrap_err();
        assert_eq!(second.1, "snapshot_spent_or_unknown");
    }

    #[test]
    fn cancellation_before_dispatch_spends_action_snapshot() {
        let mut registry = Registry::default();
        registry.snapshots.insert(
            "s-cancel".to_owned(),
            Snapshot {
                session: String::new(),
                hwnd: 1,
                pid: 1,
                start_time: 1,
                generation: "g".to_owned(),
                elements: HashMap::new(),
            },
        );
        let result = cancel_queued_action(json!({"snapshotId":"s-cancel"}), &mut registry)
            .expect("queued cancellation should settle");
        assert_eq!(result["outcome"]["status"], json!("refused"));
        assert!(!registry.snapshots.contains_key("s-cancel"));
    }

    #[test]
    fn compatibility_payload_is_bounded_and_explicit() {
        assert!(compat_payload(&json!({"value":"safe"}), "compat_type_text").is_ok());
        assert_eq!(
            compat_payload(&json!({"value":"line\nfeed"}), "compat_type_text")
                .unwrap_err()
                .1,
            "compat_payload_invalid"
        );
        assert_eq!(
            compat_payload(&json!({"value":"unexpected"}), "compat_press_enter")
                .unwrap_err()
                .1,
            "compat_payload_invalid"
        );
        assert_eq!(
            compat_payload(&json!({"value":"x"}), "press_enter")
                .unwrap_err()
                .1,
            "compat_unsupported"
        );
    }

    #[test]
    fn compatibility_authorization_is_one_shot_in_registry() {
        let mut registry = Registry::default();
        registry.compat_authorizations.insert(
            "auth-test".to_owned(),
            CompatAuthorization {
                snapshot_id: "s".to_owned(),
                element_token: "e".to_owned(),
                hwnd: 1,
                pid: 1,
                start_time: 1,
                generation: "g".to_owned(),
                helper_generation: "h".to_owned(),
                runtime_id: vec![1],
                op: "compat_press_enter".to_owned(),
                payload: String::new(),
                expires_at: Instant::now() + Duration::from_secs(1),
            },
        );
        assert!(registry.compat_authorizations.remove("auth-test").is_some());
        assert!(registry.compat_authorizations.remove("auth-test").is_none());
    }

    #[test]
    #[cfg(windows)]
    fn authorization_tokens_are_os_random_and_opaque() {
        let first = new_authorization_token().expect("CoCreateGuid should succeed");
        let second = new_authorization_token().expect("CoCreateGuid should succeed");
        assert!(first.starts_with("auth-"));
        assert!(second.starts_with("auth-"));
        assert_ne!(first, second);
    }

    #[test]
    fn authorization_registry_prunes_expired_entries_and_enforces_capacity() {
        let now = Instant::now();
        let mut registry = Registry::default();
        registry.compat_authorizations.insert(
            "expired".to_owned(),
            CompatAuthorization {
                snapshot_id: "s".to_owned(),
                element_token: "e".to_owned(),
                hwnd: 1,
                pid: 1,
                start_time: 1,
                generation: "g".to_owned(),
                helper_generation: "h".to_owned(),
                runtime_id: vec![1],
                op: "compat_press_enter".to_owned(),
                payload: String::new(),
                expires_at: now - Duration::from_secs(1),
            },
        );
        prune_expired_authorizations(&mut registry, now);
        assert!(registry.compat_authorizations.is_empty());
        for index in 0..MAX_SNAPSHOTS {
            registry.compat_authorizations.insert(
                format!("live-{index}"),
                CompatAuthorization {
                    snapshot_id: "s".to_owned(),
                    element_token: "e".to_owned(),
                    hwnd: 1,
                    pid: 1,
                    start_time: 1,
                    generation: "g".to_owned(),
                    helper_generation: "h".to_owned(),
                    runtime_id: vec![1],
                    op: "compat_press_enter".to_owned(),
                    payload: String::new(),
                    expires_at: now + Duration::from_secs(30),
                },
            );
        }
        assert!(!authorization_registry_has_capacity(&registry));
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use base64::Engine;
    use flate2::{write::ZlibEncoder, Compression};
    use std::io::Write;
    use std::time::{Duration, Instant};
    use windows::core::{IUnknown, Interface, GUID, HSTRING, PWSTR};
    use windows::core::{BOOL, BSTR};
    use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem};
    use windows::Graphics::DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat};
    use windows::Graphics::SizeInt32;
    use windows::Win32::Foundation::{CloseHandle, FILETIME, HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
    use windows::Win32::Graphics::Direct3D11::{
        D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
        D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE,
        D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
    };
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
    use windows::Win32::Graphics::Dxgi::IDXGIDevice;
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, HMONITOR, MONITORINFO,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Ole::{
        SafeArrayDestroy, SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound,
    };
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, GetProcessTimes, OpenProcess, QueryFullProcessImageNameW,
        PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::System::WinRT::Direct3D11::CreateDirect3D11DeviceFromDXGIDevice;
    use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
    use windows::Win32::System::WinRT::{
        RoGetActivationFactory, RoInitialize, RO_INIT_MULTITHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationInvokePattern,
        IUIAutomationScrollItemPattern, IUIAutomationScrollPattern,
        IUIAutomationSelectionItemPattern, IUIAutomationTextPattern, IUIAutomationTogglePattern,
        IUIAutomationTreeWalker, IUIAutomationValuePattern, ScrollAmount_LargeDecrement,
        ScrollAmount_LargeIncrement, ScrollAmount_NoAmount, ScrollAmount_SmallDecrement,
        ScrollAmount_SmallIncrement, TreeScope_Descendants, UIA_InvokePatternId,
        UIA_ScrollItemPatternId, UIA_ScrollPatternId, UIA_SelectionItemPatternId,
        UIA_TextPatternId, UIA_TogglePatternId, UIA_ValuePatternId,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE,
        VIRTUAL_KEY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsWindow,
        IsWindowVisible,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, SetForegroundWindow};
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GA_ROOT};
    static COM_INIT: Once = Once::new();
    const IID_IDIRECT3D_DXGI_INTERFACE_ACCESS: GUID =
        GUID::from_u128(0xa9b3d012_3df2_4ee3_b8d1_8695f457d3c1);

    /// The worker owns the COM apartment.  Keeping initialization here makes
    /// the stdio thread a pure control plane and avoids UIA calls crossing
    /// apartments when a request is cancelled.
    pub fn initialize_worker() {
        COM_INIT.call_once(|| unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        });
    }

    #[repr(C)]
    struct DxgiInterfaceAccessVtbl {
        query: usize,
        add_ref: usize,
        release: usize,
        get_interface: unsafe extern "system" fn(
            *mut core::ffi::c_void,
            *const GUID,
            *mut *mut core::ffi::c_void,
        ) -> windows::core::HRESULT,
    }

    pub fn list_windows() -> Result<Value, (i32, &'static str)> {
        let mut windows: Vec<Value> = Vec::new();
        unsafe {
            let _ = EnumWindows(Some(enum_window), LPARAM(&mut windows as *mut _ as isize));
        }
        Ok(json!({"windows":windows,"platform":"windows"}))
    }

    pub fn displays() -> Result<Vec<Value>, (i32, &'static str)> {
        let mut values = Vec::new();
        unsafe {
            let _ = EnumDisplayMonitors(
                None,
                None,
                Some(enum_monitor),
                LPARAM(&mut values as *mut _ as isize),
            );
        }
        if values.is_empty() {
            return Err((-32001, "display_inventory_unavailable"));
        }
        Ok(values)
    }

    unsafe extern "system" fn enum_monitor(
        monitor: HMONITOR,
        _: windows::Win32::Graphics::Gdi::HDC,
        _: *mut RECT,
        data: LPARAM,
    ) -> BOOL {
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return BOOL(1);
        }
        let rect = info.rcMonitor;
        if rect.right <= rect.left || rect.bottom <= rect.top {
            return BOOL(1);
        }
        let values = &mut *(data.0 as *mut Vec<Value>);
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        let id = format!("monitor:{:x}", monitor.0 as usize);
        values.push(json!({
            "displayId": id,
            "logicalBounds":{"x":rect.left,"y":rect.top,"width":width,"height":height},
            "sourceBoundsPx":{"x":rect.left,"y":rect.top,"width":width,"height":height},
            "scaleFactor":1.0
        }));
        BOOL(1)
    }

    pub fn process_alive(pid: u32) -> bool {
        if pid == 0 {
            return false;
        }
        let Ok(handle) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) })
        else {
            return false;
        };
        let mut exit_code = 0u32;
        let alive =
            unsafe { GetExitCodeProcess(handle, &mut exit_code).is_ok() } && exit_code == 259; // STILL_ACTIVE
        unsafe {
            let _ = CloseHandle(handle);
        }
        alive
    }

    pub fn foreground_pid() -> Option<u32> {
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid = 0u32;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
        }
        (pid > 0).then_some(pid)
    }

    fn process_app_id(pid: u32) -> Option<String> {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()? };
        let mut buffer = vec![0u16; 32_768];
        let mut length = buffer.len() as u32;
        let ok = unsafe {
            QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                PWSTR(buffer.as_mut_ptr()),
                &mut length,
            )
            .is_ok()
        };
        unsafe {
            let _ = CloseHandle(handle);
        }
        if !ok || length == 0 {
            return None;
        }
        let path = String::from_utf16(&buffer[..length as usize]).ok()?;
        Some(format!("win32:{}", path.to_ascii_lowercase()))
    }

    unsafe extern "system" fn enum_window(hwnd: HWND, data: LPARAM) -> BOOL {
        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return BOOL(1);
        }
        let mut title = [0u16; 512];
        let len = GetWindowTextW(hwnd, &mut title) as usize;
        let title = String::from_utf16_lossy(&title[..len]);
        let windows = &mut *(data.0 as *mut Vec<Value>);
        if windows.len() < 128 {
            let mut rect = RECT::default();
            let bounds = if GetWindowRect(hwnd, &mut rect).is_ok() {
                json!([
                    rect.left,
                    rect.top,
                    rect.right - rect.left,
                    rect.bottom - rect.top
                ])
            } else {
                json!([0, 0, 1, 1])
            };
            windows.push(json!({
                "hwnd":hwnd.0 as isize,
                "pid":pid,
                "appId":process_app_id(pid).unwrap_or_else(|| format!("pid:{pid}")),
                "title":title,
                "bounds":bounds,
                "isOffscreen":false
            }));
        }
        BOOL(1)
    }

    fn automation() -> Result<IUIAutomation, (i32, &'static str)> {
        COM_INIT.call_once(|| unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        });
        unsafe {
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                .map_err(|_| (-32001, "uia_unavailable"))
        }
    }
    fn text(b: BSTR) -> String {
        String::try_from(b).unwrap_or_default()
    }
    fn process_start_time(pid: u32) -> Option<u64> {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()? };
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let ok = unsafe {
            GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user).is_ok()
        };
        unsafe {
            let _ = CloseHandle(handle);
        }
        ok.then_some(((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64)
    }
    fn generation(hwnd: HWND, pid: u32, root: &IUIAutomationElement) -> String {
        let name = unsafe { root.CurrentName().map(text).unwrap_or_default() };
        let class = unsafe { root.CurrentClassName().map(text).unwrap_or_default() };
        let runtime = runtime_id(root)
            .into_iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let mut fingerprint =
            format!("{}|{}|{}|{}|{}", hwnd.0 as isize, class, name, pid, runtime).into_bytes();
        // Keep the same 16-hex-character wire shape as the C# driver. This is
        // a small deterministic hash, not a security primitive; PID/start
        // time and exact RuntimeId are separately revalidated before actions.
        let mut hash = 0xcbf29ce484222325u64;
        for byte in fingerprint.drain(..) {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        format!("{hash:016x}")
    }
    fn runtime_id(element: &IUIAutomationElement) -> Vec<i32> {
        let Ok(array) = (unsafe { element.GetRuntimeId() }) else {
            return Vec::new();
        };
        if array.is_null() {
            return Vec::new();
        }
        let (Ok(lower), Ok(upper)) = (unsafe { SafeArrayGetLBound(array, 1) }, unsafe {
            SafeArrayGetUBound(array, 1)
        }) else {
            unsafe {
                let _ = SafeArrayDestroy(array);
            }
            return Vec::new();
        };
        let mut ids = Vec::new();
        for index in lower..=upper {
            let mut value = 0i32;
            if unsafe { SafeArrayGetElement(array, &index, &mut value as *mut _ as *mut _) }.is_ok()
            {
                ids.push(value);
            }
        }
        unsafe {
            let _ = SafeArrayDestroy(array);
        }
        ids
    }

    fn tree_walker(uia: &IUIAutomation) -> Result<IUIAutomationTreeWalker, (i32, &'static str)> {
        unsafe { uia.ControlViewWalker() }
            .or_else(|_| unsafe { uia.RawViewWalker() })
            .map_err(|_| (-32001, "uia_tree_walker_unavailable"))
    }

    fn hierarchy_metadata(
        uia: &IUIAutomation,
        root: &IUIAutomationElement,
        element: &IUIAutomationElement,
    ) -> (Vec<i32>, usize, Vec<String>, usize) {
        let Ok(walker) = tree_walker(uia) else {
            return (Vec::new(), 1, Vec::new(), 0);
        };
        let root_id = runtime_id(root);
        let element_id = runtime_id(element);
        let mut parent_runtime_id = Vec::new();
        let mut ancestor_roles = Vec::new();
        let mut sibling_index = 0usize;
        let mut depth = 0usize;
        let mut current = element.clone();
        for _ in 0..64 {
            let Ok(parent) = (unsafe { walker.GetParentElement(&current) }) else {
                break;
            };
            let parent_id = runtime_id(&parent);
            if depth == 0 {
                parent_runtime_id = parent_id.clone();
                let mut sibling = unsafe { walker.GetFirstChildElement(&parent).ok() };
                while let Some(candidate) = sibling {
                    if runtime_id(&candidate) == element_id {
                        break;
                    }
                    sibling_index += 1;
                    sibling = unsafe { walker.GetNextSiblingElement(&candidate).ok() };
                }
            }
            depth += 1;
            let role = unsafe { parent.CurrentControlType().map(|value| value.0).ok() }
                .map(|value| format!("UIA.ControlType.{value}"));
            if let Some(role) = role {
                if ancestor_roles.len() < 8 {
                    ancestor_roles.push(role);
                }
            }
            if parent_id == root_id {
                break;
            }
            if parent_id.is_empty() || parent_id == runtime_id(&current) {
                break;
            }
            current = parent;
        }
        (parent_runtime_id, depth, ancestor_roles, sibling_index)
    }

    pub fn identity(hwnd: isize) -> Result<Identity, (i32, &'static str)> {
        let hwnd = HWND(hwnd as *mut _);
        if unsafe { !IsWindow(Some(hwnd)).as_bool() } {
            return Err((-32001, "target_window_gone"));
        }
        let mut pid = 0u32;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
        }
        let uia = automation()?;
        let start_time =
            process_start_time(pid).ok_or((-32001, "target_process_start_time_unavailable"))?;
        let root = unsafe {
            uia.ElementFromHandle(hwnd)
                .map_err(|_| (-32001, "uia_element_unavailable"))?
        };
        Ok(Identity {
            pid,
            start_time,
            generation: generation(hwnd, pid, &root),
        })
    }
    pub fn observe(hwnd: isize) -> Result<Observed, (i32, &'static str)> {
        let started = Instant::now();
        let hwnd = HWND(hwnd as *mut _);
        let ident = identity(hwnd.0 as isize)?;
        let mut window_rect = RECT::default();
        let window_bounds = if unsafe { GetWindowRect(hwnd, &mut window_rect).is_ok() } {
            [
                window_rect.left,
                window_rect.top,
                window_rect.right - window_rect.left,
                window_rect.bottom - window_rect.top,
            ]
        } else {
            [0, 0, 0, 0]
        };
        let uia = automation()?;
        let root = unsafe {
            uia.ElementFromHandle(hwnd)
                .map_err(|_| (-32001, "uia_element_unavailable"))?
        };
        let condition = unsafe {
            uia.CreateTrueCondition()
                .map_err(|_| (-32001, "uia_condition_failed"))?
        };
        let all = unsafe {
            root.FindAll(TreeScope_Descendants, &condition)
                .map_err(|_| (-32001, "uia_observe_failed"))?
        };
        let raw_count = unsafe { all.Length().unwrap_or(0) };
        let truncated = raw_count > MAX_ELEMENTS as i32;
        let count = raw_count.min(MAX_ELEMENTS as i32);
        let mut elements = Vec::with_capacity(count as usize);
        for i in 0..count {
            let Ok(el) = (unsafe { all.GetElement(i) }) else {
                continue;
            };
            let name = unsafe { el.CurrentName().map(text).unwrap_or_default() };
            let automation_id = unsafe { el.CurrentAutomationId().map(text).unwrap_or_default() };
            let control_type = unsafe { el.CurrentControlType().map(|x| x.0).unwrap_or_default() };
            let runtime_id = runtime_id(&el);
            let is_enabled = unsafe { el.CurrentIsEnabled().map(|x| x.as_bool()).unwrap_or(false) };
            let focused = unsafe {
                el.CurrentHasKeyboardFocus()
                    .map(|x| x.as_bool())
                    .unwrap_or(false)
            };
            let bounds = unsafe { el.CurrentBoundingRectangle() }
                .map(|rect| {
                    [
                        rect.left,
                        rect.top,
                        rect.right - rect.left,
                        rect.bottom - rect.top,
                    ]
                })
                .unwrap_or([0, 0, 0, 0]);
            let value = unsafe {
                el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                    .ok()
                    .and_then(|pattern| pattern.CurrentValue().ok().map(text))
            };
            let mut actions = Vec::new();
            let mut patterns = Vec::new();
            if unsafe {
                el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                    .is_ok()
            } {
                actions.push("set_value");
                patterns.push("Value");
            }
            if unsafe {
                el.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                    .is_ok()
            } {
                actions.push("click_element");
                patterns.push("Invoke");
            }
            let has_selection = unsafe {
                el.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                    UIA_SelectionItemPatternId,
                )
                .is_ok()
            };
            if has_selection {
                actions.push("select");
                patterns.push("SelectionItem");
            }
            let has_toggle = unsafe {
                el.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
                    .is_ok()
            };
            if has_toggle {
                actions.push("toggle");
                patterns.push("Toggle");
            }
            if (has_selection || has_toggle) && !actions.contains(&"click_element") {
                actions.push("click_element");
            }
            if unsafe {
                el.GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId)
                    .is_ok()
            } {
                patterns.push("Scroll");
            }
            if unsafe {
                el.GetCurrentPatternAs::<IUIAutomationScrollItemPattern>(UIA_ScrollItemPatternId)
                    .is_ok()
            } {
                patterns.push("ScrollItem");
            }
            if patterns.contains(&"Scroll") {
                actions.push("scroll");
            }
            if unsafe {
                el.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
                    .is_ok()
            } {
                actions.push("select_text");
                patterns.push("Text");
            }
            let scroll_state = unsafe {
                el.GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId)
                    .ok()
                    .and_then(|p| {
                        Some(json!({"source":"ScrollPattern.Current",
                        "horizontalPercent":p.CurrentHorizontalScrollPercent().ok()?,
                        "verticalPercent":p.CurrentVerticalScrollPercent().ok()?}))
                    })
            };
            if !actions.is_empty() || !name.is_empty() {
                let (parent_runtime_id, depth, ancestor_roles, sibling_index) =
                    hierarchy_metadata(&uia, &root, &el);
                elements.push(ObservedElement {
                    automation_id,
                    name,
                    control_type,
                    runtime_id,
                    actions,
                    patterns,
                    is_enabled,
                    value,
                    scroll_state,
                    bounds,
                    focused,
                    parent_runtime_id,
                    depth,
                    ancestor_roles,
                    sibling_index,
                });
            }
        }
        Ok(Observed {
            pid: ident.pid,
            start_time: ident.start_time,
            generation: ident.generation,
            window_bounds,
            elements,
            raw_descendant_count: raw_count,
            truncated,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    fn same_element_identity(
        element: &IUIAutomationElement,
        quoted: &ElementRef,
        hwnd: isize,
        snapshot: &Snapshot,
    ) -> bool {
        identity(hwnd)
            .map(|current| {
                current.pid == snapshot.pid
                    && current.start_time == snapshot.start_time
                    && current.generation == snapshot.generation
            })
            .unwrap_or(false)
            && runtime_id(element) == quoted.runtime_id
    }

    pub fn select_text(
        hwnd: isize,
        element: ElementRef,
        value: &str,
        verification: VerificationContext<'_>,
    ) -> Result<(&'static str, &'static str), (i32, &'static str)> {
        let hwnd = HWND(hwnd as *mut _);
        let uia = automation()?;
        let root = unsafe {
            uia.ElementFromHandle(hwnd)
                .map_err(|_| (-32001, "uia_element_unavailable"))?
        };
        let condition = unsafe {
            uia.CreateTrueCondition()
                .map_err(|_| (-32001, "uia_condition_failed"))?
        };
        let all = unsafe {
            root.FindAll(TreeScope_Descendants, &condition)
                .map_err(|_| (-32001, "uia_observe_failed"))?
        };
        let count = unsafe { all.Length().unwrap_or(0).min(MAX_ELEMENTS as i32) };
        let mut target = None;
        for index in 0..count {
            let Ok(candidate) = (unsafe { all.GetElement(index) }) else {
                continue;
            };
            if runtime_id(&candidate) != element.runtime_id
                || unsafe {
                    candidate
                        .CurrentAutomationId()
                        .map(text)
                        .unwrap_or_default()
                } != element.automation_id
                || unsafe { candidate.CurrentName().map(text).unwrap_or_default() } != element.name
                || unsafe {
                    candidate
                        .CurrentControlType()
                        .map(|value| value.0)
                        .unwrap_or_default()
                } != element.control_type
            {
                continue;
            }
            target = Some(candidate);
            break;
        }
        let target = target.ok_or((-32001, "element_changed"))?;
        if unsafe {
            !target
                .CurrentIsEnabled()
                .map(|value| value.as_bool())
                .unwrap_or(false)
        } {
            return Err((-32001, "element_disabled"));
        }
        let pattern = unsafe {
            target
                .GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
                .map_err(|_| (-32001, "text_pattern_unavailable"))?
        };
        let document = unsafe {
            pattern
                .DocumentRange()
                .map_err(|_| (-32001, "text_document_range_unavailable"))?
        };
        let needle: BSTR = value.into();
        let range = unsafe {
            document
                .FindText(&needle, false, false)
                .map_err(|_| (-32001, "text_not_found"))?
        };
        if !same_element_identity(
            &target,
            &element,
            verification.snapshot.hwnd,
            verification.snapshot,
        ) {
            return Ok(("refused", "stale_target_revalidate_failed"));
        }
        if verification.cancelled.load(Ordering::Acquire) {
            return Ok(("refused", "cancelled_before_dispatch"));
        }
        if unsafe { range.Select() }.is_err() {
            return Ok(("unknown", "text_selection_failed_after_dispatch"));
        }
        if identity(hwnd.0 as isize).map(|current| {
            current.pid == verification.snapshot.pid
                && current.start_time == verification.snapshot.start_time
                && current.generation == verification.snapshot.generation
        }) != Ok(true)
        {
            return Ok(("unknown", "post_dispatch_target_changed"));
        }
        let selection = unsafe {
            pattern
                .GetSelection()
                .map_err(|_| (-32001, "selection_readback_unavailable"))?
        };
        let selection_count = unsafe { selection.Length().unwrap_or(0) };
        if selection_count <= 0 {
            return Ok(("unknown", "selection_readback_empty"));
        }
        let mut selected = String::new();
        for index in 0..selection_count {
            let range = unsafe {
                selection
                    .GetElement(index)
                    .map_err(|_| (-32001, "selection_readback_unavailable"))?
            };
            let text = unsafe { range.GetText(-1) }
                .map_err(|_| (-32001, "selection_readback_unavailable"))?;
            selected.push_str(
                &String::try_from(text).map_err(|_| (-32001, "selection_readback_unavailable"))?,
            );
        }
        if selected == value {
            Ok(("verified", "selection_readback_match"))
        } else {
            Ok(("unknown", "selection_readback_mismatch"))
        }
    }

    pub fn act(
        hwnd: isize,
        element: ElementRef,
        action: &str,
        value: &str,
        direction: &str,
        amount: &str,
        verification: VerificationContext<'_>,
    ) -> Result<(&'static str, &'static str), (i32, &'static str)> {
        let hwnd = HWND(hwnd as *mut _);
        // Rebuild the §4.3 binding from a fresh UIA observation before
        // acquiring or invoking any pattern. This catches value, frame,
        // action-set, and provider-tree changes in addition to RuntimeId.
        let current = observe(hwnd.0 as isize)?;
        let current_digest = current
            .elements
            .iter()
            .enumerate()
            .find(|(_, candidate)| candidate.runtime_id == element.runtime_id)
            .map(|(_index, candidate)| {
                element_digest_for_observed(candidate, current.window_bounds)
            });
        if current_digest.as_deref() != Some(element.digest.as_str()) {
            return Err((-32001, "element_changed"));
        }
        if action == "select_text" {
            return select_text(hwnd.0 as isize, element, value, verification);
        }
        let uia = automation()?;
        let root = unsafe {
            uia.ElementFromHandle(hwnd)
                .map_err(|_| (-32001, "uia_element_unavailable"))?
        };
        let condition = unsafe {
            uia.CreateTrueCondition()
                .map_err(|_| (-32001, "uia_condition_failed"))?
        };
        let all = unsafe {
            root.FindAll(TreeScope_Descendants, &condition)
                .map_err(|_| (-32001, "uia_observe_failed"))?
        };
        let count = unsafe { all.Length().unwrap_or(0).min(MAX_ELEMENTS as i32) };
        for i in 0..count {
            let Ok(el) = (unsafe { all.GetElement(i) }) else {
                continue;
            };
            let aid = unsafe { el.CurrentAutomationId().map(text).unwrap_or_default() };
            let name = unsafe { el.CurrentName().map(text).unwrap_or_default() };
            let ct = unsafe { el.CurrentControlType().map(|x| x.0).unwrap_or_default() };
            let rid = runtime_id(&el);
            // RuntimeId is the provider's identity for an element instance.
            // Never rematch a replacement by name, index, or automation id.
            if element.runtime_id.is_empty() || rid.is_empty() || rid != element.runtime_id {
                continue;
            }
            if aid != element.automation_id || name != element.name || ct != element.control_type {
                continue;
            }
            if unsafe { !el.CurrentIsEnabled().map(|x| x.as_bool()).unwrap_or(false) } {
                return Err((-32001, "element_disabled"));
            }
            if action == "set_value" {
                if unsafe { el.CurrentIsPassword().map(|x| x.as_bool()).unwrap_or(true) } {
                    return Err((-32001, "password_field_refused"));
                }
                let pattern = unsafe {
                    el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                        .map_err(|_| (-32001, "element_not_actionable"))?
                };
                if unsafe {
                    pattern
                        .CurrentIsReadOnly()
                        .map(|x| x.as_bool())
                        .unwrap_or(true)
                } {
                    return Err((-32001, "value_pattern_readonly"));
                }
                let same_identity = || {
                    let snapshot = verification.snapshot;
                    identity(snapshot.hwnd)
                        .map(|current| {
                            current.pid == snapshot.pid
                                && current.start_time == snapshot.start_time
                                && current.generation == snapshot.generation
                        })
                        .unwrap_or(false)
                        && runtime_id(&el) == element.runtime_id
                };
                if !same_identity() {
                    return Err((-32001, "stale_target_revalidate_failed"));
                }
                if verification.cancelled.load(Ordering::Acquire) {
                    return Ok(("refused", "cancelled_before_dispatch"));
                }
                let input: BSTR = value.into();
                if unsafe { pattern.SetValue(&input) }.is_err() {
                    // The provider might have mutated before returning an error.
                    return Ok(("unknown", "set_value_failed_after_dispatch"));
                }
                let report = readback::run(
                    || {
                        if !same_identity() {
                            return Err("readback_identity_changed");
                        }
                        let password = unsafe { el.CurrentIsPassword() }
                            .map_err(|_| "readback_unavailable")?;
                        if password.as_bool() {
                            return Err("readback_password_field_refused");
                        }
                        let fresh = unsafe {
                            el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                        }
                        .map_err(|_| "readback_unavailable")?;
                        let actual =
                            unsafe { fresh.CurrentValue() }.map_err(|_| "readback_unavailable")?;
                        let actual =
                            String::try_from(actual).map_err(|_| "readback_unavailable")?;
                        if actual.chars().count() > MAX_TEXT {
                            return Err("readback_value_too_long");
                        }
                        if !same_identity() {
                            return Err("readback_identity_changed");
                        }
                        if unsafe { el.CurrentIsPassword() }
                            .map_err(|_| "readback_unavailable")?
                            .as_bool()
                        {
                            return Err("readback_password_field_refused");
                        }
                        Ok(actual == value)
                    },
                    || verification.cancelled.load(Ordering::Acquire),
                );
                let outcome = (report.status, report.verification);
                *verification.report = Some(json!(report));
                return Ok(outcome);
            }
            if action == "select" {
                let pattern = unsafe {
                    el.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                        UIA_SelectionItemPatternId,
                    )
                    .map_err(|_| (-32001, "selection_item_pattern_unavailable"))?
                };
                unsafe {
                    pattern.Select().map_err(|_| (-32001, "select_failed"))?;
                }
                let selected = unsafe {
                    pattern
                        .CurrentIsSelected()
                        .map(|x| x.as_bool())
                        .unwrap_or(false)
                };
                return if selected {
                    Ok(("verified", "selection_readback_selected"))
                } else {
                    Ok(("unknown", "selection_readback_mismatch"))
                };
            }
            if action == "toggle" {
                let pattern = unsafe {
                    el.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
                        .map_err(|_| (-32001, "toggle_pattern_unavailable"))?
                };
                let before = unsafe {
                    pattern
                        .CurrentToggleState()
                        .map_err(|_| (-32001, "toggle_state_unavailable"))?
                };
                unsafe {
                    pattern.Toggle().map_err(|_| (-32001, "toggle_failed"))?;
                }
                let after = unsafe {
                    pattern
                        .CurrentToggleState()
                        .map_err(|_| (-32001, "toggle_readback_unavailable"))?
                };
                return if after != before {
                    Ok(("verified", "toggle_state_readback_changed"))
                } else {
                    Ok(("unknown", "toggle_state_unchanged_after_action"))
                };
            }
            if action == "scroll" {
                let pattern = match unsafe {
                    el.GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId)
                } {
                    Ok(p) => p,
                    Err(_) => return Ok(("refused", "scroll_pattern_unavailable")),
                };
                let percent = |p: &IUIAutomationScrollPattern| unsafe {
                    if direction == "horizontal" {
                        p.CurrentHorizontalScrollPercent()
                    } else {
                        p.CurrentVerticalScrollPercent()
                    }
                };
                let scrollable = |p: &IUIAutomationScrollPattern| unsafe {
                    if direction == "horizontal" {
                        p.CurrentHorizontallyScrollable()
                    } else {
                        p.CurrentVerticallyScrollable()
                    }
                };
                let (before, can_scroll) = match (percent(&pattern), scrollable(&pattern)) {
                    (Ok(before), Ok(can_scroll)) => (before, can_scroll.as_bool()),
                    _ => return Ok(("refused", "scroll_state_unavailable")),
                };
                if let Some(reason) = scroll_readback::preflight(before, can_scroll, amount) {
                    return Ok(("refused", reason));
                }
                let same_identity = || {
                    let snapshot = verification.snapshot;
                    identity(snapshot.hwnd)
                        .map(|current| {
                            current.pid == snapshot.pid
                                && current.start_time == snapshot.start_time
                                && current.generation == snapshot.generation
                        })
                        .unwrap_or(false)
                        && !element.runtime_id.is_empty()
                        && runtime_id(&el) == element.runtime_id
                };
                if !same_identity() {
                    return Ok(("refused", "stale_target_revalidate_failed"));
                }
                if verification.cancelled.load(Ordering::Acquire) {
                    return Ok(("refused", "cancelled_before_dispatch"));
                }
                let scroll = match amount {
                    "small_increment" => ScrollAmount_SmallIncrement,
                    "small_decrement" => ScrollAmount_SmallDecrement,
                    "large_increment" => ScrollAmount_LargeIncrement,
                    "large_decrement" => ScrollAmount_LargeDecrement,
                    _ => return Ok(("refused", "scroll_no_amount")),
                };
                if unsafe {
                    pattern.Scroll(
                        if direction == "horizontal" {
                            scroll
                        } else {
                            ScrollAmount_NoAmount
                        },
                        if direction == "vertical" {
                            scroll
                        } else {
                            ScrollAmount_NoAmount
                        },
                    )
                }
                .is_err()
                {
                    return Ok(("unknown", "scroll_failed_after_dispatch"));
                }
                let report = scroll_readback::run(
                    before,
                    direction,
                    amount,
                    || {
                        if !same_identity() {
                            return Err("readback_identity_changed");
                        }
                        let fresh = unsafe {
                            el.GetCurrentPatternAs::<IUIAutomationScrollPattern>(
                                UIA_ScrollPatternId,
                            )
                        }
                        .map_err(|_| "scroll_readback_unavailable")?;
                        if !scrollable(&fresh)
                            .map_err(|_| "scroll_readback_unavailable")?
                            .as_bool()
                        {
                            return Err("scroll_readback_axis_not_scrollable");
                        }
                        let after = percent(&fresh).map_err(|_| "scroll_readback_unavailable")?;
                        if !same_identity() {
                            return Err("readback_identity_changed");
                        }
                        Ok(after)
                    },
                    || verification.cancelled.load(Ordering::Acquire),
                );
                let outcome = (report.status, report.verification);
                *verification.report = Some(json!(report));
                return Ok(outcome);
            }
            if let Ok(pattern) = unsafe {
                el.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                    UIA_SelectionItemPatternId,
                )
            } {
                unsafe {
                    pattern.Select().map_err(|_| (-32001, "select_failed"))?;
                }
                return Ok(("verified", "selection_action_result"));
            }
            if let Ok(pattern) =
                unsafe { el.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId) }
            {
                unsafe {
                    pattern.Toggle().map_err(|_| (-32001, "toggle_failed"))?;
                }
                return Ok(("verified", "toggle_action_result"));
            }
            let pattern = unsafe {
                el.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                    .map_err(|_| (-32001, "element_not_actionable"))?
            };
            unsafe {
                pattern.Invoke().map_err(|_| (-32001, "invoke_failed"))?;
            }
            return Ok(("verified", "invoke_action_result"));
        }
        Err((-32001, "element_changed"))
    }

    fn named_key_virtual_key(key: &str) -> Option<u16> {
        Some(match key {
            "Return" => 0x0d,
            "Tab" => 0x09,
            "Space" => 0x20,
            "Escape" => 0x1b,
            "Backspace" => 0x08,
            "ForwardDelete" => 0x2e,
            "Up" => 0x26,
            "Down" => 0x28,
            "Left" => 0x25,
            "Right" => 0x27,
            "Home" => 0x24,
            "End" => 0x23,
            "PageUp" => 0x21,
            "PageDown" => 0x22,
            "F1" => 0x70,
            "F2" => 0x71,
            "F3" => 0x72,
            "F4" => 0x73,
            "F5" => 0x74,
            "F6" => 0x75,
            "F7" => 0x76,
            "F8" => 0x77,
            "F9" => 0x78,
            "F10" => 0x79,
            "F11" => 0x7a,
            "F12" => 0x7b,
            _ => return None,
        })
    }

    fn modifier_virtual_key(modifier: &str) -> Option<u16> {
        Some(match modifier {
            "command" => 0x5b, // VK_LWIN
            "shift" => 0xa0,   // VK_LSHIFT
            "option" => 0xa4,  // VK_LMENU
            "control" => 0xa2, // VK_LCONTROL
            // Windows has no stable virtual-key equivalent for a hardware Fn
            // layer. Refusing it is safer than silently dropping the modifier.
            _ => return None,
        })
    }

    fn printable_key(key: &str) -> bool {
        let mut chars = key.chars();
        matches!(chars.next(), Some(value) if value.is_ascii() && value.is_ascii_graphic())
            && chars.next().is_none()
    }

    pub fn validate_key(key: &str, modifiers: &[String]) -> Result<(), (i32, &'static str)> {
        if named_key_virtual_key(key).is_none() && !printable_key(key) {
            return Err((-32001, "key_unsupported"));
        }
        if modifiers
            .iter()
            .any(|modifier| modifier_virtual_key(modifier).is_none())
        {
            return Err((-32001, "modifier_unsupported"));
        }
        Ok(())
    }

    fn unicode_input(code_unit: u16, key_up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: code_unit,
                    dwFlags: if key_up {
                        KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
                    } else {
                        KEYEVENTF_UNICODE
                    },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn vk_input(key: u16, key_up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(key),
                    wScan: 0,
                    dwFlags: if key_up {
                        KEYEVENTF_KEYUP
                    } else {
                        Default::default()
                    },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn key_inputs(key: &str, modifiers: &[String]) -> Result<Vec<INPUT>, (i32, &'static str)> {
        validate_key(key, modifiers)?;
        let mut inputs = Vec::with_capacity(modifiers.len() * 2 + 2);
        for modifier in modifiers {
            inputs.push(vk_input(
                modifier_virtual_key(modifier).ok_or((-32001, "modifier_unsupported"))?,
                false,
            ));
        }
        if let Some(virtual_key) = named_key_virtual_key(key) {
            inputs.push(vk_input(virtual_key, false));
            inputs.push(vk_input(virtual_key, true));
        } else {
            let code_unit = key
                .encode_utf16()
                .next()
                .ok_or((-32001, "key_unsupported"))?;
            inputs.push(unicode_input(code_unit, false));
            inputs.push(unicode_input(code_unit, true));
        }
        for modifier in modifiers.iter().rev() {
            inputs.push(vk_input(
                modifier_virtual_key(modifier).ok_or((-32001, "modifier_unsupported"))?,
                true,
            ));
        }
        Ok(inputs)
    }

    /// Dispatch a protocol key only after rebuilding its quoted UIA focus
    /// binding. `require` never changes focus; `acquire` may focus the named
    /// element, but both policies require the exact target HWND to be in the
    /// foreground immediately before SendInput.
    pub fn dispatch_key(
        hwnd: isize,
        element: ElementRef,
        key: &str,
        modifiers: &[String],
        focus_policy: &str,
        verification: VerificationContext<'_>,
    ) -> Result<(&'static str, &'static str), (i32, &'static str)> {
        validate_key(key, modifiers)?;
        let hwnd = HWND(hwnd as *mut _);
        if unsafe { !IsWindow(Some(hwnd)).as_bool() }
            || unsafe { GetAncestor(hwnd, GA_ROOT) } != hwnd
        {
            return Ok(("refused", "target_not_top_level_window"));
        }
        let current = identity(hwnd.0 as isize)?;
        if current.pid != verification.snapshot.pid
            || current.start_time != verification.snapshot.start_time
            || current.generation != verification.snapshot.generation
        {
            return Ok(("refused", "stale_target_revalidate_failed"));
        }
        let uia = automation()?;
        let root = unsafe {
            uia.ElementFromHandle(hwnd)
                .map_err(|_| (-32001, "uia_element_unavailable"))?
        };
        let condition = unsafe {
            uia.CreateTrueCondition()
                .map_err(|_| (-32001, "uia_condition_failed"))?
        };
        let all = unsafe {
            root.FindAll(TreeScope_Descendants, &condition)
                .map_err(|_| (-32001, "uia_observe_failed"))?
        };
        let count = unsafe { all.Length().unwrap_or(0).min(MAX_ELEMENTS as i32) };
        let mut target = None;
        for index in 0..count {
            let Ok(candidate) = (unsafe { all.GetElement(index) }) else {
                continue;
            };
            if runtime_id(&candidate) != element.runtime_id
                || unsafe {
                    candidate
                        .CurrentAutomationId()
                        .map(text)
                        .unwrap_or_default()
                } != element.automation_id
                || unsafe { candidate.CurrentName().map(text).unwrap_or_default() } != element.name
                || unsafe {
                    candidate
                        .CurrentControlType()
                        .map(|value| value.0)
                        .unwrap_or_default()
                } != element.control_type
                || !unsafe {
                    candidate
                        .CurrentIsEnabled()
                        .map(|value| value.as_bool())
                        .unwrap_or(false)
                }
            {
                continue;
            }
            target = Some(candidate);
            break;
        }
        let target = target.ok_or((-32001, "element_changed"))?;
        if focus_policy == "acquire" {
            if unsafe { target.SetFocus() }.is_err() {
                let native = unsafe { target.CurrentNativeWindowHandle().ok() };
                if let Some(native) = native {
                    let _ = unsafe {
                        windows::Win32::UI::Input::KeyboardAndMouse::SetFocus(Some(native))
                    };
                }
            }
            if !unsafe { SetForegroundWindow(hwnd).as_bool() }
                || unsafe { GetForegroundWindow() } != hwnd
            {
                return Ok(("refused", "foreground_mismatch"));
            }
        } else if unsafe { GetForegroundWindow() } != hwnd {
            return Ok(("refused", "foreground_mismatch"));
        }
        let focused = unsafe {
            uia.GetFocusedElement()
                .map_err(|_| (-32001, "focus_unavailable"))?
        };
        if runtime_id(&focused) != element.runtime_id {
            return Ok(("refused", "focused_element_mismatch"));
        }
        if verification.cancelled.load(Ordering::Acquire) {
            return Ok(("refused", "cancelled_before_dispatch"));
        }
        if unsafe { GetForegroundWindow() } != hwnd {
            return Ok(("refused", "foreground_mismatch"));
        }
        let current = identity(hwnd.0 as isize)?;
        if current.pid != verification.snapshot.pid
            || current.start_time != verification.snapshot.start_time
            || current.generation != verification.snapshot.generation
        {
            return Ok(("refused", "stale_target_revalidate_failed"));
        }
        let inputs = key_inputs(key, modifiers)?;
        let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent != inputs.len() as u32 {
            return Ok(("unknown", "send_input_partial_or_failed"));
        }
        match identity(hwnd.0 as isize) {
            Ok(current)
                if current.pid == verification.snapshot.pid
                    && current.start_time == verification.snapshot.start_time
                    && current.generation == verification.snapshot.generation => {}
            _ => return Ok(("unknown", "post_dispatch_target_changed")),
        }
        // A successful SendInput call proves delivery to the foreground input
        // queue, not the application-level effect. Without an app-specific
        // oracle, especially for Enter, keep the outcome unknown.
        Ok(("unknown", "key_readback_unavailable"))
    }

    /// Explicit compatibility input. This is intentionally separate from the
    /// semantic pattern path: it never accepts coordinates, clipboard text,
    /// PostMessage, or an implicit Enter fallback. The caller has already
    /// spent the snapshot and authorization before entering this function.
    #[allow(clippy::too_many_arguments)]
    #[cfg(test)]
    pub fn compat_input(
        hwnd: isize,
        element: ElementRef,
        op: &str,
        payload: &str,
        expected_pid: u32,
        expected_start_time: u64,
        expected_generation: &str,
        cancelled: &AtomicBool,
        report: &mut Option<Value>,
    ) -> Result<(&'static str, &'static str), (i32, &'static str)> {
        if !matches!(op, "compat_type_text" | "compat_press_enter") {
            return Err((-32602, "compat_unsupported"));
        }
        if op == "compat_type_text"
            && (payload.chars().count() > MAX_TEXT || payload.chars().any(char::is_control))
        {
            return Err((-32602, "compat_payload_invalid"));
        }
        let hwnd = HWND(hwnd as *mut _);
        if unsafe { !IsWindow(Some(hwnd)).as_bool() }
            || unsafe { GetAncestor(hwnd, GA_ROOT) } != hwnd
        {
            return Ok(("refused", "target_not_top_level_window"));
        }
        if !unsafe { SetForegroundWindow(hwnd).as_bool() }
            || unsafe { GetForegroundWindow() } != hwnd
        {
            return Ok(("refused", "foreground_mismatch"));
        }
        let uia = automation()?;
        let root = unsafe {
            uia.ElementFromHandle(hwnd)
                .map_err(|_| (-32001, "uia_element_unavailable"))?
        };
        let condition = unsafe {
            uia.CreateTrueCondition()
                .map_err(|_| (-32001, "uia_condition_failed"))?
        };
        let all = unsafe {
            root.FindAll(TreeScope_Descendants, &condition)
                .map_err(|_| (-32001, "uia_observe_failed"))?
        };
        let count = unsafe { all.Length().unwrap_or(0).min(MAX_ELEMENTS as i32) };
        let mut target = None;
        for i in 0..count {
            let Ok(candidate) = (unsafe { all.GetElement(i) }) else {
                continue;
            };
            if runtime_id(&candidate) != element.runtime_id
                || unsafe {
                    candidate
                        .CurrentAutomationId()
                        .map(text)
                        .unwrap_or_default()
                } != element.automation_id
                || unsafe { candidate.CurrentName().map(text).unwrap_or_default() } != element.name
                || unsafe {
                    candidate
                        .CurrentControlType()
                        .map(|x| x.0)
                        .unwrap_or_default()
                } != element.control_type
                || !unsafe {
                    candidate
                        .CurrentIsEnabled()
                        .map(|x| x.as_bool())
                        .unwrap_or(false)
                }
            {
                continue;
            }
            target = Some(candidate);
            break;
        }
        let target = target.ok_or((-32001, "element_changed"))?;
        // UIA SetFocus is the element-level focus request; the Win32 call is
        // retained for classic controls whose provider does not implement it.
        if unsafe { target.SetFocus() }.is_err() {
            let native = unsafe { target.CurrentNativeWindowHandle().ok() };
            let _ = unsafe { windows::Win32::UI::Input::KeyboardAndMouse::SetFocus(native) };
        }
        let focused =
            unsafe { uia.GetFocusedElement() }.map_err(|_| (-32001, "compat_focus_refused"))?;
        if runtime_id(&focused) != element.runtime_id {
            return Ok(("refused", "focused_element_mismatch"));
        }
        let mut inputs = Vec::new();
        if op == "compat_type_text" {
            for code_unit in payload.encode_utf16() {
                inputs.push(unicode_input(code_unit, false));
                inputs.push(unicode_input(code_unit, true));
            }
        } else {
            inputs.push(vk_input(0x0d, false));
            inputs.push(vk_input(0x0d, true));
        }
        // Final checks immediately before SendInput.  These checks reduce the
        // focus/identity race window but cannot make OS input dispatch atomic;
        // any post-dispatch identity change is therefore reported unknown.
        if unsafe { GetForegroundWindow() } != hwnd {
            return Ok(("refused", "foreground_mismatch"));
        }
        let current = identity(hwnd.0 as isize)?;
        if current.pid != expected_pid
            || current.start_time != expected_start_time
            || current.generation != expected_generation
        {
            return Ok(("refused", "stale_target_revalidate_failed"));
        }
        let focused =
            unsafe { uia.GetFocusedElement() }.map_err(|_| (-32001, "compat_focus_refused"))?;
        if runtime_id(&focused) != element.runtime_id {
            return Ok(("refused", "focused_element_mismatch"));
        }
        if unsafe { GetForegroundWindow() } != hwnd {
            return Ok(("refused", "foreground_mismatch"));
        }
        let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent != inputs.len() as u32 {
            return Ok(("unknown", "send_input_partial_or_failed"));
        }
        match identity(hwnd.0 as isize) {
            Ok(current)
                if current.pid == expected_pid
                    && current.start_time == expected_start_time
                    && current.generation == expected_generation => {}
            _ => return Ok(("unknown", "post_dispatch_target_changed")),
        }
        if op == "compat_type_text" {
            let same_identity = || {
                identity(hwnd.0 as isize)
                    .map(|current| {
                        current.pid == expected_pid
                            && current.start_time == expected_start_time
                            && current.generation == expected_generation
                    })
                    .unwrap_or(false)
                    && runtime_id(&target) == element.runtime_id
            };
            let value_report = readback::run(
                || {
                    if !same_identity() {
                        return Err("readback_identity_changed");
                    }
                    if unsafe { target.CurrentIsPassword() }
                        .map_err(|_| "readback_unavailable")?
                        .as_bool()
                    {
                        return Err("readback_password_field_refused");
                    }
                    let pattern = unsafe {
                        target.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                    }
                    .map_err(|_| "readback_unavailable")?;
                    let actual = unsafe { pattern.CurrentValue() }
                        .map_err(|_| "readback_unavailable")
                        .map(text)?;
                    if actual.chars().count() > MAX_TEXT {
                        return Err("readback_value_too_long");
                    }
                    if !same_identity() {
                        return Err("readback_identity_changed");
                    }
                    Ok(actual == payload)
                },
                || cancelled.load(Ordering::Acquire),
            );
            let status = value_report.status;
            let verification = value_report.verification;
            *report = Some(
                serde_json::to_value(value_report).map_err(|_| (-32001, "readback_unavailable"))?,
            );
            return Ok((status, verification));
        }
        Ok(("unknown", "enter_readback_unavailable"))
    }

    pub fn capture(params: Value) -> Result<Value, (i32, &'static str)> {
        let hwnd = params
            .get("hwnd")
            .and_then(Value::as_i64)
            .ok_or((-32602, "missing_hwnd"))?;
        let hwnd = HWND(hwnd as *mut _);
        if unsafe { !IsWindow(Some(hwnd)).as_bool() } {
            return Ok(json!({"status":"unavailable","path":"none","reason":"target_window_gone"}));
        }
        let expected = params
            .get("windowGeneration")
            .and_then(Value::as_str)
            .ok_or((-32602, "missing_window_generation"))?;
        let actual = identity(hwnd.0 as isize)?;
        if actual.generation != expected {
            return Ok(
                json!({"status":"unavailable","path":"none","reason":"stale_target_window_generation"}),
            );
        }
        let started = Instant::now();
        match capture_wgc(hwnd) {
            Ok((width, height, png)) => Ok(
                json!({"status":"available","path":"wgc_createforwindow","frame":{"width":width,"height":height,"bytes":png.len(),"format":"png","base64":base64::engine::general_purpose::STANDARD.encode(png),"elapsedMs":started.elapsed().as_millis()}}),
            ),
            Err(reason) => Ok(
                json!({"status":"unavailable","path":"none","reason":format!("capture_unavailable:{reason}")}),
            ),
        }
    }

    pub fn capture_display(display_id: Option<&str>) -> Result<Value, (i32, &'static str)> {
        let displays = displays()?;
        let selected = match display_id {
            Some(requested) => displays
                .iter()
                .find(|display| display.get("displayId").and_then(Value::as_str) == Some(requested))
                .ok_or((-32602, "display_not_found"))?,
            None => displays
                .first()
                .ok_or((-32001, "display_inventory_unavailable"))?,
        };
        let id = selected
            .get("displayId")
            .and_then(Value::as_str)
            .ok_or((-32001, "display_inventory_unavailable"))?;
        let monitor = id
            .strip_prefix("monitor:")
            .and_then(|value| usize::from_str_radix(value, 16).ok())
            .ok_or((-32001, "display_inventory_unavailable"))?;
        let started = Instant::now();
        match capture_wgc_monitor(HMONITOR(monitor as *mut _)) {
            Ok((width, height, png)) => Ok(json!({
                "status":"available",
                "path":"wgc_createmonitor",
                "displayId":id,
                "frame":{"width":width,"height":height,"bytes":png.len(),"format":"png","base64":base64::engine::general_purpose::STANDARD.encode(png),"elapsedMs":started.elapsed().as_millis()}
            })),
            Err(reason) => Ok(json!({
                "status":"unavailable",
                "path":"none",
                "displayId":id,
                "reason":format!("capture_unavailable:{reason}")
            })),
        }
    }

    fn capture_wgc_monitor(monitor: HMONITOR) -> Result<(i32, i32, Vec<u8>), &'static str> {
        unsafe {
            let _ = RoInitialize(RO_INIT_MULTITHREADED);
        }
        let class = HSTRING::from("Windows.Graphics.Capture.GraphicsCaptureItem");
        let interop: IGraphicsCaptureItemInterop =
            unsafe { RoGetActivationFactory(&class).map_err(|_| "activation_factory")? };
        let item: GraphicsCaptureItem = unsafe {
            interop
                .CreateForMonitor(monitor)
                .map_err(|_| "create_for_monitor")?
        };
        capture_wgc_item(item)
    }

    fn capture_wgc(hwnd: HWND) -> Result<(i32, i32, Vec<u8>), &'static str> {
        unsafe {
            let _ = RoInitialize(RO_INIT_MULTITHREADED);
        }
        let class = HSTRING::from("Windows.Graphics.Capture.GraphicsCaptureItem");
        let interop: IGraphicsCaptureItemInterop =
            unsafe { RoGetActivationFactory(&class).map_err(|_| "activation_factory")? };
        let item: GraphicsCaptureItem = unsafe {
            interop
                .CreateForWindow(hwnd)
                .map_err(|_| "create_for_window")?
        };
        capture_wgc_item(item)
    }

    fn capture_wgc_item(item: GraphicsCaptureItem) -> Result<(i32, i32, Vec<u8>), &'static str> {
        let size = item.Size().map_err(|_| "capture_size")?;
        if size.Width <= 0
            || size.Height <= 0
            || (size.Width as i64 * size.Height as i64) > MAX_CAPTURE_PIXELS
        {
            return Err("capture_dimensions");
        }
        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                Default::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
            .map_err(|_| "d3d11_device")?;
        }
        let device = device.ok_or("d3d11_device_null")?;
        let context = context.ok_or("d3d11_context_null")?;
        let dxgi: IDXGIDevice = device.cast().map_err(|_| "dxgi_device")?;
        let inspectable =
            unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi).map_err(|_| "winrt_device")? };
        let d3d_device: IDirect3DDevice = inspectable.cast().map_err(|_| "direct3d_device")?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &d3d_device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            2,
            SizeInt32 {
                Width: size.Width,
                Height: size.Height,
            },
        )
        .map_err(|_| "frame_pool")?;
        let session = pool
            .CreateCaptureSession(&item)
            .map_err(|_| "capture_session")?;
        session.StartCapture().map_err(|_| "start_capture")?;
        let deadline = Instant::now() + Duration::from_millis(3_000);
        let frame = loop {
            if let Ok(frame) = pool.TryGetNextFrame() {
                break frame;
            }
            if Instant::now() >= deadline {
                return Err("frame_timeout");
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let surface = frame.Surface().map_err(|_| "frame_surface")?;
        let unknown: IUnknown = surface.cast().map_err(|_| "surface_unknown")?;
        let mut access_ptr = core::ptr::null_mut();
        unsafe {
            unknown
                .query(&IID_IDIRECT3D_DXGI_INTERFACE_ACCESS, &mut access_ptr)
                .ok()
                .map_err(|_| "surface_access")?;
        }
        let access_vtbl = unsafe { *(access_ptr as *mut *mut DxgiInterfaceAccessVtbl) };
        let mut source_ptr = core::ptr::null_mut();
        unsafe {
            ((*access_vtbl).get_interface)(access_ptr, &ID3D11Texture2D::IID, &mut source_ptr)
                .ok()
                .map_err(|_| "surface_texture")?;
        }
        let source: ID3D11Texture2D = unsafe { ID3D11Texture2D::from_raw(source_ptr) };
        let desc = D3D11_TEXTURE2D_DESC {
            Width: size.Width as u32,
            Height: size.Height as u32,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut staging: Option<ID3D11Texture2D> = None;
        unsafe {
            device
                .CreateTexture2D(&desc, None, Some(&mut staging))
                .map_err(|_| "staging_texture")?;
        }
        let staging = staging.ok_or("staging_texture_null")?;
        unsafe {
            context.CopyResource(&staging, &source);
        }
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe {
            context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .map_err(|_| "map_texture")?;
        }
        let row_bytes = (size.Width as usize)
            .checked_mul(4)
            .ok_or("capture_overflow")?;
        let total = row_bytes
            .checked_mul(size.Height as usize)
            .ok_or("capture_overflow")?;
        let mut bgra = vec![0u8; total];
        for y in 0..size.Height as usize {
            unsafe {
                core::ptr::copy_nonoverlapping(
                    mapped.pData.add(y * mapped.RowPitch as usize),
                    bgra.as_mut_ptr().add(y * row_bytes) as *mut _,
                    row_bytes,
                );
            }
        }
        unsafe {
            context.Unmap(&staging, 0);
        }
        let png = encode_png_bgra(&bgra, size.Width as usize, size.Height as usize);
        if png.len() > MAX_CAPTURE_PNG_BYTES {
            return Err("png_too_large");
        }
        Ok((size.Width, size.Height, png))
    }

    fn encode_png_bgra(bgra: &[u8], width: usize, height: usize) -> Vec<u8> {
        let mut raw = Vec::with_capacity((width * 4 + 1) * height);
        for y in 0..height {
            raw.push(0);
            for x in 0..width {
                let i = (y * width + x) * 4;
                raw.extend_from_slice(&[bgra[i + 2], bgra[i + 1], bgra[i], bgra[i + 3]]);
            }
        }
        let mut compressed = ZlibEncoder::new(Vec::new(), Compression::fast());
        compressed.write_all(&raw).expect("memory write");
        let compressed = compressed.finish().expect("memory finish");
        let mut png = vec![137, 80, 78, 71, 13, 10, 26, 10];
        png_chunk(
            &mut png,
            b"IHDR",
            &[
                ((width >> 24) & 255) as u8,
                (width >> 16) as u8,
                (width >> 8) as u8,
                width as u8,
                ((height >> 24) & 255) as u8,
                (height >> 16) as u8,
                (height >> 8) as u8,
                height as u8,
                8,
                6,
                0,
                0,
                0,
            ],
        );
        png_chunk(&mut png, b"IDAT", &compressed);
        png_chunk(&mut png, b"IEND", &[]);
        png
    }
    fn png_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        let mut crc = 0xffff_ffffu32;
        for b in kind.iter().chain(data) {
            crc ^= *b as u32;
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    (crc >> 1) ^ 0xedb88320
                } else {
                    crc >> 1
                };
            }
        }
        out.extend_from_slice(&(!crc).to_be_bytes());
    }
}
