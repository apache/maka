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
use maka_agent_ports::session::history::Page;
use maka_agent_ports::session::history::Position;
use maka_agent_ports::session::history::Role;
use std::collections::BTreeMap;

#[tokio::test]
async fn history_pages_preserve_utf8_nul_suffixes_archive_and_frozen_fences() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("log.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("a", "create", &serde_json::json!({}), 1)
        .await
        .unwrap();
    let text = format!("a{}\0suffix-needle", "🦀".repeat(10_000));
    let (part, old) = partial(&log, "a", &text).await;
    interrupt(&log, "a", part).await;
    log.append(&event("a", request("history"))).await.unwrap();
    let call = maka_agent_facts::model::ModelToolCall {
        id: "read".into(),
        name: "Read".into(),
        input: serde_json::json!({"path": "source.rs", "intent": "Inspect source"}).into(),
        provider_options: None,
        provider_executed: false,
    };

    log.append(&event(
        "a",
        Fact::ModelCompleted {
            step_id: "step-history".into(),
            output: ModelCompletion {
                parts: completion_parts("step-history".into(), vec![ModelPart::ToolCall { call }]),
                finish_reason: maka_agent_facts::model::ModelFinishReason::ToolCalls,
                usage: ModelUsage::default(),
                provider_options: None,
                response_id: None,
                model: None,
                timestamp: None,
            },
        },
    ))
    .await
    .unwrap();
    log.append(&event(
        "a",
        Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: "step-history:read".into(),
            call: maka_agent_facts::tool_call::ToolCallIdentity::provider(
                "step-history".into(),
                "read".into(),
            ),
            name: "Read".into(),
            input: serde_json::json!({"path": "source.rs", "intent": "Inspect source"}),
        },
    ))
    .await
    .unwrap();
    let template = event(
        "a",
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    );
    let (result, _) = maka_agent_facts::event::EventWrite::tool_success(
        "read-result".into(),
        template.event().recorded_at,
        template.event().invocation.clone(),
        "step-history:read".into(),
        serde_json::json!({"content": text, "nested": ["second\nline", 42, false]}).into(),
    )
    .unwrap();
    log.append(&result).await.unwrap();
    let through = end(
        &log,
        "a",
        InvocationOutcome::Cancelled {
            source: "user".into(),
        },
    )
    .await;

    log.set_session_archived::<Value>("a", true, 10)
        .await
        .unwrap();
    let archived = log
        .scoped_sessions::<Value>(
            maka_event_log::sessions::CatalogScope::Profile,
            None,
            None.into(),
            maka_event_log::sessions::CatalogFilter {
                archived_only: false,
                include_archived: true,
                pending_only: false,
            },
        )
        .await
        .unwrap();
    assert!(archived.sessions[0].archived);
    // Large tool payloads remain available to exact readers but occupy a single
    // metadata row in chat, in either paging direction.
    for reverse in [false, true] {
        let mut position = if reverse {
            Position::Tail
        } else {
            Position::Start
        };
        let mut calls = 0;
        let mut results = 0;
        loop {
            let Page::Ready {
                chunks,
                before,
                after,
                ..
            } = log
                .history_view(
                    "a",
                    through,
                    position,
                    false,
                    maka_agent_ports::session::history::HistoryView::Conversation,
                    maka_event_log::transcript::HistoryLimits {
                        max_bytes: 4096,
                        max_chunks: Some(8),
                        max_json_bytes: 64 * 1024,
                    },
                )
                .await
                .unwrap();
            for chunk in chunks {
                if matches!(chunk.role, Role::ToolCall | Role::ToolResult) {
                    assert!(chunk.origin.is_none());
                    assert_eq!((chunk.offset, chunk.total_bytes), (0, 0));
                    assert!(chunk.text.is_empty());
                    assert!(chunk.tool.is_some());
                    if chunk.role == Role::ToolCall {
                        calls += 1;
                    } else {
                        results += 1;
                    }
                }
            }
            position = match if reverse { before } else { after } {
                Some(cursor) if reverse => Position::Before { cursor },
                Some(cursor) => Position::After { cursor },
                None => break,
            };
        }
        assert_eq!((calls, results), (1, 1));
    }
    let mut position = Position::Start;
    let mut messages: BTreeMap<String, (Role, String)> = BTreeMap::new();
    let mut pages = 0;
    loop {
        let page = log
            .history_text(
                "a",
                through,
                position,
                false,
                maka_event_log::transcript::HistoryLimits {
                    max_bytes: 16 * 1024,
                    max_chunks: Some(8),
                    max_json_bytes: 1024 * 1024,
                },
            )
            .await
            .unwrap();
        assert!(serde_json::to_vec(&page).unwrap().len() < 256 * 1024);
        let Page::Ready { chunks, after, .. } = page;
        for chunk in chunks {
            let timing = chunk.timing.as_ref().expect("original turn timing");
            let finished = timing.finished.as_ref().unwrap();
            assert!(finished.at >= timing.started_at);
            assert_eq!(
                finished.outcome,
                maka_agent_ports::session::history::TurnOutcome::Aborted
            );
            if let Some(tool) = &chunk.tool {
                assert_eq!(
                    tool.call.as_ref().map(|call| call.name.as_str()),
                    Some("Read")
                );
                match chunk.role {
                    Role::ToolCall => {
                        assert_eq!(tool.tool_use_id, chunk.message_id);
                        assert_eq!(tool.call.as_ref().unwrap().position, chunk.position);
                    }
                    Role::ToolResult => {
                        let result = tool.result.as_ref().unwrap();
                        assert_eq!(result.position, chunk.position);
                        assert!(!result.is_error);
                        assert!(!result.image);
                        assert!(messages.contains_key(&tool.tool_use_id));
                    }
                    _ => panic!("tool metadata on non-tool row"),
                }
            } else {
                assert!(matches!(chunk.role, Role::User | Role::Assistant));
            }
            let entry = messages
                .entry(chunk.message_id)
                .or_insert((chunk.role, String::new()));
            assert_eq!(entry.1.len() as u64, chunk.offset);
            entry.1.push_str(&chunk.text);
            assert!(entry.1.len() as u64 <= chunk.total_bytes);
        }
        pages += 1;
        assert!(pages < 20, "continuation must advance");
        let Some(cursor) = after else {
            break;
        };
        position = Position::After { cursor };
    }
    assert!(pages >= 3, "large message must be split, not clipped");
    assert_eq!(
        messages
            .values()
            .find(|(role, _)| *role == Role::Assistant)
            .unwrap()
            .1,
        text
    );
    assert_eq!(
        messages
            .values()
            .find(|(role, _)| *role == Role::ToolResult)
            .unwrap()
            .1,
        format!("{text}\nsecond\nline"),
        "JSON string values stay multiline; property names and non-text leaves are not searchable"
    );
    let Page::Ready { chunks, after, .. } = log
        .history_text(
            "a",
            old,
            Position::Start,
            false,
            maka_event_log::transcript::HistoryLimits {
                max_bytes: 16 * 1024,
                max_chunks: Some(8),
                max_json_bytes: 1024 * 1024,
            },
        )
        .await
        .unwrap();
    assert!(after.is_none());
    assert!(
        chunks.iter().all(|chunk| chunk
            .timing
            .as_ref()
            .is_some_and(|time| time.finished.is_none())),
        "old fence excludes the later terminal event"
    );
    assert!(
        chunks.iter().all(|chunk| chunk.role == Role::User),
        "old fence excludes unfinished answer"
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn tool_metadata_preserves_empty_calls_and_non_text_results_through_frozen_windows() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("tools.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    for session in ["numeric", "unknown", "image", "failed", "rejected", "spoof"] {
        log.create_session(session, session, &serde_json::json!({}), 1)
            .await
            .unwrap();
        log.append(&event(session, opening())).await.unwrap();
        log.append(&event(session, request(session))).await.unwrap();
        let call = maka_agent_facts::model::ModelToolCall {
            id: "count".into(),
            name: "Count".into(),
            input: serde_json::json!({"count": 42}).into(),
            provider_options: None,
            provider_executed: false,
        };
        let step = format!("step-{session}");

        log.append(&event(
            session,
            Fact::ModelCompleted {
                step_id: step.clone(),
                output: ModelCompletion {
                    parts: completion_parts(step.clone(), vec![ModelPart::ToolCall { call }]),
                    finish_reason: maka_agent_facts::model::ModelFinishReason::ToolCalls,
                    usage: ModelUsage::default(),
                    provider_options: None,
                    response_id: None,
                    model: None,
                    timestamp: None,
                },
            },
        ))
        .await
        .unwrap();
        let operation = format!("{step}:count");
        let call_fence = log
            .append(&event(
                session,
                if session == "rejected" {
                    Fact::ToolRejected {
                        operation_id: operation.clone(),
                        call: maka_agent_facts::tool_call::ToolCallIdentity::provider(
                            step.clone(),
                            "count".into(),
                        ),
                        name: "Count".into(),
                        input: serde_json::json!({"count": 42}).into(),
                        reason: maka_agent_facts::tool_call::ToolRejection::Unavailable,
                    }
                } else {
                    Fact::ToolDispatched {
                        presentation: None,
                        title: None,
                        operation_id: operation.clone(),
                        call: maka_agent_facts::tool_call::ToolCallIdentity::provider(
                            step,
                            "count".into(),
                        ),
                        name: "Count".into(),
                        input: serde_json::json!({"count": 42}),
                    }
                },
            ))
            .await
            .unwrap();
        if !matches!(session, "unknown" | "failed" | "rejected") {
            let template = event(
                session,
                Fact::InvocationEnded {
                    outcome: InvocationOutcome::Completed,
                },
            );
            let output = if session == "image" {
                maka_agent_facts::tool_output::ToolOutput::Image(
                    maka_agent_facts::tool_output::ImageOutput {
                        detail: None,
                        mime_type: "image/png".into(),
                        reference: maka_agent_facts::attachment::StorageRef::WorkspaceFile {
                            relative_path: "unread-image.png".into(),
                        },
                    },
                )
            } else if session == "spoof" {
                serde_json::json!({"count": 42, "ready": true, "settlement": "failed"}).into()
            } else {
                serde_json::json!({"count": 42, "ready": true}).into()
            };
            let (result, _) = maka_agent_facts::event::EventWrite::tool_success(
                format!("{session}-result"),
                template.event().recorded_at,
                template.event().invocation.clone(),
                operation,
                output.into(),
            )
            .unwrap();
            log.append(&result).await.unwrap();
        } else if session != "rejected" {
            log.append(&event(
                session,
                Fact::ToolSettled {
                    operation_id: operation,
                    outcome: if session == "failed" {
                        maka_agent_facts::event::ToolOutcome::Failed {
                            message: "Recorded failure".into(),
                        }
                    } else {
                        maka_agent_facts::event::ToolOutcome::Unknown {
                            message: "Result unknown; do not repeat".into(),
                            operation: None,
                        }
                    },
                },
            ))
            .await
            .unwrap();
        }
        let through = end(&log, session, InvocationOutcome::Completed).await;

        let Page::Ready { chunks, .. } = log
            .history_text(
                session,
                call_fence,
                Position::Start,
                false,
                maka_event_log::transcript::HistoryLimits {
                    max_bytes: 8192,
                    max_chunks: Some(8),
                    max_json_bytes: 64 * 1024,
                },
            )
            .await
            .unwrap();
        assert!(chunks.iter().any(|chunk| chunk.role == Role::ToolCall
            && chunk.text.is_empty()
            && chunk.tool.as_ref().is_some_and(|tool| {
                tool.call.as_ref().is_some_and(|call| {
                    call.name == "Count" && call.dispatched == (session != "rejected")
                }) && (tool.result.is_none() || session == "rejected")
            })));
        assert!(
            session == "rejected" || chunks.iter().all(|chunk| chunk.role != Role::ToolResult),
            "old fence excludes settled result"
        );
        for reverse in [false, true] {
            let mut position = if reverse {
                Position::Tail
            } else {
                Position::Start
            };
            let mut tools = BTreeMap::new();
            for _ in 0..16 {
                let Page::Ready {
                    chunks,
                    before,
                    after,
                    ..
                } = log
                    .history_text(
                        session,
                        through,
                        position,
                        false,
                        maka_event_log::transcript::HistoryLimits {
                            max_bytes: 8192,
                            max_chunks: Some(1),
                            max_json_bytes: 64 * 1024,
                        },
                    )
                    .await
                    .unwrap();
                assert!(chunks.len() <= 1);
                for chunk in chunks {
                    if matches!(chunk.role, Role::ToolCall | Role::ToolResult) {
                        use maka_agent_ports::session::history::SourceField;
                        use maka_agent_ports::session::history::SourceFormat;
                        use maka_agent_ports::session::history::SourcePosition;
                        let field = if chunk.role == Role::ToolCall {
                            SourceField::Arguments
                        } else {
                            SourceField::Result
                        };
                        let source = log
                            .history_source(
                                session,
                                through,
                                maka_event_log::transcript::SourceSelection {
                                    locator: chunk.position,
                                    field,
                                    path: None,
                                },
                                SourcePosition::Start,
                                8192,
                            )
                            .await
                            .unwrap();
                        assert_eq!(source.tool.as_ref().unwrap(), chunk.tool.as_ref().unwrap());
                        assert_eq!(
                            chunk
                                .tool
                                .as_ref()
                                .unwrap()
                                .result
                                .as_ref()
                                .unwrap()
                                .settlement,
                            Some(match session {
                                "unknown" => maka_agent_facts::tool_call::ToolSettlement::Unknown,
                                "failed" => maka_agent_facts::tool_call::ToolSettlement::Failed,
                                "rejected" => maka_agent_facts::tool_call::ToolSettlement::Rejected,
                                _ => maka_agent_facts::tool_call::ToolSettlement::Returned,
                            })
                        );

                        if chunk.role == Role::ToolResult {
                            assert!(
                                session == "rejected"
                                    || log
                                        .history_source(
                                            session,
                                            call_fence,
                                            maka_event_log::transcript::SourceSelection {
                                                locator: chunk.position,
                                                field,
                                                path: None
                                            },
                                            SourcePosition::Start,
                                            8192
                                        )
                                        .await
                                        .is_err()
                            );
                            if matches!(session, "numeric" | "spoof") {
                                assert_eq!(source.format, SourceFormat::Json);
                                assert_eq!(
                                    serde_json::from_str::<Value>(&source.text).unwrap(),
                                    if session == "spoof" {
                                        serde_json::json!({"count":42,"ready":true,"settlement":"failed"})
                                    } else {
                                        serde_json::json!({"count":42,"ready":true})
                                    }
                                );
                            } else if session == "image" {
                                assert_eq!(source.format, SourceFormat::ImageDescriptor);
                                let descriptor: Value = serde_json::from_str(&source.text).unwrap();
                                assert_eq!(descriptor["kind"], "image");
                                assert_eq!(descriptor["mimeType"], "image/png");
                                assert!(source.text.contains("unread-image.png"));
                                assert!(!temp.path().join("unread-image.png").exists());
                            } else if session == "unknown" {
                                assert_eq!(source.format, SourceFormat::Text);
                                assert_eq!(source.text, "Result unknown; do not repeat");
                            }
                        }
                    }
                    if let Some(tool) = chunk.tool {
                        tools.insert(chunk.role as u8, (chunk.text, tool));
                    }
                }
                let next = if reverse { before } else { after };
                let Some(cursor) = next else { break };
                position = if reverse {
                    Position::Before { cursor }
                } else {
                    Position::After { cursor }
                };
            }
            assert_eq!(
                tools.len(),
                2,
                "empty tool rows must not disappear or stall paging"
            );
            let (text, tool) = &tools[&(Role::ToolResult as u8)];
            let call = tool.call.as_ref().unwrap();
            let result = tool.result.as_ref().unwrap();
            assert_eq!(call.name, "Count");
            assert_eq!(
                result.is_error,
                matches!(session, "unknown" | "failed" | "rejected")
            );
            assert_eq!(result.image, session == "image");
            assert_eq!(text.is_empty(), matches!(session, "numeric" | "image"));
            let (_, call_tool) = &tools[&(Role::ToolCall as u8)];
            assert_eq!(tool, call_tool);
        }
    }
    log.close().await.unwrap();
}

#[tokio::test]
async fn oversized_tool_metadata_returns_accepted_window_without_consuming_its_boundary() {
    use maka_agent_facts::import::Content;
    use maka_agent_facts::import::Record;
    use maka_agent_facts::import::Source;
    use maka_capabilities::storage::Namespace;
    use maka_plugin_core::scope::Scope;
    let temp = tempfile::tempdir().unwrap();
    let log = EventLog::open(&temp.path().join("tool-budget.sqlite"))
        .await
        .unwrap();
    let owner = maka_event_log::sessions::PluginSession {
        session_id: "budget".into(),
        creator: Namespace::new("history.fixture", Scope::Profile).unwrap(),
        fingerprint: "tool-budget".into(),
        managed: false,
        authority_session_id: None,
    };

    let records = [
        Content::User {
            text: "accepted prefix".into(),
        },
        Content::ToolCall {
            call_id: "call".into(),
            name: "name".repeat(1024),
            input: None,
        },
        Content::Assistant {
            text: "accepted suffix".into(),
            model: None,
            thinking: None,
        },
    ]
    .into_iter()
    .enumerate()
    .map(|(index, content)| Record {
        source_message_id: format!("m{index}"),
        source_turn_id: "turn".into(),
        timestamp: Some(1),
        content,
    })
    .collect::<Vec<_>>();
    log.import_session(
        &owner,
        &Source {
            adapter: "fixture".into(),
            session_id: "foreign".into(),
        },
        &serde_json::json!({}),
        records,
        1,
    )
    .await
    .unwrap();

    let through = *log.subscribe_commits().borrow();

    for reverse in [false, true] {
        let position = if reverse {
            Position::Tail
        } else {
            Position::Start
        };
        let Page::Ready {
            chunks,
            before,
            after,
            ..
        } = log
            .history_text(
                "budget",
                through,
                position,
                false,
                maka_event_log::transcript::HistoryLimits {
                    max_bytes: 8192,
                    max_chunks: Some(8),
                    max_json_bytes: 1024,
                },
            )
            .await
            .unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(
            chunks[0].text,
            if reverse {
                "accepted suffix"
            } else {
                "accepted prefix"
            }
        );
        let cursor = if reverse { before } else { after }.unwrap();
        let position = if reverse {
            Position::Before { cursor }
        } else {
            Position::After { cursor }
        };
        let Page::Ready {
            chunks: soft,
            before: soft_before,
            after: soft_after,
            ..
        } = log
            .history_text(
                "budget",
                through,
                position,
                false,
                maka_event_log::transcript::HistoryLimits {
                    max_bytes: 8192,
                    max_chunks: Some(8),
                    max_json_bytes: 1024,
                },
            )
            .await
            .unwrap();
        assert_eq!(soft.len(), 1);
        assert_eq!(soft[0].role, Role::ToolCall);
        assert_eq!(
            soft[0].tool.as_ref().unwrap().call.as_ref().unwrap().name,
            "name".repeat(1024)
        );
        assert!(if reverse {
            soft_before.is_some()
        } else {
            soft_after.is_some()
        });
        let Page::Ready { chunks, .. } = log
            .history_text(
                "budget",
                through,
                position,
                false,
                maka_event_log::transcript::HistoryLimits {
                    max_bytes: 8192,
                    max_chunks: Some(1),
                    max_json_bytes: 64 * 1024,
                },
            )
            .await
            .unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].role, Role::ToolCall);
        assert!(chunks[0].tool.is_some());
        assert!(chunks[0].text.is_empty());
    }
    log.close().await.unwrap();
}

#[tokio::test]
async fn history_distinguishes_plain_text_from_structured_user_references() {
    use maka_agent_facts::input::MessageInput;
    use maka_agent_ports::session::history::HistoryView;
    let temp = tempfile::tempdir().unwrap();
    let log = EventLog::open(&temp.path().join("references.sqlite"))
        .await
        .unwrap();
    let cases = [
        ("plain", serde_json::json!({}), false),
        (
            "quote",
            serde_json::json!({"quotes":[{"text":"The release moved to November."}]}),
            true,
        ),
        (
            "directory",
            serde_json::json!({"directory_references":[{"hostId":"root","path":"src/中文"}]}),
            true,
        ),
        (
            "inline",
            serde_json::json!({"inline_references":[{"kind":"workspace_file","value":"notes.txt","label":"@notes.txt","start":0}]}),
            true,
        ),
    ];
    for (session, references, expected) in cases {
        log.create_session(session, "create", &serde_json::json!({}), 1)
            .await
            .unwrap();
        let mut input = serde_json::json!({"text":"Summarize this material", "display_text":null});
        input
            .as_object_mut()
            .unwrap()
            .extend(references.as_object().unwrap().clone());
        let content: MessageInput = serde_json::from_value(input).unwrap();
        let through = log
            .append(&event(
                session,
                Fact::InvocationOpened {
                    configuration: None,
                    input: InvocationInput::Message {
                        content,
                        source_messages: Vec::new(),
                        request_fingerprint: None,
                    },
                },
            ))
            .await
            .unwrap();
        for position in [Position::Start, Position::Tail] {
            let Page::Ready { chunks, .. } = log
                .history_view(
                    session,
                    through,
                    position,
                    false,
                    HistoryView::Conversation,
                    maka_event_log::transcript::HistoryLimits {
                        max_bytes: 4,
                        max_chunks: Some(8),
                        max_json_bytes: 64 * 1024,
                    },
                )
                .await
                .unwrap();
            assert_eq!(chunks.len(), 1, "one visible user fragment for {session}");
            let chunk = &chunks[0];
            assert_eq!(chunk.role, Role::User);
            assert_eq!(
                chunk.has_references,
                chunk.offset == 0 && expected,
                "reference metadata for {session} at {}",
                chunk.offset
            );
        }
    }
    log.close().await.unwrap();
}

#[tokio::test]
async fn response_models_follow_their_original_step_at_frozen_fences() {
    use maka_agent_ports::session::history::HistoryModel;
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("models.sqlite"))
        .await
        .unwrap();
    log.create_session("a", "create", &serde_json::json!({}), 1)
        .await
        .unwrap();
    log.append(&event("a", opening())).await.unwrap();
    let mut first = 0;
    let mut through = 0;
    for (id, requested, reported, text) in [
        (
            "one",
            "requested-alias",
            Some("reported-concrete"),
            "first answer",
        ),
        ("two", "second-request", None, "second answer"),
    ] {
        let mut requested_fact = request(id);
        let Fact::ModelRequested { model_id, .. } = &mut requested_fact else {
            unreachable!()
        };
        *model_id = requested.into();
        log.append(&event("a", requested_fact)).await.unwrap();
        if let Some(reported) = reported {
            log.append(&event(
                "a",
                Fact::ModelObserved {
                    step_id: format!("step-{id}"),
                    event: ModelObservation::ResponseMetadata {
                        id: None,
                        model: Some(reported.into()),
                        timestamp: None,
                    },
                },
            ))
            .await
            .unwrap();
        }
        log.append(&event(
            "a",
            Fact::ModelCompleted {
                step_id: format!("step-{id}"),
                output: ModelCompletion {
                    parts: completion_parts(
                        format!("step-{id}"),
                        vec![ModelPart::Text {
                            text_kind: TextKind::Text,
                            text: text.into(),
                            provider_options: None,
                        }],
                    ),
                    finish_reason: maka_agent_facts::model::ModelFinishReason::Stop,
                    usage: ModelUsage::default(),
                    provider_options: None,
                    response_id: None,
                    model: None,
                    timestamp: None,
                },
            },
        ))
        .await
        .unwrap();
        through = *log.subscribe_commits().borrow();
        if first == 0 {
            first = through;
        }
    }
    for (fence, expected) in [
        (
            first,
            vec![("first answer", "requested-alias", Some("reported-concrete"))],
        ),
        (
            through,
            vec![
                ("first answer", "requested-alias", Some("reported-concrete")),
                ("second answer", "second-request", None),
            ],
        ),
    ] {
        let Page::Ready { chunks, .. } = log
            .history_text(
                "a",
                fence,
                Position::Start,
                false,
                maka_event_log::transcript::HistoryLimits {
                    max_bytes: 8192,
                    max_chunks: Some(8),
                    max_json_bytes: 64 * 1024,
                },
            )
            .await
            .unwrap();
        let actual: Vec<_> = chunks
            .into_iter()
            .filter(|chunk| chunk.role == Role::Assistant)
            .map(|chunk| (chunk.text, chunk.model))
            .collect();
        assert_eq!(
            actual,
            expected
                .into_iter()
                .map(|(text, requested, reported)| (
                    text.to_owned(),
                    Some(HistoryModel::Native {
                        requested_model_id: requested.into(),
                        reported_model_id: reported.map(str::to_owned),
                    })
                ))
                .collect::<Vec<_>>()
        );
    }
    log.close().await.unwrap();
}
