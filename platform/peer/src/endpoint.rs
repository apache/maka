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

use crate::{
    Multiaddr, PeerId,
    engine::{
        self, CHUNK_BYTES, ConnectOptions, EngineCommand, PeerConnectionPath, PeerError,
        PeerStream, StartedEndpoint, StreamCommand, StreamKind,
    },
};
use bytes::Bytes;
use std::{
    future::Future,
    io,
    path::PathBuf,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
    },
    task::{Context, Poll, ready},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    sync::{Mutex, oneshot},
};

pub struct Endpoint {
    inner: StartedEndpoint,
    next: AtomicU32,
    opening: Arc<Mutex<()>>,
}

impl Endpoint {
    pub async fn start(path: PathBuf, listen: Option<Multiaddr>) -> Result<Self, String> {
        tokio::task::spawn_blocking(move || {
            let incoming = listen.is_some();
            let options = engine::StartOptions {
                key_path: path,
                relay_anchor_path: None,
                expected_peer_id: None,
                listen_addresses: listen.into_iter().collect(),
                coordination_relays: vec![],
                automatic_relay_discovery: false,
                web_rtc_stun_urls: None,
            };
            let inner = if incoming {
                engine::start(options)
            } else {
                engine::start_dial_only(options)
            }
            .map_err(|err| err.to_string())?;
            Ok(Self {
                inner,
                next: AtomicU32::new(1),
                opening: Arc::new(Mutex::new(())),
            })
        })
        .await
        .map_err(|err| err.to_string())?
    }

    pub fn connectivity(&self) -> tokio::sync::watch::Receiver<engine::ConnectivitySnapshot> {
        self.inner.connectivity.clone()
    }

    pub fn peer_id(&self) -> PeerId {
        self.inner.peer_id
    }

    pub fn address(&self) -> Option<Multiaddr> {
        self.inner
            .reachability
            .borrow()
            .listen_addresses
            .first()
            .cloned()
    }

    pub async fn accept(&mut self, expected: PeerId) -> Result<Stream, String> {
        loop {
            let stream = self
                .inner
                .incoming
                .recv()
                .await
                .ok_or("peer listener stopped")?;
            if stream.peer_id == expected && matches!(stream.path, PeerConnectionPath::Direct(_)) {
                return Ok(Stream::new(stream));
            }
            stream.abort.send_replace(true);
        }
    }

    pub async fn open(&self, expected: PeerId, address: Multiaddr) -> Result<Stream, String> {
        let opening = self.opening.clone().lock_owned().await;
        let (tx, rx) = oneshot::channel();
        self.inner
            .commands
            .send(EngineCommand::Connect {
                options: ConnectOptions {
                    request_id: self.next.fetch_add(1, Ordering::Relaxed),
                    peer_id: expected,
                    route_hints: vec![address],
                    coordination_relays: vec![],
                    transit_relay_peers: vec![],
                    deadline: Duration::from_secs(5),
                },
                stream_kind: StreamKind::Application,
                result: tx,
            })
            .await
            .map_err(|_| "peer endpoint stopped")?;
        // The engine admits one application open at a time. Keep its slot
        // until the reply even if the caller drops this observation.
        let stream = tokio::spawn(async move {
            let _opening = opening;
            rx.await
        })
        .await
        .map_err(|err| err.to_string())?
        .map_err(|_| "peer dial was interrupted")?
        .map_err(|err| err.to_string())?;
        if stream.peer_id != expected || !matches!(stream.path, PeerConnectionPath::Direct(_)) {
            stream.abort.send_replace(true);
            return Err("unexpected peer path or identity".into());
        }
        Ok(Stream::new(stream))
    }
}

/// A peer byte stream. Shutting down writes leaves reads available.
pub struct Stream {
    peer: PeerStream,
    received: Bytes,
    write: WriteState,
}

type Ack = oneshot::Receiver<Result<(), PeerError>>;

enum WriteState {
    Ready,
    Writing(Ack),
    Closing(Ack),
    Closed,
}

impl Stream {
    fn new(peer: PeerStream) -> Self {
        Self {
            peer,
            received: Bytes::new(),
            write: WriteState::Ready,
        }
    }

    fn send(&self, command: StreamCommand) -> io::Result<()> {
        // This adapter owns the sender and never queues a second command before its acknowledgement.
        self.peer
            .commands
            .try_send(command)
            .map_err(|error| io::Error::other(error.to_string()))
    }
}

impl AsyncRead for Stream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        output: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if output.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        if self.received.is_empty() {
            let Some(chunk) = ready!(self.peer.incoming.poll_recv(cx)) else {
                return Poll::Ready(Ok(()));
            };
            self.received = Bytes::from(chunk.map_err(io::Error::other)?);
        }
        let count = self.received.len().min(output.remaining());
        output.put_slice(&self.received.split_to(count));
        Poll::Ready(Ok(()))
    }
}

impl AsyncWrite for Stream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        ready!(self.as_mut().poll_flush(cx))?;
        if !matches!(self.write, WriteState::Ready) {
            return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
        }
        if bytes.is_empty() {
            return Poll::Ready(Ok(0));
        }
        let count = bytes.len().min(CHUNK_BYTES);
        let (result, ack) = oneshot::channel();
        self.send(StreamCommand::Write {
            bytes: bytes[..count].to_vec(),
            result,
        })?;
        self.write = WriteState::Writing(ack);
        Poll::Ready(Ok(count))
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let (ack, closing) = match &mut self.write {
            WriteState::Writing(ack) => (ack, false),
            WriteState::Closing(ack) => (ack, true),
            _ => return Poll::Ready(Ok(())),
        };
        let result = ready!(Pin::new(ack).poll(cx))
            .map_err(io::Error::other)
            .and_then(|result| result.map_err(io::Error::other));
        self.write = if closing || result.is_err() {
            WriteState::Closed
        } else {
            WriteState::Ready
        };
        Poll::Ready(result)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        ready!(self.as_mut().poll_flush(cx))?;
        if matches!(self.write, WriteState::Ready) {
            let (result, ack) = oneshot::channel();
            self.send(StreamCommand::Close { result })?;
            self.write = WriteState::Closing(ack);
        }
        self.poll_flush(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn half_closed_peer_stream_can_read_response() {
        tokio::time::timeout(Duration::from_secs(15), async {
            let dir = tempfile::tempdir().unwrap();
            let mut host = Endpoint::start(
                dir.path().join("host"),
                Some("/ip4/127.0.0.1/tcp/0".parse().unwrap()),
            )
            .await
            .unwrap();
            let client = Endpoint::start(dir.path().join("client"), None)
                .await
                .unwrap();
            let address = host.address().unwrap();
            let server_id = host.peer_id();
            let client_id = client.peer_id();
            let request = vec![0x12; 512 * 1024];
            let response = vec![0x34; 512 * 1024];

            let serving = async {
                let mut stream = host.accept(client_id).await.unwrap();
                let mut received = Vec::new();
                stream.read_to_end(&mut received).await.unwrap();
                assert_eq!(received, request);
                stream.write_all(&response).await.unwrap();
                stream.shutdown().await.unwrap();
            };
            let calling = async {
                let mut stream = client.open(server_id, address).await.unwrap();
                stream.write_all(&request).await.unwrap();
                stream.shutdown().await.unwrap();
                let mut received = Vec::new();
                stream.read_to_end(&mut received).await.unwrap();
                assert_eq!(received, response);
            };
            tokio::join!(serving, calling);
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn concurrent_opens_keep_independent_streams_live() {
        tokio::time::timeout(Duration::from_secs(15), async {
            let dir = tempfile::tempdir().unwrap();
            let mut host = Endpoint::start(
                dir.path().join("host"),
                Some("/ip4/127.0.0.1/tcp/0".parse().unwrap()),
            )
            .await
            .unwrap();
            let client = Endpoint::start(dir.path().join("client"), None)
                .await
                .unwrap();
            let address = host.address().unwrap();
            let server_id = host.peer_id();
            let client_id = client.peer_id();
            let serving = async {
                let mut calls = tokio::task::JoinSet::new();
                for _ in 0..8 {
                    let mut stream = host.accept(client_id).await.unwrap();
                    calls.spawn(async move {
                        let value = stream.read_u8().await.unwrap();
                        stream.write_u8(value).await.unwrap();
                        stream.shutdown().await.unwrap();
                    });
                }
                while let Some(call) = calls.join_next().await {
                    call.unwrap();
                }
            };
            let calling = async {
                let streams = futures::future::join_all(
                    (0..8).map(|_| client.open(server_id, address.clone())),
                )
                .await;
                for (value, stream) in streams.into_iter().enumerate() {
                    let mut stream = stream.unwrap();
                    stream.write_u8(value as u8).await.unwrap();
                    assert_eq!(stream.read_u8().await.unwrap(), value as u8);
                }
            };
            tokio::join!(serving, calling);
        })
        .await
        .unwrap();
    }
}
