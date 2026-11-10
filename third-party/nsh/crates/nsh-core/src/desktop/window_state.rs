//! What the app reads of its windows and the displays (TS `nsh/desktop`'s
//! `WindowRef.state()`, `windowState()` and `displays()`), and the
//! placement it saves and restores a window with ([`WindowPlacement`],
//! GPUI's `WindowBounds`).
//!
//! Every rectangle is in points, in screen coordinates: from the primary
//! display's top left corner, `y` growing down, as
//! `WindowRef.setBounds` takes them.

use serde::{Deserialize, Serialize};

use super::WindowMode;
use crate::{
    element::{JsHost, JsIn, JsObject, JsOwned, JsValue, PropError, TsTypes},
    geometry::{Bounds, Point, Points, Size},
};

/// A display, the same from one launch of the app to the next on the same
/// machine (an id to compare, not to read: the platform's own name for the
/// display, hashed). TS: a string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct DisplayId(pub u64);

impl DisplayId {
    /// The id of the display the platform names `name` (a display's UUID,
    /// a monitor's device name, a connector): FNV-1a, which gives the same
    /// id for the same name in every process. For the platform backends,
    /// which all name displays this way.
    #[doc(hidden)]
    pub fn from_name(name: &[u8]) -> DisplayId {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in name {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        DisplayId(hash)
    }
}

/// TS: `string`, sixteen hexadecimal digits.
impl JsValue for DisplayId {
    fn ts_type(_types: &mut TsTypes) -> String {
        "string".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        value
            .as_string()
            .and_then(|s| u64::from_str_radix(&s, 16).ok())
            .map(DisplayId)
            .ok_or_else(|| value.expected("a display id"))
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        format!("{:016x}", self.0).to_js(host)
    }
}

/// A display (GPUI's `PlatformDisplay`): its area, the part of it windows
/// use, and how it shows them.
#[non_exhaustive]
#[derive(Debug, Clone, PartialEq, Default, JsObject)]
pub struct Display {
    /// Which display it is, the same in the app's next launch.
    pub id: DisplayId,
    /// Its whole area, in screen coordinates.
    pub bounds: Bounds<Points>,
    /// The part windows use: its area without the menu bar, the Dock or the
    /// taskbar (the whole area where the platform does not tell).
    pub visible_bounds: Bounds<Points>,
    /// The primary display, whose top left corner screen coordinates start
    /// from.
    pub primary: bool,
    /// Its name as the system shows it (`""` where the platform does not
    /// tell).
    pub name: String,
    /// Device pixels per point.
    pub scale_factor: f32,
    /// Frames per second it shows, where the platform tells.
    pub refresh_rate: Option<f32>,
}

impl Display {
    /// A display with `id`, `bounds` and `visible_bounds`, at a scale of 1
    /// and with no name.
    pub fn new(
        id: DisplayId,
        bounds: Bounds<Points>,
        visible_bounds: Bounds<Points>,
        primary: bool,
    ) -> Display {
        Display {
            id,
            bounds,
            visible_bounds,
            primary,
            name: String::new(),
            scale_factor: 1.0,
            refresh_rate: None,
        }
    }
}

/// A window's mode and its normal bounds (GPUI's `WindowBounds`): what an
/// app saves to open its window as the user left it, and gives
/// `WindowRef.setPlacement` (Rust [`crate::element::desktop::WindowRef::set_placement`])
/// to restore it. A maximized or full screen window carries the bounds it
/// returns to.
///
/// TS: `{ mode: WindowMode; bounds: Bounds }`, which is also its serde form:
/// what one side saves `JSON.stringify` reads back with `serde_json`, and
/// the other way round.
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize, JsObject)]
pub struct WindowPlacement {
    /// Normal, maximized (zoomed on macOS) or in full screen.
    #[prop(default)]
    #[serde(default)]
    pub mode: WindowMode,
    /// Its bounds in the normal mode: where it is, or returns to, in
    /// points, in screen coordinates.
    pub bounds: Bounds<Points>,
}

/// The least of a window's top strip ([`TITLE_STRIP`] tall) that stays
/// on a display's visible area for `fit_on_displays` to leave it where it
/// is: enough to take it by its title bar.
const GRAB: Size<Points> = Size {
    width: Points(100.0),
    height: Points(20.0),
};

/// The top of a window that holds its title bar.
const TITLE_STRIP: Points = Points(40.0);

impl WindowPlacement {
    /// A placement in `mode` with normal bounds `bounds`.
    pub fn new(mode: WindowMode, bounds: Bounds<Points>) -> WindowPlacement {
        WindowPlacement { mode, bounds }
    }

    /// The same mode with `bounds`.
    pub fn with_bounds(self, bounds: Bounds<Points>) -> WindowPlacement {
        WindowPlacement { bounds, ..self }
    }

    /// These bounds on the displays there are now (saved bounds of a
    /// display the user has since unplugged, or of another arrangement):
    /// unchanged when at least 100 × 20 points of the window's top 40
    /// points are on a display's visible area, where the user can take it
    /// by its title bar; otherwise centered on the primary display's
    /// visible area (the first display's without one), no larger than it.
    /// A size that is not finite and positive takes the visible area's.
    /// The mode stays. Without displays (off desktops) the bounds stay.
    /// What `WindowRef::set_placement` does to the bounds it is given.
    pub(crate) fn fit_on_displays(self, displays: &[Display]) -> WindowPlacement {
        let bounds = self.bounds;
        let valid = |v: Points| v.0.is_finite() && v.0 > 0.0;
        let sized = valid(bounds.size.width)
            && valid(bounds.size.height)
            && bounds.origin.x.0.is_finite()
            && bounds.origin.y.0.is_finite();
        if sized && displays.iter().any(|d| grabbable(bounds, d.visible_bounds)) {
            return self;
        }
        let Some(display) = displays
            .iter()
            .find(|d| d.primary)
            .or_else(|| displays.first())
        else {
            return self;
        };
        let area = display.visible_bounds;
        let fit = |v: Points, max: Points| if valid(v) { v.min(max) } else { max };
        let size = Size {
            width: fit(bounds.size.width, area.size.width),
            height: fit(bounds.size.height, area.size.height),
        };
        let origin = Point {
            x: area.origin.x + (area.size.width - size.width) / 2.0,
            y: area.origin.y + (area.size.height - size.height) / 2.0,
        };
        self.with_bounds(Bounds::new(origin, size))
    }
}

/// Whether enough of `bounds`' top strip is on `area` ([`GRAB`]).
fn grabbable(bounds: Bounds<Points>, area: Bounds<Points>) -> bool {
    let strip = Bounds::new(
        bounds.origin,
        Size {
            width: bounds.size.width,
            height: bounds.size.height.min(TITLE_STRIP),
        },
    );
    if !strip.intersects(&area) {
        return false;
    }
    let on = strip.intersect(&area);
    on.size.width >= GRAB.width.min(strip.size.width)
        && on.size.height >= GRAB.height.min(strip.size.height)
}

/// A window as the platform reports it (TS `WindowRef.state()` and
/// `windowState()`, Rust [`crate::element::desktop::WindowRef::state`]).
/// A move or a resize is reported once the window stops for a moment; a
/// change of mode, of display, of the focus or of being minimized or
/// hidden at once.
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Default, JsObject)]
pub struct WindowState {
    /// Its mode.
    pub mode: WindowMode,
    /// It is minimized (in the Dock, the taskbar).
    pub minimized: bool,
    /// It is on the screen: shown and not minimized (the app not hidden by
    /// macOS's Hide). One there that `lifecycle()` reports in the
    /// background is covered by other windows.
    pub visible: bool,
    /// It has the keyboard focus.
    pub focused: bool,
    /// Its outer frame now, window decorations included, in screen
    /// coordinates (a maximized or full screen window's as it shows).
    pub bounds: Bounds<Points>,
    /// Its content area now, in screen coordinates.
    pub content_bounds: Bounds<Points>,
    /// Its mode and normal bounds: what to save to open it the same way
    /// next time.
    pub placement: WindowPlacement,
    /// The display it is on (the one with most of it): one of
    /// `displays()`.
    pub display: Option<DisplayId>,
    /// Device pixels per point.
    pub scale_factor: f32,
}

impl WindowState {
    /// A window on the screen at `bounds` (its content too) in
    /// `placement`'s mode, at a scale of 1.
    pub fn new(bounds: Bounds<Points>, placement: WindowPlacement) -> WindowState {
        WindowState {
            mode: placement.mode,
            visible: true,
            bounds,
            content_bounds: bounds,
            placement,
            scale_factor: 1.0,
            ..WindowState::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::{point, px, size};

    fn rect(x: f32, y: f32, w: f32, h: f32) -> Bounds<Points> {
        Bounds::new(point(px(x), px(y)), size(px(w), px(h)))
    }

    fn displays() -> Vec<Display> {
        vec![
            // A laptop's screen under a menu bar, and a display to its right.
            Display::new(
                DisplayId(1),
                rect(0.0, 0.0, 1440.0, 900.0),
                rect(0.0, 25.0, 1440.0, 875.0),
                true,
            ),
            Display::new(
                DisplayId(2),
                rect(1440.0, 0.0, 1920.0, 1080.0),
                rect(1440.0, 0.0, 1920.0, 1080.0),
                false,
            ),
        ]
    }

    #[test]
    fn display_ids_are_stable_hashes_of_names() {
        assert_eq!(DisplayId::from_name(b""), DisplayId(0xcbf2_9ce4_8422_2325));
        assert_eq!(DisplayId::from_name(b"a"), DisplayId(0xaf63_dc4c_8601_ec8c));
        assert_ne!(
            DisplayId::from_name(b"\\\\.\\DISPLAY1"),
            DisplayId::from_name(b"\\\\.\\DISPLAY2")
        );
    }

    #[test]
    fn bounds_on_a_display_stay() {
        let on_second = WindowPlacement::new(WindowMode::Normal, rect(2000.0, 100.0, 800.0, 600.0));
        assert_eq!(on_second.fit_on_displays(&displays()), on_second);
        // Across two displays.
        let across = WindowPlacement::new(WindowMode::Maximized, rect(1000.0, 200.0, 900.0, 600.0));
        assert_eq!(across.fit_on_displays(&displays()), across);
        // Mostly off the screen, but its title bar can be taken.
        let corner = WindowPlacement::new(WindowMode::Normal, rect(-700.0, 860.0, 800.0, 600.0));
        assert_eq!(corner.fit_on_displays(&displays()), corner);
    }

    #[test]
    fn bounds_off_every_display_move_to_the_primary_one() {
        // The display on the left is gone.
        let gone = WindowPlacement::new(WindowMode::Normal, rect(-1500.0, 100.0, 800.0, 600.0));
        assert_eq!(
            gone.fit_on_displays(&displays()),
            WindowPlacement::new(WindowMode::Normal, rect(320.0, 162.5, 800.0, 600.0))
        );
        // Larger than the primary display: as large as its visible area.
        let large = WindowPlacement::new(WindowMode::FullScreen, rect(5000.0, 0.0, 2560.0, 1440.0));
        assert_eq!(
            large.fit_on_displays(&displays()),
            WindowPlacement::new(WindowMode::FullScreen, rect(0.0, 25.0, 1440.0, 875.0))
        );
        // Only its bottom edge shows: its title bar is above the screen.
        let above = WindowPlacement::new(WindowMode::Normal, rect(100.0, -590.0, 800.0, 600.0));
        assert_eq!(
            above.fit_on_displays(&displays()),
            WindowPlacement::new(WindowMode::Normal, rect(320.0, 162.5, 800.0, 600.0))
        );
        // Too little of its title bar shows to take it.
        let sliver = WindowPlacement::new(WindowMode::Normal, rect(-750.0, 100.0, 800.0, 600.0));
        assert_ne!(sliver.fit_on_displays(&displays()), sliver);
    }

    #[test]
    fn invalid_bounds_take_the_visible_area() {
        let nan = WindowPlacement::new(WindowMode::Normal, rect(f32::NAN, 0.0, 0.0, -1.0));
        assert_eq!(
            nan.fit_on_displays(&displays()),
            WindowPlacement::new(WindowMode::Normal, rect(0.0, 25.0, 1440.0, 875.0))
        );
    }

    #[test]
    fn without_displays_the_bounds_stay() {
        let gone = WindowPlacement::new(WindowMode::Normal, rect(-1500.0, 100.0, 800.0, 600.0));
        assert_eq!(gone.fit_on_displays(&[]), gone);
        // No primary display: the first one.
        let second = &displays()[1..];
        assert_eq!(
            gone.fit_on_displays(second),
            WindowPlacement::new(WindowMode::Normal, rect(2000.0, 240.0, 800.0, 600.0))
        );
    }

    #[test]
    fn bounds_save_as_the_ts_object() {
        let bounds = WindowPlacement::new(WindowMode::Maximized, rect(10.0, 20.5, 800.0, 600.0));
        let json = serde_json::to_string(&bounds).unwrap();
        assert_eq!(
            json,
            r#"{"mode":"maximized","bounds":{"origin":{"x":10.0,"y":20.5},"size":{"width":800.0,"height":600.0}}}"#
        );
        assert_eq!(
            serde_json::from_str::<WindowPlacement>(&json).unwrap(),
            bounds
        );
        // As `JSON.stringify` writes it.
        let ts = r#"{"mode":"fullScreen","bounds":{"origin":{"x":-1,"y":0},"size":{"width":800,"height":600}}}"#;
        assert_eq!(
            serde_json::from_str::<WindowPlacement>(ts).unwrap(),
            WindowPlacement::new(WindowMode::FullScreen, rect(-1.0, 0.0, 800.0, 600.0))
        );
    }
}
