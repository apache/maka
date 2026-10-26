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

//! Production-Host JSONL benchmark driver; never starts a Host or a model server.
//!
//! Build: cargo build --release -p maka-cli --example host_benchmark_client
//! Keep the same feature set and build environment as the measured production CLI.
//! Requests: {"id":1,"op":"connect","args":{"root":"...","journal":"...","scopes":1}}
//! Await connect before submitting work. Every other request selects args.client (default 0).
//! query: endpoint/method/input; mutation: same, optional sessionId/correlation/secret.
//! settings_mutation uses the Settings custody protocol. secret is a dummy UTF-8 attachment.
//! create: name + optional workspace (otherwise first configured directory), optional tools.
//! Omitted tools inherits the installed production tool set.
//! send: sessionId/message/model (explicit ModelSelection), optional thinkingLevel/editor.
//! admit: same arguments, durable dispatch without a UI watch; returns accepted IDs and
//! acceptedMs (includes draft persistence + prepare + confirm, not model completion).
//! Completion uses query endpoint=agent, method=execution, input={sessionId,invocationId}.
//! Result kind=found has execution.state; terminal states: completed, failed, cancelled.
//! kind=missing is an error/unknown outcome, never completion. Waiting/paused remain active.
//! For background-agent load, a controller can pipeline 16 concurrent admit requests,
//! recording total ramp time, and hold every admitted agent at its local provider barrier.
//! This driver does not add an internal semaphore; the 16 requests are admission concurrency,
//! not a claim that only 16 background agents exist. No watch is retained after admit.
//! history: sessionId -> {messages:[{role,text}],through,pages}; frozen, fully paginated.
//! subscribe: endpoint/method/input/maxItems (required finite bound).
//! observe attaches read-only scopes to the original hostEpoch using the same Journal;
//! sender scopes remain alive. query/history with observer=true select those scopes.
//! close drains all scopes; EOF waits for outstanding commands and closes scopes.
//!
//! All commands other than connect/close run concurrently, with no semaphore or hidden
//! queue. One GUI-like scope has no fixed request-count cap. Multi-client cases
//! explicitly select their scope count and route each group to its scope.
//! A send occupies a watch plus a mutation during admission; every scope
//! has its own anchor, while all share ONE Journal clone/SQLite database. The returned
//! scope count must be reported separately from single-scope measurements.
//! Timing starts before draft persistence and ends at the original invocation's Ended
//! stream fact. firstVisibleMs excludes thinking deltas. Stream pages are fully pulled;
//! includeEvents=true additionally returns raw pages. No sampling or polling completion.
//! Initialize provider/settings separately with `maka host init --settings-stdin`.
use maka_app_client::{Client, Journal, Mutation, SubscriptionEvent};
use maka_capabilities::call::{Attachments, ReadResource, ResourceEncoding};
use maka_host_runtime::application::host::{Client as HostClient, discovery};
use maka_plugin_core::{
    contract::{ResourceType, text_resource_type},
    operation::{OperationCleanup, OperationOutcome, OperationReply, Receipt},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    io::{BufRead, Write},
    ops::Range,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{sync::RwLock, task::JoinSet};
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;
#[derive(Deserialize)]
struct Command {
    id: Value,
    op: String,
    #[serde(default)]
    args: Value,
}
#[derive(Default)]
struct State {
    clients: RwLock<Vec<Client>>,
    observers: RwLock<Vec<Client>>,
    journal: RwLock<Option<Journal>>,
}
struct DummySecret(Vec<u8>);
impl ReadResource for DummySecret {
    fn encoding(&self) -> ResourceEncoding {
        ResourceEncoding::Utf8
    }
    fn resource_type(&self) -> ResourceType {
        text_resource_type()
    }
    fn bytes(&self) -> usize {
        self.0.len()
    }
    fn metadata(&self) -> Value {
        json!({})
    }
    fn read(&self, range: Range<usize>) -> Result<Vec<u8>> {
        self.0
            .get(range)
            .map(<[u8]>::to_vec)
            .ok_or_else(|| "invalid secret range".into())
    }
}
fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing string args.{key}"))
}
fn input(v: &Value) -> Value {
    v.get("input").cloned().unwrap_or_else(|| json!({}))
}
fn operation_id(v: &Value) -> Result<Uuid> {
    v.get("operationId")
        .map(|x| {
            x.as_str()
                .ok_or("operationId must be a UUID string")
                .and_then(|s| Uuid::parse_str(s).map_err(|_| "invalid operationId"))
        })
        .transpose()
        .map(|id| id.unwrap_or_else(Uuid::new_v4))
        .map_err(str::to_owned)
}
fn returned(reply: OperationReply) -> Result<Value> {
    match reply.receipt {
        Receipt::Recorded {
            outcome: OperationOutcome::Returned { value },
            cleanup: OperationCleanup::Confirmed,
        } => Ok(value),
        receipt => Err(format!(
            "mutation did not return a confirmed recorded outcome: {}",
            serde_json::to_string(&receipt).unwrap_or_default()
        )),
    }
}
async fn commit(mutation: Mutation) -> Result<Value> {
    mutation.prepare().await?;
    returned(mutation.confirm().await?)
}
fn elapsed(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

async fn history(client: &Client, session: &str) -> Result<Value> {
    let mut through = Value::Null;
    let mut position = json!({"kind":"start"});
    let mut cursors = HashSet::new();
    let mut messages: Vec<Value> = Vec::new();
    let mut indices = BTreeMap::<String, usize>::new();
    let mut pages = 0;
    loop {
        let page = client.query("agent", "history", json!({"sessionId":session,"through":through,"position":position,"includeThinking":false})).await?;
        pages += 1;
        let fence = page.get("through").ok_or("history missing fence")?.clone();
        if !through.is_null() && through != fence {
            return Err("history fence changed".into());
        }
        through = fence;
        for chunk in page
            .get("chunks")
            .and_then(Value::as_array)
            .ok_or("history missing chunks")?
        {
            if chunk["field"] != "body" {
                continue;
            }
            let role = chunk["role"].as_str().ok_or("history missing role")?;
            // The common comparison surface is conversational body text, not tool JSON.
            if !matches!(role, "user" | "assistant") {
                continue;
            }
            let key = string(chunk, "messageId")?.to_owned();
            let index = *indices.entry(key).or_insert_with(|| {
                messages.push(json!({"role":role,"text":""}));
                messages.len() - 1
            });
            let text = string(chunk, "text")?;
            let offset = chunk["offset"].as_u64().ok_or("history missing offset")? as usize;
            let current = messages[index]["text"].as_str().unwrap();
            if offset != current.len() {
                return Err(format!(
                    "history noncontiguous text at byte {offset}, expected {}",
                    current.len()
                ));
            }
            messages[index]["text"] = format!("{current}{text}").into();
        }
        let after = page.get("after").ok_or("history missing continuation")?;
        if after.is_null() {
            return Ok(json!({"messages":messages,"through":through,"pages":pages}));
        }
        if !cursors.insert(after.to_string()) {
            return Err("history cursor repeated".into());
        }
        position = json!({"kind":"after","cursor":after});
    }
}

/// Dispatch through the same production draft/receipt custody as send, without UI observation.
async fn admit(client: &Client, args: &Value) -> Result<Value> {
    let session = string(args, "sessionId")?;
    let message = string(args, "message")?;
    let model = args
        .get("model")
        .filter(|v| v.is_object())
        .ok_or("admit requires explicit args.model selection")?;
    let editor = args["editor"].as_str().unwrap_or("host-benchmark");
    let start = Instant::now();
    let previous = client.load_draft("agent", session, editor).await?;
    let draft = client
        .save_draft(
            "agent",
            session,
            editor,
            previous.map(|d| d.revision),
            message.to_owned().into(),
        )
        .await?;
    let mut selection = json!({"model":model});
    if let Some(level) = args.get("thinkingLevel") {
        selection["thinkingLevel"] = level.clone();
    }
    let mutation = client
        .send_draft(
            operation_id(args)?,
            "agent",
            session,
            editor,
            draft.revision,
            selection,
        )
        .await?;
    let accepted = commit(mutation).await?;
    if accepted["kind"] != "started" {
        return Err(format!(
            "admit did not start a distinct idle-session invocation: {accepted}"
        ));
    }
    Ok(json!({
        "sessionId":string(&accepted,"sessionId")?,
        "invocationId":string(&accepted,"invocationId")?,
        "messageId":string(&accepted,"messageId")?,
        "acceptedMs":elapsed(start),
    }))
}

async fn send(client: &Client, args: &Value) -> Result<Value> {
    let session = string(args, "sessionId")?;
    let message = string(args, "message")?;
    let model = args
        .get("model")
        .filter(|v| v.is_object())
        .ok_or("send requires explicit args.model selection")?;
    let editor = args["editor"].as_str().unwrap_or("host-benchmark");
    let start = Instant::now();
    let previous = client.load_draft("agent", session, editor).await?;
    let draft = client
        .save_draft(
            "agent",
            session,
            editor,
            previous.map(|d| d.revision),
            message.to_owned().into(),
        )
        .await?;
    // Subscribe before dispatch so first output is measured even for an immediate local reply.
    let subscription = client
        .subscribe("agent", "watch", json!({"sessionId":session,"after":0}))
        .await?;
    let result = async {
        let mut selection = json!({"model":model});
        if let Some(level) = args.get("thinkingLevel") { selection["thinkingLevel"] = level.clone(); }
        let mutation = client.send_draft(operation_id(args)?,"agent",session,editor,draft.revision,selection).await?;
        let accepted = commit(mutation).await?;
        if accepted["kind"] != "started" { return Err(format!("send did not start a distinct idle-session invocation: {accepted}")); }
        let invocation = string(&accepted,"invocationId")?.to_owned();
        let accepted_ms = elapsed(start);
        let mut first_visible: Option<f64> = None;
        let mut text = String::new();
        let mut parts = BTreeMap::<(String,String),bool>::new();
        let mut event_count = 0_u64;
        let mut pages = Vec::new();
        loop {
            let event = subscription.next().await?.ok_or("watch ended before invocation completion")?;
            let SubscriptionEvent::Item(page) = event else { return Err("watch finished before invocation completion".into()); };
            let mut ended = None;
            if let Some(events) = page["events"].as_array() {
                for event in events {
                    if event["invocationId"] != invocation { continue; }
                    event_count += 1;
                    let fact = &event["fact"];
                    match fact["kind"].as_str() {
                        Some("part_started") => { parts.insert((string(fact,"stepId")?.into(),string(fact,"partId")?.into()),fact["textKind"] == "text"); }
                        Some("executor_started") => { parts.insert((invocation.clone(),"text".into()),true); parts.insert((invocation.clone(),"thinking".into()),false); }
                        Some("delta") => {
                            let key = (string(fact,"stepId")?.to_owned(),string(fact,"partId")?.to_owned());
                            let visible = parts.get(&key).ok_or("stream delta missing original part")?;
                            let delta = string(fact,"text")?;
                            if *visible && !delta.is_empty() { first_visible.get_or_insert_with(||elapsed(start)); text.push_str(delta); }
                        }
                        Some("ended") => { ended = Some(fact["failed"].as_bool().ok_or("ended missing failed flag")?); }
                        _ => {}
                    }
                }
            }
            if args["includeEvents"].as_bool().unwrap_or(false) { pages.push(page); }
            if let Some(failed) = ended {
                return Ok(json!({"accepted":accepted,"acceptedMs":accepted_ms,"firstVisibleMs":first_visible,"completedMs":elapsed(start),"failed":failed,"text":text,"eventCount":event_count,"events":pages}));
            }
        }
    }.await;
    let cleanup = subscription.close().await;
    match (result, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(cause), Ok(())) => Err(cause),
        (result, Err(cleanup)) => Err(format!(
            "{}; watch cleanup failed: {cleanup}",
            result.err().unwrap_or_else(|| "send completed".into())
        )),
    }
}

async fn close(state: &State) -> Result<Value> {
    let mut clients = state.clients.read().await.clone();
    clients.extend(state.observers.read().await.iter().cloned());
    let mut errors = Vec::new();
    for client in &clients {
        if let Err(error) = client.close().await {
            errors.push(error);
        }
    }
    state.clients.write().await.clear();
    state.observers.write().await.clear();
    *state.journal.write().await = None;
    if errors.is_empty() {
        Ok(json!({"closed":clients.len()}))
    } else {
        Err(format!("scope cleanup failed: {}", errors.join("; ")))
    }
}
async fn execute(state: &State, command: &Command) -> Result<Value> {
    let args = &command.args;
    if command.op == "connect" {
        if !state.clients.read().await.is_empty() {
            return Err("already connected; close before reconnecting".into());
        }
        let root = PathBuf::from(string(args, "root")?)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let journal_path = PathBuf::from(string(args, "journal")?);
        let parent = journal_path
            .parent()
            .ok_or("journal requires parent directory")?;
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let canonical_journal = parent.canonicalize().map_err(|e| e.to_string())?.join(
            journal_path
                .file_name()
                .ok_or("journal requires filename")?,
        );
        if canonical_journal.starts_with(&root) {
            return Err("client journal must be outside Host root".into());
        }
        let scopes = args["scopes"].as_u64().unwrap_or(1) as usize;
        if scopes == 0 {
            return Err("scopes must be positive".into());
        }
        let discovered = discovery::read(&root).map_err(|e| e.to_string())?;
        let status_stream = maka_host_runtime::ipc::connect(&discovered.endpoint)
            .await
            .map_err(|e| e.to_string())?;
        let status = HostClient::status_stream(status_stream, Some(discovered.host_epoch)).await?;
        discovered.verify(&status).map_err(|e| e.to_string())?;
        let journal = Journal::open(&canonical_journal).await?;
        let mut clients = Vec::with_capacity(scopes);
        for _ in 0..scopes {
            let anchor = HostClient::connect(&discovered.endpoint, Some(discovered.host_epoch))
                .await
                .map_err(|e| e.to_string())?;
            clients.push(Client::new(anchor, journal.clone(), "receipts".into())?);
        }
        *state.clients.write().await = clients;
        *state.journal.write().await = Some(journal);
        return Ok(
            json!({"scopes":scopes,"anchors":scopes,"journals":1,"hostEpoch":discovered.host_epoch}),
        );
    }
    if command.op == "close" {
        return close(state).await;
    }
    if command.op == "observe" {
        if !state.observers.read().await.is_empty() {
            return Err("observer scopes already connected".into());
        }
        let journal = state
            .journal
            .read()
            .await
            .clone()
            .ok_or("connect before observe")?;
        let root = PathBuf::from(string(args, "root")?);
        let expected = Uuid::parse_str(string(args, "hostEpoch")?).map_err(|e| e.to_string())?;
        let discovered = discovery::read(&root).map_err(|e| e.to_string())?;
        if discovered.host_epoch != expected {
            return Err("observer discovered a different Host epoch".into());
        }
        let scopes = args["scopes"].as_u64().unwrap_or(1) as usize;
        if scopes == 0 {
            return Err("observer scopes must be positive".into());
        }
        for _ in 0..scopes {
            let anchor = HostClient::connect(&discovered.endpoint, Some(expected))
                .await
                .map_err(|e| e.to_string())?;
            let observer = Client::new(anchor, journal.clone(), "receipts".into())?;
            state.observers.write().await.push(observer);
        }
        return Ok(
            json!({"observerScopes":scopes,"senderScopes":state.clients.read().await.len(),"hostEpoch":expected}),
        );
    }
    let index = args["client"].as_u64().unwrap_or(0) as usize;
    let observing = args["observer"].as_bool().unwrap_or(false);
    if observing && !matches!(command.op.as_str(), "query" | "history") {
        return Err("observer scopes accept only query/history".into());
    }
    let clients = if observing {
        &state.observers
    } else {
        &state.clients
    };
    let client = clients
        .read()
        .await
        .get(index)
        .cloned()
        .ok_or("args.client scope not connected")?;
    match command.op.as_str() {
        "query" => {
            client
                .query(
                    string(args, "endpoint")?,
                    string(args, "method")?,
                    input(args),
                )
                .await
        }
        "describe" => serde_json::to_value(client.describe(string(args, "endpoint")?).await?)
            .map_err(|e| e.to_string()),
        "mutation" | "settings_mutation" => {
            let endpoint = string(args, "endpoint")?;
            let method = string(args, "method")?;
            let mut resources = Attachments::new();
            if let Some(secret) = args["secret"].as_str() {
                resources.insert(
                    "secret".into(),
                    Arc::new(DummySecret(secret.as_bytes().to_vec())),
                );
            }
            let mutation = if command.op == "settings_mutation" {
                client
                    .settings_mutation(
                        operation_id(args)?,
                        endpoint,
                        method,
                        input(args),
                        resources,
                    )
                    .await?
            } else if endpoint == "agent" {
                if method == "send" {
                    return Err("use send: agent.send requires durable draft custody".into());
                }
                if !resources.is_empty() {
                    return Err("agent control does not accept resources".into());
                }
                client
                    .control(operation_id(args)?, method, input(args))
                    .await?
            } else {
                client
                    .mutation(
                        operation_id(args)?,
                        endpoint,
                        method,
                        input(args),
                        resources,
                        args["sessionId"].as_str().map(str::to_owned),
                        args.get("correlation").cloned().unwrap_or(Value::Null),
                    )
                    .await?
            };
            commit(mutation).await
        }
        "create" => {
            let workspace = if let Some(workspace) = args.get("workspace") {
                workspace.clone()
            } else {
                let roots = client
                    .query("agent", "directories", json!({"kind":"roots"}))
                    .await?;
                let selection = roots["roots"][0]
                    .get("selection")
                    .ok_or("no configured directory root; provide args.workspace")?;
                json!({"kind":"directory","selection":selection})
            };
            let input = json!({"title":string(args,"name")?,"automaticTitle":false,"labels":[],"workspace":workspace,"tools":args.get("tools").cloned().unwrap_or(Value::Null)});
            commit(client.control(operation_id(args)?, "create", input).await?).await
        }
        "send" => send(&client, args).await,
        "admit" => admit(&client, args).await,
        "history" => history(&client, string(args, "sessionId")?).await,
        "pending" => Ok(json!({"requests":client.pending_requests().await})),
        "subscribe" => {
            let bound = args["maxItems"]
                .as_u64()
                .filter(|n| *n > 0)
                .ok_or("subscribe requires positive finite maxItems")?;
            let subscription = client
                .subscribe(
                    string(args, "endpoint")?,
                    string(args, "method")?,
                    input(args),
                )
                .await?;
            let result = async {
                let mut items = Vec::new();
                for _ in 0..bound {
                    match subscription.next().await? {
                        Some(SubscriptionEvent::Item(value)) => items.push(value),
                        Some(SubscriptionEvent::Finished(value)) => {
                            return Ok(json!({"items":items,"finished":value}));
                        }
                        None => break,
                    }
                }
                Ok(json!({"items":items}))
            }
            .await;
            subscription.close().await?;
            result
        }
        _ => Err(format!("unknown op {}", command.op)),
    }
}
fn output(out: &Mutex<std::io::Stdout>, value: Value) {
    let mut out = out.lock().unwrap();
    // The lock spans the complete line, so concurrent requests cannot interleave JSON.
    if let Err(error) = writeln!(&mut out, "{value}").and_then(|_| out.flush()) {
        eprintln!("benchmark stdout failed: {error}");
    }
}
#[tokio::main]
async fn main() {
    let state = Arc::new(State::default());
    let out = Arc::new(Mutex::new(std::io::stdout()));
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel::<String>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            match line {
                Ok(line) => {
                    if sender.send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    let mut tasks = JoinSet::new();
    loop {
        tokio::select! {
            line = receiver.recv() => {
                let Some(line) = line else { break; };
                let command: Command = match serde_json::from_str(&line) {
                    Ok(command) => command,
                    Err(error) => { output(&out,json!({"id":null,"error":error.to_string()})); continue; }
                };
                let state = state.clone(); let out = out.clone();
                let lifecycle = matches!(command.op.as_str(),"connect"|"observe"|"close");
                let work = async move {
                    let result = if let Some(seconds) = command.args["timeoutSec"].as_u64() {
                        tokio::time::timeout(Duration::from_secs(seconds),execute(&state,&command)).await.unwrap_or_else(|_|Err("command timeout; close client scope to drain original custody".into()))
                    } else { execute(&state,&command).await };
                    output(&out,match result { Ok(value) => json!({"id":command.id,"result":value}), Err(error) => json!({"id":command.id,"error":error}) });
                };
                if lifecycle { work.await; } else { tasks.spawn(work); }
            }
            result = tasks.join_next(), if !tasks.is_empty() => {
                if let Some(Err(error)) = result { eprintln!("benchmark command panicked: {error}"); }
            }
        }
    }
    while let Some(result) = tasks.join_next().await {
        if let Err(error) = result {
            eprintln!("benchmark command panicked: {error}");
        }
    }
    if let Err(error) = close(&state).await {
        eprintln!("benchmark EOF cleanup failed: {error}");
    }
}
