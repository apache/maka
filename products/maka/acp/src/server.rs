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
    Error,
    client::Client,
    interaction::Capabilities,
    session::Registry,
    transport::{self, Peer},
};
use agent_client_protocol::{Agent, ConnectTo, JsonRpcResponse, Protocol, Responder};
use maka_host_runtime::application::host::Client as HostClient;
use std::{
    future::Future,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
mod input;
mod prompt;
mod v1;
mod v2;

struct Initialized {
    capabilities: Capabilities,
    peer: Peer,
}
struct App {
    client: Client,
    sessions: Registry,
    initialized: OnceLock<Initialized>,
    stop: CancellationToken,
    tasks: TaskTracker,
}
impl App {
    fn initialize(
        &self,
        capabilities: Capabilities,
        peer: Peer,
    ) -> agent_client_protocol::Result<()> {
        self.initialized
            .set(Initialized { capabilities, peer })
            .map_err(|_| {
                agent_client_protocol::Error::invalid_request().data("ACP is already initialized")
            })
    }
    fn initialized(&self) -> Result<&Initialized, Error> {
        self.initialized
            .get()
            .ok_or_else(|| "Initialize ACP before using sessions".into())
    }
    fn dispatch<T, P, F>(
        self: &Arc<Self>,
        responder: Responder<T, P>,
        work: F,
    ) -> agent_client_protocol::Result<()>
    where
        T: JsonRpcResponse + Send + 'static,
        P: Protocol,
        F: Future<Output = Result<T, Error>> + Send + 'static,
    {
        if self.stop.is_cancelled() || self.initialized.get().is_none() {
            return responder.respond_with_error(
                agent_client_protocol::Error::invalid_request()
                    .data("ACP connection is not initialized or has closed"),
            );
        }
        self.tasks.spawn(async move {
            let result = match work.await {
                Ok(value) => responder.respond(value),
                Err(error) => responder.respond_with_error(
                    agent_client_protocol::Error::invalid_params().data(error.to_string()),
                ),
            };
            if let Err(error) = result {
                eprintln!("ACP reply: {error}");
            }
        });
        Ok(())
    }
}

/// Serve ACP v1 and v2 over caller-owned streams, using only the ordinary Host client.
pub async fn serve<R, W>(
    client: HostClient,
    input: R,
    output: W,
    stop: CancellationToken,
) -> Result<(), Error>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let app = Arc::new(App {
        client: Client::new(client, stop.clone()),
        sessions: Registry::default(),
        initialized: OnceLock::new(),
        stop,
        tasks: TaskTracker::new(),
    });
    let server = Agent
        .protocol_router()
        .with_v1(v1::agent(app.clone()))
        .with_v2(v2::agent(app.clone()));
    let connection = server.connect_to(transport::lines(input, output));
    tokio::pin!(connection);
    let result = tokio::select! {
        _ = app.stop.cancelled() => Ok(()),
        result = &mut connection => result.map_err(|error| -> Error { Box::new(error) }),
    };
    app.stop.cancel();
    app.sessions.cancel_all();
    app.tasks.close();
    let settled = tokio::time::timeout(Duration::from_secs(45), async {
        app.tasks.wait().await;
        app.sessions.drained().await;
    })
    .await;
    let closed = app.client.close().await;
    settled.map_err(|_| "ACP shutdown did not settle its original Agent work")?;
    closed?;
    result
}
