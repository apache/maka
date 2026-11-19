//! Native components registered by the app's Rust crate
//! (`#[native_components(android)]`, `components!`).

use std::{
    cell::RefCell,
    collections::VecDeque,
    panic::{AssertUnwindSafe, catch_unwind},
    rc::Rc,
    sync::Arc,
    thread::ThreadId,
};

use jni::{
    JNIEnv,
    objects::{GlobalRef, JClass, JObject, JObjectArray, JString},
    sys::{jint, jlong},
};
use nsh_core::{
    Command, EventKind, EventPayload, JsonValue, MountBatch, MountItem, NodeId, Points, Size,
    animation::AnimationValue, platform::is_reserved_component,
};
use nsh_engine::EngineControl;
use rustc_hash::{FxHashMap, FxHashSet};

use crate::{host::Host, java::java};

/// A native component made by a registered factory on Android.
pub trait NativeComponent {
    /// Returns a global reference to the `android.view.View` that fills the
    /// container NSH lays out.
    fn view(&self) -> &GlobalRef;

    /// Prop `name` changed (`None`: removed). Every prop the app set comes
    /// right after the component is made.
    fn set_prop(&mut self, env: &mut JNIEnv<'_>, name: &str, value: Option<&JsonValue>);

    /// JS or Rust called `command(name, args)` through the element's `ref`.
    fn command(&mut self, env: &mut JNIEnv<'_>, name: &str, args: &JsonValue) {
        let _ = (env, name, args);
    }

    /// Prop `name`, bound to an animated value, moved to `value` (on the
    /// frames it changes, without JS). By default, [`Self::set_prop`] with
    /// a JSON number.
    fn set_animated_number(&mut self, env: &mut JNIEnv<'_>, name: &str, value: f64) {
        let json = serde_json::Number::from_f64(value).map_or(JsonValue::Null, JsonValue::Number);
        self.set_prop(env, name, Some(&json));
    }

    /// Prop `name`, bound to an animated color, moved to `argb`
    /// (`0xAARRGGBB`). By default, [`Self::set_prop`] with a JSON number.
    fn set_animated_color(&mut self, env: &mut JNIEnv<'_>, name: &str, argb: u32) {
        self.set_prop(env, name, Some(&JsonValue::from(argb)));
    }

    /// Releases resources held by the component when its element is removed
    /// or its view stops.
    fn destroy(&mut self, env: &mut JNIEnv<'_>) {
        let _ = env;
    }
}

/// What a component receives when created and can use to talk back to its app.
/// Cheap to clone; usable from any thread.
#[derive(Clone)]
pub struct ComponentContext {
    id: NodeId,
    control: EngineControl,
    context: GlobalRef,
}

impl std::fmt::Debug for ComponentContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ComponentContext")
            .field("id", &self.id)
            .finish()
    }
}

impl ComponentContext {
    /// Returns the Android `android.content.Context` of the `NshView` hosting
    /// this component.
    pub fn android_context(&self) -> &GlobalRef {
        &self.context
    }

    /// Runs `f` with a [`JNIEnv`] attached to the current thread inside a
    /// local reference frame.
    pub fn with_env<R>(
        &self,
        f: impl FnOnce(&mut JNIEnv<'_>) -> jni::errors::Result<R>,
    ) -> jni::errors::Result<R> {
        let mut env = java().vm.attach_current_thread()?;
        let res = env.with_local_frame(32, f);
        if res.is_err() {
            clear_exception(&mut env);
        }
        res
    }

    /// Emits event `name` with `data`: the handler `on<Name>` gets it.
    pub fn emit(&self, name: &str, data: JsonValue) {
        self.control.dispatch_event(
            self.id,
            EventKind::NativeEvent,
            EventPayload::Native {
                name: name.into(),
                data,
            },
        );
    }

    /// Reports the component's intrinsic size (dp), used where its style
    /// leaves a dimension open.
    pub fn set_size(&self, width: f32, height: f32) {
        self.control
            .set_component_size(self.id, Size::new(Points(width), Points(height)));
    }
}

// Components may emit events or update intrinsic size from worker threads.
const _: () = {
    const fn send_sync<T: Send + Sync>() {}
    send_sync::<ComponentContext>();
};

/// Makes a component for an element, given its context.
pub type ComponentFactory = Rc<dyn Fn(ComponentContext) -> Box<dyn NativeComponent>>;

/// The components registered for a surface (`NshView`).
#[derive(Default)]
pub struct Components {
    factories: RefCell<FxHashMap<Arc<str>, ComponentFactory>>,
    missing: RefCell<FxHashSet<Arc<str>>>,
}

impl std::fmt::Debug for Components {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_set()
            .entries(self.factories.borrow().keys())
            .finish()
    }
}

impl Components {
    /// Creates an empty component registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers `factory` under `name` (replacing an earlier one). Names
    /// under `nsh/` are NSH's own: registering one logs a warning and
    /// changes nothing.
    pub fn register(&self, name: &str, factory: ComponentFactory) {
        if is_reserved_component(name) {
            log::warn!("native component `{name}` is not registered: names under `nsh/` are NSH's");
            return;
        }
        self.factories.borrow_mut().insert(name.into(), factory);
        self.missing.borrow_mut().remove(name);
    }

    fn names(&self) -> Vec<String> {
        self.factories
            .borrow()
            .keys()
            .map(|name| name.to_string())
            .collect()
    }

    fn factory(&self, name: &str) -> Option<ComponentFactory> {
        let factory = self.factories.borrow().get(name).cloned();
        if factory.is_none() && self.missing.borrow_mut().insert(name.into()) {
            log::warn!(
                target: "js",
                "no native component is registered as `{name}`: it renders an empty view"
            );
        }
        factory
    }
}

enum ComponentStep {
    Slots(Vec<Arc<str>>),
    Props(Vec<(Arc<str>, Option<JsonValue>)>),
    Command(Arc<str>, JsonValue),
    ForgetAnimated,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum HandedValue {
    Number(u32),
    Color(u32),
}

struct InstanceEntry {
    component: Box<dyn NativeComponent>,
    slots: Vec<Arc<str>>,
    handed: FxHashMap<u16, HandedValue>,
}

struct UiBound {
    thread: ThreadId,
    registry: Components,
    instances: FxHashMap<NodeId, InstanceEntry>,
}

// SAFETY: `registry` and `instances` are created and used on `thread` (the
// Android UI thread); only `destroy_surface` drains them if `NshView.destroy`
// runs on teardown, freeing every global reference cleanly.
unsafe impl Send for UiBound {}

/// Per-`Host` component registrations, pending typed steps, and UI instances.
#[derive(Default)]
pub(crate) struct HostComponents {
    control: Option<EngineControl>,
    rust_names: FxHashSet<Arc<str>>,
    rust_nodes: FxHashSet<NodeId>,
    steps: FxHashMap<(u64, NodeId), VecDeque<ComponentStep>>,
    ui: Option<UiBound>,
}

impl HostComponents {
    pub(crate) fn new() -> Self {
        let mut rust_names = FxHashSet::default();
        if let Some(register) = crate::app_components_fn() {
            let registry = Components::new();
            let _ = call_user("register", || register(&registry));
            for name in registry.names() {
                rust_names.insert(name.into());
            }
        }
        Self {
            control: None,
            rust_names,
            rust_nodes: FxHashSet::default(),
            steps: FxHashMap::default(),
            ui: None,
        }
    }

    pub(crate) fn set_control(&mut self, control: EngineControl) {
        self.control = Some(control);
    }

    pub(crate) fn clear_app_state(&mut self) {
        self.control = None;
        self.rust_nodes.clear();
        self.steps.clear();
    }

    pub(crate) fn has_instance(&self, id: NodeId) -> bool {
        self.ui
            .as_ref()
            .is_some_and(|ui| ui.instances.contains_key(&id))
    }
}

fn clear_exception(env: &mut JNIEnv<'_>) {
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }
}

fn call_user<R>(what: &str, f: impl FnOnce() -> R) -> Option<R> {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(value) => Some(value),
        Err(_) => {
            log::error!("native component panicked in `{what}`");
            None
        }
    }
}

fn build_ui_registry() -> Components {
    let registry = Components::new();
    if let Some(register) = crate::app_components_fn() {
        let _ = call_user("register", || register(&registry));
    }
    registry
}

fn destroy_entry(env: &mut JNIEnv<'_>, mut entry: InstanceEntry) {
    let _ = call_user("destroy", || entry.component.destroy(env));
    clear_exception(env);
}

/// Extracts typed props, slots, commands, and dynamic resets for Rust
/// components directly out of `batch` before `encode::encode`, avoiding JSON
/// round-trips across JNI.
pub(crate) fn extract_batch_steps(host: &Host, seq: u64, batch: &mut MountBatch) {
    let mut comps = host.components.lock().unwrap_or_else(|e| e.into_inner());
    if comps.rust_names.is_empty() && comps.rust_nodes.is_empty() {
        return;
    }
    let components_ptr = &mut *comps;
    let mut push = |id: NodeId, step: ComponentStep| {
        components_ptr
            .steps
            .entry((seq, id))
            .or_default()
            .push_back(step);
    };
    for item in &mut batch.items {
        match item {
            MountItem::Component { id, name } => {
                if components_ptr.rust_names.contains(name.as_ref()) {
                    components_ptr.rust_nodes.insert(*id);
                } else {
                    components_ptr.rust_nodes.remove(id);
                }
            }
            MountItem::ComponentPropSlots { id, names }
                if components_ptr.rust_nodes.contains(id) =>
            {
                let taken = std::mem::take(names);
                push(*id, ComponentStep::Slots(taken));
            }
            MountItem::ComponentProps { id, props } if components_ptr.rust_nodes.contains(id) => {
                let taken = std::mem::take(props);
                push(*id, ComponentStep::Props(taken));
            }
            MountItem::Command {
                id,
                command: Command::Native { name, args },
            } if components_ptr.rust_nodes.contains(id) => {
                let name = std::mem::take(name);
                let args = std::mem::replace(args, JsonValue::Null);
                push(*id, ComponentStep::Command(name, args));
            }
            MountItem::AnimationBindings { id, .. } if components_ptr.rust_nodes.contains(id) => {
                push(*id, ComponentStep::ForgetAnimated);
            }
            MountItem::Delete { id } => {
                components_ptr.rust_nodes.remove(id);
            }
            _ => {}
        }
    }
}

/// Applies animated prop slots directly to live Rust components on the UI thread.
pub(crate) fn apply_animated_slots(
    env: &mut JNIEnv<'_>,
    host: &Host,
    updates: &[(NodeId, u16, AnimationValue)],
) {
    if updates.is_empty() {
        return;
    }
    let here = std::thread::current().id();
    for &(id, slot, value) in updates {
        let taken = {
            let mut comps = host.components.lock().unwrap_or_else(|e| e.into_inner());
            let Some(ui) = comps.ui.as_mut() else {
                continue;
            };
            if ui.thread != here {
                continue;
            }
            let Some(mut entry) = ui.instances.remove(&id) else {
                continue;
            };
            let Some(name) = entry.slots.get(slot as usize).cloned() else {
                ui.instances.insert(id, entry);
                continue;
            };
            let next_val = match value {
                AnimationValue::Color(c) => HandedValue::Color(c.rotate_right(8)),
                other => HandedValue::Number(other.number().to_bits()),
            };
            if entry.handed.get(&slot).copied() == Some(next_val) {
                ui.instances.insert(id, entry);
                continue;
            }
            entry.handed.insert(slot, next_val);
            (entry, name, next_val)
        };
        let (mut entry, name, next_val) = taken;
        match next_val {
            HandedValue::Color(argb) => {
                let _ = call_user("set_animated_color", || {
                    entry.component.set_animated_color(env, &name, argb);
                });
            }
            HandedValue::Number(bits) => {
                let num = f64::from(f32::from_bits(bits));
                let _ = call_user("set_animated_number", || {
                    entry.component.set_animated_number(env, &name, num);
                });
            }
        }
        clear_exception(env);
        reinsert_entry(env, host, id, entry);
    }
}

/// Discards any unconsumed component steps from batches up to `seq`.
pub(crate) fn clear_through(host: &Host, seq: u64) {
    let mut comps = host.components.lock().unwrap_or_else(|e| e.into_inner());
    comps.steps.retain(|&(s, _), _| s > seq);
}

fn reinsert_entry(env: &mut JNIEnv<'_>, host: &Host, id: NodeId, entry: InstanceEntry) {
    let here = std::thread::current().id();
    let displaced = {
        let mut comps = host.components.lock().unwrap_or_else(|e| e.into_inner());
        match comps.ui.as_mut() {
            Some(ui) if ui.thread == here && !ui.instances.contains_key(&id) => {
                ui.instances.insert(id, entry);
                None
            }
            _ => Some(entry),
        }
    };
    if let Some(dropped) = displaced {
        destroy_entry(env, dropped);
    }
}

/// Destroys all live native component instances and drops the registry when its
/// native [`Host`] is torn down.
pub(crate) fn destroy_surface(env: &mut JNIEnv<'_>, host: &Host) {
    let ui = {
        let mut comps = host.components.lock().unwrap_or_else(|e| e.into_inner());
        comps.clear_app_state();
        comps.ui.take()
    };
    if let Some(ui) = ui {
        for (_, entry) in ui.instances {
            destroy_entry(env, entry);
        }
    }
}

#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_componentNames<'local>(
    mut env: JNIEnv<'local>,
    _: JClass<'local>,
    handle: jlong,
) -> JObjectArray<'local> {
    if handle == 0 {
        return JObjectArray::from(JObject::null());
    }
    // SAFETY: Java passes its live handle from `NshView` constructor.
    let host = unsafe { crate::host::host(handle) };
    let names: Vec<String> = {
        let comps = host.components.lock().unwrap_or_else(|e| e.into_inner());
        comps.rust_names.iter().map(|n| n.to_string()).collect()
    };
    if names.is_empty() {
        return JObjectArray::from(JObject::null());
    }
    let Ok(array) = env.new_object_array(names.len() as i32, "java/lang/String", JObject::null())
    else {
        return JObjectArray::from(JObject::null());
    };
    for (i, name) in names.iter().enumerate() {
        let Ok(s) = env.new_string(name) else {
            return JObjectArray::from(JObject::null());
        };
        if env.set_object_array_element(&array, i as i32, &s).is_err() {
            return JObjectArray::from(JObject::null());
        }
    }
    array
}

#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_componentJavaRegistered(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    name: JString<'_>,
) {
    if handle == 0 || name.is_null() {
        return;
    }
    let Ok(name) = env.get_string(&name).map(String::from) else {
        return;
    };
    // SAFETY: Java passes its live handle from `NshView.registerComponent`.
    let host = unsafe { crate::host::host(handle) };
    host.components
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .rust_names
        .remove(name.as_str());
}

#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_componentCreate<'local>(
    mut env: JNIEnv<'local>,
    _: JClass<'local>,
    handle: jlong,
    id: jint,
    context: JObject<'local>,
    name: JString<'local>,
) -> JObject<'local> {
    if handle == 0 || context.is_null() || name.is_null() {
        return JObject::null();
    }
    let Ok(name) = env.get_string(&name).map(String::from) else {
        return JObject::null();
    };
    let Ok(context) = env.new_global_ref(context) else {
        return JObject::null();
    };
    // SAFETY: Java passes its live handle from NshView on the UI thread.
    let host = unsafe { crate::host::host(handle) };
    let here = std::thread::current().id();
    let (factory, control) = {
        let mut comps = host.components.lock().unwrap_or_else(|e| e.into_inner());
        let control = comps.control.clone().or_else(|| host.control());
        let ui = comps.ui.get_or_insert_with(|| UiBound {
            thread: here,
            registry: build_ui_registry(),
            instances: FxHashMap::default(),
        });
        if ui.thread != here {
            return JObject::null();
        }
        (ui.registry.factory(&name), control)
    };
    let (Some(factory), Some(control)) = (factory, control) else {
        return JObject::null();
    };
    let Some(mut component) = call_user("factory", || {
        factory(ComponentContext {
            id: id as NodeId,
            control,
            context,
        })
    }) else {
        clear_exception(&mut env);
        return JObject::null();
    };
    clear_exception(&mut env);
    let Ok(view) = env.new_local_ref(component.view().as_obj()) else {
        let _ = call_user("destroy", || component.destroy(&mut env));
        clear_exception(&mut env);
        return JObject::null();
    };
    let entry = InstanceEntry {
        component,
        slots: Vec::new(),
        handed: FxHashMap::default(),
    };
    let old = {
        let mut comps = host.components.lock().unwrap_or_else(|e| e.into_inner());
        match comps.ui.as_mut() {
            Some(ui) if ui.thread == here => ui.instances.insert(id as NodeId, entry),
            _ => Some(entry),
        }
    };
    if let Some(old) = old {
        destroy_entry(&mut env, old);
    }
    view
}

#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_componentStep(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    seq: jlong,
    id: jint,
) {
    if handle == 0 {
        return;
    }
    // SAFETY: Java passes its live handle from `NshView` on the UI thread.
    let host = unsafe { crate::host::host(handle) };
    let node = id as NodeId;
    let here = std::thread::current().id();
    let key = (seq as u64, node);
    let (step, entry) = {
        let mut comps = host.components.lock().unwrap_or_else(|e| e.into_inner());
        let step = match comps.steps.get_mut(&key) {
            Some(queue) => {
                let s = queue.pop_front();
                if queue.is_empty() {
                    comps.steps.remove(&key);
                }
                s
            }
            None => None,
        };
        let Some(step) = step else {
            return;
        };
        let entry = comps
            .ui
            .as_mut()
            .filter(|ui| ui.thread == here)
            .and_then(|ui| ui.instances.remove(&node));
        (step, entry)
    };
    let Some(mut entry) = entry else {
        return;
    };
    match step {
        ComponentStep::Slots(names) => {
            entry.slots = names;
            entry.handed.clear();
        }
        ComponentStep::Props(props) => {
            for (name, value) in props {
                let _ = call_user("set_prop", || {
                    entry.component.set_prop(&mut env, &name, value.as_ref());
                });
                clear_exception(&mut env);
            }
        }
        ComponentStep::Command(name, args) => {
            let _ = call_user("command", || {
                entry.component.command(&mut env, &name, &args);
            });
            clear_exception(&mut env);
        }
        ComponentStep::ForgetAnimated => {
            entry.handed.clear();
        }
    }
    reinsert_entry(&mut env, host, node, entry);
}

#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_componentDestroy(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    id: jint,
) {
    if handle == 0 {
        return;
    }
    // SAFETY: Java passes its live handle from `NshView`.
    let host = unsafe { crate::host::host(handle) };
    let entry = {
        let mut comps = host.components.lock().unwrap_or_else(|e| e.into_inner());
        comps
            .ui
            .as_mut()
            .and_then(|ui| ui.instances.remove(&(id as NodeId)))
    };
    if let Some(entry) = entry {
        destroy_entry(&mut env, entry);
    }
}
