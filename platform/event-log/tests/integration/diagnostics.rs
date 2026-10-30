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
    diagnostics::{DiagnosticDetail, TitleFailureCause},
    event::{EventWrite, Fact, Invocation, InvocationOutcome, RuntimeEvent},
    execution::*,
    input::InvocationInput,
    model::error::ModelFailureCause,
};
use maka_event_log::{EventLog, StoreError};
use serde_json::json;

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
