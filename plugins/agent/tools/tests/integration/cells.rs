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
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::model::ModelFinishReason;
use maka_agent_facts::model::ModelPart;
use maka_agent_facts::model::ModelStep;
use maka_agent_facts::tool_call::ToolOrigin;
use maka_agent_facts::tools::ToolExecutor;
use maka_agent_facts::tools::ToolFuture;
use maka_code_runtime::CellLimits;
use maka_event_log::EventLog;
use maka_tools::CodeExecutor;
use maka_tools::{
    RunTools, ToolCatalog, ToolDefinition, ToolHandler, ToolMode, ToolNesting, ToolRegistration,
    ToolSemantics,
};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

struct Block(Arc<Notify>);
impl ToolExecutor for Block {
    fn names(&self) -> Vec<String> {
        vec!["block".into()]
    }
    fn invoke(&self, _: String, _: Value, cancellation: CancellationToken) -> ToolFuture {
        let release = self.0.clone();
        Box::pin(async move {
            tokio::select! { _ = release.notified() => {}, _ = cancellation.cancelled() => {} }
            Ok(json!({"settled":true}))
        })
    }
}

async fn invoke(
    log: &EventLog,
    run: &RunTools,
    invocation: &Invocation,
    step: &str,
    name: &str,
    input: Value,
) -> Value {
    invoke_result(log, run, invocation, step, name, input)
        .await
        .unwrap()
}

async fn invoke_result(
    log: &EventLog,
    run: &RunTools,
    invocation: &Invocation,
    step: &str,
    name: &str,
    input: Value,
) -> Result<Value, maka_agent_facts::tools::ToolError> {
    let call = fixture::call(step, name, input);
    log.append_batch(&[
        EventWrite::plain(RuntimeEvent::new(
            invocation.clone(),
            Fact::ModelRequested {
                context_breakdown: None,
                item_acceptance: false,
                step_id: step.into(),
                model_id: "fixture".into(),
                source_scope: maka_agent_facts::event::LogScope::Root,
                source_high_water: 0,
                source_digest: String::new(),
                effective_source_digest: None,
                input_digest: String::new(),
                route_identity: String::new(),
                checkpoint_event_id: None,
                purpose: maka_agent_facts::context::ModelPurpose::Main,
                context: None,
            },
        ))
        .unwrap(),
        EventWrite::plain(RuntimeEvent::new(
            invocation.clone(),
            Fact::ModelObserved {
                step_id: step.into(),
                event: maka_agent_facts::model::ModelEvent::ToolCall(call.clone()),
            },
        ))
        .unwrap(),
        EventWrite::plain(RuntimeEvent::new(
            invocation.clone(),
            Fact::ModelCompleted {
                step_id: step.into(),
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
        ))
        .unwrap(),
    ])
    .await
    .unwrap();
    run.capture(".", CancellationToken::new())
        .await
        .unwrap()
        .into_step(step)
        .invoke(&call, CancellationToken::new())
        .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn yielding_cells_keep_ancestry_deliver_deltas_share_json_and_drain_on_run_end() {
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sqlite");
        let log = Arc::new(EventLog::open(&path).await.unwrap());
        let invocation = fixture::invocation("cells");
        log.create_session(&invocation.session_id, "create", &json!({}), 1).await.unwrap();
        fixture::accepted(&log, &invocation, &[]).await;
        let release = Arc::new(Notify::new());
        let catalog = ToolCatalog::new([ToolRegistration {
            definition:ToolDefinition { freeform: None, output_schema: None, provider:None,name:"block".into(),description:"wait".into(),input_schema:json!({"type":"object"}) },
            handler:ToolHandler::Immediate(Arc::new(Block(release.clone()))),nesting:ToolNesting::Nestable,semantics:ToolSemantics::Parallel,
        }]).unwrap();
        let loaded = maka_tools::availability::LoadedTools::temporary().unwrap();
        let run = RunTools::new(maka_agent_facts::language::Language::En, log.clone(), invocation.clone(), catalog, ToolMode::CodeMode, CodeExecutor::new(CellLimits::default()).unwrap(), loaded.clone());
        let first = invoke(&log, &run, &invocation, "first", "exec", json!("// @exec: {\"yield_time_ms\":1000,\"max_output_tokens\":1000}\ntext('early'); await yield_control(); await tools.block({}); text('late'); store('n',42);")).await;
        assert_eq!(first["state"], "running");
        assert_eq!(first["content"], json!([{"kind":"text","text":"early"}]));
        let cell_id = first["cell_id"].as_str().unwrap();
        assert!(log.append(&maka_agent_facts::event::EventWrite::plain(maka_agent_facts::event::RuntimeEvent::new(invocation.clone(), Fact::ToolNotified {
            operation_id: "first:first".into(), text: "forged".into(), model_text: "forged".into(),
        })).unwrap()).await.is_err(), "only the cell, not its exec control, owns notifications");
        let prefix = log.prefix(100, 1024*1024).await.unwrap();
        assert!(prefix.events.iter().any(|e| matches!(&e.event.fact, Fact::ToolDispatched {operation_id,call,..}
            if operation_id==cell_id && matches!(&call.origin,ToolOrigin::CodeCell{parent_operation_id,..} if parent_operation_id=="first:first"))));
        assert!(log.invocation_recovery(&invocation).await.unwrap().uncertain_operations.contains(&cell_id.to_string()));
        release.notify_one();
        let last = invoke(&log,&run,&invocation,"observe","wait",json!({"cell_id":cell_id,"max_tokens":1000})).await;
        assert_eq!(last["state"],"completed");
        assert!(log.append(&maka_agent_facts::event::EventWrite::plain(maka_agent_facts::event::RuntimeEvent::new(invocation.clone(), Fact::ToolNotified {
            operation_id: cell_id.into(), text: "late".into(), model_text: "late".into(),
        })).unwrap()).await.is_err(), "settled cells cannot inject notifications");
        assert_eq!(last["result"]["value"],Value::Null);
        assert_eq!(last["content"],json!([{"kind":"text","text":"late"}]));
        loaded.clear().unwrap();
        let next = invoke(&log,&run,&invocation,"next","exec",json!({"code":format!("const complete_source = {}; text(load('n'));", serde_json::to_string(&"甲".repeat(24_000)).unwrap())})).await;
        assert_eq!(next["content"][0]["text"],"42");
        let stopping = invoke(&log,&run,&invocation,"stopping","exec",json!({"code":"notify('stoppable'); await yield_control(); await tools.block({});"})).await;
        assert_eq!(stopping["state"],"running");
        let stopped = invoke(&log,&run,&invocation,"terminate","wait",json!({"cell_id":stopping["cell_id"],"terminate":true})).await;
        assert_eq!(stopped["state"],"terminated");
        assert_eq!(stopped["content"],json!([]), "termination must not repeat previously observed output");
        assert!(log.invocation_recovery(&invocation).await.unwrap().uncertain_operations.is_empty());
        let unfinished = invoke(&log,&run,&invocation,"unfinished","exec",json!({"code":"notify('pending'); await yield_control(); await tools.block({});"})).await;
        assert_eq!(unfinished["state"],"running");
        run.shutdown().await.unwrap();
        assert!(log.invocation_recovery(&invocation).await.unwrap().uncertain_operations.is_empty());
        let fence = log.prefix(100,1024*1024).await.unwrap().high_water;
        let headers = log.transcript_headers(&invocation.session_id, &maka_event_log::transcript::TranscriptRead {
            through: fence, position: None, direction: maka_event_log::transcript::TranscriptDirection::Older, limit: 8,
        }).await.unwrap();
        let mut result = false;
        for header in headers {
            let bytes = log.transcript_fragment(&invocation.session_id, header.position, 0, header.total_bytes).await.unwrap();
            let row: Value = serde_json::from_slice(&bytes).unwrap();
            result |= row["type"] == "tool_result";
        }
        assert!(result, "nested cells remain renderable after their control call settles");
        drop(run);
        fixture::close(log).await;
        let reopened = EventLog::open(&path).await.unwrap();
        assert!(reopened.invocation_recovery(&invocation).await.unwrap().uncertain_operations.is_empty());
        reopened.close().await.unwrap();
    }).await.expect("Code Mode observation and shutdown must not hang");
}

#[tokio::test]
async fn collected_cell_recovery_uses_the_original_run_language_and_keeps_user_output() {
    use maka_agent_facts::{language::Language, tools::ToolError};
    for (language, unavailable, caution) in [
        (
            Language::En,
            "cell is unavailable",
            "do not repeat effects blindly",
        ),
        (Language::ZhCn, "代码单元不可用", "请勿盲目重复执行"),
        (Language::ZhTw, "程式碼單元無法使用", "請勿盲目重複執行"),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let log = Arc::new(
            EventLog::open(&directory.path().join("events.sqlite"))
                .await
                .unwrap(),
        );
        let invocation = fixture::invocation("collected-cell-language");
        log.create_session(&invocation.session_id, "create", &json!({}), 1)
            .await
            .unwrap();
        fixture::accepted(&log, &invocation, &[]).await;
        let run = RunTools::new(
            language,
            log.clone(),
            invocation.clone(),
            ToolCatalog::default(),
            ToolMode::CodeMode,
            CodeExecutor::new(CellLimits::default()).unwrap(),
            maka_tools::availability::LoadedTools::temporary().unwrap(),
        );
        let finished = invoke(
            &log,
            &run,
            &invocation,
            "execute",
            "exec",
            json!({"code":"text('original 用户資料');"}),
        )
        .await;
        let missing = invoke_result(
            &log,
            &run,
            &invocation,
            "observe-collected",
            "wait",
            json!({"cell_id":finished["cell_id"]}),
        )
        .await;
        run.shutdown().await.unwrap();
        drop(run);
        fixture::close(log).await;
        assert_eq!(finished["state"], "completed");
        assert_eq!(
            finished["content"],
            json!([{"kind":"text","text":"original 用户資料"}])
        );
        let Err(ToolError::Failed(message)) = missing else {
            panic!("waiting on the actually collected cell must fail")
        };
        assert!(
            message.starts_with(unavailable),
            "missing-cell recovery language differs: {message}"
        );
        assert!(
            message.contains(caution),
            "missing-cell recovery must warn against duplicate effects: {message}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cells_accept_concurrent_work_and_honor_the_requested_output_budget() {
    let directory = tempfile::tempdir().unwrap();
    let log = Arc::new(
        EventLog::open(&directory.path().join("events.sqlite"))
            .await
            .unwrap(),
    );
    let invocation = fixture::invocation("many-cells");
    log.create_session(&invocation.session_id, "create", &json!({}), 1)
        .await
        .unwrap();
    fixture::accepted(&log, &invocation, &[]).await;
    let catalog = ToolCatalog::new([ToolRegistration {
        definition: ToolDefinition {
            name: "block".into(),
            description: "wait".into(),
            input_schema: json!({"type":"object"}),
            freeform: None,
            output_schema: None,
            provider: None,
        },
        handler: ToolHandler::Immediate(Arc::new(Block(Arc::new(Notify::new())))),
        nesting: ToolNesting::Nestable,
        semantics: ToolSemantics::Parallel,
    }])
    .unwrap();
    let run = RunTools::new(
        maka_agent_facts::language::Language::En,
        log.clone(),
        invocation.clone(),
        catalog,
        ToolMode::CodeMode,
        CodeExecutor::new(CellLimits::default()).unwrap(),
        maka_tools::availability::LoadedTools::temporary().unwrap(),
    );
    for index in 0..5 {
        let result = invoke(&log, &run, &invocation, &format!("cell-{index}"), "exec", json!({
            "code": "text('x'.repeat(140 * 1024)); await yield_control(); await tools.block({});",
            "max_output_tokens": 50_000,
        })).await;
        assert_eq!(result["state"], "running");
        assert_eq!(
            result["content"][0]["text"].as_str().unwrap(),
            "x".repeat(140 * 1024)
        );
    }
    let history = log.prefix(128, 4 * 1024 * 1024).await.unwrap();
    let complete = history.events.iter().filter(|stored| matches!(
        &stored.event.fact,
        Fact::ToolSettled { outcome: maka_agent_facts::event::ToolOutcome::Succeeded {
            model_projection: maka_agent_facts::tool_output::DurableToolProjection::Text { text }, ..
        }, .. } if text.ends_with(&"x".repeat(140 * 1024))
    )).count();
    assert_eq!(
        complete, 5,
        "each model-visible observation retains the requested output"
    );
    run.shutdown().await.unwrap();
    assert!(
        log.invocation_recovery(&invocation)
            .await
            .unwrap()
            .uncertain_operations
            .is_empty()
    );
    drop(run);
    fixture::close(log).await;
}
