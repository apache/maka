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
    ActiveStreamGuard, Attempt, BoxBody, DeliveredItem, PendingWsUpgrade, ServerState,
    TurnCloseGuard, collect_headers, default_response_id, effective_history, endpoint_protocol,
    error_http_response, event_usage, full_json, initial_usage, jitter_ms, json_with_headers,
    spawn_tracked,
};
use crate::codec::{EncodedFrame, FrameKind, WireFrame};
use crate::handler::{CloseSignalGuard, InteractiveCommand, TurnDecision};
use crate::metrics::{AttemptOutcome, RequestPurpose};
use crate::pacing::{LatencyProfile, TurnPacer};
use crate::plan::{CloseSignal, FinishReason, HttpErrorSpec, TurnEvent, Usage};
use crate::protocol::{NormalizedRequest, Protocol, Transport, normalize_request};
#[cfg(feature = "proxy")]
use crate::proxy::{
    ExchangeKind, ReplayConfig, compute_fingerprint_for_lane, fingerprint_from_route,
};
use crate::ratelimit::{RateLimitDecision, RateLimitHeaders, RateLimitLease};
use crate::routing::{CompactKind, EndpointKind, ParsedRoute, RequestUse, ResponseId, parse_route};
use crate::schema_synth::{WirePoisonConfig, poison_sse_frame};
use crate::watchdog::HistorySize;
use bytes::Bytes;
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
    let started = Instant::now();
    let headers_ns = state.clock.elapsed_ns();
    let method = req.method().clone();
    let uri = req.uri().clone();
    let headers = collect_headers(req.headers());
    let is_ws_upgrade = headers
        .get("upgrade")
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    let route = parse_route(
        method.as_str(),
        uri.path(),
        uri.query(),
        is_ws_upgrade,
        &state.control.extra_get_routes,
    );

    match route.endpoint {
        EndpointKind::ScopedForbidden => {
            return full_json(
                StatusCode::FORBIDDEN,
                &json!({"error": format!("admin and metrics are unavailable under session scope: {}", route.raw_path)}),
            );
        }
        EndpointKind::Metrics => {
            let body = state.render_prometheus();
            let bytes = Bytes::from(body);
            return Response::builder()
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
        EndpointKind::Admin => {
            return if state.control.enable_admin_api {
                state
                    .metrics
                    .control_plane_requests
                    .fetch_add(1, Ordering::Relaxed);
                handle_admin(method, route.canonical_path, req, state).await
            } else {
                unknown_route(&state, &method, route.raw_path)
            };
        }
        _ => {}
    }

    let protocol = endpoint_protocol(&route.endpoint).unwrap_or(Protocol::OpenaiChatCompletions);
    let attempt = Attempt::new(&state, protocol, Transport::Http, started, headers_ns);
    let mut response = handle_provider_request(
        &mut req,
        &state,
        pending_upgrade,
        &method,
        &route,
        headers,
        &attempt,
    )
    .await;
    let status = response.status().as_u16();
    attempt.http_status(status);
    if status == 101 {
        return response;
    }
    let sse = response.extensions().get::<TrackedSse>().is_some();
    let semantic = !sse && attempt.expects_semantic_body();
    let delivery = response.extensions_mut().remove::<NonStreamDelivery>();
    response.map(|inner| {
        AttemptBody {
            inner,
            attempt,
            sse,
            semantic,
            delivery,
        }
        .boxed_unsync()
    })
}

#[allow(clippy::too_many_arguments)]
async fn handle_provider_request(
    req: &mut Request<Incoming>,
    state: &Arc<ServerState>,
    pending_upgrade: Arc<Mutex<Option<PendingWsUpgrade>>>,
    method: &Method,
    route: &ParsedRoute<'_>,
    headers: BTreeMap<String, String>,
    attempt: &Attempt,
) -> Response<BoxBody> {
    #[cfg(feature = "proxy")]
    let mut headers = headers;
    let protocol = attempt.0.protocol;
    // Attach early when headers suffice so an interrupted upload still has a session.
    if state.auth.verify(&headers) {
        let _ = state.resolve_identity(
            attempt,
            route.scope.as_ref(),
            &headers,
            &Value::Null,
            None,
            false,
        );
    } else {
        return error_http_response(
            protocol,
            &HttpErrorSpec::new(401, "authentication_error", "invalid API key"),
            attempt,
        );
    }

    #[cfg(feature = "proxy")]
    let path_and_query = req
        .uri()
        .path_and_query()
        .map_or(route.raw_path, |pq| pq.as_str())
        .to_owned();
    #[cfg(feature = "proxy")]
    if let Some(lane) = attempt.lane() {
        headers.insert(crate::proxy::SCOPE_LANE_HEADER.into(), lane.0);
    }

    if route.endpoint == EndpointKind::ResponsesWs {
        if let Some(reject_status) = state.tuning.reject_websocket_upgrade_status {
            return error_http_response(
                protocol,
                &HttpErrorSpec::new(
                    reject_status,
                    "websocket_unavailable",
                    "WebSocket upgrade rejected by mock server configuration",
                ),
                attempt,
            );
        }
        let require_identity = route.scope.is_some();
        #[cfg(feature = "proxy")]
        let require_identity =
            require_identity || (state.strict_benchmark && state.proxy_recorder.is_some());
        if require_identity
            && let Err(spec) = state.resolve_identity(
                attempt,
                route.scope.as_ref(),
                &headers,
                &Value::Null,
                None,
                false,
            )
        {
            return error_http_response(protocol, &spec, attempt);
        }
        let Some(ws_key) = headers.get("sec-websocket-key") else {
            return full_json(
                StatusCode::BAD_REQUEST,
                &json!({"error": {"message":"missing Sec-WebSocket-Key"}}),
            );
        };
        #[cfg(feature = "proxy")]
        let proxied_upstream = if let Some(proxy) = &state.proxy_recorder {
            match proxy.connect_upstream_ws(&path_and_query, &headers).await {
                Ok(stream) => Some(stream),
                Err(error) => {
                    return full_json(
                        StatusCode::BAD_GATEWAY,
                        &json!({"error": {"type":"proxy_error", "message":error}}),
                    );
                }
            }
        } else {
            None
        };
        let accept = derive_accept_key(ws_key.as_bytes());
        *pending_upgrade.lock().unwrap() = Some(PendingWsUpgrade {
            on_upgrade: hyper::upgrade::on(req),
            path: route.raw_path.into(),
            scope: route.scope.clone(),
            canonical_offset: route.raw_path.len() - route.canonical_path.len(),
            query: route.query.map(str::to_owned),
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

    let body_bytes = match Limited::new(req.body_mut(), state.tuning.max_request_bytes)
        .collect()
        .await
    {
        Ok(body) => body.to_bytes(),
        Err(error) if error.is::<http_body_util::LengthLimitError>() => {
            return error_http_response(
                protocol,
                &crate::schema_synth::payload_too_large_error(protocol),
                attempt,
            );
        }
        Err(error) => {
            attempt.outcome(AttemptOutcome::TransportError, Some(400));
            return error_http_response(
                protocol,
                &HttpErrorSpec::new(
                    400,
                    "invalid_request_error",
                    format!("request body read error: {error}"),
                ),
                attempt,
            );
        }
    };
    attempt.body_read(body_bytes.len());

    #[cfg(feature = "proxy")]
    if let Some(proxy) = &state.proxy_recorder {
        if state.strict_benchmark || route.scope.is_some() {
            let body = match serde_json::from_slice::<Value>(&body_bytes) {
                Ok(body) => body,
                Err(_) if body_bytes.is_empty() => Value::Null,
                Err(error) => {
                    return error_http_response(
                        protocol,
                        &HttpErrorSpec::new(400, "invalid_request_error", error.to_string()),
                        attempt,
                    );
                }
            };
            let parent = body["previous_response_id"]
                .as_str()
                .map(|id| ResponseId(id.into()));
            if let Err(spec) = state.resolve_identity(
                attempt,
                route.scope.as_ref(),
                &headers,
                &body,
                parent.as_ref(),
                false,
            ) {
                return error_http_response(protocol, &spec, attempt);
            }
            if let Some(lane) = attempt.lane() {
                headers.insert(crate::proxy::SCOPE_LANE_HEADER.into(), lane.0);
            }
        }
        state.metrics.proxy_requests.fetch_add(1, Ordering::Relaxed);
        let proxied = match proxy
            .forward_http(
                method.as_str(),
                &path_and_query,
                (*method == Method::POST)
                    .then(|| endpoint_protocol(&route.endpoint))
                    .flatten(),
                &headers,
                body_bytes,
                state.shutdown.clone(),
            )
            .await
        {
            Ok(proxied) => proxied,
            Err(error) => {
                return full_json(
                    StatusCode::BAD_GATEWAY,
                    &json!({"error": {"type":"proxy_error", "message":error}}),
                );
            }
        };
        let stream = futures_util::stream::unfold(proxied.rx, |mut rx| async move {
            let item = rx.recv().await?.map(Frame::data).map_err(io::Error::other);
            Some((item, rx))
        });
        let mut builder = Response::builder()
            .status(StatusCode::from_u16(proxied.status).unwrap_or(StatusCode::BAD_GATEWAY));
        for (k, v) in proxied.headers {
            if let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(&v),
            ) {
                builder = builder.header(name, value);
            }
        }
        return builder
            .body(StreamBody::new(stream).boxed_unsync())
            .unwrap();
    }

    let record_control = || {
        state
            .metrics
            .control_plane_requests
            .fetch_add(1, Ordering::Relaxed);
        state
            .recorder
            .record_control(method.as_str(), route.raw_path, route.query, &headers);
    };
    if route.scope.is_some()
        && !matches!(
            route.endpoint,
            EndpointKind::Unknown
                | EndpointKind::GetResponse(_)
                | EndpointKind::DeleteResponse(_)
                | EndpointKind::ChatCompletions
                | EndpointKind::AnthropicMessages
                | EndpointKind::AnthropicCountTokens
                | EndpointKind::ResponsesCreate
                | EndpointKind::ResponsesCompact
        )
        && let Err(spec) = state.resolve_identity(
            attempt,
            route.scope.as_ref(),
            &headers,
            &Value::Null,
            None,
            false,
        )
    {
        return error_http_response(protocol, &spec, attempt);
    }
    if let Some(custom) = &state.custom_route
        && let Some(resp) = custom(method.as_str(), route.canonical_path, &headers, &body_bytes)
    {
        if state.strict_benchmark || route.scope.is_some() {
            let body = match serde_json::from_slice::<Value>(&body_bytes) {
                Ok(body) => body,
                Err(_) if body_bytes.is_empty() => Value::Null,
                Err(error) => {
                    attempt.outcome(AttemptOutcome::ParseFailed, Some(400));
                    return error_http_response(
                        protocol,
                        &HttpErrorSpec::new(400, "invalid_request_error", error.to_string()),
                        attempt,
                    );
                }
            };
            let parent = body["previous_response_id"]
                .as_str()
                .map(|id| ResponseId(id.into()));
            if let Err(spec) = state.resolve_identity(
                attempt,
                route.scope.as_ref(),
                &headers,
                &body,
                parent.as_ref(),
                false,
            ) {
                return error_http_response(protocol, &spec, attempt);
            }
        }
        record_control();
        let bytes = Bytes::from(resp.body);
        let mut builder = Response::builder()
            .status(StatusCode::from_u16(resp.status).unwrap_or(StatusCode::OK))
            .header(header::CONTENT_LENGTH, bytes.len());
        for (k, v) in &resp.headers {
            if let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(v),
            ) {
                builder = builder.header(name, value);
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

    #[cfg(feature = "proxy")]
    if let Some(replayer) = &state.cassette_replayer
        && (matches!(
            route.endpoint,
            EndpointKind::GetResponse(_) | EndpointKind::DeleteResponse(_)
        ) || ((replayer.config().strict_replay || state.strict_benchmark)
            && matches!(
                route.endpoint,
                EndpointKind::Models
                    | EndpointKind::ModelById(_)
                    | EndpointKind::RelayTokenUsage
                    | EndpointKind::V1Usage
                    | EndpointKind::ExtraGet(_)
            )))
    {
        if let Err(spec) = state.resolve_identity(
            attempt,
            route.scope.as_ref(),
            &headers,
            &Value::Null,
            None,
            false,
        ) && (state.strict_benchmark || route.scope.is_some())
        {
            return error_http_response(protocol, &spec, attempt);
        }
        let body = serde_json::from_slice::<Value>(&body_bytes).unwrap_or(Value::Null);
        let lane = attempt.replay_lane(&headers);
        let fingerprint = compute_fingerprint_for_lane(
            ExchangeKind::Http,
            method.as_str(),
            &route.canonical_path_and_query(),
            body["model"].as_str().unwrap_or(""),
            &body,
            lane.as_ref(),
        );
        match replayer.try_next_http_if(&fingerprint, |candidate| {
            candidate.fingerprint == fingerprint
        }) {
            Ok(exchange) => {
                record_control();
                attempt.record(|metrics| {
                    metrics.replay_hits.fetch_add(1, Ordering::Relaxed);
                });
                attempt.ready(None);
                return execute_http_replay(
                    exchange.clone(),
                    replayer.config().clone(),
                    RateLimitHeaders::default(),
                    None,
                    attempt.clone(),
                    state.clone(),
                );
            }
            Err(error) if replayer.config().strict_replay || state.strict_benchmark => {
                return error_http_response(protocol, &replay_miss(error), attempt);
            }
            Err(_) => {}
        }
    }

    match &route.endpoint {
        EndpointKind::Models => {
            record_control();
            return full_json(
                StatusCode::OK,
                &state.control.render_models_page(route.query),
            );
        }
        EndpointKind::ModelById(id) => {
            record_control();
            return match state.control.find_model(id) {
                Some(model) => full_json(StatusCode::OK, &model),
                None => error_http_response(
                    protocol,
                    &HttpErrorSpec::new(404, "not_found", format!("model '{id}' not found")),
                    attempt,
                ),
            };
        }
        EndpointKind::GetResponse(id) | EndpointKind::DeleteResponse(id) => {
            record_control();
            let not_found = || {
                full_json(
                    StatusCode::NOT_FOUND,
                    &json!({"error": {"type": "not_found", "message": format!("response '{id}' not found")}}),
                )
            };
            if state
                .resolve_identity(
                    attempt,
                    route.scope.as_ref(),
                    &headers,
                    &Value::Null,
                    None,
                    false,
                )
                .is_err()
            {
                return not_found();
            }
            let owner = attempt.owner();
            let response_id = ResponseId(id.clone());
            if matches!(route.endpoint, EndpointKind::GetResponse(_)) {
                return if let Some(owner) = owner {
                    let response = state
                        .benchmark
                        .read()
                        .unwrap()
                        .responses
                        .get(&owner)
                        .and_then(|bucket| bucket.entries.get(&response_id))
                        .map(|(response, _)| response.clone());
                    response.map_or_else(not_found, |response| {
                        full_json(StatusCode::OK, response.as_ref())
                    })
                } else {
                    state
                        .stored_responses
                        .get(id)
                        .map_or_else(not_found, |response| full_json(StatusCode::OK, &response))
                };
            }
            let deleted = if let Some(owner) = owner {
                let mut routing = state.benchmark.write().unwrap();
                let deleted = routing.lineage.delete_owned(&owner, &response_id);
                let retired = if deleted {
                    routing
                        .responses
                        .get_mut(&owner)
                        .and_then(|bucket| bucket.remove(&response_id))
                } else {
                    None
                };
                drop(routing);
                drop(retired);
                deleted
            } else {
                state.stored_responses.delete(id)
            };
            return if deleted {
                full_json(
                    StatusCode::OK,
                    &json!({"id": id, "object":"response.deleted", "deleted":true}),
                )
            } else {
                not_found()
            };
        }
        EndpointKind::RelayTokenUsage | EndpointKind::V1Usage | EndpointKind::ExtraGet(_) => {
            let payload = match &route.endpoint {
                EndpointKind::RelayTokenUsage => state.control.relay_token_usage.as_ref(),
                EndpointKind::V1Usage => state.control.v1_usage.as_ref(),
                EndpointKind::ExtraGet(path) => state.control.extra_get_routes.get(path),
                _ => unreachable!(),
            };
            if let Some(payload) = payload {
                record_control();
                return full_json(StatusCode::OK, payload);
            }
            return unknown_route(state, method, route.raw_path);
        }
        EndpointKind::Unknown => return unknown_route(state, method, route.raw_path),
        _ => {}
    }

    let raw_body = match serde_json::from_slice::<Value>(&body_bytes) {
        Ok(body) if body.is_object() => body,
        result => {
            let detail = result
                .err()
                .map_or_else(|| "expected a JSON object".into(), |err| err.to_string());
            attempt.outcome(AttemptOutcome::ParseFailed, Some(400));
            return error_http_response(
                protocol,
                &HttpErrorSpec::new(400, "invalid_request_error", detail),
                attempt,
            );
        }
    };
    let mut normalized = normalize_request(
        state.next_sequence(),
        protocol,
        Transport::Http,
        route.raw_path.into(),
        headers,
        body_bytes,
        raw_body,
    );
    let parent_id = normalized.previous_response_id.clone().map(ResponseId);
    attempt.classified(&normalized, RequestPurpose::Unclassified);
    if let Err(spec) = state.resolve_identity(
        attempt,
        route.scope.as_ref(),
        &normalized.headers,
        &normalized.raw_body,
        parent_id.as_ref(),
        false,
    ) {
        return error_http_response(protocol, &spec, attempt);
    }
    let purpose = state.classify(route, &mut normalized, attempt);
    let metric_purpose = if route.endpoint == EndpointKind::AnthropicCountTokens {
        RequestPurpose::CountTokens
    } else {
        RequestPurpose::from(&purpose)
    };
    attempt.classified(&normalized, metric_purpose);

    let main = purpose == RequestUse::Main;
    let profile = state.profile.effective();
    let (rl_headers, rl_lease) = if main {
        attempt.record(|metrics| {
            metrics.record_protocol(protocol, normalized.prompt_bytes);
            state.recorder.record(&normalized);
        });
        match state.rate_limiter.check_and_acquire(
            normalized.api_key(),
            &normalized.model,
            normalized.estimated_input_tokens,
            profile.rate_limit_override.as_ref(),
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
                for (key, value) in headers.to_header_pairs() {
                    spec.headers.insert(key.into(), value);
                }
                return error_http_response(protocol, &spec, attempt);
            }
        }
    } else {
        (RateLimitHeaders::default(), None)
    };

    #[cfg(feature = "proxy")]
    if let Some(replayer) = &state.cassette_replayer {
        let lane = attempt.lane();
        let fingerprint =
            fingerprint_from_route(&normalized, method.as_str(), route, lane.as_ref());
        let strict_prev = protocol.is_responses() && state.tuning.strict_previous_response_id;
        match replayer.try_next_http_if(&fingerprint, |candidate| {
            !strict_prev
                || normalized.previous_response_id.as_deref()
                    == candidate.request_body["previous_response_id"].as_str()
        }) {
            Ok(exchange) => {
                state.metrics.replay_hits.fetch_add(1, Ordering::Relaxed);
                attempt.admitted(None);
                attempt.ready(None);
                return execute_http_replay(
                    exchange.clone(),
                    replayer.config().clone(),
                    rl_headers,
                    rl_lease,
                    attempt.clone(),
                    state.clone(),
                );
            }
            Err(error) if replayer.config().strict_replay => {
                return error_http_response(protocol, &replay_miss(error), attempt);
            }
            Err(_) => {}
        }
    }

    if route.endpoint == EndpointKind::AnthropicCountTokens {
        state
            .metrics
            .control_plane_requests
            .fetch_add(1, Ordering::Relaxed);
        state.recorder.record_control(
            method.as_str(),
            route.raw_path,
            route.query,
            &normalized.headers,
        );
        let size = &normalized.size_breakdown;
        let tokens = size.estimated_history_tokens
            + (size.tools_bytes as u64).div_ceil(4)
            + (size.system_bytes as u64).div_ceil(4);
        attempt.usage(Usage::new(tokens, 0));
        attempt.admitted(None);
        return full_json(StatusCode::OK, &crate::control::render_count_tokens(tokens));
    }

    let parent = match state.check_parent(&normalized, attempt, None) {
        Ok(parent) => parent,
        Err(spec) => {
            if main {
                attempt.record(|_| {
                    state.watchdog.record_invalid_previous_response_id(
                        &normalized,
                        normalized.previous_response_id.as_deref().unwrap(),
                    )
                });
            }
            return error_http_response(protocol, &spec, attempt);
        }
    };
    attempt.admitted(parent.as_ref());
    let history = effective_history(&normalized, parent.as_ref());
    let normalized = Arc::new(normalized);

    if purpose == RequestUse::Compact(CompactKind::ResponsesEndpoint) {
        attempt.audit(normalized.clone(), &purpose, history);
        let output = state.compaction(&normalized, Some(attempt));
        let id = format!("resp_compact_{}", normalized.sequence);
        let retained: Vec<_> = match &normalized.raw_body["input"] {
            Value::String(text) => vec![json!({"type":"message", "role":"user",
                "content":[{"type":"input_text", "text":text}]})],
            input => input
                .as_array()
                .into_iter()
                .flatten()
                .filter(|item| item["role"] == "user")
                .cloned()
                .collect(),
        };
        let retained_bytes = retained
            .iter()
            .map(|value| value.to_string().len())
            .sum::<usize>();
        let usage = Usage::new(
            normalized.estimated_input_tokens
                + parent.as_ref().map_or(0, |p| p.effective_context_tokens),
            (output.encrypted_content.len() as u64).div_ceil(4),
        );
        let compacted_bytes = retained_bytes + output.encrypted_content.len();
        let result = crate::control::render_responses_compact(
            &id,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            &output.id,
            &output.encrypted_content,
            retained,
            &usage,
        );
        attempt.ready(Some(&id));
        attempt.usage(usage);
        let mut response = full_json(StatusCode::OK, &result);
        response.extensions_mut().insert(NonStreamDelivery {
            items: vec![DeliveredItem::Compaction {
                id: output.id,
                bytes: compacted_bytes,
            }],
            response: Some(ResponsePublication {
                id,
                value: result,
                store: normalized.options.store.unwrap_or(true),
                history: HistorySize {
                    bytes: compacted_bytes,
                    tokens: (compacted_bytes as u64).div_ceil(4),
                },
            }),
            request: normalized,
        });
        return response;
    }

    let decision = match state
        .decide(&normalized, &purpose, &profile, attempt, parent.as_ref())
        .await
    {
        Ok(decision) => decision,
        Err(spec) => return error_http_response(protocol, &spec, attempt),
    };
    if main || matches!(purpose, RequestUse::Compact(_)) {
        attempt.audit(normalized.clone(), &purpose, history);
    }
    let store = normalized.options.store.unwrap_or(true);
    execute_http_turn(
        normalized,
        decision,
        store,
        if main {
            profile.latency
        } else {
            LatencyProfile::default()
        },
        rl_headers,
        rl_lease,
        history,
        attempt.clone(),
        state.clone(),
    )
    .await
}

fn unknown_route(state: &ServerState, method: &Method, path: &str) -> Response<BoxBody> {
    state.unknown_routes.fetch_add(1, Ordering::Relaxed);
    full_json(
        StatusCode::NOT_FOUND,
        &json!({"error": {"type":"not_found",
        "message": format!("unknown route: {method} {path}")}}),
    )
}

#[derive(Clone)]
struct TrackedSse;

struct AttemptBody {
    inner: BoxBody,
    attempt: Attempt,
    sse: bool,
    semantic: bool,
    delivery: Option<NonStreamDelivery>,
}

#[derive(Clone)]
struct NonStreamDelivery {
    request: Arc<NormalizedRequest>,
    items: Vec<DeliveredItem>,
    response: Option<ResponsePublication>,
}

#[derive(Clone)]
struct ResponsePublication {
    id: String,
    value: Value,
    store: bool,
    history: HistorySize,
}

impl NonStreamDelivery {
    fn deliver(self, attempt: &Attempt) {
        for item in self.items {
            item.deliver(attempt, &self.request);
        }
        attempt.deliver_summary(&self.request);
        if let Some(response) = self.response {
            attempt.0.state.publish_response(
                &self.request,
                attempt,
                response.id,
                response.value,
                response.store,
                response.history,
            );
        }
    }
}

impl hyper::body::Body for AttemptBody {
    type Data = Bytes;
    type Error = io::Error;

    fn poll_frame(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<Frame<Bytes>, io::Error>>> {
        let result = std::pin::Pin::new(&mut self.inner).poll_frame(cx);
        if !self.sse
            && let std::task::Poll::Ready(Some(Ok(frame))) = &result
            && let Some(data) = frame.data_ref()
        {
            self.attempt.frame(data.len(), self.semantic);
            if let Some(delivery) = self.delivery.take() {
                delivery.deliver(&self.attempt);
            }
        }
        if matches!(result, std::task::Poll::Ready(Some(Err(_)))) && !self.sse {
            self.attempt.outcome(AttemptOutcome::TransportError, None);
        }
        if !self.sse
            && (self.inner.is_end_stream() || matches!(result, std::task::Poll::Ready(None)))
        {
            self.attempt.body_completed();
        }
        result
    }

    fn size_hint(&self) -> hyper::body::SizeHint {
        self.inner.size_hint()
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }
}

impl Drop for AttemptBody {
    fn drop(&mut self) {
        self.attempt
            .with_span(|span, now| span.body_dropped_ns = Some(now));
    }
}

#[cfg(feature = "proxy")]
fn replay_miss(error: crate::proxy::ReplayError) -> HttpErrorSpec {
    let mut spec = HttpErrorSpec::new(422, "invalid_request_error", error.to_string());
    spec.code = Some("cassette_replay_miss".into());
    spec
}

#[cfg(feature = "proxy")]
fn execute_http_replay(
    exchange: crate::proxy::RecordedExchange,
    replay_cfg: ReplayConfig,
    rl_headers: RateLimitHeaders,
    rl_lease: Option<RateLimitLease>,
    attempt: Attempt,
    state: Arc<ServerState>,
) -> Response<BoxBody> {
    let (tx, rx) = mpsc::channel::<Result<Frame<Bytes>, io::Error>>(16);
    let mut headers = exchange.response_headers.clone();
    for (k, v) in rl_headers.to_header_pairs() {
        headers.insert(k.to_string(), v);
    }
    let status = StatusCode::from_u16(exchange.status).unwrap_or(StatusCode::OK);
    let state_clone = state.clone();
    let replay_attempt = attempt.clone();

    spawn_tracked(state, async move {
        let _lease = rl_lease;
        state_clone
            .metrics
            .active_streams
            .fetch_add(1, Ordering::Relaxed);
        let _guard = ActiveStreamGuard(state_clone.metrics.clone());
        for chunk in exchange.chunks {
            if !replay_attempt
                .wait(replay_cfg.scaled_delay(chunk.delay_ms), tx.closed())
                .await
                || tx.send(Ok(Frame::data(chunk.to_bytes()))).await.is_err()
            {
                return;
            }
        }
        let completed = exchange.outcome == crate::proxy::ExchangeOutcome::Completed;
        replay_attempt.outcome(
            if completed {
                AttemptOutcome::Completed
            } else {
                AttemptOutcome::InjectedFault
            },
            Some(status.as_u16()),
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
        rx: mpsc::Receiver<InteractiveCommand>,
    },
}

impl HttpEventFeed {
    fn initial_usage(&self, req: &NormalizedRequest) -> TurnEvent {
        let events = match self {
            Self::Plan { events, .. } => events.as_slice(),
            Self::Interactive { .. } => &[],
        };
        initial_usage(events, req)
    }

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
        tx_closed: Option<&SseSender>,
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
                let next = if let Some(tx) = tx_closed {
                    tokio::select! {
                        _ = shutdown.cancelled() => return FeedStep::Aborted,
                        _ = tx.closed() => return FeedStep::Aborted,
                        next = rx.recv() => next,
                    }
                } else {
                    tokio::select! {
                        _ = shutdown.cancelled() => return FeedStep::Aborted,
                        next = rx.recv() => next,
                    }
                };
                match next {
                    Some(InteractiveCommand::Event(ev)) => FeedStep::Event(ev),
                    Some(InteractiveCommand::Plan { .. }) => {
                        unreachable!("TurnHandle::send_plan is rejected after incremental events")
                    }
                    None => FeedStep::Ended,
                }
            }
        }
    }

    async fn wait_stall(
        &mut self,
        shutdown: &tokio_util::sync::CancellationToken,
        tx_closed: Option<&SseSender>,
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
                            Some(InteractiveCommand::Event(ev)) => {
                                *pending = Some(ev);
                                return StallOutcome::Resumed;
                            }
                            Some(InteractiveCommand::Plan { .. }) => {
                                unreachable!("TurnHandle::send_plan is rejected after incremental events")
                            }
                            None => true,
                        }
                    }
                } else {
                    tokio::select! {
                        _ = shutdown.cancelled() => return StallOutcome::Ended,
                        next = rx.recv() => match next {
                            Some(InteractiveCommand::Event(ev)) => {
                                *pending = Some(ev);
                                return StallOutcome::Resumed;
                            }
                            Some(InteractiveCommand::Plan { .. }) => {
                                unreachable!("TurnHandle::send_plan is rejected after incremental events")
                            }
                            None => true,
                        }
                    }
                };
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

enum ResolvedHttpDecision {
    Plan {
        plan: Box<crate::plan::TurnPlan>,
        close_guard: TurnCloseGuard,
    },
    Interactive {
        first: Box<TurnEvent>,
        stream: crate::handler::InteractiveStream,
        close_guard: TurnCloseGuard,
    },
}

#[allow(clippy::too_many_arguments)]
async fn execute_http_turn(
    req: Arc<NormalizedRequest>,
    decision: TurnDecision,
    store_flag: bool,
    latency_profile: LatencyProfile,
    rl_headers: RateLimitHeaders,
    rl_lease: Option<RateLimitLease>,
    history: HistorySize,
    attempt: Attempt,
    state: Arc<ServerState>,
) -> Response<BoxBody> {
    let resolved = match decision {
        TurnDecision::Plan(mut plan) => {
            let close_guard = TurnCloseGuard::new(CloseSignalGuard(plan.on_close.take()));
            ResolvedHttpDecision::Plan {
                plan: Box::new(plan),
                close_guard,
            }
        }
        TurnDecision::Interactive(mut stream) => {
            let mut close_guard =
                TurnCloseGuard::new(CloseSignalGuard(Some(CloseSignal(stream.closed.clone()))));
            let first = tokio::select! {
                _ = state.shutdown.cancelled() => return shutdown_response(&attempt, req.protocol),
                event = stream.events.recv() => event,
            };
            match first {
                Some(InteractiveCommand::Plan { plan, on_close }) => {
                    close_guard.attach(on_close);
                    ResolvedHttpDecision::Plan { plan, close_guard }
                }
                Some(InteractiveCommand::Event(first)) => ResolvedHttpDecision::Interactive {
                    first,
                    stream,
                    close_guard,
                },
                None => {
                    return finish_http_error(
                        &req,
                        &HttpErrorSpec::new(
                            500,
                            "mock_aborted",
                            "interactive TurnHandle dropped before reply",
                        ),
                        &rl_headers,
                        &attempt,
                    );
                }
            }
        }
    };
    let (feed, plan, close_guard) = match resolved {
        ResolvedHttpDecision::Plan { plan, close_guard } => {
            let mut plan = *plan;
            attempt.ready(plan.response_id.as_deref());
            if let [TurnEvent::Delay { ms }, TurnEvent::HttpError(_), ..] = plan.events.as_slice()
                && !attempt
                    .wait(Duration::from_millis(*ms), std::future::pending())
                    .await
            {
                return shutdown_response(&attempt, req.protocol);
            }
            if let [TurnEvent::HttpError(spec), ..]
            | [TurnEvent::Delay { .. }, TurnEvent::HttpError(spec), ..] = plan.events.as_slice()
            {
                return finish_http_error(&req, spec, &rl_headers, &attempt);
            }
            let inferred_finish = plan.inferred_finish_reason();
            let feed = HttpEventFeed::Plan {
                events: std::mem::take(&mut plan.events).into_iter(),
                inferred_finish,
            };
            (feed, plan, close_guard)
        }
        ResolvedHttpDecision::Interactive {
            first,
            stream,
            close_guard,
        } => {
            if let TurnEvent::HttpError(spec) = &*first {
                return finish_http_error(&req, spec, &rl_headers, &attempt);
            }
            let id = stream.response_id.lock().unwrap().clone();
            let feed = HttpEventFeed::Interactive {
                pending: Some(first),
                rx: stream.events,
            };
            (
                feed,
                crate::plan::TurnPlan {
                    response_id: id,
                    ..Default::default()
                },
                close_guard,
            )
        }
    };
    let mut plan = plan;
    let id = plan
        .response_id
        .take()
        .unwrap_or_else(|| default_response_id(req.protocol, req.sequence));
    attempt.ready(Some(&id));
    let model = plan
        .model_override
        .take()
        .unwrap_or_else(|| req.model.clone());
    let usage_event = feed.initial_usage(&req);
    let usage = event_usage(&usage_event).unwrap().clone();
    attempt.usage(usage.clone());
    let mut pacer = feed.is_plan().then(|| {
        let active = state.metrics.active_streams.load(Ordering::Relaxed) + 1;
        super::turn_pacer(&req, &plan, &usage, &attempt, latency_profile, active)
    });
    let wire_poison = plan.wire_poison;
    let close_connection = plan.close_connection;
    let mut headers = plan.response_headers;
    for (key, value) in rl_headers.to_header_pairs() {
        headers.entry(key.into()).or_insert(value);
    }
    let mut encoder = state.encoder(&req, id, model);
    for _ in encoder.encode_event(usage_event) {}

    if !req.stream {
        let _close_guard = close_guard;
        let mut lease = rl_lease;
        let mut feed = feed;
        let mut usage = usage;
        let mut semantic_bytes = 0;
        let mut delivered = Vec::new();
        let reason = loop {
            let event = match feed.next_event(&state.shutdown, None).await {
                FeedStep::Aborted => return shutdown_response(&attempt, req.protocol),
                FeedStep::Ended => break feed.auto_finish_reason().unwrap_or(FinishReason::Stop),
                FeedStep::Event(event) => *event,
            };
            match event {
                TurnEvent::Delay { ms } => {
                    if !attempt
                        .wait(Duration::from_millis(ms), std::future::pending())
                        .await
                    {
                        return shutdown_response(&attempt, req.protocol);
                    }
                }
                TurnEvent::JitterDelay { min_ms, max_ms } => {
                    let ms = pacer.as_mut().map_or_else(
                        || jitter_ms(min_ms, max_ms),
                        |pacer| pacer.jitter_ms(min_ms, max_ms),
                    );
                    if !attempt
                        .wait(Duration::from_millis(ms), std::future::pending())
                        .await
                    {
                        return shutdown_response(&attempt, req.protocol);
                    }
                }
                TurnEvent::Stall => {
                    attempt.record(|metrics| {
                        metrics.stalls_entered.fetch_add(1, Ordering::Relaxed);
                    });
                    if matches!(
                        feed.wait_stall(&state.shutdown, None).await,
                        StallOutcome::Ended
                    ) {
                        return shutdown_response(&attempt, req.protocol);
                    }
                }
                TurnEvent::HttpError(spec) => {
                    return finish_http_error(&req, &spec, &rl_headers, &attempt);
                }
                TurnEvent::DropConnection
                | TurnEvent::TruncateEof
                | TurnEvent::MidStreamError(_) => {
                    return finish_http_error(
                        &req,
                        &HttpErrorSpec::new(500, "connection_error", "connection aborted"),
                        &rl_headers,
                        &attempt,
                    );
                }
                TurnEvent::Finish { reason } => break reason,
                event => {
                    if let Some(value) = event_usage(&event) {
                        usage = value.clone();
                        attempt.usage(usage.clone());
                    }
                    if let Some(item) = DeliveredItem::from_event(&event) {
                        item.issued(&attempt);
                        if let DeliveredItem::Compaction { bytes, .. } = item {
                            attempt.buffering(bytes);
                        }
                        delivered.push(item);
                    }
                    semantic_bytes += super::semantic_event_bytes(&event);
                    for _ in encoder.encode_event(event) {}
                }
            }
        };
        if let Some(pacer) = pacer
            && !attempt
                .wait(
                    pacer.non_streaming_total_delay(semantic_bytes),
                    std::future::pending(),
                )
                .await
        {
            return shutdown_response(&attempt, req.protocol);
        }
        let completion = encoder.finish_encoded(reason, &mut |_| {});
        usage.output_tokens = usage.output_tokens.max((semantic_bytes as u64) / 4);
        if let Some(lease) = &mut lease {
            lease.debit_output_tokens(usage.output_tokens);
        }
        attempt.usage(usage);
        let mut response = json_with_headers(&completion.response_json, &headers, close_connection);
        let publication =
            if !completion.errored && req.protocol.is_responses() && attempt.can_publish() {
                Some(ResponsePublication {
                    id: completion.response_id,
                    value: completion.response_json,
                    store: store_flag,
                    history: attempt.response_history(history, semantic_bytes),
                })
            } else {
                None
            };
        if !delivered.is_empty() || publication.is_some() || attempt.has_summary() {
            response.extensions_mut().insert(NonStreamDelivery {
                items: delivered,
                response: publication,
                request: req,
            });
        }
        return response;
    }

    let (tx, rx) = mpsc::channel(16);
    let producer_attempt = attempt.clone();
    let producer_state = state.clone();
    let producer_request = req.clone();
    spawn_tracked(state, async move {
        let state = producer_state;
        let req = producer_request;
        let attempt = producer_attempt;
        let mut lease = rl_lease;
        let _close_guard = close_guard;
        state.metrics.active_streams.fetch_add(1, Ordering::Relaxed);
        let _stream = ActiveStreamGuard(state.metrics.clone());
        let mut feed = feed;
        let mut usage = usage;
        let mut writer = SseWriter {
            tx,
            attempt: &attempt,
            req: &req,
            pacer,
            poison: wire_poison,
            frame_index: 0,
            semantic_bytes: 0,
        };
        if !writer.prefill().await {
            return;
        }
        let finish = loop {
            let event = match feed.next_event(&state.shutdown, Some(&writer.tx)).await {
                FeedStep::Aborted => return,
                FeedStep::Ended => {
                    let Some(reason) = feed.auto_finish_reason() else {
                        attempt.outcome(AttemptOutcome::TransportError, Some(200));
                        return;
                    };
                    break reason;
                }
                FeedStep::Event(event) => *event,
            };
            match event {
                TurnEvent::Delay { ms } => {
                    if !writer.wait(ms).await {
                        return;
                    }
                }
                TurnEvent::JitterDelay { min_ms, max_ms } => {
                    let ms = writer.pacer.as_mut().map_or_else(
                        || jitter_ms(min_ms, max_ms),
                        |pacer| pacer.jitter_ms(min_ms, max_ms),
                    );
                    if !writer.wait(ms).await {
                        return;
                    }
                }
                TurnEvent::Stall => {
                    attempt.record(|metrics| {
                        metrics.stalls_entered.fetch_add(1, Ordering::Relaxed);
                    });
                    if matches!(
                        feed.wait_stall(&state.shutdown, Some(&writer.tx)).await,
                        StallOutcome::Ended
                    ) {
                        if feed.is_plan() && !state.shutdown.is_cancelled() {
                            attempt.outcome(AttemptOutcome::InjectedFault, Some(200));
                        }
                        return;
                    }
                }
                TurnEvent::DropConnection => {
                    attempt.record(|metrics| {
                        metrics
                            .connection_drops_emitted
                            .fetch_add(1, Ordering::Relaxed);
                    });
                    attempt.outcome(AttemptOutcome::InjectedFault, Some(200));
                    let _ = writer
                        .tx
                        .send(Err(io::Error::new(
                            io::ErrorKind::ConnectionReset,
                            "mock-ai simulated connection drop",
                        )))
                        .await;
                    return;
                }
                TurnEvent::TruncateEof => {
                    attempt.outcome(AttemptOutcome::InjectedFault, Some(200));
                    return;
                }
                TurnEvent::HttpError(spec) => {
                    attempt.outcome(AttemptOutcome::InjectedFault, Some(200));
                    let _ = writer
                        .send(encoder.encode_event(TurnEvent::HttpError(spec)), None)
                        .await;
                    return;
                }
                TurnEvent::MidStreamError(error) => {
                    attempt.record(|metrics| {
                        metrics
                            .mid_stream_errors_emitted
                            .fetch_add(1, Ordering::Relaxed);
                    });
                    attempt.outcome(AttemptOutcome::InjectedFault, Some(200));
                    let _ = writer
                        .send(encoder.encode_event(TurnEvent::MidStreamError(error)), None)
                        .await;
                    return;
                }
                TurnEvent::Finish { reason } => break reason,
                event => {
                    if let Some(value) = event_usage(&event) {
                        usage = value.clone();
                        attempt.usage(usage.clone());
                    }
                    let delivered = DeliveredItem::from_event(&event);
                    if let Some(item) = &delivered {
                        item.issued(&attempt);
                        if let DeliveredItem::Compaction { bytes, .. } = item {
                            attempt.buffering(*bytes);
                        }
                    }
                    if !writer
                        .send(
                            encoder.encode_event(event),
                            delivered.map(SseDelivery::Item),
                        )
                        .await
                    {
                        return;
                    }
                }
            }
        };
        let mut tail = Vec::new();
        let completion = encoder.finish_encoded(finish, &mut |frame| tail.push(frame));
        usage.output_tokens = usage.output_tokens.max((writer.semantic_bytes as u64) / 4);
        if let Some(lease) = &mut lease {
            lease.debit_output_tokens(usage.output_tokens);
        }
        attempt.usage(usage);
        let effective = attempt.response_history(history, writer.semantic_bytes);
        let _ = writer
            .send(
                tail.into_iter(),
                Some(SseDelivery::Finish {
                    completion,
                    history: effective,
                    store: store_flag,
                }),
            )
            .await;
    });

    let stream =
        futures_util::stream::unfold((rx, attempt, req), |(mut rx, attempt, req)| async move {
            let chunk = rx.recv().await?;
            let frame = chunk.map(|chunk: SseChunk| {
                attempt.frame(chunk.bytes.len(), chunk.semantic);
                if let Some(delivery) = chunk.delivery {
                    match delivery {
                        SseDelivery::Item(item) => item.deliver(&attempt, &req),
                        SseDelivery::Finish {
                            completion,
                            store,
                            history,
                        } => {
                            if completion.errored {
                                attempt.outcome(AttemptOutcome::InjectedFault, Some(200));
                            } else {
                                attempt.deliver_summary(&req);
                                attempt.0.state.publish_response(
                                    &req,
                                    &attempt,
                                    completion.response_id,
                                    completion.response_json,
                                    store,
                                    history,
                                );
                                attempt.outcome(AttemptOutcome::Completed, Some(200));
                            }
                        }
                    }
                }
                Frame::data(chunk.bytes)
            });
            Some((frame, (rx, attempt, req)))
        });
    let mut response = super::sse_response(
        StreamBody::new(stream).boxed_unsync(),
        &headers,
        close_connection,
    );
    response.extensions_mut().insert(TrackedSse);
    response
}

type SseSender = mpsc::Sender<Result<SseChunk, io::Error>>;

struct SseChunk {
    bytes: Bytes,
    semantic: bool,
    delivery: Option<SseDelivery>,
}

enum SseDelivery {
    Item(DeliveredItem),
    Finish {
        completion: crate::codec::TurnCompletion,
        history: HistorySize,
        store: bool,
    },
}

struct SseWriter<'a> {
    tx: SseSender,
    attempt: &'a Attempt,
    req: &'a NormalizedRequest,
    pacer: Option<TurnPacer>,
    poison: WirePoisonConfig,
    frame_index: usize,
    semantic_bytes: usize,
}

impl SseWriter<'_> {
    async fn wait(&self, ms: u64) -> bool {
        self.attempt
            .wait(Duration::from_millis(ms), self.tx.closed())
            .await
    }

    async fn prefill(&self) -> bool {
        let Some(pacer) = &self.pacer else {
            return true;
        };
        let delay = pacer.initial_delay();
        let Some(ping) = pacer.sse_ping_interval() else {
            return self.attempt.wait(delay, self.tx.closed()).await;
        };
        let deadline = tokio::time::Instant::now() + delay;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if !self
                .attempt
                .wait(remaining.min(ping), self.tx.closed())
                .await
            {
                return false;
            }
            if tokio::time::Instant::now() >= deadline {
                return true;
            }
            let bytes = if self.poison.crlf_line_endings {
                Bytes::from_static(b": keep-alive\r\n\r\n")
            } else {
                Bytes::from_static(b": keep-alive\n\n")
            };
            if !self.chunk(bytes, false, None).await {
                return false;
            }
        }
    }

    async fn chunk(&self, bytes: Bytes, semantic: bool, delivery: Option<SseDelivery>) -> bool {
        let chunk = SseChunk {
            bytes,
            semantic,
            delivery,
        };
        match self.tx.try_send(Ok(chunk)) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Closed(_)) => false,
            Err(mpsc::error::TrySendError::Full(chunk)) => {
                let start = Instant::now();
                let sent = tokio::select! {
                    _ = self.attempt.0.state.shutdown.cancelled() => false,
                    result = self.tx.send(chunk) => result.is_ok(),
                };
                self.attempt.backpressure(start.elapsed());
                sent
            }
        }
    }

    async fn send(
        &mut self,
        frames: impl Iterator<Item = EncodedFrame>,
        mut delivery: Option<SseDelivery>,
    ) -> bool {
        let mut frames = frames.peekable();
        while let Some(frame) = frames.next() {
            let last = if delivery.is_some() {
                frames.peek().is_none()
            } else {
                false
            };
            let EncodedFrame {
                wire,
                kind,
                semantic_bytes,
            } = frame;
            let raw = match wire {
                WireFrame::Sse(bytes) | WireFrame::Raw(bytes) => bytes,
                WireFrame::WsText(text) => Bytes::from(format!("data: {text}\n\n")),
            };
            let semantic = kind == FrameKind::SemanticDelta;
            if self.poison.is_active() {
                let chunks = poison_sse_frame(
                    String::from_utf8_lossy(&raw).into_owned(),
                    &self.poison,
                    self.frame_index,
                );
                let count = chunks.len();
                for (index, chunk) in chunks.into_iter().enumerate() {
                    let final_chunk = index + 1 == count;
                    let delivered = if last && final_chunk {
                        delivery.take()
                    } else {
                        None
                    };
                    if !self.chunk(chunk, semantic && final_chunk, delivered).await {
                        return false;
                    }
                }
                self.frame_index = self.frame_index.wrapping_add(1);
            } else if !self
                .chunk(raw, semantic, if last { delivery.take() } else { None })
                .await
            {
                return false;
            }
            self.semantic_bytes += semantic_bytes;
            if let Some(deadline) = self.pacer.as_mut().and_then(|pacer| {
                pacer.next_frame_deadline(kind, semantic_bytes, tokio::time::Instant::now())
            }) && !self.attempt.wait_until(deadline, self.tx.closed()).await
            {
                return false;
            }
        }
        if let Some(SseDelivery::Item(item)) = delivery {
            // Some protocol events update only the terminal JSON.
            item.deliver(self.attempt, self.req);
        }
        true
    }
}

fn shutdown_response(attempt: &Attempt, protocol: Protocol) -> Response<BoxBody> {
    error_http_response(
        protocol,
        &HttpErrorSpec::new(503, "server_error", "server shutting down"),
        attempt,
    )
}

fn finish_http_error(
    req: &NormalizedRequest,
    spec: &HttpErrorSpec,
    rl_headers: &RateLimitHeaders,
    attempt: &Attempt,
) -> Response<BoxBody> {
    let mut enriched = spec.clone();
    for (key, value) in rl_headers.to_header_pairs() {
        enriched.headers.entry(key.into()).or_insert(value);
    }
    attempt.outcome(AttemptOutcome::InjectedFault, Some(spec.status));
    error_http_response(req.protocol, &enriched, attempt)
}
