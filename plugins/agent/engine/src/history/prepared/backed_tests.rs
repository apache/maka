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
use maka_agent_facts::event::{
    EventWrite, Fact, Invocation, InvocationInput, InvocationOutcome, RuntimeEvent,
};

#[tokio::test]
async fn numeric_history_preserves_resident_commitments_counts_and_direct_metadata_seek() {
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        let (_directory, root) = crate::test_support::root().await;
        let session = crate::test_support::session(&root, "session").await;
        let execution = session.execution_scope(None).await.unwrap().accept();
        let log = Arc::new(execution.store());
        let mut through = 0;
        for index in 0..64 {
            let invocation = Invocation {
                session_id: "session".into(),
                turn_id: format!("turn-{index}"),
                run_id: format!("run-{index}"),
                invocation_id: format!("invocation-{index}"),
            };
            let event = EventWrite::plain(RuntimeEvent::new(
                invocation.clone(),
                Fact::InvocationOpened {
                    input: InvocationInput::Message {
                        content: format!("selected message {index} 世界\n").into(),
                        request_fingerprint: None,
                        source_messages: Vec::new(),
                    },
                    configuration: None,
                },
            ))
            .unwrap();
            log.append(&event).await.unwrap();
            through = log
                .append(
                    &EventWrite::plain(RuntimeEvent::new(
                        invocation,
                        Fact::InvocationEnded {
                            outcome: InvocationOutcome::Completed,
                        },
                    ))
                    .unwrap(),
                )
                .await
                .unwrap();
        }
        let selection = SemanticSelection {
            session: "session".into(),
            lineage: None,
            after: 0,
            through,
            before: u64::MAX,
            captured_through: through,
            replay: None,
            prior_unknown: false,
        };
        let resources = ModelPreparationResources::new(Default::default()).unwrap();
        let cancellation = CancellationToken::new();
        let resident = super::capture(
            &log,
            selection.clone(),
            Language::En,
            false,
            &ProviderKind::Anthropic,
            &cancellation,
            resources,
            0,
        )
        .await
        .unwrap();
        assert!(matches!(resident.directory, HistoryDirectory::Resident(_)));
        let resources = ModelPreparationResources::new(maka_model::PreparationPolicy {
            staging_bytes: super::backed::metadata_bytes() * 2,
            ..Default::default()
        })
        .unwrap();
        let backed = super::capture(
            &log,
            selection,
            Language::En,
            false,
            &ProviderKind::Anthropic,
            &cancellation,
            resources,
            0,
        )
        .await
        .unwrap();
        assert!(matches!(backed.directory, HistoryDirectory::Backed(_)));
        assert_eq!(resident.prompt().identity(), backed.prompt().identity());
        assert_eq!(resident.prompt().breakdown(), backed.prompt().breakdown());
        let left_source = resident.recipes();
        let right_source = backed.recipes();
        for prefix in [0, 1, left_source.len() / 2, left_source.len()] {
            assert_eq!(
                left_source.prefix_identity(prefix).await.unwrap(),
                right_source.prefix_identity(prefix).await.unwrap()
            );
        }
        let mut left_cursor = left_source.open_metadata(left_source.len() - 1);
        let mut right_cursor = right_source.open_metadata(right_source.len() - 1);
        let left = left_cursor.next().await.unwrap().unwrap();
        let right = right_cursor.next().await.unwrap().unwrap();
        assert_eq!(left.logical_identity, right.logical_identity);
        assert_eq!(left.message_index, right.message_index);
        assert!(right.local_tool_names.is_empty());
        drop((left_source, right_source, left_cursor, right_cursor));
        resident.close().await.unwrap();
        backed.close().await.unwrap();
        drop(left);
        drop(right);
        drop(resident);
        drop(backed);
        drop(log);
        execution.finish();
        root.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

const MCP_ID: &str = "mcp-call: /é😀";

#[derive(Clone, Copy, Debug)]
enum McpCase {
    SameGroup,
    ExcludedProducer,
}
impl McpCase {
    fn name(self) -> &'static str {
        match self {
            Self::SameGroup => "same-group",
            Self::ExcludedProducer => "excluded-producer",
        }
    }
    fn replay(self) -> ToolResultReplay {
        match self {
            Self::SameGroup => ToolResultReplay::AnthropicMcp,
            Self::ExcludedProducer => ToolResultReplay::Ordinary,
        }
    }
}

async fn append_canonical(log: &SessionStore, invocation: &Invocation, fact: Fact) -> u64 {
    log.append(&EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap())
        .await
        .unwrap()
}

async fn canonical_mcp_history(log: &SessionStore, case: McpCase) -> SemanticSelection {
    use maka_agent_facts::model::{
        ModelFinishReason, ModelPart, ModelToolCall, ToolInput,
        recorded::{
            CompletionPart, ModelCompletion, ModelObservation, ModelPartRecord, RecordedPartRef,
        },
    };
    let invocation = Invocation {
        session_id: log.id().into(),
        turn_id: format!("{}-turn", log.id()),
        run_id: format!("{}-run", log.id()),
        invocation_id: format!("{}-invocation", log.id()),
    };
    append_canonical(
        log,
        &invocation,
        Fact::InvocationOpened {
            input: InvocationInput::Message {
                content: "Find the canonical MCP result".into(),
                source_messages: Vec::new(),
                request_fingerprint: None,
            },
            configuration: None,
        },
    )
    .await;
    let producer = ModelPart::ToolCall {
        call: ModelToolCall {
            id: MCP_ID.into(),
            name: "search".into(),
            input: ToolInput::Json(serde_json::json!({"query":"canonical query"})),
            provider_options: Some(
                serde_json::json!({"anthropic":{"type":"mcp-tool-use","serverName":"mcp-catalog"}}),
            ),
            provider_executed: true,
        },
    };
    let result = ModelPart::ToolResult {
        id: MCP_ID.into(),
        name: "search".into(),
        output: serde_json::json!({"matches":["canonical MCP result"]}),
        is_error: false,
        provider_options: None,
    };
    let step = format!("{}-step", invocation.invocation_id);
    let item_acceptance = matches!(case, McpCase::ExcludedProducer);
    let source_high_water = *log.subscribe_commits().unwrap().borrow();
    append_canonical(
        log,
        &invocation,
        Fact::ModelRequested {
            item_acceptance,
            step_id: step.clone(),
            model_id: "fixture".into(),
            source_scope: maka_agent_facts::event::LogScope::Session {
                id: log.id().into(),
            },
            source_high_water,
            source_digest: "fixture".into(),
            input_digest: "fixture".into(),
            route_identity: "fixture".into(),
            checkpoint_event_id: None,
            purpose: maka_agent_facts::context::ModelPurpose::Main,
            context: None,
            context_breakdown: None,
            effective_source_digest: None,
        },
    )
    .await;
    let mut parts = Vec::new();
    let mut producer_sequence = None;
    for (ordinal, part) in [producer, result].into_iter().enumerate() {
        let record = ModelPartRecord {
            ordinal: ordinal as u64,
            message_id: match &part {
                ModelPart::ToolCall { call } => maka_agent_facts::tool_call::tool_use_id(
                    &invocation.invocation_id,
                    &format!("{step}:{}", call.id),
                ),
                _ => uuid::Uuid::new_v4().to_string(),
            },
            started_at: std::time::SystemTime::now(),
            provider_part_id: None,
            part: Arc::new(part),
        };
        if item_acceptance {
            let observed = EventWrite::plain(RuntimeEvent::new(
                invocation.clone(),
                Fact::ModelObserved {
                    step_id: step.clone(),
                    event: ModelObservation::Part(record),
                },
            ))
            .unwrap();
            let sequence = log.append(&observed).await.unwrap();
            if ordinal == 0 {
                producer_sequence = Some(sequence);
            }
            parts.push(CompletionPart::Ref(RecordedPartRef {
                event_id: observed.event().id.clone(),
                ordinal: ordinal as u64,
            }));
        } else {
            parts.push(CompletionPart::Own(record));
        }
    }
    if item_acceptance {
        append_canonical(
            log,
            &invocation,
            Fact::ModelObserved {
                step_id: step.clone(),
                event: ModelObservation::Finished {
                    reason: ModelFinishReason::Stop,
                    usage: Default::default(),
                    provider_options: None,
                },
            },
        )
        .await;
    }
    append_canonical(
        log,
        &invocation,
        Fact::ModelCompleted {
            step_id: step,
            output: ModelCompletion {
                parts,
                finish_reason: ModelFinishReason::Stop,
                usage: Default::default(),
                provider_options: None,
                response_id: None,
                model: None,
                timestamp: None,
            },
        },
    )
    .await;
    let through = append_canonical(
        log,
        &invocation,
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    )
    .await;
    SemanticSelection {
        session: log.id().into(),
        lineage: None,
        after: if matches!(case, McpCase::ExcludedProducer) {
            producer_sequence.expect("observed producer has its own selection fence")
        } else {
            0
        },
        through,
        before: u64::MAX,
        captured_through: through,
        replay: None,
        prior_unknown: false,
    }
}

#[derive(Debug, PartialEq)]
struct McpSnapshot {
    producer_groups: Vec<usize>,
    result_groups: Vec<(usize, ToolResultReplay)>,
}
async fn mcp_snapshot(history: &FrozenHistory) -> McpSnapshot {
    let work = history.resources().acquire_work().await.unwrap();
    let budget = work.budget();
    let source = history.recipes();
    let mut messages = source.open(0);
    let mut snapshot = McpSnapshot {
        producer_groups: Vec::new(),
        result_groups: Vec::new(),
    };
    let mut group = 0;
    while let Some(message) = messages.next().await.unwrap() {
        if let MessageRecipe::Assistant { content, .. } = message {
            let mut parts = content.open(0);
            while let Some(part) = parts.next().await.unwrap() {
                match part {
                    AssistantRecipe::ToolCall {
                        tool_call_id,
                        provider_executed,
                        provider_options,
                        ..
                    } => {
                        assert_eq!(provider_executed, Some(true));
                        assert!(
                            json::text_eq(&tool_call_id, MCP_ID, budget.clone())
                                .await
                                .unwrap()
                        );
                        let options = provider_options.expect("canonical producer options");
                        for (field, expected) in
                            [("type", "mcp-tool-use"), ("serverName", "mcp-catalog")]
                        {
                            let field =
                                json::field(&options, &["anthropic", field], budget.clone())
                                    .await
                                    .unwrap()
                                    .unwrap();
                            assert!(
                                json::text_eq(&field.text().unwrap(), expected, budget.clone())
                                    .await
                                    .unwrap()
                            );
                        }
                        snapshot.producer_groups.push(group);
                    }
                    AssistantRecipe::ToolResult(result) => {
                        assert!(
                            json::text_eq(&result.tool_call_id, MCP_ID, budget.clone())
                                .await
                                .unwrap()
                        );
                        snapshot.result_groups.push((group, result.replay));
                    }
                    _ => {}
                }
            }
        }
        group += 1;
    }
    snapshot
}

async fn anthropic_blocks(history: Arc<FrozenHistory>) -> Vec<Vec<u8>> {
    use crate::prepared_prompt::PreparedPrompt;
    use maka_agent_facts::model::prompt_source::WireFormat;
    let provider = maka_model::ProviderConfig {
        adapter: None,
        capabilities: Default::default(),
        network: Default::default(),
        kind: ProviderKind::Anthropic,
        model: "fixture".into(),
        base_url: "https://example.invalid".into(),
        auth: maka_model::ProviderAuth::ApiKey("fixture".into()),
        headers: Default::default(),
        body_overlay: None,
    };
    let mut prompt = PreparedPrompt::from_history(history);
    prompt
        .compile_wire(
            Language::En,
            &provider,
            &serde_json::Value::Null,
            &[],
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let model = prompt.model();
    let wire = model.wire(WireFormat::Anthropic).unwrap();
    let mut cursor = wire.open(0);
    let mut blocks = Vec::new();
    let mut bytes = Vec::new();
    while let Some(chunk) = cursor.next().await.unwrap() {
        if chunk.item_start {
            assert!(bytes.is_empty());
        }
        bytes.extend_from_slice(&chunk.bytes);
        if chunk.item_end && !bytes.is_empty() {
            blocks.push(std::mem::take(&mut bytes));
        }
    }
    assert!(bytes.is_empty());
    blocks
}

#[tokio::test]
async fn canonical_mcp_binding_matches_across_storage_and_selection_boundaries() {
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        let (_directory, root) = crate::test_support::root().await;
        for case in [McpCase::SameGroup, McpCase::ExcludedProducer] {
            let session = crate::test_support::session(&root, case.name()).await;
            let execution = session.execution_scope(None).await.unwrap().accept();
            let log = Arc::new(execution.store());
            let selection = canonical_mcp_history(&log, case).await;
            let cancel = CancellationToken::new();
            let resident = super::capture(
                &log,
                selection.clone(),
                Language::En,
                false,
                &ProviderKind::Anthropic,
                &cancel,
                ModelPreparationResources::new(Default::default()).unwrap(),
                0,
            )
            .await
            .unwrap();
            let backed = super::capture(
                &log,
                selection,
                Language::En,
                false,
                &ProviderKind::Anthropic,
                &cancel,
                ModelPreparationResources::new(maka_model::PreparationPolicy {
                    staging_bytes: super::backed::metadata_bytes(),
                    ..Default::default()
                })
                .unwrap(),
                0,
            )
            .await
            .unwrap();
            assert!(
                matches!(resident.directory, HistoryDirectory::Resident(_)),
                "{case:?}"
            );
            assert!(
                matches!(backed.directory, HistoryDirectory::Backed(_)),
                "{case:?}"
            );
            let snapshot = mcp_snapshot(&resident).await;
            assert_eq!(snapshot, mcp_snapshot(&backed).await, "{case:?}");
            assert_eq!(snapshot.result_groups.len(), 1, "{case:?}");
            assert_eq!(snapshot.result_groups[0].1, case.replay(), "{case:?}");
            match case {
                McpCase::SameGroup => {
                    assert_eq!(snapshot.producer_groups, vec![snapshot.result_groups[0].0])
                }
                McpCase::ExcludedProducer => assert!(snapshot.producer_groups.is_empty()),
            }
            let resident_wire = anthropic_blocks(resident.clone()).await;
            let backed_wire = anthropic_blocks(backed.clone()).await;
            assert_eq!(resident_wire, backed_wire, "{case:?}");
            let blocks: Vec<serde_json::Value> = backed_wire
                .iter()
                .map(|bytes| serde_json::from_slice(bytes).unwrap())
                .collect();
            let results: Vec<_> = blocks
                .iter()
                .filter(|block| block["type"] == "mcp_tool_result")
                .collect();
            if case.replay() == ToolResultReplay::AnthropicMcp {
                assert_eq!(results.len(), 1, "{case:?}");
                assert_eq!(results[0]["tool_use_id"], MCP_ID);
                assert_eq!(
                    results[0]["content"],
                    serde_json::json!({"matches":["canonical MCP result"]})
                );
                assert_eq!(results[0]["is_error"], false);
            } else {
                assert!(results.is_empty(), "{case:?}");
                assert!(blocks.iter().all(|block| block["content"]
                    != serde_json::json!({"matches":["canonical MCP result"]})));
            }
            if !matches!(case, McpCase::ExcludedProducer) {
                let producer: Vec<_> = blocks
                    .iter()
                    .filter(|block| block["type"] == "mcp_tool_use")
                    .collect();
                assert_eq!(producer.len(), 1, "{case:?}");
                assert_eq!(producer[0]["id"], MCP_ID);
                assert_eq!(producer[0]["server_name"], "mcp-catalog");
                assert_eq!(
                    producer[0]["input"],
                    serde_json::json!({"query":"canonical query"})
                );
            }
            resident.close().await.unwrap();
            backed.close().await.unwrap();
            drop((resident, backed, log));
            execution.finish();
        }
        root.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
