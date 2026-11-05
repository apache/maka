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
use runtime::{Pipe, string};

pub(super) async fn execute(
    mut io: Pipe,
    request: &Value,
    storage: &Storage,
    journal: &mut journal::Journal,
    output: Arc<dyn OutputSink>,
    bridge: Arc<mcp::Bridge>,
) -> (Result<Outcome, Error>, Pipe) {
    let result = run(&mut io, request, storage, journal, output.as_ref(), &bridge).await;
    bridge.close_admission();
    if result.is_err()
        && let Some(session) = journal.native_session()
    {
        io.control("session/cancel", serde_json::json!({"sessionId":session}))
            .await;
    }
    (result, io)
}
async fn run(
    io: &mut Pipe,
    request: &Value,
    storage: &Storage,
    journal: &mut journal::Journal,
    output: &dyn OutputSink,
    bridge: &mcp::Bridge,
) -> Result<Outcome, Error> {
    let (initialized, _) = io.request("initialize", serde_json::json!({"protocolVersion":1,"clientInfo":{"name":"maka","version":env!("CARGO_PKG_VERSION")},"clientCapabilities":{}})).await?;
    if initialized.get("protocolVersion").and_then(Value::as_u64) != Some(1) {
        return Err(Error::Invalid("Unsupported native agy ACP protocol".into()));
    }
    if request
        .get("images")
        .and_then(Value::as_array)
        .is_some_and(|v| !v.is_empty())
        && initialized
            .pointer("/agentCapabilities/promptCapabilities/image")
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Err(Error::Invalid(
            "agy does not accept image attachments".into(),
        ));
    }
    let resume = journal.native_session().map(str::to_owned);
    let mut params = serde_json::json!({"cwd":request["cwd"],"mcpServers":[bridge.acp()]});
    if let Some(instructions) = request.get("instructions") {
        if initialized
            .pointer("/agentCapabilities/_meta/antigravity/systemPrompt/append")
            .and_then(Value::as_bool)
            != Some(true)
        {
            return Err(Error::Invalid(
                "agy does not support system prompt append".into(),
            ));
        }
        params["_meta"] =
            serde_json::json!({"antigravity":{"systemPrompt":{"append":instructions}}});
    }
    if let Some(resume) = &resume {
        params["sessionId"] = resume.clone().into();
    }
    // agy 1.5 accepts authenticated HTTP MCP despite omitting mcpCapabilities.http.
    let (opened, _) = io
        .request(
            if resume.is_some() {
                "session/load"
            } else {
                "session/new"
            },
            params,
        )
        .await?;
    let session = match &resume {
        Some(session) => {
            if opened
                .get("sessionId")
                .and_then(Value::as_str)
                .is_some_and(|id| id != session)
            {
                return Err(Error::Invalid(
                    "agy resumed a different native session".into(),
                ));
            }
            session.clone()
        }
        None => string(&opened, "/sessionId")?.into(),
    };
    journal.opened(storage, session.clone()).await?;
    // Permission policy is the native startup flag, not an agent conversation mode.
    let mut options = opened
        .get("configOptions")
        .cloned()
        .unwrap_or(Value::Array(Vec::new()));
    for (source, category) in [("model", "model"), ("effort", "thought_level")] {
        if let Some(value) = request.get(source).and_then(Value::as_str) {
            let id = options
                .as_array()
                .into_iter()
                .flatten()
                .find(|o| {
                    o.get("category").and_then(Value::as_str)
                        == Some(if source == "effort" {
                            "thought_level"
                        } else {
                            category
                        })
                        || o.get("id").and_then(Value::as_str) == Some(category)
                })
                .and_then(|o| o.get("id"))
                .and_then(Value::as_str)
                .ok_or_else(|| Error::Invalid(format!("agy has no {source} selector")))?
                .to_owned();
            let (configured, _) = io
                .request(
                    "session/set_config_option",
                    serde_json::json!({"sessionId":session,"configId":id,"value":value}),
                )
                .await?;
            if !selected(&configured["configOptions"], &id, value) {
                return Err(Error::Invalid(format!(
                    "agy did not confirm requested {source}"
                )));
            }
            options = configured["configOptions"].clone();
        }
    }
    bridge.admit()?;
    let mut prompt = vec![serde_json::json!({"type":"text","text":request["message"]})];
    for image in request
        .get("images")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let bytes = tokio::fs::read(string(image, "/path")?)
            .await
            .map_err(|e| Error::Provider(e.to_string()))?;
        use base64::Engine;
        prompt.push(serde_json::json!({"type":"image","mimeType":image["mediaType"],"data":base64::engine::general_purpose::STANDARD.encode(bytes)}));
    }
    let id = io
        .begin(
            "session/prompt",
            serde_json::json!({"sessionId":session,"prompt":prompt}),
        )
        .await?;
    let mut text = String::new();
    loop {
        let event = io.next().await?;
        if event.get("id").and_then(Value::as_u64) == Some(id) && event.get("method").is_none() {
            if event.get("error").is_some() {
                return Err(Error::Provider("agy prompt failed".into()));
            }
            return match event.pointer("/result/stopReason").and_then(Value::as_str) {
                Some("end_turn" | "max_tokens" | "max_turn_requests") => {
                    Ok(Outcome::Completed { text })
                }
                Some("cancelled") => Err(Error::Cancelled),
                _ => Err(Error::Invalid(
                    "agy prompt returned no terminal stop reason".into(),
                )),
            };
        }
        if event.get("method").is_some() && event.get("id").is_some() {
            return io.unsupported(event).await;
        }
        if event.get("method").and_then(Value::as_str) != Some("session/update") {
            continue;
        }
        if event.pointer("/params/sessionId").and_then(Value::as_str) != Some(session.as_str()) {
            return Err(Error::Invalid("agy update session mismatch".into()));
        }
        let update = &event["params"]["update"];
        match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("agent_message_chunk" | "agent_thought_chunk")
                if update.pointer("/content/type").and_then(Value::as_str) == Some("text") =>
            {
                let delta = string(update, "/content/text")?;
                let observed = if update["sessionUpdate"] == "agent_message_chunk" {
                    text.push_str(delta);
                    Output::OutputDelta { text: delta.into() }
                } else {
                    Output::ThinkingDelta { text: delta.into() }
                };
                output.emit(observed).await?;
            }
            Some("tool_call") => {
                let tool_call_id = format!("{session}:{}", string(update, "/toolCallId")?);
                output
                    .emit(Output::ToolStart {
                        tool_call_id,
                        name: update
                            .get("title")
                            .and_then(Value::as_str)
                            .unwrap_or("native tool")
                            .into(),
                        input: update.get("rawInput").cloned().unwrap_or(Value::Null),
                    })
                    .await?;
            }
            Some("tool_call_update") => {
                let tool_call_id = format!("{session}:{}", string(update, "/toolCallId")?);
                if matches!(
                    update.get("status").and_then(Value::as_str),
                    Some("completed" | "failed")
                ) {
                    output
                        .emit(Output::ToolResult {
                            tool_call_id,
                            text: serde_json::to_string(&update["content"])
                                .expect("ACP content is JSON"),
                            is_error: update["status"] == "failed",
                        })
                        .await?;
                }
            }
            _ => {}
        }
    }
}
fn selected(options: &Value, id: &str, value: &str) -> bool {
    options.as_array().is_some_and(|options| {
        options.iter().any(|option| {
            option.get("id").and_then(Value::as_str) == Some(id)
                && option.get("currentValue").and_then(Value::as_str) == Some(value)
        })
    })
}
