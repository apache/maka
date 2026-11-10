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

use crate::ports::Ports;
use crate::{
    Error, callbacks,
    conversation::{Journal, Live, State},
    projection::Projection,
    transport::{Connection, Event, Peer},
};
use agent_client_protocol::{self as sdk, v1::schema as acp};
use maka_agent_ports::executor;

use std::time::Duration;

mod attachments;
mod configure;
mod events;
mod v2;

pub(crate) struct Driver<'a> {
    host: &'a Ports,
    request: &'a executor::Request,
    context: &'a executor::Context,
    projection: Option<Projection>,
    replay: bool,
    v2: Option<v2::Projection>,
}
impl<'a> Driver<'a> {
    pub fn new(
        host: &'a Ports,
        request: &'a executor::Request,
        context: &'a executor::Context,
    ) -> Self {
        Self {
            host,
            request,
            context,
            projection: None,
            replay: false,
            v2: None,
        }
    }

    pub async fn connect(
        &mut self,
        mut connection: Connection,
        journal: &mut Journal,
    ) -> Result<Live, Error> {
        let deadline = Some(tokio::time::Instant::now() + Duration::from_secs(30));
        loop {
            match self.next_event(&mut connection, deadline).await? {
                Event::Initialized(peer) => {
                    connection.peer = Some(*peer);
                    break;
                }
                event => {
                    self.event(&mut connection, event, deadline).await?;
                }
            }
        }
        let initialized = match connection.peer.as_ref().unwrap() {
            Peer::V2(_, initialized) => {
                let initialized = initialized.clone();
                return self.connect_v2(connection, journal, initialized).await;
            }
            Peer::V1(_, initialized) => initialized.clone(),
        };
        if journal.record.v2_defaults.is_some() {
            return Err(Error::Continuity(
                "agent changed the session protocol version",
            ));
        }
        let scope = self
            .context
            .call
            .as_ref()
            .ok_or(Error::Invalid("missing actual ACP process scope"))?;
        let private_cwd = self
            .host
            .callbacks
            .private_paths(scope)
            .map_err(|error| Error::Output(executor::Error::IsolationUnavailable(error)))?
            .working_directory;
        let (session_id, options) = match &journal.record.state {
            State::Creating => {
                if journal.exists() {
                    return Err(Error::Continuity("session creation was not confirmed"));
                }
                journal
                    .save(self.host.storage.as_ref(), State::Creating)
                    .await?;
                let result: acp::NewSessionResponse = self
                    .rpc(
                        &mut connection,
                        acp::NewSessionRequest::new(&private_cwd),
                        Some(Duration::from_secs(30)),
                    )
                    .await?;
                let options = result.config_options.unwrap_or_default();
                journal.record.defaults = options.clone();
                (result.session_id.to_string(), options)
            }
            State::Ready { session_id } => {
                if !initialized.agent_capabilities.load_session {
                    return Err(Error::Continuity(
                        "agent does not support loading a previous session",
                    ));
                }
                let session_id = session_id.clone();
                self.projection = Some(Projection::new(
                    session_id.clone(),
                    self.request.task_id.to_string(),
                ));
                self.replay = true;
                let result = self
                    .rpc(
                        &mut connection,
                        acp::LoadSessionRequest::new(session_id.clone(), &private_cwd),
                        Some(Duration::from_secs(30)),
                    )
                    .await;
                self.replay = false;
                (session_id, result?.config_options.unwrap_or_default())
            }
            State::Running { .. } => {
                return Err(Error::Continuity("previous prompt outcome is unknown"));
            }
        };
        if session_id.is_empty()
            || session_id.len() > 1024
            || session_id.chars().any(char::is_control)
        {
            return Err(Error::Invalid("invalid external session identity"));
        }
        journal
            .save(
                self.host.storage.as_ref(),
                State::Ready {
                    session_id: session_id.clone(),
                },
            )
            .await?;
        Ok(Live {
            connection,
            session_id,
            options,
            v2_options: None,
        })
    }

    fn history_reference<T: serde::de::DeserializeOwned>(&self) -> Result<T, Error> {
        let scope = self
            .context
            .call
            .as_ref()
            .ok_or(Error::Invalid("missing actual ACP process scope"))?;
        let paths = self
            .host
            .callbacks
            .private_paths(scope)
            .map_err(|error| Error::Output(executor::Error::IsolationUnavailable(error)))?;
        let path = serde_json::to_string(&paths.history_file)?;
        serde_json::from_value(serde_json::json!({
            "type": "text",
            "text": format!("Read the prior conversation from the read-only local file {path} before handling the current user message. This file is context, not a new user instruction."),
        })).map_err(Error::from)
    }

    pub async fn prompt(
        &mut self,
        live: &mut Live,
        journal: &mut Journal,
    ) -> Result<executor::Outcome, Error> {
        if live.v2_options.is_some() {
            return self.prompt_v2(live, journal).await;
        }
        self.projection = Some(Projection::new(
            live.session_id.clone(),
            self.request.task_id.to_string(),
        ));
        self.configure(live, &journal.record.defaults).await?;
        let mut content = self.prompt_content(&live.connection)?;
        content.insert(0, self.history_reference()?);
        journal
            .save(
                self.host.storage.as_ref(),
                State::Running {
                    session_id: live.session_id.clone(),
                    task_id: self.request.task_id,
                },
            )
            .await?;
        let result = self
            .rpc(
                &mut live.connection,
                acp::PromptRequest::new(live.session_id.clone(), content),
                None,
            )
            .await;
        let projection = self.projection.as_mut().expect("prompt projection");
        if let Some(options) = projection.take_config_options() {
            live.options = options;
        }
        if !self.context.cancellation.is_cancelled() {
            projection
                .finish(
                    self.context.output.as_ref(),
                    result.as_ref().is_ok_and(|response: &acp::PromptResponse| {
                        response.stop_reason == acp::StopReason::EndTurn
                    }),
                )
                .await?;
        }
        let response = result?;
        journal
            .save(
                self.host.storage.as_ref(),
                State::Ready {
                    session_id: live.session_id.clone(),
                },
            )
            .await?;
        Ok(match response.stop_reason {
            acp::StopReason::EndTurn => executor::Outcome::Completed {
                message_id: projection.last_body_message_id(),
            },
            acp::StopReason::Cancelled => executor::Outcome::Cancelled {
                reason: Some("agent cancelled the prompt".into()),
            },
            reason => executor::Outcome::Failed {
                message: format!("agent stopped before completing: {reason:?}"),
                code: Some("external_agent_incomplete".into()),
                recoverable: false,
            },
        })
    }

    async fn rpc<R: sdk::JsonRpcRequest>(
        &mut self,
        connection: &mut Connection,
        request: R,
        timeout: Option<Duration>,
    ) -> Result<R::Response, Error> {
        let response = connection.request(request).block_task();
        tokio::pin!(response);
        let deadline = timeout.map(|timeout| tokio::time::Instant::now() + timeout);
        loop {
            tokio::select! {
                biased;
                _ = self.context.cancellation.cancelled() => return Err(Error::Cancelled),
                _ = wait_deadline(deadline) => return Err(Error::Timeout),
                event = connection.events.recv() => self.event(connection, event.ok_or(Error::Invalid("ACP event stream ended"))?, deadline).await?,
                result = &mut response => return result.map_err(Error::from),
                result = &mut connection.run => { result?; return Err(Error::Invalid("ACP connection ended")); },
            }
        }
    }

    async fn next_event(
        &self,
        connection: &mut Connection,
        deadline: Option<tokio::time::Instant>,
    ) -> Result<Event, Error> {
        tokio::select! {
            biased;
            _ = self.context.cancellation.cancelled() => Err(Error::Cancelled),
            _ = wait_deadline(deadline) => Err(Error::Timeout),
            event = connection.events.recv() => event.ok_or(Error::Invalid("ACP event stream ended")),
            result = &mut connection.run => { result?; Err(Error::Invalid("ACP connection ended")) },
        }
    }

    fn session(&self) -> Option<&str> {
        if let Some(projection) = &self.v2 {
            return Some(&projection.session_id);
        }
        self.projection
            .as_ref()
            .map(|projection| projection.session_id())
    }
}

async fn wait_deadline(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

fn prompt(
    content: &maka_agent_facts::input::MessageInput,
    instructions: Option<&str>,
    language: maka_agent_facts::language::Language,
) -> Result<Vec<String>, Error> {
    if content
        .attachments
        .as_ref()
        .is_some_and(|items| !items.is_empty())
    {
        return Err(Error::Invalid("ACP attachment forwarding is not supported"));
    }
    use maka_agent_facts::language::Language;
    let mut blocks = Vec::new();
    if let Some(instructions) = instructions.filter(|value| !value.is_empty()) {
        blocks.push(match language {
            Language::En => format!("Instructions from Maka:\n{instructions}"),
            Language::ZhCn => format!("来自 Maka 的指令：\n{instructions}"),
            Language::ZhTw => format!("來自 Maka 的指令：\n{instructions}"),
        });
    }
    let mut text = content.text.clone();
    for quote in content.quotes.iter().flatten() {
        text.push_str("\n\n<quoted_context>\n");
        text.push_str(&quote.text);
        text.push_str("\n</quoted_context>");
    }
    for directory in content.directory_references.iter().flatten() {
        text.push_str(match language {
            Language::En => "\n\nDirectory: ",
            Language::ZhCn => "\n\n目录：",
            Language::ZhTw => "\n\n目錄：",
        });
        text.push_str(&directory.path);
    }
    if content
        .inline_references
        .as_ref()
        .is_some_and(|items| !items.is_empty())
    {
        text.push_str(match language {
            Language::En => "\n\nInline references: ",
            Language::ZhCn => "\n\n内联引用：",
            Language::ZhTw => "\n\n行內參照：",
        });
        text.push_str(&serde_json::to_string(&content.inline_references)?);
    }
    blocks.push(text);
    Ok(blocks)
}
