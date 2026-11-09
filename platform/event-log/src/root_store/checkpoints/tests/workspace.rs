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
use crate::checkpoints::{
    LoadOperation, LoadRequest, LoadState, WorkspaceCapture, WorkspaceConsistency, WorkspaceEntry,
};

async fn publish_workspace(
    store: &RootStore,
    handle: &HistoryCheckpoints,
    publication: PublicationRequest,
) -> Result<Publication, StoreError> {
    let source = publication.workspace.as_ref().expect("workspace fixture");
    let directory = cap_std::fs::Dir::open_ambient_dir(&source.root, cap_std::ambient_authority())?;
    let workspace = store.workspace(directory).await?;
    let fence = store.fence_workspace(&workspace).await?;
    handle
        .publish_fenced(publication, snapshot_file(), &fence)
        .await
}

#[tokio::test]
async fn workspace_material_is_immutable_and_load_preserves_conditional_guarantee() {
    for mode in [
        WorkspaceConsistency::CallerConfirmedQuiescent,
        WorkspaceConsistency::Unverified,
    ] {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("project");
        std::fs::create_dir_all(source.join("empty")).unwrap();
        std::fs::create_dir_all(source.join("src")).unwrap();
        std::fs::create_dir_all(source.join(".git")).unwrap();
        std::fs::write(source.join("src/main.rs"), "original").unwrap();
        std::fs::write(source.join(".git/config"), "not archived").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            source.join("src/main.rs"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        let (store, handle, mut request) = fixture(dir.path()).await;
        request.workspace = Some(WorkspaceCapture {
            root: source.clone(),
            identity: "workspace-id".into(),
            consistency: mode,
        });
        let head = published(
            &publish_workspace(&store, &handle, request.clone())
                .await
                .unwrap(),
        );
        std::fs::write(source.join("src/main.rs"), "later version").unwrap();
        let checkout = handle.checkout_exact(head.revision).await.unwrap();
        assert_eq!(checkout.manifest.workspace().unwrap().consistency, mode);
        let operation = LoadOperation {
            operation: Uuid::new_v4(),
            fingerprint: "b".repeat(64),
            revision: head.revision,
        };
        let loaded = handle.load_exact(operation.clone()).await.unwrap();
        let LoadState::Ready {
            workspace: Some(snapshot),
            ..
        } = loaded.state
        else {
            panic!("workspace absent")
        };
        assert_eq!(snapshot.consistency, mode);
        let key = LoadRequest {
            scope: scope(),
            session_id: "source".into(),
            load: operation.clone(),
        }
        .key()
        .unwrap();
        let path = store
            .owned_root()
            .unwrap()
            .canonical_path()
            .join("history-checkpoints/inspections")
            .join(format!("{key}.workspace"));
        assert!(
            !path.exists(),
            "inspection must not copy workspace payloads"
        );
        assert_eq!(
            published(&publish_workspace(&store, &handle, request).await.unwrap()),
            head
        );
        store.close().await.unwrap();
        let store = RootStore::open(owner(dir.path()), crate::ROOT_MIGRATIONS)
            .await
            .unwrap();
        let handle = store.history_checkpoints("source", scope()).await.unwrap();
        assert!(matches!(
            handle.load_receipt(operation).await.unwrap().unwrap().state,
            LoadState::Ready {
                workspace: Some(_),
                ..
            }
        ));
        store.close().await.unwrap();
    }
}

#[tokio::test]
async fn unsafe_workspace_material_cannot_publish_a_head() {
    for kind in ["symlink", "fifo", "overlap"] {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("project");
        std::fs::create_dir(&source).unwrap();
        let (store, handle, mut request) = fixture(dir.path()).await;
        match kind {
            "symlink" => std::os::unix::fs::symlink(dir.path(), source.join("link")).unwrap(),
            "fifo" => {
                assert!(
                    std::process::Command::new("mkfifo")
                        .arg(source.join("pipe"))
                        .status()
                        .unwrap()
                        .success()
                );
            }
            _ => {}
        }
        request.workspace = Some(WorkspaceCapture {
            root: if kind == "overlap" {
                dir.path().to_owned()
            } else {
                source
            },
            identity: "workspace-id".into(),
            consistency: WorkspaceConsistency::Unverified,
        });
        assert!(
            tokio::time::timeout(
                Duration::from_secs(10),
                publish_workspace(&store, &handle, request)
            )
            .await
            .unwrap()
            .is_err()
        );
        assert!(handle.read_head().await.unwrap().is_none());
        store.close().await.unwrap();
    }
}

#[tokio::test]
async fn corrupt_workspace_object_prevents_exact_load() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("project");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("file"), "original").unwrap();
    let (store, handle, mut request) = fixture(dir.path()).await;
    request.workspace = Some(WorkspaceCapture {
        root: source,
        identity: "workspace-id".into(),
        consistency: WorkspaceConsistency::Unverified,
    });
    let head = published(&publish_workspace(&store, &handle, request).await.unwrap());
    let checkout = handle.checkout_exact(head.revision).await.unwrap();
    let objects = Objects::open(store.owned_root().unwrap()).unwrap();
    let inventory: serde_json::Value = serde_json::from_reader(
        objects
            .read(&checkout.manifest.workspace().unwrap().inventory)
            .unwrap(),
    )
    .unwrap();
    let entries: Vec<WorkspaceEntry> =
        serde_json::from_value(inventory["entries"].clone()).unwrap();
    let WorkspaceEntry::File { object, .. } = &entries[0] else {
        panic!()
    };
    std::fs::write(
        store
            .owned_root()
            .unwrap()
            .canonical_path()
            .join("history-checkpoints/objects")
            .join(&object.digest),
        "corrupt",
    )
    .unwrap();
    let request = LoadOperation {
        operation: Uuid::new_v4(),
        fingerprint: "b".repeat(64),
        revision: head.revision,
    };
    assert!(handle.load_exact(request.clone()).await.is_err());
    assert!(handle.load_receipt(request).await.unwrap().is_none());
    store.close().await.unwrap();
}

#[tokio::test]
async fn detected_external_writer_aborts_capture_even_when_caller_confirmed() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("project");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("file"), "before").unwrap();
    let (store, handle, publication) = fixture(dir.path()).await;
    let objects = Objects::open(store.owned_root().unwrap()).unwrap();
    let changed = source.join("file");
    super::super::workspace::AFTER_SCAN.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || std::fs::write(changed, "after!").unwrap()))
    });
    let request = handle.request(publication).unwrap();
    let directory =
        cap_std::fs::Dir::open_ambient_dir(&source, cap_std::ambient_authority()).unwrap();
    let error = super::super::workspace::capture(
        &objects,
        &request,
        &WorkspaceCapture {
            root: source,
            identity: "workspace".into(),
            consistency: WorkspaceConsistency::CallerConfirmedQuiescent,
        },
        &directory,
    )
    .unwrap_err();
    assert!(error.to_string().contains("changed"));
    assert!(handle.read_head().await.unwrap().is_none());
    store.close().await.unwrap();
}

async fn prepare_restore(
    store: &RootStore,
    handle: &HistoryCheckpoints,
    operation: crate::checkpoints::RestoreOperation,
) -> Result<(crate::checkpoints::PreparedRestore, WorkspaceFence), StoreError> {
    let parent = store
        .workspace(cap_std::fs::Dir::open_ambient_dir(
            &operation.parent,
            cap_std::ambient_authority(),
        )?)
        .await?;
    handle.prepare_workspace_restore(operation, &parent).await
}

async fn restore_fixture(
    path: &Path,
) -> (
    RootStore,
    HistoryCheckpoints,
    PublicationRequest,
    crate::checkpoints::RestoreOperation,
    crate::checkpoints::PreparedRestore,
    serde_json::Value,
    WorkspaceFence,
) {
    let (store, handle, mut publish) = fixture(path).await;
    let source = path.join("project");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("file"), "frozen").unwrap();
    let binding = store
        .attach_workspace("fixture", &json!({"path":source}))
        .await
        .unwrap();
    assert!(matches!(
        store
            .update_session_metadata("source", 1, move |value: &mut serde_json::Value| {
                value["workspace"] = serde_json::to_value(binding)?;
                value["boundary_revision"] = json!(1);
                Ok(())
            })
            .await
            .unwrap(),
        crate::sessions::SessionMutation::Committed(_)
    ));
    publish.workspace = Some(WorkspaceCapture {
        root: source,
        identity: "workspace".into(),
        consistency: WorkspaceConsistency::Unverified,
    });
    let head = published(
        &publish_workspace(&store, &handle, publish.clone())
            .await
            .unwrap(),
    );
    let parent = path.join("destinations");
    std::fs::create_dir(&parent).unwrap();
    let directory =
        cap_std::fs::Dir::open_ambient_dir(&parent, cap_std::ambient_authority()).unwrap();
    let operation = crate::checkpoints::RestoreOperation {
        operation: Uuid::new_v4(),
        fingerprint: "d".repeat(64),
        revision: head.revision,
        parent,
        parent_identity: super::super::restore::directory_identity(&directory).unwrap(),
    };
    let (prepared, fence) = prepare_restore(&store, &handle, operation.clone())
        .await
        .unwrap();
    let binding = store
        .attach_workspace("fixture", &json!({"path":prepared.path}))
        .await
        .unwrap();
    let configuration = json!({"title":"restored","workspace":binding,"boundary_revision":2});
    (
        store,
        handle,
        publish,
        operation,
        prepared,
        configuration,
        fence,
    )
}
async fn commit_restore(
    handle: &HistoryCheckpoints,
    operation: crate::checkpoints::RestoreOperation,
    configuration: &serde_json::Value,
    fence: &WorkspaceFence,
) -> Result<crate::checkpoints::RestoredSession, StoreError> {
    let configuration = configuration.clone();
    handle
        .commit_workspace_restore(operation, fence, move |value: &mut serde_json::Value| {
            *value = configuration.clone();
            Ok(())
        })
        .await
}
#[tokio::test]
async fn restore_receipt_is_atomic_with_binding_and_survives_later_source_changes() {
    let directory = tempfile::tempdir().unwrap();
    let (store, _handle, _, operation, prepared, configuration, original_fence) =
        restore_fixture(directory.path()).await;
    drop(original_fence);
    store.close().await.unwrap();
    let store = RootStore::open(owner(directory.path()), crate::ROOT_MIGRATIONS)
        .await
        .unwrap();
    let handle = store.history_checkpoints("source", scope()).await.unwrap();
    let (retry, fence) = prepare_restore(&store, &handle, operation.clone())
        .await
        .unwrap();
    assert_eq!(retry, prepared);
    let before = store
        .get_session::<serde_json::Value>("source")
        .await
        .unwrap()
        .unwrap();
    let log = handle.session.scoped().await.unwrap();
    log.connection.run(|db|{db.execute_batch("CREATE TRIGGER reject_restore BEFORE UPDATE ON checkpoint_workspace_restores BEGIN SELECT RAISE(ABORT,'reject receipt'); END;")?;Ok(())}).await.unwrap();
    drop(log);
    assert!(
        commit_restore(&handle, operation.clone(), &configuration, &fence)
            .await
            .is_err()
    );
    let unchanged = store
        .get_session::<serde_json::Value>("source")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unchanged.revision, before.revision);
    assert_eq!(unchanged.configuration, before.configuration);
    let log = handle.session.scoped().await.unwrap();
    log.connection
        .run(|db| {
            db.execute("DROP TRIGGER reject_restore", rusqlite::params![])?;
            Ok(())
        })
        .await
        .unwrap();
    drop(log);
    let committed = commit_restore(&handle, operation.clone(), &configuration, &fence)
        .await
        .unwrap();
    assert_eq!(committed.prepared, prepared);
    assert_eq!(
        commit_restore(&handle, operation.clone(), &configuration, &fence)
            .await
            .unwrap(),
        committed
    );
    store
        .update_session_metadata(
            "source",
            committed.session_revision,
            |value: &mut serde_json::Value| {
                value["title"] = json!("later");
                Ok(())
            },
        )
        .await
        .unwrap();
    std::fs::rename(&operation.parent, directory.path().join("moved-target")).unwrap();
    assert_eq!(
        handle
            .workspace_restore_receipt(
                operation.operation,
                operation.fingerprint.clone(),
                operation.revision
            )
            .await
            .unwrap(),
        Some(committed.clone())
    );
    store.close().await.unwrap();
    let store = RootStore::open(owner(directory.path()), crate::ROOT_MIGRATIONS)
        .await
        .unwrap();
    let handle = store.history_checkpoints("source", scope()).await.unwrap();
    assert_eq!(
        handle
            .workspace_restore_receipt(
                operation.operation,
                operation.fingerprint,
                operation.revision
            )
            .await
            .unwrap(),
        Some(committed)
    );
    store.close().await.unwrap();
}
#[tokio::test]
async fn restore_rejects_head_race_and_changed_destination_without_rebinding() {
    for race in ["head", "files", "extra", "parent", "symlink", "replacement"] {
        let directory = tempfile::tempdir().unwrap();
        let (store, handle, mut publish, operation, prepared, configuration, fence) =
            restore_fixture(directory.path()).await;
        match race {
            "head" => {
                publish.operation = Uuid::new_v4();
                publish.expected_revision = Some(operation.revision);
                publish_workspace(&store, &handle, publish).await.unwrap();
            }
            "files" => std::fs::write(prepared.path.join("file"), "modified").unwrap(),
            "parent" => {
                std::fs::rename(&operation.parent, directory.path().join("old-parent")).unwrap();
                std::fs::create_dir(&operation.parent).unwrap();
            }
            "symlink" => {
                let moved = operation.parent.join("moved-workspace");
                std::fs::rename(&prepared.path, &moved).unwrap();
                std::os::unix::fs::symlink(moved, &prepared.path).unwrap();
            }
            "replacement" => {
                std::fs::rename(&prepared.path, operation.parent.join("original-output")).unwrap();
                std::fs::create_dir(&prepared.path).unwrap();
                std::fs::write(prepared.path.join("file"), "frozen").unwrap();
            }
            _ => std::fs::write(prepared.path.join("extra"), "unrecorded").unwrap(),
        }
        let before = store
            .get_session::<serde_json::Value>("source")
            .await
            .unwrap()
            .unwrap();
        assert!(
            commit_restore(&handle, operation.clone(), &configuration, &fence)
                .await
                .is_err(),
            "accepted {race} race"
        );
        let after = store
            .get_session::<serde_json::Value>("source")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(after.revision, before.revision);
        assert_eq!(after.configuration, before.configuration);
        assert!(
            handle
                .workspace_restore_receipt(
                    operation.operation,
                    operation.fingerprint,
                    operation.revision
                )
                .await
                .unwrap()
                .is_none()
        );
        store.close().await.unwrap();
    }
}

#[tokio::test]
async fn restore_retry_never_adopts_an_occupied_destination() {
    let directory = tempfile::tempdir().unwrap();
    let (store, handle, _, mut operation, _, _, _original_fence) =
        restore_fixture(directory.path()).await;
    operation.operation = Uuid::new_v4();
    let key = crate::checkpoints::load_key(&scope(), "source", operation.operation).unwrap();
    let occupied = operation.parent.join(format!("maka-restored-{key}"));
    std::fs::create_dir(&occupied).unwrap();
    std::fs::write(occupied.join("file"), "frozen").unwrap();
    assert!(
        prepare_restore(&store, &handle, operation.clone())
            .await
            .is_err()
    );
    store.close().await.unwrap();
    let store = RootStore::open(owner(directory.path()), crate::ROOT_MIGRATIONS)
        .await
        .unwrap();
    let handle = store.history_checkpoints("source", scope()).await.unwrap();
    assert!(
        prepare_restore(&store, &handle, operation).await.is_err(),
        "retry adopted a directory it did not create"
    );
    assert_eq!(
        std::fs::read_to_string(occupied.join("file")).unwrap(),
        "frozen"
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn restore_cannot_commit_a_copy_without_a_durable_completion_record() {
    let directory = tempfile::tempdir().unwrap();
    let (store, handle, _, mut operation, _, _, _original_fence) =
        restore_fixture(directory.path()).await;
    operation.operation = Uuid::new_v4();
    let log = handle.session.scoped().await.unwrap();
    log.connection.run(|db|{
        db.execute_batch("CREATE TRIGGER reject_preparation BEFORE UPDATE OF directory_identity_json ON checkpoint_workspace_restores BEGIN SELECT RAISE(ABORT,'copy completion not recorded'); END;")?;
        Ok(())
    }).await.unwrap();
    drop(log);
    assert!(
        prepare_restore(&store, &handle, operation.clone())
            .await
            .is_err()
    );
    let key = crate::checkpoints::load_key(&scope(), "source", operation.operation).unwrap();
    let path = operation.parent.join(format!("maka-restored-{key}"));
    assert_eq!(
        std::fs::read_to_string(path.join("file")).unwrap(),
        "frozen"
    );
    let binding = store
        .attach_workspace("fixture", &json!({"path":path}))
        .await
        .unwrap();
    let configuration = json!({"workspace":binding,"boundary_revision":2});
    let owner = store.log.owned_root().unwrap();
    let parent =
        cap_std::fs::Dir::open_ambient_dir(&operation.parent, cap_std::ambient_authority())
            .unwrap();
    let slot = crate::root_store::workspace_fence::ChildSlot::reserve(
        &store.gates,
        &owner,
        parent.try_clone().unwrap(),
        path.file_name().unwrap().to_owned(),
    )
    .unwrap();
    use cap_fs_ext::DirExt;
    slot.bind_existing(
        &store.gates,
        parent.open_dir_nofollow(path.file_name().unwrap()).unwrap(),
    )
    .unwrap();
    let fence = slot.fence();
    assert!(
        commit_restore(&handle, operation, &configuration, &fence)
            .await
            .is_err()
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn workspace_ignores_build_outputs_and_secrets_but_keeps_certificate_fixtures() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("project");
    for child in [
        ".git/info",
        ".github/workflows",
        "target",
        ".venv",
        "nested",
        "fixtures",
    ] {
        std::fs::create_dir_all(source.join(child)).unwrap();
    }
    std::fs::write(
        source.join(".gitignore"),
        "target/\n.venv/\n*.log\n!keep.log\n",
    )
    .unwrap();
    std::fs::write(source.join(".git/info/exclude"), "local-only\n").unwrap();
    std::fs::write(source.join("nested/.gitignore"), "ignored\n").unwrap();
    for file in [
        "target/output",
        ".venv/bin",
        "build.log",
        "local-only",
        "nested/ignored",
        ".env",
        ".env.local",
        ".env.example",
        ".github/workflows/ci.yml",
        "fixtures/test.pem",
        "fixtures/test.key",
        "keep.log",
        "nested/keep",
    ] {
        std::fs::write(source.join(file), file).unwrap();
    }
    std::os::unix::fs::symlink("/nonexistent", source.join("target/link")).unwrap();
    let (store, handle, mut request) = fixture(dir.path()).await;
    request.workspace = Some(WorkspaceCapture {
        root: source,
        identity: "workspace".into(),
        consistency: WorkspaceConsistency::Unverified,
    });
    let head = published(&publish_workspace(&store, &handle, request).await.unwrap());
    let checkout = handle.checkout_exact(head.revision).await.unwrap();
    let objects = Objects::open(store.owned_root().unwrap()).unwrap();
    let inventory: serde_json::Value = serde_json::from_reader(
        objects
            .read(&checkout.manifest.workspace().unwrap().inventory)
            .unwrap(),
    )
    .unwrap();
    let paths = inventory["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["path"].as_str().unwrap())
        .collect::<std::collections::BTreeSet<_>>();
    for retained in [
        ".env.example",
        ".github/workflows/ci.yml",
        "fixtures/test.pem",
        "fixtures/test.key",
        "keep.log",
        "nested/keep",
    ] {
        assert!(paths.contains(retained), "missing {retained}: {paths:?}");
    }
    for omitted in [
        "target",
        ".venv",
        "build.log",
        "local-only",
        "nested/ignored",
        ".env",
        ".env.local",
        ".git",
    ] {
        assert!(!paths.contains(omitted), "unexpected {omitted}: {paths:?}");
    }
    assert!(inventory.get("version").is_none());
    store.close().await.unwrap();
}

#[tokio::test]
async fn restore_allows_metadata_changes_and_repeated_restore_of_the_same_history() {
    let directory = tempfile::tempdir().unwrap();
    let (store, handle, _, original, _, mut configuration, _original_fence) =
        restore_fixture(directory.path()).await;
    let current = store
        .get_session::<serde_json::Value>("source")
        .await
        .unwrap()
        .unwrap();
    store
        .update_session_metadata(
            "source",
            current.revision,
            |value: &mut serde_json::Value| {
                value["title"] = json!("renamed after checkpoint");
                Ok(())
            },
        )
        .await
        .unwrap();
    let mut request = original.clone();
    request.operation = Uuid::new_v4();
    request.fingerprint = "e".repeat(64);
    let (prepared, fence) = prepare_restore(&store, &handle, request.clone())
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(prepared.path.join("file")).unwrap(),
        "frozen"
    );
    configuration["workspace"] = serde_json::to_value(
        store
            .attach_workspace("fixture", &json!({"path":prepared.path}))
            .await
            .unwrap(),
    )
    .unwrap();
    commit_restore(&handle, request, &configuration, &fence)
        .await
        .unwrap();
    let mut again = original;
    again.operation = Uuid::new_v4();
    again.fingerprint = "f".repeat(64);
    let (second, second_fence) = prepare_restore(&store, &handle, again.clone())
        .await
        .unwrap();
    assert_ne!(prepared.path, second.path);
    // A concurrent metadata edit must survive rebinding the restored workspace.
    let live = store
        .get_session::<serde_json::Value>("source")
        .await
        .unwrap()
        .unwrap();
    store
        .update_session_metadata("source", live.revision, |value: &mut serde_json::Value| {
            value["title"] = json!("renamed between prepare and commit");
            Ok(())
        })
        .await
        .unwrap();
    let new_binding = store
        .attach_workspace("fixture", &json!({"path":second.path}))
        .await
        .unwrap();
    let restored = handle
        .commit_workspace_restore(
            again,
            &second_fence,
            move |value: &mut serde_json::Value| {
                value["workspace"] = serde_json::to_value(new_binding)?;
                value["boundary_revision"] = json!(3);
                Ok(())
            },
        )
        .await
        .unwrap();
    let after = store
        .get_session::<serde_json::Value>("source")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after.revision, restored.session_revision);

    assert_eq!(
        after.configuration["title"],
        "renamed between prepare and commit"
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn case_colliding_paths_fail_before_publishing_a_head() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("project");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("Readme.md"), "upper").unwrap();
    let probe = source.join("readme.md");
    std::fs::write(&probe, "lower").unwrap();
    if std::fs::read_to_string(source.join("Readme.md")).unwrap() == "lower" {
        // Case-insensitive host filesystem cannot create colliding siblings in the first place.
        return;
    }
    let (store, handle, mut request) = fixture(dir.path()).await;
    request.workspace = Some(WorkspaceCapture {
        root: source,
        identity: "workspace-id".into(),
        consistency: WorkspaceConsistency::CallerConfirmedQuiescent,
    });
    let outcome = publish_workspace(&store, &handle, request).await;
    assert!(
        outcome.is_err(),
        "expected case-collision failure: {outcome:?}"
    );
    assert!(handle.read_head().await.unwrap().is_none());
    store.close().await.unwrap();
}
