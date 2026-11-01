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

use maka_event_log::root::{RootNamespaces, RootOwner};
use maka_host_runtime::application::host::{Client, discovery};
use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

#[cfg(unix)]
mod crash;
mod owned;
mod startup;

#[test]
fn candidate_preserves_root_authority_and_drains_on_owner_loss_or_released_idle() {
    let directory = tempfile::tempdir().unwrap();
    let namespaces = RootNamespaces::for_current_account().unwrap();
    let mut fixture = CandidateFixture::new(directory.path().join("root"));

    let runtime = tokio::runtime::Runtime::new().unwrap();
    let mut predecessor = None;
    #[cfg(unix)]
    let socket_temp = tempfile::Builder::new()
        .prefix("mkt-")
        .tempdir_in("/tmp")
        .unwrap();
    enum End {
        OwnerLoss,
        ReleasedIdle,
        Retirement,
        Standalone,
        Takeover,
        Successor,
    }
    for end in [
        End::OwnerLoss,
        End::ReleasedIdle,
        End::Retirement,
        End::Standalone,
        End::Takeover,
        End::Successor,
    ] {
        let generation = if matches!(end, End::Successor) {
            "native-cli-successor"
        } else {
            "native-cli-test"
        };
        let mut command = Command::new(env!("CARGO_BIN_EXE_maka"));
        if matches!(end, End::Standalone) {
            command.args(["host", "serve", "--root"]).arg(&fixture.root);
            #[cfg(unix)]
            command.env("TMPDIR", socket_temp.path());
        } else {
            command
                .args(["host", "candidate", "--root"])
                .arg(&fixture.root)
                .args([
                    "--expected-root-id",
                    &fixture.root_id,
                    "--startup-attempt-id",
                    &uuid::Uuid::new_v4().to_string(),
                    "--generation",
                    generation,
                    "--idle-grace-ms",
                    "1000",
                    "--owner-stdin",
                ]);
        }
        fixture.child = Some(
            command
                .stdin(Stdio::piped())
                .stdout(if matches!(end, End::Standalone) {
                    Stdio::piped()
                } else {
                    Stdio::null()
                })
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        );
        let registration = fixture.wait_for_registration();
        let ready = matches!(end, End::Standalone).then(|| read_ready(&mut fixture));
        #[cfg(unix)]
        let standalone_socket = ready.as_ref().map(|ready| {
            use std::os::unix::fs::PermissionsExt;
            let socket = Path::new(ready["socketPath"].as_str().unwrap())
                .canonicalize()
                .unwrap();
            let parent = socket.parent().unwrap().to_owned();
            let placement = parent.parent().unwrap() == socket_temp.path().canonicalize().unwrap();
            let directory_mode = fs::metadata(&parent).unwrap().permissions().mode() & 0o777;
            let socket_mode = fs::metadata(&socket).unwrap().permissions().mode() & 0o777;
            (socket, parent, placement, directory_mode, socket_mode)
        });
        assert_eq!(registration["pid"], fixture.child.as_ref().unwrap().id());
        assert_eq!(registration["rootId"], fixture.root_id);
        assert_eq!(
            registration["lifecycleMode"],
            if matches!(end, End::Standalone) {
                "service"
            } else {
                "ephemeral"
            }
        );
        if !matches!(end, End::Standalone) {
            assert_eq!(registration["generation"], generation);
        }
        assert!(RootOwner::open(&fixture.root, &namespaces).is_err());
        if matches!(end, End::Successor) {
            assert_ne!(predecessor.as_ref(), Some(&registration["hostEpoch"]));
        }

        let mut client = runtime.block_on(async {
            let client = if let Some(ready) = &ready {
                let epoch = ready["hostEpoch"]
                    .as_str()
                    .and_then(|value| uuid::Uuid::parse_str(value).ok())
                    .expect("actual host serve Ready must include its Host epoch");
                assert!(!epoch.is_nil());
                Client::connect(
                    Path::new(ready["socketPath"].as_str().unwrap()),
                    Some(epoch),
                )
                .await
                .unwrap()
            } else {
                connect(&fixture.root).await
            };
            let found = discovery::read(&fixture.root).unwrap();
            let endpoint = ready
                .as_ref()
                .map(|ready| Path::new(ready["socketPath"].as_str().unwrap()))
                .unwrap_or(&found.endpoint);
            let status = Client::status(endpoint, Some(client.epoch()))
                .await
                .unwrap();
            found.verify(&status).unwrap();
            assert!(!status.closing);
            assert_eq!(status.epoch.to_string(), registration["hostEpoch"]);
            assert_eq!(status.root_id, fixture.root_id);
            client
        });

        // Initialization verifies identity without competing for an active writer lease.
        let init = Command::new(env!("CARGO_BIN_EXE_maka"))
            .args(["host", "init", "--root"])
            .arg(&fixture.root)
            .output()
            .unwrap();
        assert!(
            init.status.success(),
            "{}",
            String::from_utf8_lossy(&init.stderr)
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&init.stdout).unwrap()["rootId"],
            fixture.root_id
        );

        let status = Command::new(env!("CARGO_BIN_EXE_maka"))
            .args(["host", "status", "--root"])
            .arg(&fixture.root)
            .output()
            .unwrap();
        assert!(
            status.status.success(),
            "{}",
            String::from_utf8_lossy(&status.stderr)
        );
        let status: Value = serde_json::from_slice(&status.stdout).unwrap();
        assert_eq!(status["epoch"], registration["hostEpoch"]);
        assert_eq!(status["closing"], false);
        if matches!(end, End::Standalone) {
            runtime.block_on(client.close()).unwrap();
            let stale = Command::new(env!("CARGO_BIN_EXE_maka"))
                .args(["host", "retire", "--root"])
                .arg(&fixture.root)
                .args(["--expected-host-epoch", "stale"])
                .output()
                .unwrap();
            assert!(!stale.status.success());
            assert!(
                fixture
                    .child
                    .as_mut()
                    .unwrap()
                    .try_wait()
                    .unwrap()
                    .is_none()
            );
            let retired = Command::new(env!("CARGO_BIN_EXE_maka"))
                .args(["host", "retire", "--root"])
                .arg(&fixture.root)
                .args([
                    "--expected-host-epoch",
                    registration["hostEpoch"].as_str().unwrap(),
                ])
                .output()
                .unwrap();
            assert!(
                retired.status.success(),
                "{}",
                String::from_utf8_lossy(&retired.stderr)
            );
            let receipt: Value = serde_json::from_slice(&retired.stdout).unwrap();
            assert_eq!(receipt["kind"], "prepared", "{receipt}");
            assert_eq!(receipt["pid"], registration["pid"]);
        }
        if matches!(end, End::Retirement | End::Successor) {
            runtime.block_on(async {
                let endpoint = discovery::read(&fixture.root).unwrap().endpoint;
                assert!(
                    Client::retire(&endpoint, uuid::Uuid::new_v4())
                        .await
                        .is_err()
                );
                assert!(Client::retire(&endpoint, client.epoch()).await.unwrap());
            });
        }
        if matches!(end, End::Takeover) {
            runtime.block_on(verify_takeover(&fixture.root, &registration, &mut client));
            predecessor = Some(registration["hostEpoch"].clone());
        }
        if matches!(end, End::OwnerLoss) {
            drop(fixture.child.as_mut().unwrap().stdin.take());
        }
        if matches!(end, End::ReleasedIdle) {
            let mut stdin = fixture.child.as_mut().unwrap().stdin.take().unwrap();
            stdin
                .write_all(b"{\"kind\":\"runtime-host-launch-owner-release\"}\n")
                .unwrap();
        }
        if matches!(end, End::OwnerLoss | End::ReleasedIdle) {
            runtime.block_on(client.close()).unwrap();
        }
        drop(client);
        let status = fixture.wait_for_exit();
        assert!(
            status.success(),
            "candidate did not drain successfully: {status}"
        );
        assert!(
            !fixture.registration.exists(),
            "candidate left a discoverable stale epoch"
        );
        #[cfg(unix)]
        assert!(!Path::new(registration["endpoint"].as_str().unwrap()).exists());
        let reopened = RootOwner::open(&fixture.root, &namespaces).unwrap();
        assert_eq!(reopened.root_id(), fixture.root_id);
        drop(reopened);
        if let Some(ready) = ready {
            assert_eq!(ready["kind"], "ready");
            assert_eq!(ready["rootId"], registration["rootId"]);
            assert_eq!(ready["socketPath"], registration["endpoint"]);
            assert_eq!(ready["hostEpoch"], registration["hostEpoch"]);
        }
        #[cfg(unix)]
        if let Some((socket, child_directory, placement, directory_mode, socket_mode)) =
            standalone_socket
        {
            assert!(
                placement,
                "Host must use a fresh private child of the selected TMPDIR"
            );
            assert_eq!(directory_mode, 0o700);
            assert_eq!(socket_mode, 0o600);
            assert!(!socket.exists());
            assert!(
                !child_directory.exists(),
                "Host must release its owned temporary socket directory"
            );
            assert!(
                socket_temp.path().exists(),
                "Host must retain the selected parent directory"
            );
        }
    }
    assert!(!fixture.registration.exists());
    drop(RootOwner::open(&fixture.root, &namespaces).unwrap());
}

async fn connect(root: &Path) -> Client {
    let discovery = discovery::read(root).unwrap();
    let status = Client::status(&discovery.endpoint, Some(discovery.host_epoch))
        .await
        .unwrap();
    discovery.verify(&status).unwrap();
    Client::connect(&discovery.endpoint, Some(discovery.host_epoch))
        .await
        .unwrap()
}

async fn verify_takeover(root: &Path, registration: &Value, client: &mut Client) {
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut observer = connect(root).await;
        let discovery = discovery::read(root).unwrap();
        assert_eq!(client.epoch(), observer.epoch());
        let status = Client::status(&discovery.endpoint, Some(client.epoch()))
            .await
            .unwrap();
        assert_eq!(status.epoch.to_string(), registration["hostEpoch"]);
        assert_eq!(status.pid.get(), registration["pid"]);
        assert_eq!(status.active_calls, 0);
        assert_eq!(status.sessions, 2);
        assert!(
            Client::retire(&discovery.endpoint, uuid::Uuid::new_v4())
                .await
                .is_err()
        );
        assert!(
            !Client::retire_with_options(&discovery.endpoint, client.epoch(), false, false)
                .await
                .unwrap()
        );
        observer.close().await.unwrap();
        assert!(
            Client::retire_with_options(&discovery.endpoint, client.epoch(), false, true)
                .await
                .unwrap()
        );
    })
    .await
    .expect("native candidate retirement timed out");
}

// One bounded reader owns this exact child's pipe. Timeout kills/reaps that
// child and joins the reader before reporting failure, never leaving a waiter.
fn read_ready(fixture: &mut CandidateFixture) -> Value {
    use std::io::{BufRead, Read};
    let stdout = fixture.child.as_mut().unwrap().stdout.take().unwrap();
    let (send, receive) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut line = String::new();
        let result = std::io::BufReader::new(stdout)
            .take(8192)
            .read_line(&mut line)
            .map(|_| line);
        let _ = send.send(result);
    });
    let result = receive.recv_timeout(Duration::from_secs(15));
    if result.is_err() {
        let child = fixture.child.as_mut().unwrap();
        let _ = child.kill();
        let _ = child.wait();
    }
    reader.join().unwrap();
    serde_json::from_str(&result.expect("Host Ready deadline").unwrap()).unwrap()
}

#[cfg(unix)]
#[test]
fn host_serve_rejects_overlong_system_temp_and_releases_root_and_socket_directory() {
    use std::io::Read;
    let directory = tempfile::Builder::new()
        .prefix("mkt-")
        .tempdir_in("/tmp")
        .unwrap();
    let selected = directory.path().join("long-system-temp-".repeat(8));
    fs::create_dir(&selected).unwrap();
    let mut fixture = CandidateFixture::new(directory.path().join("root"));
    fixture.child = Some(
        Command::new(env!("CARGO_BIN_EXE_maka"))
            .args(["host", "serve", "--root"])
            .arg(&fixture.root)
            .env("TMPDIR", &selected)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let mut stdout = fixture.child.as_mut().unwrap().stdout.take().unwrap();
    let status = fixture.wait_for_exit();
    let mut output = String::new();
    stdout.read_to_string(&mut output).unwrap();
    assert!(
        !status.success(),
        "overlong system temp must fail without fallback"
    );
    // Dedicated Host stderr is captured after Root selection.
    let log = fs::read_to_string(
        fixture
            .registration
            .parent()
            .unwrap()
            .join("host.stderr.log"),
    )
    .unwrap_or_default();
    let path_error = std::os::unix::net::SocketAddr::from_pathname(selected.join("h.sock"))
        .expect_err("fixture path must exceed the actual platform Unix socket representation");
    assert!(
        log.contains(&path_error.to_string()),
        "failure must come from actual platform socket path validation: {log}"
    );
    assert!(
        output.is_empty(),
        "failed socket bind must not publish Ready"
    );
    assert!(
        !fixture.registration.exists(),
        "failed socket bind must not publish discovery"
    );
    assert_eq!(
        fs::read_dir(&selected).unwrap().count(),
        0,
        "failed bind must remove its private child directory"
    );
    drop(
        RootOwner::open(
            &fixture.root,
            &RootNamespaces::for_current_account().unwrap(),
        )
        .unwrap(),
    );
}

/// Reap the exact test child before removing its fresh root's account-level lease files.
pub(super) struct CandidateFixture {
    pub child: Option<Child>,
    pub root: PathBuf,
    pub root_id: String,
    pub registration: PathBuf,
    lock: PathBuf,
    cleanup: FixtureCleanup,
}

enum FixtureCleanup {
    Pending,
    Confirmed,
    Unconfirmed,
}

impl CandidateFixture {
    pub fn new(root: PathBuf) -> Self {
        let owner =
            RootOwner::create(&root, &RootNamespaces::for_current_account().unwrap()).unwrap();
        Self {
            child: None,
            root,
            root_id: owner.root_id().to_owned(),
            registration: owner.control_directory().join("registration.json"),
            lock: owner.lock_path().to_owned(),
            cleanup: FixtureCleanup::Pending,
        }
    }

    pub fn adopt_existing(root: PathBuf) -> Self {
        let namespaces = RootNamespaces::for_current_account().unwrap();
        let location = maka_event_log::root::resolve(&root).unwrap();
        Self {
            child: None,
            root,
            root_id: location.root_id().to_owned(),
            registration: namespaces
                .control
                .join(location.root_id())
                .join("registration.json"),
            lock: namespaces
                .ownership
                .join(format!("{}.lock", location.root_id())),
            cleanup: FixtureCleanup::Pending,
        }
    }

    pub fn wait_for_registration(&mut self) -> Value {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Ok(bytes) = fs::read(&self.registration) {
                return serde_json::from_slice(&bytes).unwrap();
            }
            assert!(
                self.child.as_mut().unwrap().try_wait().unwrap().is_none(),
                "candidate exited before registration"
            );
            assert!(
                Instant::now() < deadline,
                "candidate registration timed out"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    pub fn wait_for_exit(&mut self) -> std::process::ExitStatus {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = self.child.as_mut().unwrap().try_wait().unwrap() {
                self.child.take();
                return status;
            }
            assert!(Instant::now() < deadline, "candidate drain timed out");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    pub fn retire_registered(&self) {
        if let Ok(bytes) = fs::read(&self.registration)
            && let Ok(record) = serde_json::from_slice::<Value>(&bytes)
            && let Some(epoch) = record["hostEpoch"].as_str()
        {
            // This fixture owns a fresh, random root; the CLI rechecks the live epoch.
            let _ = Command::new(env!("CARGO_BIN_EXE_maka"))
                .args(["host", "retire", "--root"])
                .arg(&self.root)
                .args(["--expected-host-epoch", epoch])
                .output();
        }
    }

    fn cleanup(&mut self) -> bool {
        match self.cleanup {
            FixtureCleanup::Confirmed => return true,
            FixtureCleanup::Unconfirmed => return false,
            FixtureCleanup::Pending => self.cleanup = FixtureCleanup::Unconfirmed,
        }
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            if let Err(error) = child.wait() {
                eprintln!("test fixture child reaping unconfirmed: {error}");
                return false;
            }
        }
        self.retire_registered();
        let control = self.registration.parent().unwrap();
        let namespaces = RootNamespaces {
            ownership: self.lock.parent().unwrap().to_owned(),
            control: control.parent().unwrap().to_owned(),
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(owner) = RootOwner::open(&self.root, &namespaces) {
                drop(owner);
                break;
            }
            if Instant::now() >= deadline {
                eprintln!(
                    "refusing to unlink a possibly active test lease: {}",
                    self.lock.display()
                );
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let deployment = namespaces
            .ownership
            .parent()
            .unwrap()
            .join("deployments")
            .join(&self.root_id);
        match fs::symlink_metadata(&deployment) {
            Ok(metadata) if metadata.is_dir() => {
                // Only this fixture's freshly generated root; all owned children are reaped.
                let lease =
                    maka_event_log::root::FileLease::acquire(&deployment.join("executor.lock"));
                let lease = match lease {
                    Ok(lease) => lease,
                    Err(error) => {
                        eprintln!("refusing to unlink a possibly active test deployment: {error}");
                        return false;
                    }
                };
                drop(lease);
                if !Self::removed(&deployment, fs::remove_dir_all(&deployment)) {
                    return false;
                }
            }
            Ok(_) => {
                eprintln!("refusing to unlink an unexpected test deployment path");
                return false;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                eprintln!("test deployment inspection failed: {error}");
                return false;
            }
        }
        let log = control.join("host.stderr.log");
        for path in [&self.registration, &log] {
            if !Self::removed(path, fs::remove_file(path)) {
                return false;
            }
        }
        if !Self::removed(control, fs::remove_dir(control))
            || !Self::removed(&self.lock, fs::remove_file(&self.lock))
        {
            return false;
        }
        self.cleanup = FixtureCleanup::Confirmed;
        true
    }

    fn removed(path: &Path, result: std::io::Result<()>) -> bool {
        match result {
            Ok(()) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
            Err(error) => {
                eprintln!(
                    "test fixture removal failed for {}: {error}",
                    path.display()
                );
                false
            }
        }
    }
}

impl Drop for CandidateFixture {
    fn drop(&mut self) {
        self.cleanup();
    }
}

pub(super) struct RootStartupFixture {
    directory: Option<tempfile::TempDir>,
    pub(super) root: PathBuf,
    initialized: Option<CandidateFixture>,
    admission_pending: bool,
}

impl RootStartupFixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("root");
        Self {
            directory: Some(directory),
            root,
            initialized: None,
            admission_pending: true,
        }
    }

    fn directory(&self) -> &Path {
        self.directory.as_ref().unwrap().path()
    }

    pub(super) fn initialized(directory: tempfile::TempDir, fixture: CandidateFixture) -> Self {
        Self {
            root: fixture.root.clone(),
            directory: Some(directory),
            initialized: Some(fixture),
            admission_pending: false,
        }
    }

    pub(super) fn adopt(&mut self) -> &CandidateFixture {
        let fixture = self
            .initialized
            .get_or_insert_with(|| CandidateFixture::adopt_existing(self.root.clone()));
        self.admission_pending = false;
        fixture
    }

    pub(super) fn begin_admission(&mut self) {
        self.admission_pending = true;
    }
}

impl Drop for RootStartupFixture {
    fn drop(&mut self) {
        let settled = if self.admission_pending {
            if let Some(fixture) = &mut self.initialized {
                fixture.cleanup = FixtureCleanup::Unconfirmed;
            }
            false
        } else {
            self.initialized
                .as_mut()
                .is_some_and(CandidateFixture::cleanup)
        };
        if !settled && let Some(directory) = self.directory.take() {
            // A failed admission exposes no helper handle. It may still be
            // initializing this Root, even before publishing its identity.
            eprintln!(
                "startup fixture cleanup unconfirmed; retaining {}",
                directory.keep().display()
            );
        }
    }
}
