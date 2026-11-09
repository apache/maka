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
    context::{SUMMARY, respond},
    http::read_request,
    native::NativeFixture,
};
use maka_agent_api::contract::{BackendPreference, CompactResult, SendResult};
use maka_agent_facts::{
    context::ModelPurpose,
    durable::{Fact, Terminal},
};
use serde_json::json;
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stopping_summary_drains_attempt_without_checkpoint_or_retry() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let configuration = serde_json::from_value(json!({
            "workspaceRoots":[{"label":"Workspace","path":workspace}],
            "permissions":{"access":"workspace_write","requestPermissions":true}
        })).unwrap();
        let f = NativeFixture::open(directory.path(), configuration).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let model = f.configure_model(&base, "gpt-4.1", "fixture").await.unwrap();
        let backend = BackendPreference::Model {
            connection_id: model.connection_id.clone(),
            model_id: model.model_id.clone(),
            thinking_level: None,
        };
        let session = f.create("Summary stop", &workspace, Some(backend)).await.unwrap();
        let (seen, ready) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut old, _) = listener.accept().await.unwrap();
            let first = read_request(&mut old).await;
            respond(&mut old, SUMMARY, "stop").await;
            let (mut summary, _) = listener.accept().await.unwrap();
            let second = read_request(&mut summary).await;
            summary.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
            ).await.unwrap();
            let delta = json!({"id":"summary","object":"chat.completion.chunk","created":1,"model":"test",
                "choices":[{"index":0,"delta":{"content":"private unfinished summary"},"finish_reason":null}]});
            summary.write_all(format!("data: {delta}\n\n").as_bytes()).await.unwrap();
            seen.send(()).unwrap();
            let mut bytes = Vec::new();
            let _ = summary.read_to_end(&mut bytes).await;
            [first, second]
        });
        let mut changes = f.state.subscribe().unwrap();
        let old = match f.send(&session, "question-old", None).await.unwrap() {
            SendResult::Started { run_id, .. } => run_id,
            SendResult::Queued { message_id, .. } => loop {
                changes.borrow_and_update();
                match f.state.queue().resolve_message(session.clone(), message_id.clone()).await.unwrap() {
                    maka_agent_state::queue::MessageResolution::Delivered { run, .. } => break run,
                    maka_agent_state::queue::MessageResolution::Pending => changes.changed().await.unwrap(),
                    observed => panic!("queued original message did not deliver: {observed:?}"),
                }
            },
            _ => panic!("first message must admit its original queued message or Run"),
        };
        assert_eq!(f.wait_terminal(old).await.unwrap().terminal, Some(Terminal::Completed));
        let compact = f.mutation_value("compact", json!({"sessionId":session,"model":model})).await.unwrap();
        let CompactResult::Started { execution } = serde_json::from_value(compact).unwrap() else {
            panic!("manual compaction must admit a Summary Run")
        };
        ready.await.unwrap();
        let stopped = f.mutation_value("stop", json!({"sessionId":session,"runId":execution.run_id})).await.unwrap();
        assert_eq!(stopped["requested"], true);
        let view = f.wait_terminal(execution.run_id).await.unwrap();
        assert_eq!(view.terminal, Some(Terminal::Cancelled));
        assert!(view.stopped);
        assert_eq!(view.attempts.len(), 1, "Stop cannot create a summary retry");
        let attempt = view.attempts.values().next().unwrap();
        assert!(attempt.interrupted.is_some(), "the original attempt must be interrupted");
        let request = f.state.request(view.run, attempt.step).await.unwrap();
        assert_eq!(request.accounting.purpose, ModelPurpose::Summary);
        assert!(view.baseline.is_none());
        assert!(f.state.frontier(old).await.unwrap().baseline.is_none());
        let facts = f.state.history(view.run, 0, 256).await.unwrap();
        assert!(!facts.iter().any(|fact| matches!(fact.fact, Fact::ModelObserved { .. })),
            "cancelled Summary cannot publish private model parts");
        assert!(!serde_json::to_string(&facts).unwrap().contains("private unfinished summary"));
        assert_eq!(facts.iter().filter(|fact| matches!(fact.fact, Fact::ModelAttemptAdmitted { .. })).count(), 1);
        assert!(!facts.iter().any(|fact| matches!(fact.fact, Fact::ContextCompacted { .. })));
        let observing = f.query("observe", json!({"sessionId":session})).await.unwrap();
        let history = f.query("history", json!({
            "sessionId":session,"through":observing["through"],"position":{"kind":"start"}
        })).await.unwrap();
        assert!(!history.to_string().contains("private unfinished summary"),
            "cancelled private summary prose must not become delivered conversation history");
        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 2);
        f.shutdown().await.unwrap();
    }).await.unwrap();
}
