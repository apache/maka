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

//! Host-authorized HTTP. Redirect and retry policy belongs to the plugin;
//! proxy configuration, bounded I/O and resource settlement belong to Host.

pub mod upload;

use crate::call::Scope;
pub use bytes::Bytes;
use futures_util::{Stream, StreamExt, future::BoxFuture, stream::BoxStream};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Method {
    Get,
    Head,
    Post,
    Put,
    Patch,
    Delete,
    Options,
}

/// A single-use, pull-driven upload. Retrying opens a fresh source; the transport
/// never buffers a complete body to make it replayable. Dropping the stream must
/// release its resources, so producers must not detach work from this owner.
pub struct RequestBody {
    stream: BoxStream<'static, Result<Bytes, Error>>,
    length: Option<u64>,
    replay: Option<ReplaySource>,
}
/// Reopens the same immutable source without retaining an encoded body buffer.
#[derive(Clone)]
pub struct ReplaySource(Arc<dyn Fn() -> RequestBody + Send + Sync>);
impl ReplaySource {
    pub fn open(&self) -> RequestBody {
        let mut body = (self.0)();
        body.replay = Some(self.clone());
        body
    }
}
impl RequestBody {
    pub fn replayable(factory: impl Fn() -> RequestBody + Send + Sync + 'static) -> Self {
        ReplaySource(Arc::new(factory)).open()
    }
    pub fn replay_source(&self) -> Option<ReplaySource> {
        self.replay.clone()
    }
    pub fn replay(&self) -> Option<Self> {
        self.replay.as_ref().map(ReplaySource::open)
    }

    pub fn stream(stream: impl Stream<Item = Result<Bytes, Error>> + Send + 'static) -> Self {
        Self {
            stream: stream.boxed(),
            length: None,
            replay: None,
        }
    }
    /// Declare an exact length without reading the source. The caller guarantees
    /// this length (including an empty source for zero). The transport rejects
    /// observed short or oversized streams without buffering the body.
    pub fn with_length(
        stream: impl Stream<Item = Result<Bytes, Error>> + Send + 'static,
        length: u64,
    ) -> Self {
        Self {
            stream: stream.boxed(),
            length: Some(length),
            replay: None,
        }
    }
    pub fn length(&self) -> Option<u64> {
        self.length
    }
    pub fn into_stream(self) -> BoxStream<'static, Result<Bytes, Error>> {
        self.stream
    }
}
impl Default for RequestBody {
    fn default() -> Self {
        Self::replayable(|| Self::with_length(futures_util::stream::empty(), 0))
    }
}
impl From<Vec<u8>> for RequestBody {
    fn from(bytes: Vec<u8>) -> Self {
        let bytes = Bytes::from(bytes);
        let length = bytes.len() as u64;
        Self::replayable(move || {
            let bytes = bytes.clone();
            Self::with_length(futures_util::stream::once(async move { Ok(bytes) }), length)
        })
    }
}

pub struct Request {
    pub url: String,
    pub method: Method,
    pub headers: Vec<(String, String)>,
    pub body: RequestBody,
}

/// Explicit buffered external DTO boundary, separate from native uploads.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BufferedRequest {
    pub url: String,
    pub method: Method,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: Vec<u8>,
}
impl From<BufferedRequest> for Request {
    fn from(input: BufferedRequest) -> Self {
        Self {
            url: input.url,
            method: input.method,
            headers: input.headers,
            body: input.body.into(),
        }
    }
}

#[derive(Serialize)]
pub struct Head {
    pub status: u16,
    pub url: String,
    /// Preserve duplicate headers and non-UTF-8 values.
    pub headers: Vec<(String, Vec<u8>)>,
}

pub struct Response {
    pub head: Head,
    pub body: Arc<dyn Body>,
}

pub trait Client: Send + Sync {
    fn request(&self, call: Scope, input: Request) -> BoxFuture<'_, Result<Response, Error>>;
}
pub trait Body: Send + Sync {
    /// One outstanding read; successful EOF confirms completion.
    fn next(&self) -> BoxFuture<'_, Result<Option<Vec<u8>>, Error>>;
    /// Signal before awaiting cleanup. Dropping the last body also cancels I/O.
    fn cancel(&self);
    fn close(&self) -> BoxFuture<'_, Result<(), Error>>;
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("HTTP call authority is retired or denied")]
    Denied,
    #[error("invalid HTTP request: {0}")]
    Invalid(String),
    #[error("HTTP operation failed; remote side effects may already have occurred: {0}")]
    Failed(String),
    #[error("HTTP resource cleanup is unconfirmed")]
    CleanupUnconfirmed,
}
