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

pub(super) async fn proxy(
    config: &NativeCommand,
    cwd: &str,
    cancellation: CancellationToken,
) -> Result<maka_process::Command, Error> {
    let mut start = runtime::command(config, cwd).await?;
    start.args(["app-server", "daemon", "start"]);
    let mut observed = start
        .observe(
            Some(runtime::SETUP_TIMEOUT.as_secs() * 1000),
            cancellation.clone(),
        )
        .map_err(runtime::process_error)?;
    let drain = async { while observed.events.recv().await.is_some() {} };
    let (captured, ()) = tokio::join!(observed.completion, drain);
    let captured = captured.map_err(runtime::process_error)?;
    match captured.outcome {
        maka_process::ProcessOutcome::Exited(status) if status.success() => {}
        maka_process::ProcessOutcome::Interrupted {
            reason: maka_process::Termination::Cancelled,
            ..
        } => return Err(Error::Cancelled),
        _ => {
            return Err(Error::Provider(
                "Codex managed daemon start failed; a CLI with daemon/proxy support is required"
                    .into(),
            ));
        }
    }
    if cancellation.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let mut proxy = runtime::command(config, cwd).await?;
    proxy.args(["app-server", "proxy"]);
    Ok(proxy)
}

pub(super) async fn execute(
    mut io: Pipe,
    request: &Value,
    storage: &Storage,
    journal: &mut journal::Journal,
    output: Arc<dyn OutputSink>,
    bridge: Arc<mcp::Bridge>,
) -> (Result<Outcome, Error>, Pipe) {
    let mut custody = Custody::Preparing;
    let result = run(
        &mut io,
        request,
        storage,
        journal,
        output.as_ref(),
        &bridge,
        &mut custody,
    )
    .await;
    bridge.close_admission();
    let result = match custody {
        Custody::Active { thread, turn } => {
            // Proxy exit cannot settle daemon work. Interrupt only our turn and await its terminal.
            io.cancellation = CancellationToken::new();
            io.failed = CancellationToken::new();
            io.control(
                "turn/interrupt",
                serde_json::json!({"threadId":thread,"turnId":turn}),
            )
            .await;
            let drained = tokio::time::timeout(Duration::from_secs(30), async {
                loop {
                    if terminal(&io.next().await?, &thread, &turn) {
                        return Ok::<_, Error>(());
                    }
                }
            })
            .await;
            match drained {
                Ok(Ok(())) => result,
                _ => Err(Error::CleanupUnconfirmed),
            }
        }
        // A partially delivered turn/start without an acknowledgement must never be replayed.
        Custody::Submitted => Err(Error::Unknown),
        Custody::Preparing | Custody::Settled => result,
    };
    (result, io)
}
enum Custody {
    Preparing,
    Submitted,
    Active { thread: String, turn: String },
    Settled,
}
async fn run(
    io: &mut Pipe,
    request: &Value,
    storage: &Storage,
    journal: &mut journal::Journal,
    output: &dyn OutputSink,
    bridge: &mcp::Bridge,
    custody: &mut Custody,
) -> Result<Outcome, Error> {
    io.request("initialize", serde_json::json!({"clientInfo":{"name":"maka","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}})).await?;
    io.notify("initialized", serde_json::json!({})).await?;
    let resume = journal.native_session();
    let mut params = serde_json::json!({"cwd":request["cwd"],"approvalPolicy":"never","sandbox":"danger-full-access","config":{"mcp_servers":{"maka":{"url":bridge.url,"http_headers":{"Authorization":format!("Bearer {}",bridge.bearer())},"enabled":true}}}});
    for (source, target) in [
        ("model", "model"),
        ("instructions", "developerInstructions"),
    ] {
        if let Some(value) = request.get(source) {
            params[target] = value.clone();
        }
    }
    if let Some(resume) = resume {
        params["threadId"] = resume.into();
        params["excludeTurns"] = true.into();
    }
    let (opened, _) = io
        .request(
            if resume.is_some() {
                "thread/resume"
            } else {
                "thread/start"
            },
            params,
        )
        .await?;
    let thread = string(&opened, "/thread/id")?.to_owned();
    if opened.get("approvalPolicy").and_then(Value::as_str) != Some("never")
        || opened.pointer("/sandbox/type").and_then(Value::as_str) != Some("dangerFullAccess")
    {
        return Err(Error::Invalid(
            "Codex did not confirm never approval and danger-full-access".into(),
        ));
    }
    if let Some(model) = request.get("model")
        && opened.get("model") != Some(model)
    {
        return Err(Error::Invalid(
            "Codex did not confirm requested model".into(),
        ));
    }
    journal.opened(storage, thread.clone()).await?;
    bridge.admit()?;
    let mut input = vec![serde_json::json!({"type":"text","text":request["message"]})];
    for image in request
        .get("images")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        input.push(serde_json::json!({"type":"localImage","path":image["path"]}));
    }
    let mut params = serde_json::json!({"threadId":thread,"input":input,"approvalPolicy":"never","sandboxPolicy":{"type":"dangerFullAccess"}});
    if let Some(effort) = request.get("effort") {
        params["effort"] = effort.clone();
    }
    if io.cancellation.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let cancellation = std::mem::replace(&mut io.cancellation, CancellationToken::new());
    let failed = std::mem::replace(&mut io.failed, CancellationToken::new());
    *custody = Custody::Submitted;
    let (started, buffered) = io.request("turn/start", params).await?;
    let turn = string(&started, "/turn/id")?.to_owned();
    *custody = Custody::Active {
        thread: thread.clone(),
        turn: turn.clone(),
    };
    let mut state = Turn {
        thread,
        turn,
        text: String::new(),
        delta_items: std::collections::BTreeSet::new(),
    };
    for event in buffered {
        if terminal(&event, &state.thread, &state.turn) {
            *custody = Custody::Settled;
        }
        if let Some(outcome) = state.event(event, output).await? {
            return Ok(outcome);
        }
    }
    loop {
        let event = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(Error::Cancelled),
            () = failed.cancelled() => return Err(Error::Unknown),
            event = io.next() => event?,
        };
        if terminal(&event, &state.thread, &state.turn) {
            *custody = Custody::Settled;
        }
        if event.get("method").is_some() && event.get("id").is_some() {
            return io.unsupported(event).await;
        }
        if let Some(outcome) = state.event(event, output).await? {
            return Ok(outcome);
        }
    }
}
fn terminal(event: &Value, thread: &str, turn: &str) -> bool {
    event["method"] == "turn/completed"
        && event["params"]["threadId"] == thread
        && event["params"]["turn"]["id"] == turn
        && matches!(
            event["params"]["turn"]["status"].as_str(),
            Some("completed" | "failed" | "interrupted")
        )
}
struct Turn {
    thread: String,
    turn: String,
    text: String,
    delta_items: std::collections::BTreeSet<String>,
}
impl Turn {
    async fn event(
        &mut self,
        event: Value,
        output: &dyn OutputSink,
    ) -> Result<Option<Outcome>, Error> {
        let method = event
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let p = &event["params"];
        if p.get("threadId").and_then(Value::as_str) != Some(self.thread.as_str()) {
            return Ok(None);
        }
        let turn = p
            .get("turnId")
            .or_else(|| p.pointer("/turn/id"))
            .and_then(Value::as_str);
        if turn != Some(self.turn.as_str()) {
            return Ok(None);
        }
        match method {
            "item/agentMessage/delta" => {
                let text = string(p, "/delta")?;
                self.text.push_str(text);
                self.delta_items.insert(string(p, "/itemId")?.into());
                output
                    .emit(Output::OutputDelta { text: text.into() })
                    .await?;
            }
            "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
                output
                    .emit(Output::ThinkingDelta {
                        text: string(p, "/delta")?.into(),
                    })
                    .await?;
            }
            "item/started" | "item/completed" => {
                let item = &p["item"];
                let kind = item.get("type").and_then(Value::as_str).unwrap_or_default();
                let id = string(item, "/id")?.to_owned();
                if kind == "agentMessage"
                    && method == "item/completed"
                    && !self.delta_items.contains(&id)
                {
                    let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
                    self.text.push_str(text);
                    output
                        .emit(Output::OutputDelta { text: text.into() })
                        .await?;
                } else if matches!(
                    kind,
                    "commandExecution"
                        | "fileChange"
                        | "webSearch"
                        | "imageView"
                        | "collabAgentToolCall"
                ) {
                    let tool_call_id = format!("{}:{}:{id}", self.thread, self.turn);
                    if method == "item/started" {
                        output
                            .emit(Output::ToolStart {
                                tool_call_id,
                                name: kind.into(),
                                input: item.clone(),
                            })
                            .await?;
                    } else {
                        output
                            .emit(Output::ToolResult {
                                tool_call_id,
                                text: serde_json::to_string(item).expect("native item is JSON"),
                                is_error: item.get("status").and_then(Value::as_str)
                                    == Some("failed"),
                            })
                            .await?;
                    }
                }
            }
            "turn/completed" => {
                return Ok(Some(
                    match p.pointer("/turn/status").and_then(Value::as_str) {
                        Some("completed") => Outcome::Completed {
                            text: std::mem::take(&mut self.text),
                        },
                        Some("interrupted") => return Err(Error::Cancelled),
                        Some("failed") => Outcome::Failed {
                            code: Some("native_turn_failed".into()),
                            message: "Codex turn failed".into(),
                            recoverable: false,
                        },
                        _ => {
                            return Err(Error::Invalid(
                                "Codex terminal has no recognized status".into(),
                            ));
                        }
                    },
                ));
            }
            _ => {}
        }
        Ok(None)
    }
}
