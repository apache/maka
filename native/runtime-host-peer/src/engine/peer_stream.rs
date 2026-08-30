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
use libp2p::PeerId;
use tokio::sync::{mpsc, oneshot, watch};

use super::{CompletedStream, PeerError, StreamCompletion};

const QUEUE_CAPACITY: usize = 64;
const CHUNK_BYTES: usize = 64 * 1024;

pub struct PeerStream {
    pub peer_id: PeerId,
    pub incoming: mpsc::Receiver<Result<Vec<u8>, PeerError>>,
    pub commands: mpsc::Sender<StreamCommand>,
    pub abort: watch::Sender<bool>,
}

pub enum StreamCommand {
    Write {
        bytes: Vec<u8>,
        result: oneshot::Sender<Result<(), PeerError>>,
    },
    Close {
        result: oneshot::Sender<Result<(), PeerError>>,
    },
}

pub(super) fn spawn_stream(
    peer_id: PeerId,
    stream: libp2p::swarm::Stream,
    completion: Option<(StreamCompletion, mpsc::Sender<CompletedStream>)>,
) -> PeerStream {
    let (incoming_tx, incoming_rx) = mpsc::channel(QUEUE_CAPACITY);
    let (command_tx, mut command_rx) = mpsc::channel(QUEUE_CAPACITY);
    let (abort_tx, mut abort_rx) = watch::channel(false);
    let abort_guard = abort_tx.clone();
    tokio::spawn(async move {
        let _abort_guard = abort_guard;
        let (mut reader, mut writer) = stream.split();
        let mut buffer = vec![0_u8; CHUNK_BYTES];
        let mut pending_read: Option<Result<Vec<u8>, PeerError>> = None;
        let mut finish_after_delivery = false;
        let mut close_result = None;
        loop {
            tokio::select! {
                biased;
                changed = abort_rx.changed() => {
                    let _ = changed;
                    break;
                }
                command = command_rx.recv() => match command {
                    Some(StreamCommand::Write { bytes, result }) => {
                        let outcome = tokio::select! {
                            biased;
                            _ = abort_rx.changed() => Err(PeerError::new(
                                "peer_stream_aborted",
                                "peer stream was aborted",
                            )),
                            outcome = writer.write_all(&bytes) => outcome.map_err(|error| {
                                PeerError::new("peer_native_failed", error.to_string())
                            }),
                        };
                        let failed = outcome.is_err();
                        let _ = result.send(outcome);
                        if failed { break; }
                    }
                    Some(StreamCommand::Close { result }) => {
                        let outcome = tokio::select! {
                            biased;
                            _ = abort_rx.changed() => Err(PeerError::new(
                                "peer_stream_aborted",
                                "peer stream was aborted",
                            )),
                            outcome = writer.close() => outcome.map_err(|error| {
                                PeerError::new("peer_native_failed", error.to_string())
                            }),
                        };
                        close_result = Some((result, outcome));
                        break;
                    }
                    None => break,
                },
                permit = incoming_tx.reserve(), if pending_read.is_some() => match permit {
                    Ok(permit) => {
                        permit.send(pending_read.take().expect("read is pending"));
                        if finish_after_delivery { break; }
                    }
                    Err(_) => break,
                },
                read = reader.read(&mut buffer), if pending_read.is_none() => match read {
                    Ok(0) => break,
                    Ok(size) => pending_read = Some(Ok(buffer[..size].to_vec())),
                    Err(error) => {
                        pending_read = Some(Err(PeerError::new(
                            "peer_native_failed",
                            error.to_string(),
                        )));
                        finish_after_delivery = true;
                    }
                },
            }
        }
        if let Some((completion, completed)) = completion {
            let (acknowledged, acknowledgment) = oneshot::channel();
            if completed
                .send(CompletedStream {
                    kind: completion,
                    acknowledged,
                })
                .await
                .is_ok()
            {
                let _ = acknowledgment.await;
            }
        }
        if let Some((result, outcome)) = close_result {
            let _ = result.send(outcome);
        }
    });
    PeerStream {
        peer_id,
        incoming: incoming_rx,
        commands: command_tx,
        abort: abort_tx,
    }
}
