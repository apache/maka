//! Surface-wide commands and the environment: dialogs, the clipboard,
//! exiting; the system's settings followed into
//! [`Environment`].
//!
//! Dialogs are drawn inside the surface, as items the root view
//! hosts over the app's views ([`Hosted`]), rather than as separate
//! windows (`MessageBox`, `TaskDialog`): they stay with the surface when it
//! is embedded in another app's window, never run a modal message loop of
//! their own (the engine and animations keep going), and look the same in
//! every host. They follow Windows 11's content dialogs: a rounded card
//! over a dimmed backdrop, the text above a footer of buttons, the default
//! action in the accent color. The root keeps them after its other hosted
//! items ([`end_batch`]), so nothing mounted later covers them.
//!
//! The environment follows, re-read on every `WM_SETTINGCHANGE` (and
//! theme, color and DWM colorization changes, [`settings_changed`]):
//! - the color scheme: the app's appearance (`nsh.json` `"appearance"`,
//!   `setColorScheme`; [`set_appearance`]) when it forces one, else
//!   `AppsUseLightTheme` (Settings > Personalization > Colors), live;
//! - the locale (`Intl`'s default): the user's regional format
//!   (`GetUserDefaultLocaleName`), what number and date formats follow on
//!   Windows. POSIX variables (`LANG`, `LC_*`) are not looked at: Windows
//!   programs do not, and shells like Git Bash set `LANG` regardless of
//!   the user's settings;
//! - the font scale: Settings > Accessibility > Text size
//!   (`TextScaleFactor`, 100 to 225 percent);
//! - reduce motion: Settings > Accessibility > Visual effects > Animation
//!   effects off (`SPI_GETCLIENTAREAANIMATION`);
//! - right to left: the reading direction of the UI language (what the
//!   shell's own layout follows);
//! - the screen reader: `SPI_GETSCREENREADER` (Narrator, NVDA and JAWS set
//!   it);
//! - the pixel ratio: the window's DPI over 96;
//! - the OS version: `RtlGetVersion`'s major and minor version (10.0 on
//!   Windows 10 and 11 alike: Windows 11 kept the version number).
//!
//! Safe area and keyboard height are zero: desktop windows have neither.
//!
//! The surface's scheme in turn drives the title bar (dark or light, DWM's
//! immersive dark mode) and the root's background (white / neutral-950,
//! the default theme's), as the root view has none of its own.
//!
//! The status bar has no desktop equivalent. The clipboard is Win32's
//! (`CF_UNICODETEXT`); reads are synchronous, so `Clipboard.readText` is
//! answered at once.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use nsh_core::{
    Bounds, Color, Command, Dialog, DialogButtonStyle, EventKind, EventPayload, NodeId,
    PayloadValue, Points, ROOT_ID,
    geometry::px,
    platform::{Appearance, clipboard},
};
use nsh_engine::{ColorScheme, Edges, Environment, Locale};
use windows::{
    Win32::{
        Foundation::{LPARAM, WPARAM},
        Globalization::{
            GetLocaleInfoEx, GetUserDefaultLocaleName, GetUserDefaultUILanguage, LCIDToLocaleName,
            LOCALE_IREADINGLAYOUT,
        },
        Graphics::{
            Direct2D::{D2D1_DRAW_TEXT_OPTIONS_ENABLE_COLOR_FONT, D2D1_ROUNDED_RECT},
            DirectWrite::{
                DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_WEIGHT,
                DWRITE_PARAGRAPH_ALIGNMENT_CENTER, DWRITE_TEXT_ALIGNMENT,
                DWRITE_TEXT_ALIGNMENT_CENTER, DWRITE_TEXT_ALIGNMENT_LEADING, DWRITE_TEXT_METRICS,
                DWRITE_WORD_WRAPPING_NO_WRAP, IDWriteTextLayout,
            },
        },
        System::{
            LibraryLoader::{GetModuleHandleW, GetProcAddress},
            Registry::{
                HKEY, HKEY_CURRENT_USER, RRF_RT_REG_BINARY, RRF_RT_REG_DWORD, RegGetValueW,
            },
            SystemInformation::OSVERSIONINFOW,
        },
        UI::{
            Shell::{SetCurrentProcessExplicitAppUserModelID, ShellExecuteW},
            WindowsAndMessaging::{
                GA_ROOT, GetAncestor, PostMessageW, SPI_GETCLIENTAREAANIMATION,
                SPI_GETSCREENREADER, SW_SHOWNORMAL, SYSTEM_PARAMETERS_INFO_ACTION,
                SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, SystemParametersInfoW, WM_CLOSE,
            },
        },
    },
    core::{BOOL, HSTRING, PCWSTR, s, w},
};

use crate::{
    geom::{Mat4, rect},
    input::{Cursor, KeyEvent, PointerKind},
    render::{DrawCx, rect_f},
    surface::Surface,
    view::{Hosted, ItemPointer},
};

/// Fades of overlays, in seconds.
const FADE_IN: f64 = 0.167;
const FADE_OUT: f64 = 0.12;

/// Virtual keys a dialog answers.
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
    /// The dialogs of this thread's surfaces.
    static OVERLAYS: RefCell<Vec<Overlay>> = const { RefCell::new(Vec::new()) };
    /// The accent colors of the system's palette (light and dark).
    static ACCENT: Cell<Option<(Color, Color)>> = const { Cell::new(None) };
    /// Numbers overlays, to find them again from deferred calls.
    static NEXT_SERIAL: Cell<u64> = const { Cell::new(1) };
}

// ---------------------------------------------------------------------------
// The environment

/// What the system's settings say.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Settings {
    dark: bool,
    font_scale: f32,
    reduce_motion: bool,
    rtl: bool,
    screen_reader: bool,
    locale: Locale,
}

/// Makes the system look dark (or light) from now on (`nsh test
/// --target`'s color scheme).
#[cfg(feature = "dev")]
pub(crate) fn simulate_system_scheme(dark: bool) {
    SIMULATED.with(|s| s.set(Some(dark)));
}

/// True when the system's apps use the dark theme (Settings >
/// Personalization > Colors).
pub(crate) fn system_dark() -> bool {
    if let Some(dark) = SIMULATED.with(Cell::get) {
        return dark;
    }
    reg_dword(
        HKEY_CURRENT_USER,
        w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"),
        w!("AppsUseLightTheme"),
    ) == Some(0)
}

/// True when the surface draws in its dark appearance. The environment is
/// kept current by this module, so drawing never reads the registry.
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

/// Reads the environment and keeps it current (the window calls
/// [`settings_changed`] when the system's settings change).
pub(crate) fn watch_environment(surface: &Rc<Surface>) {
    refresh_accent();
    update(surface, settings());
    environment_applied(surface);
}

/// A system setting changed (`WM_SETTINGCHANGE`, `WM_THEMECHANGED`,
/// `WM_SYSCOLORCHANGE`, `WM_DWMCOLORIZATIONCOLORCHANGED`).
pub(crate) fn settings_changed(surface: &Rc<Surface>) {
    refresh_accent();
    update(surface, settings());
    // The accent may have changed without the environment.
    surface.invalidate();
}

/// The environment changed (from the system, the app or a test): the
/// title bar and the root's background follow its scheme.
pub(crate) fn environment_applied(surface: &Surface) {
    let hwnd = surface.hwnd();
    if !hwnd.is_invalid() {
        crate::window::set_dark_title_bar(hwnd, dark(surface));
    }
    // Menus follow the scheme; the caption buttons are drawn again.
    crate::chrome::appearance_changed(surface);
}

/// `MountItem::Appearance`: the app forces light or dark (or follows the
/// system again).
pub(crate) fn set_appearance(surface: &Rc<Surface>, appearance: Appearance) {
    if surface.appearance.replace(appearance) != appearance {
        update(surface, settings());
    }
}

/// The taskbar groups the process's windows under `id`.
pub(crate) fn set_app_id(id: &str) {
    // SAFETY: a valid string.
    let _ = unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(id)) };
}

/// The system's settings now.
fn settings() -> Settings {
    Settings {
        dark: system_dark(),
        font_scale: text_scale(reg_dword(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Accessibility"),
            w!("TextScaleFactor"),
        )),
        // Animation effects off is Windows' reduce motion.
        reduce_motion: spi_bool(SPI_GETCLIENTAREAANIMATION) == Some(false),
        rtl: ui_language_rtl(),
        screen_reader: spi_bool(SPI_GETSCREENREADER) == Some(true),
        locale: user_locale(user_locale_name().as_deref()),
    }
}

/// The embedding app set its locale or text size
/// ([`crate::AppView::set_locale`]): the system's settings are read again,
/// with the host's over them.
pub(crate) fn host_environment_changed(surface: &Surface) {
    update(surface, settings());
}

/// Writes `settings` and the surface's own values into its environment.
fn update(surface: &Surface, settings: Settings) {
    let mut env: Environment = surface.environment.get();
    let system = if settings.dark {
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
    if !surface.hwnd().is_invalid() {
        env.pixel_ratio = surface.scale();
    }
    env.os_version = os_version();
    env.safe_area = Edges::default();
    env.keyboard_height = px(0.0);
    surface.set_environment(env);
}

/// A `REG_DWORD` value, if it is set.
fn reg_dword(key: HKEY, subkey: PCWSTR, value: PCWSTR) -> Option<u32> {
    let mut data: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    // SAFETY: a DWORD out value of the size given.
    let result = unsafe {
        RegGetValueW(
            key,
            subkey,
            value,
            RRF_RT_REG_DWORD,
            None,
            Some(&mut data as *mut u32 as *mut _),
            Some(&mut size),
        )
    };
    result.is_ok().then_some(data)
}

/// A `BOOL` system parameter, if the system answers.
fn spi_bool(action: SYSTEM_PARAMETERS_INFO_ACTION) -> Option<bool> {
    let mut value = BOOL(0);
    // SAFETY: a BOOL out value, as these actions take.
    unsafe {
        SystemParametersInfoW(
            action,
            0,
            Some(&mut value as *mut BOOL as *mut _),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    }
    .ok()
    .map(|()| value.as_bool())
}

/// The text scale of `TextScaleFactor` (percent; unset means 100). Values
/// outside the range Settings offers are ignored.
fn text_scale(percent: Option<u32>) -> f32 {
    percent
        .filter(|p| (100..=225).contains(p))
        .map_or(1.0, |p| p as f32 / 100.0)
}

/// The user's regional format (`de-DE`), if the system has one.
fn user_locale_name() -> Option<String> {
    let mut buf = [0u16; 85];
    // SAFETY: the buffer's length is passed with it.
    let len = unsafe { GetUserDefaultLocaleName(&mut buf) };
    // The length counts the terminating null.
    (len > 1).then(|| String::from_utf16_lossy(&buf[..len as usize - 1]))
}

/// The locale of a Windows locale name (`en-US`, `zh-Hans-CN`,
/// `de-DE_phoneb` with a sort order); `en-US` without one (the invariant
/// locale's name is empty).
fn user_locale(name: Option<&str>) -> Locale {
    name.and_then(Locale::parse).unwrap_or_default()
}

/// True when the UI language is written right to left.
fn ui_language_rtl() -> bool {
    let mut name = [0u16; 85];
    // SAFETY: plain calls; buffers with their lengths.
    unsafe {
        let lcid = u32::from(GetUserDefaultUILanguage());
        if LCIDToLocaleName(lcid, Some(&mut name), 0) == 0 {
            return false;
        }
        let mut layout = [0u16; 4];
        let len = GetLocaleInfoEx(
            PCWSTR(name.as_ptr()),
            LOCALE_IREADINGLAYOUT,
            Some(&mut layout),
        );
        reading_layout_rtl(&String::from_utf16_lossy(
            &layout[..(len.max(1) as usize - 1).min(layout.len())],
        ))
    }
}

/// `LOCALE_IREADINGLAYOUT`: 0 left to right, 1 right to left, 2 and 3
/// vertical (which lays out left to right here).
fn reading_layout_rtl(value: &str) -> bool {
    value.trim() == "1"
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
    type RtlGetVersion = unsafe extern "system" fn(*mut OSVERSIONINFOW) -> i32;
    // SAFETY: ntdll is loaded in every process; `RtlGetVersion` has the
    // signature above and fills the structure whose size is set.
    unsafe {
        let Ok(ntdll) = GetModuleHandleW(w!("ntdll.dll")) else {
            return (0, 0);
        };
        let Some(proc) = GetProcAddress(ntdll, s!("RtlGetVersion")) else {
            return (0, 0);
        };
        let get: RtlGetVersion = std::mem::transmute(proc);
        let mut info = OSVERSIONINFOW {
            dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
            ..Default::default()
        };
        if get(&mut info) != 0 {
            return (0, 0);
        }
        (
            info.dwMajorVersion.min(u16::MAX as u32) as u16,
            info.dwMinorVersion.min(u16::MAX as u32) as u16,
        )
    }
}

/// Reads the accent palette again (dialogs' default buttons).
fn refresh_accent() {
    ACCENT.with(|a| a.set(read_accent()));
}

/// The system's accent for light and dark backgrounds: the palette's
/// "dark 1" and "light 2" shades, which Windows 11's own accent buttons
/// use (Settings > Personalization > Colors > Accent color).
fn read_accent() -> Option<(Color, Color)> {
    let mut palette = [0u8; 32];
    let mut size = palette.len() as u32;
    // SAFETY: a binary out value of the size given.
    let result = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Accent"),
            w!("AccentPalette"),
            RRF_RT_REG_BINARY,
            None,
            Some(palette.as_mut_ptr() as *mut _),
            Some(&mut size),
        )
    };
    if result.is_err() || size < 24 {
        return None;
    }
    Some(accent_shades(&palette))
}

/// The light-theme and dark-theme accents of an `AccentPalette` (eight RGBX
/// colors: light 3, light 2, light 1, the accent, dark 1, dark 2, dark 3).
fn accent_shades(palette: &[u8]) -> (Color, Color) {
    let at = |i: usize| Color::rgba(palette[i * 4], palette[i * 4 + 1], palette[i * 4 + 2], 255);
    (at(4), at(1))
}

/// The accent a default button has in the light or dark theme.
fn accent(dark: bool) -> Color {
    let (light, dark_shade) = ACCENT
        .with(Cell::get)
        // Windows 11's default blue.
        .unwrap_or((Color(0x005f_b8ff), Color(0x60cd_ffff)));
    if dark { dark_shade } else { light }
}

// ---------------------------------------------------------------------------
// Commands

/// Opens `url` with the app registered for its scheme (`ShellExecuteW`'s
/// `open`): whether one took it. The URL passed `nsh_core::open_url`'s
/// check, so it names no file or program to run.
pub(crate) fn open_url(url: &str) -> bool {
    // SAFETY: plain call with valid NUL-terminated strings.
    let instance = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            &HSTRING::from(url),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // Above 32 is success; the rest are error codes.
    instance.0 as isize > 32
}

/// A command not addressed to a kind of view.
pub(crate) fn command(surface: &Rc<Surface>, _id: NodeId, command: &Command) {
    match command {
        Command::Dialog(dialog) => show_dialog(surface, dialog),
        Command::SetClipboard(text) => {
            if !set_clipboard_text(text) {
                log::debug!("windows: cannot set the clipboard");
            }
        }
        Command::ReadClipboard { id, has_only } => {
            let has = clipboard_has_text();
            let text = if has && !*has_only {
                clipboard_text()
            } else {
                None
            };
            surface.event(
                ROOT_ID,
                EventKind::Clipboard,
                clipboard_answer(*id, has, text),
            );
        }
        Command::SetClipboardImage(uri) => match clipboard::decode_data_uri(uri) {
            Some(("image/png", bytes)) => {
                if !set_clipboard_bytes(png_format(), &bytes) {
                    log::debug!("windows: cannot set the clipboard");
                }
            }
            _ => log::warn!("Clipboard.writeImage: Windows takes a base64 PNG data: URI"),
        },
        Command::ReadClipboardImage { id, has_only } => {
            let has = clipboard_has_image();
            let bytes = (has && !*has_only).then(clipboard_image).flatten();
            let image = bytes.as_deref().and_then(clipboard::Image::sniff);
            surface.event(
                ROOT_ID,
                EventKind::Clipboard,
                clipboard::image_answer(*id, has, image),
            );
        }
        Command::ReadClipboardFiles { id } => surface.event(
            ROOT_ID,
            EventKind::Clipboard,
            clipboard::files_answer(*id, &clipboard_files()),
        ),
        Command::PickImages { id, request } => crate::picker::pick_images(surface, *id, *request),
        Command::OpenUrl { id, url } => {
            let opened = open_url(url);
            surface.event(
                ROOT_ID,
                EventKind::OpenUrl,
                EventPayload::Map(vec![
                    ("id", PayloadValue::Number(*id as f64)),
                    ("opened", PayloadValue::Bool(opened)),
                ]),
            );
        }
        Command::Back => crate::navigation::default_back(surface),
        Command::ExitApp => {
            // Closing destroys the window, whose handler stops the surface:
            // not while the surface is applying this batch, so the message
            // is posted. An embedded surface closes its top-level window,
            // as the app leaving would.
            let hwnd = surface.hwnd();
            if !hwnd.is_invalid() {
                // SAFETY: plain calls on a live window handle.
                unsafe {
                    let top = GetAncestor(hwnd, GA_ROOT);
                    let top = if top.is_invalid() { hwnd } else { top };
                    let _ = PostMessageW(Some(top), WM_CLOSE, WPARAM(0), LPARAM(0));
                }
            }
        }
        Command::Announce(text) => crate::access::announce(surface, text),
        Command::Desktop(command) => crate::chrome::command(surface, command),
        // The status bar is a phone's; layout animations arrive as mount
        // items.
        Command::StatusBar(_) | Command::SetStatusBar(_) | Command::LayoutAnimation(_) => {}
        other => log::debug!("windows: command {other:?} is not supported"),
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
fn find(serial: u64) -> Option<(u64, OverlayKind)> {
    OVERLAYS.with(|o| {
        o.borrow()
            .iter()
            .find(|o| o.serial == serial)
            .map(|o| (o.key, o.kind.clone()))
    })
}

/// The batch is applied: overlays stay over items hosted on the root
/// since (they are drawn in the order hosted).
pub(crate) fn end_batch(surface: &Surface) {
    let ours: Vec<Rc<dyn Hosted>> = OVERLAYS.with(|o| {
        o.borrow()
            .iter()
            .filter(|o| o.key == surface.key())
            .map(|o| o.kind.item())
            .collect()
    });
    if ours.is_empty() {
        return;
    }
    let mut state = surface.root.state_mut();
    let natives = &mut state.natives;
    let n = natives.len();
    let last = natives
        .iter()
        .rposition(|n| !ours.iter().any(|o| Rc::ptr_eq(o, &n.item)));
    let first_ours = natives
        .iter()
        .position(|n| ours.iter().any(|o| Rc::ptr_eq(o, &n.item)));
    if let (Some(last), Some(first)) = (last, first_ours)
        && last > first
    {
        // Stable: overlays keep their own order, after everything else.
        let (mut others, mut overlays): (Vec<_>, Vec<_>) = natives
            .drain(..)
            .partition(|n| !ours.iter().any(|o| Rc::ptr_eq(o, &n.item)));
        others.append(&mut overlays);
        *natives = others;
        debug_assert_eq!(natives.len(), n);
        drop(state);
        surface.root.changed();
    }
}

/// The surface is `width` × `height`: overlays follow.
pub(crate) fn surface_resized(surface: &Surface, width: f32, height: f32) {
    let ours: Vec<OverlayKind> = OVERLAYS.with(|o| {
        o.borrow()
            .iter()
            .filter(|o| o.key == surface.key())
            .map(|o| o.kind.clone())
            .collect()
    });
    for kind in ours {
        place(surface, &kind, width, height);
    }
}

/// The app stopped: its dialogs go too.
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
}

/// Hosts the overlay where it goes in a `width` × `height` surface.
fn place(surface: &Surface, kind: &OverlayKind, width: f32, height: f32) {
    let r = match kind {
        OverlayKind::Dialog(_) => rect(0.0, 0.0, width, height),
    };
    surface.root.set_native(&kind.item(), r);
}

/// Hosts a new overlay over `surface`'s views and fades it in.
fn add_overlay(surface: &Rc<Surface>, serial: u64, kind: OverlayKind) {
    if matches!(kind, OverlayKind::Dialog(_)) {
        // Its keys (Return, Escape) are the window's, not a page's.
        crate::native::take_keyboard(surface);
    }
    let env = surface.environment.get();
    place(surface, &kind, env.window.width.0, env.window.height.0);
    OVERLAYS.with(|o| {
        o.borrow_mut().push(Overlay {
            key: surface.key(),
            serial,
            kind: kind.clone(),
        })
    });
    if env.reduce_motion {
        kind.opacity().set(1.0);
    } else {
        kind.opacity().set(0.0);
        fade(surface, serial, 1.0, FADE_IN, false);
    }
}

/// Fades overlay `serial` out, then removes it. No-op when it is gone.
fn remove_overlay(surface: &Rc<Surface>, serial: u64) {
    let Some((_, kind)) = find(serial) else {
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
    let Some((_, kind)) = find(serial) else {
        return;
    };
    let from = kind.opacity().get();
    let mut start = None;
    surface.on_frame(move |surface, now| {
        let Some((_, kind)) = find(serial) else {
            return false;
        };
        let t0 = *start.get_or_insert(now);
        let t = ((now - t0) / secs).clamp(0.0, 1.0) as f32;
        let eased = 1.0 - (1.0 - t) * (1.0 - t);
        kind.opacity().set(from + (to - from) * eased);
        surface.root.changed();
        if t < 1.0 {
            // A newer fade took over (a dialog answered while fading in).
            return !matches!(&kind, OverlayKind::Dialog(d) if d.closing.get() && !remove);
        }
        if remove {
            drop_overlay(surface, serial);
        }
        false
    });
}

// ---------------------------------------------------------------------------
// Drawing helpers

/// One piece of text laid out by DirectWrite.
struct Label {
    layout: IDWriteTextLayout,
}

impl Label {
    /// `text` in the UI font at `size` points and `weight`, wrapped at
    /// `max_width` (or on one line when `wrap` is false).
    fn new(
        text: &str,
        size: f32,
        weight: i32,
        align: DWRITE_TEXT_ALIGNMENT,
        wrap: bool,
    ) -> Option<Label> {
        let factory = crate::gfx::dwrite();
        let family = HSTRING::from(&*crate::text::ui_family());
        let units: Vec<u16> = text.encode_utf16().collect();
        // SAFETY: COM calls with valid strings.
        unsafe {
            let format = factory
                .CreateTextFormat(
                    &family,
                    None,
                    DWRITE_FONT_WEIGHT(weight),
                    DWRITE_FONT_STYLE_NORMAL,
                    DWRITE_FONT_STRETCH_NORMAL,
                    size,
                    &HSTRING::new(),
                )
                .ok()?;
            let _ = format.SetTextAlignment(align);
            if !wrap {
                let _ = format.SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
                let _ = format.SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER);
            }
            let layout = factory
                .CreateTextLayout(&units, &format, 100_000.0, 100_000.0)
                .ok()?;
            Some(Label { layout })
        }
    }

    /// Its size when at most `max_width` wide: the width of its widest
    /// line and its height.
    fn measure(&self, max_width: f32) -> (f32, f32) {
        let mut m = DWRITE_TEXT_METRICS::default();
        // SAFETY: COM calls; a local out value.
        unsafe {
            let _ = self.layout.SetMaxWidth(max_width.max(1.0));
            let _ = self.layout.GetMetrics(&mut m);
        }
        (m.width.ceil(), m.height.ceil())
    }

    /// Lays it out in a box `w` × `h` (alignment applies inside it).
    fn fit(&self, w: f32, h: f32) {
        // SAFETY: COM calls on a live layout.
        unsafe {
            let _ = self.layout.SetMaxWidth(w.max(1.0));
            let _ = self.layout.SetMaxHeight(h.max(1.0));
        }
    }

    fn draw(&self, cx: &DrawCx<'_>, x: f32, y: f32, color: Color) {
        // SAFETY: a COM call between BeginDraw and EndDraw.
        unsafe {
            cx.dc.DrawTextLayout(
                windows_numerics::Vector2 { X: x, Y: y },
                &self.layout,
                cx.solid(color),
                D2D1_DRAW_TEXT_OPTIONS_ENABLE_COLOR_FONT,
            );
        }
    }
}

fn rounded(r: Bounds<Points>, radius: f32) -> D2D1_ROUNDED_RECT {
    D2D1_ROUNDED_RECT {
        rect: rect_f(r.origin.x.0, r.origin.y.0, r.size.width.0, r.size.height.0),
        radiusX: radius,
        radiusY: radius,
    }
}

fn fill_rounded(cx: &DrawCx<'_>, r: Bounds<Points>, radius: f32, color: Color) {
    // SAFETY: a COM call between BeginDraw and EndDraw.
    unsafe {
        cx.dc
            .FillRoundedRectangle(&rounded(r, radius), cx.solid(color))
    };
}

fn stroke_rounded(cx: &DrawCx<'_>, r: Bounds<Points>, radius: f32, color: Color, width: f32) {
    let i = width / 2.0;
    let r = rect(
        r.origin.x.0 + i,
        r.origin.y.0 + i,
        r.size.width.0 - width,
        r.size.height.0 - width,
    );
    // SAFETY: a COM call between BeginDraw and EndDraw.
    unsafe {
        cx.dc.DrawRoundedRectangle(
            &rounded(r, (radius - i).max(0.0)),
            cx.solid(color),
            width,
            None,
        )
    };
}

/// A soft shadow under a card: rounded rectangles growing outward with
/// falling opacity (Direct2D's blur would need an offscreen target in the
/// middle of the pass).
fn draw_shadow(cx: &DrawCx<'_>, r: Bounds<Points>, radius: f32, dy: f32, alpha: f32) {
    const STEPS: usize = 14;
    for i in (0..STEPS).rev() {
        let grow = (i + 1) as f32 * 2.0;
        let a = alpha * (1.0 - i as f32 / STEPS as f32).powi(2) / STEPS as f32 * 2.5;
        let shadow = rect(
            r.origin.x.0 - grow,
            r.origin.y.0 - grow + dy,
            r.size.width.0 + 2.0 * grow,
            r.size.height.0 + 2.0 * grow,
        );
        fill_rounded(cx, shadow, radius + grow, with_alpha(Color::BLACK, a));
    }
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

/// Windows 11's colors for dialogs in the light or dark theme.
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
                accent: accent(true),
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
                accent: accent(false),
                accent_text: Color(0xffff_ffff),
                critical: Color(0xc42b_1cff),
                focus: Color(0x0000_00e4),
                separator: Color(0xe5e5_e5ff),
                row_hover: Color(0x0000_000a),
            }
        }
    }
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
    cards: Vec<Bounds<Points>>,
    /// An alert's footer (the buttons' band at the bottom of the card).
    footer: Option<Bounds<Points>>,
    /// A sheet's line between its text and its options.
    separator: Option<Bounds<Points>>,
    title: Option<Bounds<Points>>,
    message: Option<Bounds<Points>>,
    /// The buttons, by index.
    buttons: Vec<Bounds<Points>>,
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
    // Buttons share the footer in equal columns (as Windows' do) while
    // there are at most three and every label fits its column.
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

/// A dialog's laid-out state, made again when the surface's size or text
/// scale changes.
struct DialogLayout {
    size: (f32, f32),
    geometry: Geometry,
}

/// An alert or action sheet, hosted by the root over the whole surface
/// (it takes every pointer event: the dialog is modal).
struct DialogItem {
    key: u64,
    serial: u64,
    id: u32,
    sheet: bool,
    cancelable: bool,
    cancel: Option<usize>,
    /// The accent button (an alert's default action).
    default: Option<usize>,
    styles: Vec<DialogButtonStyle>,
    texts: DialogTexts,
    layout: RefCell<Option<DialogLayout>>,
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
    fn geometry(&self, size: (f32, f32)) -> Geometry {
        let mut layout = self.layout.borrow_mut();
        if let Some(l) = &*layout
            && l.size == size
        {
            return l.geometry.clone();
        }
        let t = &self.texts;
        let measure = |part: Part, width: f32| {
            let label = match part {
                Part::Title => t.title.as_ref(),
                Part::Message => t.message.as_ref(),
                Part::Button(i) => t.buttons.get(i),
            };
            label.map_or((0.0, 0.0), |l| l.measure(width))
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
        if let (Some(l), Some(r)) = (&t.title, geometry.title) {
            l.fit(r.size.width.0, r.size.height.0);
        }
        if let (Some(l), Some(r)) = (&t.message, geometry.message) {
            l.fit(r.size.width.0, r.size.height.0);
        }
        for (l, r) in t.buttons.iter().zip(&geometry.buttons) {
            let pad = if self.sheet {
                metrics::SHEET_TEXT_PAD
            } else {
                metrics::BUTTON_PAD
            };
            l.fit(r.size.width.0 - 2.0 * pad, r.size.height.0);
        }
        *layout = Some(DialogLayout {
            size,
            geometry: geometry.clone(),
        });
        geometry
    }

    fn target(&self, x: f32, y: f32) -> Target {
        let Some(g) = self.layout.borrow().as_ref().map(|l| l.geometry.clone()) else {
            return Target::Outside;
        };
        let inside = |r: &Bounds<Points>| {
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
        let (key, serial, id) = (self.key, self.serial, self.id);
        crate::window::invoke(move || {
            let Some(surface) = Surface::by_key(key) else {
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
        let g = self.geometry(size);
        let p = Palette::new(cx.dark);
        if opacity < 1.0 {
            cx.push_opacity(opacity);
        }
        // SAFETY: a COM call between BeginDraw and EndDraw.
        unsafe {
            cx.dc
                .FillRectangle(&rect_f(0.0, 0.0, size.0, size.1), cx.solid(p.scrim))
        };
        // Opening and closing scale the cards a little around their middle.
        let world = cx.transform;
        if opacity < 1.0
            && let Some(first) = g.cards.first()
        {
            let last = g.cards.last().unwrap_or(first);
            let (mx, my) = (
                first.origin.x.0 + first.size.width.0 / 2.0,
                (first.origin.y.0 + last.origin.y.0 + last.size.height.0) / 2.0,
            );
            let s = 1.0 + 0.04 * (1.0 - opacity);
            cx.set_transform(
                Mat4::new()
                    .translate(mx, my)
                    .scale(s, s)
                    .translate(-mx, -my)
                    .then(&world),
            );
        }
        for card in &g.cards {
            draw_shadow(cx, *card, RADIUS, 8.0, if cx.dark { 0.6 } else { 0.25 });
            fill_rounded(cx, *card, RADIUS, p.card);
        }
        if let (Some(footer), Some(card)) = (g.footer, g.cards.first()) {
            // The footer's band, its bottom corners the card's.
            cx.push_clip_rounded(*card, [RADIUS; 4]);
            // SAFETY: a COM call between BeginDraw and EndDraw.
            unsafe {
                cx.dc.FillRectangle(
                    &rect_f(
                        footer.origin.x.0,
                        footer.origin.y.0,
                        footer.size.width.0,
                        footer.size.height.0,
                    ),
                    cx.solid(p.footer),
                )
            };
            cx.pop();
        }
        for card in &g.cards {
            stroke_rounded(cx, *card, RADIUS, p.stroke, 1.0);
        }
        if let Some(sep) = g.separator {
            // SAFETY: a COM call between BeginDraw and EndDraw.
            unsafe {
                cx.dc.FillRectangle(
                    &rect_f(
                        sep.origin.x.0,
                        sep.origin.y.0,
                        sep.size.width.0,
                        sep.size.height.0,
                    ),
                    cx.solid(p.separator),
                )
            };
        }
        let t = &self.texts;
        if let (Some(l), Some(r)) = (&t.title, g.title) {
            l.draw(
                cx,
                r.origin.x.0,
                r.origin.y.0,
                if self.sheet { p.secondary } else { p.text },
            );
        }
        if let (Some(l), Some(r)) = (&t.message, g.message) {
            l.draw(
                cx,
                r.origin.x.0,
                r.origin.y.0,
                if self.sheet { p.secondary } else { p.text },
            );
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
            label.draw(cx, r.origin.x.0 + pad, r.origin.y.0, text);
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
        cx.set_transform(world);
        if opacity < 1.0 {
            cx.pop();
        }
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
                if self.keyboard.replace(false) {
                    self.invalidate();
                }
                if over.is_some() {
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
        (13.0, 400, DWRITE_TEXT_ALIGNMENT_CENTER)
    } else {
        (20.0, 600, DWRITE_TEXT_ALIGNMENT_LEADING)
    };
    let texts = DialogTexts {
        title: dialog
            .title
            .as_deref()
            .and_then(|t| Label::new(t, title_size * fs, title_weight, text_align, true)),
        message: dialog.message.as_deref().and_then(|t| {
            Label::new(
                t,
                if sheet { 13.0 } else { 14.0 } * fs,
                400,
                text_align,
                true,
            )
        }),
        buttons: buttons
            .iter()
            .filter_map(|b| {
                let weight = if sheet && b.style == DialogButtonStyle::Cancel {
                    600
                } else {
                    400
                };
                Label::new(
                    &b.text,
                    14.0 * fs,
                    weight,
                    DWRITE_TEXT_ALIGNMENT_CENTER,
                    false,
                )
            })
            .collect(),
    };
    if texts.buttons.len() != buttons.len() {
        log::error!("windows: cannot lay out the dialog's text");
        return surface.event(ROOT_ID, EventKind::Dialog, dialog_answer(dialog.id, -1));
    }
    let default = default_button(&styles, sheet);
    let serial = next_serial();
    let item = Rc::new(DialogItem {
        key: surface.key(),
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
    let layout = layout.as_ref().ok_or("the dialog is not drawn yet")?;
    match button {
        Some(text) => {
            let index = dialog
                .labels
                .iter()
                .position(|l| l == text)
                .ok_or_else(|| format!("the dialog has no button {text:?}"))?;
            let r = layout
                .geometry
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

// ---------------------------------------------------------------------------
// The clipboard

/// Puts `text` on the clipboard (Unicode text).
pub(crate) fn set_clipboard_text(text: &str) -> bool {
    use windows::Win32::{
        Foundation::{GlobalFree, HANDLE, HGLOBAL},
        System::{
            DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData},
            Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock},
            Ole::CF_UNICODETEXT,
        },
    };
    let units: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
    // SAFETY: the clipboard is opened and closed here; the global memory
    // holds `units` and is owned by the clipboard once `SetClipboardData`
    // succeeds (freed here otherwise).
    unsafe {
        if OpenClipboard(None).is_err() {
            return false;
        }
        let mut ok = false;
        if EmptyClipboard().is_ok()
            && let Ok(memory) = GlobalAlloc(GMEM_MOVEABLE, units.len() * 2)
        {
            let ptr = GlobalLock(memory) as *mut u16;
            if !ptr.is_null() {
                std::ptr::copy_nonoverlapping(units.as_ptr(), ptr, units.len());
                let _ = GlobalUnlock(memory);
                ok = SetClipboardData(u32::from(CF_UNICODETEXT.0), Some(HANDLE(memory.0))).is_ok();
            }
            if !ok {
                let _ = GlobalFree(Some(HGLOBAL(memory.0)));
            }
        }
        let _ = CloseClipboard();
        ok
    }
}

/// The clipboard's text, if it has some.
pub(crate) fn clipboard_text() -> Option<String> {
    use windows::Win32::{
        Foundation::HGLOBAL,
        System::{
            DataExchange::{
                CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
            },
            Memory::{GlobalLock, GlobalSize, GlobalUnlock},
            Ole::CF_UNICODETEXT,
        },
    };
    // SAFETY: the clipboard is opened and closed here; the data is read
    // while locked and copied out.
    unsafe {
        IsClipboardFormatAvailable(u32::from(CF_UNICODETEXT.0)).ok()?;
        OpenClipboard(None).ok()?;
        let text = GetClipboardData(u32::from(CF_UNICODETEXT.0))
            .ok()
            .and_then(|h| {
                let memory = HGLOBAL(h.0);
                let ptr = GlobalLock(memory) as *const u16;
                if ptr.is_null() {
                    return None;
                }
                let max = GlobalSize(memory) / 2;
                let units = std::slice::from_raw_parts(ptr, max);
                let len = units.iter().position(|u| *u == 0).unwrap_or(max);
                let text = String::from_utf16_lossy(&units[..len]);
                let _ = GlobalUnlock(memory);
                Some(text)
            });
        let _ = CloseClipboard();
        text
    }
}

/// The clipboard format browsers, Office and the Snipping Tool put PNG
/// images in.
fn png_format() -> u32 {
    use windows::{Win32::System::DataExchange::RegisterClipboardFormatW, core::w};
    // SAFETY: a plain registration of a constant name.
    unsafe { RegisterClipboardFormatW(w!("PNG")) }
}

/// The bytes of clipboard `format`, if it holds that format.
fn clipboard_bytes(format: u32) -> Option<Vec<u8>> {
    use windows::Win32::{
        Foundation::HGLOBAL,
        System::{
            DataExchange::{
                CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
            },
            Memory::{GlobalLock, GlobalSize, GlobalUnlock},
        },
    };
    // SAFETY: the clipboard is opened and closed here; the data is read
    // while locked and copied out.
    unsafe {
        IsClipboardFormatAvailable(format).ok()?;
        OpenClipboard(None).ok()?;
        let bytes = GetClipboardData(format).ok().and_then(|h| {
            let memory = HGLOBAL(h.0);
            let ptr = GlobalLock(memory) as *const u8;
            if ptr.is_null() {
                return None;
            }
            let bytes = std::slice::from_raw_parts(ptr, GlobalSize(memory)).to_vec();
            let _ = GlobalUnlock(memory);
            Some(bytes)
        });
        let _ = CloseClipboard();
        bytes
    }
}

/// Puts `bytes` on the clipboard as `format`, replacing what it holds.
fn set_clipboard_bytes(format: u32, bytes: &[u8]) -> bool {
    use windows::Win32::{
        Foundation::{GlobalFree, HANDLE, HGLOBAL},
        System::{
            DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData},
            Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock},
        },
    };
    // SAFETY: as in `set_clipboard_text`: the memory is the clipboard's once
    // `SetClipboardData` succeeds, freed here otherwise.
    unsafe {
        if OpenClipboard(None).is_err() {
            return false;
        }
        let mut ok = false;
        if EmptyClipboard().is_ok()
            && let Ok(memory) = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1))
        {
            let ptr = GlobalLock(memory) as *mut u8;
            if !ptr.is_null() {
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
                let _ = GlobalUnlock(memory);
                ok = SetClipboardData(format, Some(HANDLE(memory.0))).is_ok();
            }
            if !ok {
                let _ = GlobalFree(Some(HGLOBAL(memory.0)));
            }
        }
        let _ = CloseClipboard();
        ok
    }
}

/// True when the clipboard has an image (a PNG or a bitmap).
pub(crate) fn clipboard_has_image() -> bool {
    use windows::Win32::System::{DataExchange::IsClipboardFormatAvailable, Ole::CF_DIB};
    // SAFETY: plain queries.
    unsafe {
        IsClipboardFormatAvailable(png_format()).is_ok()
            || IsClipboardFormatAvailable(u32::from(CF_DIB.0)).is_ok()
    }
}

/// The clipboard's image: its PNG, else its bitmap as a BMP file.
pub(crate) fn clipboard_image() -> Option<Vec<u8>> {
    use windows::Win32::System::Ole::CF_DIB;
    clipboard_bytes(png_format())
        .or_else(|| clipboard_bytes(u32::from(CF_DIB.0)).and_then(|dib| bmp_file(&dib)))
}

/// A BMP file of a packed device-independent bitmap (`CF_DIB`): the file
/// header, which says where the pixels start, before it.
fn bmp_file(dib: &[u8]) -> Option<Vec<u8>> {
    let u32_at = |i: usize| Some(u32::from_le_bytes(dib.get(i..i + 4)?.try_into().ok()?));
    let header = u32_at(0)? as usize;
    let bit_count = u32::from(u16::from_le_bytes(dib.get(14..16)?.try_into().ok()?));
    let compression = u32_at(16)?;
    let colors_used = u32_at(32)? as usize;
    // BI_BITFIELDS after a BITMAPINFOHEADER: three masks follow it.
    let masks = if header == 40 && compression == 3 {
        12
    } else {
        0
    };
    let palette = match colors_used {
        0 if bit_count <= 8 => (1usize << bit_count) * 4,
        n => n * 4,
    };
    let offset = 14 + header + masks + palette;
    let size = 14 + dib.len();
    let mut file = Vec::with_capacity(size);
    file.extend_from_slice(b"BM");
    file.extend_from_slice(&u32::try_from(size).ok()?.to_le_bytes());
    file.extend_from_slice(&[0; 4]);
    file.extend_from_slice(&u32::try_from(offset).ok()?.to_le_bytes());
    file.extend_from_slice(dib);
    Some(file)
}

/// The `file:` URLs of the files on the clipboard (`CF_HDROP`: files
/// copied in Explorer).
pub(crate) fn clipboard_files() -> Vec<String> {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt, path::PathBuf};

    use windows::Win32::{
        System::{
            DataExchange::{
                CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
            },
            Ole::CF_HDROP,
        },
        UI::Shell::{DragQueryFileW, HDROP},
    };
    let mut files = Vec::new();
    // SAFETY: the clipboard is opened and closed here; the HDROP is the
    // clipboard's and only read while it is open.
    unsafe {
        if IsClipboardFormatAvailable(u32::from(CF_HDROP.0)).is_err()
            || OpenClipboard(None).is_err()
        {
            return files;
        }
        if let Ok(handle) = GetClipboardData(u32::from(CF_HDROP.0)) {
            let drop = HDROP(handle.0);
            for index in 0..DragQueryFileW(drop, u32::MAX, None) {
                let length = DragQueryFileW(drop, index, None);
                let mut name = vec![0; length as usize + 1];
                let copied = DragQueryFileW(drop, index, Some(&mut name));
                if copied == 0 || copied != length {
                    continue;
                }
                let path = PathBuf::from(OsString::from_wide(&name[..copied as usize]));
                if path.is_absolute() {
                    files.push(clipboard::file_url(&path.to_string_lossy()));
                }
            }
        }
        let _ = CloseClipboard();
    }
    files
}

/// True when the clipboard has text.
pub(crate) fn clipboard_has_text() -> bool {
    use windows::Win32::System::{DataExchange::IsClipboardFormatAvailable, Ole::CF_UNICODETEXT};
    // SAFETY: a plain query.
    unsafe { IsClipboardFormatAvailable(u32::from(CF_UNICODETEXT.0)) }.is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bitmaps_become_bmp_files() {
        // A BITMAPINFOHEADER of a 2x1 32-bit bitmap, then its pixels.
        let mut dib = vec![0u8; 40];
        dib[0] = 40;
        dib[4] = 2;
        dib[8] = 1;
        dib[12] = 1;
        dib[14] = 32;
        dib.extend([0xFF; 8]);
        let file = bmp_file(&dib).unwrap();
        assert_eq!(&file[..2], b"BM");
        assert_eq!(u32::from_le_bytes(file[2..6].try_into().unwrap()), 62);
        assert_eq!(u32::from_le_bytes(file[10..14].try_into().unwrap()), 54);
        assert_eq!(clipboard::image_size(&file), Some((2, 1)));
    }

    #[test]
    fn locales() {
        let tag = |name: Option<&str>| user_locale(name).as_str().to_owned();
        assert_eq!(tag(Some("de-DE")), "de-DE");
        assert_eq!(tag(Some("zh-Hans-CN")), "zh-Hans-CN");
        assert_eq!(tag(Some("sr-Latn-RS")), "sr-Latn-RS");
        // A sort order is no part of the tag.
        assert_eq!(tag(Some("de-DE_phoneb")), "de-DE");
        assert_eq!(tag(Some("es-419")), "es-419");
        // The invariant locale, or none.
        assert_eq!(tag(Some("")), "en-US");
        assert_eq!(tag(None), "en-US");
    }

    #[test]
    fn text_scales() {
        assert_eq!(text_scale(None), 1.0);
        assert_eq!(text_scale(Some(100)), 1.0);
        assert_eq!(text_scale(Some(150)), 1.5);
        assert_eq!(text_scale(Some(225)), 2.25);
        assert_eq!(text_scale(Some(0)), 1.0);
        assert_eq!(text_scale(Some(1000)), 1.0);
    }

    #[test]
    fn reading_layouts() {
        assert!(reading_layout_rtl("1"));
        assert!(!reading_layout_rtl("0"));
        assert!(!reading_layout_rtl("2"));
        assert!(!reading_layout_rtl(""));
    }

    #[test]
    fn accent_palette() {
        let mut palette = [0u8; 32];
        palette[4..8].copy_from_slice(&[0x99, 0xeb, 0xff, 0]);
        palette[16..20].copy_from_slice(&[0x00, 0x5a, 0x9e, 0]);
        let (light, dark) = accent_shades(&palette);
        assert_eq!(light, Color(0x005a_9eff));
        assert_eq!(dark, Color(0x99eb_ffff));
    }

    #[test]
    fn os_version_is_windows_10_or_later() {
        assert!(os_version().0 >= 10);
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
        // The message wraps at the inner width, below the title.
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
        // More than three buttons stack.
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
        // So do labels too long for their column.
        let g = layout_alert(
            (360.0, 800.0),
            true,
            false,
            2,
            &measure(&["A rather long button label", "OK"]),
        );
        assert!(!g.row);
        // A narrow window: the card fits it, less the gutters.
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
        // The options in order in the first card, the cancel button alone.
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
