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
    Error, content,
    observation::Routes,
    session::Registry,
    transport::{self, Peer},
};
use agent_client_protocol::{
    Agent, Client as AcpClient, JsonRpcResponse, Responder, V2ConnectionTo,
    schema::{ProtocolVersion, v2 as acp},
};
use maka_client::{Client, Notification};
use std::{
    future::Future,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::{Semaphore, mpsc},
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
mod input;
mod prompt;

struct App {
    client: Client,
    sessions: Registry,
    capabilities: OnceLock<acp::ClientCapabilities>,
    routes: Routes,
    stop: CancellationToken,
    tasks: TaskTracker,
    requests: Arc<Semaphore>,
}
impl App {
    fn peer(&self, connection: V2ConnectionTo<AcpClient>) -> Peer {
        Peer {
            connection,
            stop: self.stop.clone(),
        }
    }
    fn initialized(&self) -> Result<acp::ClientCapabilities, Error> {
        self.capabilities
            .get()
            .cloned()
            .ok_or_else(|| "Initialize ACP before using sessions".into())
    }
    fn dispatch<T, F>(
        self: &Arc<Self>,
        responder: Responder<T>,
        work: F,
    ) -> agent_client_protocol::Result<()>
    where
        T: JsonRpcResponse + Send + 'static,
        F: Future<Output = Result<T, Error>> + Send + 'static,
    {
        if self.stop.is_cancelled() || self.capabilities.get().is_none() {
            return responder.respond_with_error(
                agent_client_protocol::Error::invalid_request()
                    .data("ACP connection is not initialized or has closed"),
            );
        }
        let Ok(permit) = self.requests.clone().try_acquire_owned() else {
            return responder.respond_with_error(
                agent_client_protocol::Error::internal_error()
                    .data("ACP concurrent request limit reached"),
            );
        };
        self.tasks.spawn(async move {
            let _permit = permit;
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

/// Serve ACP over caller-owned streams, using only the ordinary Host client.
pub async fn serve<R, W>(
    client: Client,
    mut notifications: mpsc::Receiver<Notification>,
    input: R,
    output: W,
    stop: CancellationToken,
) -> Result<(), Error>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let app = Arc::new(App {
        client,
        sessions: Registry::default(),
        capabilities: OnceLock::new(),
        routes: Routes::default(),
        stop,
        tasks: TaskTracker::new(),
        requests: Arc::new(Semaphore::new(32)),
    });
    let init = app.clone();
    let create = app.clone();
    let list = app.clone();
    let resume = app.clone();
    let close = app.clone();
    let config = app.clone();
    let prompt = app.clone();
    let cancel = app.clone();
    let closed = app.clone();
    let server = Agent
        .v2()
        .name("maka")
        .on_receive_dispatch(
            async |message: agent_client_protocol::Dispatch, _cx: V2ConnectionTo<AcpClient>| {
                input::validate(message)
            },
            agent_client_protocol::on_receive_dispatch!(),
        )
        .on_receive_request(
            async move |request: acp::InitializeRequest,
                        responder: Responder<acp::InitializeResponse>,
                        _cx: V2ConnectionTo<AcpClient>| {
                if request.protocol_version != ProtocolVersion::V2 {
                    return responder.respond_with_error(
                        agent_client_protocol::Error::invalid_params()
                            .data("Maka ACP requires protocol version 2"),
                    );
                }
                if init.capabilities.set(request.capabilities).is_err() {
                    return responder.respond_with_error(
                        agent_client_protocol::Error::invalid_request()
                            .data("ACP is already initialized"),
                    );
                }
                responder.respond(
                    acp::InitializeResponse::new(
                        ProtocolVersion::V2,
                        acp::Implementation::new("maka", env!("CARGO_PKG_VERSION")),
                    )
                    .capabilities(
                        acp::AgentCapabilities::new().session(
                            acp::SessionCapabilities::new().prompt(content::capabilities()),
                        ),
                    ),
                )
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: acp::NewSessionRequest,
                        responder: Responder<acp::NewSessionResponse>,
                        cx: V2ConnectionTo<AcpClient>| {
                let app = create.clone();
                create.dispatch(responder, async move {
                    app.sessions
                        .create(&app.client, &app.peer(cx), request)
                        .await
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: acp::ListSessionsRequest,
                        responder: Responder<acp::ListSessionsResponse>,
                        _cx: V2ConnectionTo<AcpClient>| {
                let app = list.clone();
                list.dispatch(responder, async move {
                    app.sessions.list(&app.client, request).await
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: acp::ResumeSessionRequest,
                        responder: Responder<acp::ResumeSessionResponse>,
                        cx: V2ConnectionTo<AcpClient>| {
                let app = resume.clone();
                resume.dispatch(responder, async move {
                    app.sessions
                        .resume(&app.client, &app.peer(cx), request)
                        .await
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: acp::CloseSessionRequest,
                        responder: Responder<acp::CloseSessionResponse>,
                        _cx: V2ConnectionTo<AcpClient>| {
                let app = close.clone();
                close.dispatch(responder, async move { app.sessions.close(request).await })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: acp::SetSessionConfigOptionRequest,
                        responder: Responder<acp::SetSessionConfigOptionResponse>,
                        cx: V2ConnectionTo<AcpClient>| {
                let app = config.clone();
                config.dispatch(responder, async move {
                    app.sessions
                        .set_config(&app.client, &app.peer(cx), request)
                        .await
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: acp::PromptRequest,
                        responder: Responder<acp::PromptResponse>,
                        cx: V2ConnectionTo<AcpClient>| {
                prompt::dispatch(prompt.clone(), request, responder, cx)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_notification(
            async move |request: acp::CancelSessionNotification, _cx: V2ConnectionTo<AcpClient>| {
                if let Ok(session) = cancel.sessions.get(&request.session_id.to_string()) {
                    session.cancel();
                }
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_close(async move |_cx| {
            closed.stop.cancel();
            closed.sessions.cancel_all();
            Ok(())
        });
    let connection = server.connect_to(transport::lines(input, output));
    tokio::pin!(connection);
    let result = loop {
        tokio::select! {
            _ = app.stop.cancelled() => break Ok(()),
            result = &mut connection => break result.map_err(|error| -> Error { Box::new(error) }),
            notification = notifications.recv() => {
                match notification {
                    Some(Notification::Observation(frame)) => {
                        if let Err(error) = app.routes.dispatch(*frame) { break Err(error); }
                    }
                    Some(Notification::Catalog(_)) => {}
                    None => break Err("Host connection closed".into()),
                }
            }
        }
    };
    app.stop.cancel();
    app.sessions.cancel_all();
    app.tasks.close();
    let settled = tokio::time::timeout(Duration::from_secs(45), async {
        let cleanup = async { app.tasks.wait().await; app.sessions.drained().await; };
        tokio::pin!(cleanup);
        let mut incoming_open = true;
        loop {
            tokio::select! {
                _ = &mut cleanup => break,
                notification = notifications.recv(), if incoming_open => { incoming_open = notification.is_some(); }
            }
        }
    }).await;
    app.client.disconnect();
    settled.map_err(|_| "ACP shutdown did not settle its Host operations")?;
    result
}
