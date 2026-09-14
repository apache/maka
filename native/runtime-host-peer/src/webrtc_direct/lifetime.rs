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

use std::{io, sync::Arc};

use tokio_util::sync::CancellationToken;
use webrtc::peer_connection::PeerConnection;

// The upgrade owns this guard until it transfers ownership to the muxer. Workers
// receive only cancellation clones, so they cannot keep the owner alive.
pub(super) struct PeerConnectionLifetime {
    pub(super) peer_connection: Arc<dyn PeerConnection>,
    pub(super) cancellation: CancellationToken,
    closed: bool,
}

impl PeerConnectionLifetime {
    pub(super) fn new(
        peer_connection: Arc<dyn PeerConnection>,
        cancellation: CancellationToken,
    ) -> Self {
        Self {
            peer_connection,
            cancellation,
            closed: false,
        }
    }

    pub(super) async fn close(&mut self) -> io::Result<()> {
        // PC close alone can leave DataChannel::poll blocked: the channel owns
        // a PC reference which retains its own event senders.
        self.cancellation.cancel();
        self.peer_connection
            .close()
            .await
            .map_err(|error| io::Error::other(error.to_string()))?;
        self.closed = true;
        Ok(())
    }
}

impl Drop for PeerConnectionLifetime {
    fn drop(&mut self) {
        self.cancellation.cancel();
        if !self.closed {
            let peer_connection = Arc::clone(&self.peer_connection);
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let _ = peer_connection.close().await;
                });
            }
        }
    }
}
