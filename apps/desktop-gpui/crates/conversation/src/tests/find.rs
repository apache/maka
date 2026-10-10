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

//! Find in the conversation: the transcript is the find bar's item. Every
//! held row counts, laid out or not; activating a match opens its row and
//! brings it into view; the rest of the history is read while the bar
//! shows.

use std::ops::Range;

use gpui_kit::{Focusable as _, Hsla};
use search::REFRESH_DELAY;
use shared::theme::ActiveMakaPalette as _;

use super::*;
use crate::BACKGROUND_PAGE_BYTES;
use crate::OlderHistory;
use crate::corpus::Field;

/// The rows of a settled turn `turn` starting at sequence `first`: the
/// prompt `ask`, a Bash call whose output is `output` when given, a reply
/// `reply`, and its end.
pub(super) fn turn(
    turn: &str,
    first: u64,
    ask: &str,
    output: Option<&str>,
    reply: &str,
) -> Vec<(u64, Value)> {
    let mut rows = vec![(
        first,
        json!({"type": "user", "id": turn, "turnId": turn, "ts": first, "text": ask}),
    )];
    if let Some(output) = output {
        let call = format!("{turn}-c1");
        rows.push((
            first + 1,
            json!({"type": "tool_call", "id": call, "turnId": turn, "ts": first + 1,
                   "toolName": "Bash", "args": {"command": "cat notes.txt"},
                   "stepId": format!("{turn}-a")}),
        ));
        rows.push((
            first + 2,
            json!({"type": "tool_result", "id": format!("{call}-r"), "turnId": turn,
                   "ts": first + 2, "toolUseId": call, "isError": false,
                   "content": {"kind": "text", "text": output}}),
        ));
    }
    rows.push((
        first + 3,
        json!({"type": "assistant", "id": format!("{turn}-a"), "turnId": turn, "ts": first + 3,
               "text": reply, "contentOrder": ["tools", "text"], "modelId": "m"}),
    ));
    rows.push((
        first + 4,
        json!({"type": "turn_state", "id": format!("{turn}-end"), "turnId": turn,
               "ts": first + 4, "status": "completed"}),
    ));
    rows
}

/// A page of `rows` (newest first on the wire) through watermark 99, with
/// older history behind `next` when given.
pub(super) fn page_of(rows: &[(u64, Value)], next: Option<&str>) -> Value {
    let mut raw = 0;
    let fragments: Vec<Value> = rows
        .iter()
        .rev()
        .map(|(sequence, row)| {
            let bytes = serde_json::to_vec(row).expect("row");
            raw += bytes.len();
            json!({
                "sequence": sequence, "byteOffset": 0, "totalBytes": bytes.len(),
                "payloadDigest": null,
                "data": base64::engine::general_purpose::STANDARD.encode(&bytes)
            })
        })
        .collect();
    json!({
        "kind": "page", "sessionId": SESSION, "direction": "older", "throughSequence": 99,
        "rawBytes": raw, "fragments": fragments, "nextCursor": next, "endsAtTurnBoundary": true
    })
}

/// A reply of `paragraphs` paragraphs, taller than the window.
fn long_text(paragraphs: usize) -> String {
    (1..=paragraphs).map(|n| format!("Paragraph {n} of a long reply.\n\n")).collect()
}

const NEEDLE_REPLY: &str = "The **needle** is in [the docs](https://example.com/needle).";

/// Turn `t1` with a needle in its prompt, its Bash output and its reply;
/// turn `t2` with a long reply, so `t1` is far above the window.
fn needle_rows() -> Vec<(u64, Value)> {
    let mut rows =
        turn("t1", 1, "Where is the needle?", Some("a needle in the output"), NEEDLE_REPLY);
    rows.extend(turn("t2", 10, "Again", None, &long_text(120)));
    rows
}

/// The session open with `tail` as its transcript tail.
pub(super) fn open_tail(tail: Value, with_composer: bool, cx: &mut TestAppContext) -> Harness {
    let mut open = open_result(SUBSCRIPTION);
    open["transcript"]["durable"] = tail;
    let transport = Arc::new(ScriptedHost::default());
    transport.reply("subscription.open", Ok(open));
    let harness = if with_composer {
        Harness::open_with_composer(transport, EPOCH, cx)
    } else {
        Harness::open(transport, EPOCH, cx)
    };
    harness.select(SESSION, cx);
    harness.with_window(cx, |_, _| {});
    settle(cx);
    harness
}

fn open_find(harness: &Harness, cx: &mut TestAppContext) {
    harness.with_window(cx, |window, cx| {
        harness.view.update(cx, |view, cx| view.open_find(window, cx));
    });
    settle(cx);
}

/// Types `query` into the bar (replacing what is selected) and lets the
/// search finish.
fn find(harness: &Harness, query: &str, cx: &mut TestAppContext) {
    harness.with_window(cx, |window, cx| window.input(query, cx));
    settle(cx);
    harness.with_window(cx, |_, _| {});
    settle(cx);
}

fn press(harness: &Harness, key: &str, cx: &mut TestAppContext) {
    harness.with_window(cx, |window, cx| window.press(key, cx));
    settle(cx);
    harness.with_window(cx, |_, _| {});
    settle(cx);
}

fn label_of(harness: &Harness, id: &'static str, cx: &mut TestAppContext) -> Option<String> {
    harness.with_window(cx, |window, _| {
        window.try_find(id).and_then(|element| element.label().map(str::to_owned))
    })
}

fn count(harness: &Harness, cx: &mut TestAppContext) -> Option<String> {
    label_of(harness, "find-count", cx)
}

fn item(turn: &str, key: ItemKey) -> RowKey {
    RowKey::Item { turn_id: turn.into(), key }
}

pub(super) fn reply(turn: &str) -> RowKey {
    item(turn, ItemKey::Text(format!("{turn}-a")))
}

fn active(harness: &Harness, cx: &mut TestAppContext) -> Option<TranscriptMatchView> {
    harness.view.read_with(cx, |view, cx| {
        let bar = view.find_bar()?.read(cx);
        let found = bar.matches().get(bar.active_match_index()?)?;
        Some(TranscriptMatchView {
            row: (*found.row).clone(),
            field: found.field,
            range: found.range.clone(),
        })
    })
}

/// A match, as the tests compare it.
#[derive(Debug, Clone, PartialEq)]
struct TranscriptMatchView {
    row: RowKey,
    field: Field,
    range: Range<usize>,
}

fn fills(cx: &mut TestAppContext) -> (Hsla, Hsla) {
    cx.update(|cx| {
        let maka = cx.maka();
        (maka.find_match, maka.find_match_active)
    })
}

fn page_reads(harness: &Harness) -> Vec<Value> {
    harness.transport.requests("session.transcript.page")
}

#[gpui_kit::test]
fn a_match_far_above_the_window_counts_and_shows_painted_once_activated(cx: &mut TestAppContext) {
    let harness = open_tail(page_of(&needle_rows(), None), false, cx);
    let t1_reply = reply("t1");
    let reply_id = item_element_id("t1", &ItemKey::Text("t1-a".into()));
    harness.with_window(cx, |window, _| {
        assert!(window.try_find(reply_id.clone()).is_none(), "t1 is not laid out");
    });
    assert!(harness.view.read_with(cx, |view, _| view.text_views().get(&t1_reply).is_none()));
    assert_eq!(
        harness.view.read_with(cx, |view, _| view.text_views().len()),
        1,
        "only the reply laid out holds a text view state"
    );

    open_find(&harness, cx);
    find(&harness, "needle", cx);
    // The prompt, the collapsed Bash output and the reply; not the link's
    // target. The nearest to the window is the last of them.
    assert_eq!(count(&harness, cx).as_deref(), Some("3/3"));
    assert_eq!(
        active(&harness, cx),
        Some(TranscriptMatchView { row: t1_reply.clone(), field: Field::Body, range: 6..12 }),
        "a range of the reply's source: `needle` inside `**needle**`"
    );
    harness.with_window(cx, |window, _| {
        assert!(window.find(reply_id.clone()).visible(), "the list scrolled to the reply");
    });
    let (_, active_fill) = fills(cx);
    let highlights = harness.view.read_with(cx, |view, _| view.text_views().highlights(&t1_reply));
    // "The needle is in the docs.": the needle, in the active fill.
    assert_eq!(highlights, [(4..10, active_fill)]);
    assert_eq!(harness.view.read_with(cx, |view, _| view.pending_reveal()), None, "revealed");
}

#[gpui_kit::test]
fn a_match_in_a_collapsed_tool_output_opens_its_card(cx: &mut TestAppContext) {
    let harness = open_tail(page_of(&needle_rows(), None), false, cx);
    open_find(&harness, cx);
    find(&harness, "needle", cx);
    let tool = item("t1", ItemKey::Tool("t1-c1".into()));
    let expanded = |harness: &Harness, cx: &mut TestAppContext| {
        harness.rows(cx).into_iter().find_map(|row| match row {
            RowBody::Tool(tool) => Some(tool.expanded),
            _ => None,
        })
    };
    assert_eq!(expanded(&harness, cx), Some(false), "collapsed until its match is active");
    // 3/3, then on past the end to the prompt, then the output.
    press(&harness, "enter", cx);
    assert_eq!(count(&harness, cx).as_deref(), Some("1/3"));
    assert_eq!(active(&harness, cx).map(|found| found.field), Some(Field::Body));
    press(&harness, "enter", cx);
    assert_eq!(count(&harness, cx).as_deref(), Some("2/3"));
    assert_eq!(
        active(&harness, cx),
        Some(TranscriptMatchView { row: tool.clone(), field: Field::ToolDetail, range: 2..8 })
    );
    assert_eq!(expanded(&harness, cx), Some(true), "its card opened");
    let tool_id = item_element_id("t1", &ItemKey::Tool("t1-c1".into()));
    harness.with_window(cx, |window, _| {
        assert!(window.within(tool_id.clone()).find("tool-output").visible());
    });
    let marks = harness.view.read_with(cx, |view, _| view.find_marks(&tool));
    assert_eq!(marks.len(), 1);
    assert!(marks[0].active && marks[0].field == Field::ToolDetail);
    // Shift-Enter goes back to the prompt, which paints its match.
    press(&harness, "shift-enter", cx);
    assert_eq!(count(&harness, cx).as_deref(), Some("1/3"));
    let prompt = harness
        .view
        .read_with(cx, |view, _| view.find_marks(&item("t1", ItemKey::User("t1".into()))));
    assert!(prompt.iter().any(|mark| mark.active && mark.range == (13..19)));
}

#[gpui_kit::test]
fn markup_and_link_targets_do_not_match(cx: &mut TestAppContext) {
    let harness = open_tail(page_of(&needle_rows(), None), false, cx);
    open_find(&harness, cx);
    find(&harness, "**", cx);
    assert_eq!(count(&harness, cx).as_deref(), Some(shared::copy::search::NO_RESULTS.en()));
    press(&harness, "cmd-a", cx);
    find(&harness, "example.com", cx);
    assert_eq!(count(&harness, cx).as_deref(), Some(shared::copy::search::NO_RESULTS.en()));
    press(&harness, "cmd-a", cx);
    find(&harness, "the docs", cx);
    assert_eq!(count(&harness, cx).as_deref(), Some("1/1"), "the link's visible text does");
}

#[gpui_kit::test]
fn match_case_and_whole_word_hold_beside_chinese(cx: &mut TestAppContext) {
    let rows =
        turn("t1", 1, "Run the TEST", None, "运行测试通过。测试 结果：test passed, retesting.");
    let harness = open_tail(page_of(&rows, None), false, cx);
    open_find(&harness, cx);
    find(&harness, "测试", cx);
    assert_eq!(count(&harness, cx).as_deref(), Some("1/2"));
    harness.with_window(cx, |window, cx| window.click("find-whole-word", cx));
    settle(cx);
    assert_eq!(count(&harness, cx).as_deref(), Some("1/2"), "each Chinese character is a word");
    open_find(&harness, cx);
    find(&harness, "test", cx);
    assert_eq!(count(&harness, cx).as_deref(), Some("1/2"), "TEST and test, not retesting");
    harness.with_window(cx, |window, cx| window.click("find-whole-word", cx));
    settle(cx);
    assert_eq!(count(&harness, cx).as_deref(), Some("1/3"));
    harness.with_window(cx, |window, cx| window.click("find-match-case", cx));
    settle(cx);
    assert_eq!(count(&harness, cx).as_deref(), Some("1/2"), "test and retesting");
}

#[gpui_kit::test]
fn command_g_moves_from_the_transcript_and_escape_closes_and_returns_focus(
    cx: &mut TestAppContext,
) {
    let harness = open_tail(page_of(&needle_rows(), None), true, cx);
    // Focus is in the composer when ⌘F opens the bar.
    let draft =
        harness.composer().read_with(cx, |composer, cx| composer.draft().read(cx).focus_handle(cx));
    harness.with_window(cx, |window, cx| draft.focus(window, cx));
    open_find(&harness, cx);
    find(&harness, "needle", cx);
    assert_eq!(count(&harness, cx).as_deref(), Some("3/3"));
    press(&harness, "cmd-g", cx);
    assert_eq!(count(&harness, cx).as_deref(), Some("1/3"));
    press(&harness, "cmd-shift-g", cx);
    assert_eq!(count(&harness, cx).as_deref(), Some("3/3"));

    // From the transcript.
    let transcript = harness.view.read_with(cx, |view, cx| view.focus_handle(cx));
    harness.with_window(cx, |window, cx| transcript.focus(window, cx));
    press(&harness, "cmd-g", cx);
    assert_eq!(count(&harness, cx).as_deref(), Some("1/3"));
    press(&harness, "cmd-shift-g", cx);
    assert_eq!(count(&harness, cx).as_deref(), Some("3/3"));

    // Escape in the bar: closed, nothing painted, focus back where it was.
    let bar = harness.view.read_with(cx, |view, _| view.find_bar().cloned()).expect("bar");
    let query = bar.read_with(cx, |bar, _| bar.query().clone());
    harness.with_window(cx, |window, cx| query.update(cx, |query, cx| query.focus(window, cx)));
    press(&harness, "escape", cx);
    assert!(!harness.view.read_with(cx, |view, _| view.is_find_open()));
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("find-bar").is_none(), "the bar is gone");
        assert!(draft.is_focused(window), "focus is back in the composer");
    });
    assert!(harness.view.read_with(cx, |view, _| view.find_marks(&reply("t1")).is_empty()));
    let highlights =
        harness.view.read_with(cx, |view, _| view.text_views().highlights(&reply("t1")));
    assert!(highlights.is_empty(), "{highlights:?}");
    // ⌘G with the bar closed does nothing here.
    press(&harness, "cmd-g", cx);
    assert!(!harness.view.read_with(cx, |view, _| view.is_find_open()));
}

#[gpui_kit::test]
fn a_live_turn_s_new_text_adds_a_match_without_moving_the_active_one(cx: &mut TestAppContext) {
    let (harness, mut frames) = start_turn(cx);
    harness.push(frames.delta("m1", 0, "A needle first."), cx);
    settle(cx);
    open_find(&harness, cx);
    find(&harness, "needle", cx);
    assert_eq!(count(&harness, cx).as_deref(), Some("1/1"));
    let first = active(&harness, cx);
    harness.push(frames.delta("m1", 15, " Then another needle."), cx);
    settle(cx);
    cx.executor().advance_clock(REFRESH_DELAY);
    settle(cx);
    assert_eq!(count(&harness, cx).as_deref(), Some("1/2"), "the new match joins");
    assert_eq!(active(&harness, cx), first, "the active match stays");
}

/// A session whose tail holds turn `t3` (a long reply with one needle),
/// and older history behind cursor `c1`: `t1` and `t2`, a needle each.
fn needle_history(running: bool, cx: &mut TestAppContext) -> Harness {
    let mut tail = turn("t3", 30, "Third", None, &format!("A needle late.\n\n{}", long_text(120)));
    if running {
        // Its end is not written yet.
        tail.pop();
    }
    let mut open = open_result(SUBSCRIPTION);
    open["transcript"]["durable"] = page_of(&tail, Some("c1"));
    if running {
        open["snapshot"]["rootTurn"] =
            json!({"sessionId": SESSION, "turnId": "t3", "runId": RUN, "status": "running"});
    }
    let transport = Arc::new(ScriptedHost::default());
    transport.reply("subscription.open", Ok(open));
    let harness = Harness::open(transport, EPOCH, cx);
    harness.select(SESSION, cx);
    harness.with_window(cx, |_, _| {});
    settle(cx);
    harness
}

fn older_rows() -> Vec<(u64, Value)> {
    let mut rows = turn("t1", 1, "First needle", None, "Nothing here.");
    rows.extend(turn("t2", 10, "Second", None, "A needle again."));
    rows
}

#[gpui_kit::test]
fn the_bar_reads_the_rest_of_the_history_and_its_matches_join_in_place(cx: &mut TestAppContext) {
    let harness = needle_history(false, cx);
    assert!(page_reads(&harness).is_empty(), "nothing is read while the bar is closed");
    let page = harness.transport.hold("session.transcript.page");
    open_find(&harness, cx);
    let reads = page_reads(&harness);
    assert_eq!(reads.len(), 1, "opening the bar reads the earlier history");
    assert_eq!(reads[0]["maxBytes"], BACKGROUND_PAGE_BYTES);
    assert_eq!(reads[0]["cursor"], "c1");
    find(&harness, "needle", cx);
    assert_eq!(count(&harness, cx).as_deref(), Some("1/1"));
    assert_eq!(
        label_of(&harness, "find-note", cx).as_deref(),
        Some(shared::copy::search::READING_EARLIER_MESSAGES.en())
    );
    let first = active(&harness, cx).expect("an active match");
    // Where the reader is: the top of the row the first painted.
    let anchor = item_element_id("t3", &ItemKey::Text("t3-a".into()));
    let before = row_top(&harness, anchor.clone(), cx);

    page.try_send(Ok(page_of(&older_rows(), None))).expect("release");
    settle(cx);
    cx.executor().advance_clock(REFRESH_DELAY);
    settle(cx);
    harness.with_window(cx, |_, _| {});
    settle(cx);
    assert_eq!(count(&harness, cx).as_deref(), Some("3/3"), "the earlier matches join");
    assert_eq!(active(&harness, cx), Some(first), "the same match is active");
    assert_near(row_top(&harness, anchor, cx), before, "the view did not move");
    assert_eq!(label_of(&harness, "find-note", cx), None, "the history is whole");
    assert_eq!(
        harness.state.read_with(cx, |state, _| state.older_history()),
        OlderHistory::Reached
    );
    assert_eq!(page_reads(&harness).len(), 1);
}

#[gpui_kit::test]
fn closing_the_bar_drops_the_page_in_flight(cx: &mut TestAppContext) {
    let harness = needle_history(false, cx);
    let page = harness.transport.hold("session.transcript.page");
    open_find(&harness, cx);
    assert_eq!(page_reads(&harness).len(), 1);
    assert_eq!(
        harness.state.read_with(cx, |state, _| state.older_history()),
        OlderHistory::Loading
    );
    press(&harness, "escape", cx);
    assert!(!harness.view.read_with(cx, |view, _| view.is_find_open()));
    assert_eq!(
        harness.state.read_with(cx, |state, _| state.older_history()),
        OlderHistory::Available,
        "the read was dropped"
    );
    page.try_send(Ok(page_of(&older_rows(), None))).ok();
    settle(cx);
    let turns =
        harness.state.read_with(cx, |state, _| state.transcript().expect("held").turns().len());
    assert_eq!(turns, 1, "its answer belongs to nobody");
    assert_eq!(page_reads(&harness).len(), 1, "nor is another read");
}

#[gpui_kit::test]
fn nothing_is_read_while_a_turn_runs(cx: &mut TestAppContext) {
    let harness = needle_history(true, cx);
    harness.transport.reply("session.transcript.page", Ok(page_of(&older_rows(), None)));
    open_find(&harness, cx);
    find(&harness, "needle", cx);
    assert!(page_reads(&harness).is_empty(), "a turn runs");
    assert_eq!(count(&harness, cx).as_deref(), Some("1/1"));

    let mut frames = Frames::new();
    let end = json!({"sessionId": SESSION, "turnId": "t3", "runId": RUN, "status": "completed",
                     "terminalEventId": "end"});
    harness.push(frames.projection(end, vec![]), cx);
    settle(cx);
    assert_eq!(page_reads(&harness).len(), 1, "read once the turn settles");
    cx.executor().advance_clock(REFRESH_DELAY);
    settle(cx);
    assert_eq!(count(&harness, cx).as_deref(), Some("3/3"));
}

#[gpui_kit::test]
fn the_find_keeps_each_item_s_text_until_it_changes(cx: &mut TestAppContext) {
    let harness = open_tail(page_of(&needle_rows(), None), false, cx);
    open_find(&harness, cx);
    find(&harness, "needle", cx);
    let kept = harness.view.read_with(cx, |view, _| view.find_kept_items());
    assert_eq!(kept, 5, "two prompts, a call and two replies");
    press(&harness, "escape", cx);
    assert_eq!(harness.view.read_with(cx, |view, _| view.find_kept_items()), 0, "dropped on close");
}

/// The top of row `id` once the find shows its match, against the line the
/// transcript's rows scroll to: a match near a tall row's start that the
/// window did not show is brought into view, not just its row.
fn revealed_near_top(harness: &Harness, id: ElementId, cx: &mut TestAppContext) {
    let (top_line, _) = transcript_geometry(harness, cx);
    let top = row_top(harness, id, cx);
    assert!(
        top >= top_line - px(80.) && top <= top_line + px(80.),
        "the row's start, where the match is, shows: {top:?} against {top_line:?}"
    );
}

#[gpui_kit::test]
fn a_match_out_of_view_inside_a_tall_reply_is_revealed(cx: &mut TestAppContext) {
    let reply_text = format!("A needle first.\n\n{}", long_text(120));
    let harness = open_tail(page_of(&turn("t1", 1, "Ask", None, &reply_text), None), false, cx);
    let id = item_element_id("t1", &ItemKey::Text("t1-a".into()));
    let (top_line, _) = transcript_geometry(&harness, cx);
    assert!(row_top(&harness, id.clone(), cx) < top_line - px(1000.), "its end shows");
    open_find(&harness, cx);
    find(&harness, "needle", cx);
    assert_eq!(count(&harness, cx).as_deref(), Some("1/1"));
    revealed_near_top(&harness, id, cx);
}

#[gpui_kit::test]
fn a_match_out_of_view_inside_a_tall_prompt_is_revealed(cx: &mut TestAppContext) {
    let lines: String = (1..=80).map(|n| format!("\nline {n}")).collect();
    let ask = format!("A needle up top{lines}");
    let harness = open_tail(page_of(&turn("t1", 1, &ask, None, "Done."), None), false, cx);
    let id = item_element_id("t1", &ItemKey::User("t1".into()));
    let (top_line, _) = transcript_geometry(&harness, cx);
    assert!(row_top(&harness, id.clone(), cx) < top_line - px(800.), "its end shows");
    open_find(&harness, cx);
    find(&harness, "needle", cx);
    assert_eq!(count(&harness, cx).as_deref(), Some("1/1"));
    revealed_near_top(&harness, id, cx);
    let marks = harness
        .view
        .read_with(cx, |view, _| view.find_marks(&item("t1", ItemKey::User("t1".into()))));
    assert_eq!(marks.len(), 1);
    assert!(marks[0].active && marks[0].range == (2..8));
}

#[gpui_kit::test]
fn a_match_deep_in_a_long_output_scrolls_its_card(cx: &mut TestAppContext) {
    let output: String = (1..=100)
        .map(|n| if n == 90 { "the needle line\n".to_owned() } else { format!("line {n}\n") })
        .collect();
    let harness =
        open_tail(page_of(&turn("t1", 1, "Ask", Some(&output), "Done."), None), false, cx);
    open_find(&harness, cx);
    find(&harness, "needle", cx);
    assert_eq!(count(&harness, cx).as_deref(), Some("1/1"));
    let scroll = harness
        .view
        .read_with(cx, |view, _| view.detail_scroll("t1/t1-c1"))
        .expect("the card opened");
    let offset = scroll.offset().y;
    assert!(offset < px(-1000.), "the block scrolled to line 90: {offset:?}");
    let block = harness.with_window(cx, |window, _| {
        window
            .within(item_element_id("t1", &ItemKey::Tool("t1-c1".into())))
            .find("tool-output")
            .bounds()
    });
    let (top_line, _) = transcript_geometry(&harness, cx);
    assert!(block.top() >= top_line - px(1.), "the block shows: {block:?}");
}

#[gpui_kit::test]
fn moving_between_matches_on_screen_leaves_the_view_where_it_is(cx: &mut TestAppContext) {
    let rows = turn("t1", 1, "One needle", None, "Two needles: needle and needle.");
    let harness = open_tail(page_of(&rows, None), false, cx);
    let user = item_element_id("t1", &ItemKey::User("t1".into()));
    let before = row_top(&harness, user.clone(), cx);
    open_find(&harness, cx);
    find(&harness, "needle", cx);
    assert_eq!(count(&harness, cx).as_deref(), Some("1/4"));
    for expected in ["2/4", "3/4", "4/4", "1/4"] {
        press(&harness, "enter", cx);
        assert_eq!(count(&harness, cx).as_deref(), Some(expected));
        assert_near(row_top(&harness, user.clone(), cx), before, "the view did not move");
    }
}

#[gpui_kit::test]
fn a_match_in_a_collapsed_reasoning_opens_it(cx: &mut TestAppContext) {
    let (harness, mut frames) = start_turn(cx);
    let delta = json!({
        "kind": "thinking", "turnId": TURN, "runId": RUN, "messageId": "m1", "startOffset": 0,
        "text": "First the needle.\nThen more.", "complete": true
    });
    harness.push(
        frames.next("subscription.session_delta", json!({"sessionId": SESSION, "delta": delta})),
        cx,
    );
    harness.push(frames.delta("m1", 0, "Here."), cx);
    settle(cx);
    let collapsed = |harness: &Harness, cx: &mut TestAppContext| {
        harness.rows(cx).into_iter().find_map(|row| match row {
            RowBody::Thinking(thinking) => Some(!thinking.expanded),
            _ => None,
        })
    };
    assert_eq!(collapsed(&harness, cx), Some(true));
    open_find(&harness, cx);
    find(&harness, "needle", cx);
    assert_eq!(count(&harness, cx).as_deref(), Some("1/1"));
    assert_eq!(collapsed(&harness, cx), Some(false), "the reasoning opened");
    let reasoning = item(TURN, ItemKey::Thinking("m1".into()));
    let marks = harness.view.read_with(cx, |view, _| view.find_marks(&reasoning));
    assert_eq!(marks.len(), 1);
    assert!(marks[0].active && marks[0].field == Field::Body && marks[0].range == (10..16));
    harness.with_window(cx, |window, _| {
        let id = item_element_id(TURN, &ItemKey::Thinking("m1".into()));
        assert!(window.within(id).find("thinking-text").visible());
    });
}

#[gpui_kit::test]
fn a_tool_call_s_header_is_searched_without_opening_its_card(cx: &mut TestAppContext) {
    let harness = open_tail(page_of(&needle_rows(), None), false, cx);
    open_find(&harness, cx);
    find(&harness, "notes.txt", cx);
    assert_eq!(count(&harness, cx).as_deref(), Some("1/1"));
    let tool = item("t1", ItemKey::Tool("t1-c1".into()));
    assert_eq!(
        active(&harness, cx),
        Some(TranscriptMatchView { row: tool.clone(), field: Field::ToolSummary, range: 4..13 })
    );
    let expanded = harness.rows(cx).into_iter().find_map(|row| match row {
        RowBody::Tool(tool) => Some(tool.expanded),
        _ => None,
    });
    assert_eq!(expanded, Some(false), "the header shows the match");
    press(&harness, "cmd-a", cx);
    find(&harness, "bash", cx);
    assert_eq!(count(&harness, cx).as_deref(), Some("1/1"));
    assert_eq!(active(&harness, cx).map(|found| found.field), Some(Field::ToolName));
}

/// A Tool call's summary is cut at 120 characters; the cut does not end
/// the word it splits, so "test" cut from "testing" is no whole word (the
/// one false match a whole-word search used to find, hidden past the
/// header's width).
#[gpui_kit::test]
fn a_summary_cut_inside_a_word_is_no_whole_word(cx: &mut TestAppContext) {
    // 115 x's and a space, then "test" up to the cut at 120, "ing" after.
    let command = format!("{} testing", "x".repeat(115));
    let rows = vec![
        (1, json!({"type": "user", "id": "t1", "turnId": "t1", "ts": 1, "text": "Run it"})),
        (
            2,
            json!({"type": "tool_call", "id": "t1-c1", "turnId": "t1", "ts": 2,
                   "toolName": "Bash", "args": {"command": command}, "stepId": "t1-a"}),
        ),
        (
            3,
            json!({"type": "tool_result", "id": "t1-c1-r", "turnId": "t1", "ts": 3,
                   "toolUseId": "t1-c1", "isError": false,
                   "content": {"kind": "text", "text": "ok"}}),
        ),
        (
            4,
            json!({"type": "assistant", "id": "t1-a", "turnId": "t1", "ts": 4, "text": "Done.",
                   "contentOrder": ["tools", "text"], "modelId": "m"}),
        ),
        (
            5,
            json!({"type": "turn_state", "id": "t1-end", "turnId": "t1", "ts": 5,
                   "status": "completed"}),
        ),
    ];
    let harness = open_tail(page_of(&rows, None), false, cx);
    open_find(&harness, cx);
    find(&harness, "test", cx);
    assert_eq!(count(&harness, cx).as_deref(), Some("1/1"));
    assert_eq!(active(&harness, cx).map(|found| found.field), Some(Field::ToolSummary));
    harness.with_window(cx, |window, cx| window.click("find-whole-word", cx));
    settle(cx);
    assert_eq!(count(&harness, cx).as_deref(), Some("No results"), "testing goes on past the cut");
}

/// A match across marked runs ("foo **bar**" for "foo bar") is one range
/// of the source with markup inside; the kit maps it to the one range of
/// text it draws, painted as one match.
#[gpui_kit::test]
fn a_match_across_marked_runs_paints_as_one(cx: &mut TestAppContext) {
    let rows = turn("t1", 1, "Ask", None, "Say foo **bar** and `baz` now.");
    let harness = open_tail(page_of(&rows, None), false, cx);
    open_find(&harness, cx);
    find(&harness, "foo bar and baz", cx);
    assert_eq!(count(&harness, cx).as_deref(), Some("1/1"));
    assert_eq!(
        active(&harness, cx).map(|found| found.range),
        Some(4..24),
        "`foo **bar** and `baz` in the source"
    );
    let (_, active_fill) = fills(cx);
    let highlights =
        harness.view.read_with(cx, |view, _| view.text_views().highlights(&reply("t1")));
    // "Say foo bar and baz now.": one range from "foo" to "baz".
    assert_eq!(highlights, [(4..19, active_fill)]);
}

/// Opens the selected task at `target`, as the Search page does, and lets
/// what it reads land.
fn open_at(harness: &Harness, target: search::PassageTarget, cx: &mut TestAppContext) {
    harness.with_window(cx, |window, cx| {
        harness.view.update(cx, |view, cx| view.open_at_passage(target, window, cx));
    });
    settle(cx);
    harness.with_window(cx, |_, _| {});
    settle(cx);
    harness.with_window(cx, |_, _| {});
    settle(cx);
}

/// `needle_history`'s second turn's reply, as a search finds it: the 5th
/// durable row of the task (t1's three, t2's prompt, then it).
fn t2_reply_target(anchor: &str) -> search::PassageTarget {
    search::PassageTarget::new(SESSION, anchor, 4).with_turn_id("t2").with_term("needle")
}

#[gpui_kit::test]
fn a_passage_in_history_not_held_yet_is_read_back_to_shown_and_found(cx: &mut TestAppContext) {
    let harness = needle_history(false, cx);
    let page = harness.transport.hold("session.transcript.page");
    open_at(&harness, t2_reply_target("t2-a"), cx);
    let reads = page_reads(&harness);
    assert_eq!(reads.len(), 1, "the message is older than the tail");
    assert_eq!(reads[0]["cursor"], "c1");
    assert_eq!(reads[0]["maxBytes"], crate::OLDER_PAGE_BYTES, "read as scrolling up reads");
    assert!(!harness.view.read_with(cx, |view, _| view.is_find_open()), "not before it lands");
    assert!(harness.view.read_with(cx, |view, _| view.is_landing()));

    page.try_send(Ok(page_of(&older_rows(), None))).expect("release");
    settle(cx);
    harness.with_window(cx, |_, _| {});
    settle(cx);
    harness.with_window(cx, |_, _| {});
    assert!(!harness.view.read_with(cx, |view, _| view.is_landing()));
    assert!(harness.view.read_with(cx, |view, _| view.is_find_open()));
    let query = harness.view.read_with(cx, |view, cx| {
        view.find_bar().expect("bar").read(cx).query().read(cx).value().to_string()
    });
    assert_eq!(query, "needle");
    // Three needles; the active one is in the passage's message, not the
    // nearest to where the window was (t3's).
    assert_eq!(count(&harness, cx).as_deref(), Some("2/3"));
    assert_eq!(
        active(&harness, cx),
        Some(TranscriptMatchView { row: reply("t2"), field: Field::Body, range: 2..8 })
    );
    harness.with_window(cx, |window, _| {
        let id = item_element_id("t2", &ItemKey::Text("t2-a".into()));
        assert!(window.find(id).visible(), "scrolled to it");
    });
    assert_eq!(page_reads(&harness).len(), 1, "the whole history is held");
}

#[gpui_kit::test]
fn a_passage_whose_message_is_not_found_lands_on_its_index_then_its_turn(cx: &mut TestAppContext) {
    // The id is unknown: once the whole history is held, the 5th row.
    let harness = needle_history(false, cx);
    harness.transport.reply("session.transcript.page", Ok(page_of(&older_rows(), None)));
    open_at(&harness, t2_reply_target("gone"), cx);
    assert_eq!(active(&harness, cx).map(|found| found.row), Some(reply("t2")));

    // No row at the index either: the passage's Turn, its prompt first.
    let harness = needle_history(false, cx);
    harness.transport.reply("session.transcript.page", Ok(page_of(&older_rows(), None)));
    let target =
        search::PassageTarget::new(SESSION, "gone", 99).with_turn_id("t2").with_term("Second");
    open_at(&harness, target, cx);
    assert_eq!(
        active(&harness, cx).map(|found| found.row),
        Some(item("t2", ItemKey::User("t2".into())))
    );
}

#[gpui_kit::test]
fn a_passage_held_in_the_tail_lands_at_once(cx: &mut TestAppContext) {
    let harness = needle_history(false, cx);
    open_at(&harness, t2_reply_target("t3-a"), cx);
    assert!(page_reads(&harness).len() <= 1, "only the bar's own read of the history");
    assert_eq!(active(&harness, cx).map(|found| found.row), Some(reply("t3")));
    assert!(harness.view.read_with(cx, |view, _| view.is_find_open()));
}

/// The Host matched text the transcript does not show (here: the term is
/// not in the message at all): the bar finds the term, but no match is
/// active, so the view stays on the passage's message.
#[gpui_kit::test]
fn a_passage_whose_message_shows_no_match_keeps_it_in_view(cx: &mut TestAppContext) {
    let harness = needle_history(false, cx);
    harness.transport.reply("session.transcript.page", Ok(page_of(&older_rows(), None)));
    let target =
        search::PassageTarget::new(SESSION, "t2", 3).with_turn_id("t2").with_term("needle");
    open_at(&harness, target, cx);
    assert_eq!(count(&harness, cx).as_deref(), Some("0/3"));
    assert_eq!(active(&harness, cx), None);
    harness.with_window(cx, |window, _| {
        let prompt = window.find(item_element_id("t2", &ItemKey::User("t2".into())));
        assert!(prompt.visible(), "the passage's prompt shows");
    });
    // The next query is the person's: it moves as any does.
    press(&harness, "cmd-a", cx);
    find(&harness, "again", cx);
    assert_eq!(active(&harness, cx).map(|found| found.row), Some(reply("t2")));
}
