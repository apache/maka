//! `nsh/storage`: the app's key-value storage, strings by string key kept
//! on the device (`crate::storage`), and the changes made to it elsewhere
//! (`change`).

use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
};

use crate::{
    element::{
        CallCx, Callback, JsError, JsObject, Local, PropEnum, Stop, System, codes, module,
        with_storage,
    },
    storage::StorageChange,
};

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

    /// Sets `key` to `value`; rejects with `ERR_NSH_QUOTA_EXCEEDED` when
    /// the storage would be full or the device refuses the value (the
    /// browser's own quota, storage the user blocked): the value is not set.
    pub(crate) async fn set_item(key: String, value: String) -> Result<(), JsError> {
        with_storage(|s| s.set(key, value))
            .map_err(|full| JsError::Error(full.to_string()).with_code(codes::QUOTA_EXCEEDED))
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

    /// Listens to `event`. `change`: the entries were changed elsewhere,
    /// by another window or view of the app sharing its storage, or on the
    /// web by another tab of the app; `getItem` reads the change already.
    /// The app's own changes here do not come, nor one that leaves an entry
    /// as it was; changes made while nothing listened are not kept. Returns
    /// a function that stops listening.
    pub(crate) fn on(
        event: StorageEvent,
        #[args(change)] listener: Callback<StorageChangeEvent>,
        sys: System,
        cx: CallCx<'_>,
    ) -> Result<Stop, JsError> {
        let StorageEvent::Change = event;
        let changes = sys.locals.get::<Changes>();
        let id = changes.next.get();
        changes.next.set(id.wrapping_add(1));
        changes.listeners.borrow_mut().push((id, listener));
        if !changes.started.replace(true) {
            cx.start(deliver(Rc::downgrade(&changes)));
        }
        let changes = Rc::downgrade(&changes);
        Ok(Stop::new(move || {
            if let Some(changes) = changes.upgrade() {
                changes.listeners.borrow_mut().retain(|(i, _)| *i != id);
            }
        }))
    }
}

/// `Storage.on`'s events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub(crate) enum StorageEvent {
    /// The entries were changed elsewhere.
    #[default]
    Change,
}

/// An entry changed elsewhere (the `change` event).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub(crate) struct StorageChangeEvent {
    /// The key changed; `null` when every entry was removed.
    key: Option<String>,
    /// The value the key holds now; `null` when it was removed.
    value: Option<String>,
}

impl From<StorageChange> for StorageChangeEvent {
    fn from(change: StorageChange) -> Self {
        match change {
            StorageChange::Set(key, value) => Self {
                key: Some(key),
                value: Some(value),
            },
            StorageChange::Remove(key) => Self {
                key: Some(key),
                value: None,
            },
            StorageChange::Clear => Self::default(),
        }
    }
}

/// The VM's `change` listeners.
#[derive(Default)]
struct Changes {
    listeners: RefCell<Vec<(u32, Callback<StorageChangeEvent>)>>,
    next: Cell<u32>,
    /// The task watching the changes started; it lasts as the VM does.
    started: Cell<bool>,
}

impl Local for Changes {
    fn close(&self) {
        self.listeners.borrow_mut().clear();
    }
}

/// Posts the changes made elsewhere to the listeners, while the VM lasts.
async fn deliver(changes: Weak<Changes>) {
    let watch = with_storage(|s| s.watch());
    loop {
        let change = watch.next().await;
        let Some(changes) = changes.upgrade() else {
            return;
        };
        let event = StorageChangeEvent::from(change);
        for (_, listener) in &*changes.listeners.borrow() {
            listener.post(event.clone());
        }
    }
}
