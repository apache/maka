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
use maka_agent_facts::context::CheckpointMode;
use maka_agent_facts::context::CompactOutcome;
use maka_agent_facts::context::ContextCheckpoint;
use maka_agent_facts::context::ModelPurpose;
use maka_agent_facts::context::TextSummary;
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::LogScope;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::model::recorded::ModelCompletion;
use maka_agent_facts::tool_call::ToolCallIdentity;
use maka_agent_facts::tool_output::ToolSuccess;
use maka_event_log::{
    EventLog, StoreError,
    context::{ContextEvent, LatestMainContext, ModelContextSource},
};
use serde_json::json;
mod fixtures;
mod streaming;
use fixtures::*;

#[tokio::test]
async fn retirement_fences_new_effects_without_rejecting_accepted_results_or_exact_replay() {
    use maka_agent_facts::event::CommitError;
    use maka_event_log::sessions::SessionRetirement;
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("retirement.sqlite"))
        .await
        .unwrap();
    log.create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    open(&log, "run", false).await;
    let accepted = request("run", "step", None);
    let sequence = log.append(&accepted).await.unwrap();
    let revision = log
        .get_session::<serde_json::Value>("session")
        .await
        .unwrap()
        .unwrap()
        .revision;
    log.begin_session_removal("session", revision)
        .await
        .unwrap();
    assert_eq!(log.append(&accepted).await.unwrap(), sequence);
    let output = ModelCompletion {
        parts: vec![model_part(
            "run",
            "step",
            0,
            maka_agent_facts::model::ModelPart::ToolCall {
                call: maka_agent_facts::model::ModelToolCall {
                    id: "call".into(),
                    name: "Read".into(),
                    input: json!({"path":"file"}).into(),
                    provider_executed: false,
                    provider_options: None,
                },
            },
        )],
        finish_reason: maka_agent_facts::model::ModelFinishReason::ToolCalls,
        usage: Default::default(),
        provider_options: None,
        response_id: None,
        model: None,
        timestamp: None,
    };
    log.append(&event(
        "run",
        Fact::ModelCompleted {
            step_id: "step".into(),
            output,
        },
    ))
    .await
    .unwrap();
    assert!(matches!(
        log.append(&request("run", "next", None)).await,
        Err(CommitError::Retired)
    ));
    assert!(matches!(
        log.append(&event(
            "run",
            Fact::ToolDispatched {
                presentation: None,
                title: None,
                operation_id: "step:call".into(),
                call: ToolCallIdentity::provider("step".into(), "call".into()),
                name: "Read".into(),
                input: json!({"path":"file"}),
            }
        ))
        .await,
        Err(CommitError::Retired)
    ));
    log.append(&event(
        "run",
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Cancelled {
                source: "session_removal".into(),
            },
        },
    ))
    .await
    .unwrap();
    assert_eq!(
        log.finish_session_retirement("session").await.unwrap(),
        SessionRetirement::Removed
    );
    assert!(matches!(
        log.append(&accepted).await,
        Err(CommitError::Retired)
    ));
    log.close().await.unwrap();
}

#[tokio::test]
async fn archive_publication_is_atomic_and_preserves_original_source_integrity() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("archive.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("session", "history-source", &json!({}), 1)
        .await
        .unwrap();
    open(&log, "old", false).await;
    let target = tool(&log, "old", "step", "x".repeat(12_000)).await;
    let unpruned = log
        .read_tool_result("session", &target.event().id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unpruned.tool_name, "Read");
    assert_eq!(
        unpruned.serialized_result,
        serde_json::to_string(&"x".repeat(12_000)).unwrap()
    );
    assert!(
        log.read_tool_result("other", &target.event().id)
            .await
            .unwrap()
            .is_none()
    );
    end(&log, "old").await;
    let frozen = log
        .capture_model_context("session", None, 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    open(&log, "writer", false).await;
    let source = log
        .capture_model_context("session", Some("writer"), 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    let mut main = request("writer", "writer-main", None).event().clone();
    if let Fact::ModelRequested {
        source_high_water,
        source_digest,
        ..
    } = &mut main.fact
    {
        *source_high_water = source.source_evidence.high_water;
        *source_digest = source.source_evidence.digest;
    }
    log.append(&EventWrite::plain(main).unwrap()).await.unwrap();
    log.append(&event(
        "writer",
        Fact::ModelCompleted {
            step_id: "writer-main".into(),
            output: serde_json::from_value(
                json!({"parts":[],"finish_reason":"stop","usage":{"input_tokens":10,"output_tokens":0}}),
            )
            .unwrap(),
        },
    ))
    .await
    .unwrap();
    let observed = log.subscribe_commits();
    assert_eq!(
        log.context_usage("session").await.unwrap().1,
        Some(maka_event_log::context::ContextUsage {
            tokens: 10,
            approximate: false,
            last_known: false,
        })
    );
    assert!(
        !observed.has_changed().unwrap(),
        "usage queries must not write execution facts"
    );
    let write = archive("writer", &target);
    let Fact::ToolResultArchived { placeholder } = &write.event().fact else {
        panic!()
    };
    assert!(
        log.read_archive("session", &placeholder.identity)
            .await
            .unwrap()
            .is_none()
    );
    let mut forged_page = write.event().clone();
    if let Fact::ToolResultArchived { placeholder } = &mut forged_page.fact {
        placeholder.page.content.replace_range(..1, "y");
    }
    let commits = log.subscribe_commits();
    assert!(
        log.append(&EventWrite::plain(forged_page).unwrap())
            .await
            .is_err()
    );
    assert!(!commits.has_changed().unwrap());
    let inspect = rusqlite::Connection::open(&path).unwrap();
    inspect.execute_batch("CREATE TRIGGER reject_archive BEFORE INSERT ON event_log WHEN NEW.kind='tool_result_archived' BEGIN SELECT RAISE(ABORT,'injected archive failure'); END;").unwrap();
    let commits = log.subscribe_commits();
    assert!(log.append(&write).await.is_err());
    assert!(!commits.has_changed().unwrap());
    assert!(
        log.read_archive("session", &placeholder.identity)
            .await
            .unwrap()
            .is_none()
    );
    inspect
        .execute_batch("DROP TRIGGER reject_archive")
        .unwrap();
    log.append(&write).await.unwrap();
    assert_eq!(
        log.context_usage("session").await.unwrap().1,
        None,
        "archiving invalidates the old provider baseline without inventing a subtraction"
    );
    assert!(
        matches!(log.latest_main_context("session").await.unwrap(),LatestMainContext::Selected(selected) if !selected.projection_current)
    );
    let original = log
        .read_frozen_model_context(&frozen.source_evidence, 100, 64 * 1024)
        .await
        .unwrap();
    assert_eq!(
        original.effective_source_digest,
        frozen.effective_source_digest
    );
    assert!(original.tail.iter().any(
        |entry| matches!(entry, ContextEvent::Canonical(entry) if entry.event.id == target.event().id)
    ));
    assert!(
        matches!(
            log.read_frozen_model_context(&frozen.source_evidence, 100, 8192)
                .await,
            Err(StoreError::PrefixTooLarge)
        ),
        "later archiving must not shrink a frozen source's original projection"
    );
    let commits = log.subscribe_commits();
    log.append(&write).await.unwrap();
    assert!(!commits.has_changed().unwrap());
    let source = log
        .capture_model_context("session", Some("writer"), 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    assert!(
        source
            .tail
            .iter()
            .any(|e| matches!(e,ContextEvent::Archived(a) if a.event_id==target.event().id))
    );
    assert!(
        log.read_archive("other", &placeholder.identity)
            .await
            .unwrap()
            .is_none()
    );
    let mut forged = placeholder.identity.clone();
    forged.body_sha256 = "0".repeat(64);
    assert!(log.read_archive("session", &forged).await.is_err());
    let expected = log
        .read_archive("session", &placeholder.identity)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        log.read_tool_result("session", &target.event().id)
            .await
            .unwrap()
            .unwrap()
            .serialized_result
            .as_bytes(),
        expected
    );
    assert_eq!(expected, serde_json::to_vec(&"x".repeat(12_000)).unwrap());
    end(&log, "writer").await;
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    log.append(&write).await.unwrap();
    assert_eq!(
        log.read_archive("session", &placeholder.identity)
            .await
            .unwrap()
            .unwrap(),
        expected
    );
    // Deliberately corrupt immutable physical material outside its publisher.
    inspect
        .execute_batch("DROP TRIGGER event_body_immutable")
        .unwrap();
    inspect.execute("UPDATE event_bodies SET payload=CAST(replace(CAST(payload AS TEXT),'xxxxxxxx','yyyyyyyy') AS BLOB) WHERE id=(
        SELECT s.body_id FROM event_body_slots s JOIN event_log e ON e.sequence=s.event_sequence WHERE e.event_id=?)",
        [&target.event().id]).unwrap();
    assert!(
        log.read_tool_result("session", &target.event().id)
            .await
            .is_err()
    );
    assert!(
        log.read_archive("session", &placeholder.identity)
            .await
            .is_err()
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn inherited_archives_remain_scoped_to_their_copied_owner() {
    use maka_event_log::sessions::{SessionCopy, SessionCopyResult};
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("copies.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("session", "source", &json!({}), 1)
        .await
        .unwrap();
    open(&log, "original", false).await;
    let target = tool(&log, "original", "read", "evidence\n".repeat(2_000)).await;
    end(&log, "original").await;
    let revision = log
        .get_session::<serde_json::Value>("session")
        .await
        .unwrap()
        .unwrap()
        .revision;
    for id in ["branch", "sibling"] {
        assert!(matches!(
            log.copy_session(
                SessionCopy {
                    source_session_id: "session".into(),
                    target_session_id: id.into(),
                    expected_source_revision: revision,
                    purpose: maka_agent_facts::session::CopyPurpose::Branch {
                        position: maka_agent_facts::session::ForkPosition::End,
                        side_conversation: false
                    },
                },
                &json!({}),
                2
            )
            .await
            .unwrap(),
            SessionCopyResult::Committed(_)
        ));
    }
    let frozen = log
        .capture_model_context("branch", None, 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    // A later source archive is neither visible nor a duplicate in the copy.
    open(&log, "source-prune", false).await;
    log.append(&archive("source-prune", &target)).await.unwrap();
    end(&log, "source-prune").await;
    let candidates = log
        .prepare_prune_candidates("branch", None, 10, 65536, None)
        .await
        .unwrap();
    assert_eq!(candidates.candidates.len(), 1);
    assert_eq!(candidates.candidates[0].event_id, target.event().id);
    let in_branch = |write: EventWrite| {
        let mut event = write.event().clone();
        event.invocation.session_id = "branch".into();
        EventWrite::plain(event).unwrap()
    };
    log.append(&in_branch(event(
        "branch-prune",
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content: "continue".into(),
                source_messages: Vec::new(),
                request_fingerprint: None,
            },
        },
    )))
    .await
    .unwrap();
    let write = in_branch(archive("branch-prune", &target));
    log.append(&write).await.unwrap();
    log.append(&write).await.unwrap();
    assert!(
        log.append(&in_branch(archive("branch-prune", &target)))
            .await
            .is_err()
    );
    log.append(&in_branch(event(
        "branch-prune",
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    )))
    .await
    .unwrap();
    let pruned = log
        .capture_model_context("branch", None, 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    assert!(pruned.tail.iter().any(
        |entry| matches!(entry, ContextEvent::Archived(a) if a.event_id == target.event().id)
    ));
    assert!(
        log.prepare_prune_candidates("branch", None, 10, 65536, None)
            .await
            .unwrap()
            .candidates
            .is_empty()
    );
    let sibling = log
        .capture_model_context("sibling", None, 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    assert_eq!(
        sibling.tail.iter().find_map(|entry| match entry {
            ContextEvent::Canonical(entry) if entry.event.id == target.event().id =>
                Some(&entry.event),
            _ => None,
        }),
        Some(target.event()),
        "branch pruning cannot replace its sibling's original result"
    );
    assert_eq!(
        log.read_frozen_model_context(&frozen.source_evidence, 100, 65536)
            .await
            .unwrap()
            .effective_source_digest,
        frozen.effective_source_digest
    );
    let Fact::ToolResultArchived { placeholder } = &write.event().fact else {
        panic!()
    };
    let bytes = log
        .read_archive("branch", &placeholder.identity)
        .await
        .unwrap()
        .unwrap();
    assert!(
        log.read_archive("sibling", &placeholder.identity)
            .await
            .unwrap()
            .is_none()
    );
    // Copying the copy freezes its local archive, whose writer is not the original Session.
    let revision = log
        .get_session::<serde_json::Value>("branch")
        .await
        .unwrap()
        .unwrap()
        .revision;
    assert!(matches!(
        log.copy_session(
            SessionCopy {
                source_session_id: "branch".into(),
                target_session_id: "nested".into(),
                expected_source_revision: revision,
                purpose: maka_agent_facts::session::CopyPurpose::Branch {
                    position: maka_agent_facts::session::ForkPosition::End,
                    side_conversation: false
                },
            },
            &json!({}),
            3
        )
        .await
        .unwrap(),
        SessionCopyResult::Committed(_)
    ));
    let adopted = log
        .capture_model_context("nested", None, 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    assert!(adopted.tail.iter().any(
        |entry| matches!(entry, ContextEvent::Archived(a) if a.event_id == target.event().id)
    ));
    assert_eq!(
        log.read_archive("nested", &placeholder.identity)
            .await
            .unwrap()
            .unwrap(),
        bytes
    );

    // A wrong, but foreign-key-valid, pin must not silently restore raw output.
    let inspect = rusqlite::Connection::open(&path).unwrap();
    inspect
        .execute(
            "UPDATE session_history_members SET archive_sequence=sequence
        WHERE session_id='nested' AND archive_sequence IS NOT NULL",
            [],
        )
        .unwrap();
    assert!(
        log.read_archive("nested", &placeholder.identity)
            .await
            .is_err()
    );
    log.close().await.unwrap();
}

mod automatic;
