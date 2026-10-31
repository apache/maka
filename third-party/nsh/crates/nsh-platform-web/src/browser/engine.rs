//! Local-engine callbacks into the app's browser realm.
use std::sync::Arc;

use nsh_core::{
    EventKind, EventPayload, NodeId, Op,
    element::{JsEvent, JsHost, ThemeTokens, Tokens},
};
use nsh_engine::{
    Environment,
    browser::{Host, Services},
};

use super::{
    Runtime, events,
    values::{Value, invoke},
};
impl Runtime {
    fn notify(&self, name: &str, args: impl IntoIterator<Item = Value>) {
        if self.bindings.stopped.get() {
            return;
        }
        let listener = self.listener.borrow().clone();
        let result = (|| {
            let Some(listener) = listener else {
                return Ok::<(), nsh_core::element::PropError>(());
            };
            let args = Value::array([Value::string(name)?, Value::array(args)?])?;
            listener.call(&Value(0), &args)?;
            Ok(())
        })();
        if let Err(error) = result {
            invoke(42, 0, error.0.as_ptr() as u32, error.0.len() as u32, 0.0);
        }
    }
    fn event(&self, name: &str, args: Result<Vec<Value>, nsh_core::element::PropError>) {
        match args {
            Ok(args) => self.notify(name, args),
            Err(error) => {
                invoke(42, 0, error.0.as_ptr() as u32, error.0.len() as u32, 0.0);
            }
        }
    }
}
impl Host for Runtime {
    fn initialize(&self, services: Services) -> Result<(), String> {
        *self.bindings.system.borrow_mut() = services.system;
        *self.bindings.posts.borrow_mut() = services.posts;
        *self.registries.borrow_mut() = nsh_core::runtime::registries()
            .iter()
            .cloned()
            .chain(services.registries)
            .collect();
        *self.tokens.borrow_mut() = Some(services.tokens);
        *self.theme.borrow_mut() = Some(services.theme);
        *self.host.borrow_mut() = Some(services.host);
        *self.wake.borrow_mut() = Some(services.wake);
        self.timers.set_clock(services.clock);
        self.set_environment(&services.environment);
        Ok(())
    }
    fn take_ops(&self, out: &mut Vec<Op>) {
        out.append(&mut self.bindings.ops.borrow_mut());
    }
    fn dispatch_event(&self, id: NodeId, event: EventKind, payload: &EventPayload) {
        self.event(
            "event",
            (|| {
                Ok(vec![
                    Value::number(id.into()),
                    Value::string(if event.handler_name().is_empty() {
                        event.prop_name()
                    } else {
                        event.handler_name()
                    })?,
                    // `onChange({ value })` (`api-naming.md` "Payloads"), as
                    // nsh-js builds it.
                    match (event, payload) {
                        (EventKind::ChangeText, EventPayload::Text { text, .. }) => {
                            events::value(text)?
                        }
                        // `onContentSizeChange({ size })`.
                        (EventKind::ContentSizeChange, EventPayload::Map(_)) => {
                            events::wrap("size", events::payload(&self.bindings, payload)?)?
                        }
                        // Presses always pass their event, as nsh-js's do.
                        (
                            EventKind::Press
                            | EventKind::LongPress
                            | EventKind::PressDown
                            | EventKind::PressUp,
                            EventPayload::None,
                        ) => events::payload(
                            &self.bindings,
                            &EventPayload::Press(nsh_core::PressEvent {
                                clicks: 1,
                                ..Default::default()
                            }),
                        )?,
                        // A video's `onLoad`: `{ duration, size }`, as nsh-js
                        // builds it (a web view's has no `duration`).
                        (EventKind::Load, EventPayload::Map(fields))
                            if fields.iter().any(|(k, _)| *k == "duration") =>
                        {
                            events::video_load(fields)?
                        }
                        _ => events::payload(&self.bindings, payload)?,
                    },
                ])
            })(),
        );
    }
    fn deliver(&self, event: JsEvent) {
        match event {
            // The engine delivers these directly to the core's installed listener.
            JsEvent::LayoutListener { .. } => {}
            JsEvent::Event(id, event, payload) => self.dispatch_event(id, event, &payload),
            JsEvent::Reply { call, result } => {
                let result = result.and_then(|value| {
                    value
                        .to_js_value(&*self.bindings)
                        .map(|v| Value(v.into_raw().0[0] as u32))
                        .map_err(Into::into)
                });
                let ok = result.is_ok();
                let value = match result {
                    Ok(value) => Ok(value),
                    Err(error) => self.modules.error(&error),
                };
                self.event(
                    "reply",
                    value.map(|v| {
                        vec![Value::number(call.into()), Value(if ok { 3 } else { 2 }), v]
                    }),
                );
            }
            JsEvent::Component { host, event } => self.event(
                "component",
                (|| {
                    Ok(vec![
                        Value::number(host.into()),
                        Value::string(event.name())?,
                        Value(event.data_js(&*self.bindings)?.into_raw().0[0] as u32),
                    ])
                })(),
            ),
            JsEvent::Children { host, wanted } => self.notify(
                "children",
                [
                    Value::number(host.into()),
                    Value(if wanted { 3 } else { 2 }),
                ],
            ),
            JsEvent::Render {
                host,
                prop,
                key,
                value,
            } => self.event(
                "render",
                (|| {
                    Ok(vec![
                        Value::number(host.into()),
                        Value::string(prop)?,
                        Value::string(&key)?,
                        Value(value.render_js(&*self.bindings)?.into_raw().0[0] as u32),
                    ])
                })(),
            ),
            JsEvent::Unrender { host, prop, key } => self.event(
                "unrender",
                (|| {
                    Ok(vec![
                        Value::number(host.into()),
                        Value::string(prop)?,
                        Value::string(&key)?,
                    ])
                })(),
            ),
        }
    }
    fn bind_list(&self, list: NodeId, binds: &[(u32, u32)]) {
        self.event(
            "bindList",
            (|| {
                Ok(vec![
                    Value::number(list.into()),
                    Value::array(
                        binds
                            .iter()
                            .map(|(a, b)| {
                                Value::array([
                                    Value::number((*a).into()),
                                    Value::number((*b).into()),
                                ])
                            })
                            .collect::<Result<Vec<_>, _>>()?,
                    )?,
                ])
            })(),
        );
    }
    fn run_posted(&self) {
        let calls = self.bindings.posts.borrow().take_calls();
        for call in calls {
            self.bindings.run_call(call);
        }
    }
    fn has_posted(&self) -> bool {
        self.bindings.posts.borrow().has_calls()
    }
    fn set_environment(&self, e: &Environment) {
        let data = serde_json::json!({
            "window":{"width":e.window.width.0,"height":e.window.height.0},
            "safeArea":{"top":e.safe_area.top.0,"right":e.safe_area.right.0,"bottom":e.safe_area.bottom.0,"left":e.safe_area.left.0},
            "titleBar":{"height":e.title_bar.top.0,"left":e.title_bar.left.0,"right":e.title_bar.right.0},
            "keyboard":{"height":e.keyboard_height.0,"duration":e.keyboard_duration},
            "colorScheme":if e.color_scheme==nsh_engine::ColorScheme::Dark {"dark"}else{"light"},
            "fontScale":e.font_scale,"rtl":e.rtl,"reduceMotion":e.reduce_motion,"pixelRatio":e.pixel_ratio,
            "screenReader":e.screen_reader,"locale":e.locale.as_str(),"host":e.host,
            "platform":{"os":"web","version":e.os_version.0,"idiom":format!("{:?}",e.reported_idiom()).to_lowercase(),"desktop":e.desktop(),"appleKeyboard":e.apple_keyboard}
        });
        self.event(
            "environment",
            self.bindings
                .json(&data)
                .map(|v| vec![Value(v.0[0] as u32)]),
        );
    }
    fn set_tokens(&self, tokens: Arc<Tokens>) {
        *self.tokens.borrow_mut() = Some(tokens);
        self.notify("tokens", []);
    }
    fn set_theme_tokens(&self, theme: ThemeTokens) {
        *self.theme.borrow_mut() = Some(theme);
    }
    fn take_fonts(&self, out: &mut Vec<String>) {
        out.append(&mut self.fonts.borrow_mut());
    }
    // On the system's clock requestAnimationFrame is the browser's, run in
    // the app realm; on a manual one the engine's frames run it.
    fn wants_frame(&self) -> bool {
        !self.bindings.stopped.get() && self.timers.wants_frame()
    }
    fn run_frame(&self) {
        if !self.bindings.stopped.get() {
            self.timers.run_frame();
        }
    }
    fn next_timer(&self) -> Option<nsh_core::time::Instant> {
        self.timers.next_deadline()
    }
    fn run_timers(&self, now: nsh_core::time::Instant) {
        if !self.bindings.stopped.get() {
            self.timers.run(now);
        }
    }
    fn take_network(&self, out: &mut Vec<(u32, nsh_core::platform::FetchOp)>) {
        self.fetches.take(out);
    }
    fn fetch_event(&self, id: u32, event: nsh_core::platform::FetchEvent) {
        if !self.bindings.stopped.get() {
            self.fetches.event(id, event);
        }
    }
    fn fetch_refused(&self, id: u32, message: &str, url: &str) {
        if !self.bindings.stopped.get() {
            self.fetches.refused(id, message, url);
        }
    }
    fn animations_finished(&self, finished: &[nsh_core::animation::Finished]) {
        self.event(
            "animationsFinished",
            Value::array(
                finished
                    .iter()
                    .map(|f| {
                        Value::array([
                            Value::number(f.animation.into()),
                            Value(if f.finished { 3 } else { 2 }),
                            f.value.map_or(Value(0), |v| Value::number(v.into())),
                        ])
                    })
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap_or_default(),
            )
            .map(|value| vec![value]),
        );
    }
    fn host_event(&self, name: &str, data: nsh_core::JsonValue) {
        self.event(
            "hostEvent",
            (|| {
                Ok(vec![
                    Value::string(name)?,
                    Value(self.bindings.json(&data)?.0[0] as u32),
                ])
            })(),
        );
    }
    fn host_reply(&self, id: u64, result: Result<nsh_core::JsonValue, String>) {
        let ok = result.is_ok();
        self.event(
            "hostReply",
            (|| {
                Ok(vec![
                    Value::number(id as f64),
                    Value(if ok { 3 } else { 2 }),
                    match result {
                        Ok(data) => Value(self.bindings.json(&data)?.0[0] as u32),
                        Err(error) => Value::string(&error)?,
                    },
                ])
            })(),
        );
    }
    fn fatal(&self) -> Option<String> {
        None
    }
    fn stop(&self, _reason: String) {
        self.timers.clear();
        self.fetches.clear();
        self.bindings.stop();
    }
}
