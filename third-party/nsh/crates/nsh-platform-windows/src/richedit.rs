//! A windowless RichEdit control: the text services of `msftedit.dll`
//! (`ITextServices2`, the editor Office and Windows' own windowless text
//! boxes are built on) behind a text host of ours (`ITextHost2`).
//!
//! The text services do everything a Windows text box does: editing,
//! caret stops and words as Windows has them (Uniscribe / DirectWrite
//! clusters, Ctrl+arrows, Ctrl+Backspace), selection by mouse and keys,
//! multilevel undo, the clipboard, the IME in place (IMM32 and Text
//! Services Framework: dictation, the emoji panel, the touch keyboard,
//! reconversion), spell checking, password masking and scrolling. They
//! draw with Direct2D and DirectWrite into the target the window draws
//! with (`TxDrawD2D`), so the field clips, transforms and fades with its
//! view and nothing covers it: no child window.
//!
//! The host answers the services' questions from [`Props`] (the client
//! rectangle, in the window's client pixels, the default character and
//! paragraph formats, the property bits, the maximum length, the password
//! character), records the caret they place ([`Caret`], drawn by the field,
//! which blinks it) and the notifications they send ([`Notes`], taken by
//! the field after each message it sends), and asks the field to draw again
//! when they invalidate. Timers the services set (autoscrolling a drag) are
//! thread timers.
//!
//! `ITextHost` is a C++ interface without a type library: its vtable is
//! written here, in its declared order (TextServ.h). Its IIDs, and the
//! services', are exported by `msftedit.dll`. On 32-bit x86 the interfaces
//! use `thiscall`; the backend is built for 64-bit Windows only.

use std::{
    cell::{Cell, RefCell},
    ffi::c_void,
    sync::OnceLock,
};

use windows::{
    Win32::{
        Foundation::{
            COLORREF, E_NOINTERFACE, E_NOTIMPL, E_POINTER, HWND, LPARAM, LRESULT, POINT, POINTL,
            RECT, RECTL, S_FALSE, S_OK, SIZE, WPARAM,
        },
        Graphics::Gdi::{
            ClientToScreen, GetDC, GetDeviceCaps, GetSysColor, HBITMAP, HDC, HPALETTE, HRGN,
            LOGPIXELSY, ReleaseDC, SYS_COLOR_INDEX, ScreenToClient,
        },
        System::LibraryLoader::{GetProcAddress, LoadLibraryW},
        UI::{
            Controls::RichEdit::{
                CHARFORMAT2W, CHARFORMATW, CHARRANGE, EM_EXGETSEL, EM_GETSCROLLPOS,
                EM_SETSCROLLPOS, ITextServices2, PARAFORMAT, PARAFORMAT2, TXTBACK_TRANSPARENT,
                TXTBACKSTYLE, TXTBIT_RICHTEXT, TXTVIEW_ACTIVE,
            },
            Input::Ime::{HIMC, ImmGetContext, ImmReleaseContext},
            WindowsAndMessaging::{HCURSOR, KillTimer, SetTimer, WM_TIMER},
        },
    },
    core::{BOOL, GUID, HRESULT, IUnknown, Interface, PCWSTR, w},
};

/// `EN_CHANGE`: the text changed.
const EN_CHANGE: u32 = 0x0300;
/// `EN_SELCHANGE`.
const EN_SELCHANGE: u32 = 0x0702;
/// `EN_STARTCOMPOSITION` (RichEdit 8).
const EN_STARTCOMPOSITION: u32 = 0x0713;
/// `EN_ENDCOMPOSITION` (RichEdit 8).
const EN_ENDCOMPOSITION: u32 = 0x0714;

/// What `msftedit.dll` gives: the factory and the interfaces' IIDs.
struct Lib {
    create: unsafe extern "system" fn(*mut c_void, *mut c_void, *mut *mut c_void) -> HRESULT,
    services2: GUID,
    host: GUID,
    host2: GUID,
}

// SAFETY: a function pointer and plain GUIDs, read only.
unsafe impl Sync for Lib {}
// SAFETY: as above.
unsafe impl Send for Lib {}

/// Loads `msftedit.dll` once (`None`: it is missing, which no supported
/// Windows is).
fn lib() -> Option<&'static Lib> {
    static LIB: OnceLock<Option<Lib>> = OnceLock::new();
    LIB.get_or_init(|| {
        // SAFETY: loading a system library by name and reading its exports:
        // a function with CreateTextServices' signature and GUID data.
        unsafe {
            let module = LoadLibraryW(w!("msftedit.dll")).ok()?;
            let create = GetProcAddress(module, windows::core::s!("CreateTextServices"))?;
            let guid = |name: windows::core::PCSTR| {
                GetProcAddress(module, name).map(|p| *(p as *const GUID))
            };
            Some(Lib {
                create: std::mem::transmute::<
                    unsafe extern "system" fn() -> isize,
                    unsafe extern "system" fn(
                        *mut c_void,
                        *mut c_void,
                        *mut *mut c_void,
                    ) -> HRESULT,
                >(create),
                services2: guid(windows::core::s!("IID_ITextServices2"))?,
                // TextServ.h's values, should an export be missing.
                host: guid(windows::core::s!("IID_ITextHost"))
                    .unwrap_or(GUID::from_u128(0x13e670f4_1a5a_11cf_abeb_00aa00b65ea1)),
                host2: guid(windows::core::s!("IID_ITextHost2"))
                    .unwrap_or(GUID::from_u128(0x13e670f5_1a5a_11cf_abeb_00aa00b65ea1)),
            })
        }
    })
    .as_ref()
}

/// What the host tells the services when they ask.
pub(crate) struct Props {
    /// The client rectangle: where the text goes, in the window's client
    /// pixels.
    pub(crate) client: RECT,
    /// The default character format (the plain text's).
    pub(crate) char_format: CHARFORMAT2W,
    /// The default paragraph format.
    pub(crate) para_format: PARAFORMAT2,
    /// `TXTBIT_*`.
    pub(crate) bits: u32,
    /// The maximum length, in UTF-16 units.
    pub(crate) max_length: u32,
    /// Scroll-bar support and auto-scrolling flags. The host draws the indicators.
    pub(crate) scroll: u32,
    /// The character a password shows.
    pub(crate) password: u16,
    /// The selection's background and text, instead of the system's.
    pub(crate) highlight: Option<(COLORREF, COLORREF)>,
}

impl Default for Props {
    fn default() -> Self {
        let mut char_format = CHARFORMAT2W::default();
        char_format.Base.cbSize = size_of::<CHARFORMAT2W>() as u32;
        let mut para_format = PARAFORMAT2::default();
        para_format.Base.cbSize = size_of::<PARAFORMAT2>() as u32;
        Props {
            client: RECT::default(),
            char_format,
            para_format,
            bits: 0,
            max_length: i32::MAX as u32,
            scroll: 0,
            // Windows' own password boxes show a black circle.
            password: 0x25CF,
            highlight: None,
        }
    }
}

/// The caret the services placed (client pixels).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Caret {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: i32,
    pub(crate) height: i32,
    /// The services show it (it is hidden over a selection, while the
    /// field has no focus, ...).
    pub(crate) shown: bool,
}

/// Notifications since the field last took them.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct Notes {
    /// The text changed (`EN_CHANGE`).
    pub(crate) changed: bool,
    /// The selection changed (`EN_SELCHANGE`).
    pub(crate) selection: bool,
    /// A composition started and has not ended yet, with the selection
    /// (UTF-16) and the text's length at that moment. When
    /// [`Self::composition_end`] is also set, this composition started after
    /// the prior one ended.
    pub(crate) composition_start: Option<(u32, u32, u32)>,
    /// A composition the field already knew about ended.
    pub(crate) composition_end: bool,
}

impl Notes {
    /// Nothing was noted.
    fn is_empty(&self) -> bool {
        !self.changed
            && !self.selection
            && self.composition_start.is_none()
            && !self.composition_end
    }
}

/// The services' id of the timer that hands the field the notifications
/// they sent outside its messages ([`notes_later`]); their own ids are
/// small.
const NOTES_LATER: u32 = u32::MAX;

/// Our `ITextHost2`.
#[repr(C)]
struct Host {
    vtbl: *const HostVtbl,
    refs: Cell<u32>,
    /// The window the text services were created on: `TxGetWindow` and the
    /// input context stay here (moving them to `shown_in` leaves compositions
    /// lost, upstream #2094), so `update_ime` keeps this window's IMC attached
    /// whenever any window's field takes IME input.
    hwnd: HWND,
    /// The window the field shows in (`hwnd`'s, or one of the app's own):
    /// where its client points are on the screen.
    shown_in: Cell<HWND>,
    props: RefCell<Props>,
    caret: Cell<Caret>,
    notes: Cell<Notes>,
    /// The services (not counted: they hold the host), for timers and the
    /// queries notifications make. Null once they are released.
    services: Cell<*mut c_void>,
    /// Set while `TxDrawD2D` runs: the services invalidate themselves as
    /// they draw, inside the window's `WM_PAINT`, where asking for another
    /// paint would be lost (`EndPaint` validates the window) and would
    /// leave the surface waiting for a paint that never comes.
    drawing: Cell<bool>,
    /// Asks the field to draw again.
    invalidate: Box<dyn Fn()>,
    /// Called after a timer's message, which may have changed the
    /// selection (a drag scrolling), and once the services noted a change
    /// outside the field's messages ([`notes_later`]).
    after_timer: Box<dyn Fn()>,
}

thread_local! {
    /// The services' timers: the thread timer's id → the host and the
    /// services' own id.
    static TIMERS: RefCell<Vec<(usize, *const Host, u32)>> = const { RefCell::new(Vec::new()) };
}

/// While a field is drawn ([`Editor::drawing`]).
pub(crate) struct Drawing<'a>(&'a Cell<bool>, bool);

impl Drop for Drawing<'_> {
    fn drop(&mut self) {
        self.0.set(self.1);
    }
}

/// A windowless RichEdit control.
pub(crate) struct Editor {
    /// Released in `drop`, before the host.
    services: std::mem::ManuallyDrop<ITextServices2>,
    host: *const Host,
}

impl Editor {
    /// Text services for window `hwnd`, with `props`; `None` when
    /// `msftedit.dll` cannot make them.
    pub(crate) fn new(
        hwnd: HWND,
        props: Props,
        invalidate: Box<dyn Fn()>,
        after_timer: Box<dyn Fn()>,
    ) -> Option<Editor> {
        let lib = lib()?;
        let host = Box::into_raw(Box::new(Host {
            vtbl: &HOST_VTBL,
            refs: Cell::new(1),
            hwnd,
            shown_in: Cell::new(hwnd),
            props: RefCell::new(props),
            caret: Cell::new(Caret::default()),
            notes: Cell::new(Notes::default()),
            services: Cell::new(std::ptr::null_mut()),
            drawing: Cell::new(false),
            invalidate,
            after_timer,
        }));
        let mut unknown: *mut c_void = std::ptr::null_mut();
        // SAFETY: the factory takes no outer object, our host (a valid
        // ITextHost2 with a count of its own) and an out pointer.
        let hr = unsafe { (lib.create)(std::ptr::null_mut(), host.cast(), &mut unknown) };
        if hr.is_err() || unknown.is_null() {
            log::error!("CreateTextServices failed: {hr:?}");
            // SAFETY: our own reference.
            unsafe { release(host.cast()) };
            return None;
        }
        // SAFETY: an owned IUnknown from the factory.
        let unknown = unsafe { IUnknown::from_raw(unknown) };
        let mut raw: *mut c_void = std::ptr::null_mut();
        // SAFETY: QueryInterface with the exported IID and an out pointer.
        let hr = unsafe { unknown.query(&lib.services2, &mut raw) };
        if hr.is_err() || raw.is_null() {
            log::error!("text services without ITextServices2: {hr:?}");
            drop(unknown);
            // SAFETY: as above.
            unsafe { release(host.cast()) };
            return None;
        }
        // SAFETY: an owned ITextServices2 pointer from QueryInterface (the
        // binding's IID is not used for calls).
        let services = unsafe { ITextServices2::from_raw(raw) };
        drop(unknown);
        // SAFETY: the host lives as long as the editor.
        unsafe { (*host).services.set(services.as_raw()) };
        let editor = Editor {
            services: std::mem::ManuallyDrop::new(services),
            host,
        };
        let mut client = editor.props().client;
        // SAFETY: in-place activation with the client rectangle.
        let _ = unsafe { editor.services.OnTxInPlaceActivate(&mut client) };
        Some(editor)
    }

    fn host(&self) -> &Host {
        // SAFETY: the editor holds a reference to the host.
        unsafe { &*self.host }
    }

    /// The field shows in window `hwnd`: the IME's candidates go by it.
    pub(crate) fn show_in(&self, hwnd: HWND) {
        self.host().shown_in.set(hwnd);
    }

    /// The host's properties, to read.
    pub(crate) fn props(&self) -> std::cell::Ref<'_, Props> {
        self.host().props.borrow()
    }

    /// Changes the host's properties, then tells the services which
    /// (`TXTBIT_*CHANGE`, and bits whose value changed).
    pub(crate) fn update(&self, f: impl FnOnce(&mut Props), changes: u32) {
        let old = self.host().props.borrow().bits;
        let new = {
            let mut props = self.host().props.borrow_mut();
            f(&mut props);
            props.bits
        };
        let mask = changes | (old ^ new);
        if mask != 0 {
            // SAFETY: a plain call; the services read the props again.
            let _ = unsafe { self.services.OnTxPropertyBitsChange(mask, new | changes) };
        }
    }

    /// Sends the services a message: its result, and whether they handled
    /// it (else the window's default handling applies).
    pub(crate) fn send(&self, msg: u32, wparam: usize, lparam: isize) -> (LRESULT, bool) {
        let mut result = LRESULT(0);
        // SAFETY: the vtable's call with an out value; S_FALSE (not
        // handled) is a success the binding would hide.
        let hr = unsafe {
            (Interface::vtable(&*self.services).base__.TxSendMessage)(
                self.services.as_raw(),
                msg,
                WPARAM(wparam),
                LPARAM(lparam),
                &mut result,
            )
        };
        (result, hr == S_OK)
    }

    /// Takes the notifications since the last time.
    pub(crate) fn take_notes(&self) -> Notes {
        self.host().notes.take()
    }

    /// Delivers `EN_STARTCOMPOSITION` through `tx_notify`, for tests that
    /// exercise composition transitions without an IME.
    #[cfg(test)]
    pub(crate) fn start_composition(&self) {
        // SAFETY: `self.host` is a live `Host` for the lifetime of `self`.
        unsafe {
            let _ = tx_notify(
                self.host.cast_mut().cast(),
                EN_STARTCOMPOSITION,
                std::ptr::null_mut(),
            );
        }
    }

    /// Delivers `EN_ENDCOMPOSITION` through `tx_notify`.
    #[cfg(test)]
    pub(crate) fn end_composition(&self) {
        // SAFETY: `self.host` is a live `Host` for the lifetime of `self`.
        unsafe {
            let _ = tx_notify(
                self.host.cast_mut().cast(),
                EN_ENDCOMPOSITION,
                std::ptr::null_mut(),
            );
        }
    }

    /// The caret the services placed.
    pub(crate) fn caret(&self) -> Caret {
        self.host().caret.get()
    }

    /// The text (plain, lines broken by `\r`, as the services keep it).
    pub(crate) fn text_units(&self) -> Vec<u16> {
        text_of(&self.services, self.host().props.borrow().bits)
    }

    /// Replaces the text (no undo, no notification but `EN_CHANGE`).
    pub(crate) fn set_text(&self, text: &str) {
        let wide: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
        // SAFETY: a NUL-terminated string that outlives the call.
        let _ = unsafe { self.services.TxSetText(PCWSTR(wide.as_ptr())) };
    }

    /// The selection, in UTF-16 units (start ≤ end), within the text: rich
    /// text's final paragraph mark ([`text_of`]), which selecting all
    /// takes in, is left out.
    pub(crate) fn selection(&self) -> (u32, u32) {
        let mut range = CHARRANGE::default();
        self.send(EM_EXGETSEL, 0, &mut range as *mut _ as isize);
        let (start, end) = (range.cpMin.max(0) as u32, range.cpMax.max(0) as u32);
        if self.host().props.borrow().bits & TXTBIT_RICHTEXT == 0 {
            return (start, end);
        }
        let len = self.text_units().len() as u32;
        (start.min(len), end.min(len))
    }

    /// The vertical scroll: minimum, maximum, position and page (pixels).
    pub(crate) fn vscroll(&self) -> (i32, i32, i32, i32) {
        let (mut min, mut max, mut pos, mut page) = (0, 0, 0, 0);
        let mut enabled = BOOL(0);
        // SAFETY: local out values.
        let _ = unsafe {
            self.services
                .TxGetVScroll(&mut min, &mut max, &mut pos, &mut page, &mut enabled)
        };
        (min, max, pos, page)
    }

    /// The top left of the character at `at` (UTF-16; the text's length:
    /// its end), in client pixels.
    pub(crate) fn position(&self, at: u32) -> POINT {
        let mut p = POINTL::default();
        self.send(
            windows::Win32::UI::Controls::EM_POSFROMCHAR,
            &mut p as *mut _ as usize,
            at as isize,
        );
        POINT { x: p.x, y: p.y }
    }

    /// Scrolls the text sideways so the character at `at` is at the client
    /// rectangle's left edge, as near as the text lets it.
    pub(crate) fn scroll_to_left_edge(&self, at: u32) {
        let dx = self.position(at).x - self.props().client.left;
        if dx == 0 {
            return;
        }
        let mut scroll = POINT::default();
        self.send(EM_GETSCROLLPOS, 0, &mut scroll as *mut _ as isize);
        scroll.x = (scroll.x + dx).max(0);
        self.send(EM_SETSCROLLPOS, 0, &mut scroll as *mut _ as isize);
    }

    /// The height of the text laid out `width` pixels wide (pixels).
    pub(crate) fn text_height(&self, width: i32) -> Option<i32> {
        use windows::Win32::{
            Foundation::SIZE,
            Graphics::Gdi::{GetDC, ReleaseDC},
            UI::Controls::RichEdit::{TXTNS_FITTOCONTENT, TXTNS_INCLUDELASTLINE},
        };
        let (mut w, mut h) = (width.max(1), 1);
        // The extent (HIMETRIC) sets the width to fit the text in.
        let extent = SIZE {
            cx: w * 2540 / 96,
            cy: 2540 / 96,
        };
        // SAFETY: the screen's DC, released below; local out values.
        unsafe {
            let dc = GetDC(None);
            let done = self.services.TxGetNaturalSize(
                1, // DVASPECT_CONTENT
                dc,
                Default::default(),
                std::ptr::null_mut(),
                (TXTNS_FITTOCONTENT.0 | TXTNS_INCLUDELASTLINE.0) as u32,
                &extent,
                &mut w,
                &mut h,
            );
            ReleaseDC(None, dc);
            done.ok().map(|_| h)
        }
    }

    /// Draws the text into `target` (an `ID2D1RenderTarget` whose
    /// transform maps client pixels), in `bounds`. False when the services
    /// would not draw: while an input method's edit holds the text (the
    /// commit of a composition), drawing fails and nothing is drawn.
    pub(crate) fn draw(&self, target: *mut c_void, bounds: RECT) -> bool {
        let mut rc = RECTL {
            left: bounds.left,
            top: bounds.top,
            right: bounds.right,
            bottom: bounds.bottom,
        };
        let _drawing = self.drawing();
        // SAFETY: the vtable's call with a live render target and
        // rectangle; a null update rectangle draws everything.
        let hr = unsafe {
            (Interface::vtable(&*self.services).TxDrawD2D)(
                self.services.as_raw(),
                target,
                &mut rc,
                std::ptr::null_mut(),
                TXTVIEW_ACTIVE.0,
            )
        };
        if hr.is_err() {
            log::debug!("TxDrawD2D failed: {hr:?}");
        }
        hr.is_ok()
    }

    /// Draws the text with GDI (`ITextServices::TxDraw`) into a top-down
    /// 32-bit premultiplied BGRA pixel buffer covering `bounds` (width × height
    /// pixels). Used only when the input renders an app-registered custom font,
    /// because windowless RichEdit's `TXTBIT_D2DDWRITE` path only sees
    /// DirectWrite's system font collection, whereas GDI resolves
    /// process-private fonts registered via `AddFontMemResourceEx`.
    ///
    /// Dual-pass black/white alpha matting recovers per-pixel alpha for
    /// transparent backgrounds, antialiased glyphs of any color, and opaque
    /// selection highlights without ClearType color fringing.
    pub(crate) fn draw_gdi_bgra(&self, bounds: RECT) -> Option<Vec<u8>> {
        use windows::Win32::Graphics::Gdi::{
            BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, CreateDIBSection,
            DIB_RGB_COLORS, DeleteDC, DeleteObject, SelectObject, SetViewportOrgEx,
        };
        let w = (bounds.right - bounds.left).max(0);
        let h = (bounds.bottom - bounds.top).max(0);
        if w == 0 || h == 0 {
            return None;
        }
        let byte_len = (w as usize).checked_mul(h as usize)?.checked_mul(4)?;
        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits_ptr: *mut c_void = std::ptr::null_mut();
        let _drawing = self.drawing();
        // SAFETY: GDI DC and DIB section are created and cleaned up within
        // this scope; `bits_ptr` points to `byte_len` valid bytes while `dib`
        // is alive; `TxDraw` receives a live DC and `RECTL`.
        unsafe {
            let dc = CreateCompatibleDC(None);
            if dc.is_invalid() {
                return None;
            }
            let Ok(dib) = CreateDIBSection(Some(dc), &bmi, DIB_RGB_COLORS, &mut bits_ptr, None, 0)
            else {
                let _ = DeleteDC(dc);
                return None;
            };
            if bits_ptr.is_null() {
                let _ = DeleteObject(dib.into());
                let _ = DeleteDC(dc);
                return None;
            }
            let old = SelectObject(dc, dib.into());
            let _ = SetViewportOrgEx(dc, -bounds.left, -bounds.top, None);
            let pixels = std::slice::from_raw_parts_mut(bits_ptr.cast::<u8>(), byte_len);

            let draw_pass = |bg: u8, pixels: &mut [u8]| -> bool {
                pixels.fill(bg);
                let mut rc = RECTL {
                    left: bounds.left,
                    top: bounds.top,
                    right: bounds.right,
                    bottom: bounds.bottom,
                };
                self.services
                    .TxDraw(
                        windows::Win32::System::Com::DVASPECT_CONTENT,
                        0,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        dc,
                        HDC::default(),
                        &mut rc,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        0,
                        0,
                        TXTVIEW_ACTIVE.0,
                    )
                    .is_ok()
            };

            let result = if draw_pass(0x00, pixels) {
                let mut black = pixels.to_vec();
                if draw_pass(0xFF, pixels) {
                    for (b_px, w_px) in black
                        .as_chunks_mut::<4>()
                        .0
                        .iter_mut()
                        .zip(pixels.as_chunks::<4>().0)
                    {
                        let ab = 255u32.saturating_sub(u32::from(w_px[0].saturating_sub(b_px[0])));
                        let ag = 255u32.saturating_sub(u32::from(w_px[1].saturating_sub(b_px[1])));
                        let ar = 255u32.saturating_sub(u32::from(w_px[2].saturating_sub(b_px[2])));
                        let alpha = ((ab + ag + ar + 1) / 3).min(255);
                        if alpha == 0 {
                            *b_px = [0, 0, 0, 0];
                        } else {
                            let premul = |c: u8, ac: u32| -> u8 {
                                (u32::from(c) * alpha)
                                    .checked_div(ac)
                                    .map_or(0, |v| v.min(alpha) as u8)
                            };
                            b_px[0] = premul(b_px[0], ab);
                            b_px[1] = premul(b_px[1], ag);
                            b_px[2] = premul(b_px[2], ar);
                            b_px[3] = alpha as u8;
                        }
                    }
                    Some(black)
                } else {
                    None
                }
            } else {
                None
            };

            SelectObject(dc, old);
            let _ = DeleteObject(dib.into());
            let _ = DeleteDC(dc);
            result
        }
    }

    /// Marks the field as being drawn until the guard drops: what the
    /// services invalidate meanwhile is what is being drawn.
    pub(crate) fn drawing(&self) -> Drawing<'_> {
        // SAFETY: the host lives as long as the editor.
        let host = unsafe { &*self.host };
        Drawing(&host.drawing, host.drawing.replace(true))
    }

    /// The services gained or lost the focus (UI activation and the
    /// focus message, as a window would get them).
    pub(crate) fn set_focus(&self, focused: bool) {
        // SAFETY: plain calls.
        unsafe {
            if focused {
                let _ = self.services.OnTxUIActivate();
                self.send(windows::Win32::UI::WindowsAndMessaging::WM_SETFOCUS, 0, 0);
            } else {
                self.send(windows::Win32::UI::WindowsAndMessaging::WM_KILLFOCUS, 0, 0);
                let _ = self.services.OnTxUIDeactivate();
            }
        }
    }
}

impl Drop for Editor {
    fn drop(&mut self) {
        let host = self.host;
        // `try_with`: an editor dropped during thread teardown, after the
        // timers' list, must not abort the process (#1767); the thread's
        // timers go with it.
        let _ = TIMERS.try_with(|t| {
            t.borrow_mut().retain(|&(id, h, _)| {
                if h == host {
                    // SAFETY: a thread timer we set.
                    let _ = unsafe { KillTimer(None, id) };
                    false
                } else {
                    true
                }
            })
        });
        self.host().services.set(std::ptr::null_mut());
        // SAFETY: plain call before the services go.
        let _ = unsafe { self.services.OnTxInPlaceDeactivate() };
        // SAFETY: dropped once, here; nothing uses the services after.
        unsafe { std::mem::ManuallyDrop::drop(&mut self.services) };
        // SAFETY: the reference `new` gave the editor.
        unsafe { release(host as *mut c_void) };
    }
}

// --- The host's vtable ---------------------------------------------------------

type This = *mut c_void;

#[repr(C)]
struct HostVtbl {
    query_interface: unsafe extern "system" fn(This, *const GUID, *mut *mut c_void) -> HRESULT,
    add_ref: unsafe extern "system" fn(This) -> u32,
    release: unsafe extern "system" fn(This) -> u32,
    // ITextHost
    tx_get_dc: unsafe extern "system" fn(This) -> HDC,
    tx_release_dc: unsafe extern "system" fn(This, HDC) -> i32,
    tx_show_scroll_bar: unsafe extern "system" fn(This, i32, BOOL) -> BOOL,
    tx_enable_scroll_bar: unsafe extern "system" fn(This, i32, i32) -> BOOL,
    tx_set_scroll_range: unsafe extern "system" fn(This, i32, i32, i32, BOOL) -> BOOL,
    tx_set_scroll_pos: unsafe extern "system" fn(This, i32, i32, BOOL) -> BOOL,
    tx_invalidate_rect: unsafe extern "system" fn(This, *const RECT, BOOL),
    tx_view_change: unsafe extern "system" fn(This, BOOL),
    tx_create_caret: unsafe extern "system" fn(This, HBITMAP, i32, i32) -> BOOL,
    tx_show_caret: unsafe extern "system" fn(This, BOOL) -> BOOL,
    tx_set_caret_pos: unsafe extern "system" fn(This, i32, i32) -> BOOL,
    tx_set_timer: unsafe extern "system" fn(This, u32, u32) -> BOOL,
    tx_kill_timer: unsafe extern "system" fn(This, u32),
    tx_scroll_window_ex:
        unsafe extern "system" fn(This, i32, i32, *const RECT, *const RECT, HRGN, *mut RECT, u32),
    tx_set_capture: unsafe extern "system" fn(This, BOOL),
    tx_set_focus: unsafe extern "system" fn(This),
    tx_set_cursor: unsafe extern "system" fn(This, HCURSOR, BOOL),
    tx_screen_to_client: unsafe extern "system" fn(This, *mut POINT) -> BOOL,
    tx_client_to_screen: unsafe extern "system" fn(This, *mut POINT) -> BOOL,
    tx_activate: unsafe extern "system" fn(This, *mut i32) -> HRESULT,
    tx_deactivate: unsafe extern "system" fn(This, i32) -> HRESULT,
    tx_get_client_rect: unsafe extern "system" fn(This, *mut RECT) -> HRESULT,
    tx_get_view_inset: unsafe extern "system" fn(This, *mut RECT) -> HRESULT,
    tx_get_char_format: unsafe extern "system" fn(This, *mut *const CHARFORMATW) -> HRESULT,
    tx_get_para_format: unsafe extern "system" fn(This, *mut *const PARAFORMAT) -> HRESULT,
    tx_get_sys_color: unsafe extern "system" fn(This, i32) -> COLORREF,
    tx_get_back_style: unsafe extern "system" fn(This, *mut TXTBACKSTYLE) -> HRESULT,
    tx_get_max_length: unsafe extern "system" fn(This, *mut u32) -> HRESULT,
    tx_get_scroll_bars: unsafe extern "system" fn(This, *mut u32) -> HRESULT,
    tx_get_password_char: unsafe extern "system" fn(This, *mut u16) -> HRESULT,
    tx_get_accelerator_pos: unsafe extern "system" fn(This, *mut i32) -> HRESULT,
    tx_get_extent: unsafe extern "system" fn(This, *mut SIZE) -> HRESULT,
    on_tx_char_format_change: unsafe extern "system" fn(This, *const CHARFORMATW) -> HRESULT,
    on_tx_para_format_change: unsafe extern "system" fn(This, *const PARAFORMAT) -> HRESULT,
    tx_get_property_bits: unsafe extern "system" fn(This, u32, *mut u32) -> HRESULT,
    tx_notify: unsafe extern "system" fn(This, u32, *mut c_void) -> HRESULT,
    tx_imm_get_context: unsafe extern "system" fn(This) -> HIMC,
    tx_imm_release_context: unsafe extern "system" fn(This, HIMC),
    tx_get_selection_bar_width: unsafe extern "system" fn(This, *mut i32) -> HRESULT,
    // ITextHost2
    tx_is_double_click_pending: unsafe extern "system" fn(This) -> BOOL,
    tx_get_window: unsafe extern "system" fn(This, *mut HWND) -> HRESULT,
    tx_set_foreground_window: unsafe extern "system" fn(This) -> HRESULT,
    tx_get_palette: unsafe extern "system" fn(This) -> HPALETTE,
    tx_get_east_asian_flags: unsafe extern "system" fn(This, *mut i32) -> HRESULT,
    tx_set_cursor2: unsafe extern "system" fn(This, HCURSOR, BOOL) -> HCURSOR,
    tx_free_text_services_notification: unsafe extern "system" fn(This),
    tx_get_edit_style: unsafe extern "system" fn(This, u32, *mut u32) -> HRESULT,
    tx_get_window_styles: unsafe extern "system" fn(This, *mut u32, *mut u32) -> HRESULT,
    tx_show_drop_caret: unsafe extern "system" fn(This, BOOL, HDC, *mut RECT) -> HRESULT,
    tx_destroy_caret: unsafe extern "system" fn(This) -> HRESULT,
    tx_get_horz_extent: unsafe extern "system" fn(This, *mut i32) -> HRESULT,
}

static HOST_VTBL: HostVtbl = HostVtbl {
    query_interface,
    add_ref,
    release,
    tx_get_dc,
    tx_release_dc,
    tx_show_scroll_bar,
    tx_enable_scroll_bar,
    tx_set_scroll_range,
    tx_set_scroll_pos,
    tx_invalidate_rect,
    tx_view_change,
    tx_create_caret,
    tx_show_caret,
    tx_set_caret_pos,
    tx_set_timer,
    tx_kill_timer,
    tx_scroll_window_ex,
    tx_set_capture,
    tx_set_focus,
    tx_set_cursor,
    tx_screen_to_client,
    tx_client_to_screen,
    tx_activate,
    tx_deactivate,
    tx_get_client_rect,
    tx_get_view_inset,
    tx_get_char_format,
    tx_get_para_format,
    tx_get_sys_color,
    tx_get_back_style,
    tx_get_max_length,
    tx_get_scroll_bars,
    tx_get_password_char,
    tx_get_accelerator_pos,
    tx_get_extent,
    on_tx_char_format_change,
    on_tx_para_format_change,
    tx_get_property_bits,
    tx_notify,
    tx_imm_get_context,
    tx_imm_release_context,
    tx_get_selection_bar_width,
    tx_is_double_click_pending,
    tx_get_window,
    tx_set_foreground_window,
    tx_get_palette,
    tx_get_east_asian_flags,
    tx_set_cursor2,
    tx_free_text_services_notification,
    tx_get_edit_style,
    tx_get_window_styles,
    tx_show_drop_caret,
    tx_destroy_caret,
    tx_get_horz_extent,
};

/// The host behind `this`.
///
/// # Safety
///
/// `this` is a host made by [`Editor::new`] with a live reference.
unsafe fn host<'a>(this: This) -> &'a Host {
    // SAFETY: as the caller promises.
    unsafe { &*(this as *const Host) }
}

unsafe extern "system" fn query_interface(
    this: This,
    iid: *const GUID,
    out: *mut *mut c_void,
) -> HRESULT {
    if out.is_null() || iid.is_null() {
        return E_POINTER;
    }
    // SAFETY: valid pointers from the caller.
    unsafe {
        let iid = &*iid;
        let known =
            *iid == IUnknown::IID || lib().is_some_and(|l| *iid == l.host || *iid == l.host2);
        if known {
            add_ref(this);
            *out = this;
            S_OK
        } else {
            *out = std::ptr::null_mut();
            E_NOINTERFACE
        }
    }
}

unsafe extern "system" fn add_ref(this: This) -> u32 {
    // SAFETY: a live host.
    let host = unsafe { host(this) };
    let n = host.refs.get() + 1;
    host.refs.set(n);
    n
}

/// Releases a reference to a host; the last one frees it.
///
/// # Safety
///
/// `this` holds a reference.
unsafe extern "system" fn release(this: This) -> u32 {
    // SAFETY: a live host.
    let n = unsafe { host(this) }.refs.get() - 1;
    if n == 0 {
        // SAFETY: the last reference: the box `Editor::new` leaked.
        drop(unsafe { Box::from_raw(this as *mut Host) });
    } else {
        // SAFETY: still live.
        unsafe { host(this) }.refs.set(n);
    }
    n
}

unsafe extern "system" fn tx_get_dc(this: This) -> HDC {
    // SAFETY: the host's window.
    unsafe { GetDC(Some(host(this).hwnd)) }
}

unsafe extern "system" fn tx_release_dc(this: This, hdc: HDC) -> i32 {
    // SAFETY: a DC from `tx_get_dc`.
    unsafe { ReleaseDC(Some(host(this).hwnd), hdc) }
}

unsafe extern "system" fn tx_show_scroll_bar(_: This, _: i32, _: BOOL) -> BOOL {
    BOOL(1)
}

unsafe extern "system" fn tx_enable_scroll_bar(_: This, _: i32, _: i32) -> BOOL {
    BOOL(1)
}

unsafe extern "system" fn tx_set_scroll_range(_: This, _: i32, _: i32, _: i32, _: BOOL) -> BOOL {
    BOOL(1)
}

unsafe extern "system" fn tx_set_scroll_pos(this: This, _: i32, _: i32, _: BOOL) -> BOOL {
    // The text scrolled: drawn again (and the field reports it).
    // SAFETY: a live host.
    let host = unsafe { host(this) };
    if !host.drawing.get() {
        (host.invalidate)();
    }
    BOOL(1)
}

unsafe extern "system" fn tx_invalidate_rect(this: This, _: *const RECT, _: BOOL) {
    // SAFETY: a live host.
    let host = unsafe { host(this) };
    if !host.drawing.get() {
        (host.invalidate)();
    }
}

unsafe extern "system" fn tx_view_change(this: This, _: BOOL) {
    // SAFETY: a live host.
    let host = unsafe { host(this) };
    if !host.drawing.get() {
        (host.invalidate)();
    }
}

unsafe extern "system" fn tx_create_caret(this: This, _: HBITMAP, width: i32, height: i32) -> BOOL {
    // SAFETY: a live host.
    let host = unsafe { host(this) };
    let mut c = host.caret.get();
    c.width = width.max(1);
    c.height = height;
    host.caret.set(c);
    BOOL(1)
}

unsafe extern "system" fn tx_show_caret(this: This, show: BOOL) -> BOOL {
    // SAFETY: a live host.
    let host = unsafe { host(this) };
    let mut c = host.caret.get();
    if c.shown != show.as_bool() {
        c.shown = show.as_bool();
        host.caret.set(c);
        (host.invalidate)();
    }
    BOOL(1)
}

unsafe extern "system" fn tx_set_caret_pos(this: This, x: i32, y: i32) -> BOOL {
    // SAFETY: a live host.
    let host = unsafe { host(this) };
    let mut c = host.caret.get();
    if (c.x, c.y) != (x, y) {
        c.x = x;
        c.y = y;
        host.caret.set(c);
        (host.invalidate)();
    }
    BOOL(1)
}

unsafe extern "system" fn timer_proc(_: HWND, _: u32, id: usize, _: u32) {
    let Some((host, re_id)) =
        TIMERS.with(|t| t.borrow().iter().find(|e| e.0 == id).map(|e| (e.1, e.2)))
    else {
        return;
    };
    // SAFETY: timers are killed before their host's editor goes, so the
    // host is live; its services pointer is null once released.
    unsafe {
        let host = &*host;
        let services = host.services.get();
        if re_id == NOTES_LATER {
            // Once: the notes are the field's to take from here.
            TIMERS.with(|t| t.borrow_mut().retain(|e| e.0 != id));
            let _ = KillTimer(None, id);
            // Nothing left when the field took them after a message of its
            // own meanwhile.
            if !services.is_null() && !host.notes.get().is_empty() {
                (host.after_timer)();
            }
            return;
        }
        if services.is_null() {
            return;
        }
        let services = ITextServices2::from_raw_borrowed(&services).expect("services");
        let mut result = LRESULT(0);
        let _ = services.TxSendMessage(WM_TIMER, WPARAM(re_id as usize), LPARAM(0), &mut result);
        (host.after_timer)();
    }
}

unsafe extern "system" fn tx_set_timer(this: This, id: u32, ms: u32) -> BOOL {
    let host = this as *const Host;
    // An existing timer of that id is replaced.
    // SAFETY: as in `tx_kill_timer`.
    unsafe { tx_kill_timer(this, id) };
    // SAFETY: a thread timer with a TIMERPROC that lives for the program.
    let sys = unsafe { SetTimer(None, 0, ms, Some(timer_proc)) };
    if sys == 0 {
        return BOOL(0);
    }
    TIMERS.with(|t| t.borrow_mut().push((sys, host, id)));
    BOOL(1)
}

/// Hands the field `host`'s notes once the thread is back in its message
/// loop, unless it took them by then. The field takes them after each
/// message it sends the services, but an input method that writes through
/// Text Services Framework (Microsoft Pinyin, the other built-in ones)
/// edits their text from the thread's message loop, in no message of the
/// field's: its composition, and the text it commits, waited for the next
/// key the field sent (a commit showed only once another key was typed).
fn notes_later(host: *const Host) {
    // `try_with`: none during thread teardown (#1767).
    let pending = TIMERS.try_with(|t| {
        t.borrow()
            .iter()
            .any(|&(_, h, re)| h == host && re == NOTES_LATER)
    });
    if !matches!(pending, Ok(false)) {
        return;
    }
    // SAFETY: a thread timer with a TIMERPROC that lives for the program;
    // `Editor`'s drop kills it with the services' timers.
    let sys = unsafe { SetTimer(None, 0, 0, Some(timer_proc)) };
    if sys != 0 {
        let _ = TIMERS.try_with(|t| t.borrow_mut().push((sys, host, NOTES_LATER)));
    }
}

unsafe extern "system" fn tx_kill_timer(this: This, id: u32) {
    let host = this as *const Host;
    TIMERS.with(|t| {
        t.borrow_mut().retain(|&(sys, h, re)| {
            if h == host && re == id {
                // SAFETY: a thread timer we set.
                let _ = unsafe { KillTimer(None, sys) };
                false
            } else {
                true
            }
        })
    });
}

unsafe extern "system" fn tx_scroll_window_ex(
    this: This,
    _: i32,
    _: i32,
    _: *const RECT,
    _: *const RECT,
    _: HRGN,
    _: *mut RECT,
    _: u32,
) {
    // SAFETY: a live host.
    unsafe { (host(this).invalidate)() }
}

unsafe extern "system" fn tx_set_capture(_: This, _: BOOL) {
    // The window's pointer handling keeps sending a pressed field the
    // mouse until it is released.
}

unsafe extern "system" fn tx_set_focus(_: This) {
    // The field takes the focus itself (`text_input::set_focus`).
}

unsafe extern "system" fn tx_set_cursor(_: This, _: HCURSOR, _: BOOL) {
    // The window sets the cursor (the field's is the I-beam).
}

unsafe extern "system" fn tx_screen_to_client(this: This, pt: *mut POINT) -> BOOL {
    // SAFETY: the window and a point from the caller.
    unsafe { ScreenToClient(host(this).shown_in.get(), pt) }
}

unsafe extern "system" fn tx_client_to_screen(this: This, pt: *mut POINT) -> BOOL {
    // SAFETY: as above.
    unsafe { ClientToScreen(host(this).shown_in.get(), pt) }
}

unsafe extern "system" fn tx_activate(_: This, old: *mut i32) -> HRESULT {
    if !old.is_null() {
        // SAFETY: an out value.
        unsafe { *old = 0 };
    }
    S_OK
}

unsafe extern "system" fn tx_deactivate(_: This, _: i32) -> HRESULT {
    S_OK
}

unsafe extern "system" fn tx_get_client_rect(this: This, rect: *mut RECT) -> HRESULT {
    // SAFETY: a live host and an out value.
    unsafe { *rect = host(this).props.borrow().client };
    S_OK
}

unsafe extern "system" fn tx_get_view_inset(_: This, rect: *mut RECT) -> HRESULT {
    // SAFETY: an out value.
    unsafe { *rect = RECT::default() };
    S_OK
}

unsafe extern "system" fn tx_get_char_format(this: This, out: *mut *const CHARFORMATW) -> HRESULT {
    // SAFETY: the host outlives the services, and its props stay where
    // they are (boxed); the services read the format before it changes
    // (the change is announced after it is made).
    unsafe { *out = &host(this).props.borrow().char_format as *const CHARFORMAT2W as *const _ };
    S_OK
}

unsafe extern "system" fn tx_get_para_format(this: This, out: *mut *const PARAFORMAT) -> HRESULT {
    // SAFETY: as above.
    unsafe { *out = &host(this).props.borrow().para_format as *const PARAFORMAT2 as *const _ };
    S_OK
}

unsafe extern "system" fn tx_get_sys_color(this: This, index: i32) -> COLORREF {
    // COLOR_HIGHLIGHT, COLOR_HIGHLIGHTTEXT.
    // SAFETY: a live host.
    if let Some((back, text)) = unsafe { host(this) }.props.borrow().highlight {
        match index {
            13 => return back,
            14 => return text,
            _ => {}
        }
    }
    // SAFETY: a plain query.
    COLORREF(unsafe { GetSysColor(SYS_COLOR_INDEX(index)) })
}

unsafe extern "system" fn tx_get_back_style(_: This, style: *mut TXTBACKSTYLE) -> HRESULT {
    // The view draws the field's background.
    // SAFETY: an out value.
    unsafe { *style = TXTBACK_TRANSPARENT };
    S_OK
}

/// The text of `services`, whose host's property bits are `bits`: rich
/// text always ends with a paragraph mark of its own, which is not the
/// field's text and is left out.
fn text_of(services: &ITextServices2, bits: u32) -> Vec<u16> {
    let mut bstr = windows::core::BSTR::new();
    // SAFETY: an out BSTR we own.
    let _ = unsafe { services.TxGetText(&mut bstr) };
    let mut units = bstr.to_vec();
    if bits & TXTBIT_RICHTEXT != 0 && units.last() == Some(&u16::from(b'\r')) {
        units.pop();
    }
    units
}

unsafe extern "system" fn tx_get_max_length(this: This, out: *mut u32) -> HRESULT {
    // SAFETY: a live host and an out value.
    unsafe { *out = host(this).props.borrow().max_length };
    S_OK
}

unsafe extern "system" fn tx_get_scroll_bars(this: This, out: *mut u32) -> HRESULT {
    // SAFETY: as above.
    unsafe { *out = host(this).props.borrow().scroll };
    S_OK
}

unsafe extern "system" fn tx_get_password_char(this: This, out: *mut u16) -> HRESULT {
    // SAFETY: as above.
    unsafe { *out = host(this).props.borrow().password };
    S_OK
}

unsafe extern "system" fn tx_get_accelerator_pos(_: This, out: *mut i32) -> HRESULT {
    // SAFETY: an out value.
    unsafe { *out = -1 };
    S_OK
}

unsafe extern "system" fn tx_get_extent(_: This, _: *mut SIZE) -> HRESULT {
    // No zoom: the services lay out in the client rectangle's pixels.
    E_NOTIMPL
}

unsafe extern "system" fn on_tx_char_format_change(_: This, _: *const CHARFORMATW) -> HRESULT {
    S_OK
}

unsafe extern "system" fn on_tx_para_format_change(_: This, _: *const PARAFORMAT) -> HRESULT {
    S_OK
}

unsafe extern "system" fn tx_get_property_bits(this: This, mask: u32, out: *mut u32) -> HRESULT {
    // SAFETY: a live host and an out value.
    unsafe { *out = host(this).props.borrow().bits & mask };
    S_OK
}

unsafe extern "system" fn tx_notify(this: This, code: u32, _: *mut c_void) -> HRESULT {
    // SAFETY: a live host.
    let host = unsafe { host(this) };
    let mut notes = host.notes.get();
    match code {
        EN_CHANGE => notes.changed = true,
        EN_SELCHANGE => notes.selection = true,
        EN_STARTCOMPOSITION => {
            let services = host.services.get();
            if !services.is_null() {
                // SAFETY: queries the services answer from a notification
                // (the selection and the length; nothing changes).
                unsafe {
                    let services = ITextServices2::from_raw_borrowed(&services).expect("services");
                    let mut range = CHARRANGE::default();
                    let mut r = LRESULT(0);
                    let _ = services.TxSendMessage(
                        EM_EXGETSEL,
                        WPARAM(0),
                        LPARAM(&mut range as *mut _ as isize),
                        &mut r,
                    );
                    let len = text_of(services, host.props.borrow().bits).len() as u32;
                    let at = |cp: i32| (cp.max(0) as u32).min(len);
                    notes.composition_start = Some((at(range.cpMin), at(range.cpMax), len));
                }
            }
        }
        EN_ENDCOMPOSITION => {
            // A composition that started since the field last looked ended
            // unseen: its commit stays in the text as a plain edit.
            if notes.composition_start.take().is_none() {
                notes.composition_end = true;
            }
        }
        _ => return S_OK,
    }
    host.notes.set(notes);
    // Not while drawing, nor once the editor is going (its timers are
    // killed before the services are deactivated, which may notify).
    if !host.drawing.get() && !host.services.get().is_null() {
        notes_later(host);
    }
    S_OK
}

unsafe extern "system" fn tx_imm_get_context(this: This) -> HIMC {
    // SAFETY: the host's window (moving IMC to shown_in breaks composition, #2094).
    unsafe { ImmGetContext(host(this).hwnd) }
}

unsafe extern "system" fn tx_imm_release_context(this: This, himc: HIMC) {
    // SAFETY: a context from `tx_imm_get_context`.
    let _ = unsafe { ImmReleaseContext(host(this).hwnd, himc) };
}

unsafe extern "system" fn tx_get_selection_bar_width(_: This, out: *mut i32) -> HRESULT {
    // SAFETY: an out value.
    unsafe { *out = 0 };
    S_OK
}

unsafe extern "system" fn tx_is_double_click_pending(_: This) -> BOOL {
    BOOL(0)
}

unsafe extern "system" fn tx_get_window(this: This, out: *mut HWND) -> HRESULT {
    // SAFETY: a live host and an out value.
    unsafe { *out = host(this).hwnd };
    S_OK
}

unsafe extern "system" fn tx_set_foreground_window(_: This) -> HRESULT {
    S_OK
}

unsafe extern "system" fn tx_get_palette(_: This) -> HPALETTE {
    HPALETTE::default()
}

unsafe extern "system" fn tx_get_east_asian_flags(_: This, out: *mut i32) -> HRESULT {
    // SAFETY: an out value.
    unsafe { *out = 0 };
    S_OK
}

unsafe extern "system" fn tx_set_cursor2(_: This, _: HCURSOR, _: BOOL) -> HCURSOR {
    HCURSOR::default()
}

unsafe extern "system" fn tx_free_text_services_notification(_: This) {}

unsafe extern "system" fn tx_get_edit_style(_: This, _: u32, out: *mut u32) -> HRESULT {
    // SAFETY: an out value.
    unsafe { *out = 0 };
    S_OK
}

unsafe extern "system" fn tx_get_window_styles(_: This, style: *mut u32, ex: *mut u32) -> HRESULT {
    // SAFETY: out values.
    unsafe {
        *style = 0;
        *ex = 0;
    }
    S_OK
}

unsafe extern "system" fn tx_show_drop_caret(_: This, _: BOOL, _: HDC, _: *mut RECT) -> HRESULT {
    S_OK
}

unsafe extern "system" fn tx_destroy_caret(this: This) -> HRESULT {
    // SAFETY: a live host.
    let host = unsafe { host(this) };
    let mut c = host.caret.get();
    if c.shown {
        c.shown = false;
        host.caret.set(c);
        (host.invalidate)();
    }
    S_OK
}

unsafe extern "system" fn tx_get_horz_extent(_: This, out: *mut i32) -> HRESULT {
    // SAFETY: an out value.
    unsafe { *out = 0 };
    S_FALSE
}

/// How much the services' drawing is scaled into a target of `scale`:
/// they turn client pixels into the target's units by GDI's DPI
/// ([`dpi`]), whatever the target's own DPI is. 1 on a monitor at the
/// system's scale; on any other the text would be drawn `scale` over GDI's
/// scale times too large, from the target's origin.
pub(crate) fn target_scale(hwnd: HWND, scale: f32) -> f32 {
    dpi(hwnd) / (96.0 * scale.max(0.01))
}

/// The window's vertical DPI as GDI reports it, which the services convert
/// twips to pixels with, and client pixels to a Direct2D target's units.
pub(crate) fn dpi(hwnd: HWND) -> f32 {
    // SAFETY: a DC of the window, released after the query.
    unsafe {
        let dc = GetDC(Some(hwnd));
        let dpi = GetDeviceCaps(Some(dc), LOGPIXELSY);
        ReleaseDC(Some(hwnd), dc);
        if dpi > 0 { dpi as f32 } else { 96.0 }
    }
}

#[cfg(test)]
mod tests {
    use std::rc::Rc;

    use windows::Win32::UI::{
        Controls::RichEdit::{EM_SETEVENTMASK, ENM_CHANGE, ENM_SELCHANGE},
        WindowsAndMessaging::{DispatchMessageW, MSG, PM_REMOVE, PeekMessageW},
    };

    use super::*;

    /// `EM_REPLACESEL`.
    const EM_REPLACESEL: u32 = 0x00C2;

    /// Runs the thread's message loop for `ms`.
    fn pump(ms: u64) {
        let until = std::time::Instant::now() + std::time::Duration::from_millis(ms);
        while std::time::Instant::now() < until {
            let mut msg = MSG::default();
            // SAFETY: the thread's own queue.
            unsafe {
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    DispatchMessageW(&msg);
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }

    /// An editor that counts the times it hands its notes on, with no
    /// notes left.
    fn editor() -> (Editor, Rc<Cell<u32>>) {
        let handed = Rc::new(Cell::new(0));
        let count = handed.clone();
        let e = Editor::new(
            HWND::default(),
            Props::default(),
            Box::new(|| {}),
            Box::new(move || count.set(count.get() + 1)),
        )
        .expect("RichEdit");
        e.send(EM_SETEVENTMASK, 0, (ENM_CHANGE | ENM_SELCHANGE) as isize);
        pump(30);
        e.take_notes();
        handed.set(0);
        (e, handed)
    }

    fn type_in(e: &Editor, text: &str) {
        let wide: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
        e.send(EM_REPLACESEL, 1, wide.as_ptr() as isize);
    }

    /// Where the ink of "MMMM" lands (pixels: left, top, right, bottom),
    /// drawn in the client rectangle (200, 100)–(600, 200) through a target
    /// of `scale` with the transform scaled by `k`.
    fn ink(scale: f32, k: f32) -> Option<(u32, u32, u32, u32)> {
        let dpi = 96.0 * scale;
        use windows::Win32::{
            Graphics::{
                Direct2D::{
                    Common::{
                        D2D_POINT_2U, D2D_RECT_U, D2D_SIZE_U, D2D1_ALPHA_MODE_PREMULTIPLIED,
                        D2D1_PIXEL_FORMAT,
                    },
                    D2D1_BITMAP_OPTIONS, D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
                    D2D1_BITMAP_OPTIONS_CPU_READ, D2D1_BITMAP_OPTIONS_TARGET,
                    D2D1_BITMAP_PROPERTIES1, D2D1_MAP_OPTIONS_READ,
                },
                Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM,
            },
            UI::Controls::RichEdit::{CFM_COLOR, CFM_FACE, CFM_SIZE, TXTBIT_D2DDWRITE},
        };
        use windows_numerics::Matrix3x2;
        let gfx = crate::gfx::get().unwrap();
        let mut p = Props {
            client: RECT {
                left: 200,
                top: 100,
                right: 600,
                bottom: 200,
            },
            bits: TXTBIT_D2DDWRITE,
            ..Props::default()
        };
        p.char_format.Base.dwMask = CFM_FACE | CFM_SIZE | CFM_COLOR;
        p.char_format.Base.yHeight = (40.0 * 1440.0 / super::dpi(HWND::default())) as i32;
        for (i, u) in "Segoe UI".encode_utf16().enumerate() {
            p.char_format.Base.szFaceName[i] = u;
        }
        let client = p.client;
        let e = Editor::new(HWND::default(), p, Box::new(|| {}), Box::new(|| {})).unwrap();
        e.set_text("MMMM");
        let (w, h) = (1600u32, 600u32);
        let props = |options: D2D1_BITMAP_OPTIONS| D2D1_BITMAP_PROPERTIES1 {
            pixelFormat: D2D1_PIXEL_FORMAT {
                format: DXGI_FORMAT_B8G8R8A8_UNORM,
                alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
            },
            dpiX: 96.0,
            dpiY: 96.0,
            bitmapOptions: options,
            colorContext: std::mem::ManuallyDrop::new(None),
        };
        let size = D2D_SIZE_U {
            width: w,
            height: h,
        };
        // SAFETY: COM calls on live objects; the mapped memory is read
        // before `Unmap`.
        unsafe {
            let dc = &gfx.dc;
            let target = dc
                .CreateBitmap(size, None, 0, &props(D2D1_BITMAP_OPTIONS_TARGET))
                .unwrap();
            dc.SetTarget(&target);
            dc.SetDpi(dpi, dpi);
            dc.BeginDraw();
            dc.Clear(None);
            dc.SetTransform(&Matrix3x2 {
                M11: k,
                M12: 0.0,
                M21: 0.0,
                M22: k,
                M31: 0.0,
                M32: 0.0,
            });
            assert!(e.draw(dc.as_raw(), client));
            dc.SetTransform(&Matrix3x2::identity());
            dc.EndDraw(None, None).unwrap();
            dc.SetTarget(None);
            dc.SetDpi(96.0, 96.0);
            let read = dc
                .CreateBitmap(
                    size,
                    None,
                    0,
                    &props(D2D1_BITMAP_OPTIONS_CPU_READ | D2D1_BITMAP_OPTIONS_CANNOT_DRAW),
                )
                .unwrap();
            read.CopyFromBitmap(
                Some(&D2D_POINT_2U { x: 0, y: 0 }),
                &target,
                Some(&D2D_RECT_U {
                    left: 0,
                    top: 0,
                    right: w,
                    bottom: h,
                }),
            )
            .unwrap();
            let mapped = read.Map(D2D1_MAP_OPTIONS_READ).unwrap();
            let mut b: Option<(u32, u32, u32, u32)> = None;
            for y in 0..h {
                let row = std::slice::from_raw_parts(
                    mapped.bits.add((y * mapped.pitch) as usize),
                    (w * 4) as usize,
                );
                for x in 0..w {
                    if row[(x * 4 + 3) as usize] > 40 {
                        b = Some(match b {
                            None => (x, y, x, y),
                            Some((l, t, r, bt)) => (l.min(x), t.min(y), r.max(x), bt.max(y)),
                        });
                    }
                }
            }
            read.Unmap().unwrap();
            b
        }
    }

    /// A window on a monitor of another scale than the system's (GDI's
    /// DPI stays the system's there): the text is drawn where the client
    /// rectangle is, at its size, whatever the target's scale.
    #[test]
    fn text_lands_in_the_client_rectangle_at_any_target_scale() {
        let hwnd = HWND::default();
        let system = ink(dpi(hwnd) / 96.0, 1.0).expect("text at the system's scale");
        assert!(system.0 >= 200 && system.1 >= 100 && system.2 < 600 && system.3 < 200);
        for scale in [1.0, 1.25, 1.5, 2.5] {
            let at = ink(scale, target_scale(hwnd, scale)).expect("text");
            for (a, b) in [
                (at.0, system.0),
                (at.1, system.1),
                (at.2, system.2),
                (at.3, system.3),
            ] {
                assert!(a.abs_diff(b) <= 2, "at {scale}: {at:?}, not {system:?}");
            }
        }
    }

    #[test]
    fn notes_left_untaken_reach_the_field_from_the_loop() {
        // As an input method's commit through Text Services Framework,
        // which is in no message of the field's.
        let (e, handed) = editor();
        type_in(&e, "你好");
        assert_eq!(handed.get(), 0, "not from inside the services");
        pump(60);
        assert_eq!(handed.get(), 1, "handed on once");
        assert!(e.take_notes().changed, "the notes stay for the field");
    }

    #[test]
    fn notes_the_field_took_are_not_handed_again() {
        let (e, handed) = editor();
        type_in(&e, "a");
        assert!(e.take_notes().changed);
        pump(60);
        assert_eq!(handed.get(), 0);
    }

    #[test]
    fn a_gone_editor_hands_nothing_on() {
        let (e, handed) = editor();
        type_in(&e, "a");
        drop(e);
        pump(60);
        assert_eq!(handed.get(), 0);
        assert!(TIMERS.with(|t| t.borrow().is_empty()));
    }
}
