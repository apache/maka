//! Surface-wide commands and the environment: dialogs, the clipboard,
//! exiting; the system's settings followed into
//! [`Environment`].
//!
//! Dialogs are drawn inside the surface, as items the root view
//! hosts over the app's views ([`Hosted`]), rather than as separate
//! windows: they stay with the surface when it is embedded in another
//! GPUI app's window, never block the main loop (the engine and
//! animations keep going), and look the same on every desktop. They follow
//! the Windows backend's content dialogs: a rounded card over a dimmed
//! backdrop, the text above a footer of buttons, the default action in the
//! accent color; action sheets are cards at the bottom. The root keeps
//! them after its other hosted items ([`end_batch`]), so nothing mounted
//! later covers them.
//!
//! The environment follows:
//! - the color scheme: the app's appearance (`nsh.json` `"appearance"`,
//!   `setColorScheme`; [`set_appearance`]) when it forces one, else the
//!   window's appearance (GPUI's: the portal's `color-scheme` on Linux,
//!   `AppsUseLightTheme` on Windows, the effective appearance on macOS),
//!   live through `observe_window_appearance`. A window the surface owns
//!   ([`own_window`]: the standalone app's) is given the app's appearance
//!   too (`set_window_appearance`, which only macOS acts on), so its title
//!   bar matches;
//! - the locale (`Intl`'s default), as the native backends read it: on
//!   Linux the POSIX locale of formats (`LC_ALL`, `LC_TIME`, `LC_NUMERIC`,
//!   `LC_MESSAGES`, `LANG`, the first set), else `LANGUAGE`; on Windows the
//!   user's regional format (`GetUserDefaultLocaleName`); on macOS the
//!   current locale (`CFLocaleCopyCurrent`, the region format);
//! - the font scale: Windows' text size (`TextScaleFactor`), the settings
//!   portal's `org.gnome.desktop.interface text-scaling-factor` on Linux;
//!   1 on macOS;
//! - reduce motion: Windows' animation effects
//!   (`SPI_GETCLIENTAREAANIMATION`), macOS' universal access
//!   `reduceMotion`, the portal's `enable-animations` off on Linux;
//! - right to left: the reading direction of the UI language on Windows,
//!   of the locale's language elsewhere;
//! - the screen reader: `SPI_GETSCREENREADER` on Windows, VoiceOver's
//!   preference on macOS, AT-SPI's `ScreenReaderEnabled` on Linux;
//! - the pixel ratio: the window's scale factor (the surface sets it);
//! - the OS version: the kernel's on Linux, `RtlGetVersion`'s on Windows,
//!   `kern.osproductversion` on macOS.
//!
//! On Windows and macOS the settings are read again whenever the window's
//! appearance changes (GPUI reports no other setting changes); on Linux
//! background threads follow the portal's `SettingChanged` and AT-SPI's
//! property changes over D-Bus, and dialogs take the portal's
//! `org.freedesktop.appearance accent-color`. Safe area and keyboard height
//! are zero: desktop windows have neither. The surface's scheme drives the
//! root's background (white / neutral-950, the default theme's), as the
//! root view has none of its own.
//!
//! The status bar has no desktop equivalent. The clipboard is GPUI's
//! (`write_to_clipboard` / `read_from_clipboard`); reads are answered as
//! [`EventKind::Clipboard`] on the next turn of the main loop.

use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
};

use gpui::{
    AnyWindowHandle, Context, FontWeight, Hsla, SharedString, TextAlign, TextRun, Window,
    WindowAppearance, px,
};
use nsh_core::{
    Color, Command, Dialog, DialogButtonStyle, EventKind, EventPayload, NodeId, PayloadValue,
    Points, ROOT_ID,
    platform::{Appearance, clipboard},
};
use nsh_engine::{ColorScheme, Edges, Environment, Locale};

use crate::{
    app::AppView,
    geom::rect,
    input::{Cursor, KeyEvent, PointerKind},
    render::{DrawCx, border_quad, corners},
    surface::Surface,
    view::{Hosted, ItemPointer},
};

/// Fades of overlays, in seconds.
const FADE_IN: f64 = 0.167;
const FADE_OUT: f64 = 0.12;

/// Virtual keys a dialog answers ([`crate::keys`] maps GPUI's to them).
const VK_TAB: u16 = 0x09;
const VK_RETURN: u16 = 0x0D;
const VK_ESCAPE: u16 = 0x1B;
const VK_SPACE: u16 = 0x20;
const VK_LEFT: u16 = 0x25;
const VK_UP: u16 = 0x26;
const VK_RIGHT: u16 = 0x27;
const VK_DOWN: u16 = 0x28;

thread_local! {
    /// The system appearance a test switched to (`nsh test --target`).
    static SIMULATED: Cell<Option<bool>> = const { Cell::new(None) };
    /// The surfaces whose environment this module keeps.
    static WATCHED: RefCell<Vec<Watched>> = const { RefCell::new(Vec::new()) };
    /// The dialogs of this thread's surfaces.
    static OVERLAYS: RefCell<Vec<Overlay>> = const { RefCell::new(Vec::new()) };
    /// Numbers overlays, to find them again from deferred calls.
    static NEXT_SERIAL: Cell<u64> = const { Cell::new(1) };
}

// ---------------------------------------------------------------------------
// The environment

/// What this module knows of a surface's window.
struct Watched {
    key: u64,
    surface: Weak<Surface>,
    /// The window's appearance is dark, as last seen.
    system_dark: bool,
    /// The window the surface was last drawn in.
    window: Option<AnyWindowHandle>,
    /// The surface fills a window of its own ([`own_window`]).
    owns_window: bool,
    /// The appearance last given to the window (owned windows).
    forced: Option<Appearance>,
}

/// Runs `f` on the record of the surface with `key`, if it is watched.
fn with_watched<R>(key: u64, f: impl FnOnce(&mut Watched) -> R) -> Option<R> {
    WATCHED.with(|w| w.borrow_mut().iter_mut().find(|w| w.key == key).map(f))
}

/// What the system's settings say (besides the color scheme, which is the
/// window's).
#[derive(Debug, Clone, Copy, PartialEq)]
struct Settings {
    font_scale: f32,
    reduce_motion: bool,
    rtl: bool,
    screen_reader: bool,
    locale: Locale,
    os_version: (u16, u16),
}

/// Makes the system look dark (or light) from now on (`nsh test
/// --target`'s color scheme).
#[cfg(feature = "dev")]
pub(crate) fn simulate_system_scheme(dark: bool) {
    SIMULATED.with(|s| s.set(Some(dark)));
    let surfaces: Vec<Rc<Surface>> = WATCHED.with(|w| {
        let mut w = w.borrow_mut();
        w.retain(|w| w.surface.strong_count() > 0);
        w.iter_mut()
            .filter_map(|w| {
                w.system_dark = dark;
                w.surface.upgrade()
            })
            .collect()
    });
    for surface in surfaces {
        update(&surface);
        surface.invalidate();
    }
}

/// The desktop's settings changed (Linux's services): every surface
/// follows.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn settings_changed() {
    let surfaces: Vec<Rc<Surface>> = WATCHED.with(|w| {
        let mut w = w.borrow_mut();
        w.retain(|w| w.surface.strong_count() > 0);
        w.iter().filter_map(|w| w.surface.upgrade()).collect()
    });
    for surface in surfaces {
        update(&surface);
        // The accent may have changed without the environment.
        surface.invalidate();
    }
}

/// True when the window looks dark (or a test made the system look so).
fn window_dark(window: &Window) -> bool {
    if let Some(dark) = SIMULATED.with(Cell::get) {
        return dark;
    }
    matches!(
        window.appearance(),
        WindowAppearance::Dark | WindowAppearance::VibrantDark
    )
}

/// True when the surface draws in its dark appearance. The environment is
/// kept current by this module, so drawing never asks the system.
pub(crate) fn dark(surface: &Surface) -> bool {
    surface.environment.get().color_scheme == ColorScheme::Dark
}

/// The color behind the app's views (the default theme's background).
pub(crate) fn window_background(surface: &Surface) -> Color {
    if dark(surface) {
        Color(0x0a0a_0aff)
    } else {
        Color(0xffff_ffff)
    }
}

/// Reads the environment of `surface`, shown in `window`, and keeps it
/// current: the window's appearance changes are followed as they happen
/// (not only when the surface is drawn next).
pub(crate) fn watch_environment(
    surface: &Rc<Surface>,
    window: &mut Window,
    cx: &mut Context<AppView>,
) {
    WATCHED.with(|w| {
        let mut w = w.borrow_mut();
        w.retain(|w| w.surface.strong_count() > 0);
        w.push(Watched {
            key: surface.key(),
            surface: Rc::downgrade(surface),
            system_dark: window_dark(window),
            window: Some(window.window_handle()),
            owns_window: false,
            forced: None,
        });
    });
    cx.observe_window_appearance(window, |view, window, cx| {
        let surface = view.surface().clone();
        appearance_changed(&surface, window);
        crate::rt::flush(cx);
    })
    .detach();
    os::watch();
    update(surface);
}

/// The surface fills a window of its own (the standalone app): the app's
/// appearance is given to the window too.
pub(crate) fn own_window(surface: &Surface) {
    with_watched(surface.key(), |w| w.owns_window = true);
    surface.invalidate();
}

/// The window's appearance changed: the settings are read again.
fn appearance_changed(surface: &Rc<Surface>, window: &Window) {
    let dark = window_dark(window);
    with_watched(surface.key(), |w| w.system_dark = dark);
    update(surface);
    surface.invalidate();
}

/// The surface is about to be drawn in `window`: remembers the window,
/// catches an appearance change no observer reported, and gives an owned
/// window the app's appearance.
pub(crate) fn window_prepaint(surface: &Rc<Surface>, window: &mut Window, cx: &mut gpui::App) {
    let handle = window.window_handle();
    let dark = window_dark(window);
    let appearance = surface.appearance.get();
    let Some((changed, force)) = with_watched(surface.key(), |w| {
        w.window = Some(handle);
        let force = (w.owns_window && w.forced != Some(appearance)).then(|| {
            w.forced = Some(appearance);
            appearance
        });
        // A forced window's appearance is the app's, not the system's.
        let follows = !w.owns_window || appearance == Appearance::System;
        let changed = follows && std::mem::replace(&mut w.system_dark, dark) != dark;
        (changed, force)
    }) else {
        return;
    };
    if let Some(appearance) = force {
        cx.set_window_appearance(match appearance {
            Appearance::System => None,
            Appearance::Light => Some(WindowAppearance::Light),
            Appearance::Dark => Some(WindowAppearance::Dark),
        });
    }
    if changed {
        update(surface);
    }
}

/// The environment changed (from the system, the app or a test): the
/// root's background follows its scheme.
pub(crate) fn environment_applied(surface: &Surface) {
    surface.invalidate();
}

/// `MountItem::Appearance`: the app forces light or dark (or follows the
/// system again).
pub(crate) fn set_appearance(surface: &Rc<Surface>, appearance: Appearance) {
    if surface.appearance.replace(appearance) != appearance {
        update(surface);
        surface.invalidate();
    }
}

/// The embedding app set its appearance ([`crate::AppView::set_appearance`]),
/// locale or text size: the system's settings are read again, with the
/// host's over them.
pub(crate) fn host_appearance_changed(surface: &Surface) {
    update(surface);
    surface.invalidate();
}

/// Writes the system's settings and the surface's own values into its
/// environment.
fn update(surface: &Surface) {
    // An embedding app's appearance stands in for the system's.
    let system_dark = surface
        .host_dark
        .get()
        .unwrap_or_else(|| with_watched(surface.key(), |w| w.system_dark).unwrap_or(false));
    let settings = os::settings();
    let mut env: Environment = surface.environment.get();
    let system = if system_dark {
        ColorScheme::Dark
    } else {
        ColorScheme::Light
    };
    env.color_scheme = surface.appearance.get().resolve(system);
    env.locale = settings.locale;
    env.font_scale = settings.font_scale;
    env.reduce_motion = settings.reduce_motion;
    env.rtl = settings.rtl;
    env.screen_reader = settings.screen_reader;
    env.os_version = settings.os_version;
    env.safe_area = Edges::default();
    env.keyboard_height = Points(0.0);
    surface.set_environment(env);
}

/// The user's locale on POSIX systems: the first locale variable set that
/// applies to formats (`var`), else the first of `LANGUAGE`'s names that
/// is a locale; `en-US` when neither is (`C`, `POSIX`).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn posix_locale(var: impl Fn(&str) -> Option<String>) -> Locale {
    const VARS: [&str; 5] = ["LC_ALL", "LC_TIME", "LC_NUMERIC", "LC_MESSAGES", "LANG"];
    // As POSIX has it, the first variable set decides, even when it is `C`.
    if let Some(value) = VARS.iter().find_map(|v| var(v).filter(|s| !s.is_empty())) {
        return Locale::parse(&value).unwrap_or_default();
    }
    var("LANGUAGE")
        .unwrap_or_default()
        .split(':')
        .find_map(Locale::parse)
        .unwrap_or_default()
}

/// True when the language of locale `tag` (`ar-EG`, `he`) is written right
/// to left.
fn rtl_language(tag: &str) -> bool {
    const RTL: [&str; 12] = [
        "ar", "ckb", "dv", "fa", "he", "iw", "ks", "ps", "sd", "ug", "ur", "yi",
    ];
    let language = tag.split(['-', '_']).next().unwrap_or_default();
    RTL.iter().any(|l| language.eq_ignore_ascii_case(l))
}

/// Major and minor version of a dotted version (`6.9.3-arch1-1`,
/// `14.5`).
#[cfg_attr(windows, allow(dead_code))]
fn parse_version(release: &str) -> (u16, u16) {
    let mut parts = release
        .trim()
        .split(|c: char| !c.is_ascii_digit())
        .map(|p| p.parse::<u16>().unwrap_or(0));
    (parts.next().unwrap_or(0), parts.next().unwrap_or(0))
}

/// The text scale of Windows' `TextScaleFactor` (percent; unset means
/// 100). Values outside the range Settings offers are ignored.
#[cfg_attr(not(windows), allow(dead_code))]
fn text_scale(percent: Option<u32>) -> f32 {
    percent
        .filter(|p| (100..=225).contains(p))
        .map_or(1.0, |p| p as f32 / 100.0)
}

#[cfg(target_os = "linux")]
mod os {
    use std::cell::Cell;

    use nsh_core::Color;
    use zbus::{
        blocking::{Connection, Proxy},
        zvariant::{OwnedValue, Value},
    };

    use super::{Settings, parse_version, posix_locale, rtl_language};

    const PORTAL: &str = "org.freedesktop.portal.Desktop";
    const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
    const PORTAL_SETTINGS: &str = "org.freedesktop.portal.Settings";
    const APPEARANCE: &str = "org.freedesktop.appearance";
    const INTERFACE: &str = "org.gnome.desktop.interface";

    /// What the desktop's services report: the settings portal and AT-SPI.
    #[derive(Debug, Clone, Copy, PartialEq)]
    struct Desktop {
        font_scale: f32,
        reduce_motion: bool,
        screen_reader: bool,
        accent: Option<Color>,
    }

    thread_local! {
        /// The desktop's settings as last reported (main thread).
        static DESKTOP: Cell<Desktop> = const {
            Cell::new(Desktop {
                font_scale: 1.0,
                reduce_motion: false,
                screen_reader: false,
                accent: None,
            })
        };
        static WATCHING: Cell<bool> = const { Cell::new(false) };
    }

    /// A setting a service reported.
    #[derive(Debug, Clone, Copy, PartialEq)]
    enum Change {
        FontScale(f32),
        ReduceMotion(bool),
        ScreenReader(bool),
        Accent(Option<Color>),
    }

    /// The settings: the locale from the environment, the kernel's
    /// version, and what the desktop's services last reported.
    pub(super) fn settings() -> Settings {
        let locale = posix_locale(|v| std::env::var(v).ok());
        let desktop = DESKTOP.with(Cell::get);
        Settings {
            font_scale: desktop.font_scale,
            reduce_motion: desktop.reduce_motion,
            rtl: rtl_language(locale.as_str()),
            screen_reader: desktop.screen_reader,
            locale,
            os_version: os_version(),
        }
    }

    /// The desktop's accent color, if it has one.
    pub(super) fn accent() -> Option<Color> {
        DESKTOP.with(Cell::get).accent
    }

    /// Follows the desktop's settings (once per process): the settings
    /// portal's text scale, animations and accent, AT-SPI's screen reader.
    /// D-Bus is only talked to on background threads, which send what they
    /// read to the main thread; until they answer, the defaults hold.
    pub(super) fn watch() {
        if WATCHING.with(|w| w.replace(true)) {
            return;
        }
        let spawn = |name: &str, f: fn() -> zbus::Result<()>| {
            let name = name.to_owned();
            let _ = std::thread::Builder::new()
                .name(name.clone())
                .spawn(move || {
                    if let Err(err) = f() {
                        log::debug!("{name}: {err}");
                    }
                });
        };
        spawn("nsh-settings-portal", watch_portal);
        spawn("nsh-screen-reader", watch_screen_reader);
    }

    /// Hands changes to the main thread, which applies them to every
    /// surface.
    fn send(changes: Vec<Change>) {
        if changes.is_empty() {
            return;
        }
        crate::rt::invoke(move || {
            let mut d = DESKTOP.with(Cell::get);
            for change in changes {
                match change {
                    Change::FontScale(v) => d.font_scale = v,
                    Change::ReduceMotion(v) => d.reduce_motion = v,
                    Change::ScreenReader(v) => d.screen_reader = v,
                    Change::Accent(v) => d.accent = v,
                }
            }
            log::debug!("desktop settings: {d:?}");
            if DESKTOP.with(|c| c.replace(d)) != d {
                super::settings_changed();
            }
        });
    }

    fn watch_portal() -> zbus::Result<()> {
        let connection = Connection::session()?;
        let proxy = Proxy::new(&connection, PORTAL, PORTAL_PATH, PORTAL_SETTINGS)?;
        let read = |namespace: &str, key: &str| {
            proxy
                .call::<_, _, OwnedValue>("ReadOne", &(namespace, key))
                // Portals before version 2 only have the deprecated `Read`.
                .or_else(|_| proxy.call::<_, _, OwnedValue>("Read", &(namespace, key)))
                .ok()
                .and_then(|v| change(namespace, key, &v))
        };
        let initial = [
            (INTERFACE, "text-scaling-factor"),
            (INTERFACE, "enable-animations"),
            (APPEARANCE, "accent-color"),
        ];
        send(initial.iter().filter_map(|(n, k)| read(n, k)).collect());
        for message in proxy.receive_signal("SettingChanged")? {
            let Ok((namespace, key, value)) =
                message.body().deserialize::<(String, String, OwnedValue)>()
            else {
                continue;
            };
            send(change(&namespace, &key, &value).into_iter().collect());
        }
        Ok(())
    }

    fn watch_screen_reader() -> zbus::Result<()> {
        let connection = Connection::session()?;
        let proxy = Proxy::new(
            &connection,
            "org.a11y.Bus",
            "/org/a11y/bus",
            "org.a11y.Status",
        )?;
        if let Ok(on) = proxy.get_property::<bool>("ScreenReaderEnabled") {
            send(vec![Change::ScreenReader(on)]);
        }
        for changed in proxy.receive_property_changed::<bool>("ScreenReaderEnabled") {
            if let Ok(on) = changed.get() {
                send(vec![Change::ScreenReader(on)]);
            }
        }
        Ok(())
    }

    /// The change a portal setting makes, if it is one followed.
    fn change(namespace: &str, key: &str, value: &Value<'_>) -> Option<Change> {
        let value = unwrap(value);
        match (namespace, key, value) {
            (INTERFACE, "text-scaling-factor", Value::F64(v)) => {
                Some(Change::FontScale(font_scale(*v)))
            }
            (INTERFACE, "enable-animations", Value::Bool(on)) => Some(Change::ReduceMotion(!on)),
            (APPEARANCE, "accent-color", Value::Structure(s)) => {
                let rgb: Vec<f64> = s
                    .fields()
                    .iter()
                    .filter_map(|f| match unwrap(f) {
                        Value::F64(v) => Some(*v),
                        _ => None,
                    })
                    .collect();
                Some(Change::Accent(accent_color(&rgb)))
            }
            _ => None,
        }
    }

    /// The value inside variants (`Read` wraps it twice).
    fn unwrap<'a>(value: &'a Value<'a>) -> &'a Value<'a> {
        match value {
            Value::Value(inner) => unwrap(inner),
            other => other,
        }
    }

    /// GNOME's text scaling factor as a font scale (sane values only).
    pub(super) fn font_scale(factor: f64) -> f32 {
        if factor.is_finite() && (0.5..=3.0).contains(&factor) {
            factor as f32
        } else {
            1.0
        }
    }

    /// The portal's accent (red, green and blue from 0 to 1; out of range
    /// means unset).
    pub(super) fn accent_color(rgb: &[f64]) -> Option<Color> {
        let [r, g, b] = rgb else {
            return None;
        };
        let channel = |v: f64| (0.0..=1.0).contains(&v).then(|| (v * 255.0).round() as u8);
        Some(Color::rgba(channel(*r)?, channel(*g)?, channel(*b)?, 255))
    }

    fn os_version() -> (u16, u16) {
        thread_local! {
            static VERSION: (u16, u16) = parse_version(
                &std::fs::read_to_string("/proc/sys/kernel/osrelease").unwrap_or_default(),
            );
        }
        VERSION.with(|v| *v)
    }
}

#[cfg(windows)]
mod os {
    use std::ffi::c_void;

    use nsh_engine::Locale;

    use super::{Settings, rtl_language, text_scale};

    const SPI_GETSCREENREADER: u32 = 0x0046;
    const SPI_GETCLIENTAREAANIMATION: u32 = 0x1042;
    const RRF_RT_REG_DWORD: u32 = 0x0000_0010;
    /// `HKEY_CURRENT_USER`: a predefined handle, sign-extended.
    const HKEY_CURRENT_USER: isize = 0x8000_0001_u32 as i32 as isize;

    #[repr(C)]
    struct OsVersionInfoW {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        service_pack: [u16; 128],
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetUserDefaultLocaleName(name: *mut u16, len: i32) -> i32;
        fn GetUserDefaultUILanguage() -> u16;
        fn LCIDToLocaleName(lcid: u32, name: *mut u16, len: i32, flags: u32) -> i32;
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn SystemParametersInfoW(action: u32, param: u32, value: *mut c_void, winini: u32) -> i32;
    }

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn RegGetValueW(
            key: isize,
            subkey: *const u16,
            value: *const u16,
            flags: u32,
            kind: *mut u32,
            data: *mut c_void,
            size: *mut u32,
        ) -> i32;
    }

    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn RtlGetVersion(info: *mut OsVersionInfoW) -> i32;
    }

    /// The settings, as the Windows backend reads them.
    /// Settings are read when needed: nothing to follow.
    pub(super) fn watch() {}

    /// The system's accent color: not followed (dialogs use their own).
    pub(super) fn accent() -> Option<nsh_core::Color> {
        None
    }

    pub(super) fn settings() -> Settings {
        let locale = user_locale_name()
            .as_deref()
            .and_then(Locale::parse)
            .unwrap_or_default();
        Settings {
            font_scale: text_scale(reg_dword(
                "Software\\Microsoft\\Accessibility",
                "TextScaleFactor",
            )),
            // Animation effects off is Windows' reduce motion.
            reduce_motion: spi_bool(SPI_GETCLIENTAREAANIMATION) == Some(false),
            rtl: ui_language().is_some_and(|l| rtl_language(&l)),
            screen_reader: spi_bool(SPI_GETSCREENREADER) == Some(true),
            locale,
            os_version: os_version(),
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    /// A `REG_DWORD` value under `HKEY_CURRENT_USER`, if it is set.
    fn reg_dword(subkey: &str, value: &str) -> Option<u32> {
        let (subkey, value) = (wide(subkey), wide(value));
        let mut data: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        // SAFETY: null-terminated strings and a DWORD out value of the
        // size given.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_DWORD,
                std::ptr::null_mut(),
                (&mut data as *mut u32).cast(),
                &mut size,
            )
        };
        (status == 0).then_some(data)
    }

    /// A `BOOL` system parameter, if the system answers.
    fn spi_bool(action: u32) -> Option<bool> {
        let mut value: i32 = 0;
        // SAFETY: a BOOL out value, as these actions take.
        let ok = unsafe { SystemParametersInfoW(action, 0, (&mut value as *mut i32).cast(), 0) };
        (ok != 0).then_some(value != 0)
    }

    /// The user's regional format (`de-DE`), if the system has one.
    fn user_locale_name() -> Option<String> {
        let mut buf = [0u16; 85];
        // SAFETY: the buffer's length is passed with it.
        let len = unsafe { GetUserDefaultLocaleName(buf.as_mut_ptr(), buf.len() as i32) };
        // The length counts the terminating null.
        (len > 1).then(|| String::from_utf16_lossy(&buf[..len as usize - 1]))
    }

    /// The name of the UI language (`ar-SA`).
    fn ui_language() -> Option<String> {
        let mut buf = [0u16; 85];
        // SAFETY: plain calls; the buffer's length is passed with it.
        let len = unsafe {
            let lcid = u32::from(GetUserDefaultUILanguage());
            LCIDToLocaleName(lcid, buf.as_mut_ptr(), buf.len() as i32, 0)
        };
        (len > 1).then(|| String::from_utf16_lossy(&buf[..len as usize - 1]))
    }

    /// The OS version (major, minor), as `RtlGetVersion` has it: unlike
    /// `GetVersionEx` it does not depend on the executable's manifest.
    fn os_version() -> (u16, u16) {
        thread_local! {
            static VERSION: (u16, u16) = read_os_version();
        }
        VERSION.with(|v| *v)
    }

    fn read_os_version() -> (u16, u16) {
        let mut info = OsVersionInfoW {
            size: std::mem::size_of::<OsVersionInfoW>() as u32,
            major: 0,
            minor: 0,
            build: 0,
            platform: 0,
            service_pack: [0; 128],
        };
        // SAFETY: the structure's size is set, as the call requires.
        if unsafe { RtlGetVersion(&mut info) } != 0 {
            return (0, 0);
        }
        (
            info.major.min(u32::from(u16::MAX)) as u16,
            info.minor.min(u32::from(u16::MAX)) as u16,
        )
    }
}

#[cfg(target_os = "macos")]
mod os {
    use std::ffi::{CStr, c_char, c_void};

    use nsh_engine::Locale;

    use super::{Settings, parse_version, rtl_language};

    type CFTypeRef = *const c_void;
    const UTF8: u32 = 0x0800_0100;

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFLocaleCopyCurrent() -> CFTypeRef;
        fn CFLocaleGetIdentifier(locale: CFTypeRef) -> CFTypeRef;
        fn CFStringGetCString(s: CFTypeRef, buf: *mut c_char, size: isize, encoding: u32) -> u8;
        fn CFStringCreateWithCString(
            alloc: CFTypeRef,
            s: *const c_char,
            encoding: u32,
        ) -> CFTypeRef;
        fn CFPreferencesGetAppBooleanValue(key: CFTypeRef, app: CFTypeRef, valid: *mut u8) -> u8;
        fn CFRelease(cf: CFTypeRef);
    }

    unsafe extern "C" {
        fn sysctlbyname(
            name: *const c_char,
            old: *mut c_void,
            old_len: *mut usize,
            new: *mut c_void,
            new_len: usize,
        ) -> i32;
    }

    /// The settings, as the macOS backend reads them (VoiceOver and reduce
    /// motion from their preferences rather than `NSWorkspace`).
    /// Settings are read when needed: nothing to follow.
    pub(super) fn watch() {}

    /// The system's accent color: not followed (dialogs use their own).
    pub(super) fn accent() -> Option<nsh_core::Color> {
        None
    }

    pub(super) fn settings() -> Settings {
        let locale = current_locale();
        Settings {
            font_scale: 1.0,
            reduce_motion: universal_access(c"reduceMotion"),
            rtl: rtl_language(locale.as_str()),
            screen_reader: universal_access(c"voiceOverOnOffKey"),
            locale,
            os_version: os_version(),
        }
    }

    /// The user's region format (`en_US@rg=gbzzzz`), `Intl`'s default.
    fn current_locale() -> Locale {
        let mut buf = [0 as c_char; 128];
        // SAFETY: the locale is released after its identifier (owned by
        // it) is copied into the buffer, whose size is passed with it.
        let ok = unsafe {
            let locale = CFLocaleCopyCurrent();
            if locale.is_null() {
                return Locale::default();
            }
            let id = CFLocaleGetIdentifier(locale);
            let ok = !id.is_null()
                && CFStringGetCString(id, buf.as_mut_ptr(), buf.len() as isize, UTF8) != 0;
            CFRelease(locale);
            ok
        };
        if !ok {
            return Locale::default();
        }
        // SAFETY: `CFStringGetCString` wrote a null-terminated string.
        let id = unsafe { CStr::from_ptr(buf.as_ptr()) };
        Locale::parse(&id.to_string_lossy()).unwrap_or_default()
    }

    /// A boolean of `com.apple.universalaccess`; false when unset.
    fn universal_access(key: &CStr) -> bool {
        // SAFETY: strings made from valid C strings, released after use.
        unsafe {
            let app = CFStringCreateWithCString(
                std::ptr::null(),
                c"com.apple.universalaccess".as_ptr(),
                UTF8,
            );
            let key = CFStringCreateWithCString(std::ptr::null(), key.as_ptr(), UTF8);
            let value = !app.is_null()
                && !key.is_null()
                && CFPreferencesGetAppBooleanValue(key, app, std::ptr::null_mut()) != 0;
            if !app.is_null() {
                CFRelease(app);
            }
            if !key.is_null() {
                CFRelease(key);
            }
            value
        }
    }

    fn os_version() -> (u16, u16) {
        thread_local! {
            static VERSION: (u16, u16) = read_os_version();
        }
        VERSION.with(|v| *v)
    }

    /// `kern.osproductversion` (`14.5`).
    fn read_os_version() -> (u16, u16) {
        let mut buf = [0u8; 32];
        let mut len = buf.len();
        // SAFETY: a buffer whose length is passed with it; nothing is set.
        let status = unsafe {
            sysctlbyname(
                c"kern.osproductversion".as_ptr(),
                buf.as_mut_ptr().cast(),
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        if status != 0 {
            return (0, 0);
        }
        let text = String::from_utf8_lossy(&buf[..len.min(buf.len())]);
        parse_version(text.trim_end_matches('\0'))
    }
}

// ---------------------------------------------------------------------------
// Commands

/// A command not addressed to a kind of view.
pub(crate) fn command(surface: &Rc<Surface>, _id: NodeId, command: &Command) {
    match command {
        Command::Dialog(dialog) => show_dialog(surface, dialog),
        Command::SetClipboard(text) => {
            let text = text.clone();
            crate::rt::on_app(move |cx| {
                cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
            });
        }
        Command::ReadClipboard { id, has_only } => {
            let (id, has_only) = (*id, *has_only);
            surface.control(|control| {
                let control = control.clone();
                crate::rt::on_app(move |cx| {
                    let text = cx.read_from_clipboard().and_then(|item| item.text());
                    let has = text.is_some();
                    let text = if has_only { None } else { text };
                    control.dispatch_event(
                        ROOT_ID,
                        EventKind::Clipboard,
                        clipboard_answer(id, has, text),
                    );
                });
            });
        }
        Command::SetClipboardImage(uri) => set_clipboard_image(uri),
        Command::ReadClipboardImage { id, has_only } => surface.control(|control| {
            read_clipboard_image(control.clone(), *id, *has_only);
        }),
        Command::OpenUrl { id, url } => {
            let (id, url) = (*id, url.clone());
            surface.control(|control| {
                let control = control.clone();
                crate::rt::on_app(move |cx| {
                    // GPUI hands it to the system's opener (`NSWorkspace`,
                    // `ShellExecuteW`, the desktop portal / `xdg-open`) and
                    // reports nothing back: it went out.
                    cx.open_url(&url);
                    control.dispatch_event(
                        ROOT_ID,
                        EventKind::OpenUrl,
                        EventPayload::Map(vec![
                            ("id", PayloadValue::Number(id as f64)),
                            ("opened", PayloadValue::Bool(true)),
                        ]),
                    );
                });
            });
        }
        Command::ReadClipboardFiles { id } => {
            let id = *id;
            surface.control(|control| {
                let control = control.clone();
                crate::rt::on_app(move |cx| {
                    let files: Vec<String> = cx
                        .read_from_clipboard()
                        .into_iter()
                        .flat_map(|item| item.into_entries())
                        .filter_map(|entry| match entry {
                            gpui::ClipboardEntry::ExternalPaths(paths) => Some(paths),
                            _ => None,
                        })
                        .flat_map(|paths| paths.paths().to_vec())
                        .filter(|path| path.is_absolute())
                        .map(|path| clipboard::file_url(&path.to_string_lossy()))
                        .collect();
                    control.dispatch_event(
                        ROOT_ID,
                        EventKind::Clipboard,
                        clipboard::files_answer(id, &files),
                    );
                });
            });
        }
        Command::PickImages { id, request } => pick_images(surface, *id, *request),
        Command::ExitApp => {
            // The window goes after the batch is applied (closing it stops
            // the surface). An embedded surface closes the window it is in,
            // as the app leaving would.
            let window = with_watched(surface.key(), |w| w.window).flatten();
            if let Some(window) = window {
                crate::rt::on_app(move |cx| {
                    let _ = window.update(cx, |_, window, _| window.remove_window());
                });
            }
        }
        Command::Announce(text) => crate::access::announce(surface, text),
        // The status bar is a phone's; layout animations arrive as mount
        // items. `Back` and `Desktop` are routed by the mounter.
        Command::StatusBar(_) | Command::SetStatusBar(_) | Command::LayoutAnimation(_) => {}
        other => log::debug!("gpui: command {other:?} is not supported"),
    }
}

/// The answer to `Clipboard.readText` / `hasString` read `id`.
fn clipboard_answer(id: u32, has: bool, text: Option<String>) -> EventPayload {
    let mut fields = vec![
        ("id", PayloadValue::Number(id as f64)),
        ("has", PayloadValue::Bool(has)),
    ];
    if let Some(text) = text {
        fields.push(("text", PayloadValue::Str(text)));
    }
    EventPayload::Map(fields)
}

/// `Clipboard.writeImage`: the image of a `data:` URI on GPUI's clipboard,
/// in its own format when GPUI knows it.
/// `Picker.pickImages`: GPUI's open dialog. It filters nothing, so the
/// files whose extension the request does not take are left out; they are
/// read as they are, on a thread of their own (no scaling or conversion
/// here: `nsh_core::picker::read_files`).
fn pick_images(surface: &Rc<Surface>, id: u32, request: nsh_core::picker::PickRequest) {
    let mut control = None;
    surface.control(|c| control = Some(c.clone()));
    let Some(control) = control else { return };
    crate::rt::on_app(move |cx| {
        let paths = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: true,
            directories: false,
            multiple: request.multiple(),
            prompt: None,
        });
        cx.spawn(async move |_| {
            let paths = paths
                .await
                .ok()
                .and_then(Result::ok)
                .flatten()
                .unwrap_or_default();
            let extensions = nsh_core::picker::dialog_extensions(&request);
            let paths: Vec<_> = paths
                .into_iter()
                .filter(|p| {
                    p.extension()
                        .and_then(|e| e.to_str())
                        .is_some_and(|e| extensions.contains(&e.to_ascii_lowercase().as_str()))
                })
                .collect();
            std::thread::spawn(move || {
                let files = nsh_core::picker::read_files(&paths, &request);
                control.dispatch_event(
                    ROOT_ID,
                    EventKind::Pick,
                    EventPayload::Picked { id, files },
                );
            });
        })
        .detach();
    });
}

fn set_clipboard_image(uri: &str) {
    let Some((mime, bytes)) = clipboard::decode_data_uri(uri) else {
        log::warn!("Clipboard.writeImage: not a base64 data: URI");
        return;
    };
    let Some(format) = gpui::ImageFormat::from_mime_type(mime) else {
        log::warn!("Clipboard.writeImage: unsupported image type {mime}");
        return;
    };
    let image = gpui::Image::from_bytes(format, bytes);
    crate::rt::on_app(move |cx| cx.write_to_clipboard(gpui::ClipboardItem::new_image(&image)));
}

/// `Clipboard.readImage` / `hasImage`: answers read `id` from GPUI's
/// clipboard. Formats other than PNG, JPEG, GIF, BMP and WebP (a TIFF) are
/// converted to PNG on a worker thread, so every image source shows them.
fn read_clipboard_image(control: nsh_engine::EngineControl, id: u32, has_only: bool) {
    crate::rt::on_app(move |cx| {
        let image = cx
            .read_from_clipboard()
            .into_iter()
            .flat_map(|item| item.into_entries())
            .find_map(|entry| match entry {
                gpui::ClipboardEntry::Image(image) => Some(image),
                _ => None,
            });
        let answer = move |payload| {
            control.dispatch_event(ROOT_ID, EventKind::Clipboard, payload);
        };
        let image = match image {
            Some(image) if !has_only => image,
            other => return answer(clipboard::image_answer(id, other.is_some(), None)),
        };
        std::thread::spawn(move || {
            let png = match clipboard::Image::sniff(&image.bytes) {
                Some(_) => None,
                None => to_png(&image.bytes),
            };
            let bytes = png.as_deref().unwrap_or(&image.bytes);
            let payload = clipboard::image_answer(id, true, clipboard::Image::sniff(bytes));
            crate::rt::invoke(move || answer(payload));
        });
    });
}

/// `bytes` decoded and encoded again as PNG.
fn to_png(bytes: &[u8]) -> Option<Vec<u8>> {
    let decoded = image::load_from_memory(bytes)
        .map_err(|e| log::warn!("clipboard image: {e}"))
        .ok()?;
    let mut png = Vec::new();
    decoded
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| log::warn!("clipboard image: {e}"))
        .ok()?;
    Some(png)
}

/// The answer to dialog `id`: the button's index, -1 when dismissed.
fn dialog_answer(id: u32, index: i32) -> EventPayload {
    EventPayload::Map(vec![
        ("id", PayloadValue::Number(id as f64)),
        ("index", PayloadValue::Number(index as f64)),
    ])
}

// ---------------------------------------------------------------------------
// Overlays

/// A dialog over a surface.
struct Overlay {
    /// The surface's key.
    key: u64,
    serial: u64,
    kind: OverlayKind,
}

#[derive(Clone)]
enum OverlayKind {
    Dialog(Rc<DialogItem>),
}

impl OverlayKind {
    fn item(&self) -> Rc<dyn Hosted> {
        match self {
            OverlayKind::Dialog(d) => d.clone(),
        }
    }

    fn opacity(&self) -> &Cell<f32> {
        match self {
            OverlayKind::Dialog(d) => &d.opacity,
        }
    }
}

fn next_serial() -> u64 {
    NEXT_SERIAL.with(|n| n.replace(n.get() + 1))
}

/// The overlay `serial` (a clone of its kind).
fn find(serial: u64) -> Option<OverlayKind> {
    OVERLAYS.with(|o| {
        o.borrow()
            .iter()
            .find(|o| o.serial == serial)
            .map(|o| o.kind.clone())
    })
}

/// The overlays of `surface`.
fn overlays_of(surface: &Surface) -> Vec<OverlayKind> {
    OVERLAYS.with(|o| {
        o.borrow()
            .iter()
            .filter(|o| o.key == surface.key())
            .map(|o| o.kind.clone())
            .collect()
    })
}

/// The batch is applied: overlays stay over items hosted on the root
/// since (they are drawn in the order hosted).
pub(crate) fn end_batch(surface: &Surface) {
    let ours: Vec<Rc<dyn Hosted>> = overlays_of(surface).iter().map(|k| k.item()).collect();
    if ours.is_empty() {
        return;
    }
    let is_ours = |item: &Rc<dyn Hosted>| ours.iter().any(|o| Rc::ptr_eq(o, item));
    let mut state = surface.root.state_mut();
    let natives = &mut state.natives;
    let last_other = natives.iter().rposition(|n| !is_ours(&n.item));
    let first_ours = natives.iter().position(|n| is_ours(&n.item));
    if let (Some(last), Some(first)) = (last_other, first_ours)
        && last > first
    {
        // Stable: overlays keep their own order, after everything else.
        let (mut others, mut overlays): (Vec<_>, Vec<_>) =
            natives.drain(..).partition(|n| !is_ours(&n.item));
        others.append(&mut overlays);
        *natives = others;
        drop(state);
        surface.root.changed();
    }
}

/// The surface is `width` × `height`: overlays follow.
pub(crate) fn surface_resized(surface: &Surface, width: f32, height: f32) {
    for kind in overlays_of(surface) {
        surface
            .root
            .set_native(&kind.item(), rect(0.0, 0.0, width, height));
    }
}

/// The app stopped: its dialogs and requested appearance go too.
pub(crate) fn clear(surface: &Surface) {
    let removed: Vec<Overlay> = OVERLAYS.with(|o| {
        let mut o = o.borrow_mut();
        let (removed, kept) = std::mem::take(&mut *o)
            .into_iter()
            .partition(|o| o.key == surface.key());
        *o = kept;
        removed
    });
    for overlay in removed {
        surface.root.remove_native(&overlay.kind.item());
    }
    surface.appearance.set(surface.initial_appearance.get());
    update(surface);
    surface.invalidate();
}

/// Hosts a new overlay over all of `surface` and fades it in. Overlays
/// cover the whole surface and place their cards themselves, as they are
/// laid out while drawn (where GPUI's text system measures them).
fn add_overlay(surface: &Rc<Surface>, serial: u64, kind: OverlayKind) {
    let (width, height) = surface.size();
    surface
        .root
        .set_native(&kind.item(), rect(0.0, 0.0, width, height));
    OVERLAYS.with(|o| {
        o.borrow_mut().push(Overlay {
            key: surface.key(),
            serial,
            kind: kind.clone(),
        })
    });
    if surface.environment.get().reduce_motion {
        kind.opacity().set(1.0);
    } else {
        kind.opacity().set(0.0);
        fade(surface, serial, 1.0, FADE_IN, false);
    }
}

/// Fades overlay `serial` out, then removes it. No-op when it is gone.
fn remove_overlay(surface: &Rc<Surface>, serial: u64) {
    let Some(kind) = find(serial) else {
        return;
    };
    let OverlayKind::Dialog(d) = &kind;
    d.closing.set(true);
    if surface.environment.get().reduce_motion {
        drop_overlay(surface, serial);
    } else {
        fade(surface, serial, 0.0, FADE_OUT, true);
    }
}

/// Stops hosting overlay `serial` at once.
fn drop_overlay(surface: &Surface, serial: u64) {
    let removed = OVERLAYS.with(|o| {
        let mut o = o.borrow_mut();
        let i = o.iter().position(|o| o.serial == serial)?;
        Some(o.remove(i))
    });
    if let Some(overlay) = removed {
        surface.root.remove_native(&overlay.kind.item());
    }
}

/// Animates overlay `serial`'s opacity to `to` over `secs` (eased out) on
/// the surface's frames; removes it at the end when `remove`.
fn fade(surface: &Rc<Surface>, serial: u64, to: f32, secs: f64, remove: bool) {
    let Some(kind) = find(serial) else {
        return;
    };
    let from = kind.opacity().get();
    let mut start = None;
    surface.on_frame(move |surface, now| {
        let Some(kind) = find(serial) else {
            return false;
        };
        // A newer fade took over (a dialog answered while fading in).
        if !remove && matches!(&kind, OverlayKind::Dialog(d) if d.closing.get()) {
            return false;
        }
        let t0 = *start.get_or_insert(now);
        let t = ((now - t0) / secs).clamp(0.0, 1.0) as f32;
        let eased = 1.0 - (1.0 - t) * (1.0 - t);
        kind.opacity().set(from + (to - from) * eased);
        surface.root.changed();
        if t < 1.0 {
            return true;
        }
        if remove {
            drop_overlay(surface, serial);
        }
        false
    });
}

// ---------------------------------------------------------------------------
// Drawing helpers

/// One piece of text in the UI font, shaped by GPUI's text system when
/// measured or drawn (its line cache keeps the shaping between frames).
struct Label {
    text: SharedString,
    size: f32,
    weight: f32,
    align: TextAlign,
    /// Wraps at the width it is given (else one line).
    wrap: bool,
}

impl Label {
    fn new(text: &str, size: f32, weight: f32, align: TextAlign, wrap: bool) -> Label {
        Label {
            text: SharedString::from(text.to_owned()),
            size,
            weight,
            align,
            wrap,
        }
    }

    fn line_height(&self) -> f32 {
        (self.size * 1.33).round()
    }

    /// Its lines in `color`, wrapped at `width` (when it wraps).
    fn shape(&self, window: &Window, width: f32, color: Hsla) -> Vec<gpui::WrappedLine> {
        let mut font = gpui::font(SharedString::from(crate::text::ui_family().to_string()));
        font.weight = FontWeight(self.weight);
        let run = TextRun {
            len: self.text.len(),
            font,
            color,
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let wrap = (self.wrap && width.is_finite()).then(|| px(width.max(1.0)));
        window
            .text_system()
            .shape_text(self.text.clone(), px(self.size), &[run], wrap, None)
            .map(|lines| lines.into_iter().collect())
            .unwrap_or_default()
    }

    /// Its size when at most `max_width` wide (unbounded with
    /// `f32::INFINITY`): the width of its widest line and its height.
    fn measure(&self, window: &Window, max_width: f32) -> (f32, f32) {
        let lh = px(self.line_height());
        let (w, h) = self
            .shape(window, max_width, Hsla::default())
            .iter()
            .map(|l| l.size(lh))
            .fold((0.0_f32, 0.0_f32), |(w, h), s| {
                (w.max(f32::from(s.width)), h + f32::from(s.height))
            });
        (w.ceil(), h.ceil())
    }

    /// Draws it in the box `r` (current coordinates; alignment applies in
    /// its width), centered vertically when it is one unwrapped line.
    fn draw(&self, cx: &mut DrawCx<'_>, r: nsh_core::Bounds<Points>, color: Color) {
        if cx.culled() {
            return;
        }
        let lh = self.line_height();
        let lines = self.shape(cx.window, r.size.width.0, cx.color(color));
        let mut y = if self.wrap {
            r.origin.y.0
        } else {
            r.origin.y.0 + ((r.size.height.0 - lh) / 2.0).round()
        };
        let k = cx.transform_scale();
        for line in lines {
            let origin = cx.map(r.origin.x.0, y);
            let b = cx.rect(r.origin.x.0, y, r.size.width.0, lh);
            let height = f32::from(line.size(px(lh)).height);
            let align = self.align;
            cx.paint(|window, app| {
                let _ = line.paint(origin, px(lh * k), align, Some(b), window, app);
            });
            y += height;
        }
    }
}

fn fill_rounded(cx: &mut DrawCx<'_>, r: nsh_core::Bounds<Points>, radius: f32, color: Color) {
    cx.fill_rect(r, [radius; 4], color);
}

fn stroke_rounded(
    cx: &mut DrawCx<'_>,
    r: nsh_core::Bounds<Points>,
    radius: f32,
    color: Color,
    width: f32,
) {
    if color.0 & 0xff == 0 {
        return;
    }
    let k = cx.transform_scale();
    let quad = border_quad(
        cx.rect(r.origin.x.0, r.origin.y.0, r.size.width.0, r.size.height.0),
        corners([radius; 4], k),
        gpui::Edges::all(px(width * k)),
        cx.color(color),
        gpui::BorderStyle::Solid,
    );
    cx.paint_quad(quad);
}

/// A soft shadow under a card (GPUI's blurred drop shadow).
fn draw_shadow(cx: &mut DrawCx<'_>, r: nsh_core::Bounds<Points>, radius: f32, dy: f32, alpha: f32) {
    if cx.culled() {
        return;
    }
    let k = cx.transform_scale();
    let b = cx.rect(r.origin.x.0, r.origin.y.0, r.size.width.0, r.size.height.0);
    let shadow = gpui::BoxShadow {
        color: cx.color(with_alpha(Color::BLACK, alpha)),
        offset: gpui::point(px(0.0), px(dy * k)),
        blur_radius: px(2.0 * dy.max(4.0) * k),
        spread_radius: px(0.0),
        inset: false,
    };
    let radii = corners([radius; 4], k);
    cx.paint(|window, _| window.paint_drop_shadows(b, radii, &[shadow]));
}

fn with_alpha(c: Color, alpha: f32) -> Color {
    Color((c.0 & 0xffff_ff00) | (alpha.clamp(0.0, 1.0) * 255.0).round() as u32)
}

/// `c` mixed with `other` by `t` (0 is `c`).
fn mix(c: Color, other: Color, t: f32) -> Color {
    let ch = |v: u32, s: u32| ((v >> s) & 0xff) as f32;
    let part = |s: u32| {
        let v = ch(c.0, s) + (ch(other.0, s) - ch(c.0, s)) * t;
        (v.round().clamp(0.0, 255.0) as u32) << s
    };
    Color(part(24) | part(16) | part(8) | part(0))
}

/// The colors of dialogs in the light or dark theme (the Windows
/// backend's, with its default accent: GPUI exposes no system accent).
struct Palette {
    scrim: Color,
    card: Color,
    footer: Color,
    stroke: Color,
    text: Color,
    secondary: Color,
    button: Color,
    button_hover: Color,
    button_pressed: Color,
    button_stroke: Color,
    accent: Color,
    accent_text: Color,
    critical: Color,
    focus: Color,
    separator: Color,
    row_hover: Color,
}

impl Palette {
    fn new(dark: bool) -> Palette {
        let mut p = Palette::default_colors(dark);
        if let Some(accent) = os::accent() {
            (p.accent, p.accent_text) = accent_shades(accent, dark);
        }
        p
    }

    fn default_colors(dark: bool) -> Palette {
        if dark {
            Palette {
                scrim: Color(0x0000_0080),
                card: Color(0x2b2b_2bff),
                footer: Color(0x2020_20ff),
                stroke: Color(0x0000_0066),
                text: Color(0xffff_ffff),
                secondary: Color(0xc5c5_c5ff),
                button: Color(0x3737_37ff),
                button_hover: Color(0x3d3d_3dff),
                button_pressed: Color(0x3030_30ff),
                button_stroke: Color(0x4444_44ff),
                accent: Color(0x60cd_ffff),
                accent_text: Color(0x0000_00ff),
                critical: Color(0xd134_38ff),
                focus: Color(0xffff_ffff),
                separator: Color(0x3d3d_3dff),
                row_hover: Color(0xffff_ff0f),
            }
        } else {
            Palette {
                scrim: Color(0x0000_004d),
                card: Color(0xffff_ffff),
                footer: Color(0xf3f3_f3ff),
                stroke: Color(0x0000_0024),
                text: Color(0x1a1a_1aff),
                secondary: Color(0x5d5d_5dff),
                button: Color(0xfbfb_fbff),
                button_hover: Color(0xf6f6_f6ff),
                button_pressed: Color(0xf0f0_f0ff),
                button_stroke: Color(0xe0e0_e0ff),
                accent: Color(0x005f_b8ff),
                accent_text: Color(0xffff_ffff),
                critical: Color(0xc42b_1cff),
                focus: Color(0x0000_00e4),
                separator: Color(0xe5e5_e5ff),
                row_hover: Color(0x0000_000a),
            }
        }
    }
}

/// A button fill for the desktop's `accent` in the light or dark theme
/// (lightened on dark backgrounds, as Windows' accent shades are) and the
/// text on it.
fn accent_shades(accent: Color, dark: bool) -> (Color, Color) {
    let fill = if dark {
        mix(accent, Color(0xffff_ffff), 0.35)
    } else {
        accent
    };
    let (r, g, b, _) = fill.to_f64();
    let luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let text = if luminance > 0.55 {
        Color(0x0000_00ff)
    } else {
        Color(0xffff_ffff)
    };
    (fill, text)
}

// ---------------------------------------------------------------------------
// Dialog layout

/// Sizes of dialogs (points), after Windows 11's content dialog.
mod metrics {
    pub(super) const GUTTER: f32 = 16.0;
    pub(super) const PAD: f32 = 24.0;
    pub(super) const MIN_WIDTH: f32 = 320.0;
    pub(super) const MAX_WIDTH: f32 = 548.0;
    pub(super) const TITLE_GAP: f32 = 12.0;
    pub(super) const BUTTON_HEIGHT: f32 = 32.0;
    pub(super) const BUTTON_PAD: f32 = 12.0;
    pub(super) const BUTTON_GAP: f32 = 8.0;
    pub(super) const RADIUS: f32 = 8.0;
    pub(super) const BUTTON_RADIUS: f32 = 4.0;
    pub(super) const SHEET_MAX_WIDTH: f32 = 420.0;
    pub(super) const SHEET_ROW: f32 = 40.0;
    pub(super) const SHEET_INSET: f32 = 4.0;
    pub(super) const SHEET_TEXT_PAD: f32 = 12.0;
}

/// A part of a dialog that has text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Part {
    Title,
    Message,
    Button(usize),
}

/// Where a dialog's parts go (surface coordinates).
#[derive(Debug, Default, Clone, PartialEq)]
struct Geometry {
    /// The cards (an alert's one; a sheet's options and its cancel card).
    cards: Vec<nsh_core::Bounds<Points>>,
    /// An alert's footer (the buttons' band at the bottom of the card).
    footer: Option<nsh_core::Bounds<Points>>,
    /// A sheet's line between its text and its options.
    separator: Option<nsh_core::Bounds<Points>>,
    title: Option<nsh_core::Bounds<Points>>,
    message: Option<nsh_core::Bounds<Points>>,
    /// The buttons, by index.
    buttons: Vec<nsh_core::Bounds<Points>>,
    /// An alert's buttons are in one row (else a column).
    row: bool,
}

/// Lays out an alert in a surface of `view` size. `measure(part, width)`
/// gives the size of a part's text at most `width` wide (unbounded with
/// `f32::INFINITY`); `title` / `message` say which parts exist.
fn layout_alert(
    view: (f32, f32),
    title: bool,
    message: bool,
    buttons: usize,
    measure: &dyn Fn(Part, f32) -> (f32, f32),
) -> Geometry {
    use metrics::*;
    let available = (view.0 - 2.0 * GUTTER).max(0.0);
    let button_widths: Vec<f32> = (0..buttons)
        .map(|i| measure(Part::Button(i), f32::INFINITY).0 + 2.0 * BUTTON_PAD)
        .collect();
    let widest_button = button_widths.iter().copied().fold(0.0, f32::max);
    let n = buttons.max(1) as f32;
    let natural = [
        title.then(|| measure(Part::Title, f32::INFINITY).0),
        message.then(|| measure(Part::Message, f32::INFINITY).0),
        Some(widest_button * n + BUTTON_GAP * (n - 1.0)),
    ]
    .into_iter()
    .flatten()
    .fold(0.0, f32::max)
        + 2.0 * PAD;
    let width = natural.clamp(MIN_WIDTH, MAX_WIDTH).min(available);
    let inner = (width - 2.0 * PAD).max(0.0);
    // Buttons share the footer in equal columns while there are at most
    // three and every label fits its column.
    let column = (inner - BUTTON_GAP * (n - 1.0)) / n;
    let row = buttons <= 3 && button_widths.iter().all(|w| *w <= column);

    let title_h = if title {
        measure(Part::Title, inner).1
    } else {
        0.0
    };
    let message_h = if message {
        measure(Part::Message, inner).1
    } else {
        0.0
    };
    let gap = if title && message { TITLE_GAP } else { 0.0 };
    let body = PAD + title_h + gap + message_h + PAD;
    let buttons_h = if row {
        BUTTON_HEIGHT
    } else {
        n * BUTTON_HEIGHT + (n - 1.0) * BUTTON_GAP
    };
    let footer_h = PAD + buttons_h + PAD;
    let height = body + footer_h;
    let x = ((view.0 - width) / 2.0).round();
    let y = ((view.1 - height) / 2.0).round().max(0.0);
    let card = rect(x, y, width, height);
    let footer = rect(x, y + body, width, footer_h);
    let buttons = (0..buttons)
        .map(|i| {
            let i = i as f32;
            if row {
                rect(
                    x + PAD + i * (column + BUTTON_GAP),
                    footer.origin.y.0 + PAD,
                    column,
                    BUTTON_HEIGHT,
                )
            } else {
                rect(
                    x + PAD,
                    footer.origin.y.0 + PAD + i * (BUTTON_HEIGHT + BUTTON_GAP),
                    inner,
                    BUTTON_HEIGHT,
                )
            }
        })
        .collect();
    Geometry {
        cards: vec![card],
        footer: Some(footer),
        separator: None,
        title: title.then(|| rect(x + PAD, y + PAD, inner, title_h)),
        message: message.then(|| rect(x + PAD, y + PAD + title_h + gap, inner, message_h)),
        buttons,
        row,
    }
}

/// Lays out an action sheet at the bottom of a surface of `view` size: its
/// text and options in one card, the cancel button (`cancel`) in its own
/// below.
fn layout_sheet(
    view: (f32, f32),
    title: bool,
    message: bool,
    buttons: usize,
    cancel: Option<usize>,
    measure: &dyn Fn(Part, f32) -> (f32, f32),
) -> Geometry {
    use metrics::*;
    let width = (view.0 - 2.0 * BUTTON_GAP).clamp(0.0, SHEET_MAX_WIDTH);
    let x = ((view.0 - width) / 2.0).round();
    let text_w = (width - 2.0 * SHEET_TEXT_PAD).max(0.0);
    let title_h = if title {
        measure(Part::Title, text_w).1
    } else {
        0.0
    };
    let message_h = if message {
        measure(Part::Message, text_w).1
    } else {
        0.0
    };
    let has_text = title || message;
    let header = if has_text {
        SHEET_TEXT_PAD
            + title_h
            + if title && message { 4.0 } else { 0.0 }
            + message_h
            + SHEET_TEXT_PAD
    } else {
        0.0
    };
    let options = (0..buttons).filter(|i| Some(*i) != cancel).count();
    let has_options_card = has_text || options > 0;
    let options_h = if has_options_card {
        header
            + if has_text && options > 0 { 1.0 } else { 0.0 }
            + if options > 0 {
                2.0 * SHEET_INSET + options as f32 * SHEET_ROW
            } else {
                0.0
            }
    } else {
        0.0
    };
    let cancel_h = if cancel.is_some() {
        2.0 * SHEET_INSET + SHEET_ROW
    } else {
        0.0
    };
    let gap = if has_options_card && cancel.is_some() {
        BUTTON_GAP
    } else {
        0.0
    };
    let bottom = (view.1 - 2.0 * BUTTON_GAP).max(options_h + gap + cancel_h);
    let cancel_y = bottom - cancel_h;
    let options_y = cancel_y - gap - options_h;
    let mut cards = Vec::new();
    if has_options_card {
        cards.push(rect(x, options_y, width, options_h));
    }
    if cancel.is_some() {
        cards.push(rect(x, cancel_y, width, cancel_h));
    }
    let row_w = width - 2.0 * SHEET_INSET;
    let first_row =
        options_y + header + if has_text && options > 0 { 1.0 } else { 0.0 } + SHEET_INSET;
    let mut k = 0.0;
    let buttons = (0..buttons)
        .map(|i| {
            if Some(i) == cancel {
                rect(x + SHEET_INSET, cancel_y + SHEET_INSET, row_w, SHEET_ROW)
            } else {
                let r = rect(x + SHEET_INSET, first_row + k * SHEET_ROW, row_w, SHEET_ROW);
                k += 1.0;
                r
            }
        })
        .collect();
    let title_y = options_y + SHEET_TEXT_PAD;
    Geometry {
        cards,
        footer: None,
        separator: (has_text && options > 0).then(|| rect(x, options_y + header, width, 1.0)),
        title: title.then(|| rect(x + SHEET_TEXT_PAD, title_y, text_w, title_h)),
        message: message.then(|| {
            rect(
                x + SHEET_TEXT_PAD,
                title_y + title_h + if title { 4.0 } else { 0.0 },
                text_w,
                message_h,
            )
        }),
        buttons,
        row: false,
    }
}

/// The button Enter presses at first: the last regular button of an alert
/// (its default action), else the first.
fn default_button(styles: &[DialogButtonStyle], sheet: bool) -> Option<usize> {
    if styles.is_empty() {
        return None;
    }
    if sheet {
        return Some(0);
    }
    Some(
        (0..styles.len())
            .rev()
            .find(|i| styles[*i] == DialogButtonStyle::Default)
            .unwrap_or(0),
    )
}

/// The buttons in focus order: a sheet's options, then its cancel button
/// (as drawn); an alert's in order.
fn focus_order(count: usize, cancel: Option<usize>, sheet: bool) -> Vec<usize> {
    let mut order: Vec<usize> = (0..count)
        .filter(|i| !sheet || Some(*i) != cancel)
        .collect();
    if sheet && let Some(c) = cancel {
        order.push(c);
    }
    order
}

/// The button after (`step` 1) or before (-1) `current` in `order`,
/// wrapping around.
fn step_focus(order: &[usize], current: Option<usize>, step: isize) -> Option<usize> {
    let n = order.len() as isize;
    if n == 0 {
        return None;
    }
    let at = current.and_then(|c| order.iter().position(|i| *i == c));
    let next = match at {
        Some(at) => (at as isize + step).rem_euclid(n),
        None if step < 0 => n - 1,
        None => 0,
    };
    Some(order[next as usize])
}

// ---------------------------------------------------------------------------
// Dialogs

/// What a press on a dialog started on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Target {
    Button(usize),
    Card,
    Outside,
}

struct DialogTexts {
    title: Option<Label>,
    message: Option<Label>,
    buttons: Vec<Label>,
}

/// An alert or action sheet, hosted by the root over the whole surface
/// (it takes every pointer event: the dialog is modal).
struct DialogItem {
    key: u64,
    generation: u64,
    serial: u64,
    id: u32,
    sheet: bool,
    cancelable: bool,
    cancel: Option<usize>,
    /// The accent button (an alert's default action).
    default: Option<usize>,
    styles: Vec<DialogButtonStyle>,
    texts: DialogTexts,
    /// The geometry of the last frame and the size it was made for (made
    /// again when the surface's size changes).
    layout: RefCell<Option<((f32, f32), Geometry)>>,
    hover: Cell<Option<usize>>,
    pressed: Cell<Option<Target>>,
    focus: Cell<Option<usize>>,
    /// The focus was moved with the keyboard: its ring shows.
    keyboard: Cell<bool>,
    opacity: Cell<f32>,
    /// Answered: fading out, no more input.
    closing: Cell<bool>,
    /// The buttons' texts, in order.
    #[cfg_attr(not(feature = "dev"), allow(dead_code))]
    labels: Vec<String>,
}

impl DialogItem {
    fn geometry(&self, window: &Window, size: (f32, f32)) -> Geometry {
        if let Some((s, g)) = &*self.layout.borrow()
            && *s == size
        {
            return g.clone();
        }
        let t = &self.texts;
        let measure = |part: Part, width: f32| {
            let label = match part {
                Part::Title => t.title.as_ref(),
                Part::Message => t.message.as_ref(),
                Part::Button(i) => t.buttons.get(i),
            };
            label.map_or((0.0, 0.0), |l| l.measure(window, width))
        };
        let geometry = if self.sheet {
            layout_sheet(
                size,
                t.title.is_some(),
                t.message.is_some(),
                t.buttons.len(),
                self.cancel,
                &measure,
            )
        } else {
            layout_alert(
                size,
                t.title.is_some(),
                t.message.is_some(),
                t.buttons.len(),
                &measure,
            )
        };
        *self.layout.borrow_mut() = Some((size, geometry.clone()));
        geometry
    }

    fn target(&self, x: f32, y: f32) -> Target {
        let layout = self.layout.borrow();
        let Some((_, g)) = &*layout else {
            return Target::Outside;
        };
        let inside = |r: &nsh_core::Bounds<Points>| {
            x >= r.origin.x.0
                && y >= r.origin.y.0
                && x < r.origin.x.0 + r.size.width.0
                && y < r.origin.y.0 + r.size.height.0
        };
        if let Some(i) = g.buttons.iter().position(inside) {
            Target::Button(i)
        } else if g.cards.iter().any(inside) {
            Target::Card
        } else {
            Target::Outside
        }
    }

    fn invalidate(&self) {
        if let Some(surface) = Surface::by_key(self.key) {
            surface.root.changed();
        }
    }

    /// Answers with button `index` (-1: dismissed), once; after the
    /// current event, as answering removes the item.
    fn answer(&self, index: i32) {
        if self.closing.replace(true) {
            return;
        }
        let (key, generation, serial, id) = (self.key, self.generation, self.serial, self.id);
        crate::rt::invoke(move || {
            let Some(surface) =
                Surface::by_key(key).filter(|surface| surface.load_generation() == generation)
            else {
                return;
            };
            remove_overlay(&surface, serial);
            surface.event(ROOT_ID, EventKind::Dialog, dialog_answer(id, index));
        });
    }

    /// Escape: the cancel button, else dismissed when cancelable.
    fn escape(&self) {
        match self.cancel {
            Some(cancel) => self.answer(cancel as i32),
            None if self.cancelable => self.answer(-1),
            None => {}
        }
    }

    fn key(&self, event: &KeyEvent) {
        if !event.down || self.closing.get() {
            return;
        }
        let order = focus_order(self.styles.len(), self.cancel, self.sheet);
        let step = match event.vk {
            VK_TAB if event.modifiers.shift => -1,
            VK_TAB | VK_RIGHT | VK_DOWN => 1,
            VK_LEFT | VK_UP => -1,
            VK_RETURN | VK_SPACE => {
                if let Some(i) = self.focus.get() {
                    self.answer(i as i32);
                }
                return;
            }
            VK_ESCAPE => return self.escape(),
            _ => return,
        };
        self.focus.set(step_focus(&order, self.focus.get(), step));
        self.keyboard.set(true);
        self.invalidate();
    }
}

impl Hosted for DialogItem {
    fn draw(&self, cx: &mut DrawCx<'_>, size: (f32, f32)) {
        use metrics::*;
        let opacity = self.opacity.get();
        if opacity <= 0.0 {
            return;
        }
        let g = self.geometry(cx.window, size);
        let p = Palette::new(cx.dark);
        cx.push_opacity(opacity);
        cx.fill_rect(rect(0.0, 0.0, size.0, size.1), [0.0; 4], p.scrim);
        for card in &g.cards {
            draw_shadow(cx, *card, RADIUS, 8.0, if cx.dark { 0.6 } else { 0.25 });
            fill_rounded(cx, *card, RADIUS, p.card);
        }
        if let Some(footer) = g.footer {
            // The footer's band, its bottom corners the card's.
            cx.fill_rect(footer, [0.0, 0.0, RADIUS, RADIUS], p.footer);
        }
        for card in &g.cards {
            stroke_rounded(cx, *card, RADIUS, p.stroke, 1.0);
        }
        if let Some(sep) = g.separator {
            cx.fill_rect(sep, [0.0; 4], p.separator);
        }
        let t = &self.texts;
        let text_color = if self.sheet { p.secondary } else { p.text };
        if let (Some(l), Some(r)) = (&t.title, g.title) {
            l.draw(cx, r, text_color);
        }
        if let (Some(l), Some(r)) = (&t.message, g.message) {
            l.draw(cx, r, text_color);
        }
        let hover = self.hover.get();
        let pressed = match self.pressed.get() {
            Some(Target::Button(i)) => Some(i),
            _ => None,
        };
        for (i, (label, r)) in t.buttons.iter().zip(&g.buttons).enumerate() {
            let style = self.styles[i];
            let (is_hover, is_pressed) = (hover == Some(i), pressed == Some(i) && hover == Some(i));
            let text = if self.sheet {
                if is_hover || is_pressed {
                    let a = if is_pressed { 2.0 } else { 1.0 };
                    let c = p.row_hover;
                    fill_rounded(
                        cx,
                        *r,
                        BUTTON_RADIUS,
                        with_alpha(c, (c.0 & 0xff) as f32 / 255.0 * a),
                    );
                }
                match style {
                    DialogButtonStyle::Destructive => p.critical,
                    _ => p.text,
                }
            } else {
                let accent = Some(i) == self.default;
                let (fill, text) = match style {
                    DialogButtonStyle::Destructive => (p.critical, Color(0xffff_ffff)),
                    _ if accent => (p.accent, p.accent_text),
                    _ => (p.button, p.text),
                };
                let filled = accent || style == DialogButtonStyle::Destructive;
                let fill = match (filled, is_pressed, is_hover) {
                    (true, true, _) => mix(fill, p.card, 0.2),
                    (true, false, true) => mix(fill, p.card, 0.1),
                    (false, true, _) => p.button_pressed,
                    (false, false, true) => p.button_hover,
                    _ => fill,
                };
                fill_rounded(cx, *r, BUTTON_RADIUS, fill);
                if !filled {
                    stroke_rounded(cx, *r, BUTTON_RADIUS, p.button_stroke, 1.0);
                }
                if is_pressed && !filled {
                    p.secondary
                } else {
                    text
                }
            };
            let pad = if self.sheet {
                SHEET_TEXT_PAD
            } else {
                BUTTON_PAD
            };
            label.draw(
                cx,
                rect(
                    r.origin.x.0 + pad,
                    r.origin.y.0,
                    r.size.width.0 - 2.0 * pad,
                    r.size.height.0,
                ),
                text,
            );
            if self.keyboard.get() && self.focus.get() == Some(i) {
                let ring = rect(
                    r.origin.x.0 - 3.0,
                    r.origin.y.0 - 3.0,
                    r.size.width.0 + 6.0,
                    r.size.height.0 + 6.0,
                );
                stroke_rounded(cx, ring, BUTTON_RADIUS + 3.0, p.focus, 2.0);
            }
        }
        cx.pop();
    }

    fn hit(&self, _x: f32, _y: f32, _size: (f32, f32)) -> bool {
        // Modal: nothing behind it takes the pointer, until it is answered.
        !self.closing.get()
    }

    fn pointer(&self, event: &ItemPointer) -> bool {
        if self.closing.get() {
            return true;
        }
        let target = self.target(event.x, event.y);
        let over = match target {
            Target::Button(i) => Some(i),
            _ => None,
        };
        if self.hover.replace(over) != over {
            self.invalidate();
        }
        match event.kind {
            PointerKind::Down => {
                self.pressed.set(Some(target));
                // Pointer input hides the keyboard focus ring.
                if self.keyboard.replace(false) || over.is_some() {
                    self.invalidate();
                }
            }
            PointerKind::Up => {
                let pressed = self.pressed.take();
                match (pressed, target) {
                    (Some(Target::Button(a)), Target::Button(b)) if a == b => self.answer(a as i32),
                    (Some(Target::Outside), Target::Outside) if self.cancelable => self.answer(-1),
                    _ => {}
                }
                self.invalidate();
            }
            PointerKind::Cancel | PointerKind::Leave => {
                self.pressed.set(None);
                self.hover.set(None);
                self.invalidate();
            }
            PointerKind::Move => {}
        }
        true
    }

    fn cursor(&self, _x: f32, _y: f32) -> Option<Cursor> {
        Some(Cursor::Arrow)
    }
}

/// Shows `dialog` over the surface: a card in the middle (an alert) or at
/// the bottom (an action sheet) over a dimmed backdrop. Answers the
/// button's index; -1 when dismissed (a click outside or Escape, when
/// cancelable); Escape presses the cancel button when there is one.
fn show_dialog(surface: &Rc<Surface>, dialog: &Dialog) {
    // `AlertDialog` always brings the app's actions (it rejects none): no
    // label of NSH's own.
    let buttons = &dialog.buttons[..];
    let styles: Vec<DialogButtonStyle> = buttons.iter().map(|b| b.style).collect();
    let cancel = styles.iter().position(|s| *s == DialogButtonStyle::Cancel);
    let fs = surface.environment.get().font_scale;
    let sheet = dialog.sheet;
    let (title_size, title_weight, text_align) = if sheet {
        (13.0, 400.0, TextAlign::Center)
    } else {
        (20.0, 600.0, TextAlign::Left)
    };
    let texts = DialogTexts {
        title: dialog
            .title
            .as_deref()
            .map(|t| Label::new(t, title_size * fs, title_weight, text_align, true)),
        message: dialog.message.as_deref().map(|t| {
            Label::new(
                t,
                if sheet { 13.0 } else { 14.0 } * fs,
                400.0,
                text_align,
                true,
            )
        }),
        buttons: buttons
            .iter()
            .map(|b| {
                let weight = if sheet && b.style == DialogButtonStyle::Cancel {
                    600.0
                } else {
                    400.0
                };
                Label::new(&b.text, 14.0 * fs, weight, TextAlign::Center, false)
            })
            .collect(),
    };
    let default = default_button(&styles, sheet);
    let serial = next_serial();
    let item = Rc::new(DialogItem {
        key: surface.key(),
        generation: surface.load_generation(),
        serial,
        id: dialog.id,
        sheet,
        cancelable: dialog.cancelable,
        cancel,
        default: if sheet { None } else { default },
        styles,
        texts,
        layout: RefCell::new(None),
        hover: Cell::new(None),
        pressed: Cell::new(None),
        focus: Cell::new(default),
        keyboard: Cell::new(false),
        opacity: Cell::new(0.0),
        closing: Cell::new(false),
        labels: buttons.iter().map(|b| b.text.clone()).collect(),
    });
    add_overlay(surface, serial, OverlayKind::Dialog(item));
}

/// Where a user presses to answer the newest dialog on `surface` (root
/// points): the middle of its button titled `button`, or outside its card
/// to close it without one (`None`; only a dialog that can be closed so).
#[cfg(feature = "dev")]
pub(crate) fn dialog_point(
    surface: &Rc<Surface>,
    button: Option<&str>,
) -> Result<(f32, f32), String> {
    let dialog = OVERLAYS
        .with(|o| {
            o.borrow().iter().rev().find_map(|o| match &o.kind {
                OverlayKind::Dialog(d) if o.key == surface.key() && !d.closing.get() => {
                    Some(d.clone())
                }
                _ => None,
            })
        })
        .ok_or("no dialog is shown")?;
    let layout = dialog.layout.borrow();
    let (_, geometry) = layout.as_ref().ok_or("the dialog is not drawn yet")?;
    match button {
        Some(text) => {
            let index = dialog
                .labels
                .iter()
                .position(|l| l == text)
                .ok_or_else(|| format!("the dialog has no button {text:?}"))?;
            let r = geometry
                .buttons
                .get(index)
                .ok_or("the dialog's button is not laid out")?;
            Ok((
                r.origin.x.0 + r.size.width.0 / 2.0,
                r.origin.y.0 + r.size.height.0 / 2.0,
            ))
        }
        None if dialog.cancelable => Ok((1.0, 1.0)),
        None => Err("the dialog can only be answered with a button".into()),
    }
}

/// A system dialog owns keyboard focus independently of the app tree.
pub(crate) fn has_dialog(surface: &Surface) -> bool {
    OVERLAYS.with(|overlays| {
        overlays.borrow().iter().any(|overlay| {
            overlay.key == surface.key()
                && matches!(&overlay.kind, OverlayKind::Dialog(dialog) if !dialog.closing.get())
        })
    })
}

/// Keys while a dialog shows over the app (it is modal: every key goes to
/// it). Enter and Space press the focused button (the default action at
/// first), Escape cancels, Tab and the arrows move between the buttons.
/// True when handled.
pub(crate) fn key(surface: &Rc<Surface>, event: &KeyEvent) -> bool {
    let top = OVERLAYS.with(|o| {
        o.borrow().iter().rev().find_map(|o| match &o.kind {
            OverlayKind::Dialog(d) if o.key == surface.key() && !d.closing.get() => Some(d.clone()),
            _ => None,
        })
    });
    match top {
        Some(dialog) => {
            dialog.key(event);
            true
        }
        None => false,
    }
}

/// Puts `text` on the clipboard (soon: GPUI's app is not at hand). True
/// when it will be.
pub(crate) fn set_clipboard_text(text: &str) -> bool {
    let text = text.to_owned();
    crate::rt::on_app(move |cx| cx.write_to_clipboard(gpui::ClipboardItem::new_string(text)));
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posix_locales() {
        let vars = |set: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                set.iter()
                    .find(|(k, _)| *k == name)
                    .map(|(_, v)| (*v).to_owned())
            }
        };
        let tag = |l: Locale| l.as_str().to_owned();
        assert_eq!(tag(posix_locale(vars(&[("LANG", "de_DE.UTF-8")]))), "de-DE");
        // Formats win over the language of messages.
        assert_eq!(
            tag(posix_locale(vars(&[
                ("LANG", "en_US.UTF-8"),
                ("LC_TIME", "zh_CN.UTF-8")
            ]))),
            "zh-CN"
        );
        assert_eq!(
            tag(posix_locale(vars(&[
                ("LC_ALL", "pt_BR"),
                ("LANG", "en_US")
            ]))),
            "pt-BR"
        );
        // `C` is no locale; empty variables are unset.
        assert_eq!(
            tag(posix_locale(vars(&[
                ("LC_ALL", "C.UTF-8"),
                ("LANG", "fr_FR")
            ]))),
            "en-US"
        );
        assert_eq!(
            tag(posix_locale(vars(&[("LC_ALL", ""), ("LANG", "fr_FR")]))),
            "fr-FR"
        );
        // Nothing set: `LANGUAGE`'s first locale.
        assert_eq!(
            tag(posix_locale(vars(&[("LANGUAGE", "C:ja_JP.UTF-8:ja")]))),
            "ja-JP"
        );
        assert_eq!(tag(posix_locale(vars(&[]))), "en-US");
    }

    #[test]
    fn rtl_languages() {
        assert!(rtl_language("ar-EG"));
        assert!(rtl_language("he"));
        assert!(rtl_language("fa_IR"));
        assert!(!rtl_language("en-US"));
        assert!(!rtl_language("arn-CL"));
        assert!(!rtl_language(""));
    }

    #[test]
    fn accents() {
        assert_eq!(
            accent_shades(Color(0x3584_e4ff), false),
            (Color(0x3584_e4ff), Color(0xffff_ffff))
        );
        assert_eq!(
            accent_shades(Color(0xf6d3_2dff), false).1,
            Color(0x0000_00ff)
        );
        let (dark, _) = accent_shades(Color(0x3584_e4ff), true);
        assert!(dark.0 >> 24 > 0x35);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn desktop_values() {
        assert_eq!(os::font_scale(1.25), 1.25);
        assert_eq!(os::font_scale(0.0), 1.0);
        assert_eq!(os::font_scale(f64::NAN), 1.0);
        assert_eq!(os::accent_color(&[0.0, 0.5, 1.0]), Some(Color(0x0080_ffff)));
        // Out of range: no accent.
        assert_eq!(os::accent_color(&[-1.0, -1.0, -1.0]), None);
        assert_eq!(os::accent_color(&[0.5]), None);
    }

    #[test]
    fn versions() {
        assert_eq!(parse_version("7.2.5-3-omarchy\n"), (7, 2));
        assert_eq!(parse_version("14.5"), (14, 5));
        assert_eq!(parse_version("15"), (15, 0));
        assert_eq!(parse_version(""), (0, 0));
    }

    #[test]
    fn text_scales() {
        assert_eq!(text_scale(None), 1.0);
        assert_eq!(text_scale(Some(150)), 1.5);
        assert_eq!(text_scale(Some(0)), 1.0);
        assert_eq!(text_scale(Some(1000)), 1.0);
    }

    #[test]
    fn settings_are_read() {
        let s = os::settings();
        assert!(s.font_scale >= 1.0);
        assert!(!s.locale.as_str().is_empty());
    }

    /// Text 8 points per character, 20 points per line.
    fn measure(texts: &'static [&'static str]) -> impl Fn(Part, f32) -> (f32, f32) {
        move |part, width| {
            let text = match part {
                Part::Title => "Title",
                Part::Message => "A message that is quite long, long enough to wrap twice or more",
                Part::Button(i) => texts[i],
            };
            let natural = text.len() as f32 * 8.0;
            let lines = (natural / width).ceil().max(1.0);
            (natural.min(width), lines * 20.0)
        }
    }

    #[test]
    fn alert_layout() {
        let g = layout_alert((1000.0, 800.0), true, true, 2, &measure(&["Cancel", "OK"]));
        let card = g.cards[0];
        // As wide as the message, up to the maximum, centered.
        assert_eq!(card.size.width.0, metrics::MAX_WIDTH);
        assert_eq!(
            card.origin.x.0,
            ((1000.0 - card.size.width.0) / 2.0).round()
        );
        assert!(g.row);
        // Equal columns in the footer.
        assert_eq!(g.buttons[0].size.width.0, g.buttons[1].size.width.0);
        assert_eq!(g.buttons[0].origin.y.0, g.buttons[1].origin.y.0);
        assert_eq!(
            g.buttons[1].origin.x.0 + g.buttons[1].size.width.0,
            card.origin.x.0 + card.size.width.0 - metrics::PAD
        );
        let footer = g.footer.unwrap();
        assert_eq!(
            footer.origin.y.0 + footer.size.height.0,
            card.origin.y.0 + card.size.height.0
        );
        let message = g.message.unwrap();
        assert_eq!(message.size.width.0, card.size.width.0 - 2.0 * metrics::PAD);
        assert!(message.size.height.0 > 20.0);
        assert_eq!(
            message.origin.y.0,
            g.title.unwrap().origin.y.0 + 20.0 + metrics::TITLE_GAP
        );
    }

    #[test]
    fn alert_buttons_wrap() {
        let g = layout_alert(
            (1000.0, 800.0),
            true,
            false,
            4,
            &measure(&["A", "B", "C", "D"]),
        );
        assert!(!g.row);
        assert!(
            g.buttons
                .windows(2)
                .all(|b| b[1].origin.y.0 > b[0].origin.y.0 && b[1].origin.x.0 == b[0].origin.x.0)
        );
        let g = layout_alert(
            (360.0, 800.0),
            true,
            false,
            2,
            &measure(&["A rather long button label", "OK"]),
        );
        assert!(!g.row);
        assert_eq!(g.cards[0].size.width.0, 360.0 - 2.0 * metrics::GUTTER);
    }

    #[test]
    fn sheet_layout() {
        let g = layout_sheet(
            (1000.0, 800.0),
            true,
            false,
            3,
            Some(1),
            &measure(&["Copy", "Cancel", "Delete"]),
        );
        assert_eq!(g.cards.len(), 2);
        let (options, cancel) = (g.cards[0], g.cards[1]);
        assert_eq!(options.size.width.0, metrics::SHEET_MAX_WIDTH);
        assert_eq!(
            cancel.origin.y.0 + cancel.size.height.0,
            800.0 - 2.0 * metrics::BUTTON_GAP
        );
        assert_eq!(
            options.origin.y.0 + options.size.height.0 + metrics::BUTTON_GAP,
            cancel.origin.y.0
        );
        assert!(g.buttons[0].origin.y.0 < g.buttons[2].origin.y.0);
        assert!(g.buttons[1].origin.y.0 > cancel.origin.y.0);
        assert!(g.separator.is_some());
    }

    #[test]
    fn dialog_focus() {
        use DialogButtonStyle::*;
        assert_eq!(default_button(&[Cancel, Default, Default], false), Some(2));
        assert_eq!(default_button(&[Default, Destructive], false), Some(0));
        assert_eq!(default_button(&[Cancel, Destructive], false), Some(0));
        assert_eq!(default_button(&[], false), None);
        assert_eq!(focus_order(3, Some(0), true), vec![1, 2, 0]);
        assert_eq!(focus_order(3, Some(0), false), vec![0, 1, 2]);
        let order = [1, 2, 0];
        assert_eq!(step_focus(&order, Some(0), 1), Some(1));
        assert_eq!(step_focus(&order, Some(1), -1), Some(0));
        assert_eq!(step_focus(&order, None, -1), Some(0));
        assert_eq!(step_focus(&order, None, 1), Some(1));
        assert_eq!(step_focus(&[], None, 1), None);
    }

    #[test]
    fn answers() {
        let field = |p: &EventPayload, key: &str| match p {
            EventPayload::Map(fields) => fields
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| v.clone()),
            _ => None,
        };
        let a = dialog_answer(7, -1);
        assert_eq!(field(&a, "id"), Some(PayloadValue::Number(7.0)));
        assert_eq!(field(&a, "index"), Some(PayloadValue::Number(-1.0)));
        let c = clipboard_answer(3, true, Some("hi".into()));
        assert_eq!(field(&c, "has"), Some(PayloadValue::Bool(true)));
        assert_eq!(field(&c, "text"), Some(PayloadValue::Str("hi".into())));
        assert_eq!(field(&clipboard_answer(3, true, None), "text"), None);
    }

    #[test]
    fn colors() {
        assert_eq!(with_alpha(Color(0x1020_30ff), 0.0), Color(0x1020_3000));
        assert_eq!(
            mix(Color(0x0000_00ff), Color(0xffff_ffff), 0.5),
            Color(0x8080_80ff)
        );
    }
}
