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

//! Loopback protocol fixtures, not real-browser or desktop capture evidence.
use super::*;
use cua_driver_core::browser::cdp_ws::CdpConnection;
use futures_util::{SinkExt, StreamExt};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Authority(Arc<AtomicBool>);
impl PreviewAuthority for Authority {
    fn authorize(
        &self,
        subject: PreviewSubject,
        _: CancellationToken,
    ) -> crate::AuthorizationFuture {
        assert!(matches!(
            subject,
            PreviewSubject::Browser {
                access: crate::BrowserAccess::ReadDocument { .. }
            }
        ));
        let allowed = self.0.load(Ordering::SeqCst);
        Box::pin(async move {
            if allowed {
                Ok(())
            } else {
                Err(failed("revoked"))
            }
        })
    }
    fn browser_effect_scope(&self) -> Option<Arc<dyn crate::BrowserEffectScope>> {
        None
    }
}
struct State {
    loader: String,
    url: String,
    generation: String,
    requests: Vec<String>,
    revoke_after_pixels: bool,
    after_pixels: Option<(&'static str, &'static str)>,
}
struct Fixture {
    socket: Cdp,
    provider: Provider,
    document: crate::BrowserDocument,
    state: Arc<Mutex<State>>,
    allowed: Arc<AtomicBool>,
    stop: CancellationToken,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}
impl Fixture {
    async fn new() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let url = format!("ws://{address}/devtools/page/tab");
        let generation = format!("ws://{address}/devtools/browser/fixture");
        let state = Arc::new(Mutex::new(State {
            loader: "loader".into(),
            url: "https://example.test/".into(),
            generation: generation.clone(),
            requests: Vec::new(),
            after_pixels: None,
            revoke_after_pixels: false,
        }));
        let stop = CancellationToken::new();
        let allowed = Arc::new(AtomicBool::new(true));
        let (connected, mut peer) =
            tokio::join!(CdpConnection::connect_bounded(&url, usize::MAX), async {
                let (stream, _) = listener.accept().await.unwrap();
                tokio_tungstenite::accept_async(stream).await.unwrap()
            });
        let socket = Cdp {
            connection: Arc::new(connected.unwrap()),
            dialogs: None,
            extension_context: None,
            preparation: extension::PreparationTransport::NotRequired,
        };
        let websocket = {
            let state = state.clone();
            let stop = stop.clone();
            let allowed = allowed.clone();
            tokio::spawn(async move {
                loop {
                    let message = tokio::select! { _ = stop.cancelled() => break, message = peer.next() => message.unwrap().unwrap() };
                    let request: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
                    let method = request["method"].as_str().unwrap();
                    let mut event = None;
                    let result = {
                        let mut state = state.lock().unwrap();
                        state.requests.push(method.into());
                        match method {
                            "Page.getFrameTree" => {
                                json!({"frameTree":{"frame":{"id":"main","loaderId":state.loader,"url":state.url,"securityOrigin":"https://example.test"}}})
                            }
                            "Runtime.enable" | "Target.setAutoAttach" => json!({}),
                            "Page.createIsolatedWorld" => {
                                event = Some(
                                    json!({"method":"Runtime.executionContextCreated","params":{"context":{"id":17,"uniqueId":"isolated-context","name":request["params"]["worldName"],"auxData":{"frameId":"main","isDefault":false}}}}),
                                );
                                json!({"executionContextId":17})
                            }
                            "Runtime.evaluate" => {
                                json!({"result":{"type":"string","value":"https://example.test"}})
                            }
                            "Page.captureScreenshot" => {
                                assert_eq!(
                                    request["params"],
                                    json!({"format":"jpeg","quality":75,"captureBeyondViewport":false})
                                );
                                if let Some((loader, url)) = state.after_pixels.take() {
                                    state.loader = loader.into();
                                    state.url = url.into();
                                }
                                if state.revoke_after_pixels {
                                    allowed.store(false, Ordering::SeqCst);
                                }
                                let mut image = std::io::Cursor::new(Vec::new());
                                image::RgbImage::new(2, 2)
                                    .write_to(&mut image, image::ImageFormat::Png)
                                    .unwrap();
                                json!({"data":base64::engine::general_purpose::STANDARD.encode(image.into_inner())})
                            }
                            other => panic!("unexpected CDP request {other}"),
                        }
                    };
                    if let Some(event) = event {
                        peer.send(tokio_tungstenite::tungstenite::Message::Text(
                            event.to_string().into(),
                        ))
                        .await
                        .unwrap();
                    }
                    peer.send(tokio_tungstenite::tungstenite::Message::Text(
                        json!({"id":request["id"],"result":result})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .unwrap();
                }
            })
        };
        let provider = Provider::Cdp(BrowserConnection {
            id: "fixture".into(),
            endpoint: format!("http://{}", listener.local_addr().unwrap()),
        });
        let inventory = {
            let state = state.clone();
            let stop = stop.clone();
            tokio::spawn(async move {
                loop {
                    let (mut stream, _) = tokio::select! { _ = stop.cancelled() => break, connected = listener.accept() => connected.unwrap() };
                    let mut request = Vec::new();
                    while !request.ends_with(b"\r\n\r\n") {
                        request.push(stream.read_u8().await.unwrap());
                        assert!(request.len() < 4096);
                    }
                    let body = {
                        let state = state.lock().unwrap();
                        if request.starts_with(b"GET /json/version ") {
                            json!({"webSocketDebuggerUrl":state.generation})
                        } else {
                            assert!(request.starts_with(b"GET /json/list "));
                            json!([{"id":"tab","type":"page","title":"fixture","url":state.url,"webSocketDebuggerUrl":url}])
                        }
                    }
                    .to_string();
                    stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                    stream.shutdown().await.unwrap();
                }
            })
        };
        let document = crate::BrowserDocument {
            browser_id: "fixture".into(),
            generation,
            tab_id: "tab".into(),
            url: "https://example.test/".into(),
        };
        Self {
            socket,
            provider,
            document,
            state,
            allowed,
            stop,
            tasks: vec![websocket, inventory],
        }
    }
    fn authority(&self) -> Arc<dyn PreviewAuthority> {
        Arc::new(Authority(self.allowed.clone()))
    }
    async fn capture(&self) -> BrowserCapture {
        BrowserCapture {
            socket: self.socket.clone(),
            provider: self.provider.clone(),
            document: self.document.clone(),
            proof: origin::resolve_document_origin(&self.socket, self.document.clone(), None)
                .await
                .unwrap(),
            execution: crate::ExecutionCorrelation::new("fixture").unwrap(),
        }
    }
    fn screenshots(&self) -> usize {
        self.state
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|method| method.as_str() == "Page.captureScreenshot")
            .count()
    }
    async fn close(self) {
        self.stop.cancel();
        for task in self.tasks {
            tokio::time::timeout(Duration::from_secs(3), task)
                .await
                .unwrap()
                .unwrap();
        }
    }
}

#[test]
fn browser_inventory_runs_through_session_on_a_normal_worker_stack() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_stack_size(2 * 1024 * 1024)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        tokio::spawn(async {
            let fixture = Fixture::new().await;
            let Provider::Cdp(connection) = &fixture.provider else {
                panic!("expected loopback CDP provider")
            };
            let driver = Arc::new(tokio::sync::Mutex::new(crate::Driver::default()));
            let mut session = crate::Session::new(driver);
            session
                .configure(
                    maka_capabilities::computer::Desktop::Local,
                    vec![connection.clone()],
                    Language::En,
                )
                .unwrap();
            let invocation = crate::InvocationContext::new(
                "session",
                "turn",
                crate::ExecutionCorrelation::new("inventory").unwrap(),
            );
            let stop = CancellationToken::new();
            let browser = session
                .invoke(
                    serde_json::from_value(
                        json!({"method":"getBrowser","options":{"id":"fixture"}}),
                    )
                    .unwrap(),
                    &invocation,
                    &stop,
                    Language::En,
                )
                .await
                .unwrap();
            assert_eq!(browser["id"], "fixture");
            let tabs = session
                .invoke(
                    serde_json::from_value(
                        json!({"method":"listTabs","options":{"browser":"fixture"}}),
                    )
                    .unwrap(),
                    &invocation,
                    &stop,
                    Language::En,
                )
                .await
                .unwrap();
            assert_eq!(
                tabs.as_array()
                    .unwrap()
                    .iter()
                    .map(|tab| (tab["id"].as_str().unwrap(), tab["url"].as_str().unwrap()))
                    .collect::<Vec<_>>(),
                [("fixture:tab", "https://example.test/")]
            );
            session.close().await.unwrap();
            fixture.close().await;
        })
        .await
        .unwrap();
    });
}

#[tokio::test]
async fn preview_rejects_loader_url_generation_or_grant_changes_before_delivering_pixels() {
    for change in ["loader", "url", "generation", "grant-before", "grant-after"] {
        let fixture = Fixture::new().await;
        let capture = fixture.capture().await;
        {
            let mut state = fixture.state.lock().unwrap();
            match change {
                "loader" => state.after_pixels = Some(("replacement", "https://example.test/")),
                "url" => state.after_pixels = Some(("loader", "https://other.test/")),
                "generation" => {
                    state.generation = format!("{}-replacement", fixture.document.generation)
                }
                "grant-before" => fixture.allowed.store(false, Ordering::SeqCst),
                "grant-after" => state.revoke_after_pixels = true,
                _ => unreachable!(),
            }
        }
        assert!(
            capture
                .capture(fixture.authority(), CancellationToken::new())
                .await
                .is_err(),
            "{change}"
        );
        assert_eq!(
            fixture.screenshots(),
            usize::from(matches!(change, "loader" | "url" | "grant-after")),
            "{change}"
        );
        fixture.close().await;
    }
}

#[tokio::test]
async fn preview_keeps_agent_document_refs_usable_and_does_not_start_or_stop_screencast() {
    let fixture = Fixture::new().await;
    let capture = fixture.capture().await;
    let mut browsers = Browsers::new(Arc::new(tokio::sync::Mutex::new(crate::Driver::default())));
    let invocation = crate::InvocationContext::new("session", "turn", capture.execution.clone());
    let bound = browsers.bind(TabSource { provider: fixture.provider.clone(), generation: fixture.document.generation.clone(), info: serde_json::from_value(json!({"id":"tab","type":"page","title":"fixture","url":"https://example.test/"})).unwrap() }, InitialState::Deferred, &invocation, &CancellationToken::new(), Language::En).await.unwrap();
    let Handle::Tab(handle) = serde_json::from_value(bound["handle"].clone()).unwrap() else {
        panic!("expected tab")
    };
    let tab = browsers.targets.get_mut(&handle).unwrap();
    tab.connection = Some(TabConnection::Prepared(fixture.socket.clone()));
    tab.origin_proof = Some(capture.proof.clone());
    let frame = tab.frame().await.unwrap();
    let nodes = vec![
        json!({"nodeId":"ax","backendDOMNodeId":12,"makaFrame":{"id":"main","loader":"loader","session":null,"parent":null},"role":{"value":"button"},"name":{"value":"Next"}}),
    ];
    let (state, refs) = tab.ax.render(&frame, &nodes, Language::En).unwrap();
    tab.refs = refs;
    tab.previous = Some(state.clone());
    tab.frame = Some(frame.clone());
    let index = *tab.refs.keys().next().unwrap();
    tab.before_element_input(Some(index), &CancellationToken::new(), Language::En)
        .await
        .unwrap();
    let registry = PreviewRegistry::default();
    registry.open_epoch(browsers.epoch);
    browsers.publish_preview(&handle, &registry, &invocation);
    let target = registry.targets().remove(0);
    let pixels = registry
        .capture(&target.id, fixture.authority(), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(pixels.mime_type, "image/jpeg");
    assert_eq!((pixels.width, pixels.height), (2, 2));
    assert_eq!(
        image::load_from_memory(&pixels.bytes)
            .unwrap()
            .to_rgb8()
            .dimensions(),
        (2, 2)
    );
    let tab = browsers.targets.get_mut(&handle).unwrap();
    tab.before_element_input(Some(index), &CancellationToken::new(), Language::En)
        .await
        .unwrap();
    assert_eq!(tab.previous.as_deref(), Some(state.as_str()));
    assert_eq!(tab.frame.as_deref(), Some(frame.as_str()));
    assert_eq!(fixture.screenshots(), 1);
    {
        let requests = &fixture.state.lock().unwrap().requests;
        assert!(!requests.iter().any(|method| matches!(
            method.as_str(),
            "Page.startScreencast" | "Page.stopScreencast" | "Page.screencastFrameAck"
        )));
    }
    drop(browsers);
    registry.close();
    fixture.close().await;
}
