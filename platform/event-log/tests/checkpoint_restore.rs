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

// Keep this crash check in its own binary so fork cannot inherit other tests' Root leases.
use cap_fs_ext::MetadataExt;
use cap_std::{ambient_authority, fs::Dir};
use maka_event_log::{
    ROOT_MIGRATIONS, RootStore, StoreError,
    checkpoints::{
        HistorySnapshot, ObjectRef, PreparedRestore, PublicationRequest, PublicationState,
        RestoreOperation, Scope, WorkspaceCapture, WorkspaceConsistency,
    },
    root::{RootNamespaces, RootOwner},
    writeback::{Notification, Prepared, Statement},
};
use maka_plugin_core::composition::InstanceId;
use maka_sandbox::workspace::{BindingRef, DirectoryIdentity};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path, sync::Arc};
use uuid::Uuid;

const CHILD_ROOT: &str = "MAKA_TEST_PREPARED_RESTORE_ROOT";
const ABRUPT_EXIT: i32 = 86;

fn namespaces(base: &Path) -> RootNamespaces {
    RootNamespaces {
        ownership: base.join("owners"),
        control: base.join("control"),
    }
}
fn scope() -> Scope {
    Scope {
        state_domain: "a".repeat(64),
        deployment: Uuid::from_u128(1),
        namespace: InstanceId(vec![Uuid::from_u128(2)]),
    }
}
fn open_directory(path: &Path) -> Dir {
    Dir::open_ambient_dir(path, ambient_authority()).unwrap()
}
fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn directory_identity(directory: &Dir) -> DirectoryIdentity {
    let metadata = directory.dir_metadata().unwrap();
    let birth = metadata
        .created()
        .ok()
        .and_then(|time| time.into_std().duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| (duration.as_secs(), duration.subsec_nanos()));
    DirectoryIdentity::try_from(format!(
        "sha256:{}",
        digest(&serde_json::to_vec(&(metadata.dev(), metadata.ino(), birth)).unwrap())
    ))
    .unwrap()
}
async fn open(base: &Path, create: bool) -> RootStore {
    let owner = if create {
        RootOwner::create(&base.join("root"), &namespaces(base))
    } else {
        RootOwner::open(&base.join("root"), &namespaces(base))
    }
    .unwrap();
    RootStore::open(Arc::new(owner), ROOT_MIGRATIONS)
        .await
        .unwrap()
}

async fn prepare_in_child(base: &Path) {
    let store = open(base, true).await;
    let source = base.join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("file"), b"frozen").unwrap();
    let binding = store
        .attach_workspace("fixture", &json!({"path":source}))
        .await
        .unwrap();
    store
        .create_session(
            "source",
            "create",
            &json!({"title":"original","workspace":binding,"boundary_revision":0}),
            1,
        )
        .await
        .unwrap();
    let handle = store.history_checkpoints("source", scope()).await.unwrap();
    let bytes = b"opaque immutable history owned by the native domain";
    let mut snapshot = tempfile::tempfile().unwrap();
    snapshot.write_all(bytes).unwrap();
    let workspace = store.workspace(open_directory(&source)).await.unwrap();
    let capture_fence = store.fence_workspace(&workspace).await.unwrap();
    let publication = handle
        .publish_fenced(
            PublicationRequest {
                operation: Uuid::from_u128(3),
                fingerprint: "b".repeat(64),
                expected_revision: None,
                confirmed_subtree_digest: digest(b"fixture-membership"),
                history: HistorySnapshot {
                    object: ObjectRef {
                        digest: digest(bytes),
                        bytes: bytes.len() as u64,
                    },
                    inventory: b"fixture-inventory".to_vec(),
                    cut: b"fixture-cut".to_vec(),
                },
                workspace: Some(WorkspaceCapture {
                    root: source,
                    identity: "fixture-workspace".into(),
                    consistency: WorkspaceConsistency::Unverified,
                }),
            },
            snapshot,
            &capture_fence,
        )
        .await
        .unwrap();
    let PublicationState::Published { head } = publication.state else {
        panic!("checkpoint was not published");
    };
    drop(capture_fence);
    let parent = base.join("destinations");
    fs::create_dir(&parent).unwrap();
    let directory = open_directory(&parent);
    let operation = RestoreOperation {
        operation: Uuid::from_u128(4),
        fingerprint: "d".repeat(64),
        revision: head.revision,
        parent,
        parent_identity: directory_identity(&directory),
    };
    let parent = store.workspace(directory).await.unwrap();
    let (prepared, _restore_fence) = handle
        .prepare_workspace_restore(operation.clone(), &parent)
        .await
        .unwrap();
    let binding = store
        .attach_workspace("fixture", &json!({"path":prepared.path}))
        .await
        .unwrap();
    fs::write(
        base.join("retry.json"),
        serde_json::to_vec(&(operation, prepared, binding)).unwrap(),
    )
    .unwrap();
    // The original Root, SQL actors and physical fence remain owned at process death.
    std::process::exit(ABRUPT_EXIT);
}

enum ReceiptFailure {
    Enable,
    Disable,
}
impl Statement for ReceiptFailure {
    type Value = ();
    type Output = ();
    fn execute(self, db: &rusqlite::Connection) -> Result<Prepared<()>, StoreError> {
        db.execute_batch(match self {
            Self::Enable => "CREATE TRIGGER reject_restore BEFORE UPDATE OF result_json ON checkpoint_workspace_restores BEGIN SELECT RAISE(ABORT,'reject restore receipt'); END;",
            Self::Disable => "DROP TRIGGER reject_restore;",
        })?;
        Ok(Prepared {
            value: (),
            changed: true,
            notification: Notification::NONE,
        })
    }
    fn committed(_: ()) {}
    fn isolated_rejection(_: &StoreError) -> bool {
        false
    }
}

async fn recover_and_commit(base: &Path) {
    let (operation, prepared, binding): (RestoreOperation, PreparedRestore, BindingRef) =
        serde_json::from_slice(&fs::read(base.join("retry.json")).unwrap()).unwrap();
    fs::write(base.join("source/file"), b"later source").unwrap();
    let store = open(base, false).await;
    let handle = store.history_checkpoints("source", scope()).await.unwrap();
    let parent = store
        .workspace(open_directory(&operation.parent))
        .await
        .unwrap();
    let (retried, fence) = handle
        .prepare_workspace_restore(operation.clone(), &parent)
        .await
        .unwrap();
    assert_eq!(retried, prepared);
    assert_eq!(fs::read_dir(&operation.parent).unwrap().count(), 1);
    assert_eq!(fs::read(prepared.path.join("file")).unwrap(), b"frozen");
    assert!(
        handle
            .workspace_restore_receipt(
                operation.operation,
                operation.fingerprint.clone(),
                operation.revision,
            )
            .await
            .unwrap()
            .is_none()
    );
    let session = store.session("source").await.unwrap();
    let before = session.get::<Value>().await.unwrap().unwrap();
    assert_eq!(before.configuration["title"], "original");
    let configuration = json!({"title":"restored","workspace":binding,"boundary_revision":1});
    let writer = store.data_writer().unwrap();
    writer.write(ReceiptFailure::Enable).await.unwrap();
    let candidate = configuration.clone();
    let error = handle
        .commit_workspace_restore(operation.clone(), &fence, move |value: &mut Value| {
            *value = candidate.clone();
            Ok(())
        })
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("reject restore receipt"),
        "{error}"
    );
    let unchanged = session.get::<Value>().await.unwrap().unwrap();
    assert_eq!(unchanged.revision, before.revision);
    assert_eq!(unchanged.configuration, before.configuration);
    assert!(
        handle
            .workspace_restore_receipt(
                operation.operation,
                operation.fingerprint.clone(),
                operation.revision,
            )
            .await
            .unwrap()
            .is_none()
    );
    writer.write(ReceiptFailure::Disable).await.unwrap();
    let committed = handle
        .commit_workspace_restore(operation.clone(), &fence, move |value: &mut Value| {
            *value = configuration.clone();
            Ok(())
        })
        .await
        .unwrap();
    let after = session.get::<Value>().await.unwrap().unwrap();
    assert_eq!(after.configuration["title"], "restored");
    assert_eq!(after.workspace_binding.unwrap().reference(), binding);
    assert_eq!(after.revision, committed.session_revision);
    drop(fence);
    store.close().await.unwrap();

    fs::write(base.join("source/file"), b"source changed again").unwrap();
    let store = open(base, false).await;
    let handle = store.history_checkpoints("source", scope()).await.unwrap();
    assert_eq!(
        handle
            .workspace_restore_receipt(
                operation.operation,
                operation.fingerprint,
                operation.revision,
            )
            .await
            .unwrap(),
        Some(committed)
    );
    assert_eq!(fs::read(prepared.path.join("file")).unwrap(), b"frozen");
    store.close().await.unwrap();
}

#[test]
fn prepared_workspace_restore_survives_process_crash_and_commits_receipt_atomically() {
    if let Some(base) = std::env::var_os(CHILD_ROOT) {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(prepare_in_child(Path::new(&base)));
        panic!("child must exit with the original Root still owned");
    }
    let directory = tempfile::tempdir().unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "prepared_workspace_restore_survives_process_crash_and_commits_receipt_atomically",
        ])
        .env(CHILD_ROOT, directory.path())
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(ABRUPT_EXIT));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(recover_and_commit(directory.path()));
}
