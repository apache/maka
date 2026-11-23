//! An app's key-value storage (`nsh/storage`): strings by string key,
//! kept on the device by the platform's [`StorageBackend`] (a file in the
//! app's data directory, the browser's `localStorage`).
//!
//! The core keeps the entries in memory, loaded from the backend on first
//! use. Cores using the same backend share entries and quota accounting,
//! with each operation serialized; reads after loading never touch the
//! disk. Every change is handed to the
//! backend, which writes it where it may block (the file backend on a
//! thread of its own). A value the backend refuses at once (the browser's
//! `localStorage`) is not kept, as one past the quota. What another writer
//! changes in the backend's entries (another browser tab of the app) the
//! platform hands in ([`changed_elsewhere`]). Every app has its storage:
//! what the host decides is where it is kept. The quota is checked here, in
//! Rust.
//!
//! What changes the entries elsewhere, another core sharing them (another
//! window of the app) or another writer the platform reports, is handed to
//! the watchers of every other core ([`Storage::on_change`], TS
//! `Storage.on("change", ...)`): each has a queue of its own, filled from
//! any thread and drained on its core's engine thread. A core's own
//! changes reach only the others.

use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicU64, Ordering},
    },
    task::{Poll, Waker},
};

/// The most an app may keep, in UTF-8 bytes of its keys and values.
pub const QUOTA: usize = 5 * 1024 * 1024;

/// A change to the entries, for the backend to keep.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StorageChange {
    /// `key` now holds `value`.
    Set(String, String),
    /// `key` was removed.
    Remove(String),
    /// Every entry was removed.
    Clear,
}

/// Where an app's entries are kept: the platform's.
pub trait StorageBackend: Send + Sync {
    /// The entries kept, read once when the app first uses its storage; an
    /// error leaves the app with none (logged).
    fn load(&self) -> Result<BTreeMap<String, String>, String>;
    /// Keeps `change`. Called on the engine thread: a backend that blocks
    /// writes elsewhere, in order, and returns before it knows how that
    /// went (logging what fails there). An error means the change was not
    /// kept: a value set is then refused ([`Storage::set_item`] fails and
    /// the entries stay as they were); a removal stays done in memory
    /// (logged), as the app asked.
    fn write(&self, change: StorageChange) -> Result<(), String>;
}

/// Names the backend only, so that platforms' options holding one can
/// derive `Debug`.
impl std::fmt::Debug for dyn StorageBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("StorageBackend")
    }
}

/// The app's key-value storage, from Rust: the same entries the app's JS
/// reads and writes with `nsh/storage`, so an app with a TSX entry and a
/// Rust entry sees one set of data. The functions are synchronous, as the
/// entries are in memory; call them where components run (their bodies,
/// handlers and tasks).
///
/// ```ignore
/// use nsh_core::storage::Storage;
///
/// let draft = Storage::get_item("draft");
/// Storage::set_item("draft", "hello")?;
/// ```
pub struct Storage;

impl Storage {
    /// The value of `key`, `None` when it has none (TS: `getItem`).
    pub fn get_item(key: &str) -> Option<String> {
        crate::element::with_storage(|s| s.get(key))
    }

    /// Sets `key` to `value` (TS: `setItem`); fails when the storage would
    /// grow past [`QUOTA`] or the device refuses the value (the browser's
    /// own quota, storage the user blocked), keeping what it held.
    pub fn set_item(key: impl Into<String>, value: impl Into<String>) -> Result<(), StorageFull> {
        crate::element::with_storage(|s| s.set(key.into(), value.into()))
    }

    /// Removes `key` (TS: `removeItem`).
    pub fn remove_item(key: &str) {
        crate::element::with_storage(|s| s.remove(key));
    }

    /// Every key, in order (TS: `keys`).
    pub fn get_all_keys() -> Vec<String> {
        crate::element::with_storage(|s| s.keys())
    }

    /// Removes every key (TS: `clear`).
    pub fn clear() {
        crate::element::with_storage(|s| s.clear());
    }

    /// Runs `f` with each change made to the entries elsewhere, while the
    /// current owner lives (TS: `Storage.on("change", ...)`): by another
    /// window or view of the app sharing its storage, or on the web by
    /// another tab of the app. The entries hold the change already, so
    /// [`Storage::get_item`] reads it; this core's own changes do not come.
    /// A change that leaves an entry as it was does not come either. Runs
    /// on the engine thread, in the order the changes were made.
    ///
    /// ```ignore
    /// Storage::on_change(move |change| {
    ///     if change.key().is_none_or(|key| key == "theme") {
    ///         theme.set(Storage::get_item("theme"));
    ///     }
    /// });
    /// ```
    pub fn on_change(f: impl Fn(&StorageChange) + 'static) {
        let watch = crate::element::with_storage(|s| s.watch());
        // Ends with the owner, dropping the watch.
        drop(crate::element::spawn(async move {
            loop {
                let change = watch.next().await;
                f(&change);
            }
        }));
    }
}

impl StorageChange {
    /// The key changed; `None` for [`StorageChange::Clear`], which changes
    /// every key.
    pub fn key(&self) -> Option<&str> {
        match self {
            Self::Set(key, _) | Self::Remove(key) => Some(key),
            Self::Clear => None,
        }
    }

    /// The value the key holds now; `None` when it was removed (or every
    /// key was).
    pub fn value(&self) -> Option<&str> {
        match self {
            Self::Set(_, value) => Some(value),
            Self::Remove(_) | Self::Clear => None,
        }
    }
}

/// A value refused because the storage would grow past [`QUOTA`], or
/// because the device refused to keep it (the browser's own quota, storage
/// the user blocked).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StorageFull {
    /// The bytes the storage would have held.
    pub bytes: usize,
}

impl std::fmt::Display for StorageFull {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.bytes > QUOTA {
            write!(
                f,
                "storage is full: {} bytes would exceed the quota of {QUOTA}",
                self.bytes
            )
        } else {
            write!(
                f,
                "storage is full: the device refused to keep {} bytes",
                self.bytes
            )
        }
    }
}

impl std::error::Error for StorageFull {}

/// An app's entries, shared by cores using the same backend: one core's
/// handle to them.
#[derive(Clone)]
pub(crate) struct Store {
    state: Arc<Mutex<Entries>>,
    /// The core's, telling its own changes from others'
    /// ([`Watcher::view`]).
    view: u64,
}

/// The changes made elsewhere one watch has not taken yet: filled under
/// the entries' lock from any thread, taken on its core's engine thread.
#[derive(Default)]
struct Inbox {
    state: Mutex<InboxState>,
}

#[derive(Default)]
struct InboxState {
    changes: VecDeque<StorageChange>,
    waker: Option<Waker>,
}

impl Inbox {
    fn push(&self, change: StorageChange) {
        let waker = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.changes.push_back(change);
            state.waker.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
    }
}

/// A watch of the changes made to the entries elsewhere ([`Store::watch`]),
/// until dropped.
pub(crate) struct Watch {
    inbox: Arc<Inbox>,
}

impl Watch {
    /// The next change made elsewhere, in order.
    pub(crate) async fn next(&self) -> StorageChange {
        std::future::poll_fn(|cx| {
            let mut state = self.inbox.state.lock().unwrap_or_else(|e| e.into_inner());
            match state.changes.pop_front() {
                Some(change) => Poll::Ready(change),
                None => {
                    state.waker = Some(cx.waker().clone());
                    Poll::Pending
                }
            }
        })
        .await
    }

    /// The next change made elsewhere, if one came.
    #[cfg(test)]
    fn try_next(&self) -> Option<StorageChange> {
        let mut state = self.inbox.state.lock().unwrap_or_else(|e| e.into_inner());
        state.changes.pop_front()
    }
}

/// A watch held by a core ([`Entries::notify`]).
struct Watcher {
    /// The [`Store::view`] it watches from: its changes are its own.
    view: u64,
    inbox: Weak<Inbox>,
}

/// The next [`Store::view`].
static NEXT_VIEW: AtomicU64 = AtomicU64::new(0);

/// Weak references let the last core release its state and backend.
struct Shared {
    backend: Weak<dyn StorageBackend>,
    state: Weak<Mutex<Entries>>,
}

/// The state of each backend in use. Indexed by backend identity, never by
/// an engine or app id: the host decides which views share storage by
/// sharing the backend.
static SHARED: Mutex<Vec<Shared>> = Mutex::new(Vec::new());

/// Takes in what another writer did to `backend`'s entries (another browser
/// tab of the same app): `change` as the backend now holds it, or `None`
/// when any entry may have changed, to be read again on next use. Every
/// core using `backend` sees it; nothing is written back. A backend no core
/// uses, or one not read yet, reads it when first used.
#[doc(hidden)]
pub fn changed_elsewhere(backend: &dyn StorageBackend, change: Option<StorageChange>) {
    let state = SHARED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .find(|s| std::ptr::addr_eq(s.backend.as_ptr(), backend as *const dyn StorageBackend))
        .and_then(|s| s.state.upgrade());
    if let Some(state) = state {
        state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .changed_elsewhere(change);
    }
}

impl Store {
    /// Shares the state of `backend`; `None` creates independent in-memory
    /// storage for this core.
    pub(crate) fn new(backend: Option<Arc<dyn StorageBackend>>) -> Self {
        let view = NEXT_VIEW.fetch_add(1, Ordering::Relaxed);
        let Some(backend) = backend else {
            return Self {
                state: Arc::new(Mutex::new(Entries::new(None))),
                view,
            };
        };
        let mut shared = SHARED.lock().unwrap_or_else(|e| e.into_inner());
        shared.retain(|s| s.state.strong_count() > 0);
        let identity = Arc::downgrade(&backend);
        if let Some(state) = shared
            .iter()
            .find(|s| s.backend.ptr_eq(&identity))
            .and_then(|s| s.state.upgrade())
        {
            return Self { state, view };
        }
        let state = Arc::new(Mutex::new(Entries::new(Some(backend))));
        shared.push(Shared {
            backend: identity,
            state: Arc::downgrade(&state),
        });
        Self { state, view }
    }

    fn entries(&self) -> std::sync::MutexGuard<'_, Entries> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The value of `key`.
    pub(crate) fn get(&self, key: &str) -> Option<String> {
        self.entries().get(key)
    }

    /// Sets `key` to `value`; fails past [`QUOTA`].
    pub(crate) fn set(&self, key: String, value: String) -> Result<(), StorageFull> {
        self.entries().set(key, value, self.view)
    }

    /// Removes `key`.
    pub(crate) fn remove(&self, key: &str) {
        self.entries().remove(key, self.view)
    }

    /// Every key, in order.
    pub(crate) fn keys(&self) -> Vec<String> {
        self.entries().keys()
    }

    /// Removes every entry.
    pub(crate) fn clear(&self) {
        self.entries().clear(self.view)
    }

    /// Watches the changes made to the entries elsewhere: by other cores,
    /// or by other writers the platform reports ([`changed_elsewhere`]).
    /// Loads the entries, so that what changes from then on is known.
    pub(crate) fn watch(&self) -> Watch {
        let inbox = Arc::new(Inbox::default());
        let mut entries = self.entries();
        entries.entries();
        entries.watchers.retain(|w| w.inbox.strong_count() > 0);
        entries.watchers.push(Watcher {
            view: self.view,
            inbox: Arc::downgrade(&inbox),
        });
        Watch { inbox }
    }
}

/// The authoritative entries and quota, locked through backend dispatch
/// so concurrent cores hand their changes to the backend in the same order.
struct Entries {
    backend: Option<Arc<dyn StorageBackend>>,
    entries: Option<BTreeMap<String, String>>,
    bytes: usize,
    /// The cores' watches of changes made elsewhere ([`Store::watch`]).
    watchers: Vec<Watcher>,
}

impl Entries {
    /// Entries kept by `backend` (`None`: in memory, for the engine's
    /// life).
    fn new(backend: Option<Arc<dyn StorageBackend>>) -> Self {
        Self {
            backend,
            entries: None,
            bytes: 0,
            watchers: Vec::new(),
        }
    }

    /// Hands `change` to the watchers of every view but `from` (`None`: to
    /// all), made only when one watches.
    fn notify(&mut self, from: Option<u64>, change: impl FnOnce() -> StorageChange) {
        if self.watchers.is_empty() {
            return;
        }
        self.watchers.retain(|w| w.inbox.strong_count() > 0);
        let inboxes: Vec<_> = self
            .watchers
            .iter()
            .filter(|w| Some(w.view) != from)
            .filter_map(|w| w.inbox.upgrade())
            .collect();
        if inboxes.is_empty() {
            return;
        }
        let change = change();
        for inbox in inboxes {
            inbox.push(change.clone());
        }
    }

    fn entries(&mut self) -> &mut BTreeMap<String, String> {
        let backend = &self.backend;
        let bytes = &mut self.bytes;
        self.entries.get_or_insert_with(|| {
            let entries = match backend.as_ref().map(|b| b.load()) {
                Some(Ok(entries)) => entries,
                Some(Err(e)) => {
                    log::error!(target: "js", "the app's storage could not be read: {e}");
                    BTreeMap::new()
                }
                None => BTreeMap::new(),
            };
            *bytes = entries.iter().map(|(k, v)| k.len() + v.len()).sum();
            entries
        })
    }

    fn write(&self, change: StorageChange) -> Result<(), String> {
        match &self.backend {
            Some(backend) => backend.write(change),
            None => Ok(()),
        }
    }

    /// Writes a removal, done in memory whatever comes of it: the app asked
    /// for the entry gone, and a backend that refuses one (the browser's
    /// `localStorage` only does when it cannot be reached at all) has
    /// refused every value since it was read.
    fn write_removal(&self, change: StorageChange) {
        if let Err(e) = self.write(change) {
            log::error!(target: "js", "the app's storage could not be written: {e}");
        }
    }

    /// The value of `key`.
    fn get(&mut self, key: &str) -> Option<String> {
        self.entries().get(key).cloned()
    }

    /// Sets `key` to `value` for view `from`; fails past [`QUOTA`].
    fn set(&mut self, key: String, value: String, from: u64) -> Result<(), StorageFull> {
        // Loaded first: what the device kept counts too.
        self.entries();
        let bytes = self.bytes;
        let entries = self.entries();
        let old = entries.get(&key).map_or(0, |v| key.len() + v.len());
        let new = bytes - old + key.len() + value.len();
        if new > QUOTA {
            return Err(StorageFull { bytes: new });
        }
        if entries.get(&key) == Some(&value) {
            return Ok(());
        }
        // Written first, the entries changing only once it is kept: under
        // the lock, so no other core sees it in between.
        if let Err(e) = self.write(StorageChange::Set(key.clone(), value.clone())) {
            log::warn!(target: "js", "the app's storage refused {key:?}: {e}");
            return Err(StorageFull { bytes: new });
        }
        self.notify(Some(from), || {
            StorageChange::Set(key.clone(), value.clone())
        });
        self.entries().insert(key, value);
        self.bytes = new;
        Ok(())
    }

    /// Removes `key` for view `from`.
    fn remove(&mut self, key: &str, from: u64) {
        let Some(value) = self.entries().remove(key) else {
            return;
        };
        self.bytes -= key.len() + value.len();
        self.write_removal(StorageChange::Remove(key.to_owned()));
        self.notify(Some(from), || StorageChange::Remove(key.to_owned()));
    }

    /// Every key, in order.
    fn keys(&mut self) -> Vec<String> {
        self.entries().keys().cloned().collect()
    }

    /// Removes every entry for view `from`.
    fn clear(&mut self, from: u64) {
        let entries = self.entries();
        if entries.is_empty() {
            return;
        }
        entries.clear();
        self.bytes = 0;
        self.write_removal(StorageChange::Clear);
        self.notify(Some(from), || StorageChange::Clear);
    }

    /// [`changed_elsewhere`]: told to every watcher when it changes what
    /// the entries hold.
    fn changed_elsewhere(&mut self, change: Option<StorageChange>) {
        let Some(entries) = &mut self.entries else {
            // The load reads it. Nothing watches yet: a watch loads.
            return;
        };
        let size = |key: &str, value: &str| key.len() + value.len();
        match change {
            Some(StorageChange::Set(key, value)) => {
                if entries.get(&key) == Some(&value) {
                    return;
                }
                self.bytes += size(&key, &value);
                if let Some(old) = entries.insert(key.clone(), value.clone()) {
                    self.bytes -= size(&key, &old);
                }
                self.notify(None, || StorageChange::Set(key, value));
            }
            Some(StorageChange::Remove(key)) => {
                let Some(old) = entries.remove(&key) else {
                    return;
                };
                self.bytes -= size(&key, &old);
                self.notify(None, || StorageChange::Remove(key));
            }
            Some(StorageChange::Clear) => {
                if entries.is_empty() {
                    return;
                }
                entries.clear();
                self.bytes = 0;
                self.notify(None, || StorageChange::Clear);
            }
            None => {
                let old = self.entries.take().unwrap_or_default();
                self.bytes = 0;
                if self.watchers.iter().all(|w| w.inbox.strong_count() == 0) {
                    // Read again on next use.
                    return;
                }
                // Read again now, for the watchers to hear what changed.
                let new = self.entries().clone();
                for change in diff(&old, &new) {
                    self.notify(None, || change);
                }
            }
        }
    }
}

/// The changes that make `old` into `new`, in key order.
fn diff(old: &BTreeMap<String, String>, new: &BTreeMap<String, String>) -> Vec<StorageChange> {
    let removed = old
        .keys()
        .filter(|key| !new.contains_key(*key))
        .map(|key| (key, StorageChange::Remove(key.clone())));
    let set = new
        .iter()
        .filter(|(key, value)| old.get(*key) != Some(value))
        .map(|(key, value)| (key, StorageChange::Set(key.clone(), value.clone())));
    let mut changes: Vec<_> = removed.chain(set).collect();
    changes.sort_by(|a, b| a.0.cmp(b.0));
    changes.into_iter().map(|(_, change)| change).collect()
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    struct Recorder {
        kept: BTreeMap<String, String>,
        changes: Mutex<Vec<StorageChange>>,
    }

    impl StorageBackend for Recorder {
        fn load(&self) -> Result<BTreeMap<String, String>, String> {
            Ok(self.kept.clone())
        }

        fn write(&self, change: StorageChange) -> Result<(), String> {
            self.changes.lock().unwrap().push(change);
            Ok(())
        }
    }

    #[test]
    fn loads_once_and_writes_changes() {
        let backend = Arc::new(Recorder {
            kept: BTreeMap::from([("a".into(), "1".into())]),
            ..Recorder::default()
        });
        let storage = Store::new(Some(backend.clone()));
        assert_eq!(storage.get("a").as_deref(), Some("1"));
        storage.set("b".into(), "2".into()).unwrap();
        storage.set("b".into(), "2".into()).unwrap();
        storage.remove("a");
        storage.remove("missing");
        assert_eq!(storage.keys(), ["b"]);
        storage.clear();
        assert_eq!(
            *backend.changes.lock().unwrap(),
            [
                StorageChange::Set("b".into(), "2".into()),
                StorageChange::Remove("a".into()),
                StorageChange::Clear,
            ]
        );
    }

    #[test]
    fn views_share_reads_removals_and_clear() {
        let backend = Arc::new(Recorder::default());
        let first = Store::new(Some(backend.clone()));
        let second = Store::new(Some(backend));
        assert_eq!(second.get("draft"), None);
        first.set("draft".into(), "saved".into()).unwrap();
        assert_eq!(second.get("draft").as_deref(), Some("saved"));
        assert_eq!(second.keys(), ["draft"]);
        second.remove("draft");
        assert_eq!(first.get("draft"), None);
        first.set("draft".into(), "new".into()).unwrap();
        second.clear();
        assert!(first.keys().is_empty());
    }

    #[test]
    fn concurrent_views_share_the_quota() {
        let backend = Arc::new(Recorder::default());
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let views: Vec<_> = (0..2)
            .map(|id| {
                let storage = Store::new(Some(backend.clone()));
                // Both views load before either writes.
                assert!(storage.keys().is_empty());
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    storage.set(id.to_string(), "x".repeat(QUOTA - 1))
                })
            })
            .collect();
        let results: Vec<_> = views.into_iter().map(|v| v.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(backend.changes.lock().unwrap().len(), 1);
    }

    #[test]
    fn independent_backends_and_in_memory_views_keep_apart() {
        for backends in [
            [None, None],
            [
                Some(Arc::new(Recorder::default()) as Arc<dyn StorageBackend>),
                Some(Arc::new(Recorder::default()) as Arc<dyn StorageBackend>),
            ],
        ] {
            let [first, second] = backends;
            let first = Store::new(first);
            let second = Store::new(second);
            first.set("draft".into(), "saved".into()).unwrap();
            assert_eq!(second.get("draft"), None);
            second.clear();
            assert_eq!(first.get("draft").as_deref(), Some("saved"));
        }
    }

    #[test]
    fn checks_the_quota() {
        let storage = Store::new(None);
        storage.set("k".into(), "x".repeat(QUOTA - 1)).unwrap();
        assert!(storage.set("j".into(), "y".into()).is_err());
        // Replacing a value counts the new one only.
        storage.set("k".into(), "z".repeat(QUOTA - 1)).unwrap();
    }

    #[test]
    fn the_quota_counts_utf8_bytes_and_frees_on_removal() {
        let storage = Store::new(None);
        // "键" is three bytes, "😀" four.
        storage
            .set("键".into(), "😀".repeat((QUOTA - 3) / 4))
            .unwrap();
        let used = 3 + (QUOTA - 3) / 4 * 4;
        assert!(storage.set("x".into(), "y".repeat(QUOTA - used)).is_err());
        // A refused value leaves the entries as they were.
        assert_eq!(storage.keys(), ["键"]);
        storage.remove("键");
        storage.set("x".into(), "y".repeat(QUOTA - 1)).unwrap();
        storage.clear();
        assert!(storage.keys().is_empty());
        storage.set("x".into(), "y".repeat(QUOTA - 1)).unwrap();
    }

    #[test]
    fn the_quota_counts_what_was_loaded() {
        let backend = Arc::new(Recorder {
            kept: BTreeMap::from([("k".into(), "v".repeat(QUOTA - 1))]),
            ..Recorder::default()
        });
        let storage = Store::new(Some(backend));
        assert!(storage.set("a".into(), "b".into()).is_err());
        storage.set("k".into(), "small".into()).unwrap();
        storage.set("a".into(), "b".into()).unwrap();
    }

    #[test]
    fn a_failed_load_starts_empty() {
        struct Broken;
        impl StorageBackend for Broken {
            fn load(&self) -> Result<BTreeMap<String, String>, String> {
                Err("unreadable".into())
            }

            fn write(&self, _: StorageChange) -> Result<(), String> {
                Ok(())
            }
        }
        let storage = Store::new(Some(Arc::new(Broken)));
        assert_eq!(storage.get("a"), None);
        storage.set("a".into(), "1".into()).unwrap();
        assert_eq!(storage.get("a").as_deref(), Some("1"));
    }

    /// Storage that refuses every change, as `localStorage` does when the
    /// user blocked it or the browser's quota is used up.
    struct Refusing {
        kept: BTreeMap<String, String>,
    }

    impl StorageBackend for Refusing {
        fn load(&self) -> Result<BTreeMap<String, String>, String> {
            Ok(self.kept.clone())
        }

        fn write(&self, _: StorageChange) -> Result<(), String> {
            Err("QuotaExceededError".into())
        }
    }

    #[test]
    fn a_value_the_backend_refuses_is_not_kept() {
        let backend: Arc<dyn StorageBackend> = Arc::new(Refusing {
            kept: BTreeMap::from([("draft".into(), "old".into())]),
        });
        let storage = Store::new(Some(backend.clone()));
        let other = Store::new(Some(backend));
        let refused = storage.set("draft".into(), "new".into()).unwrap_err();
        assert_eq!(refused, StorageFull { bytes: 8 });
        assert!(refused.to_string().contains("refused"));
        assert!(storage.set("added".into(), "1".into()).is_err());
        for view in [&storage, &other] {
            assert_eq!(view.get("draft").as_deref(), Some("old"));
            assert_eq!(view.keys(), ["draft"]);
        }
    }

    #[test]
    fn removals_the_backend_refuses_are_done_in_memory() {
        let storage = Store::new(Some(Arc::new(Refusing {
            kept: BTreeMap::from([("a".into(), "1".into()), ("b".into(), "2".into())]),
        })));
        storage.remove("a");
        assert_eq!(storage.keys(), ["b"]);
        storage.clear();
        assert!(storage.keys().is_empty());
    }

    #[test]
    fn changes_made_elsewhere_reach_every_view() {
        let backend: Arc<dyn StorageBackend> = Arc::new(Recorder {
            kept: BTreeMap::from([("a".into(), "1".into())]),
            ..Recorder::default()
        });
        let first = Store::new(Some(backend.clone()));
        let second = Store::new(Some(backend.clone()));
        assert_eq!(first.get("a").as_deref(), Some("1"));
        changed_elsewhere(&*backend, Some(StorageChange::Set("a".into(), "2".into())));
        changed_elsewhere(&*backend, Some(StorageChange::Set("b".into(), "3".into())));
        assert_eq!(second.get("a").as_deref(), Some("2"));
        assert_eq!(first.keys(), ["a", "b"]);
        changed_elsewhere(&*backend, Some(StorageChange::Remove("a".into())));
        assert_eq!(second.keys(), ["b"]);
        changed_elsewhere(&*backend, Some(StorageChange::Clear));
        assert!(first.keys().is_empty());
        // Nothing went back to the backend.
        assert!(
            backend
                .load()
                .is_ok_and(|kept| kept == BTreeMap::from([("a".into(), "1".into())]))
        );
        // `None`: read again on next use.
        changed_elsewhere(&*backend, None);
        assert_eq!(second.get("a").as_deref(), Some("1"));
    }

    #[test]
    fn changes_made_elsewhere_count_toward_the_quota() {
        let backend: Arc<dyn StorageBackend> = Arc::new(Recorder::default());
        let storage = Store::new(Some(backend.clone()));
        assert!(storage.keys().is_empty());
        changed_elsewhere(
            &*backend,
            Some(StorageChange::Set("k".into(), "x".repeat(QUOTA - 1))),
        );
        assert!(storage.set("j".into(), "y".into()).is_err());
        changed_elsewhere(&*backend, Some(StorageChange::Set("k".into(), "x".into())));
        // "k" and "x", then "j" and its value: the quota exactly.
        storage.set("j".into(), "y".repeat(QUOTA - 3)).unwrap();
        changed_elsewhere(&*backend, Some(StorageChange::Remove("j".into())));
        storage.set("i".into(), "y".repeat(QUOTA - 3)).unwrap();
    }

    #[test]
    fn changes_made_elsewhere_before_the_first_read_come_with_the_load() {
        let backend: Arc<dyn StorageBackend> = Arc::new(Recorder {
            kept: BTreeMap::from([("a".into(), "kept".into())]),
            ..Recorder::default()
        });
        let storage = Store::new(Some(backend.clone()));
        changed_elsewhere(
            &*backend,
            Some(StorageChange::Set("b".into(), "lost".into())),
        );
        assert_eq!(storage.keys(), ["a"]);
        // A backend no core uses takes nothing in.
        changed_elsewhere(&Recorder::default(), Some(StorageChange::Clear));
    }

    #[test]
    fn watchers_hear_other_views_changes_only() {
        let backend: Arc<dyn StorageBackend> = Arc::new(Recorder {
            kept: BTreeMap::from([("a".into(), "1".into())]),
            ..Recorder::default()
        });
        let first = Store::new(Some(backend.clone()));
        let second = Store::new(Some(backend.clone()));
        let third = Store::new(Some(backend));
        let heard_by_first = first.watch();
        let heard_by_second = second.watch();
        // Each watch has a queue of its own.
        let also_by_second = second.clone().watch();
        first.set("theme".into(), "dark".into()).unwrap();
        // Unchanged: nothing to hear.
        first.set("theme".into(), "dark".into()).unwrap();
        first.remove("missing");
        third.remove("a");
        second.set("own".into(), "x".into()).unwrap();
        third.clear();
        third.clear();
        let drain = |watch: &Watch| std::iter::from_fn(|| watch.try_next()).collect::<Vec<_>>();
        assert_eq!(
            drain(&heard_by_first),
            [
                StorageChange::Remove("a".into()),
                StorageChange::Set("own".into(), "x".into()),
                StorageChange::Clear,
            ]
        );
        let expected = [
            StorageChange::Set("theme".into(), "dark".into()),
            StorageChange::Remove("a".into()),
            StorageChange::Clear,
        ];
        assert_eq!(drain(&heard_by_second), expected);
        assert_eq!(drain(&also_by_second), expected);
        // A dropped watch is let go.
        drop(heard_by_first);
        third.set("b".into(), "2".into()).unwrap();
        assert_eq!(drain(&heard_by_second).len(), 1);
    }

    #[test]
    fn watchers_hear_what_other_writers_changed() {
        let backend = Arc::new(Recorder {
            kept: BTreeMap::from([("a".into(), "1".into()), ("b".into(), "2".into())]),
            ..Recorder::default()
        });
        let shared: Arc<dyn StorageBackend> = backend.clone();
        let storage = Store::new(Some(shared.clone()));
        let watch = storage.watch();
        let drain = || std::iter::from_fn(|| watch.try_next()).collect::<Vec<_>>();
        changed_elsewhere(&*shared, Some(StorageChange::Set("a".into(), "one".into())));
        // What the entries hold already (this view wrote it since).
        changed_elsewhere(&*shared, Some(StorageChange::Set("a".into(), "one".into())));
        changed_elsewhere(&*shared, Some(StorageChange::Remove("missing".into())));
        changed_elsewhere(&*shared, Some(StorageChange::Remove("b".into())));
        assert_eq!(
            drain(),
            [
                StorageChange::Set("a".into(), "one".into()),
                StorageChange::Remove("b".into()),
            ]
        );
        assert_eq!(storage.get("a").as_deref(), Some("one"));
        // `None`: read again at once, what changed told key by key. The
        // backend still holds what it was made with.
        changed_elsewhere(&*shared, None);
        assert_eq!(
            drain(),
            [
                StorageChange::Set("a".into(), "1".into()),
                StorageChange::Set("b".into(), "2".into()),
            ]
        );
        changed_elsewhere(&*shared, Some(StorageChange::Set("c".into(), "3".into())));
        changed_elsewhere(&*shared, Some(StorageChange::Remove("a".into())));
        drain();
        changed_elsewhere(&*shared, None);
        assert_eq!(
            drain(),
            [
                StorageChange::Set("a".into(), "1".into()),
                StorageChange::Remove("c".into()),
            ]
        );
        changed_elsewhere(&*shared, Some(StorageChange::Clear));
        changed_elsewhere(&*shared, Some(StorageChange::Clear));
        assert_eq!(drain(), [StorageChange::Clear]);
        assert!(backend.changes.lock().unwrap().is_empty());
    }

    #[test]
    fn a_watch_waits_for_the_next_change() {
        use std::task::{Context, Wake};

        struct Flag(std::sync::atomic::AtomicBool);
        impl Wake for Flag {
            fn wake(self: Arc<Self>) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let backend: Arc<dyn StorageBackend> = Arc::new(Recorder::default());
        let watching = Store::new(Some(backend.clone()));
        let writing = Store::new(Some(backend));
        let watch = watching.watch();
        let flag = Arc::new(Flag(Default::default()));
        let waker = Waker::from(flag.clone());
        let mut cx = Context::from_waker(&waker);
        let mut next = Box::pin(watch.next());
        assert!(next.as_mut().poll(&mut cx).is_pending());
        // Written on another thread, as another window's engine does.
        std::thread::spawn(move || writing.set("k".into(), "v".into()).unwrap())
            .join()
            .unwrap();
        assert!(flag.0.load(Ordering::SeqCst));
        assert_eq!(
            next.as_mut().poll(&mut cx),
            Poll::Ready(StorageChange::Set("k".into(), "v".into()))
        );
    }

    #[test]
    fn a_change_names_its_key_and_value() {
        let set = StorageChange::Set("k".into(), "v".into());
        assert_eq!((set.key(), set.value()), (Some("k"), Some("v")));
        let removed = StorageChange::Remove("k".into());
        assert_eq!((removed.key(), removed.value()), (Some("k"), None));
        assert_eq!(
            (StorageChange::Clear.key(), StorageChange::Clear.value()),
            (None, None)
        );
    }
}
