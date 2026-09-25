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

use crate::support::context as fixture;
use maka_agent::{RunError, RunWork};
use maka_event_log::EventLog;
use maka_model::ModelError;
use maka_runtime::{
    context::{ModelPurpose, ModelRequestContext},
    event::Fact,
};
use serde_json::json;
use std::sync::Arc;
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, TcpStream},
};
use tokio_util::sync::CancellationToken;

async fn overflow(socket: &mut TcpStream, observed: bool) {
    let error = json!({"error":{"message":"request exceeds context","type":"invalid_request_error","code":"context_length_exceeded"}});
    let (status, media, body) = if observed {
        let chunk = json!({"id":"partial","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"content":"already-observed"},"finish_reason":null}]});
        (
            "200 OK",
            "text/event-stream",
            format!("data: {chunk}\n\ndata: {error}\n\n"),
        )
    } else {
        ("400 Bad Request", "application/json", error.to_string())
    };
    socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: {media}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn overflow_recovers_once_only_without_output_and_with_remaining_main_budget() {
    for (observed, budget) in [(false, 2), (true, 2), (false, 1)] {
        let recover = !observed && budget > 1;
        let directory = tempfile::tempdir().unwrap();
        let log = Arc::new(
            EventLog::open(&directory.path().join("events.sqlite"))
                .await
                .unwrap(),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut old, _) = listener.accept().await.unwrap();
            fixture::read_request(&mut old).await;
            fixture::respond(&mut old, "old-answer", "stop").await;
            let (mut rejected, _) = listener.accept().await.unwrap();
            let rejected_request = fixture::read_request(&mut rejected).await;
            assert_eq!(rejected_request["max_tokens"], 128_000);
            overflow(&mut rejected, observed).await;
            if recover {
                let (mut summary, _) = listener.accept().await.unwrap();
                let request = fixture::read_request(&mut summary).await;
                assert!(
                    request["messages"]
                        .to_string()
                        .contains("Now write the structured summary")
                );
                fixture::respond(&mut summary, fixture::SUMMARY, "stop").await;
                let (mut next, _) = listener.accept().await.unwrap();
                let request = fixture::read_request(&mut next).await;
                assert!(request["messages"].to_string().contains("summary-marker"));
                assert_eq!(request["max_tokens"], 8000);
                fixture::respond(&mut next, "done", "stop").await;
            }
        });
        let worker = fixture::engine(log.clone());
        worker
            .run(
                fixture::input(&base, "old", false),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let mut next = fixture::input(&base, "overflow", false);
        next.main_output_limit = Some(128_000);
        if let RunWork::Message { max_steps, .. } = &mut next.work {
            *max_steps = budget;
        }
        let result = worker.run(next, CancellationToken::new()).await;
        if recover {
            result.unwrap();
        } else {
            assert!(
                matches!(result,Err(RunError::Model(ModelError::ContextOverflow {observed_output})) if observed_output==observed)
            );
        }
        worker.drain().await;
        server.await.unwrap();
        let prefix = log.prefix(100, 256 * 1024).await.unwrap();
        let events: Vec<_> = prefix
            .events
            .iter()
            .filter(|event| event.event.invocation.invocation_id == "invocation-overflow")
            .collect();
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(
                    event.event.fact,
                    Fact::ModelRequested {
                        purpose: ModelPurpose::Main,
                        ..
                    }
                ))
                .count(),
            if recover { 2 } else { 1 }
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(
                    event.event.fact,
                    Fact::ModelRequested {
                        purpose: ModelPurpose::Summary,
                        ..
                    }
                ))
                .count(),
            usize::from(recover)
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event.event.fact, Fact::ModelInterrupted { .. }))
                .count(),
            1
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn proactive_failure_spends_the_same_budget_as_overflow_recovery() {
    let directory = tempfile::tempdir().unwrap();
    let log = Arc::new(
        EventLog::open(&directory.path().join("events.sqlite"))
            .await
            .unwrap(),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut old, _) = listener.accept().await.unwrap();
        fixture::read_request(&mut old).await;
        fixture::respond(&mut old, "old-answer", "stop").await;
        for _ in 0..2 {
            let (mut summary, _) = listener.accept().await.unwrap();
            let request = fixture::read_request(&mut summary).await;
            assert!(
                request["messages"]
                    .to_string()
                    .contains("Now write the structured summary")
            );
            fixture::respond(&mut summary, "malformed", "stop").await;
        }
        let (mut main, _) = listener.accept().await.unwrap();
        let request = fixture::read_request(&mut main).await;
        assert!(request["messages"].to_string().contains("old-answer"));
        assert!(!request["messages"].to_string().contains("malformed"));
        overflow(&mut main, false).await;
    });
    let worker = fixture::engine(log.clone());
    let mut old = fixture::input(&base, "old", false);
    old.context = Some(ModelRequestContext {
        provider_id: "openai".into(),
        context_window: Some(170),
        declared_window: None,
        model_context_window: None,
    });
    worker.run(old, CancellationToken::new()).await.unwrap();
    let mut next = fixture::input(&base, "latched", false);
    next.context = Some(ModelRequestContext {
        provider_id: "openai".into(),
        context_window: Some(170),
        declared_window: Some(70),
        model_context_window: None,
    });
    if let RunWork::Message { max_steps, .. } = &mut next.work {
        *max_steps = 3;
    }
    assert!(matches!(
        worker.run(next, CancellationToken::new()).await,
        Err(RunError::Model(ModelError::ContextOverflow {
            observed_output: false
        }))
    ));
    worker.drain().await;
    server.await.unwrap();
    let prefix = log.prefix(100, 256 * 1024).await.unwrap();
    assert!(
        !prefix
            .events
            .iter()
            .any(|event| matches!(event.event.fact, Fact::ContextCheckpointRecorded { .. }))
    );
    let events: Vec<_> = prefix
        .events
        .iter()
        .filter(|event| event.event.invocation.invocation_id == "invocation-latched")
        .collect();
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(
                event.event.fact,
                Fact::ModelRequested {
                    purpose: ModelPurpose::Summary,
                    ..
                }
            ))
            .count(),
        2
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(
                event.event.fact,
                Fact::ModelRequested {
                    purpose: ModelPurpose::Main,
                    ..
                }
            ))
            .count(),
        1
    );
}
