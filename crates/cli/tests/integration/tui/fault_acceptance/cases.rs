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
use fixture::{DEDICATED, FAULT, SHARED, remote};

pub(super) fn run(vm: &str, mode: &str, log: &mut measure::Log) {
    log.context = json!({"vm":vm,"fault":mode});
    let directory = tempfile::tempdir().unwrap();
    let mut host = CandidateFixture::new(directory.path().join("root"));
    fixture::serve(&mut host);
    let runtime = Runtime::new().unwrap();
    let (client, notices) = runtime.block_on(fixture::connect(&host.root));
    runtime.block_on(async {
        for (package, title, allocation) in [
            (FAULT, "Fault lab", vm),
            (SHARED, "Shared witness", "shared"),
            (DEDICATED, "Dedicated witness", "dedicated"),
        ] {
            fixture::install(&client, directory.path(), package, title, allocation).await;
        }
    });
    let mut tui = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    let mut meter = measure::Meter::new(Instant::now());
    let mut probes = Vec::new();
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        tui.wait_for("Fault lab");
        tui.click_text("Fault lab");
        tui.wait_for("Last-good acceptance content");
        tui.wait_for("Retained record 059");
        tui.click_page_text("Retained record 059");
        tui.send(b"\x06\x1b[200~Retained record 040\x1b[201~");
        tui.wait_for("1/1");
        tui.send(b"\x1b");
        tui.wait_until(|screen| !screen.contains("1/1") && screen.contains("Retained record 040"));
        log.rss("before_fault", "host", host.child.as_ref().unwrap().id());
        log.rss("before_fault", "tui", tui.child.id());
        let trigger_ns = meter.now();
        let control = runtime.block_on(remote(
            &client,
            FAULT,
            "control",
            json!({"mode":mode, "refresh":mode != "runaway_submit"}),
        ));
        log.emit(
            json!({"kind":"trigger", "start_ns":trigger_ns,"end_ns":meter.now(),
            "control":control}),
        );
        if mode == "runaway_submit" {
            tui.send(&fixture::click(
                &tui.screen.snapshot().unwrap().screen,
                "Run presenter",
            ));
        }
        let arm = control.as_ref().expect("fault armed")["arm"]
            .as_u64()
            .unwrap();
        let entered = runtime.block_on(fixture::entered(&host.root, arm));
        assert_eq!(entered["mode"], mode);
        assert_eq!(
            entered["callback"],
            match mode {
                "runaway_submit" => "submit",
                "overflow" => "control",
                _ => "read",
            }
        );
        log.emit(
            json!({"kind":"backend_entry_barrier", "observed_ns":meter.now(),
            "marker":entered, "source":"read-only plugin_data in this fresh Root",
            "phase":if mode == "overflow" {"after bounded synchronous burst reply"}
                else if matches!(mode, "invalid" | "duplicate" | "oversized") {
                    "UI invoked its backend before samples; invalid reply may already have settled"
                } else {"UI invoked its backend before samples; loop-entry time is not observed"}}),
        );
        if matches!(mode, "invalid" | "duplicate" | "oversized") {
            // Exercise retained content after rejection has reached the UI,
            // rather than racing the still-valid frame ahead of that reply.
            tui.wait_for("This page could not be loaded or saved.");
            log.emit(json!({"kind":"page_failure_observed", "at_ns":meter.now(),
                "frame":tui.screen.snapshot().unwrap().screen}));
        }
        probes = spawn_probes(&runtime, &client, mode.starts_with("runaway"), meter.origin);
        let screen = tui.screen.snapshot().unwrap().screen;
        if let Some((row, col)) = fixture::position(&screen, "Retained record 040") {
            let before = visible_records(&screen);
            assert!(before.len() >= 2 && before[0] >= 3 && before[1] == before[0] + 1);
            let expected = [before[0] - 3, before[1] - 3];
            let bytes = format!("\x1b[<64;{};{}M", col + 1, row + 1);
            // Reader wheel-up moves three source lines. A notice shifting every
            // physical row cannot satisfy this change in visible source content.
            let mut sample = meter.input(&mut tui, bytes.as_bytes(), |next| {
                visible_records(next).starts_with(&expected)
            });
            sample["before_records"] = json!(before);
            sample["after_records"] =
                json!(visible_records(&tui.screen.snapshot().unwrap().screen));
            sample["before_frame"] = json!(screen);
            log.sample("cached_scroll", sample);
        } else {
            log.failures += 1;
            log.emit(json!({"kind":"missing_cached_anchor"}));
        }
        log.sample(
            "palette_open",
            meter.input(&mut tui, b"\x10", |screen| {
                screen.contains("Search commands…")
            }),
        );
        log.sample(
            "shell_input",
            meter.input(&mut tui, b"faultprobe", |screen| {
                screen.contains("faultprobe")
            }),
        );
        log.sample(
            "palette_close",
            meter.input(&mut tui, b"\x1b", |screen| !screen.contains("faultprobe")),
        );
        log.sample(
            "ctrl_q_confirmation",
            meter.input(&mut tui, b"\x11", |screen| screen.contains("Force quit")),
        );
        // Enter is the existing safe default: cancellation, never force shutdown.
        log.sample(
            "ctrl_q_default_cancel",
            meter.input(&mut tui, b"\r", |screen| !screen.contains("Force quit")),
        );
        log.emit(json!({"kind":"post_fault_frame", "at_ns":meter.now(),
            "last_good_visible":tui.screen.snapshot().unwrap().screen.contains("Last-good acceptance content"),
            "frame":tui.screen.snapshot().unwrap().screen}));
        let before_leave = runtime.block_on(remote(&client, FAULT, "stats", Value::Null));
        log.emit(json!({"kind":"before_leave", "at_ns":meter.now(), "stats":before_leave}));
        if let Ok(stats) = &before_leave {
            if mode == "overflow" && stats["invalidated"].as_u64().unwrap_or(0) == 0 {
                log.failures += 1;
            }
            if !matches!(mode, "runaway_submit" | "overflow") && stats["entered"] == 0 {
                log.failures += 1;
            }
        } else {
            log.failures += 1;
        }
        // A native page still loads, and leaving the remote page retires its reads.
        let leave_ns = meter.now();
        tui.command("Open settings");
        tui.wait_for("Appearance");
        tui.click_page_text("Appearance");
        tui.wait_for("Maka dark ▾");
        log.emit(
            json!({"kind":"native_page_after_fault", "start_ns":leave_ns,
            "complete_frame_parsed_ns":meter.now(), "frame":tui.screen.snapshot().unwrap().screen}),
        );
    }));
    if let Err(error) = outcome {
        log.failures += 1;
        let message = error
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| error.downcast_ref::<&str>().copied())
            .unwrap_or("non-string panic");
        log.emit(json!({"kind":"case_error","error":message}));
    }
    for probe in probes {
        let observation = runtime.block_on(probe).unwrap();
        if observation["observations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|sample| sample["result"].get("Err").is_some())
        {
            log.failures += 1;
        }
        log.emit(observation);
    }
    // Explicit normal UI close; fallback process kills cannot produce a pass.
    tui.filter_command("Close interface only");
    tui.click_text("Close interface only");
    tui.finish();
    let settled = runtime.block_on(async {
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            let result = remote(&client, FAULT, "stats", Value::Null).await;
            if result.as_ref().map_or(true, |value| value["active"] == 0)
                || Instant::now() >= deadline
            {
                break result;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    });
    if let Ok(stats) = &settled {
        if stats["active"] != 0 || stats["closed"] != stats["opened"] {
            log.failures += 1;
        }
    } else {
        // UI failures must leave their business activation available. Closing
        // the page and its sources is the proof; UI code cannot write counters.
        log.failures += 1;
    }
    log.emit(
        json!({"kind":"closed_resources", "at_ns":meter.now(),"stats":settled,
        "stats_required":true,
        "business_scope":"all UI fault modes must preserve the original business activation"}),
    );
    for package in [SHARED, DEDICATED] {
        let result = runtime.block_on(remote(&client, package, "ping", Value::Null));
        if result.is_err() {
            log.failures += 1;
        }
        log.emit(json!({"kind":"witness_after_retirement","package":package,"result":result}));
    }
    log.emit(json!({"kind":"host_after_close","result":runtime.block_on(
        client.request(Operation::HostDiagnosticsQuery, json!({}))).map_err(|error| error.to_string())}));
    log.rss("after_close", "host", host.child.as_ref().unwrap().id());
    client.disconnect();
    runtime.block_on(async {
        client.closed().await;
        notices.await.unwrap();
    });
    let start = meter.now();
    host.retire_registered();
    let status = host.wait_for_exit();
    let released = maka_event_log::root::RootOwner::open(
        &host.root,
        &maka_event_log::root::RootNamespaces::for_current_account().unwrap(),
    )
    .is_ok();
    log.emit(
        json!({"kind":"host_drain", "start_ns":start,"end_ns":meter.now(),
        "duration_ns":meter.now() - start,"success":status.success(),
        "registration_removed":!host.registration.exists(),"root_released":released}),
    );
    if !status.success() || host.registration.exists() || !released {
        log.failures += 1;
    }
}

fn visible_records(screen: &str) -> Vec<u16> {
    screen
        .lines()
        .filter_map(|line| {
            let (_, record) = line.split_once("Retained record ")?;
            record.get(..3)?.parse().ok()
        })
        .collect()
}

fn spawn_probes(
    runtime: &Runtime,
    client: &maka_client::Client,
    repeated: bool,
    origin: Instant,
) -> Vec<tokio::task::JoinHandle<Value>> {
    ["native_host", SHARED, DEDICATED].into_iter().map(|package| {
        let client = client.clone();
        runtime.spawn(async move {
            let deadline = Instant::now() + Duration::from_secs(6);
            let mut rows = Vec::new();
            loop {
                let start = origin.elapsed().as_nanos() as u64;
                let result = if package == "native_host" {
                    client.request(Operation::HostStatus, json!({})).await.map_err(|error| error.to_string())
                } else { remote(&client, package, "ping", Value::Null).await };
                let failed = result.is_err();
                rows.push(json!({"start_ns":start,"end_ns":origin.elapsed().as_nanos() as u64,"result":result}));
                if !repeated || failed || Instant::now() >= deadline { break; }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            json!({"kind":"witness_during_fault","package":package,"observations":rows})
        })
    }).collect()
}
