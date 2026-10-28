//! Input as a user's hands give it, made in process (on the main thread):
//! pointers and wheels through the handlers the window's messages go
//! through ([`crate::input`]), keys and text ([`crate::text_input`], or
//! the focused web page's window), and pictures of the window. The agent
//! of `nsh test --target windows` acts with them ([`crate::agent`]).

use std::rc::Rc;

use crate::{
    input::{KeyEvent, Modifiers, PointerEvent, PointerKind},
    surface::Surface,
};

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
            modifiers: Modifiers::default(),
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
    (!focus.is_invalid() && focus != surface.hwnd()).then_some(focus)
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

/// Resizes the window so that its client area is `w` x `h` points.
pub(crate) fn resize(surface: &Rc<Surface>, w: f32, h: f32) {
    use windows::Win32::{
        Foundation::RECT,
        UI::{
            HiDpi::AdjustWindowRectExForDpi,
            WindowsAndMessaging::{
                GWL_EXSTYLE, GWL_STYLE, GetWindowLongW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOZORDER,
                SetWindowPos, WINDOW_EX_STYLE, WINDOW_STYLE,
            },
        },
    };
    let hwnd = surface.hwnd();
    let dpi = crate::window::dpi(hwnd);
    let s = dpi as f32 / 96.0;
    let mut rect = RECT {
        left: 0,
        top: 0,
        right: (w * s).round() as i32,
        bottom: (h * s).round() as i32,
    };
    // SAFETY: plain calls on the surface's window.
    unsafe {
        let style = WINDOW_STYLE(GetWindowLongW(hwnd, GWL_STYLE) as u32);
        let ex = WINDOW_EX_STYLE(GetWindowLongW(hwnd, GWL_EXSTYLE) as u32);
        let _ = AdjustWindowRectExForDpi(&mut rect, style, false, ex, dpi);
        let _ = SetWindowPos(
            hwnd,
            None,
            0,
            0,
            rect.right - rect.left,
            rect.bottom - rect.top,
            SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
}

/// A picture of what the window shows, as a PNG: captured as DWM composes
/// it, web views included, at the window's scale (`PrintWindow` with
/// `PW_RENDERFULLCONTENT`, whatever covers the window); drawn offscreen
/// at that scale when the window cannot be captured.
pub(crate) fn screenshot(surface: &Rc<Surface>) -> Result<Vec<u8>, String> {
    let (rgba, w, h) = match capture(surface) {
        Ok(captured) => captured,
        Err(err) => {
            log::debug!("windows: PrintWindow: {err}; drawing the window offscreen");
            drawn(surface)?
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
fn capture(surface: &Rc<Surface>) -> Result<(Vec<u8>, u32, u32), String> {
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
    let hwnd = surface.hwnd();
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
fn drawn(surface: &Rc<Surface>) -> Result<(Vec<u8>, u32, u32), String> {
    let scale = crate::window::dpi(surface.hwnd()) as f32 / 96.0;
    let pixels = crate::render::snapshot(surface, scale).map_err(|e| e.to_string())?;
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
