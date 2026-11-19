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
        self, ConnectOptions, EngineCommand, PeerConnectionPath, PeerStream, StartedEndpoint,
        StreamCommand, StreamKind,
    },
};
use std::{
    io,
    path::PathBuf,
    sync::atomic::{AtomicU32, Ordering},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, DuplexStream},
    sync::oneshot,
};

pub struct Endpoint {
    inner: StartedEndpoint,
    next: AtomicU32,
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

    pub async fn accept(&mut self, expected: PeerId) -> Result<DuplexStream, String> {
        loop {
            let stream = self
                .inner
                .incoming
                .recv()
                .await
                .ok_or("peer listener stopped")?;
            if stream.peer_id == expected && matches!(stream.path, PeerConnectionPath::Direct(_)) {
                return Ok(bridge(stream));
            }
            stream.abort.send_replace(true);
        }
    }

    pub async fn open(&self, expected: PeerId, address: Multiaddr) -> Result<DuplexStream, String> {
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
        let stream = rx
            .await
            .map_err(|_| "peer dial was interrupted")?
            .map_err(|err| err.to_string())?;
        if stream.peer_id != expected || !matches!(stream.path, PeerConnectionPath::Direct(_)) {
            stream.abort.send_replace(true);
            return Err("unexpected peer path or identity".into());
        }
        Ok(bridge(stream))
    }
}

// The engine exposes acknowledged writes and bounded receive chunks. The
// bridge drains both directions independently so neither peer can wedge both.
fn bridge(mut stream: PeerStream) -> DuplexStream {
    let (app, engine) = tokio::io::duplex(64 * 1024);
    let (mut input, mut output) = tokio::io::split(engine);
    tokio::spawn(async move {
        let incoming = async {
            while let Some(chunk) = stream.incoming.recv().await {
                output.write_all(&chunk.map_err(io::Error::other)?).await?;
            }
            output.shutdown().await
        };
        let outgoing = async {
            let mut bytes = vec![0; 64 * 1024];
            loop {
                let size = input.read(&mut bytes).await?;
                let (result, done) = oneshot::channel();
                let command = if size == 0 {
                    StreamCommand::Close { result }
                } else {
                    StreamCommand::Write {
                        bytes: bytes[..size].to_vec(),
                        result,
                    }
                };
                stream
                    .commands
                    .send(command)
                    .await
                    .map_err(io::Error::other)?;
                done.await
                    .map_err(io::Error::other)?
                    .map_err(io::Error::other)?;
                if size == 0 {
                    return Ok(());
                }
            }
        };
        let _finished = tokio::try_join!(incoming, outgoing);
        stream.abort.send_replace(true);
    });
    app
}
