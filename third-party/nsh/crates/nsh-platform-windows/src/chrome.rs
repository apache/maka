//! The window's chrome (`nsh/desktop`): its title, the hidden title bar,
//! full screen, the menu bar and context menus.
//!
//! - **Hidden title bar** ([`TitleBarStyle::Hidden`]): `WM_NCCALCSIZE`
//!   gives the client area the window's whole height (the side and bottom
//!   resize borders stay non-client, invisible as on any Windows 10 / 11
//!   window), and `WM_NCHITTEST` answers for the top: its resize border,
//!   the caption buttons (`HTMINBUTTON`, `HTMAXBUTTON`, `HTCLOSE`, so that
//!   Windows 11 shows its snap layouts over the maximize button) and the
//!   views marked `windowDrag` (`HTCAPTION`: the system moves the window,
//!   maximizes it on a double click and opens its menu on a right click).
//!   The caption buttons are drawn over the app ([`draw`]), in Windows 11's
//!   style, following the app's appearance; non-client clicks on them are
//!   handled here, never by `DefWindowProc`, which would draw Windows 95's.
//! - **Drag regions** work with the system title bar too: a view marked
//!   `windowDrag` answers `HTCAPTION` anywhere.
//! - **Menus** are Win32 menus: the menu bar (`SetMenu`, not shown while
//!   the title bar is hidden) and `TrackPopupMenuEx` for context menus,
//!   both themed dark with the app (uxtheme's `SetPreferredAppMode` for the
//!   menus, the `WM_UAHDRAWMENU*` messages for the bar, which has no dark
//!   theme of its own). Their shortcuts are matched here before the keys
//!   reach the app; the editing roles act on the focused text field by
//!   sending it their keys.
//! - **Menu icons** are `hbmpItem` bitmaps: 32-bit premultiplied DIB sections
//!   of `SM_CXSMICON` at the window's DPI, which Windows alpha blends, set
//!   as each icon arrives from the image loader and kept with their menu
//!   ([`MenuIcons`]). A popup is sized when it opens, so a context menu waits
//!   for its icons, at most [`ICON_WAIT`], before it opens (the message loop
//!   keeps running meanwhile). Windows has no
//!   template bitmaps: an SVG is painted in the text color of the menu's
//!   theme when it is made, and the menu bar's are made again when the
//!   appearance or the DPI changes.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::Arc,
    time::Duration,
};

use nsh_core::{
    Color, EventKind, EventPayload, ImageSource, PayloadValue, ROOT_ID,
    desktop::{DesktopCommand, Key, MenuAction, MenuItem, MenuRole, Shortcut, menu_icon},
    geometry::{Edges, Points},
};
use windows::{
    Win32::{
        Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
        Graphics::{
            Direct2D::ID2D1DeviceContext,
            Gdi::{
                BI_RGB, BITMAPINFO, BITMAPINFOHEADER, COLOR_GRAYTEXT, COLOR_MENUTEXT,
                CreateDIBSection, CreateSolidBrush, DIB_RGB_COLORS, DT_CENTER, DT_HIDEPREFIX,
                DT_SINGLELINE, DT_VCENTER, DeleteObject, DrawTextW, FillRect, GetSysColor,
                GetWindowDC, HBITMAP, HDC, ReleaseDC, SetBkMode, SetTextColor, TRANSPARENT,
            },
        },
        System::LibraryLoader::{GetProcAddress, LoadLibraryW},
        UI::{
            Controls::{
                DRAWITEMSTRUCT, ODS_DISABLED, ODS_GRAYED, ODS_HOTLIGHT, ODS_INACTIVE, ODS_NOACCEL,
                ODS_SELECTED,
            },
            HiDpi::GetSystemMetricsForDpi,
            Input::KeyboardAndMouse::{
                TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT, TrackMouseEvent, VIRTUAL_KEY, VK_BACK,
                VK_DELETE, VK_DOWN, VK_END, VK_ESCAPE, VK_F1, VK_F24, VK_HOME, VK_INSERT, VK_LEFT,
                VK_NEXT, VK_OEM_1, VK_OEM_2, VK_OEM_3, VK_OEM_4, VK_OEM_5, VK_OEM_6, VK_OEM_7,
                VK_OEM_COMMA, VK_OEM_MINUS, VK_OEM_PERIOD, VK_OEM_PLUS, VK_PRIOR, VK_RETURN,
                VK_RIGHT, VK_SPACE, VK_TAB, VK_UP,
            },
            WindowsAndMessaging::*,
        },
    },
    core::{PCSTR, PCWSTR, w},
};
use windows_numerics::Vector2;

use crate::{
    input::{KeyEvent, Modifiers},
    render::{color_f, rect_f},
    surface::Surface,
};

/// The hidden title bar's height when the app gives none, in points
/// (Windows 11's caption).
const DEFAULT_CAPTION_HEIGHT: f32 = 32.0;

/// A caption button's width, in points.
const BUTTON_WIDTH: f32 = 46.0;

/// The undocumented messages that draw the menu bar (uxtheme's
/// "UAH" menus): the whole bar, then each item.
const WM_UAHDRAWMENU: u32 = 0x0091;
const WM_UAHDRAWMENUITEM: u32 = 0x0092;

/// What `WM_UAHDRAWMENU` points to.
#[repr(C)]
struct UahMenu {
    hmenu: HMENU,
    hdc: HDC,
    flags: u32,
}

/// What `WM_UAHDRAWMENUITEM` points to.
#[repr(C)]
struct UahDrawMenuItem {
    dis: DRAWITEMSTRUCT,
    um: UahMenu,
    /// The item's position in the bar (then metrics nobody reads here).
    position: i32,
}

/// An item of a Win32 menu: what choosing it does.
#[derive(Clone, Copy)]
struct Entry {
    /// The app's id (0: none).
    id: u32,
    role: Option<MenuRole>,
}

/// A context menu: its items and where it shows.
struct Popup {
    items: Arc<[MenuItem]>,
    at: Option<(f32, f32)>,
    /// What the items of a menu of the platform's own do, by id - 1 (the
    /// app's menus report their ids instead).
    actions: Vec<Action>,
    /// The app's `Menu.popup` waits for it to close (the tray's menu is
    /// not one the app awaits).
    awaited: bool,
}

/// What an item of a menu of the platform's own does.
pub(crate) type Action = Rc<dyn Fn(&Rc<Surface>)>;

/// A surface's chrome.
#[derive(Default)]
pub(crate) struct Chrome {
    /// The application menu.
    menu: RefCell<Option<Arc<[MenuItem]>>>,
    /// The menu bar shown (`HMENU`, 0 for none).
    bar: Cell<isize>,
    /// What the menu bar's items do, by command id - 1.
    entries: RefCell<Vec<Entry>>,
    /// The icons of the menu bar.
    bar_icons: RefCell<MenuIcons>,
    /// The context menu to show once the batch is applied.
    popup: RefCell<Option<Popup>>,
    /// The loads of its icons, which it opens once it has or after
    /// [`ICON_WAIT`].
    popup_icons: RefCell<Vec<crate::image::Load>>,
    /// The app's context menu tracking now, and the item a test chose
    /// from it (`nsh test --target windows`), carried out once it closes.
    #[cfg(feature = "dev")]
    tracked_popup: RefCell<Option<Arc<[MenuItem]>>>,
    #[cfg(feature = "dev")]
    test_choice: Cell<Option<(u32, Option<MenuRole>)>>,
}

/// Chooses the item of the app's open context menu at the end of `path`
/// (the labels of the submenus on the way, then its own), as a click on it
/// does: the menu ends, then the item is carried out (`nsh test --target
/// windows`).
#[cfg(feature = "dev")]
pub(crate) fn choose_open_menu(surface: &Surface, path: &[String]) -> Result<(), String> {
    let items = surface
        .chrome
        .tracked_popup
        .borrow()
        .clone()
        .ok_or("no context menu is open")?;
    let mut level: &[MenuItem] = &items;
    for (n, label) in path.iter().enumerate() {
        let last = n + 1 == path.len();
        let item = level
            .iter()
            .find(|item| match item {
                MenuItem::Action(action) => last && action.label == *label,
                MenuItem::Submenu { label: l, .. } => !last && l == label,
                MenuItem::Separator => false,
            })
            .ok_or_else(|| format!("the menu has no item {label:?}"))?;
        match item {
            MenuItem::Action(action) => {
                surface
                    .chrome
                    .test_choice
                    .set(Some((action.id, action.role)));
            }
            MenuItem::Submenu { items, .. } => level = items,
            MenuItem::Separator => {}
        }
    }
    // SAFETY: ends the menu this thread tracks.
    let _ = unsafe { EndMenu() };
    Ok(())
}

/// Closes the app's open context menu with nothing chosen.
#[cfg(feature = "dev")]
pub(crate) fn close_open_menu(surface: &Surface) -> Result<(), String> {
    if surface.chrome.tracked_popup.borrow().is_none() {
        return Err("no context menu is open".into());
    }
    // SAFETY: ends the menu this thread tracks.
    let _ = unsafe { EndMenu() };
    Ok(())
}

fn top_level(hwnd: HWND) -> bool {
    crate::window_state::top_level(hwnd)
}

fn zoomed(hwnd: HWND) -> bool {
    // SAFETY: a plain query.
    unsafe { IsZoomed(hwnd) }.as_bool()
}

/// The attributes of top-level window `hwnd` (the main one or one of the
/// app's own), outside full screen, which has no frame of any kind.
fn framed_attrs(hwnd: HWND) -> Option<crate::shell::Attrs> {
    if hwnd.is_invalid() || !top_level(hwnd) || crate::window::is_full_screen(hwnd) {
        return None;
    }
    crate::window::shell(hwnd).map(|s| s.attrs())
}

/// The window's title bar is hidden now: the system frame stays, the
/// caption buttons are drawn over the app.
fn hidden(hwnd: HWND) -> bool {
    framed_attrs(hwnd).is_some_and(|a| a.hidden_title_bar())
}

/// The window has no system frame now: its client area is all of it.
fn frameless(hwnd: HWND) -> bool {
    framed_attrs(hwnd).is_some_and(|a| a.frameless())
}

/// The window's title bar is the app's now (hidden, or no frame): the menu
/// bar does not show.
fn custom_caption(hwnd: HWND) -> bool {
    framed_attrs(hwnd).is_some_and(|a| a.custom_caption())
}

/// The hidden title bar's height, in points: the app's, else Windows'.
fn caption_height(hwnd: HWND) -> f32 {
    crate::window::shell(hwnd)
        .and_then(|s| s.attrs().title_bar.height)
        .map_or(DEFAULT_CAPTION_HEIGHT, |h| h.0)
}

/// The resize border's thickness in pixels (also what a maximized window
/// hangs off its monitor by).
fn frame_thickness(hwnd: HWND) -> i32 {
    let dpi = crate::window::dpi(hwnd);
    // SAFETY: plain metric queries.
    unsafe {
        GetSystemMetricsForDpi(SM_CYFRAME, dpi) + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi)
    }
}

/// Pixels per point of window `hwnd`: the surface's for its own window, the
/// monitor's for one of the app's own.
fn scale_of(surface: &Surface, hwnd: HWND) -> f32 {
    match crate::window::app_window_root(hwnd) {
        Some(_) => crate::window::dpi(hwnd) as f32 / 96.0,
        None => surface.scale(),
    }
}

/// The width of the window's client area, in points.
fn client_width(surface: &Surface, hwnd: HWND) -> f32 {
    let mut rect = RECT::default();
    // SAFETY: a query with a local out value.
    let _ = unsafe { GetClientRect(hwnd, &mut rect) };
    (rect.right - rect.left) as f32 / scale_of(surface, hwnd)
}

/// The area of window `hwnd`'s title bar while the app's: its height and
/// the width the drawn caption buttons take; nothing while the system's.
pub(crate) fn title_bar_area(hwnd: HWND) -> Edges<Points> {
    match framed_attrs(hwnd) {
        Some(attrs) if attrs.hidden_title_bar() => Edges {
            top: Points(caption_height(hwnd)),
            right: Points(crate::shell::caption_buttons(&attrs).len() as f32 * BUTTON_WIDTH),
            bottom: Points(0.0),
            left: Points(0.0),
        },
        _ => Edges::default(),
    }
}

/// Tells the app the title bar's area of window `hwnd`: the environment's
/// for the main window, an event for one of the app's own.
fn update_area(surface: &Surface, hwnd: HWND) {
    let area = title_bar_area(hwnd);
    match crate::window::app_window_root(hwnd) {
        Some(id) => crate::app_window::title_bar_changed(surface, id, area),
        None => {
            let mut env = surface.environment.get();
            if env.title_bar != area {
                env.title_bar = area;
                surface.set_environment(env);
            }
        }
    }
}

/// The frame of window `hwnd` changed (its title bar, its frame, its
/// buttons): it recomputes its client area, and the menu bar and the
/// title bar's area follow.
pub(crate) fn frame_changed(surface: &Surface, hwnd: HWND) {
    // SAFETY: a plain call on a live window.
    let _ = unsafe {
        SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        )
    };
    if crate::window::app_window_root(hwnd).is_none() {
        show_menu_bar(surface);
    }
    update_area(surface, hwnd);
    crate::window::invalidate(hwnd);
    surface.invalidate();
}

// --- Commands ---------------------------------------------------------------------------

/// A desktop command on the main window (on the root).
pub(crate) fn command(surface: &Rc<Surface>, command: &DesktopCommand) {
    let hwnd = surface.hwnd();
    if hwnd.is_invalid() {
        return;
    }
    // The embedding app owns its window and the shell's integration: only
    // context menus work there.
    if !top_level(hwnd) {
        match command {
            DesktopCommand::PopupMenu { .. } => {}
            DesktopCommand::RegisterGlobalShortcut { id, .. } => {
                crate::global_shortcut::answer(surface, *id, false);
                return;
            }
            _ => return,
        }
    }
    let c = &surface.chrome;
    match command {
        DesktopCommand::SetAttributes(diff) => crate::shell::apply(surface, hwnd, diff),
        DesktopCommand::Request(request) => {
            if !crate::shell::request(hwnd, request) {
                // `Request(Close)`: past `closeOnPress`.
                crate::window_close::close(surface);
            }
        }
        // A window of the app's own's ([`crate::app_window`]).
        DesktopCommand::OpenWindow(_) => {}
        DesktopCommand::Quit => quit(surface),
        // Quits as above, then the runner starts the app again; an
        // embedding app's window is its own.
        DesktopCommand::Restart => {
            if crate::app::request_restart() {
                quit(surface);
            }
        }
        DesktopCommand::SetMenu(menu) => {
            *c.menu.borrow_mut() = menu.clone();
            show_menu_bar(surface);
        }
        // The Win32 menu bar always shows.
        DesktopCommand::SetMenuBar(_) => {}
        DesktopCommand::PopupMenu { items, at } => popup(
            surface,
            Popup {
                items: items.clone(),
                at: at.map(|p| (p.x.0, p.y.0)),
                actions: Vec::new(),
                awaited: true,
            },
        ),
        DesktopCommand::SetTray(tray) => crate::tray::set(surface, tray.as_ref()),
        DesktopCommand::RegisterGlobalShortcut { id, shortcut } => {
            crate::global_shortcut::register(surface, *id, shortcut);
        }
        DesktopCommand::UnregisterGlobalShortcut(id) => {
            crate::global_shortcut::unregister(surface, *id)
        }
    }
}

/// Asks the message loop to show the context menu waiting; it takes the
/// menu, so a second ask does nothing.
fn post_popup(hwnd: HWND) {
    // SAFETY: posting to a window of this thread.
    let _ = unsafe { PostMessageW(Some(hwnd), crate::window::WM_NSH_MENU, WPARAM(0), LPARAM(0)) };
}

/// Shows `menu` from the message loop: `TrackPopupMenuEx` runs one of its
/// own, which must not run while a batch is applied or an event handled.
/// With icons not in memory, once they have loaded ([`ICON_WAIT`] at most):
/// loaded, they are in memory when [`show_popup`] asks for them.
fn popup(surface: &Surface, menu: Popup) {
    let hwnd = surface.hwnd();
    let mut sources = Vec::new();
    MenuItem::each_icon(&menu.items, &mut |icon| sources.push(icon.clone()));
    *surface.chrome.popup.borrow_mut() = Some(menu);
    if sources.is_empty() {
        post_popup(hwnd);
        return;
    }
    let (_, scale) = icon_size(hwnd);
    let waiting = Rc::new(Cell::new(sources.len()));
    let loads = sources
        .iter()
        .filter_map(|source| {
            let waiting = waiting.clone();
            crate::image::load_menu_icon(surface, source, scale, move |_| {
                waiting.set(waiting.get() - 1);
                if waiting.get() == 0 {
                    post_popup(hwnd);
                }
            })
        })
        .collect();
    *surface.chrome.popup_icons.borrow_mut() = loads;
    crate::image::after(ICON_WAIT, move || post_popup(hwnd));
}

/// An item of a menu of the platform's own ([`popup_actions`]).
pub(crate) enum LocalItem {
    /// A line between groups.
    Separator,
    /// An item.
    Item {
        /// Its role: the label and shortcut shown (the action does the
        /// work).
        role: Option<MenuRole>,
        /// A label of its own (else the role's).
        label: &'static str,
        /// It can be chosen.
        enabled: bool,
        /// What choosing it does.
        action: Action,
    },
}

/// Shows a context menu of the platform's own (a text field's) at the
/// pointer.
pub(crate) fn popup_actions(surface: &Surface, items: Vec<LocalItem>) {
    let mut actions = Vec::new();
    let items: Vec<MenuItem> = items
        .into_iter()
        .map(|item| match item {
            LocalItem::Separator => MenuItem::Separator,
            LocalItem::Item {
                role,
                label,
                enabled,
                action,
            } => {
                actions.push(action);
                MenuItem::Action(MenuAction {
                    id: actions.len() as u32,
                    label: if label.is_empty() {
                        role.map_or("", MenuRole::label).to_owned()
                    } else {
                        label.to_owned()
                    },
                    shortcut: role.and_then(|r| r.shortcut(false)),
                    enabled,
                    checked: None,
                    role: None,
                    when: nsh_core::keymap::When::Always,
                    icon: None,
                })
            }
        })
        .collect();
    popup(
        surface,
        Popup {
            items: items.into(),
            at: None,
            actions,
            awaited: false,
        },
    );
}

/// Shows the tray icon's menu at `at` (in the window's points): its items
/// are reported as the app's context menus' are.
pub(crate) fn popup_tray(surface: &Surface, items: Arc<[MenuItem]>, at: (f32, f32)) {
    popup(
        surface,
        Popup {
            items,
            at: Some(at),
            actions: Vec::new(),
            awaited: false,
        },
    );
}

/// Quits the app, as its `quit` role: the windows close without asking
/// (`closeOnPress` is not read), then the message loop ends, also while a
/// tray icon would keep it running.
fn quit(surface: &Surface) {
    crate::window_close::close(surface);
    // SAFETY: a plain call. The loop gets `WM_QUIT` only after the posted
    // close: the window closes first.
    unsafe { PostQuitMessage(0) };
}

fn toggle_maximize(hwnd: HWND) {
    if crate::window::is_full_screen(hwnd) {
        return;
    }
    let show = if zoomed(hwnd) {
        SW_RESTORE
    } else {
        SW_MAXIMIZE
    };
    // SAFETY: a plain call.
    let _ = unsafe { ShowWindow(hwnd, show) };
}

/// Window `hwnd` entered or left full screen: the menu bar and the title
/// bar's area follow (neither shows in full screen).
pub(crate) fn full_screen_changed(surface: &Surface, hwnd: HWND) {
    if crate::window::app_window_root(hwnd).is_none() {
        show_menu_bar(surface);
    }
    update_area(surface, hwnd);
    crate::window::invalidate(hwnd);
    surface.invalidate();
}

// --- The app's title bar ----------------------------------------------------------------

/// `WM_NCCALCSIZE`: with the title bar hidden, the client area reaches the
/// window's top; without a frame, it is the whole window.
pub(crate) fn nc_calc_size(hwnd: HWND, wparam: WPARAM, lparam: LPARAM) -> Option<LRESULT> {
    if wparam.0 == 0 {
        return None;
    }
    if frameless(hwnd) {
        // SAFETY: with `wparam` TRUE, `lparam` is the window's
        // NCCALCSIZE_PARAMS, valid for the message.
        unsafe {
            let params = &mut *(lparam.0 as *mut NCCALCSIZE_PARAMS);
            // A maximized window hangs off its monitor by its resize
            // border: the content stays on the monitor.
            if zoomed(hwnd) {
                let inset = frame_thickness(hwnd);
                let r = &mut params.rgrc[0];
                r.left += inset;
                r.top += inset;
                r.right -= inset;
                r.bottom -= inset;
            }
        }
        return Some(LRESULT(0));
    }
    if !hidden(hwnd) {
        return None;
    }
    // SAFETY: as above.
    unsafe {
        let params = &mut *(lparam.0 as *mut NCCALCSIZE_PARAMS);
        let top = params.rgrc[0].top;
        DefWindowProcW(hwnd, WM_NCCALCSIZE, wparam, lparam);
        // A maximized window hangs off its monitor by its resize border;
        // otherwise Windows 11 draws its border along the window's top edge,
        // over whatever is there: the app starts below it, so that its
        // title bar is all visible (and centered as laid out).
        params.rgrc[0].top = top
            + if zoomed(hwnd) {
                frame_thickness(hwnd)
            } else {
                top_border(hwnd)
            };
    }
    Some(LRESULT(0))
}

/// The visible border the system draws along a window's top edge, in
/// pixels (Windows 11; 0 where there is none).
fn top_border(hwnd: HWND) -> i32 {
    use windows::Win32::Graphics::Dwm::{
        DWMWA_VISIBLE_FRAME_BORDER_THICKNESS, DwmGetWindowAttribute,
    };
    let mut thickness: u32 = 0;
    // SAFETY: a u32 out value, as the attribute is.
    let ok = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_VISIBLE_FRAME_BORDER_THICKNESS,
            &mut thickness as *mut u32 as *mut _,
            std::mem::size_of::<u32>() as u32,
        )
    }
    .is_ok();
    if ok { thickness.min(8) as i32 } else { 0 }
}

/// The drawn caption button at `(x, y)` (points) of window `hwnd`, as its
/// hit test code.
fn caption_at(surface: &Surface, hwnd: HWND, x: f32, y: f32) -> Option<u32> {
    let attrs = framed_attrs(hwnd).filter(|a| a.hidden_title_bar())?;
    if !(0.0..caption_height(hwnd)).contains(&y) {
        return None;
    }
    let from_right = client_width(surface, hwnd) - x;
    if from_right < 0.0 {
        return None;
    }
    let i = (from_right / BUTTON_WIDTH).floor() as usize;
    crate::shell::caption_buttons(&attrs).get(i).copied()
}

/// `WM_NCHITTEST`: what the pointer is over, for the system to move,
/// resize and snap the window by. In order: a click-through window is
/// not there; the system's borders; a frameless window's own border and a
/// hidden title bar's top border; the drawn caption buttons; the views
/// marked `windowResize`, `windowControl` and `windowDrag`.
pub(crate) fn nc_hit_test(surface: &Surface, hwnd: HWND, lparam: LPARAM) -> Option<LRESULT> {
    let attrs = crate::window::shell(hwnd)
        .map(|s| s.attrs())
        .unwrap_or_default();
    if attrs.click_through {
        return Some(LRESULT(HTTRANSPARENT as isize));
    }
    let result = |code: u32| {
        Some(LRESULT(
            crate::shell::allowed(code, &attrs, zoomed(hwnd)) as isize
        ))
    };
    // SAFETY: default handling finds the non-client resize borders.
    let default = unsafe { DefWindowProcW(hwnd, WM_NCHITTEST, WPARAM(0), lparam) }.0 as u32;
    if default != HTCLIENT {
        return result(default);
    }
    let mut p = POINT {
        x: (lparam.0 & 0xFFFF) as i16 as i32,
        y: ((lparam.0 >> 16) & 0xFFFF) as i16 as i32,
    };
    // SAFETY: a plain call with a local value.
    let _ = unsafe { windows::Win32::Graphics::Gdi::ScreenToClient(hwnd, &mut p) };
    let scale = scale_of(surface, hwnd);
    let (x, y) = (p.x as f32 / scale, p.y as f32 / scale);
    let border = frame_thickness(hwnd);
    if frameless(hwnd) && attrs.resizable && !zoomed(hwnd) {
        let mut client = RECT::default();
        // SAFETY: a query with a local out value.
        let _ = unsafe { GetClientRect(hwnd, &mut client) };
        if let Some(code) = crate::shell::border_code(p, (client.right, client.bottom), border) {
            return result(code);
        }
    }
    if hidden(hwnd) {
        if attrs.resizable && !zoomed(hwnd) && p.y < border {
            let mut client = RECT::default();
            // SAFETY: a query with a local out value.
            let _ = unsafe { GetClientRect(hwnd, &mut client) };
            let code = if p.x < border * 2 {
                HTTOPLEFT
            } else if p.x >= client.right - border * 2 {
                HTTOPRIGHT
            } else {
                HTTOP
            };
            return result(code);
        }
        if let Some(code) = caption_at(surface, hwnd, x, y) {
            return Some(LRESULT(code as isize));
        }
    }
    let code = match crate::input::window_part(surface, x, y) {
        Some(crate::input::WindowPart::Resize(edge)) => crate::shell::edge_code(edge),
        Some(crate::input::WindowPart::Control(control)) => {
            crate::shell::control_code(control, &attrs)
        }
        Some(crate::input::WindowPart::Drag) => HTCAPTION,
        None => HTCLIENT,
    };
    result(code)
}

fn is_button(code: u32) -> bool {
    matches!(code, HTMINBUTTON | HTMAXBUTTON | HTCLOSE)
}

fn set_hover(surface: &Surface, hwnd: HWND, code: u32) {
    if let Some(shell) = crate::window::shell(hwnd)
        && shell.hover.replace(code) != code
    {
        crate::window::invalidate(hwnd);
        surface.invalidate();
    }
}

/// Non-client mouse messages over the caption buttons, drawn or the app's
/// (`windowControl`): their presses are carried out here, never by
/// `DefWindowProc`, which would draw Windows 95's buttons. The views of the
/// app's title bar hear the pointer move over them (their hover styles).
pub(crate) fn nc_mouse(
    surface: &Rc<Surface>,
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> Option<LRESULT> {
    let shell = crate::window::shell(hwnd)?;
    let code = wparam.0 as u32;
    let mut p = POINT {
        x: (lparam.0 & 0xFFFF) as i16 as i32,
        y: ((lparam.0 >> 16) & 0xFFFF) as i16 as i32,
    };
    // SAFETY: a plain call with a local value.
    let _ = unsafe { windows::Win32::Graphics::Gdi::ScreenToClient(hwnd, &mut p) };
    let scale = scale_of(surface, hwnd);
    let (x, y) = (p.x as f32 / scale, p.y as f32 / scale);
    let drawn = caption_at(surface, hwnd, x, y).is_some();
    match msg {
        WM_NCMOUSEMOVE => {
            if !shell.nc_tracking.replace(true) {
                let mut track = TRACKMOUSEEVENT {
                    cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                    dwFlags: TME_LEAVE | TME_NONCLIENT,
                    hwndTrack: hwnd,
                    dwHoverTime: 0,
                };
                // SAFETY: a valid structure for this window.
                let _ = unsafe { TrackMouseEvent(&mut track) };
            }
            set_hover(
                surface,
                hwnd,
                if is_button(code) && drawn { code } else { 0 },
            );
            // Over the app's title bar's views (not the drawn buttons, not
            // the borders): they hear it as the client area's moves.
            let on_view = !drawn && matches!(code, HTCAPTION | HTMINBUTTON | HTMAXBUTTON | HTCLOSE);
            if on_view || shell.view_hover.get() {
                shell.view_hover.set(on_view);
                crate::window::nc_pointer(surface, on_view.then_some((x, y)));
            }
            None
        }
        WM_NCMOUSELEAVE => {
            shell.nc_tracking.set(false);
            shell.pressed.set(0);
            set_hover(surface, hwnd, 0);
            if shell.view_hover.replace(false) {
                crate::window::nc_pointer(surface, None);
            }
            None
        }
        WM_NCLBUTTONDOWN | WM_NCLBUTTONDBLCLK if is_button(code) => {
            shell.pressed.set(code);
            crate::window::invalidate(hwnd);
            surface.invalidate();
            Some(LRESULT(0))
        }
        WM_NCLBUTTONUP if is_button(code) => {
            if shell.pressed.replace(0) == code {
                let attrs = shell.attrs();
                match code {
                    HTMINBUTTON if attrs.minimizable => {
                        set_hover(surface, hwnd, 0);
                        // SAFETY: a plain call.
                        let _ = unsafe { ShowWindow(hwnd, SW_MINIMIZE) };
                    }
                    HTMAXBUTTON if attrs.can_maximize() => toggle_maximize(hwnd),
                    HTCLOSE if attrs.closable => {
                        shell.close_caption.set(true);
                        // SAFETY: posting to a live window.
                        let _ = unsafe { PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)) };
                    }
                    _ => {}
                }
            }
            crate::window::invalidate(hwnd);
            surface.invalidate();
            Some(LRESULT(0))
        }
        _ => None,
    }
}

/// Presses window `hwnd`'s close button as the user does (`nsh test`):
/// the system command its click sends, at a point on it, so that the
/// window's own close path tells the app `closeButton`. An error when the
/// window has none (no frame, a hidden title bar without one, or
/// `closable: false`).
#[cfg(feature = "dev")]
pub(crate) fn press_close_button(hwnd: HWND) -> Result<(), String> {
    use windows::Win32::Graphics::{
        Dwm::{DWMWA_CAPTION_BUTTON_BOUNDS, DwmGetWindowAttribute},
        Gdi::ClientToScreen,
    };
    let attrs = crate::window::shell(hwnd)
        .map(|s| s.attrs())
        .ok_or("not a window of the app's")?;
    if !attrs.closable {
        return Err("the window cannot be closed by the user (closable: false)".into());
    }
    if crate::window::is_full_screen(hwnd) || attrs.frameless() {
        return Err("the window has no close button (no frame, or full screen)".into());
    }
    let mut p = POINT::default();
    // SAFETY: queries with local out values on a live window.
    unsafe {
        if attrs.hidden_title_bar() {
            let mut client = RECT::default();
            let _ = GetClientRect(hwnd, &mut client);
            let scale = crate::window::dpi(hwnd) as f32 / 96.0;
            p.x = client.right - (BUTTON_WIDTH * scale / 2.0) as i32;
            p.y = (caption_height(hwnd) * scale / 2.0) as i32;
            let _ = ClientToScreen(hwnd, &mut p);
        } else {
            let mut buttons = RECT::default();
            let mut window = RECT::default();
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_CAPTION_BUTTON_BOUNDS,
                &mut buttons as *mut RECT as *mut _,
                std::mem::size_of::<RECT>() as u32,
            )
            .map_err(|e| format!("the window's caption buttons: {e}"))?;
            GetWindowRect(hwnd, &mut window).map_err(|e| e.to_string())?;
            // The close button is the rightmost.
            let height = buttons.bottom - buttons.top;
            p.x = window.left + buttons.right - height / 2;
            p.y = window.top + buttons.top + height / 2;
        }
        let at = LPARAM(((p.y as u16 as isize) << 16) | p.x as u16 as isize);
        let code = SendMessageW(hwnd, WM_NCHITTEST, None, Some(at)).0 as u32;
        if code != HTCLOSE {
            return Err("the window has no close button".into());
        }
        PostMessageW(Some(hwnd), WM_SYSCOMMAND, WPARAM(SC_CLOSE as usize), at)
            .map_err(|e| e.to_string())
    }
}

/// The mouse moved over window `hwnd`'s client area: off the caption
/// buttons.
pub(crate) fn client_mouse_moved(surface: &Surface, hwnd: HWND) {
    if crate::window::shell(hwnd).is_some_and(|s| s.hover.get() != 0) {
        set_hover(surface, hwnd, 0);
    }
}

/// `WM_NCACTIVATE`: the caption buttons dim in an inactive window. With
/// the title bar the app's, the default handling must not paint the old
/// caption over the app (`lparam` -1).
pub(crate) fn nc_activate(
    surface: &Surface,
    hwnd: HWND,
    wparam: WPARAM,
    lparam: LPARAM,
) -> Option<LRESULT> {
    if let Some(shell) = crate::window::shell(hwnd) {
        shell.inactive.set(wparam.0 == 0);
    }
    crate::window::invalidate(hwnd);
    surface.invalidate();
    if !custom_caption(hwnd) {
        // SAFETY: default handling, then the dark menu bar's line.
        let r = unsafe { DefWindowProcW(hwnd, WM_NCACTIVATE, wparam, lparam) };
        if crate::window::app_window_root(hwnd).is_none() {
            paint_menu_bar_line(surface, hwnd);
        }
        return Some(r);
    }
    // SAFETY: default handling, told not to repaint the frame.
    Some(unsafe { DefWindowProcW(hwnd, WM_NCACTIVATE, wparam, LPARAM(-1)) })
}

/// Draws the caption buttons over the app in window `hwnd` (`width`
/// points wide), with its title bar hidden.
pub(crate) fn draw(surface: &Surface, hwnd: HWND, dc: &ID2D1DeviceContext, scale: f32, width: f32) {
    let Some(attrs) = framed_attrs(hwnd).filter(|a| a.hidden_title_bar()) else {
        return;
    };
    let Some(shell) = crate::window::shell(hwnd) else {
        return;
    };
    let dark = crate::shell::dark(surface, hwnd);
    // Lines one device pixel wide, on pixel centers.
    let px = 1.0 / scale;
    let snap = |v: f32| (v * scale).round() / scale + px / 2.0;
    let glyph = 10.0;
    let caption = caption_height(hwnd);
    for (i, code) in crate::shell::caption_buttons(&attrs)
        .into_iter()
        .enumerate()
    {
        let x = width - BUTTON_WIDTH * (i + 1) as f32;
        // A window that cannot close shows its close button dimmed, inert.
        let enabled = code != HTCLOSE || attrs.closable;
        let hovered = enabled && shell.hover.get() == code;
        let pressed = hovered && shell.pressed.get() == code;
        let background = match (code == HTCLOSE, hovered, pressed, dark) {
            (_, false, ..) => None,
            (true, true, false, _) => Some(Color::rgba(0xc4, 0x2b, 0x1c, 0xff)),
            (true, true, true, _) => Some(Color::rgba(0xc4, 0x2b, 0x1c, 0xe6)),
            (false, true, false, false) => Some(Color::rgba(0, 0, 0, 0x12)),
            (false, true, true, false) => Some(Color::rgba(0, 0, 0, 0x1c)),
            (false, true, false, true) => Some(Color::rgba(0xff, 0xff, 0xff, 0x14)),
            (false, true, true, true) => Some(Color::rgba(0xff, 0xff, 0xff, 0x0c)),
        };
        let foreground = if code == HTCLOSE && hovered {
            Color(0xffff_ffff)
        } else {
            let alpha = if !enabled || (shell.inactive.get() && !hovered) {
                0x70
            } else {
                0xff
            };
            if dark {
                Color::rgba(0xff, 0xff, 0xff, alpha)
            } else {
                Color::rgba(0, 0, 0, alpha)
            }
        };
        // SAFETY: drawing on the context between its BeginDraw / EndDraw.
        unsafe {
            if let Some(bg) = background
                && let Ok(brush) = dc.CreateSolidColorBrush(&color_f(bg), None)
            {
                dc.FillRectangle(&rect_f(x, 0.0, BUTTON_WIDTH, caption), &brush);
            }
            let Ok(brush) = dc.CreateSolidColorBrush(&color_f(foreground), None) else {
                continue;
            };
            let left = snap(x + (BUTTON_WIDTH - glyph) / 2.0);
            let top = snap((caption - glyph) / 2.0);
            let (right, bottom) = (left + glyph - px, top + glyph - px);
            let line = |a: (f32, f32), b: (f32, f32)| {
                dc.DrawLine(
                    Vector2 { X: a.0, Y: a.1 },
                    Vector2 { X: b.0, Y: b.1 },
                    &brush,
                    px,
                    None,
                );
            };
            match code {
                HTMINBUTTON => {
                    let y = snap(caption / 2.0);
                    line((left, y), (right + px, y));
                }
                HTMAXBUTTON if zoomed(hwnd) => {
                    // Restore: a square with another behind it.
                    let o = 2.0;
                    dc.DrawRectangle(
                        &rect_f(left, top + o, glyph - o - px, glyph - o - px),
                        &brush,
                        px,
                        None,
                    );
                    line((left + o, top + o), (left + o, top));
                    line((left + o, top), (right, top));
                    line((right, top), (right, bottom - o));
                    line((right, bottom - o), (right - o, bottom - o));
                }
                HTMAXBUTTON => {
                    dc.DrawRectangle(&rect_f(left, top, glyph - px, glyph - px), &brush, px, None);
                }
                _ => {
                    line((left, top), (right + px, bottom + px));
                    line((right + px, top), (left, bottom + px));
                }
            }
        }
    }
}

// --- Menus ------------------------------------------------------------------------------

type SetPreferredAppMode = unsafe extern "system" fn(i32) -> i32;
type FlushMenuThemes = unsafe extern "system" fn();

/// Themes the process' menus dark (or light): uxtheme's undocumented
/// `SetPreferredAppMode` (ordinal 135, Windows 10 1903 and later) and
/// `FlushMenuThemes` (136).
fn theme_menus(dark: bool) {
    thread_local! {
        static FUNCTIONS: Option<(SetPreferredAppMode, FlushMenuThemes)> = {
            // SAFETY: uxtheme stays loaded; the ordinals have these
            // signatures on every Windows version that exports them.
            unsafe {
                LoadLibraryW(w!("uxtheme.dll")).ok().and_then(|module| {
                    let set = GetProcAddress(module, PCSTR(135 as *const u8))?;
                    let flush = GetProcAddress(module, PCSTR(136 as *const u8))?;
                    Some((
                        std::mem::transmute::<unsafe extern "system" fn() -> isize, SetPreferredAppMode>(set),
                        std::mem::transmute::<unsafe extern "system" fn() -> isize, FlushMenuThemes>(flush),
                    ))
                })
            }
        };
        static DARK: Cell<Option<bool>> = const { Cell::new(None) };
    }
    if DARK.with(|d| d.replace(Some(dark))) == Some(dark) {
        return;
    }
    FUNCTIONS.with(|f| {
        if let Some((set, flush)) = f {
            // SAFETY: the functions loaded above; 2 forces dark, 3 light.
            unsafe {
                set(if dark { 2 } else { 3 });
                flush();
            }
        }
    });
}

/// A menu item's text: `&` shows as itself, the shortcut after a tab.
fn item_text(action: &MenuAction) -> Vec<u16> {
    let label = if action.label.is_empty() {
        action.role.map_or("", MenuRole::label)
    } else {
        &action.label
    };
    let mut text = label.replace('&', "&&");
    if let Some(shortcut) = &action.shortcut {
        text.push('\t');
        text.push_str(&shortcut.label());
    }
    text.encode_utf16().chain(Some(0)).collect()
}

/// The roles Windows has no use for.
fn unsupported(role: Option<MenuRole>) -> bool {
    matches!(
        role,
        Some(MenuRole::About | MenuRole::Hide | MenuRole::HideOthers | MenuRole::ShowAll)
    )
}

/// How long a context menu waits for its icons before it opens without the
/// ones still loading: short enough not to feel like waiting, long enough
/// for a bundled file.
const ICON_WAIT: Duration = Duration::from_millis(100);

/// The bitmaps of a menu's icons: they must outlive the menu, which does
/// not own them.
#[derive(Default)]
struct IconBitmaps(Vec<HBITMAP>);

impl Drop for IconBitmaps {
    fn drop(&mut self) {
        for bitmap in self.0.drain(..) {
            // SAFETY: a bitmap made here that no menu shows any more: the
            // owner drops these after the menu (`MenuIcons`).
            let _ = unsafe { DeleteObject(bitmap.into()) };
        }
    }
}

/// What a menu's icons need while it exists: replaced or dropped once
/// the menu is destroyed or no longer shown, which gives up the loads and
/// frees the bitmaps.
#[derive(Default)]
struct MenuIcons {
    loads: Vec<crate::image::Load>,
    /// Held for the menu, dropped after `loads`.
    _bitmaps: Rc<RefCell<IconBitmaps>>,
}

/// An item whose icon is to load.
struct PendingIcon {
    menu: HMENU,
    /// The item's position in `menu`.
    position: u32,
    source: ImageSource,
    enabled: bool,
}

/// The side of a menu icon in pixels at the DPI of `hwnd` (the small icon's,
/// as Windows' own menus draw) and the pixels per point of that side.
fn icon_size(hwnd: HWND) -> (u32, f32) {
    // SAFETY: a plain query.
    let side = unsafe { GetSystemMetricsForDpi(SM_CXSMICON, crate::window::dpi(hwnd)) };
    let side = side.max(1) as u32;
    (side, side as f32 / menu_icon::SIDE.0)
}

/// The color of an SVG icon: the text of a menu in the theme [`theme_menus`]
/// sets, as Win32 draws no template. A hot item keeps its text's color in
/// both themes.
fn icon_color(dark: bool, enabled: bool) -> Color {
    // `COLORREF`s: 0x00BBGGRR.
    let color = match (dark, enabled) {
        (true, true) => BAR_TEXT,
        (true, false) => BAR_TEXT_DISABLED,
        // SAFETY: plain queries.
        (false, true) => unsafe { GetSysColor(COLOR_MENUTEXT) },
        // SAFETY: as above.
        (false, false) => unsafe { GetSysColor(COLOR_GRAYTEXT) },
    };
    let [r, g, b, _] = color.to_le_bytes();
    Color::rgba(r, g, b, 255)
}

/// A 32-bit premultiplied ARGB bitmap of `icon`, `side` × `side`. A disabled
/// item's is dimmed here: nothing documents Windows doing that for an alpha
/// bitmap.
fn icon_bitmap(
    icon: &crate::image::MenuIcon,
    side: u32,
    dark: bool,
    enabled: bool,
) -> Option<HBITMAP> {
    let (width, height) = icon.frame.size();
    let mut pixels = menu_icon::canvas(icon.frame.data(), width, height, side);
    if icon.template {
        menu_icon::tint(&mut pixels, icon_color(dark, enabled));
    } else if !enabled {
        menu_icon::fade(&mut pixels, 0.4);
    }
    let info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: side as i32,
            // Bottom-up, the layout Windows' sample for menu bitmaps uses.
            biHeight: side as i32,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bits = std::ptr::null_mut();
    // SAFETY: the header describes a DIB section of `side` rows of `side`
    // 32-bit pixels, which it allocates; `bits` is written before it is
    // read, and the rows copied are that long.
    unsafe {
        let bitmap = CreateDIBSection(None, &info, DIB_RGB_COLORS, &mut bits, None, 0).ok()?;
        if bits.is_null() {
            let _ = DeleteObject(bitmap.into());
            return None;
        }
        let stride = side as usize * 4;
        let out = std::slice::from_raw_parts_mut(bits.cast::<u8>(), stride * side as usize);
        for (to, from) in out
            .chunks_exact_mut(stride)
            .zip(pixels.chunks_exact(stride).rev())
        {
            to.copy_from_slice(from);
        }
        Some(bitmap)
    }
}

/// Loads the icons of `pending`, setting each on its item as it arrives (at
/// once when in memory, as [`show_popup`]'s are) and keeping its bitmap in
/// `bitmaps`. A load never outlives its menu: its owner gives it up first.
fn load_icons(
    surface: &Surface,
    pending: Vec<PendingIcon>,
    bitmaps: &Rc<RefCell<IconBitmaps>>,
) -> Vec<crate::image::Load> {
    let hwnd = surface.hwnd();
    let (side, scale) = icon_size(hwnd);
    let dark = crate::system::dark(surface);
    pending
        .into_iter()
        .filter_map(|item| {
            let uri = item.source.uri.clone();
            let bitmaps = bitmaps.clone();
            crate::image::load_menu_icon(surface, &item.source, scale, move |loaded| {
                let icon = match loaded {
                    Ok(icon) => icon,
                    Err(e) => {
                        log::warn!("menu icon {uri}: {e}");
                        return;
                    }
                };
                let Some(bitmap) = icon_bitmap(&icon, side, dark, item.enabled) else {
                    log::warn!("menu icon {uri}: cannot make a bitmap");
                    return;
                };
                bitmaps.borrow_mut().0.push(bitmap);
                let info = MENUITEMINFOW {
                    cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
                    fMask: MIIM_BITMAP,
                    hbmpItem: bitmap,
                    ..Default::default()
                };
                // SAFETY: a menu of this thread that exists while the load
                // does ([`MenuIcons`]); `bitmaps` keeps the bitmap as long.
                unsafe {
                    let _ = SetMenuItemInfoW(item.menu, item.position, true, &info);
                }
            })
        })
        .collect()
}

/// Appends `items` to `menu`, numbering their commands in `entries`
/// (command id = index + 1) and adding the items with an icon to `icons`,
/// but for this level's without `with_icons` (a menu bar's titles are text).
fn append(
    menu: HMENU,
    items: &[MenuItem],
    entries: &mut Vec<Entry>,
    icons: &mut Vec<PendingIcon>,
    with_icons: bool,
) {
    // The position of the item just appended.
    // SAFETY: a plain query on a live menu.
    let last = || unsafe { GetMenuItemCount(Some(menu)) }.max(1) as u32 - 1;
    let mut last_separator = true;
    for item in items {
        // SAFETY: appending to a live menu with NUL-terminated strings; a
        // submenu belongs to its parent once appended.
        unsafe {
            match item {
                MenuItem::Separator => {
                    if !last_separator {
                        let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
                        last_separator = true;
                    }
                }
                MenuItem::Action(action) => {
                    if unsupported(action.role) {
                        continue;
                    }
                    entries.push(Entry {
                        id: action.id,
                        role: action.role,
                    });
                    let mut flags = MF_STRING;
                    if !action.enabled {
                        flags |= MF_GRAYED;
                    }
                    if action.checked == Some(true) {
                        flags |= MF_CHECKED;
                    }
                    let text = item_text(action);
                    let _ = AppendMenuW(menu, flags, entries.len(), PCWSTR(text.as_ptr()));
                    if let Some(source) = action.icon.clone().filter(|_| with_icons) {
                        icons.push(PendingIcon {
                            menu,
                            position: last(),
                            source,
                            enabled: action.enabled,
                        });
                    }
                    last_separator = false;
                }
                MenuItem::Submenu {
                    label,
                    enabled,
                    items,
                    icon,
                } => {
                    let Ok(sub) = CreatePopupMenu() else { continue };
                    append(sub, items, entries, icons, true);
                    let mut flags = MF_POPUP | MF_STRING;
                    if !enabled {
                        flags |= MF_GRAYED;
                    }
                    let text: Vec<u16> = label.encode_utf16().chain(Some(0)).collect();
                    let _ = AppendMenuW(menu, flags, sub.0 as usize, PCWSTR(text.as_ptr()));
                    if let Some(source) = icon.clone().filter(|_| with_icons) {
                        icons.push(PendingIcon {
                            menu,
                            position: last(),
                            source,
                            enabled: *enabled,
                        });
                    }
                    last_separator = false;
                }
            }
        }
    }
}

/// Shows the application menu as the window's menu bar, unless the title
/// bar is hidden or the window is in full screen.
fn show_menu_bar(surface: &Surface) {
    let hwnd = surface.hwnd();
    let c = &surface.chrome;
    let menu = c.menu.borrow().clone();
    let shown = menu.filter(|_| !custom_caption(hwnd) && !crate::window::is_full_screen(hwnd));
    let mut entries = Vec::new();
    let mut icons = Vec::new();
    // The old bar's loads end now: they set items of a menu about to go.
    c.bar_icons.borrow_mut().loads.clear();
    // SAFETY: menus made, set and destroyed on this thread; the old bar is
    // destroyed once the window no longer shows it, then its bitmaps freed.
    unsafe {
        let bar = match &shown {
            Some(items) => CreateMenu()
                .ok()
                .inspect(|bar| append(*bar, items, &mut entries, &mut icons, false)),
            None => None,
        };
        theme_menus(crate::system::dark(surface));
        let _ = SetMenu(hwnd, bar);
        let old = c.bar.replace(bar.map_or(0, |b| b.0 as isize));
        if old != 0 {
            let _ = DestroyMenu(HMENU(old as *mut _));
        }
        let _ = DrawMenuBar(hwnd);
    }
    let bitmaps = Rc::default();
    let loads = load_icons(surface, icons, &bitmaps);
    *c.bar_icons.borrow_mut() = MenuIcons {
        loads,
        _bitmaps: bitmaps,
    };
    // The bar's entries; the shortcuts are matched on the whole menu.
    *c.entries.borrow_mut() = entries;
}

/// `WM_COMMAND` from the menu bar.
pub(crate) fn menu_command(surface: &Rc<Surface>, command: u16) {
    let entry = surface
        .chrome
        .entries
        .borrow()
        .get((command as usize).wrapping_sub(1))
        .copied();
    if let Some(entry) = entry {
        choose(surface, entry.id, entry.role);
    }
}

/// An item was chosen: the platform carries out its role, the app hears
/// about the rest.
fn choose(surface: &Rc<Surface>, id: u32, role: Option<MenuRole>) {
    let hwnd = surface.hwnd();
    match role {
        // An embedding app's window is its own to close or keep.
        Some(MenuRole::Quit) if top_level(hwnd) => quit(surface),
        Some(MenuRole::Quit | MenuRole::Close) => {
            // As the window menu's Close: the app hears a close press.
            if let Some(shell) = crate::window::shell(hwnd) {
                shell.close_command.set(Some(crate::shell::SysClose::Menu));
            }
            // SAFETY: posting to a live window.
            let _ = unsafe { PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)) };
        }
        Some(MenuRole::Minimize) => {
            // SAFETY: a plain call.
            let _ = unsafe { ShowWindow(hwnd, SW_MINIMIZE) };
        }
        Some(MenuRole::Zoom) => toggle_maximize(hwnd),
        Some(MenuRole::ToggleFullScreen) => crate::window::toggle_full_screen(hwnd),
        Some(role) if role.edits_text() => {
            // The focused field's own keys.
            let (vk, shift) = match role {
                MenuRole::Undo => (0x5A, false),
                MenuRole::Redo => (0x59, false),
                MenuRole::Cut => (0x58, false),
                MenuRole::Copy => (0x43, false),
                MenuRole::Paste => (0x56, false),
                _ => (0x41, false),
            };
            crate::input::key(
                surface,
                KeyEvent {
                    vk,
                    down: true,
                    repeat: false,
                    modifiers: Modifiers {
                        ctrl: true,
                        shift,
                        ..Default::default()
                    },
                },
            );
        }
        _ => {}
    }
    if id != 0 {
        surface.event(
            ROOT_ID,
            EventKind::Menu,
            EventPayload::Map(vec![("id", PayloadValue::Number(id as f64))]),
        );
    }
}

/// `WM_NSH_MENU`: shows the context menu asked for.
pub(crate) fn show_popup(surface: &Rc<Surface>) {
    let Some(Popup {
        items,
        at,
        actions,
        awaited,
    }) = surface.chrome.popup.borrow_mut().take()
    else {
        return;
    };
    let hwnd = surface.hwnd();
    let mut entries = Vec::new();
    let mut icons = Vec::new();
    let bitmaps: Rc<RefCell<IconBitmaps>> = Rc::default();
    // SAFETY: a menu made, tracked and destroyed on this thread.
    let chosen = unsafe {
        let Ok(menu) = CreatePopupMenu() else { return };
        append(menu, &items, &mut entries, &mut icons, true);
        // What loaded in time is in memory, on the items now; what did not
        // goes on them while the menu is open.
        let loads = load_icons(surface, icons, &bitmaps);
        surface.chrome.popup_icons.borrow_mut().clear();
        let mut p = POINT::default();
        match at {
            Some((x, y)) => {
                let scale = surface.scale();
                p.x = (x * scale).round() as i32;
                p.y = (y * scale).round() as i32;
                let _ = windows::Win32::Graphics::Gdi::ClientToScreen(hwnd, &mut p);
            }
            None => {
                let _ = GetCursorPos(&mut p);
            }
        }
        theme_menus(crate::system::dark(surface));
        // The window must be in front for the menu to close when clicking
        // elsewhere.
        let _ = SetForegroundWindow(hwnd);
        #[cfg(feature = "dev")]
        if actions.is_empty() {
            *surface.chrome.tracked_popup.borrow_mut() = Some(items.clone());
        }
        let chosen = TrackPopupMenuEx(
            menu,
            (TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_LEFTALIGN | TPM_TOPALIGN).0,
            p.x,
            p.y,
            hwnd,
            None,
        );
        drop(loads);
        let _ = DestroyMenu(menu);
        chosen.0 as usize
    };
    drop(bitmaps);
    #[cfg(feature = "dev")]
    {
        surface.chrome.tracked_popup.borrow_mut().take();
        if let Some((id, role)) = surface.chrome.test_choice.take() {
            choose(surface, id, role);
        }
    }
    if let Some(entry) = entries.get(chosen.wrapping_sub(1)).copied() {
        match actions.get((entry.id as usize).wrapping_sub(1)) {
            Some(action) => action(surface),
            None => choose(surface, entry.id, entry.role),
        }
    }
    // The app's `Menu.popup` promise settles.
    if awaited {
        surface.event(
            ROOT_ID,
            EventKind::Menu,
            EventPayload::Map(vec![
                ("id", PayloadValue::Number(0.0)),
                ("closed", PayloadValue::Bool(true)),
            ]),
        );
    }
}

/// The shortcut key of virtual key `vk`, if it can be one.
pub(crate) fn shortcut_key(vk: u16) -> Option<Key> {
    let k = VIRTUAL_KEY(vk);
    Some(match vk {
        0x30..=0x39 | 0x41..=0x5A => Key::Char((vk as u8 as char).to_ascii_lowercase()),
        _ if (VK_F1.0..=VK_F24.0).contains(&vk) => Key::F((vk - VK_F1.0 + 1) as u8),
        _ => match k {
            VK_RETURN => Key::Enter,
            VK_ESCAPE => Key::Escape,
            VK_TAB => Key::Tab,
            VK_BACK => Key::Backspace,
            VK_DELETE => Key::Delete,
            VK_INSERT => Key::Insert,
            VK_SPACE => Key::Space,
            VK_UP => Key::Up,
            VK_DOWN => Key::Down,
            VK_LEFT => Key::Left,
            VK_RIGHT => Key::Right,
            VK_HOME => Key::Home,
            VK_END => Key::End,
            VK_PRIOR => Key::PageUp,
            VK_NEXT => Key::PageDown,
            VK_OEM_PLUS => Key::Char('='),
            VK_OEM_MINUS => Key::Char('-'),
            VK_OEM_COMMA => Key::Char(','),
            VK_OEM_PERIOD => Key::Char('.'),
            VK_OEM_1 => Key::Char(';'),
            VK_OEM_2 => Key::Char('/'),
            VK_OEM_3 => Key::Char('`'),
            VK_OEM_4 => Key::Char('['),
            VK_OEM_5 => Key::Char('\\'),
            VK_OEM_6 => Key::Char(']'),
            VK_OEM_7 => Key::Char('\''),
            _ => return None,
        },
    })
}

/// A key pressed: the application menu's item with that shortcut is
/// chosen (true), before the app gets the key.
pub(crate) fn shortcut(surface: &Rc<Surface>, event: &KeyEvent) -> bool {
    let Some(key) = shortcut_key(event.vk) else {
        return false;
    };
    let m = event.modifiers;
    let pressed = Shortcut {
        key,
        ctrl: m.ctrl,
        alt: m.alt,
        shift: m.shift,
        meta: m.meta,
    };
    let found = {
        let menu = surface.chrome.menu.borrow();
        let Some(items) = menu.as_deref() else {
            return false;
        };
        // `plus` is the `=` key, which `shortcut_key` reads.
        MenuItem::find_shortcut(items, &pressed)
            .filter(|a| !unsupported(a.role))
            .map(|a| (a.id, a.role))
    };
    match found {
        Some((id, role)) => {
            choose(surface, id, role);
            true
        }
        None => false,
    }
}

// --- The dark menu bar ------------------------------------------------------------------

fn colorref(c: u32) -> COLORREF {
    COLORREF(c)
}

/// The menu bar's background and text in the dark theme (BGR).
const BAR_DARK: u32 = 0x002b_2b2b;
const BAR_HOT: u32 = 0x0041_4141;
const BAR_TEXT: u32 = 0x00ff_ffff;
const BAR_TEXT_DISABLED: u32 = 0x0080_8080;

/// The menu bar's rectangle in the window's coordinates.
fn menu_bar_rect(hwnd: HWND) -> Option<RECT> {
    let mut info = MENUBARINFO {
        cbSize: std::mem::size_of::<MENUBARINFO>() as u32,
        ..Default::default()
    };
    let mut window = RECT::default();
    // SAFETY: plain queries with local out values.
    unsafe {
        GetMenuBarInfo(hwnd, OBJID_MENU, 0, &mut info).ok()?;
        GetWindowRect(hwnd, &mut window).ok()?;
    }
    let mut r = info.rcBar;
    r.left -= window.left;
    r.right -= window.left;
    r.top -= window.top;
    r.bottom -= window.top;
    Some(r)
}

/// The menu bar's messages in the dark theme (`WM_UAHDRAWMENU`,
/// `WM_UAHDRAWMENUITEM`); `None` in the light theme, whose bar is the
/// system's.
pub(crate) fn draw_menu_bar(
    surface: &Surface,
    hwnd: HWND,
    msg: u32,
    lparam: LPARAM,
) -> Option<LRESULT> {
    if !crate::system::dark(surface) || surface.chrome.bar.get() == 0 {
        return None;
    }
    match msg {
        WM_UAHDRAWMENU => {
            // SAFETY: the message's documented-by-use structure, valid for
            // the message; GDI calls on its device context.
            unsafe {
                let menu = &*(lparam.0 as *const UahMenu);
                let mut r = menu_bar_rect(hwnd)?;
                // The bar's own rectangle stops short of the window's right
                // border.
                r.right += 4;
                let brush = CreateSolidBrush(colorref(BAR_DARK));
                FillRect(menu.hdc, &r, brush);
                let _ = DeleteObject(brush.into());
            }
            Some(LRESULT(1))
        }
        WM_UAHDRAWMENUITEM => {
            // SAFETY: as above.
            unsafe {
                let item = &*(lparam.0 as *const UahDrawMenuItem);
                let mut text = [0u16; 256];
                let mut info = MENUITEMINFOW {
                    cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
                    fMask: MIIM_STRING,
                    dwTypeData: windows::core::PWSTR(text.as_mut_ptr()),
                    cch: text.len() as u32 - 1,
                    ..Default::default()
                };
                let _ = GetMenuItemInfoW(item.um.hmenu, item.position as u32, true, &mut info);
                let state = item.dis.itemState;
                let hot = state.0 & (ODS_HOTLIGHT.0 | ODS_SELECTED.0) != 0;
                let disabled = state.0 & (ODS_GRAYED.0 | ODS_DISABLED.0 | ODS_INACTIVE.0) != 0;
                let brush = CreateSolidBrush(colorref(if hot { BAR_HOT } else { BAR_DARK }));
                FillRect(item.um.hdc, &item.dis.rcItem, brush);
                let _ = DeleteObject(brush.into());
                SetBkMode(item.um.hdc, TRANSPARENT);
                SetTextColor(
                    item.um.hdc,
                    colorref(if disabled {
                        BAR_TEXT_DISABLED
                    } else {
                        BAR_TEXT
                    }),
                );
                let mut flags = DT_CENTER | DT_SINGLELINE | DT_VCENTER;
                if state.0 & ODS_NOACCEL.0 != 0 {
                    flags |= DT_HIDEPREFIX;
                }
                let len = text.iter().position(|&u| u == 0).unwrap_or(0);
                let mut r = item.dis.rcItem;
                DrawTextW(item.um.hdc, &mut text[..len], &mut r, flags);
            }
            Some(LRESULT(1))
        }
        _ => None,
    }
}

/// Paints over the light line the system draws under the menu bar (after
/// `WM_NCPAINT` and `WM_NCACTIVATE`), in the dark theme.
pub(crate) fn paint_menu_bar_line(surface: &Surface, hwnd: HWND) {
    if !crate::system::dark(surface) || surface.chrome.bar.get() == 0 {
        return;
    }
    let Some(bar) = menu_bar_rect(hwnd) else {
        return;
    };
    let mut client = RECT::default();
    // SAFETY: plain GDI calls on the window's own DC, released below.
    unsafe {
        let _ = GetClientRect(hwnd, &mut client);
        let line = RECT {
            left: bar.left,
            top: bar.bottom,
            right: bar.left + client.right,
            bottom: bar.bottom + 1,
        };
        let dc = GetWindowDC(Some(hwnd));
        let brush = CreateSolidBrush(colorref(BAR_DARK));
        FillRect(dc, &line, brush);
        let _ = DeleteObject(brush.into());
        ReleaseDC(Some(hwnd), dc);
    }
}

/// Makes the menu bar again if it has icons: they are drawn for one DPI and
/// theme.
fn refresh_icons(surface: &Surface) {
    let has_icons = surface.chrome.menu.borrow().as_ref().is_some_and(|menu| {
        let mut any = false;
        MenuItem::each_icon(menu, &mut |_| any = true);
        any
    });
    if has_icons && surface.chrome.bar.get() != 0 {
        show_menu_bar(surface);
    }
}

/// The window moved to a screen of another DPI: the bar's icons follow.
pub(crate) fn dpi_changed(surface: &Surface) {
    refresh_icons(surface);
}

/// The appearance changed: menus and the bar follow it.
pub(crate) fn appearance_changed(surface: &Surface) {
    theme_menus(crate::system::dark(surface));
    refresh_icons(surface);
    let hwnd = surface.hwnd();
    if surface.chrome.bar.get() != 0 && !hwnd.is_invalid() {
        // SAFETY: a plain call.
        let _ = unsafe { DrawMenuBar(hwnd) };
    }
    surface.invalidate();
}
