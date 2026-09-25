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

fn start(directory: &Path) -> CandidateFixture {
    let mut fixture = CandidateFixture::new(directory.join("root"));
    fixture.child = Some(
        Command::new(env!("CARGO_BIN_EXE_maka"))
            .args(["host", "candidate", "--root"])
            .arg(&fixture.root)
            .args([
                "--expected-root-id",
                &fixture.root_id,
                "--startup-attempt-id",
                &uuid::Uuid::new_v4().to_string(),
                "--owner-stdin",
                "--initial-connection-timeout-ms",
                "30000",
                "--idle-grace-ms",
                "1000",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    fixture.wait_for_registration();
    fixture
}

#[test]
fn candidate_owner_eof_preserves_an_independently_accepted_client_until_idle() {
    let directory = tempfile::tempdir().unwrap();
    let mut fixture = start(directory.path());
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let discovery = maka_client::local::read_discovery(&fixture.root).unwrap();
    let (client, notifications) = runtime.block_on(connect(&fixture.root));
    assert_eq!(client.identity.root_id, discovery.root_id);
    assert_eq!(client.identity.host_epoch, discovery.host_epoch);
    assert_eq!(
        runtime
            .block_on(client.request(Operation::HostStatus, json!({})))
            .unwrap()["state"],
        "ready"
    );
    // The launcher has never handshaken or sent the owner-release message.
    drop(fixture.child.as_mut().unwrap().stdin.take());
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let status = client
                    .request(Operation::HostDiagnosticsQuery, json!({}))
                    .await
                    .unwrap();
                assert_eq!(status["hostEpoch"], discovery.host_epoch);
                assert_eq!(status["state"], "ready");
                if status["logs"].as_array().unwrap().iter().any(|entry| {
                    entry
                        .as_str()
                        .unwrap()
                        .contains("Startup launcher gone; accepted clients retain Host lifetime")
                }) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("owner EOF must be processed while the observer stays attached");
        assert_eq!(
            client
                .request(Operation::HostStatus, json!({}))
                .await
                .unwrap()["state"],
            "ready"
        );
        let live = maka_client::local::read_discovery(&fixture.root).unwrap();
        assert_eq!(live.root_id, discovery.root_id);
        assert_eq!(live.host_epoch, discovery.host_epoch);
        assert_eq!(live.pid, discovery.pid);
        assert!(
            RootOwner::open(
                &fixture.root,
                &RootNamespaces::for_current_account().unwrap()
            )
            .is_err()
        );
        client.disconnect();
        client.closed().await;
    });
    drop(notifications);
    assert!(fixture.wait_for_exit().success());
    assert!(!fixture.registration.exists());
    drop(
        RootOwner::open(
            &fixture.root,
            &RootNamespaces::for_current_account().unwrap(),
        )
        .unwrap(),
    );
}

#[test]
fn candidate_owner_eof_without_an_accepted_client_drains_startup() {
    let directory = tempfile::tempdir().unwrap();
    let mut fixture = start(directory.path());
    let discovery = maka_client::local::read_discovery(&fixture.root).unwrap();
    assert_eq!(discovery.root_id, fixture.root_id);
    assert_eq!(discovery.pid.get(), fixture.child.as_ref().unwrap().id());
    drop(fixture.child.as_mut().unwrap().stdin.take());
    assert!(fixture.wait_for_exit().success());
    assert!(!fixture.registration.exists());
    drop(
        RootOwner::open(
            &fixture.root,
            &RootNamespaces::for_current_account().unwrap(),
        )
        .unwrap(),
    );
}
