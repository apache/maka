//! The app's storage (`nsh/storage`) in the browser's `localStorage`.
//!
//! `localStorage` is the origin's, shared by every app the origin serves:
//! a published site per path, the development host and the website's
//! demos side by side. Each entry is kept under the app's prefix
//! ([`nsh_engine::local_storage_prefix`]): its id (`nsh.json` `"id"`), else
//! its page's path; so apps keep apart and the page's other keys are left
//! alone.
//!
//! `localStorage` throws when the browser refuses it (blocked storage,
//! the quota): a value it refuses is not set (`setItem` fails), and one
//! that could not load leaves the app with none.
//!
//! Other tabs of the origin share `localStorage`: what they change under
//! the app's prefix comes as `storage` events, which `nsh.js` hands in
//! ([`nsh_storage_changed`]) with the value this tab now reads, so the app's
//! entries follow.

use std::{
    cell::RefCell,
    collections::BTreeMap,
    sync::{Arc, Weak},
};

use nsh_engine::{StorageBackend, StorageChange};

use crate::{bytes, ffi, string};

thread_local! {
    /// What `nsh.js` handed over during a `storage_*` call
    /// ([`nsh_storage_reply`]).
    static REPLY: RefCell<Option<String>> = const { RefCell::new(None) };
    /// The storages of the apps started on the page, for the changes other
    /// tabs make ([`nsh_storage_changed`]).
    static OPEN: RefCell<Vec<Weak<LocalStorage>>> = const { RefCell::new(Vec::new()) };
}

/// Takes what [`nsh_storage_reply`] handed over.
pub(crate) fn take_reply() -> Option<String> {
    REPLY.with(|r| r.borrow_mut().take())
}

/// The reply to the `storage_*` call in progress: the entries `storage_load`
/// read (JSON) or the error a call failed with.
///
/// # Safety
///
/// `ptr..ptr + len` is memory from [`crate::nsh_alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_storage_reply(ptr: *const u8, len: usize) {
    // SAFETY: guaranteed by the caller.
    let reply = String::from_utf8_lossy(unsafe { bytes(ptr, len) }).into_owned();
    REPLY.with(|r| *r.borrow_mut() = Some(reply));
}

/// What another tab did to `localStorage` entry `prefix` + `key`, as this
/// tab now reads it: `kind` 1 holds `value`, 0 removed it; 2 is any entry
/// (`localStorage.clear()`, `key` empty). Returns the delay (ms) until
/// `nsh_pump` is due, or -1.
///
/// # Safety
///
/// The ranges are memory from [`crate::nsh_alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_storage_changed(
    prefix: *const u8,
    prefix_len: usize,
    key: *const u8,
    key_len: usize,
    value: *const u8,
    value_len: usize,
    kind: u32,
) -> f64 {
    // SAFETY: guaranteed by the caller.
    let (prefix, key, value) = unsafe {
        (
            string(prefix, prefix_len),
            string(key, key_len),
            string(value, value_len),
        )
    };
    let change = match kind {
        0 => Some(StorageChange::Remove(key)),
        1 => Some(StorageChange::Set(key, value)),
        _ => None,
    };
    let storages: Vec<_> = OPEN.with(|o| {
        let mut open = o.borrow_mut();
        open.retain(|s| s.strong_count() > 0);
        open.iter().filter_map(Weak::upgrade).collect()
    });
    for storage in storages.iter().filter(|s| s.prefix == prefix) {
        nsh_core::storage::changed_elsewhere(&**storage, change.clone());
    }
    crate::pump()
}

/// The app's entries in `localStorage`, under the app's prefix. Holds no JS
/// handle: `nsh.js` reaches `localStorage` on each call.
pub(crate) struct LocalStorage {
    prefix: String,
}

impl LocalStorage {
    /// The storage of app `app_id` on the page at `base_url`
    /// (`document.baseURI`). Without an id, the page's path names it
    /// (`None`: an unknown page, whose apps share one namespace).
    pub(crate) fn open(app_id: Option<&str>, base_url: Option<&str>) -> Arc<Self> {
        let storage = Arc::new(Self {
            prefix: nsh_engine::local_storage_prefix(app_id, base_url.unwrap_or("")),
        });
        OPEN.with(|o| o.borrow_mut().push(Arc::downgrade(&storage)));
        storage
    }
}

impl StorageBackend for LocalStorage {
    fn load(&self) -> Result<BTreeMap<String, String>, String> {
        let reply = ffi::storage_load(&self.prefix)?;
        serde_json::from_str(&reply).map_err(|e| e.to_string())
    }

    fn write(&self, change: StorageChange) -> Result<(), String> {
        match &change {
            StorageChange::Set(key, value) => ffi::storage_set(&self.prefix, key, value),
            StorageChange::Remove(key) => ffi::storage_remove(&self.prefix, key),
            StorageChange::Clear => ffi::storage_clear(&self.prefix),
        }
    }
}
