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

use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::event::ToolOutcome;

use maka_agent_facts::tool_call::ToolCallIdentity;
use maka_agent_facts::tool_call::ToolOrigin;
use maka_agent_facts::tool_call::ToolRejection;
use maka_event_log::EventLog;
use serde_json::json;

#[tokio::test]
async fn refusals_have_no_dispatch_or_uncertainty_and_cannot_alias_effects() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let invocation = Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    let event = |fact| RuntimeEvent::new(invocation.clone(), fact);
    let rejected = |operation: &str, id: &str, origin, reason| {
        event(Fact::ToolRejected {
            operation_id: operation.into(),
            call: ToolCallIdentity {
                tool_call_id: id.into(),
                origin,
            },
            name: "tool".into(),
            input: json!({}).into(),
            reason,
        })
    };
    let dispatch = |operation: &str, id: &str| {
        event(Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: operation.into(),
            call: ToolCallIdentity::standalone(id.into()),
            name: "tool".into(),
            input: json!({}),
        })
    };
    log.append(
        &EventWrite::plain(
            (event(Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    source_messages: Vec::new(),
                    content: "hello".into(),
                    request_fingerprint: None,
                },
            }))
            .clone(),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    let mut refusals = Vec::new();
    for (index, reason) in [
        ToolRejection::Unavailable,
        ToolRejection::InvalidInput {
            message: "bad schema".into(),
        },
        ToolRejection::PolicyDenied {
            message: "not permitted".into(),
        },
        ToolRejection::ExclusiveConflict,
        ToolRejection::Cancelled,
    ]
    .into_iter()
    .enumerate()
    {
        let id = format!("rejected-{index}");
        let refusal = rejected(&id, &id, ToolOrigin::Standalone, reason);
        let encoded = serde_json::to_string(&refusal).unwrap();
        assert_eq!(
            serde_json::from_str::<RuntimeEvent>(&encoded).unwrap(),
            refusal
        );
        log.append(&EventWrite::plain((refusal).clone()).unwrap())
            .await
            .unwrap();
        for collision in [
            dispatch(&id, "different-call"),
            dispatch("different-operation", &id),
        ] {
            assert!(
                log.append(&EventWrite::plain((collision).clone()).unwrap())
                    .await
                    .is_err()
            );
        }
        assert!(
            log.append(
                &EventWrite::plain(
                    (event(Fact::ToolSettled {
                        operation_id: id,
                        outcome: ToolOutcome::Failed {
                            message: "must not invent T2".into()
                        },
                    }))
                    .clone()
                )
                .unwrap()
            )
            .await
            .is_err()
        );
        refusals.push(refusal);
    }
    assert!(
        log.invocation_recovery(&invocation)
            .await
            .unwrap()
            .uncertain_operations
            .is_empty()
    );
    let parent = dispatch("parent", "parent-call");
    let nested = |parent_id: &str| ToolOrigin::CodeMode {
        parent_operation_id: parent_id.into(),
        parent_tool_call_id: "parent-call".into(),
    };
    let child = rejected(
        "child",
        "child-call",
        nested("parent"),
        ToolRejection::PolicyDenied {
            message: "denied".into(),
        },
    );
    assert!(
        log.append(&EventWrite::plain((child).clone()).unwrap())
            .await
            .is_err()
    );
    // Rejection shares provenance validation and sees earlier batch facts.
    log.append_batch(
        &([parent, child.clone()])
            .iter()
            .cloned()
            .map(EventWrite::plain)
            .collect::<Result<Vec<_>, _>>()
            .unwrap(),
    )
    .await
    .unwrap();
    for collision in [
        rejected(
            "parent",
            "different",
            ToolOrigin::Standalone,
            ToolRejection::Unavailable,
        ),
        rejected(
            "different",
            "parent-call",
            ToolOrigin::Standalone,
            ToolRejection::Unavailable,
        ),
        rejected(
            "different",
            "child-call",
            nested("parent"),
            ToolRejection::Unavailable,
        ),
    ] {
        assert!(
            log.append(&EventWrite::plain((collision).clone()).unwrap())
                .await
                .is_err()
        );
    }
    log.append(
        &EventWrite::tool_success(
            "parent-outcome".into(),
            std::time::SystemTime::now(),
            invocation.clone(),
            "parent".into(),
            json!(null).into(),
        )
        .unwrap()
        .0,
    )
    .await
    .unwrap();
    assert!(
        log.append(
            &EventWrite::plain(
                (rejected("late", "late", nested("parent"), ToolRejection::Cancelled)).clone()
            )
            .unwrap()
        )
        .await
        .is_err()
    );
    refusals.push(child);
    let prefix = log.prefix(100, 100_000).await.unwrap();
    assert!(
        prefix
            .project_invocation("invocation")
            .uncertain_operations
            .is_empty()
    );
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    let commits = log.subscribe_commits();
    log.append_batch(
        &(refusals)
            .iter()
            .cloned()
            .map(EventWrite::plain)
            .collect::<Result<Vec<_>, _>>()
            .unwrap(),
    )
    .await
    .unwrap();
    assert!(!commits.has_changed().unwrap());
    assert_eq!(
        log.prefix(100, 100_000).await.unwrap().digest,
        prefix.digest
    );
    log.close().await.unwrap();
}
