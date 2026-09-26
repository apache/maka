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

const ALPHA: &str = "Collection Alpha";
const BETA: &str = "Collection Beta";

pub(super) fn exercise(
    timed: &mut timed::Timed,
    runtime: &Runtime,
    client: &maka_client::Client,
    proxy: &proxy::DelayProxy,
    rtt: u64,
    report: &mut report::Report,
) {
    for title in [ALPHA, BETA] {
        runtime.block_on(remote(client, "add", json!(title)));
    }
    assert!(
        timed.input(b"", |screen| screen.contains(ALPHA)
            && screen.contains(BETA))["error"]
            .is_null()
    );
    timed.settled(proxy, false);
    let hold = gate::Hold::begin(timed, runtime, client, proxy);
    report.emit(json!({"kind":"pending_entered", "added_rtt_ms":rtt, "phase":"collection", "provider":hold.entered, "source":hold.before}));
    for index in 0..report.warmup() + report.count() {
        let click = timed::click(&timed.screen(), "Filter cards");
        assert!(timed.input(&click, |screen| screen.contains("Filter cards"))["error"].is_null());
        if !report.sample(
            rtt,
            "pending_collection_filter",
            index,
            hold.during(proxy, || {
                timed.input(b"b", |screen| {
                    screen.contains(BETA) && !screen.contains(ALPHA)
                })
            }),
        ) {
            break;
        }
        if !report.sample(
            rtt,
            "pending_collection_restore",
            index,
            hold.during(proxy, || {
                timed.input(b"\x7f", |screen| {
                    screen.contains(ALPHA) && screen.contains(BETA)
                })
            }),
        ) {
            break;
        }
        let (row, col) = timed::position(&timed.screen(), ALPHA);
        let (target_row, target_col) = timed::position(&timed.screen(), "Doing  0");
        let drag = format!(
            "\x1b[<0;{};{}M\x1b[<32;{};{}M",
            col + 1,
            row + 1,
            target_col + 1,
            target_row + 1
        );
        if !report.sample(
            rtt,
            "pending_collection_drag",
            index,
            hold.during(proxy, || {
                timed.input(drag.as_bytes(), |screen| {
                    screen.contains(ALPHA) && timed::position(screen, ALPHA).1 >= target_col
                })
            }),
        ) {
            break;
        }
        if !report.sample(
            rtt,
            "pending_collection_cancel",
            index,
            hold.during(proxy, || {
                timed.input(b"\x1b", |screen| {
                    screen.contains(ALPHA) && timed::position(screen, ALPHA).1 < target_col
                })
            }),
        ) {
            break;
        }
    }
    let evidence = hold.end(timed, runtime, client, proxy);
    report.source(
        rtt,
        "pending_collection",
        &evidence["before"],
        evidence["after"].clone(),
    );
    report.emit(json!({"kind":"pending_released", "added_rtt_ms":rtt, "phase":"collection", "evidence":evidence}));
    let cards = runtime.block_on(remote(client, "cards", Value::Null));
    assert!(
        cards
            .as_array()
            .unwrap()
            .iter()
            .all(|card| card["column"] == "todo"),
        "preview/cancel never changes durable card placement"
    );
}
