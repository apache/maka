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
use maka_capabilities::storage::Data;
use maka_capabilities::storage::Mutation;
use maka_capabilities::storage::Namespace;
use maka_session_import::{Transcript, catalog, source};

mod access;
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
        match error {
            Error::Invalid(_) | Error::Decode { .. } => Self::Invalid,
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
                workspace::query_excluding(owner.import_roots.clone(), input, Some(private)).await
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
    async fn import_transcript(
        &self,
        source: &ImportSourceRef,
        entry: &ImportEntryRef,
        scope: &Scope,
    ) -> Result<(SourceRead, Transcript, String), Failure> {
        let reader = self.import_source(source, scope).await?;
        let selection = source::Selection {
            source_id: source.id,
            source_revision: source.revision,
            session_id: entry.session_id.clone(),
            path: entry.path.clone(),
        };
        let transcript = reader.adapter.read(&reader, &selection).await?;
        reader.validate(self).await?;
        let mut hash = TranscriptDigest(Sha256::new());
        serde_json::to_writer(&mut hash, &transcript).map_err(|_| Failure::Invalid)?;
        let digest = hex::encode(hash.0.finalize());
        Ok((reader, transcript, digest))
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
                let (_, transcript, actual) =
                    self.import_transcript(&source, &entry, scope).await?;
                if digest.is_some_and(|digest| digest != actual) {
                    return Err(Failure::Changed);
                }
                if after >= transcript.records.len() as u64 {
                    return Err(Failure::Invalid);
                }
                let count = transcript.records.len() as u64;
                let items = transcript
                    .records
                    .iter()
                    .enumerate()
                    .skip(after as usize)
                    .take(8)
                    .map(|(index, record)| preview_item(index, record))
                    .collect::<Vec<_>>();
                let next =
                    (after + (items.len() as u64) < count).then_some(after + items.len() as u64);
                ImportsPage::Preview {
                    preview: ImportPreview {
                        selection: ImportSelection {
                            source,
                            entry,
                            digest: actual,
                        },
                        title: transcript.title,
                        cwd: transcript.cwd,
                        records: count,
                        bytes: transcript.fingerprint.bytes,
                        incomplete_tail: transcript.fingerprint.incomplete_tail,
                        items,
                        next,
                    },
                }
            }
            ImportsRead::Copies { after } => {
                if after.as_ref().is_some_and(|id| !self.owns(id)) {
                    return Err(Failure::Invalid);
                }
                let (records, next) = self
                    .store
                    .imported_sessions::<StoredSessionConfiguration>(
                        &self.prefix,
                        after.as_deref(),
                        16,
                    )
                    .await
                    .map_err(|_| Failure::Unavailable)?;
                let sessions = records
                    .into_iter()
                    .map(|record| {
                        resolve_session(record).map(|record| crate::service::summary(self, record))
                    })
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|_| Failure::Unavailable)?;
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
        operation: maka_plugin_core::operation::RecoveryRef,
        scope: &Scope,
    ) -> Result<ImportResult, String> {
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                match owner.import_change(input, operation, &scope).await {
                    Ok(result) => Ok(result),
                    Err(failure) => failure.result(),
                }
            })
        })
        .await
    }
    async fn import_change(
        &self,
        input: ImportChange,
        operation: maka_plugin_core::operation::RecoveryRef,
        scope: &Scope,
    ) -> Result<ImportResult, Failure> {
        match input {
            ImportChange::Copy {
                selection,
                directory,
                title,
            } => {
                if metadata_rejection(&title, &[]).is_some() {
                    return Err(Failure::Invalid);
                }
                let (reader, transcript, digest) = self
                    .import_transcript(&selection.source, &selection.entry, scope)
                    .await?;
                if digest != selection.digest {
                    return Err(Failure::Changed);
                }
                let runs = self.runs.lock().await;
                if runs.closing || scope.cancellation.is_cancelled() {
                    return Err(Failure::Unavailable);
                }
                if self.import_sources().await?.revision != selection.source.revision {
                    return Err(Failure::Changed);
                }
                reader.validate(self).await?;
                let workspace = self
                    .create_project_workspace(directory)
                    .await
                    .map_err(|_| Failure::Unknown)?
                    .ok_or(Failure::Unavailable)?;
                let workspace = self
                    .store
                    .attach_workspace(&self.prefix, &workspace)
                    .await
                    .map_err(|_| Failure::Unavailable)?;
                let owner = maka_event_log::sessions::PluginSession {
                    session_id: self.operation_id(&operation),
                    creator: namespace(),
                    fingerprint: operation.fingerprint,
                    managed: false,
                    authority_session_id: None,
                };
                let record = self
                    .store
                    .import_session(
                        &owner,
                        &transcript.source,
                        &StoredSessionConfiguration {
                            backend: None,
                            compaction_prompt: None,
                            collaboration_mode: CollaborationMode::Agent,
                            tools: None,
                            title,
                            title_is_manual: true,
                            labels: vec![],
                            workspace,
                            permissions: self.settings.permissions.clone(),
                            boundary_revision: 0,
                        },
                        transcript.records,
                        now(),
                    )
                    .await
                    .map_err(|error| match error {
                        maka_event_log::StoreError::InvalidTransition(_) => Failure::Invalid,
                        maka_event_log::StoreError::SessionConflict
                        | maka_event_log::StoreError::EventConflict => Failure::Changed,
                        _ => Failure::Unknown,
                    })?;
                Ok(ImportResult::Imported {
                    session: Box::new(crate::service::summary(
                        self,
                        resolve_session(record).map_err(|_| Failure::Unavailable)?,
                    )),
                })
            }
            other => {
                let runs = self.runs.lock().await;
                if runs.closing || scope.cancellation.is_cancelled() {
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
                            location.directory().clone(),
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
                let records = self
                    .store
                    .plugin_data_batch(
                        &namespace(),
                        vec![Mutation {
                            key: format!("{}import_sources", self.prefix),
                            expected_revision: (current.revision != 0).then_some(current.revision),
                            data: Data::Present(
                                serde_json::to_value(&current.sources)
                                    .map_err(|_| Failure::Invalid)?,
                            ),
                        }],
                    )
                    .await
                    .map_err(|error| match error {
                        maka_event_log::StoreError::RevisionConflict { .. } => Failure::Changed,
                        _ => Failure::Unknown,
                    })?;
                let revision = records.first().ok_or(Failure::Unknown)?.revision;
                Ok(ImportResult::Sources {
                    revision,
                    sources: current.sources,
                })
            }
        }
    }
}
fn preview_item(index: usize, record: &maka_agent_facts::import::Record) -> ImportPreviewItem {
    use maka_agent_facts::import::Content;
    let (kind, text) = match &record.content {
        Content::User { text } => (ImportRecordKind::User, text.clone()),
        Content::Assistant { text, thinking, .. } => (
            ImportRecordKind::Assistant,
            if text.is_empty() {
                thinking.clone().unwrap_or_default()
            } else {
                text.clone()
            },
        ),
        Content::ToolCall { name, input, .. } => (
            ImportRecordKind::ToolCall,
            format!(
                "{}\n{}",
                name,
                input
                    .as_ref()
                    .map_or(String::new(), serde_json::Value::to_string)
            ),
        ),
        Content::ToolResult { output, .. } => (
            ImportRecordKind::ToolResult,
            output
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| output.to_string()),
        ),
        Content::Note { text } => (ImportRecordKind::Note, text.clone()),
    };
    let truncated = text.len() > 4096;
    let mut end = text.len().min(4096);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    ImportPreviewItem {
        index: index as u64,
        kind,
        text: text[..end].into(),
        truncated,
    }
}

struct TranscriptDigest(Sha256);
impl std::io::Write for TranscriptDigest {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
