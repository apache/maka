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

//! Bounded outgoing WebSocket messages with cancellation-safe connection retirement.
use super::websocket_failure;
use futures_util::{SinkExt, StreamExt, future::BoxFuture};
use maka_agent_facts::model::error::{ProviderFailure, ProviderFailureReason};
use maka_agent_ports::model::{Error, Frame, Socket, TextStream};
use maka_capabilities::http::Bytes;
use tokio::sync::{Mutex, MutexGuard};
use tokio_tungstenite::tungstenite::{
    Error as WireError, Message as Wire,
    protocol::frame::{
        Frame as Fragment,
        coding::{Data, OpCode},
    },
};
use tokio_util::sync::CancellationToken;

const FRAGMENT: usize = 16 * 1024;
type Writer = futures_util::stream::SplitSink<maka_network::Socket, Wire>;
type Reader = futures_util::stream::SplitStream<maka_network::Socket>;
struct Read {
    socket: Reader,
    // A send may service control frames while the producer waits. If the peer
    // sends application data early, retain one message for the normal reader.
    pending: Option<Result<Option<Wire>, WireError>>,
}
pub(super) struct Connection {
    messages: Mutex<()>,
    write: Mutex<Option<Writer>>,
    read: Mutex<Option<Read>>,
    cancelled: CancellationToken,
}
impl Connection {
    pub(super) fn new(socket: maka_network::Socket) -> Self {
        let (write, read) = socket.split();
        Self {
            messages: Mutex::new(()),
            write: Mutex::new(Some(write)),
            read: Mutex::new(Some(Read {
                socket: read,
                pending: None,
            })),
            cancelled: CancellationToken::new(),
        }
    }
    fn retire(&self) {
        self.cancelled.cancel();
        // SendLease is dropped after its per-fragment I/O guards. A concurrent
        // reader observes cancellation and drops its own half before returning.
        if let Ok(mut write) = self.write.try_lock() {
            write.take();
        }
        if let Ok(mut read) = self.read.try_lock() {
            read.take();
        }
    }
    async fn write(&self, frame: Wire) -> Result<(), Error> {
        let mut state = StateLease::new(self.write.lock().await, &self.cancelled);
        let Some(write) = state.as_mut() else {
            return Err(Error::Cancelled);
        };
        let result = tokio::select! {
            biased;
            _ = self.cancelled.cancelled() => Err(Error::Cancelled),
            result = write.send(frame) => result.map_err(|cause| websocket_failure("send", cause)),
        };
        if result.is_err() {
            state.take();
        }
        result
    }
    async fn flush_control(&self) -> Result<(), Error> {
        let mut state = StateLease::new(self.write.lock().await, &self.cancelled);
        let Some(write) = state.as_mut() else {
            return Err(Error::Cancelled);
        };
        let result = tokio::select! {
            biased;
            _ = self.cancelled.cancelled() => Err(Error::Cancelled),
            result = write.flush() => result.map_err(|cause| websocket_failure("pong", cause)),
        };
        if result.is_err() {
            state.take();
        }
        result
    }
    async fn next_text(&self, chunks: &mut TextStream) -> Result<Option<Bytes>, Error> {
        loop {
            // Service ping/pong even when Responses has not started reading its
            // reply yet. Never steal an application message from that reader.
            if let Ok(mut state) = self
                .read
                .try_lock()
                .map(|state| StateLease::new(state, &self.cancelled))
                && let Some(read) = state.as_mut()
                && read.pending.is_none()
            {
                let incoming = tokio::select! {
                    biased;
                    _ = self.cancelled.cancelled() => { state.take(); return Err(Error::Cancelled); },
                    incoming = read.socket.next() => incoming,
                    chunk = chunks.next() => return chunk.transpose(),
                };
                match incoming {
                    Some(Ok(Wire::Ping(_))) => {
                        drop(state);
                        self.flush_control().await?;
                        continue;
                    }
                    Some(Ok(Wire::Pong(_))) => continue,
                    Some(Err(error)) => return Err(websocket_failure("send", error)),
                    None | Some(Ok(Wire::Close(_))) => {
                        return Err(Error::Provider(ProviderFailure::new(
                            ProviderFailureReason::Network,
                            "model WebSocket closed during text upload",
                            false,
                            None,
                        )));
                    }
                    incoming => read.pending = Some(incoming.transpose()),
                }
            }
            return tokio::select! {
                biased;
                _ = self.cancelled.cancelled() => Err(Error::Cancelled),
                chunk = chunks.next() => chunk.transpose(),
            };
        }
    }
}
/// When retirement races an active reader/control writer, its final guard
/// releases the buffered half before that operation's future can complete.
struct StateLease<'a, T> {
    state: MutexGuard<'a, Option<T>>,
    cancelled: &'a CancellationToken,
}
impl<'a, T> StateLease<'a, T> {
    fn new(state: MutexGuard<'a, Option<T>>, cancelled: &'a CancellationToken) -> Self {
        Self { state, cancelled }
    }
}
impl<T> std::ops::Deref for StateLease<'_, T> {
    type Target = Option<T>;
    fn deref(&self) -> &Self::Target {
        &self.state
    }
}
impl<T> std::ops::DerefMut for StateLease<'_, T> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.state
    }
}
impl<T> Drop for StateLease<'_, T> {
    fn drop(&mut self) {
        if self.cancelled.is_cancelled() {
            self.state.take();
        }
    }
}
/// A cancelled or failed partial message makes the entire connection unusable.
/// No detached producer task or serialized input survives this lease.
struct SendLease<'a> {
    socket: &'a Connection,
    complete: bool,
}
impl Drop for SendLease<'_> {
    fn drop(&mut self) {
        if !self.complete {
            self.socket.retire();
        }
    }
}
impl Socket for Connection {
    fn send(&self, frame: Frame) -> BoxFuture<'_, Result<(), Error>> {
        match frame {
            Frame::Text(text) => self.send_text(Box::pin(futures_util::stream::once(async move {
                Ok(Bytes::from(text))
            }))),
            Frame::Binary(bytes) => Box::pin(async move {
                let _order = tokio::select! {
                    biased;
                    _ = self.cancelled.cancelled() => return Err(Error::Cancelled),
                    order = self.messages.lock() => order,
                };
                let mut lease = SendLease {
                    socket: self,
                    complete: false,
                };
                let bytes = Bytes::from(bytes);
                let mut offset = 0;
                while offset < bytes.len() {
                    let end = (offset + FRAGMENT).min(bytes.len());
                    let kind = if offset == 0 {
                        Data::Binary
                    } else {
                        Data::Continue
                    };
                    self.write(Wire::Frame(Fragment::message(
                        bytes.slice(offset..end),
                        OpCode::Data(kind),
                        false,
                    )))
                    .await?;
                    offset = end;
                }
                let kind = if bytes.is_empty() {
                    Data::Binary
                } else {
                    Data::Continue
                };
                self.write(Wire::Frame(Fragment::message(
                    Bytes::new(),
                    OpCode::Data(kind),
                    true,
                )))
                .await?;
                lease.complete = true;
                Ok(())
            }),
        }
    }
    fn send_text(&self, chunks: TextStream) -> BoxFuture<'_, Result<(), Error>> {
        Box::pin(async move {
            let _order = tokio::select! {
                biased;
                _ = self.cancelled.cancelled() => return Err(Error::Cancelled),
                order = self.messages.lock() => order,
            };
            let mut lease = SendLease {
                socket: self,
                complete: false,
            };
            let mut chunks = chunks;
            let mut first = true;
            while let Some(bytes) = self.next_text(&mut chunks).await? {
                let mut offset = 0;
                while offset < bytes.len() {
                    let end = (offset + FRAGMENT).min(bytes.len());
                    let kind = if first { Data::Text } else { Data::Continue };
                    self.write(Wire::Frame(Fragment::message(
                        bytes.slice(offset..end),
                        OpCode::Data(kind),
                        false,
                    )))
                    .await?;
                    first = false;
                    offset = end;
                }
            }
            // An empty final continuation avoids lookahead or retaining the
            // preceding chunk while waiting for a slow source's next item.
            let kind = if first { Data::Text } else { Data::Continue };
            self.write(Wire::Frame(Fragment::message(
                Bytes::new(),
                OpCode::Data(kind),
                true,
            )))
            .await?;
            lease.complete = true;
            Ok(())
        })
    }
    fn receive(&self) -> BoxFuture<'_, Result<Option<Frame>, Error>> {
        Box::pin(async move {
            let mut state = StateLease::new(self.read.lock().await, &self.cancelled);
            if self.cancelled.is_cancelled() {
                return Err(Error::Cancelled);
            }
            loop {
                let Some(read) = state.as_mut() else {
                    return Ok(None);
                };
                let incoming = if let Some(incoming) = read.pending.take() {
                    incoming
                } else {
                    tokio::select! {
                        biased;
                        _ = self.cancelled.cancelled() => { state.take(); return Err(Error::Cancelled); },
                        incoming = read.socket.next() => incoming.transpose(),
                    }
                };
                match incoming {
                    Ok(Some(Wire::Text(text))) => return Ok(Some(Frame::Text(text.to_string()))),
                    Ok(Some(Wire::Binary(bytes))) => {
                        return Ok(Some(Frame::Binary(bytes.to_vec())));
                    }
                    Ok(Some(Wire::Ping(_))) => self.flush_control().await?,
                    Ok(Some(Wire::Pong(_))) => {}
                    Ok(Some(Wire::Close(close))) => {
                        let interrupted = close.as_ref().is_none_or(|close| {
                            matches!(u16::from(close.code), 1000 | 1001 | 1009 | 1011..=1014)
                        });
                        let detail = close.map_or_else(
                            || "without a close status".into(),
                            |close| {
                                format!("with code {}: {}", u16::from(close.code), close.reason)
                            },
                        );
                        let message = format!("model WebSocket closed {detail}");
                        if !interrupted {
                            return Err(Error::Adapter(message));
                        }
                        return Err(Error::Provider(ProviderFailure::new(
                            ProviderFailureReason::StreamTruncated,
                            message,
                            false,
                            None,
                        )));
                    }
                    Ok(None) => return Ok(None),
                    Err(cause) => return Err(websocket_failure("receive", cause)),
                    Ok(Some(_)) => {
                        return Err(Error::Adapter(
                            "model WebSocket returned an unsupported frame".into(),
                        ));
                    }
                }
            }
        })
    }
    fn close(&self) -> BoxFuture<'_, Result<(), Error>> {
        self.retire();
        Box::pin(async move {
            // Active source ownership lasts for the entire data-message lease,
            // including waits between fragments. Settlement waits for it too.
            let _messages = self.messages.lock().await;
            self.write.lock().await.take();
            self.read.lock().await.take();
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests;
