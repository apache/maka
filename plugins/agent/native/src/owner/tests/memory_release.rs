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
use futures_util::FutureExt;

// Fixed live concurrency and source size isolate growth in settled Session count.
const ACTIVE: usize = 64;
const WAVES: usize = 32;
const SOURCE_BYTES: usize = 4 * 1024;

async fn rss_bytes() -> u64 {
    tokio::task::spawn_blocking(|| {
        let output = std::process::Command::new("ps")
            .args(["-o", "rss=", "-p", &std::process::id().to_string()])
            .output()
            .expect("read current process RSS with ps");
        assert!(output.status.success(), "ps RSS observation failed");
        std::str::from_utf8(&output.stdout)
            .unwrap()
            .trim()
            .parse::<u64>()
            .expect("ps RSS in KiB")
            * 1024
    })
    .await
    .unwrap()
}

fn connection_metrics(stats: maka_event_log::connection::SqliteResourceStats) -> Value {
    json!({
        "connectionId": stats.connection_id,
        "cachedStatements": stats.cached_statements,
        "liveStatements": stats.statements.len(),
        "cacheBytes": stats.cache_bytes,
        "schemaBytes": stats.schema_bytes,
        "statementBytes": stats.statement_bytes,
        "lookasideSlots": stats.lookaside_slots,
        "cacheHits": stats.cache_hits,
        "cacheMisses": stats.cache_misses,
        "cacheSpills": stats.cache_spills,
    })
}

fn unix_micros() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("diagnostic wall clock follows Unix epoch")
        .as_micros()
}

async fn sample(
    fixture: &Fixture,
    phase: &str,
    settled: usize,
    active: usize,
    writer_ids: &[usize],
    peer_closures: Option<&BTreeMap<&str, usize>>,
) {
    let started_unix_micros = unix_micros();
    let rss_before = rss_bytes().await;
    let stats = fixture.store.sqlite_resource_stats().await.unwrap();
    let current_ids: Vec<_> = stats
        .iter()
        .map(|stats| stats.writer.connection_id)
        .collect();
    assert_eq!(
        current_ids, writer_ids,
        "observe the original SQLite owners"
    );
    let stats: Vec<_> = stats
        .into_iter()
        .map(|stats| {
            json!({
                "writer": connection_metrics(stats.writer),
                "readers": stats.readers.map(|reader| reader.map(connection_metrics)),
            })
        })
        .collect();
    let rss_after = rss_bytes().await;
    let finished_unix_micros = unix_micros();
    eprintln!(
        "MAKA_NATIVE_MEMORY_RELEASE {}",
        json!({
            "phase": phase,
            "startedUnixMicros": started_unix_micros,
            "finishedUnixMicros": finished_unix_micros,
            "peerClosures": peer_closures,
            "pid": std::process::id(),
            "settledSessions": settled,
            "active": active,
            "sourceBytes": SOURCE_BYTES,
            "rssBeforeStatsBytes": rss_before,
            "rssAfterStatsBytes": rss_after,
            "sqlite": stats,
        })
    );
}

async fn assert_drained(fixture: &Fixture) {
    fixture.drained().await;
    assert!(fixture.owner.workers.is_empty(), "all run workers joined");
    assert!(
        !fixture.owner.workers.is_closed(),
        "same Owner stays usable"
    );
    let runs = fixture.owner.runs.lock().await;
    assert!(runs.controls.is_empty(), "no live invocation controls");
    assert!(runs.preparing.is_empty(), "no preparation custody");
    assert!(
        runs.quarantined.is_empty(),
        "physical cleanup was confirmed"
    );
    assert!(!runs.closing, "original Owner remains open");
    assert!(
        !fixture.owner.stop.is_cancelled(),
        "Owner was not shut down"
    );
}

#[tokio::test]
#[ignore = "manual memory diagnostic; run alone with --ignored --nocapture --test-threads=1"]
async fn native_memory_release_after_joined_workers() {
    let (mut logs, _subscriber) = log_capture();
    let diagnostic = async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::new(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
        )
        .await;
        assert!(!fixture.owner.settings.goals);
        assert!(!fixture.owner.settings.scheduled_tasks);
        assert!(!fixture.owner.settings.automatic_titles);
        assert!(!fixture.owner.settings.recaps);
        assert!(!fixture.owner.settings.recall);
        assert!(Arc::ptr_eq(&fixture.store, &fixture.owner.store));
        let writer_ids: Vec<_> = fixture
            .store
            .sqlite_resource_stats()
            .await
            .unwrap()
            .into_iter()
            .map(|stats| stats.writer.connection_id)
            .collect();
        assert_drained(&fixture).await;
        sample(&fixture, "warmup", 0, 0, &writer_ids, None).await;
        sample(&fixture, "baseline", 0, 0, &writer_ids, None).await;
        for wave in 0..WAVES {
            let mut accepted = Vec::with_capacity(ACTIVE);
            let mut sockets = Vec::with_capacity(ACTIVE);
            for slot in 0..ACTIVE {
                let marker = format!("native-memory-release-{wave}-{slot}:");
                let source = format!("{marker}{}", "x".repeat(SOURCE_BYTES - marker.len()));
                let session = fixture.create(&marker).await;
                let sent = fixture
                    .mutation(
                        2,
                        "send",
                        json!({
                            "sessionId": session,
                            "message": source,
                            "model": fixture.selection().await,
                        }),
                        Uuid::new_v4(),
                    )
                    .await
                    .unwrap();
                let invocation = sent["invocationId"].as_str().unwrap().to_owned();
                let (mut socket, _) = listener.accept().await.unwrap();
                let body = request(&mut socket).await;
                assert_eq!(body["model"], "fixture-model");
                assert!(
                    body["messages"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|message| message["content"].as_str() == Some(source.as_str())),
                    "actual provider request contains the complete selected source"
                );
                drop(body);
                // No response bytes are sent: the real HTTP execution stays held.
                accepted.push((session, invocation));
                sockets.push(socket);
            }
            {
                let runs = fixture.owner.runs.lock().await;
                assert_eq!(runs.controls.len(), ACTIVE);
                assert!(runs.preparing.is_empty());
                assert!(runs.quarantined.is_empty());
                assert!(!runs.closing);
                assert!(!fixture.owner.stop.is_cancelled());
                for (session, invocation) in &accepted {
                    assert_eq!(runs.controls[session].invocation.invocation_id, *invocation);
                }
            }
            sample(&fixture, "held", wave * ACTIVE, ACTIVE, &writer_ids, None).await;
            for (session, invocation) in &accepted {
                let stopped = fixture
                    .mutation(
                        2,
                        "stop",
                        json!({"sessionId": session, "invocationId": invocation}),
                        Uuid::new_v4(),
                    )
                    .await
                    .unwrap();
                assert_eq!(stopped["requested"], true);
            }
            assert_drained(&fixture).await;
            // Observe peer closure rather than dropping server sockets to cause cleanup.
            let mut peer_closures = BTreeMap::new();
            for mut socket in sockets {
                let mut byte = [0];
                let kind = match socket.read(&mut byte).await {
                    Ok(0) => "eof",
                    Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {
                        "connection_reset"
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::ConnectionAborted => {
                        "connection_aborted"
                    }
                    Ok(count) => panic!("unexpected payload after cleanup: {:?}", &byte[..count]),
                    Err(error) => panic!("peer closure observation failed: {error}"),
                };
                *peer_closures.entry(kind).or_insert(0) += 1;
            }
            for (session, invocation) in &accepted {
                let execution = fixture
                    .query(
                        "execution",
                        json!({"sessionId": session, "invocationId": invocation}),
                    )
                    .await
                    .unwrap();
                assert_eq!(execution["execution"]["state"], "cancelled");
            }
            drop(accepted);
            // Execution queries must not introduce unaccounted auxiliary workers.
            assert_drained(&fixture).await;
            sample(
                &fixture,
                "joined",
                (wave + 1) * ACTIVE,
                0,
                &writer_ids,
                Some(&peer_closures),
            )
            .await;
        }
        assert_drained(&fixture).await;
        sample(
            &fixture,
            "idle_before",
            WAVES * ACTIVE,
            0,
            &writer_ids,
            None,
        )
        .await;
        // This is an idle observation window; both boundaries independently prove cleanup.
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert_drained(&fixture).await;
        sample(&fixture, "idle_after", WAVES * ACTIVE, 0, &writer_ids, None).await;
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    };
    let outcome =
        std::panic::AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(900), diagnostic))
            .catch_unwind()
            .await;
    let captured = log_text(&mut logs);
    if !captured.is_empty() {
        eprintln!("MAKA_NATIVE_MEMORY_RELEASE_LOGS\n{captured}");
    }
    match outcome {
        Ok(result) => result.expect("accepted executions must drain within the diagnostic budget"),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}
