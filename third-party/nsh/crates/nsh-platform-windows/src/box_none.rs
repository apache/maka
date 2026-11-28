//! Windows whose `pointerEvents` is `"box-none"`: each takes the pointer
//! only where it is over a view in its root that takes it (the input's own
//! picking, the root aside), and lets it through to what is below
//! elsewhere.
//!
//! The window is layered while it is `"box-none"` and passes the pointer
//! (`WS_EX_TRANSPARENT`) or not for where the cursor is, again after each
//! batch moved its views and as it shows; the cursor is followed only while
//! one of these windows shows.

use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
};

use nsh_core::{NodeId, ROOT_ID};
use windows::Win32::{
    Foundation::{HWND, POINT},
    Graphics::Gdi::ScreenToClient,
    UI::{
        Input::KeyboardAndMouse::{
            GetAsyncKeyState, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON, VK_XBUTTON1, VK_XBUTTON2,
        },
        WindowsAndMessaging::{
            GWL_EXSTYLE, GetCursorPos, GetWindowLongPtrW, IsIconic, IsWindowVisible, KillTimer,
            SetTimer, SetWindowLongPtrW, WS_EX_TRANSPARENT,
        },
    },
};

use crate::surface::Surface;

/// How often the cursor is looked at while a `"box-none"` window shows (a
/// frame at 60 Hz).
const FOLLOW_MS: u32 = 16;

/// A `"box-none"` window: its surface and its root's id.
struct Entry {
    hwnd: isize,
    surface: Weak<Surface>,
    id: NodeId,
    /// Where the cursor was in it (pixels) and the [`LAYOUT`] when it last
    /// decided: the same again, the decision stands.
    decided: Cell<Option<(i32, i32, u64)>>,
}

thread_local! {
    static WINDOWS: RefCell<Vec<Entry>> = const { RefCell::new(Vec::new()) };
    /// The timer following the cursor while one of them shows.
    static TIMER: Cell<usize> = const { Cell::new(0) };
    /// A count that moves as the windows' views or the windows change.
    static LAYOUT: Cell<u64> = const { Cell::new(0) };
}

fn layout_changed() {
    LAYOUT.set(LAYOUT.get().wrapping_add(1));
}

/// Window `id` of `surface` (`hwnd`) is `"box-none"` (`on`) or no longer
/// is. Its styles are the shell's ([`crate::shell::styles`]): layered
/// while it is, passing the pointer as this module decides.
pub(crate) fn set(surface: &Rc<Surface>, id: NodeId, hwnd: HWND, on: bool) {
    forget(hwnd);
    if !on {
        return;
    }
    WINDOWS.with_borrow_mut(|w| {
        w.push(Entry {
            hwnd: hwnd.0 as isize,
            surface: Rc::downgrade(surface),
            id,
            decided: Cell::new(None),
        })
    });
    shown_or_hidden(hwnd);
}

/// `hwnd` closes, or is no longer `"box-none"`.
pub(crate) fn forget(hwnd: HWND) {
    let key = hwnd.0 as isize;
    WINDOWS.with_borrow_mut(|w| w.retain(|e| e.hwnd != key));
    follow_cursor();
}

/// `hwnd` moved, showed, hid, was minimized or restored
/// (`WM_WINDOWPOSCHANGED`): the cursor is followed while one of the
/// windows shows, and one that shows takes the pointer for where it is now.
pub(crate) fn shown_or_hidden(hwnd: HWND) {
    let key = hwnd.0 as isize;
    if !WINDOWS.with_borrow(|w| w.iter().any(|e| e.hwnd == key)) {
        return;
    }
    layout_changed();
    follow_cursor();
    if showing(hwnd) {
        follow(Some(key));
    }
}

/// A batch moved `surface`'s views: its `"box-none"` windows follow their
/// new layout under the cursor where it rests.
pub(crate) fn batch_applied(surface: &Surface) {
    if WINDOWS.with_borrow(Vec::is_empty) {
        return;
    }
    layout_changed();
    let windows: Vec<isize> = WINDOWS.with_borrow(|w| {
        w.iter()
            .filter(|e| std::ptr::eq(e.surface.as_ptr(), surface))
            .map(|e| e.hwnd)
            .collect()
    });
    for hwnd in windows {
        follow(Some(hwnd));
    }
}

fn showing(hwnd: HWND) -> bool {
    // SAFETY: plain queries; false for a window that is gone.
    unsafe { IsWindowVisible(hwnd).as_bool() && !IsIconic(hwnd).as_bool() }
}

/// Starts the timer while a `"box-none"` window shows, stops it otherwise.
fn follow_cursor() {
    let any = WINDOWS.with_borrow(|w| w.iter().any(|e| showing(HWND(e.hwnd as _))));
    let timer = TIMER.get();
    if any && timer == 0 {
        // SAFETY: a thread timer (no window) with a callback of the right
        // signature; this thread's message loop dispatches it.
        let id = unsafe { SetTimer(None, 0, FOLLOW_MS, Some(tick)) };
        TIMER.set(id);
    } else if !any && timer != 0 {
        // SAFETY: a thread timer this thread made.
        let _ = unsafe { KillTimer(None, timer) };
        TIMER.set(0);
    }
}

unsafe extern "system" fn tick(_: HWND, _: u32, _: usize, _: u32) {
    follow(None);
    follow_cursor();
}

/// Whether a mouse button is held: the press stays with the window it went
/// to.
fn button_held() -> bool {
    [VK_LBUTTON, VK_RBUTTON, VK_MBUTTON, VK_XBUTTON1, VK_XBUTTON2]
        .into_iter()
        // SAFETY: a plain query of the keys' state.
        .any(|vk| unsafe { GetAsyncKeyState(vk.0 as i32) } < 0)
}

/// Every `"box-none"` window that shows (only `only`, given one) passes the
/// pointer unless the cursor is over one of its views.
fn follow(only: Option<isize>) {
    if button_held() {
        return;
    }
    let mut cursor = POINT::default();
    // SAFETY: an out value.
    if unsafe { GetCursorPos(&mut cursor) }.is_err() {
        return;
    }
    let layout = LAYOUT.get();
    let entries: Vec<(isize, Weak<Surface>, NodeId)> = WINDOWS.with_borrow(|w| {
        w.iter()
            .filter(|e| only.is_none_or(|o| o == e.hwnd))
            .map(|e| (e.hwnd, e.surface.clone(), e.id))
            .collect()
    });
    for (key, surface, id) in entries {
        let hwnd = HWND(key as _);
        if !showing(hwnd) {
            continue;
        }
        let Some(surface) = surface.upgrade() else {
            continue;
        };
        let (root, scale) = if id == ROOT_ID {
            (Some(surface.root.clone()), surface.scale())
        } else {
            (
                crate::app_window::root_view(&surface, id),
                crate::window::dpi(hwnd) as f32 / 96.0,
            )
        };
        let Some(root) = root else { continue };
        let mut p = cursor;
        // SAFETY: a window of this thread; an in-out point.
        if !unsafe { ScreenToClient(hwnd, &mut p) }.as_bool() {
            continue;
        }
        // The cursor where it was in the window, the window laid out as it
        // was: the decision stands (the timer finds this most of the time).
        let now = Some((p.x, p.y, layout));
        if WINDOWS.with_borrow(|w| {
            w.iter()
                .find(|e| e.hwnd == key)
                .is_some_and(|e| e.decided.replace(now) == now)
        }) {
            continue;
        }
        let takes = crate::input::takes_pointer(&root, p.x as f32 / scale, p.y as f32 / scale);
        set_passing(hwnd, !takes);
    }
}

/// `WS_EX_TRANSPARENT` on (layered) `hwnd`: presses go to the windows
/// below, of any process.
fn set_passing(hwnd: HWND, passing: bool) {
    // SAFETY: plain reads and writes of a window of this thread's styles.
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        let next = if passing {
            ex | WS_EX_TRANSPARENT.0
        } else {
            ex & !WS_EX_TRANSPARENT.0
        };
        if next != ex {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next as isize);
        }
    }
}
