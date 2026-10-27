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

//! Sparse cross-group codec dependencies. Both producer and consumer IDs are
//! indexed, and every hit is checked against the fixed logical root.
use super::*;
use maka_agent_facts::model::prompt::AssistantPart;
use std::collections::BTreeSet;

fn mcp_call(part: &AssistantPart) -> Option<&str> {
    if let AssistantPart::ToolCall {
        tool_call_id,
        provider_executed: Some(true),
        provider_options: Some(options),
        ..
    } = part
        && options["anthropic"]["type"] == "mcp-tool-use"
    {
        Some(tool_call_id)
    } else {
        None
    }
}
pub(super) fn extract(messages: &[Message]) -> Vec<(usize, String)> {
    let mut ids = Vec::new();
    for (index, message) in messages.iter().enumerate() {
        let Message::Assistant { content, .. } = message else {
            continue;
        };
        for part in content {
            if let Some(id) = mcp_call(part) {
                ids.push((index, id.to_owned()));
            }
        }
    }
    ids
}
pub(super) fn needed(messages: &[Message]) -> Vec<String> {
    let mut local = BTreeSet::new();
    let mut needed = BTreeSet::new();
    for message in messages {
        let Message::Assistant { content, .. } = message else {
            break;
        };
        for part in content {
            if let Some(id) = mcp_call(part) {
                local.insert(id.to_owned());
            } else if let AssistantPart::ToolResult { tool_call_id, .. } = part
                && !local.contains(tool_call_id)
            {
                needed.insert(tool_call_id.clone());
            }
        }
    }
    needed.into_iter().collect()
}
pub(super) async fn prior(
    connection: &mut SqliteConnection,
    view: &PreparedView,
    sequence: u64,
    wanted: &[String],
) -> Result<Vec<String>, StoreError> {
    if wanted.is_empty() {
        return Ok(Vec::new());
    }
    let (before, tail) = tree::before_role_tail(connection, view.root.as_deref(), sequence).await?;
    if tail == 0 {
        return Ok(Vec::new());
    }
    let floor = before - tail;
    let mut found = BTreeSet::new();
    for id in wanted {
        let mut cursor = sequence as i64;
        loop {
            // Seek one distinct semantic group. The lookup index skips all of
            // that group's old content versions when the cursor advances.
            let candidate: Option<i64> = sqlx::query_scalar(
                "SELECT group_sequence FROM context_prepared_mcp_ids WHERE call_id=? AND group_sequence<? ORDER BY group_sequence DESC LIMIT 1",
            )
            .bind(id)
            .bind(cursor)
            .fetch_optional(&mut *connection)
            .await?;
            let Some(sequence) = candidate else {
                break;
            };
            cursor = sequence;
            let Some((base, content)) =
                tree::location(connection, view.root.as_deref(), sequence as u64).await?
            else {
                continue;
            };
            // Current content is already known from this immutable root. Probe
            // its exact PK range instead of materializing historical versions
            // or accidentally skipping a later producer within the same group.
            if base < before {
                let present: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM context_prepared_mcp_ids WHERE content_id=? AND call_id=? AND group_sequence=? AND message_index>=? AND message_index<?)",
                )
                .bind(content)
                .bind(id)
                .bind(sequence)
                .bind(floor.saturating_sub(base) as i64)
                .bind((before-base) as i64)
                .fetch_one(&mut *connection)
                .await?;
                if present {
                    found.insert(id.clone());
                    break;
                }
            }
            // Check this group before stopping: its last messages may straddle
            // the role boundary. Earlier groups end at or before this base.
            if base <= floor {
                break;
            }
        }
    }
    Ok(found.into_iter().collect())
}
/// An owner-local cursor over direct call dependencies and the following role run.
#[derive(Clone)]
pub(super) struct Discovery {
    sequence: u64,
    new_content: String,
    old_content: Option<String>,
    phase: u8,
    call: Option<String>,
    after_sequence: i64,
    after_content: String,
    boundary_end: Option<u64>,
}
impl Discovery {
    pub(super) async fn new(
        db: &mut SqliteConnection,
        view: &PreparedView,
        old_root: Option<&str>,
        sequence: u64,
    ) -> Result<Self, StoreError> {
        let new_content = tree::content_id(db, view.root.as_deref(), sequence).await?;
        let new_group = tree::group(db, &new_content).await?;
        let old_content = tree::location(db, old_root, sequence)
            .await?
            .map(|(_, content)| content);
        let old_roles = if let Some(content) = &old_content {
            tree::group(db, content)
                .await?
                .messages
                .into_iter()
                .map(|m| m.assistant)
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        let boundary_end = if old_roles
            != new_group
                .messages
                .iter()
                .map(|m| m.assistant)
                .collect::<Vec<_>>()
        {
            Some(
                tree::next_nonassistant(db, view.root.as_deref(), sequence)
                    .await?
                    .unwrap_or(i64::MAX as u64),
            )
        } else {
            None
        };
        Ok(Self {
            sequence,
            new_content,
            old_content,
            phase: 0,
            call: None,
            after_sequence: sequence as i64,
            after_content: String::new(),
            boundary_end,
        })
    }
    /// At most one page of metadata candidates; no rendered payloads are read.
    pub(super) async fn advance(
        &mut self,
        db: &mut SqliteConnection,
        view: &PreparedView,
        wire_id: &str,
    ) -> Result<bool, StoreError> {
        if self.phase == 0 {
            let call:Option<String>=sqlx::query_scalar("SELECT call_id FROM context_prepared_mcp_ids WHERE content_id IN (?1,?2) AND (?3 IS NULL OR call_id>?3) GROUP BY call_id ORDER BY call_id LIMIT 1")
                .bind(&self.new_content).bind(&self.old_content).bind(&self.call).fetch_optional(&mut *db).await?;
            self.after_sequence = self.sequence as i64;
            self.after_content.clear();
            if let Some(call) = call {
                self.call = Some(call);
                self.phase = 1;
            } else {
                self.phase = 2;
            }
        }
        let rows: Vec<(i64, String)> = if self.phase == 1 {
            sqlx::query_as("SELECT group_sequence,content_id FROM context_prepared_mcp_refs WHERE call_id=?1 AND group_sequence>?2 AND (group_sequence,content_id)>(?3,?4) ORDER BY group_sequence,content_id LIMIT 64")
                .bind(&self.call).bind(self.sequence as i64).bind(self.after_sequence).bind(&self.after_content).fetch_all(&mut *db).await?
        } else if let Some(end) = self.boundary_end {
            sqlx::query_as("SELECT DISTINCT group_sequence,content_id FROM context_prepared_mcp_refs WHERE group_sequence>?1 AND group_sequence<=?2 AND (group_sequence,content_id)>(?3,?4) ORDER BY group_sequence,content_id LIMIT 64")
                .bind(self.sequence as i64).bind(end as i64).bind(self.after_sequence).bind(&self.after_content).fetch_all(&mut *db).await?
        } else {
            return Ok(true);
        };
        if rows.is_empty() {
            if self.phase == 1 {
                self.phase = 0;
                return Ok(false);
            }
            return Ok(true);
        }
        for (sequence, content) in rows {
            if let Some((_, current)) =
                tree::location(db, view.root.as_deref(), sequence as u64).await?
                && current == content
            {
                sqlx::query("INSERT INTO context_prepared_wire_dirty(view_id,group_sequence) VALUES(?,?) ON CONFLICT(view_id,group_sequence) DO NOTHING")
                    .bind(wire_id).bind(sequence).execute(&mut *db).await?;
            }
            self.after_sequence = sequence;
            self.after_content = content;
        }
        Ok(false)
    }
}
impl EventLog {
    pub async fn prepared_prior_mcp_ids(
        &self,
        view: &PreparedView,
        group: &PreparedGroup,
        wanted: &[String],
    ) -> Result<Vec<String>, StoreError> {
        self.validate_root()?;
        let expected_session = self.expected_session.clone();
        let scope_id = view.build_id.clone();
        view.lease.validate(&self.prepared)?;
        self.check_bound_session(&view.selection.session)?;
        let view = view.clone();
        let sequence = group_number(group)?;
        let wanted = wanted.to_vec();
        self.prepared_store()?
            .read_interruptible(move |connection| {
                Box::pin(async move {
                    let mut scope_transaction = connection.begin().await?;
                    let connection = &mut *scope_transaction;
                    require_build_session(connection, expected_session.as_deref(), &scope_id)
                        .await?;
                    prior(connection, &view, sequence, &wanted).await
                })
            })
            .await
    }
}
