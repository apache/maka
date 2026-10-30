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
use cua_driver_core::browser::JsonStringLiteral;
use maka_agent_facts::language::Language;
use maka_agent_facts::tools::ToolError;
use maka_capabilities::computer::BrowserConnection;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashMap, time::Duration};
use tokio_util::sync::CancellationToken;
mod ax;
mod capability;
mod clipboard_bridge;
mod context;
mod cursor;
mod dialogs;
mod downloads;
mod extension;
mod filechooser;
mod frames;
mod origin;
mod owned_input;
mod ownership;
pub(crate) mod provider;
use provider::Provider;
mod playwright;
mod screenshot;
mod surface;
pub(crate) use ownership::Host;
use ownership::{BrowserIdentity, TabIdentity};

#[derive(Clone, Debug)]
struct DomElement {
    backend: u64,
    frame: Option<frames::Frame>,
}

#[derive(Clone, Debug)]
struct DomCuaElement {
    element: DomElement,
    used: Vec<frames::Frame>,
    clip: [f64; 4],
}

#[derive(Clone, Debug)]
enum ElementRef {
    Dom(DomElement),
    DomCua(DomCuaElement),
    Dialog(dialogs::DialogRef),
}

use crate::desktop::validate_connections;

pub(crate) struct Browsers {
    driver: std::sync::Arc<tokio::sync::Mutex<crate::Driver>>,
    owner: uuid::Uuid,
    epoch: crate::desktop::NativeEpochId,
    cursor_spec: Option<std::sync::Arc<std::sync::Mutex<crate::cursor::Spec>>>,
    connections: Vec<BrowserConnection>,
    extension_providers: Vec<Provider>,
    extension_errors: Vec<String>,
    clipboards: HashMap<String, clipboard_bridge::Backend>,
    targets: HashMap<String, Tab>,
}
// Borrow the actual invocation only for this call stack. No grant or
// successful permission result is stored in a tab or a metadata cache.
#[derive(Clone, Copy)]
pub(crate) struct BrowserCall<'a> {
    invocation: &'a crate::InvocationContext<'a>,
    cancellation: &'a CancellationToken,
    language: Language,
}
impl<'a> BrowserCall<'a> {
    pub(crate) fn new(
        invocation: &'a crate::InvocationContext<'a>,
        cancellation: &'a CancellationToken,
        language: Language,
    ) -> Self {
        Self {
            invocation,
            cancellation,
            language,
        }
    }
}

#[derive(Clone, Deserialize)]
struct TabInfo {
    id: String,
    #[serde(deserialize_with = "JsonStringLiteral::deserialize_raw")]
    title: JsonStringLiteral,
    url: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "webSocketDebuggerUrl")]
    websocket: Option<String>,
    #[serde(skip)]
    extension: Option<cua_driver_core::browser::ExtensionTabInfo>,
}
struct TabSource {
    provider: Provider,
    generation: String,
    info: TabInfo,
}
enum InitialState {
    Observe,
    Deferred,
}
struct Tab {
    page_assets: capability::Inventories,
    provider: Provider,
    generation: String,
    info: TabInfo,
    socket: Option<Cdp>,
    socket_prepared: bool,
    origin_proof: Option<origin::DocumentOrigin>,
    navigation_admission: Option<origin::NavigationAdmission>,
    extension_claim: Option<cua_driver_core::browser::ExtensionPhysicalClaim>,
    extension_wire: Option<cua_driver_core::browser::ExtensionWireContext>,
    extension_host_operation: Option<cua_driver_core::browser::ExtensionHostOperation>,
    // Actual acknowledged provenance/order, never a metadata-derived grant.
    extension_acquisition: Option<extension::Acquisition>,
    fixed_presentation: Option<extension::FixedPresentationScope>,
    frame: Option<String>,
    refs: HashMap<u64, ElementRef>,
    frames: frames::Frames,
    ax: ax::Projection,
    previous: Option<String>,
    navigation: Option<Navigation>,
    cursor_world: Option<(String, u64)>,
    cursor_epoch: crate::desktop::NativeEpochId,
    cursor_owner: uuid::Uuid,
    cursor_host: std::sync::Arc<tokio::sync::Mutex<Host>>,
    cursor_spec: Option<std::sync::Arc<std::sync::Mutex<crate::cursor::Spec>>>,
    last_turn: String,
    dialogs: Option<dialogs::Controller>,
    downloads: Option<downloads::Controller>,
    filechoosers: Option<filechooser::Store>,
    dialog_host: Option<std::sync::Arc<dyn crate::BrowserHostEffects>>,
    clipboard: Option<clipboard_bridge::Bridge>,
    clipboard_store: std::sync::Arc<crate::browser_clipboard::Store>,
    clipboard_authorization: Option<std::sync::Arc<dyn crate::BrowserAttachmentAuthorization>>,
    attachment_settlement: Option<std::sync::Arc<dyn crate::OperationSettlement>>,
}
// A read spends one mechanical-I/O budget across its lazy authorization and
// selector work. Host consent waits are deliberately outside these steps.
struct ReadBudget {
    remaining: Duration,
}
impl ReadBudget {
    fn new(options: &BrowserReadOptions) -> Self {
        Self {
            remaining: Duration::from_millis(options.timeout_ms.unwrap_or(3000).min(3000)),
        }
    }
}
#[derive(Clone, Copy)]
enum ReadEffect {
    Observation,
    ExtensionPreparation,
}
impl ReadEffect {
    fn interrupted(self, message: &str) -> ToolError {
        match self {
            Self::Observation => failed(message),
            Self::ExtensionPreparation => unknown(format!(
                "{message}; driver preparation may still be pending"
            )),
        }
    }
    fn read_failure(self, error: ToolError) -> ToolError {
        match (self, error) {
            (Self::Observation, ToolError::OutcomeUnknown(message)) => failed(message),
            (_, error) => error,
        }
    }
    fn uncertain(self, error: &ToolError) -> bool {
        matches!(self, Self::ExtensionPreparation)
            && matches!(
                error,
                ToolError::OutcomeUnknown(_)
                    | ToolError::CleanupUnconfirmed(_)
                    | ToolError::Persistence(_)
                    | ToolError::OperationUnknown { .. }
                    | ToolError::OperationCleanupUnconfirmed { .. }
            )
    }
}
async fn read_step<T>(
    budget: &mut Option<ReadBudget>,
    cancellation: &CancellationToken,
    future: impl std::future::Future<Output = Result<T, ToolError>>,
) -> Result<T, ToolError> {
    read_step_for(budget, cancellation, ReadEffect::Observation, future).await
}
async fn read_step_for<T>(
    budget: &mut Option<ReadBudget>,
    cancellation: &CancellationToken,
    effect: ReadEffect,
    future: impl std::future::Future<Output = Result<T, ToolError>>,
) -> Result<T, ToolError> {
    let Some(budget) = budget else {
        return future.await;
    };
    if cancellation.is_cancelled() {
        return Err(failed("Browser read cancelled"));
    }
    if budget.remaining.is_zero() {
        return Err(failed("Playwright selector deadline exceeded"));
    }
    let began = tokio::time::Instant::now();
    let mut polled = false;
    let result = {
        let mut future = std::pin::pin!(future);
        let tracked = std::future::poll_fn(|context| {
            polled = true;
            future.as_mut().poll(context)
        });
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err("Browser read cancelled"),
            result = tokio::time::timeout(budget.remaining, tracked) => {
                result.map_err(|_| "Playwright selector deadline exceeded")
            }
        }
    };
    budget.remaining = budget.remaining.saturating_sub(began.elapsed());
    match result {
        Ok(result) => result,
        // Polling proves only that this observer started, never that Extension
        // dispatch or an external effect occurred. Its original custody stays.
        Err(message) if polled => Err(effect.interrupted(message)),
        Err(message) => Err(failed(message)),
    }
}
enum Navigation {
    Loader(String),
    Reload(String),
    Url(String),
}
#[derive(Clone)]
struct Cdp {
    connection: std::sync::Arc<cua_driver_core::browser::cdp_ws::CdpConnection>,
    dialogs: Option<dialogs::Link>,
    extension_context: Option<cua_driver_core::browser::ExtensionWireContext>,
    preparation: extension::PreparationTransport,
}

// Preserve the Host's typed pre-dispatch refusal/uncertainty through existing
// anyhow CDP plumbing. This is not a transport reply or text classifier.
#[derive(Debug)]
struct CdpPreparationFailure(ToolError);
impl std::fmt::Display for CdpPreparationFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(&self.0, formatter)
    }
}
impl std::error::Error for CdpPreparationFailure {}

impl Cdp {
    fn with_effect_scope(&self, scope: std::sync::Arc<dyn crate::BrowserEffectScope>) -> Self {
        let mut socket = self.clone();
        socket.preparation = self.preparation.with_effect_scope(scope);
        socket
    }

    fn spawn_host_effect(
        &self,
        host: &std::sync::Arc<dyn crate::BrowserHostEffects>,
        factory: impl FnOnce(Cdp) -> crate::HostEffectFuture + Send + 'static,
        rejected: Box<dyn FnOnce(ToolError) + Send>,
    ) -> Result<(), ToolError> {
        if matches!(
            self.preparation,
            extension::PreparationTransport::NotRequired
        ) {
            // Generic CDP and metadata-only adapters retain their existing
            // effect path. No artificial driver preparation scope is needed.
            host.spawn_guarded(factory(self.clone()), rejected)
        } else {
            let socket = self.clone();
            host.spawn_scoped_guarded(
                Box::new(move |scope| factory(socket.with_effect_scope(scope))),
                rejected,
            )
        }
    }

    /// This marker is created only before this physical CDP call is submitted.
    /// An older effect may still be unknown; this is not its settlement proof.
    fn is_pre_dispatch_guard_failure(error: &anyhow::Error) -> bool {
        error.is::<CdpPreparationFailure>()
    }

    fn failure(error: anyhow::Error) -> ToolError {
        if let Some(preparation) = error.downcast_ref::<CdpPreparationFailure>() {
            return preparation.0.clone();
        }
        use cua_driver_core::browser::{
            CdpFailureDisposition,
            cdp_ws::{CdpReplyError, ExtensionCdpRefusal},
        };
        let disposition = error
            .downcast_ref::<CdpReplyError>()
            .map(CdpReplyError::disposition)
            .or_else(|| {
                error
                    .downcast_ref::<ExtensionCdpRefusal>()
                    .map(ExtensionCdpRefusal::disposition)
            });
        let message = error.to_string();
        // A matched driver invocation error can follow Chrome's timeout while
        // the Chrome effect continues. Only trusted local producer disposition
        // can distinguish that from a replied failure or an undispatched refusal.
        if matches!(
            disposition,
            Some(CdpFailureDisposition::ReplyFailure | CdpFailureDisposition::NotDispatched)
        ) {
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
            extension_context: None,
            preparation: extension::PreparationTransport::NotRequired,
        })
    }
    async fn raw_call(
        &self,
        session: Option<&str>,
        method: &str,
        params: Value,
    ) -> anyhow::Result<Value> {
        let _preparation = self
            .preparation
            .before_request()
            .await
            .map_err(|error| anyhow::Error::new(CdpPreparationFailure(error)))?;
        match &self.extension_context {
            Some(context) => {
                self.connection
                    .call_with_extension_context(context, session, method, params)
                    .await
            }
            None => self.connection.call(session, method, params).await,
        }
    }
    async fn raw_observation(
        &self,
        session: Option<&str>,
        method: &str,
        params: Value,
    ) -> anyhow::Result<Value> {
        let _preparation = self
            .preparation
            .before_request()
            .await
            .map_err(|error| anyhow::Error::new(CdpPreparationFailure(error)))?;
        match &self.extension_context {
            Some(context) => {
                self.connection
                    .call_observation_with_extension_context(context, session, method, params)
                    .await
            }
            None => {
                self.connection
                    .call_observation(session, method, params)
                    .await
            }
        }
    }
    async fn request(&self, method: &str, params: Value) -> Result<Value, ToolError> {
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
        let _preparation = self.preparation.before_request().await?;
        let result = match &self.extension_context {
            Some(context) => {
                self.connection
                    .call_with_extension_context(context, session, method, params)
                    .await
            }
            None => self.connection.call(session, method, params).await,
        };
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
        self.observe_reply(method, self.raw_observation(session, method, params))
            .await
    }

    async fn observe_metadata_in(
        &self,
        session: Option<&str>,
        read: cua_driver_core::browser::cdp_ws::CdpMetadataRead,
        params: Value,
    ) -> Result<String, ToolError> {
        let call = async {
            let _preparation = self
                .preparation
                .before_request()
                .await
                .map_err(|error| anyhow::Error::new(CdpPreparationFailure(error)))?;
            match &self.extension_context {
                Some(context) => {
                    self.connection
                        .call_metadata_observation_with_extension_context(
                            context, session, read, params,
                        )
                        .await
                }
                None => {
                    self.connection
                        .call_metadata_observation(session, read, params)
                        .await
                }
            }
        };
        self.observe_reply(read.as_str(), call).await
    }

    async fn observe_reply<T>(
        &self,
        method: &str,
        call: impl std::future::Future<Output = anyhow::Result<T>>,
    ) -> Result<T, ToolError> {
        if let Some(dialogs) = &self.dialogs {
            dialogs.synchronize().await;
            dialogs.state.check_method(method)?;
        }
        let result = {
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

async fn http_bytes(provider: &BrowserConnection, path: &str) -> Result<Vec<u8>, ToolError> {
    let url = format!("{}{path}", provider.endpoint.trim_end_matches('/'));
    // Platform trust-store loading is synchronous; keep it off the async poll stack.
    let client = tokio::task::spawn_blocking(|| {
        reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
    })
    .await
    .map_err(failed)?
    .map_err(failed)?;
    let mut response = client
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
    Ok(bytes)
}
async fn http(provider: &BrowserConnection, path: &str) -> Result<Value, ToolError> {
    serde_json::from_slice(&http_bytes(provider, path).await?).map_err(failed)
}
async fn inventory(provider: &BrowserConnection) -> Result<(String, Vec<TabInfo>), ToolError> {
    let version = http(provider, "/json/version").await?;
    let generation = version["webSocketDebuggerUrl"]
        .as_str()
        .ok_or_else(|| failed("browser generation unavailable"))?
        .to_owned();
    let tabs: Vec<TabInfo> =
        serde_json::from_slice(&http_bytes(provider, "/json/list").await?).map_err(failed)?;
    Ok((
        generation,
        tabs.into_iter().filter(|t| t.kind == "page").collect(),
    ))
}
fn tab_info(provider: &Provider, tab: &TabInfo) -> Value {
    if let Some(extension) = &tab.extension {
        return extension::tab_info(extension);
    }
    json!({"id":provider.public_tab_id(&tab.id),"providerTabId":tab.id,"browserId":provider.id(),"titleJson":tab.title,"url":tab.url})
}
fn tab_matches(provider: &Provider, tab: &TabInfo, id: &str) -> bool {
    id == tab.id
        || id == provider.public_tab_id(&tab.id)
        || (provider.extension().is_some()
            && cua_driver_core::browser::parse_browser_tab_id(id)
                .is_some_and(|raw| raw.to_string() == tab.id))
}
impl Browsers {
    pub(crate) fn new(driver: std::sync::Arc<tokio::sync::Mutex<crate::Driver>>) -> Self {
        Self::with_owner(driver, uuid::Uuid::new_v4())
    }

    pub(crate) fn with_owner(
        driver: std::sync::Arc<tokio::sync::Mutex<crate::Driver>>,
        owner: uuid::Uuid,
    ) -> Self {
        Self {
            driver,
            owner,
            epoch: crate::desktop::NativeEpochId::new(),
            cursor_spec: None,
            connections: Vec::new(),
            extension_providers: Vec::new(),
            extension_errors: Vec::new(),
            clipboards: HashMap::new(),
            targets: HashMap::new(),
        }
    }

    pub(crate) fn with_epoch(
        driver: std::sync::Arc<tokio::sync::Mutex<crate::Driver>>,
        owner: uuid::Uuid,
        epoch: crate::desktop::NativeEpochId,
        cursor_spec: std::sync::Arc<std::sync::Mutex<crate::cursor::Spec>>,
    ) -> Self {
        Self {
            driver,
            owner,
            epoch,
            cursor_spec: Some(cursor_spec),
            connections: Vec::new(),
            extension_providers: Vec::new(),
            extension_errors: Vec::new(),
            clipboards: HashMap::new(),
            targets: HashMap::new(),
        }
    }

    async fn host(&self) -> std::sync::Arc<tokio::sync::Mutex<Host>> {
        self.driver.lock().await.browsers.clone()
    }

    async fn visible_inventory(
        &self,
        provider: &Provider,
    ) -> Result<(String, Vec<TabInfo>), ToolError> {
        let (generation, tabs) = provider.inventory().await?;
        let browser = BrowserIdentity::of(provider, &generation)?;
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
        self.targets.get(id).map(|tab| tab.provider.id())
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
        let mut providers: Vec<_> = self
            .connections
            .iter()
            .cloned()
            .map(Provider::Cdp)
            .collect();
        let discovered = provider::discover(&self.driver, self.owner).await;
        let mut errors = discovered.errors;
        providers.extend(discovered.providers);
        let mut browsers = Vec::new();
        for provider in providers {
            match self.visible_inventory(&provider).await {
                Ok((_, tabs)) => {
                    let mut info = provider.info();
                    info["tabs"] = json!(
                        tabs.iter()
                            .map(|tab| tab_info(&provider, tab))
                            .collect::<Vec<_>>()
                    );
                    browsers.push(info);
                }
                Err(error) => errors.push(format!("{}: {error}", provider.id())),
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
        let call = BrowserCall::new(invocation, cancellation, language);
        if matches!(
            &command,
            Command::ListBrowsers { .. }
                | Command::ListTabs { .. }
                | Command::GetBrowser { .. }
                | Command::BrowserTab { .. }
                | Command::GetTab { .. }
                | Command::CreateBrowserTab { .. }
                | Command::BrowserSelect { .. }
                | Command::BrowserSelectedTab { .. }
                | Command::BrowserNameSession { .. }
                | Command::BrowserHistory { .. }
                | Command::BrowserViewportSet { .. }
                | Command::BrowserViewportReset { .. }
                | Command::BrowserManagedTabs { .. }
                | Command::BrowserUserOpenTabs { .. }
                | Command::BrowserUserGetTabContext { .. }
                | Command::BrowserUserClaimTab { .. }
        ) {
            let discovered = provider::discover(&self.driver, self.owner).await;
            self.extension_providers = discovered.providers;
            self.extension_errors = discovered.errors;
        }
        self.reconcile_extension_command(&command).await?;
        match command {
            Command::BrowserViewportSet {
                browser_id,
                options,
            } => Box::pin(self.set_browser_viewport(&browser_id, Some(options), call)).await,
            Command::BrowserViewportReset { browser_id } => {
                Box::pin(self.set_browser_viewport(&browser_id, None, call)).await
            }
            Command::TabPageAssetsList {
                handle: Handle::Tab(handle),
            } => {
                Box::pin(async move {
                    let identity = self
                        .targets
                        .get(&handle)
                        .ok_or_else(|| failed("stale_tab: bind it again"))?
                        .identity()?;
                    self.use_tab(&identity, turn).await?;
                    let tab = self.targets.get_mut(&handle).expect("checked browser tab");
                    tab.last_turn = turn.to_owned();
                    tab.page_assets_list(call).await
                })
                .await
            }
            Command::TabPageAssetsBundle {
                handle: Handle::Tab(handle),
                options,
            } => {
                Box::pin(async move {
                    let identity = self
                        .targets
                        .get(&handle)
                        .ok_or_else(|| failed("stale_tab: bind it again"))?
                        .identity()?;
                    self.use_tab(&identity, turn).await?;
                    let tab = self.targets.get_mut(&handle).expect("checked browser tab");
                    tab.last_turn = turn.to_owned();
                    tab.page_assets_bundle(options, call).await
                })
                .await
            }

            Command::BrowserSelect { selection } => {
                Box::pin(self.select_browser(selection)).await
            }
            Command::BrowserSelectedTab { browser_id } => {
                Box::pin(self.selected_tab(&browser_id, call)).await
            }
            Command::BrowserNameSession { browser_id, name } => {
                Box::pin(self.name_session(&browser_id, &name, call)).await
            }
            Command::BrowserHistory { browser_id, options } => {
                Box::pin(self.user_history(&browser_id, options, call)).await
            }
            Command::BrowserCua { handle: Handle::Tab(handle), operation } => {
                Box::pin(self.cua(&handle, operation, call, cursor)).await
            }
            Command::BrowserManagedTabs { browser_id } => {
                Box::pin(self.managed_tabs(&browser_id, call)).await
            }
            Command::BrowserUserOpenTabs { browser_id } => {
                Box::pin(self.user_tabs(&browser_id)).await
            }
            Command::BrowserScreenshot { handle: Handle::Tab(handle), options } =>
                Box::pin(self.screenshot(&handle, options, call)).await,
            Command::BrowserMarkTab {
                handle: Handle::Tab(handle),
                status,
            } => {
                Box::pin(self.mark_tab(&handle, status, invocation, cancellation, language)).await
            }
            Command::BrowserUserGetTabContext { browser_id, tab_id } => {
                Box::pin(self.user_tab_context(&browser_id, &tab_id, invocation, cancellation)).await
            }
            Command::BrowserUserClaimTab { browser_id, tab_id } => {
                Box::pin(
                    self.claim_user_tab(&browser_id, &tab_id, invocation, cancellation, language)
                )
                .await
            }
            Command::ListBrowsers { .. } => {
                Box::pin(async move {
                    let mut browsers = Vec::new();
                    let mut failure = None;
                    for provider in self.providers(None)? {
                        match self.visible_inventory(&provider).await {
                            Ok(_) => browsers.push(provider.info()),
                            Err(error) => retain_inventory_error(&mut failure, error),
                        }
                    }
                    if browsers.is_empty() {
                        if let Some(error) = failure {
                            return Err(error);
                        }
                        if !self.extension_errors.is_empty() {
                            return Err(failed(self.extension_errors.join("\n")));
                        }
                    }
                    Ok(json!(browsers))
                })
                .await
            }
            Command::ListTabs { options } => {
                Box::pin(async move {
                    let mut tabs = Vec::new();
                    for provider in self.providers(options.browser.as_deref())? {
                        let (_, listed) = self.visible_inventory(&provider).await?;
                        tabs.extend(listed.iter().map(|tab| tab_info(&provider, tab)));
                    }
                    Ok(json!(tabs))
                })
                .await
            }
            Command::GetBrowser { options } => {
                Box::pin(async move {
                    if options.id.is_none()
                        && let Some(url) = options.url
                    {
                        normalized_url(&url)?;
                    }
                    let id = options.id.as_deref();
                    let fallback = id == Some("opencli")
                        && options.extension_instance_id.is_none()
                        && !self
                            .providers(None)?
                            .iter()
                            .any(|provider| provider.id() == "opencli");
                    let mut matches = Vec::new();
                    let mut failure = None;
                    for provider in self.providers(if fallback { None } else { id })? {
                        if options.extension_instance_id.as_deref().is_some_and(|id| {
                            provider
                                .extension()
                                .is_none_or(|extension| extension.identity().instance_id != id)
                        }) {
                            continue;
                        }
                        match self.visible_inventory(&provider).await {
                            Ok(_) => matches.push(provider),
                            Err(error) => retain_inventory_error(&mut failure, error),
                        }
                    }
                    if matches.is_empty()
                        && let Some(error) = failure
                    {
                        return Err(error);
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
                    Ok(matches[0].info())
                })
                .await
            }
            Command::BrowserTab {
                browser_id,
                reference,
            } => {
                Box::pin(async move {
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
                            let (generation, info) = match provider.extension() {
                                Some(_) => self.extension_exact_metadata(&provider, &id, call).await?,
                                None => {
                                    let (generation, tabs) = provider.inventory().await?;
                                    let info = tabs
                                        .into_iter()
                                        .find(|tab| tab_matches(&provider, tab, &id))
                                        .ok_or_else(|| {
                                            failed("tab is unavailable in the selected browser")
                                        })?;
                                    (generation, info)
                                }
                            };
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
                })
                .await
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
                Box::pin(async move {
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
                    tab.ensure_clipboard_bridge(turn, call).await?;
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
                })
                .await
            }
            Command::BrowserFileChooserSetFiles {handle,file_chooser_id,files,options} => Box::pin(self.set_file_chooser_files(handle,file_chooser_id,files,options,BrowserCall::new(invocation,cancellation,language))).await,
            Command::BrowserDownloadPath {
                handle: Handle::Tab(handle),
                scope,
                download_id,
                options: _,
            } => {
                Box::pin(async move {
                    // Check actual acquisition history before use_tab can update
                    // the logical lease's recorded turn.
                    self.check_download_tab_lease(&handle, invocation.turn())
                        .await?;
                    let identity = self
                        .targets
                        .get(&handle)
                        .ok_or_else(|| failed("stale_tab: bind it again"))?
                        .identity()?;
                    self.use_tab(&identity, turn).await?;
                    let tab = self
                        .targets
                        .get_mut(&handle)
                        .expect("checked browser handle");
                    tab.last_turn = turn.to_owned();
                    tab.authorize_download_path(invocation, cancellation, language)
                        .await?;
                    self.host()
                        .await
                        .lock()
                        .await
                        .download_metadata
                        .path(self.owner, &identity.browser, &scope, &download_id)
                        .await
                })
                .await
            }
            Command::BrowserDownloadMedia {
                handle: Handle::Tab(handle),
                target,
                options,
            } => {
                Box::pin(async move {
                    let identity = self
                        .targets
                        .get(&handle)
                        .ok_or_else(|| failed("stale_tab: bind it again"))?
                        .identity()?;
                    self.use_tab(&identity, turn).await?;
                    let tab = self
                        .targets
                        .get_mut(&handle)
                        .expect("checked browser handle");
                    match target {
                        BrowserMediaTarget::Locator { locator } => {
                            tab.last_turn = turn.to_owned();
                            tab.authorize(None, invocation, cancellation, language)
                                .await?;
                            tab.verify(BrowserCall::new(invocation, cancellation, language))
                                .await?;
                            let document = tab.document();
                            tab.playwright_download_media(&locator, &options, document, call)
                                .await
                        }
                        BrowserMediaTarget::Coordinates { .. } | BrowserMediaTarget::DomNode { .. } => {
                            let command = if matches!(target, BrowserMediaTarget::Coordinates { .. }) {
                                "cua_download_media"
                            } else {
                                "dom_cua_download_media"
                            };
                            let info = tab.provider.info();
                            let name = info["name"].as_str().unwrap_or("Browser");
                            Err(failed(format!(
                                "{name} does not support command \"{command}\"."
                            )))
                        }
                    }
                })
                .await
            }
            Command::BrowserMutation {
                handle: Handle::Tab(handle),
                locator,
                operation,
            } => {
                Box::pin(async move {
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
                    tab.playwright_mutation(&locator, operation, document, cursor, call)
                        .await
                })
                .await
            }
            Command::BrowserEvaluate {
                handle: Handle::Tab(handle), locator, mode, script_json, options,
            } => Box::pin(async move {
                if (mode == BrowserEvaluateMode::Page) != locator.is_none() {
                    return Err(failed("browser evaluation mode does not match its selector scope"));
                }
                let identity = self.targets.get(&handle)
                    .ok_or_else(|| failed("stale_tab: bind it again"))?.identity()?;
                self.use_tab(&identity, turn).await?;
                let tab = self.targets.get_mut(&handle).expect("checked browser handle");
                tab.last_turn = turn.to_owned();
                let mut budget = Some(ReadBudget { remaining:options.budget() });
                tab.authorize_with_budget(None,invocation,cancellation,language,
                    extension::ClaimIntent::Implicit,&mut budget).await?;
                tab.playwright_evaluate(locator.as_ref(),mode,&script_json,&options,
                    budget.expect("evaluate budget remains owned by this call"),call).await
            }).await,

            Command::BrowserRead {
                handle: Handle::Tab(handle),
                locator,
                operation,
                options,
            } => {
                Box::pin(async move {
                    playwright::validate(&operation, &options)?;
                    let identity = self
                        .targets
                        .get(&handle)
                        .ok_or_else(|| failed("stale_tab: bind it again"))?
                        .identity()?;
                    self.use_tab(&identity, turn).await?;
                    let tab = self.targets.get_mut(&handle).unwrap();
                    tab.last_turn = turn.to_owned();
                    let mut budget = Some(ReadBudget::new(&options));
                    tab.authorize_with_budget(
                        None,
                        invocation,
                        cancellation,
                        language,
                        extension::ClaimIntent::Implicit,
                        &mut budget,
                    )
                    .await?;
                    let document = tab.document();
                    tab.playwright_read(
                        &locator,
                        operation,
                        budget.expect("read budget remains owned by this call"),
                        document,
                        call,
                    )
                    .await
                })
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
                Box::pin(async move {
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
                })
                .await
            }
            Command::TabMetadata {
                handle: Handle::Tab(handle),
            } => {
                Box::pin(async move {
                    let identity = self
                        .targets
                        .get(&handle)
                        .ok_or_else(|| failed("stale_tab: bind it again"))?
                        .identity()?;
                    self.use_tab(&identity, turn).await?;
                    let tab = self.targets.get_mut(&handle).unwrap();
                    tab.last_turn = turn.to_owned();
                    tab.refresh_info(call).await?;
                    if let Some(extension) = &tab.info.extension {
                        Ok(extension::tab_info(extension))
                    } else {
                        Ok(json!({"titleJson":tab.info.title,"url":tab.info.url}))
                    }
                })
                .await
            }
            Command::GetTab { reference, options } => {
                Box::pin(async move {
                    let mut matches = Vec::new();
                    for provider in self.providers(options.browser.as_deref())? {
                        if provider.extension().is_some() && matches!(&reference, TabReference::Id(_)) {
                            let (generation, tabs) =
                                self.extension_session_metadata(&provider, call).await?;
                            if let Some(tab) = tabs.into_iter().find(|tab| match &reference {
                                TabReference::Id(id) => tab_matches(&provider, tab, id),
                                _ => false,
                            }) {
                                matches.push((provider.clone(), generation, tab, true));
                                continue;
                            }
                            // A real known acquisition missing from the filtered
                            // session view is unavailable, never globally reselected.
                            if let TabReference::Id(id) = &reference
                                && self
                                    .extension_has_acquisition(&provider, &generation, id)
                                    .await?
                            {
                                return Err(failed(
                                    "tab_unavailable: known tab is not in this session's visible metadata",
                                ));
                            }
                        }
                        let (generation, tabs) = provider.inventory().await?;
                        for tab in tabs {
                            let selected = match &reference {
                                TabReference::Id(id) => tab_matches(&provider, &tab, id),
                                TabReference::Url { url } => &tab.url == url,
                                TabReference::Mention { .. } => {
                                    return Err(failed(
                                        "tab mentions require a connected client provider",
                                    ));
                                }
                            };
                            if selected {
                                matches.push((provider.clone(), generation.clone(), tab, false));
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
                    let (provider, generation, tab, session_metadata) = matches.pop().unwrap();
                    if provider.extension().is_some()
                        && !session_metadata
                        && !self
                            .extension_has_acquisition(&provider, &generation, &tab.id)
                            .await?
                    {
                        let bound = self
                            .claim_user_tab(provider.id(), &tab.id, invocation, cancellation, language)
                            .await?;
                        let Handle::Tab(handle) =
                            serde_json::from_value(bound["handle"].clone()).map_err(failed)?
                        else {
                            unreachable!()
                        };
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
                        let mut bound = bound;
                        bound["state"] = observed["state"].clone();
                        return Ok(bound);
                    }
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
                })
                .await
            }
            Command::CreateBrowserTab {
                browser_id,
                url,
                options,
            } => {
                Box::pin(async move {
                    let provider = self.providers(Some(&browser_id))?[0].clone();
                    if let Some(name) = options.session_name {
                        self.name_session(&browser_id, &name, call).await?;
                    }
                    if options.visible.is_some() {
                        return Err(failed(
                            "Capability is not available: visibility",
                        ));
                    }
                    let url = url.map(|url| convenience_url(&url));
                    self.create(
                        provider,
                        url,
                        InitialState::Observe,
                        invocation,
                        cancellation,
                        language,
                    )
                    .await
                })
                .await
            }
            Command::Observe {
                handle: Handle::Tab(handle),
                kind,
                options,
            } => {
                Box::pin(
                    self.observe(
                        &handle,
                        kind,
                        !options.disable_diffing,
                        invocation,
                        cancellation,
                        language,
                    )
                )
                .await
            }
            Command::Action {
                handle: Handle::Tab(handle),
                action,
            } => {
                Box::pin(
                    self.action(&handle, action, invocation, cursor, cancellation, language)
                )
                .await
            }
            _ => Err(failed("invalid browser operation")),
        }
    }
    fn providers(&self, id: Option<&str>) -> Result<Vec<Provider>, ToolError> {
        let providers: Vec<_> = self
            .connections
            .iter()
            .cloned()
            .map(Provider::Cdp)
            .chain(self.extension_providers.iter().cloned())
            .collect();
        let selected = provider::selection_mask(
            id,
            providers
                .iter()
                .map(|provider| (provider.id(), provider.extension_mode())),
        )?;
        let providers: Vec<_> = providers
            .into_iter()
            .zip(selected)
            .filter_map(|(provider, selected)| selected.then_some(provider))
            .collect();
        if providers.is_empty() && id.is_some() {
            let mut message = "browser_unavailable: no current matching provider".to_owned();
            if id.is_some_and(|id| id.starts_with("extension:"))
                && !self.extension_errors.is_empty()
            {
                message.push_str("; ");
                message.push_str(&self.extension_errors.join("; "));
            }
            return Err(failed(message));
        }
        Ok(providers)
    }
    async fn create(
        &mut self,
        provider: Provider,
        url: Option<String>,
        initial: InitialState,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &tokio_util::sync::CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        if provider.extension().is_some() {
            return self
                .create_extension(provider, url, initial, invocation, cancellation, language)
                .await;
        }
        let turn = invocation.turn();
        let (generation, _) = provider.inventory().await?;
        let identity = BrowserIdentity::of(&provider, &generation)?;
        check_input(cancellation)?;
        let browser = Cdp::connect(&generation, provider.cdp()?).await?;
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
        let (current, tabs) = provider.inventory().await?;
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
        let identity = BrowserIdentity::of(&provider, &generation)?.tab(&info.id);
        let api_profile = provider.api_profile();
        self.use_tab(&identity, turn).await?;
        if self
            .clipboards
            .get(provider.id())
            .is_none_or(|backend| backend.provider != provider || backend.generation != generation)
        {
            self.clipboards.insert(
                provider.id().to_owned(),
                clipboard_bridge::Backend::new(provider.clone(), generation.clone()),
            );
        }
        let clipboard_store = self.clipboards[provider.id()].store.clone();
        let existing = self.targets.iter().find_map(|(handle, tab)| {
            (tab.provider == provider && tab.identity().ok().as_ref() == Some(&identity))
                .then(|| handle.clone())
        });
        let new = existing.is_none();
        let handle = existing.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let id = provider.public_tab_id(&info.id);
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
                    socket_prepared: false,
                    page_assets: Default::default(),
                    origin_proof: None,
                    navigation_admission: None,
                    extension_claim: None,
                    extension_wire: None,
                    extension_host_operation: None,
                    extension_acquisition: None,
                    fixed_presentation: None,
                    frame: None,
                    refs: HashMap::new(),
                    ax: ax::Projection::default(),
                    frames: frames::Frames::default(),
                    previous: None,
                    navigation: None,
                    cursor_world: None,
                    cursor_epoch: self.epoch,
                    cursor_owner: self.owner,
                    cursor_host,
                    cursor_spec: self.cursor_spec.clone(),
                    last_turn: turn.to_owned(),
                    dialogs: None,
                    downloads: None,
                    filechoosers: None,
                    dialog_host: invocation.browser_host_effects(),
                    clipboard: None,
                    clipboard_store,
                    clipboard_authorization: invocation
                        .browser_authorization()
                        .and_then(|authorization| authorization.attachment()),
                    attachment_settlement: invocation.operation_settlement(),
                },
            );
        }
        if matches!(initial, InitialState::Deferred) {
            return Ok(
                json!({"handle":Handle::Tab(handle),"id":id,"kind":"tab","apiProfile":api_profile,"capabilities":{"tab":capability::tab_info()}}),
            );
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
                json!({"handle":Handle::Tab(handle),"id":id,"kind":"tab","state":value["state"],"apiProfile":api_profile,"capabilities":{"tab":capability::tab_info()}}),
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
        let prior_frame = tab.frame.clone();
        if !matches!(kind, ObservationKind::Screenshot) {
            tab.refs.clear();
            tab.frame = None;
        }
        tab.authorize(None, invocation, cancellation, language)
            .await?;
        tab.verify(BrowserCall::new(invocation, cancellation, language))
            .await?;
        let mut result = tab
            .observe(kind, diff, invocation, cancellation, language)
            .await;
        if result.is_err()
            && let Some(dialog) = tab.active_dialog().await
        {
            result = tab.observe_dialog(dialog, kind, diff, language);
        }
        if result.is_ok() && matches!(kind, ObservationKind::Screenshot) && prior_frame != tab.frame
        {
            // Compare against the actual captured document after settling and
            // authorization, which can themselves overlap a navigation.
            tab.refs.clear();
            tab.previous = None;
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
        if !closing || tab.provider.extension().is_some() {
            let target = match &action {
                Action::Navigate { url } => Some(url.as_str()),
                _ => None,
            };
            if matches!(action, Action::Back | Action::Forward) {
                tab.prepare_metadata(invocation, cancellation, language)
                    .await?;
            } else {
                tab.authorize(target, invocation, cancellation, language)
                    .await?;
            }
        }
        if matches!(
            action,
            Action::Navigate { .. } | Action::Back | Action::Forward
        ) {
            tab.connect_metadata().await?;
        } else {
            tab.verify(BrowserCall::new(invocation, cancellation, language))
                .await?;
        }
        if matches!(
            &action,
            Action::Click {
                target: Position::Point(_),
                ..
            } | Action::Scroll {
                target: Position::Point(_),
                ..
            } | Action::MoveCursor {
                target: Position::Point(_)
            } | Action::Drag { .. }
                | Action::TypeText { index: None, .. }
                | Action::Paste { index: None, .. }
                | Action::PressKey { index: None, .. }
        ) && tab.active_dialog().await.is_none()
        {
            let proof = tab
                .origin_proof
                .clone()
                .ok_or_else(|| failed("browser input lacks its admitted current document"))?;
            proof.check_current(tab).await?;
            let admitted = proof.document_identity().frame_token();
            if tab.frame.as_ref() != Some(&admitted) {
                tab.refs.clear();
                tab.previous = None;
            }
            tab.frame = Some(admitted);
        }
        let mut result = if closing {
            tab.cleanup_clipboard_current().await?;
            tab.cleanup_filechoosers_current().await?;
            let extension_close = tab.admit_extension_close(invocation, cancellation).await?;
            // Held response cleanup uses this actual Close operation while its
            // exact claim is still Live. Existing Pending releases keep their
            // original future; no request is replayed under this socket.
            tab.cleanup_downloads_current().await?;
            {
                let mut host = host.lock().await;
                check_input(cancellation)?;
                host.begin_close(&identity, self.owner, turn)?;
            }
            tab.refs.clear();
            if let Some(admission) = extension_close {
                tab.close_extension_tab(invocation, admission)
                    .await
                    .map(|_| Value::Null)
            } else {
                tab.request("Page.close", json!({}))
                    .await
                    .map(|_| Value::Null)
            }
        } else {
            tab.action(action, invocation, cursor, cancellation, language)
                .await
        };
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
        self.host()
            .await
            .lock()
            .await
            .check_owned_inputs(self.owner, Some(turn), None)?;
        self.drain_extension_controls(Some(turn), None).await?;
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
        self.host()
            .await
            .lock()
            .await
            .check_owned_inputs(self.owner, None, Some(self.epoch))?;
        self.drain_extension_controls(None, Some(self.epoch))
            .await?;
        for tab in self.targets.values() {
            tab.begin_disconnect();
        }
        let mut failures = Vec::new();
        if let Err(error) = self.remove_cursors(cursor).await {
            failures.push(error.to_string());
        }
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
        self.host()
            .await
            .lock()
            .await
            .check_owned_inputs(self.owner, None, None)?;
        self.drain_extension_controls(None, None).await?;
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
            host.extension.retain(|(owner, _), _| *owner != self.owner);
            drop(host);
            self.extension_providers.clear();
            self.extension_errors.clear();
            self.driver
                .lock()
                .await
                .extension_browsers
                .close_owner(self.owner)
                .await;
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
        call: BrowserCall<'_>,
    ) -> Result<(), ToolError> {
        let authorization = self
            .clipboard_authorization
            .clone()
            .ok_or_else(|| failed("Browser clipboard requires current attachment authorization"))?;
        let host = self
            .dialog_host
            .clone()
            .ok_or_else(|| failed("Browser clipboard requires Host effect custody"))?;
        self.verify(call).await?;
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

    async fn cleanup_clipboard_current(&mut self) -> Result<(), ToolError> {
        let socket = self.socket.clone();
        if let Some(bridge) = self.clipboard.as_mut() {
            let socket = socket.ok_or_else(|| {
                ToolError::CleanupUnconfirmed(
                    "Explicit Close lost its current admitted clipboard transport".into(),
                )
            })?;
            bridge.cleanup_with_socket(Some(socket)).await?;
            self.clipboard = None;
        }
        Ok(())
    }

    fn begin_disconnect(&self) {
        if let Some(choosers) = &self.filechoosers {
            choosers.begin_close();
        }
        if let Some(downloads) = &self.downloads {
            downloads.begin_close();
        }
        if let Some(bridge) = &self.clipboard {
            bridge.begin_close();
        }
        if let Some(dialogs) = &self.dialogs {
            dialogs.host_effects(None);
        }
    }

    async fn disconnect(&mut self) -> Result<(), ToolError> {
        self.check_owned_input().await?;
        self.begin_disconnect();
        self.cleanup_clipboard().await?;
        self.cleanup_downloads().await?;
        self.cleanup_filechoosers().await?;
        if let Some(dialogs) = self.dialogs.as_mut() {
            dialogs.close().await?;
        }
        self.dialogs = None;
        self.dialog_host = None;
        self.clipboard_authorization = None;
        self.socket = None;
        self.socket_prepared = false;
        self.origin_proof = None;
        self.navigation_admission = None;
        self.extension_claim = None;
        self.extension_wire = None;
        self.extension_host_operation = None;
        Ok(())
    }

    fn document(&self) -> crate::BrowserDocument {
        crate::BrowserDocument {
            browser_id: self.provider.id().to_owned(),
            generation: self.generation.clone(),
            tab_id: self.info.id.clone(),
            url: self.info.url.clone(),
        }
    }

    fn read_effect(&self) -> Result<ReadEffect, ToolError> {
        Ok(match self.provider.extension() {
            Some(extension)
                if extension
                    .capabilities()
                    .map_err(provider::extension_error)?
                    .attachment_preparation
                    == cua_driver_core::browser::ExtensionAttachmentPreparation::FullPreparation =>
            {
                ReadEffect::ExtensionPreparation
            }
            _ => ReadEffect::Observation,
        })
    }

    async fn authorize(
        &mut self,
        navigation: Option<&str>,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &tokio_util::sync::CancellationToken,
        language: Language,
    ) -> Result<(), ToolError> {
        self.authorize_with_intent(
            navigation,
            invocation,
            cancellation,
            language,
            extension::ClaimIntent::Implicit,
        )
        .await
    }

    async fn authorize_with_intent(
        &mut self,
        navigation: Option<&str>,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &tokio_util::sync::CancellationToken,
        language: Language,
        claim_intent: extension::ClaimIntent,
    ) -> Result<(), ToolError> {
        self.authorize_with_budget(
            navigation,
            invocation,
            cancellation,
            language,
            claim_intent,
            &mut None,
        )
        .await
    }

    async fn authorize_with_budget(
        &mut self,
        navigation: Option<&str>,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &tokio_util::sync::CancellationToken,
        language: Language,
        claim_intent: extension::ClaimIntent,
        budget: &mut Option<ReadBudget>,
    ) -> Result<(), ToolError> {
        let effect = if budget.is_some() {
            self.read_effect()?
        } else {
            ReadEffect::Observation
        };
        read_step_for(
            budget,
            cancellation,
            effect,
            self.refresh_info(BrowserCall::new(invocation, cancellation, language)),
        )
        .await?;
        if let Some(url) = navigation {
            self.navigation_admission = None;
            validate_url(url)?;
            // Establish only the existing transport before consent, so a same-URL
            // document replacement during consent cannot evade the source fence.
            self.prepare_origin_transport_with_budget(
                invocation,
                cancellation,
                language,
                claim_intent,
                budget,
            )
            .await?;
            let document = self.document();
            let source =
                read_step_for(budget, cancellation, effect, self.document_identity()).await?;
            invocation
                .authorize_browser(
                    crate::BrowserAccess::Navigate {
                        document: document.clone(),
                        url: url.into(),
                    },
                    cancellation,
                )
                .await?;
            read_step_for(
                budget,
                cancellation,
                effect,
                self.refresh_info(BrowserCall::new(invocation, cancellation, language)),
            )
            .await?;
            if self.document() != document {
                return Err(failed(
                    "document changed during browser authorization; retry the operation",
                ));
            }
            if read_step_for(budget, cancellation, effect, self.document_identity()).await?
                != source
            {
                return Err(failed(
                    "document changed before navigation dispatch; retry the operation",
                ));
            }
            // A grant to leave A for B never grants content preparation on A.
            self.navigation_admission = Some(origin::NavigationAdmission::new(url, source));
            return Ok(());
        }
        // An adapter may run its fixed session machinery while acquiring the
        // transport. That has a separate current Host admission and is never
        // authorized by a prior URL's site consent.
        self.prepare_origin_transport_with_budget(
            invocation,
            cancellation,
            language,
            claim_intent,
            budget,
        )
        .await?;
        let document = self.document();
        let proof = read_step_for(budget, cancellation, effect, self.document_origin()).await?;
        let access = proof.access();
        invocation
            .authorize_browser(access.clone(), cancellation)
            .await?;
        // Human consent may suspend this call while another actor navigates.
        // Never apply the admitted operation to that replacement document.
        read_step_for(
            budget,
            cancellation,
            effect,
            self.refresh_info(BrowserCall::new(invocation, cancellation, language)),
        )
        .await?;
        if self.document() != document {
            return Err(failed(
                "document changed during browser authorization; retry the operation",
            ));
        }
        read_step_for(budget, cancellation, effect, proof.check_current(self)).await?;
        check_input(cancellation)?;
        if self
            .clipboard
            .as_ref()
            .is_some_and(|bridge| bridge.turn() != invocation.turn())
        {
            read_step_for(budget, cancellation, effect, self.cleanup_clipboard()).await?;
        }
        if self.provider.extension().is_some() {
            let wire = cua_driver_core::browser::ExtensionWireContext::new(
                self.cursor_owner.to_string(),
                invocation.turn(),
            )
            .map_err(failed)?;
            if let Some(socket) = &mut self.socket {
                socket.extension_context = Some(wire.clone());
            }
            self.extension_wire = Some(wire);
        }
        let before_services_frame = if self.socket.is_some() {
            Some(read_step_for(budget, cancellation, effect, self.frame()).await?)
        } else {
            None
        };
        let services = read_step_for(
            budget,
            cancellation,
            effect,
            invocation.prepare_browser_services(access, cancellation),
        )
        .await?;
        check_input(cancellation)?;
        read_step_for(
            budget,
            cancellation,
            effect,
            self.refresh_info(BrowserCall::new(invocation, cancellation, language)),
        )
        .await?;
        if self.document() != document {
            return Err(failed(
                "document changed during browser attachment preparation",
            ));
        }
        if let Some(frame) = before_services_frame
            && read_step_for(budget, cancellation, effect, self.frame()).await? != frame
        {
            return Err(failed(
                "document changed during browser attachment preparation",
            ));
        }
        self.clipboard_authorization = services.attachment;
        self.dialog_host = services.effects;
        self.attachment_settlement = services.settlement;
        if let Some(bridge) = &self.clipboard {
            bridge.update(
                self.clipboard_authorization.clone(),
                self.dialog_host.clone(),
            );
        }
        if let Some(controller) = &self.dialogs {
            controller.host_effects(self.dialog_host.clone());
        }
        if self.provider.extension().is_some() {
            self.prepare_extension_with_budget(
                invocation,
                cancellation,
                language,
                claim_intent,
                budget,
            )
            .await?;
        }
        Ok(())
    }

    fn identity(&self) -> Result<TabIdentity, ToolError> {
        Ok(BrowserIdentity::of(&self.provider, &self.generation)?.tab(&self.info.id))
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
    async fn authorize_download_path(
        &mut self,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<(), ToolError> {
        if self.provider.extension().is_some() && self.extension_acquisition.is_some() {
            return self
                .authorize_extension_download_path(invocation, cancellation)
                .await;
        }
        self.refresh_info(BrowserCall::new(invocation, cancellation, language))
            .await?;
        let source = self
            .authorize_download_source(invocation, cancellation)
            .await?;
        self.refresh_info(BrowserCall::new(invocation, cancellation, language))
            .await?;
        self.check_download_source(&source, invocation, cancellation)
            .await
    }

    async fn authorize_download_source(
        &self,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
    ) -> Result<crate::BrowserDocument, ToolError> {
        let source = self.document();
        invocation
            .authorize_browser(
                crate::BrowserAccess::Metadata {
                    document: source.clone(),
                },
                cancellation,
            )
            .await?;
        validate_url(&source.url)?;
        // Download.path's public policy uses the current URL. This does not
        // grant content on an inherited about:blank or invent its effective Origin.
        if source.url != "about:blank" {
            invocation
                .authorize_browser(
                    crate::BrowserAccess::Read {
                        document: source.clone(),
                    },
                    cancellation,
                )
                .await?;
        }
        Ok(source)
    }

    async fn check_download_source(
        &self,
        source: &crate::BrowserDocument,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
    ) -> Result<(), ToolError> {
        if self.document() != *source {
            return Err(failed(
                "download source URL or target changed during path authorization; retry the lookup",
            ));
        }
        let authorization = invocation
            .browser_authorization()
            .ok_or_else(|| failed("download path requires current Host authorization"))?;
        authorization
            .check(
                crate::BrowserAccess::Metadata {
                    document: source.clone(),
                },
                cancellation.clone(),
            )
            .await?;
        if source.url != "about:blank" {
            authorization
                .check(
                    crate::BrowserAccess::Read {
                        document: source.clone(),
                    },
                    cancellation.clone(),
                )
                .await?;
        }
        check_input(cancellation)
    }

    async fn refresh_info(&mut self, call: BrowserCall<'_>) -> Result<(), ToolError> {
        if let Some(extension) = self.provider.extension() {
            if extension.is_closed() || extension.identity().generation != self.generation {
                return Err(failed("stale_tab: extension browser generation changed"));
            }
            let pending = self.session_metadata(call).await?;
            let observed = pending.resolve(&self.info.id).await?;
            if observed
                .url
                .as_deref()
                .is_some_and(extension::is_internal_url)
            {
                return Err(failed(
                    "tab_unavailable: raw tab is not in this session's visible metadata",
                ));
            }
            self.info = provider::extension_tab(observed);
            return Ok(());
        }
        let (generation, tabs) = self.provider.inventory().await?;
        if generation != self.generation || !tabs.iter().any(|tab| tab.id == self.info.id) {
            self.disconnect().await?;
            self.refs.clear();
            self.frame = None;
            return Err(failed(match call.language {
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
    async fn connect_metadata(&mut self) -> Result<(), ToolError> {
        if self
            .socket
            .as_ref()
            .is_some_and(|socket| !socket.connection.is_closed())
        {
            return Ok(());
        }
        self.refs.clear();
        self.frame = None;
        self.socket_prepared = false;
        let socket = match &self.provider {
            Provider::Cdp(provider) => {
                let websocket = self
                    .info
                    .websocket
                    .as_deref()
                    .ok_or_else(|| failed("tab has no CDP websocket"))?;
                Cdp::connect(websocket, provider).await?
            }
            Provider::Extension { connection, .. } => {
                let claim = self.extension_claim.as_ref().ok_or_else(|| {
                    failed("extension metadata requires its admitted physical claim")
                })?;
                Cdp {
                    connection: connection
                        .open_cdp_channel(claim)
                        .await
                        .map_err(provider::extension_error)?,
                    dialogs: None,
                    extension_context: Some(self.extension_wire.clone().ok_or_else(|| {
                        failed("extension CDP requires its admitted session/turn context")
                    })?),
                    preparation: match connection
                        .capabilities()
                        .map_err(provider::extension_error)?
                        .attachment_preparation
                    {
                        cua_driver_core::browser::ExtensionAttachmentPreparation::MetadataOnly => {
                            extension::PreparationTransport::NotRequired
                        }
                        cua_driver_core::browser::ExtensionAttachmentPreparation::FullPreparation
                        | cua_driver_core::browser::ExtensionAttachmentPreparation::Unknown => {
                            extension::PreparationTransport::Unadmitted
                        }
                    },
                }
            }
        };
        self.socket = Some(socket);
        Ok(())
    }

    async fn verify(&mut self, call: BrowserCall<'_>) -> Result<(), ToolError> {
        self.refresh_info(call).await?;
        self.connect_metadata().await?;
        if !self.socket_prepared {
            let socket = self.socket.as_mut().expect("connected metadata channel");
            let controller = dialogs::Controller::start(socket.clone());
            controller.host_effects(self.dialog_host.clone());
            socket.dialogs = Some(controller.link.clone());
            self.dialogs = Some(controller);
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
            self.socket_prepared = true;
        }
        self.apply_pending_viewport(call).await?;
        self.ensure_downloads().await?;
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
        self.verify(BrowserCall::new(invocation, cancellation, language))
            .await?;
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
        }
        if !matches!(kind, ObservationKind::Ax) {
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
    async fn point(&mut self, point: [f64; 2], _language: Language) -> Result<[f64; 2], ToolError> {
        let metrics = self.request("Page.getLayoutMetrics", json!({})).await?;
        let viewport = &metrics["cssVisualViewport"];
        let width = viewport["clientWidth"]
            .as_f64()
            .ok_or_else(|| failed("viewport dimensions unavailable"))?;
        let height = viewport["clientHeight"]
            .as_f64()
            .ok_or_else(|| failed("viewport dimensions unavailable"))?;
        if !point.iter().all(|value| value.is_finite() && *value >= 0.0)
            || point[0] >= width
            || point[1] >= height
        {
            return Err(failed(
                "Coordinate is outside the active tab content viewport",
            ));
        }
        Ok(point)
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
            return Err(failed(
                "Linux extension input requires an application target",
            ));
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
                self.refs.clear();
                check_input(cancellation)?;
                self.check_navigation(&url).await?;
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
                let history_source = self.document_identity().await?;
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
                if self.document_identity().await? != history_source {
                    return Err(failed(
                        "document changed while browser navigation history was authorized",
                    ));
                }
                self.check_navigation(target).await?;
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
                self.owned_input(cancellation, None, move |_, input, _| Box::pin(async move {
                    let held = input.mouse_down(None, json!({"type":"mousePressed","x":point[0],"y":point[1],"button":button,"clickCount":count})).await?;
                    input.release(held).await
                })).await?;
            }
            Action::PressKey { index, key } => {
                self.focus(index, cancellation, language).await?;
                self.before_element_input(selected_index, cancellation, language)
                    .await?;
                self.accessibility_key(
                    index,
                    &key,
                    BrowserCall::new(invocation, cancellation, language),
                    cursor,
                )
                .await?;
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
                let cursor = cursor.clone();
                self.owned_input(cancellation, None, move |mut page, input, cancellation| Box::pin(async move {
                    let held = input.mouse_down(None, json!({"type":"mousePressed","x":from[0],"y":from[1],"button":"left","clickCount":1})).await?;
                    if cursor.enabled {
                        let _ = page.draw_cursor(&cursor, Some(to), "drag", "update", language).await;
                    }
                    page.before_input(&cancellation, language).await?;
                    input.mouse_position(held, to);
                    page.request("Input.dispatchMouseEvent",json!({"type":"mouseMoved","x":to[0],"y":to[1],"button":"left","buttons":1})).await?;
                    input.release(held).await
                })).await?;
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
fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}
fn unknown(error: impl std::fmt::Display) -> ToolError {
    ToolError::OutcomeUnknown(error.to_string())
}

fn retain_inventory_error(failure: &mut Option<ToolError>, error: ToolError) {
    // Keep uncertainty intact when another provider only reports a known refusal.
    if failure
        .as_ref()
        .is_none_or(|previous| matches!(previous, ToolError::Failed(_) | ToolError::Io { .. }))
    {
        *failure = Some(error);
    }
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

    #[test]
    fn local_cdp_error_text_cannot_fabricate_a_matched_remote_rejection() {
        let message = "local transport failed (-32000): no matched CDP reply";
        let error = Cdp::failure(anyhow::anyhow!("{message}"));
        assert!(matches!(error, ToolError::OutcomeUnknown(actual) if actual == message));
    }

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

    struct PathPolicyFixture {
        site_allowed: bool,
        accesses: Arc<Mutex<Vec<crate::BrowserAccess>>>,
    }
    impl crate::BrowserAuthorization for PathPolicyFixture {
        fn authorize(
            &self,
            access: crate::BrowserAccess,
            _: CancellationToken,
        ) -> crate::AuthorizationFuture {
            let allowed = match &access {
                crate::BrowserAccess::Metadata { .. } => true,
                crate::BrowserAccess::Read { .. } => self.site_allowed,
                _ => false,
            };
            self.accesses.lock().unwrap().push(access);
            Box::pin(async move {
                if allowed {
                    Ok(())
                } else {
                    Err(failed("fixture current URL policy denied"))
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

    #[tokio::test]
    async fn download_path_checks_url_site_policy_without_connecting_to_page_content() {
        for (url, site_allowed, succeeds, inventories, reads) in [
            ("https://source.example/file", false, false, 2, 1),
            ("https://source.example/file", true, true, 3, 2),
            ("about:blank", false, true, 3, 0),
            ("data:text/plain,source", true, false, 2, 0),
            ("blob:https://source.example/id", true, false, 2, 0),
            ("file:///tmp/maka-download-source.html", true, false, 2, 0),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let tabs = [json!({
                    "id":"page", "title":"Download source", "url":url,
                    "type":"page",
                    "webSocketDebuggerUrl":format!("ws://{address}/devtools/page/page")
                })];
                let mut paths = Vec::new();
                for _ in 0..inventories {
                    paths.extend(serve_inventory(&listener, &tabs).await);
                }
                assert!(
                    tokio::time::timeout(Duration::from_millis(30), listener.accept())
                        .await
                        .is_err(),
                    "filename preflight must not connect to page CDP or fetch content"
                );
                paths
            });
            let accesses = Arc::new(Mutex::new(Vec::new()));
            let context = crate::InvocationContext::new("fixture", "turn")
                .with_browser_authorization(Arc::new(PathPolicyFixture {
                    site_allowed,
                    accesses: accesses.clone(),
                }));
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
            let cancellation = CancellationToken::new();
            let bound = browsers
                .invoke(
                    Command::BrowserTab {
                        browser_id: "fixture".into(),
                        reference: BrowserTabReference::Existing("page".into()),
                    },
                    &context,
                    &crate::cursor::Spec::default(),
                    &cancellation,
                    Language::En,
                )
                .await
                .unwrap();
            let Handle::Tab(handle) = serde_json::from_value(bound["handle"].clone()).unwrap()
            else {
                unreachable!()
            };
            let result = tokio::time::timeout(
                Duration::from_secs(5),
                browsers
                    .targets
                    .get_mut(&handle)
                    .unwrap()
                    .authorize_download_path(&context, &cancellation, Language::En),
            )
            .await
            .expect("finite metadata preflight");
            assert_eq!(result.is_ok(), succeeds, "{url}: {result:?}");
            {
                let accesses = accesses.lock().unwrap();
                assert_eq!(
                    accesses
                        .iter()
                        .filter(|access| matches!(access, crate::BrowserAccess::Read { .. }))
                        .count(),
                    reads,
                    "only the HTTP(S) current URL uses site consent: {url}"
                );
                assert!(accesses.iter().all(|access| matches!(
                    access,
                    crate::BrowserAccess::Metadata { .. } | crate::BrowserAccess::Read { .. }
                )));
            }
            assert_eq!(server.await.unwrap().len(), inventories * 2);
        }
    }

    #[tokio::test]
    async fn download_path_rechecks_actual_target_url_after_host_consent() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let before = [json!({
                "id":"page", "title":"Before", "url":"https://source.example/",
                "type":"page"
            })];
            let after = [json!({
                "id":"page", "title":"After", "url":"https://replacement.example/",
                "type":"page"
            })];
            let mut paths = serve_inventory(&listener, &before).await;
            paths.extend(serve_inventory(&listener, &before).await);
            paths.extend(serve_inventory(&listener, &after).await);
            assert!(
                tokio::time::timeout(Duration::from_millis(30), listener.accept())
                    .await
                    .is_err(),
                "replacement URL must be rejected before any page connection"
            );
            paths
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
        let (context, accesses) = decision_context(true);
        let cancellation = CancellationToken::new();
        let bound = browsers
            .invoke(
                Command::BrowserTab {
                    browser_id: "fixture".into(),
                    reference: BrowserTabReference::Existing("page".into()),
                },
                &context,
                &crate::cursor::Spec::default(),
                &cancellation,
                Language::En,
            )
            .await
            .unwrap();
        let Handle::Tab(handle) = serde_json::from_value(bound["handle"].clone()).unwrap() else {
            unreachable!()
        };
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            browsers
                .targets
                .get_mut(&handle)
                .unwrap()
                .authorize_download_path(&context, &cancellation, Language::En),
        )
        .await
        .expect("finite replacement metadata preflight");
        assert!(matches!(result, Err(ToolError::Failed(message))
            if message == "download source URL or target changed during path authorization; retry the lookup"));
        {
            let accesses = accesses.lock().unwrap();
            assert!(
                matches!(accesses.as_slice(), [
                crate::BrowserAccess::Metadata { document: metadata },
                crate::BrowserAccess::Read { document: source },
            ] if metadata.url == "https://source.example/"
                && source == metadata),
                "only the original source was admitted: {accesses:?}"
            );
            assert!(
                accesses
                    .iter()
                    .all(|access| access.document().url != "https://replacement.example/"),
                "the replacement must not borrow the original source's consent"
            );
        }
        assert_eq!(server.await.unwrap().len(), 6);
    }

    async fn metadata_reply(
        socket: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
        expected: &str,
        result: Value,
    ) -> Value {
        use futures_util::{SinkExt, StreamExt};
        let request: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(request["method"], expected);
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({"id":request["id"],"result":result})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        request
    }

    fn source_frame(loader: &str) -> Value {
        json!({"frameTree":{"frame":{
            "id":"main", "loaderId":loader, "url":"https://source.example/",
        }}})
    }

    #[tokio::test]
    async fn host_authorization_revalidates_the_current_url_after_consent() {
        use futures_util::StreamExt;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (context, accesses) = decision_context(true);
        let approved = accesses.clone();
        let server = tokio::spawn(async move {
            let before = [json!({
                "id":"page", "title":"Before", "url":"https://source.example/", "type":"page",
                "webSocketDebuggerUrl":format!("ws://{address}/devtools/page/page"),
            })];
            let after = [json!({
                "id":"page", "title":"After", "url":"https://replacement.example/", "type":"page",
                "webSocketDebuggerUrl":format!("ws://{address}/devtools/page/page"),
            })];
            let mut paths = Vec::new();
            for _ in 0..4 {
                paths.extend(serve_inventory(&listener, &before).await);
            }
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            assert!(
                matches!(
                    approved.lock().unwrap().as_slice(),
                    [crate::BrowserAccess::Metadata { .. }]
                ),
                "only metadata transport is admitted before the source snapshot"
            );
            metadata_reply(&mut socket, "Page.getFrameTree", source_frame("source")).await;
            // This inventory starts only after the actual Navigate approval.
            paths.extend(serve_inventory(&listener, &after).await);
            assert!(matches!(
                approved.lock().unwrap().as_slice(),
                [
                    crate::BrowserAccess::Metadata { .. },
                    crate::BrowserAccess::Navigate { .. },
                ]
            ));
            if let Ok(Some(Ok(message))) =
                tokio::time::timeout(Duration::from_millis(100), socket.next()).await
            {
                assert!(
                    message.is_close(),
                    "replacement received a page command after consent: {message:?}"
                );
            }
            paths
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
        assert!(matches!(result, Err(ToolError::Failed(message))
            if message == "document changed during browser authorization; retry the operation"));
        {
            let accesses = accesses.lock().unwrap();
            assert!(
                matches!(accesses.as_slice(), [
                crate::BrowserAccess::Metadata { document: metadata },
                crate::BrowserAccess::Navigate { document: source, url },
            ] if source == metadata && source.url == "https://source.example/"
                && url == "https://destination.example/path"),
                "replacement content must not receive the source's navigation consent: {accesses:?}"
            );
        }
        assert_eq!(server.await.unwrap().len(), 10);
    }

    #[tokio::test]
    async fn navigation_binds_its_source_across_consent_and_rechecks_before_dispatch() {
        use futures_util::StreamExt;
        for replacement in [None, Some("during-consent"), Some("before-dispatch")] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let (context, accesses) = decision_context(true);
            let approved = accesses.clone();
            let server = tokio::spawn(async move {
                let tab = [json!({
                    "id":"page", "title":"Same URL", "url":"https://source.example/", "type":"page",
                    "webSocketDebuggerUrl":format!("ws://{address}/devtools/page/page"),
                })];
                let mut paths = Vec::new();
                for _ in 0..4 {
                    paths.extend(serve_inventory(&listener, &tab).await);
                }
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                assert!(matches!(
                    approved.lock().unwrap().as_slice(),
                    [crate::BrowserAccess::Metadata { .. }]
                ));
                let mut methods = Vec::new();
                metadata_reply(&mut socket, "Page.getFrameTree", source_frame("source")).await;
                methods.push("Page.getFrameTree");
                paths.extend(serve_inventory(&listener, &tab).await);
                assert!(
                    matches!(
                        approved.lock().unwrap().as_slice(),
                        [
                            crate::BrowserAccess::Metadata { .. },
                            crate::BrowserAccess::Navigate { .. },
                        ]
                    ),
                    "source metadata must never require content consent"
                );
                metadata_reply(
                    &mut socket,
                    "Page.getFrameTree",
                    source_frame(if replacement == Some("during-consent") {
                        "replacement"
                    } else {
                        "source"
                    }),
                )
                .await;
                methods.push("Page.getFrameTree");
                if replacement != Some("during-consent") {
                    metadata_reply(
                        &mut socket,
                        "Page.getFrameTree",
                        source_frame(if replacement == Some("before-dispatch") {
                            "replacement"
                        } else {
                            "source"
                        }),
                    )
                    .await;
                    methods.push("Page.getFrameTree");
                    if replacement.is_none() {
                        let request =
                            metadata_reply(&mut socket, "Page.navigate", json!({"frameId":"main"}))
                                .await;
                        assert_eq!(request["params"]["url"], "https://destination.example/path");
                        methods.push("Page.navigate");
                    }
                }
                if let Ok(Some(Ok(message))) =
                    tokio::time::timeout(Duration::from_millis(100), socket.next()).await
                {
                    assert!(
                        message.is_close(),
                        "navigation or a content command escaped the source fence: {message:?}"
                    );
                }
                (paths, methods)
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
            if replacement.is_some() {
                assert!(matches!(result, Err(ToolError::Failed(message))
                    if message == "document changed before navigation dispatch; retry the operation"));
            } else {
                assert!(result.is_ok(), "{result:?}");
            }
            let (paths, methods) = server.await.unwrap();
            assert_eq!(paths.len(), 10);
            assert_eq!(
                methods.len(),
                match replacement {
                    None => 4,
                    Some("during-consent") => 2,
                    Some("before-dispatch") => 3,
                    _ => unreachable!(),
                }
            );
            assert!(
                !accesses.lock().unwrap().iter().any(|access| matches!(
                    access,
                    crate::BrowserAccess::Read { .. } | crate::BrowserAccess::ReadDocument { .. }
                )),
                "navigation must not authorize reading the source or replacement content"
            );
        }
    }

    async fn inventory_provider(
        id: &str,
        rounds: usize,
        tabs: Vec<Value>,
    ) -> (
        BrowserConnection,
        String,
        tokio::task::JoinHandle<Vec<String>>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let connection = BrowserConnection {
            id: id.into(),
            endpoint: format!("http://{address}"),
        };
        let generation = format!("ws://{address}/devtools/browser/fixture");
        let server = tokio::spawn(async move {
            let mut paths = Vec::new();
            for _ in 0..rounds {
                paths.extend(serve_inventory(&listener, &tabs).await);
            }
            paths
        });
        (connection, generation, server)
    }

    async fn quarantine_inventory(
        browsers: &Browsers,
        provider: &BrowserConnection,
        generation: &str,
    ) {
        browsers.host().await.lock().await.creation_unknown(
            BrowserIdentity::new(provider, generation).unwrap(),
            browsers.owner,
            "original-turn",
            provider.clone(),
            generation.into(),
        );
    }

    #[tokio::test]
    async fn healthy_browser_discovery_and_opencli_preference_keep_other_provider_uncertainty() {
        for unhealthy_first in [true, false] {
            let (healthy, _, healthy_server) = inventory_provider("actual-cdp", 3, vec![]).await;
            let (unhealthy, generation, unhealthy_server) =
                inventory_provider("unconfirmed-cdp", 3, vec![]).await;
            let mut browsers = Browsers::default();
            let connections = if unhealthy_first {
                vec![unhealthy.clone(), healthy]
            } else {
                vec![healthy, unhealthy.clone()]
            };
            browsers.configure(connections, Language::En).unwrap();
            quarantine_inventory(&browsers, &unhealthy, &generation).await;
            let context = crate::InvocationContext::new("fixture", "selection-turn");
            let cursor = crate::cursor::Spec::default();
            let cancellation = CancellationToken::new();
            let listed = browsers
                .invoke(
                    Command::ListBrowsers {
                        options: InventoryOptions::default(),
                    },
                    &context,
                    &cursor,
                    &cancellation,
                    Language::En,
                )
                .await
                .unwrap();
            assert_eq!(listed.as_array().unwrap().len(), 1);
            assert_eq!(listed[0]["id"], "actual-cdp");
            assert!(listed[0].get("tabs").is_none());
            let (state, errors) = browsers.state().await;
            assert_eq!(state.len(), 1);
            assert_eq!(state[0]["id"], "actual-cdp");
            assert_eq!(errors.len(), 1);
            assert!(errors[0].starts_with("unconfirmed-cdp: tool cleanup unconfirmed:"));
            let selected = browsers
                .invoke(
                    Command::GetBrowser {
                        options: BrowserOptions {
                            id: Some("opencli".into()),
                            url: None,
                            extension_instance_id: None,
                        },
                    },
                    &context,
                    &cursor,
                    &cancellation,
                    Language::En,
                )
                .await
                .unwrap();
            assert_eq!(selected, listed[0]);
            assert_eq!(selected["type"], "cdp");
            assert!(browsers.targets.is_empty());
            assert_eq!(
                browsers.host().await.lock().await.uncertain_creations.len(),
                1
            );
            assert_eq!(healthy_server.await.unwrap().len(), 6);
            assert_eq!(unhealthy_server.await.unwrap().len(), 6);
        }
    }

    #[tokio::test]
    async fn unavailable_browser_discovery_preserves_the_original_typed_uncertainty() {
        for unhealthy_first in [true, false] {
            let (invalid, _, invalid_server) =
                inventory_provider("invalid-cdp", 2, vec![Value::Null]).await;
            let (unhealthy, generation, unhealthy_server) =
                inventory_provider("unconfirmed-cdp", 2, vec![]).await;
            let mut browsers = Browsers::default();
            let connections = if unhealthy_first {
                vec![unhealthy.clone(), invalid]
            } else {
                vec![invalid, unhealthy.clone()]
            };
            browsers.configure(connections, Language::En).unwrap();
            quarantine_inventory(&browsers, &unhealthy, &generation).await;
            for command in [
                Command::ListBrowsers {
                    options: InventoryOptions::default(),
                },
                Command::GetBrowser {
                    options: BrowserOptions {
                        id: Some("opencli".into()),
                        url: None,
                        extension_instance_id: None,
                    },
                },
            ] {
                let result = browsers
                    .invoke(
                        command,
                        &crate::InvocationContext::new("fixture", "selection-turn"),
                        &crate::cursor::Spec::default(),
                        &CancellationToken::new(),
                        Language::En,
                    )
                    .await;
                assert!(matches!(result, Err(ToolError::CleanupUnconfirmed(message))
                    if message == "a browser tab creation has an unknown outcome; its targets cannot be reassigned"));
            }
            assert!(browsers.targets.is_empty());
            assert_eq!(
                browsers.host().await.lock().await.uncertain_creations.len(),
                1
            );
            assert_eq!(invalid_server.await.unwrap().len(), 4);
            assert_eq!(unhealthy_server.await.unwrap().len(), 4);
        }
    }

    #[tokio::test]
    async fn opencli_preference_refuses_multiple_healthy_browsers() {
        let (first, _, first_server) = inventory_provider("first-cdp", 1, vec![]).await;
        let (second, _, second_server) = inventory_provider("second-cdp", 1, vec![]).await;
        let mut browsers = Browsers::default();
        browsers
            .configure(vec![first, second], Language::En)
            .unwrap();
        let result = browsers
            .invoke(
                Command::GetBrowser {
                    options: BrowserOptions {
                        id: Some("opencli".into()),
                        url: None,
                        extension_instance_id: None,
                    },
                },
                &crate::InvocationContext::new("fixture", "selection-turn"),
                &crate::cursor::Spec::default(),
                &CancellationToken::new(),
                Language::En,
            )
            .await;
        assert!(matches!(result, Err(ToolError::Failed(message))
            if message == "browser selection is ambiguous or missing; select an ID from listBrowsers"));
        assert!(browsers.targets.is_empty());
        assert_eq!(first_server.await.unwrap().len(), 2);
        assert_eq!(second_server.await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn exact_browser_ids_and_extension_instances_never_probe_a_fallback() {
        for (id, instance, exact_present, uncertain) in [
            ("opencli", None, true, false),
            ("opencli", None, true, true),
            ("maka:missing-instance", None, false, false),
            ("opencli", Some("fixed-instance"), false, false),
        ] {
            let unrelated = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut connections = vec![BrowserConnection {
                id: "unrelated-cdp".into(),
                endpoint: format!("http://{}", unrelated.local_addr().unwrap()),
            }];
            let exact = if exact_present {
                let (provider, generation, server) = inventory_provider(id, 1, vec![]).await;
                connections.push(provider.clone());
                Some((provider, generation, server))
            } else {
                None
            };
            let mut browsers = Browsers::default();
            browsers.configure(connections, Language::En).unwrap();
            if uncertain {
                let (provider, generation, _) = exact.as_ref().unwrap();
                quarantine_inventory(&browsers, provider, generation).await;
            }
            let result = browsers
                .invoke(
                    Command::GetBrowser {
                        options: BrowserOptions {
                            id: Some(id.into()),
                            url: None,
                            extension_instance_id: instance.map(str::to_owned),
                        },
                    },
                    &crate::InvocationContext::new("fixture", "selection-turn"),
                    &crate::cursor::Spec::default(),
                    &CancellationToken::new(),
                    Language::En,
                )
                .await;
            if uncertain {
                assert!(matches!(result, Err(ToolError::CleanupUnconfirmed(_))));
                assert_eq!(
                    browsers.host().await.lock().await.uncertain_creations.len(),
                    1
                );
            } else if exact_present {
                assert_eq!(result.unwrap()["id"], id);
            } else {
                assert!(matches!(result, Err(ToolError::Failed(message))
                    if message.starts_with("browser_unavailable:")));
            }
            assert!(
                tokio::time::timeout(Duration::from_millis(50), unrelated.accept())
                    .await
                    .is_err()
            );
            assert!(browsers.targets.is_empty());
            if let Some((_, _, server)) = exact {
                assert_eq!(server.await.unwrap().len(), 2);
            }
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
            assert_eq!(value["id"], "fixture");
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
            json!({"titleJson":"\"After\"","url":"https://example.com/current"})
        );
        assert_eq!(
            server.await.unwrap(),
            ["/json/version", "/json/list", "/json/version", "/json/list"]
        );
    }

    #[tokio::test]
    async fn lazy_cdp_connection_obeys_read_deadline_and_cancellation_and_closes_its_socket() {
        for cancel_at_handshake in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let cancellation = CancellationToken::new();
            let cancelled = cancellation.clone();
            let server = tokio::spawn(async move {
                let tabs = [
                    json!({"id":"page","title":"Fixture","url":"https://example.com/","type":"page","webSocketDebuggerUrl":format!("ws://{address}/devtools/page/page")}),
                ];
                serve_inventory(&listener, &tabs).await;
                let (stream, _) = listener.accept().await.unwrap();
                let mut stream = BufReader::new(stream);
                let mut line = String::new();
                stream.read_line(&mut line).await.unwrap();
                assert!(line.starts_with("GET /devtools/page/page "));
                loop {
                    line.clear();
                    assert_ne!(stream.read_line(&mut line).await.unwrap(), 0);
                    if line == "\r\n" {
                        break;
                    }
                }
                if cancel_at_handshake {
                    cancelled.cancel();
                }
                // Never upgrade: deadline/cancellation must drop the actual
                // connecting socket, without dispatching a CDP request.
                let mut bytes = [0; 1];
                assert_eq!(stream.read(&mut bytes).await.unwrap(), 0);
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
            let bound = browsers
                .invoke(
                    Command::BrowserTab {
                        browser_id: "fixture".into(),
                        reference: BrowserTabReference::Existing("page".into()),
                    },
                    &decision_context(true).0,
                    &cursor,
                    &cancellation,
                    Language::En,
                )
                .await
                .unwrap();
            let Handle::Tab(handle) = serde_json::from_value(bound["handle"].clone()).unwrap()
            else {
                panic!("binding must return a tab handle");
            };
            let tab = browsers.targets.get_mut(&handle).unwrap();
            assert!(tab.socket.is_none(), "binding must remain lazy");
            let mut budget = Some(ReadBudget::new(&BrowserReadOptions {
                timeout_ms: Some(if cancel_at_handshake { 3000 } else { 200 }),
            }));
            // This is the same bounded connect used by metadata preparation;
            // inventory and consent have their own behavior tests.
            let result = tokio::time::timeout(
                Duration::from_secs(2),
                read_step(&mut budget, &cancellation, tab.connect_metadata()),
            )
            .await
            .expect("the connecting socket escaped its read deadline or cancellation");
            let expected = if cancel_at_handshake {
                "Browser read cancelled"
            } else {
                "Playwright selector deadline exceeded"
            };
            assert!(
                matches!(&result, Err(ToolError::Failed(message)) if message == expected),
                "{result:?}"
            );
            assert!(
                tab.socket.is_none(),
                "a failed handshake cannot retain a socket"
            );
            tokio::time::timeout(Duration::from_secs(1), server)
                .await
                .expect("the fixture must see the handshake socket close")
                .unwrap();
            browsers.close(&cursor).await.unwrap();
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
        let fixture_browser = Cdp::connect(&generation, &provider).await.unwrap();
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
            "old extension cleanup must not remove the newest cursor"
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

#[cfg(test)]
mod title_string_tests {
    use super::*;

    #[test]
    fn direct_inventory_parses_raw_title_before_any_generic_value() {
        let bytes = br#"[{"id":"page","title":"\ud800 title \udc00 \\ud800","url":"https://fixture.test/","type":"page"}]"#;
        let tabs: Vec<TabInfo> = serde_json::from_slice(bytes).unwrap();
        assert_eq!(tabs[0].title.json(), r#""\ud800 title \udc00 \\ud800""#);
        let provider = Provider::Cdp(BrowserConnection {
            id: "direct".into(),
            endpoint: "http://127.0.0.1".into(),
        });
        let metadata = tab_info(&provider, &tabs[0]);
        assert_eq!(metadata["titleJson"], r#""\ud800 title \udc00 \\ud800""#);
        assert!(metadata.get("title").is_none());
        assert_eq!(metadata["id"], "direct:page");
        for invalid in [
            br#"[{"id":"page","title":null,"url":"https://fixture.test/","type":"page"}]"#
                .as_slice(),
            br#"[{"id":"page","title":"ok","url":"https://fixture.test/"}]"#.as_slice(),
        ] {
            assert!(serde_json::from_slice::<Vec<TabInfo>>(invalid).is_err());
        }
    }
}
