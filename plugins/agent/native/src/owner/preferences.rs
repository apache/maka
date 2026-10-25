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

use super::*;
use maka_event_log::sessions::SessionMutation;

impl Owner {
    pub async fn select_backend(&self, input: SelectBackend) -> Result<MetadataResult, String> {
        let runs = self.runs.lock().await;
        if runs.closing {
            return Ok(MetadataResult::Rejected {
                reason: Rejection::Closed,
            });
        }
        if !self.owns(&input.session_id) {
            return Ok(MetadataResult::Rejected {
                reason: Rejection::SessionUnavailable,
            });
        }
        let session = self.session(&input.session_id).await?;
        if session.archived {
            return Ok(MetadataResult::Rejected {
                reason: Rejection::SessionUnavailable,
            });
        }
        // Replaying the same preference is harmless even if a read marker or
        // execution advanced the session revision in the meantime.
        if session.configuration.backend.as_ref() == Some(&input.backend) {
            return Ok(MetadataResult::Committed {
                session: Box::new(crate::service::summary(self, session)),
            });
        }
        let available = match &input.backend {
            BackendPreference::Model {
                connection_id,
                model_id,
                ..
            } => {
                let public_guard = self.catalog.snapshot.read().await;
                let snapshot = public_guard
                    .as_ref()
                    .map_err(|_| "agent_configuration_unavailable")?
                    .clone();
                self.configuration
                    .catalog()
                    .await
                    .map_err(|_| "agent_configuration_unavailable")?
                    .connections
                    .iter()
                    .any(|row| {
                        row.connection_id == *connection_id
                            && row.enabled
                            && row.enabled_model_ids.contains(model_id)
                            && maka_providers::definition(&row.provider, snapshot.clone()).is_ok()
                    })
            }
            BackendPreference::Executor { selection } => self
                .settings
                .executors
                .iter()
                .any(|entry| entry.name == selection.executor),
        };
        if !available {
            return Ok(MetadataResult::Rejected {
                reason: Rejection::ToolsUnavailable,
            });
        }
        match self
            .store
            .update_session_metadata(
                &input.session_id,
                session.revision,
                move |configuration: &mut StoredSessionConfiguration| {
                    configuration.backend = Some(input.backend);
                    Ok(())
                },
            )
            .await
            .map_err(|_| "agent_preference_commit_unknown")?
        {
            SessionMutation::Committed(session) => Ok(MetadataResult::Committed {
                session: Box::new(crate::service::summary(self, resolve_session(*session)?)),
            }),
            SessionMutation::RevisionConflict { expected, actual } => {
                Ok(MetadataResult::RevisionConflict { expected, actual })
            }
        }
    }

    pub async fn remembered_backend(
        &self,
        session: &str,
    ) -> Result<Option<BackendPreference>, String> {
        // Direct sends need not save a picker preference. Recover their last
        // admitted model identity without substituting a global default.
        let opening = self
            .store
            .session(session)
            .await
            .map_err(|error| error.to_string())?
            .latest_message_opening(session)
            .await
            .map_err(|_| "agent_history_unavailable")?;
        Ok(opening.and_then(|opening| match opening.event.fact {
            maka_agent_facts::event::Fact::InvocationOpened {
                configuration: Some(configuration),
                ..
            } => configuration.model.map(|model| BackendPreference::Model {
                connection_id: model.connection_id,
                model_id: model.model,
                thinking_level: configuration.thinking_level,
            }),
            _ => None,
        }))
    }
}
