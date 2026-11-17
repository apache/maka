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

use maka_agent_facts::accounting::{Activity, Outcome, Pending};
use maka_settings_native::usage::Page as UsagePage;
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

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum UsageSettlement {
    Complete { cost_usd: Option<f64> },
    LowerBound,
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
            }) => {
                let evidenced = evidence.as_deref().map(|ev| {
                    let s = &ev.host_usage.summary;
                    let settlement =
                        settle_usage(s.models.calls, &s.pending, &ev.host_usage_attempts, false);
                    (ev, settlement)
                });
                (
                    build_guest_json(
                        "infraFailed",
                        Some(("infraError", infra_error)),
                        evidenced.as_ref().map(|(ev, s)| (*ev, s)),
                    ),
                    Err(format!("guest infrastructure failed: {infra_error}")),
                )
            }
            Some(GuestRunResult::Completed { evidence }) => {
                self.settle_evidenced("completed", None, evidence, true)
            }
            Some(GuestRunResult::SubjectStopped {
                stop_reason,
                evidence,
            }) => self.settle_evidenced(
                "subjectStopped",
                Some(("stopReason", stop_reason)),
                evidence,
                false,
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
        is_completed: bool,
    ) -> (Value, Result<(), String>) {
        let s = &evidence.host_usage.summary;
        let settlement = settle_usage(
            s.models.calls,
            &s.pending,
            &evidence.host_usage_attempts,
            is_completed,
        );
        let guest_json = build_guest_json(status, reason_field, Some((evidence, &settlement)));
        let validation = self.validate_evidenced(evidence, settlement);
        (guest_json, validation)
    }

    fn validate_evidenced(
        &self,
        evidence: &GuestEvidence,
        settlement: Result<UsageSettlement, String>,
    ) -> Result<(), String> {
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
        settlement.map(|_| ())
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
    use maka_agent_facts::accounting::{AuxiliarySource, ModelAttempt, Origin};
    use maka_agent_facts::model::ModelUsage;
    use maka_agent_facts::pricing::{Pricing, Quote};
    use maka_agent_state::usage::UsageFence;

    fn page_of(attempts: Vec<ModelAttempt>) -> UsagePage {
        let total = attempts.len() as u64;
        UsagePage {
            through: UsageFence {
                schema_version: 1,
                state_domain: "eval".into(),
                sequence: total,
                auxiliary_sequence: 0,
                cell_sequence: 0,
                query_digest: "digest".into(),
            },
            attempts: attempts.into_iter().map(Activity::Model).collect(),
            total,
            next_cursor: None,
        }
    }

    fn model_attempt(usage: ModelUsage, quote: Option<Quote>) -> ModelAttempt {
        ModelAttempt {
            request_id: "req-1".into(),
            origin: Origin::Auxiliary {
                source: AuxiliarySource::HostEffect { id: Uuid::nil() },
            },
            session_id: None,
            binding: None,
            model_id: "deepseek-chat".into(),
            started_at: 1.0,
            completed_at: 2.0,
            outcome: Outcome::Success,
            usage,
            quote,
            cost_usd: None,
        }
    }

    #[test]
    fn settle_usage_distinguishes_unpriced_missing_cache_zero_calls_and_invalid_quotes() {
        let settled = Pending {
            models: 0,
            tools: 0,
        };
        let complete_usage = ModelUsage {
            input_tokens: Some(100),
            output_tokens: Some(20),
            cache_read_tokens: Some(20),
            cache_write_tokens: None,
            reasoning_tokens: None,
        };
        let unpriced = Quote {
            provider_id: "ollama-cloud".into(),
            revision: 0,
            pricing: None,
        };
        let page = page_of(vec![model_attempt(complete_usage.clone(), Some(unpriced))]);
        assert_eq!(
            settle_usage(1, &settled, &page, true).unwrap(),
            UsageSettlement::Complete { cost_usd: None }
        );

        let priced = Quote {
            provider_id: "deepseek".into(),
            revision: 1,
            pricing: Some(Pricing {
                model_key: "deepseek:deepseek-chat".into(),
                input_usd_per_million: 0.28,
                output_usd_per_million: 0.42,
                cache_read_usd_per_million: Some(0.028),
                cache_write_usd_per_million: None,
            }),
        };
        let page = page_of(vec![model_attempt(
            ModelUsage {
                cache_read_tokens: None,
                ..complete_usage.clone()
            },
            Some(priced),
        )]);
        assert_eq!(
            settle_usage(1, &settled, &page, true).unwrap(),
            UsageSettlement::LowerBound
        );

        let empty_page = page_of(vec![]);
        assert_eq!(
            settle_usage(0, &settled, &empty_page, false).unwrap(),
            UsageSettlement::Complete {
                cost_usd: Some(0.0)
            }
        );

        let mismatched = Quote {
            provider_id: "deepseek".into(),
            revision: 1,
            pricing: Some(Pricing {
                model_key: "deepseek:other-model".into(),
                input_usd_per_million: 0.28,
                output_usd_per_million: 0.42,
                cache_read_usd_per_million: None,
                cache_write_usd_per_million: None,
            }),
        };
        let page = page_of(vec![model_attempt(complete_usage, Some(mismatched))]);
        assert!(
            settle_usage(1, &settled, &page, true)
                .unwrap_err()
                .contains("invalid host model quote on request req-1")
        );
    }
}
