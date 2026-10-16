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

//! `svg(path).spin(period_ms)`, end to end: what a script records, and what
//! a spinning icon costs on the frames that follow.
//!
//! The cost is the point. A spinner brings its view back on every step, and
//! a step that entered the VM would make every loading indicator a script
//! render 30 times a second. These tests count script renders and paints
//! across steps, read the angle each step was painted at, and check that a
//! spinner inside a scroll container is not frozen inside a cached scroll
//! layer.

use std::{f32::consts::TAU, ops::Deref as _, rc::Rc, time::Duration};

use gpui::{
    App, AppContext as _, Entity, PlatformInput, ScrollDelta, ScrollWheelEvent, TestAppContext,
    TouchPhase, VisualTestContext, Window, point, px,
};

use crate::{
    ScriptView, ShellRuntime,
    materialize::{SPIN_STEP, take_painted_spin_angles},
};

const SPINNER: &str = r#"
import { View, div, svg } from "gpui-kit";

export default class Loading extends View {
  render() {
    return div()
      .child(svg("icons/spinner.svg").w(16).h(16).spin(1000))
      .child("loading");
  }
}
"#;

/// A window whose root is a `ShellRoot` over one script view, drawn once.
///
/// The real window root rather than `VisualTestContext::draw`: that redraws
/// every view from scratch, which would hide whether the spinner's own step
/// is what brings its view back.
fn mounted(
    cx: &mut TestAppContext,
    source: &str,
) -> (Rc<ShellRuntime>, VisualTestContext, Entity<ScriptView>) {
    cx.update(crate::init);
    let runtime = ShellRuntime::new_isolated().expect("runtime");
    cx.update(|cx| runtime.set_global(cx));
    let view_type = runtime.load_source("spin.js", source).expect("load");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let view = context.update(|window, cx| {
        let object = runtime
            .instantiate(&view_type, window, cx)
            .expect("instantiate");
        cx.new(|_| ScriptView::new(runtime.clone(), object))
    });
    context.update(|window, cx| {
        window.replace_root(cx, |window, cx| {
            crate::root::ShellRoot::new(view.clone().into(), window, cx)
        })
    });
    frame_after(&mut context, |_, _| ());
    take_painted_spin_angles();
    (runtime, context, view)
}

/// Runs `change` and draws the one frame that follows it: the window draws
/// itself when a change notifies a view in it, and is drawn here otherwise.
fn frame_after<R>(
    context: &mut VisualTestContext,
    change: impl FnOnce(&mut Window, &mut App) -> R,
) -> R {
    let frames =
        |context: &mut VisualTestContext| context.update(|window, _| window.layout_stats().frames);
    let before = frames(context);
    let result = context.update(change);
    if frames(context) == before {
        context.update(|window, cx| window.draw(cx).clear(cx));
    }
    result
}

/// The window `by` later: the clock moves on, what came due runs, and the
/// next display frame is drawn, with any callback asked for it. Returns the
/// angles a spinner was painted at.
fn after(context: &mut VisualTestContext, by: Duration) -> Vec<f32> {
    context.executor().advance_clock(by);
    context.run_until_parked();
    frame_after(context, |window, cx| window.simulate_next_frame(cx));
    take_painted_spin_angles()
}

/// What one step of a 1000 ms period turns.
const STEP_TURN: f32 = TAU * 0.033;

/// How far `to` is past `from`, going round the circle forwards.
fn turned(from: f32, to: f32) -> f32 {
    (to - from).rem_euclid(TAU)
}

fn close(left: f32, right: f32) -> bool {
    (left - right).abs() < 1e-3
}

#[gpui::test]
fn a_spinning_svg_turns_in_steps_without_reentering_js(cx: &mut TestAppContext) {
    let (runtime, mut context, view) = mounted(cx, SPINNER);
    after(&mut context, SPIN_STEP);
    let before = runtime.metrics().read();

    let mut angles = Vec::new();
    for step in 0..10 {
        let painted = after(&mut context, SPIN_STEP);
        assert_eq!(
            painted.len(),
            1,
            "step {step}: each step brings the view back once: {painted:?}"
        );
        angles.extend(painted);
    }
    for pair in angles.windows(2) {
        assert!(
            close(turned(pair[0], pair[1]), STEP_TURN),
            "33 ms of a 1000 ms period is 0.033 of a turn: {angles:?}"
        );
    }

    // Between steps nothing comes due: any 33 ms holds exactly one step,
    // however the steps fall against this clock.
    let mut between = Vec::new();
    for _ in 0..33 {
        between.extend(after(&mut context, Duration::from_millis(1)));
    }
    assert_eq!(
        between.len(),
        1,
        "the spinner is painted once a step, not on every frame: {between:?}"
    );

    let steps = runtime.metrics().read().since(&before);
    assert_eq!(
        steps.script_renders(),
        0,
        "spinner steps must not enter the VM"
    );
    assert_eq!(
        steps.materializations(),
        11,
        "each step replays the retained snapshot once"
    );

    // A render that rebuilds the description rebuilds the icon too. The turn
    // carries on from the clock rather than starting again from upright.
    let last = *between.last().unwrap();
    let stepped = after(&mut context, SPIN_STEP);
    assert_eq!(stepped.len(), 1, "{stepped:?}");
    assert!(close(turned(last, stepped[0]), STEP_TURN));
    frame_after(&mut context, |_, cx| {
        view.update(cx, |view, cx| view.refresh(cx));
    });
    let rebuilt = take_painted_spin_angles();
    assert_eq!(rebuilt.len(), 1, "{rebuilt:?}");
    assert_eq!(runtime.metrics().read().since(&before).script_renders(), 1);
    assert!(
        close(rebuilt[0], stepped[0]),
        "a spinner rebuilt within a step keeps that step's angle: {} then {}",
        stepped[0],
        rebuilt[0]
    );
}

#[gpui::test]
fn a_spinning_svg_stands_still_under_reduced_motion(cx: &mut TestAppContext) {
    cx.update(|cx| cx.set_reduce_motion(true));
    let (_runtime, mut context, _view) = mounted(cx, SPINNER);
    assert!(take_painted_spin_angles().is_empty());
    assert!(
        after(&mut context, Duration::from_millis(100)).is_empty(),
        "with reduced motion on, a spinner is drawn upright and schedules no step"
    );
}

#[gpui::test]
fn spin_on_anything_but_an_svg_schedules_no_step(cx: &mut TestAppContext) {
    let source = r##"
import { View, div } from "gpui-kit";

export default class Loading extends View {
  render() {
    return div().w(16).h(16).bg("#888888").spin(1000);
  }
}
"##;
    let (runtime, mut context, _view) = mounted(cx, source);
    assert!(take_painted_spin_angles().is_empty());
    let before = runtime.metrics().read();
    after(&mut context, Duration::from_millis(100));
    assert_eq!(
        runtime.metrics().read().since(&before).materializations(),
        0
    );
}

/// A tall feed in a 100 px scroll container, with a spinner among its rows
/// when `spinning` is set, scrolled a little on each of `frames` frames.
///
/// Returns how many frames composited the feed from a layer painted on an
/// earlier frame, and the angles the spinner was painted at while it
/// scrolled. A frame that paints the content into a layer and composites it
/// at once shows what was painted then, so it is not counted.
fn scroll_feed(cx: &mut TestAppContext, spinning: bool, frames: usize) -> (u64, Vec<f32>) {
    let spinner = if spinning {
        r#"feed = feed.child(svg("icons/spinner.svg").w(16).h(16).spin(1000));"#
    } else {
        ""
    };
    let source = format!(
        r##"
import {{ View, div, svg }} from "gpui-kit";

export default class Feed extends View {{
  render() {{
    let feed = div().id("feed").overflow_y_scroll().w(300).h(100);
    for (let i = 0; i < 2; i++) feed = feed.child(div().h(20).w_full().bg("#dddddd"));
    {spinner}
    for (let i = 0; i < 40; i++) feed = feed.child(div().h(20).w_full().bg(i % 2 ? "#eeeeee" : "#dddddd"));
    return div().size_full().bg("#ffffff").child(feed);
  }}
}}
"##
    );
    let (_runtime, mut context, _view) = mounted(cx, &source);
    context.update(|window, _| window.set_scroll_layers(true));
    frame_after(&mut context, |_, _| ());
    context.update(|window, _| window.reset_layout_stats());
    take_painted_spin_angles();

    // The wheel and the frame callbacks in one frame, as on a display: a
    // scroll layer is only promoted after scrolling on consecutive frames.
    for _ in 0..frames {
        context.executor().advance_clock(Duration::from_millis(16));
        context.run_until_parked();
        frame_after(&mut context, |window, cx| {
            window.dispatch_event(
                PlatformInput::ScrollWheel(ScrollWheelEvent {
                    position: point(px(20.), px(20.)),
                    delta: ScrollDelta::Pixels(point(px(0.), px(-2.))),
                    modifiers: Default::default(),
                    touch_phase: TouchPhase::Moved,
                }),
                cx,
            );
            window.simulate_next_frame(cx);
        });
    }
    let stats = context.update(|window, _| window.layout_stats());
    let composited = stats
        .layer_frames_composited
        .saturating_sub(stats.layer_frames_repainted);
    (composited, take_painted_spin_angles())
}

/// GPUI-fast composites a scrolled container from a cached layer once it has
/// scrolled for a few frames. A layer holds the pixels its content was
/// painted with, so a spinner composited from one would stand still. This
/// checks the outcome: across frames 16 ms apart, the spinner is painted on
/// every step that comes due, each one 0.033 of a turn on from the last, so
/// no step is left showing an angle a layer kept from earlier.
#[gpui::test]
fn a_spinner_in_a_scroll_container_keeps_turning_under_scroll_layers(cx: &mut TestAppContext) {
    // Scroll layers are compiled in on these platforms only; elsewhere every
    // frame is painted and there is nothing to keep the spinner out of.
    if !cfg!(any(
        target_os = "linux",
        target_os = "macos",
        target_os = "windows"
    )) {
        return;
    }
    let frames = 24;

    let (composited, _) = scroll_feed(cx, false, frames);
    assert!(
        composited > 0,
        "without a spinner, the scrolled feed is composited from its layer, which is \
         what makes the other half of this test mean something"
    );

    let (_, angles) = scroll_feed(cx, true, frames);
    let mut steps = angles.clone();
    steps.dedup_by(|later, earlier| close(*later, *earlier));
    // 24 frames of 16 ms hold 11 or 12 steps.
    assert!(
        steps.len() >= 11,
        "the spinner is painted on every step: {angles:?}"
    );
    for pair in steps.windows(2) {
        assert!(
            close(turned(pair[0], pair[1]), STEP_TURN),
            "each step is painted, none skipped behind a layer: {angles:?}"
        );
    }
}

/// Renders `source` once and returns the description, or the message it
/// failed with.
fn render(cx: &mut TestAppContext, source: &str) -> Result<String, String> {
    cx.update(crate::init);
    let runtime = ShellRuntime::new_isolated().expect("runtime");
    cx.update(|cx| runtime.set_global(cx));
    let view_type = runtime.load_source("spin.js", source).expect("load");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let object = context
        .update(|window, cx| runtime.instantiate(&view_type, window, cx))
        .expect("instantiate");
    context
        .update(|window, cx| runtime.render_to_spec(&object, None, window, cx))
        .map_err(|error| error.to_string())
}

fn spin_source(argument: &str) -> String {
    format!(
        r#"
import {{ View, svg }} from "gpui-kit";
export default class Loading extends View {{
  render() {{ return svg("icons/spinner.svg").spin({argument}); }}
}}
"#
    )
}

#[gpui::test]
fn spin_records_its_period(cx: &mut TestAppContext) {
    let tree = render(cx, &spin_source("750")).expect("render");
    assert!(tree.contains(":spin(750ms)"), "{tree}");
}

#[gpui::test]
fn spin_refuses_a_period_that_is_not_a_positive_duration(cx: &mut TestAppContext) {
    for argument in [
        "0",
        "-1",
        "\"1000\"",
        "NaN",
        "Infinity",
        "undefined",
        "86400001",
    ] {
        let message = render(cx, &spin_source(argument)).expect_err(argument);
        assert!(
            message.contains("spin period_ms must"),
            "{argument}: {message}"
        );
    }
}

struct Empty;

impl gpui::Render for Empty {
    fn render(
        &mut self,
        _: &mut gpui::Window,
        _: &mut gpui::Context<Self>,
    ) -> impl gpui::IntoElement {
        gpui::div()
    }
}
