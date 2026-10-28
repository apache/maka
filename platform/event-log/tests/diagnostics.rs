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

use maka_agent_facts::{
    diagnostics::{DiagnosticDetail, ExecutionFailureReason, TitleFailureCause},
    event::{
        EventWrite, Fact, Invocation, InvocationOutcome, LogScope, ModelInterruption, RuntimeEvent,
    },
    execution::*,
    input::InvocationInput,
    model::error::ModelFailureCause,
    session::{CopyPurpose, CopyRequest},
};
use maka_event_log::{EventLog, StoreError, sessions::SessionCopyResult};
use serde_json::{Value, json};

async fn append(log: &EventLog, invocation: &Invocation, fact: Fact) -> u64 {
    log.append(&EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap())
        .await
        .unwrap()
}
async fn opening(log: &EventLog, session: &str, id: &str) -> Invocation {
    let invocation = Invocation {
        session_id: session.into(),
        turn_id: id.into(),
        run_id: id.into(),
        invocation_id: id.into(),
    };
    append(
        log,
        &invocation,
        Fact::InvocationOpened {
            configuration: Some(Box::new(InvocationConfiguration {
                language: maka_agent_facts::language::Language::En,
                compaction_prompt: None,
                workspace_origin: WorkspaceOrigin::Selected,
                approval_policy: ApprovalPolicy::OnRequest,
                boundary_revision: 0,
                cwd: "/tmp".into(),
                workspace_binding: None,
                workspace_identity: None,
                model: Some(ModelBinding {
                    connection_id: "connection".into(),
                    connection_slug: "original".into(),
                    model: "requested".into(),
                }),
                editing_tools: None,
                tool_discovery: false,
                tool_composition: None,
                system_prompt: None,
                thinking_level: None,
                sandbox_mode: SandboxMode::ReadOnly,
                collaboration_mode: CollaborationMode::Agent,
                orchestration_mode: BehaviorId::default(),
                tool_mode: ToolMode::Direct,
                code_language: Default::default(),
            })),
            input: InvocationInput::Message {
                source_messages: vec![],
                content: "original question".into(),
                request_fingerprint: None,
            },
        },
    )
    .await;
    invocation
}

#[tokio::test]
async fn diagnostic_pages_preserve_sources_fences_and_operational_copy_scope() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("diagnostics.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    log.create_session("other", "other", &json!({}), 1)
        .await
        .unwrap();
    let invocation = opening(&log, "session", "first").await;
    append(
        &log,
        &invocation,
        Fact::ModelRequested {
            context_breakdown: None,
            item_acceptance: false,
            step_id: "step".into(),
            model_id: "requested".into(),
            source_scope: LogScope::Root,
            source_high_water: 0,
            source_digest: "fixture".into(),
            input_digest: "fixture".into(),
            route_identity: "route".into(),
            checkpoint_event_id: None,
            purpose: maka_agent_facts::context::ModelPurpose::Main,
            context: None,
            effective_source_digest: None,
        },
    )
    .await;
    let step = append(
        &log,
        &invocation,
        Fact::ModelInterrupted {
            step_id: "step".into(),
            status: ModelInterruption::Failed,
            diagnostic: Some("provider-secret-must-not-be-exported".into()),
            model_failure: Some(ModelFailureCause::Http { status: 400 }),
        },
    )
    .await;
    let terminal = append(
        &log,
        &invocation,
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Failed {
                class: "model_http".into(),
                message: Some("provider-secret-must-not-be-exported".into()),
                model_failure: Some(ModelFailureCause::Http { status: 400 }),
            },
        },
    )
    .await;
    let old_page = log
        .diagnostics_page("session", Some(terminal), None, 32, 48 * 1024)
        .await
        .unwrap();
    assert_eq!(
        old_page
            .entries
            .iter()
            .map(|entry| entry.sequence)
            .collect::<Vec<_>>(),
        vec![terminal, step]
    );
    assert_eq!(
        old_page.entries[0].detail,
        DiagnosticDetail::Execution {
            invocation: invocation.clone(),
            reason: ExecutionFailureReason::ModelHttp,
            model_failure: Some(ModelFailureCause::Http { status: 400 }),
        }
    );
    assert_eq!(
        old_page.entries[1].detail,
        DiagnosticDetail::ModelStep {
            invocation: invocation.clone(),
            step_id: "step".into(),
            status: ModelInterruption::Failed,
            model_failure: Some(ModelFailureCause::Http { status: 400 }),
        }
    );
    assert!(
        !serde_json::to_string(&old_page)
            .unwrap()
            .contains("provider-secret")
    );
    let revision = log
        .get_session::<Value>("session")
        .await
        .unwrap()
        .unwrap()
        .revision;
    assert!(matches!(
        log.copy_session(
            CopyRequest {
                source_session_id: "session".into(),
                target_session_id: "copy".into(),
                expected_source_revision: revision,
                purpose: CopyPurpose::Branch {
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
    log.set_session_archived::<Value>("session", true, 3)
        .await
        .unwrap();
    let title = log
        .record_title_failure(invocation.clone(), TitleFailureCause::EmptyOutput)
        .await
        .unwrap();
    let newest = log
        .diagnostics_page("session", None, None, 1, 48 * 1024)
        .await
        .unwrap();
    assert_eq!(
        newest.entries[0].detail,
        DiagnosticDetail::SessionTitle {
            invocation: invocation.clone(),
            cause: TitleFailureCause::EmptyOutput
        }
    );
    assert_eq!(newest.next_before, Some(title));
    assert_eq!(
        log.latest_diagnostic_sequence("session", terminal)
            .await
            .unwrap(),
        Some(terminal)
    );
    assert_eq!(
        log.latest_diagnostic_sequence("session", title)
            .await
            .unwrap(),
        Some(title)
    );
    let older = log
        .diagnostics_page(
            "session",
            Some(newest.through),
            newest.next_before,
            32,
            48 * 1024,
        )
        .await
        .unwrap();
    assert_eq!(older.entries, old_page.entries);
    assert_eq!(
        log.diagnostics_page("session", Some(terminal), None, 32, 48 * 1024)
            .await
            .unwrap()
            .entries,
        old_page.entries
    );
    assert!(
        log.diagnostics_page("other", None, None, 32, 48 * 1024)
            .await
            .unwrap()
            .entries
            .is_empty()
    );
    assert!(
        log.diagnostics_page("copy", None, None, 32, 48 * 1024)
            .await
            .unwrap()
            .entries
            .is_empty()
    );
    let inherited = log
        .scoped_prefix(LogScope::Session { id: "copy".into() }, 32, 128 * 1024)
        .await
        .unwrap();
    assert!(
        inherited
            .events
            .iter()
            .any(|entry| entry.event.invocation == invocation
                && matches!(entry.event.fact, Fact::InvocationEnded { .. }))
    );
    assert!(matches!(
        log.diagnostics_page("session", Some(title), Some(0), 32, 48 * 1024)
            .await,
        Err(StoreError::InvalidTransition(_))
    ));
    assert!(matches!(
        log.diagnostics_page("session", Some(title), Some(title + 1), 32, 48 * 1024)
            .await,
        Err(StoreError::InvalidTransition(_))
    ));
    let all = log
        .diagnostics_page("session", None, None, 32, 48 * 1024)
        .await
        .unwrap();
    let mut before = None;
    let mut complete = Vec::new();
    loop {
        let page = log
            .diagnostics_page("session", Some(all.through), before, 32, 1)
            .await
            .unwrap();
        assert_eq!(page.through, all.through);
        assert_eq!(
            page.entries.len(),
            1,
            "a complete oversized first record must make progress"
        );
        complete.extend(page.entries);
        match page.next_before {
            Some(next) => {
                assert!(before.is_none_or(|old| next < old));
                before = Some(next);
            }
            None => break,
        }
    }
    assert_eq!(complete, all.entries);
    let timestamp = newest.entries[0].recorded_at;
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    let reopened = log
        .diagnostics_page("session", Some(title), None, 32, 48 * 1024)
        .await
        .unwrap();
    assert_eq!(reopened.entries[0].sequence, title);
    assert_eq!(reopened.entries[0].recorded_at, timestamp);
    assert_eq!(reopened.entries[0].detail, newest.entries[0].detail);
    log.close().await.unwrap();
}

#[tokio::test]
async fn title_failure_requires_original_opening_without_inventing_attempts() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("title.sqlite"))
        .await
        .unwrap();
    log.create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    let original = opening(&log, "session", "first").await;
    let mut forged = original.clone();
    forged.run_id = "not-original".into();
    assert!(matches!(
        log.record_title_failure(forged, TitleFailureCause::Preparation)
            .await,
        Err(StoreError::InvalidTransition(_))
    ));
    let invalid = EventWrite::plain(RuntimeEvent::new(
        original.clone(),
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Failed {
                class: "model_http".into(),
                message: None,
                model_failure: Some(ModelFailureCause::Http { status: 200 }),
            },
        },
    ))
    .unwrap();
    assert!(matches!(
        log.append(&invalid).await,
        Err(maka_agent_facts::event::CommitError::Rejected(_))
    ));
    append(
        &log,
        &original,
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    )
    .await;
    let later = opening(&log, "session", "later").await;
    assert!(matches!(
        log.record_title_failure(later.clone(), TitleFailureCause::Preparation)
            .await,
        Err(StoreError::InvalidTransition(_))
    ));
    append(
        &log,
        &later,
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    )
    .await;
    assert!(matches!(
        log.record_title_failure(
            original.clone(),
            TitleFailureCause::Model {
                cause: ModelFailureCause::Http { status: 200 }
            }
        )
        .await,
        Err(StoreError::InvalidTransition(_))
    ));
    let sequence = log
        .record_title_failure(original.clone(), TitleFailureCause::Preparation)
        .await
        .unwrap();
    let page = log
        .diagnostics_page("session", None, None, 32, 48 * 1024)
        .await
        .unwrap();
    assert_eq!(page.entries.len(), 1);
    assert_eq!(page.entries[0].sequence, sequence);
    assert_eq!(
        page.entries[0].detail,
        DiagnosticDetail::SessionTitle {
            invocation: original,
            cause: TitleFailureCause::Preparation
        }
    );
    let attempts = log
        .model_attempts(
            maka_event_log::usage::Query {
                from: 0.0,
                to: f64::MAX,
                session_id: Some("session".into()),
                through: None,
            },
            0,
            32,
        )
        .await
        .unwrap();
    assert_eq!(attempts.total, 0);
    log.close().await.unwrap();
}
