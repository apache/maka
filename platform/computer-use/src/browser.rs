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

use crate::protocol::*;
use base64::Engine;
use maka_agent_facts::language::Language;
use maka_agent_facts::tools::ToolError;
use maka_capabilities::computer::BrowserConnection;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashMap, time::Duration};
mod ax;
mod cursor;
mod frames;

#[derive(Clone, Debug)]
struct ElementRef {
    backend: u64,
    frame: Option<frames::Frame>,
}

use crate::desktop::validate_connections;

#[derive(Default)]
pub(crate) struct Browsers {
    connections: Vec<BrowserConnection>,
    targets: HashMap<String, Tab>,
}
#[derive(Clone, Deserialize)]
struct TabInfo {
    id: String,
    title: String,
    url: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "webSocketDebuggerUrl")]
    websocket: Option<String>,
}
struct Tab {
    provider: BrowserConnection,
    generation: String,
    info: TabInfo,
    socket: Option<Cdp>,
    frame: Option<String>,
    refs: HashMap<u64, ElementRef>,
    frames: frames::Frames,
    ax: ax::Projection,
    previous: Option<String>,
    capture: Option<Capture>,
    navigation: Option<Navigation>,
    cursor_world: Option<(String, u64)>,
}
enum Navigation {
    Loader(String),
    Reload(String),
    Url(String),
}
#[derive(Clone, Copy)]
struct Capture {
    width: f64,
    height: f64,
    image_width: f64,
    image_height: f64,
    x: f64,
    y: f64,
}
struct Cdp {
    connection: std::sync::Arc<cua_driver_core::browser::cdp_ws::CdpConnection>,
}
impl Cdp {
    async fn connect(url: &str, provider: &BrowserConnection) -> Result<Self, ToolError> {
        let url = reqwest::Url::parse(url).map_err(failed)?;
        let endpoint = reqwest::Url::parse(&provider.endpoint).map_err(failed)?;
        if url.scheme() != "ws"
            || url.host_str() != endpoint.host_str()
            || url.port_or_known_default() != endpoint.port_or_known_default()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(failed(
                "browser returned a websocket outside its configured endpoint",
            ));
        }
        let connection = tokio::time::timeout(
            Duration::from_secs(10),
            cua_driver_core::browser::cdp_ws::CdpConnection::connect_bounded(
                url.as_str(),
                usize::MAX,
            ),
        )
        .await
        .map_err(|_| failed("browser connection timed out"))?
        .map_err(failed)?;
        Ok(Self {
            connection: std::sync::Arc::new(connection),
        })
    }
    async fn request(&mut self, method: &str, params: Value) -> Result<Value, ToolError> {
        self.request_in(None, method, params).await
    }
    async fn request_in(
        &self,
        session: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<Value, ToolError> {
        self.connection
            .call(session, method, params)
            .await
            .map_err(|error| {
                let message = error.to_string();
                if message.contains(" failed (") {
                    failed(message)
                } else {
                    unknown(message)
                }
            })
    }
}

// This is a typed owner boundary, not an error-text classifier. Lower CDP
// requests retain raw diagnostics; the model-facing result adds advice once.
pub(crate) fn with_unknown_guidance(error: ToolError, language: Language) -> ToolError {
    match error {
        ToolError::OutcomeUnknown(message) => {
            ToolError::OutcomeUnknown(message + crate::language::browser_unknown(language))
        }
        error => error,
    }
}

async fn http(provider: &BrowserConnection, path: &str) -> Result<Value, ToolError> {
    let url = format!("{}{path}", provider.endpoint.trim_end_matches('/'));
    let mut response = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(failed)?
        .get(url)
        .send()
        .await
        .map_err(failed)?
        .error_for_status()
        .map_err(failed)?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(failed)? {
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(failed)
}
async fn inventory(provider: &BrowserConnection) -> Result<(String, Vec<TabInfo>), ToolError> {
    let version = http(provider, "/json/version").await?;
    let generation = version["webSocketDebuggerUrl"]
        .as_str()
        .ok_or_else(|| failed("browser generation unavailable"))?
        .to_owned();
    let tabs: Vec<TabInfo> =
        serde_json::from_value(http(provider, "/json/list").await?).map_err(failed)?;
    Ok((
        generation,
        tabs.into_iter().filter(|t| t.kind == "page").collect(),
    ))
}
fn tab_info(provider: &BrowserConnection, tab: &TabInfo) -> Value {
    json!({"id":format!("{}:{}",provider.id,tab.id),"providerTabId":tab.id,"browserId":provider.id,"title":tab.title,"url":tab.url})
}
impl Browsers {
    pub(crate) fn target_label(&self, id: &str) -> Option<&str> {
        self.targets.get(id).map(|tab| tab.provider.id.as_str())
    }

    pub(crate) fn configure(
        &mut self,
        connections: Vec<BrowserConnection>,
        language: Language,
    ) -> Result<(), ToolError> {
        validate_connections(&connections)?;
        if connections != self.connections && !self.targets.is_empty() {
            return Err(failed(match language {
                Language::En => {
                    "browser configuration changed; reset Cua before using the new providers"
                }
                Language::ZhCn => "浏览器配置已改变；请先重置 Cua，再使用新的提供方",
                Language::ZhTw => "瀏覽器設定已變更；請先重設 Cua，再使用新的提供者",
            }));
        }
        self.connections = connections;
        Ok(())
    }
    pub(crate) async fn state(&self) -> (Vec<Value>, Vec<String>) {
        let mut browsers = Vec::new();
        let mut errors = Vec::new();
        for provider in &self.connections {
            match inventory(provider).await {
                Ok((_, tabs)) => browsers.push(json!({"id":provider.id,"name":provider.id,"type":"cdp","tabs":tabs.iter().map(|t| tab_info(provider,t)).collect::<Vec<_>>() })),
                Err(error) => errors.push(format!("{}: {error}", provider.id)),
            }
        }
        (browsers, errors)
    }
    pub(crate) async fn invoke(
        &mut self,
        command: Command,
        cursor: &crate::cursor::Spec,
        cancellation: &tokio_util::sync::CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        match command {
            Command::ListBrowsers { .. } => {
                let (mut browsers, errors) = self.state().await;
                if !errors.is_empty() {
                    return Err(failed(errors.join("\n")));
                }
                for browser in &mut browsers {
                    browser.as_object_mut().unwrap().remove("tabs");
                }
                Ok(json!(browsers))
            }
            Command::ListTabs { options } => {
                let mut tabs = Vec::new();
                for provider in self.providers(options.browser.as_deref())? {
                    let (_, listed) = inventory(provider).await?;
                    tabs.extend(listed.iter().map(|tab| tab_info(provider, tab)));
                }
                Ok(json!(tabs))
            }
            Command::GetBrowser { options } => {
                if options.extension_instance_id.is_some() {
                    return Err(failed("extension browser providers are unavailable"));
                }
                let mut matches = Vec::new();
                for provider in self.providers(options.id.as_deref())? {
                    let (_, tabs) = inventory(provider).await?;
                    if options
                        .url
                        .as_ref()
                        .is_none_or(|url| tabs.iter().any(|tab| &tab.url == url))
                    {
                        matches.push(provider);
                    }
                }
                if matches.len() != 1 {
                    return Err(failed(match language {
                        Language::En => {
                            "browser selection is ambiguous or missing; select an ID from listBrowsers"
                        }
                        Language::ZhCn => "浏览器选择不明确或缺失；请从 listBrowsers 选择 ID",
                        Language::ZhTw => "瀏覽器選擇不明確或缺少；請從 listBrowsers 選擇 ID",
                    }));
                }
                Ok(json!({"id":matches[0].id}))
            }
            Command::GetTab { reference, options } => {
                let mut matches = Vec::new();
                for provider in self.providers(options.browser.as_deref())? {
                    let (generation, tabs) = inventory(provider).await?;
                    for tab in tabs {
                        let selected = match &reference {
                            TabReference::Id(id) => {
                                id == &tab.id || id == &format!("{}:{}", provider.id, tab.id)
                            }
                            TabReference::Url { url } => &tab.url == url,
                            TabReference::Mention { .. } => {
                                return Err(failed(
                                    "tab mentions require a connected client provider",
                                ));
                            }
                        };
                        if selected {
                            matches.push((provider.clone(), generation.clone(), tab));
                        }
                    }
                }
                if matches.len() != 1 {
                    return Err(failed(match language {
                        Language::En => {
                            "tab selection is ambiguous or missing; choose an exact ID from listTabs"
                        }
                        Language::ZhCn => "标签页选择不明确或缺失；请从 listTabs 选择确切 ID",
                        Language::ZhTw => "分頁選擇不明確或缺少；請從 listTabs 選擇確切 ID",
                    }));
                }
                let (provider, generation, tab) = matches.pop().unwrap();
                self.bind(provider, generation, tab, cancellation, language)
                    .await
            }
            Command::CreateBrowserTab {
                browser_id,
                url,
                options,
            } => {
                if options.visible.is_some() || options.session_name.is_some() {
                    return Err(failed(
                        "this CDP provider does not support visibility or sessionName options",
                    ));
                }
                validate_url(&url)?;
                let provider = self.providers(Some(&browser_id))?[0].clone();
                let (generation, _) = inventory(&provider).await?;
                let mut browser = Cdp::connect(&generation, &provider).await?;
                let created = browser
                    .request("Target.createTarget", json!({"url":url,"background":true}))
                    .await?;
                let id = created["targetId"]
                    .as_str()
                    .ok_or_else(|| unknown("browser did not return a target ID"))?;
                let (current, tabs) = inventory(&provider).await?;
                if current != generation {
                    return Err(unknown("browser restarted after tab creation"));
                }
                let tab = tabs.into_iter().find(|t| t.id == id).ok_or_else(|| {
                    unknown(match language {
                        Language::En => "created tab is not observable",
                        Language::ZhCn => "已创建的标签页不可观察",
                        Language::ZhTw => "已建立的分頁無法觀察",
                    })
                })?;
                self.bind(provider, generation, tab, cancellation, language)
                    .await
            }
            Command::Observe {
                handle: Handle::Tab(handle),
                kind,
                options,
            } => {
                self.observe(
                    &handle,
                    kind,
                    !options.disable_diffing,
                    cancellation,
                    language,
                )
                .await
            }
            Command::Action {
                handle: Handle::Tab(handle),
                action,
            } => {
                self.action(&handle, action, cursor, cancellation, language)
                    .await
            }
            _ => Err(failed("invalid browser operation")),
        }
    }
    fn providers(&self, id: Option<&str>) -> Result<Vec<&BrowserConnection>, ToolError> {
        let providers: Vec<_> = self
            .connections
            .iter()
            .filter(|p| id.is_none_or(|id| p.id == id))
            .collect();
        if providers.is_empty() && id.is_some() {
            return Err(failed(
                "browser_unavailable: no matching configured CDP provider",
            ));
        }
        Ok(providers)
    }
    async fn bind(
        &mut self,
        provider: BrowserConnection,
        generation: String,
        info: TabInfo,
        cancellation: &tokio_util::sync::CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        if self.targets.len() >= 64 {
            return Err(failed(match language {
                Language::En => "tab binding limit reached; reset Cua",
                Language::ZhCn => "标签页绑定数已达上限；请重置 Cua",
                Language::ZhTw => "分頁綁定數已達上限；請重設 Cua",
            }));
        }
        let handle = uuid::Uuid::new_v4().to_string();
        let id = format!("{}:{}", provider.id, info.id);
        self.targets.insert(
            handle.clone(),
            Tab {
                provider,
                generation,
                info,
                socket: None,
                frame: None,
                refs: HashMap::new(),
                ax: ax::Projection::default(),
                frames: frames::Frames::default(),
                previous: None,
                capture: None,
                navigation: None,
                cursor_world: None,
            },
        );
        match self
            .observe(&handle, ObservationKind::Ax, false, cancellation, language)
            .await
        {
            Ok(value) => Ok(
                json!({"handle":Handle::Tab(handle),"id":id,"kind":"tab","state":value["state"]}),
            ),
            Err(error) => {
                self.targets.remove(&handle);
                Err(error)
            }
        }
    }
    async fn observe(
        &mut self,
        handle: &str,
        kind: ObservationKind,
        diff: bool,
        cancellation: &tokio_util::sync::CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        let tab = self.targets.get_mut(handle).ok_or_else(|| {
            failed(match language {
                Language::En => "stale_tab: bind it again",
                Language::ZhCn => "stale_tab: 请重新绑定标签页",
                Language::ZhTw => "stale_tab: 請重新綁定分頁",
            })
        })?;
        tab.refs.clear();
        tab.capture = None;
        tab.frame = None;
        tab.verify(language).await?;
        let result = tab.observe(kind, diff, cancellation, language).await;
        if result.is_err() {
            tab.socket = None;
            tab.refs.clear();
            tab.frame = None;
            tab.capture = None;
        }
        result
    }
    async fn action(
        &mut self,
        handle: &str,
        action: Action,
        cursor: &crate::cursor::Spec,
        cancellation: &tokio_util::sync::CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        let closing = matches!(&action, Action::Close);
        let moving_cursor = matches!(&action, Action::MoveCursor { .. });
        let tab = self.targets.get_mut(handle).ok_or_else(|| {
            failed(match language {
                Language::En => "stale_tab: bind it again",
                Language::ZhCn => "stale_tab: 请重新绑定标签页",
                Language::ZhTw => "stale_tab: 請重新綁定分頁",
            })
        })?;
        tab.verify(language).await?;
        let result = tab.action(action, cursor, cancellation, language).await;
        if !moving_cursor {
            tab.capture = None;
        }
        if result.is_err() {
            tab.socket = None;
            tab.refs.clear();
            tab.frame = None;
        }
        if closing && result.is_ok() {
            self.targets.remove(handle);
        }
        result
    }
    pub(crate) fn close(&mut self) {
        self.targets.clear();
    }
}
impl Tab {
    async fn wait_ready(&mut self, language: Language) -> Result<(), ToolError> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let tree = self.request("Page.getFrameTree", json!({})).await?;
            let frame = &tree["frameTree"]["frame"];
            let expected = match &self.navigation {
                None => true,
                Some(Navigation::Loader(loader)) => frame["loaderId"].as_str() == Some(loader),
                Some(Navigation::Reload(previous)) => frame["loaderId"]
                    .as_str()
                    .is_some_and(|loader| loader != previous),
                Some(Navigation::Url(url)) => frame["url"].as_str() == Some(url),
            };
            if expected {
                let ready = self
                    .request(
                        "Runtime.evaluate",
                        json!({"expression":"document.readyState","returnByValue":true}),
                    )
                    .await?;
                if matches!(
                    ready["result"]["value"].as_str(),
                    Some("interactive" | "complete")
                ) {
                    self.navigation = None;
                    return Ok(());
                }
            }
            if tokio::time::Instant::now() >= deadline {
                self.navigation = None;
                return Err(failed(match language {
                    Language::En => {
                        "page has not reached an observable document; call getAXState again, without repeating navigation"
                    }
                    Language::ZhCn => "页面尚无可观察的文档；请再次调用 getAXState，不要重复导航",
                    Language::ZhTw => "頁面尚無可觀察的文件；請再次呼叫 getAXState，不要重複導覽",
                }));
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
    async fn verify(&mut self, language: Language) -> Result<(), ToolError> {
        let (generation, tabs) = inventory(&self.provider).await?;
        if generation != self.generation || !tabs.iter().any(|tab| tab.id == self.info.id) {
            self.socket = None;
            self.refs.clear();
            self.capture = None;
            self.frame = None;
            return Err(failed(match language {
                Language::En => "stale_tab: browser restarted or tab closed; bind the current tab",
                Language::ZhCn => "stale_tab: 浏览器已重启或标签页已关闭；请绑定当前标签页",
                Language::ZhTw => "stale_tab: 瀏覽器已重新啟動或分頁已關閉；請綁定目前分頁",
            }));
        }
        self.info = tabs
            .into_iter()
            .find(|tab| tab.id == self.info.id)
            .expect("verified tab identity");
        if self
            .socket
            .as_ref()
            .is_none_or(|socket| socket.connection.is_closed())
        {
            self.refs.clear();
            self.capture = None;
            self.frame = None;
            let websocket = self
                .info
                .websocket
                .as_deref()
                .ok_or_else(|| failed("tab has no CDP websocket"))?;
            self.socket = Some(Cdp::connect(websocket, &self.provider).await?);
            self.frames = frames::Frames::default();
        }
        Ok(())
    }
    async fn request(&mut self, method: &str, params: Value) -> Result<Value, ToolError> {
        self.socket
            .as_mut()
            .ok_or_else(|| failed("tab connection unavailable"))?
            .request(method, params)
            .await
    }
    async fn frame(&mut self) -> Result<String, ToolError> {
        let tree = self.request("Page.getFrameTree", json!({})).await?;
        let frame = &tree["frameTree"]["frame"];
        Ok(format!(
            "{}:{}",
            frame["id"]
                .as_str()
                .ok_or_else(|| failed("missing main frame"))?,
            frame["loaderId"]
                .as_str()
                .ok_or_else(|| failed("missing document generation"))?
        ))
    }
    async fn observe(
        &mut self,
        kind: ObservationKind,
        diff: bool,
        cancellation: &tokio_util::sync::CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        self.wait_ready(language).await?;
        crate::observation::settle(crate::observation::BROWSER_SETTLE, cancellation).await?;
        self.verify(language).await?;
        self.request(
            "Runtime.releaseObjectGroup",
            json!({"objectGroup":"maka-cua"}),
        )
        .await?;
        let frame = self.frame().await?;
        let mut value = json!({});
        if !matches!(kind, ObservationKind::Screenshot) {
            let frames = self.frames().await?;
            let mut nodes = Vec::new();
            for observed in &frames {
                let session = observed.session.as_deref();
                self.frame_request(
                    session,
                    "Runtime.releaseObjectGroup",
                    json!({"objectGroup":"maka-cua"}),
                )
                .await?;
                let tree = self
                    .frame_request(
                        session,
                        "Accessibility.getFullAXTree",
                        json!({"depth":30,"frameId":observed.id}),
                    )
                    .await?;
                let dom = self
                    .frame_request(
                        session,
                        "DOM.getDocument",
                        json!({"depth":30,"pierce":true}),
                    )
                    .await?;
                let layout = self
                    .frame_request(
                        session,
                        "DOMSnapshot.captureSnapshot",
                        json!({
                            "computedStyles":cua_driver_core::browser::SEMANTIC_COMPUTED_STYLES,
                            "includePaintOrder":true,"includeDOMRects":true
                        }),
                    )
                    .await?;
                let metrics = self
                    .frame_request(session, "Page.getLayoutMetrics", json!({}))
                    .await?;
                let mut tree = cua_driver_core::browser::semantic_ax_tree(
                    &tree,
                    &dom,
                    &layout,
                    &metrics,
                    cua_driver_core::browser::store::FrameRef {
                        kind: if observed.parent.is_none() {
                            cua_driver_core::browser::store::FrameKind::Main
                        } else {
                            cua_driver_core::browser::store::FrameKind::Iframe
                        },
                        oopif_target_id: None,
                        identity: Some(cua_driver_core::browser::store::FrameIdentity {
                            frame_id: observed.id.clone(),
                            loader_id: observed.loader.clone(),
                        }),
                    },
                );
                let scope =
                    serde_json::to_string(&[&observed.id, &observed.loader]).map_err(failed)?;
                let frame_nodes = tree["nodes"]
                    .as_array_mut()
                    .ok_or_else(|| failed("browser returned no accessibility nodes"))?;
                for mut node in frame_nodes.drain(..) {
                    for key in ["nodeId", "parentId"] {
                        if let Some(id) = node[key].as_str() {
                            node[key] = json!(format!("{scope}:{id}"));
                        }
                    }
                    if let Some(children) = node["childIds"].as_array() {
                        node["childIds"] = json!(
                            children
                                .iter()
                                .filter_map(Value::as_str)
                                .map(|id| format!("{scope}:{id}"))
                                .collect::<Vec<_>>()
                        );
                    }
                    node["makaFrame"] = json!(observed);
                    nodes.push(node);
                }
            }
            if self.frames().await? != frames {
                return Err(failed(match language {
                    Language::En => "frame changed during observation; observe again",
                    Language::ZhCn => "观察期间框架已改变；请重新观察",
                    Language::ZhTw => "觀察期間框架已變更；請重新觀察",
                }));
            }
            let (full, refs) = self.ax.render(&frame, &nodes, language)?;
            self.refs = refs;
            let body = if diff {
                crate::session::display_diff(self.previous.as_deref(), &full, language)
            } else {
                full.clone()
            };
            let label = match language {
                Language::En => "Tab",
                Language::ZhCn => "标签页",
                Language::ZhTw => "分頁",
            };
            let state = format!("{label} {}: {}\n{body}", self.info.id, self.info.url);
            value["state"] = json!(state);
            self.previous = Some(full);
        } else {
            self.previous = None;
        }
        if !matches!(kind, ObservationKind::Ax) {
            let metrics = self.request("Page.getLayoutMetrics", json!({})).await?;
            let viewport = &metrics["cssVisualViewport"];
            let width = viewport["clientWidth"]
                .as_f64()
                .ok_or_else(|| failed("viewport dimensions unavailable"))?;
            let height = viewport["clientHeight"]
                .as_f64()
                .ok_or_else(|| failed("viewport dimensions unavailable"))?;
            let image = self
                .request(
                    "Page.captureScreenshot",
                    json!({"format":"png","captureBeyondViewport":false}),
                )
                .await?;
            let data = image["data"]
                .as_str()
                .ok_or_else(|| failed("browser screenshot unavailable"))?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(failed)?;
            if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
                return Err(failed("browser screenshot is not PNG"));
            }
            let image_width = u32::from_be_bytes(bytes[16..20].try_into().unwrap()) as f64;
            let image_height = u32::from_be_bytes(bytes[20..24].try_into().unwrap()) as f64;
            if image_width == 0.0 || image_height == 0.0 {
                return Err(failed("empty browser screenshot"));
            }
            value["image"] = json!({"type":"image","mimeType":"image/png","data":data});
            self.capture = Some(Capture {
                width,
                height,
                image_width,
                image_height,
                x: viewport["pageX"].as_f64().unwrap_or(0.0),
                y: viewport["pageY"].as_f64().unwrap_or(0.0),
            });
        }
        if self.frame().await? != frame {
            return Err(failed(match language {
                Language::En => "document changed during observation; observe again",
                Language::ZhCn => "观察期间文档已改变；请重新观察",
                Language::ZhTw => "觀察期間文件已變更；請重新觀察",
            }));
        }
        self.frame = Some(frame);
        Ok(value)
    }
    async fn call_element(
        &mut self,
        index: u64,
        function: &str,
        arguments: Vec<Value>,
        cancellation: &tokio_util::sync::CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        let element = self.verify_element(index, language).await?;
        let frame = element
            .frame
            .as_ref()
            .ok_or_else(|| failed("element frame was not proven"))?;
        let resolved = self
            .frame_request(
                frame.session.as_deref(),
                "DOM.resolveNode",
                json!({"backendNodeId":element.backend,"objectGroup":"maka-cua"}),
            )
            .await?;
        let object = resolved["object"]["objectId"]
            .as_str()
            .ok_or_else(|| failed("element is no longer attached"))?;
        check_input(cancellation)?;
        let result=self.frame_request(frame.session.as_deref(),"Runtime.callFunctionOn",json!({
            "objectId":object,"functionDeclaration":function,
            "arguments":arguments.into_iter().map(|value|json!({"value":value})).collect::<Vec<_>>(),"returnByValue":true
        })).await?;
        if let Some(error) = result.get("exceptionDetails") {
            return Err(failed(format!(
                "element operation refused: {}",
                error["exception"]["description"]
            )));
        }
        Ok(result["result"]["value"].clone())
    }
    async fn focus(
        &mut self,
        index: Option<u64>,
        cancellation: &tokio_util::sync::CancellationToken,
        language: Language,
    ) -> Result<(), ToolError> {
        if let Some(index) = index {
            self.call_element(index,"function(){ if(!this.isConnected) throw Error('detached'); this.focus(); if(this.getRootNode().activeElement!==this) throw Error('focus not confirmed'); }",vec![],cancellation, language).await?;
        }
        Ok(())
    }
    async fn point(&mut self, point: [f64; 2], language: Language) -> Result<[f64; 2], ToolError> {
        let capture = self.capture.ok_or_else(|| {
            failed(match language {
                Language::En => "capture_required: getScreenshot before coordinate input",
                Language::ZhCn => "capture_required: 按坐标输入前请先调用 getScreenshot",
                Language::ZhTw => "capture_required: 按座標輸入前請先呼叫 getScreenshot",
            })
        })?;
        let metrics = self.request("Page.getLayoutMetrics", json!({})).await?;
        if metrics["cssVisualViewport"]["clientWidth"].as_f64() != Some(capture.width)
            || metrics["cssVisualViewport"]["clientHeight"].as_f64() != Some(capture.height)
            || metrics["cssVisualViewport"]["pageX"].as_f64() != Some(capture.x)
            || metrics["cssVisualViewport"]["pageY"].as_f64() != Some(capture.y)
            || !point.iter().all(|v| v.is_finite() && *v >= 0.0)
            || point[0] >= capture.image_width
            || point[1] >= capture.image_height
        {
            return Err(failed(
                "stale_capture: viewport changed or point lies outside screenshot",
            ));
        }
        Ok([
            point[0] * capture.width / capture.image_width,
            point[1] * capture.height / capture.image_height,
        ])
    }
    async fn before_input(
        &mut self,
        cancellation: &tokio_util::sync::CancellationToken,
        language: Language,
    ) -> Result<(), ToolError> {
        check_input(cancellation)?;
        let frame = self.frame().await?;
        check_input(cancellation)?;
        if self.frame.as_ref() != Some(&frame) {
            self.refs.clear();
            self.capture = None;
            return Err(failed(match language {
                Language::En => "stale_document: observe after navigation before acting",
                Language::ZhCn => "stale_document: 导航后请先观察，再操作",
                Language::ZhTw => "stale_document: 導覽後請先觀察，再操作",
            }));
        }
        Ok(())
    }
    async fn before_element_input(
        &mut self,
        index: Option<u64>,
        cancellation: &tokio_util::sync::CancellationToken,
        language: Language,
    ) -> Result<(), ToolError> {
        self.before_input(cancellation, language).await?;
        if let Some(index) = index {
            self.verify_element(index, language).await?;
        }
        check_input(cancellation)
    }
    async fn action(
        &mut self,
        action: Action,
        cursor: &crate::cursor::Spec,
        cancellation: &tokio_util::sync::CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        if !matches!(
            &action,
            Action::Navigate { .. }
                | Action::Back
                | Action::Forward
                | Action::Reload
                | Action::Close
        ) {
            self.before_input(cancellation, language).await?;
        }
        let selected_index = match action.cursor_target() {
            Some(Position::Element(index)) => Some(index),
            _ => None,
        };
        if let Action::MoveCursor { target } = &action {
            let point = self.cursor_point(target, cancellation, language).await?;
            return self
                .draw_cursor(cursor, Some(point), "idle", "update", language)
                .await;
        }
        if cursor.enabled
            && !matches!(
                action,
                Action::Click { .. } | Action::Scroll { .. } | Action::Drag { .. }
            )
            && let Some(target) = action.cursor_target()
            && let Ok(point) = self.cursor_point(&target, cancellation, language).await
        {
            let _ = self
                .draw_cursor(
                    cursor,
                    Some(point),
                    action.cursor_action().as_str(),
                    "update",
                    language,
                )
                .await;
        }
        check_input(cancellation)?;
        match action {
            Action::MoveCursor { .. } => unreachable!("handled before input dispatch"),
            Action::Navigate { url } => {
                validate_url(&url)?;
                self.refs.clear();
                self.capture = None;
                let result = self.request("Page.navigate", json!({"url":url})).await?;
                if let Some(error) = result.get("errorText") {
                    return Err(failed(format!("navigation failed: {error}")));
                }
                self.navigation = result["loaderId"]
                    .as_str()
                    .map(|loader| Navigation::Loader(loader.into()));
            }
            Action::Reload => {
                let tree = self.request("Page.getFrameTree", json!({})).await?;
                let previous = tree["frameTree"]["frame"]["loaderId"]
                    .as_str()
                    .ok_or_else(|| failed("document identity unavailable"))?
                    .to_owned();
                self.refs.clear();
                check_input(cancellation)?;
                self.request("Page.reload", json!({})).await?;
                self.navigation = Some(Navigation::Reload(previous));
            }
            Action::Back | Action::Forward => {
                let history = self.request("Page.getNavigationHistory", json!({})).await?;
                let index = history["currentIndex"]
                    .as_i64()
                    .ok_or_else(|| failed("navigation history unavailable"))?
                    + if matches!(action, Action::Back) {
                        -1
                    } else {
                        1
                    };
                let entry = usize::try_from(index)
                    .ok()
                    .and_then(|index| history["entries"].get(index))
                    .ok_or_else(|| failed("no navigation history in that direction"))?;
                self.refs.clear();
                self.navigation = entry["url"].as_str().map(|url| Navigation::Url(url.into()));
                check_input(cancellation)?;
                self.request(
                    "Page.navigateToHistoryEntry",
                    json!({"entryId":entry["id"]}),
                )
                .await?;
            }
            Action::Close => {
                self.refs.clear();
                self.request("Page.close", json!({})).await?;
            }
            Action::TypeText { index, text } => {
                self.focus(index, cancellation, language).await?;
                self.before_element_input(selected_index, cancellation, language)
                    .await?;
                self.request("Input.insertText", json!({"text":text}))
                    .await?;
            }
            Action::Paste {
                index,
                text,
                options,
            } => {
                if matches!(options.format, Some(PasteFormat::Html)) {
                    let index = index.ok_or_else(|| {
                        failed("HTML paste requires an observed editable element")
                    })?;
                    self.call_element(index,"function(html){ if(!this.isConnected || !this.isContentEditable) throw Error('HTML paste requires contenteditable'); this.focus(); if(!document.execCommand('insertHTML',false,html)) throw Error('HTML insertion not supported'); }",vec![json!(text)],cancellation, language).await?;
                } else {
                    self.focus(index, cancellation, language).await?;
                    self.before_element_input(selected_index, cancellation, language)
                        .await?;
                    self.request("Input.insertText", json!({"text":text}))
                        .await?;
                }
            }
            Action::SetValue { index, value } => {
                self.call_element(
                    index,
                    include_str!("browser/set-value.js"),
                    vec![json!(value)],
                    cancellation,
                    language,
                )
                .await?;
            }
            Action::SelectText {
                index,
                text,
                options,
            } => {
                let selection = match options.selection_type.unwrap_or(SelectionType::Text) {
                    SelectionType::Text => "text",
                    SelectionType::CursorBefore => "cursor_before",
                    SelectionType::CursorAfter => "cursor_after",
                };
                self.call_element(
                    index,
                    include_str!("browser/select-text.js"),
                    vec![
                        json!(text),
                        json!(options.prefix),
                        json!(options.suffix),
                        json!(selection),
                    ],
                    cancellation,
                    language,
                )
                .await?;
            }
            Action::Click { target, options } => {
                let count = options.click_count.unwrap_or(1);
                if !(1..=3).contains(&count) {
                    return Err(failed("clickCount must be 1 to 3"));
                }
                let button = options.mouse_button.unwrap_or(MouseButton::Left).name();
                let point = match target {
                    Position::Point(point) => self.point(point, language).await?,
                    Position::Element(index) => {
                        self.element_point(index, true, cancellation, language)
                            .await?
                    }
                };
                if cursor.enabled {
                    let _ = self
                        .draw_cursor(cursor, Some(point), "click", "update", language)
                        .await;
                }
                self.before_element_input(selected_index, cancellation, language)
                    .await?;
                let pressed=self.request("Input.dispatchMouseEvent",json!({"type":"mousePressed","x":point[0],"y":point[1],"button":button,"clickCount":count})).await;
                self.request("Input.dispatchMouseEvent",json!({"type":"mouseReleased","x":point[0],"y":point[1],"button":button,"clickCount":count})).await.map_err(|error|ToolError::CleanupUnconfirmed(format!("mouse release was not acknowledged: {error}")))?;
                pressed?;
            }
            Action::PressKey { index, key } => {
                let (key, code, modifiers) = key_event(&key)?;
                self.focus(index, cancellation, language).await?;
                self.before_element_input(selected_index, cancellation, language)
                    .await?;
                let mut event = json!({"type":"keyDown","key":key,"windowsVirtualKeyCode":code,"modifiers":modifiers});
                if modifiers & 7 == 0 {
                    if key.len() == 1 {
                        event["text"] = json!(key);
                    } else if key == "Enter" {
                        event["text"] = json!("\r");
                    }
                }
                let pressed = self.request("Input.dispatchKeyEvent", event).await;
                self.request("Input.dispatchKeyEvent",json!({"type":"keyUp","key":key,"windowsVirtualKeyCode":code,"modifiers":modifiers})).await.map_err(|error|ToolError::CleanupUnconfirmed(format!("key release was not acknowledged: {error}")))?;
                pressed?;
            }
            Action::Scroll {
                target,
                direction,
                distance,
            } => {
                let pixels = match distance.unwrap_or(Distance::Pages(1)) {
                    Distance::Pages(pages) => {
                        let layout = self.request("Page.getLayoutMetrics", json!({})).await?;
                        let dimension = if matches!(direction, Direction::Left | Direction::Right) {
                            "clientWidth"
                        } else {
                            "clientHeight"
                        };
                        let extent = layout["cssVisualViewport"][dimension]
                            .as_f64()
                            .ok_or_else(|| failed("viewport dimensions unavailable"))?;
                        extent * pages as f64
                    }
                    Distance::Pixels { pixels } => pixels as f64,
                };
                if !(1.0..=50000.0).contains(&pixels) {
                    return Err(failed("scroll distance out of range"));
                }
                let (dx, dy) = match direction {
                    Direction::Up => (0.0, -pixels),
                    Direction::Down => (0.0, pixels),
                    Direction::Left => (-pixels, 0.0),
                    Direction::Right => (pixels, 0.0),
                };
                let point = match target {
                    Position::Point(point) => self.point(point, language).await?,
                    Position::Element(index) => {
                        self.element_point(index, false, cancellation, language)
                            .await?
                    }
                };
                if cursor.enabled {
                    let _ = self
                        .draw_cursor(cursor, Some(point), "scroll", "update", language)
                        .await;
                }
                self.before_element_input(selected_index, cancellation, language)
                    .await?;
                self.request(
                    "Input.dispatchMouseEvent",
                    json!({"type":"mouseWheel","x":point[0],"y":point[1],"deltaX":dx,"deltaY":dy}),
                )
                .await?;
            }
            Action::Drag { from, to } => {
                let from = self.point(from, language).await?;
                let to = self.point(to, language).await?;
                if cursor.enabled {
                    let _ = self
                        .draw_cursor(cursor, Some(from), "drag", "update", language)
                        .await;
                }
                self.before_element_input(selected_index, cancellation, language)
                    .await?;
                let pressed=self.request("Input.dispatchMouseEvent",json!({"type":"mousePressed","x":from[0],"y":from[1],"button":"left","clickCount":1})).await;
                let moved = if pressed.is_ok() {
                    if cursor.enabled {
                        let _ = self
                            .draw_cursor(cursor, Some(to), "drag", "update", language)
                            .await;
                    }
                    if let Err(error) = self.before_input(cancellation, language).await {
                        Err(error)
                    } else {
                        self.request("Input.dispatchMouseEvent",json!({"type":"mouseMoved","x":to[0],"y":to[1],"button":"left","buttons":1})).await
                    }
                } else {
                    pressed
                };
                let released=self.request("Input.dispatchMouseEvent",json!({"type":"mouseReleased","x":to[0],"y":to[1],"button":"left","clickCount":1})).await;
                released.map_err(|error| {
                    ToolError::CleanupUnconfirmed(format!(
                        "mouse release was not acknowledged: {error}"
                    ))
                })?;
                moved?;
            }
            Action::Secondary { .. } => {
                return Err(failed(
                    "unsupported: CDP accessibility does not expose secondary action names",
                ));
            }
        }
        if self.navigation.is_some() {
            self.wait_ready(language).await?;
        }
        Ok(Value::Null)
    }
}
fn validate_url(url: &str) -> Result<(), ToolError> {
    if url == "about:blank" {
        return Ok(());
    }
    let parsed = reqwest::Url::parse(url).map_err(failed)?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(failed(
            "browser navigation supports HTTP(S) and about:blank",
        ));
    }
    Ok(())
}
fn key_event(key: &str) -> Result<(String, u32, u32), ToolError> {
    let mut parts: Vec<_> = key.split('+').collect();
    let key = parts.pop().unwrap_or_default();
    let mut modifiers = 0;
    for part in parts {
        modifiers |= match part.to_ascii_lowercase().as_str() {
            "alt" | "option" => 1,
            "ctrl" | "control" => 2,
            "super" | "meta" | "cmd" | "command" => 4,
            "shift" => 8,
            _ => return Err(failed("unsupported key modifier")),
        };
    }
    let (name, code) = match key {
        "Return" | "Enter" => ("Enter", 13),
        "Tab" => ("Tab", 9),
        "Escape" | "Esc" => ("Escape", 27),
        "BackSpace" | "Backspace" => ("Backspace", 8),
        "Delete" => ("Delete", 46),
        "Up" | "ArrowUp" => ("ArrowUp", 38),
        "Down" | "ArrowDown" => ("ArrowDown", 40),
        "Left" | "ArrowLeft" => ("ArrowLeft", 37),
        "Right" | "ArrowRight" => ("ArrowRight", 39),
        "Home" => ("Home", 36),
        "End" => ("End", 35),
        "Page_Up" | "PageUp" => ("PageUp", 33),
        "Page_Down" | "PageDown" => ("PageDown", 34),
        key if key.len() == 1 && key.is_ascii() => {
            (key, key.as_bytes()[0].to_ascii_uppercase() as u32)
        }
        _ => return Err(failed("unsupported browser key")),
    };
    Ok((name.into(), code, modifiers))
}
fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}
fn unknown(error: impl std::fmt::Display) -> ToolError {
    ToolError::OutcomeUnknown(error.to_string())
}

fn check_input(cancellation: &tokio_util::sync::CancellationToken) -> Result<(), ToolError> {
    if cancellation.is_cancelled() {
        Err(failed("Computer Use cancelled before input dispatch"))
    } else {
        Ok(())
    }
}
