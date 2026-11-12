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
            COLORREF, E_NOINTERFACE, E_NOTIMPL, E_POINTER, HWND, LPARAM, LRESULT, POINT, RECT,
            RECTL, S_FALSE, S_OK, SIZE, WPARAM,
        },
        Graphics::Gdi::{
            ClientToScreen, GetDC, GetDeviceCaps, GetSysColor, HBITMAP, HDC, HPALETTE, HRGN,
            LOGPIXELSY, ReleaseDC, SYS_COLOR_INDEX, ScreenToClient,
        },
        System::LibraryLoader::{GetProcAddress, LoadLibraryW},
        UI::{
            Controls::RichEdit::{
                CHARFORMAT2W, CHARFORMATW, CHARRANGE, EM_EXGETSEL, ITextServices2, PARAFORMAT,
                PARAFORMAT2, TXTBACK_TRANSPARENT, TXTBACKSTYLE, TXTVIEW_ACTIVE,
            },
            Input::Ime::{HIMC, ImmGetContext, ImmReleaseContext},
            WindowsAndMessaging::{HCURSOR, KillTimer, SetTimer, WM_GETTEXTLENGTH, WM_TIMER},
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
    /// `ES_AUTOHSCROLL` / `ES_AUTOVSCROLL`: how the text scrolls (never a
    /// scroll bar: there is no window to put one in).
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
    /// A composition started, with the selection (UTF-16) and the text's
    /// length at that moment.
    pub(crate) composition_start: Option<(u32, u32, u32)>,
    /// The composition ended.
    pub(crate) composition_end: bool,
}

/// Our `ITextHost2`.
#[repr(C)]
struct Host {
    vtbl: *const HostVtbl,
    refs: Cell<u32>,
    hwnd: HWND,
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
    /// selection (a drag scrolling).
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

    /// The caret the services placed.
    pub(crate) fn caret(&self) -> Caret {
        self.host().caret.get()
    }

    /// The text (plain, lines broken by `\r`, as the services keep it).
    pub(crate) fn text_units(&self) -> Vec<u16> {
        let mut bstr = windows::core::BSTR::new();
        // SAFETY: an out BSTR we own.
        let _ = unsafe { self.services.TxGetText(&mut bstr) };
        bstr.to_vec()
    }

    /// Replaces the text (no undo, no notification but `EN_CHANGE`).
    pub(crate) fn set_text(&self, text: &str) {
        let wide: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
        // SAFETY: a NUL-terminated string that outlives the call.
        let _ = unsafe { self.services.TxSetText(PCWSTR(wide.as_ptr())) };
    }

    /// The selection, in UTF-16 units (start ≤ end).
    pub(crate) fn selection(&self) -> (u32, u32) {
        let mut range = CHARRANGE::default();
        self.send(EM_EXGETSEL, 0, &mut range as *mut _ as isize);
        (range.cpMin.max(0) as u32, range.cpMax.max(0) as u32)
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
        TIMERS.with(|t| {
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
    unsafe { ScreenToClient(host(this).hwnd, pt) }
}

unsafe extern "system" fn tx_client_to_screen(this: This, pt: *mut POINT) -> BOOL {
    // SAFETY: as above.
    unsafe { ClientToScreen(host(this).hwnd, pt) }
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
            notes.composition_end = false;
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
                    let mut len = LRESULT(0);
                    let _ =
                        services.TxSendMessage(WM_GETTEXTLENGTH, WPARAM(0), LPARAM(0), &mut len);
                    notes.composition_start = Some((
                        range.cpMin.max(0) as u32,
                        range.cpMax.max(0) as u32,
                        len.0.max(0) as u32,
                    ));
                }
            }
        }
        EN_ENDCOMPOSITION => notes.composition_end = true,
        _ => {}
    }
    host.notes.set(notes);
    S_OK
}

unsafe extern "system" fn tx_imm_get_context(this: This) -> HIMC {
    // SAFETY: the host's window.
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

/// The window's vertical DPI as GDI reports it, which the services convert
/// twips to pixels with.
pub(crate) fn dpi(hwnd: HWND) -> f32 {
    // SAFETY: a DC of the window, released after the query.
    unsafe {
        let dc = GetDC(Some(hwnd));
        let dpi = GetDeviceCaps(Some(dc), LOGPIXELSY);
        ReleaseDC(Some(hwnd), dc);
        if dpi > 0 { dpi as f32 } else { 96.0 }
    }
}
