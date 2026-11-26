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

use maka_agent_facts::accounting::{ModelTotals, ToolTotals};
use maka_agent_facts::execution::ThinkingLevel;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::guest::{GuestEvidence, GuestRunResult, Metering, UsageSettlement};

const HARBOR_AGENT_PLUGIN_PY: &str = include_str!("../harbor/maka_host_agent.py");
const TEARDOWN_GRACE_SEC: f64 = 30.0;

#[derive(Debug, Clone)]
struct VerifierEnvRef {
    target: String,
    host_var: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum TrialOutcome {
    Scored {
        guest_status: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stop_reason: Option<String>,
        reward: f64,
        steps_observed: u32,
        settlement: UsageSettlement,
        models: Box<ModelTotals>,
        tools: ToolTotals,
    },
    InfraFailed {
        error: String,
    },
}

fn default_sandbox_mode() -> maka_sandbox::Mode {
    maka_sandbox::Mode::DangerFullAccess
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, clap::Args)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SubjectConfig {
    #[arg(long)]
    pub bundle_dir: PathBuf,
    #[arg(long)]
    pub provider: String,
    #[arg(long = "model")]
    #[serde(alias = "model")]
    pub model_id: String,
    #[arg(long)]
    pub api_key_env: String,
    #[arg(long)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[arg(long, value_parser = parse_thinking_level)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<ThinkingLevel>,
    #[arg(long, value_parser = parse_sandbox_mode, default_value = "danger-full-access")]
    #[serde(default = "default_sandbox_mode")]
    pub sandbox_mode: maka_sandbox::Mode,
    #[arg(long)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_steps: Option<NonZeroU32>,
    #[arg(long)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<NonZeroU64>,
}

#[derive(Debug, Clone, clap::Args)]
pub(crate) struct HarborRunOptions {
    #[arg(long = "task")]
    pub task_path: PathBuf,
    #[arg(long = "out")]
    pub out_dir: PathBuf,
    #[arg(long, default_value = "harbor")]
    pub harbor_bin: String,
    #[arg(long)]
    pub force_build: bool,
    #[command(flatten)]
    pub subject: SubjectConfig,
    #[arg(long = "verifier-env", value_name = "KEY[=${HOST_VAR}]")]
    pub verifier_env: Vec<String>,
}

pub(crate) fn parse_thinking_level(raw: &str) -> Result<ThinkingLevel, String> {
    serde_json::from_value(Value::String(raw.to_owned())).map_err(|e| e.to_string())
}

pub(crate) fn parse_sandbox_mode(raw: &str) -> Result<maka_sandbox::Mode, String> {
    serde_json::from_value(Value::String(raw.to_owned())).map_err(|e| e.to_string())
}

pub(crate) fn validate_subject(subject: &mut SubjectConfig) -> Result<(), String> {
    for (label, value) in [
        ("provider", &subject.provider),
        ("model", &subject.model_id),
        ("api-key-env", &subject.api_key_env),
    ] {
        if value.trim().is_empty() {
            return Err(format!("{label} must not be empty"));
        }
    }
    subject.base_url = subject.base_url.take().filter(|s| !s.trim().is_empty());
    let bundle_dir = std::fs::canonicalize(&subject.bundle_dir).map_err(|e| {
        format!(
            "failed to resolve bundle dir {}: {e}",
            subject.bundle_dir.display()
        )
    })?;
    for required in ["maka", "maka-python-worker", "maka-eval"] {
        let bin = bundle_dir.join(required);
        if !bin.is_file() {
            return Err(format!("bundle missing required binary: {}", bin.display()));
        }
    }
    subject.bundle_dir = bundle_dir;
    if std::env::var(&subject.api_key_env)
        .unwrap_or_default()
        .trim()
        .is_empty()
    {
        return Err(format!(
            "API key environment variable '{}' is unset or empty",
            subject.api_key_env
        ));
    }
    Ok(())
}

fn is_valid_env_var_name(key: &str) -> bool {
    !key.is_empty()
        && (key.as_bytes()[0].is_ascii_alphabetic() || key.as_bytes()[0] == b'_')
        && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn parse_verifier_env(raw: &str) -> Result<VerifierEnvRef, String> {
    if let Some((target, expr)) = raw.split_once('=') {
        if !is_valid_env_var_name(target) {
            return Err("invalid --verifier-env: expected KEY or KEY=${HOST_VAR}".into());
        }
        let host_var = expr
            .strip_prefix("${")
            .and_then(|s| s.strip_suffix('}'))
            .filter(|v| is_valid_env_var_name(v))
            .ok_or_else(|| {
                format!(
                    "invalid --verifier-env for '{target}': only host env references KEY or KEY=${{HOST_VAR}} are allowed so values are never persisted to Harbor artifacts"
                )
            })?;
        return Ok(VerifierEnvRef {
            target: target.to_owned(),
            host_var: host_var.to_owned(),
        });
    }
    if !is_valid_env_var_name(raw) {
        return Err("invalid --verifier-env: expected KEY or KEY=${HOST_VAR}".into());
    }
    Ok(VerifierEnvRef {
        target: raw.to_owned(),
        host_var: raw.to_owned(),
    })
}

// Harbor 0.26.0's `Trial._init_agent` only forwards `agent_timeout_sec` to `OracleAgent`,
// and `AgentConfig` only accepts an absolute `override_timeout_sec` (no relative teardown grace),
// so `maka-eval` reads `[agent].timeout_sec` from `task.toml` directly for single-step tasks.
#[derive(Deserialize)]
struct TaskToml {
    agent: Option<TaskAgentToml>,
    #[serde(default)]
    steps: Vec<serde::de::IgnoredAny>,
}

#[derive(Deserialize)]
struct TaskAgentToml {
    timeout_sec: Option<f64>,
}

pub(crate) fn read_task_timeout_ms(
    task_toml: &Path,
    override_timeout_ms: Option<NonZeroU64>,
) -> Result<Option<NonZeroU64>, String> {
    let raw = std::fs::read_to_string(task_toml)
        .map_err(|e| format!("failed to read {}: {e}", task_toml.display()))?;
    let parsed: TaskToml =
        toml::from_str(&raw).map_err(|e| format!("invalid {}: {e}", task_toml.display()))?;
    if !parsed.steps.is_empty() {
        return Err(format!(
            "multi-step tasks ([[steps]]) in {} are not supported by maka-eval run",
            task_toml.display()
        ));
    }
    if let Some(ms) = override_timeout_ms {
        return Ok(Some(ms));
    }
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

pub(crate) struct HarborRunOutcome {
    pub harbor_status: ExitStatus,
    pub wall_duration_ms: u64,
    pub reward: Option<f64>,
    pub exception_info: Option<Value>,
    pub guest_result: Option<GuestRunResult>,
    pub guest_result_path: Option<PathBuf>,
    pub transcript_path: Option<PathBuf>,
    pub harbor_result_path: PathBuf,
}

struct EvidencedOutcome<'a> {
    guest_status: &'static str,
    stop_reason: Option<&'a str>,
    evidence: &'a GuestEvidence,
    settlement: &'a UsageSettlement,
    reward: f64,
}

impl HarborRunOutcome {
    pub(crate) fn settle(&self) -> (Value, Result<(), String>) {
        let guest_json = self
            .guest_result
            .as_ref()
            .map_or(Value::Null, build_guest_json);
        let (reward, validation) = match self.classify() {
            Ok(ev) => (Some(ev.reward), Ok(())),
            Err(err) => (None, Err(err)),
        };
        let summary = json!({
            "reward": reward,
            "exceptionInfo": self.exception_info,
            "guest": guest_json,
            "guestResultPath": self.guest_result_path,
            "transcriptPath": self.transcript_path,
            "harborResultPath": self.harbor_result_path,
        });
        (summary, validation)
    }

    pub(crate) fn settle_outcome(&self) -> TrialOutcome {
        match self.classify() {
            Ok(ev) => TrialOutcome::Scored {
                guest_status: ev.guest_status.to_owned(),
                stop_reason: ev.stop_reason.map(str::to_owned),
                reward: ev.reward,
                steps_observed: ev.evidence.steps_observed,
                settlement: *ev.settlement,
                models: Box::new(ev.evidence.host_usage.summary.models.clone()),
                tools: ev.evidence.host_usage.summary.tools.clone(),
            },
            Err(error) => TrialOutcome::InfraFailed { error },
        }
    }

    fn classify(&self) -> Result<EvidencedOutcome<'_>, String> {
        let (guest_status, stop_reason, evidence, settlement) = match &self.guest_result {
            None => {
                return Err(check_harbor_outcome(self)
                    .err()
                    .unwrap_or_else(|| "missing guest-result.json from trial artifacts".into()));
            }
            Some(GuestRunResult::InfraFailed { infra_error, .. }) => {
                return Err(format!("guest infrastructure failed: {infra_error}"));
            }
            Some(GuestRunResult::Completed {
                evidence,
                settlement,
            }) => ("completed", None, evidence.as_ref(), settlement),
            Some(GuestRunResult::SubjectStopped {
                stop_reason,
                evidence,
                settlement,
            }) => (
                "subjectStopped",
                Some(stop_reason.as_str()),
                evidence.as_ref(),
                settlement,
            ),
        };
        let reward = check_harbor_outcome(self)?;
        if !self.transcript_path.as_ref().is_some_and(|p| p.is_file()) {
            return Err(format!(
                "missing exported transcript.json artifact: {:?}",
                self.transcript_path
            ));
        }
        Ok(EvidencedOutcome {
            guest_status,
            stop_reason,
            evidence,
            settlement,
            reward,
        })
    }
}

fn build_guest_json(guest: &GuestRunResult) -> Value {
    let (status, reason_field, evidence, settlement) = match guest {
        GuestRunResult::InfraFailed {
            infra_error,
            evidence,
        } => (
            "infraFailed",
            Some(("infraError", infra_error.as_str())),
            evidence.as_deref(),
            None,
        ),
        GuestRunResult::Completed {
            evidence,
            settlement,
        } => ("completed", None, Some(evidence.as_ref()), Some(settlement)),
        GuestRunResult::SubjectStopped {
            stop_reason,
            evidence,
            settlement,
        } => (
            "subjectStopped",
            Some(("stopReason", stop_reason.as_str())),
            Some(evidence.as_ref()),
            Some(settlement),
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
    match settlement.map(|s| s.metering) {
        Some(Metering::Complete { cost_usd }) => {
            map.insert("costUsd".into(), json!(cost_usd));
            map.insert("metering".into(), json!("complete"));
        }
        Some(Metering::LowerBound) => {
            map.insert("costUsd".into(), Value::Null);
            map.insert("metering".into(), json!("lower_bound"));
        }
        None => {}
    }
    Value::Object(map)
}

fn resolve_verifier_env(
    raw_entries: &[String],
    has_env: impl Fn(&str) -> bool,
) -> Result<Vec<VerifierEnvRef>, String> {
    let entries: Vec<VerifierEnvRef> = raw_entries
        .iter()
        .map(|raw| parse_verifier_env(raw))
        .collect::<Result<_, _>>()?;
    let mut keys = BTreeSet::<&str>::new();
    for entry in &entries {
        if !keys.insert(entry.target.as_str()) {
            return Err(format!("duplicate --verifier-env key '{}'", entry.target));
        }
        if matches!(entry.host_var.as_str(), "ALL_PROXY" | "all_proxy") {
            return Err(format!(
                "--verifier-env host variable '{}' is stripped by maka-eval before invoking harbor",
                entry.host_var
            ));
        }
        if !has_env(&entry.host_var) {
            return Err(format!(
                "--verifier-env host variable '{}' is not set",
                entry.host_var
            ));
        }
    }
    Ok(entries)
}

pub(crate) fn validate_verifier_env(raw_entries: &[String]) -> Result<(), String> {
    resolve_verifier_env(raw_entries, |var| std::env::var_os(var).is_some()).map(|_| ())
}

pub(crate) fn run_trial(
    opts: &HarborRunOptions,
    log_prefix: Option<&str>,
) -> Result<HarborRunOutcome, String> {
    let verifier_env =
        resolve_verifier_env(&opts.verifier_env, |var| std::env::var_os(var).is_some())?;

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
    let mut subject = opts.subject.clone();
    let effective_timeout_ms = read_task_timeout_ms(&task_toml, subject.timeout_ms)?;
    validate_subject(&mut subject)?;

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
        "model_name": format!("{}/{}", subject.provider, subject.model_id),
        "skip_model_parsing": true,
        "kwargs": {
            // Named `endpoint_url` because Harbor `BaseAgent.preflight` rejects `kwargs["base_url"]` when `capabilities.base_url` is false.
            "endpoint_url": subject.base_url,
            "api_key_env": subject.api_key_env,
            "provider": subject.provider,
            "model_id": subject.model_id,
            "thinking_level": subject.thinking_level,
            "sandbox_mode": subject.sandbox_mode,
            "max_steps": subject.max_steps.map(NonZeroU32::get),
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
                    "source": subject.bundle_dir,
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
        .stdin(Stdio::null());
    if let Some(prefix) = log_prefix {
        let log = |ext| {
            let p = out_dir.join(format!("{prefix}.{ext}.log"));
            std::fs::File::create(&p).map_err(|e| format!("failed to create {}: {e}", p.display()))
        };
        harbor_cmd
            .stdout(Stdio::from(log("stdout")?))
            .stderr(Stdio::from(log("stderr")?));
    } else {
        harbor_cmd.stdout(Stdio::inherit()).stderr(Stdio::inherit());
    }
    for entry in &verifier_env {
        harbor_cmd.args([
            "--verifier-env",
            &format!("{}=${{{}}}", entry.target, entry.host_var),
        ]);
    }
    let harbor_started = std::time::Instant::now();
    let status = harbor_cmd
        .status()
        .map_err(|e| format!("failed to spawn '{}': {e}", opts.harbor_bin))?;
    let wall_duration_ms = u64::try_from(harbor_started.elapsed().as_millis()).unwrap_or(u64::MAX);

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
        wall_duration_ms,
        reward,
        exception_info,
        guest_result,
        guest_result_path,
        transcript_path,
        harbor_result_path: trial_result_path,
    })
}

fn check_harbor_outcome(outcome: &HarborRunOutcome) -> Result<f64, String> {
    if let Some(exc) = &outcome.exception_info {
        return Err(format!("harbor trial recorded exception: {exc}"));
    }
    if !outcome.harbor_status.success() {
        return Err(format!(
            "harbor run failed ({}) without recording exception_info",
            outcome.harbor_status
        ));
    }
    match outcome.reward {
        Some(reward) if reward.is_finite() => Ok(reward),
        other => Err(format!(
            "verifier did not produce a finite numeric reward: {other:?}"
        )),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_and_validate_verifier_env_enforces_host_references_only() {
        let bare = parse_verifier_env("HOST_MARKER").unwrap();
        assert_eq!(bare.target, "HOST_MARKER");
        assert_eq!(bare.host_var, "HOST_MARKER");

        let mapped = parse_verifier_env("JUDGE_KEY=${SYNTH_KEY}").unwrap();
        assert_eq!(mapped.target, "JUDGE_KEY");
        assert_eq!(mapped.host_var, "SYNTH_KEY");

        for bad in [
            "MODE=strict",
            "MODE=${HOST_MARKER:-fallback}",
            "123=${HOST_MARKER}",
            "123",
        ] {
            assert!(parse_verifier_env(bad).is_err(), "expected error for {bad}");
        }

        for (secret_arg, secret_val) in [
            (
                "JUDGE_KEY=sk-synth-literal-secret",
                "sk-synth-literal-secret",
            ),
            ("sk-raw-secret-token", "sk-raw-secret-token"),
            ("bad-key=sk-raw-secret", "sk-raw-secret"),
        ] {
            let err = resolve_verifier_env(&[secret_arg.to_owned()], |_| true).unwrap_err();
            assert!(
                !err.contains(secret_val),
                "error leaked secret value: {err}"
            );
        }

        assert!(
            resolve_verifier_env(
                &[
                    "HOST_MARKER".to_owned(),
                    "JUDGE_KEY=${SYNTH_KEY}".to_owned()
                ],
                |_| true
            )
            .is_ok()
        );

        assert!(
            resolve_verifier_env(
                &["HOST_MARKER".to_owned(), "HOST_MARKER=${OTHER}".to_owned()],
                |_| true
            )
            .unwrap_err()
            .contains("duplicate --verifier-env key 'HOST_MARKER'")
        );

        for proxy in ["ALL_PROXY", "all_proxy"] {
            assert!(
                resolve_verifier_env(&[format!("P=${{{proxy}}}")], |_| true)
                    .unwrap_err()
                    .contains("stripped by maka-eval")
            );
        }

        assert!(
            resolve_verifier_env(&["MISSING_VAR".to_owned()], |_| false)
                .unwrap_err()
                .contains("is not set")
        );
    }

    #[test]
    fn read_task_timeout_ms_parses_positive_fractional_and_rejects_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("task.toml");

        std::fs::write(&path, "[task]\nname = \"ws\"\n").unwrap();
        assert_eq!(read_task_timeout_ms(&path, None).unwrap(), None);

        std::fs::write(&path, "[task]\nname = \"ws\"\nsteps = []\n").unwrap();
        assert_eq!(read_task_timeout_ms(&path, None).unwrap(), None);

        std::fs::write(
            &path,
            "[task]\nname = \"ws\"\n[agent]\ntimeout_sec = 10.5\n",
        )
        .unwrap();
        assert_eq!(
            read_task_timeout_ms(&path, None).unwrap(),
            NonZeroU64::new(10_500)
        );

        let override_ms = NonZeroU64::new(5_000);
        for invalid in [
            "[agent]\ntimeout_sec = 0\n",
            "[agent]\ntimeout_sec = -1.0\n",
        ] {
            std::fs::write(&path, invalid).unwrap();
            assert!(
                read_task_timeout_ms(&path, None)
                    .unwrap_err()
                    .contains("must be finite and > 0")
            );
        }
        std::fs::write(&path, "[agent]\ntimeout_sec = 0\n").unwrap();
        assert_eq!(
            read_task_timeout_ms(&path, override_ms).unwrap(),
            override_ms
        );

        std::fs::write(&path, "[[steps]]\nname = \"main\"\n").unwrap();
        for override_arg in [None, override_ms] {
            assert!(
                read_task_timeout_ms(&path, override_arg)
                    .unwrap_err()
                    .contains("multi-step tasks ([[steps]])")
            );
        }
    }
}
