//! An app's key-value storage (`nsh/storage`): strings by string key,
//! kept on the device by the platform's [`StorageBackend`] (a file in the
//! app's data directory, the browser's `localStorage`).
//!
//! The core keeps the entries in memory, loaded from the backend on first
//! use. Cores using the same backend share entries and quota accounting,
//! with each operation serialized; reads after loading never touch the
//! disk. Every change is handed to the
//! backend, which writes it where it may block (the file backend on a
//! thread of its own). Every app has its storage: what the host decides is
//! where it is kept. The quota is checked here, in Rust.

use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, Weak},
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
    /// writes elsewhere, in order.
    fn write(&self, change: StorageChange);
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
        crate::element::ambient::with_storage(|s| s.get(key))
    }

    /// Sets `key` to `value` (TS: `setItem`); fails when the storage would
    /// grow past [`QUOTA`], keeping what it held.
    pub fn set_item(key: impl Into<String>, value: impl Into<String>) -> Result<(), StorageFull> {
        crate::element::ambient::with_storage(|s| s.set(key.into(), value.into()))
    }

    /// Removes `key` (TS: `removeItem`).
    pub fn remove_item(key: &str) {
        crate::element::ambient::with_storage(|s| s.remove(key));
    }

    /// Every key, in order (TS: `keys`).
    pub fn get_all_keys() -> Vec<String> {
        crate::element::ambient::with_storage(|s| s.keys())
    }

    /// Removes every key (TS: `clear`).
    pub fn clear() {
        crate::element::ambient::with_storage(|s| s.clear());
    }
}

/// A value refused because the storage would grow past [`QUOTA`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StorageFull {
    /// The bytes the storage would have held.
    pub bytes: usize,
}

impl std::fmt::Display for StorageFull {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "storage is full: {} bytes would exceed the quota of {QUOTA}",
            self.bytes
        )
    }
}

impl std::error::Error for StorageFull {}

/// An app's entries, shared by cores using the same backend.
#[derive(Clone)]
pub(crate) struct Store {
    state: Arc<Mutex<Entries>>,
}

/// Weak references let the last core release its state and backend.
struct Shared {
    backend: Weak<dyn StorageBackend>,
    state: Weak<Mutex<Entries>>,
}

impl Store {
    /// Shares the state of `backend`; `None` creates independent in-memory
    /// storage for this core.
    pub(crate) fn new(backend: Option<Arc<dyn StorageBackend>>) -> Self {
        // Index by backend identity, never by an engine or app id: the
        // host decides which views share storage by sharing the backend.
        static SHARED: Mutex<Vec<Shared>> = Mutex::new(Vec::new());
        let Some(backend) = backend else {
            return Self {
                state: Arc::new(Mutex::new(Entries::new(None))),
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
            return Self { state };
        }
        let state = Arc::new(Mutex::new(Entries::new(Some(backend))));
        shared.push(Shared {
            backend: identity,
            state: Arc::downgrade(&state),
        });
        Self { state }
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
        self.entries().set(key, value)
    }

    /// Removes `key`.
    pub(crate) fn remove(&self, key: &str) {
        self.entries().remove(key)
    }

    /// Every key, in order.
    pub(crate) fn keys(&self) -> Vec<String> {
        self.entries().keys()
    }

    /// Removes every entry.
    pub(crate) fn clear(&self) {
        self.entries().clear()
    }
}

/// The authoritative entries and quota, locked through backend dispatch
/// so concurrent cores hand their changes to the backend in the same order.
struct Entries {
    backend: Option<Arc<dyn StorageBackend>>,
    entries: Option<BTreeMap<String, String>>,
    bytes: usize,
}

impl Entries {
    /// Entries kept by `backend` (`None`: in memory, for the engine's
    /// life).
    fn new(backend: Option<Arc<dyn StorageBackend>>) -> Self {
        Self {
            backend,
            entries: None,
            bytes: 0,
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

    fn write(&self, change: StorageChange) {
        if let Some(backend) = &self.backend {
            backend.write(change);
        }
    }

    /// The value of `key`.
    fn get(&mut self, key: &str) -> Option<String> {
        self.entries().get(key).cloned()
    }

    /// Sets `key` to `value`; fails past [`QUOTA`].
    fn set(&mut self, key: String, value: String) -> Result<(), StorageFull> {
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
        entries.insert(key.clone(), value.clone());
        self.bytes = new;
        self.write(StorageChange::Set(key, value));
        Ok(())
    }

    /// Removes `key`.
    fn remove(&mut self, key: &str) {
        let Some(value) = self.entries().remove(key) else {
            return;
        };
        self.bytes -= key.len() + value.len();
        self.write(StorageChange::Remove(key.to_owned()));
    }

    /// Every key, in order.
    fn keys(&mut self) -> Vec<String> {
        self.entries().keys().cloned().collect()
    }

    /// Removes every entry.
    fn clear(&mut self) {
        let entries = self.entries();
        if entries.is_empty() {
            return;
        }
        entries.clear();
        self.bytes = 0;
        self.write(StorageChange::Clear);
    }
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

        fn write(&self, change: StorageChange) {
            self.changes.lock().unwrap().push(change);
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

            fn write(&self, _: StorageChange) {}
        }
        let storage = Store::new(Some(Arc::new(Broken)));
        assert_eq!(storage.get("a"), None);
        storage.set("a".into(), "1".into()).unwrap();
        assert_eq!(storage.get("a").as_deref(), Some("1"));
    }
}
