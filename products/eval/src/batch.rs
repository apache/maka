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
use std::fs::{File, OpenOptions, TryLockError};
use std::io::{Read, Seek, SeekFrom, Write};
use std::num::{NonZeroU32, NonZeroU64};
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::harbor::{
    EvalStatus, Metering, TrialOutcome, TrialSpec, resolve_bundle_dir, resolve_task_dir,
    run_prepared_trial, validate_harbor_bin, validate_subject_target, validate_verifier_env_map,
    write_run_summary,
};

#[derive(Debug, Clone, clap::Args)]
pub(crate) struct BatchOptions {
    #[arg(long = "spec")]
    pub spec_path: PathBuf,
    #[arg(long = "out")]
    pub out_dir: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BatchSpec {
    bundle_dir: PathBuf,
    #[serde(default = "default_harbor_bin")]
    harbor_bin: String,
    #[serde(default)]
    force_build: bool,
    #[serde(default)]
    verifier_env: BTreeMap<String, String>,
    #[serde(default = "default_one")]
    repetitions: NonZeroU32,
    #[serde(default)]
    max_retries: u32,
    #[serde(default = "default_max_steps")]
    max_steps: NonZeroU32,
    #[serde(default = "default_timeout_ms")]
    timeout_ms: NonZeroU64,
    subjects: Vec<SubjectSpec>,
    tasks: Vec<PathBuf>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SubjectSpec {
    id: String,
    provider: String,
    model_id: String,
    api_key_env: String,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default = "default_sandbox_mode")]
    sandbox_mode: maka_sandbox::Mode,
}

fn default_harbor_bin() -> String {
    "harbor".to_owned()
}
fn default_one() -> NonZeroU32 {
    NonZeroU32::MIN
}
fn default_max_steps() -> NonZeroU32 {
    NonZeroU32::new(64).expect("non-zero")
}
fn default_timeout_ms() -> NonZeroU64 {
    NonZeroU64::new(600_000).expect("non-zero")
}
fn default_sandbox_mode() -> maka_sandbox::Mode {
    maka_sandbox::Mode::DangerFullAccess
}

struct PreparedBatch {
    spec: BatchSpec,
    bundle_dir: PathBuf,
    harbor_bin: String,
    max_attempts: NonZeroU32,
    tasks: Vec<(String, PathBuf)>,
}

struct Cell<'a> {
    id: String,
    dir_slug: String,
    task_path: &'a Path,
    subject: &'a SubjectSpec,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AttemptRecord {
    cell_id: String,
    sequence: NonZeroU32,
    duration_ms: u64,
    status: EvalStatus,
    score: Option<f64>,
    metering: Option<Metering>,
    cost_usd: Option<f64>,
    failure_reason: Option<String>,
    summary_path: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CellSummary {
    cell_id: String,
    attempts: usize,
    selected_sequence: Option<NonZeroU32>,
    status: EvalStatus,
    score: Option<f64>,
    metering: Option<Metering>,
    cost_usd: Option<f64>,
    duration_ms: Option<u64>,
    failure_reason: Option<String>,
    summary_path: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchSummary {
    attempts_recorded: usize,
    selected: usize,
    blocked: usize,
    exhausted: usize,
    cells: Vec<CellSummary>,
}

pub(crate) fn run_batch(opts: &BatchOptions) -> Result<(), String> {
    let raw_spec = std::fs::read_to_string(&opts.spec_path)
        .map_err(|e| format!("failed to read spec {}: {e}", opts.spec_path.display()))?;
    let spec: BatchSpec = serde_json::from_str(&raw_spec)
        .map_err(|e| format!("invalid batch spec {}: {e}", opts.spec_path.display()))?;
    let prepared = prepare_batch(&opts.spec_path, spec)?;

    std::fs::create_dir_all(&opts.out_dir)
        .map_err(|e| format!("failed to create out dir {}: {e}", opts.out_dir.display()))?;
    let out_dir = std::fs::canonicalize(&opts.out_dir)
        .map_err(|e| format!("failed to canonicalize out dir: {e}"))?;

    let mut store = AttemptLog::open_exclusive(&out_dir.join("attempts.jsonl"))?;
    let cells = expand_cells(&prepared);

    for cell in &cells {
        while can_admit_attempt(store.for_cell(&cell.id), prepared.max_attempts) {
            let seq = NonZeroU32::new(store.for_cell(&cell.id).len() as u32 + 1)
                .expect("admitted attempt count is < u32::MAX");
            let attempt_dir = out_dir
                .join("trials")
                .join(&cell.dir_slug)
                .join(format!("attempt-{seq}"));
            if attempt_dir.exists() {
                std::fs::remove_dir_all(&attempt_dir).map_err(|e| {
                    format!(
                        "failed to clean stale attempt dir {}: {e}",
                        attempt_dir.display()
                    )
                })?;
            }
            let record = execute_attempt(&prepared, cell, seq, &attempt_dir)?;
            store.append(record)?;
        }
    }

    let summary = build_summary(&cells, &store);
    let summary_path = out_dir.join("summary.json");
    let encoded = serde_json::to_string_pretty(&summary).map_err(|e| e.to_string())?;
    let tmp_path = out_dir.join(".summary.json.tmp");
    std::fs::write(&tmp_path, format!("{encoded}\n"))
        .map_err(|e| format!("failed to write {}: {e}", tmp_path.display()))?;
    std::fs::rename(&tmp_path, &summary_path)
        .map_err(|e| format!("failed to replace {}: {e}", summary_path.display()))?;
    println!("{encoded}");

    let incomplete = summary.cells.len() - summary.selected;
    if incomplete > 0 {
        return Err(format!(
            "batch finished with {incomplete} incomplete cell(s) ({} blocked, {} exhausted)",
            summary.blocked, summary.exhausted
        ));
    }
    Ok(())
}

fn validate_id(raw: &str, label: &str) -> Result<(), String> {
    if raw.trim().is_empty()
        || raw == "."
        || raw.contains("..")
        || raw.contains("::")
        || raw.contains("__")
        || raw
            .chars()
            .any(|c| matches!(c, '/' | '\\' | '\0') || c.is_control())
    {
        return Err(format!(
            "invalid {label} '{raw}': cannot be empty or contain path/delimiter tokens"
        ));
    }
    Ok(())
}

fn prepare_batch(spec_path: &Path, spec: BatchSpec) -> Result<PreparedBatch, String> {
    let base_dir = spec_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let max_attempts = spec
        .max_retries
        .checked_add(1)
        .and_then(NonZeroU32::new)
        .ok_or("maxRetries overflowed u32")?;

    let bundle_dir = resolve_bundle_dir(&resolve_path(base_dir, &spec.bundle_dir))?;
    validate_harbor_bin(&spec.harbor_bin)?;
    let harbor_bin =
        if spec.harbor_bin.contains('/') || spec.harbor_bin.contains(std::path::MAIN_SEPARATOR) {
            resolve_path(base_dir, Path::new(&spec.harbor_bin))
                .to_string_lossy()
                .into_owned()
        } else {
            spec.harbor_bin.clone()
        };
    validate_verifier_env_map(&spec.verifier_env)?;

    if spec.subjects.is_empty() {
        return Err("subjects cannot be empty".into());
    }
    let mut subject_ids = BTreeSet::new();
    for subject in &spec.subjects {
        validate_id(&subject.id, "subject id")?;
        if !subject_ids.insert(subject.id.as_str()) {
            return Err(format!("duplicate subject id '{}'", subject.id));
        }
        validate_subject_target(
            Some(&subject.id),
            &subject.provider,
            &subject.model_id,
            &subject.api_key_env,
            subject.base_url.as_deref(),
        )?;
    }

    if spec.tasks.is_empty() {
        return Err("tasks cannot be empty".into());
    }
    let mut task_ids = BTreeSet::new();
    let mut tasks = Vec::with_capacity(spec.tasks.len());
    for raw_task in &spec.tasks {
        let path = resolve_task_dir(&resolve_path(base_dir, raw_task))?;
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("task path has non-UTF-8 directory name: {}", path.display()))?
            .to_owned();
        validate_id(&name, "task directory name")?;
        if !task_ids.insert(name.clone()) {
            return Err(format!("duplicate task name '{name}'"));
        }
        tasks.push((name, path));
    }

    Ok(PreparedBatch {
        spec,
        bundle_dir,
        harbor_bin,
        max_attempts,
        tasks,
    })
}

fn resolve_path(base_dir: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        base_dir.join(path)
    }
}

fn expand_cells(prepared: &PreparedBatch) -> Vec<Cell<'_>> {
    let cap = prepared.tasks.len()
        * prepared.spec.repetitions.get() as usize
        * prepared.spec.subjects.len();
    let mut cells = Vec::with_capacity(cap);
    for (task_id, task_path) in &prepared.tasks {
        for repetition in 1..=prepared.spec.repetitions.get() {
            for subject in &prepared.spec.subjects {
                cells.push(Cell {
                    id: format!("{task_id}::{repetition}::{}", subject.id),
                    dir_slug: format!("{task_id}__{repetition}__{}", subject.id),
                    task_path,
                    subject,
                });
            }
        }
    }
    cells
}

fn execute_attempt(
    prepared: &PreparedBatch,
    cell: &Cell<'_>,
    sequence: NonZeroU32,
    attempt_dir: &Path,
) -> Result<AttemptRecord, String> {
    let trial_spec = TrialSpec {
        task_path: cell.task_path,
        bundle_dir: &prepared.bundle_dir,
        out_dir: attempt_dir,
        harbor_bin: &prepared.harbor_bin,
        force_build: prepared.spec.force_build,
        base_url: cell.subject.base_url.as_deref(),
        api_key_env: &cell.subject.api_key_env,
        provider: &cell.subject.provider,
        model_id: &cell.subject.model_id,
        sandbox_mode: cell.subject.sandbox_mode,
        max_steps: prepared.spec.max_steps,
        timeout_ms: prepared.spec.timeout_ms,
        verifier_env: &prepared.spec.verifier_env,
    };

    let started = Instant::now();
    let (summary, outcome) = run_prepared_trial(&trial_spec)?.settle();
    let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let (summary_path, _) = write_run_summary(attempt_dir, &summary)?;

    let (status, score, metering, cost_usd, failure_reason) = match outcome {
        TrialOutcome::Completed { score, settlement } => {
            let (m, c) = settlement.into_parts();
            (EvalStatus::Completed, Some(score), Some(m), c, None)
        }
        TrialOutcome::SubjectFailed {
            score,
            settlement,
            reason,
        } => {
            let (m, c) = settlement.into_parts();
            (
                EvalStatus::SubjectFailed,
                Some(score),
                Some(m),
                c,
                Some(reason),
            )
        }
        TrialOutcome::InfraFailed { reason } => {
            (EvalStatus::InfraFailed, None, None, None, Some(reason))
        }
        TrialOutcome::Indeterminate { reason } => {
            (EvalStatus::Indeterminate, None, None, None, Some(reason))
        }
    };

    Ok(AttemptRecord {
        cell_id: cell.id.clone(),
        sequence,
        duration_ms,
        status,
        score,
        metering,
        cost_usd,
        failure_reason,
        summary_path,
    })
}

fn can_admit_attempt(attempts: &[AttemptRecord], max_attempts: NonZeroU32) -> bool {
    attempts.len() < max_attempts.get() as usize
        && attempts.iter().all(|a| a.status == EvalStatus::InfraFailed)
}

fn validate_attempt_record(record: &AttemptRecord) -> Result<(), String> {
    match record.status {
        EvalStatus::Completed => {
            if !record.score.is_some_and(f64::is_finite) || record.failure_reason.is_some() {
                return Err("completed attempt requires finite score and no failureReason".into());
            }
        }
        EvalStatus::SubjectFailed => {
            if !record.score.is_some_and(f64::is_finite) || record.failure_reason.is_none() {
                return Err(
                    "subject_failed attempt requires finite score and failureReason".into(),
                );
            }
        }
        EvalStatus::InfraFailed | EvalStatus::Indeterminate => {
            if record.score.is_some() || record.failure_reason.is_none() {
                return Err("non-selectable attempt requires null score and failureReason".into());
            }
        }
    }
    if let Some(cost) = record.cost_usd
        && (!cost.is_finite() || cost < 0.0 || record.metering != Some(Metering::Complete))
    {
        return Err("costUsd must be finite >= 0 with metering=complete".into());
    }
    Ok(())
}

struct AttemptLog {
    path: PathBuf,
    file: File,
    total_records: usize,
    by_cell: BTreeMap<String, Vec<AttemptRecord>>,
}

impl AttemptLog {
    fn open_exclusive(path: &Path) -> Result<Self, String> {
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(|e| format!("failed to open {}: {e}", path.display()))?;

        match file.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => {
                return Err(format!(
                    "{} is locked by another maka-eval batch process",
                    path.display()
                ));
            }
            Err(TryLockError::Error(e)) => {
                return Err(format!("failed to lock {}: {e}", path.display()));
            }
        }

        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|e| format!("failed to read {}: {e}", path.display()))?;

        let mut total_records = 0usize;
        let mut by_cell: BTreeMap<String, Vec<AttemptRecord>> = BTreeMap::new();
        if !bytes.is_empty() {
            if !bytes.ends_with(b"\n") {
                let line_no = bytes.iter().filter(|&&b| b == b'\n').count() + 1;
                return Err(format!(
                    "corrupt {}: line {line_no} is missing trailing newline",
                    path.display()
                ));
            }
            let text = std::str::from_utf8(&bytes)
                .map_err(|e| format!("corrupt {}: invalid UTF-8: {e}", path.display()))?;
            for (idx, line) in text.lines().enumerate() {
                let line_no = idx + 1;
                let record: AttemptRecord = serde_json::from_str(line)
                    .map_err(|e| format!("corrupt {} at line {line_no}: {e}", path.display()))?;
                validate_attempt_record(&record).map_err(|e| {
                    format!(
                        "invalid attempt record in {} at line {line_no}: {e}",
                        path.display()
                    )
                })?;
                let entry = by_cell.entry(record.cell_id.clone()).or_default();
                let expected = entry.len() as u32 + 1;
                if record.sequence.get() != expected {
                    return Err(format!(
                        "corrupt {} at line {line_no}: cell '{}' expected sequence {expected}, found {}",
                        path.display(),
                        record.cell_id,
                        record.sequence
                    ));
                }
                if let Some(prev_label) = entry.last().and_then(|prev| match prev.status {
                    EvalStatus::InfraFailed => None,
                    EvalStatus::Completed => Some("completed"),
                    EvalStatus::SubjectFailed => Some("subject_failed"),
                    EvalStatus::Indeterminate => Some("indeterminate"),
                }) {
                    return Err(format!(
                        "corrupt {} at line {line_no}: cell '{}' has attempt {} after terminal '{prev_label}' attempt",
                        path.display(),
                        record.cell_id,
                        record.sequence,
                    ));
                }
                entry.push(record);
                total_records += 1;
            }
        }

        file.seek(SeekFrom::End(0))
            .map_err(|e| format!("failed seeking {}: {e}", path.display()))?;

        Ok(Self {
            path: path.to_path_buf(),
            file,
            total_records,
            by_cell,
        })
    }

    fn for_cell(&self, cell_id: &str) -> &[AttemptRecord] {
        self.by_cell.get(cell_id).map_or(&[], Vec::as_slice)
    }

    fn append(&mut self, record: AttemptRecord) -> Result<(), String> {
        let mut line = serde_json::to_string(&record).map_err(|e| e.to_string())?;
        line.push('\n');
        self.file
            .write_all(line.as_bytes())
            .and_then(|()| self.file.sync_all())
            .map_err(|e| format!("failed to persist {}: {e}", self.path.display()))?;
        self.by_cell
            .entry(record.cell_id.clone())
            .or_default()
            .push(record);
        self.total_records += 1;
        Ok(())
    }
}

fn build_summary(cells: &[Cell<'_>], store: &AttemptLog) -> BatchSummary {
    let mut selected = 0usize;
    let mut blocked = 0usize;
    let mut exhausted = 0usize;
    let mut cell_summaries = Vec::with_capacity(cells.len());

    for cell in cells {
        let attempts = store.for_cell(&cell.id);
        let last = attempts.last().expect("each cell runs >= 1 attempt");
        let is_selected = match last.status {
            EvalStatus::Completed | EvalStatus::SubjectFailed => {
                selected += 1;
                true
            }
            EvalStatus::Indeterminate => {
                blocked += 1;
                false
            }
            EvalStatus::InfraFailed => {
                exhausted += 1;
                false
            }
        };
        cell_summaries.push(CellSummary {
            cell_id: cell.id.clone(),
            attempts: attempts.len(),
            selected_sequence: is_selected.then_some(last.sequence),
            status: last.status,
            score: is_selected.then_some(last.score).flatten(),
            metering: is_selected.then_some(last.metering).flatten(),
            cost_usd: is_selected.then_some(last.cost_usd).flatten(),
            duration_ms: is_selected.then_some(last.duration_ms),
            failure_reason: last.failure_reason.clone(),
            summary_path: last.summary_path.clone(),
        });
    }

    BatchSummary {
        attempts_recorded: store.total_records,
        selected,
        blocked,
        exhausted,
        cells: cell_summaries,
    }
}
