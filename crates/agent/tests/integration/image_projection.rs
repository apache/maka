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

use base64::{Engine as _, engine::general_purpose::STANDARD};
use maka_agent::RunError;
use maka_event_log::EventLog;
use maka_runtime::{
    event::{EventWrite, Fact, InvocationOutcome, RuntimeEvent},
    input::InvocationInput,
    tool_call::ToolCallIdentity,
    tool_output::{ImageOutput, ToolOutput},
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use support::*;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

const FOUR_MIB: usize = 4 * 1024 * 1024;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reopened_user_and_typed_tool_images_share_actual_byte_budget_with_current_turn() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sqlite");
        let log = EventLog::open(&path).await.unwrap();
        log.create_session("session", "create", &json!({}), 1).await.unwrap();
        for id in ["historical", "tool", "fits"] { artifact(&log, id, FOUR_MIB, true).await; }
        artifact(&log, "invalid", FOUR_MIB + 1, false).await;
        artifact(&log, "overflow", 8, true).await;
        let prior = identity("historical");
        let mut historical = attachment("historical");
        historical["bytes"] = json!(FOUR_MIB);
        let message = serde_json::from_value(json!({"text":"historical", "attachments":[historical]})).unwrap();
        let facts = [
            Fact::InvocationOpened { input: InvocationInput::Message { source_messages: Vec::new(), content: message, request_fingerprint: None }, configuration: None },
            Fact::ModelRequested { effective_source_digest: None, purpose: maka_runtime::context::ModelPurpose::Main, context: None, checkpoint_event_id: None, step_id: "prior-step".into(), model_id: "test".into(),
                source_scope: maka_runtime::event::LogScope::Session { id: "session".into() },
                source_high_water: 1, source_digest: "fixture".into(), input_digest: "fixture".into(), route_identity: "fixture".into() },
            Fact::ModelCompleted { step_id: "prior-step".into(), output: serde_json::from_value(json!({
                "parts":[{"kind":"tool_call","call":{"id":"read","name":"Read","input":{},"provider_executed":false}}],
                "finish_reason":"tool-calls", "usage":{}})).unwrap() },
            Fact::ToolDispatched { operation_id: "prior-step:read".into(), call: ToolCallIdentity::provider("prior-step".into(), "read".into()), name: "Read".into(), input: json!({}) },
        ];
        for fact in facts { log.append(&EventWrite::plain(RuntimeEvent::new(prior.clone(), fact)).unwrap()).await.unwrap(); }
        log.append(&EventWrite::tool_success("prior-result".into(), std::time::SystemTime::now(), prior.clone(), "prior-step:read".into(),
            ToolOutput::Image(ImageOutput { detail: Some(maka_runtime::tool_output::ImageDetail::High), mime_type: "image/png".into(), reference: serde_json::from_value(attachment("tool")["ref"].clone()).unwrap() }).into()).unwrap().0).await.unwrap();
        log.append(&EventWrite::plain(RuntimeEvent::new(prior, Fact::InvocationEnded { outcome: InvocationOutcome::Completed })).unwrap()).await.unwrap();
        let revision = log.get_session::<Value>("session").await.unwrap().unwrap().revision;
        assert!(matches!(log.copy_session(maka_event_log::sessions::SessionCopy {
            source_session_id: "session".into(), target_session_id: "branch".into(),
            expected_source_revision: revision, purpose: maka_runtime::session::CopyPurpose::Branch { turn_id: None, side_conversation: false },
        }, &json!({}), 2).await.unwrap(), maka_event_log::sessions::SessionCopyResult::Committed(_)));
        log.close().await.unwrap();

        let log = Arc::new(EventLog::open(&path).await.unwrap());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let observed_log = log.clone();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let body = request(&mut socket).await;
            let prefix = observed_log.prefix(100, 128 * 1024).await.unwrap();
            assert!(prefix.events.iter().any(|stored| stored.event.invocation.invocation_id == "invocation-current"
                && matches!(stored.event.fact, Fact::ModelRequested { .. })));
            respond(&mut socket).await;
            body
        });
        let mut foreign = attachment("historical");
        foreign["ref"]["sessionId"] = json!("other");
        let mut workspace = attachment("workspace");
        workspace["ref"] = json!({"kind":"workspace_file", "relativePath":"historical"});
        let engine = engine(log.clone());
        engine.run(input(&base, json!([attachment("invalid"), attachment("missing"), foreign, workspace,
            attachment("fits"), attachment("overflow")])), CancellationToken::new()).await.unwrap();
        let body = server.await.unwrap();
        let mut urls = Vec::new();
        collect_images(&body["messages"], &mut urls);
        assert_eq!(urls.len(), 3, "prior user + typed Read + exact remaining current image");
        for url in urls {
            let data = url.strip_prefix("data:image/png;base64,").unwrap();
            let bytes = STANDARD.decode(data).unwrap();
            assert_eq!(bytes.len(), FOUR_MIB);
            assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
        }
        let text = body["messages"].to_string();
        assert!(text.contains("\"detail\":\"high\""), "tool image detail reaches the provider after reopening");
        for name in ["invalid", "missing", "historical", "workspace"] {
            assert!(text.contains(&format!("Image attachment \\\"{name}\\\" could not be loaded")), "missing error for {name}");
        }
        assert!(text.contains("unsupported_mime"));
        assert!(text.contains("[1 image attachment(s) omitted:"), "only the valid overflow image is omitted");
        assert!(text.contains("session_mismatch"));
        assert!(text.contains("unsupported_ref_kind"));
        let prefix = log.prefix(100, 128 * 1024).await.unwrap();
        let canonical = serde_json::to_string(&prefix).unwrap();
        assert!(!canonical.contains("data:image"), "projection must not persist image bytes");
        assert!(canonical.len() < 32 * 1024);
        for id in ["historical", "tool"] {
            assert_eq!(log.delete_user_artifact("session", id).await.unwrap(),
                maka_event_log::artifacts::ArtifactDeletion::Deleted);
        }
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let copied_request = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let body = request(&mut socket).await;
            respond(&mut socket).await;
            body
        });
        let mut copied = input(&base, json!([]));
        copied.invocation = identity("branch-current");
        copied.invocation.session_id = "branch".into();
        engine.run(copied, CancellationToken::new()).await.unwrap();
        let copied_request = copied_request.await.unwrap();
        let mut inherited_images = Vec::new();
        collect_images(&copied_request["messages"], &mut inherited_images);
        assert_eq!(inherited_images.len(), 2, "copy retains both user and typed tool images after source deletion");
        let reference = log.resolve_history_artifact("branch", "session", "historical").await.unwrap().unwrap();
        assert!(copied_request["messages"].to_string().contains(&reference.resource_ref().unwrap()),
            "Read must receive the destination-owned resource URI");
        let tool_reference = log.resolve_history_artifact("branch", "session", "tool").await.unwrap().unwrap();
        let maka_runtime::attachment::StorageRef::SessionFile { relative_path, .. } = tool_reference else { panic!("owned tool image") };
        assert!(log.read_tool_result("branch", "prior-result").await.unwrap().unwrap().serialized_result.contains(&relative_path),
            "tool-result Read renders the copied image's locator, not the source artifact ID");
        let original = log.prefix(100, 128 * 1024).await.unwrap();
        let source_opening = original.events.iter().find(|e| e.event.invocation.invocation_id == "invocation-historical"
            && matches!(e.event.fact, Fact::InvocationOpened { .. })).unwrap();
        assert!(!serde_json::to_string(&source_opening.event).unwrap().contains("history-"),
            "rendering aliases cannot rewrite canonical input");
        engine.drain().await;
    }).await.expect("image projection must make bounded progress");
}

fn collect_images<'a>(value: &'a Value, urls: &mut Vec<&'a str>) {
    match value {
        Value::Array(values) => {
            for value in values {
                collect_images(value, urls);
            }
        }
        Value::Object(fields) => {
            if let Some(url) = fields
                .get("image_url")
                .and_then(|value| value["url"].as_str())
            {
                urls.push(url);
            }
            for value in fields.values() {
                collect_images(value, urls);
            }
        }
        _ => {}
    }
}

#[tokio::test]
async fn cancelled_image_turn_does_not_commit_or_send_a_model_request() {
    let directory = tempfile::tempdir().unwrap();
    let log = Arc::new(
        EventLog::open(&directory.path().join("events.sqlite"))
            .await
            .unwrap(),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let cancellation = CancellationToken::new();
    cancellation.cancel();
    let engine = engine(log.clone());
    assert!(matches!(
        engine
            .run(input(&base, json!([attachment("missing")])), cancellation)
            .await,
        Err(RunError::Cancelled)
    ));
    engine.drain().await;
    assert!(
        !log.prefix(100, 128 * 1024)
            .await
            .unwrap()
            .events
            .iter()
            .any(|stored| matches!(stored.event.fact, Fact::ModelRequested { .. }))
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(20), listener.accept())
            .await
            .is_err()
    );
}
