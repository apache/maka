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

use crate::contract::{RecallPage, RecallPassage};
use maka_agent_facts::{
    durable::RunOwner,
    tool_call::ToolRejection,
    tool_output::{DurableToolProjection, ToolOutput, ToolSuccess},
    tools::*,
};
use maka_agent_state::{
    recall::{self as indexed, RecallStore},
    session_catalog::Record,
};
use maka_assistant::recall::search;
use maka_capabilities::call::Scope;
use serde_json::Value;
use std::{future::Future, sync::Arc};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub(crate) struct Recall {
    pub(super) store: Arc<maka_event_log::RootStore>,
    pub(super) durable: maka_agent_state::Store,
    pub(super) owner: RunOwner,
    pub(super) prefix: String,
    pub(super) data_source: crate::contract::DataSource,
    pub(super) enabled: bool,
    pub(super) services: maka_host_runtime::application::NativeServices,
    pub(super) stop: CancellationToken,
    pub(super) workers: tokio_util::task::TaskTracker,
}
impl Recall {
    fn data(&self, call: &Scope) -> Result<maka_event_log::root_store::DataWriter, ToolError> {
        let data = if let Some(execution) = call.identity.agent() {
            let custody = call
                .work_custody()
                .ok_or_else(|| failed("Recall work custody unavailable"))?;
            self.store
                .data_writer_for_work(custody.as_ref(), &execution.session_id)
        } else {
            self.store.data_writer()
        }
        .map_err(failed)?;
        self.durable.validate_root(&data).map_err(failed)?;
        Ok(data)
    }
    fn index(&self, call: &Scope) -> Result<RecallStore, ToolError> {
        RecallStore::new(self.data(call)?, self.owner.clone(), self.prefix.clone()).map_err(failed)
    }
    async fn address(
        &self,
        call: &Scope,
        session: &str,
        cut: &maka_agent_state::session_history::HistoryCut,
        anchor: &indexed::Message,
    ) -> Result<maka_agent_facts::history::HistoryRowAddress, ToolError> {
        let source = maka_agent_state::session_history::SessionHistory::new(
            self.data(call)?,
            self.owner.clone(),
            session.to_owned(),
        )
        .item(cut, anchor.position.source_sequence)
        .await
        .map_err(failed)?
        .ok_or_else(|| failed("Recall original source fact unavailable"))?;
        if source.recorded.run != anchor.run {
            return Err(failed("Recall source Run differs from the original anchor"));
        }
        Ok(maka_agent_facts::history::HistoryRowAddress::Live {
            sequence: source.sequence,
            fact: source.recorded.id,
            item_index: anchor.position.item_index,
        })
    }
    async fn check(&self, call: &Scope) -> Result<(), ToolError> {
        if call.cancellation.is_cancelled() || self.stop.is_cancelled() {
            return Err(failed("Recall cancelled"));
        }
        let data = self.data(call)?;
        if let Some(execution) = call.identity.agent() {
            if !self.enabled {
                return Err(failed("Recall model access is disabled"));
            }
            if !super::owns_session(&self.prefix, &execution.session_id) {
                return Err(failed("Recall Session unavailable"));
            }
            RecallStore::new(data, self.owner.clone(), self.prefix.clone())
                .map_err(failed)?
                .validate_execution(execution.clone())
                .await
                .map_err(failed)?;
        }
        Ok(())
    }
    async fn worker<T: Send + 'static>(
        &self,
        call: &Scope,
        work: impl Future<Output = Result<T, ToolError>> + Send + 'static,
    ) -> Result<T, ToolError> {
        let mut ticket = call.resources.reserve()?;
        ticket.start();
        let worker = self.workers.spawn(async move {
            let result = work.await;
            ticket.complete(Ok(()));
            result
        });
        tokio::select! {biased;_ =call.cancellation.cancelled()=>Err(failed("Recall cancelled")),_ =self.stop.cancelled()=>Err(failed("Recall cancelled")),result=worker=>result.map_err(|e|failed(format!("Recall worker failed: {e}")))?}
    }
    async fn batch(
        self: &Arc<Self>,
        call: &Scope,
        query: &search::Query,
        before: usize,
        after: usize,
    ) -> Result<indexed::Batch, ToolError> {
        self.check(call).await?;
        let index = self.index(call)?;
        let exclude = if let Some(execution) = call.identity.agent() {
            Some(index.exclusion(execution.run_id).await.map_err(failed)?)
        } else {
            None
        };
        let query = indexed::SearchQuery {
            terms: query.terms.clone(),
            limit: query.limit,
            session_id: query.session_id.clone(),
            since: query.since,
            until: query.until,
            exclude,
        };
        let stop = call.cancellation.child_token();
        let _guard = stop.clone().drop_guard();
        let recall = self.clone();
        let scope = call.clone();
        self.worker(call, async move {
            recall.check(&scope).await?;
            let found = index
                .search(query, before, after, stop)
                .await
                .map_err(failed)?;
            recall.check(&scope).await?;
            Ok(found)
        })
        .await
    }
    pub async fn query(
        self: &Arc<Self>,
        mut query: search::Query,
        call: &Scope,
    ) -> Result<RecallPage, String> {
        query.validate()?;
        let found = self
            .batch(call, &query, 0, 0)
            .await
            .map_err(|e| e.to_string())?;
        let mut titles = Vec::new();
        let mut gaps = found.gaps;
        for record in found.titles {
            match crate::service::summary_for(&self.data_source, record) {
                Ok(summary) => titles.push(summary),
                Err(reason) => {
                    if query.session_id.is_some() {
                        return Err(reason);
                    }
                    gaps.push(reason);
                }
            }
        }
        let mut passages = Vec::new();
        for hit in found.hits {
            if query
                .limit
                .is_some_and(|n| titles.len() + passages.len() >= n)
            {
                break;
            }
            let address = self
                .address(call, &hit.session.metadata.id, &hit.cut, &hit.anchor)
                .await
                .map_err(|e| e.to_string())?;
            let session = match crate::service::summary_for(&self.data_source, hit.session) {
                Ok(summary) => summary,
                Err(reason) => {
                    if query.session_id.is_some() {
                        return Err(reason);
                    }
                    gaps.push(reason);
                    continue;
                }
            };
            passages.push(RecallPassage {
                session,
                anchor_message_id: hit.anchor.message_id,
                anchor_position: address,
                excerpt: hit.anchor.body,
                highlights: vec![],
                matched_terms: hit.matched_terms,
            });
        }
        let stop = call.cancellation.child_token();
        let _guard = stop.clone().drop_guard();
        let terms = query.terms;
        let passages = self
            .worker(call, async move {
                tokio::task::spawn_blocking(move || {
                    for passage in &mut passages {
                        let (excerpt, highlights) =
                            preview::excerpt(&passage.excerpt, &terms, &stop).map_err(failed)?;
                        passage.excerpt = excerpt;
                        passage.highlights = highlights;
                    }
                    Ok::<_, ToolError>(passages)
                })
                .await
                .map_err(failed)?
            })
            .await
            .map_err(|e| e.to_string())?;
        self.check(call).await.map_err(|e| e.to_string())?;
        Ok(RecallPage {
            titles,
            passages,
            complete: gaps.is_empty(),
            gaps,
        })
    }
    async fn search_result(
        self: &Arc<Self>,
        call: &Scope,
        query: &search::Query,
        before: usize,
        after: usize,
    ) -> Result<search::ResultSet, ToolError> {
        let found = self.batch(call, query, before, after).await?;
        let mut passages = Vec::with_capacity(found.hits.len());
        for hit in found.hits {
            let address = self
                .address(call, &hit.session.metadata.id, &hit.cut, &hit.anchor)
                .await?;
            passages.push(passage(
                hit.session,
                address,
                hit.anchor,
                hit.messages,
                hit.matched_terms,
                hit.score,
                hit.has_more_before,
                hit.has_more_after,
            )?);
        }
        Ok(search::ResultSet {
            passages,
            searched_every_session: found.gaps.is_empty(),
            gaps: found.gaps,
        })
    }
    async fn more_result(
        self: &Arc<Self>,
        call: &Scope,
        more: search::More,
    ) -> Result<search::ResultSet, ToolError> {
        self.check(call).await?;
        let index = self.index(call)?;
        let exclude = if let Some(execution) = call.identity.agent() {
            Some(index.exclusion(execution.run_id).await.map_err(failed)?)
        } else {
            None
        };
        let stop = call.cancellation.child_token();
        let _guard = stop.clone().drop_guard();
        let recall = self.clone();
        let scope = call.clone();
        let context = self
            .worker(call, async move {
                let context = index
                    .context(
                        more.session_id,
                        more.anchor_message_id,
                        maka_agent_state::recall::ContextWindow {
                            before: more.before.unwrap_or(8),
                            after: more.after.unwrap_or(8),
                        },
                        None,
                        exclude,
                        stop,
                    )
                    .await
                    .map_err(failed)?;
                recall.check(&scope).await?;
                Ok(context)
            })
            .await?;
        let address = self
            .address(
                call,
                &context.session.metadata.id,
                &context.cut,
                &context.anchor,
            )
            .await?;
        Ok(search::ResultSet {
            passages: vec![passage(
                context.session,
                address,
                context.anchor,
                context.messages,
                vec![],
                0.0,
                context.has_more_before,
                context.has_more_after,
            )?],
            searched_every_session: true,
            gaps: vec![],
        })
    }
    pub fn tools(self: &Arc<Self>) -> Vec<ToolRegistration> {
        search::definitions()
            .into_iter()
            .map(|(name, description, input_schema)| ToolRegistration {
                definition: ToolDefinition {
                    provider: None,
                    name: name.into(),
                    description: description.into(),
                    input_schema,
                    output_schema: None,
                    freeform: None,
                },
                nesting: ToolNesting::Nestable,
                semantics: ToolSemantics::Parallel,
                handler: ToolHandler::Prepared(self.clone()),
            })
            .collect()
    }
}
enum Input {
    Search {
        query: search::Query,
        before: usize,
        after: usize,
    },
    More(search::More),
}
impl Recall {
    pub(super) async fn prepare_native(
        self: &Arc<Self>,
        name: String,
        input: Value,
        context: ToolCallContext,
        cancellation: CancellationToken,
        access: Arc<super::RunAccess>,
        semantics: ToolSemantics,
    ) -> Result<super::driver::PreparedTool, ToolRejection> {
        if name != "RecallMaterial" {
            let effect =
                <Self as ToolPreparer>::prepare(self, name, input, context, cancellation).await?;
            return Ok(super::driver::PreparedTool {
                effect,
                local: None,
                semantics,
            });
        }
        if cancellation.is_cancelled() || self.stop.is_cancelled() {
            return Err(ToolRejection::Cancelled);
        }
        let input: search::Material = serde_json::from_value(input).map_err(invalid)?;
        input.validate().map_err(invalid)?;
        self.prepare_material(input, context, cancellation, access, semantics)
            .await
    }
}
impl ToolPreparer for Recall {
    fn names(&self) -> Vec<String> {
        search::definitions()
            .into_iter()
            .map(|(name, _, _)| name.into())
            .collect()
    }
    fn prepare(
        &self,
        name: String,
        input: Value,
        context: ToolCallContext,
        cancellation: CancellationToken,
    ) -> PreparationFuture {
        let recall = Arc::new(self.clone());
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(ToolRejection::Cancelled);
            }
            let input = match name.as_str() {
                "Recall" => {
                    let value: search::ToolQuery =
                        serde_json::from_value(input).map_err(invalid)?;
                    let (query, before, after) = value.into_parts().map_err(invalid)?;
                    Input::Search {
                        query,
                        before,
                        after,
                    }
                }
                "RecallMore" => {
                    let value: search::More = serde_json::from_value(input).map_err(invalid)?;
                    value.validate().map_err(invalid)?;
                    Input::More(value)
                }
                "RecallMaterial" => {
                    return Err(ToolRejection::PreparationFailed {
                        message: "RecallMaterial requires original Native atomic completion".into(),
                    });
                }
                _ => return Err(ToolRejection::Unavailable),
            };
            let title = match &input {
                Input::Search { query, .. } => {
                    let query = query.terms.join(", ");
                    maka_agent_facts::display::Text::single_line(&query).map(|query| {
                        let query = query.fallback;
                        maka_agent_facts::display::Text::localized(
                            &format!("Search conversation history · {query}"),
                            &format!("搜索会话历史 · {query}"),
                            &format!("搜尋對話歷史 · {query}"),
                        )
                    })
                }
                Input::More(_) => None,
            };
            let effect = PreparedEffect::new(move |cancellation| {
                Box::pin(async move {
                    // The Engine supplies the admitted ToolCallContext. The
                    // original native activation owns the request and settlement.
                    let request = recall
                        .services
                        .request_with_work(
                            maka_capabilities::call::Identity::Agent {
                                execution: context.execution,
                                operation_id: Some(context.operation_id),
                            },
                            cancellation,
                            context
                                .custody
                                .ok_or_else(|| failed("Execution custody unavailable"))?,
                        )
                        .map_err(failed)?;
                    let call = request.scope();
                    let result = async {
                        recall.check(call).await?;
                        let found = match input {
                            Input::Search {
                                query,
                                before,
                                after,
                            } => recall.search_result(call, &query, before, after).await?,
                            Input::More(more) => recall.more_result(call, more).await?,
                        };
                        recall.check(call).await?;
                        let text = found.render();
                        Ok(ToolSuccess::projected(
                            ToolOutput::Json(serde_json::to_value(found).map_err(failed)?),
                            DurableToolProjection::Text { text },
                        ))
                    }
                    .await;
                    request
                        .finish()
                        .await
                        .map_err(ToolError::CleanupUnconfirmed)?;
                    result
                })
            })
            .presented(format!("maka.agent.Builtin@1/{name}"));
            Ok(if let Some(title) = title {
                effect.titled(title)
            } else {
                effect
            })
        })
    }
}
fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}
fn invalid(error: impl std::fmt::Display) -> ToolRejection {
    ToolRejection::InvalidInput {
        message: error.to_string(),
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "A passage combines the resolved address with its exact anchor, matched terms and context window"
)]
fn passage(
    record: Record,
    address: maka_agent_facts::history::HistoryRowAddress,
    anchor: indexed::Message,
    messages: Vec<indexed::Message>,
    matched_terms: Vec<String>,
    score: f64,
    has_more_before: bool,
    has_more_after: bool,
) -> Result<search::Passage, ToolError> {
    let session_id = record.metadata.id.clone();
    let title = record
        .metadata
        .configuration
        .get("title")
        .and_then(Value::as_str)
        .ok_or_else(|| failed("Recall Session title invalid"))?
        .to_owned();
    let anchor_id = anchor.message_id.clone();
    Ok(search::Passage {
        session_id,
        session_title: title,
        anchor_message_id: anchor_id.clone(),
        anchor_position: address,
        turn_id: anchor.turn_id,
        messages: messages
            .into_iter()
            .map(|message| search::PassageMessage {
                is_anchor: message.message_id == anchor_id,
                message_id: message.message_id,
                role: match message.role {
                    indexed::Role::User => maka_agent_ports::session::history::Role::User,
                    indexed::Role::Assistant => maka_agent_ports::session::history::Role::Assistant,
                    indexed::Role::ToolCall => maka_agent_ports::session::history::Role::ToolCall,
                    indexed::Role::ToolResult => {
                        maka_agent_ports::session::history::Role::ToolResult
                    }
                    indexed::Role::Compaction => {
                        maka_agent_ports::session::history::Role::Compaction
                    }
                    indexed::Role::Failure => maka_agent_ports::session::history::Role::Failure,
                },
                text: message.body,
                timestamp: message.timestamp,
                attachments: message.attachments,
            })
            .collect(),
        matched_terms,
        score,
        has_more_before,
        has_more_after,
    })
}
mod material;
mod preview;
