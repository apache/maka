//! The app's icon in the notification area (`DesktopCommand::SetTray`,
//! `nsh/desktop`'s `Tray`): `Shell_NotifyIconW` on the app's top-level
//! window.
//!
//! - The icon is the small icon's size at the window's DPI (`SM_CXSMICON`),
//!   loaded through the image pipeline as a menu item's icon is. An SVG is a
//!   template, painted in the taskbar's text color (white on the dark
//!   taskbar, black on the light one: Settings > Personalization > Colors,
//!   "Windows mode"), and painted again when that changes. Without an icon
//!   the tray shows the app's (the executable's first icon resource, else
//!   its window's, else Windows' default application icon). The old icon stays until a new
//!   one has loaded.
//! - `NOTIFYICON_VERSION_4`: a primary click is `NIN_SELECT`, Enter or Space
//!   on the focused icon `NIN_KEYSELECT`, a secondary click or Shift+F10
//!   `WM_CONTEXTMENU`, each with the icon's position. A primary click (and
//!   the keyboard's) reports the app's `onClick` with the icon's frame
//!   (`Shell_NotifyIconGetRect`, in points on the monitor with most of it),
//!   else opens the menu; the menu opens at the icon, its items reported as
//!   a context menu's are.
//! - Explorer forgets every icon when it restarts and broadcasts
//!   `TaskbarCreated`: the icon is added again ([`taskbar_created`]).
//! - The icon goes with the window that set it ([`destroyed`]).

use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
    sync::OnceLock,
};

use nsh_core::{
    Color, EventKind, EventPayload, ImageSource, PayloadValue, ROOT_ID,
    desktop::{Tray, menu_icon},
    geometry::{Bounds, Points},
};
use windows::{
    Win32::{
        Foundation::{HWND, LPARAM, POINT, WPARAM},
        Graphics::Gdi::{
            BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateBitmap, CreateDIBSection, DIB_RGB_COLORS,
            DeleteObject, HGDIOBJ, ScreenToClient,
        },
        UI::{
            HiDpi::GetSystemMetricsForDpi,
            Shell::{
                NIF_ICON, NIF_MESSAGE, NIF_SHOWTIP, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_MODIFY,
                NIM_SETVERSION, NIN_SELECT, NOTIFY_ICON_MESSAGE, NOTIFYICON_VERSION_4,
                NOTIFYICONDATAW, NOTIFYICONIDENTIFIER, Shell_NotifyIconGetRect, Shell_NotifyIconW,
            },
            WindowsAndMessaging::{
                CreateIconIndirect, DestroyIcon, GA_ROOT, GetAncestor, GetWindowTextW, HICON,
                ICON_SMALL, ICONINFO, IDI_APPLICATION, LoadIconW, RegisterWindowMessageW,
                SM_CXSMICON, SendMessageW, WM_CONTEXTMENU, WM_GETICON,
            },
        },
    },
    core::{PCWSTR, w},
};

/// The message the icon sends its window.
pub(crate) use crate::window::WM_NSH_TRAY;
use crate::{image::Load, surface::Surface};
/// The icon's id on its window: an app has one.
const UID: u32 = 1;
/// `NIN_KEYSELECT`: Enter or Space on the focused icon (`NIN_SELECT |
/// NINF_KEY`).
const NIN_KEYSELECT: u32 = NIN_SELECT | 1;
/// The longest tooltip, in UTF-16 units with its NUL.
const MAX_TIP: usize = 128;

/// The app's icon.
struct Item {
    /// The top-level window it is on.
    hwnd: HWND,
    /// The surface whose app set it, which its reports go to.
    surface: Weak<Surface>,
    tray: Tray,
    /// The icon shown; destroyed with the item unless it is the app's.
    icon: Icon,
    /// The icon source shown or loading, kept to see whether it changed.
    source: Option<Option<ImageSource>>,
    /// The loaded image, kept to paint a template again.
    loaded: Option<Rc<crate::image::MenuIcon>>,
    load: Option<Load>,
    /// In the notification area now.
    added: Cell<bool>,
}

/// An icon handle and whether the item made it.
#[derive(Clone, Copy, Default)]
struct Icon {
    handle: HICON,
    owned: bool,
}

impl Icon {
    fn release(self) {
        if self.owned && !self.handle.is_invalid() {
            // SAFETY: an icon this module made and no longer uses.
            let _ = unsafe { DestroyIcon(self.handle) };
        }
    }
}

impl Drop for Item {
    fn drop(&mut self) {
        if self.added.get() {
            notify(NIM_DELETE, &self.data());
        }
        self.icon.release();
    }
}

thread_local! {
    static ITEM: RefCell<Option<Item>> = const { RefCell::new(None) };
}

/// Shows, changes or removes (`None`) the app's icon.
pub(crate) fn set(surface: &Rc<Surface>, tray: Option<&Tray>) {
    let Some(tray) = tray else {
        ITEM.with(|item| item.borrow_mut().take());
        return;
    };
    // SAFETY: a plain call; a destroyed window gives a null one.
    let hwnd = unsafe { GetAncestor(surface.hwnd(), GA_ROOT) };
    if hwnd.is_invalid() {
        return;
    }
    // One icon per app: the last window's wins.
    let moved = ITEM.with(|item| item.borrow().as_ref().is_some_and(|i| i.hwnd != hwnd));
    if moved {
        ITEM.with(|item| item.borrow_mut().take());
    }
    let new_source = Some(tray.icon.clone());
    let icon_changed = ITEM.with(|item| {
        let mut item = item.borrow_mut();
        let item = item.get_or_insert_with(|| Item {
            hwnd,
            surface: Rc::downgrade(surface),
            tray: tray.clone(),
            icon: app_icon(hwnd),
            source: None,
            loaded: None,
            load: None,
            added: Cell::new(false),
        });
        item.surface = Rc::downgrade(surface);
        item.tray = tray.clone();
        item.source != new_source
    });
    if icon_changed {
        load_icon(surface, hwnd, tray.icon.clone());
    }
    ITEM.with(|item| {
        if let Some(item) = item.borrow().as_ref() {
            item.show();
        }
    });
}

/// Starts loading `source` for the icon; the app's icon at once for none.
fn load_icon(surface: &Surface, hwnd: HWND, source: Option<ImageSource>) {
    let Some(src) = source.clone() else {
        ITEM.with(|item| {
            if let Some(item) = item.borrow_mut().as_mut() {
                item.load = None;
                item.loaded = None;
                item.source = Some(None);
                item.icon.release();
                item.icon = app_icon(hwnd);
            }
        });
        return;
    };
    let (side, scale) = icon_size(hwnd);
    let uri = src.uri.clone();
    ITEM.with(|item| {
        if let Some(item) = item.borrow_mut().as_mut() {
            item.source = Some(source);
        }
    });
    let finished = Rc::new(Cell::new(false));
    let done = finished.clone();
    let load = crate::image::load_menu_icon(surface, &src, scale, move |loaded| {
        done.set(true);
        let icon = match loaded {
            Ok(icon) => Rc::new(icon),
            Err(e) => {
                log::warn!("tray icon {uri}: {e}");
                return;
            }
        };
        ITEM.with(|item| {
            let mut item = item.borrow_mut();
            let Some(item) = item.as_mut() else { return };
            item.load = None;
            item.loaded = Some(icon);
            item.repaint(side);
        });
    });
    // A load in memory has run `done` already, before it is kept here.
    ITEM.with(|item| {
        if let Some(item) = item.borrow_mut().as_mut()
            && !finished.get()
        {
            item.load = load;
        }
    });
}

impl Item {
    /// Makes the icon from the image loaded, at `side` pixels, and shows it.
    fn repaint(&mut self, side: u32) {
        let Some(loaded) = &self.loaded else { return };
        match make_icon(loaded, side) {
            Some(handle) => {
                self.icon.release();
                self.icon = Icon {
                    handle,
                    owned: true,
                };
                self.show();
            }
            None => log::warn!("tray icon: cannot make an icon"),
        }
    }

    fn data(&self) -> NOTIFYICONDATAW {
        NOTIFYICONDATAW {
            cbSize: size_of::<NOTIFYICONDATAW>() as u32,
            hWnd: self.hwnd,
            uID: UID,
            ..Default::default()
        }
    }

    /// Adds the icon, or brings it up to date.
    fn show(&self) {
        let mut data = self.data();
        data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP;
        data.uCallbackMessage = WM_NSH_TRAY;
        data.hIcon = self.icon.handle;
        let tip = if self.tray.tooltip.is_empty() {
            app_name(self.hwnd)
        } else {
            self.tray.tooltip.clone()
        };
        for (to, from) in data
            .szTip
            .iter_mut()
            .zip(tip.encode_utf16().take(MAX_TIP - 1))
        {
            *to = from;
        }
        if self.added.get() && notify(NIM_MODIFY, &data) {
            return;
        }
        if notify(NIM_ADD, &data) {
            self.added.set(true);
            data.Anonymous.uVersion = NOTIFYICON_VERSION_4;
            notify(NIM_SETVERSION, &data);
        } else {
            // The taskbar is not there yet; `TaskbarCreated` adds it.
            self.added.set(false);
        }
    }
}

fn notify(message: NOTIFY_ICON_MESSAGE, data: &NOTIFYICONDATAW) -> bool {
    // SAFETY: `data` is a complete structure of its own size.
    unsafe { Shell_NotifyIconW(message, data) }.as_bool()
}

/// `WM_NSH_TRAY`: the user acted on the icon.
pub(crate) fn message(surface: &Rc<Surface>, hwnd: HWND, wparam: WPARAM, lparam: LPARAM) {
    let event = (lparam.0 as u32) & 0xFFFF;
    let found = ITEM.with(|item| {
        item.borrow()
            .as_ref()
            .filter(|i| i.hwnd == hwnd)
            .map(|i| (i.tray.click, i.tray.menu.clone()))
    });
    let Some((click, menu)) = found else { return };
    // The icon's position, in screen pixels.
    let anchor = POINT {
        x: i32::from(wparam.0 as u16 as i16),
        y: i32::from((wparam.0 >> 16) as u16 as i16),
    };
    let primary = event == NIN_SELECT || event == NIN_KEYSELECT;
    if primary && click != 0 {
        let mut payload = vec![("id", PayloadValue::Number(f64::from(click)))];
        if let Some(bounds) = icon_bounds(hwnd) {
            payload.push(("bounds", PayloadValue::Bounds(bounds)));
        }
        surface.event(ROOT_ID, EventKind::Menu, EventPayload::Map(payload));
    } else if (primary || event == WM_CONTEXTMENU) && !menu.is_empty() {
        let mut p = anchor;
        // SAFETY: a plain call with a local point.
        let _ = unsafe { ScreenToClient(surface.hwnd(), &mut p) };
        let scale = surface.scale();
        crate::chrome::popup_tray(surface, menu, (p.x as f32 / scale, p.y as f32 / scale));
    }
}

/// The icon's frame in screen points, where the taskbar (or its overflow)
/// shows it.
fn icon_bounds(hwnd: HWND) -> Option<Bounds<Points>> {
    let id = NOTIFYICONIDENTIFIER {
        cbSize: size_of::<NOTIFYICONIDENTIFIER>() as u32,
        hWnd: hwnd,
        uID: UID,
        ..Default::default()
    };
    // SAFETY: a complete structure of its own size.
    let rect = unsafe { Shell_NotifyIconGetRect(&id) }.ok()?;
    crate::window_state::screen_bounds(rect)
}

/// The message Explorer broadcasts when the taskbar is made: when it
/// restarts, which forgets every icon.
pub(crate) fn taskbar_created() -> u32 {
    static MESSAGE: OnceLock<u32> = OnceLock::new();
    // SAFETY: a valid string.
    *MESSAGE.get_or_init(|| unsafe { RegisterWindowMessageW(w!("TaskbarCreated")) })
}

/// The taskbar was made anew: the icon goes back on it.
pub(crate) fn readd(hwnd: HWND) {
    ITEM.with(|item| {
        if let Some(item) = item.borrow().as_ref()
            && item.hwnd == hwnd
        {
            item.added.set(false);
            item.show();
        }
    });
}

/// The window moved to a screen of another DPI, or the taskbar's colors
/// changed: the icon is made again.
pub(crate) fn refresh(hwnd: HWND) {
    ITEM.with(|item| {
        if let Some(item) = item.borrow_mut().as_mut()
            && item.hwnd == hwnd
        {
            let (side, _) = icon_size(hwnd);
            item.repaint(side);
        }
    });
}

/// `hwnd` is being destroyed: its icon goes.
pub(crate) fn destroyed(hwnd: HWND) {
    let mine = ITEM.with(|item| item.borrow().as_ref().is_some_and(|i| i.hwnd == hwnd));
    if mine {
        ITEM.with(|item| item.borrow_mut().take());
    }
}

/// The icon's side in pixels and the image's scale for it.
fn icon_size(hwnd: HWND) -> (u32, f32) {
    // SAFETY: a plain query.
    let side = unsafe { GetSystemMetricsForDpi(SM_CXSMICON, crate::window::dpi(hwnd)) };
    let side = side.max(1) as u32;
    (side, side as f32 / menu_icon::SIDE.0)
}

/// The app's icon: the executable's first icon resource, which packaging
/// writes, else the window's small icon (the app's `.ico`), else Windows'
/// application icon. Shared, never destroyed here.
fn app_icon(hwnd: HWND) -> Icon {
    // SAFETY: plain calls; resource 1 is the icon packaging writes, and the
    // window's icon is kept by whoever set it while the window lives.
    let handle = unsafe {
        LoadIconW(Some(crate::window::instance()), PCWSTR(1 as _))
            .ok()
            .or_else(|| {
                let icon = SendMessageW(hwnd, WM_GETICON, Some(WPARAM(ICON_SMALL as usize)), None);
                (icon.0 != 0).then_some(HICON(icon.0 as _))
            })
            .or_else(|| LoadIconW(None, IDI_APPLICATION).ok())
            .unwrap_or_default()
    };
    Icon {
        handle,
        owned: false,
    }
}

/// The tooltip when the app gives none: the app's name, else the window's
/// title.
fn app_name(hwnd: HWND) -> String {
    if let Some(name) = crate::notifications::app_name() {
        return name;
    }
    let mut text = [0u16; MAX_TIP];
    // SAFETY: a plain query into a local buffer.
    let len = unsafe { GetWindowTextW(hwnd, &mut text) }.max(0) as usize;
    String::from_utf16_lossy(&text[..len])
}

/// The color of a template icon: the taskbar's text.
fn template_color() -> Color {
    if crate::system::taskbar_dark() {
        Color::rgba(255, 255, 255, 255)
    } else {
        Color::rgba(0, 0, 0, 255)
    }
}

/// An icon of `icon`, `side` pixels square.
fn make_icon(icon: &crate::image::MenuIcon, side: u32) -> Option<HICON> {
    let (width, height) = icon.frame.size();
    let mut pixels = menu_icon::canvas(icon.frame.data(), width, height, side);
    if icon.template {
        menu_icon::tint(&mut pixels, template_color());
    }
    unpremultiply(&mut pixels);
    let info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: side as i32,
            // Top-down, as the pixels are.
            biHeight: -(side as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bits = std::ptr::null_mut();
    // SAFETY: the header describes a DIB section of `side` rows of `side`
    // 32-bit pixels, which it allocates and `bits` points to; the bitmaps
    // are released once the icon has copied them.
    unsafe {
        let color = CreateDIBSection(None, &info, DIB_RGB_COLORS, &mut bits, None, 0).ok()?;
        if bits.is_null() {
            let _ = DeleteObject(HGDIOBJ(color.0));
            return None;
        }
        let out = std::slice::from_raw_parts_mut(bits.cast::<u8>(), pixels.len());
        out.copy_from_slice(&pixels);
        // A 32-bit color bitmap carries the alpha, so the mask stays empty.
        let mask = CreateBitmap(side as i32, side as i32, 1, 1, None);
        let icon = CreateIconIndirect(&ICONINFO {
            fIcon: true.into(),
            hbmMask: mask,
            hbmColor: color,
            ..Default::default()
        });
        let _ = DeleteObject(HGDIOBJ(mask.0));
        let _ = DeleteObject(HGDIOBJ(color.0));
        icon.ok()
    }
}

/// Premultiplied BGRA to straight alpha, which icons take.
fn unpremultiply(pixels: &mut [u8]) {
    for px in pixels.as_chunks_mut::<4>().0 {
        let a = px[3];
        if a != 0 && a != 255 {
            for c in &mut px[..3] {
                *c = ((u16::from(*c) * 255 + u16::from(a) / 2) / u16::from(a)).min(255) as u8;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpremultiplies() {
        let mut px = [64, 32, 0, 128, 10, 20, 30, 255, 0, 0, 0, 0];
        unpremultiply(&mut px);
        assert_eq!(px, [128, 64, 0, 128, 10, 20, 30, 255, 0, 0, 0, 0]);
    }
}
