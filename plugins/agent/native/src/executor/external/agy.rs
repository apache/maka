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
#[cfg(unix)]
use runtime::interruptible_pipe as native_pipe;
#[cfg(not(unix))]
use runtime::pipe as native_pipe;
use runtime::{Pipe, string};

#[expect(
    clippy::too_many_arguments,
    reason = "one invocation owns native custody, protocol and Host tool settlement"
)]
pub(super) async fn execute(
    config: &NativeCommand,
    cwd: &str,
    request: &Value,
    storage: &Storage,
    journal: &mut journal::Journal,
    output: Arc<dyn OutputSink>,
    bridge: Arc<mcp::Bridge>,
    cancellation: CancellationToken,
    _steering: &mut steering::Steering,
) -> Result<Outcome, Error> {
    let provisional = journal.native_session().is_none();
    let mut submitted = false;
    let result = prepare(
        config,
        cwd,
        request,
        storage,
        journal,
        output.as_ref(),
        &bridge,
        cancellation,
        &mut submitted,
    )
    .await;
    let closed = bridge.close().await;
    if matches!(result, Err(Error::CleanupUnconfirmed)) {
        return result;
    }
    closed?;
    if !submitted && let Err(error) = &result {
        match error {
            Error::Unknown | Error::CleanupUnconfirmed | Error::Persistence(_) => return result,
            _ => {}
        }
        if provisional && journal.native_session().is_some() {
            journal.revoke_unsubmitted(storage).await?;
        }
        if !matches!(error, Error::Cancelled) {
            return Ok(Outcome::Failed {
                message: error.to_string(),
                code: Some("native_preparation_failed".into()),
                recoverable: false,
            });
        }
    }
    result
}

#[expect(
    clippy::too_many_arguments,
    reason = "native resources have one physical settlement owner"
)]
async fn prepare(
    config: &NativeCommand,
    cwd: &str,
    request: &Value,
    storage: &Storage,
    journal: &mut journal::Journal,
    output: &dyn OutputSink,
    bridge: &Arc<mcp::Bridge>,
    cancellation: CancellationToken,
    submitted: &mut bool,
) -> Result<Outcome, Error> {
    if cancellation.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let directory = bridge.directory();
    let plugin = directory.join(".agents/plugins/maka");
    tokio::fs::create_dir_all(&plugin)
        .await
        .map_err(|e| Error::Provider(e.to_string()))?;
    tokio::fs::write(plugin.join("plugin.json"), b"{\"name\":\"maka\"}")
        .await
        .map_err(|e| Error::Provider(e.to_string()))?;
    let mcp = serde_json::json!({"mcpServers":{"maka":{"url":bridge.url,"headers":{"Authorization":format!("Bearer {}",bridge.bearer())}}}});
    tokio::fs::write(
        plugin.join("mcp_config.next"),
        serde_json::to_vec(&mcp).expect("MCP config is JSON"),
    )
    .await
    .map_err(|e| Error::Provider(e.to_string()))?;
    tokio::fs::rename(
        plugin.join("mcp_config.next"),
        plugin.join("mcp_config.json"),
    )
    .await
    .map_err(|e| Error::Provider(e.to_string()))?;
    let settings = directory.join("settings.json");
    tokio::fs::write(&settings, b"{\"queuedMessages\":\"send-immediately\"}")
        .await
        .map_err(|e| Error::Provider(e.to_string()))?;
    let mut plan = runtime::command(config, cwd).await?;
    plan.arg("--print=")
        .arg("--input-format")
        .arg("stream-json")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--disable-slash-commands")
        .arg("--dangerously-skip-permissions")
        .arg("--add-dir")
        .arg(directory)
        .arg("--settings")
        .arg(&settings);
    let mut image_directories = std::collections::BTreeSet::new();
    for image in request
        .get("images")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let path = std::path::Path::new(string(image, "/path")?);
        let parent = path
            .parent()
            .ok_or_else(|| Error::Invalid("agy image path has no parent".into()))?;
        if image_directories.insert(parent) {
            plan.arg("--add-dir").arg(parent);
        }
    }
    if let Some(session) = journal.native_session() {
        plan.arg("--conversation").arg(session);
    }
    if let Some(model) = request
        .get("model")
        .and_then(Value::as_str)
        .filter(|model| *model != "default")
    {
        plan.arg("--model").arg(model);
    }
    if let Some(effort) = request.get("effort").and_then(Value::as_str) {
        plan.arg("--effort").arg(effort);
    }
    let host = bridge.clone();
    native_pipe(
        plan,
        runtime::Transport::JsonLines,
        Some(bridge.clone()),
        cancellation,
        |mut io| async move {
            let result =
                converse(&mut io, request, storage, journal, output, &host, submitted).await;
            (result, io)
        },
    )
    .await
}

async fn converse(
    io: &mut Pipe,
    request: &Value,
    storage: &Storage,
    journal: &mut journal::Journal,
    output: &dyn OutputSink,
    bridge: &mcp::Bridge,
    submitted: &mut bool,
) -> Result<Outcome, Error> {
    let init = tokio::time::timeout(runtime::SETUP_TIMEOUT, io.next())
        .await
        .map_err(|_| Error::Provider("agy initialization timed out".into()))??;
    if init.get("event").and_then(Value::as_str) != Some("init") {
        return Err(Error::Invalid(
            "agy did not emit its native init event".into(),
        ));
    }
    if init
        .pointer("/init/permission_mode")
        .and_then(Value::as_str)
        != Some("always-proceed")
    {
        return Err(Error::Invalid(
            "agy did not confirm always-proceed permission mode".into(),
        ));
    }
    let session = string(&init, "/conversation_id")?.to_owned();
    if let Some(model) = request
        .get("model")
        .and_then(Value::as_str)
        .filter(|model| *model != "default")
        && init.pointer("/init/model").and_then(Value::as_str) != Some(model)
    {
        return Err(Error::Invalid(
            "agy did not select the requested model".into(),
        ));
    }
    journal.opened(storage, session.clone()).await?;
    bridge.admit()?;
    let interrupt = io.interrupt.take();
    let stop = io.cancellation.clone();
    if interrupt.is_some() {
        // Root Stop requests native interruption; it must not cancel the stream reader.
        io.cancellation = CancellationToken::new();
    }
    let work = async {
        if stop.is_cancelled() {
            return Err(Error::Cancelled);
        }
        *submitted = true;
        let mut cursor = TurnCursor::default();
        if !journal.bootstrap_completed() {
            let instructions = request.get("instructions").and_then(Value::as_str);
            let bootstrap = runtime::bootstrap_message(instructions);
            io.send(user_message(&bootstrap)).await?;
            let bootstrap = observe(io, &session, &mut cursor, output, false).await?;
            if !matches!(bootstrap, Outcome::Completed { .. }) {
                return Ok(bootstrap);
            }
            if stop.is_cancelled() {
                return Err(Error::Cancelled);
            }
            if !bridge.listed.is_cancelled() {
                return Ok(Outcome::Failed {
                    message: "agy did not confirm the captured Host MCP tool catalog".into(),
                    code: Some("native_mcp_setup_failed".into()),
                    recoverable: false,
                });
            }
            journal.complete_bootstrap(storage).await?;
        }
        io.send(user_message(&native_prompt(request)?)).await?;
        observe(io, &session, &mut cursor, output, true).await
    };
    tokio::pin!(work);
    let soft = interrupt.is_some();
    let result = if let Some(interrupt) = interrupt {
        tokio::select! {
            biased;
            result = &mut work => result,
            () = stop.cancelled() => {
                bridge.close_admission();
                // A closed receiver means the child owner already finished. Its
                // physical result is still checked by pipe; native terminal is required here.
                let _ = interrupt.send(());
                tokio::time::timeout(runtime::INTERRUPT_TIMEOUT, &mut work).await
                    .map_err(|_| Error::CleanupUnconfirmed)?
            }
        }
    } else {
        work.await
    };
    if soft {
        match result {
            Ok(outcome) => Ok(outcome),
            Err(
                error @ (Error::Cancelled
                | Error::Unknown
                | Error::CleanupUnconfirmed
                | Error::Persistence(_)),
            ) => Err(error),
            // A later Root Stop during physical cleanup cannot settle malformed
            // or uncorrelated observations either.
            _ => Err(Error::Unknown),
        }
    } else {
        result
    }
}

fn native_prompt(request: &Value) -> Result<String, Error> {
    let message = request
        .get("message")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Invalid("agy request has no user message".into()))?;
    let images = request
        .get("images")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    if images.is_empty() {
        return Ok(message.into());
    }
    let manifest = serde_json::to_string(images).expect("validated image paths are JSON");
    Ok(format!(
        "{message}\n\n<maka_image_attachments>\n{manifest}\n</maka_image_attachments>"
    ))
}

fn user_message(text: &str) -> Value {
    serde_json::json!({"event":"user","message":{"content":text}})
}

#[derive(Default)]
struct TurnCursor {
    highest_step: Option<u64>,
}
async fn observe(
    io: &mut Pipe,
    session: &str,
    cursor: &mut TurnCursor,
    output: &dyn OutputSink,
    show_text: bool,
) -> Result<Outcome, Error> {
    let previous_step = cursor.highest_step;
    let mut user = None;
    let mut user_done = false;
    let mut tools = std::collections::BTreeSet::new();
    let mut admission = Some(tokio::time::Instant::now() + runtime::SETUP_TIMEOUT);
    loop {
        let event = if let Some(deadline) = admission {
            tokio::time::timeout_at(deadline, io.next())
                .await
                .map_err(|_| Error::Provider("agy user input admission timed out".into()))??
        } else {
            io.next().await?
        };
        match event.get("event").and_then(Value::as_str) {
            Some("step_update") => {
                let step = &event["step_update"];
                if string(step, "/conversation_id")? != session {
                    return Err(Error::Invalid("agy step conversation mismatch".into()));
                }
                let index = step
                    .get("step_index")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| Error::Invalid("agy step has no index".into()))?;
                let kind = string(step, "/step_type")?;
                let state = string(step, "/state")?;
                if kind == "user_input" {
                    if previous_step.is_some_and(|previous| index <= previous)
                        || user.is_some_and(|user| user != index)
                    {
                        return Err(Error::Invalid(
                            "agy did not correlate the submitted user turn".into(),
                        ));
                    }
                    user = Some(index);
                    admission = None;
                    user_done |= state == "DONE";
                } else if !user.is_some_and(|user| index > user) {
                    return Err(Error::Invalid(
                        "agy emitted activity before the submitted user input".into(),
                    ));
                }
                cursor.highest_step = Some(
                    cursor
                        .highest_step
                        .map_or(index, |previous| previous.max(index)),
                );
                if show_text
                    && kind == "agent_response"
                    && let Some(delta) = step.get("text_delta").and_then(Value::as_str)
                {
                    output
                        .emit(Output::OutputDelta { text: delta.into() })
                        .await?;
                }
                if kind == "tool" {
                    emit_tool(step, session, index, state, &mut tools, output).await?;
                }
            }
            Some("result") => {
                let result = &event["result"];
                if string(result, "/conversation_id")? != session || !user_done {
                    return Err(Error::Invalid(
                        "agy terminal did not correlate to this user input".into(),
                    ));
                }
                return terminal(result);
            }
            _ => return Err(Error::Invalid("Unsupported agy stream event".into())),
        }
    }
}
fn terminal(result: &Value) -> Result<Outcome, Error> {
    let status = string(result, "/status").map_err(|_| Error::Unknown)?;
    let reason = match result.get("finished_reason") {
        None => None,
        Some(Value::String(reason))
            if matches!(reason.as_str(), "interrupted" | "error" | "print_timeout") =>
        {
            Some(reason.as_str())
        }
        _ => return Err(Error::Unknown),
    };
    match (status, reason) {
        ("SUCCESS", None) => {
            let text = result
                .get("response")
                .and_then(Value::as_str)
                .ok_or(Error::Unknown)?;
            Ok(Outcome::Completed { text: text.into() })
        }
        ("ERROR", Some("interrupted")) | ("CANCELED" | "INTERRUPTED", _) => {
            Ok(Outcome::Cancelled {
                reason: Some("native_interrupted".into()),
            })
        }
        ("SUCCESS" | "ERROR" | "INVALID", _) => Ok(Outcome::Failed {
            message: result
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("agy turn ended before normal completion")
                .into(),
            code: Some("native_turn_failed".into()),
            recoverable: false,
        }),
        // RUNNING and WAITING do not prove that native work has settled.
        _ => Err(Error::Unknown),
    }
}
async fn emit_tool(
    step: &Value,
    session: &str,
    index: u64,
    state: &str,
    tools: &mut std::collections::BTreeSet<u64>,
    output: &dyn OutputSink,
) -> Result<(), Error> {
    let name = string(step, "/tool_name")?;
    // Only Maka's MCP calls already own canonical Host T1/T2.
    if name == "call_mcp_tool"
        && step
            .pointer("/tool_info/parameters/ServerName")
            .and_then(Value::as_str)
            == Some("maka_maka")
    {
        return Ok(());
    }
    let tool_call_id = format!("{session}:{index}");
    if tools.insert(index) {
        output
            .emit(Output::ToolStart {
                tool_call_id: tool_call_id.clone(),
                name: name.into(),
                input: step
                    .pointer("/tool_info/parameters")
                    .cloned()
                    .unwrap_or(Value::Null),
            })
            .await?;
    }
    if matches!(state, "DONE" | "ERROR") {
        tools.remove(&index);
        output
            .emit(Output::ToolResult {
                tool_call_id,
                text: serde_json::to_string(&step["tool_info"]).expect("native tool info is JSON"),
                is_error: state == "ERROR"
                    || step
                        .pointer("/tool_info/error")
                        .is_some_and(|error| !error.is_null()),
            })
            .await?;
    }
    Ok(())
}

pub(super) async fn models(
    config: &NativeCommand,
    cwd: &str,
    cancellation: CancellationToken,
) -> Result<Value, Error> {
    use tokio::io::AsyncWriteExt;
    if cancellation.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let mut command = runtime::command(config, cwd).await?;
    command.arg("models");
    let mut process = maka_process::pipe::spawn(command)
        .await
        .map_err(runtime::process_error)?;
    let observed = async {
        process
            .stdin
            .shutdown()
            .await
            .map_err(|_| Error::Provider("Could not close agy discovery input".into()))?;
        let status = async {
            process
                .child
                .wait()
                .await
                .map_err(|_| Error::CleanupUnconfirmed)
        };
        tokio::try_join!(
            status,
            catalog_output(&mut process.stdout, true),
            catalog_output(&mut process.stderr, false),
        )
    };
    let observed = tokio::select! {
        biased;
        () = cancellation.cancelled() => Err(Error::Cancelled),
        result = tokio::time::timeout(runtime::SETUP_TIMEOUT, observed) => {
            result.unwrap_or_else(|_| Err(Error::Provider("agy model discovery timed out".into())))
        }
    };
    let (status, stdout, _) = match observed {
        Ok(value) => value,
        Err(error) => {
            process
                .child
                .terminate()
                .map_err(|_| Error::CleanupUnconfirmed)?;
            tokio::time::timeout(std::time::Duration::from_secs(4), process.child.wait())
                .await
                .map_err(|_| Error::CleanupUnconfirmed)?
                .map_err(|_| Error::CleanupUnconfirmed)?;
            let drain = async {
                let mut stdout_sink = tokio::io::sink();
                let mut stderr_sink = tokio::io::sink();
                tokio::try_join!(
                    tokio::io::copy(&mut process.stdout, &mut stdout_sink),
                    tokio::io::copy(&mut process.stderr, &mut stderr_sink),
                )
            };
            tokio::time::timeout(std::time::Duration::from_secs(1), drain)
                .await
                .map_err(|_| Error::CleanupUnconfirmed)?
                .map_err(|_| Error::CleanupUnconfirmed)?;
            return Err(error);
        }
    };
    if !status.success() {
        // Native diagnostics may contain account information; they are never surfaced.
        return Err(Error::Provider("agy models failed".into()));
    }
    let models = tokio::task::spawn_blocking(move || parse_models(&stdout))
        .await
        .map_err(|_| Error::Provider("agy model parser task failed".into()))??;
    Ok(serde_json::json!({
        "installation":{"kind":"available"},
        "authentication":{"kind":"unknown","source":"agy models"},
        "models":{"kind":"ok","models":models}
    }))
}

async fn catalog_output(
    reader: &mut (impl tokio::io::AsyncRead + Unpin),
    retain: bool,
) -> Result<Vec<u8>, Error> {
    use tokio::io::AsyncReadExt;
    let mut result = Vec::new();
    let mut buffer = [0; 8192];
    let mut observed = 0usize;
    loop {
        let count = reader
            .read(&mut buffer)
            .await
            .map_err(|_| Error::Provider("Could not read agy model discovery".into()))?;
        if count == 0 {
            return Ok(result);
        }
        observed += count;
        if observed > runtime::MAX_MESSAGE_BYTES {
            return Err(Error::Invalid(
                "agy model discovery exceeds the 256 MiB observation budget".into(),
            ));
        }
        if retain {
            result.extend_from_slice(&buffer[..count]);
        }
    }
}

fn parse_models(bytes: &[u8]) -> Result<Vec<Value>, Error> {
    let catalog = std::str::from_utf8(bytes)
        .map_err(|_| Error::Invalid("agy models returned non-UTF-8 output".into()))?;
    let mut models = Vec::new();
    let mut ids = std::collections::BTreeSet::new();
    for row in catalog.lines() {
        let (id, name) = row
            .split_once('\t')
            .filter(|(id, name)| !id.is_empty() && !name.is_empty() && !name.contains('\t'))
            .ok_or_else(|| Error::Invalid("agy models returned a malformed TSV row".into()))?;
        if !ids.insert(id) {
            return Err(Error::Invalid("agy models returned duplicate IDs".into()));
        }
        models.push(serde_json::json!({"id":id,"displayName":name}));
    }
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_paths_remain_ordered_and_losslessly_escaped_in_native_user_context() {
        let images = serde_json::json!([
            {"path":"/private/user uploads/first\".png","mediaType":"image/png"},
            {"path":"/private/user uploads/second\nimage.webp","mediaType":"image/webp"},
        ]);
        let prompt =
            native_prompt(&serde_json::json!({"message":"Compare these images.","images":images}))
                .unwrap();
        assert!(prompt.starts_with("Compare these images."));
        let manifest = prompt
            .split_once("<maka_image_attachments>\n")
            .unwrap()
            .1
            .strip_suffix("\n</maka_image_attachments>")
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(manifest).unwrap(), images);
        assert_eq!(
            native_prompt(&serde_json::json!({"message":"original","images":[]})).unwrap(),
            "original"
        );
        assert!(native_prompt(&serde_json::json!({"message":"","images":images})).is_ok());
    }

    #[test]
    fn catalog_preserves_native_model_ids_and_unicode_names() {
        let catalog = "gemini-4-argon-high\tGemini 4 Argon（高）\r\nclaude-opus-5-5-low\tClaude Opus 5.5 · 低\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n";
        assert_eq!(
            parse_models(catalog.as_bytes()).unwrap(),
            vec![
                serde_json::json!({"id":"gemini-4-argon-high","displayName":"Gemini 4 Argon（高）"}),
                serde_json::json!({"id":"claude-opus-5-5-low","displayName":"Claude Opus 5.5 · 低"}),
                serde_json::json!({"id":"gpt-oss-120b-medium","displayName":"GPT-OSS 120B (Medium)"}),
            ],
        );
    }

    #[test]
    fn early_native_results_are_not_successful_answers() {
        let completed =
            terminal(&serde_json::json!({"status":"SUCCESS","response":"完整回复"})).unwrap();
        assert!(matches!(completed, Outcome::Completed { text } if text == "完整回复"));
        for reason in ["print_timeout", "interrupted", "error"] {
            let result = terminal(&serde_json::json!({"status":"SUCCESS","response":"partial","finished_reason":reason})).unwrap();
            assert!(matches!(result, Outcome::Failed { .. }));
        }
        assert!(terminal(&serde_json::json!({"status":"SUCCESS"})).is_err());
    }

    #[test]
    fn catalog_rejects_malformed_or_ambiguous_native_observations() {
        for catalog in [
            "model",
            "\tName",
            "model\t",
            "model\tName\textra",
            "m\tA\nm\tB",
        ] {
            assert!(parse_models(catalog.as_bytes()).is_err(), "{catalog}");
        }
        assert!(parse_models(&[0xff]).is_err());
    }
}
