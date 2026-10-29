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

use maka_agent_facts::context::ModelPurpose;
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::model::assembly::{AttemptBinding, AttemptWriter};
use maka_agent_facts::model::{ModelEvent, ModelFinishReason};
use maka_agent_facts::tool_call::ToolCallIdentity;
use maka_agent_facts::tool_output::ToolSuccess;
use maka_event_log::EventLog;
use serde_json::json;

/// A real request surface is required for replay and archive proof validation.
pub(crate) async fn tool(
    log: &EventLog,
    invocation: &Invocation,
    step: &str,
    text: String,
) -> EventWrite {
    output(log, invocation, step, ToolSuccess::from(json!(text)))
        .await
        .0
}

pub(crate) async fn output(
    log: &EventLog,
    invocation: &Invocation,
    step: &str,
    output: ToolSuccess,
) -> (EventWrite, u64) {
    let source = log
        .capture_model_context(
            &invocation.session_id,
            Some(&invocation.invocation_id),
            100_000,
            64 * 1024 * 1024,
        )
        .await
        .unwrap();
    let event = |fact| EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap();
    log.append(
        &event(Fact::ModelRequested {
            context_breakdown: Some(maka_agent_facts::context::PreparedContextBreakdown {
                system: maka_agent_facts::context::ContextBucket {
                    content_bytes: 3,
                    estimated_tokens: 17,
                },
                counts: maka_agent_facts::context::ContextCounts {
                    messages: 1,
                    ..Default::default()
                },
                ..Default::default()
            }),
            item_acceptance: false,
            step_id: step.into(),
            model_id: "test".into(),
            purpose: ModelPurpose::Main,
            context: None,
            source_scope: source.source_evidence.scope,
            source_high_water: source.source_evidence.high_water,
            source_digest: source.source_evidence.digest,
            input_digest: "fixture".into(),
            route_identity: format!("sha256:{}", "a".repeat(64)),
            checkpoint_event_id: source.baseline.map(|baseline| baseline.event_id),
            effective_source_digest: Some(source.effective_source_digest),
        })
        .with_quote(maka_agent_facts::pricing::Quote {
            provider_id: "fixture".into(),
            revision: 1,
            pricing: Some(maka_agent_facts::pricing::Pricing {
                model_key: "fixture:test".into(),
                input_usd_per_million: 1.0,
                output_usd_per_million: 2.0,
                cache_read_usd_per_million: None,
                cache_write_usd_per_million: None,
            }),
        })
        .unwrap(),
    )
    .await
    .unwrap();
    let mut writer = AttemptWriter::new(
        AttemptBinding {
            invocation: invocation.clone(),
            step_id: step.into(),
            purpose: ModelPurpose::Main,
        },
        false,
    )
    .unwrap();
    writer
        .push(
            ModelEvent::ToolCall(
                serde_json::from_value(json!({
                    "id":step,"name":"Read","input":{"kind":"json","data":{"path":"file"}},"provider_executed":false
                }))
                .unwrap(),
            ),
            std::time::SystemTime::now(),
        )
        .unwrap();
    let observations = writer
        .push(
            ModelEvent::Finished {
                reason: ModelFinishReason::ToolCalls,
                usage: Default::default(),
                provider_options: None,
            },
            std::time::SystemTime::now(),
        )
        .unwrap();
    for observation in observations {
        log.append(&event(Fact::ModelObserved {
            step_id: step.into(),
            event: observation,
        }))
        .await
        .unwrap();
    }
    log.append(&event(Fact::ModelCompleted {
        step_id: step.into(),
        output: writer.completed().unwrap().completion(),
    }))
    .await
    .unwrap();
    let operation = format!("{step}:{step}");
    log.append(&event(Fact::ToolDispatched {
        presentation: None,
        title: None,
        operation_id: operation.clone(),
        call: ToolCallIdentity::provider(step.into(), step.into()),
        name: "Read".into(),
        input: json!({"path":"file"}),
    }))
    .await
    .unwrap();
    let (result, _) = EventWrite::tool_success(
        format!("result-{step}"),
        std::time::SystemTime::now(),
        invocation.clone(),
        operation,
        output,
    )
    .unwrap();
    let sequence = log.append(&result).await.unwrap();
    (result, sequence)
}
