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

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::process::Command;

use crate::guest::{GuestRunResult, GuestRunStatus, SandboxMode};

#[derive(Debug, Clone)]
pub struct HarborRunOptions {
    pub task_path: PathBuf,
    pub bundle_dir: PathBuf,
    pub out_dir: PathBuf,
    pub harbor_bin: String,
    pub force_build: bool,
    pub base_url: Option<String>,
    pub api_key_env: String,
    pub provider: String,
    pub connection_slug: String,
    pub model_id: String,
    pub sandbox_mode: SandboxMode,
    pub max_steps: u32,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarborRunOutcome {
    pub reward: Option<f64>,
    pub verifier_result: Option<Value>,
    pub exception_info: Option<Value>,
    pub guest_result: Option<GuestRunResult>,
    pub transcript_path: Option<PathBuf>,
    pub harbor_result_path: PathBuf,
}

pub async fn run_trial(opts: &HarborRunOptions) -> Result<HarborRunOutcome, String> {
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
                "kwargs": {
                    "endpoint_url": opts.base_url,
                    "api_key_env": opts.api_key_env,
                    "provider": opts.provider,
                    "connection_slug": opts.connection_slug,
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
    let verifier_result = trial_json
        .get("verifier_result")
        .filter(|v| !v.is_null())
        .cloned();
    let exception_info = trial_json
        .get("exception_info")
        .filter(|v| !v.is_null())
        .cloned();

    let trial_dir = trial_result_path
        .parent()
        .ok_or("trial result.json has no parent directory")?;
    let guest_result_path = trial_dir
        .join("agent")
        .join("maka")
        .join("guest-result.json");
    let guest_result = if guest_result_path.is_file() {
        let raw_guest = std::fs::read_to_string(&guest_result_path)
            .map_err(|e| format!("failed to read {}: {e}", guest_result_path.display()))?;
        Some(
            serde_json::from_str::<GuestRunResult>(&raw_guest).map_err(|e| {
                format!(
                    "invalid guest-result.json {}: {e}",
                    guest_result_path.display()
                )
            })?,
        )
    } else {
        None
    };

    let transcript_candidate = trial_dir.join("agent").join("maka").join("transcript.json");
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
        verifier_result,
        exception_info,
        guest_result,
        transcript_path,
        harbor_result_path: trial_result_path,
    })
}

pub fn validate_trial_evidence(outcome: &HarborRunOutcome) -> Result<(), String> {
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
    if guest.status == GuestRunStatus::InfraFailed || guest.infra_error.is_some() {
        return Err(format!(
            "guest infrastructure failed: {}",
            guest.infra_error.as_deref().unwrap_or("unknown error")
        ));
    }
    let state_kind = guest
        .execution
        .as_ref()
        .and_then(|e| e["state"]["kind"].as_str());
    if !matches!(state_kind, Some("completed" | "failed" | "cancelled")) {
        return Err(format!(
            "guest execution receipt missing terminal state: {:?}",
            guest.execution
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
    let pending_models = guest
        .host_usage
        .as_ref()
        .and_then(|u| u.pointer("/summary/pending/models"))
        .and_then(Value::as_u64);
    let Some(attempts) = &guest.host_usage_attempts else {
        return Err(format!(
            "incomplete host usage accounting: pending_models={pending_models:?}, has_attempts=false"
        ));
    };
    if pending_models != Some(0) {
        return Err(format!(
            "incomplete host usage accounting: pending_models={pending_models:?}, has_attempts=true"
        ));
    }
    if !attempts.get("nextCursor").is_some_and(Value::is_null) {
        return Err(format!(
            "incomplete host usage attempt pagination: nextCursor={:?}",
            attempts.get("nextCursor")
        ));
    }
    let collected_len = attempts["attempts"].as_array().map(Vec::len);
    let declared_total = attempts["total"]
        .as_u64()
        .and_then(|n| usize::try_from(n).ok());
    if collected_len.is_none() || collected_len != declared_total {
        return Err(format!(
            "host usage attempt count mismatch: collected={collected_len:?}, total={declared_total:?}"
        ));
    }
    if let (Some(summary_through), Some(attempts_through)) = (
        guest
            .host_usage
            .as_ref()
            .and_then(|u| u.get("through"))
            .filter(|v| !v.is_null()),
        attempts.get("through").filter(|v| !v.is_null()),
    ) && summary_through != attempts_through
    {
        return Err(format!(
            "host usage fence mismatch between summary ({summary_through}) and attempts ({attempts_through})"
        ));
    }
    Ok(())
}

fn resolve_harbor_plugin_dir() -> Result<PathBuf, String> {
    let manifest_harbor = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("harbor");
    if manifest_harbor.join("maka_host_agent.py").is_file() {
        return std::fs::canonicalize(&manifest_harbor).map_err(|e| e.to_string());
    }
    if let Ok(cwd) = std::env::current_dir() {
        let candidate = cwd.join("products/eval/harbor");
        if candidate.join("maka_host_agent.py").is_file() {
            return std::fs::canonicalize(&candidate).map_err(|e| e.to_string());
        }
    }
    Err("unable to locate products/eval/harbor/maka_host_agent.py".into())
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
    use serde_json::json;

    fn sample_outcome(
        transcript_path: Option<PathBuf>,
        status: GuestRunStatus,
        state_kind: &str,
        pending_models: u64,
    ) -> HarborRunOutcome {
        HarborRunOutcome {
            reward: Some(0.0),
            verifier_result: Some(json!({ "rewards": { "reward": 0.0 } })),
            exception_info: None,
            guest_result: Some(GuestRunResult {
                status,
                steps_observed: 3,
                session_id: Some("sess-1".into()),
                run_id: Some("run-1".into()),
                execution: Some(json!({ "state": { "kind": state_kind } })),
                host_usage: Some(json!({
                    "through": { "sequence": 12 },
                    "summary": { "pending": { "models": pending_models } }
                })),
                host_usage_attempts: Some(json!({
                    "through": { "sequence": 12 },
                    "attempts": [],
                    "total": 0,
                    "nextCursor": null
                })),
                transcript_file: Some(PathBuf::from("/tmp/transcript.json")),
                stop_reason: (status == GuestRunStatus::SubjectStopped)
                    .then(|| "exceeded maxSteps (3)".into()),
                infra_error: (status == GuestRunStatus::InfraFailed)
                    .then(|| "host startup failed".into()),
            }),
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
        let (_dir, transcript) = temp_transcript_file();
        let outcome = sample_outcome(Some(transcript), GuestRunStatus::Completed, "completed", 0);
        assert!(validate_trial_evidence(&outcome).is_ok());
    }

    #[test]
    fn accepts_subject_stopped_with_settled_receipt_and_zero_reward() {
        let (_dir, transcript) = temp_transcript_file();
        let outcome = sample_outcome(
            Some(transcript),
            GuestRunStatus::SubjectStopped,
            "cancelled",
            0,
        );
        assert!(validate_trial_evidence(&outcome).is_ok());
    }

    #[test]
    fn rejects_infra_failed_exception_missing_reward_or_unsettled_usage() {
        let (_dir, transcript) = temp_transcript_file();

        let infra = sample_outcome(
            Some(transcript.clone()),
            GuestRunStatus::InfraFailed,
            "failed",
            0,
        );
        assert!(
            validate_trial_evidence(&infra)
                .unwrap_err()
                .contains("infrastructure failed")
        );

        let mut with_exc = sample_outcome(
            Some(transcript.clone()),
            GuestRunStatus::Completed,
            "completed",
            0,
        );
        with_exc.exception_info = Some(json!({ "exception_type": "RuntimeError" }));
        assert!(
            validate_trial_evidence(&with_exc)
                .unwrap_err()
                .contains("exception")
        );

        let mut no_reward = sample_outcome(
            Some(transcript.clone()),
            GuestRunStatus::Completed,
            "completed",
            0,
        );
        no_reward.reward = None;
        assert!(
            validate_trial_evidence(&no_reward)
                .unwrap_err()
                .contains("finite numeric reward")
        );

        let pending_usage = sample_outcome(
            Some(transcript.clone()),
            GuestRunStatus::Completed,
            "completed",
            1,
        );
        assert!(
            validate_trial_evidence(&pending_usage)
                .unwrap_err()
                .contains("incomplete host usage")
        );

        let mut more_pages = sample_outcome(
            Some(transcript.clone()),
            GuestRunStatus::Completed,
            "completed",
            0,
        );
        more_pages
            .guest_result
            .as_mut()
            .unwrap()
            .host_usage_attempts = Some(json!({
            "through": { "sequence": 12 },
            "attempts": [],
            "total": 0,
            "nextCursor": { "offset": 32 }
        }));
        assert!(
            validate_trial_evidence(&more_pages)
                .unwrap_err()
                .contains("attempt pagination")
        );

        let mut truncated_attempts = sample_outcome(
            Some(transcript.clone()),
            GuestRunStatus::Completed,
            "completed",
            0,
        );
        truncated_attempts
            .guest_result
            .as_mut()
            .unwrap()
            .host_usage_attempts = Some(json!({
            "through": { "sequence": 12 },
            "attempts": [],
            "total": 2,
            "nextCursor": null
        }));
        assert!(
            validate_trial_evidence(&truncated_attempts)
                .unwrap_err()
                .contains("count mismatch")
        );

        let mut fence_mismatch =
            sample_outcome(Some(transcript), GuestRunStatus::Completed, "completed", 0);
        fence_mismatch
            .guest_result
            .as_mut()
            .unwrap()
            .host_usage_attempts = Some(json!({
            "through": { "sequence": 99 },
            "attempts": [],
            "total": 0,
            "nextCursor": null
        }));
        assert!(
            validate_trial_evidence(&fence_mismatch)
                .unwrap_err()
                .contains("fence mismatch")
        );
    }
}
