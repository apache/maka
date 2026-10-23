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

use super::candidate::CandidateFixture;
use maka_event_log::root::{RootNamespaces, RootOwner};
use maka_host_runtime::application::host::{Client, discovery};
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
};

fn launcher(directory: &Path) -> PathBuf {
    let executable = directory.join("maka");
    std::fs::copy(env!("CARGO_BIN_EXE_maka"), &executable).unwrap();
    executable
}

fn shell(directory: &Path) -> PathBuf {
    shell_at(directory.join(if cfg!(target_os = "macos") {
        "Maka.app/Contents/MacOS/maka-desktop-shell"
    } else {
        "maka-desktop-shell"
    }))
}

fn shell_at(executable: PathBuf) -> PathBuf {
    std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
    std::fs::write(&executable,
        "#!/bin/sh\nprintf '%s\n' \"$MAKA_HOST_ROOT\" \"$MAKA_LAUNCHER\" \"$MAKA_HOST_ENDPOINT\" \"$MAKA_HOST_EPOCH\" \"$$\" \"$#\"\nread status || exit 1\nexit \"$status\"\n",
    ).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    executable
}

async fn started(executable: &Path, root: &Path) -> (Child, PathBuf, uuid::Uuid, i32) {
    // A Root relative to the launcher's directory reaches the shell absolute.
    let mut child = Command::new(executable)
        .args(["desktop", "--root"])
        .arg(root.file_name().unwrap())
        .current_dir(root.parent().unwrap())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let shell_root = PathBuf::from(lines.next_line().await.unwrap().expect("shell Root"));
    assert!(shell_root.is_absolute(), "{}", shell_root.display());
    assert_eq!(
        std::fs::canonicalize(&shell_root).unwrap(),
        std::fs::canonicalize(root).unwrap()
    );
    let launcher = PathBuf::from(lines.next_line().await.unwrap().expect("shell launcher"));
    assert_eq!(
        std::fs::canonicalize(&launcher).unwrap(),
        std::fs::canonicalize(executable).unwrap(),
        "the shell starts the Root's next Host through the launcher itself"
    );
    let endpoint = PathBuf::from(lines.next_line().await.unwrap().expect("shell endpoint"));
    let epoch = lines
        .next_line()
        .await
        .unwrap()
        .expect("shell epoch")
        .parse()
        .unwrap();
    let pid = lines
        .next_line()
        .await
        .unwrap()
        .expect("shell PID")
        .parse()
        .unwrap();
    assert_eq!(
        lines.next_line().await.unwrap().as_deref(),
        Some("0"),
        "the launcher supplies no old UI arguments"
    );
    (child, endpoint, epoch, pid)
}

async fn saved(root: &Path) -> (uuid::Uuid, serde_json::Value, Option<Vec<u8>>) {
    let namespaces = RootNamespaces::for_current_account().unwrap();
    let owner = loop {
        match RootOwner::open(root, &namespaces) {
            Ok(owner) => break owner,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                tokio::task::yield_now().await
            }
            Err(error) => panic!("Host Root did not reopen: {error}"),
        }
    };
    let store = maka_transport::open_store(Arc::new(owner)).await.unwrap();
    let launch = store.application_launch().await.unwrap().unwrap();
    store.drain().await;
    (launch.deployment, launch.configuration, launch.pending)
}

#[tokio::test]
async fn desktop_shell_owns_its_child_and_preserves_the_selected_host_and_other_clients() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let directory = tempfile::tempdir().unwrap();
        let executable = launcher(directory.path());
        shell(directory.path());
        let fixture = CandidateFixture::new(directory.path().join("Host root 中文"));
        // The Root has no saved application: use the existing standalone initialization.
        let (mut first, endpoint, epoch, _) = started(&executable, &fixture.root).await;
        let registered = discovery::read(&fixture.root).unwrap();
        assert_eq!(registered.endpoint, endpoint);
        assert_eq!(registered.host_epoch, epoch);
        let mut peer = Client::connect(&endpoint, Some(epoch)).await.unwrap();
        assert_eq!(peer.source(), &registered.source);
        registered
            .verify(&Client::status(&endpoint, Some(epoch)).await.unwrap())
            .unwrap();
        let original_source = peer.source().clone();
        first
            .stdin
            .take()
            .unwrap()
            .write_all(b"73\n")
            .await
            .unwrap();
        assert_eq!(first.wait().await.unwrap().code(), Some(73));
        let live = Client::status(&endpoint, Some(epoch)).await.unwrap();
        assert_eq!(live.source, original_source);
        assert!(
            !live.closing && !live.closed,
            "a separate peer keeps its Host alive after shell exit"
        );

        let (mut second, same_endpoint, same_epoch, shell_pid) =
            started(&executable, &fixture.root).await;
        assert_eq!(same_endpoint, endpoint);
        assert_eq!(same_epoch, epoch);
        assert_eq!(
            discovery::read(&fixture.root).unwrap().source,
            original_source
        );
        // Signal the launcher, not the Host or the independently connected client.
        // Keep wait() from closing stdin and racing SIGTERM with shell EOF.
        let second_stdin = second.stdin.take().unwrap();
        assert_eq!(
            unsafe { libc::kill(second.id().unwrap() as i32, libc::SIGTERM) },
            0
        );
        let status = second.wait().await.unwrap();
        drop(second_stdin);
        assert!(status.success(), "{status}");
        assert_eq!(
            unsafe { libc::kill(shell_pid, 0) },
            -1,
            "the owned shell must be reaped before the launcher returns"
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
        let live = Client::status(&endpoint, Some(epoch)).await.unwrap();
        assert_eq!(live.source, original_source);
        assert!(!live.closing && !live.closed);
        peer.quit().await.unwrap();
        let original_launch = saved(&fixture.root).await;
        assert_eq!(original_launch.0, original_source.deployment);
        assert!(original_launch.2.is_none());

        let (mut reopened, new_endpoint, new_epoch, _) = started(&executable, &fixture.root).await;
        assert_ne!(new_epoch, epoch);
        let live = Client::status(&new_endpoint, Some(new_epoch))
            .await
            .unwrap();
        assert_eq!(
            live.source, original_source,
            "reopen keeps the complete saved source reference"
        );
        reopened
            .stdin
            .take()
            .unwrap()
            .write_all(b"0\n")
            .await
            .unwrap();
        assert!(reopened.wait().await.unwrap().success());
        assert_eq!(
            saved(&fixture.root).await,
            original_launch,
            "reopening must preserve the original saved selection and configuration"
        );
    })
    .await
    .expect("desktop launcher lifecycle did not settle");
}

#[tokio::test]
async fn desktop_launcher_succeeds_when_its_host_stopped_under_the_shell() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let directory = tempfile::tempdir().unwrap();
        let executable = launcher(directory.path());
        shell(directory.path());
        let fixture = CandidateFixture::new(directory.path().join("root"));
        let (mut child, endpoint, epoch, _) = started(&executable, &fixture.root).await;
        // The Host stops while the window is open, as when it is retired
        // over its clients or crashes; the window then moves to the next Host.
        assert!(
            Client::retire_with_options(&endpoint, epoch, true, true)
                .await
                .unwrap()
        );
        while Client::status(&endpoint, Some(epoch))
            .await
            .is_ok_and(|status| !status.closed)
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        child.stdin.take().unwrap().write_all(b"0\n").await.unwrap();
        let status = child.wait().await.unwrap();
        assert!(
            status.success(),
            "a stopped Host leaves the launcher nothing to detach: {status}"
        );
    })
    .await
    .expect("desktop launcher did not settle after its Host stopped");
}

#[tokio::test]
async fn desktop_shell_spawn_failure_ignores_path_and_releases_its_host() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let directory = tempfile::tempdir().unwrap();
        let executable = launcher(directory.path());
        let decoy = directory.path().join("path");
        std::fs::create_dir(&decoy).unwrap();
        shell(&decoy);
        // What a lookup by bare name would find.
        shell_at(decoy.join("maka-desktop-shell"));
        let fixture = CandidateFixture::new(directory.path().join("root"));
        let result = Command::new(&executable)
            .args(["desktop", "--root"])
            .arg(&fixture.root)
            .env("PATH", &decoy)
            .output()
            .await
            .unwrap();
        assert!(!result.status.success());
        assert!(
            String::from_utf8_lossy(&result.stderr).contains("maka-desktop-shell"),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(
            result.stdout.is_empty(),
            "a PATH decoy must never be executed"
        );
        assert!(
            saved(&fixture.root).await.2.is_none(),
            "spawn failure must settle the startup owner and leave a reusable saved Host"
        );
    })
    .await
    .expect("desktop shell spawn failure did not settle");
}

#[test]
fn desktop_help_and_version_do_not_start_a_host_or_shell() {
    let directory = tempfile::tempdir().unwrap();
    let executable = launcher(directory.path());
    let root = directory.path().join("must remain absent");
    for flag in ["--help", "--version"] {
        for with_root in [false, true] {
            let mut command = std::process::Command::new(&executable);
            command.arg("desktop");
            if with_root {
                command.arg("--root").arg(&root);
            }
            let result = command.arg(flag).output().unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
            assert!(!root.exists());
        }
    }
    let required = std::process::Command::new(&executable)
        .arg("desktop")
        .output()
        .unwrap();
    assert!(!required.status.success());
    assert!(String::from_utf8_lossy(&required.stderr).contains("--root"));
    let help = std::process::Command::new(&executable)
        .arg("--help")
        .output()
        .unwrap();
    assert!(help.status.success());
    assert!(String::from_utf8_lossy(&help.stdout).contains("desktop"));
}
