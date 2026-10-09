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

//! The live running turn's status line: a working phrase that changes every
//! 20 seconds, a clock that counts from the prompt's send, and a redraw
//! timer that runs only while the line has a clock. Time is the test
//! executor's fake clock.

use std::cell::Cell;
use std::rc::Rc;

use shared::copy::Locale;

use super::*;

/// When the prompt was sent, in Host wall-clock milliseconds.
const SENT_AT: u64 = 1_790_000_000_000;

/// Opens the synthetic session and runs its turn with the prompt sent at
/// [`SENT_AT`], which is when the view's wall clock reads as the turn
/// starts; the clock moves with the test executor's.
fn start_timed_turn(cx: &mut TestAppContext) -> (Harness, Frames) {
    let transport = Arc::new(ScriptedHost::default());
    transport.reply("subscription.open", Ok(open_result(SUBSCRIPTION)));
    let harness = Harness::open(transport, EPOCH, cx);
    harness.select(SESSION, cx);
    let origin = cx.executor().now();
    harness.view.update(cx, |view, _| {
        view.set_wall_clock(move |cx| {
            let elapsed = cx.background_executor().now().duration_since(origin);
            SENT_AT + elapsed.as_millis() as u64
        });
    });
    let frames = run_turn_sent_at(&harness, Frames::new(), SENT_AT, cx);
    (harness, frames)
}

/// The running line's words: its label and what follows it.
fn running_line(harness: &Harness, cx: &mut TestAppContext) -> (Option<String>, Option<String>) {
    harness.with_window(cx, |window, _| {
        let footer = window.within(footer_element_id(TURN));
        let part = |id: &'static str| footer.try_find(id)?.label().map(str::to_owned);
        (part("turn-status-label"), part("turn-status-detail"))
    })
}

fn line(label: &str, detail: &str) -> (Option<String>, Option<String>) {
    (Some(label.to_owned()), Some(detail.to_owned()))
}

fn wait(seconds: u64, cx: &mut TestAppContext) {
    cx.executor().advance_clock(Duration::from_secs(seconds));
    cx.run_until_parked();
}

fn clock_ticks(harness: &Harness, cx: &mut TestAppContext) -> bool {
    harness.view.read_with(cx, |view, _| view.clock_ticks())
}

#[gpui_kit::test]
fn the_clock_counts_from_the_prompt_s_send(cx: &mut TestAppContext) {
    let (harness, _) = start_timed_turn(cx);
    assert_eq!(running_line(&harness, cx), line("Pondering…", "0s"));
    wait(59, cx);
    assert_eq!(running_line(&harness, cx), line("Untangling…", "59s"));
    wait(6, cx);
    assert_eq!(running_line(&harness, cx), line("Digging in…", "1m 5s"));
    assert_eq!(
        footer_label(&harness, TURN, cx).as_deref(),
        Some(copy::TURN_RUNNING.en()),
        "the clock is not part of the line's name, so it is never announced"
    );

    cx.update(|cx| cx.set_global(Locale::SimplifiedChinese));
    cx.run_until_parked();
    assert_eq!(running_line(&harness, cx), line("正在钻研…", "1 分 5 秒"));
    assert_eq!(footer_label(&harness, TURN, cx).as_deref(), Some("正在处理…"));
}

#[gpui_kit::test]
fn the_working_phrase_changes_every_twenty_seconds(cx: &mut TestAppContext) {
    let (harness, _) = start_timed_turn(cx);
    wait(19, cx);
    assert_eq!(running_line(&harness, cx), line("Pondering…", "19s"));
    wait(1, cx);
    assert_eq!(running_line(&harness, cx), line("Tinkering…", "20s"));
}

#[gpui_kit::test]
fn reduced_motion_keeps_the_first_phrase_and_still_counts(cx: &mut TestAppContext) {
    cx.update(|cx| cx.set_reduce_motion(true));
    let (harness, _) = start_timed_turn(cx);
    let redraws = Rc::new(Cell::new(0));
    let _observer = cx.update(|cx| {
        let redraws = redraws.clone();
        cx.observe(&harness.view, move |_, _| redraws.set(redraws.get() + 1))
    });
    wait(20, cx);
    assert_eq!(running_line(&harness, cx), line("Pondering…", "20s"));
    assert_eq!(redraws.get(), 20, "with no spinner, the clock redraws once a second");
}

#[gpui_kit::test]
fn the_clock_stops_when_the_line_goes_away(cx: &mut TestAppContext) {
    let (harness, mut frames) = start_timed_turn(cx);
    assert!(clock_ticks(&harness, cx));

    // A prompt owns the next step; the line goes, and its clock with it.
    let pending = interaction(permission_request(), "pending", Value::Null);
    harness.push(frames.projection(root("waiting_for_user"), vec![pending]), cx);
    settle(cx);
    assert!(!clock_ticks(&harness, cx));
    harness.push(frames.projection(root("running"), vec![]), cx);
    settle(cx);
    assert!(clock_ticks(&harness, cx));

    harness.push(frames.projection(root("completed"), vec![]), cx);
    settle(cx);
    assert!(!clock_ticks(&harness, cx), "no timer once nothing runs");
    assert_eq!(running_line(&harness, cx), (None, None));
    assert_eq!(footer_outcome(&harness, TURN, cx).as_deref(), Some(copy::TURN_FINISHED.en()));
}

/// The running root while the Runtime retries a provider request.
fn retrying(retry: Value) -> Value {
    let mut root = root("running");
    root["providerRetry"] = retry;
    root
}

#[gpui_kit::test]
fn a_provider_retry_shows_why_and_when_then_gives_way_to_the_answer(cx: &mut TestAppContext) {
    let (harness, mut frames) = start_timed_turn(cx);
    wait(50, cx);

    // A 4 s wait that began a second before the Host reported it.
    let now = harness.view.read_with(cx, |view, cx| view.wall_now(cx));
    let scheduled = json!({"phase": "scheduled", "attempt": 2, "maxAttempts": 5,
                           "delayMs": 4000, "reason": "rate_limit", "ts": now - 1000});
    harness.push(frames.projection(retrying(scheduled), vec![]), cx);
    assert_eq!(
        running_line(&harness, cx),
        line("Model rate limit reached", "Retrying in 3s (2/5)")
    );
    let waiting = "Model rate limit reached · Waiting to retry (2/5)";
    assert_eq!(footer_label(&harness, TURN, cx).as_deref(), Some(waiting));
    wait(1, cx);
    assert_eq!(running_line(&harness, cx).1.as_deref(), Some("Retrying in 2s (2/5)"));
    assert_eq!(footer_label(&harness, TURN, cx).as_deref(), Some(waiting), "never announced");
    wait(2, cx);
    assert_eq!(running_line(&harness, cx).1.as_deref(), Some("Retrying in 1s (2/5)"));
    assert!(!clock_ticks(&harness, cx), "a countdown that ran out stops its timer");

    let started = json!({"phase": "started", "attempt": 2, "maxAttempts": 5,
                         "reason": "rate_limit"});
    harness.push(frames.projection(retrying(started), vec![]), cx);
    assert_eq!(running_line(&harness, cx), line("Model rate limit reached", "Retrying (2/5)"));
    assert!(!clock_ticks(&harness, cx), "nothing on the line moves");

    // The attempt answers: the Host clears the retry, and the line is the
    // working one again, its clock still counting from the send.
    harness.push(frames.projection(root("running"), vec![]), cx);
    harness.push(frames.delta("m1", 0, "Hello"), cx);
    settle(cx);
    assert_eq!(running_line(&harness, cx), line("Untangling…", "53s"));
    assert!(clock_ticks(&harness, cx));
    assert_eq!(footer_label(&harness, TURN, cx).as_deref(), Some(copy::TURN_RUNNING.en()));
}
