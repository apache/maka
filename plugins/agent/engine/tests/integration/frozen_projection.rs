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

use crate::support::image_projection as support;

use crate::support::store::SessionFixture;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use maka_agent_engine::project_model_history;
use maka_agent_facts::capability::CallResult;
use maka_agent_facts::capability::ContentBlock;
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::input::InvocationInput;
use maka_agent_facts::tool_call::ToolCallIdentity;
use maka_agent_facts::tool_output::ToolOutput;
use serde_json::json;
use std::{sync::Arc, time::SystemTime};
use support::*;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

async fn settled(log: &SessionFixture, output: &ToolOutput) {
    let prior = identity("prior");
    for fact in [
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message { source_messages: Vec::new(), content: "prior".into(), request_fingerprint: None },
        },
        Fact::ModelRequested { item_acceptance: false, effective_source_digest: None, purpose: maka_agent_facts::context::ModelPurpose::Main, context: None, context_breakdown: None, checkpoint_event_id: None, step_id: "step".into(), model_id: "test".into(),
            source_scope: maka_agent_facts::event::LogScope::Session { id: "session".into() },
            source_high_water: 1, source_digest: "fixture".into(), input_digest: "fixture".into(),
            route_identity: "fixture".into() },
        Fact::ModelCompleted { step_id: "step".into(), output: crate::support::model_records::completion(prior.clone(), "step", serde_json::from_value::<Vec<maka_agent_facts::model::ModelPart>>(json!([{"kind":"tool_call","call":{"id":"call","name":"Read","input":{"kind":"json","data":{}},"provider_executed":false}}])).unwrap(), maka_agent_facts::model::ModelFinishReason::ToolCalls) },
        Fact::ToolDispatched { presentation: None,
        title: None, operation_id: "step:call".into(),
            call: ToolCallIdentity::provider("step".into(), "call".into()), name: "Read".into(), input: json!({}) },
    ] {
        log.append(&EventWrite::plain(RuntimeEvent::new(prior.clone(), fact)).unwrap()).await.unwrap();
    }
    log.append(
        &EventWrite::tool_success(
            "result".into(),
            SystemTime::now(),
            prior.clone(),
            "step:call".into(),
            output.clone().into(),
        )
        .unwrap()
        .0,
    )
    .await
    .unwrap();
    log.append(
        &EventWrite::plain(RuntimeEvent::new(
            prior,
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Completed,
            },
        ))
        .unwrap(),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn frozen_string_and_attachment_text_keep_distinct_sdk_shapes() {
    for (raw, expected) in [
        (
            ToolOutput::Json(json!("plain")),
            json!({"type":"text","value":"plain"}),
        ),
        (
            ToolOutput::Text("attachment".into()),
            json!({"type":"json","value":{"kind":"text","text":"attachment"}}),
        ),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let log = SessionFixture::open(&directory.path().join("events.sqlite"))
            .await
            .unwrap();
        settled(&log, &raw).await;
        let prefix = log.prefix(100, 128 * 1024).await.unwrap();
        assert_eq!(
            serde_json::to_value(
                project_model_history(&prefix, "session", maka_agent_facts::language::Language::En)
                    .unwrap()
            )
            .unwrap()[2]["content"][0]["output"],
            expected
        );
    }
}

#[tokio::test]
async fn reopened_history_uses_frozen_projection_without_raw_store_access() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = SessionFixture::open(&path).await.unwrap();
    let raw = ToolOutput::Text("raw-only-marker".repeat(800_000));
    settled(&log, &raw).await;
    let original = log.prefix(100, 16 * 1024 * 1024).await.unwrap();
    let expected = project_model_history(
        &original,
        "session",
        maka_agent_facts::language::Language::En,
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(&expected).unwrap()[2]["content"][0]["output"],
        json!({"type":"json","value":{"kind":"text","text":"raw-only-marker".repeat(800_000)}})
    );
    log.close().await.unwrap();
    let log = SessionFixture::open(&path).await.unwrap();
    let reopened = log.prefix(100, 16 * 1024 * 1024).await.unwrap();
    assert_eq!(
        serde_json::to_value(&reopened).unwrap(),
        serde_json::to_value(&original).unwrap()
    );
    assert_eq!(
        log.resolve_tool_result("session", "result").await.unwrap(),
        raw
    );
    log.close().await.unwrap();
    // A detached committed prefix is sufficient: there is no live store from
    // which a current projector could accidentally fetch or reinterpret raw.
    assert_eq!(
        project_model_history(
            &reopened,
            "session",
            maka_agent_facts::language::Language::En
        )
        .unwrap(),
        expected
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reopened_mcp_images_materialize_multiple_ordered_parts_from_protected_artifacts() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = SessionFixture::open(&path).await.unwrap();

    artifact(&log, "user", 8, true).await;
    let bytes = [
        b"\x89PNG\r\n\x1a\nfirst".to_vec(),
        b"\x89PNG\r\n\x1a\nsecond".to_vec(),
    ];
    let image = |index: usize| ContentBlock::Image {
        data: STANDARD.encode(&bytes[index]),
        mime_type: "image/png".into(),
    };
    settled(
        &log,
        &ToolOutput::Mcp(CallResult {
            content: vec![
                ContentBlock::Text {
                    text: "before".into(),
                },
                image(0),
                ContentBlock::Text {
                    text: "between".into(),
                },
                image(1),
                ContentBlock::Text {
                    text: "after".into(),
                },
            ],
            structured_content: None,
        }),
    )
    .await;
    log.close().await.unwrap();
    let log = Arc::new(SessionFixture::open(&path).await.unwrap());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let body = request(&mut socket).await;
        respond(&mut socket).await;
        body
    });
    let engine = engine();
    engine
        .run(
            log.store(),
            input(&base, json!([attachment("user")])),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let body = server.await.unwrap();
    let messages = body["messages"].as_array().unwrap();
    let relocated = messages
        .iter()
        .find(|message| {
            message["content"]
                .as_array()
                .is_some_and(|parts| parts.iter().any(|part| part["type"] == "image_url"))
        })
        .unwrap();
    let urls: Vec<_> = relocated["content"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|part| part["image_url"]["url"].as_str())
        .collect();
    assert_eq!(
        urls,
        bytes
            .iter()
            .map(|bytes| format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
            .collect::<Vec<_>>()
    );
    let tool = messages
        .iter()
        .find(|message| message["role"] == "tool")
        .unwrap();
    let text = tool["content"].as_str().unwrap();
    assert!(text.find("before").unwrap() < text.find("between").unwrap());
    assert!(text.find("between").unwrap() < text.find("after").unwrap());
    engine.drain().await;
}
