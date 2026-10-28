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

/// Exercise the Rust-to-browser event conversion with the actual value bridge.
#[unsafe(no_mangle)]
pub(crate) extern "C" fn nsh_browser_test_mouse_events() -> u32 {
    use nsh_core::{EventPayload, MouseButton, MouseEvent, keymap::Modifiers};

    use super::{bindings::Bindings, events, values::Value};
    let host = Bindings::new();
    let buttons = [
        None,
        Some(MouseButton::Left),
        Some(MouseButton::Right),
        Some(MouseButton::Middle),
        Some(MouseButton::Back),
        Some(MouseButton::Forward),
    ];
    let events = buttons.into_iter().map(|button| {
        events::payload(
            &host,
            &EventPayload::Mouse(MouseEvent::new(
                Point::new(Points(3.0), Points(4.0)),
                Point::new(Points(30.0), Points(40.0)),
                Modifiers {
                    shift: true,
                    ..Default::default()
                },
                button,
            )),
        )
        .unwrap()
    });
    Value::array(events).unwrap().into_raw()
}

/// Both file-drop variants keep the same public shape as the native JS host.
#[unsafe(no_mangle)]
pub(crate) extern "C" fn nsh_browser_test_file_drop_events() -> u32 {
    use nsh_core::EventPayload;

    use super::{bindings::Bindings, events, values::Value};
    let host = Bindings::new();
    let uris = vec![
        "file:///tmp/hello.txt".to_owned(),
        "file:///tmp/world.txt".to_owned(),
    ];
    let payloads = [
        EventPayload::FileDrop(uris.clone()),
        EventPayload::FileDropAt {
            uris,
            page_position: Point::new(Points(30.0), Points(40.0)),
        },
    ];
    Value::array(payloads.iter().map(|p| events::payload(&host, p).unwrap()))
        .unwrap()
        .into_raw()
}

/// A video's `onLoad` keeps the `{ duration, size }` of the native JS host.
#[unsafe(no_mangle)]
pub(crate) extern "C" fn nsh_browser_test_video_load_event() -> u32 {
    use nsh_core::PayloadValue;

    use super::events;
    events::video_load(&[
        ("duration", PayloadValue::Number(12.5)),
        ("width", PayloadValue::Number(1920.0)),
        ("height", PayloadValue::Number(1080.0)),
    ])
    .unwrap()
    .into_raw()
}
