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

//! Starts the real Runtime Host candidate from the Maka checkout on a fresh
//! State Root under `target/tmp`, connects, calls `host.status`, and waits
//! for the Host to exit on its own after a short idle grace.
//!
//! ```sh
//! MAKA_REPO=~/code/maka-pin cargo test -p host-client --test real_candidate -- --ignored --nocapture
//! ```
//!
//! Ignored by default, and a no-op without `MAKA_REPO`: it needs a built
//! checkout (`docs/dev-host.md`) and a Node discovered as the app discovers
//! it (`MAKA_NODE`, `node` on `PATH`, nvm). It never touches an existing
//! State Root. Provider keys are removed from the candidate's environment so
//! the fresh root does not import one. Afterwards it deletes the scratch
//! root and the Host's control directory and owner lock for that root.
#![allow(clippy::disallowed_methods)]

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use futures_lite::future;
use host_client::{
    CandidateProcess, Connected, LaunchObserver, LaunchOptions, Launched, MAKA_REPO_ENV,
    NodeRuntime, REGISTRATION_FILE, connect_or_spawn, control_directory, random_client_instance_id,
};
use host_protocol::{ClientHello, HostLifecycleState};

const IDLE_GRACE: Duration = Duration::from_secs(2);

struct Report(Instant);

impl LaunchObserver for Report {
    async fn candidate_spawned(&self, candidate: &CandidateProcess) {
        eprintln!(
            "[{:>6} ms] spawned candidate pid {} (startup attempt {})",
            self.0.elapsed().as_millis(),
            candidate.pid(),
            candidate.startup_attempt_id()
        );
    }
}

#[test]
#[ignore = "starts a real Runtime Host from $MAKA_REPO; run with --ignored"]
fn the_real_candidate_starts_answers_and_idles_out() {
    if std::env::var_os(MAKA_REPO_ENV).is_none() {
        eprintln!("skipped: {MAKA_REPO_ENV} is not set");
        return;
    }
    let scratch = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("real-candidate-{}", uuid::Uuid::new_v4().simple()));
    let root = scratch.join("state-root");
    let started = Instant::now();
    let at = || format!("[{:>6} ms]", started.elapsed().as_millis());

    let node = future::block_on(NodeRuntime::discover()).expect("a Node to run the Host");
    eprintln!(
        "{} node {} ({:?}, {:?})",
        at(),
        node.path().display(),
        node.source(),
        node.version()
    );
    let options = LaunchOptions::default()
        .idle_grace(IDLE_GRACE)
        .env_remove("DEEPSEEK_API_KEY")
        .env_remove("ANTHROPIC_API_KEY")
        .env_remove("OPENAI_API_KEY");
    let hello = ClientHello::new(random_client_instance_id());
    let Launched { connected, root: prepared, registration, spawned, .. } =
        future::block_on(connect_or_spawn(&root, hello, &options, &Report(started)))
            .expect("connect or spawn");
    let spawned = spawned.expect("no Host ran for a new root, so this call spawned one");
    eprintln!(
        "{} registration: pid {} rootId {} state {} lifecycle {:?} endpoint {}",
        at(),
        registration.pid,
        registration.root_id,
        registration.state,
        registration.lifecycle_mode,
        registration.endpoint
    );
    assert!(prepared.created);
    assert_eq!(registration.pid, spawned.pid());

    let Connected { connection, pump, .. } = connected;
    let (pump_result, status) = future::block_on(future::zip(pump, async {
        let ready = connection.wait_until_ready(Duration::from_secs(60)).await;
        let status = connection.host_status().await;
        connection.shutdown();
        (ready, status)
    }));
    let (ready, status) = status;
    let ready = ready.expect("the Host becomes ready");
    eprintln!("{} ready: host.status state {} epoch {}", at(), ready.state, ready.host_epoch);
    let status = status.expect("host.status");
    eprintln!(
        "{} host.status: state {} connections {} composition {}@{}",
        at(),
        status.state,
        status.connections,
        status.composition_id,
        status.composition_revision
    );
    assert_eq!(status.state, HostLifecycleState::Ready);
    pump_result.expect("the connection closes cleanly");
    // The Host rewrites its registration after the state change it reports
    // over the connection, so the file can lag `host.status` briefly.
    let control = control_directory(&prepared.root_id).expect("control directory");
    let registration_path = control.join(REGISTRATION_FILE);
    let wait_until = Instant::now() + Duration::from_secs(5);
    let current = loop {
        let text = std::fs::read_to_string(&registration_path).expect("registration");
        if text.contains(r#""state":"ready""#) || Instant::now() >= wait_until {
            break text;
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    eprintln!("{} registration: {}", at(), current.trim());
    assert!(current.contains(r#""state":"ready""#), "the registration reaches ready");
    eprintln!("{} connection closed; waiting for the idle exit", at());

    let exit =
        future::block_on(future::or(async { Some(spawned.exited().await.clone()) }, async {
            async_io::Timer::after(Duration::from_secs(30)).await;
            None
        }))
        .expect("the Host exits by itself after its idle grace");
    eprintln!(
        "{} candidate pid {} exited: code {:?} signal {:?}; stderr: {:?}",
        at(),
        spawned.pid(),
        exit.code,
        exit.signal,
        exit.stderr.trim()
    );
    assert_eq!(exit.code, Some(0));
    assert!(!registration_path.exists(), "the Host removed its registration");

    cleanup(&scratch, &control, &prepared.root_id);
}

/// Removes the scratch root and the Host's per-root files, all named by this
/// test's fresh `rootId`.
fn cleanup(scratch: &Path, control: &Path, root_id: &str) {
    std::fs::remove_dir_all(scratch).ok();
    std::fs::remove_dir_all(control).ok();
    if let Some(home) = std::env::home_dir() {
        let owners = if cfg!(target_os = "macos") {
            home.join("Library/Application Support/Maka/state-root-owners")
        } else {
            home.join(".local/share/Maka/state-root-owners")
        };
        std::fs::remove_file(owners.join(format!("{root_id}.lock"))).ok();
    }
}
