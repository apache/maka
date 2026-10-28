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

use maka_agent_facts::language::Language;

use maka_agent_facts::event::LogPrefix;
use maka_model::prompt::Message;

use crate::RunError;
mod chat;
mod compatible;
mod images;
mod output;
mod prepared;
pub(super) use prepared::{PreparedHistory, capture as prepare_view};
mod user;

mod references;
mod resources;
mod semantic;
pub(super) use semantic::render as render_semantic_group;

/// Only committed semantic facts produce provider input. No UI transcript or
/// previous isolate state is read, including after process restart.
pub fn project(
    prefix: &LogPrefix,
    session: &str,
    language: Language,
) -> Result<Vec<Message>, RunError> {
    if !matches!(prefix.scope, maka_agent_facts::event::LogScope::Root)
        && prefix
            .events
            .iter()
            .any(|e| e.event.invocation.session_id != session)
    {
        return Err(RunError::ReconciliationRequired(
            "inherited history requires a checked effective context source".into(),
        ));
    }
    if prefix.events.iter().any(|stored| {
        matches!(
            stored.event.fact,
            maka_agent_facts::event::Fact::ToolResultArchived { .. }
        )
    }) {
        return Err(RunError::ReconciliationRequired(
            "archived history requires a checked effective context source".into(),
        ));
    }
    use maka_agent_facts::history::semantic::{
        FragmentSource, Frontier, PartPayload, Payload, ResolvedRow, SemanticKind, reduce,
    };
    use std::collections::{BTreeMap, HashMap};
    let mut frontiers: HashMap<&str, Frontier> = HashMap::new();
    let mut rows = BTreeMap::new();
    let mut fragments = BTreeMap::new();
    for stored in prefix
        .events
        .iter()
        .filter(|event| event.event.invocation.session_id == session)
    {
        let frontier = frontiers
            .entry(&stored.event.invocation.invocation_id)
            .or_default();
        let transition = reduce(frontier, stored)
            .map_err(|error| RunError::ReconciliationRequired(error.into()))?;
        for fragment in transition.fragments {
            let payload = match fragment.source {
                FragmentSource::Payload(payload) => *payload,
                FragmentSource::CanonicalToolProjection => {
                    let maka_agent_facts::event::Fact::ToolSettled {
                        outcome:
                            maka_agent_facts::event::ToolOutcome::Succeeded {
                                model_projection, ..
                            },
                        ..
                    } = &stored.event.fact
                    else {
                        return Err(RunError::ReconciliationRequired(
                            "canonical projection marker lacks a successful tool source".into(),
                        ));
                    };
                    Payload::Tool(model_projection.clone())
                }
            };
            fragments.insert(fragment.key, (fragment.part, payload));
        }
        for row in transition.rows {
            rows.insert(row.id, row);
        }
    }
    if frontiers
        .values()
        .any(|frontier| !frontier.calls.is_empty())
    {
        return Err(RunError::ReconciliationRequired(
            "model tool calls have no committed outcome".into(),
        ));
    }
    let mut rows: Vec<_> = rows.into_values().collect();
    rows.sort_by_key(|row| (row.order, row.id));
    let mut has_user = false;
    let mut resolved = Vec::new();
    for row in rows {
        let key = match &row.kind {
            SemanticKind::User { payload, .. } | SemanticKind::ImportedUser { payload } => {
                has_user = true;
                Some(*payload)
            }
            SemanticKind::ImportedAssistant { .. } if !has_user => continue,
            SemanticKind::ImportedAssistant { payload }
            | SemanticKind::ExecutorText { payload }
            | SemanticKind::ToolResult { payload, .. }
            | SemanticKind::Notification { payload, .. } => Some(*payload),
            SemanticKind::AssistantPart {
                payload: PartPayload::Complete(key),
                ..
            } => Some(*key),
            _ => None,
        };
        let payload = if let Some(key) = key {
            Some(
                fragments
                    .get(&key)
                    .ok_or_else(|| {
                        RunError::ReconciliationRequired("semantic payload missing".into())
                    })?
                    .1
                    .clone(),
            )
        } else if let SemanticKind::AssistantPart {
            payload:
                PartPayload::Text {
                    part,
                    end,
                    text_kind,
                },
            ..
        } = &row.kind
        {
            let mut text = String::new();
            let mut options = None;
            for (_, (_, payload)) in fragments.iter().filter(|(key, (fragment_part, _))| {
                *fragment_part == *part && key.source_sequence <= *end
            }) {
                let Payload::TextDelta {
                    text: delta,
                    provider_options,
                } = payload
                else {
                    return Err(RunError::ReconciliationRequired(
                        "invalid text fragment".into(),
                    ));
                };
                text.push_str(delta);
                maka_agent_facts::model::merge_provider_options(
                    &mut options,
                    provider_options.clone(),
                );
            }
            Some(Payload::Part(maka_agent_facts::model::ModelPart::Text {
                text_kind: *text_kind,
                text,
                provider_options: options,
            }))
        } else {
            None
        };
        resolved.push(ResolvedRow { row, payload });
    }
    semantic::project(&resolved, session, language)
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::event::Fact;
    use maka_agent_facts::event::Invocation;
    use maka_agent_facts::event::LogScope;
    use maka_agent_facts::event::RuntimeEvent;
    use maka_agent_facts::event::StoredEvent;
    use maka_agent_facts::input::InvocationInput;
    use maka_agent_facts::tool_call::ToolCallIdentity;
    use maka_agent_facts::tool_call::ToolOrigin;
    use maka_agent_facts::tool_call::ToolRejection;
    use serde_json::json;
    #[test]
    fn rejection_closes_only_its_proven_provider_call_as_error_text() {
        let invocation: Invocation = serde_json::from_value(json!({
            "session_id":"session","turn_id":"turn","run_id":"run","invocation_id":"invocation"
        }))
        .unwrap();
        let provider =
            |step: &str, call: &str| ToolCallIdentity::provider(step.into(), call.into());
        let rejected = |operation: &str, call| Fact::ToolRejected {
            operation_id: operation.into(),
            call,
            name: "exec".into(),
            input: json!({"code":"return 1"}).into(),
            reason: ToolRejection::ExclusiveConflict,
        };
        let facts = [
            Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    source_messages: Vec::new(),
                    content: "hello".into(),
                    request_fingerprint: None,
                },
            },
            Fact::ModelRequested {
                item_acceptance: false,
                effective_source_digest: None,
                purpose: maka_agent_facts::context::ModelPurpose::Main,
                context: None, context_breakdown: None,
                checkpoint_event_id: None,
                step_id: "step".into(),
                model_id: "test".into(),
                source_scope: LogScope::Root,
                source_high_water: 1,
                source_digest: "fixture".into(),
                input_digest: "fixture".into(),
                route_identity: "fixture".into(),
            },
            Fact::ModelCompleted {
                step_id: "step".into(),
                output: serde_json::from_value(json!({
                    "parts":[{"kind":"tool_call","call":{
                        "id":"call","name":"exec","input":{"kind":"json","data":{"code":"return 1"}},
                        "provider_executed":false
                    }}],
                    "finish_reason":"tool-calls","usage":{}
                }))
                .unwrap(),
            },
            rejected("hidden", ToolCallIdentity::standalone("hidden".into())),
            rejected(
                "nested",
                ToolCallIdentity {
                    tool_call_id: "nested".into(),
                    origin: ToolOrigin::CodeMode {
                        parent_operation_id: "parent".into(),
                        parent_tool_call_id: "parent-call".into(),
                    },
                },
            ),
            rejected("step:call", provider("step", "call")),
        ];
        let mut prefix = LogPrefix {
            scope: LogScope::Root,
            high_water: facts.len() as u64,
            digest: "test".into(),
            events: facts
                .into_iter()
                .enumerate()
                .map(|(index, fact)| StoredEvent {
                    sequence: index as u64 + 1,
                    event: RuntimeEvent::new(invocation.clone(), fact),
                })
                .collect(),
        };
        let history = project(&prefix, "session", Language::En).unwrap();
        assert_eq!(history.len(), 3);
        assert_eq!(
            serde_json::to_value(&history[2]).unwrap(),
            json!({"role":"tool","content":[{
                "type":"tool-result","toolCallId":"call","toolName":"exec",
                "output":{"type":"error-text","value":"tool conflicts with exclusive step execution"}
            }]})
        );
        for stored in &mut prefix.events {
            stored.event =
                serde_json::from_value(serde_json::to_value(&stored.event).unwrap()).unwrap();
        }
        assert_eq!(project(&prefix, "session", Language::En).unwrap(), history);
        let valid = prefix.events.last().unwrap().event.fact.clone();
        for invalid in [
            rejected("step:call", ToolCallIdentity::standalone("call".into())),
            rejected("step:call", provider("other", "call")),
            rejected("step:call", provider("step", "wrong-call")),
        ] {
            prefix.events.last_mut().unwrap().event.fact = invalid;
            assert!(project(&prefix, "session", Language::En).is_err());
        }
        prefix.events.last_mut().unwrap().event.fact = valid;
        prefix.events.insert(
            4,
            StoredEvent {
                sequence: 5,
                event: RuntimeEvent::new(
                    invocation,
                    Fact::ToolDispatched {
                        presentation: None,
                        title: None,
                        operation_id: "step:call".into(),
                        call: provider("step", "call"),
                        name: "exec".into(),
                        input: json!({"code":"return 1"}),
                    },
                ),
            },
        );
        assert!(project(&prefix, "session", Language::En).is_err());
    }
}
