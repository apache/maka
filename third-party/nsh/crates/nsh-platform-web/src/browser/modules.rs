//! Registry-driven browser exports. Calls retain the same Rust argument
//! conversion and op ordering as the native host.
use std::{cell::RefCell, rc::Rc};

use nsh_core::{
    Op,
    element::{
        ConstantValue, ErrorClass, FunctionCall, FunctionSpec, JsHost, MemberCall, MemberKind,
        PropError, Registry, RustCall, RustOp, Thrown,
    },
};

use super::{
    bindings::Bindings,
    values::{Value, invoke},
};

pub(super) struct Modules {
    bindings: Rc<Bindings>,
    functions: RefCell<Vec<FunctionSpec>>,
    components: RefCell<Vec<std::sync::Arc<nsh_core::element::ComponentSpec>>>,
}
impl Modules {
    pub(super) fn new(bindings: Rc<Bindings>) -> Self {
        Self {
            bindings,
            functions: RefCell::default(),
            components: RefCell::default(),
        }
    }
    pub(super) fn describe(&self, registries: &[Registry]) -> Result<Value, PropError> {
        let mut sets = Vec::new();
        for registry in registries.iter().flat_map(Registry::sets) {
            let Some(specifier) = registry.specifier() else {
                continue;
            };
            let set = Value::object()?;
            set.set("specifier", &Value::string(specifier)?)?;
            let mut modules = Vec::new();
            for spec in registry.module_specs() {
                let module = Value::object()?;
                module.set("name", &Value::string(spec.name)?)?;
                module.set("flat", &Value(if spec.flat { 3 } else { 2 }))?;
                module.set("default", &Value(if spec.default { 3 } else { 2 }))?;
                let mut functions = Vec::new();
                for f in &spec.functions {
                    let id = {
                        let mut all = self.functions.borrow_mut();
                        let id = all.len();
                        all.push(f.clone());
                        id
                    };
                    let function = Value::object()?;
                    function.set("id", &Value::number(id as f64))?;
                    function.set("name", &Value::string(f.name)?)?;
                    function.set("getter", &Value(if f.getter { 3 } else { 2 }))?;
                    function.set("promise", &Value(if f.promises() { 3 } else { 2 }))?;
                    functions.push(function);
                }
                module.set("functions", &Value::array(functions)?)?;
                let constants = Value::object()?;
                for constant in &spec.constants {
                    let value = match constant.value {
                        ConstantValue::Undefined => Value(0),
                        ConstantValue::Bool(v) => Value(if v { 3 } else { 2 }),
                        ConstantValue::Number(v) => Value::number(v),
                        ConstantValue::String(v) => Value::string(v)?,
                    };
                    constants.set(constant.name, &value)?;
                }
                module.set("constants", &constants)?;
                modules.push(module);
            }
            set.set("modules", &Value::array(modules)?)?;
            let mut components = Vec::new();
            for spec in registry.specs() {
                let id = {
                    let mut all = self.components.borrow_mut();
                    let id = all.len();
                    all.push(spec.clone());
                    id
                };
                let component = Value::object()?;
                component.set("id", &Value::number(id as f64))?;
                component.set("name", &Value::string(spec.name)?)?;
                component.set("export", &Value::string(&spec.export)?)?;
                component.set("lazy", &Value(if spec.lazy_children { 3 } else { 2 }))?;
                let mut props = Vec::new();
                for prop in &spec.props {
                    let value = Value::object()?;
                    value.set("name", &Value::string(prop.name)?)?;
                    value.set(
                        "kind",
                        &Value::string(match prop.kind {
                            nsh_core::element::PropKind::Value => "value",
                            nsh_core::element::PropKind::Renderer => "renderer",
                            nsh_core::element::PropKind::Slot => "slot",
                            nsh_core::element::PropKind::Children => "children",
                            nsh_core::element::PropKind::Items => "items",
                        })?,
                    )?;
                    props.push(value);
                }
                component.set("props", &Value::array(props)?)?;
                component.set(
                    "events",
                    &Value::array(
                        spec.events
                            .iter()
                            .map(|event| Value::string(event.name))
                            .collect::<Result<Vec<_>, _>>()?,
                    )?,
                )?;
                let mut methods = Vec::new();
                for (index, method) in spec.methods.iter().enumerate() {
                    let value = Value::object()?;
                    value.set("id", &Value::number(index as f64))?;
                    value.set("name", &Value::string(method.name)?)?;
                    value.set("promise", &Value(if method.promises() { 3 } else { 2 }))?;
                    methods.push(value);
                }
                component.set("methods", &Value::array(methods)?)?;
                components.push(component);
            }
            set.set("components", &Value::array(components)?)?;
            let mut classes = Vec::new();
            for spec in registry.class_specs() {
                let class = Value::object()?;
                class.set(
                    "id",
                    &Value::number(self.bindings.class_id(spec.def) as f64),
                )?;
                class.set("name", &Value::string(spec.name)?)?;
                class.set("interface", &Value(if spec.def.interface { 3 } else { 2 }))?;
                let mut members = Vec::new();
                for (index, member) in spec.def.members.iter().enumerate() {
                    let item = Value::object()?;
                    item.set("id", &Value::number(index as f64))?;
                    item.set("name", &Value::string(member.name)?)?;
                    item.set(
                        "kind",
                        &Value::string(match member.kind {
                            MemberKind::Constructor => "constructor",
                            MemberKind::Method => "method",
                            MemberKind::Getter => "get",
                            MemberKind::Setter => "set",
                            MemberKind::Static => "static",
                        })?,
                    )?;
                    item.set(
                        "promise",
                        &Value(if member.call.is_async() { 3 } else { 2 }),
                    )?;
                    members.push(item);
                }
                class.set("members", &Value::array(members)?)?;
                classes.push(class);
            }
            set.set("classes", &Value::array(classes)?)?;
            sets.push(set);
        }
        Value::array(sets)
    }
    pub(super) fn function(
        &self,
        index: usize,
        this: Value,
        args: Value,
        call: u32,
    ) -> Result<Value, Thrown> {
        let spec = self
            .functions
            .borrow()
            .get(index)
            .cloned()
            .ok_or_else(|| Thrown::Type("unknown browser module function".into()))?;
        self.bindings.with_call(this, args, |host| match spec.call {
            FunctionCall::Sync(f) => f(host).map(|raw| Value(raw.0[0] as u32)),
            FunctionCall::Op(f) => {
                let run = f(host)?;
                host.ops.borrow_mut().push(Op::Rust(RustOp {
                    call,
                    run: RustCall::Op(run),
                }));
                Ok(Value(0))
            }
            FunctionCall::Async(f) | FunctionCall::Start(f) => {
                let run = f(host)?;
                host.ops.borrow_mut().push(Op::Rust(RustOp {
                    call,
                    run: RustCall::Task(run),
                }));
                Ok(Value(0))
            }
        })
    }
    pub(super) fn member(
        &self,
        class: usize,
        member: usize,
        this: Value,
        args: Value,
        call: u32,
    ) -> Result<Value, Thrown> {
        let def = self
            .bindings
            .classes
            .borrow()
            .get(class)
            .copied()
            .ok_or_else(|| Thrown::Type("unknown browser class".into()))?;
        let member = def
            .members
            .get(member)
            .ok_or_else(|| Thrown::Type("unknown browser class member".into()))?;
        self.bindings
            .with_call(this, args, |host| match member.call {
                MemberCall::Sync(f) => f(host).map(|raw| Value(raw.0[0] as u32)),
                MemberCall::Async(f) | MemberCall::Start(f) => {
                    let run = f(host)?;
                    host.ops.borrow_mut().push(Op::Rust(RustOp {
                        call,
                        run: RustCall::Task(run),
                    }));
                    Ok(Value(0))
                }
            })
    }
    pub(super) fn prop(
        &self,
        index: usize,
        node: u32,
        key: &str,
        value: Value,
    ) -> Result<Value, PropError> {
        let spec = self
            .components
            .borrow()
            .get(index)
            .cloned()
            .ok_or_else(|| PropError("unknown Rust component".into()))?;
        let prop = spec
            .props
            .iter()
            .find(|p| p.name == key)
            .ok_or_else(|| PropError("unknown Rust component prop".into()))?;
        let decode = prop
            .decode
            .ok_or_else(|| PropError("not a value prop".into()))?;
        let decoded = if value.kind() == 0 {
            None
        } else {
            Some(nsh_core::element::__decoding_props_of(node, || {
                decode(nsh_core::element::JsIn::new(
                    &*self.bindings,
                    super::bindings::raw(value.0),
                ))
            })?)
        };
        self.bindings.ops.borrow_mut().push(Op::SetProp {
            id: node,
            prop: nsh_core::Prop::RustProp(prop.name, decoded),
        });
        Ok(Value(0))
    }
    pub(super) fn method(
        &self,
        index: usize,
        node: u32,
        method: usize,
        this: Value,
        args: Value,
        call: u32,
    ) -> Result<Value, Thrown> {
        let spec = self
            .components
            .borrow()
            .get(index)
            .cloned()
            .ok_or_else(|| Thrown::Type("unknown Rust component".into()))?;
        let method = spec
            .methods
            .get(method)
            .ok_or_else(|| Thrown::Type("unknown component method".into()))?;
        self.bindings.with_call(this, args, |host| {
            let run = (method.call)(host)?;
            host.ops.borrow_mut().push(Op::Rust(RustOp {
                call,
                run: RustCall::Method(node, run),
            }));
            Ok(Value(0))
        })
    }
    pub(super) fn error(&self, error: &Thrown) -> Result<Value, PropError> {
        let (class, message) = match error {
            Thrown::Type(m) => ("TypeError", m),
            Thrown::Range(m) => ("RangeError", m),
            Thrown::Error(m) => ("Error", m),
            Thrown::Fields(f) => (
                match f.class {
                    ErrorClass::Type => "TypeError",
                    ErrorClass::Range => "RangeError",
                    ErrorClass::Error => "Error",
                },
                &f.message,
            ),
        };
        let class = Value::string(class)?;
        let message = Value::string(message)?;
        let value = Value::checked(invoke(36, class.0, message.0, 0, 0.0))?;
        if let Thrown::Fields(fields) = error {
            for (key, field) in &fields.fields {
                value.set(key, &Value(self.bindings.json(field)?.0[0] as u32))?;
            }
        }
        Ok(value)
    }
}
