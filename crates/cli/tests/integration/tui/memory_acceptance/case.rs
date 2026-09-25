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
use maka_plugins::remote::Target;
use uuid::Uuid;

#[allow(clippy::too_many_arguments)]
pub(super) fn exercise(
    tui: &mut Pty,
    runtime: &Runtime,
    client: &Client,
    relay: &proxy::DelayProxy,
    sampler: &mut sampler::Sampler,
    log: &mut report::Report,
    origin: Instant,
) {
    sampler.mark("initial_load", 0);
    open(tui, "Memory end 0999");
    tui.click_text("Memory end 0999");
    note(runtime, client, relay, sampler, log, origin, "loaded", 0);
    // Walk every source page in both directions once, independently of the
    // subsequent repeated adjacent-window stress. Screen markers prove pages.
    for (index, edge) in [743, 487, 231].into_iter().enumerate() {
        sampler.mark("initial_older", index);
        tui.send(b"\x1b[H");
        wait_visible(tui, &format!("Memory end {edge:04}"));
        note(
            runtime,
            client,
            relay,
            sampler,
            log,
            origin,
            "initial_older",
            index,
        );
    }
    tui.send(b"\x1b[H");
    wait_visible(tui, "Memory block 0000");
    for (index, (last, first)) in [(231, 232), (487, 488), (743, 744)].into_iter().enumerate() {
        find(tui, &format!("Memory end {last:04}"));
        sampler.mark("initial_newer", index);
        tui.send(b"\x1b[6~");
        wait_visible(tui, &format!("Memory block {first:04}"));
        note(
            runtime,
            client,
            relay,
            sampler,
            log,
            origin,
            "initial_newer",
            index,
        );
    }
    follow_tail(tui, runtime, client, log, origin, "Memory end 0999");
    let cycles = if log.smoke { 2 } else { 100 };
    let rounds = if log.smoke { 2 } else { 10 };
    let mut tail = "Memory end 0999".to_owned();
    for cycle in 0..cycles {
        sampler.mark("paging_older", cycle);
        tui.send(b"\x1b[H");
        wait_visible(tui, "Memory end 0743");
        note(
            runtime,
            client,
            relay,
            sampler,
            log,
            origin,
            "paging_older",
            cycle,
        );
        sampler.mark("paging_newer", cycle);
        tui.send(b"\x1b[6~");
        wait_visible(tui, "Memory block 0744");
        follow_tail(tui, runtime, client, log, origin, &tail);
        note(
            runtime,
            client,
            relay,
            sampler,
            log,
            origin,
            "paging_newer",
            cycle,
        );
        let before = runtime.block_on(stats(client));
        sampler.mark("stream", cycle);
        for index in cycle * 3..cycle * 3 + 3 {
            let update = runtime.block_on(remote(client, "memory-append", json!(index)));
            tail = update["marker"].as_str().unwrap().to_owned();
            wait_visible(tui, &tail);
            log.emit(json!({"kind":"append","phase":"stream","iteration":cycle,"index":index,
                "at_ns":origin.elapsed().as_nanos() as u64,"bytes":update["bytes"],"visible_marker":tail}));
        }
        let after = runtime.block_on(stats(client));
        log.emit(json!({"kind":"stream_counts","iteration":cycle,"before":before,"after":after}));
        assert_eq!(
            before["viewReads"], after["viewReads"],
            "append reread the full View"
        );
        assert_eq!(
            before["pageReads"], after["pageReads"],
            "append fetched historical pages"
        );
        assert_eq!(after["appends"], (cycle + 1) * 3);
    }
    close(tui, runtime, client);
    note(
        runtime,
        client,
        relay,
        sampler,
        log,
        origin,
        "page_closed",
        0,
    );
    for round in 0..rounds {
        sampler.mark("reopen_loading", round);
        open(tui, &tail);
        note(
            runtime,
            client,
            relay,
            sampler,
            log,
            origin,
            "reopen_loaded",
            round,
        );
        close(tui, runtime, client);
        note(
            runtime,
            client,
            relay,
            sampler,
            log,
            origin,
            "reopen_closed",
            round,
        );
    }
    let final_stats = runtime.block_on(stats(client));
    assert_eq!(
        final_stats["activations"], 1,
        "opening a presenter reactivated the business plugin"
    );
    assert_eq!(final_stats["updates"], cycles * 3);
}

// Markdown soft breaks may put a marker on two terminal rows. Border glyphs
// delimit the viewport; they are not characters of the source text.
pub(super) fn visible(screen: &str, text: &str) -> bool {
    screen
        .replace(['│', '┃'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .contains(text)
}
fn wait_visible(tui: &mut Pty, text: &str) {
    tui.wait_until(|screen| visible(screen, text));
}

fn open(tui: &mut Pty, tail: &str) {
    tui.command(TITLE);
    tui.wait_for("10,000 source lines");
    wait_visible(tui, tail);
}
fn close(tui: &mut Pty, runtime: &Runtime, client: &Client) {
    tui.command("Open settings");
    tui.wait_for("Maka dark ▾");
    runtime.block_on(closed(client));
}
pub(super) fn find(tui: &mut Pty, query: &str) {
    tui.send(format!("\x06\x1b[200~{query}\x1b[201~").as_bytes());
    tui.wait_for("1/1");
    tui.send(b"\x1b");
    tui.wait_until(|screen| !screen.contains("1/1") && visible(screen, query));
}
#[allow(clippy::too_many_arguments)]
fn note(
    runtime: &Runtime,
    client: &Client,
    relay: &proxy::DelayProxy,
    sampler: &sampler::Sampler,
    log: &mut report::Report,
    origin: Instant,
    phase: &'static str,
    iteration: usize,
) {
    sampler.mark(phase, iteration);
    log.emit(json!({"kind":"phase","phase":phase,"iteration":iteration,"at_ns":origin.elapsed().as_nanos() as u64,
        "stats":runtime.block_on(stats(client)),"wire_fence":relay.fence(),
        "logical_source_lines_are_not_visual_rows":true}));
}

pub(super) async fn stats(client: &Client) -> Value {
    remote(client, "memory-stats", Value::Null).await
}
pub(super) async fn closed(client: &Client) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let value = stats(client).await;
            if value["active"] == 0 {
                assert_eq!(
                    value["closed"], value["opened"],
                    "resource close accounting: {value}"
                );
                return value;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("memory reader resources did not close")
}
pub(super) fn binding(method: &str) -> RemoteBinding {
    RemoteBinding::Package {
        package_id: PACKAGE.into(),
        method: method.into(),
        session_id: None,
    }
}
pub(super) async fn target(client: &Client, method: &str) -> Target {
    let result = client
        .plugin_remote(RemoteRequest::Bind {
            binding: binding(method),
        })
        .await
        .unwrap();
    let RemoteResult::Bound { target, .. } = result else {
        panic!("expected binding: {result:?}");
    };
    target
}
pub(super) async fn document(client: &Client) -> Uuid {
    let result = client
        .plugin_remote(RemoteRequest::OpenDocument)
        .await
        .unwrap();
    let RemoteResult::Document { document } = result else {
        panic!("expected document: {result:?}");
    };
    document
}
pub(super) async fn remote(client: &Client, method: &str, input: Value) -> Value {
    let target = target(client, method).await;
    let document = document(client).await;
    let response = client
        .plugin_remote(RemoteRequest::Call {
            binding: binding(method),
            target,
            document,
            input,
        })
        .await;
    let close = client
        .plugin_remote(RemoteRequest::CloseDocument { document })
        .await
        .unwrap();
    assert!(matches!(close, RemoteResult::Closed));
    let response = response.unwrap();
    let RemoteResult::Value { value } = response else {
        panic!("expected value: {response:?}");
    };
    value
}
