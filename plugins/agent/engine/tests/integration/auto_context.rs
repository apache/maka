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

use crate::support::store::SessionFixture;
use crate::support::{code_mode, context as fixture, image_projection};
use maka_agent_engine::RunWork;
use maka_agent_facts::context::CheckpointMode;
use maka_agent_facts::context::ModelPurpose;
use maka_agent_facts::context::ModelRequestContext;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::InvocationOutcome;
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::{net::TcpListener, sync::Barrier};
use tokio_util::sync::CancellationToken;

#[path = "auto_context/background.rs"]
mod background;

fn context(window: Option<u64>) -> Option<ModelRequestContext> {
    Some(ModelRequestContext {
        provider_id: "openai".into(),
        context_window: Some(170_000),
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
            SessionFixture::open(&directory.path().join("events.sqlite"))
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
            let mut main = None;
            for _ in 0..if expected { 2 } else { 1 } {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = fixture::read_request(&mut socket).await;
                if request["messages"].to_string().contains(
                    maka_agent_facts::context::default_compaction_prompt(
                        maka_agent_facts::language::Language::En,
                    )
                    .lines()
                    .next()
                    .unwrap(),
                ) {
                    fixture::respond(&mut socket, fixture::SUMMARY, "stop").await;
                } else {
                    main = Some(socket);
                }
                requests.push(request);
            }
            fixture::respond(main.as_mut().unwrap(), "done", "stop").await;
            requests
        });
        let worker = fixture::engine();
        let mut old = fixture::input(&base, "old", false);
        old.context = context(None);
        worker
            .run(log.store(), old, CancellationToken::new())
            .await
            .unwrap();
        let mut next = fixture::input(&base, "next", false);
        next.main_output_limit = Some(200_000);
        next.context = context(declared);
        if !matching {
            next.configuration.model.as_mut().unwrap().connection_id = "different".into();
        }
        worker
            .run(log.store(), next, CancellationToken::new())
            .await
            .unwrap();
        worker.drain().await;
        let requests = server.await.unwrap();
        let (summaries, mains): (Vec<_>, Vec<_>) = requests.iter().partition(|request| {
            request["messages"].to_string().contains(
                maka_agent_facts::context::default_compaction_prompt(
                    maka_agent_facts::language::Language::En,
                )
                .lines()
                .next()
                .unwrap(),
            )
        });
        assert_eq!(summaries.len(), usize::from(expected));
        assert_eq!(mains.len(), 1);
        let output = mains[0]["max_tokens"].as_u64().unwrap();
        if matching {
            // Proactive work runs alongside the main request. Until adoption,
            // the matching route still uses its retained provider usage.
            assert_eq!(output, 191_930);
        } else {
            assert!((199_000..200_000).contains(&output));
        }
        let prefix = log.prefix(100, 128 * 1024).await.unwrap();
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
            usize::from(expected)
        );
        if expected {
            assert!(
                !summaries[0]["messages"]
                    .to_string()
                    .contains("question-next"),
                "preturn source excludes current anchor"
            );
            assert!(mains[0]["messages"].to_string().contains("question-next"));
            assert!(mains[0]["messages"].to_string().contains("old-answer"));
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn midturn_compaction_keeps_image_references_without_replaying_messages() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = Arc::new(SessionFixture::open(&path).await.unwrap());

    image_projection::artifact(&log, "anchor-image", 8, true).await;
    let mut image: maka_agent_facts::attachment::AttachmentRef =
        serde_json::from_value(image_projection::attachment("anchor-image")).unwrap();
    image.bytes = 8;
    let image_reference = image.storage_ref.resource_ref().unwrap();
    let summary_text = format!("{}\nRequired image: {image_reference}", fixture::SUMMARY);
    let retained_summary = summary_text.clone();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let observed = log.clone();
    let server = tokio::spawn(async move {
        let (mut first, _) = listener.accept().await.unwrap();
        let original = fixture::read_request(&mut first).await;
        assert!(original["messages"].to_string().contains("question-first"));
        assert!(original["messages"].to_string().contains("image_url"));
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
        fixture::respond(&mut summary, &retained_summary, "stop").await;
        let (mut next, _) = listener.accept().await.unwrap();
        let after = fixture::read_request(&mut next).await;
        code_mode::respond(&mut next, true).await;
        // An accepted tool step renews compaction within this same turn.
        let (mut summary, _) = listener.accept().await.unwrap();
        let second_summary = fixture::read_request(&mut summary).await;
        let messages = second_summary["messages"].to_string();
        assert!(messages.contains("tool_call_id"));
        assert!(messages.contains("Required image:"));
        assert!(!messages.contains("question-first"));
        assert!(!messages.contains("image_url"));
        fixture::respond(&mut summary, &retained_summary, "stop").await;
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
    // This test needs adoption before the next main request. Real prompt
    // pressure requires that boundary; a usage threshold alone runs in the background.
    input.context.as_mut().unwrap().context_window = Some(4096);
    input.configuration.system_prompt = Some(maka_agent_facts::execution::SystemPrompt {
        sources: Vec::new(),
        text: "main prompt pressure ".repeat(600),
        policy_revision: 1,
    });
    input.supports_vision = true;
    input.configuration.model = fixture::input(&base, "unused", false).configuration.model;
    if let RunWork::Message { message, .. } = &mut input.work {
        message.text = "question-first".into();
        message.attachments = Some(vec![image]);
    }
    let worker = fixture::engine();
    worker
        .run(log.store(), input, CancellationToken::new())
        .await
        .unwrap();
    worker.drain().await;
    let (summary_request, after) = server.await.unwrap();
    assert!(
        summary_request["messages"]
            .to_string()
            .contains("tool_call_id")
    );
    assert!(after["messages"].to_string().contains("summary-marker"));
    assert!(after["messages"].to_string().contains(&image_reference));
    assert!(!after["messages"].to_string().contains("question-first"));
    assert!(!after["messages"].to_string().contains("image_url"));
    let source = log.read_model_view("session", None).await.unwrap();
    let checkpoint = &source.baseline.as_ref().unwrap().checkpoint;
    assert!(matches!(checkpoint.mode, CheckpointMode::MidTurn { .. }));
    assert_eq!(checkpoint.summary.text, summary_text);
    let checkpoint_id = source.baseline.unwrap().event_id;
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
    let log = Arc::new(SessionFixture::open(&path).await.unwrap());
    assert_eq!(
        log.read_model_view("session", None)
            .await
            .unwrap()
            .baseline
            .unwrap()
            .event_id,
        checkpoint_id
    );
    let address = maka_agent_facts::read::ResourceAddress::parse(&image_reference)
        .unwrap()
        .unwrap();
    assert_eq!(
        log.resolve_read_resource("session", address.clone())
            .await
            .unwrap(),
        Some(address)
    );
    let image = log
        .read_artifact_chunk("session", "anchor-image", 0, 8)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(image.bytes, b"\x89PNG\r\n\x1a\n");
    let source = log
        .get_session::<serde_json::Value>("session")
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        log.root()
            .copy_session(
                maka_event_log::sessions::SessionCopy {
                    source_session_id: "session".into(),
                    target_session_id: "branch".into(),
                    expected_source_revision: source.revision,
                    purpose: maka_agent_facts::session::CopyPurpose::Branch {
                        position: maka_agent_facts::session::ForkPosition::End,
                        side_conversation: false,
                    },
                },
                &source.configuration,
                100,
            )
            .await
            .unwrap(),
        maka_event_log::sessions::SessionCopyResult::Committed(_)
    ));
    let branch = log.select("branch").await.unwrap();
    assert_eq!(
        branch
            .read_model_view("branch", None)
            .await
            .unwrap()
            .baseline
            .unwrap()
            .checkpoint
            .summary
            .text,
        summary_text
    );
    let address = maka_agent_facts::read::ResourceAddress::parse(&image_reference)
        .unwrap()
        .unwrap();
    let copied = branch
        .resolve_read_resource("branch", address)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(copied.id(), "anchor-image");
    assert_eq!(
        branch
            .read_artifact_chunk("branch", copied.id(), 0, 8)
            .await
            .unwrap()
            .unwrap()
            .bytes,
        image.bytes
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = fixture::read_request(&mut socket).await;
        fixture::respond(&mut socket, "reopened", "stop").await;
        request
    });
    let worker = fixture::engine();
    let mut next = fixture::input(&base, "reopen", false);
    next.supports_vision = true;
    worker
        .run(log.store(), next, CancellationToken::new())
        .await
        .unwrap();
    worker.drain().await;
    let next = server.await.unwrap();
    let messages = next["messages"].to_string();
    assert!(messages.contains("question-reopen"));
    assert!(messages.contains(&image_reference));
    assert!(!messages.contains("question-first"));
    assert!(!messages.contains("image_url"));
}
