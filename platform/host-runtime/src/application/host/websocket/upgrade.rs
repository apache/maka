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

use std::{convert::Infallible, sync::Arc};

use base64::{Engine, engine::general_purpose::STANDARD};
use http_body_util::Full;
use hyper::{
    Method, Request, Response, StatusCode,
    body::{Bytes, Incoming},
    header::{AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE, ORIGIN, UPGRADE},
    server::conn::http1,
    service::service_fn,
    upgrade::{OnUpgrade, Upgraded},
};
use hyper_util::rt::TokioIo;
use sha2::{Digest, Sha256};
use tokio::{net::TcpStream, sync::mpsc};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{handshake::server::create_response_with_body, protocol::Role},
};

use super::super::{Host, Result};

type Body = Full<Bytes>;
type AuthenticatedUpgrade = (OnUpgrade, String);

pub(super) async fn accept(
    socket: TcpStream,
    host: Arc<Host>,
    allowed_origins: Arc<[String]>,
) -> Result<Option<(WebSocketStream<TokioIo<Upgraded>>, String)>> {
    let (sender, mut receiver) = mpsc::channel(1);
    let service = service_fn(move |request| {
        let host = host.clone();
        let allowed_origins = allowed_origins.clone();
        let sender = sender.clone();
        async move { Ok::<_, Infallible>(respond(request, &host, &allowed_origins, sender).await) }
    });
    http1::Builder::new()
        // Preserve Connection: Upgrade on 101. Plain responses explicitly
        // close instead; globally disabling keep-alive rewrites this header.
        .keep_alive(true)
        .max_buf_size(16 * 1024)
        .max_headers(64)
        .serve_connection(TokioIo::new(socket), service)
        .with_upgrades()
        .await
        .map_err(|_| "Application Host HTTP connection failed".to_string())?;

    // The single-request connection drops the service before we receive. The
    // capacity-one channel lets the service return its 101 without a waiter.
    let Some((upgrade, hash)) = receiver.recv().await else {
        return Ok(None);
    };
    let upgraded = upgrade
        .await
        .map_err(|_| "Application Host WebSocket upgrade failed".to_string())?;
    let socket = WebSocketStream::from_raw_socket(
        TokioIo::new(upgraded),
        Role::Server,
        Some(super::bytes::config()),
    )
    .await;
    Ok(Some((socket, hash)))
}

async fn respond(
    mut request: Request<Incoming>,
    host: &Host,
    allowed_origins: &[String],
    sender: mpsc::Sender<AuthenticatedUpgrade>,
) -> Response<Body> {
    if !request.headers().contains_key(UPGRADE) {
        return plain_http(&request, host);
    }
    if request.method() != Method::GET
        || request.uri().path() != "/runtime-host"
        || request.uri().query().is_some()
    {
        return plain(StatusCode::NOT_FOUND, "Not Found");
    }
    let origins = request.headers().get_all(ORIGIN);
    let mut origins = origins.iter();
    if let Some(origin) = origins.next()
        && (origins.next().is_some()
            || !allowed_origins
                .iter()
                .any(|allowed| origin.as_bytes() == allowed.as_bytes()))
    {
        return plain(StatusCode::FORBIDDEN, "Forbidden");
    }
    let Some(hash) = credential_hash(&request) else {
        return plain(StatusCode::UNAUTHORIZED, "Unauthorized");
    };
    request.headers_mut().remove(AUTHORIZATION);
    if host.credential(&hash).await.is_err() {
        return plain(StatusCode::UNAUTHORIZED, "Unauthorized");
    }
    // Tungstenite checks the protocol headers but only checks key presence.
    // Enforce the RFC 6455 nonce length and reject ambiguous singleton headers.
    for name in ["upgrade", "sec-websocket-key", "sec-websocket-version"] {
        if request.headers().get_all(name).iter().count() != 1 {
            return plain(StatusCode::BAD_REQUEST, "Bad Request");
        }
    }
    if !request
        .headers()
        .get("sec-websocket-key")
        .and_then(|key| STANDARD.decode(key.as_bytes()).ok())
        .is_some_and(|key| key.len() == 16)
    {
        return plain(StatusCode::BAD_REQUEST, "Bad Request");
    }
    let Ok(response) = create_response_with_body(&request, || Full::new(Bytes::new())) else {
        return plain(StatusCode::BAD_REQUEST, "Bad Request");
    };
    if sender
        .try_send((hyper::upgrade::on(&mut request), hash))
        .is_err()
    {
        return plain(StatusCode::SERVICE_UNAVAILABLE, "Service Unavailable");
    }
    response
}

fn credential_hash(request: &Request<Incoming>) -> Option<String> {
    let mut headers = request.headers().get_all(AUTHORIZATION).iter();
    let value = headers.next()?;
    if headers.next().is_some() {
        return None;
    }
    let token = std::str::from_utf8(value.as_bytes())
        .ok()?
        .strip_prefix("Bearer ")?;
    if token.is_empty() || token.chars().any(char::is_whitespace) || token.contains('\u{feff}') {
        return None;
    }
    Some(hex::encode(Sha256::digest(token.as_bytes())))
}

fn plain_http(request: &Request<Incoming>, host: &Host) -> Response<Body> {
    if request.method() != Method::GET {
        return plain(StatusCode::METHOD_NOT_ALLOWED, "Method Not Allowed");
    }
    match request.uri().path() {
        "/healthz" => plain(StatusCode::OK, "ok"),
        "/readyz" if host.stop.is_cancelled() => {
            plain(StatusCode::SERVICE_UNAVAILABLE, "not ready")
        }
        "/readyz" => plain(StatusCode::OK, "ready"),
        _ => plain(StatusCode::NOT_FOUND, "Not Found"),
    }
}

fn plain(status: StatusCode, body: &'static str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(CACHE_CONTROL, "no-store")
        .header(CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(hyper::header::CONNECTION, "close")
        .body(Full::new(Bytes::from_static(body.as_bytes())))
        .expect("static HTTP response headers are valid")
}
