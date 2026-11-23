//! Presses of the notifications NSH did not show, for Rust code (an app's
//! crate, an nshm): the counterpart of `nsh_platform_apple::notifications`'
//! foreign handler.
//!
//! A push service's SDK, or other code of the app, shows notifications of
//! its own, whose presses open the app's launch activity (or the SDK's own
//! activity, which opens it) with the payload as the intent's extras.
//! Android does not say which notification opened an activity, so
//! `Notifications.java` takes an intent of the activity (`onCreate` and
//! `onNewIntent`, through `NshView.handleNotificationIntent`) without NSH's
//! own mark for one of these presses when no other meaning claims it
//! (`ForeignIntents.isPress`), and hands it here. NSH's own presses still
//! reach the app's `press` listeners.
//!
//! ```no_run
//! // The library of the `nsh-platform-android` crate is `nsh`.
//! use nsh::notifications::{
//!     ForeignNotification, ForeignNotificationHandler, set_foreign_handler,
//! };
//!
//! struct Chats;
//!
//! impl ForeignNotificationHandler for Chats {
//!     fn pressed(&self, notification: &ForeignNotification) {
//!         if let Some(chat) = notification.extras["chat"].as_str() {
//!             log::info!("open chat {chat}");
//!         }
//!     }
//! }
//!
//! set_foreign_handler(Chats);
//! ```

use std::{cell::RefCell, rc::Rc};

use jni::{
    JNIEnv,
    objects::{JClass, JString},
};
use nsh_core::JsonValue;

thread_local! {
    /// The handler of the notifications NSH did not show
    /// ([`set_foreign_handler`]).
    static FOREIGN: RefCell<Option<Rc<dyn ForeignNotificationHandler>>> =
        const { RefCell::new(None) };
    /// Presses of notifications NSH did not show before a handler is set.
    static FOREIGN_PRESSES: RefCell<Vec<ForeignNotification>> = const { RefCell::new(Vec::new()) };
}

/// A press of a notification NSH did not show: the intent it opened the
/// app's activity with. [`ForeignNotificationHandler`] receives it.
///
/// Android does not tell an activity which notification opened it, so
/// there is no id or group, as Apple's has: what the notification's code
/// put in the intent is all there is.
#[derive(Debug, Clone, PartialEq, Default)]
#[non_exhaustive]
pub struct ForeignNotification {
    /// The intent's extras as JSON, an object: a push notification's
    /// payload. Strings, numbers, booleans, arrays and lists keep their
    /// values and a nested `Bundle` is an object; other values (byte
    /// arrays, parcelables) are `null`, so one such value does not lose the
    /// rest. NSH's own extras are left out.
    pub extras: JsonValue,
    /// The intent's action (`Intent.getAction`): `android.intent.action.MAIN`
    /// for the launch intent, the SDK's own action, or `""` for none.
    pub action: String,
    /// The intent's data URI (`Intent.getDataString`), `""` for none.
    pub data: String,
}

/// Handles the presses of the notifications NSH did not show
/// ([`set_foreign_handler`]). Its method runs on the UI thread.
pub trait ForeignNotificationHandler {
    /// The user pressed `notification`, which may have started the app.
    fn pressed(&self, notification: &ForeignNotification);
}

/// Hands the presses of the notifications NSH did not show to `handler`.
/// Until a handler is set they wait for it, so one set while the app's
/// first `NshView` loads (the `#[native_module]` entry of the app's crate
/// or of an nshm) hears the press that started the app. They never reach
/// the app's `press` listeners.
///
/// There is one handler: a later one replaces the earlier (with a
/// warning), so the app's crate should own it and pass presses on to the
/// modules it uses. An app that embeds `NshView` hands its activity's
/// intents to `NshView.handleNotificationIntent`, which reports these
/// presses too.
///
/// # Panics
///
/// Panics off the UI thread.
pub fn set_foreign_handler(handler: impl ForeignNotificationHandler + 'static) {
    assert!(
        on_ui_thread(),
        "set_foreign_handler is called on the UI thread"
    );
    if replace_handler(Rc::new(handler)) {
        log::warn!("notifications: a foreign notification handler replaced the one set before");
    }
}

/// Sets the handler and hands it the presses that waited for one; whether
/// it replaced another.
fn replace_handler(handler: Rc<dyn ForeignNotificationHandler>) -> bool {
    let replaced = FOREIGN.with(|f| f.borrow_mut().replace(handler).is_some());
    for notification in FOREIGN_PRESSES.with(|p| std::mem::take(&mut *p.borrow_mut())) {
        foreign_pressed(notification);
    }
    replaced
}

/// Reports a press of a notification NSH did not show to the handler, or
/// keeps it until one is set. On the UI thread.
fn foreign_pressed(notification: ForeignNotification) {
    match handler() {
        Some(handler) => handler.pressed(&notification),
        None => FOREIGN_PRESSES.with(|p| p.borrow_mut().push(notification)),
    }
}

/// The handler, out of `FOREIGN`, so that it may set another while it runs.
fn handler() -> Option<Rc<dyn ForeignNotificationHandler>> {
    FOREIGN.with(|f| f.borrow().clone())
}

/// The press `Notifications.java` reports, its extras as the JSON
/// `ForeignIntents.json` wrote.
fn notification(extras: &str, action: String, data: String) -> ForeignNotification {
    let extras = match serde_json::from_str(extras) {
        Ok(extras @ JsonValue::Object(_)) => extras,
        Ok(_) => JsonValue::Object(Default::default()),
        Err(err) => {
            log::warn!("notifications: the extras of a press are not JSON: {err}");
            JsonValue::Object(Default::default())
        }
    };
    ForeignNotification {
        extras,
        action,
        data,
    }
}

/// Whether this is the UI thread (the main looper's).
fn on_ui_thread() -> bool {
    let answer = crate::java::try_with_env(|env| {
        let looper = "android/os/Looper";
        let signature = "()Landroid/os/Looper;";
        let main = env
            .call_static_method(looper, "getMainLooper", signature, &[])?
            .l()?;
        let mine = env
            .call_static_method(looper, "myLooper", signature, &[])?
            .l()?;
        Ok(!mine.is_null() && env.is_same_object(&main, &mine)?)
    });
    answer.unwrap_or_else(|err| {
        log::error!("notifications: cannot tell the UI thread: {err}");
        false
    })
}

/// `Notifications.nativeForeignPressed`: a press of a notification NSH did
/// not show. On the UI thread.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Notifications_nativeForeignPressed(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    extras: JString<'_>,
    action: JString<'_>,
    data: JString<'_>,
) {
    let mut read = |s: &JString<'_>| {
        if s.is_null() {
            String::new()
        } else {
            env.get_string(s).map(String::from).unwrap_or_default()
        }
    };
    let (extras, action, data) = (read(&extras), read(&action), read(&data));
    foreign_pressed(notification(&extras, action, data));
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    struct Recorder(Rc<RefCell<Vec<String>>>);

    impl ForeignNotificationHandler for Recorder {
        fn pressed(&self, notification: &ForeignNotification) {
            self.0.borrow_mut().push(notification.data.clone());
        }
    }

    fn press(data: &str) -> ForeignNotification {
        notification(r#"{"chat":"42"}"#, String::new(), data.into())
    }

    #[test]
    fn a_press_keeps_its_intent() {
        assert_eq!(
            notification(
                r#"{"chat":"42","badge":3,"message":{"title":"Hi"},"sent":null}"#,
                "android.intent.action.MAIN".into(),
                "app://chat/42".into(),
            ),
            ForeignNotification {
                extras: json!({ "chat": "42", "badge": 3, "message": { "title": "Hi" }, "sent": null }),
                action: "android.intent.action.MAIN".into(),
                data: "app://chat/42".into(),
            }
        );
    }

    #[test]
    fn extras_that_are_not_an_object_are_empty() {
        assert_eq!(
            notification("[1]", String::new(), String::new()).extras,
            json!({})
        );
        assert_eq!(
            notification("{", String::new(), String::new()).extras,
            json!({})
        );
    }

    #[test]
    fn a_press_before_the_handler_waits_for_it() {
        // The press that starts the app comes before the app's first load.
        foreign_pressed(press("first"));
        let pressed = Rc::new(RefCell::new(Vec::new()));
        assert!(!replace_handler(Rc::new(Recorder(pressed.clone()))));
        assert_eq!(*pressed.borrow(), ["first"]);
        foreign_pressed(press("second"));
        assert_eq!(*pressed.borrow(), ["first", "second"]);
        // Another handler replaces it.
        assert!(replace_handler(Rc::new(Recorder(Rc::default()))));
    }

    struct Replacing(Rc<RefCell<Vec<String>>>);

    impl ForeignNotificationHandler for Replacing {
        fn pressed(&self, notification: &ForeignNotification) {
            self.0.borrow_mut().push(notification.data.clone());
            replace_handler(Rc::new(Recorder(self.0.clone())));
        }
    }

    #[test]
    fn a_handler_may_set_another_while_it_runs() {
        let pressed = Rc::new(RefCell::new(Vec::new()));
        replace_handler(Rc::new(Replacing(pressed.clone())));
        foreign_pressed(press("first"));
        foreign_pressed(press("second"));
        assert_eq!(*pressed.borrow(), ["first", "second"]);
    }
}
