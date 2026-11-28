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

//! Native presentation policy shared by the two macOS permission-window hosts.

use nsh_platform_macos::{
    objc2::MainThreadOnly,
    objc2_app_kit::{NSFloatingWindowLevel, NSRunningApplication, NSScreen, NSWindow},
    objc2_foundation::{NSPoint, NSRect, NSSize, NSString},
};

/// Only for a newly opened permission utility, never its parent workbench or a
/// same-key focus: the user may have moved an existing utility deliberately.
pub(crate) fn configure(window: &NSWindow) {
    window.setLevel(NSFloatingWindowLevel);
    if let Some(screen) = NSScreen::mainScreen(window.mtm()).or_else(|| window.screen()) {
        window.setFrame_display(corner(window.frame().size, screen.visibleFrame()), false);
    }
}

/// Called only for the nonactivating Settings guide, while its lease is live.
pub(crate) fn place_guide(window: &NSWindow) -> bool {
    let mtm = window.mtm();
    let screens = NSScreen::screens(mtm);
    let Some(primary) = screens.firstObject() else {
        return false;
    };
    let fallback = NSScreen::mainScreen(mtm)
        .unwrap_or_else(|| primary.clone())
        .visibleFrame();
    let settings = NSRunningApplication::runningApplicationsWithBundleIdentifier(
        &NSString::from_str("com.apple.systempreferences"),
    )
    .firstObject()
    .and_then(|app| {
        // A sheet may be in front of the main window. Prefer the largest normal window.
        crate::window_list::on_screen(Some(app.processIdentifier()))
            .into_iter()
            .map(|w| w.bounds)
            .max_by(|a, b| area(*a).total_cmp(&area(*b)))
    })
    .map(|bounds| appkit_bounds(bounds, primary.frame().max().y));
    let frame = guide_frame(
        window.frame().size,
        settings,
        screens.iter().map(|s| (s.frame(), s.visibleFrame())),
        fallback,
    );
    let Some(frame) = frame else { return false };
    if window.frame() != frame {
        window.setFrame_display(frame, false);
    }
    true
}

fn appkit_bounds(cg: NSRect, primary_top: f64) -> NSRect {
    NSRect::new(NSPoint::new(cg.min().x, primary_top - cg.max().y), cg.size)
}

fn fit(size: NSSize, visible: NSRect) -> NSSize {
    NSSize::new(
        size.width.min(visible.size.width),
        size.height.min(visible.size.height),
    )
}

fn corner(size: NSSize, visible: NSRect) -> NSRect {
    let size = fit(size, visible);
    NSRect::new(
        NSPoint::new(
            (visible.max().x - size.width - 16.).max(visible.min().x),
            (visible.max().y - size.height - 16.).max(visible.min().y),
        ),
        size,
    )
}

fn area(rect: NSRect) -> f64 {
    rect.size.width * rect.size.height
}

fn guide_frame(
    size: NSSize,
    settings: Option<NSRect>,
    screens: impl IntoIterator<Item = (NSRect, NSRect)>,
    fallback: NSRect,
) -> Option<NSRect> {
    let Some(settings) = settings else {
        return Some(corner(size, fallback));
    };
    let screens: Vec<_> = screens.into_iter().collect();
    let overlap = |frame: NSRect| {
        let width = frame.max().x.min(settings.max().x) - frame.min().x.max(settings.min().x);
        let height = frame.max().y.min(settings.max().y) - frame.min().y.max(settings.min().y);
        width.max(0.) * height.max(0.)
    };
    let Some((_, visible)) = screens
        .iter()
        .filter(|(f, _)| overlap(*f) > 0.)
        .max_by(|(a, _), (b, _)| overlap(*a).total_cmp(&overlap(*b)))
    else {
        return Some(corner(size, fallback));
    };
    const GAP: f64 = 8.;
    for visible in
        std::iter::once(visible).chain(screens.iter().map(|(_, v)| v).filter(|v| *v != visible))
    {
        if visible.size.width < size.width || visible.size.height < size.height {
            continue;
        }
        let max_x = visible.max().x - size.width;
        let max_y = visible.max().y - size.height;
        let x = (settings.mid().x - size.width / 2.)
            .round()
            .clamp(visible.min().x, max_x);
        let y = (settings.mid().y - size.height / 2.)
            .round()
            .clamp(visible.min().y, max_y);
        for origin in [
            NSPoint::new(x, (settings.min().y - GAP - size.height).min(max_y)),
            NSPoint::new(x, (settings.max().y + GAP).max(visible.min().y)),
            NSPoint::new((settings.max().x + GAP).max(visible.min().x), y),
            NSPoint::new((settings.min().x - GAP - size.width).min(max_x), y),
        ] {
            if (visible.min().x..=max_x).contains(&origin.x)
                && (visible.min().y..=max_y).contains(&origin.y)
            {
                return Some(NSRect::new(origin, size));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const PANEL: NSSize = NSSize::new(400., 180.);
    fn rect(x: f64, y: f64, w: f64, h: f64) -> NSRect {
        NSRect::new(NSPoint::new(x, y), NSSize::new(w, h))
    }
    #[test]
    fn converts_quartz_global_points_using_primary_top_even_above_the_primary() {
        assert_eq!(
            appkit_bounds(rect(-540., -400., 500., 300.), 900.),
            rect(-540., 1000., 500., 300.)
        );
        assert_eq!(
            appkit_bounds(rect(100., 80., 700., 400.), 900.),
            rect(100., 420., 700., 400.)
        );
    }
    #[test]
    fn centers_below_settings_on_the_screen_with_the_largest_intersection() {
        let main = rect(0., 0., 1440., 900.);
        let left = rect(-1024., 200., 1024., 768.);
        let screens = [
            (main, rect(0., 40., 1440., 830.)),
            (left, rect(-1024., 240., 1024., 700.)),
        ];
        assert_eq!(
            guide_frame(PANEL, Some(rect(200., 340., 800., 440.)), screens, main),
            Some(rect(400., 152., 400., 180.))
        );
        assert_eq!(
            guide_frame(PANEL, Some(rect(-520., 580., 680., 340.)), screens, main),
            Some(rect(-400., 392., 400., 180.))
        );
    }
    #[test]
    fn prefers_above_then_the_unobstructed_side() {
        let screen = rect(0., 0., 1200., 900.);
        let visible = rect(40., 60., 1160., 810.);
        let screens = [(screen, visible)];
        assert_eq!(
            guide_frame(PANEL, Some(rect(900., 100., 400., 500.)), screens, visible),
            Some(rect(800., 608., 400., 180.))
        );
        assert_eq!(
            guide_frame(PANEL, Some(rect(-100., 100., 400., 720.)), screens, visible),
            Some(rect(308., 370., 400., 180.))
        );
    }
    #[test]
    fn guides_use_the_left_side_or_wait_for_room_instead_of_covering_settings() {
        let visible = rect(0., 0., 1200., 900.);
        assert_eq!(
            guide_frame(
                PANEL,
                Some(rect(420., 5., 770., 890.)),
                [(visible, visible)],
                visible
            ),
            Some(rect(12., 360., 400., 180.))
        );
        assert_eq!(
            guide_frame(PANEL, Some(visible), [(visible, visible)], visible),
            None
        );
    }
    #[test]
    fn falls_back_to_the_visible_top_right_without_an_onscreen_settings_window() {
        let visible = rect(-1280., 40., 1280., 800.);
        for missing in [None, Some(rect(300., 400., 500., 300.))] {
            assert_eq!(
                guide_frame(PANEL, missing, [(visible, visible)], visible),
                Some(rect(-416., 644., 400., 180.))
            );
        }
    }
}
