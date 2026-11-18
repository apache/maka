//! Whether the user can see the app's window beyond its own show state,
//! which `lifecycle()` follows ([`crate::system`]): nothing of the app is
//! seen, and it is in the background, while
//!
//! - the session is locked (Win+L, the lock screen after sleep or a
//!   timeout): `WM_WTSSESSION_CHANGE`'s `WTS_SESSION_LOCK` /
//!   `WTS_SESSION_UNLOCK`;
//! - the session has no display: another user switched in, or a remote
//!   session was disconnected (`WTS_CONSOLE_DISCONNECT`,
//!   `WTS_REMOTE_DISCONNECT`, until the matching connect);
//! - the display is off (`GUID_CONSOLE_DISPLAY_STATE`'s power setting
//!   notification; dimmed still shows);
//! - the shell cloaks the window: on another virtual desktop (the shell
//!   cloaks the windows of the desktops not shown), read with `DWMWA_CLOAKED`
//!   whenever the state is worked out, and worked out again on
//!   `EVENT_OBJECT_CLOAKED` / `EVENT_OBJECT_UNCLOAKED` of a surface's root
//!   window (a WinEvent hook per thread, for this process's windows).
//!
//! All of it comes from the system's notifications, nothing is polled. The
//! session and the display are the same for every window: one [`Screen`]
//! per thread, which each surface's window keeps current (its own
//! registrations, [`watch`], removed when it is destroyed, [`unwatch`]),
//! read once from the session on the thread's first window; the display's
//! registration sends its current state at once. Every window gets its own
//! copy of a notification, and each recomputes its own surface on it.
//!
//! An embedded surface's window registers itself: the notifications are
//! sent to the window that asked, child windows too.

use std::cell::Cell;

use windows::{
    Win32::{
        Foundation::{HANDLE, HWND, LPARAM},
        Graphics::Dwm::{DWM_CLOAKED_SHELL, DWMWA_CLOAKED, DwmGetWindowAttribute},
        System::{
            Power::{
                HPOWERNOTIFY, POWERBROADCAST_SETTING, RegisterPowerSettingNotification,
                UnregisterPowerSettingNotification,
            },
            RemoteDesktop::{
                NOTIFY_FOR_THIS_SESSION, WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION,
                WTS_SESSIONSTATE_LOCK, WTSDisconnected, WTSFreeMemory, WTSINFOEXW,
                WTSQuerySessionInformationW, WTSRegisterSessionNotification, WTSSessionInfoEx,
                WTSUnRegisterSessionNotification,
            },
            SystemServices::GUID_CONSOLE_DISPLAY_STATE,
            Threading::GetCurrentProcessId,
        },
        UI::{
            Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent},
            WindowsAndMessaging::{
                CHILDID_SELF, DEVICE_NOTIFY_WINDOW_HANDLE, EVENT_OBJECT_CLOAKED,
                EVENT_OBJECT_UNCLOAKED, GA_ROOT, GetAncestor, OBJID_WINDOW, WINEVENT_OUTOFCONTEXT,
                WTS_CONSOLE_CONNECT, WTS_CONSOLE_DISCONNECT, WTS_REMOTE_CONNECT,
                WTS_REMOTE_DISCONNECT, WTS_SESSION_LOCK, WTS_SESSION_UNLOCK,
            },
        },
    },
    core::PWSTR,
};

use crate::surface::Surface;

/// `GUID_CONSOLE_DISPLAY_STATE`'s value for a display that is off (1 is
/// on, 2 dimmed).
const DISPLAY_OFF: u32 = 0;

/// What the session and the display let the user see.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Screen {
    /// The session is locked.
    locked: bool,
    /// The session has no display (switched away from, or a remote one
    /// disconnected).
    disconnected: bool,
    /// The display is off.
    display_off: bool,
}

impl Screen {
    /// The state after `WM_WTSSESSION_CHANGE`'s `event`; other events
    /// (logons, logoffs, remote control) change nothing.
    pub(crate) fn session_changed(self, event: u32) -> Self {
        match event {
            WTS_SESSION_LOCK => Self {
                locked: true,
                ..self
            },
            WTS_SESSION_UNLOCK => Self {
                locked: false,
                ..self
            },
            WTS_CONSOLE_DISCONNECT | WTS_REMOTE_DISCONNECT => Self {
                disconnected: true,
                ..self
            },
            WTS_CONSOLE_CONNECT | WTS_REMOTE_CONNECT => Self {
                disconnected: false,
                ..self
            },
            _ => self,
        }
    }

    /// The state after the display's power setting became `state`
    /// (`GUID_CONSOLE_DISPLAY_STATE`).
    pub(crate) fn display_changed(self, state: u32) -> Self {
        Self {
            display_off: state == DISPLAY_OFF,
            ..self
        }
    }

    /// Whether the user can see the screen.
    pub(crate) fn seen(self) -> bool {
        !(self.locked || self.disconnected || self.display_off)
    }
}

thread_local! {
    /// The screen as this thread's windows were told.
    static SCREEN: Cell<Screen> = const {
        Cell::new(Screen {
            locked: false,
            disconnected: false,
            display_off: false,
        })
    };
    /// Windows of this thread that [`watch`] the screen.
    static WATCHERS: Cell<usize> = const { Cell::new(0) };
    /// The thread's hook of cloaking events, while it has watchers.
    static CLOAK_HOOK: Cell<Option<HWINEVENTHOOK>> = const { Cell::new(None) };
}

/// Whether the user can see the screen, as this thread knows it.
pub(crate) fn screen_seen() -> bool {
    SCREEN.with(Cell::get).seen()
}

/// What a window registered for ([`watch`]), to remove ([`unwatch`]).
pub(crate) struct Watch {
    power: Option<HPOWERNOTIFY>,
    session: bool,
}

/// Registers surface window `hwnd` for the session's and the display's
/// notifications, and the thread for its windows' cloaking.
pub(crate) fn watch(hwnd: HWND) -> Watch {
    let first = WATCHERS.with(|w| {
        w.set(w.get() + 1);
        w.get() == 1
    });
    if first {
        SCREEN.with(|s| s.set(session_now()));
        // SAFETY: an out-of-context hook: `cloak_event` runs on this
        // thread while it pumps messages; removed with the last watcher.
        let hook = unsafe {
            SetWinEventHook(
                EVENT_OBJECT_CLOAKED,
                EVENT_OBJECT_UNCLOAKED,
                None,
                Some(cloak_event),
                GetCurrentProcessId(),
                0,
                WINEVENT_OUTOFCONTEXT,
            )
        };
        if !hook.is_invalid() {
            CLOAK_HOOK.with(|h| h.set(Some(hook)));
        }
    }
    // SAFETY: registrations of a live window, removed in `unwatch` before
    // it is destroyed.
    unsafe {
        Watch {
            session: WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION).is_ok(),
            power: RegisterPowerSettingNotification(
                HANDLE(hwnd.0),
                &GUID_CONSOLE_DISPLAY_STATE,
                DEVICE_NOTIFY_WINDOW_HANDLE,
            )
            .ok(),
        }
    }
}

/// Removes what [`watch`] registered for `hwnd` (on `WM_DESTROY`).
pub(crate) fn unwatch(hwnd: HWND, watch: Watch) {
    // SAFETY: removes this window's own registrations.
    unsafe {
        if watch.session {
            let _ = WTSUnRegisterSessionNotification(hwnd);
        }
        if let Some(power) = watch.power {
            let _ = UnregisterPowerSettingNotification(power);
        }
    }
    let last = WATCHERS.with(|w| {
        w.set(w.get().saturating_sub(1));
        w.get() == 0
    });
    if last && let Some(hook) = CLOAK_HOOK.with(Cell::take) {
        // SAFETY: the hook `watch` set on this thread.
        let _ = unsafe { UnhookWinEvent(hook) };
    }
}

/// The session's state now: locked, or without a display. Unknown counts
/// as seen.
fn session_now() -> Screen {
    let mut buffer = PWSTR::null();
    let mut bytes = 0u32;
    // SAFETY: the system allocates the buffer, freed below; it holds a
    // `WTSINFOEXW` when the call succeeds with at least its size.
    unsafe {
        if WTSQuerySessionInformationW(
            Some(WTS_CURRENT_SERVER_HANDLE),
            WTS_CURRENT_SESSION,
            WTSSessionInfoEx,
            &mut buffer,
            &mut bytes,
        )
        .is_err()
            || buffer.is_null()
        {
            return Screen::default();
        }
        let mut screen = Screen::default();
        if bytes as usize >= std::mem::size_of::<WTSINFOEXW>() {
            let info = &*(buffer.0 as *const WTSINFOEXW);
            if info.Level == 1 {
                let session = info.Data.WTSInfoExLevel1;
                screen.locked = session.SessionFlags == WTS_SESSIONSTATE_LOCK as i32;
                screen.disconnected = session.SessionState == WTSDisconnected;
            }
        }
        WTSFreeMemory(buffer.0 as *mut _);
        screen
    }
}

/// `WM_WTSSESSION_CHANGE` with `event` came to `surface`'s window.
pub(crate) fn session_changed(surface: &Surface, event: u32) {
    changed(surface, |s| s.session_changed(event));
}

/// `WM_POWERBROADCAST`'s `PBT_POWERSETTINGCHANGE` came to `surface`'s
/// window with `setting` (a `POWERBROADCAST_SETTING`).
pub(crate) fn power_setting_changed(surface: &Surface, setting: LPARAM) {
    if setting.0 == 0 {
        return;
    }
    // SAFETY: the message's setting, alive while it is handled; its value
    // is read only when it is as long as the display state's `u32`.
    let state = unsafe {
        let setting = &*(setting.0 as *const POWERBROADCAST_SETTING);
        if setting.PowerSetting != GUID_CONSOLE_DISPLAY_STATE
            || (setting.DataLength as usize) < std::mem::size_of::<u32>()
        {
            return;
        }
        std::ptr::read_unaligned(setting.Data.as_ptr() as *const u32)
    };
    changed(surface, |s| s.display_changed(state));
}

/// Applies `change` to the thread's screen, then `surface`'s state follows.
fn changed(surface: &Surface, change: impl FnOnce(Screen) -> Screen) {
    SCREEN.with(|screen| {
        follow(screen, change, || crate::system::lifecycle_changed(surface));
    });
}

/// Applies `change` to `screen`, then `recompute`s the surface whose window
/// the notification came to, whether or not the screen changed: each of
/// the thread's surface windows gets the notification, and only the first
/// finds the screen still to change, so a guard on the change would leave
/// the other surfaces in their old state (`set_environment` drops a value
/// that did not change).
fn follow(screen: &Cell<Screen>, change: impl FnOnce(Screen) -> Screen, recompute: impl FnOnce()) {
    screen.set(change(screen.get()));
    recompute();
}

/// Whether the shell cloaks top-level window `root`: on another virtual
/// desktop (`DWM_CLOAKED_SHELL`, with `DWM_CLOAKED_INHERITED` on a window
/// owned by a cloaked one). The app's own cloak (`DWM_CLOAKED_APP`, which
/// keeps a window out of composition until its first frame is drawn:
/// `app::show_main`) does not count.
pub(crate) fn cloaked(root: HWND) -> bool {
    let mut cloaked = 0u32;
    // SAFETY: a plain query on a window handle; the attribute is written
    // into a local of its size.
    let read = unsafe {
        DwmGetWindowAttribute(
            root,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut _,
            std::mem::size_of::<u32>() as u32,
        )
    };
    read.is_ok() && (cloaked & DWM_CLOAKED_SHELL) != 0
}

/// A window of this process was cloaked or uncloaked: the surfaces whose
/// root window it is work out their state again.
unsafe extern "system" fn cloak_event(
    _hook: HWINEVENTHOOK,
    _event: u32,
    hwnd: HWND,
    object: i32,
    child: i32,
    _thread: u32,
    _time: u32,
) {
    if hwnd.is_invalid() || object != OBJID_WINDOW.0 || child != CHILDID_SELF as i32 {
        return;
    }
    for surface in Surface::all() {
        let own = surface.hwnd();
        // SAFETY: a plain call on a window handle.
        if !own.is_invalid() && unsafe { GetAncestor(own, GA_ROOT) } == hwnd {
            crate::system::lifecycle_changed(&surface);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_locked_session_hides_the_screen_until_it_is_unlocked() {
        let screen = Screen::default();
        assert!(screen.seen());
        let locked = screen.session_changed(WTS_SESSION_LOCK);
        assert!(!locked.seen());
        assert!(locked.session_changed(WTS_SESSION_UNLOCK).seen());
    }

    #[test]
    fn a_session_without_a_display_hides_the_screen_until_it_connects() {
        for (gone, back) in [
            (WTS_CONSOLE_DISCONNECT, WTS_CONSOLE_CONNECT),
            (WTS_REMOTE_DISCONNECT, WTS_REMOTE_CONNECT),
        ] {
            let away = Screen::default().session_changed(gone);
            assert!(!away.seen());
            assert!(away.session_changed(back).seen());
        }
    }

    #[test]
    fn a_switched_away_session_stays_hidden_until_connected_and_unlocked() {
        // Switching users locks the session, then moves it off the console.
        let away = Screen::default()
            .session_changed(WTS_SESSION_LOCK)
            .session_changed(WTS_CONSOLE_DISCONNECT);
        let connected = away.session_changed(WTS_CONSOLE_CONNECT);
        assert!(!connected.seen(), "the lock screen shows first");
        assert!(connected.session_changed(WTS_SESSION_UNLOCK).seen());
    }

    #[test]
    fn other_session_events_change_nothing() {
        use windows::Win32::UI::WindowsAndMessaging::{WTS_SESSION_LOGOFF, WTS_SESSION_LOGON};
        let locked = Screen::default().session_changed(WTS_SESSION_LOCK);
        for event in [WTS_SESSION_LOGON, WTS_SESSION_LOGOFF, 0, 99] {
            assert_eq!(locked.session_changed(event), locked);
            assert_eq!(Screen::default().session_changed(event), Screen::default());
        }
    }

    #[test]
    fn every_surface_follows_a_change_another_window_already_applied() {
        // Two surfaces' windows on one thread each get the lock, then the
        // unlock; the second finds the screen already changed.
        let screen = Cell::new(Screen::default());
        let mut seen = [true, true];
        for (event, expected) in [(WTS_SESSION_LOCK, false), (WTS_SESSION_UNLOCK, true)] {
            for surface in &mut seen {
                follow(
                    &screen,
                    |s| s.session_changed(event),
                    || *surface = screen.get().seen(),
                );
            }
            assert_eq!(seen, [expected; 2]);
        }
    }

    #[test]
    fn a_display_turned_off_hides_the_screen_and_a_dimmed_one_does_not() {
        let off = Screen::default().display_changed(0);
        assert!(!off.seen());
        assert!(off.display_changed(1).seen());
        assert!(off.display_changed(2).seen(), "dimmed still shows");
        // The display and the session are apart: both must allow it.
        let locked_off = off.session_changed(WTS_SESSION_LOCK);
        assert!(!locked_off.display_changed(1).seen());
        assert!(!locked_off.session_changed(WTS_SESSION_UNLOCK).seen());
    }
}
