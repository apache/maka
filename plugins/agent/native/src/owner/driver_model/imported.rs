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

//! Imported historical observations read only through their bound copied snapshot.
use super::*;
use maka_agent_facts::{
    history_snapshot::{HistoricalRole, ImportedPart, ImportedProviderMetadata},
    language::Language,
};
use maka_agent_state::{artifacts::SessionScope, session_history::snapshot::Snapshot};
use std::io::BufReader;

impl DriverModel {
    pub(super) async fn imported_messages(
        &self,
        target: ReplayTarget<'_>,
        snapshot: &Snapshot,
        path: &[RunId],
        vision: bool,
        language: Language,
        messages: &mut preparation::PromptBuilder,
    ) -> Result<(), RunError> {
        let mut after = None;
        loop {
            let page = snapshot.imported(after, 256).await?;
            for (ordinal, message) in page.items {
                if self.cancellation.is_cancelled() {
                    return Err(RunError::Cancelled);
                }
                if let Some(reference) = &message.provider_metadata {
                    let metadata: ImportedProviderMetadata = snapshot
                        .with_imported_content(ordinal, reference, |reader| {
                            Ok(serde_json::from_reader(BufReader::new(reader)))
                        })
                        .await?
                        .map_err(RunError::Json)?;
                    if metadata.version != 1 {
                        return Err(RunError::InvalidInput(
                            "unsupported imported provider metadata version".into(),
                        ));
                    }
                    metadata
                        .source
                        .validate()
                        .map_err(|reason| RunError::InvalidInput(reason.into()))?;
                }
                let scope = SessionScope {
                    owner: message.artifact_scope.owner,
                    session: message.artifact_scope.session,
                };
                let mut assistant = Vec::new();
                for (part_ordinal, reference) in message.parts.iter().enumerate() {
                    if self.cancellation.is_cancelled() {
                        return Err(RunError::Cancelled);
                    }
                    if message.role == HistoricalRole::Tool {
                        if let Some((call_id, name, output)) = self
                            .archived_imported_tool_result(
                                snapshot,
                                path,
                                ordinal,
                                part_ordinal as u64,
                                reference,
                            )
                            .await?
                        {
                            flush_assistant(messages, &mut assistant).await?;
                            messages
                                .append(Message::tool(call_id, name, output))
                                .await?;
                            continue;
                        }
                    }
                    let part: ImportedPart = snapshot
                        .with_imported_content(ordinal, reference, |reader| {
                            Ok(serde_json::from_reader(BufReader::new(reader)))
                        })
                        .await?
                        .map_err(RunError::Json)?;
                    match part {
                        ImportedPart::Input { content } => {
                            if !matches!(
                                message.role,
                                HistoricalRole::User
                                    | HistoricalRole::System
                                    | HistoricalRole::Context
                            ) {
                                return Err(RunError::InvalidInput("imported input part requires user, system or context historical role".into()));
                            }
                            flush_assistant(messages, &mut assistant).await?;
                            let mut projected = preparation::project_input_from(
                                preparation::MediaSource::Snapshot {
                                    snapshot,
                                    scope: scope.clone().into(),
                                },
                                &content,
                                language,
                                vision,
                                false,
                                None,
                                &self.resources,
                                &self.cancellation,
                            )
                            .await?;
                            if matches!(
                                message.role,
                                HistoricalRole::System | HistoricalRole::Context
                            ) {
                                let Message::User {
                                    provider_options, ..
                                } = &mut projected
                                else {
                                    return Err(RunError::Internal(
                                        "imported input projector returned a non-user message"
                                            .into(),
                                    ));
                                };
                                maka_agent_facts::model::merge_provider_options(
                                    provider_options,
                                    Some(
                                        json!({"maka":{"imported":{"originalRole":message.role}}}),
                                    ),
                                );
                            }
                            messages.append(projected).await?;
                        }
                        ImportedPart::Model { part } => {
                            if message.role != HistoricalRole::Assistant {
                                return Err(RunError::InvalidInput(
                                    "imported model part requires assistant historical role".into(),
                                ));
                            }
                            if let Some(part) = target.part(&part, "", None)? {
                                assistant.push(part);
                            }
                        }
                        ImportedPart::ToolReturn {
                            call_id,
                            name,
                            result,
                        } => {
                            if message.role != HistoricalRole::Tool {
                                return Err(RunError::InvalidInput(
                                    "imported tool return requires tool historical role".into(),
                                ));
                            }
                            result.validate().map_err(|reason| {
                                RunError::InvalidInput(format!(
                                    "invalid imported tool return: {reason}"
                                ))
                            })?;
                            flush_assistant(messages, &mut assistant).await?;
                            let output = preparation::project_returned_tool_from(
                                preparation::MediaSource::Snapshot {
                                    snapshot,
                                    scope: scope.clone().into(),
                                },
                                &result.body,
                                language,
                                vision,
                                &self.resources,
                                &self.cancellation,
                            )
                            .await?;
                            messages
                                .append(Message::tool(call_id, name, output))
                                .await?;
                        }
                    }
                }
                flush_assistant(messages, &mut assistant).await?;
            }
            match page.next {
                Some(next) => after = Some(next),
                None => break,
            }
        }
        Ok(())
    }
}
