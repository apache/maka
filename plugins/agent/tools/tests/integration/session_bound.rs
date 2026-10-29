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

use super::support::preflight as fixture;
use maka_agent_facts::{
    event::{EventWrite, Fact, Invocation, InvocationInput, LogScope, RuntimeEvent},
    language::Language,
    model::{ModelFinishReason, ModelPart, ModelStep},
    tools::ToolError,
};
use maka_code_runtime::CellLimits;
use maka_event_log::{
    root::{RootNamespaces, RootOwner},
    root_store::RootStore,
};
use maka_tools::{CodeExecutor, RunTools, ToolMode, availability::LoadedTools};
use std::sync::{Arc, atomic::Ordering};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn selected_session_sink_rejects_foreign_tool_before_effect_and_accepts_its_own() {
    let directory = tempfile::tempdir().unwrap();
    let owner = Arc::new(
        RootOwner::create(
            &directory.path().join("root"),
            &RootNamespaces {
                ownership: directory.path().join("owners"),
                control: directory.path().join("control"),
            },
        )
        .unwrap(),
    );
    let root = RootStore::open(owner).await.unwrap();
    let a = Arc::new(
        root.create_session("a", "a", &serde_json::json!({}), 1)
            .await
            .unwrap(),
    );
    let b = Arc::new(
        root.create_session("b", "b", &serde_json::json!({}), 1)
            .await
            .unwrap(),
    );
    let invocation = Invocation {
        session_id: "b".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    let call = fixture::call("call", "echo", serde_json::json!({"n": 7}));
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
            context_breakdown: None,
            item_acceptance: false,
            effective_source_digest: None,
            step_id: "step".into(),
            model_id: "fixture".into(),
            source_scope: LogScope::Root,
            source_high_water: 0,
            source_digest: "".into(),
            input_digest: "".into(),
            route_identity: "".into(),
            checkpoint_event_id: None,
            purpose: maka_agent_facts::context::ModelPurpose::Main,
            context: None,
        },
        Fact::ModelCompleted {
            step_id: "step".into(),
            output: ModelStep {
                parts: vec![ModelPart::ToolCall { call: call.clone() }],
                finish_reason: ModelFinishReason::ToolCalls,
                usage: Default::default(),
                provider_options: None,
                response_id: None,
                model: None,
                timestamp: None,
            },
        },
    ];
    b.append_batch(
        &facts.map(|fact| EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap()),
    )
    .await
    .unwrap();
    let effect = Arc::new(fixture::Effect::default());
    for (sink, foreign) in [(a, true), (b, false)] {
        let tools = RunTools::new(
            Language::En,
            sink,
            invocation.clone(),
            fixture::catalog(effect.clone()),
            ToolMode::Direct,
            CodeExecutor::new(CellLimits::default()).unwrap(),
            LoadedTools::temporary().unwrap(),
        );
        let result = tools
            .capture(".", CancellationToken::new())
            .await
            .unwrap()
            .into_step("step")
            .invoke(&call, None, CancellationToken::new())
            .await;
        if foreign {
            assert!(matches!(result, Err(ToolError::Persistence(_))));
            assert_eq!(effect.0.load(Ordering::SeqCst), 0);
        } else {
            assert_eq!(result.unwrap(), serde_json::json!({"n": 7}));
            assert_eq!(effect.0.load(Ordering::SeqCst), 1);
        }
        tools.shutdown().await.unwrap();
    }
    root.close().await.unwrap();
}

async fn accepted_scoped(
    store: &maka_event_log::root_store::SessionStore,
    invocation: &Invocation,
    call: &maka_agent_facts::model::ModelToolCall,
) {
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
            context_breakdown: None,
            item_acceptance: false,
            effective_source_digest: None,
            step_id: "step".into(),
            model_id: "fixture".into(),
            source_scope: LogScope::Root,
            source_high_water: 0,
            source_digest: "".into(),
            input_digest: "".into(),
            route_identity: "".into(),
            checkpoint_event_id: None,
            purpose: maka_agent_facts::context::ModelPurpose::Main,
            context: None,
        },
        Fact::ModelCompleted {
            step_id: "step".into(),
            output: ModelStep {
                parts: vec![ModelPart::ToolCall { call: call.clone() }],
                finish_reason: ModelFinishReason::ToolCalls,
                usage: Default::default(),
                provider_options: None,
                response_id: None,
                model: None,
                timestamp: None,
            },
        },
    ];
    store
        .append_batch(
            &facts.map(|fact| {
                EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap()
            }),
        )
        .await
        .unwrap();
}

#[derive(Clone)]
struct ScopedReader(Arc<RootStore>, Arc<std::sync::atomic::AtomicUsize>);
impl maka_tools::request::RequestBinding for ScopedReader {
    fn bind(
        &self,
        request: maka_tools::request::BindingRequest,
    ) -> maka_tools::request::BindingFuture {
        let reader = self.clone();
        Box::pin(async move {
            let custody = request
                .execution
                .as_deref()
                .expect("request capture carries execution custody");
            let selected = reader
                .0
                .session_for_execution(custody, &request.invocation)
                .unwrap();
            assert_eq!(
                selected
                    .get::<serde_json::Value>()
                    .await
                    .unwrap()
                    .unwrap()
                    .id,
                request.invocation.session_id
            );
            Ok(std::collections::BTreeMap::from([(
                "read".into(),
                maka_tools::request::BoundTool::Prepared(Arc::new(reader)),
            )]))
        })
    }
}
impl maka_agent_facts::tools::ToolPreparer for ScopedReader {
    fn names(&self) -> Vec<String> {
        vec!["read".into()]
    }
    fn prepare(
        &self,
        _: String,
        _: serde_json::Value,
        context: maka_agent_facts::tools::ToolCallContext,
        _: CancellationToken,
    ) -> maka_agent_facts::tools::PreparationFuture {
        let root = self.0.clone();
        let calls = self.1.clone();
        Box::pin(async move {
            let custody = context
                .execution
                .as_deref()
                .expect("direct and nested calls carry custody");
            let selected = root
                .session_for_execution(custody, &context.invocation)
                .unwrap();
            Ok(maka_agent_facts::tools::PreparedEffect::new(move |_| {
                Box::pin(async move {
                    // A separate runtime task receives the selected handle explicitly.
                    let record = tokio::spawn(async move {
                        selected.get::<serde_json::Value>().await.unwrap().unwrap()
                    })
                    .await
                    .unwrap();
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(serde_json::json!({"session": record.id}).into())
                })
            }))
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn direct_and_nested_tools_carry_selected_execution_into_spawned_host_work() {
    use maka_agent_facts::tools::{
        ToolDefinition, ToolHandler, ToolNesting, ToolRegistration, ToolSemantics,
    };
    use maka_tools::ToolCatalog;
    let directory = tempfile::tempdir().unwrap();
    let root = Arc::new(
        RootStore::open(Arc::new(
            RootOwner::create(
                &directory.path().join("root"),
                &RootNamespaces {
                    ownership: directory.path().join("owners"),
                    control: directory.path().join("control"),
                },
            )
            .unwrap(),
        ))
        .await
        .unwrap(),
    );
    for (id, mode) in [("direct", ToolMode::Direct), ("nested", ToolMode::CodeMode)] {
        let invocation = fixture::invocation(id);
        let session = root
            .create_session(&invocation.session_id, id, &serde_json::json!({}), 1)
            .await
            .unwrap();
        let scope = session.execution_scope(None).await.unwrap();
        let selected = Arc::new(scope.store());
        let lease = scope.accept();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let catalog = ToolCatalog::new([ToolRegistration {
            definition: ToolDefinition {
                freeform: None,
                output_schema: None,
                provider: None,
                name: "read".into(),
                description: "read selected session".into(),
                input_schema: serde_json::json!({"type":"object"}),
            },
            handler: ToolHandler::Prepared(Arc::new(ScopedReader(root.clone(), calls.clone()))),
            nesting: ToolNesting::Nestable,
            semantics: ToolSemantics::Parallel,
        }])
        .unwrap()
        .with_request_binding(
            std::collections::BTreeSet::from(["read".into()]),
            Arc::new(ScopedReader(root.clone(), calls.clone())),
        )
        .unwrap();
        let call = match mode {
            ToolMode::Direct => fixture::call(id, "read", serde_json::json!({})),
            _ => fixture::call(
                id,
                "exec",
                serde_json::json!({"code":"text(await tools.read({}));"}),
            ),
        };
        accepted_scoped(&selected, &invocation, &call).await;
        let run = RunTools::new(
            Language::En,
            selected,
            invocation.clone(),
            catalog,
            mode,
            CodeExecutor::new(CellLimits::default()).unwrap(),
            LoadedTools::temporary().unwrap(),
        );
        let result = run
            .capture(".", CancellationToken::new())
            .await
            .unwrap()
            .into_step("step")
            .invoke(&call, None, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1, "{result}");
        if matches!(mode, ToolMode::Direct) {
            assert_eq!(result["session"], invocation.session_id);
        }
        run.shutdown().await.unwrap();
        lease.finish();
    }
    root.shutdown().await.unwrap();
}
