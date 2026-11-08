//! URL schemes on Windows (`EventKind::UrlScheme`, nsh.json `schemes`): the system
//! opens `<scheme>:...` URLs with the app, and the app hears them.
//!
//! - Registration: `HKCU\Software\Classes\<scheme>` marks the scheme a URL
//!   protocol whose `shell\open\command` runs the executable with the URL as
//!   its argument. Written at startup by the release runner ([`start`]) when
//!   the command differs from what is there: the app may have moved. The
//!   development host registers nothing.
//! - Launch: an argument that is a URL of one of the app's schemes is sent to
//!   the root surface once it exists ([`attach`]); the core keeps it until JS
//!   listens.
//! - One instance: the first instance of an app with schemes owns a named
//!   mutex keyed by the app id and marks its top-level window with a property
//!   ([`attach`]). A later launch with a URL finds that window, lets it take
//!   the foreground, hands it the URL in a `WM_COPYDATA` and exits; the
//!   running instance restores its window, brings it to the front and sends
//!   the URL. A launch without a URL opens another window, as before.

use std::{
    cell::RefCell,
    rc::{Rc, Weak},
};

use nsh_core::{EventKind, EventPayload, PayloadValue, ROOT_ID};
use windows::{
    Win32::{
        Foundation::{
            ERROR_ALREADY_EXISTS, GetLastError, HANDLE, HWND, LPARAM, LRESULT, TRUE, WPARAM,
        },
        System::{
            DataExchange::COPYDATASTRUCT,
            Registry::{HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ, RegGetValueW, RegSetKeyValueW},
        },
        UI::{
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::{
                AllowSetForegroundWindow, EnumWindows, GA_ROOT, GetAncestor, GetPropW,
                GetWindowThreadProcessId, IsIconic, SMTO_ABORTIFHUNG, SW_RESTORE,
                SendMessageTimeoutW, SetForegroundWindow, SetPropW, ShowWindow, WM_COPYDATA,
                WM_NCDESTROY,
            },
        },
    },
    core::{BOOL, HSTRING, PCWSTR, Result},
};

use crate::surface::Surface;

// Declared here: the `windows` crate's binding needs its `Win32_Security`
// feature for the attributes, which are always null here.
#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateMutexW(attributes: *const std::ffi::c_void, owner: BOOL, name: PCWSTR) -> HANDLE;
}

/// `COPYDATASTRUCT::dwData` of a forwarded URL ("NSHL").
const COPY_LINK: usize = 0x4E53_484C;
/// The subclass id of the window that hears forwarded URLs.
const SUBCLASS: usize = 0x4E53_484C;
/// How long a second launch looks for the first one's window, which may still
/// be opening, in steps of [`WAIT_STEP_MS`].
const WAIT_STEPS: u32 = 50;
const WAIT_STEP_MS: u64 = 100;

thread_local! {
    /// The URL the process was started with, until the root surface exists.
    static LAUNCH: RefCell<Option<String>> = const { RefCell::new(None) };
    /// The property that marks this app's window ([`property`]).
    static PROPERTY: RefCell<Option<HSTRING>> = const { RefCell::new(None) };
    /// The surface forwarded URLs go to.
    static SURFACE: RefCell<Option<Weak<Surface>>> = const { RefCell::new(None) };
}

/// What [`start`] decided.
pub(crate) enum Start {
    /// This process runs the app.
    Run,
    /// The URL went to the running instance: this process exits.
    Forwarded,
}

/// Registers `schemes` for the app `id` named `name`, reads the launch URL
/// and, when an instance of the app already runs, forwards the URL to it. On
/// the UI thread, before the window opens. Does nothing without schemes.
pub(crate) fn start(id: &str, name: &str, schemes: &[String]) -> Start {
    if schemes.is_empty() {
        return Start::Run;
    }
    if !cfg!(feature = "dev") {
        for scheme in schemes {
            if let Err(err) = register(scheme, name) {
                log::warn!("links: cannot register the scheme {scheme}: {err}");
            }
        }
    }
    let url = std::env::args().nth(1).filter(|arg| matches(arg, schemes));
    let property = property(id);
    PROPERTY.with(|p| *p.borrow_mut() = Some(property.clone()));
    let mutex = HSTRING::from(format!("Local\\nsh-app-{}", sanitize(id)));
    // SAFETY: default security, not owned, a valid name. The handle is
    // kept for the process's life (the system closes it at exit), so the
    // mutex marks the running instance.
    let first = unsafe {
        let handle = CreateMutexW(std::ptr::null(), BOOL(0), PCWSTR(mutex.as_ptr()));
        handle.is_invalid() || GetLastError() != ERROR_ALREADY_EXISTS
    };
    if !first && let Some(url) = &url {
        if forward(&property, url) {
            return Start::Forwarded;
        }
        log::warn!("links: the running instance did not answer; opening another");
    }
    LAUNCH.with(|l| *l.borrow_mut() = url);
    Start::Run
}

/// Marks `surface`'s top-level window as the app's, hears URLs forwarded to
/// it and sends the launch URL. After the app is loaded.
pub(crate) fn attach(surface: &Rc<Surface>) {
    let Some(property) = PROPERTY.with(|p| p.borrow().clone()) else {
        return;
    };
    SURFACE.with(|s| *s.borrow_mut() = Some(Rc::downgrade(surface)));
    // SAFETY: plain calls on the app's live window; the subclass removes
    // itself at `WM_NCDESTROY`.
    unsafe {
        let window = GetAncestor(surface.hwnd(), GA_ROOT);
        let _ = SetPropW(window, &property, Some(HANDLE(std::ptr::dangling_mut())));
        let _ = SetWindowSubclass(window, Some(link_proc), SUBCLASS, 0);
    }
    if let Some(url) = LAUNCH.with(|l| l.borrow_mut().take()) {
        send(surface, url);
    }
}

fn send(surface: &Surface, url: String) {
    surface.event(
        ROOT_ID,
        EventKind::UrlScheme,
        EventPayload::Map(vec![("url", PayloadValue::Str(url))]),
    );
}

/// The app's window's messages: URLs from later launches.
unsafe extern "system" fn link_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    id: usize,
    _: usize,
) -> LRESULT {
    match msg {
        WM_COPYDATA => {
            // SAFETY: for `WM_COPYDATA`, `lparam` is a COPYDATASTRUCT the
            // sender keeps valid for the call.
            let data = unsafe { &*(lparam.0 as *const COPYDATASTRUCT) };
            if data.dwData == COPY_LINK && !data.lpData.is_null() {
                // SAFETY: `cbData` bytes of UTF-16 at `lpData`, as
                // `forward` sends them.
                let units = unsafe {
                    std::slice::from_raw_parts(data.lpData as *const u16, data.cbData as usize / 2)
                };
                received(hwnd, String::from_utf16_lossy(units));
                return LRESULT(1);
            }
        }
        WM_NCDESTROY => {
            // SAFETY: removes the subclass `attach` installed.
            unsafe {
                let _ = RemoveWindowSubclass(hwnd, Some(link_proc), id);
            }
        }
        _ => {}
    }
    // SAFETY: default handling of the subclassed window.
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

/// A URL from a later launch: brings the window to the front and sends it.
fn received(window: HWND, url: String) {
    // SAFETY: plain calls on the app's window; the sender allowed this
    // process to take the foreground.
    unsafe {
        if IsIconic(window).as_bool() {
            let _ = ShowWindow(window, SW_RESTORE);
        }
        let _ = SetForegroundWindow(window);
    }
    let surface = SURFACE.with(|s| s.borrow().as_ref().and_then(Weak::upgrade));
    match surface {
        Some(surface) => send(&surface, url),
        None => log::warn!("links: a URL arrived without a window to take it"),
    }
}

/// Sends `url` to the window marked with `property`, waiting for it while
/// the running instance may still be opening it. `true` when it took it.
fn forward(property: &HSTRING, url: &str) -> bool {
    for step in 0..WAIT_STEPS {
        if let Some(window) = find(property) {
            let data: Vec<u16> = url.encode_utf16().collect();
            let copy = COPYDATASTRUCT {
                dwData: COPY_LINK,
                cbData: (data.len() * 2) as u32,
                lpData: data.as_ptr() as *mut _,
            };
            let mut result = 0usize;
            // SAFETY: plain calls; `copy` and `data` outlive the synchronous
            // send.
            unsafe {
                let mut pid = 0u32;
                GetWindowThreadProcessId(window, Some(&mut pid as *mut u32));
                let _ = AllowSetForegroundWindow(pid);
                let _ = SendMessageTimeoutW(
                    window,
                    WM_COPYDATA,
                    WPARAM(0),
                    LPARAM(&copy as *const COPYDATASTRUCT as isize),
                    SMTO_ABORTIFHUNG,
                    5000,
                    Some(&mut result as *mut usize),
                );
            }
            return result == 1;
        }
        if step + 1 < WAIT_STEPS {
            std::thread::sleep(std::time::Duration::from_millis(WAIT_STEP_MS));
        }
    }
    false
}

/// The top-level window with `property`, if any.
fn find(property: &HSTRING) -> Option<HWND> {
    struct Search<'a> {
        property: &'a HSTRING,
        found: Option<HWND>,
    }
    unsafe extern "system" fn each(window: HWND, lparam: LPARAM) -> BOOL {
        // SAFETY: `lparam` is the `Search` below, alive during the call.
        let search = unsafe { &mut *(lparam.0 as *mut Search<'_>) };
        // SAFETY: a plain read of a window's property.
        if !unsafe { GetPropW(window, search.property) }.is_invalid() {
            search.found = Some(window);
            return BOOL(0);
        }
        TRUE
    }
    let mut search = Search {
        property,
        found: None,
    };
    // SAFETY: `each` only uses `search`, which outlives the enumeration.
    let _ = unsafe { EnumWindows(Some(each), LPARAM(&mut search as *mut Search<'_> as isize)) };
    search.found
}

/// The window property naming the app `id`.
fn property(id: &str) -> HSTRING {
    HSTRING::from(format!("nsh.app.{}", sanitize(id)))
}

/// `id` with only characters safe in kernel object and property names.
fn sanitize(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Whether `arg` is a URL of one of `schemes` (compared ignoring case, as
/// schemes are).
fn matches(arg: &str, schemes: &[String]) -> bool {
    let Some((scheme, _)) = arg.split_once(':') else {
        return false;
    };
    let valid = scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    valid && schemes.iter().any(|s| s.eq_ignore_ascii_case(scheme))
}

/// Registers `scheme` for this executable under the current user, when its
/// command is not this executable's already.
fn register(scheme: &str, name: &str) -> Result<()> {
    let exe = std::env::current_exe().map_err(|_| windows::core::Error::from_thread())?;
    let key = format!("Software\\Classes\\{scheme}");
    let command_key = format!("{key}\\shell\\open\\command");
    let command = format!("\"{}\" \"%1\"", exe.display());
    if read_value(&command_key).as_deref() == Some(command.as_str()) {
        return Ok(());
    }
    set_value(&key, None, &format!("URL:{name}"))?;
    set_value(&key, Some("URL Protocol"), "")?;
    set_value(
        &format!("{key}\\DefaultIcon"),
        None,
        &format!("{},0", exe.display()),
    )?;
    set_value(&command_key, None, &command)
}

/// The default string value of `key` under `HKEY_CURRENT_USER`.
fn read_value(key: &str) -> Option<String> {
    let key = HSTRING::from(key);
    let mut size = 0u32;
    // SAFETY: asks for the size only.
    unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            &key,
            PCWSTR::null(),
            RRF_RT_REG_SZ,
            None,
            None,
            Some(&mut size),
        )
    }
    .ok()
    .ok()?;
    let mut data = vec![0u16; (size as usize).div_ceil(2)];
    // SAFETY: `data` holds `size` bytes.
    unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            &key,
            PCWSTR::null(),
            RRF_RT_REG_SZ,
            None,
            Some(data.as_mut_ptr().cast()),
            Some(&mut size),
        )
    }
    .ok()
    .ok()?;
    let len = data.iter().position(|&u| u == 0).unwrap_or(data.len());
    Some(String::from_utf16_lossy(&data[..len]))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_of_the_apps_schemes_match() {
        let schemes = ["myapp".to_owned()];
        assert!(matches("myapp://open?x=1", &schemes));
        assert!(matches("MyApp:item/2", &schemes));
        assert!(!matches("other://x", &schemes));
        assert!(!matches("-ToastActivated", &schemes));
        assert!(!matches("C:\\path", &schemes));
    }

    #[test]
    fn names_are_sanitized() {
        assert_eq!(sanitize("com.example.app"), "com.example.app");
        assert_eq!(sanitize("a\\b c"), "a_b_c");
    }
}
