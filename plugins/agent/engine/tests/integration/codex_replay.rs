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

use super::codex_compaction::{input, message, native, respond};
use crate::support::{
    context as support,
    store::{RootFixture, SessionFixture},
};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::{io::AsyncWriteExt, net::TcpListener};
use tokio_util::sync::CancellationToken;

fn select(input: &mut maka_agent_engine::RunInput, model: &str, hash: Option<&str>, account: &str) {
    input.provider.model = model.into();
    let binding = input.configuration.model.as_mut().unwrap();
    binding.model = model.into();
    binding.connection_id = format!("connection-{account}");
    let provenance = input.context.as_mut().unwrap().codex.as_mut().unwrap();
    provenance.connection_id = binding.connection_id.clone();
    provenance.account_id = Some(account.into());
    provenance.compatibility = hash.map(|hash| maka_agent_facts::context::CodexCompatibility {
        comp_hash: hash.into(),
        fetched_at: 1,
    });
}
fn reasoning() -> Value {
    json!({"type":"reasoning","id":"reason-original","encrypted_content":"opaque-original", "summary":[{"type":"summary_text","text":"visible summary"}]})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reasoning_replay_uses_producing_evidence_across_models_and_accounts() {
    tokio::time::timeout(std::time::Duration::from_secs(90), async {
        let directory = tempfile::tempdir().unwrap();
        let root = RootFixture::open(&directory.path().join("events.sqlite")).await.unwrap();
        let worker = support::engine();
        for (index, (source_model, source_hash, source_codex, target_model, target_hash, target_codex, expected)) in [
            ("model-a", Some("3000"), true, "model-b", Some("3000"), true, true),
            ("model-a", Some("3000"), true, "model-b", Some("4000"), true, false),
            ("model-a", None, true, "model-b", Some("3000"), true, false),
            ("model-a", Some("3000"), true, "model-b", None, true, false),
            ("model-a", None, true, "model-a", None, true, true),
            ("model-a", Some("3000"), true, "model-a", Some("4000"), true, false),
            ("model-a", Some("3000"), false, "model-a", Some("3000"), true, false),
            ("model-a", Some("3000"), true, "model-a", Some("3000"), false, false),
        ].into_iter().enumerate() {
            let session = format!("matrix-{index}");
            root.create_session(&session, "fixture", &json!({}), 1).await.unwrap();
            let log = root.select(&session).await.unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                support::read_request(&mut socket).await;
                respond(&mut socket, reasoning(), "source-response").await;
                let (mut socket, _) = listener.accept().await.unwrap();
                let sent = support::read_request(&mut socket).await;
                if index == 0 {
                    let body = r#"{"error":{"message":"retry","type":"rate_limit_error"}}"#;
                    socket.write_all(format!("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 0.01\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
                    let (mut retry, _) = listener.accept().await.unwrap();
                    assert_eq!(support::read_request(&mut retry).await, sent, "physical retry preserves the opaque reasoning request");
                    respond(&mut retry, message("target-answer"), "target-response").await;
                    return sent;
                }
                respond(&mut socket, message("target-answer"), "target-response").await;
                sent
            });
            let mut source = input(&base, &format!("source-{index}"), false);
            source.invocation.session_id = session.clone();
            select(&mut source, source_model, source_hash, "account-a");
            if !source_codex { source.context.as_mut().unwrap().codex = None; }
            worker.run(log.store(), source, CancellationToken::new()).await.unwrap();
            let mut target = input(&base, &format!("target-{index}"), false);
            target.invocation.session_id = session;
            select(&mut target, target_model, target_hash, "account-b");
            if !target_codex { target.context.as_mut().unwrap().codex = None; }
            worker.run(log.store(), target, CancellationToken::new()).await.unwrap();
            let sent = server.await.unwrap();
            let items = sent["input"].as_array().unwrap();
            assert_eq!(items.contains(&reasoning()), expected, "{source_model}/{source_hash:?}/{source_codex} -> {target_model}/{target_hash:?}/{target_codex}: {sent}");
            assert!(sent.to_string().contains("question-source"));
            assert!(sent.to_string().contains("question-target"));
        }
        worker.drain().await;
        root.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compatible_native_switch_replays_and_recompacts_across_accounts_after_restart() {
    tokio::time::timeout(std::time::Duration::from_secs(45), async {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sqlite");
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let mut requests = vec![];
            for (index, item) in [
                message("old-answer"),
                native("original"),
                message("new-answer"),
                native("successor"),
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
        for (id, compact) in [("source", false), ("compact-a", true)] {
            let mut request = input(&base, id, compact);
            select(&mut request, "model-a", Some("3000"), "account-a");
            worker
                .run(log.store(), request, CancellationToken::new())
                .await
                .unwrap();
        }
        worker.drain().await;
        drop(worker);
        Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
        let log = Arc::new(SessionFixture::open(&path).await.unwrap());
        let worker = support::engine();
        for (id, compact) in [("target", false), ("compact-b", true)] {
            let mut request = input(&base, id, compact);
            select(&mut request, "model-b", Some("3000"), "account-b");
            worker
                .run(log.store(), request, CancellationToken::new())
                .await
                .unwrap();
        }
        worker.drain().await;
        let requests = server.await.unwrap();
        for sent in &requests[2..] {
            assert_eq!(sent["model"], "model-b");
            let items = sent["input"].as_array().unwrap();
            assert_eq!(
                items.iter().find(|item| item["role"] != "system"),
                Some(&native("original"))
            );
            assert!(sent.to_string().contains("question-target"));
            assert!(!sent.to_string().contains("old-answer"));
        }
        assert_eq!(
            requests[3]["input"].as_array().unwrap().last().unwrap()["type"],
            "compaction_trigger"
        );
        assert_eq!(
            log.read_model_view("session", None)
                .await
                .unwrap()
                .baseline
                .unwrap()
                .native_item(),
            Some(&native("successor"))
        );
        log.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn incompatible_native_switch_stops_before_target_inference_and_retains_checkpoint() {
    for hash in [Some("different"), None] {
        let directory = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for (index, item) in [message("old"), native("original")].into_iter().enumerate() {
                let (mut socket, _) = listener.accept().await.unwrap();
                support::read_request(&mut socket).await;
                respond(&mut socket, item, &format!("response-{index}")).await;
            }
            listener
        });
        let log = Arc::new(
            SessionFixture::open(&directory.path().join("events.sqlite"))
                .await
                .unwrap(),
        );
        let worker = support::engine();
        for (id, compact) in [("source", false), ("compact-a", true)] {
            worker
                .run(
                    log.store(),
                    input(&base, id, compact),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
        }
        let listener = server.await.unwrap();
        let mut target = input(&base, "target", false);
        select(&mut target, "model-b", hash, "account-b");
        let error = worker
            .run(log.store(), target, CancellationToken::new())
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("compatible ChatGPT state"),
            "{error}"
        );
        assert_eq!(
            log.read_model_view("session", None)
                .await
                .unwrap()
                .baseline
                .unwrap()
                .native_item(),
            Some(&native("original"))
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
        worker.drain().await;
        log.shutdown().await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compatible_continuation_keeps_original_reasoning_and_user_boundary() {
    use tokio::io::AsyncWriteExt;
    let directory = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let mut requests = vec![];
        for index in 0..3 {
            let (mut socket, _) = listener.accept().await.unwrap();
            requests.push(support::read_request(&mut socket).await);
            if index == 1 {
                let body =
                    r#"{"error":{"message":"paused fixture","type":"invalid_request_error"}}"#;
                socket.write_all(format!("HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            } else {
                respond(
                    &mut socket,
                    if index == 0 {
                        reasoning()
                    } else {
                        message("continued")
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
            input(&base, "source", false),
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
    select(&mut child, "model-b", Some("3000"), "account-b");
    child.request_fingerprint = Some(maka_agent_facts::artifact::content_digest(
        b"reasoning-continuation",
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
        requests[2]["input"]
            .as_array()
            .unwrap()
            .contains(&reasoning())
    );
    assert!(requests[2].to_string().contains("question-paused"));
    assert!(!requests[2].to_string().contains("question-child"));
    log.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn plaintext_target_keeps_visible_reasoning_without_opaque_state() {
    let directory = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut source, _) = listener.accept().await.unwrap();
        support::read_request(&mut source).await;
        respond(&mut source, reasoning(), "source").await;
        let (mut target, _) = listener.accept().await.unwrap();
        let sent = support::read_request(&mut target).await;
        support::respond(&mut target, "done", "stop").await;
        sent
    });
    let log = SessionFixture::open(&directory.path().join("events.sqlite"))
        .await
        .unwrap();
    let worker = support::engine();
    worker
        .run(
            log.store(),
            input(&base, "source", false),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let mut target = support::input(&base, "target", false);
    target.provider.kind = maka_model::ProviderKind::OpenaiCompatible {
        name: "fixture".into(),
    };
    target.provider.adapter = Some("chat-completions".into());
    target.context = None;
    worker
        .run(log.store(), target, CancellationToken::new())
        .await
        .unwrap();
    worker.drain().await;
    let sent = server.await.unwrap();
    let body = sent.to_string();
    assert!(body.contains("visible summary"), "{body}");
    assert!(!body.contains("opaque-original"), "{body}");
    log.shutdown().await.unwrap();
}
