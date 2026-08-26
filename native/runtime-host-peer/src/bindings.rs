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

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use libp2p::{Multiaddr, PeerId};
use napi::bindgen_prelude::{Buffer, Error, Result, Status};
use napi_derive::napi;
use tokio::sync::{Mutex as AsyncMutex, mpsc, oneshot};

use crate::engine::{self, EngineCommand, PeerError, StreamCommand};

type IncomingStreamReceiver = mpsc::Receiver<std::result::Result<Vec<u8>, PeerError>>;

#[napi(object)]
pub struct StartPeerEndpointOptions {
    pub key_path: String,
    pub expected_peer_id: Option<String>,
    pub listen_addresses: Option<Vec<String>>,
    pub coordination_relays: Option<Vec<String>>,
}

#[napi(object)]
pub struct ConnectPeerOptions {
    pub peer_id: String,
    pub route_hints: Vec<String>,
    pub coordination_relays: Option<Vec<String>>,
    pub direct_deadline_ms: u32,
}

#[napi]
pub struct PeerEndpoint {
    peer_id: String,
    listen_addresses: Vec<String>,
    commands: mpsc::Sender<EngineCommand>,
    incoming: Arc<AsyncMutex<mpsc::Receiver<engine::PeerStream>>>,
    terminal: Arc<AsyncMutex<mpsc::Receiver<PeerError>>>,
    thread: Arc<Mutex<Option<std::thread::JoinHandle<()>>>>,
}

#[napi]
impl PeerEndpoint {
    #[napi(getter)]
    pub fn peer_id(&self) -> String {
        self.peer_id.clone()
    }

    #[napi(getter)]
    pub fn listen_addresses(&self) -> Vec<String> {
        self.listen_addresses.clone()
    }

    #[napi]
    pub async fn connect(&self, options: ConnectPeerOptions) -> Result<PeerStream> {
        let peer_id = parse_peer_id(&options.peer_id)?;
        let route_hints = parse_addresses(options.route_hints, "route hint")?;
        let coordination_relays = parse_addresses(
            options.coordination_relays.unwrap_or_default(),
            "coordination relay",
        )?;
        if !(1..=120_000).contains(&options.direct_deadline_ms) {
            return Err(Error::new(
                Status::InvalidArg,
                "direct deadline must be between 1 and 120000 milliseconds",
            ));
        }
        let (result_tx, result_rx) = oneshot::channel();
        self.commands
            .send(EngineCommand::Connect {
                options: engine::ConnectOptions {
                    peer_id,
                    route_hints,
                    coordination_relays,
                    deadline: Duration::from_millis(u64::from(options.direct_deadline_ms)),
                },
                result: result_tx,
            })
            .await
            .map_err(|_| {
                peer_error(PeerError {
                    code: "peer_native_failed",
                    message: "peer endpoint is closed".to_owned(),
                })
            })?;
        wrap_stream(
            result_rx
                .await
                .map_err(|_| native_closed_error())?
                .map_err(peer_error)?,
        )
    }

    #[napi]
    pub async fn accept(&self) -> Result<Option<PeerStream>> {
        let mut incoming = self.incoming.lock().await;
        let mut terminal = self.terminal.lock().await;
        tokio::select! {
            error = terminal.recv() => match error {
                Some(error) => Err(peer_error(error)),
                None => Ok(None),
            },
            stream = incoming.recv() => stream.map(wrap_stream).transpose(),
        }
    }

    #[napi]
    pub async fn close(&self) -> Result<()> {
        let (result_tx, result_rx) = oneshot::channel();
        if self
            .commands
            .send(EngineCommand::Stop { result: result_tx })
            .await
            .is_ok()
        {
            let _ = result_rx.await;
        }
        let thread = self
            .thread
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "peer endpoint lock poisoned"))?
            .take();
        if let Some(thread) = thread {
            tokio::task::spawn_blocking(move || thread.join())
                .await
                .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?
                .map_err(|_| Error::new(Status::GenericFailure, "peer endpoint thread panicked"))?;
        }
        Ok(())
    }
}

impl Drop for PeerEndpoint {
    fn drop(&mut self) {
        if Arc::strong_count(&self.thread) == 1 {
            let (result, _) = oneshot::channel();
            let _ = self.commands.try_send(EngineCommand::Stop { result });
        }
    }
}

#[napi]
pub struct PeerStream {
    incoming: Arc<AsyncMutex<IncomingStreamReceiver>>,
    commands: mpsc::Sender<StreamCommand>,
}

#[napi]
impl PeerStream {
    #[napi]
    pub async fn read(&self) -> Result<Option<Buffer>> {
        match self.incoming.lock().await.recv().await {
            Some(Ok(bytes)) => Ok(Some(bytes.into())),
            Some(Err(error)) => Err(peer_error(error)),
            None => Ok(None),
        }
    }

    #[napi]
    pub async fn write(&self, bytes: Buffer) -> Result<()> {
        let (result_tx, result_rx) = oneshot::channel();
        self.commands
            .send(StreamCommand::Write {
                bytes: bytes.to_vec(),
                result: result_tx,
            })
            .await
            .map_err(|_| native_closed_error())?;
        result_rx
            .await
            .map_err(|_| native_closed_error())?
            .map_err(peer_error)
    }

    #[napi]
    pub async fn close(&self) -> Result<()> {
        let (result_tx, result_rx) = oneshot::channel();
        if self
            .commands
            .send(StreamCommand::Close { result: result_tx })
            .await
            .is_err()
        {
            return Ok(());
        }
        match result_rx.await {
            Ok(result) => result.map_err(peer_error),
            Err(_) => Ok(()),
        }
    }

    #[napi]
    pub fn abort(&self) {
        let _ = self.commands.try_send(StreamCommand::Abort);
    }
}

#[napi]
pub fn start_peer_endpoint(options: StartPeerEndpointOptions) -> Result<PeerEndpoint> {
    let started = engine::start(engine::StartOptions {
        key_path: PathBuf::from(options.key_path),
        expected_peer_id: options
            .expected_peer_id
            .map(|value| parse_peer_id(&value))
            .transpose()?,
        listen_addresses: parse_addresses(options.listen_addresses.unwrap_or_default(), "listen")?,
        coordination_relays: parse_addresses(
            options.coordination_relays.unwrap_or_default(),
            "coordination relay",
        )?,
    })
    .map_err(peer_error)?;
    Ok(PeerEndpoint {
        peer_id: started.peer_id.to_string(),
        listen_addresses: started
            .listen_addresses
            .into_iter()
            .map(|address| address.to_string())
            .collect(),
        commands: started.commands,
        incoming: Arc::new(AsyncMutex::new(started.incoming)),
        terminal: Arc::new(AsyncMutex::new(started.terminal)),
        thread: Arc::new(Mutex::new(Some(started.thread))),
    })
}

#[napi]
pub async fn ensure_peer_identity(key_path: String) -> Result<String> {
    engine::ensure_identity(PathBuf::from(key_path))
        .await
        .map(|peer_id| peer_id.to_string())
        .map_err(peer_error)
}

fn wrap_stream(stream: engine::PeerStream) -> Result<PeerStream> {
    Ok(PeerStream {
        incoming: Arc::new(AsyncMutex::new(stream.incoming)),
        commands: stream.commands,
    })
}

fn parse_peer_id(value: &str) -> Result<PeerId> {
    value
        .parse()
        .map_err(|_| Error::new(Status::InvalidArg, "peer id is invalid"))
}

fn parse_addresses(values: Vec<String>, label: &str) -> Result<Vec<Multiaddr>> {
    values
        .into_iter()
        .map(|value| {
            value.parse().map_err(|_| {
                Error::new(Status::InvalidArg, format!("{label} multiaddr is invalid"))
            })
        })
        .collect()
}

fn peer_error(error: PeerError) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("{}: {}", error.code, error.message),
    )
}

fn native_closed_error() -> Error {
    peer_error(PeerError {
        code: "peer_native_failed",
        message: "peer stream is closed".to_owned(),
    })
}
