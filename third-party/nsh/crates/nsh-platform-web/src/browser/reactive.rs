//! Browser callbacks on the same reactive scheduler used by native apps.
use std::{
    cell::{RefCell, UnsafeCell},
    rc::Rc,
};
type RustCleanup = Rc<RefCell<Option<Box<dyn FnOnce()>>>>;
enum Cleanup {
    Browser(Value),
    Rust(RustCleanup),
}
use nsh_core::{
    element::PropError,
    js::host::HostInput,
    reactive::{self as r, Equals, Host as _, Kind},
};

use super::values::{Value, invoke};

#[derive(Clone, Copy)]
struct Host(*mut r::Graph<Self>);
#[derive(Default)]
struct Data {
    error: Option<String>,
}

// SAFETY: the graph is owned by Runtime on the browser thread. Every
// graph borrow ends before invoking a browser function or releasing a
// value. Runtime outlives all calls; disposed app callbacks are rejected.
unsafe impl r::Host for Host {
    type Value = Value;
    type Func = Value;
    type Equals = Value;
    type Cleanup = Cleanup;
    type Context = (Value, Value);
    type Data = Data;
    unsafe fn graph<'a>(self) -> &'a mut r::Graph<Self> {
        unsafe { &mut *self.0 }
    }
    fn empty() -> Value {
        Value(0)
    }
    fn dup(self, value: &Value) -> Value {
        value.clone()
    }
    fn free(self, value: Value) {
        drop(value);
    }
    fn dup_func(self, value: &Value) -> Value {
        value.clone()
    }
    fn free_func(self, value: Value) {
        drop(value);
    }
    fn dup_equals(self, value: &Value) -> Value {
        value.clone()
    }
    fn free_equals(self, value: Value) {
        drop(value);
    }
    fn call(self, func: &Value, previous: Value) -> Option<Value> {
        let result = Value::array([previous]).and_then(|args| func.call(&Value(0), &args));
        match result {
            Ok(value) => Some(value),
            Err(error) => {
                unsafe { self.graph() }.data.error.get_or_insert(error.0);
                None
            }
        }
    }
    fn same(self, a: &Value, b: &Value) -> bool {
        invoke(32, a.0, b.0, 0, 0.0) != 0.0
    }
    fn truthy(self, value: &Value) -> bool {
        value.truthy()
    }
    fn custom_changed(self, func: &Value, previous: Value, next: &Value) -> bool {
        let result =
            Value::array([previous, next.clone()]).and_then(|args| func.call(&Value(0), &args));
        match result {
            Ok(value) => !value.truthy(),
            Err(error) => {
                unsafe { self.graph() }.data.error.get_or_insert(error.0);
                false
            }
        }
    }
    fn run_cleanup(self, cleanup: Cleanup) {
        match cleanup {
            Cleanup::Browser(func) => {
                self.call(&func, Value(0));
            }
            Cleanup::Rust(f) => {
                let f = f.borrow_mut().take();
                if let Some(f) = f {
                    f();
                }
            }
        }
    }
    fn free_cleanup(self, cleanup: Cleanup) {
        drop(cleanup);
    }
    fn runaway(self) {
        unsafe { self.graph() }.data.error = Some("reactive update limit exceeded".into());
    }
}

pub(super) struct Runtime {
    graph: Box<UnsafeCell<r::Graph<Host>>>,
    outside: RefCell<Vec<RustCleanup>>,
    handles: RefCell<std::collections::HashMap<u32, u32>>,
}
impl Default for Runtime {
    fn default() -> Self {
        Self {
            graph: Box::new(UnsafeCell::new(r::Graph::new(Data::default()))),
            outside: RefCell::default(),
            handles: RefCell::default(),
        }
    }
}
impl Runtime {
    pub(super) fn on_cleanup(self: &Rc<Self>, f: Box<dyn FnOnce()>) -> Box<dyn FnOnce()> {
        let callback = Rc::new(RefCell::new(Some(f)));
        let owner = self.owner();
        if unsafe { self.host().graph() }
            .on_cleanup(Cleanup::Rust(callback.clone()))
            .is_err()
        {
            self.outside.borrow_mut().push(callback.clone());
        }
        let runtime = Rc::downgrade(self);
        Box::new(move || {
            let removed = runtime.upgrade().and_then(|runtime| {
                unsafe { runtime.host().graph() }.remove_cleanup(
                    owner,
                    |cleanup| matches!(cleanup,Cleanup::Rust(other) if Rc::ptr_eq(&callback,other)),
                )
            });
            let f = callback.borrow_mut().take();
            drop((removed, f));
        })
    }
    pub(super) fn finish(&self) {
        let outside = self.outside.take();
        for callback in outside {
            let f = callback.borrow_mut().take();
            if let Some(f) = f {
                f();
            }
        }
    }
    fn host(&self) -> Host {
        Host(self.graph.get())
    }
    fn handle(&self, id: u32) -> Result<Value, PropError> {
        if !unsafe { self.host().graph() }.is_live_owner(id) && id >= r::DISPOSED {
            return Ok(Value(1));
        }
        let generation = unsafe { self.host().graph() }.generation(id);
        self.handles.borrow_mut().insert(id, generation);
        Value::array([Value::number(id.into()), Value::number(generation.into())])
    }
    fn node(&self, handle: &Value) -> Result<u32, PropError> {
        let id = handle
            .index(0)?
            .as_number()
            .ok_or_else(|| PropError("invalid reactive handle".into()))? as u32;
        let generation = handle
            .index(1)?
            .as_number()
            .ok_or_else(|| PropError("invalid reactive generation".into()))?
            as u32;
        if !unsafe { self.host().graph() }.live(id, generation, u32::MAX) {
            return Err(PropError("the reactive owner was disposed".into()));
        }
        Ok(id)
    }
    fn equals(value: Value) -> Equals<Value> {
        if value.as_bool() == Some(false) {
            Equals::Never
        } else if value.kind() == 6 {
            Equals::Custom(value)
        } else {
            Equals::Default
        }
    }
    /// Only payloads whose lifetime belongs to a JS handle can be
    /// attributed to that handle. Active scheduler-owned memos stay rooted.
    pub(super) fn trace_edges(&self, edges: &mut Vec<(u32, u32, u32, u32)>) {
        let graph = unsafe { self.host().graph() };
        self.handles.borrow_mut().retain(|id, generation| {
            if !graph.live(*id, *generation, u32::MAX) {
                return false;
            }
            if graph.kind(*id) == Kind::Signal || graph.disposed(*id) {
                edges.push((1, *id, *generation, graph.value(*id).0));
                if let Some(equals) = graph.custom_equals(*id) {
                    edges.push((1, *id, *generation, equals.0));
                }
            }
            true
        });
    }
    pub(super) fn owner(&self) -> u32 {
        unsafe { self.host().graph() }.owner()
    }
    pub(super) fn dispose(&self, owner: u32) {
        r::dispose_owner(self.host(), owner);
    }
    pub(super) fn call(&self, op: u32, args: &Value) -> Result<Value, PropError> {
        let h = self.host();
        let result = match op {
            100 => {
                let value = args.index(0)?;
                let equals = Self::equals(args.index(1)?);
                let id = unsafe { h.graph() }.signal(value, equals);
                self.handle(id)
            }
            101 => {
                let id = self.node(&args.index(0)?)?;
                Ok(r::read(h, id))
            }
            102 => {
                let id = self.node(&args.index(0)?)?;
                let value = args.index(1)?;
                r::write(h, id, value.clone());
                Ok(value)
            }
            103 => {
                let func = args.index(0)?;
                let value = args.index(1)?;
                let equals = Self::equals(args.index(2)?);
                let id = r::memo(h, func, value, equals, true);
                self.handle(id)
            }
            104 => {
                let func = args.index(0)?;
                let value = args.index(1)?;
                let kind = if args.index(2)?.truthy() {
                    Kind::UserEffect
                } else {
                    Kind::Effect
                };
                r::effect(h, kind, func, value);
                Ok(Value(0))
            }
            105 => {
                let func = args.index(0)?;
                let (owner, result) = r::with_root(h, || {
                    let handle = self.handle(self.owner())?;
                    func.call(&Value(0), &Value::array([handle])?)
                });
                if result.is_err() {
                    r::dispose_owner(h, owner);
                }
                result
            }
            106 => {
                if let Ok(id) = self.node(&args.index(0)?) {
                    self.dispose(id);
                }
                Ok(Value(0))
            }
            107 => {
                let func = args.index(0)?;
                r::batch(h, || func.call(&Value(0), &Value::array([])?))
            }
            108 => {
                let func = args.index(0)?;
                r::untracked(h, || func.call(&Value(0), &Value::array([])?))
            }
            109 => {
                let func = args.index(0)?;
                unsafe { h.graph() }
                    .on_cleanup(Cleanup::Browser(func))
                    .map_err(|_| PropError("cleanup requires an owner".into()))?;
                Ok(Value(0))
            }
            110 => {
                let owner = self.owner();
                if unsafe { h.graph() }.is_live_owner(owner) {
                    self.handle(owner)
                } else {
                    Ok(Value(1))
                }
            }
            111 => {
                let handle = args.index(0)?;
                let owner = if handle.is_nullish() {
                    r::UNOWNED
                } else {
                    self.node(&handle)?
                };
                let func = args.index(1)?;
                r::with_owner(h, owner, || func.call(&Value(0), &Value::array([])?))
            }
            112 => {
                let key = args.index(0)?;
                let mut frame = unsafe { h.graph() }.context();
                let mut found = None;
                while let Some(f) = frame {
                    if h.same(&f.data.0, &key) {
                        found = Some(f.data.1.clone());
                        break;
                    }
                    frame = f.parent.clone();
                }
                found.map_or_else(|| args.index(1), Ok)
            }
            113 => {
                let key = args.index(0)?;
                let value = args.index(1)?;
                let previous = unsafe { h.graph() }
                    .provide((key, value))
                    .map_err(|_| PropError("context requires an owner".into()))?;
                drop(previous);
                Ok(Value(0))
            }
            114 => {
                let Ok(id) = self.node(&args.index(0)?) else {
                    return Ok(Value(0));
                };
                let held = unsafe { h.graph() }.drop_handle(id);
                if let Some(held) = held {
                    held.free(h);
                }
                Ok(Value(0))
            }
            _ => Err(PropError("unknown reactive operation".into())),
        };
        let error = unsafe { h.graph() }.data.error.take();
        match error {
            Some(message) => Err(PropError(message)),
            None => result,
        }
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        // No callback runs during teardown: free_all only releases values.
        unsafe { self.host().graph() }.free_all(self.host());
    }
}
