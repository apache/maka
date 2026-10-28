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

pub(super) async fn drain(log: &EventLog) {
    for _ in 0..10_000 {
        let registry = log.prepared.clone();
        let more = log
            .prepared_store()
            .unwrap()
            .run(move |connection, in_flight| {
                Box::pin(async move { gc::maintain(connection, &registry, in_flight).await })
            })
            .await
            .unwrap();
        assert_log_refs(log).await;
        if !more {
            return;
        }
    }
    panic!("prepared collector did not quiesce");
}
async fn counts(log: &EventLog) -> (i64, i64, i64, i64) {
    log.prepared_store()
        .unwrap()
        .read_interruptible(|connection| {
            Box::pin(async move {
                Ok(sqlx::query_as(
                    "SELECT (SELECT COUNT(*) FROM context_prepared_builds),
            (SELECT COUNT(*) FROM context_prepared_wire_views),
            (SELECT COUNT(*) FROM context_prepared_chunks),
            (SELECT COUNT(*) FROM context_prepared_heads)",
                )
                .fetch_one(connection)
                .await?)
            })
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn idle_previous_wire_survives_collection_until_incremental_successor_finishes() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("events.sqlite"))
        .await
        .unwrap();
    let values = BTreeMap::new();
    let mut retained = None;
    for sequence in 1..=32 {
        seed(&log, sequence, sequence, false).await;
        let build = log
            .prepare_model_view(selection(sequence), "stable", None)
            .await
            .unwrap();
        assert_eq!(render(&log, &build, &values).await, 1);
        let view = log.finish_prepared(&build).await.unwrap();
        drop(build);
        // Force the previously racy inter-phase schedule: no prior reader owns
        // last turn's wire, and collection runs before this turn's encoding.
        drain(&log).await;
        let (wire, encoded) = encode(&log, &view, WireFormat::Responses, &values).await;
        assert_eq!(encoded, 1, "turn {sequence} must encode only its new group");
        if sequence == 1 {
            retained = Some(wire.clone());
        }
        drop(wire);
        drop(view);
        drain(&log).await;
        let (builds, wires, _, heads) = counts(&log).await;
        assert!(
            builds <= 2 && wires <= 2,
            "old roots leaked: {builds}/{wires}"
        );
        assert_eq!(heads, 1);
    }
    let retained = retained.unwrap();
    assert!(!bytes(&log, &retained).await.is_empty());
    drop(retained);
    drain(&log).await;
    let (builds, wires, _, _) = counts(&log).await;
    assert_eq!((builds, wires), (1, 1));
    log.close().await.unwrap();
}

#[tokio::test]
async fn codec_churn_over_identical_bytes_keeps_only_cached_and_live_roots() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("events.sqlite"))
        .await
        .unwrap();
    seed(&log, 1, 1, false).await;
    let build = log
        .prepare_model_view(selection(1), "stable", None)
        .await
        .unwrap();
    render(&log, &build, &BTreeMap::new()).await;
    let view = log.finish_prepared(&build).await.unwrap();
    drop(build);
    let mut first = None;
    for variant in 0..128 {
        let codec = format!("codec-{variant}");
        let build = log
            .prepare_wire_view(&view, WireFormat::Responses, &codec, None)
            .await
            .unwrap();
        let mut wire = encoded_wire(&[Message::user("1")], WireFormat::Responses, "ordinary");
        wire.codec = codec;
        log.put_prepared_wire_group(&build, &PreparedGroup { id: "1".into() }, wire)
            .await
            .unwrap();
        let wire = log.finish_prepared_wire(&build).await.unwrap();
        if variant == 0 {
            first = Some(wire.clone());
        }
        drop(wire);
        drop(build);
        drain(&log).await;
        let (builds, wires, chunks, heads) = counts(&log).await;
        assert_eq!((builds, chunks, heads), (1, 1, 1));
        assert!(wires <= 2, "codec history retained {wires} wire roots");
    }
    assert!(!bytes(&log, first.as_ref().unwrap()).await.is_empty());
    drop(first);
    drop(view);
    drain(&log).await;
    assert_eq!(counts(&log).await, (1, 1, 1, 1));
    log.close().await.unwrap();
}

#[tokio::test]
async fn cancelled_accepted_build_releases_its_unpublished_roots() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("events.sqlite"))
        .await
        .unwrap();
    seed(&log, 1, 1, false).await;
    let (entered, entry) = tokio::sync::oneshot::channel();
    let (release, gate) = tokio::sync::oneshot::channel();
    let prepared = log.prepared_store().unwrap();
    let mut block = Box::pin(prepared.run(move |_, _in_flight| {
        Box::pin(async move {
            entered.send(()).unwrap();
            gate.await.unwrap();
            Ok(())
        })
    }));
    assert!(futures_util::poll!(&mut block).is_pending());
    entry.await.unwrap();
    let mut cancelled = Box::pin(log.prepare_model_view(selection(1), "cancelled", None));
    assert!(futures_util::poll!(&mut cancelled).is_pending());
    drop(cancelled);
    release.send(()).unwrap();
    block.await.unwrap();
    // This serialized job follows the accepted cancelled request. Its result's
    // Drop has run even though no observer ever acquired the PreparedBuild.
    log.prepared_store()
        .unwrap()
        .run(|_, _in_flight| Box::pin(async { Ok(()) }))
        .await
        .unwrap();
    drain(&log).await;
    assert_eq!(counts(&log).await, (0, 0, 0, 0));
    log.close().await.unwrap();
}

#[tokio::test]
async fn private_cache_files_follow_real_close_and_canonical_durability_is_unchanged() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let (main_sync, cache_sync, vacuum, cache_path): (i64, i64, i64, String) = log
        .prepared_store()
        .unwrap()
        .run(|connection, _in_flight| {
            Box::pin(async move {
                let main = sqlx::query_scalar("PRAGMA main.synchronous")
                    .fetch_one(&mut *connection)
                    .await?;
                let cache = sqlx::query_scalar("PRAGMA prepared_cache.synchronous")
                    .fetch_one(&mut *connection)
                    .await?;
                let vacuum = sqlx::query_scalar("PRAGMA prepared_cache.auto_vacuum")
                    .fetch_one(&mut *connection)
                    .await?;
                let path = sqlx::query_scalar(
                    "SELECT file FROM pragma_database_list WHERE name='prepared_cache'",
                )
                .fetch_one(&mut *connection)
                .await?;
                Ok((main, cache, vacuum, path))
            })
        })
        .await
        .unwrap();
    assert_eq!((main_sync, cache_sync, vacuum), (2, 0, 2));
    assert!(std::path::Path::new(&cache_path).exists());
    log.create_session("durable", "manual", &serde_json::json!({}), 1)
        .await
        .unwrap();
    log.close().await.unwrap();
    assert!(!std::path::Path::new(&cache_path).exists());
    // A killed Host can leave a whole private database. The next canonical
    // writer lease owns and clears that marked namespace before rebuilding.
    std::fs::create_dir_all(std::path::Path::new(&cache_path).parent().unwrap()).unwrap();
    std::fs::write(&cache_path, b"crash-leftover").unwrap();
    let reopened = EventLog::open(&path).await.unwrap();
    assert!(!std::path::Path::new(&cache_path).exists());
    assert!(
        reopened
            .get_session::<serde_json::Value>("durable")
            .await
            .unwrap()
            .is_some()
    );
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn empty_groups_and_large_manifests_have_nonzero_cache_weight() {
    let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    sqlx::query("ATTACH ':memory:' AS prepared_cache")
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::raw_sql(include_str!("schema.sql"))
        .execute(&mut db)
        .await
        .unwrap();
    let group = Group {
        index_bytes: 0,
        dependencies: Vec::new(),
        members: (0..2048).collect(),
        messages: Vec::new(),
        breakdown: Default::default(),
        manifest: MediaManifest {
            aliases: Vec::new(),
            media: vec![MediaBinding::Unavailable {
                reason: "x".repeat(64 * 1024),
            }],
        },
    };
    let content = store_group_fixture(&mut db, &group).await;
    let root = tree::insert(&mut db, None, 1, content, group)
        .await
        .unwrap();
    assert_eq!(tree::totals(&mut db, root.as_deref()).await.unwrap().0, 0);
    assert!(tree::weight(&mut db, root.as_deref()).await.unwrap() > 64 * 1024);
}

#[tokio::test]
async fn cancelled_partial_assembly_releases_execution_frontier_and_staging() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("events.sqlite"))
        .await
        .unwrap();
    for sequence in 1..=130 {
        seed(&log, sequence, sequence, false).await;
    }
    let build = log
        .prepare_model_view(selection(130), "cancel-frontier", None)
        .await
        .unwrap();
    assert_eq!(render(&log, &build, &BTreeMap::new()).await, 130);
    assert_log_refs(&log).await;
    let mut saw_frontier = false;
    for _ in 0..100 {
        let id = build.id.clone();
        let lease = build.lease.clone();
        let (ready, frames, nodes): (bool, i64, i64) = log
            .prepared_store()
            .unwrap()
            .run(move |db, in_flight| {
                Box::pin(async move {
                    let _lease = lease;
                    let ready =
                        assembly::advance(db, in_flight, assembly::Kind::Logical, &id).await?;
                    let frames = sqlx::query_scalar(
                        "SELECT COUNT(*) FROM context_prepared_generation_nodes",
                    )
                    .fetch_one(&mut *db)
                    .await?;
                    let nodes = sqlx::query_scalar("SELECT COUNT(*) FROM context_prepared_nodes")
                        .fetch_one(&mut *db)
                        .await?;
                    let mut tx = db.begin().await?;
                    gc::collect_unreachable(&mut tx).await?;
                    assert_refs(&mut tx).await?;
                    tx.commit().await?;
                    Ok((ready, frames, nodes))
                })
            })
            .await
            .unwrap();
        assert!(!ready, "fixture must cancel before publication");
        if frames > 0 && nodes > 0 {
            saw_frontier = true;
            break;
        }
    }
    assert!(saw_frontier);
    drop(build);
    drain(&log).await;
    let (remaining, execution_states): ((i64, i64, i64, i64), usize) = log
        .prepared_store().unwrap()
        .run(|db, in_flight| Box::pin(async move {
            let remaining = sqlx::query_as("SELECT (SELECT COUNT(*) FROM context_prepared_generation_nodes),(SELECT COUNT(*) FROM context_prepared_dirty),(SELECT COUNT(*) FROM context_prepared_nodes),(SELECT COUNT(*) FROM context_prepared_groups)").fetch_one(db).await?;
            Ok((remaining, in_flight.generations.len()))
        })).await.unwrap();
    assert_eq!(remaining, (0, 0, 0, 0));
    assert_eq!(
        execution_states, 0,
        "cancelled generations must release their execution state"
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn startup_releases_schema_programs_and_preserves_wire_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("startup.sqlite");
    let message = Message::user("startup wire 中🙂");
    let expected = serde_json::to_vec(&("ordinary", &message)).unwrap();
    let values = BTreeMap::from([("1".into(), vec![message])]);
    for reopened in [false, true] {
        let log = EventLog::open(&path).await.unwrap();
        let cold = log
            .prepared_store()
            .unwrap()
            .resource_stats()
            .await
            .unwrap();
        assert!(
            cold.readers.iter().all(Option::is_none),
            "cold observations must not start readers"
        );
        let schema_program = |sql: &str| {
            let sql = sql.to_ascii_uppercase();
            [
                "CREATE TABLE PREPARED_CACHE.",
                "CREATE INDEX PREPARED_CACHE.",
                "CREATE UNIQUE INDEX PREPARED_CACHE.",
                "CREATE TRIGGER PREPARED_CACHE.",
            ]
            .iter()
            .any(|prefix| sql.contains(prefix))
        };
        assert!(
            !cold
                .writer
                .statements
                .iter()
                .filter_map(|statement| statement.sql.as_deref())
                .any(schema_program),
            "startup schema programs must be released before accepting work"
        );
        if !reopened {
            seed(&log, 1, 1, false).await;
        }
        let build = log
            .prepare_model_view(selection(1), "startup", None)
            .await
            .unwrap();
        assert_eq!(render(&log, &build, &values).await, 1);
        let view = log.finish_prepared(&build).await.unwrap();
        let (wire, encoded) = encode(&log, &view, WireFormat::Responses, &values).await;
        assert_eq!(encoded, 1);
        assert_eq!(bytes(&log, &wire).await, expected);
        let used = log
            .prepared_store()
            .unwrap()
            .resource_stats()
            .await
            .unwrap();
        assert_eq!(
            used.writer.connection_id, cold.writer.connection_id,
            "clearing setup statements keeps the original physical owner"
        );
        assert!(
            !used
                .writer
                .statements
                .iter()
                .filter_map(|statement| statement.sql.as_deref())
                .any(schema_program)
        );
        assert!(
            used.writer.statements.iter().any(|statement| cold
                .writer
                .statements
                .iter()
                .all(|cold| cold.statement_id != statement.statement_id)),
            "real wire preparation owns its new statements after startup cleanup"
        );
        eprintln!(
            "startup statements reopened={reopened}: cold handles={} bytes={}, used handles={} bytes={}",
            cold.writer.statements.len(),
            cold.writer.statement_bytes,
            used.writer.statements.len(),
            used.writer.statement_bytes
        );
        drop((wire, view, build));
        log.close().await.unwrap();
    }
}
