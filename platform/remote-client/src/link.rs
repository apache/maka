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
    RemoteClientError, RemoteHostConnection,
    client::{BoxedStream, WsByteChannel},
};
use maka_remote_transport::{
    PathSummary, PeerConnection, PeerEndpoint, TlsTrust, websocket::WebSocketEndpoint,
};
use std::sync::Arc;

#[derive(Clone)]
pub(crate) enum Link {
    Peer(Arc<PeerLink>),
    WebSocket(Arc<WebSocketLink>),
}

pub(crate) struct PeerLink {
    // The endpoint must remain alive for the lifetime of its connection.
    _endpoint: PeerEndpoint,
    connection: PeerConnection,
}

impl PeerLink {
    pub(crate) async fn wait_for_disconnect(&self) -> RemoteClientError {
        RemoteClientError::Transport(Box::new(self.connection.closed().await))
    }
}

impl Drop for PeerLink {
    fn drop(&mut self) {
        self.connection.close();
    }
}

pub(crate) struct WebSocketLink {
    endpoint: WebSocketEndpoint,
    bearer: Arc<str>,
}

impl Link {
    pub(crate) fn peer(endpoint: PeerEndpoint, connection: PeerConnection) -> Self {
        Self::Peer(Arc::new(PeerLink {
            _endpoint: endpoint,
            connection,
        }))
    }

    pub(crate) async fn open(&self) -> Result<BoxedStream, RemoteClientError> {
        Ok(match self {
            Self::Peer(peer) => Box::new(
                peer.connection
                    .open_bi()
                    .await
                    .map_err(RemoteClientError::Transport)?,
            ),
            Self::WebSocket(ws) => {
                let socket = ws
                    .endpoint
                    .open(Some(&ws.bearer))
                    .await
                    .map_err(RemoteClientError::Transport)?;
                Box::new(WsByteChannel::new(socket))
            }
        })
    }

    pub(crate) fn path_summary(&self) -> Option<PathSummary> {
        match self {
            Self::Peer(peer) => peer.connection.path_summary(),
            Self::WebSocket(_) => None,
        }
    }
}

impl RemoteHostConnection {
    /// Open a new session using an explicitly provisioned WebSocket Bearer.
    /// Signed native-peer invitations are not WebSocket credentials.
    pub async fn connect_websocket(
        endpoint: &str,
        trust: TlsTrust,
        bearer: Arc<str>,
        root_id: &str,
        client_instance: Arc<str>,
    ) -> Result<Self, RemoteClientError> {
        if bearer.trim().is_empty() {
            return Err(RemoteClientError::EmptyField("bearer"));
        }
        let endpoint =
            WebSocketEndpoint::new(endpoint, trust).map_err(RemoteClientError::Transport)?;
        let link = Link::WebSocket(Arc::new(WebSocketLink { endpoint, bearer }));
        Self::connect(link, root_id, client_instance).await
    }
}
