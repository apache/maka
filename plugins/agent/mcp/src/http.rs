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

//! Bounded HTTP body ingress. rmcp owns protocol/session handling; its reqwest
//! POST adapter buffers ordinary JSON/error bodies without a byte limit.
use futures_util::{StreamExt, stream::BoxStream};
use reqwest::{
    StatusCode,
    header::{HeaderName, HeaderValue},
};
use rmcp::{
    model::{ClientJsonRpcMessage, ClientRequest, ErrorData, ServerJsonRpcMessage},
    transport::streamable_http_client::{
        StreamableHttpClient, StreamableHttpError, StreamableHttpPostResponse,
    },
};
use rmcp_sse::{Error as SseError, Sse};
use sse_stream::SseStream;
use std::{collections::HashMap, sync::Arc};

#[derive(Clone)]
pub(crate) struct Client(pub reqwest::Client);
type Error = StreamableHttpError<reqwest::Error>;
type Headers = HashMap<HeaderName, HeaderValue>;
fn limit_error() -> Error {
    Error::UnexpectedServerResponse("MCP HTTP response exceeds the byte limit".into())
}
async fn body(mut response: reqwest::Response) -> Result<Vec<u8>, Error> {
    if response
        .content_length()
        .is_some_and(|len| len > super::MAX_MESSAGE as u64)
    {
        return Err(limit_error());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if chunk.len() > super::MAX_MESSAGE - bytes.len() {
            return Err(limit_error());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

// Bound raw bytes between SSE event separators before the parser buffers them.
// CRLF is one line ending even when split between network chunks. Comments
// count towards the event budget too; no unbounded comment/unknown-field event.
fn sse(response: reqwest::Response, limit: usize) -> BoxStream<'static, Result<Sse, SseError>> {
    let stream = futures_util::stream::unfold(
        (response.bytes_stream().boxed(), 0usize, false, false, false),
        move |(mut source, mut size, mut line_has_bytes, mut cr, failed)| async move {
            if failed {
                return None;
            }
            let next = source.next().await?;
            let chunk = match next {
                Ok(chunk) => chunk,
                Err(error) => {
                    return Some((
                        Err(std::io::Error::other(error)),
                        (source, size, line_has_bytes, cr, true),
                    ));
                }
            };
            for &byte in &chunk {
                if cr && byte == b'\n' {
                    cr = false;
                    continue;
                }
                cr = byte == b'\r';
                if matches!(byte, b'\r' | b'\n') {
                    if !line_has_bytes {
                        size = 0;
                    }
                    line_has_bytes = false;
                } else {
                    line_has_bytes = true;
                }
                size = size.saturating_add(1);
                if size > limit {
                    return Some((
                        Err(std::io::Error::other(
                            "MCP SSE event exceeds the byte limit",
                        )),
                        (source, size, line_has_bytes, cr, true),
                    ));
                }
            }
            Some((Ok(chunk), (source, size, line_has_bytes, cr, false)))
        },
    );
    SseStream::from_bytes_stream(stream)
        .map(|event| {
            event
                .map(|event| Sse {
                    event: event.event,
                    data: event.data,
                    id: event.id,
                    retry: event.retry,
                })
                .map_err(|error| match error {
                    sse_stream::Error::Body(source) => SseError::Body(source),
                    sse_stream::Error::Utf8Parse(source) => SseError::Utf8Parse(source),
                    error => SseError::Body(Box::new(error)),
                })
        })
        .boxed()
}

impl StreamableHttpClient for Client {
    type Error = reqwest::Error;
    async fn get_stream(
        &self,
        uri: Arc<str>,
        session: Option<Arc<str>>,
        last: Option<String>,
        auth: Option<String>,
        headers: Headers,
    ) -> Result<BoxStream<'static, Result<Sse, SseError>>, Error> {
        self.get_stream_with_max_sse_event_size(
            uri,
            session,
            last,
            auth,
            headers,
            super::MAX_MESSAGE,
        )
        .await
    }
    async fn get_stream_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        session: Option<Arc<str>>,
        last: Option<String>,
        auth: Option<String>,
        headers: Headers,
        limit: usize,
    ) -> Result<BoxStream<'static, Result<Sse, SseError>>, Error> {
        self.0
            .get_stream_with_max_sse_event_size(
                uri,
                session,
                last,
                auth,
                headers,
                limit.min(super::MAX_MESSAGE),
            )
            .await
    }
    async fn delete_session(
        &self,
        uri: Arc<str>,
        session: Arc<str>,
        auth: Option<String>,
        headers: Headers,
    ) -> Result<(), Error> {
        self.0.delete_session(uri, session, auth, headers).await
    }
    async fn post_message(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session: Option<Arc<str>>,
        auth: Option<String>,
        headers: Headers,
    ) -> Result<StreamableHttpPostResponse, Error> {
        self.post_message_with_max_sse_event_size(
            uri,
            message,
            session,
            auth,
            headers,
            super::MAX_MESSAGE,
        )
        .await
    }
    async fn post_message_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session: Option<Arc<str>>,
        auth: Option<String>,
        headers: Headers,
        limit: usize,
    ) -> Result<StreamableHttpPostResponse, Error> {
        let mut request = self
            .0
            .post(uri.as_ref())
            .header("accept", "application/json, text/event-stream");
        if let Some(auth) = auth {
            request = request.bearer_auth(auth);
        }
        // Configuration headers are validated at admission. Protocol-version
        // and parameter headers may also be supplied by the SDK itself.
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let attached = session.is_some();
        if let Some(session) = session {
            request = request.header("mcp-session-id", session.as_ref());
        }
        let response = request.json(&message).send().await?;
        let status = response.status();
        if matches!(status, StatusCode::ACCEPTED | StatusCode::NO_CONTENT) {
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        if status == StatusCode::NOT_FOUND && attached {
            return Err(Error::SessionExpired);
        }
        let ct = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let session = response
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let is_request = matches!(message, ClientJsonRpcMessage::Request(_));
        if status.is_success() && response.content_length() == Some(0) && !is_request {
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        if status.is_success()
            && ct
                .as_deref()
                .is_some_and(|v| v.starts_with("text/event-stream"))
        {
            return Ok(StreamableHttpPostResponse::Sse(
                sse(response, limit.min(super::MAX_MESSAGE)),
                session,
            ));
        }
        let bytes = body(response).await?;
        let parsed = serde_json::from_slice::<ServerJsonRpcMessage>(&bytes);
        if !status.is_success() {
            let auth_failure = matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN);
            // Preserve rmcp's legacy discovery fallback without reflecting
            // arbitrary server response text (which can contain credentials).
            if !attached
                && status.is_client_error()
                && !auth_failure
                && let ClientJsonRpcMessage::Request(request) = &message
                && matches!(request.request, ClientRequest::DiscoverRequest(_))
            {
                let error = match parsed {
                    Ok(ServerJsonRpcMessage::Error(error)) => error.error,
                    _ => ErrorData::invalid_request(
                        format!("server/discover rejected with HTTP {status}"),
                        None,
                    ),
                };
                return Ok(StreamableHttpPostResponse::Json(
                    ServerJsonRpcMessage::error(error, Some(request.id.clone())),
                    None,
                ));
            }
            if !auth_failure
                && ct
                    .as_deref()
                    .is_some_and(|v| v.starts_with("application/json"))
                && let Ok(message @ ServerJsonRpcMessage::Error(_)) = parsed
            {
                return Ok(StreamableHttpPostResponse::Json(message, session));
            }
            return Err(Error::UnexpectedServerResponse(
                format!("HTTP {status}").into(),
            ));
        }
        if !ct
            .as_deref()
            .is_some_and(|v| v.starts_with("application/json"))
        {
            return Err(Error::UnexpectedContentType(ct));
        }
        match parsed {
            Ok(message) => Ok(StreamableHttpPostResponse::Json(message, session)),
            Err(_) if !is_request => Ok(StreamableHttpPostResponse::Accepted),
            Err(_) => Err(Error::UnexpectedServerResponse(
                "invalid JSON-RPC response".into(),
            )),
        }
    }
}
