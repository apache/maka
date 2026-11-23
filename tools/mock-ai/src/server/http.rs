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

use super::admin::handle_admin;
use super::{
    ActiveStreamGuard, BoxBody, FlushStatus, PendingWsUpgrade, ServerState, TtftTracker,
    TurnCloseGuard, classify_protocol, collect_headers, default_response_id, error_http_response,
    extract_stored_response_id, full_json, is_responses_path, is_semantic_delta_frame, jitter_ms,
    json_with_headers, pacer_seed_for, plan_usage_hint, semantic_event_bytes, spawn_tracked,
    sse_response,
};
use crate::codec::{WireFrame, create_encoder};
use crate::handler::{InteractiveMeta, TurnContext, TurnDecision};
use crate::pacing::{LatencyProfile, TurnPacer};
use crate::plan::{CloseSignal, FinishReason, HttpErrorSpec, TurnEvent, Usage};
use crate::protocol::{NormalizedRequest, Protocol, Transport, normalize_request};
#[cfg(feature = "proxy")]
use crate::proxy::{ReplayConfig, fingerprint_from_normalized};
use crate::ratelimit::{RateLimitDecision, RateLimitHeaders, RateLimitLease};
use crate::schema_synth::{WirePoisonConfig, poison_sse_frame};
use bytes::Bytes;
#[cfg(feature = "proxy")]
use http_body_util::StreamBody;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::{Frame, Incoming};
use hyper::header::{self, HeaderName, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;

pub(super) async fn handle_http_request(
    mut req: Request<Incoming>,
    state: Arc<ServerState>,
    pending_upgrade: Arc<Mutex<Option<PendingWsUpgrade>>>,
) -> Response<BoxBody> {
    let method = req.method().clone();
    let path = req.uri().path().to_owned();
    let query = req.uri().query().map(str::to_owned);
    #[cfg(feature = "proxy")]
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_owned())
        .unwrap_or_else(|| path.clone());
    let headers = collect_headers(req.headers());

    // 1) Prometheus /metrics and Admin routes (do not require provider API key)
    if method == Method::GET && path == "/metrics" {
        let body = state
            .metrics
            .render_prometheus(state.watchdog.total_violations());
        let bytes = Bytes::from(body);
        return Response::builder()
            .status(StatusCode::OK)
            .header(
                header::CONTENT_TYPE,
                "text/plain; version=0.0.4; charset=utf-8",
            )
            .header(header::CONTENT_LENGTH, bytes.len())
            .body(
                Full::new(bytes)
                    .map_err(|never| match never {})
                    .boxed_unsync(),
            )
            .unwrap();
    }
    if state.control.enable_admin_api && path.starts_with("/admin/") {
        state
            .metrics
            .control_plane_requests
            .fetch_add(1, Ordering::Relaxed);
        return handle_admin(method, &path, req, state).await;
    }

    // 2) Auth check for provider endpoints
    if !state.auth.verify(&headers) {
        let proto = classify_protocol(&path).unwrap_or(Protocol::OpenaiChatCompletions);
        return error_http_response(
            proto,
            &HttpErrorSpec::new(401, "authentication_error", "invalid API key"),
            &state.metrics,
        );
    }

    // 3) Responses WebSocket Upgrade on GET /v1/responses or /responses
    let is_ws_upgrade = headers
        .get("upgrade")
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    if is_ws_upgrade && is_responses_path(&path) {
        if let Some(reject_status) = state.tuning.reject_websocket_upgrade_status {
            return error_http_response(
                Protocol::OpenaiResponsesWs,
                &HttpErrorSpec::new(
                    reject_status,
                    "websocket_unavailable",
                    "WebSocket upgrade rejected by mock server configuration",
                ),
                &state.metrics,
            );
        }
        let Some(ws_key) = headers.get("sec-websocket-key") else {
            return full_json(
                StatusCode::BAD_REQUEST,
                &json!({ "error": { "message": "missing Sec-WebSocket-Key" } }),
            );
        };
        #[cfg(feature = "proxy")]
        let proxied_upstream = if let Some(ref proxy) = state.proxy_recorder {
            match proxy.connect_upstream_ws(&path_and_query, &headers).await {
                Ok(upstream_ws) => Some(upstream_ws),
                Err(err) => {
                    return full_json(
                        StatusCode::BAD_GATEWAY,
                        &json!({ "error": { "type": "proxy_error", "message": err } }),
                    );
                }
            }
        } else {
            None
        };
        let accept = derive_accept_key(ws_key.as_bytes());
        *pending_upgrade.lock().unwrap() = Some(PendingWsUpgrade {
            on_upgrade: hyper::upgrade::on(&mut req),
            path,
            #[cfg(feature = "proxy")]
            path_and_query,
            headers,
            #[cfg(feature = "proxy")]
            proxied_upstream,
        });
        state.metrics.ws_upgrades.fetch_add(1, Ordering::Relaxed);
        return Response::builder()
            .status(StatusCode::SWITCHING_PROTOCOLS)
            .header(header::CONNECTION, "upgrade")
            .header(header::UPGRADE, "websocket")
            .header("sec-websocket-accept", accept)
            .body(
                Full::new(Bytes::new())
                    .map_err(|never| match never {})
                    .boxed_unsync(),
            )
            .unwrap();
    }

    // 4) Read request body (supports chunked/streaming upload without requiring Content-Length)
    let body_bytes = match Limited::new(req.into_body(), state.tuning.max_request_bytes)
        .collect()
        .await
    {
        Ok(collected) => collected.to_bytes(),
        Err(err) => {
            return full_json(
                StatusCode::PAYLOAD_TOO_LARGE,
                &json!({ "error": { "message": format!("request body read error: {err}") } }),
            );
        }
    };

    // 4b) Transparent HTTP proxy-record mode (forwards all provider endpoints to upstream & records cassette)
    #[cfg(feature = "proxy")]
    if let Some(ref proxy) = state.proxy_recorder {
        state.metrics.proxy_requests.fetch_add(1, Ordering::Relaxed);
        let proto = (method == Method::POST)
            .then(|| classify_protocol(&path))
            .flatten();
        match proxy
            .forward_http(
                method.as_str(),
                &path_and_query,
                proto,
                &headers,
                body_bytes,
                state.shutdown.clone(),
            )
            .await
        {
            Ok(proxied) => {
                let metrics = state.metrics.clone();
                let rx = proxied.rx;
                let stream = futures_util::stream::unfold(rx, move |mut rx| {
                    let metrics = metrics.clone();
                    async move {
                        let item = rx.recv().await?;
                        let mapped = match item {
                            Ok(bytes) => {
                                metrics
                                    .bytes_sent
                                    .fetch_add(bytes.len() as u64, Ordering::Relaxed);
                                Ok(Frame::data(bytes))
                            }
                            Err(msg) => Err(io::Error::other(msg)),
                        };
                        Some((mapped, rx))
                    }
                });
                let mut builder = Response::builder().status(
                    StatusCode::from_u16(proxied.status).unwrap_or(StatusCode::BAD_GATEWAY),
                );
                for (k, v) in proxied.headers {
                    if let (Ok(name), Ok(val)) = (
                        HeaderName::from_bytes(k.as_bytes()),
                        HeaderValue::from_str(&v),
                    ) {
                        builder = builder.header(name, val);
                    }
                }
                return builder
                    .body(StreamBody::new(stream).boxed_unsync())
                    .unwrap();
            }
            Err(err) => {
                return full_json(
                    StatusCode::BAD_GATEWAY,
                    &json!({ "error": { "type": "proxy_error", "message": err } }),
                );
            }
        }
    }

    // 5) Custom dynamic route hook (runs BEFORE built-in control-plane & generation routes so
    // tests can override /v1/models, add static scripts, or emit custom status/headers)
    if let Some(custom) = &state.custom_route
        && let Some(resp) = custom(method.as_str(), &path, &headers, &body_bytes)
    {
        state
            .metrics
            .control_plane_requests
            .fetch_add(1, Ordering::Relaxed);
        state
            .recorder
            .record_control(method.as_str(), &path, query.as_deref(), &headers);
        let bytes = Bytes::from(resp.body);
        let mut builder = Response::builder()
            .status(StatusCode::from_u16(resp.status).unwrap_or(StatusCode::OK))
            .header(header::CONTENT_LENGTH, bytes.len());
        for (k, v) in &resp.headers {
            if let (Ok(name), Ok(val)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(v),
            ) {
                builder = builder.header(name, val);
            }
        }
        return builder
            .body(
                Full::new(bytes)
                    .map_err(|never| match never {})
                    .boxed_unsync(),
            )
            .unwrap();
    }

    // 6) Control plane GET/DELETE endpoints
    if method == Method::GET {
        if path == "/v1/models" || path == "/models" || path.ends_with("/models") {
            state
                .metrics
                .control_plane_requests
                .fetch_add(1, Ordering::Relaxed);
            state
                .recorder
                .record_control(method.as_str(), &path, query.as_deref(), &headers);
            let page = state.control.render_models_page(query.as_deref());
            return full_json(StatusCode::OK, &page);
        }
        if let Some(id) = extract_stored_response_id(&path) {
            state
                .metrics
                .control_plane_requests
                .fetch_add(1, Ordering::Relaxed);
            state
                .recorder
                .record_control(method.as_str(), &path, query.as_deref(), &headers);
            return match state.stored_responses.get(id) {
                Some(resp) => full_json(StatusCode::OK, &resp),
                None => full_json(
                    StatusCode::NOT_FOUND,
                    &json!({ "error": { "type": "not_found", "message": format!("response '{id}' not found") } }),
                ),
            };
        }
        if (path == "/api/usage/token/" || path == "/api/usage/token")
            && let Some(payload) = &state.control.relay_token_usage
        {
            state
                .metrics
                .control_plane_requests
                .fetch_add(1, Ordering::Relaxed);
            state
                .recorder
                .record_control(method.as_str(), &path, query.as_deref(), &headers);
            return full_json(StatusCode::OK, payload);
        }
        if path == "/v1/usage"
            && let Some(payload) = &state.control.v1_usage
        {
            state
                .metrics
                .control_plane_requests
                .fetch_add(1, Ordering::Relaxed);
            state
                .recorder
                .record_control(method.as_str(), &path, query.as_deref(), &headers);
            return full_json(StatusCode::OK, payload);
        }
        if let Some(payload) = state.control.extra_get_routes.get(&path) {
            state
                .metrics
                .control_plane_requests
                .fetch_add(1, Ordering::Relaxed);
            state
                .recorder
                .record_control(method.as_str(), &path, query.as_deref(), &headers);
            return full_json(StatusCode::OK, payload);
        }
    }

    if method == Method::DELETE
        && let Some(id) = extract_stored_response_id(&path)
    {
        state
            .metrics
            .control_plane_requests
            .fetch_add(1, Ordering::Relaxed);
        state
            .recorder
            .record_control(method.as_str(), &path, query.as_deref(), &headers);
        let deleted = state.stored_responses.delete(id);
        return if deleted {
            full_json(
                StatusCode::OK,
                &json!({ "id": id, "object": "response.deleted", "deleted": true }),
            )
        } else {
            full_json(
                StatusCode::NOT_FOUND,
                &json!({ "error": { "type": "not_found", "message": format!("response '{id}' not found") } }),
            )
        };
    }

    // 7) Generation routes (POST /v1/chat/completions, /v1/responses, /v1/messages)
    let Some(protocol) = (method == Method::POST)
        .then(|| classify_protocol(&path))
        .flatten()
    else {
        return full_json(
            StatusCode::NOT_FOUND,
            &json!({ "error": { "type": "not_found", "message": format!("unknown route: {method} {path}") } }),
        );
    };

    let raw_body: Value = match serde_json::from_slice(&body_bytes) {
        Ok(val) => val,
        Err(err) => {
            return error_http_response(
                protocol,
                &HttpErrorSpec::new(
                    400,
                    "invalid_request_error",
                    format!("malformed JSON request body: {err}"),
                ),
                &state.metrics,
            );
        }
    };

    let seq = state.next_sequence();
    let normalized = normalize_request(
        seq,
        protocol,
        Transport::Http,
        path,
        headers,
        body_bytes.len(),
        raw_body,
    );
    let turn_started = Instant::now();
    state
        .metrics
        .record_protocol(protocol, normalized.prompt_bytes);
    state.recorder.record(&normalized);
    state.watchdog.inspect_request(&normalized);

    let effective_profile = state.profile.effective();

    // Stateful rate-limit admission (RPM, ITPM, concurrency slots)
    let (rl_headers, rl_lease) = match state.rate_limiter.check_and_acquire(
        normalized.api_key(),
        &normalized.model,
        normalized.estimated_input_tokens,
        effective_profile.rate_limit_override.as_ref(),
    ) {
        RateLimitDecision::Allowed { headers, lease } => (headers, lease),
        RateLimitDecision::Rejected {
            retry_after_ms,
            reason,
            headers,
        } => {
            let mut spec = HttpErrorSpec::rate_limit(
                Some(retry_after_ms.div_ceil(1000).max(1)),
                format!("rate limit exceeded ({reason})"),
            )
            .with_retry_after_ms(retry_after_ms);
            for (k, v) in headers.to_header_pairs() {
                spec.headers.insert(k.to_string(), v);
            }
            state.metrics.record_dimension(
                protocol,
                &normalized.model,
                "429",
                normalized.estimated_input_tokens,
                0,
                0,
                None,
                Some(turn_started.elapsed().as_millis() as u64),
            );
            return error_http_response(protocol, &spec, &state.metrics);
        }
    };

    // Cassette replay mode (checked before strict previous_response_id so multi-turn recorded
    // Responses HTTP cassettes replay faithfully without pre-populating stored_responses, while
    // still rejecting requests whose previous_response_id disagrees with the recorded exchange).
    #[cfg(feature = "proxy")]
    if let Some(ref replayer) = state.cassette_replayer {
        let fp = fingerprint_from_normalized(&normalized);
        let strict_prev =
            protocol == Protocol::OpenaiResponsesHttp && state.tuning.strict_previous_response_id;
        let expected_prev = normalized.previous_response_id.as_deref();
        if let Some(ex) = replayer
            .next_http_if(&fp, |candidate| {
                !strict_prev
                    || expected_prev == candidate.request_body["previous_response_id"].as_str()
            })
            .cloned()
        {
            state.metrics.replay_hits.fetch_add(1, Ordering::Relaxed);
            return execute_http_replay(
                normalized,
                ex,
                replayer.config().clone(),
                rl_headers,
                rl_lease,
                turn_started,
                state,
            );
        }
    }

    // Strict previous_response_id check for HTTP Responses
    if protocol == Protocol::OpenaiResponsesHttp
        && state.tuning.strict_previous_response_id
        && let Some(prev_id) = &normalized.previous_response_id
        && !state.stored_responses.contains(prev_id)
    {
        state
            .watchdog
            .record_invalid_previous_response_id(&normalized, prev_id);
        state.metrics.record_dimension(
            protocol,
            &normalized.model,
            "400",
            normalized.estimated_input_tokens,
            0,
            0,
            None,
            Some(turn_started.elapsed().as_millis() as u64),
        );
        return error_http_response(
            protocol,
            &HttpErrorSpec {
                status: 400,
                error_type: "invalid_request_error".into(),
                code: Some("previous_response_not_found".into()),
                message: format!("previous_response_id '{prev_id}' not found"),
                retry_after_secs: None,
                retry_after_ms: None,
                headers: BTreeMap::new(),
                raw_body: None,
                raw_text: None,
                content_type: None,
            },
            &state.metrics,
        );
    }

    let session_turn = state.sessions.next_turn(&normalized.session_key);
    let ctx = TurnContext {
        global_turn: seq,
        session_turn,
        chaos_override: effective_profile.chaos_override.clone(),
    };

    let decision = match state.handler.handle(&normalized, &ctx).await {
        Some(d) => d,
        None => {
            return error_http_response(
                protocol,
                &HttpErrorSpec::new(
                    500,
                    "mock_handler_exhausted",
                    "no handler matched or scripted queue was exhausted",
                ),
                &state.metrics,
            );
        }
    };

    let store_flag = normalized.raw_body["store"].as_bool().unwrap_or(true);
    execute_http_turn(
        normalized,
        decision,
        store_flag,
        effective_profile.latency,
        rl_headers,
        rl_lease,
        turn_started,
        state,
    )
    .await
}

#[cfg(feature = "proxy")]
fn execute_http_replay(
    req: NormalizedRequest,
    exchange: crate::proxy::RecordedExchange,
    replay_cfg: ReplayConfig,
    rl_headers: RateLimitHeaders,
    rl_lease: Option<RateLimitLease>,
    turn_started: Instant,
    state: Arc<ServerState>,
) -> Response<BoxBody> {
    let (tx, rx) = mpsc::channel::<Result<Frame<Bytes>, io::Error>>(16);
    let mut headers = exchange.response_headers.clone();
    for (k, v) in rl_headers.to_header_pairs() {
        headers.insert(k.to_string(), v);
    }
    let status = StatusCode::from_u16(exchange.status).unwrap_or(StatusCode::OK);
    let state_clone = state.clone();

    spawn_tracked(state, async move {
        let _lease = rl_lease;
        state_clone
            .metrics
            .active_streams
            .fetch_add(1, Ordering::Relaxed);
        let _guard = ActiveStreamGuard(state_clone.metrics.clone());
        let mut first_recorded: Option<u64> = None;

        for chunk in exchange.chunks {
            let delay = replay_cfg.scaled_delay(chunk.delay_ms);
            if !delay.is_zero() {
                tokio::select! {
                    _ = state_clone.shutdown.cancelled() => break,
                    _ = tx.closed() => break,
                    _ = tokio::time::sleep(delay) => {}
                }
            }
            let bytes = chunk.to_bytes();
            let len = bytes.len();
            if tx.send(Ok(Frame::data(bytes))).await.is_err() {
                break;
            }
            if first_recorded.is_none() {
                let ttft = turn_started.elapsed().as_millis() as u64;
                state_clone.metrics.ttft_ms.record(ttft);
                first_recorded = Some(ttft);
            }
            state_clone
                .metrics
                .bytes_sent
                .fetch_add(len as u64, Ordering::Relaxed);
        }
        let dur = turn_started.elapsed().as_millis() as u64;
        state_clone.metrics.turn_duration_ms.record(dur);
        state_clone.metrics.record_dimension(
            req.protocol,
            &req.model,
            &status.as_u16().to_string(),
            req.estimated_input_tokens,
            0,
            0,
            first_recorded,
            Some(dur),
        );
    });

    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|item| (item, rx))
    });
    let mut builder = Response::builder().status(status);
    for (k, v) in &headers {
        if let (Ok(name), Ok(val)) = (
            HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(v),
        ) {
            builder = builder.header(name, val);
        }
    }
    builder
        .body(StreamBody::new(stream).boxed_unsync())
        .unwrap()
}

enum HttpEventFeed {
    Plan {
        events: std::vec::IntoIter<TurnEvent>,
        inferred_finish: FinishReason,
    },
    Interactive {
        pending: Option<Box<TurnEvent>>,
        rx: mpsc::UnboundedReceiver<TurnEvent>,
    },
}

impl HttpEventFeed {
    fn is_plan(&self) -> bool {
        matches!(self, Self::Plan { .. })
    }

    fn auto_finish_reason(&self) -> Option<FinishReason> {
        match self {
            Self::Plan {
                inferred_finish, ..
            } => Some(inferred_finish.clone()),
            Self::Interactive { .. } => None,
        }
    }

    async fn next_event(
        &mut self,
        shutdown: &tokio_util::sync::CancellationToken,
        tx_closed: Option<&mpsc::Sender<Result<Frame<Bytes>, io::Error>>>,
    ) -> FeedStep {
        match self {
            Self::Plan { events, .. } => {
                if shutdown.is_cancelled() || tx_closed.is_some_and(mpsc::Sender::is_closed) {
                    return FeedStep::Aborted;
                }
                match events.next() {
                    Some(ev) => FeedStep::Event(Box::new(ev)),
                    None => FeedStep::Ended,
                }
            }
            Self::Interactive { pending, rx } => {
                if let Some(ev) = pending.take() {
                    return FeedStep::Event(ev);
                }
                if let Some(tx) = tx_closed {
                    tokio::select! {
                        _ = shutdown.cancelled() => FeedStep::Aborted,
                        _ = tx.closed() => FeedStep::Aborted,
                        next = rx.recv() => match next {
                            Some(ev) => FeedStep::Event(Box::new(ev)),
                            None => FeedStep::Ended,
                        }
                    }
                } else {
                    tokio::select! {
                        _ = shutdown.cancelled() => FeedStep::Aborted,
                        next = rx.recv() => match next {
                            Some(ev) => FeedStep::Event(Box::new(ev)),
                            None => FeedStep::Ended,
                        }
                    }
                }
            }
        }
    }

    async fn wait_stall(
        &mut self,
        shutdown: &tokio_util::sync::CancellationToken,
        tx_closed: Option<&mpsc::Sender<Result<Frame<Bytes>, io::Error>>>,
    ) -> StallOutcome {
        match self {
            Self::Plan { .. } => {
                if let Some(tx) = tx_closed {
                    tokio::select! {
                        _ = shutdown.cancelled() => {}
                        _ = tx.closed() => {}
                    }
                } else {
                    shutdown.cancelled().await;
                }
                StallOutcome::Ended
            }
            Self::Interactive { pending, rx } => {
                let rx_closed = if let Some(tx) = tx_closed {
                    tokio::select! {
                        _ = shutdown.cancelled() => return StallOutcome::Ended,
                        _ = tx.closed() => return StallOutcome::Ended,
                        next = rx.recv() => match next {
                            Some(ev) => {
                                *pending = Some(Box::new(ev));
                                return StallOutcome::Resumed;
                            }
                            None => true,
                        }
                    }
                } else {
                    tokio::select! {
                        _ = shutdown.cancelled() => return StallOutcome::Ended,
                        next = rx.recv() => match next {
                            Some(ev) => {
                                *pending = Some(Box::new(ev));
                                return StallOutcome::Resumed;
                            }
                            None => true,
                        }
                    }
                };
                // Once TurnHandle is dropped (e.g. via send_plan(TurnPlan::stall())),
                // keep stalling until client disconnect or server shutdown, matching Plan::Stall.
                if rx_closed {
                    if let Some(tx) = tx_closed {
                        tokio::select! {
                            _ = shutdown.cancelled() => {}
                            _ = tx.closed() => {}
                        }
                    } else {
                        shutdown.cancelled().await;
                    }
                }
                StallOutcome::Ended
            }
        }
    }
}

enum FeedStep {
    Event(Box<TurnEvent>),
    Ended,
    Aborted,
}

enum StallOutcome {
    Resumed,
    Ended,
}

#[allow(clippy::too_many_arguments)]
async fn execute_http_turn(
    req: NormalizedRequest,
    decision: TurnDecision,
    store_flag: bool,
    latency_profile: LatencyProfile,
    rl_headers: RateLimitHeaders,
    mut rl_lease: Option<RateLimitLease>,
    turn_started: Instant,
    state: Arc<ServerState>,
) -> Response<BoxBody> {
    let (mut feed, meta, pre_usage, usage_hint, mut pacer, ttft_dur, close_guard) = match decision {
        TurnDecision::Plan(plan) => {
            let close_guard = TurnCloseGuard(plan.on_close.clone());
            // Handle pre-stream HTTP error (including optional leading Delay before error).
            for (idx, ev) in plan.events.iter().enumerate() {
                match ev {
                    TurnEvent::Delay { ms } if idx == 0 => {
                        tokio::select! {
                            _ = state.shutdown.cancelled() => break,
                            _ = tokio::time::sleep(Duration::from_millis(*ms)) => {}
                        }
                    }
                    TurnEvent::HttpError(spec) => {
                        return finish_http_error(&req, spec, &rl_headers, turn_started, &state);
                    }
                    _ => break,
                }
            }

            let inferred_finish = plan.inferred_finish_reason();
            let usage_hint = plan_usage_hint(&plan, &req);
            let cached_tokens = usage_hint.cache_read_tokens.unwrap_or(0);
            let uncached_tokens = usage_hint.input_tokens.saturating_sub(cached_tokens);
            let in_flight_sample = state.metrics.active_streams.load(Ordering::Relaxed) + 1;
            let mut pacer = TurnPacer::new(
                latency_profile,
                pacer_seed_for(&req),
                in_flight_sample,
                plan.ttft_ms,
                (plan.chunk_delay_ms > 0).then_some(plan.chunk_delay_ms),
            );
            let ttft_dur = pacer.compute_ttft(uncached_tokens, cached_tokens);
            let pre_usage = plan.events.iter().find_map(|ev| match ev {
                TurnEvent::Usage(u) => Some(u.clone()),
                _ => None,
            });
            let meta = InteractiveMeta {
                response_id: plan.response_id,
                model_override: plan.model_override,
                response_headers: plan.response_headers,
                close_connection: plan.close_connection,
                wire_poison: plan.wire_poison,
            };
            let feed = HttpEventFeed::Plan {
                events: plan.events.into_iter(),
                inferred_finish,
            };
            (
                feed,
                meta,
                pre_usage,
                usage_hint,
                Some(pacer),
                ttft_dur,
                close_guard,
            )
        }
        TurnDecision::Interactive(mut stream) => {
            let close_guard = TurnCloseGuard(Some(CloseSignal(stream.closed.clone())));
            // Wait for the first event before committing HTTP headers so TurnHandle::http_error works
            // and so TurnHandle metadata setters (response_id, headers, close_connection) take effect.
            let first = tokio::select! {
                _ = state.shutdown.cancelled() => {
                    return full_json(
                        StatusCode::SERVICE_UNAVAILABLE,
                        &json!({ "error": { "message": "server shutting down" } }),
                    );
                }
                ev = stream.events.recv() => ev,
            };
            let Some(first_event) = first else {
                return finish_http_error(
                    &req,
                    &HttpErrorSpec::new(
                        500,
                        "mock_aborted",
                        "interactive TurnHandle dropped before reply",
                    ),
                    &rl_headers,
                    turn_started,
                    &state,
                );
            };
            if let TurnEvent::HttpError(spec) = first_event {
                return finish_http_error(&req, &spec, &rl_headers, turn_started, &state);
            }
            let meta = stream.meta.lock().unwrap().clone();
            let usage_hint = Usage::new(req.estimated_input_tokens.max(1), 0);
            let feed = HttpEventFeed::Interactive {
                pending: Some(Box::new(first_event)),
                rx: stream.events,
            };
            (
                feed,
                meta,
                None,
                usage_hint,
                None,
                Duration::ZERO,
                close_guard,
            )
        }
    };

    let response_id = meta
        .response_id
        .unwrap_or_else(|| default_response_id(req.protocol, req.sequence));
    let model = meta.model_override.unwrap_or_else(|| req.model.clone());
    let mut response_headers = meta.response_headers;
    for (k, v) in rl_headers.to_header_pairs() {
        response_headers.entry(k.to_string()).or_insert(v);
    }
    let close_connection = meta.close_connection;
    let wire_poison = meta.wire_poison;

    // 1) Non-streaming JSON HTTP response (unified for both Plan and Interactive!)
    if !req.stream {
        let _close_guard = close_guard;
        if !ttft_dur.is_zero() {
            tokio::select! {
                _ = state.shutdown.cancelled() => {}
                _ = tokio::time::sleep(ttft_dur) => {}
            }
        }
        let mut encoder = create_encoder(req.protocol, response_id, model.clone(), false);
        let mut scratch = Vec::new();
        if let Some(u) = pre_usage {
            encoder.push_event(TurnEvent::Usage(u), &mut scratch);
        }
        let mut emitted_tool_ids = Vec::new();
        let mut emitted_compaction = false;
        let mut semantic_output_bytes = 0usize;
        let mut final_usage = usage_hint;

        loop {
            match feed.next_event(&state.shutdown, None).await {
                FeedStep::Aborted | FeedStep::Ended => break,
                FeedStep::Event(ev) => {
                    let ev = *ev;
                    semantic_output_bytes += semantic_event_bytes(&ev);
                    match ev {
                        TurnEvent::Delay { ms } => {
                            tokio::select! {
                                _ = state.shutdown.cancelled() => break,
                                _ = tokio::time::sleep(Duration::from_millis(ms)) => {}
                            }
                        }
                        TurnEvent::JitterDelay { min_ms, max_ms } => {
                            let ms = jitter_ms(min_ms, max_ms);
                            if ms > 0 {
                                tokio::select! {
                                    _ = state.shutdown.cancelled() => break,
                                    _ = tokio::time::sleep(Duration::from_millis(ms)) => {}
                                }
                            }
                        }
                        TurnEvent::Stall => {
                            state.metrics.stalls_entered.fetch_add(1, Ordering::Relaxed);
                            if matches!(
                                feed.wait_stall(&state.shutdown, None).await,
                                StallOutcome::Ended
                            ) {
                                break;
                            }
                        }
                        TurnEvent::HttpError(spec) => {
                            return finish_http_error(
                                &req,
                                &spec,
                                &rl_headers,
                                turn_started,
                                &state,
                            );
                        }
                        TurnEvent::Usage(u) => {
                            final_usage = u.clone();
                            encoder.push_event(TurnEvent::Usage(u), &mut scratch);
                        }
                        TurnEvent::ToolCall(tc) => {
                            emitted_tool_ids.push(tc.id.clone());
                            encoder.push_event(TurnEvent::ToolCall(tc), &mut scratch);
                        }
                        TurnEvent::NativeCompaction(c) => {
                            emitted_compaction = true;
                            state
                                .metrics
                                .native_compactions_emitted
                                .fetch_add(1, Ordering::Relaxed);
                            encoder.push_event(TurnEvent::NativeCompaction(c), &mut scratch);
                        }
                        TurnEvent::Finish { reason } => {
                            let completion = encoder.finish(reason, &mut scratch);
                            return complete_non_streaming(
                                &req,
                                &model,
                                completion,
                                store_flag,
                                &final_usage,
                                semantic_output_bytes,
                                &emitted_tool_ids,
                                emitted_compaction,
                                &response_headers,
                                close_connection,
                                &mut rl_lease,
                                turn_started,
                                &state,
                            );
                        }
                        TurnEvent::DropConnection | TurnEvent::TruncateEof => {
                            return finish_http_error(
                                &req,
                                &HttpErrorSpec::new(500, "connection_error", "connection aborted"),
                                &rl_headers,
                                turn_started,
                                &state,
                            );
                        }
                        other => encoder.push_event(other, &mut scratch),
                    }
                }
            }
        }

        let finish_reason = feed.auto_finish_reason().unwrap_or(FinishReason::Stop);
        let completion = encoder.finish(finish_reason, &mut scratch);
        return complete_non_streaming(
            &req,
            &model,
            completion,
            store_flag,
            &final_usage,
            semantic_output_bytes,
            &emitted_tool_ids,
            emitted_compaction,
            &response_headers,
            close_connection,
            &mut rl_lease,
            turn_started,
            &state,
        );
    }

    // 2) Streaming SSE HTTP response (unified for both Plan and Interactive!)
    let (tx, rx) = mpsc::channel::<Result<Frame<Bytes>, io::Error>>(16);
    let protocol = req.protocol;
    let state_clone = state.clone();
    let ping_interval = pacer.as_ref().and_then(TurnPacer::sse_ping_interval);

    spawn_tracked(state, async move {
        let mut lease = rl_lease;
        state_clone
            .metrics
            .active_streams
            .fetch_add(1, Ordering::Relaxed);
        let _guard = ActiveStreamGuard(state_clone.metrics.clone());
        let _close_guard = close_guard;

        let mut encoder = create_encoder(protocol, response_id, model.clone(), true);
        let mut frames = Vec::new();
        let mut frame_seq = 0usize;
        let mut first_delta_at: Option<Instant> = None;
        let mut recorded_ttft_ms: Option<u64> = None;
        let mut emitted_semantic_bytes = 0usize;
        let mut emitted_tool_ids: Vec<String> = Vec::new();
        let mut emitted_compaction = false;
        let mut final_usage = usage_hint;

        // Dynamic TTFT wait with optional SSE keep-alive ping comments.
        let mut aborted = false;
        if !ttft_dur.is_zero() {
            let deadline = tokio::time::Instant::now() + ttft_dur;
            loop {
                let now = tokio::time::Instant::now();
                if now >= deadline {
                    break;
                }
                let remaining = deadline - now;
                let step = ping_interval.map_or(remaining, |p| remaining.min(p));
                tokio::select! {
                    _ = state_clone.shutdown.cancelled() => { aborted = true; break; }
                    _ = tx.closed() => { aborted = true; break; }
                    _ = tokio::time::sleep(step) => {
                        if ping_interval.is_some() && tokio::time::Instant::now() < deadline {
                            let ping = if wire_poison.crlf_line_endings {
                                Bytes::from_static(b": keep-alive\r\n\r\n")
                            } else {
                                Bytes::from_static(b": keep-alive\n\n")
                            };
                            if tx.send(Ok(Frame::data(ping))).await.is_err() {
                                aborted = true;
                                break;
                            }
                        }
                    }
                }
            }
        }

        // Pre-feed Usage so Anthropic message_start has exact input/cache tokens.
        if !aborted && let Some(u) = pre_usage {
            encoder.push_event(TurnEvent::Usage(u), &mut frames);
        }

        let mut explicit_finish = false;
        let mut intentional_fault = false;

        if !aborted {
            loop {
                let ev = match feed.next_event(&state_clone.shutdown, Some(&tx)).await {
                    FeedStep::Event(ev) => *ev,
                    FeedStep::Ended => break,
                    FeedStep::Aborted => {
                        aborted = true;
                        break;
                    }
                };
                let ev_sem_bytes = semantic_event_bytes(&ev);
                match ev {
                    TurnEvent::Delay { ms } => {
                        tokio::select! {
                            _ = state_clone.shutdown.cancelled() => { aborted = true; break; }
                            _ = tx.closed() => { aborted = true; break; }
                            _ = tokio::time::sleep(Duration::from_millis(ms)) => {}
                        }
                    }
                    TurnEvent::JitterDelay { min_ms, max_ms } => {
                        let ms = jitter_ms(min_ms, max_ms);
                        if ms > 0 {
                            tokio::select! {
                                _ = state_clone.shutdown.cancelled() => { aborted = true; break; }
                                _ = tx.closed() => { aborted = true; break; }
                                _ = tokio::time::sleep(Duration::from_millis(ms)) => {}
                            }
                        }
                    }
                    TurnEvent::Stall => {
                        state_clone
                            .metrics
                            .stalls_entered
                            .fetch_add(1, Ordering::Relaxed);
                        match feed.wait_stall(&state_clone.shutdown, Some(&tx)).await {
                            StallOutcome::Resumed => continue,
                            StallOutcome::Ended => {
                                intentional_fault = true;
                                aborted = true;
                                break;
                            }
                        }
                    }
                    TurnEvent::DropConnection => {
                        state_clone
                            .metrics
                            .connection_drops_emitted
                            .fetch_add(1, Ordering::Relaxed);
                        intentional_fault = true;
                        let _ = tx
                            .send(Err(io::Error::new(
                                io::ErrorKind::ConnectionReset,
                                "mock-ai simulated connection drop",
                            )))
                            .await;
                        aborted = true;
                        break;
                    }
                    TurnEvent::TruncateEof => {
                        intentional_fault = true;
                        aborted = true;
                        break;
                    }
                    TurnEvent::MidStreamError(err) => {
                        state_clone
                            .metrics
                            .mid_stream_errors_emitted
                            .fetch_add(1, Ordering::Relaxed);
                        intentional_fault = true;
                        encoder.push_event(TurnEvent::MidStreamError(err), &mut frames);
                        if !flush_http_frames(
                            &tx,
                            &mut frames,
                            None,
                            0,
                            None,
                            &wire_poison,
                            &mut frame_seq,
                            &state_clone,
                        )
                        .await
                        {
                            aborted = true;
                            break;
                        }
                        explicit_finish = true;
                        break;
                    }
                    TurnEvent::Finish { reason } => {
                        let completion = encoder.finish(reason, &mut frames);
                        if protocol.is_responses() && store_flag {
                            state_clone
                                .stored_responses
                                .put(completion.response_id, completion.response_json);
                        }
                        if !flush_http_frames(
                            &tx,
                            &mut frames,
                            None,
                            0,
                            None,
                            &wire_poison,
                            &mut frame_seq,
                            &state_clone,
                        )
                        .await
                        {
                            aborted = true;
                            break;
                        }
                        explicit_finish = true;
                        break;
                    }
                    TurnEvent::NativeCompaction(c) => {
                        state_clone
                            .metrics
                            .native_compactions_emitted
                            .fetch_add(1, Ordering::Relaxed);
                        encoder.push_event(TurnEvent::NativeCompaction(c), &mut frames);
                        let mut ttft = TtftTracker {
                            turn_started,
                            first_delta_at: &mut first_delta_at,
                            recorded_ttft_ms: &mut recorded_ttft_ms,
                        };
                        let status = flush_http_frames_detailed(
                            &tx,
                            &mut frames,
                            pacer.as_mut(),
                            ev_sem_bytes,
                            Some(&mut ttft),
                            &wire_poison,
                            &mut frame_seq,
                            &state_clone,
                        )
                        .await;
                        if status.all_wire_frames_sent {
                            emitted_compaction = true;
                            emitted_semantic_bytes += ev_sem_bytes;
                        }
                        if !status.continued {
                            aborted = true;
                            break;
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
                        let status = flush_http_frames_detailed(
                            &tx,
                            &mut frames,
                            pacer.as_mut(),
                            ev_sem_bytes,
                            Some(&mut ttft),
                            &wire_poison,
                            &mut frame_seq,
                            &state_clone,
                        )
                        .await;
                        if status.all_wire_frames_sent {
                            if let Some(tid) = maybe_tool_id {
                                emitted_tool_ids.push(tid);
                            }
                            emitted_semantic_bytes += ev_sem_bytes;
                        }
                        if !status.continued {
                            aborted = true;
                            break;
                        }
                    }
                }
            }
        }

        if !aborted
            && !explicit_finish
            && !intentional_fault
            && !encoder.is_finished()
            && let Some(reason) = feed.auto_finish_reason()
        {
            let completion = encoder.finish(reason, &mut frames);
            if protocol.is_responses() && store_flag {
                state_clone
                    .stored_responses
                    .put(completion.response_id, completion.response_json);
            }
            if !flush_http_frames(
                &tx,
                &mut frames,
                None,
                0,
                None,
                &wire_poison,
                &mut frame_seq,
                &state_clone,
            )
            .await
            {
                aborted = true;
            }
        }

        let dur = turn_started.elapsed().as_millis() as u64;
        let out_toks = final_usage
            .output_tokens
            .max((emitted_semantic_bytes as u64) / 4);
        let cached_tokens = final_usage.cache_read_tokens.unwrap_or(0);
        if aborted && !intentional_fault {
            state_clone
                .metrics
                .abandoned_streams
                .fetch_add(1, Ordering::Relaxed);
            state_clone.watchdog.record_turn_outcome(
                &req,
                &emitted_tool_ids,
                emitted_compaction,
                false,
            );
            state_clone.metrics.record_dimension(
                protocol,
                &model,
                "aborted",
                final_usage.input_tokens,
                out_toks,
                cached_tokens,
                recorded_ttft_ms,
                Some(dur),
            );
        } else {
            state_clone.metrics.turn_duration_ms.record(dur);
            if let Some(first_at) = first_delta_at
                && out_toks > 0
            {
                let tps = ((out_toks as f64) / first_at.elapsed().as_secs_f64().max(0.001))
                    .round()
                    .max(1.0) as u64;
                state_clone.metrics.effective_tps.record(tps);
            }
            if let Some(ref mut l) = lease {
                l.debit_output_tokens(out_toks);
            }
            let status_label = if intentional_fault { "fault" } else { "200" };
            state_clone.metrics.record_dimension(
                protocol,
                &model,
                status_label,
                final_usage.input_tokens,
                out_toks,
                cached_tokens,
                recorded_ttft_ms,
                Some(dur),
            );
            let completed_cleanly = !intentional_fault && (explicit_finish || feed.is_plan());
            state_clone.watchdog.record_turn_outcome(
                &req,
                &emitted_tool_ids,
                emitted_compaction,
                completed_cleanly,
            );
        }
    });

    sse_response(rx, &response_headers, close_connection)
}

fn finish_http_error(
    req: &NormalizedRequest,
    spec: &HttpErrorSpec,
    rl_headers: &RateLimitHeaders,
    turn_started: Instant,
    state: &ServerState,
) -> Response<BoxBody> {
    let status_label = spec.status.to_string();
    let mut enriched = spec.clone();
    for (k, v) in rl_headers.to_header_pairs() {
        enriched.headers.entry(k.to_string()).or_insert(v);
    }
    state.metrics.record_dimension(
        req.protocol,
        &req.model,
        &status_label,
        req.estimated_input_tokens,
        0,
        0,
        None,
        Some(turn_started.elapsed().as_millis() as u64),
    );
    error_http_response(req.protocol, &enriched, &state.metrics)
}

#[allow(clippy::too_many_arguments)]
fn complete_non_streaming(
    req: &NormalizedRequest,
    model: &str,
    completion: crate::codec::TurnCompletion,
    store_flag: bool,
    usage: &Usage,
    semantic_output_bytes: usize,
    emitted_tool_ids: &[String],
    emitted_compaction: bool,
    response_headers: &BTreeMap<String, String>,
    close_connection: bool,
    rl_lease: &mut Option<RateLimitLease>,
    turn_started: Instant,
    state: &ServerState,
) -> Response<BoxBody> {
    if req.protocol.is_responses() && store_flag {
        state.stored_responses.put(
            completion.response_id.clone(),
            completion.response_json.clone(),
        );
    }
    let dur = turn_started.elapsed().as_millis() as u64;
    state.metrics.ttft_ms.record(dur);
    state.metrics.turn_duration_ms.record(dur);
    let out_toks = usage.output_tokens.max((semantic_output_bytes as u64) / 4);
    if let Some(lease) = rl_lease.as_mut() {
        lease.debit_output_tokens(out_toks);
    }
    state.metrics.record_dimension(
        req.protocol,
        model,
        "200",
        usage.input_tokens,
        out_toks,
        usage.cache_read_tokens.unwrap_or(0),
        Some(dur),
        Some(dur),
    );
    state
        .watchdog
        .record_turn_outcome(req, emitted_tool_ids, emitted_compaction, true);
    json_with_headers(
        completion.response_json,
        response_headers,
        close_connection,
        &state.metrics,
    )
}

#[allow(clippy::too_many_arguments)]
async fn flush_http_frames(
    tx: &mpsc::Sender<Result<Frame<Bytes>, io::Error>>,
    frames: &mut Vec<WireFrame>,
    pacer: Option<&mut TurnPacer>,
    semantic_bytes: usize,
    ttft: Option<&mut TtftTracker<'_>>,
    wire_poison: &WirePoisonConfig,
    frame_seq: &mut usize,
    state: &ServerState,
) -> bool {
    flush_http_frames_detailed(
        tx,
        frames,
        pacer,
        semantic_bytes,
        ttft,
        wire_poison,
        frame_seq,
        state,
    )
    .await
    .continued
}

#[allow(clippy::too_many_arguments)]
async fn flush_http_frames_detailed(
    tx: &mpsc::Sender<Result<Frame<Bytes>, io::Error>>,
    frames: &mut Vec<WireFrame>,
    mut pacer: Option<&mut TurnPacer>,
    semantic_bytes: usize,
    mut ttft: Option<&mut TtftTracker<'_>>,
    wire_poison: &WirePoisonConfig,
    frame_seq: &mut usize,
    state: &ServerState,
) -> FlushStatus {
    let total_frames = frames.len();
    let per_frame_sem_bytes = if semantic_bytes > 0 {
        (semantic_bytes / total_frames.max(1)).max(1)
    } else {
        0
    };
    let mut sent_frames = 0usize;
    for frame in frames.drain(..) {
        let raw_bytes = match frame {
            WireFrame::Sse(b) | WireFrame::Raw(b) => b,
            WireFrame::WsText(s) => Bytes::from(format!("data: {s}\n\n")),
        };
        let is_delta =
            semantic_bytes > 0 && is_semantic_delta_frame(&String::from_utf8_lossy(&raw_bytes));
        let chunks = if wire_poison.is_active() {
            let s = String::from_utf8_lossy(&raw_bytes).into_owned();
            poison_sse_frame(s, wire_poison, *frame_seq)
        } else {
            vec![raw_bytes]
        };
        *frame_seq = frame_seq.wrapping_add(1);

        for chunk in chunks {
            let len = chunk.len();
            if tx.send(Ok(Frame::data(chunk))).await.is_err() {
                return FlushStatus {
                    all_wire_frames_sent: false,
                    continued: false,
                };
            }
            state
                .metrics
                .bytes_sent
                .fetch_add(len as u64, Ordering::Relaxed);
        }
        sent_frames += 1;

        // Record TTFT right after first actual semantic delta frame is sent, BEFORE pacing sleep.
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
                    _ = tx.closed() => return FlushStatus {
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
