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

//! Observe configured workspace roots uniformly. All quiet periods use event time in milliseconds.
use super::*;
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use maka_agent_state::discovery::{
    DiscoveryStore,
    changes::{ChangeSnapshot, FileWrite, Fingerprint, ProbeResult, WriteKind},
};
use notify::{
    EventKind, RecommendedWatcher, RecursiveMode, Watcher,
    event::{CreateKind, MetadataKind, ModifyKind, RemoveKind, RenameMode},
};
use std::{
    io::{self, Read},
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};
use tokio::sync::{mpsc, oneshot};

const BATCH: usize = 128;

#[derive(Clone, Copy)]
struct Timing {
    debounce: Duration,
    window: Duration,
    cooldown: Duration,
}
impl Default for Timing {
    fn default() -> Self {
        Self {
            debounce: Duration::from_secs(10),
            window: Duration::from_secs(4 * 60),
            cooldown: Duration::from_secs(10 * 60),
        }
    }
}
struct ChangeTracker {
    store: DiscoveryStore,
    roots: Arc<BTreeMap<PathBuf, Dir>>,
    timing: Timing,
}

fn ignored(path: &Path, private: &[PathBuf]) -> bool {
    private.iter().any(|p| path.starts_with(p))
        || path.components().any(|part| {
            matches!(
                part.as_os_str().to_str(),
                Some(".git" | "node_modules" | "target")
            )
        })
        || path
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|name| {
                name == ".DS_Store"
                    || name.starts_with("~$")
                    || [".tmp", ".swp", ".lock"]
                        .iter()
                        .any(|suffix| name.ends_with(suffix))
            })
}

fn file_events(event: notify::Event, private: &[PathBuf], tx: &mpsc::Sender<FileWrite>) {
    let kind = match event.kind {
        EventKind::Create(CreateKind::File | CreateKind::Any)
        | EventKind::Modify(ModifyKind::Name(
            RenameMode::Both | RenameMode::To | RenameMode::Any,
        )) => WriteKind::Created,
        EventKind::Modify(
            ModifyKind::Data(_) | ModifyKind::Any | ModifyKind::Metadata(MetadataKind::WriteTime),
        ) => WriteKind::Modified,
        EventKind::Remove(RemoveKind::File | RemoveKind::Any)
        | EventKind::Modify(ModifyKind::Name(RenameMode::From)) => WriteKind::Removed,
        _ => return,
    };
    let at = UnixMillis(now() as i64);
    for (index, path) in event.paths.into_iter().enumerate() {
        if ignored(&path, private) {
            continue;
        }
        let kind = if index == 0
            && matches!(
                event.kind,
                EventKind::Modify(ModifyKind::Name(RenameMode::Both))
            ) {
            WriteKind::Removed
        } else {
            kind
        };
        let kind = if kind == WriteKind::Removed {
            kind
        } else {
            match path.symlink_metadata() {
                Ok(meta) if meta.is_file() => kind,
                Ok(_) => continue,
                Err(e) if e.kind() == io::ErrorKind::NotFound => WriteKind::Removed,
                Err(error) => {
                    tracing::debug!(%error, "Discovery could not inspect a filesystem event");
                    continue;
                }
            }
        };
        if let Ok(path) = path.into_os_string().into_string()
            && tx.blocking_send(FileWrite { path, kind, at }).is_err()
        {
            return;
        }
    }
}

impl ChangeTracker {
    async fn observe(&self, writes: Vec<FileWrite>) -> Result<(), String> {
        self.store
            .observe_writes(
                writes,
                self.timing.debounce.as_millis() as i64,
                self.timing.window.as_millis() as i64,
                self.timing.cooldown.as_millis() as i64,
            )
            .await
            .map_err(reason)
    }
    async fn flush(&self, at: UnixMillis, stop: &CancellationToken) -> Result<(), String> {
        let probes = self
            .store
            .due_probes(at, BATCH as u32)
            .await
            .map_err(reason)?;
        if probes.is_empty() {
            return Ok(());
        }
        let roots = self.roots.clone();
        let cancel = stop.clone();
        let debounce_ms = self.timing.debounce.as_millis() as i64;
        let results = tokio::task::spawn_blocking(move || {
            let mut results = Vec::with_capacity(probes.len());
            for probe in probes {
                if cancel.is_cancelled() {
                    break;
                }
                if probe.cooldown_until.0 > at.0 {
                    let until = probe.cooldown_until;
                    results.push((probe, ProbeResult::RetryAt(until)));
                    continue;
                }
                let path = Path::new(&probe.path);
                let fp = match fingerprint(&roots, path, &cancel) {
                    Ok(Some(fp)) => ProbeResult::Stable(fp),
                    Ok(None) => ProbeResult::Missing,
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                        ProbeResult::RetryAt(UnixMillis(at.0 + debounce_ms))
                    }
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => break,
                    Err(e) if e.kind() == io::ErrorKind::NotFound => ProbeResult::Missing,
                    Err(error) => {
                        tracing::warn!(%error, "Discovery file fingerprint unavailable");
                        ProbeResult::Unreadable
                    }
                };
                results.push((probe, fp));
            }
            results
        })
        .await
        .map_err(reason)?;
        self.store.finish_probes(results).await.map_err(reason)
    }

    async fn run(&self, owner: &Owner, mut rx: mpsc::Receiver<FileWrite>) -> Result<(), String> {
        let mut schedules = owner.schedule_changes();
        let mut check_ready = true;
        let mut writes = Vec::new();
        loop {
            let at = UnixMillis(now() as i64);
            if check_ready {
                self.flush(at, &owner.stop).await?;
                if owner.stop.is_cancelled() {
                    return Ok(());
                }
                owner.wake_changed_discovery(at).await?;
            }
            let due = self.store.next_change_deadline(at).await.map_err(reason)?;
            let timer = async {
                match due {
                    Some(due) => {
                        tokio::time::sleep(Duration::from_millis(
                            (due as u64).saturating_sub(now()),
                        ))
                        .await
                    }
                    None => std::future::pending().await,
                }
            };
            tokio::select! { biased;
                _ = owner.stop.cancelled() => return Ok(()),
                n = rx.recv_many(&mut writes,BATCH) => {
                    if n == 0 {return Ok(())}
                    self.observe(std::mem::take(&mut writes)).await?;
                    check_ready = due.is_some_and(|t| t <= now() as i64);
                }
                _ = timer => check_ready = true,
                result = schedules.changed() => {result.map_err(reason)?; check_ready = true;}
            }
        }
    }
}

fn fingerprint(
    roots: &BTreeMap<PathBuf, Dir>,
    path: &Path,
    stop: &CancellationToken,
) -> io::Result<Option<Fingerprint>> {
    let Some((root, dir)) = roots.iter().find(|(p, _)| path.starts_with(p)) else {
        return Ok(None);
    };
    let mut relative = path.strip_prefix(root).expect("matched root").components();
    let Some(Component::Normal(name)) = relative.next_back() else {
        return Ok(None);
    };
    let mut parent = dir.try_clone()?;
    for comp in relative {
        let Component::Normal(part) = comp else {
            return Ok(None);
        };
        parent = parent.open_dir_nofollow(part)?;
    }
    let meta = parent.symlink_metadata(name)?;
    if !meta.is_file() {
        return Ok(None);
    }
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    cap_std::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NONBLOCK);
    let mut file = parent.open_with(name, &options)?.into_std();
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Ok(None);
    }
    let mtime = meta.modified()?;
    let mut hash = Sha256::new();
    let mut buf = [0; 64 * 1024];
    loop {
        if stop.is_cancelled() {
            return Err(io::ErrorKind::Interrupted.into());
        }
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    let after = file.metadata()?;
    if after.len() != meta.len() || after.modified()? != mtime {
        return Err(io::ErrorKind::WouldBlock.into());
    }
    Ok(Some(Fingerprint {
        mtime: UnixMillis(
            mtime
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64,
        ),
        hash: hex::encode(hash.finalize()),
    }))
}

impl Owner {
    pub(in crate::owner) fn start_change_tracker(self: &Arc<Self>) {
        if !self.settings.bot
            || !self.settings.scheduled_tasks
            || self.settings.workspace_roots.is_empty()
        {
            return;
        }
        let owner = self.clone();
        self.producers.spawn(async move {
            while !owner.stop.is_cancelled() {
                match owner.watch_discovery_changes().await {
                    Ok(()) => return,
                    Err(error) => tracing::warn!(%error, "Restarting discovery filesystem watcher"),
                }
                tokio::select! {
                    _ = owner.stop.cancelled() => return,
                    _ = tokio::time::sleep(Duration::from_secs(5)) => {}
                }
            }
        });
    }

    async fn watch_discovery_changes(&self) -> Result<(), String> {
        let state = self.store.owned_root().map_err(reason)?;
        let mut private = vec![
            state.canonical_path().into(),
            state.control_directory().into(),
            state.lock_path().into(),
        ];
        let configured = self.workspace_roots.clone();
        let roots = tokio::task::spawn_blocking(move || {
            configured
                .iter()
                .filter_map(workspace::Root::configured_directory)
                .map(|r| {
                    Ok((
                        r.path().to_path_buf(),
                        maka_fs_tools::directory::open(r.path(), &r.identity()?)?,
                    ))
                })
                .collect::<io::Result<BTreeMap<_, _>>>()
        })
        .await
        .map_err(reason)?
        .map_err(reason)?;
        let tracker = ChangeTracker {
            store: self.discovery.clone(),
            roots: Arc::new(roots),
            timing: Timing::default(),
        };
        let paths: Vec<_> = tracker
            .roots
            .keys()
            .filter(|p| !p.ancestors().skip(1).any(|a| tracker.roots.contains_key(a)))
            .cloned()
            .collect();
        let (tx, rx) = mpsc::channel(BATCH * 2);
        let (release, shutdown) = oneshot::channel::<()>();
        let watcher = tokio::task::spawn_blocking(move || {
            private.push(maka_sandbox::native_task_namespace().map_err(reason)?);
            let mut watcher = RecommendedWatcher::new(
                move |event: notify::Result<notify::Event>| match event {
                    Ok(event) if event.need_rescan() => {
                        tracing::warn!("Discovery filesystem event stream reported lost changes")
                    }
                    Ok(event) => file_events(event, &private, &tx),
                    Err(error) => tracing::warn!(%error, "Discovery filesystem watcher error"),
                },
                notify::Config::default().with_follow_symlinks(false),
            )
            .map_err(reason)?;
            for path in paths {
                watcher
                    .watch(&path, RecursiveMode::Recursive)
                    .map_err(reason)?;
            }
            Ok::<_, String>(watcher)
        });
        // Drain the bounded callback channel during registration. Close it before joining the OS watcher.
        let (watched, tracked) = tokio::join!(
            async {
                let watcher = watcher.await.map_err(reason)??;
                let _ = shutdown.await;
                tokio::task::spawn_blocking(move || drop(watcher))
                    .await
                    .map_err(reason)
            },
            async {
                let result = tracker.run(self, rx).await;
                drop(release);
                result
            }
        );
        watched?;
        tracked
    }

    pub(super) async fn discovery_changes(
        &self,
        approval: &BackgroundApproval,
        at: UnixMillis,
        limit: usize,
    ) -> Result<ChangeSnapshot, String> {
        let roots: Vec<_> = self
            .workspace_roots
            .iter()
            .filter_map(workspace::Root::configured_directory)
            .map(|r| r.path().to_path_buf())
            .collect();
        let policy = match &approval.sandbox_ceiling {
            Some(maka_sandbox::Sandbox::Managed { filesystem, .. }) => {
                Some(filesystem.compile().map_err(reason)?)
            }
            Some(maka_sandbox::Sandbox::External { .. }) => return Ok(ChangeSnapshot::default()),
            _ => None,
        };
        self.discovery
            .change_snapshot(at, limit, move |path| {
                roots.iter().any(|r| path.starts_with(r))
                    && policy.as_ref().is_none_or(|p| p.access(path).can_read())
            })
            .await
            .map_err(reason)
    }

    async fn wake_changed_discovery(&self, at: UnixMillis) -> Result<(), String> {
        if self.scheduler.investigation.read().unwrap().is_some()
            || !self.discovery.has_ready_changes(at).await.map_err(reason)?
        {
            return Ok(());
        }
        let Some(_producer) = self.producer().await else {
            return Ok(());
        };
        let _gate = self.scheduler.gate.lock().await;
        if self.scheduler.investigation.read().unwrap().is_some() {
            return Ok(());
        }
        let mut catalog = self.scheduler.load_change_plans().await?;
        if catalog.plans.values().any(|s| {
            s.plan
                .pending
                .as_ref()
                .is_some_and(|f| matches!(f.effect, ScheduledEffect::Discovery { .. }))
        }) {
            return Ok(());
        }
        for saved in catalog.plans.values() {
            let plan = &saved.plan;
            let Some((approval, tools)) = scheduler::file_change_grant(plan) else {
                continue;
            };
            if plan.task.expires_at.is_some_and(|end| end <= at.0) {
                continue;
            }
            let source = match self.session(&approval.target.session_id).await {
                Ok(source) => source,
                Err(e) if e == "agent_session_unavailable" => continue,
                Err(e) => return Err(e),
            };
            let names = self.discovery_worker_tools(
                &tools.names,
                source.configuration.tools.as_deref(),
                plan.task.effect.selected_discovery_tools(),
            );
            if check_target(&source, &approval.target).is_err()
                || !self.discovery_reads_files(&names)
                || self
                    .discovery_changes(approval, at, 1)
                    .await?
                    .deltas
                    .is_empty()
            {
                continue;
            }
            let mut plan = plan.clone();
            let id = plan.task.id.clone();
            plan.task.next_fire_at = Some(at.0);
            plan.claim(at.0).map_err(reason)?;
            self.scheduler
                .commit(&mut catalog, &id, Some(plan), None)
                .await?;
            self.scheduler.wake.notify_one();
            break;
        }
        Ok(())
    }

    pub(super) fn discovery_reads_files(&self, tools: &[String]) -> bool {
        tools
            .iter()
            .any(|name| self.discovery_tool_group(name) == DiscoveryToolGroup::ReadFiles)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::discovery::SourceUri;
    use maka_agent_facts::durable::RunOwner;
    use maka_agent_state::discovery::changes::DeltaKind;
    use maka_event_log::root::{RootNamespaces, RootOwner};

    #[test]
    fn discovery_ignores_internal_outputs_and_temporary_files_at_any_depth() {
        let private = [PathBuf::from("/work/state")];
        for path in [
            "state/staging/a.md",
            "state/runtime-rust.sqlite-wal",
            ".git/refs/t",
            "p/node_modules/a",
            "p/target/out",
            ".DS_Store",
            "x.tmp",
            "~$doc",
            "x.swp",
            "a.lock",
        ] {
            assert!(ignored(&Path::new("/work").join(path), &private), "{path}");
        }
        for path in [
            "staging/notes.md",
            ".github/readme",
            "targeted/plan",
            "notes/.draft",
        ] {
            assert!(!ignored(&Path::new("/work").join(path), &private), "{path}");
        }
    }

    #[tokio::test]
    async fn discovery_quiet_probes_and_cooldown_coalesce_across_restarts() {
        let dir = tempfile::tempdir().unwrap();
        let state = RootOwner::create(
            &dir.path().join("state"),
            &RootNamespaces {
                ownership: dir.path().join("own"),
                control: dir.path().join("ctl"),
            },
        )
        .unwrap();
        let migrations = maka_event_log::ROOT_MIGRATIONS
            .iter()
            .chain(maka_agent_state::MIGRATIONS)
            .copied()
            .collect::<Vec<_>>();
        let root = RootStore::open(Arc::new(state), &migrations).await.unwrap();
        let owner = RunOwner {
            deployment: Uuid::new_v4(),
            namespace: maka_plugin_core::composition::InstanceId(vec![Uuid::new_v4()]),
        };
        let store = DiscoveryStore::new(root.data_writer().unwrap(), &owner).unwrap();
        let work = dir.path().join("arbitrary");
        std::fs::create_dir(&work).unwrap();
        let roots = Arc::new(BTreeMap::from([(
            work.clone(),
            Dir::open_ambient_dir(&work, cap_std::ambient_authority()).unwrap(),
        )]));
        let timing = Timing {
            debounce: Duration::from_millis(10),
            window: Duration::from_millis(240),
            cooldown: Duration::from_millis(600),
        };
        let tracker = ChangeTracker {
            store: store.clone(),
            roots: roots.clone(),
            timing,
        };
        let cancel = CancellationToken::new();
        let write = |name: &str, at, created| FileWrite {
            path: work.join(name).to_str().unwrap().into(),
            at: UnixMillis(at),
            kind: if created {
                WriteKind::Created
            } else {
                WriteKind::Modified
            },
        };
        let snapshot = |at| store.change_snapshot(UnixMillis(at), 15, |_| true);
        let file = work.join("terms.md");
        std::fs::write(&file, "first").unwrap();
        tracker
            .observe(vec![
                write("terms.md", 100, true),
                write("terms.md", 102, false),
            ])
            .await
            .unwrap();
        tracker.flush(UnixMillis(111), &cancel).await.unwrap();
        assert!(snapshot(111).await.unwrap().deltas.is_empty());
        tracker.flush(UnixMillis(112), &cancel).await.unwrap();
        let quiet = snapshot(112).await.unwrap();
        assert_eq!(quiet.deltas.len(), 1);
        assert_eq!(quiet.deltas[0].kind, DeltaKind::Created);
        root.data_writer()
            .unwrap()
            .write(store.acknowledge_changes(quiet.deltas))
            .await
            .unwrap();
        let uri = SourceUri(file.to_str().unwrap().into());
        let before = store.get_source_cursor(uri.clone()).await.unwrap().unwrap();
        std::fs::write(&file, "first").unwrap();
        tracker
            .observe(vec![write("terms.md", 120, false)])
            .await
            .unwrap();
        tracker.flush(UnixMillis(130), &cancel).await.unwrap();
        assert!(snapshot(130).await.unwrap().deltas.is_empty());
        let after = store.get_source_cursor(uri).await.unwrap().unwrap();
        assert_eq!(after.last_hash, before.last_hash);
        assert!(after.last_mtime_ms.0 > 0);
        std::fs::write(work.join("another"), "new").unwrap();
        tracker
            .observe(vec![write("another", 140, true)])
            .await
            .unwrap();
        tracker.flush(UnixMillis(150), &cancel).await.unwrap();
        assert_eq!(snapshot(150).await.unwrap().deltas.len(), 1);
        std::fs::write(&file, "revised").unwrap();
        tracker
            .observe(vec![write("terms.md", 160, false)])
            .await
            .unwrap();
        let tracker = ChangeTracker {
            store: DiscoveryStore::new(root.data_writer().unwrap(), &owner).unwrap(),
            roots,
            timing,
        };
        tracker.flush(UnixMillis(170), &cancel).await.unwrap();
        let hot = snapshot(170).await.unwrap();
        assert!(hot.deltas.is_empty());
        assert_eq!(
            hot.cooling,
            [(work.to_str().unwrap().into(), UnixMillis(760))]
        );
        tracker
            .observe(vec![write("terms.md", 500, false)])
            .await
            .unwrap();
        tracker.flush(UnixMillis(510), &cancel).await.unwrap();
        assert!(snapshot(760).await.unwrap().deltas.is_empty());
        tracker.flush(UnixMillis(1100), &cancel).await.unwrap();
        let cooled = snapshot(1100).await.unwrap();
        assert!(cooled.cooling.is_empty());
        assert_eq!(cooled.deltas.len(), 1);
        assert_eq!(cooled.deltas[0].kind, DeltaKind::Directory);
        assert_eq!(Path::new(&cooled.deltas[0].path), work);
        root.data_writer()
            .unwrap()
            .write(store.acknowledge_changes(cooled.deltas))
            .await
            .unwrap();
        assert!(snapshot(1101).await.unwrap().deltas.is_empty());
        // Editors can replace an existing file by renaming over it, even preserving its mtime.
        let modified = std::fs::metadata(&file).unwrap().modified().unwrap();
        std::fs::write(&file, "latest").unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        tracker
            .observe(vec![write("terms.md", 1400, true)])
            .await
            .unwrap();
        tracker.flush(UnixMillis(1410), &cancel).await.unwrap();
        let revised = snapshot(1410).await.unwrap();
        assert_eq!(revised.deltas.len(), 1);
        assert_eq!(revised.deltas[0].kind, DeltaKind::Modified);
    }
}
