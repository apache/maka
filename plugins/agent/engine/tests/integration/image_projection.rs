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

use crate::support::{http::read_request, image_projection as support};

use crate::support::store::SessionFixture;
use base64::{Engine as _, engine::general_purpose::STANDARD};

use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::input::InvocationInput;
use maka_agent_facts::tool_call::ToolCallIdentity;
use maka_agent_facts::tool_output::ImageOutput;
use maka_agent_facts::tool_output::ToolOutput;
use maka_agent_facts::tool_output::ToolSuccess;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use support::*;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reopened_images_preserve_complete_accepted_artifacts_and_copied_authority() {
    tokio::time::timeout(Duration::from_secs(180), async {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sqlite");
        let log = SessionFixture::open(&path).await.unwrap();

        let image = png(160, 160).await;
        assert!(image.len() > 64 * 1024, "real encoded media crosses the transport quantum");
        let tiny = png(1, 1).await;
        for id in ["historical", "tool", "fits"] { artifact(&log, id, image.clone()).await; }
        artifact(&log, "invalid", vec![0; image.len()]).await;
        artifact(&log, "tiny", tiny.clone()).await;

        let prior = identity("historical");
        let mut historical = attachment("historical");
        historical["bytes"] = json!(image.len());
        let message = serde_json::from_value(json!({"text":"historical", "attachments":[historical]})).unwrap();
        let facts = [
            Fact::InvocationOpened { input: InvocationInput::Message { source_messages: Vec::new(), content: message, request_fingerprint: None }, configuration: None },
            Fact::ModelRequested { item_acceptance: false, effective_source_digest: None, purpose: maka_agent_facts::context::ModelPurpose::Main, context: None, context_breakdown: None, checkpoint_event_id: None, step_id: "prior-step".into(), model_id: "test".into(),
                source_scope: maka_agent_facts::event::LogScope::Session { id: "session".into() },
                source_high_water: 1, source_digest: "fixture".into(), input_digest: "fixture".into(), route_identity: "fixture".into() },
            Fact::ModelCompleted { step_id: "prior-step".into(), output: crate::support::model_records::completion(prior.clone(), "prior-step", serde_json::from_value::<Vec<maka_agent_facts::model::ModelPart>>(json!([{"kind":"tool_call","call":{"id":"read","name":"Read","input":{"kind":"json","data":{}},"provider_executed":false}},
                    {"kind":"tool_call","call":{"id":"read-large","name":"Read","input":{"kind":"json","data":{}},"provider_executed":false}}])).unwrap(), maka_agent_facts::model::ModelFinishReason::ToolCalls) },
            Fact::ToolDispatched { presentation: None,
        title: None, operation_id: "prior-step:read".into(), call: ToolCallIdentity::provider("prior-step".into(), "read".into()), name: "Read".into(), input: json!({}) },
            Fact::ToolDispatched { presentation: None, title: None, operation_id: "prior-step:read-large".into(), call: ToolCallIdentity::provider("prior-step".into(), "read-large".into()), name: "Read".into(), input: json!({}) },
        ];
        for fact in facts { log.append(&EventWrite::plain(RuntimeEvent::new(prior.clone(), fact)).unwrap()).await.unwrap(); }
        log.append(&EventWrite::tool_success("prior-result".into(), std::time::SystemTime::now(), prior.clone(), "prior-step:read".into(),
            ToolOutput::Image(ImageOutput { detail: Some(maka_agent_facts::tool_output::ImageDetail::High), mime_type: "image/png".into(), reference: serde_json::from_value(attachment("tool")["ref"].clone()).unwrap() }).into()).unwrap().0).await.unwrap();
        let large_bytes = png(3840, 3840).await;
        assert!(large_bytes.len() > 50 * 1024 * 1024, "accepted original remains above 50 MiB");
        let original_size = large_bytes.len() as u64;
        let original_digest = maka_agent_facts::artifact::content_digest(&large_bytes);
        let (large_result, _) = EventWrite::tool_success(
            "prior-large-result".into(), std::time::SystemTime::now(), prior.clone(),
            "prior-step:read-large".into(), ToolSuccess::image(large_bytes, "image/png".into()).unwrap(),
        ).unwrap();

        let generated_id = large_result.projection_artifacts()[0].artifact().id.clone();
        log.append(&large_result).await.unwrap();
        drop(large_result);
        assert_stored_png(&log, &generated_id, original_size, &original_digest).await;
        log.append(&EventWrite::plain(RuntimeEvent::new(prior, Fact::InvocationEnded { outcome: InvocationOutcome::Completed })).unwrap()).await.unwrap();

        let revision = log.get_session::<Value>("session").await.unwrap().unwrap().revision;
        assert!(matches!(log.root().copy_session(maka_event_log::sessions::SessionCopy {
            source_session_id: "session".into(), target_session_id: "branch".into(),
            expected_source_revision: revision, purpose: maka_agent_facts::session::CopyPurpose::Branch { position: maka_agent_facts::session::ForkPosition::End, side_conversation: false },
        }, &json!({}), 2).await.unwrap(), maka_event_log::sessions::SessionCopyResult::Committed(_)));

        log.close().await.unwrap();

        let log = Arc::new(SessionFixture::open(&path).await.unwrap());

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let observed_log = log.clone();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let body = read_request(&mut socket).await;

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
        let engine = engine();
        engine.run(log.store(), input(&base, json!([attachment("invalid"), attachment("missing"), foreign, workspace,
            attachment("fits"), attachment("tiny")])), CancellationToken::new()).await.unwrap();

        let body = server.await.unwrap();
        let mut urls = Vec::new();
        collect_images(&body["messages"], &mut urls);
        assert_eq!(urls.len(), 5, "prior user, typed and generated Read images, and both current images reach the provider");
        for index in [0, 1, 3] { assert_eq!(provider_png(urls[index]), image); }
        assert_eq!(provider_png(urls[4]), tiny);
        let view_digest = assert_whole_image(provider_png(urls[2])).await;
        assert!(body["messages"].as_array().unwrap().iter().any(|message| {
            message["content"].as_array().is_some_and(|parts| {
                parts.iter().any(|part| part["image_url"]["detail"] == "high")
            })
        }), "tool image detail reaches the provider after reopening");
        let text: Vec<_> = message_text(&body["messages"]).collect();
        for name in ["invalid", "missing", "historical", "workspace"] {
            assert!(text.iter().any(|text| text.contains(&format!("Image attachment \"{name}\" could not be loaded"))), "missing error for {name}");
        }
        for reason in ["unsupported_mime", "session_mismatch", "unsupported_ref_kind"] {
            assert!(text.iter().any(|text| text.contains(reason)), "missing reason {reason}");
        }
        assert!(text.iter().all(|text| !text.contains("per-request image budget")));
        drop(text);
        drop(body);

        let prefix = log.prefix(100, 128 * 1024).await.unwrap();
        let canonical = serde_json::to_string(&prefix).unwrap();
        assert!(!canonical.contains("data:image"), "projection must not persist image bytes");
        assert!(canonical.len() < 32 * 1024);
        use maka_event_log :: artifacts :: ArtifactDeletion;
        for (id, expected) in [("historical", ArtifactDeletion::Deleted), ("tool", ArtifactDeletion::Protected), (generated_id.as_str(), ArtifactDeletion::Protected)] {
            assert_eq!(log.delete_user_artifact("session", id).await.unwrap(), expected, "{id}");
        }
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let copied_request = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let body = read_request(&mut socket).await;

            respond(&mut socket).await;
            body
        });

        let mut copied = input(&base, json!([]));
        copied.invocation = identity("branch-current");
        copied.invocation.session_id = "branch".into();
        let branch = log.select("branch").await.unwrap();
        engine.run(branch.store(), copied, CancellationToken::new()).await.unwrap();

        let copied_request = copied_request.await.unwrap();
        let mut inherited_images = Vec::new();
        collect_images(&copied_request["messages"], &mut inherited_images);
        assert_eq!(inherited_images.len(), 3, "copy retains the deleted user upload and both protected tool images through destination-owned references");
        for url in &inherited_images[..2] { assert_eq!(provider_png(url), image); }
        assert_eq!(assert_whole_image(provider_png(inherited_images[2])).await, view_digest);
        let reference = branch.resolve_history_artifact("branch", "session", "historical").await.unwrap().unwrap();
        assert!(message_text(&copied_request["messages"]).any(|text| text.contains(&reference.resource_ref().unwrap())),
            "Read must receive the destination-owned resource URI");
        drop(copied_request);

        let tool_reference = branch.resolve_history_artifact("branch", "session", "tool").await.unwrap().unwrap();
        let maka_agent_facts::attachment::StorageRef::SessionFile { relative_path, .. } = tool_reference else { panic!("owned tool image") };
        assert!(branch.read_tool_result("branch", "prior-result").await.unwrap().unwrap().serialized_result.contains(&relative_path),
            "tool-result Read renders the copied image's locator, not the source artifact ID");
        let generated_reference = branch.resolve_history_artifact("branch", "session", &generated_id).await.unwrap().unwrap();
        let maka_agent_facts::attachment::StorageRef::SessionFile { session_id, relative_path } = generated_reference else { panic!("owned generated image") };
        assert_eq!(session_id, "branch");
        assert_stored_png(&branch, &relative_path, original_size, &original_digest).await;
        assert!(branch.read_tool_result("branch", "prior-large-result").await.unwrap().unwrap().serialized_result.contains(&relative_path),
            "generated tool evidence keeps destination-owned authority after copying");
        let original = log.prefix(100, 128 * 1024).await.unwrap();
        let source_opening = original.events.iter().find(|e| e.event.invocation.invocation_id == "invocation-historical"
            && matches!(e.event.fact, Fact::InvocationOpened { .. })).unwrap();
        assert!(!serde_json::to_string(&source_opening.event).unwrap().contains("history-"),
            "rendering aliases cannot rewrite canonical input");

        engine.drain().await;

    }).await.expect("image projection must make bounded progress");
}

fn provider_png(url: &str) -> Vec<u8> {
    STANDARD
        .decode(url.strip_prefix("data:image/png;base64,").unwrap())
        .unwrap()
}

async fn assert_whole_image(bytes: Vec<u8>) -> String {
    tokio::task::spawn_blocking(move || {
        let image = image::load_from_memory(&bytes).unwrap().to_rgba8();
        assert_eq!(image.dimensions(), (2000, 2000));
        for (x, y, color) in [
            (0, 0, [255, 0, 0, 255]),
            (1999, 0, [0, 255, 0, 255]),
            (0, 1999, [0, 0, 255, 255]),
            (1999, 1999, [255, 255, 0, 255]),
        ] {
            assert_eq!(
                image.get_pixel(x, y).0,
                color,
                "whole source corner at {x},{y}"
            );
        }
        maka_agent_facts::artifact::content_digest(&bytes)
    })
    .await
    .unwrap()
}

fn message_text(messages: &Value) -> impl Iterator<Item = &str> {
    messages.as_array().unwrap().iter().flat_map(|message| {
        let content = &message["content"];
        content.as_str().into_iter().chain(
            content
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|part| part["text"].as_str()),
        )
    })
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn summary_overflow_keeps_media_multipart_and_checkpoint_corrections_as_evidence() {
    use crate::support::context;
    use maka_agent_facts::context::ModelRequestContext;
    use tokio::io::AsyncWriteExt;

    // These are reported historical facts. The fixture proves their delivery,
    // rather than claiming a mock response demonstrates model summary quality.
    const CHECKPOINT: &str = "Goal: recover launch checklist. Failed attempt: deploy returned E42. Remote write outcome_unknown. Background task bg-17 is running; read results at tasks/bg-17.";
    const CORRECTION: &str = "User correction: stage only; retain the rollback checklist. Screenshot evidence is attached.";
    let directory = tempfile::tempdir().unwrap();
    let log = Arc::new(
        SessionFixture::open(&directory.path().join("events.sqlite"))
            .await
            .unwrap(),
    );

    artifact(&log, "summary-evidence", png(8, 8).await).await;
    artifact(&log, "summary-tool-evidence", png(9, 8).await).await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        read_request(&mut socket).await;
        context::respond(&mut socket, "initial work", "stop").await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let baseline = read_request(&mut socket).await;
        assert!(baseline["messages"].to_string().contains(CHECKPOINT));
        context::respond(&mut socket, CHECKPOINT, "stop").await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let recent = read_request(&mut socket).await;
        assert!(recent["messages"].to_string().contains(CORRECTION));
        context::respond(&mut socket, "recent answer", "stop").await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let full = read_request(&mut socket).await;
        let body = json!({"error":{"message":"context exceeded","type":"invalid_request_error","code":"context_length_exceeded"}}).to_string();
        socket.write_all(format!("HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let fitted = read_request(&mut socket).await;
        context::respond(&mut socket, "continued checkpoint", "stop").await;
        (recent, full, fitted)
    });
    let worker = context::engine();
    let mut first = context::input(&base, "first", false);
    if let maka_agent_engine::RunWork::Message { message, .. } = &mut first.work {
        *message = CHECKPOINT.into();
    }
    worker
        .run(log.store(), first, CancellationToken::new())
        .await
        .unwrap();
    worker
        .run(
            log.store(),
            context::input(&base, "baseline", true),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let mut recent = context::input(&base, "recent", false);
    recent.supports_vision = true;
    if let maka_agent_engine::RunWork::Message { message, .. } = &mut recent.work {
        *message = CORRECTION.into();
    }
    worker
        .run(log.store(), recent, CancellationToken::new())
        .await
        .unwrap();
    let historical = identity("summary-media");
    let message = serde_json::from_value(
        json!({"text":CORRECTION,"attachments":[attachment("summary-evidence")]}),
    )
    .unwrap();
    // The synthetic historical request follows its InvocationOpened event.
    let source_high_water = log
        .prefix(200, 512 * 1024)
        .await
        .unwrap()
        .events
        .last()
        .unwrap()
        .sequence
        + 1;
    let facts = [
        Fact::InvocationOpened { input: InvocationInput::Message { source_messages: Vec::new(), content: message, request_fingerprint: None }, configuration: None },
        Fact::ModelRequested { item_acceptance: false, effective_source_digest: None, purpose: maka_agent_facts::context::ModelPurpose::Main, context: None, context_breakdown: None, checkpoint_event_id: None, step_id: "media-step".into(), model_id: "test".into(), source_scope: maka_agent_facts::event::LogScope::Session { id: "session".into() }, source_high_water, source_digest: "fixture".into(), input_digest: "fixture".into(), route_identity: "fixture".into() },
        Fact::ModelCompleted { step_id: "media-step".into(), output: crate::support::model_records::completion(historical.clone(), "media-step", serde_json::from_value::<Vec<maka_agent_facts::model::ModelPart>>(json!([{"kind":"text","text_kind":"text","text":"large historical log ".repeat(4000)},{"kind":"tool_call","call":{"id":"screenshot","name":"Read","input":{"kind":"json","data":{}},"provider_executed":false}}])).unwrap(), maka_agent_facts::model::ModelFinishReason::ToolCalls) },
        Fact::ToolDispatched { presentation: None, title: None, operation_id: "media-step:screenshot".into(), call: ToolCallIdentity::provider("media-step".into(), "screenshot".into()), name: "Read".into(), input: json!({}) },
    ];
    for fact in facts {
        log.append(&EventWrite::plain(RuntimeEvent::new(historical.clone(), fact)).unwrap())
            .await
            .unwrap();
    }
    let result = EventWrite::tool_success(
        "summary-tool-result".into(),
        std::time::SystemTime::now(),
        historical.clone(),
        "media-step:screenshot".into(),
        ToolOutput::Image(ImageOutput {
            detail: Some(maka_agent_facts::tool_output::ImageDetail::High),
            mime_type: "image/png".into(),
            reference: serde_json::from_value(attachment("summary-tool-evidence")["ref"].clone())
                .unwrap(),
        })
        .into(),
    )
    .unwrap()
    .0;
    log.append(&result).await.unwrap();
    log.append(
        &EventWrite::plain(RuntimeEvent::new(
            historical,
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Completed,
            },
        ))
        .unwrap(),
    )
    .await
    .unwrap();
    let canonical_result = log
        .read_tool_result("session", "summary-tool-result")
        .await
        .unwrap()
        .unwrap()
        .serialized_result;
    let mut compact = context::input(&base, "final", true);
    compact.supports_vision = true;
    compact.context = Some(ModelRequestContext {
        provider_id: "fixture".into(),
        context_window: Some(10_000),
        model_context_window: Some(10_000),
        declared_window: None,
    });
    worker
        .run(log.store(), compact, CancellationToken::new())
        .await
        .unwrap();
    worker.drain().await;
    let (recent, full, fitted) = server.await.unwrap();
    let original_prefix = recent["messages"].as_array().unwrap();
    assert_eq!(
        &full["messages"].as_array().unwrap()[..original_prefix.len()],
        original_prefix,
        "the first summary attempt retains the entire captured Main prefix for caching"
    );
    assert_eq!(full["tools"], recent["tools"]);
    assert_eq!(full["messages"][0], fitted["messages"][0]);
    assert_eq!(full["tools"], fitted["tools"]);
    assert!(fitted.to_string().len() < full.to_string().len());
    fn image_parts(value: &Value, parts: &mut Vec<Value>) {
        match value {
            Value::Array(values) => {
                for value in values {
                    image_parts(value, parts);
                }
            }
            Value::Object(fields) => {
                if fields.get("type").and_then(Value::as_str) == Some("image_url") {
                    parts.push(value.clone());
                } else {
                    for value in fields.values() {
                        image_parts(value, parts);
                    }
                }
            }
            _ => {}
        }
    }
    let mut original_parts = Vec::new();
    let mut fitted_parts = Vec::new();
    image_parts(&full["messages"], &mut original_parts);
    image_parts(&fitted["messages"], &mut fitted_parts);
    assert_eq!(
        fitted_parts, original_parts,
        "media detail metadata survives fitting with its payload"
    );
    let mut original_images = Vec::new();
    let mut fitted_images = Vec::new();
    collect_images(&full["messages"], &mut original_images);
    collect_images(&fitted["messages"], &mut fitted_images);
    assert_eq!(original_images.len(), 2);
    assert_eq!(
        fitted_images, original_images,
        "selected small screenshot remains an actual image part with identical payload"
    );
    let encoded_image = original_images[0]
        .strip_prefix("data:image/png;base64,")
        .unwrap();
    let mut text_parts = Vec::new();
    for message in fitted["messages"].as_array().unwrap() {
        if let Some(text) = message["content"].as_str() {
            text_parts.push(text);
        } else if let Some(parts) = message["content"].as_array() {
            text_parts.extend(parts.iter().filter_map(|part| part["text"].as_str()));
        }
    }
    let text = text_parts.join("\n");
    assert!(
        text.contains(CHECKPOINT),
        "previous checkpoint must remain available with failed, unknown and running work"
    );
    assert!(
        text.contains(CORRECTION),
        "later user correction must accompany the previous checkpoint"
    );
    assert!(
        !text.contains(encoded_image),
        "media bytes must never become historical text during fitting"
    );
    for image in original_images {
        assert!(!text.contains(image.strip_prefix("data:image/png;base64,").unwrap()));
    }
    assert_eq!(
        log.read_tool_result("session", "summary-tool-result")
            .await
            .unwrap()
            .unwrap()
            .serialized_result,
        canonical_result,
        "summary fitting leaves canonical media evidence untouched"
    );
    assert_eq!(
        log.read_model_view("session", None)
            .await
            .unwrap()
            .baseline
            .unwrap()
            .checkpoint
            .summary
            .text,
        "continued checkpoint"
    );
}
