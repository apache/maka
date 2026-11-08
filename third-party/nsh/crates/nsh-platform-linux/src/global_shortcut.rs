//! Global shortcuts on Linux (`DesktopCommand::RegisterGlobalShortcut`,
//! `nsh/desktop`'s `GlobalShortcut`), through the desktop portal's
//! `org.freedesktop.portal.GlobalShortcuts`: the only way on Wayland, where
//! no app may grab keys, and served on X11 desktops too (Plasma, GNOME 48+,
//! Hyprland's portal).
//!
//! - A portal session binds a set of shortcuts once: each change of the set
//!   closes the session and binds the whole set in a new one, on the next
//!   idle, so registering several at once asks once.
//! - A shortcut's id on the portal is its keystroke (`ctrl+shift+k`): what a
//!   desktop that lets the user bind it shows, and what Hyprland's
//!   `bind = …, global, <app id>:<id>` names. Its keystroke is only the
//!   preferred trigger: the desktop may ask the user, or bind another.
//! - The portal binds shortcuts for an app it knows the id of: an app
//!   outside a sandbox says it with `org.freedesktop.host.portal.Registry`'s
//!   `Register` (xdg-desktop-portal 1.19+, which refuses `CreateSession`
//!   with "An app id is required" otherwise), the connection's first portal
//!   call. GTK may have used the shared session connection for portals
//!   already, so the shortcuts have a connection of their own.
//! - Without a portal, or when it refuses, a registration answers
//!   `registered: false`.

use std::{
    cell::{Cell, RefCell},
    rc::Weak,
};

use gtk4::{gio, glib, prelude::*};
use nsh_core::{EventKind, EventPayload, PayloadValue, ROOT_ID, desktop::Shortcut};

use crate::surface::Surface;

const PORTAL: &str = "org.freedesktop.portal.Desktop";
const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
const INTERFACE: &str = "org.freedesktop.portal.GlobalShortcuts";
const REQUEST: &str = "org.freedesktop.portal.Request";
const SESSION: &str = "org.freedesktop.portal.Session";
const REGISTRY: &str = "org.freedesktop.host.portal.Registry";

/// A shortcut the app registered.
struct Global {
    id: u32,
    shortcut: Shortcut,
    surface: Weak<Surface>,
    /// The portal's answer was reported.
    answered: bool,
}

#[derive(Default)]
struct State {
    globals: Vec<Global>,
    /// The portal session bound to the set, once created.
    session: Option<String>,
    /// The `Activated` subscription.
    activated: Option<gio::SignalSubscription>,
    /// A bind waits for the next idle.
    scheduled: Option<glib::SourceId>,
    /// Bumped at each bind: answers of an earlier one are dropped.
    generation: u64,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::default();
    /// The shortcuts' own connection, with the app's id registered.
    static BUS: RefCell<Option<gio::DBusConnection>> = const { RefCell::new(None) };
    static TOKEN: Cell<u32> = const { Cell::new(0) };
}

/// Registers `shortcut` as `id` for `surface`'s app.
pub(crate) fn register(surface: &std::rc::Rc<Surface>, id: u32, shortcut: Shortcut) {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        s.globals
            .retain(|g| g.id != id || !std::ptr::eq(g.surface.as_ptr(), surface.as_ref()));
        s.globals.push(Global {
            id,
            shortcut,
            surface: std::rc::Rc::downgrade(surface),
            answered: false,
        });
    });
    schedule();
}

/// Gives back the shortcut registered as `id`.
pub(crate) fn unregister(surface: &Surface, id: u32) {
    let had = STATE.with(|s| {
        let mut s = s.borrow_mut();
        let before = s.globals.len();
        s.globals
            .retain(|g| g.id != id || !std::ptr::eq(g.surface.as_ptr(), surface));
        before != s.globals.len()
    });
    if had {
        schedule();
    }
}

/// Releases only this embedded app's registrations on stop or drop.
pub(crate) fn clear(surface: &Surface) {
    let had = STATE
        .try_with(|s| {
            let mut s = s.borrow_mut();
            let before = s.globals.len();
            s.globals
                .retain(|g| !std::ptr::eq(g.surface.as_ptr(), surface));
            before != s.globals.len()
        })
        .unwrap_or(false);
    if had {
        schedule();
    }
}

/// The shortcut's id on the portal: its keystroke, lowercase
/// (`ctrl+shift+k`).
pub(crate) fn portal_id(shortcut: &Shortcut) -> String {
    shortcut.label().to_lowercase().replace("win+", "super+")
}

/// The shortcut as the XDG shortcuts spec writes a trigger
/// (`CTRL+SHIFT+k`).
pub(crate) fn trigger(shortcut: &Shortcut) -> Option<String> {
    let key = crate::chrome::accelerator(&Shortcut::key(shortcut.key))?;
    let mut out = String::new();
    for (on, name) in [
        (shortcut.ctrl, "CTRL+"),
        (shortcut.alt, "ALT+"),
        (shortcut.shift, "SHIFT+"),
        (shortcut.meta, "LOGO+"),
    ] {
        if on {
            out.push_str(name);
        }
    }
    out.push_str(&key);
    Some(out)
}

fn schedule() {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        if s.scheduled.is_none() {
            s.scheduled = Some(glib::idle_add_local_once(bind));
        }
    });
}

/// Answers every global not answered yet: registered when `registered`
/// holds for its portal id; those refused are dropped.
fn answer(registered: impl Fn(&str) -> bool) {
    let answers: Vec<(Weak<Surface>, u32, bool)> = STATE.with(|s| {
        let mut s = s.borrow_mut();
        let answers: Vec<(Weak<Surface>, u32, bool)> = s
            .globals
            .iter_mut()
            .filter(|g| !g.answered)
            .map(|g| {
                g.answered = true;
                (g.surface.clone(), g.id, registered(&portal_id(&g.shortcut)))
            })
            .collect();
        // VM-local ids may coincide across surfaces.
        s.globals.retain(|g| {
            !answers
                .iter()
                .any(|(surface, id, ok)| !ok && *id == g.id && Weak::ptr_eq(surface, &g.surface))
        });
        answers
    });
    for (surface, id, registered) in answers {
        if let Some(surface) = surface.upgrade() {
            surface.event(
                ROOT_ID,
                EventKind::Menu,
                EventPayload::Map(vec![
                    ("id", PayloadValue::Number(f64::from(id))),
                    ("registered", PayloadValue::Bool(registered)),
                ]),
            );
        }
    }
}

/// Binds the set in a new session, closing the last one.
fn bind() {
    let (old, generation, empty) = STATE.with(|s| {
        let mut s = s.borrow_mut();
        s.scheduled.take();
        s.generation += 1;
        (s.session.take(), s.generation, s.globals.is_empty())
    });
    connect(move |bus| {
        let Some(bus) = bus else {
            return answer(|_| false);
        };
        if let Some(old) = old {
            close_session(&bus, &old);
        }
        if empty || !current(generation) {
            return;
        }
        create_session(&bus, generation);
    });
}

/// Hands `done` the shortcuts' connection, opening it and registering the
/// app's id with the portal the first time (`None`: no session bus).
fn connect(done: impl FnOnce(Option<gio::DBusConnection>) + 'static) {
    if let Some(bus) = BUS.with(|b| b.borrow().clone()) {
        return done(Some(bus));
    }
    let bus = gio::dbus_address_get_for_bus_sync(gio::BusType::Session, gio::Cancellable::NONE)
        .and_then(|address| {
            gio::DBusConnection::for_address_sync(
                &address,
                gio::DBusConnectionFlags::AUTHENTICATION_CLIENT
                    | gio::DBusConnectionFlags::MESSAGE_BUS_CONNECTION,
                None,
                gio::Cancellable::NONE,
            )
        });
    let bus = match bus {
        Ok(bus) => bus,
        Err(e) => {
            log::warn!("nsh: no session bus for global shortcuts: {e}");
            return done(None);
        }
    };
    let (app_id, _) = crate::notifications::app();
    if app_id.is_empty() {
        BUS.with(|b| *b.borrow_mut() = Some(bus.clone()));
        return done(Some(bus));
    }
    let registered = bus.clone();
    bus.call(
        Some(PORTAL),
        PORTAL_PATH,
        REGISTRY,
        "Register",
        Some(&glib::Variant::tuple_from_iter([
            app_id.to_variant(),
            glib::VariantDict::new(None).end(),
        ])),
        None,
        gio::DBusCallFlags::NONE,
        -1,
        gio::Cancellable::NONE,
        move |result| {
            // An older portal, or a sandboxed app (whose id the sandbox
            // gives), has nothing to register: the session may still work.
            if let Err(e) = result {
                log::debug!("nsh: the desktop portal did not register the app: {e}");
            }
            BUS.with(|b| *b.borrow_mut() = Some(registered.clone()));
            done(Some(registered));
        },
    );
}

/// Creates the session binding the set (`bind`'s second half).
fn create_session(bus: &gio::DBusConnection, generation: u64) {
    subscribe(bus);
    let session_token = token();
    let options = glib::VariantDict::new(None);
    options.insert("session_handle_token", session_token.as_str());
    request(
        bus,
        "CreateSession",
        session_args,
        options,
        move |bus, results| {
            let session = results.and_then(|r| {
                r.lookup_value("session_handle", None)
                    .and_then(|v| v.str().map(str::to_owned))
            });
            if !current(generation) {
                // A surface may have stopped while CreateSession was in flight.
                if let Some(session) = session {
                    close_session(bus, &session);
                }
                return;
            }
            let Some(session) = session else {
                log::warn!("nsh: the desktop portal has no global shortcuts session");
                return answer(|_| false);
            };
            STATE.with(|s| s.borrow_mut().session = Some(session.clone()));
            bind_shortcuts(bus, &session, generation);
        },
    );
}

fn close_session(bus: &gio::DBusConnection, session: &str) {
    bus.call(
        Some(PORTAL),
        session,
        SESSION,
        "Close",
        None,
        None,
        gio::DBusCallFlags::NONE,
        -1,
        gio::Cancellable::NONE,
        |_| {},
    );
}

fn session_args(options: glib::Variant) -> glib::Variant {
    glib::Variant::tuple_from_iter([options])
}

fn current(generation: u64) -> bool {
    STATE.with(|s| s.borrow().generation == generation)
}

fn bind_shortcuts(bus: &gio::DBusConnection, session: &str, generation: u64) {
    let shortcuts: Vec<(String, glib::Variant)> = STATE.with(|s| {
        s.borrow()
            .globals
            .iter()
            .map(|g| {
                let id = portal_id(&g.shortcut);
                let props = glib::VariantDict::new(None);
                props.insert("description", g.shortcut.label());
                if let Some(trigger) = trigger(&g.shortcut) {
                    props.insert("preferred_trigger", trigger);
                }
                (id, props.end())
            })
            .collect()
    });
    let Ok(session) = glib::variant::ObjectPath::try_from(session.to_owned()) else {
        return answer(|_| false);
    };
    request(
        bus,
        "BindShortcuts",
        move |options| {
            glib::Variant::tuple_from_iter([
                session.to_variant(),
                glib::Variant::array_from_iter_with_type(
                    glib::VariantTy::new("(sa{sv})").expect("a valid type"),
                    shortcuts.iter().map(|(id, props)| {
                        glib::Variant::tuple_from_iter([id.to_variant(), props.clone()])
                    }),
                ),
                "".to_variant(),
                options,
            ])
        },
        glib::VariantDict::new(None),
        move |_, results| {
            if !current(generation) {
                return;
            }
            let bound: Vec<String> = results
                .and_then(|r| r.lookup_value("shortcuts", None))
                .map(|list| {
                    list.iter()
                        .filter_map(|s| s.child_value(0).str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            answer(|id| bound.iter().any(|b| b == id));
        },
    );
}

/// Subscribes to the portal's `Activated`, once. By any sender: matched by
/// the portal's well-known name, GDBus never hands the signal on (seen with
/// xdg-desktop-portal 1.22 and GLib 2.90); [`pressed`] takes only the
/// session this connection created, whose handle the portal alone knows.
fn subscribe(bus: &gio::DBusConnection) {
    if STATE.with(|s| s.borrow().activated.is_some()) {
        return;
    }
    let subscription = bus.subscribe_to_signal(
        None,
        Some(INTERFACE),
        Some("Activated"),
        Some(PORTAL_PATH),
        None,
        gio::DBusSignalFlags::NONE,
        |signal| {
            let session = signal.parameters.child_value(0);
            let id = signal.parameters.child_value(1);
            let (Some(session), Some(id)) = (session.str(), id.str()) else {
                return;
            };
            pressed(session, id);
        },
    );
    STATE.with(|s| s.borrow_mut().activated = Some(subscription));
}

/// The shortcut called `id` of `session` was pressed.
fn pressed(session: &str, id: &str) {
    let found = STATE.with(|s| {
        let s = s.borrow();
        if s.session.as_deref() != Some(session) {
            return None;
        }
        s.globals
            .iter()
            .find(|g| portal_id(&g.shortcut) == id)
            .map(|g| (g.surface.clone(), g.id))
    });
    if let Some((surface, id)) = found
        && let Some(surface) = surface.upgrade()
    {
        surface.event(
            ROOT_ID,
            EventKind::Menu,
            EventPayload::Map(vec![("id", PayloadValue::Number(f64::from(id)))]),
        );
    }
}

/// A new handle token.
fn token() -> String {
    let n = TOKEN.with(|t| {
        t.set(t.get() + 1);
        t.get()
    });
    format!("nsh{}_{n}", std::process::id())
}

/// Calls portal method `method` with `args(options)` (options with a
/// `handle_token` added) and hands its `Request`'s results to `done`
/// (`None`: refused, cancelled or no portal).
fn request(
    bus: &gio::DBusConnection,
    method: &'static str,
    args: impl FnOnce(glib::Variant) -> glib::Variant,
    options: glib::VariantDict,
    done: impl FnOnce(&gio::DBusConnection, Option<glib::VariantDict>) + 'static,
) {
    let handle_token = token();
    options.insert("handle_token", handle_token.as_str());
    // The request's path, known before the call so that no response is
    // missed: the sender's unique name without its `:`, dots as `_`.
    let sender = bus
        .unique_name()
        .map(|n| n.trim_start_matches(':').replace('.', "_"))
        .unwrap_or_default();
    let path = format!("{PORTAL_PATH}/request/{sender}/{handle_token}");
    let done = std::rc::Rc::new(RefCell::new(Some(done)));
    let subscription: std::rc::Rc<RefCell<Option<gio::SignalSubscription>>> =
        std::rc::Rc::default();
    let finish = {
        let done = done.clone();
        let subscription = subscription.clone();
        let bus = bus.clone();
        move |results: Option<glib::VariantDict>| {
            subscription.borrow_mut().take();
            if let Some(done) = done.borrow_mut().take() {
                done(&bus, results);
            }
        }
    };
    let finish = std::rc::Rc::new(RefCell::new(Some(finish)));
    let on_response = finish.clone();
    *subscription.borrow_mut() = Some(bus.subscribe_to_signal(
        Some(PORTAL),
        Some(REQUEST),
        Some("Response"),
        Some(&path),
        None,
        gio::DBusSignalFlags::NONE,
        move |signal| {
            let code = signal.parameters.child_value(0).get::<u32>().unwrap_or(2);
            let results = glib::VariantDict::new(Some(&signal.parameters.child_value(1)));
            if let Some(finish) = on_response.borrow_mut().take() {
                finish((code == 0).then_some(results));
            }
        },
    ));
    let on_error = finish;
    bus.call(
        Some(PORTAL),
        PORTAL_PATH,
        INTERFACE,
        method,
        Some(&args(options.end())),
        None,
        gio::DBusCallFlags::NONE,
        -1,
        gio::Cancellable::NONE,
        move |result| {
            if let Err(e) = result {
                log::warn!("nsh: the desktop portal refused {method}: {e}");
                if let Some(finish) = on_error.borrow_mut().take() {
                    finish(None);
                }
            }
        },
    );
}

#[cfg(test)]
mod tests {
    use nsh_core::desktop::{Key, Shortcut};

    use super::*;

    fn reset() {
        STATE.with(|state| {
            let mut state = state.borrow_mut();
            if let Some(source) = state.scheduled.take() {
                source.remove();
            }
            *state = State::default();
        });
    }

    #[test]
    fn two_surfaces_keep_independent_shortcut_ids() {
        crate::gtk_test::run(|| {
            reset();
            let first = crate::gtk_test::surface();
            let second = crate::gtk_test::surface();
            register(&first, 1, Shortcut::parse("ctrl+alt+k", false).unwrap());
            register(&second, 1, Shortcut::parse("ctrl+alt+j", false).unwrap());
            assert_eq!(STATE.with(|state| state.borrow().globals.len()), 2);
            unregister(&first, 1);
            STATE.with(|state| {
                let state = state.borrow();
                assert_eq!(state.globals.len(), 1);
                assert!(std::ptr::eq(
                    state.globals[0].surface.as_ptr(),
                    second.as_ref()
                ));
            });
            drop(second);
            assert!(STATE.with(|state| state.borrow().globals.is_empty()));
            reset();
        });
    }

    #[test]
    fn stopping_surface_releases_shortcut_registrations() {
        crate::gtk_test::run(|| {
            reset();
            let surface = crate::gtk_test::surface();
            register(&surface, 123, Shortcut::parse("ctrl+alt+k", false).unwrap());
            surface.stop();
            let count = STATE.with(|state| state.borrow().globals.len());
            reset();
            assert_eq!(
                count, 0,
                "stopping an embedded surface must release its shortcuts"
            );
        });
    }

    #[test]
    fn portal_requests_round_trip_through_introspected_dbus() {
        crate::gtk_test::run(|| {
            use std::io::BufRead;
            // A private abstract socket: no desktop portal or filesystem socket is touched.
            let mut daemon = std::process::Command::new("dbus-daemon")
                .args([
                    "--session",
                    "--nofork",
                    "--print-address=1",
                    &format!(
                        "--address=unix:abstract=nsh-shortcut-test-{}",
                        std::process::id()
                    ),
                ])
                .stdout(std::process::Stdio::piped())
                .spawn()
                .expect("private D-Bus daemon");
            let mut address = String::new();
            std::io::BufReader::new(daemon.stdout.take().unwrap())
                .read_line(&mut address)
                .unwrap();
            struct Daemon(std::process::Child);
            impl Drop for Daemon {
                fn drop(&mut self) {
                    let _ = self.0.kill();
                    let _ = self.0.wait();
                }
            }
            let _daemon = Daemon(daemon);
            let bus = gio::DBusConnection::for_address_sync(
                address.trim(),
                gio::DBusConnectionFlags::AUTHENTICATION_CLIENT
                    | gio::DBusConnectionFlags::MESSAGE_BUS_CONNECTION,
                None,
                gio::Cancellable::NONE,
            )
            .unwrap();
            bus.call_sync(
                Some("org.freedesktop.DBus"),
                "/org/freedesktop/DBus",
                "org.freedesktop.DBus",
                "RequestName",
                Some(&(PORTAL, 0u32).to_variant()),
                None,
                gio::DBusCallFlags::NONE,
                5000,
                gio::Cancellable::NONE,
            )
            .unwrap();
            let info = gio::DBusNodeInfo::for_xml(r#"<node>
                <interface name="org.freedesktop.portal.GlobalShortcuts">
                <method name="CreateSession"><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
                <method name="BindShortcuts"><arg type="o" direction="in"/><arg type="a(sa{sv})" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
                </interface></node>"#).unwrap();
            let methods = std::rc::Rc::new(RefCell::new(Vec::new()));
            let received = methods.clone();
            let registration = bus
                .register_object(PORTAL_PATH, &info.lookup_interface(INTERFACE).unwrap())
                .method_call(move |bus, sender, _, _, method, params, invocation| {
                    received.borrow_mut().push(method.to_owned());
                    let options = glib::VariantDict::new(Some(
                        &params.child_value(if method == "CreateSession" { 0 } else { 3 }),
                    ));
                    let handle = options.lookup::<String>("handle_token").unwrap().unwrap();
                    let sender = sender.unwrap();
                    let path = format!(
                        "{PORTAL_PATH}/request/{}/{}",
                        sender.trim_start_matches(':').replace('.', "_"),
                        handle
                    );
                    let result = glib::VariantDict::new(None);
                    if method == "CreateSession" {
                        result.insert(
                            "session_handle",
                            glib::variant::ObjectPath::try_from("/session/test").unwrap(),
                        );
                    } else {
                        assert_eq!(params.child_value(0).str(), Some("/session/test"));
                        let shortcuts = params.child_value(1);
                        assert_eq!(shortcuts.n_children(), 1);
                        result.insert_value("shortcuts", &shortcuts);
                    }
                    invocation.return_value(Some(
                        &(glib::variant::ObjectPath::try_from(path.clone()).unwrap(),).to_variant(),
                    ));
                    let response =
                        glib::Variant::tuple_from_iter([0u32.to_variant(), result.end()]);
                    bus.emit_signal(Some(sender), &path, REQUEST, "Response", Some(&response))
                        .unwrap();
                })
                .build()
                .unwrap();
            let surface = crate::gtk_test::surface();
            STATE.with(|state| {
                *state.borrow_mut() = State::default();
                state.borrow_mut().globals.push(Global {
                    id: 1,
                    shortcut: Shortcut::parse("ctrl+alt+k", false).unwrap(),
                    surface: std::rc::Rc::downgrade(&surface),
                    answered: false,
                });
            });
            request(
                &bus,
                "CreateSession",
                session_args,
                glib::VariantDict::new(None),
                |bus, result| {
                    let result = result.expect("portal accepted CreateSession");
                    let session = result.lookup_value("session_handle", None).unwrap();
                    let session = session.str().unwrap();
                    bind_shortcuts(bus, session, 0);
                },
            );
            assert!(crate::gtk_test::wait_until(|| STATE.with(|s| s
                .borrow()
                .globals
                .first()
                .is_some_and(|g| g.answered))));
            assert_eq!(&*methods.borrow(), &["CreateSession", "BindShortcuts"]);
            reset();
            bus.unregister_object(registration).unwrap();
        });
    }

    #[test]
    fn shortcuts_name_and_trigger_for_the_portal() {
        let s = Shortcut::parse("ctrl+shift+k", false).unwrap();
        assert_eq!(portal_id(&s), "ctrl+shift+k");
        assert_eq!(trigger(&s).as_deref(), Some("CTRL+SHIFT+k"));
        let s = Shortcut {
            meta: true,
            alt: true,
            ..Shortcut::key(Key::F(5))
        };
        assert_eq!(portal_id(&s), "alt+super+f5");
        assert_eq!(trigger(&s).as_deref(), Some("ALT+LOGO+F5"));
        let s = Shortcut::parse("mod+,", false).unwrap();
        assert_eq!(trigger(&s).as_deref(), Some("CTRL+comma"));
    }
}
