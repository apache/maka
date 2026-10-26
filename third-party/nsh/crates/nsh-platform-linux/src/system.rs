//! Surface-wide commands and the environment: dialogs, toasts,
//! announcements, the clipboard, exiting; the system appearance followed
//! into [`Environment`].
//!
//! Dialogs and toasts are drawn inside the surface, as GTK widgets the
//! root view hosts over the app's views (overlays), rather than as
//! separate windows: they stay with the surface when it is embedded,
//! never block the main loop, and look the same everywhere (like the web
//! backend's). The root keeps them after its other children
//! ([`end_batch`]), so views mounted later never cover them.
//!
//! The environment follows:
//! - the color scheme: the app's appearance (`nsh.json` `"appearance"`,
//!   `setColorScheme`; [`set_appearance`]) when it forces one, else the
//!   XDG desktop portal's `org.freedesktop.appearance color-scheme` (what
//!   GTK itself follows), live; before it answers, and without a portal,
//!   GTK's own `gtk-interface-color-scheme` (GTK 4.20+) or
//!   `gtk-application-prefer-dark-theme` as they were at start;
//! - the locale (`Intl`'s default): the POSIX locale of formats
//!   (`LC_ALL`, `LC_TIME`, `LC_NUMERIC`, `LC_MESSAGES`, `LANG`, the first
//!   set), else GLib's language names (`LANGUAGE` too), read once;
//! - the font scale: `gtk-xft-dpi` over 96 dpi;
//! - reduce motion: `gtk-enable-animations` off;
//! - the pixel ratio: the root's surface scale (fractional scales too);
//! - right to left: GTK's default text direction (the locale's);
//! - the screen reader: the AT-SPI bus's `ScreenReaderEnabled`;
//! - the OS version: the kernel's major and minor version (distributions
//!   number their releases in incomparable ways, some not at all).
//!
//! Safe area and keyboard height are zero: desktop windows have neither.
//!
//! The surface's scheme in turn drives GTK's (`gtk-interface-color-scheme`
//! and `gtk-application-prefer-dark-theme`), so hosted GTK widgets match
//! the app, and the root's background (white / neutral-950, the default
//! theme's), as the root view has none of its own.
//!
//! The status bar has no desktop equivalent. (`AccessibilityFocus`, which
//! moves keyboard focus when the view can take it, is the mounter's.)
//!
//! The clipboard is the display's (`GdkClipboard`, the "CLIPBOARD"
//! selection): `Clipboard.writeText` sets its text, reads are answered as
//! [`EventKind::Clipboard`] once GDK has the text (reading another app's
//! clipboard is asynchronous); `hasText` only looks at the formats on
//! offer.

use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
    time::Duration,
};

use gtk4::{self as gtk, gdk, gio, glib, prelude::*};
use nsh_core::{
    Bounds, Command, Dialog, DialogButtonStyle, EventKind, EventPayload, NodeId, PayloadValue,
    Points, ROOT_ID,
    geometry::{Point, Size, px},
    platform::clipboard,
};
use nsh_engine::{ColorScheme, Edges, Environment, Locale};

use crate::{surface::Surface, view::NshView};

/// The GTK 4.20 setting of the system's color scheme.
const INTERFACE_SCHEME: &str = "gtk-interface-color-scheme";

/// How long a toast shows (Android's short and long durations).
const TOAST_SHORT: Duration = Duration::from_millis(2000);
const TOAST_LONG: Duration = Duration::from_millis(3500);
/// Fades of overlays, in milliseconds.
const FADE_IN: f64 = 150.0;
const FADE_OUT: f64 = 120.0;

const CSS: &str = "
.nsh-light { background-color: #ffffff; }
.nsh-dark { background-color: #0a0a0a; }
.nsh-dialog-backdrop { background-color: rgba(0, 0, 0, 0.4); }
.nsh-dialog-card {
  border-radius: 12px; padding: 20px;
  background-color: #ffffff; color: #0a0a0a; border: 1px solid #e5e5e5;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
}
.nsh-dark .nsh-dialog-card { background-color: #171717; color: #fafafa; border-color: #262626; }
.nsh-dialog-card.sheet { padding: 6px; }
.nsh-dialog-title { font-size: 17px; font-weight: 600; }
.nsh-dialog-message { font-size: 14px; color: #737373; }
.nsh-dark .nsh-dialog-message { color: #a3a3a3; }
.nsh-dialog-card.sheet .nsh-dialog-title { font-size: 13px; color: #737373; }
.nsh-dark .nsh-dialog-card.sheet .nsh-dialog-title { color: #a3a3a3; }
.nsh-dialog-card.sheet .nsh-dialog-message { font-size: 13px; }
button.nsh-dialog-button {
  min-height: 0; padding: 7px 16px; border-radius: 8px; border: 1px solid #e5e5e5;
  background-image: none; background-color: #ffffff; color: #0a0a0a;
  box-shadow: none; font-size: 14px; font-weight: 500;
}
button.nsh-dialog-button:hover { background-color: #f5f5f5; }
button.nsh-dialog-button:active { background-color: #e5e5e5; }
.nsh-dark button.nsh-dialog-button { background-color: #171717; color: #fafafa; border-color: #262626; }
.nsh-dark button.nsh-dialog-button:hover { background-color: #262626; }
.nsh-dark button.nsh-dialog-button:active { background-color: #404040; }
button.nsh-dialog-button.default { background-color: #171717; color: #fafafa; border-color: #171717; }
button.nsh-dialog-button.default:hover { background-color: #262626; }
.nsh-dark button.nsh-dialog-button.default { background-color: #fafafa; color: #171717; border-color: #fafafa; }
.nsh-dark button.nsh-dialog-button.default:hover { background-color: #e5e5e5; }
button.nsh-dialog-button.destructive { background-color: #ef4444; color: #ffffff; border-color: #ef4444; }
button.nsh-dialog-button.destructive:hover { background-color: #dc2626; }
.nsh-dark button.nsh-dialog-button.destructive { background-color: #f87171; color: #0a0a0a; border-color: #f87171; }
.nsh-dialog-card.sheet button.nsh-dialog-button {
  padding: 11px 16px; border: none; border-radius: 8px; background-color: transparent;
  font-size: 16px; font-weight: 400; color: inherit;
}
.nsh-dialog-card.sheet button.nsh-dialog-button:hover { background-color: alpha(currentColor, 0.08); }
.nsh-dialog-card.sheet button.nsh-dialog-button.destructive { color: #ef4444; }
.nsh-dark .nsh-dialog-card.sheet button.nsh-dialog-button.destructive { color: #f87171; }
.nsh-dialog-card.sheet button.nsh-dialog-button.cancel { font-weight: 600; }
.nsh-toast {
  padding: 9px 16px; border-radius: 18px; font-size: 14px;
  background-color: rgba(23, 23, 23, 0.92); color: #fafafa;
}
.nsh-dark .nsh-toast { background-color: rgba(250, 250, 250, 0.92); color: #0a0a0a; }
";

/// What the system's settings say, for every surface.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Appearance {
    dark: bool,
    font_scale: f32,
    reduce_motion: bool,
    rtl: bool,
    screen_reader: bool,
}

/// A dialog or toast over a surface.
struct Overlay {
    /// The surface's root view, which hosts it.
    root: NshView,
    widget: gtk::Widget,
    kind: OverlayKind,
}

enum OverlayKind {
    Toast(gtk::Label),
    /// `sized` gets the width of the window less `gutter`, at most `max`.
    Dialog {
        sized: gtk::Widget,
        max: f32,
        gutter: f32,
        /// What closing it without a button does: `None` when it cannot
        /// be closed so.
        #[cfg_attr(not(feature = "dev"), allow(dead_code))]
        dismiss: Option<Rc<DialogAnswer>>,
    },
}

#[derive(Default)]
struct System {
    installed: bool,
    surfaces: Vec<Weak<Surface>>,
    /// The portal's answer: `None` until it gives one (or without it).
    portal_dark: Option<bool>,
    /// GTK's scheme before this module set it.
    initial_dark: bool,
    screen_reader: bool,
    /// The D-Bus proxies, kept for their signals.
    proxies: Vec<gio::DBusProxy>,
    overlays: Vec<Overlay>,
}

thread_local! {
    static SYSTEM: RefCell<System> = RefCell::default();
    static OS_VERSION: (u16, u16) = std::fs::read_to_string("/proc/sys/kernel/osrelease")
        .map_or((0, 0), |s| parse_version(&s));
    static LOCALE: Locale = user_locale(|name| std::env::var(name).ok(), || {
        glib::language_names()
            .into_iter()
            .map(|n| n.to_string())
            .collect()
    });
}

/// Follows the system appearance (dark mode, text scale, scale factor)
/// into the surface's environment.
pub(crate) fn watch_environment(surface: &Rc<Surface>) {
    install();
    SYSTEM.with(|s| {
        let mut s = s.borrow_mut();
        s.surfaces.retain(|w| w.strong_count() > 0);
        s.surfaces.push(Rc::downgrade(surface));
    });
    let weak = Rc::downgrade(surface);
    surface.root.connect_scale_factor_notify(move |_| {
        if let Some(surface) = weak.upgrade() {
            update(&surface, appearance());
        }
    });
    // Fractional scales only show on the GDK surface, which exists once
    // the root is realized (in a window).
    let weak = Rc::downgrade(surface);
    surface.root.connect_realize(move |root| {
        let Some(gdk_surface) = root.native().and_then(|n| n.surface()) else {
            return;
        };
        let scaled = weak.clone();
        gdk_surface.connect_scale_notify(move |_| {
            if let Some(surface) = scaled.upgrade() {
                update(&surface, appearance());
            }
        });
        if let Some(surface) = weak.upgrade() {
            update(&surface, appearance());
        }
    });
    update(surface, appearance());
    environment_applied(surface);
}

/// Installs what every surface shares (once per thread): the style sheet
/// and the watchers of the system's settings.
fn install() {
    if SYSTEM.with(|s| std::mem::replace(&mut s.borrow_mut().installed, true)) {
        return;
    }
    let Some(display) = gdk::Display::default() else {
        return;
    };
    let provider = gtk::CssProvider::new();
    provider.load_from_string(CSS);
    gtk::style_context_add_provider_for_display(
        &display,
        &provider,
        gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
    );
    let settings = gtk::Settings::for_display(&display);
    let initial_dark = interface_scheme(&settings)
        .map_or(settings.is_gtk_application_prefer_dark_theme(), |s| {
            s == "dark"
        });
    SYSTEM.with(|s| s.borrow_mut().initial_dark = initial_dark);
    settings.connect_gtk_xft_dpi_notify(|_| system_changed());
    settings.connect_gtk_enable_animations_notify(|_| system_changed());
    watch_portal();
    watch_screen_reader();
}

/// The system's settings now.
fn appearance() -> Appearance {
    let settings = gtk::Settings::default();
    let (dark, screen_reader) = SYSTEM.with(|s| {
        let s = s.borrow();
        (s.portal_dark.unwrap_or(s.initial_dark), s.screen_reader)
    });
    Appearance {
        dark,
        font_scale: settings
            .as_ref()
            .map_or(1.0, |s| font_scale(s.gtk_xft_dpi())),
        reduce_motion: settings
            .as_ref()
            .is_some_and(|s| !s.is_gtk_enable_animations()),
        rtl: gtk::Widget::default_direction() == gtk::TextDirection::Rtl,
        screen_reader,
    }
}

/// A system setting changed: tells every surface.
fn system_changed() {
    let appearance = appearance();
    let surfaces: Vec<Rc<Surface>> = SYSTEM.with(|s| {
        let mut s = s.borrow_mut();
        s.surfaces.retain(|w| w.strong_count() > 0);
        s.surfaces.iter().filter_map(Weak::upgrade).collect()
    });
    for surface in surfaces {
        update(&surface, appearance);
    }
}

/// The embedding app set its locale or text size
/// ([`crate::AppView::set_locale`]): the system's settings are read again,
/// with the host's over them.
pub(crate) fn host_environment_changed(surface: &Surface) {
    update(surface, appearance());
}

/// Writes `appearance` and the surface's own values into its environment.
fn update(surface: &Surface, appearance: Appearance) {
    let mut env: Environment = surface.environment.get();
    let system = if appearance.dark {
        ColorScheme::Dark
    } else {
        ColorScheme::Light
    };
    env.color_scheme = surface.appearance.get().resolve(system);
    env.locale = LOCALE.with(|l| *l);
    env.font_scale = appearance.font_scale;
    env.reduce_motion = appearance.reduce_motion;
    env.rtl = appearance.rtl;
    env.screen_reader = appearance.screen_reader;
    env.pixel_ratio = pixel_ratio(&surface.root);
    env.os_version = OS_VERSION.with(|v| *v);
    env.safe_area = Edges::default();
    env.keyboard_height = px(0.0);
    surface.set_environment(env);
}

/// The surface's environment changed (from the system or a test): GTK's
/// theme and the root's background follow its scheme.
pub(crate) fn environment_applied(surface: &Surface) {
    let dark = surface.environment.get().color_scheme == ColorScheme::Dark;
    let root = &surface.root;
    let (add, remove) = if dark {
        ("nsh-dark", "nsh-light")
    } else {
        ("nsh-light", "nsh-dark")
    };
    root.remove_css_class(remove);
    root.add_css_class(add);
    let Some(settings) = gtk::Settings::default() else {
        return;
    };
    if settings.is_gtk_application_prefer_dark_theme() != dark {
        settings.set_gtk_application_prefer_dark_theme(dark);
    }
    // GTK 4.20+ themes follow this one rather than the above. Setting it
    // makes GTK stop following the portal, which this module does itself.
    let want = if dark { "dark" } else { "light" };
    if interface_scheme(&settings).is_some_and(|scheme| scheme != want)
        && let Some(pspec) = settings.find_property(INTERFACE_SCHEME)
        && let Some(class) = glib::EnumClass::with_type(pspec.value_type())
        && let Some(value) = class.to_value_by_nick(want)
    {
        settings.set_property_from_value(INTERFACE_SCHEME, &value);
    }
}

/// GTK's `gtk-interface-color-scheme` (GTK 4.20+) as its nick: "default",
/// "dark", "light".
fn interface_scheme(settings: &gtk::Settings) -> Option<String> {
    settings.find_property(INTERFACE_SCHEME)?;
    let value = settings.property_value(INTERFACE_SCHEME);
    glib::EnumValue::from_value(&value).map(|(_, v)| v.nick().to_owned())
}

/// Device pixels per point of `root`'s window.
fn pixel_ratio(root: &NshView) -> f32 {
    root.native()
        .and_then(|n| n.surface())
        .map_or(root.scale_factor() as f64, |s| s.scale()) as f32
}

/// `gtk-xft-dpi` (1024ths of a dpi; -1 when unset) over GTK's 96 dpi.
fn font_scale(xft_dpi: i32) -> f32 {
    if xft_dpi <= 0 {
        1.0
    } else {
        xft_dpi as f32 / 1024.0 / 96.0
    }
}

/// The user's locale: the first POSIX locale variable set that applies to
/// formats (`var`), else the first of GLib's language names that is a
/// locale; `en-US` when neither is (`C`, `POSIX`).
fn user_locale(
    var: impl Fn(&str) -> Option<String>,
    language_names: impl FnOnce() -> Vec<String>,
) -> Locale {
    const VARS: [&str; 5] = ["LC_ALL", "LC_TIME", "LC_NUMERIC", "LC_MESSAGES", "LANG"];
    // As POSIX has it, the first variable set decides, even when it is `C`.
    if let Some(value) = VARS.iter().find_map(|v| var(v).filter(|s| !s.is_empty())) {
        return Locale::parse(&value).unwrap_or_default();
    }
    language_names()
        .iter()
        .find_map(|name| Locale::parse(name))
        .unwrap_or_default()
}

/// Major and minor version of a kernel release (`6.9.3-arch1-1`).
fn parse_version(release: &str) -> (u16, u16) {
    let mut parts = release
        .trim()
        .split(|c: char| !c.is_ascii_digit())
        .map(|p| p.parse::<u16>().unwrap_or(0));
    (parts.next().unwrap_or(0), parts.next().unwrap_or(0))
}

/// Follows the portal's `color-scheme` (0: no preference, 1: dark, 2:
/// light).
fn watch_portal() {
    gio::DBusProxy::for_bus(
        gio::BusType::Session,
        gio::DBusProxyFlags::DO_NOT_LOAD_PROPERTIES,
        None,
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.Settings",
        gio::Cancellable::NONE,
        |proxy| {
            let proxy = match proxy {
                Ok(proxy) => proxy,
                Err(err) => return log::debug!("no settings portal: {err}"),
            };
            proxy.connect_g_signal(|_, _, signal, params| {
                if signal == "SettingChanged"
                    && let Some((namespace, key, value)) =
                        params.get::<(String, String, glib::Variant)>()
                    && namespace == "org.freedesktop.appearance"
                    && key == "color-scheme"
                {
                    portal_scheme(&value);
                }
            });
            proxy.call(
                "ReadOne",
                Some(&("org.freedesktop.appearance", "color-scheme").to_variant()),
                gio::DBusCallFlags::NONE,
                1000,
                gio::Cancellable::NONE,
                |result| match result {
                    Ok(reply) => {
                        if let Some((value,)) = reply.get::<(glib::Variant,)>() {
                            portal_scheme(&value);
                        }
                    }
                    Err(err) => log::debug!("settings portal: no color-scheme: {err}"),
                },
            );
            SYSTEM.with(|s| s.borrow_mut().proxies.push(proxy));
        },
    );
}

/// The portal's `color-scheme` value (a `u`, possibly boxed in a `v`).
fn portal_scheme(value: &glib::Variant) {
    let value = if value.is_type(glib::VariantTy::VARIANT) {
        value.as_variant().unwrap_or_else(|| value.clone())
    } else {
        value.clone()
    };
    let Some(scheme) = value.get::<u32>() else {
        return;
    };
    // No preference (0) is light, as GTK has it.
    let dark = Some(scheme == 1);
    let changed = SYSTEM.with(|s| {
        let mut s = s.borrow_mut();
        std::mem::replace(&mut s.portal_dark, dark) != dark
    });
    if changed {
        system_changed();
    }
}

/// Follows AT-SPI's `ScreenReaderEnabled` (Orca and the like set it).
fn watch_screen_reader() {
    gio::DBusProxy::for_bus(
        gio::BusType::Session,
        gio::DBusProxyFlags::NONE,
        None,
        "org.a11y.Bus",
        "/org/a11y/bus",
        "org.a11y.Status",
        gio::Cancellable::NONE,
        |proxy| {
            let proxy = match proxy {
                Ok(proxy) => proxy,
                Err(err) => return log::debug!("no accessibility bus: {err}"),
            };
            proxy.connect_g_properties_changed(|proxy, _, _| screen_reader(proxy));
            screen_reader(&proxy);
            SYSTEM.with(|s| s.borrow_mut().proxies.push(proxy));
        },
    );
}

fn screen_reader(proxy: &gio::DBusProxy) {
    let on = proxy
        .cached_property("ScreenReaderEnabled")
        .and_then(|v| v.get::<bool>())
        .unwrap_or(false);
    let changed = SYSTEM.with(|s| std::mem::replace(&mut s.borrow_mut().screen_reader, on) != on);
    if changed {
        system_changed();
    }
}

/// A command not addressed to a kind of view.
pub(crate) fn command(surface: &Rc<Surface>, _id: NodeId, command: &Command) {
    match command {
        Command::Dialog(dialog) => show_dialog(surface, dialog),
        Command::Toast { text, long } => show_toast(surface, text, *long),
        Command::Announce(text) => crate::access::announce(&surface.root, text),
        Command::Desktop(command) => crate::chrome::command(surface, command),
        Command::SetClipboard(text) => {
            if let Some(display) = gdk::Display::default() {
                display.clipboard().set_text(text);
            }
        }
        Command::ReadClipboard { id, has_only } => read_clipboard(surface, *id, *has_only),
        Command::SetClipboardImage(uri) => set_clipboard_image(uri),
        Command::ReadClipboardImage { id, has_only } => {
            read_clipboard_image(surface, *id, *has_only)
        }
        Command::ReadClipboardFiles { id } => read_clipboard_files(surface, *id),
        Command::PickImages { id, request } => pick_images(surface, *id, *request),
        Command::OpenUrl { id, url } => open_url(surface, *id, url),
        Command::Back => crate::navigation::default_back(surface),
        Command::ExitApp => {
            // Closing destroys the window, whose handler stops the surface:
            // not while the surface is applying this batch.
            if let Some(window) = surface.root.root().and_downcast::<gtk::Window>() {
                glib::idle_add_local_once(move || window.close());
            }
        }
        // The status bar is a phone's; layout animations arrive as mount
        // items.
        Command::StatusBar(_) | Command::SetStatusBar(_) | Command::LayoutAnimation(_) => {}
        other => log::debug!("linux: command {other:?} is not supported"),
    }
}

/// The batch is applied: overlays stay over views mounted on the root.
pub(crate) fn end_batch(surface: &Surface) {
    let root = &surface.root;
    let Some(last) = root.last_child() else {
        return;
    };
    SYSTEM.with(|s| {
        let s = s.borrow();
        if s.overlays.iter().any(|o| o.widget == last) {
            return;
        }
        for overlay in s.overlays.iter().filter(|o| &o.root == root) {
            overlay.widget.insert_before(root, gtk::Widget::NONE);
        }
    });
}

/// The surface is `width` × `height`: overlays follow.
pub(crate) fn surface_resized(surface: &Surface, width: f32, height: f32) {
    SYSTEM.with(|s| {
        for overlay in s
            .borrow()
            .overlays
            .iter()
            .filter(|o| o.root == surface.root)
        {
            place(overlay, width, height);
        }
    });
}

/// The app stopped: its dialogs and toasts go too.
pub(crate) fn clear(surface: &Surface) {
    let removed: Vec<Overlay> = SYSTEM.with(|s| {
        let mut s = s.borrow_mut();
        let (removed, kept) = std::mem::take(&mut s.overlays)
            .into_iter()
            .partition(|o| o.root == surface.root);
        s.overlays = kept;
        removed
    });
    for overlay in removed {
        overlay.root.remove_native(&overlay.widget);
    }
}

fn place(overlay: &Overlay, width: f32, height: f32) {
    match &overlay.kind {
        OverlayKind::Dialog {
            sized, max, gutter, ..
        } => {
            sized.set_width_request((width - gutter).min(*max).max(0.0) as i32);
            overlay.root.set_native(
                &overlay.widget,
                Bounds {
                    origin: Point {
                        x: Points(0.0),
                        y: Points(0.0),
                    },
                    size: Size {
                        width: Points(width),
                        height: Points(height),
                    },
                },
            );
        }
        OverlayKind::Toast(label) => {
            let max = (width - 48.0).max(0.0) as i32;
            let (_, natural, _, _) = label.measure(gtk::Orientation::Horizontal, -1);
            let w = natural.min(max);
            let (_, h, _, _) = label.measure(gtk::Orientation::Vertical, w);
            overlay.root.set_native(
                &overlay.widget,
                Bounds {
                    origin: Point {
                        x: Points(((width - w as f32) / 2.0).round()),
                        y: Points(height - 64.0 - h as f32),
                    },
                    size: Size {
                        width: Points(w as f32),
                        height: Points(h as f32),
                    },
                },
            );
        }
    }
}

/// Hosts `widget` over `surface`'s views and fades it in.
fn add_overlay(surface: &Surface, widget: gtk::Widget, kind: OverlayKind) {
    widget.add_css_class("nsh-overlay");
    let overlay = Overlay {
        root: surface.root.clone(),
        widget: widget.clone(),
        kind,
    };
    let env = surface.environment.get();
    place(&overlay, env.window.width.0, env.window.height.0);
    SYSTEM.with(|s| s.borrow_mut().overlays.push(overlay));
    widget.set_opacity(0.0);
    fade(
        &widget,
        1.0,
        if env.reduce_motion { 0.0 } else { FADE_IN },
        || {},
    );
}

/// Fades `widget` out and removes it.
fn remove_overlay(widget: &gtk::Widget) {
    let found = SYSTEM.with(|s| {
        let mut s = s.borrow_mut();
        let i = s.overlays.iter().position(|o| &o.widget == widget)?;
        Some(s.overlays.remove(i))
    });
    let Some(overlay) = found else { return };
    // No more input while it fades.
    widget.set_can_target(false);
    let root = overlay.root;
    let w = widget.clone();
    fade(widget, 0.0, FADE_OUT, move || root.remove_native(&w));
}

/// Animates `widget`'s opacity to `to` over `ms` on its frame clock, then
/// calls `done`.
fn fade(widget: &gtk::Widget, to: f64, ms: f64, done: impl FnOnce() + 'static) {
    if ms <= 0.0 || !widget.is_mapped() {
        widget.set_opacity(to);
        return done();
    }
    let from = widget.opacity();
    let start = Cell::new(None::<i64>);
    let done = Cell::new(Some(done));
    widget.add_tick_callback(move |widget, clock| {
        let now = clock.frame_time();
        let t0 = start.get().unwrap_or(now);
        start.set(Some(t0));
        let t = ((now - t0) as f64 / 1000.0 / ms).min(1.0);
        // Ease out.
        let eased = 1.0 - (1.0 - t) * (1.0 - t);
        widget.set_opacity(from + (to - from) * eased);
        if t < 1.0 {
            return glib::ControlFlow::Continue;
        }
        if let Some(done) = done.take() {
            done();
        }
        glib::ControlFlow::Break
    });
}

/// Reports one dialog's answer, once, and closes it.
struct DialogAnswer {
    id: u32,
    surface: Weak<Surface>,
    backdrop: gtk::Widget,
    answered: Cell<bool>,
    /// What had the keyboard focus before the dialog took it.
    previous_focus: glib::WeakRef<gtk::Widget>,
}

impl DialogAnswer {
    fn answer(&self, index: i32) {
        if self.answered.replace(true) {
            return;
        }
        // The focus goes back where it was (as desktop dialogs do), not to
        // whatever GTK picks once the focused button goes.
        match self.previous_focus.upgrade() {
            Some(previous) if previous.root().is_some() && previous.is_sensitive() => {
                // A text field would select all its text otherwise.
                match previous.downcast_ref::<gtk::Text>() {
                    Some(text) => text.grab_focus_without_selecting(),
                    None => previous.grab_focus(),
                };
            }
            _ => {
                if let Some(root) = self.backdrop.root() {
                    root.set_focus(gtk::Widget::NONE);
                }
            }
        }
        remove_overlay(&self.backdrop);
        let Some(surface) = self.surface.upgrade() else {
            return;
        };
        surface.event(
            ROOT_ID,
            EventKind::Dialog,
            EventPayload::Map(vec![
                ("id", PayloadValue::Number(self.id as f64)),
                ("index", PayloadValue::Number(index as f64)),
            ]),
        );
    }
}

/// A dialog's card: a rounded box.
fn dialog_card(sheet: bool) -> gtk::Box {
    let card = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(if sheet { 0 } else { 6 })
        .css_classes(["nsh-dialog-card"])
        .accessible_role(gtk::AccessibleRole::AlertDialog)
        .build();
    if sheet {
        card.add_css_class("sheet");
    }
    card
}

/// A dialog's title or message.
fn dialog_label(text: &str, class: &str, sheet: bool) -> gtk::Label {
    let label = gtk::Label::builder()
        .label(text)
        .wrap(true)
        .wrap_mode(gtk::pango::WrapMode::WordChar)
        // Wrapped labels ask for their whole text's width otherwise; the
        // card's width request sets the width.
        .max_width_chars(1)
        .xalign(if sheet { 0.5 } else { 0.0 })
        .justify(if sheet {
            gtk::Justification::Center
        } else {
            gtk::Justification::Left
        })
        .css_classes([class])
        .build();
    if sheet {
        label.set_margin_top(8);
        label.set_margin_start(12);
        label.set_margin_end(12);
    }
    label
}

/// Shows `dialog` over the surface: a card in the middle (an alert) or at
/// the bottom (an action sheet) over a dimmed backdrop. Answers the
/// button's index; -1 when dismissed (a click outside or Escape, when
/// cancelable); Escape presses the cancel button when there is one.
fn show_dialog(surface: &Rc<Surface>, dialog: &Dialog) {
    let backdrop = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .css_classes(["nsh-dialog-backdrop"])
        .build();
    let previous_focus = glib::WeakRef::new();
    previous_focus.set(surface.root.root().and_then(|r| r.focus()).as_ref());
    let answer = Rc::new(DialogAnswer {
        id: dialog.id,
        surface: Rc::downgrade(surface),
        backdrop: backdrop.clone().upcast(),
        answered: Cell::new(false),
        previous_focus,
    });
    // `AlertDialog` always brings the app's actions (it rejects none): no
    // label of NSH's own.
    let buttons = &dialog.buttons[..];
    let cancel = buttons
        .iter()
        .position(|b| b.style == DialogButtonStyle::Cancel);
    // The buttons in focus order, for keeping the focus inside.
    let order: Rc<RefCell<Vec<gtk::Button>>> = Rc::default();
    let make_button = |index: usize| {
        let b = &buttons[index];
        let button = gtk::Button::builder()
            .label(&b.text)
            .css_classes(["nsh-dialog-button"])
            .build();
        match b.style {
            DialogButtonStyle::Default => {}
            DialogButtonStyle::Cancel => button.add_css_class("cancel"),
            DialogButtonStyle::Destructive => button.add_css_class("destructive"),
        }
        let answer = answer.clone();
        button.connect_clicked(move |_| answer.answer(index as i32));
        order.borrow_mut().push(button.clone());
        button
    };

    let (sized, max, gutter, focus): (gtk::Widget, f32, f32, Option<gtk::Button>);
    if dialog.sheet {
        let column = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(8)
            .vexpand(true)
            .valign(gtk::Align::End)
            .halign(gtk::Align::Center)
            .margin_bottom(8)
            .build();
        let options = dialog_card(true);
        if let Some(title) = &dialog.title {
            options.append(&dialog_label(title, "nsh-dialog-title", true));
        }
        if let Some(message) = &dialog.message {
            options.append(&dialog_label(message, "nsh-dialog-message", true));
        }
        if dialog.title.is_some() || dialog.message.is_some() {
            options.append(&gtk::Separator::builder().margin_top(8).build());
        }
        let mut first = None;
        for index in (0..buttons.len()).filter(|i| Some(*i) != cancel) {
            let button = make_button(index);
            first.get_or_insert_with(|| button.clone());
            options.append(&button);
        }
        if options.first_child().is_some() {
            column.append(&options);
        }
        if let Some(cancel) = cancel {
            let card = dialog_card(true);
            let button = make_button(cancel);
            first.get_or_insert_with(|| button.clone());
            card.append(&button);
            column.append(&card);
        }
        backdrop.append(&column);
        (sized, max, gutter, focus) = (column.upcast(), 420.0, 16.0, first);
    } else {
        let card = dialog_card(false);
        card.set_vexpand(true);
        card.set_valign(gtk::Align::Center);
        card.set_halign(gtk::Align::Center);
        if let Some(title) = &dialog.title {
            card.append(&dialog_label(title, "nsh-dialog-title", false));
        }
        if let Some(message) = &dialog.message {
            card.append(&dialog_label(message, "nsh-dialog-message", false));
        }
        // Up to three buttons in a row at the end, more in a column.
        let row = buttons.len() <= 3;
        let actions = gtk::Box::builder()
            .orientation(if row {
                gtk::Orientation::Horizontal
            } else {
                gtk::Orientation::Vertical
            })
            .spacing(8)
            .halign(if row {
                gtk::Align::End
            } else {
                gtk::Align::Fill
            })
            .margin_top(14)
            .build();
        // The last regular button is the default action (Enter).
        let default = (0..buttons.len())
            .rev()
            .find(|i| buttons[*i].style == DialogButtonStyle::Default);
        let mut focused = None;
        for index in 0..buttons.len() {
            let button = make_button(index);
            if Some(index) == default {
                button.add_css_class("default");
                focused = Some(button.clone());
            }
            actions.append(&button);
        }
        let focused = focused.or_else(|| actions.first_child().and_downcast());
        card.append(&actions);
        backdrop.append(&card);
        (sized, max, gutter, focus) = (card.upcast(), 340.0, 32.0, focused);
    }

    // A click outside the cards.
    let click = gtk::GestureClick::new();
    let cancelable = dialog.cancelable;
    {
        let answer = answer.clone();
        click.connect_released(move |gesture, _, x, y| {
            let Some(backdrop) = gesture.widget() else {
                return;
            };
            let outside = backdrop
                .pick(x, y, gtk::PickFlags::DEFAULT)
                .is_none_or(|w| w == backdrop || w.parent().as_ref() == Some(&backdrop));
            if cancelable && outside {
                answer.answer(-1);
            }
        });
    }
    backdrop.add_controller(click);
    let keys = gtk::EventControllerKey::new();
    {
        let answer = answer.clone();
        keys.connect_key_pressed(move |_, key, _, modifiers| {
            // The dialog is modal: Tab and the arrows move between its
            // buttons, wrapping around, never to the views behind it.
            let step = match key {
                gdk::Key::Tab | gdk::Key::KP_Tab
                    if modifiers.contains(gdk::ModifierType::SHIFT_MASK) =>
                {
                    Some(-1)
                }
                gdk::Key::Tab | gdk::Key::KP_Tab | gdk::Key::Right | gdk::Key::Down => Some(1),
                gdk::Key::ISO_Left_Tab | gdk::Key::Left | gdk::Key::Up => Some(-1),
                _ => None,
            };
            if let Some(step) = step {
                let order = order.borrow();
                let n = order.len() as isize;
                if n > 0 {
                    let at = order
                        .iter()
                        .position(|b| b.has_focus())
                        .map_or(-1, |i| i as isize);
                    let next = if at < 0 && step < 0 {
                        n - 1
                    } else {
                        (at + step).rem_euclid(n)
                    };
                    order[next as usize].grab_focus();
                }
                return glib::Propagation::Stop;
            }
            if key != gdk::Key::Escape {
                return glib::Propagation::Proceed;
            }
            match cancel {
                Some(cancel) => answer.answer(cancel as i32),
                None if cancelable => answer.answer(-1),
                None => {}
            }
            glib::Propagation::Stop
        });
    }
    backdrop.add_controller(keys);

    add_overlay(
        surface,
        backdrop.upcast(),
        OverlayKind::Dialog {
            sized,
            max,
            gutter,
            dismiss: cancelable.then(|| answer.clone()),
        },
    );
    if let Some(focus) = focus {
        focus.grab_focus();
    }
}

/// Answers the newest dialog on `surface` as a user does: presses its
/// button titled `button`, or closes it without one (`None`; only a dialog
/// that can be closed so).
#[cfg(feature = "dev")]
pub(crate) fn answer_dialog(surface: &Surface, button: Option<&str>) -> Result<(), String> {
    let (widget, dismiss) = SYSTEM
        .with(|s| {
            s.borrow()
                .overlays
                .iter()
                .rev()
                .find_map(|o| match &o.kind {
                    OverlayKind::Dialog { dismiss, .. }
                        if o.root == surface.root && o.widget.can_target() =>
                    {
                        Some((o.widget.clone(), dismiss.clone()))
                    }
                    _ => None,
                })
        })
        .ok_or("no dialog is shown")?;
    let Some(text) = button else {
        let dismiss = dismiss.ok_or("the dialog can only be answered with a button")?;
        dismiss.answer(-1);
        return Ok(());
    };
    let found = descendants(&widget).find_map(|w| {
        let button = w.downcast::<gtk::Button>().ok()?;
        (button.label().as_deref() == Some(text)).then_some(button)
    });
    let button = found.ok_or_else(|| format!("the dialog has no button {text:?}"))?;
    button.emit_clicked();
    Ok(())
}

/// `widget` and every widget inside it, depth first.
#[cfg(feature = "dev")]
fn descendants(widget: &gtk::Widget) -> impl Iterator<Item = gtk::Widget> {
    let mut stack = vec![widget.clone()];
    std::iter::from_fn(move || {
        let w = stack.pop()?;
        let mut child = w.last_child();
        while let Some(c) = child {
            child = c.prev_sibling();
            stack.push(c);
        }
        Some(w)
    })
}

/// Shows `text` at the bottom of the surface for a while (one at a time:
/// a new toast replaces the one showing).
fn show_toast(surface: &Rc<Surface>, text: &str, long: bool) {
    let showing: Vec<gtk::Widget> = SYSTEM.with(|s| {
        s.borrow()
            .overlays
            .iter()
            .filter(|o| o.root == surface.root && matches!(o.kind, OverlayKind::Toast(_)))
            .map(|o| o.widget.clone())
            .collect()
    });
    for widget in &showing {
        remove_overlay(widget);
    }
    let label = gtk::Label::builder()
        .label(text)
        .wrap(true)
        .wrap_mode(gtk::pango::WrapMode::WordChar)
        .max_width_chars(48)
        .justify(gtk::Justification::Center)
        .css_classes(["nsh-toast"])
        .can_target(false)
        .build();
    let widget: gtk::Widget = label.clone().upcast();
    add_overlay(surface, widget.clone(), OverlayKind::Toast(label));
    surface
        .root
        .announce(text, gtk::AccessibleAnnouncementPriority::Low);
    let duration = if long { TOAST_LONG } else { TOAST_SHORT };
    glib::timeout_add_local_once(duration, move || remove_overlay(&widget));
}

/// `Clipboard.readText` / `hasText`: answers read `id` with whether the
/// clipboard holds text and, unless `has_only`, the text.
/// Opens `url` with the app the desktop has for its scheme
/// (`GtkUriLauncher`: the desktop portal in a sandbox, `GAppInfo`
/// otherwise), parented to the surface's window, and reports whether it
/// did ([`EventKind::OpenUrl`]).
fn open_url(surface: &Rc<Surface>, id: u32, url: &str) {
    let window = surface.root.root().and_downcast::<gtk::Window>();
    let surface = Rc::downgrade(surface);
    gtk::UriLauncher::new(url).launch(window.as_ref(), gio::Cancellable::NONE, move |result| {
        if let Err(err) = &result {
            log::debug!("linux: opening a URL failed: {err}");
        }
        if let Some(surface) = surface.upgrade() {
            surface.event(
                ROOT_ID,
                EventKind::OpenUrl,
                EventPayload::Map(vec![
                    ("id", PayloadValue::Number(id as f64)),
                    ("opened", PayloadValue::Bool(result.is_ok())),
                ]),
            );
        }
    });
}

fn read_clipboard(surface: &Rc<Surface>, id: u32, has_only: bool) {
    let answer = move |surface: &Surface, has: bool, text: Option<String>| {
        let mut fields = vec![
            ("id", PayloadValue::Number(id as f64)),
            ("has", PayloadValue::Bool(has)),
        ];
        if let Some(text) = text {
            fields.push(("text", PayloadValue::Str(text)));
        }
        surface.event(ROOT_ID, EventKind::Clipboard, EventPayload::Map(fields));
    };
    let Some(display) = gdk::Display::default() else {
        return answer(surface, false, None);
    };
    let clipboard = display.clipboard();
    // Text on offer as a type (this app's own) or a format GDK reads as one.
    let has = clipboard
        .formats()
        .union_deserialize_types()
        .contains_type(glib::Type::STRING);
    if has_only || !has {
        return answer(surface, has, None);
    }
    let surface = Rc::downgrade(surface);
    glib::spawn_future_local(async move {
        let text = match clipboard.read_text_future().await {
            Ok(text) => text.map(String::from),
            Err(err) => {
                log::debug!("linux: clipboard read failed: {err}");
                None
            }
        };
        if let Some(surface) = surface.upgrade() {
            answer(&surface, text.is_some(), text);
        }
    });
}

/// `Clipboard.writeImage`: the image of a `data:` URI as a GDK texture,
/// which GDK offers in the formats it encodes (PNG, TIFF, ...).
fn set_clipboard_image(uri: &str) {
    let Some((_, bytes)) = clipboard::decode_data_uri(uri) else {
        log::warn!("Clipboard.writeImage: not a base64 data: URI");
        return;
    };
    match gdk::Texture::from_bytes(&glib::Bytes::from_owned(bytes)) {
        Ok(texture) => {
            if let Some(display) = gdk::Display::default() {
                display.clipboard().set_texture(&texture);
            }
        }
        Err(err) => log::warn!("Clipboard.writeImage: {err}"),
    }
}

/// `Clipboard.readImage` / `hasImage`: the clipboard's image as a GDK
/// texture (whatever format the app offering it put), answered as PNG.
fn read_clipboard_image(surface: &Rc<Surface>, id: u32, has_only: bool) {
    let answer = move |surface: &Surface, payload| {
        surface.event(ROOT_ID, EventKind::Clipboard, payload);
    };
    let Some(display) = gdk::Display::default() else {
        return answer(surface, clipboard::image_answer(id, false, None));
    };
    let board = display.clipboard();
    let has = board
        .formats()
        .union_deserialize_types()
        .contains_type(gdk::Texture::static_type());
    if has_only || !has {
        return answer(surface, clipboard::image_answer(id, has, None));
    }
    let surface = Rc::downgrade(surface);
    glib::spawn_future_local(async move {
        let png = match board.read_texture_future().await {
            Ok(texture) => texture.map(|t| t.save_to_png_bytes()),
            Err(err) => {
                log::debug!("linux: clipboard image read failed: {err}");
                None
            }
        };
        let image = png.as_deref().and_then(clipboard::Image::sniff);
        if let Some(surface) = surface.upgrade() {
            answer(&surface, clipboard::image_answer(id, true, image));
        }
    });
}

/// What `board` holds, read as the user pastes into an input (`onPaste`):
/// its text, its image (as PNG) and its local files' `file:` URIs. GTK
/// reads a clipboard asynchronously: `done` gets it once read.
pub(crate) fn read_pasted(
    board: gdk::Clipboard,
    done: impl FnOnce(nsh_core::PasteEvent) + 'static,
) {
    let types = board.formats().union_deserialize_types();
    let (has_image, has_files) = (
        types.contains_type(gdk::Texture::static_type()),
        types.contains_type(gdk::FileList::static_type()),
    );
    glib::spawn_future_local(async move {
        let text = board.read_text_future().await.ok().flatten();
        let mut paste = nsh_core::PasteEvent::new(text.map(|t| t.to_string()).unwrap_or_default());
        if has_files
            && let Ok(value) = board
                .read_value_future(gdk::FileList::static_type(), glib::Priority::DEFAULT)
                .await
            && let Ok(list) = value.get::<gdk::FileList>()
        {
            paste.uris = list
                .files()
                .into_iter()
                .filter(|file| file.path().is_some_and(|path| path.is_absolute()))
                .map(|file| file.uri().to_string())
                .collect();
        }
        // A file list's icon is no image of the user's.
        if has_image
            && paste.uris.is_empty()
            && let Ok(Some(texture)) = board.read_texture_future().await
        {
            paste.files.push(nsh_core::PastedFile::image(
                texture.save_to_png_bytes().to_vec(),
            ));
        }
        done(paste);
    });
}

/// `Picker.pickImages`: GTK's file dialog (the portal's where there is
/// one), filtered to the image formats the request takes. The files are
/// read as they are, on a thread of their own (no scaling or conversion
/// here: `nsh_core::picker::read_files`).
fn pick_images(surface: &Rc<Surface>, id: u32, request: nsh_core::picker::PickRequest) {
    let mut control = None;
    surface.control(|c| control = Some(c.clone()));
    let Some(control) = control else { return };
    let filter = gtk::FileFilter::new();
    for extension in nsh_core::picker::dialog_extensions(&request) {
        filter.add_suffix(extension);
    }
    let filters = gio::ListStore::new::<gtk::FileFilter>();
    filters.append(&filter);
    let dialog = gtk::FileDialog::builder().modal(true).build();
    dialog.set_filters(Some(&filters));
    dialog.set_default_filter(Some(&filter));
    let window = surface.root.root().and_downcast::<gtk::Window>();
    let read = move |paths: Vec<std::path::PathBuf>| {
        std::thread::spawn(move || {
            let files = nsh_core::picker::read_files(&paths, &request);
            control.dispatch_event(ROOT_ID, EventKind::Pick, EventPayload::Picked { id, files });
        });
    };
    if request.multiple() {
        dialog.open_multiple(window.as_ref(), gio::Cancellable::NONE, move |result| {
            let paths = result
                .map(|list| {
                    (0..list.n_items())
                        .filter_map(|i| list.item(i).and_downcast::<gio::File>())
                        .filter_map(|file| file.path())
                        .collect()
                })
                .unwrap_or_default();
            read(paths);
        });
    } else {
        dialog.open(window.as_ref(), gio::Cancellable::NONE, move |result| {
            read(
                result
                    .ok()
                    .and_then(|file| file.path())
                    .into_iter()
                    .collect(),
            );
        });
    }
}

/// `Clipboard.readFiles`: the `file:` URIs of a file list on the clipboard
/// (files copied in a file manager).
fn read_clipboard_files(surface: &Rc<Surface>, id: u32) {
    let answer = move |surface: &Surface, files: &[String]| {
        surface.event(
            ROOT_ID,
            EventKind::Clipboard,
            clipboard::files_answer(id, files),
        );
    };
    let Some(display) = gdk::Display::default() else {
        return answer(surface, &[]);
    };
    let board = display.clipboard();
    if !board
        .formats()
        .union_deserialize_types()
        .contains_type(gdk::FileList::static_type())
    {
        return answer(surface, &[]);
    }
    let surface = Rc::downgrade(surface);
    glib::spawn_future_local(async move {
        let files = match board
            .read_value_future(gdk::FileList::static_type(), glib::Priority::DEFAULT)
            .await
        {
            Ok(value) => value
                .get::<gdk::FileList>()
                .map(|list| {
                    list.files()
                        .into_iter()
                        .filter(|file| file.path().is_some_and(|path| path.is_absolute()))
                        .map(|file| file.uri().to_string())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default(),
            Err(err) => {
                log::debug!("linux: clipboard files read failed: {err}");
                Vec::new()
            }
        };
        if let Some(surface) = surface.upgrade() {
            answer(&surface, &files);
        }
    });
}

/// `MountItem::Appearance`: the app forces light or dark (or follows the
/// system again). The environment, GTK's theme (hosted widgets, dialogs)
/// and the root's background follow.
pub(crate) fn set_appearance(surface: &Rc<Surface>, appearance: nsh_core::platform::Appearance) {
    if surface.appearance.replace(appearance) != appearance {
        update(surface, self::appearance());
    }
}

/// Tests: the system's color scheme is now dark (or light), as the
/// portal would say.
#[cfg(feature = "dev")]
pub(crate) fn simulate_system_scheme(dark: bool) {
    SYSTEM.with(|s| s.borrow_mut().portal_dark = Some(dark));
    system_changed();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kernel_versions() {
        assert_eq!(parse_version("7.2.5-3-omarchy\n"), (7, 2));
        assert_eq!(parse_version("6.8.0-45-generic"), (6, 8));
        assert_eq!(parse_version("5.15"), (5, 15));
        assert_eq!(parse_version(""), (0, 0));
    }

    #[test]
    fn locales() {
        let vars = |set: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                set.iter()
                    .find(|(k, _)| *k == name)
                    .map(|(_, v)| (*v).to_owned())
            }
        };
        let none = || vec!["C".to_owned()];
        let tag = |l: Locale| l.as_str().to_owned();
        assert_eq!(
            tag(user_locale(vars(&[("LANG", "de_DE.UTF-8")]), none)),
            "de-DE"
        );
        // Formats win over the language of messages.
        assert_eq!(
            tag(user_locale(
                vars(&[("LANG", "en_US.UTF-8"), ("LC_TIME", "zh_CN.UTF-8")]),
                none
            )),
            "zh-CN"
        );
        assert_eq!(
            tag(user_locale(
                vars(&[("LC_ALL", "pt_BR"), ("LANG", "en_US")]),
                none
            )),
            "pt-BR"
        );
        // `C` is no locale; empty variables are unset.
        assert_eq!(
            tag(user_locale(
                vars(&[("LC_ALL", "C.UTF-8"), ("LANG", "fr_FR")]),
                none
            )),
            "en-US"
        );
        assert_eq!(
            tag(user_locale(
                vars(&[("LC_ALL", ""), ("LANG", "fr_FR")]),
                none
            )),
            "fr-FR"
        );
        // Nothing set: GLib's names (`LANGUAGE`).
        assert_eq!(
            tag(user_locale(vars(&[]), || vec![
                "ja_JP.UTF-8".to_owned(),
                "ja".to_owned(),
                "C".to_owned()
            ])),
            "ja-JP"
        );
        assert_eq!(tag(user_locale(vars(&[]), none)), "en-US");
    }

    #[test]
    fn font_scales() {
        assert_eq!(font_scale(-1), 1.0);
        assert_eq!(font_scale(96 * 1024), 1.0);
        assert_eq!(font_scale(120 * 1024), 1.25);
    }
}
