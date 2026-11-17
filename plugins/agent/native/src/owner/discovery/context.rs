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
use maka_agent_state::session_catalog::{Filter, Position};
use maka_event_log::sessions::{CatalogFilter, CatalogScope, CatalogSelection, MAX_SESSION_PAGE};

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

impl Owner {
    pub(super) async fn discovery_opening(
        &self,
        job: &Job,
        previous: Option<&Run>,
    ) -> Result<String, String> {
        let last_investigation = self.scheduler.opening_reference(job, previous).await?;
        let mut recent = Vec::new();
        if job
            .tools
            .names
            .iter()
            .any(|name| name == "SessionRead" || self.discovery_reads.contains(name))
        {
            let target = &job.approval.target;
            let page = self
                .canonical_catalog()?
                .page(
                    CatalogScope::Owned {
                        id_prefix: self.prefix.clone(),
                        selection: CatalogSelection::Workspace {
                            session_id: target.session_id.clone(),
                            path: target.workspace.path.clone(),
                        },
                        title_query: String::new(),
                    },
                    None,
                    Position::Start,
                    Filter {
                        base: CatalogFilter {
                            roots_only: true,
                            archived_only: false,
                            include_archived: true,
                        },
                        needs_you_only: false,
                        room: Some(false),
                    },
                    MAX_SESSION_PAGE as u32,
                )
                .await
                .map_err(reason)?;
            recent.extend(page.sessions.into_iter().filter_map(|record| {
                let binding = record.metadata.workspace_binding.as_ref()?;
                if binding.stamp() != target.binding {
                    return None;
                }
                Some((record.last_message?.recorded_at, record.metadata.id))
            }));
            recent.sort_unstable_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        }
        if last_investigation.is_none() && recent.is_empty() {
            return Ok(String::new());
        }
        let recent_conversations: Vec<_> = recent.into_iter().take(6)
            .map(|(at, session_id)| serde_json::json!({"session_id":session_id,"path":format!("maka://session/{session_id}"),"last_message_at":timestamp(at)}))
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
}
