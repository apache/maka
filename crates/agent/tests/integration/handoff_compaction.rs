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

use crate::support::{
    agent_loop::{Effect, input, respond},
    context as fixture,
    http::read_request,
};
use maka_agent::RunWork;
use maka_event_log::{EventLog, context::LatestMainContext};
use maka_runtime::{
    context::{CheckpointMode, ModelRequestContext},
    continuation::RunBoundary,
    event::Fact,
    execution::{ModelBinding, WorkspaceIdentity},
    handoff::HandoffIntent,
};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{io::AsyncWriteExt, net::TcpListener, sync::oneshot};
use tokio_util::sync::CancellationToken;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handoff_preserves_conversation_replay_and_compacts_before_its_physical_anchor() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let directory = tempfile::tempdir().unwrap();
        let log = Arc::new(EventLog::open(&directory.path().join("events.sqlite")).await.unwrap());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let (seen, ready) = oneshot::channel();
        let (release, released) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_request(&mut socket).await;
            let chunk = serde_json::json!({"id":"old","object":"chat.completion.chunk","created":1,"model":"old",
                "choices":[{"index":0,"delta":{"reasoning_content":"old-route-thinking","content":"old-answer"},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}});
            let body = format!("data: {chunk}\n\ndata: [DONE]\n\n");
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            let (mut socket, _) = listener.accept().await.unwrap();
            read_request(&mut socket).await;
            seen.send(()).unwrap();
            released.await.unwrap();
            respond(&mut socket, true).await;
            let (mut socket, _) = listener.accept().await.unwrap();
            let summary = read_request(&mut socket).await;
            fixture::respond(&mut socket, fixture::SUMMARY, "stop").await;
            let (mut socket, _) = listener.accept().await.unwrap();
            let main = read_request(&mut socket).await;
            let failure = r#"{"error":{"message":"retry this request","type":"rate_limit_error"}}"#;
            socket.write_all(format!("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 0.01\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{failure}", failure.len()).as_bytes()).await.unwrap();
            let (mut socket, _) = listener.accept().await.unwrap();
            let retried = read_request(&mut socket).await;
            assert_eq!(retried, main, "physical retries preserve the frozen request surface");
            respond(&mut socket, false).await;
            (summary, main)
        });
        let engine = fixture::engine(log.clone());
        let mut prior = fixture::input(&base, "prior", false);
        prior.provider.kind = maka_model::ProviderKind::OpenaiCompatible { name: "fixture".into() };
        prior.provider.model = "old".into();
        prior.configuration.model.as_mut().unwrap().model = "old".into();
        engine.run(prior, CancellationToken::new()).await.unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let effect = Arc::new(Effect { log: log.clone(), count: count.clone() });
        let mut first = input(&base, "first", effect.clone());
        first.configuration.workspace_identity = Some(WorkspaceIdentity::from_marker_id(
            "ef751105-55b5-4d65-a364-646281586a17").unwrap());
        first.configuration.model = Some(ModelBinding {
            connection_id: "connection".into(), connection_slug: "fixture".into(), model: "test".into(),
        });
        first.context = Some(ModelRequestContext {
            provider_id: "openai".into(), context_window: Some(10), declared_window: Some(7),
            model_context_window: None,
        });
        let configuration = first.configuration.clone();
        let context = first.context.clone();
        let source_invocation = first.invocation.clone();
        let running = engine.start(first, CancellationToken::new()).await.unwrap();
        ready.await.unwrap();
        let reservation = running.handoff().unwrap().reserve(HandoffIntent {
            handoff_id: "compact".into(), host_epoch: "host".into(), root_run_id: "run-first".into(),
            successor_run_id: "successor-run".into(), successor_invocation_id: "successor-invocation".into(),
            claim_id: "claim".into(),
        }).unwrap();
        release.send(()).unwrap();
        let pause = reservation.ready().await.unwrap().commit().unwrap().wait().await.unwrap();
        assert_eq!(pause.execution.compaction, maka_runtime::handoff::CompactionBudget::Available);
        assert_eq!(pause.execution.replay_base, None);
        running.wait().await.unwrap();
        engine.drain().await;
        let prefix = log.run_prefix("session", "run-first", None, 100, 128 * 1024).await.unwrap().unwrap();
        let mut successor = input(&base, "next", effect);
        let RunWork::Message { tools, .. } = successor.work else { unreachable!() };
        successor.invocation = pause.intent.successor(&source_invocation);
        successor.configuration = configuration;
        successor.context = context;
        successor.work = RunWork::Handoff {
            source: RunBoundary { invocation: prefix.invocation, high_water: prefix.high_water, digest: prefix.digest },
            pause: Box::new(pause), tools,
        };
        let resumed = fixture::engine(log.clone());
        resumed.run(successor, CancellationToken::new()).await.unwrap();
        resumed.drain().await;
        let (summary, main) = server.await.unwrap();
        assert!(summary["messages"].to_string().contains("question first"));
        assert!(main["messages"].to_string().contains("summary-marker"));
        assert!(!main["messages"].to_string().contains("old-answer"));
        assert_eq!(count.load(Ordering::SeqCst), 1);
        let prefix = log.prefix(100, 256 * 1024).await.unwrap();
        assert!(prefix.events.iter().any(|e| matches!(&e.event.fact,
            Fact::ModelCompleted { output, .. } if output.parts.iter().any(|part| matches!(part,
                maka_runtime::model::ModelPart::Text { text_kind: maka_runtime::model::TextKind::Thinking, .. })))));
        assert!(prefix.events.iter().any(|e| matches!(&e.event.fact,
            Fact::ContextCheckpointRecorded { checkpoint } if checkpoint.mode == CheckpointMode::PreTurn)));
        let latest_sequence = prefix.events.iter().rev().find(|e|
            e.event.invocation.invocation_id == "successor-invocation"
            && matches!(e.event.fact, Fact::ModelCompleted { .. })).unwrap().sequence;
        let source = log.read_model_context("session", None, 100, 256 * 1024).await.unwrap();
        assert!(matches!(source.latest_main, LatestMainContext::Selected(latest)
            if latest.sequence == latest_sequence));
        log.shutdown().await.unwrap();
    }).await.unwrap();
}
