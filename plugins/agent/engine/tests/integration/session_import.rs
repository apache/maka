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
use maka_agent_facts::event::LogScope;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::import::Content;
use maka_agent_facts::import::Record;
use maka_agent_facts::import::Source;
use maka_capabilities::storage::Namespace;
use maka_event_log::{
    EventLog, StoreError,
    sessions::{PluginSession, SessionCopy, SessionCopyResult},
};
use maka_plugin_core::scope::Scope;
use serde_json::{Value, json};

fn owner(id: &str) -> PluginSession {
    PluginSession {
        session_id: id.into(),
        creator: Namespace::new("external.reader", Scope::Profile).unwrap(),
        fingerprint: format!("request-{id}"),
        managed: false,
        authority_session_id: None,
    }
}
fn source() -> Source {
    Source {
        adapter: "arbitrary-format".into(),
        session_id: "foreign-session".into(),
    }
}
fn record(id: &str, content: Content) -> Record {
    Record {
        source_message_id: id.into(),
        source_turn_id: "foreign-turn".into(),
        timestamp: Some(123),
        content,
    }
}

#[tokio::test]
async fn import_is_retryable_history_not_an_execution_and_survives_copy_and_restart() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("import.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let owner = owner("imported");
    let first = record(
        "leading",
        Content::Assistant {
            text: "retained, not a prefill".into(),
            model: None,
            thinking: None,
        },
    );
    let records = vec![
        first,
        record(
            "user",
            Content::User {
                text: "the original question".into(),
            },
        ),
        record(
            "tool",
            Content::ToolCall {
                call_id: "foreign-call".into(),
                name: "old-command".into(),
                input: Some(json!({"command":"do not run"})),
            },
        ),
        record(
            "answer",
            Content::Assistant {
                text: "the original answer".into(),
                model: Some("foreign-model".into()),
                thinking: Some("original thought".into()),
            },
        ),
        record(
            "result",
            Content::ToolResult {
                call_id: "foreign-call".into(),
                output: json!({"result":"historical"}),
                is_error: false,
            },
        ),
    ];
    let accepted = log
        .import_session(
            &owner,
            &source(),
            &json!({"name":"Imported"}),
            records.clone(),
            1,
        )
        .await
        .unwrap();
    let prefix = log
        .scoped_prefix(
            LogScope::Session {
                id: "imported".into(),
            },
            100,
            1024 * 1024,
        )
        .await
        .unwrap();
    assert_eq!(prefix.events.len(), 5);
    assert!(EventWrite::plain(prefix.events[0].event.clone()).is_err());
    assert!(
        log.unfinished_invocations(0, 100)
            .await
            .unwrap()
            .invocations
            .is_empty()
    );
    let accepted_digest = prefix.digest;
    let accepted_through = prefix.high_water;
    log.close().await.unwrap();

    let log = EventLog::open(&path).await.unwrap();
    let commits = log.subscribe_commits();
    let retry = log
        .import_session(
            &owner,
            &source(),
            &json!({"name":"Imported"}),
            records.clone(),
            99,
        )
        .await
        .unwrap();
    assert_eq!(retry, accepted);
    assert!(!commits.has_changed().unwrap());
    let mut changed = records.clone();
    changed[0] = record(
        "leading",
        Content::User {
            text: "changed".into(),
        },
    );
    assert!(matches!(
        log.import_session(&owner, &source(), &json!({"name":"Imported"}), changed, 99)
            .await,
        Err(StoreError::EventConflict)
    ));
    let replayed = log
        .scoped_prefix(
            LogScope::Session {
                id: "imported".into(),
            },
            100,
            1024 * 1024,
        )
        .await
        .unwrap();
    assert_eq!(replayed.digest, accepted_digest);
    assert_eq!(replayed.high_water, accepted_through);
    let session = log.get_session::<Value>("imported").await.unwrap().unwrap();
    assert!(session.execution.is_none());
    assert_eq!(
        session.last_message.as_ref().unwrap().preview.as_deref(),
        Some("the original answer")
    );
    let source = log.read_model_view("imported", None).await.unwrap();
    let frozen = source.source_evidence;
    let prefix = log
        .scoped_prefix(
            LogScope::Session {
                id: "imported".into(),
            },
            100,
            1024 * 1024,
        )
        .await
        .unwrap();
    let history = maka_agent_engine::project_model_history(
        &prefix,
        "imported",
        maka_agent_facts::language::Language::En,
    )
    .unwrap();
    assert_eq!(history.len(), 2);
    assert!(
        serde_json::to_string(&history)
            .unwrap()
            .contains("the original answer")
    );
    assert!(
        !serde_json::to_string(&history)
            .unwrap()
            .contains("do not run")
    );
    assert!(
        !serde_json::to_string(&history)
            .unwrap()
            .contains("original thought")
    );

    let read = log
        .history_text(
            "imported",
            prefix.high_water,
            maka_agent_ports::session::history::Position::Start,
            false,
            maka_event_log::transcript::HistoryLimits {
                max_bytes: 16 * 1024,
                max_chunks: Some(8),
                max_json_bytes: 1024 * 1024,
            },
        )
        .await
        .unwrap();
    let text = serde_json::to_string(&read).unwrap();
    assert!(text.contains("retained, not a prefill"));
    assert!(text.contains("the original answer"));

    let rows: Vec<_> = prefix
        .events
        .iter()
        .flat_map(|event| {
            maka_presentation::InvocationView::new()
                .push(event)
                .unwrap()
        })
        .collect();
    assert_eq!(rows.len(), 5);
    let call = &rows[2].message;
    assert!(matches!(
        rows[3].message.content,
        maka_presentation::Content::Assistant { .. }
    ));
    let maka_presentation::Content::ToolResult { tool_use_id, .. } = &rows[4].message.content
    else {
        panic!("result must retain its position after the intervening answer");
    };
    assert_eq!(tool_use_id, &call.id);

    let copy = log
        .copy_session(
            SessionCopy {
                source_session_id: "imported".into(),
                target_session_id: "copy".into(),
                expected_source_revision: session.revision,
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
    assert!(matches!(copy, SessionCopyResult::Committed(_)));
    assert_eq!(
        log.capture_model_context("copy", None, 10_000, 16 * 1024 * 1024)
            .await
            .unwrap()
            .tail
            .len(),
        5
    );

    let invocation = Invocation {
        session_id: "imported".into(),
        turn_id: "new-turn".into(),
        run_id: "new-run".into(),
        invocation_id: "new-invocation".into(),
    };
    for fact in [
        Fact::InvocationOpened {
            input: InvocationInput::Message {
                content: "continue".into(),
                request_fingerprint: None,
                source_messages: vec![],
            },
            configuration: None,
        },
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    ] {
        log.append(&EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap())
            .await
            .unwrap();
    }
    assert_eq!(
        log.read_frozen_model_context(&frozen, 100, 1024 * 1024)
            .await
            .unwrap()
            .tail
            .len(),
        5
    );
    let prefix = log
        .scoped_prefix(
            LogScope::Session {
                id: "imported".into(),
            },
            100,
            1024 * 1024,
        )
        .await
        .unwrap();
    assert_eq!(
        maka_agent_engine::project_model_history(
            &prefix,
            "imported",
            maka_agent_facts::language::Language::En
        )
        .unwrap()
        .len(),
        3
    );
    assert!(!prefix.events.iter().any(|event| matches!(
        event.event.fact,
        Fact::ModelRequested { .. } | Fact::ToolDispatched { .. }
    )));
    log.close().await.unwrap();
}

#[tokio::test]
async fn atomic_import_refuses_notes_and_retiring_parent_authority_without_publication() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("refused-import.sqlite"))
        .await
        .unwrap();
    log.create_session("parent", "parent", &json!({}), 1)
        .await
        .unwrap();
    let parent = log.get_session::<Value>("parent").await.unwrap().unwrap();
    log.begin_session_removal("parent", parent.revision)
        .await
        .unwrap();
    let mut child = owner("dependent");
    child.authority_session_id = Some("parent".into());
    assert!(matches!(
        log.import_session(
            &child,
            &source(),
            &json!({}),
            vec![record(
                "user",
                Content::User {
                    text: "historical".into()
                }
            )],
            2
        )
        .await,
        Err(StoreError::SessionRetired)
    ));
    assert!(
        log.import_session(
            &owner("notes"),
            &source(),
            &json!({}),
            vec![record(
                "note",
                Content::Note {
                    text: "not a conversation".into()
                }
            )],
            2
        )
        .await
        .is_err()
    );
    for session in ["dependent", "notes"] {
        assert!(log.get_session::<Value>(session).await.unwrap().is_none());
        assert!(log.session_creator(session).await.unwrap().is_none());
        assert!(
            log.imported_sessions::<Value>(session, None, 16)
                .await
                .unwrap()
                .0
                .is_empty()
        );
        assert!(
            log.scoped_prefix(LogScope::Session { id: session.into() }, 100, 1024 * 1024)
                .await
                .unwrap()
                .events
                .is_empty()
        );
    }
    log.close().await.unwrap();
}
