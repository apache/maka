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
use maka_host_runtime::application::host::{LifecycleMode, VERSION, discovery::Discovery};
use maka_plugin_core::deployment::DeploymentRef;
use std::{
    fs,
    num::NonZeroU32,
    path::{Path, PathBuf},
    process::{Command, Output},
};
use uuid::Uuid;

/// An initialized State Root that removes its account-level lease files on drop.
struct Root {
    _directory: tempfile::TempDir,
    path: PathBuf,
    id: String,
    control: PathBuf,
    lock: PathBuf,
}

impl Root {
    fn create() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("root");
        let namespaces = RootNamespaces::for_current_account().unwrap();
        let owner = RootOwner::create(&path, &namespaces).unwrap();
        Self {
            _directory: directory,
            path,
            id: owner.root_id().to_owned(),
            control: owner.control_directory().to_owned(),
            lock: owner.lock_path().to_owned(),
        }
    }
}

impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.control);
        let _ = fs::remove_file(&self.lock);
    }
}

fn status(root: &Path) -> Output {
    Command::new(crate::maka_executable())
        .args(["host", "status", "--root"])
        .arg(root)
        .output()
        .unwrap()
}

#[test]
fn status_reports_a_stopped_host_with_its_root_id_and_hint() {
    let root = Root::create();
    let output = status(&root.path);
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no Host is running for State Root"),
        "{stderr}"
    );
    assert!(stderr.contains(root.path.to_str().unwrap()), "{stderr}");
    assert!(stderr.contains(&root.id), "{stderr}");
    assert!(stderr.contains("maka host status --root-id"), "{stderr}");
    assert!(!stderr.contains("os error"), "{stderr}");
}

#[test]
fn status_rejects_a_missing_or_uninitialized_root() {
    let directory = tempfile::tempdir().unwrap();
    let missing = directory.path().join("missing");
    let uninitialized = directory.path().join("uninitialized");
    fs::create_dir(&uninitialized).unwrap();
    for root in [&missing, &uninitialized] {
        let output = status(root);
        assert!(!output.status.success());
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains("does not exist or is not initialized"),
            "{stderr}"
        );
        assert!(stderr.contains(root.to_str().unwrap()), "{stderr}");
        assert!(!stderr.contains("no Host is running"), "{stderr}");
        assert!(!stderr.contains("os error"), "{stderr}");
    }
}

#[test]
fn status_reports_a_stale_registration_as_a_stopped_host() {
    let root = Root::create();
    #[cfg(unix)]
    let socket_directory = {
        // A closed listener keeps its socket inode, so connecting is refused.
        let directory = tempfile::Builder::new()
            .prefix("mkt-")
            .tempdir_in("/tmp")
            .unwrap();
        let socket = directory.path().join("dead.sock");
        drop(std::os::unix::net::UnixListener::bind(&socket).unwrap());
        assert!(
            fs::symlink_metadata(&socket).is_ok(),
            "the socket inode must outlive its listener"
        );
        write_registration(&root, socket);
        directory
    };
    #[cfg(windows)]
    write_registration(
        &root,
        PathBuf::from(format!(r"\\.\pipe\maka-stopped-{}", Uuid::new_v4())),
    );

    let output = status(&root.path);
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no Host is running for State Root"),
        "{stderr}"
    );
    assert!(stderr.contains(&root.id), "{stderr}");
    assert!(!stderr.contains("os error"), "{stderr}");

    #[cfg(unix)]
    drop(socket_directory);
}

/// Writes the discovery record a crashed Host leaves behind for a dead endpoint.
fn write_registration(root: &Root, endpoint: PathBuf) {
    let discovery = Discovery {
        version: VERSION,
        root_id: root.id.clone(),
        generation: None,
        host_epoch: Uuid::new_v4(),
        source: DeploymentRef {
            state_domain: "0".repeat(64),
            deployment: Uuid::new_v4(),
            revision: 1,
        },
        lifecycle_mode: LifecycleMode::Ephemeral,
        endpoint,
        pid: NonZeroU32::new(std::process::id()).unwrap(),
        websocket_endpoints: Vec::new(),
    };
    fs::write(
        root.control.join("registration.json"),
        serde_json::to_vec(&discovery).unwrap(),
    )
    .unwrap();
}

#[test]
fn retire_reports_a_stopped_host_instead_of_an_os_error() {
    let root = Root::create();
    let output = Command::new(crate::maka_executable())
        .args(["host", "retire", "--root"])
        .arg(&root.path)
        .output()
        .unwrap();
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no Host is running for State Root"),
        "{stderr}"
    );
    assert!(!stderr.contains("os error"), "{stderr}");
}

#[test]
fn status_root_id_reports_an_uninstalled_root() {
    let root = Root::create();
    let output = Command::new(crate::maka_executable())
        .args(["host", "status", "--root-id", &root.id])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let observation: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(observation["kind"], "not_installed");
}
