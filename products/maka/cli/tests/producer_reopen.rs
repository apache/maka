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

#![cfg(unix)]

#[path = "support/host.rs"]
mod host;

use futures_util::{FutureExt, StreamExt};
use host::{Host, Result, Sandbox};
use http_body_util::{BodyExt, Full, StreamBody, combinators::UnsyncBoxBody};
use hyper::{
    Request, Response,
    body::{Bytes, Frame, Incoming},
    service::service_fn,
};
use hyper_util::rt::TokioIo;
use maka_agent_api::contract::{ContextReport, Execution, GoalView, HistoryPage};
use maka_agent_facts::{configuration::CatalogMutationResult, durable::ContentRef};
use maka_agent_ports::session::history::{HistoryField, HistoryRowAddress, Role};
use maka_app_client::{Client, Journal};
use maka_capabilities::call::{Attachments, ReadResource, ResourceEncoding};
use maka_config::ConfigurationStore;
use maka_event_log::root::{RootNamespaces, RootOwner};
use maka_plugin_core::{
    contract::ResourceType,
    operation::{OperationCleanup, OperationOutcome, OperationResult, Receipt},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    convert::Infallible,
    future::Future,
    ops::Range,
    panic::AssertUnwindSafe,
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    net::TcpListener,
    process::{Child, ChildStdout},
    sync::mpsc,
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone, Copy)]
enum Producer {
    Goal { pending_steering: bool },
    GoalBudget,
    Scheduler,
    Automation,
}

struct FixtureKey;
impl ReadResource for FixtureKey {
    fn encoding(&self) -> ResourceEncoding {
        ResourceEncoding::Utf8
    }
    fn resource_type(&self) -> ResourceType {
        ResourceType {
            name: "maka.text.utf8".into(),
            version: 1,
        }
    }
    fn bytes(&self) -> usize {
        b"producer-fixture".len()
    }
    fn metadata(&self) -> Value {
        json!({})
    }
    fn read(&self, range: Range<usize>) -> Result<Vec<u8>> {
        b"producer-fixture"
            .get(range)
            .map(<[u8]>::to_vec)
            .ok_or_else(|| "invalid fixture credential range".into())
    }
}

async fn phase<T>(name: &str, future: impl Future<Output = Result<T>>) -> Result<T> {
    tokio::time::timeout(Duration::from_secs(30), future)
        .await
        .map_err(|_| format!("deadline: {name}"))?
        .map_err(|error| format!("{name}: {error}"))
}

async fn mutate(
    client: &Client,
    endpoint: &str,
    method: &str,
    input: Value,
    resources: Attachments,
) -> Result<Value> {
    phase(&format!("{endpoint}.{method}"), async {
        let call = client
            .mutation(
                Uuid::new_v4(),
                endpoint,
                method,
                input,
                resources,
                None,
                json!({"kind":"producer-cold-reopen"}),
            )
            .await?;
        call.prepare().await?;
        let reply = call.confirm().await?;
        match reply.receipt {
            Receipt::Recorded {
                outcome:
                    OperationOutcome::Returned {
                        result: OperationResult::Success { value },
                    },
                cleanup: OperationCleanup::Confirmed,
                ..
            } => Ok(value),
            other => Err(format!(
                "known result and original cleanup required: {other:?}"
            )),
        }
    })
    .await
}

async fn query(client: &Client, method: &str, input: Value) -> Result<Value> {
    phase(
        &format!("agent.{method}"),
        client.query("agent", method, input),
    )
    .await
}

type Body = UnsyncBoxBody<Bytes, Infallible>;
fn response(body: String, content_type: &str) -> Response<Body> {
    Response::builder()
        .header("content-type", content_type)
        .header("connection", "close")
        .body(Full::new(Bytes::from(body)).boxed_unsync())
        .unwrap()
}
fn sse(delta: Value, finish: &str) -> Response<Body> {
    let first = json!({"id":"producer","object":"chat.completion.chunk","choices":[{"index":0,"delta":delta,"finish_reason":null}]});
    let last = json!({"id":"producer","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":finish}],
        "usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}});
    response(
        format!("data: {first}\n\ndata: {last}\n\ndata: [DONE]\n\n"),
        "text/event-stream",
    )
}
fn scheduled_tool(id: &str, input: Value) -> Response<Body> {
    sse(
        json!({"tool_calls":[{"index":0,"id":id,"type":"function","function":{
        "name":"ScheduledTask","arguments":json!({"request":input}).to_string()}}]}),
        "tool_calls",
    )
}

fn tool_text<'a>(messages: &'a [Value], id: &str) -> Result<&'a str> {
    let mut results = messages
        .iter()
        .filter(|message| message["role"] == "tool" && message["tool_call_id"] == id);
    let result = results.next().ok_or("actual direct tool result missing")?;
    assert!(
        results.next().is_none(),
        "one original direct tool result required"
    );
    result["content"]
        .as_str()
        .ok_or_else(|| "direct tool content must be a string".to_string())
}

const RECOVERY_STEERING: &str = "Keep this queued correction after the original Run fails.";

struct Model {
    producer: Producer,
    marker: String,
    bootstrap: String,
    bootstrap_step: Mutex<u8>,
    requests: AtomicUsize,
    producer_requests: AtomicUsize,
    eof: AtomicUsize,
}
impl Model {
    async fn reply(
        &self,
        request: Request<Incoming>,
        held: Arc<AtomicBool>,
        events: mpsc::UnboundedSender<&'static str>,
    ) -> Result<Response<Body>> {
        if request.method() == hyper::Method::GET && request.uri().path().ends_with("/models") {
            return Ok(response(
                json!({"object":"list","data":[{"id":"gpt-4.1","object":"model"}]}).to_string(),
                "application/json",
            ));
        }
        if request.uri().path() == "/v1/condition.ts" {
            return Ok(response(
                "export const ready = true;".into(),
                "application/typescript",
            ));
        }
        if request.uri().path() == "/v1/condition" {
            let is_post = request.method() == hyper::Method::POST;
            let has_header = request
                .headers()
                .get("x-condition")
                .is_some_and(|value| value == "ready");
            let body = request
                .into_body()
                .collect()
                .await
                .map_err(|error| error.to_string())?
                .to_bytes();
            return Ok(response(
                (is_post && has_header && body.as_ref() == b"check").to_string(),
                "application/json",
            ));
        }
        if request.method() != hyper::Method::POST
            || !request.uri().path().ends_with("/chat/completions")
        {
            return Err("unexpected model request: other".into());
        }
        self.requests.fetch_add(1, Ordering::SeqCst);
        let bytes = request
            .into_body()
            .collect()
            .await
            .map_err(|error| error.to_string())?
            .to_bytes();
        let body: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        let messages = body["messages"]
            .as_array()
            .ok_or("model messages missing")?;
        let tools = body["tools"].as_array().ok_or("model tools missing")?;
        let has_user = |marker: &str| {
            messages.iter().any(|message| {
                message["role"] == "user" && message["content"].to_string().contains(marker)
            })
        };
        if matches!(self.producer, Producer::Automation) {
            let last = messages
                .iter()
                .rev()
                .find(|message| message["role"] == "user")
                .ok_or("automation fixture received no user message")?;
            let content = last["content"].to_string();
            if content.contains("AUTOMATION-FOLLOWUP") || content.contains("AUTOMATION-STEERING") {
                self.producer_requests.fetch_add(1, Ordering::SeqCst);
                return Ok(sse(json!({"content":"Automation delivered."}), "stop"));
            }
        }
        if has_user(&self.marker)
            || (matches!(self.producer, Producer::Automation) && has_user(&self.bootstrap))
        {
            let iteration = self.producer_requests.fetch_add(1, Ordering::SeqCst) + 1;
            if matches!(self.producer, Producer::GoalBudget) {
                assert!(
                    iteration <= 2,
                    "finite Goal must not dispatch a third iteration"
                );
                return Ok(sse(
                    json!({"content":"Budgeted iteration complete."}),
                    "stop",
                ));
            }
            if let Producer::Goal { pending_steering } = self.producer
                && iteration > 1
            {
                if pending_steering {
                    let corrections = messages
                        .iter()
                        .filter(|message| {
                            message["role"] == "user"
                                && message["content"].to_string().contains(RECOVERY_STEERING)
                        })
                        .count();
                    assert_eq!(corrections, 1, "one delivered correction in model history");
                    if iteration == 2 {
                        return Ok(sse(json!({"content":"Correction handled."}), "stop"));
                    }
                }
                return match iteration - usize::from(pending_steering) {
                    2 => Ok(sse(
                        json!({"tool_calls":[{"index":0,"id":"finish-goal","type":"function","function":{
                            "name":"GoalStatus","arguments":json!({"status":"achieved","note":"Continued in a new iteration."}).to_string()
                        }}]}),
                        "tool_calls",
                    )),
                    3 => {
                        let output: Value =
                            serde_json::from_str(tool_text(messages, "finish-goal")?)
                                .map_err(|error| error.to_string())?;
                        assert_eq!(output["current"]["status"], "achieved");
                        Ok(sse(
                            json!({"content":"Goal completed after restart."}),
                            "stop",
                        ))
                    }
                    _ => Err("Goal dispatched an extra model request".into()),
                };
            }
            held.store(true, Ordering::SeqCst);
            // Headers and an SSE comment only: no semantic item, finish or DONE.
            let first = futures_util::stream::once(async move {
                events.send("accepted").expect("outer observation slot");
                Ok::<_, Infallible>(Frame::data(Bytes::from_static(b": pending\n\n")))
            });
            return Ok(Response::builder()
                .header("content-type", "text/event-stream")
                .header("connection", "close")
                .body(
                    StreamBody::new(first.chain(futures_util::stream::pending::<
                        std::result::Result<Frame<Bytes>, Infallible>,
                    >()))
                    .boxed_unsync(),
                )
                .unwrap());
        }
        if !has_user(&self.bootstrap) {
            return Err("unexpected non-producer model request".into());
        }
        let mut step = self.bootstrap_step.lock().unwrap();
        if *step != 0 {
            let scheduled = tools
                .iter()
                .find(|tool| tool["function"]["name"] == "ScheduledTask")
                .expect("discovered ScheduledTask must be in the next actual wire request");
            assert!(
                scheduled["function"]["parameters"]["properties"]
                    .get("request")
                    .is_some(),
                "ScheduledTask must advertise its actual request schema"
            );
        }
        let reply = match *step {
            0 => {
                let search = tools
                    .iter()
                    .find(|tool| tool["function"]["name"] == "tool_search")
                    .expect("Direct discovery must advertise its actual tool_search");
                assert!(
                    search["function"]["parameters"]["properties"]
                        .get("query")
                        .is_some(),
                    "tool_search must advertise its actual query schema"
                );
                sse(
                    json!({"tool_calls":[{"index":0,"id":"discover-schedule","type":"function","function":{
                    "name":"tool_search","arguments":json!({"query":"ScheduledTask","limit":1}).to_string()}}]}),
                    "tool_calls",
                )
            }
            1 => {
                // Direct JSON tool outputs are JSON text in content, not projection envelopes.
                let value: Value = serde_json::from_str(tool_text(messages, "discover-schedule")?)
                    .map_err(|error| format!("direct discovery result JSON: {error}"))?;
                assert!(
                    value == json!({"activated":["ScheduledTask"]}),
                    "actual discovery result must activate exactly ScheduledTask"
                );
                let start_at = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64
                    + 10_000;
                scheduled_tool(
                    "create-schedule",
                    json!({"mode":"create","title":"Agent-created one-fire acceptance",
                    "intentBody":self.marker,"schedule":{"kind":"interval","everySeconds":1,"startAt":start_at},
                    "timezone":"UTC","misfire":"latest","effect":"agent_run","maxFires":1,"expiresAt":null}),
                )
            }
            2 => {
                let value: Value = serde_json::from_str(tool_text(messages, "create-schedule")?)
                    .map_err(|error| format!("direct create result JSON: {error}"))?;
                assert!(value["taskId"].is_string());
                assert!(value["revision"].is_u64());
                sse(json!({"content":"Scheduled task created."}), "stop")
            }
            _ => return Err("bootstrap must not dispatch again".into()),
        };
        *step += 1;
        Ok(reply)
    }
}

// The outer scope, not the accept task's Drop, owns every connection task.
async fn serve(
    listener: TcpListener,
    model: Arc<Model>,
    events: mpsc::UnboundedSender<&'static str>,
    stop: CancellationToken,
    connections: Arc<tokio::sync::Mutex<JoinSet<Result<()>>>>,
) -> Result<()> {
    loop {
        let socket = tokio::select! {
            _ = stop.cancelled() => return Ok(()),
            accepted = listener.accept() => accepted.map_err(|error| error.to_string())?.0,
        };
        let (model, events, stop) = (model.clone(), events.clone(), stop.clone());
        connections.lock().await.spawn(async move {
            let held = Arc::new(AtomicBool::new(false));
            let observed = held.clone();
            let service_model = model.clone();
            let closed = events.clone();
            let service = service_fn(move |request| {
                let (model, held, events) = (service_model.clone(), held.clone(), events.clone());
                async move {
                    model
                        .reply(request, held, events)
                        .await
                        .map_err(std::io::Error::other)
                }
            });
            let mut builder = hyper::server::conn::http1::Builder::new();
            builder.keep_alive(false);
            let result = tokio::select! {
                _ = stop.cancelled() => return Ok(()),
                result = builder.serve_connection(TokioIo::new(socket), service) => result,
            };
            if observed.load(Ordering::SeqCst) {
                if let Err(error) = result
                    && !(error.is_incomplete_message() || error.is_canceled() || error.is_closed())
                {
                    return Err(format!("held model connection: {error}"));
                }
                model.eof.fetch_add(1, Ordering::SeqCst);
                closed.send("eof").map_err(|error| error.to_string())?;
                Ok(())
            } else {
                result.map_err(|error| error.to_string())
            }
        });
    }
}

fn work_metadata(value: &Value) -> Value {
    let execution = &value["execution"];
    let state = &execution["state"];
    let waits: Vec<_> = state["waits"]
        .as_array()
        .into_iter()
        .flatten()
        .take(4)
        .map(|wait| {
            json!({"kind":wait["kind"],"cell":wait["cell"],"task":wait["task"],
            "attempt":wait["attempt"],"approval":wait["approval"],"run":wait["run"],
            "blocker":wait["blocker"],"tool":wait["tool"].as_object().map(|_| {
                json!({"attempt":wait["tool"]["attempt"],"call":wait["tool"]["call"]})
            })})
        })
        .collect();
    json!({"kind":value["kind"],"shared":value["shared"],
        "execution":{"sessionId":execution["sessionId"],"turnId":execution["turnId"],
            "runId":execution["runId"],"highWater":execution["highWater"],
            "state":{"kind":state["kind"],"reason":state["reason"],"waits":waits,
                "waitCount":state["waits"].as_array().map(Vec::len)}},
        "pendingInteractions":value["pendingInteractions"]})
}

fn diagnostic(result: Result<Value>) -> Value {
    match result {
        Ok(value) => value,
        Err(error) => json!({"diagnosticError":error.chars().take(512).collect::<String>()}),
    }
}

async fn model_accept_snapshot(
    client: &Client,
    session: &str,
    message: &str,
    model: &Model,
) -> Value {
    let counts = json!({"requests":model.requests.load(Ordering::SeqCst),
        "producerRequests":model.producer_requests.load(Ordering::SeqCst),
        "eof":model.eof.load(Ordering::SeqCst)});
    let goal = async {
        let view: GoalView = serde_json::from_value(
            query(client, "goal", json!({"sessionId":session})).await?,
        ).map_err(|error| error.to_string())?;
        Ok(json!({"enabled":view.enabled,"current":view.current.map(|goal| json!({
            "id":goal.id,"revision":goal.revision,"status":goal.status,"iterations":goal.iterations,
            "tokenBudget":goal.token_budget,"consumed":goal.consumed,"remainingTokens":goal.remaining_tokens,
            "pending":goal.pending,"note":goal.note.chars().take(512).collect::<String>()
        }))}))
    }.await;
    let observed = query(
        client,
        "work",
        json!({
            "sessionId":session,"target":{"kind":"message","messageId":message}
        }),
    )
    .await;
    let context = match &observed {
        Ok(value) if value["kind"] == "delivered" => Some(diagnostic(async {
            let execution: Execution = serde_json::from_value(value["execution"].clone())
                .map_err(|error| error.to_string())?;
            if execution.session_id != session {
                return Err("diagnostic work returned a different Session".into());
            }
            let report: ContextReport = serde_json::from_value(query(client, "context", json!({
                "sessionId":session,"runId":execution.run_id,"through":null
            })).await?).map_err(|error| error.to_string())?;
            if report.request.as_ref().is_some_and(|request|
                request.execution.session_id != session || request.execution.run_id != execution.run_id
                    || request.execution.turn_id != execution.turn_id)
            {
                return Err("diagnostic context returned a different original execution".into());
            }
            Ok(json!({"through":report.through,"request":report.request.map(|request| json!({
                "execution":request.execution,"stepId":request.step_id,"attemptId":request.attempt_id,
                "sequence":request.sequence,"state":request.state,"reportedInputTokens":request.reported_input_tokens
            }))}))
        }.await)),
        _ => None,
    };
    json!({"countsAtDeadline":counts,"goal":diagnostic(goal),
        "work":diagnostic(observed.map(|value| work_metadata(&value))),"context":context})
}

async fn failed_run_history(client: &Client, session: &str, execution: &Value) -> Result<Value> {
    let execution: Execution =
        serde_json::from_value(execution.clone()).map_err(|error| error.to_string())?;
    if execution.session_id != session {
        return Err("diagnostic failed Run belongs to a different Session".into());
    }
    let page: HistoryPage = serde_json::from_value(
        query(
            client,
            "history",
            json!({
                "sessionId":session,"through":null,"position":{"kind":"tail"},
                "includeThinking":false,"view":"conversation"
            }),
        )
        .await?,
    )
    .map_err(|error| error.to_string())?;
    let HistoryPage::Ready {
        through,
        chunks,
        before,
        after,
    } = page;
    let mut remaining = 2048;
    let mut failures = Vec::new();
    for row in chunks
        .into_iter()
        .filter(|row| {
            row.role == Role::Failure
                && row.field == HistoryField::Body
                && row.run_id == Some(execution.run_id)
                && row.turn_id.as_deref() == Some(execution.turn_id.as_str())
        })
        .take(4)
    {
        let HistoryRowAddress::Live { sequence, .. } = row.position else {
            continue;
        };
        let text: String = row.text.chars().take(remaining).collect();
        remaining -= text.chars().count();
        failures.push(
            json!({"runId":row.run_id,"turnId":row.turn_id,"sequence":sequence,
            "offset":row.offset,"totalBytes":row.total_bytes,"text":text}),
        );
    }
    Ok(
        json!({"sessionId":session,"runId":execution.run_id,"turnId":execution.turn_id,
        "through":through,"moreBefore":before.is_some(),"moreAfter":after.is_some(),"failures":failures}),
    )
}

async fn work(
    client: &Client,
    session: &str,
    message: &str,
    terminal: Option<&str>,
    model: Option<&Model>,
) -> Result<Value> {
    let mut first = None;
    let mut last = None;
    let mut failed = None;
    let result = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let value = query(
                client,
                "work",
                json!({"sessionId":session,"target":{"kind":"message","messageId":message}}),
            )
            .await?;
            let metadata = work_metadata(&value);
            if model.is_some() {
                first.get_or_insert_with(|| metadata.clone());
                last = Some(metadata.clone());
            }
            match value["kind"].as_str() {
                Some("pending") => {}
                Some("delivered") => {
                    assert_eq!(value["shared"], false);
                    let state = value["execution"]["state"]["kind"].as_str().unwrap();
                    if terminal.is_none_or(|expected| state == expected) {
                        return Ok(value["execution"].clone());
                    }
                    if terminal == Some("completed")
                        && state == "failed"
                        && model.is_some_and(|model| matches!(model.producer, Producer::GoalBudget))
                    {
                        failed = Some(value["execution"].clone());
                        return Err(format!("unexpected original Run: {metadata}"));
                    }
                    assert!(
                        matches!(state, "admitted" | "running" | "waiting"),
                        "unexpected original Run: {metadata}"
                    );
                }
                _ => return Err(format!("original message unavailable: {metadata}")),
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    match result {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => {
            if let Some(execution) = failed {
                eprintln!("original message to Run: {error}");
                let history = diagnostic(failed_run_history(client, session, &execution).await);
                return Err(format!(
                    "original message to Run: {error}; failureHistory={history}"
                ));
            }
            Err(format!("original message to Run: {error}"))
        }
        Err(_) => {
            let Some(model) = model else {
                return Err("deadline: original message to Run".into());
            };
            let bootstrap_step = model
                .bootstrap_step
                .lock()
                .map(|step| *step)
                .map_err(|_| "bootstrap step lock poisoned");
            let counts = json!({"requests":model.requests.load(Ordering::SeqCst),
                "producerRequests":model.producer_requests.load(Ordering::SeqCst),
                "eof":model.eof.load(Ordering::SeqCst),"bootstrapStep":bootstrap_step});
            Err(format!(
                "deadline: original message to Run; firstWork={first:?}; lastSuccessfulWork={last:?}; countsAtDeadline={counts}"
            ))
        }
    }
}

async fn user_message(client: &Client, session: &str, message: &str, run: &Value) -> Result<Value> {
    let history = query(
        client,
        "history",
        json!({"sessionId":session,"position":{"kind":"start"}}),
    )
    .await?;
    assert_eq!(history["kind"], "ready");
    assert!(
        history["after"].is_null(),
        "small producer transcript must be read completely: {history}"
    );
    let users: Vec<_> = history["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|chunk| chunk["role"] == "user")
        .collect();
    assert_eq!(
        users.len(),
        1,
        "exactly one original producer message: {history}"
    );
    let user = users[0];
    assert_eq!(user["messageId"], message);
    assert_eq!(&user["runId"], run);
    assert_eq!(user["offset"], 0);
    Ok(
        json!({"messageId":user["messageId"],"runId":user["runId"],"turnId":user["turnId"],
        "origin":user["origin"],"text":user["text"],"position":user["position"],"totalBytes":user["totalBytes"]}),
    )
}

async fn schedule(client: &Client, id: &str) -> Result<Value> {
    let result = query(client, "schedules", json!({"kind":"get","taskId":id})).await?;
    assert_eq!(result["kind"], "task");
    assert!(
        result["detail"].is_object(),
        "original task missing: {result}"
    );
    Ok(result["detail"].clone())
}

async fn inspect(
    sandbox: &Sandbox,
    session: &str,
    children: &mut Vec<(Child, ChildStdout)>,
) -> Result<Value> {
    let mut child = host::command(sandbox)?
        .args(["inspect", "--root"])
        .arg(&sandbox.root)
        .args(["--session", session])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| error.to_string())?;
    let stdout = child.stdout.take().unwrap();
    children.push((child, stdout));
    phase("read-only canonical inspection wait/EOF", async {
        let (child, stdout) = children.last_mut().unwrap();
        let mut bytes = Vec::new();
        match tokio::join!(stdout.read_to_end(&mut bytes), child.wait()) {
            (Ok(_), Ok(status)) if status.success() => {}
            other => return Err(format!("inspect wait/EOF: {other:?}")),
        }
        let result: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        assert_eq!(result["truncated"], false);
        Ok(result)
    })
    .await
}
fn records(inspection: &Value) -> Vec<Value> {
    inspection["facts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["item"]["recorded"].clone())
        .collect()
}
fn one<'a>(records: &'a [Value], kind: &str) -> &'a Value {
    let selected: Vec<_> = records
        .iter()
        .filter(|record| record["fact"]["kind"] == kind)
        .collect();
    assert_eq!(selected.len(), 1, "one original {kind}: {records:?}");
    selected[0]
}

#[expect(
    clippy::too_many_arguments,
    reason = "Test resources stay separately owned for exact process cleanup after a fault"
)]
async fn body(
    producer: Producer,
    retry_workspace: bool,
    sandbox: &Sandbox,
    hosts: &mut Vec<Host>,
    clients: &mut Vec<Client>,
    inspectors: &mut Vec<(Child, ChildStdout)>,
    model: &Arc<Model>,
    events: &mut mpsc::UnboundedReceiver<&'static str>,
    base: &str,
) -> Result<()> {
    // Seed before the Host's public catalog refresh can advance the fixture's CAS revision.
    let connection = {
        let root = sandbox.root.clone();
        let owner = tokio::task::spawn_blocking(move || {
            RootOwner::create(&root, &RootNamespaces::for_current_account()?)
        })
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
        let store = ConfigurationStore::for_root(Arc::new(owner))
            .await
            .map_err(|error| error.to_string())?;
        let mut draft = json!({"slug":"producer","name":"Producer loopback",
            "provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"openai-compatible"},
            "configuration":{"baseUrl":base},"enabled":true,"enabledModelIds":["gpt-4.1"],
            "modelOverrides":{"gpt-4.1":{"codeMode":false,"apiProtocol":"openai-chat-completions"}}
        });
        if matches!(
            producer,
            Producer::Goal {
                pending_steering: true
            }
        ) {
            // This connection cannot interrupt a model stream to apply steering.
            draft["requestBodyOverlay"] = json!({"temperature":0});
        }
        let created = store
            .create_connection(
                serde_json::from_value(json!({"expectedCatalogRevision":0,"connection":draft}))
                    .unwrap(),
            )
            .await;
        let closed = store.shutdown().await;
        let created = created.map_err(|error| error.to_string())?;
        closed.map_err(|error| error.to_string())?;
        match created {
            CatalogMutationResult::Committed {
                connection: Some(basis),
                ..
            } => basis.connection_id,
            other => return Err(format!("fixture connection was not committed: {other:?}")),
        }
    };
    let journal = phase("external Journal", Journal::open(&sandbox.journal)).await?;
    hosts.push(Host::spawn(sandbox)?);
    let (first, _) = phase("actual default Host ready", hosts[0].ready()).await?;
    let epoch = first.epoch();
    let source = first.source().clone();
    clients.push(Client::new(first, journal, "receipts".into())?);
    let client = &clients[0];
    let detail = phase(
        "credential target",
        client.query("settings", "connection", json!({"connectionId":connection})),
    )
    .await?;
    assert_eq!(detail["kind"], "ready");
    let secret: Arc<dyn ReadResource> = Arc::new(FixtureKey);
    let saved = mutate(
        client,
        "settings",
        "saveCredential",
        json!({"expected":detail["target"],"expectedCredential":null}),
        Attachments::from([("secret".into(), secret)]),
    )
    .await?;
    assert_eq!(saved["kind"], "saved");
    let tool = match producer {
        Producer::Goal { .. } | Producer::GoalBudget => "GoalStatus",
        Producer::Scheduler | Producer::Automation => "ScheduledTask",
    };
    let created = mutate(client, "agent", "create", json!({"title":"Producer crash acceptance","automaticTitle":false,"labels":[],"tools":[tool],
        "workspace":{"kind":"directory","path":sandbox.workspace},
        "backend":{"kind":"model","connectionId":connection,"modelId":"gpt-4.1","thinkingLevel":null}}), Attachments::new()).await?;
    assert_eq!(created["kind"], "created");
    let parent = created["session"]["id"].as_str().unwrap().to_owned();
    let observed = query(client, "observe", json!({"sessionId":parent})).await?;
    let session_dto = &observed["session"];
    assert_eq!(session_dto["id"], parent);
    let target = json!({"sessionId":session_dto["id"],"workspace":session_dto["workspace"],"permissions":session_dto["permissions"],
        "boundaryRevision":session_dto["boundaryRevision"],"binding":session_dto["binding"]});
    let approval = json!({"target":target,"model":{"connectionId":connection,"modelId":"gpt-4.1"},"thinkingLevel":null});
    if matches!(producer, Producer::Automation) {
        return automation_delivery(
            client, &parent, target, connection, sandbox, model, events, base,
        )
        .await;
    }
    if matches!(producer, Producer::GoalBudget) {
        let created = mutate(
            client,
            "agent",
            "changeGoal",
            json!({
                "kind":"create","sessionId":parent,"objective":model.marker,
                "tokenBudget":110,"start":true,"approval":approval
            }),
            Attachments::new(),
        )
        .await?;
        assert_eq!(created["kind"], "committed");
        let id = created["goalId"].as_str().unwrap().to_owned();
        let mut epochs = vec![epoch];
        let mut executions: Vec<(String, Value)> = Vec::new();
        // Both faults follow settled iterations, not an accounting commit seam.
        for iteration in 1..=2usize {
            let client = &clients[iteration - 1];
            let message = format!("m_goal-{id}-{iteration}");
            let mut last_goal = Value::Null;
            let settled = phase("finite Goal reaches its cumulative budget", async {
                loop {
                    let goal = query(client, "goal", json!({"sessionId":parent})).await?;
                    last_goal = goal.clone();
                    assert_eq!(goal["enabled"], true);
                    let current = &goal["current"];
                    assert!(matches!(
                        current["status"].as_str(),
                        Some("active" | "budget_limited")
                    ));
                    if current["status"] == "budget_limited" && current["pending"] == false {
                        return Ok(current.clone());
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await.map_err(|error| format!(
                "{error}; iteration={iteration}; lastGoal={last_goal}; requests={}; producerRequests={}",
                model.requests.load(Ordering::SeqCst), model.producer_requests.load(Ordering::SeqCst)
            ))?;
            let budget = 110 * iteration;
            assert_eq!(settled["id"], id);
            assert_eq!(settled["objective"], model.marker);
            assert_eq!(settled["iterations"], iteration);
            assert_eq!(settled["tokenBudget"], budget);
            assert_eq!(settled["consumed"], json!({"known":budget,"missing":0}));
            assert_eq!(settled["remainingTokens"], 0);
            let completed = work(client, &parent, &message, Some("completed"), Some(model)).await?;
            assert_eq!(completed["sessionId"], parent);
            assert!(
                executions
                    .iter()
                    .all(|(_, prior)| prior["runId"] != completed["runId"])
            );
            executions.push((message, completed));
            assert_eq!(model.requests.load(Ordering::SeqCst), iteration);
            assert_eq!(model.producer_requests.load(Ordering::SeqCst), iteration);
            phase("finite Goal SDK close ACK before crash", client.close()).await?;
            phase(
                "finite Goal Host SIGKILL/wait/EOF",
                hosts[iteration - 1].sigkill(),
            )
            .await?;
            let journal = phase(
                "finite Goal independent reopened Journal",
                Journal::open(
                    &sandbox
                        .directory
                        .path()
                        .join(format!("budget-client-{iteration}.db")),
                ),
            )
            .await?;
            hosts.push(Host::spawn(sandbox)?);
            let (next, _) = phase(
                "finite Goal same Root new Host ready",
                hosts[iteration].ready(),
            )
            .await?;
            let next_epoch = next.epoch();
            assert!(epochs.iter().all(|epoch| *epoch != next_epoch));
            assert_eq!(next.source(), &source);
            epochs.push(next_epoch);
            clients.push(Client::new(next, journal, "receipts".into())?);
            let client = &clients[iteration];
            let reopened = query(client, "goal", json!({"sessionId":parent})).await?;
            assert_eq!(reopened["enabled"], true);
            assert_eq!(reopened["current"], settled);
            for (message, original) in &executions {
                assert_eq!(
                    work(client, &parent, message, Some("completed"), Some(model)).await?,
                    *original
                );
            }
            let next_message = format!("m_goal-{id}-{}", iteration + 1);
            let undispatched = query(
                client,
                "work",
                json!({
                    "sessionId":parent,"target":{"kind":"message","messageId":next_message}
                }),
            )
            .await?;
            assert_eq!(undispatched["kind"], "missing");
            assert_eq!(model.requests.load(Ordering::SeqCst), iteration);
            assert_eq!(model.producer_requests.load(Ordering::SeqCst), iteration);
            assert_eq!(
                model.eof.load(Ordering::SeqCst),
                0,
                "finite streams are not held across faults"
            );
            if iteration == 1 {
                let changed = mutate(client, "agent", "changeGoal", json!({
                    "kind":"control","sessionId":parent,"goalId":id,"revision":reopened["current"]["revision"],
                    "action":"set_budget","budget":{"tokenBudget":220}
                }), Attachments::new()).await?;
                assert_eq!(changed["kind"], "committed");
                assert_eq!(changed["goalId"], id);
                let enlarged = query(client, "goal", json!({"sessionId":parent})).await?;
                let current = &enlarged["current"];
                assert_eq!(current["id"], id);
                assert_eq!(current["revision"], changed["revision"]);
                assert_eq!(current["status"], "budget_limited");
                assert_eq!(current["iterations"], 1);
                assert_eq!(current["pending"], false);
                assert_eq!(current["tokenBudget"], 220);
                assert_eq!(current["consumed"], settled["consumed"]);
                assert_eq!(current["remainingTokens"], 110);
                assert_eq!(
                    query(
                        client,
                        "work",
                        json!({
                            "sessionId":parent,"target":{"kind":"message","messageId":next_message}
                        })
                    )
                    .await?["kind"],
                    "missing"
                );
                assert_eq!(model.requests.load(Ordering::SeqCst), 1);
                let observed = query(client, "observe", json!({"sessionId":parent})).await?;
                let session_dto = &observed["session"];
                assert_eq!(session_dto["id"], parent);
                let target = json!({"sessionId":session_dto["id"],"workspace":session_dto["workspace"],
                    "permissions":session_dto["permissions"],"boundaryRevision":session_dto["boundaryRevision"],
                    "binding":session_dto["binding"]});
                let renewed = json!({"target":target,"model":{"connectionId":connection,"modelId":"gpt-4.1"},
                    "thinkingLevel":null});
                let resumed = mutate(client, "agent", "changeGoal", json!({
                    "kind":"control","sessionId":parent,"goalId":id,"revision":current["revision"],
                    "action":"resume","approval":renewed
                }), Attachments::new()).await?;
                assert_eq!(resumed["kind"], "committed");
                assert_eq!(resumed["goalId"], id);
            }
        }
        return Ok(());
    }
    let (domain_id, session, message) = match producer {
        Producer::Goal { .. } | Producer::GoalBudget => {
            let result = mutate(
                client,
                "agent",
                "changeGoal",
                json!({"kind":"create","sessionId":parent,"objective":model.marker,
                "tokenBudget":null,"start":true,"approval":approval}),
                Attachments::new(),
            )
            .await?;
            assert_eq!(result["kind"], "committed");
            let id = result["goalId"].as_str().unwrap().to_owned();
            let message = format!("m_goal-{id}-1");
            (id, parent.clone(), message)
        }
        Producer::Automation => unreachable!(),
        Producer::Scheduler => {
            let sent = mutate(
                client,
                "agent",
                "send",
                json!({"sessionId":parent,"message":model.bootstrap,"delivery":"queue"}),
                Attachments::new(),
            )
            .await?;
            assert_eq!(sent["kind"], "queued");
            work(
                client,
                &parent,
                sent["messageId"].as_str().unwrap(),
                Some("completed"),
                Some(model.as_ref()),
            )
            .await?;
            assert_eq!(*model.bootstrap_step.lock().unwrap(), 3);
            assert_eq!(model.producer_requests.load(Ordering::SeqCst), 0);
            let page = query(client, "schedules", json!({"kind":"list"})).await?;
            assert_eq!(page["kind"], "page");
            assert!(page["nextCursor"].is_null());
            let tasks = page["tasks"].as_array().unwrap();
            assert_eq!(tasks.len(), 1);
            let id = tasks[0]["id"].as_str().unwrap().to_owned();
            let created = schedule(client, &id).await?;
            assert_eq!(
                created["task"]["createdBy"],
                json!({"kind":"agent","sessionId":parent})
            );
            assert_eq!(created["task"]["status"], "active");
            assert_eq!(created["task"]["fireCount"], 0);
            assert_eq!(created["task"]["runs"], json!([]));
            assert!(created["pendingFire"].is_null());
            let retry_fire = if retry_workspace {
                let held = sandbox.home.join("workspace-unavailable");
                tokio::fs::rename(&sandbox.workspace, &held)
                    .await
                    .map_err(|e| e.to_string())?;
                let pending = phase("claim while workspace is unavailable", async {
                    loop {
                        let detail = schedule(client, &id).await?;
                        if let Some(fire) = detail["pendingFire"].as_str() {
                            break Ok(fire.to_owned());
                        }
                        tokio::task::yield_now().await;
                    }
                })
                .await?;
                // Deliberate fault duration: keep the workspace absent across the
                // claim's own notification and the first timed retry. Reads do not wake it.
                tokio::time::sleep(Duration::from_secs(3)).await;
                let blocked = schedule(client, &id).await?;
                assert_eq!(blocked["pendingFire"], pending);
                assert_eq!(blocked["task"]["fireCount"], 0);
                assert_eq!(model.producer_requests.load(Ordering::SeqCst), 0);
                // Restore the same directory identity without a Host mutation or wake.
                tokio::fs::rename(&held, &sandbox.workspace)
                    .await
                    .map_err(|e| e.to_string())?;
                Some(pending)
            } else {
                None
            };
            // No triggerNow or clock injection. Wait for actual due and Message-admitted settlement.
            let settled = phase("actual due and one settled Fire", async {
                loop {
                    let detail = schedule(client, &id).await?;
                    if detail["task"]["status"] == "completed" {
                        break Ok(detail);
                    }
                    assert_eq!(detail["task"]["status"], "active");
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await?;
            let task = &settled["task"];
            assert_eq!(task["maxFires"], 1);
            assert_eq!(task["fireCount"], 1);
            let fires = task["runs"].as_array().unwrap();
            assert_eq!(fires.len(), 1);
            let fire = &fires[0];
            if let Some(original) = retry_fire {
                assert_eq!(fire["id"], original);
            }
            assert_eq!(fire["outcome"], "ok");
            assert_eq!(fire["message"], "Message admitted");
            let message = format!(
                "m_{}",
                hex::encode(Sha256::digest(fire["id"].as_str().unwrap().as_bytes()))
            );
            (id, fire["sessionId"].as_str().unwrap().to_owned(), message)
        }
    };
    let accepted = phase("external physical model accept", async {
        match events.recv().await {
            Some("accepted") => Ok(()),
            other => Err(format!("expected producer accept: {other:?}")),
        }
    })
    .await;
    if let Err(error) = accepted {
        if matches!(producer, Producer::Goal { .. })
            && error == "deadline: external physical model accept"
        {
            eprintln!("{error}");
            let snapshot = model_accept_snapshot(client, &session, &message, model).await;
            return Err(format!("{error}; modelAcceptSnapshot={snapshot}"));
        }
        return Err(error);
    }
    assert_eq!(model.producer_requests.load(Ordering::SeqCst), 1);
    let original = work(client, &session, &message, None, None).await?;
    assert!(
        matches!(
            original["state"]["kind"].as_str(),
            Some("running" | "waiting")
        ),
        "{original}"
    );
    let run = original["runId"].clone();
    let user = user_message(client, &session, &message, &run).await?;
    let scheduled = match producer {
        Producer::Goal { .. } | Producer::GoalBudget => {
            assert_eq!(user["origin"]["kind"], "goal");
            assert_eq!(user["origin"]["goalId"], domain_id);
            let goal = query(client, "goal", json!({"sessionId":session})).await?;
            assert_eq!(goal["enabled"], true);
            assert_eq!(goal["current"]["id"], domain_id);
            assert_eq!(goal["current"]["iterations"], 1);
            assert_eq!(goal["current"]["pending"], true);
            assert_eq!(goal["current"]["status"], "active");
            assert!(
                goal["current"]["consumed"]["missing"].as_u64().unwrap() > 0,
                "unfinished usage must be reported as missing"
            );
            None
        }
        Producer::Automation => unreachable!(),
        Producer::Scheduler => {
            assert_eq!(
                user["origin"],
                json!({
                    "kind":"automation", "automationId":domain_id, "title":"Agent-created one-fire acceptance"
                })
            );
            assert_ne!(session, parent);
            let child = query(client, "observe", json!({"sessionId":session})).await?;
            assert_eq!(child["session"]["parentSessionId"], parent);
            let detail = schedule(client, &domain_id).await?;
            assert_eq!(detail["task"]["runs"][0]["runId"], run);
            assert!(detail["pendingFire"].is_null());
            Some(detail)
        }
    };
    let correction = if matches!(
        producer,
        Producer::Goal {
            pending_steering: true
        }
    ) {
        let queued = mutate(
            client,
            "agent",
            "send",
            json!({"sessionId":session,"message":RECOVERY_STEERING,"delivery":"steer","expectedRunId":run}),
            Attachments::new(),
        )
        .await?;
        assert_eq!(queued["kind"], "queued", "{queued}");
        let queue = query(client, "queue", json!({"sessionId":session})).await?;
        assert_eq!(queue["entries"][0]["kind"], "steering", "{queue}");
        assert_eq!(queue["entries"][0]["messageId"], queued["messageId"]);
        Some(queued["messageId"].as_str().unwrap().to_owned())
    } else {
        None
    };
    phase("first client close before Host fault", clients[0].close()).await?;
    assert_eq!(model.producer_requests.load(Ordering::SeqCst), 1);
    assert_eq!(
        model.eof.load(Ordering::SeqCst),
        0,
        "closing the SDK observer must leave the original model connection open"
    );
    phase(
        "first Host SIGKILL and physical wait/EOF",
        hosts[0].sigkill(),
    )
    .await?;
    phase("original model socket EOF", async {
        match events.recv().await {
            Some("eof") => Ok(()),
            other => Err(format!("expected physical producer EOF: {other:?}")),
        }
    })
    .await?;
    assert_eq!(model.eof.load(Ordering::SeqCst), 1);
    let before = records(&inspect(sandbox, &session, inspectors).await?);
    assert!(before.iter().all(|record| record["run"] == run));
    let admitted = one(&before, "run_admitted").clone();
    assert_eq!(admitted["run"], run);
    let original_spec: ContentRef = serde_json::from_value(admitted["fact"]["spec"].clone())
        .map_err(|error| error.to_string())?;
    original_spec.validate().map_err(str::to_owned)?;
    one(&before, "model_attempt_prepared");
    assert_eq!(
        one(&before, "model_attempt_admitted")["fact"]["attempt"],
        one(&before, "model_attempt_prepared")["fact"]["attempt"]
    );
    one(&before, "step_prepared");
    assert!(!before.iter().any(|record| matches!(
        record["fact"]["kind"].as_str(),
        Some(
            "model_observed"
                | "model_closed"
                | "model_interrupted"
                | "stop_requested"
                | "run_terminated"
        )
    )));

    let journal = phase(
        "second external Journal",
        Journal::open(&sandbox.directory.path().join("reopened-client.db")),
    )
    .await?;
    hosts.push(Host::spawn(sandbox)?);
    let (second, _) = phase("new Host same Root ready", hosts[1].ready()).await?;
    let second_epoch = second.epoch();
    let second_source = second.source().clone();
    clients.push(Client::new(second, journal, "receipts".into())?);
    assert_ne!(second_epoch, epoch);
    assert_eq!(second_source, source);
    let client = &clients[1];
    let recovered = work(client, &session, &message, Some("failed"), None).await?;
    assert_eq!(recovered["runId"], run);
    assert_eq!(recovered["turnId"], original["turnId"]);
    assert_eq!(recovered["state"]["reason"]["kind"], "unsupported_protocol");
    let by_run = query(
        client,
        "execution",
        json!({"sessionId":session,"runId":run}),
    )
    .await?;
    assert_eq!(by_run["kind"], "found");
    assert_eq!(by_run["execution"], recovered);
    let successors = match producer {
        Producer::Goal { .. } => {
            let mut successors = Vec::new();
            if let Some(correction) = &correction {
                let corrected = work(client, &session, correction, Some("completed"), None).await?;
                assert_ne!(corrected["runId"], run);
                successors.push(corrected["runId"].clone());
            }
            phase("Goal completes a second iteration after recovery", async {
                loop {
                    let goal = query(client, "goal", json!({"sessionId":session})).await?;
                    let current = &goal["current"];
                    assert_eq!(current["id"], domain_id);
                    assert!(
                        current["iterations"]
                            .as_u64()
                            .is_some_and(|count| count <= 2)
                    );
                    if current["status"] == "achieved" && current["pending"] == false {
                        return Ok(());
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await?;
            let next_message = format!("m_goal-{domain_id}-2");
            let next = work(client, &session, &next_message, Some("completed"), None).await?;
            successors.push(next["runId"].clone());
            successors
        }
        Producer::GoalBudget | Producer::Automation => unreachable!(),
        Producer::Scheduler => {
            assert_eq!(user_message(client, &session, &message, &run).await?, user);
            assert_eq!(schedule(client, &domain_id).await?, scheduled.unwrap());
            let child = query(client, "observe", json!({"sessionId":session})).await?;
            assert_eq!(child["session"]["parentSessionId"], parent);
            let children = query(client, "list", json!({"filter":"all","position":{"kind":"start"},"scope":{"kind":"children","sessionId":parent}})).await?;
            let children = children["sessions"].as_array().unwrap();
            assert_eq!(children.len(), 1);
            assert_eq!(children[0]["id"], session);
            vec![]
        }
    };
    // Leave failed history for the existing read-only inspector, without a
    // test Root/SQL writer or a live Root fence.
    phase("second client close before Host fault", clients[1].close()).await?;
    phase("second Host kill/wait/EOF", hosts[1].sigkill()).await?;
    let after = records(&inspect(sandbox, &session, inspectors).await?);
    assert!(
        after.starts_with(&before),
        "recovery must append to original history"
    );
    let admitted_runs: Vec<_> = after
        .iter()
        .filter(|record| record["fact"]["kind"] == "run_admitted")
        .map(|record| &record["run"])
        .collect();
    assert_eq!(
        admitted_runs,
        std::iter::once(&run)
            .chain(successors.iter())
            .collect::<Vec<_>>()
    );
    let after: Vec<_> = after
        .into_iter()
        .filter(|record| record["run"] == run)
        .collect();
    assert_eq!(one(&after, "run_admitted"), &admitted);
    let reopened_spec: ContentRef =
        serde_json::from_value(one(&after, "run_admitted")["fact"]["spec"].clone())
            .map_err(|error| error.to_string())?;
    reopened_spec.validate().map_err(str::to_owned)?;
    assert_eq!(reopened_spec, original_spec);
    assert_eq!(one(&after, "step_prepared"), one(&before, "step_prepared"));
    assert_eq!(
        one(&after, "model_attempt_prepared"),
        one(&before, "model_attempt_prepared")
    );
    assert_eq!(
        one(&after, "model_attempt_admitted"),
        one(&before, "model_attempt_admitted")
    );
    if correction.is_some() {
        assert_eq!(
            one(&after, "blocked")["fact"]["reason"]["protocol"],
            "maka.native-model-input/provider-effects-or-unproved-adapter"
        );
    } else {
        let interrupted = one(&after, "model_interrupted");
        let recovery = one(&after, "attempt_recovery_recorded");
        assert_eq!(recovery["fact"]["recovery"]["kind"], "blocked");
        assert_eq!(interrupted["fact"]["attempt"], recovery["fact"]["attempt"]);
        assert_eq!(
            recovery["fact"]["attempt"],
            one(&before, "model_attempt_prepared")["fact"]["attempt"]
        );
    }
    assert_eq!(one(&after, "run_terminated")["fact"]["terminal"], "failed");
    assert!(!after.iter().any(|record| matches!(
        record["fact"]["kind"].as_str(),
        Some("model_observed" | "model_closed" | "retry_charged" | "stop_requested")
    )));
    Ok(())
}

async fn acceptance(producer: Producer, retry_workspace: bool) {
    let sandbox = Sandbox::new()
        .await
        .expect("owned empty Root/HOME/workspace");
    let nonce = Uuid::new_v4().simple().to_string();
    let model = Arc::new(Model {
        producer,
        marker: format!("producer-{nonce}"),
        bootstrap: format!("schedule-{nonce}"),
        bootstrap_step: Mutex::new(0),
        requests: AtomicUsize::new(0),
        producer_requests: AtomicUsize::new(0),
        eof: AtomicUsize::new(0),
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let (events, mut observations) = mpsc::unbounded_channel();
    let stop = CancellationToken::new();
    let connections = Arc::new(tokio::sync::Mutex::new(JoinSet::new()));
    let mut server = tokio::spawn(serve(
        listener,
        model.clone(),
        events,
        stop.clone(),
        connections.clone(),
    ));
    let mut server_collected = false;
    let mut hosts = Vec::new();
    let mut clients = Vec::new();
    let mut inspectors = Vec::new();
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(150), async {
        tokio::select! {
            result = body(producer, retry_workspace, &sandbox, &mut hosts, &mut clients, &mut inspectors, &model, &mut observations, &base) => result,
            result = &mut server => { server_collected = true; Err(format!("model accept task ended: {result:?}")) },
        }
    })).catch_unwind().await;
    let mut cleanup = Vec::new();
    for client in &clients {
        if let Err(error) = phase("owned SDK close", client.close()).await {
            cleanup.push(error);
        }
    }
    for process in &mut hosts {
        if let Err(error) = phase("owned Host cleanup kill/wait/EOF", process.cleanup()).await {
            cleanup.push(error);
        }
    }
    for (child, stdout) in &mut inspectors {
        if let Err(error) = phase("owned inspector kill/wait/EOF", async {
            if child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_none()
            {
                child.start_kill().map_err(|error| error.to_string())?;
            }
            let mut tail = Vec::new();
            match tokio::join!(stdout.read_to_end(&mut tail), child.wait()) {
                (Ok(_), Ok(_)) => Ok(()),
                other => Err(format!("inspector cleanup: {other:?}")),
            }
        })
        .await
        {
            cleanup.push(error);
        }
    }
    stop.cancel();
    if !server_collected {
        match tokio::time::timeout(Duration::from_secs(30), &mut server).await {
            Ok(Ok(Ok(()))) => {}
            Ok(other) => cleanup.push(format!("model accept task join: {other:?}")),
            Err(error) => {
                cleanup.push(format!("model accept task deadline: {error}"));
                server.abort();
                cleanup.push(format!(
                    "model accept task aborted and joined: {:?}",
                    server.await
                ));
            }
        }
    }
    let mut connections = connections.lock().await;
    let drained = tokio::time::timeout(Duration::from_secs(30), async {
        while let Some(joined) = connections.join_next().await {
            if !matches!(joined, Ok(Ok(()))) {
                cleanup.push(format!("model connection join: {joined:?}"));
            }
        }
    })
    .await;
    if drained.is_err() {
        cleanup.push("model connection drain deadline".into());
        connections.abort_all();
        while let Some(joined) = connections.join_next().await {
            cleanup.push(format!("model connection after abort/join: {joined:?}"));
        }
    }
    match outcome {
        Ok(Ok(Ok(()))) => {
            assert!(cleanup.is_empty(), "{cleanup:?}");
            if matches!(producer, Producer::Automation) {
                assert_eq!(model.producer_requests.load(Ordering::SeqCst), 4);
                return;
            }
            let (requests, producer_requests, eof) = match producer {
                Producer::Goal { pending_steering } => {
                    let count = 3 + usize::from(pending_steering);
                    (count, count, 1)
                }
                Producer::Scheduler => (4, 1, 1),
                Producer::Automation => unreachable!(),
                Producer::GoalBudget => (2, 2, 0),
            };
            assert_eq!(model.requests.load(Ordering::SeqCst), requests);
            assert_eq!(
                model.producer_requests.load(Ordering::SeqCst),
                producer_requests
            );
            assert_eq!(model.eof.load(Ordering::SeqCst), eof);
        }
        Ok(Ok(Err(error))) => panic!("producer acceptance: {error}; cleanup={cleanup:?}"),
        Ok(Err(error)) => panic!("bounded producer acceptance: {error}; cleanup={cleanup:?}"),
        Err(panic) => {
            eprintln!("producer cleanup: {cleanup:?}");
            std::panic::resume_unwind(panic);
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn goal_continues_in_a_new_iteration_after_original_run_fails_on_reopen() {
    acceptance(
        Producer::Goal {
            pending_steering: false,
        },
        false,
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn goal_continues_after_failed_run_delivers_queued_steering_as_followup() {
    acceptance(
        Producer::Goal {
            pending_steering: true,
        },
        false,
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn scheduler_agent_created_due_fire_fails_original_run_without_redispatch_after_reopen() {
    acceptance(Producer::Scheduler, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn finite_goal_budget_remains_cumulative_across_two_host_reopens() {
    acceptance(Producer::GoalBudget, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn scheduler_retries_original_fire_when_workspace_returns_without_host_mutation() {
    acceptance(Producer::Scheduler, true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn scheduler_delivers_script_as_steering_and_timer_as_followup() {
    acceptance(Producer::Automation, false).await;
}

#[expect(
    clippy::too_many_arguments,
    reason = "The fixture keeps its independent resources borrowed"
)]
async fn automation_delivery(
    client: &Client,
    session: &str,
    target: Value,
    connection: String,
    sandbox: &Sandbox,
    model: &Model,
    events: &mut mpsc::UnboundedReceiver<&'static str>,
    base: &str,
) -> Result<()> {
    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    }
    let fire_message_id = |run: &Value| {
        format!(
            "m_{}",
            hex::encode(Sha256::digest(run["id"].as_str().unwrap().as_bytes()))
        )
    };
    let condition = sandbox.workspace.join("status.txt");
    tokio::fs::write(&condition, "waiting")
        .await
        .map_err(|e| e.to_string())?;
    tokio::fs::write(
        sandbox.workspace.join("readiness.ts"),
        r#"import { readFile } from "node:fs/promises";
           export async function ready(): Promise<boolean> { return (await readFile("status.txt", "utf8")).trim() === "ready"; }"#,
    )
    .await
    .map_err(|e| e.to_string())?;
    let sent = mutate(
        client,
        "agent",
        "send",
        json!({"sessionId":session,"message":model.bootstrap,"delivery":"queue"}),
        Attachments::new(),
    )
    .await?;
    let message = sent["messageId"]
        .as_str()
        .ok_or("original message missing")?;
    phase("busy original model request", async {
        assert_eq!(events.recv().await, Some("accepted"));
        Ok(())
    })
    .await?;
    let original = work(client, session, message, None, None).await?;
    let create =
        |title: &'static str, delivery: &'static str, schedule: Value, expires_at: Option<u64>| {
            let target = target.clone();
            let connection = connection.clone();
            async move {
                let created = mutate(
                client,
                "agent",
                "schedule",
                json!({"kind":"create","input":{
                    "timezone":"UTC","misfire":"skip","task":{
                        "title":title,"intentBody":title,"schedule":schedule,"expiresAt":expires_at,
                        "effect":{"kind":"session","delivery":delivery,"target":target,
                            "model":{"connectionId":connection,"modelId":"gpt-4.1"}}
                    }
                }}),
                Attachments::new(),
            )
            .await?;
                assert_eq!(created["kind"], "committed", "{created}");
                created["taskId"]
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| "automation missing ID".to_string())
            }
        };
    let followup = create(
        "AUTOMATION-FOLLOWUP",
        "followup",
        json!({"kind":"once","runAt":now_ms()+800}),
        None,
    )
    .await?;
    let expiry_start = now_ms();
    let expiring = create(
        "AUTOMATION-EXPIRING",
        "followup",
        json!({"kind":"once","runAt":expiry_start+400}),
        Some(expiry_start + 2_500),
    )
    .await?;
    let blocked = create(
        "AUTOMATION-BLOCKED-IMPORT",
        "steering",
        json!({"kind":"script","everySeconds":1,"startAt":now_ms()+100,
            "source":format!("import {{ ready }} from \"{base}/condition.ts\"; console.log(ready);")
        }),
        None,
    )
    .await?;
    let steering = create(
        "AUTOMATION-STEERING",
        "steering",
        json!({"kind":"script","everySeconds":1,
            "startAt":now_ms()+100,
            "source":"import { ready } from './readiness.ts'; console.log(await ready());"
        }),
        None,
    )
    .await?;
    let editing = schedule(client, &steering).await?;
    let next_check = editing["task"]["nextFireAt"].as_i64().unwrap();
    let wait = |id: String, count: u64| async move {
        phase("automation delivered to the conversation", async {
            loop {
                let task = schedule(client, &id).await?;
                if task["task"]["fireCount"] == count {
                    return Ok(task);
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await
    };
    phase("follow-up waits and false script does not fire", async {
        loop {
            let denied = schedule(client, &blocked).await?;
            assert_eq!(denied["task"]["fireCount"], 0, "{denied}");
            let queued = schedule(client, &followup).await?;
            let checked = schedule(client, &steering).await?;
            assert!(checked["task"]["lastError"].is_null(), "{checked}");
            if queued["pendingFire"].is_string()
                && checked["task"]["nextFireAt"].as_i64().unwrap() > next_check
                && let Some(error) = denied["task"]["lastError"].as_str()
            {
                assert!(error.contains("/condition.ts"), "{error}");
                assert_eq!(queued["task"]["fireCount"], 0);
                assert_eq!(checked["task"]["fireCount"], 0);
                assert_eq!(model.producer_requests.load(Ordering::SeqCst), 1);
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await?;
    let edited = mutate(
        client,
        "agent",
        "schedule",
        json!({"kind":"update","taskId":steering,"revision":editing["revision"],"input":{
            "timezone":"UTC","misfire":"skip","task":{
                "title":"Updated script name","intentBody":"AUTOMATION-STEERING",
                "schedule":editing["task"]["schedule"],"effect":editing["task"]["effect"]
            }
        }}),
        Attachments::new(),
    )
    .await?;
    assert_eq!(
        edited["kind"], "committed",
        "a background check must not invalidate an open editor: {edited}"
    );
    let expired = wait(expiring, 1).await?;
    assert_eq!(expired["task"]["status"], "expired");
    assert_eq!(
        expired["task"]["runs"][0]["message"],
        "Automation expired before delivery"
    );
    assert_eq!(model.producer_requests.load(Ordering::SeqCst), 1);
    tokio::fs::write(&condition, "ready")
        .await
        .map_err(|e| e.to_string())?;
    let steered = wait(steering.clone(), 1).await?;
    assert_eq!(steered["task"]["runs"][0]["runId"], original["runId"]);
    assert_eq!(
        steered["task"]["runs"][0]["message"],
        "Message delivered as steering"
    );
    let delivered = query(
        client,
        "work",
        json!({"sessionId":session,"target":{"kind":"message",
            "messageId":fire_message_id(&steered["task"]["runs"][0])}}),
    )
    .await?;
    assert_eq!(delivered["kind"], "delivered");
    assert_eq!(delivered["shared"], true);
    assert_eq!(delivered["execution"]["runId"], original["runId"]);
    assert_eq!(delivered["execution"]["turnId"], original["turnId"]);
    let queued = wait(followup, 1).await?;
    let queued_run = &queued["task"]["runs"][0];
    assert_ne!(queued_run["runId"], original["runId"]);
    assert_eq!(queued_run["message"], "Message admitted");
    // A fire settles at admission; finish the timer Run before the next script edge.
    let completed = work(
        client,
        session,
        &fire_message_id(queued_run),
        Some("completed"),
        Some(model),
    )
    .await?;
    assert_eq!(completed["runId"], queued_run["runId"]);
    let mut check_after = steered["task"]["nextFireAt"].as_i64().unwrap();
    for state in ["ready", "waiting"] {
        tokio::fs::write(&condition, state)
            .await
            .map_err(|e| e.to_string())?;
        check_after = phase("advance script check without another message", async {
            loop {
                let task = schedule(client, &steering).await?;
                assert_eq!(task["task"]["fireCount"], 1, "{task}");
                assert!(task["task"]["lastError"].is_null(), "{task}");
                let next = task["task"]["nextFireAt"].as_i64().unwrap();
                if next > check_after {
                    return Ok(next);
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await?;
    }
    tokio::fs::write(&condition, "ready")
        .await
        .map_err(|e| e.to_string())?;
    let again = wait(steering, 2).await?;
    let latest = &again["task"]["runs"][0];
    assert_eq!(latest["message"], "Message admitted");
    assert_ne!(latest["runId"], original["runId"]);
    assert_ne!(latest["runId"], queued_run["runId"]);
    let completed = work(
        client,
        session,
        &fire_message_id(latest),
        Some("completed"),
        Some(model),
    )
    .await?;
    assert_eq!(completed["runId"], latest["runId"]);
    let observed = query(client, "observe", json!({"sessionId":session})).await?;
    let changed = mutate(
        client,
        "agent",
        "metadata",
        json!({"sessionId":session,"expectedRevision":observed["session"]["revision"],
            "title":observed["session"]["title"],"labels":[],
            "permissions":{"settings":{"access":"danger_full_access","requestPermissions":true},"revokeGrants":false}}),
        Attachments::new(),
    )
    .await?;
    assert_eq!(changed["kind"], "committed", "{changed}");
    let session = &changed["session"];
    let posted = mutate(
        client,
        "agent",
        "schedule",
        json!({"kind":"create","input":{"timezone":"UTC","misfire":"skip","task":{
            "title":"POST check","intentBody":"AUTOMATION-FOLLOWUP-POST","maxFires":1,
            "schedule":{"kind":"script","everySeconds":1,"startAt":now_ms()+100,
                "source":format!("const response = await fetch(\"{base}/condition\", {{ method: 'POST', headers: {{ 'x-condition': 'ready' }}, body: 'check' }}); console.log(await response.json());")},
            "effect":{"kind":"session","delivery":"followup","model":{"connectionId":connection,"modelId":"gpt-4.1"},
                "target":{"sessionId":session["id"],"workspace":session["workspace"],"permissions":session["permissions"],
                    "boundaryRevision":session["boundaryRevision"],"binding":session["binding"]}}
        }}}),
        Attachments::new(),
    )
    .await?;
    assert_eq!(posted["kind"], "committed", "{posted}");
    let posted = wait(posted["taskId"].as_str().unwrap().to_owned(), 1).await?;
    assert_eq!(posted["task"]["status"], "completed", "{posted}");
    assert_eq!(
        posted["task"]["runs"][0]["message"], "Message admitted",
        "{posted}"
    );
    Ok(())
}
