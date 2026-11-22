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

//! Per-execution HTTP/CONNECT gateway. Destination authority and upstream routing
//! are independent immutable inputs. The native sandbox enforces direct network
//! access separately from proxy settings. MXC restricted networking also permits
//! host loopback services, matching its native policy contract.

use crate::{Policy, tunnel};
use futures_util::TryStreamExt;
use http_body_util::{BodyExt, Full, StreamBody, combinators::UnsyncBoxBody};
use hyper::{
    Request, Response, StatusCode,
    body::{Bytes, Frame, Incoming},
};
use hyper_util::rt::{TokioIo, TokioTimer};
use maka_sandbox::{Destination, Network};
use std::{
    convert::Infallible,
    io,
    net::{Ipv4Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use tokio::{net::TcpListener, sync::Semaphore, task::JoinHandle};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

type Body = UnsyncBoxBody<Bytes, io::Error>;

/// The process owner retains this lease until tree settlement. Closing it also
/// interrupts established tunnels; no request survives its execution owner.
pub struct Proxy {
    cancellation: CancellationToken,
    worker: Option<JoinHandle<io::Result<()>>>,
    failure: Option<String>,
}

impl Proxy {
    pub async fn start(network: Network, route: Policy) -> io::Result<(SocketAddr, Self)> {
        Self::start_at(network, route, SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await
    }

    pub async fn start_at(
        network: Network,
        route: Policy,
        address: SocketAddr,
    ) -> io::Result<(SocketAddr, Self)> {
        if !address.ip().is_loopback() {
            return Err(io::Error::other("execution gateway must use loopback"));
        }
        let socket = if address.is_ipv4() {
            tokio::net::TcpSocket::new_v4()?
        } else {
            tokio::net::TcpSocket::new_v6()?
        };
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawSocket;
            use windows_sys::Win32::Networking::WinSock::{
                SO_EXCLUSIVEADDRUSE, SOCKET_ERROR, SOL_SOCKET, WSAGetLastError, setsockopt,
            };
            let enabled = 1i32;
            // A sibling process using SO_REUSEADDR must not steal a gateway's
            // reserved address while its execution owns the listener.
            if unsafe {
                setsockopt(
                    socket.as_raw_socket() as _,
                    SOL_SOCKET,
                    SO_EXCLUSIVEADDRUSE,
                    (&enabled as *const i32).cast(),
                    size_of::<i32>() as i32,
                )
            } == SOCKET_ERROR
            {
                return Err(io::Error::from_raw_os_error(unsafe { WSAGetLastError() }));
            }
        }
        socket.bind(address)?;
        let listener = socket.listen(128)?;
        let address = listener.local_addr()?;
        Ok((
            address,
            Self::serve(network, route, async move { Ok(listener) })?,
        ))
    }

    /// Linux supplies a listener created inside the child's private namespace.
    /// Cancellation owns the handoff too: a failed launch cannot leave a waiter.
    pub fn serve(
        network: Network,
        route: Policy,
        listener: impl std::future::Future<Output = io::Result<TcpListener>> + Send + 'static,
    ) -> io::Result<Self> {
        let cancellation = CancellationToken::new();
        let stopped = cancellation.clone();
        let client = route
            .client_builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .no_zstd()
            .build()
            .map_err(io::Error::other)?;
        let worker = tokio::spawn(async move {
            let listener = tokio::select! {
                _ = stopped.cancelled() => return Ok(()),
                listener = listener => listener?,
            };
            let tasks = TaskTracker::new();
            let permits = Arc::new(Semaphore::new(64));
            let state = Arc::new(State {
                network,
                route,
                client,
                cancellation: stopped.clone(),
                tasks: tasks.clone(),
            });
            let result = async {
                loop {
                    let permit = tokio::select! {
                        _ = stopped.cancelled() => break,
                        permit = permits.clone().acquire_owned() => Arc::new(permit.map_err(io::Error::other)?),
                    };
                    let (socket, _) = tokio::select! {
                        _ = stopped.cancelled() => break,
                        connection = listener.accept() => connection?,
                    };
                    let state = state.clone();
                    tasks.spawn(async move {
                        let stopped = state.cancellation.clone();
                        let service = hyper::service::service_fn(move |request| {
                            let state = state.clone();
                            let permit = permit.clone();
                            async move {
                                let response = state.request(request, permit).await;
                                Ok::<_, Infallible>(response)
                            }
                        });
                        let mut builder = hyper::server::conn::http1::Builder::new();
                        builder.timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(10)).max_buf_size(32 * 1024);
                        tokio::select! {
                            _ = stopped.cancelled() => {}
                            _ = builder.serve_connection(TokioIo::new(socket), service).with_upgrades() => {}
                        }
                    });
                }
                Ok(())
            }.await;
            // Stop on listener errors too. All connection and upgrade tasks are
            // tracked; cancellation cannot detach an in-flight connect or body.
            stopped.cancel();
            drop(listener);
            tasks.close();
            tasks.wait().await;
            result
        });
        Ok(Self {
            cancellation,
            worker: Some(worker),
            failure: None,
        })
    }
    pub async fn close(&mut self) -> io::Result<()> {
        self.cancellation.cancel();
        if let Some(worker) = &mut self.worker {
            let result = worker
                .await
                .map_err(io::Error::other)
                .and_then(|result| result);
            self.worker = None;
            self.failure = result.err().map(|error| error.to_string());
        }
        match &self.failure {
            Some(error) => Err(io::Error::other(error.clone())),
            None => Ok(()),
        }
    }
}
impl Drop for Proxy {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}

struct State {
    network: Network,
    route: Policy,
    client: reqwest::Client,
    cancellation: CancellationToken,
    tasks: TaskTracker,
}
impl State {
    async fn request(
        self: Arc<Self>,
        mut request: Request<Incoming>,
        permit: Arc<tokio::sync::OwnedSemaphorePermit>,
    ) -> Response<Body> {
        if request.method() == hyper::Method::CONNECT {
            let Some(authority) = request.uri().authority() else {
                return status(StatusCode::BAD_REQUEST, "CONNECT requires a destination");
            };
            if request.uri().scheme().is_some() || request.uri().path_and_query().is_some() {
                return status(StatusCode::BAD_REQUEST, "CONNECT requires authority form");
            }
            let Some(port) = authority.port_u16() else {
                return status(StatusCode::BAD_REQUEST, "CONNECT requires an explicit port");
            };
            let Ok(destination) = Destination::new(authority.host(), port) else {
                return status(StatusCode::BAD_REQUEST, "invalid destination");
            };
            if !self.network.allows(&destination) {
                return denied(&destination);
            }
            let mut upstream = match tunnel::connect(&self.route, &destination).await {
                Ok(stream) => stream,
                Err(_) => return status(StatusCode::BAD_GATEWAY, "upstream connection failed"),
            };
            let upgrade = hyper::upgrade::on(&mut request);
            let stopped = self.cancellation.clone();
            self.tasks.spawn(async move {
                let _permit = permit;
                tokio::select! {
                    _ = stopped.cancelled() => {}
                    _ = async {
                        if let Ok(upgrade) = upgrade.await {
                            let mut client = TokioIo::new(upgrade);
                            let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
                        }
                    } => {}
                }
            });
            return status(StatusCode::OK, "");
        }
        let Ok(url) = reqwest::Url::parse(&request.uri().to_string()) else {
            return status(
                StatusCode::BAD_REQUEST,
                "proxy requires an absolute HTTP URL",
            );
        };
        if url.scheme() != "http"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return status(StatusCode::BAD_REQUEST, "use CONNECT for TLS");
        }
        let Ok(destination) = Destination::new(
            url.host_str().unwrap_or_default(),
            url.port_or_known_default().unwrap_or_default(),
        ) else {
            return status(StatusCode::BAD_REQUEST, "invalid destination");
        };
        if !self.network.allows(&destination) {
            return denied(&destination);
        }
        if request.headers().contains_key(hyper::header::UPGRADE) {
            return status(
                StatusCode::BAD_REQUEST,
                "use CONNECT for upgraded protocols",
            );
        }
        let (mut parts, body) = request.into_parts();
        strip_hop_headers(&mut parts.headers);
        // Only URI authority selects the destination. Reconstruct Host rather
        // than forwarding a conflicting client-supplied value.
        parts.headers.remove(hyper::header::HOST);
        let body = reqwest::Body::wrap_stream(body.into_data_stream());
        let response = self
            .client
            .request(parts.method, url)
            .headers(parts.headers)
            .body(body)
            .send()
            .await;
        let Ok(mut response) = response else {
            return status(StatusCode::BAD_GATEWAY, "upstream request failed");
        };
        let mut headers = std::mem::take(response.headers_mut());
        strip_hop_headers(&mut headers);
        let code = response.status();
        let body = StreamBody::new(
            response
                .bytes_stream()
                .map_ok(Frame::data)
                .map_err(io::Error::other),
        );
        let mut response = Response::new(body.boxed_unsync());
        *response.status_mut() = code;
        *response.headers_mut() = headers;
        response
    }
}

fn strip_hop_headers(headers: &mut hyper::HeaderMap) {
    let named: Vec<_> = headers
        .get_all(hyper::header::CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .filter_map(|v| hyper::header::HeaderName::from_bytes(v.trim().as_bytes()).ok())
        .collect();
    for name in named {
        headers.remove(name);
    }
    for name in [
        "connection",
        "proxy-connection",
        "proxy-authorization",
        "proxy-authenticate",
        "keep-alive",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ] {
        headers.remove(name);
    }
}
fn denied(destination: &Destination) -> Response<Body> {
    status(
        StatusCode::FORBIDDEN,
        &format!(
            "network destination denied: {}",
            tunnel::authority(destination)
        ),
    )
}
fn status(code: StatusCode, message: &str) -> Response<Body> {
    let mut response = Response::new(
        Full::new(Bytes::copy_from_slice(message.as_bytes()))
            .map_err(|never| match never {})
            .boxed_unsync(),
    );
    *response.status_mut() = code;
    response
}
