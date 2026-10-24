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

//! One real service turn per process; sequential effects and query fanout are distinct workloads.
use super::*;
use futures_util::FutureExt;
use maka_agent_facts::{
    context::ModelPurpose,
    event::InvocationOutcome,
    model::{ModelFinishReason, ModelPart, TextKind},
    tool_output::ToolOutput,
};
use maka_plugin_core::operation::{OperationCleanup, OperationOutcome, Receipt};
use std::{panic::AssertUnwindSafe, time::Instant};

const FINAL: &str = "K40_ALL_SERVICE_RESULTS_CONFIRMED";

#[derive(Clone, Copy)]
struct Case {
    calls: usize,
    bytes: usize,
    javascript: bool,
    query: bool,
    model_usage: bool,
}

impl Case {
    fn environment(query: bool) -> Self {
        let number =
            |name, fallback| std::env::var(name).map_or(fallback, |v| v.parse::<usize>().unwrap());
        let backend = std::env::var("MAKA_TOOL_STORM_BACKEND").unwrap_or("native".into());
        assert!(matches!(backend.as_str(), "native" | "javascript"));
        let case = Self {
            calls: number("MAKA_TOOL_STORM_CALLS", 8),
            bytes: number("MAKA_TOOL_STORM_PAYLOAD_BYTES", 128),
            javascript: backend == "javascript",
            query,
            model_usage: false,
        };
        assert!(case.calls > 0);
        case
    }
    fn business(self, index: usize) -> Value {
        json!({"effects":if self.query {0} else {index+1},"payload":payload(index, self.bytes)})
    }
}

fn payload(index: usize, bytes: usize) -> String {
    (0..bytes)
        .map(|offset| char::from(b'a' + ((index + offset) % 26) as u8))
        .collect()
}
fn call_id(index: usize) -> String {
    format!("storm-{index:04}")
}

fn usage() -> (f64, u64) {
    let mut value = std::mem::MaybeUninit::<libc::rusage>::uninit();
    assert_eq!(
        unsafe { libc::getrusage(libc::RUSAGE_SELF, value.as_mut_ptr()) },
        0
    );
    let value = unsafe { value.assume_init() };
    let seconds = |v: libc::timeval| v.tv_sec as f64 + v.tv_usec as f64 / 1_000_000.0;
    let peak = value.ru_maxrss as u64;
    #[cfg(not(target_os = "macos"))]
    let peak = peak * 1024;
    (seconds(value.ru_utime) + seconds(value.ru_stime), peak)
}

async fn reply(
    socket: &mut TcpStream,
    case: Case,
    indices: std::ops::Range<usize>,
    text: Option<&str>,
    progress: &Arc<StdMutex<Value>>,
) -> usize {
    let mut body = String::new();
    for (slot, index) in indices.enumerate() {
        let delta = json!({"id":"storm-model","choices":[{"index":0,"delta":{"tool_calls":[{
            "index":slot,"id":call_id(index),"type":"function","function":{"name":"Counter",
            "arguments":json!({"amount":1,"note":payload(index,case.bytes)}).to_string()}
        }]},"finish_reason":null}]});
        // One event per call, including large query fanout; never one giant arguments event.
        body.push_str(&format!("data: {delta}\n\n"));
    }
    if let Some(text) = text {
        body.push_str(&format!("data: {}\n\n", json!({"id":"storm-model","choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]})));
    }
    let mut end = json!({"id":"storm-model","choices":[{"index":0,"delta":{},"finish_reason":if text.is_some() {"stop"} else {"tool_calls"}}]});
    if case.model_usage {
        end["usage"] = json!({"prompt_tokens":7,"completion_tokens":11,"total_tokens":18});
    }
    body.push_str(&format!("data: {end}\n\ndata: [DONE]\n\n"));
    let wire = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let mut written = 0;
    while written < wire.len() {
        let count = socket.write(&wire.as_bytes()[written..]).await.unwrap();
        assert_ne!(count, 0, "EOF while writing controlled SSE");
        written += count;
        let mut progress = progress.lock().unwrap();
        progress["response_wire_bytes"] =
            json!(progress["response_wire_bytes"].as_u64().unwrap() + count as u64);
    }
    wire.len()
}

#[derive(serde::Serialize)]
struct SummaryProof {
    step_id: String,
    source_through: u64,
    previous_checkpoint_id: Option<String>,
    text: String,
    confirmed: usize,
    checkpoint_id: Option<String>,
    completion_seen: bool,
    adopted: bool,
}

struct RequestProof {
    step_id: String,
    purpose: ModelPurpose,
    source_through: u64,
    checkpoint_id: Option<String>,
}

fn model_text(output: &maka_agent_facts::model::ModelStep) -> String {
    output
        .parts
        .iter()
        .filter_map(|part| match part {
            ModelPart::Text {
                text,
                text_kind: TextKind::Text,
                ..
            } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

fn summary_output(output: &maka_agent_facts::model::ModelStep, expected: &str) {
    assert_eq!(model_text(output), expected);
    assert_eq!(output.finish_reason, ModelFinishReason::Stop);
    assert!(output.parts.iter().all(|part| matches!(
        part,
        ModelPart::Text {
            text_kind: TextKind::Text,
            ..
        }
    )));
    assert_eq!(output.usage.input_tokens, None);
    assert_eq!(output.usage.output_tokens, None);
}

async fn serve(
    listener: TcpListener,
    store: maka_event_log::root_store::SessionStore,
    session: String,
    case: Case,
    progress: Arc<StdMutex<Value>>,
) -> Value {
    let mut after = 0;
    let mut mains = 0;
    let mut issued = 0;
    let mut request_bytes = 0;
    let mut response_bytes = 0;
    let mut archives = BTreeMap::new();
    let mut budgets = Vec::new();
    let mut latencies = Vec::new();
    let mut emitted_at = None;
    let mut confirmed = BTreeSet::new();
    let mut summaries: Vec<SummaryProof> = Vec::new();
    let mut opening = None;
    loop {
        let (mut socket, _) = listener.accept().await.unwrap();
        let body = request(&mut socket).await; // Original auth/EOF/content-length checks.
        assert_eq!(body["model"], "fixture-model");
        request_bytes += serde_json::to_vec(&body).unwrap().len();
        {
            let mut progress = progress.lock().unwrap();
            progress["http_requests"] = json!(progress["http_requests"].as_u64().unwrap() + 1);
            progress["normalized_request_json_bytes"] = json!(request_bytes);
        }
        let through = *store.subscribe_commits().unwrap().borrow();
        let mut requested = None;
        loop {
            let page = store
                .session_events(&session, after, through, 512, usize::MAX)
                .await
                .unwrap();
            for stored in page.events {
                match stored.event.fact {
                    Fact::InvocationOpened { .. } => {
                        assert!(opening.replace(stored.event.id).is_none());
                    }
                    Fact::ModelRequested {
                        purpose,
                        step_id,
                        source_high_water,
                        checkpoint_event_id,
                        context,
                        context_breakdown,
                        ..
                    } => {
                        assert!(
                            requested
                                .replace(RequestProof {
                                    step_id: step_id.clone(),
                                    purpose,
                                    source_through: source_high_water,
                                    checkpoint_id: checkpoint_event_id.clone(),
                                })
                                .is_none(),
                            "serial HTTP must have one fresh canonical request"
                        );
                        budgets.push(json!({"purpose":purpose,"step_id":step_id,"source_through":source_high_water,
                            "checkpoint_event_id":checkpoint_event_id,"context":context,"context_breakdown":context_breakdown,
                            "http_max_tokens":body.get("max_tokens"),"http_max_completion_tokens":body.get("max_completion_tokens")}));
                    }
                    Fact::ModelCompleted { step_id, output } => {
                        if let Some(summary) = summaries
                            .iter_mut()
                            .find(|summary| summary.step_id == step_id)
                        {
                            assert!(!summary.completion_seen);
                            summary_output(&output, &summary.text);
                            summary.completion_seen = true;
                        }
                    }
                    Fact::ContextCheckpointRecorded { checkpoint } => {
                        let summary = summaries
                            .last_mut()
                            .expect("checkpoint follows a served Summary");
                        assert!(summary.completion_seen);
                        assert!(summary.checkpoint_id.is_none());
                        assert_eq!(checkpoint.summary_step_id, summary.step_id);
                        assert_eq!(checkpoint.summary.text, summary.text);
                        assert_eq!(checkpoint.covered_through, summary.source_through);
                        assert!(checkpoint.covered_through < stored.sequence);
                        assert_eq!(
                            checkpoint.previous_checkpoint_id,
                            summary.previous_checkpoint_id
                        );
                        assert_eq!(
                            checkpoint.mode,
                            maka_agent_facts::context::CheckpointMode::MidTurn {
                                anchor_event_id: opening.as_ref().unwrap().clone(),
                            }
                        );
                        summary.checkpoint_id = Some(stored.event.id);
                    }
                    Fact::ToolResultArchived { placeholder } => {
                        let DurableToolProjection::Json { mut value } =
                            placeholder.to_canonical_projection().unwrap()
                        else {
                            panic!("archive projection")
                        };
                        value["readInstructions"] = "Use page.next only with a selected Session tool-result reader; without one, the remainder is unavailable.".into();
                        archives
                            .insert(placeholder.identity.tool_call_id, (stored.sequence, value));
                    }
                    _ => {}
                }
            }
            if let Some(next) = page.next_after {
                assert!(next > after);
                after = next;
            } else {
                after = through;
                break;
            }
        }
        let requested = requested.expect("HTTP request has original canonical role");
        {
            let mut progress = progress.lock().unwrap();
            progress["last_canonical_purpose"] = json!(requested.purpose);
            progress["last_step_id"] = json!(requested.step_id);
            progress["source_through"] = json!(requested.source_through);
        }
        let messages = body["messages"].as_array().unwrap();
        assert!(has_tool(&body, "Counter"));
        let before_confirmed = confirmed.len();
        for message in messages {
            if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    let index = (0..issued)
                        .find(|index| call["id"] == call_id(*index))
                        .expect("only already issued tool calls can reach the provider");
                    assert_eq!(call["function"]["name"], "Counter");
                    let input: Value =
                        serde_json::from_str(call["function"]["arguments"].as_str().unwrap())
                            .unwrap();
                    assert_eq!(input, json!({"amount":1,"note":payload(index,case.bytes)}));
                }
            }
            if message["role"] != "tool" {
                continue;
            }
            let index = (0..issued)
                .find(|index| message["tool_call_id"] == call_id(*index))
                .expect("only already issued results can reach the provider");
            let actual: Value = serde_json::from_str(message["content"].as_str().unwrap()).unwrap();
            let expected = archives
                .get(&call_id(index))
                .filter(|(sequence, _)| *sequence <= requested.source_through)
                .map(|(_, value)| value.clone())
                .unwrap_or_else(|| case.business(index));
            assert_eq!(
                actual,
                expected,
                "actual model projection for {}",
                call_id(index)
            );
            assert!(actual.get("receipt").is_none() && actual.get("stateDomain").is_none());
            confirmed.insert(index); // Previously confirmed results may remain in the next prompt.
        }
        assert_eq!(
            confirmed.len(),
            issued,
            "every issued result reached Main or Summary"
        );
        if confirmed.len() > before_confirmed {
            let at = emitted_at.take().expect("one outstanding issued batch");
            latencies.push(Instant::now().duration_since(at).as_secs_f64() * 1000.0);
        }
        {
            let mut progress = progress.lock().unwrap();
            progress["confirmed_results"] = json!(confirmed.len());
            progress["issued_calls"] = json!(issued);
        }
        if let Some(summary) = summaries.last() {
            assert!(summary.completion_seen);
            assert!(summary.checkpoint_id.is_some());
            assert_eq!(requested.checkpoint_id, summary.checkpoint_id);
            assert!(messages.iter().any(|message| {
                message["role"] == "user"
                    && message["content"]
                        .as_str()
                        .is_some_and(|text| text.ends_with(&format!("\n\n{}", summary.text)))
            }));
            // Both Main and later Summary inherit covered work only through the checkpoint.
            for message in messages {
                if message["role"] == "tool" {
                    assert!(
                        !(0..summary.confirmed)
                            .any(|index| message["tool_call_id"] == call_id(index))
                    );
                }
                if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
                    assert!(calls.iter().all(|call| {
                        !(0..summary.confirmed).any(|index| call["id"] == call_id(index))
                    }));
                }
            }
        } else {
            assert!(requested.checkpoint_id.is_none());
        }
        if requested.purpose == ModelPurpose::Summary {
            assert!(
                confirmed.len() > before_confirmed,
                "Summary must verify newly issued work"
            );
            if let Some(previous) = summaries.last() {
                assert!(previous.adopted);
                assert!(confirmed.len() > previous.confirmed);
                assert!(requested.source_through > previous.source_through);
            }
            let text = format!(
                "K43_SUMMARY_{}: {issued} original service results confirmed.",
                summaries.len() + 1
            );
            // Summary is real text-only SSE, with no invented provider usage.
            response_bytes += reply(
                &mut socket,
                Case {
                    model_usage: false,
                    ..case
                },
                0..0,
                Some(&text),
                &progress,
            )
            .await;
            summaries.push(SummaryProof {
                step_id: requested.step_id,
                source_through: requested.source_through,
                previous_checkpoint_id: requested.checkpoint_id,
                text,
                confirmed: confirmed.len(),
                checkpoint_id: None,
                completion_seen: false,
                adopted: false,
            });
            progress.lock().unwrap()["summary_requests"] = json!(summaries.len());
            continue;
        }
        assert_eq!(requested.purpose, ModelPurpose::Main);
        if let Some(summary) = summaries.last_mut() {
            summary.adopted = true;
            progress.lock().unwrap()["adopted_checkpoints"] =
                json!(summaries.iter().filter(|summary| summary.adopted).count());
        }
        mains += 1;
        let finished = issued == case.calls;
        let indices = if finished {
            0..0
        } else if case.query {
            assert_eq!(issued, 0, "query emits its original batch only once");
            0..case.calls
        } else {
            issued..issued + 1
        };
        issued = indices.end.max(issued);
        {
            let mut progress = progress.lock().unwrap();
            progress["issued_calls"] = json!(issued);
            progress["main_requests"] = json!(mains);
        }
        if !finished {
            emitted_at = Some(Instant::now());
        }
        response_bytes += reply(
            &mut socket,
            case,
            indices,
            finished.then_some(FINAL),
            &progress,
        )
        .await;
        if finished {
            assert!(
                summaries
                    .iter()
                    .all(|summary| summary.completion_seen && summary.adopted)
            );
            return json!({"status":"completed","main_requests":mains,"summary_requests":summaries.len(),
                "http_requests":mains+summaries.len(),"normalized_request_json_bytes":request_bytes,"response_wire_bytes":response_bytes,
                "confirmed_results":confirmed.len(),"step_confirmation_ms":latencies,"requests":budgets,
                "archived_projections":archives.len(),"summaries":summaries,
                "adopted_checkpoints":summaries.len()});
        }
    }
}

async fn business_read(fixture: &Fixture, binding: Binding) -> Result<Value, String> {
    fixture
        .app
        .client()
        .start(
            binding,
            "read".into(),
            json!({"amount":1,"note":""}),
            scope(&fixture.issuer, true),
            Attachments::new().into(),
        )
        .await?
        .result()
        .await
}

async fn verify(
    fixture: &Fixture,
    session: &str,
    invocation: &str,
    case: Case,
    served: &Value,
) -> Value {
    let through = fixture.through(&session).await;
    let mut after = 0;
    let mut dispatched = BTreeMap::new();
    let mut settled = BTreeSet::new();
    let mut raw_bytes = 0;
    let mut projected_bytes = 0;
    let mut final_completions = 0;
    let mut completed = 0;
    let mut maintenance = 0;
    let mut purposes = BTreeMap::new();
    let mut summary_completions = 0;
    let mut main_completions = 0;
    let mut checkpoints = 0;
    loop {
        let page = fixture
            .session(session)
            .await
            .session_events(session, after, through, 512, usize::MAX)
            .await
            .unwrap();
        for stored in page.events {
            assert_eq!(stored.event.invocation.invocation_id, invocation);
            match &stored.event.fact {
                Fact::ToolDispatched {
                    operation_id,
                    call,
                    name,
                    input,
                    ..
                } => {
                    assert_eq!(name, "Counter");
                    let index = (0..case.calls)
                        .find(|index| call.tool_call_id == call_id(*index))
                        .expect("unique real call id");
                    assert_eq!(input, &json!({"amount":1,"note":payload(index,case.bytes)}));
                    assert!(dispatched.insert(operation_id.clone(), index).is_none());
                }
                Fact::ToolSettled {
                    operation_id,
                    outcome,
                } => {
                    let index = dispatched[operation_id];
                    assert!(settled.insert(index));
                    let ToolOutcome::Succeeded { .. } = outcome else {
                        panic!("unexpected tool settlement: {outcome:?}")
                    };
                    assert_eq!(
                        outcome_projection(outcome).as_ref(),
                        &DurableToolProjection::Json {
                            value: case.business(index)
                        }
                    );
                    projected_bytes += serde_json::to_vec(&case.business(index)).unwrap().len();
                    let raw = fixture
                        .session(session)
                        .await
                        .resolve_tool_result(session, &stored.event.id)
                        .await
                        .unwrap();
                    raw_bytes += serde_json::to_vec(&raw).unwrap().len();
                    match raw {
                        ToolOutput::Operation(reply) if !case.query => {
                            assert_eq!(reply.reference.method, "write");
                            assert_eq!(reply.reference.export, "Counter");
                            assert_eq!(reply.reference.namespace, id(21));
                            let Receipt::Recorded {
                                outcome: OperationOutcome::Returned { value },
                                cleanup: OperationCleanup::Confirmed,
                            } = reply.receipt
                            else {
                                panic!("original returned receipt and cleanup")
                            };
                            assert_eq!(value, case.business(index));
                        }
                        ToolOutput::Json(value) if case.query => {
                            assert_eq!(value, case.business(index))
                        }
                        other => panic!("wrong original service result: {other:?}"),
                    }
                }
                Fact::ModelRequested {
                    purpose, step_id, ..
                } => {
                    assert!(purposes.insert(step_id.clone(), *purpose).is_none());
                }
                Fact::ModelCompleted { step_id, output } => match purposes[step_id] {
                    ModelPurpose::Main => {
                        main_completions += 1;
                        if case.model_usage {
                            assert_eq!(output.usage.input_tokens, Some(7));
                            assert_eq!(output.usage.output_tokens, Some(11));
                        }
                        let text = model_text(output);
                        if !text.is_empty() {
                            assert_eq!(text, FINAL);
                            assert_eq!(output.finish_reason, ModelFinishReason::Stop);
                            final_completions += 1;
                        }
                    }
                    ModelPurpose::Summary => {
                        let proof = served["summaries"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .find(|proof| proof["step_id"] == *step_id)
                            .unwrap();
                        summary_output(output, proof["text"].as_str().unwrap());
                        summary_completions += 1;
                    }
                },
                Fact::ToolResultArchived { .. } => maintenance += 1,
                Fact::ContextCheckpointRecorded { checkpoint } => {
                    let proof = served["summaries"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|proof| proof["step_id"] == checkpoint.summary_step_id)
                        .unwrap();
                    assert_eq!(proof["checkpoint_id"], stored.event.id);
                    assert_eq!(proof["source_through"], checkpoint.covered_through);
                    assert_eq!(proof["text"], checkpoint.summary.text);
                    assert_eq!(proof["adopted"], true);
                    checkpoints += 1;
                    maintenance += 1;
                }
                Fact::InvocationEnded { outcome } => {
                    assert!(matches!(outcome, InvocationOutcome::Completed));
                    completed += 1;
                }
                _ => {}
            }
        }
        if let Some(next) = page.next_after {
            assert!(next > after);
            after = next;
        } else {
            break;
        }
    }
    assert_eq!(dispatched.len(), case.calls);
    assert_eq!(settled.len(), case.calls);
    assert_eq!(completed, 1);
    assert_eq!(final_completions, 1);
    let main_requests = purposes
        .values()
        .filter(|purpose| **purpose == ModelPurpose::Main)
        .count();
    let summary_requests = purposes.len() - main_requests;
    assert_eq!(main_requests, if case.query { 2 } else { case.calls + 1 });
    assert_eq!(main_completions, main_requests);
    assert_eq!(summary_completions, summary_requests);
    assert_eq!(checkpoints, summary_requests);
    assert_eq!(
        summary_requests,
        served["summary_requests"].as_u64().unwrap() as usize
    );
    assert_eq!(
        summary_requests,
        served["adopted_checkpoints"].as_u64().unwrap() as usize
    );
    // Exact original assistant text through the public, fixed-fence paged history path.
    let mut input = json!({"sessionId":session,"through":through,"position":{"kind":"start"}});
    let mut final_text = String::new();
    let expected_tools: BTreeMap<_, _> = dispatched
        .iter()
        .map(|(operation, index)| {
            (
                maka_agent_facts::tool_call::tool_use_id(invocation, operation),
                *index,
            )
        })
        .collect();
    let mut result_offsets = BTreeMap::new();
    let mut history_calls = BTreeSet::new();
    loop {
        let page = fixture.query("history", input.clone()).await.unwrap();
        assert_eq!(page["through"], through);
        assert_eq!(page["kind"], "ready");
        for chunk in page["chunks"].as_array().unwrap() {
            if chunk["role"] == "tool_call" && chunk["field"] == "body" {
                let tool = &chunk["tool"];
                let id = tool["toolUseId"].as_str().unwrap();
                assert!(expected_tools.contains_key(id));
                assert!(history_calls.insert(id.to_owned()));
                assert_eq!(tool["call"]["position"], chunk["position"]);
                assert_eq!(tool["call"]["name"], "Counter");
                assert_eq!(tool["call"]["pending"], false);
                assert_eq!(tool["call"]["dispatched"], true);
                assert!(!tool["result"].is_null());
            }
            if chunk["role"] == "tool_result" && chunk["field"] == "body" {
                let tool = chunk["tool"]["toolUseId"].as_str().unwrap();
                let index = expected_tools[tool];
                let expected = payload(index, case.bytes);
                let offset = result_offsets.entry(tool.to_owned()).or_insert(0usize);
                let text = chunk["text"].as_str().unwrap();
                assert_eq!(chunk["offset"], *offset);
                assert_eq!(chunk["totalBytes"], expected.len());
                assert_eq!(text, &expected[*offset..*offset + text.len()]);
                *offset += text.len();
            }
            if chunk["role"] == "assistant" && chunk["field"] == "body" {
                assert_eq!(chunk["offset"], final_text.len());
                assert_eq!(chunk["totalBytes"], FINAL.len());
                final_text.push_str(chunk["text"].as_str().unwrap());
            }
        }
        if page["after"].is_null() {
            break;
        }
        input["position"] = json!({"kind":"after","cursor":page["after"]});
    }
    assert_eq!(final_text, FINAL);
    assert_eq!(history_calls.len(), case.calls);
    assert_eq!(result_offsets.len(), case.calls);
    assert!(result_offsets.values().all(|bytes| *bytes == case.bytes));
    let execution = fixture
        .query(
            "execution",
            json!({"sessionId":session,"invocationId":invocation}),
        )
        .await
        .unwrap();
    assert_eq!(execution["execution"]["state"], "completed");
    let observed: contract::Observation = serde_json::from_value(
        fixture
            .query("observe", json!({"sessionId":session}))
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(matches!(
        observed.session.activity,
        contract::SessionActivity::Idle
    ));
    assert!(!observed.compacting);
    json!({"tool_dispatches":dispatched.len(),"tool_settlements":settled.len(),"raw_result_json_bytes":raw_bytes,
        "business_result_json_bytes":projected_bytes,"original_payload_bytes":case.calls*case.bytes,
        "maintenance_facts":maintenance,"model_requests":purposes.len(),"main_requests":main_requests,
        "summary_requests":summary_requests,"checkpoints":checkpoints,"completed_invocations":completed,
        "final_assistant_bytes":final_text.len(),"through":through})
}

async fn run(case: Case) -> Value {
    let whole = Instant::now();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let counter = Counter::new(Behavior::Echo);
    let mut setup = if case.javascript {
        Setup::javascript()
    } else {
        Setup::native(counter.clone(), true)
    };
    setup.echo = true;
    setup.query = case.query;
    let fixture = Fixture::with_services(
        &format!("http://{}/v1", listener.local_addr().unwrap()),
        None,
        None,
        Some(setup),
    )
    .await;
    let prepared = AssertUnwindSafe(async {
        let session = fixture.create("K40 actual service tool storm").await;
        let client = fixture.app.client();
        let binding = client
            .bind(client.activation(&id(1)).unwrap(), "service".into())
            .await
            .unwrap()
            .remove(0);
        let before = business_read(&fixture, binding.clone()).await.unwrap();
        assert_eq!(before, json!({"effects":0,"payload":""}));
        (session, binding, before)
    })
    .catch_unwind()
    .await;
    let (session, binding, business_before) = match prepared {
        Ok(prepared) => prepared,
        Err(panic) => {
            let app = fixture.app.shutdown().await;
            let config = fixture.config.shutdown().await;
            println!(
                "MAKA_AGENT_TOOL_STORM {}",
                json!({"status":"setup_failed","calls_requested":case.calls,
                "payload_bytes":case.bytes,"backend":if case.javascript {"javascript"} else {"native"},
                "cleanup":{"app":app.err(),"config":config.as_ref().err().map(ToString::to_string)}})
            );
            std::panic::resume_unwind(panic);
        }
    };
    let entered_before = counter.entered.available_permits();
    let store = fixture.session(&session).await;
    let server_session = session.clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    let progress = Arc::new(StdMutex::new(
        json!({"http_requests":0,"normalized_request_json_bytes":0,
        "response_wire_bytes":0,"confirmed_results":0}),
    ));
    let server_progress = progress.clone();
    let server = tokio::spawn(async move {
        let result = AssertUnwindSafe(serve(
            listener,
            store,
            server_session,
            case,
            server_progress,
        ))
        .catch_unwind()
        .await;
        let _ = send.send(result);
    });
    let cpu = usage().0;
    let start = Instant::now();
    let mut invocation = None;
    let checked = tokio::time::timeout(
        Duration::from_secs(600),
        AssertUnwindSafe(async {
            let sent = fixture.send(&session).await.unwrap();
            assert_eq!(sent["kind"], "started");
            invocation = Some(sent["invocationId"].as_str().unwrap().to_owned());
            let admission = start.elapsed().as_secs_f64() * 1000.0;
            // This isolated fixture has no competing closer; avoid the shared busy drainer.
            assert!(fixture.owner.workers.close());
            let mut metrics = receive
                .await
                .unwrap()
                .unwrap_or_else(|panic| std::panic::resume_unwind(panic));
            fixture.owner.workers.wait().await;
            assert!(fixture.owner.workers.reopen());
            metrics["admission_ms"] = json!(admission);
            metrics["turn_wall_ms"] = json!(start.elapsed().as_secs_f64() * 1000.0);
            metrics["turn_cpu_seconds"] = json!(usage().0 - cpu);
            metrics["turn_peak_rss_bytes"] = json!(usage().1);
            if !case.javascript {
                assert_eq!(
                    counter.entered.available_permits() - entered_before,
                    case.calls
                );
                assert_eq!(
                    counter.effects.load(Ordering::SeqCst),
                    if case.query { 0 } else { case.calls }
                );
                metrics["native_tool_handler_entries"] = json!(case.calls);
            }
            let canonical = verify(
                &fixture,
                &session,
                invocation.as_deref().unwrap(),
                case,
                &metrics,
            )
            .await;
            metrics["canonical"] = canonical;
            metrics
        })
        .catch_unwind(),
    )
    .await;
    if !matches!(&checked, Ok(Ok(_))) {
        if let Some(invocation) = &invocation {
            let _ = fixture
                .mutation(
                    2,
                    "stop",
                    json!({"sessionId":session,"invocationId":invocation}),
                    Uuid::new_v4(),
                )
                .await;
        }
        server.abort();
    }
    let served = server.await;
    let business_after = business_read(&fixture, binding).await;
    let app = fixture.app.shutdown().await;
    let config = fixture.config.shutdown().await;
    // Retain actual partial counts on timeout, panic, or maintenance boundary.
    let through = fixture.through(&session).await;
    let mut counts =
        json!({"dispatches":0,"settlements":0,"summary_requests":0,"checkpoints":0,"archives":0});
    let mut after = 0;
    loop {
        let page = match fixture
            .session(&session)
            .await
            .session_events(&session, after, through, 512, usize::MAX)
            .await
        {
            Ok(page) => page,
            Err(error) => {
                counts["read_error"] = json!(error.to_string());
                break;
            }
        };
        for event in page.events {
            let failure = match &event.event.fact {
                Fact::ToolSettled { outcome, .. } => {
                    !matches!(outcome, ToolOutcome::Succeeded { .. })
                }
                Fact::InvocationEnded { outcome } => {
                    matches!(outcome, InvocationOutcome::Failed { .. })
                }
                Fact::ModelInterrupted { .. } => true,
                _ => false,
            };
            if failure && counts["first_failure"].is_null() {
                counts["first_failure"] = serde_json::to_value(&event.event.fact).unwrap();
            }
            let key = match event.event.fact {
                Fact::ToolDispatched { .. } => Some("dispatches"),
                Fact::ToolSettled { .. } => Some("settlements"),
                Fact::ModelRequested {
                    purpose: ModelPurpose::Summary,
                    ..
                } => Some("summary_requests"),
                Fact::ContextCheckpointRecorded { .. } => Some("checkpoints"),
                Fact::ToolResultArchived { .. } => Some("archives"),
                _ => None,
            };
            if let Some(key) = key {
                counts[key] = json!(counts[key].as_u64().unwrap() + 1);
            }
        }
        if let Some(next) = page.next_after {
            after = next;
        } else {
            counts["complete"] = json!(true);
            break;
        }
    }
    let controls_empty = fixture.owner.runs.lock().await.controls.is_empty();
    let mut result = match &checked {
        Ok(Ok(value)) => value.clone(),
        Ok(Err(panic)) => {
            json!({"status":"failed_assertion","error":panic.downcast_ref::<String>().map(String::as_str).or_else(||panic.downcast_ref::<&str>().copied())})
        }
        Err(error) => json!({"status":"fixture_timeout","error":error.to_string()}),
    };
    result["scenario"] = json!(if case.query {
        "query_parallel_fanout"
    } else {
        "mutation_sequential"
    });
    result["backend"] = json!(if case.javascript {
        "javascript"
    } else {
        "native"
    });
    result["calls_requested"] = json!(case.calls);
    result["payload_bytes"] = json!(case.bytes);
    result["actual_partial_counts"] = counts;
    result["http_progress"] = progress.lock().unwrap().clone();
    result["partial_counts_snapshot"] = json!("after_stop_and_application_shutdown");
    result["business_after_snapshot"] = json!("after_stop_before_application_shutdown");
    result["business_before"] = business_before;
    result["business_after"] = json!(business_after.as_ref().ok());
    result["business_after_error"] = json!(business_after.as_ref().err());
    result["native_effects"] = if case.javascript {
        Value::Null
    } else {
        json!(counter.effects.load(Ordering::SeqCst))
    };
    result["first_effect_observed_ms"] = if case.javascript || case.query {
        Value::Null
    } else {
        json!(
            counter
                .first_effect
                .get()
                .map(|at| at.duration_since(start).as_secs_f64() * 1000.0)
        )
    };
    if let Some(ms) = result["turn_wall_ms"].as_f64() {
        result["settlements_per_second"] = json!(
            result["actual_partial_counts"]["settlements"]
                .as_u64()
                .unwrap() as f64
                / (ms / 1000.0)
        );
    }
    result["cleanup"] = json!({"app":app.as_ref().err(),"config":config.as_ref().err().map(ToString::to_string),"controls_empty":controls_empty,
        "server_joined":true,"server_result_ok":served.is_ok()});
    result["whole_scenario_wall_ms"] = json!(whole.elapsed().as_secs_f64() * 1000.0);
    result["whole_process_peak_rss_bytes"] = json!(usage().1);
    result["driver_included"] = json!(true);
    result["query_fanout_does_not_assert_handler_overlap"] = json!(case.query);
    println!("MAKA_AGENT_TOOL_STORM {result}");
    app.unwrap();
    config.unwrap();
    assert!(controls_empty);
    if result["status"] == "completed" {
        assert_eq!(
            business_after.unwrap(),
            json!({"effects":if case.query {0} else {case.calls},"payload":""})
        );
    }
    match checked {
        Ok(Ok(_)) => {}
        Ok(Err(panic)) => std::panic::resume_unwind(panic),
        Err(error) => panic!("tool storm did not settle: {error}"),
    }
    assert!(served.is_ok());
    result
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "explicit real service sequential mutation workload, one case per process"]
async fn real_service_tool_storm() {
    assert_eq!(run(Case::environment(false)).await["status"], "completed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "explicit real service query fanout workload, one case per process"]
async fn real_service_query_fanout() {
    assert_eq!(run(Case::environment(true)).await["status"], "completed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn public_history_preserves_129_real_service_query_results() {
    let case = Case {
        calls: 129,
        bytes: 128,
        javascript: false,
        query: true,
        model_usage: false,
    };
    let result = run(case).await;
    assert_eq!(result["status"], "completed");
    assert_eq!(result["summary_requests"], 0);
    assert_eq!(result["canonical"]["checkpoints"], 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn public_history_preserves_256_real_service_query_results_with_usage() {
    let case = Case {
        calls: 256,
        bytes: 128,
        javascript: false,
        query: true,
        model_usage: true,
    };
    let result = run(case).await;
    assert_eq!(result["status"], "completed");
    assert_eq!(result["summary_requests"], 0);
    assert_eq!(result["canonical"]["checkpoints"], 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn query_storm_automatic_summary_preserves_original_history() {
    let result = run(Case {
        calls: 8,
        bytes: 65536,
        javascript: false,
        query: true,
        model_usage: false,
    })
    .await;
    assert_eq!(result["status"], "completed");
    assert!(result["summary_requests"].as_u64().unwrap() >= 1);
    assert_eq!(result["confirmed_results"], 8);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn mutation_storm_repeated_summaries_preserve_original_effects() {
    let result = run(Case {
        calls: 16,
        bytes: 65536,
        javascript: false,
        query: false,
        model_usage: false,
    })
    .await;
    assert_eq!(result["status"], "completed");
    assert!(result["summary_requests"].as_u64().unwrap() >= 2);
    assert_eq!(result["confirmed_results"], 16);
}

#[path = "storm/combined.rs"]
mod combined;
