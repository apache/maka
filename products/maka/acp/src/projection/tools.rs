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
        self.tools.get(id).and_then(|tool| tool.position)
    }

    pub fn unsettled_tool_positions(
        &self,
    ) -> impl Iterator<Item = maka_agent_ports::session::history::RowPosition> + '_ {
        self.tools
            .values()
            .filter(|tool| !tool.authoritative)
            .filter_map(|tool| tool.position)
    }

    pub(super) fn tool_chunk(
        &mut self,
        chunk: &HistoryChunk,
        text: &str,
    ) -> Result<Vec<acp::SessionUpdate>, crate::Error> {
        let source = chunk
            .tool
            .as_ref()
            .ok_or("Tool history omitted its canonical reference")?;
        let tool = self.ensure_tool(&chunk.turn_id, &source.tool_use_id)?;
        if let Some(call) = &source.call {
            tool.position = Some(call.position);
            tool.card.name = MaybeUndefined::Value(call.name.clone());
            tool.card.title = MaybeUndefined::Value(
                call.title
                    .as_ref()
                    .map_or(call.name.as_str(), |title| title.fallback.as_str())
                    .to_owned(),
            );
            tool.meta("presentation", json!(call.presentation));
        }
        if let Some(result) = &source.result {
            tool.authoritative = true;
            tool.card.status = MaybeUndefined::Value(
                if result.is_error
                    || matches!(
                        result.settlement,
                        Some(
                            maka_agent_facts::tool_call::ToolSettlement::Unknown
                                | maka_agent_facts::tool_call::ToolSettlement::Rejected
                                | maka_agent_facts::tool_call::ToolSettlement::Failed
                        )
                    )
                {
                    acp::ToolCallStatus::Failed
                } else {
                    acp::ToolCallStatus::Completed
                },
            );
            tool.meta("settlement", json!(result.settlement));
            tool.meta("image", json!(result.image));
        }
        if chunk.role == Role::ToolResult {
            tool.card.content = MaybeUndefined::Value(text_content(text));
        } else {
            tool.card.raw_input = MaybeUndefined::Value(json!({"preview":text}));
        }
        self.publish(&source.tool_use_id)
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
                .any(|tool| tool.turn == turn && !tool.authoritative)
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
            self.tools.insert(
                id.to_owned(),
                Tool {
                    turn: turn.to_owned(),
                    published: None,
                    authoritative: false,
                    position: None,
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn complete_tool_output_survives_acp_projection() {
        let text = "result".repeat(20_000);
        let chunk: HistoryChunk = serde_json::from_value(json!({
            "field":"body", "messageId":"result", "turnId":"turn", "timestamp":1,
            "role":"tool_result", "position":{"sourceSequence":2,"itemIndex":0}, "offset":0, "totalBytes":text.len(), "text":text,
            "tool":{"toolUseId":"call", "call":null,
                "result":{"position":{"sourceSequence":2,"itemIndex":0},"settlement":"returned","isError":false,"image":false}}
        }))
        .unwrap();
        let mut projection = Projection::default();
        let updates = projection.chunk(&chunk).unwrap();
        let encoded = serde_json::to_value(&updates[0]).unwrap();
        assert_eq!(encoded["content"][0]["content"]["text"], text);
    }
}
