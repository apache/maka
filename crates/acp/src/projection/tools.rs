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

impl Projection {
    pub fn tool(
        &mut self,
        event: &SessionToolEvent,
    ) -> Result<Vec<acp::SessionUpdate>, crate::Error> {
        let (turn, id) = match event {
            SessionToolEvent::ToolStart {
                turn_id,
                tool_use_id,
                ..
            }
            | SessionToolEvent::ToolProgress {
                turn_id,
                tool_use_id,
                ..
            }
            | SessionToolEvent::ToolResult {
                turn_id,
                tool_use_id,
                ..
            } => (turn_id, tool_use_id),
        };
        let tool = self.ensure_tool(turn, id)?;
        match event {
            SessionToolEvent::ToolStart { tool_name, .. } => {
                if !tool.authoritative {
                    tool.card.title = MaybeUndefined::Value(bounded(tool_name, 4096));
                    tool.card.name = MaybeUndefined::Value(tool_name.clone());
                }
            }
            SessionToolEvent::ToolProgress { chunk, .. } => {
                if tool.announced || tool.authoritative {
                    return Ok(vec![]);
                }
                tool.card.content =
                    MaybeUndefined::Value(text_content(&bounded(chunk, TOOL_BYTES)));
            }
            SessionToolEvent::ToolResult { status, .. } => {
                if tool.authoritative {
                    return Ok(vec![]);
                }
                if !tool.announced
                    && let MaybeUndefined::Value(content) = &mut tool.card.content
                {
                    content.extend(text_content("[Awaiting durable tool result]"));
                }
                tool.announced = true;
                tool.card.status =
                    MaybeUndefined::Value(if *status == ToolResultStatus::Completed {
                        acp::ToolCallStatus::Completed
                    } else {
                        acp::ToolCallStatus::Failed
                    });
                tool.meta("resultPending", json!(true));
            }
        }
        self.publish(id)
    }

    pub(super) fn tool_row(
        &mut self,
        row: &Value,
        turn: &str,
        id: &str,
    ) -> Result<Vec<acp::SessionUpdate>, crate::Error> {
        if row["type"] == "tool_call" {
            let name = required(row, "toolName")?;
            let tool = self.ensure_tool(turn, id)?;
            tool.card.name = MaybeUndefined::Value(name.into());
            tool.card.title =
                MaybeUndefined::Value(bounded(row["displayName"].as_str().unwrap_or(name), 4096));
            tool.card.kind = MaybeUndefined::Value(match row["activityKind"].as_str() {
                Some("read") => acp::ToolKind::Read,
                Some("search" | "websearch" | "explore") => acp::ToolKind::Search,
                Some("webfetch") => acp::ToolKind::Fetch,
                Some("edit") => acp::ToolKind::Edit,
                Some("command") => acp::ToolKind::Execute,
                _ => acp::ToolKind::Other,
            });
            // Clear previously shown input when this durable card suppresses it.
            tool.card.raw_input = match row.get("args") {
                Some(args) if !matches!(name, "WriteStdin" | "todo_write") => {
                    MaybeUndefined::Value(bounded_value(args))
                }
                _ => MaybeUndefined::Null,
            };
            self.publish(id)
        } else {
            let tool_id = required(row, "toolUseId")?;
            let result = row.get("content").ok_or("Tool result content is missing")?;
            // isError describes the call, not the observed background job.
            let failed = row["isError"]
                .as_bool()
                .ok_or("Tool result status is missing")?;
            let tool = self.ensure_tool(turn, tool_id)?;
            tool.authoritative = true;
            tool.card.status = MaybeUndefined::Value(if failed {
                acp::ToolCallStatus::Failed
            } else {
                acp::ToolCallStatus::Completed
            });
            tool.meta("resultPending", json!(false));
            tool.card.content = MaybeUndefined::Value(result_content(result));
            tool.card.raw_output = MaybeUndefined::Value(bounded_value(result));
            self.publish(tool_id)
        }
    }

    /// Call after durable transcript catchup and authoritative turn settlement.
    pub fn finish(
        &mut self,
        turn: &str,
        completed: bool,
    ) -> Result<Vec<acp::SessionUpdate>, crate::Error> {
        if completed
            && self
                .tools
                .values()
                .any(|tool| tool.turn == turn && tool.announced && !tool.authoritative)
        {
            return Err("Completed turn is missing an announced durable tool result".into());
        }
        let ids: Vec<_> = self
            .tools
            .iter()
            .filter(|(_, tool)| tool.turn == turn && !tool.authoritative)
            .map(|(id, _)| id.clone())
            .collect();
        let mut updates = vec![];
        for id in ids {
            let tool = self.tools.get_mut(&id).expect("existing tool");
            tool.card.status = MaybeUndefined::Value(acp::ToolCallStatus::Failed);
            tool.meta("hostStatus", json!("interrupted"));
            tool.meta("resultPending", json!(false));
            updates.extend(self.publish(&id)?);
        }
        Ok(updates)
    }

    fn ensure_tool(&mut self, turn: &str, id: &str) -> Result<&mut Tool, crate::Error> {
        if !self.tools.contains_key(id) {
            if self.tools.len() + self.streams.len() >= IDENTITIES {
                return Err("ACP presentation identity limit exceeded".into());
            }
            self.tools.insert(
                id.to_owned(),
                Tool {
                    turn: turn.to_owned(),
                    published: None,
                    published_bytes: 0,
                    authoritative: false,
                    announced: false,
                    card: acp::ToolCallUpdate::new(id.to_owned())
                        .title(id.to_owned())
                        .kind(acp::ToolKind::Other)
                        .status(acp::ToolCallStatus::InProgress)
                        .content(Vec::<acp::ToolCallContent>::new())
                        .meta(acp::Meta::from_iter([(
                            "maka".into(),
                            json!({"turnId":turn}),
                        )])),
                },
            );
        }
        let tool = self.tools.get_mut(id).expect("inserted tool");
        if tool.turn != turn {
            return Err("Tool identity changed its turn".into());
        }
        Ok(tool)
    }

    fn publish(&mut self, id: &str) -> Result<Vec<acp::SessionUpdate>, crate::Error> {
        let tool = self.tools.get_mut(id).expect("existing tool");
        if tool.published.as_ref() == Some(&tool.card) {
            return Ok(vec![]);
        }
        let size = serde_json::to_vec(&tool.card)?.len();
        if self.bytes - tool.published_bytes + size > TOTAL_BYTES {
            return Err("ACP tool presentation limit exceeded".into());
        }
        self.bytes = self.bytes - tool.published_bytes + size;
        tool.published_bytes = size;
        tool.published = Some(tool.card.clone());
        Ok(vec![acp::SessionUpdate::ToolCallUpdate(tool.card.clone())])
    }
}

impl Tool {
    fn meta(&mut self, key: &str, value: Value) {
        if let MaybeUndefined::Value(meta) = &mut self.card.meta {
            meta["maka"][key] = value;
        }
    }
}

fn text_content(text: &str) -> Vec<acp::ToolCallContent> {
    vec![acp::ToolCallContent::Content(Box::new(acp::Content::new(
        text,
    )))]
}

fn result_content(result: &Value) -> Vec<acp::ToolCallContent> {
    // Host file_diff lacks the absolute-path git_patch contract required by ACP.
    let text = match result["kind"].as_str() {
        Some("text") => result["text"].as_str().map(str::to_owned),
        Some("file_diff") => result["diff"].as_str().map(str::to_owned),
        Some("summary") => result["summarized"].as_str().map(str::to_owned),
        Some("subagent" | "rive_workflow") => result["summary"].as_str().map(str::to_owned),
        Some("json") => Some(
            result["value"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| result["value"].to_string()),
        ),
        _ => None,
    }
    .unwrap_or_else(|| result.to_string());
    text_content(&bounded(&text, TOOL_BYTES))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tool_terminal_requires_durable_result_and_explicit_bounded_presentation() {
        let mut projection = Projection::default();
        let event = SessionToolEvent::ToolResult {
            id: "e".into(),
            turn_id: "t".into(),
            ts: 0,
            tool_use_id: "call".into(),
            operation_id: None,
            status: ToolResultStatus::Completed,
        };
        assert_eq!(projection.tool(&event).unwrap().len(), 1);
        assert!(projection.finish("t", true).is_err());
        let row = json!({"type":"tool_result","id":"result","turnId":"t","toolUseId":"call","isError":false,"content":{"kind":"text","text":"中".repeat(TOOL_BYTES)}});
        let updates = projection.row(&row).unwrap();
        assert!(matches!(updates[0], acp::SessionUpdate::ToolCallUpdate(_)));
        let update = serde_json::to_value(&updates[0]).unwrap();
        assert_eq!(update["status"], "completed");
        assert_eq!(update["rawOutput"]["truncated"], true);
        assert!(
            update["content"][0]["content"]["text"]
                .as_str()
                .unwrap()
                .ends_with("[Presentation truncated]")
        );
        assert!(projection.row(&row).unwrap().is_empty());
        assert!(projection.finish("t", true).unwrap().is_empty());
    }
}
