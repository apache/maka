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

use maka_plugins::process::{Handle, Id, Stream};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const MAX_LINE: usize = 1024 * 1024;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug)]
pub enum Frame {
    Stderr {
        bytes: Vec<u8>,
    },
    Response {
        id: u64,
        result: Result<Value, RpcError>,
    },
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("external process operation failed")]
    Process(#[from] maka_plugins::process::Error),
    #[error("external process output ended")]
    Eof,
    #[error("external process output ended within a JSON-RPC frame")]
    Truncated,
    #[error("external JSON-RPC frame exceeds the transport limit")]
    Limit,
    #[error("invalid external JSON-RPC frame")]
    Invalid,
    #[error("cannot rebind a different external process")]
    DifferentProcess,
    #[error("external JSON-RPC request identifiers exhausted")]
    IdExhausted,
}

/// Newline-delimited JSON-RPC over a Host-owned process. The caller owns deadlines,
/// request correlation, and process cleanup. Requests may receive callbacks before
/// their response. Rebinding refreshes authority without losing buffered output.
pub struct Connection {
    handle: Handle,
    next_id: u64,
    line: Vec<u8>,
    chunk: Vec<u8>,
    offset: usize,
    observe_stderr: bool,
}

impl Connection {
    pub fn new(handle: Handle) -> Self {
        Self {
            handle,
            next_id: 1,
            line: Vec::new(),
            chunk: Vec::new(),
            offset: 0,
            observe_stderr: false,
        }
    }

    pub fn observe_stderr(mut self) -> Self {
        self.observe_stderr = true;
        self
    }

    pub fn id(&self) -> Id {
        self.handle.id.clone()
    }

    pub fn rebind(&mut self, handle: Handle) -> Result<(), Error> {
        if handle.id != self.handle.id {
            return Err(Error::DifferentProcess);
        }
        self.handle = handle;
        Ok(())
    }

    pub async fn request(&mut self, method: &str, params: &impl Serialize) -> Result<u64, Error> {
        let id = self.next_id;
        self.next_id = id.checked_add(1).ok_or(Error::IdExhausted)?;
        self.send(json!({"jsonrpc": "2.0", "id": id, "method": method,
            "params": serde_json::to_value(params).map_err(|_| Error::Invalid)?}))
            .await?;
        Ok(id)
    }

    pub async fn notify(&mut self, method: &str, params: &impl Serialize) -> Result<(), Error> {
        self.send(json!({"jsonrpc": "2.0", "method": method,
            "params": serde_json::to_value(params).map_err(|_| Error::Invalid)?}))
            .await
    }

    pub async fn respond(
        &mut self,
        id: Value,
        result: Result<Value, RpcError>,
    ) -> Result<(), Error> {
        if !valid_id(&id) {
            return Err(Error::Invalid);
        }
        let value = match result {
            Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
            Err(error) => json!({"jsonrpc": "2.0", "id": id, "error": error}),
        };
        self.send(value).await
    }

    async fn send(&self, value: Value) -> Result<(), Error> {
        if value.get("method").is_some()
            && (!value["method"].is_string() || !structured(&value["params"]))
        {
            return Err(Error::Invalid);
        }
        let mut bytes = serde_json::to_vec(&value).map_err(|_| Error::Invalid)?;
        if bytes.len() > MAX_LINE {
            return Err(Error::Limit);
        }
        bytes.push(b'\n');
        // Managed process writes are bounded independently of protocol frames.
        // This connection serializes writers, so splitting cannot interleave JSON.
        for chunk in bytes.chunks(64 * 1024) {
            self.handle.io.write(chunk.to_vec()).await?;
        }
        Ok(())
    }

    /// Cancellation safe provided the managed Process::next implementation is:
    /// received bytes are retained before any subsequent suspension point.
    pub async fn next(&mut self) -> Result<Frame, Error> {
        loop {
            if self.offset < self.chunk.len() {
                let remaining = &self.chunk[self.offset..];
                let newline = remaining.iter().position(|byte| *byte == b'\n');
                let len = newline.unwrap_or(remaining.len());
                if self.line.len().saturating_add(len) > MAX_LINE {
                    return Err(Error::Limit);
                }
                self.line.extend_from_slice(&remaining[..len]);
                self.offset += len + usize::from(newline.is_some());
                if newline.is_some() {
                    let frame = decode(&self.line);
                    self.line.clear();
                    return frame;
                }
            }
            self.chunk.clear();
            self.offset = 0;
            let Some(chunk) = self.handle.io.next().await? else {
                return Err(if self.line.is_empty() {
                    Error::Eof
                } else {
                    Error::Truncated
                });
            };
            // Managed process chunks are bounded; independently reject oversized
            // chunks to keep this layer bounded even with an alternate provider.
            if chunk.bytes.len() > MAX_LINE {
                return Err(Error::Limit);
            }
            if matches!(chunk.stream, Stream::Stdout) {
                self.chunk = chunk.bytes;
            } else if self.observe_stderr {
                return Ok(Frame::Stderr { bytes: chunk.bytes });
            }
            // Execution discards diagnostics. Setup may extract a bounded login URL.
        }
    }
}

fn structured(value: &Value) -> bool {
    value.is_object() || value.is_array()
}
fn valid_id(value: &Value) -> bool {
    value.is_null() || value.is_string() || value.is_i64() || value.is_u64()
}

fn decode(bytes: &[u8]) -> Result<Frame, Error> {
    struct Envelope;
    impl<'de> serde::de::Visitor<'de> for Envelope {
        type Value = serde_json::Map<String, Value>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a JSON-RPC object")
        }
        fn visit_map<M: serde::de::MapAccess<'de>>(
            self,
            mut map: M,
        ) -> Result<Self::Value, M::Error> {
            let mut row = serde_json::Map::new();
            while let Some((key, value)) = map.next_entry::<String, Value>()? {
                if row.insert(key, value).is_some() {
                    return Err(serde::de::Error::custom("duplicate JSON-RPC field"));
                }
            }
            Ok(row)
        }
    }
    let mut decoder = serde_json::Deserializer::from_slice(bytes);
    let row =
        serde::Deserializer::deserialize_map(&mut decoder, Envelope).map_err(|_| Error::Invalid)?;
    decoder.end().map_err(|_| Error::Invalid)?;
    if row.get("jsonrpc") != Some(&json!("2.0")) {
        return Err(Error::Invalid);
    }
    if let Some(method) = row.get("method") {
        if row
            .keys()
            .any(|key| !["jsonrpc", "id", "method", "params"].contains(&key.as_str()))
        {
            return Err(Error::Invalid);
        }
        let method = method.as_str().ok_or(Error::Invalid)?.to_owned();
        let params = row.get("params").cloned().unwrap_or_else(|| json!({}));
        if !structured(&params) {
            return Err(Error::Invalid);
        }
        return match row.get("id") {
            Some(id) if valid_id(id) => Ok(Frame::Request {
                id: id.clone(),
                method,
                params,
            }),
            Some(_) => Err(Error::Invalid),
            None => Ok(Frame::Notification { method, params }),
        };
    }
    if row
        .keys()
        .any(|key| !["jsonrpc", "id", "result", "error"].contains(&key.as_str()))
    {
        return Err(Error::Invalid);
    }
    let id = row
        .get("id")
        .and_then(Value::as_u64)
        .ok_or(Error::Invalid)?;
    let result = match (row.get("result"), row.get("error")) {
        (Some(result), None) => Ok(result.clone()),
        (None, Some(error)) => {
            Err(serde_json::from_value(error.clone()).map_err(|_| Error::Invalid)?)
        }
        _ => return Err(Error::Invalid),
    };
    Ok(Frame::Response { id, result })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelopes_require_one_terminal_field_and_preserve_null_results() {
        assert!(matches!(
            decode(br#"{"jsonrpc":"2.0","id":1,"result":null}"#),
            Ok(Frame::Response {
                id: 1,
                result: Ok(Value::Null)
            })
        ));
        for invalid in [
            br#"{"jsonrpc":"2.0","id":1,"result":null,"error":{"code":1,"message":"x"}}"#
                .as_slice(),
            br#"{"jsonrpc":"2.0","method":"x","params":null}"#,
            br#"{"jsonrpc":"1.0","id":1,"result":true}"#,
            br#"{"jsonrpc":"2.0","id":1}"#,
            br#"{"jsonrpc":"2.0","id":1,"id":2,"result":true}"#,
        ] {
            assert!(matches!(decode(invalid), Err(Error::Invalid)));
        }
    }

    #[test]
    fn cancelled_read_rebind_and_eof_preserve_partial_output() {
        use maka_plugins::process::{Chunk, Exit, Process};
        use std::{
            collections::VecDeque,
            future::Future,
            pin::Pin,
            sync::{Arc, Mutex},
            task::{Context, Poll, Waker},
        };
        type Reply<'a, T> =
            Pin<Box<dyn Future<Output = Result<T, maka_plugins::process::Error>> + Send + 'a>>;
        struct Fake(Mutex<VecDeque<Option<Chunk>>>);
        impl Process for Fake {
            fn write(&self, _: Vec<u8>) -> Reply<'_, ()> {
                Box::pin(async { Ok(()) })
            }
            fn end_input(&self) -> Reply<'_, ()> {
                Box::pin(async { Ok(()) })
            }
            fn close(&self) -> Reply<'_, ()> {
                Box::pin(async { Ok(()) })
            }
            fn wait(&self) -> Reply<'_, Exit> {
                Box::pin(std::future::pending())
            }
            fn next(&self) -> Reply<'_, Option<Chunk>> {
                Box::pin(std::future::poll_fn(|_| {
                    match self.0.lock().unwrap().pop_front() {
                        Some(chunk) => Poll::Ready(Ok(chunk)),
                        None => Poll::Pending,
                    }
                }))
            }
        }
        let mut cx = Context::from_waker(Waker::noop());
        let chunk = |bytes: &[u8]| {
            Some(Chunk {
                stream: Stream::Stdout,
                bytes: bytes.to_vec(),
            })
        };
        let io = Arc::new(Fake(Mutex::new(VecDeque::from([chunk(
            br#"{"jsonrpc":"2.0","id":1,"res"#,
        )]))));
        let handle = || Handle {
            id: Id("retained".into()),
            io: io.clone(),
        };
        let mut connection = Connection::new(handle());
        // Drop a pending read after its first chunk was consumed.
        assert!(
            Box::pin(connection.next())
                .as_mut()
                .poll(&mut cx)
                .is_pending()
        );
        connection.rebind(handle()).unwrap();
        io.0.lock().unwrap().extend([
            Some(Chunk {
                stream: Stream::Stderr,
                bytes: b"private diagnostic".to_vec(),
            }),
            chunk(b"ult\":null}\n{\"jsonrpc\":"),
            None,
        ]);
        assert!(matches!(
            Box::pin(connection.next()).as_mut().poll(&mut cx),
            Poll::Ready(Ok(Frame::Response {
                id: 1,
                result: Ok(Value::Null)
            }))
        ));
        assert!(matches!(
            Box::pin(connection.next()).as_mut().poll(&mut cx),
            Poll::Ready(Err(Error::Truncated))
        ));
    }
}
