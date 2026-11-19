//! Storage in memory: what a test session's app starts with and writes to,
//! headless or on a real host.

use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

use nsh_core::storage::{StorageBackend, StorageChange};

/// Storage in memory that starts with the entries given: an app's data as
/// a test sets it up. Shared ([`Arc`]), it shows what the app wrote.
#[derive(Debug, Default)]
pub struct MemoryStorage {
    entries: Mutex<BTreeMap<String, String>>,
}

impl MemoryStorage {
    /// Storage holding `entries`.
    pub fn new(entries: impl IntoIterator<Item = (String, String)>) -> Arc<Self> {
        Arc::new(Self {
            entries: Mutex::new(entries.into_iter().collect()),
        })
    }

    /// The entries now.
    pub fn entries(&self) -> BTreeMap<String, String> {
        self.entries.lock().expect("entries").clone()
    }
}

impl StorageBackend for MemoryStorage {
    fn load(&self) -> Result<BTreeMap<String, String>, String> {
        Ok(self.entries())
    }

    fn write(&self, change: StorageChange) -> Result<(), String> {
        let mut entries = self.entries.lock().expect("entries");
        match change {
            StorageChange::Set(key, value) => {
                entries.insert(key, value);
            }
            StorageChange::Remove(key) => {
                entries.remove(&key);
            }
            StorageChange::Clear => entries.clear(),
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_starts_with_its_entries_and_keeps_changes() {
        let storage = MemoryStorage::new([("todos".to_owned(), "[]".to_owned())]);
        assert_eq!(storage.load().unwrap()["todos"], "[]");
        storage
            .write(StorageChange::Set("theme".into(), "dark".into()))
            .unwrap();
        storage
            .write(StorageChange::Remove("todos".into()))
            .unwrap();
        assert_eq!(
            storage.entries().into_iter().collect::<Vec<_>>(),
            [("theme".to_owned(), "dark".to_owned())]
        );
    }
}
