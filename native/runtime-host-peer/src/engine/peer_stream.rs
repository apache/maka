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

use futures::{AsyncReadExt as _, AsyncWriteExt as _};
use libp2p::swarm::ConnectionId;
use tokio::sync::{mpsc, oneshot};

use super::PeerError;

const QUEUE_CAPACITY: usize = 64;
const CHUNK_BYTES: usize = 64 * 1024;

pub struct PeerStream {
    pub incoming: mpsc::Receiver<Result<Vec<u8>, PeerError>>,
    pub commands: mpsc::Sender<StreamCommand>,
}

pub enum StreamCommand {
    Write {
        bytes: Vec<u8>,
        result: oneshot::Sender<Result<(), PeerError>>,
    },
    Close {
        result: oneshot::Sender<Result<(), PeerError>>,
    },
    Abort,
}

pub(super) fn spawn_stream(
    stream: libp2p::swarm::Stream,
    close_connection: Option<(ConnectionId, mpsc::Sender<ConnectionId>)>,
) -> PeerStream {
    let (incoming_tx, incoming_rx) = mpsc::channel(QUEUE_CAPACITY);
    let (command_tx, mut command_rx) = mpsc::channel(QUEUE_CAPACITY);
    tokio::spawn(async move {
        let (mut reader, mut writer) = stream.split();
        let mut buffer = vec![0_u8; CHUNK_BYTES];
        loop {
            tokio::select! {
                read = reader.read(&mut buffer) => match read {
                    Ok(0) => break,
                    Ok(size) => {
                        if incoming_tx.send(Ok(buffer[..size].to_vec())).await.is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = incoming_tx.send(Err(PeerError::new(
                            "peer_native_failed",
                            error.to_string(),
                        ))).await;
                        break;
                    }
                },
                command = command_rx.recv() => match command {
                    Some(StreamCommand::Write { bytes, result }) => {
                        let outcome = writer.write_all(&bytes).await
                            .map_err(|error| PeerError::new("peer_native_failed", error.to_string()));
                        let failed = outcome.is_err();
                        let _ = result.send(outcome);
                        if failed { break; }
                    }
                    Some(StreamCommand::Close { result }) => {
                        let outcome = writer.close().await
                            .map_err(|error| PeerError::new("peer_native_failed", error.to_string()));
                        let _ = result.send(outcome);
                        break;
                    }
                    Some(StreamCommand::Abort) | None => break,
                }
            }
        }
        if let Some((connection_id, close)) = close_connection {
            let _ = close.send(connection_id).await;
        }
    });
    PeerStream {
        incoming: incoming_rx,
        commands: command_tx,
    }
}
