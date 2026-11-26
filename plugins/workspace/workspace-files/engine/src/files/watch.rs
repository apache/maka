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

use super::*;
use notify::{Config, EventHandler, EventKind, PathOp, RecommendedWatcher, Watcher};
use std::sync::{Arc, mpsc};
use tokio::sync::mpsc as wake;

pub struct Watch {
    watcher: RecommendedWatcher,
    changed: wake::Receiver<()>,
    failed: Arc<AtomicBool>,
    settled: mpsc::Receiver<()>,
}
struct Handler {
    changed: wake::Sender<()>,
    failed: Arc<AtomicBool>,
    settled: mpsc::Sender<()>,
    filter: Filter,
}
struct Filter {
    chain: Vec<PathBuf>,
    private_root: PathBuf,
    control: PathBuf,
    managed: bool,
}
impl Filter {
    fn relevant(&self, path: &Path) -> bool {
        let root = &self.chain[0];
        let target = self.chain.last().expect("target anchor");
        // Unknown paths may describe a moved watch root; only invalidate, never read them.
        let Ok(relative) = path.strip_prefix(root) else {
            return true;
        };
        if path.starts_with(&self.control)
            || (path.starts_with(&self.private_root) && !(self.managed && path.starts_with(root)))
        {
            return false;
        }
        if relative.components().any(|part| {
            part.as_os_str()
                .as_encoded_bytes()
                .eq_ignore_ascii_case(b".git")
        }) {
            return false;
        }
        self.chain.iter().any(|anchor| anchor == path) || path.parent() == Some(target.as_path())
    }
}
impl EventHandler for Handler {
    fn handle_event(&mut self, event: notify::Result<notify::Event>) {
        match event {
            Ok(event) if matches!(event.kind, EventKind::Access(_)) && !event.need_rescan() => {
                return;
            }
            Ok(event)
                if !event.need_rescan()
                    && !event.paths.is_empty()
                    && !event.paths.iter().any(|path| self.filter.relevant(path)) =>
            {
                return;
            }
            Err(_) => {
                self.failed.store(true, Ordering::Release);
            }
            _ => {}
        }
        // A full slot already represents dirty state; never block the OS callback.
        let _ = self.changed.try_send(());
    }
}
impl Drop for Handler {
    fn drop(&mut self) {
        let _ = self.settled.send(());
    }
}

pub(super) fn open(directory: &Directory) -> io::Result<Watch> {
    directory.validate_inner()?;
    let (tx, changed) = wake::channel(1);
    let (done, settled) = mpsc::channel();
    let failed = Arc::new(AtomicBool::new(false));
    let handler = Handler {
        changed: tx,
        failed: failed.clone(),
        settled: done,
        filter: Filter {
            chain: directory.anchors.iter().map(|a| a.path.clone()).collect(),
            private_root: directory.private_root.clone(),
            control: directory.control.clone(),
            managed: directory.managed,
        },
    };
    let mut watcher =
        match RecommendedWatcher::new(handler, Config::default().with_follow_symlinks(false)) {
            Ok(watcher) => watcher,
            Err(_) => {
                let _ = settled.recv();
                return Err(error("files_watch_unavailable"));
            }
        };
    let result = (|| {
        let paths = directory
            .anchors
            .iter()
            .map(|anchor| PathOp::watch_non_recursive(anchor.path.clone()))
            .collect();
        watcher
            .update_paths(paths)
            .map_err(|_| error("files_watch_unavailable"))?;
        directory.validate_inner()
    })();
    if let Err(error) = result {
        settle(watcher, settled)?;
        return Err(error);
    }
    Ok(Watch {
        watcher,
        changed,
        failed,
        settled,
    })
}
fn settle(watcher: RecommendedWatcher, settled: mpsc::Receiver<()>) -> io::Result<()> {
    drop(watcher);
    // Normal shutdown fence: watch FDs/callback ownership are gone. This does not
    // claim that notify exposes a joined event-loop thread on every platform.
    settled.recv().map_err(|_| error("files_watch_unavailable"))
}
impl Watch {
    pub async fn changed(&mut self) -> io::Result<()> {
        match self.changed.recv().await {
            Some(()) if !self.failed.load(Ordering::Acquire) => Ok(()),
            _ => Err(error("files_watch_unavailable")),
        }
    }
    /// Caller keeps original resource custody until this normal quiescence fence.
    pub async fn close(self) -> io::Result<()> {
        let Self {
            watcher, settled, ..
        } = self;
        tokio::task::spawn_blocking(move || settle(watcher, settled))
            .await
            .map_err(|_| error("files_watch_unavailable"))?
    }
}
