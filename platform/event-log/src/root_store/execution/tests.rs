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
use futures_util::poll;
use serde_json::{Value, json};
use std::time::Duration;

fn captured_artifact<T>(value: crate::context::semantic::ArtifactLookupResult<T>) -> T {
    match value {
        crate::context::semantic::ArtifactLookupResult::Captured(value) => value,
        _ => panic!("expected captured artifact"),
    }
}
async fn open(path: &std::path::Path) -> RootStore {
    let owner = root::RootOwner::create(&path.join("root"), &namespaces(path)).unwrap();
    RootStore::open(Arc::new(owner)).await.unwrap()
}
fn namespaces(path: &std::path::Path) -> root::RootNamespaces {
    root::RootNamespaces {
        ownership: path.join("ownership"),
        control: path.join("control"),
    }
}

fn invocation() -> Invocation {
    Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    }
}

#[tokio::test]
async fn captured_source_keeps_original_custody_after_parent_release_until_real_close() {
    use crate::context::semantic::SemanticSelection;
    use maka_agent_facts::model::prompt_source::source::ChargedBuffer;

    let directory = tempfile::tempdir().unwrap();
    let root = open(directory.path()).await;
    let session = root
        .create_session("session", "session", &json!({}), 1)
        .await
        .unwrap();
    assert!(
        session
            .capture_source(SemanticSelection {
                session: "session".into(),
                lineage: None,
                after: 0,
                through: 0,
                before: u64::MAX,
                captured_through: 0,
                replay: None,
                prior_unknown: false,
            })
            .await
            .is_err()
    );
    let scope = session.execution_scope(None).await.unwrap();
    let stale_parent = scope.store();
    let parent = scope.accept();
    let source = stale_parent
        .capture_source(SemanticSelection {
            session: "session".into(),
            lineage: None,
            after: 0,
            through: 0,
            before: u64::MAX,
            captured_through: 0,
            replay: None,
            prior_unknown: false,
        })
        .await
        .unwrap();
    parent.finish();
    assert!(matches!(
        stale_parent.get::<Value>().await,
        Err(StoreError::ConnectionClosed)
    ));
    let mut shutdown = Box::pin(root.shutdown());
    assert!(poll!(&mut shutdown).is_pending());
    let page = source
        .metadata_page(None, ChargedBuffer::new(vec![0; 1024], ()))
        .await
        .unwrap();
    assert!(page.is_empty());
    drop(page);
    drop(source);
    shutdown.await.unwrap();
    root.close().await.unwrap();
}

#[tokio::test]
async fn captured_metadata_pages_exclude_covered_rows_and_preserve_replay_filters() {
    use crate::context::semantic::{SemanticReplay, SemanticSelection};
    use maka_agent_facts::{
        history::semantic::{
            Payload,
            directory::{ByteRange, PartDirectory, PayloadDirectory, TextSpan},
        },
        model::{
            ModelPart, TextKind,
            prompt_source::source::{ChargedBuffer, DecodedTextMeasure},
        },
    };
    use sha2::{Digest, Sha256};

    let directory = tempfile::tempdir().unwrap();
    let root = open(directory.path()).await;
    let session = root
        .create_session("session", "session", &json!({}), 1)
        .await
        .unwrap();
    let body = serde_json::to_vec(&Payload::Part(ModelPart::Text {
        text_kind: TextKind::Text,
        text: "x".into(),
        provider_options: None,
    }))
    .unwrap();
    let token = br#""x""#;
    let start = body
        .windows(token.len())
        .position(|bytes| bytes == token)
        .unwrap();
    let payload_directory = serde_json::to_string(&PayloadDirectory::Part(PartDirectory::Text {
        text_kind: TextKind::Text,
        text: TextSpan {
            range: ByteRange {
                start: start as u64,
                len: token.len() as u64,
            },
            measure: DecodedTextMeasure {
                bytes: 1,
                sha256: Sha256::digest(b"x").into(),
            },
        },
        provider_options: None,
    }))
    .unwrap();
    session.owner().unwrap().connection.run(|db| Box::pin(async move {
        for (sequence, order, invocation, kind) in [
            (1_i64, 1_i64, "current", "assistant_part"),
            (2, 1, "earlier", "assistant_part"),
            (3, 3, "current", "assistant_part"),
            (4, 4, "other", "assistant_part"),
            (5, 5, "current", "unknown_tool"),
        ] {
            let payload = if kind == "unknown_tool" {
                json!({"UnknownTool": {"operation_id":"operation","call_id":"call","name":"tool","custom":false}})
            } else {
                json!({"AssistantPart": {"step_id":"step","model_id":"model","route_identity":"route","accepted_at":sequence,"index":0,"payload": {"Complete": {
                    "sourceSequence": sequence, "itemIndex": 0
                }}}})
            };
            if kind == "assistant_part" {
                sqlx::query("INSERT INTO context_semantic_fragment_pieces(source_sequence,source_index,piece_index,bytes) VALUES(?,0,0,?)")
                    .bind(sequence).bind(&body).execute(&mut *db).await?;
                sqlx::query("INSERT INTO context_semantic_fragments(source_sequence,source_index,storage_kind,byte_offset,byte_len,directory_json,payload_bytes) VALUES(?,0,'pieces',NULL,NULL,?,?)")
                    .bind(sequence).bind(&payload_directory).bind(body.len() as i64).execute(&mut *db).await?;
            }
            let metadata = json!({"id":{"sourceSequence":sequence,"itemIndex":0},"revision": sequence,"order":{"sourceSequence":order,"itemIndex":0},"invocation":{"session_id":"session","turn_id":"turn","run_id":"run","invocation_id":invocation},"kind": payload}).to_string();
            let directory = crate::context::semantic::directory_fixture_json(&metadata)?;
            sqlx::query("INSERT INTO context_semantic_rows VALUES('session',?,0,?,?,0,?,?,'metadata-window',?,0,0,1,0,?,?)")
                .bind(sequence).bind(sequence).bind(order).bind(invocation).bind(invocation)
                .bind(kind).bind(metadata).bind(directory).execute(&mut *db).await?;
        }
        Ok(())
    })).await.unwrap();
    let scope = session.execution_scope(None).await.unwrap();
    let running = scope.store();
    let parent = scope.accept();
    for (prior_unknown, expected) in [(false, vec![2, 3]), (true, vec![2, 3, 5])] {
        let source = running
            .capture_source(SemanticSelection {
                session: "session".into(),
                lineage: None,
                after: 1,
                through: 5,
                before: 6,
                captured_through: 5,
                replay: Some(SemanticReplay {
                    base: 2,
                    current: "current".into(),
                    route: "route".into(),
                    model: "model".into(),
                }),
                prior_unknown,
            })
            .await
            .unwrap();
        let mut cursor = None;
        let mut selected = Vec::new();
        loop {
            let mut page = source
                .directory_page(cursor, ChargedBuffer::new(vec![0; 1024], ()))
                .await
                .unwrap();
            while let Some(record) = page.next_row().unwrap() {
                selected.push(record.row.id.source_sequence);
            }
            cursor = page.next;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(selected, expected, "prior_unknown={prior_unknown}");
    }
    parent.finish();
    root.close().await.unwrap();
}

#[tokio::test]
async fn artifact_capture_copies_deletable_bytes_and_metadata_from_one_snapshot() {
    use crate::context::semantic::SemanticSelection;
    use maka_agent_facts::artifact::{Artifact, ArtifactKind, ArtifactSource, content_digest};

    let directory = tempfile::tempdir().unwrap();
    let root = open(directory.path()).await;
    let session = root
        .create_session("session", "session", &json!({}), 1)
        .await
        .unwrap();
    let original = b"original bytes";
    let artifact = Artifact {
        id: "upload".into(),
        session_id: "session".into(),
        turn_id: "upload".into(),
        created_at: 1,
        name: "original.bin".into(),
        kind: ArtifactKind::File,
        size_bytes: original.len() as u64,
        mime_type: Some("application/octet-stream".into()),
        source: ArtifactSource::UserUpload,
        summary: Some(content_digest(original)),
    };
    session
        .commit_artifact(artifact.clone(), original.to_vec())
        .await
        .unwrap();
    let scope = session.execution_scope(None).await.unwrap();
    let running = scope.store();
    let parent = scope.accept();
    let source = running
        .capture_source(SemanticSelection {
            session: "session".into(),
            lineage: None,
            after: 0,
            through: 0,
            before: u64::MAX,
            captured_through: 0,
            replay: None,
            prior_unknown: false,
        })
        .await
        .unwrap();
    let lookup = source
        .artifact_lookup_fixture(br#"["session","upload"]"#.to_vec(), 1..10, 11..19)
        .await;
    let (started, observed) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let read = tokio::spawn(async move {
        captured_artifact(
            source
                .with_artifact_capture(lookup, move |captured, metadata, body| {
                    assert!(captured.protected_metadata.is_none());
                    let metadata: Artifact = serde_json::from_reader(metadata)?;
                    started.send(()).unwrap();
                    wait.recv().unwrap();
                    let mut bytes = Vec::new();
                    std::io::Read::read_to_end(body, &mut bytes)?;
                    Ok((metadata, bytes, captured.digest))
                })
                .await
                .unwrap(),
        )
    });
    observed.await.unwrap();
    assert_eq!(
        running
            .delete_user_artifact("session", "upload")
            .await
            .unwrap(),
        crate::artifacts::ArtifactDeletion::Deleted
    );
    let replacement_bytes = b"replacement!!!";
    let mut replacement = artifact.clone();
    replacement.name = "replacement.bin".into();
    replacement.size_bytes = replacement_bytes.len() as u64;
    replacement.summary = Some(content_digest(replacement_bytes));
    running
        .commit_artifact(replacement, replacement_bytes.to_vec())
        .await
        .unwrap();
    release.send(()).unwrap();
    let (metadata, copied, digest) = read.await.unwrap();
    assert_eq!(metadata, artifact);
    assert_eq!(copied, original);
    assert_eq!(
        format!("sha256:{}", hex::encode(digest)),
        content_digest(original)
    );
    parent.finish();
    root.close().await.unwrap();
}

#[tokio::test]
async fn captured_artifact_sources_cannot_cross_session_or_snapshot_authority() {
    use crate::context::semantic::SemanticSelection;
    use maka_agent_facts::artifact::{Artifact, ArtifactKind, ArtifactSource};
    let directory = tempfile::tempdir().unwrap();
    let root = open(directory.path()).await;
    let session = root
        .create_session("session", "session", &json!({}), 1)
        .await
        .unwrap();
    session
        .commit_artifact(
            Artifact {
                id: "protected".into(),
                session_id: "session".into(),
                turn_id: "turn".into(),
                created_at: 1,
                name: "proof.bin".into(),
                kind: ArtifactKind::File,
                size_bytes: 3,
                mime_type: Some("application/octet-stream".into()),
                source: ArtifactSource::ToolResultProjection,
                summary: None,
            },
            b"abc".to_vec(),
        )
        .await
        .unwrap();
    let scope = session.execution_scope(None).await.unwrap();
    let running = scope.store();
    let parent = scope.accept();
    let selection = SemanticSelection {
        session: "session".into(),
        lineage: None,
        after: 0,
        through: 0,
        before: u64::MAX,
        captured_through: 0,
        replay: None,
        prior_unknown: false,
    };
    let mut foreign = selection.clone();
    foreign.session = "foreign".into();
    assert!(running.capture_source(foreign).await.is_err());
    let first = running.capture_source(selection.clone()).await.unwrap();
    let second = running.capture_source(selection).await.unwrap();
    let lookup = first
        .artifact_lookup_fixture(br#"["session","protected"]"#.to_vec(), 1..10, 11..22)
        .await;
    let artifact = captured_artifact(
        first
            .with_artifact_capture(lookup, |capture, _, _| {
                Ok(capture.protected_metadata.unwrap())
            })
            .await
            .unwrap(),
    );
    assert!(second.byte_source(&artifact).is_err());
    assert!(first.byte_range(&artifact, 0, u64::MAX).is_err());
    let original = first.byte_source(&artifact).unwrap();
    let metadata: Artifact = first
        .with_sequential_source(&artifact, |reader| Ok(serde_json::from_reader(reader)?))
        .await
        .unwrap();
    assert_eq!(metadata.id, "protected");
    assert_eq!(metadata.session_id, "session");
    assert_eq!(metadata.size_bytes, 3);
    drop(original);
    drop(artifact);
    drop(first);
    drop(second);
    parent.finish();
    root.close().await.unwrap();
}

#[tokio::test]
async fn invocation_effect_retains_run_cancellation_and_settlement_after_observer_finishes() {
    use maka_capabilities::call::{Identity, Issuer};

    let directory = tempfile::tempdir().unwrap();
    let root = open(directory.path()).await;
    let session = root
        .create_session("session", "session", &json!({}), 1)
        .await
        .unwrap();
    let prepared = session.execution_scope(None).await.unwrap();
    let selected = prepared.store();
    let stop = CancellationToken::new();
    let (parent, effects) = prepared
        .accept_invocation(invocation(), stop.clone())
        .unwrap();
    let custody = selected.execution_custody().unwrap();
    let effect = root
        .fork_invocation_effect(custody.as_ref(), &invocation())
        .unwrap();
    let issuer = Issuer::default();
    let original = issuer
        .issue_with_execution(
            Identity::Agent {
                invocation: invocation(),
                operation_id: Some("observer".into()),
            },
            42u64,
            CancellationToken::new(),
            custody.clone(),
        )
        .unwrap();
    let (effect, accepted) = effect.into_scope(&original).unwrap();
    assert_eq!(issuer.evidence::<u64>(&accepted), Some(&42));
    assert!(issuer.owns(&accepted));
    original.finish().await.unwrap();
    assert!(original.cancellation.is_cancelled());
    assert!(!accepted.cancellation.is_cancelled());
    let sibling = root
        .fork_invocation_effect(custody.as_ref(), &invocation())
        .unwrap();
    let (sibling, sibling_scope) = sibling.into_scope(&original).unwrap();
    let local_stop = effect.cancellation();
    local_stop.cancel();
    assert!(accepted.cancellation.is_cancelled());
    assert!(effect.cancellation().is_cancelled());
    assert!(!sibling_scope.cancellation.is_cancelled());
    assert!(!stop.is_cancelled());
    let mut foreign = invocation();
    foreign.invocation_id = "another-invocation".into();
    assert!(
        root.fork_invocation_effect(custody.as_ref(), &foreign)
            .is_err()
    );
    let mut drain = Box::pin(effects.settle());
    assert!(poll!(&mut drain).is_pending());
    assert!(
        root.fork_invocation_effect(custody.as_ref(), &invocation())
            .is_err()
    );
    // Sealing native journal admission leaves existing session-owned background
    // resource admission unchanged.
    let background = root
        .fork_execution(custody.as_ref(), &invocation())
        .unwrap();
    stop.cancel();
    assert!(accepted.cancellation.is_cancelled());
    assert!(sibling_scope.cancellation.is_cancelled());
    assert!(poll!(&mut drain).is_pending());
    effect.finish(Ok(()));
    sibling.finish(Ok(()));
    drain.await.unwrap();
    assert!(effects.is_idle());
    background.finish();
    parent.finish();
    root.close().await.unwrap();
}

#[tokio::test]
async fn stopped_run_before_effect_scope_has_no_dispatch_or_unconfirmed_owner() {
    use maka_capabilities::call::{Identity, Issuer};

    let directory = tempfile::tempdir().unwrap();
    let root = open(directory.path()).await;
    let session = root
        .create_session("session", "session", &json!({}), 1)
        .await
        .unwrap();
    let prepared = session.execution_scope(None).await.unwrap();
    let selected = prepared.store();
    let stop = CancellationToken::new();
    let (parent, effects) = prepared
        .accept_invocation(invocation(), stop.clone())
        .unwrap();
    let custody = selected.execution_custody().unwrap();
    let original = Issuer::default()
        .issue_with_execution(
            Identity::Agent {
                invocation: invocation(),
                operation_id: Some("observer".into()),
            },
            (),
            CancellationToken::new(),
            custody.clone(),
        )
        .unwrap();
    let effect = root
        .fork_invocation_effect(custody.as_ref(), &invocation())
        .unwrap();
    stop.cancel();
    assert!(matches!(
        effect.into_scope(&original),
        Err(ToolError::Failed(_))
    ));
    effects.settle().await.unwrap();
    assert!(effects.is_idle());
    assert!(session.get::<Value>().await.unwrap().is_some());
    let journal = selected
        .scoped_prefix(
            maka_agent_facts::event::LogScope::Session {
                id: "session".into(),
            },
            10,
            4096,
        )
        .await
        .unwrap();
    assert!(journal.events.is_empty());
    parent.finish();
    root.close().await.unwrap();
}

#[tokio::test]
async fn lost_invocation_effect_is_observable_after_every_other_original_owner_settles() {
    let directory = tempfile::tempdir().unwrap();
    let root = open(directory.path()).await;
    let session = root
        .create_session("session", "session", &json!({}), 1)
        .await
        .unwrap();
    let prepared = session.execution_scope(None).await.unwrap();
    let selected = prepared.store();
    let stop = CancellationToken::new();
    let (parent, effects) = prepared
        .accept_invocation(invocation(), stop.clone())
        .unwrap();
    let custody = selected.execution_custody().unwrap();
    let lost = root
        .fork_invocation_effect(custody.as_ref(), &invocation())
        .unwrap();
    let live = root
        .fork_invocation_effect(custody.as_ref(), &invocation())
        .unwrap();
    drop(lost);
    assert!(stop.is_cancelled());
    assert!(matches!(
        session.get::<Value>().await,
        Err(StoreError::ConnectionClosed)
    ));
    let mut drain = Box::pin(effects.settle());
    assert!(poll!(&mut drain).is_pending());
    live.finish(Ok(()));
    let error = drain.await.unwrap_err();
    assert!(
        matches!(error, ToolError::CleanupUnconfirmed(message) if message.contains("owner disappeared"))
    );
    assert!(!effects.is_idle());
    parent.retain_unconfirmed();
    assert!(root.shutdown().await.is_err());
    // Uncertain original authority remains quarantined, as with every other
    // accepted execution whose owner disappears.
    let _ = directory.keep();
}

#[tokio::test]
async fn prepared_scope_can_cancel_and_shutdown_drains_accepted_work_before_sql() {
    let directory = tempfile::tempdir().unwrap();
    let root = open(directory.path()).await;
    let session = root
        .create_session("session", "session", &json!({}), 1)
        .await
        .unwrap();
    let prepared = session.execution_scope(None).await.unwrap();
    let stale = prepared.store();
    drop(prepared);
    assert!(matches!(
        stale.get::<Value>().await,
        Err(StoreError::ConnectionClosed)
    ));
    let scope = session.execution_scope(None).await.unwrap();
    let running = scope.store();
    let lease = scope.accept();
    let mut closing = Box::pin(root.shutdown());
    assert!(poll!(&mut closing).is_pending());
    assert!(matches!(
        session.get::<Value>().await,
        Err(StoreError::ConnectionClosed)
    ));
    let admitted = running.scoped().await.unwrap();
    admitted
        .connection
        .run(|connection| {
            Box::pin(async move {
                sqlx::query("UPDATE session_control SET updated_at=42 WHERE id='session'")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    drop(admitted);
    assert_eq!(
        running.get::<Value>().await.unwrap().unwrap().updated_at,
        42
    );
    lease.finish();
    tokio::time::timeout(Duration::from_secs(10), closing)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        running.get::<Value>().await,
        Err(StoreError::ConnectionClosed)
    ));
    drop(root);
    let owner = root::RootOwner::open(
        &directory.path().join("root"),
        &namespaces(directory.path()),
    )
    .unwrap();
    RootStore::open(Arc::new(owner))
        .await
        .unwrap()
        .close()
        .await
        .unwrap();
}

#[tokio::test]
async fn execution_reuses_binding_pin_behind_queued_writer_and_cannot_rebind() {
    let directory = tempfile::tempdir().unwrap();
    let root = open(directory.path()).await;
    let reference = root
        .attach_workspace("owner", &json!({"path":"/tmp/original"}))
        .await
        .unwrap();
    let session = root
        .create_session(
            "session",
            "session",
            &json!({"workspace":reference,"boundary_revision":0}),
            1,
        )
        .await
        .unwrap();
    let basis = PermissionBasis {
        boundary_revision: 0,
        binding: maka_agent_facts::workspace::BindingStamp {
            id: reference.id,
            permission_epoch: 0,
        },
    };
    assert!(matches!(
        session.execution_scope(None).await,
        Err(StoreError::PermissionRevoked)
    ));
    let scope = session.execution_scope(Some(basis)).await.unwrap();
    let running = scope.store();
    let lease = scope.accept();
    let mut writer = Box::pin(root.gates.write([gates::Key::Binding(reference.id)]));
    assert!(poll!(&mut writer).is_pending());
    let record = tokio::time::timeout(Duration::from_secs(2), running.get::<Value>())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let rejected = tokio::time::timeout(
        Duration::from_secs(2),
        running.update_session_metadata::<Value, _>("session", record.revision, |value| {
            value["title"] = json!("changed");
            Ok(())
        }),
    )
    .await
    .unwrap();
    assert!(matches!(rejected, Err(StoreError::InvalidTransition(_))));
    // A plain control handle also cannot switch the attachment underneath
    // this run's immutable binding lease.
    let other = root
        .attach_workspace("owner", &json!({"path":"/tmp/other"}))
        .await
        .unwrap();
    let rebind = session
        .update_session_metadata::<Value, _>("session", record.revision, move |value| {
            value["workspace"] = serde_json::to_value(other)?;
            Ok(())
        })
        .await;
    assert!(matches!(rebind, Err(StoreError::SessionBusy)));
    lease.finish();
    drop(
        tokio::time::timeout(Duration::from_secs(2), writer)
            .await
            .unwrap()
            .unwrap(),
    );
    assert!(
        session
            .get::<Value>()
            .await
            .unwrap()
            .unwrap()
            .configuration
            .get("title")
            .is_none()
    );
    root.close().await.unwrap();
}

#[tokio::test]
async fn retirement_waits_for_physical_scope_and_blocks_fresh_admission() {
    let directory = tempfile::tempdir().unwrap();
    let root = open(directory.path()).await;
    let session = root
        .create_session("session", "session", &json!({}), 1)
        .await
        .unwrap();
    let scope = session.execution_scope(None).await.unwrap();
    let lease = scope.accept();
    let revision = session.get::<Value>().await.unwrap().unwrap().revision;
    root.begin_session_removal("session", revision)
        .await
        .unwrap();
    assert!(!root.session_retirement_ready("session").await.unwrap());
    assert!(matches!(
        session.execution_scope(None).await,
        Err(StoreError::SessionRetired)
    ));
    lease.finish();
    assert!(root.session_retirement_ready("session").await.unwrap());
    root.close().await.unwrap();
}

#[tokio::test]
async fn quarantined_child_keeps_sql_for_accepted_parent_without_reopening_admission() {
    let directory = tempfile::tempdir().unwrap();
    let root = open(directory.path()).await;
    let session = root
        .create_session("session", "session", &json!({}), 1)
        .await
        .unwrap();
    let parent = session.execution_scope(None).await.unwrap().accept();
    let running = parent.store();
    let child = running.fork_execution().unwrap();
    let abandoned = child.store();
    child.retain_unconfirmed();

    // Quarantine itself fences prebound ordinary handles, before shutdown sets
    // the Root's explicit closed flag. Only the original accepted pins remain.
    assert!(matches!(
        root.session("session").await,
        Err(StoreError::ConnectionClosed)
    ));
    assert!(matches!(
        session.subscribe_commits(),
        Err(StoreError::ConnectionClosed)
    ));
    assert!(matches!(
        session.get::<Value>().await,
        Err(StoreError::ConnectionClosed)
    ));
    assert!(matches!(
        abandoned.get::<Value>().await,
        Err(StoreError::ConnectionClosed)
    ));
    assert!(
        tokio::time::timeout(Duration::from_secs(10), root.shutdown())
            .await
            .unwrap()
            .is_err()
    );

    let admitted = running.scoped().await.unwrap();
    admitted
        .connection
        .run(|connection| {
            Box::pin(async move {
                sqlx::query("UPDATE session_control SET updated_at=42 WHERE id='session'")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    drop(admitted);
    assert_eq!(
        running.get::<Value>().await.unwrap().unwrap().updated_at,
        42
    );
    parent.finish();
    assert!(matches!(
        running.get::<Value>().await,
        Err(StoreError::ConnectionClosed)
    ));
    drop(root);
    assert!(
        root::RootOwner::open(
            &directory.path().join("root"),
            &namespaces(directory.path()),
        )
        .is_err()
    );
    // The original uncertain owner still owns live SQL and its filesystem.
    let _ = directory.keep();
}

#[tokio::test]
async fn artifact_lookup_streams_long_local_alias_and_target_ids_and_rejects_collisions() {
    use crate::artifacts::identity::{artifact_lookup_digest, history_lookup_digest};
    use crate::context::semantic::SemanticSelection;
    use maka_agent_facts::artifact::{Artifact, ArtifactKind, ArtifactSource, content_digest};
    let directory = tempfile::tempdir().unwrap();
    let root = open(directory.path()).await;
    let owner = "owner_".to_owned() + &"a".repeat(4096);
    let target = "target_".to_owned() + &"b".repeat(70000);
    let remote = "remote_".to_owned() + &"c".repeat(5000);
    let original = "original_".to_owned() + &"d".repeat(80000);
    let session = root
        .create_session(&owner, "long identities", &json!({}), 1)
        .await
        .unwrap();
    for (id, body) in [
        ("wrong", b"wrong".as_slice()),
        (target.as_str(), b"right".as_slice()),
    ] {
        session
            .commit_artifact(
                Artifact {
                    id: id.into(),
                    session_id: owner.clone(),
                    turn_id: "upload".into(),
                    created_at: 1,
                    name: "file.bin".into(),
                    kind: ArtifactKind::File,
                    size_bytes: body.len() as u64,
                    mime_type: None,
                    source: ArtifactSource::UserUpload,
                    summary: Some(content_digest(body)),
                },
                body.to_vec(),
            )
            .await
            .unwrap();
    }
    let raw = session.owner().unwrap();
    let digest = artifact_lookup_digest(&owner, &target);
    raw.connection
        .run(move |db| {
            Box::pin(async move {
                sqlx::query("UPDATE artifacts SET lookup_digest=? WHERE id='wrong'")
                    .bind(digest.as_slice())
                    .execute(db)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    let scope = session.execution_scope(None).await.unwrap();
    let running = scope.store();
    let parent = scope.accept();
    let source = running
        .capture_source(SemanticSelection {
            session: owner.clone(),
            lineage: None,
            after: 0,
            through: 0,
            before: u64::MAX,
            captured_through: 0,
            replay: None,
            prior_unknown: false,
        })
        .await
        .unwrap();
    async fn lookup(
        source: &crate::context::semantic::CapturedSource,
        session: &str,
        id: &str,
    ) -> crate::context::semantic::ArtifactLookup<
        maka_agent_facts::model::prompt_source::source::ChargedBuffer,
    > {
        // Alternate escape spelling crosses multiple stored Pieces; work remains 64 bytes.
        let session = format!("\"\\u{:04x}{}\"", session.as_bytes()[0], &session[1..]);
        let id = serde_json::to_string(id).unwrap();
        let first = 1..1 + session.len() as u64;
        let second = first.end + 1..first.end + 1 + id.len() as u64;
        let json = format!("[{session},{id}]").into_bytes();
        source.artifact_lookup_fixture(json, first, second).await
    }
    let local = lookup(&source, &owner, &target).await;
    let body = captured_artifact(
        source
            .with_artifact_capture(local, |_, _, body| {
                let mut bytes = Vec::new();
                body.read_to_end(&mut bytes)?;
                Ok(bytes)
            })
            .await
            .unwrap(),
    );
    assert_eq!(body, b"right");
    let alias_hash = history_lookup_digest(&owner, &remote, &original);
    let target_hash = artifact_lookup_digest(&owner, &target);
    let (o, r) = (owner.clone(), remote.clone());
    raw.connection.run(move |db|Box::pin(async move {
        sqlx::query("INSERT INTO session_history_copies(session_id,source_session_id,source_revision,through_sequence,observed_through,request_json,lineage_json,state) VALUES(?,?,1,0,0,'{}','{}','committed')").bind(&o).bind(&r).execute(&mut *db).await?;
        // Wrong alias and wrong target are deliberately earlier fixed-key collision candidates.
        sqlx::query("INSERT INTO session_history_artifacts(session_id,source_session_id,source_artifact_id,artifact_id,lookup_digest,target_digest) VALUES(?,?,'wrong','wrong',?,?)").bind(&o).bind(&r).bind(alias_hash.as_slice()).bind(target_hash.as_slice()).execute(&mut *db).await?;
        Ok(())
    })).await.unwrap();
    let (o, r, i, t) = (
        owner.clone(),
        remote.clone(),
        original.clone(),
        target.clone(),
    );
    raw.connection.run(move |db|Box::pin(async move {
        sqlx::query("INSERT INTO session_history_artifacts(session_id,source_session_id,source_artifact_id,artifact_id,lookup_digest,target_digest) VALUES(?,?,?,?,?,?)").bind(&o).bind(&r).bind(&i).bind(&t).bind(alias_hash.as_slice()).bind(target_hash.as_slice()).execute(db).await?;Ok(())
    })).await.unwrap();
    let alias = lookup(&source, &remote, &original).await;
    let body = captured_artifact(
        source
            .with_artifact_capture(alias, |_, _, body| {
                let mut bytes = Vec::new();
                body.read_to_end(&mut bytes)?;
                Ok(bytes)
            })
            .await
            .unwrap(),
    );
    assert_eq!(body, b"right");
    // A fingerprint alone cannot authorize a different source identity.
    let absent_digest = history_lookup_digest(&owner, &remote, "absent");
    raw.connection.run(move |db|Box::pin(async move {
        sqlx::query("UPDATE session_history_artifacts SET lookup_digest=? WHERE source_artifact_id='wrong'").bind(absent_digest.as_slice()).execute(db).await?;Ok(())
    })).await.unwrap();
    let absent = lookup(&source, &remote, "absent").await;
    assert!(matches!(
        source
            .with_artifact_capture(absent, |_, _, _| Ok(()))
            .await
            .unwrap(),
        crate::context::semantic::ArtifactLookupResult::Missing
    ));
    drop(source);
    drop(running);
    parent.finish();
    drop(raw);
    root.close().await.unwrap();
}
