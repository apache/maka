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
    pub transport: Arc<Network>,
    pub events: Arc<dyn maka_agent_ports::model::Events>,
    pub cancellation: CancellationToken,
    pub source: Option<maka_agent_ports::model::RequestSource>,
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
            let pending = self
                .transport
                .request_http(request, stop.clone(), self.source.as_ref());
            tokio::pin!(pending);
            let response = tokio::select! {
                biased;
                _ = self.cancellation.cancelled() => {
                    stop.cancel();
                    pending.as_mut().await?
                },
                _ = cancellation.cancelled() => {
                    stop.cancel();
                    pending.as_mut().await?
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
            if let Some(source) = &self.source {
                source.frozen.authorize(self.cancellation.clone()).await?;
            }
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
    fn send_text(
        &self,
        socket: Arc<dyn Socket>,
        chunks: maka_agent_ports::model::TextStream,
    ) -> BoxFuture<'_, Result<(), Error>> {
        Box::pin(async move {
            if let Some(source) = &self.source {
                source.frozen.authorize(self.cancellation.clone()).await?;
            }
            if self.cancellation.is_cancelled() {
                return Err(Error::Cancelled);
            }
            self.transport.send_text(socket, chunks).await
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
    pub fn get(&self, policy: &maka_network::Policy) -> Result<Arc<Network>, Error> {
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
pub(super) struct Network {
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
    fn send_text(
        &self,
        socket: Arc<dyn Socket>,
        chunks: maka_agent_ports::model::TextStream,
    ) -> BoxFuture<'_, Result<(), Error>> {
        Box::pin(async move { socket.send_text(chunks).await })
    }
    fn identity(&self) -> u64 {
        self.identity
    }
    fn request(
        &self,
        request: http::Request,
        cancellation: CancellationToken,
    ) -> BoxFuture<'_, Result<http::Response, Error>> {
        Box::pin(self.request_http(request, cancellation, None))
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
        // Joining this request's connection drivers drops their upload wrappers;
        // the original receipt also waits for all retained source byte slices.
        self.connections.close().await;
        let mut receipt = self.receipt.lock().await;
        receipt.source_released().await?;
        receipt.finish().await.map(|_| ())
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
fn response_error(error: reqwest::Error) -> http::Error {
    match failure(error) {
        Error::Provider(_) => http::Error::Failed("model HTTP stream interrupted".into()),
        _ => http::Error::Invalid("invalid model HTTP stream".into()),
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
            let result = {
                let chunk = body.chunk();
                tokio::pin!(chunk);
                let mut receipt = self.upload.receipt.lock().await;
                let close_source = receipt.needs_source_close();
                tokio::select! {
                    biased;
                    _ = self.cancelled.cancelled() => Err(http::Error::Denied),
                    result = &mut chunk => result.map_err(response_error),
                    released = receipt.source_released(), if close_source => {
                        released?;
                        receipt.close_source().await?;
                        tokio::select! {
                            biased;
                            _ = self.cancelled.cancelled() => Err(http::Error::Denied),
                            result = &mut chunk => result.map_err(response_error),
                        }
                    }
                }
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
        WsError::Io(cause) => transport_cause(cause).0,
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

fn transport_cause(mut error: &(dyn std::error::Error + 'static)) -> (bool, String) {
    let mut transient = false;
    loop {
        if let Some(error) = error.downcast_ref::<hyper::Error>() {
            transient |= error.is_closed() || error.is_incomplete_message();
        }
        let next = if let Some(io) = error.downcast_ref::<std::io::Error>() {
            transient |= transient_io(io.kind());
            // io::Error::source() can skip the wrapped error itself.
            io.get_ref()
                .map(|inner| inner as &(dyn std::error::Error + 'static))
                .or_else(|| error.source())
        } else {
            error.source()
        };
        match next {
            Some(next) => error = next,
            None => return (transient, error.to_string()),
        }
    }
}

fn transient_connect_tunnel(detail: &str) -> bool {
    // hyper-util's TunnelError is private, so match its transient HTTP CONNECT
    // variants only when reqwest already proved the failure happened during
    // connection setup (before any request bytes were sent).
    matches!(
        detail,
        "tunnel error: unexpected end of file" | "tunnel error: unsuccessful"
    )
}

pub(super) fn failure(error: reqwest::Error) -> Error {
    let error = error.without_url();
    let (source_transient, detail) = transport_cause(&error);
    if error.is_timeout()
        || error.is_dns()
        || source_transient
        || (error.is_connect() && transient_connect_tunnel(&detail))
    {
        Error::Provider(ProviderFailure::new(
            ProviderFailureReason::Network,
            format!("model HTTP transport interrupted: {detail}"),
            true,
            None,
        ))
    } else {
        Error::Adapter(format!("model HTTP request failed: {detail}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::configuration::policy::{NetworkProxy, ProxyProtocol};
    use std::time::Duration;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[tokio::test]
    async fn proxy_tunnel_interruptions_retry_while_proxy_auth_and_invalid_tls_do_not() {
        tokio::time::timeout(Duration::from_secs(10), async {
            for (response, expect_retryable, expected_detail) in [
                (
                    Some(&b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"[..]),
                    true,
                    "tunnel error: unsuccessful",
                ),
                (None, true, "tunnel error: unexpected end of file"),
                (
                    Some(
                        &b"HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n"
                            [..],
                    ),
                    false,
                    "tunnel error: proxy authorization required",
                ),
            ] {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let proxy_addr = listener.local_addr().unwrap();
                let proxy = tokio::spawn(async move {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let mut head = Vec::new();
                    while !head.ends_with(b"\r\n\r\n") {
                        let mut byte = [0];
                        if socket.read(&mut byte).await.unwrap() == 0 {
                            break;
                        }
                        head.push(byte[0]);
                    }
                    if let Some(reply) = response {
                        socket.write_all(reply).await.unwrap();
                    }
                    socket.shutdown().await.unwrap();
                });

                let policy = maka_network::Policy::from_settings(
                    &NetworkProxy {
                        enabled: true,
                        protocol: ProxyProtocol::Http,
                        host: proxy_addr.ip().to_string(),
                        port: proxy_addr.port(),
                        auth_enabled: false,
                        username: String::new(),
                        bypass_list: Vec::new(),
                        auto_bypass_domains: Vec::new(),
                    },
                    None,
                )
                .unwrap();
                let network = Pool::default().get(&policy).unwrap();
                let error = network
                    .request(
                        http::Request {
                            method: maka_plugin_core::http::Method::Get,
                            url: "https://upstream.example/?api_key=must-not-appear".into(),
                            headers: Vec::new(),
                            body: Default::default(),
                        },
                        CancellationToken::new(),
                    )
                    .await
                    .err()
                    .expect("proxy CONNECT failure must fail the request");
                proxy.await.unwrap();

                let message = error.to_string();
                assert!(
                    !message.contains("must-not-appear"),
                    "request URLs must stay private: {message}"
                );
                if expect_retryable {
                    let Error::Provider(failure) = error else {
                        panic!("transient proxy tunnel error must be retryable: {message}");
                    };
                    assert_eq!(failure.reason(), ProviderFailureReason::Network);
                    assert!(failure.retryable() && failure.replay_safe());
                    assert!(
                        failure.message().contains(expected_detail),
                        "expected {expected_detail:?} in {message}"
                    );
                } else {
                    assert!(
                        matches!(error, Error::Adapter(_)),
                        "proxy auth failure must stay non-retryable: {message}"
                    );
                    assert!(
                        message.contains(expected_detail),
                        "expected {expected_detail:?} in {message}"
                    );
                }
            }

            // Guard that is_connect() matching does not turn invalid TLS into a retryable failure.
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!(
                "https://{}/?api_key=must-not-appear",
                listener.local_addr().unwrap()
            );
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut record = [0; 5];
                socket.read_exact(&mut record).await.unwrap();
                let mut hello = vec![0; usize::from(u16::from_be_bytes([record[3], record[4]]))];
                socket.read_exact(&mut hello).await.unwrap();
                socket
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                    .await
                    .unwrap();
                socket.shutdown().await.unwrap();
            });
            let network = Pool::default()
                .get(&maka_network::Policy::default())
                .unwrap();
            let error = network
                .request(
                    http::Request {
                        method: maka_plugin_core::http::Method::Get,
                        url,
                        headers: Vec::new(),
                        body: Default::default(),
                    },
                    CancellationToken::new(),
                )
                .await
                .err()
                .expect("invalid TLS must fail");
            server.await.unwrap();
            let message = error.to_string();
            assert!(
                !message.contains("must-not-appear"),
                "request URLs must stay private: {message}"
            );
            assert!(
                matches!(error, Error::Adapter(_)),
                "invalid TLS must not become a retryable connection failure: {message}"
            );
        })
        .await
        .unwrap();
    }
}
