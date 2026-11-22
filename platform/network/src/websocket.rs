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

use crate::Error;
use reqwest::{
    StatusCode, Version,
    header::{self, HeaderMap, HeaderValue},
};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{
        handshake::{client::generate_key, derive_accept_key},
        protocol::{Role, WebSocketConfig},
    },
};

pub type Socket = WebSocketStream<reqwest::Upgraded>;

/// HTTP upgrade uses the same proxy/auth/TLS routing as ordinary requests.
/// Cancellation drops the handshake future; no response.create is sent here.
pub async fn connect_websocket(
    policy: &crate::Policy,
    client: reqwest::ClientBuilder,
    url: &str,
    mut headers: HeaderMap,
    limit: usize,
) -> Result<Socket, Error> {
    let key = generate_key();
    headers.remove(header::CONTENT_LENGTH);
    headers.remove(header::HOST);
    headers.remove(header::SEC_WEBSOCKET_EXTENSIONS);
    headers.remove(header::SEC_WEBSOCKET_PROTOCOL);
    headers
        .try_insert(header::CONNECTION, HeaderValue::from_static("Upgrade"))
        .map_err(|_| Error::InvalidHeaders)?;
    headers
        .try_insert(header::UPGRADE, HeaderValue::from_static("websocket"))
        .map_err(|_| Error::InvalidHeaders)?;
    headers
        .try_insert(
            header::SEC_WEBSOCKET_VERSION,
            HeaderValue::from_static("13"),
        )
        .map_err(|_| Error::InvalidHeaders)?;
    headers
        .try_insert(
            header::SEC_WEBSOCKET_KEY,
            HeaderValue::from_str(&key).map_err(|_| Error::InvalidHeaders)?,
        )
        .map_err(|_| Error::InvalidHeaders)?;
    let target = reqwest::Url::parse(url).map_err(|_| Error::InvalidHeaders)?;
    policy.check_request_headers(&target, &headers, false, false)?;
    let response = client
        .redirect(reqwest::redirect::Policy::none())
        .http1_only()
        .build()?
        .get(url)
        .version(Version::HTTP_11)
        .headers(headers)
        .send()
        .await?;
    let headers = response.headers();
    let accept = derive_accept_key(key.as_bytes());
    if response.status() != StatusCode::SWITCHING_PROTOCOLS
        || headers.get_all(header::SEC_WEBSOCKET_ACCEPT).iter().count() != 1
        || headers
            .get(header::SEC_WEBSOCKET_ACCEPT)
            .is_none_or(|value| value.as_bytes() != accept.as_bytes())
        || !has_token(headers, header::CONNECTION, "upgrade")
        || !has_token(headers, header::UPGRADE, "websocket")
        || headers.contains_key(header::SEC_WEBSOCKET_EXTENSIONS)
        || headers.contains_key(header::SEC_WEBSOCKET_PROTOCOL)
    {
        return Err(Error::InvalidUpgrade);
    }
    Ok(WebSocketStream::from_raw_socket(
        response.upgrade().await?,
        Role::Client,
        Some(
            WebSocketConfig::default()
                .write_buffer_size(0)
                .max_write_buffer_size(64 * 1024)
                .max_message_size(Some(limit))
                .max_frame_size(Some(limit)),
        ),
    )
    .await)
}

fn has_token(headers: &HeaderMap, name: header::HeaderName, expected: &str) -> bool {
    headers
        .get_all(name)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|value| value.trim().eq_ignore_ascii_case(expected))
}
