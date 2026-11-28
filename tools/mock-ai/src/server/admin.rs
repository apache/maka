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

use super::{BoxBody, ServerState, SessionActivity, full_json};
use crate::metrics::compute_attribution;
use crate::pacing::{RuntimeProfile, ScenarioSchedule};
use crate::ratelimit::RateLimitConfig;
use crate::routing::{SessionId, SessionRegistration};
#[cfg(feature = "rules")]
use crate::rules::RuleSpec;
use crate::scenario::{CompletionProof, RunnerObservation};
use http_body_util::{BodyExt, Limited};
use hyper::body::Incoming;
use hyper::{Method, Request, Response, StatusCode};
use serde_json::json;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

pub(super) async fn handle_admin(
    method: Method,
    path: &str,
    req: Request<Incoming>,
    state: Arc<ServerState>,
) -> Response<BoxBody> {
    match (method, path) {
        (Method::GET, "/admin/health") => full_json(StatusCode::OK, &json!({ "ok": true })),
        (Method::GET, "/admin/metrics") => {
            let mut snapshot = json!(state.metrics.snapshot());
            snapshot["unknownRoutes"] = json!(state.unknown_routes.load(Ordering::Relaxed));
            full_json(StatusCode::OK, &snapshot)
        }
        (Method::GET, "/admin/requests") => {
            full_json(StatusCode::OK, &json!(state.recorder.snapshot()))
        }
        (Method::POST, "/admin/reset") => {
            if state.reset() {
                full_json(StatusCode::OK, &json!({ "reset": true }))
            } else {
                problem(
                    StatusCode::CONFLICT,
                    "export and delete benchmark sessions before resetting",
                )
            }
        }
        (Method::POST, "/admin/sessions") => register_session(req, &state).await,
        (Method::GET, "/admin/sessions") => match SessionQuery::parse(req.uri().query()) {
            Ok(query) => {
                let page = state
                    .telemetry
                    .list_sessions(query.run, query.cursor, query.limit());
                full_json(StatusCode::OK, &json!(page))
            }
            Err(error) => problem(StatusCode::BAD_REQUEST, error),
        },
        (method, path) if path.starts_with("/admin/sessions/") => {
            session_route(method, &path["/admin/sessions/".len()..], req, &state).await
        }
        #[cfg(feature = "rules")]
        (Method::GET, "/admin/rules") => {
            let rules = state
                .rule_engine
                .as_ref()
                .map(|e| e.rule_specs())
                .unwrap_or_default();
            full_json(StatusCode::OK, &json!(rules))
        }
        #[cfg(feature = "rules")]
        (Method::PUT, "/admin/rules") => {
            let Some(engine) = &state.rule_engine else {
                return full_json(
                    StatusCode::BAD_REQUEST,
                    &json!({ "error": "server is not configured with a RuleEngine" }),
                );
            };
            let bytes = match Limited::new(req.into_body(), 8 * 1024 * 1024)
                .collect()
                .await
            {
                Ok(c) => c.to_bytes(),
                Err(e) => {
                    return full_json(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": format!("body read failed: {e}") }),
                    );
                }
            };
            let specs: Vec<RuleSpec> = match serde_json::from_slice(&bytes) {
                Ok(s) => s,
                Err(e) => {
                    return full_json(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": format!("invalid rules JSON: {e}") }),
                    );
                }
            };
            match engine.replace_rules(specs) {
                Ok(()) => full_json(StatusCode::OK, &json!({ "updated": true })),
                Err(e) => full_json(StatusCode::BAD_REQUEST, &json!({ "error": e.to_string() })),
            }
        }
        (Method::GET, "/admin/profile") => {
            full_json(StatusCode::OK, &json!(state.profile.snapshot()))
        }
        (Method::PUT, "/admin/profile") => {
            let bytes = match Limited::new(req.into_body(), 1024 * 1024).collect().await {
                Ok(c) => c.to_bytes(),
                Err(e) => {
                    return full_json(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": format!("body read failed: {e}") }),
                    );
                }
            };
            let profile: RuntimeProfile = match serde_json::from_slice(&bytes) {
                Ok(p) => p,
                Err(e) => {
                    return full_json(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": format!("invalid profile JSON: {e}") }),
                    );
                }
            };
            state.profile.set_manual_override(Some(profile));
            full_json(StatusCode::OK, &json!(state.profile.snapshot()))
        }
        (Method::DELETE, "/admin/profile") => {
            state.profile.set_manual_override(None);
            full_json(StatusCode::OK, &json!(state.profile.snapshot()))
        }
        (Method::PUT, "/admin/schedule") => {
            let bytes = match Limited::new(req.into_body(), 1024 * 1024).collect().await {
                Ok(c) => c.to_bytes(),
                Err(e) => {
                    return full_json(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": format!("body read failed: {e}") }),
                    );
                }
            };
            let schedule: ScenarioSchedule = match serde_json::from_slice(&bytes) {
                Ok(s) => s,
                Err(e) => {
                    return full_json(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": format!("invalid schedule JSON: {e}") }),
                    );
                }
            };
            state.profile.set_schedule(schedule);
            full_json(StatusCode::OK, &json!(state.profile.snapshot()))
        }
        (Method::GET, "/admin/ratelimit") => {
            full_json(StatusCode::OK, &json!(state.rate_limiter.config()))
        }
        (Method::PUT, "/admin/ratelimit") => {
            let bytes = match Limited::new(req.into_body(), 1024 * 1024).collect().await {
                Ok(c) => c.to_bytes(),
                Err(e) => {
                    return full_json(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": format!("body read failed: {e}") }),
                    );
                }
            };
            let cfg: RateLimitConfig = match serde_json::from_slice(&bytes) {
                Ok(c) => c,
                Err(e) => {
                    return full_json(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": format!("invalid ratelimit JSON: {e}") }),
                    );
                }
            };
            state.rate_limiter.update_config(cfg);
            full_json(StatusCode::OK, &json!(state.rate_limiter.config()))
        }
        (Method::GET, "/admin/violations") => {
            full_json(StatusCode::OK, &json!(state.watchdog.snapshot()))
        }
        (Method::DELETE, "/admin/violations") => {
            state.watchdog.clear_violations();
            full_json(StatusCode::OK, &json!({ "cleared": true }))
        }
        _ => full_json(
            StatusCode::NOT_FOUND,
            &json!({ "error": format!("unknown admin route: {path}") }),
        ),
    }
}

#[derive(serde::Deserialize)]
struct RegisterSession {
    #[serde(flatten)]
    registration: SessionRegistration,
    workspace: Option<std::path::PathBuf>,
}

#[derive(Default)]
struct SessionQuery<'a> {
    run: Option<&'a str>,
    cursor: Option<u64>,
    after: Option<u64>,
    limit: Option<usize>,
}

impl<'a> SessionQuery<'a> {
    fn parse(query: Option<&'a str>) -> Result<Self, &'static str> {
        let mut parsed = Self::default();
        for pair in query.into_iter().flat_map(|q| q.split('&')) {
            let (key, value) = pair
                .split_once('=')
                .ok_or("expected key=value query parameters")?;
            match key {
                "run" => parsed.run = Some(value),
                "cursor" => parsed.cursor = Some(value.parse().map_err(|_| "invalid cursor")?),
                "after" | "through" => {
                    parsed.after = Some(value.parse().map_err(|_| "invalid after cursor")?)
                }
                "limit" => {
                    let limit = value.parse().map_err(|_| "invalid limit")?;
                    if !(1..=1000).contains(&limit) {
                        return Err("limit must be between 1 and 1000");
                    }
                    parsed.limit = Some(limit);
                }
                _ => return Err("unrecognized query parameter"),
            }
        }
        Ok(parsed)
    }

    fn limit(&self) -> usize {
        self.limit.unwrap_or(100)
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FinalizeProof {
    response_id: String,
    observed_markers: std::collections::BTreeSet<String>,
}

async fn read_json<T: serde::de::DeserializeOwned>(req: Request<Incoming>) -> Result<T, String> {
    let bytes = read_admin_body(req).await?;
    serde_json::from_slice(&bytes).map_err(|error| format!("invalid JSON body: {error}"))
}

async fn read_admin_body(req: Request<Incoming>) -> Result<bytes::Bytes, String> {
    Limited::new(req.into_body(), 1024 * 1024)
        .collect()
        .await
        .map(|body| body.to_bytes())
        .map_err(|error| format!("body read failed: {error}"))
}

fn problem(status: StatusCode, message: impl std::fmt::Display) -> Response<BoxBody> {
    full_json(status, &json!({"error": message.to_string()}))
}

async fn register_session(req: Request<Incoming>, state: &ServerState) -> Response<BoxBody> {
    let RegisterSession {
        registration,
        workspace,
    } = match read_json(req).await {
        Ok(data) => data,
        Err(error) => return problem(StatusCode::BAD_REQUEST, error),
    };
    let id = registration.session_id.clone();
    let run = registration.run_id.clone();
    let lane = registration.logical_lane.clone();
    if lane.0.trim().is_empty()
        || registration.harness.trim().is_empty()
        || registration.scenario.trim().is_empty()
    {
        return problem(
            StatusCode::UNPROCESSABLE_ENTITY,
            "harness, logical_lane and scenario are required",
        );
    }
    if let Some(scenario) = &state.scenario {
        if registration.scenario != scenario.spec().scenario {
            return problem(
                StatusCode::UNPROCESSABLE_ENTITY,
                "registration scenario does not match server scenario",
            );
        }
        if workspace
            .as_ref()
            .is_none_or(|path| !path.is_absolute() || path.to_str().is_none())
        {
            return problem(
                StatusCode::UNPROCESSABLE_ENTITY,
                "scenario sessions require an absolute workspace path",
            );
        }
    }
    let mut routing = state.benchmark.write().unwrap();
    if let Err(error) = routing.registry.register(registration) {
        return problem(StatusCode::CONFLICT, error);
    }
    if let Some(scenario) = &state.scenario
        && let Err(error) = scenario.register_session(&id.0, lane.0, workspace.unwrap())
    {
        routing.registry.remove_session(&id);
        return problem(StatusCode::UNPROCESSABLE_ENTITY, error);
    }
    if let Err(error) = state.telemetry.register_session(&run, &id) {
        routing.registry.remove_session(&id);
        if let Some(scenario) = &state.scenario {
            scenario.remove_session(&id.0);
        }
        return problem(StatusCode::CONFLICT, error);
    }
    let now = state.clock.elapsed_ns();
    let (run_start, count) = routing.runs.entry(run.clone()).or_insert((now, 0));
    *count += 1;
    let run_start_ns = *run_start;
    routing.sessions.insert(
        id.clone(),
        Arc::new(SessionActivity {
            attempts: AtomicUsize::new(0),
            run_start_ns,
            registered_ns: now - run_start_ns,
            finalized_ns: AtomicU64::new(u64::MAX),
        }),
    );
    full_json(StatusCode::CREATED, &json!({"runId": run, "sessionId": id}))
}

async fn session_route(
    method: Method,
    suffix: &str,
    req: Request<Incoming>,
    state: &ServerState,
) -> Response<BoxBody> {
    let (id, action) = suffix.split_once('/').unwrap_or((suffix, ""));
    if id.is_empty() {
        return problem(StatusCode::NOT_FOUND, "session ID is required");
    }
    let id = SessionId(id.into());
    match (method, action) {
        (Method::GET, "") => {
            let query = match SessionQuery::parse(req.uri().query()) {
                Ok(query) => query,
                Err(error) => return problem(StatusCode::BAD_REQUEST, error),
            };
            session_detail(state, &id, query)
        }
        (Method::POST, "observations") => {
            let observation = match read_json::<RunnerObservation>(req).await {
                Ok(observation) => observation,
                Err(error) => return problem(StatusCode::BAD_REQUEST, error),
            };
            let routing = state.benchmark.read().unwrap();
            let Some(record) = routing.registry.get(&id) else {
                return problem(StatusCode::NOT_FOUND, "unknown session");
            };
            if !record.active {
                return problem(StatusCode::CONFLICT, "session is finalized");
            }
            let Some(scenario) = &state.scenario else {
                return problem(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "runner observation requires a configured scenario",
                );
            };
            match scenario.record_runner_observation(&id.0, observation) {
                Ok(()) => full_json(StatusCode::OK, &json!({"recorded": true})),
                Err(error) => problem(StatusCode::UNPROCESSABLE_ENTITY, error),
            }
        }
        (Method::POST, "finalize") => {
            let body = match read_admin_body(req).await {
                Ok(body) => body,
                Err(error) => return problem(StatusCode::BAD_REQUEST, error),
            };
            let proof = if body.is_empty() {
                None
            } else {
                match serde_json::from_slice::<Option<FinalizeProof>>(&body) {
                    Ok(proof) => proof,
                    Err(error) => return problem(StatusCode::BAD_REQUEST, error),
                }
            };
            let mut routing = state.benchmark.write().unwrap();
            let Some(activity) = routing.sessions.get(&id) else {
                return problem(StatusCode::NOT_FOUND, "unknown session");
            };
            if activity.attempts.load(Ordering::Acquire) != 0 {
                return problem(StatusCode::CONFLICT, "session still has in-flight attempts");
            }
            if let Some(proof) = proof {
                let Some(scenario) = &state.scenario else {
                    return problem(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "completion proof requires a configured scenario",
                    );
                };
                if let Err(error) = scenario.verify_completion(
                    &id.0,
                    CompletionProof {
                        response_id: proof.response_id,
                        observed_markers: proof.observed_markers,
                    },
                ) {
                    return problem(StatusCode::UNPROCESSABLE_ENTITY, error);
                }
            }
            let _ = activity.finalized_ns.compare_exchange(
                u64::MAX,
                state.clock.elapsed_ns() - activity.run_start_ns,
                Ordering::Relaxed,
                Ordering::Relaxed,
            );
            routing.registry.finalize(&id);
            let summary = state
                .telemetry
                .finalize(&id.0)
                .expect("registered telemetry");
            full_json(StatusCode::OK, &json!(summary))
        }
        (Method::DELETE, "") => {
            let query = match SessionQuery::parse(req.uri().query()) {
                Ok(query) => query,
                Err(error) => return problem(StatusCode::BAD_REQUEST, error),
            };
            let mut routing = state.benchmark.write().unwrap();
            let Some(record) = routing.registry.get(&id) else {
                return problem(StatusCode::NOT_FOUND, "unknown session");
            };
            if record.active {
                return problem(
                    StatusCode::CONFLICT,
                    "finalize the session before deleting it",
                );
            }
            let Some((cursor, through)) = query.cursor.zip(query.after) else {
                return problem(
                    StatusCode::BAD_REQUEST,
                    "export acknowledgement requires cursor and after",
                );
            };
            let run = record.run_id.clone();
            if !state.telemetry.acknowledge_export(&id.0, cursor, through) {
                return problem(
                    StatusCode::CONFLICT,
                    "acknowledge the finalized session and its final attempt cursor",
                );
            }
            routing.registry.remove_session(&id);
            let activity = routing.sessions.remove(&id);
            routing.lineage.remove_owner(&id);
            if let Some((_, count)) = routing.runs.get_mut(&run) {
                *count -= 1;
                if *count == 0 {
                    routing.runs.remove(&run);
                }
            }
            let retired = routing.responses.remove(&id);
            state.watchdog.remove_session(&id.0);
            state.sessions.remove(&id.0);
            if let Some(scenario) = &state.scenario {
                scenario.remove_session(&id.0);
            }
            drop(routing);
            drop((retired, activity));
            full_json(StatusCode::OK, &json!({"deleted": true}))
        }
        _ => problem(StatusCode::NOT_FOUND, "unknown session route"),
    }
}

fn session_detail(
    state: &ServerState,
    id: &SessionId,
    query: SessionQuery<'_>,
) -> Response<BoxBody> {
    let (activity, metadata) = {
        let routing = state.benchmark.read().unwrap();
        let Some(activity) = routing.sessions.get(id) else {
            return problem(StatusCode::NOT_FOUND, "unknown session");
        };
        let record = routing.registry.get(id).expect("registered session");
        (
            activity.clone(),
            json!({
                "harness": record.harness, "logicalLane": record.logical_lane,
                "scenario": record.scenario, "launchMode": record.launch_mode,
            }),
        )
    };
    let Some(mut detail) = state.telemetry.session_detail(&id.0, None, usize::MAX) else {
        return problem(StatusCode::NOT_FOUND, "unknown session");
    };
    let after = query.after.unwrap_or(0);
    let all_items = std::mem::take(&mut detail.items);
    let compactions: Vec<_> = all_items.iter().filter(|item| item.span.checkpoint_id.is_some() || item.span.adopted_checkpoint_id.is_some())
        .map(|item| json!({
            "cursor":item.cursor, "checkpointId":item.span.checkpoint_id,
                "adoptedCheckpointId":item.span.adopted_checkpoint_id, "purpose":item.span.purpose,
            "outcome":item.span.outcome, "effectiveContextBytes":item.span.effective_context_bytes,
        })).collect();
    let spans: Vec<_> = all_items.iter().map(|item| item.span.clone()).collect();
    let end = activity
        .finalized_ns
        .load(Ordering::Relaxed)
        .min(state.clock.elapsed_ns() - activity.run_start_ns);
    let attribution = compute_attribution(activity.registered_ns, end, &spans);
    let mut items = all_items.into_iter().filter(|item| item.cursor > after);
    detail.items = items.by_ref().take(query.limit()).collect();
    if items.next().is_some() {
        detail.next_cursor = detail.items.last().map_or(after, |item| item.cursor);
    } else {
        detail.next_cursor = after.max(detail.summary.attempts);
    }
    let mut response = json!(detail);
    response["registration"] = metadata;
    response["compactions"] = json!(compactions);
    response["attribution"] = json!(attribution);
    response["audit"] = json!(state.watchdog.session_audit(&id.0));
    response["violations"] = json!(state.watchdog.violations_for_session(&id.0));
    full_json(StatusCode::OK, &response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MockAiBuilder;
    use crate::plan::TurnPlan;
    use crate::routing::{RequestClassifier, RequestUse, SideKind};
    use crate::scenario::{
        BenchmarkTrack, CanonicalAction, CompactionMode, FaultKind, ScenarioSpec, ScheduledFault,
    };
    use futures_util::{SinkExt, StreamExt};
    use reqwest::{Client, Response as ClientResponse, StatusCode};
    use serde_json::Value;
    use tokio_tungstenite::{connect_async, tungstenite::Message};

    async fn post(client: &Client, url: &str, body: Value) -> ClientResponse {
        client
            .post(url)
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .unwrap()
    }

    async fn body(response: ClientResponse, status: StatusCode) -> Value {
        let actual = response.status();
        let text = response.text().await.unwrap();
        assert_eq!(actual, status, "{text}");
        serde_json::from_str(&text).unwrap()
    }

    async fn register(client: &Client, origin: &str, session: &str, harness: &str) {
        let response = post(
            client,
            &format!("{origin}/admin/sessions"),
            json!({
                "run_id": "run", "session_id": session, "harness": harness,
                "logical_lane": session, "scenario": "fixture",
                "workspace": std::env::current_dir().unwrap(),
            }),
        )
        .await;
        body(response, StatusCode::CREATED).await;
    }

    #[tokio::test]
    async fn runner_can_report_harness_termination_without_a_followup_model_turn() {
        let scenario = ScenarioSpec::new("fixture", 42, "fixture", BenchmarkTrack::Native)
            .with_step(
                "unknown",
                CanonicalAction::UnknownTool {
                    name: "unlisted_fixture_tool".into(),
                    expect_handling: crate::scenario::FailureHandling::HarnessTermination,
                },
            )
            .with_step(
                "finish",
                CanonicalAction::FinalAnswer {
                    text: "scenario continued".into(),
                    expect_markers: Vec::new(),
                },
            );
        let server = MockAiBuilder::new()
            .scenario(scenario)
            .start()
            .await
            .unwrap();
        let client = Client::new();
        let origin = server.origin_url();
        register(&client, &origin, "one", "opencode").await;
        let responses = format!("{origin}/s/run/one/v1/responses");
        let request = json!({"input": "begin"});
        let issued = body(
            post(&client, &responses, request.clone()).await,
            StatusCode::OK,
        )
        .await;
        let call = &issued["output"][0];
        assert_eq!(call["name"], "unlisted_fixture_tool");
        let observations = format!("{origin}/admin/sessions/one/observations");
        let observation = json!({
            "sessionId": "one",
            "attempt": 1,
            "callId": call["call_id"],
            "kind": "harnessTermination",
            "detail": "harness exited after the unknown call"
        });
        let mut foreign = observation.clone();
        foreign["sessionId"] = json!("two");
        body(
            post(&client, &observations, foreign).await,
            StatusCode::UNPROCESSABLE_ENTITY,
        )
        .await;
        assert_eq!(
            body(
                post(&client, &observations, observation).await,
                StatusCode::OK
            )
            .await,
            json!({"recorded": true})
        );
        let after = body(
            post(&client, &responses, request).await,
            StatusCode::UNPROCESSABLE_ENTITY,
        )
        .await;
        assert_eq!(
            after["error"]["message"],
            "the runner reported harness termination"
        );
    }

    #[tokio::test]
    async fn context_overflow_advances_after_the_client_returns_its_summary() {
        let scenario = ScenarioSpec::new("fixture", 42, "fixture", BenchmarkTrack::Native)
            .with_step(
                "compact",
                CanonicalAction::TriggerCompaction {
                    mode: CompactionMode::ContextOverflow {
                        actual_bytes: 8_000,
                        limit_bytes: 4_000,
                    },
                    proof_marker: "overflow-proof".into(),
                },
            )
            .with_step(
                "finish",
                CanonicalAction::FinalAnswer {
                    text: "continued after compaction".into(),
                    expect_markers: Vec::new(),
                },
            );
        let server = MockAiBuilder::new()
            .scenario(scenario)
            .start()
            .await
            .unwrap();
        let client = Client::new();
        let origin = server.origin_url();
        register(&client, &origin, "one", "codex").await;
        let responses = format!("{origin}/s/run/one/v1/responses");

        let overflow = body(
            post(&client, &responses, json!({"input": "begin"})).await,
            StatusCode::BAD_REQUEST,
        )
        .await;
        assert_eq!(overflow["error"]["code"], "context_length_exceeded");
        let summary = post(&client, &responses, json!({
            "model": "gpt-5", "stream": true, "store": false,
            "input": [
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "begin"}]},
                {"type": "message", "role": "user", "content": [{"type": "input_text",
                    "text": "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task."}]},
                {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "Executed tools: shell_command"}]}
            ]
        })).await;
        assert_eq!(summary.status(), StatusCode::OK);
        let stream = summary.text().await.unwrap();
        let summary = stream
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .map(|data| serde_json::from_str::<Value>(data).unwrap())
            .find(|event| event["type"] == "response.completed")
            .unwrap()["response"]
            .clone();
        let summary_text = summary["output"][0]["content"][0]["text"].as_str().unwrap();
        let (checkpoint_id, marker) = summary_text.split_once(' ').unwrap();
        assert_eq!(marker, "overflow-proof");

        let continued = body(
            post(&client, &responses, json!({
                "input": [
                    {"type": "message", "role": "user", "content": [{"type": "input_text",
                        "text": format!("Here is the summary produced by the other language model:\n{summary_text}")}]},
                    {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "continue"}]}
                ]
            })).await,
            StatusCode::OK,
        ).await;
        assert_eq!(
            continued["output"][0]["content"][0]["text"],
            "continued after compaction"
        );
        let detail = body(
            client
                .get(format!("{origin}/admin/sessions/one"))
                .send()
                .await
                .unwrap(),
            StatusCode::OK,
        )
        .await;
        let compactions = detail["compactions"].as_array().unwrap();
        assert!(compactions.iter().any(|event| {
            event["purpose"] == "compact" && event["checkpointId"] == checkpoint_id
        }));
        assert!(
            compactions
                .iter()
                .any(|event| event["adoptedCheckpointId"] == checkpoint_id)
        );
    }

    #[tokio::test]
    async fn scenario_retry_compaction_and_export_stay_inside_registered_session() {
        let scenario = ScenarioSpec::new("fixture", 42, "fixture", BenchmarkTrack::Native)
            .with_step(
                "compact",
                CanonicalAction::TriggerCompaction {
                    mode: CompactionMode::Native,
                    proof_marker: "proof-token".into(),
                },
            )
            .with_step(
                "finish",
                CanonicalAction::FinalAnswer {
                    text: "verified result".into(),
                    expect_markers: vec!["verified".into()],
                },
            )
            .with_fault(ScheduledFault {
                step: "compact".into(),
                attempt: 1,
                at: Default::default(),
                emit: FaultKind::Http429,
            });
        let server = MockAiBuilder::new()
            .scenario(scenario)
            .start()
            .await
            .unwrap();
        let origin = server.origin_url();
        let client = Client::new();
        register(&client, &origin, "one", "opencode").await;
        register(&client, &origin, "two", "opencode").await;
        let scoped = format!("{origin}/s/run/one/v1");
        let responses = format!("{scoped}/responses");

        let forbidden = client
            .get(format!("{origin}/s/run/one/metrics"))
            .send()
            .await
            .unwrap();
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
        let unknown = client
            .get(format!("{scoped}/unknown"))
            .send()
            .await
            .unwrap();
        let unknown = body(unknown, StatusCode::NOT_FOUND).await;
        assert!(unknown.to_string().contains("/s/run/one/v1/unknown"));

        let count = post(
            &client,
            &format!("{scoped}/messages/count_tokens"),
            json!({
                "system": "sys", "messages": [{"role": "user", "content": "hello"}]
            }),
        )
        .await;
        assert_eq!(body(count, StatusCode::OK).await, json!({"input_tokens":4}));

        let title = client
            .post(&responses)
            .header("x-maka-bench-request-use", "title")
            .body(json!({"input":"title only","stream":true}).to_string())
            .send()
            .await
            .unwrap();
        assert!(title.text().await.unwrap().contains("Benchmark task"));
        assert_eq!(server.request_count(), 0);

        let request = json!({"model":"gpt-5", "input":"explore"});
        let conflict = client
            .post(&responses)
            .header("x-maka-bench-session", "two")
            .body(request.to_string())
            .send()
            .await
            .unwrap();
        assert_eq!(
            body(conflict, StatusCode::BAD_REQUEST).await["error"]["code"],
            "session_identity_conflict"
        );
        let fault = body(
            post(&client, &responses, request.clone()).await,
            StatusCode::TOO_MANY_REQUESTS,
        )
        .await;
        assert_eq!(fault["error"]["type"], "rate_limit_error");
        let issued = body(post(&client, &responses, request).await, StatusCode::OK).await;
        let previous = issued["id"].as_str().unwrap();
        let compact = body(
            post(
                &client,
                &format!("{responses}/compact"),
                json!({
                    "model":"gpt-5", "previous_response_id": previous,
                    "input":[{"role":"user","content":"explore"}]
                }),
            )
            .await,
            StatusCode::OK,
        )
        .await;
        assert_eq!(compact["object"], "response.compaction");
        assert_eq!(
            compact["output"][1]["encrypted_content"],
            "mock:proof-token"
        );
        let finished = body(
            post(
                &client,
                &responses,
                json!({
                    "model":"gpt-5", "previous_response_id": compact["id"],
                    "input":[compact["output"][1].clone()]
                }),
            )
            .await,
            StatusCode::OK,
        )
        .await;
        assert_eq!(
            finished["output"][0]["content"][0]["text"],
            "verified result"
        );
        let id = finished["id"].as_str().unwrap();
        let own = client
            .get(format!("{responses}/{id}"))
            .send()
            .await
            .unwrap();
        assert_eq!(body(own, StatusCode::OK).await["id"], id);
        let foreign = client
            .get(format!("{origin}/s/run/two/v1/responses/{id}"))
            .send()
            .await
            .unwrap();
        assert_eq!(foreign.status(), StatusCode::NOT_FOUND);

        let endpoint = format!("{origin}/admin/sessions/one");
        let detail = body(client.get(&endpoint).send().await.unwrap(), StatusCode::OK).await;
        let items = detail["items"].as_array().unwrap();
        let main: Vec<_> = items
            .iter()
            .filter(|span| span["purpose"] == "main")
            .collect();
        assert_eq!(main.len(), 3);
        assert_eq!(main[0]["outcome"], "injected_fault");
        assert_eq!(main[0]["revision"], main[1]["revision"]);
        assert_ne!(main[0]["attempt"], main[1]["attempt"]);
        assert_eq!(main[2]["adoptedCheckpointId"], compact["output"][1]["id"]);
        assert!(items.iter().any(|span| span["purpose"] == "title"
            && span["firstSemanticDeltaNs"].as_u64().unwrap()
                >= span["firstByteNs"].as_u64().unwrap()));
        assert!(detail["attribution"]["mockUnionNs"].as_u64().unwrap() > 0);

        let reset = client
            .post(format!("{origin}/admin/reset"))
            .send()
            .await
            .unwrap();
        assert_eq!(reset.status(), StatusCode::CONFLICT);
        let summary = body(
            post(
                &client,
                &format!("{endpoint}/finalize"),
                json!({
                    "responseId":id, "observedMarkers":["verified"],
                }),
            )
            .await,
            StatusCode::OK,
        )
        .await;
        assert_eq!(summary["finalized"], true);
        let deleted = client
            .delete(format!(
                "{endpoint}?cursor={}&after={}",
                summary["cursor"], summary["attempts"]
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(body(deleted, StatusCode::OK).await, json!({"deleted":true}));
        assert_eq!(
            client.get(&endpoint).send().await.unwrap().status(),
            StatusCode::NOT_FOUND
        );
        server.shutdown().await;
    }

    #[tokio::test]
    async fn websocket_warmup_and_side_turn_leave_transient_main_baseline_intact() {
        let mut classifier = RequestClassifier::default();
        classifier
            .model_aliases
            .insert("title".into(), RequestUse::Side(SideKind::Title));
        let server = MockAiBuilder::new()
            .strict_benchmark(true)
            .request_classifier(classifier)
            .scripted([
                TurnPlan::text("first").with_response_id("r1"),
                TurnPlan::text("second").with_response_id("r2"),
            ])
            .start()
            .await
            .unwrap();
        let origin = server.origin_url();
        let client = Client::new();
        register(&client, &origin, "one", "codex").await;
        let url = format!("ws://{}/s/run/one/v1/responses", server.addr());

        async fn reply(
            ws: &mut tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            request: Value,
        ) -> Value {
            ws.send(Message::text(request.to_string())).await.unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                let mut created = None;
                loop {
                    let message = ws.next().await.unwrap().unwrap();
                    if let Message::Text(text) = message {
                        let event: Value = serde_json::from_str(&text).unwrap();
                        match event["type"].as_str() {
                            Some("response.created") => {
                                assert!(created.replace(event["response"]["id"].clone()).is_none());
                            }
                            Some("response.completed") => {
                                assert_eq!(created, Some(event["response"]["id"].clone()));
                                return event;
                            }
                            Some("error") => return event,
                            _ => {}
                        }
                    }
                }
            })
            .await
            .unwrap()
        }

        let (mut ws, _) = connect_async(&url).await.unwrap();
        let warmup = reply(
            &mut ws,
            json!({"type":"response.create", "model":"gpt-5", "generate":false}),
        )
        .await;
        assert_eq!(warmup["response"]["output"], json!([]));
        assert_eq!(warmup["response"]["usage"]["input_tokens"], 0);
        assert_eq!(warmup["response"]["usage"]["output_tokens"], 0);
        let warmup_id = warmup["response"]["id"].as_str().unwrap();
        assert_eq!(server.metrics().responses_ws_turns, 0);
        let first = reply(
            &mut ws,
            json!({"type":"response.create", "model":"gpt-5", "input":"first","store":false,
                "previous_response_id":warmup_id}),
        )
        .await;
        assert_eq!(first["response"]["id"], "r1");
        let side = reply(
            &mut ws,
            json!({"type":"response.create", "model":"title","input":"title"}),
        )
        .await;
        assert_eq!(
            side["response"]["output"][0]["content"][0]["text"],
            "Benchmark task"
        );

        let (mut other, _) = connect_async(&url).await.unwrap();
        let continuation = json!({"type":"response.create", "model":"gpt-5", "previous_response_id":"r1", "input":"next"});
        let rejected = reply(&mut other, continuation.clone()).await;
        assert_eq!(rejected["error"]["code"], "previous_response_not_found");
        let second = reply(&mut ws, continuation).await;
        assert_eq!(second["response"]["id"], "r2");
        let transient = client
            .get(format!("{origin}/s/run/one/v1/responses/r1"))
            .send()
            .await
            .unwrap();
        assert_eq!(transient.status(), StatusCode::NOT_FOUND);
        server.shutdown().await;
    }
}
