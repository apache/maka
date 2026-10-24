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
use crate::sessions::{MaterialCollection, SessionRetirement};
use maka_agent_facts::event::LogScope;

fn snapshot(db: &Connection) -> Vec<Vec<String>> {
    [
        "SELECT json_array(sequence,event_id,invocation_id,kind,operation_id,event_json,retained_json,body_digest) FROM event_log ORDER BY sequence",
        "SELECT json_array(owner_session_id,inherited,archive_sequence,sequence,event_id,event_json) FROM session_history_events ORDER BY owner_session_id,sequence,inherited",
        "SELECT json_array(session_id,sequence,archive_sequence) FROM session_history_members ORDER BY session_id,sequence",
        "SELECT json_array(session_id,sequence) FROM session_revision_sources ORDER BY session_id,sequence",
        "SELECT json_array(version,description,success,hex(checksum)) FROM _sqlx_migrations WHERE version<=38 ORDER BY version",
    ].into_iter().map(|sql| db.prepare(sql).unwrap().query_map([], |row| row.get(0)).unwrap()
        .collect::<Result<Vec<String>, _>>().unwrap()).collect()
}

fn material_indexes(db: &Connection) -> std::collections::BTreeSet<String> {
    db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name IN ('event_log','session_history_members','session_revision_sources')")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

async fn retire(log: &EventLog, session: &str) {
    let revision = log
        .get_session::<Value>(session)
        .await
        .unwrap()
        .unwrap()
        .revision;
    log.begin_session_removal(session, revision).await.unwrap();
    assert_eq!(
        log.finish_session_retirement(session).await.unwrap(),
        SessionRetirement::Removed
    );
}

async fn collect(log: &EventLog) {
    for _ in 0..100 {
        match log.collect_session_material(None).await.unwrap() {
            MaterialCollection::Done => return,
            MaterialCollection::Collected => {}
            other => panic!("unexpected retained material: {other:?}"),
        }
    }
    panic!("material collection failed to converge");
}

/// Literal schema-38 fixture state. Current retirement/material APIs own newer
/// derived tables and must only be exercised after the migration below.
async fn seed_collected_v38(log: &EventLog) {
    use sqlx::Connection as _;
    log.connection
        .run(|connection| Box::pin(async move {
            let mut tx=connection.begin().await?;
            let records:Vec<(String,String)>=sqlx::query_as("SELECT event_id,event_json FROM event_log WHERE json_extract(event_json,'$.invocation.session_id')='collected' ORDER BY sequence")
                .fetch_all(&mut *tx).await?;
            assert_eq!(records.len(),2);
            for (id,body) in records {
                let original:Value=serde_json::from_str(&body)?;
                let fact=match original["fact"]["kind"].as_str().unwrap() {
                    "invocation_opened"=>json!({"configuration":null}),
                    "invocation_ended"=>json!({"outcome":{"kind":"completed"}}),
                    other=>panic!("unexpected schema-38 collected fixture: {other}"),
                };
                let retained=json!({"id":original["id"],"invocation":original["invocation"],"recorded_at":original["recorded_at"],"fact":fact});
                sqlx::query("UPDATE event_log SET retained_json=?,body_digest=?,event_json=NULL WHERE event_id=?")
                    .bind(serde_json::to_string(&retained)?).bind(content_digest(body.as_bytes())).bind(id).execute(&mut *tx).await?;
            }
            for statement in [
                "DELETE FROM transcript_cache.rows WHERE session_id='collected'",
                "DELETE FROM transcript_cache.text WHERE session_id='collected'",
                "DELETE FROM transcript_directory WHERE session_id='collected'",
                "DELETE FROM transcript_failures WHERE session_id='collected'",
                "DELETE FROM catalog_messages WHERE session_id='collected'",
                "DELETE FROM session_read_state WHERE session_id='collected'",
                "DELETE FROM message_queue_state WHERE session_id='collected'",
                "DELETE FROM session_control WHERE id='collected'",
            ] { sqlx::query(statement).execute(&mut *tx).await?; }
            sqlx::query("INSERT INTO session_retirements(session_id,remove_session,completed) VALUES('collected',1,1)")
                .execute(&mut *tx).await?;
            tx.commit().await?;
            Ok(())
        }))
        .await.unwrap();
}

#[tokio::test]
async fn migration_39_preserves_live_collected_and_copied_evidence_and_original_ledger() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("events.sqlite");
    let log = open_at::<38>(&path).await;
    log.connection
        .run(|db| Box::pin(async move { crate::transcript::initialize_cache(db).await }))
        .await
        .unwrap();
    seed_canonical_image(&log).await;
    log.create_session("collected", "create-collected", &json!({}), 30)
        .await
        .unwrap();
    let mut original = invocation();
    original.session_id = "collected".into();
    original.turn_id = "collected-turn".into();
    original.run_id = "collected-run".into();
    original.invocation_id = "collected-invocation".into();
    for fact in [
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                source_messages: vec![],
                content: "private collected body".into(),
                request_fingerprint: None,
            },
        },
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    ] {
        append_historical(
            &log,
            &EventWrite::plain(RuntimeEvent::new(original.clone(), fact)).unwrap(),
        )
        .await;
    }
    seed_collected_v38(&log).await;
    let scoped = |id: &str| LogScope::Session { id: id.into() };
    // Prefix digests use the new source representation after migration. Original
    // rows and membership are compared byte-for-byte below; repeat opens must
    // then preserve the new native and inherited source identities.
    let mut native = None;
    let mut inherited = None;
    assert_eq!(log.navigation_fence("original").await.unwrap(), Some(4));
    assert_eq!(log.navigation_fence("copied").await.unwrap(), Some(4));
    let versions = log
        .observation_versions(&["original".into(), "copied".into()])
        .await
        .unwrap();
    assert_eq!(versions["original"].event, 4);
    assert_eq!(versions["copied"].event, 0);
    log.close().await.unwrap();
    let db = Connection::open(&path).unwrap();
    let before = snapshot(&db);
    let mut expected_indexes = material_indexes(&db);
    assert!(expected_indexes.remove("session_event_sequence"));
    expected_indexes.insert("context_run_opening".into());
    expected_indexes.insert("auxiliary_usage_meter_observation".into());
    assert_eq!(
        db.query_row("SELECT max(version) FROM _sqlx_migrations", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        38
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM event_log WHERE retained_json IS NOT NULL",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
    drop(db);
    for _ in 0..2 {
        let log = EventLog::open(&path).await.unwrap();
        let actual_native = log
            .scoped_prefix(scoped("original"), 64, 1_000_000)
            .await
            .unwrap()
            .digest;
        let actual_inherited = log
            .scoped_prefix(scoped("copied"), 64, 1_000_000)
            .await
            .unwrap()
            .digest;
        assert_eq!(&actual_native, native.get_or_insert(actual_native.clone()));
        assert_eq!(
            &actual_inherited,
            inherited.get_or_insert(actual_inherited.clone())
        );
        let actual = log
            .observation_versions(&["original".into(), "copied".into(), "missing".into()])
            .await
            .unwrap();
        assert_eq!(actual["original"].event, 4);
        assert_eq!(actual["copied"].event, 0);
        assert_eq!(actual.len(), 2);
        assert_eq!(log.navigation_fence("original").await.unwrap(), Some(4));
        assert_eq!(log.navigation_fence("copied").await.unwrap(), Some(4));
        assert!(
            log.session_events("copied", 0, 6, 64, 1_000_000)
                .await
                .unwrap()
                .events
                .is_empty()
        );
        let own = log
            .session_events("original", 0, 6, 64, 1_000_000)
            .await
            .unwrap();
        assert_eq!(
            own.events
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            [1, 2, 3, 4]
        );
        let db = Connection::open(&path).unwrap();
        assert_eq!(snapshot(&db), before);
        assert_eq!(material_indexes(&db), expected_indexes);
        assert_eq!(
            db.query_row("SELECT max(version) FROM _sqlx_migrations", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            current_version()
        );
        drop(db);
        log.close().await.unwrap();
    }
    let log = EventLog::open(&path).await.unwrap();
    retire(&log, "original").await;
    assert_eq!(
        log.collect_session_material(None).await.unwrap(),
        MaterialCollection::Retained("original".into())
    );
    assert_eq!(
        log.scoped_prefix(scoped("copied"), 64, 1_000_000)
            .await
            .unwrap()
            .digest,
        inherited.unwrap()
    );
    retire(&log, "copied").await;
    collect(&log).await;
    log.close().await.unwrap();
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM event_log WHERE event_json IS NOT NULL",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM event_log WHERE retained_json IS NOT NULL",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        6
    );
}
