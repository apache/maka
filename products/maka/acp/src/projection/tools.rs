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
    pub fn tool_position(
        &self,
        id: &str,
    ) -> Option<maka_agent_ports::session::history::RowPosition> {
        self.tools.get(id).and_then(|tool| tool.position.clone())
    }

    pub fn unsettled_tool_positions(
        &self,
    ) -> impl Iterator<Item = maka_agent_ports::session::history::RowPosition> + '_ {
        self.tools
            .values()
            .filter(|tool| !tool.authoritative)
            .filter_map(|tool| tool.position.clone())
    }

    pub(super) fn tool_chunk(
        &mut self,
        chunk: &HistoryChunk,
        text: &str,
    ) -> Result<Vec<Update>, crate::Error> {
        let source = chunk
            .tool
            .as_ref()
            .ok_or("Tool history omitted its canonical reference")?;
        let id = if matches!(
            &chunk.position,
            maka_agent_ports::session::history::RowPosition::Live { .. }
        ) {
            source.tool_use_id.clone()
        } else {
            let position = source
                .call
                .as_ref()
                .map(|call| &call.position)
                .or_else(|| source.result.as_ref().map(|result| &result.position))
                .ok_or("Tool history omitted its source address")?;
            format!("history-tool:{}", serde_json::to_string(position)?)
        };
        let tool = self.ensure_tool(chunk.turn_id.as_deref(), &id)?;
        if tool.card.name.is_none() {
            tool.card.title = source.tool_use_id.clone();
        }
        tool.meta("toolUseId", json!(source.tool_use_id));
        tool.meta("historyPosition", serde_json::to_value(&chunk.position)?);
        tool.meta("historyOrder", serde_json::to_value(&chunk.order)?);
        if let Some(run) = chunk.run_id {
            tool.meta("runId", serde_json::to_value(run)?);
        }
        if let Some(call) = &source.call {
            tool.position = Some(call.position.clone());
            tool.card.name = Some(call.name.clone());
            tool.card.title = call
                .title
                .as_ref()
                .map_or(call.name.as_str(), |title| title.fallback.as_str())
                .to_owned();
            tool.meta("presentation", json!(call.presentation));
        }
        if let Some(result) = &source.result {
            tool.authoritative = true;
            tool.card.status = if result.is_error
                || matches!(
                    result.settlement,
                    Some(
                        maka_agent_facts::tool_call::ToolSettlement::Unknown
                            | maka_agent_facts::tool_call::ToolSettlement::Rejected
                            | maka_agent_facts::tool_call::ToolSettlement::Failed
                    )
                ) {
                ToolStatus::Failed
            } else {
                ToolStatus::Completed
            };
            tool.meta("settlement", json!(result.settlement));
            tool.meta("image", json!(result.image));
        }
        if chunk.role == Role::ToolResult
            || (chunk.role != Role::ToolCall && source.result.is_some())
        {
            tool.card.output = Some(text.into());
        } else {
            tool.card.input = Some(json!({"preview":text}));
        }
        self.publish(&id)
    }

    /// Call after run-filtered foreground catchup and authoritative settlement.
    /// A tool without a semantic Turn still requires its canonical result.
    pub fn finish(&mut self, turn: &str, completed: bool) -> Result<Vec<Update>, crate::Error> {
        if completed
            && self.tools.values().any(|tool| {
                tool.turn.as_deref().is_none_or(|owner| owner == turn) && !tool.authoritative
            })
        {
            return Err("Completed turn is missing an announced durable tool result".into());
        }
        let ids: Vec<_> = self
            .tools
            .iter()
            .filter(|(_, tool)| {
                tool.turn.as_deref().is_none_or(|owner| owner == turn) && !tool.authoritative
            })
            .map(|(id, _)| id.clone())
            .collect();
        let mut updates = vec![];
        for id in ids {
            let tool = self.tools.get_mut(&id).expect("existing tool");
            tool.card.status = ToolStatus::Failed;
            tool.meta("hostStatus", json!("interrupted"));
            tool.meta("resultPending", json!(false));
            updates.extend(self.publish(&id)?);
        }
        Ok(updates)
    }

    fn ensure_tool(&mut self, turn: Option<&str>, id: &str) -> Result<&mut Tool, crate::Error> {
        if !self.tools.contains_key(id) {
            self.tools.insert(
                id.to_owned(),
                Tool {
                    turn: turn.map(str::to_owned),
                    published: None,
                    authoritative: false,
                    position: None,
                    card: ToolCard {
                        id: id.into(),
                        title: id.into(),
                        name: None,
                        status: ToolStatus::Running,
                        input: None,
                        output: None,
                        meta: Meta::from_iter([("maka".into(), json!({"turnId":turn}))]),
                    },
                },
            );
        }
        let tool = self.tools.get_mut(id).expect("inserted tool");
        if let (Some(recorded), Some(current)) = (tool.turn.as_deref(), turn)
            && recorded != current
        {
            return Err("Tool identity changed its turn".into());
        }
        if tool.turn.is_none()
            && let Some(turn) = turn
        {
            tool.turn = Some(turn.to_owned());
            tool.meta("turnId", json!(turn));
        }
        Ok(tool)
    }

    fn publish(&mut self, id: &str) -> Result<Vec<Update>, crate::Error> {
        let tool = self.tools.get_mut(id).expect("existing tool");
        if tool.published.as_ref() == Some(&tool.card) {
            return Ok(vec![]);
        }
        tool.published = Some(tool.card.clone());
        Ok(vec![Update::Tool(tool.card.clone())])
    }
}

impl Tool {
    fn meta(&mut self, key: &str, value: Value) {
        self.card.meta["maka"][key] = value;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn complete_tool_output_survives_acp_projection() {
        let text = "result".repeat(20_000);
        let chunk: HistoryChunk = serde_json::from_value(json!({
            "field":"body", "messageId":null, "turnId":null, "timestamp":1,
            "role":"tool_result", "order":{"path":[2],"itemIndex":0},
            "position":{"kind":"live","sequence":2,"fact":"00000000-0000-4000-8000-000000000004","itemIndex":0},
            "offset":0, "totalBytes":text.len(), "text":text,
            "tool":{"toolUseId":"call", "call":null,
                "result":{"position":{"kind":"live","sequence":2,"fact":"00000000-0000-4000-8000-000000000004","itemIndex":0},"settlement":"returned","isError":false,"image":false,"images":0}}
        }))
        .unwrap();
        let mut projection = Projection::default();
        let updates = projection.chunk(&chunk).unwrap();
        let encoded = crate::presentation::wire(&updates[0]).unwrap();
        assert_eq!(encoded["content"][0]["content"]["text"], text);
    }
}
