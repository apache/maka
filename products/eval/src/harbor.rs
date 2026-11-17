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

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::num::{NonZeroU32, NonZeroU64};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};

use maka_agent_facts::accounting::{Activity, Outcome, Pending};
use maka_settings_native::usage::Page as UsagePage;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
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
    #[arg(long, default_value = "64")]
    pub max_steps: NonZeroU32,
    #[arg(long, default_value = "600000")]
    pub timeout_ms: NonZeroU64,
    #[arg(long = "verifier-env", value_name = "KEY=VALUE", value_parser = parse_env_pair)]
    pub verifier_env: Vec<(String, String)>,
}

fn parse_sandbox_mode(raw: &str) -> Result<maka_sandbox::Mode, String> {
    serde_json::from_value(Value::String(raw.to_owned()))
        .map_err(|_| "expected read-only, workspace-write, or danger-full-access".into())
}

fn parse_env_pair(raw: &str) -> Result<(String, String), String> {
    let Some((key, value)) = raw.split_once('=') else {
        return Err("expected KEY=VALUE".into());
    };
    if key.is_empty() || key.contains('\0') {
        return Err("environment variable name cannot be empty".into());
    }
    Ok((key.to_owned(), value.to_owned()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum EvalStatus {
    Completed,
    SubjectFailed,
    InfraFailed,
    Indeterminate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Metering {
    Complete,
    LowerBound,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum UsageSettlement {
    Complete { cost_usd: Option<f64> },
    LowerBound,
}

impl UsageSettlement {
    pub(crate) fn into_parts(self) -> (Metering, Option<f64>) {
        match self {
            Self::Complete { cost_usd } => (Metering::Complete, cost_usd),
            Self::LowerBound => (Metering::LowerBound, None),
        }
    }
}

pub(crate) enum TrialOutcome {
    Completed {
        score: f64,
        settlement: UsageSettlement,
    },
    SubjectFailed {
        score: f64,
        settlement: UsageSettlement,
        reason: String,
    },
    InfraFailed {
        reason: String,
    },
    Indeterminate {
        reason: String,
    },
}

impl TrialOutcome {
    pub(crate) fn into_validation(self) -> Result<(), String> {
        match self {
            Self::Completed { .. } | Self::SubjectFailed { .. } => Ok(()),
            Self::InfraFailed { reason } | Self::Indeterminate { reason } => Err(reason),
        }
    }
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
    pub(crate) fn settle(&self) -> (Value, TrialOutcome) {
        match &self.guest_result {
            None => {
                let reason = self
                    .check_harbor_outcome()
                    .err()
                    .unwrap_or_else(|| "missing guest-result.json from trial artifacts".into());
                // Harbor's default ErrorPolicy marks AgentTimeoutError as gradeable even though
                // the hung guest never settled usage or confirmed cleanup; block auto-retry.
                let is_agent_timeout = self
                    .exception_info
                    .as_ref()
                    .and_then(|v| v.get("exception_type"))
                    .and_then(Value::as_str)
                    == Some("AgentTimeoutError");
                let outcome = if is_agent_timeout {
                    TrialOutcome::Indeterminate { reason }
                } else {
                    TrialOutcome::InfraFailed { reason }
                };
                (self.summary_json(Value::Null), outcome)
            }
            Some(GuestRunResult::InfraFailed {
                infra_error,
                evidence,
            }) => {
                let evidenced = evidence.as_deref().map(|ev| {
                    let s = &ev.host_usage.summary;
                    let settlement =
                        settle_usage(s.models.calls, &s.pending, &ev.host_usage_attempts, false);
                    (ev, settlement)
                });
                let guest_json = build_guest_json(
                    "infraFailed",
                    Some(("infraError", infra_error.as_str())),
                    evidenced.as_ref().map(|(ev, s)| (*ev, s)),
                );
                (
                    self.summary_json(guest_json),
                    TrialOutcome::InfraFailed {
                        reason: format!("guest infrastructure failed: {infra_error}"),
                    },
                )
            }
            Some(GuestRunResult::Completed { evidence }) => {
                self.settle_evidenced("completed", None, evidence)
            }
            Some(GuestRunResult::SubjectStopped {
                stop_reason,
                evidence,
            }) => self.settle_evidenced(
                "subjectStopped",
                Some(("stopReason", stop_reason.as_str())),
                evidence,
            ),
        }
    }

    fn settle_evidenced(
        &self,
        status_label: &str,
        reason: Option<(&str, &str)>,
        evidence: &GuestEvidence,
    ) -> (Value, TrialOutcome) {
        let is_completed = reason.is_none();
        let s = &evidence.host_usage.summary;
        let settlement = settle_usage(
            s.models.calls,
            &s.pending,
            &evidence.host_usage_attempts,
            is_completed,
        );
        let guest_json = build_guest_json(status_label, reason, Some((evidence, &settlement)));
        let summary = self.summary_json(guest_json);

        let score = match self.check_harbor_outcome() {
            Ok(score) => score,
            Err(harbor_err) => return (summary, TrialOutcome::InfraFailed { reason: harbor_err }),
        };

        let check = (|| {
            if !is_terminal_execution_state(&evidence.execution.state) {
                let encoded = serde_json::to_string(&evidence.execution.state).unwrap_or_default();
                return Err(format!(
                    "guest execution receipt missing terminal state: {encoded}"
                ));
            }
            if !self.transcript_path.as_deref().is_some_and(Path::is_file) {
                return Err(format!(
                    "missing exported transcript.json artifact: {:?}",
                    self.transcript_path
                ));
            }
            settlement
        })();

        let outcome = match check {
            Err(inv_err) => TrialOutcome::Indeterminate { reason: inv_err },
            Ok(settled) => match reason {
                None => TrialOutcome::Completed {
                    score,
                    settlement: settled,
                },
                Some((_, stop_reason)) => TrialOutcome::SubjectFailed {
                    score,
                    settlement: settled,
                    reason: stop_reason.to_owned(),
                },
            },
        };
        (summary, outcome)
    }

    fn summary_json(&self, guest_json: Value) -> Value {
        json!({
            "reward": self.reward,
            "exceptionInfo": self.exception_info,
            "guest": guest_json,
            "guestResultPath": self.guest_result_path,
            "transcriptPath": self.transcript_path,
            "harborResultPath": self.harbor_result_path,
        })
    }

    fn check_harbor_outcome(&self) -> Result<f64, String> {
        if let Some(exc) = &self.exception_info {
            return Err(format!("harbor trial recorded exception: {exc}"));
        }
        if !self.harbor_status.success() {
            return Err(format!(
                "harbor run failed ({}) without recording exception_info",
                self.harbor_status
            ));
        }
        self.reward.filter(|r| r.is_finite()).ok_or_else(|| {
            format!(
                "verifier did not produce a finite numeric reward: {:?}",
                self.reward
            )
        })
    }
}

fn build_guest_json(
    status: &str,
    reason_field: Option<(&str, &str)>,
    evidenced: Option<(&GuestEvidence, &Result<UsageSettlement, String>)>,
) -> Value {
    let mut map = Map::new();
    map.insert("status".into(), json!(status));
    if let Some((key, value)) = reason_field {
        map.insert(key.into(), json!(value));
    }
    if let Some((ev, settlement)) = evidenced {
        map.insert("stepsObserved".into(), json!(ev.steps_observed));
        map.insert("execution".into(), json!(ev.execution));
        map.insert("usage".into(), json!(ev.host_usage.summary));
        match settlement {
            Ok(UsageSettlement::Complete { cost_usd }) => {
                map.insert("costUsd".into(), json!(cost_usd));
                map.insert("metering".into(), json!("complete"));
            }
            Ok(UsageSettlement::LowerBound) => {
                map.insert("costUsd".into(), Value::Null);
                map.insert("metering".into(), json!("lower_bound"));
            }
            Err(err) => {
                map.insert("meteringError".into(), json!(err));
            }
        }
    }
    Value::Object(map)
}

pub(crate) struct TrialSpec<'a> {
    pub task_path: &'a Path,
    pub bundle_dir: &'a Path,
    pub out_dir: &'a Path,
    pub harbor_bin: &'a str,
    pub force_build: bool,
    pub base_url: Option<&'a str>,
    pub api_key_env: &'a str,
    pub provider: &'a str,
    pub model_id: &'a str,
    pub sandbox_mode: maka_sandbox::Mode,
    pub max_steps: NonZeroU32,
    pub timeout_ms: NonZeroU64,
    pub verifier_env: &'a BTreeMap<String, String>,
}

pub(crate) fn run_single(opts: HarborRunOptions) -> Result<(), String> {
    validate_harbor_bin(&opts.harbor_bin)?;
    let mut verifier_env = BTreeMap::new();
    for (k, v) in opts.verifier_env {
        if verifier_env.insert(k.clone(), v).is_some() {
            return Err(format!("duplicate --verifier-env key '{k}'"));
        }
    }
    validate_verifier_env_map(&verifier_env)?;
    validate_subject_target(
        None,
        &opts.provider,
        &opts.model_id,
        &opts.api_key_env,
        opts.base_url.as_deref(),
    )?;
    let task_path = resolve_task_dir(&opts.task_path)?;
    let bundle_dir = resolve_bundle_dir(&opts.bundle_dir)?;
    std::fs::create_dir_all(&opts.out_dir)
        .map_err(|e| format!("failed to create out dir {}: {e}", opts.out_dir.display()))?;
    let out_dir = std::fs::canonicalize(&opts.out_dir)
        .map_err(|e| format!("failed to canonicalize out dir: {e}"))?;

    let spec = TrialSpec {
        task_path: &task_path,
        bundle_dir: &bundle_dir,
        out_dir: &out_dir,
        harbor_bin: &opts.harbor_bin,
        force_build: opts.force_build,
        base_url: opts.base_url.as_deref(),
        api_key_env: &opts.api_key_env,
        provider: &opts.provider,
        model_id: &opts.model_id,
        sandbox_mode: opts.sandbox_mode,
        max_steps: opts.max_steps,
        timeout_ms: opts.timeout_ms,
        verifier_env: &verifier_env,
    };
    let (summary, outcome) = run_prepared_trial(&spec)?.settle();
    let (_, encoded) = write_run_summary(&out_dir, &summary)?;
    println!("{encoded}");
    outcome.into_validation()
}

pub(crate) fn resolve_bundle_dir(path: &Path) -> Result<PathBuf, String> {
    let resolved = std::fs::canonicalize(path)
        .map_err(|e| format!("failed to resolve bundle dir {}: {e}", path.display()))?;
    for required in ["maka", "maka-python-worker", "maka-eval"] {
        let bin = resolved.join(required);
        if !bin.is_file() {
            return Err(format!("bundle missing required binary: {}", bin.display()));
        }
    }
    Ok(resolved)
}

pub(crate) fn resolve_task_dir(path: &Path) -> Result<PathBuf, String> {
    let resolved = std::fs::canonicalize(path)
        .map_err(|e| format!("failed to resolve task path {}: {e}", path.display()))?;
    if !resolved.join("task.toml").is_file() {
        return Err(format!(
            "task directory missing task.toml: {}",
            resolved.display()
        ));
    }
    Ok(resolved)
}

pub(crate) fn validate_harbor_bin(harbor_bin: &str) -> Result<(), String> {
    if harbor_bin.trim().is_empty() {
        return Err("harborBin cannot be empty".into());
    }
    Ok(())
}

pub(crate) fn validate_verifier_env_map(map: &BTreeMap<String, String>) -> Result<(), String> {
    for k in map.keys() {
        if k.is_empty() || k.contains('=') || k.contains('\0') {
            return Err(format!("invalid verifierEnv key '{k}'"));
        }
    }
    Ok(())
}

pub(crate) fn validate_subject_target(
    scope: Option<&str>,
    provider: &str,
    model_id: &str,
    api_key_env: &str,
    base_url: Option<&str>,
) -> Result<(), String> {
    let prefix = scope.map_or_else(String::new, |s| format!("subject '{s}': "));
    if provider.trim().is_empty() {
        return Err(format!("{prefix}provider cannot be empty"));
    }
    if model_id.trim().is_empty() {
        return Err(format!("{prefix}modelId cannot be empty"));
    }
    if api_key_env.trim().is_empty() {
        return Err(format!("{prefix}apiKeyEnv cannot be empty"));
    }
    if base_url.is_some_and(|url| url.trim().is_empty()) {
        return Err(format!("{prefix}baseUrl cannot be empty or whitespace"));
    }
    let val = std::env::var(api_key_env).unwrap_or_default();
    if val.trim().is_empty() {
        return Err(format!(
            "{prefix}API key environment variable '{api_key_env}' is unset or empty"
        ));
    }
    Ok(())
}

pub(crate) fn run_prepared_trial(spec: &TrialSpec<'_>) -> Result<HarborRunOutcome, String> {
    std::fs::create_dir_all(spec.out_dir)
        .map_err(|e| format!("failed to create out dir {}: {e}", spec.out_dir.display()))?;
    let out_dir = std::fs::canonicalize(spec.out_dir)
        .map_err(|e| format!("failed to canonicalize out dir: {e}"))?;

    let jobs_dir = out_dir.join("harbor-jobs");
    let job_name = format!("run-{}", Uuid::new_v4());
    let config_path = out_dir.join("harbor-job-config.json");
    let harbor_plugin_dir = materialize_harbor_plugin(&out_dir)?;
    let mut config = json!({
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
            "force_build": spec.force_build,
            "delete": true,
            "mounts": [
                {
                    "type": "bind",
                    "source": spec.bundle_dir,
                    "target": "/opt/maka-agent",
                    "read_only": true
                }
            ]
        },
        "agents": [
            {
                "import_path": "maka_host_agent:MakaHostAgent",
                "model_name": format!("{}/{}", spec.provider, spec.model_id),
                "skip_model_parsing": true,
                // Give guest-run 30s after its internal timeout_ms deadline to stop and flush artifacts.
                "override_timeout_sec": (spec.timeout_ms.get() as f64 / 1000.0) + 30.0,
                "kwargs": {
                    "endpoint_url": spec.base_url,
                    "api_key_env": spec.api_key_env,
                    "provider": spec.provider,
                    "model_id": spec.model_id,
                    "sandbox_mode": spec.sandbox_mode,
                    "max_steps": spec.max_steps.get(),
                    "timeout_ms": spec.timeout_ms.get()
                }
            }
        ],
        "tasks": [
            {
                "path": spec.task_path
            }
        ]
    });
    if !spec.verifier_env.is_empty() {
        config["verifier"] = json!({ "env": spec.verifier_env });
    }

    let encoded = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("failed to serialize harbor config: {e}"))?;
    std::fs::write(&config_path, format!("{encoded}\n"))
        .map_err(|e| format!("failed to write {}: {e}", config_path.display()))?;

    let pythonpath = prepend_search_path(
        &harbor_plugin_dir,
        std::env::var_os("PYTHONPATH").as_deref(),
    )?;

    let status = Command::new(spec.harbor_bin)
        .args(["run", "-c"])
        .arg(&config_path)
        .env("PYTHONPATH", pythonpath)
        .env_remove("all_proxy")
        .env_remove("ALL_PROXY")
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|e| format!("failed to spawn '{}': {e}", spec.harbor_bin))?;

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

fn settle_usage(
    summary_calls: u64,
    pending: &Pending,
    attempts: &UsagePage,
    is_completed: bool,
) -> Result<UsageSettlement, String> {
    if attempts.next_cursor.is_some()
        || attempts.total != summary_calls
        || u64::try_from(attempts.attempts.len()).ok() != Some(summary_calls)
    {
        return Err(format!(
            "inconsistent host usage attempts page: summary_calls={summary_calls}, page_total={}, page_len={}, has_next={}",
            attempts.total,
            attempts.attempts.len(),
            attempts.next_cursor.is_some(),
        ));
    }

    let mut successful_calls = 0u64;
    let mut input_missing = 0u64;
    let mut output_missing = 0u64;
    let mut lower_bound = pending.models > 0;
    let mut total_cost_usd = Some(0.0_f64);

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
        } else if matches!(attempt.outcome, Outcome::Aborted | Outcome::Unknown) {
            lower_bound = true;
        }

        let attempt_cost = match &attempt.quote {
            Some(quote) => quote
                .validate(&attempt.model_id)
                .and_then(|()| quote.estimate(u))
                .map_err(|e| {
                    format!(
                        "invalid host model quote on request {}: {e}",
                        attempt.request_id
                    )
                })?,
            None => None,
        };
        if attempt_cost.is_none()
            && (u.input_tokens.is_none()
                || u.output_tokens.is_none()
                || attempt.quote.as_ref().is_some_and(|q| q.pricing.is_some()))
        {
            lower_bound = true;
        }
        total_cost_usd = match (total_cost_usd, attempt_cost) {
            (Some(acc), Some(c)) => {
                let sum = acc + c;
                if sum.is_finite() {
                    Some(sum)
                } else {
                    lower_bound = true;
                    None
                }
            }
            _ => None,
        };
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
            cost_usd: total_cost_usd,
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

pub(crate) fn write_run_summary(
    out_dir: &Path,
    summary: &Value,
) -> Result<(PathBuf, String), String> {
    let summary_path = out_dir.join("run-summary.json");
    let encoded = serde_json::to_string_pretty(summary).map_err(|e| e.to_string())?;
    std::fs::write(&summary_path, format!("{encoded}\n"))
        .map_err(|e| format!("failed to write {}: {e}", summary_path.display()))?;
    Ok((summary_path, encoded))
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
