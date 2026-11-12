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

// Keep this process-spawning check in its own binary: fork temporarily inherits
// other test threads' OFD leases even when their files are close-on-exec.
use maka_event_log::root::{FileLease, RootNamespaces, RootOwner};
use std::{fs, path::Path, process::Command};

fn namespaces(base: &Path) -> RootNamespaces {
    RootNamespaces {
        ownership: base.join("owners"),
        control: base.join("control"),
    }
}

#[test]
fn durable_lease_blocks_other_process_even_after_cache_removal() {
    if let Some(base) = std::env::var_os("MAKA_ROOT_AUTHORITY_TEST_BASE") {
        let base = Path::new(&base);
        let error = RootOwner::open(&base.join("root"), &namespaces(base))
            .err()
            .unwrap();
        assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let ns = namespaces(temp.path());
    let path = temp.path().join("root");
    let owner = RootOwner::create(&path, &ns).unwrap();
    let _management = FileLease::acquire(&path.join("skills-management.lock")).unwrap();
    fs::create_dir(path.join("arbitrary-business-data")).unwrap();
    fs::write(path.join("arbitrary-business-data/domain.bin"), b"opaque").unwrap();
    assert_eq!(
        maka_event_log::root::initialize(&path, &ns).unwrap(),
        owner.root_id()
    );
    fs::remove_dir_all(&ns.control).unwrap();
    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "durable_lease_blocks_other_process_even_after_cache_removal",
            "--nocapture",
        ])
        .env("MAKA_ROOT_AUTHORITY_TEST_BASE", temp.path())
        .status()
        .unwrap();
    assert!(status.success());
    assert!(owner.validate_current().is_err());
    drop(owner);
    RootOwner::open(&path, &ns).unwrap();
}

#[cfg(target_os = "macos")]
#[test]
fn root_opens_after_its_mount_number_changes() {
    use maka_event_log::root::{ROOT_MARKER, repair_after_remount, resolve};
    use serde_json::Value;

    let temp = tempfile::tempdir().unwrap();
    let ns = namespaces(temp.path());
    let path = temp.path().join("root");
    let owner = RootOwner::create(&path, &ns).unwrap();
    let id = owner.root_id().to_owned();
    drop(owner);
    let marker_path = path.join(ROOT_MARKER);
    let mut marker: Value = serde_json::from_slice(&fs::read(&marker_path).unwrap()).unwrap();
    let volume = marker
        .as_object_mut()
        .unwrap()
        .remove("volumeUuid")
        .unwrap();
    fs::write(&marker_path, serde_json::to_vec(&marker).unwrap()).unwrap();
    let upgraded = RootOwner::open(&path, &ns).unwrap();
    assert_eq!(upgraded.root_id(), id);
    drop(upgraded);
    marker = serde_json::from_slice(&fs::read(&marker_path).unwrap()).unwrap();
    assert_eq!(marker["volumeUuid"], volume);

    // A legacy device number differs after a remount. The APFS volume is the same.
    marker["rootIdentity"]["dev"] = Value::String(u64::MAX.to_string());
    fs::write(&marker_path, serde_json::to_vec(&marker).unwrap()).unwrap();
    assert_eq!(resolve(&path).unwrap().root_id(), id);
    RootOwner::open(&path, &ns)
        .unwrap()
        .validate_current()
        .unwrap();

    marker.as_object_mut().unwrap().remove("volumeUuid");
    fs::write(&marker_path, serde_json::to_vec(&marker).unwrap()).unwrap();
    assert!(resolve(&path).is_err());
    assert!(repair_after_remount(&path, "wrong-root", &ns).is_err());
    repair_after_remount(&path, &id, &ns).unwrap();
    assert_eq!(resolve(&path).unwrap().root_id(), id);

    let mut marker: Value = serde_json::from_slice(&fs::read(&marker_path).unwrap()).unwrap();
    marker["volumeUuid"] = serde_json::to_value(uuid::Uuid::new_v4()).unwrap();
    fs::write(&marker_path, serde_json::to_vec(&marker).unwrap()).unwrap();
    assert!(resolve(&path).is_err());
    assert!(repair_after_remount(&path, &id, &ns).is_err());
}
