//! Read-only views used by the property/animation decoders. These wrap
//! browser handles, not VM objects; no JavaScript evaluation occurs here.
use std::marker::PhantomData;

use nsh_core::{
    element::PropError,
    js::host::{HostInput, HostList},
};

use super::values::Value as Handle;
pub(super) type Result<T> = std::result::Result<T, PropError>;
#[derive(Clone, Copy)]
pub(super) struct Ctx<'a>(PhantomData<&'a ()>);
const CONTEXT: Ctx<'static> = Ctx(PhantomData);
pub(super) struct Exception;
impl Exception {
    pub(super) fn throw_type(_: &Ctx<'_>, message: &str) -> PropError {
        PropError(message.into())
    }
    pub(super) fn throw_range(_: &Ctx<'_>, message: &str) -> PropError {
        PropError(message.into())
    }
}
#[derive(Clone)]
pub(super) struct Value<'a>(pub(super) Handle, PhantomData<&'a ()>);
#[derive(Clone)]
pub(super) struct Object<'a>(Value<'a>);
#[derive(Clone)]
pub(super) struct Array<'a>(Value<'a>);
pub(super) struct StringValue<'a>(Value<'a>);
#[derive(Clone, Copy)]
pub(super) enum Type {
    Undefined,
    Null,
    Bool,
    Float,
    String,
    Array,
    Function,
    Object,
    Symbol,
}
impl<'a> Value<'a> {
    pub(super) fn new(value: Handle) -> Self {
        Self(value, PhantomData)
    }
    pub(super) fn ctx(&self) -> &Ctx<'a> {
        &CONTEXT
    }
    pub(super) fn type_of(&self) -> Type {
        match self.0.kind() {
            0 => Type::Undefined,
            1 => Type::Null,
            2 => Type::Bool,
            3 => Type::Float,
            4 => Type::String,
            5 => Type::Array,
            6 => Type::Function,
            7 => Type::Object,
            _ => Type::Symbol,
        }
    }
    pub(super) fn is_string(&self) -> bool {
        self.0.kind() == 4
    }
    pub(super) fn is_null(&self) -> bool {
        self.0.kind() == 1
    }
    pub(super) fn is_undefined(&self) -> bool {
        self.0.kind() == 0
    }
    pub(super) fn is_nullish(&self) -> bool {
        self.0.is_nullish()
    }
    pub(super) fn is_object(&self) -> bool {
        self.0.is_object()
    }
    pub(super) fn as_bool(&self) -> Option<bool> {
        self.0.as_bool()
    }
    pub(super) fn as_number(&self) -> Option<f64> {
        self.0.as_number()
    }
    pub(super) fn as_float(&self) -> Option<f64> {
        self.0.as_number()
    }
    pub(super) fn as_int(&self) -> Option<i32> {
        self.0
            .as_number()
            .filter(|v| v.fract() == 0.0 && *v >= i32::MIN as f64 && *v <= i32::MAX as f64)
            .map(|v| v as i32)
    }
    pub(super) fn as_string(&self) -> Option<StringValue<'a>> {
        (self.0.kind() == 4).then(|| StringValue(self.clone()))
    }
    pub(super) fn as_array(&self) -> Option<Array<'a>> {
        (self.0.kind() == 5).then(|| Array(self.clone()))
    }
    pub(super) fn as_object(&self) -> Option<Object<'a>> {
        self.0.is_object().then(|| Object(self.clone()))
    }
    pub(super) fn node(&self) -> Option<u32> {
        self.0.node()
    }
}
impl StringValue<'_> {
    pub(super) fn to_string(&self) -> Result<String> {
        self.0
            .0
            .as_string()
            .ok_or_else(|| PropError("expected a string".into()))
    }
}
pub(super) trait FromValue<'a>: Sized {
    fn from_value(value: Value<'a>) -> Result<Self>;
}
impl<'a> FromValue<'a> for Value<'a> {
    fn from_value(value: Value<'a>) -> Result<Self> {
        Ok(value)
    }
}
impl<'a> FromValue<'a> for Array<'a> {
    fn from_value(value: Value<'a>) -> Result<Self> {
        value
            .as_array()
            .ok_or_else(|| PropError("expected an array".into()))
    }
}
impl<'a> FromValue<'a> for Object<'a> {
    fn from_value(value: Value<'a>) -> Result<Self> {
        value
            .as_object()
            .ok_or_else(|| PropError("expected an object".into()))
    }
}
impl<'a> FromValue<'a> for String {
    fn from_value(value: Value<'a>) -> Result<Self> {
        value
            .0
            .as_string()
            .ok_or_else(|| PropError("expected a string".into()))
    }
}
impl<'a> FromValue<'a> for bool {
    fn from_value(value: Value<'a>) -> Result<Self> {
        value
            .as_bool()
            .ok_or_else(|| PropError("expected a boolean".into()))
    }
}
macro_rules! number { ($($t:ty),*) => { $(impl<'a> FromValue<'a> for $t { fn from_value(value: Value<'a>) -> Result<Self> { value.as_number().map(|v| v as Self).ok_or_else(|| PropError("expected a number".into())) } })* }; }
number!(f32, f64, i32, u32, usize);
impl<'a, T: FromValue<'a>> FromValue<'a> for Option<T> {
    fn from_value(value: Value<'a>) -> Result<Self> {
        if value.is_nullish() {
            Ok(None)
        } else {
            T::from_value(value).map(Some)
        }
    }
}
impl<'a> Object<'a> {
    pub(super) fn get<K: AsRef<str>, T: FromValue<'a>>(&self, key: K) -> Result<T> {
        T::from_value(Value::new(self.0.0.get(key.as_ref())?))
    }
    pub(super) fn props<K: From<String>, T: FromValue<'a>>(
        &self,
    ) -> impl Iterator<Item = Result<(K, T)>> {
        let entries: Result<Vec<_>> = self.0.0.keys().and_then(|keys| {
            keys.into_iter()
                .map(|k| self.get(k.as_str()).map(|v| (K::from(k), v)))
                .collect()
        });
        match entries {
            Ok(entries) => entries.into_iter().map(Ok).collect::<Vec<_>>(),
            Err(error) => vec![Err(error)],
        }
        .into_iter()
    }
}
impl<'a> Array<'a> {
    pub(super) fn len(&self) -> usize {
        self.0.0.len()
    }
    pub(super) fn get<T: FromValue<'a>>(&self, index: usize) -> Result<T> {
        T::from_value(Value::new(self.0.0.index(index)?))
    }
    pub(super) fn iter<T: FromValue<'a>>(&self) -> impl Iterator<Item = Result<T>> {
        (0..self.len()).map(|i| self.get(i))
    }
}

impl<'a, T: FromValue<'a>> FromValue<'a> for Vec<T> {
    fn from_value(value: Value<'a>) -> Result<Self> {
        value
            .as_array()
            .ok_or_else(|| PropError("expected an array".into()))?
            .iter()
            .collect()
    }
}
