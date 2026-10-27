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

//! Sequential Main/compact work through the actual Host and controlled HTTP model.
use super::*;
use futures_util::FutureExt;
use maka_agent_api::contract::{Observation, SessionActivity};
use maka_agent_facts::{
    context::{CheckpointMode, CompactOutcome, ModelPurpose},
    event::{Fact, InvocationOutcome, StoredEvent},
    model::{ModelFinishReason, ModelPart, TextKind},
};
use std::panic::AssertUnwindSafe;

struct ExpectedRequest {
    cycle: usize,
    purpose: ModelPurpose,
    input: String,
    reply: String,
    previous_summary: Option<String>,
    private_answer: Option<String>,
    main_prompt: Option<String>,
}

struct Arrival {
    cycle: usize,
    purpose: ModelPurpose,
    at: Instant,
    normalized_request_json_bytes: usize,
}

async fn events(
    fixture: &Fixture,
    session: &str,
    mut after: u64,
    through: u64,
) -> Vec<StoredEvent> {
    let mut result = Vec::new();
    loop {
        let page = fixture
            .session(session)
            .await
            .session_events(session, after, through, 512, usize::MAX)
            .await
            .unwrap();
        assert_eq!(page.through_sequence, through);
        result.extend(page.events);
        let Some(next) = page.next_after else {
            return result;
        };
        assert!(next > after && next <= through);
        after = next;
    }
}

fn evidence(
    events: &[StoredEvent],
    invocation: &str,
    purpose: ModelPurpose,
    reply: &str,
    previous_checkpoint: Option<&str>,
) -> (Value, Option<String>) {
    assert!(!events.is_empty());
    assert!(
        events
            .iter()
            .all(|event| event.event.invocation.invocation_id == invocation)
    );
    let requests: Vec<_> = events
        .iter()
        .filter_map(|event| match &event.event.fact {
            Fact::ModelRequested {
                purpose: actual,
                step_id,
                checkpoint_event_id,
                ..
            } => {
                assert_eq!(*actual, purpose);
                assert_eq!(checkpoint_event_id.as_deref(), previous_checkpoint);
                Some((event, step_id))
            }
            _ => None,
        })
        .collect();
    assert_eq!(requests.len(), 1);
    let completions: Vec<_> = events
        .iter()
        .filter(|event| match &event.event.fact {
            Fact::ModelCompleted { step_id, output } => {
                assert_eq!(step_id, requests[0].1);
                assert_eq!(output.finish_reason, ModelFinishReason::Stop);
                assert_eq!(output.usage.input_tokens, Some(1));
                assert_eq!(output.usage.output_tokens, Some(2));
                let text: String = output
                    .parts
                    .iter()
                    .filter_map(|part| match part {
                        ModelPart::Text {
                            text_kind: TextKind::Text,
                            text,
                            ..
                        } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect();
                assert_eq!(text, reply);
                true
            }
            _ => false,
        })
        .collect();
    assert_eq!(completions.len(), 1);
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event.event.fact, Fact::ToolDispatched { .. }))
            .count(),
        0
    );
    let checkpoints: Vec<_> = events
        .iter()
        .filter_map(|event| match &event.event.fact {
            Fact::ContextCheckpointRecorded { checkpoint } => Some((event, checkpoint)),
            _ => None,
        })
        .collect();
    let ended: Vec<_> = events
        .iter()
        .filter_map(|event| match &event.event.fact {
            Fact::InvocationEnded { outcome } => Some((event, outcome)),
            _ => None,
        })
        .collect();
    assert_eq!(ended.len(), 1);
    let checkpoint = match purpose {
        ModelPurpose::Main => {
            assert!(matches!(ended[0].1, InvocationOutcome::Completed));
            assert_eq!(checkpoints.len(), 0);
            None
        }
        ModelPurpose::Summary => {
            assert_eq!(checkpoints.len(), 1);
            let (event, checkpoint) = checkpoints[0];
            assert_eq!(checkpoint.mode, CheckpointMode::Standalone);
            assert_eq!(
                checkpoint.previous_checkpoint_id.as_deref(),
                previous_checkpoint
            );
            assert_eq!(checkpoint.summary.text, reply);
            assert_eq!(&checkpoint.summary_step_id, requests[0].1);
            assert!(checkpoint.covered_through < event.sequence);
            assert!(
                matches!(ended[0].1, InvocationOutcome::ContextCompactFinished {
                outcome: CompactOutcome::Compacted { checkpoint_id }
            } if checkpoint_id == &event.event.id)
            );
            Some(event.event.id.clone())
        }
    };
    (
        json!({"invocation_id":invocation,"request_event_id":requests[0].0.event.id,
        "model_step_id":requests[0].1,"completion_event_id":completions[0].event.id,
        "terminal_event_id":ended[0].0.event.id,"terminal_sequence":ended[0].0.sequence,
        "events":events.len(),"requests":requests.len(),"completions":completions.len(),
        "checkpoint_event_id":checkpoint,"previous_checkpoint_event_id":previous_checkpoint,
        "checkpoints":checkpoints.len(),"tool_dispatches":0}),
        checkpoint,
    )
}

async fn completed(load: &Load<'_>, session: &str, invocation: &str) {
    let execution = load
        .query(
            "execution",
            json!({"sessionId":session,"invocationId":invocation}),
        )
        .await;
    assert_eq!(execution["execution"]["state"], "completed");
    let observed: Observation =
        serde_json::from_value(load.query("observe", json!({"sessionId":session})).await).unwrap();
    assert!(observed.compacting.is_none());
    assert!(matches!(observed.session.activity, SessionActivity::Idle));
}

async fn phase(
    load: &Load<'_>,
    session: &str,
    expected: &ExpectedRequest,
    previous_checkpoint: Option<&str>,
    arrivals: &mut tokio::sync::mpsc::UnboundedReceiver<Arrival>,
) -> (Value, Option<String>, u64) {
    let before = *load
        .fixture
        .session(session)
        .await
        .subscribe_commits()
        .unwrap()
        .borrow();
    let cpu = usage().0;
    let start = Instant::now();
    let started = match expected.purpose {
        ModelPurpose::Main => load.send_message(session, &expected.input).await,
        ModelPurpose::Summary => {
            load.mutation(
                "compact",
                json!({"sessionId":session,"model":load.model,"prompt":expected.input}),
            )
            .await
        }
    };
    let admission_ms = start.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(started["kind"], "started", "{started}");
    let invocation = match expected.purpose {
        ModelPurpose::Main => started["invocationId"].as_str().unwrap(),
        ModelPurpose::Summary => started["execution"]["invocationId"].as_str().unwrap(),
    };
    let arrival = arrivals
        .recv()
        .await
        .expect("controlled HTTP phase must match its explicit plan");
    assert_eq!(arrival.cycle, expected.cycle);
    assert_eq!(arrival.purpose, expected.purpose);
    // This sequential fixture owns the tracker until shutdown. Wait for its
    // notification instead of charging a self-waking observer to each phase.
    assert!(load.fixture.owner.workers.close());
    load.fixture.owner.workers.wait().await;
    assert!(load.fixture.owner.workers.reopen());
    let completion_ms = start.elapsed().as_secs_f64() * 1000.0;
    let cpu_seconds = usage().0 - cpu;
    let through = *load
        .fixture
        .session(session)
        .await
        .subscribe_commits()
        .unwrap()
        .borrow();
    // Correctness reads below are outside the operation's measured interval.
    completed(load, session, invocation).await;
    let facts = events(load.fixture, session, before, through).await;
    let terminal_sequence = facts
        .iter()
        .find(|event| matches!(event.event.fact, Fact::InvocationEnded { .. }))
        .unwrap()
        .sequence;
    let (canonical, checkpoint) = evidence(
        &facts,
        invocation,
        expected.purpose,
        &expected.reply,
        previous_checkpoint,
    );
    let covered_through = facts.iter().find_map(|event| match &event.event.fact {
        Fact::ContextCheckpointRecorded { checkpoint } => Some(checkpoint.covered_through),
        _ => None,
    });
    (
        json!({"cycle":expected.cycle,"purpose":expected.purpose,"admission_ms":admission_ms,
        "request_receipt_ms":arrival.at.duration_since(start).as_secs_f64()*1000.0,
        "completion_ms":completion_ms,"cpu_seconds":cpu_seconds,
        "normalized_request_json_bytes":arrival.normalized_request_json_bytes,
        "input_bytes":expected.input.len(),"reply_bytes":expected.reply.len(),
        "before":before,"through":through,"covered_through":covered_through,"canonical":canonical}),
        checkpoint,
        terminal_sequence,
    )
}

pub(in crate::owner::tests) fn user_prompt(
    cycle: usize,
    cycles: usize,
    prompt_bytes: usize,
) -> String {
    if cycle == cycles {
        return "K32_FINAL_PROBE".into();
    }
    let prefix = format!("K32_USER_{cycle} ");
    let suffix = " K32_END";
    assert!(prompt_bytes >= prefix.len() + suffix.len());
    format!(
        "{prefix}{}{suffix}",
        "p".repeat(prompt_bytes - prefix.len() - suffix.len())
    )
}

pub(in crate::owner::tests) fn main_answer(cycle: usize, cycles: usize) -> String {
    if cycle == cycles {
        "K32_FINAL_DONE".into()
    } else {
        format!("K32_PRIVATE_ANSWER_{cycle}")
    }
}

fn expected_request(index: usize, cycles: usize, prompt_bytes: usize) -> ExpectedRequest {
    let cycle = index / 2;
    let purpose = if index.is_multiple_of(2) {
        ModelPurpose::Main
    } else {
        ModelPurpose::Summary
    };
    let previous_summary = cycle.checked_sub(1).map(|i| format!("K32_SUMMARY_{i}"));
    match purpose {
        ModelPurpose::Main => ExpectedRequest {
            cycle,
            purpose,
            input: user_prompt(cycle, cycles, prompt_bytes),
            reply: main_answer(cycle, cycles),
            previous_summary,
            private_answer: cycle.checked_sub(1).map(|i| main_answer(i, cycles)),
            main_prompt: None,
        },
        ModelPurpose::Summary => ExpectedRequest {
            cycle,
            purpose,
            input: format!("K32_SUMMARY_INSTRUCTION_{cycle}"),
            reply: format!("K32_SUMMARY_{cycle}"),
            previous_summary,
            private_answer: Some(main_answer(cycle, cycles)),
            main_prompt: Some(user_prompt(cycle, cycles, prompt_bytes)),
        },
    }
}

async fn original_history(
    load: &Load<'_>,
    session: &str,
    cycles: usize,
    prompt_bytes: usize,
) -> (usize, usize) {
    let through = *load
        .fixture
        .session(session)
        .await
        .subscribe_commits()
        .unwrap()
        .borrow();
    let mut input = json!({"sessionId":session,"through":through,"position":{"kind":"start"}});
    // Retain only each role's current expected message, never the complete transcript.
    let mut ids: [Option<String>; 2] = [None, None];
    let mut expected = [String::new(), String::new()];
    let mut offsets = [0, 0];
    let mut counts = [0, 0];
    let mut verified_bytes = [0, 0];
    loop {
        let page = load.query("history", input.clone()).await;
        assert_eq!(page["through"], through);
        assert_eq!(page["kind"], "ready");
        for chunk in page["chunks"].as_array().unwrap() {
            let role = match chunk["role"].as_str().unwrap() {
                "user" => 0,
                "assistant" => 1,
                _ => continue,
            };
            assert_eq!(chunk["field"], "body");
            let id = chunk["messageId"].as_str().unwrap();
            if ids[role].as_deref() != Some(id) {
                assert_eq!(offsets[role], expected[role].len());
                assert!(
                    counts[role] <= cycles,
                    "unexpected original transcript message"
                );
                expected[role] = if role == 0 {
                    user_prompt(counts[role], cycles, prompt_bytes)
                } else {
                    main_answer(counts[role], cycles)
                };
                ids[role] = Some(id.into());
                counts[role] += 1;
                offsets[role] = 0;
            }
            assert_eq!(chunk["offset"], offsets[role]);
            assert_eq!(chunk["totalBytes"], expected[role].len());
            let text = chunk["text"].as_str().unwrap();
            let end = offsets[role] + text.len();
            assert_eq!(Some(text), expected[role].get(offsets[role]..end));
            offsets[role] = end;
            verified_bytes[role] += text.len();
        }
        if page["after"].is_null() {
            break;
        }
        input["position"] = json!({"kind":"after","cursor":page["after"]});
    }
    assert_eq!(counts, [cycles + 1, cycles + 1]);
    assert_eq!(offsets, [expected[0].len(), expected[1].len()]);
    (verified_bytes[0], verified_bytes[1])
}

async fn run(cycles: usize, prompt_bytes: usize, timeout: Duration) -> Value {
    assert!(cycles > 0);
    let all_started = Instant::now();
    let request_count = 2 * cycles + 1;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let fixture = Fixture::new(
        &format!("http://{}/v1", listener.local_addr().unwrap()),
        None,
    )
    .await;
    let load = Load {
        fixture: &fixture,
        binding: fixture.binding(2).await,
        model: fixture.selection().await,
    };
    let created = load
        .mutation("create", fixture.create_input("Repeated compaction").await)
        .await;
    let session = created["session"]["id"].as_str().unwrap();
    memory_checkpoint("host_ready");
    let (arrived, mut arrivals) = tokio::sync::mpsc::unbounded_channel();
    let server = tokio::spawn(async move {
        let mut received = 0;
        for index in 0..request_count {
            let expected = expected_request(index, cycles, prompt_bytes);
            let (mut socket, _) = listener.accept().await.unwrap();
            let body = request(&mut socket).await;
            let at = Instant::now();
            let normalized_request_json_bytes = serde_json::to_vec(&body).unwrap().len();
            assert_eq!(body["model"], "fixture-model");
            let messages = body["messages"].as_array().unwrap();
            let has = |role: &str, text: &str| {
                messages.iter().any(|message| {
                    message["role"] == role && message["content"].as_str() == Some(text)
                })
            };
            assert!(
                has("user", &expected.input),
                "missing exact planned input for {:?} cycle {}",
                expected.purpose,
                expected.cycle
            );
            if let Some(previous) = &expected.previous_summary {
                assert!(messages.iter().any(|message| {
                    message["role"] == "user"
                        && message["content"]
                            .as_str()
                            .is_some_and(|text| text.ends_with(&format!("\n\n{previous}")))
                }));
            }
            match expected.purpose {
                ModelPurpose::Main => {
                    assert_eq!(
                        messages
                            .iter()
                            .rev()
                            .find(|message| message["role"] == "user")
                            .unwrap()["content"],
                        expected.input
                    );
                    if let Some(private) = &expected.private_answer {
                        assert!(!has("assistant", private));
                    }
                }
                ModelPurpose::Summary => {
                    assert_eq!(messages.last().unwrap()["role"], "user");
                    assert_eq!(messages.last().unwrap()["content"], expected.input);
                    assert!(has("user", expected.main_prompt.as_deref().unwrap()));
                    assert!(has(
                        "assistant",
                        expected.private_answer.as_deref().unwrap()
                    ));
                }
            }
            drop(body);
            arrived
                .send(Arrival {
                    cycle: expected.cycle,
                    purpose: expected.purpose,
                    at,
                    normalized_request_json_bytes,
                })
                .unwrap();
            response_with_text(&mut socket, &expected.reply).await;
            received += 1;
        }
        received
    });
    let checked = tokio::time::timeout(timeout, AssertUnwindSafe(async {
        let mut rows = Vec::new();
        let mut previous_checkpoint: Option<String> = None;
        let mut previous_coverage = 0;
        let mut main_terminal = 0;
        let mut main_count = 0;
        let mut summary_count = 0;
        let mut summary_bytes = 0;
        for index in 0..request_count {
            let expected = expected_request(index, cycles, prompt_bytes);
            let (row, checkpoint, terminal) = phase(&load, session, &expected, previous_checkpoint.as_deref(), &mut arrivals).await;
            match expected.purpose {
                ModelPurpose::Main => { main_count += 1; main_terminal = terminal; }
                ModelPurpose::Summary => {
                    let coverage = row["covered_through"].as_u64().unwrap();
                    assert!(coverage > previous_coverage && coverage >= main_terminal);
                    previous_coverage = coverage;
                    previous_checkpoint = checkpoint;
                    // The next Main proves adoption through its request and HTTP body without prewarming its source.
                    summary_count += 1;
                    summary_bytes += expected.reply.len();
                }
            }
            rows.push(row);
        }
        assert_eq!(main_count, cycles + 1);
        assert_eq!(summary_count, cycles);
        assert!(arrivals.recv().await.is_none());
        memory_checkpoint("cycles_settled");
        let (user_bytes, output_bytes) = original_history(&load, session, cycles, prompt_bytes).await;
        memory_checkpoint("verified");
        let times = |purpose: &str| rows.iter().filter(|row| row["purpose"] == purpose).map(|row| row["completion_ms"].as_f64().unwrap()).collect::<Vec<_>>();
        let main_times = times("main");
        let compact_times = times("summary");
        let main_operation_wall_ms: f64 = main_times.iter().sum();
        let compact_operation_wall_ms: f64 = compact_times.iter().sum();
        let operation_wall_ms: f64 = rows.iter().map(|row| row["completion_ms"].as_f64().unwrap()).sum();
        let operation_cpu_seconds: f64 = rows.iter().map(|row| row["cpu_seconds"].as_f64().unwrap()).sum();
        json!({"scenario":"same_session_manual_compaction","cycles_requested":cycles,"cycles_completed":summary_count,
            "main_requests":main_count,"main_completions":main_count,"summary_requests":summary_count,"summary_completions":summary_count,
            "http_requests":main_count+summary_count,"manual_compact_invocations":summary_count,"checkpoints":summary_count,"tool_dispatches":0,
            "original_user_messages":main_count,"original_assistant_messages":main_count,"verified_original_user_bytes":user_bytes,
            "verified_original_output_bytes":output_bytes,"summary_bytes":summary_bytes,"prompt_bytes_per_cycle":prompt_bytes,
            "main_completion_ms":distribution(main_times),"compact_completion_ms":distribution(compact_times),
            "main_operation_wall_ms":main_operation_wall_ms,"compact_operation_wall_ms":compact_operation_wall_ms,
            "operation_wall_ms":operation_wall_ms,"operation_cpu_seconds":operation_cpu_seconds,
            "final_probe":rows.last().unwrap(),"phases":rows,"errors":0,
            "controlled_http_model":true,"provider_usage_per_request":{"input_tokens":1,"output_tokens":2},
            "memory_profile_paused":std::env::var_os("MAKA_SCALE_MEMORY_PROFILE").is_some()})
    }).catch_unwind()).await;
    if !matches!(&checked, Ok(Ok(_))) {
        server.abort();
    }
    let served = server.await;
    let app_cleanup = fixture.app.shutdown().await;
    let config_cleanup = fixture.config.shutdown().await;
    assert!(fixture.owner.runs.lock().await.controls.is_empty());
    app_cleanup.unwrap();
    config_cleanup.unwrap();
    memory_checkpoint("shutdown");
    drop(load);
    drop(fixture);
    memory_checkpoint("dropped");
    let mut result = match checked {
        Ok(Ok(result)) => result,
        Ok(Err(panic)) => std::panic::resume_unwind(panic),
        Err(error) => panic!("same-session compaction did not settle: {error}"),
    };
    assert_eq!(served.unwrap(), request_count);
    result["whole_scenario_wall_ms"] = json!(all_started.elapsed().as_secs_f64() * 1000.0);
    result["setup_validation_shutdown_wall_ms"] = json!(
        result["whole_scenario_wall_ms"].as_f64().unwrap()
            - result["operation_wall_ms"].as_f64().unwrap()
    );
    result["whole_process_peak_rss_bytes"] = json!(usage().1);
    result
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn same_session_compaction_cycles_keep_original_history() {
    let result = run(2, 256, Duration::from_secs(60)).await;
    assert_eq!(result["cycles_completed"], 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "explicit real-Host repeated compaction benchmark"]
async fn real_host_same_session_compaction() {
    let size = |name: &str, default| {
        std::env::var(name).map_or(default, |value| value.parse::<usize>().unwrap())
    };
    let result = run(
        size("MAKA_COMPACTION_CYCLES", 10),
        size("MAKA_COMPACTION_PROMPT_BYTES", 64 * 1024),
        Duration::from_secs(600),
    )
    .await;
    println!("MAKA_AGENT_COMPACTION {result}");
}
