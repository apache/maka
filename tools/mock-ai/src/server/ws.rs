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

use super::{
    ActiveStreamGuard, Attempt, DeliveredItem, FlushStatus, ServerState, TurnCloseGuard,
    default_response_id, effective_history, event_usage, format_ws_error_frame, initial_usage,
    jitter_ms,
};
use crate::codec::{EncodedFrame, FrameKind, WireFrame};
use crate::handler::{CloseSignalGuard, InteractiveCommand, TurnDecision};
use crate::metrics::{AttemptOutcome, RequestPurpose};
use crate::pacing::{LatencyProfile, TurnPacer};
use crate::plan::{CloseSignal, FinishReason, HttpErrorSpec, TurnEvent, TurnPlan, Usage};
use crate::protocol::{NormalizedRequest, Protocol, Transport, normalize_request};
#[cfg(feature = "proxy")]
use crate::proxy::fingerprint_from_route;
use crate::ratelimit::{RateLimitDecision, RateLimitLease};
use crate::routing::{EndpointKind, ParsedRoute, RequestUse, ResponseId, RouteScope};
use crate::schema_synth::WirePoisonConfig;
use crate::watchdog::HistorySize;
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::BTreeMap;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message as WsMessage;

#[allow(clippy::too_many_arguments)]
pub(super) async fn handle_responses_websocket<S>(
    mut ws: WebSocketStream<S>,
    conn_id: u64,
    path: String,
    scope: Option<RouteScope>,
    canonical_offset: usize,
    query: Option<String>,
    headers: BTreeMap<String, String>,
    state: Arc<ServerState>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    let mut connection = WsBinding {
        state: &state,
        id: conn_id,
        bound: false,
    };
    let route = ParsedRoute {
        canonical_path: &path[canonical_offset..],
        raw_path: &path,
        scope,
        query: query.as_deref(),
        endpoint: EndpointKind::ResponsesWs,
    };
    let mut legacy_baseline = None;
    let mut turn_on_connection = 0;
    let mut warmups = 0_u64;
    loop {
        let message = tokio::select! {
            _ = state.shutdown.cancelled() => break,
            message = ws.next() => message,
        };
        let Some(Ok(message)) = message else {
            break;
        };
        match message {
            WsMessage::Ping(bytes) => {
                if ws.send(WsMessage::Pong(bytes)).await.is_err() {
                    break;
                }
            }
            WsMessage::Pong(_) => {}
            WsMessage::Text(text) => {
                let transport = Transport::WebSocket {
                    connection_id: conn_id,
                    turn_on_connection: turn_on_connection + 1,
                };
                let attempt = Attempt::new(
                    &state,
                    Protocol::OpenaiResponsesWs,
                    transport,
                    Instant::now(),
                    state.clock.elapsed_ns(),
                );
                attempt.body_read(text.len());
                let _ = state.resolve_identity(
                    &attempt,
                    route.scope.as_ref(),
                    &headers,
                    &Value::Null,
                    None,
                    false,
                );
                let raw_body = match serde_json::from_str::<Value>(&text) {
                    Ok(body) => body,
                    Err(error) => {
                        let spec = HttpErrorSpec::new(
                            400,
                            "invalid_request_error",
                            format!("invalid WS JSON frame: {error}"),
                        );
                        attempt.outcome(AttemptOutcome::ParseFailed, Some(400));
                        let _ = send_error(&mut ws, &attempt, &spec).await;
                        continue;
                    }
                };
                attempt.with_span(|span, now| span.parsed_ns = Some(now));
                if raw_body["type"] != "response.create" {
                    let spec = HttpErrorSpec::new(
                        400,
                        "invalid_request_error",
                        "expected a response.create event",
                    );
                    attempt.outcome(AttemptOutcome::Rejected, Some(400));
                    if !send_error(&mut ws, &attempt, &spec).await {
                        break;
                    }
                    continue;
                }
                let sequence = if raw_body["generate"] == false {
                    0
                } else {
                    state.next_sequence()
                };
                let mut req = normalize_request(
                    sequence,
                    Protocol::OpenaiResponsesWs,
                    attempt.0.transport.clone(),
                    path.clone(),
                    headers.clone(),
                    Bytes::from(text),
                    raw_body,
                );
                let parent_id = req.previous_response_id.clone().map(ResponseId);
                if let Err(spec) = state.resolve_identity(
                    &attempt,
                    route.scope.as_ref(),
                    &req.headers,
                    &req.raw_body,
                    parent_id.as_ref(),
                    !connection.bound,
                ) {
                    attempt.outcome(AttemptOutcome::Rejected, Some(spec.status));
                    if !send_error(&mut ws, &attempt, &spec).await {
                        break;
                    }
                    continue;
                }
                if !connection.bound {
                    connection.bound = attempt.owner().is_some();
                }
                let purpose = state.classify(&route, &mut req, &attempt);
                if req.options.generate == Some(false) {
                    attempt.classified(&req, RequestPurpose::Warmup);
                    let parent =
                        match state.check_parent(&req, &attempt, legacy_baseline.as_deref()) {
                            Ok(parent) => parent,
                            Err(spec) => {
                                attempt.outcome(AttemptOutcome::Rejected, Some(spec.status));
                                if !send_error(&mut ws, &attempt, &spec).await {
                                    break;
                                }
                                continue;
                            }
                        };
                    attempt.admitted(parent.as_ref());
                    warmups += 1;
                    req.options.store = Some(false);
                    let plan = TurnPlan::new()
                        .with_response_id(format!("resp_warmup_{conn_id}_{warmups}"))
                        .with_usage(Usage::new(0, 0))
                        .finish(FinishReason::Stop);
                    let history = effective_history(&req, parent.as_ref());
                    let Some(id) = execute_ws_turn(
                        &mut ws,
                        &req,
                        TurnDecision::Plan(plan),
                        LatencyProfile::default(),
                        None,
                        history,
                        &attempt,
                    )
                    .await
                    else {
                        break;
                    };
                    legacy_baseline = Some(id);
                    continue;
                }
                turn_on_connection += 1;
                attempt.classified(&req, RequestPurpose::from(&purpose));
                let main = purpose == RequestUse::Main;
                let profile = state.profile.effective();
                let lease = if main {
                    attempt.record(|metrics| {
                        metrics.record_protocol(req.protocol, req.prompt_bytes);
                        state.recorder.record(&req);
                    });
                    match state.rate_limiter.check_and_acquire(
                        req.api_key(),
                        &req.model,
                        req.estimated_input_tokens,
                        profile.rate_limit_override.as_ref(),
                    ) {
                        RateLimitDecision::Allowed { lease, .. } => lease,
                        RateLimitDecision::Rejected {
                            retry_after_ms,
                            reason,
                            ..
                        } => {
                            let spec = HttpErrorSpec::rate_limit(
                                Some(retry_after_ms.div_ceil(1000).max(1)),
                                format!("rate limit exceeded ({reason})"),
                            )
                            .with_retry_after_ms(retry_after_ms);
                            attempt.outcome(AttemptOutcome::RateLimited, Some(429));
                            if !send_error(&mut ws, &attempt, &spec).await {
                                break;
                            }
                            continue;
                        }
                    }
                } else {
                    None
                };

                #[cfg(feature = "proxy")]
                if let Some(replayer) = &state.cassette_replayer {
                    let parent = if replayer.config().strict_replay || attempt.owner().is_some() {
                        match state.check_parent(&req, &attempt, legacy_baseline.as_deref()) {
                            Ok(parent) => parent,
                            Err(spec) => {
                                attempt.outcome(AttemptOutcome::Rejected, Some(spec.status));
                                if !send_error(&mut ws, &attempt, &spec).await {
                                    break;
                                }
                                continue;
                            }
                        }
                    } else {
                        None
                    };
                    let lane = attempt.replay_lane(&req.headers);
                    let fp = fingerprint_from_route(&req, "GET", &route, lane.as_ref());
                    match replayer.try_next_ws_if(&fp, |candidate| {
                        !state.tuning.strict_previous_response_id
                            || req.previous_response_id.as_deref()
                                == candidate.request_body["previous_response_id"].as_str()
                    }) {
                        Ok(exchange) => {
                            attempt.record(|metrics| {
                                metrics.replay_hits.fetch_add(1, Ordering::Relaxed);
                            });
                            attempt.admitted(parent.as_ref());
                            attempt.ready(None);
                            let mut complete = true;
                            for chunk in &exchange.chunks {
                                if !wait_ws(
                                    &mut ws,
                                    &attempt,
                                    replayer.config().scaled_delay(chunk.delay_ms),
                                )
                                .await
                                {
                                    complete = false;
                                    break;
                                }
                                let message = if chunk.is_binary {
                                    WsMessage::Binary(chunk.to_bytes())
                                } else {
                                    WsMessage::text(chunk.data.clone())
                                };
                                if !send_ws(&mut ws, &attempt, message).await {
                                    complete = false;
                                    break;
                                }
                                attempt.frame(chunk.data.len(), false);
                            }
                            if !complete {
                                break;
                            }
                            if exchange.outcome != crate::proxy::ExchangeOutcome::Completed {
                                attempt
                                    .outcome(AttemptOutcome::InjectedFault, Some(exchange.status));
                                break;
                            }
                            if let Some(response) = replayed_response(exchange)
                                && let Some(id) = response["id"].as_str().map(str::to_owned)
                            {
                                attempt.ready(Some(&id));
                                if purpose == RequestUse::Main
                                    || matches!(purpose, RequestUse::Compact(_))
                                {
                                    legacy_baseline = Some(id.clone());
                                }
                                state.publish_response(
                                    &req,
                                    &attempt,
                                    id,
                                    response,
                                    req.options.store.unwrap_or(false),
                                    effective_history(&req, parent.as_ref()),
                                );
                            }
                            attempt.outcome(AttemptOutcome::Completed, Some(exchange.status));
                            continue;
                        }
                        Err(error) if replayer.config().strict_replay => {
                            let mut spec =
                                HttpErrorSpec::new(422, "invalid_request_error", error.to_string());
                            spec.code = Some("cassette_replay_miss".into());
                            attempt.outcome(AttemptOutcome::Rejected, Some(spec.status));
                            if !send_error(&mut ws, &attempt, &spec).await {
                                break;
                            }
                            continue;
                        }
                        Err(_) => {}
                    }
                }

                let parent = match state.check_parent(&req, &attempt, legacy_baseline.as_deref()) {
                    Ok(parent) => parent,
                    Err(spec) => {
                        if main {
                            attempt.record(|_| {
                                state.watchdog.record_invalid_previous_response_id(
                                    &req,
                                    req.previous_response_id.as_deref().unwrap(),
                                )
                            });
                        }
                        attempt.outcome(AttemptOutcome::Rejected, Some(spec.status));
                        if !send_error(&mut ws, &attempt, &spec).await {
                            break;
                        }
                        continue;
                    }
                };
                attempt.admitted(parent.as_ref());
                let history = effective_history(&req, parent.as_ref());
                let req = Arc::new(req);
                let decision = match state
                    .decide(&req, &purpose, &profile, &attempt, parent.as_ref())
                    .await
                {
                    Ok(decision) => decision,
                    Err(spec) => {
                        attempt.outcome(AttemptOutcome::Rejected, Some(spec.status));
                        if !send_error(&mut ws, &attempt, &spec).await {
                            break;
                        }
                        continue;
                    }
                };
                attempt.audit(req.clone(), &purpose, history);
                state.metrics.active_streams.fetch_add(1, Ordering::Relaxed);
                let _stream = ActiveStreamGuard(state.metrics.clone());
                let Some(response_id) = execute_ws_turn(
                    &mut ws,
                    &req,
                    decision,
                    if main {
                        profile.latency
                    } else {
                        LatencyProfile::default()
                    },
                    lease,
                    history,
                    &attempt,
                )
                .await
                else {
                    break;
                };
                if main || matches!(purpose, RequestUse::Compact(_)) {
                    legacy_baseline = Some(response_id);
                }
            }
            WsMessage::Binary(_) | WsMessage::Frame(_) | WsMessage::Close(_) => break,
        }
    }
}

#[cfg(feature = "proxy")]
fn replayed_response(exchange: &crate::proxy::RecordedExchange) -> Option<Value> {
    // Recorded messages are opaque bytes until the last provider terminal event.
    exchange
        .chunks
        .iter()
        .rev()
        .filter(|chunk| !chunk.is_binary)
        .find_map(|chunk| {
            let mut event: Value = serde_json::from_str(&chunk.data).ok()?;
            matches!(
                event["type"].as_str(),
                Some("response.completed" | "response.incomplete")
            )
            .then(|| event["response"].take())
        })
}

struct WsBinding<'a> {
    state: &'a ServerState,
    id: u64,
    bound: bool,
}

impl Drop for WsBinding<'_> {
    fn drop(&mut self) {
        if !self.bound {
            return;
        }
        let mut routing = self.state.benchmark.write().unwrap();
        routing.registry.unbind_connection(self.id);
        routing.lineage.close_connection(self.id);
    }
}

async fn send_ws<S>(ws: &mut WebSocketStream<S>, attempt: &Attempt, message: WsMessage) -> bool
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let mut send = std::pin::pin!(ws.send(message));
    let mut waiting = None;
    let result = tokio::select! {
        _ = attempt.0.state.shutdown.cancelled() => false,
        result = std::future::poll_fn(|cx| {
            let result = send.as_mut().poll(cx);
            if result.is_pending() && waiting.is_none() {
                waiting = Some(Instant::now());
            }
            result
        }) => result.is_ok(),
    };
    if let Some(start) = waiting {
        attempt.backpressure(start.elapsed());
    }
    result
}

async fn send_error<S>(ws: &mut WebSocketStream<S>, attempt: &Attempt, spec: &HttpErrorSpec) -> bool
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    attempt.record(|metrics| {
        metrics.http_errors_emitted.fetch_add(1, Ordering::Relaxed);
        if spec.status == 429 {
            metrics.rate_limits_emitted.fetch_add(1, Ordering::Relaxed);
        }
    });
    let message = format_ws_error_frame(spec).to_string();
    let len = message.len();
    if send_ws(ws, attempt, WsMessage::text(message)).await {
        attempt.frame(len, false);
        true
    } else {
        false
    }
}

async fn busy_message<S>(
    ws: &mut WebSocketStream<S>,
    message: Option<Result<WsMessage, tokio_tungstenite::tungstenite::Error>>,
    attempt: &Attempt,
) -> bool
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    match message {
        Some(Ok(WsMessage::Ping(payload))) => ws.send(WsMessage::Pong(payload)).await.is_ok(),
        Some(Ok(WsMessage::Pong(_))) => true,
        Some(Ok(message @ (WsMessage::Text(_) | WsMessage::Binary(_)))) => {
            let rejection = attempt.rejected_ws_message(message.len());
            let mut error = HttpErrorSpec::new(
                400,
                "invalid_request_error",
                "a response is already in progress on this connection",
            );
            error.code = Some("response_already_in_progress".into());
            send_error(ws, &rejection, &error).await
        }
        _ => false,
    }
}

async fn wait_ws<S>(ws: &mut WebSocketStream<S>, attempt: &Attempt, delay: Duration) -> bool
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    wait_ws_until(ws, attempt, tokio::time::Instant::now() + delay).await
}

async fn wait_ws_until<S>(
    ws: &mut WebSocketStream<S>,
    attempt: &Attempt,
    deadline: tokio::time::Instant,
) -> bool
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let now = tokio::time::Instant::now();
    if deadline <= now {
        return !attempt.0.state.shutdown.is_cancelled();
    }
    let started = Instant::now();
    let mut sleep = std::pin::pin!(tokio::time::sleep_until(deadline));
    let completed = loop {
        tokio::select! {
            _ = attempt.0.state.shutdown.cancelled() => break false,
            _ = &mut sleep => break true,
            msg = ws.next() => {
                if !busy_message(ws, msg, attempt).await {
                    break false;
                }
            }
        }
    };
    attempt.sleep_recorded(deadline - now, started.elapsed());
    completed
}

enum WsEventFeed {
    Plan {
        events: std::vec::IntoIter<TurnEvent>,
        inferred_finish: FinishReason,
    },
    Interactive {
        pending: Option<Box<TurnEvent>>,
        rx: mpsc::Receiver<InteractiveCommand>,
    },
}

enum WsFeedStep {
    Event(Box<TurnEvent>),
    Ended,
    Aborted,
}

enum WsStallOutcome {
    Resumed,
    Ended,
}

impl WsEventFeed {
    fn auto_finish_reason(&self) -> Option<FinishReason> {
        match self {
            Self::Plan {
                inferred_finish, ..
            } => Some(inferred_finish.clone()),
            Self::Interactive { .. } => None,
        }
    }

    async fn next_event<S>(&mut self, ws: &mut WebSocketStream<S>, attempt: &Attempt) -> WsFeedStep
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
    {
        let shutdown = &attempt.0.state.shutdown;
        match self {
            Self::Plan { events, .. } => {
                if shutdown.is_cancelled() {
                    return WsFeedStep::Aborted;
                }
                match events.next() {
                    Some(ev) => WsFeedStep::Event(Box::new(ev)),
                    None => WsFeedStep::Ended,
                }
            }
            Self::Interactive { pending, rx } => {
                if let Some(ev) = pending.take() {
                    return WsFeedStep::Event(ev);
                }
                // Concurrently monitor client WS Ping/Close while waiting for the next test event
                // so handle.wait_closed() wakes promptly when the client cancels/disconnects.
                loop {
                    tokio::select! {
                        _ = shutdown.cancelled() => return WsFeedStep::Aborted,
                        next = rx.recv() => match next {
                            Some(InteractiveCommand::Event(ev)) => return WsFeedStep::Event(ev),
                            Some(InteractiveCommand::Plan { .. }) => {
                                unreachable!("TurnHandle::send_plan is rejected after incremental events")
                            }
                            None => return WsFeedStep::Ended,
                        },
                        msg = ws.next() => if !busy_message(ws, msg, attempt).await { return WsFeedStep::Aborted; }
                    }
                }
            }
        }
    }

    async fn wait_stall<S>(
        &mut self,
        ws: &mut WebSocketStream<S>,
        attempt: &Attempt,
    ) -> WsStallOutcome
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
    {
        let shutdown = &attempt.0.state.shutdown;
        match self {
            Self::Plan { .. } => loop {
                tokio::select! {
                    _ = shutdown.cancelled() => return WsStallOutcome::Ended,
                    msg = ws.next() => if !busy_message(ws, msg, attempt).await { return WsStallOutcome::Ended; }
                }
            },
            Self::Interactive { pending, rx } => {
                let mut rx_open = true;
                loop {
                    if rx_open {
                        tokio::select! {
                            _ = shutdown.cancelled() => return WsStallOutcome::Ended,
                            next = rx.recv() => match next {
                                Some(InteractiveCommand::Event(ev)) => {
                                    *pending = Some(ev);
                                    return WsStallOutcome::Resumed;
                                }
                                Some(InteractiveCommand::Plan { .. }) => {
                                    unreachable!("TurnHandle::send_plan is rejected after incremental events")
                                }
                                None => rx_open = false,
                            },
                            msg = ws.next() => if !busy_message(ws, msg, attempt).await { return WsStallOutcome::Ended; }
                        }
                    } else {
                        tokio::select! {
                            _ = shutdown.cancelled() => return WsStallOutcome::Ended,
                            msg = ws.next() => if !busy_message(ws, msg, attempt).await { return WsStallOutcome::Ended; }
                        }
                    }
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute_ws_turn<S>(
    ws: &mut WebSocketStream<S>,
    req: &NormalizedRequest,
    decision: TurnDecision,
    latency_profile: LatencyProfile,
    mut lease: Option<RateLimitLease>,
    history: HistorySize,
    attempt: &Attempt,
) -> Option<String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    let state = &attempt.0.state;
    let (mut plan, mut feed, _close_guard) = match decision {
        TurnDecision::Plan(plan) => resolve_ws_plan(plan, None),
        TurnDecision::Interactive(mut stream) => {
            let guard =
                TurnCloseGuard::new(CloseSignalGuard(Some(CloseSignal(stream.closed.clone()))));
            let first = loop {
                tokio::select! {
                    _ = state.shutdown.cancelled() => return None,
                    event = stream.events.recv() => break event?,
                    msg = ws.next() => if !busy_message(ws, msg, attempt).await { return None; },
                }
            };
            match first {
                InteractiveCommand::Plan { mut plan, on_close } => {
                    let mut guard = guard;
                    guard.attach(on_close);
                    plan.on_close = None;
                    resolve_ws_plan(*plan, Some(guard))
                }
                InteractiveCommand::Event(first) => {
                    let id = stream.response_id.lock().unwrap().clone();
                    (
                        TurnPlan {
                            response_id: id,
                            ..Default::default()
                        },
                        WsEventFeed::Interactive {
                            pending: Some(first),
                            rx: stream.events,
                        },
                        guard,
                    )
                }
            }
        }
    };
    let response_id = plan
        .response_id
        .take()
        .unwrap_or_else(|| default_response_id(req.protocol, req.sequence));
    attempt.ready(Some(&response_id));
    let model = plan
        .model_override
        .take()
        .unwrap_or_else(|| req.model.clone());
    let usage_event = initial_usage(
        match &feed {
            WsEventFeed::Plan { events, .. } => events.as_slice(),
            WsEventFeed::Interactive { .. } => &[],
        },
        req,
    );
    let mut usage = event_usage(&usage_event).unwrap().clone();
    attempt.usage(usage.clone());
    let mut pacer = matches!(feed, WsEventFeed::Plan { .. }).then(|| {
        let active = state.metrics.active_streams.load(Ordering::Relaxed).max(1);
        super::turn_pacer(req, &plan, &usage, attempt, latency_profile, active)
    });
    let mut encoder = state.encoder(req, response_id, model);
    for _ in encoder.encode_event(usage_event) {}
    let mut semantic_bytes = 0;
    if let Some(pacer) = &pacer
        && !wait_ws(ws, attempt, pacer.initial_delay()).await
    {
        return None;
    }
    let close_reason = loop {
        let event = match feed.next_event(ws, attempt).await {
            WsFeedStep::Aborted => return None,
            WsFeedStep::Ended => break feed.auto_finish_reason()?,
            WsFeedStep::Event(event) => *event,
        };
        match event {
            TurnEvent::Delay { ms } => {
                if !wait_ws(ws, attempt, Duration::from_millis(ms)).await {
                    return None;
                }
            }
            TurnEvent::JitterDelay { min_ms, max_ms } => {
                let ms = pacer.as_mut().map_or_else(
                    || jitter_ms(min_ms, max_ms),
                    |pacer| pacer.jitter_ms(min_ms, max_ms),
                );
                if !wait_ws(ws, attempt, Duration::from_millis(ms)).await {
                    return None;
                }
            }
            TurnEvent::Stall => {
                attempt.record(|metrics| {
                    metrics.stalls_entered.fetch_add(1, Ordering::Relaxed);
                });
                if matches!(feed.wait_stall(ws, attempt).await, WsStallOutcome::Ended) {
                    if matches!(feed, WsEventFeed::Plan { .. }) && !state.shutdown.is_cancelled() {
                        attempt.outcome(AttemptOutcome::InjectedFault, None);
                    }
                    return None;
                }
            }
            TurnEvent::HttpError(spec) => {
                attempt.outcome(AttemptOutcome::InjectedFault, Some(spec.status));
                let _ = send_error(ws, attempt, &spec).await;
                return None;
            }
            TurnEvent::DropConnection => {
                attempt.record(|metrics| {
                    metrics
                        .connection_drops_emitted
                        .fetch_add(1, Ordering::Relaxed);
                });
                attempt.outcome(AttemptOutcome::InjectedFault, None);
                return None;
            }
            TurnEvent::TruncateEof => {
                attempt.outcome(AttemptOutcome::InjectedFault, None);
                let _ = ws.close(None).await;
                return None;
            }
            TurnEvent::MidStreamError(error) => {
                attempt.record(|metrics| {
                    metrics
                        .mid_stream_errors_emitted
                        .fetch_add(1, Ordering::Relaxed);
                });
                attempt.outcome(AttemptOutcome::InjectedFault, None);
                let _ = flush_ws_frames(
                    ws,
                    encoder.encode_event(TurnEvent::MidStreamError(error)),
                    pacer.as_mut(),
                    &plan.wire_poison,
                    attempt,
                    &mut semantic_bytes,
                )
                .await;
                return None;
            }
            TurnEvent::Finish { reason } => break reason,
            event => {
                if let Some(value) = event_usage(&event) {
                    usage = value.clone();
                    attempt.usage(usage.clone());
                }
                let item = DeliveredItem::from_event(&event);
                if let Some(item) = &item {
                    item.issued(attempt);
                }
                let sent = flush_ws_frames(
                    ws,
                    encoder.encode_event(event),
                    pacer.as_mut(),
                    &plan.wire_poison,
                    attempt,
                    &mut semantic_bytes,
                )
                .await;
                if sent.all_wire_frames_sent
                    && let Some(item) = item
                {
                    item.deliver(attempt, req);
                }
                if !sent.continued {
                    return None;
                }
            }
        }
    };
    let mut tail = Vec::new();
    let completion = encoder.finish_encoded(close_reason, &mut |frame| tail.push(frame));
    if !flush_ws_frames(
        ws,
        tail.into_iter(),
        None,
        &plan.wire_poison,
        attempt,
        &mut semantic_bytes,
    )
    .await
    .continued
    {
        return None;
    }
    usage.output_tokens = usage.output_tokens.max((semantic_bytes as u64) / 4);
    if let Some(lease) = &mut lease {
        lease.debit_output_tokens(usage.output_tokens);
    }
    attempt.usage(usage);
    attempt.with_span(|span, now| span.body_dropped_ns = Some(now));
    if completion.errored {
        attempt.outcome(AttemptOutcome::InjectedFault, None);
        return None;
    }
    attempt.outcome(AttemptOutcome::Completed, Some(200));
    attempt.deliver_summary(req);
    let id = completion.response_id;
    state.publish_response(
        req,
        attempt,
        id.clone(),
        completion.response_json,
        req.options.store.unwrap_or(false),
        attempt.response_history(history, semantic_bytes),
    );
    completion.ws_reusable.then_some(id)
}

fn resolve_ws_plan(
    mut plan: TurnPlan,
    guard: Option<TurnCloseGuard>,
) -> (TurnPlan, WsEventFeed, TurnCloseGuard) {
    let guard =
        guard.unwrap_or_else(|| TurnCloseGuard::new(CloseSignalGuard(plan.on_close.take())));
    let inferred_finish = plan.inferred_finish_reason();
    let feed = WsEventFeed::Plan {
        events: std::mem::take(&mut plan.events).into_iter(),
        inferred_finish,
    };
    (plan, feed, guard)
}

async fn flush_ws_frames<S>(
    ws: &mut WebSocketStream<S>,
    frames: impl Iterator<Item = EncodedFrame>,
    mut pacer: Option<&mut TurnPacer>,
    poison: &WirePoisonConfig,
    attempt: &Attempt,
    total_semantic_bytes: &mut usize,
) -> FlushStatus
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    let mut frames = frames.peekable();
    while let Some(EncodedFrame {
        wire,
        kind,
        semantic_bytes,
    }) = frames.next()
    {
        let mut text = match wire {
            WireFrame::WsText(text) => text,
            WireFrame::Raw(bytes) | WireFrame::Sse(bytes) => {
                String::from_utf8_lossy(&bytes).into_owned()
            }
        };
        if poison.crlf_line_endings {
            text.push_str("\r\n");
        }
        let len = text.len();
        if poison.inject_sse_comments && !send_ws(ws, attempt, WsMessage::Ping(Bytes::new())).await
        {
            return FlushStatus {
                all_wire_frames_sent: false,
                continued: false,
            };
        }
        let split = poison
            .split_utf8_boundaries
            .then(|| {
                text.as_bytes()
                    .iter()
                    .position(|byte| byte & 0b1100_0000 == 0b1000_0000)
            })
            .flatten();
        let sent = if let Some(split) = split {
            use tokio_tungstenite::tungstenite::protocol::frame::{
                Frame,
                coding::{Data, OpCode},
            };
            let bytes = Bytes::from(text);
            send_ws(
                ws,
                attempt,
                WsMessage::Frame(Frame::message(
                    bytes.slice(..split),
                    OpCode::Data(Data::Text),
                    false,
                )),
            )
            .await
                && send_ws(
                    ws,
                    attempt,
                    WsMessage::Frame(Frame::message(
                        bytes.slice(split..),
                        OpCode::Data(Data::Continue),
                        true,
                    )),
                )
                .await
        } else {
            send_ws(ws, attempt, WsMessage::text(text)).await
        };
        if !sent {
            return FlushStatus {
                all_wire_frames_sent: false,
                continued: false,
            };
        }
        attempt.frame(len, kind == FrameKind::SemanticDelta);
        *total_semantic_bytes += semantic_bytes;
        if let Some(deadline) = pacer.as_mut().and_then(|pacer| {
            pacer.next_frame_deadline(kind, semantic_bytes, tokio::time::Instant::now())
        }) && !wait_ws_until(ws, attempt, deadline).await
        {
            return FlushStatus {
                all_wire_frames_sent: frames.peek().is_none(),
                continued: false,
            };
        }
    }
    FlushStatus {
        all_wire_frames_sent: true,
        continued: true,
    }
}
