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

async fn drain(log: &EventLog) {
    for _ in 0..10_000 {
        let registry = log.prepared.clone();
        let more = log
            .connection
            .run(move |connection| {
                Box::pin(async move { gc::maintain(connection, &registry).await })
            })
            .await
            .unwrap();
        if !more {
            return;
        }
    }
    panic!("prepared collector did not quiesce");
}
async fn counts(log: &EventLog) -> (i64, i64, i64, i64) {
    log.connection
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
            .prepare_model_view(selection(sequence), "stable")
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
        .prepare_model_view(selection(1), "stable")
        .await
        .unwrap();
    render(&log, &build, &BTreeMap::new()).await;
    let view = log.finish_prepared(&build).await.unwrap();
    drop(build);
    let mut first = None;
    for variant in 0..128 {
        let codec = format!("codec-{variant}");
        let build = log
            .prepare_wire_view(&view, WireFormat::Responses, &codec)
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
    let mut block = Box::pin(log.connection.run(move |_| {
        Box::pin(async move {
            entered.send(()).unwrap();
            gate.await.unwrap();
            Ok(())
        })
    }));
    assert!(futures_util::poll!(&mut block).is_pending());
    entry.await.unwrap();
    let mut cancelled = Box::pin(log.prepare_model_view(selection(1), "cancelled"));
    assert!(futures_util::poll!(&mut cancelled).is_pending());
    drop(cancelled);
    release.send(()).unwrap();
    block.await.unwrap();
    // This serialized job follows the accepted cancelled request. Its result's
    // Drop has run even though no observer ever acquired the PreparedBuild.
    log.connection
        .run(|_| Box::pin(async { Ok(()) }))
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
        .connection
        .run(|connection| {
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
        wire_id: None,
        wire_bytes: 0,
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
    let content = tree::save_group(&mut db, &group).await.unwrap();
    let root = tree::insert(&mut db, None, 1, content, group)
        .await
        .unwrap();
    assert_eq!(tree::totals(&mut db, root.as_deref()).await.unwrap().0, 0);
    assert!(tree::weight(&mut db, root.as_deref()).await.unwrap() > 64 * 1024);
}

#[tokio::test]
async fn cancelled_partial_assembly_releases_disk_frontier_and_staging() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("events.sqlite"))
        .await
        .unwrap();
    for sequence in 1..=130 {
        seed(&log, sequence, sequence, false).await;
    }
    let build = log
        .prepare_model_view(selection(130), "cancel-frontier")
        .await
        .unwrap();
    assert_eq!(render(&log, &build, &BTreeMap::new()).await, 130);
    let mut saw_frontier = false;
    for _ in 0..100 {
        let id = build.id.clone();
        let lease = build.lease.clone();
        let (ready, frames, nodes): (bool, i64, i64) = log
            .connection
            .run(move |db| {
                Box::pin(async move {
                    let _lease = lease;
                    let mut tx = db.begin().await?;
                    let ready = assembly::advance(&mut tx, assembly::Kind::Logical, &id).await?;
                    let frames = sqlx::query_scalar("SELECT COUNT(*) FROM context_prepared_frames")
                        .fetch_one(&mut *tx)
                        .await?;
                    let nodes = sqlx::query_scalar("SELECT COUNT(*) FROM context_prepared_nodes")
                        .fetch_one(&mut *tx)
                        .await?;
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
    let remaining:(i64,i64,i64,i64,i64)=log.connection.run(|db|Box::pin(async move {
        Ok(sqlx::query_as("SELECT (SELECT COUNT(*) FROM context_prepared_frames),(SELECT COUNT(*) FROM context_prepared_assembly),(SELECT COUNT(*) FROM context_prepared_dirty),(SELECT COUNT(*) FROM context_prepared_nodes),(SELECT COUNT(*) FROM context_prepared_groups)").fetch_one(db).await?)
    })).await.unwrap();
    assert_eq!(remaining, (0, 0, 0, 0, 0));
    log.close().await.unwrap();
}
