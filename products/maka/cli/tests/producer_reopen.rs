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
use maka_app_client::{Client, Journal};
use maka_capabilities::call::{Attachments, ReadResource, ResourceEncoding};
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
    Goal,
    Scheduler,
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

struct Model {
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
        if request.method() != hyper::Method::POST
            || !request.uri().path().ends_with("/chat/completions")
        {
            return Err(format!(
                "unexpected model request: {} {}",
                request.method(),
                request.uri()
            ));
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
        let names = tools
            .iter()
            .map(|tool| {
                tool["function"]["name"]
                    .as_str()
                    .ok_or_else(|| "direct function name missing".to_string())
            })
            .collect::<Result<Vec<_>>>()?;
        eprintln!("producer model tool names: {names:?}");
        let has_user = |marker: &str| {
            messages.iter().any(|message| {
                message["role"] == "user" && message["content"].to_string().contains(marker)
            })
        };
        if has_user(&self.marker) {
            self.producer_requests.fetch_add(1, Ordering::SeqCst);
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
                scheduled_tool(
                    "proposal",
                    json!({"mode":"create","title":"Approved one-fire acceptance",
                    "intentBody":self.marker,"schedule":{"kind":"interval","everySeconds":1,"startAt":0},
                    "timezone":"UTC","misfire":"latest","effect":"agent_run","maxFires":1,"expiresAt":null}),
                )
            }
            2 => {
                let value: Value = serde_json::from_str(tool_text(messages, "proposal")?)
                    .map_err(|error| format!("direct proposal result JSON: {error}"))?;
                assert_eq!(value["approved"], false);
                assert!(value["taskId"].is_string());
                assert!(value["revision"].is_u64());
                scheduled_tool(
                    "unapproved-resume",
                    json!({"mode":"resume","taskId":value["taskId"],"revision":value["revision"]}),
                )
            }
            3 => {
                assert!(
                    tool_text(messages, "unapproved-resume")?
                        .contains("scheduler_user_approval_required"),
                    "actual unapproved resume must be rejected"
                );
                sse(
                    json!({"content":"Proposal saved; explicit user approval is still required."}),
                    "stop",
                )
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
                if let Err(error) = result {
                    if !(error.is_incomplete_message() || error.is_canceled() || error.is_closed())
                    {
                        return Err(format!("held model connection: {error}"));
                    }
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

async fn work(
    client: &Client,
    session: &str,
    message: &str,
    terminal: Option<&str>,
) -> Result<Value> {
    phase("original message to Run", async {
        loop {
            let value = query(
                client,
                "work",
                json!({"sessionId":session,"target":{"kind":"message","messageId":message}}),
            )
            .await?;
            match value["kind"].as_str() {
                Some("pending") => {}
                Some("delivered") => {
                    assert_eq!(value["shared"], false);
                    let state = value["execution"]["state"]["kind"].as_str().unwrap();
                    if terminal.is_none_or(|expected| state == expected) {
                        return Ok(value["execution"].clone());
                    }
                    assert!(
                        matches!(state, "admitted" | "running" | "waiting"),
                        "unexpected original Run: {value}"
                    );
                }
                _ => return Err(format!("original message unavailable: {value}")),
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
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
fn goal_identity(current: &Value) -> Value {
    assert_eq!(current["iterations"], 1);
    assert_eq!(current["pending"], true);
    assert_eq!(current["status"], "active");
    assert!(current["tokenBudget"].is_null());
    assert!(current["remainingTokens"].is_null());
    assert!(
        current["consumed"]["missing"].as_u64().unwrap() > 0,
        "unfinished usage is missing, not zero: {current}"
    );
    json!({"id":current["id"],"objective":current["objective"],"consumed":current["consumed"],
        "createdAt":current["createdAt"],"report":current["report"],"note":current["note"]})
}

async fn body(
    producer: Producer,
    sandbox: &Sandbox,
    hosts: &mut Vec<Host>,
    clients: &mut Vec<Client>,
    inspectors: &mut Vec<(Child, ChildStdout)>,
    model: &Arc<Model>,
    events: &mut mpsc::UnboundedReceiver<&'static str>,
    base: &str,
) -> Result<()> {
    let journal = phase("external Journal", Journal::open(&sandbox.journal)).await?;
    hosts.push(Host::spawn(sandbox)?);
    let (first, _) = phase("actual default Host ready", hosts[0].ready()).await?;
    let epoch = first.epoch();
    let source = first.source().clone();
    clients.push(Client::new(first, journal, "receipts".into())?);
    let client = &clients[0];
    let catalog = phase(
        "connection catalog",
        client.query("settings", "connections", json!({"kind":"start"})),
    )
    .await?;
    assert_eq!(catalog["kind"], "ready");
    let created = mutate(client, "settings", "create", json!({"expectedCatalogRevision":catalog["revision"],"connection":{
        "slug":"producer","name":"Producer loopback","provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"openai-compatible"},
        "configuration":{"baseUrl":base},"enabled":true,"enabledModelIds":["gpt-4.1"],
        "modelOverrides":{"gpt-4.1":{"codeMode":false,"apiProtocol":"openai-chat-completions"}}
    }}), Attachments::new()).await?;
    assert_eq!(created["kind"], "committed");
    let connection = created["connection"]["connectionId"].clone();
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
        Producer::Goal => "GoalStatus",
        Producer::Scheduler => "ScheduledTask",
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
    let (domain_id, session, message) = match producer {
        Producer::Goal => {
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
            )
            .await?;
            assert_eq!(*model.bootstrap_step.lock().unwrap(), 4);
            assert_eq!(model.producer_requests.load(Ordering::SeqCst), 0);
            let page = query(client, "schedules", json!({"kind":"list"})).await?;
            assert_eq!(page["kind"], "page");
            assert!(page["nextCursor"].is_null());
            let tasks = page["tasks"].as_array().unwrap();
            assert_eq!(tasks.len(), 1);
            let id = tasks[0]["id"].as_str().unwrap().to_owned();
            let proposal = schedule(client, &id).await?;
            assert_eq!(proposal["approved"], false);
            assert_eq!(
                proposal["task"]["createdBy"],
                json!({"kind":"agent","sessionId":parent})
            );
            assert_eq!(proposal["task"]["status"], "paused");
            assert_eq!(proposal["task"]["fireCount"], 0);
            assert_eq!(proposal["task"]["runs"], json!([]));
            assert!(proposal["pendingFire"].is_null());
            let approved = mutate(
                client,
                "agent",
                "schedule",
                json!({"kind":"approve","taskId":id,"revision":proposal["revision"]}),
                Attachments::new(),
            )
            .await?;
            assert_eq!(approved["kind"], "committed");
            // No triggerNow or clock injection. Wait for actual due and Message-admitted settlement.
            let settled = phase("actual due and one settled Fire", async {
                loop {
                    let detail = schedule(client, &id).await?;
                    assert_eq!(detail["approved"], true);
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
            assert_eq!(fire["outcome"], "ok");
            assert_eq!(fire["message"], "Message admitted");
            let message = format!(
                "m_{}",
                hex::encode(Sha256::digest(fire["id"].as_str().unwrap().as_bytes()))
            );
            (id, fire["sessionId"].as_str().unwrap().to_owned(), message)
        }
    };
    phase("external physical model accept", async {
        match events.recv().await {
            Some("accepted") => Ok(()),
            other => Err(format!("expected producer accept: {other:?}")),
        }
    })
    .await?;
    assert_eq!(model.producer_requests.load(Ordering::SeqCst), 1);
    let original = work(client, &session, &message, None).await?;
    assert!(
        matches!(
            original["state"]["kind"].as_str(),
            Some("running" | "waiting")
        ),
        "{original}"
    );
    let run = original["runId"].clone();
    let user = user_message(client, &session, &message, &run).await?;
    let domain = match producer {
        Producer::Goal => {
            assert_eq!(user["origin"]["kind"], "goal");
            assert_eq!(user["origin"]["goalId"], domain_id);
            let goal = query(client, "goal", json!({"sessionId":session})).await?;
            assert_eq!(goal["enabled"], true);
            assert_eq!(goal["current"]["id"], domain_id);
            goal_identity(&goal["current"])
        }
        Producer::Scheduler => {
            assert_ne!(session, parent);
            let child = query(client, "observe", json!({"sessionId":session})).await?;
            assert_eq!(child["session"]["parentSessionId"], parent);
            let detail = schedule(client, &domain_id).await?;
            assert_eq!(detail["task"]["runs"][0]["runId"], run);
            assert!(detail["pendingFire"].is_null());
            detail
        }
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
    assert_eq!(
        admitted["fact"]["spec"]["digest"].as_str().unwrap().len(),
        64
    );
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
    let recovered = work(client, &session, &message, Some("blocked")).await?;
    assert_eq!(recovered["runId"], run);
    assert_eq!(recovered["turnId"], original["turnId"]);
    let blockers = recovered["state"]["blockers"].as_array().unwrap();
    assert_eq!(blockers.len(), 1);
    assert_eq!(blockers[0]["reason"]["kind"], "unsupported_protocol");
    let by_run = query(
        client,
        "execution",
        json!({"sessionId":session,"runId":run}),
    )
    .await?;
    assert_eq!(by_run["kind"], "found");
    assert_eq!(by_run["execution"], recovered);
    assert_eq!(user_message(client, &session, &message, &run).await?, user);
    match producer {
        Producer::Goal => {
            let current = query(client, "goal", json!({"sessionId":session})).await?;
            assert_eq!(goal_identity(&current["current"]), domain);
            let rejected = mutate(
                client,
                "agent",
                "changeGoal",
                json!({"kind":"control","sessionId":session,"goalId":domain_id,
                "revision":current["current"]["revision"],"action":"resume","approval":approval}),
                Attachments::new(),
            )
            .await?;
            assert_eq!(
                rejected,
                json!({"kind":"rejected","reason":"goal_approval_invalid"})
            );
            let after = query(client, "goal", json!({"sessionId":session})).await?;
            assert_eq!(goal_identity(&after["current"]), domain);
        }
        Producer::Scheduler => {
            // The public DTO exposes approved, not the private authorization blob.
            assert_eq!(schedule(client, &domain_id).await?, domain);
            let child = query(client, "observe", json!({"sessionId":session})).await?;
            assert_eq!(child["session"]["parentSessionId"], parent);
            let children = query(client, "list", json!({"filter":"all","position":{"kind":"start"},"scope":{"kind":"children","sessionId":parent}})).await?;
            let children = children["sessions"].as_array().unwrap();
            assert_eq!(children.len(), 1);
            assert_eq!(children[0]["id"], session);
        }
    }
    assert_eq!(model.producer_requests.load(Ordering::SeqCst), 1);
    assert_eq!(
        model.requests.load(Ordering::SeqCst),
        match producer {
            Producer::Goal => 1,
            Producer::Scheduler => 5,
        }
    );
    // Leave blocked history for the existing read-only inspector, without a
    // test Root/SQL writer or a live Root fence.
    phase("second client close before Host fault", clients[1].close()).await?;
    phase("second Host kill/wait/EOF", hosts[1].sigkill()).await?;
    let after = records(&inspect(sandbox, &session, inspectors).await?);
    assert!(
        after.starts_with(&before),
        "recovery must append to original history"
    );
    assert!(after.iter().all(|record| record["run"] == run));
    assert_eq!(one(&after, "run_admitted"), &admitted);
    assert_eq!(one(&after, "step_prepared"), one(&before, "step_prepared"));
    assert_eq!(
        one(&after, "model_attempt_prepared"),
        one(&before, "model_attempt_prepared")
    );
    assert_eq!(
        one(&after, "model_attempt_admitted"),
        one(&before, "model_attempt_admitted")
    );
    let interrupted = one(&after, "model_interrupted");
    let recovery = one(&after, "attempt_recovery_recorded");
    assert_eq!(recovery["fact"]["recovery"]["kind"], "blocked");
    assert_eq!(interrupted["fact"]["attempt"], recovery["fact"]["attempt"]);
    assert_eq!(
        recovery["fact"]["attempt"],
        one(&before, "model_attempt_prepared")["fact"]["attempt"]
    );
    assert!(!after.iter().any(|record| matches!(
        record["fact"]["kind"].as_str(),
        Some(
            "model_observed"
                | "model_closed"
                | "retry_charged"
                | "stop_requested"
                | "run_terminated"
        )
    )));
    assert_eq!(model.producer_requests.load(Ordering::SeqCst), 1);
    Ok(())
}

async fn acceptance(producer: Producer) {
    let sandbox = Sandbox::new()
        .await
        .expect("owned empty Root/HOME/workspace");
    let nonce = Uuid::new_v4().simple().to_string();
    let model = Arc::new(Model {
        marker: format!("producer-{nonce}"),
        bootstrap: format!("proposal-{nonce}"),
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
            result = body(producer, &sandbox, &mut hosts, &mut clients, &mut inspectors, &model, &mut observations, &base) => result,
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
            assert_eq!(model.producer_requests.load(Ordering::SeqCst), 1);
            assert_eq!(model.eof.load(Ordering::SeqCst), 1);
            assert_eq!(
                model.requests.load(Ordering::SeqCst),
                match producer {
                    Producer::Goal => 1,
                    Producer::Scheduler => 5,
                }
            );
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
async fn goal_iteration_one_reopens_original_blocked_run_without_redispatch() {
    acceptance(Producer::Goal).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn scheduler_user_approved_due_fire_reopens_original_blocked_run_without_redispatch() {
    acceptance(Producer::Scheduler).await;
}
