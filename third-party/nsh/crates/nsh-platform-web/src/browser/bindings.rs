//! Typed Rust calls over browser value handles.
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::{Rc, Weak},
};

use nsh_core::{
    Op,
    element::{
        CallbackHandle, ClassDef, ClassInstance, Exception, JsCall, JsHost, JsIn, JsKind, JsRaw,
        Posts, PropError, RustCall, RustOp, System, TaskStart,
    },
    js::host::HostInput,
};

use super::{
    compat, protocol,
    values::{Value, invoke},
};

struct Frame {
    this: Value,
    args: Value,
    borrowed: Vec<Value>,
}
struct FrameGuard<'a>(&'a Bindings);
impl Drop for FrameGuard<'_> {
    fn drop(&mut self) {
        let frame = self.0.frames.borrow_mut().pop();
        drop(frame);
    }
}

pub(super) struct Bindings {
    own: Weak<Self>,
    frames: RefCell<Vec<Frame>>,
    pub(super) ops: RefCell<Vec<Op>>,
    pub(super) posts: RefCell<Posts>,
    pub(super) system: RefCell<System>,
    pub(super) classes: RefCell<Vec<&'static ClassDef>>,
    instances: RefCell<Vec<Option<Rc<dyn ClassInstance>>>>,
    callbacks: RefCell<HashMap<u32, Weak<BrowserCallback>>>,
    pending: RefCell<HashMap<u32, JsCall>>,
    primitive_callbacks: RefCell<Vec<Weak<BrowserCallback>>>,
    next_call: Cell<u32>,
    pub(super) stopped: Cell<bool>,
    pub(super) reactive: RefCell<Weak<super::reactive::Runtime>>,
}
impl Bindings {
    pub(super) fn new() -> Rc<Self> {
        Rc::new_cyclic(|own| Self {
            own: own.clone(),
            frames: RefCell::default(),
            ops: RefCell::default(),
            posts: RefCell::new(Posts::new()),
            system: RefCell::default(),
            classes: RefCell::default(),
            instances: RefCell::default(),
            callbacks: RefCell::default(),
            pending: RefCell::default(),
            primitive_callbacks: RefCell::default(),
            next_call: Cell::new(1),
            stopped: Cell::new(false),
            reactive: RefCell::default(),
        })
    }
    pub(super) fn with_call<T>(
        &self,
        this: Value,
        args: Value,
        call: impl FnOnce(&Self) -> T,
    ) -> T {
        self.frames.borrow_mut().push(Frame {
            this,
            args,
            borrowed: Vec::new(),
        });
        let _guard = FrameGuard(self);
        call(self)
    }
    pub(super) fn call_id(&self) -> u32 {
        let id = self.next_call.get();
        self.next_call
            .set(id.checked_add(1).expect("browser call id exhausted"));
        id
    }
    pub(super) fn class_id(&self, def: &'static ClassDef) -> u32 {
        let mut classes = self.classes.borrow_mut();
        match classes
            .iter()
            .position(|c| (c.type_id)() == (def.type_id)())
        {
            Some(i) => i as u32,
            None => {
                let id = classes.len() as u32;
                classes.push(def);
                id
            }
        }
    }
    fn keep_instance(&self, instance: Rc<dyn ClassInstance>) -> u32 {
        let mut instances = self.instances.borrow_mut();
        if let Some(id) = instances
            .iter()
            .position(|old| old.as_ref().is_some_and(|old| Rc::ptr_eq(old, &instance)))
        {
            return id as u32 + 1;
        }
        let id = instances.len() as u32 + 1;
        instances.push(Some(instance));
        id
    }
    pub(super) fn release_instance(&self, id: u32) {
        let instance = self
            .instances
            .borrow_mut()
            .get_mut(id.wrapping_sub(1) as usize)
            .and_then(Option::take);
        drop(instance);
    }
    /// Match the native collector's conservative Trace contract. A Rust
    /// task or another instance retaining this value is an external root.
    pub(super) fn trace_edges(&self, edges: &mut Vec<(u32, u32, u32, u32)>) {
        let instances = self.instances.borrow();
        for (index, instance) in instances.iter().enumerate() {
            let Some(instance) = instance else { continue };
            if Rc::strong_count(instance) != 1 {
                continue;
            }
            instance.trace(&mut nsh_core::element::Tracer::new(&mut |callback| {
                let any: &dyn std::any::Any = callback;
                if let Some(callback) = any.downcast_ref::<BrowserCallback>()
                    && Weak::ptr_eq(&callback.host, &self.own)
                    && !self.stopped.get()
                    && let Ok(value) = callback.value.try_borrow()
                    && let Some(value) = &*value
                {
                    edges.push((0, index as u32 + 1, 0, value.0));
                }
            }));
        }
    }
    pub(super) fn stop(&self) {
        if self.stopped.replace(true) {
            return;
        }
        self.posts.borrow().close();
        // Closing resources may post callbacks; stopped is already set.
        let locals = self.system.borrow().locals.clone();
        locals.close_all();
        let pending = self.pending.take();
        let instances = self.instances.take();
        let ops = self.ops.take();
        // Externally retained callbacks may outlive this app. Release their
        // arena handles now, before a later run installs a different arena.
        let callbacks = self.callbacks.take();
        let primitives = self.primitive_callbacks.take();
        for callback in callbacks
            .into_values()
            .chain(primitives)
            .filter_map(|c| c.upgrade())
        {
            let value = callback.value.borrow_mut().take();
            drop(value);
        }
        drop((pending, instances, ops));
    }
    fn keep_callback(&self, raw: JsRaw) -> Rc<BrowserCallback> {
        if !matches!(
            self.kind(raw),
            JsKind::Object | JsKind::Function | JsKind::Array
        ) {
            let callback = Rc::new(BrowserCallback {
                host: self.own.clone(),
                value: RefCell::new(Some(Value::borrowed(id(raw)))),
            });
            let mut retained = self.primitive_callbacks.borrow_mut();
            retained.retain(|value| value.strong_count() != 0);
            retained.push(Rc::downgrade(&callback));
            return callback;
        }
        let id = invoke(33, id(raw), 0, 0, 0.0) as u32;
        if let Some(callback) = self.callbacks.borrow().get(&id).and_then(Weak::upgrade) {
            return callback;
        }
        let callback = Rc::new(BrowserCallback {
            host: self.own.clone(),
            value: RefCell::new(Some(Value::borrowed(id_raw(raw)))),
        });
        self.callbacks
            .borrow_mut()
            .insert(id, Rc::downgrade(&callback));
        callback
    }
    pub(super) fn run_call(&self, mut call: JsCall) {
        if self.stopped.get() {
            return;
        }
        let callback = call.callback().value(self);
        let Some(callback) = callback else {
            return;
        };
        let callback = Value(id(callback));
        let args = match call
            .args(self)
            .and_then(|args| Value::array(args.into_iter().map(|v| Value(id(v.into_raw())))))
        {
            Ok(args) => args,
            Err(error) => {
                call.reply(Err(error.0.into()));
                return;
            }
        };
        let result = callback.call(&Value(0), &args);
        match result {
            Err(error) => call.reply(Err(Exception {
                message: error.0,
                stack: None,
            })),
            Ok(result) if call.settles() => {
                let id = self.call_id();
                self.pending.borrow_mut().insert(id, call);
                invoke(35, result.0, id, 0, 0.0);
            }
            Ok(result) => call.reply(Ok(JsIn::new(self, raw(result.0)))),
        }
    }
    pub(super) fn settle(&self, id: u32, ok: bool, value: Value) {
        let call = self.pending.borrow_mut().remove(&id);
        if let Some(call) = call {
            if ok {
                call.reply(Ok(JsIn::new(self, raw(value.0))));
            } else {
                call.reply(Err(Exception {
                    message: value
                        .get("message")
                        .ok()
                        .and_then(|v| v.as_string())
                        .unwrap_or_else(|| self.describe(raw(value.0))),
                    stack: value.get("stack").ok().and_then(|v| v.as_string()),
                }));
            }
        }
    }
}
fn id(raw: JsRaw) -> u32 {
    raw.0[0] as u32
}
fn id_raw(raw: JsRaw) -> u32 {
    id(raw)
}
pub(super) fn raw(id: u32) -> JsRaw {
    JsRaw([id.into(), 0])
}
fn owned(value: Value) -> JsRaw {
    raw(value.into_raw())
}

struct BrowserCallback {
    host: Weak<Bindings>,
    value: RefCell<Option<Value>>,
}
impl CallbackHandle for BrowserCallback {
    fn call_now(&self, call: JsCall) {
        if let Some(host) = self.host.upgrade() {
            host.run_call(call);
        }
    }
    fn post(&self, call: JsCall) {
        if let Some(host) = self.host.upgrade() {
            if host.stopped.get() {
                return;
            }
            if host.frames.borrow().is_empty() {
                host.posts.borrow().post(call);
            } else {
                let place = host.posts.borrow().park(call);
                host.ops.borrow_mut().push(Op::Rust(RustOp {
                    call: 0,
                    run: RustCall::Post(place),
                }));
            }
        }
    }
    fn value(&self, host: &dyn JsHost) -> Option<JsRaw> {
        let own = self.host.upgrade()?;
        if own.stopped.get() || !std::ptr::addr_eq::<Bindings, dyn JsHost>(&*own, host) {
            return None;
        }
        let value = self.value.borrow();
        let value = value.as_ref()?;
        if invoke(47, value.0, 0, 0, 0.0) == 0.0 {
            return None;
        }
        Some(owned(value.clone()))
    }
}
impl JsHost for Bindings {
    fn kind(&self, value: JsRaw) -> JsKind {
        match invoke(0, id(value), 0, 0, 0.0) as u32 {
            0 => JsKind::Undefined,
            1 => JsKind::Null,
            2 => JsKind::Bool,
            3 => JsKind::Number,
            4 => JsKind::String,
            5 => JsKind::Array,
            6 => JsKind::Function,
            7 => JsKind::Object,
            _ => JsKind::Other,
        }
    }
    fn bool(&self, value: JsRaw) -> Option<bool> {
        Value::borrowed(id(value)).as_bool()
    }
    fn number(&self, value: JsRaw) -> Option<f64> {
        Value::borrowed(id(value)).as_number()
    }
    fn string(&self, value: JsRaw) -> Option<String> {
        Value::borrowed(id(value)).as_string()
    }
    fn bytes(&self, value: JsRaw) -> Option<Vec<u8>> {
        Value::borrowed(id(value)).read_bytes()
    }
    fn len(&self, value: JsRaw) -> Result<Option<usize>, PropError> {
        Value::borrowed(id(value)).length()
    }
    fn index(&self, value: JsRaw, index: usize) -> Result<JsRaw, PropError> {
        Value::borrowed(id(value)).index(index).map(owned)
    }
    fn field(&self, value: JsRaw, key: &str) -> Result<JsRaw, PropError> {
        Value::borrowed(id(value)).get(key).map(owned)
    }
    fn keys(&self, value: JsRaw) -> Result<Vec<String>, PropError> {
        Value::borrowed(id(value)).keys()
    }
    fn date(&self, value: JsRaw) -> Option<f64> {
        let n = invoke(11, id(value), 0, 0, 0.0);
        (!n.is_nan()).then_some(n)
    }
    fn to_json(&self, value: JsRaw) -> Result<nsh_core::JsonValue, PropError> {
        protocol::to_json(&compat::Value::new(Value::borrowed(id(value))))
    }
    fn describe(&self, value: JsRaw) -> String {
        Value::checked(invoke(13, id(value), 0, 0, 0.0))
            .ok()
            .and_then(|v| v.as_string())
            .unwrap_or_else(|| "a browser value".into())
    }
    fn style(&self, value: JsRaw) -> Result<nsh_core::StylePatch, PropError> {
        protocol::style_patch(
            &compat::Value::new(Value::borrowed(id(value))),
            &mut protocol::Warnings::default(),
        )
    }
    fn node(&self, value: JsRaw) -> Option<u32> {
        Value::borrowed(id(value)).node()
    }
    fn node_value(&self, node: u32) -> JsRaw {
        raw(invoke(15, node, 0, 0, 0.0) as u32)
    }
    fn instance(&self, value: JsRaw) -> Option<Rc<dyn ClassInstance>> {
        let index = invoke(29, id(value), 0, 0, 0.0) as u32;
        self.instances
            .borrow()
            .get(index.wrapping_sub(1) as usize)
            .and_then(Clone::clone)
    }
    fn callback(&self, value: JsRaw) -> Option<Rc<dyn CallbackHandle>> {
        (self.kind(value) == JsKind::Function)
            .then(|| self.keep_callback(value) as Rc<dyn CallbackHandle>)
    }
    fn retain(&self, value: JsRaw) -> Option<Rc<dyn CallbackHandle>> {
        Some(self.keep_callback(value))
    }
    fn free(&self, value: JsRaw) {
        drop(Value(id(value)));
    }
    fn undefined(&self) -> JsRaw {
        raw(0)
    }
    fn null(&self) -> JsRaw {
        raw(1)
    }
    fn new_bool(&self, value: bool) -> JsRaw {
        raw(if value { 3 } else { 2 })
    }
    fn new_number(&self, value: f64) -> JsRaw {
        owned(Value::number(value))
    }
    fn new_string(&self, value: &str) -> Result<JsRaw, PropError> {
        Value::string(value).map(owned)
    }
    fn new_bytes(&self, value: &[u8]) -> Result<JsRaw, PropError> {
        Value::bytes(value).map(owned)
    }
    fn new_file(
        &self,
        data: &nsh_core::ImageData,
        mime: &str,
        name: &str,
        last_modified: Option<std::time::SystemTime>,
    ) -> Result<JsRaw, PropError> {
        let bytes = Value::bytes(data.bytes())?;
        let name = Value::string(name)?;
        let mime = Value::string(mime)?;
        let millis = last_modified
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(f64::NAN, |d| d.as_millis() as f64);
        Value::checked(invoke(41, bytes.0, name.0, mime.0, millis)).map(owned)
    }
    fn new_date(&self, value: f64) -> Result<JsRaw, PropError> {
        Value::checked(invoke(25, 0, 0, 0, value)).map(owned)
    }
    fn new_array(&self, items: Vec<JsRaw>) -> Result<JsRaw, PropError> {
        Value::array(items.into_iter().map(|v| Value(id(v)))).map(owned)
    }
    fn new_object(&self) -> Result<JsRaw, PropError> {
        Value::object().map(owned)
    }
    fn set_field(&self, object: JsRaw, key: &str, value: JsRaw) -> Result<(), PropError> {
        Value::borrowed(id(object)).set(key, &Value(id(value)))
    }
    fn json(&self, value: &nsh_core::JsonValue) -> Result<JsRaw, PropError> {
        use nsh_core::JsonValue as J;
        Ok(match value {
            J::Null => self.null(),
            J::Bool(v) => self.new_bool(*v),
            J::Number(v) => self.new_number(v.as_f64().unwrap_or(f64::NAN)),
            J::String(v) => self.new_string(v)?,
            J::Array(items) => {
                let mut out = Vec::new();
                for item in items {
                    out.push(Value(id(self.json(item)?)));
                }
                owned(Value::array(out)?)
            }
            J::Object(fields) => {
                let out = Value::object()?;
                for (key, value) in fields {
                    out.set(key, &Value(id(self.json(value)?)))?;
                }
                owned(out)
            }
        })
    }
    fn wrap(&self, instance: Rc<dyn ClassInstance>) -> Result<JsRaw, PropError> {
        let class = self.class_id(instance.def());
        let index = self.keep_instance(instance);
        Value::checked(invoke(28, index, class, 0, 0.0)).map(owned)
    }
    fn arg(&self, index: usize) -> JsRaw {
        let args = self.frames.borrow().last().map(|f| f.args.clone());
        let value = args.and_then(|a| a.index(index).ok()).unwrap_or(Value(0));
        let result = raw(value.0);
        if let Some(frame) = self.frames.borrow_mut().last_mut() {
            frame.borrowed.push(value);
        }
        result
    }
    fn this(&self) -> JsRaw {
        self.frames
            .borrow()
            .last()
            .map_or(raw(0), |f| raw(f.this.0))
    }
    fn construct(&self, instance: Rc<dyn ClassInstance>) -> Result<JsRaw, PropError> {
        let this = self
            .frames
            .borrow()
            .last()
            .map(|f| f.this.clone())
            .ok_or_else(|| PropError("constructor called without a frame".into()))?;
        let index = self.keep_instance(instance);
        Value::checked(invoke(34, this.0, index, 0, 0.0))?;
        Ok(owned(this))
    }
    fn on_cleanup(&self, f: Box<dyn FnOnce()>) -> Box<dyn FnOnce()> {
        match self.reactive.borrow().upgrade() {
            Some(graph) => graph.on_cleanup(f),
            None => {
                drop(f);
                Box::new(|| {})
            }
        }
    }
    fn system(&self) -> System {
        self.system.borrow().clone()
    }
    fn start_task(&self, task: TaskStart) {
        self.ops.borrow_mut().push(Op::Rust(RustOp {
            call: 0,
            run: RustCall::Task(task),
        }));
    }
}
