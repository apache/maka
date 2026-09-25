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

use super::EventRef;
use crate::RunError;
use maka_runtime::{
    event::{Fact, StoredEvent},
    input::InvocationInput,
    model::{ModelPart, TextKind},
    tool_call::ToolOrigin,
};
use std::collections::{HashMap, HashSet};

/// Admission supplies the authenticated Session base, never a shortened log cut.
#[derive(Clone, Copy)]
pub(crate) struct Replay<'a> {
    pub base: u64,
    pub current: &'a str,
    pub route: &'a str,
    pub model: &'a str,
}

pub(super) struct Cuts<'a> {
    policy: Replay<'a>,
    stable: HashMap<&'a str, (u64, usize)>,
    routes: HashMap<(&'a str, &'a str), (&'a str, &'a str)>,
}

impl<'a> Cuts<'a> {
    pub fn new(events: impl Iterator<Item = EventRef<'a>> + Clone, policy: Replay<'a>) -> Self {
        let provider_operations: HashSet<_> = events
            .clone()
            .filter_map(EventRef::canonical)
            .filter_map(|stored| match &stored.event.fact {
                Fact::ToolDispatched {
                    operation_id, call, ..
                } if matches!(call.origin, ToolOrigin::Provider { .. }) => {
                    Some(operation_id.as_str())
                }
                _ => None,
            })
            .collect();
        let mut result = Self {
            policy,
            stable: HashMap::new(),
            routes: HashMap::new(),
        };
        for event in events {
            let (sequence, invocation) = match event {
                EventRef::Canonical(stored) => (stored.sequence, &stored.event.invocation),
                EventRef::Archived(archived) => (archived.sequence, &archived.invocation),
            };
            let inherited = sequence > policy.base && invocation.invocation_id != policy.current;
            if inherited {
                result.stable.entry(&invocation.invocation_id).or_default();
            }
            let cut = match event {
                EventRef::Archived(_) => Some(usize::MAX),
                EventRef::Canonical(stored) => match &stored.event.fact {
                    Fact::InvocationOpened {
                        input: InvocationInput::Message { .. },
                        ..
                    }
                    | Fact::MessageSteered { .. }
                    | Fact::ToolNotified { .. } => Some(usize::MAX),
                    Fact::ToolRejected { call, .. }
                        if matches!(call.origin, ToolOrigin::Provider { .. }) =>
                    {
                        Some(usize::MAX)
                    }
                    Fact::ToolSettled { operation_id, .. }
                        if provider_operations.contains(operation_id.as_str()) =>
                    {
                        Some(usize::MAX)
                    }
                    Fact::ModelCompleted { output, .. } => output
                        .parts
                        .iter()
                        .rposition(|part| matches!(part, ModelPart::ToolResult { .. }))
                        .map(|index| index + 1),
                    Fact::ModelRequested {
                        step_id,
                        model_id,
                        route_identity,
                        ..
                    } => {
                        result.routes.insert(
                            (&invocation.invocation_id, step_id),
                            (model_id, route_identity),
                        );
                        None
                    }
                    _ => None,
                },
            };
            if inherited && let Some(part) = cut {
                result
                    .stable
                    .insert(&invocation.invocation_id, (sequence, part));
            }
        }
        result
    }

    /// Call pairing is still validated against all facts by the history builder;
    /// this gate controls only the emitted model parts, including event-internal cuts.
    pub fn allows(
        &self,
        stored: &StoredEvent,
        step: &str,
        index: usize,
        part: &ModelPart,
    ) -> Result<bool, RunError> {
        if stored.sequence > self.policy.base
            && stored.event.invocation.invocation_id != self.policy.current
        {
            let cut = self
                .stable
                .get(stored.event.invocation.invocation_id.as_str())
                .copied()
                .unwrap_or_default();
            if (stored.sequence, index) >= cut {
                return Ok(false);
            }
        }
        if matches!(
            part,
            ModelPart::Text {
                text_kind: TextKind::Thinking,
                ..
            }
        ) && self
            .routes
            .get(&(stored.event.invocation.invocation_id.as_str(), step))
            .copied()
            != Some((self.policy.model, self.policy.route))
        {
            return Err(RunError::ReconciliationRequired(
                "continuation reasoning belongs to another provider route or model".into(),
            ));
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_runtime::event::{Invocation, RuntimeEvent};
    use serde_json::json;

    #[test]
    fn cuts_preserve_event_internal_tool_results_and_do_not_trim_base_or_current_run() {
        let invocation = Invocation {
            session_id: "session".into(),
            turn_id: "source".into(),
            run_id: "source".into(),
            invocation_id: "source".into(),
        };
        let events: Vec<_> = [
            Fact::InvocationOpened { configuration: None, input: InvocationInput::Message {
                content: "question".into(), request_fingerprint: None, source_messages: Vec::new(),             }},
            Fact::ModelRequested { step_id: "step".into(), model_id: "old".into(), route_identity: "old".into(),
                purpose: maka_runtime::context::ModelPurpose::Main, context: None, source_scope: maka_runtime::event::LogScope::Root, source_high_water: 1,
                source_digest: "fixture".into(), input_digest: "fixture".into(), checkpoint_event_id: None, effective_source_digest: None },
            Fact::ModelCompleted { step_id: "step".into(), output: serde_json::from_value(json!({
                "parts":[
                    {"kind":"tool_result","id":"remote","name":"search","output":{},"is_error":false,"provider_options":null},
                    {"kind":"text","text_kind":"text","text":"trailing text","provider_options":null},
                    {"kind":"text","text_kind":"thinking","text":"old reasoning","provider_options":{"signature":"old"}}
                ], "finish_reason":"stop","usage":{}
            })).unwrap() },
        ].into_iter().enumerate().map(|(i, fact)| StoredEvent {
            sequence: i as u64 + 1, event: RuntimeEvent::new(invocation.clone(), fact),
        }).collect();
        let policy = Replay {
            base: 0,
            current: "child",
            route: "new",
            model: "new",
        };
        let Fact::ModelCompleted { output, .. } = &events[2].event.fact else {
            unreachable!()
        };
        let cuts = Cuts::new(events.iter().map(EventRef::Canonical), policy);
        for (index, expected) in [true, false, false].into_iter().enumerate() {
            assert_eq!(
                cuts.allows(&events[2], "step", index, &output.parts[index])
                    .unwrap(),
                expected
            );
        }
        for policy in [
            Replay { base: 3, ..policy },
            Replay {
                current: "source",
                ..policy
            },
        ] {
            let cuts = Cuts::new(events.iter().map(EventRef::Canonical), policy);
            assert!(
                cuts.allows(&events[2], "step", 1, &output.parts[1])
                    .unwrap()
            );
            assert!(
                cuts.allows(&events[2], "step", 2, &output.parts[2])
                    .is_err(),
                "retained reasoning cannot cross provider identity"
            );
        }
        let archived = maka_event_log::context::ArchivedToolResult {
            sequence: 4,
            event_id: "archive".into(),
            invocation,
            operation_id: "local-call".into(),
            replacement: maka_runtime::tool_output::DurableToolProjection::Json {
                value: json!({"page":"retained"}),
            },
            is_error: false,
        };
        let cuts = Cuts::new(
            events
                .iter()
                .map(EventRef::Canonical)
                .chain(std::iter::once(EventRef::Archived(&archived))),
            policy,
        );
        assert!(
            cuts.allows(&events[2], "step", 1, &output.parts[1])
                .unwrap(),
            "a later archived tool result is a stable boundary, not an omitted effect"
        );
        assert!(
            cuts.allows(&events[2], "step", 2, &output.parts[2])
                .is_err()
        );
    }
}
