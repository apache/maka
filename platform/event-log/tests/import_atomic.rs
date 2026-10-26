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

use maka_agent_facts::event::{Fact, LogScope};
use maka_agent_facts::import::Content;
use maka_agent_facts::import::Record;
use maka_agent_facts::import::Source;
use maka_capabilities::storage::Namespace;
use maka_event_log::{EventLog, StoreError, sessions::PluginSession};
use maka_plugin_core::scope::Scope;
use serde_json::{Value, json};

fn owner(id: &str) -> PluginSession {
    PluginSession {
        session_id: id.into(),
        creator: Namespace::new("import.fixture", Scope::Profile).unwrap(),
        fingerprint: format!("original-{id}"),
        managed: false,
        authority_session_id: None,
    }
}
fn record(id: usize, text: String) -> Record {
    Record {
        source_message_id: format!("source-{id}"),
        source_turn_id: "foreign-turn".into(),
        timestamp: Some(17),
        content: Content::User { text },
    }
}
#[tokio::test]
async fn atomic_import_publishes_once_in_its_namespace() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("history.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let source = Source {
        adapter: "fixture".into(),
        session_id: "foreign".into(),
    };
    let claim = owner("owned-one");
    let records = vec![
        record(0, "Hello imported history".into()),
        Record {
            source_message_id: "call".into(),
            source_turn_id: "foreign-turn".into(),
            timestamp: None,
            content: Content::ToolCall {
                call_id: "foreign-call".into(),
                name: "Shell".into(),
                input: Some(json!({"command":"must not execute"})),
            },
        },
    ];
    let first = log
        .import_session(
            &claim,
            &source,
            &json!({"name":"copy"}),
            records.clone(),
            20,
        )
        .await
        .unwrap();
    assert_eq!(
        log.get_session::<Value>(&claim.session_id)
            .await
            .unwrap()
            .as_ref(),
        Some(&first)
    );
    assert_eq!(
        log.session_creator(&claim.session_id).await.unwrap(),
        Some(claim.creator.clone())
    );
    let published = log
        .scoped_prefix(
            LogScope::Session {
                id: claim.session_id.clone(),
            },
            16,
            64 * 1024,
        )
        .await
        .unwrap();
    assert_eq!(published.events.len(), 2);
    let imported: Vec<_> = published
        .events
        .iter()
        .map(|event| match &event.event.fact {
            Fact::MessageImported { record, .. } => record.as_ref(),
            _ => panic!("publication must preserve canonical imported records"),
        })
        .collect();
    assert_eq!(imported, records.iter().collect::<Vec<_>>());
    let original_digest = published.digest;
    assert!(
        log.unfinished_invocations(0, 16)
            .await
            .unwrap()
            .invocations
            .is_empty()
    );
    let through = *log.subscribe_commits().borrow();
    let retry = log
        .import_session(
            &claim,
            &source,
            &json!({"name":"copy"}),
            records.clone(),
            99,
        )
        .await
        .unwrap();
    assert_eq!(first, retry);
    assert_eq!(*log.subscribe_commits().borrow(), through);
    assert!(matches!(
        log.import_session(
            &PluginSession {
                fingerprint: "different-origin".into(),
                ..claim.clone()
            },
            &source,
            &json!({"name":"copy"}),
            records.clone(),
            20
        )
        .await,
        Err(StoreError::SessionConflict)
    ));
    let mut changed = records.clone();
    changed[0] = record(0, "Replaced source".into());
    assert!(matches!(
        log.import_session(&claim, &source, &json!({"name":"copy"}), changed, 20)
            .await,
        Err(StoreError::EventConflict)
    ));
    log.import_session(
        &owner("foreign-one"),
        &source,
        &json!(["different configuration"]),
        records.clone(),
        21,
    )
    .await
    .unwrap();
    log.import_session(
        &owner("owned-two"),
        &source,
        &json!({"name":"second"}),
        records,
        22,
    )
    .await
    .unwrap();
    let (page, next) = log
        .imported_sessions::<Value>("owned-", None, 1)
        .await
        .unwrap();
    assert_eq!(page[0].id, "owned-two");
    let (page, next) = log
        .imported_sessions::<Value>("owned-", next.as_deref(), 1)
        .await
        .unwrap();
    assert_eq!(page[0].id, "owned-one");
    assert!(next.is_none());
    assert!(
        log.imported_sessions::<Value>("owned-", Some("foreign-one"), 1)
            .await
            .is_err()
    );
    log.close().await.unwrap();
    let reopened = EventLog::open(&path).await.unwrap();
    assert_eq!(
        reopened
            .imported_sessions::<Value>("owned-", None, 16)
            .await
            .unwrap()
            .0
            .len(),
        2
    );
    assert_eq!(*reopened.subscribe_commits().borrow(), through + 4);
    assert_eq!(
        reopened
            .scoped_prefix(
                LogScope::Session {
                    id: claim.session_id.clone()
                },
                16,
                64 * 1024
            )
            .await
            .unwrap()
            .digest,
        original_digest
    );
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn second_record_sql_failure_rolls_back_the_complete_import_and_allows_retry() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("rollback.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let inspect = rusqlite::Connection::open(&path).unwrap();
    inspect
        .execute_batch(
            "CREATE TRIGGER fail_second_import_record BEFORE INSERT ON event_log
        WHEN NEW.kind='message_imported'
          AND json_extract(NEW.event_json,'$.fact.record.sourceMessageId')='source-1'
          AND EXISTS(SELECT 1 FROM event_log WHERE kind='message_imported'
            AND json_extract(event_json,'$.fact.record.sourceMessageId')='source-0')
        BEGIN SELECT RAISE(ABORT,'atomic second record fault'); END;",
        )
        .unwrap();
    let claim = owner("rollback-owned");
    let source = Source {
        adapter: "fixture".into(),
        session_id: "foreign".into(),
    };
    let records = vec![
        record(0, "first".into()),
        record(1, "second".into()),
        record(2, "third".into()),
    ];
    let notices = log.subscribe_commits();
    let through = *notices.borrow();
    let result = log
        .import_session(
            &claim,
            &source,
            &json!({"title":"Atomic"}),
            records.clone(),
            20,
        )
        .await;
    assert!(
        matches!(result,Err(StoreError::Sqlx(error)) if error.as_database_error().and_then(|error|error.code()).as_deref()==Some("1811"))
    );
    assert_eq!(*notices.borrow(), through);
    assert!(!notices.has_changed().unwrap());
    assert!(
        log.get_session::<Value>(&claim.session_id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        log.session_creator(&claim.session_id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        log.imported_sessions::<Value>("rollback-", None, 16)
            .await
            .unwrap()
            .0
            .is_empty()
    );
    assert!(log.prefix(16, 64 * 1024).await.unwrap().events.is_empty());
    inspect
        .execute_batch("DROP TRIGGER fail_second_import_record")
        .unwrap();
    drop(inspect);
    let accepted = log
        .import_session(
            &claim,
            &source,
            &json!({"title":"Atomic"}),
            records.clone(),
            20,
        )
        .await
        .unwrap();
    assert_eq!(
        log.imported_sessions::<Value>("rollback-", None, 16)
            .await
            .unwrap()
            .0,
        vec![accepted.clone()]
    );
    let published = log.prefix(16, 64 * 1024).await.unwrap();
    let imported: Vec<_> = published
        .events
        .iter()
        .map(|event| match &event.event.fact {
            Fact::MessageImported { record, .. } => record.as_ref(),
            _ => panic!("retry must publish only the complete ordered import"),
        })
        .collect();
    assert_eq!(imported, records.iter().collect::<Vec<_>>());
    let digest = published.digest;
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    let notices = log.subscribe_commits();
    assert_eq!(
        log.import_session(&claim, &source, &json!({"title":"Atomic"}), records, 99)
            .await
            .unwrap(),
        accepted
    );
    assert!(!notices.has_changed().unwrap());
    assert_eq!(log.prefix(16, 64 * 1024).await.unwrap().digest, digest);
    log.close().await.unwrap();
}

// Original four-record witness: preserve its distinct source IDs, record order,
// normalized duplicate key, inputs and result instead of repairing the fixture.
fn duplicate_calls() -> Vec<Record> {
    [
        Content::User {
            text: "import literal".into(),
        },
        Content::ToolCall {
            call_id: "same".into(),
            name: "Read".into(),
            input: None,
        },
        Content::ToolCall {
            call_id: "same".into(),
            name: "Read".into(),
            input: None,
        },
        Content::ToolResult {
            call_id: "same".into(),
            output: json!({"literal":"result"}),
            is_error: false,
        },
    ]
    .into_iter()
    .enumerate()
    .map(|(i, content)| Record {
        source_message_id: format!("m{i}"),
        source_turn_id: "turn".into(),
        timestamp: Some(1),
        content,
    })
    .collect()
}

fn import_state(db: &rusqlite::Connection) -> (Vec<(i64, Vec<u8>)>, String) {
    let events = db
        .prepare("SELECT sequence,CAST(event_json AS BLOB) FROM event_log ORDER BY sequence")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let publication = db.query_row(
        "SELECT json_array(
           (SELECT json_group_array(json_array(id,fingerprint,revision,created_at,updated_at,archived,configuration))
              FROM (SELECT * FROM session_control ORDER BY id)),
           (SELECT json_group_array(json_array(session_id,source_json,configuration,created_at,state,records,bytes,conversation))
              FROM (SELECT * FROM session_imports ORDER BY session_id)),
           (SELECT json_group_array(json_array(session_id,package_id,scope_id,fingerprint,managed,authority_session_id))
              FROM (SELECT * FROM plugin_sessions ORDER BY session_id)),
           (SELECT json_group_array(json_array(sequence,ordinal,session_id,message_at,preview,message_id))
              FROM (SELECT * FROM catalog_messages ORDER BY sequence,ordinal)),
           (SELECT json_group_array(json_array(singleton,sequence)) FROM catalog_message_watermark),
           (SELECT json_group_array(json_array(singleton,revision)) FROM session_catalog_revision),
           (SELECT json_group_array(json_array(session_id,has_unread,last_read_message_id))
              FROM (SELECT * FROM session_read_state ORDER BY session_id)),
           (SELECT seq FROM sqlite_sequence WHERE name='event_log'))",
        [], |row| row.get(0),
    ).unwrap();
    (events, publication)
}

#[tokio::test]
async fn duplicate_normalized_calls_reject_the_complete_new_import_atomically() {
    for cross_turn in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("duplicate.sqlite");
        let log = EventLog::open(&path).await.unwrap();
        let db = rusqlite::Connection::open(&path).unwrap();
        let source = Source {
            adapter: "fixture".into(),
            session_id: "foreign".into(),
        };
        let kept = log
            .import_session(
                &owner("kept"),
                &source,
                &json!({}),
                vec![record(0, "retained control".into())],
                10,
            )
            .await
            .unwrap();
        let before = import_state(&db);
        assert_eq!(
            before.0.len(),
            1,
            "the unchanged state proof has a real canonical control"
        );
        let prefix = log.prefix(16, 64 * 1024).await.unwrap();
        let notices = log.subscribe_commits();
        let high = *notices.borrow();
        let claim = owner("duplicate-owned");
        let mut records = duplicate_calls();
        if cross_turn {
            records[2].source_turn_id = "other-turn".into();
        }
        assert!(matches!(
            log.import_session(&claim, &source, &json!({}), records, 20).await,
            Err(StoreError::InvalidTransition(reason)) if reason == "duplicate imported tool call identity"
        ));
        assert_eq!(import_state(&db), before);
        assert_eq!(*notices.borrow(), high);
        assert!(!notices.has_changed().unwrap());
        let after = log.prefix(16, 64 * 1024).await.unwrap();
        assert_eq!(after.high_water, prefix.high_water);
        assert_eq!(after.digest, prefix.digest);
        assert!(
            log.get_session::<Value>(&claim.session_id)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            log.session_creator(&claim.session_id)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            log.imported_sessions::<Value>("duplicate-", None, 16)
                .await
                .unwrap()
                .0
                .is_empty()
        );
        assert_eq!(log.get_session::<Value>("kept").await.unwrap(), Some(kept));
        log.close().await.unwrap();
        let log = EventLog::open(&path).await.unwrap();
        assert_eq!(import_state(&db), before);
        assert!(
            log.get_session::<Value>(&claim.session_id)
                .await
                .unwrap()
                .is_none()
        );
        log.close().await.unwrap();
    }
}

#[tokio::test]
async fn import_retry_verifies_original_bytes_before_new_call_uniqueness() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("retry.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    let source = Source {
        adapter: "fixture".into(),
        session_id: "foreign".into(),
    };
    let claim = owner("retry-owned");
    let mut records = duplicate_calls();
    let Content::ToolCall { call_id, .. } = &mut records[2].content else {
        unreachable!()
    };
    *call_id = "other".into();
    // A matching result, a call with no result, and an orphan result keep their
    // existing import semantics; only repeated ToolCall keys are rejected.
    records.push(Record {
        source_message_id: "m4".into(),
        source_turn_id: "turn".into(),
        timestamp: Some(1),
        content: Content::ToolResult {
            call_id: "unmatched".into(),
            output: json!({"orphan":true}),
            is_error: false,
        },
    });
    let first = log
        .import_session(
            &claim,
            &source,
            &json!({"name":"copy"}),
            records.clone(),
            20,
        )
        .await
        .unwrap();
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    let before = import_state(&db);
    let notices = log.subscribe_commits();
    let high = *notices.borrow();
    assert_eq!(
        log.import_session(
            &claim,
            &source,
            &json!({"name":"copy"}),
            records.clone(),
            99
        )
        .await
        .unwrap(),
        first
    );
    assert_eq!(import_state(&db), before);
    assert_eq!(*notices.borrow(), high);
    assert!(!notices.has_changed().unwrap());
    // Same source identities/count, but this changed retry now introduces the
    // duplicate normalized key. Original-byte replay must still win.
    records[2].content = Content::ToolCall {
        call_id: "same".into(),
        name: "Read".into(),
        input: None,
    };
    assert!(matches!(
        log.import_session(&claim, &source, &json!({"name":"copy"}), records, 99)
            .await,
        Err(StoreError::EventConflict)
    ));
    assert_eq!(import_state(&db), before);
    assert_eq!(*notices.borrow(), high);
    assert!(!notices.has_changed().unwrap());
    log.close().await.unwrap();
}

#[tokio::test]
async fn second_record_projection_failure_leaves_no_partial_import_after_reopen() {
    for trigger in [
        "CREATE TRIGGER fail_import_projection BEFORE INSERT ON context_source_prefixes
         WHEN NEW.kind='session' AND NEW.sequence=2
         BEGIN SELECT RAISE(ABORT,'import source fault'); END;",
        "CREATE TRIGGER fail_import_projection BEFORE INSERT ON context_semantic_fragment_pieces
         WHEN NEW.source_sequence=2
         BEGIN SELECT RAISE(ABORT,'import semantic fault'); END;",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("projection-rollback.sqlite");
        let log = EventLog::open(&path).await.unwrap();
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute_batch(trigger)
            .unwrap();
        let claim = owner("rollback-projection");
        let source = Source {
            adapter: "fixture".into(),
            session_id: "foreign".into(),
        };
        let records = vec![
            record(0, "first".into()),
            record(1, "second".into()),
            record(2, "third".into()),
        ];
        let notices = log.subscribe_commits();
        let failure = log
            .import_session(&claim, &source, &json!({}), records.clone(), 20)
            .await
            .unwrap_err();
        let StoreError::Sqlx(error) = failure else {
            panic!("projection failure must retain SQLx database category")
        };
        let database = error.as_database_error().unwrap();
        assert!(database.message().contains("import ") && database.message().contains(" fault"));
        assert!(database.code().is_some());
        assert!(!notices.has_changed().unwrap());
        log.close().await.unwrap();
        let reopened = EventLog::open(&path).await.unwrap();
        assert!(
            reopened
                .get_session::<Value>(&claim.session_id)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            reopened
                .session_creator(&claim.session_id)
                .await
                .unwrap()
                .is_none()
        );
        let inspect = rusqlite::Connection::open(&path).unwrap();
        for table in [
            "event_log",
            "session_imports",
            "context_source_prefixes",
            "context_semantic_rows",
            "context_semantic_frontiers",
            "catalog_messages",
            "transcript_directory",
        ] {
            assert_eq!(
                inspect
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                0,
                "partial {table}"
            );
        }
        inspect
            .execute_batch("DROP TRIGGER fail_import_projection")
            .unwrap();
        reopened
            .import_session(&claim, &source, &json!({}), records.clone(), 20)
            .await
            .unwrap();
        let published = reopened.prefix(16, 64 * 1024).await.unwrap();
        assert_eq!(published.events.len(), 3);
        assert_eq!(
            inspect
                .query_row("SELECT COUNT(*) FROM context_source_prefixes", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            6
        );
        assert_eq!(
            inspect
                .query_row(
                    "SELECT through_sequence FROM context_semantic_heads WHERE session_id=?",
                    [&claim.session_id],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            3
        );
        reopened.close().await.unwrap();
    }
}

#[tokio::test]
async fn retained_orphan_physical_proof_still_blocks_complete_import() {
    use maka_agent_facts::event::{EventWrite, Invocation, InvocationInput, RuntimeEvent};

    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("retained-owner.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let claim = owner("retained-owner");
    let opening = RuntimeEvent::new(
        Invocation {
            session_id: claim.session_id.clone(),
            turn_id: "existing-turn".into(),
            run_id: "existing-run".into(),
            invocation_id: "existing-invocation".into(),
        },
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Code {
                source: "physical proof".into(),
            },
        },
    );
    log.append(&EventWrite::plain(opening).unwrap())
        .await
        .unwrap();
    log.close().await.unwrap();
    let inspect = rusqlite::Connection::open(&path).unwrap();
    inspect
        .execute_batch(
            "UPDATE event_log SET retained_json=event_json,body_digest='fixture',event_json=NULL",
        )
        .unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert!(
        log.get_session::<Value>(&claim.session_id)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        inspect
            .query_row(
                "SELECT COUNT(*) FROM context_source_prefixes WHERE kind='session' AND owner=?",
                [&claim.session_id],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert!(matches!(
        log.import_session(
            &claim,
            &Source {
                adapter: "fixture".into(),
                session_id: "foreign".into()
            },
            &json!({}),
            vec![record(0, "incoming".into())],
            20,
        )
        .await,
        Err(StoreError::SessionConflict),
    ));
    assert!(
        log.session_creator(&claim.session_id)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        inspect
            .query_row("SELECT COUNT(*) FROM event_log", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    log.close().await.unwrap();
}
