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

// Task-owned integration consumer of the actual CLI business Host.
// No native host, browser protocol, NativeContext, Run or grant implementation.
#![cfg(target_os = "linux")]

use http_body_util::{BodyExt, Full};
use hyper::{
    Request, Response,
    body::{Bytes, Incoming},
    server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::TokioIo;
use maka_app_client::{Client, Journal};
use maka_capabilities::call::{Attachments, ReadResource, ResourceEncoding};
use maka_host_runtime::application::host::Client as HostClient;
use maka_plugin_core::{
    contract::{ResourceType, text_resource_type},
    operation::{OperationCleanup, OperationOutcome, Receipt},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    convert::Infallible,
    io::{Read, Write},
    ops::Range,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{net::TcpListener, sync::mpsc, task::JoinSet};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
const MARKER: &str = "MAKA_MAIN_NATIVE_DISCOVERY_V1:";
const FIXTURE_KEY: &str = "maka-main-interop-task-only-key";
const TOOL_ID: &str = "maka-main-native-readonly";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    main_binary: PathBuf,
    main_sha256: String,
    main_pid: u32,
    chrome_pid: u32,
    ready: Value,
    adapter: String,
    extension_id: String,
    fixture_url: String,
    output: PathBuf,
}
#[derive(Clone)]
struct Evidence(Arc<Mutex<std::fs::File>>);
impl Evidence {
    fn record(&self, kind: &str, value: Value) -> Result<()> {
        let mut file = self.0.lock().map_err(|_| "evidence lock poisoned")?;
        serde_json::to_writer(&mut *file, &json!({"kind":kind,"value":value}))?;
        file.write_all(b"\n")?;
        file.flush()?;
        Ok(())
    }
}
fn digest(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(hex::encode(hash.finalize()))
}
fn process(pid: u32) -> Result<Value> {
    let base = PathBuf::from(format!("/proc/{pid}"));
    let executable = std::fs::read_link(base.join("exe"))?;
    let cmdline = std::fs::read(base.join("cmdline"))?;
    let args: Vec<_> = cmdline
        .split(|byte| *byte == 0)
        .filter(|bytes| !bytes.is_empty())
        .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
        .collect();
    let status = std::fs::read_to_string(base.join("status"))?;
    let parent = status
        .lines()
        .find_map(|line| line.strip_prefix("PPid:\t"))
        .ok_or("process PPid missing")?
        .trim()
        .parse::<u32>()?;
    Ok(
        json!({"pid":pid,"ppid":parent,"executable":executable,"argv":args,"stat":std::fs::read_to_string(base.join("stat"))?,"status":status}),
    )
}
fn same_main_native_processes(input: &Input, evidence: &Evidence) -> Result<usize> {
    let mut count = 0;
    for entry in std::fs::read_dir("/proc")? {
        let entry = entry?;
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(row) = process(pid) else { continue }; // A disappearing unrelated process is not a cleanup claim.
        if row["executable"].as_str() != input.main_binary.to_str() {
            continue;
        }
        let wanted = json!([
            input.main_binary.to_str().ok_or("Main path UTF8")?,
            format!("chrome-extension://{}/", input.extension_id)
        ]);
        if row["argv"] != wanted {
            continue;
        }
        let mut ancestry = Vec::new();
        let mut current = row.clone();
        let mut found = false;
        for _ in 0..32 {
            let parent = current["ppid"].as_u64().ok_or("parent missing")? as u32;
            if parent == input.chrome_pid {
                ancestry.push(process(parent)?);
                found = true;
                break;
            }
            if parent == 0 || parent == 1 {
                break;
            }
            current = process(parent)?;
            ancestry.push(current.clone());
        }
        evidence.record("actual_chrome_launched_same_main_native_role",json!({"process":row,"ancestry":ancestry,"expected_chrome_ancestor_observed":found,"binary_sha256":digest(&input.main_binary)?}))?;
        if !found {
            return Err("Main native role ancestry is not the task Chrome process".into());
        }
        count += 1;
    }
    if count == 0 {
        return Err(
            "no live Chrome-launched Main native role with exact canonical argv observed".into(),
        );
    }
    Ok(count)
}
struct Secret(Vec<u8>);
impl ReadResource for Secret {
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
        Value::Null
    }
    fn read(&self, range: Range<usize>) -> std::result::Result<Vec<u8>, String> {
        self.0
            .get(range)
            .map(<[u8]>::to_vec)
            .ok_or_else(|| "fixture secret range".into())
    }
}
async fn mutation(
    client: &Client,
    evidence: &Evidence,
    endpoint: &str,
    method: &str,
    input: Value,
    resources: Attachments,
) -> Result<Value> {
    let id = Uuid::new_v4();
    evidence.record(
        "public_mutation_reserved",
        json!({"id":id,"endpoint":endpoint,"method":method,"input":input}),
    )?;
    let call = client
        .mutation(id, endpoint, method, input, resources, None, Value::Null)
        .await?;
    let prepared = call.prepare().await?;
    evidence.record("public_original_prepared", serde_json::to_value(prepared)?)?;
    let reply = call.confirm().await?;
    evidence.record(
        "public_actual_operation_reply",
        serde_json::to_value(&reply)?,
    )?;
    // Unknown/unconfirmed/refusal is recorded above and never retried or promoted.
    match reply.receipt {
        Receipt::Recorded {
            outcome: OperationOutcome::Returned { value },
            cleanup: OperationCleanup::Confirmed,
        } => Ok(value),
        other => Err(format!("actual Host receipt is not returned+confirmed: {other:?}").into()),
    }
}
fn tool_choice(name: &str, id: &str, input: Value) -> Value {
    json!({"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":id,"type":"function","function":{"name":name,"arguments":input.to_string()}}]},"finish_reason":"tool_calls"})
}
fn text_choice(text: &str) -> Value {
    json!({"index":0,"delta":{"role":"assistant","content":text},"finish_reason":"stop"})
}
fn find_marker(value: &Value) -> Option<Value> {
    match value {
        Value::String(text) => text.lines().find_map(|line| {
            line.strip_prefix(MARKER)
                .and_then(|json| serde_json::from_str(json).ok())
        }),
        Value::Array(values) => values.iter().find_map(find_marker),
        Value::Object(object) => object.values().find_map(find_marker),
        _ => None,
    }
}
struct Model {
    phase: usize,
    code: String,
    prefix: String,
    fixture_url: String,
    completed: mpsc::Sender<Value>,
}
impl Model {
    fn answer(&mut self, body: &Value) -> Result<Value> {
        let names: Vec<_> = body["tools"]
            .as_array()
            .map(|tools| {
                tools
                    .iter()
                    .filter_map(|tool| tool["function"]["name"].as_str())
                    .collect()
            })
            .unwrap_or_default();
        if names.is_empty() {
            return Ok(text_choice("Main native browser fixture"));
        } // Product title/recap requests are not tool invocations.
        match self.phase {
            0 if !names.contains(&"cua_repl") && names.contains(&"tool_search") => {
                self.phase = 1;
                Ok(tool_choice(
                    "tool_search",
                    "maka-main-discover-cua",
                    json!({"query":"cua_repl"}),
                ))
            }
            0 | 1 if names.contains(&"cua_repl") => {
                self.phase = 2;
                Ok(tool_choice(
                    "cua_repl",
                    TOOL_ID,
                    json!({"code":self.code,"timeout_ms":30000,"title":"Inspect the isolated native browser"}),
                ))
            }
            2 => {
                let messages = body["messages"]
                    .as_array()
                    .ok_or("model continuation messages missing")?;
                let calls: Vec<_> = messages
                    .iter()
                    .filter(|message| message["role"] == "assistant")
                    .flat_map(|message| message["tool_calls"].as_array().into_iter().flatten())
                    .filter(|call| {
                        call["function"]["name"] == "cua_repl"
                            && call["function"]["arguments"]
                                .as_str()
                                .and_then(|args| serde_json::from_str::<Value>(args).ok())
                                .is_some_and(|args| args["code"] == self.code)
                    })
                    .collect();
                if calls.len() != 1 {
                    return Err(
                        "actual continuation does not contain exactly the original cua_repl input"
                            .into(),
                    );
                }
                let actual_call_id = calls[0]["id"]
                    .as_str()
                    .ok_or("actual model call ID missing")?;
                let matching: Vec<_> = messages
                    .iter()
                    .filter(|message| {
                        message["role"] == "tool" && message["tool_call_id"] == actual_call_id
                    })
                    .collect();
                if matching.len() != 1 {
                    return Err(
                        "exact actual original tool-call/result join is missing or ambiguous"
                            .into(),
                    );
                }
                let original = matching[0];
                let observation = find_marker(&original["content"])
                    .ok_or("no actual emitted discovery JSON marker in original tool result")?;
                if !observation["browserId"]
                    .as_str()
                    .is_some_and(|id| id.starts_with(&self.prefix))
                {
                    return Err("tool result selected a foreign/non-native browser".into());
                }
                let tabs = observation["tabs"]
                    .as_array()
                    .ok_or("actual user.openTabs result is not array")?;
                if !tabs
                    .iter()
                    .any(|tab| tab["url"].as_str() == Some(self.fixture_url.as_str()))
                {
                    return Err(
                        "actual native user tabs do not include isolated fixture URL".into(),
                    );
                }
                self.completed.try_send(
                    json!({"raw_original_tool_message":original,"observation":observation}),
                )?;
                self.phase = 3;
                Ok(text_choice("Main native discovery complete"))
            }
            _ => Err("unexpected or duplicate model tool request; no tool replay".into()),
        }
    }
}
struct Provider {
    base_url: String,
    stop: CancellationToken,
    worker: Option<tokio::task::JoinHandle<Result<()>>>,
}
impl Provider {
    async fn start(model: Model, evidence: Evidence) -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let base_url = format!("http://{}/v1", listener.local_addr()?);
        let model = Arc::new(Mutex::new(model));
        let stop = CancellationToken::new();
        let stopped = stop.clone();
        let worker = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    ()=stopped.cancelled()=>break,
                    accepted=listener.accept()=>{
                        let (socket,_)=accepted?;let model=model.clone();let evidence=evidence.clone();
                        connections.spawn(async move {
                            let service=service_fn(move |request:Request<Incoming>|{
                                let model=model.clone();let evidence=evidence.clone();
                                async move {
                                    let result=async {
                                        let path=request.uri().path().to_owned();
                                        if request.method()==hyper::Method::GET&&path=="/v1/models" {
                                            return Ok::<_,Box<dyn std::error::Error+Send+Sync>>(Response::builder().header("content-type","application/json").body(Full::new(Bytes::from(json!({"object":"list","data":[{"id":"fixture-model","object":"model","owned_by":"task-fixture"}]}).to_string())))?);
                                        }
                                        if request.method()!=hyper::Method::POST||path!="/v1/chat/completions" {return Err("unexpected model fixture HTTP method/path".into());}
                                        let authorization=request.headers().get("authorization").and_then(|x|x.to_str().ok()).unwrap_or("").to_owned();
                                        if authorization!=format!("Bearer {FIXTURE_KEY}") {return Err("real model request did not use task-only credential".into());}
                                        let bytes=request.into_body().collect().await?.to_bytes();
                                        if bytes.len()>8*1024*1024 {return Err("fixture model request exceeds bound".into());}
                                        let body:Value=serde_json::from_slice(&bytes)?;
                                        evidence.record("actual_model_http_request",json!({"path":path,"bytes":bytes.len(),"sha256":hex::encode(Sha256::digest(&bytes)),"body":body}))?;
                                        let choice=model.lock().map_err(|_|"model state poisoned")?.answer(&body)?;
                                        evidence.record("deterministic_model_content_only",choice.clone())?;
                                        let chunk=json!({"id":"main-native-interop-model","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[choice]});
                                        Ok(Response::builder().header("content-type","text/event-stream").header("connection","close").body(Full::new(Bytes::from(format!("data: {chunk}\n\ndata: [DONE]\n\n"))))?)
                                    }.await;
                                    let response=match result {
                                        Ok(response)=>response,
                                        Err(error)=>{let message=error.to_string();let _=evidence.record("model_fixture_failure",json!({"message":message}));Response::builder().status(500).body(Full::new(Bytes::from(message))).expect("literal response")}
                                    };
                                    Ok::<_,Infallible>(response)
                                }
                            });
                            http1::Builder::new().serve_connection(TokioIo::new(socket),service).await.map_err(|error|error.to_string())
                        });
                    }
                    Some(result)=connections.join_next(),if !connections.is_empty()=>{result??;}
                }
            }
            while let Some(result) = connections.join_next().await {
                result??;
            }
            Ok(())
        });
        Ok(Self {
            base_url,
            stop,
            worker: Some(worker),
        })
    }
    async fn finish(mut self) -> Result<()> {
        self.stop.cancel();
        let mut worker = self.worker.take().ok_or("model worker owner missing")?;
        match tokio::time::timeout(Duration::from_secs(10), &mut worker).await {
            Ok(result) => {
                result??;
                Ok(())
            }
            Err(_) => {
                worker.abort();
                let joined = worker.await;
                Err(format!(
                    "fixture model shutdown forced abort; join={joined:?}; not graceful cleanup"
                )
                .into())
            }
        }
    }
}
impl Drop for Provider {
    fn drop(&mut self) {
        self.stop.cancel();
        if let Some(worker) = &self.worker {
            worker.abort();
        }
        // Forced task cancellation is never reported as a successful server drain.
        // Outer Root namespace ownership remains responsible for process cleanup.
    }
}
async fn configure(client: &Client, evidence: &Evidence, base: &str) -> Result<Value> {
    let provider = json!({"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"openai-compatible"});
    let catalog = client
        .query("settings", "connections", json!({"kind":"start"}))
        .await?;
    if !catalog["connections"]
        .as_array()
        .is_some_and(|rows| rows.is_empty())
    {
        return Err("fixture Root already has provider connections".into());
    }
    let created=mutation(client,evidence,"settings","create",json!({"expectedCatalogRevision":catalog["revision"],"connection":{"slug":"main-native-interop","name":"Task-only Main browser fixture","provider":provider,"configuration":{"baseUrl":base},"enabled":true,"enabledModelIds":["fixture-model"],"modelOverrides":{"fixture-model":{"contextWindow":200000,"thinkingLevels":["off"],"vision":false}}}}),Attachments::new()).await?;
    if created["kind"] != "committed" {
        return Err("actual fixture settings create did not commit".into());
    }
    let rows = client
        .query("settings", "connections", json!({"kind":"start"}))
        .await?;
    let row = rows["connections"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["slug"] == "main-native-interop"))
        .ok_or("actual created provider row missing")?;
    let detail=client.query("settings","connection",json!({"connectionId":row["basis"]["connectionId"],"revision":row["basis"]["revision"],"includeEditingFacts":true})).await?;
    let mut resources = Attachments::new();
    resources.insert(
        "secret".into(),
        Arc::new(Secret(FIXTURE_KEY.as_bytes().to_vec())),
    );
    let saved = mutation(
        client,
        evidence,
        "settings",
        "saveCredential",
        json!({"expected":detail["target"],"expectedCredential":null}),
        resources,
    )
    .await?;
    if saved["kind"] != "saved" {
        return Err("actual task fixture credential was not saved".into());
    }
    let models = client
        .query(
            "settings",
            "models",
            json!({"kind":"start","query":"fixture-model"}),
        )
        .await?;
    evidence.record("actual_model_selections", models.clone())?;
    let selection = models["choices"]
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|row| row["selection"]["modelId"] == "fixture-model")
        })
        .ok_or("actual configured fixture model not advertised")?["selection"]
        .clone();
    Ok(selection)
}
async fn canonical_history(
    client: &Client,
    evidence: &Evidence,
    session: &str,
) -> Result<Vec<Value>> {
    let mut position = json!({"kind":"start"});
    let mut through = Value::Null;
    let mut chunks = Vec::new();
    for _ in 0..128 {
        let page=client.query("agent","history",json!({"sessionId":session,"through":through,"position":position,"includeThinking":false})).await?;
        evidence.record("actual_canonical_history_page", page.clone())?;
        if page["kind"] != "ready" {
            return Err("canonical history snapshot unavailable".into());
        }
        if through.is_null() {
            through = page["through"].clone();
        } else if through != page["through"] {
            return Err("canonical history fence changed".into());
        }
        chunks.extend(
            page["chunks"]
                .as_array()
                .ok_or("canonical history chunks missing")?
                .iter()
                .cloned(),
        );
        if page["after"].is_null() {
            return Ok(chunks);
        }
        position = json!({"kind":"after","cursor":page["after"]});
    }
    Err("canonical history exceeds bounded 128 pages".into())
}
async fn approve_actual_computer(
    client: &Client,
    evidence: &Evidence,
    session: &str,
    invocation: &Value,
    seen: &mut std::collections::BTreeSet<String>,
) -> Result<()> {
    let pending = client
        .query("agent", "pendingInteractions", json!({"sessionId":session}))
        .await?;
    for summary in pending["entries"]
        .as_array()
        .ok_or("pending interactions shape")?
    {
        let id = summary["requestId"].as_str().ok_or("request ID")?;
        if seen.contains(id) {
            continue;
        }
        let record = client
            .query(
                "agent",
                "interaction",
                json!({"sessionId":session,"requestId":id}),
            )
            .await?;
        evidence.record("actual_pending_interaction", record.clone())?;
        let expected = serde_json::to_value(maka_workspace_api::computer::target())?;
        let actual_tool = record["request"]["toolUseId"]
            .as_str()
            .ok_or("actual interaction tool-use ID missing")?;
        let history = canonical_history(client, evidence, session).await?;
        let calls: Vec<_> = history
            .iter()
            .filter(|chunk| {
                chunk["turnId"] == invocation["turnId"]
                    && chunk["tool"]["toolUseId"] == actual_tool
                    && chunk["tool"]["call"]["name"] == "cua_repl"
                    && chunk["tool"]["call"]["dispatched"] == true
            })
            .collect();
        if calls.is_empty() {
            return Err(
                "actual permission request has no same-Turn canonical cua_repl dispatch".into(),
            );
        }
        if record["sessionId"] != session
            || record["turnId"] != invocation["turnId"]
            || record["runId"] != invocation["runId"]
            || record["request"]["kind"] != "client_capability"
            || record["request"]["target"] != expected
            || !record["outcome"].is_null()
        {
            return Err(
                "unexpected interaction: not the exact current task ComputerUse request".into(),
            );
        }
        let answered=mutation(client,evidence,"agent","respond",json!({"sessionId":session,"requestId":id,"answer":{"kind":"client_capability","decision":"allow"}}),Attachments::new()).await?;
        evidence.record("actual_recorded_interaction_answer", answered.clone())?;
        if answered["kind"] != "recorded" || answered["record"]["requestId"] != id {
            return Err("original capability answer was not recorded".into());
        }
        seen.insert(id.to_owned());
    }
    Ok(())
}

/// Root runs this existing public-client integration consumer only in a prepared
/// task namespace containing the actual Main binary, actual Chrome and install.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires Root-created isolated actual Main Host and Chrome"]
async fn actual_main_cli_native_discovery() -> Result<()> {
    let input: Input =
        serde_json::from_slice(&std::fs::read(std::env::var("MAKA_MAIN_INTEROP_INPUT")?)?)?;
    if input.main_binary != Path::new("/home/test/bin/maka")
        || input.main_sha256.len() != 64
        || digest(&input.main_binary)? != input.main_sha256
    {
        return Err("canonical actual Main path/SHA mismatch".into());
    }
    if !["original", "own"].contains(&input.adapter.as_str())
        || input.extension_id.len() != 32
        || !input
            .extension_id
            .bytes()
            .all(|b| (b'a'..=b'p').contains(&b))
    {
        return Err("actual adapter/extension identity invalid".into());
    }
    let fixture = reqwest::Url::parse(&input.fixture_url)?;
    if fixture.scheme() != "http" || fixture.host_str() != Some("127.0.0.1") {
        return Err("only task loopback fixture allowed".into());
    }
    std::fs::create_dir(&input.output)?;
    let evidence = Evidence(Arc::new(Mutex::new(
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(input.output.join("public-evidence.jsonl"))?,
    )));
    let main = process(input.main_pid)?;
    if main["executable"].as_str() != input.main_binary.to_str()
        || main["argv"][1] != "application"
        || main["argv"][2] != "serve"
    {
        return Err(
            "business Host must be the actual canonical Main explicit application serve process"
                .into(),
        );
    }
    evidence.record("actual_main_business_process", main)?;
    evidence.record("actual_cli_ready", input.ready.clone())?;
    let endpoint = PathBuf::from(
        input.ready["socketPath"]
            .as_str()
            .ok_or("actual ready socket missing")?,
    );
    let epoch = Uuid::parse_str(
        input.ready["hostEpoch"]
            .as_str()
            .ok_or("actual ready epoch missing")?,
    )?;
    let status = HostClient::status(&endpoint, Some(epoch)).await?;
    if status.pid.get() != input.main_pid
        || status.root_id != input.ready["rootId"]
        || status.closing
        || status.closed
    {
        return Err("actual Host status identity mismatch".into());
    }
    evidence.record("actual_host_status_before", serde_json::to_value(&status)?)?;
    let anchor = HostClient::connect(&endpoint, Some(epoch)).await?;
    let client = Client::new(
        anchor,
        Journal::open(&input.output.join("client-journal.db")).await?,
        "receipts".into(),
    )?;
    // This is a live query to the actual authenticated Host, before any model
    // request or Cua evaluation. A source-plan/input assertion is insufficient:
    // WSL Auto delegates to Windows even inside a namespace with Xvfb.
    let installed = client.query("management", "read", json!({})).await?;
    evidence.record("actual_persisted_local_desktop_source", installed.clone())?;
    if installed["source"]["reference"] != serde_json::to_value(&status.source)?
        || installed["source"]["input"]["instances"]["workspace-computer"]["configuration"]["values"]
            ["desktop"]
            != "local"
    {
        let close = client.close().await;
        evidence.record(
            "local_desktop_guard_rejected_actual_source",
            json!({"client_close_result":format!("{close:?}"),"no_model_or_Cua_started":true}),
        )?;
        return Err("actual committed Computer desktop is not explicitly local; WSL Auto/Windows refused before Cua".into());
    }
    // CLI selectors differ from the actual NativeEndpointIdentity.adapter:
    // Core publishes the installed registration host_name unchanged. This
    // expected value only filters actual public observations; it grants nothing.
    let expected_host_name = match input.adapter.as_str() {
        "original" => "com.openai.codexextension",
        "own" => "org.apache.maka.browser_connector",
        _ => return Err("unknown task adapter selector".into()),
    };
    let prefix = format!("native:{}:{}:", expected_host_name, input.extension_id);
    let code = format!(
        "var __mb = await cua.listBrowsers({{emit:false}}); var __ms = __mb.filter(b => b.type === 'extension' && b.metadata?.extensionId === {} && b.id.startsWith({})); if (__ms.length !== 1) throw new Error('exact native fixture browser not unique'); var __mbr = await cua.getBrowser({{id:__ms[0].id}}); var __mt = await __mbr.user.openTabs(); console.log({} + JSON.stringify({{browserId:__mbr.browserId,browserInfo:__ms[0],tabs:__mt}}));",
        serde_json::to_string(&input.extension_id)?,
        serde_json::to_string(&prefix)?,
        serde_json::to_string(MARKER)?
    );
    let (completed, mut observed) = mpsc::channel(1);
    let provider = Provider::start(
        Model {
            phase: 0,
            code,
            prefix,
            fixture_url: input.fixture_url.clone(),
            completed,
        },
        evidence.clone(),
    )
    .await?;
    let mut accepted: Option<Value> = None;
    let mut session = None;
    let outcome:Result<Value>=tokio::time::timeout(Duration::from_secs(120),async {
        let model=configure(&client,&evidence,&provider.base_url).await?;
        let directories=client.query("agent","directories",json!({"kind":"roots"})).await?;
        let root=&directories["roots"][0]["selection"];
        if root.is_null() {return Err("actual product workspace root missing".into());}
        let created=mutation(&client,&evidence,"agent","create",json!({"title":"Actual Main native browser discovery","labels":[],"workspace":{"kind":"directory","selection":root}}),Attachments::new()).await?;
        let id=created["session"]["id"].as_str().ok_or("actual session ID missing")?.to_owned();session=Some(id.clone());
        let sent=mutation(&client,&evidence,"agent","send",json!({"sessionId":id,"message":"Inspect only the task-owned native browser tab inventory once. Do not navigate, claim, click or download.","model":model,"thinkingLevel":"off"}),Attachments::new()).await?;
        if sent["kind"]!="started" {return Err("actual Engine invocation did not start".into());}accepted=Some(sent.clone());
        let invocation=client.query("agent","execution",json!({"sessionId":id,"invocationId":sent["invocationId"]})).await?;
        if invocation["kind"]!="found" {return Err("actual accepted execution missing".into());}
        evidence.record("actual_execution_started",invocation.clone())?;
        let mut decisions=std::collections::BTreeSet::new();
        let observation=loop {
            approve_actual_computer(&client,&evidence,&id,&invocation["execution"],&mut decisions).await?;
            match observed.try_recv() {Ok(value)=>break value,Err(mpsc::error::TryRecvError::Disconnected)=>return Err("model observation channel lost".into()),Err(mpsc::error::TryRecvError::Empty)=>{}}
            tokio::time::sleep(Duration::from_millis(25)).await;
        };
        evidence.record("actual_native_public_observation",observation.clone())?;
        loop {
            let current=client.query("agent","observe",json!({"sessionId":id})).await?;
            if current["run"].is_null() {break;}
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let final_execution=client.query("agent","execution",json!({"sessionId":id,"invocationId":sent["invocationId"]})).await?;
        evidence.record("actual_execution_terminal",final_execution.clone())?;
        if final_execution["execution"]["state"]!="completed" {return Err("actual Engine execution did not complete".into());}
        let history=canonical_history(&client,&evidence,&id).await?;
        let calls:Vec<_>=history.iter().filter(|chunk|chunk["turnId"]==final_execution["execution"]["turnId"]&&chunk["tool"]["call"]["name"]=="cua_repl").collect();
        if calls.is_empty()||!calls.iter().any(|chunk|chunk["tool"]["result"]["isError"]==false&&!chunk["tool"]["result"].is_null()) {return Err("actual canonical cua_repl result is not present and successful".into());}
        let native_count=same_main_native_processes(&input,&evidence)?;
        Ok(json!({"observation":observation,"execution":final_execution,"observed_same_main_native_processes":native_count,"scope":"Actual Main business Host/Engine/Computer native inventory only. No document read, input, child adoption, tagged GET, download, file-byte/custody or full parity claim."}))
    }).await.unwrap_or_else(|_|Err("actual Main public consumer budget expired; original custody is not assumed settled".into()));
    if outcome.is_err() {
        if let (Some(id), Some(sent)) = (&session, &accepted) {
            let stop = tokio::time::timeout(
                Duration::from_secs(15),
                mutation(
                    &client,
                    &evidence,
                    "agent",
                    "stop",
                    json!({"sessionId":id,"invocationId":sent["invocationId"]}),
                    Attachments::new(),
                ),
            )
            .await;
            evidence.record(
                "original_run_stop_attempt_after_failure",
                json!({"result":format!("{stop:?}"),"settlement_proven":false}),
            )?;
        }
    }
    let client_close = tokio::time::timeout(Duration::from_secs(15), client.close()).await;
    evidence.record(
        "official_client_close_result",
        json!({"result":format!("{client_close:?}")}),
    )?;
    let provider_close = provider.finish().await;
    evidence.record(
        "fixture_model_server_close_result",
        json!({"result":format!("{provider_close:?}")}),
    )?;
    let report = json!({"completed":outcome.is_ok()&&matches!(client_close,Ok(Ok(())))&&provider_close.is_ok(),"result":outcome.as_ref().ok(),"error":outcome.as_ref().err().map(ToString::to_string),"host_process_retirement_proven":false,"physical_native_cleanup_proven":false,"scope":"Read-only public native inventory via actual Main CLI Host. Outer Root controller still owns real Host/native/Chrome/namespace retirement and canonical cleanup collection."});
    std::fs::write(
        input.output.join("consumer-report.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    outcome?;
    client_close??;
    provider_close?;
    Ok(())
}
