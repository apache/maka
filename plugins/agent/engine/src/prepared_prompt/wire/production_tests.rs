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
use futures_util::poll;
use maka_agent_facts::event::{EventWrite, Fact, Invocation, InvocationInput, RuntimeEvent};
use maka_capabilities::model_preparation::{ModelPreparationResources, PreparationPolicy};
use maka_event_log::{
    context::semantic::SemanticSelection,
    root::{RootNamespaces, RootOwner},
    root_store::{RootStore, SessionExecutionLease, SessionStore},
};
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
    SessionExecutionLease,
    SemanticSelection,
) {
    let root = RootStore::open(Arc::new(
        RootOwner::create(
            &path.join("root"),
            &RootNamespaces {
                ownership: path.join("owners"),
                control: path.join("control"),
            },
        )
        .unwrap(),
    ))
    .await
    .unwrap();
    let session = root
        .create_session("session", "create", &serde_json::json!({}), 1)
        .await
        .unwrap();
    let execution = session.execution_scope(None).await.unwrap().accept();
    let store = Arc::new(execution.store());
    let sequence = store
        .append(
            &EventWrite::plain(RuntimeEvent::new(
                Invocation {
                    session_id: "session".into(),
                    turn_id: "turn".into(),
                    run_id: "run".into(),
                    invocation_id: "invocation".into(),
                },
                Fact::InvocationOpened {
                    input: InvocationInput::Message {
                        content: "source-backed admission regression".into(),
                        request_fingerprint: None,
                        source_messages: Vec::new(),
                    },
                    configuration: None,
                },
            ))
            .unwrap(),
        )
        .await
        .unwrap();
    let selection = SemanticSelection {
        session: "session".into(),
        lineage: None,
        after: 0,
        through: sequence,
        before: u64::MAX,
        captured_through: sequence,
        replay: None,
        prior_unknown: false,
    };
    (root, store, execution, selection)
}

async fn capture(
    log: &Arc<SessionStore>,
    selection: SemanticSelection,
    resources: ModelPreparationResources,
) -> PreparedPrompt {
    let history = crate::history::prepare_view(
        log,
        selection,
        Language::En,
        false,
        &maka_model::ProviderKind::OpenaiChatCompletions,
        &CancellationToken::new(),
        resources,
        0,
    )
    .await
    .unwrap();
    PreparedPrompt::from_history(history)
}

#[tokio::test]
async fn two_captured_requests_reach_send_ready_and_last_output_retains_full_charge() {
    let directory = tempfile::tempdir().unwrap();
    let (root, log, execution, selection) = source(directory.path()).await;
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
    execution.finish();
    root.shutdown().await.unwrap();
}

#[tokio::test]
async fn blocked_wire_admission_releases_counting_work_and_observes_cancellation() {
    let directory = tempfile::tempdir().unwrap();
    let (root, log, execution, selection) = source(directory.path()).await;
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
    execution.finish();
    root.shutdown().await.unwrap();
}
