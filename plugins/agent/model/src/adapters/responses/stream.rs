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

//! Responses dispatch. Protocol code never enters the model V8 isolate.
use super::{
    decode::Decoder,
    transport::{Exchange, ResponsesLane, Shared},
};
use maka_agent_facts::model::error::ProviderFailure;
use maka_agent_facts::model::error::ProviderFailureReason;
use maka_agent_facts::model::error::{ModelError, ModelFailureCause};
use maka_agent_ports::model::Context;
use maka_agent_ports::model::Credentials as ProviderAuth;
use maka_agent_ports::model::Events;
use maka_agent_ports::model::ProviderKind;
use maka_agent_ports::model::Request as ModelRequest;
use maka_capabilities::http;
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

pub async fn stream(
    mut request: ModelRequest,
    context: Context,
    lane: Option<super::Lane>,
    transport: Arc<Shared>,
) -> Result<(), ModelError> {
    let skip = if let Some(lane) = &lane {
        tokio::select! {
            biased;
            _ = context.cancellation.cancelled() => return Err(ModelError::Cancelled),
            skip = lane.prepare(&mut request) => skip,
        }
    } else {
        0
    };
    let lane = lane.map(|lane| lane.transport);
    run(request, skip, context, lane, transport).await
}
fn http_failure(status: u16) -> ModelError {
    match (ModelFailureCause::Http { status }).validate() {
        Ok(()) => ModelError::Http { status },
        Err(error) => error,
    }
}
fn interruption(
    decoder: &Decoder,
    reason: ProviderFailureReason,
    message: impl Into<String>,
) -> ModelError {
    ModelError::Provider(
        ProviderFailure::new(reason, message, decoder.replay_safe, None)
            .with_retained_output(decoder.retained_output_safe()),
    )
}
async fn wait<T>(
    duration: Duration,
    decoder: &Decoder,
    cancellation: &CancellationToken,
    future: impl Future<Output = T>,
) -> Result<T, ModelError> {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(ModelError::Cancelled),
        result = tokio::time::timeout(duration, future) => result.map_err(|_| interruption(
            decoder, ProviderFailureReason::TimedOut, ModelError::TimedOut.to_string(),
        )),
    }
}

/// Cancellation and idle timeout signal the upload, then await its physical
/// source settlement. Dropping request() here could orphan a retained chunk.
async fn request_http(
    network: &dyn maka_agent_ports::model::Transport,
    input: http::Request,
    cancellation: &CancellationToken,
    duration: Duration,
    decoder: &Decoder,
) -> Result<http::Response, ModelError> {
    let upload_cancel = cancellation.child_token();
    let operation = network.request(input, upload_cancel.clone());
    tokio::pin!(operation);
    let timeout = tokio::select! {
        biased;
        _ = cancellation.cancelled() => false,
        result = &mut operation => return result,
        _ = tokio::time::sleep(duration) => true,
    };
    upload_cancel.cancel();
    match operation.await {
        Ok(response) => {
            response.body.cancel();
            response.body.close().await.map_err(|error| match error {
                http::Error::CleanupUnconfirmed => ModelError::CleanupUnconfirmed,
                other => ModelError::Adapter(other.to_string()),
            })?;
        }
        Err(ModelError::Cancelled) => {}
        Err(error) => return Err(error),
    }
    if timeout {
        Err(interruption(
            decoder,
            ProviderFailureReason::TimedOut,
            ModelError::TimedOut.to_string(),
        ))
    } else {
        Err(ModelError::Cancelled)
    }
}
async fn emit(
    decoder: &mut Decoder,
    value: Value,
    sender: &Arc<dyn Events>,
    cancellation: &CancellationToken,
) -> Result<(), ModelError> {
    for event in decoder.push(value).map_err(failure)? {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(ModelError::Cancelled),
            result = sender.emit(event.into()) => result?,
        }
    }
    Ok(())
}
async fn run(
    request: ModelRequest,
    skip: usize,
    context: Context,
    lane: Option<ResponsesLane>,
    transport: Arc<Shared>,
) -> Result<(), ModelError> {
    let Context {
        events: sender,
        cancellation,
        idle_timeout,
        transport: network,
    } = context;
    let plaintext = match request.provider.kind {
        ProviderKind::OpenResponses(p) => Some(p),
        _ => None,
    };
    let mut body = super::body::RequestBody::new(&request, plaintext, skip).map_err(failure)?;
    let mut url = reqwest::Url::parse(&request.provider.base_url)
        .map_err(|_| ModelError::Adapter("invalid Responses endpoint".into()))?;
    url.set_path(&format!("{}/responses", url.path().trim_end_matches('/')));
    let headers = headers(&request)?;
    let mut decoder = Decoder::new(plaintext, &request.tools);
    if let Some(lane) = lane.filter(|_| {
        request.provider.headers.is_empty()
            && request
                .provider
                .body_overlay
                .as_ref()
                .is_none_or(|value| value.is_empty())
    }) {
        let exchange = Exchange::new(lane, cancellation.clone(), network.clone(), transport);
        match wait(
            idle_timeout,
            &decoder,
            &cancellation,
            exchange.start(url.to_string(), headers.clone(), body),
        )
        .await?
        .map_err(|error| match error {
            super::Error::Interrupted(message) => {
                interruption(&decoder, ProviderFailureReason::Network, message)
            }
            error => failure(error),
        })? {
            Some(full) => body = full,
            None => {
                while let Some(frame) = wait(idle_timeout, &decoder, &cancellation, exchange.next())
                    .await?
                    .map_err(|error| match error {
                        super::Error::Interrupted(message) => {
                            interruption(&decoder, ProviderFailureReason::StreamTruncated, message)
                        }
                        error => failure(error),
                    })?
                {
                    sender.progress();
                    let value = serde_json::from_str(&frame).map_err(|_| {
                        ModelError::Adapter("invalid Responses WebSocket JSON".into())
                    })?;
                    emit(&mut decoder, value, &sender, &cancellation).await?;
                }
                return decoder.end().map_err(failure);
            }
        }
    }
    let response = request_http(
        network.as_ref(),
        http::Request {
            method: http::Method::Post,
            url: url.to_string(),
            headers: headers.into_iter().collect(),
            body: body.http(),
        },
        &cancellation,
        idle_timeout,
        &decoder,
    )
    .await?;
    let result = read_response(
        &response,
        &mut decoder,
        &sender,
        idle_timeout,
        &cancellation,
    )
    .await;
    // A provider may finish before it consumes the complete upload. All exits,
    // including terminal SSE, rejection, timeout and cancellation, settle the
    // response's upload lease before this adapter returns.
    response.body.close().await.map_err(|error| match error {
        http::Error::CleanupUnconfirmed => ModelError::CleanupUnconfirmed,
        other => ModelError::Adapter(other.to_string()),
    })?;
    result
}
async fn read_response(
    response: &http::Response,
    decoder: &mut Decoder,
    sender: &Arc<dyn Events>,
    idle_timeout: Duration,
    cancellation: &CancellationToken,
) -> Result<(), ModelError> {
    let content_type = header(&response.head, "content-type");
    // Some Responses endpoints omit Content-Type even for a valid event
    // stream. The decoder still validates its frames and terminal outcome.
    let event_stream = content_type.is_none_or(|value| {
        value
            .split(';')
            .next()
            .is_some_and(|value| value.trim().eq_ignore_ascii_case("text/event-stream"))
    });
    if !(200..300).contains(&response.head.status) || !event_stream {
        let status = response.head.status;
        let retry_after = header(&response.head, "retry-after")
            .and_then(|v| v.parse::<u64>().ok())
            .and_then(|v| v.checked_mul(1000));
        let reason = match status {
            429 => Some(ProviderFailureReason::RateLimit),
            500..=599 => Some(ProviderFailureReason::ProviderUnavailable),
            _ => None,
        };
        // A stalled error body cannot turn an explicit permanent rejection
        // into a retry, or discard rate-limit advice already in the headers.
        let body_failure = || match reason {
            Some(reason) => ModelError::Provider(ProviderFailure::new(
                reason,
                format!("Responses HTTP {status}: error body interrupted"),
                true,
                retry_after,
            )),
            None if !(200..300).contains(&status) => http_failure(status),
            None => ModelError::Adapter(format!("Responses HTTP {status}: error body interrupted")),
        };
        let mut bytes = Vec::new();
        while let Some(chunk) = wait(idle_timeout, decoder, cancellation, response.body.next())
            .await
            .map_err(|error| {
                if matches!(error, ModelError::Cancelled) {
                    error
                } else {
                    body_failure()
                }
            })?
            .map_err(|error| match error {
                http::Error::Denied => ModelError::Cancelled,
                http::Error::CleanupUnconfirmed => ModelError::CleanupUnconfirmed,
                _ => body_failure(),
            })?
        {
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        let code = value["error"]["code"]
            .as_str()
            .or_else(|| value["error"]["type"].as_str());
        if code.is_some_and(context_overflow) {
            return Err(ModelError::ContextOverflow {
                observed_output: false,
            });
        }
        if let Some(reason) = reason {
            return Err(ModelError::Provider(ProviderFailure::new(
                reason,
                format!("Responses HTTP {status}"),
                true,
                retry_after,
            )));
        }
        if (200..300).contains(&status) {
            let message = value["error"]["message"]
                .as_str()
                .or_else(|| value["detail"].as_str())
                .unwrap_or("request rejected");
            let content_type = content_type.unwrap_or("missing Content-Type");
            return Err(ModelError::Adapter(format!(
                "Responses HTTP {status} returned {content_type}, expected text/event-stream: {message}"
            )));
        }
        return Err(http_failure(status));
    }
    let mut sse = maka_provider_protocol::responses::sse::Sse::default();
    let mut received_event = false;
    let missing_events = || {
        ModelError::Adapter(format!(
            "Responses HTTP {} had missing Content-Type and no SSE events",
            response.head.status
        ))
    };
    while let Some(chunk) = wait(idle_timeout, decoder, cancellation, response.body.next())
        .await
        .map_err(|error| {
            if matches!(error, ModelError::Cancelled) {
                error
            } else if content_type.is_none() && !received_event {
                missing_events()
            } else {
                error
            }
        })?
        .map_err(|error| match error {
            http::Error::Failed(_) if content_type.is_none() && !received_event => missing_events(),
            http::Error::Failed(_) => interruption(
                decoder,
                ProviderFailureReason::Network,
                "Responses stream read failed",
            ),
            http::Error::Denied => ModelError::Cancelled,
            http::Error::CleanupUnconfirmed => ModelError::CleanupUnconfirmed,
            other => ModelError::Adapter(other.to_string()),
        })?
    {
        for byte in chunk {
            if let Some(value) = sse.push(byte).map_err(|error| failure(error.into()))? {
                received_event = true;
                emit(decoder, value, sender, cancellation).await?;
                if decoder.finished() {
                    return Ok(());
                }
            }
        }
    }
    if content_type.is_none() && !received_event {
        // An untyped JSON/HTML response is not evidence of a retryable stream
        // interruption, whether it ends, stalls, or disconnects.
        return Err(missing_events());
    }
    decoder.end().map_err(failure)
}

fn headers(request: &ModelRequest) -> Result<BTreeMap<String, String>, ModelError> {
    let mut headers = BTreeMap::from([
        ("content-type".into(), "application/json".into()),
        ("accept".into(), "text/event-stream".into()),
    ]);
    match &request.provider.auth {
        ProviderAuth::ApiKey(token) => {
            headers.insert("authorization".into(), format!("Bearer {token}"));
        }
        ProviderAuth::RequestHeaders(prepared) => {
            for (name, value) in prepared {
                let name = name.to_ascii_lowercase();
                if headers.get(&name).is_some_and(|existing| existing != value) {
                    return Err(ModelError::Adapter(format!(
                        "Authentication header conflicts with protocol header: {name}"
                    )));
                }
                headers.insert(name, value.clone());
            }
        }
    }
    for (key, value) in &request.provider.headers {
        let key = key.to_ascii_lowercase();
        if headers.get(&key).is_some_and(|existing| existing != value) {
            return Err(ModelError::Adapter(format!(
                "Custom request header conflicts with a generated header: {key}"
            )));
        }
        headers.insert(key, value.clone());
    }
    Ok(headers)
}
fn context_overflow(code: &str) -> bool {
    matches!(
        code,
        "context_length_exceeded" | "model_context_window_exceeded" | "request_too_large"
    )
}
fn failure(error: super::Error) -> ModelError {
    use super::Error;
    match error {
        Error::CleanupUnconfirmed => ModelError::CleanupUnconfirmed,
        Error::Truncated {
            replay_safe,
            retained_output_safe,
        } => ModelError::Provider(
            ProviderFailure::new(
                ProviderFailureReason::StreamTruncated,
                "model stream ended without finish",
                replay_safe,
                None,
            )
            .with_retained_output(retained_output_safe),
        ),
        Error::Provider {
            code,
            observed_output,
            ..
        } if code.as_deref().is_some_and(context_overflow) => {
            ModelError::ContextOverflow { observed_output }
        }
        Error::Provider {
            code,
            message,
            replay_safe,
            retained_output_safe,
            ..
        } if matches!(
            code.as_deref(),
            Some("rate_limit_exceeded" | "server_error" | "service_unavailable")
        ) =>
        {
            let reason = if code.as_deref() == Some("rate_limit_exceeded") {
                ProviderFailureReason::RateLimit
            } else {
                ProviderFailureReason::ProviderUnavailable
            };
            ModelError::Provider(
                ProviderFailure::new(reason, message, replay_safe, None)
                    .with_retained_output(retained_output_safe),
            )
        }
        error => ModelError::Adapter(error.to_string()),
    }
}

fn header<'a>(head: &'a http::Head, name: &str) -> Option<&'a str> {
    head.headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .and_then(|(_, value)| std::str::from_utf8(value).ok())
}

#[cfg(test)]
mod upload_settlement_tests {
    use super::*;
    use futures_util::future::BoxFuture;
    use maka_agent_ports::model::{Connect, Socket, Transport};
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::sync::Notify;

    #[derive(Default)]
    struct Draining {
        entered: Notify,
        cancelled: Notify,
        release: Notify,
        settled: AtomicBool,
        unknown: bool,
    }
    impl Transport for Draining {
        fn identity(&self) -> u64 {
            0
        }
        fn request(
            &self,
            input: http::Request,
            cancellation: CancellationToken,
        ) -> BoxFuture<'_, Result<http::Response, ModelError>> {
            Box::pin(async move {
                let _input = input;
                self.entered.notify_one();
                cancellation.cancelled().await;
                self.cancelled.notify_one();
                self.release.notified().await;
                self.settled.store(true, Ordering::SeqCst);
                Err(if self.unknown {
                    ModelError::CleanupUnconfirmed
                } else {
                    ModelError::Cancelled
                })
            })
        }
        fn connect(&self, _: Connect) -> BoxFuture<'_, Result<Arc<dyn Socket>, ModelError>> {
            Box::pin(async { Err(ModelError::Adapter("unused fixture transport".into())) })
        }
    }
    #[tokio::test]
    async fn cancellation_and_idle_timeout_wait_for_upload_settlement() {
        for (timeout, unknown) in [(false, false), (true, false), (false, true), (true, true)] {
            let network = Arc::new(Draining {
                unknown,
                ..Default::default()
            });
            let cancellation = CancellationToken::new();
            let task_network = network.clone();
            let task_cancel = cancellation.clone();
            let task = tokio::spawn(async move {
                let decoder = Decoder::new(None, &[]);
                request_http(
                    task_network.as_ref(),
                    http::Request {
                        method: http::Method::Post,
                        url: "http://fixture.invalid".into(),
                        headers: vec![],
                        body: Default::default(),
                    },
                    &task_cancel,
                    if timeout {
                        Duration::from_millis(10)
                    } else {
                        Duration::from_secs(10)
                    },
                    &decoder,
                )
                .await
            });
            network.entered.notified().await;
            if !timeout {
                cancellation.cancel();
            }
            network.cancelled.notified().await;
            assert!(
                !task.is_finished(),
                "the deadline must not discard an unsettled upload future"
            );
            assert!(!network.settled.load(Ordering::SeqCst));
            network.release.notify_one();
            let result = task.await.unwrap();
            if unknown {
                assert!(
                    matches!(result, Err(ModelError::CleanupUnconfirmed)),
                    "cancellation must not hide unconfirmed cleanup"
                );
            } else if timeout {
                assert!(
                    matches!(result, Err(ModelError::Provider(failure)) if failure.reason() == ProviderFailureReason::TimedOut)
                );
            } else {
                assert!(matches!(result, Err(ModelError::Cancelled)));
            }
            assert!(network.settled.load(Ordering::SeqCst));
        }
    }
}
