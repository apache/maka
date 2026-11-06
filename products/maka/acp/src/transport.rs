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
    interaction::{Callback, Response},
};
use agent_client_protocol::{
    Client, Lines,
    v1::schema as v1_wire,
    v2::{ConnectionTo, schema as acp},
};
pub(crate) mod v1;
pub(crate) mod v2;

use futures_util::{StreamExt, sink};
use std::{
    collections::HashMap,
    io,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio_util::{
    codec::{FramedRead, LinesCodec},
    sync::CancellationToken,
};

const MAX_LINE: usize = 8 * 1024 * 1024;

/// SDK owns JSON-RPC framing, correlation and dispatch; this adapter bounds I/O.
pub(crate) fn lines<R, W>(
    input: R,
    output: W,
) -> impl agent_client_protocol::ConnectTo<agent_client_protocol::Agent>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let incoming = FramedRead::new(input, LinesCodec::new_with_max_length(MAX_LINE))
        .map(|line| line.map_err(io::Error::other));
    let outgoing = sink::unfold(output, async |mut output, line: String| {
        if line.len() > MAX_LINE {
            return Err(io::Error::other("ACP output exceeds frame limit"));
        }
        tokio::time::timeout(Duration::from_secs(15), async {
            output.write_all(line.as_bytes()).await?;
            output.write_all(b"\n").await?;
            output.flush().await
        })
        .await??;
        Ok(output)
    });
    Lines::new(outgoing, incoming)
}

#[derive(Clone)]
pub(crate) struct Peer {
    connection: Connection,
    pub stop: CancellationToken,
}
#[derive(Clone)]
enum Connection {
    V1 {
        client: agent_client_protocol::v1::ConnectionTo<Client>,
        projections: Arc<Mutex<HashMap<String, v1::Projection>>>,
    },
    V2(ConnectionTo<Client>),
}
impl Peer {
    pub fn v1(
        client: agent_client_protocol::v1::ConnectionTo<Client>,
        stop: CancellationToken,
    ) -> Self {
        Self {
            connection: Connection::V1 {
                client,
                projections: Default::default(),
            },
            stop,
        }
    }
    pub fn v2(client: ConnectionTo<Client>, stop: CancellationToken) -> Self {
        Self {
            connection: Connection::V2(client),
            stop,
        }
    }
    pub fn reset(&self, session: &str) {
        if let Connection::V1 { projections, .. } = &self.connection {
            projections.lock().unwrap().remove(session);
        }
    }
    pub async fn update(
        &self,
        session: &str,
        update: crate::presentation::Update,
    ) -> Result<(), Error> {
        if self.stop.is_cancelled() {
            return Err("ACP connection closed".into());
        }
        match &self.connection {
            Connection::V1 {
                client,
                projections,
            } => {
                let update = projections
                    .lock()
                    .unwrap()
                    .entry(session.into())
                    .or_default()
                    .update(update)?;
                if let Some(update) = update {
                    client.send_notification(v1_wire::SessionNotification::new(
                        session.to_owned(),
                        update,
                    ))?;
                }
            }
            Connection::V2(client) => {
                client.send_notification(acp::UpdateSessionNotification::new(
                    session.to_owned(),
                    v2::update(update),
                ))?;
            }
        }
        Ok(())
    }
    pub async fn state(
        &self,
        session: &str,
        state: crate::presentation::State,
    ) -> Result<(), Error> {
        if let Connection::V2(client) = &self.connection {
            client.send_notification(acp::UpdateSessionNotification::new(
                session.to_owned(),
                acp::SessionUpdate::StateUpdate(match state {
                    crate::presentation::State::Running => {
                        acp::StateUpdate::Running(acp::RunningStateUpdate::new())
                    }
                    crate::presentation::State::RequiresAction => {
                        acp::StateUpdate::RequiresAction(acp::RequiresActionStateUpdate::new())
                    }
                }),
            ))?;
        }
        Ok(())
    }
    pub async fn synchronize(
        &self,
        session: &maka_agent_api::contract::Session,
    ) -> Result<(), Error> {
        if let Connection::V2(client) = &self.connection {
            client.send_notification(acp::UpdateSessionNotification::new(
                session.id.clone(),
                acp::SessionUpdate::StateUpdate(
                    acp::StateUpdate::Idle(acp::IdleStateUpdate::new()),
                ),
            ))?;
            client.send_notification(acp::UpdateSessionNotification::new(
                session.id.clone(),
                acp::SessionUpdate::SessionInfoUpdate(
                    acp::SessionInfoUpdate::new().title(session.title.clone()),
                ),
            ))?;
        }
        Ok(())
    }
    pub async fn complete(
        &self,
        session: &str,
        result: Result<crate::presentation::Completion, Error>,
    ) -> Result<(), Error> {
        use crate::presentation::Completion;
        if let Connection::V2(client) = &self.connection {
            let reason = match result {
                Ok(Completion::Completed) => acp::StopReason::EndTurn,
                Ok(Completion::Cancelled) => acp::StopReason::Cancelled,
                Ok(Completion::Paused) => acp::StopReason::Other(acp::OtherStopReason::new(
                    "_maka_paused",
                    Default::default(),
                )),
                result => acp::StopReason::Error(acp::ErrorStopReason::new().error(
                    acp::Error::internal_error().data(match result {
                        Err(e) => e.to_string(),
                        _ => "Agent execution failed; see transcript".into(),
                    }),
                )),
            };
            client.send_notification(acp::UpdateSessionNotification::new(
                session.to_owned(),
                acp::SessionUpdate::StateUpdate(acp::StateUpdate::Idle(
                    acp::IdleStateUpdate::new().stop_reason(reason),
                )),
            ))?;
        }
        self.reset(session);
        Ok(())
    }
    pub async fn config(
        &self,
        session: &str,
        options: Vec<crate::configuration::Select>,
    ) -> Result<(), Error> {
        match &self.connection {
            Connection::V1 { client, .. } => {
                client.send_notification(v1_wire::SessionNotification::new(
                    session.to_owned(),
                    v1_wire::SessionUpdate::ConfigOptionUpdate(v1_wire::ConfigOptionUpdate::new(
                        v1::config(options),
                    )),
                ))?;
            }
            Connection::V2(client) => {
                client.send_notification(acp::UpdateSessionNotification::new(
                    session.to_owned(),
                    acp::SessionUpdate::ConfigOptionUpdate(acp::ConfigOptionUpdate::new(
                        v2::config(options),
                    )),
                ))?;
            }
        }
        Ok(())
    }
    pub async fn request(
        &self,
        callback: Callback,
        cancel: &CancellationToken,
    ) -> Result<Response, Error> {
        tokio::select! {
            _ = self.stop.cancelled() => Err("ACP connection closed".into()),
            _ = cancel.cancelled() => Err("ACP interaction cancelled".into()),
            result = async {
                Ok(match (&self.connection,callback) {
                    (Connection::V1 { client, .. }, Callback::Permission(offer)) => Response::Permission(v1::permission_answer(client.send_request(v1::permission(offer)).block_task().await?)?),
                    (Connection::V2(client), Callback::Permission(offer)) => Response::Permission(v2::permission_answer(client.send_request(v2::permission(offer)).block_task().await?)?),
                    (Connection::V1 { client, .. }, Callback::Elicitation(input)) => Response::Elicitation(v1::form_answer(client.send_request(v1::form(input)?).block_task().await?)?),
                    (Connection::V2(client), Callback::Elicitation(input)) => Response::Elicitation(v2::form_answer(client.send_request(v2::form(input)?).block_task().await?)?),
                })
            } => result,
        }
    }
}
