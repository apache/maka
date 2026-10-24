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
use std::time::Instant;

// Save release test executables at each revision, then alternate invocations of
// this test with MAKA_CONTEXT_BENCH_REPETITIONS=1 for at least five A/B pairs.
// Timings include fixed model-view capture only, after one unmeasured warmup.
// Bounded export assertions run outside the timed region.
#[tokio::test]
#[ignore = "release archive-heavy context performance regression harness"]
#[allow(clippy::assertions_on_constants)] // Compile in debug; reject only execution.
async fn archive_heavy_context() {
    assert!(!cfg!(debug_assertions), "run this benchmark with --release");
    let sizes = std::env::var("MAKA_CONTEXT_BENCH_ARCHIVES").unwrap_or("128,512".into());
    let repetitions: usize = std::env::var("MAKA_CONTEXT_BENCH_REPETITIONS")
        .unwrap_or("5".into())
        .parse()
        .unwrap();
    assert!(repetitions > 0);
    for count in sizes.split(',').map(|n| n.trim().parse::<usize>().unwrap()) {
        assert!(count > 0);
        let directory = tempfile::tempdir().unwrap();
        let log = EventLog::open(&directory.path().join("context-performance.sqlite"))
            .await
            .unwrap();
        open(&log, "history", false).await;
        let mut results = Vec::with_capacity(count);
        for index in 0..count {
            results.push(tool(&log, "history", &format!("step-{index}"), "x".repeat(8192)).await);
        }
        end(&log, "history").await;
        open(&log, "writer", false).await;
        for result in &results {
            log.append(&archive("writer", result)).await.unwrap();
        }
        let mut expected = None;
        let mut samples = Vec::with_capacity(repetitions);
        for sample in 0..=repetitions {
            let start = Instant::now();
            let context = log.read_model_view("session", Some("writer")).await;
            let context_ms = start.elapsed().as_secs_f64() * 1000.0;
            let context = match context {
                Ok(view) => {
                    let context = log
                        .capture_model_context("session", Some("writer"), 100_000, 64 * 1024 * 1024)
                        .await
                        .unwrap();
                    assert_eq!(context.source_evidence.digest, view.source_evidence.digest);
                    assert_eq!(
                        context.effective_source_digest,
                        view.effective_source_digest
                    );
                    context
                }
                Err(error) => {
                    eprintln!(
                        "{}",
                        json!({"benchmark":"archive_context", "archives":count, "sample":sample, "context_ms":context_ms, "errors":1, "error":format!("{error:?}")})
                    );
                    panic!("context benchmark failed");
                }
            };
            let archived: Vec<_> = context
                .tail
                .iter()
                .filter_map(|entry| match entry {
                    ContextEvent::Archived(entry) => Some(entry),
                    _ => None,
                })
                .collect();
            assert_eq!(archived.len(), count);
            for (actual, result) in archived.iter().zip(&results) {
                assert_eq!(actual.event_id, result.event().id);
                assert!(!actual.is_error);
            }
            let projection_bytes: usize = archived
                .iter()
                .map(|entry| serde_json::to_vec(&entry.replacement).unwrap().len())
                .sum();
            assert!(projection_bytes > 0);
            let evidence = (
                context.source_evidence.high_water,
                context.source_evidence.digest,
                context.effective_source_digest,
                projection_bytes,
            );
            if let Some(expected) = &expected {
                assert_eq!(&evidence, expected);
            } else {
                expected = Some(evidence.clone());
            }
            if sample > 0 {
                samples.push(context_ms);
                eprintln!(
                    "{}",
                    json!({"benchmark":"archive_context", "sample":sample, "context_ms":context_ms, "archived_count":archived.len(), "archived_projection_bytes":projection_bytes, "source_high_water":evidence.0, "errors":0})
                );
            }
        }
        samples.sort_by(f64::total_cmp);
        eprintln!(
            "{}",
            json!({"benchmark":"archive_context", "summary":true, "archived_count":count, "samples":repetitions, "min_ms":samples[0], "median_ms":samples[repetitions / 2], "max_ms":samples[repetitions - 1], "errors":0})
        );
        log.close().await.unwrap();
    }
}
