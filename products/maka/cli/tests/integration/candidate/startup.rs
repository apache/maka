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

#[test]
fn host_logs_reads_captured_stderr_without_an_installed_deployment() {
    use base64::Engine;

    let directory = tempfile::tempdir().unwrap();
    let fixture = CandidateFixture::new(directory.path().join("root"));
    let path = fixture
        .registration
        .parent()
        .unwrap()
        .join("host.stderr.log");
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut capture = options.open(path).unwrap();
    capture.write_all(b"pre-Ready host failure\n\xff").unwrap();
    drop(capture);

    let output = Command::new(env!("CARGO_BIN_EXE_maka"))
        .args(["host", "logs", "--root-id", &fixture.root_id])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "uninstalled Root's captured stderr must remain readable: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let page: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(page["kind"], "data");
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(page["bytes"].as_str().unwrap())
            .unwrap(),
        b"pre-Ready host failure\n\xff"
    );
    assert_eq!(page["reset"], Value::Null);
    assert_eq!(page["hasMore"], false);
    assert!(!page["cursor"].as_str().unwrap().is_empty());
}

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
    let discovery = discovery::read(&fixture.root).unwrap();
    let mut client = runtime.block_on(connect(&fixture.root));
    assert_eq!(client.epoch(), discovery.host_epoch);
    // The launcher has never handshaken or sent the owner-release message.
    drop(fixture.child.as_mut().unwrap().stdin.take());
    runtime.block_on(async {
        // Stay attached beyond the entire idle grace after owner EOF.
        tokio::time::sleep(Duration::from_millis(1200)).await;
        let status = Client::status(&discovery.endpoint, Some(client.epoch()))
            .await
            .unwrap();
        assert_eq!(status.epoch, discovery.host_epoch);
        assert!(!status.closing);
        let live = discovery::read(&fixture.root).unwrap();
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
        client.close().await.unwrap();
    });
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
    let discovery = discovery::read(&fixture.root).unwrap();
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

#[test]
fn detached_candidate_captures_pre_ready_and_released_owner_failures() {
    use base64::Engine;
    use futures_util::FutureExt;
    use maka_host_runtime::logs::Source;
    use tokio::io::AsyncWriteExt;

    let directory = tempfile::tempdir().unwrap();
    let fixture = CandidateFixture::new(directory.path().join("root"));
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        for released in [false, true] {
            let owner = RootOwner::open(
                &fixture.root,
                &RootNamespaces::for_current_account().unwrap(),
            )
            .unwrap();
            let source = Source::from_owner(&owner).unwrap();
            let capture = source.open_capture().unwrap();
            drop(owner);
            let expected_id = if released {
                fixture.root_id.as_str()
            } else {
                "wrong-root"
            };
            let mut child = maka_process::detached::spawn(
                Path::new(env!("CARGO_BIN_EXE_maka")),
                &[
                    "host",
                    "candidate",
                    "--root",
                    fixture.root.to_str().unwrap(),
                    "--expected-root-id",
                    expected_id,
                    "--startup-attempt-id",
                    &uuid::Uuid::new_v4().to_string(),
                    "--owner-stdin",
                    "--initial-connection-timeout-ms",
                    "30000",
                ],
                Some(capture),
            )
            .await
            .unwrap();
            let mut original_registration = None;
            let mut phase = "waiting for child exit";
            let outcome = std::panic::AssertUnwindSafe(async {
                tokio::time::timeout(Duration::from_secs(15), async {
                    if released {
                        phase = "waiting for registration";
                        loop {
                            if fixture.registration.exists() {
                                break;
                            }
                            assert!(
                                child.try_wait().unwrap().is_none(),
                                "candidate exited before Ready"
                            );
                            tokio::time::sleep(Duration::from_millis(20)).await;
                        }
                        let found = discovery::read(&fixture.root).unwrap();
                        original_registration = Some(fs::read(&fixture.registration).unwrap());
                        phase = "connecting accepted client";
                        let mut client = connect(&fixture.root).await;
                        let mut stdin = child.stdin.take().unwrap();
                        phase = "releasing launcher ownership";
                        stdin
                            .write_all(b"{\"kind\":\"runtime-host-launch-owner-release\"}\n")
                            .await
                            .unwrap();
                        drop(stdin);
                        phase = "reading Host status after owner release";
                        assert!(
                            !Client::status(&found.endpoint, Some(client.epoch()))
                                .await
                                .unwrap()
                                .closing
                        );
                        // A real shutdown failure after launcher release must still reach stderr.
                        fs::write(&fixture.registration, b"not a registration").unwrap();
                        phase = "closing accepted client";
                        client.close().await.unwrap();
                        phase = "requesting idle retirement";
                        assert!(
                            Client::retire_with_options(
                                &found.endpoint,
                                found.host_epoch,
                                false,
                                false
                            )
                            .await
                            .unwrap()
                        );
                    }
                    if released {
                        phase = "waiting for child exit";
                    }
                    let status = child.wait().await.unwrap();
                    assert!(
                        !status.success(),
                        "injected startup/shutdown failure was not reported"
                    );
                })
                .await
                .unwrap_or_else(|error| {
                    panic!(
                        "captured candidate did not settle: released={released}, phase={phase}: {error:?}"
                    )
                });
                let output = Command::new(env!("CARGO_BIN_EXE_maka"))
                    .args(["host", "logs", "--root-id", &fixture.root_id])
                    .output()
                    .unwrap();
                assert!(
                    output.status.success(),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
                let page: Value = serde_json::from_slice(&output.stdout).unwrap();
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(page["bytes"].as_str().unwrap())
                    .unwrap();
                let log = String::from_utf8_lossy(&bytes);
                assert!(
                    log.contains(if released {
                        "could not remove Host registration"
                    } else {
                        "candidate State Root identity mismatch"
                    }),
                    "{log}"
                );
            })
            .catch_unwind()
            .await;
            // Reap the exact spawned child even when an assertion or readiness wait fails.
            child.start_kill().unwrap();
            tokio::time::timeout(Duration::from_secs(5), child.wait())
                .await
                .unwrap()
                .unwrap();
            if let Some(bytes) = original_registration {
                fs::write(&fixture.registration, bytes).unwrap();
            }
            if let Err(panic) = outcome {
                std::panic::resume_unwind(panic);
            }
        }
    });
}

#[cfg(unix)]
#[test]
fn host_logs_follow_streams_uninstalled_root_and_exits_with_a_full_stdout_pipe() {
    use base64::Engine;
    use std::{
        io::Read,
        os::fd::{AsRawFd, FromRawFd},
    };

    let directory = tempfile::tempdir().unwrap();
    let mut fixture = CandidateFixture::new(directory.path().join("root"));
    let mut descriptors = [-1; 2];
    // This test owns both ends; retaining the writer permits observing actual backpressure.
    assert_eq!(unsafe { libc::pipe(descriptors.as_mut_ptr()) }, 0);
    for descriptor in descriptors {
        assert_eq!(
            unsafe { libc::fcntl(descriptor, libc::F_SETFD, libc::FD_CLOEXEC) },
            0
        );
    }
    let mut reader = unsafe { fs::File::from_raw_fd(descriptors[0]) };
    let writer = unsafe { fs::File::from_raw_fd(descriptors[1]) };
    let flags = unsafe { libc::fcntl(reader.as_raw_fd(), libc::F_GETFL) };
    assert!(flags >= 0);
    assert_eq!(
        unsafe { libc::fcntl(reader.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) },
        0
    );
    #[cfg(target_os = "linux")]
    assert!(unsafe { libc::fcntl(writer.as_raw_fd(), libc::F_SETPIPE_SZ, 4096) } >= 4096);
    fixture.child = Some(
        Command::new(env!("CARGO_BIN_EXE_maka"))
            .args([
                "--timeout-ms",
                "1",
                "host",
                "logs",
                "--root-id",
                &fixture.root_id,
                "--follow",
            ])
            .stdout(Stdio::from(writer.try_clone().unwrap()))
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );

    fn page(reader: &mut fs::File, fixture: &mut CandidateFixture) -> Value {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut bytes = Vec::new();
        loop {
            let mut byte = [0];
            match reader.read(&mut byte) {
                Ok(1) if byte[0] == b'\n' => return serde_json::from_slice(&bytes).unwrap(),
                Ok(1) => bytes.push(byte[0]),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        fixture
                            .child
                            .as_mut()
                            .unwrap()
                            .try_wait()
                            .unwrap()
                            .is_none(),
                        "follow exited before its next page"
                    );
                    assert!(Instant::now() < deadline, "follow page timed out");
                    let mut poll = libc::pollfd {
                        fd: reader.as_raw_fd(),
                        events: libc::POLLIN,
                        revents: 0,
                    };
                    assert!(unsafe { libc::poll(&mut poll, 1, 100) } >= 0);
                }
                other => panic!("unexpected follow read: {other:?}"),
            }
        }
    }

    assert_eq!(
        page(&mut reader, &mut fixture),
        serde_json::json!({"kind":"missing"})
    );
    let owner = RootOwner::open(
        &fixture.root,
        &RootNamespaces::for_current_account().unwrap(),
    )
    .unwrap();
    let source = maka_host_runtime::logs::Source::from_owner(&owner).unwrap();
    let mut capture = source.open_capture().unwrap();
    drop(owner);
    let initial = page(&mut reader, &mut fixture);
    assert_eq!(initial["kind"], "data");
    assert_eq!(initial["bytes"], "");
    capture.write_all(b"after creation\n\xff").unwrap();
    let appended = page(&mut reader, &mut fixture);
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(appended["bytes"].as_str().unwrap())
            .unwrap(),
        b"after creation\n\xff"
    );
    assert_eq!(appended["reset"], Value::Null);

    // More than the pipe, one blocking write, and the bounded async bridge can hold.
    capture.write_all(&vec![b'x'; 1024 * 1024]).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let mut poll = libc::pollfd {
            fd: writer.as_raw_fd(),
            events: libc::POLLOUT,
            revents: 0,
        };
        assert!(unsafe { libc::poll(&mut poll, 1, 0) } >= 0);
        if poll.revents & libc::POLLOUT == 0 {
            break;
        }
        assert!(
            fixture
                .child
                .as_mut()
                .unwrap()
                .try_wait()
                .unwrap()
                .is_none()
        );
        assert!(
            Instant::now() < deadline,
            "follow never filled its stdout pipe"
        );
        std::thread::park_timeout(Duration::from_millis(2));
    }
    // The exact owned child must service cancellation without waiting for this reader.
    assert_eq!(
        unsafe { libc::kill(fixture.child.as_ref().unwrap().id() as i32, libc::SIGTERM) },
        0
    );
    assert!(fixture.wait_for_exit().success());
}
