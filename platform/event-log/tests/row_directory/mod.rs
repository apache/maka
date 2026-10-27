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

use maka_agent_facts::import::{Content, Record, Source};
use maka_agent_ports::session::history::{HistoryView, Position};
use maka_capabilities::storage::Namespace;
use maka_event_log::{EventLog, sessions::PluginSession};
use maka_plugin_core::scope::Scope;
use serde_json::json;

#[tokio::test]
async fn complete_import_is_immediately_readable_and_exact_retry_keeps_original_records() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("import-directory.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let owner = PluginSession {
        session_id: "imported".into(),
        creator: Namespace::new("directory.fixture", Scope::Profile).unwrap(),
        fingerprint: "literal-import".into(),
        managed: false,
        authority_session_id: None,
    };
    let source = Source {
        adapter: "fixture".into(),
        session_id: "original".into(),
    };
    let records = vec![
        Record {
            source_message_id: "original-user".into(),
            source_turn_id: "original-turn".into(),
            timestamp: Some(10),
            content: Content::User {
                text: "first literal中".into(),
            },
        },
        Record {
            source_message_id: "original-assistant".into(),
            source_turn_id: "original-turn".into(),
            timestamp: Some(11),
            content: Content::Assistant {
                text: "answer😀".into(),
                model: Some("original-model".into()),
                thinking: None,
            },
        },
    ];
    log.import_session(&owner, &source, &json!({}), records.clone(), 20)
        .await
        .unwrap();
    let original = log.prefix(16, 65536).await.unwrap();
    let bytes = serde_json::to_vec(&original.events).unwrap();
    let page = log
        .history_view(
            "imported",
            original.high_water,
            Position::Tail,
            false,
            HistoryView::Text,
            maka_event_log::transcript::HistoryLimits {
                max_bytes: 8192,
                max_chunks: Some(8),
                max_json_bytes: 65536,
            },
        )
        .await
        .unwrap();
    let value = serde_json::to_value(page).unwrap();
    assert_eq!(value["kind"], "ready");
    assert_eq!(value["chunks"][0]["text"], "first literal中");
    assert_eq!(value["chunks"][1]["text"], "answer😀");
    assert!(value["before"].is_null() && value["after"].is_null());
    log.import_session(&owner, &source, &json!({}), records, 20)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_vec(&log.prefix(16, 65536).await.unwrap().events).unwrap(),
        bytes
    );
    log.close().await.unwrap();
    let reopened = EventLog::open(&path).await.unwrap();
    let page = reopened
        .history_view(
            "imported",
            original.high_water,
            Position::Tail,
            false,
            HistoryView::Text,
            maka_event_log::transcript::HistoryLimits {
                max_bytes: 8192,
                max_chunks: Some(8),
                max_json_bytes: 65536,
            },
        )
        .await
        .unwrap();
    assert_eq!(serde_json::to_value(page).unwrap(), value);
    reopened.close().await.unwrap();
}

mod bare_copy {
    use maka_agent_facts::event::{
        EventWrite, Fact, Invocation, InvocationInput, InvocationOutcome, RuntimeEvent,
    };
    use maka_agent_facts::message::{MessageDisposition, Placement, RootSourceMessage};
    use maka_event_log::{
        EventLog, StoreError,
        sessions::{SessionCopy, SessionCopyResult},
        transcript::{TranscriptDirection, TranscriptRead},
    };
    use serde_json::{Value, json};
    fn canonical(path: &std::path::Path) -> Vec<(i64, Vec<u8>)> {
        let db = rusqlite::Connection::open(path).unwrap();
        db.prepare("SELECT sequence,CAST(event_json AS BLOB) FROM event_log ORDER BY sequence")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }
    async fn turn(log: &EventLog, session: &str, message_id: &str) {
        let content: maka_agent_facts::input::MessageInput = format!("literal {session}").into();
        let input = InvocationInput::Message {
            content: content.clone(),
            source_messages: vec![RootSourceMessage {
                message: maka_agent_facts::input::DeliveredMessage {
                    origin: None,
                    message_id: message_id.into(),
                    content: content.clone(),
                    submitted_content_digest: content.content_digest().unwrap(),
                },
                unprepared_content: content,
                submitted_placement: Placement::CurrentTurn,
                disposition: MessageDisposition::TurnStarted,
                submitted_intent: None,
            }],
            request_fingerprint: None,
        };
        let invocation = Invocation {
            session_id: session.into(),
            turn_id: format!("turn-{session}"),
            run_id: format!("run-{session}"),
            invocation_id: format!("inv-{session}"),
        };
        for fact in [
            Fact::InvocationOpened {
                configuration: None,
                input,
            },
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Completed,
            },
        ] {
            log.append(&EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap())
                .await
                .unwrap();
        }
    }
    #[tokio::test]
    async fn public_copy_preserves_bare_target_and_earliest_claimant() {
        for (source_first, collision) in [(true, true), (false, true), (true, false)] {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("copy.sqlite");
            let log = EventLog::open(&path).await.unwrap();
            log.create_session("source", "source", &json!({}), 1)
                .await
                .unwrap();
            let source_id = "same";
            let target_id = if collision { "same" } else { "other" };
            if source_first {
                turn(&log, "source", source_id).await;
                turn(&log, "target", target_id).await;
            } else {
                turn(&log, "target", target_id).await;
                turn(&log, "source", source_id).await;
            }
            assert!(log.get_session::<Value>("target").await.unwrap().is_none());
            let before = canonical(&path);
            assert_eq!(before.len(), 4);
            // Warm the real bare target body cache before inheriting an earlier
            // source claimant; obsolete cache uniqueness must not pin the later ID.
            assert_eq!(
                log.transcript_headers(
                    "target",
                    &TranscriptRead {
                        through: 4,
                        position: None,
                        direction: TranscriptDirection::Newer,
                        limit: 8
                    }
                )
                .await
                .unwrap()
                .len(),
                3
            );
            let source = log.get_session::<Value>("source").await.unwrap().unwrap();
            let request = SessionCopy {
                source_session_id: "source".into(),
                target_session_id: "target".into(),
                expected_source_revision: source.revision,
                purpose: maka_agent_facts::session::CopyPurpose::Branch {
                    turn_id: None,
                    side_conversation: false,
                },
            };
            let notices = log.subscribe_commits();
            let high = *notices.borrow();
            let SessionCopyResult::Committed(copy) = log
                .copy_session(request.clone(), &json!({}), 2)
                .await
                .unwrap()
            else {
                panic!("copy did not commit")
            };
            assert_eq!(copy.id, "target");
            assert_eq!(canonical(&path), before);
            assert_eq!(*notices.borrow(), high);
            assert!(!notices.has_changed().unwrap());
            let db = rusqlite::Connection::open(&path).unwrap();
            let members: i64 = db
                .query_row(
                    "SELECT COUNT(*) FROM session_history_members WHERE session_id='target'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(members, 2);
            if collision {
                assert_eq!(db.query_row("SELECT source_sequence,claimant_source_sequence,claimant_item_index,attempted_item_index,reason FROM transcript_failures WHERE session_id='target'",[],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?,r.get::<_,i64>(3)?,r.get::<_,String>(4)?))).unwrap(),(3,1,0,0,"message identity is already claimed".into()));
                assert_eq!(db.query_row("SELECT count(*) FROM transcript_directory WHERE session_id='target' AND source_sequence=3",[],|r|r.get::<_,i64>(0)).unwrap(),0);
            }
            drop(db);
            let headers = log
                .transcript_headers(
                    "target",
                    &TranscriptRead {
                        through: 1,
                        position: None,
                        direction: TranscriptDirection::Newer,
                        limit: 8,
                    },
                )
                .await
                .unwrap();
            assert_eq!(headers.len(), 2);
            let first: Value = serde_json::from_slice(
                &log.transcript_fragment("target", headers[0].position, 0, headers[0].total_bytes)
                    .await
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(
                first["id"],
                if source_first { source_id } else { target_id }
            );
            assert_eq!(
                first["text"],
                if source_first {
                    "literal source"
                } else {
                    "literal target"
                }
            );
            assert_eq!(headers[0].position.source_sequence, 1);
            if collision {
                assert!(matches!(
                    log.transcript_headers(
                        "target",
                        &TranscriptRead {
                            through: 4,
                            position: None,
                            direction: TranscriptDirection::Newer,
                            limit: 8
                        }
                    )
                    .await,
                    Err(StoreError::TranscriptConflict)
                ));
            } else {
                assert_eq!(
                    log.transcript_headers(
                        "target",
                        &TranscriptRead {
                            through: 4,
                            position: None,
                            direction: TranscriptDirection::Newer,
                            limit: 8
                        }
                    )
                    .await
                    .unwrap()
                    .len(),
                    6
                );
            }
            assert_eq!(canonical(&path), before);
            assert!(matches!(
                log.copy_session(request, &json!({}), 99).await.unwrap(),
                SessionCopyResult::Committed(_)
            ));
            drop(notices);
            log.close().await.unwrap();
            let log = EventLog::open(&path).await.unwrap();
            assert_eq!(canonical(&path), before);
            assert_eq!(
                log.get_session::<Value>("target")
                    .await
                    .unwrap()
                    .unwrap()
                    .id,
                "target"
            );
            log.close().await.unwrap();
            println!(
                "COPY_BARE_SOURCE_FIRST={source_first} COLLISION={collision} COPY_ACCEPTED ORIGINAL_BYTES_UNCHANGED EARLY_FENCE_OK"
            );
        }
    }
}
