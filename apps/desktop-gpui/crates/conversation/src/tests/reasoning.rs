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

//! Reasoning: `thinking` deltas and durable rows render as a collapsed row of
//! their own, never inside the reply's text.

use super::*;

use crate::rows::ThinkingRow;
use crate::thinking_face::{FacePose, LOOP_SECS, pose_at};

fn thinking_delta(
    frames: &mut Frames,
    message: &str,
    start: u64,
    text: &str,
    complete: bool,
) -> PushFrame {
    let mut delta = json!({
        "kind": "thinking", "turnId": TURN, "runId": RUN, "messageId": message,
        "startOffset": start, "text": text
    });
    if complete {
        delta["complete"] = json!(true);
    }
    frames.next("subscription.session_delta", json!({"sessionId": SESSION, "delta": delta}))
}

fn thinking_row(harness: &Harness, cx: &mut TestAppContext) -> ThinkingRow {
    harness
        .rows(cx)
        .into_iter()
        .find_map(|row| match row {
            RowBody::Thinking(thinking) => Some(thinking),
            _ => None,
        })
        .expect("a reasoning row")
}

fn reasoning_id() -> ElementId {
    item_element_id(TURN, &ItemKey::Thinking("m1".into()))
}

#[gpui_kit::test]
fn reasoning_is_a_collapsed_row_that_expands_to_its_text(cx: &mut TestAppContext) {
    let (harness, mut frames) = start_turn(cx);
    harness.push(thinking_delta(&mut frames, "m1", 0, "First, list the files.\nThen", false), cx);
    harness.push(frames.delta("m1", 0, "Here they are."), cx);
    settle(cx);
    let row = thinking_row(&harness, cx);
    assert!(row.streaming && !row.expanded);
    assert_eq!((row.preview.clone(), row.text.clone()), (None, None));
    let keys: Vec<String> = harness.state.read_with(cx, |state, _| {
        let turn = state.transcript().expect("transcript").turn(TURN).expect("turn").clone();
        turn.items.iter().map(|item| item.key().to_string()).collect()
    });
    assert_eq!(keys, ["user:t1", "thinking:m1", "text:m1"], "reasoning comes first, apart");
    harness.with_window(cx, |window, _| {
        let toggle = window.within(reasoning_id()).find("thinking-toggle");
        assert_eq!(
            toggle.label(),
            Some(
                format!("{}. {}", copy::THINKING_STREAMING.en(), copy::SHOW_REASONING.en())
                    .as_str()
            )
        );
        assert!(window.within(reasoning_id()).try_find("thinking-text").is_none());
    });

    // Complete: the label settles and the first line follows it.
    harness.push(thinking_delta(&mut frames, "m1", 27, " report.", true), cx);
    settle(cx);
    let row = thinking_row(&harness, cx);
    assert!(!row.streaming);
    assert_eq!(row.preview.as_deref(), Some("First, list the files. …"));

    // The keyboard expands it: Tab to the row, Enter.
    harness.with_window(cx, |window, cx| {
        tab_to(window, reasoning_id(), "thinking-toggle", cx);
        press_and_release(window, "enter", cx);
    });
    settle(cx);
    let row = thinking_row(&harness, cx);
    assert!(row.expanded);
    assert_eq!(row.text.as_deref(), Some("First, list the files.\nThen report."));
    harness.with_window(cx, |window, _| {
        let text = window.within(reasoning_id()).find("thinking-text");
        assert_eq!(text.label(), Some("First, list the files.\nThen report."));
    });
    // The reply's text never holds the reasoning.
    assert!(harness.rows(cx).iter().any(|row| matches!(
        row, RowBody::Text { text, .. } if text.as_ref() == "Here they are."
    )));
}

/// The reasoning row draws the thinking face in its 16 px icon slot. The
/// face thinks, on the spinner's clock, only while the reasoning streams
/// and motion is allowed; with reduced motion, and once the reasoning
/// ends, it rests.
#[gpui_kit::test]
fn the_thinking_face_thinks_only_while_the_reasoning_streams(cx: &mut TestAppContext) {
    cx.update(|cx| cx.set_reduce_motion(false));
    let (harness, mut frames) = start_turn(cx);
    harness.push(thinking_delta(&mut frames, "m1", 0, "Weighing the files", false), cx);
    settle(cx);
    harness.with_window(cx, |window, _| {
        let face = window.within(reasoning_id()).find("thinking-face");
        assert!(face.visible());
        assert_eq!(face.bounds().size, size(px(16.), px(16.)), "the icon slot");
    });
    let key = format!("{TURN}/thinking:m1");
    let drawn = |cx: &mut TestAppContext| {
        harness.view.read_with(cx, |view, cx| view.thinking_face_secs(&key, cx)).expect("the row")
    };

    // On to the middle of the held moved pose, 0.43 to 0.65 of the loop.
    let middle = 0.54 * LOOP_SECS;
    let wait = (middle - drawn(cx)).rem_euclid(LOOP_SECS);
    cx.executor().advance_clock(Duration::from_secs_f32(wait));
    cx.run_until_parked();
    let secs = drawn(cx);
    assert!((secs - middle).abs() < 0.1, "{secs} s into the loop, not {middle} s");
    assert_eq!(pose_at(secs), FacePose::MOVED);

    cx.update(|cx| cx.set_reduce_motion(true));
    assert_eq!(drawn(cx), 0., "at rest with reduced motion");
    cx.update(|cx| cx.set_reduce_motion(false));

    harness.push(thinking_delta(&mut frames, "m1", 18, "", true), cx);
    settle(cx);
    assert_eq!(drawn(cx), 0., "at rest once the reasoning ends");
    cx.executor().advance_clock(Duration::from_millis(500));
    cx.run_until_parked();
    assert_eq!(drawn(cx), 0., "and still at rest");
    harness.with_window(cx, |window, _| {
        assert!(window.within(reasoning_id()).find("thinking-face").visible(), "the same face");
    });
}
