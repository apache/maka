//! Notifications and the badge on Windows (`Command::Notification`, `nsh`'s
//! `Notifications`): toasts through WinRT's `ToastNotificationManager`, the
//! count as the taskbar button's overlay icon (`ITaskbarList3`).
//!
//! NSH apps are not packaged, so the system knows them by nothing but what
//! the process says. Toasts of an unpackaged app need:
//! - an AppUserModelID: the app's id, the one the taskbar groups it by
//!   ([`start`]), set only for a view that owns the process's notifications
//!   (`AppOptions::notifications`, [`start_app`]; `run_app` sets it).
//!   Without it the notifications stay the embedding app's, the permission
//!   is `unavailable` and nothing shows;
//! - the id's registration, `HKCU\Software\Classes\AppUserModelId\<id>`, with
//!   the name and icon toasts show and the COM class that hears presses. Written when
//!   the app first asks about notifications ([`register`]), not on every
//!   start. It needs no Start Menu shortcut;
//! - that class's `LocalServer32`, the command that starts the app when a
//!   toast is pressed after it ended. The development host writes none: it
//!   has no app to start without its arguments, so there a press is heard
//!   only while it runs.
//!
//! Windows has no permission prompt: a toast shows unless the user turned the
//! app's or all notifications off in Settings, which is what `denied` is, so
//! the permission is never `default` and asking asks nothing.
//!
//! The press reaches [`Activator`], on the UI thread (COM calls an apartment's
//! objects through its message loop). The class is registered with COM on
//! every start ([`start`]), before the window opens: a toast left in the
//! notification center by an earlier run would otherwise start a second
//! process when pressed.

use std::{
    cell::{Cell, RefCell},
    ffi::c_void,
    path::{Path, PathBuf},
    rc::{Rc, Weak},
    sync::OnceLock,
};

use nsh_core::{
    EventKind, EventPayload, PayloadValue, ROOT_ID,
    notifications::{Notification, NotificationCommand, NotificationEvent, NotificationPermission},
};
use windows::{
    Data::Xml::Dom::XmlDocument,
    UI::Notifications::{
        NotificationSetting, ToastNotification, ToastNotificationManager, ToastNotifier,
    },
    Win32::{
        Foundation::{ERROR_NOT_FOUND, HWND, RECT},
        Graphics::Gdi::{
            ANTIALIASED_QUALITY, BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CLIP_DEFAULT_PRECIS,
            CreateBitmap, CreateCompatibleDC, CreateDIBSection, CreateFontW, DEFAULT_CHARSET,
            DEFAULT_PITCH, DIB_RGB_COLORS, DT_CENTER, DT_NOCLIP, DT_SINGLELINE, DT_VCENTER,
            DeleteDC, DeleteObject, DrawTextW, FF_DONTCARE, FW_BOLD, HGDIOBJ, OUT_DEFAULT_PRECIS,
            SelectObject, SetBkMode, SetTextColor, TRANSPARENT,
        },
        System::{
            Com::{
                CLSCTX_INPROC_SERVER, CLSCTX_LOCAL_SERVER, CoCreateInstance, CoRegisterClassObject,
                IClassFactory, IClassFactory_Impl, REGCLS_MULTIPLEUSE,
            },
            Registry::{HKEY_CURRENT_USER, REG_SZ, RegSetKeyValueW},
        },
        UI::{
            HiDpi::GetSystemMetricsForDpi,
            Notifications::{
                INotificationActivationCallback, INotificationActivationCallback_Impl,
                NOTIFICATION_USER_INPUT_DATA,
            },
            Shell::{ITaskbarList3, TaskbarList},
            WindowsAndMessaging::{
                CreateIconIndirect, DestroyIcon, GA_ROOT, GetAncestor, HICON, ICONINFO, IsIconic,
                RegisterWindowMessageW, SM_CXSMICON, SW_RESTORE, SetForegroundWindow, ShowWindow,
            },
        },
    },
    core::{BOOL, GUID, HSTRING, IUnknown, Interface, PCWSTR, Ref, Result, implement, w},
};

use crate::surface::Surface;

/// The group of every toast: a toast is found by its tag and group.
const GROUP: &str = "nsh";
/// The longest tag Windows takes, in UTF-16 units.
const MAX_TAG: usize = 64;
/// The longest AppUserModelID the registration takes.
const MAX_APP_ID: usize = 129;
/// What the system passes the app it starts for a press. The release runner
/// reads no arguments.
const ACTIVATED_ARG: &str = "-ToastActivated";
/// The largest count the overlay icon has room for.
const MAX_BADGE: u32 = 99;

thread_local! {
    /// The app's id and name, when the process is an app of its own.
    static APP: RefCell<Option<(String, String)>> = const { RefCell::new(None) };
    /// The app's icon file, which toasts show.
    static ICON: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
    /// The id is registered ([`register`]).
    static REGISTERED: Cell<bool> = const { Cell::new(false) };
    /// The surface that listens to presses, once the app does.
    static LISTENER: RefCell<Option<Weak<Surface>>> = const { RefCell::new(None) };
    /// Presses before the app listens.
    static PRESSES: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    /// The count on the taskbar button, put back when the button is made anew.
    static BADGE: Cell<u32> = const { Cell::new(0) };
}

/// Makes the process the app `id` ([`start`]) for an [`AppView`] that owns
/// its notifications (`AppOptions::notifications`), once per process: the
/// first such view's app wins.
///
/// [`AppView`]: crate::AppView
pub(crate) fn start_app(id: &str, name: &str, icon: Option<&Path>) {
    if APP.with(|app| app.borrow().is_some()) {
        return;
    }
    crate::system::set_app_id(id);
    start(id, name, icon);
}

/// Makes the process the app `id`, named `name`, for toasts, and starts
/// hearing their presses. On the UI thread, in its apartment, before the
/// message loop.
pub(crate) fn start(id: &str, name: &str, icon: Option<&Path>) {
    if id.encode_utf16().count() > MAX_APP_ID {
        log::warn!("notifications: the app id is over {MAX_APP_ID} characters: none will show");
        return;
    }
    APP.with(|app| *app.borrow_mut() = Some((id.to_owned(), name.to_owned())));
    ICON.with(|i| *i.borrow_mut() = icon.and_then(|icon| std::path::absolute(icon).ok()));
    let factory: IClassFactory = Factory.into();
    // SAFETY: a valid class id and factory. The registration lasts as the
    // process does, so its cookie is not kept.
    let registered = unsafe {
        CoRegisterClassObject(
            &class_id(id),
            &factory,
            CLSCTX_LOCAL_SERVER,
            REGCLS_MULTIPLEUSE,
        )
    };
    if let Err(err) = registered {
        log::warn!("notifications: presses will not be heard: {err}");
    }
}

/// Applies `command`, reporting to `surface`. On the UI thread.
pub(crate) fn command(surface: &Rc<Surface>, command: &NotificationCommand) {
    match command {
        NotificationCommand::SetBadge(count) => {
            BADGE.set(*count);
            apply_badge(surface);
        }
        NotificationCommand::Permission { id, ask: _ } => {
            answer_permission(surface, *id, permission());
        }
        NotificationCommand::Show { id, notification } => {
            let shown = show(notification);
            if let Err(err) = &shown {
                log::warn!("notifications: not shown: {err}");
            }
            answer_shown(surface, *id, shown.unwrap_or(false));
        }
        NotificationCommand::Close(id) => {
            if let Err(err) = close(id) {
                log::warn!("notifications: cannot close: {err}");
            }
        }
        NotificationCommand::Listen => {
            LISTENER.with(|l| *l.borrow_mut() = Some(Rc::downgrade(surface)));
            for id in PRESSES.with(|p| std::mem::take(&mut *p.borrow_mut())) {
                pressed(id);
            }
        }
        _ => {}
    }
}

/// The message the shell sends a window when its taskbar button is made: the
/// first time, and when Explorer restarts, which forgets the overlay.
pub(crate) fn taskbar_button_created() -> u32 {
    static MESSAGE: OnceLock<u32> = OnceLock::new();
    // SAFETY: a valid string.
    *MESSAGE.get_or_init(|| unsafe { RegisterWindowMessageW(w!("TaskbarButtonCreated")) })
}

/// Puts the count back on the taskbar button just made.
pub(crate) fn button_created(surface: &Rc<Surface>) {
    if BADGE.get() > 0 {
        apply_badge(surface);
    }
}

/// The app's name, when the process is an app of its own.
pub(crate) fn app_name() -> Option<String> {
    app().map(|(_, name)| name)
}

/// The app's id and name, when it has them.
fn app() -> Option<(String, String)> {
    APP.with(|app| app.borrow().clone())
}

/// The toast notifier of the app, its id registered first; `None` without an
/// id of its own.
fn notifier() -> Option<Result<ToastNotifier>> {
    let (id, name) = app()?;
    if !REGISTERED.get() {
        match register(&id, &name) {
            Ok(()) => REGISTERED.set(true),
            Err(err) => return Some(Err(err)),
        }
    }
    Some(ToastNotificationManager::CreateToastNotifierWithId(
        &HSTRING::from(id),
    ))
}

/// Registers the app's id for the current user; again on each run that needs
/// it, as the executable may have moved.
fn register(id: &str, name: &str) -> Result<()> {
    let class = class_key(&class_id(id));
    let app_key = format!("Software\\Classes\\AppUserModelId\\{id}");
    set_value(&app_key, Some("DisplayName"), name)?;
    set_value(&app_key, Some("CustomActivator"), &class)?;
    // The icon toasts show by the app's name; without one, a blank one.
    let icon = ICON.with(|i| i.borrow().clone());
    set_value(
        &app_key,
        Some("IconUri"),
        &icon
            .map(|icon| icon.display().to_string())
            .unwrap_or_default(),
    )?;
    if !cfg!(feature = "dev") {
        let exe = std::env::current_exe().map_err(|_| windows::core::Error::from_thread())?;
        set_value(
            &format!("Software\\Classes\\CLSID\\{class}\\LocalServer32"),
            None,
            &format!("\"{}\" {ACTIVATED_ARG}", exe.display()),
        )?;
    }
    Ok(())
}

/// Sets a string under `HKEY_CURRENT_USER`, making the key when missing.
fn set_value(key: &str, name: Option<&str>, value: &str) -> Result<()> {
    let data: Vec<u16> = value.encode_utf16().chain(Some(0)).collect();
    let name = name.map(HSTRING::from);
    // SAFETY: valid strings, and `data` with its length in bytes.
    unsafe {
        RegSetKeyValueW(
            HKEY_CURRENT_USER,
            &HSTRING::from(key),
            name.as_ref()
                .map_or(PCWSTR::null(), |name| PCWSTR(name.as_ptr())),
            REG_SZ.0,
            Some(data.as_ptr().cast()),
            (data.len() * 2) as u32,
        )
    }
    .ok()
}

fn permission() -> NotificationPermission {
    let setting = match notifier() {
        None => return NotificationPermission::Unavailable,
        Some(notifier) => notifier.and_then(|n| setting(&n)),
    };
    match setting {
        Ok(NotificationSetting::Enabled) => NotificationPermission::Granted,
        Ok(_) => NotificationPermission::Denied,
        Err(err) => {
            log::warn!("notifications: cannot read the setting: {err}");
            NotificationPermission::Unavailable
        }
    }
}

/// The user's setting for the app's notifications. An app that has not
/// shown one yet has no entry in Settings > System > Notifications, and
/// `Setting` fails with `ERROR_NOT_FOUND` until the first toast makes it:
/// nothing turned off, so they are on.
fn setting(notifier: &ToastNotifier) -> Result<NotificationSetting> {
    match notifier.Setting() {
        Err(err) if err.code() == ERROR_NOT_FOUND.to_hresult() => Ok(NotificationSetting::Enabled),
        setting => setting,
    }
}

/// Whether the system took `notification`.
fn show(notification: &Notification) -> Result<bool> {
    let Some(notifier) = notifier() else {
        return Ok(false);
    };
    let notifier = notifier?;
    if setting(&notifier)? != NotificationSetting::Enabled {
        return Ok(false);
    }
    let document = XmlDocument::new()?;
    document.LoadXml(&HSTRING::from(toast_xml(notification)))?;
    let toast = ToastNotification::CreateToastNotification(&document)?;
    toast.SetTag(&HSTRING::from(tag(&notification.id)))?;
    toast.SetGroup(&HSTRING::from(GROUP))?;
    notifier.Show(&toast)?;
    Ok(true)
}

fn close(id: &str) -> Result<()> {
    let Some((app, _)) = app() else {
        return Ok(());
    };
    ToastNotificationManager::History()?.RemoveGroupedTagWithId(
        &HSTRING::from(tag(id)),
        &HSTRING::from(GROUP),
        &HSTRING::from(app),
    )
}

/// The toast showing `notification`. The press hands back its `launch`
/// exactly, which holds the id in hex: an id can be anything, XML cannot.
fn toast_xml(notification: &Notification) -> String {
    let mut lines = format!("<text>{}</text>", escape(&notification.title));
    if !notification.body.is_empty() {
        lines += &format!("<text>{}</text>", escape(&notification.body));
    }
    let audio = if notification.silent {
        "<audio silent=\"true\"/>"
    } else {
        ""
    };
    format!(
        "<toast launch=\"{}\"><visual><binding template=\"ToastGeneric\">{lines}</binding></visual>{audio}</toast>",
        hex(&notification.id)
    )
}

/// `text` as XML content, without what XML cannot hold.
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\t' | '\n' | '\r' => out.push(c),
            c if c < ' ' || matches!(c, '\u{FFFE}' | '\u{FFFF}') => {}
            c => out.push(c),
        }
    }
    out
}

fn hex(text: &str) -> String {
    text.bytes().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(text: &str) -> Option<String> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    let bytes = (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect::<Option<Vec<u8>>>()?;
    String::from_utf8(bytes).ok()
}

/// The tag of the toast called `id`: itself when Windows takes it, its hash
/// when it is too long.
fn tag(id: &str) -> String {
    if !id.is_empty() && id.encode_utf16().count() <= MAX_TAG {
        id.to_owned()
    } else {
        format!("{:032x}", hash(id))
    }
}

/// FNV-1a, 128 bits: stable across runs and builds.
fn hash(text: &str) -> u128 {
    const PRIME: u128 = 0x0000_0000_0100_0000_0000_0000_0000_013B;
    const BASIS: u128 = 0x6C62_272E_07BB_0142_62B8_2175_6295_C58D;
    text.bytes().fold(BASIS, |hash, byte| {
        (hash ^ u128::from(byte)).wrapping_mul(PRIME)
    })
}

/// The COM class of the app `id`: derived from it, so each app has its own
/// and a run finds what an earlier one registered.
fn class_id(id: &str) -> GUID {
    let hash = hash(&format!("nsh.notifications:{id}"));
    // A version 4 layout, in the RFC 4122 variant.
    let bits = (hash & !(0xF_u128 << 76) & !(0x3_u128 << 62)) | (0x4_u128 << 76) | (0x2_u128 << 62);
    GUID::from_u128(bits)
}

/// `class` as registry keys write it.
fn class_key(class: &GUID) -> String {
    let bits = class.to_u128();
    format!(
        "{{{:08X}-{:04X}-{:04X}-{:04X}-{:012X}}}",
        (bits >> 96) as u32,
        (bits >> 80) as u16,
        (bits >> 64) as u16,
        (bits >> 48) as u16,
        bits & 0xFFFF_FFFF_FFFF,
    )
}

/// Makes the app's [`Activator`]s for COM.
#[implement(IClassFactory)]
struct Factory;

impl IClassFactory_Impl for Factory_Impl {
    fn CreateInstance(
        &self,
        outer: Ref<IUnknown>,
        interface: *const GUID,
        object: *mut *mut c_void,
    ) -> Result<()> {
        if outer.is_some() {
            return Err(windows::Win32::Foundation::CLASS_E_NOAGGREGATION.into());
        }
        let activator: INotificationActivationCallback = Activator.into();
        // SAFETY: COM's output pointer and the interface it asks for.
        unsafe { activator.query(interface, object) }.ok()
    }

    fn LockServer(&self, _lock: BOOL) -> Result<()> {
        Ok(())
    }
}

/// Hears the presses of the app's toasts.
#[implement(INotificationActivationCallback)]
struct Activator;

impl INotificationActivationCallback_Impl for Activator_Impl {
    fn Activate(
        &self,
        _app: &PCWSTR,
        arguments: &PCWSTR,
        _data: *const NOTIFICATION_USER_INPUT_DATA,
        _count: u32,
    ) -> Result<()> {
        // SAFETY: a string of the call, or null.
        let arguments = if arguments.is_null() {
            String::new()
        } else {
            unsafe { arguments.to_string() }.unwrap_or_default()
        };
        // The toast's `launch` (`toast_xml`); a toast of no id is not NSH's.
        if let Some(id) = from_hex(&arguments).filter(|id| !id.is_empty()) {
            pressed(id);
        }
        Ok(())
    }
}

/// Reports a press to the app and brings it to the front, or keeps the press
/// until the app listens.
fn pressed(id: String) {
    let listener = LISTENER.with(|l| l.borrow().as_ref().and_then(Weak::upgrade));
    let Some(surface) = listener else {
        PRESSES.with(|p| p.borrow_mut().push(id));
        return;
    };
    let window = root(&surface);
    // SAFETY: plain calls on the app's window. The system lets the process a
    // toast activates take the foreground.
    unsafe {
        if IsIconic(window).as_bool() {
            let _ = ShowWindow(window, SW_RESTORE);
        }
        let _ = SetForegroundWindow(window);
    }
    surface.event(
        ROOT_ID,
        EventKind::Notification,
        EventPayload::Map(vec![(NotificationEvent::PRESSED, PayloadValue::Str(id))]),
    );
}

fn answer_permission(surface: &Surface, id: u32, permission: NotificationPermission) {
    surface.event(
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

fn answer_shown(surface: &Surface, id: u32, shown: bool) {
    surface.event(
        ROOT_ID,
        EventKind::Notification,
        EventPayload::Map(vec![
            (NotificationEvent::ID, PayloadValue::Number(f64::from(id))),
            (NotificationEvent::SHOWN, PayloadValue::Bool(shown)),
        ]),
    );
}

/// The top-level window of `surface`: the one with a taskbar button.
fn root(surface: &Surface) -> HWND {
    // SAFETY: a plain call; a destroyed window gives a null one.
    unsafe { GetAncestor(surface.hwnd(), GA_ROOT) }
}

/// Shows [`BADGE`] on the surface's taskbar button. Without a button yet this
/// fails, and [`button_created`] does it again.
fn apply_badge(surface: &Surface) {
    let window = root(surface);
    if window.is_invalid() {
        return;
    }
    if let Err(err) = set_overlay(window, BADGE.get()) {
        log::debug!("notifications: no badge yet: {err}");
    }
}

fn set_overlay(window: HWND, count: u32) -> Result<()> {
    let label = badge_label(count);
    let icon = if count == 0 {
        HICON::default()
    } else {
        badge_icon(&label, crate::window::dpi(window))?
    };
    let description = HSTRING::from(label.as_str());
    // SAFETY: COM is initialized on the UI thread and the icon is valid; the
    // taskbar copies it, so it is destroyed here.
    unsafe {
        let taskbar: ITaskbarList3 = CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER)?;
        taskbar.HrInit()?;
        let set = taskbar.SetOverlayIcon(window, icon, &description);
        if !icon.is_invalid() {
            let _ = DestroyIcon(icon);
        }
        set
    }
}

/// What the overlay says of `count`; empty for none.
fn badge_label(count: u32) -> String {
    match count {
        0 => String::new(),
        1..=MAX_BADGE => count.to_string(),
        _ => format!("{MAX_BADGE}+"),
    }
}

/// `label` white on a red disc, an icon of the small icon's size at `dpi`.
fn badge_icon(label: &str, dpi: u32) -> Result<HICON> {
    // SAFETY: plain calls.
    let size = unsafe { GetSystemMetricsForDpi(SM_CXSMICON, dpi) }.max(16);
    let info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: size,
            // Top-down.
            biHeight: -size,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bits: *mut c_void = std::ptr::null_mut();
    let pixels = (size * size) as usize;
    // SAFETY: GDI objects made and released here. `bits` has `pixels` pixels
    // (its section is as `info` says) while the bitmap lasts, and is read
    // and written once GDI has finished drawing into it (`GdiFlush` is
    // implied by `DeleteDC`).
    unsafe {
        let dc = CreateCompatibleDC(None);
        let color = CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0)?;
        let old_bitmap = SelectObject(dc, HGDIOBJ(color.0));
        // Fewer digits, larger: "99+" must fit the disc.
        let height = size * if label.len() > 2 { 5 } else { 7 } / 10;
        let font = CreateFontW(
            -height,
            0,
            0,
            0,
            FW_BOLD.0 as i32,
            0,
            0,
            0,
            DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS,
            CLIP_DEFAULT_PRECIS,
            ANTIALIASED_QUALITY,
            (DEFAULT_PITCH.0 | FF_DONTCARE.0) as u32,
            w!("Segoe UI"),
        );
        let old_font = SelectObject(dc, HGDIOBJ(font.0));
        SetBkMode(dc, TRANSPARENT);
        SetTextColor(dc, windows::Win32::Foundation::COLORREF(0x00FF_FFFF));
        let mut text: Vec<u16> = label.encode_utf16().collect();
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: size,
            bottom: size,
        };
        DrawTextW(
            dc,
            &mut text,
            &mut rect,
            DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOCLIP,
        );
        SelectObject(dc, old_font);
        SelectObject(dc, old_bitmap);
        let _ = DeleteObject(HGDIOBJ(font.0));
        let _ = DeleteDC(dc);

        let pixels = std::slice::from_raw_parts_mut(bits.cast::<u32>(), pixels);
        compose_badge(pixels, size as usize);

        // A 32-bit color bitmap carries the alpha, so the mask stays empty.
        let mask = CreateBitmap(size, size, 1, 1, None);
        let icon = CreateIconIndirect(&ICONINFO {
            fIcon: true.into(),
            hbmMask: mask,
            hbmColor: color,
            ..Default::default()
        });
        let _ = DeleteObject(HGDIOBJ(mask.0));
        let _ = DeleteObject(HGDIOBJ(color.0));
        icon
    }
}

/// Turns text drawn white on black in `pixels` (BGRA, `size` square) into the
/// badge: white over a red disc, straight alpha as icons have it.
fn compose_badge(pixels: &mut [u32], size: usize) {
    const RED: [f32; 3] = [196.0, 43.0, 28.0];
    let radius = size as f32 / 2.0;
    for (i, pixel) in pixels.iter_mut().enumerate() {
        let (x, y) = ((i % size) as f32 + 0.5, (i / size) as f32 + 0.5);
        let distance = ((x - radius).powi(2) + (y - radius).powi(2)).sqrt();
        let alpha = (radius - distance + 0.5).clamp(0.0, 1.0);
        // Antialiased, not ClearType: every channel holds the coverage.
        let coverage = ((*pixel >> 8) & 0xFF) as f32 / 255.0;
        let [r, g, b] = RED.map(|c| (c + (255.0 - c) * coverage).round() as u32);
        *pixel = (((alpha * 255.0).round() as u32) << 24) | (r << 16) | (g << 8) | b;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_toast_escapes_text_and_omits_an_empty_body() {
        let xml = toast_xml(&Notification::new("a", "<T> & \u{1}x", ""));
        assert_eq!(
            xml,
            "<toast launch=\"61\"><visual><binding template=\"ToastGeneric\">\
             <text>&lt;T&gt; &amp; x</text></binding></visual></toast>"
        );
        assert!(toast_xml(&Notification::new("a", "T", "B")).contains("<text>B</text>"));
    }

    #[test]
    fn a_silent_toast_plays_no_sound() {
        let xml = toast_xml(&Notification::new("a", "T", "").silent(true));
        assert!(
            xml.ends_with("</visual><audio silent=\"true\"/></toast>"),
            "{xml}"
        );
        assert!(!toast_xml(&Notification::new("a", "T", "")).contains("<audio"));
    }

    #[test]
    fn the_toast_loads_in_the_system_parser() {
        use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize};
        struct Apartment;
        impl Drop for Apartment {
            fn drop(&mut self) {
                // SAFETY: balances initialization after the WinRT objects drop.
                unsafe { RoUninitialize() };
            }
        }
        // SAFETY: this test owns its thread's WinRT apartment.
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.unwrap();
        let _apartment = Apartment;
        for silent in [false, true] {
            let notification =
                Notification::new("chat:\"42\"\n", "<T> & \u{1}", "B\n").silent(silent);
            let document = XmlDocument::new().unwrap();
            document
                .LoadXml(&HSTRING::from(toast_xml(&notification)))
                .unwrap();
            ToastNotification::CreateToastNotification(&document).unwrap();
        }
    }

    #[test]
    fn a_press_gets_any_id_back() {
        for id in ["chat:42", "a\"<&>\n", "通知"] {
            assert_eq!(from_hex(&hex(id)).as_deref(), Some(id));
        }
        assert_eq!(from_hex("abc"), None);
        assert_eq!(from_hex("zz"), None);
        assert_eq!(from_hex("ff"), None);
    }

    #[test]
    fn tags_stay_within_the_limit() {
        assert_eq!(tag("short"), "short");
        let long = "x".repeat(65);
        assert_eq!(tag(&long).len(), 32);
        assert_eq!(tag(&long), tag(&long));
        assert_ne!(tag(&long), tag(&"y".repeat(65)));
        assert_eq!(tag(&"x".repeat(64)).len(), 64);
    }

    #[test]
    fn each_app_has_a_stable_class() {
        let class = class_id("com.example.app");
        assert_eq!(class, class_id("com.example.app"));
        assert_ne!(class, class_id("com.example.other"));
        let key = class_key(&class);
        assert_eq!(key.len(), 38, "{key}");
        assert_eq!(&key[15..16], "4", "{key}");
        assert!(matches!(&key[20..21], "8" | "9" | "A" | "B"), "{key}");
    }

    #[test]
    fn large_counts_are_capped() {
        assert_eq!(badge_label(0), "");
        assert_eq!(badge_label(7), "7");
        assert_eq!(badge_label(99), "99");
        assert_eq!(badge_label(100), "99+");
    }

    #[test]
    fn the_badge_is_white_text_on_a_red_disc() {
        let size = 16;
        let mut pixels = vec![0; size * size];
        let center = size * 8 + 8;
        pixels[center] = 0x00FF_FFFF;
        compose_badge(&mut pixels, size);
        assert_eq!(pixels[0] >> 24, 0, "transparent outside the disc");
        assert_eq!(pixels[center], 0xFFFF_FFFF, "the text");
        assert_eq!(pixels[center - 3], 0xFFC4_2B1C, "the disc");
    }

    #[test]
    fn the_badge_icon_is_made_without_a_window() {
        for label in ["7", "99+"] {
            let icon = badge_icon(label, 144).unwrap();
            assert!(!icon.is_invalid());
            // SAFETY: the icon just made.
            unsafe { DestroyIcon(icon) }.unwrap();
        }
    }
}
