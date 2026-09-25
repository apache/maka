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

use super::super::super::candidate::CandidateFixture;
use super::*;
use tokio::runtime::Runtime;

mod pending;
pub(in crate::tui) mod proxy;
mod report;
mod timed;
mod visual;

const READY: &str = "Live activity — ready.";
const ANCHOR: &str = "Board history 150";

/// Fixed release acceptance: 20 warmups + 200 samples per operation/delay.
/// MAKA_TUI_PERF_MODE=smoke selects 2+8 and never claims performance acceptance.
/// MAKA_TUI_PERF_OUTPUT may name a new JSONL file; every raw row also goes to stdout.
#[test]
#[ignore = "serial release Host+PTY performance acceptance; emits raw JSONL"]
fn local_input_scroll_and_disclosure_under_real_host_rtt() {
    let mut report = report::Report::new();
    for rtt in [0, 200] {
        run(rtt, &mut report, false);
    }
    report.finish();
    assert_eq!(
        report.failures, 0,
        "raw JSONL retains all observed failures"
    );
}

fn run(rtt: u64, report: &mut report::Report, extended: bool) {
    let directory = tempfile::tempdir().unwrap();
    let package = directory.path().join("board-plugin");
    std::fs::create_dir(&package).unwrap();
    let board = include_str!("../../../fixtures/board-plugin/host.mjs");
    let entry = if extended {
        pending::fixture(board)
    } else {
        board.to_owned()
    };
    std::fs::write(package.join("host.mjs"), entry).unwrap();
    std::fs::write(
        package.join("board-ui.mjs"),
        include_str!("../../../fixtures/board-plugin/board-ui.mjs"),
    )
    .unwrap();
    std::fs::write(
        package.join("maka.extension.json"),
        json!({"schemaVersion":1,
        "id":"example.board","runtime":{"entry":"host.mjs","sdkVersion":2}})
        .to_string(),
    )
    .unwrap();
    let mut host = CandidateFixture::new(directory.path().join("root"));
    host.child = Some(
        Command::new(env!("CARGO_BIN_EXE_maka"))
            .args(["host", "serve", "--root"])
            .arg(&host.root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    host.wait_for_registration();
    let runtime = Runtime::new().unwrap();
    let (client, notices) = runtime.block_on(proxy::connect(&host.root));
    runtime.block_on(async {
        client
            .request(
                Operation::PluginPackageInstall,
                json!({"sourcePath":package}),
            )
            .await
            .unwrap();
        let receipt = client
            .request(
                Operation::PluginCompositionApply,
                json!({"operations":[{"type":"insert",
            "rootId":"profile","entry":{"id":"board","packageId":"example.board"}}]}),
            )
            .await
            .unwrap();
        lifecycle::settle(&client, false, &receipt).await;
    });
    let origin = Instant::now();
    let proxy = runtime.block_on(proxy::DelayProxy::start(
        &host,
        directory.path(),
        Duration::from_millis(rtt / 2),
        origin,
    ));
    let tui = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    let mut timed = timed::Timed::new(tui, origin);
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        timed.tui.resize(170, 40);
        assert!(timed.input(b"", |s| s.contains("Board"))["error"].is_null());
        let click = timed::click(&timed.screen(), "Board");
        assert!(timed.input(&click, |s| s.contains("A new card"))["error"].is_null());
        let setup = timed.settled(&proxy, true);
        report.emit(json!({"kind":"setup_fence","added_rtt_ms":rtt,"fence":setup}));
        report.rss(
            rtt,
            "board_loaded",
            host.child.as_ref().unwrap().id(),
            timed.tui.child.id(),
        );
        if extended {
            pending::exercise(&mut timed, &runtime, &client, &proxy, rtt, report);
            return;
        }
        let before = timed.source(&runtime, &client, &proxy);
        let click = timed::click(&timed.screen(), "A new card");
        assert!(timed.input(&click, |s| s.contains("A new card"))["error"].is_null());
        let (input_row, input_col) = timed::position(&timed.screen(), "A new card");
        // Each insertion starts empty; its paired backspace restores that state.
        for index in 0..report.warmup() + report.count() {
            if !report.sample(
                rtt,
                "input_insert",
                index,
                timed.input(b"x", |screen| {
                    timed::field_character(screen, input_row, input_col, 'x')
                }),
            ) {
                break;
            }
            if !report.sample(
                rtt,
                "input_backspace",
                index,
                timed.input(b"\x7f", |screen| screen.contains("A new card")),
            ) {
                break;
            }
        }
        report.source(
            rtt,
            "input",
            &before,
            timed.source(&runtime, &client, &proxy),
        );
        let click = timed::click(&timed.screen(), "Board activity");
        assert!(timed.input(&click, |s| s.contains(READY))["error"].is_null());
        let click = timed::click(&timed.screen(), READY);
        assert!(timed.input(&click, |s| s.contains(READY))["error"].is_null());
        // An interior loaded record avoids the remote Newer/Older edge actions.
        timed.find(ANCHOR);
        let before = timed.source(&runtime, &client, &proxy);
        for index in 0..report.warmup() + report.count() {
            let (row, col) = timed::position(&timed.screen(), ANCHOR);
            let up = format!("\x1b[<64;{};{}M", col + 1, row + 1);
            if !report.sample(
                rtt,
                "loaded_scroll_up",
                index,
                timed.input(up.as_bytes(), |screen| {
                    screen
                        .lines()
                        .position(|line| line.contains(ANCHOR))
                        .is_some_and(|next| next > row)
                }),
            ) {
                break;
            }
            let (moved, col) = timed::position(&timed.screen(), ANCHOR);
            let down = format!("\x1b[<65;{};{}M", col + 1, moved + 1);
            if !report.sample(
                rtt,
                "loaded_scroll_down",
                index,
                timed.input(down.as_bytes(), |screen| {
                    screen.lines().position(|line| line.contains(ANCHOR)) == Some(row)
                }),
            ) {
                break;
            }
        }
        report.source(
            rtt,
            "loaded_scroll",
            &before,
            timed.source(&runtime, &client, &proxy),
        );
        timed.find("Board report end — 完整记录。");
        assert!(timed.screen().contains("Read × 2"));
        let before = timed.source(&runtime, &client, &proxy);
        for index in 0..report.warmup() + report.count() {
            let bytes = timed::click(&timed.screen(), "Read × 2");
            if !report.sample(
                rtt,
                "disclosure_open",
                index,
                timed.input(&bytes, |screen| screen.contains("Read cards")),
            ) {
                break;
            }
            let bytes = timed::click(&timed.screen(), "Read × 2");
            if !report.sample(
                rtt,
                "disclosure_close",
                index,
                timed.input(&bytes, |screen| !screen.contains("Read cards")),
            ) {
                break;
            }
        }
        report.source(
            rtt,
            "disclosure",
            &before,
            timed.source(&runtime, &client, &proxy),
        );
        report.rss(
            rtt,
            "operations_finished",
            host.child.as_ref().unwrap().id(),
            timed.tui.child.id(),
        );
    }));
    if let Err(error) = outcome {
        let message = error
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| error.downcast_ref::<&str>().copied())
            .unwrap_or("non-string panic");
        report.emit(json!({"kind":"case_error","added_rtt_ms":rtt,"error":message}));
        report.failures += 1;
    }
    if extended {
        runtime.block_on(remote(&client, "read-control", json!({"op":"release"})));
        timed.settled(&proxy, false);
    }
    // Close the interface through its real local command and let the Host drain.
    // CandidateFixture/Pty kill fallbacks are never counted as successful teardown.
    timed.tui.filter_command("Close interface only");
    timed.tui.click_text("Close interface only");
    timed.tui.finish();
    let closed = runtime.block_on(async {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let stats = remote(&client, "activity-stats", Value::Null).await;
            if stats["active"] == 0 || Instant::now() >= deadline {
                break stats;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    });
    let fence = proxy.fence();
    report.emit(json!({"kind":"source_closed","added_rtt_ms":rtt,"stats":closed,"fence":fence}));
    if closed["active"] != 0 || closed["closed"] != closed["opened"] || fence["live_documents"] != 0
    {
        report.failures += 1;
    }
    let records = runtime.block_on(proxy.stop());
    report.wire(rtt, records);
    client.disconnect();
    runtime.block_on(async {
        client.closed().await;
        notices.await.unwrap();
    });
    host.retire_registered();
    let status = host.wait_for_exit();
    report.emit(
        json!({"kind":"drain","added_rtt_ms":rtt,"host_success":status.success(),
        "registration_removed":!host.registration.exists()}),
    );
    assert!(status.success() && !host.registration.exists());
}
