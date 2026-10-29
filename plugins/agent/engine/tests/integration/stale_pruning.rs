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

use crate::support::store::SessionFixture;
use crate::support::{context as fixture, image_projection::identity};
use maka_agent_facts::context::ModelPurpose;
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::LogScope;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::input::InvocationInput;
use maka_agent_facts::tool_call::ToolCallIdentity;
use maka_agent_facts::tool_output::ToolOutput;
use serde_json::{Value, json};
use std::{sync::Arc, time::SystemTime};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

// Closed canonical history written before pruning was enabled, not a derived view.
async fn legacy(log: &SessionFixture, id: &str, repeats: usize) {
    let invocation = identity(id);
    let step = format!("step-{id}");
    let operation = format!("{step}:call-{id}");
    for fact in [
        Fact::InvocationOpened { configuration: None,
            input: InvocationInput::Message { source_messages: Vec::new(), content: format!("question-{id}").into(), request_fingerprint: None } },
        Fact::ModelRequested { item_acceptance: false, purpose: maka_agent_facts::context::ModelPurpose::Main, context: None, context_breakdown: None, checkpoint_event_id: None, effective_source_digest: None,
            step_id: step.clone(), model_id: "test".into(), source_scope: LogScope::Session { id: "session".into() },
            source_high_water: 1, source_digest: "legacy".into(), input_digest: "legacy".into(), route_identity: "legacy".into() },
        Fact::ModelCompleted { step_id: step.clone(), output: crate::support::model_records::completion(invocation.clone(), &step, serde_json::from_value::<Vec<maka_agent_facts::model::ModelPart>>(json!([{"kind":"tool_call","call":{"id":format!("call-{id}"),"name":"Read","input":{"kind":"json","data":{"path":id}},"provider_executed":false}}])).unwrap(), maka_agent_facts::model::ModelFinishReason::ToolCalls) },
        Fact::ToolDispatched { presentation: None,
        title: None, operation_id: operation.clone(),
            call: ToolCallIdentity::provider(step, format!("call-{id}")), name: "Read".into(), input: json!({"path":id}) },
    ] {
        log.append(&EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap()).await.unwrap();
    }
    log.append(
        &EventWrite::tool_success(
            format!("result-{id}"),
            SystemTime::now(),
            invocation.clone(),
            operation,
            ToolOutput::Json(json!({"content":format!("body-{id}-").repeat(repeats)})).into(),
        )
        .unwrap()
        .0,
    )
    .await
    .unwrap();
    log.append(
        &EventWrite::plain(RuntimeEvent::new(
            invocation,
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Completed,
            },
        ))
        .unwrap(),
    )
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn history_pruning_binds_post_coverage_first_pages_into_summary_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = Arc::new(SessionFixture::open(&path).await.unwrap());
    for id in ["one", "two", "three"] {
        legacy(&log, id, 1500).await;
    }
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = fixture::read_request(&mut socket).await;
        let messages = request["messages"].to_string();
        assert!(messages.contains("maka.archived_tool_result"));
        assert!(messages.contains("body-one-"));
        assert!(messages.contains("body-two-"));
        assert!(messages.contains("body-three-"));
        for message in request["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["role"] == "tool")
        {
            let content = message["content"].as_str().unwrap();
            assert!(content.encode_utf16().count() <= 7500);
            assert_eq!(
                serde_json::from_str::<Value>(content).unwrap()["reason"],
                "tool_result_pruned"
            );
        }
        fixture::respond(&mut socket, fixture::SUMMARY, "stop").await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = fixture::read_request(&mut socket).await;
        assert!(request["messages"].to_string().contains("summary-marker"));
        assert!(!request["messages"].to_string().contains("body-two-"));
        fixture::respond(&mut socket, "done", "stop").await;
    });
    let worker = fixture::engine();
    worker
        .run(
            log.store(),
            fixture::input(&base, "compact", true),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    worker.drain().await;
    let prefix = log.prefix(200, 256 * 1024).await.unwrap();
    let archived: Vec<_> = prefix
        .events
        .iter()
        .filter_map(|stored| match &stored.event.fact {
            Fact::ToolResultArchived { placeholder } => Some((stored.sequence, placeholder)),
            _ => None,
        })
        .collect();
    assert_eq!(archived.len(), 3);
    assert_eq!(
        archived
            .iter()
            .map(|(_, p)| p.identity.runtime_event_id.as_str())
            .collect::<Vec<_>>(),
        vec!["result-one", "result-two", "result-three"]
    );
    let request = prefix
        .events
        .iter()
        .find_map(|stored| match &stored.event.fact {
            Fact::ModelRequested {
                purpose: ModelPurpose::Summary,
                source_high_water,
                effective_source_digest: Some(digest),
                ..
            } => Some((*source_high_water, digest)),
            _ => None,
        })
        .unwrap();
    assert!(
        archived[0].0 > request.0,
        "stale was committed after the compact coverage fence"
    );
    assert!(request.1.starts_with("sha256:"));
    let original = log
        .resolve_tool_result("session", "result-one")
        .await
        .unwrap();
    assert!(original.into_json().to_string().contains("body-one-"));
    drop(worker);
    Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
    let log = Arc::new(SessionFixture::open(&path).await.unwrap());
    let worker = fixture::engine();
    worker
        .run(
            log.store(),
            fixture::input(&base, "next", false),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    worker.drain().await;
    server.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn small_first_page_does_not_starve_later_large_stale_result() {
    let directory = tempfile::tempdir().unwrap();
    let log = Arc::new(
        SessionFixture::open(&directory.path().join("events.sqlite"))
            .await
            .unwrap(),
    );
    for index in 0..128 {
        legacy(&log, &format!("small-{index}"), 1).await;
    }
    legacy(&log, "large", 1500).await;
    legacy(&log, "protected-one", 1).await;
    legacy(&log, "protected-two", 1).await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = fixture::read_request(&mut socket).await;
        let messages = request["messages"].to_string();
        assert!(messages.contains("body-small-0-"));
        assert!(messages.contains("maka.archived_tool_result"));
        assert!(messages.contains("body-large-"));
        fixture::respond(&mut socket, "done", "stop").await;
    });
    let worker = fixture::engine();
    worker
        .run(
            log.store(),
            fixture::input(&base, "next", false),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    worker.drain().await;
    server.await.unwrap();
    let prefix = log.prefix(2000, 4 * 1024 * 1024).await.unwrap();
    let archived: Vec<_> = prefix
        .events
        .iter()
        .filter_map(|stored| match &stored.event.fact {
            Fact::ToolResultArchived { placeholder } => {
                Some(&placeholder.identity.runtime_event_id)
            }
            _ => None,
        })
        .collect();
    assert_eq!(archived, vec!["result-large"]);
}
