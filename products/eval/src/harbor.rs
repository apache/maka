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

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};

use maka_agent_facts::accounting::{Activity, Outcome};
use serde_json::{Map, Value, json};
use tokio::process::Command;
use uuid::Uuid;

use crate::guest::{GuestEvidence, GuestRunResult, is_terminal_execution_state};

const HARBOR_AGENT_PLUGIN_PY: &str = include_str!("../harbor/maka_host_agent.py");

#[derive(Debug, Clone, clap::Args)]
pub(crate) struct HarborRunOptions {
    #[arg(long = "task")]
    pub task_path: PathBuf,
    #[arg(long)]
    pub bundle_dir: PathBuf,
    #[arg(long = "out")]
    pub out_dir: PathBuf,
    #[arg(long, default_value = "harbor")]
    pub harbor_bin: String,
    #[arg(long)]
    pub force_build: bool,
    #[arg(long)]
    pub base_url: Option<String>,
    #[arg(long)]
    pub api_key_env: String,
    #[arg(long)]
    pub provider: String,
    #[arg(long = "model")]
    pub model_id: String,
    #[arg(long, value_parser = parse_sandbox_mode, default_value = "danger-full-access")]
    pub sandbox_mode: maka_sandbox::Mode,
    #[arg(long, default_value_t = 64)]
    pub max_steps: u32,
    #[arg(long, default_value_t = 600_000)]
    pub timeout_ms: u64,
}

fn parse_sandbox_mode(raw: &str) -> Result<maka_sandbox::Mode, String> {
    serde_json::from_value(Value::String(raw.to_owned()))
        .map_err(|_| "expected read-only, workspace-write, or danger-full-access".into())
}

pub(crate) struct HarborRunOutcome {
    pub harbor_status: ExitStatus,
    pub reward: Option<f64>,
    pub exception_info: Option<Value>,
    pub guest_result: Option<GuestRunResult>,
    pub guest_result_path: Option<PathBuf>,
    pub transcript_path: Option<PathBuf>,
    pub harbor_result_path: PathBuf,
}

impl HarborRunOutcome {
    pub(crate) fn to_summary_json(&self) -> Value {
        json!({
            "reward": self.reward,
            "exceptionInfo": self.exception_info,
            "guest": self.guest_result.as_ref().map(guest_summary_json),
            "guestResultPath": self.guest_result_path,
            "transcriptPath": self.transcript_path,
            "harborResultPath": self.harbor_result_path,
        })
    }
}

fn guest_summary_json(guest: &GuestRunResult) -> Value {
    let (status, reason_field, evidence): (&str, Option<(&str, &str)>, Option<&GuestEvidence>) =
        match guest {
            GuestRunResult::Completed { evidence } => ("completed", None, Some(evidence.as_ref())),
            GuestRunResult::SubjectStopped {
                stop_reason,
                evidence,
            } => (
                "subjectStopped",
                Some(("stopReason", stop_reason.as_str())),
                Some(evidence.as_ref()),
            ),
            GuestRunResult::InfraFailed {
                infra_error,
                evidence,
            } => (
                "infraFailed",
                Some(("infraError", infra_error.as_str())),
                evidence.as_deref(),
            ),
        };
    let mut map = Map::new();
    map.insert("status".into(), json!(status));
    if let Some((key, value)) = reason_field {
        map.insert(key.into(), json!(value));
    }
    if let Some(ev) = evidence {
        map.insert("stepsObserved".into(), json!(ev.steps_observed));
        map.insert("execution".into(), json!(ev.execution));
        map.insert("usage".into(), json!(ev.host_usage.summary));
    }
    Value::Object(map)
}

pub(crate) async fn run_trial(opts: &HarborRunOptions) -> Result<HarborRunOutcome, String> {
    if opts.timeout_ms == 0 || opts.max_steps == 0 {
        return Err("maxSteps and timeoutMs must be > 0".into());
    }
    let task_path = std::fs::canonicalize(&opts.task_path).map_err(|e| {
        format!(
            "failed to resolve task path {}: {e}",
            opts.task_path.display()
        )
    })?;
    let bundle_dir = std::fs::canonicalize(&opts.bundle_dir).map_err(|e| {
        format!(
            "failed to resolve bundle dir {}: {e}",
            opts.bundle_dir.display()
        )
    })?;
    for required in ["maka", "maka-python-worker", "maka-eval"] {
        let bin = bundle_dir.join(required);
        if !bin.is_file() {
            return Err(format!("bundle missing required binary: {}", bin.display()));
        }
    }

    let api_key = std::env::var(&opts.api_key_env).unwrap_or_default();
    if api_key.trim().is_empty() {
        return Err(format!(
            "API key environment variable '{}' is unset or empty",
            opts.api_key_env
        ));
    }

    std::fs::create_dir_all(&opts.out_dir)
        .map_err(|e| format!("failed to create out dir {}: {e}", opts.out_dir.display()))?;
    let out_dir = std::fs::canonicalize(&opts.out_dir)
        .map_err(|e| format!("failed to canonicalize out dir: {e}"))?;

    let jobs_dir = out_dir.join("harbor-jobs");
    let job_name = format!("run-{}", Uuid::new_v4());
    let config_path = out_dir.join("harbor-job-config.json");
    let harbor_plugin_dir = materialize_harbor_plugin(&out_dir)?;
    let config = json!({
        "job_name": job_name,
        "jobs_dir": jobs_dir,
        "n_attempts": 1,
        "timeout_multiplier": 1.0,
        "agent_setup_timeout_multiplier": 3.0,
        "n_concurrent_trials": 1,
        "retry": {
            "max_retries": 0
        },
        "environment": {
            "type": "docker",
            "force_build": opts.force_build,
            "delete": true,
            "mounts": [
                {
                    "type": "bind",
                    "source": bundle_dir,
                    "target": "/opt/maka-agent",
                    "read_only": true
                }
            ]
        },
        "agents": [
            {
                "import_path": "maka_host_agent:MakaHostAgent",
                "model_name": format!("{}/{}", opts.provider, opts.model_id),
                "skip_model_parsing": true,
                // Give guest-run 30s after its internal timeout_ms deadline to stop and flush artifacts.
                "override_timeout_sec": (opts.timeout_ms as f64 / 1000.0) + 30.0,
                "kwargs": {
                    "endpoint_url": opts.base_url,
                    "api_key_env": opts.api_key_env,
                    "provider": opts.provider,
                    "model_id": opts.model_id,
                    "sandbox_mode": opts.sandbox_mode,
                    "max_steps": opts.max_steps,
                    "timeout_ms": opts.timeout_ms
                }
            }
        ],
        "tasks": [
            {
                "path": task_path
            }
        ]
    });

    let encoded = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("failed to serialize harbor config: {e}"))?;
    std::fs::write(&config_path, format!("{encoded}\n"))
        .map_err(|e| format!("failed to write {}: {e}", config_path.display()))?;

    let pythonpath = prepend_search_path(
        &harbor_plugin_dir,
        std::env::var_os("PYTHONPATH").as_deref(),
    )?;

    let status = Command::new(&opts.harbor_bin)
        .args(["run", "-c"])
        .arg(&config_path)
        .env("PYTHONPATH", pythonpath)
        .env_remove("all_proxy")
        .env_remove("ALL_PROXY")
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .await
        .map_err(|e| format!("failed to spawn '{}': {e}", opts.harbor_bin))?;

    let job_dir = jobs_dir.join(&job_name);
    let trial_result_path = find_trial_result_json(&job_dir)?.ok_or_else(|| {
        format!(
            "harbor exited ({status}) without producing a trial result.json under {}",
            job_dir.display()
        )
    })?;

    let raw_trial = std::fs::read_to_string(&trial_result_path)
        .map_err(|e| format!("failed to read {}: {e}", trial_result_path.display()))?;
    let trial_json: Value = serde_json::from_str(&raw_trial).map_err(|e| {
        format!(
            "invalid trial result.json {}: {e}",
            trial_result_path.display()
        )
    })?;

    let reward = trial_json["verifier_result"]["rewards"]["reward"].as_f64();
    let exception_info = trial_json
        .get("exception_info")
        .filter(|v| !v.is_null())
        .cloned();

    let trial_dir = trial_result_path
        .parent()
        .ok_or("trial result.json has no parent directory")?;
    let maka_dir = trial_dir.join("agent").join("maka");
    let guest_result_candidate = maka_dir.join("guest-result.json");
    let (guest_result, guest_result_path) = if guest_result_candidate.is_file() {
        let raw_guest = std::fs::read_to_string(&guest_result_candidate)
            .map_err(|e| format!("failed to read {}: {e}", guest_result_candidate.display()))?;
        let parsed = serde_json::from_str::<GuestRunResult>(&raw_guest).map_err(|e| {
            format!(
                "invalid guest-result.json {}: {e}",
                guest_result_candidate.display()
            )
        })?;
        (Some(parsed), Some(guest_result_candidate))
    } else {
        (None, None)
    };

    let transcript_candidate = maka_dir.join("transcript.json");
    let transcript_path = transcript_candidate
        .is_file()
        .then_some(transcript_candidate);

    Ok(HarborRunOutcome {
        harbor_status: status,
        reward,
        exception_info,
        guest_result,
        guest_result_path,
        transcript_path,
        harbor_result_path: trial_result_path,
    })
}

fn check_harbor_outcome(outcome: &HarborRunOutcome) -> Result<(), String> {
    if let Some(exc) = &outcome.exception_info {
        return Err(format!("harbor trial recorded exception: {exc}"));
    }
    if !outcome.harbor_status.success() {
        return Err(format!(
            "harbor run failed ({}) without recording exception_info",
            outcome.harbor_status
        ));
    }
    if !outcome.reward.is_some_and(f64::is_finite) {
        return Err(format!(
            "verifier did not produce a finite numeric reward: {:?}",
            outcome.reward
        ));
    }
    Ok(())
}

pub(crate) fn validate_trial_evidence(outcome: &HarborRunOutcome) -> Result<(), String> {
    let (is_completed, evidence) = match &outcome.guest_result {
        Some(GuestRunResult::InfraFailed { infra_error, .. }) => {
            return Err(format!("guest infrastructure failed: {infra_error}"));
        }
        Some(GuestRunResult::Completed { evidence }) => {
            check_harbor_outcome(outcome)?;
            (true, evidence.as_ref())
        }
        Some(GuestRunResult::SubjectStopped { evidence, .. }) => {
            check_harbor_outcome(outcome)?;
            (false, evidence.as_ref())
        }
        None => {
            check_harbor_outcome(outcome)?;
            return Err("missing guest-result.json from trial artifacts".into());
        }
    };

    if !is_terminal_execution_state(&evidence.execution.state) {
        let encoded = serde_json::to_string(&evidence.execution.state).unwrap_or_default();
        return Err(format!(
            "guest execution receipt missing terminal state: {encoded}"
        ));
    }
    if !outcome
        .transcript_path
        .as_ref()
        .is_some_and(|p| p.is_file())
    {
        return Err(format!(
            "missing exported transcript.json artifact: {:?}",
            outcome.transcript_path
        ));
    }

    let summary = &evidence.host_usage.summary;
    let attempts = &evidence.host_usage_attempts;
    if attempts.next_cursor.is_some()
        || attempts.total != summary.models.calls
        || u64::try_from(attempts.attempts.len()).ok() != Some(summary.models.calls)
    {
        return Err(format!(
            "inconsistent host usage attempts page: summary_calls={}, page_total={}, page_len={}, has_next={}",
            summary.models.calls,
            attempts.total,
            attempts.attempts.len(),
            attempts.next_cursor.is_some(),
        ));
    }

    let mut successful_calls = 0u64;
    let mut input_missing = 0u64;
    let mut output_missing = 0u64;
    for item in &attempts.attempts {
        let Activity::Model(attempt) = item else {
            return Err("unexpected non-model activity in hostUsageAttempts".into());
        };
        if attempt.outcome == Outcome::Success {
            successful_calls += 1;
            if attempt.usage.input_tokens.is_none() {
                input_missing += 1;
            }
            if attempt.usage.output_tokens.is_none() {
                output_missing += 1;
            }
        }
    }

    if is_completed {
        if summary.pending.models != 0 || summary.pending.tools != 0 {
            return Err(format!(
                "incomplete host usage accounting: pending_models={}, pending_tools={}",
                summary.pending.models, summary.pending.tools
            ));
        }
        if successful_calls == 0 {
            return Err(
                "incomplete host usage accounting: completed run recorded 0 successful model calls"
                    .into(),
            );
        }
    }

    if input_missing != 0 || output_missing != 0 {
        return Err(format!(
            "incomplete token usage on successful model call(s) ({successful_calls} total): input_missing={input_missing}, output_missing={output_missing}"
        ));
    }
    Ok(())
}

fn materialize_harbor_plugin(out_dir: &Path) -> Result<PathBuf, String> {
    let plugin_dir = out_dir.join("harbor-plugin");
    std::fs::create_dir_all(&plugin_dir)
        .map_err(|e| format!("failed to create {}: {e}", plugin_dir.display()))?;
    let plugin_file = plugin_dir.join("maka_host_agent.py");
    std::fs::write(&plugin_file, HARBOR_AGENT_PLUGIN_PY)
        .map_err(|e| format!("failed to write {}: {e}", plugin_file.display()))?;
    Ok(plugin_dir)
}

pub(crate) fn prepend_search_path(
    first: &Path,
    existing: Option<&OsStr>,
) -> Result<OsString, String> {
    let mut paths = vec![first.to_path_buf()];
    if let Some(existing) = existing
        && !existing.is_empty()
    {
        paths.extend(std::env::split_paths(existing));
    }
    std::env::join_paths(paths).map_err(|e| format!("failed joining search path: {e}"))
}

fn find_trial_result_json(job_dir: &Path) -> Result<Option<PathBuf>, String> {
    if !job_dir.is_dir() {
        return Ok(None);
    }
    for entry in std::fs::read_dir(job_dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.is_dir() {
            let candidate = path.join("result.json");
            if candidate.is_file() {
                return Ok(Some(candidate));
            }
        }
    }
    Ok(None)
}
