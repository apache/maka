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

use std::collections::BTreeSet;
use std::ffi::{OsStr, OsString};
use std::num::{NonZeroU32, NonZeroU64};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};

use maka_agent_facts::accounting::{Activity, Outcome};
use maka_agent_facts::execution::ThinkingLevel;
use maka_settings_native::usage::{Page as UsagePage, Report as UsageReport};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::guest::{GuestEvidence, GuestRunResult, is_terminal_execution_state};

const HARBOR_AGENT_PLUGIN_PY: &str = include_str!("../harbor/maka_host_agent.py");
const TEARDOWN_GRACE_SEC: f64 = 30.0;

#[derive(Debug, Clone)]
pub(crate) struct VerifierEnvRef {
    pub target: String,
    pub host_var: String,
}

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
    #[arg(long, value_parser = parse_thinking_level)]
    pub thinking_level: Option<ThinkingLevel>,
    #[arg(long, value_parser = parse_sandbox_mode, default_value = "danger-full-access")]
    pub sandbox_mode: maka_sandbox::Mode,
    #[arg(long)]
    pub max_steps: Option<NonZeroU32>,
    #[arg(long)]
    pub timeout_ms: Option<NonZeroU64>,
    #[arg(long = "verifier-env", value_name = "KEY[=${HOST_VAR}]", value_parser = parse_verifier_env)]
    pub verifier_env: Vec<VerifierEnvRef>,
}

fn parse_thinking_level(raw: &str) -> Result<ThinkingLevel, String> {
    serde_json::from_value(Value::String(raw.to_owned()))
        .map_err(|_| "expected off, minimal, low, medium, high, xhigh, max, or ultra".into())
}

fn parse_sandbox_mode(raw: &str) -> Result<maka_sandbox::Mode, String> {
    serde_json::from_value(Value::String(raw.to_owned()))
        .map_err(|_| "expected read-only, workspace-write, or danger-full-access".into())
}

fn is_valid_env_var_name(key: &str) -> bool {
    !key.is_empty()
        && (key.as_bytes()[0].is_ascii_alphabetic() || key.as_bytes()[0] == b'_')
        && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn parse_verifier_env(raw: &str) -> Result<VerifierEnvRef, String> {
    if let Some((target, expr)) = raw.split_once('=') {
        if !is_valid_env_var_name(target) {
            return Err(format!("invalid --verifier-env key '{target}'"));
        }
        let host_var = expr
            .strip_prefix("${")
            .and_then(|s| s.strip_suffix('}'))
            .filter(|v| is_valid_env_var_name(v))
            .ok_or_else(|| {
                format!(
                    "invalid --verifier-env '{raw}': only host env references KEY or KEY=${{HOST_VAR}} are allowed so values are never persisted to Harbor artifacts"
                )
            })?;
        return Ok(VerifierEnvRef {
            target: target.to_owned(),
            host_var: host_var.to_owned(),
        });
    }
    if !is_valid_env_var_name(raw) {
        return Err(format!(
            "invalid --verifier-env key '{raw}': expected KEY or KEY=${{HOST_VAR}}"
        ));
    }
    Ok(VerifierEnvRef {
        target: raw.to_owned(),
        host_var: raw.to_owned(),
    })
}

#[derive(Deserialize)]
struct TaskToml {
    agent: Option<TaskAgentToml>,
}

#[derive(Deserialize)]
struct TaskAgentToml {
    timeout_sec: Option<f64>,
}

fn read_task_timeout_ms(task_toml: &Path) -> Result<Option<NonZeroU64>, String> {
    let raw = std::fs::read_to_string(task_toml)
        .map_err(|e| format!("failed to read {}: {e}", task_toml.display()))?;
    let parsed: TaskToml =
        toml::from_str(&raw).map_err(|e| format!("invalid {}: {e}", task_toml.display()))?;
    let Some(secs) = parsed.agent.and_then(|agent| agent.timeout_sec) else {
        return Ok(None);
    };
    if !secs.is_finite() || secs <= 0.0 {
        return Err(format!(
            "invalid [agent].timeout_sec in {}: must be finite and > 0",
            task_toml.display()
        ));
    }
    let ms = (secs * 1000.0).ceil().max(1.0);
    if !ms.is_finite() || ms >= u64::MAX as f64 {
        return Err(format!(
            "invalid [agent].timeout_sec in {}: overflows u64 ms",
            task_toml.display()
        ));
    }
    Ok(NonZeroU64::new(ms as u64))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum UsageSettlement {
    Complete {
        #[serde(
            default,
            deserialize_with = "deserialize_json_field",
            skip_serializing_if = "Option::is_none"
        )]
        cost_usd: Option<f64>,
    },
    LowerBound,
}

// Workspace feature unification enables serde_json/arbitrary_precision, which
// routes fields inside #[serde(tag = "...")] enums through an internal Content
// buffer; decoding via Value preserves nested f64 fields.
pub(crate) fn deserialize_json_field<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: DeserializeOwned,
{
    let value = Value::deserialize(deserializer)?;
    serde_json::from_value(value).map_err(serde::de::Error::custom)
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
    pub(crate) fn settle(&self) -> (Value, Result<(), String>) {
        let (guest_json, validation) = match &self.guest_result {
            None => (
                Value::Null,
                check_harbor_outcome(self)
                    .and(Err("missing guest-result.json from trial artifacts".into())),
            ),
            Some(GuestRunResult::InfraFailed {
                infra_error,
                evidence,
            }) => (
                build_guest_json(
                    "infraFailed",
                    Some(("infraError", infra_error)),
                    evidence.as_deref(),
                    None,
                ),
                Err(format!("guest infrastructure failed: {infra_error}")),
            ),
            Some(GuestRunResult::Completed {
                evidence,
                settlement,
            }) => self.settle_evidenced("completed", None, evidence, settlement),
            Some(GuestRunResult::SubjectStopped {
                stop_reason,
                evidence,
                settlement,
            }) => self.settle_evidenced(
                "subjectStopped",
                Some(("stopReason", stop_reason)),
                evidence,
                settlement,
            ),
        };

        let summary = json!({
            "reward": self.reward,
            "exceptionInfo": self.exception_info,
            "guest": guest_json,
            "guestResultPath": self.guest_result_path,
            "transcriptPath": self.transcript_path,
            "harborResultPath": self.harbor_result_path,
        });
        (summary, validation)
    }

    fn settle_evidenced(
        &self,
        status: &str,
        reason_field: Option<(&str, &str)>,
        evidence: &GuestEvidence,
        settlement: &UsageSettlement,
    ) -> (Value, Result<(), String>) {
        let guest_json = build_guest_json(status, reason_field, Some(evidence), Some(settlement));
        let validation = self.validate_evidenced(evidence);
        (guest_json, validation)
    }

    fn validate_evidenced(&self, evidence: &GuestEvidence) -> Result<(), String> {
        check_harbor_outcome(self)?;
        if !is_terminal_execution_state(&evidence.execution.state) {
            let encoded = serde_json::to_string(&evidence.execution.state).unwrap_or_default();
            return Err(format!(
                "guest execution receipt missing terminal state: {encoded}"
            ));
        }
        if !self.transcript_path.as_ref().is_some_and(|p| p.is_file()) {
            return Err(format!(
                "missing exported transcript.json artifact: {:?}",
                self.transcript_path
            ));
        }
        Ok(())
    }
}

fn build_guest_json(
    status: &str,
    reason_field: Option<(&str, &str)>,
    evidence: Option<&GuestEvidence>,
    settlement: Option<&UsageSettlement>,
) -> Value {
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
    match settlement {
        Some(UsageSettlement::Complete { cost_usd }) => {
            map.insert("costUsd".into(), json!(cost_usd));
            map.insert("metering".into(), json!("complete"));
        }
        Some(UsageSettlement::LowerBound) => {
            map.insert("costUsd".into(), Value::Null);
            map.insert("metering".into(), json!("lower_bound"));
        }
        None => {}
    }
    Value::Object(map)
}

pub(crate) fn run_trial(opts: &HarborRunOptions) -> Result<HarborRunOutcome, String> {
    let mut verifier_env_keys = BTreeSet::<&str>::new();
    for entry in &opts.verifier_env {
        if !verifier_env_keys.insert(entry.target.as_str()) {
            return Err(format!("duplicate --verifier-env key '{}'", entry.target));
        }
        if std::env::var_os(&entry.host_var).is_none() {
            return Err(format!(
                "--verifier-env host variable '{}' is not set",
                entry.host_var
            ));
        }
    }

    let task_path = std::fs::canonicalize(&opts.task_path).map_err(|e| {
        format!(
            "failed to resolve task path {}: {e}",
            opts.task_path.display()
        )
    })?;
    let task_toml = task_path.join("task.toml");
    if !task_toml.is_file() {
        return Err(format!(
            "task directory missing task.toml: {}",
            task_path.display()
        ));
    }
    let effective_timeout_ms = match opts.timeout_ms {
        Some(ms) => Some(ms),
        None => read_task_timeout_ms(&task_toml)?,
    };

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
    let mut agent_cfg = json!({
        "import_path": "maka_host_agent:MakaHostAgent",
        "model_name": format!("{}/{}", opts.provider, opts.model_id),
        "skip_model_parsing": true,
        "kwargs": {
            "endpoint_url": opts.base_url,
            "api_key_env": opts.api_key_env,
            "provider": opts.provider,
            "model_id": opts.model_id,
            "thinking_level": opts.thinking_level,
            "sandbox_mode": opts.sandbox_mode,
            "max_steps": opts.max_steps.map(NonZeroU32::get),
            "timeout_ms": effective_timeout_ms.map(NonZeroU64::get),
        }
    });
    if let Some(timeout_ms) = effective_timeout_ms {
        // Give guest-run extra teardown margin after its internal timeout_ms deadline to flush artifacts.
        agent_cfg["override_timeout_sec"] =
            json!((timeout_ms.get() as f64 / 1000.0) + TEARDOWN_GRACE_SEC);
    }

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
        "override_error_policy": {
            "MakaInfraError": {
                "should_retry": false,
                "should_grade": false,
                "has_valid_reward": false
            },
            "AgentTimeoutError": {
                "should_retry": false,
                "should_grade": false,
                "has_valid_reward": false
            }
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
        "agents": [agent_cfg],
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

    let mut harbor_cmd = Command::new(&opts.harbor_bin);
    harbor_cmd
        .args(["run", "-c"])
        .arg(&config_path)
        .env("PYTHONPATH", pythonpath)
        .env_remove("all_proxy")
        .env_remove("ALL_PROXY")
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    for entry in &opts.verifier_env {
        harbor_cmd.args([
            "--verifier-env",
            &format!("{}=${{{}}}", entry.target, entry.host_var),
        ]);
    }
    let status = harbor_cmd
        .status()
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
    let (guest_result, guest_result_path) = match std::fs::read_to_string(&guest_result_candidate) {
        Ok(raw_guest) => (
            Some(
                serde_json::from_str::<GuestRunResult>(&raw_guest).unwrap_or_else(|e| {
                    GuestRunResult::infra_error(format!(
                        "invalid guest-result.json {}: {e}",
                        guest_result_candidate.display()
                    ))
                }),
            ),
            Some(guest_result_candidate),
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (None, None),
        Err(e) => (
            Some(GuestRunResult::infra_error(format!(
                "failed to read {}: {e}",
                guest_result_candidate.display()
            ))),
            Some(guest_result_candidate),
        ),
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

pub(crate) fn settle_usage(
    usage: &UsageReport,
    attempts: &UsagePage,
    is_completed: bool,
) -> Result<UsageSettlement, String> {
    let models = &usage.summary.models;
    let pending = &usage.summary.pending;
    if attempts.through != usage.through
        || attempts.next_cursor.is_some()
        || attempts.total != models.calls
        || u64::try_from(attempts.attempts.len()).ok() != Some(models.calls)
    {
        return Err(format!(
            "inconsistent host usage attempts page: same_fence={}, summary_calls={}, page_total={}, page_len={}, has_next={}",
            attempts.through == usage.through,
            models.calls,
            attempts.total,
            attempts.attempts.len(),
            attempts.next_cursor.is_some(),
        ));
    }

    let mut successful_calls = 0u64;
    let mut input_missing = 0u64;
    let mut output_missing = 0u64;
    let mut lower_bound = pending.models > 0 || models.aborted > 0 || models.unknown > 0;

    for item in &attempts.attempts {
        let Activity::Model(attempt) = item else {
            return Err("unexpected non-model activity in hostUsageAttempts".into());
        };
        let u = &attempt.usage;
        if attempt.outcome == Outcome::Success {
            successful_calls += 1;
            if u.input_tokens.is_none() {
                input_missing += 1;
            }
            if u.output_tokens.is_none() {
                output_missing += 1;
            }
        }
        if attempt.cost_usd.is_none()
            && (u.input_tokens.is_none()
                || u.output_tokens.is_none()
                || attempt.quote.as_ref().is_some_and(|q| q.pricing.is_some()))
        {
            lower_bound = true;
        }
    }

    if is_completed {
        if pending.models != 0 || pending.tools != 0 {
            return Err(format!(
                "incomplete host usage accounting: pending_models={}, pending_tools={}",
                pending.models, pending.tools
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

    if lower_bound {
        Ok(UsageSettlement::LowerBound)
    } else {
        Ok(UsageSettlement::Complete {
            cost_usd: (models.cost.unvalued == 0).then_some(models.cost.known_usd),
        })
    }
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
