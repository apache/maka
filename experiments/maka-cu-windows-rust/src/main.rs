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
//! comparison.  The transport is line-delimited JSON-RPC 2.0 and is kept
//! private to this experiment.  On Windows the UIA calls are made through the
//! IUIAutomation COM interfaces (there is no managed/UIA wrapper).
//!
//! Security properties shared with the C# spike:
//! * only an explicitly supplied HWND is observed or captured;
//! * every observation mints opaque, one-use element tokens;
//! * mutation spends the token before dispatch and revalidates HWND/PID and
//!   the element identity; and
//! * no foreground, SendInput, PostMessage, coordinate or screen fallback is
//!   present in this executable.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::Once;
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
mod readback;
mod scroll_readback;

const PROTOCOL: &str = "maka.cu.windows/0";
const MAX_ELEMENTS: usize = 512;
const MAX_SNAPSHOTS: usize = 64;
const MAX_TEXT: usize = 1024;
const MAX_RESPONSE_BYTES: usize = 6 * 1024 * 1024;
const MAX_CAPTURE_PIXELS: i64 = 16_000_000;
const MAX_CAPTURE_PNG_BYTES: usize = 4 * 1024 * 1024;
const SHUTDOWN_GRACE_MS: u64 = 1_000;
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
    // Monotonic ids are used only for snapshot bookkeeping; compatibility
    // grants use OS-random GUIDs below and never derive tokens from this.
    next: AtomicU64,
    snapshots: HashMap<String, Snapshot>,
    compat_authorizations: HashMap<String, CompatAuthorization>,
}

#[derive(Debug, Clone)]
struct Snapshot {
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
}

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

    while !input_closed || !pending.is_empty() {
        while let Ok(result) = result_rx.try_recv() {
            pending.remove(&result.key);
            match result.result {
                Ok(value) => write_rpc(&mut out, result.id, Some(value), None),
                Err((code, message)) => write_rpc(&mut out, result.id, None, Some((code, message))),
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
    match method {
        "initialize" => Ok(initialize()),
        "list_windows" => platform::list_windows(),
        "observe" => observe(params, registry),
        "act" => act(params, registry, cancelled),
        "authorize_compat" => authorize_compat(params, registry),
        "capture" => platform::capture(params),
        "debug_sleep" => {
            let millis = params
                .get("ms")
                .and_then(Value::as_u64)
                .unwrap_or(100)
                .min(5_000);
            std::thread::sleep(Duration::from_millis(millis));
            Ok(json!({"sleptMs":millis,"provider":"worker"}))
        }
        _ => Err((-32601, "method_not_found")),
    }
}

fn initialize() -> Value {
    json!({
        "protocol": PROTOCOL,
        "executor": {"name":"maka-cu-windows-rust", "language":"rust-direct-com", "spikeStage":"comparison-v0"},
        "capabilities": {
        "observation": {"uia": true, "uiaBinding":"IUIAutomation COM", "wgc": true},
            "semanticActions": ["set_value", "click_element", "select", "toggle", "scroll"],
            "input": {"foreground":false,"globalPointer":false,"postMessage":false,"sendInput":false},
            "compatibilityInput": {"enabled":true,"default":"refused","ops":["compat_type_text","compat_press_enter"],"requiresAuthorization":true,"authorizationTtlMs":5000,"foregroundFocusConfirmed":true,"sendInput":"single_unicode_or_vk_return","readbackFailure":"unknown"},
            "capture": {"targetWindow":true,"targetWindowWgc":true,"screenRect":false}
        },
        "limits": {"maxElements":MAX_ELEMENTS,"maxSnapshots":MAX_SNAPSHOTS,"maxTextChars":MAX_TEXT,"maxResponseBytes":MAX_RESPONSE_BYTES,"shutdownGraceMs":SHUTDOWN_GRACE_MS},
        "deadlines": {"handshake":10,"request":20,"cancelGrace":2},
        "generation": helper_generation(),
        "signature":"none",
        "distributionReady":false,
        "runtime":"rust-native-windows"
    })
}

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
    for (index, element) in observed.elements.into_iter().enumerate().take(MAX_ELEMENTS) {
        let token = format!("e{:016x}", token_seed.wrapping_add(index as u64 + 1));
        elements.insert(
            token.clone(),
            ElementRef {
                automation_id: element.automation_id.clone(),
                name: element.name.clone(),
                control_type: element.control_type,
                runtime_id: element.runtime_id.clone(),
            },
        );
        rendered.push(json!({"token":token,"name":element.name,"automationId":element.automation_id,"controlType":element.control_type,"runtimeId":element.runtime_id,"patterns":element.patterns,"actions":element.actions,"isEnabled":element.is_enabled,"value":element.value,"scrollState":element.scroll_state}));
    }
    let element_count = rendered.len();
    registry.snapshots.insert(
        snapshot_id.clone(),
        Snapshot {
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
                object.insert("bounds".to_owned(), json!([0, 0, 0, 0]));
            }
            node
        })
        .collect::<Vec<_>>();
    Ok(
        json!({"snapshotId":snapshot_id,"protocol":PROTOCOL,"hwnd":hwnd,"pid":observed.pid,"windowGeneration":generation,"target":{"hwnd":hwnd,"pid":observed.pid,"processStartTimeUtc":format!("filetime:{}", observed.start_time),"windowGeneration":generation},"elements":rendered,"tree":{"rootToken":null,"nodeCount":element_count,"truncated":observed.truncated,"rawDescendantCount":observed.raw_descendant_count,"elapsedMs":observed.elapsed_ms,"nodes":nodes},"capture":{"path":"capture_rpc","status":"separate"}}),
    )
}

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

fn prune_expired_authorizations(registry: &mut Registry, now: Instant) {
    registry
        .compat_authorizations
        .retain(|_, authorization| authorization.expires_at > now);
}

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
    if matches!(action, "compat_type_text" | "compat_press_enter") {
        return compat_act(params, registry, cancelled);
    }
    if action == "press_enter" {
        return Ok(
            json!({"outcome":{"tier":"compatibility","path":"unsupported","status":"refused","reason":"unsupported_enter","effect":"none","snapshotSpent":false,"verification":"not_dispatched"}}),
        );
    }
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
}
#[derive(Debug)]
struct Observed {
    pid: u32,
    start_time: u64,
    generation: String,
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
    use windows::core::{IUnknown, Interface, GUID, HSTRING};
    use windows::core::{BOOL, BSTR};
    use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem};
    use windows::Graphics::DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat};
    use windows::Graphics::SizeInt32;
    use windows::Win32::Foundation::{CloseHandle, FILETIME, HWND, LPARAM};
    use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
    use windows::Win32::Graphics::Direct3D11::{
        D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
        D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE,
        D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
    };
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
    use windows::Win32::Graphics::Dxgi::IDXGIDevice;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Ole::{
        SafeArrayDestroy, SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound,
    };
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::System::WinRT::Direct3D11::CreateDirect3D11DeviceFromDXGIDevice;
    use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
    use windows::Win32::System::WinRT::{
        RoGetActivationFactory, RoInitialize, RO_INIT_MULTITHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationInvokePattern,
        IUIAutomationScrollItemPattern, IUIAutomationScrollPattern,
        IUIAutomationSelectionItemPattern, IUIAutomationTogglePattern, IUIAutomationValuePattern,
        ScrollAmount_LargeDecrement, ScrollAmount_LargeIncrement, ScrollAmount_NoAmount,
        ScrollAmount_SmallDecrement, ScrollAmount_SmallIncrement, TreeScope_Descendants,
        UIA_InvokePatternId, UIA_ScrollItemPatternId, UIA_ScrollPatternId,
        UIA_SelectionItemPatternId, UIA_TogglePatternId, UIA_ValuePatternId,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE,
        VIRTUAL_KEY, VK_RETURN,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetAncestor, GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
        IsWindow, IsWindowVisible, SetForegroundWindow, GA_ROOT,
    };
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
            windows
                .push(json!({"hwnd":hwnd.0 as isize,"pid":pid,"title":title,"isOffscreen":false}));
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
                });
            }
        }
        Ok(Observed {
            pid: ident.pid,
            start_time: ident.start_time,
            generation: ident.generation,
            elements,
            raw_descendant_count: raw_count,
            truncated,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
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

    /// Explicit compatibility input. This is intentionally separate from the
    /// semantic pattern path: it never accepts coordinates, clipboard text,
    /// PostMessage, or an implicit Enter fallback. The caller has already
    /// spent the snapshot and authorization before entering this function.
    #[allow(clippy::too_many_arguments)]
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
            inputs.push(vk_input(VK_RETURN, false));
            inputs.push(vk_input(VK_RETURN, true));
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

    fn vk_input(key: VIRTUAL_KEY, key_up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: key,
                    wScan: 0,
                    dwFlags: if key_up {
                        KEYEVENTF_KEYUP
                    } else {
                        KEYEVENTF_KEYUP & KEYEVENTF_UNICODE
                    },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
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
