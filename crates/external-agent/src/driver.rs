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
    Error, callbacks,
    conversation::{Journal, Live, State},
    projection::Projection,
    transport::{Connection, Frame, RpcError},
};
use agent_client_protocol_schema::{ProtocolVersion, v1 as acp};
use maka_plugins::{executor, host::Services, process::Handle};
use serde::{Serialize, de::DeserializeOwned};
use std::time::Duration;

pub(crate) struct Driver<'a> {
    host: &'a Services,
    request: &'a executor::Request,
    context: &'a executor::Context,
    projection: Option<Projection>,
    replay: bool,
}
impl<'a> Driver<'a> {
    pub fn new(
        host: &'a Services,
        request: &'a executor::Request,
        context: &'a executor::Context,
    ) -> Self {
        Self {
            host,
            request,
            context,
            projection: None,
            replay: false,
        }
    }

    pub async fn connect(&mut self, handle: Handle, journal: &mut Journal) -> Result<Live, Error> {
        let mut connection = Connection::new(handle);
        let init = acp::InitializeRequest::new(ProtocolVersion::V1)
            .client_info(acp::Implementation::new("maka", env!("CARGO_PKG_VERSION")))
            .client_capabilities(
                acp::ClientCapabilities::new().fs(acp::FileSystemCapabilities::new()
                    .read_text_file(true)
                    .write_text_file(true)),
            );
        let initialized: acp::InitializeResponse = self
            .rpc(
                &mut connection,
                "initialize",
                &init,
                Duration::from_secs(30),
            )
            .await?;
        if initialized.protocol_version != ProtocolVersion::V1 {
            return Err(Error::Invalid("agent does not support ACP version 1"));
        }
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
                        "session/new",
                        &acp::NewSessionRequest::new(&self.request.cwd),
                        Duration::from_secs(30),
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
                    self.request.invocation.invocation_id.clone(),
                ));
                self.replay = true;
                let result = self
                    .rpc::<acp::LoadSessionResponse>(
                        &mut connection,
                        "session/load",
                        &acp::LoadSessionRequest::new(session_id.clone(), &self.request.cwd),
                        Duration::from_secs(30),
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
        })
    }

    pub async fn prompt(
        &mut self,
        live: &mut Live,
        journal: &mut Journal,
    ) -> Result<executor::Outcome, Error> {
        self.projection = Some(Projection::new(
            live.session_id.clone(),
            self.request.invocation.invocation_id.clone(),
        ));
        self.configure(live, &journal.record.defaults).await?;
        let content = prompt(&self.request.content, self.request.instructions.as_deref())?;
        journal
            .save(
                self.host.storage.as_ref(),
                State::Running {
                    session_id: live.session_id.clone(),
                    invocation_id: self.request.invocation.invocation_id.clone(),
                },
            )
            .await?;
        let result = self
            .rpc::<acp::PromptResponse>(
                &mut live.connection,
                "session/prompt",
                &acp::PromptRequest::new(live.session_id.clone(), content),
                Duration::from_secs(15 * 60),
            )
            .await;
        let projection = self.projection.as_mut().expect("prompt projection");
        if let Some(options) = projection.take_config_options() {
            live.options = options;
        }
        if !self.context.cancellation.is_cancelled() {
            projection.finish(self.context.output.as_ref()).await?;
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
                text: projection.text(),
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

    async fn configure(
        &mut self,
        live: &mut Live,
        defaults: &[acp::SessionConfigOption],
    ) -> Result<(), Error> {
        let thinking = self
            .request
            .settings
            .thinking_level
            .map(serde_json::to_value)
            .transpose()?;
        for (category, value) in [
            (
                acp::SessionConfigOptionCategory::Model,
                self.request.settings.model.as_deref(),
            ),
            (
                acp::SessionConfigOptionCategory::ThoughtLevel,
                thinking.as_ref().and_then(|value| value.as_str()),
            ),
        ] {
            let default = defaults
                .iter()
                .find(|option| option.category.as_ref() == Some(&category))
                .and_then(|option| match &option.kind {
                    acp::SessionConfigKind::Select(select) => {
                        Some(select.current_value.to_string())
                    }
                    _ => None,
                });
            let Some(value) = value.or(default.as_deref()) else {
                continue;
            };
            let option = live
                .options
                .iter()
                .find(|option| option.category.as_ref() == Some(&category))
                .ok_or(Error::Invalid(
                    "agent does not expose the requested setting",
                ))?;
            let acp::SessionConfigKind::Select(select) = &option.kind else {
                return Err(Error::Invalid("agent setting is not a selector"));
            };
            let valid = match &select.options {
                acp::SessionConfigSelectOptions::Ungrouped(options) => options
                    .iter()
                    .any(|option| option.value.to_string() == value),
                acp::SessionConfigSelectOptions::Grouped(groups) => groups.iter().any(|group| {
                    group
                        .options
                        .iter()
                        .any(|option| option.value.to_string() == value)
                }),
                _ => false,
            };
            if !valid {
                return Err(Error::Invalid(
                    "agent does not offer the requested setting value",
                ));
            }
            if select.current_value.to_string() == value {
                continue;
            }
            let input = acp::SetSessionConfigOptionRequest::new(
                live.session_id.clone(),
                option.id.clone(),
                acp::SessionConfigOptionValue::value_id(value.to_owned()),
            );
            let response: acp::SetSessionConfigOptionResponse = self
                .rpc(
                    &mut live.connection,
                    "session/set_config_option",
                    &input,
                    Duration::from_secs(30),
                )
                .await?;
            live.options = response.config_options;
        }
        Ok(())
    }

    async fn rpc<T: DeserializeOwned>(
        &mut self,
        connection: &mut Connection,
        method: &str,
        params: &impl Serialize,
        timeout: Duration,
    ) -> Result<T, Error> {
        self.exchange(connection, method, params, timeout).await
    }

    async fn exchange<T: DeserializeOwned>(
        &mut self,
        connection: &mut Connection,
        method: &str,
        params: &impl Serialize,
        timeout: Duration,
    ) -> Result<T, Error> {
        let expected = tokio::select! {
            biased;
            _ = self.context.cancellation.cancelled() => return Err(Error::Cancelled),
            result = tokio::time::timeout(timeout, connection.request(method, params)) => result.map_err(|_| Error::Timeout)??,
        };
        loop {
            let frame = tokio::select! {
                biased;
                _ = self.context.cancellation.cancelled() => return Err(Error::Cancelled),
                result = tokio::time::timeout(timeout, connection.next()) => match result {
                    Ok(result) => result?,
                    Err(_) => {
                        if method == "session/prompt" && let Some(session) = self.session() {
                            // Best effort protocol notification, followed by owner-confirmed
                            // process shutdown. Never extend expired execution authority.
                            let _ = tokio::time::timeout(Duration::from_secs(1), connection.notify("session/cancel", &acp::CancelNotification::new(session.to_owned()))).await;
                        }
                        return Err(Error::Timeout);
                    }
                },
            };
            match frame {
                Frame::Stderr { .. } => {}
                Frame::Response { id, result } => {
                    if id != expected {
                        return Err(Error::Invalid(
                            "response does not match the outstanding request",
                        ));
                    }
                    let value = result.map_err(|error| Error::Remote {
                        code: error.code,
                        message: error.message,
                    })?;
                    return Ok(serde_json::from_value(value)?);
                }
                Frame::Notification { method, params } if method == "session/update" => {
                    let update: acp::SessionNotification = serde_json::from_value(params)?;
                    if self.replay {
                        if Some(update.session_id.to_string()).as_deref() != self.session() {
                            return Err(Error::Invalid(
                                "replayed update belongs to another session",
                            ));
                        }
                    } else if let Some(projection) = &mut self.projection {
                        projection
                            .update(update, self.context.output.as_ref())
                            .await?;
                    } else {
                        return Err(Error::Invalid(
                            "session update before session establishment",
                        ));
                    }
                }
                Frame::Notification { .. } => {}
                Frame::Request { id, method, params } => {
                    let result = if let Some(session) = self.session() {
                        callbacks::handle(
                            &method,
                            params,
                            session,
                            self.request,
                            self.context,
                            self.host,
                            &id,
                        )
                        .await
                        .map_err(|error| RpcError {
                            code: i64::from(error.code),
                            message: error.message,
                            data: None,
                        })
                    } else {
                        Err(RpcError {
                            code: -32000,
                            message: "no active session".into(),
                            data: None,
                        })
                    };
                    connection.respond(id, result).await?;
                }
            }
        }
    }

    fn session(&self) -> Option<&str> {
        self.projection
            .as_ref()
            .map(|projection| projection.session_id())
    }
}

fn prompt(
    content: &maka_runtime::input::MessageInput,
    instructions: Option<&str>,
) -> Result<Vec<acp::ContentBlock>, Error> {
    if content
        .attachments
        .as_ref()
        .is_some_and(|items| !items.is_empty())
    {
        return Err(Error::Invalid("ACP attachment forwarding is not supported"));
    }
    let mut blocks = Vec::new();
    if let Some(instructions) = instructions.filter(|value| !value.is_empty()) {
        blocks.push(acp::ContentBlock::Text(acp::TextContent::new(format!(
            "Instructions from Maka:\n{instructions}"
        ))));
    }
    let mut text = content.text.clone();
    for quote in content.quotes.iter().flatten() {
        text.push_str("\n\n<quoted_context>\n");
        text.push_str(&quote.text);
        text.push_str("\n</quoted_context>");
    }
    for directory in content.directory_references.iter().flatten() {
        text.push_str("\n\nDirectory: ");
        text.push_str(&directory.path);
    }
    if content
        .inline_references
        .as_ref()
        .is_some_and(|items| !items.is_empty())
    {
        text.push_str("\n\nInline references: ");
        text.push_str(&serde_json::to_string(&content.inline_references)?);
    }
    blocks.push(acp::ContentBlock::Text(acp::TextContent::new(text)));
    Ok(blocks)
}
