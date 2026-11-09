//! What components read from the environment: the surface, system UI, the
//! user's settings ([`super::window`] and the like).

use crate::{
    EdgeInsets, Points, Size,
    platform::{Idiom, Lifecycle, Locale, LocaleSettings, Os},
};

/// The environment of a surface, as the platform reports it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Environment {
    /// The surface's size in points.
    pub window: Size<Points>,
    /// The edges system UI covers.
    pub safe_area: EdgeInsets,
    /// Space reserved for system controls in a custom desktop title bar.
    pub title_bar: crate::geometry::Edges<crate::geometry::Points>,
    /// The app's window: its bounds, mode and display (desktops).
    pub window_state: Option<crate::desktop::WindowState>,
    /// The software keyboard's height, 0 when hidden.
    pub keyboard_height: Points,
    /// How long the keyboard's show / hide animation takes, in milliseconds.
    pub keyboard_duration: f32,
    /// Dark appearance.
    pub dark: bool,
    /// The user's text size relative to the default.
    pub font_scale: f32,
    /// Less motion asked for.
    pub reduce_motion: bool,
    /// A screen reader runs.
    pub screen_reader: bool,
    /// Right-to-left layout.
    pub rtl: bool,
    /// Device pixels per point.
    pub pixel_ratio: f32,
    /// The operating system.
    pub os: Os,
    /// The OS version: major and minor (iOS), Android's API level and 0.
    pub os_version: (u16, u16),
    /// The kind of device.
    pub idiom: Idiom,
    /// The user's locale, for formatting numbers and dates.
    pub locale: Locale,
    /// The user's locale settings: the preferred languages, the time zone
    /// and the regional preferences.
    pub locale_settings: LocaleSettings,
    /// In a browser, it runs on an Apple platform: shortcuts follow Apple's
    /// conventions ([`crate::keymap::apple_keys`]); the other OSes imply
    /// theirs.
    pub apple_keyboard: bool,
    /// Ctrl stands in for Command: labels show Command as Ctrl
    /// ([`crate::platform::Environment::ctrl_for_command`]).
    pub ctrl_for_command: bool,
    /// The embedding app answers `nsh/host`'s calls
    /// ([`crate::platform::Environment::host`]).
    pub host: bool,
    /// Whether the app is in use: in the foreground, visible without the
    /// focus, or in the background.
    pub lifecycle: Lifecycle,
    /// The platform picks colors from the screen
    /// ([`crate::platform::Environment::screen_color`]).
    pub screen_color: bool,
    /// The platform shows file dialogs and opens, reveals and trashes local
    /// paths ([`crate::platform::Environment::file_requests`]).
    pub file_requests: bool,
    /// The platform recognizes speech
    /// ([`crate::platform::Environment::speech`]).
    pub speech: bool,
    /// The platform shows notifications
    /// ([`crate::platform::Environment::notifications`]).
    pub notifications: bool,
    /// The platform plays sound
    /// ([`crate::platform::Environment::audio`]).
    pub audio: bool,
    /// The Cell size of a grid surface (a terminal): the core lays out in
    /// its Cells ([`crate::platform::Environment::cell`]); `None` elsewhere.
    pub cell: Option<Size<Points>>,
    /// The platform gives web views trusted input
    /// ([`crate::platform::Environment::web_input`]).
    pub web_input: bool,
}

impl Default for Environment {
    fn default() -> Self {
        Self {
            window: crate::geometry::size_pt(0.0, 0.0),
            safe_area: EdgeInsets::default(),
            title_bar: crate::geometry::Edges::default(),
            window_state: None,
            keyboard_height: Points(0.0),
            keyboard_duration: 0.0,
            dark: false,
            font_scale: 1.0,
            reduce_motion: false,
            screen_reader: false,
            rtl: false,
            pixel_ratio: 1.0,
            os: Os::default(),
            os_version: (0, 0),
            idiom: Idiom::Phone,
            locale: Locale::EN_US,
            locale_settings: LocaleSettings::default(),
            apple_keyboard: false,
            ctrl_for_command: false,
            host: false,
            lifecycle: Lifecycle::Active,
            screen_color: false,
            file_requests: false,
            speech: false,
            notifications: false,
            audio: false,
            cell: None,
            web_input: false,
        }
    }
}
