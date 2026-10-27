//! A JS host over JSON values, for the core's tests: it reads and makes
//! values as `nsh-js` does with QuickJS's, in an arena of JSON values
//! (`undefined` apart), so props, events and results convert as they do
//! for an app.

use std::{cell::RefCell, rc::Rc};

use super::{
    AnyValue, CallbackHandle, ClassInstance, JsHost, JsIn, JsKind, JsOwned, JsRaw, JsResult,
    PropDecode, PropError,
};
use crate::{JsonValue, NodeId};

#[derive(Clone)]
enum Val {
    Undefined,
    Json(JsonValue),
}

/// The host: its values live as long as it does.
#[derive(Default)]
pub(crate) struct JsonHost {
    values: RefCell<Vec<Val>>,
    args: Vec<JsonValue>,
}

impl JsonHost {
    /// A host whose call has `args`.
    pub(crate) fn with_args(args: Vec<JsonValue>) -> Self {
        Self {
            values: RefCell::default(),
            args,
        }
    }

    fn put(&self, v: Val) -> JsRaw {
        let mut values = self.values.borrow_mut();
        values.push(v);
        JsRaw([(values.len() - 1) as u64, 0])
    }

    fn val(&self, v: JsRaw) -> Val {
        self.values.borrow()[v.0[0] as usize].clone()
    }

    fn json_of(&self, v: JsRaw) -> Option<JsonValue> {
        match self.val(v) {
            Val::Undefined => None,
            Val::Json(json) => Some(json),
        }
    }

    /// `json` as a value of the host.
    pub(crate) fn value(&self, json: JsonValue) -> JsRaw {
        self.put(Val::Json(json))
    }

    /// What `v` is (`None`: `undefined`).
    pub(crate) fn read(&self, v: JsOwned<'_>) -> Option<JsonValue> {
        self.json_of(v.into_raw())
    }
}

/// Prop value `json` as `decode` reads it from JS.
pub(crate) fn decode(decode: PropDecode, json: JsonValue) -> Result<AnyValue, PropError> {
    let host = JsonHost::default();
    let raw = host.value(json);
    decode(JsIn::new(&host, raw))
}

/// The data JS hears with `event` (`None`: none).
pub(crate) fn event_data(event: &dyn super::EventToJs) -> Option<JsonValue> {
    let host = JsonHost::default();
    let data = event.data_js(&host).expect("the event's data converts");
    host.read(data)
}

/// The value JS renders with (`None`: `undefined`).
pub(crate) fn render_value(value: &dyn super::RenderValue) -> Option<JsonValue> {
    let host = JsonHost::default();
    let data = value.render_js(&host).expect("the value converts");
    host.read(data)
}

/// The value a call's result settles its promise with (`None`:
/// `undefined`), or the rejection's message.
pub(crate) fn result(result: JsResult) -> Result<Option<JsonValue>, String> {
    let host = JsonHost::default();
    let value = result
        .map_err(|e| e.to_string())?
        .to_js_value(&host)
        .map_err(|e| e.0)?;
    Ok(host.read(value))
}

impl JsHost for JsonHost {
    fn kind(&self, v: JsRaw) -> JsKind {
        match self.val(v) {
            Val::Undefined => JsKind::Undefined,
            Val::Json(JsonValue::Null) => JsKind::Null,
            Val::Json(JsonValue::Bool(_)) => JsKind::Bool,
            Val::Json(JsonValue::Number(_)) => JsKind::Number,
            Val::Json(JsonValue::String(_)) => JsKind::String,
            Val::Json(JsonValue::Array(_)) => JsKind::Array,
            Val::Json(JsonValue::Object(_)) => JsKind::Object,
        }
    }

    fn bool(&self, v: JsRaw) -> Option<bool> {
        self.json_of(v)?.as_bool()
    }

    fn number(&self, v: JsRaw) -> Option<f64> {
        self.json_of(v)?.as_f64()
    }

    fn string(&self, v: JsRaw) -> Option<String> {
        self.json_of(v)?.as_str().map(str::to_owned)
    }

    /// An array of byte values stands for a `Uint8Array` here.
    fn bytes(&self, v: JsRaw) -> Option<Vec<u8>> {
        self.json_of(v)?
            .as_array()?
            .iter()
            .map(|n| n.as_u64().and_then(|n| u8::try_from(n).ok()))
            .collect()
    }

    fn len(&self, v: JsRaw) -> Result<Option<usize>, PropError> {
        Ok(self.json_of(v).and_then(|j| j.as_array().map(Vec::len)))
    }

    fn index(&self, v: JsRaw, i: usize) -> Result<JsRaw, PropError> {
        let item = self.json_of(v).and_then(|j| j.get(i).cloned());
        Ok(self.put(item.map_or(Val::Undefined, Val::Json)))
    }

    fn field(&self, v: JsRaw, key: &str) -> Result<JsRaw, PropError> {
        let field = self.json_of(v).and_then(|j| j.get(key).cloned());
        Ok(self.put(field.map_or(Val::Undefined, Val::Json)))
    }

    fn keys(&self, v: JsRaw) -> Result<Vec<String>, PropError> {
        Ok(match self.json_of(v) {
            Some(JsonValue::Object(map)) => map.keys().cloned().collect(),
            _ => Vec::new(),
        })
    }

    /// A `{ "$date": millis }` object stands for a `Date` here.
    fn date(&self, v: JsRaw) -> Option<f64> {
        self.json_of(v)?.get("$date")?.as_f64()
    }

    fn to_json(&self, v: JsRaw) -> Result<JsonValue, PropError> {
        Ok(self.json_of(v).unwrap_or(JsonValue::Null))
    }

    fn describe(&self, v: JsRaw) -> String {
        match self.val(v) {
            Val::Undefined => "undefined".to_owned(),
            Val::Json(json) => json.to_string(),
        }
    }

    /// Objects' numbers, strings and nulls, as the core once read inline
    /// styles (enough for its tests).
    fn style(&self, v: JsRaw) -> Result<crate::StylePatch, PropError> {
        fn walk(value: &JsonValue, style: &mut crate::Style, patch: &mut crate::StylePatch) {
            use crate::StyleValue as V;
            match value {
                JsonValue::Object(entries) => {
                    for (key, value) in entries {
                        let v = match value {
                            JsonValue::Number(n) => V::Number(n.as_f64().unwrap_or(0.0) as f32),
                            JsonValue::String(s) => V::Str(s),
                            JsonValue::Null => V::Null,
                            _ => continue,
                        };
                        // Reported as the JS host reports them.
                        match patch.set(style, key, v) {
                            Ok(()) => {}
                            Err(crate::StyleError::UnknownProperty) => {
                                log::warn!("unsupported style property `{key}`")
                            }
                            Err(crate::StyleError::InvalidValue) => {
                                log::warn!("invalid value for style `{key}`: {v:?}")
                            }
                        }
                    }
                }
                JsonValue::Array(items) => {
                    for item in items {
                        walk(item, style, patch);
                    }
                }
                _ => {}
            }
        }
        let mut style = crate::Style::default();
        let mut patch = crate::StylePatch::default();
        if let Some(json) = self.json_of(v) {
            walk(&json, &mut style, &mut patch);
        }
        Ok(patch)
    }

    fn node(&self, _v: JsRaw) -> Option<NodeId> {
        None
    }

    fn node_value(&self, _id: NodeId) -> JsRaw {
        self.null()
    }

    fn instance(&self, _v: JsRaw) -> Option<Rc<dyn ClassInstance>> {
        None
    }

    fn callback(&self, _v: JsRaw) -> Option<Rc<dyn CallbackHandle>> {
        None
    }

    fn free(&self, _v: JsRaw) {}

    fn undefined(&self) -> JsRaw {
        self.put(Val::Undefined)
    }

    fn null(&self) -> JsRaw {
        self.value(JsonValue::Null)
    }

    fn new_bytes(&self, bytes: &[u8]) -> Result<JsRaw, PropError> {
        Ok(self.value(JsonValue::from(bytes.to_vec())))
    }

    fn new_date(&self, millis: f64) -> Result<JsRaw, PropError> {
        Ok(self.value(serde_json::json!({ "$date": millis })))
    }

    fn new_bool(&self, b: bool) -> JsRaw {
        self.value(JsonValue::Bool(b))
    }

    /// A whole number reads as an integer, as `JSON.stringify` writes it.
    fn new_number(&self, n: f64) -> JsRaw {
        if n.fract() == 0.0 && n.abs() < 2f64.powi(53) {
            return self.value(serde_json::json!(n as i64));
        }
        self.value(serde_json::json!(n))
    }

    fn new_string(&self, s: &str) -> Result<JsRaw, PropError> {
        Ok(self.value(JsonValue::String(s.to_owned())))
    }

    fn new_array(&self, items: Vec<JsRaw>) -> Result<JsRaw, PropError> {
        let items = items
            .into_iter()
            .map(|i| self.json_of(i).unwrap_or(JsonValue::Null))
            .collect();
        Ok(self.value(JsonValue::Array(items)))
    }

    fn new_object(&self) -> Result<JsRaw, PropError> {
        Ok(self.value(JsonValue::Object(Default::default())))
    }

    fn set_field(&self, obj: JsRaw, key: &str, value: JsRaw) -> Result<(), PropError> {
        // `undefined` fields are left out, as `JSON.stringify` does.
        let Some(value) = self.json_of(value) else {
            return Ok(());
        };
        if let Val::Json(JsonValue::Object(map)) = &mut self.values.borrow_mut()[obj.0[0] as usize]
        {
            map.insert(key.to_owned(), value);
        }
        Ok(())
    }

    fn json(&self, v: &JsonValue) -> Result<JsRaw, PropError> {
        Ok(self.value(v.clone()))
    }

    fn wrap(&self, _instance: Rc<dyn ClassInstance>) -> Result<JsRaw, PropError> {
        Err(PropError("the JSON host has no classes".to_owned()))
    }

    fn arg(&self, i: usize) -> JsRaw {
        match self.args.get(i) {
            Some(json) => self.value(json.clone()),
            None => self.undefined(),
        }
    }

    fn this(&self) -> JsRaw {
        self.undefined()
    }

    fn construct(&self, _instance: Rc<dyn ClassInstance>) -> Result<JsRaw, PropError> {
        Err(PropError("the JSON host has no classes".to_owned()))
    }
}
