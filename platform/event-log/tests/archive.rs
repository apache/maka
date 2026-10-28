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
use maka_agent_facts::model::ModelStep;
use maka_agent_facts::tool_call::ToolCallIdentity;
use maka_agent_facts::tool_output::ToolSuccess;
use maka_event_log::{
    EventLog, StoreError,
    context::{ContextEvent, HistoryCapture, HistoryCut, LatestMainContext, ModelContextSource},
};
use serde_json::json;
#[path = "archive/context_performance.rs"]
mod context_performance;
#[path = "archive/digest.rs"]
mod digest;
#[path = "archive/fixtures.rs"]
mod fixtures;
#[path = "archive/lineage.rs"]
mod lineage;
#[path = "archive/performance.rs"]
mod performance;
#[path = "archive/streaming.rs"]
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
    let output = serde_json::from_value(json!({
        "parts":[{"kind":"tool_call","call":{"id":"call","name":"Read","input":{"kind":"json","data":{"path":"file"}},"provider_executed":false}}],
        "finish_reason":"tool-calls","usage":{}
    })).unwrap();
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
async fn archive_atomic_retry_reopen_scope_and_source_integrity() {
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
    let initial_revision = log
        .get_session::<serde_json::Value>("session")
        .await
        .unwrap()
        .unwrap()
        .revision;
    let HistoryCapture::Captured(before_archive) = log
        .capture_session_history(
            "session",
            initial_revision,
            HistoryCut::ThroughTurn("old".into()),
            100,
            64 * 1024,
        )
        .await
        .unwrap()
    else {
        panic!("unchanged source");
    };
    use maka_event_log::sessions::{SessionCopy, SessionCopyResult};
    assert!(matches!(
        log.copy_session(
            SessionCopy {
                source_session_id: "session".into(),
                target_session_id: "unpruned-copy".into(),
                expected_source_revision: initial_revision,
                purpose: maka_agent_facts::session::CopyPurpose::Branch {
                    position: maka_agent_facts::session::ForkPosition::ThroughTurn {
                        turn_id: "old".into()
                    },
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
    assert_eq!(
        log.resolve_read_resource(
            "unpruned-copy",
            maka_agent_facts::read::ResourceAddress::ToolResult("result-st".into())
        )
        .await
        .unwrap(),
        Some(maka_agent_facts::read::ResourceAddress::ToolResult(
            target.event().id.clone()
        ))
    );
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
    let final_revision = log
        .get_session::<serde_json::Value>("session")
        .await
        .unwrap()
        .unwrap()
        .revision;
    assert!(matches!(
        log.copy_session(
            SessionCopy {
                source_session_id: "session".into(),
                target_session_id: "archived-copy".into(),
                expected_source_revision: final_revision,
                purpose: maka_agent_facts::session::CopyPurpose::Branch {
                    position: maka_agent_facts::session::ForkPosition::ThroughTurn {
                        turn_id: "old".into()
                    },
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
        .capture_model_context("archived-copy", None, 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    assert_eq!(
        log.read_archive("archived-copy", &placeholder.identity)
            .await
            .unwrap()
            .unwrap(),
        expected,
        "copy reads its accepted archive without borrowing source Session access"
    );
    assert!(
        log.read_archive("unpruned-copy", &placeholder.identity)
            .await
            .unwrap()
            .is_none(),
        "a later source archive does not become an accepted archive in an older copy"
    );
    for session in ["archived-copy", "unpruned-copy"] {
        assert_eq!(
            log.read_tool_result(session, &target.event().id)
                .await
                .unwrap()
                .unwrap()
                .serialized_result
                .as_bytes(),
            expected
        );
    }
    assert!(
        adopted
            .tail
            .iter()
            .any(|e| matches!(e, ContextEvent::Archived(a) if a.event_id == target.event().id))
    );
    assert_eq!(
        log.read_frozen_model_context(&adopted.source_evidence, 100, 64 * 1024)
            .await
            .unwrap()
            .effective_source_digest,
        adopted.effective_source_digest
    );
    let unpruned = log
        .capture_model_context("unpruned-copy", None, 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    assert_eq!(
        unpruned.tail.iter().find_map(|entry| match entry {
            ContextEvent::Canonical(entry) if entry.event.id == target.event().id =>
                Some(&entry.event),
            _ => None,
        }),
        Some(target.event()),
        "later source pruning cannot replace history already owned by a copy"
    );
    let copy_invocation = Invocation {
        session_id: "archived-copy".into(),
        turn_id: "copy-turn".into(),
        run_id: "copy-run".into(),
        invocation_id: "copy-inv".into(),
    };
    for fact in [
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content: "continue".into(),
                source_messages: Vec::new(),
                request_fingerprint: None,
            },
        },
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    ] {
        log.append(&EventWrite::plain(RuntimeEvent::new(copy_invocation.clone(), fact)).unwrap())
            .await
            .unwrap();
    }
    assert_eq!(
        log.context_before_run(&copy_invocation, 100, 64 * 1024)
            .await
            .unwrap()
            .effective_source_digest,
        adopted.effective_source_digest
    );
    let lineage = log
        .scoped_prefix(
            LogScope::Lineage {
                session_id: "archived-copy".into(),
                run_id: "copy-run".into(),
            },
            100,
            65536,
        )
        .await
        .unwrap();
    let lineage = log
        .read_frozen_model_context(
            &maka_event_log::context::SourceEvidence {
                scope: lineage.scope,
                high_water: lineage.high_water,
                digest: lineage.digest,
            },
            100,
            64 * 1024,
        )
        .await
        .unwrap();
    assert!(
        lineage
            .tail
            .iter()
            .any(|e| matches!(e, ContextEvent::Archived(a) if a.event_id == target.event().id)),
        "adopted archive writer need not belong to the new Run's lineage"
    );
    assert!(matches!(log.capture_session_history(
        "session", initial_revision, HistoryCut::End, 100, 8192,
    ).await.unwrap(), HistoryCapture::SourceRevisionConflict { expected, actual }
        if expected == initial_revision && actual == final_revision));
    let HistoryCapture::Captured(after_archive) = log
        .capture_session_history(
            "session",
            final_revision,
            HistoryCut::ThroughTurn("old".into()),
            100,
            16 * 1024,
        )
        .await
        .unwrap()
    else {
        panic!("unchanged source");
    };
    // The retained Turn is unchanged, but an already accepted later archive
    // belongs to the copy's frozen rendering. It is not a copied writer Run.
    assert_eq!(
        after_archive.context.source_evidence.digest,
        before_archive.context.source_evidence.digest
    );
    assert_ne!(
        after_archive.context.effective_source_digest,
        before_archive.context.effective_source_digest
    );
    assert!(after_archive.observed_through > before_archive.observed_through);
    assert!(after_archive.context.tail.iter().any(
        |entry| matches!(entry, ContextEvent::Archived(entry) if entry.event_id == target.event().id)
    ));
    assert!(after_archive.context.tail.iter().all(|entry| match entry {
        ContextEvent::Canonical(entry) => entry.event.invocation.invocation_id == "old",
        ContextEvent::Archived(entry) => entry.invocation.invocation_id == "old",
        ContextEvent::ModelItems(entry) => entry.invocation.invocation_id == "old",
    }));
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    let HistoryCapture::Captured(reopened) = log
        .capture_session_history(
            "session",
            final_revision,
            HistoryCut::ThroughTurn("old".into()),
            100,
            16 * 1024,
        )
        .await
        .unwrap()
    else {
        panic!("unchanged source after reopen");
    };
    assert_eq!(
        reopened.context.effective_source_digest,
        after_archive.context.effective_source_digest
    );
    log.append(&write).await.unwrap();
    assert_eq!(
        log.read_archive("session", &placeholder.identity)
            .await
            .unwrap()
            .unwrap(),
        expected
    );
    inspect.execute("UPDATE event_log SET event_json=replace(event_json,'xxxxxxxx','yyyyyyyy') WHERE event_id=?", [&target.event().id]).unwrap();
    assert!(
        log.read_tool_result("session", &target.event().id)
            .await
            .is_err()
    );
    assert!(
        log.read_archive("archived-copy", &placeholder.identity)
            .await
            .is_err(),
        "history membership never bypasses original evidence integrity"
    );
    assert!(
        log.read_archive("session", &placeholder.identity)
            .await
            .is_err()
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn inherited_results_prune_and_compact_without_changing_siblings_or_frozen_reads() {
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

    log.append(&in_branch(event(
        "branch-compact",
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::ContextCompact {
                request_fingerprint: "branch-compact".into(),
            },
        },
    )))
    .await
    .unwrap();
    let source = log
        .capture_compaction_context(
            "branch",
            Some("branch-compact"),
            &CheckpointMode::Standalone,
            100_000,
            64 * 1024 * 1024,
        )
        .await
        .unwrap();
    log.append(&in_branch(request(
        "branch-compact",
        "summary",
        Some(&source),
    )))
    .await
    .unwrap();
    let output: ModelStep = serde_json::from_value(json!({"parts":[{"kind":"text","text_kind":"text","text":SUMMARY}],"finish_reason":"stop","usage":{}})).unwrap();
    log.append(&in_branch(event(
        "branch-compact",
        Fact::ModelCompleted {
            step_id: "summary".into(),
            output: output.clone(),
        },
    )))
    .await
    .unwrap();
    let checkpoint = in_branch(event(
        "branch-compact",
        Fact::ContextCheckpointRecorded {
            checkpoint: ContextCheckpoint {
                mode: CheckpointMode::Standalone,
                covered_through: source.source_evidence.high_water,
                source_digest: source.source_evidence.digest,
                previous_checkpoint_id: None,
                summary: TextSummary::from_model_step(&output).unwrap(),
                summary_step_id: "summary".into(),
            },
        },
    ));
    log.append_batch(&[
        checkpoint.clone(),
        in_branch(event(
            "branch-compact",
            Fact::InvocationEnded {
                outcome: InvocationOutcome::ContextCompactFinished {
                    outcome: CompactOutcome::Compacted {
                        checkpoint_id: checkpoint.event().id.clone(),
                    },
                },
            },
        )),
    ])
    .await
    .unwrap();
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        log.capture_model_context("branch", None, 100_000, 64 * 1024 * 1024)
            .await
            .unwrap()
            .baseline
            .unwrap()
            .event_id,
        checkpoint.event().id
    );
    // Nested pins still need the intermediate writer's inherited ownership and
    // checkpoint evidence even after its live Session and materials are gone.
    let revision = log
        .get_session::<serde_json::Value>("branch")
        .await
        .unwrap()
        .unwrap()
        .revision;
    log.begin_session_removal("branch", revision).await.unwrap();
    assert_eq!(
        log.finish_session_retirement("branch").await.unwrap(),
        maka_event_log::sessions::SessionRetirement::Removed
    );
    assert_eq!(
        log.collect_session_material(None).await.unwrap(),
        maka_event_log::sessions::MaterialCollection::Retained("branch".into())
    );
    assert_eq!(
        log.capture_model_context("nested", None, 100_000, 64 * 1024 * 1024)
            .await
            .unwrap()
            .effective_source_digest,
        adopted.effective_source_digest
    );
    assert_eq!(
        log.read_archive("nested", &placeholder.identity)
            .await
            .unwrap()
            .unwrap(),
        bytes
    );
    assert_eq!(
        log.read_frozen_model_context(&frozen.source_evidence, 100, 65536)
            .await
            .unwrap()
            .effective_source_digest,
        frozen.effective_source_digest
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
}

#[tokio::test]
async fn bounded_prune_candidates_do_not_materialize_the_old_tail() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("large.sqlite"))
        .await
        .unwrap();
    open(&log, "old", false).await;
    let mut originals = Vec::new();
    for n in 0..40 {
        originals.push(tool(&log, "old", &format!("step-{n}"), "x".repeat(220_000)).await);
    }
    end(&log, "old").await;
    open(&log, "recent", false).await;
    end(&log, "recent").await;
    open(&log, "current", false).await;
    tool(&log, "current", "current-result", "small".into()).await;
    let complete = log
        .capture_model_context("session", Some("current"), 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    for original in &originals {
        assert_eq!(
            complete.tail.iter().find_map(|entry| match entry {
                ContextEvent::Canonical(entry) if entry.event.id == original.event().id =>
                    Some(&entry.event),
                _ => None,
            }),
            Some(original.event()),
            "the full model context must preserve every original result"
        );
    }
    let guard = log
        .prepare_prune_candidates("session", Some("current"), 0, 0, None)
        .await
        .unwrap();
    assert!(guard.candidates.is_empty());
    let first = log
        .prepare_prune_candidates("session", Some("current"), 4, 1024 * 1024, None)
        .await
        .unwrap();
    assert_eq!(first.candidates.len(), 4);
    assert!(first.next.is_some());
    end(&log, "current").await;
    open(&log, "pruner", false).await;
    let mut archived = 0;
    let mut cursor = None;
    loop {
        let batch = log
            .prepare_prune_candidates("session", Some("pruner"), 4, 1024 * 1024, cursor.as_ref())
            .await
            .unwrap();
        if batch.candidates.is_empty() {
            break;
        }
        for candidate in &batch.candidates {
            let Some(placeholder) = ArchivedPlaceholder::prepare(
                candidate.event_id.clone(),
                candidate.tool_call_id.clone(),
                candidate.tool_name.clone(),
                &candidate.projection,
            )
            .unwrap() else {
                continue;
            };
            log.append(&event("pruner", Fact::ToolResultArchived { placeholder }))
                .await
                .unwrap();
            archived += 1;
        }
        cursor = batch.next;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(archived, 40);
    let source = log
        .capture_model_context("session", Some("pruner"), 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    assert_eq!(
        source
            .tail
            .iter()
            .filter(|e| matches!(e, ContextEvent::Archived(_)))
            .count(),
        40
    );
    log.close().await.unwrap();
}

#[path = "archive/automatic.rs"]
mod automatic;
#[path = "archive/summary.rs"]
mod summary;

#[tokio::test]
async fn read_prefixes_keep_literal_archive_ids_and_session_scope() {
    use maka_agent_facts::read::ResourceAddress::ToolResult;
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("prefix.sqlite"))
        .await
        .unwrap();
    log.create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    open(&log, "run", false).await;
    for step in ["shared", "shared-long", "literal_*?[tail", "literal-other"] {
        tool(&log, "run", step, "content".into()).await;
    }
    let hidden = event(
        "run",
        Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: "hidden".into(),
            call: ToolCallIdentity::standalone("hidden-call".into()),
            name: "Read".into(),
            input: json!({}),
        },
    );
    log.append(&hidden).await.unwrap();
    let (hidden_result, _) = EventWrite::tool_success(
        "result-literal_hidden".into(),
        std::time::SystemTime::now(),
        hidden.event().invocation.clone(),
        "hidden".into(),
        ToolSuccess::from(json!("hidden")),
    )
    .unwrap();
    log.append(&hidden_result).await.unwrap();
    assert_eq!(
        log.resolve_read_resource("session", ToolResult("result-literal_".into()))
            .await
            .unwrap(),
        Some(ToolResult("result-literal_*?[tail".into()))
    );
    assert_eq!(
        log.resolve_read_resource("session", ToolResult("result-shared".into()))
            .await
            .unwrap(),
        Some(ToolResult("result-shared".into()))
    );
    assert!(matches!(
        log.resolve_read_resource("session", ToolResult("result-shar".into()))
            .await,
        Err(StoreError::AmbiguousReadResource)
    ));
    assert_eq!(
        log.resolve_read_resource("session", ToolResult("result-literal_*?[".into()))
            .await
            .unwrap(),
        Some(ToolResult("result-literal_*?[tail".into()))
    );
    for (session, prefix) in [
        ("other", "result-shar"),
        ("session", "Result-shared"),
        ("session", "result-shared\0x"),
    ] {
        assert!(
            log.resolve_read_resource(session, ToolResult(prefix.into()))
                .await
                .unwrap()
                .is_none()
        );
    }
    log.close().await.unwrap();
}

#[tokio::test]
async fn inspected_prune_results_are_skipped_without_hiding_later_results() {
    use maka_event_log::archive::PruneCursor;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("prune-progress.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    open(&log, "writer", false).await;
    for step in ["small-first", "small-second"] {
        tool(&log, "writer", step, "small retained output".into()).await;
    }
    let inspected = log
        .prepare_prune_candidates("session", Some("writer"), 128, 1024 * 1024, None)
        .await
        .unwrap();
    assert_eq!(inspected.candidates.len(), 2);
    assert!(inspected.next.is_none());
    for candidate in inspected.candidates {
        assert!(
            ArchivedPlaceholder::prepare(
                candidate.event_id,
                candidate.tool_call_id,
                candidate.tool_name,
                &candidate.projection
            )
            .unwrap()
            .is_none()
        );
    }
    let progress = PruneCursor::After(inspected.through);
    let empty = log
        .prepare_prune_candidates("session", Some("writer"), 128, 1024 * 1024, Some(&progress))
        .await
        .unwrap();
    assert!(empty.candidates.is_empty());
    let large = tool(
        &log,
        "writer",
        "large-later",
        "large output ".repeat(10_000),
    )
    .await;
    let later = log
        .prepare_prune_candidates("session", Some("writer"), 128, 1024 * 1024, Some(&progress))
        .await
        .unwrap();
    assert_eq!(later.candidates.len(), 1);
    assert_eq!(later.candidates[0].event_id, large.event().id);
    log.append(&archive("writer", &large)).await.unwrap();
    let done = PruneCursor::After(later.through);
    assert!(
        log.prepare_prune_candidates("session", Some("writer"), 128, 1024 * 1024, Some(&done))
            .await
            .unwrap()
            .candidates
            .is_empty()
    );
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    let restarted = log
        .prepare_prune_candidates("session", Some("writer"), 128, 1024 * 1024, None)
        .await
        .unwrap();
    assert_eq!(
        restarted.candidates.len(),
        2,
        "a new owner may inspect retained small results again"
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn oversized_tool_result_archives_alone_and_remains_readable() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("large.sqlite"))
        .await
        .unwrap();
    open(&log, "writer", false).await;
    let text = "x".repeat(5 * 1024 * 1024);
    let large = tool(&log, "writer", "large", text.clone()).await;
    let small = tool(&log, "writer", "small", "next".into()).await;
    let batch = log
        .prepare_prune_candidates("session", Some("writer"), 10, 1024 * 1024, None)
        .await
        .unwrap();
    assert_eq!(batch.candidates.len(), 1);
    assert_eq!(batch.candidates[0].event_id, large.event().id);
    assert_eq!(
        batch.candidates[0].projection,
        maka_agent_facts::tool_output::DurableToolProjection::Text { text: text.clone() }
    );
    let next = log
        .prepare_prune_candidates(
            "session",
            Some("writer"),
            10,
            1024 * 1024,
            batch.next.as_ref(),
        )
        .await
        .unwrap();
    assert_eq!(next.candidates.len(), 1);
    assert_eq!(next.candidates[0].event_id, small.event().id);
    let archived = archive("writer", &large);
    log.append(&archived).await.unwrap();
    let Fact::ToolResultArchived { placeholder } = &archived.event().fact else {
        panic!()
    };
    let body = log
        .read_archive("session", &placeholder.identity)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(serde_json::from_slice::<String>(&body).unwrap(), text);
    assert_eq!(placeholder.identity.original_bytes, 5 * 1024 * 1024 + 2);
    assert!(placeholder.page.next.is_some());
    let resource = log
        .read_tool_result("session", &large.event().id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(resource.serialized_result.as_bytes(), body);
    log.close().await.unwrap();
}

#[tokio::test]
async fn tool_result_prefixes_respect_frozen_copy_membership() {
    use maka_agent_facts::read::ResourceAddress::ToolResult;
    use maka_event_log::sessions::{SessionCopy, SessionCopyResult};
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("copied-prefix.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    open(&log, "old", false).await;
    tool(&log, "old", "shared", "copied response".into()).await;
    end(&log, "old").await;
    let revision = log
        .get_session::<serde_json::Value>("session")
        .await
        .unwrap()
        .unwrap()
        .revision;
    assert!(matches!(
        log.copy_session(
            SessionCopy {
                source_session_id: "session".into(),
                target_session_id: "branch".into(),
                expected_source_revision: revision,
                purpose: maka_agent_facts::session::CopyPurpose::Branch {
                    position: maka_agent_facts::session::ForkPosition::End,
                    side_conversation: false,
                },
            },
            &json!({}),
            2
        )
        .await
        .unwrap(),
        SessionCopyResult::Committed(_)
    ));
    open(&log, "later", false).await;
    tool(&log, "later", "shared-long", "after fork".into()).await;
    end(&log, "later").await;
    log.close().await.unwrap();
    let reopened = EventLog::open(&path).await.unwrap();
    assert_eq!(
        reopened
            .resolve_read_resource("branch", ToolResult("result-shar".into()))
            .await
            .unwrap(),
        Some(ToolResult("result-shared".into()))
    );
    assert_eq!(
        reopened
            .resolve_read_resource("branch", ToolResult("result-shared-long".into()))
            .await
            .unwrap(),
        None
    );
    assert!(matches!(
        reopened
            .resolve_read_resource("session", ToolResult("result-shar".into()))
            .await,
        Err(StoreError::AmbiguousReadResource)
    ));
    assert_eq!(
        reopened
            .resolve_read_resource("session", ToolResult("result-shared".into()))
            .await
            .unwrap(),
        Some(ToolResult("result-shared".into()))
    );
    assert_eq!(
        reopened
            .resolve_read_resource("other", ToolResult("result-shar".into()))
            .await
            .unwrap(),
        None
    );
    reopened.close().await.unwrap();
}
