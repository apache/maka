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

//! Coalesce lost-event notifications and sample recently modified files after the stream settles.
use super::*;
use std::{
    collections::VecDeque,
    sync::Mutex,
    time::{Instant, SystemTime},
};

const RELOAD: Duration = Duration::from_secs(10);
const QUIET: Duration = Duration::from_secs(1);
const MAX_PATHS: usize = 16;
const MAX_ENTRIES: usize = 128;
const MAX_DEPTH: usize = 2;
const SCAN_TIME: Duration = Duration::from_millis(50);

#[derive(Default)]
struct Stream {
    dirty: Option<CatchUp>,
    last_reload: Option<Instant>,
    dropped: u64,
}

pub(super) struct CatchUp {
    last_event: Instant,
    since: SystemTime,
    paths: Option<BTreeSet<PathBuf>>,
}

enum Next {
    Idle,
    Wait(Instant),
    Report(u64),
    Scan(CatchUp),
}

impl Stream {
    fn lost(&mut self, now: Instant, paths: &[PathBuf]) -> bool {
        let first = self.dirty.is_none();
        let burst = self.dirty.get_or_insert_with(|| CatchUp {
            last_event: now,
            since: SystemTime::now().checked_sub(QUIET).unwrap_or(UNIX_EPOCH),
            paths: Some(BTreeSet::new()),
        });
        burst.last_event = now;
        self.dropped = self.dropped.saturating_add(1);
        if let Some(hints) = &mut burst.paths {
            if paths.is_empty() || paths.len() > MAX_PATHS {
                burst.paths = None;
            } else {
                hints.extend(
                    paths
                        .iter()
                        .filter_map(|p| host_path(p).ok().map(Path::to_owned)),
                );
                if hints.len() > MAX_PATHS {
                    burst.paths = None;
                }
            }
        }
        first
    }

    fn next(&mut self, now: Instant) -> Next {
        let Some(burst) = &self.dirty else {
            return Next::Idle;
        };
        if self.dropped > 0 {
            if let Some(next) = self
                .last_reload
                .map(|t| t + RELOAD)
                .filter(|next| *next > now)
            {
                return Next::Wait(next);
            }
            self.last_reload = Some(now);
            return Next::Report(std::mem::take(&mut self.dropped));
        }
        let quiet = burst.last_event + QUIET;
        if quiet > now {
            Next::Wait(quiet)
        } else {
            Next::Scan(self.dirty.take().expect("dirty stream"))
        }
    }
}

#[derive(Default)]
pub(super) struct Rescans {
    state: Mutex<Stream>,
    wake: tokio::sync::Notify,
}

impl Rescans {
    pub(super) fn lost(&self, paths: &[PathBuf]) {
        if self.state.lock().unwrap().lost(Instant::now(), paths) {
            self.wake.notify_one();
        }
    }

    async fn settled(&self, topology: &watch::Sender<()>) -> CatchUp {
        loop {
            let next = self.state.lock().unwrap().next(Instant::now());
            match next {
                Next::Idle => self.wake.notified().await,
                Next::Wait(at) => tokio::time::sleep_until(at.into()).await,
                Next::Report(dropped) => {
                    tracing::warn!(
                        dropped,
                        "Discovery filesystem event stream reported lost changes"
                    );
                    topology.send_replace(());
                }
                Next::Scan(burst) => return burst,
            }
        }
    }
}

pub(super) enum Update {
    Routing(Routing),
    Scan(CatchUp),
}

pub(super) async fn next(
    rescans: &Rescans,
    updates: &mut mpsc::Receiver<Routing>,
    topology: &watch::Sender<()>,
) -> Option<Update> {
    tokio::select! {
        routing = updates.recv() => routing.map(Update::Routing),
        burst = rescans.settled(topology) => Some(Update::Scan(burst)),
    }
}

pub(super) fn scan(
    burst: CatchUp,
    routing: &Routing,
    roots: &Directories,
    installed: &BTreeMap<PathBuf, RecursiveMode>,
    tx: &mpsc::Sender<FileWrite>,
    watches: &broadcast::Sender<String>,
) {
    let deadline = Instant::now() + SCAN_TIME;
    let affected = |path: &Path| {
        burst.paths.as_ref().is_none_or(|hints| {
            hints
                .iter()
                .any(|p| path.starts_with(p) || p.starts_with(path))
        })
    };
    let mut guard_budget = MAX_ENTRIES;
    for (path, targets) in routing.files.iter().take(MAX_ENTRIES) {
        if Instant::now() >= deadline {
            return;
        }
        if affected(path) {
            for target in targets.iter().take(guard_budget) {
                let _ = watches.send(target.clone());
                guard_budget -= 1;
            }
        }
    }
    let mut pending = VecDeque::new();
    let mut start = |path: &Path, depth| {
        if pending.len() < MAX_PATHS
            && (routing.deltas.permits(path, true)
                || (depth == 0
                    && routing
                        .deltas
                        .recursive
                        .iter()
                        .any(|root| root.parent() == Some(path))))
        {
            pending.push_back((path.to_owned(), depth));
        }
    };
    if let Some(hints) = &burst.paths {
        for hint in hints {
            if Instant::now() >= deadline {
                return;
            }
            if let Some((base, mode)) = hint.ancestors().find_map(|p| installed.get_key_value(p)) {
                if *mode == RecursiveMode::Recursive {
                    start(
                        hint.parent()
                            .filter(|p| p.starts_with(base))
                            .unwrap_or(base),
                        MAX_DEPTH,
                    );
                } else {
                    start(base, 0);
                }
            }
        }
    }
    for (path, mode) in installed {
        if Instant::now() >= deadline {
            break;
        }
        if affected(path) {
            start(
                path,
                if *mode == RecursiveMode::Recursive {
                    MAX_DEPTH
                } else {
                    0
                },
            );
        }
    }
    let mut visited = BTreeSet::new();
    let mut remaining = MAX_ENTRIES;
    let mut tags = CacheTags::default();
    while let Some((path, depth)) = pending.pop_front() {
        if remaining == 0 || Instant::now() >= deadline {
            break;
        }
        if !visited.insert(path.clone()) {
            continue;
        }
        let Some((base, cap)) = roots.iter().find(|(base, _)| path.starts_with(base)) else {
            continue;
        };
        if tags.ignored(&path, roots) {
            continue;
        }
        let entries = roots::open_relative(cap, path.strip_prefix(base).expect("matched root"))
            .and_then(|d| d.entries());
        let Ok(entries) = entries else {
            continue;
        };
        for entry in entries {
            if remaining == 0 || Instant::now() >= deadline {
                return;
            }
            remaining -= 1;
            let Ok(entry) = entry else {
                continue;
            };
            let child = path.join(entry.file_name());
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if !affected(&child) || !routing.deltas.permits(&child, kind.is_dir()) {
                continue;
            }
            if kind.is_dir() && depth > 0 {
                pending.push_back((child, depth - 1));
            } else if kind.is_file()
                && let Some(path) = child.to_str()
                && entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .is_ok_and(|at| at.into_std() >= burst.since)
                && tx
                    .try_send(FileWrite {
                        path: path.into(),
                        kind: WriteKind::Modified,
                        at: UnixMillis(now() as i64),
                    })
                    .is_err()
            {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_rescan_storm_reports_dropped_events_once_per_window_and_scans_after_quiet() {
        let mut stream = Stream::default();
        let start = Instant::now();
        assert!(stream.lost(start, &[]));
        assert!(matches!(stream.next(start), Next::Report(1)));
        for n in 1..100 {
            let at = start + Duration::from_millis(n * 100);
            assert!(!stream.lost(at, &[]));
            assert!(matches!(stream.next(at),Next::Wait(t) if t == start+RELOAD));
        }
        assert!(matches!(stream.next(start + RELOAD), Next::Report(99)));
        assert!(matches!(stream.next(start + RELOAD), Next::Wait(_)));
        assert!(matches!(stream.next(start + RELOAD + QUIET), Next::Scan(_)));
        assert!(matches!(stream.next(start + RELOAD + QUIET), Next::Idle));
    }

    #[test]
    fn discovery_catch_up_limits_entries_depth_and_authorized_paths() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let project = root.join("tracked");
        for path in ["one/two/three", "dist", "excluded"] {
            std::fs::create_dir_all(project.join(path)).unwrap();
        }
        for path in [
            "one/keep",
            "one/two/keep",
            "one/two/three/deep",
            "dist/noise",
            "excluded/private",
        ] {
            std::fs::write(project.join(path), "changed").unwrap();
        }
        let caps = [(
            root.to_owned(),
            Dir::open_ambient_dir(root, cap_std::ambient_authority()).unwrap(),
        )]
        .into();
        let routing = Routing {
            deltas: DeltaRoots {
                recursive: [project.clone()].into(),
                excluded: Arc::new([project.join("excluded")].into()),
                ..Default::default()
            },
            ..Default::default()
        };
        let installed = [(project.clone(), RecursiveMode::Recursive)].into();
        let (tx, mut rx) = mpsc::channel(MAX_ENTRIES + 1);
        let (watch, _) = broadcast::channel(1);
        let catch_up = || {
            scan(
                CatchUp {
                    last_event: Instant::now(),
                    since: UNIX_EPOCH,
                    paths: None,
                },
                &routing,
                &caps,
                &installed,
                &tx,
                &watch,
            )
        };
        catch_up();
        let mut found = BTreeSet::new();
        while let Ok(write) = rx.try_recv() {
            found.insert(PathBuf::from(write.path));
        }
        assert_eq!(
            found,
            [project.join("one/keep"), project.join("one/two/keep")].into()
        );
        for i in 0..MAX_ENTRIES + 10 {
            std::fs::write(project.join(i.to_string()), "").unwrap();
        }
        catch_up();
        assert!((1..=MAX_ENTRIES).contains(&rx.len()));
    }
}
