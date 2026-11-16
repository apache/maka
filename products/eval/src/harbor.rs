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

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde_json::{Map, Value, json};
use tokio::process::Command;

use crate::guest::{GuestEvidence, GuestRunResult, is_terminal_execution_state};

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
    let job_name = format!(
        "run-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    );
    let config_path = out_dir.join("harbor-job-config.json");
    let harbor_plugin_dir = resolve_harbor_plugin_dir()?;
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

    let pythonpath = match std::env::var("PYTHONPATH") {
        Ok(existing) if !existing.is_empty() => {
            format!("{}:{existing}", harbor_plugin_dir.display())
        }
        _ => harbor_plugin_dir.to_string_lossy().into_owned(),
    };

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

    if !status.success() && reward.is_none() {
        return Err(format!(
            "harbor run failed ({status}); exception_info={}",
            exception_info
                .as_ref()
                .map(Value::to_string)
                .unwrap_or_else(|| "null".into())
        ));
    }

    Ok(HarborRunOutcome {
        reward,
        exception_info,
        guest_result,
        guest_result_path,
        transcript_path,
        harbor_result_path: trial_result_path,
    })
}

pub(crate) fn validate_trial_evidence(outcome: &HarborRunOutcome) -> Result<(), String> {
    if let Some(exc) = &outcome.exception_info {
        return Err(format!("harbor trial recorded exception: {exc}"));
    }
    if !outcome.reward.is_some_and(f64::is_finite) {
        return Err(format!(
            "verifier did not produce a finite numeric reward: {:?}",
            outcome.reward
        ));
    }
    let Some(guest) = &outcome.guest_result else {
        return Err("missing guest-result.json from trial artifacts".into());
    };
    let (is_completed, evidence) = match guest {
        GuestRunResult::InfraFailed { infra_error, .. } => {
            return Err(format!("guest infrastructure failed: {infra_error}"));
        }
        GuestRunResult::Completed { evidence } => (true, evidence.as_ref()),
        GuestRunResult::SubjectStopped { evidence, .. } => (false, evidence.as_ref()),
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
    if summary.pending.models != 0 || summary.pending.tools != 0 {
        return Err(format!(
            "incomplete host usage accounting: pending_models={}, pending_tools={}",
            summary.pending.models, summary.pending.tools
        ));
    }
    let calls = summary.models.calls;
    if is_completed && calls == 0 {
        return Err(
            "incomplete host usage accounting: completed run recorded 0 model calls".into(),
        );
    }
    let input_missing = summary.models.input.missing;
    let output_missing = summary.models.output.missing;
    if input_missing != 0 || output_missing != 0 {
        return Err(format!(
            "incomplete token usage across {calls} model call(s): input_missing={input_missing}, output_missing={output_missing}"
        ));
    }
    Ok(())
}

fn resolve_harbor_plugin_dir() -> Result<PathBuf, String> {
    let plugin_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("harbor");
    if plugin_dir.join("maka_host_agent.py").is_file() {
        std::fs::canonicalize(&plugin_dir).map_err(|e| e.to_string())
    } else {
        Err(format!(
            "missing harbor plugin under {}",
            plugin_dir.display()
        ))
    }
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
    use crate::guest::tests::sample_evidence;
    use maka_agent_api::contract::ExecutionState;
    use serde_json::json;

    fn outcome_with(
        transcript_path: Option<PathBuf>,
        guest_result: GuestRunResult,
    ) -> HarborRunOutcome {
        HarborRunOutcome {
            reward: Some(0.0),
            exception_info: None,
            guest_result: Some(guest_result),
            guest_result_path: Some(PathBuf::from("/tmp/guest-result.json")),
            transcript_path,
            harbor_result_path: PathBuf::from("/tmp/result.json"),
        }
    }

    fn temp_transcript_file() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("transcript.json");
        std::fs::write(&file, "{}\n").unwrap();
        (dir, file)
    }

    #[test]
    fn accepts_completed_subject_with_zero_reward() {
        assert_eq!(
            parse_sandbox_mode("workspace-write").unwrap(),
            maka_sandbox::Mode::WorkspaceWrite
        );
        assert!(parse_sandbox_mode("full").is_err());

        let (_dir, transcript) = temp_transcript_file();
        let outcome = outcome_with(
            Some(transcript),
            GuestRunResult::Completed {
                evidence: Box::new(sample_evidence(ExecutionState::Completed, 0, 0, 1, 0, 0)),
            },
        );
        assert!(validate_trial_evidence(&outcome).is_ok());

        let summary = outcome.to_summary_json();
        assert_eq!(summary["guest"]["status"], json!("completed"));
        assert_eq!(summary["guest"]["stepsObserved"], json!(2));
        assert_eq!(summary["guest"]["usage"]["models"]["calls"], json!(1));
        assert_eq!(summary["guestResultPath"], json!("/tmp/guest-result.json"));
        assert!(summary.get("verifierResult").is_none());
        assert!(summary.get("guestResult").is_none());
        assert!(summary["guest"].get("hostUsageAttempts").is_none());
    }

    #[test]
    fn accepts_subject_stopped_with_settled_receipt_and_zero_reward() {
        let (_dir, transcript) = temp_transcript_file();
        let outcome = outcome_with(
            Some(transcript),
            GuestRunResult::SubjectStopped {
                stop_reason: "exceeded maxSteps (3)".into(),
                evidence: Box::new(sample_evidence(ExecutionState::Cancelled, 0, 0, 0, 0, 0)),
            },
        );
        assert!(validate_trial_evidence(&outcome).is_ok());
    }

    #[test]
    fn rejects_infra_failed_exception_missing_reward_or_unsettled_usage() {
        let (_dir, transcript) = temp_transcript_file();

        let infra = outcome_with(
            Some(transcript.clone()),
            GuestRunResult::InfraFailed {
                infra_error: "host startup failed".into(),
                evidence: Some(Box::new(sample_evidence(
                    ExecutionState::Failed { reason: None },
                    0,
                    0,
                    1,
                    0,
                    0,
                ))),
            },
        );
        assert!(
            validate_trial_evidence(&infra)
                .unwrap_err()
                .contains("infrastructure failed")
        );

        let non_terminal = outcome_with(
            Some(transcript.clone()),
            GuestRunResult::Completed {
                evidence: Box::new(sample_evidence(ExecutionState::Running, 0, 0, 1, 0, 0)),
            },
        );
        assert!(
            validate_trial_evidence(&non_terminal)
                .unwrap_err()
                .contains("missing terminal state")
        );

        let mut with_exc = outcome_with(
            Some(transcript.clone()),
            GuestRunResult::Completed {
                evidence: Box::new(sample_evidence(ExecutionState::Completed, 0, 0, 1, 0, 0)),
            },
        );
        with_exc.exception_info = Some(json!({ "exception_type": "RuntimeError" }));
        assert!(
            validate_trial_evidence(&with_exc)
                .unwrap_err()
                .contains("exception")
        );

        let mut no_reward = outcome_with(
            Some(transcript.clone()),
            GuestRunResult::Completed {
                evidence: Box::new(sample_evidence(ExecutionState::Completed, 0, 0, 1, 0, 0)),
            },
        );
        no_reward.reward = None;
        assert!(
            validate_trial_evidence(&no_reward)
                .unwrap_err()
                .contains("finite numeric reward")
        );

        for (evidence, expected_err) in [
            (
                sample_evidence(ExecutionState::Completed, 1, 0, 1, 0, 0),
                "incomplete host usage",
            ),
            (
                sample_evidence(ExecutionState::Completed, 0, 1, 1, 0, 0),
                "incomplete host usage",
            ),
            (
                sample_evidence(ExecutionState::Completed, 0, 0, 0, 0, 0),
                "0 model calls",
            ),
            (
                sample_evidence(ExecutionState::Completed, 0, 0, 2, 1, 0),
                "incomplete token usage",
            ),
            (
                sample_evidence(ExecutionState::Completed, 0, 0, 2, 0, 1),
                "incomplete token usage",
            ),
        ] {
            let outcome = outcome_with(
                Some(transcript.clone()),
                GuestRunResult::Completed {
                    evidence: Box::new(evidence),
                },
            );
            assert!(
                validate_trial_evidence(&outcome)
                    .unwrap_err()
                    .contains(expected_err)
            );
        }
    }
}
