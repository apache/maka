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
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::StoredEvent;
use maka_agent_facts::event::ToolOutcome;
use maka_agent_facts::tool_call::HostSdkParent;
use maka_agent_facts::tool_call::ToolCallIdentity;
use maka_agent_facts::tool_call::ToolOrigin;
use maka_agent_facts::tool_call::ToolRejection;
use maka_presentation::{InvocationView, tool_message_id};
use serde_json::{Value, json};
mod fixtures;
use fixtures::{opening, step, stored};
mod payloads;

#[test]
fn malformed_arguments_display_exact_raw_and_cannot_alias_a_parsed_dispatch() {
    use maka_agent_facts::model::recorded::CompletionPart;
    use maka_agent_facts::model::{ModelPart, ToolInput};
    let raw = "  {\"code\":\n";
    let input = ToolInput::from_json(raw.into());
    let mut facts = vec![opening()];
    step(&mut facts, "step", false, false);
    for fact in &mut facts {
        if let Fact::ModelCompleted { output, .. } = fact {
            for part in &mut output.parts {
                if let CompletionPart::Own(record) = part
                    && let ModelPart::ToolCall { call } = std::sync::Arc::make_mut(&mut record.part)
                {
                    call.input = input.clone();
                }
            }
        }
    }
    let mut forged = facts.clone();
    forged.push(Fact::ToolDispatched {
        operation_id: "step:raw".into(),
        call: ToolCallIdentity::provider("step".into(), "raw".into()),
        name: "exec".into(),
        input: json!({}),
        title: None,
        presentation: None,
    });
    let mut view = InvocationView::new();
    let events = stored(forged);
    for event in &events[..events.len() - 1] {
        view.push(event).unwrap();
    }
    assert!(view.push(events.last().unwrap()).is_err());

    facts.push(Fact::ToolRejected {
        operation_id: "step:raw".into(),
        call: ToolCallIdentity::provider("step".into(), "raw".into()),
        name: "exec".into(),
        input,
        reason: ToolRejection::InvalidInput {
            message: "arguments are not valid JSON".into(),
        },
    });
    let mut view = InvocationView::new();
    let rows: Vec<_> = stored(facts)
        .iter()
        .flat_map(|event| view.push(event).unwrap())
        .collect();
    let calls: Vec<_> = rows
        .iter()
        .filter_map(|row| match &row.message.content {
            maka_presentation::Content::ToolCall { args, .. } => Some(args),
            _ => None,
        })
        .collect();
    assert_eq!(calls, [&json!(raw)]);
    assert!(rows.iter().any(|row| matches!(&row.message.content,
        maka_presentation::Content::ToolResult { is_error: true, content: maka_presentation::ToolContent::Text { text }, .. }
        if text == "invalid tool input: arguments are not valid JSON")));
}

#[test]
fn accepted_tools_replay_with_distinct_ids_parentage_rejections() {
    let mut facts = vec![opening()];
    step(&mut facts, "first", true, false);
    facts.push(Fact::ToolDispatched {
        presentation: None,
        title: Some(maka_agent_facts::display::Text::plain(
            "Inspect application",
        )),
        operation_id: "first:raw".into(),
        call: ToolCallIdentity::provider("first".into(), "raw".into()),
        name: "exec".into(),
        input: json!({"code":"Read()"}),
    });
    facts.push(Fact::ToolDispatched {
        presentation: None,
        title: None,
        operation_id: "child".into(),
        call: ToolCallIdentity {
            tool_call_id: "nested".into(),
            origin: ToolOrigin::CodeMode {
                parent_operation_id: "first:raw".into(),
                parent_tool_call_id: "raw".into(),
            },
        },
        name: "Read".into(),
        input: json!({"path":"file"}),
    });
    facts.push(Fact::ToolSettled {
        operation_id: "child".into(),
        outcome: success(&json!({"content":"file text"}).into()),
    });
    facts.push(Fact::ToolSettled {
        operation_id: "first:raw".into(),
        outcome: success(&json!({"status":"completed"}).into()),
    });
    step(&mut facts, "second", false, false);
    facts.push(Fact::ToolRejected {
        operation_id: "second:raw".into(),
        call: ToolCallIdentity::provider("second".into(), "raw".into()),
        name: "exec".into(),
        input: json!({"code":"Read()"}).into(),
        reason: ToolRejection::Unavailable,
    });
    step(&mut facts, "native", false, true);
    step(&mut facts, "unknown", false, false);
    facts.push(Fact::ToolDispatched {
        presentation: None,
        title: None,
        operation_id: "unknown:raw".into(),
        call: ToolCallIdentity::provider("unknown".into(), "raw".into()),
        name: "exec".into(),
        input: json!({"code":"Read()"}),
    });
    facts.push(Fact::InvocationEnded {
        outcome: InvocationOutcome::Failed {
            model_failure: None,
            class: "unknown_outcome".into(),
            message: None,
        },
    });
    let events = stored(facts);
    let mut view = InvocationView::new();
    let mut replay = InvocationView::new();
    let mut rows = Vec::new();
    for stored in &events {
        let raw = match &stored.event.fact {
            Fact::ToolSettled {
                operation_id,
                outcome: ToolOutcome::Succeeded { .. },
            } => Some(
                if operation_id == "child" {
                    json!({"content":"file text"})
                } else {
                    json!({"status":"completed"})
                }
                .into(),
            ),
            _ => None,
        };
        let next = view.push_with_tool_output(stored, raw.as_ref()).unwrap();
        if matches!(
            stored.event.fact,
            Fact::ToolDispatched { .. } | Fact::ToolRejected { .. } | Fact::ToolSettled { .. }
        ) {
            let dispatch = match &stored.event.fact {
                Fact::ToolSettled { operation_id, .. } => events.iter().find_map(|prior| {
                    (prior.sequence < stored.sequence && matches!(&prior.event.fact,
                        Fact::ToolDispatched { operation_id: original, .. } if original == operation_id)).then_some(&prior.event)
                }),
                _ => None,
            };
            assert_eq!(
                next,
                maka_presentation::project_tool_boundary(stored, dispatch, raw.as_ref()).unwrap(),
                "one boundary has the same rows as the full invocation reducer"
            );
        }
        let roundtrip = StoredEvent {
            sequence: stored.sequence,
            event: serde_json::from_value(serde_json::to_value(&stored.event).unwrap()).unwrap(),
        };
        assert_eq!(
            next,
            replay
                .push_with_tool_output(&roundtrip, raw.as_ref())
                .unwrap()
        );
        if matches!(stored.event.fact, Fact::ModelObserved { .. }) {
            assert!(next.is_empty());
            assert!(
                view.overlay()
                    .iter()
                    .all(|message| serde_json::to_value(message).unwrap()["type"] == "assistant")
            );
        }
        rows.extend(next);
    }
    assert!(
        rows.windows(2)
            .all(|pair| pair[0].position < pair[1].position)
    );
    let messages: Vec<Value> = rows
        .iter()
        .map(|row| serde_json::to_value(&row.message).unwrap())
        .collect();
    let activity = messages
        .iter()
        .find(|row| row["type"] == "tool_activity")
        .unwrap();
    assert_eq!(activity["title"]["fallback"], "Inspect application");
    assert_eq!(
        activity["toolUseId"],
        tool_message_id("invocation", "first:raw")
    );
    let calls: Vec<_> = messages
        .iter()
        .filter(|message| message["type"] == "tool_call")
        .collect();
    assert_eq!(
        calls.len(),
        5,
        "dispatch never duplicates the accepted call"
    );
    assert_eq!(calls[0]["id"], tool_message_id("invocation", "first:raw"));
    assert_eq!(
        calls[0]["stepId"],
        messages
            .iter()
            .find(|row| row["type"] == "assistant")
            .unwrap()["id"]
    );
    assert_eq!(calls[0]["modelVisibility"], "visible");
    assert_eq!(calls[1]["parentToolCallId"], calls[0]["id"]);
    assert_eq!(calls[1]["parentOperationId"], "first:raw");
    assert_eq!(calls[1]["modelVisibility"], "hidden");
    assert_ne!(calls[0]["id"], calls[2]["id"]);
    assert!(
        calls[2].get("stepId").is_none(),
        "pure tool step has no empty assistant anchor"
    );
    let results: Vec<_> = messages
        .iter()
        .filter(|message| message["type"] == "tool_result")
        .collect();
    assert_eq!(results.len(), 4, "unknown outcome produces no result");
    assert_eq!(
        messages
            .iter()
            .filter(|row| row["type"] == "tool_activity")
            .count(),
        3,
        "each original dispatch is visible even without display metadata; rejection is not dispatch"
    );
    assert_eq!(results[0]["settlement"], "returned");
    assert_eq!(results[1]["settlement"], "returned");
    assert_eq!(results[2]["settlement"], "rejected");
    assert!(
        results[3].get("settlement").is_none(),
        "provider result is not a Host settlement"
    );

    assert_eq!(results[0]["toolUseId"], calls[1]["id"]);
    assert_eq!(
        results[0]["content"],
        json!({"kind":"json","value":{"content":"file text"}})
    );
    assert_eq!(results[2]["toolUseId"], calls[2]["id"]);
    assert_eq!(results[2]["isError"], true);
    assert_eq!(results[2]["content"]["kind"], "text");
    for result in &results[..3] {
        let fact = events
            .iter()
            .find(|stored| stored.event.id == result["id"])
            .unwrap();
        assert_eq!(result["ts"], 999 + fact.sequence);
    }
    assert_eq!(results[3]["toolUseId"], calls[3]["id"]);
    assert_eq!(results[3]["id"], "native:part:1");
}

fn success(output: &maka_agent_facts::tool_output::ToolOutput) -> ToolOutcome {
    let template = stored(vec![opening()]).remove(0).event;
    let write = EventWrite::tool_success(
        template.id,
        template.recorded_at,
        template.invocation,
        "operation".into(),
        output.clone().into(),
    )
    .unwrap()
    .0;
    match &write.event().fact {
        Fact::ToolSettled { outcome, .. } => outcome.clone(),
        _ => unreachable!(),
    }
}

#[test]
fn direct_tool_projection_preserves_hidden_failures_and_large_raw_results() {
    use maka_agent_facts::tool_output::ToolOutput;
    for origin in [
        ToolOrigin::CodeMode {
            parent_operation_id: "first:raw".into(),
            parent_tool_call_id: "raw".into(),
        },
        ToolOrigin::CodeCell {
            parent_operation_id: "first:raw".into(),
            parent_tool_call_id: "raw".into(),
        },
        ToolOrigin::HostSdk {
            package_id: "package".into(),
            entry_id: "entry".into(),
            activation: "activation".into(),
            parent: Some(HostSdkParent::NestedEffect {
                operation_id: "first:raw".into(),
            }),
        },
        ToolOrigin::HostSdk {
            package_id: "package".into(),
            entry_id: "entry".into(),
            activation: "activation".into(),
            parent: Some(HostSdkParent::EvaluationObserver {
                operation_id: "first:raw".into(),
                epoch: "evaluation".into(),
            }),
        },
        ToolOrigin::HostSdk {
            package_id: "package".into(),
            entry_id: "entry".into(),
            activation: "activation".into(),
            parent: None,
        },
    ] {
        for mode in ["returned", "failed", "unknown", "rejected"] {
            let raw = ToolOutput::Text("中🙂".repeat(64 * 1024));
            let mut facts = vec![opening()];
            step(&mut facts, "first", false, false);
            facts.push(Fact::ToolDispatched {
                presentation: None,
                title: None,
                operation_id: "first:raw".into(),
                call: ToolCallIdentity::provider("first".into(), "raw".into()),
                name: "exec".into(),
                input: json!({"code":"Read()"}),
            });
            let identity = ToolCallIdentity {
                tool_call_id: "child:opaque/🙂".into(),
                origin: origin.clone(),
            };
            if mode == "rejected" {
                facts.push(Fact::ToolRejected {
                    operation_id: "operation:opaque/🙂".into(),
                    call: identity,
                    name: "Read".into(),
                    input: json!({"path":"file"}).into(),
                    reason: ToolRejection::Unavailable,
                });
            } else {
                facts.push(Fact::ToolDispatched {
                    presentation: Some("file.read".into()),
                    title: Some(maka_agent_facts::display::Text::plain("Read file")),
                    operation_id: "operation:opaque/🙂".into(),
                    call: identity,
                    name: "Read".into(),
                    input: json!({"path":"file"}),
                });
                facts.push(Fact::ToolSettled {
                    operation_id: "operation:opaque/🙂".into(),
                    outcome: match mode {
                        "returned" => success(&raw),
                        "failed" => ToolOutcome::Failed {
                            message: "read failed".into(),
                        },
                        _ => ToolOutcome::Unknown {
                            message: "outcome unknown".into(),
                            operation: None,
                        },
                    },
                });
            }
            let events = stored(facts);
            let mut view = InvocationView::new();
            for stored in &events {
                let resolved = matches!(
                    stored.event.fact,
                    Fact::ToolSettled {
                        outcome: ToolOutcome::Succeeded { .. },
                        ..
                    }
                )
                .then_some(&raw);
                let expected = view.push_with_tool_output(stored, resolved).unwrap();
                if matches!(
                    stored.event.fact,
                    Fact::ToolDispatched { .. }
                        | Fact::ToolRejected { .. }
                        | Fact::ToolSettled { .. }
                ) {
                    let dispatch = match &stored.event.fact {
                        Fact::ToolSettled { operation_id, .. } => events.iter().find_map(|prior| {
                            (prior.sequence < stored.sequence && matches!(&prior.event.fact,
                                Fact::ToolDispatched { operation_id: original, .. } if original == operation_id)).then_some(&prior.event)
                        }),
                        _ => None,
                    };
                    assert_eq!(
                        maka_presentation::project_tool_boundary(stored, dispatch, resolved)
                            .unwrap(),
                        expected,
                        "origin {origin:?}, outcome {mode}"
                    );
                }
            }
        }
    }
}
