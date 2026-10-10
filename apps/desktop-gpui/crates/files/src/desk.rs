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

//! Where a file leaves the window: a copy saved where the person chooses
//! (the platform's save dialog), and a copy handed to the default app.
//!
//! The protocol gives no path to an Artifact (Desktop's Show in Finder and
//! Open come from Electron main), so a file opened in the default app is a
//! copy written for the purpose: under the app's cache directory,
//! `<cache>/maka-gpui/artifacts/<launch>/<sessionId>/<artifactId>.<ext>`,
//! the directories owner-only (0700) and the file 0600, named by the ids
//! (canonical, `A-Z a-z 0-9 _ -`) and an extension from an allow-list (a
//! PDF's, a raster image's, `html`), never by the Artifact's own name. An
//! HTML page's copy holds the page's bytes alone, none of the files beside
//! it where it was made: the files its relative links and images name were
//! never copied. Each launch holds a lock on `<launch>.lock` while it runs;
//! at startup every launch directory whose lock is free (its app quit or
//! crashed) is removed, and at quit this launch's own.

use std::fs::{DirBuilder, File, OpenOptions, TryLockError};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;

use gpui_kit::{App, AppContext as _, Global, Task};

/// The client's directory under the cache directory, as the bots
/// sidecar's (`CACHE_DIRECTORY` in `crates/bots/src/sidecar.rs`).
const CLIENT_DIRECTORY: &str = "maka-gpui";
/// The directory in it that holds the copies.
const TEMP_DIRECTORY: &str = "artifacts";

/// How a saved copy's place is chosen: `suggested` is the name the dialog
/// fills in; `None` when the person cancels.
pub type ChooseSavePath = Rc<dyn Fn(&str, &mut App) -> Task<Option<PathBuf>>>;
/// How a file is handed to the system's default app.
pub type OpenFile = Rc<dyn Fn(&Path, &mut App)>;

/// The desktop the Files face saves to and opens with: the platform's
/// ([`Desk::system`]) or a test's.
#[derive(Clone)]
pub struct Desk {
    choose_save_path: ChooseSavePath,
    open: OpenFile,
    temp_dir: TempDir,
}

/// Where the copies to open go.
#[derive(Debug, Clone)]
enum TempDir {
    /// This launch's directory, once [`install_temp_files`] made it: read
    /// when a file opens, since the window may open first.
    System,
    Fixed(Option<PathBuf>),
}

impl std::fmt::Debug for Desk {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Desk").field("temp_dir", &self.temp_dir).finish_non_exhaustive()
    }
}

impl Desk {
    /// A desk that asks with `choose_save_path`, opens with `open`, and
    /// writes the copies it opens under `temp_dir` (none: nothing opens).
    pub fn new(
        choose_save_path: ChooseSavePath,
        open: OpenFile,
        temp_dir: Option<PathBuf>,
    ) -> Self {
        Self { choose_save_path, open, temp_dir: TempDir::Fixed(temp_dir) }
    }

    /// The platform's save dialog, opening in Downloads, the system's
    /// default app, and this launch's directory of copies when
    /// [`install_temp_files`] set it up.
    pub fn system() -> Self {
        let choose: ChooseSavePath = Rc::new(|suggested, cx| {
            let directory = dirs::download_dir().or_else(dirs::home_dir).unwrap_or_default();
            let answer = cx.prompt_for_new_path(&directory, Some(suggested));
            cx.spawn(async move |_| match answer.await {
                Ok(Ok(path)) => path,
                Ok(Err(error)) => {
                    log::warn!("files: the save dialog failed: {error:#}");
                    None
                }
                Err(_) => None,
            })
        });
        Self {
            choose_save_path: choose,
            open: Rc::new(|path, cx| cx.open_with_system(path)),
            temp_dir: TempDir::System,
        }
    }

    pub(crate) fn choose_save_path(&self, suggested: &str, cx: &mut App) -> Task<Option<PathBuf>> {
        (self.choose_save_path)(suggested, cx)
    }

    pub(crate) fn open(&self, path: &Path, cx: &mut App) {
        (self.open)(path, cx);
    }

    pub(crate) fn temp_dir(&self, cx: &App) -> Option<PathBuf> {
        match &self.temp_dir {
            TempDir::System => cx.try_global::<TempFiles>().map(|temp| temp.launch_dir.clone()),
            TempDir::Fixed(directory) => directory.clone(),
        }
    }
}

/// This launch's directory of copies, once [`install_temp_files`] made it.
struct TempFiles {
    launch_dir: PathBuf,
    /// Held while the app runs: a later launch leaves the directory alone.
    _lock: Arc<File>,
}

impl Global for TempFiles {}

/// Makes this launch's directory of copies under the cache directory and
/// removes those of launches that ended; removes this launch's at quit.
/// Call once from `main`; tests never do.
pub fn install_temp_files(cx: &mut App) {
    let Some(root) =
        dirs::cache_dir().map(|cache| cache.join(CLIENT_DIRECTORY).join(TEMP_DIRECTORY))
    else {
        log::warn!("files: no cache directory: files cannot open in the default app");
        return;
    };
    let launch = uuid::Uuid::new_v4().simple().to_string();
    let prepare = cx.background_spawn(async move { prepare_launch(&root, &launch) });
    cx.spawn(async move |cx| match prepare.await {
        Ok((launch_dir, lock)) => {
            cx.update(|cx| {
                let quit_dir = launch_dir.clone();
                cx.on_app_quit(move |_| {
                    remove_launch(&quit_dir);
                    async {}
                })
                .detach();
                cx.set_global(TempFiles { launch_dir, _lock: Arc::new(lock) });
            });
        }
        Err(error) => log::warn!("files: the directory of copies is unavailable: {error}"),
    })
    .detach();
}

/// Takes this launch's lock under `root`, removes the directories of
/// launches whose lock is free, and makes this launch's directory.
// Runs on the background executor.
#[allow(clippy::disallowed_methods)]
pub(crate) fn prepare_launch(root: &Path, launch: &str) -> io::Result<(PathBuf, File)> {
    private_dirs().create(root)?;
    let lock = lock_file(&root.join(format!("{launch}.lock")))?;
    match lock.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => {
            return Err(io::Error::other("this launch's lock is held"));
        }
        Err(TryLockError::Error(error)) => return Err(error),
    }
    for entry in std::fs::read_dir(root)?.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()).map(str::to_owned) else {
            continue;
        };
        let stem = name.strip_suffix(".lock").unwrap_or(&name);
        if stem == launch {
            continue;
        }
        if path.is_dir() {
            // A directory whose launch holds its lock belongs to a running app.
            let held = lock_file(&root.join(format!("{stem}.lock")))
                .map(|file| matches!(file.try_lock(), Err(TryLockError::WouldBlock)))
                .unwrap_or(false);
            if !held {
                std::fs::remove_dir_all(&path).ok();
                std::fs::remove_file(root.join(format!("{stem}.lock"))).ok();
            }
        } else if name.ends_with(".lock") {
            let free = lock_file(&path).is_ok_and(|file| file.try_lock().is_ok());
            if free {
                std::fs::remove_file(&path).ok();
            }
        }
    }
    let launch_dir = root.join(launch);
    private_dirs().create(&launch_dir)?;
    Ok((launch_dir, lock))
}

fn remove_launch(launch_dir: &Path) {
    std::fs::remove_dir_all(launch_dir).ok();
    std::fs::remove_file(launch_dir.with_extension("lock")).ok();
}

fn lock_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    owner_only(&mut options);
    options.open(path)
}

fn private_dirs() -> DirBuilder {
    let mut builder = DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        builder.mode(0o700);
    }
    builder
}

fn owner_only(options: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    #[cfg(not(unix))]
    let _ = options;
}

/// Writes the copy of `artifact` of `session` to open, under `temp_dir`,
/// and returns its path. Both ids must be canonical.
pub(crate) fn write_temp_copy(
    temp_dir: &Path,
    session: &str,
    artifact: &str,
    extension: &str,
    bytes: &[u8],
) -> io::Result<PathBuf> {
    if !crate::policy::is_canonical_id(session) || !crate::policy::is_canonical_id(artifact) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a canonical id"));
    }
    let directory = temp_dir.join(session);
    private_dirs().create(&directory)?;
    let path = directory.join(format!("{artifact}.{extension}"));
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    owner_only(&mut options);
    let mut file = options.open(&path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(path)
}

/// Writes `bytes` to `target`: into a hidden file beside it first, then
/// over it, so a failure never leaves half a file in its place.
pub(crate) fn write_saved_copy(target: &Path, bytes: &[u8]) -> io::Result<()> {
    let directory = target.parent().unwrap_or(Path::new("."));
    let name = target.file_name().and_then(|name| name.to_str()).unwrap_or("file");
    let partial = directory.join(format!(".{name}.{}.partial", uuid::Uuid::new_v4().simple()));
    let written = (|| {
        let mut file = File::create(&partial)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&partial, target)
    })();
    if written.is_err() {
        std::fs::remove_file(&partial).ok();
    }
    written
}

#[cfg(test)]
#[allow(clippy::disallowed_methods)] // Tests write and read their scratch files.
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir()
            .join(format!("maka-files-{name}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&root).expect("scratch");
        root
    }

    #[test]
    fn a_launch_removes_ended_launches_and_keeps_running_ones() {
        let root = scratch("purge");
        // An ended launch: its lock is free.
        std::fs::create_dir_all(root.join("ended/s1")).expect("ended");
        std::fs::write(root.join("ended.lock"), b"").expect("lock");
        // A directory with no lock at all.
        std::fs::create_dir_all(root.join("stray")).expect("stray");
        // A running launch holds its lock.
        std::fs::create_dir_all(root.join("running")).expect("running");
        let running = lock_file(&root.join("running.lock")).expect("lock");
        running.try_lock().expect("held");

        let (launch_dir, _lock) = prepare_launch(&root, "now").expect("prepare");
        assert_eq!(launch_dir, root.join("now"));
        assert!(launch_dir.is_dir());
        assert!(!root.join("ended").exists() && !root.join("ended.lock").exists());
        assert!(!root.join("stray").exists());
        assert!(root.join("running").is_dir(), "a running launch keeps its copies");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&launch_dir).expect("meta").permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        drop(running);
        remove_launch(&launch_dir);
        assert!(!launch_dir.exists() && !root.join("now.lock").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn copies_are_named_by_ids_and_owner_only() {
        let root = scratch("copy");
        let path = write_temp_copy(&root, "s-1", "a_2", "png", b"bytes").expect("copy");
        assert_eq!(path, root.join("s-1").join("a_2.png"));
        assert_eq!(std::fs::read(&path).expect("read"), b"bytes");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&path).expect("meta").permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
            let dir = std::fs::metadata(root.join("s-1")).expect("meta").permissions().mode();
            assert_eq!(dir & 0o777, 0o700);
        }
        assert!(write_temp_copy(&root, "../s", "a", "png", b"x").is_err());
        assert!(write_temp_copy(&root, "s", "a/b", "png", b"x").is_err());

        let target = root.join("saved.txt");
        std::fs::write(&target, b"old").expect("old");
        write_saved_copy(&target, b"new").expect("save");
        assert_eq!(std::fs::read(&target).expect("read"), b"new");
        let leftovers = std::fs::read_dir(&root)
            .expect("dir")
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".partial"))
            .count();
        assert_eq!(leftovers, 0);
        std::fs::remove_dir_all(&root).ok();
    }
}
