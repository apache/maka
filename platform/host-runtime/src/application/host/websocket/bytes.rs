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

//! Binary WebSocket messages carry the existing application byte stream.
use futures_util::{Sink, Stream};
use hyper::body::Bytes;
use std::{
    io,
    pin::Pin,
    task::{Context, Poll, ready},
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio_tungstenite::{WebSocketStream, tungstenite::Message};

pub(super) fn config() -> tokio_tungstenite::tungstenite::protocol::WebSocketConfig {
    let mut config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
    config.max_message_size = None;
    config.max_frame_size = None;
    config.max_write_buffer_size = 2 * 1024 * 1024;
    config
}
pub(super) struct Channel<S> {
    socket: WebSocketStream<S>,
    pending: Bytes,
    flush: bool,
}
impl<S> Channel<S> {
    pub(super) fn new(socket: WebSocketStream<S>) -> Self {
        Self {
            socket,
            pending: Bytes::new(),
            flush: false,
        }
    }
}
impl<S: AsyncRead + AsyncWrite + Unpin> AsyncRead for Channel<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        output: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if output.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        loop {
            if !self.pending.is_empty() {
                let count = self.pending.len().min(output.remaining());
                output.put_slice(&self.pending.split_to(count));
                return Poll::Ready(Ok(()));
            }
            if self.flush {
                ready!(Pin::new(&mut self.socket).poll_flush(cx)).map_err(io::Error::other)?;
                self.flush = false;
            }
            match ready!(Pin::new(&mut self.socket).poll_next(cx)) {
                Some(Ok(Message::Binary(bytes))) => self.pending = bytes,
                Some(Ok(Message::Ping(_))) => self.flush = true,
                Some(Ok(Message::Pong(_))) => {}
                Some(Ok(Message::Close(_))) | None => return Poll::Ready(Ok(())),
                Some(Ok(_)) => {
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "Application WebSocket requires binary messages",
                    )));
                }
                Some(Err(error)) => return Poll::Ready(Err(io::Error::other(error))),
            }
        }
    }
}
impl<S: AsyncRead + AsyncWrite + Unpin> AsyncWrite for Channel<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        if bytes.is_empty() {
            return Poll::Ready(Ok(0));
        }
        ready!(Pin::new(&mut self.socket).poll_ready(cx)).map_err(io::Error::other)?;
        let length = bytes.len().min(crate::application::RESOURCE_CHUNK_LIMIT);
        Pin::new(&mut self.socket)
            .start_send(Message::Binary(Bytes::copy_from_slice(&bytes[..length])))
            .map_err(io::Error::other)?;
        Poll::Ready(Ok(length))
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.socket)
            .poll_flush(cx)
            .map_err(io::Error::other)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.socket)
            .poll_close(cx)
            .map_err(io::Error::other)
    }
}
