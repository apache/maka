//! URL schemes on Windows (`EventKind::UrlScheme`, nsh.json `schemes`): the system
//! opens `<scheme>:...` URLs with the app, and the app hears them.
//!
//! - Registration: `HKCU\Software\Classes\<scheme>` marks the scheme a URL
//!   protocol whose `shell\open\command` runs the executable with the URL as
//!   its argument. Written at startup by the release runner ([`start`]) when
//!   the command differs from what is there: the app may have moved. The
//!   development host registers nothing.
//! - Launch: an argument that is a URL of one of the app's schemes goes to
//!   the root surface before its app loads ([`launch`]), whose engine applies
//!   it before the app's code first runs; the core keeps it until JS listens.
//! - One instance: the first instance of an app with schemes owns a named
//!   mutex keyed by the app id and marks its top-level window with a property
//!   ([`attach`]). A later launch with a URL finds that window, lets it take
//!   the foreground, hands it the URL in a `WM_COPYDATA` and exits; the
//!   running instance shows its window (restored, or shown when hidden),
//!   brings it to the front and sends the URL. A launch without a URL opens
//!   another window, as before.
//! - Files (nsh.json `fileTypes`): `HKCU\Software\Classes\<app id>.<n>` is a
//!   ProgID per file type whose `shell\open\command` runs the executable with
//!   the file, listed under each extension's `OpenWithProgids`, so the app
//!   shows in Open With; written at startup as the schemes are. An argument
//!   that is an existing file of those types goes to the app as a `file://`
//!   URL, as a link does, and a later launch forwards it the same way.
//! - Single instance (nsh.json `singleInstance`): the same mutex, made with
//!   or without schemes. A later launch, with a URL or not, hands the
//!   running instance its arguments and working directory
//!   ([`nsh_core::single_instance::SecondInstance`], JSON in a
//!   `WM_COPYDATA`) and exits before it opens a window; the running instance
//!   shows its window as for a URL, reports the launch
//!   (`EventKind::SecondInstance`) and sends the URLs among the arguments.

use std::{
    cell::RefCell,
    rc::{Rc, Weak},
};

use nsh_core::{EventKind, EventPayload, PayloadValue, ROOT_ID, file_type::FileType};
use nsh_engine::EngineControl;
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
                GetWindowThreadProcessId, IsIconic, IsWindowVisible, SMTO_ABORTIFHUNG, SW_RESTORE,
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
/// `COPYDATASTRUCT::dwData` of a forwarded launch ("NSHI"): UTF-8 JSON.
const COPY_INSTANCE: usize = 0x4E53_4849;
/// The subclass id of the window that hears forwarded URLs.
const SUBCLASS: usize = 0x4E53_484C;
/// How long a second launch looks for the first one's window, which may still
/// be opening, in steps of [`WAIT_STEP_MS`].
const WAIT_STEPS: u32 = 50;
const WAIT_STEP_MS: u64 = 100;

thread_local! {
    /// The URLs the process was started with, until the root surface exists.
    static LAUNCH: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    /// The property that marks this app's window ([`property`]).
    static PROPERTY: RefCell<Option<HSTRING>> = const { RefCell::new(None) };
    /// The surface forwarded URLs go to.
    static SURFACE: RefCell<Option<Weak<Surface>>> = const { RefCell::new(None) };
    /// The app's schemes, which a forwarded launch's URLs are of.
    static SCHEMES: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    /// The file types the app opens, which a forwarded launch's files are of.
    static FILE_TYPES: RefCell<Vec<FileType>> = const { RefCell::new(Vec::new()) };
}

/// What [`start`] decided.
pub(crate) enum Start {
    /// This process runs the app.
    Run,
    /// The URL went to the running instance: this process exits.
    Forwarded,
}

/// Registers `schemes` and `file_types` for the app `id` named `name`,
/// reads the launch's URLs and files and, when an instance of the app
/// already runs, forwards them to it, or with `single_instance` the whole
/// launch. On the UI thread, before the window opens. Does nothing without
/// schemes, file types or `single_instance`.
pub(crate) fn start(
    id: &str,
    name: &str,
    schemes: &[String],
    file_types: &[FileType],
    single_instance: bool,
) -> Start {
    if schemes.is_empty() && file_types.is_empty() && !single_instance {
        return Start::Run;
    }
    SCHEMES.with(|s| *s.borrow_mut() = schemes.to_vec());
    FILE_TYPES.with(|t| *t.borrow_mut() = file_types.to_vec());
    if !cfg!(feature = "dev") {
        for scheme in schemes {
            if let Err(err) = register(scheme, name) {
                log::warn!("links: cannot register the scheme {scheme}: {err}");
            }
        }
        if let Err(err) = register_file_types(id, file_types) {
            log::warn!("links: cannot register the app's file types: {err}");
        }
    }
    let cwd = std::env::current_dir().ok();
    let urls: Vec<String> = std::env::args()
        .skip(1)
        .filter_map(|arg| launch_url(&arg, cwd.as_deref(), schemes, file_types))
        .collect();
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
    if !first && single_instance {
        let launch = nsh_core::single_instance::SecondInstance::current();
        let data = launch.to_json().to_string().into_bytes();
        if forward(&property, COPY_INSTANCE, &data) {
            return Start::Forwarded;
        }
        log::warn!("single instance: the running instance did not answer; opening another");
    } else if !first && !urls.is_empty() {
        let all = urls.iter().all(|url| {
            let data: Vec<u8> = url.encode_utf16().flat_map(u16::to_le_bytes).collect();
            forward(&property, COPY_LINK, &data)
        });
        if all {
            return Start::Forwarded;
        }
        log::warn!("links: the running instance did not answer; opening another");
    }
    LAUNCH.with(|l| *l.borrow_mut() = urls);
    Start::Run
}

/// The URL `arg` hands the app: a URL of one of `schemes`, or the
/// `file://` URL of an existing file of one of `file_types` (relative to
/// `cwd`).
fn launch_url(
    arg: &str,
    cwd: Option<&std::path::Path>,
    schemes: &[String],
    file_types: &[FileType],
) -> Option<String> {
    if matches(arg, schemes) {
        return Some(arg.to_owned());
    }
    if file_types.is_empty() || arg.starts_with('-') {
        return None;
    }
    let path = std::path::Path::new(arg);
    let path = match cwd {
        Some(cwd) if path.is_relative() => cwd.join(path),
        _ => path.to_path_buf(),
    };
    if !path.is_file() || !file_types.iter().any(|t| t.matches(&path)) {
        return None;
    }
    url::Url::from_file_path(&path).ok().map(String::from)
}

/// Hands the URL the process was started with to `surface`, whose engine
/// applies it as it starts. Before the app is loaded.
pub(crate) fn launch(surface: &Surface) {
    let urls = LAUNCH.with(|l| std::mem::take(&mut *l.borrow_mut()));
    if !urls.is_empty() {
        surface.set_launch_links(urls);
    }
}

/// Marks `surface`'s top-level window as the app's and hears URLs forwarded
/// to it. After the app is loaded.
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
}

fn send(surface: &Surface, url: String) {
    surface.control(|control| dispatch(control, url));
}

/// Reports `url` as a link the system opened the app with.
pub(crate) fn dispatch(control: &EngineControl, url: String) {
    control.dispatch_event(
        ROOT_ID,
        EventKind::UrlScheme,
        EventPayload::Map(vec![(nsh_core::url_scheme::URL, PayloadValue::Str(url))]),
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
                let url = String::from_utf16_lossy(units);
                received(hwnd, |surface| send(surface, url));
                return LRESULT(1);
            }
            if data.dwData == COPY_INSTANCE && !data.lpData.is_null() {
                // SAFETY: `cbData` bytes at `lpData`, as `forward` sends them.
                let bytes = unsafe {
                    std::slice::from_raw_parts(data.lpData as *const u8, data.cbData as usize)
                };
                let launch = serde_json::from_slice(bytes)
                    .ok()
                    .and_then(|json| nsh_core::single_instance::SecondInstance::from_json(&json));
                if let Some(launch) = launch {
                    received(hwnd, |surface| relaunched(surface, launch));
                    return LRESULT(1);
                }
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

/// A later launch of a single-instance app: reports it, then sends the URLs
/// of the app's schemes and the files of its types among its arguments.
fn relaunched(surface: &Surface, launch: nsh_core::single_instance::SecondInstance) {
    let cwd = (!launch.cwd.is_empty()).then(|| std::path::PathBuf::from(&launch.cwd));
    let urls: Vec<String> = SCHEMES.with(|schemes| {
        FILE_TYPES.with(|types| {
            let (schemes, types) = (schemes.borrow(), types.borrow());
            launch
                .args
                .iter()
                .filter_map(|arg| launch_url(arg, cwd.as_deref(), &schemes, &types))
                .collect()
        })
    });
    let payload = launch.to_payload();
    surface.control(|control| {
        control.dispatch_event(ROOT_ID, EventKind::SecondInstance, payload);
    });
    for url in urls {
        send(surface, url);
    }
}

/// A URL or a launch from a later launch: shows the window, brings it to the
/// front and hands `deliver` the surface. A hidden window shows as the app's
/// `focus()` shows it (one hidden since launch, nsh.json
/// `window.defaultVisible: false`, drawn before DWM composites it), as a
/// link shows it on macOS and Linux.
fn received(window: HWND, deliver: impl FnOnce(&Surface)) {
    let surface = SURFACE.with(|s| s.borrow().as_ref().and_then(Weak::upgrade));
    // SAFETY: plain queries on the app's window.
    let (iconic, visible) = unsafe {
        (
            IsIconic(window).as_bool(),
            IsWindowVisible(window).as_bool(),
        )
    };
    if iconic {
        // SAFETY: a plain call on the app's window.
        let _ = unsafe { ShowWindow(window, SW_RESTORE) };
    } else if !visible {
        match &surface {
            Some(surface) if surface.main_unshown.get() => {
                crate::app::show_main(surface, window);
            }
            _ => crate::window::show(window),
        }
    }
    // SAFETY: a plain call on the app's window; the sender allowed this
    // process to take the foreground.
    let _ = unsafe { SetForegroundWindow(window) };
    match surface {
        Some(surface) => deliver(&surface),
        None => log::warn!("links: a launch arrived without a window to take it"),
    }
}

/// Sends `data` of the `kind` to the window marked with `property`, waiting
/// for it while the running instance may still be opening it. `true` when
/// it took it.
fn forward(property: &HSTRING, kind: usize, data: &[u8]) -> bool {
    for step in 0..WAIT_STEPS {
        if let Some(window) = find(property) {
            let copy = COPYDATASTRUCT {
                dwData: kind,
                cbData: data.len() as u32,
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

/// Registers each of `file_types` as a ProgID of the app `id`
/// (`<id>.<n>`), opened by this executable, and lists it under its
/// extensions' `OpenWithProgids`; the ProgID is written again when its
/// command is not this executable's.
fn register_file_types(id: &str, file_types: &[FileType]) -> Result<()> {
    if file_types.is_empty() {
        return Ok(());
    }
    let exe = std::env::current_exe().map_err(|_| windows::core::Error::from_thread())?;
    let command = format!("\"{}\" \"%1\"", exe.display());
    for (n, file_type) in file_types.iter().enumerate() {
        let prog_id = format!("{}.{}", sanitize(id), n + 1);
        let key = format!("Software\\Classes\\{prog_id}");
        let command_key = format!("{key}\\shell\\open\\command");
        // Cheap and idempotent: an extension added since is listed too.
        for extension in &file_type.extensions {
            set_value(
                &format!("Software\\Classes\\.{extension}\\OpenWithProgids"),
                Some(&prog_id),
                "",
            )?;
        }
        if read_value(&command_key).as_deref() == Some(command.as_str()) {
            continue;
        }
        set_value(&key, None, &file_type.name)?;
        set_value(
            &format!("{key}\\DefaultIcon"),
            None,
            &format!("{},0", exe.display()),
        )?;
        set_value(&command_key, None, &command)?;
    }
    Ok(())
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
    fn files_of_the_apps_types_are_file_urls() {
        let dir = std::env::temp_dir().join(format!("nsh-links-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("clip.mp4"), b"").unwrap();
        std::fs::write(dir.join("notes.txt"), b"").unwrap();
        let types = nsh_core::file_type::file_types_from_json(
            &serde_json::json!([{ "name": "Video", "extensions": ["mp4"] }]),
        );
        let url = launch_url("clip.mp4", Some(&dir), &[], &types).unwrap();
        assert!(
            url.starts_with("file:///") && url.ends_with("/clip.mp4"),
            "{url}"
        );
        assert_eq!(launch_url("notes.txt", Some(&dir), &[], &types), None);
        assert_eq!(launch_url("missing.mp4", Some(&dir), &[], &types), None);
        assert_eq!(launch_url("clip.mp4", Some(&dir), &[], &[]), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn names_are_sanitized() {
        assert_eq!(sanitize("com.example.app"), "com.example.app");
        assert_eq!(sanitize("a\\b c"), "a_b_c");
    }
}
