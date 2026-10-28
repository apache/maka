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

//! Incremental semantic groups and separately captured provider-wire groups.
use crate::RunError;
use maka_agent_facts::model::prompt_source::{
    WireCursor, WireMetadata, WireMetadataCursor, WireSource,
};
use maka_agent_facts::{context::measure, language::Language};
use maka_event_log::context::{
    prepared::{PreparedView, PreparedWireCursor, PreparedWireView},
    semantic::{SemanticReplay, SemanticSelection},
};
use maka_event_log::root_store::SessionStore;
use maka_model::{
    ModelError, ProviderConfig, ProviderKind, ToolDefinition,
    prompt::{Message, Prompt, PromptCursor, PromptSource},
};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

pub(crate) struct PreparedHistory {
    log: Arc<SessionStore>,
    view: PreparedView,
    wire: Mutex<Option<PreparedWireView>>,
    language: Language,
    vision: bool,
    provider: ProviderKind,
    replay: Option<SemanticReplay>,
    session: String,
}

pub(crate) async fn capture(
    log: &Arc<SessionStore>,
    selection: SemanticSelection,
    language: Language,
    vision: bool,
    provider: &ProviderKind,
    cancellation: &CancellationToken,
    prior: Option<&PreparedHistory>,
) -> Result<Arc<PreparedHistory>, RunError> {
    #[derive(serde::Serialize)]
    struct Policy<'a> {
        renderer: &'static str,
        language: Language,
        vision: bool,
        provider: &'a ProviderKind,
    }
    let policy = crate::runner::digest(&Policy {
        renderer: "maka.semantic-render.v1",
        language,
        vision,
        provider,
    })?;
    let session = selection.session.clone();
    let replay = selection.replay.clone();
    let build = log
        .prepare_model_view(selection, &policy, prior.map(|history| &history.view))
        .await?;
    let mut after = None;
    loop {
        if cancellation.is_cancelled() {
            return Err(RunError::Cancelled);
        }
        let groups = log
            .prepared_dirty_groups(&build, after.as_deref(), 64)
            .await?;
        if groups.is_empty() {
            break;
        }
        for group in groups {
            if cancellation.is_cancelled() {
                return Err(RunError::Cancelled);
            }
            let rows = log.prepared_group_rows(&build, &group).await?;
            let (messages, manifest) = super::render_semantic_group(
                log,
                &rows,
                super::semantic::RenderContext {
                    session: &session,
                    vision,
                    language,
                    provider,
                    replay: replay.as_ref(),
                },
                cancellation,
                None,
            )
            .await?;
            let breakdown = measure::prompt_breakdown(&messages);
            log.put_prepared_group(&build, &group, messages, breakdown, manifest)
                .await?;
            after = Some(group.id);
        }
    }
    let view = log.finish_prepared(&build).await?;
    Ok(Arc::new(PreparedHistory {
        log: log.clone(),
        view,
        wire: Mutex::new(prior.and_then(|history| {
            history
                .wire
                .lock()
                .expect("prepared wire lock poisoned")
                .clone()
        })),
        language,
        vision,
        provider: provider.clone(),
        replay,
        session,
    }))
}

impl PreparedHistory {
    pub fn prompt(self: &Arc<Self>) -> Prompt {
        Prompt::new(
            self.clone(),
            self.view.identity.clone(),
            self.view.message_count,
            self.view.breakdown.clone(),
        )
        .with_normalization(self.provider.clone())
    }

    pub async fn compile(
        self: &Arc<Self>,
        provider: &ProviderConfig,
        options: &serde_json::Value,
        tools: &[ToolDefinition],
        cancellation: &CancellationToken,
    ) -> Result<Prompt, RunError> {
        let encoding = maka_model::WireEncoding::new(self.language, provider, options, tools)?;
        let codec = encoding.codec().to_owned();
        let format = encoding.format();
        let prior = self
            .wire
            .lock()
            .expect("prepared wire lock poisoned")
            .clone();
        let build = self
            .log
            .prepare_wire_view(&self.view, format, &codec, prior.as_ref())
            .await?;
        let mut after = None;
        loop {
            if cancellation.is_cancelled() {
                return Err(RunError::Cancelled);
            }
            let groups = self
                .log
                .prepared_wire_dirty_groups(&build, after.as_deref(), 64)
                .await?;
            if groups.is_empty() {
                break;
            }
            for group in groups {
                let semantic = self.log.prepared_view_group(&self.view, &group).await?;
                let (messages, _) = super::render_semantic_group(
                    &self.log,
                    &semantic.rows,
                    super::semantic::RenderContext {
                        session: &self.session,
                        vision: self.vision,
                        language: self.language,
                        provider: &self.provider,
                        replay: self.replay.as_ref(),
                    },
                    cancellation,
                    Some(&semantic.manifest),
                )
                .await?;
                let needed = maka_model::wire_preparation_dependencies(&messages, &provider.kind);
                let anthropic_mcp_ids = if needed.is_empty() {
                    Vec::new()
                } else {
                    self.log
                        .prepared_prior_mcp_ids(&self.view, &group, &needed)
                        .await?
                };
                let wire = encoding.prepare_group(
                    messages,
                    &maka_model::PreparationContext { anthropic_mcp_ids },
                );
                self.log
                    .put_prepared_wire_group(&build, &group, wire)
                    .await?;
                after = Some(group.id);
            }
        }
        let view = self.log.finish_prepared_wire(&build).await?;
        *self.wire.lock().expect("prepared wire lock poisoned") = Some(view.clone());
        Ok(self.prompt().with_wire(
            format,
            codec,
            view.identity.clone(),
            Arc::new(StoredWire {
                log: self.log.clone(),
                view,
            }),
        ))
    }
}

impl PromptSource for PreparedHistory {
    fn open(&self) -> Box<dyn PromptCursor> {
        Box::new(Cursor {
            log: self.log.clone(),
            view: self.view.clone(),
            language: self.language,
            vision: self.vision,
            provider: self.provider.clone(),
            replay: self.replay.clone(),
            session: self.session.clone(),
            position: Some(0),
            page: VecDeque::new(),
        })
    }
}
struct Cursor {
    log: Arc<SessionStore>,
    view: PreparedView,
    language: Language,
    vision: bool,
    provider: ProviderKind,
    replay: Option<SemanticReplay>,
    session: String,
    position: Option<usize>,
    page: VecDeque<Message>,
}
fn model_error(error: impl std::fmt::Display) -> ModelError {
    ModelError::Adapter(format!("prepared history read failed: {error}"))
}
impl PromptCursor for Cursor {
    fn next(&mut self) -> maka_agent_facts::model::prompt_source::Next<'_> {
        Box::pin(async move {
            loop {
                if let Some(message) = self.page.pop_front() {
                    return Ok(Some(message));
                }
                let Some(position) = self.position else {
                    return Ok(None);
                };
                let Some(group) = self
                    .log
                    .prepared_semantic_group(&self.view, position)
                    .await
                    .map_err(model_error)?
                else {
                    self.position = None;
                    continue;
                };
                let (messages, _) = super::render_semantic_group(
                    &self.log,
                    &group.rows,
                    super::semantic::RenderContext {
                        session: &self.session,
                        vision: self.vision,
                        language: self.language,
                        provider: &self.provider,
                        replay: self.replay.as_ref(),
                    },
                    &CancellationToken::new(),
                    Some(&group.manifest),
                )
                .await
                .map_err(model_error)?;
                // Retain only the active logical group's remaining messages.
                self.page.extend(messages.into_iter().skip(group.skip));
                let next = position + self.page.len();
                self.position = (next < self.view.message_count).then_some(next);
            }
        })
    }
}

struct StoredWire {
    log: Arc<SessionStore>,
    view: PreparedWireView,
}
impl WireSource for StoredWire {
    fn open_at(
        &self,
        position: maka_agent_facts::model::prompt_source::WirePosition,
    ) -> Option<Box<dyn WireCursor>> {
        Some(Box::new(WireReader {
            log: self.log.clone(),
            view: self.view.clone(),
            position: Some(PreparedWireCursor {
                message_offset: position.message_index,
                piece_index: position.piece_index,
            }),
            page: VecDeque::new(),
        }))
    }
    fn open(&self, start_message: usize) -> Box<dyn WireCursor> {
        Box::new(WireReader {
            log: self.log.clone(),
            view: self.view.clone(),
            position: Some(PreparedWireCursor {
                message_offset: start_message,
                piece_index: 0,
            }),
            page: VecDeque::new(),
        })
    }
    fn open_metadata(&self, start_message: usize) -> Option<Box<dyn WireMetadataCursor>> {
        Some(Box::new(MetadataReader {
            log: self.log.clone(),
            view: self.view.clone(),
            position: Some(PreparedWireCursor {
                message_offset: start_message,
                piece_index: 0,
            }),
            page: VecDeque::new(),
        }))
    }
    fn prefix_identity(
        &self,
        messages: usize,
    ) -> maka_agent_facts::model::prompt_source::PrefixIdentity<'_> {
        Box::pin(async move {
            self.log
                .prepared_wire_prefix_identity(&self.view, messages)
                .await
                .map_err(model_error)
        })
    }
}
struct WireReader {
    log: Arc<SessionStore>,
    view: PreparedWireView,
    position: Option<PreparedWireCursor>,
    page: VecDeque<maka_agent_facts::model::prompt_source::WireChunk>,
}
impl WireCursor for WireReader {
    fn next(&mut self) -> maka_agent_facts::model::prompt_source::NextWire<'_> {
        Box::pin(async move {
            loop {
                if let Some(chunk) = self.page.pop_front() {
                    return Ok(Some(chunk));
                }
                let Some(position) = self.position.take() else {
                    return Ok(None);
                };
                let page = self
                    .log
                    .prepared_wire_page(&self.view, position, 32)
                    .await
                    .map_err(model_error)?;
                self.position = page.next_cursor;
                self.page = page.chunks.into();
            }
        })
    }
}
struct MetadataReader {
    log: Arc<SessionStore>,
    view: PreparedWireView,
    position: Option<PreparedWireCursor>,
    page: VecDeque<WireMetadata>,
}
impl WireMetadataCursor for MetadataReader {
    fn next(&mut self) -> maka_agent_facts::model::prompt_source::NextWireMetadata<'_> {
        Box::pin(async move {
            loop {
                if let Some(item) = self.page.pop_front() {
                    return Ok(Some(item));
                }
                let Some(position) = self.position.take() else {
                    return Ok(None);
                };
                let page = self
                    .log
                    .prepared_wire_metadata_page(&self.view, position, 64)
                    .await
                    .map_err(model_error)?;
                self.position = page.next_cursor;
                self.page = page.items.into();
            }
        })
    }
}
