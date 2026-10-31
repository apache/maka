//! The JS values `nsh/test`'s `expect` checks, kept as JS made them
//! ([`Kept`]) and compared as Jest compares them, in Rust over the test
//! file's VM ([`JsHost`]): `toBe` by `Object.is` ([`JsIn::same_value`]),
//! `toEqual` by Jest's recursive equality ([`equals`]), `toMatchObject` by
//! its subsets ([`matches_object`]), `toContain` by `===`
//! ([`strict_equal`]). No value goes through JSON on the way: a `Date`,
//! a `Map` or a typed array is compared as what it is.
//!
//! A matcher reads values only while JS runs, so it returns a [`Check`],
//! which makes the comparison as its result goes back to JS (an `async`
//! one's too, once what it waited for settled).

use std::{collections::HashSet, rc::Rc};

use nsh_core::element::{
    CallbackHandle, JsClass, JsHost, JsIn, JsKind, JsOwned, JsValue, PropError, Ret, TsTypes,
};

/// A JS value as JS made it, kept to check later: what `expect` was
/// given, and what its matchers compare it with. Cheap to clone; the value
/// is released when the last clone goes.
#[derive(Clone)]
pub struct Kept(Rc<dyn CallbackHandle>);

impl Kept {
    /// The value, as a value of `host` to read.
    pub(crate) fn get<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, String> {
        self.0
            .value(host)
            .map(|raw| JsOwned::new(host, raw))
            .ok_or_else(|| "the value is gone: its VM stopped".to_owned())
    }
}

impl JsValue for Kept {
    fn ts_type(_types: &mut TsTypes) -> String {
        "unknown".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        value
            .host()
            .retain(value.raw())
            .map(Kept)
            .ok_or_else(|| PropError("values cannot be kept here".into()))
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        self.get(host).map_err(PropError)
    }
}

/// A check a matcher makes once it can read the values: made as its result
/// goes back to JS (which has the VM at hand), it throws (or rejects) with
/// what did not hold.
pub struct Check(Box<CheckFn>);

type CheckFn = dyn FnOnce(&dyn JsHost) -> Result<(), String>;

impl Check {
    /// The check `f` makes.
    pub(crate) fn new(f: impl FnOnce(&dyn JsHost) -> Result<(), String> + 'static) -> Self {
        Self(Box::new(f))
    }
}

impl Ret for Check {
    fn ts_type(_types: &mut TsTypes) -> String {
        "void".into()
    }

    fn into_js<'a>(self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        (self.0)(host).map_err(PropError)?;
        Ok(JsOwned::new(host, host.undefined()))
    }
}

/// Whether `a === b`: `Object.is`, but `NaN` is not `NaN` and `0` is `-0`
/// (`toContain`, as `Array.prototype.indexOf` compares).
pub(crate) fn strict_equal(a: JsIn<'_>, b: JsIn<'_>) -> bool {
    match (a.kind(), b.kind()) {
        (JsKind::Number, JsKind::Number) => a.as_number() == b.as_number(),
        _ => a.same_value(b),
    }
}

/// Whether `a` equals `b` as Jest's `toEqual` says: `Object.is` for
/// primitives (`NaN` equals `NaN`, `0` is not `-0`); objects of one class,
/// member by member: own enumerable properties (one that is `undefined`
/// is as one missing), arrays item by item (holes are `undefined`), dates
/// by their time, regular expressions by source and flags, maps and sets by
/// their entries (in any order), `ArrayBuffer`s, typed arrays and
/// `DataView`s by their bytes, errors by name and message (and their own
/// properties); functions only by identity. Classes are not compared: an
/// instance equals a plain object with its properties.
pub(crate) fn equals(a: JsIn<'_>, b: JsIn<'_>) -> Result<bool, PropError> {
    Equality::new(false).eq(a, b)
}

/// Whether `value` matches `subset` as Jest's `toMatchObject` says: an
/// object (a plain object, an instance of a class) has each property of
/// `subset` (its own or inherited, as an error's `name`), each matching in
/// turn; an array has as many items, each matching; anything else equals
/// it as [`equals`] says.
pub(crate) fn matches_object(value: JsIn<'_>, subset: JsIn<'_>) -> Result<bool, PropError> {
    Equality::new(true).eq(value, subset)
}

/// A comparison in progress: the pairs of objects being compared, so a
/// value that holds itself compares with what the other holds there
/// (Jest's `aStack` / `bStack`).
struct Equality<'a> {
    stack: Vec<(JsIn<'a>, JsIn<'a>)>,
    /// `toMatchObject`: objects in `b` are subsets.
    subset: bool,
}

impl<'a> Equality<'a> {
    fn new(subset: bool) -> Self {
        Self {
            stack: Vec::new(),
            subset,
        }
    }

    fn eq(&mut self, a: JsIn<'a>, b: JsIn<'a>) -> Result<bool, PropError> {
        if a.same_value(b) {
            return Ok(true);
        }
        let (Some(class_a), Some(class_b)) = (a.class(), b.class()) else {
            // A primitive, and a value it is not.
            return Ok(false);
        };
        if let Some(i) = self.stack.iter().position(|(x, _)| x.same_value(a)) {
            return Ok(self.stack[i].1.same_value(b));
        }
        self.stack.push((a, b));
        let equal = if self.subset && class_b == JsClass::Object {
            self.has_subset(a, b)
        } else if class_a == class_b {
            self.eq_objects(a, b, class_a)
        } else {
            Ok(false)
        };
        self.stack.pop();
        equal
    }

    /// Objects `a` and `b`, both of class `class`.
    fn eq_objects(&mut self, a: JsIn<'a>, b: JsIn<'a>, class: JsClass) -> Result<bool, PropError> {
        Ok(match class {
            JsClass::Function => false,
            JsClass::Date => match (a.as_date(), b.as_date()) {
                (Some(x), Some(y)) => x == y || (x.is_nan() && y.is_nan()),
                _ => false,
            },
            JsClass::RegExp => {
                text(a, "source")? == text(b, "source")? && text(a, "flags")? == text(b, "flags")?
            }
            JsClass::ArrayBuffer | JsClass::View(_) => a.as_buffer() == b.as_buffer(),
            JsClass::Map | JsClass::Set => self.eq_entries(a, b)?,
            JsClass::Error => {
                text(a, "name")? == text(b, "name")?
                    && text(a, "message")? == text(b, "message")?
                    && self.eq_properties(a, b)?
            }
            JsClass::Array => a.array_len()? == b.array_len()? && self.eq_properties(a, b)?,
            _ => self.eq_properties(a, b)?,
        })
    }

    /// The own enumerable properties of `a` and `b`, each equal; a property
    /// one of them lacks is `undefined` there.
    fn eq_properties(&mut self, a: JsIn<'a>, b: JsIn<'a>) -> Result<bool, PropError> {
        let mut keys = a.keys()?;
        let mut seen: HashSet<String> = keys.iter().cloned().collect();
        keys.extend(b.keys()?.into_iter().filter(|k| seen.insert(k.clone())));
        for key in keys {
            let (x, y) = (a.field(&key)?, b.field(&key)?);
            if !self.eq(x.get(), y.get())? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// The entries of maps (`[key, value]` pairs) or sets `a` and `b`: as
    /// many, each of `a`'s equal to one of `b`'s, in any order.
    fn eq_entries(&mut self, a: JsIn<'a>, b: JsIn<'a>) -> Result<bool, PropError> {
        let (Some(xs), Some(ys)) = (a.iterate()?, b.iterate()?) else {
            return Ok(false);
        };
        if xs.len() != ys.len() {
            return Ok(false);
        }
        'entries: for (i, x) in xs.iter().enumerate() {
            // Entries in the same order match at once.
            if self.eq(x.get(), ys[i].get())? {
                continue;
            }
            for y in &ys {
                if self.eq(x.get(), y.get())? {
                    continue 'entries;
                }
            }
            return Ok(false);
        }
        Ok(true)
    }

    /// Whether `value` has every property of object `subset`, each
    /// matching.
    fn has_subset(&mut self, value: JsIn<'a>, subset: JsIn<'a>) -> Result<bool, PropError> {
        if value.class().is_none() {
            return Ok(false);
        }
        for key in subset.keys()? {
            let (got, want) = (value.field(&key)?, subset.field(&key)?);
            let present = got.get().kind() != JsKind::Undefined || value.keys()?.contains(&key);
            if !present || !self.eq(got.get(), want.get())? {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

/// Property `key` of `v` as a string (`None`: not one).
fn text(v: JsIn<'_>, key: &str) -> Result<Option<String>, PropError> {
    Ok(v.field(key)?.get().as_string())
}

/// JS's truthiness of `v`.
pub(crate) fn truthy(v: JsIn<'_>) -> bool {
    match v.kind() {
        JsKind::Undefined | JsKind::Null => false,
        JsKind::Bool => v.as_bool() == Some(true),
        JsKind::Number => v.as_number().is_some_and(|n| n != 0.0 && !n.is_nan()),
        JsKind::String => v.as_string().is_some_and(|s| !s.is_empty()),
        // A big integer is falsy when it is zero; a symbol never is.
        JsKind::Other => !v
            .invoke("toString", &[])
            .is_ok_and(|s| s.get().as_string().as_deref() == Some("0")),
        JsKind::Array | JsKind::Function | JsKind::Object => true,
    }
}

/// `v` as failure messages show it: strings and keys quoted as JSON is,
/// arrays and objects compact (`["a",1]`, `{"a":1}`), what JSON cannot
/// say as JS would (`undefined`, `NaN`, `-0`, `Date(2024-01-01T00:00:00.000Z)`,
/// `/a+/i`, `Map {"a" => 1}`, `Set {1, 2}`, `Uint8Array [1,2]`, an
/// instance with its class's name, `[Circular]` for a value inside
/// itself).
pub(crate) fn show(v: JsIn<'_>) -> String {
    let mut out = String::new();
    Shower { stack: Vec::new() }.write(v, &mut out);
    out
}

/// A number as JS writes it (`1`, `0.5`, `NaN`, `-0`).
pub(crate) fn number(n: f64) -> String {
    if n.is_nan() {
        "NaN".into()
    } else if n.is_infinite() {
        let sign = if n > 0.0 { "" } else { "-" };
        format!("{sign}Infinity")
    } else if n == 0.0 && n.is_sign_negative() {
        "-0".into()
    } else if n.fract() == 0.0 && n.abs() < 1e21 {
        format!("{n:.0}")
    } else {
        format!("{n}")
    }
}

struct Shower<'a> {
    /// The objects being written, for `[Circular]`.
    stack: Vec<JsIn<'a>>,
}

impl<'a> Shower<'a> {
    fn write(&mut self, v: JsIn<'a>, out: &mut String) {
        match v.kind() {
            JsKind::Undefined => out.push_str("undefined"),
            JsKind::Null => out.push_str("null"),
            JsKind::Bool => out.push_str(if v.as_bool() == Some(true) {
                "true"
            } else {
                "false"
            }),
            JsKind::Number => out.push_str(&number(v.as_number().unwrap_or(f64::NAN))),
            JsKind::String => out.push_str(&quoted(&v.as_string().unwrap_or_default())),
            JsKind::Other => {
                let text = v
                    .invoke("toString", &[])
                    .ok()
                    .and_then(|s| s.get().as_string())
                    .unwrap_or_else(|| v.describe());
                out.push_str(&text);
                if !text.starts_with("Symbol(") {
                    // A big integer.
                    out.push('n');
                }
            }
            JsKind::Array | JsKind::Function | JsKind::Object => {
                if self.stack.iter().any(|x| x.same_value(v)) {
                    out.push_str("[Circular]");
                    return;
                }
                self.stack.push(v);
                self.write_object(v, out);
                self.stack.pop();
            }
        }
    }

    fn write_object(&mut self, v: JsIn<'a>, out: &mut String) {
        let field = |key: &str| v.field(key).ok().and_then(|f| f.get().as_string());
        match v.class().unwrap_or(JsClass::Object) {
            JsClass::Array => {
                let len = v.array_len().ok().flatten().unwrap_or(0);
                out.push('[');
                for i in 0..len {
                    if i > 0 {
                        out.push(',');
                    }
                    match v.index(i) {
                        Ok(item) => self.write(item.get(), out),
                        Err(_) => out.push('?'),
                    }
                }
                out.push(']');
            }
            JsClass::Function => {
                let name = field("name").filter(|n| !n.is_empty());
                out.push_str(&format!(
                    "[Function {}]",
                    name.as_deref().unwrap_or("anonymous")
                ));
            }
            JsClass::Date => {
                let iso = v
                    .invoke("toISOString", &[])
                    .ok()
                    .and_then(|s| s.get().as_string())
                    .unwrap_or_else(|| "Invalid Date".into());
                out.push_str(&format!("Date({iso})"));
            }
            JsClass::RegExp => out.push_str(&format!(
                "/{}/{}",
                field("source").unwrap_or_default(),
                field("flags").unwrap_or_default()
            )),
            JsClass::Error => {
                let name = field("name").unwrap_or_else(|| "Error".into());
                let message = field("message").unwrap_or_default();
                out.push_str(&format!("{name}({})", quoted(&message)));
            }
            JsClass::Map | JsClass::Set => {
                let map = v.class() == Some(JsClass::Map);
                out.push_str(if map { "Map {" } else { "Set {" });
                let entries = v.iterate().ok().flatten().unwrap_or_default();
                for (i, entry) in entries.iter().enumerate() {
                    if i > 0 {
                        out.push_str(", ");
                    }
                    let entry = entry.get();
                    if map {
                        if let (Ok(key), Ok(value)) = (entry.index(0), entry.index(1)) {
                            self.write(key.get(), out);
                            out.push_str(" => ");
                            self.write(value.get(), out);
                        }
                    } else {
                        self.write(entry, out);
                    }
                }
                out.push('}');
            }
            JsClass::ArrayBuffer | JsClass::View("DataView") => {
                let name = if v.class() == Some(JsClass::ArrayBuffer) {
                    "ArrayBuffer"
                } else {
                    "DataView"
                };
                let bytes = v.as_buffer().unwrap_or_default();
                let bytes: Vec<String> = bytes.iter().map(u8::to_string).collect();
                out.push_str(&format!("{name} [{}]", bytes.join(",")));
            }
            JsClass::View(name) => {
                let len = v
                    .field("length")
                    .ok()
                    .and_then(|l| l.get().as_number())
                    .unwrap_or(0.0) as usize;
                out.push_str(name);
                out.push_str(" [");
                for i in 0..len {
                    if i > 0 {
                        out.push(',');
                    }
                    if let Ok(item) = v.index(i) {
                        self.write(item.get(), out);
                    }
                }
                out.push(']');
            }
            _ => {
                let class = v
                    .field("constructor")
                    .ok()
                    .and_then(|c| c.get().field("name").ok())
                    .and_then(|n| n.get().as_string())
                    .filter(|n| !n.is_empty() && n != "Object");
                if let Some(class) = class {
                    out.push_str(&class);
                    out.push(' ');
                }
                out.push('{');
                for (i, key) in v.keys().unwrap_or_default().iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&quoted(key));
                    out.push(':');
                    match v.field(key) {
                        Ok(value) => self.write(value.get(), out),
                        Err(_) => out.push('?'),
                    }
                }
                out.push('}');
            }
        }
    }
}

/// `s` quoted as JSON writes a string.
fn quoted(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| format!("{s:?}"))
}
