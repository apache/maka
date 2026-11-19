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

#[tokio::test]
async fn relocated_root_keeps_logical_identity_and_blocks_competing_copy() {
    use maka_event_log::{
        ROOT_MIGRATIONS, RootStore,
        root::{ROOT_DATABASE, ROOT_MARKER, resolve},
    };
    use serde_json::{Value, json};
    use std::sync::Arc;

    if let Some(base) = std::env::var_os("MAKA_ROOT_RELOCATION_TEST_BASE") {
        let base = Path::new(&base);
        let error = RootOwner::open(&base.join("original"), &namespaces(base))
            .err()
            .unwrap();
        assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
        return;
    }

    let temp = tempfile::tempdir().unwrap();
    let ns = namespaces(temp.path());
    let original = temp.path().join("original");
    let relocated = temp.path().join("relocated");
    let workspace = temp.path().join("workspace");
    fs::create_dir(&workspace).unwrap();

    let owner = Arc::new(RootOwner::create(&original, &ns).unwrap());
    let root_id = owner.root_id().to_owned();
    let store = RootStore::open(owner.clone(), ROOT_MIGRATIONS)
        .await
        .unwrap();
    let attached = store
        .attach_workspace("fixture", &json!({"path": workspace}))
        .await
        .unwrap();
    store.close().await.unwrap();
    drop(owner);

    fs::create_dir(&relocated).unwrap();
    for entry in fs::read_dir(&original).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_file() {
            fs::copy(entry.path(), relocated.join(entry.file_name())).unwrap();
        }
    }
    assert!(relocated.join(ROOT_MARKER).is_file());
    assert!(relocated.join(ROOT_DATABASE).is_file());
    assert_eq!(resolve(&relocated).unwrap().root_id(), root_id);

    let relocated_owner = Arc::new(RootOwner::open(&relocated, &ns).unwrap());
    assert_eq!(relocated_owner.root_id(), root_id);
    let relocated_store = RootStore::open(relocated_owner.clone(), ROOT_MIGRATIONS)
        .await
        .unwrap();
    let persisted = relocated_store
        .workspace_binding::<Value>(attached.id)
        .await
        .unwrap()
        .expect("persisted workspace binding must survive offline relocation");
    assert_eq!(persisted.workspace["path"], json!(workspace));

    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "relocated_root_keeps_logical_identity_and_blocks_competing_copy",
            "--nocapture",
        ])
        .env("MAKA_ROOT_RELOCATION_TEST_BASE", temp.path())
        .status()
        .unwrap();
    assert!(status.success());
    relocated_store.close().await.unwrap();
    drop(relocated_owner);
    assert_eq!(RootOwner::open(&original, &ns).unwrap().root_id(), root_id);
}
