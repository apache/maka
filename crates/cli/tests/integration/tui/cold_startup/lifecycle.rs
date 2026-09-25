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
use maka_client::Client;
use maka_client::local::{Discovery, open_stream, read_discovery};
use maka_event_log::root::{RootNamespaces, RootOwner};
use std::path::{Path, PathBuf};
use tokio::task::JoinHandle;

pub(super) async fn disconnect(client: Client, notices: JoinHandle<()>) {
    client.disconnect();
    client.closed().await;
    notices.await.unwrap();
}

/// This observer never starts a Host: only the measured TUI may launch it.
pub(super) async fn observe(
    root: PathBuf,
    origin: Instant,
) -> (Value, Option<(Client, JoinHandle<()>)>) {
    let now = || origin.elapsed().as_nanos() as u64;
    let started = now();
    let deadline = Instant::now() + Duration::from_secs(12);
    let mut attempts = Vec::new();
    loop {
        let start = now();
        let result = tokio::time::timeout(Duration::from_secs(2), connect_once(&root)).await;
        let result = result.unwrap_or_else(|_| Err("discovery/handshake timeout".into()));
        match result {
            Ok((client, notices, pid)) => {
                let response = tokio::time::timeout(
                    Duration::from_secs(2),
                    client.request(Operation::HostStatus, json!({})),
                )
                .await;
                let end = now();
                let ready = matches!(&response, Ok(Ok(value)) if value["state"] == "ready");
                attempts.push(json!({"start_ns":start,"end_ns":end,
                    "response":format!("{response:?}"),"ready":ready}));
                if ready {
                    return (
                        json!({"kind":"host_ready_observation","observer_started_ns":started,
                        "observed_ns":end,"pid":pid,"root_id":client.identity.root_id,
                        "host_epoch":client.identity.host_epoch,
                        "requested_retry_interval_ns":1_000_000,"attempts":attempts,
                        "internal_ready_event_ns":null,"error":null}),
                        Some((client, notices)),
                    );
                }
                disconnect(client, notices).await;
            }
            Err(error) => attempts.push(json!({"start_ns":start,"end_ns":now(),"error":error})),
        }
        if Instant::now() >= deadline {
            return (
                json!({"kind":"host_ready_observation","observer_started_ns":started,
                "observed_ns":null,"attempts":attempts,"error":"ready observation timeout"}),
                None,
            );
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}

async fn connect_once(root: &Path) -> Result<(Client, JoinHandle<()>, u32), String> {
    let discovery = read_discovery(root).map_err(|error| error.to_string())?;
    let stream = open_stream(&discovery.endpoint)
        .await
        .map_err(|error| error.to_string())?;
    let (client, mut notices) = Client::connect(
        stream,
        &discovery.root_id,
        &discovery.host_epoch,
        maka_client::Operations,
    )
    .await
    .map_err(|error| error.to_string())?;
    let pump = tokio::spawn(async move { while notices.recv().await.is_some() {} });
    Ok((client, pump, discovery.pid.get()))
}

pub(super) fn close(tui: &mut Pty) {
    tui.filter_command("Close interface only");
    tui.click_text("Close interface only");
    tui.finish();
}

pub(super) async fn resources(client: &Client) -> Value {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let result = fixture::remote(client, PACKAGE, "stats", Value::Null).await;
        if result.as_ref().map_or(true, |stats| stats["active"] == 0) || Instant::now() >= deadline
        {
            return match result {
                Ok(stats) => {
                    json!({"success":stats["active"] == 0 && stats["closed"] == stats["opened"],"stats":stats})
                }
                Err(error) => json!({"success":false,"error":error}),
            };
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}

/// Retirement targets this fixture's exact live epoch, never a historical PID.
pub(super) fn retire(host: &mut CandidateFixture) -> Value {
    let discovery = read_discovery(&host.root).unwrap();
    retire_observed(host, &discovery)
}

pub(super) fn retire_observed(host: &mut CandidateFixture, discovery: &Discovery) -> Value {
    let origin = Instant::now();
    assert_eq!(discovery.root_id, host.root_id);
    let current = read_discovery(&host.root);
    if !current.as_ref().is_ok_and(|current| {
        current.root_id == discovery.root_id
            && current.host_epoch == discovery.host_epoch
            && current.pid == discovery.pid
    }) {
        return json!({"kind":"host_drain","success":false,
            "expected_root_id":discovery.root_id,"expected_host_epoch":discovery.host_epoch,
            "pid":discovery.pid.get(),"retire_attempted":false,
            "error":current.err().map_or_else(
                || "observed Host identity changed before retirement".to_owned(),
                |error| format!("observed Host disappeared before retirement: {error}"))});
    }
    let result = Command::new(env!("CARGO_BIN_EXE_maka"))
        .args(["host", "retire", "--root"])
        .arg(&host.root)
        .args(["--expected-host-epoch", &discovery.host_epoch])
        .output()
        .unwrap();
    let mut child_exit = None;
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut observations = Vec::new();
    loop {
        if let Some(child) = &mut host.child
            && let Some(status) = child.try_wait().unwrap()
        {
            child_exit = Some(status.success());
            host.child.take();
        }
        let released =
            RootOwner::open(&host.root, &RootNamespaces::for_current_account().unwrap()).is_ok();
        let state = process_state(discovery.pid.get());
        let exited = matches!(state.as_deref(), None | Some("Z"));
        let gone = !host.registration.exists();
        observations.push(json!({"at_ns":origin.elapsed().as_nanos() as u64,
            "registration_removed":gone,"root_released":released,"process_state":state}));
        if (released && gone && exited && host.child.is_none()) || Instant::now() >= deadline {
            return json!({"kind":"host_drain","duration_ns":origin.elapsed().as_nanos() as u64,
                "success":result.status.success() && released && gone && exited && child_exit != Some(false),
                "retire_exit_success":result.status.success(),"host_child_exit_success":child_exit,
                "pid":discovery.pid.get(),"expected_host_epoch":discovery.host_epoch,
                "host_exit_status":"only available for the directly owned attach/preparation child",
                "registration_removed":gone,"root_released":released,"process_exited":exited,
                "process_reaped":state.is_none(),"observations":observations,
                "retire_stdout":String::from_utf8_lossy(&result.stdout),
                "retire_stderr":String::from_utf8_lossy(&result.stderr)});
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn process_state(pid: u32) -> Option<String> {
    // A zombie has exited, but is reported separately from a reaped process.
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => Some(
            stat.rsplit_once(") ")
                .and_then(|(_, rest)| rest.split_whitespace().next())
                .unwrap_or("unparseable")
                .to_owned(),
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => Some(format!("unavailable: {error}")),
    }
}
