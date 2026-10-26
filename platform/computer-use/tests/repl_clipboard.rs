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
    AuthorizationFuture, BrowserAccess, BrowserAttachmentAuthorization, BrowserAttachmentOrigin,
    BrowserAuthorization, BrowserHostEffects, Driver, HostEffectFuture, InvocationContext, Session,
    facade,
};
use maka_js_runtime::repl::Repl;
use serde_json::{Value, json};
use std::{
    process::Stdio,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    sync::{Mutex, mpsc},
};
use tokio_util::sync::CancellationToken;

struct SiteState {
    origins: Vec<String>,
    allowed: AtomicBool,
    revoke_after_allow: AtomicBool,
    pause: AtomicBool,
    entered: CancellationToken,
    checks: AtomicUsize,
}

#[derive(Clone)]
struct SiteAuthority(Arc<SiteState>);

impl BrowserAuthorization for SiteAuthority {
    fn authorize(
        &self,
        access: BrowserAccess,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        let state = self.0.clone();
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(ToolError::Failed("clipboard fixture cancelled".into()));
            }
            let origin = access.origin()?;
            if state.allowed.load(Ordering::SeqCst)
                && origin.is_none_or(|origin| state.origins.contains(&origin))
            {
                Ok(())
            } else {
                Err(ToolError::Failed("clipboard fixture site denied".into()))
            }
        })
    }
    fn check(&self, access: BrowserAccess, cancellation: CancellationToken) -> AuthorizationFuture {
        self.authorize(access, cancellation)
    }
    fn attachment(&self) -> Option<Arc<dyn BrowserAttachmentAuthorization>> {
        Some(Arc::new(self.clone()))
    }
}

impl BrowserAttachmentAuthorization for SiteAuthority {
    fn check(
        &self,
        origin: BrowserAttachmentOrigin,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        let state = self.0.clone();
        Box::pin(async move {
            state.checks.fetch_add(1, Ordering::SeqCst);
            if state.pause.load(Ordering::SeqCst) {
                state.entered.cancel();
                cancellation.cancelled().await;
            }
            if cancellation.is_cancelled() {
                return Err(ToolError::Failed("clipboard attachment ended".into()));
            }
            let allowed = state.allowed.load(Ordering::SeqCst);
            if allowed && state.revoke_after_allow.swap(false, Ordering::SeqCst) {
                state.allowed.store(false, Ordering::SeqCst);
            }
            match origin {
                BrowserAttachmentOrigin::Site(origin)
                    if allowed && state.origins.contains(&origin) =>
                {
                    Ok(())
                }
                _ => Err(ToolError::Failed("clipboard fixture site denied".into())),
            }
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
        loop {
            let tasks = std::mem::take(&mut *self.tasks.lock().unwrap());
            if tasks.is_empty() {
                break;
            }
            for task in tasks {
                task.await.unwrap().unwrap();
            }
        }
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
            let command = serde_json::from_value(input)
                .map_err(|error| ToolError::Failed(error.to_string()))?;
            session
                .lock()
                .await
                .invoke(
                    command,
                    &InvocationContext::new("clipboard-fixture", turn)
                        .with_browser_authorization(authority)
                        .with_browser_host_effects(effects),
                    &cancellation,
                    Language::En,
                )
                .await
        })
    }
}

struct Browser {
    chrome: tokio::process::Child,
    profile: Option<tempfile::TempDir>,
    server: tokio::task::JoinHandle<()>,
    logging: tokio::task::JoinHandle<()>,
    observer: Arc<CdpConnection>,
    events: mpsc::UnboundedReceiver<CdpEvent>,
    endpoint: String,
    target: String,
    url: String,
    child_url: String,
    child: String,
}

impl Drop for Browser {
    fn drop(&mut self) {
        self.server.abort();
        self.logging.abort();
        let _ = self.chrome.start_kill();
    }
}

impl Browser {
    async fn start() -> Self {
        let executable = std::env::var("MAKA_CUA_TEST_CHROME")
            .expect("MAKA_CUA_TEST_CHROME must name a task-owned test browser");
        let profile = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let url = format!("http://127.0.0.1:{port}/fixture");
        let child_url = format!("http://localhost:{port}/child");
        let server = tokio::spawn(async move {
            let mut tasks = tokio::task::JoinSet::new();
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                tasks.spawn(async move {
                    let mut stream=BufReader::new(stream);
                    let mut line=String::new();
                    if stream.read_line(&mut line).await.unwrap()==0 {return;}
                    let path=line.split_whitespace().nth(1).unwrap_or("/").to_owned();
                    loop {line.clear();if stream.read_line(&mut line).await.unwrap()==0 || line=="\r\n" {break;}}
                    let body=if path.starts_with("/child") {
                        "<!doctype html><meta charset=utf-8><title>Owned clipboard child</title><div id=ready>Child ready</div>".to_owned()
                    } else {
                        format!(r#"<!doctype html><meta charset=utf-8><title>Owned clipboard page</title>
<div id=ready>Page ready</div><iframe id=child src="http://localhost:{port}/child"></iframe><iframe id=blank src="about:blank"></iframe>
<script>globalThis.priorClipboard=navigator.clipboard;globalThis.priorReadText=navigator.clipboard?.readText;</script>"#)
                    };
                    let response=format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                    let _=stream.write_all(response.as_bytes()).await;
                });
                while tasks.try_join_next().is_some() {}
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
                if let Some(ws) = line.strip_prefix("DevTools listening on ") {
                    return ws.to_owned();
                }
                eprintln!("clipboard fixture startup: {line}");
            }
            panic!("owned Chrome did not expose a debugger endpoint");
        })
        .await
        .unwrap();
        let logging = tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("clipboard fixture Chrome: {line}");
            }
        });
        let endpoint = format!(
            "http://127.0.0.1:{}",
            reqwest::Url::parse(&browser_ws).unwrap().port().unwrap()
        );
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let selected = tokio::time::timeout(Duration::from_secs(10), async {
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
                    break tab.clone();
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let target = selected["id"].as_str().unwrap().to_owned();
        let observer = Arc::new(
            CdpConnection::connect_bounded(
                selected["webSocketDebuggerUrl"].as_str().unwrap(),
                usize::MAX,
            )
            .await
            .unwrap(),
        );
        let events = observer.subscribe();
        for (method, params) in [
            ("Runtime.enable", json!({})),
            ("Page.enable", json!({})),
            (
                "Target.setAutoAttach",
                json!({"autoAttach":true,"waitForDebuggerOnStart":false,"flatten":true}),
            ),
        ] {
            observer.call(None, method, params).await.unwrap();
        }
        let mut browser = Self {
            chrome,
            profile: Some(profile),
            server,
            logging,
            observer,
            events,
            endpoint,
            target,
            url,
            child_url,
            child: String::new(),
        };
        browser
            .wait_page(
                None,
                "document.readyState==='complete' && document.querySelector('#ready')!==null",
            )
            .await;
        browser.child = browser.child_session(&browser.child_url.clone()).await;
        browser
    }

    async fn child_session(&mut self, url: &str) -> String {
        let session = tokio::time::timeout(Duration::from_secs(10), async {
            let mut attached = std::collections::HashMap::<String, (String, String)>::new();
            loop {
                let event = self
                    .events
                    .recv()
                    .await
                    .expect("owned observer remains connected");
                eprintln!("clipboard fixture observer: {event:?}");
                if event.session_id.is_some() {
                    continue;
                }
                match event.method.as_str() {
                    "Target.attachedToTarget" if event.params["targetInfo"]["type"] == "iframe" => {
                        let info = &event.params["targetInfo"];
                        let target = info["targetId"].as_str().unwrap().to_owned();
                        let session = event.params["sessionId"].as_str().unwrap().to_owned();
                        let current_url = info["url"].as_str().unwrap().to_owned();
                        attached.insert(target, (session.clone(), current_url.clone()));
                        if current_url == url {
                            break session;
                        }
                    }
                    "Target.targetInfoChanged"
                        if event.params["targetInfo"]["type"] == "iframe" =>
                    {
                        let info = &event.params["targetInfo"];
                        let target = info["targetId"].as_str().unwrap();
                        if let Some((session, current_url)) = attached.get_mut(target) {
                            *current_url = info["url"].as_str().unwrap().to_owned();
                            if current_url.as_str() == url {
                                break session.clone();
                            }
                        }
                    }
                    "Target.detachedFromTarget" => {
                        if let Some(session) = event.params["sessionId"].as_str() {
                            attached.retain(|_, (current, _)| current.as_str() != session);
                        }
                    }
                    "Target.targetDestroyed" => {
                        if let Some(target) = event.params["targetId"].as_str() {
                            attached.remove(target);
                        }
                    }
                    _ => {}
                }
            }
        })
        .await
        .unwrap();
        for method in ["Runtime.enable", "Page.enable"] {
            self.observer
                .call(Some(&session), method, json!({}))
                .await
                .unwrap();
        }
        let tree = self
            .observer
            .call(Some(&session), "Page.getFrameTree", json!({}))
            .await
            .unwrap();
        let frame = &tree["frameTree"]["frame"];
        assert_eq!(frame["url"], url);
        self.observer
            .call(None, "DOM.getFrameOwner", json!({"frameId":frame["id"]}))
            .await
            .unwrap();
        session
    }

    async fn page(&self, session: Option<&str>, expression: &str) -> Value {
        let reply = tokio::time::timeout(
            Duration::from_secs(10),
            self.observer.call(
                session,
                "Runtime.evaluate",
                json!({
                    "expression":expression,"awaitPromise":true,"returnByValue":true
                }),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(
            reply.get("exceptionDetails").is_none(),
            "page expression failed: {expression}; {reply}"
        );
        reply["result"]["value"].clone()
    }

    async fn wait_page(&self, session: Option<&str>, expression: &str) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if self.page(session, expression).await == true {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }

    async fn reload(&self) {
        let before = self
            .observer
            .call(None, "Page.getFrameTree", json!({}))
            .await
            .unwrap()["frameTree"]["frame"]["loaderId"]
            .clone();
        self.observer
            .call(None, "Page.reload", json!({}))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let tree = self
                    .observer
                    .call(None, "Page.getFrameTree", json!({}))
                    .await
                    .unwrap();
                if tree["frameTree"]["frame"]["loaderId"] != before {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        self.wait_page(
            None,
            "document.readyState==='complete' && document.querySelector('#ready')!==null",
        )
        .await;
    }

    async fn stop(&mut self) {
        let _ = self.observer.call(None, "Browser.close", json!({})).await;
        assert!(
            tokio::time::timeout(Duration::from_secs(20), self.chrome.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
        (&mut self.logging).await.unwrap();
        self.server.abort();
        self.profile.take().unwrap().close().unwrap();
    }
}

async fn evaluate(repl: &Repl, bridge: Arc<Bridge>, source: &str) -> Value {
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
    let output = context.take_output();
    assert!(
        matches!(result, CellResult::Success { .. }),
        "clipboard cell failed: {result:?}; output={output:?}; source={source}"
    );
    let text = output
        .iter()
        .rev()
        .find_map(|part| match part {
            CellOutput::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no clipboard result text: {output:?}; {source}"));
    serde_json::from_str(text).unwrap_or_else(|error|panic!("invalid JSON clipboard result: {error}; result={text:?}; output={output:?}; source={source}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires task-owned Chrome; starts only private headless profiles and loopback pages"]
async fn public_clipboard_shares_real_page_values_and_owns_turn_and_epoch_cleanup() {
    let mut browser = Browser::start().await;
    let driver = Arc::new(Mutex::new(Driver::default()));
    let mut session = Session::new(driver);
    session
        .configure(
            Desktop::Local,
            vec![BrowserConnection {
                id: "fixture".into(),
                endpoint: browser.endpoint.clone(),
            }],
            Language::En,
        )
        .unwrap();
    let session = Arc::new(Mutex::new(session));
    let port = reqwest::Url::parse(&browser.url).unwrap().port().unwrap();
    let state = Arc::new(SiteState {
        origins: vec![
            format!("http://127.0.0.1:{port}"),
            format!("http://localhost:{port}"),
        ],
        allowed: AtomicBool::new(true),
        revoke_after_allow: AtomicBool::new(false),
        pause: AtomicBool::new(false),
        entered: CancellationToken::new(),
        checks: AtomicUsize::new(0),
    });
    let effects = Arc::new(HostEffects::default());
    let bridge = Arc::new(Bridge {
        session: session.clone(),
        authority: Arc::new(SiteAuthority(state.clone())),
        effects: effects.clone(),
        turn: "clipboard-first",
    });
    let repl = Repl::new(
        facade(),
        CellLimits {
            heap_bytes: 128 * 1024 * 1024,
            ..Default::default()
        },
    );
    assert_eq!(evaluate(&repl,bridge.clone(),&format!("globalThis.browser=await cua.getBrowser({{id:'fixture'}});globalThis.tab=await browser.tabs.get({});nodeRepl.write(JSON.stringify(Object.keys(tab.clipboard).sort()));",json!(browser.target))).await,json!(["read","readText","write","writeText"]));
    assert_eq!(evaluate(&repl,bridge.clone(),"nodeRepl.write(JSON.stringify({result:(await tab.clipboard.writeText('Café 日本語 🐧'))===undefined,text:await tab.clipboard.readText()}));").await,json!({"result":true,"text":"Café 日本語 🐧"}));
    assert_eq!(
        browser.page(None, "navigator.clipboard.readText()").await,
        "Café 日本語 🐧"
    );
    assert_eq!(
        browser
            .page(
                None,
                "navigator.clipboard.writeText('page Γειά 世界 🦀').then(()=>true)"
            )
            .await,
        true
    );
    assert_eq!(
        evaluate(
            &repl,
            bridge.clone(),
            "nodeRepl.write(JSON.stringify(await tab.clipboard.readText()));"
        )
        .await,
        "page Γειά 世界 🦀"
    );
    assert_eq!(
        evaluate(
            &repl,
            bridge.clone(),
            "await tab.clipboard.writeText('');nodeRepl.write(JSON.stringify(await tab.clipboard.readText()));"
        )
        .await,
        ""
    );
    assert_eq!(
        browser.page(None, "navigator.clipboard.readText()").await,
        ""
    );

    let rich = json!([{ "entries":[{"mimeType":"text/plain","base64":"SGVsbG8="},{"mimeType":"application/x-maka-test","base64":"AAECf4D/"}],"presentationStyle":"inline"},{"entries":[{"mimeType":"text/plain","text":"must not replace first plain entry"}],"presentationStyle":"attachment"}]);
    assert_eq!(evaluate(&repl,bridge.clone(),&format!("await tab.clipboard.write({rich});nodeRepl.write(JSON.stringify({{items:await tab.clipboard.read(),text:await tab.clipboard.readText()}}));")).await,json!({"items":rich,"text":""}));
    assert_eq!(
        browser.page(None, "navigator.clipboard.readText()").await,
        "Hello"
    );
    assert_eq!(browser.page(None,"(async()=>{const items=await navigator.clipboard.read();return {types:items[0].types,bytes:[...new Uint8Array(await (await items[0].getType('application/x-maka-test')).arrayBuffer())]};})()").await,json!({"types":["text/plain","application/x-maka-test"],"bytes":[0,1,2,127,128,255]}));
    assert_eq!(browser.page(None,"navigator.clipboard.write([{types:['text/plain','application/x-maka-test'],presentationStyle:'attachment',async getType(type){return type==='text/plain'?new Blob(['page rich 🐧'],{type}):new Blob([new Uint8Array([0,1,2,127,128,255])],{type});}}]).then(()=>true)").await,true);
    let page_rich = json!([{"entries":[{"mimeType":"text/plain","text":"page rich 🐧"},{"mimeType":"application/x-maka-test","base64":"AAECf4D/"}],"presentationStyle":"attachment"}]);
    assert_eq!(
        evaluate(
            &repl,
            bridge.clone(),
            "nodeRepl.write(JSON.stringify(await tab.clipboard.read()));"
        )
        .await,
        page_rich
    );
    let admissions = effects.admissions.load(Ordering::SeqCst);
    assert_eq!(
        browser
            .page(None, "navigator.clipboard.write([]).then(()=>true)")
            .await,
        true
    );
    assert_eq!(
        effects.admissions.load(Ordering::SeqCst),
        admissions,
        "empty page write sent a host request"
    );
    assert_eq!(
        evaluate(
            &repl,
            bridge.clone(),
            "nodeRepl.write(JSON.stringify(await tab.clipboard.read()));"
        )
        .await,
        page_rich
    );
    for invalid in [
        json!([]),
        json!([{"entries":[]}]),
        json!([{"entries":[{"mimeType":"","text":"x"}]}]),
        json!([{"entries":[{"mimeType":"text/plain","text":"x","base64":"eA=="}]}]),
        json!([{"entries":[{"mimeType":"text/plain"}]}]),
        json!([{"entries":[{"mimeType":"text/plain","base64":"A"}]}]),
        json!([{"entries":[{"mimeType":"text/plain","text":"x"}],"presentationStyle":"bad"}]),
    ] {
        assert_eq!(evaluate(&repl,bridge.clone(),&format!("nodeRepl.write(JSON.stringify(await(async()=>{{try{{await tab.clipboard.write({invalid});return false;}}catch{{return true;}}}})()));")).await,true);
        assert_eq!(
            evaluate(
                &repl,
                bridge.clone(),
                "nodeRepl.write(JSON.stringify(await tab.clipboard.read()));"
            )
            .await,
            page_rich
        );
    }
    assert_eq!(
        browser
            .page(
                None,
                "navigator.clipboard.writeText(undefined).then(()=>navigator.clipboard.readText())"
            )
            .await,
        "undefined"
    );
    assert_eq!(
        browser
            .page(
                None,
                "navigator.clipboard.writeText(null).then(()=>navigator.clipboard.readText())"
            )
            .await,
        "null"
    );
    assert_eq!(browser.page(None,"Promise.all([navigator.clipboard.writeText(),navigator.clipboard.writeText(Symbol()),navigator.clipboard.read.call({})].map(p=>p.then(()=>false,e=>e instanceof TypeError)))").await,json!([true,true,true]));
    assert_eq!(
        evaluate(
            &repl,
            bridge.clone(),
            "nodeRepl.write(JSON.stringify(await tab.clipboard.readText()));"
        )
        .await,
        "null"
    );
    browser
        .wait_page(
            Some(&browser.child),
            "typeof globalThis.__makaVirtualClipboard==='object'",
        )
        .await;
    assert_eq!(
        browser
            .page(Some(&browser.child), "navigator.clipboard.readText()")
            .await,
        "null"
    );
    assert_eq!(
        browser
            .page(
                None,
                "document.getElementById('blank').contentWindow.navigator.clipboard.readText()"
            )
            .await,
        "null",
        "inherited about:blank origin was lost"
    );

    let second = browser
        .observer
        .call(
            None,
            "Target.createTarget",
            json!({"url":format!("{}?second",browser.url)}),
        )
        .await
        .unwrap();
    let second = second["targetId"].as_str().unwrap().to_owned();
    let second_route = browser
        .observer
        .call(
            None,
            "Target.attachToTarget",
            json!({"targetId":second,"flatten":true}),
        )
        .await
        .unwrap();
    let second_route = second_route["sessionId"].as_str().unwrap().to_owned();
    browser
        .wait_page(Some(&second_route), "document.readyState==='complete'")
        .await;
    assert_eq!(evaluate(&repl,bridge.clone(),&format!("globalThis.tab2=await browser.tabs.get({});nodeRepl.write(JSON.stringify(await tab2.clipboard.readText()));",json!(second))).await,"null","two tabs in one backend did not share clipboard data");
    assert_eq!(
        browser
            .page(
                Some(&second_route),
                "navigator.clipboard.writeText('second tab').then(()=>true)"
            )
            .await,
        true
    );
    assert_eq!(
        evaluate(
            &repl,
            bridge.clone(),
            "nodeRepl.write(JSON.stringify(await tab.clipboard.readText()));"
        )
        .await,
        "second tab"
    );
    assert_eq!(
        evaluate(
            &repl,
            bridge.clone(),
            "await tab.clipboard.writeText('null');nodeRepl.write(JSON.stringify(await tab2.clipboard.readText()));"
        )
        .await,
        "null"
    );

    state.allowed.store(false, Ordering::SeqCst);
    assert_eq!(browser.page(None,"navigator.clipboard.readText().then(()=>({success:true}),e=>({success:false,error:e.message}))").await,json!({"success":false,"error":"tool failed: clipboard fixture site denied"}));
    assert_eq!(
        browser
            .page(
                None,
                "navigator.clipboard.writeText('must not persist').then(()=>true,()=>false)"
            )
            .await,
        false
    );
    state.allowed.store(true, Ordering::SeqCst);
    assert_eq!(
        evaluate(
            &repl,
            bridge.clone(),
            "nodeRepl.write(JSON.stringify(await tab.clipboard.readText()));"
        )
        .await,
        "null"
    );

    state.revoke_after_allow.store(true, Ordering::SeqCst);
    assert_eq!(browser.page(None,"navigator.clipboard.writeText('revoked during frame observation').then(()=>true,()=>false)").await,false,"an earlier Allow was reused after the frame RPC");
    state.allowed.store(true, Ordering::SeqCst);
    assert_eq!(
        evaluate(
            &repl,
            bridge.clone(),
            "nodeRepl.write(JSON.stringify(await tab.clipboard.readText()));"
        )
        .await,
        "null"
    );

    let next = Arc::new(Bridge {
        turn: "clipboard-second",
        session: session.clone(),
        authority: bridge.authority.clone(),
        effects: effects.clone(),
    });
    assert_eq!(
        evaluate(
            &repl,
            next.clone(),
            &format!(
                "globalThis.tab=await browser.tabs.get({});nodeRepl.write(JSON.stringify(await tab.url()));",
                json!(browser.target)
            )
        )
        .await,
        browser.url
    );
    assert_eq!(
        browser
            .page(
                None,
                "navigator.clipboard.readText===globalThis.priorReadText"
            )
            .await,
        true,
        "new-turn deferred bind left the old bridge installed"
    );
    session
        .lock()
        .await
        .finish_turn("clipboard-fixture", "clipboard-first", Language::En)
        .await
        .unwrap();
    assert_eq!(
        evaluate(
            &repl,
            next.clone(),
            "nodeRepl.write(JSON.stringify(await tab.clipboard.readText()));"
        )
        .await,
        "null",
        "turn cleanup cleared backend data"
    );
    assert_eq!(
        browser.page(None, "navigator.clipboard.readText()").await,
        "null",
        "same-connection bridge reinstall lost its contexts"
    );

    browser.page(None,"globalThis.replacementReadText=async()=> 'page replacement';navigator.clipboard.readText=globalThis.replacementReadText;true").await;
    session
        .lock()
        .await
        .finish_turn("clipboard-fixture", "clipboard-second", Language::En)
        .await
        .unwrap();
    assert_eq!(
        browser
            .page(
                None,
                "navigator.clipboard.readText===globalThis.replacementReadText"
            )
            .await,
        true,
        "cleanup replaced a page-owned method"
    );
    assert_eq!(
        browser
            .page(None, "globalThis.__makaVirtualClipboard===undefined")
            .await,
        true
    );
    browser.reload().await;
    assert_eq!(
        browser
            .page(None, "globalThis.__makaVirtualClipboard===undefined")
            .await,
        true,
        "turn cleanup left a future-document hook"
    );

    let third = Arc::new(Bridge {
        turn: "clipboard-third",
        session: session.clone(),
        authority: bridge.authority.clone(),
        effects: effects.clone(),
    });
    assert_eq!(
        evaluate(
            &repl,
            third.clone(),
            "nodeRepl.write(JSON.stringify(await tab.clipboard.readText()));"
        )
        .await,
        "null"
    );
    browser.reload().await;
    assert_eq!(
        browser.page(None, "navigator.clipboard.readText()").await,
        "null",
        "same-URL document replacement lost the live bridge"
    );
    browser
        .page(None, "document.getElementById('child').remove();true")
        .await;
    let future_url = format!("{}?future", browser.child_url);
    browser.page(None,&format!("(()=>{{const frame=document.createElement('iframe');frame.src={};document.body.append(frame);return true;}})()",json!(future_url))).await;
    let future_session = browser.child_session(&future_url).await;
    browser
        .wait_page(
            Some(&future_session),
            "typeof globalThis.__makaVirtualClipboard==='object'",
        )
        .await;
    assert_eq!(
        browser
            .page(Some(&future_session), "navigator.clipboard.readText()")
            .await,
        "null",
        "future OOPIF did not share the exact backend store"
    );
    state.pause.store(true, Ordering::SeqCst);
    let observer = browser.observer.clone();
    let pending = tokio::spawn(async move {
        observer.call(None,"Runtime.evaluate",json!({"expression":"navigator.clipboard.readText().then(()=>({success:true}),e=>({success:false,error:e.message}))","awaitPromise":true,"returnByValue":true})).await.unwrap()
    });
    tokio::time::timeout(Duration::from_secs(10), state.entered.cancelled())
        .await
        .unwrap();
    session
        .lock()
        .await
        .finish_turn("clipboard-fixture", "clipboard-third", Language::En)
        .await
        .unwrap();
    let rejected = tokio::time::timeout(Duration::from_secs(10), pending)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        rejected["result"]["value"],
        json!({"success":false,"error":"Clipboard bridge was removed"})
    );
    state.pause.store(false, Ordering::SeqCst);
    assert_eq!(
        browser
            .page(None, "globalThis.__makaVirtualClipboard===undefined")
            .await,
        true
    );

    repl.close().await.unwrap();
    session.lock().await.close().await.unwrap();
    effects.join().await;
    let fresh_driver = Arc::new(Mutex::new(Driver::default()));
    let mut fresh = Session::new(fresh_driver);
    fresh
        .configure(
            Desktop::Local,
            vec![BrowserConnection {
                id: "fixture".into(),
                endpoint: browser.endpoint.clone(),
            }],
            Language::En,
        )
        .unwrap();
    let fresh = Arc::new(Mutex::new(fresh));
    let fresh_bridge = Arc::new(Bridge {
        turn: "clipboard-fresh",
        session: fresh.clone(),
        authority: bridge.authority.clone(),
        effects: effects.clone(),
    });
    let fresh_repl = Repl::new(facade(), CellLimits::default());
    assert_eq!(evaluate(&fresh_repl,fresh_bridge,&format!("globalThis.browser=await cua.getBrowser({{id:'fixture'}});globalThis.tab=await browser.tabs.get({});nodeRepl.write(JSON.stringify(await tab.clipboard.read()));",json!(browser.target))).await,json!([]));
    assert_eq!(
        browser.page(None, "navigator.clipboard.readText()").await,
        ""
    );
    fresh_repl.close().await.unwrap();
    fresh.lock().await.close().await.unwrap();
    effects.join().await;
    assert!(state.checks.load(Ordering::SeqCst) > 0);
    browser.stop().await;
}
