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

use super::auxiliary::persistence;
use super::{StoredSessionConfiguration, resolve_session};
use crate::contract::{RecallPage, RecallPassage};
use futures_util::future::BoxFuture;
use maka_agent_facts::tool_call::ToolRejection;
use maka_agent_facts::tool_output::DurableToolProjection;
use maka_agent_facts::tool_output::ToolOutput;
use maka_agent_facts::tool_output::ToolSuccess;
use maka_agent_facts::tools::*;
use maka_agent_ports::session::catalog;
use maka_assistant::recall::search::{self, History};
use maka_capabilities::call::Scope;
use maka_event_log::sessions::{CatalogFilter, CatalogScope, SessionPosition};
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub(crate) struct Recall {
    pub(super) store: Arc<maka_event_log::RootStore>,
    pub(super) configuration: Arc<maka_config::ConfigurationStore>,
    pub(super) prefix: String,
    pub(super) data_source: crate::contract::DataSource,
    pub(super) enabled: bool,
    pub(super) services: maka_host_runtime::application::NativeServices,
    pub(super) stop: CancellationToken,
    pub(super) workers: tokio_util::task::TaskTracker,
}
impl Recall {
    async fn scoped_store(
        &self,
        call: &Scope,
        id: &str,
    ) -> Result<maka_event_log::SessionStore, ToolError> {
        if !super::owns_session(&self.prefix, id) {
            return Err(failed("Recall Session unavailable"));
        }
        if let Some(invocation) = call
            .identity
            .agent()
            .filter(|invocation| invocation.session_id == id)
        {
            let custody = call
                .execution()
                .ok_or_else(|| failed("Recall execution custody unavailable"))?;
            self.store
                .session_for_execution(custody.as_ref(), invocation)
                .map_err(persistence)
        } else {
            self.store.session(id).await.map_err(persistence)
        }
    }
    async fn private(&self) -> Result<bool, ToolError> {
        Ok(self
            .configuration
            .runtime_policy()
            .await
            .map_err(failed)?
            .policy
            .privacy
            .incognito_active)
    }
    async fn metadata(
        &self,
        id: &str,
    ) -> Result<maka_event_log::sessions::SessionRecord<StoredSessionConfiguration>, String> {
        if !super::owns_session(&self.prefix, id) {
            return Err("Recall Session unavailable".into());
        }
        self.store
            .get_session::<StoredSessionConfiguration>(id)
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "agent_session_unavailable".into())
    }
    async fn check(&self, call: &Scope) -> Result<(), ToolError> {
        if call.cancellation.is_cancelled() || self.stop.is_cancelled() {
            return Err(failed("Recall cancelled"));
        }
        if self.private().await? {
            return Err(failed("Recall is unavailable in privacy mode"));
        }
        if let Some(invocation) = call.identity.agent() {
            if !self.enabled {
                return Err(failed("Recall model access is disabled"));
            }
            if !super::owns_session(&self.prefix, &invocation.session_id) {
                return Err(failed("Recall Session unavailable"));
            }
            let store = self.scoped_store(call, &invocation.session_id).await?;
            let session = store
                .get::<StoredSessionConfiguration>()
                .await
                .map_err(persistence)?
                .ok_or_else(|| failed("Recall Session unavailable"))?;
            resolve_session(session).map_err(failed)?;
            let boundary = store
                .invocation_boundary(&invocation.session_id, &invocation.invocation_id)
                .await
                .map_err(failed)?
                .ok_or_else(|| failed("Recall invocation unavailable"))?
                .0;
            if boundary.invocation != *invocation
                || matches!(
                    boundary.state,
                    maka_event_log::turns::InvocationState::Ended { .. }
                )
            {
                return Err(failed("Recall invocation closed"));
            }
        }
        Ok(())
    }
    pub async fn query(
        self: &Arc<Self>,
        mut query: search::Query,
        call: &Scope,
    ) -> Result<RecallPage, String> {
        query.validate()?;
        let operation = async {
            self.check(call).await.map_err(|e| e.to_string())?;
            if let Some(id) = &query.session_id {
                self.metadata(id).await?;
            }
            let (titles, catalog_complete) = search::titles(self.as_ref(), call, &query)
                .await
                .map_err(|e| e.to_string())?;
            let mut title_matches = Vec::new();
            for title in titles {
                if query
                    .limit
                    .is_some_and(|limit| title_matches.len() == limit)
                {
                    break;
                }
                title_matches.push(crate::service::summary_for(
                    &self.data_source,
                    resolve_session(self.metadata(&title.id).await?)?,
                ));
            }
            let found = search::search(self.clone(), call, &query, search::Content::Anchor)
                .await
                .map_err(|e| e.to_string())?;
            let mut passages = Vec::new();
            for passage in found.passages {
                if query
                    .limit
                    .is_some_and(|limit| title_matches.len() + passages.len() == limit)
                {
                    break;
                }
                let session = resolve_session(self.metadata(&passage.session_id).await?)?;
                let excerpt = passage
                    .messages
                    .iter()
                    .find(|message| message.is_anchor)
                    .map(|message| message.text.as_str())
                    .unwrap_or_default();
                let (excerpt, highlights) = preview::excerpt(excerpt, &query.terms);
                passages.push(RecallPassage {
                    session: crate::service::summary_for(&self.data_source, session),
                    anchor_message_id: passage.anchor_message_id,
                    anchor_position: passage.anchor_position,
                    excerpt,
                    highlights,
                    matched_terms: passage.matched_terms,
                });
            }
            self.check(call).await.map_err(|e| e.to_string())?;
            let page = RecallPage {
                titles: title_matches,
                passages,
                complete: catalog_complete && found.searched_every_session,
                gaps: found.gaps,
            };
            Ok(page)
        };
        tokio::select! {
            biased;
            _ = call.cancellation.cancelled() => Err("Recall cancelled".into()),
            _ = self.stop.cancelled() => Err("Recall cancelled".into()),
            result = operation => result,
        }
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
impl maka_tools::request::RequestBinding for Recall {
    fn bind(
        &self,
        request: maka_tools::request::BindingRequest,
    ) -> maka_tools::request::BindingFuture {
        let recall = Arc::new(self.clone());
        Box::pin(async move {
            let unavailable = !recall.enabled || recall.private().await?;
            if request.cancellation.is_cancelled() || recall.stop.is_cancelled() {
                return Err(failed("Recall cancelled"));
            }
            Ok(request
                .tools
                .into_iter()
                .map(|name| {
                    let projection = if unavailable {
                        maka_tools::request::BoundTool::Unavailable
                    } else {
                        maka_tools::request::BoundTool::Prepared(recall.clone())
                    };
                    (name, projection)
                })
                .collect())
        })
    }
}
impl History for Recall {
    fn list(
        &self,
        call: Scope,
        input: catalog::List,
    ) -> BoxFuture<'_, Result<search::Catalog, ToolError>> {
        Box::pin(async move {
            input.validate().map_err(failed)?;
            self.check(&call).await?;
            let page = self
                .store
                .scoped_sessions::<StoredSessionConfiguration>(
                    CatalogScope::IdPrefix(self.prefix.clone()),
                    input.revision.as_deref(),
                    input
                        .cursor
                        .as_deref()
                        .map_or(SessionPosition::Start, SessionPosition::After),
                    CatalogFilter {
                        archived_only: false,
                        include_archived: true,
                        pending_only: false,
                    },
                )
                .await
                .map_err(failed)?;
            self.check(&call).await?;
            Ok(search::Catalog {
                revision: page.revision,
                next_cursor: page.next_cursor,
                entries: page
                    .sessions
                    .into_iter()
                    .map(|session| search::Session {
                        id: session.id,
                        title: session.configuration.title,
                        last_message_at: session.last_message.map(|message| message.recorded_at),
                    })
                    .collect(),
            })
        })
    }
    fn find(
        &self,
        call: Scope,
        query: search::Query,
    ) -> BoxFuture<'_, Result<search::Matches, ToolError>> {
        Box::pin(async move {
            let cancellation = call.cancellation.child_token();
            let _cancel_on_drop = cancellation.clone().drop_guard();
            let operation = async {
                self.check(&call).await?;
                if let Some(id) = &query.session_id {
                    self.metadata(id).await.map_err(failed)?;
                }
                let input = maka_event_log::recall::SearchQuery {
                    terms: query.terms,
                    session_id: query.session_id,
                    since: query.since,
                    until: query.until,
                    exclude: exclusion(&call),
                    limit: query.limit,
                };
                let batch = self
                    .store
                    .search_history(&self.prefix, input, cancellation)
                    .await
                    .map_err(failed)?;
                let mut sessions = BTreeMap::new();
                let mut found = Vec::with_capacity(batch.hits.len());
                for mut hit in batch.hits {
                    if !sessions.contains_key(&hit.session_id) {
                        let record = self.metadata(&hit.session_id).await.map_err(failed)?;
                        sessions.insert(
                            hit.session_id.clone(),
                            search::Session {
                                id: record.id,
                                title: record.configuration.title,
                                last_message_at: record
                                    .last_message
                                    .map(|message| message.recorded_at),
                            },
                        );
                    }
                    let session = sessions
                        .get(&hit.session_id)
                        .expect("loaded source Session")
                        .clone();
                    let matched_terms = std::mem::take(&mut hit.matched_terms);
                    let score = hit.score;
                    let through = hit.through;
                    found.push(search::Hit {
                        session,
                        message: indexed_message(hit),
                        matched_terms,
                        score,
                        through,
                    });
                }
                self.check(&call).await?;
                Ok(search::Matches {
                    hits: found,
                    gaps: batch.gaps,
                })
            };
            tokio::select! {
                biased;
                _ = call.cancellation.cancelled() => Err(failed("Recall cancelled")),
                _ = self.stop.cancelled() => Err(failed("Recall cancelled")),
                result = operation => result,
            }
        })
    }
    fn context(
        &self,
        call: Scope,
        input: search::More,
        through: Option<u64>,
    ) -> BoxFuture<'_, Result<search::Context, ToolError>> {
        Box::pin(async move {
            let cancellation = call.cancellation.child_token();
            let _cancel_on_drop = cancellation.clone().drop_guard();
            let operation = async {
                self.check(&call).await?;
                let session = self.metadata(&input.session_id).await.map_err(failed)?;
                let selected = if let Some(invocation) = call.identity.agent() {
                    Some(self.scoped_store(&call, &invocation.session_id).await?)
                } else {
                    None
                };
                let context = self
                    .store
                    .history_context(
                        &self.prefix,
                        &input.session_id,
                        &input.anchor_message_id,
                        input.before.unwrap_or(8),
                        input.after.unwrap_or(8),
                        through,
                        exclusion(&call),
                        selected.as_ref(),
                        cancellation,
                    )
                    .await
                    .map_err(failed)?;
                let anchor = search::Anchor {
                    message_id: context.anchor.message_id.clone(),
                    position: context.anchor.position,
                    turn_id: context.anchor.turn_id.clone(),
                };
                let mut messages = context
                    .messages
                    .into_iter()
                    .map(indexed_message)
                    .collect::<Vec<_>>();
                messages.push(indexed_message(context.anchor));
                messages.sort_by_key(|message| message.position);
                self.check(&call).await?;
                Ok(search::Context {
                    session: search::Session {
                        id: session.id,
                        title: session.configuration.title,
                        last_message_at: session.last_message.map(|message| message.recorded_at),
                    },
                    anchor,
                    messages,
                    has_more_before: context.has_more_before,
                    has_more_after: context.has_more_after,
                })
            };
            tokio::select! {
                biased;
                _ = call.cancellation.cancelled() => Err(failed("Recall cancelled")),
                _ = self.stop.cancelled() => Err(failed("Recall cancelled")),
                result = operation => result,
            }
        })
    }
}
enum Input {
    Search(search::Query),
    More(search::More),
    Material(search::Material),
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
                    let mut value: search::Query =
                        serde_json::from_value(input).map_err(invalid)?;
                    value.validate().map_err(invalid)?;
                    Input::Search(value)
                }
                "RecallMore" => {
                    let value: search::More = serde_json::from_value(input).map_err(invalid)?;
                    value.validate().map_err(invalid)?;
                    Input::More(value)
                }
                "RecallMaterial" => {
                    let value: search::Material = serde_json::from_value(input).map_err(invalid)?;
                    value.validate().map_err(invalid)?;
                    Input::Material(value)
                }
                _ => return Err(ToolRejection::Unavailable),
            };
            Ok(PreparedEffect::new(move |cancellation| {
                Box::pin(async move {
                    // The Engine supplies the admitted ToolCallContext. The
                    // original native activation owns the request and settlement.
                    let request = recall
                        .services
                        .request_with_execution(
                            maka_capabilities::call::Identity::Agent {
                                invocation: context.invocation,
                                operation_id: Some(context.operation_id),
                            },
                            cancellation,
                            context
                                .execution
                                .ok_or_else(|| failed("Execution custody unavailable"))?,
                        )
                        .map_err(failed)?;
                    let call = request.scope();
                    let result = async {
                        recall.check(call).await?;
                        if let Input::Material(material) = input {
                            return recall.material(call.clone(), material).await;
                        }
                        let found = match input {
                            Input::Search(query) => {
                                search::search(
                                    recall.clone(),
                                    call,
                                    &query,
                                    search::Content::Context {
                                        before: 4,
                                        after: 4,
                                    },
                                )
                                .await?
                            }
                            Input::More(more) => search::more(recall.clone(), call, &more).await?,
                            Input::Material(_) => unreachable!(),
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
            }))
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

fn exclusion(call: &Scope) -> Option<(String, String)> {
    call.identity
        .agent()
        .map(|invocation| (invocation.session_id.clone(), invocation.turn_id.clone()))
}
fn indexed_message(hit: maka_event_log::recall::SearchHit) -> search::Message {
    search::Message {
        message_id: hit.message_id,
        position: hit.position,
        turn_id: hit.turn_id,
        timestamp: hit.timestamp,
        role: hit.role,
        text: hit.body,
        attachments: hit.attachments,
    }
}

mod material;
mod preview;
