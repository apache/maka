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
    ActiveStreamGuard, FlushStatus, ServerState, TtftTracker, TurnCloseGuard, default_response_id,
    format_ws_error_frame, is_semantic_delta_frame, jitter_ms, pacer_seed_for, plan_usage_hint,
    semantic_event_bytes,
};
use crate::codec::{WireFrame, create_encoder};
use crate::handler::{InteractiveMeta, TurnContext, TurnDecision};
use crate::pacing::{LatencyProfile, TurnPacer};
use crate::plan::{CloseSignal, FinishReason, TurnEvent, Usage};
use crate::protocol::{NormalizedRequest, Protocol, Transport, normalize_request};
#[cfg(feature = "proxy")]
use crate::proxy::fingerprint_from_normalized;
use crate::ratelimit::{RateLimitDecision, RateLimitLease};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_util::sync::CancellationToken;

pub(super) async fn handle_responses_websocket<S>(
    mut ws: WebSocketStream<S>,
    conn_id: u64,
    path: String,
    headers: BTreeMap<String, String>,
    state: Arc<ServerState>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    // Single latest continuable response ID on this WS connection for `store: false` turns.
    // Mirrors Maka's confirmed baseline semantics: continuing from a superseded ID or another
    // connection is rejected when `strict_previous_response_id == true`.
    let mut current_baseline_id: Option<String> = None;
    let mut turn_on_connection = 0usize;

    loop {
        let frame = tokio::select! {
            _ = state.shutdown.cancelled() => break,
            msg = ws.next() => msg,
        };
        let Some(Ok(msg)) = frame else {
            break;
        };
        match msg {
            WsMessage::Ping(payload) => {
                if ws.send(WsMessage::Pong(payload)).await.is_err() {
                    break;
                }
                continue;
            }
            WsMessage::Pong(_) => continue,
            WsMessage::Close(_) => break,
            WsMessage::Text(text) => {
                turn_on_connection += 1;
                let prompt_bytes = text.len();
                let raw_body: Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(err) => {
                        let _ = ws
                            .send(WsMessage::text(
                                json!({
                                    "type": "error",
                                    "error": {
                                        "type": "invalid_request_error",
                                        "message": format!("invalid WS JSON frame: {err}"),
                                    }
                                })
                                .to_string(),
                            ))
                            .await;
                        break;
                    }
                };

                let seq = state.next_sequence();
                let normalized = normalize_request(
                    seq,
                    Protocol::OpenaiResponsesWs,
                    Transport::WebSocket {
                        connection_id: conn_id,
                        turn_on_connection,
                    },
                    path.clone(),
                    headers.clone(),
                    prompt_bytes,
                    raw_body,
                );
                let turn_started = Instant::now();
                state
                    .metrics
                    .record_protocol(Protocol::OpenaiResponsesWs, normalized.prompt_bytes);
                state.recorder.record(&normalized);
                state.watchdog.inspect_request(&normalized);

                let effective_profile = state.profile.effective();

                // Stateful rate-limit admission on WS turns
                let rl_lease = match state.rate_limiter.check_and_acquire(
                    normalized.api_key(),
                    &normalized.model,
                    normalized.estimated_input_tokens,
                    effective_profile.rate_limit_override.as_ref(),
                ) {
                    RateLimitDecision::Allowed { lease, .. } => lease,
                    RateLimitDecision::Rejected {
                        retry_after_ms,
                        reason,
                        ..
                    } => {
                        state
                            .metrics
                            .http_errors_emitted
                            .fetch_add(1, Ordering::Relaxed);
                        state
                            .metrics
                            .rate_limits_emitted
                            .fetch_add(1, Ordering::Relaxed);
                        state.metrics.record_dimension(
                            Protocol::OpenaiResponsesWs,
                            &normalized.model,
                            "429",
                            normalized.estimated_input_tokens,
                            0,
                            0,
                            None,
                            Some(turn_started.elapsed().as_millis() as u64),
                        );
                        let err_frame = json!({
                            "type": "error",
                            "status": 429,
                            "error": {
                                "type": "rate_limit_error",
                                "code": "rate_limit_exceeded",
                                "message": format!("rate limit exceeded ({reason})"),
                                "retry_after_ms": retry_after_ms,
                            }
                        });
                        let _ = ws.send(WsMessage::text(err_frame.to_string())).await;
                        break;
                    }
                };

                if state.tuning.strict_previous_response_id
                    && let Some(prev_id) = &normalized.previous_response_id
                    && current_baseline_id.as_deref() != Some(prev_id.as_str())
                    && !state.stored_responses.contains(prev_id)
                {
                    state
                        .watchdog
                        .record_invalid_previous_response_id(&normalized, prev_id);
                    state.metrics.record_dimension(
                        Protocol::OpenaiResponsesWs,
                        &normalized.model,
                        "400",
                        normalized.estimated_input_tokens,
                        0,
                        0,
                        None,
                        Some(turn_started.elapsed().as_millis() as u64),
                    );
                    let err_frame = json!({
                        "type": "error",
                        "error": {
                            "type": "invalid_request_error",
                            "code": "previous_response_not_found",
                            "message": format!("previous_response_id '{prev_id}' is not valid on this connection"),
                        }
                    });
                    let _ = ws.send(WsMessage::text(err_frame.to_string())).await;
                    break;
                }

                // Cassette WS replay mode (when configured and matched)
                #[cfg(feature = "proxy")]
                if let Some(ref replayer) = state.cassette_replayer {
                    let fp = fingerprint_from_normalized(&normalized);
                    if let Some(ex) = replayer.next_ws(&fp) {
                        state.metrics.replay_hits.fetch_add(1, Ordering::Relaxed);
                        state.metrics.active_streams.fetch_add(1, Ordering::Relaxed);
                        let _stream_guard = ActiveStreamGuard(state.metrics.clone());
                        let _lease = rl_lease;
                        let mut ok = true;
                        let mut first_ttft: Option<u64> = None;
                        let mut last_resp_id: Option<String> = None;
                        for chunk in &ex.chunks {
                            let delay = replayer.config().scaled_delay(chunk.delay_ms);
                            if !delay.is_zero() {
                                tokio::select! {
                                    _ = state.shutdown.cancelled() => { ok = false; break; }
                                    _ = tokio::time::sleep(delay) => {}
                                }
                            }
                            let msg = if chunk.is_binary {
                                WsMessage::Binary(chunk.to_bytes())
                            } else {
                                if let Ok(v) = serde_json::from_str::<Value>(&chunk.data)
                                    && let Some(id) =
                                        v.pointer("/response/id").and_then(Value::as_str)
                                {
                                    last_resp_id = Some(id.to_string());
                                }
                                WsMessage::text(chunk.data.clone())
                            };
                            let byte_len = chunk.data.len();
                            if ws.send(msg).await.is_err() {
                                ok = false;
                                break;
                            }
                            if first_ttft.is_none() {
                                let ttft = turn_started.elapsed().as_millis() as u64;
                                state.metrics.ttft_ms.record(ttft);
                                first_ttft = Some(ttft);
                            }
                            state
                                .metrics
                                .bytes_sent
                                .fetch_add(byte_len as u64, Ordering::Relaxed);
                        }
                        let dur = turn_started.elapsed().as_millis() as u64;
                        state.metrics.turn_duration_ms.record(dur);
                        state.metrics.record_dimension(
                            Protocol::OpenaiResponsesWs,
                            &normalized.model,
                            if ok { "200" } else { "aborted" },
                            normalized.estimated_input_tokens,
                            0,
                            0,
                            first_ttft,
                            Some(dur),
                        );
                        if ok {
                            current_baseline_id = last_resp_id;
                            continue;
                        } else {
                            break;
                        }
                    }
                }

                let session_turn = state.sessions.next_turn(&normalized.session_key);
                let ctx = TurnContext {
                    global_turn: seq,
                    session_turn,
                    chaos_override: effective_profile.chaos_override.clone(),
                };
                let store_flag = normalized.raw_body["store"].as_bool().unwrap_or(false);

                let decision = match state.handler.handle(&normalized, &ctx).await {
                    Some(d) => d,
                    None => {
                        let _ = ws
                            .send(WsMessage::text(
                                json!({
                                    "type": "error",
                                    "error": {
                                        "type": "server_error",
                                        "message": "mock handler exhausted",
                                    }
                                })
                                .to_string(),
                            ))
                            .await;
                        break;
                    }
                };

                state.metrics.active_streams.fetch_add(1, Ordering::Relaxed);
                let _stream_guard = ActiveStreamGuard(state.metrics.clone());

                let (reusable, completed_id) = execute_ws_turn(
                    &mut ws,
                    &normalized,
                    decision,
                    store_flag,
                    effective_profile.latency,
                    rl_lease,
                    turn_started,
                    &state,
                )
                .await;

                if reusable {
                    current_baseline_id = completed_id;
                } else {
                    break;
                }
            }
            WsMessage::Binary(_) | WsMessage::Frame(_) => break,
        }
    }
}

enum WsEventFeed {
    Plan {
        events: std::vec::IntoIter<TurnEvent>,
        inferred_finish: FinishReason,
    },
    Interactive {
        pending: Option<Box<TurnEvent>>,
        rx: mpsc::UnboundedReceiver<TurnEvent>,
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

    async fn next_event<S>(
        &mut self,
        ws: &mut WebSocketStream<S>,
        shutdown: &CancellationToken,
    ) -> WsFeedStep
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
    {
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
                            Some(ev) => return WsFeedStep::Event(Box::new(ev)),
                            None => return WsFeedStep::Ended,
                        },
                        msg = ws.next() => match msg {
                            Some(Ok(WsMessage::Ping(p))) => {
                                if ws.send(WsMessage::Pong(p)).await.is_err() {
                                    return WsFeedStep::Aborted;
                                }
                            }
                            Some(Ok(WsMessage::Pong(_))) => {}
                            None | Some(Ok(WsMessage::Close(_))) | Some(Err(_)) => {
                                return WsFeedStep::Aborted;
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
    }

    async fn wait_stall<S>(
        &mut self,
        ws: &mut WebSocketStream<S>,
        shutdown: &CancellationToken,
    ) -> WsStallOutcome
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
    {
        match self {
            Self::Plan { .. } => loop {
                tokio::select! {
                    _ = shutdown.cancelled() => return WsStallOutcome::Ended,
                    msg = ws.next() => match msg {
                        Some(Ok(WsMessage::Ping(p))) => {
                            let _ = ws.send(WsMessage::Pong(p)).await;
                        }
                        None | Some(Ok(WsMessage::Close(_))) | Some(Err(_)) => {
                            return WsStallOutcome::Ended;
                        }
                        _ => {}
                    }
                }
            },
            Self::Interactive { pending, rx } => {
                let mut rx_open = true;
                loop {
                    if rx_open {
                        tokio::select! {
                            _ = shutdown.cancelled() => return WsStallOutcome::Ended,
                            next = rx.recv() => match next {
                                Some(ev) => {
                                    *pending = Some(Box::new(ev));
                                    return WsStallOutcome::Resumed;
                                }
                                // Keep stalling after TurnHandle is dropped (e.g. send_plan(TurnPlan::stall()))
                                // until client disconnect or server shutdown, matching Plan::Stall.
                                None => rx_open = false,
                            },
                            msg = ws.next() => match msg {
                                Some(Ok(WsMessage::Ping(p))) => {
                                    if ws.send(WsMessage::Pong(p)).await.is_err() {
                                        return WsStallOutcome::Ended;
                                    }
                                }
                                Some(Ok(WsMessage::Pong(_))) => {}
                                None | Some(Ok(WsMessage::Close(_))) | Some(Err(_)) => {
                                    return WsStallOutcome::Ended;
                                }
                                _ => {}
                            }
                        }
                    } else {
                        tokio::select! {
                            _ = shutdown.cancelled() => return WsStallOutcome::Ended,
                            msg = ws.next() => match msg {
                                Some(Ok(WsMessage::Ping(p))) => {
                                    if ws.send(WsMessage::Pong(p)).await.is_err() {
                                        return WsStallOutcome::Ended;
                                    }
                                }
                                Some(Ok(WsMessage::Pong(_))) => {}
                                None | Some(Ok(WsMessage::Close(_))) | Some(Err(_)) => {
                                    return WsStallOutcome::Ended;
                                }
                                _ => {}
                            }
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
    store_flag: bool,
    latency_profile: LatencyProfile,
    mut rl_lease: Option<RateLimitLease>,
    turn_started: Instant,
    state: &Arc<ServerState>,
) -> (bool, Option<String>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    let (mut feed, meta, usage_hint, mut pacer, ttft_dur, _close_guard) = match decision {
        TurnDecision::Plan(plan) => {
            let close_guard = TurnCloseGuard(plan.on_close.clone());
            let inferred_finish = plan.inferred_finish_reason();
            let usage_hint = plan_usage_hint(&plan, req);
            let cached_tokens = usage_hint.cache_read_tokens.unwrap_or(0);
            let uncached_tokens = usage_hint.input_tokens.saturating_sub(cached_tokens);
            let in_flight_sample = state.metrics.active_streams.load(Ordering::Relaxed).max(1);
            let mut pacer = TurnPacer::new(
                latency_profile,
                pacer_seed_for(req),
                in_flight_sample,
                plan.ttft_ms,
                (plan.chunk_delay_ms > 0).then_some(plan.chunk_delay_ms),
            );
            let ttft_dur = pacer.compute_ttft(uncached_tokens, cached_tokens);
            let meta = InteractiveMeta {
                response_id: plan.response_id,
                model_override: plan.model_override,
                response_headers: plan.response_headers,
                close_connection: plan.close_connection,
                wire_poison: plan.wire_poison,
            };
            let feed = WsEventFeed::Plan {
                events: plan.events.into_iter(),
                inferred_finish,
            };
            (feed, meta, usage_hint, Some(pacer), ttft_dur, close_guard)
        }
        TurnDecision::Interactive(mut stream) => {
            let close_guard = TurnCloseGuard(Some(CloseSignal(stream.closed.clone())));
            // Wait for the first event while still handling client WS Ping/Close,
            // so TurnHandle metadata setters take effect before creating the encoder.
            let first = loop {
                tokio::select! {
                    _ = state.shutdown.cancelled() => return (false, None),
                    ev = stream.events.recv() => break ev,
                    msg = ws.next() => match msg {
                        Some(Ok(WsMessage::Ping(p))) => {
                            if ws.send(WsMessage::Pong(p)).await.is_err() {
                                return (false, None);
                            }
                        }
                        Some(Ok(WsMessage::Pong(_))) => {}
                        None | Some(Ok(WsMessage::Close(_))) | Some(Err(_)) => {
                            return (false, None);
                        }
                        _ => {}
                    }
                }
            };
            let Some(first_event) = first else {
                return (false, None);
            };
            let meta = stream.meta.lock().unwrap().clone();
            let usage_hint = Usage::new(req.estimated_input_tokens.max(1), 0);
            let feed = WsEventFeed::Interactive {
                pending: Some(Box::new(first_event)),
                rx: stream.events,
            };
            (feed, meta, usage_hint, None, Duration::ZERO, close_guard)
        }
    };

    let response_id = meta
        .response_id
        .unwrap_or_else(|| default_response_id(Protocol::OpenaiResponsesWs, req.sequence));
    let model = meta.model_override.unwrap_or_else(|| req.model.clone());
    let mut final_usage = usage_hint;

    let mut encoder = create_encoder(
        Protocol::OpenaiResponsesWs,
        response_id,
        model.clone(),
        true,
    );
    let mut frames = Vec::new();
    let mut first_delta_at: Option<Instant> = None;
    let mut recorded_ttft_ms: Option<u64> = None;
    let mut emitted_semantic_bytes = 0usize;
    let mut emitted_tool_ids: Vec<String> = Vec::new();
    let mut emitted_compaction = false;

    if !ttft_dur.is_zero() {
        let deadline = tokio::time::Instant::now() + ttft_dur;
        loop {
            let now = tokio::time::Instant::now();
            if now >= deadline {
                break;
            }
            tokio::select! {
                _ = state.shutdown.cancelled() => return (false, None),
                _ = tokio::time::sleep(deadline - now) => break,
                msg = ws.next() => match msg {
                    Some(Ok(WsMessage::Ping(p))) => {
                        if ws.send(WsMessage::Pong(p)).await.is_err() {
                            return (false, None);
                        }
                    }
                    None | Some(Ok(WsMessage::Close(_))) | Some(Err(_)) => {
                        state.metrics.abandoned_streams.fetch_add(1, Ordering::Relaxed);
                        state.watchdog.record_turn_outcome(req, &emitted_tool_ids, emitted_compaction, false);
                        return (false, None);
                    }
                    _ => {}
                }
            }
        }
    }

    loop {
        let ev = match feed.next_event(ws, &state.shutdown).await {
            WsFeedStep::Event(ev) => *ev,
            WsFeedStep::Ended => break,
            WsFeedStep::Aborted => {
                state
                    .metrics
                    .abandoned_streams
                    .fetch_add(1, Ordering::Relaxed);
                state.watchdog.record_turn_outcome(
                    req,
                    &emitted_tool_ids,
                    emitted_compaction,
                    false,
                );
                return (false, None);
            }
        };
        let ev_sem_bytes = semantic_event_bytes(&ev);
        match ev {
            TurnEvent::Delay { ms } => {
                tokio::select! {
                    _ = state.shutdown.cancelled() => return (false, None),
                    _ = tokio::time::sleep(Duration::from_millis(ms)) => {}
                }
            }
            TurnEvent::JitterDelay { min_ms, max_ms } => {
                let ms = jitter_ms(min_ms, max_ms);
                if ms > 0 {
                    tokio::select! {
                        _ = state.shutdown.cancelled() => return (false, None),
                        _ = tokio::time::sleep(Duration::from_millis(ms)) => {}
                    }
                }
            }
            TurnEvent::Stall => {
                state.metrics.stalls_entered.fetch_add(1, Ordering::Relaxed);
                match feed.wait_stall(ws, &state.shutdown).await {
                    WsStallOutcome::Resumed => continue,
                    WsStallOutcome::Ended => return (false, None),
                }
            }
            TurnEvent::HttpError(spec) => {
                state
                    .metrics
                    .http_errors_emitted
                    .fetch_add(1, Ordering::Relaxed);
                if spec.status == 429 {
                    state
                        .metrics
                        .rate_limits_emitted
                        .fetch_add(1, Ordering::Relaxed);
                }
                let err_frame = format_ws_error_frame(&spec);
                let _ = ws.send(WsMessage::text(err_frame.to_string())).await;
                state.metrics.record_dimension(
                    Protocol::OpenaiResponsesWs,
                    &model,
                    &spec.status.to_string(),
                    final_usage.input_tokens,
                    0,
                    final_usage.cache_read_tokens.unwrap_or(0),
                    None,
                    Some(turn_started.elapsed().as_millis() as u64),
                );
                return (false, None);
            }
            TurnEvent::DropConnection => {
                state
                    .metrics
                    .connection_drops_emitted
                    .fetch_add(1, Ordering::Relaxed);
                return (false, None);
            }
            TurnEvent::TruncateEof => {
                let _ = ws.close(None).await;
                return (false, None);
            }
            TurnEvent::MidStreamError(err) => {
                state
                    .metrics
                    .mid_stream_errors_emitted
                    .fetch_add(1, Ordering::Relaxed);
                encoder.push_event(TurnEvent::MidStreamError(err), &mut frames);
                let _ = flush_ws_frames(ws, &mut frames, None, 0, None, state).await;
                return (false, None);
            }
            TurnEvent::Finish { reason } => {
                let completion = encoder.finish(reason, &mut frames);
                if store_flag {
                    state
                        .stored_responses
                        .put(completion.response_id.clone(), completion.response_json);
                }
                if !flush_ws_frames(ws, &mut frames, None, 0, None, state).await {
                    state
                        .metrics
                        .abandoned_streams
                        .fetch_add(1, Ordering::Relaxed);
                    state.watchdog.record_turn_outcome(
                        req,
                        &emitted_tool_ids,
                        emitted_compaction,
                        false,
                    );
                    return (false, None);
                }
                record_ws_completion(
                    req,
                    &model,
                    &final_usage,
                    emitted_semantic_bytes,
                    &emitted_tool_ids,
                    emitted_compaction,
                    first_delta_at,
                    recorded_ttft_ms,
                    &mut rl_lease,
                    turn_started,
                    state,
                );
                return (completion.ws_reusable, Some(completion.response_id));
            }
            TurnEvent::NativeCompaction(c) => {
                state
                    .metrics
                    .native_compactions_emitted
                    .fetch_add(1, Ordering::Relaxed);
                encoder.push_event(TurnEvent::NativeCompaction(c), &mut frames);
                let mut ttft = TtftTracker {
                    turn_started,
                    first_delta_at: &mut first_delta_at,
                    recorded_ttft_ms: &mut recorded_ttft_ms,
                };
                let status = flush_ws_frames_detailed(
                    ws,
                    &mut frames,
                    pacer.as_mut(),
                    ev_sem_bytes,
                    Some(&mut ttft),
                    state,
                )
                .await;
                if status.all_wire_frames_sent {
                    emitted_compaction = true;
                    emitted_semantic_bytes += ev_sem_bytes;
                }
                if !status.continued {
                    state
                        .metrics
                        .abandoned_streams
                        .fetch_add(1, Ordering::Relaxed);
                    state.watchdog.record_turn_outcome(
                        req,
                        &emitted_tool_ids,
                        emitted_compaction,
                        false,
                    );
                    return (false, None);
                }
            }
            TurnEvent::Usage(u) => {
                final_usage = u.clone();
                encoder.push_event(TurnEvent::Usage(u), &mut frames);
            }
            other => {
                let maybe_tool_id = match &other {
                    TurnEvent::ToolCall(tc) => Some(tc.id.clone()),
                    _ => None,
                };
                encoder.push_event(other, &mut frames);
                let mut ttft = TtftTracker {
                    turn_started,
                    first_delta_at: &mut first_delta_at,
                    recorded_ttft_ms: &mut recorded_ttft_ms,
                };
                let status = flush_ws_frames_detailed(
                    ws,
                    &mut frames,
                    pacer.as_mut(),
                    ev_sem_bytes,
                    Some(&mut ttft),
                    state,
                )
                .await;
                if status.all_wire_frames_sent {
                    if let Some(tid) = maybe_tool_id {
                        emitted_tool_ids.push(tid);
                    }
                    emitted_semantic_bytes += ev_sem_bytes;
                }
                if !status.continued {
                    state
                        .metrics
                        .abandoned_streams
                        .fetch_add(1, Ordering::Relaxed);
                    state.watchdog.record_turn_outcome(
                        req,
                        &emitted_tool_ids,
                        emitted_compaction,
                        false,
                    );
                    return (false, None);
                }
            }
        }
    }

    if !encoder.is_finished()
        && let Some(reason) = feed.auto_finish_reason()
    {
        let completion = encoder.finish(reason, &mut frames);
        if store_flag {
            state
                .stored_responses
                .put(completion.response_id.clone(), completion.response_json);
        }
        if !flush_ws_frames(ws, &mut frames, None, 0, None, state).await {
            state
                .metrics
                .abandoned_streams
                .fetch_add(1, Ordering::Relaxed);
            state
                .watchdog
                .record_turn_outcome(req, &emitted_tool_ids, emitted_compaction, false);
            return (false, None);
        }
        record_ws_completion(
            req,
            &model,
            &final_usage,
            emitted_semantic_bytes,
            &emitted_tool_ids,
            emitted_compaction,
            first_delta_at,
            recorded_ttft_ms,
            &mut rl_lease,
            turn_started,
            state,
        );
        return (completion.ws_reusable, Some(completion.response_id));
    }

    (false, None)
}

#[allow(clippy::too_many_arguments)]
fn record_ws_completion(
    req: &NormalizedRequest,
    model: &str,
    usage: &Usage,
    emitted_semantic_bytes: usize,
    emitted_tool_ids: &[String],
    emitted_compaction: bool,
    first_delta_at: Option<Instant>,
    recorded_ttft_ms: Option<u64>,
    rl_lease: &mut Option<RateLimitLease>,
    turn_started: Instant,
    state: &ServerState,
) {
    let dur = turn_started.elapsed().as_millis() as u64;
    state.metrics.turn_duration_ms.record(dur);
    let out_toks = usage.output_tokens.max((emitted_semantic_bytes as u64) / 4);
    if let Some(first_at) = first_delta_at
        && out_toks > 0
    {
        let tps = ((out_toks as f64) / first_at.elapsed().as_secs_f64().max(0.001))
            .round()
            .max(1.0) as u64;
        state.metrics.effective_tps.record(tps);
    }
    if let Some(lease) = rl_lease.as_mut() {
        lease.debit_output_tokens(out_toks);
    }
    state.metrics.record_dimension(
        Protocol::OpenaiResponsesWs,
        model,
        "200",
        usage.input_tokens,
        out_toks,
        usage.cache_read_tokens.unwrap_or(0),
        recorded_ttft_ms,
        Some(dur),
    );
    state
        .watchdog
        .record_turn_outcome(req, emitted_tool_ids, emitted_compaction, true);
}

async fn flush_ws_frames<S>(
    ws: &mut WebSocketStream<S>,
    frames: &mut Vec<WireFrame>,
    pacer: Option<&mut TurnPacer>,
    semantic_bytes: usize,
    ttft: Option<&mut TtftTracker<'_>>,
    state: &ServerState,
) -> bool
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    flush_ws_frames_detailed(ws, frames, pacer, semantic_bytes, ttft, state)
        .await
        .continued
}

async fn flush_ws_frames_detailed<S>(
    ws: &mut WebSocketStream<S>,
    frames: &mut Vec<WireFrame>,
    mut pacer: Option<&mut TurnPacer>,
    semantic_bytes: usize,
    mut ttft: Option<&mut TtftTracker<'_>>,
    state: &ServerState,
) -> FlushStatus
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    let total_frames = frames.len();
    let per_frame_sem_bytes = if semantic_bytes > 0 {
        (semantic_bytes / total_frames.max(1)).max(1)
    } else {
        0
    };
    let mut sent_frames = 0usize;
    for frame in frames.drain(..) {
        let text = match frame {
            WireFrame::WsText(s) => s,
            WireFrame::Sse(b) | WireFrame::Raw(b) => String::from_utf8_lossy(&b).into_owned(),
        };
        let is_delta = semantic_bytes > 0 && is_semantic_delta_frame(&text);
        let len = text.len();
        if ws.send(WsMessage::text(text)).await.is_err() {
            return FlushStatus {
                all_wire_frames_sent: false,
                continued: false,
            };
        }
        state
            .metrics
            .bytes_sent
            .fetch_add(len as u64, Ordering::Relaxed);
        sent_frames += 1;

        if is_delta && let Some(ref mut tracker) = ttft {
            tracker.record_once(&state.metrics);
        }

        if is_delta
            && let Some(ref mut p) = pacer
            && per_frame_sem_bytes > 0
        {
            let delay = p.next_chunk_delay(per_frame_sem_bytes);
            if !delay.is_zero() {
                tokio::select! {
                    _ = state.shutdown.cancelled() => return FlushStatus {
                        all_wire_frames_sent: sent_frames == total_frames,
                        continued: false,
                    },
                    _ = tokio::time::sleep(delay) => {}
                }
            }
        }
    }
    FlushStatus {
        all_wire_frames_sent: true,
        continued: true,
    }
}
