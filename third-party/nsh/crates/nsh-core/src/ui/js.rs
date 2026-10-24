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
    /// `v` as JSON (as `JSON.stringify` sees it).
    fn to_json(&self, v: JsRaw) -> Result<JsonValue, PropError>;
    /// A short text showing `v`, for errors (`"abc"`, `{}`).
    fn describe(&self, v: JsRaw) -> String;
    /// Style `v` (an object or an array of them), decoded as a host
    /// element's `style` is; what it does not take is logged as there.
    fn style(&self, v: JsRaw) -> Result<crate::StylePatch, PropError>;
    /// The node `v` is (a `YNode`, a `ref`).
    fn node(&self, v: JsRaw) -> Option<crate::NodeId>;
    /// Node `id`'s JS object (`null` when JS let it go), owned.
    fn node_value(&self, id: crate::NodeId) -> JsRaw;
    /// The instance of a class `v` holds (any class's).
    fn instance(&self, v: JsRaw) -> Option<Rc<dyn ClassInstance>>;
    /// The JS function `v` is, as a callback Rust keeps.
    fn callback(&self, v: JsRaw) -> Option<Rc<dyn CallbackHandle>>;

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

    /// The milliseconds since the Unix epoch of the `Date` it is.
    pub fn as_date(&self) -> Option<f64> {
        self.host.date(self.raw)
    }

    /// The value as JSON.
    pub fn to_json(&self) -> Result<JsonValue, PropError> {
        self.host.to_json(self.raw)
    }

    /// A short text showing it, for errors.
    pub fn describe(&self) -> String {
        self.host.describe(self.raw)
    }

    /// "expected `what`, got <the value>".
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
