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

use crate::support::{context as support, store::SessionFixture};
use maka_agent_facts::context::{
    CheckpointContent, CodexCompatibility, CodexRequestProvenance, ModelRequestContext,
};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, TcpStream},
};
use tokio_util::sync::CancellationToken;

pub(super) fn input(base: &str, id: &str, compact: bool) -> maka_agent_engine::RunInput {
    let mut input = support::input(base, id, compact);
    input.configuration.workspace_identity = Some(
        maka_agent_facts::execution::WorkspaceIdentity::from_marker_id(
            "c193cd58-f929-4ba2-bfb5-6887beaf8132",
        )
        .unwrap(),
    );
    input.provider_id = "chatgpt".into();
    input.provider.adapter = Some("codex-responses".into());
    input.provider.kind = maka_model::ProviderKind::OpenaiResponses;
    // Keep this fixture on HTTP. WebSocket codec behavior has separate adapter tests.
    input
        .provider
        .headers
        .insert("x-test".into(), "native-compaction".into());
    input.provider_options =
        json!({"openai":{"instructions":"Follow the conversation.","store":false}});
    input.provider.capabilities.native_compaction = Some(true);
    input.configuration.compaction_prompt = Some("CUSTOM_TEXT_SUMMARY_MUST_NOT_BE_SENT".into());
    input.context = Some(ModelRequestContext {
        operation: maka_agent_facts::context::ModelOperation::Inference,
        codex: Some(CodexRequestProvenance {
            connection_id: "connection".into(),
            account_id: Some("account-a".into()),
            compatibility: Some(CodexCompatibility {
                comp_hash: "3000".into(),
                fetched_at: 1,
            }),
        }),
        provider_id: "chatgpt".into(),
        context_window: Some(128_000),
        model_context_window: Some(128_000),
        declared_window: Some(108_800),
    });
    input
}
pub(super) async fn respond(socket: &mut TcpStream, item: Value, response_id: &str) {
    respond_with_usage(
        socket,
        item,
        response_id,
        json!({"input_tokens":100,"output_tokens":30}),
    )
    .await;
}
pub(super) async fn respond_with_usage(
    socket: &mut TcpStream,
    item: Value,
    response_id: &str,
    usage: Value,
) {
    let events = [
        json!({"type":"response.output_item.done","item":item}),
        json!({"type":"response.completed","response":{"id":response_id,"model":"test","output":[item],"usage":usage}}),
    ];
    let body = events
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect::<String>();
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}
pub(super) fn message(text: &str) -> Value {
    json!({"id":format!("msg-{text}"),"type":"message","role":"assistant","content":[{"type":"output_text","text":text}]})
}
pub(super) fn native(id: &str) -> Value {
    json!({"id":id,"type":"compaction","encrypted_content":format!("opaque-{id}"),"opaque_extension":{"keep":true}})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_compact_replay_roll_forward_and_restart_preserve_opaque_items() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let mut requests = vec![];
        for (index, item) in [
            message("old-answer"),
            native("cmp-1"),
            message("tail-answer"),
            native("cmp-2"),
            message("reopened"),
        ]
        .into_iter()
        .enumerate()
        {
            let (mut socket, _) = listener.accept().await.unwrap();
            requests.push(support::read_request(&mut socket).await);
            respond(&mut socket, item, &format!("response-{index}")).await;
        }
        requests
    });
    let log = Arc::new(SessionFixture::open(&path).await.unwrap());
    let worker = support::engine();
    for (id, compact) in [
        ("old", false),
        ("compact-1", true),
        ("tail", false),
        ("compact-2", true),
    ] {
        worker
            .run(
                log.store(),
                input(&base, id, compact),
                CancellationToken::new(),
            )
            .await
            .unwrap();
    }
    let baseline = log
        .read_model_view("session", None)
        .await
        .unwrap()
        .baseline
        .unwrap();
    assert!(
        matches!(&baseline.checkpoint.summary,CheckpointContent::CodexNative { estimated_tokens,.. } if *estimated_tokens == 30)
            && baseline.native().unwrap().model_id == "test"
    );
    assert_eq!(baseline.native_item(), Some(&native("cmp-2")));
    assert!(
        !serde_json::to_string(&baseline.checkpoint)
            .unwrap()
            .contains("opaque-cmp-2")
    );
    assert!(baseline.checkpoint.previous_checkpoint_id.is_some());
    worker.drain().await;
    drop(worker);
    Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
    let log = Arc::new(SessionFixture::open(&path).await.unwrap());
    let worker = support::engine();
    worker
        .run(
            log.store(),
            input(&base, "reopened", false),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    worker.drain().await;
    let requests = server.await.unwrap();
    for index in [1, 3] {
        assert_eq!(
            requests[index]["input"].as_array().unwrap().last().unwrap(),
            &json!({"type":"compaction_trigger"})
        );
        assert!(
            !requests[index]
                .to_string()
                .contains("CUSTOM_TEXT_SUMMARY_MUST_NOT_BE_SENT")
        );
    }
    assert!(
        requests[2]["input"]
            .as_array()
            .unwrap()
            .contains(&native("cmp-1"))
    );
    assert!(!requests[2].to_string().contains("old-answer"));
    assert!(
        requests[3]["input"]
            .as_array()
            .unwrap()
            .contains(&native("cmp-1"))
    );
    assert!(
        requests[4]["input"]
            .as_array()
            .unwrap()
            .contains(&native("cmp-2"))
    );
    assert!(!requests[4].to_string().contains("opaque-cmp-1"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disabling_native_compaction_replays_existing_checkpoint_then_installs_text_summary() {
    let directory = tempfile::tempdir().unwrap();
    let log = SessionFixture::open(&directory.path().join("events.sqlite"))
        .await
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let mut requests = vec![];
        for (index, item) in [
            message("old-answer"),
            native("cmp-enabled"),
            message("continued-with-option-off"),
            message("text-summary"),
            message("continued-after-text-compaction"),
        ]
        .into_iter()
        .enumerate()
        {
            let (mut socket, _) = listener.accept().await.unwrap();
            requests.push(support::read_request(&mut socket).await);
            respond(&mut socket, item, &format!("response-{index}")).await;
        }
        requests
    });
    let worker = support::engine();
    for (id, compact, enabled) in [
        ("seed", false, true),
        ("native", true, true),
        ("off", false, false),
        ("text", true, false),
        ("after-text", false, false),
    ] {
        let mut request = input(&base, id, compact);
        request.provider.capabilities.native_compaction = Some(enabled);
        request.configuration.compaction_prompt = Some("Summarize this conversation.".into());
        worker
            .run(log.store(), request, CancellationToken::new())
            .await
            .unwrap();
    }
    worker.drain().await;
    let baseline = log
        .read_model_view("session", None)
        .await
        .unwrap()
        .baseline
        .unwrap();
    assert_eq!(
        baseline.checkpoint.summary,
        CheckpointContent::Text("text-summary".into())
    );
    let requests = server.await.unwrap();
    for request in &requests[2..] {
        assert!(
            !request["input"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| { item["type"] == "compaction_trigger" })
        );
    }
    for request in &requests[2..4] {
        assert!(
            request["input"]
                .as_array()
                .unwrap()
                .contains(&native("cmp-enabled"))
        );
    }
    assert!(
        requests[3]
            .to_string()
            .contains("Summarize this conversation.")
    );
    assert!(!requests[4].to_string().contains("opaque-cmp-enabled"));
    assert!(requests[4].to_string().contains("text-summary"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_native_compaction_keeps_original_history_and_never_falls_back_to_text() {
    let directory = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let mut requests = vec![];
        for index in 0..3 {
            let (mut socket, _) = listener.accept().await.unwrap();
            requests.push(support::read_request(&mut socket).await);
            // A completed ordinary message is not a successful native compaction.
            respond(
                &mut socket,
                message(if index == 0 {
                    "original-answer"
                } else {
                    "ordinary-text"
                }),
                &format!("response-{index}"),
            )
            .await;
        }
        requests
    });
    let log = Arc::new(
        SessionFixture::open(&directory.path().join("events.sqlite"))
            .await
            .unwrap(),
    );
    let worker = support::engine();
    worker
        .run(
            log.store(),
            input(&base, "old", false),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(
        worker
            .run(
                log.store(),
                input(&base, "failed", true),
                CancellationToken::new()
            )
            .await
            .is_err()
    );
    assert!(
        log.read_model_view("session", None)
            .await
            .unwrap()
            .baseline
            .is_none()
    );
    worker
        .run(
            log.store(),
            input(&base, "next", false),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    worker.drain().await;
    let requests = server.await.unwrap();
    assert_eq!(requests.len(), 3);
    assert!(requests[2].to_string().contains("original-answer"));
    assert!(
        !requests[1]
            .to_string()
            .contains("CUSTOM_TEXT_SUMMARY_MUST_NOT_BE_SENT")
    );
    assert_eq!(
        requests[1]["input"].as_array().unwrap().last().unwrap(),
        &json!({"type":"compaction_trigger"})
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_native_stream_cannot_install_an_unfinished_checkpoint() {
    let directory = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let cancellation = CancellationToken::new();
    let server_stop = cancellation.clone();
    let (entered, ready) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut first, _) = listener.accept().await.unwrap();
        support::read_request(&mut first).await;
        respond(&mut first, message("original"), "old-response").await;
        let (mut socket, _) = listener.accept().await.unwrap();
        support::read_request(&mut socket).await;
        let event = json!({"type":"response.output_item.done","item":native("unfinished")});
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {event}\n\n").as_bytes()).await.unwrap();
        entered.send(()).unwrap();
        server_stop.cancelled().await;
    });
    let log = Arc::new(
        SessionFixture::open(&directory.path().join("events.sqlite"))
            .await
            .unwrap(),
    );
    let worker = support::engine();
    worker
        .run(
            log.store(),
            input(&base, "old", false),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let compact = worker.run(
        log.store(),
        input(&base, "cancelled", true),
        cancellation.clone(),
    );
    tokio::pin!(compact);
    tokio::select! {
        result = &mut compact => panic!("native stream must remain incomplete: {result:?}"),
        _ = ready => {},
    }
    cancellation.cancel();
    assert!(compact.await.is_err());
    assert!(
        log.read_model_view("session", None)
            .await
            .unwrap()
            .baseline
            .is_none()
    );
    server.await.unwrap();
    worker.drain().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn continuation_uses_native_prefix_without_mistaking_it_for_a_new_assistant_turn() {
    let directory = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let mut requests = vec![];
        for index in 0..4 {
            let (mut socket, _) = listener.accept().await.unwrap();
            requests.push(support::read_request(&mut socket).await);
            if index == 2 {
                let body = r#"{"error":{"message":"invalid fixture request","type":"invalid_request_error"}}"#;
                socket.write_all(format!("HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            } else {
                respond(
                    &mut socket,
                    if index == 1 {
                        native("baseline")
                    } else {
                        message("answer")
                    },
                    &format!("response-{index}"),
                )
                .await;
            }
        }
        requests
    });
    let log = Arc::new(
        SessionFixture::open(&directory.path().join("events.sqlite"))
            .await
            .unwrap(),
    );
    let worker = support::engine();
    worker
        .run(
            log.store(),
            input(&base, "old", false),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    worker
        .run(
            log.store(),
            input(&base, "compact", true),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let source = input(&base, "paused", false);
    assert!(
        worker
            .run(log.store(), source.clone(), CancellationToken::new())
            .await
            .is_err()
    );
    let boundary = log
        .run_source("session", &source.invocation.run_id, None)
        .await
        .unwrap()
        .unwrap()
        .boundary;
    let mut child = input(&base, "child", false);
    child.configuration = source.configuration;
    child.provider.model = "compatible-target".into();
    child.configuration.model.as_mut().unwrap().model = "compatible-target".into();
    let provenance = child.context.as_mut().unwrap().codex.as_mut().unwrap();
    provenance.connection_id = "other-connection".into();
    provenance.account_id = Some("other-account".into());
    child.request_fingerprint = Some(maka_agent_facts::artifact::content_digest(
        b"native-continuation",
    ));
    child.work = maka_agent_engine::RunWork::Continuation {
        source: boundary,
        tools: Default::default(),
    };
    worker
        .check_continuation(&log.store(), &child, &CancellationToken::new())
        .await
        .unwrap();
    worker
        .run(log.store(), child, CancellationToken::new())
        .await
        .unwrap();
    worker.drain().await;
    let requests = server.await.unwrap();
    assert!(
        requests[3]["input"]
            .as_array()
            .unwrap()
            .contains(&native("baseline"))
    );
    assert!(requests[3].to_string().contains("question-paused"));
    assert!(!requests[3].to_string().contains("question-child"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_hash_change_can_recompact_an_existing_checkpoint_without_new_messages() {
    let directory = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let mut requests = vec![];
        for (index, item) in [
            message("old"),
            native("before"),
            native("after"),
            message("continued"),
        ]
        .into_iter()
        .enumerate()
        {
            let (mut socket, _) = listener.accept().await.unwrap();
            requests.push(support::read_request(&mut socket).await);
            respond(&mut socket, item, &format!("response-{index}")).await;
        }
        requests
    });
    let log = Arc::new(
        SessionFixture::open(&directory.path().join("events.sqlite"))
            .await
            .unwrap(),
    );
    let worker = support::engine();
    worker
        .run(
            log.store(),
            input(&base, "old", false),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    worker
        .run(
            log.store(),
            input(&base, "compact-before", true),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(
        !log.read_model_view("session", None)
            .await
            .unwrap()
            .has_new_history
    );
    let changed = |id: &str, compact| {
        let mut request = input(&base, id, compact);
        request
            .context
            .as_mut()
            .unwrap()
            .codex
            .as_mut()
            .unwrap()
            .compatibility
            .as_mut()
            .unwrap()
            .comp_hash = "4000".into();
        request
    };
    worker
        .run(
            log.store(),
            changed("compact-after", true),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let baseline = log
        .read_model_view("session", None)
        .await
        .unwrap()
        .baseline
        .unwrap();
    assert_eq!(
        baseline
            .native()
            .unwrap()
            .provenance
            .compatibility
            .as_ref()
            .unwrap()
            .comp_hash,
        "4000"
    );
    worker
        .run(
            log.store(),
            changed("next", false),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    worker.drain().await;
    let requests = server.await.unwrap();
    assert!(
        requests[2]["input"]
            .as_array()
            .unwrap()
            .contains(&native("before"))
    );
    assert_eq!(
        requests[2]["input"].as_array().unwrap().last().unwrap(),
        &json!({"type":"compaction_trigger"})
    );
    assert!(
        requests[3]["input"]
            .as_array()
            .unwrap()
            .contains(&native("after"))
    );
}

#[tokio::test]
async fn native_capability_without_subscription_facts_is_rejected_before_dispatch() {
    let directory = tempfile::tempdir().unwrap();
    let log = SessionFixture::open(&directory.path().join("events.sqlite"))
        .await
        .unwrap();
    let worker = maka_agent_engine::Engine::new(
        maka_model::ModelExecutor::new(std::time::Duration::from_secs(5)).unwrap(),
        maka_tools::CodeExecutor::new(Default::default()).unwrap(),
    )
    .unwrap();
    for missing_context in [true, false] {
        let mut request = input(
            "http://127.0.0.1:1/v1",
            if missing_context {
                "missing-context"
            } else {
                "missing-producer"
            },
            true,
        );
        if missing_context {
            request.context = None;
        } else {
            request.context.as_mut().unwrap().codex = None;
            request.provider_id = "openai".into();
        }
        let error = worker
            .run(log.store(), request, CancellationToken::new())
            .await
            .unwrap_err();
        assert!(
            matches!(error, maka_agent_engine::RunError::InvalidInput(ref reason) if reason.contains("ChatGPT producer facts")),
            "{error:?}"
        );
    }
    worker.drain().await;
    assert!(
        log.read_model_view("session", None)
            .await
            .unwrap()
            .baseline
            .is_none()
    );
}
