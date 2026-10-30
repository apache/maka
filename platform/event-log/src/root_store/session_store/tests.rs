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
                sqlx::query("INSERT INTO session_history_artifacts (session_id,source_session_id,source_artifact_id,artifact_id,lookup_digest,target_digest) VALUES(?,?,'original','copy',?,?)")
                    .bind(&target)
                    .bind(&source)
                    .bind(crate::artifacts::identity::history_lookup_digest(&target,&source,"original").as_slice())
                    .bind(crate::artifacts::identity::artifact_lookup_digest(&target,"copy").as_slice())
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
