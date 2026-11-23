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

use crate::plan::{
    CompactionOutput, FinishReason, HttpErrorSpec, MidStreamErrorSpec, NativeToolEvent,
    ToolCallSpec, TurnEvent, TurnPlan, Usage,
};
use crate::protocol::NormalizedRequest;
use crate::schema_synth::WirePoisonConfig;
use bytes::Bytes;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Execution context passed to handlers for every model turn.
#[derive(Debug, Clone)]
pub struct TurnContext {
    /// 1-based global turn index across the server since start/reset.
    pub global_turn: u64,
    /// 1-based turn index within `req.session_key`.
    pub session_turn: u64,
    /// Optional runtime chaos override injected by `DynamicProfileManager` (manual override or active phase).
    pub chaos_override: Option<crate::workload::ChaosConfig>,
}

/// Bounded per-session turn counter (prevents unbounded growth under 100k+ ephemeral sessions).
pub struct SessionTracker {
    max_sessions: usize,
    inner: Mutex<SessionTrackerInner>,
}

struct SessionTrackerInner {
    order: VecDeque<String>,
    turns: HashMap<String, u64>,
}

impl SessionTracker {
    pub fn new(max_sessions: usize) -> Self {
        Self {
            max_sessions,
            inner: Mutex::new(SessionTrackerInner {
                order: VecDeque::new(),
                turns: HashMap::new(),
            }),
        }
    }

    pub fn next_turn(&self, session_key: &str) -> u64 {
        let mut guard = self.inner.lock().unwrap();
        if let Some(count) = guard.turns.get_mut(session_key) {
            *count += 1;
            return *count;
        }
        while self.max_sessions > 0 && guard.order.len() >= self.max_sessions {
            if let Some(evicted) = guard.order.pop_front() {
                guard.turns.remove(&evicted);
            }
        }
        guard.order.push_back(session_key.to_owned());
        guard.turns.insert(session_key.to_owned(), 1);
        1
    }

    pub fn clear(&self) {
        let mut guard = self.inner.lock().unwrap();
        guard.order.clear();
        guard.turns.clear();
    }
}

/// Metadata configured on an interactive turn before sending its first event.
#[derive(Debug, Clone, Default)]
pub struct InteractiveMeta {
    pub response_id: Option<String>,
    pub model_override: Option<String>,
    pub response_headers: BTreeMap<String, String>,
    pub close_connection: bool,
    pub wire_poison: WirePoisonConfig,
}

/// Outcome returned by a `TurnHandler`: either a ready `TurnPlan` (zero channel overhead)
/// or an interactive event stream driven step-by-step by test code.
pub enum TurnDecision {
    Plan(TurnPlan),
    Interactive(InteractiveStream),
}

pub struct InteractiveStream {
    pub events: mpsc::UnboundedReceiver<TurnEvent>,
    pub meta: Arc<Mutex<InteractiveMeta>>,
    pub closed: CancellationToken,
}

pub type HandlerFuture<'a> = Pin<Box<dyn Future<Output = Option<TurnDecision>> + Send + 'a>>;

/// Core extensibility trait for deciding how the mock AI responds to a turn.
pub trait TurnHandler: Send + Sync {
    fn handle<'a>(&'a self, req: &'a NormalizedRequest, ctx: &'a TurnContext) -> HandlerFuture<'a>;

    /// Reset internal counters/state (called by `MockAiServer::reset()` and `POST /admin/reset`).
    fn reset(&self) {}
}

/// Handle handed to test code in interactive mode for frame-by-frame stream control.
pub struct TurnHandle {
    pub request: NormalizedRequest,
    pub context: TurnContext,
    tx: mpsc::UnboundedSender<TurnEvent>,
    meta: Arc<Mutex<InteractiveMeta>>,
    closed: CancellationToken,
}

impl TurnHandle {
    pub fn body(&self) -> &Value {
        &self.request.raw_body
    }

    pub fn headers(&self) -> &BTreeMap<String, String> {
        &self.request.headers
    }

    /// Set the wire response/message ID (must be called before sending the first event).
    pub fn set_response_id(&self, id: impl Into<String>) {
        self.meta.lock().unwrap().response_id = Some(id.into());
    }

    /// Override the echoed model name (must be called before sending the first event).
    pub fn set_model_override(&self, model: impl Into<String>) {
        self.meta.lock().unwrap().model_override = Some(model.into());
    }

    /// Attach an HTTP response header (must be called before sending the first event).
    pub fn set_header(&self, name: impl Into<String>, value: impl Into<String>) {
        self.meta
            .lock()
            .unwrap()
            .response_headers
            .insert(name.into(), value.into());
    }

    /// Force `Connection: close` on HTTP/1.1 (must be called before sending the first event).
    pub fn set_close_connection(&self, close: bool) {
        self.meta.lock().unwrap().close_connection = close;
    }

    /// Configure SSE framing poison for this turn (must be called before sending the first event).
    pub fn set_wire_poison(&self, poison: WirePoisonConfig) {
        self.meta.lock().unwrap().wire_poison = poison;
    }

    pub async fn send(&self, event: TurnEvent) -> bool {
        self.tx.send(event).is_ok()
    }

    pub async fn stream_start(&self) -> bool {
        self.send(TurnEvent::StreamStart).await
    }

    pub async fn flush_item(&self) -> bool {
        self.send(TurnEvent::Flush).await
    }

    pub async fn sse_comment(&self, comment: impl Into<String>) -> bool {
        self.send(TurnEvent::SseComment {
            comment: comment.into(),
        })
        .await
    }

    pub async fn delta(&self, text: impl Into<String>) -> bool {
        self.send(TurnEvent::Text {
            text: text.into(),
            chunk_chars: 0,
            citations: Vec::new(),
        })
        .await
    }

    pub async fn thinking(&self, text: impl Into<String>) -> bool {
        self.send(TurnEvent::Reasoning {
            text: text.into(),
            chunk_chars: 0,
            signature: Some("mock-thinking-sig".into()),
            encrypted_content: None,
        })
        .await
    }

    pub async fn reasoning_encrypted(
        &self,
        text: impl Into<String>,
        encrypted_content: impl Into<String>,
    ) -> bool {
        self.send(TurnEvent::Reasoning {
            text: text.into(),
            chunk_chars: 0,
            signature: None,
            encrypted_content: Some(encrypted_content.into()),
        })
        .await
    }

    pub async fn tool_call(
        &self,
        id: impl Into<String>,
        name: impl Into<String>,
        arguments: Value,
    ) -> bool {
        self.send(TurnEvent::ToolCall(ToolCallSpec::new(id, name, arguments)))
            .await
    }

    pub async fn custom_tool_call(
        &self,
        id: impl Into<String>,
        name: impl Into<String>,
        input: impl Into<String>,
    ) -> bool {
        self.send(TurnEvent::ToolCall(
            ToolCallSpec::new(id, name, Value::String(input.into())).as_custom_tool(),
        ))
        .await
    }

    pub async fn native_tool(&self, tool: NativeToolEvent) -> bool {
        self.send(TurnEvent::NativeTool(tool)).await
    }

    pub async fn native_compaction(&self, output: CompactionOutput) -> bool {
        self.send(TurnEvent::NativeCompaction(output)).await
    }

    pub async fn usage(&self, usage: Usage) -> bool {
        self.send(TurnEvent::Usage(usage)).await
    }

    pub async fn raw_json(&self, value: Value) -> bool {
        self.send(TurnEvent::RawJson { value }).await
    }

    pub async fn raw_bytes(&self, bytes: impl Into<Bytes>) -> bool {
        self.send(TurnEvent::RawBytes(bytes.into())).await
    }

    pub async fn http_error(self, spec: HttpErrorSpec) {
        let _ = self.tx.send(TurnEvent::HttpError(spec));
    }

    pub async fn mid_stream_error(self, spec: MidStreamErrorSpec) {
        let _ = self.tx.send(TurnEvent::MidStreamError(spec));
    }

    pub async fn drop_connection(self) {
        let _ = self.tx.send(TurnEvent::DropConnection);
    }

    pub async fn truncate_eof(self) {
        let _ = self.tx.send(TurnEvent::TruncateEof);
    }

    pub async fn stall(&self) {
        let _ = self.tx.send(TurnEvent::Stall);
    }

    pub async fn finish(self) {
        let _ = self.tx.send(TurnEvent::Finish {
            reason: FinishReason::Stop,
        });
    }

    pub async fn finish_with(self, reason: FinishReason) {
        let _ = self.tx.send(TurnEvent::Finish { reason });
    }

    /// Apply a complete `TurnPlan` to this interactive turn (metadata + all events + auto-finish if needed).
    /// Non-blocking: enqueues all events and releases the handle without waiting for the client to drain.
    pub fn send_plan(self, plan: TurnPlan) {
        let inferred_finish = plan.inferred_finish_reason();
        {
            let mut meta = self.meta.lock().unwrap();
            if let Some(id) = plan.response_id {
                meta.response_id = Some(id);
            }
            if let Some(model) = plan.model_override {
                meta.model_override = Some(model);
            }
            for (k, v) in plan.response_headers {
                meta.response_headers.insert(k, v);
            }
            if plan.close_connection {
                meta.close_connection = true;
            }
            if plan.wire_poison.is_active() {
                meta.wire_poison = plan.wire_poison;
            }
        }
        let mut has_terminal = false;
        // Pre-send Usage so Anthropic message_start gets exact token counts even if Usage was pushed late.
        for ev in &plan.events {
            if let TurnEvent::Usage(u) = ev {
                let _ = self.tx.send(TurnEvent::Usage(u.clone()));
                break;
            }
        }
        for ev in plan.events {
            if matches!(
                ev,
                TurnEvent::Finish { .. }
                    | TurnEvent::HttpError(_)
                    | TurnEvent::MidStreamError(_)
                    | TurnEvent::DropConnection
                    | TurnEvent::TruncateEof
                    | TurnEvent::Stall
            ) {
                has_terminal = true;
            }
            let _ = self.tx.send(ev);
        }
        if !has_terminal {
            let _ = self.tx.send(TurnEvent::Finish {
                reason: inferred_finish,
            });
        }
    }

    /// Convenience: reply with visible text + Finish(Stop).
    pub fn reply_text(self, text: impl Into<String>) {
        self.send_plan(TurnPlan::text(text));
    }

    /// Convenience: reply with visible text + explicit Usage + Finish(Stop).
    pub fn reply_text_with_usage(self, text: impl Into<String>, usage: Usage) {
        self.send_plan(
            TurnPlan::new()
                .with_usage(usage)
                .push_text(text)
                .finish(FinishReason::Stop),
        );
    }

    /// Convenience: reply with a single tool call + Finish(ToolCalls).
    pub fn reply_tool_call(self, id: impl Into<String>, name: impl Into<String>, arguments: Value) {
        self.send_plan(
            TurnPlan::new()
                .push_tool_call(id, name, arguments)
                .finish(FinishReason::ToolCalls),
        );
    }

    /// Clone the sticky token cancelled as soon as the server closes this turn's HTTP/WS stream.
    pub fn closed_signal(&self) -> CancellationToken {
        self.closed.clone()
    }

    /// Wait until the server finishes writing this turn or the client disconnects.
    /// Sticky and idempotent: returns immediately if already closed.
    pub async fn wait_closed(&self) {
        self.closed.cancelled().await;
    }
}

/// Interactive queue handler: pushes each incoming turn as a `TurnHandle` to the test driver.
pub struct InteractiveHandler {
    tx: mpsc::Sender<TurnHandle>,
}

impl InteractiveHandler {
    pub fn channel(request_capacity: usize) -> (Arc<Self>, mpsc::Receiver<TurnHandle>) {
        let (tx, rx) = mpsc::channel(request_capacity.max(1));
        (Arc::new(Self { tx }), rx)
    }

    pub fn with_event_buffer(
        request_capacity: usize,
        _event_capacity: usize,
    ) -> (Arc<Self>, mpsc::Receiver<TurnHandle>) {
        Self::channel(request_capacity)
    }
}

impl TurnHandler for InteractiveHandler {
    fn handle<'a>(&'a self, req: &'a NormalizedRequest, ctx: &'a TurnContext) -> HandlerFuture<'a> {
        let req_clone = req.clone();
        let ctx_clone = ctx.clone();
        Box::pin(async move {
            let (ev_tx, ev_rx) = mpsc::unbounded_channel();
            let meta = Arc::new(Mutex::new(InteractiveMeta::default()));
            let closed = CancellationToken::new();
            let handle = TurnHandle {
                request: req_clone,
                context: ctx_clone,
                tx: ev_tx,
                meta: meta.clone(),
                closed: closed.clone(),
            };
            if self.tx.send(handle).await.is_err() {
                return None;
            }
            Some(TurnDecision::Interactive(InteractiveStream {
                events: ev_rx,
                meta,
                closed,
            }))
        })
    }
}

/// FIFO queue of pre-scripted `TurnPlan`s with optional repeating fallback.
pub struct ScriptedHandler {
    initial: Vec<TurnPlan>,
    queue: Mutex<VecDeque<TurnPlan>>,
    fallback: Option<TurnPlan>,
}

impl ScriptedHandler {
    pub fn new(plans: impl IntoIterator<Item = TurnPlan>) -> Self {
        let initial: Vec<TurnPlan> = plans.into_iter().collect();
        let queue = VecDeque::from(initial.clone());
        Self {
            initial,
            queue: Mutex::new(queue),
            fallback: None,
        }
    }

    pub fn with_fallback(mut self, fallback: TurnPlan) -> Self {
        self.fallback = Some(fallback);
        self
    }

    pub fn push(&self, plan: TurnPlan) {
        self.queue.lock().unwrap().push_back(plan);
    }
}

impl TurnHandler for ScriptedHandler {
    fn handle<'a>(
        &'a self,
        _req: &'a NormalizedRequest,
        _ctx: &'a TurnContext,
    ) -> HandlerFuture<'a> {
        let plan = self
            .queue
            .lock()
            .unwrap()
            .pop_front()
            .or_else(|| self.fallback.clone());
        Box::pin(async move { plan.map(TurnDecision::Plan) })
    }

    fn reset(&self) {
        *self.queue.lock().unwrap() = VecDeque::from(self.initial.clone());
    }
}

/// Closure-backed handler for concise programmatic test scenarios.
pub struct FnHandler<F>(pub F);

impl<F> TurnHandler for FnHandler<F>
where
    F: Fn(&NormalizedRequest, &TurnContext) -> TurnPlan + Send + Sync + 'static,
{
    fn handle<'a>(&'a self, req: &'a NormalizedRequest, ctx: &'a TurnContext) -> HandlerFuture<'a> {
        let plan = (self.0)(req, ctx);
        Box::pin(async move { Some(TurnDecision::Plan(plan)) })
    }
}

/// Fallthrough predicate handler for use in `ChainHandler` (returns `Some(TurnPlan)` to handle,
/// or `None` to delegate to the next handler such as `InteractiveHandler`).
pub struct FilterHandler<F>(pub F);

impl<F> TurnHandler for FilterHandler<F>
where
    F: Fn(&NormalizedRequest, &TurnContext) -> Option<TurnPlan> + Send + Sync + 'static,
{
    fn handle<'a>(&'a self, req: &'a NormalizedRequest, ctx: &'a TurnContext) -> HandlerFuture<'a> {
        let plan = (self.0)(req, ctx);
        Box::pin(async move { plan.map(TurnDecision::Plan) })
    }
}

/// Async closure-backed handler for scenarios that need to await barriers or channels before replying.
pub struct AsyncFnHandler<F>(pub F);

impl<F, Fut> TurnHandler for AsyncFnHandler<F>
where
    F: Fn(NormalizedRequest, TurnContext) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Option<TurnPlan>> + Send + 'static,
{
    fn handle<'a>(&'a self, req: &'a NormalizedRequest, ctx: &'a TurnContext) -> HandlerFuture<'a> {
        let fut = (self.0)(req.clone(), ctx.clone());
        Box::pin(async move { fut.await.map(TurnDecision::Plan) })
    }
}

/// Ordered chain of handlers; first one returning `Some(decision)` wins.
pub struct ChainHandler {
    handlers: Vec<Arc<dyn TurnHandler>>,
}

impl ChainHandler {
    pub fn new(handlers: Vec<Arc<dyn TurnHandler>>) -> Self {
        Self { handlers }
    }
}

impl TurnHandler for ChainHandler {
    fn handle<'a>(&'a self, req: &'a NormalizedRequest, ctx: &'a TurnContext) -> HandlerFuture<'a> {
        Box::pin(async move {
            for handler in &self.handlers {
                if let Some(decision) = handler.handle(req, ctx).await {
                    return Some(decision);
                }
            }
            None
        })
    }

    fn reset(&self) {
        for handler in &self.handlers {
            handler.reset();
        }
    }
}
