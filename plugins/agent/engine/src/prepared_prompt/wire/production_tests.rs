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

use super::*;
use crate::{history::test_support as canonical, preparation};
use futures_util::poll;
use maka_agent_facts::{
    durable::{ExecutionIdentity, Fact, RunId, UnixMillis},
    input::{DeliveredMessage, MessageInput, RunInput},
    message::{MessageDisposition, MessageOrigin, Placement, RootSourceMessage},
};
use maka_agent_state::{
    Admission, Change,
    queue::{Consume, Placement as QueuePlacement},
    session_history::SessionHistory,
};
use maka_capabilities::model_preparation::{ModelPreparationResources, PreparationPolicy};
use maka_event_log::root_store::{RootStore, SessionStore, SessionWorkLease, WorkEffects};
use maka_model::prompt::Message;
use std::{sync::Arc, task::Poll, time::Duration};

fn provider() -> ProviderConfig {
    ProviderConfig {
        image_input: None,
        adapter: None,
        capabilities: Default::default(),
        network: Default::default(),
        kind: maka_model::ProviderKind::OpenaiChatCompletions,
        model: "fixture".into(),
        base_url: "https://example.invalid".into(),
        auth: maka_model::ProviderAuth::ApiKey("fixture".into()),
        headers: Default::default(),
        body_overlay: None,
    }
}

async fn source(
    path: &std::path::Path,
) -> (
    RootStore,
    Arc<SessionStore>,
    SessionWorkLease,
    Vec<Message>,
    WorkEffects,
) {
    let root = canonical::open(path, false).await;
    root.create_session("session", "create", &serde_json::json!({}), 1)
        .await
        .unwrap();
    let (store, work, effects) = canonical::work(&root).await;
    (
        root,
        store,
        work,
        vec![Message::user("source-backed admission regression")],
        effects,
    )
}
async fn capture(
    log: &Arc<SessionStore>,
    messages: Vec<Message>,
    resources: ModelPreparationResources,
) -> PreparedPrompt {
    canonical::capture(log, messages, resources).await
}

#[tokio::test]
async fn production_wire_preserves_merged_and_steered_sender_origins_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let message =
        |id: &str, sender: &str, text: &str, disposition| {
            let content = MessageInput::from(text);
            RootSourceMessage {
                message: DeliveredMessage {
                    message_id: id.into(),
                    submitted_content_digest: content.content_digest().unwrap(),
                    content: content.clone(),
                    origin: Some(MessageOrigin::Session {
                        execution: ExecutionIdentity {
                            session_id: sender.into(),
                            turn_id: format!("turn-{sender}"),
                            run_id: RunId::try_from(uuid::Uuid::from_u128(
                                if sender == "sender-a" { 10 } else { 11 },
                            ))
                            .unwrap(),
                        },
                    }),
                },
                unprepared_content: content,
                submitted_placement: Placement::CurrentTurn,
                disposition,
                submitted_intent: None,
            }
        };
    let first = message(
        "first",
        "sender-a",
        "sender-b is only body text\n原文",
        MessageDisposition::TurnStarted,
    );
    let second = message(
        "second",
        "sender-b",
        "Second agent 原文\n",
        MessageDisposition::TurnStarted,
    );
    let steering = message(
        "steering",
        "sender-a",
        "Adjust course 原文",
        MessageDisposition::Steering,
    );
    let root = canonical::open(directory.path(), false).await;
    root.create_session("session", "create", &serde_json::json!({}), 1)
        .await
        .unwrap();
    let state = canonical::state(&root);
    let queued = canonical::enqueue(
        &state,
        first.clone(),
        vec![first.clone(), second.clone()],
        QueuePlacement::Followup,
    )
    .await;
    let revision = state.queue().read("session".into()).await.unwrap().revision;
    let admission = Admission::new(queued.spec, UnixMillis(2), vec![]).with_queue(Consume {
        session: "session".into(),
        requests: vec![queued.id],
        expected_revision: revision,
    });
    let run = admission.run();
    let committed = state.admit(admission).await.unwrap();
    let queued = canonical::enqueue(
        &state,
        steering.clone(),
        vec![steering.clone()],
        QueuePlacement::Steering {
            run,
            expected_head: committed.head,
        },
    )
    .await;
    let revision = state.queue().read("session".into()).await.unwrap().revision;
    let (step, request, contents) = canonical::request(vec![queued.source]);
    let claim = state.claim(run).await.unwrap();
    state
        .append_steering(
            &claim,
            committed.head,
            vec![Change::new(
                Fact::StepPrepared {
                    step,
                    request: request.reference().clone(),
                    adjudications: vec![],
                },
                UnixMillis(3),
            )],
            contents,
            Consume {
                session: "session".into(),
                requests: vec![queued.id],
                expected_revision: revision,
            },
        )
        .await
        .unwrap();
    drop((claim, state));
    root.shutdown().await.unwrap();
    drop(root);

    let root = canonical::open(directory.path(), true).await;
    let (log, execution, effects) = canonical::work(&root).await;
    let history = SessionHistory::new(
        root.data_writer().unwrap(),
        canonical::owner(),
        "session".into(),
    );
    let cut = history.capture().await.unwrap();
    let page = history.page(&cut, 0, 256).await.unwrap();
    let opening = page
        .items
        .iter()
        .find(|item| matches!(item.recorded.fact, Fact::RunAdmitted { .. }))
        .unwrap();
    let sources = history
        .sources(&cut, opening.sequence, None, 256)
        .await
        .unwrap();
    assert_eq!(sources.sources.len(), 1);
    let original = &sources.sources[0];
    let bytes = history
        .source_content(
            &cut,
            opening.sequence,
            original.position,
            &original.request.source,
        )
        .await
        .unwrap();
    let source: RootSourceMessage = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(source, first);
    let spec = history.run_source(run).await.unwrap().spec;
    let bytes = history
        .with_content(&cut, run, &spec.input, |reader| {
            let mut bytes = Vec::new();
            std::io::Read::read_to_end(reader, &mut bytes)?;
            Ok(bytes)
        })
        .await
        .unwrap();
    let RunInput::Message {
        content,
        source_messages,
        ..
    } = serde_json::from_slice(&bytes).unwrap()
    else {
        panic!("expected persisted opening input")
    };
    assert_eq!(
        content.text,
        "sender-b is only body text\n原文\n\nSecond agent 原文\n"
    );
    assert_eq!(source_messages, vec![first, second]);
    let prepared = page
        .items
        .iter()
        .find(|item| matches!(item.recorded.fact, Fact::StepPrepared { .. }))
        .unwrap();
    let sources = history
        .sources(&cut, prepared.sequence, None, 256)
        .await
        .unwrap();
    assert_eq!(sources.sources.len(), 1);
    let original = &sources.sources[0];
    let bytes = history
        .source_content(
            &cut,
            prepared.sequence,
            original.position,
            &original.request.source,
        )
        .await
        .unwrap();
    let persisted: RootSourceMessage = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(persisted.message, steering.message);
    assert_eq!(persisted, steering);

    let resources = ModelPreparationResources::new(PreparationPolicy::default()).unwrap();
    let artifacts = maka_agent_state::artifacts::ArtifactStore::new(root.data_writer().unwrap());
    let scope = maka_agent_state::artifacts::SessionScope {
        owner: canonical::owner(),
        session: "session".into(),
    };
    let mut messages = Vec::new();
    for (source, steering) in source_messages
        .iter()
        .map(|source| (source, false))
        .chain(std::iter::once((&persisted, true)))
    {
        messages.push(
            preparation::project_input(
                &artifacts,
                &scope,
                &source.message.content,
                Language::En,
                false,
                steering,
                source.message.origin.as_ref(),
                &resources,
                &CancellationToken::new(),
            )
            .await
            .unwrap(),
        );
    }
    let mut prompt = capture(&log, messages, resources).await;
    prompt
        .compile_wire(
            Language::En,
            &provider(),
            &serde_json::Value::Null,
            &[],
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let mut cursor = prompt.wire.as_ref().unwrap().open(0);
    let mut bytes = Vec::new();
    let mut messages = Vec::new();
    while let Some(chunk) = cursor.next().await.unwrap() {
        bytes.extend_from_slice(&chunk.bytes);
        if chunk.item_end {
            messages.push(serde_json::from_slice::<serde_json::Value>(&bytes).unwrap());
            bytes.clear();
        }
    }
    assert_eq!(messages.len(), 3);
    for (message, (sender, body)) in messages.iter().zip([
        ("sender-a", "sender-b is only body text\n原文"),
        ("sender-b", "Second agent 原文\n"),
        ("sender-a", "A message arrived while you were working:\n<user_query>\nAdjust course 原文\n</user_query>"),
    ]) {
        assert_eq!(message["role"], "user");
        let (header, text) = message["content"].as_str().unwrap().split_once('\n').unwrap();
        let origin: serde_json::Value = serde_json::from_str(header.strip_prefix("[Message source (Host-provided): ").unwrap().strip_suffix(']').unwrap()).unwrap();
        assert_eq!(origin, serde_json::json!({"kind":"session","execution":{
            "sessionId":sender,"turnId":format!("turn-{sender}"),"runId":uuid::Uuid::from_u128(if sender == "sender-a" { 10 } else { 11 })
        }}));
        assert_eq!(text, body);
    }
    drop(cursor);
    prompt.close().await.unwrap();
    drop(prompt);
    drop(log);
    effects.settle().await.unwrap();
    execution.finish();
    root.shutdown().await.unwrap();
}

#[tokio::test]
async fn two_captured_requests_reach_send_ready_and_last_output_retains_full_charge() {
    let directory = tempfile::tempdir().unwrap();
    let (root, log, execution, selection, effects) = source(directory.path()).await;
    let provider = provider();
    let options = serde_json::Value::Null;
    let cancellation = CancellationToken::new();
    let probe_resources = ModelPreparationResources::new(PreparationPolicy::default()).unwrap();
    let probe = capture(&log, selection.clone(), probe_resources.clone()).await;
    let encoding = WireEncoding::new(Language::En, &provider, &options, &[]).unwrap();
    let plan = encoding
        .count_prompt(&probe.model(), probe_resources)
        .await
        .unwrap();
    let source_bytes = probe.resident_bytes();
    let full_bytes = source_bytes + plan.allocation();
    drop(plan);
    probe.close().await.unwrap();
    drop(probe);

    let resources = ModelPreparationResources::new(PreparationPolicy {
        staging_bytes: 2 * source_bytes,
        resident_bytes: full_bytes,
        ..Default::default()
    })
    .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut first = capture(&log, selection.clone(), resources.clone()).await;
        let mut second = capture(&log, selection, resources.clone()).await;
        assert_eq!(first.resident_bytes(), source_bytes);
        assert_eq!(second.resident_bytes(), source_bytes);

        first
            .compile_wire(Language::En, &provider, &options, &[], &cancellation)
            .await
            .unwrap();
        {
            let second_plan = encoding
                .count_prompt(&second.model(), resources)
                .await
                .unwrap();
            assert_eq!(source_bytes + second_plan.allocation(), full_bytes);
            drop(second_plan);
            let second_promotion = second.promote(full_bytes, &cancellation);
            tokio::pin!(second_promotion);
            assert!(matches!(poll!(&mut second_promotion), Poll::Pending));

            let wire = first.wire.as_ref().unwrap();
            let mut cursor = wire.open(0);
            let chunk = cursor
                .next()
                .await
                .unwrap()
                .expect("first request is send-ready");
            assert!(!chunk.bytes.is_empty());
            let last_slice = chunk.bytes.slice(..1);
            drop(chunk);
            drop(cursor);
            first.close().await.unwrap();
            drop(first);
            assert!(matches!(poll!(&mut second_promotion), Poll::Pending));
            drop(last_slice);
            second_promotion.await.unwrap();
        }
        second
            .compile_wire(Language::En, &provider, &options, &[], &cancellation)
            .await
            .unwrap();
        let mut cursor = second.wire.as_ref().unwrap().open(0);
        let chunk = cursor
            .next()
            .await
            .unwrap()
            .expect("second request is send-ready");
        assert!(!chunk.bytes.is_empty());
        drop(chunk);
        drop(cursor);
        second.close().await.unwrap();
        drop(second);
    })
    .await
    .expect("source capture, admission and final output release must make progress");
    drop(log);
    effects.settle().await.unwrap();
    execution.finish();
    root.shutdown().await.unwrap();
}

#[tokio::test]
async fn blocked_wire_admission_releases_counting_work_and_observes_cancellation() {
    let directory = tempfile::tempdir().unwrap();
    let (root, log, execution, selection, effects) = source(directory.path()).await;
    let definitions = [Arc::new(ToolDefinition {
        name: "fixture".into(),
        description: "fixture input".into(),
        input_schema: serde_json::json!({"type":"object"}),
        output_schema: None,
        provider: None,
        freeform: None,
    })];
    let policy = PreparationPolicy::default();
    let resources = ModelPreparationResources::new(PreparationPolicy {
        progress_bytes: policy.work_bytes,
        ..policy
    })
    .unwrap();
    let resident = resources
        .reserve_staging(1)
        .await
        .unwrap()
        .promote(policy.resident_bytes)
        .await
        .unwrap();
    let mut prompt = capture(&log, selection, resources.clone()).await;
    let provider = provider();
    let options = serde_json::Value::Null;
    let cancellation = CancellationToken::new();

    tokio::time::timeout(Duration::from_secs(10), async {
        let work = resources.acquire_work().await.unwrap();
        let compilation = prompt.compile_wire(
            Language::En,
            &provider,
            &options,
            &definitions,
            &cancellation,
        );
        tokio::pin!(compilation);
        assert!(matches!(poll!(&mut compilation), Poll::Pending));
        let counted = resources.acquire_work();
        tokio::pin!(counted);
        assert!(matches!(poll!(&mut counted), Poll::Pending));
        drop(work);
        let counted = tokio::select! {
            result = &mut compilation => panic!("resident admission must wait: {result:?}"),
            result = &mut counted => result.unwrap(),
        };
        assert!(matches!(poll!(&mut compilation), Poll::Pending));
        cancellation.cancel();
        assert!(matches!(compilation.await, Err(RunError::Cancelled)));
        drop(counted);
    })
    .await
    .expect("wire admission must release counting work and observe cancellation");

    drop(resident);
    prompt.close().await.unwrap();
    drop(prompt);
    drop(log);
    effects.settle().await.unwrap();
    execution.finish();
    root.shutdown().await.unwrap();
}
