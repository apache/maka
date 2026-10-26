/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Where the window was when it closed: its display, whether it filled the
//! screen, and its bounds. The placement is kept beside the client journal
//! in the Root's client directory, so the desktop opens where it closed.

use nsh_platform_gpui::gpui::{self, App, Bounds, DisplayId, Pixels, Size, Window, WindowBounds};
use serde::{Deserialize, Serialize};
use std::{
    cell::RefCell,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use uuid::Uuid;

const FILE: &str = "desktop-window.json";
/// How much of the window's top edge must stay on its display for the window
/// to open there again: enough to grab and move it.
const GRAB: f32 = 64.;
/// How long the window must keep its bounds for them to count as where it
/// was: maximizing animates the frame through bounds the window was never
/// left at.
const SETTLE: Duration = Duration::from_millis(500);

#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct Saved {
    /// The display's stable identifier.
    display: Uuid,
    state: State,
    /// The window's bounds; for a maximized or full-screen window, the ones
    /// it returns to.
    x: f32,
    y: f32,
    width: f32,
    height: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum State {
    Windowed,
    Maximized,
    Fullscreen,
}

/// Where a saved window opens: on `display`, at `bounds`, or centered there
/// at `size` when the saved position is no longer on that display.
#[derive(Debug, PartialEq)]
struct Spot<T> {
    display: T,
    state: State,
    bounds: Option<Bounds<Pixels>>,
    size: Size<Pixels>,
}

/// Where the window last was while windowed: the bounds a maximized window
/// returns to. macOS reports a maximized (zoomed) window as windowed at its
/// zoomed frame, so the desktop keeps them itself.
#[derive(Default)]
struct Windowed {
    /// Bounds the window settled at.
    settled: Option<Bounds<Pixels>>,
    /// The bounds it has had since `Instant`, not yet settled.
    latest: Option<(Bounds<Pixels>, Instant)>,
}

impl Windowed {
    /// The window has `bounds` at `now`, or is not windowed (`None`).
    fn note(&mut self, bounds: Option<Bounds<Pixels>>, now: Instant) {
        if let Some((latest, since)) = self.latest
            && now.duration_since(since) >= SETTLE
        {
            self.settled = Some(latest);
        }
        self.latest = bounds.map(|bounds| (bounds, now));
    }
}

/// The window placement saved in a client directory.
pub struct Placement {
    path: PathBuf,
    windowed: RefCell<Windowed>,
}

impl Placement {
    pub fn new(directory: &Path) -> Self {
        Self {
            path: directory.join(FILE),
            windowed: RefCell::default(),
        }
    }

    /// The display and bounds the window had, when that display is still
    /// connected; `None` without a saved placement.
    pub fn restore(&self, min: Size<Pixels>, cx: &App) -> Option<(DisplayId, WindowBounds)> {
        let saved = serde_json::from_slice(&std::fs::read(&self.path).ok()?).ok()?;
        let displays = cx
            .displays()
            .into_iter()
            .filter_map(|display| Some((display.uuid().ok()?, display.id(), display.bounds())));
        let spot = place(&saved, displays, min)?;
        let bounds = spot
            .bounds
            .unwrap_or_else(|| Bounds::centered(Some(spot.display), spot.size, cx));
        self.windowed.borrow_mut().settled = Some(bounds);
        let bounds = match spot.state {
            State::Windowed => WindowBounds::Windowed(bounds),
            State::Maximized => WindowBounds::Maximized(bounds),
            State::Fullscreen => WindowBounds::Fullscreen(bounds),
        };
        Some((spot.display, bounds))
    }

    /// Notes where `window` is while it is windowed; called as it moves and
    /// resizes.
    pub fn follow(&self, window: &Window) {
        let bounds = match window.window_bounds() {
            WindowBounds::Windowed(bounds) if !window.is_maximized() => Some(bounds),
            _ => None,
        };
        self.windowed.borrow_mut().note(bounds, Instant::now());
    }

    /// Records where `window` is. A placement that cannot be saved only
    /// costs the next window its place, so the error is printed.
    pub fn save(&self, window: &Window, cx: &App) {
        let Some(display) = window.display(cx).and_then(|display| display.uuid().ok()) else {
            return;
        };
        let (state, bounds) = match window.window_bounds() {
            WindowBounds::Windowed(bounds) if window.is_maximized() => (
                State::Maximized,
                self.windowed.borrow().settled.unwrap_or(bounds),
            ),
            WindowBounds::Windowed(bounds) => (State::Windowed, bounds),
            WindowBounds::Maximized(bounds) => (State::Maximized, bounds),
            WindowBounds::Fullscreen(bounds) => (State::Fullscreen, bounds),
        };
        let saved = Saved {
            display,
            state,
            x: bounds.origin.x.as_f32(),
            y: bounds.origin.y.as_f32(),
            width: bounds.size.width.as_f32(),
            height: bounds.size.height.as_f32(),
        };
        if let Err(error) = write(&self.path, &saved) {
            eprintln!("maka-desktop-shell: {}: {error}", self.path.display());
        }
    }
}

fn write(path: &Path, saved: &Saved) -> std::io::Result<()> {
    let partial = path.with_extension("json.partial");
    std::fs::write(&partial, serde_json::to_vec_pretty(saved)?)?;
    std::fs::rename(partial, path)
}

/// Where `saved` opens among `displays` (identifier, id, bounds): on the
/// display it was on, if that one is connected, at no less than `min` and no
/// more than the display. It keeps its position while enough of its top edge
/// stays on the display to grab.
fn place<T>(
    saved: &Saved,
    displays: impl IntoIterator<Item = (Uuid, T, Bounds<Pixels>)>,
    min: Size<Pixels>,
) -> Option<Spot<T>> {
    let (_, display, screen) = displays
        .into_iter()
        .find(|(identifier, ..)| *identifier == saved.display)?;
    let fit = |saved: f32, min: Pixels, screen: Pixels| {
        gpui::px(saved.max(min.as_f32()).min(screen.as_f32()))
    };
    let size = gpui::size(
        fit(saved.width, min.width, screen.size.width),
        fit(saved.height, min.height, screen.size.height),
    );
    let (left, top) = (screen.origin.x.as_f32(), screen.origin.y.as_f32());
    let (right, bottom) = (
        left + screen.size.width.as_f32(),
        top + screen.size.height.as_f32(),
    );
    let grabbed = saved.y >= top
        && saved.y <= bottom - GRAB
        && saved.x + size.width.as_f32() >= left + GRAB
        && saved.x <= right - GRAB;
    Some(Spot {
        display,
        state: saved.state,
        bounds: grabbed
            .then(|| Bounds::new(gpui::point(gpui::px(saved.x), gpui::px(saved.y)), size)),
        size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved(x: f32, y: f32, width: f32, height: f32) -> Saved {
        Saved {
            display: Uuid::from_u128(1),
            state: State::Windowed,
            x,
            y,
            width,
            height,
        }
    }

    fn screen(x: f32, y: f32, width: f32, height: f32) -> Bounds<Pixels> {
        Bounds::new(
            gpui::point(gpui::px(x), gpui::px(y)),
            gpui::size(gpui::px(width), gpui::px(height)),
        )
    }

    const MIN: Size<Pixels> = Size {
        width: gpui::px(640.),
        height: gpui::px(480.),
    };

    #[test]
    fn a_maximized_window_returns_to_bounds_it_settled_at_not_its_animation() {
        let start = Instant::now();
        let at = |ms| start + Duration::from_millis(ms);
        let mut windowed = Windowed {
            settled: Some(screen(116., 66., 1280., 820.)),
            latest: None,
        };
        // Moved, left there, then maximized through an animation.
        windowed.note(Some(screen(200., 100., 1000., 650.)), at(0));
        windowed.note(Some(screen(150., 80., 1200., 760.)), at(5_000));
        windowed.note(Some(screen(60., 50., 1400., 840.)), at(5_016));
        windowed.note(None, at(5_032));
        assert_eq!(windowed.settled, Some(screen(200., 100., 1000., 650.)));
        // Restored, then maximized again after a while.
        windowed.note(Some(screen(200., 100., 1000., 650.)), at(9_000));
        windowed.note(Some(screen(300., 120., 900., 600.)), at(9_100));
        windowed.note(None, at(20_000));
        assert_eq!(windowed.settled, Some(screen(300., 120., 900., 600.)));
    }

    #[test]
    fn a_window_reopens_where_it_was_on_its_display() {
        let displays = [
            (Uuid::from_u128(2), 'a', screen(0., 0., 1512., 982.)),
            (Uuid::from_u128(1), 'b', screen(1512., 0., 2560., 1440.)),
        ];
        let spot = place(&saved(1700., 120., 1280., 820.), displays, MIN).unwrap();
        assert_eq!(spot.display, 'b');
        assert_eq!(spot.bounds, Some(screen(1700., 120., 1280., 820.)));
    }

    #[test]
    fn a_window_whose_display_is_gone_has_no_place() {
        let displays = [(Uuid::from_u128(2), 'a', screen(0., 0., 1512., 982.))];
        assert_eq!(place(&saved(10., 10., 800., 600.), displays, MIN), None);
    }

    #[test]
    fn a_window_keeps_its_size_between_the_minimum_and_its_display() {
        let display = [(Uuid::from_u128(1), (), screen(0., 0., 1512., 982.))];
        let small = place(&saved(10., 10., 100., 100.), display, MIN).unwrap();
        assert_eq!(small.size, MIN);
        let large = place(&saved(0., 0., 3000., 2000.), display, MIN).unwrap();
        assert_eq!(large.size, gpui::size(gpui::px(1512.), gpui::px(982.)));
    }

    #[test]
    fn a_window_that_cannot_be_grabbed_is_centered_on_its_display() {
        let display = [(Uuid::from_u128(1), (), screen(0., 0., 1512., 982.))];
        for (x, y) in [(1480., 100.), (-1250., 100.), (100., -5.), (100., 960.)] {
            let spot = place(&saved(x, y, 1280., 820.), display, MIN).unwrap();
            assert_eq!(spot.bounds, None, "{x}, {y}");
            assert_eq!(spot.size, gpui::size(gpui::px(1280.), gpui::px(820.)));
        }
        let edge = place(&saved(1448., 918., 1280., 820.), display, MIN).unwrap();
        assert!(edge.bounds.is_some());
    }

    #[test]
    fn the_placement_survives_a_round_trip_through_its_file() {
        let directory = std::env::temp_dir().join(format!("maka-placement-{}", Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join(FILE);
        let maximized = Saved {
            state: State::Maximized,
            ..saved(-1200., 40., 1024., 700.)
        };
        write(&path, &maximized).unwrap();
        let read: Saved = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(read, maximized);
        assert!(!path.with_extension("json.partial").exists());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
