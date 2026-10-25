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

use super::{ComponentOutput, ComponentSlot, Error, Result, surface_contract};
use maka_plugin_core::{
    composition::PresentationTarget,
    contract::{Contract, Interface},
};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    rc::Rc,
    sync::Arc,
};

/// Native render payload stays on the presenter thread and is never serialized.
/// The embedding chooses V (e.g. a GPUI view recipe or a terminal renderer).
/// V is immutable presentation data, not a native resource owner. It must not
/// retain entities, input bindings, subscriptions or pending native work. Those
/// belong to renderer resource owners and keep the mount resource lease until
/// actual destruction. Retired frames can retain this recipe during cleanup.
pub struct NativeView<V: ?Sized> {
    pub view: Rc<V>,
    schemas: Rc<BTreeMap<String, Value>>,
    slots: Rc<Vec<ComponentSlot>>,
    hidden_slots: Rc<BTreeSet<String>>,
    root_visible: bool,
    inputs: Rc<BTreeMap<String, Arc<jsonschema::Validator>>>,
    pub(crate) render_depth: u16,
    pub(crate) slot_render_depth: Rc<BTreeMap<String, u16>>,
}

fn input_validators(
    schemas: &BTreeMap<String, Value>,
    slots: &[ComponentSlot],
) -> Result<BTreeMap<String, Arc<jsonschema::Validator>>> {
    let mut keys = std::collections::BTreeSet::new();
    for slot in slots {
        slot.validate().map_err(Error::Invalid)?;
        if !keys.insert(&slot.key) {
            return Err(Error::Invalid("duplicate native slot key".into()));
        }
    }
    let mut inputs = BTreeMap::new();
    for (key, schema) in schemas {
        if key.is_empty() {
            return Err(Error::Invalid("invalid native input key".into()));
        }
        inputs.insert(
            key.clone(),
            maka_plugin_core::validator(schema)
                .map_err(|error| Error::Invalid(error.to_string()))?,
        );
    }
    Ok(inputs)
}

/// A checked, platform-specific scene declaration. Only inert data crosses a
/// thread; native recipes and native resource owners are constructed separately.
pub struct PreparedScene {
    payload: Box<dyn std::any::Any + Send>,
    schemas: BTreeMap<String, Value>,
    inputs: BTreeMap<String, Arc<jsonschema::Validator>>,
    slots: Vec<ComponentSlot>,
    hidden: BTreeSet<String>,
    visible: bool,
    depth: u16,
    slot_depth: BTreeMap<String, u16>,
}
impl PreparedScene {
    pub fn slots(&self) -> &[ComponentSlot] {
        &self.slots
    }
    pub fn new<T: Send + 'static>(
        payload: T,
        schemas: BTreeMap<String, Value>,
        slots: Vec<ComponentSlot>,
    ) -> Result<Self> {
        let inputs = input_validators(&schemas, &slots)?;
        Ok(Self {
            payload: Box::new(payload),
            schemas,
            inputs,
            slots,
            hidden: BTreeSet::new(),
            visible: true,
            depth: 0,
            slot_depth: BTreeMap::new(),
        })
    }
    pub fn with_hidden_slots(mut self, hidden: BTreeSet<String>) -> Result<Self> {
        if hidden
            .iter()
            .any(|key| !self.slots.iter().any(|slot| &slot.key == key))
        {
            return Err(Error::Invalid("hidden slot is not declared".into()));
        }
        self.hidden = hidden;
        Ok(self)
    }
    pub fn with_root_visibility(mut self, visible: bool) -> Self {
        self.visible = visible;
        self
    }
    pub fn with_render_depth(mut self, depth: u16, slots: BTreeMap<String, u16>) -> Result<Self> {
        if slots
            .iter()
            .any(|(key, cost)| *cost > depth || !self.slots.iter().any(|slot| &slot.key == key))
        {
            return Err(Error::Invalid("invalid native render depth".into()));
        }
        self.depth = depth;
        self.slot_depth = slots;
        Ok(self)
    }
    pub fn finish<T: Send + 'static, V: ?Sized>(
        self,
        wrap: impl FnOnce(T) -> Rc<V>,
    ) -> Result<NativeView<V>> {
        let payload = self
            .payload
            .downcast::<T>()
            .map_err(|_| Error::Invalid("foreign native scene preparation".into()))?;
        Ok(NativeView {
            view: wrap(*payload),
            schemas: Rc::new(self.schemas),
            inputs: Rc::new(self.inputs),
            slots: Rc::new(self.slots),
            hidden_slots: Rc::new(self.hidden),
            root_visible: self.visible,
            render_depth: self.depth,
            slot_render_depth: Rc::new(self.slot_depth),
        })
    }
}

impl<V: ?Sized> NativeView<V> {
    pub fn new(
        view: Rc<V>,
        schemas: BTreeMap<String, Value>,
        slots: Vec<ComponentSlot>,
    ) -> Result<Self> {
        let inputs = input_validators(&schemas, &slots)?;
        Ok(Self {
            view,
            schemas: Rc::new(schemas),
            slots: Rc::new(slots),
            hidden_slots: Rc::new(BTreeSet::new()),
            root_visible: true,
            inputs: Rc::new(inputs),
            render_depth: 0,
            slot_render_depth: Rc::new(BTreeMap::new()),
        })
    }
    pub(crate) fn components<'a>(&'a self, output: &mut Vec<super::frame::ComponentRef<'a>>) {
        output.extend(self.slots.iter().map(ComponentSlot::reference));
    }
    pub fn slots(&self) -> &[ComponentSlot] {
        &self.slots
    }
    /// Immutable layout projection. Hidden children remain mounted, retain their
    /// capabilities and settle observations; only mechanical presentation stops.
    pub fn with_hidden_slots(mut self, hidden: BTreeSet<String>) -> Result<Self> {
        if hidden
            .iter()
            .any(|key| !self.slots.iter().any(|slot| &slot.key == key))
        {
            return Err(Error::Invalid("hidden slot is not declared".into()));
        }
        self.hidden_slots = Rc::new(hidden);
        Ok(self)
    }
    /// Renderer-derived nesting cost, independent of business state. `depth`
    /// is the maximum local cost; each slot records its enclosing local cost.
    /// The application checks complete visible paths before committing a batch.
    pub fn with_render_depth(mut self, depth: u16, slots: BTreeMap<String, u16>) -> Result<Self> {
        if slots
            .iter()
            .any(|(key, cost)| *cost > depth || !self.slots.iter().any(|slot| &slot.key == key))
        {
            return Err(Error::Invalid("invalid native render depth".into()));
        }
        self.render_depth = depth;
        self.slot_render_depth = Rc::new(slots);
        Ok(self)
    }
    /// Mechanical projection of the recipe's declared root visibility, distinct
    /// from physical clipping/minimization. It retains all original mounted slots.
    pub fn with_root_visibility(mut self, visible: bool) -> Self {
        self.root_visible = visible;
        self
    }
    pub fn root_visible(&self) -> bool {
        self.root_visible
    }
    pub fn visible_slots(&self) -> impl Iterator<Item = &ComponentSlot> {
        self.slots
            .iter()
            .filter(|slot| self.root_visible && !self.hidden_slots.contains(&slot.key))
    }
    /// Compare immutable presentation declarations, independently of native
    /// render behavior, resource ownership and business input admission.
    pub fn same_presentation_metadata(&self, previous: &Self) -> bool {
        self.schemas == previous.schemas
            && self.slots == previous.slots
            && self.hidden_slots == previous.hidden_slots
            && self.root_visible == previous.root_visible
            && self.render_depth == previous.render_depth
            && self.slot_render_depth == previous.slot_render_depth
    }
    /// Whether an input target still belongs to this published recipe.
    pub fn declares_input(&self, key: &str) -> bool {
        self.inputs.contains_key(key)
    }
    pub(crate) fn validate_input(&self, key: &str, input: &Value) -> Result<()> {
        self.inputs
            .get(key)
            .ok_or_else(|| Error::Invalid(format!("undeclared native input: {key}")))?
            .validate(input)
            .map_err(|error| Error::Invalid(error.to_string()))
    }
}

impl<V: ?Sized> Clone for NativeView<V> {
    fn clone(&self) -> Self {
        Self {
            view: self.view.clone(),
            schemas: self.schemas.clone(),
            slots: self.slots.clone(),
            hidden_slots: self.hidden_slots.clone(),
            root_visible: self.root_visible,
            inputs: self.inputs.clone(),
            render_depth: self.render_depth,
            slot_render_depth: self.slot_render_depth.clone(),
        }
    }
}
/// Native callbacks prepare an immutable scene. They do not receive a GPUI
/// context/editor handle: observable native effects execute after scene commit.
pub enum ComponentCall<'a> {
    Mount {
        props: &'a Value,
    },
    Update {
        state: &'a Value,
        props: &'a Value,
    },
    Event {
        state: &'a Value,
        props: &'a Value,
        key: &'a str,
        input: &'a Value,
        origin: EventOrigin<'a>,
    },
}
/// The adapter constructs this origin; an arbitrary raw input payload cannot
/// impersonate a child component notification.
pub enum EventOrigin<'a> {
    Raw,
    Action,
    Component { child: &'a str, name: &'a str },
}
pub trait NativeComponent<V: ?Sized>: 'static {
    /// Pure expensive preparation may return a pending job. The job retains
    /// the original invocation and yields only inert candidate recipe data;
    /// native resources and external operations remain with their existing owners.
    /// `previous` is the immutable view matching this invocation's state, from
    /// the current transaction when already staged, or the committed frame.
    fn start(
        &self,
        call: ComponentCall<'_>,
        _previous: Option<&NativeView<V>>,
        values: &super::abi::ValueBindings,
        _: &tokio::runtime::Handle,
    ) -> super::backend::Job<ComponentOutput<NativeView<V>>>
    where
        V: 'static,
    {
        super::backend::Job::ready(self.call(call, values))
    }
    fn capture(&self, _: super::actions::CaptureCall<'_>) -> Result<super::actions::CapturePlan> {
        Err(Error::Invalid("native capture method unavailable".into()))
    }
    fn call(
        &self,
        call: ComponentCall<'_>,
        _values: &super::abi::ValueBindings,
    ) -> Result<ComponentOutput<NativeView<V>>>;
}
pub enum NativeCapability<V: ?Sized> {
    Component(Rc<dyn NativeComponent<V>>),
    Surface(PresentationTarget),
    Service(std::sync::Arc<dyn super::actions::NativeService>),
    Value(Value),
}
pub struct NativeExport<V: ?Sized> {
    pub contract: Contract,
    pub value: NativeCapability<V>,
}
type Factory<V> =
    dyn Fn(&Value, &super::abi::ValueBindings) -> Result<BTreeMap<String, NativeExport<V>>>;

/// Presenter-owned, pure translation. No runtime or native owner is available
/// at this precommit boundary. Implementations validate finite declarations;
/// painting never executes a compiler.
pub type PrepareScene = dyn Fn(&Value) -> Result<PreparedScene> + Send + Sync;
type FinishScene<V> = dyn Fn(PreparedScene) -> Result<NativeView<V>>;
pub(crate) struct SceneCompiler<V: ?Sized> {
    pub language: maka_plugin_core::package::SceneLanguage,
    pub prepare: std::sync::Arc<PrepareScene>,
    pub finish: Box<FinishScene<V>>,
}

/// Build-time implementation availability. The composition selects instances;
/// this map does not register capabilities or automatically activate products.
pub struct NativeRegistry<V: ?Sized> {
    factories: BTreeMap<String, Box<Factory<V>>>,
    pub(crate) render_depth_limit: Option<u16>,
    pub(crate) scene_compiler: Option<Rc<SceneCompiler<V>>>,
}
impl<V: ?Sized + 'static> Default for NativeRegistry<V> {
    fn default() -> Self {
        Self {
            factories: BTreeMap::new(),
            render_depth_limit: None,
            scene_compiler: None,
        }
    }
}
impl<V: ?Sized + 'static> NativeRegistry<V> {
    /// Select this embedding's scene ABI. Native factories still use their own
    /// typed recipes. JavaScript components require an explicit compiler; there
    /// is no kernel vocabulary or implicit fallback.
    pub fn with_scene_compiler(
        mut self,
        language: maka_plugin_core::package::SceneLanguage,
        prepare: impl Fn(&Value) -> Result<PreparedScene> + Send + Sync + 'static,
        finish: impl Fn(PreparedScene) -> Result<NativeView<V>> + 'static,
    ) -> Result<Self> {
        language.validate()?;
        self.scene_compiler = Some(Rc::new(SceneCompiler {
            language,
            prepare: std::sync::Arc::new(prepare),
            finish: Box::new(finish),
        }));
        Ok(self)
    }
    /// Embedding policy for nesting native render work. Scene compilers and
    /// compiled components report local costs; composition can only consume it.
    pub fn with_render_depth_limit(mut self, limit: u16) -> Self {
        self.render_depth_limit = Some(limit);
        self
    }
    pub fn register(
        &mut self,
        implementation: &str,
        factory: impl Fn(
            &Value,
            &super::abi::ValueBindings,
        ) -> Result<BTreeMap<String, NativeExport<V>>>
        + 'static,
    ) -> Result<()> {
        if implementation.is_empty() || self.factories.contains_key(implementation) {
            return Err(Error::Invalid(
                "invalid or duplicate native implementation".into(),
            ));
        }
        self.factories
            .insert(implementation.into(), Box::new(factory));
        Ok(())
    }
    pub fn with_surface(target: PresentationTarget) -> Self {
        let mut registry = Self::default();
        registry
            .register(surface_implementation(target), move |_, _values| {
                Ok(BTreeMap::from([(
                    "Surface".into(),
                    NativeExport {
                        contract: surface_contract(target),
                        value: NativeCapability::Surface(target),
                    },
                )]))
            })
            .expect("unique built-in surface");
        registry
            .register(crate::locale::IMPLEMENTATION, |_, _values| {
                Ok(BTreeMap::from([(
                    "Locale".into(),
                    NativeExport {
                        contract: super::locale::contract(),
                        value: NativeCapability::Value(Value::String(super::locale::system())),
                    },
                )]))
            })
            .expect("unique native locale");
        registry
            .register(crate::text::IMPLEMENTATION, |_, _values| {
                Ok(BTreeMap::from([(
                    "Reader".into(),
                    NativeExport {
                        contract: super::text::reader_contract(),
                        value: NativeCapability::Service(std::sync::Arc::new(super::text::Reader)),
                    },
                )]))
            })
            .expect("unique native text reader");
        registry
    }
    pub(crate) fn validate_implementation(&self, implementation: &str) -> Result<()> {
        if !self.factories.contains_key(implementation) {
            return Err(Error::Invalid(format!(
                "native implementation not provided: {implementation}"
            )));
        }
        Ok(())
    }
    pub(crate) fn activate(
        &self,
        implementation: &str,
        configuration: &Value,
        values: &super::abi::ValueBindings,
    ) -> Result<BTreeMap<String, NativeExport<V>>> {
        let actual = self.factories.get(implementation).ok_or_else(|| {
            Error::Invalid(format!(
                "native implementation not provided: {implementation}"
            ))
        })?(configuration, values)?;
        for export in actual.values() {
            export.contract.validate()?;
            match (&export.contract.interface, &export.value) {
                (Interface::Component { .. }, NativeCapability::Component(_)) => {}
                (Interface::Service { .. }, NativeCapability::Service(_)) => {}
                (Interface::Value { .. }, NativeCapability::Value(_)) => {}
                (_, NativeCapability::Surface(target))
                    if export.contract == surface_contract(*target) => {}
                _ => {
                    return Err(Error::Invalid(
                        "native export shape does not match its actual value".into(),
                    ));
                }
            }
        }
        Ok(actual)
    }
}

#[derive(Clone, PartialEq, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LabelProps {
    pub text: String,
    pub appearance: crate::appearance::TextAppearance,
    #[serde(default, rename = "terminalForeground")]
    pub terminal_foreground: Option<crate::scene::terminal::Color>,
    #[serde(default)]
    pub elapsed: Option<crate::elapsed::Elapsed>,
}
impl LabelProps {
    pub fn validate(&self) -> crate::Result<()> {
        if let Some(elapsed) = &self.elapsed {
            elapsed.validate()?;
        }
        Ok(())
    }
    pub fn rendered(&self) -> std::borrow::Cow<'_, str> {
        match &self.elapsed {
            Some(elapsed) => elapsed
                .text(crate::elapsed::now())
                .map(|text| format!("{}{text}", self.text).into())
                .unwrap_or_default(),
            None => self.text.as_str().into(),
        }
    }
}
pub fn label_contract() -> Contract {
    Contract {
        name: "maka.ui.Label".into(),
        version: 1,
        transport: maka_plugin_core::contract::Transport::Local,
        interface: Interface::Component {
            props: serde_json::to_value(schemars::schema_for!(LabelProps))
                .expect("label schema")
                .into(),
            events: BTreeMap::new(),
            captures: BTreeMap::new(),
        },
    }
}

pub const IMPLEMENTATION: &str = "maka.ui.label";

pub fn native() -> maka_plugin_core::package::NativeDefinition {
    maka_plugin_core::package::NativeDefinition::new(
        IMPLEMENTATION,
        serde_json::json!({"type":"object","properties":{},"required":[],"additionalProperties":false}),
        [("Label", label_contract())],
    )
}

fn surface_implementation(target: PresentationTarget) -> &'static str {
    match target {
        PresentationTarget::Tui => "maka.ui.surface.tui",
    }
}

pub fn surface_native(target: PresentationTarget) -> maka_plugin_core::package::NativeDefinition {
    maka_plugin_core::package::NativeDefinition::new(
        surface_implementation(target),
        serde_json::json!({"type":"object","properties":{},"required":[],"additionalProperties":false}),
        [("Surface", surface_contract(target))],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scene_inputs_validate_changed_contracts_and_reject_unknown_inputs() {
        use serde_json::json;
        let view = |schema| {
            NativeView::new(
                Rc::new(()),
                BTreeMap::from([("choose".into(), schema)]),
                vec![],
            )
            .unwrap()
        };
        let same = view(json!({"type":"integer", "minimum":1}));
        let changed = view(json!({"type":"integer", "minimum":2}));
        assert!(same.validate_input("choose", &json!(1)).is_ok());
        assert!(changed.validate_input("choose", &json!(1)).is_err());
        assert!(changed.validate_input("choose", &json!(2)).is_ok());
        assert!(same.validate_input("choose", &json!("1")).is_err());
        assert!(same.validate_input("missing", &json!(1)).is_err());
        assert!(
            NativeView::new(
                Rc::new(()),
                BTreeMap::from([("choose".into(), json!({"type":"invalid"}))]),
                vec![]
            )
            .is_err()
        );
    }

    #[test]
    fn hidden_slot_projection_retains_exact_declarations_and_rejects_unbound_keys() {
        let slots = ["one", "two"].map(|key| ComponentSlot {
            key: key.into(),
            binding: "component".into(),
            member: 0,
            props: serde_json::json!({}),
            on: BTreeMap::new(),
        });
        let view = NativeView::new(Rc::new(()), BTreeMap::new(), slots.to_vec())
            .unwrap()
            .with_hidden_slots(BTreeSet::from(["one".into()]))
            .unwrap();
        assert_eq!(view.slots().len(), 2);
        assert_eq!(
            view.visible_slots()
                .map(|slot| slot.key.as_str())
                .collect::<Vec<_>>(),
            ["two"]
        );
        assert!(
            view.clone()
                .with_hidden_slots(BTreeSet::from(["unbound".into()]))
                .is_err()
        );
        assert_eq!(view.clone().visible_slots().count(), 1);
    }
}
