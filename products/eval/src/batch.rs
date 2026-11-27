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

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsStr;
use std::fmt::Write as _;
use std::num::{NonZeroU32, NonZeroU64, NonZeroUsize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use maka_agent_facts::execution::ThinkingLevel;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::guest::Metering;
use crate::harbor::{
    HarborRunOptions, SubjectConfig, TrialOutcome, parse_sandbox_mode, parse_thinking_level,
    read_task_timeout_ms, run_trial, validate_subject, validate_verifier_env,
};

#[derive(Debug, Clone, clap::Args)]
pub(crate) struct BatchCliOptions {
    #[arg(long = "out")]
    pub out_dir: PathBuf,
    /// Task directory containing task.toml (repeatable).
    #[arg(long = "task", conflicts_with_all = ["resume", "retry_infra"])]
    pub tasks: Vec<PathBuf>,
    /// Parent directory whose child directories contain task.toml (repeatable).
    #[arg(long = "tasks-dir", conflicts_with_all = ["resume", "retry_infra"])]
    pub tasks_dir: Vec<PathBuf>,
    /// JSON array of subjects (each with id, bundleDir, provider, modelId, apiKeyEnv, ...).
    #[arg(long, conflicts_with_all = ["resume", "retry_infra"])]
    pub subjects_file: Option<PathBuf>,
    #[arg(long, conflicts_with_all = ["resume", "retry_infra", "subjects_file"])]
    pub bundle_dir: Option<PathBuf>,
    #[arg(long, conflicts_with_all = ["resume", "retry_infra", "subjects_file"])]
    pub provider: Option<String>,
    #[arg(long = "model", conflicts_with_all = ["resume", "retry_infra", "subjects_file"])]
    pub model_id: Option<String>,
    #[arg(long, conflicts_with_all = ["resume", "retry_infra", "subjects_file"])]
    pub api_key_env: Option<String>,
    #[arg(long, conflicts_with_all = ["resume", "retry_infra", "subjects_file"])]
    pub base_url: Option<String>,
    #[arg(long, value_parser = parse_thinking_level, conflicts_with_all = ["resume", "retry_infra", "subjects_file"])]
    pub thinking_level: Option<ThinkingLevel>,
    #[arg(long, value_parser = parse_sandbox_mode, conflicts_with_all = ["resume", "retry_infra", "subjects_file"])]
    pub sandbox_mode: Option<maka_sandbox::Mode>,
    #[arg(long, conflicts_with_all = ["resume", "retry_infra", "subjects_file"])]
    pub max_steps: Option<NonZeroU32>,
    #[arg(long, conflicts_with_all = ["resume", "retry_infra", "subjects_file"])]
    pub timeout_ms: Option<NonZeroU64>,
    #[arg(long = "verifier-env", value_name = "KEY[=${HOST_VAR}]", conflicts_with_all = ["resume", "retry_infra"])]
    pub verifier_env: Vec<String>,
    #[arg(long, default_value = "1", conflicts_with_all = ["resume", "retry_infra"])]
    pub repeats: NonZeroU32,
    #[arg(long, default_value = "1")]
    pub concurrency: NonZeroUsize,
    #[arg(long, default_value = "harbor")]
    pub harbor_bin: String,
    #[arg(long)]
    pub force_build: bool,
    /// Resume an existing batch directory by running pending cells only.
    #[arg(long)]
    pub resume: bool,
    /// Resume and re-run infra-failed cells (never resamples scored cells).
    #[arg(long)]
    pub retry_infra: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlannedTask {
    name: String,
    path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlannedSubject {
    id: String,
    #[serde(flatten)]
    config: SubjectConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchPlan {
    tasks: Vec<PlannedTask>,
    subjects: Vec<PlannedSubject>,
    repeats: NonZeroU32,
    #[serde(default)]
    verifier_env: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CellRecord {
    task: String,
    subject: String,
    repeat: u32,
    attempt: u32,
    wall_duration_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    transcript_path: Option<String>,
    outcome: TrialOutcome,
}

struct ScheduledCell {
    slot_idx: usize,
    task_idx: usize,
    subject_idx: usize,
    repeat: u32,
    attempt: u32,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct SubjectSummary {
    subject: String,
    total_trials: usize,
    scored_trials: usize,
    infra_failed_trials: usize,
    pending_trials: usize,
    mean_reward: Option<f64>,
    total_steps: u64,
    total_model_calls: u64,
    total_tool_calls: u64,
    known_input_tokens: u64,
    known_cache_tokens: u64,
    known_output_tokens: u64,
    known_cost_usd: f64,
    complete_cost_usd: Option<f64>,
    unpriced_trials: usize,
    lower_bound_trials: usize,
    mean_wall_duration_ms: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchSummary<'a> {
    plan: &'a BatchPlan,
    subjects: Vec<SubjectSummary>,
    trials: Vec<&'a CellRecord>,
}

const BATCH_LOCK_FILE: &str = ".batch.lock";

fn acquire_batch_lock(out_dir: &Path) -> Result<std::fs::File, String> {
    let lock_path = out_dir.join(BATCH_LOCK_FILE);
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|e| format!("failed to open {}: {e}", lock_path.display()))?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(std::fs::TryLockError::WouldBlock) => Err(format!(
            "batch output directory {} is locked by another running maka-eval batch process",
            out_dir.display()
        )),
        Err(std::fs::TryLockError::Error(e)) => {
            Err(format!("failed to lock {}: {e}", lock_path.display()))
        }
    }
}

fn check_fresh_out_dir(out_dir: &Path) -> Result<(), String> {
    if out_dir.join("plan.json").exists() {
        return Err(format!(
            "batch output directory {} already contains plan.json; pass --resume or --retry-infra to continue",
            out_dir.display()
        ));
    }
    if !out_dir.exists() {
        return Ok(());
    }
    let not_fresh = || {
        format!(
            "batch output directory {} is not empty (or not a directory); choose a fresh --out directory",
            out_dir.display()
        )
    };
    if !out_dir.is_dir() {
        return Err(not_fresh());
    }
    for entry in std::fs::read_dir(out_dir)
        .map_err(|e| format!("failed to read {}: {e}", out_dir.display()))?
    {
        let entry = entry.map_err(|e| format!("failed to read {}: {e}", out_dir.display()))?;
        if entry.file_name() != OsStr::new(BATCH_LOCK_FILE) {
            return Err(not_fresh());
        }
    }
    Ok(())
}

pub(crate) fn run_batch(opts: BatchCliOptions) -> Result<(), String> {
    let resume_mode = opts.resume || opts.retry_infra;
    let (mut plan, out_dir, _batch_lock) = if resume_mode {
        let missing_plan = || {
            format!(
                "cannot resume: missing plan.json in {}",
                opts.out_dir.display()
            )
        };
        if !opts.out_dir.join("plan.json").exists() && !opts.out_dir.join(BATCH_LOCK_FILE).exists()
        {
            return Err(missing_plan());
        }
        let out_dir = std::fs::canonicalize(&opts.out_dir)
            .map_err(|e| format!("failed to canonicalize out dir: {e}"))?;
        let lock = acquire_batch_lock(&out_dir)?;
        let plan_path = out_dir.join("plan.json");
        let raw = std::fs::read_to_string(&plan_path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                missing_plan()
            } else {
                format!("failed to read {}: {e}", plan_path.display())
            }
        })?;
        let saved: BatchPlan = serde_json::from_str(&raw)
            .map_err(|e| format!("invalid {}: {e}", plan_path.display()))?;
        (saved, out_dir, lock)
    } else {
        check_fresh_out_dir(&opts.out_dir)?;
        let mut plan = BatchPlan {
            tasks: resolve_tasks(&opts.tasks, &opts.tasks_dir)?,
            subjects: resolve_subjects(&opts)?,
            repeats: opts.repeats,
            verifier_env: opts.verifier_env.clone(),
        };
        preflight(&mut plan, None)?;

        std::fs::create_dir_all(&opts.out_dir)
            .map_err(|e| format!("failed to create out dir {}: {e}", opts.out_dir.display()))?;
        let out_dir = std::fs::canonicalize(&opts.out_dir)
            .map_err(|e| format!("failed to canonicalize out dir: {e}"))?;
        let lock = acquire_batch_lock(&out_dir)?;
        check_fresh_out_dir(&out_dir)?;
        write_json_atomic(&out_dir.join("plan.json"), &plan, "plan")?;
        (plan, out_dir, lock)
    };

    let total_slots = plan.tasks.len() * plan.subjects.len() * plan.repeats.get() as usize;
    let mut slots: Vec<Option<CellRecord>> = Vec::with_capacity(total_slots);
    let mut scheduled = Vec::new();

    for (task_idx, task) in plan.tasks.iter().enumerate() {
        for repeat in 1..=plan.repeats.get() {
            for (subject_idx, subject) in plan.subjects.iter().enumerate() {
                let cell_path =
                    cell_dir(&out_dir, &task.name, &subject.id, repeat).join("cell.json");
                let existing = match std::fs::read_to_string(&cell_path) {
                    Ok(raw) => Some(serde_json::from_str::<CellRecord>(&raw).map_err(|e| {
                        format!("corrupt cell record {}: {e}", cell_path.display())
                    })?),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                    Err(e) => return Err(format!("failed to read {}: {e}", cell_path.display())),
                };
                let should_run = match &existing {
                    None => true,
                    Some(r) => {
                        opts.retry_infra && matches!(r.outcome, TrialOutcome::InfraFailed { .. })
                    }
                };
                if should_run {
                    scheduled.push(ScheduledCell {
                        slot_idx: slots.len(),
                        task_idx,
                        subject_idx,
                        repeat,
                        attempt: existing.as_ref().map_or(1, |r| r.attempt + 1),
                    });
                }
                slots.push(existing);
            }
        }
    }

    if !scheduled.is_empty() && resume_mode {
        preflight(&mut plan, Some(&scheduled))?;
    }

    let total_scheduled = scheduled.len();
    let storage_error = Mutex::new(Option::<String>::None);
    if total_scheduled > 0 {
        eprintln!(
            "maka-eval batch: running {total_scheduled} trial(s) (total matrix {total_slots}, concurrency {})",
            opts.concurrency.get()
        );
        let queue = Mutex::new(scheduled.into_iter());
        let slots_lock = Mutex::new(&mut slots);
        let stop = AtomicBool::new(false);
        let completed = AtomicUsize::new(0);
        let workers = opts.concurrency.get().min(total_scheduled);

        std::thread::scope(|scope| {
            for _ in 0..workers {
                scope.spawn(|| {
                    while !stop.load(Ordering::Relaxed) {
                        let Some(cell) = queue.lock().unwrap().next() else { break };
                        let slot_idx = cell.slot_idx;
                        match execute_cell(&out_dir, &opts.harbor_bin, opts.force_build, &plan, cell) {
                            Ok(record) => {
                                let done = completed.fetch_add(1, Ordering::Relaxed) + 1;
                                let status = match &record.outcome {
                                    TrialOutcome::Scored { reward, .. } => format!("scored (reward={reward})"),
                                    TrialOutcome::InfraFailed { .. } => "infra_failed".to_owned(),
                                };
                                eprintln!(
                                    "[{done}/{total_scheduled}] {} / {} r{} (attempt {}) -> {status} ({} ms)",
                                    record.task, record.subject, record.repeat, record.attempt, record.wall_duration_ms
                                );
                                slots_lock.lock().unwrap()[slot_idx] = Some(record);
                            }
                            Err(err) => {
                                eprintln!("error persisting cell result: {err}");
                                stop.store(true, Ordering::Relaxed);
                                let mut guard = storage_error.lock().unwrap();
                                if guard.is_none() {
                                    *guard = Some(err);
                                }
                                break;
                            }
                        }
                    }
                });
            }
        });
    }

    let (summary, paired_csv) = build_reports(&plan, &slots);
    write_json_atomic(&out_dir.join("summary.json"), &summary, "batch summary")?;
    if let Some(csv) = &paired_csv {
        write_atomic(&out_dir.join("paired.csv"), csv.as_bytes())?;
    }

    if let Some(err) = storage_error.into_inner().unwrap() {
        return Err(err);
    }
    let pending: usize = summary.subjects.iter().map(|s| s.pending_trials).sum();
    if pending > 0 {
        return Err(format!(
            "batch has {pending} pending trial(s) remaining; re-run with --resume"
        ));
    }
    let infra_failed: usize = summary.subjects.iter().map(|s| s.infra_failed_trials).sum();
    if infra_failed > 0 {
        let scored: usize = summary.subjects.iter().map(|s| s.scored_trials).sum();
        return Err(format!(
            "batch finished with {infra_failed} infra-failed trial(s) ({scored} scored / {total_slots} total); re-run with --retry-infra"
        ));
    }
    Ok(())
}

fn execute_cell(
    out_dir: &Path,
    harbor_bin: &str,
    force_build: bool,
    plan: &BatchPlan,
    cell: ScheduledCell,
) -> Result<CellRecord, String> {
    let task = &plan.tasks[cell.task_idx];
    let subject = &plan.subjects[cell.subject_idx];
    let c_dir = cell_dir(out_dir, &task.name, &subject.id, cell.repeat);
    std::fs::create_dir_all(&c_dir)
        .map_err(|e| format!("failed to create {}: {e}", c_dir.display()))?;
    let log_prefix = format!("harbor-attempt-{}", cell.attempt);
    let wall_timer = std::time::Instant::now();
    let run_opts = HarborRunOptions {
        task_path: task.path.clone(),
        out_dir: c_dir.clone(),
        harbor_bin: harbor_bin.to_owned(),
        force_build,
        subject: subject.config.clone(),
        verifier_env: plan.verifier_env.clone(),
    };

    let (wall_duration_ms, transcript_path, outcome) = match run_trial(&run_opts, Some(&log_prefix))
    {
        Ok(harbor_outcome) => {
            let outcome = harbor_outcome.settle_outcome();
            let transcript = harbor_outcome.transcript_path.as_deref().map(|p| {
                p.strip_prefix(out_dir)
                    .unwrap_or(p)
                    .to_string_lossy()
                    .replace('\\', "/")
            });
            (harbor_outcome.wall_duration_ms, transcript, outcome)
        }
        Err(error) => (
            u64::try_from(wall_timer.elapsed().as_millis()).unwrap_or(u64::MAX),
            None,
            TrialOutcome::InfraFailed { error },
        ),
    };

    let record = CellRecord {
        task: task.name.clone(),
        subject: subject.id.clone(),
        repeat: cell.repeat,
        attempt: cell.attempt,
        wall_duration_ms,
        transcript_path,
        outcome,
    };
    write_json_atomic(&c_dir.join("cell.json"), &record, "cell record")?;
    Ok(record)
}

fn resolve_tasks(
    task_paths: &[PathBuf],
    tasks_dirs: &[PathBuf],
) -> Result<Vec<PlannedTask>, String> {
    let mut raw_paths = Vec::new();
    for dir in tasks_dirs {
        let mut discovered = Vec::new();
        for entry in std::fs::read_dir(dir)
            .map_err(|e| format!("failed to read --tasks-dir {}: {e}", dir.display()))?
        {
            let entry = entry.map_err(|e| format!("failed reading {}: {e}", dir.display()))?;
            let path = entry.path();
            if path.is_dir() && path.join("task.toml").is_file() {
                discovered.push((entry.file_name(), path));
            }
        }
        discovered.sort_by(|a, b| a.0.cmp(&b.0));
        if discovered.is_empty() {
            return Err(format!(
                "--tasks-dir {} contains no task subdirectories with task.toml",
                dir.display()
            ));
        }
        raw_paths.extend(discovered.into_iter().map(|(_, path)| path));
    }
    raw_paths.extend(task_paths.iter().cloned());
    if raw_paths.is_empty() {
        return Err("no tasks specified; pass --task or --tasks-dir".into());
    }

    let mut seen_paths = BTreeSet::new();
    let mut seen_names = BTreeMap::<String, PathBuf>::new();
    let mut tasks = Vec::new();
    for raw in raw_paths {
        let canonical = std::fs::canonicalize(&raw)
            .map_err(|e| format!("failed to resolve task path {}: {e}", raw.display()))?;
        if !seen_paths.insert(canonical.clone()) {
            continue;
        }
        let name = canonical
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("task path has non-UTF-8 name: {}", canonical.display()))?
            .to_owned();
        validate_safe_segment("task name", &name)?;
        if let Some(prev) = seen_names.insert(name.to_ascii_lowercase(), canonical.clone()) {
            return Err(format!(
                "duplicate task name '{name}' for {} and {}",
                prev.display(),
                canonical.display()
            ));
        }
        tasks.push(PlannedTask {
            name,
            path: canonical,
        });
    }
    Ok(tasks)
}

fn resolve_subjects(opts: &BatchCliOptions) -> Result<Vec<PlannedSubject>, String> {
    let subjects = match &opts.subjects_file {
        None => vec![PlannedSubject {
            id: "default".into(),
            config: SubjectConfig {
                bundle_dir: opts
                    .bundle_dir
                    .clone()
                    .ok_or("missing --bundle-dir (or --subjects-file)")?,
                provider: opts
                    .provider
                    .clone()
                    .ok_or("missing --provider (or --subjects-file)")?,
                model_id: opts
                    .model_id
                    .clone()
                    .ok_or("missing --model (or --subjects-file)")?,
                api_key_env: opts
                    .api_key_env
                    .clone()
                    .ok_or("missing --api-key-env (or --subjects-file)")?,
                base_url: opts.base_url.clone(),
                thinking_level: opts.thinking_level,
                sandbox_mode: opts
                    .sandbox_mode
                    .unwrap_or(maka_sandbox::Mode::DangerFullAccess),
                max_steps: opts.max_steps,
                timeout_ms: opts.timeout_ms,
            },
        }],
        Some(path) => {
            let raw = std::fs::read_to_string(path)
                .map_err(|e| format!("failed to read --subjects-file {}: {e}", path.display()))?;
            let subjects: Vec<PlannedSubject> = serde_json::from_str(&raw)
                .map_err(|e| format!("invalid --subjects-file {}: {e}", path.display()))?;
            if subjects.is_empty() {
                return Err(format!(
                    "--subjects-file {} must contain at least one subject",
                    path.display()
                ));
            }
            subjects
        }
    };

    let mut seen_ids = BTreeSet::new();
    for subject in &subjects {
        validate_safe_segment("subject id", &subject.id)?;
        if !seen_ids.insert(subject.id.to_ascii_lowercase()) {
            return Err(format!("duplicate subject id '{}'", subject.id));
        }
    }
    Ok(subjects)
}

fn preflight(plan: &mut BatchPlan, scheduled: Option<&[ScheduledCell]>) -> Result<(), String> {
    let mut subject_indices = BTreeSet::new();
    let mut task_needs_native_timeout = BTreeMap::<usize, bool>::new();
    match scheduled {
        None => {
            subject_indices.extend(0..plan.subjects.len());
            let any_native = plan.subjects.iter().any(|s| s.config.timeout_ms.is_none());
            for task_idx in 0..plan.tasks.len() {
                task_needs_native_timeout.insert(task_idx, any_native);
            }
        }
        Some(cells) => {
            for cell in cells {
                subject_indices.insert(cell.subject_idx);
                *task_needs_native_timeout
                    .entry(cell.task_idx)
                    .or_insert(false) |=
                    plan.subjects[cell.subject_idx].config.timeout_ms.is_none();
            }
        }
    }
    for idx in subject_indices {
        let subject = &mut plan.subjects[idx];
        validate_subject(&mut subject.config)
            .map_err(|e| format!("subject '{}': {e}", subject.id))?;
    }
    for (task_idx, needs_native) in task_needs_native_timeout {
        let task_toml = plan.tasks[task_idx].path.join("task.toml");
        if !task_toml.is_file() {
            return Err(format!(
                "task directory missing task.toml: {}",
                plan.tasks[task_idx].path.display()
            ));
        }
        read_task_timeout_ms(&task_toml, (!needs_native).then_some(NonZeroU64::MIN))?;
    }
    validate_verifier_env(&plan.verifier_env)
}

fn validate_safe_segment(label: &str, value: &str) -> Result<(), String> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err(format!(
            "invalid {label} '{value}': expected non-empty ASCII [A-Za-z0-9._-] segment"
        ));
    }
    Ok(())
}

fn cell_dir(out_dir: &Path, task: &str, subject: &str, repeat: u32) -> PathBuf {
    out_dir
        .join("cells")
        .join(task)
        .join(subject)
        .join(format!("r{repeat}"))
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T, label: &str) -> Result<(), String> {
    let encoded = serde_json::to_string_pretty(value)
        .map_err(|e| format!("failed to serialize {label}: {e}"))?;
    write_atomic(path, format!("{encoded}\n").as_bytes())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("artifact");
    let tmp_path = parent.join(format!(".{name}.tmp.{}", Uuid::new_v4()));
    if let Err(err) = std::fs::write(&tmp_path, bytes) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("failed to write {}: {err}", tmp_path.display()));
    }
    if let Err(err) = std::fs::rename(&tmp_path, path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!(
            "failed to commit {} -> {}: {err}",
            tmp_path.display(),
            path.display()
        ));
    }
    Ok(())
}

fn build_reports<'a>(
    plan: &'a BatchPlan,
    slots: &'a [Option<CellRecord>],
) -> (BatchSummary<'a>, Option<String>) {
    let n_subjects = plan.subjects.len();
    let subjects = plan
        .subjects
        .iter()
        .enumerate()
        .map(|(i, s)| summarize_subject(i, &s.id, n_subjects, slots))
        .collect();
    let summary = BatchSummary {
        plan,
        subjects,
        trials: slots.iter().flatten().collect(),
    };
    let paired_csv = (n_subjects >= 2).then(|| render_paired_csv(plan, slots));
    (summary, paired_csv)
}

fn summarize_subject(
    subject_idx: usize,
    subject_id: &str,
    num_subjects: usize,
    slots: &[Option<CellRecord>],
) -> SubjectSummary {
    let mut summary = SubjectSummary {
        subject: subject_id.to_owned(),
        ..Default::default()
    };
    let (mut reward_sum, mut total_wall_duration_ms) = (0.0_f64, 0_u64);

    for slot in slots.iter().skip(subject_idx).step_by(num_subjects) {
        summary.total_trials += 1;
        let Some(record) = slot else {
            summary.pending_trials += 1;
            continue;
        };
        match &record.outcome {
            TrialOutcome::Scored {
                reward,
                steps_observed,
                settlement,
                models,
                tools,
                ..
            } => {
                summary.scored_trials += 1;
                reward_sum += *reward;
                total_wall_duration_ms =
                    total_wall_duration_ms.saturating_add(record.wall_duration_ms);
                summary.total_steps = summary
                    .total_steps
                    .saturating_add(u64::from(*steps_observed));
                summary.total_model_calls = summary.total_model_calls.saturating_add(models.calls);
                summary.total_tool_calls = summary.total_tool_calls.saturating_add(tools.calls);
                summary.known_input_tokens = summary
                    .known_input_tokens
                    .saturating_add(models.input.known);
                summary.known_cache_tokens = summary
                    .known_cache_tokens
                    .saturating_add(models.cache_read.known);
                summary.known_output_tokens = summary
                    .known_output_tokens
                    .saturating_add(models.output.known);
                summary.known_cost_usd += models.cost.known_usd;
                match settlement.metering {
                    Metering::Complete { cost_usd: Some(_) } => {}
                    Metering::Complete { cost_usd: None } => summary.unpriced_trials += 1,
                    Metering::LowerBound => summary.lower_bound_trials += 1,
                }
            }
            TrialOutcome::InfraFailed { .. } => summary.infra_failed_trials += 1,
        }
    }

    if summary.scored_trials > 0 {
        let n = summary.scored_trials as f64;
        summary.mean_reward = Some(reward_sum / n);
        summary.mean_wall_duration_ms = Some(total_wall_duration_ms as f64 / n);
        if summary.unpriced_trials == 0 && summary.lower_bound_trials == 0 {
            summary.complete_cost_usd = Some(summary.known_cost_usd);
        }
    }
    summary
}

fn paired_side(
    record: Option<&CellRecord>,
) -> (&'static str, Option<f64>, Option<f64>, Option<u64>) {
    let Some(record) = record else {
        return ("pending", None, None, None);
    };
    match &record.outcome {
        TrialOutcome::Scored {
            reward, settlement, ..
        } => {
            let cost = match settlement.metering {
                Metering::Complete { cost_usd } => cost_usd,
                Metering::LowerBound => None,
            };
            ("scored", Some(*reward), cost, Some(record.wall_duration_ms))
        }
        TrialOutcome::InfraFailed { .. } => {
            ("infra_failed", None, None, Some(record.wall_duration_ms))
        }
    }
}

fn opt_str<T: ToString>(value: Option<T>) -> String {
    value.map_or_else(String::new, |v| v.to_string())
}

fn render_paired_csv(plan: &BatchPlan, slots: &[Option<CellRecord>]) -> String {
    let mut out = String::from(
        "baseline,candidate,task,repeat,outcome,baseline_status,candidate_status,baseline_reward,candidate_reward,baseline_cost_usd,candidate_cost_usd,baseline_wall_ms,candidate_wall_ms\n",
    );
    let n_subjects = plan.subjects.len();
    let repeats = plan.repeats.get() as usize;
    for (i, base_sub) in plan.subjects.iter().enumerate() {
        for (offset, cand_sub) in plan.subjects[i + 1..].iter().enumerate() {
            let j = i + 1 + offset;
            for (task_idx, task) in plan.tasks.iter().enumerate() {
                for repeat_idx in 0..repeats {
                    let row = &slots[(task_idx * repeats + repeat_idx) * n_subjects..];
                    let (b_st, b_rev, b_cost, b_wall) = paired_side(row[i].as_ref());
                    let (c_st, c_rev, c_cost, c_wall) = paired_side(row[j].as_ref());
                    let outcome = match (b_rev, c_rev) {
                        (Some(b), Some(c)) if c > b => "win",
                        (Some(b), Some(c)) if c < b => "loss",
                        (Some(_), Some(_)) => "tie",
                        _ => "uncomparable",
                    };
                    let _ = writeln!(
                        out,
                        "{},{},{},{},{outcome},{b_st},{c_st},{},{},{},{},{},{}",
                        base_sub.id,
                        cand_sub.id,
                        task.name,
                        repeat_idx + 1,
                        opt_str(b_rev),
                        opt_str(c_rev),
                        opt_str(b_cost),
                        opt_str(c_cost),
                        opt_str(b_wall),
                        opt_str(c_wall),
                    );
                }
            }
        }
    }
    out
}
