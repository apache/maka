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

//! Product parity verification gate between a normal Maka client session and `maka-eval`.
//!
//! Executes the same declared Maka executable, public configuration, workspace contents,
//! and task input through both:
//! 1. The normal product client path (`maka host init` -> `maka host serve` -> `Client`
//!    directly against the model endpoint with no Eval gateway or Eval wrapper), and
//! 2. The `maka-eval` subject entry point (`RustHostSubject::execute` -> `maka-eval host-subject`
//!    -> `EvalMeteringGateway`).
//!
//! Compares committed durable facts (`RunSpec`, `RequestSpec`, `AcceptedModel`, `maka inspect`)
//! and actual outbound wire HTTP payloads to prove equivalent effective instructions,
//! unpruned tool exposure and schemas, Code Mode / skill availability, compaction/continuation
//! policy, and sandbox/approval ceiling.

use crate::contract::{
    BenchmarkSpec, ExecutionOutcome, ExecutionSpec, ExecutorSpec, ExperimentCell, ExperimentSpec,
    JsonObject, SchemaVersion, SubjectKind, SubjectSpec, TaskSpec, sha256_hex,
};
use crate::environment::{
    BoxFuture, CommandRunner, SubjectExecutionContext, SubjectProcessOutput, SubjectProcessRequest,
    SubjectProcessTermination,
};
use crate::subject::SubjectAdapter;
use crate::subject::maka::native::{
    apply_public_host_preferences, commit_client_mutation, sandbox_mode_to_workspace_access,
    shutdown_host_client, start_host_client,
};
use crate::subject::maka::{MakaSubjectConfig, RustHostSubject, bootstrap_maka_host_root};
use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use maka_app_client::{Journal, SubscriptionEvent};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::convert::Infallible;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub const PARITY_REPORT_SCHEMA_VERSION: &str = "maka.eval.parity_report.v1";
const ROOT_SQLITE_FILENAME: &str = "runtime-rust.sqlite";
const DEFAULT_PARITY_TASK_INPUT: &str = "Reply with OK.";

#[derive(Debug, Clone)]
pub struct ParityCheckInput {
    pub subject_id: String,
    pub subject_config: JsonObject,
    pub subject_credentials: Vec<String>,
    pub workspace_source: Option<PathBuf>,
    pub task_input: String,
    pub max_steps: u32,
}

impl ParityCheckInput {
    pub fn from_subject(subject: &SubjectSpec, task_input: Option<&str>, max_steps: u32) -> Self {
        Self {
            subject_id: subject.id.clone(),
            subject_config: subject.config.clone(),
            subject_credentials: subject.credentials.clone(),
            workspace_source: None,
            task_input: task_input
                .filter(|s| !s.is_empty())
                .unwrap_or(DEFAULT_PARITY_TASK_INPUT)
                .to_owned(),
            max_steps: max_steps.max(1),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParityCheckResult {
    pub dimension: String,
    pub passed: bool,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParityMismatch {
    pub dimension: String,
    pub field: String,
    pub normal: Value,
    pub eval: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParityVerificationReport {
    pub schema_version: String,
    pub subject_id: String,
    pub passed: bool,
    pub maka_version: String,
    pub maka_executable_sha256: String,
    pub declared_config_sha256: String,
    pub normal_tool_catalog_digest: String,
    pub eval_tool_catalog_digest: String,
    pub exposed_tool_names: Vec<String>,
    pub checks: Vec<ParityCheckResult>,
    pub mismatches: Vec<ParityMismatch>,
}

/// Normalized snapshot of committed execution facts and wire model request for parity comparison.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParitySnapshot {
    pub system_prompt_text: String,
    pub request_system_prompt: Option<String>,
    pub compaction_prompt: Option<String>,
    pub language: Value,
    pub dynamic_context: Vec<String>,
    pub composition_sources: Vec<Value>,
    pub allowed_tools: Option<Vec<String>>,
    pub tool_discovery: bool,
    pub tool_selection: Value,
    pub tool_mode: Value,
    pub code_language: Value,
    pub editing_tools: Value,
    pub tool_catalog_digest: String,
    pub tools: Vec<Value>,
    pub collaboration: Value,
    pub approval_policy: Value,
    pub sandbox_policy: Value,
    pub thinking_level: Value,
    pub provider_options: Value,
    pub max_output_tokens: Value,
    pub context_policy: Value,
    pub wire_path: String,
    pub wire_model: Option<String>,
    pub wire_messages: Value,
    pub wire_tools: Value,
    pub wire_options: Value,
}

#[derive(Debug, Clone)]
struct CapturedWireRequest {
    path: String,
    body: Value,
}

struct ParityProbeServer {
    addr: std::net::SocketAddr,
    captured: Arc<Mutex<Vec<CapturedWireRequest>>>,
    shutdown: CancellationToken,
    worker: Option<tokio::task::JoinHandle<()>>,
}

impl ParityProbeServer {
    async fn start(configured_model: String) -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("failed to bind parity probe server: {e}"))?;
        let addr = listener
            .local_addr()
            .map_err(|e| format!("failed to read parity probe address: {e}"))?;
        let captured = Arc::new(Mutex::new(Vec::new()));
        let captured_clone = captured.clone();
        let shutdown = CancellationToken::new();
        let shutdown_clone = shutdown.clone();

        let worker = tokio::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    _ = shutdown_clone.cancelled() => break,
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { break; };
                        let store = captured_clone.clone();
                        let model_id = configured_model.clone();
                        tokio::spawn(async move {
                            let service = service_fn(move |req: Request<Incoming>| {
                                let store = store.clone();
                                let model_id = model_id.clone();
                                async move { handle_probe_request(req, store, model_id).await }
                            });
                            let _ = http1::Builder::new()
                                .serve_connection(TokioIo::new(stream), service)
                                .await;
                        });
                    }
                }
            }
        });

        Ok(Self {
            addr,
            captured,
            shutdown,
            worker: Some(worker),
        })
    }

    fn base_url_for(&self, declared_base_url: &str) -> String {
        let suffix = url::Url::parse(declared_base_url)
            .ok()
            .map(|u| u.path().trim_end_matches('/').to_owned())
            .unwrap_or_else(|| "/v1".to_owned());
        format!("http://{}{}", self.addr, suffix)
    }

    async fn take_requests(&self) -> Vec<CapturedWireRequest> {
        let mut guard = self.captured.lock().await;
        std::mem::take(&mut *guard)
    }

    async fn close(mut self) {
        self.shutdown.cancel();
        if let Some(w) = self.worker.take() {
            w.abort();
        }
    }
}

async fn handle_probe_request(
    req: Request<Incoming>,
    store: Arc<Mutex<Vec<CapturedWireRequest>>>,
    configured_model: String,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let method = req.method().clone();
    let path = req.uri().path().to_owned();
    let bytes = req
        .into_body()
        .collect()
        .await
        .map(|c| c.to_bytes())
        .unwrap_or_default();

    if method == hyper::Method::GET {
        let payload = if path.ends_with("/api/tags") {
            json!({ "models": [{ "name": configured_model }] })
        } else {
            json!({
                "object": "list",
                "data": [{ "id": configured_model, "object": "model" }]
            })
        };
        let body = serde_json::to_vec(&payload).unwrap();
        return Ok(Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(Full::new(Bytes::from(body)))
            .unwrap());
    }

    let body_json: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let model = body_json
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or(&configured_model)
        .to_owned();
    let stream = body_json
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    if method == hyper::Method::POST {
        store.lock().await.push(CapturedWireRequest {
            path: path.clone(),
            body: body_json,
        });
    }

    if path.ends_with("/messages") {
        if stream {
            let sse = format!(
                concat!(
                    "event: message_start\ndata: {{\"type\":\"message_start\",\"message\":{{\"id\":\"msg_probe\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"{model}\",\"content\":[],\"stop_reason\":null,\"stop_sequence\":null,\"usage\":{{\"input_tokens\":12,\"output_tokens\":0}}}}}}\n\n",
                    "event: content_block_start\ndata: {{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{{\"type\":\"text\",\"text\":\"\"}}}}\n\n",
                    "event: content_block_delta\ndata: {{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{{\"type\":\"text_delta\",\"text\":\"OK\"}}}}\n\n",
                    "event: content_block_stop\ndata: {{\"type\":\"content_block_stop\",\"index\":0}}\n\n",
                    "event: message_delta\ndata: {{\"type\":\"message_delta\",\"delta\":{{\"stop_reason\":\"end_turn\",\"stop_sequence\":null}},\"usage\":{{\"output_tokens\":2}}}}\n\n",
                    "event: message_stop\ndata: {{\"type\":\"message_stop\"}}\n\n"
                ),
                model = model
            );
            return Ok(Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "text/event-stream")
                .body(Full::new(Bytes::from(sse)))
                .unwrap());
        }
        let body = serde_json::to_vec(&json!({
            "id": "msg_probe",
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": [{"type": "text", "text": "OK"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 12, "output_tokens": 2}
        }))
        .unwrap();
        return Ok(Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(Full::new(Bytes::from(body)))
            .unwrap());
    }

    if path.ends_with("/responses") {
        let sse = format!(
            concat!(
                "event: response.created\ndata: {{\"type\":\"response.created\",\"response\":{{\"id\":\"resp_probe\",\"object\":\"response\",\"status\":\"in_progress\",\"model\":\"{model}\",\"output\":[]}}}}\n\n",
                "event: response.output_item.added\ndata: {{\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{{\"id\":\"msg_1\",\"type\":\"message\",\"status\":\"in_progress\",\"role\":\"assistant\",\"content\":[]}}}}\n\n",
                "event: response.content_part.added\ndata: {{\"type\":\"response.content_part.added\",\"item_id\":\"msg_1\",\"output_index\":0,\"content_index\":0,\"part\":{{\"type\":\"output_text\",\"text\":\"\",\"annotations\":[]}}}}\n\n",
                "event: response.output_text.delta\ndata: {{\"type\":\"response.output_text.delta\",\"item_id\":\"msg_1\",\"output_index\":0,\"content_index\":0,\"delta\":\"OK\"}}\n\n",
                "event: response.output_text.done\ndata: {{\"type\":\"response.output_text.done\",\"item_id\":\"msg_1\",\"output_index\":0,\"content_index\":0,\"text\":\"OK\"}}\n\n",
                "event: response.output_item.done\ndata: {{\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{{\"id\":\"msg_1\",\"type\":\"message\",\"status\":\"completed\",\"role\":\"assistant\",\"content\":[{{\"type\":\"output_text\",\"text\":\"OK\",\"annotations\":[]}}]}}}}\n\n",
                "event: response.completed\ndata: {{\"type\":\"response.completed\",\"response\":{{\"id\":\"resp_probe\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"{model}\",\"output\":[{{\"id\":\"msg_1\",\"type\":\"message\",\"status\":\"completed\",\"role\":\"assistant\",\"content\":[{{\"type\":\"output_text\",\"text\":\"OK\",\"annotations\":[]}}]}}],\"usage\":{{\"input_tokens\":12,\"output_tokens\":2,\"total_tokens\":14,\"input_tokens_details\":{{\"cached_tokens\":0}},\"output_tokens_details\":{{\"reasoning_tokens\":0}}}}}}}}\n\n"
            ),
            model = model
        );
        return Ok(Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Full::new(Bytes::from(sse)))
            .unwrap());
    }

    if !stream {
        let body = serde_json::to_vec(&json!({
            "id": "chatcmpl-probe",
            "object": "chat.completion",
            "created": 1,
            "model": model,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "OK"},
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": 12,
                "completion_tokens": 2,
                "total_tokens": 14,
                "prompt_tokens_details": {"cached_tokens": 0},
                "completion_tokens_details": {"reasoning_tokens": 0}
            }
        }))
        .unwrap();
        return Ok(Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(Full::new(Bytes::from(body)))
            .unwrap());
    }

    let chunk1 = json!({
        "id": "chatcmpl-probe",
        "object": "chat.completion.chunk",
        "created": 1,
        "model": model,
        "choices": [{"index": 0, "delta": {"role": "assistant", "content": "OK"}, "finish_reason": null}]
    });
    let chunk2 = json!({
        "id": "chatcmpl-probe",
        "object": "chat.completion.chunk",
        "created": 1,
        "model": model,
        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        "usage": {
            "prompt_tokens": 12,
            "completion_tokens": 2,
            "total_tokens": 14,
            "prompt_tokens_details": {"cached_tokens": 0},
            "completion_tokens_details": {"reasoning_tokens": 0}
        }
    });
    let sse = format!("data: {chunk1}\n\ndata: {chunk2}\n\ndata: [DONE]\n\n");
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Full::new(Bytes::from(sse)))
        .unwrap())
}

struct LocalProcessRunner {
    work_dir: PathBuf,
    timeout: Duration,
}

impl CommandRunner for LocalProcessRunner {
    fn execute<'a>(
        &'a self,
        request: SubjectProcessRequest,
    ) -> BoxFuture<'a, Result<SubjectProcessOutput, String>> {
        Box::pin(async move {
            let mut cmd = Command::new(&request.command);
            cmd.args(&request.args)
                .current_dir(&self.work_dir)
                .env_remove("MAKA_EVAL_RESULT_TOKEN")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            for (k, v) in &request.environment {
                cmd.env(k, v);
            }
            for (target_env, source_env) in &request.credential_environment {
                let val =
                    std::env::var(source_env).unwrap_or_else(|_| "parity-probe-credential".into());
                cmd.env(target_env, val);
            }
            let child = cmd
                .spawn()
                .map_err(|e| format!("failed to spawn {}: {e}", request.command))?;
            match tokio::time::timeout(self.timeout, child.wait_with_output()).await {
                Ok(Ok(out)) => Ok(SubjectProcessOutput {
                    termination: SubjectProcessTermination::Exited,
                    exit_code: out.status.code().unwrap_or(1),
                    stdout: if request.capture_stdout {
                        String::from_utf8_lossy(&out.stdout).into_owned()
                    } else {
                        String::new()
                    },
                    stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
                    diagnostic: None,
                }),
                Ok(Err(e)) => Err(format!("failed waiting on {}: {e}", request.command)),
                Err(_) => Ok(SubjectProcessOutput {
                    termination: SubjectProcessTermination::FrameworkTimeout,
                    exit_code: -1,
                    stdout: String::new(),
                    stderr: String::new(),
                    diagnostic: None,
                }),
            }
        })
    }
}

/// Runs Product Parity verification for every Maka subject (or `subject_filter`) in `spec`.
pub async fn verify_experiment_parity(
    spec: &ExperimentSpec,
    subject_filter: Option<&str>,
) -> Result<Vec<ParityVerificationReport>, String> {
    let task_input = spec.tasks.first().map(|t| t.input.as_str());
    let max_steps = spec
        .budget
        .get("maxSteps")
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok())
        .unwrap_or(10);
    let mut reports = Vec::new();
    for subject in &spec.subjects {
        if subject.kind != SubjectKind::Maka {
            continue;
        }
        if let Some(filter) = subject_filter
            && subject.id != filter
        {
            continue;
        }
        let input = ParityCheckInput::from_subject(subject, task_input, max_steps);
        reports.push(verify_product_parity(&input).await?);
    }
    if reports.is_empty() {
        return Err("no matching Maka subjects found in experiment specification".into());
    }
    Ok(reports)
}

/// Executes both the normal Maka client and `maka-eval` subject entry point under identical
/// declared configuration, workspace, and task input, returning a `ParityVerificationReport`.
pub async fn verify_product_parity(
    input: &ParityCheckInput,
) -> Result<ParityVerificationReport, String> {
    let config = MakaSubjectConfig::decode(&input.subject_config, &input.subject_credentials)
        .map_err(|e| format!("invalid Maka subject configuration: {e}"))?;
    let declared_config_sha256 = config.parity_config_sha256();

    let maka_path = PathBuf::from(&config.maka_executable);
    let maka_bytes = fs::read(&maka_path).map_err(|e| {
        format!(
            "failed to read maka executable {}: {e}",
            maka_path.display()
        )
    })?;
    let maka_executable_sha256 = sha256_hex(&maka_bytes);
    let maka_version = read_maka_version(&maka_path).await?;

    let probe = ParityProbeServer::start(config.model.clone()).await?;
    let probe_base_url = probe.base_url_for(&config.base_url);

    let temp = tempfile::tempdir().map_err(|e| format!("tempdir failed: {e}"))?;
    let shared_workspace = temp.path().join("workspace");
    prepare_shared_workspace(input.workspace_source.as_deref(), &shared_workspace)?;

    let normal_root = temp.path().join("normal-root");
    let normal_journal_dir = temp.path().join("normal-client");
    fs::create_dir_all(&normal_journal_dir).map_err(|e| e.to_string())?;

    let normal_session_id = run_normal_product_client(
        &config,
        &probe_base_url,
        &normal_root,
        &normal_journal_dir,
        &shared_workspace,
        &input.task_input,
    )
    .await;
    let normal_requests = probe.take_requests().await;

    let eval_roots_dir = temp.path().join("eval-roots");
    let eval_artifacts_dir = temp.path().join("eval-artifacts");
    fs::create_dir_all(&eval_roots_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&eval_artifacts_dir).map_err(|e| e.to_string())?;

    let eval_run = run_eval_subject_entry(
        &input.subject_id,
        &input.subject_config,
        &input.subject_credentials,
        &probe_base_url,
        &eval_roots_dir,
        &eval_artifacts_dir,
        &shared_workspace,
        &input.task_input,
        input.max_steps,
        Duration::from_millis(
            u64::from(config.host_settlement_timeout_ms)
                .saturating_mul(3)
                .max(30_000),
        ),
    )
    .await;
    let eval_requests = probe.take_requests().await;
    probe.close().await;

    let normal_session_id = normal_session_id?;
    let (eval_root, eval_session_id) = eval_run?;

    verify_maka_inspect(&maka_path, &normal_root, &normal_session_id).await?;
    verify_maka_inspect(&maka_path, &eval_root, &eval_session_id).await?;

    let normal_wire = normal_requests
        .first()
        .ok_or("normal Maka client did not emit a model request")?;
    let eval_wire = eval_requests
        .first()
        .ok_or("Eval Maka entry point did not emit a model request")?;

    let normal_snapshot = extract_committed_parity_snapshot(
        &normal_root,
        &normal_session_id,
        &shared_workspace,
        normal_wire,
    )?;
    let eval_snapshot = extract_committed_parity_snapshot(
        &eval_root,
        &eval_session_id,
        &shared_workspace,
        eval_wire,
    )?;

    let route_mismatches = check_declared_endpoint_route_parity(&config);

    Ok(compare_parity_snapshots(
        &input.subject_id,
        &maka_version,
        &maka_executable_sha256,
        &declared_config_sha256,
        &normal_snapshot,
        &eval_snapshot,
        route_mismatches,
    ))
}

async fn read_maka_version(maka_executable: &Path) -> Result<String, String> {
    let out = Command::new(maka_executable)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("failed running maka --version: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "maka --version failed with {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

async fn verify_maka_inspect(
    maka_executable: &Path,
    root_path: &Path,
    session_id: &str,
) -> Result<(), String> {
    let out = Command::new(maka_executable)
        .args(["inspect", "--root"])
        .arg(root_path)
        .args(["--session", session_id])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("failed running maka inspect: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "maka inspect failed for session {session_id}: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let parsed: Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("invalid maka inspect JSON: {e}"))?;
    if parsed.get("session").and_then(Value::as_str) != Some(session_id) {
        return Err("maka inspect session mismatch".into());
    }
    Ok(())
}

fn prepare_shared_workspace(source: Option<&Path>, workspace: &Path) -> Result<(), String> {
    fs::create_dir_all(workspace).map_err(|e| e.to_string())?;
    if let Some(src) = source {
        copy_dir_recursive(src, workspace)?;
    } else {
        fs::write(
            workspace.join("README.md"),
            b"# Parity Workspace\nSample repository file.\n",
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        let target = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else if ty.is_file() {
            fs::copy(entry.path(), target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Runs a session using Maka's normal public client flow directly against `probe_base_url`
/// (with no `EvalMeteringGateway` and no `maka-eval` wrapper).
async fn run_normal_product_client(
    config: &MakaSubjectConfig,
    probe_base_url: &str,
    root_path: &Path,
    journal_dir: &Path,
    workspace_path: &Path,
    task_input: &str,
) -> Result<String, String> {
    let deadline = Duration::from_millis(u64::from(config.host_settlement_timeout_ms));
    let maka_executable = Path::new(&config.maka_executable);
    let api_key = std::env::var(&config.api_key_environment)
        .unwrap_or_else(|_| "parity-probe-credential".into());
    let init_payload = config.host_init_settings(probe_base_url, api_key);

    tokio::time::timeout(
        deadline,
        bootstrap_maka_host_root(maka_executable, root_path, &init_payload),
    )
    .await
    .map_err(|_| "normal Maka Host initialization timed out".to_owned())??;

    let journal = Journal::open(&journal_dir.join("client-journal.sqlite")).await?;
    let (mut child, client) = start_host_client(
        maka_executable,
        root_path,
        u64::from(config.host_settlement_timeout_ms),
        journal.clone(),
    )
    .await?;

    let workspace_str = workspace_path.to_string_lossy().into_owned();
    let configured =
        apply_public_host_preferences(&workspace_str, &config.session_settings, &client).await;
    let cleanup = shutdown_host_client(&mut child, &client, deadline).await;
    configured?;
    cleanup?;

    let (mut child, client) = start_host_client(
        maka_executable,
        root_path,
        u64::from(config.host_settlement_timeout_ms),
        journal,
    )
    .await?;

    let session_res = async {
        let connections = client
            .query("settings", "connections", json!({"kind": "start"}))
            .await?;
        let connection = connections["connections"]
            .as_array()
            .and_then(|items| items.iter().find(|c| c["slug"] == config.connection_slug))
            .ok_or("normal Maka connection unavailable")?;
        let backend = json!({
            "kind": "model",
            "connectionId": connection["basis"]["connectionId"],
            "modelId": config.model,
            "thinkingLevel": config.session_settings.thinking_level,
        });
        let created = commit_client_mutation(
            client
                .control(
                    Uuid::new_v4(),
                    "create",
                    json!({
                        "title": "Task",
                        "automaticTitle": false,
                        "labels": [],
                        "backend": backend,
                        "workspace": {
                            "kind": "directory",
                            "path": workspace_str,
                        },
                        "tools": Value::Null,
                    }),
                )
                .await?,
        )
        .await?;
        if created["kind"] != "created" {
            return Err(format!("normal Maka session creation rejected: {created}"));
        }
        let session_obj = &created["session"];
        let session_id = session_obj["id"]
            .as_str()
            .ok_or("normal Maka session id missing")?
            .to_owned();

        if let Some(request_permissions) = config.session_settings.request_permissions {
            let access = match &config.session_settings.sandbox_mode {
                Some(mode) => sandbox_mode_to_workspace_access(mode)?.to_owned(),
                None => session_obj["permissions"]["access"]
                    .as_str()
                    .unwrap_or("workspace_write")
                    .to_owned(),
            };
            let revision = session_obj["revision"]
                .as_u64()
                .ok_or("normal session revision missing")?;
            let updated = commit_client_mutation(
                client
                    .control(
                        Uuid::new_v4(),
                        "metadata",
                        json!({
                            "sessionId": session_id,
                            "expectedRevision": revision,
                            "title": "Task",
                            "labels": [],
                            "permissions": {
                                "settings": {
                                    "access": access,
                                    "requestPermissions": request_permissions,
                                },
                                "revokeGrants": false,
                            },
                        }),
                    )
                    .await?,
            )
            .await?;
            if updated["kind"] != "committed" {
                return Err("normal Maka session permission update rejected".into());
            }
        }

        let draft = client
            .save_draft(
                "agent",
                &session_id,
                "composer",
                None,
                task_input.to_owned().into(),
            )
            .await?;
        let mutation = client
            .reserve_send_draft(
                Uuid::new_v4(),
                "agent",
                &session_id,
                "composer",
                draft.revision,
                json!({"backend": backend}),
            )
            .await?
            .open()
            .await?;
        let watch = client
            .subscribe("agent", "watch", json!({"sessionId": session_id, "after": 0}))
            .await?;
        let accepted = commit_client_mutation(mutation).await?;
        let run_id = match accepted["kind"].as_str() {
            Some("started") => accepted["runId"]
                .as_str()
                .ok_or("normal Maka runId missing")?
                .to_owned(),
            Some("queued") => {
                let msg_id = accepted["messageId"]
                    .as_str()
                    .ok_or("normal Maka queued messageId missing")?;
                let mut wait_interval = tokio::time::interval(Duration::from_millis(50));
                loop {
                    wait_interval.tick().await;
                    let work = client
                        .query(
                            "agent",
                            "work",
                            json!({
                                "sessionId": session_id,
                                "target": {"kind": "message", "messageId": msg_id},
                                "cursor": null
                            }),
                        )
                        .await?;
                    match work["kind"].as_str() {
                        Some("delivered") => {
                            break work["execution"]["runId"]
                                .as_str()
                                .ok_or("normal Maka delivered runId missing")?
                                .to_owned();
                        }
                        Some("pending") => {}
                        _ => return Err(format!("normal Maka queued message failed: {work}")),
                    }
                }
            }
            _ => return Err(format!("normal Maka send rejected: {accepted}")),
        };

        let mut interval = tokio::time::interval(Duration::from_millis(50));
        let mut next = Box::pin(watch.next());
        loop {
            tokio::select! {
                ev = &mut next => {
                    match ev? {
                        Some(SubscriptionEvent::Item(_)) => {
                            next = Box::pin(watch.next());
                        }
                        _ => return Err("normal Maka watch ended prematurely".into()),
                    }
                }
                _ = interval.tick() => {
                    let exec = client
                        .query("agent", "execution", json!({"sessionId": session_id, "runId": run_id}))
                        .await?;
                    match exec["execution"]["state"]["kind"].as_str() {
                        Some("completed") => break,
                        Some("failed" | "cancelled") => {
                            return Err(format!("normal Maka run did not complete: {exec}"));
                        }
                        _ => {}
                    }
                }
            }
        }
        drop(next);
        watch.close().await?;
        Ok::<String, String>(session_id)
    }
    .await;

    let cleanup = shutdown_host_client(&mut child, &client, deadline).await;
    let session_id = session_res?;
    cleanup?;
    Ok(session_id)
}

#[expect(
    clippy::too_many_arguments,
    reason = "parity entry-point harness binds subject config, probe endpoint, isolated roots, artifacts, workspace, task input, step budget, and timeout explicitly"
)]
async fn run_eval_subject_entry(
    subject_id: &str,
    subject_config: &JsonObject,
    subject_credentials: &[String],
    probe_base_url: &str,
    eval_roots_dir: &Path,
    eval_artifacts_dir: &Path,
    workspace_path: &Path,
    task_input: &str,
    max_steps: u32,
    timeout: Duration,
) -> Result<(PathBuf, String), String> {
    let mut cfg = subject_config.clone();
    cfg.insert("baseUrl".into(), Value::String(probe_base_url.to_owned()));
    cfg.insert(
        "runtimeHostsPath".into(),
        Value::String(eval_roots_dir.to_string_lossy().into_owned()),
    );

    let spec = ExperimentSpec {
        schema_version: SchemaVersion::V2,
        id: "parity-check".into(),
        benchmark: BenchmarkSpec {
            id: "parity".into(),
            version: "1".into(),
            config: Map::new(),
        },
        executor: ExecutorSpec {
            kind: "local".into(),
            config: Map::new(),
        },
        execution: ExecutionSpec::default(),
        subjects: vec![SubjectSpec {
            id: subject_id.to_owned(),
            kind: SubjectKind::Maka,
            credentials: subject_credentials.to_vec(),
            config: cfg.clone(),
        }],
        tasks: vec![TaskSpec {
            id: "parity-task".into(),
            input: task_input.to_owned(),
            config: Map::new(),
        }],
        repetitions: 1,
        budget: json!({"maxSteps": max_steps}).as_object().unwrap().clone(),
        verifier: Map::new(),
    };
    let cell = ExperimentCell {
        id: format!("parity-task::1::{subject_id}"),
        experiment_id: spec.id.clone(),
        benchmark: spec.benchmark,
        executor: spec.executor,
        subject: spec.subjects[0].clone(),
        task: spec.tasks[0].clone(),
        repetition: 1,
        budget: spec.budget,
        verifier: spec.verifier,
    };

    let artifact_root = eval_artifacts_dir.join("maka-runtime-host");
    let mut metadata = Map::new();
    metadata.insert(
        "artifactRoot".into(),
        Value::String(artifact_root.to_string_lossy().into_owned()),
    );

    let runner = Arc::new(LocalProcessRunner {
        work_dir: eval_artifacts_dir.to_path_buf(),
        timeout,
    });
    let context = SubjectExecutionContext {
        cwd: workspace_path.to_string_lossy().into_owned(),
        task_input: task_input.to_owned(),
        metadata,
        cancel: CancellationToken::new(),
        runner,
    };

    let subject = RustHostSubject::new();
    subject
        .validate(&cell)
        .map_err(|e| format!("Eval subject validation failed: {e}"))?;
    let exec_result = subject.execute(&cell, context).await;
    if exec_result.outcome != ExecutionOutcome::Completed {
        return Err(format!(
            "Eval Maka entry point failed with {:?}: {:?}",
            exec_result.outcome, exec_result.failure_reason
        ));
    }

    let receipt_bytes = fs::read(artifact_root.join("execution-receipt.json"))
        .map_err(|e| format!("failed reading Eval execution-receipt.json: {e}"))?;
    let receipt: Value =
        serde_json::from_slice(&receipt_bytes).map_err(|e| format!("invalid receipt JSON: {e}"))?;
    let session_id = receipt["sessionId"]
        .as_str()
        .ok_or("Eval receipt missing sessionId")?
        .to_owned();
    let root_path = receipt["rootPath"]
        .as_str()
        .map(PathBuf::from)
        .ok_or("Eval receipt missing rootPath")?;

    Ok((root_path, session_id))
}

fn read_content_json(conn: &Connection, content_ref: &Value) -> Result<Value, String> {
    let digest = content_ref
        .get("digest")
        .and_then(Value::as_str)
        .ok_or("ContentRef missing digest")?;
    let bytes: Vec<u8> = conn
        .query_row(
            "SELECT payload FROM contents WHERE content_sha256 = ?",
            [digest],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("SQLite content read failed: {e}"))?
        .ok_or_else(|| format!("missing content payload for digest {digest}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("invalid JSON in content {digest}: {e}"))
}

fn extract_committed_parity_snapshot(
    root_path: &Path,
    session_id: &str,
    workspace_path: &Path,
    wire: &CapturedWireRequest,
) -> Result<ParitySnapshot, String> {
    let db_path = root_path.join(ROOT_SQLITE_FILENAME);
    let conn = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("failed opening {}: {e}", db_path.display()))?;

    let (run_id, spec_bytes): (String, Vec<u8>) = conn
        .query_row(
            "SELECT s.run, c.payload FROM agent_run_specs s JOIN contents c ON c.id = s.spec_content_id WHERE s.session = ? ORDER BY s.rowid ASC LIMIT 1",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("failed reading RunSpec for session {session_id}: {e}"))?;

    let run_spec: Value =
        serde_json::from_slice(&spec_bytes).map_err(|e| format!("invalid RunSpec JSON: {e}"))?;

    let accepted_model = read_content_json(&conn, &run_spec["backend"]["descriptor"])?;
    let connection_id = accepted_model
        .pointer("/binding/connectionId")
        .or_else(|| accepted_model.pointer("/binding/connection_id"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();

    let canonical_workspace =
        fs::canonicalize(workspace_path).unwrap_or_else(|_| workspace_path.to_path_buf());
    let canonical_root = fs::canonicalize(root_path).unwrap_or_else(|_| root_path.to_path_buf());
    let connection_namespace = camel_case_hyphen_letters(&connection_id);
    let normalizer = EphemeralNormalizer {
        session_id: session_id.to_owned(),
        connection_id,
        connection_namespace,
        workspace_raw: workspace_path.to_string_lossy().into_owned(),
        workspace_canonical: canonical_workspace.to_string_lossy().into_owned(),
        root_raw: root_path.to_string_lossy().into_owned(),
        root_canonical: canonical_root.to_string_lossy().into_owned(),
    };

    let system_prompt_blob = read_content_json(&conn, &run_spec["systemPrompt"])?;
    let system_prompt_text = system_prompt_blob["text"]
        .as_str()
        .ok_or("SystemPrompt.text missing")?
        .to_owned();

    let compaction_prompt = match run_spec.get("compactionPrompt") {
        Some(v) if !v.is_null() => {
            let digest = v["digest"]
                .as_str()
                .ok_or("compactionPrompt digest missing")?;
            let raw: Vec<u8> = conn
                .query_row(
                    "SELECT payload FROM contents WHERE content_sha256 = ?",
                    [digest],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            let decoded: Value = serde_json::from_slice(&raw)
                .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&raw).into_owned()));
            Some(
                decoded
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| decoded.to_string()),
            )
        }
        _ => None,
    };

    let tool_selection = normalize_tool_selection(
        &normalizer.normalize_value(&read_content_json(&conn, &run_spec["toolSelection"])?),
    );

    let allowed_tools = match run_spec.get("allowedTools") {
        None | Some(Value::Null) => None,
        Some(Value::Array(arr)) => Some(
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
        ),
        Some(other) => return Err(format!("unexpected allowedTools: {other}")),
    };

    let mut stmt = conn
        .prepare(
            "SELECT c.payload FROM agent_facts f JOIN contents c ON c.id = f.body_content_id WHERE f.run = ? ORDER BY f.revision ASC",
        )
        .map_err(|e| e.to_string())?;
    let fact_rows = stmt
        .query_map([&run_id], |row| row.get::<_, Vec<u8>>(0))
        .map_err(|e| e.to_string())?;

    let mut request_spec: Option<Value> = None;
    for row in fact_rows {
        let bytes = row.map_err(|e| e.to_string())?;
        let recorded: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if recorded.pointer("/fact/kind").and_then(Value::as_str) == Some("step_prepared") {
            let req_ref = &recorded["fact"]["request"];
            request_spec = Some(read_content_json(&conn, req_ref)?);
            break;
        }
    }
    let request_spec =
        request_spec.ok_or("Session Run has no committed step_prepared RequestSpec")?;
    let composition = &request_spec["composition"];
    let provenance = read_content_json(&conn, &request_spec["provenance"])?;

    let request_system_prompt = composition
        .get("systemPrompt")
        .and_then(Value::as_str)
        .map(|s| normalizer.normalize_str(s));

    let dynamic_context = composition["dynamicContext"]
        .as_array()
        .ok_or("RequestComposition.dynamicContext missing")?
        .iter()
        .filter_map(Value::as_str)
        .map(|s| normalizer.normalize_str(s))
        .collect();

    let composition_sources = composition["sources"]
        .as_array()
        .ok_or("RequestComposition.sources missing")?
        .iter()
        .map(|src| {
            let mut obj = src.as_object().cloned().unwrap_or_default();
            obj.remove("activation");
            if matches!(
                obj.get("kind").and_then(Value::as_str),
                Some("input" | "prompt_context" | "prompt_variable")
            ) {
                obj.remove("revision");
                obj.remove("entryId");
            }
            normalizer.normalize_value(&Value::Object(obj))
        })
        .collect();

    let tool_catalog_digest = composition["toolCatalogDigest"]
        .as_str()
        .ok_or("RequestComposition.toolCatalogDigest missing")?
        .to_owned();

    let tools = composition["tools"]
        .as_array()
        .ok_or("RequestComposition.tools missing")?
        .iter()
        .map(|t| normalizer.normalize_value(t))
        .collect();

    let sandbox_policy = normalizer.normalize_value(&run_spec["permissionCeiling"]["sandbox"]);
    let approval_policy = normalizer.normalize_value(&run_spec["permissionCeiling"]["approval"]);

    let context_policy = normalizer.normalize_value(&json!({
        "modelInputPolicy": provenance.get("modelInputPolicy").cloned().unwrap_or(Value::Null),
        "contextWindow": provenance.get("contextWindow").cloned().unwrap_or(Value::Null),
        "modelContextWindow": provenance.get("modelContextWindow").cloned().unwrap_or(Value::Null),
        "declaredWindow": provenance.get("declaredWindow").cloned().unwrap_or(Value::Null),
        "publicModel": accepted_model.get("public_model").cloned().unwrap_or(Value::Null),
        "modelOverride": accepted_model.get("model_override").cloned().unwrap_or(Value::Null),
        "bodyOverlay": accepted_model.get("body_overlay").cloned().unwrap_or(Value::Null),
    }));

    let wire_normalized = normalizer.normalize_value(&wire.body);
    let mut wire_rest = wire_normalized.as_object().cloned().unwrap_or_default();
    let wire_model = wire_rest
        .remove("model")
        .and_then(|v| v.as_str().map(str::to_owned));
    let wire_tools = wire_rest.remove("tools").unwrap_or(Value::Null);
    let wire_messages = json!({
        "system": wire_rest.remove("system").unwrap_or(Value::Null),
        "messages": wire_rest.remove("messages").unwrap_or(Value::Null),
        "input": wire_rest.remove("input").unwrap_or(Value::Null),
        "instructions": wire_rest.remove("instructions").unwrap_or(Value::Null),
    });

    Ok(ParitySnapshot {
        system_prompt_text: normalizer.normalize_str(&system_prompt_text),
        request_system_prompt,
        compaction_prompt: compaction_prompt.map(|s| normalizer.normalize_str(&s)),
        language: run_spec.get("language").cloned().unwrap_or(Value::Null),
        dynamic_context,
        composition_sources,
        allowed_tools,
        tool_discovery: run_spec["toolDiscovery"].as_bool().unwrap_or(false),
        tool_selection,
        tool_mode: accepted_model
            .get("tool_mode")
            .cloned()
            .unwrap_or_else(|| Value::String("code_mode".into())),
        code_language: accepted_model
            .get("code_language")
            .cloned()
            .unwrap_or_else(|| Value::String("javascript".into())),
        editing_tools: accepted_model
            .get("editing_tools")
            .cloned()
            .unwrap_or(Value::Null),
        tool_catalog_digest,
        tools,
        collaboration: run_spec
            .get("collaboration")
            .cloned()
            .unwrap_or(Value::Null),
        approval_policy,
        sandbox_policy,
        thinking_level: accepted_model
            .get("thinking_level")
            .cloned()
            .unwrap_or(Value::Null),
        provider_options: normalizer.normalize_value(
            &composition
                .get("providerOptions")
                .cloned()
                .unwrap_or(Value::Null),
        ),
        max_output_tokens: composition
            .get("maxOutputTokens")
            .cloned()
            .unwrap_or(Value::Null),
        context_policy,
        wire_path: wire.path.clone(),
        wire_model,
        wire_messages,
        wire_tools,
        wire_options: Value::Object(wire_rest),
    })
}

struct EphemeralNormalizer {
    session_id: String,
    connection_id: String,
    connection_namespace: String,
    workspace_raw: String,
    workspace_canonical: String,
    root_raw: String,
    root_canonical: String,
}

fn camel_case_hyphen_letters(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '-'
            && let Some(&next) = chars.peek()
            && next.is_ascii_alphabetic()
        {
            out.push(next.to_ascii_uppercase());
            chars.next();
        } else {
            out.push(ch);
        }
    }
    out
}

fn normalize_tool_selection(value: &Value) -> Value {
    let mut cloned = value.clone();
    if let Some(services) = cloned.get_mut("services").and_then(Value::as_array_mut) {
        for item in services {
            if let Some(obj) = item.as_object_mut()
                && obj
                    .get("binding")
                    .and_then(Value::as_str)
                    .is_some_and(is_sha256_prefixed_hex)
            {
                obj.insert(
                    "binding".into(),
                    Value::String("<HOST_SERVICE_BINDING>".into()),
                );
            }
        }
    }
    cloned
}

fn is_sha256_prefixed_hex(s: &str) -> bool {
    s.strip_prefix("sha256:")
        .is_some_and(|hex| hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn replace_skill_revision_tokens(input: &str) -> String {
    const PREFIX: &str = "revision = sha256:";
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(idx) = rest.find(PREFIX) {
        out.push_str(&rest[..idx]);
        out.push_str(PREFIX);
        let after = &rest[idx + PREFIX.len()..];
        if after.len() >= 64 && after.as_bytes()[..64].iter().all(u8::is_ascii_hexdigit) {
            out.push_str("<SKILL_PREPARATION_REVISION>");
            rest = &after[64..];
        } else {
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

impl EphemeralNormalizer {
    fn normalize_str(&self, input: &str) -> String {
        let mut out =
            replace_skill_revision_tokens(&input.replace(&self.session_id, "<SESSION_ID>"));
        for (candidate, replacement) in [
            (&self.connection_id, "<CONNECTION_ID>"),
            (&self.connection_namespace, "<CONNECTION_ID>"),
            (&self.workspace_canonical, "<WORKSPACE_PATH>"),
            (&self.workspace_raw, "<WORKSPACE_PATH>"),
            (&self.root_canonical, "<ROOT_PATH>"),
            (&self.root_raw, "<ROOT_PATH>"),
        ] {
            if !candidate.is_empty() {
                out = out.replace(candidate, replacement);
            }
        }
        out
    }

    fn normalize_value(&self, value: &Value) -> Value {
        match value {
            Value::String(s) => Value::String(self.normalize_str(s)),
            Value::Array(items) => {
                Value::Array(items.iter().map(|v| self.normalize_value(v)).collect())
            }
            Value::Object(map) => {
                let mut out = BTreeMap::new();
                for (k, v) in map {
                    out.insert(self.normalize_str(k), self.normalize_value(v));
                }
                Value::Object(out.into_iter().collect())
            }
            other => other.clone(),
        }
    }
}

/// Checks whether routing `config.base_url` through the local loopback metering gateway
/// would silently alter URL-dependent Maka policy relative to the declared upstream URL.
pub fn check_declared_endpoint_route_parity(config: &MakaSubjectConfig) -> Vec<ParityMismatch> {
    let mut mismatches = Vec::new();
    let apply_patch_override = config
        .model_override
        .as_ref()
        .and_then(|ov| ov.get("applyPatch"))
        .and_then(Value::as_bool);

    let declared_apply_patch =
        effective_apply_patch(&config.model, &config.base_url, apply_patch_override);
    let loopback_apply_patch =
        effective_apply_patch(&config.model, "http://127.0.0.1/v1", apply_patch_override);
    if declared_apply_patch != loopback_apply_patch {
        mismatches.push(ParityMismatch {
            dimension: "tool_exposure".into(),
            field: "declaredEndpointEditingTools".into(),
            normal: Value::String(if declared_apply_patch {
                "apply_patch".into()
            } else {
                "structured".into()
            }),
            eval: Value::String(if loopback_apply_patch {
                "apply_patch".into()
            } else {
                "structured".into()
            }),
        });
    }
    mismatches
}

fn effective_apply_patch(model_id: &str, request_url: &str, enabled: Option<bool>) -> bool {
    enabled.unwrap_or_else(|| {
        let lower = model_id.to_ascii_lowercase();
        lower.contains("gpt-")
            || lower.contains("deepseek")
            || url::Url::parse(request_url).ok().is_some_and(|u| {
                matches!(u.scheme(), "http" | "https") && u.host_str() == Some("api.deepseek.com")
            })
    })
}

/// Compares normalized snapshots from the normal Maka client and the `maka-eval` entry point.
pub fn compare_parity_snapshots(
    subject_id: &str,
    maka_version: &str,
    maka_executable_sha256: &str,
    declared_config_sha256: &str,
    normal: &ParitySnapshot,
    eval: &ParitySnapshot,
    mut mismatches: Vec<ParityMismatch>,
) -> ParityVerificationReport {
    let mut check_dim = |dimension: &str,
                         comparisons: &[(&str, Value, Value)],
                         detail_ok: &str|
     -> ParityCheckResult {
        let before = mismatches.len();
        for (field, lhs, rhs) in comparisons {
            if lhs != rhs {
                mismatches.push(ParityMismatch {
                    dimension: dimension.to_owned(),
                    field: (*field).to_owned(),
                    normal: lhs.clone(),
                    eval: rhs.clone(),
                });
            }
        }
        let dim_failed = mismatches
            .iter()
            .skip(before)
            .any(|m| m.dimension == dimension)
            || mismatches[..before]
                .iter()
                .any(|m| m.dimension == dimension);
        ParityCheckResult {
            dimension: dimension.to_owned(),
            passed: !dim_failed,
            detail: if dim_failed {
                format!("{dimension} drifted between normal Maka client and Eval entry point")
            } else {
                detail_ok.to_owned()
            },
        }
    };

    let composition_check = check_dim(
        "product_composition",
        &[(
            "compositionSources",
            Value::Array(normal.composition_sources.clone()),
            Value::Array(eval.composition_sources.clone()),
        )],
        "System prompt, adapter, skill, and tool composition sources come from identical released product packages",
    );

    let instructions_check = check_dim(
        "effective_instructions",
        &[
            (
                "runSpecSystemPrompt",
                Value::String(normal.system_prompt_text.clone()),
                Value::String(eval.system_prompt_text.clone()),
            ),
            (
                "requestCompositionSystemPrompt",
                serde_json::to_value(&normal.request_system_prompt).unwrap(),
                serde_json::to_value(&eval.request_system_prompt).unwrap(),
            ),
            (
                "compactionPrompt",
                serde_json::to_value(&normal.compaction_prompt).unwrap(),
                serde_json::to_value(&eval.compaction_prompt).unwrap(),
            ),
            ("language", normal.language.clone(), eval.language.clone()),
            (
                "dynamicContext",
                serde_json::to_value(&normal.dynamic_context).unwrap(),
                serde_json::to_value(&eval.dynamic_context).unwrap(),
            ),
            (
                "wireMessages",
                normal.wire_messages.clone(),
                eval.wire_messages.clone(),
            ),
        ],
        "System prompts, compaction instructions, dynamic workspace context, and outbound prompt messages match",
    );

    let tools_check = check_dim(
        "tool_exposure",
        &[
            (
                "allowedToolsUnpruned",
                serde_json::to_value(&normal.allowed_tools).unwrap(),
                Value::Null,
            ),
            (
                "evalAllowedToolsUnpruned",
                Value::Null,
                serde_json::to_value(&eval.allowed_tools).unwrap(),
            ),
            (
                "toolDiscovery",
                Value::Bool(normal.tool_discovery),
                Value::Bool(eval.tool_discovery),
            ),
            (
                "toolSelection",
                normal.tool_selection.clone(),
                eval.tool_selection.clone(),
            ),
            ("toolMode", normal.tool_mode.clone(), eval.tool_mode.clone()),
            (
                "codeLanguage",
                normal.code_language.clone(),
                eval.code_language.clone(),
            ),
            (
                "editingTools",
                normal.editing_tools.clone(),
                eval.editing_tools.clone(),
            ),
            (
                "toolCatalogDigest",
                Value::String(normal.tool_catalog_digest.clone()),
                Value::String(eval.tool_catalog_digest.clone()),
            ),
            (
                "requestCompositionTools",
                Value::Array(normal.tools.clone()),
                Value::Array(eval.tools.clone()),
            ),
            (
                "wireTools",
                normal.wire_tools.clone(),
                eval.wire_tools.clone(),
            ),
        ],
        "Full unpruned toolset, schemas, descriptions, tool discovery, Code Mode, and built-in skills match",
    );

    let policies_check = check_dim(
        "execution_policies",
        &[
            (
                "collaborationMode",
                normal.collaboration.clone(),
                eval.collaboration.clone(),
            ),
            (
                "approvalPolicy",
                normal.approval_policy.clone(),
                eval.approval_policy.clone(),
            ),
            (
                "sandboxPolicy",
                normal.sandbox_policy.clone(),
                eval.sandbox_policy.clone(),
            ),
            (
                "thinkingLevel",
                normal.thinking_level.clone(),
                eval.thinking_level.clone(),
            ),
            (
                "providerOptions",
                normal.provider_options.clone(),
                eval.provider_options.clone(),
            ),
            (
                "maxOutputTokens",
                normal.max_output_tokens.clone(),
                eval.max_output_tokens.clone(),
            ),
            (
                "contextAndCompactionPolicy",
                normal.context_policy.clone(),
                eval.context_policy.clone(),
            ),
            (
                "wirePath",
                Value::String(normal.wire_path.clone()),
                Value::String(eval.wire_path.clone()),
            ),
            (
                "wireModel",
                serde_json::to_value(&normal.wire_model).unwrap(),
                serde_json::to_value(&eval.wire_model).unwrap(),
            ),
            (
                "wireOptions",
                normal.wire_options.clone(),
                eval.wire_options.clone(),
            ),
        ],
        "Sandbox ceiling, approval policy, context/compaction window, reasoning level, and wire options match",
    );

    let exposed_tool_names: Vec<String> = eval
        .tools
        .iter()
        .filter_map(|t| t.get("name").and_then(Value::as_str).map(str::to_owned))
        .collect();

    let checks = vec![
        composition_check,
        instructions_check,
        tools_check,
        policies_check,
    ];
    let passed = mismatches.is_empty() && checks.iter().all(|c| c.passed);

    ParityVerificationReport {
        schema_version: PARITY_REPORT_SCHEMA_VERSION.into(),
        subject_id: subject_id.to_owned(),
        passed,
        maka_version: maka_version.to_owned(),
        maka_executable_sha256: maka_executable_sha256.to_owned(),
        declared_config_sha256: declared_config_sha256.to_owned(),
        normal_tool_catalog_digest: normal.tool_catalog_digest.clone(),
        eval_tool_catalog_digest: eval.tool_catalog_digest.clone(),
        exposed_tool_names,
        checks,
        mismatches,
    }
}
