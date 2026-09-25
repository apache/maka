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

use crate::support::preflight;
use maka_event_log::EventLog;
use maka_js_runtime::{CellLimits, CodeExecutor};
use maka_plugins::{
    composition::Scope,
    contributions::{Catalog, Staged},
    fiber::Fiber,
};
use maka_runtime::{
    tool_call::ToolRejection,
    tools::{ToolCallContext, ToolExecutor, ToolFuture},
};
use maka_tools::{plugins::PluginTool, *};
use serde_json::json;
use std::{
    collections::BTreeSet,
    sync::{Arc, atomic::Ordering},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

struct ScopedEffect {
    effect: Arc<preflight::Effect>,
    issuer: maka_plugins::call::Issuer,
}
impl ToolExecutor for ScopedEffect {
    fn names(&self) -> Vec<String> {
        self.effect.names()
    }
    fn invoke(
        &self,
        name: String,
        input: serde_json::Value,
        cancellation: CancellationToken,
    ) -> ToolFuture {
        let effect = self.effect.clone();
        let issuer = self.issuer.clone();
        Box::pin(async move {
            let scope =
                maka_plugins::call::current().expect("scope exists only after tool admission");
            assert!(issuer.owns(&scope));
            assert!(scope.identity.operation_id().is_some());
            effect.invoke(name, input, cancellation).await
        })
    }
}

fn registration(
    schema: serde_json::Value,
    effect: Arc<preflight::Effect>,
    issuer: maka_plugins::call::Issuer,
) -> PluginTool {
    PluginTool::new(ToolRegistration {
        definition: ToolDefinition {
            freeform: None,
            output_schema: None,
            provider: None,
            name: "echo".into(),
            description: "plugin echo".into(),
            input_schema: schema,
        },
        nesting: ToolNesting::Nestable,
        semantics: ToolSemantics::Parallel,
        handler: ToolHandler::Immediate(Arc::new(ScopedEffect { effect, issuer })),
    })
    .unwrap()
}

#[tokio::test]
async fn request_capture_refreshes_plugins_without_retargeting_old_handlers_or_widening_ceilings() {
    let directory = tempfile::tempdir().unwrap();
    let log = Arc::new(
        EventLog::open(&directory.path().join("plugins.sqlite"))
            .await
            .unwrap(),
    );
    let invocation = preflight::invocation("plugins");
    let scope = Scope::Session(invocation.session_id.clone());
    let issuer = maka_plugins::call::Issuer::default();
    let catalog = Catalog::with_calls(issuer.clone());
    let core = ToolCatalog::default()
        .with_plugins(catalog.clone(), scope.clone(), None)
        .unwrap();
    let restricted = ToolCatalog::default()
        .with_plugins(catalog.clone(), scope.clone(), Some(BTreeSet::new()))
        .unwrap();
    let run = RunTools::new(
        log.clone(),
        invocation.clone(),
        core.clone(),
        ToolMode::Direct,
        CodeExecutor::new(1, CellLimits::default()).unwrap(),
    );
    let empty = run
        .capture(".", tokio_util::sync::CancellationToken::new())
        .await
        .unwrap();
    let first_effect = Arc::new(preflight::Effect::default());
    let first = Fiber::new("example", "example", Scope::Profile).unwrap();
    first.begin_loading().unwrap();
    first.ready().unwrap();
    let mut staged = Staged::default();
    staged
        .insert(
            "echo",
            registration(
                json!({"type":"string"}),
                first_effect.clone(),
                issuer.clone(),
            ),
        )
        .unwrap();
    catalog.publish(&first, staged).unwrap();
    let original = run
        .capture(".", tokio_util::sync::CancellationToken::new())
        .await
        .unwrap();
    let original_handlers = core.resolve_plugins().unwrap();
    assert!(empty.definitions().is_empty());
    assert_eq!(original.definitions()[0].input_schema["type"], "string");
    assert!(restricted.resolve_plugins().unwrap().names().is_empty());
    assert!(
        core.resolve_captured(&Catalog::default().capture(&scope))
            .is_err()
    );

    first
        .shutdown(tokio::time::Instant::now() + Duration::from_secs(1))
        .await
        .unwrap();
    let second_effect = Arc::new(preflight::Effect::default());
    let second = Fiber::new("example", "example", Scope::Profile).unwrap();
    second.begin_loading().unwrap();
    second.ready().unwrap();
    let mut staged = Staged::default();
    staged
        .insert(
            "echo",
            registration(
                json!({"type":"integer"}),
                second_effect.clone(),
                issuer.clone(),
            ),
        )
        .unwrap();
    catalog.publish(&second, staged).unwrap();
    assert_eq!(original.definitions()[0].input_schema["type"], "string");
    let current = run
        .capture(".", tokio_util::sync::CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(current.definitions()[0].input_schema["type"], "integer");
    assert!(matches!(
        original_handlers
            .prepare(
                "echo".into(),
                json!("old schema"),
                ToolCallContext {
                    invocation: invocation.clone(),
                    operation_id: "old".into()
                },
                CancellationToken::new()
            )
            .await,
        Err(ToolRejection::Unavailable)
    ));
    let call = preflight::call("current", "echo", json!(7));
    preflight::accepted(&log, &invocation, std::slice::from_ref(&call)).await;
    assert_eq!(
        current
            .into_step(&invocation.invocation_id)
            .invoke(&call, CancellationToken::new())
            .await
            .unwrap(),
        json!(7)
    );
    assert_eq!(first_effect.0.load(Ordering::SeqCst), 0);
    assert_eq!(second_effect.0.load(Ordering::SeqCst), 1);
    second
        .shutdown(tokio::time::Instant::now() + Duration::from_secs(1))
        .await
        .unwrap();
    log.shutdown().await.unwrap();
}
