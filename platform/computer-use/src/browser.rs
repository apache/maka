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
mod clipboard_bridge;
mod cursor;
mod dialogs;
mod frames;
mod ownership;
mod playwright;
pub(crate) use ownership::Host;
use ownership::{BrowserIdentity, TabIdentity};

#[derive(Clone, Debug)]
struct DomElement {
    backend: u64,
    frame: Option<frames::Frame>,
}

#[derive(Clone, Debug)]
enum ElementRef {
    Dom(DomElement),
    Dialog(dialogs::DialogRef),
}

use crate::desktop::validate_connections;

pub(crate) struct Browsers {
    native: std::sync::Arc<tokio::sync::Mutex<crate::Driver>>,
    owner: uuid::Uuid,
    epoch: crate::desktop::NativeEpochId,
    cursor_spec: Option<std::sync::Arc<std::sync::Mutex<crate::cursor::Spec>>>,
    connections: Vec<BrowserConnection>,
    clipboards: HashMap<String, clipboard_bridge::Backend>,
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
struct TabSource {
    provider: BrowserConnection,
    generation: String,
    info: TabInfo,
}
enum InitialState {
    Observe,
    Deferred,
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
    cursor_epoch: crate::desktop::NativeEpochId,
    cursor_owner: uuid::Uuid,
    cursor_host: std::sync::Arc<tokio::sync::Mutex<Host>>,
    cursor_spec: Option<std::sync::Arc<std::sync::Mutex<crate::cursor::Spec>>>,
    last_turn: String,
    dialogs: Option<dialogs::Controller>,
    dialog_host: Option<std::sync::Arc<dyn crate::BrowserHostEffects>>,
    clipboard: Option<clipboard_bridge::Bridge>,
    clipboard_store: std::sync::Arc<crate::browser_clipboard::Store>,
    clipboard_authorization: Option<std::sync::Arc<dyn crate::BrowserAttachmentAuthorization>>,
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
#[derive(Clone)]
struct Cdp {
    connection: std::sync::Arc<cua_driver_core::browser::cdp_ws::CdpConnection>,
    dialogs: Option<dialogs::Link>,
}
impl Cdp {
    fn failure(error: impl ToString) -> ToolError {
        let message = error.to_string();
        if message.contains(" failed (") {
            failed(message)
        } else {
            unknown(message)
        }
    }
    fn url(url: &str, provider: &BrowserConnection) -> Result<reqwest::Url, ToolError> {
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
        Ok(url)
    }
    async fn connect(url: &str, provider: &BrowserConnection) -> Result<Self, ToolError> {
        let url = Self::url(url, provider)?;
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
            dialogs: None,
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
        if matches!(
            method,
            "Page.getFrameTree"
                | "Page.getLayoutMetrics"
                | "Page.captureScreenshot"
                | "Accessibility.getFullAXTree"
                | "DOM.getDocument"
                | "DOMSnapshot.captureSnapshot"
                | "DOM.getContentQuads"
                | "DOM.getFrameOwner"
                | "DOM.describeNode"
                | "Runtime.getProperties"
        ) {
            return self.observe_in(session, method, params).await;
        }
        if let Some(dialogs) = &self.dialogs {
            dialogs.synchronize().await;
            dialogs.state.check_method(method)?;
        }
        let result = self.connection.call(session, method, params).await;
        if let Some(dialogs) = &self.dialogs {
            dialogs.synchronize().await;
        }
        result.map_err(Self::failure)
    }

    async fn observe_in(
        &self,
        session: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<Value, ToolError> {
        if let Some(dialogs) = &self.dialogs {
            dialogs.synchronize().await;
            dialogs.state.check_method(method)?;
        }
        let result = {
            let call = self.connection.call_observation(session, method, params);
            tokio::pin!(call);
            if let Some(dialogs) = &self.dialogs {
                tokio::select! {
                    biased;
                    dialog=dialogs.state.opened()=>Err(failed(format!("A {} JavaScript dialog is active; use tab.getJsDialog() first",dialog.metadata.kind.name()))),
                    result=&mut call=>result.map_err(Self::failure),
                }
            } else {
                call.await.map_err(Self::failure)
            }
        };
        if let Some(dialogs) = &self.dialogs {
            dialogs.synchronize().await;
        }
        result
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
fn tab_matches(provider: &BrowserConnection, tab: &TabInfo, id: &str) -> bool {
    id == tab.id || id == format!("{}:{}", provider.id, tab.id)
}
impl Browsers {
    pub(crate) fn new(native: std::sync::Arc<tokio::sync::Mutex<crate::Driver>>) -> Self {
        Self::with_owner(native, uuid::Uuid::new_v4())
    }

    pub(crate) fn with_owner(
        native: std::sync::Arc<tokio::sync::Mutex<crate::Driver>>,
        owner: uuid::Uuid,
    ) -> Self {
        Self {
            native,
            owner,
            epoch: crate::desktop::NativeEpochId::new(),
            cursor_spec: None,
            connections: Vec::new(),
            clipboards: HashMap::new(),
            targets: HashMap::new(),
        }
    }

    pub(crate) fn with_epoch(
        native: std::sync::Arc<tokio::sync::Mutex<crate::Driver>>,
        owner: uuid::Uuid,
        epoch: crate::desktop::NativeEpochId,
        cursor_spec: std::sync::Arc<std::sync::Mutex<crate::cursor::Spec>>,
    ) -> Self {
        Self {
            native,
            owner,
            epoch,
            cursor_spec: Some(cursor_spec),
            connections: Vec::new(),
            clipboards: HashMap::new(),
            targets: HashMap::new(),
        }
    }

    async fn host(&self) -> std::sync::Arc<tokio::sync::Mutex<Host>> {
        self.native.lock().await.browsers.clone()
    }

    async fn visible_inventory(
        &self,
        provider: &BrowserConnection,
    ) -> Result<(String, Vec<TabInfo>), ToolError> {
        let (generation, tabs) = inventory(provider).await?;
        let browser = BrowserIdentity::new(provider, &generation)?;
        let host = self.host().await;
        let host = host.lock().await;
        host.known(&browser)?;
        Ok((
            generation,
            tabs.into_iter()
                .filter(|tab| host.visible(&browser.tab(&tab.id), self.owner))
                .collect(),
        ))
    }

    async fn use_tab(&self, identity: &TabIdentity, turn: &str) -> Result<(), ToolError> {
        self.host()
            .await
            .lock()
            .await
            .use_tab(identity, self.owner, turn)
    }

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
        if connections != self.connections {
            self.clipboards.clear();
        }
        self.connections = connections;
        Ok(())
    }
    pub(crate) async fn state(&self) -> (Vec<Value>, Vec<String>) {
        let mut browsers = Vec::new();
        let mut errors = Vec::new();
        for provider in &self.connections {
            match self.visible_inventory(provider).await {
                Ok((_, tabs)) => browsers.push(json!({"id":provider.id,"name":provider.id,"type":"cdp","tabs":tabs.iter().map(|t| tab_info(provider,t)).collect::<Vec<_>>() })),
                Err(error) => errors.push(format!("{}: {error}", provider.id)),
            }
        }
        (browsers, errors)
    }
    pub(crate) async fn invoke(
        &mut self,
        command: Command,
        invocation: &crate::InvocationContext<'_>,
        cursor: &crate::cursor::Spec,
        cancellation: &tokio_util::sync::CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        let turn = invocation.turn();
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
                    let (_, listed) = self.visible_inventory(provider).await?;
                    tabs.extend(listed.iter().map(|tab| tab_info(provider, tab)));
                }
                Ok(json!(tabs))
            }
            Command::GetBrowser { options } => {
                if options.extension_instance_id.is_some() {
                    return Err(failed("extension browser providers are unavailable"));
                }
                if options.id.is_none()
                    && let Some(url) = options.url
                {
                    normalized_url(&url)?;
                }
                let mut matches = Vec::new();
                for provider in self.providers(options.id.as_deref())? {
                    inventory(provider).await?;
                    matches.push(provider);
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
            Command::BrowserTab {
                browser_id,
                reference,
            } => {
                let provider = self.providers(Some(&browser_id))?[0].clone();
                match reference {
                    BrowserTabReference::New => {
                        self.create(
                            provider,
                            None,
                            InitialState::Deferred,
                            invocation,
                            cancellation,
                            language,
                        )
                        .await
                    }
                    BrowserTabReference::Existing(id) => {
                        if id.is_empty() {
                            return Err(failed("tab ID is required"));
                        }
                        let (generation, tabs) = inventory(&provider).await?;
                        let info = tabs
                            .into_iter()
                            .find(|tab| tab_matches(&provider, tab, &id))
                            .ok_or_else(|| failed("tab is unavailable in the selected browser"))?;
                        self.bind(
                            TabSource {
                                provider,
                                generation,
                                info,
                            },
                            InitialState::Deferred,
                            invocation,
                            cancellation,
                            language,
                        )
                        .await
                    }
                }
            }
            command @ (Command::ClipboardRead {
                handle: Handle::Tab(_),
            }
            | Command::ClipboardReadText {
                handle: Handle::Tab(_),
            }
            | Command::ClipboardWrite {
                handle: Handle::Tab(_),
                ..
            }
            | Command::ClipboardWriteText {
                handle: Handle::Tab(_),
                ..
            }) => {
                let handle = match &command {
                    Command::ClipboardRead {
                        handle: Handle::Tab(handle),
                    }
                    | Command::ClipboardReadText {
                        handle: Handle::Tab(handle),
                    }
                    | Command::ClipboardWrite {
                        handle: Handle::Tab(handle),
                        ..
                    }
                    | Command::ClipboardWriteText {
                        handle: Handle::Tab(handle),
                        ..
                    } => handle,
                    _ => unreachable!(),
                };
                let identity = self
                    .targets
                    .get(handle)
                    .ok_or_else(|| failed("stale_tab: bind it again"))?
                    .identity()?;
                self.use_tab(&identity, turn).await?;
                let tab = self.targets.get_mut(handle).unwrap();
                tab.last_turn = turn.to_owned();
                tab.authorize(None, invocation, cancellation, language)
                    .await?;
                tab.ensure_clipboard_bridge(turn, language).await?;
                check_input(cancellation)?;
                let store = &tab.clipboard_store;
                store
                    .access(|items| {
                        check_input(cancellation)?;
                        match command {
                            Command::ClipboardRead { .. } => Ok(json!(items)),
                            Command::ClipboardReadText { .. } => Ok(json!(
                                items
                                    .iter()
                                    .flat_map(ClipboardItem::entries)
                                    .find(|entry| entry.mime_type() == "text/plain")
                                    .and_then(|entry| match entry.payload() {
                                        ClipboardPayload::Text { text } => Some(text.as_str()),
                                        ClipboardPayload::Base64 { .. } => None,
                                    })
                                    .unwrap_or_default()
                            )),
                            Command::ClipboardWrite {
                                items: replacement, ..
                            } => {
                                *items = replacement.into_vec();
                                Ok(Value::Null)
                            }
                            Command::ClipboardWriteText { text, .. } => {
                                *items = ClipboardItems::text(text).into_vec();
                                Ok(Value::Null)
                            }
                            _ => unreachable!(),
                        }
                    })
                    .await
            }
            Command::BrowserMutation {
                handle: Handle::Tab(handle),
                locator,
                operation,
            } => {
                playwright::validate_mutation(&operation)?;
                let identity = self
                    .targets
                    .get(&handle)
                    .ok_or_else(|| failed("stale_tab: bind it again"))?
                    .identity()?;
                self.use_tab(&identity, turn).await?;
                let tab = self.targets.get_mut(&handle).unwrap();
                tab.last_turn = turn.to_owned();
                tab.authorize(None, invocation, cancellation, language)
                    .await?;
                let document = tab.document();
                tab.playwright_mutation(
                    &locator,
                    operation,
                    document,
                    cursor,
                    cancellation,
                    language,
                )
                .await
            }
            Command::BrowserRead {
                handle: Handle::Tab(handle),
                locator,
                operation,
                options,
            } => {
                playwright::validate(&operation, &options)?;
                let identity = self
                    .targets
                    .get(&handle)
                    .ok_or_else(|| failed("stale_tab: bind it again"))?
                    .identity()?;
                self.use_tab(&identity, turn).await?;
                let tab = self.targets.get_mut(&handle).unwrap();
                tab.last_turn = turn.to_owned();
                tab.authorize(None, invocation, cancellation, language)
                    .await?;
                let document = tab.document();
                tab.playwright_read(
                    &locator,
                    operation,
                    options,
                    document,
                    cancellation,
                    language,
                )
                .await
            }
            command @ (Command::GetJsDialog {
                handle: Handle::Tab(_),
                ..
            }
            | Command::HandleJsDialog {
                handle: Handle::Tab(_),
                ..
            }) => {
                let handle = match &command {
                    Command::GetJsDialog {
                        handle: Handle::Tab(handle),
                    }
                    | Command::HandleJsDialog {
                        handle: Handle::Tab(handle),
                        ..
                    } => handle,
                    _ => unreachable!(),
                };
                let identity = self
                    .targets
                    .get(handle)
                    .ok_or_else(|| failed("stale_tab: bind it again"))?
                    .identity()?;
                self.use_tab(&identity, turn).await?;
                let tab = self.targets.get_mut(handle).unwrap();
                tab.last_turn = turn.to_owned();
                tab.authorize(None, invocation, cancellation, language)
                    .await?;
                if let Some(controller) = &tab.dialogs {
                    controller.link.synchronize().await;
                }
                match command {
                    Command::GetJsDialog { .. } => Ok(tab
                        .dialogs
                        .as_ref()
                        .and_then(|controller| controller.link.state.current())
                        .map(|dialog| json!(dialog.metadata))
                        .unwrap_or(Value::Null)),
                    Command::HandleJsDialog {
                        dialog_id,
                        action,
                        prompt_text,
                        ..
                    } => {
                        tab.handle_dialog(&dialog_id, action, prompt_text, invocation, cancellation)
                            .await
                    }
                    _ => unreachable!(),
                }
            }
            Command::TabMetadata {
                handle: Handle::Tab(handle),
            } => {
                let identity = self
                    .targets
                    .get(&handle)
                    .ok_or_else(|| failed("stale_tab: bind it again"))?
                    .identity()?;
                self.use_tab(&identity, turn).await?;
                let tab = self.targets.get_mut(&handle).unwrap();
                tab.last_turn = turn.to_owned();
                tab.refresh_info(language).await?;
                Ok(json!({"title":tab.info.title,"url":tab.info.url}))
            }
            Command::GetTab { reference, options } => {
                let mut matches = Vec::new();
                for provider in self.providers(options.browser.as_deref())? {
                    let (generation, tabs) = inventory(provider).await?;
                    for tab in tabs {
                        let selected = match &reference {
                            TabReference::Id(id) => tab_matches(provider, &tab, id),
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
                self.bind(
                    TabSource {
                        provider,
                        generation,
                        info: tab,
                    },
                    InitialState::Observe,
                    invocation,
                    cancellation,
                    language,
                )
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
                let url = url.map(|url| convenience_url(&url));
                let provider = self.providers(Some(&browser_id))?[0].clone();
                self.create(
                    provider,
                    url,
                    InitialState::Observe,
                    invocation,
                    cancellation,
                    language,
                )
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
                    invocation,
                    cancellation,
                    language,
                )
                .await
            }
            Command::Action {
                handle: Handle::Tab(handle),
                action,
            } => {
                self.action(&handle, action, invocation, cursor, cancellation, language)
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
    async fn create(
        &mut self,
        provider: BrowserConnection,
        url: Option<String>,
        initial: InitialState,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &tokio_util::sync::CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        let turn = invocation.turn();
        let (generation, _) = inventory(&provider).await?;
        let identity = BrowserIdentity::new(&provider, &generation)?;
        check_input(cancellation)?;
        let mut browser = Cdp::connect(&generation, &provider).await?;
        let host = self.host().await;
        let mut host = host.lock().await;
        host.known(&identity)?;
        check_input(cancellation)?;
        let created = browser
            .request(
                "Target.createTarget",
                json!({"url":"about:blank","background":true}),
            )
            .await;
        let id = match created {
            Ok(value) => match value["targetId"].as_str() {
                Some(id) => id.to_owned(),
                None => {
                    host.creation_unknown(identity, self.owner, turn, provider, generation);
                    return Err(unknown("browser did not return a target ID"));
                }
            },
            Err(error) => {
                if matches!(error, ToolError::OutcomeUnknown(_)) {
                    host.creation_unknown(identity, self.owner, turn, provider, generation);
                }
                return Err(error);
            }
        };
        host.created(
            identity.tab(&id),
            self.owner,
            turn,
            provider.clone(),
            generation.clone(),
        )?;
        drop(host);
        let (current, tabs) = inventory(&provider).await?;
        if current != generation {
            return Err(unknown("browser restarted after tab creation"));
        }
        let info = tabs.into_iter().find(|tab| tab.id == id).ok_or_else(|| {
            unknown(match language {
                Language::En => "created tab is not observable",
                Language::ZhCn => "已创建的标签页不可观察",
                Language::ZhTw => "已建立的分頁無法觀察",
            })
        })?;
        let mut bound = self
            .bind(
                TabSource {
                    provider,
                    generation,
                    info,
                },
                InitialState::Deferred,
                invocation,
                cancellation,
                language,
            )
            .await?;
        let Handle::Tab(handle) =
            serde_json::from_value(bound["handle"].clone()).map_err(failed)?
        else {
            unreachable!("browser creation always binds a tab");
        };
        if let Some(url) = url {
            self.action(
                &handle,
                Action::Navigate { url },
                invocation,
                &crate::cursor::Spec::default(),
                cancellation,
                language,
            )
            .await?;
        }
        if matches!(initial, InitialState::Observe) {
            let observed = self
                .observe(
                    &handle,
                    ObservationKind::Ax,
                    false,
                    invocation,
                    cancellation,
                    language,
                )
                .await?;
            bound["state"] = observed["state"].clone();
        }
        Ok(bound)
    }
    async fn bind(
        &mut self,
        source: TabSource,
        initial: InitialState,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &tokio_util::sync::CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        let turn = invocation.turn();
        let TabSource {
            provider,
            generation,
            info,
        } = source;
        let identity = BrowserIdentity::new(&provider, &generation)?.tab(&info.id);
        self.use_tab(&identity, turn).await?;
        if self
            .clipboards
            .get(&provider.id)
            .is_none_or(|backend| backend.provider != provider || backend.generation != generation)
        {
            self.clipboards.insert(
                provider.id.clone(),
                clipboard_bridge::Backend::new(provider.clone(), generation.clone()),
            );
        }
        let clipboard_store = self.clipboards[&provider.id].store.clone();
        let existing = self.targets.iter().find_map(|(handle, tab)| {
            (tab.provider == provider && tab.identity().ok().as_ref() == Some(&identity))
                .then(|| handle.clone())
        });
        let new = existing.is_none();
        let handle = existing.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let id = format!("{}:{}", provider.id, info.id);
        if let Some(tab) = self.targets.get_mut(&handle) {
            if tab
                .clipboard
                .as_ref()
                .is_some_and(|bridge| bridge.turn() != turn)
            {
                tab.cleanup_clipboard().await?;
            }
            if !std::sync::Arc::ptr_eq(&tab.clipboard_store, &clipboard_store) {
                tab.cleanup_clipboard().await?;
            }
            tab.clipboard_store = clipboard_store;
            tab.provider = provider;
            tab.generation = generation;
            tab.info = info;
            tab.last_turn = turn.to_owned();
        } else {
            let cursor_host = self.host().await;
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
                    cursor_epoch: self.epoch,
                    cursor_owner: self.owner,
                    cursor_host,
                    cursor_spec: self.cursor_spec.clone(),
                    last_turn: turn.to_owned(),
                    dialogs: None,
                    dialog_host: invocation.browser_host_effects(),
                    clipboard: None,
                    clipboard_store,
                    clipboard_authorization: invocation
                        .browser_authorization()
                        .and_then(|authorization| authorization.attachment()),
                },
            );
        }
        if matches!(initial, InitialState::Deferred) {
            return Ok(json!({"handle":Handle::Tab(handle),"id":id,"kind":"tab"}));
        }
        match self
            .observe(
                &handle,
                ObservationKind::Ax,
                false,
                invocation,
                cancellation,
                language,
            )
            .await
        {
            Ok(value) => Ok(
                json!({"handle":Handle::Tab(handle),"id":id,"kind":"tab","state":value["state"]}),
            ),
            Err(error) => {
                if new {
                    let tab = self.targets.get_mut(&handle).unwrap();
                    if let Err(cleanup) = tab.disconnect().await {
                        return Err(ToolError::CleanupUnconfirmed(format!(
                            "{error}; browser target cleanup: {cleanup}"
                        )));
                    }
                    self.targets.remove(&handle);
                }
                Err(error)
            }
        }
    }
    async fn observe(
        &mut self,
        handle: &str,
        kind: ObservationKind,
        diff: bool,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &tokio_util::sync::CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        let turn = invocation.turn();
        let tab = self.targets.get(handle).ok_or_else(|| {
            failed(match language {
                Language::En => "stale_tab: bind it again",
                Language::ZhCn => "stale_tab: 请重新绑定标签页",
                Language::ZhTw => "stale_tab: 請重新綁定分頁",
            })
        })?;
        let identity = tab.identity()?;
        self.use_tab(&identity, turn).await?;
        let tab = self.targets.get_mut(handle).unwrap();
        tab.last_turn = turn.to_owned();
        tab.refs.clear();
        tab.capture = None;
        tab.frame = None;
        tab.authorize(None, invocation, cancellation, language)
            .await?;
        tab.verify(language).await?;
        let mut result = tab
            .observe(kind, diff, invocation, cancellation, language)
            .await;
        if result.is_err()
            && let Some(dialog) = tab.active_dialog().await
        {
            result = tab.observe_dialog(dialog, kind, diff, language);
        }
        if result.is_err() && tab.active_dialog().await.is_none() {
            if let Err(error) = tab.disconnect().await {
                result = result.map_err(|original| {
                    ToolError::CleanupUnconfirmed(format!(
                        "{original}; browser target cleanup: {error}"
                    ))
                });
            }
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
        invocation: &crate::InvocationContext<'_>,
        cursor: &crate::cursor::Spec,
        cancellation: &tokio_util::sync::CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        let turn = invocation.turn();
        let closing = matches!(&action, Action::Close);
        let moving_cursor = matches!(&action, Action::MoveCursor { .. });
        let tab = self.targets.get(handle).ok_or_else(|| {
            failed(match language {
                Language::En => "stale_tab: bind it again",
                Language::ZhCn => "stale_tab: 请重新绑定标签页",
                Language::ZhTw => "stale_tab: 請重新綁定分頁",
            })
        })?;
        let identity = tab.identity()?;
        self.use_tab(&identity, turn).await?;
        let host = self.host().await;
        let tab = self.targets.get_mut(handle).unwrap();
        tab.last_turn = turn.to_owned();
        if !closing {
            let target = match &action {
                Action::Navigate { url } => Some(url.as_str()),
                _ => None,
            };
            tab.authorize(target, invocation, cancellation, language)
                .await?;
        }
        tab.verify(language).await?;
        let mut result = if closing {
            tab.cleanup_clipboard().await?;
            let mut host = host.lock().await;
            check_input(cancellation)?;
            host.begin_close(&identity, self.owner, turn)?;
            tab.refs.clear();
            tab.request("Page.close", json!({}))
                .await
                .map(|_| Value::Null)
        } else {
            tab.action(action, invocation, cursor, cancellation, language)
                .await
        };
        if !moving_cursor {
            tab.capture = None;
        }
        if result.is_err() && tab.active_dialog().await.is_none() {
            if let Err(error) = tab.disconnect().await {
                result = result.map_err(|original| {
                    ToolError::CleanupUnconfirmed(format!(
                        "{original}; browser target cleanup: {error}"
                    ))
                });
            }
            tab.refs.clear();
            tab.frame = None;
        }
        if closing && result.is_ok() {
            tab.disconnect().await?;
            self.targets.remove(handle);
        }
        result
    }
    pub(crate) async fn finish_turn(
        &mut self,
        turn: &str,
        cursor: &crate::cursor::Spec,
        language: Language,
    ) -> Result<(), ToolError> {
        for tab in self.targets.values().filter(|tab| {
            tab.last_turn == turn
                || tab
                    .clipboard
                    .as_ref()
                    .is_some_and(|bridge| bridge.turn() == turn)
        }) {
            tab.begin_disconnect();
        }
        let mut failures = Vec::new();
        let mut unsettled = std::collections::HashSet::new();
        for (handle, tab) in &mut self.targets {
            if tab.last_turn != turn {
                if tab
                    .clipboard
                    .as_ref()
                    .is_some_and(|bridge| bridge.turn() == turn)
                    && let Err(error) = tab.cleanup_clipboard().await
                {
                    failures.push(error.to_string());
                    unsettled.insert(handle.clone());
                }
                continue;
            }
            if tab
                .socket
                .as_ref()
                .is_some_and(|socket| !socket.connection.is_closed())
            {
                let _ = tab
                    .draw_cursor(cursor, None, "idle", "hide", language)
                    .await;
            }
            if let Err(error) = tab.disconnect().await {
                failures.push(error.to_string());
                unsettled.insert(handle.clone());
            }
            tab.refs.clear();
            tab.frames = frames::Frames::default();
            tab.frame = None;
            tab.capture = None;
            tab.previous = None;
        }
        let finished = self
            .host()
            .await
            .lock()
            .await
            .finish(self.owner, Some(turn))
            .await;
        let finished: std::collections::HashSet<_> = match finished {
            Ok(finished) => finished.into_iter().collect(),
            Err(error) => {
                failures.push(error.to_string());
                std::collections::HashSet::new()
            }
        };
        self.targets.retain(|handle, tab| {
            unsettled.contains(handle)
                || tab
                    .identity()
                    .is_ok_and(|identity| !finished.contains(&identity))
        });
        if failures.is_empty() {
            Ok(())
        } else {
            Err(ToolError::CleanupUnconfirmed(failures.join("; ")))
        }
    }

    pub(crate) async fn retire_epoch(
        &mut self,
        cursor: &crate::cursor::Spec,
    ) -> Result<(), ToolError> {
        for tab in self.targets.values() {
            tab.begin_disconnect();
        }
        self.remove_cursors(cursor).await;
        let mut failures = Vec::new();
        let handles: Vec<_> = self.targets.keys().cloned().collect();
        for handle in handles {
            match self.targets.get_mut(&handle).unwrap().disconnect().await {
                Ok(()) => {
                    self.targets.remove(&handle);
                }
                Err(error) => failures.push(error.to_string()),
            }
        }
        if failures.is_empty() {
            for backend in self.clipboards.values() {
                backend.store.clear().await;
            }
            self.clipboards.clear();
            self.connections.clear();
            Ok(())
        } else {
            Err(ToolError::CleanupUnconfirmed(failures.join("; ")))
        }
    }

    pub(crate) async fn close(&mut self, cursor: &crate::cursor::Spec) -> Result<(), ToolError> {
        let mut failures = Vec::new();
        if let Err(error) = self.retire_epoch(cursor).await {
            failures.push(error.to_string());
        }
        let host = self.host().await;
        let mut host = host.lock().await;
        let cursor_result = host.finalize_cursors(self.owner, cursor).await;
        let tabs_result = host.finish(self.owner, None).await;
        if let Err(error) = cursor_result {
            failures.push(error.to_string());
        }
        if let Err(error) = tabs_result {
            failures.push(error.to_string());
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(ToolError::CleanupUnconfirmed(failures.join("; ")))
        }
    }
}
impl Default for Browsers {
    fn default() -> Self {
        Self::new(std::sync::Arc::new(tokio::sync::Mutex::new(
            crate::Driver::default(),
        )))
    }
}
impl Tab {
    async fn ensure_clipboard_bridge(
        &mut self,
        turn: &str,
        language: Language,
    ) -> Result<(), ToolError> {
        let authorization = self
            .clipboard_authorization
            .clone()
            .ok_or_else(|| failed("Browser clipboard requires current attachment authorization"))?;
        let host = self
            .dialog_host
            .clone()
            .ok_or_else(|| failed("Browser clipboard requires Host effect custody"))?;
        self.verify(language).await?;
        if self
            .clipboard
            .as_ref()
            .is_some_and(|bridge| !bridge.is_open())
        {
            self.cleanup_clipboard().await?;
        }
        if self.clipboard.is_none() {
            let store = self.clipboard_store.clone();
            clipboard_bridge::Bridge::install(self, store, authorization, host, turn).await?;
        }
        Ok(())
    }
    async fn cleanup_clipboard(&mut self) -> Result<(), ToolError> {
        if let Some(bridge) = self.clipboard.as_mut() {
            bridge.cleanup().await?;
            self.clipboard = None;
        }
        Ok(())
    }

    fn begin_disconnect(&self) {
        if let Some(bridge) = &self.clipboard {
            bridge.begin_close();
        }
        if let Some(dialogs) = &self.dialogs {
            dialogs.host_effects(None);
        }
    }

    async fn disconnect(&mut self) -> Result<(), ToolError> {
        self.begin_disconnect();
        self.cleanup_clipboard().await?;
        if let Some(dialogs) = self.dialogs.as_mut() {
            dialogs.close().await?;
        }
        self.dialogs = None;
        self.dialog_host = None;
        self.clipboard_authorization = None;
        self.socket = None;
        Ok(())
    }

    fn document(&self) -> crate::BrowserDocument {
        crate::BrowserDocument {
            browser_id: self.provider.id.clone(),
            generation: self.generation.clone(),
            tab_id: self.info.id.clone(),
            url: self.info.url.clone(),
        }
    }

    async fn authorize(
        &mut self,
        navigation: Option<&str>,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &tokio_util::sync::CancellationToken,
        language: Language,
    ) -> Result<(), ToolError> {
        self.refresh_info(language).await?;
        let document = self.document();
        let access = match navigation {
            Some(url) => crate::BrowserAccess::Navigate {
                document: document.clone(),
                url: url.into(),
            },
            None => crate::BrowserAccess::Read {
                document: document.clone(),
            },
        };
        invocation.authorize_browser(access, cancellation).await?;
        // Human consent may suspend this call while another actor navigates.
        // Never apply the admitted operation to that replacement document.
        self.refresh_info(language).await?;
        if self.document() != document {
            return Err(failed(
                "document changed during browser authorization; retry the operation",
            ));
        }
        check_input(cancellation)?;
        if self
            .clipboard
            .as_ref()
            .is_some_and(|bridge| bridge.turn() != invocation.turn())
        {
            self.cleanup_clipboard().await?;
        }
        self.clipboard_authorization = invocation
            .browser_authorization()
            .and_then(|authorization| authorization.attachment());
        self.dialog_host = invocation.browser_host_effects();
        if let Some(bridge) = &self.clipboard {
            bridge.update(
                self.clipboard_authorization.clone(),
                self.dialog_host.clone(),
            );
        }
        if let Some(controller) = &self.dialogs {
            controller.host_effects(self.dialog_host.clone());
        }
        Ok(())
    }

    fn identity(&self) -> Result<TabIdentity, ToolError> {
        Ok(BrowserIdentity::new(&self.provider, &self.generation)?.tab(&self.info.id))
    }
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
                    .socket
                    .as_ref()
                    .ok_or_else(|| failed("tab connection unavailable"))?
                    .observe_in(
                        None,
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
    async fn refresh_info(&mut self, language: Language) -> Result<(), ToolError> {
        let (generation, tabs) = inventory(&self.provider).await?;
        if generation != self.generation || !tabs.iter().any(|tab| tab.id == self.info.id) {
            self.disconnect().await?;
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
        Ok(())
    }
    async fn verify(&mut self, language: Language) -> Result<(), ToolError> {
        self.refresh_info(language).await?;
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
            let mut socket = Cdp::connect(websocket, &self.provider).await?;
            let controller = dialogs::Controller::start(socket.clone());
            controller.host_effects(self.dialog_host.clone());
            socket.dialogs = Some(controller.link.clone());
            self.dialogs = Some(controller);
            self.socket = Some(socket);
            self.frames = frames::Frames::default();
            self.request("Page.enable", json!({})).await?;
            if self
                .dialogs
                .as_ref()
                .and_then(|controller| controller.link.state.current())
                .is_none()
            {
                self.attach_frames().await?;
            }
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
        invocation: &crate::InvocationContext<'_>,
        cancellation: &tokio_util::sync::CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        if let Some(dialog) = self.active_dialog().await {
            return self.observe_dialog(dialog, kind, diff, language);
        }
        self.wait_ready(language).await?;
        crate::observation::settle(crate::observation::BROWSER_SETTLE, cancellation).await?;
        self.authorize(None, invocation, cancellation, language)
            .await?;
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
        invocation: &crate::InvocationContext<'_>,
        cursor: &crate::cursor::Spec,
        cancellation: &tokio_util::sync::CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        if matches!(
            action,
            Action::LinuxClick { .. } | Action::LinuxScroll { .. } | Action::LinuxDrag { .. }
        ) {
            return Err(failed("Linux native input requires an application target"));
        }
        if let Some(dialog) = self.active_dialog().await {
            return self
                .dialog_action(dialog, action, invocation, cancellation)
                .await;
        }
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
            Action::LinuxClick { .. } | Action::LinuxScroll { .. } | Action::LinuxDrag { .. } => {
                unreachable!("refused before browser input")
            }
            Action::Navigate { url } => {
                validate_url(&url)?;
                let source_frame = self.frame().await?;
                self.refs.clear();
                self.capture = None;
                check_input(cancellation)?;
                if self.frame().await? != source_frame {
                    return Err(failed(
                        "document changed before navigation dispatch; retry the operation",
                    ));
                }
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
                let target = entry["url"]
                    .as_str()
                    .ok_or_else(|| failed("history URL unavailable"))?;
                self.authorize(Some(target), invocation, cancellation, language)
                    .await?;
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
                unreachable!("tab closure is admitted by its Host owner")
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
                let distance = distance.unwrap_or(Distance::Pages(1.0));
                match &distance {
                    Distance::Pages(pages) if !pages.is_finite() => {
                        return Err(failed("scroll pages must be finite"));
                    }
                    Distance::Pixels { pixels } if !pixels.is_finite() || *pixels <= 0.0 => {
                        return Err(failed("scroll pixels must be positive and finite"));
                    }
                    _ => {}
                }
                let horizontal = matches!(direction, Direction::Left | Direction::Right);
                let (point, extent) = match target {
                    Position::Point(point) => {
                        let point = self.point(point, language).await?;
                        let layout = self.request("Page.getLayoutMetrics", json!({})).await?;
                        let dimension = if horizontal {
                            "clientWidth"
                        } else {
                            "clientHeight"
                        };
                        let extent = layout["cssVisualViewport"][dimension]
                            .as_f64()
                            .ok_or_else(|| failed("viewport dimensions unavailable"))?;
                        (point, extent)
                    }
                    Position::Element(index) => {
                        let extent = self.element_extent(index, horizontal, language).await?;
                        let point = self
                            .element_point(index, false, cancellation, language)
                            .await?;
                        (point, extent)
                    }
                };
                let pixels = match distance {
                    Distance::Pages(pages) => extent.max(100.0) * pages,
                    Distance::Pixels { pixels } => pixels,
                };
                if !pixels.is_finite() {
                    return Err(failed("scroll delta must be finite"));
                }
                let (dx, dy) = match direction {
                    Direction::Up => (0.0, -pixels),
                    Direction::Down => (0.0, pixels),
                    Direction::Left => (-pixels, 0.0),
                    Direction::Right => (pixels, 0.0),
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
                    json!({"type":"mouseMoved","x":point[0],"y":point[1],"button":"none","buttons":0}),
                ).await?;
                check_input(cancellation)?;
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
fn normalized_url(url: &str) -> Result<String, ToolError> {
    let url = convenience_url(url);
    reqwest::Url::parse(&url).map_err(failed)?;
    Ok(url)
}
fn convenience_url(url: &str) -> String {
    if reqwest::Url::parse(url).is_ok() {
        url.to_owned()
    } else {
        format!("https://{url}")
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;
    use tokio_util::sync::CancellationToken;

    struct Decision {
        allow: bool,
        accesses: Arc<Mutex<Vec<crate::BrowserAccess>>>,
    }
    impl crate::BrowserAuthorization for Decision {
        fn authorize(
            &self,
            access: crate::BrowserAccess,
            _: CancellationToken,
        ) -> crate::AuthorizationFuture {
            self.accesses.lock().unwrap().push(access);
            let allow = self.allow;
            Box::pin(async move {
                if allow {
                    Ok(())
                } else {
                    Err(failed("fixture denied site access"))
                }
            })
        }
        fn check(
            &self,
            access: crate::BrowserAccess,
            cancellation: CancellationToken,
        ) -> crate::AuthorizationFuture {
            self.authorize(access, cancellation)
        }
    }

    fn decision_context(
        allow: bool,
    ) -> (
        crate::InvocationContext<'static>,
        Arc<Mutex<Vec<crate::BrowserAccess>>>,
    ) {
        let accesses = Arc::new(Mutex::new(Vec::new()));
        (
            crate::InvocationContext::new("fixture", "turn").with_browser_authorization(Arc::new(
                Decision {
                    allow,
                    accesses: accesses.clone(),
                },
            )),
            accesses,
        )
    }

    async fn serve_inventory(listener: &TcpListener, tabs: &[Value]) -> Vec<String> {
        let address = listener.local_addr().unwrap();
        let mut paths = Vec::new();
        for expected in ["/json/version", "/json/list"] {
            let (stream, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            let mut line = String::new();
            stream.read_line(&mut line).await.unwrap();
            let path = line.split_whitespace().nth(1).unwrap().to_owned();
            assert_eq!(path, expected);
            paths.push(path);
            loop {
                line.clear();
                stream.read_line(&mut line).await.unwrap();
                if line == "\r\n" {
                    break;
                }
                assert!(!line.is_empty(), "incomplete fixture request");
            }
            let body = if expected == "/json/version" {
                json!({"webSocketDebuggerUrl": format!("ws://{address}/devtools/browser/fixture")})
            } else {
                json!(tabs)
            }
            .to_string();
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        }
        paths
    }

    #[tokio::test]
    async fn host_authorization_revalidates_the_current_url_after_consent() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let before = [
                json!({"id":"page","title":"Before","url":"https://source.example/","type":"page"}),
            ];
            let after = [
                json!({"id":"page","title":"After","url":"https://replacement.example/","type":"page"}),
            ];
            let mut paths = serve_inventory(&listener, &before).await;
            paths.extend(serve_inventory(&listener, &before).await);
            paths.extend(serve_inventory(&listener, &after).await);
            assert!(
                tokio::time::timeout(Duration::from_millis(100), listener.accept())
                    .await
                    .is_err(),
                "a changed URL received a CDP connection"
            );
            paths
        });
        let mut browsers = Browsers::default();
        browsers
            .configure(
                vec![BrowserConnection {
                    id: "fixture".into(),
                    endpoint,
                }],
                Language::En,
            )
            .unwrap();
        let cursor = crate::cursor::Spec::default();
        let cancellation = CancellationToken::new();
        let (context, accesses) = decision_context(true);
        let bound = browsers
            .invoke(
                Command::BrowserTab {
                    browser_id: "fixture".into(),
                    reference: BrowserTabReference::Existing("page".into()),
                },
                &context,
                &cursor,
                &cancellation,
                Language::En,
            )
            .await
            .unwrap();
        let result = browsers
            .invoke(
                Command::Action {
                    handle: serde_json::from_value(bound["handle"].clone()).unwrap(),
                    action: Action::Navigate {
                        url: "https://destination.example/path".into(),
                    },
                },
                &context,
                &cursor,
                &cancellation,
                Language::En,
            )
            .await;
        assert!(
            matches!(result,Err(ToolError::Failed(message)) if message == "document changed during browser authorization; retry the operation")
        );
        {
            let accesses = accesses.lock().unwrap();
            assert_eq!(accesses.len(), 1);
            assert_eq!(accesses[0].document().url, "https://source.example/");
            assert_eq!(
                accesses[0].origin().unwrap().as_deref(),
                Some("https://destination.example")
            );
        }
        assert_eq!(server.await.unwrap().len(), 6);
    }

    #[tokio::test]
    async fn navigation_captures_its_source_after_consent_and_rechecks_before_dispatch() {
        use futures_util::{SinkExt, StreamExt};
        for replaced in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let endpoint = format!("http://{address}");
            let (context, accesses) = decision_context(true);
            let approved = accesses.clone();
            let server = tokio::spawn(async move {
                let tab = [
                    json!({"id":"page","title":"Same URL","url":"https://source.example/","type":"page","webSocketDebuggerUrl":format!("ws://{address}/devtools/page/page")}),
                ];
                let mut paths = Vec::new();
                for _ in 0..4 {
                    paths.extend(serve_inventory(&listener, &tab).await);
                }
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                assert_eq!(
                    approved.lock().unwrap().len(),
                    1,
                    "frame snapshot preceded site consent"
                );
                for expected in ["Page.enable", "Target.setAutoAttach"] {
                    let request: Value = serde_json::from_str(
                        socket.next().await.unwrap().unwrap().to_text().unwrap(),
                    )
                    .unwrap();
                    assert_eq!(request["method"], expected);
                    socket
                        .send(tokio_tungstenite::tungstenite::Message::Text(
                            json!({"id":request["id"],"result":{}}).to_string().into(),
                        ))
                        .await
                        .unwrap();
                }
                let mut methods = Vec::new();
                for loader in [
                    "current-after-consent",
                    if replaced {
                        "replacement-after-snapshot"
                    } else {
                        "current-after-consent"
                    },
                ] {
                    let request: Value = serde_json::from_str(
                        socket.next().await.unwrap().unwrap().to_text().unwrap(),
                    )
                    .unwrap();
                    assert_eq!(request["method"], "Page.getFrameTree");
                    methods.push(request["method"].as_str().unwrap().to_owned());
                    socket.send(tokio_tungstenite::tungstenite::Message::Text(json!({"id":request["id"],"result":{"frameTree":{"frame":{"id":"main","loaderId":loader}}}}).to_string().into())).await.unwrap();
                }
                if !replaced {
                    let request: Value = serde_json::from_str(
                        socket.next().await.unwrap().unwrap().to_text().unwrap(),
                    )
                    .unwrap();
                    assert_eq!(request["method"], "Page.navigate");
                    assert_eq!(request["params"]["url"], "https://destination.example/path");
                    methods.push("Page.navigate".into());
                    socket
                        .send(tokio_tungstenite::tungstenite::Message::Text(
                            json!({"id":request["id"],"result":{"frameId":"main"}})
                                .to_string()
                                .into(),
                        ))
                        .await
                        .unwrap();
                }
                if let Ok(Some(Ok(message))) =
                    tokio::time::timeout(Duration::from_millis(100), socket.next()).await
                {
                    assert!(
                        message.is_close(),
                        "navigation was dispatched or replayed after a source replacement: {message:?}"
                    );
                }
                (paths, methods)
            });
            let mut browsers = Browsers::default();
            browsers
                .configure(
                    vec![BrowserConnection {
                        id: "fixture".into(),
                        endpoint,
                    }],
                    Language::En,
                )
                .unwrap();
            let cursor = crate::cursor::Spec::default();
            let cancellation = CancellationToken::new();
            let bound = browsers
                .invoke(
                    Command::BrowserTab {
                        browser_id: "fixture".into(),
                        reference: BrowserTabReference::Existing("page".into()),
                    },
                    &context,
                    &cursor,
                    &cancellation,
                    Language::En,
                )
                .await
                .unwrap();
            let result = browsers
                .invoke(
                    Command::Action {
                        handle: serde_json::from_value(bound["handle"].clone()).unwrap(),
                        action: Action::Navigate {
                            url: "https://destination.example/path".into(),
                        },
                    },
                    &context,
                    &cursor,
                    &cancellation,
                    Language::En,
                )
                .await;
            if replaced {
                assert!(
                    matches!(result,Err(ToolError::Failed(message)) if message == "document changed before navigation dispatch; retry the operation")
                );
            } else {
                assert!(result.is_ok(), "{result:?}");
            }
            let (paths, methods) = server.await.unwrap();
            assert_eq!(paths.len(), 8);
            assert_eq!(methods.len(), if replaced { 2 } else { 3 });
        }
    }

    #[tokio::test]
    async fn browser_selection_uses_a_prospective_url_or_explicit_id_without_navigating() {
        for options in [
            BrowserOptions {
                id: None,
                url: Some("example.com/new-page".into()),
                extension_instance_id: None,
            },
            BrowserOptions {
                id: None,
                url: Some("ftp://example.com".into()),
                extension_instance_id: None,
            },
            BrowserOptions {
                id: Some("fixture".into()),
                url: Some("ftp://example.com".into()),
                extension_instance_id: None,
            },
            BrowserOptions {
                id: Some("fixture".into()),
                url: Some(String::new()),
                extension_instance_id: None,
            },
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move { serve_inventory(&listener, &[]).await });
            let mut browsers = Browsers::default();
            browsers
                .configure(
                    vec![BrowserConnection {
                        id: "fixture".into(),
                        endpoint,
                    }],
                    Language::En,
                )
                .unwrap();
            let value = browsers
                .invoke(
                    Command::GetBrowser { options },
                    &crate::InvocationContext::new("fixture", "selection-turn"),
                    &crate::cursor::Spec::default(),
                    &CancellationToken::new(),
                    Language::En,
                )
                .await
                .unwrap();
            assert_eq!(value, json!({"id":"fixture"}));
            assert_eq!(server.await.unwrap(), ["/json/version", "/json/list"]);
            assert!(browsers.targets.is_empty());
        }
    }

    #[tokio::test]
    async fn browser_tab_binding_and_metadata_do_not_observe_or_attach_the_page() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let before = [json!({"id":"page","title":"Before","url":"about:blank","type":"page"})];
            let after = [
                json!({"id":"page","title":"After","url":"https://example.com/current","type":"page"}),
            ];
            let mut paths = serve_inventory(&listener, &before).await;
            paths.extend(serve_inventory(&listener, &after).await);
            paths
        });
        let mut browsers = Browsers::default();
        browsers
            .configure(
                vec![BrowserConnection {
                    id: "fixture".into(),
                    endpoint,
                }],
                Language::En,
            )
            .unwrap();
        let cursor = crate::cursor::Spec::default();
        let cancellation = CancellationToken::new();
        let bound = browsers
            .invoke(
                Command::BrowserTab {
                    browser_id: "fixture".into(),
                    reference: BrowserTabReference::Existing("page".into()),
                },
                &crate::InvocationContext::new("fixture", "turn"),
                &cursor,
                &cancellation,
                Language::En,
            )
            .await
            .unwrap();
        assert_eq!(bound["id"], "fixture:page");
        assert!(bound.get("state").is_none());
        assert!(bound.get("image").is_none());
        let metadata = browsers
            .invoke(
                Command::TabMetadata {
                    handle: serde_json::from_value(bound["handle"].clone()).unwrap(),
                },
                &crate::InvocationContext::new("fixture", "turn"),
                &cursor,
                &cancellation,
                Language::En,
            )
            .await
            .unwrap();
        assert_eq!(
            metadata,
            json!({"title":"After","url":"https://example.com/current"})
        );
        assert_eq!(
            server.await.unwrap(),
            ["/json/version", "/json/list", "/json/version", "/json/list"]
        );
    }

    #[tokio::test]
    async fn lazy_browser_read_bounds_a_stalled_websocket_handshake() {
        for cancel_at_handshake in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let cancellation = CancellationToken::new();
            let cancelled = cancellation.clone();
            let settle = CancellationToken::new();
            let settled = settle.clone();
            let server = tokio::spawn(async move {
                let tabs = [
                    json!({"id":"page","title":"Fixture","url":"https://example.com/","type":"page","webSocketDebuggerUrl":format!("ws://{address}/devtools/page/page")}),
                ];
                // Binding, pre/post-consent inventory, and the read's own
                // document proof precede its first lazy debugger connection.
                for _ in 0..4 {
                    serve_inventory(&listener, &tabs).await;
                }
                let (stream, _) = listener.accept().await.unwrap();
                let mut stream = BufReader::new(stream);
                let mut line = String::new();
                stream.read_line(&mut line).await.unwrap();
                assert!(line.starts_with("GET /devtools/page/page "));
                if cancel_at_handshake {
                    cancelled.cancel();
                }
                // Keep the accepted socket open without completing its
                // upgrade. A plain connection timeout would take ten seconds.
                settled.cancelled().await;
            });
            let mut browsers = Browsers::default();
            browsers
                .configure(
                    vec![BrowserConnection {
                        id: "fixture".into(),
                        endpoint: format!("http://{address}"),
                    }],
                    Language::En,
                )
                .unwrap();
            let cursor = crate::cursor::Spec::default();
            let (context, _) = decision_context(true);
            let bound = browsers
                .invoke(
                    Command::BrowserTab {
                        browser_id: "fixture".into(),
                        reference: BrowserTabReference::Existing("page".into()),
                    },
                    &context,
                    &cursor,
                    &cancellation,
                    Language::En,
                )
                .await
                .unwrap();
            let began = tokio::time::Instant::now();
            let result = tokio::time::timeout(
                Duration::from_secs(2),
                browsers.invoke(
                    Command::BrowserRead {
                        handle: serde_json::from_value(bound["handle"].clone()).unwrap(),
                        locator: LocatorPlan {
                            selector: "button".into(),
                        },
                        operation: BrowserReadOperation::InnerText,
                        options: BrowserReadOptions {
                            timeout_ms: Some(if cancel_at_handshake { 3000 } else { 200 }),
                        },
                    },
                    &context,
                    &cursor,
                    &cancellation,
                    Language::En,
                ),
            )
            .await
            .expect("the read escaped its deadline or cancellation");
            let error = result.unwrap_err().to_string();
            if cancel_at_handshake {
                assert!(error.to_lowercase().contains("cancel"), "{error}");
            } else {
                assert!(error.contains("deadline"), "{error}");
            }
            assert!(began.elapsed() < Duration::from_secs(1));
            settle.cancel();
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn cancellation_during_browser_connect_does_not_create_a_target() {
        use tokio_tungstenite::tungstenite::handshake::server::{
            Callback, ErrorResponse, Request, Response,
        };

        struct CancelAtHandshake(CancellationToken);

        impl Callback for CancelAtHandshake {
            fn on_request(
                self,
                _: &Request,
                response: Response,
            ) -> std::result::Result<Response, ErrorResponse> {
                self.0.cancel();
                Ok(response)
            }
        }

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let cancellation = CancellationToken::new();
        let cancelled = cancellation.clone();
        let server = tokio::spawn(async move {
            let paths = serve_inventory(&listener, &[]).await;
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket =
                tokio_tungstenite::accept_hdr_async(stream, CancelAtHandshake(cancelled))
                    .await
                    .unwrap();
            let mut bytes = [0; 1024];
            let count = socket.get_mut().read(&mut bytes).await.unwrap();
            assert_eq!(count, 0, "a cancelled caller dispatched a CDP request");
            paths
        });
        let mut browsers = Browsers::default();
        browsers
            .configure(
                vec![BrowserConnection {
                    id: "fixture".into(),
                    endpoint,
                }],
                Language::En,
            )
            .unwrap();
        let result = browsers
            .invoke(
                Command::CreateBrowserTab {
                    browser_id: "fixture".into(),
                    url: Some("example.com/new-page".into()),
                    options: CreateTabOptions {
                        visible: None,
                        session_name: None,
                    },
                },
                &decision_context(true).0,
                &crate::cursor::Spec::default(),
                &cancellation,
                Language::En,
            )
            .await;
        assert!(
            matches!(result, Err(ToolError::Failed(message)) if message == "Computer Use cancelled before input dispatch")
        );
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), server)
                .await
                .unwrap()
                .unwrap(),
            ["/json/version", "/json/list"]
        );
        assert!(browsers.targets.is_empty());
    }

    #[test]
    fn browser_selection_and_creation_normalize_prospective_urls() {
        for (input, expected) in [
            ("example.com/path?a=1", "https://example.com/path?a=1"),
            ("http://127.0.0.1:8080/form", "http://127.0.0.1:8080/form"),
            ("about:blank", "about:blank"),
        ] {
            assert_eq!(normalized_url(input).unwrap(), expected);
        }
        for input in [
            "",
            "file:///tmp/fixture",
            "javascript:alert(1)",
            "ftp://example.com",
        ] {
            assert!(
                validate_url(&convenience_url(input)).is_err(),
                "accepted {input:?}"
            );
        }
    }

    #[tokio::test]
    async fn unconfirmed_temporary_tab_close_keeps_ownership_without_replaying() {
        use futures_util::{SinkExt, StreamExt};
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let provider = BrowserConnection {
            id: "fixture".into(),
            endpoint: format!("http://{address}"),
        };
        let generation = format!("ws://{address}/devtools/browser/fixture");
        let identity = BrowserIdentity::new(&provider, &generation)
            .unwrap()
            .tab("owned");
        let server = tokio::spawn(async move {
            let tabs =
                [json!({"id":"owned","title":"Owned fixture","url":"about:blank","type":"page"})];
            serve_inventory(&listener, &tabs).await;
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let request: Value =
                serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            assert_eq!(request["method"], "Target.closeTarget");
            assert_eq!(request["params"], json!({"targetId":"owned"}));
            socket
                .send(tokio_tungstenite::tungstenite::Message::Text(
                    json!({"id":request["id"],"result":{"success":true}})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            // A close acknowledgement is not proof that the target disappeared.
            serve_inventory(&listener, &tabs).await;
            serve_inventory(&listener, &tabs).await;
            request
        });
        let owner = uuid::Uuid::new_v4();
        let other = uuid::Uuid::new_v4();
        let mut host = Host::default();
        host.created(identity.clone(), owner, "turn", provider, generation)
            .unwrap();
        let first = host.finish(owner, Some("turn")).await;
        assert!(
            matches!(first, Err(ToolError::CleanupUnconfirmed(message)) if message == "the temporary tab is still present after its close request")
        );
        assert!(!host.visible(&identity, other));
        assert!(
            matches!(host.use_tab(&identity, owner, "later"), Err(ToolError::CleanupUnconfirmed(message)) if message == "the tab's previous close has not settled")
        );
        let second = host.finish(owner, Some("turn")).await;
        assert!(
            matches!(second, Err(ToolError::CleanupUnconfirmed(message)) if message == "a previous tab close has not settled; close was not replayed")
        );
        assert_eq!(server.await.unwrap()["method"], "Target.closeTarget");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires MAKA_CUA_TEST_CHROME; starts an isolated temporary headless profile"]
    async fn independent_sessions_hide_owned_temporary_tabs_and_cleanup_only_the_matching_turn() {
        use std::process::Stdio;
        use std::sync::Arc;
        use tokio::sync::Mutex;

        async fn call(
            session: &mut crate::Session,
            owner: &str,
            turn: &str,
            command: Value,
        ) -> Result<Value, ToolError> {
            session
                .invoke(
                    serde_json::from_value(command).unwrap(),
                    &crate::InvocationContext::new(owner, turn),
                    &CancellationToken::new(),
                    Language::En,
                )
                .await
        }

        async fn cursor_count(page: &mut Cdp) -> u64 {
            page.request("Runtime.evaluate", json!({
                "expression":"Array.from(document.querySelectorAll('[popover][aria-hidden=true]')).filter(host => host.isConnected && host.matches(':popover-open') && host.style.display !== 'none').length",
                "returnByValue":true,
            })).await.unwrap()["result"]["value"].as_u64().unwrap()
        }

        async fn cursor_metadata(page: &mut Cdp) -> Value {
            let tree = page.request("Page.getFrameTree", json!({})).await.unwrap();
            let world = page
                .request(
                    "Page.createIsolatedWorld",
                    json!({
                        "frameId":tree["frameTree"]["frame"]["id"],
                        "worldName":"maka-cua-cursor",
                        "grantUniveralAccess":false,
                    }),
                )
                .await
                .unwrap();
            let observed = page.request("Runtime.evaluate", json!({
                "contextId":world["executionContextId"],
                "expression":"Object.fromEntries(Array.from(globalThis.__makaCursorRegistry ?? [], ([id, entry]) => [id, {ownerEpoch:entry.ownerEpoch,retired:entry.retired === true,connected:entry.host.isConnected,point:entry.point}]))",
                "returnByValue":true,
            })).await.unwrap();
            assert!(observed.get("exceptionDetails").is_none(), "{observed}");
            observed["result"]["value"].clone()
        }

        async fn bind_cursor(
            session: &mut crate::Session,
            actor: &str,
            provider: &str,
            tab: &str,
            point: [u32; 2],
        ) -> (String, Value) {
            let settings = call(
                session,
                actor,
                "cursor",
                json!({"method":"configureCursor","options":{"enabled":true,"reducedMotion":true}}),
            )
            .await
            .unwrap();
            let bound = call(session, actor, "cursor", json!({"method":"browserTab","browserId":provider,"reference":{"kind":"existing","id":tab}})).await.unwrap();
            call(session, actor, "cursor", json!({"method":"observe","handle":bound["handle"],"kind":"both","options":{"emit":false}})).await.unwrap();
            let moved = call(session, actor, "cursor", json!({"method":"action","handle":bound["handle"],"action":{"kind":"moveCursor","target":point}})).await.unwrap();
            assert_eq!(moved["visible"], true);
            assert_eq!(
                moved["requestedPosition"][0].as_f64(),
                Some(f64::from(point[0]))
            );
            assert_eq!(
                moved["requestedPosition"][1].as_f64(),
                Some(f64::from(point[1]))
            );
            (
                settings["settings"]["id"].as_str().unwrap().to_owned(),
                bound["handle"].clone(),
            )
        }

        async fn cursor_state(session: &mut crate::Session, actor: &str, point: [u32; 2]) {
            let state = call(
                session,
                actor,
                "cursor",
                json!({"method":"cursorState","options":{}}),
            )
            .await
            .unwrap();
            assert!(
                state["browsers"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|tab| tab["state"]["visible"] == true
                        && tab["state"]["requestedPosition"][0].as_f64()
                            == Some(f64::from(point[0]))
                        && tab["state"]["requestedPosition"][1].as_f64()
                            == Some(f64::from(point[1]))),
                "{state}"
            );
        }

        let executable = std::env::var("MAKA_CUA_TEST_CHROME").unwrap();
        let profile = tempfile::tempdir().unwrap();
        let mut chrome = tokio::process::Command::new(executable)
            .args([
                "--headless=new",
                "--no-first-run",
                "--no-default-browser-check",
                "--remote-debugging-port=0",
                "--disable-gpu",
                "--password-store=basic",
            ])
            .arg(format!("--user-data-dir={}", profile.path().display()))
            .arg("about:blank")
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
                    return reqwest::Url::parse(url).unwrap().port().unwrap();
                }
            }
            panic!("isolated Chrome did not expose a test endpoint");
        })
        .await
        .unwrap();
        let logging =
            tokio::spawn(async move { while lines.next_line().await.ok().flatten().is_some() {} });
        let driver = Arc::new(Mutex::new(crate::Driver::default()));
        let owner = crate::SessionOwner::new(driver.clone());
        let mut a = owner.new_epoch().unwrap();
        let mut b = crate::Session::new(driver.clone());
        for (session, id, hostname) in [
            (&mut a, "owner", "127.0.0.1"),
            (&mut b, "observer", "localhost"),
        ] {
            session
                .configure(
                    maka_capabilities::computer::Desktop::Local,
                    vec![BrowserConnection {
                        id: id.into(),
                        endpoint: format!("http://{hostname}:{endpoint}"),
                    }],
                    Language::En,
                )
                .unwrap();
        }
        let user_tabs = call(
            &mut b,
            "b",
            "first",
            json!({"method":"listTabs","options":{}}),
        )
        .await
        .unwrap();
        assert_eq!(user_tabs.as_array().unwrap().len(), 1);
        let user_id = user_tabs[0]["id"].as_str().unwrap().to_owned();
        let created = call(
            &mut a,
            "a",
            "first",
            json!({"method":"browserTab","browserId":"owner","reference":{"kind":"new"}}),
        )
        .await
        .unwrap();
        assert!(created.get("state").is_none());
        let target = created["id"]
            .as_str()
            .unwrap()
            .strip_prefix("owner:")
            .unwrap()
            .to_owned();
        let foreign = call(
            &mut b,
            "b",
            "first",
            json!({"method":"getTab","reference":target,"options":{"browser":"observer"}}),
        )
        .await;
        assert!(
            matches!(foreign, Err(ToolError::Failed(message)) if message == "tab_owned_by_another_session")
        );
        let hidden = call(
            &mut b,
            "b",
            "first",
            json!({"method":"listTabs","options":{}}),
        )
        .await
        .unwrap();
        assert_eq!(hidden, user_tabs);
        a.close_native().await.unwrap();
        let still_hidden = call(
            &mut b,
            "b",
            "first",
            json!({"method":"listTabs","options":{}}),
        )
        .await
        .unwrap();
        assert_eq!(
            still_hidden, user_tabs,
            "retirement must not close or expose the owner's tab"
        );
        a = owner.new_epoch().unwrap();
        a.configure(
            maka_capabilities::computer::Desktop::Local,
            vec![BrowserConnection {
                id: "owner".into(),
                endpoint: format!("http://127.0.0.1:{endpoint}"),
            }],
            Language::En,
        )
        .unwrap();
        let old_handle = call(
            &mut a,
            "a",
            "first",
            json!({"method":"tabMetadata","handle":created["handle"]}),
        )
        .await;
        assert!(
            matches!(old_handle, Err(ToolError::Failed(message)) if message == "stale_tab: bind it again"),
            "a new epoch must not inherit the retired cache's handle"
        );
        let owned = call(
            &mut a,
            "a",
            "first",
            json!({"method":"listTabs","options":{}}),
        )
        .await
        .unwrap();
        assert_eq!(owned.as_array().unwrap().len(), 2);
        assert!(
            owned
                .as_array()
                .unwrap()
                .iter()
                .any(|tab| tab["id"] == created["id"]),
            "the logical owner must retain its physical tab across epochs"
        );
        let foreign = call(
            &mut b,
            "b",
            "first",
            json!({"method":"getTab","reference":target,"options":{"browser":"observer"}}),
        )
        .await;
        assert!(
            matches!(foreign, Err(ToolError::Failed(message)) if message == "tab_owned_by_another_session")
        );
        call(
            &mut a,
            "a",
            "first",
            json!({"method":"getTab","reference":target,"options":{"browser":"owner"}}),
        )
        .await
        .unwrap();
        let later = call(
            &mut a,
            "a",
            "later",
            json!({"method":"createBrowserTab","browserId":"owner","url":"about:blank","options":{}}),
        )
        .await
        .unwrap();
        a.finish_turn("a", "first", Language::En).await.unwrap();
        let remaining = call(
            &mut a,
            "a",
            "later",
            json!({"method":"listTabs","options":{}}),
        )
        .await
        .unwrap();
        assert_eq!(remaining.as_array().unwrap().len(), 2);
        assert!(
            remaining
                .as_array()
                .unwrap()
                .iter()
                .any(|tab| tab["id"] == later["id"])
        );
        assert!(
            !remaining
                .as_array()
                .unwrap()
                .iter()
                .any(|tab| tab["id"] == created["id"])
        );

        // The convenience helper first owns a fresh blank tab. Refusing its
        // destination must leave that blank owned until canonical turn cleanup.
        let destination = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let destination_url = format!("http://{}/denied", destination.local_addr().unwrap());
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = requests.clone();
        let destination_server = tokio::spawn(async move {
            let mut stopped = stopped;
            loop {
                tokio::select! {
                    _ = &mut stopped => break,
                    accepted = destination.accept() => {
                        let (stream,_) = accepted.unwrap();
                        let mut stream = BufReader::new(stream);
                        let mut line = String::new();
                        let read = tokio::time::timeout(Duration::from_secs(2),async {
                            loop {
                                line.clear();
                                if stream.read_line(&mut line).await? == 0 || line == "\r\n" {break;}
                            }
                            Ok::<(),std::io::Error>(())
                        }).await;
                        if !matches!(read,Ok(Ok(()))) {continue;}
                        counted.fetch_add(1,std::sync::atomic::Ordering::SeqCst);
                        let body = "<!doctype html><title>Owned fixture</title><input id='fixture'>";
                        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                        let _ = stream.write_all(response.as_bytes()).await;
                    }
                }
            }
        });
        let accesses = Arc::new(std::sync::Mutex::new(Vec::new()));
        for (url, host) in [
            (destination_url.clone(), false),
            (destination_url.clone(), true),
            ("ftp://example.com/unsupported".into(), true),
            (String::new(), true),
        ] {
            let mut context = crate::InvocationContext::new("a", "denied");
            if host {
                context = context.with_browser_authorization(Arc::new(Decision {
                    allow: false,
                    accesses: accesses.clone(),
                }));
            }
            let denied = a.invoke(serde_json::from_value(json!({"method":"createBrowserTab","browserId":"owner","url":url,"options":{}})).unwrap(),&context,&CancellationToken::new(),Language::En).await;
            assert!(
                matches!(denied, Err(ToolError::Failed(_))),
                "denied or invalid destination unexpectedly succeeded"
            );
        }
        assert_eq!(
            accesses.lock().unwrap().len(),
            1,
            "invalid URLs reached the Host origin callback"
        );
        let owned_blanks = call(
            &mut a,
            "a",
            "later",
            json!({"method":"listTabs","options":{}}),
        )
        .await
        .unwrap();
        assert_eq!(owned_blanks.as_array().unwrap().len(), 6);
        assert!(
            owned_blanks
                .as_array()
                .unwrap()
                .iter()
                .all(|tab| tab["url"] == "about:blank")
        );
        let still_hidden = call(
            &mut b,
            "b",
            "later",
            json!({"method":"listTabs","options":{}}),
        )
        .await
        .unwrap();
        assert_eq!(still_hidden, user_tabs);
        assert_eq!(
            requests.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "a refused destination received network traffic"
        );
        a.finish_turn("a", "denied", Language::En).await.unwrap();
        let after_denial_cleanup = call(
            &mut a,
            "a",
            "later",
            json!({"method":"listTabs","options":{}}),
        )
        .await
        .unwrap();
        assert_eq!(after_denial_cleanup.as_array().unwrap().len(), 2);

        // Prepare an ordinary page directly as trusted test-fixture setup. The
        // public Session can list/bind its metadata without site authority, but
        // cannot read the page or send input to it.
        let provider = BrowserConnection {
            id: "fixture-setup".into(),
            endpoint: format!("http://127.0.0.1:{endpoint}"),
        };
        let (generation, _) = inventory(&provider).await.unwrap();
        let mut fixture_browser = Cdp::connect(&generation, &provider).await.unwrap();
        let fixture_page = fixture_browser
            .request(
                "Target.createTarget",
                json!({"url":destination_url,"background":true}),
            )
            .await
            .unwrap()["targetId"]
            .as_str()
            .unwrap()
            .to_owned();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let (_, tabs) = inventory(&provider).await.unwrap();
                if tabs
                    .iter()
                    .any(|tab| tab.id == fixture_page && tab.url == destination_url)
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let read = call(
            &mut b,
            "b",
            "later",
            json!({"method":"getTab","reference":fixture_page,"options":{"browser":"observer"}}),
        )
        .await;
        assert!(
            matches!(read,Err(ToolError::Failed(message)) if message == "Browser site access requires Host authorization")
        );
        let metadata_bound = call(&mut b,"b","later",json!({"method":"browserTab","browserId":"observer","reference":{"kind":"existing","id":fixture_page}})).await.unwrap();
        let metadata = call(
            &mut b,
            "b",
            "later",
            json!({"method":"tabMetadata","handle":metadata_bound["handle"]}),
        )
        .await
        .unwrap();
        assert_eq!(metadata["url"], destination_url);
        let input = call(&mut b,"b","later",json!({"method":"action","handle":metadata_bound["handle"],"action":{"kind":"typeText","text":"must not be entered"}})).await;
        assert!(
            matches!(input,Err(ToolError::Failed(message)) if message == "Browser site access requires Host authorization")
        );
        fixture_browser
            .request("Target.closeTarget", json!({"targetId":fixture_page}))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let (_, tabs) = inventory(&provider).await.unwrap();
                if !tabs.iter().any(|tab| tab.id == fixture_page) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let _ = stop.send(());
        destination_server.await.unwrap();
        let user_target = user_id.strip_prefix("observer:").unwrap();
        let (_, physical) = inventory(&provider).await.unwrap();
        let user = physical.iter().find(|tab| tab.id == user_target).unwrap();
        let mut cursor_page = Cdp::connect(user.websocket.as_ref().unwrap(), &provider)
            .await
            .unwrap();
        let (old_cursor, old_user_handle) =
            bind_cursor(&mut a, "a", "owner", user_target, [15, 20]).await;
        let mut newer = owner.new_epoch().unwrap();
        newer
            .configure(
                maka_capabilities::computer::Desktop::Local,
                vec![BrowserConnection {
                    id: "owner".into(),
                    endpoint: format!("http://127.0.0.1:{endpoint}"),
                }],
                Language::En,
            )
            .unwrap();
        let disabled = call(
            &mut newer,
            "a",
            "cursor",
            json!({"method":"configureCursor","options":{"enabled":false}}),
        )
        .await
        .unwrap();
        assert_eq!(disabled["settings"]["id"], old_cursor);
        assert_eq!(disabled["settings"]["enabled"], false);
        call(&mut a, "a", "cursor", json!({"method":"action","handle":old_user_handle,"action":{"kind":"moveCursor","target":[65,70]}})).await.unwrap();
        assert_eq!(
            cursor_count(&mut cursor_page).await,
            0,
            "a new epoch's disabled configuration must survive an old render before the new epoch binds the tab"
        );
        let (new_cursor, _) = bind_cursor(&mut newer, "a", "owner", user_target, [25, 30]).await;
        assert_eq!(
            new_cursor, old_cursor,
            "epochs share one logical cursor identity"
        );
        let (foreign_cursor, _) = bind_cursor(&mut b, "b", "observer", user_target, [45, 50]).await;
        assert_ne!(foreign_cursor, old_cursor);
        assert_eq!(
            cursor_count(&mut cursor_page).await,
            2,
            "one marker per logical owner"
        );
        call(&mut a, "a", "cursor", json!({"method":"action","handle":old_user_handle,"action":{"kind":"moveCursor","target":[65,70]}})).await.unwrap();
        cursor_state(&mut newer, "a", [25, 30]).await;
        cursor_state(&mut b, "b", [45, 50]).await;
        assert_eq!(
            cursor_count(&mut cursor_page).await,
            2,
            "a late old-epoch render must not reclaim the newer marker"
        );
        newer.close_native().await.unwrap();
        call(&mut a, "a", "cursor", json!({"method":"action","handle":old_user_handle,"action":{"kind":"moveCursor","target":[75,80]}})).await.unwrap();
        cursor_state(&mut b, "b", [45, 50]).await;
        assert_eq!(
            cursor_count(&mut cursor_page).await,
            1,
            "an old late render must not resurrect a removed newer epoch"
        );
        let metadata = cursor_metadata(&mut cursor_page).await;
        assert_eq!(metadata[old_cursor.as_str()]["retired"], true, "{metadata}");
        assert_eq!(
            metadata[old_cursor.as_str()]["connected"],
            false,
            "{metadata}"
        );

        let mut newest = owner.new_epoch().unwrap();
        newest
            .configure(
                maka_capabilities::computer::Desktop::Local,
                vec![
                    BrowserConnection {
                        id: "owner".into(),
                        endpoint: format!("http://127.0.0.1:{endpoint}"),
                    },
                    BrowserConnection {
                        id: "unused-offline".into(),
                        endpoint: "http://127.0.0.1:9".into(),
                    },
                ],
                Language::En,
            )
            .unwrap();
        let (latest_cursor, latest_user_handle) =
            bind_cursor(&mut newest, "a", "owner", user_target, [35, 40]).await;
        assert_eq!(latest_cursor, old_cursor);
        assert_eq!(
            cursor_count(&mut cursor_page).await,
            2,
            "a newer epoch reuses the retired logical marker"
        );
        newest
            .finish_turn("a", "cursor", Language::En)
            .await
            .unwrap();
        assert_eq!(
            cursor_count(&mut cursor_page).await,
            1,
            "ordinary turn cleanup hides the current cursor"
        );
        let metadata = cursor_metadata(&mut cursor_page).await;
        assert_eq!(
            metadata[old_cursor.as_str()]["retired"],
            false,
            "ordinary turn cleanup must permit the next turn in the same epoch: {metadata}"
        );
        assert_eq!(
            metadata[old_cursor.as_str()]["connected"],
            false,
            "{metadata}"
        );
        call(&mut newest, "a", "cursor-next", json!({"method":"observe","handle":latest_user_handle,"kind":"both","options":{"emit":false}})).await.unwrap();
        call(&mut newest, "a", "cursor-next", json!({"method":"action","handle":latest_user_handle,"action":{"kind":"moveCursor","target":[35,40]}})).await.unwrap();
        cursor_state(&mut newest, "a", [35, 40]).await;
        cursor_state(&mut b, "b", [45, 50]).await;
        assert_eq!(
            cursor_count(&mut cursor_page).await,
            2,
            "the next turn restores its cursor without a VM reset"
        );
        a.finish_turn("a", "cursor", Language::En).await.unwrap();
        cursor_state(&mut newest, "a", [35, 40]).await;
        cursor_state(&mut b, "b", [45, 50]).await;
        assert_eq!(
            cursor_count(&mut cursor_page).await,
            2,
            "old turn cleanup must not remove the newest cursor"
        );
        a.close_native().await.unwrap();
        cursor_state(&mut newest, "a", [35, 40]).await;
        cursor_state(&mut b, "b", [45, 50]).await;
        assert_eq!(
            cursor_count(&mut cursor_page).await,
            2,
            "old native cleanup must not remove the newest cursor"
        );
        newest.close_native().await.unwrap();
        cursor_state(&mut b, "b", [45, 50]).await;
        assert_eq!(
            cursor_count(&mut cursor_page).await,
            1,
            "all A epochs settled; only the other owner is visible"
        );
        let metadata = cursor_metadata(&mut cursor_page).await;
        assert_eq!(metadata[old_cursor.as_str()]["retired"], true, "{metadata}");
        assert_eq!(
            metadata[old_cursor.as_str()]["connected"],
            false,
            "{metadata}"
        );
        assert!(
            metadata.get(foreign_cursor.as_str()).is_some(),
            "{metadata}"
        );
        let before_final = call(
            &mut b,
            "b",
            "later",
            json!({"method":"listTabs","options":{}}),
        )
        .await
        .unwrap();
        assert_eq!(
            before_final, user_tabs,
            "retiring the final epoch must preserve ownership until owner close"
        );
        let retained = later["id"]
            .as_str()
            .unwrap()
            .strip_prefix("owner:")
            .unwrap();
        let (_, physical) = inventory(&provider).await.unwrap();
        assert!(
            physical.iter().any(|tab| tab.id == retained),
            "epoch retirement must leave the owned physical tab open"
        );
        owner.close().await.unwrap();
        let metadata = cursor_metadata(&mut cursor_page).await;
        assert!(
            metadata.get(old_cursor.as_str()).is_none(),
            "logical owner finalization must release the renderer metadata: {metadata}"
        );
        assert!(
            metadata.get(foreign_cursor.as_str()).is_some(),
            "other owner metadata must remain: {metadata}"
        );
        cursor_state(&mut b, "b", [45, 50]).await;
        assert_eq!(
            cursor_count(&mut cursor_page).await,
            1,
            "logical owner cleanup preserves another owner's marker"
        );
        let (_, physical) = inventory(&provider).await.unwrap();
        assert!(
            !physical.iter().any(|tab| tab.id == retained),
            "logical owner close must actually close its temporary tab"
        );
        assert!(
            physical
                .iter()
                .any(|tab| tab.id == user_id.strip_prefix("observer:").unwrap()),
            "logical cleanup must preserve the fixture's original user tab"
        );
        let preserved = call(
            &mut b,
            "b",
            "later",
            json!({"method":"listTabs","options":{}}),
        )
        .await
        .unwrap();
        assert_eq!(preserved.as_array().unwrap().len(), 1);
        assert_eq!(preserved[0]["id"], user_id);
        b.close().await.unwrap();
        assert_eq!(cursor_count(&mut cursor_page).await, 0);
        assert!(
            cursor_metadata(&mut cursor_page)
                .await
                .as_object()
                .unwrap()
                .is_empty(),
            "both logical owners released their renderer metadata"
        );
        driver.lock().await.close().await.unwrap();
        chrome.kill().await.unwrap();
        let _ = chrome.wait().await;
        logging.abort();
    }
}
