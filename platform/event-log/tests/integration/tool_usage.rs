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

use maka_agent_facts::accounting::Activity;
use maka_agent_facts::accounting::ActivityKind;
use maka_agent_facts::accounting::ActivityStatus;
use maka_agent_facts::accounting::Selection;
use maka_agent_facts::accounting::ToolResult;
use maka_agent_facts::accounting::ToolStatus;
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::ToolOutcome;
use maka_agent_facts::tool_call::RejectionKind;
use maka_agent_facts::tool_call::ToolCallIdentity;
use maka_agent_facts::tool_call::ToolRejection;
use maka_event_log::EventLog;
use serde_json::json;
use std::time::{Duration, UNIX_EPOCH};

use crate::usage::fixture;
use fixture::{event, query, request};

#[tokio::test]
async fn tool_accounting_preserves_dispatch_truth_and_snapshot_without_private_bodies() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("usage.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("source", "source", &json!({}), 1)
        .await
        .unwrap();
    log.append(&event(
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content: "question".into(),
                source_messages: vec![],
                request_fingerprint: None,
            },
        },
        0,
    ))
    .await
    .unwrap();
    let private = "private-tool-data".repeat(4096);
    let refusal = event(
        Fact::ToolRejected {
            operation_id: "refusal".into(),
            call: ToolCallIdentity::standalone("refusal".into()),
            name: "Shell".into(),
            input: json!({"command": private}).into(),
            reason: ToolRejection::PolicyDenied {
                message: private.clone(),
            },
        },
        1250,
    );
    log.append(&refusal).await.unwrap();
    log.append(&event(
        Fact::ToolRejected {
            operation_id: "cancelled".into(),
            call: ToolCallIdentity::standalone("cancelled".into()),
            name: "Shell".into(),
            input: json!({}).into(),
            reason: ToolRejection::Cancelled,
        },
        1500,
    ))
    .await
    .unwrap();
    for (i, id) in ["success", "failed", "unknown", "lost"]
        .into_iter()
        .enumerate()
    {
        log.append(&event(
            Fact::ToolDispatched {
                presentation: None,
                title: None,
                operation_id: id.into(),
                call: ToolCallIdentity::standalone(id.into()),
                name: "Shell".into(),
                input: json!({"command": private}),
            },
            2000 + i as u64 * 1000,
        ))
        .await
        .unwrap();
    }
    let captured = log.tool_attempts(query(), 0, 100).await.unwrap();
    assert_eq!(
        captured.total, 2,
        "pending dispatches have no completed outcome"
    );
    let success = EventWrite::tool_success(
        "success-settled".into(),
        UNIX_EPOCH + Duration::from_micros(6250),
        refusal.event().invocation.clone(),
        "success".into(),
        json!({"output": private}).into(),
    )
    .unwrap()
    .0;
    log.append(&success).await.unwrap();
    for (id, outcome) in [
        (
            "failed",
            ToolOutcome::Failed {
                message: private.clone(),
            },
        ),
        (
            "unknown",
            ToolOutcome::Unknown {
                message: private.clone(),
                operation: None,
            },
        ),
    ] {
        log.append(&event(
            Fact::ToolSettled {
                operation_id: id.into(),
                outcome,
            },
            6500,
        ))
        .await
        .unwrap();
    }
    log.append_batch(&[
        request("model-step", 6000),
        event(
            Fact::ModelInterrupted {
                partial: None,
                model_failure: None,
                diagnostic: None,
                step_id: "model-step".into(),
                status: maka_agent_facts::event::ModelInterruption::RetryableFailure,
            },
            6500,
        ),
    ])
    .await
    .unwrap();
    // A cancellation of the enclosing invocation cannot relabel a failed tool.
    log.append(&event(
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Cancelled {
                source: "user".into(),
            },
        },
        7000,
    ))
    .await
    .unwrap();
    let mut fixed = query();
    fixed.through = Some(captured.through);
    assert_eq!(
        log.tool_attempts(fixed.clone(), 0, 100)
            .await
            .unwrap()
            .attempts,
        captured.attempts
    );
    let page = log.tool_attempts(query(), 0, 100).await.unwrap();
    assert_eq!(page.total, 6);
    let totals = log.usage_summary(query()).await.unwrap().summary.tools;
    assert_eq!(
        (
            totals.calls,
            totals.success,
            totals.error,
            totals.unknown,
            totals.rejected
        ),
        (6, 1, 1, 2, 2)
    );
    assert_eq!(
        totals.mean_latency_ms,
        Some(3.875),
        "refusals and unknown effects do not invent execution latency"
    );
    assert_eq!(totals.duration_ms, 7.75);
    let find = |id: &str| {
        page.attempts
            .iter()
            .find(|item| item.call.tool_call_id == id)
            .unwrap()
    };
    assert_eq!(
        find("refusal").result,
        ToolResult::Rejected {
            reason: RejectionKind::PolicyDenied
        }
    );
    assert_eq!(find("refusal").completed_at, 1.25);
    assert_eq!(find("refusal").latency_ms(), None);
    assert_eq!(
        find("cancelled").result,
        ToolResult::Rejected {
            reason: RejectionKind::Cancelled
        }
    );
    for (id, status) in [
        ("success", ToolStatus::Success),
        ("failed", ToolStatus::Error),
        ("unknown", ToolStatus::Unknown),
        ("lost", ToolStatus::Unknown),
    ] {
        assert!(
            matches!(find(id).result, ToolResult::Settled { outcome, .. } if outcome == status)
        );
    }
    assert_eq!(find("success").latency_ms(), Some(4.25));
    let bytes = serde_json::to_string(&page.attempts).unwrap();
    assert!(!bytes.contains("private-tool-data"));
    assert!(bytes.len() < 4096, "large bodies are not accounting fields");
    log.append(&refusal).await.unwrap();
    log.append(&success).await.unwrap();
    let all = log
        .usage_activity(query(), Selection::default(), 0, 100)
        .await
        .unwrap();
    assert_eq!(all.total, 7);
    // The model and two tool outcomes tie on completion time; admission sequence
    // provides one deterministic order across both kinds.
    assert!(
        matches!(&all.attempts[0], Activity::Tool(attempt) if attempt.call.tool_call_id == "lost")
    );
    assert!(matches!(&all.attempts[1], Activity::Model(attempt) if attempt.model_id == "model"));
    let mut second_query = query();
    second_query.through = Some(all.through);
    let first = log
        .usage_activity(second_query.clone(), Selection::default(), 0, 2)
        .await
        .unwrap();
    let rest = log
        .usage_activity(
            second_query,
            Selection::default(),
            first.next_offset.unwrap(),
            100,
        )
        .await
        .unwrap();
    assert_eq!([first.attempts, rest.attempts].concat(), all.attempts);
    let errors = log
        .usage_activity(
            query(),
            Selection {
                kind: Some(ActivityKind::Tool),
                status: Some(ActivityStatus::Error),
                search: "sHeLl".into(),
            },
            0,
            100,
        )
        .await
        .unwrap();
    assert_eq!(errors.total, 1);
    assert_eq!(
        errors.attempts,
        vec![Activity::Tool(find("failed").clone())]
    );
    let literal = log
        .usage_activity(
            query(),
            Selection {
                search: "%' OR 1=1 --".into(),
                ..Default::default()
            },
            0,
            100,
        )
        .await
        .unwrap();
    assert_eq!(
        literal.total, 0,
        "search is a bound literal, not SQL or LIKE syntax"
    );
    let complete_query = log
        .usage_activity(
            query(),
            Selection {
                search: "字".repeat(342),
                ..Default::default()
            },
            0,
            100,
        )
        .await
        .unwrap();
    assert_eq!(complete_query.through, literal.through);
    assert_eq!(complete_query.total, 0);
    assert!(
        complete_query.attempts.is_empty(),
        "the complete UTF-8 search is a valid literal with no match"
    );
    let old = log
        .usage_activity(fixed.clone(), Selection::default(), 0, 100)
        .await
        .unwrap();
    assert_eq!(
        old.attempts,
        captured
            .attempts
            .iter()
            .cloned()
            .map(Activity::Tool)
            .collect::<Vec<_>>()
    );
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    let revision = log
        .get_session::<serde_json::Value>("source")
        .await
        .unwrap()
        .unwrap()
        .revision;
    log.begin_session_removal("source", revision).await.unwrap();
    log.finish_session_retirement("source").await.unwrap();
    assert_eq!(
        log.collect_session_material(None).await.unwrap(),
        maka_event_log::sessions::MaterialCollection::Collected
    );
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    while log.collect_session_material(None).await.unwrap()
        == maka_event_log::sessions::MaterialCollection::Collected
    {}
    assert!(matches!(
        log.prefix(100, 1_000_000).await,
        Err(maka_event_log::StoreError::MaterialCollected)
    ));
    let inspect = rusqlite::Connection::open(&path).unwrap();
    let (bodies, payloads, leaked): (i64, i64, i64) = inspect
        .query_row(
            "SELECT (SELECT COUNT(*) FROM event_log WHERE event_json IS NOT NULL),
         (SELECT COUNT(*) FROM tool_result_payloads),
         (SELECT COUNT(*) FROM event_log WHERE retained_json LIKE '%private-tool-data%')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!((bodies, payloads, leaked), (0, 0, 0));
    assert_eq!(
        log.usage_summary(query()).await.unwrap().summary.tools,
        totals
    );
    assert_eq!(
        log.tool_attempts(query(), 0, 100).await.unwrap().attempts,
        page.attempts
    );
    assert_eq!(
        log.tool_attempts(fixed, 0, 100).await.unwrap().attempts,
        captured.attempts
    );
    log.close().await.unwrap();
}
