/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
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
use jiff::{Timestamp, tz::TimeZone};
use maka_agent_ports::session::history::{Cursor, HistoryView, Role};
use maka_agent_state::session_catalog::{Filter, Page, Position};
use maka_capabilities::call::Identity;
use maka_event_log::sessions::{CatalogFilter, CatalogScope, CatalogSelection, MAX_SESSION_PAGE};

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct SessionCursor {
    revision: String,
    cursor: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Input {
    /// Browse conversations in the investigation's workspace, including archived ones.
    List { after: Option<SessionCursor> },
    /// Read conversation text. Omit session_id for the Bot's user messages.
    /// Pass the returned through and before fields to read earlier messages.
    History {
        session_id: Option<String>,
        through: Option<u64>,
        before: Option<Cursor>,
    },
}

pub(super) fn timestamp(ms: u64) -> Option<String> {
    Timestamp::from_millisecond(i64::try_from(ms).ok()?)
        .ok()
        .map(|time| time.to_string())
}

pub(super) fn local_timestamp(ms: u64, timezone: &str) -> Option<String> {
    let time = Timestamp::from_millisecond(i64::try_from(ms).ok()?).ok()?;
    let zone = TimeZone::get(timezone).ok()?;
    Some(time.to_zoned(zone).strftime("%FT%T%:z").to_string())
}

pub(super) fn environment(language: Language, workspace: &str, timezone: &str) -> String {
    let at = now();
    let time = local_timestamp(at, timezone)
        .or_else(|| timestamp(at))
        .unwrap_or_default();
    match language {
        Language::ZhCn => format!("\n\n当前时间：{time}。工作区：{workspace}"),
        Language::ZhTw => format!("\n\n目前時間：{time}。工作區：{workspace}"),
        _ => format!("\n\nCurrent time: {time}. Workspace: {workspace}"),
    }
}

impl scheduler::Scheduler {
    pub(in crate::owner) fn discovery_context_tool(self: &Arc<Self>) -> ToolRegistration {
        ToolRegistration {
            definition: ToolDefinition {
                provider: None,
                name: CONTEXT.into(),
                description: "Browse historical conversations in this investigation's workspace with list, then read their original messages with history. Follow the returned cursors for older material. Read prior discovery notifications through DiscoveryMemory.".into(),
                input_schema: serde_json::to_value(schemars::schema_for!(Input))
                    .expect("discovery context schema"),
                output_schema: None,
                freeform: None,
            },
            nesting: ToolNesting::Nestable,
            semantics: ToolSemantics::Parallel,
            handler: ToolHandler::Prepared(self.clone()),
        }
    }

    pub(in crate::owner) fn prepare_discovery_context(
        &self,
        input: Value,
        context: ToolCallContext,
        cancellation: CancellationToken,
    ) -> PreparationFuture {
        let owner = self.link.get().and_then(Weak::upgrade);
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(ToolRejection::Cancelled);
            }
            let owner = owner.ok_or(ToolRejection::Unavailable)?;
            let input =
                serde_json::from_value(input).map_err(|error| ToolRejection::InvalidInput {
                    message: error.to_string(),
                })?;
            Ok(PreparedEffect::new(move |cancel| {
                Box::pin(async move {
                    owner
                        .discovery_context(context, input, cancel)
                        .await
                        .map(Into::into)
                })
            }))
        })
    }
}

impl Owner {
    pub(super) async fn discovery_opening(
        &self,
        job: &Job,
        previous: Option<&Run>,
    ) -> Result<String, String> {
        let last_investigation = self.scheduler.opening_reference(job, previous).await?;
        let mut recent = Vec::new();
        if job.recall {
            let page = self
                .discovery_conversation_page(&job.approval.target, None)
                .await?;
            recent.extend(page.sessions.into_iter().filter_map(|record| {
                let at = record.last_message?.recorded_at;
                Some((at, record.metadata.id))
            }));
            recent.sort_unstable_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        }
        if last_investigation.is_none() && recent.is_empty() {
            return Ok(String::new());
        }
        let recent_conversations: Vec<_> = recent.into_iter().take(6)
            .map(|(at, session_id)| serde_json::json!({"session_id":session_id,"last_message_at":timestamp(at)}))
            .collect();
        let guidance = match job.approval.language {
            Language::ZhCn => {
                "调查开场引用。可用 DiscoveryMemory 和已获准的会话历史工具按需读取。近期会话仅提供调查入口，可以继续查找其他相关资料。"
            }
            Language::ZhTw => {
                "調查開場引用。可用 DiscoveryMemory 和已獲准的對話歷史工具按需讀取。近期對話僅提供調查入口，可以繼續尋找其他相關資料。"
            }
            _ => {
                "Discovery opening references. Use DiscoveryMemory and authorized conversation history as needed. Recent conversations are starting points. Continue exploring other relevant material."
            }
        };
        Ok(format!(
            "\n\n{guidance}\n{}",
            serde_json::json!({"last_investigation":last_investigation,"recent_conversations":recent_conversations})
        ))
    }

    async fn discovery_context(
        &self,
        context: ToolCallContext,
        input: Input,
        cancel: CancellationToken,
    ) -> Result<Value, ToolError> {
        let fail = ToolError::Failed;
        if cancel.is_cancelled() {
            return Err(fail("Discovery context cancelled".into()));
        }
        let job = {
            let _gate = self.scheduler.gate.lock().await;
            let (_, job) = self.scheduler.investigation().await.map_err(fail)?;
            let job = job
                .filter(|job| job.recall)
                .ok_or_else(|| fail("discovery_history_unavailable".into()))?;
            self.check_discovery_invocation(&context, &job)
                .await
                .map_err(fail)?;
            job
        };

        let result = match input {
            Input::List { after } => self
                .discovery_conversations(&job, after)
                .await
                .map_err(fail)?,
            Input::History {
                session_id,
                through,
                before,
            } => {
                let session_id = session_id.unwrap_or_else(|| job.bot.clone());
                let request = self
                    .services
                    .request_with_work(
                        Identity::Agent {
                            execution: context.execution.clone(),
                            operation_id: Some(context.operation_id.clone()),
                        },
                        cancel.clone(),
                        context
                            .custody
                            .clone()
                            .ok_or_else(|| fail("Execution custody unavailable".into()))?,
                    )
                    .map_err(fail)?;
                let result = self
                    .discovery_history(request.scope(), &job, session_id, through, before)
                    .await;
                request
                    .finish()
                    .await
                    .map_err(ToolError::CleanupUnconfirmed)?;
                result.map_err(fail)?
            }
        };

        if cancel.is_cancelled() {
            return Err(fail("Discovery context cancelled".into()));
        }
        self.check_discovery_invocation(&context, &job)
            .await
            .map_err(fail)?;
        Ok(result)
    }

    async fn discovery_conversations(
        &self,
        job: &Job,
        after: Option<SessionCursor>,
    ) -> Result<Value, String> {
        let page = self
            .discovery_conversation_page(&job.approval.target, after)
            .await?;
        let sessions: Vec<_> = page.sessions.into_iter()
            .map(|record| serde_json::json!({
                "session_id": record.metadata.id,
                "title": record.metadata.configuration["title"],
                "last_message_at": record.last_message.and_then(|last| timestamp(last.recorded_at)),
                "archived": record.metadata.archived,
            }))
            .collect();
        let after = page.next_cursor.map(|cursor| {
            serde_json::json!({
                "revision": page.revision,
                "cursor": cursor,
            })
        });
        Ok(serde_json::json!({"sessions": sessions, "after": after}))
    }

    async fn discovery_conversation_page(
        &self,
        target: &ScheduledTarget,
        after: Option<SessionCursor>,
    ) -> Result<Page, String> {
        let (revision, position) = match after {
            None => (None, Position::Start),
            Some(after) => (Some(after.revision), Position::After(after.cursor)),
        };
        let mut page = self
            .canonical_catalog()?
            .page(
                CatalogScope::Owned {
                    id_prefix: self.prefix.clone(),
                    selection: CatalogSelection::Workspace {
                        session_id: target.session_id.clone(),
                        identity: target.workspace.identity.clone(),
                    },
                    title_query: String::new(),
                },
                revision,
                position,
                Filter {
                    base: CatalogFilter {
                        roots_only: true,
                        archived_only: false,
                        include_archived: true,
                    },
                    needs_you_only: false,
                },
                MAX_SESSION_PAGE as u32,
            )
            .await
            .map_err(reason)?;
        page.sessions.retain(|record| {
            record
                .metadata
                .workspace_binding
                .as_ref()
                .is_some_and(|binding| binding.stamp() == target.binding)
        });
        Ok(page)
    }

    async fn discovery_history(
        &self,
        scope: &maka_capabilities::call::Scope,
        job: &Job,
        session_id: String,
        through: Option<u64>,
        before: Option<Cursor>,
    ) -> Result<Value, String> {
        let target = &job.approval.target;
        let readable = |configuration: &ResolvedConfiguration| {
            configuration.workspace.identity == target.workspace.identity
                && configuration.binding == target.binding
                && configuration.parent_session_id.is_none()
        };
        if !readable(&self.scoped_session(scope, &session_id).await?.configuration) {
            return Err("discovery_history_unavailable".into());
        }
        let HistoryPage::Ready {
            through,
            chunks,
            before,
            ..
        } = crate::service::history::read(
            self,
            scope,
            History {
                session_id: session_id.clone(),
                through,
                position: before.map_or(HistoryPosition::Tail, |cursor| HistoryPosition::Before {
                    cursor,
                }),
                include_thinking: false,
                view: HistoryView::Conversation,
            },
        )
        .await?;
        if !readable(&self.scoped_session(scope, &session_id).await?.configuration) {
            return Err("discovery_history_unavailable".into());
        }
        let is_bot = session_id == job.bot;
        let messages: Vec<_> = chunks
            .into_iter()
            .filter(|chunk| {
                (chunk.role == Role::User && chunk.origin.is_none())
                    || (chunk.role == Role::Assistant && !is_bot)
            })
            .map(|chunk| {
                serde_json::json!({
                    "role": chunk.role,
                    "message_id": chunk.message_id,
                    "at": chunk.timestamp.and_then(timestamp),
                    "offset": chunk.offset,
                    "total_bytes": chunk.total_bytes,
                    "text": chunk.text,
                    "quotes": chunk.quotes,
                })
            })
            .collect();
        Ok(
            serde_json::json!({"session_id": session_id, "through": through, "before": before, "messages": messages}),
        )
    }
}
