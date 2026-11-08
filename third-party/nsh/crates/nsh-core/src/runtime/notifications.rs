//! `nsh`'s `Notifications`: system notifications and the app's badge
//! ([`crate::notifications`]). Needs the `notifications` capability when the
//! app declares capabilities: without it every function that can fail
//! rejects or throws `ERR_ACCESS_DENIED` (checked here, in the call; the
//! core also refuses Rust components' requests, which answer `unavailable`).

use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
};

use crate::{
    element::{Callback, JsError, JsObject, Local, PropEnum, Stop, System, module},
    notifications::{Notification, NotificationPermission},
};

/// Whether the app may use notifications: why not when it may not.
fn granted(sys: &System) -> Result<(), JsError> {
    if sys.access.allows_notifications() {
        return Ok(());
    }
    Err(JsError::access_denied(
        "notifications are not granted: add `\"notifications\": true` to capabilities in nsh.json",
        "notifications",
        "",
    ))
}

/// System notifications and the app's badge.
#[module]
pub(crate) struct Notifications;

#[module]
impl Notifications {
    /// Whether the app may show notifications, without asking the user:
    /// `"default"` (not asked yet), `"granted"`, `"denied"` (only the
    /// system's settings change it) or `"unavailable"` (this platform or
    /// build shows none: the terminal, a macOS app that is not a signed
    /// bundle). Rejects with `ERR_ACCESS_DENIED` when the `notifications`
    /// capability is not granted.
    pub(crate) async fn permission(sys: System) -> Result<NotificationPermission, JsError> {
        granted(&sys)?;
        Ok(crate::prelude::notification_permission().await)
    }

    /// Asks the user to let the app show notifications, with the system's
    /// prompt the first time, and resolves with the permission. Ask when
    /// the user does something that needs them: browsers refuse a prompt
    /// the user did not cause, and iOS and Android ask only once. Rejects
    /// with `ERR_ACCESS_DENIED` when the `notifications` capability is not
    /// granted.
    pub(crate) async fn request_permission(sys: System) -> Result<NotificationPermission, JsError> {
        granted(&sys)?;
        Ok(crate::prelude::request_notification_permission().await)
    }

    /// Shows a notification, resolving with whether the system took it
    /// (`false` without the permission). They also show while the app is in
    /// front. Showing another with the same `id` replaces it. Rejects with
    /// `ERR_ACCESS_DENIED` when the `notifications` capability is not
    /// granted, and with a `RangeError` for an empty `id` or `title`.
    pub(crate) async fn show(
        options: ShowNotificationOptions,
        sys: System,
    ) -> Result<bool, JsError> {
        granted(&sys)?;
        let notification = options.notification()?;
        Ok(crate::prelude::show_notification(notification).await)
    }

    /// Removes the notification called `id`, if it still shows. Rejects
    /// with `ERR_ACCESS_DENIED` when the `notifications` capability is not
    /// granted.
    pub(crate) async fn close(id: String, sys: System) -> Result<(), JsError> {
        granted(&sys)?;
        crate::prelude::close_notification(id);
        Ok(())
    }

    /// Shows `count` on the app's icon, and `0` clears it: the Dock on
    /// macOS, an installed web app's icon, the home screen on iOS, which
    /// needs the permission (`requestPermission`). Android has no count to
    /// set: launchers mark an app that has notifications showing, and
    /// `count` goes with those shown after this. On Windows, the taskbar
    /// button. Elsewhere nothing happens.
    /// Rejects with `ERR_ACCESS_DENIED` when the
    /// `notifications` capability is not granted, and with a `RangeError`
    /// for a count that is not a whole number from 0.
    pub(crate) async fn set_badge(count: f64, sys: System) -> Result<(), JsError> {
        granted(&sys)?;
        if !(count >= 0.0 && count.fract() == 0.0 && count <= f64::from(u32::MAX)) {
            return Err(JsError::Range(format!(
                "Notifications.setBadge: count must be a whole number from 0, not {count}"
            )));
        }
        crate::prelude::set_badge(count as u32);
        Ok(())
    }

    /// Listens to `event`. `press`: the user pressed a notification (the
    /// app comes to the front), the one that started the app included, which
    /// waits for the first listener. Returns a function that stops
    /// listening. Throws `ERR_ACCESS_DENIED` when the `notifications`
    /// capability is not granted.
    pub(crate) fn on(
        event: NotificationsEvent,
        #[args(press)] listener: Callback<NotificationPress>,
        sys: System,
        cx: crate::element::CallCx<'_>,
    ) -> Result<Stop, JsError> {
        let NotificationsEvent::Press = event;
        granted(&sys)?;
        let presses = sys.locals.get::<Presses>();
        let id = presses.next.get();
        presses.next.set(id.wrapping_add(1));
        for pressed in presses.unheard.take() {
            listener.post(NotificationPress { id: pressed });
        }
        presses.listeners.borrow_mut().push((id, listener));
        if !presses.started.replace(true) {
            cx.start(deliver(Rc::downgrade(&presses)));
        }
        let presses = Rc::downgrade(&presses);
        Ok(Stop::new(move || {
            if let Some(presses) = presses.upgrade() {
                presses.listeners.borrow_mut().retain(|(i, _)| *i != id);
            }
        }))
    }
}

/// `Notifications.show`'s notification.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub(crate) struct ShowNotificationOptions {
    /// The app's name for it: showing another with the same `id` replaces
    /// it, `close` removes it and a press reports it. Keep what the press
    /// must open in it (`"chat:42"`): a press can start the app anew.
    id: String,
    /// Its title.
    title: String,
    /// Its text.
    body: Option<String>,
    /// Shows it without a sound or vibration (false: with the system's).
    silent: Option<bool>,
}

impl ShowNotificationOptions {
    fn notification(self) -> Result<Notification, JsError> {
        if self.id.is_empty() || self.title.is_empty() {
            return Err(JsError::Range(
                "Notifications.show: `id` and `title` must not be empty".into(),
            ));
        }
        Ok(
            Notification::new(self.id, self.title, self.body.unwrap_or_default())
                .silent(self.silent.unwrap_or_default()),
        )
    }
}

/// `Notifications.on`'s events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub(crate) enum NotificationsEvent {
    /// The user pressed a notification.
    #[default]
    Press,
}

/// A notification the user pressed (the `press` event).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub(crate) struct NotificationPress {
    /// Its `id`.
    id: String,
}

/// The VM's `press` listeners.
#[derive(Default)]
struct Presses {
    listeners: RefCell<Vec<(u32, Callback<NotificationPress>)>>,
    next: Cell<u32>,
    /// The task waiting for the core's presses started; it lasts as the VM
    /// does.
    started: Cell<bool>,
    /// Presses that came with no listener, for the next one.
    unheard: RefCell<Vec<String>>,
}

impl Local for Presses {
    fn close(&self) {
        self.listeners.borrow_mut().clear();
    }
}

/// Posts the core's presses to the listeners, while the VM lasts.
async fn deliver(presses: Weak<Presses>) {
    loop {
        let pressed = crate::prelude::next_notification_press().await;
        let Some(presses) = presses.upgrade() else {
            return;
        };
        let listeners = presses.listeners.borrow();
        if listeners.is_empty() {
            presses.unheard.borrow_mut().push(pressed);
            continue;
        }
        for (_, listener) in &*listeners {
            listener.post(NotificationPress {
                id: pressed.clone(),
            });
        }
    }
}
