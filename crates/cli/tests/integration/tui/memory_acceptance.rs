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

use super::super::candidate::CandidateFixture;
use super::board::performance::proxy;
use super::*;
use maka_client::Client;
use maka_protocol::{
    Operation,
    plugin::{RemoteBinding, RemoteRequest, RemoteResult},
};
use serde_json::{Value, json};
use tokio::runtime::Runtime;

mod capacity;
mod case;
mod report;
mod sampler;

const PACKAGE: &str = "example.acceptance-memory";
const TITLE: &str = "Memory lab";

/// VmRSS is descriptive: the design specifies no process RSS pass threshold.
#[test]
#[ignore = "serial fixed-release Host+PTY RSS measurement; writes raw JSONL"]
fn ten_thousand_lines_page_stream_close_and_page_vm_rss() {
    assert!(
        std::path::Path::new("/proc/self/status").is_file(),
        "requires Linux /proc"
    );
    let mut log = report::Report::new();
    for size in [(120, 40), (55, 24)] {
        log.context = json!({"columns":size.0,"rows":size.1});
        let outcome =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(size, &mut log)));
        log.caught("case", outcome);
    }
    log.finish();
    assert_eq!(log.failures, 0, "all raw failures are retained in JSONL");
}

fn run(size: (u16, u16), log: &mut report::Report) {
    let directory = tempfile::tempdir().unwrap();
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
    let origin = Instant::now();
    let mut sampler = sampler::Sampler::new(host.child.as_ref().unwrap().id(), origin);
    let runtime = Runtime::new().unwrap();
    let (mut client, mut notices, mut relay, mut terminal) = (None, None, None, None);
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        host.wait_for_registration();
        let (connected, pump) = runtime.block_on(proxy::connect(&host.root));
        client = Some(connected);
        notices = Some(pump);
        let client = client.as_ref().unwrap();
        relay = Some(runtime.block_on(proxy::DelayProxy::start(
            &host,
            directory.path(),
            Duration::ZERO,
            origin,
        )));
        terminal = Some(Pty::spawn(&["--root", host.root.to_str().unwrap()]));
        let tui = terminal.as_mut().unwrap();
        sampler.set_tui(tui.child.id());
        tui.wait_for("Settings");
        tui.click_text("Settings");
        tui.wait_for("Maka dark ▾");
        tui.resize(size.0, size.1);
        tui.wait_for("Maka dark ▾");
        sampler.mark("native_settings_before_install", 0);
        runtime.block_on(install(client, directory.path()));
        // The palette freezes its command catalog when opened. This ordinary
        // directory remains live while the TUI receives the Host's new entry.
        tui.command("Plugin pages");
        tui.wait_for(PACKAGE);
        tui.wait_for(TITLE);
        tui.command("Open settings");
        tui.wait_for("Maka dark ▾");
        sampler.mark("native_settings_after_install", 0);
        log.emit(
            json!({"kind":"baseline","at_ns":origin.elapsed().as_nanos() as u64,
            "page":"native Settings","equivalent_transcript_source":false,
            "stats":runtime.block_on(case::stats(client))}),
        );
        capacity::measure(&runtime, &host.root, &mut sampler, log, "capacity_before");
        case::exercise(
            tui,
            &runtime,
            client,
            relay.as_ref().unwrap(),
            &mut sampler,
            log,
            origin,
        );
        capacity::measure(&runtime, &host.root, &mut sampler, log, "capacity_after");
        sampler.mark("final_native_settings", 0);
    }));
    log.caught("scenario", outcome);
    sampler.mark("before_interface_close", 0);
    log.memory(sampler.stop()); // Join the 10 ms observer before any process exits.
    log.emit(json!({"kind":"rss_sampler_joined","joined":true,"target_period_ms":10}));
    if let Some(tui) = terminal.as_mut() {
        let close = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            // A failed setup can leave the palette open. Close that known
            // modal and observe dismissal before starting a new palette.
            if tui.screen.snapshot().unwrap().screen.contains("Commands") {
                tui.send(b"\x1b");
                tui.wait_until(|screen| {
                    !screen.contains("Commands") && !screen.contains("No matching commands.")
                });
            }
            tui.filter_command("Close interface only");
            tui.click_text("Close interface only");
            tui.finish();
        }));
        let normal = close.is_ok();
        log.caught("interface_close", close);
        log.emit(json!({"kind":"interface_closed","normal":normal}));
    }
    if let Some(client) = &client {
        let resources = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let stats = runtime.block_on(case::closed(client));
            log.emit(json!({"kind":"resources_closed","stats":stats}));
        }));
        log.caught("resource_close", resources);
    }
    if let Some(proxy) = relay {
        let fence = proxy.fence();
        if fence["live_documents"] != 0 {
            log.failures += 1;
        }
        log.emit(json!({"kind":"wire_fence_before_stop","fence":fence,"records_seen":proxy.records().len()}));
        log.wire(runtime.block_on(proxy.stop()));
    }
    if let Some(client) = client {
        client.disconnect();
        runtime.block_on(client.closed());
    }
    if let Some(pump) = notices {
        runtime.block_on(pump).unwrap();
    }
    host.retire_registered();
    let status = host.wait_for_exit();
    log.emit(json!({"kind":"host_drain","success":status.success(),"registration_removed":!host.registration.exists()}));
    assert!(
        status.success() && !host.registration.exists(),
        "Host did not drain normally"
    );
}

fn follow_tail(
    tui: &mut Pty,
    runtime: &Runtime,
    client: &Client,
    log: &mut report::Report,
    origin: Instant,
    marker: &str,
) {
    // Newer already delivered the last source window. Local find + PageDown
    // resumes following without starting a redundant asynchronous Tail read.
    case::find(tui, marker);
    let before = runtime.block_on(case::stats(client));
    let mut meter = super::fault_acceptance::measure::Meter::new(origin);
    let frame = meter.input(tui, b"\x1b[6~", |screen| case::visible(screen, marker));
    let after = runtime.block_on(case::stats(client));
    log.emit(
        json!({"kind":"local_tail_follow","marker":marker,"frame":frame,
        "before":before,"after":after,"metric":"complete frame barrier; not latency acceptance"}),
    );
    assert!(
        frame["error"].is_null(),
        "local tail following did not paint: {frame}"
    );
    assert_eq!(
        before["pageReads"], after["pageReads"],
        "following an already loaded tail fetched history"
    );
    assert_eq!(before["viewReads"], after["viewReads"]);
}

async fn install(client: &Client, directory: &std::path::Path) {
    let package = directory.join("memory-plugin");
    std::fs::create_dir(&package).unwrap();
    std::fs::write(
        package.join("host.mjs"),
        include_str!("../../fixtures/memory-plugin/host.mjs"),
    )
    .unwrap();
    std::fs::write(
        package.join("memory-ui.mjs"),
        include_str!("../../fixtures/memory-plugin/memory-ui.mjs"),
    )
    .unwrap();
    std::fs::write(
        package.join("maka.extension.json"),
        json!({"schemaVersion":1,"id":PACKAGE,
        "runtime":{"entry":"host.mjs","sdkVersion":2}})
        .to_string(),
    )
    .unwrap();
    client
        .request(
            Operation::PluginPackageInstall,
            json!({"sourcePath":package}),
        )
        .await
        .unwrap();
    client
        .request(
            Operation::PluginCompositionApply,
            json!({"operations":[{"type":"insert","rootId":"profile",
        "entry":{"id":PACKAGE,"packageId":PACKAGE}}]}),
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let status = client
                .request(Operation::PluginPlatformQuery, json!({"view":"status"}))
                .await
                .unwrap();
            if status["convergence"] == "converged" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("memory fixture activation did not converge");
    let source = case::stats(client).await;
    assert_eq!(source["sourceBlocks"], 1000);
    assert_eq!(source["initialLogicalLines"], 10_000);
    assert!(source["initialSourceBytes"].as_u64().unwrap() < 32 * 1024 * 1024);
    assert_eq!(source["activations"], 1);
}
