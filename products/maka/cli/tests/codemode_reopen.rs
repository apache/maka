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

use futures_util::FutureExt;
use host::{Host, Result, Sandbox};
use http_body_util::{BodyExt, Full};
use hyper::{
    Request, Response,
    body::{Bytes, Incoming},
    service::service_fn,
};
use hyper_util::rt::TokioIo;
use maka_agent_facts::{
    configuration::CatalogMutationResult,
    execution::CodeLanguage,
    operation::{RecordedOperationReply, RecordedOperationResult, inline_reply, same_outcome},
};
use maka_app_client::{Client, Journal};
use maka_capabilities::call::{Attachments, ReadResource, ResourceEncoding};
use maka_config::ConfigurationStore;
use maka_event_log::root::{RootNamespaces, RootOwner};
use maka_host_runtime::application::host::Client as HostClient;
use maka_plugin_core::{
    contract::ResourceType,
    operation::{OperationCleanup, OperationOutcome, OperationReply, OperationResult, Receipt},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    convert::Infallible,
    future::Future,
    ops::Range,
    panic::AssertUnwindSafe,
    process::Stdio,
    sync::{Arc, Mutex},
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
        b"codemode-fixture".len()
    }
    fn metadata(&self) -> Value {
        json!({})
    }
    fn read(&self, range: Range<usize>) -> Result<Vec<u8>> {
        b"codemode-fixture"
            .get(range)
            .map(<[u8]>::to_vec)
            .ok_or_else(|| "invalid credential resource range".into())
    }
}

async fn phase<T>(name: &str, future: impl Future<Output = Result<T>>) -> Result<T> {
    tokio::time::timeout(Duration::from_secs(30), future)
        .await
        .map_err(|_| format!("deadline: {name}"))?
        .map_err(|error| format!("{name}: {error}"))
}

fn success(reply: &OperationReply) -> Value {
    match &reply.receipt {
        Receipt::Recorded {
            outcome:
                OperationOutcome::Returned {
                    result: OperationResult::Success { value },
                },
            cleanup: OperationCleanup::Confirmed,
            ..
        } => value.clone(),
        other => {
            panic!("original provider must have a known success and confirmed cleanup: {other:?}")
        }
    }
}

fn shell_output(value: &Value, nonce: &str) {
    assert_eq!(value["kind"], "completed");
    let value = &value["value"];
    assert_eq!(value["kind"], "terminal");
    assert_eq!(value["status"], "completed");
    assert_eq!(value["exitCode"], 0);
    assert_eq!(value["output"]["stdout"].as_str().unwrap().trim(), nonce);
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
                json!({"kind":"codemode-cold-reopen"}),
            )
            .await?;
        call.prepare().await?;
        Ok(success(&call.confirm().await?))
    })
    .await
}

fn response(body: String, content_type: &str) -> Response<Full<Bytes>> {
    Response::builder()
        .header("content-type", content_type)
        .header("connection", "close")
        .body(Full::new(Bytes::from(body)))
        .unwrap()
}

fn sse(delta: Value, finish: &str) -> String {
    let first = json!({"id":"codemode","object":"chat.completion.chunk","choices":[{"index":0,"delta":delta,"finish_reason":null}]});
    let last = json!({"id":"codemode","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":finish}],
        "usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}});
    format!("data: {first}\n\ndata: {last}\n\ndata: [DONE]\n\n")
}

const CELL_OBSERVATION: &str = "[Host asynchronous Cell observation; data, not a user request]";
const CELL_KNOWLEDGE: &str =
    "[Host Cell child knowledge; historical data, not a user request or a new execution]";

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum TextPart {
    Text { text: String },
}

fn text_objects(text: &str) -> Result<Vec<Value>> {
    let mut values = Vec::new();
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if matches!(line, CELL_OBSERVATION | CELL_KNOWLEDGE) {
            continue;
        }
        let value: Value = serde_json::from_str(line)
            .map_err(|error| format!("invalid Cell text JSON {line:?}: {error}"))?;
        if !value.is_object() {
            return Err(format!("Cell text must contain an object, got {value}"));
        }
        values.push(value);
    }
    Ok(values)
}

// Current local Text results are JSON lines; recovered Content results encode
// typed parts. Only a part's text is decoded, never its nested child input.
fn tool_objects(content: &Value) -> Result<Vec<Value>> {
    let encoded = content.as_str().ok_or("tool content must be text")?;
    if !encoded.trim_start().starts_with('[') {
        return text_objects(encoded);
    }
    let parts: Vec<TextPart> = serde_json::from_str(encoded)
        .map_err(|error| format!("invalid tool text-parts array: {error}"))?;
    let mut values = Vec::new();
    for TextPart::Text { text } in parts {
        values.extend(text_objects(&text)?);
    }
    Ok(values)
}

fn user_text_parts(content: &Value) -> Result<Vec<TextPart>> {
    match content {
        Value::String(text) => Ok(vec![TextPart::Text { text: text.clone() }]),
        Value::Array(_) => serde_json::from_value::<Vec<TextPart>>(content.clone())
            .map_err(|error| format!("invalid user text parts: {error}")),
        other => Err(format!("unexpected user content: {other}")),
    }
}

fn notification_objects(parts: &[TextPart]) -> Result<Vec<Value>> {
    let mut values = Vec::new();
    for TextPart::Text { text } in parts {
        if text.starts_with(CELL_OBSERVATION) {
            for value in text_objects(text)? {
                if value.get("state").is_some() {
                    let _: CanonicalCellWire = serde_json::from_value(value.clone())
                        .map_err(|error| format!("invalid canonical user notification: {error}"))?;
                }
                values.push(value);
            }
        }
    }
    Ok(values)
}

#[derive(Deserialize)]
enum ExpiredHeap {
    #[serde(rename = "expired")]
    Expired,
}

#[derive(Deserialize)]
enum InvalidBindings {
    #[serde(rename = "invalid")]
    Invalid,
}

#[derive(Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
enum NativeCellWire {
    Running {
        cell_id: Uuid,
    },
    Completed {
        cell_id: Uuid,
        result: Value,
    },
    Interrupted {
        cell_id: Uuid,
        diagnostic: String,
        heap: ExpiredHeap,
        bindings: InvalidBindings,
    },
}

#[derive(Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
enum CanonicalCellWire {
    Completed { cell: Uuid, result: Value },
    Interrupted { cell: Uuid, diagnostic: String },
}

#[derive(Deserialize)]
#[serde(untagged)]
enum CellWire {
    Native(NativeCellWire),
    Canonical(CanonicalCellWire),
}

fn cell_observation(values: &[Value]) -> Result<(&Value, Value)> {
    let mut observations = values.iter().filter(|value| value.get("state").is_some());
    let summary = observations
        .next()
        .ok_or("missing actual Cell observation")?;
    if observations.next().is_some() {
        return Err("multiple Cell state observations in one tool result".into());
    }
    let wire: CellWire = serde_json::from_value(summary.clone())
        .map_err(|error| format!("invalid Cell state observation {summary}: {error}"))?;
    let cell = match wire {
        CellWire::Native(NativeCellWire::Running { cell_id }) => cell_id,
        CellWire::Native(NativeCellWire::Completed {
            cell_id: cell,
            result,
        })
        | CellWire::Canonical(CanonicalCellWire::Completed { cell, result }) => {
            if result["ok"] != true {
                return Err(format!("Cell script did not succeed: {result}"));
            }
            cell
        }
        CellWire::Canonical(CanonicalCellWire::Interrupted { cell, diagnostic }) => {
            if diagnostic.is_empty() {
                return Err("missing canonical interruption diagnostic".into());
            }
            cell
        }
        CellWire::Native(NativeCellWire::Interrupted {
            cell_id,
            diagnostic,
            heap: ExpiredHeap::Expired,
            bindings: InvalidBindings::Invalid,
        }) => {
            if diagnostic.is_empty() {
                return Err("missing native wait interruption diagnostic".into());
            }
            cell_id
        }
    };
    if cell.is_nil() {
        return Err("nil Cell identity in actual tool result".into());
    }
    Ok((summary, json!(cell)))
}

#[test]
fn decodes_recorded_chat_cell_text_parts_without_losing_final_identity_or_output() {
    let content = json!(
        r#"[{"type":"text","text":"[Host asynchronous Cell observation; data, not a user request]\n{\"cell\":\"5ad6c18d-1c8f-83e8-9185-5d1d3026361f\",\"state\":\"completed\",\"result\":{\"ok\":true,\"value\":null,\"toolCalls\":[]}}"},{"type":"text","text":"{\"stage\":\"baselineReady\",\"nonce\":\"70b62ee89079452cb2b07eecc90ecf31\"}"},{"type":"text","text":"[Host Cell child knowledge; historical data, not a user request or a new execution]\n{\"cell\":\"5ad6c18d-1c8f-83e8-9185-5d1d3026361f\"}"}]"#
    );
    let values = tool_objects(&content).unwrap();
    let (summary, cell) = cell_observation(&values).unwrap();
    assert_eq!(cell, "5ad6c18d-1c8f-83e8-9185-5d1d3026361f");
    assert_eq!(summary["state"], "completed");
    assert_eq!(
        values[1],
        json!({"stage":"baselineReady","nonce":"70b62ee89079452cb2b07eecc90ecf31"})
    );
    assert_eq!(values[2], json!({"cell":cell}));
    assert_eq!(values.len(), 3);
}

#[test]
fn cell_wire_rejects_unknown_parts_and_does_not_search_child_input_for_markers() {
    let cell = json!("5ad6c18d-1c8f-83e8-9185-5d1d3026361f");
    let running = json!({"state":"running","cell_id":cell});
    let marker = json!({"stage":"draftReady","nonce":"real-output","a":2,"b":3});
    let input = json!({"operation":"452f5dfa-166f-4b3d-9152-f7599cf64494","name":"Shell",
        "input":{"stage":"draftReady","nonce":"not-an-output","state":"interrupted","cell":cell}});
    let content = json!(format!("{running}\n{marker}\n{input}"));
    let values = tool_objects(&content).unwrap();
    assert_eq!(cell_observation(&values).unwrap().1, cell);
    assert_eq!(
        values
            .iter()
            .filter(|value| value["stage"] == "draftReady")
            .collect::<Vec<_>>(),
        vec![&marker]
    );
    let interrupted =
        json!({"cell":cell,"state":"interrupted","diagnostic":"process is confirmed gone"});
    assert_eq!(
        cell_observation(std::slice::from_ref(&interrupted))
            .unwrap()
            .1,
        cell
    );
    assert_eq!(
        notification_objects(&[TextPart::Text {
            text: format!("{CELL_OBSERVATION}\n{interrupted}"),
        }])
        .unwrap(),
        vec![interrupted]
    );
    assert!(
        notification_objects(&[TextPart::Text {
            text: format!("{CELL_OBSERVATION}\n{running}"),
        }])
        .is_err()
    );
    for content in [
        json!([]),
        json!("not JSON"),
        json!(r#"[{"type":"image","text":"{}"}]"#),
        json!(r#"[{"type":"text","text":{}}]"#),
        json!(r#"[{"type":"text","text":"prefix {\"state\":\"running\"}"}]"#),
    ] {
        assert!(
            tool_objects(&content).is_err(),
            "unexpected tool content must fail: {content}"
        );
    }
    assert!(cell_observation(&[input]).is_err());
    assert!(cell_observation(&[running.clone(), running]).is_err());
    let native_completed = json!({"state":"completed","cell_id":cell,"result":{"ok":true}});
    let values = tool_objects(&json!(native_completed.to_string())).unwrap();
    assert_eq!(cell_observation(&values).unwrap().1, cell);
    let native_interrupted = json!({"state":"interrupted","cell_id":cell,"diagnostic":"process is confirmed gone","heap":"expired","bindings":"invalid"});
    let values = tool_objects(&json!(native_interrupted.to_string())).unwrap();
    assert_eq!(cell_observation(&values).unwrap().1, cell);
    for summary in [
        json!({"state":"completed","cell":cell,"cell_id":cell,"result":{"ok":true}}),
        json!({"state":"completed","result":{"ok":true}}),
        json!({"state":"completed","cell":cell,"result":{"ok":true},"unknown":true}),
        json!({"state":"completed","cell_id":Uuid::nil(),"result":{"ok":true}}),
        json!({"cell":cell,"state":"interrupted","diagnostic":"process is confirmed gone","children":{}}),
        json!({"state":"interrupted","cell_id":cell,"diagnostic":"process is confirmed gone","heap":"retained","bindings":"invalid"}),
        json!({"state":"interrupted","cell_id":cell,"diagnostic":"process is confirmed gone","heap":"expired","bindings":"valid"}),
        json!({"state":"interrupted","cell_id":cell,"report":{"cell":cell,"children":{}},"heap":"expired","bindings":"invalid"}),
    ] {
        assert!(cell_observation(&[summary]).is_err());
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Step {
    ResetComputer,
    DeniedComputerEvaluation,
    Baseline,
    Draft,
    Interrupted,
    Report,
    Read,
    Done,
}

struct Model {
    nonce: String,
    baseline_code: String,
    draft_code: String,
    read_code: String,
    step: Step,
    serial: u32,
    pending: String,
    baseline: Option<Value>,
    draft: Option<Value>,
    read: Option<Value>,
    child_operation: Option<String>,
    child_output: Option<Value>,
    reopened: bool,
    baseline_ready: bool,
    read_ready: bool,
}

impl Model {
    fn tool(&mut self, name: &str, input: Value) -> String {
        self.serial += 1;
        self.pending = format!("{}-{}", self.nonce, self.serial);
        sse(
            json!({"tool_calls":[{"index":0,"id":self.pending,"type":"function",
            "function":{"name":name,"arguments":input.to_string()}}]}),
            "tool_calls",
        )
    }

    fn exec(&mut self, code: String) -> String {
        self.tool(
            "exec",
            json!({"code":code,"yield_time_ms":10000,"max_output_tokens":10000}),
        )
    }

    fn wait(&mut self, cell: Value) -> String {
        self.tool(
            "wait",
            json!({"cell_id":cell,"yield_time_ms":1000,"max_tokens":10000,"terminate":false}),
        )
    }

    fn check_child_knowledge(&self, user_parts: &[Vec<TextPart>], cell: &Value) {
        let operation = self
            .child_operation
            .as_ref()
            .expect("offline original child before reopen");
        let mut knowledge = user_parts.iter().filter_map(|parts| {
            let (TextPart::Text { text }, rest) = parts.split_first()?;
            let header = text.strip_prefix(CELL_KNOWLEDGE)?.strip_prefix('\n')?;
            let header: Value = serde_json::from_str(header).expect("Cell knowledge header");
            (header["cell"] == *cell).then_some((header, rest))
        });
        let (header, evidence) = knowledge
            .next()
            .expect("model knowledge for the interrupted Cell");
        assert!(
            knowledge.next().is_none(),
            "one child knowledge message for the interrupted Cell"
        );
        assert_eq!(header, json!({"cell":cell}));
        let [
            TextPart::Text { text: call },
            TextPart::Text { text: result },
            TextPart::Text { text: output },
        ] = evidence
        else {
            panic!("expected one Shell invocation and one provider result");
        };
        let call: Value = serde_json::from_str(call).expect("child invocation JSON");
        assert_eq!(call["operation"], operation.as_str());
        assert_eq!(call["name"], "Shell");
        assert_eq!(call["input"]["title"], "Write the durability marker");
        assert!(
            call["input"]["command"]
                .as_str()
                .unwrap()
                .contains(&self.nonce)
        );
        assert_eq!(
            serde_json::from_str::<Value>(result).expect("child result header"),
            json!({"operation":operation,"evidence":"providerResult","isError":false})
        );
        assert_eq!(
            &serde_json::from_str::<Value>(output).expect("original Shell result"),
            self.child_output.as_ref().expect("original Shell output")
        );
    }

    fn answer(&mut self, body: &Value, observed: &mpsc::UnboundedSender<()>) -> String {
        let messages = body["messages"].as_array().expect("actual model messages");
        if !messages.iter().any(|message| {
            message["role"] == "user" && message["content"].to_string().contains(&self.nonce)
        }) || !body["tools"]
            .as_array()
            .is_some_and(|tools| tools.iter().any(|tool| tool["function"]["name"] == "exec"))
        {
            return sse(json!({"content":"auxiliary complete"}), "stop");
        }
        let tools = body["tools"].as_array().unwrap();
        for name in ["cua_repl", "cua_reset"] {
            assert!(
                tools.iter().any(|tool| tool["function"]["name"] == name),
                "Code Mode with tool discovery must advertise {name} as a direct tool"
            );
        }
        for (name, field) in [("exec", "code"), ("wait", "cell_id")] {
            let tool = tools
                .iter()
                .find(|tool| tool["function"]["name"] == name)
                .unwrap();
            assert!(
                tool["function"]["parameters"]["properties"]
                    .get(field)
                    .is_some()
            );
        }
        if self.step == Step::Interrupted {
            assert!(
                self.reopened,
                "no additional original model attempt before the crash"
            );
            let user_parts: Vec<_> = messages
                .iter()
                .filter(|message| message["role"] == "user")
                .map(|message| user_text_parts(&message["content"]).expect("actual user content"))
                .collect();
            let notice = user_parts
                .iter()
                .flat_map(|parts| {
                    notification_objects(parts).expect("actual user notification wire")
                })
                .find(|value| {
                    value["state"] == "interrupted" && Some(&value["cell"]) == self.draft.as_ref()
                })
                .expect("Engine must deliver the original Cell interruption in the same Run");
            self.check_child_knowledge(&user_parts, &notice["cell"]);
            assert!(
                notice["diagnostic"]
                    .as_str()
                    .unwrap()
                    .contains("process is confirmed gone")
            );
            self.step = Step::Report;
            return self.wait(self.draft.clone().unwrap());
        }
        if self.step == Step::ResetComputer && self.pending.is_empty() {
            return self.tool("cua_reset", json!({}));
        }
        assert_ne!(
            self.step,
            Step::Done,
            "a completed Run must not request another model attempt"
        );
        let output = messages
            .iter()
            .find(|message| message["role"] == "tool" && message["tool_call_id"] == self.pending)
            .expect("actual result of the exact previous call");
        if self.step == Step::ResetComputer {
            assert!(
                output["content"]
                    .to_string()
                    .contains("Computer Use REPL reset. Bind targets again."),
                "model must receive the saved CUA output: {output}"
            );
            self.step = Step::DeniedComputerEvaluation;
            return self.tool(
                "cua_repl",
                json!({"code":"await cua.listWindows({emit: false})"}),
            );
        }
        if self.step == Step::DeniedComputerEvaluation {
            assert!(
                output["content"]
                    .to_string()
                    .contains("desktop and browser resources cannot prove compatibility with the caller's sandbox floor"),
                "model must receive the original CUA error: {output}"
            );
            self.step = Step::Baseline;
            return self.exec(self.baseline_code.clone());
        }
        let values = tool_objects(&output["content"])
            .unwrap_or_else(|error| panic!("{error}; actual tool result: {output}"));
        let (summary, cell) = cell_observation(&values)
            .unwrap_or_else(|error| panic!("{error}; actual tool result: {output}"));
        match self.step {
            Step::Baseline => {
                if let Some(original) = &self.baseline {
                    assert_eq!(&cell, original);
                }
                self.baseline = Some(cell.clone());
                self.baseline_ready |= values
                    .iter()
                    .any(|value| value["stage"] == "baselineReady" && value["nonce"] == self.nonce);
                if summary["state"] == "running" {
                    return self.wait(cell);
                }
                assert_eq!(summary["state"], "completed", "{output}");
                assert!(
                    self.baseline_ready,
                    "actual baseline output must have been delivered"
                );
                self.step = Step::Draft;
                self.exec(self.draft_code.clone())
            }
            Step::Draft => {
                if let Some(original) = &self.draft {
                    assert_eq!(&cell, original);
                }
                self.draft = Some(cell.clone());
                assert_eq!(
                    summary["state"], "running",
                    "draft must not finish before SIGKILL: {output}"
                );
                let Some(marker) = values
                    .iter()
                    .find(|value| value["stage"] == "draftReady" && value["nonce"] == self.nonce)
                else {
                    return self.wait(cell);
                };
                assert_eq!(marker["a"], 2);
                assert_eq!(marker["b"], 3);
                shell_output(&marker["child"], &self.nonce);
                self.child_output = Some(marker["child"].clone());
                self.step = Step::Interrupted;
                observed.send(()).unwrap();
                // Complete this upstream attempt. Engine now waits for the Cell,
                // rather than losing another open model stream at SIGKILL.
                sse(json!({"content":"Waiting for the admitted Cell."}), "stop")
            }
            Step::Report => {
                assert_eq!(Some(&cell), self.draft.as_ref());
                assert_eq!(summary["state"], "interrupted", "{output}");
                assert_eq!(summary["heap"], "expired");
                assert_eq!(summary["bindings"], "invalid");
                assert!(
                    summary["diagnostic"]
                        .as_str()
                        .unwrap()
                        .contains("process is confirmed gone")
                );
                self.step = Step::Read;
                self.exec(self.read_code.clone())
            }
            Step::Read => {
                if let Some(original) = &self.read {
                    assert_eq!(&cell, original);
                }
                self.read = Some(cell.clone());
                if let Some(marker) = values
                    .iter()
                    .find(|value| value["stage"] == "canonicalRead" && value["nonce"] == self.nonce)
                {
                    assert_eq!(marker["a"], 1);
                    assert_eq!(marker["b_missing"], true);
                    self.read_ready = true;
                }
                if summary["state"] == "running" {
                    return self.wait(cell);
                }
                assert_eq!(summary["state"], "completed", "{output}");
                assert!(
                    self.read_ready,
                    "actual new Cell load result must have been delivered"
                );
                assert_ne!(Some(&cell), self.baseline.as_ref());
                assert_ne!(Some(&cell), self.draft.as_ref());
                self.step = Step::Done;
                sse(
                    json!({"content":"Canonical value preserved; interrupted draft discarded."}),
                    "stop",
                )
            }
            _ => unreachable!(),
        }
    }
}

async fn serve(
    listener: TcpListener,
    model: Arc<Mutex<Model>>,
    observed: mpsc::UnboundedSender<()>,
    stop: CancellationToken,
) -> Result<()> {
    let mut connections = JoinSet::new();
    let mut errors = Vec::new();
    loop {
        tokio::select! {
            _ = stop.cancelled() => break,
            joined = connections.join_next(), if !connections.is_empty() => {
                match joined.unwrap() {
                    Ok(Ok(())) => {},
                    other => { errors.push(format!("model connection: {other:?}")); break; }
                }
            }
            accepted = listener.accept() => {
                let (socket, _) = match accepted { Ok(socket) => socket, Err(error) => { errors.push(error.to_string()); break; } };
                let (model, observed, connection_stop) = (model.clone(), observed.clone(), stop.clone());
                connections.spawn(async move {
                    let service = service_fn(move |request: Request<Incoming>| {
                        let (model, observed) = (model.clone(), observed.clone());
                        async move {
                            let response = if request.method() == hyper::Method::GET {
                                assert!(request.uri().path().ends_with("/models"));
                                response(json!({"object":"list","data":[{"id":"gpt-4.1","object":"model"}]}).to_string(), "application/json")
                            } else {
                                assert!(request.uri().path().ends_with("/chat/completions"));
                                let bytes = request.into_body().collect().await.unwrap().to_bytes();
                                let body: Value = serde_json::from_slice(&bytes).unwrap();
                                response(model.lock().unwrap().answer(&body, &observed), "text/event-stream")
                            };
                            Ok::<_, Infallible>(response)
                        }
                    });
                    tokio::select! {
                        _ = connection_stop.cancelled() => Ok(()),
                        result = hyper::server::conn::http1::Builder::new().keep_alive(false)
                            .serve_connection(TokioIo::new(socket), service) => result.map_err(|error| error.to_string()),
                    }
                });
            }
        }
    }
    stop.cancel();
    while let Some(joined) = connections.join_next().await {
        match joined {
            Ok(Ok(())) => {}
            other => errors.push(format!("model drain: {other:?}")),
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn work_metadata(value: &Value) -> Value {
    let execution = &value["execution"];
    let state = &execution["state"];
    let waits: Vec<_> = state["waits"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|wait| {
            json!({"kind":wait["kind"],"cell":wait["cell"],"task":wait["task"],
            "attempt":wait["attempt"],"approval":wait["approval"],"run":wait["run"],
            "blocker":wait["blocker"],"tool":wait["tool"].as_object().map(|_| {
                json!({"attempt":wait["tool"]["attempt"],"call":wait["tool"]["call"]})
            })})
        })
        .collect();
    let blockers: Vec<_> = state["blockers"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|blocker| json!({"id":blocker["id"],"reason":{"kind":blocker["reason"]["kind"]}}))
        .collect();
    json!({"kind":value["kind"],"shared":value["shared"],
        "execution":{"sessionId":execution["sessionId"],"turnId":execution["turnId"],
            "runId":execution["runId"],"highWater":execution["highWater"],
            "state":{"kind":state["kind"],"waits":waits,"blockers":blockers}},
        "pendingInteractions":value["pendingInteractions"]})
}

#[derive(Debug, Default)]
struct WorkObservations {
    first: Option<Result<Value>>,
    last: Option<Result<Value>>,
}

async fn execution(
    client: &Client,
    session: &str,
    target: &Value,
    cell: Option<&Value>,
    mut observations: Option<&mut WorkObservations>,
) -> Result<Value> {
    loop {
        let work = phase("original Run observation", async {
            let work = client
                .query(
                    "agent",
                    "work",
                    json!({"sessionId":session,"target":target}),
                )
                .await;
            if let Some(observations) = observations.as_deref_mut() {
                let metadata = work
                    .as_ref()
                    .map(work_metadata)
                    .map_err(|error| error.clone());
                if observations.first.is_none() {
                    observations.first = Some(metadata.clone());
                }
                observations.last = Some(metadata);
            }
            work
        })
        .await?;
        match work["kind"].as_str() {
            Some("pending") => {}
            Some("delivered") => {
                let execution = &work["execution"];
                let state = &execution["state"];
                match (cell, state["kind"].as_str()) {
                    (None, Some("completed")) => return Ok(execution.clone()),
                    (Some(cell), Some("waiting"))
                        if state["waits"] == json!([{"kind":"cell","cell":cell}]) =>
                    {
                        return Ok(execution.clone());
                    }
                    (_, Some("admitted" | "running" | "waiting")) => {}
                    _ => return Err(format!("unexpected original Run: {}", work_metadata(&work))),
                }
            }
            _ => {
                return Err(format!(
                    "original Run unavailable: {}",
                    work_metadata(&work)
                ));
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn inspect(
    sandbox: &Sandbox,
    session: &str,
    children: &mut Vec<(Child, ChildStdout)>,
) -> Result<Value> {
    let mut command = host::command(sandbox)?;
    let mut child = command
        .args(["inspect", "--root"])
        .arg(&sandbox.root)
        .args(["--session", session])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| error.to_string())?;
    let stdout = child.stdout.take().unwrap();
    children.push((child, stdout));
    let (child, stdout) = children.last_mut().unwrap();
    let mut bytes = Vec::new();
    let (eof, status) = tokio::join!(stdout.read_to_end(&mut bytes), child.wait());
    match (eof, status) {
        (Ok(_), Ok(status)) if status.success() => {}
        other => return Err(format!("inspect stdout EOF/physical wait: {other:?}")),
    }
    let inspection: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    assert_eq!(inspection["truncated"], false);
    Ok(inspection)
}

fn records(inspection: &Value, run: &Value) -> Vec<Value> {
    inspection["facts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| &row["item"]["recorded"])
        .filter(|record| &record["run"] == run)
        .cloned()
        .collect()
}

fn event_rows<'a>(inspection: &'a Value, run: &Value, cell: &Value, kind: &str) -> Vec<&'a Value> {
    inspection["facts"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| {
            let record = &row["item"]["recorded"];
            let event = &record["fact"]["event"];
            &record["run"] == run
                && record["fact"]["kind"] == "cell"
                && &event["cell"] == cell
                && event["kind"] == kind
        })
        .collect()
}

fn one_event<'a>(inspection: &'a Value, run: &Value, cell: &Value, kind: &str) -> &'a Value {
    let rows = event_rows(inspection, run, cell, kind);
    assert_eq!(rows.len(), 1, "one original {kind}: {cell}");
    rows[0]
}

async fn source(
    client: &Client,
    session: &str,
    inspection: &Value,
    row: &Value,
    field: &str,
) -> Result<Value> {
    let item = &row["item"];
    let mut position = json!({"kind":"start"});
    let mut text = String::new();
    loop {
        let page = phase("authorized original Cell source", client.query("agent", "source", json!({
            "sessionId":session,"through":inspection["through"],
            "source":{"kind":"row","position":{"kind":"live","sequence":item["sequence"],"fact":item["recorded"]["id"],"itemIndex":0}},
            "field":field,"path":null,"position":position,
        }))).await?;
        assert_eq!(page["kind"], "ready");
        let value = &page["source"];
        assert_eq!(value["format"], "json");
        assert_eq!(value["offset"].as_u64(), Some(text.len() as u64));
        let chunk = value["text"].as_str().unwrap();
        text.push_str(chunk);
        let total = value["totalBytes"].as_u64().unwrap();
        if text.len() as u64 == total {
            break;
        }
        assert!(!chunk.is_empty() && (text.len() as u64) < total);
        position = json!({"kind":"after","offset":text.len()});
    }
    serde_json::from_str(&text).map_err(|error| format!("canonical source JSON: {error}"))
}

#[expect(
    clippy::too_many_arguments,
    reason = "Test resources stay separately owned for exact process cleanup after a fault"
)]
async fn case(
    sandbox: &Sandbox,
    hosts: &mut Vec<Host>,
    clients: &mut Vec<Client>,
    inspectors: &mut Vec<(Child, ChildStdout)>,
    model: &Arc<Mutex<Model>>,
    observed: &mut mpsc::UnboundedReceiver<()>,
    base: &str,
    language: CodeLanguage,
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
        let created = store.create_connection(serde_json::from_value(json!({
            "expectedCatalogRevision":0,"connection":{
                "slug":"codemode","name":"CodeMode loopback","provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"openai-compatible"},
                "configuration":{"baseUrl":base},"enabled":true,"enabledModelIds":["gpt-4.1"],
                "modelOverrides":{"gpt-4.1":{"codeMode":true,"codeModeLanguage":language,"apiProtocol":"openai-chat-completions"}}
            }
        })).unwrap()).await;
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
    hosts.push(Host::spawn(sandbox)?);
    let (first, _) = phase("first default Host ready", hosts[0].ready()).await?;
    let epoch = first.epoch();
    let original_source = first.source().clone();
    let publication =
        serde_json::to_value(phase("original publication", first.publication()).await?).unwrap();
    clients.push(Client::new(
        first,
        phase("external client Journal", Journal::open(&sandbox.journal)).await?,
        "receipts".into(),
    )?);
    let detail = phase(
        "credential target",
        clients[0].query("settings", "connection", json!({"connectionId":connection})),
    )
    .await?;
    assert_eq!(detail["kind"], "ready");
    let secret: Arc<dyn ReadResource> = Arc::new(FixtureKey);
    let saved = mutate(
        &clients[0],
        "settings",
        "saveCredential",
        json!({"expected":detail["target"],"expectedCredential":null}),
        Attachments::from([("secret".into(), secret)]),
    )
    .await?;
    assert_eq!(saved["kind"], "saved");
    let created = mutate(&clients[0], "agent", "create", json!({
        "title":"CodeMode canonical store and cold Root","automaticTitle":false,"labels":[],"tools":["Shell","cua_repl","cua_reset"],
        "workspace":{"kind":"directory","path":sandbox.workspace},
        "backend":{"kind":"model","connectionId":connection,"modelId":"gpt-4.1","thinkingLevel":null}
    }), Attachments::new()).await?;
    assert_eq!(created["kind"], "created");
    let session = created["session"]["id"].as_str().unwrap();
    let nonce = model.lock().unwrap().nonce.clone();
    let sent = mutate(&clients[0], "agent", "send", json!({"sessionId":session,"message":format!("Run the CodeMode durability scenario {nonce}."),"delivery":"queue"}), Attachments::new()).await?;
    assert_eq!(sent["kind"], "queued");
    let draft_deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    match tokio::time::timeout_at(draft_deadline - Duration::from_secs(10), observed.recv()).await {
        Ok(Some(())) => {}
        Ok(None) => return Err("loopback model lost its original observation channel".into()),
        Err(_) => {
            let diagnostic = tokio::time::timeout(Duration::from_secs(5), clients[0].query(
                "agent", "work", json!({"sessionId":session,"target":{"kind":"message","messageId":sent["messageId"]}})
            )).await.map(|result| result.map(|work| work_metadata(&work)));
            eprintln!("draftReady pending; original public work: {diagnostic:?}");
            match tokio::time::timeout_at(draft_deadline, observed.recv()).await {
                Ok(Some(())) => {}
                result => {
                    return Err(format!(
                        "draftReady did not reach the actual next model request: {result:?}; original public work: {diagnostic:?}"
                    ));
                }
            }
        }
    }
    let (baseline, draft) = {
        let state = model.lock().unwrap();
        (
            state.baseline.clone().unwrap(),
            state.draft.clone().unwrap(),
        )
    };
    let waiting = phase(
        "public Waiting Cell after normal model completion",
        execution(
            &clients[0],
            session,
            &json!({"kind":"message","messageId":sent["messageId"]}),
            Some(&draft),
            None,
        ),
    )
    .await?;
    let run = waiting["runId"].clone();
    let target = json!({"kind":"run","runId":run});
    let current = phase(
        "canonical execution Waiting Cell",
        clients[0].query(
            "agent",
            "execution",
            json!({"sessionId":session,"runId":run}),
        ),
    )
    .await?;
    assert_eq!(current["kind"], "found");
    assert_eq!(current["execution"]["runId"], run);
    assert_eq!(
        current["execution"]["state"],
        json!({"kind":"waiting","waits":[{"kind":"cell","cell":draft}],"authorityUnavailable":false})
    );
    let expected_effect = format!("{nonce}\n");
    assert_eq!(
        tokio::fs::read_to_string(sandbox.workspace.join("effects.log"))
            .await
            .map_err(|error| error.to_string())?,
        expected_effect
    );
    phase("close settled first client", clients[0].close()).await?;
    phase(
        "SIGKILL exact original Host, EOF and wait",
        hosts[0].sigkill(),
    )
    .await?;
    let before = phase(
        "offline original canonical facts",
        inspect(sandbox, session, inspectors),
    )
    .await?;
    let old = records(&before, &run);
    assert_eq!(
        old.iter()
            .filter(|record| record["fact"]["kind"] == "run_admitted")
            .count(),
        1
    );
    let first_started = one_event(&before, &run, &baseline, "started");
    let draft_started = one_event(&before, &run, &draft, "started");
    assert_ne!(
        first_started["item"]["recorded"]["id"],
        draft_started["item"]["recorded"]["id"]
    );
    one_event(&before, &run, &baseline, "completed");
    one_event(&before, &run, &baseline, "result_accepted");
    let published = one_event(&before, &run, &baseline, "session_value_published");
    assert_eq!(published["item"]["recorded"]["fact"]["event"]["key"], "a");
    let value_one = maka_agent_state::ContentBlob::json(&json!(1)).unwrap();
    assert_eq!(
        published["item"]["recorded"]["fact"]["event"]["value"],
        serde_json::to_value(value_one.reference()).unwrap()
    );
    for kind in [
        "completed",
        "interrupted",
        "result_accepted",
        "session_value_published",
    ] {
        assert!(
            event_rows(&before, &run, &draft, kind).is_empty(),
            "Cell2 must still be Running, without accepted draft: {kind}"
        );
    }
    let vm = one_event(&before, &run, &draft, "vm_bound");
    assert_eq!(
        vm["item"]["recorded"]["fact"]["event"]["binding"]["runtime"],
        match language {
            CodeLanguage::JavaScript => "maka.javascript.v8-host",
            CodeLanguage::Python => "maka.python.monty-child",
        }
    );
    let source_blob =
        maka_agent_state::ContentBlob::new(model.lock().unwrap().draft_code.as_bytes().to_vec());
    assert_eq!(
        draft_started["item"]["recorded"]["fact"]["event"]["source"],
        serde_json::to_value(source_blob.reference()).unwrap()
    );
    let bound = one_event(&before, &run, &draft, "child_bound");
    let known = one_event(&before, &run, &draft, "child_observed");
    let bound_event = &bound["item"]["recorded"]["fact"]["event"];
    let known_event = &known["item"]["recorded"]["fact"]["event"];
    let child_reply: RecordedOperationReply =
        serde_json::from_value(known_event["reply"].clone()).unwrap();
    assert_eq!(
        serde_json::to_value(&child_reply.reference).unwrap(),
        bound_event["reference"]
    );
    assert_eq!(known_event["operation"], bound_event["operation"]);
    assert!(
        matches!(
            &child_reply.receipt,
            Receipt::Recorded {
                outcome: OperationOutcome::Returned {
                    result: RecordedOperationResult::Referenced {
                        is_error: false,
                        ..
                    }
                },
                cleanup: OperationCleanup::Confirmed
            }
        ),
        "known successful original result: {child_reply:?}"
    );
    let child_result = one_event(&before, &run, &draft, "child_result_recorded");
    one_event(&before, &run, &draft, "child_admitted");
    let prepared = one_event(&before, &run, &draft, "child_prepared");
    assert_eq!(
        prepared["item"]["recorded"]["fact"]["event"]["name"],
        "Shell"
    );
    let admitted_attempts: Vec<_> = old
        .iter()
        .filter(|record| record["fact"]["kind"] == "model_attempt_prepared")
        .collect();
    assert!(admitted_attempts.len() >= 3);
    for attempt in admitted_attempts {
        let attempt = &attempt["fact"]["attempt"];
        assert!(
            old.iter()
                .any(|record| record["fact"]["kind"] == "model_closed"
                    && &record["fact"]["attempt"] == attempt)
        );
        assert!(
            old.iter()
                .any(|record| record["fact"]["kind"] == "model_cleanup_observed"
                    && &record["fact"]["attempt"] == attempt
                    && record["fact"]["cleanup"]
                        == serde_json::to_value(OperationCleanup::Confirmed).unwrap())
        );
    }
    {
        let mut state = model.lock().unwrap();
        assert_eq!(state.step, Step::Interrupted);
        state.child_operation = Some(bound_event["operation"].as_str().unwrap().to_owned());
        state.reopened = true;
    }
    hosts.push(Host::spawn(sandbox)?);
    let (mut reopened, address) = phase("reopened default Host ready", hosts[1].ready()).await?;
    assert_ne!(reopened.epoch(), epoch);
    assert_eq!(reopened.source(), &original_source);
    assert_eq!(
        serde_json::to_value(phase("same publication", reopened.publication()).await?).unwrap(),
        publication
    );
    clients.push(Client::new(
        phase(
            "reopened independent client",
            HostClient::connect(&address, Some(reopened.epoch())),
        )
        .await?,
        phase(
            "reopen same external Journal",
            Journal::open(&sandbox.journal),
        )
        .await?,
        "receipts".into(),
    )?);
    let known_receipt = source(&clients[1], session, &before, known, "receipt").await?;
    let resolved: OperationReply = serde_json::from_value(known_receipt["reply"].clone()).unwrap();
    assert_eq!(resolved.reference, child_reply.reference);
    let resolved_inline = inline_reply(resolved.clone());
    match (&child_reply.receipt, &resolved_inline.receipt) {
        (
            Receipt::Recorded {
                outcome: original,
                cleanup: original_cleanup,
            },
            Receipt::Recorded {
                outcome: recovered,
                cleanup: recovered_cleanup,
            },
        ) => {
            assert_eq!(original_cleanup, recovered_cleanup);
            assert!(
                same_outcome(original, recovered).unwrap(),
                "the recovered receipt must retain the original recorded result"
            );
        }
        other => panic!("original receipt must stay recorded: {other:?}"),
    }
    let mut expanded_event = known_event.clone();
    expanded_event["reply"] = serde_json::to_value(&resolved).unwrap();
    assert_eq!(known_receipt, expanded_event);
    shell_output(&success(&resolved), &nonce);
    let mut observations = WorkObservations::default();
    let completion = phase(
        "same Run interrupted notification, old wait, and new exec",
        execution(&clients[1], session, &target, None, Some(&mut observations)),
    )
    .await;
    let completed = match completion {
        Ok(completed) => completed,
        Err(error) => {
            let waiting = work_metadata(&json!({"kind":"delivered","execution":waiting}));
            let state = model.lock().map(|state| {
                json!({"step":format!("{:?}", state.step),"pending":state.pending,"reopened":state.reopened})
            }).map_err(|_| "model state lock poisoned");
            return Err(format!(
                "{error}; pre-reopen work metadata: {waiting}; post-reopen original work: {observations:?}; model={state:?}"
            ));
        }
    };
    assert_eq!(completed["runId"], run);
    assert_eq!(completed["turnId"], waiting["turnId"]);
    assert_eq!(
        source(&clients[1], session, &before, published, "result").await?,
        json!(1)
    );
    assert_eq!(
        source(&clients[1], session, &before, known, "receipt").await?,
        known_receipt
    );
    let returned_child = source(&clients[1], session, &before, child_result, "result").await?;
    shell_output(&returned_child, &nonce);
    let card = phase("reopened Shell card", clients[1].query("agent", "source", json!({
        "sessionId":session,"through":before["through"],
        "source":{"kind":"row","position":{"kind":"live","sequence":child_result["item"]["sequence"],"fact":child_result["item"]["recorded"]["id"],"itemIndex":0}},
        "field":"result","path":["value","output","stdout"],"position":{"kind":"start"}
    }))).await?;
    assert_eq!(card["kind"], "ready");
    assert_eq!(card["source"]["text"].as_str().unwrap().trim(), nonce);
    let call = &card["source"]["tool"]["call"];
    assert_eq!(call["title"]["fallback"], "Write the durability marker");
    assert_eq!(call["presentation"], "maka.workspace.Processes@1/execute");
    let history = phase("reopened tool presentation", clients[1].query("agent", "history", json!({
        "sessionId":session,"through":before["through"],"position":{"kind":"tail"},"includeThinking":true,"view":"conversation"
    }))).await?;
    assert!(
        history["chunks"].as_array().unwrap().iter().any(|row| {
            row["tool"]["call"]["name"] == "exec"
                && row["tool"]["call"]["title"]["fallback"] == "Run script"
        }),
        "CodeMode keeps its producer-owned script label after reopening"
    );
    assert_eq!(model.lock().unwrap().step, Step::Done);
    assert_eq!(
        tokio::fs::read_to_string(sandbox.workspace.join("effects.log"))
            .await
            .map_err(|error| error.to_string())?,
        expected_effect
    );
    loop {
        let readiness = phase(
            "Root physical readiness",
            clients[1].query(
                "agent",
                "workReadiness",
                json!({"sessionId":session,"target":target}),
            ),
        )
        .await?;
        match readiness["kind"].as_str() {
            Some("ready") => break,
            Some("pending") => tokio::time::sleep(Duration::from_millis(20)).await,
            _ => return Err(format!("original Run readiness unavailable: {readiness}")),
        }
    }
    phase("close settled reopened client", clients[1].close()).await?;
    phase(
        "quit ACK, Host stdout EOF and wait",
        hosts[1].quit(&mut reopened),
    )
    .await?;
    let after = phase(
        "offline recovered canonical facts",
        inspect(sandbox, session, inspectors),
    )
    .await?;
    let new = records(&after, &run);
    assert!(
        new.starts_with(&old),
        "every original FactId/revision/source/ref must be retained exactly"
    );
    let interrupted = one_event(&after, &run, &draft, "interrupted");
    one_event(&after, &run, &draft, "started");
    one_event(&after, &run, &draft, "child_admitted");
    assert!(event_rows(&after, &run, &draft, "completed").is_empty());
    assert!(event_rows(&after, &run, &draft, "result_accepted").is_empty());
    assert!(event_rows(&after, &run, &draft, "session_value_published").is_empty());
    assert_eq!(
        one_event(&after, &run, &baseline, "session_value_published"),
        published
    );
    assert_eq!(one_event(&after, &run, &draft, "child_bound"), bound);
    assert_eq!(one_event(&after, &run, &draft, "child_observed"), known);
    assert_ne!(
        interrupted["item"]["recorded"]["fact"]["event"]["report"],
        Value::Null
    );
    let read = model.lock().unwrap().read.clone().unwrap();
    one_event(&after, &run, &read, "completed");
    one_event(&after, &run, &read, "result_accepted");
    assert_eq!(
        new.iter()
            .filter(|record| record["fact"]["kind"] == "run_admitted")
            .count(),
        1
    );
    assert_eq!(
        new.iter()
            .filter(|record| record["fact"]["kind"] == "run_terminated")
            .count(),
        1
    );
    assert_eq!(
        after["facts"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["item"]["recorded"]["fact"]["kind"] == "run_admitted")
            .count(),
        1,
        "cold recovery must not silently admit a replacement Run"
    );
    assert_eq!(
        tokio::fs::read_to_string(sandbox.workspace.join("effects.log"))
            .await
            .map_err(|error| error.to_string())?,
        expected_effect
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn javascript_cell_cold_root_preserves_accepted_values_and_never_replays_known_child() {
    cold_root(CodeLanguage::JavaScript).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn python_cell_cold_root_preserves_accepted_values_and_never_replays_known_child() {
    cold_root(CodeLanguage::Python).await;
}

fn cell_scripts(language: CodeLanguage, command: &str, nonce: &str) -> (String, String, String) {
    match language {
        CodeLanguage::JavaScript => (
            format!("store('a',1); text({{stage:'baselineReady',nonce:{nonce}}});"),
            format!(
                "if(load('a')!==1 || load('b')!==undefined) throw new Error('baseline not canonical');\nconst child=await tools.Shell({{command:{command},title:\"Write the durability marker\",login:false,timeout_ms:10000}});\nstore('a',2); store('b',3); text({{stage:'draftReady',nonce:{nonce},a:load('a'),b:load('b'),child}});\nawait yield_control(); await new Promise(resolve=>setTimeout(resolve,600000));"
            ),
            format!(
                "const a=load('a'); const b_missing=load('b')===undefined; if(a!==1 || !b_missing) throw new Error('interrupted draft leaked'); text({{stage:'canonicalRead',nonce:{nonce},a,b_missing}});"
            ),
        ),
        CodeLanguage::Python => (
            format!(
                r#"store("a", 1)
text({{"stage": "baselineReady", "nonce": {nonce}}})
"#
            ),
            format!(
                r#"import asyncio

if load("a") != 1 or load("b") is not None:
    raise ValueError("baseline not canonical")

child = await tools.Shell({{
    "command": {command},
    "title": "Write the durability marker",
    "login": False,
    "timeout_ms": 10000,
}})
store("a", 2)
store("b", 3)
text({{
    "stage": "draftReady",
    "nonce": {nonce},
    "a": load("a"),
    "b": load("b"),
    "child": child,
}})
await yield_control()
await asyncio.sleep(600)
"#
            ),
            format!(
                r#"a = load("a")
b_missing = load("b") is None
if a != 1 or not b_missing:
    raise ValueError("interrupted draft leaked")
text({{
    "stage": "canonicalRead",
    "nonce": {nonce},
    "a": a,
    "b_missing": b_missing,
}})
"#
            ),
        ),
    }
}

async fn cold_root(language: CodeLanguage) {
    let sandbox = Sandbox::new()
        .await
        .expect("owned HOME, Root, workspace and external Journal");
    let nonce = Uuid::new_v4().simple().to_string();
    let script = format!(
        "import os; f=open('effects.log','ab',buffering=0); f.write(b'{nonce}\\n'); os.fsync(f.fileno()); f.close(); print('{nonce}')"
    );
    let command = serde_json::to_string(&format!("python3 -c \"{script}\"")).unwrap();
    let quoted_nonce = serde_json::to_string(&nonce).unwrap();
    let (baseline_code, draft_code, read_code) = cell_scripts(language, &command, &quoted_nonce);
    let model = Arc::new(Mutex::new(Model {
        baseline_code,
        draft_code,
        read_code,
        nonce,
        step: Step::ResetComputer,
        serial: 0,
        pending: String::new(),
        baseline: None,
        draft: None,
        read: None,
        child_operation: None,
        child_output: None,
        reopened: false,
        baseline_ready: false,
        read_ready: false,
    }));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let (observed, mut observations) = mpsc::unbounded_channel();
    let stop = CancellationToken::new();
    let mut server = tokio::spawn(serve(listener, model.clone(), observed, stop.clone()));
    let mut server_collected = false;
    let mut hosts = Vec::new();
    let mut clients = Vec::new();
    let mut inspectors = Vec::new();
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(180), async {
        tokio::select! {
            result = case(&sandbox, &mut hosts, &mut clients, &mut inspectors, &model, &mut observations, &base, language) => result,
            result = &mut server => { server_collected = true; Err(format!("loopback model ended: {result:?}")) },
        }
    })).catch_unwind().await;
    let mut cleanup = Vec::new();
    for client in &clients {
        if let Err(error) = phase("owned client cleanup", client.close()).await {
            cleanup.push(error);
        }
    }
    for process in &mut hosts {
        if let Err(error) = phase("owned Host kill/wait/EOF cleanup", process.cleanup()).await {
            cleanup.push(error);
        }
    }
    for (child, stdout) in &mut inspectors {
        let result = phase("owned inspect child kill/wait/EOF", async {
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
                other => Err(format!(
                    "inspect stdout EOF/physical wait cleanup: {other:?}"
                )),
            }
        })
        .await;
        if let Err(error) = result {
            cleanup.push(error);
        }
    }
    stop.cancel();
    if !server_collected {
        match tokio::time::timeout(Duration::from_secs(30), &mut server).await {
            Ok(Ok(Ok(()))) => {}
            Ok(other) => cleanup.push(format!("model server join: {other:?}")),
            Err(error) => {
                cleanup.push(format!("model server drain: {error}"));
                server.abort();
                cleanup.push(format!(
                    "model server after cancellation: {:?}",
                    server.await
                ));
            }
        }
    }
    if !cleanup.is_empty() {
        eprintln!("codemode cleanup errors: {cleanup:?}");
    }
    match outcome {
        Ok(Ok(Ok(()))) => assert!(cleanup.is_empty(), "{cleanup:?}"),
        Ok(Ok(Err(error))) => panic!("CodeMode cold Root: {error}; cleanup={cleanup:?}"),
        Ok(Err(error)) => panic!("bounded CodeMode cold Root: {error}; cleanup={cleanup:?}"),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}
