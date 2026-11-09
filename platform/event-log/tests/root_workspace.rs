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

use cap_fs_ext::MetadataExt;
use cap_std::fs::Dir;
use maka_event_log::{
    ROOT_MIGRATIONS, RootStore, StoreError,
    checkpoints::{
        HistorySnapshot, ObjectRef, PublicationRequest, PublicationState, RestoreOperation, Scope,
        WorkspaceCapture, WorkspaceConsistency,
    },
    root::{RootNamespaces, RootOwner},
    root_store::RootWorkspace,
};
use maka_plugin_core::composition::InstanceId;
use maka_sandbox::workspace::DirectoryIdentity;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{io::Write, path::Path, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

async fn open(path: &Path) -> RootStore {
    let owner = RootOwner::create(
        &path.join("root"),
        &RootNamespaces {
            ownership: path.join("ownership"),
            control: path.join("control"),
        },
    )
    .unwrap();
    RootStore::open(Arc::new(owner), ROOT_MIGRATIONS)
        .await
        .unwrap()
}
async fn workspace(root: &RootStore, path: &Path) -> RootWorkspace {
    root.workspace(Dir::open_ambient_dir(path, cap_std::ambient_authority()).unwrap())
        .await
        .unwrap()
}
fn observed_identity(directory: &Dir) -> DirectoryIdentity {
    let metadata = directory.dir_metadata().unwrap();
    let birth = metadata
        .created()
        .ok()
        .and_then(|time| time.into_std().duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| (duration.as_secs(), duration.subsec_nanos()));
    let observation = serde_json::to_vec(&(metadata.dev(), metadata.ino(), birth)).unwrap();
    DirectoryIdentity::try_from(format!(
        "sha256:{}",
        hex::encode(Sha256::digest(observation))
    ))
    .unwrap()
}

#[tokio::test]
async fn actual_directory_overlap_tracks_forks_retained_custody_aliases_and_foreign_roots() {
    let temporary = tempfile::tempdir().unwrap();
    let data = temporary.path().join("workspaces");
    let a = data.join("a");
    let b = data.join("b");
    std::fs::create_dir_all(a.join("nested")).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    let root = open(temporary.path()).await;
    let first = root
        .create_session("first", "first", &json!({}), 1)
        .await
        .unwrap();
    let second = root
        .create_session("second", "second", &json!({}), 1)
        .await
        .unwrap();
    let ca = workspace(&root, &a).await;
    let cb = workspace(&root, &b).await;
    let nested = workspace(&root, &a.join("nested")).await;
    let parent = workspace(&root, &data).await;
    let (work_a, effects_a) = first
        .work_scope_in(None, &ca)
        .await
        .unwrap()
        .accept(CancellationToken::new());
    let (work_b, effects_b) = second
        .work_scope_in(None, &cb)
        .await
        .unwrap()
        .accept(CancellationToken::new());
    for overlap in [&ca, &nested, &parent] {
        assert!(matches!(
            root.fence_workspace(overlap).await,
            Err(StoreError::SessionBusy)
        ));
    }
    #[cfg(unix)]
    {
        let alias = data.join("alias");
        std::os::unix::fs::symlink(&a, &alias).unwrap();
        assert!(matches!(
            root.fence_workspace(&workspace(&root, &alias).await).await,
            Err(StoreError::SessionBusy)
        ));
    }
    let custody = work_a.store().work_custody().unwrap();
    let child = root.fork_work(custody.as_ref(), "first").unwrap();
    effects_a.settle().await.unwrap();
    work_a.finish();
    assert!(matches!(
        root.fence_workspace(&ca).await,
        Err(StoreError::SessionBusy)
    ));
    let retained = child.retain_original_material(());
    assert!(matches!(
        root.fence_workspace(&ca).await,
        Err(StoreError::SessionBusy)
    ));
    retained.confirm_cleanup();
    let exclusive = root.fence_workspace(&ca).await.unwrap();
    assert!(matches!(
        first.work_scope_in(None, &ca).await,
        Err(StoreError::SessionBusy)
    ));
    // A held exclusive on A does not prevent unrelated B from entering again.
    drop(second.work_scope_in(None, &cb).await.unwrap());
    drop(exclusive);
    effects_b.settle().await.unwrap();
    work_b.finish();

    let unknown = root
        .create_session("unknown", "unknown", &json!({}), 1)
        .await
        .unwrap();
    let (unknown, effects) = unknown
        .work_scope(None)
        .await
        .unwrap()
        .accept(CancellationToken::new());
    assert!(matches!(
        root.fence_workspace(&cb).await,
        Err(StoreError::SessionBusy)
    ));
    effects.settle().await.unwrap();
    unknown.finish();
    drop(root.fence_workspace(&cb).await.unwrap());

    let other_directory = tempfile::tempdir().unwrap();
    let other = open(other_directory.path()).await;
    let foreign_session = other
        .create_session("foreign", "foreign", &json!({}), 1)
        .await
        .unwrap();
    assert!(matches!(
        other.fence_workspace(&ca).await,
        Err(StoreError::InvalidTransition(_))
    ));
    assert!(matches!(
        foreign_session.work_scope_in(None, &ca).await,
        Err(StoreError::InvalidTransition(_))
    ));
    other.close().await.unwrap();
    root.close().await.unwrap();
}

#[tokio::test]
async fn a_new_restore_child_is_fenced_without_draining_or_blocking_a_live_sibling() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("source");
    let parent = temporary.path().join("destinations");
    let sibling = parent.join("sibling");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::create_dir_all(&sibling).unwrap();
    std::fs::write(source.join("proof.txt"), b"original workspace bytes").unwrap();
    let root = open(temporary.path()).await;
    root.create_session("source", "source", &json!({}), 1)
        .await
        .unwrap();
    let sibling_session = root
        .create_session("sibling", "sibling", &json!({}), 1)
        .await
        .unwrap();
    let candidate = root
        .create_session("candidate", "candidate", &json!({}), 1)
        .await
        .unwrap();
    let repository = root
        .history_checkpoints(
            "source",
            Scope {
                state_domain: "a".repeat(64),
                deployment: Uuid::new_v4(),
                namespace: InstanceId(vec![Uuid::new_v4()]),
            },
        )
        .await
        .unwrap();
    let source_cap = workspace(&root, &source).await;
    let source_fence = root.fence_workspace(&source_cap).await.unwrap();
    // Root treats canonical history as opaque immutable material from its owner.
    let history = b"standalone immutable history of the test domain";
    let mut snapshot = tempfile::tempfile().unwrap();
    snapshot.write_all(history).unwrap();
    let publication = repository
        .publish_fenced(
            PublicationRequest {
                operation: Uuid::new_v4(),
                fingerprint: "b".repeat(64),
                expected_revision: None,
                confirmed_subtree_digest: "c".repeat(64),
                history: HistorySnapshot {
                    object: ObjectRef {
                        digest: hex::encode(Sha256::digest(history)),
                        bytes: history.len() as u64,
                    },
                    inventory: b"owned inventory".to_vec(),
                    cut: b"owned cut".to_vec(),
                },
                workspace: Some(WorkspaceCapture {
                    root: source.clone(),
                    identity: "test-domain-workspace".into(),
                    consistency: WorkspaceConsistency::Unverified,
                }),
            },
            snapshot,
            &source_fence,
        )
        .await
        .unwrap();
    let PublicationState::Published { head } = publication.state else {
        panic!("publication must finish")
    };
    drop(source_fence);

    let sibling_cap = workspace(&root, &sibling).await;
    let (sibling_work, effects) = sibling_session
        .work_scope_in(None, &sibling_cap)
        .await
        .unwrap()
        .accept(CancellationToken::new());
    let parent_directory = Dir::open_ambient_dir(&parent, cap_std::ambient_authority()).unwrap();
    let identity = observed_identity(&parent_directory);
    let parent_cap = root.workspace(parent_directory).await.unwrap();
    let operation = RestoreOperation {
        operation: Uuid::new_v4(),
        fingerprint: "d".repeat(64),
        revision: head.revision,
        parent: parent.canonicalize().unwrap(),
        parent_identity: identity,
    };
    let (prepared, fence) = tokio::time::timeout(
        Duration::from_secs(5),
        repository.prepare_workspace_restore(operation, &parent_cap),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        std::fs::read(prepared.path.join("proof.txt")).unwrap(),
        b"original workspace bytes"
    );
    drop(
        sibling_session
            .work_scope_in(None, &sibling_cap)
            .await
            .unwrap(),
    );
    let restored = workspace(&root, &prepared.path).await;
    assert!(matches!(
        candidate.work_scope_in(None, &restored).await,
        Err(StoreError::SessionBusy)
    ));
    assert!(matches!(
        root.fence_workspace(&parent_cap).await,
        Err(StoreError::SessionBusy)
    ));
    drop(fence);
    let (child, child_effects) = candidate
        .work_scope_in(None, &restored)
        .await
        .unwrap()
        .accept(CancellationToken::new());
    child_effects.settle().await.unwrap();
    child.finish();
    effects.settle().await.unwrap();
    sibling_work.finish();
    root.close().await.unwrap();
}

#[tokio::test]
async fn one_batch_unions_aliases_and_ancestors_but_still_conflicts_with_other_physical_scopes() {
    let temporary = tempfile::tempdir().unwrap();
    let data = temporary.path().join("workspaces");
    let a = data.join("a");
    let sibling = data.join("sibling");
    std::fs::create_dir_all(a.join("nested")).unwrap();
    std::fs::create_dir_all(&sibling).unwrap();
    let root = open(temporary.path()).await;
    let session = root
        .create_session("batch", "batch", &json!({}), 1)
        .await
        .unwrap();
    let ca = workspace(&root, &a).await;
    let nested = workspace(&root, &a.join("nested")).await;
    let sibling = workspace(&root, &sibling).await;
    let alias_path = data.join("alias");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&a, &alias_path).unwrap();
    #[cfg(not(unix))]
    let alias_path = a.clone();
    let alias = workspace(&root, &alias_path).await;
    let batch = root
        .fence_workspaces(&[nested.clone(), ca.clone(), alias])
        .await
        .unwrap();
    drop(root.fence_workspace(&sibling).await.unwrap());
    assert!(matches!(
        root.fence_workspace(&nested).await,
        Err(StoreError::SessionBusy)
    ));
    drop(batch);
    let (work, effects) = session
        .work_scope_in(None, &nested)
        .await
        .unwrap()
        .accept(CancellationToken::new());
    assert!(matches!(
        root.fence_workspaces(&[ca.clone(), sibling.clone()]).await,
        Err(StoreError::SessionBusy)
    ));
    // A rejected union must not leave any member registered.
    drop(root.fence_workspace(&sibling).await.unwrap());
    effects.settle().await.unwrap();
    work.finish();
    drop(root.fence_workspaces(&[ca, nested, sibling]).await.unwrap());
    root.close().await.unwrap();
}
