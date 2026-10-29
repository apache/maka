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
use maka_agent_facts::tool_output::DurableToolProjection;
use std::time::Instant;

// Build each revision with `cargo test -p maka-event-log --release --test integration
// --no-run`, save its test executable, and alternate the saved executables with:
// `archive::performance::long_history_prune --ignored --exact --nocapture`.
// Setup and archive writes are excluded. Samples measure a warmed first page,
// not end-to-end pruning; no machine-dependent timing assertion is made.
#[tokio::test]
#[ignore = "release performance regression harness; creates substantial durable history"]
#[allow(clippy::assertions_on_constants)] // Compile in debug; reject only execution.
async fn long_history_prune() {
    assert!(!cfg!(debug_assertions), "run this benchmark with --release");
    let sizes = std::env::var("MAKA_PRUNE_BENCH_TURNS").unwrap_or("250,1000".into());
    let repetitions: usize = std::env::var("MAKA_PRUNE_BENCH_REPETITIONS")
        .unwrap_or("5".into())
        .parse()
        .unwrap();
    assert!(repetitions > 0);
    let projection_size: usize = std::env::var("MAKA_PRUNE_BENCH_PROJECTION_BYTES")
        .unwrap_or("12000".into())
        .parse()
        .unwrap();
    assert!(projection_size > 0 && projection_size <= 12000);
    for turns in sizes.split(',').map(|n| n.trim().parse::<usize>().unwrap()) {
        assert!(turns > 0);
        for one_invocation in [false, true] {
            let shape = if one_invocation {
                "one-invocation"
            } else {
                "many-invocations"
            };
            let directory = tempfile::tempdir().unwrap();
            let log = EventLog::open(&directory.path().join("performance.sqlite"))
                .await
                .unwrap();
            let mut results = Vec::with_capacity(turns);
            if one_invocation {
                open(&log, "long", false).await;
            }
            for index in 0..turns {
                let invocation = if one_invocation {
                    "long".into()
                } else {
                    format!("turn-{index}")
                };
                if !one_invocation {
                    open(&log, &invocation, false).await;
                }
                results.push(
                    tool(
                        &log,
                        &invocation,
                        &format!("step-{index}"),
                        "x".repeat(projection_size),
                    )
                    .await,
                );
                if !one_invocation {
                    end(&log, &invocation).await;
                }
            }
            if one_invocation {
                end(&log, "long").await;
            }
            open(&log, "pruner", false).await;
            let archivable = ArchivedPlaceholder::prepare(
                "probe".into(),
                "probe".into(),
                "Read".into(),
                &DurableToolProjection::Text {
                    text: "x".repeat(projection_size),
                },
            )
            .unwrap()
            .is_some();
            for archived in [false, true] {
                if archived && !archivable {
                    continue;
                }
                // Keep a nonempty live tail so archived-history timings cannot
                // appear fast simply because no candidate proof was checked.
                let offset = if archived {
                    turns.saturating_sub(16)
                } else {
                    0
                };
                if archived {
                    for result in &results[..offset] {
                        log.append(&archive("pruner", result)).await.unwrap();
                    }
                }
                let expected_count = (turns - offset).min(128);
                let mut timings = Vec::with_capacity(repetitions);
                let mut errors = 0;
                for sample in 0..=repetitions {
                    let start = Instant::now();
                    let batch = log
                        .prepare_prune_candidates(
                            "session",
                            Some("pruner"),
                            128,
                            4 * 1024 * 1024,
                            None,
                        )
                        .await;
                    let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                    let batch = match batch {
                        Ok(batch) => batch,
                        Err(error) => {
                            errors += 1;
                            eprintln!(
                                "prune-bench shape={shape} turns={turns} archived={archived} sample={sample} errors={errors} error={error:?}"
                            );
                            panic!("prune benchmark returned an error");
                        }
                    };
                    assert_eq!(batch.candidates.len(), expected_count);
                    assert_eq!(batch.next.is_some(), turns - offset > expected_count);
                    let mut projection_bytes = 0;
                    for (candidate, expected) in batch.candidates.iter().zip(&results[offset..]) {
                        assert_eq!(candidate.event_id, expected.event().id);
                        assert_eq!(candidate.tool_name, "Read");
                        assert_eq!(
                            candidate.tool_call_id,
                            candidate.event_id.strip_prefix("result-").unwrap()
                        );
                        let DurableToolProjection::Text { text } = &candidate.projection else {
                            panic!("unexpected projection");
                        };
                        assert_eq!(text, &"x".repeat(projection_size));
                        projection_bytes += text.len();
                    }
                    assert_eq!(projection_bytes, expected_count * projection_size);
                    if sample > 0 {
                        timings.push(elapsed);
                        eprintln!(
                            "prune-bench shape={shape} turns={turns} archived={archived} sample={sample} ms={elapsed:.3} candidates={} projection_bytes={projection_bytes} errors={errors}",
                            batch.candidates.len()
                        );
                    }
                }
                timings.sort_by(f64::total_cmp);
                eprintln!(
                    "prune-bench-summary shape={shape} turns={turns} archived={archived} n={repetitions} min_ms={:.3} median_ms={:.3} max_ms={:.3} errors={errors}",
                    timings[0],
                    timings[repetitions / 2],
                    timings[repetitions - 1]
                );
            }
            log.close().await.unwrap();
        }
    }
}
