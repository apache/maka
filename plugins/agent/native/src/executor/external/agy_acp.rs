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
use base64::{Engine, engine::general_purpose::STANDARD};
use maka_agent_facts::{
    executor::{Output, ToolResultDetails, TurnUsage},
    model::ModelUsage,
};
use maka_external_agent::AcpV1Projection;
use runtime::{Pipe, string};
use serde_json::json;

const HOST_SERVER: &str = "maka";

#[expect(
    clippy::too_many_arguments,
    reason = "one invocation owns the original process, protocol and Host bridge"
)]
pub(super) async fn execute(
    config: &NativeCommand,
    cwd: &str,
    request: &Value,
    journal: &mut journal::ProtocolSession,
    output: Arc<dyn OutputSink>,
    bridge: Arc<mcp::Bridge>,
    cancellation: CancellationToken,
    owner: maka_process::isolated::TaskOwner,
) -> Result<Outcome, Error> {
    let mut command = runtime::command(config, cwd).await?;
    if journal.native_session().is_none() {
        agy::require_host_agent().await?;
    }
    command.args([
        "acp",
        "--process-per-session",
        "--dangerously-skip-permissions",
        "--agent",
        agy::HOST_AGENT,
    ]);
    runtime::task_pipe(
        owner,
        journal.observation(),
        command,
        runtime::Transport::JsonLines,
        Some(bridge.clone()),
        cancellation,
        Protocol {
            cwd,
            request,
            journal,
            output,
            bridge,
        },
    )
    .await
}

struct Protocol<'a> {
    cwd: &'a str,
    request: &'a Value,
    journal: &'a mut journal::ProtocolSession,
    output: Arc<dyn OutputSink>,
    bridge: Arc<mcp::Bridge>,
}

impl runtime::PipeProtocol for Protocol<'_> {
    type Output = Outcome;

    fn run<'io>(self, io: &'io mut Pipe) -> BoxFuture<'io, Result<Outcome, Error>>
    where
        Self: 'io,
    {
        Box::pin(self.converse(io))
    }
}

impl Protocol<'_> {
    async fn converse(mut self, io: &mut Pipe) -> Result<Outcome, Error> {
        let setup = self.prepare(io).await;
        let (session, prompt) = match setup {
            Ok(setup) => setup,
            Err(
                error @ (Error::Cancelled
                | Error::ObservationRetired
                | Error::Persistence(_)
                | Error::CleanupUnconfirmed
                | Error::Unknown),
            ) => return Err(error),
            Err(error) => {
                return Ok(Outcome::Failed {
                    message: error.to_string(),
                    code: Some("native_preparation_failed".into()),
                    recoverable: false,
                });
            }
        };

        io.turn_started();
        let prompt_id = io
            .begin("session/prompt", prompt)
            .await
            .map_err(unconfirmed)?;
        self.journal
            .bind_task(NativeTask::AntigravityAcp {
                session: session.clone(),
                prompt_id,
            })
            .await?;
        let mut turn = Turn::new(session.clone(), prompt_id);
        let outcome = turn
            .observe(io, self.output.as_ref(), &self.bridge)
            .await
            .map_err(unconfirmed)?;
        self.journal.closed(outcome.clone()).await?;
        io.turn_finished();
        self.bridge.close_admission();

        // End the dedicated ACP session so agy can release its worker and persist native history.
        if !io.stop.is_cancelled() {
            let close = io.request("session/close", json!({"sessionId":session}));
            if !matches!(
                tokio::time::timeout(Duration::from_secs(2), close).await,
                Ok(Ok(_))
            ) {
                tracing::debug!("agy ACP session did not acknowledge close before process cleanup");
            }
        }
        Ok(outcome)
    }

    async fn prepare(&mut self, io: &mut Pipe) -> Result<(String, Value), Error> {
        let initialized = io
            .request(
                "initialize",
                json!({
                    "protocolVersion":1,
                    "clientCapabilities":{},
                    "clientInfo":{"name":"maka","title":"Maka","version":env!("CARGO_PKG_VERSION")}
                }),
            )
            .await?;
        if initialized["protocolVersion"] != 1
            || initialized.pointer("/agentCapabilities/mcpCapabilities/http")
                != Some(&Value::Bool(true))
        {
            return Err(Error::Invalid(
                "agy must support ACP 1 with HTTP MCP".into(),
            ));
        }
        let mut params = json!({
            "cwd":self.cwd,
            "mcpServers":[{
                "type":"http", "name":HOST_SERVER, "url":self.bridge.url,
                "headers":[{"name":"Authorization", "value":format!("Bearer {}",self.bridge.bearer())}]
            }],
            "_meta":{"antigravity":{"eagerMcpServers":[HOST_SERVER]}}
        });
        let method = if let Some(session) = self.journal.native_session() {
            params["sessionId"] = session.into();
            "session/resume"
        } else {
            "session/new"
        };
        let opened = io.request(method, params).await?;
        let session = match self.journal.native_session() {
            Some(previous) => opened["sessionId"].as_str().unwrap_or(previous),
            None => string(&opened, "/sessionId")?,
        }
        .to_owned();
        self.journal.opened(session.clone())?;
        if !self.bridge.listed.is_cancelled() {
            return Err(Error::Invalid(
                "agy ACP did not discover Maka's MCP tools".into(),
            ));
        }
        select_model(io, &session, opened, self.request).await?;
        let message = string(self.request, "/message")?;
        let blocks = prompt_blocks(message, &self.request["images"]).await?;
        self.bridge.admit()?;
        if let Some(update) = self
            .journal
            .instruction_update(self.request["instructions"].as_str())
        {
            let setup = io
                .request(
                    "session/prompt",
                    json!({
                        "sessionId":session,
                        "prompt":[{"type":"text","text":runtime::bootstrap_message(&update.text)}]
                    }),
                )
                .await?;
            if setup["stopReason"] != "end_turn" {
                return Err(Error::Provider(
                    "agy ACP did not complete the instructions turn".into(),
                ));
            }
            self.journal.confirm_instructions(update).await?;
        }
        Ok((
            session.clone(),
            json!({"sessionId":session, "prompt":blocks}),
        ))
    }
}

fn unconfirmed(error: Error) -> Error {
    match error {
        Error::Invalid(_) | Error::Provider(_) | Error::Cancelled => {
            tracing::debug!(%error, "agy ACP prompt could not be confirmed");
            Error::Unknown
        }
        other => other,
    }
}

fn config_value<'a>(config: &'a Value, category: &str) -> Option<(&'a str, &'a str)> {
    let option = config["configOptions"]
        .as_array()?
        .iter()
        .find(|option| option["category"] == category)?;
    Some((option["id"].as_str()?, option["currentValue"].as_str()?))
}

async fn select_model(
    io: &mut Pipe,
    session: &str,
    mut config: Value,
    request: &Value,
) -> Result<(), Error> {
    if let Some(model) = request["model"]
        .as_str()
        .filter(|&model| model != "default")
        && config
            .pointer("/models/currentModelId")
            .and_then(Value::as_str)
            != Some(model)
    {
        let (id, _) = config_value(&config, "model")
            .ok_or_else(|| Error::Invalid("agy ACP did not advertise model selection".into()))?;
        config = io
            .request(
                "session/set_config_option",
                json!({"sessionId":session,"configId":id,"value":model}),
            )
            .await?;
        let selected = config_value(&config, "model").map(|(_, value)| value);
        // agy exposes a combined ID in its model catalog and separate config values.
        let confirmed = selected.is_some_and(|selected| {
            selected == model
                || config_value(&config, "thought_level").is_some_and(|(_, level)| {
                    model
                        .strip_prefix(selected)
                        .and_then(|suffix| suffix.strip_prefix('-'))
                        == Some(level)
                })
        });
        if !confirmed {
            return Err(Error::Invalid(format!(
                "agy ACP did not select model {model}"
            )));
        }
    }
    if let Some(level) = request["effort"].as_str() {
        let (id, current) = config_value(&config, "thought_level").ok_or_else(|| {
            Error::Invalid("agy ACP did not advertise a thinking level for this model".into())
        })?;
        if current != level {
            let updated = io
                .request(
                    "session/set_config_option",
                    json!({"sessionId":session,"configId":id,"value":level}),
                )
                .await?;
            if config_value(&updated, "thought_level").map(|(_, value)| value) != Some(level) {
                return Err(Error::Invalid(format!(
                    "agy ACP did not select thinking level {level}"
                )));
            }
        }
    }
    Ok(())
}

async fn prompt_blocks(message: &str, images: &Value) -> Result<Vec<Value>, Error> {
    let mut blocks = vec![json!({"type":"text","text":message})];
    for image in images.as_array().into_iter().flatten() {
        let path = string(image, "/path")?;
        let mime = string(image, "/mediaType")?;
        let bytes = tokio::fs::read(path)
            .await
            .map_err(|error| Error::Provider(format!("Cannot read agy ACP image: {error}")))?;
        let data = tokio::task::spawn_blocking(move || STANDARD.encode(bytes))
            .await
            .map_err(|error| Error::Provider(format!("Cannot encode agy ACP image: {error}")))?;
        blocks.push(json!({"type":"image","data":data,"mimeType":mime}));
    }
    Ok(blocks)
}

struct Turn {
    session: String,
    prompt_id: u64,
    projection: AcpV1Projection,
    host_calls: std::collections::BTreeSet<String>,
}

impl Turn {
    fn new(session: String, prompt_id: u64) -> Self {
        Self {
            projection: AcpV1Projection::new(session.clone(), format!("agy:{prompt_id}")),
            session,
            prompt_id,
            host_calls: Default::default(),
        }
    }

    async fn observe(
        &mut self,
        io: &mut Pipe,
        output: &dyn OutputSink,
        bridge: &mcp::Bridge,
    ) -> Result<Outcome, Error> {
        let mut cancel_deadline = None;
        loop {
            let event = if let Some(deadline) = cancel_deadline {
                tokio::time::timeout_at(deadline, io.next())
                    .await
                    .map_err(|_| Error::CleanupUnconfirmed)??
            } else {
                match io.next().await {
                    Err(Error::Cancelled) if io.stop.is_cancelled() => {
                        bridge.close_admission();
                        io.cancellation = CancellationToken::new();
                        io.failed = CancellationToken::new();
                        io.control("session/cancel", json!({"sessionId":self.session}))
                            .await;
                        cancel_deadline =
                            Some(tokio::time::Instant::now() + runtime::INTERRUPT_TIMEOUT);
                        continue;
                    }
                    event => event?,
                }
            };
            if event.get("method").is_some() && event.get("id").is_some() {
                return io.unsupported(event).await;
            }
            if let Some(outcome) = self.event(event, output).await? {
                return Ok(outcome);
            }
        }
    }

    async fn event(
        &mut self,
        mut event: Value,
        output: &dyn OutputSink,
    ) -> Result<Option<Outcome>, Error> {
        if is_response(&event, self.prompt_id) {
            let result = &event["result"];
            let reason = result["stopReason"].as_str();
            let completed = reason == Some("end_turn");
            let failure = match reason {
                Some("end_turn" | "cancelled") => None,
                Some("max_tokens" | "max_turn_requests" | "refusal") => reason,
                _ if event
                    .pointer("/error/code")
                    .and_then(Value::as_i64)
                    .is_some()
                    && event
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .is_some() =>
                {
                    event.pointer("/error/message").and_then(Value::as_str)
                }
                _ => return Err(Error::Unknown),
            };
            self.projection.finish(output, completed).await?;
            if let Some(usage) = usage(result) {
                output.emit(Output::TurnUsage { usage }).await?;
            }
            return Ok(Some(match (reason, failure) {
                (Some("end_turn"), _) => Outcome::Completed {
                    message_id: self.projection.last_body_message_id(),
                },
                (Some("cancelled"), _) => Outcome::Cancelled {
                    reason: Some("native_interrupted".into()),
                },
                (_, Some(message)) => Outcome::Failed {
                    message: format!("agy ACP turn ended: {message}"),
                    code: Some("native_turn_failed".into()),
                    recoverable: false,
                },
                _ => return Err(Error::Unknown),
            }));
        }
        if event["method"] == "session/update" {
            let mut params = event["params"].take();
            if params["sessionId"] != self.session {
                return Err(Error::Unknown);
            }
            let update = &params["update"];
            if matches!(
                update["sessionUpdate"].as_str(),
                Some("tool_call" | "tool_call_update")
            ) {
                let id = string(update, "/toolCallId")?;
                // The Host bridge already emits the canonical Maka tool card.
                if update["name"]
                    .as_str()
                    .is_some_and(|name| name.starts_with("mcp_maka_maka_"))
                {
                    self.host_calls.insert(id.into());
                }
                if self.host_calls.contains(id) {
                    self.projection.close_message(output).await?;
                    return Ok(None);
                }
            }
            if let Some(exit_code) = command_result(&mut params["update"]) {
                self.projection
                    .update_json(params, &CommandResult { output, exit_code })
                    .await?;
            } else {
                self.projection.update_json(params, output).await?;
            }
        }
        Ok(None)
    }
}

fn command_result(update: &mut Value) -> Option<i32> {
    if update["name"] != "run_command"
        || !matches!(update["status"].as_str(), Some("completed" | "failed"))
    {
        return None;
    }
    let exit_code = i32::try_from(update["rawOutput"]["exit_code"].as_i64()?).ok()?;
    if let Some(raw) = update["rawOutput"]["output"].as_str() {
        let (body, _) = command_output(raw);
        update["content"] = json!([{
            "type":"content",
            "content":{"type":"text","text":body.replace('\0', "\\0")}
        }]);
    }
    if exit_code != 0 {
        update["status"] = "failed".into();
    }
    Some(exit_code)
}

fn command_output(raw: &str) -> (&str, Option<i32>) {
    let mut body = raw;
    for label in ["Created At: ", "Completed At: "] {
        if body.starts_with(label) {
            let Some((_, rest)) = body.split_once('\n') else {
                return (raw, None);
            };
            body = rest;
        }
    }
    let (status, rest) = body.split_once('\n').unwrap_or((body, ""));
    let code = status
        .strip_prefix("Command exited with code ")
        .and_then(|code| code.trim_end_matches('\r').strip_suffix('.'))
        .and_then(|code| code.parse::<i32>().ok());
    match (code, rest.trim_start_matches(['\r', '\n'])) {
        (Some(code), "") => ("", Some(code)),
        (Some(code), rest)
            if let Some(output) = rest
                .strip_prefix("Command output:\n")
                .or_else(|| rest.strip_prefix("Command output:\r\n")) =>
        {
            (output, Some(code))
        }
        _ => (raw, None),
    }
}

struct CommandResult<'a> {
    output: &'a dyn OutputSink,
    exit_code: i32,
}

impl OutputSink for CommandResult<'_> {
    fn emit(&self, mut event: Output) -> BoxFuture<'_, Result<(), Error>> {
        if let Output::ToolResult { details, .. } = &mut event {
            *details = Some(ToolResultDetails {
                exit_code: Some(self.exit_code),
                duration_ms: None,
            });
        }
        self.output.emit(event)
    }
}

fn is_response(row: &Value, id: u64) -> bool {
    row["id"].as_u64() == Some(id) && row.get("method").is_none()
}

fn usage(result: &Value) -> Option<TurnUsage> {
    let usage = result["usage"].as_object()?;
    let counter = |key| usage.get(key).and_then(Value::as_u64);
    Some(TurnUsage {
        tokens: ModelUsage {
            input_tokens: counter("inputTokens"),
            output_tokens: counter("outputTokens"),
            cache_read_tokens: counter("cachedReadTokens"),
            cache_write_tokens: counter("cachedWriteTokens"),
            reasoning_tokens: counter("thoughtTokens"),
        },
        total_tokens: counter("totalTokens"),
        duration_ms: None,
    })
}

pub(super) async fn replay(
    session: &str,
    prompt_id: u64,
    input: &mut replay::Stream,
    stream: &mut replay::Stream,
    output: &dyn OutputSink,
) -> Result<Outcome, Error> {
    if prompt_id < 3 {
        return Err(Error::Unknown);
    }
    loop {
        let row = input.required().await?;
        if row["id"].as_u64() == Some(prompt_id) {
            if row["method"] != "session/prompt"
                || row["params"]["sessionId"] != session
                || !row["params"]["prompt"].is_array()
            {
                return Err(Error::Unknown);
            }
            break;
        }
    }
    while let Some(row) = input.next().await? {
        if row["params"]["sessionId"] != session
            || !matches!(
                row["method"].as_str(),
                Some("session/cancel" | "session/close")
            )
        {
            return Err(Error::Unknown);
        }
    }

    // Setup may replay history or a prior instructions-only prompt. Its final RPC
    // acknowledgement precedes the current prompt, which is the only turn projected.
    loop {
        let event = stream.required().await?;
        if is_response(&event, prompt_id - 1) && event.get("result").is_some() {
            break;
        }
    }
    let mut turn = Turn::new(session.into(), prompt_id);
    loop {
        let event = stream.required().await?;
        if let Some(outcome) = turn.event(event, output).await? {
            return Ok(outcome);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Sink(std::sync::Mutex<Vec<Output>>);

    impl OutputSink for Sink {
        fn emit(&self, event: Output) -> BoxFuture<'_, Result<(), Error>> {
            Box::pin(async move {
                self.0.lock().unwrap().push(event);
                Ok(())
            })
        }
    }

    fn spool(rows: impl IntoIterator<Item = Value>) -> replay::Stream {
        use std::io::{Seek, Write};
        let mut file = tempfile::tempfile().unwrap();
        for row in rows {
            writeln!(file, "{row}").unwrap();
        }
        file.rewind().unwrap();
        replay::Stream::new(file, CancellationToken::new(), CancellationToken::new())
    }

    fn update(update: Value) -> Value {
        json!({"method":"session/update","params":{"sessionId":"session","update":update}})
    }

    #[tokio::test]
    async fn replays_only_the_bound_prompt_with_the_same_activity_as_live() {
        let prior = update(json!({"sessionUpdate":"agent_message_chunk",
            "content":{"type":"text","text":"prior instructions acknowledgement"}}));
        let events = [
            update(
                json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"checking"}}),
            ),
            update(
                json!({"sessionUpdate":"tool_call","toolCallId":"host","name":"mcp_maka_maka_ModelList",
                "status":"in_progress","title":"Run ModelList"}),
            ),
            update(
                json!({"sessionUpdate":"tool_call_update","toolCallId":"host","status":"completed"}),
            ),
            update(
                json!({"sessionUpdate":"tool_call","toolCallId":"shell","name":"run_command",
                "status":"in_progress","title":"false","rawInput":{"CommandLine":"false","toolSummary":"Check status"}}),
            ),
            update(
                json!({"sessionUpdate":"tool_call_update","toolCallId":"shell","name":"run_command",
                "status":"completed","rawOutput":{"exit_code":1,"output":"Command exited with code 1.\n\nCommand output:\nfailed"}}),
            ),
            update(
                json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Result: "}}),
            ),
            update(
                json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"failed."}}),
            ),
            json!({"id":4,"result":{"stopReason":"end_turn","usage":{"cachedReadTokens":50,"totalTokens":70}}}),
        ];
        let live = Sink::default();
        let mut turn = Turn::new("session".into(), 4);
        let mut terminal = None;
        for event in &events {
            terminal = turn.event(event.clone(), &live).await.unwrap();
        }
        let replayed = Sink::default();
        let outcome = replay(
            "session",
            4,
            &mut spool([
                json!({"id":1,"method":"initialize"}),
                json!({"id":2,"method":"session/resume","params":{"sessionId":"session"}}),
                json!({"id":3,"method":"session/prompt","params":{"sessionId":"session","prompt":[{"type":"text","text":"instructions"}]}}),
                json!({"id":4,"method":"session/prompt","params":{"sessionId":"session","prompt":[{"type":"text","text":"task"}]}}),
                json!({"id":5,"method":"session/close","params":{"sessionId":"session"}}),
            ]),
            &mut spool([prior, json!({"id":3,"result":{"stopReason":"end_turn"}})].into_iter().chain(events)),
            &replayed,
        )
        .await
        .unwrap();
        assert!(replay::same_outcome(&terminal.unwrap(), &outcome));
        let observations = live.0.into_inner().unwrap();
        assert_eq!(observations, replayed.0.into_inner().unwrap());
        assert!(matches!(&observations[..], [
            Output::MessageStart { .. },
            Output::ThinkingDelta { text: thought, .. },
            Output::MessageEnd { .. },
            Output::ToolStart { input, .. },
            Output::ToolResult { is_error: true, text: error, details: Some(ToolResultDetails { exit_code: Some(1), .. }), .. },
            Output::MessageStart { .. },
            Output::OutputDelta { text: first, .. },
            Output::OutputDelta { text: second, .. },
            Output::MessageEnd { .. },
            Output::TurnUsage { usage: TurnUsage { tokens: ModelUsage { cache_read_tokens: Some(50), .. }, .. } },
        ] if thought == "checking" && input["toolSummary"] == "Check status" && error == "failed" && first == "Result: " && second == "failed."));
    }
}
