//! `nsh/desktop`'s window functions (macOS, Windows, Linux; nothing
//! happens elsewhere). Menus, which call the app's functions, are
//! `nsh-js`'s.

use crate::{
    Command, ROOT_ID,
    desktop::{DesktopCommand, MenuBarMode, TitleBarStyle, WindowFrame, WindowLevel},
    element::{ModuleCx, module, task::Action},
    geometry::Points,
};

fn desktop(cx: &mut ModuleCx, command: DesktopCommand) {
    cx.act(Action::Command(
        ROOT_ID,
        Command::Desktop(Box::new(command)),
    ));
}

/// The app's window (desktops; its functions do nothing elsewhere).
#[module]
pub(crate) struct Window;

#[module]
impl Window {
    /// Sets the window's title (the title bar, the taskbar / Dock, the
    /// window switcher).
    pub(crate) fn set_title(title: String, cx: &mut ModuleCx) {
        desktop(cx, DesktopCommand::SetTitle(title));
    }

    /// Shows the system's title bar (`"default"`) or hides it
    /// (`"hidden"`): the app then fills the window up to its top edge and
    /// draws a title bar of its own, made draggable with
    /// `desktop={{ windowDrag: true }}`; the system's window controls stay,
    /// in the area `titleBar()` reports. `height` is the app's bar's height
    /// in points: the controls are centered in it (Windows' caption buttons
    /// fill it); the platform's own without it. On macOS, it selects compact
    /// chrome up to 44 points and regular chrome above; use `titleBar().height`
    /// to lay out the bar at AppKit's actual height. An embedding host's
    /// existing toolbar keeps its own style and height.
    pub(crate) fn set_title_bar(style: TitleBarStyle, height: Option<f32>, cx: &mut ModuleCx) {
        let height = crate::desktop::title_bar_height(height.map(Points));
        desktop(cx, DesktopCommand::SetTitleBar { style, height });
    }

    /// When the menu bar shows on Windows and Linux, where the window draws
    /// the application menu as a bar above the app: `"shown"` (the
    /// default) always; `"autoHide"` only after Alt is pressed and released
    /// alone, until Alt alone hides it again, as in Windows and GNOME apps.
    /// F10 and Alt with a menu's initial still open a menu, and the bar
    /// shows while it is open. macOS's menu bar is the system's and always
    /// shows.
    pub(crate) fn set_menu_bar(mode: MenuBarMode, cx: &mut ModuleCx) {
        desktop(cx, DesktopCommand::SetMenuBar(mode));
    }

    /// Minimizes the window.
    pub(crate) fn minimize(cx: &mut ModuleCx) {
        desktop(cx, DesktopCommand::Minimize);
    }

    /// Maximizes the window, or restores it when it is maximized.
    pub(crate) fn toggle_maximize(cx: &mut ModuleCx) {
        desktop(cx, DesktopCommand::ToggleMaximize);
    }

    /// Enters or leaves full screen.
    pub(crate) fn toggle_full_screen(cx: &mut ModuleCx) {
        desktop(cx, DesktopCommand::ToggleFullScreen);
    }

    /// Moves and sizes the window in points; omitted fields keep their values.
    /// macOS and Windows use the outer frame, including window decorations;
    /// Linux uses GTK's default window size. `x` and `y` are the bottom left
    /// corner in macOS screen coordinates and the top left on Windows.
    /// `animated` enables macOS's resize animation (false by default).
    /// Sizing is supported on macOS, Windows and Linux; positioning and levels
    /// on macOS and Windows. A view embedded in another app's window leaves
    /// its bounds and level to that app.
    pub(crate) fn set_frame(frame: WindowFrame, cx: &mut ModuleCx) {
        let frame = WindowFrame {
            x: frame.x.filter(|v| v.is_finite()),
            y: frame.y.filter(|v| v.is_finite()),
            width: frame.width.filter(|v| v.is_finite() && v.0 > 0.0),
            height: frame.height.filter(|v| v.is_finite() && v.0 > 0.0),
            animated: frame.animated,
            anchor_top: frame.anchor_top,
        };
        desktop(cx, DesktopCommand::SetFrame(frame));
    }

    /// Sets the window's level on macOS and Windows: `"normal"` restores the
    /// normal level; `"floating"` stays above normal windows. `"desktopIcon"`
    /// selects macOS's desktop icon level or moves a Windows window to the
    /// bottom of the current z-order, where later activation can raise it.
    /// Elsewhere the level is left to the host and the window manager.
    pub(crate) fn set_level(level: WindowLevel, cx: &mut ModuleCx) {
        desktop(cx, DesktopCommand::SetLevel(level));
    }

    /// Brings the window to the front of its level and focuses it (the app
    /// activates). The window keeps its level. On macOS, desktop-level
    /// surfaces stay behind other windows.
    pub(crate) fn order_front(cx: &mut ModuleCx) {
        desktop(cx, DesktopCommand::OrderFront);
    }

    /// Closes the window; the app ends with it.
    pub(crate) fn close(cx: &mut ModuleCx) {
        desktop(cx, DesktopCommand::Close);
    }
}
