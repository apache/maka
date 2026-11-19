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
    pub path: PeerConnectionPath,
    pub incoming: mpsc::Receiver<Result<Vec<u8>, PeerError>>,
    pub commands: mpsc::Sender<StreamCommand>,
    pub abort: watch::Sender<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DirectTransport {
    Quic,
    Tcp,
    WebRtc,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PeerConnectionPath {
    Direct(DirectTransport),
    Transit { relay_peer_id: PeerId },
}

impl PeerConnectionPath {
    pub(super) fn relay_peer_id(&self) -> Option<PeerId> {
        match self {
            Self::Direct(_) => None,
            Self::Transit { relay_peer_id } => Some(*relay_peer_id),
        }
    }
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
    path: PeerConnectionPath,
    stream: impl futures::AsyncRead + futures::AsyncWrite + Unpin + Send + 'static,
    completion: Option<(StreamCompletion, mpsc::Sender<CompletedStream>)>,
) -> PeerStream {
    let (incoming_tx, incoming_rx) = mpsc::channel(QUEUE_CAPACITY);
    let (command_tx, mut command_rx) = mpsc::channel(QUEUE_CAPACITY);
    let (abort_tx, mut abort_rx) = watch::channel(false);
    let abort_guard = abort_tx.clone();
    tokio::spawn(async move {
        let _abort_guard = abort_guard;
        let (mut reader, mut writer) = stream.split();
        // Drive both halves independently. Awaiting a backpressured write in
        // the read loop deadlocks when both peers send more than the window.
        let close_result = {
            let reading = async {
                let mut buffer = vec![0_u8; CHUNK_BYTES];
                loop {
                    match reader.read(&mut buffer).await {
                        Ok(0) => break,
                        Ok(size) => {
                            if incoming_tx.send(Ok(buffer[..size].to_vec())).await.is_err() {
                                break;
                            }
                        }
                        Err(error) => {
                            let _ = incoming_tx
                                .send(Err(PeerError::new("peer_native_failed", error.to_string())))
                                .await;
                            break;
                        }
                    }
                }
            };
            let writing = async {
                while let Some(command) = command_rx.recv().await {
                    match command {
                        StreamCommand::Write { bytes, result } => {
                            let outcome = async {
                                writer.write_all(&bytes).await?;
                                writer.flush().await
                            }
                            .await
                            .map_err(|error: std::io::Error| {
                                PeerError::new("peer_native_failed", error.to_string())
                            });
                            let failed = outcome.is_err();
                            let _ = result.send(outcome);
                            if failed {
                                break;
                            }
                        }
                        StreamCommand::Close { result } => {
                            let outcome = writer.close().await.map_err(|error| {
                                PeerError::new("peer_native_failed", error.to_string())
                            });
                            return Some((result, outcome));
                        }
                    }
                }
                None
            };
            tokio::select! {
                biased;
                _ = abort_rx.changed() => None,
                result = writing => result,
                _ = reading => None,
            }
        };
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
        path,
        incoming: incoming_rx,
        commands: command_tx,
        abort: abort_tx,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_util::compat::TokioAsyncReadCompatExt;

    #[tokio::test]
    async fn simultaneous_large_writes_keep_reading_under_backpressure() {
        let (left, right) = tokio::io::duplex(1024);
        let mut left = spawn_stream(
            PeerId::random(),
            PeerConnectionPath::Direct(DirectTransport::Tcp),
            left.compat(),
            None,
        );
        let mut right = spawn_stream(
            PeerId::random(),
            PeerConnectionPath::Direct(DirectTransport::Tcp),
            right.compat(),
            None,
        );
        let (left_result, left_done) = oneshot::channel();
        let (right_result, right_done) = oneshot::channel();
        const BYTES: usize = 512 * 1024;
        left.commands
            .send(StreamCommand::Write {
                bytes: vec![1; BYTES],
                result: left_result,
            })
            .await
            .unwrap();
        right
            .commands
            .send(StreamCommand::Write {
                bytes: vec![2; BYTES],
                result: right_result,
            })
            .await
            .unwrap();
        async fn receive(stream: &mut PeerStream, expected: u8) {
            let mut count = 0;
            while count < BYTES {
                let bytes = stream.incoming.recv().await.unwrap().unwrap();
                assert!(bytes.iter().all(|byte| *byte == expected));
                count += bytes.len();
            }
            assert_eq!(count, BYTES);
        }
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            let (left_ack, right_ack, _, _) = tokio::join!(
                left_done,
                right_done,
                receive(&mut left, 2),
                receive(&mut right, 1)
            );
            left_ack.unwrap().unwrap();
            right_ack.unwrap().unwrap();
        })
        .await;
        left.abort.send_replace(true);
        right.abort.send_replace(true);
        outcome.expect("simultaneous writes must not stop either reader");
    }
}
