//! A standalone application whose tray outlives its window and engine.

use super::*;
use std::cell::Cell;
use windows::{
    Win32::{
        Foundation::{HINSTANCE, LPARAM, LRESULT, POINT, WPARAM},
        System::LibraryLoader::GetModuleHandleW,
        UI::{
            Shell::{
                NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NOTIFYICONDATAW,
                Shell_NotifyIconW,
            },
            WindowsAndMessaging::*,
        },
    },
    core::{PCWSTR, w},
};

/// Application-owned labels for a resident application's tray.
#[derive(Clone, Default)]
#[non_exhaustive]
pub struct TrayOptions {
    /// The notification area's accessible name and tooltip.
    pub title: String,
    /// The menu command that opens or focuses the window.
    pub open_label: String,
    /// The menu command that exits the application.
    pub quit_label: String,
}

/// Runs an application with a tray and a disposable window. Closing the window
/// drops its engine; Open calls `configuration` again. `on_closed` runs after
/// the engine is dropped. If no tray can be installed, closing exits normally.
/// [`super::quit_app`] exits even while no window is open.
pub fn run_resident_app(
    configuration: impl FnMut() -> EngineConfig + Send + 'static,
    options: AppOptions,
    tray: TrayOptions,
    on_active: impl Fn(bool) + Send + Sync + 'static,
    on_closed: impl Fn() + Send + 'static,
    should_close: impl Fn() -> bool + Send + Sync + 'static,
) -> std::process::ExitCode {
    struct Job {
        options: AppOptions,
        factory: Box<dyn FnMut() -> EngineConfig + Send>,
        tray: TrayOptions,
        active: Arc<dyn Fn(bool) + Send + Sync>,
        closed: Box<dyn Fn() + Send>,
        should_close: Arc<dyn Fn() -> bool + Send + Sync>,
    }
    // SAFETY: as in run_app, AppOptions' native-component Rc values move to
    // one UI thread while the caller waits; they are never accessed concurrently.
    unsafe impl Send for Job {}
    let job = Job {
        options,
        factory: Box::new(configuration),
        tray,
        active: Arc::new(on_active),
        closed: Box::new(on_closed),
        should_close: Arc::new(should_close),
    };
    let thread = std::thread::Builder::new()
        .name("nsh-ui".into())
        .stack_size(8 << 20)
        .spawn(move || {
            let job = job;
            // SAFETY: this is the application's UI thread, before creating windows.
            unsafe {
                let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
                let _ = OleInitialize(None);
            }
            crate::system::set_app_id(&job.options.app_id);
            let tray = match Tray::new(job.tray) {
                Ok(tray) => tray,
                Err(error) => {
                    log::error!("cannot create the tray owner: {error}");
                    // SAFETY: pairs OleInitialize before returning from this thread.
                    unsafe { windows::Win32::System::Ole::OleUninitialize() };
                    return std::process::ExitCode::FAILURE;
                }
            };
            STATE.with(|slot| {
                *slot.borrow_mut() = Some(State {
                    options: job.options,
                    factory: job.factory,
                    active: job.active,
                    closed: job.closed,
                    should_close: job.should_close,
                    tray,
                    view: None,
                    placement: None,
                    quitting: false,
                });
            });
            if let Err(error) = open() {
                log::error!("cannot open the application: {error}");
                quit();
            }
            let code = crate::window::run_loop();
            let state = STATE.with(|slot| slot.borrow_mut().take());
            if let Some(mut state) = state {
                if let Some(view) = state.view.take() {
                    view.stop();
                    // SAFETY: the window belongs to this thread; only destroy if live.
                    unsafe {
                        if IsWindow(Some(view.hwnd())).as_bool() {
                            let _ = DestroyWindow(view.hwnd());
                        }
                    }
                    drop(view);
                    (state.closed)();
                }
                RUNNING_VIEW.with(|view| *view.borrow_mut() = Weak::new());
                drop(state);
            }
            // SAFETY: all windows, engines and OLE users on this thread are gone.
            unsafe { windows::Win32::System::Ole::OleUninitialize() };
            if code == 0 {
                std::process::ExitCode::SUCCESS
            } else {
                std::process::ExitCode::FAILURE
            }
        });
    match thread.map(std::thread::JoinHandle::join) {
        Ok(Ok(code)) => code,
        _ => std::process::ExitCode::FAILURE,
    }
}

struct State {
    options: AppOptions,
    factory: Box<dyn FnMut() -> EngineConfig + Send>,
    active: Arc<dyn Fn(bool) + Send + Sync>,
    closed: Box<dyn Fn() + Send>,
    should_close: Arc<dyn Fn() -> bool + Send + Sync>,
    tray: Tray,
    view: Option<Rc<AppView>>,
    placement: Option<WINDOWPLACEMENT>,
    quitting: bool,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

pub(crate) fn running() -> bool {
    STATE.with(|slot| slot.borrow().is_some())
}

/// Called after the native close handler has stopped the window's engine.
/// Defers dropping the AppView until Win32 has left its destruction callbacks.
pub(crate) fn window_closed(hwnd: HWND) -> bool {
    let (owned, keep_alive) = STATE.with(|slot| {
        let state = slot.borrow();
        let Some(state) = state.as_ref() else {
            return (false, false);
        };
        (
            state.view.as_ref().is_some_and(|view| view.hwnd() == hwnd),
            state.tray.available.get() && !state.quitting,
        )
    });
    if owned {
        let address = hwnd.0 as usize;
        crate::window::invoke(move || {
            let removed = STATE.with(|slot| {
                let mut state = slot.borrow_mut();
                let state = state.as_mut()?;
                if state
                    .view
                    .as_ref()
                    .is_some_and(|view| view.hwnd().0 as usize == address)
                {
                    let view = state.view.take();
                    RUNNING_VIEW.with(|running| *running.borrow_mut() = Weak::new());
                    drop(view);
                    Some(())
                } else {
                    None
                }
            });
            if removed.is_some() {
                STATE.with(|slot| {
                    if let Some(state) = slot.borrow().as_ref() {
                        (state.closed)();
                    }
                });
            }
        });
    }
    keep_alive
}

pub(crate) fn should_close(hwnd: HWND) -> bool {
    let callback = STATE.with(|slot| {
        let state = slot.borrow();
        state
            .as_ref()
            .filter(|state| {
                !state.quitting
                    && state.tray.available.get()
                    && state.view.as_ref().is_some_and(|view| view.hwnd() == hwnd)
            })
            .map(|state| state.should_close.clone())
    });
    callback.is_none_or(|callback| callback())
}

pub(crate) fn save_placement(hwnd: HWND) {
    STATE.with(|slot| {
        let mut slot = slot.borrow_mut();
        if let Some(state) = slot.as_mut()
            && state.view.as_ref().is_some_and(|view| view.hwnd() == hwnd)
        {
            let mut placement = WINDOWPLACEMENT {
                length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
                ..Default::default()
            };
            // SAFETY: the close request still owns a live window.
            if unsafe { GetWindowPlacement(hwnd, &mut placement) }.is_ok() {
                state.placement = Some(placement);
            }
        }
    });
}

fn open() -> windows::core::Result<()> {
    STATE.with(|slot| {
        let mut slot = slot.borrow_mut();
        let Some(state) = slot.as_mut() else {
            return Ok(());
        };
        if state.quitting {
            return Ok(());
        }
        if let Some(view) = state.view.as_ref() {
            // SAFETY: use the existing live window, restoring a minimized one.
            unsafe {
                if IsWindow(Some(view.hwnd())).as_bool() {
                    let _ = ShowWindow(view.hwnd(), SW_RESTORE);
                    let _ = SetForegroundWindow(view.hwnd());
                    return Ok(());
                }
            }
        }
        // A preceding WM_DESTROY may have queued cleanup just before Open.
        if let Some(view) = state.view.take() {
            drop(view);
            (state.closed)();
        }
        let view = AppView::new(None, state.options.clone())?;
        let active = state.active.clone();
        *view.surface.on_activation.borrow_mut() = Some(Box::new(move |value| active(value)));
        RUNNING_VIEW.with(|running| *running.borrow_mut() = Rc::downgrade(&view));
        view.load_with_config((state.factory)());
        crate::system::environment_applied(view.surface());
        install_shortcuts(&view);
        if let Some(mut placement) = state.placement {
            placement.showCmd = SW_SHOWNORMAL.0 as u32;
            // SAFETY: restore the previous normal bounds on the new native window.
            unsafe {
                let _ = SetWindowPlacement(view.hwnd(), &placement);
            }
        }
        view.show();
        // SAFETY: a tray action is a user request to bring this window forward.
        unsafe {
            let _ = SetForegroundWindow(view.hwnd());
        }
        state.view = Some(view);
        Ok(())
    })
}

pub(crate) fn quit() {
    STATE.with(|slot| {
        if let Some(state) = slot.borrow_mut().as_mut() {
            state.quitting = true;
        }
    });
    // SAFETY: this runs on the UI thread. The runner owns window teardown after
    // the loop; the caller then performs its bounded application-client detach.
    unsafe { PostQuitMessage(0) };
}

const TRAY_MESSAGE: u32 = WM_APP + 110;
const OPEN_COMMAND: usize = 1;
const QUIT_COMMAND: usize = 2;
const CLASS: PCWSTR = w!("NshResidentTray");

struct Tray {
    hwnd: HWND,
    icon: NOTIFYICONDATAW,
    menu: HMENU,
    taskbar_created: u32,
    available: Cell<bool>,
}

impl Tray {
    fn new(options: TrayOptions) -> windows::core::Result<Self> {
        // SAFETY: this thread owns the class, native window, menu and icon.
        unsafe {
            let instance = HINSTANCE(GetModuleHandleW(None)?.0);
            let class = WNDCLASSW {
                lpfnWndProc: Some(tray_proc),
                hInstance: instance,
                lpszClassName: CLASS,
                ..Default::default()
            };
            RegisterClassW(&class);
            // A hidden top-level window, not HWND_MESSAGE: Explorer broadcasts
            // TaskbarCreated only to top-level windows after a shell restart.
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                CLASS,
                w!(""),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                None,
                None,
                Some(instance),
                None,
            )?;
            let menu = match CreatePopupMenu() {
                Ok(menu) => menu,
                Err(error) => {
                    let _ = DestroyWindow(hwnd);
                    return Err(error);
                }
            };
            let result = (|| {
                let open: Vec<u16> = options.open_label.encode_utf16().chain(Some(0)).collect();
                let quit: Vec<u16> = options.quit_label.encode_utf16().chain(Some(0)).collect();
                AppendMenuW(menu, MF_STRING, OPEN_COMMAND, PCWSTR(open.as_ptr()))?;
                AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null())?;
                AppendMenuW(menu, MF_STRING, QUIT_COMMAND, PCWSTR(quit.as_ptr()))?;
                Ok::<_, windows::core::Error>(())
            })();
            if let Err(error) = result {
                let _ = DestroyMenu(menu);
                let _ = DestroyWindow(hwnd);
                return Err(error);
            }
            let mut icon = NOTIFYICONDATAW {
                cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
                hWnd: hwnd,
                uID: 1,
                uFlags: NIF_ICON | NIF_MESSAGE | NIF_TIP,
                uCallbackMessage: TRAY_MESSAGE,
                hIcon: LoadIconW(Some(instance), PCWSTR(1 as _))
                    .or_else(|_| LoadIconW(None, IDI_APPLICATION))?,
                ..Default::default()
            };
            // Leave space for NUL and do not truncate inside a UTF-16 surrogate pair.
            let mut title: Vec<u16> = options
                .title
                .encode_utf16()
                .take(icon.szTip.len() - 1)
                .collect();
            if title
                .last()
                .is_some_and(|unit| (0xD800..=0xDBFF).contains(unit))
            {
                title.pop();
            }
            icon.szTip[..title.len()].copy_from_slice(&title);
            let available = Shell_NotifyIconW(NIM_ADD, &icon).as_bool();
            if !available {
                log::error!("cannot register the tray icon; closing the window will exit");
            }
            Ok(Self {
                hwnd,
                icon,
                menu,
                available: Cell::new(available),
                taskbar_created: RegisterWindowMessageW(w!("TaskbarCreated")),
            })
        }
    }
}

impl Drop for Tray {
    fn drop(&mut self) {
        // SAFETY: these resources belong to this UI thread; the loaded icon is shared.
        unsafe {
            let _ = Shell_NotifyIconW(NIM_DELETE, &self.icon);
            let _ = DestroyMenu(self.menu);
            let _ = DestroyWindow(self.hwnd);
        }
    }
}

unsafe extern "system" fn tray_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_COMMAND {
        match wparam.0 & 0xffff {
            OPEN_COMMAND => {
                if let Err(error) = open() {
                    log::error!("cannot reopen the window: {error}");
                }
            }
            QUIT_COMMAND => quit(),
            _ => {}
        }
        return LRESULT(0);
    }
    if message == TRAY_MESSAGE {
        match lparam.0 as u32 {
            WM_LBUTTONUP | WM_LBUTTONDBLCLK => {
                if let Err(error) = open() {
                    log::error!("cannot reopen the window: {error}");
                }
            }
            WM_RBUTTONUP | WM_CONTEXTMENU => {
                let menu = STATE.with(|slot| slot.borrow().as_ref().map(|state| state.tray.menu));
                if let Some(menu) = menu {
                    let mut point = POINT::default();
                    // SAFETY: native context menu at the pointer, owned by this window.
                    let command = unsafe {
                        let _ = GetCursorPos(&mut point);
                        let _ = SetForegroundWindow(hwnd);
                        TrackPopupMenu(
                            menu,
                            TPM_RETURNCMD | TPM_RIGHTBUTTON,
                            point.x,
                            point.y,
                            None,
                            hwnd,
                            None,
                        )
                        .0 as usize
                    };
                    match command {
                        OPEN_COMMAND => {
                            if let Err(error) = open() {
                                log::error!("cannot reopen the window: {error}");
                            }
                        }
                        QUIT_COMMAND => quit(),
                        _ => {}
                    }
                    // SAFETY: let Win32 dismiss the menu when the user clicks elsewhere.
                    unsafe {
                        let _ = PostMessageW(Some(hwnd), WM_NULL, WPARAM(0), LPARAM(0));
                    }
                }
            }
            _ => {}
        }
        return LRESULT(0);
    }
    let restore = STATE.with(|slot| {
        let state = slot.borrow();
        let Some(state) = state.as_ref() else {
            return false;
        };
        if message != 0 && message == state.tray.taskbar_created {
            // SAFETY: Explorer restarted; re-register the same live tray owner.
            let available = unsafe { Shell_NotifyIconW(NIM_ADD, &state.tray.icon) }.as_bool();
            state.tray.available.set(available);
            if !available {
                log::error!("cannot restore the tray icon after Explorer restarted");
            }
            !available
        } else {
            false
        }
    });
    if restore && let Err(error) = open() {
        log::error!("cannot restore a visible window: {error}");
    }
    if message == WM_QUERYENDSESSION {
        return LRESULT(1);
    }
    if message == WM_ENDSESSION && wparam.0 != 0 {
        quit();
        return LRESULT(0);
    }
    // SAFETY: all unhandled messages retain ordinary Win32 behavior.
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

#[cfg(all(test, feature = "js"))]
mod tests;
