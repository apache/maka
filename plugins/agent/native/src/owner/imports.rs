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

//! Explicit source reads and one atomic publication into this Agent's history.
use super::*;
use maka_capabilities::call::Scope;
use maka_event_log::{StoreError, root_store::DataWriter};
use maka_plugin_core::operation::{OperationOutcome, OperationResult, RecoveryRef};
use maka_plugin_core::storage::Data;
use maka_plugin_core::storage::Mutation;
use maka_plugin_core::storage::Namespace;
use maka_session_import::{catalog, source};

mod access;
mod capture;
mod copy;
mod history_source;
mod preview;
use access::SourceRead;

#[derive(Clone, Copy)]
enum Failure {
    Changed,
    Unavailable,
    Invalid,
    Unknown,
}
impl From<maka_session_import::Error> for Failure {
    fn from(error: maka_session_import::Error) -> Self {
        use maka_session_import::Error;
        tracing::warn!(stage = "session_import_source", error = ?error, "Source import read failed");
        match error {
            Error::Invalid(_)
            | Error::Decode { .. }
            | Error::Json(_)
            | Error::Encoding(_)
            | Error::Unsupported(_) => Self::Invalid,
            _ => Self::Unavailable,
        }
    }
}
impl Failure {
    fn page(self) -> ImportsPage {
        match self {
            Self::Changed => ImportsPage::Changed,
            Self::Invalid => ImportsPage::Invalid,
            Self::Unavailable | Self::Unknown => ImportsPage::Unavailable,
        }
    }
    fn result(self) -> Result<ImportResult, String> {
        Ok(match self {
            Self::Changed => ImportResult::Changed,
            Self::Invalid => ImportResult::Invalid,
            Self::Unavailable => ImportResult::Unavailable,
            Self::Unknown => return Err("agent_import_unknown".into()),
        })
    }
}
struct Sources {
    revision: u64,
    sources: Vec<ImportSource>,
}
fn namespace() -> Namespace {
    Namespace::new(IMPLEMENTATION, maka_plugin_core::scope::Scope::Profile)
        .expect("native Agent namespace")
}
impl Owner {
    pub async fn import_directories(
        self: &Arc<Self>,
        input: Directories,
        scope: &Scope,
    ) -> Result<DirectoryPage, String> {
        self.resource_work(scope, move |owner, _| {
            Box::pin(async move {
                let private = owner
                    .store
                    .owned_root()
                    .map_err(|_| "agent_import_unavailable")?
                    .canonical_path()
                    .to_owned();
                workspace::query_excluding(
                    owner.import_roots.clone(),
                    input,
                    owner.home.as_deref(),
                    Some(private),
                )
                .await
            })
        })
        .await
    }

    async fn import_sources(&self) -> Result<Sources, Failure> {
        let record = self
            .store
            .plugin_data(&namespace(), &format!("{}import_sources", self.prefix))
            .await
            .map_err(|_| Failure::Unavailable)?;
        let revision = record.as_ref().map_or(0, |record| record.revision);
        let sources: Vec<ImportSource> = match record.map(|record| record.data) {
            None | Some(Data::Deleted) => vec![],
            Some(Data::Present(value)) => {
                serde_json::from_value(value).map_err(|_| Failure::Unavailable)?
            }
        };
        Ok(Sources { revision, sources })
    }
    async fn import_source(
        &self,
        reference: &ImportSourceRef,
        scope: &Scope,
    ) -> Result<SourceRead, Failure> {
        let snapshot = self.import_sources().await?;
        if reference.revision != snapshot.revision {
            return Err(Failure::Changed);
        }
        let source = snapshot
            .sources
            .into_iter()
            .find(|source| source.id == reference.id)
            .ok_or(Failure::Changed)?;
        SourceRead::open(self, source, scope).await
    }
    pub async fn imports(
        self: &Arc<Self>,
        input: ImportsRead,
        scope: &Scope,
    ) -> Result<ImportsPage, String> {
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                Ok(owner
                    .import_page(input, &scope)
                    .await
                    .unwrap_or_else(Failure::page))
            })
        })
        .await
    }
    async fn import_page(&self, input: ImportsRead, scope: &Scope) -> Result<ImportsPage, Failure> {
        let mut result = match input {
            ImportsRead::Sources => {
                let snapshot = self.import_sources().await?;
                return Ok(ImportsPage::Sources {
                    revision: snapshot.revision,
                    sources: snapshot.sources,
                });
            }
            ImportsRead::Catalog { source, query } => {
                let reader = self.import_source(&source, scope).await?;
                let page = reader
                    .adapter
                    .catalog(
                        &reader,
                        catalog::Query {
                            text: query.text,
                            cwd: None,
                            include_archived: query.include_archived,
                            limit: 16,
                            cursor: query.cursor,
                        },
                    )
                    .await?;
                reader.validate(self).await?;
                let entries = page
                    .entries
                    .into_iter()
                    .map(|entry| ImportEntry {
                        id: entry.id,
                        path: entry.path,
                        title: entry.title,
                        cwd: entry.cwd,
                        updated_at: entry.updated_at,
                        archived: entry.archived,
                    })
                    .collect();
                return Ok(ImportsPage::Catalog {
                    source,
                    entries,
                    next: page.next,
                });
            }
            ImportsRead::Preview {
                source,
                entry,
                digest,
                after,
            } => {
                if after > 0 && digest.is_none() {
                    return Err(Failure::Invalid);
                }
                let reader = self.import_source(&source, scope).await?;
                let selected = source::Selection {
                    source_id: source.id,
                    source_revision: source.revision,
                    session_id: entry.session_id.clone(),
                    path: entry.path.clone(),
                };
                let mut page = preview::Preview::new(after);
                let transcript = reader
                    .adapter
                    .read_exact(&reader, &selected, &mut page)
                    .await?;
                reader.validate(self).await?;
                let actual = preview::digest(&transcript.fingerprint)?;
                if digest.is_some_and(|digest| digest != actual) {
                    return Err(Failure::Changed);
                }
                if after >= page.count {
                    return Err(Failure::Invalid);
                }
                let next = (after + (page.items.len() as u64) < page.count)
                    .then_some(after + page.items.len() as u64);
                ImportsPage::Preview {
                    preview: ImportPreview {
                        selection: ImportSelection {
                            source,
                            entry,
                            digest: actual,
                        },
                        title: transcript.title,
                        cwd: transcript.cwd,
                        records: page.count,
                        bytes: transcript.fingerprint.bytes,
                        incomplete_tail: transcript.fingerprint.incomplete_tail,
                        items: page.items,
                        next,
                    },
                }
            }
            ImportsRead::Copies { after } => {
                if after.as_ref().is_some_and(|id| !self.owns(id)) {
                    return Err(Failure::Invalid);
                }
                let page = self
                    .durable
                    .imported_sessions(self.run_owner(), self.prefix.clone(), after, 16)
                    .await
                    .map_err(Failure::from)?;
                let catalog = self.canonical_catalog().map_err(|_| Failure::Unavailable)?;
                let mut sessions = Vec::with_capacity(page.ids.len());
                for id in page.ids {
                    if let Some(session) = catalog
                        .record(&id)
                        .await
                        .map_err(Failure::from)?
                        .map(|record| crate::service::summary(self, record))
                        .transpose()
                        .map_err(|_| Failure::Unavailable)?
                    {
                        sessions.push(session);
                    }
                }
                let next = page.next;
                ImportsPage::Copies { sessions, next }
            }
        };
        while !workspace::fits(&result) {
            match &mut result {
                ImportsPage::Preview { preview } if preview.items.len() > 1 => {
                    preview.next = preview.items.pop().map(|item| item.index);
                }
                ImportsPage::Copies { sessions, next } if sessions.len() > 1 => {
                    sessions.pop();
                    *next = sessions.last().map(|session| session.id.clone());
                }
                // A complete first item and its source metadata must always advance.
                _ => break,
            }
        }
        Ok(result)
    }
    pub async fn import(
        self: &Arc<Self>,
        input: ImportChange,
        operation: RecoveryRef,
        scope: &Scope,
    ) -> Result<NativeMutation<ImportResult>, String> {
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                if let Some(original) = owner.original_import(&operation).await? {
                    return Ok(NativeMutation::Returned(original));
                }
                match owner.import_change(input, &operation, &scope).await {
                    Ok(result) => Ok(result),
                    Err(Failure::Unknown) => match owner.original_import(&operation).await? {
                        Some(original) => Ok(NativeMutation::Returned(original)),
                        None => Err("agent_import_unknown".into()),
                    },
                    Err(failure) => failure.result().map(NativeMutation::Returned),
                }
            })
        })
        .await
    }

    async fn original_import(
        &self,
        operation: &RecoveryRef,
    ) -> Result<Option<ImportResult>, String> {
        operation
            .validate()
            .map_err(|_| "agent_import_reference_invalid")?;
        if operation.source.state_domain != self.data_source.state_domain
            || operation.source.deployment != self.data_source.deployment
            || operation.namespace != self.data_source.namespace
            || operation.export != maka_agent_api::EXPORT
            || operation.method != "import"
        {
            return Err("agent_import_reference_unavailable".into());
        }
        let observed = self
            .store
            .operation(operation)
            .map_err(|_| "agent_import_unavailable")?
            .operation_observation()
            .await
            .map_err(|_| "agent_import_unavailable")?;
        match observed.map(|value| value.outcome) {
            Some(OperationOutcome::Returned {
                result: OperationResult::Success { value },
            }) => {
                let result: ImportResult = serde_json::from_value(value)
                    .map_err(|_| "agent_import_reference_unavailable")?;
                if let ImportResult::Imported { session } = &result
                    && session.id != self.operation_id(operation)
                {
                    return Err("agent_import_reference_unavailable".into());
                }
                Ok(Some(result))
            }
            Some(OperationOutcome::Returned {
                result: OperationResult::Failure { diagnostic },
            }) => Err(diagnostic),
            Some(OperationOutcome::Unknown { .. }) => Err("agent_import_unknown".into()),
            Some(OperationOutcome::NotExecuted { .. }) => Err("agent_import_not_executed".into()),
            Some(OperationOutcome::Unresolved) | None => Ok(None),
        }
    }

    fn import_writer(&self, scope: &Scope) -> Result<DataWriter, Failure> {
        if let Some(execution) = scope.identity.agent() {
            let custody = scope.work_custody().ok_or(Failure::Unavailable)?;
            self.store
                .data_writer_for_work(custody.as_ref(), &execution.session_id)
        } else {
            self.store.data_writer()
        }
        .map_err(Failure::from)
    }

    async fn import_change(
        &self,
        input: ImportChange,
        operation: &RecoveryRef,
        scope: &Scope,
    ) -> Result<NativeMutation<ImportResult>, Failure> {
        match input {
            ImportChange::Copy {
                selection,
                path,
                title,
            } => {
                self.import_copy(selection, path, title, operation, scope)
                    .await
            }
            other => {
                if self.runs.state().await.closing || scope.cancellation.is_cancelled() {
                    return Err(Failure::Unavailable);
                }
                let mut current = self.import_sources().await?;
                match other {
                    ImportChange::SaveSource {
                        revision,
                        id,
                        name,
                        location,
                    } => {
                        if revision != current.revision {
                            return Err(Failure::Changed);
                        }
                        let name = name.trim().to_owned();
                        if name.is_empty() || name.chars().any(char::is_control) {
                            return Err(Failure::Invalid);
                        }
                        let private = self
                            .store
                            .owned_root()
                            .map_err(|_| Failure::Unavailable)?
                            .canonical_path()
                            .to_owned();
                        let selected = workspace::observed(
                            self.import_roots.clone(),
                            location.path(),
                            self.home.as_deref(),
                            private,
                        )
                        .await
                        .map_err(|_| Failure::Unavailable)?
                        .ok_or(Failure::Unavailable)?;
                        let source = ImportSource {
                            id: id.unwrap_or_else(Uuid::new_v4),
                            name,
                            location,
                            path: selected.path,
                        };
                        let reader = SourceRead::open(self, source.clone(), scope).await?;
                        reader.validate(self).await?;
                        if let Some(id) = id {
                            let row = current
                                .sources
                                .iter_mut()
                                .find(|source| source.id == id)
                                .ok_or(Failure::Changed)?;
                            *row = source;
                        } else {
                            current.sources.push(source);
                        }
                    }
                    ImportChange::RemoveSource { revision, id } => {
                        if revision != current.revision
                            || !current.sources.iter().any(|source| source.id == id)
                        {
                            return Err(Failure::Changed);
                        }
                        current.sources.retain(|source| source.id != id);
                    }
                    ImportChange::Copy { .. } => unreachable!(),
                }
                if scope.cancellation.is_cancelled() {
                    return Err(Failure::Unavailable);
                }
                let writer = self.import_writer(scope)?;
                let (records, change) = self
                    .store
                    .prepare_plugin_data_batch(
                        &namespace(),
                        vec![Mutation {
                            key: format!("{}import_sources", self.prefix),
                            expected_revision: (current.revision != 0).then_some(current.revision),
                            data: Data::Present(
                                serde_json::to_value(&current.sources)
                                    .map_err(|_| Failure::Invalid)?,
                            ),
                        }],
                        &writer,
                    )
                    .map_err(Failure::from)?;
                let revision = records.first().ok_or(Failure::Unknown)?.revision;
                Ok(NativeMutation::Commit {
                    value: ImportResult::Sources {
                        revision,
                        sources: current.sources,
                    },
                    change,
                })
            }
        }
    }
}

impl From<StoreError> for Failure {
    fn from(error: StoreError) -> Self {
        tracing::warn!(
            stage = "session_import",
            cause = crate::diagnostics::store_cause(&error),
            error = ?error,
            sql_code = crate::diagnostics::store_sql_code(&error),
            "Import storage operation failed"
        );
        match error.underlying() {
            StoreError::CommitUnknown(_) | StoreError::OperationUnknown => Self::Unknown,
            StoreError::RevisionConflict { .. }
            | StoreError::EventConflict
            | StoreError::SessionConflict => Self::Changed,
            StoreError::InvalidTransition(_) => Self::Invalid,
            _ => Self::Unavailable,
        }
    }
}
