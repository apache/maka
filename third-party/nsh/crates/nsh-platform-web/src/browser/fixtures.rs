//! Actual-Wasm ownership fixtures, excluded from published artifacts.
use std::cell::RefCell;

use nsh_core::prelude::*;

thread_local! {
    static KEPT: RefCell<Vec<Callback<(), i32>>> = const { RefCell::new(Vec::new()) };
}

#[class]
pub(crate) struct CallbackBox {
    callback: Callback<(), i32>,
}

#[class]
impl CallbackBox {
    pub(crate) fn new(callback: Callback<(), i32>) -> Self {
        Self { callback }
    }
    pub(crate) fn call(&self) -> i32 {
        self.callback.call(()).unwrap_or(-1)
    }
    pub(crate) fn escape(&self) {
        KEPT.with(|kept| kept.borrow_mut().push(self.callback.clone()));
    }
    pub(crate) fn call_kept() -> i32 {
        let callback = KEPT.with(|kept| kept.borrow().last().cloned());
        callback
            .and_then(|callback| callback.call(()).ok())
            .unwrap_or(-1)
    }
    pub(crate) fn clear_kept() {
        let callbacks = KEPT.with(|kept| kept.take());
        drop(callbacks);
    }
}

pub(super) fn registry() -> nsh_core::element::Registry {
    let mut registry = nsh_core::element::Registry::ui_set("test/browser");
    registry.class::<CallbackBox>();
    registry
}
