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

//! Host-owned model I/O shared by built-in and JavaScript adapters.
use futures_util::future::BoxFuture;
use maka_agent_facts::model::error::ProviderFailure;
use maka_agent_facts::model::error::ProviderFailureReason;
use maka_agent_ports::model::Connect;
use maka_agent_ports::model::Error;
use maka_agent_ports::model::Socket;
use maka_agent_ports::model::Transport;
use maka_capabilities::http;
use std::{
    collections::{HashMap, hash_map::RandomState},
    hash::BuildHasher,
    sync::{Arc, Mutex},
};
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

/// The pool owns connections; this handle admits I/O only while its call lives.
pub(super) struct Call {
    pub transport: Arc<dyn Transport>,
    pub events: Arc<dyn maka_agent_ports::model::Events>,
    pub cancellation: CancellationToken,
}
impl Transport for Call {
    fn identity(&self) -> u64 {
        self.transport.identity()
    }
    fn request(
        &self,
        request: http::Request,
        cancellation: CancellationToken,
    ) -> BoxFuture<'_, Result<http::Response, Error>> {
        Box::pin(async move {
            let stop = self.cancellation.child_token();
            let pending = self.transport.request(request, stop.clone());
            tokio::pin!(pending);
            let response = tokio::select! {
                biased;
                _ = self.cancellation.cancelled() => {
                    stop.cancel();
                    let cleanup_started = tokio::time::Instant::now();
                    tokio::time::timeout(std::time::Duration::from_secs(11), &mut pending).await
                        .map_err(|_| {
                            tracing::error!(
                                stage = "model_call_cancel_drain",
                                outcome = "timeout",
                                timeout_ms = 11000_u64,
                                elapsed_ms = cleanup_started.elapsed().as_millis(),
                                "cleanup unconfirmed"
                            );
                            cleanup_unconfirmed()
                        })??
                },
                _ = cancellation.cancelled() => {
                    stop.cancel();
                    let cleanup_started = tokio::time::Instant::now();
                    tokio::time::timeout(std::time::Duration::from_secs(11), &mut pending).await
                        .map_err(|_| {
                            tracing::error!(
                                stage = "model_request_cancel_drain",
                                outcome = "timeout",
                                timeout_ms = 11000_u64,
                                elapsed_ms = cleanup_started.elapsed().as_millis(),
                                "cleanup unconfirmed"
                            );
                            cleanup_unconfirmed()
                        })??
                },
                response = &mut pending => response?,
            };
            if stop.is_cancelled() {
                response.body.cancel();
                response
                    .body
                    .close()
                    .await
                    .map_err(|_| cleanup_unconfirmed())?;
                return Err(Error::Cancelled);
            }
            self.events.progress();
            Ok(http::Response {
                head: response.head,
                body: Arc::new(CallBody {
                    body: response.body,
                    events: self.events.clone(),
                    cancellation: self.cancellation.clone(),
                    request_cancellation: cancellation,
                }),
            })
        })
    }
    fn connect(&self, request: Connect) -> BoxFuture<'_, Result<Arc<dyn Socket>, Error>> {
        Box::pin(async move {
            let socket = tokio::select! {
                biased;
                _ = self.cancellation.cancelled() => return Err(Error::Cancelled),
                socket = self.transport.connect(request) => socket?,
            };
            self.events.progress();
            // Accepted sockets belong to the adapter session and may outlive
            // this request. Each new call supplies its own cancellation context.
            Ok(socket)
        })
    }
}
struct CallBody {
    body: Arc<dyn http::Body>,
    events: Arc<dyn maka_agent_ports::model::Events>,
    cancellation: CancellationToken,
    request_cancellation: CancellationToken,
}
impl http::Body for CallBody {
    fn next(&self) -> BoxFuture<'_, Result<Option<Vec<u8>>, http::Error>> {
        Box::pin(async move {
            let result = tokio::select! {
                biased;
                _ = self.cancellation.cancelled() => {
                    self.body.cancel();
                    self.body.close().await?;
                    return Err(http::Error::Denied);
                },
                _ = self.request_cancellation.cancelled() => {
                    self.body.cancel();
                    self.body.close().await?;
                    return Err(http::Error::Denied);
                },
                result = self.body.next() => result?,
            };
            self.events.progress();
            Ok(result)
        })
    }
    fn cancel(&self) {
        self.body.cancel();
    }
    fn close(&self) -> BoxFuture<'_, Result<(), http::Error>> {
        self.body.close()
    }
}

#[derive(Default)]
pub(super) struct Pool {
    routes: Mutex<HashMap<maka_network::Policy, Arc<Network>>>,
    identity: RandomState,
}
impl Pool {
    pub fn get(&self, policy: &maka_network::Policy) -> Result<Arc<dyn Transport>, Error> {
        let mut routes = self.routes.lock().unwrap();
        if let Some(network) = routes.get(policy) {
            return Ok(network.clone());
        }
        let network = Arc::new(Network {
            policy: policy.clone(),
            tls: maka_network::TlsConfigCache::default(),
            identity: self.identity.hash_one(policy),
        });
        // Settings edits cannot accumulate an unbounded pool of obsolete clients.
        if routes.len() >= 16 {
            routes.clear();
        }
        routes.insert(policy.clone(), network.clone());
        Ok(network)
    }
}
struct Network {
    tls: maka_network::TlsConfigCache,
    policy: maka_network::Policy,
    identity: u64,
}
fn headers(values: Vec<(String, String)>) -> Result<reqwest::header::HeaderMap, Error> {
    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in values {
        let name = name
            .parse::<reqwest::header::HeaderName>()
            .map_err(|_| Error::Adapter("invalid model HTTP header".into()))?;
        let bytes = value
            .chars()
            .map(u8::try_from)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| Error::Adapter("invalid model HTTP header".into()))?;
        let value = reqwest::header::HeaderValue::from_bytes(&bytes)
            .map_err(|_| Error::Adapter("invalid model HTTP header".into()))?;
        headers
            .try_append(name, value)
            .map_err(|_| Error::Adapter("model HTTP headers cannot be represented".into()))?;
    }
    Ok(headers)
}
impl Transport for Network {
    fn identity(&self) -> u64 {
        self.identity
    }
    fn request(
        &self,
        request: http::Request,
        cancellation: CancellationToken,
    ) -> BoxFuture<'_, Result<http::Response, Error>> {
        Box::pin(self.request_http(request, cancellation))
    }
    fn connect(&self, request: Connect) -> BoxFuture<'_, Result<Arc<dyn Socket>, Error>> {
        Box::pin(async move {
            let mut url = reqwest::Url::parse(&request.url)
                .map_err(|_| Error::Adapter("invalid model WebSocket URL".into()))?;
            let scheme = match url.scheme() {
                "ws" | "http" => "http",
                "wss" | "https" => "https",
                _ => return Err(Error::Adapter("invalid model WebSocket scheme".into())),
            };
            url.set_scheme(scheme)
                .map_err(|_| Error::Adapter("invalid model WebSocket scheme".into()))?;
            let request_headers = headers(request.headers)?;
            let socket = maka_network::connect_websocket(
                &self.policy,
                self.policy.client_builder(),
                url.as_str(),
                request_headers,
                usize::MAX,
            )
            .await
            .map_err(|_| Error::Adapter("model WebSocket connection failed".into()))?;
            Ok(Arc::new(Connection::new(socket)) as Arc<dyn Socket>)
        })
    }
}
struct UploadLease {
    connections: maka_network::ConnectionTasks,
    stop: CancellationToken,
    receipt: AsyncMutex<http::upload::Receipt>,
}
impl UploadLease {
    async fn finish(&self) -> Result<(), http::Error> {
        self.stop.cancel();
        self.connections.close().await;
        self.receipt.lock().await.finish().await.map(|_| ())
    }
}
impl Drop for UploadLease {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}
fn cleanup_unconfirmed() -> Error {
    Error::CleanupUnconfirmed
}
struct Body {
    response: AsyncMutex<Option<reqwest::Response>>,
    cancelled: CancellationToken,
    upload: UploadLease,
}
impl Drop for Body {
    fn drop(&mut self) {
        self.cancelled.cancel();
    }
}
impl http::Body for Body {
    fn next(&self) -> BoxFuture<'_, Result<Option<Vec<u8>>, http::Error>> {
        Box::pin(async move {
            let mut response = self.response.lock().await;
            let Some(body) = response.as_mut() else {
                self.upload.finish().await?;
                return Ok(None);
            };
            let result = tokio::select! {
                biased;
                _ = self.cancelled.cancelled() => Err(http::Error::Denied),
                result = body.chunk() => result.map_err(|error| match failure(error) {
                    Error::Provider(_) => http::Error::Failed("model HTTP stream interrupted".into()),
                    _ => http::Error::Invalid("invalid model HTTP stream".into()),
                }),
            };
            match result {
                Ok(Some(bytes)) => Ok(Some(bytes.to_vec())),
                result => {
                    response.take();
                    self.upload.finish().await?;
                    result.map(|_| None)
                }
            }
        })
    }
    fn cancel(&self) {
        self.cancelled.cancel();
        self.upload.stop.cancel();
    }
    fn close(&self) -> BoxFuture<'_, Result<(), http::Error>> {
        self.cancel();
        Box::pin(async move {
            self.response.lock().await.take();
            self.upload.finish().await
        })
    }
}
mod http_request;
mod socket;
use socket::Connection;
fn websocket_failure(operation: &str, cause: tokio_tungstenite::tungstenite::Error) -> Error {
    use tokio_tungstenite::tungstenite::{Error as WsError, error::ProtocolError};
    let transient = match &cause {
        WsError::ConnectionClosed
        | WsError::AlreadyClosed
        | WsError::Protocol(ProtocolError::ResetWithoutClosingHandshake) => true,
        WsError::Io(cause) => transient_io(cause.kind()),
        _ => false,
    };
    let message = format!("model WebSocket {operation} failed: {cause}");
    if transient {
        Error::Provider(ProviderFailure::new(
            ProviderFailureReason::Network,
            message,
            false,
            None,
        ))
    } else {
        Error::Adapter(message)
    }
}

fn transient_io(kind: std::io::ErrorKind) -> bool {
    use std::io::ErrorKind;
    matches!(
        kind,
        ErrorKind::ConnectionRefused
            | ErrorKind::UnexpectedEof
            | ErrorKind::ConnectionReset
            | ErrorKind::ConnectionAborted
            | ErrorKind::NotConnected
            | ErrorKind::BrokenPipe
            | ErrorKind::TimedOut
            | ErrorKind::HostUnreachable
            | ErrorKind::NetworkUnreachable
            | ErrorKind::NetworkDown
    )
}

pub(super) fn failure(error: reqwest::Error) -> Error {
    use std::error::Error as _;
    let mut transient = error.is_timeout() || error.is_dns();
    let mut cause = error.source();
    while let Some(error) = cause {
        if let Some(error) = error.downcast_ref::<hyper::Error>() {
            transient |= error.is_closed() || error.is_incomplete_message();
        }
        if let Some(error) = error.downcast_ref::<std::io::Error>() {
            transient |= transient_io(error.kind());
        }
        cause = error.source();
    }
    if transient {
        Error::Provider(ProviderFailure::new(
            ProviderFailureReason::Network,
            "model HTTP transport interrupted",
            true,
            None,
        ))
    } else {
        Error::Adapter("model HTTP request failed".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unrepresentable_model_headers_fail_without_panicking() {
        let values = (0..32_768)
            .map(|index| (format!("x-field-{index}"), "value".into()))
            .collect();
        let result = headers(values).and_then(|headers| {
            maka_network::Policy::default()
                .check_request_headers(
                    &reqwest::Url::parse("https://example.com/").unwrap(),
                    &headers,
                    true,
                    true,
                )
                .map_err(|_| Error::Adapter("model HTTP headers cannot be represented".into()))?;
            Ok(headers)
        });
        assert!(
            matches!(result, Err(Error::Adapter(message)) if message == "model HTTP headers cannot be represented")
        );
        let values = headers(vec![("x-safe".into(), "kept".into())]).unwrap();
        assert_eq!(values["x-safe"], "kept");
    }

    #[test]
    fn socket_write_failures_preserve_transient_network_evidence() {
        use tokio_tungstenite::tungstenite::{Error as WsError, error::ProtocolError};
        let error = websocket_failure(
            "send",
            WsError::Io(std::io::Error::from(std::io::ErrorKind::BrokenPipe)),
        );
        let Error::Provider(failure) = error else {
            panic!("broken pipe must remain a network failure")
        };
        assert_eq!(failure.reason(), ProviderFailureReason::Network);
        assert!(
            failure.message().contains("send failed")
                && failure
                    .message()
                    .to_ascii_lowercase()
                    .contains("broken pipe")
        );
        assert!(
            !failure.replay_safe(),
            "only the protocol decoder can authorize replay"
        );
        assert!(
            matches!(
                websocket_failure("send", WsError::Protocol(ProtocolError::SendAfterClosing)),
                Error::Adapter(_)
            ),
            "protocol misuse is not a retryable network outage"
        );
    }
}

#[cfg(test)]
mod http_tests;
