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

pub(super) fn run(host_mode: &str, target: &str, log: &mut measure::Log) -> Value {
    let directory = tempfile::tempdir().unwrap();
    let mut host = CandidateFixture::new(directory.path().join("root"));
    let runtime = Runtime::new().unwrap();
    let failures_before = log.failures;
    let checkpoint = directory
        .path()
        .join("tui-state")
        .join(&host.root_id)
        .join("startup/state.json");
    let mut preexisting_ready = Value::Null;
    if target != "empty" || host_mode == "attach" {
        fixture::serve(&mut host);
        let (client, notices) = runtime.block_on(fixture::connect(&host.root));
        if target != "empty" {
            runtime.block_on(fixture::install(
                &client,
                directory.path(),
                PACKAGE,
                TITLE,
                "shared",
            ));
            page::restored_checkpoint(&host, target);
            let resources = runtime.block_on(lifecycle::resources(&client));
            log.emit(json!({"kind":"preparation_resources","value":resources}));
            assert_eq!(resources["success"], true);
            assert!(checkpoint.is_file());
        }
        preexisting_ready = runtime
            .block_on(client.request(Operation::HostStatus, json!({})))
            .unwrap();
        assert_eq!(preexisting_ready["state"], "ready");
        runtime.block_on(lifecycle::disconnect(client, notices));
        if host_mode == "on_demand" {
            let drained = lifecycle::retire(&mut host);
            log.emit(json!({"kind":"preparation_host_drain","value":drained}));
            assert_eq!(drained["success"], true);
            preexisting_ready = Value::Null;
        }
    }
    let checkpoint_bytes = std::fs::read(&checkpoint).ok();
    assert_eq!(checkpoint_bytes.is_some(), target != "empty");
    if host_mode == "on_demand" {
        assert!(!host.registration.exists());
        assert!(
            maka_event_log::root::RootOwner::open(
                &host.root,
                &maka_event_log::root::RootNamespaces::for_current_account().unwrap()
            )
            .is_ok()
        );
    }
    log.emit(json!({"kind":"prepared", "root_id":host.root_id,
        "root_condition":"fresh synthetic Root, initialized before timing",
        "checkpoint_bytes":checkpoint_bytes.as_ref().map(Vec::len),
        "checkpoint_sha256":checkpoint_bytes.map(|bytes| format!("{:x}", Sha256::digest(bytes))),
        "host_ready_before_spawn":preexisting_ready,
        "data":{"sessions":0,"js_blocks":usize::from(target != "empty"),
            "js_logical_lines":if target == "empty" {0} else {60}},
        "installed_fixture":target != "empty","preparation_excluded":true}));

    // The existing fixture does not expose Command::spawn internally. Include
    // its small PTY/setup cost explicitly rather than inventing an exec time.
    let origin = Instant::now();
    let mut tui = page::spawn(&host);
    let mut meter = measure::Meter::new(origin);
    let spawn_returned = meter.now();
    let observer = runtime.spawn(lifecycle::observe(host.root.clone(), origin));
    log.emit(
        json!({"kind":"spawn","start_ns":0,"returned_ns":spawn_returned,"tui_pid":tui.child.id()}),
    );
    let shell = meter.wait(&mut tui, 0, 0, |screen| {
        screen.contains("New session") && screen.contains("Settings")
    });
    log.sample("spawn_to_first_shell_frame", shell.clone());
    let content =
        if shell["error"].is_null() && page::ready(shell["frame"].as_str().unwrap(), target) {
            let mut value = shell.clone();
            value["already_in_first_shell_frame"] = json!(true);
            value
        } else if shell["error"].is_null() {
            meter.wait(&mut tui, 0, 0, |screen| page::ready(screen, target))
        } else {
            json!({"error":"shell unavailable","duration_ns":null})
        };
    log.sample("spawn_to_target_content", content.clone());
    let interaction = if content["error"].is_null() {
        page::interact(&mut tui, &mut meter, target)
    } else {
        json!({"error":"target content unavailable","complete_frame_parsed_ns":null})
    };
    let interactive_ns = if interaction["error"].is_null() {
        interaction["complete_frame_parsed_ns"].clone()
    } else {
        Value::Null
    };
    log.sample("target_local_interaction", interaction.clone());
    let (mut ready, connection) = runtime.block_on(observer).unwrap();
    ready["ready_before_spawn"] = json!(host_mode == "attach");
    ready["interpretation"] = json!(if host_mode == "attach" {
        "post-spawn status reobservation; Host was already ready before t0"
    } else {
        "upper bound on on-demand Host readiness; probe is not the internal transition"
    });
    if !ready["error"].is_null() {
        log.failures += 1;
    }
    log.emit(ready.clone());
    log.rss("target_observed", "tui", tui.child.id());
    if let Some(pid) = ready["pid"].as_u64() {
        log.rss("target_observed", "host", pid as u32);
    }

    if interaction["error"].is_null() {
        page::reset_interaction(&mut tui, target);
    }
    // Inspect frames already observed, without waiting for attachment and hiding
    // the valid early-detach boundary exercised by restored native Settings.
    let current_frame = tui.screen.snapshot().unwrap().screen;
    let attachment_ns = [&shell, &content, &interaction]
        .into_iter()
        .find(|row| row["error"].is_null() && row["frame"].as_str().is_some_and(page::attached))
        .map(|row| row["complete_frame_parsed_ns"].clone())
        .or_else(|| {
            (tui.frames.ready() && page::attached(&current_frame)).then(|| json!(meter.now()))
        })
        .unwrap_or(Value::Null);
    log.emit(json!({"kind":"tui_attachment_observation","observed_ns":attachment_ns,
        "observed":!attachment_ns.is_null(),
        "basis":"complete frame with loaded empty Session catalog; not an internal handshake timestamp",
        "waited_for_attachment":false}));
    let captured = maka_client::local::read_discovery(&host.root).unwrap();
    assert_eq!(captured.root_id, host.root_id);
    if let Some((client, _)) = &connection {
        assert_eq!(captured.root_id, client.identity.root_id);
        assert_eq!(captured.host_epoch, client.identity.host_epoch);
    }
    log.emit(
        json!({"kind":"host_before_ui_close","root_id":captured.root_id,
        "host_epoch":captured.host_epoch,"pid":captured.pid.get()}),
    );
    let close_start = meter.now();
    lifecycle::close(&mut tui);
    log.emit(json!({"kind":"normal_ui_close","start_ns":close_start,"end_ns":meter.now(),"success":true}));
    if let Some((client, notices)) = connection {
        if target != "empty" {
            let resources = runtime.block_on(lifecycle::resources(&client));
            if resources["success"] != true {
                log.failures += 1;
            }
            log.emit(json!({"kind":"closed_resources","value":resources}));
        }
        runtime.block_on(lifecycle::disconnect(client, notices));
    } else if target != "empty" {
        log.failures += 1;
        log.emit(
            json!({"kind":"closed_resources","error":"Host observer unavailable","value":null}),
        );
    }
    let drained = lifecycle::retire_observed(&mut host, &captured);
    if drained["success"] != true {
        log.failures += 1;
    }
    log.emit(drained.clone());
    json!({"first_shell_frame_ns":shell["duration_ns"],
        "host_ready_observed_ns":ready["observed_ns"],
        "target_content_frame_ns":content["duration_ns"],
        "target_interactive_frame_ns":interactive_ns,
        "tui_attachment_observed_ns":attachment_ns,
        "interaction_sent_ns":interaction["start_ns"],
        "host_ready_internal_event_ns":null,"normal_cleanup":drained["success"],
        "error":(log.failures != failures_before).then_some("one or more observations or drains failed")})
}
