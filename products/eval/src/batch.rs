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
    DEFAULT_HARBOR_BIN, DEFAULT_MAX_STEPS, DEFAULT_SANDBOX_MODE, DEFAULT_TIMEOUT_MS,
    HarborRunOptions, TrialOutcome, UsageSettlement, prepend_search_path, resolve_bundle_dir,
    resolve_task_dir, run_and_settle, validate_env_entry, validate_subject_target,
    write_run_summary,
};

const RESULTS_FILE: &str = "results.jsonl";

#[derive(Debug, Clone, clap::Args)]
pub(crate) struct BatchOptions {
    #[arg(long = "spec")]
    pub spec_path: PathBuf,
    #[arg(long = "out")]
    pub out_dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
    #[serde(default = "default_max_steps")]
    max_steps: NonZeroU32,
    #[serde(default = "default_timeout_ms")]
    timeout_ms: NonZeroU64,
    subjects: Vec<SubjectSpec>,
    tasks: Vec<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
    DEFAULT_HARBOR_BIN.to_owned()
}
fn default_one() -> NonZeroU32 {
    NonZeroU32::MIN
}
fn default_max_steps() -> NonZeroU32 {
    DEFAULT_MAX_STEPS
}
fn default_timeout_ms() -> NonZeroU64 {
    DEFAULT_TIMEOUT_MS
}
fn default_sandbox_mode() -> maka_sandbox::Mode {
    DEFAULT_SANDBOX_MODE
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum CellStatus {
    Completed,
    SubjectFailed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Metering {
    Complete,
    LowerBound,
}

// Keep enums externally tagged so serde_json/arbitrary_precision preserves f64 values.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum CellOutcome {
    Completed {
        score: f64,
        metering: Metering,
        cost_usd: Option<f64>,
        duration_ms: u64,
        summary_path: PathBuf,
    },
    SubjectFailed {
        score: f64,
        metering: Metering,
        cost_usd: Option<f64>,
        duration_ms: u64,
        failure_reason: String,
        summary_path: PathBuf,
    },
    Failed {
        failure_reason: String,
        duration_ms: Option<u64>,
        summary_path: Option<PathBuf>,
    },
}

impl CellOutcome {
    fn from_trial(outcome: TrialOutcome, duration_ms: u64, summary_path: PathBuf) -> Self {
        let settle = |s: UsageSettlement| match s {
            UsageSettlement::Complete { cost_usd } => (Metering::Complete, cost_usd),
            UsageSettlement::LowerBound => (Metering::LowerBound, None),
        };
        match outcome {
            TrialOutcome::Completed { score, settlement } => {
                let (metering, cost_usd) = settle(settlement);
                Self::Completed {
                    score,
                    metering,
                    cost_usd,
                    duration_ms,
                    summary_path,
                }
            }
            TrialOutcome::SubjectFailed {
                score,
                settlement,
                reason,
            } => {
                let (metering, cost_usd) = settle(settlement);
                Self::SubjectFailed {
                    score,
                    metering,
                    cost_usd,
                    duration_ms,
                    failure_reason: reason,
                    summary_path,
                }
            }
            TrialOutcome::Failed { reason } => Self::Failed {
                failure_reason: reason,
                duration_ms: Some(duration_ms),
                summary_path: Some(summary_path),
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum JournalEvent {
    Started {
        cell_id: String,
    },
    Settled {
        cell_id: String,
        outcome: CellOutcome,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CellSummary {
    cell_id: String,
    status: CellStatus,
    score: Option<f64>,
    metering: Option<Metering>,
    cost_usd: Option<f64>,
    duration_ms: Option<u64>,
    failure_reason: Option<String>,
    summary_path: Option<PathBuf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchSummary {
    completed: usize,
    subject_failed: usize,
    failed: usize,
    cells: Vec<CellSummary>,
}

pub(crate) fn run_batch(opts: &BatchOptions) -> Result<(), String> {
    let raw_spec = std::fs::read_to_string(&opts.spec_path)
        .map_err(|e| format!("failed to read spec {}: {e}", opts.spec_path.display()))?;
    let spec: BatchSpec = serde_json::from_str(&raw_spec)
        .map_err(|e| format!("invalid batch spec {}: {e}", opts.spec_path.display()))?;
    let (frozen, cell_cap) = freeze_spec(&opts.spec_path, spec)?;

    prepend_search_path(&opts.out_dir, std::env::var_os("PYTHONPATH").as_deref())?;

    std::fs::create_dir_all(&opts.out_dir)
        .map_err(|e| format!("failed to create out dir {}: {e}", opts.out_dir.display()))?;
    let out_dir = std::fs::canonicalize(&opts.out_dir)
        .map_err(|e| format!("failed to canonicalize out dir: {e}"))?;

    let results_path = out_dir.join(RESULTS_FILE);
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&results_path)
        .map_err(|e| format!("failed to open {}: {e}", results_path.display()))?;
    match file.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => {
            return Err(format!(
                "{} is locked by another maka-eval batch process",
                results_path.display()
            ));
        }
        Err(TryLockError::Error(e)) => {
            return Err(format!("failed to lock {}: {e}", results_path.display()));
        }
    }

    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("failed to read {}: {e}", results_path.display()))?;
    verify_or_write_experiment(&out_dir, &frozen, !bytes.is_empty())?;

    let mut cells = Vec::with_capacity(cell_cap);
    for task_path in &frozen.tasks {
        let task_id = task_path
            .file_name()
            .and_then(|n| n.to_str())
            .expect("validated task dir name");
        for rep in 1..=frozen.repetitions.get() {
            for subject in &frozen.subjects {
                let id = format!("{task_id}::{rep}::{}", subject.id);
                cells.push((cells.len(), id, task_path.as_path(), subject));
            }
        }
    }
    let valid_ids: BTreeSet<&str> = cells.iter().map(|(_, id, _, _)| id.as_str()).collect();
    let (mut by_cell, pending) = load_journal(&results_path, &bytes, &valid_ids)?;
    file.seek(SeekFrom::End(0))
        .map_err(|e| format!("failed seeking {}: {e}", results_path.display()))?;

    if let Some(interrupted_id) = pending {
        let (index, ..) = cells
            .iter()
            .find(|(_, id, _, _)| id == &interrupted_id)
            .expect("pending cell is in valid_ids");
        let cell_dir = out_dir.join("trials").join(format!("cell-{index}"));
        let outcome = CellOutcome::Failed {
            failure_reason: format!(
                "cell '{interrupted_id}' interrupted before settlement; preserved {}",
                cell_dir.display()
            ),
            duration_ms: None,
            summary_path: None,
        };
        append_event(
            &mut file,
            &results_path,
            &JournalEvent::Settled {
                cell_id: interrupted_id.clone(),
                outcome: outcome.clone(),
            },
        )?;
        by_cell.insert(interrupted_id, outcome);
    }

    let verifier_env: Vec<(String, String)> = frozen
        .verifier_env
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    for (index, cell_id, task_path, subject) in &cells {
        if by_cell.contains_key(cell_id) {
            continue;
        }
        let cell_dir = out_dir.join("trials").join(format!("cell-{index}"));
        prepare_cell_dir(&cell_dir, cell_id)?;
        append_event(
            &mut file,
            &results_path,
            &JournalEvent::Started {
                cell_id: cell_id.clone(),
            },
        )?;
        let run_opts = HarborRunOptions {
            task_path: task_path.to_path_buf(),
            bundle_dir: frozen.bundle_dir.clone(),
            out_dir: cell_dir.clone(),
            harbor_bin: frozen.harbor_bin.clone(),
            force_build: frozen.force_build,
            base_url: subject.base_url.clone(),
            api_key_env: subject.api_key_env.clone(),
            provider: subject.provider.clone(),
            model_id: subject.model_id.clone(),
            sandbox_mode: subject.sandbox_mode,
            max_steps: frozen.max_steps,
            timeout_ms: frozen.timeout_ms,
            verifier_env: verifier_env.clone(),
        };
        let started = Instant::now();
        let (summary, trial_outcome) = run_and_settle(&run_opts)?;
        let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let (summary_path, _) = write_run_summary(&cell_dir, &summary)?;
        let outcome = CellOutcome::from_trial(trial_outcome, duration_ms, summary_path);
        append_event(
            &mut file,
            &results_path,
            &JournalEvent::Settled {
                cell_id: cell_id.clone(),
                outcome: outcome.clone(),
            },
        )?;
        by_cell.insert(cell_id.clone(), outcome);
    }

    let (mut completed, mut subject_failed, mut failed) = (0, 0, 0);
    let ordered: Vec<CellSummary> = cells
        .into_iter()
        .map(|(_, cell_id, _, _)| {
            match by_cell
                .remove(&cell_id)
                .expect("every cell runs and settles")
            {
                CellOutcome::Completed {
                    score,
                    metering,
                    cost_usd,
                    duration_ms,
                    summary_path,
                } => {
                    completed += 1;
                    CellSummary {
                        cell_id,
                        status: CellStatus::Completed,
                        score: Some(score),
                        metering: Some(metering),
                        cost_usd,
                        duration_ms: Some(duration_ms),
                        failure_reason: None,
                        summary_path: Some(summary_path),
                    }
                }
                CellOutcome::SubjectFailed {
                    score,
                    metering,
                    cost_usd,
                    duration_ms,
                    failure_reason,
                    summary_path,
                } => {
                    subject_failed += 1;
                    CellSummary {
                        cell_id,
                        status: CellStatus::SubjectFailed,
                        score: Some(score),
                        metering: Some(metering),
                        cost_usd,
                        duration_ms: Some(duration_ms),
                        failure_reason: Some(failure_reason),
                        summary_path: Some(summary_path),
                    }
                }
                CellOutcome::Failed {
                    failure_reason,
                    duration_ms,
                    summary_path,
                } => {
                    failed += 1;
                    CellSummary {
                        cell_id,
                        status: CellStatus::Failed,
                        score: None,
                        metering: None,
                        cost_usd: None,
                        duration_ms,
                        failure_reason: Some(failure_reason),
                        summary_path,
                    }
                }
            }
        })
        .collect();

    let summary = BatchSummary {
        completed,
        subject_failed,
        failed,
        cells: ordered,
    };
    let encoded = serde_json::to_string_pretty(&summary).map_err(|e| e.to_string())?;
    write_atomic(
        &out_dir.join("summary.json"),
        format!("{encoded}\n").as_bytes(),
    )?;
    println!("{encoded}");

    if failed > 0 {
        return Err(format!("batch finished with {failed} failed cell(s)"));
    }
    Ok(())
}

fn validate_id(raw: &str, label: &str) -> Result<(), String> {
    if raw.trim().is_empty() || raw.contains("::") || raw.chars().any(char::is_control) {
        return Err(format!(
            "invalid {label} '{raw}': cannot be empty or contain '::' or control characters"
        ));
    }
    Ok(())
}

fn resolve_from(base_dir: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        base_dir.join(path)
    }
}

fn freeze_spec(spec_path: &Path, mut spec: BatchSpec) -> Result<(BatchSpec, usize), String> {
    let base_dir = spec_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));

    spec.bundle_dir = resolve_bundle_dir(&resolve_from(base_dir, &spec.bundle_dir))?;
    if spec.harbor_bin.trim().is_empty() {
        return Err("harborBin cannot be empty".into());
    }
    let mut comps = Path::new(&spec.harbor_bin).components();
    if !matches!(
        (comps.next(), comps.next()),
        (Some(std::path::Component::Normal(_)), None)
    ) {
        let candidate = resolve_from(base_dir, Path::new(&spec.harbor_bin));
        let resolved = std::fs::canonicalize(&candidate)
            .map_err(|e| format!("failed to resolve harborBin {}: {e}", candidate.display()))?;
        if !resolved.is_file() {
            return Err(format!("harborBin is not a file: {}", resolved.display()));
        }
        spec.harbor_bin = resolved
            .to_str()
            .ok_or_else(|| format!("harborBin path is not valid UTF-8: {}", resolved.display()))?
            .to_owned();
    }
    for (k, v) in &spec.verifier_env {
        validate_env_entry(k, v)?;
    }

    if spec.subjects.is_empty() {
        return Err("subjects cannot be empty".into());
    }
    let mut subject_ids = BTreeSet::new();
    for s in &spec.subjects {
        validate_id(&s.id, "subject id")?;
        if !subject_ids.insert(s.id.as_str()) {
            return Err(format!("duplicate subject id '{}'", s.id));
        }
        validate_subject_target(
            Some(&s.id),
            &s.provider,
            &s.model_id,
            &s.api_key_env,
            s.base_url.as_deref(),
        )?;
    }

    if spec.tasks.is_empty() {
        return Err("tasks cannot be empty".into());
    }
    let mut task_ids = BTreeSet::new();
    for task in &mut spec.tasks {
        *task = resolve_task_dir(&resolve_from(base_dir, task))?;
        let id = task
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("task path has non-UTF-8 directory name: {}", task.display()))?
            .to_owned();
        validate_id(&id, "task directory name")?;
        if !task_ids.insert(id.clone()) {
            return Err(format!("duplicate task name '{id}'"));
        }
    }

    let cell_cap = usize::try_from(spec.repetitions.get())
        .ok()
        .and_then(|r| spec.tasks.len().checked_mul(r))
        .and_then(|n| n.checked_mul(spec.subjects.len()))
        .ok_or("experiment cell count overflowed usize")?;

    Ok((spec, cell_cap))
}

fn prepare_cell_dir(cell_dir: &Path, cell_id: &str) -> Result<(), String> {
    let err = |e| format!("failed preparing cell dir {}: {e}", cell_dir.display());
    if let Some(parent) = cell_dir.parent() {
        std::fs::create_dir_all(parent).map_err(err)?;
    }
    match std::fs::create_dir(cell_dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let is_dir = std::fs::symlink_metadata(cell_dir)
                .map_err(err)?
                .file_type()
                .is_dir();
            if !is_dir
                || std::fs::read_dir(cell_dir)
                    .map_err(err)?
                    .next()
                    .transpose()
                    .map_err(err)?
                    .is_some()
            {
                return Err(format!(
                    "refusing to overwrite non-empty cell dir {} for cell '{cell_id}'",
                    cell_dir.display()
                ));
            }
            Ok(())
        }
        Err(e) => Err(err(e)),
    }
}

fn append_event(file: &mut File, path: &Path, event: &JournalEvent) -> Result<(), String> {
    let mut line = serde_json::to_string(event).map_err(|e| e.to_string())?;
    line.push('\n');
    file.write_all(line.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|e| format!("failed to persist {}: {e}", path.display()))
}

fn load_journal(
    path: &Path,
    bytes: &[u8],
    valid_ids: &BTreeSet<&str>,
) -> Result<(BTreeMap<String, CellOutcome>, Option<String>), String> {
    let mut by_cell = BTreeMap::new();
    let mut pending: Option<String> = None;
    if bytes.is_empty() {
        return Ok((by_cell, pending));
    }
    if !bytes.ends_with(b"\n") {
        let line_no = bytes.iter().filter(|&&b| b == b'\n').count() + 1;
        return Err(format!(
            "corrupt {}: line {line_no} is missing trailing newline",
            path.display()
        ));
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|e| format!("corrupt {}: invalid UTF-8: {e}", path.display()))?;
    for (idx, line) in text.lines().enumerate() {
        let line_no = idx + 1;
        let event: JournalEvent = serde_json::from_str(line)
            .map_err(|e| format!("corrupt {} at line {line_no}: {e}", path.display()))?;
        match event {
            JournalEvent::Started { cell_id } => {
                if pending.is_some() {
                    return Err(format!(
                        "corrupt {} at line {line_no}: started cell while previous cell is still unsettled",
                        path.display()
                    ));
                }
                if !valid_ids.contains(cell_id.as_str()) {
                    return Err(format!(
                        "corrupt {} at line {line_no}: unknown cell '{cell_id}'",
                        path.display()
                    ));
                }
                if by_cell.contains_key(&cell_id) {
                    return Err(format!(
                        "corrupt {} at line {line_no}: duplicate record for cell '{cell_id}'",
                        path.display()
                    ));
                }
                pending = Some(cell_id);
            }
            JournalEvent::Settled { cell_id, outcome } => {
                if pending.take().as_deref() != Some(cell_id.as_str()) {
                    return Err(format!(
                        "corrupt {} at line {line_no}: settled record without matching started cell",
                        path.display()
                    ));
                }
                by_cell.insert(cell_id, outcome);
            }
        }
    }
    Ok((by_cell, pending))
}

fn verify_or_write_experiment(
    out_dir: &Path,
    frozen: &BatchSpec,
    has_existing_journal: bool,
) -> Result<(), String> {
    let path = out_dir.join("experiment.json");
    match std::fs::read_to_string(&path) {
        Ok(raw) => {
            let existing: BatchSpec = serde_json::from_str(&raw)
                .map_err(|e| format!("corrupt {}: {e}", path.display()))?;
            if existing != *frozen {
                return Err(format!(
                    "experiment spec mismatch in {}: --out is bound to a different frozen spec",
                    path.display()
                ));
            }
            return Ok(());
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("failed to read {}: {e}", path.display())),
    }
    if has_existing_journal {
        return Err(format!(
            "corrupt {}: missing experiment.json alongside non-empty {RESULTS_FILE}",
            out_dir.display()
        ));
    }
    let encoded = serde_json::to_string_pretty(frozen).map_err(|e| e.to_string())?;
    write_atomic(&path, format!("{encoded}\n").as_bytes())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("tmp");
    let tmp = path.with_file_name(format!(".{name}.tmp"));
    let mut file =
        File::create(&tmp).map_err(|e| format!("failed to create {}: {e}", tmp.display()))?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|e| format!("failed to write {}: {e}", tmp.display()))?;
    drop(file);
    std::fs::rename(&tmp, path).map_err(|e| format!("failed to replace {}: {e}", path.display()))
}
