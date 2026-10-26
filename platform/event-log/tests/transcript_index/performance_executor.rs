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

//! Opt-in release probe for sequential tools inside one external invocation.
use super::*;
use maka_agent_facts::execution::{
    ApprovalPolicy, BehaviorId, CollaborationMode, InvocationConfiguration, SandboxMode, ToolMode,
    WorkspaceOrigin,
};
use maka_agent_facts::executor::{Binding, Output};
use serde_json::json;
use std::time::Instant;

#[tokio::test]
#[ignore = "release performance probe for a long external invocation"]
#[allow(clippy::assertions_on_constants)]
async fn executor_invocation_transcript() {
    assert!(!cfg!(debug_assertions), "run with --release");
    let sizes = std::env::var("MAKA_EXECUTOR_BENCH_STEPS").unwrap_or("128,512".into());
    let repetitions: usize = std::env::var("MAKA_EXECUTOR_BENCH_REPETITIONS")
        .unwrap_or("5".into())
        .parse()
        .unwrap();
    assert!(repetitions > 0);
    for count in sizes.split(',').map(|size| size.parse::<usize>().unwrap()) {
        assert!((1..=2048).contains(&count));
        let fixture = tempfile::tempdir().unwrap();
        let database = fixture.path().join("source.sqlite");
        let log = EventLog::open(&database).await.unwrap();
        let mut opening = opening();
        let Fact::InvocationOpened { configuration, .. } = &mut opening else {
            unreachable!()
        };
        *configuration = Some(Box::new(InvocationConfiguration {
            language: maka_agent_facts::language::Language::En,
            compaction_prompt: None,
            workspace_origin: WorkspaceOrigin::Selected,
            approval_policy: ApprovalPolicy::OnRequest,
            boundary_revision: 0,
            cwd: fixture.path().to_string_lossy().into_owned(),
            workspace_binding: None,
            workspace_identity: None,
            model: None,
            editing_tools: None,
            tool_discovery: false,
            tool_composition: None,
            system_prompt: None,
            thinking_level: None,
            sandbox_mode: SandboxMode::WorkspaceWrite,
            collaboration_mode: CollaborationMode::Agent,
            orchestration_mode: BehaviorId::default(),
            tool_mode: ToolMode::Direct,
            code_language: Default::default(),
        }));
        log.append(&event("a", opening)).await.unwrap();
        log.append(&event(
            "a",
            Fact::ExecutorStarted {
                settings: Default::default(),
                binding: Binding {
                    executor_id: "example".to_owned().try_into().unwrap(),
                    package_id: "example".into(),
                    entry_id: "example".into(),
                    activation: "activation".into(),
                },
            },
        ))
        .await
        .unwrap();
        for tool in 0..count {
            let id = format!("external-{tool}");
            let outputs = [
                Output::ToolStart {
                    tool_call_id: id.clone(),
                    name: "Read".into(),
                    input: json!({"path":format!("file-{tool}")}),
                },
                Output::ToolProgress {
                    tool_call_id: id.clone(),
                    text: format!("progress-{tool}"),
                },
                Output::ToolResult {
                    tool_call_id: id,
                    text: format!("result-{tool}"),
                    is_error: false,
                },
            ];
            let writes = outputs
                .into_iter()
                .map(|output| event("a", Fact::ExecutorObserved { output }))
                .collect::<Vec<_>>();
            log.append_batch(&writes).await.unwrap();
        }
        log.append(&event(
            "a",
            Fact::ExecutorCompleted {
                text: "external complete".into(),
            },
        ))
        .await
        .unwrap();
        let through = end(&log, "a", InvocationOutcome::Completed).await;
        assert_eq!(through, (count * 3 + 4) as u64);
        let prefix = log.prefix(10_000, 16 * 1024 * 1024).await.unwrap();
        let mut view = maka_presentation::InvocationView::new();
        let expected = prefix
            .events
            .iter()
            .flat_map(|row| view.push(row).unwrap())
            .map(|row| serde_json::to_value(row.message).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(expected.len(), count * 2 + 4);
        log.close().await.unwrap();
        for repetition in 0..repetitions {
            let sample = tempfile::tempdir().unwrap();
            let path = sample.path().join("sample.sqlite");
            std::fs::copy(&database, &path).unwrap();
            let log = EventLog::open(&path).await.unwrap();
            let started = Instant::now();
            crate::transcript_cache::materialize_all_rows(&log, "a", through)
                .await
                .unwrap();
            let body_materialize_ms = started.elapsed().as_secs_f64() * 1000.0;
            let db = Connection::open(&path).unwrap();
            let rows: Vec<Value> = crate::test_store::inspect(&log, move |db| { db.prepare("SELECT CAST(payload AS TEXT) FROM transcript_cache.rows WHERE session_id='a' ORDER BY source_sequence, item_index").unwrap()
                .query_map([], |row| row.get::<_, String>(0)).unwrap()
                .map(|row| serde_json::from_str(&row.unwrap()).unwrap()).collect() }).await;
            assert_eq!(rows, expected);

            println!(
                "{}",
                json!({"benchmark":"executor_invocation_transcript", "shape":"external_invocation",
                "tool_calls":count, "history_events":through, "repetition":repetition,
                "body_materialize_ms":body_materialize_ms,
                "messages":rows.len(), "errors":0})
            );
            drop(db);
            log.close().await.unwrap();
        }
    }
}
