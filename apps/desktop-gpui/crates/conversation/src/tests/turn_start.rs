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

//! A settled turn larger than the transcript's 16 KiB tail shows without its
//! start. When its end is in view, older history is read in the background
//! until the turn's start is held, the view staying where it is; never
//! while a turn runs; at most [`TURN_START_PAGE_CAP`] pages. Pages come from
//! [`Pager`], which serves synthetic rows as the Host's reader does.

use std::time::Instant;

use super::*;
use crate::rows::RowKey;
use crate::{BACKGROUND_PAGE_BYTES, OLDER_PAGE_BYTES, TURN_START_PAGE_CAP};

/// The most fragments one page carries (`SESSION_TRANSCRIPT_PAGE_MAX_MESSAGES`).
const PAGE_MAX_FRAGMENTS: usize = 256;

/// One durable row: its sequence, its turn, and its bytes.
struct PagerRow {
    sequence: u64,
    turn: String,
    bytes: Vec<u8>,
}

/// A session's durable rows served as `pagedTranscriptReads.readPage`
/// serves them (packages/runtime-host/src/server/session-transcript-reader.ts):
/// an `older` read runs newest first up to its `maxBytes`, a row larger than
/// what is left goes in byte slices from its end, and a page that would stop
/// inside a turn is cut back to the last point between turns, unless one
/// turn fills it. Its cursor is the row (and the byte) to go on from.
struct Pager {
    rows: Vec<PagerRow>,
}

impl Pager {
    /// `rows`, oldest first, eight sequences apart as the Host's are sparse.
    fn new(rows: &[Value]) -> Self {
        let rows = rows
            .iter()
            .enumerate()
            .map(|(ix, row)| PagerRow {
                sequence: (ix as u64 + 1) * 8,
                turn: row["turnId"].as_str().expect("turnId").to_owned(),
                bytes: serde_json::to_vec(row).expect("row"),
            })
            .collect();
        Self { rows }
    }

    fn through(&self) -> u64 {
        self.rows.last().map_or(0, |row| row.sequence)
    }

    fn bytes(&self) -> usize {
        self.rows.iter().map(|row| row.bytes.len()).sum()
    }

    /// `subscription.open` with the 16 KiB tail, the live root turn `root`.
    fn open(&self, root: Value) -> Value {
        let mut open = open_result(SUBSCRIPTION);
        open["snapshot"]["rootTurn"] = root;
        open["transcript"]["durable"] = self.read(self.rows.len() - 1, None, 16 * 1024);
        open
    }

    /// What `session.transcript.page` answers to the older read `input`.
    fn answer(&self, input: &Value) -> Value {
        assert_eq!(input["direction"], "older");
        assert_eq!(input["throughSequence"], self.through(), "bound to the tail's watermark");
        let cursor = input["cursor"].as_str().expect("cursor");
        let (row, offset) = match cursor.split_once(':') {
            Some((row, offset)) => (row, Some(offset.parse().expect("offset"))),
            None => (cursor, None),
        };
        let max = input["maxBytes"].as_u64().expect("maxBytes") as usize;
        self.read(row.parse().expect("row"), offset, max)
    }

    /// Whether a page may stop just before row `ix` (going older) without
    /// splitting a turn: no later row belongs to its turn.
    fn between(&self, ix: usize) -> bool {
        self.rows.get(ix + 1).is_none_or(|next| next.turn != self.rows[ix].turn)
    }

    fn read(&self, start: usize, offset: Option<usize>, max: usize) -> Value {
        let mut fragments = Vec::new();
        let (mut raw, mut ends, mut truncated) = (0, true, false);
        let mut next = None;
        // The last point between turns: fragments before it, bytes, row.
        let mut between: Option<(usize, usize, usize)> = None;
        for ix in (0..=start).rev() {
            if fragments.len() >= PAGE_MAX_FRAGMENTS || raw >= max {
                (truncated, ends, next) = (true, self.between(ix), Some(ix.to_string()));
                break;
            }
            if self.between(ix) {
                between = Some((fragments.len(), raw, ix));
            }
            let row = &self.rows[ix];
            let edge =
                if ix == start { offset.unwrap_or(row.bytes.len()) } else { row.bytes.len() };
            let from = edge.saturating_sub(max - raw);
            fragments.push(json!({
                "sequence": row.sequence, "byteOffset": from, "totalBytes": row.bytes.len(),
                "payloadDigest": null,
                "data": base64::engine::general_purpose::STANDARD.encode(&row.bytes[from..edge])
            }));
            raw += edge - from;
            if from > 0 {
                (truncated, ends, next) = (true, false, Some(format!("{ix}:{from}")));
                break;
            }
        }
        if !ends && let Some((index, bytes, ix)) = between.filter(|(index, ..)| *index > 0) {
            fragments.truncate(index);
            (raw, ends, next) = (bytes, true, Some(ix.to_string()));
        }
        if !truncated {
            next = None;
        }
        json!({
            "kind": "page", "sessionId": SESSION, "direction": "older",
            "throughSequence": self.through(), "rawBytes": raw, "fragments": fragments,
            "nextCursor": next, "endsAtTurnBoundary": ends
        })
    }
}

/// Turn `turn`, settled: its prompt, then `calls` steps that each write a
/// new file of 80 lines (the call carries the text, its result the diff
/// that created it, about 13 KB together), then a reply taller than the
/// window, so the 16 KiB tail fills the transcript.
fn long_turn(turn: &str, calls: usize) -> Vec<Value> {
    let text: String =
        (1..=80).map(|n| format!("{n:>4} {}\n", "lorem ipsum dolor sit amet ".repeat(3))).collect();
    let diff_body: String = text.lines().map(|line| format!("+{line}\n")).collect();
    let mut rows = vec![
        json!({"type": "user", "id": turn, "turnId": turn, "ts": 1, "text": "Write the files"}),
    ];
    for call in 0..calls {
        let (step, id, path) =
            (format!("{turn}-s{call}"), format!("{turn}-c{call}"), format!("/w/f{call}.md"));
        rows.push(json!({"type": "assistant", "id": step, "turnId": turn, "ts": 2,
                         "text": format!("Writing file {call}."),
                         "contentOrder": ["text", "tools"], "modelId": "m"}));
        rows.push(json!({"type": "tool_call", "id": id, "turnId": turn, "ts": 2,
                         "toolName": "Write", "args": {"path": path, "content": text},
                         "stepId": step}));
        rows.push(json!({"type": "tool_result", "id": format!("{id}-r"), "turnId": turn,
                         "ts": 3, "toolUseId": id, "isError": false,
                         "content": {"kind": "file_diff", "paths": [path], "diff": format!(
                             "--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,80 @@\n{diff_body}")}}));
    }
    let reply: String =
        (1..=40).map(|n| format!("Paragraph {n} of what the files say.\n\n")).collect();
    rows.push(json!({"type": "assistant", "id": format!("{turn}-done"), "turnId": turn,
                     "ts": 4, "text": reply, "modelId": "m"}));
    rows.push(json!({"type": "turn_state", "id": format!("{turn}-end"), "turnId": turn,
                     "ts": 5, "status": "completed"}));
    rows
}

/// A short settled turn.
fn short_turn(turn: &str) -> Vec<Value> {
    vec![
        json!({"type": "user", "id": turn, "turnId": turn, "ts": 1, "text": "Hello"}),
        json!({"type": "assistant", "id": format!("{turn}-a"), "turnId": turn, "ts": 2,
               "text": "Hi.", "modelId": "m"}),
        json!({"type": "turn_state", "id": format!("{turn}-end"), "turnId": turn, "ts": 3,
               "status": "completed"}),
    ]
}

/// The session with turn `t1` and then `t2` of `calls` calls, opened with
/// the live root turn `root`. The pager answers older reads; the first one
/// waits for the returned sender when `hold_first`.
fn open_long(
    calls: usize,
    root: Value,
    hold_first: bool,
    cx: &mut TestAppContext,
) -> (Harness, Arc<Pager>, async_channel::Sender<Reply>) {
    let mut rows = short_turn("t1");
    rows.extend(long_turn("t2", calls));
    let pager = Arc::new(Pager::new(&rows));
    let transport = Arc::new(ScriptedHost::default());
    transport.reply("subscription.open", Ok(pager.open(root)));
    let first = if hold_first {
        transport.hold("session.transcript.page")
    } else {
        async_channel::bounded(1).0
    };
    let answers = pager.clone();
    transport.respond_with(move |operation, input| {
        (operation == "session.transcript.page").then(|| Ok(answers.answer(input)))
    });
    let harness = Harness::open(transport, EPOCH, cx);
    harness.select(SESSION, cx);
    harness.with_window(cx, |_, _| {});
    settle(cx);
    (harness, pager, first)
}

/// Answers the first read, held until now, and lets the rest run.
fn release_first(
    harness: &Harness,
    pager: &Pager,
    first: &async_channel::Sender<Reply>,
    cx: &mut TestAppContext,
) {
    let input = pages(harness)[0].clone();
    first.try_send(Ok(pager.answer(&input))).expect("release");
    settle(cx);
}

fn pages(harness: &Harness) -> Vec<Value> {
    harness.transport.requests("session.transcript.page")
}

fn has_start(harness: &Harness, turn_id: &str, cx: &mut TestAppContext) -> bool {
    harness
        .state
        .read_with(cx, |state, _| state.transcript().expect("transcript").has_turn_start(turn_id))
}

fn root_of(turn_id: &str, status: &str) -> Value {
    let mut root = json!({"sessionId": SESSION, "turnId": turn_id, "runId": RUN, "status": status});
    if status == "completed" {
        root["terminalEventId"] = json!("end");
    }
    root
}

fn reply_id() -> ElementId {
    item_element_id("t2", &ItemKey::Text("t2-done".into()))
}

/// The task opens on the end of a 2 MB turn of 150 calls, the tail filling
/// the transcript: its end shows, so background pages of the Host's largest
/// size run back to its start, and the view, following the latest output,
/// stays on the turn's end.
#[gpui_kit::test]
fn a_settled_turn_larger_than_the_tail_reads_its_start_once_its_end_shows(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (harness, pager, first) = open_long(150, Value::Null, true, cx);
    assert!(pager.bytes() > 2_000_000, "{} bytes", pager.bytes());
    assert!(!has_start(&harness, "t2", cx), "the tail cut the turn");
    assert_eq!(pages(&harness).len(), 1, "its end shows: the read starts");
    let footer = footer_element_id("t2");
    let before = (row_top(&harness, footer.clone(), cx), row_top(&harness, reply_id(), cx));

    let started = Instant::now();
    release_first(&harness, &pager, &first, cx);
    let elapsed = started.elapsed();
    let reads = pages(&harness);
    eprintln!(
        "F30 measurement: a {} byte turn of 150 calls held whole after {} pages of {} KiB \
         in {elapsed:?} (debug build, scripted Host, its encoding included)",
        pager.bytes(),
        reads.len(),
        BACKGROUND_PAGE_BYTES / 1024
    );
    assert!(has_start(&harness, "t2", cx), "the turn is held from its prompt");
    assert!(reads.len() > 1, "{reads:?}");
    assert!(reads.iter().all(|read| read["maxBytes"] == BACKGROUND_PAGE_BYTES));
    assert!(following_tail(&harness, cx), "the view still follows the latest output");
    assert_near(row_top(&harness, footer, cx), before.0, "the turn's end did not move");
    assert_near(row_top(&harness, reply_id(), cx), before.1, "its reply did not move");
    let user = item_element_id("t2", &ItemKey::User("t2".into()));
    harness.view.read_with(cx, |view, _| {
        assert!(view.rows().iter().any(|row| row.key.element_id() == user), "its prompt is in");
    });
}

/// The reader scrolled up a little from the end: the turn's start arrives
/// above without moving what they read.
#[gpui_kit::test]
fn the_start_of_a_turn_goes_above_the_rows_being_read(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (harness, pager, first) = open_long(50, Value::Null, true, cx);
    assert_eq!(pages(&harness).len(), 1, "its end shows: the read starts");
    harness.with_window(cx, |window, cx| {
        let delta = gpui_kit::ScrollDelta::Pixels(gpui_kit::point(px(0.), px(60.)));
        window.scroll("conversation-transcript", delta, cx);
        window.render_frame(cx);
    });
    assert!(!following_tail(&harness, cx), "the reader left the end");
    let before = row_top(&harness, reply_id(), cx);

    release_first(&harness, &pager, &first, cx);
    assert!(has_start(&harness, "t2", cx));
    assert!(pages(&harness).len() > 1);
    assert!(!following_tail(&harness, cx));
    assert_near(row_top(&harness, reply_id(), cx), before, "the reply being read stayed put");
}

/// While a turn runs nothing is read in the background, however often the
/// settled turn's end is drawn; once it ends, the read goes ahead.
#[gpui_kit::test]
fn nothing_is_read_in_the_background_while_a_turn_runs(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (harness, _, _) = open_long(40, root_of("t3", "running"), false, cx);
    for _ in 0..3 {
        harness.with_window(cx, |_, _| {});
        settle(cx);
    }
    harness.with_window(cx, |window, _| assert!(window.find(footer_element_id("t2")).visible()));
    assert!(pages(&harness).is_empty(), "a turn runs: no page");
    assert!(!has_start(&harness, "t2", cx));

    let mut frames = Frames::new();
    harness.push(frames.projection(root_of("t3", "completed"), vec![]), cx);
    settle(cx);
    assert!(!pages(&harness).is_empty(), "the turn ended: the read goes ahead");
    assert!(has_start(&harness, "t2", cx));
}

/// A turn larger than the cap: the background stops after
/// [`TURN_START_PAGE_CAP`] pages, the turn still without its start; the
/// person reaching the top reads on to it, in pages of their own size.
#[gpui_kit::test]
fn the_background_read_stops_at_its_cap(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let calls = (TURN_START_PAGE_CAP as usize * BACKGROUND_PAGE_BYTES as usize) / 13_000 + 40;
    let (harness, _, _) = open_long(calls, Value::Null, false, cx);
    for _ in 0..2 {
        harness.with_window(cx, |_, _| {});
        settle(cx);
    }
    assert_eq!(pages(&harness).len(), TURN_START_PAGE_CAP as usize);
    assert!(!has_start(&harness, "t2", cx), "past the cap the turn waits");

    harness.with_window(cx, |window, cx| {
        window.focus_next(cx);
        window.press("home", cx);
    });
    settle(cx);
    assert!(has_start(&harness, "t2", cx), "the person's read goes on to the start");
    let reads = pages(&harness);
    assert!(
        reads[TURN_START_PAGE_CAP as usize..]
            .iter()
            .all(|read| read["maxBytes"] == OLDER_PAGE_BYTES)
    );
}

/// A tail that ends between turns cuts none: nothing is read until the
/// person reaches the top, though older history exists.
#[gpui_kit::test]
fn a_tail_between_turns_reads_nothing_on_its_own(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let rows: Vec<Value> = (1..=120).flat_map(|n| short_turn(&format!("t{n}"))).collect();
    let pager = Pager::new(&rows);
    let transport = Arc::new(ScriptedHost::default());
    let open = pager.open(Value::Null);
    assert_eq!(open["transcript"]["durable"]["endsAtTurnBoundary"], true);
    assert!(open["transcript"]["durable"]["nextCursor"].is_string(), "older history exists");
    transport.reply("subscription.open", Ok(open));
    let harness = Harness::open(transport, EPOCH, cx);
    harness.select(SESSION, cx);
    harness.with_window(cx, |window, _| assert!(window.find(footer_element_id("t120")).visible()));
    settle(cx);
    harness.with_window(cx, |_, _| {});
    assert!(pages(&harness).is_empty());
    harness.view.read_with(cx, |view, _| {
        assert!(view.rows().iter().any(|row| row.key == RowKey::History), "the top waits");
    });
}
