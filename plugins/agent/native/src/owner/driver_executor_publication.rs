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

//! Root-owned preparation of immutable native workspace publication candidates.
pub(super) mod calls;
use super::RunAccess;
use maka_agent_authority::permissions::Access;
use maka_agent_engine::RunError;
use maka_agent_facts::{
    durable::{ContentRef, ExternalTaskId, SCHEMA_VERSION},
    external_publication::PublicationManifest,
};
use maka_agent_state::{ContentBlob, DriverClaim, ImmutableContentBody, Store};
use maka_fs_tools::publication::{PublicationChange, PublicationEntry, SourceIdentity};
use maka_process::isolated::{
    BaselineEntry, BaselineReader, CandidateCapture, CaptureCost, FrozenCandidate,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::File,
    io::{self, Read, Seek},
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

const IO_BUFFER: usize = 64 * 1024;

pub(super) struct ExecutorPublication {
    access: Arc<RunAccess>,
    claim: DriverClaim,
    state: Store,
    task: ExternalTaskId,
    capture: CandidateCapture,
}

#[derive(Debug, thiserror::Error)]
pub(super) enum PublicationPreparationError {
    #[error(transparent)]
    Root(#[from] RunError),
    #[error(transparent)]
    Capture(#[from] maka_process::isolated::Error),
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ComparisonCost {
    pub entries: u64,
    /// Bytes actually read by exact comparison, including both trees.
    pub compared_bytes: u64,
    /// Bytes read again to hash only changed file inputs, including both trees.
    pub hashed_bytes: u64,
    pub elapsed_millis: u64,
}

/// Parent admission must pin all these contents under its actual publication
/// source in one original Root transaction before preparing the Host FS effect.
/// Keeping this value also keeps the actual immutable input owners alive.
pub(super) struct PreparedPublication {
    pub plan: PublicationManifest<SourceIdentity, PublicationChange>,
    pub comparison: ComparisonCost,
    pub capture: CaptureCost,
    pub freeze_elapsed_millis: u64,
    pub descriptor: ContentBlob,
    pub contents: Vec<ContentBlob>,
    candidate: Arc<FrozenCandidate>,
    baseline: Arc<BaselineReader>,
}

impl PreparedPublication {
    pub(super) fn candidate(&self) -> &FrozenCandidate {
        &self.candidate
    }
    pub(super) fn baseline(&self) -> &BaselineReader {
        &self.baseline
    }
}

impl ExecutorPublication {
    pub(super) fn new(
        access: Arc<RunAccess>,
        claim: DriverClaim,
        state: Store,
        task: ExternalTaskId,
        capture: CandidateCapture,
    ) -> Result<Self, RunError> {
        if claim.run() != access.execution().run_id {
            return Err(RunError::InvalidInput(
                "foreign publication driver claim".into(),
            ));
        }
        Ok(Self {
            access,
            claim,
            state,
            task,
            capture,
        })
    }

    pub(super) async fn prepare(&self) -> Result<PreparedPublication, PublicationPreparationError> {
        let view = self
            .state
            .driver_frontier(&self.claim)
            .await
            .map_err(RunError::from)?;
        let task = view.external.as_ref().ok_or_else(|| {
            RunError::InvalidInput("publication has no original executor task".into())
        })?;
        if task.task != self.task || !task.admitted || task.closed.is_none() {
            return Err(RunError::InvalidInput(
                "publication requires the original known native closure".into(),
            )
            .into());
        }
        let pending = task.publication.as_ref().ok_or_else(|| {
            RunError::InvalidInput("publication has no original canonical Pending source".into())
        })?;
        if pending.task != self.task || pending.abandoned || pending.manifest.is_some() {
            return Err(RunError::InvalidInput(
                "publication preparation is not the original pending obligation".into(),
            )
            .into());
        }
        let publication = pending.id;
        let source = pending.source.clone();
        // Actual Root access is checked independently of the job's private sandbox.
        let configuration = self
            .access
            .live_configuration()
            .await
            .map_err(RunError::from)?;
        if view.stopped || view.terminal.is_some() {
            return Err(RunError::Cancelled.into());
        }
        let permission_basis = configuration.permission_basis();
        let task = self.task;
        let freeze_started = Instant::now();
        let candidate = Arc::new(self.capture.freeze().await?);
        let freeze_elapsed_millis = u64::try_from(freeze_started.elapsed().as_millis())
            .map_err(|_| RunError::Internal("publication capture elapsed time overflow".into()))?;
        if candidate.snapshot().source() != Path::new(&configuration.workspace.path) {
            return Err(RunError::InvalidInput(
                "publication source differs from the actual Root workspace".into(),
            )
            .into());
        }
        tokio::task::spawn_blocking(
            move || -> Result<PreparedPublication, PublicationPreparationError> {
                let baseline = Arc::new(
                    candidate
                        .baseline_reader()
                        .map_err(maka_process::isolated::Error::from)?,
                );
                let (changes, contents, comparison) = compare(&baseline, &candidate)?;
                let snapshot = candidate.snapshot();
                let identity = snapshot.source_identity();
                let plan = PublicationManifest {
                    schema_version: SCHEMA_VERSION,
                    publication,
                    task,
                    source,
                    basis: permission_basis,
                    root: SourceIdentity {
                        device: identity.device,
                        inode: identity.inode,
                    },
                    changes,
                    contents: contents
                        .iter()
                        .map(|content| content.reference().clone())
                        .collect(),
                };
                let capture = candidate.capture_cost();
                let descriptor = ContentBlob::json(&plan).map_err(RunError::from)?;
                let mut contents = contents;
                contents.push(descriptor.clone());
                Ok(PreparedPublication {
                    plan,
                    comparison,
                    capture,
                    freeze_elapsed_millis,
                    descriptor,
                    contents,
                    candidate,
                    baseline,
                })
            },
        )
        .await
        .map_err(|error| RunError::Internal(error.to_string()))?
    }
}

/// Every inventory path is visited. No gitignore or stat tuple stands in for
/// file equality, and no current source path is opened outside the FS effect.
fn compare(
    baseline: &Arc<BaselineReader>,
    candidate: &Arc<FrozenCandidate>,
) -> Result<(Vec<PublicationChange>, Vec<ContentBlob>, ComparisonCost), RunError> {
    let started = Instant::now();
    let paths: BTreeSet<&Path> = baseline
        .snapshot()
        .files()
        .iter()
        .chain(candidate.entries())
        .map(|entry| entry.relative_path.as_path())
        .collect();
    let mut cost = ComparisonCost {
        entries: paths.len() as u64,
        ..ComparisonCost::default()
    };
    let mut changes = Vec::new();
    let mut contents = Vec::new();
    for path in paths {
        let mut original = baseline.open_entry(path)?;
        let mut selected = candidate.open_entry(path)?;
        if equal(&mut original, &mut selected, &mut cost)? {
            continue;
        }
        let expected = describe(
            original,
            &mut cost,
            |reference| {
                ContentBlob::prepared(
                    reference,
                    Arc::new(BaselineBody {
                        owner: baseline.clone(),
                        path: path.to_owned(),
                    }),
                )
            },
            &mut contents,
        )?;
        let selected = describe(
            selected,
            &mut cost,
            |reference| {
                ContentBlob::prepared(
                    reference,
                    Arc::new(CandidateBody {
                        owner: candidate.clone(),
                        path: path.to_owned(),
                    }),
                )
            },
            &mut contents,
        )?;
        changes.push(PublicationChange {
            path: path.to_owned(),
            expected,
            candidate: selected,
        });
    }
    cost.elapsed_millis = started
        .elapsed()
        .as_millis()
        .try_into()
        .map_err(|_| io::Error::other("publication elapsed time overflow"))?;
    Ok((changes, contents, cost))
}

fn equal(
    original: &mut BaselineEntry,
    candidate: &mut BaselineEntry,
    cost: &mut ComparisonCost,
) -> io::Result<bool> {
    match (original, candidate) {
        (BaselineEntry::Missing, BaselineEntry::Missing) => Ok(true),
        (BaselineEntry::Directory { mode: left }, BaselineEntry::Directory { mode: right }) => {
            Ok(left == right)
        }
        (
            BaselineEntry::Symlink {
                source_target: left,
                ..
            },
            BaselineEntry::Symlink {
                source_target: right,
                ..
            },
        ) => Ok(left == right),
        (
            BaselineEntry::File {
                file: left,
                mode: left_mode,
            },
            BaselineEntry::File {
                file: right,
                mode: right_mode,
            },
        ) => {
            let bytes_equal = equal_files(left, right, cost)?;
            Ok(bytes_equal && left_mode == right_mode)
        }
        _ => Ok(false),
    }
}

fn equal_files(left: &mut File, right: &mut File, cost: &mut ComparisonCost) -> io::Result<bool> {
    let mut a = [0; IO_BUFFER];
    let mut b = [0; IO_BUFFER];
    loop {
        let na = read_chunk(left, &mut a)?;
        let nb = read_chunk(right, &mut b)?;
        add_bytes(&mut cost.compared_bytes, na + nb)?;
        if na != nb || a[..na] != b[..nb] {
            return Ok(false);
        }
        if na == 0 {
            return Ok(true);
        }
    }
}

fn describe(
    entry: BaselineEntry,
    cost: &mut ComparisonCost,
    content: impl FnOnce(ContentRef) -> Result<ContentBlob, maka_event_log::StoreError>,
    contents: &mut Vec<ContentBlob>,
) -> Result<PublicationEntry, RunError> {
    Ok(match entry {
        BaselineEntry::Missing => PublicationEntry::Missing,
        BaselineEntry::Directory { mode } => PublicationEntry::Directory { mode },
        BaselineEntry::Symlink { source_target, .. } => PublicationEntry::Symlink {
            target: source_target,
        },
        BaselineEntry::File { mut file, mode } => {
            file.rewind()?;
            let reference = hash_file(&mut file, cost)?;
            contents.push(content(reference.clone())?);
            PublicationEntry::File {
                content: reference,
                mode,
            }
        }
    })
}

fn hash_file(file: &mut File, cost: &mut ComparisonCost) -> io::Result<ContentRef> {
    let mut hash = Sha256::new();
    let mut bytes = 0;
    let mut buffer = [0; IO_BUFFER];
    loop {
        let n = read_chunk(file, &mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
        add_bytes(&mut bytes, n)?;
        add_bytes(&mut cost.hashed_bytes, n)?;
    }
    Ok(ContentRef {
        digest: format!("sha256:{}", hex::encode(hash.finalize())),
        bytes,
    })
}

fn read_chunk(reader: &mut impl Read, buffer: &mut [u8]) -> io::Result<usize> {
    let mut used = 0;
    while used < buffer.len() {
        match reader.read(&mut buffer[used..]) {
            Ok(0) => break,
            Ok(n) => used += n,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(used)
}
fn add_bytes(total: &mut u64, count: usize) -> io::Result<()> {
    *total = total
        .checked_add(count as u64)
        .ok_or_else(|| io::Error::other("publication byte count overflow"))?;
    Ok(())
}

struct CandidateBody {
    owner: Arc<FrozenCandidate>,
    path: PathBuf,
}
impl ImmutableContentBody for CandidateBody {
    fn reader(&self) -> io::Result<Box<dyn Read + Send + '_>> {
        file_reader(self.owner.open_entry(&self.path)?)
    }
}
struct BaselineBody {
    owner: Arc<BaselineReader>,
    path: PathBuf,
}
impl ImmutableContentBody for BaselineBody {
    fn reader(&self) -> io::Result<Box<dyn Read + Send + '_>> {
        file_reader(self.owner.open_entry(&self.path)?)
    }
}
fn file_reader(entry: BaselineEntry) -> io::Result<Box<dyn Read + Send>> {
    match entry {
        BaselineEntry::File { file, .. } => Ok(Box::new(file)),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "immutable publication input changed type",
        )),
    }
}
