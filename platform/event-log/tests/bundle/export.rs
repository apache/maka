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

use maka_agent_facts::archive::ArchivedPlaceholder;
use maka_agent_facts::archive::outcome_projection;
use maka_agent_facts::artifact::Artifact;
use maka_agent_facts::artifact::ArtifactKind;
use maka_agent_facts::artifact::ArtifactSource;
use maka_agent_facts::attachment::AttachmentKind;
use maka_agent_facts::attachment::AttachmentRef;
use maka_agent_facts::attachment::StorageRef;
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::session::CopyPurpose;
use maka_event_log::{EventLog, StoreError, bundle::BundleError, sessions::SessionCopy};
use serde_json::{Value, json};
#[path = "fixtures.rs"]
mod fixtures;
#[path = "frames.rs"]
mod frames;
#[path = "image.rs"]
mod image;
#[path = "import.rs"]
mod import;
#[path = "materials.rs"]
mod materials;
#[path = "tamper.rs"]
mod tamper;
use frames::records;

fn event(run: &str, fact: Fact) -> EventWrite {
    EventWrite::plain(RuntimeEvent::new(
        Invocation {
            session_id: "source".into(),
            turn_id: run.into(),
            run_id: run.into(),
            invocation_id: run.into(),
        },
        fact,
    ))
    .unwrap()
}
async fn open(log: &EventLog, run: &str, content: maka_agent_facts::input::MessageInput) {
    log.append(&event(
        run,
        Fact::InvocationOpened {
            input: InvocationInput::Message {
                content,
                source_messages: vec![],
                request_fingerprint: None,
            },
            configuration: None,
        },
    ))
    .await
    .unwrap();
}
async fn end(log: &EventLog, run: &str) {
    log.append(&event(
        run,
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    ))
    .await
    .unwrap();
}

#[tokio::test]
async fn branch_export_keeps_archive_proofs_and_owned_bytes_without_parent_future_or_authority() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("source.sqlite"))
        .await
        .unwrap();
    log.create_session(
        "source",
        "source",
        &json!({"name":"private source config"}),
        1,
    )
    .await
    .unwrap();
    let empty_source = log
        .capture_model_context("source", None, 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    log.commit_artifact(
        Artifact {
            id: "input".into(),
            session_id: "source".into(),
            turn_id: "old".into(),
            created_at: 1,
            name: "input.txt".into(),
            kind: ArtifactKind::File,
            size_bytes: 5,
            mime_type: Some("text/plain".into()),
            source: ArtifactSource::UserUpload,
            summary: Some(maka_agent_facts::artifact::content_digest(b"bytes")),
        },
        b"bytes".to_vec(),
    )
    .await
    .unwrap();
    let mut content: maka_agent_facts::input::MessageInput = "retained conversation".into();
    content.attachments = Some(vec![AttachmentRef {
        kind: AttachmentKind::Other,
        name: "input.txt".into(),
        mime_type: "text/plain".into(),
        bytes: 5,
        storage_ref: StorageRef::SessionFile {
            session_id: "source".into(),
            relative_path: "input".into(),
        },
    }]);
    open(&log, "old", content).await;
    let result = fixtures::tool(
        &log,
        &event(
            "old",
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Completed,
            },
        )
        .event()
        .invocation
        .clone(),
        "read",
        (0..400)
            .map(|i| format!("line {i}: retained source\n"))
            .collect::<String>(),
    )
    .await;
    end(&log, "old").await;
    open(&log, "archiver", "archive".into()).await;
    let Fact::ToolSettled { outcome, .. } = &result.event().fact else {
        unreachable!()
    };
    let archived = event(
        "archiver",
        Fact::ToolResultArchived {
            placeholder: ArchivedPlaceholder::prepare(
                result.event().id.clone(),
                "read".into(),
                "Read".into(),
                &outcome_projection(outcome),
            )
            .unwrap()
            .unwrap(),
        },
    );
    log.append(&archived).await.unwrap();
    end(&log, "archiver").await;
    let revision = log
        .get_session::<Value>("source")
        .await
        .unwrap()
        .unwrap()
        .revision;
    log.copy_session(
        SessionCopy {
            source_session_id: "source".into(),
            target_session_id: "branch".into(),
            expected_source_revision: revision,
            purpose: CopyPurpose::Branch {
                turn_id: Some("old".into()),
                side_conversation: false,
            },
        },
        &json!({"name":"exported branch"}),
        2,
    )
    .await
    .unwrap();
    open(&log, "later", "DO NOT EXPORT FUTURE".into()).await;
    end(&log, "later").await;
    let inventory = log.preview_bundle("branch").await.unwrap();
    let process = uuid::Uuid::new_v4();
    log.admit_session_process("branch", process).await.unwrap();
    assert!(matches!(
        log.export_bundle("branch", &inventory.subtree_digest, Vec::new())
            .await,
        Err(BundleError::Store(StoreError::SessionBusy))
    ));
    log.clean_session_process(process).await.unwrap();
    let (bytes, report) = log
        .export_bundle("branch", &inventory.subtree_digest, Vec::new())
        .await
        .unwrap();
    assert_eq!(report.bytes, bytes.len() as u64);
    let inspected = maka_event_log::bundle::inspect(bytes.as_slice())
        .await
        .unwrap();
    assert_eq!(inspected.inventory, report.inventory);
    assert_eq!(inspected.digest, report.digest);
    assert_eq!(inspected.bytes, report.bytes);
    let mut staged = maka_event_log::bundle::StagedBundle::read(bytes.as_slice())
        .await
        .unwrap();
    assert_eq!(staged.summary().digest, report.digest);
    assert_eq!(staged.summary().inventory, report.inventory);
    staged.validate_history().await.unwrap();
    staged.close().await.unwrap();
    import::roundtrip(&bytes).await;
    tamper::verify_original_proofs(&bytes, &report.digest, &empty_source).await;
    for end in [0, 13, bytes.len() / 2, bytes.len() - 1] {
        assert!(
            maka_event_log::bundle::inspect(&bytes[..end])
                .await
                .is_err()
        );
    }
    let mut damaged = bytes.clone();
    let payload = damaged
        .windows(5)
        .rposition(|window| window == b"bytes")
        .unwrap();
    damaged[payload] ^= 1;
    assert!(matches!(
        maka_event_log::bundle::inspect(damaged.as_slice()).await,
        Err(BundleError::Store(StoreError::InvalidTransition(message))) if message == "bundle payload digest mismatch"
    ));
    let mut trailing = bytes.clone();
    trailing.push(0);
    assert!(
        maka_event_log::bundle::inspect(trailing.as_slice())
            .await
            .is_err()
    );
    let records = records(&bytes, &report.digest);
    let catalog: Vec<_> = records.iter().filter(|r| r["kind"] == "session").collect();
    assert_eq!(catalog.len(), 1);
    assert_eq!(catalog[0]["id"], "branch");
    assert_eq!(catalog[0]["configuration"]["name"], "exported branch");
    let events: Vec<RuntimeEvent> = records
        .iter()
        .filter(|r| r["kind"] == "event")
        .map(|r| serde_json::from_str(r["json"].as_str().unwrap()).unwrap())
        .collect();
    assert!(events.iter().any(|e| e.id == archived.event().id));
    assert!(events.iter().any(|e| e.id == result.event().id));
    assert!(
        events.iter().any(|e| e.invocation.run_id == "archiver"
            && matches!(e.fact, Fact::InvocationOpened { .. }))
    );
    assert!(!events.iter().any(
        |e| e.invocation.run_id == "archiver" && matches!(e.fact, Fact::InvocationEnded { .. })
    ));
    assert!(!events.iter().any(|e| e.invocation.run_id == "later"));
    assert!(
        records
            .iter()
            .any(|r| r["kind"] == "history_artifact" && r["session"] == "branch")
    );
    assert!(records.iter().any(|r| r["kind"] == "blob"
        && r["resource"] == "artifact"
        && r["metadata"]["sessionId"] == "branch"));
    assert!(!String::from_utf8_lossy(&bytes).contains("DO NOT EXPORT FUTURE"));
    assert!(!String::from_utf8_lossy(&bytes).contains("private source config"));
    // Both original JSON strings and raw payload bytes remain exact.
    let result_frame = records
        .iter()
        .find(|r| {
            r["kind"] == "event"
                && r["json"].as_str().is_some_and(|s| {
                    serde_json::from_str::<RuntimeEvent>(s).unwrap().id == result.event().id
                })
        })
        .unwrap();
    assert_eq!(
        result_frame["json"],
        serde_json::to_string(result.event()).unwrap()
    );
    assert!(matches!(
        log.export_bundle("branch", "stale", Vec::new()).await,
        Err(BundleError::CandidateSetStale)
    ));
    open(&log, "busy", "not sealed".into()).await;
    let source = log.preview_bundle("source").await.unwrap();
    assert!(matches!(
        log.export_bundle("source", &source.subtree_digest, Vec::new())
            .await,
        Err(BundleError::Store(StoreError::SessionBusy))
    ));
    end(&log, "busy").await;
    materials::verify_nested_copy(&log).await;
    tamper::verify_deleted_upload(&log).await;
    log.close().await.unwrap();
}
