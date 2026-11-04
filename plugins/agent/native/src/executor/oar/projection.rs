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
use maka_agent_facts::executor::Output;

pub(super) async fn emit(event: Value, output: &dyn OutputSink) -> Result<(), Error> {
    let kind = text(&event, "kind")?;
    let path = event
        .get("agentPath")
        .and_then(Value::as_array)
        .ok_or_else(|| Error::Invalid("OAR event has no agent path".into()))?;
    let call = || -> Result<String, Error> {
        Ok(
            serde_json::to_string(&(event.get("sessionId"), path, text(&event, "callId")?))
                .expect("OAR activity identity"),
        )
    };
    let observed = match kind {
        "text_delta" if path.is_empty() => Some(Output::OutputDelta {
            text: text(&event, "text")?.into(),
        }),
        "reasoning"
            if path.is_empty()
                && event.pointer("/content/kind").and_then(Value::as_str) == Some("text") =>
        {
            Some(Output::ThinkingDelta {
                text: event
                    .pointer("/content/text")
                    .and_then(Value::as_str)
                    .ok_or_else(|| Error::Invalid("OAR reasoning has no text".into()))?
                    .into(),
            })
        }
        "tool_call_started" => Some(Output::ToolStart {
            tool_call_id: call()?,
            name: text(&event, "tool")?.into(),
            input: event
                .get("input")
                .and_then(Value::as_str)
                .map(|value| serde_json::from_str(value).unwrap_or_else(|_| value.into()))
                .unwrap_or(Value::Null),
        }),
        "tool_call_input" => Some(Output::ToolProgress {
            tool_call_id: call()?,
            text: format!("Input: {}", text(&event, "input")?),
        }),
        "tool_call_input_delta" => Some(Output::ToolProgress {
            tool_call_id: call()?,
            text: text(&event, "delta")?.into(),
        }),
        "tool_call_progress" => Some(Output::ToolProgress {
            tool_call_id: call()?,
            text: serde_json::to_string(&event).expect("OAR progress"),
        }),
        "tool_call_ended" => Some(Output::ToolResult {
            tool_call_id: call()?,
            text: event
                .get("content")
                .map(|v| serde_json::to_string(v).expect("OAR result"))
                .unwrap_or_default(),
            is_error: event.get("result").and_then(Value::as_str) == Some("failed"),
        }),
        _ => None,
    };
    if let Some(observed) = observed {
        output.emit(observed).await?;
    }
    Ok(())
}
fn text<'a>(event: &'a Value, key: &str) -> Result<&'a str, Error> {
    event
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Invalid(format!("OAR event is missing {key}")))
}
