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

use super::*;
use base64::Engine;
use tokio::runtime::Runtime;

const READY: &str = "Live activity — ready.";
const OPEN: &str = "\nUnicode **中文🦀**\n\n```rust\nlet label = \"第一段\";\n";
const FINISH: &str = "let tail = \"最后一段\";\n```\n\nAfter the fence — 已完成。\n";
const AWAY: &str = "While away — 未显示。\n";
const SOURCE: &[u8] = b"\x1b[99;6u"; // Ctrl+Shift+C through the terminal keyboard protocol.

/// Continue the already running, externally installed Board acceptance. Every
/// read and append crosses the real Host's public Remote protocol.
pub(super) fn exercise(tui: &mut Pty, runtime: &Runtime, client: &maka_client::Client) {
    let cards = runtime.block_on(remote(client, "cards", Value::Null));
    tui.click_page_text("Board activity");
    tui.wait_for(READY);
    tui.click_page_text(READY);
    let initial = wait_stats(runtime, client, |stats| stats["active"] == 1);
    assert!(initial["reportBytes"].as_u64().unwrap() > 64 * 1024);
    assert!(initial["pageReads"].as_u64().unwrap() > 1);

    // Both ends of the same oversized Markdown block must be searchable and
    // readable after Remote assembles its multiple bounded deliveries.
    find(tui, "Board report — 看板记录", "1/1");
    find(tui, "Board report end — 完整记录。", "1/1");
    tui.drag_last_text("完整记录");
    copy(tui, b"\x03", "完整记录");
    tui.click_page_text("Read × 2");
    tui.wait_for("Read cards");
    tui.click_page_text("Read cards");
    tui.wait_for("Board cards checked.");
    copy(tui, SOURCE, "Read cards\nBoard cards checked.");
    tui.click_page_text("Read cards");
    tui.wait_until(|screen| !screen.contains("Board cards checked."));
    tui.click_page_text("Read × 2");
    tui.wait_until(|screen| !screen.contains("Read cards"));

    tui.click_page_text(READY);
    // Reading or selecting a body pauses following. Explicitly return to the
    // latest record before asking its open fence to grow into the viewport.
    latest(tui, runtime, client);
    runtime.block_on(remote(client, "activity-append", json!(OPEN)));
    tui.wait_for("第一段");
    let (row, column) = position(tui, "中文🦀");
    let last = column + "中文🦀".width() - 1;
    tui.send(
        format!(
            "\x1b[<0;{};{}M\x1b[<32;{};{}M",
            column + 1,
            row + 1,
            last + 1,
            row + 1
        )
        .as_bytes(),
    );
    copy(tui, b"\x03", "中文🦀");
    runtime.block_on(remote(client, "activity-append", json!(FINISH)));
    // Copy while the pointer is held: incoming text cannot rebase the range
    // against a partially updated layout or finish the open fence underneath it.
    copy(tui, b"\x03", "中文🦀");
    assert!(
        !tui.screen
            .snapshot()
            .unwrap()
            .screen
            .contains("After the fence")
    );
    tui.send(format!("\x1b[<0;{};{}m", last + 1, row + 1).as_bytes());
    latest(tui, runtime, client);
    tui.wait_for("After the fence — 已完成。");
    copy(tui, b"\x03", "中文🦀");
    // End preserves the text range but clears the selected message. Select
    // the live body explicitly for source copy, then restore its text range.
    tui.click_page_text("After the fence — 已完成。");
    copy(tui, SOURCE, &format!("{READY}\n{OPEN}{FINISH}"));
    tui.drag_last_text("中文🦀");
    copy(tui, b"\x03", "中文🦀");
    tui.resize(55, 24);
    tui.wait_until(|screen| {
        !screen.contains("+  New session") && screen.contains("Board activity")
    });
    copy(tui, b"\x03", "中文🦀");
    tui.resize(170, 40);
    tui.wait_until(|screen| screen.contains("+  New session") && screen.contains("Board activity"));
    copy(tui, b"\x03", "中文🦀");

    // The oldest record lies outside the initial 256-record window. Older
    // paging lands at its adjacent edge; newer paging returns to the next one.
    find(tui, "Board history 000", "0/0");
    tui.send(b"\x1b[H");
    tui.wait_for("Board history 047");
    tui.send(b"\x1b[H");
    tui.wait_for("Board history 000");
    find(tui, "Board history 000", "1/1");
    find(tui, "Board history 047", "1/1");
    tui.send(b"\x1b[6~");
    tui.wait_for("Board history 048");
    tui.send(b"\x1b[F");
    tui.wait_for("After the fence — 已完成。");
    let read = stats(runtime, client);
    assert!(read["pageReads"].as_u64().unwrap() > initial["pageReads"].as_u64().unwrap());
    assert_eq!(read["viewReads"], initial["viewReads"]);
    assert_eq!(read["activityViewReads"], initial["activityViewReads"]);
    assert_eq!(read["updates"], 2);
    assert_eq!(
        runtime.block_on(remote(client, "cards", Value::Null)),
        cards
    );

    // An idle live reader has no queued updates; leaving it must cancel its
    // waiting stream and release the provider's document-owned mount.
    tui.click_text("Settings");
    tui.wait_for("Maka dark ▾");
    let closed = wait_stats(runtime, client, |stats| stats["active"] == 0);
    assert_eq!(closed["closed"], closed["opened"]);
    runtime.block_on(remote(client, "activity-append", json!(AWAY)));
    tui.send(b"\x1b[1;3D"); // Global Back restores the complete activity address.
    tui.wait_for("While away — 未显示。");
    let reopened = wait_stats(runtime, client, |stats| stats["active"] == 1);
    assert_eq!(
        reopened["opened"].as_u64().unwrap(),
        initial["opened"].as_u64().unwrap() + 1
    );
    assert_eq!(reopened["closed"], closed["closed"]);
    assert_eq!(reopened["invalidated"], 0);

    // Leave a disclosure press unfinished when the caller retires this plugin.
    // Its eventual release must not toggle the same key in a fresh activation.
    tui.wait_for("Read × 2");
    let (row, column) = position(tui, "Read × 2");
    tui.send(format!("\x1b[<0;{};{}M", column + 1, row + 1).as_bytes());
    copy(tui, SOURCE, "Read × 2");
}

pub(super) fn replacement(tui: &mut Pty, runtime: &Runtime, client: &maka_client::Client) {
    tui.wait_until(|screen| {
        screen.contains(READY) && !screen.contains("This app is no longer available.")
    });
    tui.wait_for("Read × 2");
    let (row, column) = position(tui, "Read × 2");
    tui.send(format!("\x1b[<0;{};{}m", column + 1, row + 1).as_bytes());
    tui.click_page_text(READY);
    // Clipboard output is an event-loop barrier after the late release.
    copy(tui, SOURCE, &format!("{READY}\n"));
    let screen = tui.screen.snapshot().unwrap().screen;
    assert!(screen.contains("Read × 2"));
    assert!(!screen.contains("Read cards"));
    assert!(!screen.contains("After the fence") && !screen.contains("While away"));
    let fresh = stats(runtime, client);
    assert_eq!(fresh["active"], 1);
    assert_eq!(fresh["opened"], 1);
    assert_eq!(fresh["updates"], 0);
    // Return to the board so its durable-card and post-retirement write checks
    // continue in the original acceptance test.
    tui.click_last_text("‹ Board");
    tui.wait_for("From elsewhere");
    let closed = wait_stats(runtime, client, |stats| stats["active"] == 0);
    assert_eq!(closed["closed"], fresh["opened"]);
}

fn find(tui: &mut Pty, query: &str, count: &str) {
    tui.send(format!("\x06\x1b[200~{query}\x1b[201~").as_bytes());
    tui.wait_for(count);
    tui.send(b"\x1b");
    tui.wait_until(|screen| !screen.contains(count));
    if count == "1/1" {
        tui.wait_for(query); // The query editor is closed; this is rendered content.
    }
}

fn copy(tui: &mut Pty, keys: &[u8], expected: &str) {
    tui.output.clear();
    tui.send(keys);
    let encoded = base64::engine::general_purpose::STANDARD.encode(expected);
    tui.wait_output(format!("\x1b]52;c;{encoded}\x07").as_bytes());
}

fn latest(tui: &mut Pty, runtime: &Runtime, client: &maka_client::Client) {
    let reads = stats(runtime, client)["pageReads"].as_u64().unwrap();
    tui.send(b"\x1b[F");
    // A provider read is the barrier proving End reached the active reader.
    wait_stats(runtime, client, |stats| {
        stats["pageReads"].as_u64().unwrap() > reads
    });
}

fn position(tui: &Pty, text: &str) -> (usize, usize) {
    let screen = tui.screen.snapshot().unwrap().screen;
    screen
        .lines()
        .enumerate()
        .find_map(|(row, line)| line.find(text).map(|byte| (row, line[..byte].width())))
        .unwrap_or_else(|| panic!("No transcript text {text:?}\n{screen}"))
}

fn stats(runtime: &Runtime, client: &maka_client::Client) -> Value {
    runtime.block_on(remote(client, "activity-stats", Value::Null))
}

fn wait_stats(
    runtime: &Runtime,
    client: &maka_client::Client,
    ready: impl Fn(&Value) -> bool,
) -> Value {
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let value = remote(client, "activity-stats", Value::Null).await;
                if ready(&value) {
                    return value;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("Transcript provider resources did not settle")
    })
}
