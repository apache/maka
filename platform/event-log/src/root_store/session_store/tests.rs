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
use crate::root::{RootNamespaces, RootOwner};
use crate::root_store::{RootStore, partition_for};
use serde_json::json;
use std::sync::Arc;

async fn fixture() -> (tempfile::TempDir, RootStore, SessionStore, SessionStore) {
    let dir = tempfile::tempdir().unwrap();
    let owner = Arc::new(
        RootOwner::create(
            &dir.path().join("root"),
            &RootNamespaces {
                ownership: dir.path().join("ownership"),
                control: dir.path().join("control"),
            },
        )
        .unwrap(),
    );
    let root = RootStore::open(owner).await.unwrap();
    let first = "scope-a";
    let second = (0..100)
        .map(|i| format!("scope-b-{i}"))
        .find(|id| partition_for(b"session", id) == partition_for(b"session", first))
        .unwrap();
    let a = root
        .create_session(first, first, &json!({}), 1)
        .await
        .unwrap();
    let b = root
        .create_session(&second, &second, &json!({}), 1)
        .await
        .unwrap();
    assert!(Arc::ptr_eq(&a.owner().unwrap(), &b.owner().unwrap()));
    (dir, root, a, b)
}

fn request(session: &str) -> InteractionRecord {
    serde_json::from_value(json!({
        "sessionId":session,"turnId":"turn","runId":"run","requestId":"request","createdAt":2,
        "request":{"kind":"form","toolUseId":"tool","message":"Continue?","requester":{"name":"Tool"},"fields":[]},
        "outcome":null
    })).unwrap()
}

#[tokio::test]
async fn foreign_interaction_reads_are_absent_and_mutations_are_rejected() {
    let (_dir, root, a, b) = fixture().await;
    let raw = b.owner().unwrap();
    let request = request(b.id());
    raw.establish_interaction(&request).await.unwrap();
    let revision = b
        .get::<serde_json::Value>()
        .await
        .unwrap()
        .unwrap()
        .revision;
    let outcome = InteractionOutcome::Closure {
        reason: ClosureReason::ProducerCancelled,
        committed_at: 3,
    };
    assert!(a.interaction("request").await.unwrap().is_none());
    assert_eq!(
        serde_json::to_value(b.interaction("request").await.unwrap().unwrap()).unwrap(),
        serde_json::to_value(&request).unwrap()
    );
    assert_eq!(
        serde_json::to_value(raw.interaction("request").await.unwrap().unwrap()).unwrap(),
        serde_json::to_value(&request).unwrap()
    );
    assert!(
        a.commit_interaction_outcome("request", outcome.clone())
            .await
            .is_err()
    );
    let mut collision = request.clone();
    collision.session_id = a.id().into();
    assert!(a.establish_interaction(&collision).await.is_err());
    assert!(
        b.interaction("request")
            .await
            .unwrap()
            .unwrap()
            .outcome
            .is_none()
    );
    assert_eq!(
        b.get::<serde_json::Value>()
            .await
            .unwrap()
            .unwrap()
            .revision,
        revision
    );
    assert!(
        b.commit_interaction_outcome("request", outcome.clone())
            .await
            .unwrap()
            .matches
    );
    assert!(
        a.commit_interaction_outcome("request", outcome)
            .await
            .is_err()
    );
    // Relational identity controls visibility. A payload claiming another
    // Session cannot broaden it, and the matched owner still detects corruption.
    let mut wrong_identity = request.clone();
    wrong_identity.session_id = a.id().into();
    let encoded = serde_json::to_string(&wrong_identity).unwrap();
    raw.connection
        .run(move |db| {
            Box::pin(async move {
                sqlx::query(
                    "UPDATE interaction_requests SET record_json=? WHERE request_id='request'",
                )
                .bind(encoded)
                .execute(db)
                .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    assert!(a.interaction("request").await.unwrap().is_none());
    assert!(b.interaction("request").await.is_err());

    // A bound read must exclude a foreign row before decoding its payload.
    // Corruption is still observable by the original owner and unbound reader.
    raw.connection
        .run(|db| {
            Box::pin(async move {
                sqlx::query(
                    "UPDATE interaction_requests SET record_json='{}' WHERE request_id='request'",
                )
                .execute(db)
                .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    assert!(a.interaction("request").await.unwrap().is_none());
    assert!(b.interaction("request").await.is_err());
    assert!(raw.interaction("request").await.is_err());
    drop(raw);
    root.close().await.unwrap();
}

#[tokio::test]
async fn foreign_process_cleanup_and_continuation_receipt_stay_private() {
    let (_dir, root, a, b) = fixture().await;
    let raw = b.owner().unwrap();
    let process = Uuid::new_v4();
    raw.admit_session_process(b.id(), process).await.unwrap();
    assert!(a.clean_session_process(process).await.is_err());
    let cleaned: bool = raw
        .connection
        .read(move |db| {
            Box::pin(async move {
                Ok(
                    sqlx::query_scalar("SELECT cleaned FROM session_processes WHERE id=?")
                        .bind(process.to_string())
                        .fetch_one(db)
                        .await?,
                )
            })
        })
        .await
        .unwrap();
    assert!(!cleaned);
    b.clean_session_process(process).await.unwrap();
    let invocation = Invocation {
        session_id: b.id().into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "continuation".into(),
    };
    let source_invocation = Invocation {
        session_id: b.id().into(),
        turn_id: "original-turn".into(),
        run_id: "original-run".into(),
        invocation_id: "original-invocation".into(),
    };
    raw.append(
        &EventWrite::plain(maka_agent_facts::event::RuntimeEvent::new(
            source_invocation.clone(),
            maka_agent_facts::event::Fact::InvocationOpened {
                configuration: None,
                input: maka_agent_facts::event::InvocationInput::Message {
                    content: "original".into(),
                    source_messages: Vec::new(),
                    request_fingerprint: None,
                },
            },
        ))
        .unwrap(),
    )
    .await
    .unwrap();
    let source = RunBoundary {
        invocation: source_invocation,
        high_water: 1,
        digest: "sha256:source".into(),
    };
    let encoded = serde_json::to_string(&maka_agent_facts::event::RuntimeEvent::new(
        invocation,
        maka_agent_facts::event::Fact::InvocationOpened {
            configuration: None,
            input: maka_agent_facts::event::InvocationInput::Continuation {
                claim: Box::new(maka_agent_facts::continuation::ContinuationClaim {
                    id: "claim".into(),
                    source,
                    base: maka_agent_facts::continuation::SessionBase {
                        high_water: 0,
                        digest: "sha256:base".into(),
                    },
                    replay: maka_agent_facts::continuation::ReplayEvidence {
                        version: 1,
                        digest: "sha256:replay".into(),
                        route_identity: "sha256:route".into(),
                    },
                }),
                request_fingerprint: "fingerprint".into(),
            },
        },
    ))
    .unwrap();
    raw.connection
        .run(move |db| {
            Box::pin(async move {
                use sqlx::Connection as _;
                let mut tx = db.begin().await?;
                let mut event: maka_agent_facts::event::RuntimeEvent =
                    serde_json::from_str(&encoded)?;
                event.id = "opening".into();
                crate::append::ingress::insert(
                    &mut tx,
                    &event,
                    serde_json::to_string(&event)?,
                    crate::append::ingress::Position::Imported(None),
                )
                .await?;
                tx.commit().await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    assert!(
        a.continuation_receipt("continuation")
            .await
            .unwrap()
            .is_none()
    );
    let own = b
        .continuation_receipt("continuation")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(own.0.session_id, b.id());
    assert_eq!(own.2, "fingerprint");
    drop(raw);
    root.close().await.unwrap();
}

#[tokio::test]
async fn prepared_handles_and_wire_views_are_session_bound() {
    let (_dir, root, a, b) = fixture().await;
    let build = b
        .prepare_model_view(
            SemanticSelection {
                session: b.id().into(),
                lineage: None,
                after: 0,
                anchor_sequence: None,
                through: 0,
                before: 1,
                captured_through: 0,
                replay: None,
                prior_unknown: false,
            },
            "scope-test",
        )
        .await
        .unwrap();
    assert!(a.prepared_dirty_groups(&build, None, 1).await.is_err());
    assert!(a.finish_prepared(&build).await.is_err());
    let view = b.finish_prepared(&build).await.unwrap();
    assert!(a.prepared_semantic_page(&view, 0, 1).await.is_err());
    assert!(
        a.prepare_wire_view(&view, WireFormat::Responses, "codec")
            .await
            .is_err()
    );
    let wire_build = b
        .prepare_wire_view(&view, WireFormat::Responses, "codec")
        .await
        .unwrap();
    assert!(a.finish_prepared_wire(&wire_build).await.is_err());
    let wire = b.finish_prepared_wire(&wire_build).await.unwrap();
    assert!(
        a.prepared_wire_page(&wire, PreparedWireCursor::default(), 1)
            .await
            .is_err()
    );
    assert!(
        a.prepared_wire_metadata_page(&wire, PreparedWireCursor::default(), 1)
            .await
            .is_err()
    );
    assert!(a.prepared_wire_prefix_identity(&wire, 0).await.is_err());
    assert!(
        b.prepared_wire_page(&wire, PreparedWireCursor::default(), 1)
            .await
            .unwrap()
            .chunks
            .is_empty()
    );
    drop((build, view, wire_build, wire));
    root.close().await.unwrap();
}

#[tokio::test]
async fn copied_artifact_provenance_keeps_destination_visibility() {
    let (_dir, root, a, b) = fixture().await;
    let artifact = Artifact {
        id: "copy".into(),
        session_id: a.id().into(),
        turn_id: "turn".into(),
        created_at: 1,
        name: "copy.txt".into(),
        kind: maka_agent_facts::artifact::ArtifactKind::File,
        size_bytes: 5,
        mime_type: Some("text/plain".into()),
        source: maka_agent_facts::artifact::ArtifactSource::UserUpload,
        summary: Some(maka_agent_facts::artifact::content_digest(b"hello")),
    };
    a.commit_artifact(artifact, b"hello".to_vec())
        .await
        .unwrap();
    let raw = a.owner().unwrap();
    let target = a.id().to_owned();
    let source = b.id().to_owned();
    raw.connection
        .run(move |db| {
            Box::pin(async move {
                sqlx::query(
                    "INSERT INTO session_history_copies(session_id,source_session_id,source_revision,through_sequence,observed_through,request_json,lineage_json,state) VALUES(?,?,1,0,0,'{}','{}','committed')",
                )
                .bind(&target)
                .bind(&source)
                .execute(&mut *db)
                .await?;
                sqlx::query("INSERT INTO session_history_artifacts VALUES(?,?,'original','copy')")
                    .bind(target)
                    .bind(source)
                    .execute(db)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    let reference = a
        .resolve_history_artifact(a.id(), b.id(), "original")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        reference,
        StorageRef::SessionFile {
            session_id: a.id().into(),
            relative_path: "copy".into()
        }
    );
    assert!(
        a.resolve_history_artifact(b.id(), b.id(), "original")
            .await
            .is_err()
    );
    assert!(b.get_artifact(a.id(), "copy").await.is_err());
    let content = a
        .with_artifact(
            ArtifactReadScope::Session(a.id()),
            "copy",
            |_record, read| {
                let mut bytes = Vec::new();
                read.read_to_end(&mut bytes).unwrap();
                bytes
            },
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(content, b"hello");
    drop(raw);
    root.close().await.unwrap();
}

#[tokio::test]
async fn mixed_session_batch_is_rejected_before_any_event_and_root_scope_is_denied() {
    use maka_agent_facts::event::{Fact, InvocationInput, LogScope, RuntimeEvent};
    let (_dir, root, a, b) = fixture().await;
    let opening = |session: &str, id: &str| {
        EventWrite::plain(RuntimeEvent::new(
            Invocation {
                session_id: session.into(),
                turn_id: id.into(),
                run_id: id.into(),
                invocation_id: id.into(),
            },
            Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    content: "hello".into(),
                    source_messages: Vec::new(),
                    request_fingerprint: None,
                },
            },
        ))
        .unwrap()
    };
    let first = opening(a.id(), "first");
    let foreign = opening(b.id(), "foreign");
    assert!(
        a.append_batch(&[first.clone(), foreign.clone()])
            .await
            .is_err()
    );
    assert!(a.scoped().await.unwrap().append(&foreign).await.is_err());
    assert!(a.get_session::<serde_json::Value>(b.id()).await.is_err());
    assert!(a.scoped_prefix(LogScope::Root, 10, 4096).await.is_err());
    for session in [&a, &b] {
        assert!(
            session
                .scoped_prefix(
                    LogScope::Session {
                        id: session.id().into()
                    },
                    10,
                    4096
                )
                .await
                .unwrap()
                .events
                .is_empty()
        );
    }
    a.append(&first).await.unwrap();
    assert_eq!(
        a.scoped_prefix(LogScope::Session { id: a.id().into() }, 10, 4096)
            .await
            .unwrap()
            .events
            .len(),
        1
    );
    root.close().await.unwrap();
}

#[tokio::test]
async fn unfinished_invocations_filter_session_before_pagination() {
    use maka_agent_facts::event::{Fact, InvocationInput, RuntimeEvent};
    let (_dir, root, a, b) = fixture().await;
    let opening = |session: &str, id: &str| {
        EventWrite::plain(RuntimeEvent::new(
            Invocation {
                session_id: session.into(),
                turn_id: id.into(),
                run_id: id.into(),
                invocation_id: id.into(),
            },
            Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    content: "pending".into(),
                    source_messages: Vec::new(),
                    request_fingerprint: None,
                },
            },
        ))
        .unwrap()
    };
    // A foreign pending row occupies the first global slot. Filtering after
    // LIMIT would return an empty A page and hide its later pending invocation.
    b.append(&opening(b.id(), "foreign-first")).await.unwrap();
    let own_sequence = a.append(&opening(a.id(), "own-second")).await.unwrap();
    let page = a.unfinished_invocations(0, 1).await.unwrap();
    assert_eq!(page.invocations.len(), 1);
    assert_eq!(page.invocations[0].session_id, a.id());
    assert_eq!(page.invocations[0].invocation_id, "own-second");
    assert_eq!(page.through_sequence, own_sequence);
    assert!(
        a.unfinished_invocations(page.through_sequence, 1)
            .await
            .unwrap()
            .invocations
            .is_empty()
    );
    let foreign_page = b.unfinished_invocations(0, 1).await.unwrap();
    assert_eq!(foreign_page.invocations[0].invocation_id, "foreign-first");
    assert!(a.unfinished_invocations(0, 0).await.is_err());
    root.close().await.unwrap();
}
