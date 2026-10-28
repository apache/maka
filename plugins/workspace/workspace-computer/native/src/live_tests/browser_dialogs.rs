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

//! Real product/Root custody with one deliberately delayed, otherwise unchanged
//! Chrome reply. The proxy never fabricates a CDP event or request result.
use super::*;
use futures_util::{SinkExt, StreamExt};
use maka_agent_facts::interaction::{GrantCapability, GrantScope, GrantTarget};
use std::{
    collections::HashSet,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tokio::{
    io::{AsyncReadExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::OnceCell,
};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use url::Url;

const PAGE: &str = r#"<!doctype html><meta charset=utf-8><title>Maka owned dialog custody</title>
<button id=ready>Page ready</button><script>
globalThis.openOwnedDialog=()=>setTimeout(()=>{
  document.getElementById('ready').textContent=String(confirm('owned-close-first'));
},0);
</script>"#;

#[derive(Default)]
pub(super) struct Wire {
    clipboard_replies: AtomicBool,
    pub(super) requests: AtomicUsize,
    closed: AtomicUsize,
    pub(super) lost_while_held: AtomicBool,
    opened: CancellationToken,
    closed_forwarded: CancellationToken,
    pub(super) held: CancellationToken,
    pub(super) release: CancellationToken,
    pub(super) forwarded: CancellationToken,
    pub(super) rows: Mutex<Vec<Value>>,
}
impl Wire {
    pub(super) fn hold_clipboard_replies(&self, hold: bool) {
        self.clipboard_replies.store(hold, Ordering::SeqCst);
    }
    fn row(&self, row: Value) {
        eprintln!("dialog custody fixture: {row}");
        self.rows.lock().unwrap().push(row);
    }
    pub(super) fn snapshot(&self) -> Value {
        json!({
            "handle_requests":self.requests.load(Ordering::SeqCst),
            "closed_events_forwarded":self.closed.load(Ordering::SeqCst),
            "connection_lost_while_ack_held":self.lost_while_held.load(Ordering::SeqCst),
            "ack_released":self.forwarded.is_cancelled(),
            "rows":self.rows.lock().unwrap().clone(),
        })
    }
}

async fn http_json(origin: &str, path: &str, wire: &Wire) -> Value {
    let origin = Url::parse(origin).unwrap();
    let port = origin.port().unwrap();
    wire.row(json!({"stage":"discovery_request","origin":origin.as_str(),"path":path}));
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream
        .write_all(
            format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await
        .unwrap();
    let mut stream = BufReader::new(stream);
    let mut headers = Vec::new();
    let mut length = None;
    loop {
        let mut line = String::new();
        assert_ne!(
            stream.read_line(&mut line).await.unwrap(),
            0,
            "Chrome closed discovery before its HTTP headers: {headers:?}"
        );
        if line == "\r\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':')
            && name.eq_ignore_ascii_case("content-length")
        {
            length = Some(value.trim().parse::<usize>().unwrap());
        }
        headers.push(line.trim_end().to_owned());
    }
    wire.row(
        json!({"stage":"discovery_headers","path":path,"headers":headers,"content_length":length}),
    );
    assert!(
        headers[0].starts_with("HTTP/1.1 200"),
        "Chrome discovery failed: {headers:?}"
    );
    // Chrome's discovery endpoint provides Content-Length. Its socket may stay
    // open after the response; EOF is not this HTTP message's boundary.
    let mut bytes = vec![0; length.expect("Chrome discovery must provide Content-Length")];
    stream.read_exact(&mut bytes).await.unwrap();
    wire.row(json!({"stage":"discovery_body","path":path,"bytes":bytes.len()}));
    serde_json::from_slice(&bytes).unwrap_or_else(|error| {
        panic!(
            "Chrome discovery JSON failed: {error}; headers={headers:?}; body={}",
            String::from_utf8_lossy(&bytes)
        )
    })
}

fn rewrite_debugger(value: &mut Value, port: u16) {
    match value {
        Value::Object(object) => {
            if let Some(websocket) = object.get_mut("webSocketDebuggerUrl") {
                let mut url = Url::parse(websocket.as_str().unwrap()).unwrap();
                url.set_host(Some("127.0.0.1")).unwrap();
                url.set_port(Some(port)).unwrap();
                *websocket = json!(url.as_str());
            }
            for value in object.values_mut() {
                rewrite_debugger(value, port);
            }
        }
        Value::Array(values) => {
            for value in values {
                rewrite_debugger(value, port);
            }
        }
        _ => {}
    }
}

async fn proxy_connection(
    mut stream: TcpStream,
    chrome: Arc<OnceCell<String>>,
    port: u16,
    wire: Arc<Wire>,
) {
    let mut peek = [0; 8192];
    let count = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let count = stream.peek(&mut peek).await.unwrap();
            if count == 0 {
                return None;
            }
            assert!(
                count < peek.len(),
                "owned request must fit its fixed headers"
            );
            if peek[..count].windows(4).any(|window| window == b"\r\n\r\n") {
                break Some(count);
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    let Ok(Some(count)) = count else {
        return;
    };
    let header = std::str::from_utf8(&peek[..count]).unwrap();
    let path = header
        .lines()
        .next()
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .to_owned();
    wire.row(json!({"stage":"proxy_request","path":path,"headers":header}));
    if header.to_ascii_lowercase().contains("upgrade: websocket") {
        let client = tokio_tungstenite::accept_async(stream).await.unwrap();
        let origin = Url::parse(
            chrome
                .get()
                .expect("Chrome is ready before debugger connections"),
        )
        .unwrap();
        let (server, _) = connect_async(format!("ws://127.0.0.1:{}{path}", origin.port().unwrap()))
            .await
            .unwrap();
        let (mut client_out, mut client_in) = client.split();
        let (mut server_out, mut server_in) = server.split();
        let connection = Uuid::new_v4().to_string();
        let mut handles = HashSet::new();
        let mut cleanups = std::collections::HashMap::new();
        let mut held = Vec::new();
        loop {
            tokio::select! {
                next = client_in.next() => {
                    let Some(Ok(message)) = next else { break; };
                    if let Message::Text(text) = &message {
                        let request: Value = serde_json::from_str(text.as_str()).unwrap();
                        if matches!(request["method"].as_str(), Some("Page.removeScriptToEvaluateOnNewDocument" | "Runtime.removeBinding" | "Runtime.disable")) {
                            let id=request["id"].as_u64().unwrap();
                            assert!(cleanups.insert(id,request["method"].as_str().unwrap().to_owned()).is_none());
                            wire.row(json!({"stage":"cleanup_request","connection":connection,"message":request}));
                        }
                        let clipboard_reply = request["method"] == "Runtime.evaluate"
                            && request["params"]["uniqueContextId"].is_string()
                            && request["params"]["expression"].as_str().is_some_and(|expression| {
                                expression.starts_with("globalThis.__makaVirtualClipboard?.bindingName === ")
                                    && expression.contains(" && globalThis.__makaVirtualClipboard.respond(")
                            });
                        if clipboard_reply {
                            wire.row(json!({"stage":"clipboard_reply_request","connection":connection,"message":request}));
                        }
                        if request["method"] == "Page.handleJavaScriptDialog"
                            || (clipboard_reply && wire.clipboard_replies.load(Ordering::SeqCst))
                        {
                            let id = request["id"].as_u64().unwrap();
                            assert!(handles.insert(id));
                            wire.requests.fetch_add(1, Ordering::SeqCst);
                            wire.row(json!({"stage":"request_forwarded","connection":connection,"message":request}));
                        }
                    }
                    if server_out.send(message).await.is_err() { break; }
                }
                next = server_in.next() => {
                    let Some(Ok(message)) = next else { break; };
                    if let Message::Text(text) = &message {
                        let event: Value = serde_json::from_str(text.as_str()).unwrap();
                        if let Some(id)=event["id"].as_u64()
                            && let Some(method)=cleanups.remove(&id)
                        {
                            wire.row(json!({"stage":"cleanup_ack","connection":connection,"method":method,"message":event}));
                        }
                        if let Some(id) = event["id"].as_u64()
                            && handles.contains(&id)
                        {
                            wire.row(json!({"stage":"ack_held","connection":connection,"message":event}));
                            held.push((id, message));
                            wire.held.cancel();
                            continue;
                        }
                        let opening = event["method"] == "Page.javascriptDialogOpening";
                        let closed = event["method"] == "Page.javascriptDialogClosed";
                        if client_out.send(message).await.is_err() { break; }
                        if opening {
                            assert_eq!(event["params"]["type"], "confirm");
                            assert_eq!(event["params"]["message"], "owned-close-first");
                            wire.opened.cancel();
                        }
                        if closed {
                            wire.closed.fetch_add(1, Ordering::SeqCst);
                            wire.row(json!({"stage":"closed_forwarded","connection":connection,"message":event}));
                            wire.closed_forwarded.cancel();
                        }
                        continue;
                    }
                    if client_out.send(message).await.is_err() { break; }
                }
                () = wire.release.cancelled(), if !held.is_empty() => {
                    for (id, message) in held.drain(..) {
                        if client_out.send(message).await.is_err() {
                            wire.lost_while_held.store(true, Ordering::SeqCst);
                            return;
                        }
                        assert!(handles.remove(&id));
                        wire.row(json!({"stage":"original_ack_forwarded","connection":connection,"id":id}));
                    }
                    wire.forwarded.cancel();
                }
            }
        }
        if !handles.is_empty() {
            wire.lost_while_held.store(true, Ordering::SeqCst);
            wire.row(json!({"stage":"connection_lost_before_original_ack","connection":connection,"ids":handles}));
        }
    } else {
        let mut header = vec![0; count];
        stream.read_exact(&mut header).await.unwrap();
        let body = if path.starts_with("/json") {
            let mut value = http_json(chrome.get().unwrap(), &path, &wire).await;
            rewrite_debugger(&mut value, port);
            serde_json::to_string(&value).unwrap()
        } else {
            PAGE.to_owned()
        };
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            if path.starts_with("/json") {
                "application/json"
            } else {
                "text/html; charset=utf-8"
            },
            body.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
        wire.row(json!({"stage":"proxy_response","path":path,"status":200,"bytes":body.len()}));
    }
}

pub(super) struct Browser {
    chrome: tokio::process::Child,
    logging: tokio::task::JoinHandle<()>,
    proxy: tokio::task::JoinHandle<()>,
    profile: Option<tempfile::TempDir>,
    pub(super) endpoint: String,
    pub(super) target: String,
    page_socket: String,
    browser_socket: String,
    pub(super) wire: Arc<Wire>,
}
impl Browser {
    pub(super) async fn open() -> Self {
        let executable = std::env::var_os("MAKA_CUA_TEST_CHROME")
            .expect("explicit task-owned Chrome executable is required");
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let endpoint = format!("http://127.0.0.1:{port}");
        let url = format!("{endpoint}/fixture");
        let upstream = Arc::new(OnceCell::new());
        let wire = Arc::new(Wire::default());
        let proxy = {
            let upstream = upstream.clone();
            let wire = wire.clone();
            tokio::spawn(async move {
                let mut connections = tokio::task::JoinSet::new();
                loop {
                    tokio::select! {
                        accepted = listener.accept() => {
                            let (stream, _) = accepted.unwrap();
                            connections.spawn(proxy_connection(stream, upstream.clone(), port, wire.clone()));
                        }
                        completed = connections.join_next(), if !connections.is_empty() => {
                            completed.unwrap().expect("task-owned transparent proxy worker failed");
                        }
                    }
                }
            })
        };
        let profile = tempfile::tempdir().unwrap();
        let mut chrome = tokio::process::Command::new(executable)
            .args([
                "--headless=new",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-networking",
                "--remote-debugging-port=0",
                "--disable-gpu",
                "--password-store=basic",
            ])
            .arg(format!("--user-data-dir={}", profile.path().display()))
            .arg(&url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut lines = tokio::io::BufReader::new(chrome.stderr.take().unwrap()).lines();
        let websocket = tokio::time::timeout(Duration::from_secs(20), async {
            while let Some(line) = lines.next_line().await.unwrap() {
                wire.row(json!({"stage":"chrome_stderr","line":line}));
                if let Some(url) = line.strip_prefix("DevTools listening on ") {
                    return url.to_owned();
                }
            }
            panic!("task-owned Chrome did not report its debugger endpoint");
        })
        .await
        .unwrap();
        let actual = format!(
            "http://127.0.0.1:{}",
            Url::parse(&websocket).unwrap().port().unwrap()
        );
        upstream.set(actual.clone()).unwrap();
        wire.row(json!({"stage":"upstream_ready","origin":actual,"expected_page_url":url}));
        let logging = {
            let wire = wire.clone();
            tokio::spawn(async move {
                while let Some(line) = lines.next_line().await.unwrap() {
                    wire.row(json!({"stage":"chrome_stderr","line":line}));
                }
            })
        };
        let mut last_tabs = Value::Null;
        let tab = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let tabs = http_json(&actual, "/json/list", &wire).await;
                if tabs != last_tabs {
                    wire.row(json!({"stage":"discovery_tabs","expected_page_url":url,"tabs":tabs}));
                    last_tabs = tabs.clone();
                }
                if let Some(tab) = tabs
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|tab| tab["type"] == "page" && tab["url"] == url)
                {
                    break tab.clone();
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        let startup = json!({"expected_page_url":url,"chrome_origin":actual,"chrome_status":format!("{:?}",chrome.try_wait().unwrap()),"last_tabs":last_tabs,"wire":wire.snapshot()});
        capture(
            PathBuf::from(std::env::var_os("MAKA_COMPUTER_LIVE_ARTIFACT_DIR").unwrap())
                .join(format!("dialog-browser-startup-{}.json", Uuid::new_v4())),
            startup.clone(),
        )
        .await;
        let tab = match tab {
            Ok(tab) => tab,
            Err(error) => {
                let _ = chrome.kill().await;
                let status = chrome.wait().await;
                logging.await.unwrap();
                proxy.abort();
                let _ = proxy.await;
                panic!(
                    "owned Chrome page discovery timed out: {error}; cleanup={status:?}; startup={startup}"
                );
            }
        };
        Self {
            chrome,
            logging,
            proxy,
            profile: Some(profile),
            endpoint,
            target: tab["id"].as_str().unwrap().into(),
            page_socket: tab["webSocketDebuggerUrl"].as_str().unwrap().into(),
            browser_socket: websocket,
            wire,
        }
    }
    pub(super) async fn request(&self, method: &str, params: Value) -> Value {
        let (mut socket, _) = connect_async(&self.page_socket).await.unwrap();
        socket
            .send(Message::Text(
                json!({"id":1,"method":method,"params":params})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let message = socket.next().await.unwrap().unwrap();
                let Message::Text(text) = message else {
                    continue;
                };
                let response: Value = serde_json::from_str(text.as_str()).unwrap();
                if response["id"] == 1 {
                    assert!(response.get("error").is_none(), "{method}: {response}");
                    return response["result"].clone();
                }
            }
        })
        .await
        .unwrap_or_else(|error| panic!("owned Chrome {method} timed out: {error}"))
    }

    pub(super) async fn page(&self, expression: &str) -> Value {
        let response = self
            .request(
                "Runtime.evaluate",
                json!({
                    "expression":expression,"awaitPromise":true,"returnByValue":true
                }),
            )
            .await;
        assert!(
            response.get("exceptionDetails").is_none(),
            "{expression}: {response}"
        );
        response["result"]["value"].clone()
    }

    async fn open_dialog(&self) {
        let (mut socket, _) = connect_async(&self.page_socket).await.unwrap();
        socket.send(Message::Text(json!({"id":1,"method":"Runtime.evaluate","params":{"expression":"openOwnedDialog();true","returnByValue":true}}).to_string().into())).await.unwrap();
        loop {
            let message = socket.next().await.unwrap().unwrap();
            let Message::Text(text) = message else {
                continue;
            };
            let response: Value = serde_json::from_str(text.as_str()).unwrap();
            if response["id"] == 1 {
                assert!(
                    response.get("error").is_none()
                        && response["result"].get("exceptionDetails").is_none(),
                    "{response}"
                );
                break;
            }
        }
        tokio::time::timeout(Duration::from_secs(10), self.wire.opened.cancelled())
            .await
            .unwrap();
    }
    pub(super) async fn finish(mut self) {
        let (mut control, _) = connect_async(&self.browser_socket).await.unwrap();
        control
            .send(Message::Text(
                json!({"id":1,"method":"Browser.close","params":{}})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        loop {
            let message = control.next().await.unwrap().unwrap();
            if let Message::Text(text) = message {
                let response: Value = serde_json::from_str(text.as_str()).unwrap();
                if response["id"] == 1 {
                    assert!(response.get("error").is_none(), "{response}");
                    break;
                }
            }
        }
        let status = self.chrome.wait().await.unwrap();
        assert!(
            status.success(),
            "owned Chrome failed to shut down: {status}"
        );
        (&mut self.logging).await.unwrap();
        self.proxy.abort();
        let _ = (&mut self.proxy).await;
        self.profile.take().unwrap().close().unwrap();
    }
}
impl Drop for Browser {
    fn drop(&mut self) {
        self.proxy.abort();
        self.logging.abort();
        let _ = self.chrome.start_kill();
    }
}

pub(super) async fn product(endpoint: &str) -> Run {
    let mut run = Run::open().await;
    // Configure this existing embedding before its first evaluation. The empty
    // old watch has no native resources; no product/test-only switch is added.
    run.owner.stopping.cancel();
    run.owner.tasks.close();
    run.owner.tasks.wait().await;
    let mut owner = Arc::try_unwrap(run.owner)
        .unwrap_or_else(|_| panic!("empty fixture watch retained its owner"));
    owner.configuration.browsers = vec![maka_capabilities::computer::BrowserConnection {
        id: "fixture".into(),
        endpoint: endpoint.into(),
    }];
    owner.stopping = CancellationToken::new();
    owner.tasks.reopen();
    run.owner = Arc::new(owner);
    sessions::watch(&run.owner);
    let target = GrantTarget {
        capability: GrantCapability::Browser,
        scope: GrantScope::BrowserOrigin {
            origin: endpoint.into(),
        },
        ..api::target()
    };
    run.store
        .establish_run_interaction(
            &run.invocation,
            &InteractionRecord {
                session_id: run.invocation.session_id.clone(),
                turn_id: run.invocation.turn_id.clone(),
                run_id: run.invocation.run_id.clone(),
                request_id: "owned-browser-origin".into(),
                created_at: maka_agent_authority::now(),
                request: InteractionRequest::ClientCapability {
                    tool_use_id: "owned-browser-fixture".into(),
                    basis: Some(run.basis),
                    target: target.clone(),
                },
                outcome: None,
            },
        )
        .await
        .unwrap();
    assert!(
        run.store
            .commit_interaction_outcome(
                "owned-browser-origin",
                InteractionOutcome::ClientCapabilityDecision {
                    decision: Decision::Allow,
                    committed_at: maka_agent_authority::now()
                }
            )
            .await
            .unwrap()
            .matches
    );
    assert_eq!(
        run.store
            .client_capability_grant(&run.invocation.session_id, &target)
            .await
            .unwrap()
            .unwrap()
            .basis,
        Some(run.basis)
    );
    run
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires native-desktop, MAKA_CUA_TEST_CHROME and a task-owned MAKA_COMPUTER_LIVE_ARTIFACT_DIR; launches only a new headless Chrome profile"]
async fn product_dialog_closed_t2_precedes_same_rpc_ack_and_reset_does_not_release_custody() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let browser = Browser::open().await;
        let _release_on_failure = browser.wire.release.clone().drop_guard();
        let mut run = product(&browser.endpoint).await;
        let (_, warm) = run.invoke("dialog_bind", "evaluate", json!({
            "code":format!("var browser=await cua.getBrowser({{id:'fixture'}});var tab=await browser.tabs.get({});nodeRepl.write(await tab.playwright.locator('#ready').innerText());", json!(browser.target)),
            "timeout_ms":10000,"title":"Bind owned Chrome page"
        })).await;
        assert!(run.text(warm.unwrap()).await.contains("Page ready"));
        browser.open_dialog().await;
        let marker = format!("dialog-closed-{}=", Uuid::new_v4());
        let (outer, closed) = tokio::time::timeout(Duration::from_secs(10), run.invoke("dialog_closed", "evaluate", json!({
            "code":format!("var dialog=await tab.getJsDialog();if(dialog?.type!=='confirm')throw Error('wrong dialog');var returned=await dialog.accept();nodeRepl.write({}+JSON.stringify({{closed:returned===undefined}}));",json!(marker)),
            "timeout_ms":10000,"title":"Accept owned confirm dialog"
        }))).await.expect("public close must return after real Closed while the same RPC ACK is still held");
        let text = run.text(closed.unwrap()).await;
        let result: Value = serde_json::from_str(text.lines().find_map(|line| line.strip_prefix(&marker)).expect("public JS close result")).unwrap();
        assert_eq!(result, json!({"closed":true}));
        tokio::time::timeout(Duration::from_secs(5), browser.wire.held.cancelled()).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), browser.wire.closed_forwarded.cancelled()).await.unwrap();
        assert!(browser.wire.closed.load(Ordering::SeqCst) > 0);
        let wire_rows = browser.wire.rows.lock().unwrap().clone();
        let request = wire_rows.iter().find(|row| row["stage"]=="request_forwarded").unwrap();
        let ack = wire_rows.iter().find(|row| row["stage"]=="ack_held").unwrap();
        let closed_event = wire_rows.iter().find(|row| row["stage"]=="closed_forwarded").unwrap();
        assert_eq!(request["message"]["params"]["accept"], true);
        assert_eq!(closed_event["message"]["params"]["result"], true);
        assert_eq!(request["connection"], ack["connection"]);
        assert_eq!(request["connection"], closed_event["connection"]);
        assert_eq!(request["message"]["id"], ack["message"]["id"]);
        assert_eq!(request["message"]["sessionId"], closed_event["message"]["sessionId"]);
        let ledger = facts(&run.store, &run.invocation.session_id).await;
        let handles: Vec<_> = ledger.iter().filter_map(|stored| match &stored.event.fact {
            Fact::ToolDispatched { operation_id, name, input, call, .. } if name=="cua_operation" && input["method"]=="handleJsDialog" => {
                assert!(matches!(&call.origin, ToolOrigin::HostSdk { parent: Some(HostSdkParent::EvaluationObserver { operation_id: parent, epoch }), .. } if parent==&outer && !epoch.is_empty()));
                Some(operation_id.clone())
            }
            _ => None,
        }).collect();
        assert_eq!(handles.len(), 1);
        assert!(matches!(settled(&ledger, &handles[0]), Some(ToolOutcome::Succeeded { .. })));
        assert!(matches!(settled(&ledger, &outer), Some(ToolOutcome::Succeeded { .. })));
        assert_eq!(browser.wire.requests.load(Ordering::SeqCst), 1);
        let mut ending = Box::pin(run.effects.settle());
        assert!(futures_util::poll!(&mut ending).is_pending(), "original native Run lease must outlive the public result");
        assert!(!run.owner.resources.is_idle());
        run.record("dialog_before_reset", json!({"outer":outer,"inner":handles[0],"wire":browser.wire.snapshot(),"original_run_pending":true,"computer_resources_pending":true,"resource_note":"aggregate includes the logical turn watcher; exact native custody is independently asserted through InvocationEffects"})).await;
        let (_, reset) = run.invoke("dialog_reset_before_ack", "reset", json!({})).await;
        assert_eq!(reset.unwrap()["state"], "fresh");
        assert!(futures_util::poll!(&mut ending).is_pending(), "reset cannot release the original dialog RPC owner");
        let (_, pure) = run.invoke("dialog_fresh_vm", "evaluate", json!({"code":"nodeRepl.write(typeof tab);","timeout_ms":1000,"title":"Check reset VM"})).await;
        assert!(run.text(pure.unwrap()).await.contains("undefined"));
        assert!(futures_util::poll!(&mut ending).is_pending());
        assert!(!browser.wire.forwarded.is_cancelled());
        assert!(!browser.wire.lost_while_held.load(Ordering::SeqCst), "reset must retain the exact original connection until its RPC settles");
        assert_eq!(browser.wire.requests.load(Ordering::SeqCst), 1);
        run.record("dialog_ack_still_held", browser.wire.snapshot()).await;
        browser.wire.release.cancel();
        tokio::time::timeout(Duration::from_secs(10), ending).await.expect("the original RPC ACK must settle its same Run ticket").unwrap();
        tokio::time::timeout(Duration::from_secs(5), browser.wire.forwarded.cancelled()).await.unwrap();
        let released_rows = browser.wire.rows.lock().unwrap().clone();
        let released = released_rows.iter().find(|row| row["stage"]=="original_ack_forwarded").unwrap();
        assert_eq!(released["connection"], request["connection"]);
        assert_eq!(released["id"], request["message"]["id"]);
        assert!(!browser.wire.lost_while_held.load(Ordering::SeqCst));
        let final_ledger = facts(&run.store, &run.invocation.session_id).await;
        assert!(matches!(settled(&final_ledger, &handles[0]), Some(ToolOutcome::Succeeded { .. })));
        assert_eq!(final_ledger.iter().filter(|stored| matches!(&stored.event.fact, Fact::ToolDispatched { name, input, .. } if name=="cua_operation" && input["method"]=="handleJsDialog")).count(), 1);
        assert_eq!(browser.wire.requests.load(Ordering::SeqCst), 1);
        run.record("dialog_ack_released", json!({"wire":browser.wire.snapshot(),"original_run_settled":true,"scope":"actual Linux Computer.evaluate, canonical Root, public JS and main-frame Chrome Closed-first/held-ACK/reset; not Host transport/UI, OOPIF, origin revocation or cross-platform timing parity"})).await;
        run.close().await;
        NativeOwner::close(&Service(run.owner.clone())).await.unwrap();
        run.owner.store.shutdown().await.unwrap();
        browser.finish().await;
    }).await.unwrap();
}
