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

use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::execution::CollaborationMode;
use maka_agent_facts::execution::InvocationConfiguration;
use maka_agent_facts::execution::SandboxMode;
use maka_agent_facts::execution::ToolMode;
use maka_agent_facts::executor::Binding;
use maka_agent_facts::executor::Output;
use maka_agent_facts::tool_call::ToolCallIdentity;
use maka_event_log::EventLog;
use serde_json::json;

#[tokio::test]
async fn external_output_is_durable_observation_not_native_dispatch_and_rebuilds_transcript() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("executors.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    let invocation = Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    let event = |fact| EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap();
    log.append(&event(Fact::InvocationOpened {
        input: InvocationInput::Message {
            content: "external task".into(),
            source_messages: vec![],
            request_fingerprint: None,
        },
        configuration: Some(Box::new(InvocationConfiguration {
            language: maka_agent_facts::language::Language::En,
            compaction_prompt: None,
            workspace_origin: maka_agent_facts::execution::WorkspaceOrigin::Selected,
            approval_policy: maka_agent_facts::execution::ApprovalPolicy::OnRequest,
            boundary_revision: 0,
            cwd: temp.path().to_string_lossy().into_owned(),
            workspace_binding: None,
            workspace_identity: None,
            model: None,
            editing_tools: None,
            tool_discovery: false,
            tool_composition: None,
            system_prompt: None,
            thinking_level: None,
            sandbox_mode: SandboxMode::WorkspaceWrite,
            collaboration_mode: CollaborationMode::Agent,
            tool_mode: ToolMode::Direct,
            code_language: Default::default(),
        })),
    }))
    .await
    .unwrap();
    assert!(
        log.append(&event(Fact::ExecutorObserved {
            output: Output::OutputDelta {
                message_id: "second".into(),
                text: "too early".into()
            }
        }))
        .await
        .is_err()
    );
    let started = event(Fact::ExecutorStarted {
        settings: Default::default(),
        binding: Binding {
            executor_id: "example".to_owned().try_into().unwrap(),
            package_id: "example".into(),
            entry_id: "example".into(),
            activation: "activation".into(),
        },
    });
    log.append(&started).await.unwrap();
    let call = "\"".repeat(1024);
    let message_start = event(Fact::ExecutorObserved {
        output: Output::MessageStart {
            message_id: "second".into(),
        },
    });
    let mut first_end = 0;
    for output in [
        Output::MessageStart {
            message_id: "first".into(),
        },
        Output::OutputDelta {
            message_id: "first".into(),
            text: "first note".into(),
        },
        Output::ToolStart {
            tool_call_id: call.clone(),
            name: "shell".into(),
            input: json!({"command":"external only"}),
        },
        Output::MessageEnd {
            message_id: "first".into(),
        },
        Output::ToolProgress {
            tool_call_id: call.clone(),
            text: "working".into(),
        },
        Output::MessageStart {
            message_id: "second".into(),
        },
        Output::ThinkingDelta {
            message_id: "second".into(),
            text: "external reasoning".into(),
        },
        Output::OutputDelta {
            message_id: "second".into(),
            text: "partial answer".into(),
        },
    ] {
        let is_first_end =
            matches!(&output, Output::MessageEnd { message_id } if message_id=="first");
        let write = if matches!(&output, Output::MessageStart { message_id } if message_id=="second")
        {
            message_start.clone()
        } else {
            event(Fact::ExecutorObserved { output })
        };
        let seq = log.append(&write).await.unwrap();
        if is_first_end {
            first_end = seq;
        }
    }
    let progress = Output::ToolProgress {
        tool_call_id: call.clone(),
        text: format!("{}current", "\u{1}".repeat(64 * 1024 - 7)),
    };
    progress.validate().unwrap();
    log.append(&event(Fact::ExecutorObserved { output: progress }))
        .await
        .unwrap();
    let before = log.prefix(100, 1024 * 1024).await.unwrap();
    let observation = log
        .observe_session::<serde_json::Value>("session")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(observation.active_streams.len(), 2);
    assert_eq!(observation.active_tools.len(), 1);
    assert_eq!(
        observation.active_tools[0].tool_use_id,
        maka_agent_facts::tool_call::tool_use_id("invocation", &call)
    );
    assert!(observation.active_streams.iter().all(|seed| seed.message_id
        == maka_presentation::executor_message_id("invocation", "second")
        && seed.step_id == seed.message_id
        && seed.start_sequence > first_end));
    let stream = log
        .session_stream_events("session", 0, before.high_water, 32, 48 * 1024)
        .await
        .unwrap();
    use maka_agent_facts::model::TextKind;
    use maka_event_log::observation::StreamFact;
    assert!(stream.events.iter().any(|event| matches!(&event.fact,
        StreamFact::ExecutorDelta {text_kind: TextKind::Thinking, text, ..} if text == "external reasoning")));
    assert!(stream.events.iter().any(|event| matches!(&event.fact,
        StreamFact::ExecutorToolProgress {text, ..} if text == "working")));
    assert!(stream.events.iter().any(|event| matches!(&event.fact,
        StreamFact::ExecutorToolProgress {text, tool_call_id}
        if text == &format!("{}current", "\u{1}".repeat(2048-7)) && tool_call_id == &call)));
    assert_eq!(stream.next_after, None);
    let overlay = log
        .active_transcript(&invocation, before.high_water)
        .await
        .unwrap();
    assert_eq!(overlay.len(), 1);
    let overlay = serde_json::to_value(&overlay[0]).unwrap();
    assert_eq!(overlay["text"], "partial answer");
    assert_eq!(overlay["thinking"]["text"], "external reasoning");
    let message_start_sequence = before
        .events
        .iter()
        .find(|stored| stored.event.id == message_start.event().id)
        .unwrap()
        .sequence;
    assert!(
        observation
            .active_streams
            .iter()
            .all(|seed| seed.start_sequence == message_start_sequence)
    );
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    let reattached = log
        .observe_session::<serde_json::Value>("session")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reattached.active_streams, observation.active_streams);
    let reattached_overlay = log
        .active_transcript(&invocation, before.high_water)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(&reattached_overlay[0]).unwrap(),
        overlay
    );

    assert!(
        log.append(&event(Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: "dispatch".into(),
            call: ToolCallIdentity::standalone("call".into()),
            name: "shell".into(),
            input: json!({})
        }))
        .await
        .is_err()
    );
    assert!(
        log.append(&event(Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed
        }))
        .await
        .is_err()
    );
    log.append(&event(Fact::ExecutorObserved {
        output: Output::ToolResult {
            tool_call_id: call,
            text: "external result".into(),
            is_error: false,
        },
    }))
    .await
    .unwrap();
    assert!(
        log.observe_session::<serde_json::Value>("session")
            .await
            .unwrap()
            .unwrap()
            .active_tools
            .is_empty()
    );
    for output in [
        Output::MessageEnd {
            message_id: "second".into(),
        },
        Output::MessageStart {
            message_id: "tool-only".into(),
        },
        Output::ToolStart {
            tool_call_id: "second-call".into(),
            name: "read".into(),
            input: json!({}),
        },
        Output::ToolResult {
            tool_call_id: "second-call".into(),
            text: "second result".into(),
            is_error: false,
        },
        Output::MessageEnd {
            message_id: "tool-only".into(),
        },
        Output::MessageStart {
            message_id: "final".into(),
        },
        Output::OutputDelta {
            message_id: "final".into(),
            text: "final authoritative answer".into(),
        },
    ] {
        log.append(&event(Fact::ExecutorObserved { output }))
            .await
            .unwrap();
    }
    let final_end = log
        .append(&event(Fact::ExecutorObserved {
            output: Output::MessageEnd {
                message_id: "final".into(),
            },
        }))
        .await
        .unwrap();
    for output in [
        Output::MessageStart {
            message_id: "trailing-reasoning".into(),
        },
        Output::ThinkingDelta {
            message_id: "trailing-reasoning".into(),
            text: "private trailing thought".into(),
        },
        Output::MessageEnd {
            message_id: "trailing-reasoning".into(),
        },
    ] {
        log.append(&event(Fact::ExecutorObserved { output }))
            .await
            .unwrap();
    }
    log.append(&event(Fact::ExecutorCompleted {
        message_id: Some("final".into()),
    }))
    .await
    .unwrap();
    assert!(
        log.append(&event(Fact::ExecutorObserved {
            output: Output::OutputDelta {
                message_id: "second".into(),
                text: "too late".into()
            }
        }))
        .await
        .is_err()
    );
    let through = log
        .append(&event(Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        }))
        .await
        .unwrap();
    assert!(
        log.observe_session::<serde_json::Value>("session")
            .await
            .unwrap()
            .unwrap()
            .active_streams
            .is_empty()
    );

    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();

    assert!(matches!(
        log.search_transcript(
            "session",
            maka_event_log::transcript::search::TranscriptSearch {
                through,
                after: Some(maka_agent_facts::history::RowPosition {
                    source_sequence: 1,
                    item_index: 99,
                }),
                query: "note".into(),
                case_sensitive: false,
                whole_word: false,
                include_internal: false,
                max_matches: 8,
            },
        )
        .await,
        Err(maka_event_log::StoreError::InvalidTransition(_))
    ));

    let maka_agent_ports::session::history::Page::Ready { chunks, .. } = log
        .history_text(
            "session",
            through,
            maka_agent_ports::session::history::Position::Start,
            true,
            maka_event_log::transcript::HistoryLimits {
                max_bytes: 8192,
                max_chunks: Some(32),
                max_json_bytes: 64 * 1024,
            },
        )
        .await
        .unwrap();
    use maka_agent_ports::session::history::{Page, Position};
    let mut forward = Vec::new();
    let mut position = Position::Start;
    for _ in 0..32 {
        let Page::Ready {
            chunks: page,
            after,
            ..
        } = log
            .history_text(
                "session",
                through,
                position,
                true,
                maka_event_log::transcript::HistoryLimits {
                    max_bytes: 8192,
                    max_chunks: Some(1),
                    max_json_bytes: 64 * 1024,
                },
            )
            .await
            .unwrap();
        forward.extend(page);
        let Some(cursor) = after else { break };
        position = Position::After { cursor };
    }
    assert_eq!(
        serde_json::to_value(&forward).unwrap(),
        serde_json::to_value(&chunks).unwrap(),
        "one-row forward windows preserve display order"
    );
    let mut backward = Vec::new();
    let mut position = Position::Tail;
    for _ in 0..32 {
        let Page::Ready {
            mut chunks, before, ..
        } = log
            .history_text(
                "session",
                through,
                position,
                true,
                maka_event_log::transcript::HistoryLimits {
                    max_bytes: 8192,
                    max_chunks: Some(1),
                    max_json_bytes: 64 * 1024,
                },
            )
            .await
            .unwrap();
        chunks.append(&mut backward);
        backward = chunks;
        let Some(cursor) = before else { break };
        position = Position::Before { cursor };
    }
    assert_eq!(
        serde_json::to_value(&backward).unwrap(),
        serde_json::to_value(&chunks).unwrap(),
        "one-row reverse windows preserve display order"
    );
    let Page::Ready {
        chunks: historical, ..
    } = log
        .history_text(
            "session",
            first_end - 1,
            Position::Start,
            true,
            maka_event_log::transcript::HistoryLimits {
                max_bytes: 8192,
                max_chunks: Some(32),
                max_json_bytes: 64 * 1024,
            },
        )
        .await
        .unwrap();
    assert!(
        !historical.iter().any(|chunk| chunk.text == "first note"),
        "start anchor must not leak a future commit through an old fence"
    );
    let answer = chunks
        .iter()
        .find(|chunk| chunk.text == "final authoritative answer")
        .expect("actual executor answer");
    assert!(chunks.iter().all(|chunk| chunk.model.is_none()));
    assert_eq!(
        chunks
            .iter()
            .filter(|chunk| chunk.final_output)
            .map(|chunk| chunk.text.as_str())
            .collect::<Vec<_>>(),
        vec!["final authoritative answer"],
    );
    let source = log
        .history_source(
            "session",
            through,
            maka_event_log::transcript::SourceSelection {
                locator: answer.position,
                field: maka_agent_ports::session::history::SourceField::Body,
                path: None,
            },
            maka_agent_ports::session::history::SourcePosition::After { offset: 6 },
            8192,
        )
        .await
        .unwrap();
    assert_eq!(source.text, "authoritative answer");
    assert!(source.model.is_none(), "executor ID is not an LLM model");
    let source_session = log
        .get_session::<serde_json::Value>("session")
        .await
        .unwrap()
        .unwrap();
    let copied = log
        .copy_session(
            maka_event_log::sessions::SessionCopy {
                source_session_id: "session".into(),
                target_session_id: "copy".into(),
                expected_source_revision: source_session.revision,
                purpose: maka_agent_facts::session::CopyPurpose::Branch {
                    position: maka_agent_facts::session::ForkPosition::End,
                    side_conversation: false,
                },
            },
            &json!({}),
            2,
        )
        .await
        .unwrap();
    assert!(matches!(
        copied,
        maka_event_log::sessions::SessionCopyResult::Committed(_)
    ));
    let maka_agent_ports::session::history::Page::Ready {
        chunks: copied_chunks,
        ..
    } = log
        .history_text(
            "copy",
            through,
            maka_agent_ports::session::history::Position::Start,
            true,
            maka_event_log::transcript::HistoryLimits {
                max_bytes: 8192,
                max_chunks: Some(32),
                max_json_bytes: 64 * 1024,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(&copied_chunks).unwrap(),
        serde_json::to_value(&chunks).unwrap(),
        "copied history preserves text, sources and final membership"
    );
    let prefix = log.prefix(100, 1024 * 1024).await.unwrap();
    use maka_agent_facts::history::semantic::{Payload, SemanticKind};
    let semantic = log
        .context_semantic_rows(
            &maka_event_log::context::semantic::SemanticSelection {
                session: "session".into(),
                lineage: None,
                after: 0,
                through,
                before: through,
                captured_through: through,
                replay: None,
                prior_unknown: false,
            },
            None,
            32,
        )
        .await
        .unwrap();
    assert!(semantic.next.is_none());
    let messages = semantic
        .rows
        .into_iter()
        .filter(|row| matches!(row.kind, SemanticKind::ExecutorText { .. }))
        .collect::<Vec<_>>();
    let reasoning_end = prefix
        .events
        .iter()
        .find(|stored| {
            matches!(&stored.event.fact,
                Fact::ExecutorObserved { output: Output::MessageEnd { message_id } } if message_id=="trailing-reasoning"
            )
        })
        .unwrap()
        .sequence;
    assert!(
        messages
            .iter()
            .all(|row| row.id.source_sequence != reasoning_end),
        "thinking-only completion must not emit a semantic assistant text row"
    );
    let resolved = log.context_semantic_resolve(&messages).await.unwrap();
    let bodies = resolved
        .iter()
        .map(|row| match row.payload.as_ref() {
            Some(Payload::Text(text)) => text.as_str(),
            other => panic!("native message has non-text model-history payload: {other:?}"),
        })
        .collect::<Vec<_>>();
    assert_eq!(
        bodies,
        vec!["first note", "partial answer", "final authoritative answer"],
        "model history retains each completed body independently, without thinking, empty tool messages, or a terminal aggregate"
    );
    let first_tool = prefix
        .events
        .iter()
        .find(|stored| {
            matches!(&stored.event.fact,
        Fact::ExecutorObserved { output: Output::ToolStart { name, .. } } if name=="shell")
        })
        .unwrap()
        .sequence;
    assert!(
        messages[0].order.source_sequence < first_tool
            && first_tool < messages[1].order.source_sequence,
        "model-history display anchors straddle the actual external tool activity"
    );
    assert_eq!(messages[0].id.source_sequence, first_end);
    assert!(
        first_tool < messages[0].id.source_sequence,
        "the first body commits only at its real message end"
    );

    let mut view = maka_presentation::InvocationView::new();
    let mut rows = vec![];
    for record in &prefix.events {
        rows.extend(view.push(record).unwrap());
    }
    assert!(rows.iter().any(|row| matches!(&row.message.content,
        maka_presentation::Content::Assistant { text, interrupted, .. } if text == "final authoritative answer" && !*interrupted)));
    rows.sort_by_key(|row| row.order);
    let headers = log
        .transcript_headers(
            "session",
            &maka_event_log::transcript::TranscriptRead {
                through,
                position: None,
                direction: maka_event_log::transcript::TranscriptDirection::Newer,
                limit: 256,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        headers
            .iter()
            .map(|header| header.position)
            .collect::<Vec<_>>(),
        rows.iter().map(|row| row.position).collect::<Vec<_>>()
    );

    let rows = rows
        .iter()
        .map(|row| serde_json::to_value(&row.message).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        rows.iter().filter(|row| row["type"] == "tool_call").count(),
        2
    );
    assert!(
        rows.iter()
            .any(|row| row["type"] == "tool_call" && row["providerExecuted"] == true)
    );
    assert!(rows.iter().any(|row| row["type"] == "assistant"
        && row["text"] == "partial answer"
        && row["thinking"]["text"] == "external reasoning"));
    let ordered: Vec<_> = rows
        .iter()
        .filter_map(|row| match row["type"].as_str() {
            Some("assistant") => Some(
                row["text"]
                    .as_str()
                    .filter(|text| !text.is_empty())
                    .unwrap_or_else(|| {
                        row["thinking"]["text"]
                            .as_str()
                            .expect("assistant row must have text or thinking")
                    }),
            ),
            Some("tool_call") => row["toolName"].as_str(),
            _ => None,
        })
        .collect();
    assert_eq!(
        ordered,
        vec![
            "first note",
            "shell",
            "partial answer",
            "read",
            "final authoritative answer",
            "private trailing thought",
        ]
    );
    assert!(chunks.windows(2).all(|pair| pair[0].order <= pair[1].order));
    let first_note = chunks
        .iter()
        .find(|chunk| chunk.text == "first note")
        .unwrap();
    assert_eq!(first_note.position.source_sequence, first_end);
    assert!(first_note.order.source_sequence < first_end);
    let maka_agent_ports::session::history::Page::Ready {
        chunks: event_chunks,
        ..
    } = log
        .history_text(
            "session",
            through,
            maka_agent_ports::session::history::Position::Event {
                sequence: answer.position.source_sequence,
            },
            false,
            maka_event_log::transcript::HistoryLimits {
                max_bytes: 8192,
                max_chunks: Some(32),
                max_json_bytes: 64 * 1024,
            },
        )
        .await
        .unwrap();
    assert!(
        event_chunks
            .iter()
            .any(|chunk| chunk.text == "final authoritative answer")
    );
    assert_eq!(answer.position.item_index, 0);
    assert_eq!(answer.position.source_sequence, final_end);

    assert!(!prefix.events.iter().any(|row| matches!(
        row.event.fact,
        Fact::ToolDispatched { .. } | Fact::ModelRequested { .. }
    )));
    log.close().await.unwrap();
}

#[tokio::test]
async fn cancellation_seals_only_the_unfinished_native_message() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("cancelled_executor.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    let invocation = Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    let event = |fact| EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap();
    log.append(&event(Fact::InvocationOpened {
        input: InvocationInput::Message {
            content: "external task".into(),
            source_messages: vec![],
            request_fingerprint: None,
        },
        configuration: Some(Box::new(InvocationConfiguration {
            language: maka_agent_facts::language::Language::En,
            compaction_prompt: None,
            workspace_origin: maka_agent_facts::execution::WorkspaceOrigin::Selected,
            approval_policy: maka_agent_facts::execution::ApprovalPolicy::OnRequest,
            boundary_revision: 0,
            cwd: temp.path().to_string_lossy().into_owned(),
            workspace_binding: None,
            workspace_identity: None,
            model: None,
            editing_tools: None,
            tool_discovery: false,
            tool_composition: None,
            system_prompt: None,
            thinking_level: None,
            sandbox_mode: SandboxMode::WorkspaceWrite,
            collaboration_mode: CollaborationMode::Agent,
            tool_mode: ToolMode::Direct,
            code_language: Default::default(),
        })),
    }))
    .await
    .unwrap();
    log.append(&event(Fact::ExecutorStarted {
        settings: Default::default(),
        binding: Binding {
            executor_id: "example".to_owned().try_into().unwrap(),
            package_id: "example".into(),
            entry_id: "example".into(),
            activation: "activation".into(),
        },
    }))
    .await
    .unwrap();
    for output in [
        Output::MessageStart {
            message_id: "first".into(),
        },
        Output::OutputDelta {
            message_id: "first".into(),
            text: "first note".into(),
        },
        Output::MessageEnd {
            message_id: "first".into(),
        },
        Output::MessageStart {
            message_id: "empty-open".into(),
        },
        Output::MessageStart {
            message_id: "unfinished-answer".into(),
        },
        Output::OutputDelta {
            message_id: "unfinished-answer".into(),
            text: "partial answer".into(),
        },
        Output::ToolStart {
            tool_call_id: "unfinished".into(),
            name: "pending".into(),
            input: json!({}),
        },
    ] {
        log.append(&event(Fact::ExecutorObserved { output }))
            .await
            .unwrap();
    }
    let through = log
        .append(&event(Fact::InvocationEnded {
            outcome: InvocationOutcome::Cancelled {
                source: "test".into(),
            },
        }))
        .await
        .unwrap();

    let maka_agent_ports::session::history::Page::Ready { chunks, .. } = log
        .history_text(
            "session",
            through,
            maka_agent_ports::session::history::Position::Start,
            true,
            maka_event_log::transcript::HistoryLimits {
                max_bytes: 8192,
                max_chunks: Some(32),
                max_json_bytes: 64 * 1024,
            },
        )
        .await
        .unwrap();
    assert!(chunks.iter().all(|chunk| !chunk.final_output));
    let partial = chunks
        .iter()
        .find(|chunk| chunk.text == "partial answer")
        .expect("unfinished non-empty message sealed on cancellation");
    assert_eq!(partial.position.source_sequence, through);
    assert_eq!(partial.position.item_index, 1);

    use maka_agent_facts::history::semantic::{Payload, SemanticKind};
    let semantic = log
        .context_semantic_rows(
            &maka_event_log::context::semantic::SemanticSelection {
                session: "session".into(),
                lineage: None,
                after: 0,
                through,
                before: through,
                captured_through: through,
                replay: None,
                prior_unknown: false,
            },
            None,
            32,
        )
        .await
        .unwrap();
    let messages = semantic
        .rows
        .into_iter()
        .filter(|row| matches!(row.kind, SemanticKind::ExecutorText { .. }))
        .collect::<Vec<_>>();
    let resolved = log.context_semantic_resolve(&messages).await.unwrap();
    let bodies = resolved
        .iter()
        .map(|row| match row.payload.as_ref() {
            Some(Payload::Text(text)) => text.as_str(),
            other => panic!("unexpected payload: {other:?}"),
        })
        .collect::<Vec<_>>();
    assert_eq!(
        bodies,
        vec!["first note"],
        "only completed messages commit to semantic model history"
    );

    let prefix = log.prefix(100, 1024 * 1024).await.unwrap();
    let mut view = maka_presentation::InvocationView::new();
    let mut rows = vec![];
    for record in &prefix.events {
        rows.extend(view.push(record).unwrap());
    }
    rows.sort_by_key(|row| row.order);
    let assistants = rows
        .iter()
        .filter_map(|row| match &row.message.content {
            maka_presentation::Content::Assistant {
                text, interrupted, ..
            } => Some((text.as_str(), *interrupted)),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        assistants,
        vec![("first note", false), ("partial answer", true)],
        "sealed first message stays uninterrupted, empty open message is suppressed, and unfinished non-empty message is marked interrupted"
    );
    log.close().await.unwrap();
}
