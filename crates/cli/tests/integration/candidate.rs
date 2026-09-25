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

use maka_client::{Client, Operations};
use maka_event_log::root::{RootNamespaces, RootOwner};
use maka_protocol::{
    Operation,
    handshake::{ClientHello, HostHandshake, Replacement, Takeover},
};
use serde_json::Value;
use serde_json::json;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

mod startup;

#[test]
fn candidate_preserves_root_authority_and_drains_on_owner_loss_or_released_idle() {
    let directory = tempfile::tempdir().unwrap();
    let namespaces = RootNamespaces::for_current_account().unwrap();
    let mut fixture = CandidateFixture::new(directory.path().join("root"));

    let runtime = tokio::runtime::Runtime::new().unwrap();
    let mut predecessor = None;
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
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        );
        let registration = fixture.wait_for_registration();
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

        let mut stdin = fixture.child.as_mut().unwrap().stdin.take().unwrap();
        if matches!(end, End::ReleasedIdle) {
            stdin
                .write_all(b"{\"kind\":\"runtime-host-launch-owner-release\"}\n")
                .unwrap();
            drop(stdin);
        } else {
            fixture.child.as_mut().unwrap().stdin = Some(stdin);
        }

        runtime.block_on(async {
            let (client, _notifications) = connect(&fixture.root).await;
            let status = client
                .request(Operation::HostStatus, json!({}))
                .await
                .unwrap();
            assert_eq!(status["state"], "ready");
            assert_eq!(status["hostEpoch"], registration["hostEpoch"]);
            assert_eq!(client.identity.root_id, fixture.root_id);
            client.disconnect();
            client.closed().await;
        });

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
        assert_eq!(status["hostEpoch"], registration["hostEpoch"]);
        assert_eq!(status["state"], "ready");
        if matches!(end, End::Retirement | End::Standalone | End::Successor) {
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
        if matches!(end, End::Takeover) {
            runtime.block_on(verify_takeover(&fixture.root, &registration));
            predecessor = Some(registration["hostEpoch"].clone());
        }
        if matches!(end, End::OwnerLoss) {
            drop(fixture.child.as_mut().unwrap().stdin.take());
        }
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
    }
    assert!(!fixture.registration.exists());
    drop(RootOwner::open(&fixture.root, &namespaces).unwrap());
}

async fn connect(
    root: &Path,
) -> (
    Client,
    tokio::sync::mpsc::Receiver<maka_client::Notification>,
) {
    let discovery = maka_client::local::read_discovery(root).unwrap();
    Client::connect(
        maka_client::local::open_stream(&discovery.endpoint)
            .await
            .unwrap(),
        &discovery.root_id,
        &discovery.host_epoch,
        Operations,
    )
    .await
    .unwrap()
}

async fn verify_takeover(root: &Path, registration: &Value) {
    tokio::time::timeout(Duration::from_secs(10), async {
        let (client, _notifications) = connect(root).await;
        let (observer, _observer_notifications) = connect(root).await;
        assert_eq!(client.identity.host_epoch, observer.identity.host_epoch);
        let diagnostics = client
            .request(Operation::HostDiagnosticsQuery, json!({}))
            .await
            .unwrap();
        assert_eq!(diagnostics["hostEpoch"], registration["hostEpoch"]);
        assert_eq!(diagnostics["pid"], registration["pid"]);
        assert_eq!(diagnostics["activeOperations"], 0);
        assert_eq!(diagnostics["activeResidencies"], 0);
        assert_eq!(diagnostics["connections"], 2);
        assert_eq!(diagnostics["upgradeBlockingActivity"], true);
        assert!(
            diagnostics["logs"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v.as_str().unwrap().contains("Host ready"))
        );
        assert!(matches!(
            client
                .request(
                    Operation::HostUpgradePrepare,
                    json!({
                        "expectedHostEpoch":"stale", "allowInterruptActiveTasks":true
                    })
                )
                .await,
            Err(maka_client::RequestFailure::Rejected(maka_client::ClientError::Rejected(error)))
                if error.code == maka_protocol::OperationErrorCode::OperationConflict
        ));
        let busy = client.request(Operation::HostUpgradePrepare, json!({
            "expectedHostEpoch":registration["hostEpoch"], "allowInterruptActiveTasks":false,
            "allowCooperativeHandoff":true
        })).await.unwrap();
        assert_eq!(busy, json!({"kind":"active_tasks"}));
        assert!(matches!(
            challenge(registration).await,
            HostHandshake::Incompatible {
                replacement: Replacement::BlockedByResidency,
                ..
            }
        ));
        observer.disconnect();
        observer.closed().await;
        client.disconnect();
        client.closed().await;
        loop {
            match challenge(registration).await {
                HostHandshake::Draining { host_epoch, .. } => {
                    assert_eq!(host_epoch, registration["hostEpoch"]);
                    break;
                }
                HostHandshake::Incompatible {
                    replacement: Replacement::BlockedByResidency,
                    ..
                } => tokio::task::yield_now().await,
                other => panic!("Unexpected takeover: {other:?}"),
            }
        }
    })
    .await
    .expect("native candidate takeover timed out");
}

async fn challenge(registration: &Value) -> HostHandshake {
    let stream =
        maka_client::local::open_stream(Path::new(registration["endpoint"].as_str().unwrap()))
            .await
            .unwrap();
    let (mut reader, mut writer) =
        maka_transport::ndjson::split(stream, tokio_util::sync::CancellationToken::new());
    writer
        .write(&ClientHello {
            client_instance_id: uuid::Uuid::new_v4().to_string(),
            protocol_min: maka_protocol::PROTOCOL_VERSION,
            protocol_max: maka_protocol::PROTOCOL_VERSION,
            compatibility_epoch: maka_protocol::COMPATIBILITY_EPOCH,
            composition_id: maka_protocol::COMPOSITION_ID.into(),
            generation: Some("native-cli-successor".into()),
            takeover: Some(Takeover {
                expected_host_epoch: registration["hostEpoch"].as_str().unwrap().into(),
            }),
        })
        .await
        .unwrap();
    maka_protocol::handshake::decode_host_handshake(&reader.read().await.unwrap().unwrap()).unwrap()
}

/// Reap the exact test child before removing its fresh root's account-level lease files.
pub(super) struct CandidateFixture {
    pub child: Option<Child>,
    pub root: PathBuf,
    pub root_id: String,
    pub registration: PathBuf,
    lock: PathBuf,
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
}

impl Drop for CandidateFixture {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
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
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = fs::remove_file(&self.registration);
        let deployment = namespaces
            .ownership
            .parent()
            .unwrap()
            .join("deployments")
            .join(&self.root_id);
        if deployment.is_dir() {
            // Only this fixture's freshly generated root; all owned children are reaped.
            if let Ok(lease) =
                maka_event_log::root::FileLease::acquire(&deployment.join("executor.lock"))
            {
                drop(lease);
                let _ = fs::remove_dir_all(deployment);
            }
        }
        let _ = fs::remove_dir(control);
        let _ = fs::remove_file(&self.lock);
    }
}
