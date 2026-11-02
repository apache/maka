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

use super::*;

pub(crate) fn opening(id: &str, claim: Option<ContinuationClaim>) -> RuntimeEvent {
    RuntimeEvent::new(
        Invocation {
            session_id: "session".into(),
            turn_id: id.into(),
            run_id: id.into(),
            invocation_id: id.into(),
        },
        Fact::InvocationOpened {
            configuration: Some(Box::new(InvocationConfiguration {
                language: maka_agent_facts::language::Language::En,
                compaction_prompt: None,
                workspace_origin: maka_agent_facts::execution::WorkspaceOrigin::Selected,
                approval_policy: maka_agent_facts::execution::ApprovalPolicy::OnRequest,
                boundary_revision: 0,
                system_prompt: None,
                editing_tools: None,
                tool_discovery: false,
                tool_composition: None,
                cwd: ".".into(),
                workspace_binding: None,
                workspace_identity: Some(
                    WorkspaceIdentity::from_marker_id("ef751105-55b5-4d65-a364-646281586a17")
                        .unwrap(),
                ),
                sandbox_mode: SandboxMode::ReadOnly,
                collaboration_mode: CollaborationMode::Agent,
                orchestration_mode: BehaviorId::default(),
                tool_mode: ToolMode::Direct,
                code_language: Default::default(),
                model: None,
                thinking_level: None,
            })),
            input: match claim {
                Some(claim) => InvocationInput::Continuation {
                    claim: Box::new(claim),

                    request_fingerprint: digest('f'),
                },
                None => InvocationInput::Message {
                    content: id.into(),
                    source_messages: Vec::new(),
                    request_fingerprint: None,
                },
            },
        },
    )
}

pub(crate) fn digest(c: char) -> String {
    format!("sha256:{}", c.to_string().repeat(64))
}

pub(crate) async fn append(log: &EventLog, event: &RuntimeEvent) -> u64 {
    log.append(&EventWrite::plain(event.clone()).unwrap())
        .await
        .unwrap()
}

pub(crate) async fn close(log: &EventLog, opening: &RuntimeEvent) {
    append(
        log,
        &RuntimeEvent::new(
            opening.invocation.clone(),
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Completed,
            },
        ),
    )
    .await;
}

pub(crate) async fn claim(
    log: &EventLog,
    id: &str,
    source: &RuntimeEvent,
    base: SessionBase,
) -> ContinuationClaim {
    let prefix = log
        .run_source(
            &source.invocation.session_id,
            &source.invocation.run_id,
            None,
        )
        .await
        .unwrap()
        .unwrap();
    ContinuationClaim {
        id: id.into(),
        source: prefix.boundary,
        base,
        // Fixture of engine-owned projection evidence; the store authenticates raw ancestry.
        replay: ReplayEvidence {
            version: REPLAY_VERSION,
            digest: digest('a'),
            route_identity: digest('b'),
        },
    }
}
