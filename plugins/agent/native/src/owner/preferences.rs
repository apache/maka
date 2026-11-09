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
use maka_agent_facts::durable::BackendSpec;
use maka_agent_state::{SessionQuiescenceGuard, session_catalog::Record};
use maka_event_log::{
    StoreError,
    writeback::{Notification, Prepared, Statement},
};
use maka_plugin_core::operation::RecoveryRef;

impl Owner {
    pub(super) async fn backend_available(
        &self,
        backend: &BackendPreference,
    ) -> Result<bool, String> {
        Ok(match backend {
            BackendPreference::Model {
                connection_id,
                model_id,
                ..
            } => {
                let snapshot = {
                    let public_guard = self.catalog.snapshot.read().await;
                    public_guard
                        .as_ref()
                        .map_err(|_| "agent_configuration_unavailable")?
                        .clone()
                };
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
            BackendPreference::Executor { selection } => {
                self.executors.select(selection.clone()).is_ok()
            }
        })
    }

    pub async fn select_backend(
        self: &Arc<Self>,
        input: SelectBackend,
        _operation: &RecoveryRef,
    ) -> Result<NativeMutation<MetadataResult>, String> {
        if !self.owns(&input.session_id) {
            return Ok(metadata_rejected(Rejection::SessionUnavailable));
        }
        let ordered = Arc::new(self.runs.ordered(&input.session_id).await);
        if self.stop.is_cancelled() || self.runs.state().await.closing {
            return Ok(metadata_rejected(Rejection::Closed));
        }
        let Some(record) = self
            .canonical_catalog()?
            .record(&input.session_id)
            .await
            .map_err(|error| error.to_string())?
        else {
            return Ok(metadata_rejected(Rejection::SessionUnavailable));
        };
        if record.metadata.archived {
            return Ok(metadata_rejected(Rejection::SessionUnavailable));
        }
        let configuration: StoredSessionConfiguration =
            serde_json::from_value(record.metadata.configuration.clone())
                .map_err(|error| format!("agent_session_configuration_invalid: {error}"))?;
        if configuration.backend.as_ref() == Some(&input.backend) {
            return Ok(NativeMutation::Returned(MetadataResult::Committed {
                session: Box::new(crate::service::summary(self, record)?),
            }));
        }
        if !self.backend_available(&input.backend).await? {
            return Ok(metadata_rejected(Rejection::ToolsUnavailable));
        }
        self.prepare_configuration(record, ordered, None, move |configuration| {
            configuration.backend = Some(input.backend);
            Ok(())
        })
        .await
    }

    pub async fn remembered_backend(
        &self,
        session: &str,
    ) -> Result<Option<BackendPreference>, String> {
        self.require_session(session).await?;
        let Some((run, backend)) = self
            .durable
            .latest_message_backend(self.run_owner(), session.to_owned())
            .await
            .map_err(|error| error.to_string())?
        else {
            return Ok(None);
        };
        let preference = match &backend {
            BackendSpec::Model { descriptor, .. } => {
                let bytes = self
                    .durable
                    .content(run, descriptor.clone())
                    .await
                    .map_err(|error| error.to_string())?;
                let accepted = crate::model::AcceptedModel::from_backend(&backend, &bytes)
                    .map_err(|error| error.to_string())?;
                BackendPreference::Model {
                    connection_id: accepted.binding.connection_id,
                    model_id: accepted.binding.model,
                    thinking_level: accepted.thinking_level,
                }
            }
            BackendSpec::Executor {
                descriptor,
                selection,
            } => {
                let bytes = self
                    .durable
                    .content(run, descriptor.clone())
                    .await
                    .map_err(|error| error.to_string())?;
                let accepted: crate::executor::Accepted = serde_json::from_slice(&bytes)
                    .map_err(|error| format!("agent_executor_descriptor_invalid: {error}"))?;
                if &accepted.selection != selection {
                    return Err("agent_executor_descriptor_changed".into());
                }
                BackendPreference::Executor {
                    selection: accepted.selection,
                }
            }
            BackendSpec::Historical {} => return Err("agent_message_backend_unavailable".into()),
        };
        Ok(Some(preference))
    }

    pub(super) async fn prepare_configuration<F>(
        &self,
        mut record: Record,
        ordered: Arc<runs::Ordered>,
        guard: Option<SessionQuiescenceGuard>,
        update: F,
    ) -> Result<NativeMutation<MetadataResult>, String>
    where
        F: FnOnce(&mut StoredSessionConfiguration) -> Result<(), StoreError>
            + std::marker::Send
            + 'static,
    {
        let writer = match &guard {
            Some(guard) => guard.data_writer().clone(),
            None => self
                .store
                .data_writer()
                .map_err(|error| error.to_string())?,
        };
        let prepared = self
            .store
            .prepare_session_metadata(
                &record.metadata.id,
                record.metadata.revision,
                update,
                &writer,
                ConfigurationChange { ordered, guard },
            )
            .await;
        let (preview, change) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => return metadata_change_error(error),
        };
        let configuration = serde_json::to_value(&preview.configuration)
            .map_err(|error| format!("agent_session_configuration_invalid: {error}"))?;
        record.metadata = preview.map_configuration(|_| configuration);
        Ok(NativeMutation::Commit {
            value: MetadataResult::Committed {
                session: Box::new(crate::service::summary(self, record)?),
            },
            change,
        })
    }
}

struct ConfigurationChange {
    ordered: Arc<runs::Ordered>,
    guard: Option<SessionQuiescenceGuard>,
}
impl Statement for ConfigurationChange {
    type Value = ();
    type Output = ();
    fn retain(&self) -> Vec<Arc<dyn std::marker::Send + Sync>> {
        vec![self.ordered.clone()]
    }
    fn execute(self, connection: &rusqlite::Connection) -> Result<Prepared<()>, StoreError> {
        if let Some(guard) = self.guard {
            guard.validate(connection)?;
        }
        Ok(Prepared {
            value: (),
            changed: false,
            notification: Notification::NONE,
        })
    }
    fn committed(_: ()) {}
    fn isolated_rejection(_: &StoreError) -> bool {
        false
    }
}
fn metadata_rejected(reason: Rejection) -> NativeMutation<MetadataResult> {
    NativeMutation::Returned(MetadataResult::Rejected { reason })
}
fn metadata_change_error(error: StoreError) -> Result<NativeMutation<MetadataResult>, String> {
    Ok(match error {
        StoreError::SessionRevisionConflict { expected, actual } => {
            NativeMutation::Returned(MetadataResult::RevisionConflict { expected, actual })
        }
        StoreError::SessionBusy => metadata_rejected(Rejection::Busy),
        StoreError::SessionNotFound | StoreError::SessionRetired => {
            metadata_rejected(Rejection::SessionUnavailable)
        }
        error => return Err(format!("agent_metadata_prepare_failed: {error}")),
    })
}
