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

pub(super) mod gate;

pub(super) fn fixture(board: &str) -> String {
    let activation = "export default async function activate(ctx)";
    assert_eq!(
        board.matches(activation).count(),
        1,
        "single Board activation"
    );
    let board = board.replacen(activation, "async function activateBoard(ctx)", 1);
    format!("{board}\n{}", include_str!("gated.mjs"))
}

#[test]
#[ignore = "serial release Host+PTY pending-Read and drag acceptance; emits raw JSONL"]
fn pending_read_keeps_local_input_scroll_disclosure_and_drag_responsive() {
    let mut report = report::Report::scenario(
        "provider-held semantic Board Read; loaded local operations; idle/pending cell-style drag",
        &[
            "pending_input_insert",
            "pending_input_backspace",
            "pending_loaded_scroll_up",
            "pending_loaded_scroll_down",
            "pending_disclosure_open",
            "pending_disclosure_close",
            "idle_drag_extend",
            "idle_drag_shrink",
            "pending_drag_extend",
            "pending_drag_shrink",
        ],
    );
    for rtt in [0, 200] {
        run(rtt, &mut report, true);
    }
    report.finish();
    assert_eq!(
        report.failures, 0,
        "raw JSONL retains all observed failures"
    );
}

pub(super) fn exercise(
    timed: &mut timed::Timed,
    runtime: &Runtime,
    client: &maka_client::Client,
    proxy: &proxy::DelayProxy,
    rtt: u64,
    report: &mut report::Report,
) {
    timed.visual = Some(visual::Visual::new(timed.tui.screen.size()));
    // A real resize supplies a complete current screen to the visual observer;
    // ordinary text-only fixture setup above was deliberately not timed.
    for columns in [169, 170] {
        timed.tui.resize(columns, 40);
        assert!(timed.input(b"", |s| s.contains("A new card"))["error"].is_null());
    }
    timed.tui.send(&timed::click(&timed.screen(), "A new card"));
    phase(timed, runtime, client, proxy, report, (rtt, "input"));
    let click = timed::click(&timed.screen(), "Board activity");
    assert!(timed.input(&click, |s| s.contains(READY))["error"].is_null());
    timed.tui.send(&timed::click(&timed.screen(), READY));
    timed.settled(proxy, false);
    timed.find(ANCHOR);
    let before = timed.source(runtime, client, proxy);
    visual::drag(timed, proxy, report, rtt, None);
    report.source(
        rtt,
        "idle_drag",
        &before,
        timed.source(runtime, client, proxy),
    );
    phase(
        timed,
        runtime,
        client,
        proxy,
        report,
        (rtt, "loaded_scroll"),
    );
    phase(timed, runtime, client, proxy, report, (rtt, "drag"));
    timed.find("Board report end — 完整记录。");
    assert!(timed.screen().contains("Read × 2"));
    phase(timed, runtime, client, proxy, report, (rtt, "disclosure"));
}

fn phase(
    timed: &mut timed::Timed,
    runtime: &Runtime,
    client: &maka_client::Client,
    proxy: &proxy::DelayProxy,
    report: &mut report::Report,
    (rtt, phase): (u64, &str),
) {
    let hold = gate::Hold::begin(timed, runtime, client, proxy);
    report.emit(
        json!({"kind":"pending_entered","added_rtt_ms":rtt,"phase":phase,
        "provider":hold.entered,"source":hold.before}),
    );
    if phase == "drag" {
        visual::drag(timed, proxy, report, rtt, Some(&hold));
    } else {
        for index in 0..report.warmup() + report.count() {
            let completed = match phase {
                "input" => {
                    let (row, col) = timed::position(&timed.screen(), "A new card");
                    report.sample(
                        rtt,
                        "pending_input_insert",
                        index,
                        hold.during(proxy, || {
                            timed.input(b"x", |s| timed::field_character(s, row, col, 'x'))
                        }),
                    ) && report.sample(
                        rtt,
                        "pending_input_backspace",
                        index,
                        hold.during(proxy, || timed.input(b"\x7f", |s| s.contains("A new card"))),
                    )
                }
                "loaded_scroll" => {
                    let (row, col) = timed::position(&timed.screen(), ANCHOR);
                    let up = format!("\x1b[<64;{};{}M", col + 1, row + 1);
                    let ok = report.sample(
                        rtt,
                        "pending_loaded_scroll_up",
                        index,
                        hold.during(proxy, || {
                            timed.input(up.as_bytes(), |s| {
                                s.lines()
                                    .position(|line| line.contains(ANCHOR))
                                    .is_some_and(|next| next > row)
                            })
                        }),
                    );
                    if !ok {
                        false
                    } else {
                        let (moved, col) = timed::position(&timed.screen(), ANCHOR);
                        let down = format!("\x1b[<65;{};{}M", col + 1, moved + 1);
                        report.sample(
                            rtt,
                            "pending_loaded_scroll_down",
                            index,
                            hold.during(proxy, || {
                                timed.input(down.as_bytes(), |s| {
                                    s.lines().position(|line| line.contains(ANCHOR)) == Some(row)
                                })
                            }),
                        )
                    }
                }
                "disclosure" => {
                    let open = timed::click(&timed.screen(), "Read × 2");
                    let ok = report.sample(
                        rtt,
                        "pending_disclosure_open",
                        index,
                        hold.during(proxy, || timed.input(&open, |s| s.contains("Read cards"))),
                    );
                    if !ok {
                        false
                    } else {
                        let close = timed::click(&timed.screen(), "Read × 2");
                        report.sample(
                            rtt,
                            "pending_disclosure_close",
                            index,
                            hold.during(proxy, || {
                                timed.input(&close, |s| !s.contains("Read cards"))
                            }),
                        )
                    }
                }
                _ => unreachable!(),
            };
            if !completed {
                break;
            }
        }
    }
    let evidence = hold.end(timed, runtime, client, proxy);
    report.source(
        rtt,
        &format!("pending_{phase}"),
        &evidence["before"],
        evidence["after"].clone(),
    );
    report.emit(
        json!({"kind":"pending_released","added_rtt_ms":rtt,"phase":phase,"evidence":evidence}),
    );
}
