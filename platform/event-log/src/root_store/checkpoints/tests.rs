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
use serde_json::json;
use std::{
    path::Path,
    time::{Duration, Instant},
};
use uuid::Uuid;

fn namespaces(path: &Path) -> root::RootNamespaces {
    root::RootNamespaces {
        ownership: path.join("ownership"),
        control: path.join("control"),
    }
}
fn owner(path: &Path) -> Arc<root::RootOwner> {
    let path_to_root = path.join("root");
    Arc::new(if path_to_root.exists() {
        root::RootOwner::open(&path_to_root, &namespaces(path)).unwrap()
    } else {
        root::RootOwner::create(&path_to_root, &namespaces(path)).unwrap()
    })
}
fn scope() -> Scope {
    Scope {
        state_domain: "a".repeat(64),
        deployment: Uuid::from_u128(1),
        namespace: maka_plugin_core::composition::InstanceId(vec![Uuid::from_u128(2)]),
    }
}
async fn fixture(path: &Path) -> (RootStore, HistoryCheckpoints, PublicationRequest) {
    let store = RootStore::open(owner(path)).await.unwrap();
    store
        .create_session("source", "create", &json!({"title":"original"}), 1)
        .await
        .unwrap();
    let handle = store.history_checkpoints("source", scope()).await.unwrap();
    let request = PublicationRequest {
        operation: Uuid::from_u128(3),
        fingerprint: "a".repeat(64),
        expected_revision: None,
        confirmed_subtree_digest: store.preview_bundle("source").await.unwrap().subtree_digest,
    };
    (store, handle, request)
}
fn published(value: &Publication) -> Head {
    match &value.state {
        PublicationState::Published { head } => head.clone(),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn publish_replay_exact_checkout_and_head_cas() {
    let directory = tempfile::tempdir().unwrap();
    let (store, handle, request) = fixture(directory.path()).await;
    let value = handle.publish(request.clone()).await.unwrap();
    assert!(!value.cleanup_pending);
    let first = published(&value);
    assert_eq!(handle.read_head().await.unwrap(), Some(first.clone()));
    let checkout = handle.checkout_exact(first.revision).await.unwrap();
    let mut staged = StagedBundle::read(tokio::fs::File::from_std(checkout.bundle))
        .await
        .unwrap();
    staged.validate_history().await.unwrap();
    let before: serde_json::Value = staged.configuration("source").await.unwrap();
    assert_eq!(before["title"], "original");
    staged.close().await.unwrap();
    store
        .update_session_metadata::<serde_json::Value, _>("source", 1, |config| {
            config["title"] = json!("later");
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(handle.publish(request.clone()).await.unwrap(), value);
    let mut next = request.clone();
    next.operation = Uuid::from_u128(4);
    next.expected_revision = Some(first.revision);
    let second = published(&handle.publish(next).await.unwrap());
    assert_ne!(first.revision, second.revision);
    assert!(
        handle
            .checkout_exact(first.revision)
            .await
            .unwrap_err()
            .to_string()
            .contains("unavailable")
    );
    assert_eq!(handle.receipt(request).await.unwrap().unwrap(), value);
    store.close().await.unwrap();
    assert!(matches!(
        handle.read_head().await,
        Err(StoreError::ConnectionClosed)
    ));
}

#[tokio::test]
async fn concurrent_cas_and_identity_conflicts() {
    let directory = tempfile::tempdir().unwrap();
    let (store, handle, first) = fixture(directory.path()).await;
    let mut second = first.clone();
    second.operation = Uuid::from_u128(4);
    let (a, b) = tokio::join!(handle.publish(first.clone()), handle.publish(second));
    let outcomes = [a.unwrap(), b.unwrap()];
    assert_eq!(
        outcomes
            .iter()
            .filter(|p| matches!(p.state, PublicationState::Published { .. }))
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|p| matches!(p.state, PublicationState::Conflict { .. }))
            .count(),
        1
    );
    let mut changed = first;
    changed.fingerprint = "b".repeat(64);
    assert!(
        handle
            .publish(changed)
            .await
            .unwrap_err()
            .to_string()
            .contains("differ")
    );
    let mut other = scope();
    other.namespace.0.push(Uuid::from_u128(6));
    let other = store.history_checkpoints("source", other).await.unwrap();
    assert!(
        other
            .read_head()
            .await
            .unwrap_err()
            .to_string()
            .contains("binding")
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn prepared_bytes_survive_live_changes_and_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let (store, handle, input) = fixture(directory.path()).await;
    let request = handle.request(input.clone()).unwrap();
    let log = handle.session.scoped().await.unwrap();
    let objects = Objects::open(store.owned_root().unwrap()).unwrap();
    journal::claim(&log, request.clone()).await.unwrap();
    let manifest = capture(&log, &objects, &request).await.unwrap();
    journal::prepare(&log, request, manifest.clone())
        .await
        .unwrap();
    drop(log);
    store
        .update_session_metadata::<serde_json::Value, _>("source", 1, |config| {
            config["title"] = json!("changed after prepare");
            Ok(())
        })
        .await
        .unwrap();
    drop(objects);
    store.close().await.unwrap();
    let store = RootStore::open(owner(directory.path())).await.unwrap();
    let handle = store.history_checkpoints("source", scope()).await.unwrap();
    let value = handle.receipt(input.clone()).await.unwrap().unwrap();
    assert_eq!(published(&value).manifest, manifest);
    let checkout = handle
        .checkout_exact(published(&value).revision)
        .await
        .unwrap();
    let mut staged = StagedBundle::read(tokio::fs::File::from_std(checkout.bundle))
        .await
        .unwrap();
    let config: serde_json::Value = staged.configuration("source").await.unwrap();
    assert_eq!(config["title"], "original");
    staged.close().await.unwrap();
    assert_eq!(handle.publish(input).await.unwrap(), value);
    store.close().await.unwrap();
}

#[tokio::test]
async fn corrupt_object_cannot_be_checked_out_or_published() {
    let directory = tempfile::tempdir().unwrap();
    let (store, handle, input) = fixture(directory.path()).await;
    let request = handle.request(input.clone()).unwrap();
    let log = handle.session.scoped().await.unwrap();
    let objects = Objects::open(store.owned_root().unwrap()).unwrap();
    journal::claim(&log, request.clone()).await.unwrap();
    let manifest = capture(&log, &objects, &request).await.unwrap();
    journal::prepare(&log, request.clone(), manifest.clone())
        .await
        .unwrap();
    let value = objects.manifest(&manifest).unwrap();
    let path = directory
        .path()
        .join("root/history-checkpoints/objects")
        .join(&value.bundle().digest);
    std::fs::write(&path, b"broken").unwrap();
    assert!(
        verify(&objects, &request, &manifest)
            .await
            .unwrap_err()
            .to_string()
            .contains("digest")
    );
    assert!(handle.read_head().await.unwrap().is_none());
    drop(log);
    drop(objects);
    store.close().await.unwrap();
    let store = RootStore::open(owner(directory.path())).await.unwrap();
    let handle = store.history_checkpoints("source", scope()).await.unwrap();
    assert!(matches!(
        handle.receipt(input).await.unwrap().unwrap().state,
        PublicationState::Unavailable { .. }
    ));
    assert!(handle.read_head().await.unwrap().is_none());
    assert!(
        store
            .get_session::<serde_json::Value>("source")
            .await
            .unwrap()
            .is_some()
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn cleanup_failure_does_not_undo_publication_and_retries_only_cleanup() {
    let directory = tempfile::tempdir().unwrap();
    let (store, handle, input) = fixture(directory.path()).await;
    let request = handle.request(input.clone()).unwrap();
    let log = handle.session.scoped().await.unwrap();
    let objects = Objects::open(store.owned_root().unwrap()).unwrap();
    journal::claim(&log, request.clone()).await.unwrap();
    let manifest = capture(&log, &objects, &request).await.unwrap();
    journal::prepare(&log, request.clone(), manifest.clone())
        .await
        .unwrap();
    let result = journal::commit(&log, request.clone(), manifest)
        .await
        .unwrap();
    let staging = objects.staging(&request, "manifest").unwrap();
    std::fs::remove_file(&staging).unwrap();
    std::fs::create_dir(&staging).unwrap();
    let failed_cleanup = handle.publish(input.clone()).await.unwrap();
    assert_eq!(failed_cleanup.state, result.state);
    assert!(failed_cleanup.cleanup_pending);
    assert!(
        failed_cleanup
            .cleanup_error
            .as_deref()
            .unwrap()
            .contains("regular")
    );
    drop(log);
    drop(objects);
    store.close().await.unwrap();
    let store = RootStore::open(owner(directory.path())).await.unwrap();
    let handle = store.history_checkpoints("source", scope()).await.unwrap();
    assert_eq!(
        handle.receipt(input.clone()).await.unwrap(),
        Some(failed_cleanup)
    );
    std::fs::remove_dir(&staging).unwrap();
    let cleaned = handle.publish(input).await.unwrap();
    assert!(!cleaned.cleanup_pending);
    assert!(cleaned.cleanup_error.is_none());
    assert_eq!(cleaned.state, result.state);
    store.close().await.unwrap();
}

#[tokio::test]
async fn abandoning_observer_does_not_release_physical_work_before_close() {
    let directory = tempfile::tempdir().unwrap();
    let (store, handle, _) = fixture(directory.path()).await;
    let (ready, started) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    let log = handle.session.scoped().await.unwrap();
    let gates = handle.session.gates.clone();
    let task = tokio::spawn(worker(log, gates, move |_, _| async move {
        ready.send(()).unwrap();
        released.await.unwrap();
        Ok(())
    }));
    started.await.unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    let closed = store.close();
    tokio::pin!(closed);
    assert!(futures_util::poll!(&mut closed).is_pending());
    assert!(
        root::RootOwner::open(
            &directory.path().join("root"),
            &namespaces(directory.path())
        )
        .is_err()
    );
    release.send(()).unwrap();
    closed.await.unwrap();
}

#[tokio::test]
async fn real_history_and_artifact_are_verified_but_busy_source_is_not_published() {
    use maka_agent_facts::{
        artifact::{Artifact, ArtifactKind, ArtifactSource, content_digest},
        attachment::{AttachmentKind, AttachmentRef, StorageRef},
        event::{EventWrite, Fact, Invocation, InvocationInput, InvocationOutcome, RuntimeEvent},
        input::{DeliveredMessage, MessageInput},
        message::{MessageDisposition, Placement, RootSourceMessage},
    };
    let directory = tempfile::tempdir().unwrap();
    let (store, handle, input) = fixture(directory.path()).await;
    let log = handle.session.scoped().await.unwrap();
    log.commit_artifact(
        Artifact {
            id: "upload".into(),
            session_id: "source".into(),
            turn_id: "upload".into(),
            created_at: 2,
            name: "input.txt".into(),
            kind: ArtifactKind::File,
            size_bytes: 5,
            mime_type: Some("text/plain".into()),
            source: ArtifactSource::UserUpload,
            summary: Some(content_digest(b"hello")),
        },
        b"hello",
    )
    .await
    .unwrap();
    let mut content: MessageInput = "actual checkpoint history".to_owned().into();
    content.attachments = Some(vec![AttachmentRef {
        kind: AttachmentKind::Other,
        name: "input.txt".into(),
        mime_type: "text/plain".into(),
        bytes: 5,
        storage_ref: StorageRef::SessionFile {
            session_id: "source".into(),
            relative_path: "upload".into(),
        },
    }]);
    let source = RootSourceMessage {
        message: DeliveredMessage {
            origin: None,
            message_id: "message".into(),
            content: content.clone(),
            submitted_content_digest: content.content_digest().unwrap(),
        },
        unprepared_content: content.clone(),
        submitted_placement: Placement::CurrentTurn,
        disposition: MessageDisposition::TurnStarted,
        submitted_intent: None,
    };
    let invocation = Invocation {
        session_id: "source".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "inv".into(),
    };
    log.append(
        &EventWrite::plain(RuntimeEvent::new(
            invocation.clone(),
            Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    content,
                    source_messages: vec![source],
                    request_fingerprint: None,
                },
            },
        ))
        .unwrap(),
    )
    .await
    .unwrap();
    assert!(matches!(
        handle.publish(input.clone()).await,
        Err(StoreError::SessionBusy)
    ));
    assert!(handle.read_head().await.unwrap().is_none());
    log.append(
        &EventWrite::plain(RuntimeEvent::new(
            invocation,
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Completed,
            },
        ))
        .unwrap(),
    )
    .await
    .unwrap();
    drop(log);
    assert_eq!(
        handle.publish(input.clone()).await.unwrap().state,
        PublicationState::Interrupted
    );
    let mut next = input;
    next.operation = Uuid::from_u128(9);
    let head = published(&handle.publish(next).await.unwrap());
    let checkout = handle.checkout_exact(head.revision).await.unwrap();
    let mut staged = StagedBundle::read(tokio::fs::File::from_std(checkout.bundle))
        .await
        .unwrap();
    staged.validate_history().await.unwrap();
    assert_eq!(staged.artifact_count().await.unwrap(), 1);
    staged.close().await.unwrap();
    store.close().await.unwrap();
}

#[tokio::test]
async fn source_retirement_does_not_erase_checkpoint_or_original_receipt() {
    use crate::sessions::{RemovalAuthority, RemoveFamilyResult};
    let directory = tempfile::tempdir().unwrap();
    let (store, handle, input) = fixture(directory.path()).await;
    let value = handle.publish(input.clone()).await.unwrap();
    let head = published(&value);
    assert!(matches!(
        store
            .remove_session_family("source", 1, RemovalAuthority::Unmanaged)
            .await
            .unwrap(),
        RemoveFamilyResult::Accepted(_)
    ));
    store.finish_session_retirement("source").await.unwrap();
    store.close().await.unwrap();
    let store = RootStore::open(owner(directory.path())).await.unwrap();
    let handle = store.history_checkpoints("source", scope()).await.unwrap();
    assert_eq!(handle.publish(input.clone()).await.unwrap(), value);
    assert_eq!(
        handle.checkout_exact(head.revision).await.unwrap().head,
        head
    );
    let mut next = input;
    next.operation = Uuid::from_u128(10);
    assert!(matches!(
        handle.publish(next).await,
        Err(StoreError::SessionNotFound)
    ));
    store.close().await.unwrap();
}

#[tokio::test]
async fn concurrent_identical_requests_share_one_capture_and_receipt() {
    let directory = tempfile::tempdir().unwrap();
    let (store, handle, input) = fixture(directory.path()).await;
    let (first, second) =
        tokio::join!(handle.publish(input.clone()), handle.publish(input.clone()));
    let first = first.unwrap();
    let second = second.unwrap();
    assert!(
        matches!(first.state, PublicationState::Published { .. })
            || matches!(second.state, PublicationState::Published { .. })
    );
    let value = handle.receipt(input.clone()).await.unwrap().unwrap();
    let head = published(&value);
    for result in [first, second] {
        if matches!(result.state, PublicationState::Published { .. }) {
            assert_eq!(published(&result), head);
        }
    }
    assert_eq!(handle.publish(input).await.unwrap(), value);
    store.close().await.unwrap();
}

#[tokio::test]
async fn incomplete_staging_is_interrupted_and_cleaned_without_another_capture() {
    use std::io::Write;
    let directory = tempfile::tempdir().unwrap();
    let (store, handle, input) = fixture(directory.path()).await;
    let request = handle.request(input.clone()).unwrap();
    let log = handle.session.scoped().await.unwrap();
    journal::claim(&log, request.clone()).await.unwrap();
    let objects = Objects::open(store.owned_root().unwrap()).unwrap();
    let mut partial = objects.create(&request, "bundle").unwrap();
    partial.write_all(b"MAKA-SESSION\0\x02incomplete").unwrap();
    partial.sync_all().unwrap();
    drop(partial);
    drop(log);
    drop(objects);
    store.close().await.unwrap();
    let store = RootStore::open(owner(directory.path())).await.unwrap();
    let handle = store.history_checkpoints("source", scope()).await.unwrap();
    let receipt = handle.receipt(input.clone()).await.unwrap().unwrap();
    assert_eq!(receipt.state, PublicationState::Interrupted);
    assert!(!receipt.cleanup_pending);
    assert_eq!(handle.publish(input).await.unwrap(), receipt);
    assert!(handle.read_head().await.unwrap().is_none());
    store.close().await.unwrap();
}

#[tokio::test]
async fn cleanup_receipt_failure_still_returns_acknowledged_publication() {
    let directory = tempfile::tempdir().unwrap();
    let (store, handle, input) = fixture(directory.path()).await;
    let log = handle.session.scoped().await.unwrap();
    log.connection.run(|db| Box::pin(async move {
        sqlx::raw_sql("CREATE TRIGGER reject_checkpoint_cleanup BEFORE UPDATE ON history_checkpoint_publications
            WHEN json_extract(NEW.publication_json,'$.cleanup_pending')=0
            BEGIN SELECT RAISE(ABORT,'injected cleanup receipt failure'); END;")
            .execute(db).await?;
        Ok(())
    })).await.unwrap();
    let value = handle.publish(input.clone()).await.unwrap();
    let head = published(&value);
    assert!(value.cleanup_pending);
    assert!(
        value
            .cleanup_error
            .as_deref()
            .unwrap()
            .contains("not confirmed")
    );
    assert_eq!(handle.read_head().await.unwrap(), Some(head.clone()));
    log.connection
        .run(|db| {
            Box::pin(async move {
                sqlx::query("DROP TRIGGER reject_checkpoint_cleanup")
                    .execute(db)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    drop(log);
    let retry = handle.publish(input).await.unwrap();
    assert_eq!(published(&retry), head);
    assert!(!retry.cleanup_pending);
    assert!(retry.cleanup_error.is_none());
    store.close().await.unwrap();
}

#[tokio::test]
async fn rejected_prepare_does_not_leave_a_capture_running_until_restart() {
    let directory = tempfile::tempdir().unwrap();
    let (store, handle, input) = fixture(directory.path()).await;
    let log = handle.session.scoped().await.unwrap();
    log.connection.run(|db| Box::pin(async move {
        sqlx::raw_sql("CREATE TRIGGER reject_checkpoint_prepare BEFORE UPDATE ON history_checkpoint_publications
            WHEN json_extract(NEW.publication_json,'$.state.kind')='prepared'
            BEGIN SELECT RAISE(ABORT,'injected prepare failure'); END;")
            .execute(db).await?;
        Ok(())
    })).await.unwrap();
    let error = handle.publish(input.clone()).await.unwrap_err();
    assert!(error.to_string().contains("injected prepare failure"));
    assert!(handle.read_head().await.unwrap().is_none());
    let receipt = handle.receipt(input.clone()).await.unwrap().unwrap();
    assert_eq!(receipt.state, PublicationState::Interrupted);
    assert!(!receipt.cleanup_pending);
    log.connection
        .run(|db| {
            Box::pin(async move {
                sqlx::query("DROP TRIGGER reject_checkpoint_prepare")
                    .execute(db)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    drop(log);
    store
        .update_session_metadata::<serde_json::Value, _>("source", 1, |config| {
            config["title"] = json!("newer history must not be recaptured");
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(handle.publish(input).await.unwrap(), receipt);
    assert_eq!(
        std::fs::read_dir(directory.path().join("root/history-checkpoints/staging"))
            .unwrap()
            .count(),
        0
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn nonregular_checkpoint_object_is_rejected_without_blocking_close() {
    use std::os::unix::fs::OpenOptionsExt;
    let directory = tempfile::tempdir().unwrap();
    let (store, handle, input) = fixture(directory.path()).await;
    let head = published(&handle.publish(input).await.unwrap());
    let checkout = handle.checkout_exact(head.revision).await.unwrap();
    let path = directory
        .path()
        .join("root/history-checkpoints/objects")
        .join(&checkout.manifest.bundle().digest);
    drop(checkout);
    std::fs::remove_file(&path).unwrap();
    let fifo = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
    // SAFETY: fifo is a live, NUL-terminated pathname in this test's private Root.
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    let mut task = tokio::spawn(async move { handle.checkout_exact(head.revision).await });
    let observed = tokio::time::timeout(Duration::from_secs(30), &mut task).await;
    let blocked = observed.is_err();
    let result = match observed {
        Ok(result) => result.unwrap(),
        Err(_) => {
            // Release a buggy blocking reader so a failing regression leaves no worker behind.
            let writer = std::fs::OpenOptions::new()
                .write(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(&path)
                .unwrap();
            drop(writer);
            task.await.unwrap()
        }
    };
    assert!(result.unwrap_err().to_string().contains("regular"));
    store.close().await.unwrap();
    assert!(
        !blocked,
        "nonregular checkpoint object blocked its physical worker"
    );
}

#[test]
fn crash_child() {
    let Some(path) = std::env::var_os("MAKA_CHECKPOINT_TEST_ROOT") else {
        return;
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let (store, handle, request) = fixture(Path::new(&path)).await;
        handle.publish(request).await.unwrap();
        store.close().await.unwrap();
    });
}

#[tokio::test]
async fn killed_writer_recovers_without_a_new_capture() {
    for phase in [
        "claimed",
        "payload",
        "prepared",
        "head_written",
        "published",
        "cleanup",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let ready = directory.path().join("ready");
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "root_store::checkpoints::tests::crash_child",
                "--nocapture",
            ])
            .env("MAKA_CHECKPOINT_TEST_ROOT", directory.path())
            .env("MAKA_CHECKPOINT_TEST_PHASE", phase)
            .env("MAKA_CHECKPOINT_TEST_READY", &ready)
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        while !ready.exists() {
            assert!(
                child.try_wait().unwrap().is_none(),
                "child exited before {phase}"
            );
            if Instant::now() > deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("child did not reach {phase}");
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        // A second physical owner is rejected while the original worker is alive.
        assert!(
            root::RootOwner::open(
                &directory.path().join("root"),
                &namespaces(directory.path())
            )
            .is_err()
        );
        child.kill().unwrap();
        child.wait().unwrap();
        let store = RootStore::open(owner(directory.path())).await.unwrap();
        let handle = store.history_checkpoints("source", scope()).await.unwrap();
        let input = PublicationRequest {
            operation: Uuid::from_u128(3),
            fingerprint: "a".repeat(64),
            expected_revision: None,
            confirmed_subtree_digest: store.preview_bundle("source").await.unwrap().subtree_digest,
        };
        let receipt = handle.receipt(input.clone()).await.unwrap().unwrap();
        if matches!(phase, "claimed" | "payload") {
            assert_eq!(receipt.state, PublicationState::Interrupted);
            assert!(handle.read_head().await.unwrap().is_none());
        } else {
            assert_eq!(handle.read_head().await.unwrap(), Some(published(&receipt)));
        }
        assert!(!receipt.cleanup_pending);
        assert_eq!(handle.publish(input).await.unwrap(), receipt);
        assert_eq!(
            std::fs::read_dir(directory.path().join("root/history-checkpoints/staging"))
                .unwrap()
                .count(),
            0
        );
        store.close().await.unwrap();
    }
}
