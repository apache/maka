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
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use http_body_util::Full;
use hyper::{
    Request, Response,
    body::{Bytes, Incoming},
    service::service_fn,
};
use hyper_util::rt::TokioIo;
use tokio::{
    net::{TcpListener, TcpStream},
    task::JoinSet,
};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{Message, protocol::Role},
};
use tokio_util::sync::CancellationToken;

fn http_response(body: String, content_type: &str) -> Response<Full<Bytes>> {
    Response::builder()
        .header("content-type", content_type)
        .header("connection", "close")
        .body(Full::new(Bytes::from(body)))
        .unwrap()
}

// A protocol regression: the model and Chrome peers are controlled fixtures.
// The child Host still uses the real Root, authority, Bridge, REPL and CDP driver.
struct Peer {
    origin: String,
    marker: String,
    pixels: String,
    url: String,
    created: bool,
    methods: Vec<String>,
    preview_screenshots: usize,
    window_bounds: Value,
    canonical_sent: Option<tokio::sync::oneshot::Sender<()>>,
    canonical_ready: Option<tokio::sync::oneshot::Receiver<()>>,
    presentation_done: Option<tokio::sync::oneshot::Sender<()>>,
    resume_model: Option<tokio::sync::oneshot::Receiver<()>>,
    close_result_seen: bool,
    model_requests: usize,
    model_result: Option<Value>,
    model_pages: String,
}
impl Peer {
    fn tab(&self) -> Value {
        json!({"id":"owned","type":"page","title":self.marker,"url":self.url,
            "webSocketDebuggerUrl":format!("{}/devtools/page/owned",self.origin.replacen("http", "ws", 1))})
    }
    fn generation(&self) -> String {
        format!(
            "{}/devtools/browser/fixture",
            self.origin.replacen("http", "ws", 1)
        )
    }
    fn frame(&self) -> Value {
        json!({"frameTree":{"frame":{"id":"main","loaderId":self.url,"url":self.url,
            "securityOrigin":if self.url=="about:blank" {"null"} else {&self.origin}}}})
    }
    fn script(&self) -> String {
        format!(
            r#"const browser = await cua.getBrowser({{id:'owned-stack'}});
const tab = await browser.tabs.new();
await tab.goto({url});
const ax = await tab.getAXState({{emit:false,disableDiffing:true}});
if (!ax.includes({marker})) throw new Error('AX marker missing');
const pixels = Array.from(await tab.screenshot({{fullPage:true}}));
nodeRepl.write(JSON.stringify({{marker:{marker},ax,pixels}}));"#,
            url = json!(format!("{}/fixture", self.origin)),
            marker = json!(self.marker)
        )
    }
    fn cdp(&mut self, request: &Value) -> Result<(Value, Option<Value>)> {
        let method = request["method"].as_str().ok_or("CDP method missing")?;
        let p = &request["params"];
        // Preserve original-tool counts while observing live viewport reads separately.
        if method == "Page.captureScreenshot" && p["quality"] == 75 {
            self.preview_screenshots += 1;
        } else {
            self.methods.push(method.into());
        }
        let mut event = None;
        let result = match method {
            "Target.createTarget" => {
                assert_eq!(p, &json!({"url":"about:blank","background":true}));
                assert!(!self.created, "target creation replayed");
                self.created = true;
                json!({"targetId":"owned"})
            }
            "Page.getFrameTree" => self.frame(),
            "Runtime.enable"
            | "Page.enable"
            | "Target.setAutoAttach"
            | "Runtime.releaseObjectGroup" => json!({}),
            "Page.createIsolatedWorld" => {
                assert_eq!(p["frameId"], "main");
                assert!(
                    p["worldName"]
                        .as_str()
                        .unwrap()
                        .starts_with("maka-browser-origin-metadata-")
                );
                assert_eq!(p["grantUniveralAccess"], false);
                event = Some(
                    json!({"method":"Runtime.executionContextCreated","params":{"context":{
                    "id":17,"uniqueId":format!("realm:{}",self.url),"name":p["worldName"],
                    "auxData":{"frameId":"main","isDefault":false}}}}),
                );
                json!({"executionContextId":17})
            }
            "Runtime.evaluate" => {
                let expression = p["expression"].as_str().ok_or("expression missing")?;
                match expression {
                    "document.readyState" => json!({"result":{"type":"string","value":"complete"}}),
                    "window.devicePixelRatio" => json!({"result":{"type":"number","value":1}}),
                    expression
                        if expression.contains(
                            "Object.getOwnPropertyDescriptor(Window.prototype, 'origin')",
                        ) =>
                    {
                        assert_eq!(p["uniqueContextId"], format!("realm:{}", self.url));
                        json!({"result":{"type":"string","value":if self.url=="about:blank" {"null"} else {&self.origin}}})
                    }
                    other => return Err(format!("unexpected CDP expression: {other}")),
                }
            }
            "Page.navigate" => {
                assert_eq!(p["url"], format!("{}/fixture", self.origin));
                assert_eq!(self.url, "about:blank", "navigation replayed");
                self.url = p["url"].as_str().unwrap().into();
                json!({"frameId":"main","loaderId":self.url})
            }
            "Accessibility.getFullAXTree" => json!({"nodes":[
                {"nodeId":"root","ignored":false,"role":{"value":"RootWebArea"},"name":{"value":"fixture"},"childIds":["marker"]},
                {"nodeId":"marker","parentId":"root","ignored":false,"backendDOMNodeId":2,
                    "role":{"value":"button"},"name":{"value":self.marker}}
            ]}),
            "DOM.getDocument" => {
                json!({"root":{"nodeId":1,"nodeType":9,"nodeName":"#document","backendNodeId":1,
                "children":[{"nodeId":2,"nodeType":1,"nodeName":"BUTTON","localName":"button","backendNodeId":2,
                    "attributes":["aria-label",self.marker]}]}})
            }
            "DOMSnapshot.captureSnapshot" => {
                json!({"strings":["block","visible","1","auto","none"],"documents":[{
                "nodes":{"backendNodeId":[1,2]},"layout":{"nodeIndex":[0,1],"bounds":[[0,0,2,2],[0,0,2,2]],
                "styles":[[],[]],"paintOrders":[0,1],"text":[-1,-1]}}]})
            }
            "Page.getLayoutMetrics" => json!({"cssContentSize":{"x":0,"y":0,"width":2,"height":2},
                "cssVisualViewport":{"pageX":0,"pageY":0,"clientWidth":2,"clientHeight":2,"scale":1}}),
            "Page.captureScreenshot" => {
                assert_eq!(p["format"], "jpeg");
                if p["quality"] == 75 {
                    assert_eq!(
                        p,
                        &json!({"format":"jpeg","quality":75,"captureBeyondViewport":false}),
                    );
                } else {
                    assert_eq!(p["quality"], 80);
                    assert_eq!(p["clip"]["width"], 2.0);
                    assert_eq!(p["clip"]["height"], 2.0);
                }
                json!({"data":self.pixels})
            }
            "Browser.getWindowForTarget" | "Browser.getWindowBounds" => {
                assert!(self.created, "window queried after owned tab closed");
                if method == "Browser.getWindowForTarget" {
                    assert_eq!(p, &json!({}));
                    json!({"windowId":7,"bounds":self.window_bounds})
                } else {
                    assert_eq!(p, &json!({"windowId":7}));
                    json!({"bounds":self.window_bounds})
                }
            }
            "Browser.setWindowBounds" => {
                assert!(self.created);
                assert_eq!(p["windowId"], 7);
                if self.window_bounds["windowState"] != "normal" {
                    assert_eq!(p["bounds"], json!({"windowState":"normal"}));
                    self.window_bounds["windowState"] = json!("normal");
                    return Ok((json!({}), None));
                }
                assert_eq!(
                    p["bounds"],
                    json!({"left":200,"top":100,"width":800,"height":600})
                );
                self.window_bounds = p["bounds"].clone();
                self.window_bounds["windowState"] = json!("normal");
                json!({})
            }
            "Page.bringToFront" => {
                assert!(self.created);
                assert_eq!(p, &json!({}));
                assert_eq!(
                    self.window_bounds,
                    json!({"left":200,"top":100,"width":800,"height":600,"windowState":"normal"})
                );
                json!({})
            }
            "Page.close" => {
                assert!(self.created);
                self.created = false;
                json!({})
            }
            other => return Err(format!("unexpected CDP method: {other}")),
        };
        Ok((result, event))
    }
}

async fn connection(
    stream: TcpStream,
    state: Arc<Mutex<Peer>>,
    stop: CancellationToken,
) -> Result<()> {
    let upgrade = Arc::new(Mutex::new(None));
    let accepted = upgrade.clone();
    let service = service_fn(|mut request: Request<Incoming>| {
        let (state, upgrade) = (state.clone(), accepted.clone());
        async move {
            let path = request.uri().path().to_owned();
            assert_eq!(request.method(), hyper::Method::GET);
            if path.starts_with("/devtools/") {
                assert!(matches!(
                    path.as_str(),
                    "/devtools/page/owned" | "/devtools/browser/fixture"
                ));
                let key = request
                    .headers()
                    .get("sec-websocket-key")
                    .ok_or("WebSocket key missing")?;
                let key =
                    tokio_tungstenite::tungstenite::handshake::derive_accept_key(key.as_bytes());
                *upgrade.lock().unwrap() = Some(hyper::upgrade::on(&mut request));
                return Response::builder()
                    .status(hyper::StatusCode::SWITCHING_PROTOCOLS)
                    .header("upgrade", "websocket")
                    .header("connection", "Upgrade")
                    .header("sec-websocket-accept", key)
                    .body(Full::new(Bytes::new()))
                    .map_err(|e| e.to_string());
            }
            let (body, mime) = {
                let peer = state.lock().unwrap();
                match path.as_str() {
                    "/json/version" => (
                        json!({"webSocketDebuggerUrl":peer.generation()}).to_string(),
                        "application/json",
                    ),
                    "/json/list" => (
                        if peer.created {
                            json!([peer.tab()])
                        } else {
                            json!([])
                        }
                        .to_string(),
                        "application/json",
                    ),
                    "/fixture" => (format!("<button>{}</button>", peer.marker), "text/html"),
                    other => return Err(format!("unexpected CDP HTTP path {other}")),
                }
            };
            Ok::<_, String>(http_response(body, mime))
        }
    });
    tokio::select! {
        _ = stop.cancelled() => return Ok(()),
        result = hyper::server::conn::http1::Builder::new()
            .serve_connection(TokioIo::new(stream), service).with_upgrades() => {
                result.map_err(|e| format!("{e:?}"))?;
            }
    }
    let upgraded = upgrade.lock().unwrap().take();
    if let Some(upgraded) = upgraded {
        let stream = upgraded.await.map_err(|e| e.to_string())?;
        let mut ws =
            WebSocketStream::from_raw_socket(TokioIo::new(stream), Role::Server, None).await;
        loop {
            let message = tokio::select! {_ = stop.cancelled()=>break,message=ws.next()=>message};
            let Some(message) = message else { break };
            let message = match message {
                Ok(message) => message,
                // CdpConnection::drop aborts its reader without a close frame.
                Err(tokio_tungstenite::tungstenite::Error::Protocol(
                    tokio_tungstenite::tungstenite::error::ProtocolError::ResetWithoutClosingHandshake,
                )) => break,
                Err(error) => return Err(error.to_string()),
            };
            if message.is_close() {
                break;
            }
            if let Message::Ping(bytes) = message {
                ws.send(Message::Pong(bytes))
                    .await
                    .map_err(|e| e.to_string())?;
                continue;
            }
            let request: Value =
                serde_json::from_str(message.to_text().map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            let result = state.lock().unwrap().cdp(&request);
            match result {
                Ok((result, event)) => {
                    if let Some(event) = event {
                        ws.send(Message::Text(event.to_string().into()))
                            .await
                            .map_err(|e| e.to_string())?;
                    }
                    ws.send(Message::Text(
                        json!({"id":request["id"],"result":result})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .map_err(|e| e.to_string())?;
                }
                Err(error) => {
                    ws.send(Message::Text(
                        json!({"id":request["id"],"error":{"code":-32601,"message":error}})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .map_err(|e| e.to_string())?;
                    return Err(error);
                }
            }
        }
    }
    Ok(())
}

async fn start_browser_mock_ai(state: Arc<Mutex<Peer>>, stop: CancellationToken) -> MockAiServer {
    MockAiBuilder::new()
        .control(ControlPlaneConfig {
            models: vec![ModelEntry::simple("gpt-4.1")],
            ..Default::default()
        })
        .handler_async(move |req: NormalizedRequest, _ctx: TurnContext| {
            let state = state.clone();
            let stop = stop.clone();
            async move {
                assert_eq!(req.protocol, Protocol::OpenaiChatCompletions);
                let input = &req.raw_body;
                let mut wait_for_presentation = None;
                let plan = {
                    let mut peer = state.lock().unwrap();
                    peer.model_requests += 1;
                    if peer.model_requests == 1 {
                        TurnPlan::new()
                            .with_response_id("browser-stack")
                            .push_tool_call(
                                "discover_computer",
                                "tool_search",
                                json!({"query":"cua_repl","limit":1}),
                            )
                            .with_usage(Usage::new(100, 10))
                            .finish(FinishReason::ToolCalls)
                    } else if peer.model_requests == 2 {
                        let names: Vec<_> = input["tools"]
                            .as_array()
                            .expect("model tools missing")
                            .iter()
                            .filter_map(|tool| tool["function"]["name"].as_str())
                            .collect();
                        assert!(
                            names.contains(&"Read") && names.contains(&"cua_repl"),
                            "discovered Computer and Read tools missing: {names:?}"
                        );
                        TurnPlan::new()
                            .with_response_id("browser-stack")
                            .push_tool_call(
                                peer.marker.clone(),
                                "cua_repl",
                                json!({"code":peer.script(),"title":"Owned protocol stack regression"}),
                            )
                            .with_usage(Usage::new(100, 10))
                            .finish(FinishReason::ToolCalls)
                    } else if peer.model_result.is_some() {
                        assert!(!peer.close_result_seen, "close result replayed");
                        let result = input["messages"]
                            .as_array()
                            .expect("model messages missing")
                            .iter()
                            .rev()
                            .find(|m| m["role"] == "tool")
                            .expect("close tool result missing");
                        assert_eq!(result["tool_call_id"], "close_owned");
                        assert!(!peer.created, "fresh close call left the owned tab open");
                        peer.close_result_seen = true;
                        TurnPlan::new()
                            .with_response_id("browser-stack")
                            .push_text("owned Browser regression complete")
                            .with_usage(Usage::new(100, 10))
                            .finish(FinishReason::Stop)
                    } else {
                        let expected = if peer.model_requests == 3 {
                            peer.marker.clone()
                        } else {
                            format!("read_{}", peer.model_requests - 1)
                        };
                        let result = input["messages"]
                            .as_array()
                            .expect("model messages missing")
                            .iter()
                            .rev()
                            .find(|m| m["role"] == "tool")
                            .expect("model tool result missing");
                        assert_eq!(
                            result["tool_call_id"], expected,
                            "unexpected model result correlation: {result}"
                        );
                        let content = result["content"]
                            .as_str()
                            .expect("model content is not text");
                        let value: Value = serde_json::from_str(content)
                            .unwrap_or_else(|e| panic!("Read protocol: {e}: {content}"));
                        let page = if peer.model_requests == 3 {
                            assert!(
                                value["kind"] == "maka.archived_tool_result"
                                    && value["toolName"] == "cua_repl",
                                "original Cua archive missing: {value}"
                            );
                            &value["page"]
                        } else {
                            assert_eq!(value["kind"], "completed", "Read did not complete: {value}");
                            &value["value"]
                        };
                        peer.model_pages.push_str(
                            page["content"]
                                .as_str()
                                .unwrap_or_else(|| panic!("Read page missing: {value}")),
                        );
                        if let Some(next) = page.get("next").filter(|v| !v.is_null()) {
                            TurnPlan::new()
                                .with_response_id("browser-stack")
                                .push_tool_call(
                                    format!("read_{}", peer.model_requests),
                                    "Read",
                                    next.clone(),
                                )
                                .with_usage(Usage::new(100, 10))
                                .finish(FinishReason::ToolCalls)
                        } else {
                            peer.model_result =
                                Some(json!(std::mem::take(&mut peer.model_pages)));
                            wait_for_presentation = Some(
                                peer.resume_model
                                    .take()
                                    .expect("model hold already consumed"),
                            );
                            peer.canonical_sent
                                .take()
                                .expect("canonical signal already consumed")
                                .send(())
                                .expect("canonical observer closed");
                            TurnPlan::new()
                                .with_response_id("browser-stack")
                                .push_tool_call(
                                    "close_owned",
                                    "cua_repl",
                                    json!({"code":"await tab.close();","title":"Close the owned regression tab"}),
                                )
                                .with_usage(Usage::new(100, 10))
                                .finish(FinishReason::ToolCalls)
                        }
                    }
                };
                if let Some(resume) = wait_for_presentation {
                    // The Peer mutex is released: CDP must remain serviceable during this hold.
                    tokio::select! {
                        biased;
                        () = stop.cancelled() => return None,
                        result = tokio::time::timeout(Duration::from_secs(30), resume) => {
                            result
                                .expect("presentation release deadline")
                                .expect("presentation observer closed");
                        }
                    }
                }
                Some(plan)
            }
        })
        .start()
        .await
        .unwrap()
}

async fn serve_peer(
    listener: TcpListener,
    state: Arc<Mutex<Peer>>,
    stop: CancellationToken,
) -> Result<()> {
    let mut tasks = JoinSet::new();
    let mut errors = Vec::new();
    loop {
        tokio::select! {
            _ = stop.cancelled()=>break,
            joined=tasks.join_next(),if !tasks.is_empty()=>match joined.unwrap(){Ok(Ok(()))=>{},other=>{errors.push(format!("peer: {other:?}"));break;}},
            accepted=listener.accept()=>{let(stream,_)=accepted.map_err(|e|e.to_string())?;let(s,c)=(state.clone(),stop.clone());
                tasks.spawn(async move{tokio::select!{_ = c.cancelled()=>Ok(()),result=connection(stream,s,c.clone())=>result}});}
        }
    }
    stop.cancel();
    while let Some(joined) = tasks.join_next().await {
        if !matches!(joined, Ok(Ok(()))) {
            errors.push(format!("peer join: {joined:?}"));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn reports(value: &Value, out: &mut Vec<Value>) {
    match value {
        Value::Object(map) => {
            if map.contains_key("pixels") && map.contains_key("marker") {
                out.push(value.clone());
            } else {
                for v in map.values() {
                    reports(v, out);
                }
            }
        }
        Value::Array(values) => {
            for v in values {
                reports(v, out);
            }
        }
        Value::String(text) => {
            for line in text.lines() {
                if let Ok(v) = serde_json::from_str::<Value>(line)
                    && !v.is_string()
                {
                    reports(&v, out);
                }
            }
        }
        _ => {}
    }
}
fn check_report(value: &Value, marker: &str) -> Value {
    let mut found = Vec::new();
    reports(value, &mut found);
    assert_eq!(found.len(), 1, "one original REPL pixel report: {value}");
    let report = found.pop().unwrap();
    assert_eq!(report["marker"], marker);
    assert!(report["ax"].as_str().unwrap().contains(marker));
    let bytes: Vec<u8> = serde_json::from_value(report["pixels"].clone()).unwrap();
    assert_eq!(
        image::guess_format(&bytes).unwrap(),
        image::ImageFormat::Jpeg
    );
    let pixels = image::load_from_memory(&bytes).unwrap().to_rgb8();
    assert_eq!(pixels.dimensions(), (2, 2));
    for pixel in pixels.pixels() {
        for (a, b) in pixel.0.into_iter().zip([17u8, 71, 139]) {
            assert!(a.abs_diff(b) <= 3, "original JPEG pixels differ");
        }
    }
    report
}

async fn scenario(
    sandbox: &Sandbox,
    hosts: &mut Vec<Host>,
    clients: &mut Vec<Client>,
    inspectors: &mut Vec<(Child, ChildStdout)>,
    peer: &Arc<Mutex<Peer>>,
    model_base_url: &str,
    progress: &mut Value,
) -> Result<()> {
    progress["phase"] = json!("bootstrap Host ready");
    hosts.push(Host::spawn(sandbox)?);
    let (first, address) = phase("ordinary worker Host ready", hosts[0].ready()).await?;
    let epoch = first.epoch();
    clients.push(Client::new(
        first,
        Journal::open(&sandbox.journal).await?,
        "receipts".into(),
    )?);
    progress["phase"] = json!("read source and commit Browser configuration");
    let initial_source = clients[0].query("management", "read", json!({})).await?;
    let mut input = initial_source["source"]["input"].clone();
    let origin = peer.lock().unwrap().origin.clone();
    input["base"]["overrides"].as_array_mut().ok_or("base overrides missing")?.push(json!({
        "path":["workspace-computer"],"configuration":{"browsers":[{"id":"owned-stack","endpoint":origin}]}}));
    let cas=mutate(&clients[0],"management","replaceSource",json!({"expectedRevision":initial_source["source"]["reference"]["revision"],
        "document":{"input":input,"remoteExports":initial_source["source"]["remoteExports"],"packages":initial_source["packages"]}}),Attachments::new()).await?;
    assert_eq!(cas["status"], "committed");
    progress["committedSource"] = cas["value"].clone();
    progress["phase"] = json!("bootstrap Host quit before configured startup");
    phase("retired activation close", clients[0].close()).await?;
    let mut quit = phase(
        "bootstrap quit connection",
        HostClient::connect(&address, Some(epoch)),
    )
    .await?;
    phase(
        "bootstrap Host physical wait and EOF",
        hosts[0].quit(&mut quit),
    )
    .await?;
    progress["phase"] = json!("configured Host ready from committed source");
    hosts.push(Host::spawn(sandbox)?);
    let (anchor, address) =
        phase("configured ordinary worker Host ready", hosts[1].ready()).await?;
    let epoch = anchor.epoch();
    progress["ownerSource"] = serde_json::to_value(anchor.source()).map_err(|e| e.to_string())?;
    progress["registrations"] =
        serde_json::to_value(anchor.catalogue().epochs()).map_err(|e| e.to_string())?;
    assert_eq!(
        progress["ownerSource"], cas["value"],
        "configured Host must start at the committed source"
    );
    clients.push(Client::new(
        anchor,
        Journal::open(&sandbox.directory.path().join("configured-client.db")).await?,
        "receipts".into(),
    )?);
    let client = clients.last().unwrap();
    progress["phase"] = json!("controlled connection and Session setup");
    let catalog = client
        .query("settings", "connections", json!({"kind":"start"}))
        .await?;
    let connection=mutate(client,"settings","create",json!({"expectedCatalogRevision":catalog["revision"],"connection":{
        "slug":"owned-browser","name":"Controlled Browser protocol","provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"openai-compatible"},
        "configuration":{"baseUrl":model_base_url},"enabled":true,"enabledModelIds":["gpt-4.1"],
        "modelOverrides":{"gpt-4.1":{"codeMode":false,"apiProtocol":"openai-chat-completions"}}
    }}),Attachments::new()).await?;
    let id = connection["connection"]["connectionId"].clone();
    let detail = client
        .query("settings", "connection", json!({"connectionId":id}))
        .await?;
    let secret: Arc<dyn ReadResource> = Arc::new(FixtureKey);
    mutate(
        client,
        "settings",
        "saveCredential",
        json!({"expected":detail["target"],"expectedCredential":null}),
        Attachments::from([("secret".into(), secret)]),
    )
    .await?;
    let created=mutate(client,"agent","create",json!({"title":"Browser normal Host worker regression","automaticTitle":false,"labels":[],"tools":["cua_repl","Read"],
        "workspace":{"kind":"directory","path":sandbox.workspace},"backend":{"kind":"model","connectionId":id,"modelId":"gpt-4.1","thinkingLevel":null}}),Attachments::new()).await?;
    let session = &created["session"];
    let sid = session["id"].as_str().unwrap();
    mutate(client,"agent","metadata",json!({"sessionId":sid,"expectedRevision":session["revision"],"title":session["title"],"labels":[],
        "permissions":{"settings":{"access":"danger_full_access","requestPermissions":true},"revokeGrants":false}}),Attachments::new()).await?;
    let (canonical_ready, presentation_done) = {
        let mut state = peer.lock().unwrap();
        (
            state
                .canonical_ready
                .take()
                .ok_or("canonical receiver already consumed")?,
            state
                .presentation_done
                .take()
                .ok_or("presentation sender already consumed")?,
        )
    };
    progress["phase"] = json!("admit original Browser Run");
    let sent=mutate(client,"agent","send",json!({"sessionId":sid,"message":"Explicitly authorize nonisolated Computer only for the owned-stack loopback protocol peer and its /fixture URL. Perform the one Browser regression and close only its owned tab.","delivery":"queue"}),Attachments::new()).await?;
    progress["phase"] = json!("waiting for original canonical tool and Read results");
    // This spans the original call and every Read continuation, not one RPC.
    // The scenario deadline bounds the entire exchange.
    canonical_ready
        .await
        .map_err(|_| "canonical sender closed")?;
    let held_requests = {
        let state = peer.lock().unwrap();
        check_report(
            state
                .model_result
                .as_ref()
                .ok_or("canonical model result missing")?,
            &state.marker,
        );
        assert!(
            state.created,
            "original tool closed its tab before client presentation"
        );
        assert!(
            !state
                .methods
                .iter()
                .any(|method| method == "Page.bringToFront")
        );
        state.model_requests
    };
    let work_target = json!({"kind":"message","messageId":sent["messageId"]});
    let held = client
        .query(
            "agent",
            "work",
            json!({"sessionId":sid,"target":work_target}),
        )
        .await?;
    assert_eq!(held["kind"], "delivered");
    assert_eq!(held["execution"]["state"]["kind"], "running");
    let held_run = held["execution"]["runId"].clone();
    let stage = client
        .subscribe("computer", "watchStage", json!({"sessionId":sid}))
        .await?;
    let snapshot = match phase("live stage snapshot", stage.next()).await? {
        Some(maka_app_client::SubscriptionEvent::Item(value)) => value,
        _ => return Err("stage ended before its snapshot".into()),
    };
    let binding = snapshot["bindingId"]
        .as_str()
        .ok_or("stage binding missing")?;
    let targets = snapshot["targets"]
        .as_array()
        .ok_or("stage targets missing")?;
    assert_eq!(targets.len(), 1);
    let target = &targets[0];
    assert_eq!(target["kind"], "browser");
    let frames = client.subscribe("computer", "watchFrames", json!({
        "sessionId":sid,"bindingId":binding,"targetIds":[target["id"]],"selectedTargetId":target["id"]
    })).await?;
    let notice = match phase("live viewport frame notice", frames.next()).await? {
        Some(maka_app_client::SubscriptionEvent::Item(value)) => value,
        _ => return Err("frame stream ended before its notice".into()),
    };
    assert_eq!(notice["sessionId"], sid);
    assert_eq!(notice["bindingId"], binding);
    assert_eq!(notice["targetId"], target["id"]);
    assert!(
        notice["sequence"]
            .as_u64()
            .is_some_and(|sequence| sequence > 0)
    );
    {
        let value = client.query("computer", "readFrame", json!({
            "sessionId":sid,"bindingId":binding,"feedId":notice["feedId"],"targetId":target["id"],"after":0
        })).await?;
        assert_eq!(value["kind"], "frame", "live frame was not available");
        let frame = &value["frame"];
        assert_eq!(frame["sessionId"], sid);
        assert_eq!(frame["bindingId"], binding);
        assert_eq!(frame["targetId"], target["id"]);
        assert_eq!(frame["revision"], target["revision"]);
        assert!(
            frame["sequence"].as_u64().ok_or("frame sequence missing")?
                >= notice["sequence"]
                    .as_u64()
                    .ok_or("notice sequence missing")?
        );
        assert_eq!(frame["mimeType"], "image/jpeg");
        assert_eq!(
            (frame["width"].as_u64(), frame["height"].as_u64()),
            (Some(2), Some(2))
        );
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(frame["dataBase64"].as_str().ok_or("frame data missing")?)
            .map_err(|_| "invalid live frame encoding")?;
        let image = image::load_from_memory(&bytes).map_err(|_| "invalid live frame image")?;
        assert_eq!((image.width(), image.height()), (2, 2));
    }
    progress["phase"] = json!("new client foreground operation after original tool settlement");
    // The first presentation restores the minimized window. The second must
    // position and activate the same, now normal window without restoring it.
    for normalizing in [true, false] {
        let before = peer.lock().unwrap().methods.len();
        let foreground_id = Uuid::new_v4();
        let foreground = client.mutation(
            foreground_id, "computer", "presentTarget",
            json!({"sessionId":sid,"bindingId":binding,"feedId":notice["feedId"],"targetId":target["id"],
                "revision":target["revision"],"area":{"x":100,"y":50,"width":1000,"height":700}}),
            Attachments::new(), None, json!({"kind":"post-settled-browser-presentation"}),
        ).await?;
        phase("foreground operation prepared", foreground.prepare()).await?;
        let foreground_reply =
            phase("foreground operation confirmed", foreground.confirm()).await?;
        let presented = success(&foreground_reply);
        assert_eq!(presented["kind"], "requested");
        assert_eq!(presented["details"]["windowId"], 7);
        if normalizing {
            assert_eq!(
                presented["details"]["normalizationRequested"],
                json!({"windowState":"normal"})
            );
            assert_eq!(
                presented["details"]["normalizationObserved"]["bounds"],
                json!({"left":20,"top":30,"width":800,"height":600,"windowState":"normal"})
            );
        } else {
            assert!(presented["details"].get("normalizationRequested").is_none());
        }
        assert_eq!(
            presented["details"]["placementRequested"],
            json!({"left":200,"top":100,"width":800,"height":600})
        );
        assert_eq!(
            presented["details"]["placementObserved"]["bounds"],
            json!({"left":200,"top":100,"width":800,"height":600,"windowState":"normal"})
        );
        assert_eq!(presented["details"]["activationRequested"], json!({}));
        {
            let state = peer.lock().unwrap();
            assert_eq!(
                state.model_requests, held_requests,
                "model hold ended before presentation"
            );
            assert!(!state.close_result_seen);
            assert!(state.created);
            assert!(state.preview_screenshots > 0);
            assert_eq!(
                state.window_bounds,
                json!({"left":200,"top":100,"width":800,"height":600,"windowState":"normal"})
            );
            let effects: Vec<_> = state.methods[before..]
                .iter()
                .map(String::as_str)
                .filter(|method| matches!(*method, "Browser.setWindowBounds" | "Page.bringToFront"))
                .collect();
            let expected: &[_] = if normalizing {
                &[
                    "Browser.setWindowBounds",
                    "Browser.setWindowBounds",
                    "Page.bringToFront",
                ]
            } else {
                &["Browser.setWindowBounds", "Page.bringToFront"]
            };
            assert_eq!(effects, expected);
        }
        progress["foreground"] =
            json!({"operationId":foreground_id,"kind":presented["kind"],"cleanup":"confirmed"});
    }
    phase("viewport subscription closed", frames.close()).await?;
    phase("stage subscription closed", stage.close()).await?;
    presentation_done
        .send(())
        .map_err(|_| "held model response disappeared")?;
    progress["phase"] = json!("original Run completed");
    let execution = execution(
        client,
        sid,
        &json!({"kind":"message","messageId":sent["messageId"]}),
        None,
        None,
    )
    .await?;
    assert_eq!(
        execution["runId"], held_run,
        "presentation must not replace the original Run"
    );
    let marker = peer.lock().unwrap().marker.clone();
    let model_result = peer
        .lock()
        .unwrap()
        .model_result
        .take()
        .ok_or("no actual provider tool result")?;
    let projected = check_report(&model_result, &marker);
    progress["phase"] = json!("completed Host quit before offline inspect");
    phase("configured client closed", client.close()).await?;
    let mut quit = phase(
        "completed Host quit connection",
        HostClient::connect(&address, Some(epoch)),
    )
    .await?;
    phase(
        "completed Host physical wait and EOF",
        hosts[1].quit(&mut quit),
    )
    .await?;
    progress["phase"] = json!("offline original canonical facts");
    let inspection = phase(
        "offline original canonical facts",
        inspect(sandbox, sid, inspectors),
    )
    .await?;
    progress["phase"] = json!("reopened Host for original durable receipt");
    hosts.push(Host::spawn(sandbox)?);
    let (anchor, address) = phase("durable evidence Host ready", hosts[2].ready()).await?;
    let epoch = anchor.epoch();
    progress["ownerSource"] = serde_json::to_value(anchor.source()).map_err(|e| e.to_string())?;
    progress["registrations"] =
        serde_json::to_value(anchor.catalogue().epochs()).map_err(|e| e.to_string())?;
    assert_eq!(progress["ownerSource"], cas["value"]);
    clients.push(Client::new(
        anchor,
        Journal::open(&sandbox.directory.path().join("evidence-client.db")).await?,
        "receipts".into(),
    )?);
    let client = clients.last().unwrap();
    let run = &execution["runId"];
    let facts = records(&inspection, run);
    assert_eq!(
        facts
            .iter()
            .filter(|r| r["fact"]["kind"] == "run_admitted")
            .count(),
        1
    );
    let returned: Vec<_> = inspection["facts"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| {
            r["item"]["recorded"]["run"] == *run
                && r["item"]["recorded"]["fact"]["kind"] == "host_tool_result_recorded"
                && r["item"]["recorded"]["fact"]["tool"]["call"] == marker
        })
        .collect();
    assert_eq!(returned.len(), 1);
    let close_results: Vec<_> = inspection["facts"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| {
            let recorded = &row["item"]["recorded"];
            recorded["run"] == *run
                && recorded["fact"]["kind"] == "host_tool_result_recorded"
                && recorded["fact"]["tool"]["call"] == "close_owned"
        })
        .collect();
    assert_eq!(
        close_results.len(),
        1,
        "fresh close call has one canonical result"
    );
    assert_eq!(
        close_results[0]["item"]["recorded"]["fact"]["is_error"],
        false
    );
    let close_tool = &close_results[0]["item"]["recorded"]["fact"]["tool"];
    for kind in ["tool_admitted", "tool_result_accepted"] {
        assert_eq!(
            facts
                .iter()
                .filter(|row| row["fact"]["kind"] == kind && row["fact"]["tool"] == *close_tool)
                .count(),
            1
        );
    }
    let fact = &returned[0]["item"]["recorded"]["fact"];
    assert_eq!(fact["is_error"], false);
    let tool = &fact["tool"];
    assert_eq!(tool["call"], marker, "original provider call correlation");
    for kind in ["tool_admitted", "tool_result_accepted"] {
        assert_eq!(
            facts
                .iter()
                .filter(|r| r["fact"]["kind"] == kind && r["fact"]["tool"] == *tool)
                .count(),
            1,
            "same original {kind}"
        );
    }
    let bindings: Vec<_> = facts
        .iter()
        .filter(|r| r["fact"]["kind"] == "tool_original_bound" && r["fact"]["tool"] == *tool)
        .collect();
    assert!(!bindings.is_empty(), "original operation was bound");
    for binding in bindings {
        assert_eq!(binding["fact"]["reference"], fact["reference"]);
    }
    let observed_rows: Vec<_> = inspection["facts"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| {
            let r = &row["item"]["recorded"];
            r["run"] == *run
                && r["fact"]["kind"] == "operation_observed"
                && r["fact"]["tool"] == *tool
        })
        .collect();
    let observed_row = observed_rows
        .last()
        .ok_or("original operation observation missing")?;
    let recorded: RecordedOperationReply =
        serde_json::from_value(observed_row["item"]["recorded"]["fact"]["reply"].clone())
            .map_err(|e| e.to_string())?;
    progress["phase"] = json!("resolve original durable receipt");
    let receipt = phase(
        "original durable receipt",
        source(client, sid, &inspection, observed_row, "receipt"),
    )
    .await?;
    let resolved: OperationReply =
        serde_json::from_value(receipt.clone()).map_err(|e| e.to_string())?;
    assert_eq!(serde_json::to_value(&resolved).unwrap(), receipt);
    assert_eq!(
        serde_json::to_value(&resolved.reference).unwrap(),
        fact["reference"]
    );
    let inline = inline_reply(resolved.clone());
    match (&recorded.receipt, &inline.receipt) {
        (
            Receipt::Recorded {
                outcome: a,
                cleanup: OperationCleanup::Confirmed,
            },
            Receipt::Recorded {
                outcome: b,
                cleanup: OperationCleanup::Confirmed,
            },
        ) => assert!(same_outcome(a, b).map_err(|e| e.to_string())?),
        other => return Err(format!("original cleanup not confirmed: {other:?}")),
    }
    let completed = success(&resolved);
    assert_eq!(completed["kind"], "completed");
    let artifact = completed["artifact"]
        .as_str()
        .ok_or("Completed artifact missing")?
        .to_owned();
    let (db, session_id, run_id, turn_id) = (
        sandbox.root.join("runtime-rust.sqlite"),
        sid.to_owned(),
        run.as_str().unwrap().to_owned(),
        execution["turnId"].clone(),
    );
    progress["phase"] = json!("original artifact provenance and JPEG bytes");
    let original_reference = fact["reference"].clone();
    let original_tool = tool.clone();
    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>> {
        let connection = rusqlite::Connection::open_with_flags(
            db,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        ).map_err(|e|e.to_string())?;
        maka_event_log::content::register_sql_functions(&connection).map_err(|e| e.to_string())?;
        let (record, bytes, provenance): (String, Vec<u8>, Vec<u8>) = connection.query_row(
            "SELECT a.record_json,maka_content_bytes(c.payload,c.encoding),maka_content_bytes(p.payload,p.encoding) FROM agent_artifacts a JOIN agent_session_artifact_registrations r ON r.session=a.session AND r.artifact=a.artifact AND r.owner=a.owner JOIN agent_run_specs s ON s.run=?1 AND s.session=a.session AND s.owner=a.owner JOIN contents c ON c.id=a.content_id JOIN contents p ON p.id=r.provenance_content_id WHERE a.session=?2 AND a.artifact=?3",
            rusqlite::params![run_id, session_id, artifact],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).map_err(|e|e.to_string())?;
        let record: maka_agent_facts::artifact::PublishedArtifact =
            serde_json::from_str(&record).map_err(|e|e.to_string())?;
        let provenance: Value = serde_json::from_slice(&provenance).map_err(|e|e.to_string())?;
        assert_eq!(record.artifact.id, artifact);
        assert_eq!(record.artifact.session_id, session_id);
        assert_eq!(record.artifact.turn_id, turn_id.as_str().unwrap());
        assert_eq!(record.payload.bytes, bytes.len() as u64);
        assert_eq!(record.payload.digest, maka_agent_facts::artifact::content_digest(&bytes));
        assert_eq!(provenance["kind"], "computer_output");
        assert_eq!(provenance["execution"]["sessionId"], session_id);
        assert_eq!(provenance["execution"]["turnId"], turn_id);
        assert_eq!(provenance["call"]["tool_call_id"], original_tool["call"]);
        assert_eq!(provenance["call"]["origin"]["kind"], "provider");
        assert_eq!(provenance["call"]["origin"]["link"]["run"], run_id);
        assert_eq!(provenance["call"]["origin"]["link"]["attempt"], original_tool["attempt"]);
        assert_eq!(provenance["original"], original_reference);
        Ok(bytes)
    }).await.map_err(|e|e.to_string())??;
    let original: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    assert_eq!(check_report(&original, &marker), projected);
    {
        let state = peer.lock().unwrap();
        assert!(state.model_requests > 3, "original archive fully read");
        assert!(!state.created);
        assert!(state.close_result_seen);
        assert!(state.preview_screenshots > 0);
        for method in [
            "Target.createTarget",
            "Page.navigate",
            "Page.captureScreenshot",
            "Page.close",
        ] {
            assert_eq!(
                state
                    .methods
                    .iter()
                    .filter(|s| s.as_str() == method)
                    .count(),
                1,
                "original {method} only"
            );
        }
    }
    progress["phase"] = json!("durable evidence Host quit");
    phase("evidence client closed", client.close()).await?;
    let mut quit = phase(
        "evidence Host quit connection",
        HostClient::connect(&address, Some(epoch)),
    )
    .await?;
    phase(
        "evidence Host physical wait and EOF",
        hosts[2].quit(&mut quit),
    )
    .await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn browser_stage_presents_the_same_window_after_tool_settlement() {
    let sandbox = Sandbox::new().await.unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut jpeg = std::io::Cursor::new(Vec::new());
    image::RgbImage::from_pixel(2, 2, image::Rgb([17, 71, 139]))
        .write_to(&mut jpeg, image::ImageFormat::Jpeg)
        .unwrap();
    let (canonical_sent, canonical_ready) = tokio::sync::oneshot::channel();
    let (presentation_done, resume_model) = tokio::sync::oneshot::channel();
    let peer = Arc::new(Mutex::new(Peer {
        origin: format!("http://{}", listener.local_addr().unwrap()),
        marker: Uuid::new_v4().to_string(),
        pixels: base64::engine::general_purpose::STANDARD.encode(jpeg.into_inner()),
        url: "about:blank".into(),
        created: false,
        methods: Vec::new(),
        preview_screenshots: 0,
        window_bounds: json!({"left":20,"top":30,"width":800,"height":600,"windowState":"minimized"}),
        canonical_sent: Some(canonical_sent),
        canonical_ready: Some(canonical_ready),
        presentation_done: Some(presentation_done),
        resume_model: Some(resume_model),
        close_result_seen: false,
        model_requests: 0,
        model_result: None,
        model_pages: String::new(),
    }));
    let stop = CancellationToken::new();
    let mock_ai = start_browser_mock_ai(peer.clone(), stop.clone()).await;
    let model_base_url = mock_ai.base_url();
    let mut server = tokio::spawn(serve_peer(listener, peer.clone(), stop.clone()));
    let mut collected = false;
    let (mut hosts, mut clients, mut inspectors) = (Vec::new(), Vec::new(), Vec::new());
    let mut progress = json!({"phase":"fixture initialization"});
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(90), async {
        tokio::select! {
            r=scenario(&sandbox,&mut hosts,&mut clients,&mut inspectors,&peer,&model_base_url,&mut progress)=>r,
            r=&mut server=>{collected=true;Err(format!("protocol peer ended: {r:?}"))}
        }
    }))
    .catch_unwind()
    .await;
    let mut cleanup = Vec::new();
    for client in &clients {
        if let Err(e) = phase("client cleanup", client.close()).await {
            cleanup.push(e);
        }
    }
    for host in &mut hosts {
        if let Err(e) = phase("Host child cleanup", host.cleanup()).await {
            cleanup.push(e);
        }
    }
    for (child, stdout) in &mut inspectors {
        let result = phase("inspect cleanup", async {
            if child.try_wait().map_err(|e| e.to_string())?.is_none() {
                child.start_kill().map_err(|e| e.to_string())?;
            }
            let mut tail = Vec::new();
            let (eof, status) = tokio::join!(stdout.read_to_end(&mut tail), child.wait());
            eof.map_err(|e| e.to_string())?;
            status.map_err(|e| e.to_string())?;
            Ok(())
        })
        .await;
        if let Err(e) = result {
            cleanup.push(e);
        }
    }
    stop.cancel();
    let panics = mock_ai.shutdown_taking_panics().await;
    if !panics.is_empty() {
        cleanup.push(format!("mock-ai handler panics: {}", panics.join("; ")));
    }
    if !collected {
        match tokio::time::timeout(Duration::from_secs(30), &mut server).await {
            Ok(Ok(Ok(()))) => {}
            Ok(other) => cleanup.push(format!("protocol peer join: {other:?}")),
            Err(error) => {
                cleanup.push(format!("protocol peer drain: {error}"));
                server.abort();
                cleanup.push(format!(
                    "protocol peer after cancellation: {:?}",
                    server.await
                ));
            }
        }
    }
    if !matches!(&outcome, Ok(Ok(Ok(())))) {
        let state = peer.lock().unwrap();
        progress["peer"] = json!({"modelRequests":state.model_requests,"archiveBytes":state.model_pages.len(),"methods":state.methods,"tabCreated":state.created});
        eprintln!("Browser Root failure metadata: {progress}");
    }
    match outcome {
        Ok(Ok(Ok(()))) => assert!(cleanup.is_empty(), "{cleanup:?}"),
        other => {
            panic!("Browser Root regression: {other:?}; progress={progress}; cleanup={cleanup:?}")
        }
    }
}
