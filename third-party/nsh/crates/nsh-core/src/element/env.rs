//! What components read from the environment: the surface, system UI, the
//! user's settings ([`super::window`] and the like).

use crate::{
    EdgeInsets, Points, Size,
    platform::{Idiom, Locale, Os, Renderer},
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
    /// How the surface presents its UI (native views, HTML or terminal cells).
    pub renderer: Renderer,
    /// The OS version: major and minor (iOS), Android's API level and 0.
    pub os_version: (u16, u16),
    /// The kind of device.
    pub idiom: Idiom,
    /// The user's locale, for formatting numbers and dates.
    pub locale: Locale,
    /// In a browser, it runs on an Apple platform: shortcuts follow Apple's
    /// conventions ([`crate::keymap::apple_keys`]); graphical native
    /// backends infer theirs from the OS. Terminals use Control.
    pub apple_keyboard: bool,
    /// The host receives terminal key sequences, even with graphical rendering.
    pub terminal_keyboard: bool,
    /// The embedding app answers `nsh/host`'s calls
    /// ([`crate::platform::Environment::host`]).
    pub host: bool,
}

impl Default for Environment {
    fn default() -> Self {
        Self {
            window: crate::geometry::size_pt(0.0, 0.0),
            safe_area: EdgeInsets::default(),
            title_bar: crate::geometry::Edges::default(),
            keyboard_height: Points(0.0),
            keyboard_duration: 0.0,
            dark: false,
            font_scale: 1.0,
            reduce_motion: false,
            screen_reader: false,
            rtl: false,
            pixel_ratio: 1.0,
            os: Os::default(),
            renderer: Renderer::Native,
            os_version: (0, 0),
            idiom: Idiom::Phone,
            locale: Locale::EN_US,
            apple_keyboard: false,
            terminal_keyboard: false,
            host: false,
        }
    }
}

impl Environment {
    /// Whether command shortcuts use terminal Control-key conventions.
    pub fn uses_terminal_keyboard(&self) -> bool {
        self.terminal_keyboard || self.renderer == Renderer::Terminal
    }
}
