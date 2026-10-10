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

//! The side chats' cleanup ledger: every fork this client asks the Host
//! for, from before the request until the fork is gone.
//!
//! A side chat's fork is a Session of its own, temporary by design (Maka
//! Desktop's "用完即弃"). Closing its tab removes it, and so does deleting
//! its task; but the app can quit, crash, or lose its Host in between, and a
//! create can be in flight when it does. So, as Desktop's cleanup authority
//! does (`createSessionCopyCleanupAuthority` in
//! packages/storage/src/session-copy-cleanup.ts, `ownCreation`, `recover`),
//! an entry with the State Root's id, the whole creation input (source,
//! target, boundary) and its phase is written, and flushed to disk, before
//! the create request goes; it is marked live once the Host commits the
//! fork, and goes once the fork is removed or found missing.
//!
//! When a window connects to a State Root, every entry for that root that no
//! live side chat of this process holds, and whose owner process has ended,
//! is settled: one still `creating` has its create sent again first (a
//! create in flight when the app stopped could commit after a removal that
//! went first; the same input resolves to whatever the first one made),
//! then the fork's runs are stopped and it is removed; `not_found` settles
//! it too. Entries for another root wait for that root. A fork of this run
//! whose removal gives up (a run that had not ended after its stop) is
//! tried again a minute later while its root stays connected. Forks the
//! ledger does not hold are never touched: another client on the same root
//! may own them.
//!
//! The ledger is the app's, one for every window, kept in the client's
//! config directory beside the preferences ([`LEDGER_FILE`]). Each process
//! owns its entries through an advisory lock on a file of its own under
//! [`OWNER_LOCKS_DIRECTORY`], which the operating system drops when the
//! process ends however it ends (Desktop's process lifetime owner).
//!
//! Two runs of the app can share the file. Every save reads it again, while
//! no other run's save runs, and writes the other runs' entries back as
//! they are on disk (those this run settled left out) with this run's own.
//! An entry this client cannot read (a newer client's phase) is left for
//! the clients that can; a document that does not parse is moved aside
//! rather than overwritten; and when the file cannot be read at launch,
//! this run writes nothing and keeps its forks in memory.

use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions, TryLockError};
use std::io;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

use futures_lite::future::Boxed;
use gpui_kit::{App, AppContext as _, Context, Entity, Global, SharedString, Task};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use workspace::{HostRequestError, HostRequester, client_config_file, write_config_file};

use super::fork;

/// The ledger's file in the client's config directory.
pub const LEDGER_FILE: &str = "side-chat-forks.json";

/// The directory, beside [`LEDGER_FILE`], of each process's owner lock.
pub const OWNER_LOCKS_DIRECTORY: &str = "side-chat-owners";

/// A ledger is a few entries; a larger file is not ours.
const MAX_LEDGER_BYTES: u64 = 256 * 1024;

/// How long after a fork of this run fails to settle (its removal gave up
/// on a run that had not ended after its stop) it is tried again, while a
/// window is connected to its root.
const RETRY_INTERVAL: Duration = Duration::from_secs(60);

/// Where a fork's life stands (Desktop's `creating`, `live`, `cleanup`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ForkPhase {
    /// Written before the create request; the Host may or may not have
    /// made the fork.
    Creating,
    /// The Host committed the fork.
    Live,
    /// Its side chat is gone; the fork is to be removed.
    Cleanup,
}

/// One fork, with what it takes to settle it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ForkEntry {
    /// The State Root's id (`accepted.rootId`) whose Host holds it.
    pub root_id: String,
    /// The process that asked for it ([`LedgerStore::owner`]).
    pub owner: String,
    /// The fork's id: the create's identity.
    pub target_session_id: String,
    pub source_session_id: String,
    /// The Turn it copies its task through; none for an empty fork.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_turn_id: Option<String>,
    pub phase: ForkPhase,
}

/// The file's document. Its forks stay JSON values until read: another
/// run's entry is written back as it was, fields and phases this client
/// does not know included.
#[derive(Debug, Default, Serialize, Deserialize)]
struct LedgerDocument {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    forks: Vec<Value>,
}

/// Makes the document a save writes from the saved one (`None` when
/// nothing is saved).
pub type LedgerEdit = Box<dyn FnOnce(Option<&[u8]>) -> io::Result<LedgerWrite> + Send>;

/// What a [`LedgerStore::update`] writes.
#[derive(Debug)]
#[non_exhaustive]
pub struct LedgerWrite {
    /// The document.
    pub contents: Vec<u8>,
    /// The saved document does not parse: it is moved aside, not
    /// overwritten, with whatever forks it holds.
    pub set_aside: bool,
}

/// Keeps the ledger across launches and tells whether another process that
/// wrote entries still runs.
pub trait LedgerStore: 'static {
    /// This process's owner token.
    fn owner(&self) -> SharedString;
    /// The saved document, or `None` when nothing was saved; an error when
    /// it could not be read.
    fn load(&self) -> Boxed<io::Result<Option<Vec<u8>>>>;
    /// Saves what `edit` makes of the saved document, read again for it,
    /// flushed before it answers; another process's update waits for it.
    /// A saved document that cannot be read is left as it is: nothing is
    /// written.
    fn update(&self, edit: LedgerEdit) -> Boxed<io::Result<()>>;
    /// Whether the process `owner` still runs (it holds its lock).
    fn is_owner_alive(&self, owner: &str) -> Boxed<bool>;
    /// The ended process `owner` has no entry left: its lock file goes.
    fn release_owner(&self, owner: &str) -> Boxed<()>;
    /// Removes the lock files of ended processes that hold no entry (all
    /// but `keep`): a run with no fork left behind leaves its lock file.
    fn sweep_owners(&self, keep: Vec<String>) -> Boxed<()>;
}

/// The ledger in [`LEDGER_FILE`] under the client's config directory,
/// with this process's lock under [`OWNER_LOCKS_DIRECTORY`].
pub struct LedgerFile {
    path: PathBuf,
    owners: PathBuf,
    owner: SharedString,
    /// Held for the life of the process: the lock others test.
    _lock: File,
}

impl std::fmt::Debug for LedgerFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LedgerFile").field("path", &self.path).field("owner", &self.owner).finish()
    }
}

impl LedgerFile {
    /// The ledger in the client's config directory, this process's owner
    /// lock taken (on the blocking pool). `None` without a config
    /// directory or when the lock cannot be taken: side chats then keep
    /// their ledger in memory for this run.
    pub async fn open_default() -> Option<Self> {
        let path = client_config_file(LEDGER_FILE)?;
        let owners = client_config_file(OWNER_LOCKS_DIRECTORY)?;
        Self::open(path, owners).await
    }

    /// The ledger at `path`, owner locks under `owners`. The lock is taken
    /// on a file named as no sweep reads it, then renamed into place: a
    /// sweep that ran between creating `<owner>.lock` and locking it would
    /// unlink it, and others would take this running process for ended.
    pub(crate) async fn open(path: PathBuf, owners: PathBuf) -> Option<Self> {
        let owner: SharedString = uuid::Uuid::new_v4().simple().to_string().into();
        let lock_path = owners.join(format!("{owner}.lock"));
        let staged = owners.join(format!("{owner}.lock.new"));
        let directory = owners.clone();
        let opened = blocking::unblock(move || -> io::Result<File> {
            create_private_dir(&directory)?;
            let file = OpenOptions::new().create_new(true).write(true).open(&staged)?;
            let locked = match file.try_lock() {
                Ok(()) => std::fs::rename(&staged, &lock_path),
                Err(TryLockError::WouldBlock) => Err(io::Error::other("the lock is held")),
                Err(TryLockError::Error(error)) => Err(error),
            };
            if let Err(error) = locked {
                std::fs::remove_file(&staged).ok();
                return Err(error);
            }
            Ok(file)
        })
        .await;
        match opened {
            Ok(lock) => Some(Self { path, owners, owner, _lock: lock }),
            Err(error) => {
                log::warn!("side chats keep their ledger in memory: {error}");
                None
            }
        }
    }

    fn lock_path(&self, owner: &str) -> Option<PathBuf> {
        // An owner token is ours: hex only. Anything else names no file.
        owner
            .chars()
            .all(|ch| ch.is_ascii_hexdigit())
            .then(|| self.owners.join(format!("{owner}.lock")))
    }
}

impl LedgerStore for LedgerFile {
    fn owner(&self) -> SharedString {
        self.owner.clone()
    }

    fn load(&self) -> Boxed<io::Result<Option<Vec<u8>>>> {
        let path = self.path.clone();
        Box::pin(blocking::unblock(move || read_ledger(&path)))
    }

    fn update(&self, edit: LedgerEdit) -> Boxed<io::Result<()>> {
        let path = self.path.clone();
        let guard = sibling(&self.path, ".lock");
        Box::pin(async move {
            // Held until the document is saved: another process's update
            // reads it only then.
            let _guard = blocking::unblock(move || -> io::Result<File> {
                if let Some(directory) = guard.parent() {
                    create_private_dir(directory)?;
                }
                let file =
                    OpenOptions::new().create(true).truncate(false).write(true).open(&guard)?;
                file.lock()?;
                Ok(file)
            })
            .await?;
            let read = path.clone();
            let saved = blocking::unblock(move || read_ledger(&read)).await?;
            let write = edit(saved.as_deref())?;
            if write.set_aside && saved.is_some() {
                let millis = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|elapsed| elapsed.as_millis())
                    .unwrap_or_default();
                let aside = sibling(&path, &format!(".unreadable-{millis}"));
                let from = path.clone();
                let kept = aside.clone();
                blocking::unblock(move || std::fs::rename(&from, &kept)).await?;
                log::warn!("the side chats' ledger did not parse; kept as {}", aside.display());
            }
            write_config_file(path, write.contents).await
        })
    }

    fn is_owner_alive(&self, owner: &str) -> Boxed<bool> {
        let Some(path) = self.lock_path(owner) else { return Box::pin(async { false }) };
        Box::pin(blocking::unblock(move || match OpenOptions::new().write(true).open(&path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => false,
            Err(_) => true,
            Ok(file) => match file.try_lock() {
                // Nobody holds it: its process has ended.
                Ok(()) => false,
                Err(_) => true,
            },
        }))
    }

    fn release_owner(&self, owner: &str) -> Boxed<()> {
        let Some(path) = self.lock_path(owner) else { return Box::pin(async {}) };
        Box::pin(blocking::unblock(move || remove_unheld_lock(&path)))
    }

    fn sweep_owners(&self, keep: Vec<String>) -> Boxed<()> {
        let owners = self.owners.clone();
        let mine = self.owner.to_string();
        // On the blocking pool, off the UI thread.
        #[allow(clippy::disallowed_methods)]
        Box::pin(blocking::unblock(move || {
            let Ok(listing) = std::fs::read_dir(&owners) else { return };
            for entry in listing.flatten() {
                let path = entry.path();
                let owner = path.file_stem().and_then(|stem| stem.to_str()).unwrap_or_default();
                let ours = path.extension().is_some_and(|extension| extension == "lock")
                    && owner.chars().all(|ch| ch.is_ascii_hexdigit());
                if ours && owner != mine && !keep.iter().any(|kept| kept == owner) {
                    remove_unheld_lock(&path);
                }
            }
        }))
    }
}

/// The ledger's document at `path`, on a blocking thread; `None` when there
/// is none. What is there but is not a small regular file is not a ledger:
/// it reads as nothing that parses, so a save sets it aside.
#[allow(clippy::disallowed_methods)] // Runs on the blocking pool.
fn read_ledger(path: &Path) -> io::Result<Option<Vec<u8>>> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !metadata.is_file() || metadata.len() > MAX_LEDGER_BYTES {
        log::warn!("{} is not a small regular file", path.display());
        return Ok(Some(Vec::new()));
    }
    match std::fs::read(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        read => read.map(Some),
    }
}

/// `path` with `suffix` after its file name.
fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Creates `directory` and its parents, owner-only as the config
/// directory is (`write_config_file`), when missing; on a blocking thread.
fn create_private_dir(directory: &Path) -> io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        builder.mode(0o700);
    }
    builder.create(directory)
}

/// Removes the lock file at `path` unless its process still holds it.
fn remove_unheld_lock(path: &Path) {
    if let Ok(file) = OpenOptions::new().write(true).open(path)
        && file.try_lock().is_ok()
    {
        std::fs::remove_file(path).ok();
    }
}

struct GlobalLedger(Entity<SideChatLedger>);

impl Global for GlobalLedger {}

/// The app's ledger of side chats' forks; see the module docs. Mutations
/// answer once the document that holds them is saved (in order, the newest
/// replacing one waiting). Settlements run on its own tasks, so a fork is
/// removed even after its side chat and its window are gone.
pub struct SideChatLedger {
    store: Option<Rc<dyn LedgerStore>>,
    owner: SharedString,
    entries: Vec<ForkEntry>,
    /// The saved document was read (or there is none to read).
    loaded: bool,
    /// Forks a live side chat of this process holds: never settled here.
    held: HashSet<String>,
    /// Forks being settled.
    settling: HashSet<String>,
    /// Other runs' forks this one settled: a save leaves them out.
    settled: HashSet<String>,
    /// The roots a window is connected to, and how to reach their Host.
    roots: HashMap<String, HostRequester>,
    /// Bumped by every change; `written` is the last one saved.
    dirty: u64,
    written: u64,
    writing: bool,
    waiters: Vec<(u64, async_channel::Sender<Result<(), SharedString>>)>,
    _load: Option<Task<()>>,
    _save: Option<Task<()>>,
    _settles: HashMap<String, Task<()>>,
    /// A settlement of this run's leftovers is due ([`RETRY_INTERVAL`]).
    retry_armed: bool,
    _retry: Option<Task<()>>,
}

impl std::fmt::Debug for SideChatLedger {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SideChatLedger")
            .field("entries", &self.entries)
            .field("held", &self.held)
            .finish_non_exhaustive()
    }
}

impl SideChatLedger {
    /// Installs a ledger kept in memory, unless one exists. The app then
    /// gives it its file ([`Self::restore`]).
    pub fn init(cx: &mut App) {
        if cx.has_global::<GlobalLedger>() {
            return;
        }
        let entity = cx.new(|_| Self::in_memory());
        cx.set_global(GlobalLedger(entity));
    }

    /// A ledger kept in memory until [`Self::restore`] gives it its store.
    pub(crate) fn in_memory() -> Self {
        Self {
            store: None,
            owner: "memory".into(),
            entries: Vec::new(),
            loaded: true,
            held: HashSet::new(),
            settling: HashSet::new(),
            settled: HashSet::new(),
            roots: HashMap::new(),
            dirty: 0,
            written: 0,
            writing: false,
            waiters: Vec::new(),
            _load: None,
            _save: None,
            _settles: HashMap::new(),
            retry_armed: false,
            _retry: None,
        }
    }

    /// The app's ledger. Panics before [`crate::init`].
    pub fn global(cx: &App) -> Entity<Self> {
        cx.global::<GlobalLedger>().0.clone()
    }

    /// Takes `store` and reads what it saved, then settles what the roots
    /// connected meanwhile hold. Entries added before the read are kept
    /// beside the saved ones, as this process's.
    pub fn restore(&mut self, store: Rc<dyn LedgerStore>, cx: &mut Context<Self>) {
        let owner = store.owner();
        for entry in &mut self.entries {
            if entry.owner == self.owner.as_ref() {
                entry.owner = owner.to_string();
            }
        }
        self.owner = owner;
        self.loaded = false;
        let load = store.load();
        self.store = Some(store);
        self._load = Some(cx.spawn(async move |this, cx| {
            let loaded = load.await;
            this.update(cx, |this, cx| this.finish_load(loaded, cx)).ok();
        }));
    }

    fn finish_load(&mut self, loaded: io::Result<Option<Vec<u8>>>, cx: &mut Context<Self>) {
        let loaded = match loaded {
            Ok(saved) => saved.map(|saved| read_entries(&saved)).unwrap_or_default(),
            Err(error) => {
                // A save would replace forks this run could not read.
                log::warn!("could not read the side chats' ledger; it is kept in memory: {error}");
                self.store = None;
                Vec::new()
            }
        };
        for entry in loaded {
            if !self.entries.iter().any(|known| known.target_session_id == entry.target_session_id)
            {
                self.entries.push(entry);
            }
        }
        self.loaded = true;
        log::info!("side chats' ledger: {} forks", self.entries.len());
        if let Some(store) = self.store.clone() {
            let keep = self.entries.iter().map(|entry| entry.owner.clone()).collect();
            cx.background_spawn(store.sweep_owners(keep)).detach();
        }
        self.dirty += 1;
        self.flush(cx);
        let roots: Vec<String> = self.roots.keys().cloned().collect();
        for root in roots {
            self.settle_root(&root, false, cx);
        }
        cx.notify();
    }

    /// Every fork the ledger holds.
    pub fn entries(&self) -> &[ForkEntry] {
        &self.entries
    }

    /// Whether `session_id` is a fork the ledger holds: one of this
    /// client's side chats, live or still to be removed.
    pub fn holds(&self, session_id: &str) -> bool {
        self.entries.iter().any(|entry| entry.target_session_id == session_id)
    }

    /// This process's owner token.
    pub fn owner(&self) -> &SharedString {
        &self.owner
    }

    /// Writes down a fork about to be asked for, held by a live side chat;
    /// answers once it is on disk. The same target again (a create sent
    /// again after an unknown outcome) replaces its entry.
    pub fn begin(
        &mut self,
        root_id: String,
        target_session_id: String,
        source_session_id: String,
        source_turn_id: Option<String>,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), SharedString>> {
        self.entries.retain(|entry| entry.target_session_id != target_session_id);
        self.held.insert(target_session_id.clone());
        self.entries.push(ForkEntry {
            root_id,
            owner: self.owner.to_string(),
            target_session_id,
            source_session_id,
            source_turn_id,
            phase: ForkPhase::Creating,
        });
        self.persist(cx)
    }

    /// The Host committed the fork `target`.
    pub fn mark_live(
        &mut self,
        target: &str,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), SharedString>> {
        if let Some(entry) = self.entry_mut(target) {
            entry.phase = ForkPhase::Live;
        }
        self.persist(cx)
    }

    /// The fork `target` was never made: its entry goes.
    pub fn forget(
        &mut self,
        target: &str,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), SharedString>> {
        self.held.remove(target);
        self.entries.retain(|entry| entry.target_session_id != target);
        self.persist(cx)
    }

    /// The side chat of fork `target` is gone: stops its runs and removes
    /// it through `requester` (a create that may be in flight is sent
    /// again first). Answers whether it is settled; when it is not, the
    /// entry stays, to be tried again ([`RETRY_INTERVAL`]) and at the next
    /// connection to its root.
    pub fn dispose(
        &mut self,
        target: &str,
        requester: HostRequester,
        cx: &mut Context<Self>,
    ) -> Task<bool> {
        self.held.remove(target);
        let Some(entry) = self.entry_mut(target) else { return Task::ready(true) };
        if entry.phase == ForkPhase::Live {
            entry.phase = ForkPhase::Cleanup;
        }
        let entry = entry.clone();
        self.persist(cx).detach();
        self.settle_entry(entry, requester, cx)
    }

    /// A window connected to the root `root_id`: settles the forks the
    /// ledger holds for it that nothing holds now.
    pub fn connected(&mut self, root_id: &str, requester: HostRequester, cx: &mut Context<Self>) {
        self.roots.insert(root_id.to_owned(), requester);
        if self.loaded {
            self.settle_root(root_id, false, cx);
        }
    }

    /// Settles the forks of the root `root_id` that nothing holds and that
    /// are not being settled: this run's only, when `only_mine`.
    fn settle_root(&mut self, root_id: &str, only_mine: bool, cx: &mut Context<Self>) {
        let Some(requester) = self.roots.get(root_id).cloned() else { return };
        let leftovers: Vec<ForkEntry> = self
            .entries
            .iter()
            .filter(|entry| {
                entry.root_id == root_id
                    && (!only_mine || entry.owner == self.owner.as_ref())
                    && !self.held.contains(&entry.target_session_id)
                    && !self.settling.contains(&entry.target_session_id)
            })
            .cloned()
            .collect();
        for entry in leftovers {
            log::info!(
                "side chats' ledger: settling fork {} ({:?})",
                entry.target_session_id,
                entry.phase
            );
            self.settle_entry(entry, requester.clone(), cx).detach();
        }
    }

    /// Settles `entry` unless its owner, another process, still runs.
    fn settle_entry(
        &mut self,
        entry: ForkEntry,
        requester: HostRequester,
        cx: &mut Context<Self>,
    ) -> Task<bool> {
        let target = entry.target_session_id.clone();
        if !self.settling.insert(target.clone()) {
            return Task::ready(false);
        }
        let store = self.store.clone().filter(|_| entry.owner != self.owner.as_ref());
        let executor = cx.background_executor().clone();
        let (reply, answer) = async_channel::bounded(1);
        let key = target.clone();
        let task = cx.spawn(async move |this, cx| {
            if let Some(store) = &store
                && store.is_owner_alive(&entry.owner).await
            {
                log::info!("side chats' ledger: fork {target} belongs to a running client");
                this.update(cx, |this, _| this.settling.remove(&target)).ok();
                reply.try_send(false).ok();
                return;
            }
            let result = fork::settle(&requester, &entry, &executor).await;
            let settled = result.is_ok();
            if let Err(error) = &result {
                log::warn!("side chats' ledger: fork {target} is not settled yet: {error}");
            }
            // Without a connection, the next one settles it.
            let again =
                matches!(&result, Err(error) if !matches!(error, HostRequestError::NotConnected));
            let owner = this
                .update(cx, |this, cx| {
                    this.settling.remove(&target);
                    this._settles.remove(&target);
                    if !settled && again && entry.owner == this.owner.as_ref() {
                        this.retry_later(cx);
                    }
                    if !settled || this.held.contains(&target) {
                        return None;
                    }
                    this.entries.retain(|known| known.target_session_id != target);
                    if entry.owner != this.owner.as_ref() {
                        this.settled.insert(target.clone());
                    }
                    this.persist(cx).detach();
                    cx.notify();
                    let ended = entry.owner != this.owner.as_ref()
                        && !this.entries.iter().any(|known| known.owner == entry.owner);
                    ended.then(|| (this.store.clone(), entry.owner.clone()))
                })
                .ok()
                .flatten();
            if let Some((Some(store), owner)) = owner {
                store.release_owner(&owner).await;
            }
            reply.try_send(settled).ok();
        });
        self._settles.insert(key, task);
        cx.foreground_executor().spawn(async move { answer.recv().await.unwrap_or(false) })
    }

    /// Settles this run's leftovers on the connected roots again in
    /// [`RETRY_INTERVAL`], unless that is already due. A fork being settled
    /// then is left to that settlement.
    fn retry_later(&mut self, cx: &mut Context<Self>) {
        if self.retry_armed {
            return;
        }
        self.retry_armed = true;
        self._retry = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(RETRY_INTERVAL).await;
            this.update(cx, |this, cx| {
                this.retry_armed = false;
                let roots: Vec<String> = this.roots.keys().cloned().collect();
                for root in roots {
                    this.settle_root(&root, true, cx);
                }
            })
            .ok();
        }));
    }

    fn entry_mut(&mut self, target: &str) -> Option<&mut ForkEntry> {
        self.entries.iter_mut().find(|entry| entry.target_session_id == target)
    }

    /// Saves the ledger as it stands; answers once a document holding
    /// this change is on disk.
    fn persist(&mut self, cx: &mut Context<Self>) -> Task<Result<(), SharedString>> {
        self.dirty += 1;
        let (reply, answer) = async_channel::bounded(1);
        self.waiters.push((self.dirty, reply));
        self.flush(cx);
        cx.notify();
        cx.foreground_executor().spawn(async move {
            answer.recv().await.unwrap_or_else(|_| Err("the ledger went away".into()))
        })
    }

    /// Starts a save of the newest document unless one runs or the saved
    /// one has not been read yet.
    fn flush(&mut self, cx: &mut Context<Self>) {
        if self.writing || !self.loaded || self.written == self.dirty {
            return;
        }
        let version = self.dirty;
        let Some(store) = self.store.clone() else {
            self.answer_waiters(version, Ok(()));
            return;
        };
        let owner = self.owner.to_string();
        let mine: Vec<ForkEntry> =
            self.entries.iter().filter(|entry| entry.owner == owner).cloned().collect();
        let settled = self.settled.clone();
        let saved = store.update(Box::new(move |saved| merge(saved, &owner, &mine, &settled)));
        let saved = cx.background_spawn(saved);
        self.writing = true;
        self._save = Some(cx.spawn(async move |this, cx| {
            let result = saved.await;
            this.update(cx, |this, cx| {
                this.writing = false;
                match result {
                    Ok(()) => this.answer_waiters(version, Ok(())),
                    Err(error) => {
                        log::warn!("could not save the side chats' ledger: {error}");
                        this.answer_waiters(version, Err(error.to_string().into()));
                    }
                }
                this.flush(cx);
            })
            .ok();
        }));
    }

    /// Answers the changes up to `version` with `result`. A failed save
    /// is not tried again by itself: the next change saves everything.
    fn answer_waiters(&mut self, version: u64, result: Result<(), SharedString>) {
        self.written = self.written.max(version);
        self.waiters.retain(|(waits_for, reply)| {
            if *waits_for <= version {
                reply.try_send(result.clone()).ok();
                false
            } else {
                true
            }
        });
    }
}

/// The entries of the saved document this client can settle. A document
/// that does not parse holds none (the next save sets it aside); an entry
/// this client cannot read, a newer client's phase, is left to the clients
/// that can, and stays on disk ([`merge`]).
fn read_entries(saved: &[u8]) -> Vec<ForkEntry> {
    let document = match serde_json::from_slice::<LedgerDocument>(saved) {
        Ok(document) => document,
        Err(error) => {
            log::warn!("the side chats' ledger does not parse: {error}");
            return Vec::new();
        }
    };
    document
        .forks
        .into_iter()
        .filter_map(|fork| match serde_json::from_value::<ForkEntry>(fork) {
            Ok(entry) => Some(entry),
            Err(error) => {
                log::warn!("leaving an entry of the side chats' ledger: {error}");
                None
            }
        })
        .collect()
}

/// The document a save writes over `saved`: its entries of other runs as
/// they are on disk, but those this run settled (`settled`), then the
/// entries of this run (`owner`), `mine`. A saved document that does not
/// parse is set aside.
fn merge(
    saved: Option<&[u8]>,
    owner: &str,
    mine: &[ForkEntry],
    settled: &HashSet<String>,
) -> io::Result<LedgerWrite> {
    let (theirs, set_aside) = match saved.map(serde_json::from_slice::<LedgerDocument>) {
        None => (Vec::new(), false),
        Some(Ok(document)) => (document.forks, false),
        Some(Err(_)) => (Vec::new(), true),
    };
    let mut forks: Vec<Value> = theirs
        .into_iter()
        .filter(|fork| {
            let field = |name: &str| fork.get(name).and_then(Value::as_str);
            field("owner") != Some(owner)
                && !field("targetSessionId").is_some_and(|target| settled.contains(target))
        })
        .collect();
    for entry in mine {
        forks.push(serde_json::to_value(entry).map_err(io::Error::other)?);
    }
    let document = LedgerDocument { version: 1, forks };
    let mut contents = serde_json::to_vec_pretty(&document).map_err(io::Error::other)?;
    contents.push(b'\n');
    Ok(LedgerWrite { contents, set_aside })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh directory under the system's temporary one.
    fn scratch() -> PathBuf {
        std::env::temp_dir().join(format!("maka-ledger-{}", uuid::Uuid::new_v4().simple()))
    }

    #[test]
    fn an_owner_is_alive_while_its_process_holds_its_lock() {
        let directory = scratch();
        let (path, owners) = (directory.join(LEDGER_FILE), directory.join(OWNER_LOCKS_DIRECTORY));
        let first = futures_lite::future::block_on(LedgerFile::open(path.clone(), owners.clone()))
            .expect("a ledger");
        let second = futures_lite::future::block_on(LedgerFile::open(path, owners.clone()))
            .expect("another");
        let owner = first.owner().to_string();
        assert!(futures_lite::future::block_on(second.is_owner_alive(&owner)), "it holds its lock");
        assert!(!futures_lite::future::block_on(second.is_owner_alive("0123abcd")), "no such file");
        assert!(!futures_lite::future::block_on(second.is_owner_alive("../etc")), "not a token");
        drop(first);
        assert!(
            !futures_lite::future::block_on(second.is_owner_alive(&owner)),
            "its process ended"
        );
        // A sweep removes the ended owner's lock unless an entry keeps it.
        let lock = owners.join(format!("{owner}.lock"));
        futures_lite::future::block_on(second.sweep_owners(vec![owner.clone()]));
        assert!(lock.exists(), "kept for its entries");
        futures_lite::future::block_on(second.sweep_owners(Vec::new()));
        assert!(!lock.exists(), "gone");
        assert!(owners.join(format!("{}.lock", second.owner())).exists(), "its own stays");
        drop(second);
        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn a_lock_gets_the_name_a_sweep_reads_only_once_it_is_held() {
        let directory = scratch();
        let (path, owners) = (directory.join(LEDGER_FILE), directory.join(OWNER_LOCKS_DIRECTORY));
        // Another process's lock, created and not locked yet.
        create_private_dir(&owners).expect("owners");
        let staged = owners.join("0123abcd.lock.new");
        File::create(&staged).expect("staged");
        let ledger = futures_lite::future::block_on(LedgerFile::open(path.clone(), owners.clone()))
            .expect("a ledger");
        futures_lite::future::block_on(ledger.sweep_owners(Vec::new()));
        assert!(staged.exists(), "a sweep passes over a lock being taken");
        #[allow(clippy::disallowed_methods)] // A test.
        let mut names: Vec<String> = std::fs::read_dir(&owners)
            .expect("owners")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        let mut expected = vec!["0123abcd.lock.new".to_owned(), format!("{}.lock", ledger.owner())];
        expected.sort();
        assert_eq!(names, expected, "its lock in place, nothing of it staged");
        let other = futures_lite::future::block_on(LedgerFile::open(path, owners)).expect("other");
        assert!(futures_lite::future::block_on(other.is_owner_alive(&ledger.owner())), "held");
        drop((ledger, other));
        std::fs::remove_dir_all(&directory).ok();
    }
}
