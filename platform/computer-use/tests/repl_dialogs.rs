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

#![cfg(feature = "native-desktop")]

use cua_driver_core::browser::cdp_ws::{CdpConnection, CdpEvent};
use maka_agent_facts::{
    language::Language,
    tools::{ToolError, ToolExecutor, ToolFuture},
};
use maka_capabilities::computer::{BrowserConnection, Desktop};
use maka_code_runtime::{CellContext, CellLimits, CellOutput, CellResult, CellStore};
use maka_computer_use::{
    AuthorizationFuture, BrowserAccess, BrowserAuthorization, BrowserHostEffects, Driver,
    HostEffectFuture, InvocationContext, Session, SessionOwner, facade,
};
use maka_js_runtime::repl::Repl;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    process::Stdio,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    sync::{Mutex, Notify, mpsc},
};
use tokio_util::sync::CancellationToken;

struct SiteAuthority {
    origins: Vec<String>,
}

impl BrowserAuthorization for SiteAuthority {
    fn authorize(
        &self,
        access: BrowserAccess,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        let origins = self.origins.clone();
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(ToolError::Failed("dialog fixture cancelled".into()));
            }
            let origin = access.origin()?;
            if origin
                .as_ref()
                .is_some_and(|origin| origins.contains(origin))
            {
                Ok(())
            } else {
                Err(ToolError::Failed("dialog fixture site denied".into()))
            }
        })
    }

    fn check(&self, access: BrowserAccess, cancellation: CancellationToken) -> AuthorizationFuture {
        self.authorize(access, cancellation)
    }
}

struct Bridge {
    session: Arc<Mutex<Session>>,
    authority: Arc<SiteAuthority>,
    effects: Arc<HostEffects>,
    turn: &'static str,
}

impl ToolExecutor for Bridge {
    fn names(&self) -> Vec<String> {
        vec!["cua".into()]
    }

    fn invoke(&self, _: String, input: Value, cancellation: CancellationToken) -> ToolFuture {
        let session = self.session.clone();
        let authority = self.authority.clone();
        let effects = self.effects.clone();
        let turn = self.turn;
        Box::pin(async move {
            session
                .lock()
                .await
                .invoke(
                    serde_json::from_value(input).unwrap(),
                    &InvocationContext::new("dialogs-fixture", turn)
                        .with_browser_authorization(authority)
                        .with_browser_host_effects(effects),
                    &cancellation,
                    Language::En,
                )
                .await
        })
    }
}

#[derive(Default)]
struct HostEffects {
    tasks: StdMutex<Vec<tokio::task::JoinHandle<Result<(), ToolError>>>>,
    admissions: AtomicUsize,
}

impl BrowserHostEffects for HostEffects {
    fn spawn(&self, unpolled: HostEffectFuture) -> Result<(), ToolError> {
        self.admissions.fetch_add(1, Ordering::SeqCst);
        self.tasks.lock().unwrap().push(tokio::spawn(unpolled));
        Ok(())
    }
}

impl HostEffects {
    async fn join(&self) {
        let tasks = std::mem::take(&mut *self.tasks.lock().unwrap());
        for task in tasks {
            task.await.unwrap().unwrap();
        }
    }
}

#[derive(Default)]
struct Results {
    values: StdMutex<HashMap<String, Value>>,
    changed: Notify,
}

struct ChildFrame {
    session: String,
    id: String,
    url: String,
}

struct Browser {
    chrome: tokio::process::Child,
    logging: tokio::task::JoinHandle<()>,
    server: tokio::task::JoinHandle<()>,
    endpoint: String,
    url: String,
    target: String,
    observer: CdpConnection,
    events: mpsc::UnboundedReceiver<CdpEvent>,
    root_session: String,
    root_frame: String,
    child_frames: HashMap<String, ChildFrame>,
    results: Arc<Results>,
    effects: Arc<HostEffects>,
    profile: Option<tempfile::TempDir>,
}

impl Drop for Browser {
    fn drop(&mut self) {
        self.server.abort();
        self.logging.abort();
        let _ = self.chrome.start_kill();
    }
}

impl Browser {
    async fn open() -> Self {
        let executable = std::env::var("MAKA_CUA_TEST_CHROME")
            .expect("MAKA_CUA_TEST_CHROME must name a task-owned test browser");
        let profile = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let url = format!("http://127.0.0.1:{port}/");
        let results = Arc::new(Results::default());
        let recorded = results.clone();
        let server = tokio::spawn(async move {
            let mut requests = tokio::task::JoinSet::new();
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let recorded = recorded.clone();
                requests.spawn(async move {
                    let mut stream = BufReader::new(stream);
                    let mut line = String::new();
                    if stream.read_line(&mut line).await.unwrap() == 0 {
                        return;
                    }
                    let path = line.split_whitespace().nth(1).unwrap_or("/").to_owned();
                    loop {
                        line.clear();
                        if stream.read_line(&mut line).await.unwrap() == 0 || line == "\r\n" {
                            break;
                        }
                    }
                    let request = reqwest::Url::parse(&format!("http://fixture{path}")).unwrap();
                    let body = if request.path() == "/result" {
                        let query: HashMap<_, _> = request.query_pairs().into_owned().collect();
                        let value = if query["value"] == "undefined" {
                            json!({"undefined": true})
                        } else {
                            serde_json::from_str(&query["value"]).unwrap()
                        };
                        eprintln!("dialog fixture page result {}: {value}", query["key"]);
                        recorded.values.lock().unwrap().insert(query["key"].clone(), value);
                        recorded.changed.notify_one();
                        "recorded".to_owned()
                    } else if request.path().starts_with("/remote-") {
                        format!(
                            "<!doctype html><meta charset=utf-8><title>{}</title><button>Remote ready</button>",
                            request.path()
                        )
                    } else {
                        format!(
                            r#"<!doctype html><meta charset="utf-8"><title>Maka dialogs fixture</title>
<button id="ready">Page ready</button>
<iframe id="remote-one" src="http://localhost:{port}/remote-one"></iframe>
<iframe id="remote-two" src="http://localhost:{port}/remote-two"></iframe>"#
                        )
                    };
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                });
                while requests.try_join_next().is_some() {}
            }
        });
        let mut chrome = tokio::process::Command::new(executable)
            .args([
                "--headless=new",
                "--site-per-process",
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
        let mut lines = BufReader::new(chrome.stderr.take().unwrap()).lines();
        let browser_ws = tokio::time::timeout(Duration::from_secs(20), async {
            while let Some(line) = lines.next_line().await.unwrap() {
                if let Some(url) = line.strip_prefix("DevTools listening on ") {
                    return url.to_owned();
                }
            }
            panic!("owned Chrome did not expose a debugger endpoint");
        })
        .await
        .unwrap();
        let endpoint = format!(
            "http://127.0.0.1:{}",
            reqwest::Url::parse(&browser_ws).unwrap().port().unwrap()
        );
        let logging = tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("dialog fixture Chrome: {line}");
            }
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let target = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let bytes = client
                    .get(format!("{endpoint}/json/list"))
                    .send()
                    .await
                    .unwrap()
                    .bytes()
                    .await
                    .unwrap();
                let tabs: Value = serde_json::from_slice(&bytes).unwrap();
                if let Some(tab) = tabs
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|tab| tab["url"] == url && tab["type"] == "page")
                {
                    break tab["id"].as_str().unwrap().to_owned();
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let observer = CdpConnection::connect_bounded(&browser_ws, usize::MAX)
            .await
            .unwrap();
        let mut events = observer.subscribe();
        let attached = observer
            .call(
                None,
                "Target.attachToTarget",
                json!({"targetId":target,"flatten":true}),
            )
            .await
            .unwrap();
        let root_session = attached["sessionId"].as_str().unwrap().to_owned();
        for method in ["Page.enable", "Runtime.enable", "Log.enable"] {
            observer
                .call(Some(&root_session), method, json!({}))
                .await
                .unwrap();
        }
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let reply = observer.call(Some(&root_session), "Runtime.evaluate", json!({
                    "expression":"document.readyState==='complete' && document.querySelector('#ready')!==null",
                    "returnByValue":true
                })).await.unwrap();
                if reply["result"]["value"] == true {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.unwrap();
        let tree = observer
            .call(Some(&root_session), "Page.getFrameTree", json!({}))
            .await
            .unwrap();
        assert_eq!(tree["frameTree"]["frame"]["url"], url);
        let root_frame = tree["frameTree"]["frame"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        observer
            .call(
                Some(&root_session),
                "Target.setAutoAttach",
                json!({
                    "autoAttach":true,"waitForDebuggerOnStart":false,"flatten":true,
                    "filter":[{"type":"iframe","exclude":false}]
                }),
            )
            .await
            .unwrap();
        let child_frames = tokio::time::timeout(Duration::from_secs(10), async {
            let mut children = HashMap::new();
            while children.len() < 2 {
                let event = events.recv().await.expect("observer connection closed");
                trace_event(&event);
                if event.method != "Target.attachedToTarget" {
                    continue;
                }
                let Some(url) = event.params["targetInfo"]["url"].as_str() else {
                    continue;
                };
                let path = reqwest::Url::parse(url).unwrap().path().to_owned();
                if !matches!(path.as_str(), "/remote-one" | "/remote-two") {
                    continue;
                }
                let session = event.params["sessionId"].as_str().unwrap().to_owned();
                for method in ["Page.enable", "Runtime.enable", "Log.enable"] {
                    observer
                        .call(Some(&session), method, json!({}))
                        .await
                        .unwrap();
                }
                let tree = observer
                    .call(Some(&session), "Page.getFrameTree", json!({}))
                    .await
                    .unwrap();
                let frame = &tree["frameTree"]["frame"];
                assert_eq!(frame["id"], event.params["targetInfo"]["targetId"]);
                assert_eq!(frame["parentId"], root_frame);
                assert_eq!(frame["url"], url);
                children.insert(
                    path.trim_start_matches('/').to_owned(),
                    ChildFrame {
                        session,
                        id: frame["id"].as_str().unwrap().to_owned(),
                        url: url.to_owned(),
                    },
                );
            }
            children
        })
        .await
        .expect("both task-owned cross-origin frame sessions must attach");
        Self {
            chrome,
            logging,
            server,
            endpoint,
            url,
            target,
            observer,
            events,
            root_session,
            root_frame,
            child_frames,
            results,
            effects: Arc::new(HostEffects::default()),
            profile: Some(profile),
        }
    }

    fn configure(&self, session: &mut Session) {
        session
            .configure(
                Desktop::Local,
                vec![BrowserConnection {
                    id: "fixture".into(),
                    endpoint: self.endpoint.clone(),
                }],
                Language::En,
            )
            .unwrap();
    }

    fn bridge(&self, session: Arc<Mutex<Session>>, turn: &'static str) -> Arc<Bridge> {
        let port = reqwest::Url::parse(&self.url).unwrap().port().unwrap();
        Arc::new(Bridge {
            session,
            authority: Arc::new(SiteAuthority {
                origins: vec![
                    format!("http://127.0.0.1:{port}"),
                    format!("http://localhost:{port}"),
                ],
            }),
            effects: self.effects.clone(),
            turn,
        })
    }

    fn frame_session(&self, frame: &str) -> &str {
        if frame == "root" {
            &self.root_session
        } else {
            &self.child_frames[frame].session
        }
    }

    async fn schedule(&self, frame: &str, key: &str, expression: &str) {
        let result_path = format!("/result?key={key}&value=");
        let expression = format!(
            "setTimeout(()=>{{const value=({expression});fetch({}+encodeURIComponent(value===undefined?'undefined':JSON.stringify(value))) }},0);true",
            json!(result_path)
        );
        let reply = self
            .observer
            .call(
                Some(self.frame_session(frame)),
                "Runtime.evaluate",
                json!({
                    "expression":expression,"returnByValue":true
                }),
            )
            .await
            .unwrap();
        eprintln!(
            "dialog fixture schedule frame={frame} session={} key={key} reply={reply}",
            self.frame_session(frame)
        );
        assert!(reply.get("exceptionDetails").is_none(), "{reply}");
    }

    async fn opened(&mut self, frame: &str, kind: &str, message: &str) {
        let session = self.frame_session(frame).to_owned();
        let (frame_id, frame_url) = if frame == "root" {
            (&self.root_frame, &self.url)
        } else {
            let child = &self.child_frames[frame];
            (&child.id, &child.url)
        };
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let event = self
                    .events
                    .recv()
                    .await
                    .expect("observer connection closed");
                trace_event(&event);
                if event.method == "Page.javascriptDialogOpening"
                    && event.params["type"] == kind
                    && event.params["message"] == message
                {
                    // Chrome reports the UI event on the root Page session,
                    // including when its actual initiator is an OOPIF. The
                    // event's frame identity still must match that exact child.
                    assert_eq!(
                        event.session_id.as_deref(),
                        Some(self.root_session.as_str()),
                        "unexpected dialog transport: {event:?}"
                    );
                    assert_eq!(event.params["frameId"], *frame_id, "{event:?}");
                    assert_eq!(event.params["url"], *frame_url, "{event:?}");
                    break;
                }
            }
        })
        .await
        .unwrap_or_else(|_| {
            panic!(
                "no {kind} opening for frame={frame} session={session} message={message:?}; recorded page results={:?}",
                self.results.values.lock().unwrap()
            )
        });
    }

    async fn result(&self, key: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let changed = self.results.changed.notified();
                if let Some(value) = self.results.values.lock().unwrap().get(key).cloned() {
                    return value;
                }
                changed.await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("page never reported result for {key}"))
    }

    async fn before_unload_navigation(&mut self) {
        for event in ["mousePressed", "mouseReleased"] {
            self.observer
                .call(
                    Some(&self.root_session),
                    "Input.dispatchMouseEvent",
                    json!({
                        "type":event,"x":25,"y":16,"button":"left","clickCount":1
                    }),
                )
                .await
                .unwrap();
        }
        let activation = self
            .observer
            .call(
                Some(&self.root_session),
                "Runtime.evaluate",
                json!({
                    "expression":"navigator.userActivation.hasBeenActive","returnByValue":true
                }),
            )
            .await
            .unwrap();
        assert_eq!(
            activation["result"]["value"], true,
            "owned fixture must have real sticky activation"
        );
        let destination = reqwest::Url::parse(&self.url)
            .unwrap()
            .join("/after-beforeunload")
            .unwrap()
            .to_string();
        let reply = self.observer.call(Some(&self.root_session), "Runtime.evaluate", json!({
            "expression":format!("onbeforeunload=event=>{{event.preventDefault();event.returnValue='fixture'}};setTimeout(()=>location.href={},0);true",json!(destination)),
            "returnByValue":true
        })).await.unwrap();
        assert!(reply.get("exceptionDetails").is_none(), "{reply}");
        tokio::time::timeout(Duration::from_secs(10), async {
            let mut opening = false;
            let mut accepted = false;
            let mut navigated = false;
            while !(opening && accepted && navigated) {
                let event = self
                    .events
                    .recv()
                    .await
                    .expect("observer connection closed");
                if event.session_id.as_deref() != Some(self.root_session.as_str()) {
                    continue;
                }
                match event.method.as_str() {
                    "Page.javascriptDialogOpening" if event.params["type"] == "beforeunload" => {
                        opening = true
                    }
                    "Page.javascriptDialogClosed" if opening => {
                        assert_eq!(
                            event.params["result"], true,
                            "beforeunload must actually be accepted"
                        );
                        accepted = true;
                    }
                    "Page.frameNavigated" if event.params["frame"]["url"] == destination => {
                        navigated = true
                    }
                    _ => {}
                }
            }
        })
        .await
        .expect(
            "active browser control must automatically accept beforeunload and complete navigation",
        );
    }

    async fn close(mut self) {
        self.effects.join().await;
        self.observer
            .call(None, "Browser.close", json!({}))
            .await
            .unwrap();
        let status = self.chrome.wait().await.unwrap();
        assert!(
            status.success(),
            "owned Chrome failed to shut down: {status}"
        );
        (&mut self.logging).await.unwrap();
        self.server.abort();
        self.profile.take().unwrap().close().unwrap();
    }

    async fn assert_prompt_unchanged(&mut self, key: &str, admissions: usize) {
        // Renderer Page methods can block behind the modal. Inspect the exact
        // target through the browser process on this same observer connection.
        let metadata = self
            .observer
            .call(
                None,
                "Target.getTargetInfo",
                json!({"targetId": self.target}),
            )
            .await
            .unwrap();
        assert_eq!(metadata["targetInfo"]["targetId"], self.target);
        assert_eq!(metadata["targetInfo"]["url"], self.url);
        while let Ok(event) = self.events.try_recv() {
            trace_event(&event);
            assert!(
                event.method != "Page.javascriptDialogClosed"
                    || event.session_id.as_deref() != Some(self.root_session.as_str()),
                "a refused operation closed the fixture prompt: {event:?}"
            );
        }
        assert!(
            self.results.values.lock().unwrap().get(key).is_none(),
            "the page resumed after a refused operation"
        );
        assert_eq!(
            self.effects.admissions.load(Ordering::SeqCst),
            admissions,
            "a refused operation admitted an automatic Host effect"
        );
    }
}

fn trace_event(event: &CdpEvent) {
    if matches!(
        event.method.as_str(),
        "Target.attachedToTarget"
            | "Target.detachedFromTarget"
            | "Page.javascriptDialogOpening"
            | "Page.javascriptDialogClosed"
            | "Page.frameNavigated"
            | "Runtime.exceptionThrown"
            | "Runtime.consoleAPICalled"
            | "Log.entryAdded"
    ) {
        eprintln!("dialog fixture observer: {event:?}");
    }
}

async fn native_command(
    session: &Arc<Mutex<Session>>,
    input: Value,
    context: &InvocationContext<'_>,
) -> Result<Value, ToolError> {
    session
        .lock()
        .await
        .invoke(
            serde_json::from_value(input).unwrap(),
            context,
            &CancellationToken::new(),
            Language::En,
        )
        .await
}

fn new_repl() -> Repl {
    Repl::new(
        facade(),
        CellLimits {
            heap_bytes: 128 * 1024 * 1024,
            ..Default::default()
        },
    )
}

async fn evaluate(repl: &Repl, bridge: Arc<dyn ToolExecutor>, source: &str) -> Value {
    let context = CellContext::new(CellStore::temporary().unwrap(), vec![]).unwrap();
    let result = repl
        .evaluate(
            source.into(),
            bridge,
            CancellationToken::new(),
            context.clone(),
            Duration::from_secs(20),
        )
        .await
        .unwrap();
    let outputs = context.take_output();
    assert!(
        matches!(result, CellResult::Success { .. }),
        "dialog fixture cell failed: {result:?}; outputs={outputs:?}; source={source}"
    );
    outputs
        .iter()
        .rev()
        .find_map(|output| match output {
            CellOutput::Text { text } => serde_json::from_str(text).ok(),
            _ => None,
        })
        .unwrap_or_else(|| {
            panic!(
                "dialog fixture cell emitted no explicit JSON result: {result:?}; outputs={outputs:?}; source={source}"
            )
        })
}

async fn bind(repl: &Repl, bridge: Arc<Bridge>, target: &str) {
    assert_eq!(evaluate(repl, bridge, &format!(
        "const browser=await cua.getBrowser({{id:'fixture'}});const tab=await browser.tabs.get({});nodeRepl.write({{dialog:(await tab.getJsDialog())===undefined,ready:await tab.playwright.locator('#ready').innerText()}});",
        json!(target)
    )).await, json!({"dialog":true,"ready":"Page ready"}));
}

async fn dialog(repl: &Repl, bridge: Arc<Bridge>, kind: &str) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let found = evaluate(repl, bridge.clone(), "globalThis.dialog=await tab.getJsDialog();nodeRepl.write(dialog?{type:dialog.type}:null);").await;
            if found == json!({"type":kind}) {
                break;
            }
            assert_eq!(found, Value::Null, "unexpected active dialog");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.unwrap();
}

fn element(state: &str, role: &str, name: &str) -> u64 {
    let name = json!(name).to_string();
    state
        .lines()
        .find(|line| line.contains(role) && line.contains(&name))
        .unwrap_or_else(|| panic!("missing {role} {name}: {state}"))
        .split_whitespace()
        .next()
        .unwrap()
        .parse()
        .unwrap()
}

#[derive(Default)]
struct DialogApiFixture {
    next: AtomicUsize,
    commands: Arc<StdMutex<Vec<Value>>>,
}

impl ToolExecutor for DialogApiFixture {
    fn names(&self) -> Vec<String> {
        vec!["cua".into()]
    }

    fn invoke(&self, _: String, input: Value, _: CancellationToken) -> ToolFuture {
        let metadata = match input["method"].as_str().unwrap() {
            "documentation" => json!("Dialog fixture reference"),
            "getBrowser" => json!({"id":"fixture"}),
            "browserTab" => {
                json!({"kind":"tab","id":"fixture:tab","handle":{"kind":"tab","id":"tab"}})
            }
            "getJsDialog" => match self.next.fetch_add(1, Ordering::SeqCst) {
                0 => Value::Null,
                1 => json!({"id":"alert-id","type":"alert"}),
                2 => json!({"id":"beforeunload-id","type":"beforeunload"}),
                3 => json!({"id":"confirm-id","type":"confirm"}),
                4 => json!({"id":"prompt-id","type":"prompt"}),
                other => panic!("unexpected fixture dialog read {other}"),
            },
            "handleJsDialog" => {
                serde_json::from_value::<maka_computer_use::protocol::Command>(input.clone())
                    .unwrap();
                self.commands.lock().unwrap().push(input);
                Value::Null
            }
            other => panic!("unexpected fixture command {other}"),
        };
        Box::pin(async move { Ok(metadata) })
    }
}

#[tokio::test]
async fn dialog_facade_exposes_finite_methods_and_validates_prompt_before_dispatch() {
    let repl = new_repl();
    let fixture = Arc::new(DialogApiFixture::default());
    let result = evaluate(&repl, fixture.clone(), r#"
        const browser=await cua.getBrowser({id:'fixture'});const tab=await browser.tabs.get('fixture:tab');
        const none=(await tab.getJsDialog())===undefined;
        const alert=await tab.getJsDialog(),beforeunload=await tab.getJsDialog(),confirm=await tab.getJsDialog(),prompt=await tab.getJsDialog();
        let validation=0;try{await prompt.accept()}catch{validation++}try{await prompt.accept(42)}catch{validation++}
        const returns=[await alert.dismiss(),await beforeunload.dismiss(),await confirm.accept(),await confirm.dismiss(),await prompt.accept(''),await prompt.accept('你好 🌍'),await prompt.dismiss()];
        nodeRepl.write({none,types:[alert.type,beforeunload.type,confirm.type,prompt.type],keys:[alert,beforeunload,confirm,prompt].map(value=>Object.keys(value).sort()),frozen:[alert,beforeunload,confirm,prompt].every(Object.isFrozen),returns:returns.every(value=>value===undefined),validation});
    "#).await;
    assert_eq!(
        result,
        json!({
            "none":true,"types":["alert","beforeunload","confirm","prompt"],
            "keys":[["dismiss","type"],["dismiss","type"],["accept","dismiss","type"],["accept","dismiss","type"]],
            "frozen":true,"returns":true,"validation":2
        })
    );
    assert_eq!(*fixture.commands.lock().unwrap(), json!([
        {"method":"handleJsDialog","handle":{"kind":"tab","id":"tab"},"dialogId":"alert-id","action":"dismiss"},
        {"method":"handleJsDialog","handle":{"kind":"tab","id":"tab"},"dialogId":"beforeunload-id","action":"dismiss"},
        {"method":"handleJsDialog","handle":{"kind":"tab","id":"tab"},"dialogId":"confirm-id","action":"accept"},
        {"method":"handleJsDialog","handle":{"kind":"tab","id":"tab"},"dialogId":"confirm-id","action":"dismiss"},
        {"method":"handleJsDialog","handle":{"kind":"tab","id":"tab"},"dialogId":"prompt-id","action":"accept","promptText":""},
        {"method":"handleJsDialog","handle":{"kind":"tab","id":"tab"},"dialogId":"prompt-id","action":"accept","promptText":"你好 🌍"},
        {"method":"handleJsDialog","handle":{"kind":"tab","id":"tab"},"dialogId":"prompt-id","action":"dismiss"}
    ]).as_array().unwrap().clone());
    repl.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires MAKA_CUA_TEST_CHROME; operates only its own temporary headless Chrome profile"]
async fn public_dialog_methods_preserve_actual_results_and_reject_stale_objects() {
    let mut browser = Browser::open().await;
    let driver = Arc::new(Mutex::new(Driver::default()));
    let mut native = Session::new(driver.clone());
    browser.configure(&mut native);
    let session = Arc::new(Mutex::new(native));
    let bridge = browser.bridge(session.clone(), "methods");
    let repl = new_repl();
    bind(&repl, bridge.clone(), &browser.target).await;
    let page_state = evaluate(
        &repl,
        bridge.clone(),
        "nodeRepl.write(JSON.stringify(await tab.getAXState({disableDiffing:true,emit:false})));",
    )
    .await;
    let page_button = element(page_state.as_str().unwrap(), "button", "Page ready");

    browser
        .schedule("root", "alert", "alert('fixture alert')")
        .await;
    browser.opened("root", "alert", "fixture alert").await;
    dialog(&repl, bridge.clone(), "alert").await;
    let projected = evaluate(&repl, bridge.clone(), &r#"
        let blocked=false,actionBlocked=false,shot=false;
        try{await tab.playwright.locator('#ready').innerText()}catch{blocked=true}
        try{await tab.click(PAGE_INDEX)}catch{actionBlocked=true}
        try{await tab.getScreenshot({emit:false})}catch(error){shot=String(error).toLowerCase().includes('screenshot')}
        const combined=await tab.getAXStateAndScreenshot({emit:false});
        nodeRepl.write({type:dialog.type,accept:typeof dialog.accept,blocked,actionBlocked,shot,state:combined.state,hasScreenshot:Object.hasOwn(combined,'screenshot')});
    "#.replace("PAGE_INDEX", &page_button.to_string())).await;
    assert_eq!(projected["type"], "alert");
    assert_eq!(projected["accept"], "undefined");
    assert_eq!(projected["blocked"], true);
    assert_eq!(projected["actionBlocked"], true);
    assert_eq!(projected["shot"], true);
    assert_eq!(projected["hasScreenshot"], false);
    assert!(
        projected["state"]
            .as_str()
            .unwrap()
            .contains("fixture alert"),
        "{projected}"
    );
    assert_eq!(
        evaluate(
            &repl,
            bridge.clone(),
            "await dialog.dismiss();nodeRepl.write((await tab.getJsDialog())===undefined);"
        )
        .await,
        true
    );
    assert_eq!(browser.result("alert").await, json!({"undefined":true}));

    for (key, expression, kind, message, action, expected) in [
        (
            "confirm-yes",
            "confirm('confirm yes')",
            "confirm",
            "confirm yes",
            "await dialog.accept()",
            json!(true),
        ),
        (
            "confirm-no",
            "confirm('confirm no')",
            "confirm",
            "confirm no",
            "await dialog.dismiss()",
            json!(false),
        ),
        (
            "prompt-empty",
            "prompt('prompt empty','initial')",
            "prompt",
            "prompt empty",
            "await dialog.accept('')",
            json!(""),
        ),
        (
            "prompt-unicode",
            "prompt('prompt unicode','initial')",
            "prompt",
            "prompt unicode",
            "await dialog.accept('你好, Καλημέρα 🌍')",
            json!("你好, Καλημέρα 🌍"),
        ),
        (
            "prompt-cancel",
            "prompt('prompt cancel','initial')",
            "prompt",
            "prompt cancel",
            "await dialog.dismiss()",
            Value::Null,
        ),
    ] {
        browser.schedule("root", key, expression).await;
        browser.opened("root", kind, message).await;
        dialog(&repl, bridge.clone(), kind).await;
        assert_eq!(
            evaluate(
                &repl,
                bridge.clone(),
                &format!("{action};nodeRepl.write((await tab.getJsDialog())===undefined);")
            )
            .await,
            true
        );
        assert_eq!(
            browser.result(key).await,
            expected,
            "actual page result for {key}"
        );
    }

    browser
        .schedule("root", "stale-old", "confirm('old confirm')")
        .await;
    browser.opened("root", "confirm", "old confirm").await;
    dialog(&repl, bridge.clone(), "confirm").await;
    evaluate(
        &repl,
        bridge.clone(),
        "globalThis.stale=dialog;await dialog.dismiss();nodeRepl.write(true);",
    )
    .await;
    assert_eq!(browser.result("stale-old").await, false);
    browser
        .schedule("root", "stale-new", "confirm('new confirm')")
        .await;
    browser.opened("root", "confirm", "new confirm").await;
    dialog(&repl, bridge.clone(), "confirm").await;
    assert_eq!(evaluate(&repl, bridge.clone(), "let rejected=false;try{await stale.dismiss()}catch{rejected=true}nodeRepl.write({rejected,type:(await tab.getJsDialog())?.type});").await, json!({"rejected":true,"type":"confirm"}));
    evaluate(
        &repl,
        bridge.clone(),
        "await dialog.accept();nodeRepl.write(true);",
    )
    .await;
    assert_eq!(browser.result("stale-new").await, true);
    assert_eq!(
        evaluate(
            &repl,
            bridge,
            "nodeRepl.write(JSON.stringify(await tab.playwright.locator('#ready').innerText()));"
        )
        .await,
        "Page ready"
    );

    repl.close().await.unwrap();
    session.lock().await.close().await.unwrap();
    driver.lock().await.close().await.unwrap();
    browser.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires MAKA_CUA_TEST_CHROME; verifies missing/denied site authority leaves an actual owned prompt open"]
async fn dialog_getter_and_handler_require_site_authority_without_changing_the_prompt() {
    let mut browser = Browser::open().await;
    let driver = Arc::new(Mutex::new(Driver::default()));
    let mut native = Session::new(driver.clone());
    browser.configure(&mut native);
    let session = Arc::new(Mutex::new(native));
    let bridge = browser.bridge(session.clone(), "authority");
    let repl = new_repl();
    bind(&repl, bridge.clone(), &browser.target).await;
    browser.effects.join().await;
    let allowed = InvocationContext::new("dialogs-fixture", "authority")
        .with_browser_authorization(bridge.authority.clone())
        .with_browser_host_effects(browser.effects.clone());
    let bound=native_command(&session,json!({"method":"browserTab","browserId":"fixture","reference":{"kind":"existing","id":browser.target}}),&allowed).await.unwrap();
    browser
        .schedule(
            "root",
            "authority-prompt",
            "prompt('authority must remain open','unchanged')",
        )
        .await;
    browser
        .opened("root", "prompt", "authority must remain open")
        .await;
    dialog(&repl, bridge.clone(), "prompt").await;
    let current = native_command(
        &session,
        json!({"method":"getJsDialog","handle":bound["handle"]}),
        &allowed,
    )
    .await
    .unwrap();
    assert_eq!(current["type"], "prompt");
    let admissions = browser.effects.admissions.load(Ordering::SeqCst);
    for (context, expected) in [
        (
            InvocationContext::new("dialogs-fixture", "authority"),
            "requires Host authorization",
        ),
        (
            InvocationContext::new("dialogs-fixture", "authority").with_browser_authorization(
                Arc::new(SiteAuthority {
                    origins: Vec::new(),
                }),
            ),
            "dialog fixture site denied",
        ),
    ] {
        for command in [
            json!({"method":"getJsDialog","handle":bound["handle"]}),
            json!({"method":"handleJsDialog","handle":bound["handle"],"dialogId":current["id"],"action":"accept","promptText":"must not reach the page"}),
        ] {
            let error = native_command(&session, command, &context)
                .await
                .unwrap_err();
            assert!(error.to_string().contains(expected), "{error}");
            browser
                .assert_prompt_unchanged("authority-prompt", admissions)
                .await;
            assert_eq!(
                native_command(
                    &session,
                    json!({"method":"getJsDialog","handle":bound["handle"]}),
                    &allowed
                )
                .await
                .unwrap(),
                current
            );
        }
    }
    evaluate(
        &repl,
        bridge.clone(),
        "await dialog.accept('authorized response');nodeRepl.write(true);",
    )
    .await;
    assert_eq!(
        browser.result("authority-prompt").await,
        "authorized response"
    );
    assert_eq!(
        evaluate(
            &repl,
            bridge,
            "nodeRepl.write(JSON.stringify(await tab.playwright.locator('#ready').innerText()));"
        )
        .await,
        "Page ready"
    );
    repl.close().await.unwrap();
    session.lock().await.close().await.unwrap();
    driver.lock().await.close().await.unwrap();
    browser.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires MAKA_CUA_TEST_CHROME; verifies real OOPIF dialogs and AX input in an owned temporary profile"]
async fn child_dialog_ax_controls_and_epoch_rebinding_keep_exact_identity() {
    let mut browser = Browser::open().await;
    assert_ne!(
        browser.frame_session("remote-one"),
        browser.frame_session("remote-two")
    );
    let driver = Arc::new(Mutex::new(Driver::default()));
    let owner = SessionOwner::new(driver.clone());
    let mut native = owner.new_epoch().unwrap();
    browser.configure(&mut native);
    let session = Arc::new(Mutex::new(native));
    let bridge = browser.bridge(session.clone(), "ax-turn");
    let repl = new_repl();
    bind(&repl, bridge.clone(), &browser.target).await;

    browser
        .schedule(
            "remote-one",
            "ax-enter",
            "prompt('first child prompt','default-one')",
        )
        .await;
    browser
        .opened("remote-one", "prompt", "first child prompt")
        .await;
    dialog(&repl, bridge.clone(), "prompt").await;
    let state = evaluate(
        &repl,
        bridge.clone(),
        "nodeRepl.write(JSON.stringify(await tab.getAXState({disableDiffing:true,emit:false})));",
    )
    .await;
    let state = state.as_str().unwrap();
    assert!(
        state.contains("first child prompt") && state.contains("default-one"),
        "{state}"
    );
    let old_prompt = element(state, "textbox", "Response");
    element(state, "button", "Cancel");
    element(state, "button", "OK");
    let edited = evaluate(&repl, bridge.clone(), &format!(
        "await tab.setValue({old_prompt},'Edited ');await tab.typeText({old_prompt},'文本');nodeRepl.write(JSON.stringify(await tab.getAXState({{disableDiffing:true,emit:false}})));"
    )).await;
    assert!(edited.as_str().unwrap().contains("Edited 文本"), "{edited}");
    evaluate(
        &repl,
        bridge.clone(),
        &format!("await tab.pressKey({old_prompt},'Enter');nodeRepl.write(true);"),
    )
    .await;
    assert_eq!(browser.result("ax-enter").await, "Edited 文本");

    browser
        .schedule(
            "remote-two",
            "ax-escape",
            "prompt('second child prompt','default-two')",
        )
        .await;
    browser
        .opened("remote-two", "prompt", "second child prompt")
        .await;
    dialog(&repl, bridge.clone(), "prompt").await;
    let state = evaluate(
        &repl,
        bridge.clone(),
        "nodeRepl.write(JSON.stringify(await tab.getAXState({disableDiffing:true,emit:false})));",
    )
    .await;
    let state = state.as_str().unwrap();
    let prompt = element(state, "textbox", "Response");
    assert_ne!(
        prompt, old_prompt,
        "a new dialog must not inherit an old AX control index"
    );
    assert_eq!(evaluate(&repl, bridge.clone(), &format!(
        "let staleControl=false;try{{await tab.setValue({old_prompt},'wrong target')}}catch{{staleControl=true}}nodeRepl.write({{staleControl,state:await tab.getAXState({{disableDiffing:true,emit:false}})}});"
    )).await["staleControl"], true);
    evaluate(&repl, bridge.clone(), &format!("await tab.setValue({prompt},'discarded 文本');await tab.pressKey({prompt},'Escape');nodeRepl.write(true);")).await;
    assert_eq!(browser.result("ax-escape").await, Value::Null);

    browser
        .schedule("remote-two", "ax-click", "confirm('second child confirm')")
        .await;
    browser
        .opened("remote-two", "confirm", "second child confirm")
        .await;
    dialog(&repl, bridge.clone(), "confirm").await;
    let state = evaluate(
        &repl,
        bridge.clone(),
        "nodeRepl.write(JSON.stringify(await tab.getAXState({disableDiffing:true,emit:false})));",
    )
    .await;
    let accept = element(state.as_str().unwrap(), "button", "OK");
    evaluate(
        &repl,
        bridge.clone(),
        &format!("await tab.click({accept});nodeRepl.write(true);"),
    )
    .await;
    assert_eq!(browser.result("ax-click").await, true);

    let bound = session.lock().await.invoke(
        serde_json::from_value(json!({"method":"browserTab","browserId":"fixture","reference":{"kind":"existing","id":browser.target}})).unwrap(),
        &InvocationContext::new("dialogs-fixture", "ax-turn"),
        &CancellationToken::new(),
        Language::En,
    ).await.unwrap();
    session
        .lock()
        .await
        .finish_turn("dialogs-fixture", "ax-turn", Language::En)
        .await
        .unwrap();
    let next_turn = browser.bridge(session.clone(), "after-turn");
    assert_eq!(evaluate(&repl, next_turn.clone(), "nodeRepl.write({dialog:(await tab.getJsDialog())===undefined,ready:await tab.playwright.locator('#ready').innerText()});").await,
        json!({"dialog":true,"ready":"Page ready"}));
    browser
        .schedule("root", "after-turn", "confirm('after turn')")
        .await;
    browser.opened("root", "confirm", "after turn").await;
    dialog(&repl, next_turn.clone(), "confirm").await;
    evaluate(
        &repl,
        next_turn,
        "await dialog.accept();nodeRepl.write(true);",
    )
    .await;
    assert_eq!(browser.result("after-turn").await, true);

    let before_reset = browser.bridge(session.clone(), "after-turn");
    let before_context = InvocationContext::new("dialogs-fixture", "after-turn")
        .with_browser_authorization(before_reset.authority.clone())
        .with_browser_host_effects(browser.effects.clone());
    browser
        .schedule(
            "root",
            "before-reset-id",
            "prompt('before reset identity','old response')",
        )
        .await;
    browser
        .opened("root", "prompt", "before reset identity")
        .await;
    dialog(&repl, before_reset.clone(), "prompt").await;
    let old_dialog = native_command(
        &session,
        json!({"method":"getJsDialog","handle":bound["handle"]}),
        &before_context,
    )
    .await
    .unwrap();
    assert_eq!(old_dialog["type"], "prompt");
    evaluate(
        &repl,
        before_reset,
        "await dialog.dismiss();nodeRepl.write(true);",
    )
    .await;
    assert_eq!(browser.result("before-reset-id").await, Value::Null);

    repl.close().await.unwrap();
    session.lock().await.close_native().await.unwrap();
    let mut native = owner.new_epoch().unwrap();
    browser.configure(&mut native);
    let reset = Arc::new(Mutex::new(native));
    let after_reset = browser.bridge(reset.clone(), "after-reset");
    let rejected = reset
        .lock()
        .await
        .invoke(
            serde_json::from_value(json!({"method":"getJsDialog","handle":bound["handle"]}))
                .unwrap(),
            &InvocationContext::new("dialogs-fixture", "after-reset")
                .with_browser_authorization(after_reset.authority.clone()),
            &CancellationToken::new(),
            Language::En,
        )
        .await
        .unwrap_err();
    assert!(rejected.to_string().contains("stale_tab"), "{rejected}");
    let replacement_repl = new_repl();
    bind(&replacement_repl, after_reset.clone(), &browser.target).await;
    browser
        .schedule("root", "after-reset", "prompt('after reset','old')")
        .await;
    browser.opened("root", "prompt", "after reset").await;
    dialog(&replacement_repl, after_reset.clone(), "prompt").await;
    let after_context = InvocationContext::new("dialogs-fixture", "after-reset")
        .with_browser_authorization(after_reset.authority.clone())
        .with_browser_host_effects(browser.effects.clone());
    let fresh_bound=native_command(&reset,json!({"method":"browserTab","browserId":"fixture","reference":{"kind":"existing","id":browser.target}}),&after_context).await.unwrap();
    assert_ne!(fresh_bound["handle"], bound["handle"]);
    let fresh_dialog = native_command(
        &reset,
        json!({"method":"getJsDialog","handle":fresh_bound["handle"]}),
        &after_context,
    )
    .await
    .unwrap();
    assert_eq!(fresh_dialog["type"], "prompt");
    assert_ne!(fresh_dialog["id"], old_dialog["id"]);
    let admissions = browser.effects.admissions.load(Ordering::SeqCst);
    let error=native_command(&reset,json!({"method":"handleJsDialog","handle":fresh_bound["handle"],"dialogId":old_dialog["id"],"action":"accept","promptText":"stale ID must not reach the page"}),&after_context).await.unwrap_err();
    assert!(error.to_string().contains("no longer active"), "{error}");
    browser
        .assert_prompt_unchanged("after-reset", admissions)
        .await;
    assert_eq!(
        native_command(
            &reset,
            json!({"method":"getJsDialog","handle":fresh_bound["handle"]}),
            &after_context
        )
        .await
        .unwrap(),
        fresh_dialog
    );
    evaluate(
        &replacement_repl,
        after_reset,
        "await dialog.accept('fresh epoch');nodeRepl.write(true);",
    )
    .await;
    assert_eq!(browser.result("after-reset").await, "fresh epoch");
    browser.before_unload_navigation().await;
    browser.effects.join().await;

    replacement_repl.close().await.unwrap();
    reset.lock().await.close_native().await.unwrap();
    owner.close().await.unwrap();
    driver.lock().await.close().await.unwrap();
    browser.close().await;
}
