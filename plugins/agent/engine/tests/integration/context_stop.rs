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

use crate::support::context as support;
use crate::support::store::SessionFixture;
use maka_agent_engine::RunError;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::ModelInterruption;
use std::sync::Arc;
use support::*;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_util::sync::CancellationToken;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stopping_summary_drains_attempt_without_checkpoint_or_retry() {
    let directory = tempfile::tempdir().unwrap();
    let log = Arc::new(
        SessionFixture::open(&directory.path().join("events.sqlite"))
            .await
            .unwrap(),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let (seen, ready) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut old, _) = listener.accept().await.unwrap();
        read_request(&mut old).await;
        respond(&mut old, SUMMARY, "stop").await;
        let (mut summary, _) = listener.accept().await.unwrap();
        read_request(&mut summary).await;
        summary
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        seen.send(()).unwrap();
        let mut bytes = Vec::new();
        let _ = summary.read_to_end(&mut bytes).await;
    });
    let worker = engine();
    worker
        .run(
            log.store(),
            input(&base, "old", false),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let running = worker
        .start(
            log.store(),
            input(&base, "stop", true),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    ready.await.unwrap();
    running.cancel();
    assert!(matches!(
        running.wait().await,
        Err(RunError::Cancelled) | Err(RunError::Model(maka_model::ModelError::Cancelled))
    ));
    worker.drain().await;
    server.await.unwrap();
    let prefix = log.prefix(100, 128 * 1024).await.unwrap();
    let stopped: Vec<_> = prefix
        .events
        .iter()
        .filter(|event| event.event.invocation.invocation_id == "invocation-stop")
        .collect();
    assert_eq!(
        stopped
            .iter()
            .filter(|event| matches!(event.event.fact, Fact::ModelRequested { .. }))
            .count(),
        1
    );
    assert!(stopped.iter().any(|event| matches!(
        event.event.fact,
        Fact::ModelInterrupted {
            status: ModelInterruption::Cancelled,
            model_failure: None,
            ..
        }
    )));
    assert!(stopped.iter().any(|event| matches!(
        event.event.fact,
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Cancelled { .. }
        }
    )));
    assert!(
        !prefix
            .events
            .iter()
            .any(|event| matches!(event.event.fact, Fact::ContextCheckpointRecorded { .. }))
    );
    assert!(
        log.read_model_view("session", None)
            .await
            .unwrap()
            .baseline
            .is_none()
    );
}
