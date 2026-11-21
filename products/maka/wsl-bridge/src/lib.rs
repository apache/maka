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

//! Same-user WSL Desktop stdio protocol.
//!
//! Stream order is fixed by the protocol:
//! 1. Bootstrap stream: residency handoff (`0` -> `Ready` -> `1` + half-close -> `1`),
//!    then held open until the Host anchor stream closes.
//! 2. Host `Connect` anchor stream, opened before completing the residency handoff.
//! 3. Subsequent streams: unmodified Host IPC channels.

use serde::{Deserialize, Serialize};
use std::{future::poll_fn, io, task::Poll};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::{mpsc, oneshot},
};
use tokio_util::compat::{Compat, FuturesAsyncReadCompatExt, TokioAsyncReadCompatExt};
use uuid::Uuid;
use yamux::{Config, Mode};

pub const HELPER: &str = "__maka-wsl-stdio-v1";
pub type Stream = Compat<yamux::Stream>;
type Mux<T> = yamux::Connection<Compat<T>>;
type Open = oneshot::Sender<Stream>;

#[derive(Clone)]
pub struct Opener(mpsc::Sender<Open>);

impl Opener {
    pub async fn open(&self) -> io::Result<Stream> {
        let (reply, stream) = oneshot::channel();
        self.0.send(reply).await.map_err(|_| disconnected())?;
        stream.await.map_err(|_| disconnected())
    }
}

fn disconnected() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "WSL stdio bridge disconnected")
}

pub fn client<T: AsyncRead + AsyncWrite + Unpin>(
    io: T,
) -> (Opener, impl Future<Output = io::Result<()>>) {
    let (sender, mut requests) = mpsc::channel::<Open>(32);
    let mut mux = Mux::new(io.compat(), Config::default(), Mode::Client);
    let drive = async move {
        let mut opening = None::<Open>;
        poll_fn(move |cx| {
            if opening.as_ref().is_some_and(Open::is_closed) {
                opening = None;
            }
            if opening.is_none() {
                match requests.poll_recv(cx) {
                    Poll::Ready(Some(request)) => opening = Some(request),
                    Poll::Ready(None) => return Poll::Ready(Ok(())),
                    Poll::Pending => {}
                }
            }
            if opening.is_some() {
                match mux.poll_new_outbound(cx) {
                    Poll::Ready(Ok(stream)) => {
                        let _ = opening.take().unwrap().send(stream.compat());
                        cx.waker().wake_by_ref();
                    }
                    Poll::Ready(Err(error)) => return Poll::Ready(Err(io::Error::other(error))),
                    Poll::Pending => {}
                }
            }
            match mux.poll_next_inbound(cx) {
                Poll::Ready(Some(Ok(_))) => Poll::Ready(Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "unexpected WSL server-initiated stream",
                ))),
                Poll::Ready(Some(Err(error))) => Poll::Ready(Err(io::Error::other(error))),
                Poll::Ready(None) => Poll::Ready(Ok(())),
                Poll::Pending => Poll::Pending,
            }
        })
        .await
    };
    (Opener(sender), drive)
}

pub struct Server<T: AsyncRead + AsyncWrite + Unpin>(Mux<T>);

impl<T: AsyncRead + AsyncWrite + Unpin> Server<T> {
    pub fn new(io: T) -> Self {
        Self(Mux::new(io.compat(), Config::default(), Mode::Server))
    }

    pub async fn accept(&mut self) -> io::Result<Option<Stream>> {
        poll_fn(|cx| self.0.poll_next_inbound(cx))
            .await
            .transpose()
            .map(|stream| stream.map(FuturesAsyncReadCompatExt::compat))
            .map_err(io::Error::other)
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ready {
    pub root: String,
    pub epoch: Uuid,
}

impl Ready {
    pub async fn send(&self, stream: &mut Stream) -> io::Result<()> {
        let bytes = serde_json::to_vec(self)?;
        stream
            .write_u16(bytes.len().try_into().map_err(io::Error::other)?)
            .await?;
        stream.write_all(&bytes).await?;
        stream.flush().await
    }

    pub async fn receive(stream: &mut Stream) -> io::Result<Self> {
        // Opening a yamux stream alone does not send a frame.
        stream.write_u8(0).await?;
        stream.flush().await?;
        let length = stream.read_u16().await? as usize;
        if length > 256 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid WSL ready length",
            ));
        }
        let mut bytes = vec![0; length];
        stream.read_exact(&mut bytes).await?;
        serde_json::from_slice(&bytes).map_err(io::Error::other)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::task::JoinSet;

    #[tokio::test]
    async fn multiplexes_handoff_and_independent_half_closed_ipc_channels() {
        tokio::time::timeout(Duration::from_secs(10), async {
            let (desktop, linux) = tokio::io::duplex(8 * 1024);
            let (opener, drive) = client(desktop);
            let driver = tokio::spawn(drive);
            let ready = Ready {
                root: "a".repeat(64),
                epoch: Uuid::from_u128(1),
            };
            let epoch = ready.epoch;
            let (lose_anchor, anchor_lost) = oneshot::channel();
            let server = tokio::spawn(async move {
                let mut server = Server::new(linux);
                let mut bootstrap = server.accept().await.unwrap().unwrap();
                let mut calls = JoinSet::new();
                calls.spawn(async move {
                    assert_eq!(bootstrap.read_u8().await.unwrap(), 0);
                    ready.send(&mut bootstrap).await.unwrap();
                    assert_eq!(bootstrap.read_u8().await.unwrap(), 1);
                    bootstrap.write_u8(1).await.unwrap();
                    bootstrap.flush().await.unwrap();
                    anchor_lost.await.unwrap();
                    drop(bootstrap);
                });
                while let Some(mut stream) = server.accept().await.unwrap() {
                    calls.spawn(async move {
                        let (mut bridge_side, mut host_side) = tokio::io::duplex(8 * 1024);
                        let bridge = async {
                            tokio::io::copy_bidirectional(&mut stream, &mut bridge_side)
                                .await
                                .unwrap();
                        };
                        let host = async {
                            let mut bytes = Vec::new();
                            host_side.read_to_end(&mut bytes).await.unwrap();
                            bytes.reverse();
                            host_side.write_all(&bytes).await.unwrap();
                            host_side.shutdown().await.unwrap();
                        };
                        tokio::join!(bridge, host);
                    });
                    while let Some(result) = calls.try_join_next() {
                        result.unwrap();
                    }
                }
                while let Some(result) = calls.join_next().await {
                    result.unwrap();
                }
            });

            let mut bootstrap = opener.open().await.unwrap();
            assert_eq!(Ready::receive(&mut bootstrap).await.unwrap().epoch, epoch);
            let call = |marker| {
                let opener = opener.clone();
                async move {
                    fn as_host_channel(
                        _: &(impl AsyncRead + AsyncWrite + Unpin + Send + Sync + 'static),
                    ) {
                    }
                    let mut stream = opener.open().await.unwrap();
                    as_host_channel(&stream);
                    let mut payload = vec![marker; 512 * 1024];
                    payload[0] = 0;
                    stream.write_all(&payload).await.unwrap();
                    stream.shutdown().await.unwrap();
                    let mut response = Vec::new();
                    stream.read_to_end(&mut response).await.unwrap();
                    payload.reverse();
                    assert!(response == payload);
                }
            };
            let acknowledge = async {
                bootstrap.write_u8(1).await.unwrap();
                bootstrap.shutdown().await.unwrap();
                assert_eq!(bootstrap.read_u8().await.unwrap(), 1);
            };
            tokio::join!(call(3), call(4), acknowledge);
            lose_anchor.send(()).unwrap();
            let mut eof = [0];
            assert_eq!(bootstrap.read(&mut eof).await.unwrap(), 0);
            call(5).await;
            drop(opener);
            driver.await.unwrap().unwrap();
            server.await.unwrap();
        })
        .await
        .unwrap();
    }
}
