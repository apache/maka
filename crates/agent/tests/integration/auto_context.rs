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

use crate::support::{code_mode, context as fixture, image_projection};
use maka_agent::RunWork;
use maka_event_log::EventLog;
use maka_runtime::{
    context::{CheckpointMode, ModelPurpose, ModelRequestContext},
    event::{Fact, InvocationOutcome},
};
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::{net::TcpListener, sync::Barrier};
use tokio_util::sync::CancellationToken;

fn context(window: Option<u64>) -> Option<ModelRequestContext> {
    Some(ModelRequestContext {
        provider_id: "openai".into(),
        context_window: Some(170),
        model_context_window: Some(200_000),
        declared_window: window,
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resolved_threshold_and_matching_latest_main_route_are_required_for_preturn() {
    for (declared, matching, expected) in [
        (None, true, false),
        (Some(70), false, false),
        (Some(70), true, true),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let log = Arc::new(
            EventLog::open(&directory.path().join("events.sqlite"))
                .await
                .unwrap(),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            fixture::read_request(&mut socket).await;
            fixture::respond(&mut socket, "old-answer", "stop").await;
            let mut requests = Vec::new();
            for summary in if expected {
                vec![true, false]
            } else {
                vec![false]
            } {
                let (mut socket, _) = listener.accept().await.unwrap();
                requests.push(fixture::read_request(&mut socket).await);
                fixture::respond(
                    &mut socket,
                    if summary { fixture::SUMMARY } else { "done" },
                    "stop",
                )
                .await;
            }
            requests
        });
        let worker = fixture::engine(log.clone());
        let mut old = fixture::input(&base, "old", false);
        old.context = context(None);
        worker.run(old, CancellationToken::new()).await.unwrap();
        let mut next = fixture::input(&base, "next", false);
        next.main_output_limit = Some(200_000);
        next.context = context(declared);
        if !matching {
            next.configuration.model.as_mut().unwrap().connection_id = "different".into();
        }
        worker.run(next, CancellationToken::new()).await.unwrap();
        worker.drain().await;
        let requests = server.await.unwrap();
        assert_eq!(
            requests.last().unwrap()["max_tokens"],
            if expected {
                8000
            } else if matching {
                191_930 // 200K capacity, 70 observed retained tokens, 8K growth reserve.
            } else {
                200_000 // Another connection's usage is not a budget for this request.
            }
        );
        let prefix = log.prefix(100, 128 * 1024).await.unwrap();
        let checkpoints: Vec<_> = prefix
            .events
            .iter()
            .filter_map(|event| match &event.event.fact {
                Fact::ContextCheckpointRecorded { checkpoint } => Some(checkpoint),
                _ => None,
            })
            .collect();
        assert_eq!(checkpoints.len(), usize::from(expected));
        if expected {
            assert_eq!(checkpoints[0].mode, CheckpointMode::PreTurn);
            assert!(
                !requests[0]["messages"]
                    .to_string()
                    .contains("question-next"),
                "preturn source excludes current anchor"
            );
            assert!(
                requests[1]["messages"]
                    .to_string()
                    .contains("question-next")
            );
            assert!(!requests[1]["messages"].to_string().contains("old-answer"));
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn midturn_waits_for_all_code_mode_results_and_replays_exact_image_anchor_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = Arc::new(EventLog::open(&path).await.unwrap());
    log.create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    image_projection::artifact(&log, "anchor-image", 8, true).await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let observed = log.clone();
    let server = tokio::spawn(async move {
        let (mut first, _) = listener.accept().await.unwrap();
        fixture::read_request(&mut first).await;
        code_mode::respond(&mut first, true).await;
        let (mut summary, _) = listener.accept().await.unwrap();
        let summary_request = fixture::read_request(&mut summary).await;
        let prefix = observed.prefix(100, 128 * 1024).await.unwrap();
        assert_eq!(
            prefix
                .events
                .iter()
                .filter(|event| matches!(event.event.fact, Fact::ToolSettled { .. }))
                .count(),
            4
        );
        assert!(
            !prefix
                .events
                .iter()
                .any(|event| matches!(event.event.fact, Fact::InvocationEnded { .. }))
        );
        fixture::respond(&mut summary, fixture::SUMMARY, "stop").await;
        let (mut next, _) = listener.accept().await.unwrap();
        let after = fixture::read_request(&mut next).await;
        code_mode::respond(&mut next, true).await;
        // An accepted tool step renews compaction within this same turn.
        let (mut summary, _) = listener.accept().await.unwrap();
        let second_summary = fixture::read_request(&mut summary).await;
        assert!(
            second_summary["messages"]
                .to_string()
                .contains("tool_call_id")
        );
        fixture::respond(&mut summary, fixture::SUMMARY, "stop").await;
        let (mut final_step, _) = listener.accept().await.unwrap();
        fixture::read_request(&mut final_step).await;
        fixture::respond(&mut final_step, "done", "stop").await;
        (summary_request, after)
    });
    let count = Arc::new(AtomicUsize::new(0));
    let effects = Arc::new(code_mode::Effects {
        log: log.clone(),
        count: count.clone(),
        together: Arc::new(Barrier::new(2)),
    });
    let mut input = code_mode::input(&base, "first", effects.clone());
    input.context = context(Some(7));
    input.supports_vision = true;
    input.configuration.model = fixture::input(&base, "unused", false).configuration.model;
    if let RunWork::Message { message, .. } = &mut input.work {
        *message=serde_json::from_value(json!({"text":"question-first","attachments":[image_projection::attachment("anchor-image")]})).unwrap();
    }
    let worker = fixture::engine(log.clone());
    worker.run(input, CancellationToken::new()).await.unwrap();
    worker.drain().await;
    let (summary_request, after) = server.await.unwrap();
    assert!(
        summary_request["messages"]
            .to_string()
            .contains("tool_call_id")
    );
    assert!(after["messages"].to_string().contains("summary-marker"));
    assert!(after["messages"].to_string().contains("image_url"));
    let source = log
        .read_model_context("session", None, 100, 128 * 1024)
        .await
        .unwrap();
    let anchor = source.anchor.as_ref().unwrap().event.id.clone();
    assert!(
        matches!(&source.baseline.as_ref().unwrap().checkpoint.mode,CheckpointMode::MidTurn {anchor_event_id} if anchor_event_id==&anchor)
    );
    assert_eq!(count.load(Ordering::SeqCst), 4);
    let prefix = log.prefix(100, 256 * 1024).await.unwrap();
    assert_eq!(
        prefix
            .events
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
        prefix
            .events
            .iter()
            .filter(|event| matches!(
                event.event.fact,
                Fact::InvocationEnded {
                    outcome: InvocationOutcome::Completed
                }
            ))
            .count(),
        1
    );
    drop(worker);
    drop(effects);
    Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
    let log = Arc::new(EventLog::open(&path).await.unwrap());
    assert_eq!(
        log.read_model_context("session", None, 100, 128 * 1024)
            .await
            .unwrap()
            .anchor
            .unwrap()
            .event
            .id,
        anchor
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = fixture::read_request(&mut socket).await;
        fixture::respond(&mut socket, "reopened", "stop").await;
        request
    });
    let worker = fixture::engine(log);
    let mut next = fixture::input(&base, "reopen", false);
    next.supports_vision = true;
    worker.run(next, CancellationToken::new()).await.unwrap();
    worker.drain().await;
    let next = server.await.unwrap();
    assert!(next["messages"].to_string().contains("question-first"));
    assert!(next["messages"].to_string().contains("image_url"));
}
