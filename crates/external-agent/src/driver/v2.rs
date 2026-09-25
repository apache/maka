// Licensed to the Apache Software Foundation (ASF) under one
// or more contributor license agreements. See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership. The ASF licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License. You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.

use super::*;
pub(super) use crate::projection::v2::Projection;
use agent_client_protocol::schema::v2 as acp;

impl Driver<'_> {
    pub(super) async fn connect_v2(
        &mut self,
        mut connection: Connection,
        journal: &mut Journal,
        initialized: acp::InitializeResponse,
    ) -> Result<Live, Error> {
        if initialized.capabilities.session.is_none() {
            return Err(Error::Invalid("ACP v2 peer does not support sessions"));
        }
        if journal.exists() && journal.record.v2_defaults.is_none() {
            return Err(Error::Continuity(
                "agent changed the session protocol version",
            ));
        }
        let (session_id, options) = match &journal.record.state {
            State::Creating => {
                if journal.exists() {
                    return Err(Error::Continuity("session creation was not confirmed"));
                }
                journal.record.v2_defaults = Some(vec![]);
                journal
                    .save(self.host.storage.as_ref(), State::Creating)
                    .await?;
                let result: acp::NewSessionResponse = self
                    .rpc(
                        &mut connection,
                        acp::NewSessionRequest::new(&self.request.cwd),
                        Duration::from_secs(30),
                    )
                    .await?;
                journal.record.v2_defaults = Some(result.config_options.clone());
                (result.session_id.to_string(), result.config_options)
            }
            State::Ready { session_id } => {
                let session_id = session_id.clone();
                self.v2 = Some(Projection::new(
                    session_id.clone(),
                    self.request.invocation.invocation_id.clone(),
                ));
                // No replay cursor: retained history must not become this invocation's output.
                self.replay = true;
                let result = self
                    .rpc(
                        &mut connection,
                        acp::ResumeSessionRequest::new(session_id.clone(), &self.request.cwd),
                        Duration::from_secs(30),
                    )
                    .await;
                self.replay = false;
                (session_id, result?.config_options)
            }
            State::Running { .. } => {
                return Err(Error::Continuity("previous prompt outcome is unknown"));
            }
        };
        crate::projection::v2::identity(&session_id)?;
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
            options: vec![],
            v2_options: Some(options),
        })
    }

    pub(super) async fn prompt_v2(
        &mut self,
        live: &mut Live,
        journal: &mut Journal,
    ) -> Result<executor::Outcome, Error> {
        self.v2 = Some(Projection::new(
            live.session_id.clone(),
            self.request.invocation.invocation_id.clone(),
        ));
        self.configure_v2(
            live,
            journal.record.v2_defaults.as_deref().unwrap_or_default(),
        )
        .await?;
        // Discard idle/state updates from configuration before admitting this prompt.
        self.v2 = Some(Projection::new(
            live.session_id.clone(),
            self.request.invocation.invocation_id.clone(),
        ));
        let content = super::prompt(&self.request.content, self.request.instructions.as_deref())?
            .into_iter()
            .map(|text| acp::ContentBlock::Text(acp::TextContent::new(text)))
            .collect();
        journal
            .save(
                self.host.storage.as_ref(),
                State::Running {
                    session_id: live.session_id.clone(),
                    invocation_id: self.request.invocation.invocation_id.clone(),
                },
            )
            .await?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15 * 60);
        let result = async {
            let accepted = self
                .rpc(
                    &mut live.connection,
                    acp::PromptRequest::new(live.session_id.clone(), content),
                    Duration::from_secs(15 * 60),
                )
                .await?;
            self.v2
                .as_mut()
                .unwrap()
                .accept(accepted.message_id.to_string())?;
            while !self.v2.as_ref().unwrap().completed() {
                let event = self.next_event(&mut live.connection, deadline).await?;
                self.event(&mut live.connection, event, deadline).await?;
            }
            Ok::<(), Error>(())
        }
        .await;
        let projection = self.v2.as_mut().unwrap();
        if let Some(options) = projection.options.take() {
            live.v2_options = Some(options);
        }
        if !self.context.cancellation.is_cancelled() {
            projection
                .finish(self.context.output.as_ref(), result.is_ok())
                .await?;
        }
        result?;
        journal
            .save(
                self.host.storage.as_ref(),
                State::Ready {
                    session_id: live.session_id.clone(),
                },
            )
            .await?;
        Ok(match projection.stop_reason.as_ref() {
            None | Some(acp::StopReason::EndTurn) => executor::Outcome::Completed {
                text: projection.text(),
            },
            Some(acp::StopReason::Cancelled) => executor::Outcome::Cancelled {
                reason: Some("agent cancelled the prompt".into()),
            },
            Some(reason) => executor::Outcome::Failed {
                message: format!("agent stopped before completing: {reason:?}"),
                code: Some("external_agent_incomplete".into()),
                recoverable: false,
            },
        })
    }

    async fn configure_v2(
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
        for (category, desired) in [
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
            let Some(value) = desired.or(default.as_deref()) else {
                continue;
            };
            let option = live
                .v2_options
                .as_ref()
                .unwrap()
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
                option.config_id.clone(),
                acp::SessionConfigOptionValue::Id {
                    value: value.to_owned().into(),
                },
            );
            let response: acp::SetSessionConfigOptionResponse = self
                .rpc(&mut live.connection, input, Duration::from_secs(30))
                .await?;
            live.v2_options = Some(response.config_options);
        }
        Ok(())
    }
}
