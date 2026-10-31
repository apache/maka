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

//! Waits reuse the admitted page's existing CDP and Playwright utility.

use super::*;
use crate::protocol::BrowserWaitOperation;
use cua_driver_core::browser::cdp_ws::CdpEvent;
use futures_util::FutureExt;
use tokio::sync::mpsc;

type Events = mpsc::UnboundedReceiver<CdpEvent>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LocatorState {
    Attached,
    Detached,
    Visible,
    Hidden,
}
impl LocatorState {
    fn name(self) -> &'static str {
        match self {
            Self::Attached => "attached",
            Self::Detached => "detached",
            Self::Visible => "visible",
            Self::Hidden => "hidden",
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
enum LoadState {
    Load,
    DomContentLoaded,
    NetworkIdle,
    Other(String),
}
impl LoadState {
    fn from_value(value: Option<&Value>) -> Self {
        match value {
            None | Some(Value::Null) => Self::Load,
            Some(Value::String(value)) if value == "load" => Self::Load,
            Some(Value::String(value)) if value == "domcontentloaded" => Self::DomContentLoaded,
            Some(Value::String(value)) if value == "networkidle" => Self::NetworkIdle,
            Some(value) => Self::Other(js_string(value)),
        }
    }
    fn label(&self) -> &str {
        match self {
            Self::Load => "load",
            Self::DomContentLoaded => "domcontentloaded",
            Self::NetworkIdle => "networkidle",
            Self::Other(value) => value,
        }
    }
    fn ready(&self, state: &str) -> bool {
        state == "complete" || (matches!(self, Self::DomContentLoaded) && state == "interactive")
    }
    fn accepts(&self, event: &CdpEvent) -> bool {
        event.session_id.is_none()
            && (event.method == "Page.loadEventFired"
                || (matches!(self, Self::DomContentLoaded)
                    && event.method == "Page.domContentEventFired"))
    }
}

pub(super) fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    String::new()
                } else {
                    js_string(value)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
        _ => value.to_string(),
    }
}
fn timeout(value: Option<&Value>) -> Duration {
    Duration::from_secs_f64(
        value
            .and_then(Value::as_f64)
            .unwrap_or(3000.0)
            .clamp(0.0, 3000.0)
            / 1000.0,
    )
}

struct Glob(regex::Regex);
impl Glob {
    fn new(pattern: &str) -> Result<Self, ToolError> {
        let mut expression = String::from(r"\A");
        let mut chars = pattern.chars().peekable();
        while let Some(character) = chars.next() {
            if character == '*' {
                if chars.peek() == Some(&'*') {
                    chars.next();
                    // ECMAScript dot without the s flag excludes these four line terminators.
                    expression.push_str(r"[^\n\r\x{2028}\x{2029}]*");
                } else {
                    expression.push_str("[^/]*");
                }
            } else {
                expression.push_str(&regex::escape(&character.to_string()));
            }
        }
        expression.push_str(r"\z");
        regex::Regex::new(&expression).map(Self).map_err(failed)
    }
    fn matches(&self, value: &str) -> bool {
        self.0.is_match(value)
    }
}

enum Plan {
    Locator {
        locator: LocatorPlan,
        state: LocatorState,
        timeout: Duration,
    },
    Url {
        pattern: String,
        matcher: Glob,
        until: Option<LoadState>,
        timeout: Duration,
    },
    Load {
        state: LoadState,
        timeout: Duration,
    },
    Delay(Duration),
}
impl Plan {
    fn new(operation: BrowserWaitOperation) -> Result<Self, ToolError> {
        Ok(match operation {
            BrowserWaitOperation::Locator {
                locator,
                state,
                timeout_ms,
            } => {
                let state = match state.as_str() {
                    Some("attached") => LocatorState::Attached,
                    Some("detached") => LocatorState::Detached,
                    Some("visible") => LocatorState::Visible,
                    Some("hidden") => LocatorState::Hidden,
                    _ => {
                        return Err(failed(format!(
                            "Unsupported waitFor state: {}",
                            js_string(&state)
                        )));
                    }
                };
                Self::Locator {
                    locator,
                    state,
                    timeout: timeout(timeout_ms.as_ref()),
                }
            }
            BrowserWaitOperation::Url {
                url,
                wait_until,
                timeout_ms,
            } => {
                let pattern = url
                    .as_str()
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| failed("playwright_wait_for_url requires a url"))?
                    .to_owned();
                let until = match wait_until.as_ref().and_then(Value::as_str) {
                    Some("load") => Some(LoadState::Load),
                    Some("domcontentloaded") => Some(LoadState::DomContentLoaded),
                    Some("networkidle") => Some(LoadState::NetworkIdle),
                    _ => None,
                };
                Self::Url {
                    matcher: Glob::new(&pattern)?,
                    pattern,
                    until,
                    timeout: timeout(timeout_ms.as_ref()),
                }
            }
            BrowserWaitOperation::LoadState { state, timeout_ms } => Self::Load {
                state: LoadState::from_value(state.as_ref()),
                timeout: timeout(timeout_ms.as_ref()),
            },
            BrowserWaitOperation::Timeout { timeout_ms } => {
                let value = timeout_ms
                    .as_f64()
                    .filter(|value| value.is_finite() && *value >= 0.0 && value.fract() == 0.0)
                    .ok_or_else(|| {
                        failed("playwright.waitForTimeout requires a non-negative integer")
                    })?;
                // The selected Node runtime's setTimeout treats zero and overflow as 1ms.
                let millis = if !(1.0..=2_147_483_647.0).contains(&value) {
                    1
                } else {
                    value as u64
                };
                Self::Delay(Duration::from_millis(millis))
            }
        })
    }
}

fn required_completion(result: Result<Value, ToolError>) -> Result<(), ToolError> {
    match result {
        Err(
            error @ (ToolError::Persistence(_)
            | ToolError::CleanupUnconfirmed(_)
            | ToolError::OutcomeUnknown(_)
            | ToolError::OperationUnknown { .. }
            | ToolError::OperationCleanupUnconfirmed { .. }),
        ) => Err(error),
        _ => Ok(()),
    }
}

pub(super) async fn cancellable_observation<T>(
    effect: ReadEffect,
    cancellation: &CancellationToken,
    future: impl std::future::Future<Output = Result<T, ToolError>>,
) -> Result<T, ToolError> {
    let mut polled = false;
    let result = {
        let mut future = std::pin::pin!(future);
        let tracked = std::future::poll_fn(|context| {
            polled = true;
            future.as_mut().poll(context)
        });
        tokio::select! { biased;
            ()=cancellation.cancelled()=>None,
            result=tracked=>Some(result),
        }
    };
    match result {
        Some(result) => result,
        None if polled => Err(effect.interrupted("Browser wait cancelled")),
        None => Err(failed("Browser wait cancelled")),
    }
}

impl Browsers {
    pub(crate) async fn prepare_wait(
        &mut self,
        handle: Handle,
        operation: BrowserWaitOperation,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<crate::InvocationCompletion, ToolError> {
        let plan = Plan::new(operation)?;
        let Handle::Tab(handle) = handle else {
            return Err(failed("Browser waits require a browser tab"));
        };
        let identity = self
            .targets
            .get(&handle)
            .ok_or_else(|| failed("stale_tab: bind it again"))?
            .identity()?;
        let wait_cancellation = cancellation.child_token();
        let owned = invocation.capture();
        let stop_wait = wait_cancellation.clone();
        // The Windows worker obtains custody through its existing remote Host
        // services; its InvocationContext does not carry a direct settlement.
        let document = self
            .targets
            .get(&handle)
            .expect("checked browser wait handle")
            .document();
        let services = invocation
            .prepare_browser_services(crate::BrowserAccess::Metadata { document }, cancellation)
            .await?;
        let settlement = services
            .settlement
            .ok_or_else(|| failed("Browser waits require original Host settlement custody"))?;
        let future: futures_util::future::BoxFuture<'static, Result<Value, ToolError>> = match plan
        {
            Plan::Delay(duration) => Box::pin(async move {
                tokio::select! { biased;
                    ()=wait_cancellation.cancelled()=>Err(failed("Browser wait cancelled")),
                    ()=tokio::time::sleep(duration)=>Ok(Value::Null),
                }
            }),
            plan => {
                self.use_tab(&identity, invocation.turn(), cancellation)
                    .await?;
                let tab = self
                    .targets
                    .get_mut(&handle)
                    .expect("checked browser wait handle");
                tab.last_turn = invocation.turn().to_owned();
                tab.authorize(None, invocation, cancellation, language)
                    .await?;
                tab.verify(BrowserCall::new(invocation, cancellation, language))
                    .await?;
                // Subscribe before synchronizing the existing frame cache. Replayed
                // attach/detach notifications are handled by the same frame engine.
                let cdp = tab.socket.as_ref().expect("verified wait socket");
                let events = cdp.connection.subscribe();
                let frame_events = cdp.connection.subscribe();
                tab.attach_frames().await?;
                let mut page = tab.wait_observation_branch(frame_events)?;
                let effect = tab.read_effect()?;
                let wait_cancellation = wait_cancellation.clone();
                Box::pin(async move {
                    let context = owned.borrow();
                    let is_locator = matches!(plan, Plan::Locator { .. });
                    let observation =
                        page.run_wait(plan, events, &context, &wait_cancellation, language);
                    // Locator observation owns selector handles and performs its
                    // own cancellation followed by object-group cleanup.
                    let result = if is_locator {
                        observation.await
                    } else {
                        cancellable_observation(effect, &wait_cancellation, observation).await
                    };
                    result.map_err(|error| effect.read_failure(error))
                })
            }
        };
        let future = future.shared();
        let retained = future.clone();
        if let Err((error, pending)) =
            settlement.retain_checked(Box::pin(async move { required_completion(retained.await) }))
        {
            // No new operation or replay: drain this same observation on refusal.
            stop_wait.cancel();
            let _ = future.await;
            pending.await?;
            return Err(error);
        }
        Ok(crate::InvocationCompletion::pending(future))
    }
}

impl Tab {
    pub(in crate::browser) fn wait_observation_branch(
        &self,
        frame_events: Events,
    ) -> Result<Self, ToolError> {
        let socket = self
            .socket
            .as_ref()
            .ok_or_else(|| failed("tab connection unavailable"))?
            .clone();
        Ok(Self {
            provider: self.provider.clone(),
            generation: self.generation.clone(),
            info: self.info.clone(),
            frames: self.frames.observation_branch(frame_events),
            socket: Some(socket),
            socket_prepared: true,
            page_assets: Default::default(),
            origin_proof: None,
            navigation_admission: None,
            extension_claim: self.extension_claim.clone(),
            extension_wire: self.extension_wire.clone(),
            extension_host_operation: self.extension_host_operation.clone(),
            extension_acquisition: self.extension_acquisition.clone(),
            fixed_presentation: self.fixed_presentation.clone(),
            frame: self.frame.clone(),
            refs: HashMap::new(),
            ax: ax::Projection::default(),
            previous: None,
            navigation: None,
            cursor_world: None,
            cursor_epoch: self.cursor_epoch,
            cursor_owner: self.cursor_owner,
            cursor_host: self.cursor_host.clone(),
            cursor_spec: self.cursor_spec.clone(),
            last_turn: self.last_turn.clone(),
            dialogs: None,
            downloads: None,
            filechoosers: None,
            dialog_host: self.dialog_host.clone(),
            clipboard: None,
            clipboard_store: self.clipboard_store.clone(),
            clipboard_authorization: self.clipboard_authorization.clone(),
            attachment_settlement: self.attachment_settlement.clone(),
        })
    }

    async fn run_wait(
        &mut self,
        plan: Plan,
        mut events: Events,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        match plan {
            Plan::Locator {
                locator,
                state,
                timeout,
            } => {
                self.wait_locator(&locator, state, timeout, invocation, cancellation, language)
                    .await?
            }
            Plan::Load { state, timeout } => {
                self.wait_load(
                    state,
                    timeout,
                    &mut events,
                    invocation,
                    cancellation,
                    language,
                )
                .await?
            }
            Plan::Url {
                pattern,
                matcher,
                until,
                timeout,
            } => {
                self.request("Page.enable", json!({})).await?;
                let current = self
                    .wait_document_state(invocation, cancellation, language)
                    .await?;
                if !current["href"]
                    .as_str()
                    .is_some_and(|url| !url.is_empty() && matcher.matches(url))
                {
                    let main = match self.request("Page.getFrameTree", json!({})).await {
                        Ok(tree) => tree["frameTree"]["frame"]["id"].as_str().map(str::to_owned),
                        Err(ToolError::Failed(_)) => None,
                        Err(error) => return Err(error),
                    };
                    EventWait {
                        tab: &self.info.id,
                        timeout,
                        cancellation,
                    }
                    .url(
                        self.socket.as_ref().expect("verified wait socket"),
                        &pattern,
                        &matcher,
                        main.as_deref(),
                    )
                    .await?;
                }
                if let Some(state) = until {
                    // The follow-load stage starts its own observation. In particular,
                    // GD networkidle must not consume the URL stage's prior events.
                    events = self.wait_events()?;
                    // The selected service deliberately gives this second stage a full timeout.
                    self.wait_load(
                        state,
                        timeout,
                        &mut events,
                        invocation,
                        cancellation,
                        language,
                    )
                    .await?;
                }
            }
            Plan::Delay(_) => unreachable!("fixed delay needs no page connection"),
        }
        Ok(Value::Null)
    }

    fn wait_events(&self) -> Result<Events, ToolError> {
        Ok(self
            .socket
            .as_ref()
            .ok_or_else(|| failed("tab connection unavailable"))?
            .connection
            .subscribe())
    }

    async fn wait_document_state(
        &mut self,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        self.authorize(None, invocation, cancellation, language)
            .await?;
        let proof = self.document_origin().await?;
        let result = self.frame_observation(None, "Runtime.evaluate", json!({
            "uniqueContextId":proof.execution_context(),
            "expression":"({href:globalThis.location.href,readyState:globalThis.document.readyState})",
            "returnByValue":true,
        })).await?;
        proof.check_current(self).await?;
        cdp_value(result).map(|result| result["value"].clone())
    }

    async fn wait_locator(
        &mut self,
        locator: &LocatorPlan,
        state: LocatorState,
        timeout: Duration,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<(), ToolError> {
        let resources = Resources::new();
        let effect = self.read_effect()?;
        let mut remaining = timeout;
        let result = async {
            loop {
                check_input(cancellation)?;
                // Mechanical preparation spends the same budget; actual human
                // consent remains outside it, as in ordinary locator reads.
                let mut budget = (!timeout.is_zero()).then_some(ReadBudget { remaining });
                self.authorize_with_budget(None, invocation, cancellation, language,
                    extension::ClaimIntent::Implicit, &mut budget).await?;
                if let Some(budget) = budget { remaining = budget.remaining; }
                let proof = self.origin_proof.clone().ok_or_else(||failed("wait origin proof unavailable"))?;
                let began = tokio::time::Instant::now();
                let deadline = began + remaining;
                let attempt = async {
                    let scope = self.playwright_scope(&locator.selector, &resources).await?;
                    proof.check_current(self).await?;
                    let result = self.playwright_script(&scope.frame, json!({"selector":scope.segment.text,"parsedSelector":scope.segment.parsed,"operation":{"kind":"waitFor","state":state.name()}}), true, &resources).await?;
                    if !self.frame_scopes_current(&scope.used).await? {
                        return Err(AttemptError::Retry(failed("frame changed while waiting for locator")));
                    }
                    proof.check_current(self).await?;
                    read_reply(result["value"].clone())
                };
                let observed = if timeout.is_zero() {
                    tokio::select! { biased;
                        ()=cancellation.cancelled()=>return Err(effect.interrupted("Browser wait cancelled")),
                        result=attempt=>result,
                    }
                } else {
                    tokio::select! { biased;
                        ()=cancellation.cancelled()=>return Err(effect.interrupted("Browser wait cancelled")),
                        result=tokio::time::timeout_at(deadline,attempt)=>result.map_err(|_|effect.interrupted("Playwright selector deadline exceeded"))?,
                    }
                };
                remaining = remaining.saturating_sub(began.elapsed());
                let reason = match observed {
                    Ok(value) if value["ready"] == true => return Ok(()),
                    Ok(value) => value["reason"].as_str().unwrap_or("Element did not reach the requested state").to_owned(),
                    Err(AttemptError::Fatal(error)) => return Err(error),
                    Err(AttemptError::Retry(error)) => {
                        if effect.uncertain(&error) { return Err(error); }
                        error.to_string()
                    }
                };
                if timeout.is_zero() || remaining.is_zero() {
                    return Err(failed(format!("Timed out after {}ms waiting for selector {}: {reason}", timeout.as_millis(), locator.selector)));
                }
                let began = tokio::time::Instant::now();
                tokio::select! { biased;
                    ()=cancellation.cancelled()=>return Err(failed("Browser wait cancelled")),
                    ()=tokio::time::sleep(remaining.min(Duration::from_millis(100)))=>{},
                }
                remaining = remaining.saturating_sub(began.elapsed());
            }
        }.await;
        resources.cleanup(self).await;
        result
    }

    async fn wait_load(
        &mut self,
        state: LoadState,
        timeout: Duration,
        events: &mut Events,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<(), ToolError> {
        if matches!(state, LoadState::NetworkIdle) {
            return self.wait_network_idle(timeout, events, cancellation).await;
        }
        self.request("Page.enable", json!({})).await?;
        let document = self
            .wait_document_state(invocation, cancellation, language)
            .await?;
        if document["readyState"]
            .as_str()
            .is_some_and(|ready| state.ready(ready))
        {
            return Ok(());
        }
        EventWait {
            tab: &self.info.id,
            timeout,
            cancellation,
        }
        .load(self.socket.as_ref().expect("verified wait socket"), &state)
        .await
    }

    async fn wait_network_idle(
        &mut self,
        timeout: Duration,
        events: &mut Events,
        cancellation: &CancellationToken,
    ) -> Result<(), ToolError> {
        let deadline = tokio::time::Instant::now() + timeout;
        let message = format!("Timed out waiting for networkidle in tab {}.", self.info.id);
        if timeout.is_zero() {
            return Err(failed(message));
        }
        let effect = self.read_effect()?;
        let setup = async {
            self.request("Page.enable", json!({})).await?;
            let tree = self.request("Page.getFrameTree", json!({})).await?;
            let mut state = NetworkIdle::from_tree(&tree)?;
            while let Ok(event) = events.try_recv() {
                state.observe(&event)?;
            }
            self.request("Page.setLifecycleEventsEnabled", json!({"enabled":true}))
                .await?;
            Ok::<_, ToolError>(state)
        };
        let mut state = tokio::select! { biased;
            ()=cancellation.cancelled()=>return Err(effect.interrupted("Browser wait cancelled")),
            result=tokio::time::timeout_at(deadline,setup)=>result.map_err(|_|effect.interrupted(&message))??,
        };
        loop {
            if tokio::time::Instant::now() >= deadline {
                return Err(failed(&message));
            }
            if state.idle {
                return Ok(());
            }
            state.observe(
                &wait_event(
                    events,
                    deadline,
                    cancellation,
                    &message,
                    &format!(
                        "Tab {} detached while waiting for networkidle.",
                        self.info.id
                    ),
                )
                .await?,
            )?;
        }
    }
}

// Generic URL/load observation begins only after the caller's current-state
// probe. Networkidle intentionally uses its separate listener-before-setup path.
struct EventWait<'a> {
    tab: &'a str,
    timeout: Duration,
    cancellation: &'a CancellationToken,
}
impl EventWait<'_> {
    async fn url(
        &self,
        socket: &Cdp,
        pattern: &str,
        matcher: &Glob,
        main: Option<&str>,
    ) -> Result<(), ToolError> {
        let mut events = socket.connection.subscribe();
        let deadline = tokio::time::Instant::now() + self.timeout;
        let message = format!("Timed out waiting for URL {pattern} in tab {}.", self.tab);
        loop {
            let event = wait_event(
                &mut events,
                deadline,
                self.cancellation,
                &message,
                "Browser tab detached while waiting",
            )
            .await?;
            if event.session_id.is_some() {
                continue;
            }
            navigation_error(&event)?;
            if url_from_event(&event, main, matcher).is_some() {
                return Ok(());
            }
        }
    }

    async fn load(&self, socket: &Cdp, state: &LoadState) -> Result<(), ToolError> {
        let mut events = socket.connection.subscribe();
        let deadline = tokio::time::Instant::now() + self.timeout;
        let message = format!(
            "Timed out waiting for {} in tab {}.",
            state.label(),
            self.tab
        );
        loop {
            let event = wait_event(
                &mut events,
                deadline,
                self.cancellation,
                &message,
                "Browser tab detached while waiting",
            )
            .await?;
            if event.session_id.is_some() {
                continue;
            }
            navigation_error(&event)?;
            if state.accepts(&event) {
                return Ok(());
            }
        }
    }
}

async fn wait_event(
    events: &mut Events,
    deadline: tokio::time::Instant,
    cancellation: &CancellationToken,
    timeout_message: &str,
    detached_message: &str,
) -> Result<CdpEvent, ToolError> {
    tokio::select! { biased;
        ()=cancellation.cancelled()=>Err(failed("Browser wait cancelled")),
        result=tokio::time::timeout_at(deadline,events.recv())=>result.map_err(|_|failed(timeout_message))?.ok_or_else(||failed(detached_message)),
    }
}
pub(super) fn navigation_error(event: &CdpEvent) -> Result<(), ToolError> {
    navigation_error_including_subframes(event, false)
}
pub(super) fn navigation_error_including_subframes(
    event: &CdpEvent,
    reject_subframes: bool,
) -> Result<(), ToolError> {
    if event.method != "Page.navigationBlocked"
        || !reject_subframes && event.params["resourceType"] == "subFrame"
    {
        return Ok(());
    }
    let url = event.params["url"]
        .as_str()
        .and_then(|value| {
            let mut url = reqwest::Url::parse(value).ok()?;
            if !matches!(url.scheme(), "http" | "https") {
                return None;
            }
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.set_query(None);
            url.set_fragment(None);
            let root = url.path() == "/";
            let url = url.to_string();
            Some(if root {
                url.trim_end_matches('/').to_owned()
            } else {
                url
            })
        })
        .unwrap_or_else(|| "this page".into());
    Err(failed(format!("Browser Use is not permitted on {url}.")))
}
fn url_from_event<'a>(event: &'a CdpEvent, main: Option<&str>, matcher: &Glob) -> Option<&'a str> {
    if event.session_id.is_some() {
        return None;
    }
    if event.method == "Page.navigatedWithinDocument" {
        return event.params["url"]
            .as_str()
            .filter(|url| matcher.matches(url));
    }
    if event.method != "Page.frameNavigated" {
        return None;
    }
    let frame = &event.params["frame"];
    if main.map_or_else(|| !frame["parentId"].is_null(), |main| frame["id"] != main) {
        return None;
    }
    frame["url"].as_str().filter(|url| matcher.matches(url))
}
struct NetworkIdle {
    id: String,
    loader: Option<String>,
    idle: bool,
}
impl NetworkIdle {
    fn from_tree(tree: &Value) -> Result<Self, ToolError> {
        let frame = &tree["frameTree"]["frame"];
        Ok(Self {
            id: frame["id"]
                .as_str()
                .ok_or_else(|| failed("missing main frame"))?
                .to_owned(),
            loader: frame["loaderId"].as_str().map(str::to_owned),
            idle: false,
        })
    }
    fn observe(&mut self, event: &CdpEvent) -> Result<(), ToolError> {
        if event.session_id.is_some() || event.source_target_id.is_some() {
            return Ok(());
        }
        navigation_error(event)?;
        if event.method == "Page.frameNavigated" && event.params["frame"]["parentId"].is_null() {
            let frame = &event.params["frame"];
            if let Some(id) = frame["id"].as_str() {
                let loader = frame["loaderId"].as_str().map(str::to_owned);
                if self.id != id || self.loader != loader {
                    self.id = id.to_owned();
                    self.loader = loader;
                    self.idle = false;
                }
            }
        } else if event.method == "Page.lifecycleEvent"
            && event.params["name"] == "networkIdle"
            && event.params["frameId"] == self.id
            && event.params["loaderId"].as_str() == self.loader.as_deref()
        {
            self.idle = true;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(method: &str, params: Value) -> CdpEvent {
        CdpEvent {
            method: method.into(),
            params,
            session_id: None,
            source_target_id: None,
            params_json: None,
        }
    }
    fn frame() -> NetworkIdle {
        NetworkIdle::from_tree(&json!({"frameTree":{"frame":{"id":"main","loaderId":"first"}}}))
            .unwrap()
    }

    #[test]
    fn glob_language_preserves_slashes_literals_case_and_javascript_dot() {
        for (pattern, value, expected) in [
            ("https://e.test/*", "https://e.test/a", true),
            ("https://e.test/*", "https://e.test/a/b", false),
            ("https://e.test/**", "https://e.test/a/b", true),
            ("https://e.test/**", "https://e.test/", true),
            ("https://e.test/{a,b}", "https://e.test/a", false),
            ("https://e.test/{a,b}", "https://e.test/{a,b}", true),
            ("https://e.test/?", "https://e.test/x", false),
            ("https://e.test/?", "https://e.test/?", true),
            ("https://e.test/a[1](x)+", "https://e.test/a[1](x)+", true),
            ("https://E.test/**", "https://e.test/path", false),
            ("**", "x\ny", false),
            ("**", "x\ry", false),
            ("**", "x\u{2028}y", false),
            ("**", "x\u{2029}y", false),
            ("*", "x\ny", true),
            ("**🔥", "https://e.test/🔥", true),
        ] {
            assert_eq!(
                Glob::new(pattern).unwrap().matches(value),
                expected,
                "pattern={pattern:?}, value={value:?}"
            );
        }
    }

    #[test]
    fn network_idle_requires_real_main_frame_and_loader_not_readystate_or_child_events() {
        let mut state = frame();
        for params in [
            json!({"name":"networkIdle","frameId":"child","loaderId":"first"}),
            json!({"name":"networkIdle","frameId":"main","loaderId":"other"}),
            json!({"name":"DOMContentLoaded","frameId":"main","loaderId":"first"}),
        ] {
            state
                .observe(&event("Page.lifecycleEvent", params))
                .unwrap();
            assert!(!state.idle);
        }
        let mut child = event(
            "Page.lifecycleEvent",
            json!({"name":"networkIdle","frameId":"main","loaderId":"first"}),
        );
        child.session_id = Some("flattened-child".into());
        state.observe(&child).unwrap();
        assert!(!state.idle);
        child.session_id = None;
        child.source_target_id = Some("actual-auxiliary-target".into());
        state.observe(&child).unwrap();
        assert!(!state.idle);
        state
            .observe(&event(
                "Page.lifecycleEvent",
                json!({"name":"networkIdle","frameId":"main","loaderId":"first"}),
            ))
            .unwrap();
        assert!(state.idle);
    }
    #[test]
    fn navigation_resets_network_idle_and_old_loader_cannot_finish_new_document() {
        let mut state = frame();
        state
            .observe(&event(
                "Page.lifecycleEvent",
                json!({"name":"networkIdle","frameId":"main","loaderId":"first"}),
            ))
            .unwrap();
        assert!(state.idle);
        state
            .observe(&event(
                "Page.frameNavigated",
                json!({"frame":{"id":"main","loaderId":"second"}}),
            ))
            .unwrap();
        assert!(!state.idle);
        state
            .observe(&event(
                "Page.lifecycleEvent",
                json!({"name":"networkIdle","frameId":"main","loaderId":"first"}),
            ))
            .unwrap();
        assert!(!state.idle);
        state
            .observe(&event(
                "Page.lifecycleEvent",
                json!({"name":"networkIdle","frameId":"main","loaderId":"second"}),
            ))
            .unwrap();
        assert!(state.idle);
    }

    #[test]
    fn failed_wait_does_not_erase_required_unknown_settlement() {
        assert!(
            required_completion(Err(unknown("accepted preparation remains uncertain"))).is_err()
        );
        assert!(required_completion(Err(failed("ordinary wait timed out"))).is_ok());
    }
    #[tokio::test]
    async fn cancelled_wait_wins_even_if_an_event_is_already_queued() {
        let (sender, mut events) = mpsc::unbounded_channel();
        sender
            .send(event("Page.loadEventFired", json!({})))
            .unwrap();
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let result = wait_event(
            &mut events,
            tokio::time::Instant::now() + Duration::from_secs(1),
            &cancellation,
            "timeout",
            "detached",
        )
        .await;
        assert!(result.unwrap_err().to_string().contains("cancelled"));
        assert_eq!(events.try_recv().unwrap().method, "Page.loadEventFired");
    }
    #[tokio::test]
    async fn event_subscription_keeps_an_early_observation_without_another_command() {
        let (sender, mut events) = mpsc::unbounded_channel();
        sender
            .send(event("Page.loadEventFired", json!({})))
            .unwrap();
        let cancellation = CancellationToken::new();
        assert_eq!(
            wait_event(
                &mut events,
                tokio::time::Instant::now() + Duration::from_secs(1),
                &cancellation,
                "timeout",
                "detached"
            )
            .await
            .unwrap()
            .method,
            "Page.loadEventFired"
        );
    }

    async fn stale_event_cannot_finish_new_generic_wait(url_wait: bool) {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let wire_event = if url_wait {
            json!({"method":"Page.frameNavigated","params":{"frame":{"id":"main","url":"https://e.test/next"}}})
        } else {
            json!({"method":"Page.loadEventFired","params":{}})
        };
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut wire = tokio_tungstenite::accept_async(stream).await.unwrap();
            while let Some(Ok(Message::Text(text))) = wire.next().await {
                let request: Value = serde_json::from_str(&text).unwrap();
                wire.send(Message::Text(wire_event.to_string().into()))
                    .await
                    .unwrap();
                wire.send(Message::Text(
                    json!({"id":request["id"],"result":{}}).to_string().into(),
                ))
                .await
                .unwrap();
            }
        });
        let socket = Cdp::connect(
            &format!("ws://{address}"),
            &BrowserConnection {
                id: "fixture".into(),
                endpoint: format!("http://{address}"),
            },
        )
        .await
        .unwrap();
        let mut old_events = socket.connection.subscribe();
        // The wire guarantees that this matching old-document event is processed
        // before the current-state probe's reply, just as in the regression.
        socket
            .request_in(None, "Runtime.evaluate", json!({}))
            .await
            .unwrap();
        assert!(old_events.try_recv().is_ok());
        let cancellation = CancellationToken::new();
        let scope = EventWait {
            tab: "17",
            timeout: Duration::from_secs(2),
            cancellation: &cancellation,
        };
        let matcher = Glob::new("**/next").unwrap();
        let waiting: futures_util::future::BoxFuture<'_, Result<(), ToolError>> = if url_wait {
            Box::pin(scope.url(&socket, "**/next", &matcher, Some("main")))
        } else {
            Box::pin(scope.load(&socket, &LoadState::Load))
        };
        tokio::pin!(waiting);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut waiting)
                .await
                .is_err(),
            "a queued event before the current snapshot must not finish a new wait"
        );
        // A later event through that same real CdpConnection is sufficient.
        socket
            .request_in(None, "Runtime.evaluate", json!({}))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .unwrap()
            .unwrap();
        server.abort();
        let _ = server.await;
    }
    #[tokio::test]
    async fn prior_document_url_event_cannot_satisfy_new_url_wait() {
        stale_event_cannot_finish_new_generic_wait(true).await;
    }

    #[derive(Default)]
    struct Kept(std::sync::Mutex<Vec<crate::CheckedSettlementFuture>>);
    impl crate::OperationSettlement for Kept {
        fn retain(
            &self,
            pending: crate::SettlementFuture,
        ) -> Result<(), (ToolError, crate::SettlementFuture)> {
            Err((failed("fixture requires checked settlement"), pending))
        }
        fn retain_checked(
            &self,
            pending: crate::CheckedSettlementFuture,
        ) -> Result<(), (ToolError, crate::CheckedSettlementFuture)> {
            self.0.lock().unwrap().push(pending);
            Ok(())
        }
    }
    struct RemoteServices(std::sync::Arc<Kept>);
    impl crate::invocation::BrowserServicesProvider for RemoteServices {
        fn prepare(
            &self,
            access: crate::BrowserAccess,
            _: CancellationToken,
        ) -> crate::invocation::BrowserServicesFuture {
            assert!(matches!(access, crate::BrowserAccess::Metadata { .. }));
            let settlement = self.0.clone();
            Box::pin(async move {
                Ok(crate::invocation::BrowserServices {
                    files: None,
                    attachment: None,
                    effects: None,
                    settlement: Some(settlement),
                })
            })
        }
    }
    #[tokio::test]
    async fn remote_host_custody_retains_same_timer_when_the_caller_drops_its_wait() {
        let custody = std::sync::Arc::new(Kept::default());
        let context = crate::InvocationContext::new("fixture", "turn")
            .with_browser_services(std::sync::Arc::new(RemoteServices(custody.clone())));
        assert!(
            context.operation_settlement().is_none(),
            "matches actual Windows worker context"
        );
        let cancellation = CancellationToken::new();
        let mut browsers = Browsers::default();
        // Deferred binding is metadata only; no browser or desktop is contacted.
        let bound = browsers
            .bind(
                TabSource {
                    provider: Provider::Cdp(BrowserConnection {
                        id: "fixture".into(),
                        endpoint: "http://127.0.0.1:1".into(),
                    }),
                    generation: "ws://127.0.0.1:1/devtools/browser/fixture".into(),
                    info: TabInfo {
                        id: "17".into(),
                        title: String::new().into(),
                        url: "about:blank".into(),
                        kind: "page".into(),
                        websocket: None,
                        extension: None,
                    },
                },
                InitialState::Deferred,
                &context,
                &cancellation,
                Language::En,
            )
            .await
            .unwrap();
        let handle = serde_json::from_value(bound["handle"].clone()).unwrap();
        let completion = browsers
            .prepare_wait(
                handle,
                BrowserWaitOperation::Timeout {
                    timeout_ms: json!(60000),
                },
                &context,
                &cancellation,
                Language::En,
            )
            .await
            .unwrap();
        assert!(completion.is_pending());
        drop(completion);
        assert_eq!(
            custody.0.lock().unwrap().len(),
            1,
            "the original Host still owns this exact observation"
        );
        cancellation.cancel();
        let pending = custody.0.lock().unwrap().pop().unwrap();
        tokio::time::timeout(Duration::from_secs(1), pending)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            browsers.targets.len(),
            1,
            "caller drop or cancellation cannot close a browser tab"
        );
    }

    #[tokio::test]
    async fn stop_during_page_setup_keeps_started_extension_preparation_unknown_without_replay() {
        let cancellation = CancellationToken::new();
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let result =
            cancellable_observation(ReadEffect::ExtensionPreparation, &cancellation, async {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                cancellation.cancel();
                std::future::pending::<Result<Value, ToolError>>().await
            })
            .await;
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(matches!(result, Err(ToolError::OutcomeUnknown(_))));
    }
}
