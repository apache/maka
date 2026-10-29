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

//! Coordinate CUA operations share the admitted Tab, CDP and fixed cursor path.

use super::*;
use crate::protocol::BrowserCuaOperation;
#[path = "cua_dom.rs"]
mod dom;
#[path = "cua_text.rs"]
mod text;

fn coordinate(name: &str, x: &Value, y: &Value) -> Result<[f64; 2], ToolError> {
    match (x.as_f64(), y.as_f64()) {
        (Some(x), Some(y)) if x.is_finite() && y.is_finite() => Ok([x, y]),
        _ => Err(failed(format!(
            "{name} requires finite x and y coordinates"
        ))),
    }
}

fn modifiers(keys: Option<&Value>, macos: bool) -> Result<u32, ToolError> {
    let Some(keys) = keys else { return Ok(0) };
    let values = match keys {
        Value::Null | Value::Bool(false) | Value::String(_) => return Ok(0),
        Value::Number(number) if number.as_f64() == Some(0.0) => return Ok(0),
        Value::Array(values) => values,
        _ => return Err(failed("t is not iterable")),
    };
    Ok(values.iter().fold(0, |mask, value| {
        mask | match value.as_str() {
            Some("Alt") => 1,
            Some("Control") => 2,
            Some("Meta") => 4,
            Some("Shift") => 8,
            Some("ControlOrMeta") if macos => 4,
            Some("ControlOrMeta") => 2,
            _ => 0,
        }
    }))
}

#[derive(Clone, Copy)]
enum Button {
    Left,
    Middle,
    Right,
}
impl Button {
    fn parse(value: Option<&Value>) -> Result<Self, ToolError> {
        match value {
            None => Ok(Self::Left),
            Some(value) if value.as_f64() == Some(1.0) => Ok(Self::Left),
            Some(value) if value.as_f64() == Some(2.0) => Ok(Self::Middle),
            Some(value) if value.as_f64() == Some(3.0) => Ok(Self::Right),
            Some(value) => Err(failed(format!("Unsupported CUA mouse button: {value}"))),
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Middle => "middle",
            Self::Right => "right",
        }
    }
    fn buttons(self) -> u32 {
        match self {
            Self::Left => 1,
            Self::Middle => 4,
            Self::Right => 2,
        }
    }
}

enum Pointer {
    Move {
        point: [f64; 2],
        mask: u32,
    },
    Click {
        point: [f64; 2],
        mask: u32,
        button: Button,
        count: u32,
    },
    Drag {
        path: Vec<[f64; 2]>,
        mask: u32,
    },
    Scroll {
        point: [f64; 2],
        mask: u32,
        delta: [f64; 2],
    },
}
impl Pointer {
    fn parse(operation: BrowserCuaOperation) -> Result<Self, ToolError> {
        let mac = cfg!(target_os = "macos");
        Ok(match operation {
            BrowserCuaOperation::Move { x, y, keys } => Self::Move {
                point: coordinate("cua_move", &x, &y)?,
                mask: modifiers(keys.as_ref(), mac)?,
            },
            BrowserCuaOperation::Click { x, y, button, keys } => Self::Click {
                point: coordinate("cua_click", &x, &y)?,
                mask: modifiers(keys.as_ref(), mac)?,
                button: Button::parse(button.as_ref())?,
                count: 1,
            },
            BrowserCuaOperation::DoubleClick { x, y, keys } => Self::Click {
                point: coordinate("cua_double_click", &x, &y)?,
                mask: modifiers(keys.as_ref(), mac)?,
                button: Button::Left,
                count: 2,
            },
            BrowserCuaOperation::Drag { path, keys } => {
                let points = path
                    .as_array()
                    .filter(|path| !path.is_empty())
                    .ok_or_else(|| failed("cua_drag requires a non-empty path"))?;
                let path = points
                    .iter()
                    .map(|p| coordinate("cua_drag", &p["x"], &p["y"]))
                    .collect::<Result<Vec<_>, _>>()?;
                Self::Drag {
                    path,
                    mask: modifiers(keys.as_ref(), mac)?,
                }
            }
            BrowserCuaOperation::Scroll {
                x,
                y,
                scroll_x,
                scroll_y,
                keys,
            } => {
                // A nonfinite facade number reaches the JSON boundary as null.
                // The selected service's unary negation converts that null to0.
                let delta = |value: &Value| {
                    if value.is_null() {
                        Ok(0.0)
                    } else {
                        value.as_f64().ok_or_else(|| {
                            failed("cua_scroll requires scroll_x and scroll_y numbers")
                        })
                    }
                };
                Self::Scroll {
                    point: coordinate("cua_scroll", &x, &y)?,
                    mask: modifiers(keys.as_ref(), mac)?,
                    delta: [delta(&scroll_x)?, delta(&scroll_y)?],
                }
            }
            BrowserCuaOperation::Keypress { .. }
            | BrowserCuaOperation::DomKeypress { .. }
            | BrowserCuaOperation::Type { .. }
            | BrowserCuaOperation::DomType { .. }
            | BrowserCuaOperation::DomSnapshot
            | BrowserCuaOperation::DomClick { .. }
            | BrowserCuaOperation::DomDoubleClick { .. }
            | BrowserCuaOperation::DomScroll { .. } => {
                unreachable!("key operations are routed before pointer parsing")
            }
        })
    }
    fn point(&self) -> [f64; 2] {
        match self {
            Self::Move { point, .. } | Self::Click { point, .. } | Self::Scroll { point, .. } => {
                *point
            }
            Self::Drag { path, .. } => path[0],
        }
    }
}

#[derive(Clone, Copy)]
enum MousePhase {
    Move,
    Press(Button, u32),
    Drag(Button),
}
struct MouseInput {
    point: [f64; 2],
    mask: u32,
    phase: MousePhase,
}
impl MouseInput {
    fn params(&self) -> Value {
        let mut value = json!({"x":self.point[0],"y":self.point[1],"modifiers":self.mask});
        let (kind, button, buttons, count) = match self.phase {
            MousePhase::Move => ("mouseMoved", "none", 0, None),
            MousePhase::Drag(button) => ("mouseMoved", button.name(), button.buttons(), None),
            MousePhase::Press(button, count) => {
                ("mousePressed", button.name(), button.buttons(), Some(count))
            }
        };
        value["type"] = json!(kind);
        value["button"] = json!(button);
        value["buttons"] = json!(buttons);
        if let Some(count) = count {
            value["clickCount"] = json!(count);
        }
        value
    }
}

enum CuaPlan {
    Pointer(Pointer),
    Keys(String),
    Text(String),
    Snapshot,
    Dom(dom::Action),
}

fn key_sequence(keys: &Value, command: &str) -> Result<String, ToolError> {
    let keys = keys
        .as_array()
        .filter(|keys| !keys.is_empty())
        .ok_or_else(|| failed(format!("{command} requires a non-empty keys array")))?;
    let mut result = Vec::new();
    for value in keys {
        let parts: Vec<(String, bool)> = match value {
            Value::String(value) => value
                .chars()
                .map(|value| (value.to_string(), value == '+'))
                .collect(),
            Value::Array(values) => values
                .iter()
                .map(|value| {
                    (
                        super::super::wait::js_string(value),
                        value.as_str() == Some("+"),
                    )
                })
                .collect(),
            _ => return Err(failed("t is not iterable")),
        };
        let mut current = String::new();
        for (part, separator) in parts {
            if separator && !current.is_empty() {
                result.push(std::mem::take(&mut current));
            } else {
                current.push_str(&part);
            }
        }
        if !current.is_empty() {
            result.push(current);
        }
    }
    if result.is_empty() {
        return Err(failed("keypress requires at least one key"));
    }
    let combined = result
        .iter()
        .map(|part| part.to_lowercase())
        .collect::<Vec<_>>()
        .join("+");
    let whole_alias = matches!(
        combined.as_str(),
        "ctrl+a"
            | "ctrl+c"
            | "ctrl+l"
            | "ctrl+n"
            | "ctrl+shift+v"
            | "ctrl+v"
            | "ctrl+x"
            | "ctrl+y"
            | "ctrl+z"
    );
    if !whole_alias
        && let Some(token) = result
            .iter()
            .find(|token| token.len() > 1 && token.contains('+'))
    {
        return Err(failed(format!("Unknown key: {token:?}")));
    }
    Ok(result.join("+"))
}

impl Browsers {
    pub(in crate::browser) async fn cua(
        &mut self,
        handle: &str,
        operation: BrowserCuaOperation,
        call: crate::browser::BrowserCall<'_>,
        cursor: &crate::cursor::Spec,
    ) -> Result<Value, ToolError> {
        let operation = match operation {
            BrowserCuaOperation::Keypress { keys } => {
                CuaPlan::Keys(key_sequence(&keys, "cua_keypress")?)
            }
            BrowserCuaOperation::DomKeypress { keys } => {
                CuaPlan::Keys(key_sequence(&keys, "dom_cua_keypress")?)
            }
            BrowserCuaOperation::Type { text } => CuaPlan::Text(
                text.as_str()
                    .ok_or_else(|| failed("cua_type requires text"))?
                    .to_owned(),
            ),
            BrowserCuaOperation::DomType { text } => CuaPlan::Text(
                text.as_str()
                    .ok_or_else(|| failed("dom_cua_type requires text"))?
                    .to_owned(),
            ),
            BrowserCuaOperation::DomSnapshot => CuaPlan::Snapshot,
            operation @ (BrowserCuaOperation::DomClick { .. }
            | BrowserCuaOperation::DomDoubleClick { .. }
            | BrowserCuaOperation::DomScroll { .. }) => CuaPlan::Dom(dom::action(operation)?),
            operation => CuaPlan::Pointer(Pointer::parse(operation)?),
        };
        let identity = self
            .targets
            .get(handle)
            .ok_or_else(|| failed("stale_tab: bind it again"))?
            .identity()?;
        self.use_tab(&identity, call.invocation.turn()).await?;
        let tab = self
            .targets
            .get_mut(handle)
            .expect("checked CUA tab handle");
        tab.last_turn = call.invocation.turn().to_owned();
        tab.authorize(None, call.invocation, call.cancellation, call.language)
            .await?;
        tab.verify(call).await?;
        let proof = tab
            .origin_proof
            .clone()
            .ok_or_else(|| failed("browser input lacks its admitted current document"))?;
        proof.check_current(tab).await?;
        let frame = proof.document_identity().frame_token();
        if tab.frame.as_ref() != Some(&frame) {
            tab.refs.clear();
            tab.previous = None;
        }
        tab.frame = Some(frame);
        if matches!(operation, CuaPlan::Snapshot) {
            return tab.cua_dom_snapshot(&proof, call).await;
        }
        tab.before_input(call.cancellation, call.language).await?;
        match operation {
            CuaPlan::Pointer(pointer) => tab.cua_pointer(pointer, &proof, call, cursor).await?,
            CuaPlan::Keys(keys) => {
                tab.browser_current_key(None, &keys, call, cursor, KeySource::Cua)
                    .await?
            }
            CuaPlan::Text(value) => tab.cua_text(value, &proof, call, cursor).await?,
            CuaPlan::Dom(action) => tab.cua_dom_action(action, &proof, call, cursor).await?,
            CuaPlan::Snapshot => unreachable!("DOM snapshot returns before input preparation"),
        }
        Ok(Value::Null)
    }
}
impl Tab {
    async fn cua_text(
        &mut self,
        value: String,
        proof: &origin::DocumentOrigin,
        call: crate::browser::BrowserCall<'_>,
        cursor: &crate::cursor::Spec,
    ) -> Result<(), ToolError> {
        let rich = text::rich_for_url(&self.info.url);
        let items = tokio::task::spawn_blocking(move || text::items(value, rich))
            .await
            .map_err(failed)??;
        check_input(call.cancellation)?;
        proof.check_current(self).await?;
        let resources = Resources::new();
        let document = self.document();
        let result = async {
            let frame = self.main_frame().await?;
            let selected = self
                .cua_root_scope(frame.clone(), vec![frame], &resources)
                .await?;
            let context = MutationContext {
                document: &document,
                clock: MutationClock::Host,
                cancellation: call.cancellation,
                invocation: call.invocation,
                resources: &resources,
                language: call.language,
                cursor,
            };
            proof.check_current(self).await?;
            self.locator_virtual_items(
                &selected,
                &items,
                clipboard::VirtualTextMode::Cua { rich },
                &context,
            )
            .await
        }
        .await;
        resources.cleanup(self).await;
        result.map_err(|error| {
            if call.cancellation.is_cancelled()
                && resources.mutated.load(std::sync::atomic::Ordering::Relaxed)
                && let ToolError::Failed(message) = error
            {
                unknown(format!(
                    "{message}; cancellation followed a page effect; do not replay"
                ))
            } else {
                error
            }
        })
    }

    pub(super) async fn cua_focused_scope(
        &mut self,
        resources: &Resources,
    ) -> Result<Selected, ToolError> {
        let mut frame = self.main_frame().await?;
        let mut used = vec![frame.clone()];
        loop {
            let engine = self.playwright_engine(&frame, resources).await?;
            let focused=cdp_value(self.frame_observation(frame.session.as_deref(),"Runtime.callFunctionOn",json!({
                "objectId":engine,"functionDeclaration":r#"function(){
                    const local=Object.getOwnPropertyDescriptor(Element.prototype,'localName')?.get;
                    const namespace=Object.getOwnPropertyDescriptor(Element.prototype,'namespaceURI')?.get;
                    if(!local||!namespace)throw Error('Focused frame inspection requires native DOM getters');
                    let element=document.activeElement;
                    while(element?.shadowRoot?.activeElement)element=element.shadowRoot.activeElement;
                    if(!element||namespace.call(element)!=='http://www.w3.org/1999/xhtml')return null;
                    return ['iframe','frame'].includes(local.call(element))?element:null;
                }"#,
                "returnByValue":false,"objectGroup":resources.group,
            })).await?)?;
            let Some(object) = focused["objectId"].as_str() else {
                return self.cua_root_scope(frame, used, resources).await;
            };
            let described = self
                .frame_observation(
                    frame.session.as_deref(),
                    "DOM.describeNode",
                    json!({"objectId":object}),
                )
                .await?;
            let backend = described["node"]["backendNodeId"]
                .as_u64()
                .ok_or_else(|| failed("focused frame owner has no backend node"))?;
            let catalog = self.frame_catalog().await?;
            let child = self
                .resolve_frame(
                    &frame,
                    backend,
                    described["node"]["frameId"].as_str(),
                    &catalog,
                )
                .await?;
            if used.contains(&child) {
                return Err(failed("Browser Use encountered a focused frame cycle"));
            }
            frame = child;
            used.push(frame.clone());
        }
    }
    async fn cua_root_scope(
        &self,
        frame: frames::Frame,
        used: Vec<frames::Frame>,
        resources: &Resources,
    ) -> Result<Selected, ToolError> {
        let engine = self.playwright_engine(&frame, resources).await?;
        let root=cdp_value(self.frame_observation(frame.session.as_deref(),"Runtime.callFunctionOn",json!({
            "objectId":engine,"functionDeclaration":"function(){return document.documentElement;}",
            "returnByValue":false,"objectGroup":resources.group,
        })).await?)?;
        let object = root["objectId"]
            .as_str()
            .ok_or_else(|| failed("current browser document is unavailable"))?
            .to_owned();
        Ok(Selected {
            object,
            frame,
            used,
        })
    }
}

impl Tab {
    async fn cua_present(
        &mut self,
        point: [f64; 2],
        call: crate::browser::BrowserCall<'_>,
        cursor: &crate::cursor::Spec,
        wait_for_arrival: Option<bool>,
    ) -> Result<(), ToolError> {
        let presentation = if wait_for_arrival == Some(false) {
            match self
                .extension_cursor_presentation_with_arrival(Some(point), "update", wait_for_arrival)
                .await
            {
                Ok(Some(value)) => Ok(value),
                Ok(None) => {
                    self.draw_cursor(cursor, Some(point), "idle", "update", call.language)
                        .await
                }
                Err(error) => Err(error),
            }
        } else {
            self.draw_cursor(cursor, Some(point), "idle", "update", call.language)
                .await
        };
        match presentation {
            Ok(_) => Ok(()),
            // Presentation is best effort in the selected Original helper.
            // A fresh admission prevents a UI failure from acting as a grant.
            Err(ToolError::Failed(_)) => {
                self.authorize(None, call.invocation, call.cancellation, call.language)
                    .await
            }
            Err(error) => Err(error),
        }
    }
    async fn cua_pointer_scope_current(
        &self,
        target: Option<&MouseTarget>,
    ) -> Result<(), ToolError> {
        if let Some(target) = target
            && !self.frame_scopes_current(&target.used).await?
        {
            return Err(failed(
                "DOM node frame navigated or detached; observe again",
            ));
        }
        Ok(())
    }
    async fn cua_mouse(&self, session: Option<&str>, input: MouseInput) -> Result<(), ToolError> {
        self.cua_mouse_before(session, input, None).await
    }
    async fn cua_mouse_before(
        &self,
        session: Option<&str>,
        input: MouseInput,
        deadline: Option<tokio::time::Instant>,
    ) -> Result<(), ToolError> {
        if deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) {
            return Err(failed("CUA click deadline exceeded before the next input"));
        }
        // The observation window belongs to the retained whole sequence. It
        // must never drop an in-flight Required mutation and fence this route.
        self.frame_request(session, "Input.dispatchMouseEvent", input.params())
            .await?;
        Ok(())
    }
    async fn cua_pointer(
        &mut self,
        pointer: Pointer,
        proof: &origin::DocumentOrigin,
        call: crate::browser::BrowserCall<'_>,
        cursor: &crate::cursor::Spec,
    ) -> Result<(), ToolError> {
        self.cua_pointer_at(pointer, proof, call, cursor, None)
            .await
    }
    async fn cua_pointer_at(
        &mut self,
        pointer: Pointer,
        proof: &origin::DocumentOrigin,
        call: crate::browser::BrowserCall<'_>,
        cursor: &crate::cursor::Spec,
        target: Option<MouseTarget>,
    ) -> Result<(), ToolError> {
        let connection = &self
            .socket
            .as_ref()
            .expect("verified CUA socket")
            .connection;
        let mut watches = Vec::new();
        let input_deadline = matches!(pointer, Pointer::Click { .. })
            .then(|| tokio::time::Instant::now() + Duration::from_secs(3));
        if matches!(pointer, Pointer::Click { .. }) {
            watches.push(PageLoadWatch::new_for(
                connection.subscribe(),
                proof.document_identity().frame_id().to_owned(),
                None,
                target
                    .as_ref()
                    .is_some_and(|target| target.session.is_some()),
                call.cancellation.clone(),
            ));
            if let Some(target) = target.as_ref().filter(|target| target.session.is_some()) {
                watches.push(PageLoadWatch::new_for(
                    connection.subscribe(),
                    target.main.clone(),
                    target.session.clone(),
                    false,
                    call.cancellation.clone(),
                ));
            }
        }
        let proof = proof.clone();
        let owned = call.invocation.capture();
        let cursor = cursor.clone();
        let language = call.language;
        let result = self.owned_input(call.cancellation, input_deadline, move |mut page, input, cancellation| Box::pin(async move {
            let invocation = owned.borrow();
            let call = crate::browser::BrowserCall::new(&invocation, &cancellation, language);
            let session = target.as_ref().and_then(|target| target.session.as_deref());
            let mut dispatched = false;
            let result = async {
                let top = pointer.point();
                let point = target.as_ref().map_or(top, |target| target.input);
                page.cua_present(top, call, &cursor, None).await?;
                proof.check_current(&mut page).await?;
                page.cua_pointer_scope_current(target.as_ref()).await?;
                page.before_input(&cancellation, language).await?;
                let mask = match &pointer { Pointer::Move{mask,..}|Pointer::Click{mask,..}|Pointer::Drag{mask,..}|Pointer::Scroll{mask,..}=>*mask };
                check_input(&cancellation)?;
                page.cua_mouse_before(session, MouseInput { point, mask, phase: MousePhase::Move }, input_deadline).await?;
                dispatched = true;
                match pointer {
                    Pointer::Move { .. } => Ok(()),
                    Pointer::Scroll { delta, .. } => {
                        proof.check_current(&mut page).await?;
                        page.before_input(&cancellation, language).await?;
                        let distance = |delta: f64| if delta == 0.0 { 0.0 } else { -delta };
                        page.frame_request(None, "Input.synthesizeScrollGesture", json!({
                            "x":point[0],"y":point[1],"xDistance":distance(delta[0]),"yDistance":distance(delta[1]),
                            "gestureSourceType":"mouse","preventFling":true,"speed":8000,
                        })).await?;
                        Ok(())
                    },
                    Pointer::Click { button, count, .. } => {
                        for count in 1..=count {
                            check_cancelled(&cancellation, true)?;
                            if input_deadline.is_some_and(|deadline|tokio::time::Instant::now()>=deadline) {
                                return Err(unknown("CUA click input deadline exceeded after input; do not replay"));
                            }
                            proof.check_current(&mut page).await?;
                            page.cua_pointer_scope_current(target.as_ref()).await?;
                            page.before_input(&cancellation, language).await?;
                            let held = input.mouse_down(session, MouseInput { point, mask, phase: MousePhase::Press(button,count) }.params()).await?;
                            input.release(held).await?;
                        }
                        Ok(())
                    },
                    Pointer::Drag { path, .. } => {
                        let button = Button::Left;
                        proof.check_current(&mut page).await?;
                        page.before_input(&cancellation, language).await?;
                        let held = input.mouse_down(session, MouseInput { point, mask, phase: MousePhase::Press(button,1) }.params()).await?;
                        for point in path.into_iter().skip(1) {
                            check_cancelled(&cancellation, true)?;
                            proof.check_current(&mut page).await?;
                            page.cua_present(point, call, &cursor, Some(false)).await?;
                            proof.check_current(&mut page).await?;
                            page.before_input(&cancellation, language).await?;
                            input.mouse_position(held, point);
                            page.cua_mouse(session, MouseInput { point, mask, phase: MousePhase::Drag(button) }).await?;
                        }
                        input.release(held).await
                    },
                }
            }.await;
            result.map_err(|error| {
                if dispatched && let ToolError::Failed(message) = error {
                    unknown(format!("{message}; CUA input already began; do not replay"))
                } else { error }
            })
        })).await;
        let mut result = result;
        for watch in watches {
            let observed = watch.finish().await;
            result = result.and(observed);
        }
        result
    }
}

struct MouseTarget {
    session: Option<String>,
    input: [f64; 2],
    main: String,
    used: Vec<frames::Frame>,
}

struct PageLoadWatch(Option<tokio::task::JoinHandle<Result<(), ToolError>>>);
impl PageLoadWatch {
    fn new_for(
        events: tokio::sync::mpsc::UnboundedReceiver<cua_driver_core::browser::cdp_ws::CdpEvent>,
        main: String,
        session: Option<String>,
        reject_subframes: bool,
        cancellation: CancellationToken,
    ) -> Self {
        let armed = tokio::time::Instant::now();
        Self(Some(tokio::spawn(page_load_watch(
            events,
            main,
            session,
            reject_subframes,
            cancellation,
            armed,
        ))))
    }
    async fn finish(mut self) -> Result<(), ToolError> {
        self.0
            .take()
            .expect("page-load observer remains owned")
            .await
            .map_err(|error| {
                unknown(format!(
                    "CUA page-load observation was interrupted: {error}"
                ))
            })?
    }
}
impl Drop for PageLoadWatch {
    fn drop(&mut self) {
        if let Some(task) = self.0.take() {
            task.abort();
        }
    }
}
struct PageLoadState {
    main: String,
    session: Option<String>,
    reject_subframes: bool,
    deadline: tokio::time::Instant,
    loading: bool,
    navigated: std::collections::HashSet<String>,
}
impl PageLoadState {
    fn new(main: String, armed: tokio::time::Instant) -> Self {
        Self {
            main,
            session: None,
            reject_subframes: false,
            deadline: armed + Duration::from_millis(250),
            loading: false,
            navigated: std::collections::HashSet::new(),
        }
    }
    fn observe(
        &mut self,
        event: &cua_driver_core::browser::cdp_ws::CdpEvent,
        now: tokio::time::Instant,
    ) -> Result<bool, ToolError> {
        if event.session_id != self.session
            || self.session.is_none() && event.source_target_id.is_some()
        {
            return Ok(false);
        }
        super::super::wait::navigation_error_including_subframes(event, self.reject_subframes)?;
        match event.method.as_str() {
            "Page.navigatedWithinDocument"
                if event.params["frameId"] == self.main
                    && !self
                        .navigated
                        .contains(event.params["frameId"].as_str().unwrap_or_default()) =>
            {
                Ok(true)
            }
            "Page.frameStartedLoading" | "Page.frameNavigated" => {
                if event.method == "Page.frameNavigated" {
                    if event.params["frame"]["parentId"].is_null()
                        && let Some(id) = event.params["frame"]["id"].as_str()
                    {
                        self.main = id.to_owned();
                    }
                    if event.params["type"] != "BackForwardCacheRestore"
                        && let Some(id) = event.params["frame"]["id"].as_str()
                    {
                        self.navigated.insert(id.to_owned());
                    }
                }
                if !self.loading {
                    self.loading = true;
                    self.deadline = now + Duration::from_secs(3);
                }
                Ok(false)
            }
            "Page.domContentEventFired" | "Page.loadEventFired" => Ok(self.loading),
            _ => Ok(false),
        }
    }
}
async fn page_load_watch(
    mut events: tokio::sync::mpsc::UnboundedReceiver<cua_driver_core::browser::cdp_ws::CdpEvent>,
    main: String,
    session: Option<String>,
    reject_subframes: bool,
    cancellation: CancellationToken,
    armed: tokio::time::Instant,
) -> Result<(), ToolError> {
    let mut state = PageLoadState::new(main, armed);
    state.session = session;
    state.reject_subframes = reject_subframes;
    loop {
        let event = tokio::select! {biased;
            ()=cancellation.cancelled()=>return Err(unknown("CUA page-load wait cancelled; do not replay the input")),
            result=tokio::time::timeout_at(state.deadline,events.recv())=>match result {
                Ok(Some(event))=>event,
                Ok(None)=>return tokio::select! { biased;
                    ()=cancellation.cancelled()=>Err(unknown("CUA page-load wait cancelled; do not replay the input")),
                    ()=tokio::time::sleep_until(state.deadline)=>Ok(()),
                },
                Err(_)=>return Ok(()),
            },
        };
        if state.observe(&event, tokio::time::Instant::now())? {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn child_load_watch_accepts_only_its_actual_flattened_session_and_root_can_reject_subframe_policy()
     {
        let now = tokio::time::Instant::now();
        let mut state = PageLoadState::new("child-main".into(), now);
        state.session = Some("owned-child".into());
        let mut loading = event("Page.frameStartedLoading", json!({"frameId":"child-main"}));
        assert!(!state.observe(&loading, now).unwrap());
        assert!(!state.loading);
        loading.session_id = Some("sibling".into());
        assert!(!state.observe(&loading, now).unwrap());
        assert!(!state.loading);
        loading.session_id = Some("owned-child".into());
        loading.source_target_id = Some("actual-child-target".into());
        assert!(!state.observe(&loading, now).unwrap());
        assert!(state.loading);
        let mut root = PageLoadState::new("root".into(), now);
        root.reject_subframes = true;
        assert!(root.observe(&event("Page.navigationBlocked",json!({"resourceType":"subFrame","url":"https://u:p@example.test/path?secret#fragment"})),now).is_err());
    }
    #[test]
    fn nested_key_tokens_preserve_literal_boundaries_and_whole_chord_aliases() {
        assert!(key_sequence(&json!([["a+b"]]), "cua_keypress").is_err());
        assert!(key_sequence(&json!([["Control+x"]]), "cua_keypress").is_err());
        assert_eq!(
            key_sequence(&json!([["CTRL+x"]]), "cua_keypress").unwrap(),
            "CTRL+x"
        );
        assert_eq!(
            key_sequence(&json!(["Control+x"]), "cua_keypress").unwrap(),
            "Control+x"
        );
        assert_eq!(
            key_sequence(&json!([["Control", "+", "x"]]), "cua_keypress").unwrap(),
            "Control+x"
        );
    }
    #[test]
    fn coordinates_preserve_negative_fractional_and_beyond_viewport_values() {
        assert_eq!(
            coordinate("cua_move", &json!(-7.25), &json!(4000.125)).unwrap(),
            [-7.25, 4000.125]
        );
        for value in [Value::Null, json!("2"), json!(false)] {
            assert!(coordinate("cua_move", &value, &json!(0)).is_err());
        }
    }
    #[test]
    fn pointer_modifier_names_are_exact_and_control_or_meta_uses_actual_host_os() {
        let keys = json!([
            "Alt",
            "ControlOrMeta",
            "Shift",
            "ControlOrMeta",
            "ctrl",
            "AltLeft",
            17
        ]);
        assert_eq!(modifiers(Some(&keys), false).unwrap(), 11);
        assert_eq!(modifiers(Some(&keys), true).unwrap(), 13);
        assert_eq!(
            modifiers(Some(&json!(["Control", "Meta"])), false).unwrap(),
            6
        );
    }
    #[test]
    fn actual_nonparsed_modifier_boundary_keeps_ignored_iterables_and_falsy_inputs() {
        for keys in [
            Value::Null,
            json!(false),
            json!(0),
            json!("Control"),
            json!([]),
        ] {
            assert_eq!(modifiers(Some(&keys), false).unwrap(), 0);
        }
        for keys in [json!(true), json!(7), json!({})] {
            assert!(modifiers(Some(&keys), false).is_err());
        }
    }
    fn event(method: &str, params: Value) -> cua_driver_core::browser::cdp_ws::CdpEvent {
        cua_driver_core::browser::cdp_ws::CdpEvent {
            method: method.into(),
            params,
            session_id: None,
            source_target_id: None,
            params_json: None,
        }
    }
    #[test]
    fn supplied_null_button_is_not_an_omitted_left_button() {
        let decode = |button: Option<Value>| {
            let mut value = json!({"kind":"click","x":0,"y":0});
            if let Some(button) = button {
                value["button"] = button;
            }
            Pointer::parse(serde_json::from_value(value).unwrap())
        };
        assert!(decode(None).is_ok());
        assert!(decode(Some(Value::Null)).is_err());
        assert!(decode(Some(json!(0))).is_err());
        for button in [1, 2, 3] {
            assert!(decode(Some(json!(button))).is_ok());
            assert!(decode(Some(json!(f64::from(button)))).is_ok());
        }
    }
    #[test]
    fn load_classification_has_no_new_wait_after_unrelated_child_source_events() {
        let start = tokio::time::Instant::now();
        let mut state = PageLoadState::new("main".into(), start);
        let mut child = event("Page.frameStartedLoading", json!({"frameId":"main"}));
        child.session_id = Some("actual-child-session".into());
        assert!(!state.observe(&child, start).unwrap());
        child.session_id = None;
        child.source_target_id = Some("actual-child-target".into());
        assert!(!state.observe(&child, start).unwrap());
        assert_eq!(state.deadline, start + Duration::from_millis(250));
        assert!(!state.loading);
    }
    #[test]
    fn first_loading_event_extends_once_then_dom_ready_finishes() {
        let start = tokio::time::Instant::now();
        let mut state = PageLoadState::new("main".into(), start);
        assert!(
            !state
                .observe(&event("Page.loadEventFired", json!({})), start)
                .unwrap()
        );
        assert!(
            !state
                .observe(
                    &event("Page.frameStartedLoading", json!({"frameId":"subframe"})),
                    start
                )
                .unwrap()
        );
        let deadline = state.deadline;
        assert_eq!(deadline, start + Duration::from_secs(3));
        assert!(
            !state
                .observe(
                    &event("Page.frameNavigated", json!({"frame":{"id":"main"}})),
                    start + Duration::from_secs(1)
                )
                .unwrap()
        );
        assert_eq!(
            state.deadline, deadline,
            "the selected service does not restart the three-second timer on every frame event"
        );
        assert!(
            state
                .observe(
                    &event("Page.domContentEventFired", json!({})),
                    start + Duration::from_secs(1)
                )
                .unwrap()
        );
    }
    #[test]
    fn main_same_document_change_finishes_unless_that_frame_already_navigated() {
        let start = tokio::time::Instant::now();
        let mut state = PageLoadState::new("main".into(), start);
        assert!(
            !state
                .observe(
                    &event("Page.navigatedWithinDocument", json!({"frameId":"child"})),
                    start
                )
                .unwrap()
        );
        assert!(
            state
                .observe(
                    &event("Page.navigatedWithinDocument", json!({"frameId":"main"})),
                    start
                )
                .unwrap()
        );
        let mut state = PageLoadState::new("main".into(), start);
        state
            .observe(
                &event(
                    "Page.frameNavigated",
                    json!({"frame":{"id":"main"},"type":"Navigation"}),
                ),
                start,
            )
            .unwrap();
        assert!(
            !state
                .observe(
                    &event("Page.navigatedWithinDocument", json!({"frameId":"main"})),
                    start
                )
                .unwrap()
        );
    }
    #[tokio::test]
    async fn cancelling_a_page_load_observer_does_not_wait_for_its_timer_or_restart_input() {
        let (_sender, events) = tokio::sync::mpsc::unbounded_channel();
        let cancellation = CancellationToken::new();
        let watch =
            PageLoadWatch::new_for(events, "main".into(), None, false, cancellation.clone());
        cancellation.cancel();
        assert!(matches!(
            watch.finish().await,
            Err(ToolError::OutcomeUnknown(_))
        ));
    }
    #[test]
    fn key_arrays_flatten_the_selected_plus_grammar_without_ax_only_preprocessing() {
        for (keys, expected) in [
            (json!(["Control", "x"]), "Control+x"),
            (json!(["Control+", "x"]), "Control+x"),
            (json!(["Control", "+"]), "Control++"),
            (json!(["a+", "", "b"]), "a+b"),
            (json!(["CTRL_L", "x"]), "CTRL_L+x"),
            (json!([["Control", "+", "x"]]), "Control+x"),
        ] {
            assert_eq!(key_sequence(&keys, "cua_keypress").unwrap(), expected);
        }
        assert!(
            key_sequence(&json!([""]), "cua_keypress")
                .unwrap_err()
                .to_string()
                .contains("at least one key")
        );
        assert!(key_sequence(&json!([7]), "cua_keypress").is_err());
        assert!(
            key_sequence(&json!([]), "dom_cua_keypress")
                .unwrap_err()
                .to_string()
                .contains("dom_cua_keypress")
        );
    }
}
