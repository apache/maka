// Licensed to the Apache Software Foundation (ASF) under one
// or more contributor license agreements. See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership. The ASF licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License. You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.

use super::*;
impl Projection {
    pub(super) async fn tool(
        &mut self,
        update: acp::ToolCallUpdate,
        chunk: Option<acp::ToolCallContent>,
        sink: &dyn OutputSink,
    ) -> Result<(), Error> {
        let id = update.tool_call_id.to_string();
        identity(&id)?;
        let host_id = format!("{}:{}:{id}", self.invocation_id.len(), self.invocation_id);
        if !self.tools.contains_key(&id) {
            if self.tools.len() >= 1024 {
                return Err(Error::Invalid("ACP turn exceeds 1024 tools"));
            }
            let name = match &update.name {
                MaybeUndefined::Value(name) => name.as_str(),
                _ => "ACP tool",
            };
            let input = match &update.raw_input {
                MaybeUndefined::Value(input) => input.clone(),
                _ => serde_json::Value::Null,
            };
            emit(
                sink,
                Output::ToolStart {
                    tool_call_id: host_id.clone(),
                    name: name.into(),
                    input,
                },
            )
            .await?;
            self.tools.insert(id.clone(), Tool::default());
        }
        let tool = self.tools.get_mut(&id).unwrap();
        if tool.done {
            return Err(Error::Invalid("ACP updated a completed tool call"));
        }
        let patch = serde_json::to_value(update)?;
        for (key, value) in patch.as_object().unwrap() {
            tool.snapshot.insert(key.clone(), value.clone());
        }
        if let Some(chunk) = chunk {
            let content = tool
                .snapshot
                .entry("content".to_owned())
                .or_insert_with(|| serde_json::json!([]));
            if content.is_null() {
                *content = serde_json::json!([]);
            }
            content
                .as_array_mut()
                .ok_or(Error::Invalid("invalid ACP tool content"))?
                .push(serde_json::to_value(chunk)?);
        }
        // Preserve all v2 patch fields (including explicit clears and new status
        // variants) in the observed snapshot; never coerce these through v1.
        let text = serde_json::to_string(&tool.snapshot)?;
        if text.len() > 1024 * 1024 {
            return Err(Error::Invalid("ACP tool content exceeds 1 MiB"));
        }
        emit_text(&text, sink, |text| Output::ToolProgress {
            tool_call_id: host_id.clone(),
            text,
        })
        .await?;
        if self
            .tools
            .values()
            .map(|tool| {
                serde_json::to_vec(&tool.snapshot)
                    .map(|value| value.len())
                    .unwrap_or(usize::MAX)
            })
            .sum::<usize>()
            > 1024 * 1024
        {
            return Err(Error::Invalid("ACP tool snapshots exceed 1 MiB"));
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::super::tests::{Sink, update};
    use super::*;
    #[tokio::test]
    async fn tool_snapshots_keep_explicit_clears_chunks_and_cancellation() {
        let sink = Sink::default();
        let mut projection = Projection::new("s".into(), "turn".into());
        for value in [
            serde_json::json!({"sessionUpdate":"tool_call_update", "toolCallId":"t", "name":"read", "rawInput":{"file":"x"}, "rawOutput":"old", "status":"in_progress"}),
            serde_json::json!({"sessionUpdate":"tool_call_update", "toolCallId":"t", "rawOutput":null}),
            serde_json::json!({"sessionUpdate":"tool_call_content_chunk", "toolCallId":"t", "content":{"type":"content", "content":{"type":"text","text":"partial"}}}),
            serde_json::json!({"sessionUpdate":"tool_call_update", "toolCallId":"t", "status":"cancelled"}),
        ] {
            update(&mut projection, &sink, value).await;
        }
        projection.finish(&sink, true).await.unwrap();
        let events = sink.0.lock().unwrap();
        let Output::ToolResult { text, is_error, .. } = events.last().unwrap() else {
            panic!("missing tool result");
        };
        let snapshot: serde_json::Value = serde_json::from_str(text).unwrap();
        assert!(*is_error);
        assert!(snapshot["rawOutput"].is_null());
        assert_eq!(snapshot["rawInput"]["file"], "x");
        assert_eq!(snapshot["content"][0]["content"]["text"], "partial");
        assert_eq!(snapshot["status"], "cancelled");
    }
}
