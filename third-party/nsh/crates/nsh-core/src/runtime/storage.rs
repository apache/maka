//! `nsh/storage`: the app's key-value storage, strings by string key kept
//! on the device (`crate::storage`).

use crate::element::{ambient::with_storage, module};

/// The app's key-value storage: strings by string key, kept on the device
/// across launches (up to 5 MB). Calls run in order, so a read after a
/// write sees it.
///
/// # Rust
///
/// Every function is `async` (a promise), as `nsh/storage`'s callers
/// await them alike.
#[module]
pub(crate) struct Storage;

#[module]
impl Storage {
    /// The value of `key`, `null` when it has none.
    pub(crate) async fn get_item(key: String) -> Option<String> {
        with_storage(|s| s.get(&key))
    }

    /// Sets `key` to `value`; rejects when the storage would be full.
    pub(crate) async fn set_item(key: String, value: String) -> Result<(), String> {
        with_storage(|s| s.set(key, value)).map_err(|e| e.to_string())
    }

    /// Removes `key`.
    pub(crate) async fn remove_item(key: String) -> Result<(), String> {
        with_storage(|s| s.remove(&key));
        Ok(())
    }

    /// Every key, in order.
    pub(crate) async fn keys() -> Vec<String> {
        with_storage(|s| s.keys())
    }

    /// Removes every key.
    pub(crate) async fn clear() -> Result<(), String> {
        with_storage(|s| s.clear());
        Ok(())
    }
}
