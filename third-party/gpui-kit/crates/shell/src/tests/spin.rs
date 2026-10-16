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
//! The cost is the point. A spinner asks for a frame on every paint, and a
//! frame that entered the VM would make every loading indicator a script
//! render at the display's refresh rate. These tests count script renders
//! across native frames, read the angle each frame was painted at, and check
//! that a spinner inside a scroll container is not frozen inside a cached
//! scroll layer.

use std::{f32::consts::TAU, ops::Deref as _, rc::Rc, time::Duration};

use gpui::{
    App, AppContext as _, Entity, PlatformInput, ScrollDelta, ScrollWheelEvent, TestAppContext,
    TouchPhase, VisualTestContext, Window, point, px,
};

use crate::{ScriptView, ShellRuntime, materialize::take_painted_spin_angles};

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
/// every view from scratch, which would hide whether the spinner's own frame
/// request is what brings its view back.
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

/// One native frame `step` after the last: the frame callbacks run, then the
/// window is drawn. Returns how many callbacks ran.
fn next_frame(context: &mut VisualTestContext, step: Duration) -> usize {
    context.executor().advance_clock(step);
    frame_after(context, |window, cx| window.simulate_next_frame(cx))
}

/// How far `to` is past `from`, going round the circle forwards.
fn turned(from: f32, to: f32) -> f32 {
    (to - from).rem_euclid(TAU)
}

fn close(left: f32, right: f32) -> bool {
    (left - right).abs() < 1e-3
}

#[gpui::test]
fn a_spinning_svg_turns_on_native_frames_without_reentering_js(cx: &mut TestAppContext) {
    let (runtime, mut context, view) = mounted(cx, SPINNER);
    // A tenth of the period per frame.
    let step = Duration::from_millis(100);
    // Mounting drew more than once before any frame callback ran, so the
    // first frame runs one callback per draw. From here on, one frame is one
    // draw.
    next_frame(&mut context, step);
    take_painted_spin_angles();
    let before = runtime.metrics().read();

    let mut angles = Vec::new();
    for frame in 0..10 {
        assert_eq!(
            next_frame(&mut context, step),
            1,
            "frame {frame}: each painted spinner asks for exactly the next frame"
        );
        angles.extend(take_painted_spin_angles());
    }
    assert_eq!(angles.len(), 10, "every frame paints the spinner again");
    for pair in angles.windows(2) {
        assert!(
            close(turned(pair[0], pair[1]), TAU / 10.),
            "100 ms of a 1000 ms period is a tenth of a turn: {angles:?}"
        );
    }

    let frames = runtime.metrics().read().since(&before);
    assert_eq!(
        frames.script_renders(),
        0,
        "ten spinner frames must not enter the VM"
    );
    assert_eq!(
        frames.materializations(),
        10,
        "each spinner frame replays the retained snapshot once"
    );

    // A render that rebuilds the description rebuilds the icon too. The turn
    // carries on from the clock rather than starting again from upright.
    context.executor().advance_clock(step);
    frame_after(&mut context, |window, cx| {
        window.simulate_next_frame(cx);
        view.update(cx, |view, cx| view.refresh(cx));
    });
    let rebuilt = take_painted_spin_angles();
    assert_eq!(rebuilt.len(), 1);
    assert_eq!(runtime.metrics().read().since(&before).script_renders(), 1);
    assert!(
        close(turned(*angles.last().unwrap(), rebuilt[0]), TAU / 10.),
        "a rebuilt spinner continues the same rotation: {} then {}",
        angles.last().unwrap(),
        rebuilt[0]
    );
}

#[gpui::test]
fn a_spinning_svg_stands_still_under_reduced_motion(cx: &mut TestAppContext) {
    cx.update(|cx| cx.set_reduce_motion(true));
    let (_runtime, mut context, _view) = mounted(cx, SPINNER);
    assert!(take_painted_spin_angles().is_empty());
    assert_eq!(
        next_frame(&mut context, Duration::from_millis(100)),
        0,
        "with reduced motion on, a spinner is drawn upright and asks for no frame"
    );
}

#[gpui::test]
fn spin_on_anything_but_an_svg_asks_for_no_frame(cx: &mut TestAppContext) {
    let source = r##"
import { View, div } from "gpui-kit";

export default class Loading extends View {
  render() {
    return div().w(16).h(16).bg("#888888").spin(1000);
  }
}
"##;
    let (_runtime, mut context, _view) = mounted(cx, source);
    assert!(take_painted_spin_angles().is_empty());
    assert_eq!(next_frame(&mut context, Duration::from_millis(100)), 0);
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
/// checks the outcome — the spinner is painted, at a new angle, on every
/// scrolled frame, and no frame shows a layer painted earlier — rather than
/// which of the two reasons in `materialize::components::spin` kept it off.
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
    let frames = 12;

    let (composited, _) = scroll_feed(cx, false, frames);
    assert!(
        composited > 0,
        "without a spinner, the scrolled feed is composited from its layer, which is \
         what makes the other half of this test mean something"
    );

    let (composited, angles) = scroll_feed(cx, true, frames);
    assert_eq!(
        composited, 0,
        "a container whose content is spinning must be painted on every frame, never \
         composited from what an earlier frame painted"
    );
    assert_eq!(
        angles.len(),
        frames,
        "the spinner is painted on every scrolled frame"
    );
    for pair in angles.windows(2) {
        assert!(
            turned(pair[0], pair[1]) > 0.,
            "the spinner turns on every scrolled frame: {angles:?}"
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
