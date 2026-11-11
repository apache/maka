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

use clap::Subcommand;
use maka_agent_facts::{
    durable::RunOwner,
    history_snapshot::{Entry, Origin},
};
use maka_agent_ports::session::history::{HistoryView, Page, Position};
use maka_agent_state::{DriverDomain, Store, session_history::snapshot::Snapshot};
use maka_event_log::{
    RootStore,
    checkpoints::{Head, Manifest, Revision},
    root::{RootNamespaces, RootOwner},
    root_store::portable,
};
use maka_host_runtime::HostError;
use std::{
    fs::File,
    path::{Path, PathBuf},
    sync::Arc,
};
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Subcommand)]
pub(super) enum Command {
    /// Export an exact retained revision to a new .tar.gz file.
    Export {
        #[arg(long)]
        root: PathBuf,
        #[arg(long)]
        session: String,
        #[arg(long)]
        revision: Uuid,
        #[arg(long)]
        output: PathBuf,
    },
    /// Verify and open a portable archive in a new inspection directory.
    Open {
        archive: PathBuf,
        #[arg(long)]
        output: PathBuf,
        /// Maximum total file bytes published in the inspection directory.
        #[arg(long, default_value_t = 8 << 30)]
        max_bytes: u64,
    },
}
fn parent(path: &Path) -> Result<&Path, HostError> {
    path.file_name()
        .ok_or("output needs a file or directory name")?;
    Ok(path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new(".")))
}
impl Command {
    pub(super) async fn run(self) -> Result<(), HostError> {
        match self {
            Self::Export {
                root,
                session,
                revision,
                output,
            } => {
                tokio::task::spawn_blocking(move || {
                    let parent = parent(&output)?;
                    #[cfg(windows)]
                    let mut file = tempfile::Builder::new()
                        .make_in(parent, maka_event_log::root::windows::create_private_file)?;
                    #[cfg(not(windows))]
                    let mut file = tempfile::NamedTempFile::new_in(parent)?;
                    portable::export(&root, &session, Revision(revision), file.as_file_mut())?;
                    file.as_file().sync_all()?;
                    file.persist_noclobber(&output)?;
                    sync_directory(parent)?;
                    Ok(())
                })
                .await?
            }
            Self::Open {
                archive,
                output,
                max_bytes,
            } => open(archive, output, max_bytes).await,
        }
    }
}

async fn open(archive: PathBuf, output: PathBuf, max_bytes: u64) -> Result<(), HostError> {
    let target = output.clone();
    let (stage, scratch, inspected) =
        tokio::task::spawn_blocking(move || -> Result<_, HostError> {
            if target.try_exists()? {
                return Err("inspection destination already exists".into());
            }
            let mut builder = tempfile::Builder::new();
            builder.prefix(".maka-inspection-");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                builder.permissions(std::fs::Permissions::from_mode(0o700));
            }
            let stage = builder.tempdir_in(parent(&target)?)?;
            #[cfg(windows)]
            maka_event_log::root::private_directory(stage.path())?;
            let scratch = tempfile::Builder::new()
                .prefix(".scratch-")
                .tempdir_in(stage.path())?;
            let inspected = portable::open(
                File::open(archive)?,
                stage.path(),
                scratch.path(),
                max_bytes,
            )?;
            Ok((stage, scratch, inspected))
        })
        .await??;
    let portable::Inspection {
        head,
        manifest,
        history,
        mut remaining_bytes,
    } = inspected;
    let owner = RunOwner {
        deployment: manifest.scope.deployment,
        namespace: manifest.scope.namespace.clone(),
    };
    let origin: Origin = serde_json::from_slice(&manifest.history.cut)?;
    if !matches!(origin, Origin::Canonical { ref cut } if cut.owner == owner && cut.session == manifest.session_id)
    {
        return Err("checkpoint history does not belong to the declared source Session".into());
    }

    // Scratch has its own Root and control namespace. It has no Host, provider
    // connection, live Session or execution authority copied from the source.
    let private = scratch.path().to_owned();
    let root_owner = tokio::task::spawn_blocking(move || {
        RootOwner::create(
            &private.join("root"),
            &RootNamespaces {
                ownership: private.join("ownership"),
                control: private.join("control"),
            },
        )
    })
    .await??;
    let catalog = maka_event_log::ROOT_MIGRATIONS
        .iter()
        .chain(maka_agent_state::MIGRATIONS)
        .copied()
        .collect::<Vec<_>>();
    let root = RootStore::open(Arc::new(root_owner), &catalog).await?;
    let result = async {
        let data = root.data_writer()?;
        let store = Store::new(data.clone(), DriverDomain::new(data)?)?;
        let stop = CancellationToken::new();
        let snapshot = store
            .session_history(owner, manifest.session_id.clone())
            .import_snapshot(
                Uuid::new_v4(),
                manifest.history.clone(),
                history,
                stop.clone(),
            )
            .await?;
        let mut position = Position::Start;
        let mut transcript = tokio::io::BufWriter::new(
            tokio::fs::File::create_new(stage.path().join("history.jsonl")).await?,
        );
        use tokio::io::AsyncWriteExt;
        loop {
            let Page::Ready { chunks, after, .. } = maka_agent_native::checkpoint_history_page(
                &snapshot,
                position.clone(),
                true,
                HistoryView::Text,
                &stop,
            )
            .await?;
            for chunk in chunks {
                write_record(&mut transcript, &chunk, &mut remaining_bytes).await?;
            }
            let Some(cursor) = after else { break };
            let next = Position::After { cursor };
            if position == next {
                return Err("checkpoint history cursor did not advance".into());
            }
            position = next;
        }
        transcript.flush().await?;
        transcript.get_ref().sync_all().await?;
        write_artifacts(&snapshot, stage.path(), &mut remaining_bytes).await?;
        #[derive(serde::Serialize)]
        struct Summary<'a> {
            head: &'a Head,
            manifest: &'a Manifest,
        }
        let mut summary = tokio::fs::File::create_new(stage.path().join("checkpoint.json")).await?;
        write_record(
            &mut summary,
            &Summary {
                head: &head,
                manifest: &manifest,
            },
            &mut remaining_bytes,
        )
        .await?;
        summary.sync_all().await?;
        Ok::<_, HostError>(())
    }
    .await;
    let closed = root.shutdown().await;
    drop(root);
    result?;
    closed?;
    tokio::task::spawn_blocking(move || {
        scratch.close()?;
        sync_directory(stage.path())?;
        publish_directory(stage, &output)?;
        sync_directory(parent(&output)?)?;
        Ok::<_, HostError>(())
    })
    .await?
}

fn charge(remaining: &mut u64, bytes: u64) -> Result<(), HostError> {
    *remaining = remaining
        .checked_sub(bytes)
        .ok_or("checkpoint exceeds inspection byte budget")?;
    Ok(())
}

async fn write_record(
    writer: &mut (impl tokio::io::AsyncWrite + Unpin),
    record: &impl serde::Serialize,
    remaining: &mut u64,
) -> Result<(), HostError> {
    use tokio::io::AsyncWriteExt;
    let mut bytes = serde_json::to_vec(record)?;
    bytes.push(b'\n');
    charge(remaining, bytes.len() as u64)?;
    writer.write_all(&bytes).await?;
    Ok(())
}

/// Materialize immutable media by content digest. Source-provided names and
/// identities belong in the index, never in an output path.
async fn write_artifacts(
    snapshot: &Snapshot,
    stage: &Path,
    remaining: &mut u64,
) -> Result<(), HostError> {
    use tokio::io::AsyncWriteExt;
    let directory = stage.join("artifacts");
    tokio::fs::create_dir(&directory).await?;
    let mut index = tokio::io::BufWriter::new(
        tokio::fs::File::create_new(stage.join("artifacts.jsonl")).await?,
    );
    let mut seen = std::collections::BTreeSet::from([snapshot.id()]);
    let mut pending = vec![snapshot.clone()];
    while let Some(snapshot) = pending.pop() {
        let mut cursor = None;
        loop {
            let (entries, next) = snapshot.artifacts_and_markers(cursor, 64).await?;
            for (_, entry) in entries {
                if let Entry::Run { run, .. } = &entry {
                    let child = snapshot.nested(*run).await?;
                    if seen.insert(child.id()) {
                        pending.push(child);
                    }
                    continue;
                }
                let Entry::Artifact {
                    run, ref record, ..
                } = entry
                else {
                    continue;
                };
                record.payload.validate()?;
                let digest = record
                    .payload
                    .digest
                    .strip_prefix("sha256:")
                    .ok_or("invalid artifact digest")?;
                let path = directory.join(digest);
                if !tokio::fs::try_exists(&path).await? {
                    charge(remaining, record.payload.bytes)?;
                    let bytes = snapshot
                        .with_pinned_content(run, &record.payload, move |reader| {
                            let mut dest = File::create_new(path)?;
                            let count = std::io::copy(reader, &mut dest)?;
                            dest.sync_all()?;
                            Ok(count)
                        })
                        .await?;
                    if bytes != record.payload.bytes {
                        return Err("checkpoint artifact missing or length differs".into());
                    }
                }
                write_record(&mut index, &entry, remaining).await?;
            }
            let Some(next) = next else { break };
            cursor = Some(next);
        }
    }
    index.flush().await?;
    index.get_ref().sync_all().await?;
    tokio::task::spawn_blocking(move || sync_directory(&directory)).await??;
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn publish_directory(stage: TempDir, output: &Path) -> std::io::Result<()> {
    use rustix::fs::{CWD, RenameFlags, renameat_with};
    renameat_with(CWD, stage.path(), CWD, output, RenameFlags::NOREPLACE)?;
    let _ = stage.keep();
    Ok(())
}
#[cfg(windows)]
fn publish_directory(stage: TempDir, output: &Path) -> std::io::Result<()> {
    // MoveFileEx without REPLACE_EXISTING and with WRITE_THROUGH.
    maka_event_log::root::windows::publish_file(stage.path(), output)?;
    let _ = stage.keep();
    Ok(())
}
#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn publish_directory(_: TempDir, _: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "exclusive directory publication unavailable",
    ))
}
fn sync_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
