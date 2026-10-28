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

//! Opt-in release probe for many model steps inside one physical invocation.
use super::*;
use maka_agent_facts::model::{ModelFinishReason, assembly::StepBuilder};
use serde_json::json;
use std::time::Instant;

#[tokio::test]
#[ignore = "release performance probe for one long invocation"]
#[allow(clippy::assertions_on_constants)]
async fn one_invocation_transcript() {
    assert!(!cfg!(debug_assertions), "run with --release");
    let sizes = std::env::var("MAKA_TRANSCRIPT_BENCH_STEPS").unwrap_or("128,512".into());
    let repetitions: usize = std::env::var("MAKA_TRANSCRIPT_BENCH_REPETITIONS")
        .unwrap_or("5".into())
        .parse()
        .unwrap();
    assert!(repetitions > 0);
    for steps in sizes.split(',').map(|size| size.parse::<usize>().unwrap()) {
        assert!(steps > 0);
        let fixture = tempfile::tempdir().unwrap();
        let database = fixture.path().join("source.sqlite");
        let log = EventLog::open(&database).await.unwrap();
        log.append(&event("a", opening())).await.unwrap();
        for step in 0..steps {
            let name = format!("s-{step}");
            let request = request(&name);
            let Fact::ModelRequested { step_id, .. } = &request else {
                unreachable!()
            };
            let step_id = step_id.clone();
            let mut writes = vec![event("a", request)];
            let text = format!("one-invocation-step-{step}. ");
            let mut observations = vec![ModelEvent::PartStarted {
                id: "text".into(),
                text_kind: TextKind::Text,
                provider_options: None,
            }];
            observations.extend((0..13).map(|_| ModelEvent::PartDelta {
                id: "text".into(),
                text: text.clone(),
                provider_options: None,
            }));
            observations.push(ModelEvent::PartFinished {
                id: "text".into(),
                provider_options: None,
            });
            observations.push(ModelEvent::Finished {
                reason: ModelFinishReason::Stop,
                usage: ModelUsage::default(),
                provider_options: None,
            });
            let mut builder = StepBuilder::for_step(&step_id).unwrap();
            for observation in observations {
                builder.push(observation.clone()).unwrap();
                writes.push(event("a", observe(&name, observation)));
            }
            writes.push(event(
                "a",
                Fact::ModelCompleted {
                    step_id,
                    output: builder.finish().unwrap(),
                },
            ));
            assert_eq!(writes.len(), 18);
            log.append_batch(&writes).await.unwrap();
        }
        let through = end(&log, "a", InvocationOutcome::Completed).await;
        assert_eq!(through, (steps * 18 + 2) as u64);
        log.close().await.unwrap();
        for repetition in 0..repetitions {
            let sample = tempfile::tempdir().unwrap();
            let path = sample.path().join("sample.sqlite");
            std::fs::copy(&database, &path).unwrap();
            let log = EventLog::open(&path).await.unwrap();
            let started = Instant::now();
            crate::transcript_cache::materialize_all_rows(&log, "a", through)
                .await
                .unwrap();
            let body_materialize_ms = started.elapsed().as_secs_f64() * 1000.0;
            let db = Connection::open(&path).unwrap();
            let texts: Vec<String> = crate::test_store::inspect_cache(&log, move |db| {
                db.prepare(
                    "SELECT json_extract(payload, '$.text') FROM temp.transcript_rows
                 WHERE session_id='a' AND json_extract(payload, '$.type')='assistant'
                 ORDER BY source_sequence, item_index",
                )
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
            })
            .await;
            assert_eq!(texts.len(), steps);
            for (step, text) in texts.iter().enumerate() {
                assert_eq!(text, &format!("one-invocation-step-{step}. ").repeat(13));
            }

            println!(
                "{}",
                json!({"benchmark":"one_invocation_transcript", "shape":"one_invocation",
                "model_steps":steps, "history_events":through, "repetition":repetition,
                "body_materialize_ms":body_materialize_ms,
                "assistant_messages":texts.len(), "errors":0})
            );
            drop(db);
            log.close().await.unwrap();
        }
    }
}
