//! Desktop windows for Rust components, using the platform's native chrome.
//!
//! A custom title bar calls [`set_title_bar`] once (or in an effect if its
//! height changes), marks its background with [`Interactive::window_drag`],
//! and reserves the left and right edges reported by [`title_bar`]. Native
//! window controls and title-bar double-click behavior remain the platform's.
//!
//! [`Interactive::window_drag`]: super::Interactive::window_drag

use crate::{
    desktop::{DesktopCommand, TitleBarStyle},
    geometry::{Edges, Points},
};

/// Hides the system title text so the app can draw its own title bar, or
/// restores the system bar. `height` is the custom bar's height in points:
/// native window controls are centered in it. Positive finite heights are
/// capped at 200 points; other values use the platform's default height.
/// On macOS it selects compact chrome up to 44 points and regular chrome
/// above; [`title_bar`] reports the actual native height for layout. An
/// embedding host's existing toolbar keeps its own style and height.
/// On platforms without desktop windows this has no effect.
pub fn set_title_bar(style: TitleBarStyle, height: Option<Points>) {
    super::ambient::desktop_command(DesktopCommand::SetTitleBar {
        style,
        height: crate::desktop::title_bar_height(height),
    });
}

/// The custom title bar's height (`top`) and the widths its native window
/// controls occupy (`left` and `right`), in points. Reading subscribes to
/// changes, including entering and leaving full screen. These are zero
/// with a system title bar and on platforms without desktop windows.
pub fn title_bar() -> Edges<Points> {
    super::ambient::title_bar()
}

/// Closes the app's window using the platform's normal close behavior.
/// The embedding host decides whether closing the last window exits.
/// On platforms without desktop windows this has no effect.
pub fn close_window() {
    super::ambient::desktop_command(DesktopCommand::Close);
}
