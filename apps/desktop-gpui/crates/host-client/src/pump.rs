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

//! The connection pump: one future that reads Host frames and writes client
//! frames until either side ends.
//!
//! The pump owns the transport. [`crate::Connection`] handles only enqueue
//! encoded frames and wait on the [`RequestTable`], so reading never waits on
//! a caller and callers never touch the socket. This mirrors the independent
//! read loop in `RuntimeHostConnectionImpl#readResponses`
//! (`packages/runtime-host/src/client/connection.ts`).
//!
//! The transport is a [`MessageSource`] and a [`MessageSink`]: one protocol
//! message each way at a time. The local socket and pipe split a byte stream
//! on newlines ([`FrameReader`], [`StreamSink`]); a WebSocket carries one
//! message per text frame (`crate::websocket`), as `RuntimeHostMessageTransport`
//! abstracts both in `packages/runtime-host/src/transport/message-transport.ts`.

use std::collections::VecDeque;
use std::fmt;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use async_channel::TrySendError;
use futures_lite::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, future};
use host_protocol::{
    FrameDecodeError, FrameDecoder, FrameError, HostFrame, PushFrame, decode_frame_json,
};
use thiserror::Error;

use crate::requests::{RequestTable, RouteError};
use crate::ssh::SshTunnel;

const READ_BUFFER_BYTES: usize = 64 * 1024;

/// How many push events one connection buffers before its pump waits for
/// the consumer.
///
/// The pump reads responses and pushes from one ordered stream, so a full
/// push channel also holds back responses: that is the backpressure. 256
/// frames cover a few seconds of a fast assistant stream while the consumer
/// is busy (the UI drains a batch per frame), and bound the worst case at
/// 256 × [`host_protocol::MAX_MESSAGE_BYTES`] (192 MiB); real frames are a
/// few KiB, so the usual bound is around 1 MiB. A consumer that stalls for
/// longer than the liveness timeout makes a supervised connection look dead
/// and reconnect, because the `host.status` answer waits behind the pushes.
pub const PUSH_CHANNEL_CAPACITY: usize = 256;

/// One item on a connection's push channel.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum PushEvent {
    /// A frame the Host sent unasked.
    Frame(PushFrame),
    /// The channel was full, so the pump stopped reading until the consumer
    /// made room. No frame was dropped: the frame that found the channel full
    /// follows this marker. Reported once per episode; an episode ends when
    /// the pump finds the channel empty again.
    Lagging,
}

/// Why a connection ended, as reported by [`ConnectionPump`].
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum ConnectionError {
    /// The Host closed the stream.
    #[error("the Runtime Host closed the connection")]
    HostClosed,
    /// Reading or writing the transport failed.
    #[error("Runtime Host transport failed")]
    Io(#[from] io::Error),
    /// The byte stream is not valid framing.
    #[error(transparent)]
    Frame(#[from] FrameError),
    /// A frame claims a modeled shape but does not match it.
    #[error(transparent)]
    Decode(#[from] FrameDecodeError),
    /// The Host broke the protocol, for example with an unmatched response.
    #[error("Runtime Host protocol violation: {0}")]
    Protocol(String),
    /// The SSH process that forwards the connection exited; the text says
    /// how.
    #[error("the SSH tunnel to the Runtime Host ended ({0})")]
    TunnelEnded(String),
}

impl From<RouteError> for ConnectionError {
    fn from(error: RouteError) -> Self {
        match error {
            RouteError::Unmatched { request_id } => {
                Self::Protocol(format!("response for unknown request {request_id}"))
            }
            RouteError::OperationMismatch { request_id } => Self::Protocol(format!(
                "response for request {request_id} names a different operation"
            )),
        }
    }
}

/// The receiving half of a transport: whole protocol messages, in order.
pub(crate) trait MessageSource: Send + 'static {
    /// The next message's text, not yet parsed as JSON, or `None` at a clean
    /// end of the transport.
    fn next_message(
        &mut self,
    ) -> impl Future<Output = Result<Option<String>, ConnectionError>> + Send;
}

/// The sending half of a transport.
pub(crate) trait MessageSink: Send + 'static {
    /// Sends one frame as [`host_protocol::encode_frame`] made it: compact
    /// JSON followed by exactly one `\n`.
    fn send_frame(
        &mut self,
        frame: Vec<u8>,
    ) -> impl Future<Output = Result<(), ConnectionError>> + Send;

    /// Best effort: tells the Host no more frames follow.
    fn close(&mut self) -> impl Future<Output = ()> + Send;
}

/// The next message, parsed and classified; `None` at a clean end.
pub(crate) async fn next_host_frame<S: MessageSource>(
    source: &mut S,
) -> Result<Option<HostFrame>, ConnectionError> {
    let Some(text) = source.next_message().await? else {
        return Ok(None);
    };
    let value = decode_frame_json(&text)?;
    Ok(Some(HostFrame::decode(value)?))
}

/// Reads whole frames from a byte stream.
pub(crate) struct FrameReader<R> {
    reader: R,
    decoder: FrameDecoder,
    ready: VecDeque<String>,
    buffer: Box<[u8]>,
}

impl<R: AsyncRead + Unpin> FrameReader<R> {
    pub(crate) fn new(reader: R) -> Self {
        Self {
            reader,
            decoder: FrameDecoder::new(),
            ready: VecDeque::new(),
            buffer: vec![0; READ_BUFFER_BYTES].into_boxed_slice(),
        }
    }

    /// The next frame's text, or `None` at a clean end of stream.
    pub(crate) async fn next_frame(&mut self) -> Result<Option<String>, ConnectionError> {
        loop {
            if let Some(frame) = self.ready.pop_front() {
                return Ok(Some(frame));
            }
            let read = self.reader.read(&mut self.buffer).await?;
            if read == 0 {
                self.decoder.finish()?;
                return Ok(None);
            }
            self.ready.extend(self.decoder.push(&self.buffer[..read])?);
        }
    }
}

impl<R: AsyncRead + Unpin + Send + 'static> MessageSource for FrameReader<R> {
    fn next_message(
        &mut self,
    ) -> impl Future<Output = Result<Option<String>, ConnectionError>> + Send {
        self.next_frame()
    }
}

/// Writes newline-delimited frames to a byte stream.
pub(crate) struct StreamSink<W>(pub(crate) W);

impl<W: AsyncWrite + Unpin + Send + 'static> MessageSink for StreamSink<W> {
    async fn send_frame(&mut self, frame: Vec<u8>) -> Result<(), ConnectionError> {
        self.0.write_all(&frame).await?;
        self.0.flush().await?;
        Ok(())
    }

    async fn close(&mut self) {
        let _ = self.0.close().await;
    }
}

/// The future that drives one connection. It must be polled, typically by
/// spawning it on the application's executor, or no request completes.
///
/// It resolves when the connection ends: `Ok(())` after
/// [`crate::Connection::shutdown`] or once every `Connection` handle is
/// dropped, and `Err` when the Host or the transport ends it. Either way,
/// every waiting request fails and the push receiver closes.
#[must_use = "a connection makes no progress unless its pump is polled"]
pub struct ConnectionPump {
    future: Pin<Box<dyn Future<Output = Result<(), ConnectionError>> + Send>>,
    table: Arc<RequestTable>,
}

/// The transport a pump drives: its two halves and, for an SSH-forwarded
/// connection, the tunnel, which ends with the connection.
pub(crate) struct Transport<S, K> {
    pub(crate) source: S,
    pub(crate) sink: K,
    pub(crate) tunnel: Option<SshTunnel>,
}

impl ConnectionPump {
    pub(crate) fn new<S: MessageSource, K: MessageSink>(
        transport: Transport<S, K>,
        outgoing: async_channel::Receiver<Vec<u8>>,
        table: Arc<RequestTable>,
        pushes: async_channel::Sender<PushEvent>,
    ) -> Self {
        Self { future: Box::pin(run(transport, outgoing, table.clone(), pushes)), table }
    }
}

impl Drop for ConnectionPump {
    /// A pump dropped before it finished (for example, a cancelled task) must
    /// not leave requests waiting forever. After a normal finish this is a
    /// no-op: the table keeps the first close reason.
    fn drop(&mut self) {
        self.table.close("the connection pump was dropped".into());
    }
}

impl Future for ConnectionPump {
    type Output = Result<(), ConnectionError>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        self.future.as_mut().poll(cx)
    }
}

impl fmt::Debug for ConnectionPump {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ConnectionPump").finish_non_exhaustive()
    }
}

async fn run<S: MessageSource, K: MessageSink>(
    transport: Transport<S, K>,
    outgoing: async_channel::Receiver<Vec<u8>>,
    table: Arc<RequestTable>,
    pushes: async_channel::Sender<PushEvent>,
) -> Result<(), ConnectionError> {
    let Transport { mut source, mut sink, mut tunnel } = transport;
    let mut push_sink = PushSink { pushes: pushes.clone(), lagging: false };
    let result = future::or(
        future::or(
            read_frames(&mut source, &table, &mut push_sink),
            write_frames(&mut sink, &outgoing),
        ),
        async {
            match tunnel.as_mut() {
                Some(tunnel) => Err(ConnectionError::TunnelEnded(tunnel.exited().await)),
                None => future::pending().await,
            }
        },
    )
    .await;
    let reason: Arc<str> = match &result {
        Ok(()) => "the connection was shut down".into(),
        Err(error) => error.to_string().into(),
    };
    table.close(reason);
    outgoing.close();
    pushes.close();
    // Best effort: tell the Host we are done writing.
    sink.close().await;
    if let Some(tunnel) = tunnel {
        tunnel.close().await;
    }
    result
}

/// The sending half of the push channel, with the lagging episode state.
struct PushSink {
    pushes: async_channel::Sender<PushEvent>,
    lagging: bool,
}

impl PushSink {
    /// Queues `frame`, waiting for room when the channel is full. Never drops
    /// a frame while someone listens; a dropped receiver means nobody does.
    async fn deliver(&mut self, frame: PushFrame) {
        match self.pushes.try_send(PushEvent::Frame(frame)) {
            Ok(()) => {
                // The consumer had drained everything: the episode is over.
                if self.pushes.len() <= 1 {
                    self.lagging = false;
                }
            }
            Err(TrySendError::Full(event)) => {
                if !self.lagging {
                    self.lagging = true;
                    if self.pushes.send(PushEvent::Lagging).await.is_err() {
                        return;
                    }
                }
                let _ = self.pushes.send(event).await;
            }
            Err(TrySendError::Closed(_)) => {}
        }
    }
}

async fn read_frames<S: MessageSource>(
    source: &mut S,
    table: &RequestTable,
    pushes: &mut PushSink,
) -> Result<(), ConnectionError> {
    loop {
        let Some(frame) = next_host_frame(source).await? else {
            return Err(ConnectionError::HostClosed);
        };
        match frame {
            HostFrame::Response(response) => table.route(response)?,
            HostFrame::Push(push) => pushes.deliver(push).await,
            HostFrame::Handshake(_) => {
                return Err(ConnectionError::Protocol("handshake frame after acceptance".into()));
            }
        }
    }
}

async fn write_frames<K: MessageSink>(
    sink: &mut K,
    outgoing: &async_channel::Receiver<Vec<u8>>,
) -> Result<(), ConnectionError> {
    // `recv` fails once the channel is closed by `shutdown` or every sender
    // (every `Connection` handle) is gone.
    while let Ok(frame) = outgoing.recv().await {
        sink.send_frame(frame).await?;
    }
    Ok(())
}
