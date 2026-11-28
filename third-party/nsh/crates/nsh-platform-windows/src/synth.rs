//! Input as a user's hands give it, made in process (on the main thread):
//! pointers and wheels through the handlers the window's messages go
//! through ([`crate::input`]), keys and text ([`crate::text_input`], or
//! the focused web page's window), and pictures of the window. The agent
//! of `nsh test --target windows` acts with them ([`crate::agent`]).

use std::rc::Rc;

use nsh_core::{NodeId, ROOT_ID};
use windows::Win32::Foundation::HWND;

use crate::{
    input::{KeyEvent, Modifiers, PointerEvent, PointerKind},
    surface::Surface,
    view::NshView,
};

thread_local! {
    /// The modifier keys the agent holds down (`keyboard.down`): the
    /// pointer events it makes until they are let go carry them.
    static HELD: std::cell::Cell<Modifiers> = std::cell::Cell::new(Modifiers::default());
}

/// Holds the modifier keys `keys` (`mod+shift`) down or lets go of them.
pub(crate) fn hold(keys: Modifiers, down: bool) {
    HELD.with(|held| {
        let mut m = held.get();
        if keys.shift {
            m.shift = down;
        }
        if keys.ctrl {
            m.ctrl = down;
        }
        if keys.alt {
            m.alt = down;
        }
        if keys.meta {
            m.meta = down;
        }
        held.set(m);
    });
}

/// The modifier keys the agent holds.
pub(crate) fn held_keys() -> Modifiers {
    HELD.with(|held| held.get())
}

/// A pointer event of the mouse's `button` (0: primary, 3: back) at `x`,
/// `y` (points, root coordinates), with the buttons `held` after it (bit
/// `n` for button `n`, as a mouse message's `wparam` tells them).
pub(crate) fn pointer(
    surface: &Rc<Surface>,
    kind: PointerKind,
    x: f32,
    y: f32,
    button: u8,
    held: u8,
) {
    crate::input::pointer(
        surface,
        PointerEvent {
            kind,
            x,
            y,
            button,
            buttons: held,
            pointer: 1,
            touch: false,
            pen: false,
            time: surface.clock(),
            modifiers: held_keys(),
            clicks: 1,
        },
    );
}

/// The window of another module that has the keyboard focus (a web view's
/// page), if any.
fn focused_child(surface: &Surface) -> Option<windows::Win32::Foundation::HWND> {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetFocus;
    // SAFETY: a plain query.
    let focus = unsafe { GetFocus() };
    // The app's own windows (the host's and those it opens) take keys
    // through their input root ([`crate::agent`]'s focused window).
    (!focus.is_invalid() && focus != surface.hwnd() && crate::window::surface_of(focus).is_none())
        .then_some(focus)
}

/// Types `text` into the focused page (posted as `WM_CHAR`s to its window,
/// as the keyboard would), else into the focused field.
pub(crate) fn type_text(surface: &Rc<Surface>, text: &str) {
    use windows::Win32::{
        Foundation::{LPARAM, WPARAM},
        UI::WindowsAndMessaging::{PostMessageW, WM_CHAR},
    };
    let Some(hwnd) = focused_child(surface) else {
        crate::text_input::char_input(surface, text);
        return;
    };
    for unit in text.encode_utf16() {
        // SAFETY: posting plain messages to a live window.
        let _ = unsafe { PostMessageW(Some(hwnd), WM_CHAR, WPARAM(unit as usize), LPARAM(1)) };
    }
}

/// Presses `vk` in the focused page; false when nsh has the focus.
fn press_in_child(surface: &Surface, vk: u16) -> bool {
    use windows::Win32::{
        Foundation::{LPARAM, WPARAM},
        UI::WindowsAndMessaging::{PostMessageW, WM_CHAR, WM_KEYDOWN, WM_KEYUP},
    };
    let Some(hwnd) = focused_child(surface) else {
        return false;
    };
    // SAFETY: posting plain messages to a live window.
    unsafe {
        let _ = PostMessageW(Some(hwnd), WM_KEYDOWN, WPARAM(vk as usize), LPARAM(1));
        if matches!(vk, 0x08 | 0x09 | 0x0D | 0x1B) {
            // What `TranslateMessage` adds for these keys.
            let _ = PostMessageW(Some(hwnd), WM_CHAR, WPARAM(vk as usize), LPARAM(1));
        }
        let _ = PostMessageW(
            Some(hwnd),
            WM_KEYUP,
            WPARAM(vk as usize),
            LPARAM((1 | (3 << 30)) as isize),
        );
    }
    true
}

/// Presses and releases the virtual key `vk` with `modifiers`.
pub(crate) fn press(surface: &Rc<Surface>, vk: u16, modifiers: Modifiers) {
    // The keys the agent holds (`keyboard.down`) too.
    let h = held_keys();
    let modifiers = Modifiers {
        shift: modifiers.shift || h.shift,
        ctrl: modifiers.ctrl || h.ctrl,
        alt: modifiers.alt || h.alt,
        meta: modifiers.meta || h.meta,
    };
    if modifiers == Modifiers::default() && press_in_child(surface, vk) {
        return;
    }
    for down in [true, false] {
        let handled = crate::input::key(
            surface,
            KeyEvent {
                vk,
                down,
                repeat: false,
                modifiers,
                scan: 0,
                extended: false,
                sys: false,
                translated: false,
            },
        );
        // Unhandled printable keys type their character, as
        // `TranslateMessage` would.
        if down && !handled && !modifiers.ctrl && !modifiers.alt {
            let ch = match vk {
                0x20 => Some(' '),
                0x0D => Some('\r'),
                0x09 => Some('\t'),
                // The US layout's character, Shift's for `shift+8` (`*`).
                _ => match nsh_core::keymap::Key::from_virtual_key(vk) {
                    Some(nsh_core::keymap::Key::Char(c)) if modifiers.shift => {
                        Some(nsh_core::keymap::shifted(c))
                    }
                    Some(nsh_core::keymap::Key::Char(c)) => Some(c),
                    _ => None,
                },
            };
            if let Some(ch) = ch {
                crate::text_input::char_input(surface, &ch.to_string());
            }
        }
    }
}

/// Resizes the window the test acts on so that its client area is `w` x `h`
/// points: the targeted window, else the focused one, else the first open
/// one, else the host.
/// The window of the app's own a desktop test step acts in, as the user
/// would: `target` (a window [`crate::agent`] was told to act in), else
/// the focused one, else the first open one (a background host focuses no
/// window: it stands in, as the headless model does). The host is never a
/// user window: `None` only when the app shows none.
fn user_window(surface: &Rc<Surface>, target: NodeId) -> Option<NodeId> {
    if target != nsh_core::ROOT_ID {
        return Some(target);
    }
    let ids = crate::app_window::ids(surface);
    crate::app_window::focused_hwnd(surface)
        .and_then(|hwnd| {
            ids.iter()
                .copied()
                .find(|&id| crate::app_window::hwnd_of(surface, id) == Some(hwnd))
        })
        .or_else(|| ids.first().copied())
}

pub(crate) fn resize(surface: &Rc<Surface>, target: NodeId, w: f32, h: f32) {
    use windows::Win32::{
        Foundation::RECT,
        UI::WindowsAndMessaging::{
            GetClientRect, GetWindowRect, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOZORDER, SetWindowPos,
        },
    };
    let hwnd = user_window(surface, target)
        .and_then(|id| crate::app_window::hwnd_of(surface, id))
        .unwrap_or_else(|| surface.hwnd());
    let dpi = crate::window::dpi(hwnd);
    let s = dpi as f32 / 96.0;
    let (w, h) = ((w * s).round() as i32, (h * s).round() as i32);
    // SAFETY: plain calls on the surface's window, with local out values.
    unsafe {
        // The client area is `w` x `h`: the window grows by its frame as it
        // is now, which a window drawing its own title bar has none of at
        // the top (`AdjustWindowRectEx` would add the system's caption).
        let (mut outer, mut inner) = (RECT::default(), RECT::default());
        let _ = GetWindowRect(hwnd, &mut outer);
        let _ = GetClientRect(hwnd, &mut inner);
        let frame_w = (outer.right - outer.left) - (inner.right - inner.left);
        let frame_h = (outer.bottom - outer.top) - (inner.bottom - inner.top);
        let _ = SetWindowPos(
            hwnd,
            None,
            0,
            0,
            w + frame_w,
            h + frame_h,
            SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
}

/// A picture of what the window shows, as a PNG: captured as DWM composes
/// it, web views included, at the window's scale (`PrintWindow` with
/// `PW_RENDERFULLCONTENT`, whatever covers the window); drawn offscreen
/// at that scale when the window cannot be captured. The window is the one
/// the steps act in ([`user_window`]); the host's own (hidden) window only
/// while the app shows none.
pub(crate) fn screenshot(surface: &Rc<Surface>, target: NodeId) -> Result<Vec<u8>, String> {
    match user_window(surface, target) {
        Some(id) => window_screenshot(surface, id),
        None => picture(surface, surface.hwnd(), None),
    }
}

/// [`screenshot`] of the window of the app's own that shows dialog root
/// `window` (`ROOT_ID`: the main window).
pub(crate) fn window_screenshot(surface: &Rc<Surface>, window: NodeId) -> Result<Vec<u8>, String> {
    if window == ROOT_ID {
        return screenshot(surface, ROOT_ID);
    }
    let (Some(hwnd), Some(root)) = (
        crate::app_window::hwnd_of(surface, window),
        crate::app_window::root_view(surface, window),
    ) else {
        return Err(format!("no window \"{window}\" is open"));
    };
    picture(surface, hwnd, Some(&root))
}

/// A PNG of native window `hwnd`, which shows `root` (`None`: the main
/// window's tree).
fn picture(surface: &Rc<Surface>, hwnd: HWND, root: Option<&NshView>) -> Result<Vec<u8>, String> {
    let (rgba, w, h) = match capture(hwnd) {
        Ok(captured) => captured,
        Err(err) => {
            log::debug!("windows: PrintWindow: {err}; drawing the window offscreen");
            drawn(surface, hwnd, root)?
        }
    };
    let image = image::RgbaImage::from_raw(w, h, rgba).ok_or("a picture of no size")?;
    let mut png = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(png.into_inner())
}

/// The window's client area as DWM composes it: straight RGBA rows.
fn capture(hwnd: HWND) -> Result<(Vec<u8>, u32, u32), String> {
    use windows::Win32::{
        Foundation::RECT,
        Graphics::Gdi::{
            BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, CreateDIBSection,
            DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, ReleaseDC, SelectObject,
        },
        Storage::Xps::{PRINT_WINDOW_FLAGS, PrintWindow},
        UI::WindowsAndMessaging::GetClientRect,
    };
    // PW_CLIENTONLY | PW_RENDERFULLCONTENT.
    const FLAGS: u32 = 0x1 | 0x2;
    let mut rect = RECT::default();
    // SAFETY: plain GDI calls on this thread's window and the objects made
    // here, released before returning; the DIB's bits are read while it is
    // alive.
    unsafe {
        GetClientRect(hwnd, &mut rect).map_err(|e| e.to_string())?;
        let (w, h) = (rect.right - rect.left, rect.bottom - rect.top);
        if w <= 0 || h <= 0 {
            return Err("the window has no client area".into());
        }
        let screen = GetDC(None);
        let dc = CreateCompatibleDC(Some(screen));
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                // Top-down rows.
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        let bitmap = CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0);
        let result = match bitmap {
            Ok(bitmap) => {
                let old = SelectObject(dc, bitmap.into());
                let printed = PrintWindow(hwnd, dc, PRINT_WINDOW_FLAGS(FLAGS)).as_bool();
                let mut rgba =
                    std::slice::from_raw_parts(bits as *const u8, (w * h * 4) as usize).to_vec();
                SelectObject(dc, old);
                let _ = DeleteObject(bitmap.into());
                if printed {
                    for px in rgba.as_chunks_mut::<4>().0 {
                        px.swap(0, 2);
                        px[3] = 255;
                    }
                    Ok((rgba, w as u32, h as u32))
                } else {
                    Err("PrintWindow failed".into())
                }
            }
            Err(err) => Err(err.to_string()),
        };
        let _ = DeleteDC(dc);
        ReleaseDC(None, screen);
        result
    }
}

/// The surface drawn offscreen at the window's scale: straight RGBA rows
/// (no web views: the system composes their pages).
fn drawn(
    surface: &Rc<Surface>,
    hwnd: HWND,
    root: Option<&NshView>,
) -> Result<(Vec<u8>, u32, u32), String> {
    let scale = crate::window::dpi(hwnd) as f32 / 96.0;
    let pixels = crate::render::snapshot(surface, scale, root).map_err(|e| e.to_string())?;
    let mut rgba = pixels.data;
    for px in rgba.as_chunks_mut::<4>().0 {
        // Premultiplied BGRA to straight RGBA.
        let a = px[3];
        let un = |c: u8| {
            if a == 0 {
                0
            } else {
                ((c as u32 * 255 + a as u32 / 2) / a as u32).min(255) as u8
            }
        };
        let (b, g, r) = (un(px[0]), un(px[1]), un(px[2]));
        px[0] = r;
        px[1] = g;
        px[2] = b;
    }
    Ok((rgba, pixels.width, pixels.height))
}
