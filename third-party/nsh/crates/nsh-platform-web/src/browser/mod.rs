//! Browser JavaScript's value and reactive bridge. App execution stays in
//! the page; this module contains no interpreter or source evaluator.
mod animation;
mod bindings;
mod canvas;
mod compat;
mod dom;
mod engine;
mod events;
mod fetch;
#[cfg(feature = "browser-tests")]
mod fixtures;
mod gesture;
mod keymap;
mod modules;
mod protocol;
mod reactive;
mod resource;
mod rows;
mod standard;
mod timers;
mod values;

use std::{cell::RefCell, rc::Rc};

use nsh_core::{element::JsHost, js::host::HostInput};
use values::{EXCEPTION, Value};

struct Runtime {
    reactive: Rc<reactive::Runtime>,
    modules: modules::Modules,
    bindings: Rc<bindings::Bindings>,
    dom: dom::Dom,
    rows: rows::Rows,
    resources: resource::Resources,
    standard: standard::Standard,
    animation: animation::Animations,
    gestures: gesture::Gestures,
    timers: timers::Timers,
    fetches: fetch::Fetches,
    listener: RefCell<Option<Value>>,
    registries: RefCell<Vec<nsh_core::element::Registry>>,
    tokens: RefCell<Option<std::sync::Arc<nsh_core::element::Tokens>>>,
    theme: RefCell<Option<nsh_core::element::ThemeTokens>>,
    host: RefCell<Option<Rc<dyn nsh_core::host_channel::HostBridge>>>,
    wake: RefCell<Option<std::sync::Arc<dyn Fn() + Send + Sync>>>,
    fonts: RefCell<Vec<String>>,
    options: RefCell<(Option<String>, Option<String>)>,
}
impl Default for Runtime {
    fn default() -> Self {
        let bindings = bindings::Bindings::new();
        let reactive = Rc::new(reactive::Runtime::default());
        *bindings.reactive.borrow_mut() = Rc::downgrade(&reactive);
        Self {
            reactive,
            modules: modules::Modules::new(bindings.clone()),
            dom: dom::Dom::new(bindings.clone()),
            rows: rows::Rows::default(),
            resources: resource::Resources::default(),
            standard: standard::Standard::default(),
            animation: animation::Animations::default(),
            gestures: gesture::Gestures::default(),
            timers: timers::Timers::default(),
            fetches: fetch::Fetches::default(),
            listener: RefCell::default(),
            registries: RefCell::default(),
            tokens: RefCell::default(),
            theme: RefCell::default(),
            host: RefCell::default(),
            wake: RefCell::default(),
            fonts: RefCell::default(),
            options: RefCell::default(),
            bindings,
        }
    }
}
impl Runtime {
    /// Makes `error` the JS exception the call throws (its class, message
    /// and `code` / ... fields); the `PropError` returned carries its
    /// message.
    fn throw(&self, error: nsh_core::element::JsError) -> nsh_core::element::PropError {
        use nsh_core::element::IntoThrown;
        let thrown = error.into_thrown();
        if let Ok(value) = self.modules.error(&thrown) {
            values::invoke(37, value.0, 0, 0, 0.0);
        }
        nsh_core::element::PropError(thrown.message().into())
    }

    fn call(&self, op: u32, args: &Value) -> Result<Value, nsh_core::element::PropError> {
        match op {
            1000..=1006 => self.timers.call(op, args),
            1007..=1009 => self.fetches.call(op, args),
            // Why the engine refuses a WebSocket to the URL before it
            // reaches the network (a test's: `System::refuse_connections`),
            // or `undefined`: the realm's `WebSocket` (`testing.js`).
            1010 => {
                let url = args.index(0)?.as_string().unwrap_or_default();
                let refused = self.bindings.system.borrow().check_connection(&url);
                match refused {
                    Ok(()) => Ok(Value(0)),
                    Err(error) => Value::string(error.message()),
                }
            }
            800..=807 => self.resources.call(op, args),
            900..=906 => self.standard.call(op, args),
            700..=702 => self.gestures.call(&self.bindings, op, args),
            313..=315 => self.dom.call(op, args),
            600..=603 => canvas::call(&self.bindings, op, args),
            500..=507 => self.animation.call(&self.bindings, op, args),
            450..=451 => keymap::call(&self.bindings, op, args),
            310..=312 => self.rows.call(op, args),
            300..=309 => self.dom.call(op, args),
            100..=114 => self.reactive.call(op, args),
            430 => {
                let host = self.host.borrow().clone();
                let available = host.as_ref().is_some_and(|host| host.available());
                let params = host
                    .map(|host| host.params())
                    .unwrap_or_else(|| serde_json::json!({}));
                let params = self.bindings.json(&params)?;
                Value::array([
                    Value(if available { 3 } else { 2 }),
                    Value(params.0[0] as u32),
                ])
            }
            // The SDK channel's calls and posts (`host.js`): what fails is
            // thrown as `nsh-js`'s channel throws it, with its class and
            // `code` (`nsh_core::host_channel`'s errors).
            431 | 432 => {
                let name = args
                    .index(0)?
                    .as_string()
                    .ok_or_else(|| nsh_core::element::PropError("host: a message name".into()))?;
                nsh_core::host_channel::check_name(&name).map_err(nsh_core::element::PropError)?;
                let checked = nsh_core::host_channel::check_call(
                    &self.bindings.system.borrow().access,
                    &name,
                );
                checked.map_err(|e| self.throw(e))?;
                let data = protocol::to_json(&compat::Value::new(args.index(1)?))?;
                let id = args.index(2)?.as_number().unwrap_or(0.0) as u64;
                let host = self
                    .host
                    .borrow()
                    .clone()
                    .ok_or_else(|| self.throw(nsh_core::host_channel::no_host()))?;
                if op == 431 {
                    host.call(id, &name, data).map_err(|message| {
                        self.throw(nsh_core::host_channel::host_error(&message))
                    })?;
                } else {
                    host.post(&name, data);
                }
                Ok(Value(0))
            }
            200 => {
                let registries = self.registries.borrow().clone();
                self.modules.describe(if registries.is_empty() {
                    nsh_core::runtime::registries()
                } else {
                    &registries
                })
            }
            402 => {
                use nsh_core::element::Token;
                let name = args.index(0)?.as_string().unwrap_or_default();
                let dark = args.index(1)?.truthy();
                let token = self.tokens.borrow().as_ref().and_then(|t| t.get(&name));
                match token {
                    Some(Token::Number(n)) => Ok(Value::number(n.into())),
                    Some(Token::Font(f)) => Value::string(&f),
                    Some(Token::Color(c)) => Value::string(&format!(
                        "#{:08x}",
                        nsh_core::Color::from(if dark { c.dark } else { c.light }).0
                    )),
                    None => Ok(Value(0)),
                }
            }
            403 => {
                let json = args.index(0)?.as_string().unwrap_or_default();
                let tokens = self
                    .theme
                    .borrow()
                    .as_ref()
                    .and_then(|theme| theme.of(&json));
                if let Some(tokens) = tokens {
                    *self.tokens.borrow_mut() = Some(std::sync::Arc::new(tokens));
                }
                Ok(Value(0))
            }
            404 => {
                let uri = args
                    .index(0)?
                    .as_string()
                    .ok_or_else(|| nsh_core::element::PropError("expected font URI".into()))?;
                self.fonts.borrow_mut().push(uri);
                args.index(1)
            }
            405 => {
                let json = args.index(0)?.as_string().unwrap_or_default();
                if let Ok(value) = serde_json::from_str(&json)
                    && let Ok(setting) = nsh_core::StatusBarSetting::from_json(&value)
                {
                    self.bindings.ops.borrow_mut().push(nsh_core::Op::Command {
                        id: 1,
                        command: nsh_core::Command::SetStatusBar(setting),
                    });
                }
                Ok(Value(0))
            }
            401 => {
                let id = args.index(0)?.as_string();
                let capabilities = args.index(1)?.as_string().filter(|v| !v.is_empty());
                *self.options.borrow_mut() = (id, capabilities);
                Ok(Value(0))
            }
            400 => {
                let listener = args.index(0)?;
                *self.listener.borrow_mut() = Some(listener);
                Ok(Value(0))
            }
            206 => {
                let index = args.index(0)?.as_number().unwrap_or(f64::NAN) as usize;
                let node = args.index(1)?.node().ok_or_else(|| {
                    nsh_core::element::PropError("expected component node".into())
                })?;
                let key = args.index(2)?.as_string().unwrap_or_default();
                self.modules.prop(index, node, &key, args.index(3)?)
            }
            207 => {
                let index = args.index(0)?.as_number().unwrap_or(f64::NAN) as usize;
                let node = args.index(1)?.node().ok_or_else(|| {
                    nsh_core::element::PropError("expected component node".into())
                })?;
                let method = args.index(2)?.as_number().unwrap_or(f64::NAN) as usize;
                self.modules
                    .method(
                        index,
                        node,
                        method,
                        args.index(3)?,
                        args.index(4)?,
                        args.index(5)?.as_number().unwrap_or(0.0) as u32,
                    )
                    .map_err(|e| nsh_core::element::PropError(e.message().into()))
            }
            201 | 202 => {
                let index = args.index(0)?.as_number().unwrap_or(f64::NAN) as usize;
                let result = if op == 201 {
                    self.modules.function(
                        index,
                        args.index(1)?,
                        args.index(2)?,
                        args.index(3)?.as_number().unwrap_or(0.0) as u32,
                    )
                } else {
                    self.modules.member(
                        index,
                        args.index(1)?.as_number().unwrap_or(f64::NAN) as usize,
                        args.index(2)?,
                        args.index(3)?,
                        args.index(4)?.as_number().unwrap_or(0.0) as u32,
                    )
                };
                result.map_err(|error| {
                    if let Ok(value) = self.modules.error(&error) {
                        values::invoke(37, value.0, 0, 0, 0.0);
                    }
                    nsh_core::element::PropError(error.message().into())
                })
            }
            205 => {
                use nsh_core::element::JsHost;
                let value = args.index(0)?;
                let class = args.index(1)?.as_number().unwrap_or(f64::NAN) as usize;
                let expected = self
                    .bindings
                    .classes
                    .borrow()
                    .get(class)
                    .copied()
                    .ok_or_else(|| nsh_core::element::PropError("unknown class".into()))?;
                let instance = self
                    .bindings
                    .instance(bindings::raw(value.0))
                    .filter(|i| (i.def().type_id)() == (expected.type_id)())
                    .ok_or_else(|| {
                        nsh_core::element::PropError("illegal class disposal receiver".into())
                    })?;
                instance.dispose().map_err(nsh_core::element::PropError)?;
                Ok(Value(0))
            }
            208 => {
                self.bindings
                    .call_function(args.index(0)?.as_number().unwrap_or(0.0) as u32);
                Ok(Value(0))
            }
            209 => {
                self.bindings
                    .release_function(args.index(0)?.as_number().unwrap_or(0.0) as u32);
                Ok(Value(0))
            }
            203 => {
                self.bindings
                    .release_instance(args.index(0)?.as_number().unwrap_or(0.0) as u32);
                Ok(Value(0))
            }
            204 => {
                self.bindings.settle(
                    args.index(0)?.as_number().unwrap_or(0.0) as u32,
                    args.index(1)?.truthy(),
                    args.index(2)?,
                );
                Ok(Value(0))
            }
            _ => Err(nsh_core::element::PropError(format!(
                "unknown browser operation {op}"
            ))),
        }
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        self.reactive.finish();
        self.bindings.stop();
    }
}

thread_local! {
    static REACTIVE: RefCell<Option<Rc<Runtime>>> = const { RefCell::new(None) };
}

/// Start one browser graph. The player disposes the previous app before
/// replacing the graph, so its delayed callbacks cannot reach this one.
#[unsafe(no_mangle)]
pub(crate) extern "C" fn nsh_browser_initialize() {
    let previous = REACTIVE.with(|slot| slot.borrow_mut().replace(Rc::new(Runtime::default())));
    drop(previous);
    #[cfg(feature = "browser-tests")]
    REACTIVE.with(|slot| {
        slot.borrow()
            .as_ref()
            .unwrap()
            .registries
            .borrow_mut()
            .extend(
                nsh_core::runtime::registries()
                    .iter()
                    .cloned()
                    .chain([fixtures::registry()]),
            );
    });
}

/// Release a stopped app's graph after its owners have been disposed.
#[unsafe(no_mangle)]
pub(crate) extern "C" fn nsh_browser_dispose() {
    let previous = REACTIVE.with(|slot| slot.borrow_mut().take());
    drop(previous);
}

/// Enumerate references at a quiescent outermost Wasm boundary. Collect
/// raw handle IDs first; no graph/instance borrow crosses a browser call.
#[unsafe(no_mangle)]
pub(crate) extern "C" fn nsh_browser_trace() {
    let runtime = REACTIVE.with(|slot| slot.borrow().clone());
    if let Some(runtime) = runtime {
        let mut edges = Vec::new();
        runtime.bindings.trace_edges(&mut edges);
        runtime.reactive.trace_edges(&mut edges);
        runtime.dom.trace_edges(&mut edges);
        for (kind, owner, generation, value) in edges {
            values::invoke(46, kind, owner, generation, value.into());
        }
    }
}

/// Dispatch one synchronous call with arguments in a borrowed browser
/// array. The result is an owned value handle (or the exception sentinel).
#[unsafe(no_mangle)]
pub(crate) extern "C" fn nsh_browser_call(op: u32, args: u32) -> u32 {
    let runtime = REACTIVE.with(|slot| slot.borrow().clone());
    let result = runtime
        .ok_or_else(|| nsh_core::element::PropError("the app was disposed".into()))
        .and_then(|runtime| runtime.call(op, &Value::borrowed(args)));
    match result {
        Ok(value) => {
            if values::invoke(45, 0, 0, 0, 0.0) != 0.0 {
                drop(value);
                EXCEPTION
            } else {
                value.into_raw()
            }
        }
        Err(error) => {
            values::invoke(31, 0, error.0.as_ptr() as u32, error.0.len() as u32, 0.0);
            EXCEPTION
        }
    }
}

/// Start the trusted standalone browser app. Its ES modules are imported
/// by the player after this installs the Rust engine and its UI sets.
#[unsafe(no_mangle)]
pub(crate) extern "C" fn nsh_browser_start(
    width: f32,
    height: f32,
    dark: u32,
    pixel_ratio: f32,
) -> f64 {
    crate::init();
    let result: Result<f64, String> = (|| {
        let runtime = REACTIVE
            .with(|slot| slot.borrow().clone())
            .ok_or("the browser host was not initialized")?;
        let (id, capabilities) = runtime.options.borrow().clone();
        let mut bundle = nsh_engine::Bundle::source(String::new())
            .with_app_id(id.as_deref())
            .with_capabilities_json(capabilities.as_deref())
            .map_err(|e| e.to_string())?;
        bundle.base_url = crate::BASE_URL.with(|b| b.borrow().as_deref().map(Into::into));
        let previous = crate::APP.with(|slot| slot.borrow_mut().take());
        drop(previous);
        if runtime.bindings.stopped.get() {
            return Err("a disposed browser host cannot be restarted".into());
        }
        let _registration = nsh_engine::browser::register(runtime)?;
        Ok(crate::run(
            nsh_engine::App::Js(bundle),
            width,
            height,
            crate::environment(width, height, dark != 0, pixel_ratio),
            nsh_engine::Limits::standalone(),
        ))
    })();
    match result {
        Ok(delay) => delay,
        Err(error) => {
            crate::ffi::report_error(&error);
            -2.0
        }
    }
}
