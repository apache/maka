//! JS values as Rust reads and makes them directly, without JSON: what
//! every call into Rust converts its arguments and results with, and Rust
//! components their props and events ([`super::JsValue::from_js`],
//! [`super::JsValue::to_js`]).
//!
//! The values are the JS host's (`nsh-js`: QuickJS's), opaque here
//! ([`JsRaw`]); a [`JsHost`] reads and makes them. A [`JsIn`] is a value
//! borrowed for a call, a [`JsOwned`] one Rust holds a reference to (freed
//! when dropped).

use std::{fmt, rc::Rc};

use super::{PropError, callback::CallbackHandle, class::ClassInstance};
use crate::JsonValue;

/// A JS value as the host holds it, copied in: meaningful to the host
/// only.
#[doc(hidden)]
#[derive(Clone, Copy)]
#[repr(C, align(8))]
pub struct JsRaw(pub [u64; 2]);

impl fmt::Debug for JsRaw {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("JsRaw")
    }
}

/// What kind of value a JS value is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JsKind {
    /// `undefined`.
    Undefined,
    /// `null`.
    Null,
    /// `true` or `false`.
    Bool,
    /// A number.
    Number,
    /// A string.
    String,
    /// An array.
    Array,
    /// A function.
    Function,
    /// Any other object.
    Object,
    /// A symbol, a big integer, ...
    Other,
}

/// What class of object a JS object is, as `Object.prototype.toString`
/// tells built-in objects apart ([`JsIn::class`]): what checks of equality
/// compare by (`nsh/test`'s `toEqual`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum JsClass {
    /// An array.
    Array,
    /// A function.
    Function,
    /// A `Date`.
    Date,
    /// A `RegExp`.
    RegExp,
    /// A `Map`.
    Map,
    /// A `Set`.
    Set,
    /// An error (an `Error` or one of its subclasses).
    Error,
    /// An `ArrayBuffer`.
    ArrayBuffer,
    /// A typed array or a `DataView`, named by its class (`"Uint8Array"`,
    /// `"DataView"`).
    View(&'static str),
    /// Any other object: a plain object, an instance of a class, ...
    Object,
}

/// Whether `a` and `b` are the same primitive, as `Object.is` says (`NaN`
/// is `NaN`, `0` is not `-0`); objects are never the same here.
fn same_primitive<H: JsHost + ?Sized>(host: &H, a: JsRaw, b: JsRaw) -> bool {
    match (host.kind(a), host.kind(b)) {
        (JsKind::Undefined, JsKind::Undefined) | (JsKind::Null, JsKind::Null) => true,
        (JsKind::Bool, JsKind::Bool) => host.bool(a) == host.bool(b),
        (JsKind::String, JsKind::String) => host.string(a) == host.string(b),
        (JsKind::Number, JsKind::Number) => match (host.number(a), host.number(b)) {
            (Some(a), Some(b)) if a.is_nan() => b.is_nan(),
            (Some(a), Some(b)) => a == b && a.is_sign_negative() == b.is_sign_negative(),
            _ => false,
        },
        _ => false,
    }
}

/// A value of an array or object read in bulk ([`JsIn::primitives`],
/// [`JsIn::primitive_entries`]).
#[derive(Debug, Clone, PartialEq)]
pub enum JsPrimitive {
    /// Anything else: `undefined`, `null`, an object, a function, ...
    Other,
    /// `true` or `false`.
    Bool(bool),
    /// A number.
    Number(f64),
    /// A string.
    String(String),
    /// A `Date`, as milliseconds since the Unix epoch.
    Date(f64),
}

/// Value `raw` of `host` as a [`JsPrimitive`].
fn primitive_of<H: JsHost + ?Sized>(host: &H, raw: JsRaw) -> JsPrimitive {
    match host.kind(raw) {
        JsKind::Bool => host.bool(raw).map_or(JsPrimitive::Other, JsPrimitive::Bool),
        JsKind::Number => host
            .number(raw)
            .map_or(JsPrimitive::Other, JsPrimitive::Number),
        JsKind::String => host
            .string(raw)
            .map_or(JsPrimitive::Other, JsPrimitive::String),
        JsKind::Object => host.date(raw).map_or(JsPrimitive::Other, JsPrimitive::Date),
        _ => JsPrimitive::Other,
    }
}

/// The JS host's side of the direct conversions (`nsh-js` implements it):
/// reads and makes values of its VM, and the call being made (its
/// arguments, `this`). Values it returns are owned (one reference the
/// caller frees); values it takes are borrowed unless named otherwise.
#[doc(hidden)]
pub trait JsHost {
    /// The kind of `v`.
    fn kind(&self, v: JsRaw) -> JsKind;
    /// `v` as a boolean (`None`: not one).
    fn bool(&self, v: JsRaw) -> Option<bool>;
    /// `v` as a number (`None`: not one).
    fn number(&self, v: JsRaw) -> Option<f64>;
    /// `v` as a string (`None`: not one).
    fn string(&self, v: JsRaw) -> Option<String>;
    /// The bytes of `Uint8Array` `v`, copied (`None`: not one).
    fn bytes(&self, v: JsRaw) -> Option<Vec<u8>>;
    /// The length of array `v` (`None`: not an array; an error when it is
    /// more than the host reads in one call).
    fn len(&self, v: JsRaw) -> Result<Option<usize>, PropError>;
    /// Item `i` of array `v`, owned.
    fn index(&self, v: JsRaw, i: usize) -> Result<JsRaw, PropError>;
    /// Field `key` of object `v` (`undefined` when it has none), owned.
    fn field(&self, v: JsRaw, key: &str) -> Result<JsRaw, PropError>;
    /// The own enumerable string keys of object `v` (none when it is not
    /// one).
    fn keys(&self, v: JsRaw) -> Result<Vec<String>, PropError>;
    /// The time `Date` `v` stands for, in milliseconds since the Unix
    /// epoch (`None`: not a `Date`).
    fn date(&self, v: JsRaw) -> Option<f64>;
    /// The items of array `v` as primitives (`None`: not an array). One
    /// call for the whole array where a host crosses a boundary for each
    /// value it reads (the browser's): tables read many rows of them.
    fn primitives(&self, v: JsRaw) -> Result<Option<Vec<JsPrimitive>>, PropError> {
        let Some(len) = self.len(v)? else {
            return Ok(None);
        };
        let mut items = Vec::with_capacity(len);
        for i in 0..len {
            let item = self.index(v, i)?;
            items.push(primitive_of(self, item));
            self.free(item);
        }
        Ok(Some(items))
    }
    /// The own enumerable string-keyed fields of object `v` as primitives
    /// (none when it is not one), in one call as [`JsHost::primitives`].
    fn primitive_entries(&self, v: JsRaw) -> Result<Vec<(String, JsPrimitive)>, PropError> {
        let mut entries = Vec::new();
        for key in self.keys(v)? {
            let field = self.field(v, &key)?;
            entries.push((key, primitive_of(self, field)));
            self.free(field);
        }
        Ok(entries)
    }
    /// The class of object `v` (`None`: not an object). A host that tells
    /// only arrays, functions and dates apart says `Object` for the rest.
    fn class(&self, v: JsRaw) -> Option<JsClass> {
        match self.kind(v) {
            JsKind::Array => Some(JsClass::Array),
            JsKind::Function => Some(JsClass::Function),
            JsKind::Object if self.date(v).is_some() => Some(JsClass::Date),
            JsKind::Object => Some(JsClass::Object),
            _ => None,
        }
    }
    /// Whether `a` and `b` are the same value, as `Object.is` says: the
    /// same primitive, or the same object. A host that cannot tell objects
    /// apart says no for any two.
    fn same_value(&self, a: JsRaw, b: JsRaw) -> bool {
        same_primitive(self, a, b)
    }
    /// The bytes of `ArrayBuffer`, typed array or `DataView` `v`, copied
    /// (`None`: none of those). A host that reads only `Uint8Array`s reads
    /// [`JsHost::bytes`].
    fn buffer(&self, v: JsRaw) -> Option<Vec<u8>> {
        self.bytes(v)
    }
    /// The values iterable `v` yields, as `for...of` reads them (a `Map`'s
    /// `[key, value]` pairs, a `Set`'s values), owned (`None`: not
    /// iterable). A host without the iteration protocol reads arrays.
    fn iterate(&self, v: JsRaw) -> Result<Option<Vec<JsRaw>>, PropError> {
        let Some(len) = self.len(v)? else {
            return Ok(None);
        };
        let mut items = Vec::with_capacity(len);
        for i in 0..len {
            match self.index(v, i) {
                Ok(item) => items.push(item),
                Err(e) => {
                    for item in items {
                        self.free(item);
                    }
                    return Err(e);
                }
            }
        }
        Ok(Some(items))
    }
    /// Calls method `name` of `v` (a primitive's, as JS does: `"a".search(…)`)
    /// with `args` (borrowed): its result, owned. A host without calls
    /// refuses.
    fn invoke(&self, v: JsRaw, name: &str, args: &[JsRaw]) -> Result<JsRaw, PropError> {
        let _ = (v, args);
        Err(PropError(format!("`{name}` cannot be called here")))
    }
    /// `v` as JSON (as `JSON.stringify` sees it).
    fn to_json(&self, v: JsRaw) -> Result<JsonValue, PropError>;
    /// A short text showing `v`, for errors (`"abc"`, `{}`).
    fn describe(&self, v: JsRaw) -> String;
    /// Style `v` (an object or an array of them), decoded as a host
    /// element's `style` is; what it does not take is logged as there.
    fn style(&self, v: JsRaw) -> Result<crate::StylePatch, PropError>;
    /// The node `v` is (an element, a `ref`: TS `ViewRef`).
    fn node(&self, v: JsRaw) -> Option<crate::NodeId>;
    /// Node `id`'s JS object (`null` when JS let it go), owned.
    fn node_value(&self, id: crate::NodeId) -> JsRaw;
    /// The instance of a class `v` holds (any class's).
    fn instance(&self, v: JsRaw) -> Option<Rc<dyn ClassInstance>>;
    /// The JS function `v` is, as a callback Rust keeps.
    fn callback(&self, v: JsRaw) -> Option<Rc<dyn CallbackHandle>>;
    /// Any value `v`, kept alive until the handle goes, to give back to JS
    /// later ([`CallbackHandle::value`]): the rows a component reads, to
    /// hand them to the app's functions one by one; a promise a
    /// [`super::Callback::settling`] answers with. `None` where the host
    /// keeps no values.
    fn retain(&self, _v: JsRaw) -> Option<Rc<dyn CallbackHandle>> {
        None
    }

    /// Whether this host owns a retained handle's values. Hosts that cannot
    /// establish ownership reject it before any raw value is accessed.
    /// A host supporting retained values must recognize its own handles;
    /// this does not grant permission to transfer values from another VM.
    fn owns_retained(&self, _handle: &dyn CallbackHandle) -> bool {
        false
    }

    /// Frees owned value `v`.
    fn free(&self, v: JsRaw);
    /// `undefined`.
    fn undefined(&self) -> JsRaw;
    /// `null`.
    fn null(&self) -> JsRaw;
    /// A boolean.
    fn new_bool(&self, b: bool) -> JsRaw;
    /// A number.
    fn new_number(&self, n: f64) -> JsRaw;
    /// A string.
    fn new_string(&self, s: &str) -> Result<JsRaw, PropError>;
    /// A `Uint8Array` of `bytes` (copied).
    fn new_bytes(&self, bytes: &[u8]) -> Result<JsRaw, PropError>;
    /// A `Date` of `millis` since the Unix epoch.
    fn new_date(&self, millis: f64) -> Result<JsRaw, PropError>;
    /// An array of `items` (taken).
    fn new_array(&self, items: Vec<JsRaw>) -> Result<JsRaw, PropError>;
    /// An empty object.
    fn new_object(&self) -> Result<JsRaw, PropError>;
    /// Sets field `key` of object `obj` to `value` (taken).
    fn set_field(&self, obj: JsRaw, key: &str, value: JsRaw) -> Result<(), PropError>;
    /// JSON as a JS value.
    fn json(&self, v: &JsonValue) -> Result<JsRaw, PropError>;
    /// A `File` named `name` of type `mime` holding `data` (shared, not
    /// copied), last changed at `last_modified` (`None`: now). A host
    /// without `File` refuses.
    fn new_file(
        &self,
        data: &crate::ImageData,
        mime: &str,
        name: &str,
        last_modified: Option<std::time::SystemTime>,
    ) -> Result<JsRaw, PropError> {
        let _ = (data, mime, name, last_modified);
        Err(PropError("a `File` cannot be made here".into()))
    }
    /// A function taking nothing and returning `undefined` that runs `f`
    /// each time it is called ([`super::Stop`]'s). A host without
    /// functions refuses.
    fn new_function(&self, f: Box<dyn Fn()>) -> Result<JsRaw, PropError> {
        drop(f);
        Err(PropError("a function cannot be made here".into()))
    }
    /// The JS object of `instance`: the one it has, or a new one of its
    /// class.
    fn wrap(&self, instance: Rc<dyn ClassInstance>) -> Result<JsRaw, PropError>;

    /// Argument `i` of the call (`undefined` past the last), borrowed.
    fn arg(&self, i: usize) -> JsRaw;
    /// `this` of the call, borrowed.
    fn this(&self) -> JsRaw;
    /// The object a constructor makes for `instance` (with `new.target`'s
    /// prototype).
    fn construct(&self, instance: Rc<dyn ClassInstance>) -> Result<JsRaw, PropError>;

    /// The VM the call comes from ([`super::System`]); one granting nothing
    /// where the host configured none.
    fn system(&self) -> super::System {
        super::System::default()
    }

    /// Starts `task` as a task of the core, in order with the ops JS sent
    /// before the call (`CallCx::start`); a host without a core drops it.
    fn start_task(&self, task: super::TaskStart) {
        drop(task);
    }

    /// The image `blob:` URL `url` names in this VM (`URL.createObjectURL`):
    /// the key it goes by and its bytes, as `<Image>`'s `src` resolves one,
    /// so an image prop of a Rust component shows what `<Image>` would.
    /// `None` for a URL no blob has (revoked, never made) or a host without
    /// blobs: the image then fails to load.
    fn image_blob(&self, url: &str) -> Option<(std::sync::Arc<str>, crate::ImageData)> {
        let _ = url;
        None
    }

    /// Runs `f` when what owns the call in JS goes (`CallCx::on_cleanup`);
    /// a host without owners keeps it until it goes itself. Returns what
    /// unregisters `f` without running it.
    fn on_cleanup(&self, f: Box<dyn FnOnce()>) -> Box<dyn FnOnce()> {
        drop(f);
        Box::new(|| {})
    }
}

/// A JS value borrowed for a call: read it with its methods, convert it
/// with [`super::JsValue::from_js`].
#[derive(Clone, Copy)]
pub struct JsIn<'a> {
    host: &'a dyn JsHost,
    raw: JsRaw,
}

impl fmt::Debug for JsIn<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.describe())
    }
}

impl<'a> JsIn<'a> {
    /// Value `raw` of `host`, borrowed.
    #[doc(hidden)]
    pub fn new(host: &'a dyn JsHost, raw: JsRaw) -> Self {
        Self { host, raw }
    }

    /// The host the value belongs to.
    #[doc(hidden)]
    pub fn host(&self) -> &'a dyn JsHost {
        self.host
    }

    /// The value as the host holds it.
    #[doc(hidden)]
    pub fn raw(&self) -> JsRaw {
        self.raw
    }

    /// What kind of value it is.
    pub fn kind(&self) -> JsKind {
        self.host.kind(self.raw)
    }

    /// The bytes of a `Uint8Array`, copied.
    pub fn as_bytes(&self) -> Option<Vec<u8>> {
        self.host.bytes(self.raw)
    }

    /// `undefined` or `null`.
    pub fn is_nullish(&self) -> bool {
        matches!(self.kind(), JsKind::Undefined | JsKind::Null)
    }

    /// The boolean it is.
    pub fn as_bool(&self) -> Option<bool> {
        self.host.bool(self.raw)
    }

    /// The number it is.
    pub fn as_number(&self) -> Option<f64> {
        self.host.number(self.raw)
    }

    /// The string it is.
    pub fn as_string(&self) -> Option<String> {
        self.host.string(self.raw)
    }

    /// Its length, if it is an array (an error when it is longer than the
    /// host reads in one call).
    pub fn array_len(&self) -> Result<Option<usize>, PropError> {
        self.host.len(self.raw)
    }

    /// Item `i` of the array it is.
    pub fn index(&self, i: usize) -> Result<JsOwned<'a>, PropError> {
        let raw = self.host.index(self.raw, i)?;
        Ok(JsOwned::new(self.host, raw))
    }

    /// Its field `key` (`undefined` when it has none).
    pub fn field(&self, key: &str) -> Result<JsOwned<'a>, PropError> {
        let raw = self.host.field(self.raw, key)?;
        Ok(JsOwned::new(self.host, raw))
    }

    /// Its own enumerable string keys (none when it is not an object).
    pub fn keys(&self) -> Result<Vec<String>, PropError> {
        self.host.keys(self.raw)
    }

    /// The items of the array it is, as primitives (`None`: not an array),
    /// read in one call.
    pub fn primitives(&self) -> Result<Option<Vec<JsPrimitive>>, PropError> {
        self.host.primitives(self.raw)
    }

    /// Its own enumerable string-keyed fields, as primitives (none when it
    /// is not an object), read in one call.
    pub fn primitive_entries(&self) -> Result<Vec<(String, JsPrimitive)>, PropError> {
        self.host.primitive_entries(self.raw)
    }

    /// The milliseconds since the Unix epoch of the `Date` it is.
    pub fn as_date(&self) -> Option<f64> {
        self.host.date(self.raw)
    }

    /// The class of the object it is (`None`: not an object).
    pub fn class(&self) -> Option<JsClass> {
        self.host.class(self.raw)
    }

    /// Whether it is `other`, as `Object.is` says (the same object, or
    /// the same primitive: `NaN` is `NaN`, `0` is not `-0`).
    pub fn same_value(&self, other: JsIn<'_>) -> bool {
        self.host.same_value(self.raw, other.raw)
    }

    /// The bytes of the `ArrayBuffer`, typed array or `DataView` it is,
    /// copied.
    pub fn as_buffer(&self) -> Option<Vec<u8>> {
        self.host.buffer(self.raw)
    }

    /// The values it yields as an iterable, as `for...of` reads them (a
    /// `Map`'s `[key, value]` pairs, a `Set`'s values; `None`: not
    /// iterable).
    pub fn iterate(&self) -> Result<Option<Vec<JsOwned<'a>>>, PropError> {
        Ok(self.host.iterate(self.raw)?.map(|items| {
            items
                .into_iter()
                .map(|raw| JsOwned::new(self.host, raw))
                .collect()
        }))
    }

    /// Calls its method `name` with `args`: what it returns (a
    /// primitive's methods too: `"a".search(re)`).
    pub fn invoke(&self, name: &str, args: &[JsIn<'_>]) -> Result<JsOwned<'a>, PropError> {
        let args: Vec<JsRaw> = args.iter().map(|a| a.raw).collect();
        let raw = self.host.invoke(self.raw, name, &args)?;
        Ok(JsOwned::new(self.host, raw))
    }

    /// The value as JSON.
    pub fn to_json(&self) -> Result<JsonValue, PropError> {
        self.host.to_json(self.raw)
    }

    /// A short text showing it, for errors.
    pub fn describe(&self) -> String {
        self.host.describe(self.raw)
    }

    /// "expected `what`, got `<the value>`".
    pub fn expected(&self, what: &str) -> PropError {
        PropError(format!("expected {what}, got {}", self.describe()))
    }
}

/// A JS value Rust holds a reference to, freed when dropped.
pub struct JsOwned<'a> {
    host: &'a dyn JsHost,
    raw: JsRaw,
}

impl<'a> JsOwned<'a> {
    /// Owned value `raw` of `host`.
    #[doc(hidden)]
    pub fn new(host: &'a dyn JsHost, raw: JsRaw) -> Self {
        Self { host, raw }
    }

    /// The value, to read.
    pub fn get(&self) -> JsIn<'a> {
        JsIn {
            host: self.host,
            raw: self.raw,
        }
    }

    /// The reference, for the host to take.
    #[doc(hidden)]
    pub fn into_raw(self) -> JsRaw {
        let raw = self.raw;
        std::mem::forget(self);
        raw
    }
}

impl Drop for JsOwned<'_> {
    fn drop(&mut self) {
        self.host.free(self.raw);
    }
}

impl fmt::Debug for JsOwned<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.get().fmt(f)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::element::json_host::JsonHost;

    #[test]
    fn hosts_without_their_own_compare_primitives_and_read_arrays() {
        let host = JsonHost::default();
        let value = |json| JsIn::new(&host, host.value(json));
        let undefined = JsIn::new(&host, host.undefined());
        assert!(value(json!(1)).same_value(value(json!(1.0))));
        assert!(value(json!("a")).same_value(value(json!("a"))));
        assert!(undefined.same_value(undefined));
        assert!(!undefined.same_value(value(json!(null))));
        assert!(!value(json!(1)).same_value(value(json!("1"))));
        assert!(!value(json!(0.0)).same_value(value(json!(-0.0))));
        // Two objects are never the same here.
        assert!(!value(json!({})).same_value(value(json!({}))));
        assert_eq!(value(json!([1])).class(), Some(JsClass::Array));
        assert_eq!(value(json!({})).class(), Some(JsClass::Object));
        assert_eq!(value(json!("a")).class(), None);
        let items = value(json!(["a", 2])).iterate().unwrap().unwrap();
        let items: Vec<_> = items.iter().map(|i| i.get().to_json().unwrap()).collect();
        assert_eq!(items, [json!("a"), json!(2)]);
        assert!(value(json!({})).iterate().unwrap().is_none());
        assert!(value(json!("a")).invoke("search", &[]).is_err());
    }
}
