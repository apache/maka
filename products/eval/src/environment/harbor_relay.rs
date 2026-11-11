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

//! Loopback TCP JSON-line relay server and Harbor/Pier trial executor.
//!
//! Implements the exact `ready` -> `execute` -> `executed` -> `verify` protocol
//! spoken by `products/eval/harbor/relay_agent.py` and `run_trial.py`, including
//! version-mismatch exit code detection (`78`), `SIGTERM` -> `SIGKILL` process
//! termination escalation, `<trial_path>/result.json` reward extraction, and
//! collected artifact SHA-256 inventory.

use crate::contract::{
    ContractError, EgressAuditState, EvalResultStatus, ExperimentCell, JsonObject, V2AttemptRecord,
    sha256_hex,
};
use crate::environment::{
    ActiveTrialAttempt, BoxFuture, CommandRunner, EgressAuditEvidence, ExecutorPreparationCode,
    ExecutorVerification, HarborExecutorConfig, IndeterminateCause, SubjectExecutionContext,
    SubjectProcessDiagnostic, SubjectProcessDiagnosticCategory, SubjectProcessOutput,
    SubjectProcessRequest, SubjectProcessTermination, TrialAttemptOperation, TrialEnvironment,
    TrialEnvironmentOutcome, harbor_trial_name_for_attempt, read_egress_audit_evidence,
};
use crate::store::{
    MAKA_RUNTIME_ARTIFACT_PATH, MAKA_SUBJECT_STDERR_PATH, MAKA_SUBJECT_STDOUT_PATH,
    write_atomic_bytes,
};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub const FRAMEWORK_VERSION_MISMATCH_EXIT_CODE: i32 = 78;
pub const PYTHON_TEARDOWN_DEADLINE_MS: u64 = 110_000;
pub const RELAY_SETTLEMENT_DEADLINE_MS: u64 = 120_000;
pub const TERM_SETTLEMENT_DEADLINE_MS: u64 = 20_000;
pub const KILL_SETTLEMENT_DEADLINE_MS: u64 = 5_000;

/// Returns the path to the bundled `products/eval/harbor` directory.
pub fn bundled_harbor_relay_root() -> PathBuf {
    if let Ok(custom) = std::env::var("MAKA_EVAL_HARBOR_ROOT")
        && !custom.is_empty()
    {
        return PathBuf::from(custom);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("harbor")
}

/// Terminates a trial child process (`SIGTERM` -> `SIGKILL`) and returns `true`
/// if the child exited cleanly on `SIGTERM`.
async fn terminate_trial(child: &mut Child, deadline_ms: u64) -> bool {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        unsafe {
            let _ = libc::kill(pid as i32, libc::SIGTERM);
        }
    }
    if let Ok(Ok(status)) =
        tokio::time::timeout(Duration::from_millis(deadline_ms), child.wait()).await
    {
        return status.success();
    }

    let _ = child.start_kill();
    let _ = tokio::time::timeout(
        Duration::from_millis(KILL_SETTLEMENT_DEADLINE_MS),
        child.wait(),
    )
    .await;
    false
}

struct RelaySocketRunner {
    token: String,
    result_token: String,
    credentials: HashMap<String, String>,
    execution_environment: HashMap<String, String>,
    stream: Arc<Mutex<BufReader<TcpStream>>>,
    used: AtomicBool,
    last_diagnostic: Arc<Mutex<Option<SubjectProcessDiagnostic>>>,
}

impl CommandRunner for RelaySocketRunner {
    fn execute<'a>(
        &'a self,
        request: SubjectProcessRequest,
    ) -> BoxFuture<'a, Result<SubjectProcessOutput, String>> {
        Box::pin(async move {
            if self.used.swap(true, Ordering::SeqCst) {
                return Err("Trial already executed its subject".into());
            }
            let mut mapped_credentials = HashMap::new();
            for (target, source) in &request.credential_environment {
                let value = self
                    .credentials
                    .get(source)
                    .ok_or_else(|| format!("credential {source} was not admitted"))?;
                mapped_credentials.insert(target.clone(), value.clone());
            }

            let mut merged_env = request.environment.clone();
            for (k, v) in &self.execution_environment {
                if merged_env.contains_key(k) {
                    return Err(format!(
                        "subject environment overrides Eval execution environment: {k}"
                    ));
                }
                merged_env.insert(k.clone(), v.clone());
            }

            let execute_msg = json!({
                "token": self.token,
                "kind": "execute",
                "command": request.command,
                "args": request.args,
                "environment": merged_env,
                "credentials": mapped_credentials,
                "resultToken": self.result_token,
                "captureStdout": request.capture_stdout,
            });
            let mut payload =
                serde_json::to_vec(&execute_msg).map_err(|e| format!("json error: {e}"))?;
            payload.push(b'\n');

            let mut line = String::new();
            {
                let mut reader = self.stream.lock().await;
                reader
                    .get_mut()
                    .write_all(&payload)
                    .await
                    .map_err(|_| "relay transport is unavailable".to_owned())?;
                reader
                    .get_mut()
                    .flush()
                    .await
                    .map_err(|_| "relay transport is unavailable".to_owned())?;
                let bytes_read = reader
                    .read_line(&mut line)
                    .await
                    .map_err(|_| "relay execution result was unavailable".to_owned())?;
                if bytes_read == 0 {
                    return Err("relay execution result was unavailable".into());
                }
            }

            let executed: Value = serde_json::from_str(line.trim())
                .map_err(|_| "relay returned an invalid execution result".to_owned())?;
            if executed.get("token").and_then(Value::as_str) != Some(&self.token)
                || executed.get("kind").and_then(Value::as_str) != Some("executed")
            {
                return Err("relay returned an invalid execution result".into());
            }
            let termination = match executed.get("termination").and_then(Value::as_str) {
                Some("exited") => SubjectProcessTermination::Exited,
                Some("framework_timeout") => SubjectProcessTermination::FrameworkTimeout,
                _ => return Err("relay returned an invalid execution result".into()),
            };
            let exit_code = executed
                .get("exitCode")
                .and_then(Value::as_i64)
                .and_then(|c| i32::try_from(c).ok())
                .ok_or_else(|| "relay returned an invalid execution result".to_owned())?;
            let stdout = executed
                .get("stdout")
                .and_then(Value::as_str)
                .ok_or_else(|| "relay returned an invalid execution result".to_owned())?
                .to_owned();
            let diag_val = executed
                .get("diagnostic")
                .ok_or_else(|| "relay returned an invalid execution result".to_owned())?;
            let diagnostic = decode_process_diagnostic(diag_val)
                .ok_or_else(|| "relay returned an invalid execution result".to_owned())?;
            *self.last_diagnostic.lock().await = Some(diagnostic.clone());

            Ok(SubjectProcessOutput {
                termination,
                exit_code,
                stdout,
                stderr: String::new(),
                diagnostic: Some(diagnostic),
            })
        })
    }
}

fn decode_process_diagnostic(value: &Value) -> Option<SubjectProcessDiagnostic> {
    let obj = value.as_object()?;
    let cat_str = obj.get("category")?.as_str()?;
    let category = match cat_str {
        "none" if obj.len() == 1 => {
            return Some(SubjectProcessDiagnostic {
                category: SubjectProcessDiagnosticCategory::None,
                bytes: None,
                sha256: None,
            });
        }
        "unstructured-output" => SubjectProcessDiagnosticCategory::UnstructuredOutput,
        "result-frame-missing" => SubjectProcessDiagnosticCategory::ResultFrameMissing,
        "result-frame-invalid" => SubjectProcessDiagnosticCategory::ResultFrameInvalid,
        "result-frame-ambiguous" => SubjectProcessDiagnosticCategory::ResultFrameAmbiguous,
        "result-frame-oversize" => SubjectProcessDiagnosticCategory::ResultFrameOversize,
        "execution-scope-unavailable" => {
            SubjectProcessDiagnosticCategory::ExecutionScopeUnavailable
        }
        _ => return None,
    };
    if obj.len() != 3 {
        return None;
    }
    let bytes = obj.get("bytes")?.as_u64()?;
    let sha256 = obj.get("sha256")?.as_str()?;
    if sha256.len() != 64
        || !sha256
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return None;
    }
    Some(SubjectProcessDiagnostic {
        category,
        bytes: Some(bytes),
        sha256: Some(sha256.to_owned()),
    })
}

struct ActiveHarborAttempt<'a> {
    cell: &'a ExperimentCell,
    framework: String,
    egress_required: bool,
    trial_name: String,
    trial_path: PathBuf,
    token: String,
    context: SubjectExecutionContext,
    stream: Arc<Mutex<BufReader<TcpStream>>>,
    child: Arc<Mutex<Child>>,
    decision_sent: Arc<AtomicBool>,
    finalization_confirmed: Arc<Mutex<Option<bool>>>,
}

impl ActiveTrialAttempt for ActiveHarborAttempt<'_> {
    fn context(&self) -> SubjectExecutionContext {
        self.context.clone()
    }

    fn verify(&self) -> BoxFuture<'_, Result<ExecutorVerification, String>> {
        Box::pin(async move {
            if !self.decision_sent.swap(true, Ordering::SeqCst) {
                let verify_msg = json!({
                    "token": self.token,
                    "kind": "verify",
                });
                let mut payload = serde_json::to_vec(&verify_msg).unwrap_or_default();
                payload.push(b'\n');
                let mut reader = self.stream.lock().await;
                if reader.get_mut().write_all(&payload).await.is_err()
                    || reader.get_mut().shutdown().await.is_err()
                {
                    let mut child = self.child.lock().await;
                    let ok = terminate_trial(&mut child, RELAY_SETTLEMENT_DEADLINE_MS).await;
                    *self.finalization_confirmed.lock().await = Some(ok);
                    return Err("relay verify decision was not delivered".into());
                }
            }
            let ok = {
                let mut child = self.child.lock().await;
                child.wait().await.ok().is_some_and(|s| s.success())
            };
            *self.finalization_confirmed.lock().await = Some(ok);
            if !ok {
                return Err("Trial did not finalize cleanly".into());
            }
            read_trial_verification(
                &self.trial_path,
                &self.trial_name,
                self.cell,
                &self.framework,
                self.egress_required,
            )
        })
    }

    fn read_audit(&self) -> BoxFuture<'_, (EgressAuditState, EgressAuditEvidence)> {
        let path = self.trial_path.clone();
        let req = self.egress_required;
        Box::pin(async move { read_egress_audit_evidence(&path, req) })
    }
}

/// Reads `<trial_path>/result.json`, extracts the verifier reward key without ever
/// defaulting a missing reward to `0.0`, verifies egress audit evidence, and walks
/// collected artifacts.
pub fn read_trial_verification(
    trial_path: &Path,
    trial_name: &str,
    cell: &ExperimentCell,
    framework: &str,
    audit_required: bool,
) -> Result<ExecutorVerification, String> {
    let result_bytes = std::fs::read(trial_path.join("result.json"))
        .map_err(|e| format!("failed to read trial result.json: {e}"))?;
    let result_json: Value = serde_json::from_slice(&result_bytes)
        .map_err(|e| format!("invalid trial result.json: {e}"))?;

    let reward_key = cell
        .verifier
        .get("reward")
        .and_then(Value::as_str)
        .unwrap_or("reward");

    let exception_type = result_json
        .get("exception_info")
        .and_then(|v| v.get("exception_type"))
        .and_then(Value::as_str);
    let subject_exception = matches!(
        exception_type,
        Some("AgentTimeoutError") | Some("NonZeroAgentExitCodeError")
    );
    if result_json
        .get("exception_info")
        .is_some_and(|v| !v.is_null())
        && !subject_exception
    {
        return Err("Trial failed outside subject execution".into());
    }

    let score = result_json
        .get("verifier_result")
        .and_then(|vr| vr.get("rewards"))
        .and_then(|r| r.get(reward_key))
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite());

    let (_, audit) = read_egress_audit_evidence(trial_path, audit_required);
    let missing_reward = score.is_none();
    let base_failure = missing_reward.then(|| "verifier produced no reward".to_owned());
    let status = if audit.failure_reason.is_some() || missing_reward {
        EvalResultStatus::InfraFailed
    } else if subject_exception {
        EvalResultStatus::SubjectFailed
    } else {
        EvalResultStatus::Completed
    };

    let mut artifacts = Vec::new();
    let mut trial_art = Map::new();
    trial_art.insert("kind".into(), Value::String("trial".into()));
    trial_art.insert(
        "framework".into(),
        Value::String(cell.executor.kind.as_str().into()),
    );
    trial_art.insert("trialName".into(), Value::String(trial_name.into()));
    artifacts.push(trial_art);
    artifacts.extend(collected_artifact_inventory(trial_path, framework));
    artifacts.extend(audit.artifacts);

    Ok(ExecutorVerification {
        status,
        score,
        failure_reason: audit.failure_reason.or(base_failure),
        artifacts,
        missing_reward,
    })
}

pub fn collected_artifact_inventory(trial_path: &Path, framework: &str) -> Vec<JsonObject> {
    let root = if framework == "pier" {
        trial_path.join("artifacts")
    } else {
        trial_path.join("artifacts").join("logs").join("artifacts")
    };
    let targets = [
        root.join(
            Path::new(MAKA_RUNTIME_ARTIFACT_PATH)
                .file_name()
                .unwrap_or_default(),
        ),
        root.join(
            Path::new(MAKA_SUBJECT_STDOUT_PATH)
                .file_name()
                .unwrap_or_default(),
        ),
        root.join(
            Path::new(MAKA_SUBJECT_STDERR_PATH)
                .file_name()
                .unwrap_or_default(),
        ),
    ];
    let mut files = Vec::new();
    for target in &targets {
        walk_collected_artifacts(trial_path, target, &mut files);
    }
    files.sort_by(|a, b| {
        let pa = a.get("path").and_then(Value::as_str).unwrap_or("");
        let pb = b.get("path").and_then(Value::as_str).unwrap_or("");
        pa.cmp(pb)
    });
    files
}

fn walk_collected_artifacts(trial_path: &Path, current: &Path, out: &mut Vec<JsonObject>) {
    let Ok(meta) = std::fs::symlink_metadata(current) else {
        return;
    };
    if meta.file_type().is_symlink() {
        return;
    }
    if meta.is_file() {
        let Ok(bytes) = std::fs::read(current) else {
            return;
        };
        let Ok(rel) = current.strip_prefix(trial_path) else {
            return;
        };
        let rel_str = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        let mut obj = Map::new();
        obj.insert("kind".into(), Value::String("collected-artifact".into()));
        obj.insert("path".into(), Value::String(rel_str));
        obj.insert("bytes".into(), Value::from(bytes.len() as u64));
        obj.insert(
            "sha256".into(),
            Value::String(format!("sha256:{}", sha256_hex(&bytes))),
        );
        out.push(obj);
        return;
    }
    if meta.is_dir()
        && let Ok(entries) = std::fs::read_dir(current)
    {
        for entry in entries.flatten() {
            walk_collected_artifacts(trial_path, &entry.path(), out);
        }
    }
}

/// Real Harbor / Pier trial environment that binds a loopback TCP relay server,
/// writes `<trialName>.json` with `relay_agent:RelayAgent`, spawns `run_trial.py`
/// (or a custom trial command for testing), and coordinates the trial lifecycle.
pub struct HarborTrialEnvironment {
    config: HarborExecutorConfig,
    spec_dir: PathBuf,
    env_overrides: HashMap<String, String>,
}

impl HarborTrialEnvironment {
    pub fn new(config: HarborExecutorConfig, spec_dir: PathBuf) -> Self {
        Self {
            config,
            spec_dir,
            env_overrides: HashMap::new(),
        }
    }

    pub fn with_env_overrides(mut self, env_overrides: HashMap<String, String>) -> Self {
        self.env_overrides = env_overrides;
        self
    }

    fn resolve_env_var(&self, key: &str) -> Option<String> {
        self.env_overrides
            .get(key)
            .cloned()
            .or_else(|| std::env::var(key).ok())
            .filter(|v| !v.is_empty())
    }

    fn resolve_trials_root(&self) -> Result<PathBuf, String> {
        let raw = self
            .resolve_env_var(&self.config.trials_root_env)
            .ok_or_else(|| {
                format!(
                    "machine path {} is unavailable",
                    self.config.trials_root_env
                )
            })?;
        Ok(PathBuf::from(raw))
    }

    fn resolve_python_executable(&self) -> Result<PathBuf, String> {
        let raw = self
            .resolve_env_var(&self.config.python_path_env)
            .ok_or_else(|| {
                format!(
                    "machine path {} is unavailable",
                    self.config.python_path_env
                )
            })?;
        Ok(PathBuf::from(raw))
    }
}

impl TrialEnvironment for HarborTrialEnvironment {
    fn kind(&self) -> &str {
        &self.config.framework
    }

    fn validate(&self, cell: &ExperimentCell) -> Result<(), ContractError> {
        let _ = self.config.validate_task(cell)?;
        Ok(())
    }

    fn preflight(
        &self,
        subject_credential_names: &[String],
        cancel: CancellationToken,
    ) -> BoxFuture<'_, Result<(), ContractError>> {
        let cred_names: Vec<String> = subject_credential_names.to_vec();
        Box::pin(async move {
            if cancel.is_cancelled() {
                return Err(ContractError::Invalid("preflight cancelled".into()));
            }
            let _ = self.resolve_trials_root().map_err(ContractError::Invalid)?;
            let _ = self
                .resolve_python_executable()
                .map_err(ContractError::Invalid)?;
            for name in &cred_names {
                if self.resolve_env_var(name).is_none() {
                    return Err(ContractError::Invalid(format!(
                        "subject credential {name} is required"
                    )));
                }
            }
            Ok(())
        })
    }

    fn run_attempt<'a>(
        &'a self,
        cell: &'a ExperimentCell,
        sequence: u32,
        _subject_credential_names: &'a [String],
        cancel: CancellationToken,
        operation: TrialAttemptOperation<'a>,
    ) -> BoxFuture<'a, Result<TrialEnvironmentOutcome<V2AttemptRecord>, String>> {
        Box::pin(async move {
            if cancel.is_cancelled() {
                return Ok(TrialEnvironmentOutcome::NotStarted {
                    code: ExecutorPreparationCode::Cancelled,
                    artifacts: Vec::new(),
                });
            }

            let trials_root = match self.resolve_trials_root() {
                Ok(p) => p,
                Err(_) => {
                    return Ok(TrialEnvironmentOutcome::NotStarted {
                        code: ExecutorPreparationCode::PreparationFailed,
                        artifacts: Vec::new(),
                    });
                }
            };
            let python_exe = match self.resolve_python_executable() {
                Ok(p) => p,
                Err(_) => {
                    return Ok(TrialEnvironmentOutcome::NotStarted {
                        code: ExecutorPreparationCode::PreparationFailed,
                        artifacts: Vec::new(),
                    });
                }
            };

            let mut credentials = HashMap::new();
            for name in &cell.subject.credentials {
                let Some(val) = self.resolve_env_var(name) else {
                    return Ok(TrialEnvironmentOutcome::NotStarted {
                        code: ExecutorPreparationCode::PreparationFailed,
                        artifacts: Vec::new(),
                    });
                };
                credentials.insert(name.clone(), val);
            }

            if std::fs::create_dir_all(&trials_root).is_err() {
                return Ok(TrialEnvironmentOutcome::NotStarted {
                    code: ExecutorPreparationCode::PreparationFailed,
                    artifacts: Vec::new(),
                });
            }

            let trial_name = harbor_trial_name_for_attempt(&cell.id, sequence);
            let config_path = trials_root.join(format!("{trial_name}.json"));
            let trial_path = trials_root.join(&trial_name);
            let relay_token = format!(
                "{}{}",
                Uuid::new_v4().simple(),
                &Uuid::new_v4().simple().to_string()[..16]
            );

            let listener = match TcpListener::bind("127.0.0.1:0").await {
                Ok(l) => l,
                Err(_) => {
                    return Ok(TrialEnvironmentOutcome::NotStarted {
                        code: ExecutorPreparationCode::PreparationFailed,
                        artifacts: Vec::new(),
                    });
                }
            };
            let relay_port = match listener.local_addr() {
                Ok(addr) => addr.port(),
                Err(_) => {
                    return Ok(TrialEnvironmentOutcome::NotStarted {
                        code: ExecutorPreparationCode::PreparationFailed,
                        artifacts: Vec::new(),
                    });
                }
            };

            let task_path = match self.config.validate_task(cell) {
                Ok(p) => p.to_string_lossy().to_string(),
                Err(_) => {
                    return Ok(TrialEnvironmentOutcome::NotStarted {
                        code: ExecutorPreparationCode::PreparationFailed,
                        artifacts: Vec::new(),
                    });
                }
            };
            let timeout_multiplier = cell
                .budget
                .get("timeoutMultiplier")
                .and_then(Value::as_f64)
                .unwrap_or(1.0);

            let trial_config = json!({
                "task": {
                    "path": task_path,
                    "git_url": cell.benchmark.config.get("repository").and_then(Value::as_str).unwrap_or(""),
                    "git_commit_id": cell.benchmark.version,
                },
                "trial_name": trial_name,
                "trials_dir": trials_root.to_string_lossy(),
                "timeout_multiplier": timeout_multiplier,
                "agent": {
                    "import_path": "relay_agent:RelayAgent",
                    "kwargs": {
                        "relay_host": "127.0.0.1",
                        "relay_port": relay_port,
                        "relay_token": relay_token,
                        "teardown_timeout_ms": PYTHON_TEARDOWN_DEADLINE_MS,
                    }
                },
                "environment": cell.executor.config.get("environment").cloned().unwrap_or_else(|| json!({})),
            });
            let mut config_bytes = serde_json::to_vec(&trial_config).unwrap_or_default();
            config_bytes.push(b'\n');
            if write_atomic_bytes(&config_path, &config_bytes).is_err() {
                return Ok(TrialEnvironmentOutcome::NotStarted {
                    code: ExecutorPreparationCode::PreparationFailed,
                    artifacts: Vec::new(),
                });
            }

            let run_trial_script = bundled_harbor_relay_root().join("run_trial.py");

            let mut cmd = Command::new(&python_exe);
            cmd.arg(&run_trial_script)
                .arg(&self.config.framework)
                .arg(&self.config.framework_version)
                .arg(&config_path)
                .current_dir(&self.spec_dir)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            cmd.env("PYTHONPATH", bundled_harbor_relay_root());
            if self.config.egress_proxy_required {
                cmd.env("MAKA_EVAL_EGRESS_REQUIRED", "1");
            }

            let mut child = match cmd.spawn() {
                Ok(c) => c,
                Err(_) => {
                    let _ = std::fs::remove_file(&config_path);
                    return Ok(TrialEnvironmentOutcome::NotStarted {
                        code: ExecutorPreparationCode::SpawnFailed,
                        artifacts: vec![preparation_artifact(
                            &self.config.framework,
                            &trial_name,
                            &trial_path,
                            "spawn",
                            ExecutorPreparationCode::SpawnFailed,
                            None,
                        )],
                    });
                }
            };

            // Wait for either the relay TCP connection or premature process exit.
            let accept_res = tokio::select! {
                _ = cancel.cancelled() => {
                    let _ = terminate_trial(&mut child, TERM_SETTLEMENT_DEADLINE_MS).await;
                    let _ = std::fs::remove_file(&config_path);
                    return Ok(TrialEnvironmentOutcome::NotStarted {
                        code: ExecutorPreparationCode::Cancelled,
                        artifacts: Vec::new(),
                    });
                }
                status = child.wait() => {
                    let exit_code = status.ok().and_then(|s| s.code());
                    let code = if exit_code == Some(FRAMEWORK_VERSION_MISMATCH_EXIT_CODE) {
                        ExecutorPreparationCode::FrameworkVersionMismatch
                    } else {
                        ExecutorPreparationCode::ExitBeforeReady
                    };
                    let _ = std::fs::remove_file(&config_path);
                    return Ok(TrialEnvironmentOutcome::NotStarted {
                        code,
                        artifacts: vec![preparation_artifact(
                            &self.config.framework,
                            &trial_name,
                            &trial_path,
                            "exit-before-ready",
                            code,
                            exit_code,
                        )],
                    });
                }
                accepted = listener.accept() => accepted,
            };

            let Ok((socket, _)) = accept_res else {
                let _ = terminate_trial(&mut child, TERM_SETTLEMENT_DEADLINE_MS).await;
                let _ = std::fs::remove_file(&config_path);
                return Ok(TrialEnvironmentOutcome::NotStarted {
                    code: ExecutorPreparationCode::ExitBeforeReady,
                    artifacts: Vec::new(),
                });
            };
            drop(listener);

            let mut reader = BufReader::new(socket);
            let mut ready_line = String::new();
            let read_ready = tokio::select! {
                _ = cancel.cancelled() => {
                    let _ = terminate_trial(&mut child, TERM_SETTLEMENT_DEADLINE_MS).await;
                    return Ok(TrialEnvironmentOutcome::NotStarted {
                        code: ExecutorPreparationCode::Cancelled,
                        artifacts: Vec::new(),
                    });
                }
                res = reader.read_line(&mut ready_line) => res,
            };

            let Ok(n) = read_ready else {
                let _ = terminate_trial(&mut child, TERM_SETTLEMENT_DEADLINE_MS).await;
                return Ok(TrialEnvironmentOutcome::NotStarted {
                    code: ExecutorPreparationCode::InvalidReady,
                    artifacts: Vec::new(),
                });
            };
            if n == 0 {
                let status = child.wait().await.ok();
                let exit_code = status.and_then(|s| s.code());
                let code = if exit_code == Some(FRAMEWORK_VERSION_MISMATCH_EXIT_CODE) {
                    ExecutorPreparationCode::FrameworkVersionMismatch
                } else {
                    ExecutorPreparationCode::InvalidReady
                };
                return Ok(TrialEnvironmentOutcome::NotStarted {
                    code,
                    artifacts: vec![preparation_artifact(
                        &self.config.framework,
                        &trial_name,
                        &trial_path,
                        "ready-decode",
                        code,
                        exit_code,
                    )],
                });
            }

            let Ok(ready_json) = serde_json::from_str::<Value>(ready_line.trim()) else {
                let _ = terminate_trial(&mut child, TERM_SETTLEMENT_DEADLINE_MS).await;
                return Ok(TrialEnvironmentOutcome::NotStarted {
                    code: ExecutorPreparationCode::InvalidReady,
                    artifacts: Vec::new(),
                });
            };

            let valid_ready = ready_json.get("token").and_then(Value::as_str) == Some(&relay_token)
                && ready_json.get("kind").and_then(Value::as_str) == Some("ready")
                && ready_json
                    .get("instruction")
                    .and_then(Value::as_str)
                    .is_some()
                && ready_json
                    .get("cwd")
                    .and_then(Value::as_str)
                    .is_some_and(|c| c.starts_with('/'));
            if !valid_ready {
                let _ = terminate_trial(&mut child, TERM_SETTLEMENT_DEADLINE_MS).await;
                return Ok(TrialEnvironmentOutcome::NotStarted {
                    code: ExecutorPreparationCode::InvalidReady,
                    artifacts: vec![preparation_artifact(
                        &self.config.framework,
                        &trial_name,
                        &trial_path,
                        "ready-decode",
                        ExecutorPreparationCode::InvalidReady,
                        None,
                    )],
                });
            }

            let instruction = ready_json["instruction"].as_str().unwrap().to_owned();
            let cwd = ready_json["cwd"].as_str().unwrap().to_owned();
            let result_token = Uuid::new_v4().simple().to_string();

            let mut metadata = Map::new();
            metadata.insert("trialName".into(), Value::String(trial_name.clone()));
            metadata.insert(
                "trialPath".into(),
                Value::String(trial_path.to_string_lossy().into()),
            );
            metadata.insert("meteringSecret".into(), Value::String(result_token.clone()));

            let mut exec_env = HashMap::new();
            exec_env.insert("DEBIAN_FRONTEND".into(), "noninteractive".into());
            exec_env.insert("TZ".into(), "Etc/UTC".into());

            let shared_stream = Arc::new(Mutex::new(reader));
            let last_diagnostic = Arc::new(Mutex::new(None));
            let socket_runner = Arc::new(RelaySocketRunner {
                token: relay_token.clone(),
                result_token,
                credentials,
                execution_environment: exec_env,
                stream: shared_stream.clone(),
                used: AtomicBool::new(false),
                last_diagnostic: last_diagnostic.clone(),
            });

            let subject_context = SubjectExecutionContext {
                cwd,
                task_input: instruction,
                metadata,
                cancel: cancel.clone(),
                runner: socket_runner.clone(),
            };

            let shared_child = Arc::new(Mutex::new(child));
            let decision_sent = Arc::new(AtomicBool::new(false));
            let finalization_confirmed = Arc::new(Mutex::new(None));

            let active = ActiveHarborAttempt {
                cell,
                framework: self.config.framework.clone(),
                egress_required: self.config.egress_proxy_required,
                trial_name,
                trial_path,
                token: relay_token,
                context: subject_context,
                stream: shared_stream,
                child: shared_child.clone(),
                decision_sent: decision_sent.clone(),
                finalization_confirmed: finalization_confirmed.clone(),
            };

            let mut record = operation(&active).await;

            let host_cancelled = cancel.is_cancelled();
            if !decision_sent.load(Ordering::SeqCst)
                || finalization_confirmed.lock().await.is_none()
            {
                let used = socket_runner.used.load(Ordering::SeqCst);
                let mut child_guard = shared_child.lock().await;
                let ok = terminate_trial(
                    &mut child_guard,
                    if used {
                        RELAY_SETTLEMENT_DEADLINE_MS
                    } else {
                        TERM_SETTLEMENT_DEADLINE_MS
                    },
                )
                .await;
                *finalization_confirmed.lock().await = Some(ok);
            }

            if let Some(diag) = last_diagnostic.lock().await.clone()
                && diag.category != SubjectProcessDiagnosticCategory::None
            {
                let mut art = Map::new();
                art.insert("kind".into(), Value::String("executor-relay-result".into()));
                art.insert(
                    "category".into(),
                    Value::String(diag.category.as_str().into()),
                );
                if let Some(b) = diag.bytes {
                    art.insert("bytes".into(), Value::from(b));
                }
                if let Some(s) = diag.sha256 {
                    art.insert("sha256".into(), Value::String(s));
                }
                record.artifacts.push(art);
            }

            if host_cancelled {
                return Ok(TrialEnvironmentOutcome::Indeterminate {
                    cause: IndeterminateCause::HostCancelled,
                    partial: Some(record),
                });
            }

            let finalized_ok = finalization_confirmed.lock().await.unwrap_or(false);
            if !finalized_ok {
                return Ok(TrialEnvironmentOutcome::Indeterminate {
                    cause: IndeterminateCause::CleanupUnconfirmed,
                    partial: Some(record),
                });
            }

            Ok(TrialEnvironmentOutcome::Settled(record))
        })
    }
}

fn preparation_artifact(
    framework: &str,
    trial_name: &str,
    trial_path: &Path,
    stage: &str,
    code: ExecutorPreparationCode,
    exit_code: Option<i32>,
) -> JsonObject {
    let _ = std::fs::create_dir_all(trial_path);
    let diag_name = "preparation-error.json";
    let diag_payload = json!({
        "stage": stage,
        "framework": framework,
        "code": code,
        "errorCode": Value::Null,
        "exitCode": exit_code,
        "signal": Value::Null,
    });
    if let Ok(mut bytes) = serde_json::to_vec(&diag_payload) {
        bytes.push(b'\n');
        let _ = write_atomic_bytes(&trial_path.join(diag_name), &bytes);
    }
    let mut art = Map::new();
    art.insert("kind".into(), Value::String("executor-preparation".into()));
    art.insert("framework".into(), Value::String(framework.into()));
    art.insert("trialName".into(), Value::String(trial_name.into()));
    art.insert("path".into(), Value::String(diag_name.into()));
    art
}
