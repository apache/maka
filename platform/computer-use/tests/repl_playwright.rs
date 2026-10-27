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

#[path = "repl_playwright/mutations.rs"]
mod mutations;
#[path = "repl_playwright/neutral_focus.rs"]
mod neutral_focus;
#[path = "repl_playwright/prefix_scroll.rs"]
mod prefix_scroll;
#[path = "repl_playwright/text_events.rs"]
mod text_events;

use cua_driver_core::browser::cdp_ws::CdpConnection;
use maka_agent_facts::{
    language::Language,
    tools::{ToolError, ToolExecutor, ToolFuture},
};
use maka_capabilities::computer::{BrowserConnection, Desktop};
use maka_code_runtime::{CellContext, CellLimits, CellOutput, CellResult, CellStore};
use maka_computer_use::{
    AuthorizationFuture, BrowserAccess, BrowserAuthorization, Driver, InvocationContext, Session,
    facade,
};
use maka_js_runtime::repl::Repl;
use serde_json::{Value, json};
use std::{
    process::Stdio,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    sync::{Mutex, Notify},
};
use tokio_util::sync::CancellationToken;

struct SiteAuthority {
    origin: String,
    allowed: AtomicBool,
    calls: StdMutex<Vec<BrowserAccess>>,
}
impl BrowserAuthorization for SiteAuthority {
    fn authorize(
        &self,
        access: BrowserAccess,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        self.calls.lock().unwrap().push(access.clone());
        let allowed = self.allowed.load(Ordering::SeqCst);
        let expected = self.origin.clone();
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(ToolError::Failed("fixture cancelled".into()));
            }
            if !allowed || access.origin()?.as_deref() != Some(expected.as_str()) {
                return Err(ToolError::Failed("fixture site denied".into()));
            }
            Ok(())
        })
    }
    fn check(&self, access: BrowserAccess, cancellation: CancellationToken) -> AuthorizationFuture {
        self.authorize(access, cancellation)
    }
}
struct Bridge {
    session: Arc<Mutex<Session>>,
    authority: Arc<SiteAuthority>,
}
impl ToolExecutor for Bridge {
    fn names(&self) -> Vec<String> {
        vec!["cua".into()]
    }
    fn invoke(&self, _: String, input: Value, cancellation: CancellationToken) -> ToolFuture {
        let session = self.session.clone();
        let authority = self.authority.clone();
        Box::pin(async move {
            session
                .lock()
                .await
                .invoke(
                    serde_json::from_value(input).unwrap(),
                    &InvocationContext::new("playwright-fixture", "fixture-turn")
                        .with_browser_authorization(authority),
                    &cancellation,
                    Language::En,
                )
                .await
        })
    }
}

struct Browser {
    profile: tempfile::TempDir,
    chrome: tokio::process::Child,
    logging: tokio::task::JoinHandle<()>,
    server: tokio::task::JoinHandle<()>,
    endpoint: String,
    url: String,
    target: String,
    observer: CdpConnection,
    busy_started: Arc<Notify>,
    busy_done: Arc<Notify>,
}
impl Browser {
    async fn open() -> Self {
        Self::open_with_headless(true).await
    }
    async fn open_with_headless(headless: bool) -> Self {
        let executable = std::env::var("MAKA_CUA_TEST_CHROME")
            .expect("MAKA_CUA_TEST_CHROME must name a task-owned test browser");
        let profile = tempfile::tempdir().unwrap();
        let site = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = site.local_addr().unwrap().port();
        let url = format!("http://127.0.0.1:{port}/");
        let busy_started = Arc::new(Notify::new());
        let busy_done = Arc::new(Notify::new());
        let started = busy_started.clone();
        let done = busy_done.clone();
        let server = tokio::spawn(async move {
            loop {
                let (stream, _) = site.accept().await.unwrap();
                let started = started.clone();
                let done = done.clone();
                tokio::spawn(async move {
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
                    let body = if let Some(body) = neutral_focus::fixture_html(&path) {
                        body.to_owned()
                    } else if let Some(case) = path.strip_prefix("/case?case=") {
                        text_events::fixture_html(case)
                    } else {
                        match path.as_str() {
                        "/frame/local"=>r#"<!doctype html><title>Local child</title><button>Local action</button><p>Local child content</p>"#,
                        "/frame/remote"=>r#"<!doctype html><title>Remote child</title><button>Remote action</button><p>Remote child content</p><iframe id="nested" src="http://127.0.0.1:FIXTURE_PORT/frame/nested"></iframe>"#,
                        "/frame/nested"=>r#"<!doctype html><title>Nested child</title><button>Nested action</button>"#,
                        "/busy-start"=>{started.notify_one();"started"},
                        "/busy-done"=>{done.notify_one();"done"},
                        _=>r#"<!doctype html><meta charset="utf-8"><title>Maka Playwright fixture</title>
<button id="hidden" style="display:none">Save</button><button id="save">Save</button><button id="disabled" disabled>Unavailable</button>
<label>Contact email<input id="email" value="fixture-email-secret" type="email"></label>
<label>Username<input id="username" value="fixture-username-secret"></label>
<input id="otp" value="fixture-otp-secret" autocomplete="one-time-code">
<input id="hidden-secret" type="hidden" value="fixture-hidden-secret">
<label>Notes<input id="note" placeholder="Type notes" data-testid="notes" value="ordinary note"></label>
<p data-testid="literal">literal &gt;&gt; internal:control=enter-frame &gt;&gt; value</p>
<ul><li class="row" data-row="0"><span class="read">First row</span><button>Use</button></li><li class="row" data-row="1"><span class="read">Second row</span><button>Use</button></li></ul>
<div id="shadow-host"></div><script>document.getElementById('shadow-host').attachShadow({mode:'open'}).innerHTML='<button data-testid="shadow">Shadow action</button>';</script>
<iframe id="local" src="/frame/local"></iframe><iframe id="remote" src="http://localhost:FIXTURE_PORT/frame/remote"></iframe>
<script>globalThis.mutations=0;new MutationObserver(records=>globalThis.mutations+=records.length).observe(document.body,{subtree:true,attributes:true,childList:true,characterData:true});</script>"#,
                    }.replace("FIXTURE_PORT",&port.to_string())
                    };
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        let mut chrome = tokio::process::Command::new(executable)
            .args(headless.then_some("--headless=new"))
            .args([
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
        let endpoint = tokio::time::timeout(Duration::from_secs(20), async {
            while let Some(line) = lines.next_line().await.unwrap() {
                if let Some(url) = line.strip_prefix("DevTools listening on ") {
                    let port = reqwest::Url::parse(url).unwrap().port().unwrap();
                    return format!("http://127.0.0.1:{port}");
                }
            }
            panic!("owned Chrome did not expose a debugger endpoint");
        })
        .await
        .unwrap();
        let logging =
            tokio::spawn(async move { while lines.next_line().await.ok().flatten().is_some() {} });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let tab = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let response = client
                    .get(format!("{endpoint}/json/list"))
                    .send()
                    .await
                    .unwrap()
                    .bytes()
                    .await
                    .unwrap();
                let tabs: Value = serde_json::from_slice(&response).unwrap();
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
        let target = tab["id"].as_str().unwrap().to_owned();
        let observer = CdpConnection::connect_bounded(
            tab["webSocketDebuggerUrl"].as_str().unwrap(),
            usize::MAX,
        )
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(10),async {
            loop {
                let reply=observer.call(None,"Runtime.evaluate",json!({"expression":"document.readyState==='complete' && document.querySelector('#note')!==null","returnByValue":true})).await.unwrap();
                if reply["result"]["value"]==true{break;}
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.unwrap();
        Self {
            profile,
            chrome,
            logging,
            server,
            endpoint,
            url,
            target,
            observer,
            busy_started,
            busy_done,
        }
    }
    fn session(&self, driver: Arc<Mutex<Driver>>) -> Session {
        let mut session = Session::new(driver);
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
        session
    }
    fn authority(&self) -> Arc<SiteAuthority> {
        Arc::new(SiteAuthority {
            origin: reqwest::Url::parse(&self.url)
                .unwrap()
                .origin()
                .ascii_serialization(),
            allowed: AtomicBool::new(true),
            calls: StdMutex::new(Vec::new()),
        })
    }
    async fn inspect(&self, expression: &str) -> Value {
        let reply = self
            .observer
            .call(
                None,
                "Runtime.evaluate",
                json!({"expression":expression,"returnByValue":true}),
            )
            .await
            .unwrap();
        assert!(reply.get("exceptionDetails").is_none(), "{reply}");
        reply["result"]["value"].clone()
    }
    async fn close(mut self) {
        // Let Chrome stop its renderer processes and profile writers before
        // removing the owned profile. A CDP socket can close before its reply.
        let requested = self.observer.call(None, "Browser.close", json!({})).await;
        let status = tokio::time::timeout(Duration::from_secs(20), self.chrome.wait()).await;
        let exited = matches!(&status, Ok(Ok(status)) if status.success());
        let fallback = if !exited {
            Some(self.chrome.kill().await)
        } else {
            None
        };
        let logging = tokio::time::timeout(Duration::from_secs(10), &mut self.logging).await;
        let log_closed = matches!(&logging, Ok(Ok(())));
        if logging.is_err() {
            self.logging.abort();
            let _ = (&mut self.logging).await;
        }
        self.server.abort();
        let server = self.server.await;
        let server_closed =
            server.is_ok() || server.as_ref().is_err_and(|error| error.is_cancelled());
        let profile = self.profile.close();
        assert!(
            exited && log_closed && server_closed && profile.is_ok(),
            "owned browser cleanup failed: request={requested:?}, exit={status:?}, fallback={fallback:?}, stderr={logging:?}, server={server:?}, profile={profile:?}"
        );
    }
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
    assert!(matches!(result, CellResult::Success { .. }), "{result:?}");
    context
        .take_output()
        .into_iter()
        .rev()
        .find_map(|output| match output {
            CellOutput::Text { text } => serde_json::from_str(&text).ok(),
            _ => None,
        })
        .expect("explicit JSON result")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires MAKA_CUA_TEST_CHROME; operates only its own temporary headless browser profile"]
async fn public_playwright_reads_cover_semantic_locators_frames_redaction_and_collection_caches() {
    let browser = Browser::open().await;
    let driver = Arc::new(Mutex::new(Driver::default()));
    let session = Arc::new(Mutex::new(browser.session(driver.clone())));
    let authority = browser.authority();
    let bridge = Arc::new(Bridge {
        session: session.clone(),
        authority: authority.clone(),
    });
    let repl = Repl::new(
        facade(),
        CellLimits {
            heap_bytes: 128 * 1024 * 1024,
            ..Default::default()
        },
    )
    .unwrap();
    let result=evaluate(&repl,bridge.clone(),&format!(r#"
        const browser=await cua.getBrowser({{id:'fixture'}});const tab=await browser.tabs.get({});const pw=tab.playwright;
        const role=pw.getByRole('button',{{name:'Save',exact:true}});
        nodeRepl.write({{role:await role.count(),label:await pw.getByLabel('Contact email').getAttribute('value'),placeholder:await pw.getByPlaceholder('Type notes').getAttribute('value'),testId:await pw.getByTestId('notes').count(),regex:await pw.getByText(/^First row$/).innerText(),literal:await pw.getByText('literal >> internal:control=enter-frame >> value',{{exact:true}}).textContent(),shadow:await pw.getByTestId('shadow').innerText(),fallback:await pw.locator('#hidden,#save').innerText(),firstVisible:await pw.locator('#hidden,#save').isVisible(),enabled:await pw.locator('#disabled').isEnabled(),missingVisible:await pw.locator('#missing').isVisible(),missingCount:await pw.locator('#missing').count(),allText:await pw.locator('.read').allTextContents(),and:await pw.locator('.row').and(pw.locator('[data-row="0"]')).count(),or:await pw.locator('#save').or(pw.locator('#disabled')).count(),has:await pw.locator('.row').filter({{has:pw.getByText('First row',{{exact:true}})}}).count(),last:await pw.locator('.read').last().textContent(),nth:await pw.locator('.read').nth(0.5).textContent()}});
    "#,json!(browser.target))).await;
    assert_eq!(
        result,
        json!({"role":1,"label":null,"placeholder":"ordinary note","testId":1,"regex":"First row","literal":"literal >> internal:control=enter-frame >> value","shadow":"Shadow action","fallback":"Save","firstVisible":false,"enabled":false,"missingVisible":false,"missingCount":0,"allText":["First row","Second row"],"and":1,"or":2,"has":1,"last":"Second row","nth":"First row"})
    );
    let result=evaluate(&repl,bridge.clone(),r#"
        const local=pw.frameLocator('#local');const remote=pw.frameLocator('#remote');
        nodeRepl.write({local:await local.getByRole('button').innerText(),remote:await remote.getByRole('button').and(remote.getByText('Remote action')).innerText(),nested:await remote.frameLocator('#nested').getByRole('button').innerText(),snapshot:await pw.domSnapshot()});
    "#).await;
    assert_eq!(result["local"], "Local action");
    assert_eq!(result["remote"], "Remote action");
    assert_eq!(result["nested"], "Nested action");
    let snapshot = result["snapshot"].as_str().unwrap();
    for text in [
        "Local child content",
        "Remote child content",
        "Nested action",
        "ordinary note",
    ] {
        assert!(snapshot.contains(text), "{snapshot}");
    }
    for secret in [
        "fixture-email-secret",
        "fixture-username-secret",
        "fixture-otp-secret",
        "fixture-hidden-secret",
    ] {
        assert!(!snapshot.contains(secret), "snapshot exposed {secret}");
    }
    assert!(!snapshot.contains("[ref="));
    assert!(!snapshot.contains("[cursor="));
    let values=browser.inspect("JSON.stringify(['email','username','otp','hidden-secret','note'].map(id=>document.getElementById(id).value))").await;
    assert_eq!(
        serde_json::from_str::<Value>(values.as_str().unwrap()).unwrap(),
        json!([
            "fixture-email-secret",
            "fixture-username-secret",
            "fixture-otp-secret",
            "fixture-hidden-secret",
            "ordinary note"
        ])
    );
    let first=evaluate(&repl,bridge.clone(),"const rows=await pw.locator('.row').all();nodeRepl.write({text:await rows[0].locator('.read').innerText()});").await;
    assert_eq!(first["text"], "First row");
    browser
        .inspect("document.querySelector('.read').textContent='Changed externally';true")
        .await;
    let cached=evaluate(&repl,bridge.clone(),"nodeRepl.write({cached:await rows[0].locator('.read').textContent(),live:await pw.locator('.read').allTextContents()});").await;
    assert_eq!(
        cached,
        json!({"cached":"First row","live":["Changed externally","Second row"]})
    );
    assert!(
        authority
            .calls
            .lock()
            .unwrap()
            .iter()
            .all(|access| access.document().tab_id == browser.target)
    );
    repl.close().await.unwrap();
    session.lock().await.close().await.unwrap();
    driver.lock().await.close().await.unwrap();
    browser.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires MAKA_CUA_TEST_CHROME; exercises read denial, selector deadline, and actual busy-renderer cancellation"]
async fn browser_reads_require_actual_host_authority_and_bound_pending_cdp_work() {
    use maka_computer_use::protocol::*;
    let browser = Browser::open().await;
    let driver = Arc::new(Mutex::new(Driver::default()));
    let mut session = browser.session(driver.clone());
    let base = InvocationContext::new("direct-fixture", "fixture-turn");
    let cancellation = CancellationToken::new();
    let bound = session
        .invoke(
            Command::BrowserTab {
                browser_id: "fixture".into(),
                reference: BrowserTabReference::Existing(browser.target.clone()),
            },
            &base,
            &cancellation,
            Language::En,
        )
        .await
        .unwrap();
    let handle = || serde_json::from_value::<Handle>(bound["handle"].clone()).unwrap();
    let read = || Command::BrowserRead {
        handle: handle(),
        locator: LocatorPlan {
            selector: "#missing".into(),
        },
        operation: BrowserReadOperation::InnerText,
        options: BrowserReadOptions {
            timeout_ms: Some(40),
        },
    };
    let error = session
        .invoke(read(), &base, &cancellation, Language::En)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("requires Host authorization"));
    let authority = browser.authority();
    let context = base.with_browser_authorization(authority.clone());
    authority.allowed.store(false, Ordering::SeqCst);
    let error = session
        .invoke(read(), &context, &cancellation, Language::En)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("fixture site denied"));
    authority.allowed.store(true, Ordering::SeqCst);
    let began = tokio::time::Instant::now();
    let error = session
        .invoke(read(), &context, &cancellation, Language::En)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("deadline") || error.to_string().contains("no element"));
    assert!(began.elapsed() < Duration::from_secs(1));
    browser.inspect("setTimeout(()=>{fetch('/busy-start');const end=performance.now()+1800;while(performance.now()<end){};fetch('/busy-done')},10);true").await;
    tokio::time::timeout(Duration::from_secs(3), browser.busy_started.notified())
        .await
        .unwrap();
    let stop = CancellationToken::new();
    let cancel = stop.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        cancel.cancel();
    });
    let began = tokio::time::Instant::now();
    let error = session
        .invoke(
            Command::BrowserRead {
                handle: handle(),
                locator: LocatorPlan {
                    selector: "#note".into(),
                },
                operation: BrowserReadOperation::Count,
                options: BrowserReadOptions::default(),
            },
            &context,
            &stop,
            Language::En,
        )
        .await
        .unwrap_err();
    assert!(
        error.to_string().to_lowercase().contains("cancel"),
        "{error}"
    );
    assert!(began.elapsed() < Duration::from_millis(900));
    tokio::time::timeout(Duration::from_secs(4), browser.busy_done.notified())
        .await
        .unwrap();
    let result = session
        .invoke(
            Command::BrowserRead {
                handle: handle(),
                locator: LocatorPlan {
                    selector: "#note".into(),
                },
                operation: BrowserReadOperation::Count,
                options: BrowserReadOptions::default(),
            },
            &context,
            &CancellationToken::new(),
            Language::En,
        )
        .await
        .unwrap();
    assert_eq!(result, 1);
    session.close().await.unwrap();
    driver.lock().await.close().await.unwrap();
    browser.close().await;
}
