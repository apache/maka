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

//! Single-writer append-only experiment journal, atomic attempt settlement,
//! critical artifact verification, and deterministic state reconstruction.

use crate::contract::{
    AttemptPhase, CleanupState, ContractError, CriticalArtifactsState, EgressAuditState,
    ExecutionOutcome, ExperimentSpec, SchemaVersion, V1CellAttempt, V2AttemptRecord,
    VerifierOutcome, canonical_json_string, decode_v1_cell_attempt, parse_experiment_spec,
    sha256_hex,
};
use crate::measurement::{MeteringState, NormalizedUsage};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use thiserror::Error;
use uuid::Uuid;

pub const MAKA_RUNTIME_ARTIFACT_PATH: &str = "/logs/artifacts/maka-runtime-host";
pub const MAKA_SUBJECT_STDOUT_PATH: &str = "/logs/artifacts/maka-subject.stdout.txt";
pub const MAKA_SUBJECT_STDERR_PATH: &str = "/logs/artifacts/maka-subject.stderr.txt";

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Contract error: {0}")]
    Contract(#[from] ContractError),
    #[error("{0}: experiment already has an active writer")]
    ActiveWriter(String),
    #[error("{0}")]
    Integrity(String),
}

/// Exclusive single-writer lock guard held for the duration of a store write session.
#[derive(Debug)]
pub struct WriterGuard {
    _file: File,
}

impl WriterGuard {
    pub fn acquire(dir: &Path) -> Result<Self, StoreError> {
        fs::create_dir_all(dir)?;
        let lock_path = dir.join(".writer.lock");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&lock_path)?;
        match file.try_lock() {
            Ok(()) => Ok(Self { _file: file }),
            Err(std::fs::TryLockError::WouldBlock) => {
                Err(StoreError::ActiveWriter(lock_path.display().to_string()))
            }
            Err(std::fs::TryLockError::Error(err)) => Err(StoreError::Io(err)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum JournalEntry {
    LaunchIntent {
        cell_id: String,
        sequence: u32,
        started_at: u64,
        intent_id: String,
    },
    ResourceTagged {
        cell_id: String,
        sequence: u32,
        resource_kind: String,
        resource_id: String,
        operation_id: Option<String>,
        invocation_id: Option<String>,
    },
    Checkpoint {
        cell_id: String,
        sequence: u32,
        recorded_at: u64,
        usage: Option<NormalizedUsage>,
        metering_state: MeteringState,
    },
    Settled {
        attempt: Box<V2AttemptRecord>,
    },
    PostHocRecovery {
        cell_id: String,
        sequence: u32,
        recovered_at: u64,
        usage: Option<NormalizedUsage>,
        metering_state: MeteringState,
        cleanup_confirmed: bool,
        reason: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct UnsettledAttempt {
    pub cell_id: String,
    pub sequence: u32,
    pub started_at: u64,
    pub intent_id: String,
    pub resource_kind: Option<String>,
    pub resource_id: Option<String>,
    pub operation_id: Option<String>,
    pub invocation_id: Option<String>,
    pub latest_usage: Option<NormalizedUsage>,
    pub latest_metering_state: MeteringState,
}

#[derive(Debug, Clone, Default)]
pub struct ReconstructedStoreState {
    pub settled_v2: BTreeMap<String, Vec<V2AttemptRecord>>,
    pub settled_v1: BTreeMap<String, Vec<V1CellAttempt>>,
    pub unsettled: BTreeMap<(String, u32), UnsettledAttempt>,
}

#[derive(Debug, Clone)]
pub struct FileAttemptStore {
    root: PathBuf,
    journal_path: PathBuf,
}

impl FileAttemptStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        let journal_path = root.join("journal.jsonl");
        Self { root, journal_path }
    }

    pub fn path(&self) -> &Path {
        &self.root
    }

    pub fn journal_path(&self) -> &Path {
        &self.journal_path
    }

    pub fn acquire_writer(&self) -> Result<WriterGuard, StoreError> {
        WriterGuard::acquire(&self.root)
    }

    pub fn run_exclusive<T, F>(&self, operation: F) -> Result<T, StoreError>
    where
        F: FnOnce(&WriterGuard) -> Result<T, StoreError>,
    {
        let guard = self.acquire_writer()?;
        operation(&guard)
    }

    pub async fn run_exclusive_async<T, F, Fut>(&self, operation: F) -> Result<T, StoreError>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<T, StoreError>>,
    {
        let _guard = self.acquire_writer()?;
        operation().await
    }

    /// Appends a single journal entry to `journal.jsonl` and fsyncs it before returning.
    pub fn append_journal_entry(&self, entry: &JournalEntry) -> Result<(), StoreError> {
        fs::create_dir_all(&self.root)?;
        let mut options = OpenOptions::new();
        options.create(true).append(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&self.journal_path)?;
        let line = serde_json::to_string(entry)?;
        file.write_all(line.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        Ok(())
    }

    /// Records a pre-dispatch `LaunchIntent` before any external resource or Host operation starts.
    pub fn record_launch_intent(
        &self,
        cell_id: &str,
        sequence: u32,
        started_at: u64,
        intent_id: &str,
    ) -> Result<(), StoreError> {
        let expected = self.next_sequence(cell_id)?;
        if sequence != expected {
            return Err(StoreError::Integrity(format!(
                "attempt sequence must be {expected}"
            )));
        }
        self.append_journal_entry(&JournalEntry::LaunchIntent {
            cell_id: cell_id.to_owned(),
            sequence,
            started_at,
            intent_id: intent_id.to_owned(),
        })
    }

    pub fn record_resource_tagged(
        &self,
        cell_id: &str,
        sequence: u32,
        resource_kind: &str,
        resource_id: &str,
        operation_id: Option<String>,
        invocation_id: Option<String>,
    ) -> Result<(), StoreError> {
        self.append_journal_entry(&JournalEntry::ResourceTagged {
            cell_id: cell_id.to_owned(),
            sequence,
            resource_kind: resource_kind.to_owned(),
            resource_id: resource_id.to_owned(),
            operation_id,
            invocation_id,
        })
    }

    pub fn record_checkpoint(
        &self,
        cell_id: &str,
        sequence: u32,
        recorded_at: u64,
        usage: Option<NormalizedUsage>,
        metering_state: MeteringState,
    ) -> Result<(), StoreError> {
        self.append_journal_entry(&JournalEntry::Checkpoint {
            cell_id: cell_id.to_owned(),
            sequence,
            recorded_at,
            usage,
            metering_state,
        })
    }

    /// Commits a settled record to the sole durable authority: the journal.
    pub fn append_v2(&self, record: &V2AttemptRecord) -> Result<V1CellAttempt, StoreError> {
        let expected = self.next_settled_sequence(&record.cell_id)?;
        if record.sequence != expected {
            return Err(StoreError::Integrity(format!(
                "attempt sequence must be {expected}"
            )));
        }
        let v1 = record.project_v1();
        let _ = decode_v1_cell_attempt(&serde_json::to_value(&v1)?)?;

        self.append_journal_entry(&JournalEntry::Settled {
            attempt: Box::new(record.clone()),
        })?;

        Ok(v1)
    }

    /// Appends a `maka.eval.v1` attempt directly (for legacy compatibility tests and stores)
    /// while synthesizing the corresponding `v2` record in the journal.
    pub fn append_v1(&self, attempt: &V1CellAttempt) -> Result<(), StoreError> {
        let validated = decode_v1_cell_attempt(&serde_json::to_value(attempt)?)?;
        let expected = self.next_settled_sequence(&validated.cell_id)?;
        if validated.sequence != expected {
            return Err(StoreError::Integrity(format!(
                "attempt sequence must be {expected}"
            )));
        }
        let v2 = v2_from_v1(&validated);
        self.append_journal_entry(&JournalEntry::Settled {
            attempt: Box::new(v2),
        })?;
        Ok(())
    }

    /// Appends a post-hoc recovery entry without mutating any existing attempt file or journal entry.
    #[allow(clippy::too_many_arguments)]
    pub fn record_post_hoc_recovery(
        &self,
        cell_id: &str,
        sequence: u32,
        recovered_at: u64,
        usage: Option<NormalizedUsage>,
        metering_state: MeteringState,
        cleanup_confirmed: bool,
        reason: Option<String>,
    ) -> Result<(), StoreError> {
        self.append_journal_entry(&JournalEntry::PostHocRecovery {
            cell_id: cell_id.to_owned(),
            sequence,
            recovered_at,
            usage,
            metering_state,
            cleanup_confirmed,
            reason,
        })
    }

    /// Projects only committed journal records, including post-hoc evidence.
    pub fn list_v1(&self, cell_id: &str) -> Result<Vec<V1CellAttempt>, StoreError> {
        Ok(self
            .reconstruct_state()?
            .settled_v1
            .remove(cell_id)
            .unwrap_or_default())
    }

    pub fn read_journal_entries(&self) -> Result<Vec<JournalEntry>, StoreError> {
        let file = match File::open(&self.journal_path) {
            Ok(f) => f,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => return Err(StoreError::Io(err)),
        };
        let reader = BufReader::new(file);
        let mut entries = Vec::new();
        for line in reader.lines() {
            let line = line?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let entry: JournalEntry = serde_json::from_str(trimmed)?;
            entries.push(entry);
        }
        Ok(entries)
    }

    /// Deterministically reconstructs all settled `v2` records, `v1` projections, and
    /// unsettled in-flight attempts from the append-only journal.
    pub fn reconstruct_state(&self) -> Result<ReconstructedStoreState, StoreError> {
        let entries = self.read_journal_entries()?;
        let mut state = ReconstructedStoreState::default();
        let mut settled_map: BTreeMap<(String, u32), V2AttemptRecord> = BTreeMap::new();

        for entry in entries {
            match entry {
                JournalEntry::LaunchIntent {
                    cell_id,
                    sequence,
                    started_at,
                    intent_id,
                } => {
                    state.unsettled.insert(
                        (cell_id.clone(), sequence),
                        UnsettledAttempt {
                            cell_id,
                            sequence,
                            started_at,
                            intent_id,
                            resource_kind: None,
                            resource_id: None,
                            operation_id: None,
                            invocation_id: None,
                            latest_usage: None,
                            latest_metering_state: MeteringState::Unknown,
                        },
                    );
                }
                JournalEntry::ResourceTagged {
                    cell_id,
                    sequence,
                    resource_kind,
                    resource_id,
                    operation_id,
                    invocation_id,
                } => {
                    if let Some(unsettled) = state.unsettled.get_mut(&(cell_id, sequence)) {
                        unsettled.resource_kind = Some(resource_kind);
                        unsettled.resource_id = Some(resource_id);
                        unsettled.operation_id = operation_id;
                        unsettled.invocation_id = invocation_id;
                    }
                }
                JournalEntry::Checkpoint {
                    cell_id,
                    sequence,
                    usage,
                    metering_state,
                    ..
                } => {
                    if let Some(unsettled) = state.unsettled.get_mut(&(cell_id, sequence)) {
                        if usage.is_some() {
                            unsettled.latest_usage = usage;
                        }
                        unsettled.latest_metering_state = metering_state;
                    }
                }
                JournalEntry::Settled { attempt } => {
                    let key = (attempt.cell_id.clone(), attempt.sequence);
                    state.unsettled.remove(&key);
                    settled_map.insert(key, *attempt);
                }
                JournalEntry::PostHocRecovery {
                    cell_id,
                    sequence,
                    recovered_at,
                    usage,
                    metering_state,
                    cleanup_confirmed,
                    reason,
                } => {
                    let key = (cell_id.clone(), sequence);
                    if let Some(existing) = settled_map.get_mut(&key) {
                        existing.recovered_post_hoc = true;
                        existing.phase = AttemptPhase::Recovered;
                        if usage.is_some() {
                            if existing.usage != usage {
                                if let Some(crate::contract::PricingEvidence::Model {
                                    cost_usd,
                                    ..
                                }) = &mut existing.pricing
                                {
                                    *cost_usd = None;
                                } else {
                                    existing.pricing = None;
                                }
                            }
                            existing.usage = usage;
                            existing.metering_state = metering_state;
                        }
                        if cleanup_confirmed {
                            existing.cleanup_state = CleanupState::Confirmed;
                        }
                        if let Some(r) = reason {
                            existing.failure_reason = Some(r);
                        }
                    } else if let Some(unsettled) = state.unsettled.remove(&key) {
                        let recovered_usage = usage.or(unsettled.latest_usage);
                        let record =
                            V2AttemptRecord {
                                schema_version: SchemaVersion::V2,
                                cell_id,
                                sequence,
                                started_at: unsettled.started_at,
                                completed_at: recovered_at,
                                duration_ms: recovered_at.saturating_sub(unsettled.started_at),
                                phase: AttemptPhase::Recovered,
                                execution_outcome: if cleanup_confirmed {
                                    ExecutionOutcome::InfraFailed
                                } else {
                                    ExecutionOutcome::Indeterminate
                                },
                                verifier_outcome: VerifierOutcome::Skipped,
                                usage: recovered_usage,
                                metering_state,
                                pricing: None,
                                cleanup_state: if cleanup_confirmed {
                                    CleanupState::Confirmed
                                } else {
                                    CleanupState::Unconfirmed {
                                        reason: reason.clone().unwrap_or_else(|| {
                                            "executor cleanup did not settle".into()
                                        }),
                                    }
                                },
                                audit_state: EgressAuditState::NotRequired,
                                critical_artifacts_state: CriticalArtifactsState::Present,
                                cancelled_after_verification: false,
                                recovered_post_hoc: true,
                                failure_reason: Some(reason.unwrap_or_else(|| {
                                    "recovered after interrupted attempt".into()
                                })),
                                artifacts: Vec::new(),
                            };
                        settled_map.insert(key, record);
                    }
                }
            }
        }

        for ((cell_id, _seq), record) in settled_map {
            let v1 = record.project_v1();
            state
                .settled_v2
                .entry(cell_id.clone())
                .or_default()
                .push(record);
            state.settled_v1.entry(cell_id).or_default().push(v1);
        }

        Ok(state)
    }

    pub fn next_settled_sequence(&self, cell_id: &str) -> Result<u32, StoreError> {
        let v1_list = self.list_v1(cell_id)?;
        Ok(v1_list.last().map_or(1, |a| a.sequence + 1))
    }

    pub fn next_sequence(&self, cell_id: &str) -> Result<u32, StoreError> {
        let settled_next = self.next_settled_sequence(cell_id)?;
        let reconstructed = self.reconstruct_state()?;
        let max_journal_seq = reconstructed
            .settled_v2
            .get(cell_id)
            .and_then(|v| v.last().map(|r| r.sequence))
            .into_iter()
            .chain(
                reconstructed
                    .unsettled
                    .keys()
                    .filter(|(c, _)| c == cell_id)
                    .map(|(_, s)| *s),
            )
            .max()
            .map_or(1, |s| s + 1);
        Ok(settled_next.max(max_journal_seq))
    }
}

#[derive(Debug, Clone)]
pub struct ExperimentDirectory {
    pub root: PathBuf,
    pub spec_path: PathBuf,
    pub attempts: FileAttemptStore,
}

impl ExperimentDirectory {
    pub fn open(root: impl Into<PathBuf>, spec: &ExperimentSpec) -> Result<Self, StoreError> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        let spec_path = root.join("experiment.json");
        let spec_val = serde_json::to_value(spec)?;
        let canonical = format!("{}\n", canonical_json_string(&spec_val));
        let temp_path = root.join(format!(".experiment-{}.tmp", Uuid::new_v4()));

        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut temp_file = options.open(&temp_path)?;
        let link_res = (|| -> Result<(), std::io::Error> {
            temp_file.write_all(canonical.as_bytes())?;
            temp_file.sync_all()?;
            drop(temp_file);
            fs::hard_link(&temp_path, &spec_path)
        })();
        let _ = fs::remove_file(&temp_path);

        match link_res {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                let existing_raw = fs::read_to_string(&spec_path)?;
                let existing_val: Value = serde_json::from_str(&existing_raw)?;
                let existing_spec = parse_experiment_spec(&existing_val)?;
                let existing_canonical =
                    canonical_json_string(&serde_json::to_value(&existing_spec)?);
                if existing_canonical != canonical_json_string(&spec_val) {
                    return Err(StoreError::Integrity("experiment spec differs".into()));
                }
            }
            Err(err) => return Err(StoreError::Io(err)),
        }

        Ok(Self {
            spec_path,
            attempts: FileAttemptStore::new(root.join("attempts")),
            root,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapturedArtifactFile {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MakaRuntimeArtifactManifest {
    pub schema_version: String,
    pub reason: String,
    pub captured_at: u64,
    pub files: Vec<CapturedArtifactFile>,
}

/// Verifies whether every required critical artifact path exists as a readable regular file.
///
/// Explicitly distinguishes a `0-byte` regular file (`Present`, valid empty file) from a
/// missing, symlink, directory, or unreadable path (`Missing`).
pub fn verify_critical_artifacts(
    base_dir: &Path,
    required_paths: &[&str],
) -> (CriticalArtifactsState, Vec<CapturedArtifactFile>) {
    let mut missing = Vec::new();
    let mut captured = Vec::new();

    for rel in required_paths {
        let full = base_dir.join(rel);
        match describe_regular_file(&full, rel) {
            Some(desc) => captured.push(desc),
            None => missing.push((*rel).to_owned()),
        }
    }

    if missing.is_empty() {
        (CriticalArtifactsState::Present, captured)
    } else {
        (CriticalArtifactsState::Missing { paths: missing }, captured)
    }
}

pub fn describe_regular_file(path: &Path, reported_name: &str) -> Option<CapturedArtifactFile> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_file() {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    Some(CapturedArtifactFile {
        path: reported_name.to_owned(),
        bytes: bytes.len() as u64,
        sha256: format!("sha256:{}", sha256_hex(&bytes)),
    })
}

/// Captures Maka runtime artifacts (`runtime.sqlite`, logs, and `manifest.json`) into
/// `destination_root` using atomic directory staging.
pub fn capture_maka_runtime_artifacts(
    state_root: &Path,
    destination_root: &Path,
    reason: &str,
    captured_at: u64,
) -> Result<MakaRuntimeArtifactManifest, StoreError> {
    let staging_root =
        destination_root.with_extension(format!("tmp.{}.{}", std::process::id(), Uuid::new_v4()));
    let _ = fs::remove_dir_all(&staging_root);
    fs::create_dir_all(&staging_root)?;

    let res = (|| -> Result<MakaRuntimeArtifactManifest, StoreError> {
        let sqlite_src = state_root.join("runtime.sqlite");
        let sqlite_dst = staging_root.join("runtime.sqlite");
        if sqlite_src.is_file() {
            let src_conn = rusqlite::Connection::open_with_flags(
                &sqlite_src,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .map_err(|e| StoreError::Integrity(format!("sqlite open failed: {e}")))?;
            let dst_str = sqlite_dst
                .to_str()
                .ok_or_else(|| StoreError::Integrity("invalid sqlite destination path".into()))?;
            src_conn
                .execute("VACUUM INTO ?1", [dst_str])
                .map_err(|e| StoreError::Integrity(format!("sqlite backup failed: {e}")))?;
        }

        for candidate in [
            "runtime-host-candidate.log",
            "runtime-policy.json",
            "collection-error.json",
        ] {
            let src = state_root.join(candidate);
            if src.is_file() {
                fs::copy(&src, staging_root.join(candidate))?;
            }
        }

        let mut files = Vec::new();
        for name in [
            "runtime.sqlite",
            "runtime-host-candidate.log",
            "runtime-policy.json",
            "collection-error.json",
        ] {
            if let Some(desc) = describe_regular_file(&staging_root.join(name), name) {
                files.push(desc);
            }
        }

        let manifest = MakaRuntimeArtifactManifest {
            schema_version: "maka.eval.runtime_artifacts.v1".into(),
            reason: reason.to_owned(),
            captured_at,
            files,
        };
        let manifest_bytes = format!("{}\n", serde_json::to_string_pretty(&manifest)?);
        fs::write(staging_root.join("manifest.json"), manifest_bytes)?;

        if let Some(parent) = destination_root.parent() {
            fs::create_dir_all(parent)?;
        }
        let _ = fs::remove_dir_all(destination_root);
        fs::rename(&staging_root, destination_root)?;
        Ok(manifest)
    })();

    if res.is_err() {
        let _ = fs::remove_dir_all(&staging_root);
    }
    res
}

pub fn write_atomic_bytes(final_path: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    if let Some(parent) = final_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp_path =
        final_path.with_extension(format!("tmp.{}.{}", std::process::id(), Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut temp_file = options.open(&temp_path)?;
    let res = (|| -> Result<(), StoreError> {
        temp_file.write_all(bytes)?;
        temp_file.sync_all()?;
        drop(temp_file);
        fs::rename(&temp_path, final_path)?;
        Ok(())
    })();
    if res.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    res
}

fn v2_from_v1(v1: &V1CellAttempt) -> V2AttemptRecord {
    use crate::contract::EvalResultStatus;
    let execution_outcome = match v1.result.status {
        EvalResultStatus::Completed => ExecutionOutcome::Completed,
        EvalResultStatus::SubjectFailed => ExecutionOutcome::SubjectFailed,
        EvalResultStatus::InfraFailed => ExecutionOutcome::InfraFailed,
        EvalResultStatus::Indeterminate => ExecutionOutcome::Indeterminate,
    };
    let verifier_outcome = match (v1.result.status, v1.result.score) {
        (EvalResultStatus::Completed, Some(score)) => VerifierOutcome::Verified { score },
        (EvalResultStatus::SubjectFailed, score) => VerifierOutcome::SubjectFailed {
            score,
            reason: v1
                .result
                .failure_reason
                .clone()
                .unwrap_or_else(|| "subject failed".into()),
        },
        _ => VerifierOutcome::Skipped,
    };
    let metering_state = match (&v1.result.usage, v1.result.cost_usd) {
        (Some(_), Some(_)) => MeteringState::Complete,
        (Some(_), None) => MeteringState::LowerBound,
        (None, _) => MeteringState::Unknown,
    };
    let mut clean_artifacts: Vec<Map<String, Value>> = Vec::new();
    for a in &v1.result.artifacts {
        clean_artifacts.push(a.clone());
    }
    V2AttemptRecord {
        schema_version: SchemaVersion::V2,
        cell_id: v1.cell_id.clone(),
        sequence: v1.sequence,
        started_at: v1.started_at,
        completed_at: v1.completed_at,
        duration_ms: v1.result.duration_ms,
        phase: AttemptPhase::Settled,
        execution_outcome,
        verifier_outcome,
        usage: v1.result.usage.clone(),
        metering_state,
        pricing: v1
            .result
            .cost_usd
            .map(|cost_usd| crate::contract::PricingEvidence::SubjectReported { cost_usd }),
        cleanup_state: CleanupState::Confirmed,
        audit_state: EgressAuditState::NotRequired,
        critical_artifacts_state: CriticalArtifactsState::Present,
        cancelled_after_verification: false,
        recovered_post_hoc: false,
        failure_reason: v1.result.failure_reason.clone(),
        artifacts: clean_artifacts,
    }
}
