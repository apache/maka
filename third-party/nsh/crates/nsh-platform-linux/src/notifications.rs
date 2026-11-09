//! Notifications and the badge on Linux (`Command::Notification`, `nsh`'s
//! `Notifications`), on the session bus through GIO:
//!
//! - Notifications are the freedesktop notification service's
//!   (`org.freedesktop.Notifications`), which every desktop's daemon serves.
//!   `GNotification` is not used: it needs a registered, uniquely named
//!   `GApplication`, and neither `run_app` (`NON_UNIQUE`) nor every embedding
//!   host has one, where GNOME's backend could not deliver a press.
//! - The service has no permission to ask for: `granted` while a daemon
//!   answers, `unavailable` otherwise.
//! - Presses reach only the running process: a notification left after the
//!   app exits does nothing when pressed, and the daemon's ids die with the
//!   process, so a restarted app cannot replace or close those it left.
//! - The badge is the Unity launcher API's signal
//!   (`com.canonical.Unity.LauncherEntry`), the one standard docks share
//!   (Plasma, Ubuntu's and Dash to Dock). No one listening means no badge.
//!
//! The daemon's numeric id for a notification comes back in the reply to
//! showing it, so the calls run one at a time, in order: a `Close` right
//! after a `Show` waits for the id it needs.

use std::{
    cell::RefCell,
    collections::{HashMap, VecDeque},
};

use gtk4::{self as gtk, gio, glib, glib::prelude::*, prelude::*};
use nsh_core::{
    EventKind, EventPayload, PayloadValue, ROOT_ID,
    notifications::{Notification, NotificationCommand, NotificationEvent, NotificationPermission},
};
use nsh_engine::EngineControl;

const SERVICE: &str = "org.freedesktop.Notifications";
const PATH: &str = "/org/freedesktop/Notifications";
const LAUNCHER_PATH: &str = "/com/canonical/unity/launcherentry/nsh";
const LAUNCHER_INTERFACE: &str = "com.canonical.Unity.LauncherEntry";
/// Milliseconds a daemon has to answer, which holds up the calls behind it.
const TIMEOUT: i32 = 5000;

/// A call waiting for those before it.
enum Call {
    Permission {
        control: EngineControl,
        id: u32,
    },
    Show {
        control: EngineControl,
        id: u32,
        notification: Notification,
        root: glib::WeakRef<gtk::Widget>,
    },
    Close(String),
}

/// A notification the daemon shows.
struct Shown {
    number: u32,
    /// Where the surface that showed it lives: a press brings its window up.
    root: glib::WeakRef<gtk::Widget>,
}

#[derive(Default)]
struct State {
    app_id: String,
    app_name: String,
    bus: Option<gio::DBusConnection>,
    subscription: Option<gio::SignalSubscription>,
    /// Whether the daemon reads markup in a body, once asked.
    markup: Option<bool>,
    calls: VecDeque<Call>,
    calling: bool,
    shown: HashMap<String, Shown>,
    /// The activation token of the last action, sent just before it.
    token: Option<(u32, String)>,
    /// The engine that listens to presses, once the app does.
    listener: Option<EngineControl>,
    /// Presses before the app listens.
    presses: Vec<String>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::default();
}

/// Names the app to the daemon and the docks. The last surface's wins: they
/// are the same app.
pub(crate) fn set_app(app_id: &str, app_name: &str) {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        s.app_id = app_id.to_owned();
        s.app_name = app_name.to_owned();
    });
}

/// The app's id and name, as [`set_app`] gave them (the tray's too).
pub(crate) fn app() -> (String, String) {
    STATE.with(|s| {
        let s = s.borrow();
        (s.app_id.clone(), s.app_name.clone())
    })
}

/// Applies `command`, reporting through `control`. On the main thread.
pub(crate) fn command(control: &EngineControl, root: &gtk::Widget, command: &NotificationCommand) {
    let call = match command {
        NotificationCommand::SetBadge(count) => {
            set_badge(*count);
            return;
        }
        NotificationCommand::Listen => {
            let presses = STATE.with(|s| {
                let mut s = s.borrow_mut();
                s.listener = Some(control.clone());
                std::mem::take(&mut s.presses)
            });
            presses.into_iter().for_each(pressed);
            return;
        }
        NotificationCommand::Permission { id, .. } => Call::Permission {
            control: control.clone(),
            id: *id,
        },
        NotificationCommand::Show { id, notification } => Call::Show {
            control: control.clone(),
            id: *id,
            notification: notification.clone(),
            root: root.downgrade(),
        },
        NotificationCommand::Close(id) => Call::Close(id.clone()),
        _ => return,
    };
    STATE.with(|s| s.borrow_mut().calls.push_back(call));
    next();
}

/// Runs the next call, unless one is running.
fn next() {
    let call = STATE.with(|s| {
        let mut s = s.borrow_mut();
        if s.calling {
            return None;
        }
        let call = s.calls.pop_front();
        s.calling = call.is_some();
        call
    });
    let Some(call) = call else { return };
    with_bus(move |bus| run(bus, call));
}

fn finished() {
    STATE.with(|s| s.borrow_mut().calling = false);
    next();
}

/// Calls `f` with the session bus, or `None` if there is none.
fn with_bus(f: impl FnOnce(Option<gio::DBusConnection>) + 'static) {
    if let Some(bus) = STATE.with(|s| s.borrow().bus.clone()) {
        f(Some(bus));
        return;
    }
    gio::bus_get(gio::BusType::Session, gio::Cancellable::NONE, move |bus| {
        let bus = bus.ok();
        if let Some(bus) = &bus {
            connected(bus);
        }
        f(bus);
    });
}

/// Keeps `bus` and subscribes to the daemon's signals, before showing
/// anything so that no press can be missed.
fn connected(bus: &gio::DBusConnection) {
    if STATE.with(|s| s.borrow_mut().bus.replace(bus.clone()).is_some()) {
        return;
    }
    let subscription = bus.subscribe_to_signal(
        Some(SERVICE),
        Some(SERVICE),
        None,
        Some(PATH),
        None,
        gio::DBusSignalFlags::NONE,
        |signal| on_signal(signal.signal_name, signal.parameters),
    );
    STATE.with(|s| s.borrow_mut().subscription = Some(subscription));
}

fn on_signal(member: &str, args: &glib::Variant) {
    match member {
        "ActivationToken" => {
            if let Some(token) = args.get::<(u32, String)>() {
                STATE.with(|s| s.borrow_mut().token = Some(token));
            }
        }
        "ActionInvoked" => {
            if let Some((number, action)) = args.get::<(u32, String)>()
                && action == "default"
            {
                invoked(number);
            }
        }
        "NotificationClosed" => {
            if let Some((number, _reason)) = args.get::<(u32, u32)>() {
                STATE.with(|s| s.borrow_mut().shown.retain(|_, n| n.number != number));
            }
        }
        _ => {}
    }
}

/// The user pressed notification `number`, which may be another app's: the
/// signals are broadcast.
fn invoked(number: u32) {
    let (found, token) = STATE.with(|s| {
        let mut s = s.borrow_mut();
        let token = s.token.take().filter(|(n, _)| *n == number).map(|(_, t)| t);
        let found = s
            .shown
            .iter()
            .find(|(_, n)| n.number == number)
            .map(|(id, n)| (id.clone(), n.root.clone()));
        (found, token)
    });
    let Some((id, root)) = found else { return };
    // The daemon took the focus away; other platforms' systems bring the app
    // up themselves.
    if let Some(window) = root
        .upgrade()
        .and_then(|r| r.root())
        .and_downcast::<gtk::Window>()
    {
        if let Some(token) = token {
            window.set_startup_id(&token);
        }
        window.present();
    }
    pressed(id);
}

/// Reports a press to the app, or keeps it until the app listens.
fn pressed(id: String) {
    match STATE.with(|s| s.borrow().listener.clone()) {
        Some(control) => control.dispatch_event(
            ROOT_ID,
            EventKind::Notification,
            EventPayload::Map(vec![(NotificationEvent::PRESSED, PayloadValue::Str(id))]),
        ),
        None => STATE.with(|s| s.borrow_mut().presses.push(id)),
    }
}

fn run(bus: Option<gio::DBusConnection>, call: Call) {
    match call {
        Call::Permission { control, id } => {
            let Some(bus) = bus else {
                answer_permission(&control, id, false);
                return finished();
            };
            // Also starts a daemon that the bus can activate.
            call_daemon(&bus, "GetServerInformation", None, move |reply| {
                answer_permission(&control, id, reply.is_ok());
                finished();
            });
        }
        Call::Show {
            control,
            id,
            notification,
            root,
        } => {
            let Some(bus) = bus else {
                answer_shown(&control, id, false);
                return finished();
            };
            with_markup(&bus.clone(), move |markup| {
                show(&bus, control, id, &notification, root, markup);
            });
        }
        Call::Close(id) => {
            let number = STATE
                .with(|s| s.borrow_mut().shown.remove(&id))
                .map(|n| n.number);
            let (Some(bus), Some(number)) = (bus, number) else {
                return finished();
            };
            call_daemon(
                &bus,
                "CloseNotification",
                Some(&(number,).to_variant()),
                |_| finished(),
            );
        }
    }
}

/// Calls `f` with whether the daemon reads markup in a body.
fn with_markup(bus: &gio::DBusConnection, f: impl FnOnce(bool) + 'static) {
    if let Some(markup) = STATE.with(|s| s.borrow().markup) {
        f(markup);
        return;
    }
    call_daemon(bus, "GetCapabilities", None, move |reply| {
        let capabilities = reply.ok().and_then(|r| r.get::<(Vec<String>,)>());
        let markup = capabilities.is_some_and(|(c,)| c.iter().any(|c| c == "body-markup"));
        STATE.with(|s| s.borrow_mut().markup = Some(markup));
        f(markup);
    });
}

fn show(
    bus: &gio::DBusConnection,
    control: EngineControl,
    id: u32,
    notification: &Notification,
    root: glib::WeakRef<gtk::Widget>,
    markup: bool,
) {
    let (args, name) = STATE.with(|s| {
        let s = s.borrow();
        let replaces = s.shown.get(&notification.id).map_or(0, |n| n.number);
        (
            notify_args(&s.app_id, &s.app_name, replaces, notification, markup),
            notification.id.clone(),
        )
    });
    call_daemon(bus, "Notify", Some(&args), move |reply| {
        let number = reply.ok().and_then(|r| r.get::<(u32,)>());
        if let Some((number,)) = number {
            let shown = Shown { number, root };
            STATE.with(|s| s.borrow_mut().shown.insert(name, shown));
        }
        answer_shown(&control, id, number.is_some());
        finished();
    });
}

/// The arguments of `Notify`.
fn notify_args(
    app_id: &str,
    app_name: &str,
    replaces: u32,
    notification: &Notification,
    markup: bool,
) -> glib::Variant {
    // A daemon that reads markup would read the app's text as markup, where
    // `<` and `&` go wrong and tags can load images.
    let body = if markup {
        glib::markup_escape_text(&notification.body).to_string()
    } else {
        notification.body.clone()
    };
    // The daemon finds the app's name and icon in the `.desktop` file.
    let mut hints = HashMap::from([("desktop-entry", app_id.to_variant())]);
    if notification.silent {
        hints.insert("suppress-sound", true.to_variant());
    }
    // "default" is the press on the notification itself, so it has no label.
    let actions = vec!["default", ""];
    let expire = -1i32;
    (
        app_name,
        replaces,
        "",
        notification.title.as_str(),
        body,
        actions,
        hints,
        expire,
    )
        .to_variant()
}

fn call_daemon(
    bus: &gio::DBusConnection,
    method: &str,
    args: Option<&glib::Variant>,
    done: impl FnOnce(Result<glib::Variant, glib::Error>) + 'static,
) {
    bus.call(
        Some(SERVICE),
        PATH,
        SERVICE,
        method,
        args,
        None,
        gio::DBusCallFlags::NONE,
        TIMEOUT,
        gio::Cancellable::NONE,
        done,
    );
}

fn set_badge(count: u32) {
    let app_id = STATE.with(|s| s.borrow().app_id.clone());
    with_bus(move |bus| {
        let Some(bus) = bus else { return };
        let args = badge_args(&app_id, count);
        if let Err(error) = bus.emit_signal(
            None,
            LAUNCHER_PATH,
            LAUNCHER_INTERFACE,
            "Update",
            Some(&args),
        ) {
            log::debug!("linux: the badge's signal failed: {error}");
        }
    });
}

/// The arguments of the launcher API's `Update`: the app's `.desktop` file,
/// its count (`x`) and whether the count shows.
fn badge_args(app_id: &str, count: u32) -> glib::Variant {
    let properties = HashMap::from([
        ("count", i64::from(count).to_variant()),
        ("count-visible", (count > 0).to_variant()),
    ]);
    (format!("application://{app_id}.desktop"), properties).to_variant()
}

fn answer_permission(control: &EngineControl, id: u32, available: bool) {
    let permission = if available {
        NotificationPermission::Granted
    } else {
        NotificationPermission::Unavailable
    };
    control.dispatch_event(
        ROOT_ID,
        EventKind::Notification,
        EventPayload::Map(vec![
            (NotificationEvent::ID, PayloadValue::Number(f64::from(id))),
            (
                NotificationEvent::PERMISSION,
                PayloadValue::Str(permission.as_str().to_owned()),
            ),
        ]),
    );
}

fn answer_shown(control: &EngineControl, id: u32, shown: bool) {
    control.dispatch_event(
        ROOT_ID,
        EventKind::Notification,
        EventPayload::Map(vec![
            (NotificationEvent::ID, PayloadValue::Number(f64::from(id))),
            (NotificationEvent::SHOWN, PayloadValue::Bool(shown)),
        ]),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notify_has_the_signature_of_the_service() {
        let notification = Notification::new("a", "Title", "x < y & z");
        let args = notify_args("com.example.app", "App", 7, &notification, true);
        assert_eq!(args.type_().as_str(), "(susssasa{sv}i)");
        assert_eq!(args.child_value(1).get::<u32>(), Some(7));
        assert_eq!(
            args.child_value(3).get::<String>().as_deref(),
            Some("Title")
        );
        assert_eq!(
            args.child_value(5).get::<Vec<String>>(),
            Some(vec!["default".to_owned(), String::new()])
        );
        let hints = args.child_value(6);
        let hints = hints
            .get::<HashMap<String, glib::Variant>>()
            .expect("hints");
        assert_eq!(
            hints["desktop-entry"].get::<String>().as_deref(),
            Some("com.example.app")
        );
        assert!(!hints.contains_key("suppress-sound"));
    }

    #[test]
    fn a_silent_notification_asks_the_daemon_for_no_sound() {
        let notification = Notification::new("a", "T", "").silent(true);
        let args = notify_args("id", "App", 0, &notification, false);
        let hints = args
            .child_value(6)
            .get::<HashMap<String, glib::Variant>>()
            .expect("hints");
        assert_eq!(hints["suppress-sound"].get::<bool>(), Some(true));
    }

    #[test]
    fn a_body_is_escaped_only_for_a_daemon_that_reads_markup() {
        let notification = Notification::new("a", "T", "x < y & <img src=\"u\">");
        let body = |markup| {
            notify_args("id", "App", 0, &notification, markup)
                .child_value(4)
                .get::<String>()
                .expect("body")
        };
        assert_eq!(body(true), "x &lt; y &amp; &lt;img src=&quot;u&quot;&gt;");
        assert_eq!(body(false), "x < y & <img src=\"u\">");
    }

    #[test]
    fn the_badge_names_the_desktop_file_and_hides_at_zero() {
        let args = badge_args("com.example.app", 3);
        assert_eq!(args.type_().as_str(), "(sa{sv})");
        assert_eq!(
            args.child_value(0).get::<String>().as_deref(),
            Some("application://com.example.app.desktop")
        );
        let properties = |args: &glib::Variant| {
            args.child_value(1)
                .get::<HashMap<String, glib::Variant>>()
                .expect("properties")
        };
        let shown = properties(&args);
        assert_eq!(shown["count"].get::<i64>(), Some(3));
        assert_eq!(shown["count-visible"].get::<bool>(), Some(true));
        let cleared = properties(&badge_args("com.example.app", 0));
        assert_eq!(cleared["count-visible"].get::<bool>(), Some(false));
    }
}
