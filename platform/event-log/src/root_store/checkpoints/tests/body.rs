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
use crate::sessions::{MaterialCollection, RemoveFamilyResult};
use maka_agent_facts::{
    event::{
        EventWrite, Fact, Invocation, InvocationInput, InvocationOutcome, LogScope, RuntimeEvent,
    },
    tool_call::ToolCallIdentity,
    tool_output::{DurableToolProjection, ToolOutput, ToolSuccess},
};
use std::collections::BTreeMap;

#[tokio::test]
async fn checkpoint_keeps_tool_bytes_after_source_collection_and_import() {
    let directory = tempfile::tempdir().unwrap();
    let (store, handle, request) = fixture(directory.path()).await;
    let log = handle.session.scoped().await.unwrap();
    let invocation = Invocation {
        session_id: "source".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    let plain = |fact| EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap();
    log.append(&plain(Fact::InvocationOpened {
        configuration: None,
        input: InvocationInput::Message {
            content: "read the large tool result".into(),
            source_messages: vec![],
            request_fingerprint: None,
        },
    }))
    .await
    .unwrap();
    use maka_agent_facts::model::{
        ModelFinishReason, ModelPart, ModelToolCall, ModelUsage,
        recorded::{CompletionPart, ModelCompletion, ModelPartRecord},
    };
    let context = log
        .read_model_view("source", Some(&invocation.invocation_id))
        .await
        .unwrap();
    log.append(&plain(Fact::ModelRequested {
        source_capture: maka_agent_facts::event::SourceCapture {
            publication_watermark: context.selection.captured_through,
            prior_unknown: context.selection.prior_unknown,
        },
        context_breakdown: None,
        item_acceptance: false,
        purpose: maka_agent_facts::context::ModelPurpose::Main,
        context: None,
        checkpoint_event_id: None,
        step_id: "step".into(),
        model_id: "model".into(),
        source_scope: context.source_evidence.scope,
        source_high_water: context.source_evidence.high_water,
        source_digest: context.source_evidence.digest,
        effective_source_digest: Some(context.effective_source_digest),
        input_digest: "fixture".into(),
        route_identity: "route".into(),
    }))
    .await
    .unwrap();
    log.append(&plain(Fact::ModelCompleted {
        step_id: "step".into(),
        output: ModelCompletion {
            compaction: None,
            parts: vec![CompletionPart::Own(ModelPartRecord {
                ordinal: 0,
                message_id: maka_agent_facts::tool_call::tool_use_id(
                    &invocation.invocation_id,
                    "step:call",
                ),
                started_at: std::time::UNIX_EPOCH,
                provider_part_id: None,
                part: Arc::new(ModelPart::ToolCall {
                    call: ModelToolCall {
                        id: "call".into(),
                        name: "Read".into(),
                        input: json!({}).into(),
                        provider_options: None,
                        provider_executed: false,
                    },
                }),
            })],
            finish_reason: ModelFinishReason::ToolCalls,
            usage: ModelUsage::default(),
            provider_options: None,
            response_id: None,
            model: None,
            timestamp: None,
        },
    }))
    .await
    .unwrap();
    log.append(&plain(Fact::ToolDispatched {
        presentation: None,
        title: None,
        operation_id: "step:call".into(),
        call: ToolCallIdentity::provider("step".into(), "call".into()),
        name: "Read".into(),
        input: json!({}),
    }))
    .await
    .unwrap();
    let text = "checkpoint 汉🦀\n\\\"".repeat(4000);
    let result = EventWrite::tool_success(
        "result".into(),
        std::time::UNIX_EPOCH,
        invocation.clone(),
        "step:call".into(),
        ToolSuccess::projected(
            ToolOutput::Text(text.clone()),
            DurableToolProjection::Text { text: text.clone() },
        ),
    )
    .unwrap()
    .0;
    log.append(&result).await.unwrap();
    log.append(&plain(Fact::InvocationEnded {
        outcome: InvocationOutcome::Completed,
    }))
    .await
    .unwrap();
    let original = log
        .scoped_prefix(
            LogScope::Session {
                id: "source".into(),
            },
            usize::MAX,
            usize::MAX,
        )
        .await
        .unwrap()
        .events;
    drop(log);
    let value = handle.publish(request.clone()).await.unwrap();
    let head = published(&value);
    let log = handle.session.owner().unwrap();
    let revision = store
        .get_session::<serde_json::Value>("source")
        .await
        .unwrap()
        .unwrap()
        .revision;
    assert!(matches!(
        store
            .remove_session_family("source", revision)
            .await
            .unwrap(),
        RemoveFamilyResult::Accepted(_)
    ));
    store.finish_session_retirement("source").await.unwrap();
    while log.collect_session_material(None).await.unwrap() == MaterialCollection::Collected {}
    drop(log);
    store.close().await.unwrap();

    let store = RootStore::open(owner(directory.path())).await.unwrap();
    let handle = store.history_checkpoints("source", scope()).await.unwrap();
    assert_eq!(handle.receipt(request).await.unwrap(), Some(value));
    // The public inspection path must page tool bodies after canonical source GC.
    let load = crate::checkpoints::LoadOperation {
        operation: Uuid::new_v4(),
        fingerprint: "c".repeat(64),
        revision: head.revision,
    };
    handle.load_exact(load.clone()).await.unwrap();
    use maka_agent_ports::session::history::{Page, Position, Role};
    let mut position = Position::Start;
    let mut restored_tool = String::new();
    let mut pages = 0;
    loop {
        let Page::Ready { chunks, after, .. } = handle
            .loaded_history(load.operation, "source".into(), position, false)
            .await
            .unwrap();
        pages += 1;
        for chunk in chunks {
            if chunk.role == Role::ToolResult {
                restored_tool.push_str(&chunk.text);
            }
        }
        let Some(cursor) = after else {
            break;
        };
        position = Position::After { cursor };
        assert!(pages < 100, "paging must advance");
    }
    assert!(pages > 1);
    assert_eq!(restored_tool, text);
    let checkout = handle.checkout_exact(head.revision).await.unwrap();
    let mut staged = StagedBundle::read(tokio::fs::File::from_std(checkout.bundle))
        .await
        .unwrap();
    staged.validate_history().await.unwrap();
    let destination_directory = tempfile::tempdir().unwrap();
    let destination = RootStore::open(owner(destination_directory.path()))
        .await
        .unwrap();
    let receipt = destination
        .import_bundle(
            staged,
            &maka_agent_facts::artifact::content_digest(b"checkpoint destination"),
            BTreeMap::from([("source".to_owned(), json!({"title":"restored"}))]),
        )
        .await
        .unwrap();
    let session = destination.session(&receipt.root_session_id).await.unwrap();
    assert_eq!(
        session
            .resolve_tool_result(&receipt.root_session_id, "result")
            .await
            .unwrap(),
        ToolOutput::Text(text)
    );
    let restored = session
        .scoped_prefix(
            LogScope::Session {
                id: receipt.root_session_id,
            },
            usize::MAX,
            usize::MAX,
        )
        .await
        .unwrap()
        .events;
    assert_eq!(
        serde_json::to_value(restored).unwrap(),
        serde_json::to_value(original).unwrap()
    );
    destination.close().await.unwrap();
    store.close().await.unwrap();
}
