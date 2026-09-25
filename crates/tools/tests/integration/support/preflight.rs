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

use maka_event_log::EventLog;
use maka_runtime::event::{EventWrite, Fact, Invocation, InvocationInput, LogScope, RuntimeEvent};
use maka_runtime::model::{ModelFinishReason, ModelPart, ModelStep, ModelToolCall};
use maka_runtime::tools::{ToolExecutor, ToolFuture};
use maka_tools::*;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio_util::sync::CancellationToken;

pub async fn close(log: Arc<EventLog>) {
    let log = match Arc::try_unwrap(log) {
        Ok(log) => log,
        Err(_) => panic!("all RunTools handles must be dropped before closing the log"),
    };
    log.close().await.unwrap();
}

#[derive(Default)]
pub struct Effect(pub AtomicUsize);
impl ToolExecutor for Effect {
    fn names(&self) -> Vec<String> {
        ["echo", "direct", "withheld"].map(String::from).into()
    }
    fn invoke(&self, _: String, input: Value, _: CancellationToken) -> ToolFuture {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { Ok(input) })
    }
}
pub fn catalog(effect: Arc<Effect>) -> ToolCatalog {
    ToolCatalog::new(["echo", "direct"].map(|name| ToolRegistration {
        definition: ToolDefinition {
            freeform: None,
            output_schema: None,
            provider: None,
            name: name.into(),
            description: "fixture".into(),
            input_schema: json!({"type":"object","properties":{"n":{"type":"integer"}},
                "required":["n"],"additionalProperties":false}),
        },
        nesting: if name == "direct" {
            ToolNesting::DirectOnly
        } else {
            ToolNesting::Nestable
        },
        semantics: if name == "direct" {
            ToolSemantics::FinishTurn
        } else {
            ToolSemantics::Parallel
        },
        handler: ToolHandler::Immediate(effect.clone()),
    }))
    .unwrap()
}
pub fn invocation(id: &str) -> Invocation {
    Invocation {
        session_id: format!("session-{id}"),
        turn_id: format!("turn-{id}"),
        run_id: format!("run-{id}"),
        invocation_id: format!("invocation-{id}"),
    }
}
pub fn call(id: &str, name: &str, input: Value) -> ModelToolCall {
    ModelToolCall {
        id: id.into(),
        name: name.into(),
        input,
        provider_options: None,
        provider_executed: false,
    }
}
pub async fn accepted(log: &EventLog, invocation: &Invocation, calls: &[ModelToolCall]) {
    let facts = [
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                source_messages: Vec::new(),
                content: "test".into(),
                request_fingerprint: None,
            },
        },
        Fact::ModelRequested {
            effective_source_digest: None,
            step_id: invocation.invocation_id.clone(),
            model_id: "fixture".into(),
            source_scope: LogScope::Root,
            source_high_water: 0,
            source_digest: "".into(),
            input_digest: "".into(),
            route_identity: "".into(),
            checkpoint_event_id: None,
            purpose: maka_runtime::context::ModelPurpose::Main,
            context: None,
        },
        Fact::ModelCompleted {
            step_id: invocation.invocation_id.clone(),
            output: ModelStep {
                parts: calls
                    .iter()
                    .cloned()
                    .map(|call| ModelPart::ToolCall { call })
                    .collect(),
                finish_reason: ModelFinishReason::ToolCalls,
                usage: Default::default(),
                provider_options: None,
                response_id: None,
                model: None,
                timestamp: None,
            },
        },
    ];
    log.append_batch(
        &facts.map(|fact| EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap()),
    )
    .await
    .unwrap();
}
