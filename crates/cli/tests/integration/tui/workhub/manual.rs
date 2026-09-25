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

use super::{composition, model, readback, support};
use maka_event_log::root::{RootNamespaces, RootOwner};
use maka_runtime_host::server::{Host, HostOptions, local::LocalListener};
use serde_json::{Value, json};
use std::{fs, io::Write, os::unix::fs::PermissionsExt, time::Duration};
use tokio_util::sync::CancellationToken;

mod provider;

/// Run this exact ignored test from the compiled integration binary with
/// --ignored --nocapture. Open the printed Root in the frozen TUI binary.
/// All connections, consent, creation defaults and delegation begin in that TUI.
#[test]
#[ignore = "interactive isolated WorkHub Host with a controlled model, not Luna"]
fn manual_smoke_host() {
    let directory = tempfile::Builder::new()
        .prefix("maka-workhub-manual-")
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap();
    let workspace = directory.path().join("workspace");
    let skill_home = directory.path().join("user-library");
    let tui_state = directory.path().join("tui-state");
    for path in [&workspace, &skill_home, &tui_state] {
        fs::create_dir_all(path).unwrap();
    }
    let fixture = crate::candidate::CandidateFixture::new(directory.path().join("root"));
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let stop = CancellationToken::new();
    let _cleanup = stop.clone().drop_guard();
    let (server, registration, client, model) = runtime.block_on(async {
        let owner = RootOwner::open(
            &fixture.root,
            &RootNamespaces::for_current_account().unwrap(),
        )
        .unwrap();
        let host = Host::open_with_options(
            owner,
            None,
            HostOptions {
                skill_home: Some(skill_home.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let socket = directory.path().join("host.sock");
        let listener = LocalListener::bind(&socket).unwrap();
        let registration = host.publish_registration(&socket, None).unwrap();
        let server = tokio::spawn(listener.serve(host, stop.clone()));
        let client = support::client(&fixture.root).await;
        (server, registration, client, provider::start().await)
    });
    let notes_source = directory.path().join("workhub-notes-plugin");
    println!(
        "{}",
        json!({
            "root":fixture.root, "workspace":workspace, "skillHome":skill_home,
            "providerUrl":model.url, "provider":"Controlled WorkHub fixture; not a real model or Luna",
            "modelIds":["fixture-model","worker-model"],
            "tuiStateDirectory":tui_state, "makaBinary":env!("CARGO_BIN_EXE_maka"),
            "notesSource":notes_source,
            "commands":{"notes":"Write and install the notes source while the TUI is running",
                "emptyLine":"Close the TUI first, then press Enter here to drain this Host"}
        })
    );
    std::io::stdout().flush().unwrap();
    let mut installed = false;
    loop {
        let mut line = String::new();
        if std::io::stdin().read_line(&mut line).unwrap() == 0 || line.trim().is_empty() {
            break;
        }
        match line.trim() {
            "notes" if !installed => {
                runtime.block_on(composition::install(&client, directory.path()));
                installed = true;
                println!("{}", json!({"notesInstalled":true,"source":notes_source}));
            }
            "notes" => println!("Notes are already installed; no operation repeated."),
            _ => println!(
                "Type notes to install the filler, or an empty line after closing the TUI."
            ),
        }
        std::io::stdout().flush().unwrap();
    }
    let assignments =
        runtime.block_on(readback::hub(&client, "assignments", json!({"after":null})));
    println!(
        "{}",
        json!({"assignments":assignments,
        "delegated":model.delegated.lock().unwrap().clone(),
        "executed":model.executed.lock().unwrap().clone()})
    );
    client.disconnect();
    stop.cancel();
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(10), server)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        model.task.abort();
        if let Err(error) = model.task.await {
            assert!(error.is_cancelled(), "controlled provider failed: {error}");
        }
    });
    registration.remove().unwrap();
    println!("WorkHub manual Host drained; its registration removed.");
}
