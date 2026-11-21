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

#[test]
fn validate_current_fences_marker_tampering_and_parent_rebind() {
    use maka_event_log::root::ROOT_MARKER;
    use std::io::{Seek, SeekFrom, Write};

    // 1. In-place overwrite keeping the exact same inode and byte length.
    {
        let temp = tempfile::tempdir().unwrap();
        let ns = namespaces(temp.path());
        let path = temp.path().join("root");
        let owner = RootOwner::create(&path, &ns).unwrap();
        owner.validate_current().unwrap();

        let marker = path.join(ROOT_MARKER);
        let original = fs::read(&marker).unwrap();
        let mut tampered = original.clone();
        let idx = tampered
            .iter()
            .position(|b| b.is_ascii_hexdigit())
            .expect("marker contains hex id bytes");
        tampered[idx] = if tampered[idx] == b'0' { b'1' } else { b'0' };
        assert_eq!(tampered.len(), original.len());

        let mut file = fs::OpenOptions::new().write(true).open(&marker).unwrap();
        file.seek(SeekFrom::Start(0)).unwrap();
        file.write_all(&tampered).unwrap();
        file.sync_all().unwrap();
        drop(file);

        assert!(
            owner.validate_current().is_err(),
            "in-place same-length marker overwrite must be fenced immediately"
        );
    }

    // 2. Atomic rename-replace of the marker file.
    {
        let temp = tempfile::tempdir().unwrap();
        let ns = namespaces(temp.path());
        let path = temp.path().join("root");
        let owner = RootOwner::create(&path, &ns).unwrap();
        owner.validate_current().unwrap();

        let replacement = path.join("marker.tmp");
        fs::write(
            &replacement,
            br#"{"rootId":"00000000-0000-0000-0000-000000000000"}"#,
        )
        .unwrap();
        fs::rename(&replacement, path.join(ROOT_MARKER)).unwrap();

        assert!(
            owner.validate_current().is_err(),
            "atomically replaced marker must be fenced immediately"
        );
    }

    // 3. Marker deletion.
    {
        let temp = tempfile::tempdir().unwrap();
        let ns = namespaces(temp.path());
        let path = temp.path().join("root");
        let owner = RootOwner::create(&path, &ns).unwrap();
        owner.validate_current().unwrap();

        fs::remove_file(path.join(ROOT_MARKER)).unwrap();
        assert!(
            owner.validate_current().is_err(),
            "deleted marker must be fenced immediately"
        );
    }

    // 4. Ancestor directory renamed and replaced by symlink to another directory (Unix).
    #[cfg(unix)]
    {
        let temp = tempfile::tempdir().unwrap();
        let ns = namespaces(temp.path());
        let parent = temp.path().join("parent");
        let decoy = temp.path().join("decoy");
        fs::create_dir(&parent).unwrap();
        fs::create_dir(&decoy).unwrap();
        let path = parent.join("root");
        let owner = RootOwner::create(&path, &ns).unwrap();
        owner.validate_current().unwrap();

        let moved = temp.path().join("parent-moved");
        fs::rename(&parent, &moved).unwrap();
        std::os::unix::fs::symlink(&decoy, &parent).unwrap();

        assert!(
            owner.validate_current().is_err(),
            "rebound ancestor directory must be fenced immediately"
        );
    }
}

#[tokio::test]
async fn concurrent_fresh_workspace_creation_converges_on_single_project() {
    use maka_event_log::{
        ROOT_MIGRATIONS, RootStore, projects::ProjectRegistration,
        root_store::SessionCreationRequest,
    };
    use serde_json::json;
    use std::collections::BTreeSet;
    use std::sync::Arc;
    use tokio::sync::Barrier;

    let temp = tempfile::tempdir().unwrap();
    let ns = namespaces(temp.path());
    let root_path = temp.path().join("root");
    let workspace = temp.path().join("brand-new-workspace");
    fs::create_dir(&workspace).unwrap();
    let ws_str = workspace.to_string_lossy().to_string();

    let owner = Arc::new(RootOwner::create(&root_path, &ns).unwrap());
    let store = Arc::new(RootStore::open(owner, ROOT_MIGRATIONS).await.unwrap());

    const N: usize = 16;
    let barrier = Arc::new(Barrier::new(N));
    let mut set = tokio::task::JoinSet::new();
    for i in 0..N {
        let store = store.clone();
        let ws = ws_str.clone();
        let barrier = barrier.clone();
        set.spawn(async move {
            let writer = store.data_writer().unwrap();
            // All N tasks plan the fresh workspace BEFORE anyone commits, reproducing the exact race.
            let plan = store
                .plan_available_project(
                    ProjectRegistration {
                        identity: format!("dir:{ws}"),
                        name: "brand-new-workspace".into(),
                        path: ws.clone(),
                        is_worktree: false,
                    },
                    1000 + i as u64,
                    &writer,
                )
                .await
                .unwrap();
            barrier.wait().await;
            let sid = format!("session-race-{i}");
            let fp = format!("fp-race-{i}");
            let creation = store
                .prepare_session_creation(
                    SessionCreationRequest {
                        id: &sid,
                        fingerprint: &fp,
                        owner_scope: "test/agent",
                        workspace: move |project_id| {
                            json!({
                                "kind": "directory",
                                "path": ws,
                                "projectId": project_id,
                            })
                        },
                        project: Some(plan),
                        now: 1000 + i as u64,
                    },
                    &writer,
                    |binding| {
                        Ok(json!({
                            "workspace": binding,
                            "boundary_revision": 1,
                        }))
                    },
                )
                .await
                .expect(
                    "concurrent fresh-workspace creation must not fail with ProjectError::Changed",
                );
            writer.write(creation).await.unwrap();
            let record = store
                .get_session::<serde_json::Value>(&sid)
                .await
                .unwrap()
                .expect("session committed");
            let binding_id = record.configuration["workspace"]["id"]
                .as_str()
                .unwrap()
                .to_owned();
            let binding_uuid = uuid::Uuid::parse_str(&binding_id).unwrap();
            let binding = store
                .workspace_binding::<serde_json::Value>(binding_uuid)
                .await
                .unwrap()
                .expect("workspace binding");
            binding.workspace["projectId"].as_str().unwrap().to_owned()
        });
    }

    let mut project_ids = BTreeSet::new();
    while let Some(res) = set.join_next().await {
        project_ids.insert(res.unwrap());
    }
    assert_eq!(
        project_ids.len(),
        1,
        "all {N} concurrent creations must converge on a single project_id, got {project_ids:?}"
    );
    let projects = store.list_projects().await.unwrap();
    assert_eq!(projects.len(), 1);
    Arc::try_unwrap(store).ok().unwrap().close().await.unwrap();
}
