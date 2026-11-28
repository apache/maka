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

//! Observe workspace content and explicit file watches. All quiet periods use event time in milliseconds.
use super::roots::{CacheTags, DeltaRoots, Directories, TAG, host_path};
use super::*;
use cap_fs_ext::{FollowSymlinks, MetadataExt, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use maka_agent_state::discovery::{
    DiscoveryStore,
    changes::{
        ChangeQuery, ChangeSnapshot, DeltaKind, FileWrite, Fingerprint, ProbeResult, WriteKind,
    },
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
use tokio::sync::{broadcast, mpsc, watch};

const BATCH: usize = 128;

#[derive(Clone, Copy)]
pub(in crate::owner) struct Timing {
    pub(in crate::owner) debounce: Duration,
    window: Duration,
    cooldown: Duration,
}
impl Default for Timing {
    fn default() -> Self {
        Self {
            debounce: Duration::from_secs(120),
            window: Duration::from_secs(4 * 60),
            cooldown: Duration::from_secs(10 * 60),
        }
    }
}
struct ChangeTracker {
    store: DiscoveryStore,
    roots: Arc<BTreeMap<PathBuf, Dir>>,
    timing: Timing,
    routing: watch::Receiver<Arc<Routing>>,
}

pub(super) fn ignored(path: &Path, private: &[PathBuf]) -> bool {
    private.iter().any(|p| path.starts_with(p))
        || path
            .ancestors()
            .any(|p| match p.file_name().and_then(|s| s.to_str()) {
                Some(
                    ".git" | "__pycache__" | ".venv" | ".next" | ".nuxt" | ".Trash"
                    | "node_modules" | "target" | "Caches" | "Logs",
                ) => true,
                Some(name) => [".photoslibrary", ".musiclibrary", ".tvlibrary"]
                    .iter()
                    .any(|s| name.ends_with(s)),
                None => false,
            })
        || path
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|name| {
                matches!(name, TAG | ".DS_Store")
                    || name.starts_with("~$")
                    || [
                        ".tmp",
                        ".swp",
                        ".swo",
                        ".lock",
                        ".log",
                        "-wal",
                        "-shm",
                        "-journal",
                        ".crdownload",
                        ".part",
                    ]
                    .iter()
                    .any(|suffix| name.ends_with(suffix))
            })
}

pub(super) fn visible_in_workspace(
    path: &Path,
    directory: bool,
    is_root: impl Fn(&Path) -> bool,
) -> bool {
    let dir = if directory {
        path
    } else {
        path.parent().unwrap_or(path)
    };
    for ancestor in dir.ancestors() {
        if is_root(ancestor) {
            return true;
        }
        if ancestor
            .file_name()
            .is_some_and(|name| name.as_encoded_bytes().starts_with(b"."))
        {
            break;
        }
    }
    false
}

#[derive(Default)]
struct Routing {
    deltas: DeltaRoots,
    files: BTreeMap<PathBuf, Vec<String>>,
}

impl Routing {
    fn file_events(
        &self,
        event: notify::Event,
        roots: &Directories,
        tags: &mut CacheTags,
        tx: &mpsc::Sender<FileWrite>,
        watch_paths: &broadcast::Sender<String>,
        reload: &watch::Sender<()>,
    ) {
        if !matches!(
            event.kind,
            EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
        ) {
            return;
        }
        let structural = matches!(
            event.kind,
            EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_))
        );
        let kind = match event.kind {
            EventKind::Create(CreateKind::File | CreateKind::Any)
            | EventKind::Modify(ModifyKind::Name(
                RenameMode::Both | RenameMode::To | RenameMode::Any,
            )) => Some(WriteKind::Created),
            EventKind::Modify(
                ModifyKind::Data(_)
                | ModifyKind::Any
                | ModifyKind::Metadata(MetadataKind::WriteTime),
            ) => Some(WriteKind::Modified),
            EventKind::Remove(RemoveKind::File | RemoveKind::Any)
            | EventKind::Modify(ModifyKind::Name(RenameMode::From)) => Some(WriteKind::Removed),
            _ => None,
        };
        let at = UnixMillis(now() as i64);
        for (index, path) in event.paths.into_iter().enumerate() {
            let Ok(path) = host_path(&path) else { continue };
            let marker = path.file_name().is_some_and(|n| n == TAG);
            if structural || marker {
                tags.invalidate(path);
            }
            let parent = path.parent();
            let home_child = parent.is_some() && parent == self.deltas.home.as_deref();
            let tagged_root = marker
                && parent.is_some_and(|p| {
                    self.deltas.recursive.contains(p)
                        || self
                            .deltas
                            .home
                            .as_deref()
                            .is_some_and(|home| p == home || p.parent() == Some(home))
                });
            if tagged_root
                || (structural
                    && home_child
                    && path.file_name().is_some_and(roots::home_child)
                    && !matches!(
                        event.kind,
                        EventKind::Create(CreateKind::File) | EventKind::Remove(RemoveKind::File)
                    ))
            {
                reload.send_replace(());
            }
            let Some(kind) = kind else { continue };
            if let Some(targets) = self.files.get(path) {
                for target in targets {
                    let _ = watch_paths.send(target.clone());
                }
            }
            if marker
                || !self.deltas.permits(path, false)
                || path.parent().is_none_or(|dir| tags.ignored(dir, roots))
            {
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
            if tx
                .blocking_send(FileWrite {
                    path: path.to_str().expect("host path").into(),
                    kind,
                    at,
                })
                .is_err()
            {
                return;
            }
        }
    }
}

fn watch_files<W: Watcher>(
    roots: Arc<Directories>,
    mut updates: mpsc::Receiver<Routing>,
    route: watch::Sender<Arc<Routing>>,
    tx: mpsc::Sender<FileWrite>,
    watch_paths: broadcast::Sender<String>,
    reload: watch::Sender<()>,
    config: notify::Config,
) -> Result<(), String> {
    let mut current = route.subscribe();
    let dirs = roots.clone();
    let mut tags = CacheTags::default();
    let topology = reload.clone();
    let mut watcher = W::new(
        move |event: notify::Result<notify::Event>| match event {
            Ok(event) if event.need_rescan() => {
                tags = CacheTags::default();
                topology.send_replace(());
                tracing::warn!("Discovery filesystem event stream reported lost changes");
            }
            Ok(event) => {
                if current.has_changed().unwrap_or(false) {
                    tags = CacheTags::default();
                }
                let routing = current.borrow_and_update().clone();
                routing.file_events(event, &dirs, &mut tags, &tx, &watch_paths, &topology);
            }
            Err(error) => tracing::warn!(%error, "Discovery filesystem watcher error"),
        },
        config.with_follow_symlinks(false),
    )
    .map_err(reason)?;
    let mut installed: BTreeMap<PathBuf, RecursiveMode> = BTreeMap::new();
    while let Some(routing) = updates.blocking_recv() {
        let wanted = routing
            .deltas
            .subscriptions(&roots, routing.files.keys().map(PathBuf::as_path), |_| true)
            .map_err(reason)?;
        let new_home = routing
            .deltas
            .home
            .as_ref()
            .is_some_and(|p| !installed.contains_key(p) && wanted.contains_key(p));
        route.send_replace(Arc::new(routing));
        if wanted == installed {
            continue;
        }
        let mut operations = Vec::new();
        for (path, mode) in &installed {
            if wanted.get(path) != Some(mode) {
                operations.push(notify::PathOp::unwatch(path.clone()));
            }
        }
        let mut next = wanted;
        for (path, mode) in &next {
            if installed.get(path) != Some(mode) {
                operations.push(notify::PathOp::Watch(
                    path.clone(),
                    notify::WatchPathConfig::new(*mode),
                ));
            }
        }
        while !operations.is_empty() {
            let Err(error) = watcher.update_paths(operations) else {
                break;
            };
            match &error.origin {
                Some(notify::PathOp::Unwatch(_))
                    if matches!(
                        error.source.kind,
                        notify::ErrorKind::WatchNotFound | notify::ErrorKind::PathNotFound
                    ) => {}
                Some(notify::PathOp::Watch(path, _))
                    if matches!(error.source.kind, notify::ErrorKind::PathNotFound)
                        || matches!(&error.source.kind, notify::ErrorKind::Io(e) if matches!(e.kind(), io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied)) =>
                {
                    tracing::debug!(%error, ?path, "Discovery directory unavailable");
                    next.remove(path);
                }
                _ => return Err(reason(error)),
            }
            operations = error.remaining;
        }
        installed = next;
        // Cover children created between the first enumeration and registration of the home directory.
        if new_home {
            reload.send_replace(());
        }
    }
    Ok(())
}

fn inspect_files(mut writes: Vec<FileWrite>) -> Vec<FileWrite> {
    writes.retain_mut(|write| {
        if write.kind == WriteKind::Removed {
            return true;
        }
        match Path::new(&write.path).symlink_metadata() {
            Ok(meta) => meta.is_file(),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                write.kind = WriteKind::Removed;
                true
            }
            Err(error) => {
                tracing::debug!(%error, "Discovery could not inspect a filesystem event");
                false
            }
        }
    });
    writes
}

impl ChangeTracker {
    async fn observe_events(&self, writes: Vec<FileWrite>) -> Result<Option<i64>, String> {
        let files = tokio::task::spawn_blocking(move || inspect_files(writes))
            .await
            .map_err(reason)?;
        if files.is_empty() {
            return Ok(None);
        }
        self.observe(files).await?;
        self.store
            .next_change_deadline(UnixMillis(now() as i64))
            .await
            .map_err(reason)
    }

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
        let routing = self.routing.borrow().clone();
        let debounce_ms = self.timing.debounce.as_millis() as i64;
        let results = tokio::task::spawn_blocking(move || {
            let mut results = Vec::with_capacity(probes.len());
            let mut tags = CacheTags::default();
            for probe in probes {
                if cancel.is_cancelled() {
                    break;
                }
                let path = host_path(Path::new(&probe.path)).expect("stored UTF-8 path");
                if !routing.deltas.permits(path, false)
                    || path.parent().is_none_or(|dir| tags.ignored(dir, &roots))
                {
                    results.push((probe, ProbeResult::Unreadable));
                    continue;
                }
                if probe.cooldown_until.0 > at.0 {
                    let until = probe.cooldown_until;
                    results.push((probe, ProbeResult::RetryAt(until)));
                    continue;
                }
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
        let mut scopes = self.routing.clone();
        scopes.changed().await.map_err(reason)?;
        let mut plan_due = None;
        let mut probe_due = Some(0_i64);
        let mut writes = Vec::new();
        loop {
            let due = probe_due.into_iter().chain(plan_due).min();
            let timer = async {
                let Some(due) = due else {
                    return std::future::pending().await;
                };
                let delay = due.saturating_sub(now() as i64);
                if delay > 0 {
                    tokio::time::sleep(Duration::from_millis(delay as u64)).await;
                }
            };
            tokio::select! { biased;
                _ = owner.stop.cancelled() => return Ok(()),
                result = schedules.changed() => {
                    result.map_err(reason)?;

                }
                result = scopes.changed() => { result.map_err(reason)?; }
                _ = timer => {}
                n = rx.recv_many(&mut writes, BATCH) => {
                    if n == 0 { return Ok(()) }
                    let next = self.observe_events(std::mem::take(&mut writes)).await?;
                    probe_due = probe_due.into_iter().chain(next).min();
                    continue;
                }
            }
            let at = UnixMillis(now() as i64);
            self.flush(at, &owner.stop).await?;
            if owner.stop.is_cancelled() {
                return Ok(());
            }
            plan_due = owner.wake_changed_discovery(at).await?;
            probe_due = self.store.next_change_deadline(at).await.map_err(reason)?;
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
    fingerprint_in(dir, path.strip_prefix(root).expect("matched root"), stop)
}

pub(super) fn fingerprint_in(
    dir: &Dir,
    path: &Path,
    stop: &CancellationToken,
) -> io::Result<Option<Fingerprint>> {
    let mut relative = path.components();
    let Some(Component::Normal(name)) = relative.next_back() else {
        return Ok(None);
    };
    let open_parent = || -> io::Result<Dir> { roots::open_relative(dir, relative.as_path()) };
    let parent = open_parent()?;
    let meta = parent.symlink_metadata(name)?;
    if !meta.is_file() {
        return Ok(None);
    }
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    cap_std::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NONBLOCK);
    let file = parent.open_with(name, &options)?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Ok(None);
    }
    let mtime = meta.modified()?;
    let mut reader = (&file).take(meta.len());
    let mut hash = Sha256::new();
    let mut buf = [0; 64 * 1024];
    loop {
        if stop.is_cancelled() {
            return Err(io::ErrorKind::Interrupted.into());
        }
        let n = reader.read(&mut buf)?;
        if n == 0 {
            if reader.limit() != 0 {
                return Err(io::ErrorKind::WouldBlock.into());
            }
            break;
        }
        hash.update(&buf[..n]);
    }
    // An editor can replace the directory entry while the original descriptor is being hashed.
    let after = open_parent()?.symlink_metadata(name)?;
    if !after.is_file()
        || after.dev() != meta.dev()
        || after.ino() != meta.ino()
        || after.len() != meta.len()
        || after.modified()? != mtime
    {
        return Err(io::ErrorKind::WouldBlock.into());
    }
    Ok(Some(Fingerprint {
        mtime: UnixMillis(
            mtime
                .into_std()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64,
        ),
        hash: hex::encode(hash.finalize()),
    }))
}

impl Owner {
    async fn active_discovery_workspaces(&self) -> Result<BTreeSet<PathBuf>, String> {
        let _gate = self.scheduler.gate.lock().await;
        // One-shot plans can select a hidden workspace for their scheduled opening too.
        let catalog = self.scheduler.load_ready(i64::MAX).await?;
        let at = now() as i64;
        Ok(catalog
            .plans
            .values()
            .filter_map(|saved| {
                let plan = &saved.plan;
                let Some(scheduler::Approval::Discovery { approval, .. }) = &plan.authorization
                else {
                    return None;
                };
                let path = Path::new(&approval.target.workspace.path);
                (plan.task.status == maka_scheduler::task::Status::Active
                    && plan.task.expires_at.is_none_or(|end| end > at)
                    && path
                        .ancestors()
                        .any(|dir| self.watch_scopes.directories.contains_key(dir)))
                .then(|| path.to_path_buf())
            })
            .collect())
    }

    pub(in crate::owner) fn start_change_tracker(self: &Arc<Self>) {
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
        let track_deltas = self.settings.bot
            && self.settings.scheduled_tasks
            && !self.settings.workspace_roots.is_empty();
        let roots = self.watch_scopes.directories.clone();
        if !track_deltas {
            let mut registrations = self.watch_runner.changes.subscribe();
            while self
                .discovery
                .next_watch_due(maka_agent_facts::discovery::WatchKind::FileHash)
                .await
                .map_err(reason)?
                .is_none()
            {
                tokio::select! {
                    _ = self.stop.cancelled() => return Ok(()),
                    result = registrations.changed() => result.map_err(reason)?,
                }
            }
        }
        let (route, routing) = watch::channel(Arc::new(Routing::default()));
        let tracker = ChangeTracker {
            store: self.discovery.clone(),
            roots: roots.clone(),
            timing: self.watch_scopes.timing,
            routing,
        };
        let (tx, rx) = mpsc::channel(BATCH * 2);
        let (updates, changes) = mpsc::channel(1);
        let watch_paths = self.watch_runner.paths.clone();
        let (reload, topology) = watch::channel(());
        let watcher = tokio::task::spawn_blocking(move || {
            watch_files::<RecommendedWatcher>(
                roots,
                changes,
                route,
                tx,
                watch_paths,
                reload,
                notify::Config::default(),
            )
        });
        tokio::try_join!(
            async { watcher.await.map_err(reason)? },
            self.watch_subscriptions(track_deltas, updates, topology),
            async {
                if track_deltas {
                    tracker.run(self, rx).await
                } else {
                    self.stop.cancelled().await;
                    Ok(())
                }
            },
        )?;
        Ok(())
    }

    async fn file_watch_targets(&self) -> Result<BTreeMap<PathBuf, Vec<String>>, String> {
        let state = self.store.owned_root().map_err(reason)?;
        let discovery = host_path(state.canonical_path())
            .map_err(reason)?
            .join("discovery");
        let mut files = BTreeMap::new();
        for target in self.discovery.file_watch_targets().await.map_err(reason)? {
            let path = discovery.join(&target);
            files
                .entry(host_path(&path).map_err(reason)?.to_owned())
                .or_insert_with(Vec::new)
                .push(target);
        }
        Ok(files)
    }

    async fn watch_subscriptions(
        &self,
        track: bool,
        updates: mpsc::Sender<Routing>,
        mut topology: watch::Receiver<()>,
    ) -> Result<(), String> {
        let mut scopes = self.watch_scopes.changed.subscribe();
        let mut registrations = self.watch_runner.changes.subscribe();
        let mut dossiers = self.discovery.subscribe();
        let mut schedules = self.schedule_changes();
        let mut active = if track {
            self.active_discovery_workspaces().await?
        } else {
            BTreeSet::new()
        };
        let mut files = self.file_watch_targets().await?;
        loop {
            let deltas = if track {
                let mut roots = active.clone();
                roots.extend(self.watch_scopes.directories.keys().cloned());
                self.watch_scopes
                    .delta_roots(roots, watch_scope::ScopeView::Watcher)
            } else {
                DeltaRoots::default()
            };
            updates
                .send(Routing {
                    deltas,
                    files: files.clone(),
                })
                .await
                .map_err(reason)?;
            loop {
                tokio::select! {
                    _ = self.stop.cancelled() => return Ok(()),
                    result = scopes.changed() => { result.map_err(reason)?; break; }
                    result = topology.changed() => { result.map_err(reason)?; break; }
                    result = async { tokio::select! {
                        r = registrations.changed() => r,
                        r = dossiers.changed(), if !files.is_empty() => r,
                    } } => {
                        result.map_err(reason)?;
                        let next = self.file_watch_targets().await?;
                        if next != files { files = next; break; }
                    }
                    result = schedules.changed(), if track => {
                        result.map_err(reason)?;
                        let next = self.active_discovery_workspaces().await?;
                        if next != active { active = next; break; }
                    }
                }
            }
        }
    }

    pub(super) async fn discovery_changes(
        &self,
        approval: &BackgroundApproval,
        at: UnixMillis,
        query: ChangeQuery,
    ) -> Result<ChangeSnapshot, String> {
        let selected = Path::new(&approval.target.workspace.path);
        let roots = self
            .watch_scopes
            .directories
            .keys()
            .map(|p| discovery_root(p, selected).to_owned())
            .collect();
        let scope = self
            .watch_scopes
            .delta_roots(roots, watch_scope::ScopeView::Workspace);
        let caps = self.watch_scopes.directories.clone();
        let mut tags = CacheTags::default();
        let policy = match &approval.sandbox_ceiling {
            Some(maka_sandbox::Sandbox::Managed { filesystem, .. }) => {
                Some(filesystem.compile().map_err(reason)?)
            }
            Some(maka_sandbox::Sandbox::External { .. }) => return Ok(ChangeSnapshot::default()),
            _ => None,
        };
        if matches!(query, ChangeQuery::Opening { .. }) {
            // Prune stale/deleted or newly-excluded cursors so removed temp directories
            // and excluded trees do not replay ghost deltas across subsequent turns.
            let prune_scope = self.watch_scopes.delta_roots(
                self.watch_scopes
                    .directories
                    .keys()
                    .map(|p| discovery_root(p, selected).to_owned())
                    .collect(),
                watch_scope::ScopeView::Workspace,
            );
            let prune_root = selected.to_owned();
            let _ = self
                .discovery
                .prune_cursors_matching(move |path| {
                    if !path.starts_with(&prune_root) {
                        return false;
                    }
                    let Ok(path) = host_path(path) else {
                        return true;
                    };
                    if !prune_scope.permits(path, false) && !prune_scope.permits(path, true) {
                        return true;
                    }
                    // If the path and its parent directory are both gone, it's a deleted
                    // directory tree (e.g. removed worktree) whose orphan deltas should vanish.
                    !path.exists() && path.parent().is_some_and(|parent| !parent.exists())
                })
                .await;
        }
        self.discovery
            .change_snapshot(at, query, move |path, kind| {
                let Ok(path) = host_path(path) else {
                    return false;
                };
                let directory = kind == DeltaKind::Directory;
                scope.permits(path, directory)
                    && policy.as_ref().is_none_or(|p| p.access(path).can_read())
                    && !tags.ignored(
                        if directory {
                            path
                        } else {
                            path.parent().unwrap_or(path)
                        },
                        &caps,
                    )
            })
            .await
            .map_err(reason)
    }

    pub(super) async fn wander_sources(
        &self,
        approval: &BackgroundApproval,
    ) -> Result<Vec<String>, String> {
        let selected = &approval.target.workspace;
        let dir =
            workspace::open_workspace(&self.workspace_roots, selected, &self.managed_worktrees)
                .await?;
        let root = PathBuf::from(&selected.path);
        let scope = Arc::new(
            self.watch_scopes
                .delta_roots([root.clone()].into(), watch_scope::ScopeView::Workspace),
        );
        let reserved = access::reserved_sandbox_floor(&self.store, selected).await?;
        let ceiling = match &approval.sandbox_ceiling {
            Some(maka_sandbox::Sandbox::External { .. }) => return Ok(vec![]),
            Some(ceiling) => reserved.intersect(ceiling).map_err(reason)?,
            None => reserved,
        };
        let maka_sandbox::Sandbox::Managed { filesystem, .. } = ceiling else {
            return Ok(vec![]);
        };
        let policy = Arc::new(filesystem.compile().map_err(reason)?);
        let can_list_root = policy.access(&root).can_read() && scope.permits(&root, true);
        let caps = if root
            .ancestors()
            .any(|p| self.watch_scopes.directories.contains_key(p))
        {
            self.watch_scopes.directories.clone()
        } else {
            Arc::new([(root.clone(), dir.try_clone().map_err(reason)?)].into())
        };
        let includes = scope
            .recursive
            .iter()
            .filter(|p| **p != root && scope.permits(p, true) && policy.access(p).can_read())
            .filter_map(|p| p.to_str().map(str::to_owned))
            .collect::<Vec<_>>();
        let base = root.clone();
        let mut tags = CacheTags::default();
        let scan_caps = caps.clone();
        let allowed = move |p: &Path| {
            let Ok(p) = host_path(p) else { return false };
            p != base
                && p.starts_with(&base)
                && scope.permits(p, true)
                && policy.access(p).can_read()
                && !tags.source_ignored(p, &caps)
        };
        let at = UnixMillis(now() as i64);
        // Prefer targets from the durable WorkspaceMap (due frontier + due mapped sources)
        // when available so Wander follows the semantic map rather than blind top-level names.
        if let Ok((_, map)) = self.scheduler.workspace_map(&root).await
            && (!map.sources.is_empty() || !map.frontier.is_empty())
        {
            let mut permit_map = allowed.clone();
            let picked = map.select_wander_targets(&root, at.0, 3, move |p| permit_map(p));
            if !picked.is_empty() {
                return Ok(picked
                    .into_iter()
                    .filter_map(|t| t.path.to_str().map(str::to_owned))
                    .collect());
            }
        }
        if !includes.is_empty() {
            self.discovery
                .seed_cold_sources(includes, at)
                .await
                .map_err(reason)?;
        }
        let pick_bucketed = |candidates: Vec<String>, base: &Path, limit: usize| -> Vec<String> {
            let mut chosen = Vec::with_capacity(limit);
            let mut buckets = BTreeSet::new();
            let mut rest = Vec::new();
            for path in candidates {
                let bucket = Path::new(&path)
                    .strip_prefix(base)
                    .ok()
                    .and_then(|rel| rel.components().next())
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .unwrap_or_default();
                if chosen.len() < limit && buckets.insert(bucket) {
                    chosen.push(path);
                } else {
                    rest.push(path);
                }
            }
            for path in rest {
                if chosen.len() >= limit {
                    break;
                }
                chosen.push(path);
            }
            chosen
        };
        let cold = self
            .discovery
            .cold_sources(at, 24, allowed.clone())
            .await
            .map_err(reason)?;
        if cold.len() > 3 || !can_list_root {
            return Ok(pick_bucketed(cold, &root, 3));
        }
        let mut permit = allowed.clone();
        let (batches, mut pending) = mpsc::channel(1);
        let scan_root = root.clone();
        let scan = tokio::task::spawn_blocking(move || {
            if CacheTags::default().ignored(&scan_root, &scan_caps) {
                return Ok(());
            }
            let mut paths = Vec::with_capacity(BATCH);
            for entry in dir.entries()? {
                let entry = entry?;
                let path = scan_root.join(entry.file_name());
                if permit(&path)
                    && let Some(path) = path.to_str()
                {
                    paths.push(path.to_owned());
                    if paths.len() == BATCH {
                        batches
                            .blocking_send(std::mem::take(&mut paths))
                            .map_err(io::Error::other)?;
                    }
                }
            }
            if !paths.is_empty() {
                batches.blocking_send(paths).map_err(io::Error::other)?;
            }
            Ok::<_, io::Error>(())
        });
        while let Some(paths) = pending.recv().await {
            self.discovery
                .seed_cold_sources(paths, at)
                .await
                .map_err(reason)?;
        }
        scan.await.map_err(reason)?.map_err(reason)?;
        let candidates = self
            .discovery
            .cold_sources(at, 24, allowed)
            .await
            .map_err(reason)?;
        Ok(pick_bucketed(candidates, &root, 3))
    }

    async fn wake_changed_discovery(&self, at: UnixMillis) -> Result<Option<i64>, String> {
        if self.scheduler.investigation.read().unwrap().is_some()
            || !self.discovery.has_ready_changes(at).await.map_err(reason)?
        {
            return Ok(None);
        }
        let Some(_producer) = self.producer().await else {
            return Ok(None);
        };
        let scopes = self.watch_scopes.changed.subscribe();
        let schedules = self.schedule_changes();
        let catalog = {
            let _gate = self.scheduler.gate.lock().await;
            self.scheduler.load_change_plans().await?
        };
        if catalog.has_pending_discovery() {
            return Ok(None);
        }
        let mut next_cooldown = None;
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
                    .discovery_changes(approval, at, ChangeQuery::FirstReady)
                    .await?
                    .deltas
                    .is_empty()
            {
                continue;
            }
            if let Some(last) = plan.task.last_fire_at {
                let until = last.saturating_add(file_change_cooldown_ms(&plan.task.schedule));
                if at.0 < until {
                    next_cooldown = Some(next_cooldown.map_or(until, |t: i64| t.min(until)));
                    continue;
                }
            }
            let mut plan = plan.clone();
            let id = plan.task.id.clone();
            if plan
                .claim_preserving_schedule(at.0, FireSource::FileChange)
                .map_err(reason)?
                .is_none()
            {
                continue;
            }
            // Scope edits and other openings can invalidate the snapshot while the gate is free.
            let _scope = self.watch_scopes.edits.lock().await;
            let _gate = self.scheduler.gate.lock().await;
            if scopes.has_changed().map_err(reason)? || schedules.has_changed().map_err(reason)? {
                return Ok(Some(at.0));
            }
            let mut catalog = self.scheduler.load_change_plans().await?;
            if catalog.has_pending_discovery()
                || self.scheduler.investigation.read().unwrap().is_some()
            {
                return Ok(None);
            }
            if catalog
                .plans
                .get(&id)
                .is_none_or(|live| live.revision != saved.revision)
            {
                return Ok(Some(at.0));
            }
            self.scheduler
                .commit(&mut catalog, &id, Some(plan), None)
                .await?;
            self.scheduler.wake.notify_one();
            return Ok(None);
        }
        Ok(next_cooldown)
    }

    pub(super) fn discovery_reads_files(&self, tools: &[String]) -> bool {
        tools
            .iter()
            .any(|name| self.discovery_tool_group(name) == DiscoveryToolGroup::ReadFiles)
    }
}

fn discovery_root<'a>(configured: &'a Path, selected: &'a Path) -> &'a Path {
    if selected.starts_with(configured) && selected != configured {
        selected
    } else {
        configured
    }
}

fn file_change_cooldown_ms(schedule: &TaskSchedule) -> i64 {
    const MAX_MS: i64 = 900_000;
    match schedule {
        TaskSchedule::Interval { every_seconds, .. } => {
            (i64::from(*every_seconds) * 1000 / 2).min(MAX_MS)
        }
        _ => MAX_MS,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::discovery::SourceUri;

    #[tokio::test]
    async fn discovery_live_subscriptions_add_home_children_and_explicit_watch_parents() {
        let temp = tempfile::tempdir().unwrap();
        let home = host_path(&temp.path().canonicalize().unwrap())
            .unwrap()
            .to_owned();
        let guards = home.join(".guards");
        std::fs::create_dir(&guards).unwrap();
        let cap = Dir::open_ambient_dir(&home, cap_std::ambient_authority()).unwrap();
        let dirs = Arc::new([(home.clone(), cap)].into());
        let guard = guards.join("input");
        let routing = |files| Routing {
            deltas: DeltaRoots {
                home: Some(home.clone()),
                ..Default::default()
            },
            files,
        };
        let (updates, requests) = mpsc::channel(1);
        let (route, _) = watch::channel(Arc::new(Routing::default()));
        let (reload, mut topology) = watch::channel(());
        let (tx, mut deltas) = mpsc::channel(64);
        let (paths, mut targets) = broadcast::channel(64);
        // The polling backend exercises the same live registration loop without an OS event service.
        let worker = tokio::task::spawn_blocking(move || {
            watch_files::<notify::PollWatcher>(
                dirs,
                requests,
                route,
                tx,
                paths,
                reload,
                notify::Config::default()
                    .with_poll_interval(Duration::from_millis(25))
                    .with_compare_contents(true),
            )
        });
        let wait = Duration::from_secs(5);
        updates.send(routing(BTreeMap::new())).await.unwrap();
        tokio::time::timeout(wait, topology.changed())
            .await
            .unwrap()
            .unwrap();
        let project = home.join("NewProject");
        tokio::fs::create_dir(&project).await.unwrap();
        tokio::time::timeout(wait, topology.changed())
            .await
            .unwrap()
            .unwrap();
        updates
            .send(routing([(guard.clone(), vec!["guard".into()])].into()))
            .await
            .unwrap();
        let doc = project.join("notes");
        tokio::time::timeout(wait, async {
            let (mut seen_doc, mut seen_guard) = (false, false);
            let mut tick = tokio::time::interval(Duration::from_millis(50));
            let mut version = 0;
            while !(seen_doc && seen_guard) {
                tokio::select! {
                    _ = tick.tick() => {
                        version += 1;
                        for path in [&doc, &guard] { tokio::fs::write(path, version.to_string()).await.unwrap(); }
                    }
                    write = deltas.recv() => {
                        let path = PathBuf::from(write.unwrap().path);
                        if path != project { assert_eq!(path, doc); seen_doc = true; }
                    }
                    target = targets.recv() => { assert_eq!(target.unwrap(), "guard"); seen_guard = true; }
                }
            }
        }).await.expect("recursive content and exact guard did not both receive updates");
        drop(updates);
        drop(deltas);
        worker.await.unwrap().unwrap();
    }

    #[test]
    fn discovery_home_events_reload_new_folders_and_route_guard_only_writes() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let content = home.join("Notes");
        let guards = home.join(".guards");
        std::fs::create_dir(&content).unwrap();
        std::fs::create_dir(&guards).unwrap();
        let cap = Dir::open_ambient_dir(home, cap_std::ambient_authority()).unwrap();
        let dirs = [(home.to_owned(), cap)].into();
        let guarded = guards.join("input");
        let routing = Routing {
            deltas: DeltaRoots {
                home: Some(home.to_owned()),
                excluded: Arc::new([content.join("excluded")].into()),
                ..Default::default()
            },
            files: [(guarded.clone(), vec!["guard-key".into()])].into(),
        };
        let (tx, mut writes) = mpsc::channel(8);
        let (paths, mut targeted) = broadcast::channel(8);
        let (reload, changed) = watch::channel(());
        let mut tags = CacheTags::default();
        let mut event = |path: PathBuf, kind| {
            routing.file_events(
                notify::Event::new(kind).add_path(path),
                &dirs,
                &mut tags,
                &tx,
                &paths,
                &reload,
            )
        };
        event(content.clone(), EventKind::Create(CreateKind::Folder));
        assert!(changed.has_changed().unwrap());
        let write = EventKind::Modify(ModifyKind::Any);
        event(guarded, write);
        event(guards.join("other"), write);
        event(content.join("excluded/old"), write);
        event(content.join("contract"), write);
        assert_eq!(targeted.try_recv().unwrap(), "guard-key");
        assert!(targeted.try_recv().is_err());
        assert_eq!(
            Path::new(&writes.try_recv().unwrap().path),
            content.join("contract")
        );
        std::fs::write(
            content.join(TAG),
            b"Signature: 8a477f597d28d172789f06886806bc55",
        )
        .unwrap();
        event(content.join(TAG), write);
        event(content.join("cached"), write);
        assert!(writes.try_recv().is_err());
    }

    #[test]
    fn discovery_ignores_internal_outputs_and_temporary_files_at_any_depth() {
        let root = Path::new("/var/folders/test/T/.tmp123456/project");
        let scope = DeltaRoots {
            recursive: [root.to_owned(), root.join(".gemini/scratch/selected")].into(),
            private: vec![root.join("state")],
            ..Default::default()
        };
        let tracked = |name: &str| scope.permits(&root.join(name), false);
        for path in [
            "state/discovery/staging/topic/draft.md",
            ".git/refs/t",
            ".github/readme",
            ".gemini/brain/trace",
            ".gemini/scratch/other/spec.md",
            ".gemini/scratch/selected/.cache/noise",
            "p/node_modules/a",
            "p/target/out",
            "p/__pycache__/module",
            "p/Caches/index",
            "p/Logs/output",
            "p/CACHEDIR.TAG",
            ".DS_Store",
            "x.tmp",
            "~$doc",
            "x.swp",
            "x.swo",
            "a.lock",
            "messages-wal",
            "messages-shm",
            "messages.db-journal",
            "trace.log",
            "archive.crdownload",
            "archive.part",
        ] {
            assert!(!tracked(path), "{path}");
        }
        for path in [
            "staging/notes.md",
            "targeted/plan",
            "notes/.draft",
            ".gemini/scratch/selected/spec.md",
            "History",
            "Preferences",
            "Local State",
            "Documents/contract.enc",
            "p/sample.statistic",
            "p/scene.material",
            "Service Worker/script",
            "Library/Preferences/notes",
        ] {
            assert!(tracked(path), "{path}");
        }
    }

    #[tokio::test]
    async fn discovery_quiet_probes_and_cooldown_coalesce_across_restarts() {
        let (dir, root, owner) = test_store().await;
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
        let routing = watch::channel(Arc::new(Routing {
            deltas: DeltaRoots {
                recursive: [work.clone()].into(),
                ..Default::default()
            },
            ..Default::default()
        }))
        .1;
        let tracker = ChangeTracker {
            routing: routing.clone(),
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
        let snapshot = |at| {
            store.change_snapshot(
                UnixMillis(at),
                ChangeQuery::Opening { limit: 15 },
                |_, _| true,
            )
        };
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
            routing,
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
