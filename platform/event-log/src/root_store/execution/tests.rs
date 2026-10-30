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
async fn captured_source_reads_admitted_canonical_bytes_at_its_frozen_cut() {
    use crate::context::semantic::{SemanticSelection, SourcePosition};
    use maka_agent_facts::{
        event::{EventWrite, Fact, InvocationInput, RuntimeEvent},
        model::{
            ModelPart, TextKind,
            prompt_source::source::ChargedBuffer,
            recorded::{ModelObservation, ModelPartRecord},
        },
    };

    let directory = tempfile::tempdir().unwrap();
    let root = open(directory.path()).await;
    let session = root
        .create_session("session", "session", &json!({}), 1)
        .await
        .unwrap();
    let write = |fact| EventWrite::plain(RuntimeEvent::new(invocation(), fact)).unwrap();
    let opened = session
        .append(&write(Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content: "covered question".into(),
                source_messages: Vec::new(),
                request_fingerprint: None,
            },
        }))
        .await
        .unwrap();
    let context = session
        .read_model_view("session", Some("invocation"))
        .await
        .unwrap();
    session
        .append(&write(Fact::ModelRequested {
            source_capture: maka_agent_facts::event::SourceCapture {
                publication_watermark: context.selection.captured_through,
                prior_unknown: context.selection.prior_unknown,
            },
            item_acceptance: true,
            step_id: "step".into(),
            model_id: "model".into(),
            source_scope: context.source_evidence.scope,
            source_high_water: context.source_evidence.high_water,
            source_digest: context.source_evidence.digest,
            input_digest: "fixture".into(),
            route_identity: "route".into(),
            checkpoint_event_id: None,
            purpose: maka_agent_facts::context::ModelPurpose::Main,
            context: None,
            context_breakdown: None,
            effective_source_digest: Some(context.effective_source_digest),
        }))
        .await
        .unwrap();
    let original = ModelPart::Text {
        text_kind: TextKind::Text,
        text: "accepted 中\0suffix".into(),
        provider_options: None,
    };
    let observed = |ordinal, part| {
        write(Fact::ModelObserved {
            step_id: "step".into(),
            event: ModelObservation::Part(ModelPartRecord {
                ordinal,
                message_id: format!("part-{ordinal}"),
                started_at: std::time::UNIX_EPOCH,
                provider_part_id: None,
                part: Arc::new(part),
            }),
        })
    };
    let through = session
        .append(&observed(0, original.clone()))
        .await
        .unwrap();
    let scope = session.execution_scope(None).await.unwrap();
    let running = scope.store();
    let parent = scope.accept();
    let source = running
        .capture_source(SemanticSelection {
            session: "session".into(),
            lineage: None,
            after: opened,
            through,
            before: through + 1,
            captured_through: through,
            replay: None,
            prior_unknown: false,
        })
        .await
        .unwrap();
    session
        .append(&observed(
            1,
            ModelPart::Text {
                text_kind: TextKind::Text,
                text: "later accepted body".into(),
                provider_options: None,
            },
        ))
        .await
        .unwrap();
    let mut page = source
        .directory_page(None, ChargedBuffer::new(vec![0; 4096], ()))
        .await
        .unwrap();
    let record = page.next_row().unwrap().unwrap();
    assert_eq!(record.row.id.source_sequence, through);
    assert!(page.next_row().unwrap().is_none());
    assert!(page.next.is_none());
    let payload = source.describe_payload(&record.row).unwrap().unwrap();
    let mut chunk = source
        .read_chunk(
            &payload,
            SourcePosition::default(),
            ChargedBuffer::new(vec![0; 4096], ()),
        )
        .await
        .unwrap();
    let restored: ModelPart =
        serde_json::from_slice(&chunk.buffer.as_mut()[..chunk.bytes_read]).unwrap();
    assert_eq!(restored, original);
    drop(source);
    parent.finish();
    root.close().await.unwrap();
}
