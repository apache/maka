//! The monitors as displays in points (`displays()`), and conversions
//! between a window's pixels and screen points.
//!
//! The process is per-monitor DPI aware: Win32 places windows in physical
//! pixels, and each monitor has a scale of its own. Screen points start at
//! the primary monitor's top left corner; each monitor is placed next to
//! the one it touches, at its own scale, so that a window's points on a
//! monitor are its pixels there divided by that monitor's scale.

use nsh_core::{
    desktop::{Display, DisplayId},
    geometry::{Bounds, Point, Points, point, size},
};
use windows::{
    Win32::{
        Foundation::{LPARAM, RECT},
        Graphics::Gdi::{
            DEVMODEW, DISPLAY_DEVICEW, ENUM_CURRENT_SETTINGS, EnumDisplayDevicesW,
            EnumDisplayMonitors, EnumDisplaySettingsW, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO,
            MONITORINFOEXW,
        },
        UI::{
            HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI},
            WindowsAndMessaging::{EDD_GET_DEVICE_INTERFACE_NAME, MONITORINFOF_PRIMARY},
        },
    },
    core::{BOOL, PCWSTR},
};

/// A monitor: its pixels, its scale and the display it is in points.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Screen {
    pub(crate) monitor: HMONITOR,
    /// Its whole area, in pixels.
    pub(crate) native: RECT,
    /// Its work area (without the taskbar), in pixels.
    pub(crate) work: RECT,
    /// Pixels per point.
    pub(crate) scale: f32,
    pub(crate) display: Display,
}

impl Screen {
    /// `rect` (pixels on this monitor) in screen points.
    pub(crate) fn bounds(&self, rect: RECT) -> Bounds<Points> {
        Bounds::new(
            point(
                self.display.bounds.origin.x
                    + Points((rect.left - self.native.left) as f32 / self.scale),
                self.display.bounds.origin.y
                    + Points((rect.top - self.native.top) as f32 / self.scale),
            ),
            size(
                Points((rect.right - rect.left) as f32 / self.scale),
                Points((rect.bottom - rect.top) as f32 / self.scale),
            ),
        )
    }

    /// `bounds` (screen points) in pixels, on this monitor.
    pub(crate) fn native_bounds(&self, bounds: Bounds<Points>) -> RECT {
        let left = self.native.left
            + ((bounds.origin.x - self.display.bounds.origin.x).0 * self.scale).round() as i32;
        let top = self.native.top
            + ((bounds.origin.y - self.display.bounds.origin.y).0 * self.scale).round() as i32;
        RECT {
            left,
            top,
            right: left.saturating_add((bounds.size.width.0 * self.scale).round() as i32),
            bottom: top.saturating_add((bounds.size.height.0 * self.scale).round() as i32),
        }
    }
}

/// The monitors, the primary one first.
#[derive(Default, Clone, Debug)]
pub(crate) struct Screens(pub(crate) Vec<Screen>);

/// A NUL-terminated UTF-16 buffer's text.
fn text(units: &[u16]) -> String {
    let end = units.iter().position(|c| *c == 0).unwrap_or(units.len());
    String::from_utf16_lossy(&units[..end])
}

impl Screens {
    /// The monitors there are now.
    pub(crate) fn read() -> Screens {
        unsafe extern "system" fn collect(
            monitor: HMONITOR,
            _: HDC,
            _: *mut RECT,
            data: LPARAM,
        ) -> BOOL {
            let mut info = MONITORINFOEXW::default();
            info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
            // SAFETY: `info` declares its size as the extended structure;
            // `data` is the vector `read` passes, alive for the enumeration.
            unsafe {
                if !GetMonitorInfoW(monitor, &mut info as *mut _ as *mut MONITORINFO).as_bool() {
                    return true.into();
                }
                let native = info.monitorInfo.rcMonitor;
                if native.right <= native.left || native.bottom <= native.top {
                    return true.into();
                }
                let (mut dpi, mut dpi_y) = (96u32, 96u32);
                let scale = if GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi, &mut dpi_y)
                    .is_ok()
                    && dpi > 0
                {
                    dpi as f32 / 96.0
                } else {
                    1.0
                };
                let device_name = PCWSTR(info.szDevice.as_ptr());
                // The monitor's interface path names it the same from one
                // launch to the next (the device name `\\.\DISPLAYn` is
                // only its place in the list).
                let mut device = DISPLAY_DEVICEW {
                    cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32,
                    ..Default::default()
                };
                let stable = if EnumDisplayDevicesW(
                    device_name,
                    0,
                    &mut device,
                    EDD_GET_DEVICE_INTERFACE_NAME,
                )
                .as_bool()
                    && device.DeviceID[0] != 0
                {
                    text(&device.DeviceID)
                } else {
                    text(&info.szDevice)
                };
                // Its name as the system shows it.
                let mut named = DISPLAY_DEVICEW {
                    cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32,
                    ..Default::default()
                };
                let name = if EnumDisplayDevicesW(device_name, 0, &mut named, 0).as_bool() {
                    text(&named.DeviceString)
                } else {
                    String::new()
                };
                let mut mode = DEVMODEW {
                    dmSize: std::mem::size_of::<DEVMODEW>() as u16,
                    ..Default::default()
                };
                // 0 and 1 mean the hardware's default rate.
                let refresh_rate =
                    (EnumDisplaySettingsW(device_name, ENUM_CURRENT_SETTINGS, &mut mode).as_bool()
                        && mode.dmDisplayFrequency > 1)
                        .then_some(mode.dmDisplayFrequency as f32);
                let mut display = Display::new(
                    DisplayId::from_name(stable.as_bytes()),
                    Bounds::default(),
                    Bounds::default(),
                    info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
                );
                display.name = name;
                display.scale_factor = scale;
                display.refresh_rate = refresh_rate;
                let screens = &mut *(data.0 as *mut Vec<Screen>);
                screens.push(Screen {
                    monitor,
                    native,
                    work: info.monitorInfo.rcWork,
                    scale,
                    display,
                });
                true.into()
            }
        }
        let mut screens = Vec::new();
        // SAFETY: `collect` only runs during the call, with this vector.
        unsafe {
            let _ = EnumDisplayMonitors(
                None,
                None,
                Some(collect),
                LPARAM(&mut screens as *mut _ as isize),
            );
        }
        Screens::layout(screens)
    }

    /// Places `screens` in points: the primary one at the origin, each
    /// other next to one it touches.
    pub(crate) fn layout(mut screens: Vec<Screen>) -> Screens {
        screens.sort_by_key(|s| {
            (
                !s.display.primary,
                s.native.left,
                s.native.top,
                s.display.id.0,
            )
        });
        let Some(primary_scale) = screens.first().map(|s| s.scale) else {
            return Screens(screens);
        };
        for screen in &mut screens {
            // Where nothing it touches places it: its pixels at the primary
            // monitor's scale.
            screen.display.bounds = Bounds::new(
                point(
                    Points(screen.native.left as f32 / primary_scale),
                    Points(screen.native.top as f32 / primary_scale),
                ),
                size(
                    Points((screen.native.right - screen.native.left) as f32 / screen.scale),
                    Points((screen.native.bottom - screen.native.top) as f32 / screen.scale),
                ),
            );
        }
        let mut placed = vec![false; screens.len()];
        placed[0] = true;
        loop {
            let mut changed = false;
            for child in 1..screens.len() {
                if placed[child] {
                    continue;
                }
                // Next to a placed one it touches. A monitor beside a denser
                // one can touch it and another monitor at once, and there
                // the place next to one covers the other: it moves on the
                // way it touches until it covers none, so that no point is
                // on two displays (mixed scales can leave gaps). The place
                // that moved least wins.
                let size = screens[child].display.bounds.size;
                let mut best: Option<(f32, Point<Points>)> = None;
                for parent in (0..screens.len()).filter(|&parent| placed[parent]) {
                    let Some((start, side)) = adjacent(&screens[parent], &screens[child]) else {
                        continue;
                    };
                    let mut origin = start;
                    for _ in 0..screens.len() {
                        let bounds = Bounds::new(origin, size);
                        let Some(other) = (0..screens.len())
                            .filter(|&other| placed[other])
                            .map(|other| screens[other].display.bounds)
                            .find(|other| {
                                let overlap = bounds.intersect(other);
                                overlap.size.width.0 > 0.0 && overlap.size.height.0 > 0.0
                            })
                        else {
                            break;
                        };
                        match side {
                            Side::Right => origin.x = other.origin.x + other.size.width,
                            Side::Left => origin.x = other.origin.x - size.width,
                            Side::Below => origin.y = other.origin.y + other.size.height,
                            Side::Above => origin.y = other.origin.y - size.height,
                        }
                    }
                    let moved = (origin.x - start.x).0.abs() + (origin.y - start.y).0.abs();
                    if best.is_none_or(|(least, _)| moved < least) {
                        best = Some((moved, origin));
                    }
                }
                let origin = best.map(|(_, origin)| origin);
                if let Some(origin) = origin {
                    screens[child].display.bounds.origin = origin;
                    placed[child] = true;
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        for screen in &mut screens {
            screen.display.visible_bounds = screen.bounds(screen.work);
        }
        Screens(screens)
    }

    /// The displays.
    pub(crate) fn displays(&self) -> Vec<Display> {
        self.0.iter().map(|s| s.display.clone()).collect()
    }

    /// The monitor `monitor`.
    pub(crate) fn of(&self, monitor: HMONITOR) -> Option<&Screen> {
        self.0.iter().find(|s| s.monitor == monitor)
    }

    /// The display `id`.
    pub(crate) fn by_id(&self, id: DisplayId) -> Option<&Screen> {
        self.0.iter().find(|s| s.display.id == id)
    }

    /// The primary monitor.
    pub(crate) fn primary(&self) -> Option<&Screen> {
        self.0.iter().find(|s| s.display.primary).or(self.0.first())
    }

    /// The monitor with most of `rect` (pixels), else the nearest.
    pub(crate) fn native_screen(&self, rect: RECT) -> Option<&Screen> {
        self.best(
            Bounds::new(
                point(Points(rect.left as f32), Points(rect.top as f32)),
                size(
                    Points((rect.right - rect.left) as f32),
                    Points((rect.bottom - rect.top) as f32),
                ),
            ),
            false,
        )
    }

    /// The display with most of `rect` (screen points), else the nearest.
    pub(crate) fn logical_screen(&self, rect: Bounds<Points>) -> Option<&Screen> {
        self.best(rect, true)
    }

    fn best(&self, bounds: Bounds<Points>, logical: bool) -> Option<&Screen> {
        let score = |s: &Screen| {
            let area = if logical {
                s.display.bounds
            } else {
                Bounds::new(
                    point(Points(s.native.left as f32), Points(s.native.top as f32)),
                    size(
                        Points((s.native.right - s.native.left) as f32),
                        Points((s.native.bottom - s.native.top) as f32),
                    ),
                )
            };
            let overlap = bounds.intersect(&area);
            let visible = overlap.size.width.0.max(0.0) * overlap.size.height.0.max(0.0);
            let dx = (area.origin.x.0 - bounds.origin.x.0)
                .max(0.0)
                .max(bounds.origin.x.0 - (area.origin.x + area.size.width).0);
            let dy = (area.origin.y.0 - bounds.origin.y.0)
                .max(0.0)
                .max(bounds.origin.y.0 - (area.origin.y + area.size.height).0);
            (visible, -(dx * dx + dy * dy), s.display.primary)
        };
        self.0.iter().max_by(|a, b| {
            let (aa, ad, ap) = score(a);
            let (ba, bd, bp) = score(b);
            aa.total_cmp(&ba).then(ad.total_cmp(&bd)).then(ap.cmp(&bp))
        })
    }
}

/// The side of a monitor another touches.
#[derive(Clone, Copy)]
enum Side {
    Right,
    Left,
    Below,
    Above,
}

/// Where `child` goes in points when it touches `parent` (side by side or
/// one above the other), and on which side of it; `None` when it does not.
fn adjacent(parent: &Screen, child: &Screen) -> Option<(Point<Points>, Side)> {
    let p = parent.native;
    let c = child.native;
    let origin = parent.display.bounds.origin;
    let extent = parent.display.bounds.size;
    let y = origin.y + Points((c.top - p.top) as f32 / parent.scale);
    let x = origin.x + Points((c.left - p.left) as f32 / parent.scale);
    if p.top.max(c.top) <= p.bottom.min(c.bottom) {
        if c.left == p.right {
            return Some((point(origin.x + extent.width, y), Side::Right));
        }
        if c.right == p.left {
            return Some((
                point(origin.x - child.display.bounds.size.width, y),
                Side::Left,
            ));
        }
    }
    if p.left.max(c.left) <= p.right.min(c.right) {
        if c.top == p.bottom {
            return Some((point(x, origin.y + extent.height), Side::Below));
        }
        if c.bottom == p.top {
            return Some((
                point(x, origin.y - child.display.bounds.size.height),
                Side::Above,
            ));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(left: i32, top: i32, right: i32, bottom: i32) -> RECT {
        RECT {
            left,
            top,
            right,
            bottom,
        }
    }

    fn screen(id: u64, native: RECT, scale: f32, primary: bool) -> Screen {
        Screen {
            monitor: HMONITOR(id as usize as *mut _),
            native,
            work: native,
            scale,
            display: Display::new(DisplayId(id), Bounds::default(), Bounds::default(), primary),
        }
    }

    #[test]
    fn a_window_on_a_denser_monitor_keeps_its_points() {
        let screens = Screens::layout(vec![
            screen(1, rect(0, 0, 1920, 1080), 1.0, true),
            screen(2, rect(1920, 0, 5760, 2160), 2.0, false),
        ]);
        let native = rect(2200, 120, 3200, 920);
        let source = &screens.0[1];
        let bounds = source.bounds(native);
        assert_eq!(bounds.origin.x, Points(2060.0));
        assert_eq!(bounds.size.width, Points(500.0));
        let target = screens.logical_screen(bounds).unwrap();
        assert_eq!(target.display.id, DisplayId(2));
        assert_eq!(target.native_bounds(bounds), native);
    }

    #[test]
    fn bounds_round_trip_at_fractional_scales_and_negative_positions() {
        for primary_scale in [1.0, 1.25, 1.5, 2.0] {
            for other_scale in [1.0, 1.25, 1.5, 2.0] {
                for native in [
                    rect(1920, 0, 4480, 1440),
                    rect(-2560, 0, 0, 1440),
                    rect(0, -1440, 2560, 0),
                    rect(0, 1080, 2560, 2520),
                ] {
                    let screens = Screens::layout(vec![
                        screen(2, native, other_scale, false),
                        screen(1, rect(0, 0, 1920, 1080), primary_scale, true),
                    ]);
                    assert!(screens.0[0].display.primary);
                    for source in &screens.0 {
                        let r = rect(
                            source.native.left + 100,
                            source.native.top + 100,
                            source.native.left + 500,
                            source.native.top + 400,
                        );
                        let bounds = source.bounds(r);
                        let target = screens.logical_screen(bounds).unwrap();
                        assert_eq!(target.display.id, source.display.id);
                        assert_eq!(target.native_bounds(bounds), r);
                        assert_eq!(
                            source.native_bounds(source.display.visible_bounds),
                            source.work
                        );
                    }
                }
            }
        }
    }

    /// No point of the screen is on two displays.
    fn assert_disjoint(screens: &Screens) {
        for (i, a) in screens.0.iter().enumerate() {
            for b in &screens.0[i + 1..] {
                let overlap = a.display.bounds.intersect(&b.display.bounds);
                assert!(
                    overlap.size.width.0 <= 0.0 || overlap.size.height.0 <= 0.0,
                    "{:?} and {:?} overlap",
                    a.display.bounds,
                    b.display.bounds
                );
            }
        }
    }

    #[test]
    fn monitors_stacked_beside_a_denser_primary_stay_apart() {
        // A 200% primary, two 100% monitors one above the other on its
        // right: the lower one touches the primary and the upper one.
        for order in [[1, 2, 3], [3, 2, 1], [2, 3, 1]] {
            let all = [
                screen(1, rect(0, 0, 3840, 2160), 2.0, true),
                screen(2, rect(3840, 0, 5760, 1080), 1.0, false),
                screen(3, rect(3840, 1080, 5760, 2160), 1.0, false),
            ];
            let screens = Screens::layout(
                order
                    .iter()
                    .map(|&id| all.iter().find(|s| s.display.id.0 == id).unwrap().clone())
                    .collect(),
            );
            assert_disjoint(&screens);
            let upper = screens.by_id(DisplayId(2)).unwrap();
            let lower = screens.by_id(DisplayId(3)).unwrap();
            assert_eq!(
                upper.display.bounds.origin,
                point(Points(1920.0), Points(0.0))
            );
            assert_eq!(
                lower.display.bounds.origin,
                point(Points(1920.0), Points(1080.0))
            );
            // A window on the upper one comes back there.
            let native = rect(4000, 700, 4400, 1000);
            let bounds = upper.bounds(native);
            let target = screens.logical_screen(bounds).unwrap();
            assert_eq!(target.display.id, DisplayId(2));
            assert_eq!(target.native_bounds(bounds), native);
        }
    }

    #[test]
    fn three_monitors_at_any_scales_stay_apart_and_round_trip() {
        let scales = [1.0, 1.25, 1.5, 2.0];
        for a in scales {
            for b in scales {
                for c in scales {
                    for (second, third) in [
                        // Stacked on the right.
                        (rect(3840, 0, 5760, 1080), rect(3840, 1080, 5760, 2160)),
                        // One on each side.
                        (rect(3840, 0, 5760, 1080), rect(-1920, 0, 0, 1080)),
                        // Side by side above.
                        (rect(0, -1080, 1920, 0), rect(1920, -1080, 3840, 0)),
                        // Side by side below.
                        (rect(0, 2160, 1920, 3240), rect(1920, 2160, 3840, 3240)),
                        // In a row on the right.
                        (rect(3840, 0, 5760, 1080), rect(5760, 0, 7680, 1080)),
                    ] {
                        let screens = Screens::layout(vec![
                            screen(3, third, c, false),
                            screen(1, rect(0, 0, 3840, 2160), a, true),
                            screen(2, second, b, false),
                        ]);
                        assert_disjoint(&screens);
                        for source in &screens.0 {
                            let r = rect(
                                source.native.left + 100,
                                source.native.top + 100,
                                source.native.left + 500,
                                source.native.top + 400,
                            );
                            let bounds = source.bounds(r);
                            let target = screens.logical_screen(bounds).unwrap();
                            assert_eq!(target.display.id, source.display.id);
                            assert_eq!(target.native_bounds(bounds), r);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn work_areas_are_relative_to_their_monitor() {
        let mut right = screen(2, rect(1920, 0, 5760, 2160), 2.0, false);
        right.work.left += 80;
        right.work.bottom -= 80;
        let screens = Screens::layout(vec![screen(1, rect(0, 0, 1920, 1080), 1.0, true), right]);
        let right = &screens.0[1];
        assert_eq!(right.display.visible_bounds.origin.x, Points(1960.0));
        assert_eq!(right.display.visible_bounds.size.width, Points(1880.0));
        assert_eq!(
            right.native_bounds(right.display.visible_bounds),
            right.work
        );
        assert_eq!(screens.primary().unwrap().display.id, DisplayId(1));
        assert_eq!(screens.by_id(DisplayId(2)).unwrap().scale, 2.0);
    }
}
