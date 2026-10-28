//! Event values retain the native public shape without serializing JS.
use nsh_core::{
    EventPayload, PayloadValue,
    element::{JsHost, PropError},
    geometry::{Bounds, Point, Points, Size},
};

use super::{bindings::Bindings, values::Value};
/// An input's text as `onChange`'s `{ value }`.
pub(crate) fn value(text: &str) -> Result<Value, PropError> {
    object([("value", Value::string(text)?)])
}

/// `value` as the one field `key` of an event's object.
pub(crate) fn wrap(key: &'static str, value: Value) -> Result<Value, PropError> {
    object([(key, value)])
}

/// A video's `onLoad` payload: `{ duration, size: { width, height } }` of the
/// platforms' `duration`, `width` and `height`, as nsh-js nests them.
pub(crate) fn video_load(fields: &[(&'static str, PayloadValue)]) -> Result<Value, PropError> {
    let out = Value::object()?;
    let size = Value::object()?;
    for (key, value) in fields {
        match *key {
            "width" | "height" => size.set(key, &scalar(value)?)?,
            _ => out.set(key, &scalar(value)?)?,
        }
    }
    out.set("size", &size)?;
    Ok(out)
}

fn object(fields: impl IntoIterator<Item = (&'static str, Value)>) -> Result<Value, PropError> {
    let out = Value::object()?;
    for (key, value) in fields {
        out.set(key, &value)?;
    }
    Ok(out)
}
fn number(value: impl Into<f64>) -> Value {
    Value::number(value.into())
}
fn boolean(value: bool) -> Value {
    Value(if value { 3 } else { 2 })
}
fn point(p: Point<Points>) -> Result<Value, PropError> {
    object([("x", number(p.x.0)), ("y", number(p.y.0))])
}
fn size(s: Size<Points>) -> Result<Value, PropError> {
    object([("width", number(s.width.0)), ("height", number(s.height.0))])
}
fn bounds(b: Bounds<Points>) -> Result<Value, PropError> {
    object([("origin", point(b.origin)?), ("size", size(b.size)?)])
}
fn modifiers(m: &nsh_core::keymap::Modifiers) -> Result<Value, PropError> {
    object([
        ("control", boolean(m.ctrl)),
        ("alt", boolean(m.alt)),
        ("shift", boolean(m.shift)),
        ("platform", boolean(m.cmd)),
    ])
}
fn scalar(v: &PayloadValue) -> Result<Value, PropError> {
    Ok(match v {
        PayloadValue::Number(n) => number(*n),
        PayloadValue::Bool(b) => boolean(*b),
        PayloadValue::Str(s) => Value::string(s)?,
        PayloadValue::Null => Value(1),
        PayloadValue::Point(p) => point(*p)?,
        PayloadValue::Size(s) => size(*s)?,
        PayloadValue::Bounds(b) => bounds(*b)?,
    })
}
fn strings(items: &[String]) -> Result<Value, PropError> {
    Value::array(
        items
            .iter()
            .map(|s| Value::string(s))
            .collect::<Result<Vec<_>, _>>()?,
    )
}
pub(super) fn payload(host: &Bindings, payload: &EventPayload) -> Result<Value, PropError> {
    Ok(match payload {
        EventPayload::None => Value(0),
        EventPayload::Value(v) => scalar(v)?,
        EventPayload::Map(fields) => object(
            fields
                .iter()
                .map(|(k, v)| scalar(v).map(|v| (*k, v)))
                .collect::<Result<Vec<_>, _>>()?,
        )?,
        EventPayload::Layout(b) => object([("bounds", bounds(*b)?)])?,
        EventPayload::Press(p) => object([
            ("position", point(p.position)?),
            ("pagePosition", point(p.page_position)?),
            ("modifiers", modifiers(&p.modifiers)?),
            ("clickCount", number(p.clicks)),
        ])?,
        EventPayload::Mouse(m) => object([
            ("position", point(m.position)?),
            ("pagePosition", point(m.page_position)?),
            ("modifiers", modifiers(&m.modifiers)?),
            (
                "pressedButton",
                match m.pressed_button {
                    Some(button) => Value::string(button.name())?,
                    // `null`, as `PayloadValue::Null`.
                    None => Value(1),
                },
            ),
        ])?,
        EventPayload::ContextMenu(p) => object([
            ("position", point(p.position)?),
            ("pagePosition", point(p.page_position)?),
            ("modifiers", modifiers(&p.modifiers)?),
        ])?,
        EventPayload::FileDrop(uris) => object([("uris", strings(uris)?)])?,
        EventPayload::FileDropAt {
            uris,
            page_position,
        } => object([
            ("uris", strings(uris)?),
            ("pagePosition", point(*page_position)?),
        ])?,
        EventPayload::Paste(paste) => {
            let mut files = Vec::new();
            for file in &paste.files {
                let data = nsh_core::ImageData::new(file.data.clone());
                files.push(Value(
                    host.new_file(&data, &file.mime, &file.name, None)?.0[0] as u32,
                ));
            }
            object([
                ("text", Value::string(&paste.text)?),
                ("html", Value::string(&paste.html)?),
                ("files", Value::array(files)?),
                ("uris", strings(&paste.uris)?),
            ])?
        }
        EventPayload::Picked { id, .. } => object([("id", number(*id))])?,
        EventPayload::Native { name, data } => object([
            ("name", Value::string(name)?),
            ("data", Value(host.json(data)?.0[0] as u32)),
        ])?,
        EventPayload::Json(value) => Value(host.json(value)?.0[0] as u32),
        EventPayload::TextLayout(lines) => {
            let mut values = Vec::new();
            for l in lines {
                values.push(object([
                    ("text", Value::string(&l.text)?),
                    (
                        "bounds",
                        bounds(Bounds {
                            origin: Point::new(l.x, l.y),
                            size: Size::new(l.width, l.height),
                        })?,
                    ),
                    ("ascender", number(l.ascender.0)),
                    ("descender", number(l.descender.0)),
                    ("capHeight", number(l.cap_height.0)),
                    ("xHeight", number(l.x_height.0)),
                ])?);
            }
            object([("lines", Value::array(values)?)])?
        }
        EventPayload::Pan {
            translation,
            velocity_x,
            velocity_y,
            value_x,
            value_y,
        }
        | EventPayload::PanCancelled {
            translation,
            velocity_x,
            velocity_y,
            value_x,
            value_y,
        } => {
            let out = object([
                (
                    "cancelled",
                    boolean(matches!(payload, EventPayload::PanCancelled { .. })),
                ),
                ("translation", point(*translation)?),
                (
                    "velocity",
                    object([("x", number(*velocity_x)), ("y", number(*velocity_y))])?,
                ),
            ])?;
            // The bound values, those of the axes `pan` binds.
            if value_x.is_some() || value_y.is_some() {
                let value = object([])?;
                if let Some(x) = value_x {
                    value.set("x", &number(x.0))?;
                }
                if let Some(y) = value_y {
                    value.set("y", &number(y.0))?;
                }
                out.set("value", &value)?;
            }
            out
        }
        EventPayload::Scroll(offset) => object([("offset", point(*offset)?)])?,
        EventPayload::Image(size) => object([(
            "size",
            object([
                ("width", number(size.width.0 as f64)),
                ("height", number(size.height.0 as f64)),
            ])?,
        )])?,
        EventPayload::Error { message } => object([("message", Value::string(message)?)])?,
        EventPayload::Text { text, .. } => object([("text", Value::string(text)?)])?,
        EventPayload::Touch(touch) => {
            let mut points = Vec::new();
            for p in &touch.points {
                points.push(object([
                    ("identifier", number(p.id)),
                    ("target", number(p.target)),
                    ("path", Value::array(p.path.iter().map(|id| number(*id)))?),
                    ("pageX", number(p.page.x.0)),
                    ("pageY", number(p.page.y.0)),
                    ("locationX", number(p.location.x.0)),
                    ("locationY", number(p.location.y.0)),
                    ("changed", boolean(p.changed)),
                    ("timestamp", number(touch.timestamp)),
                ])?);
            }
            object([
                (
                    "phase",
                    Value::string(match touch.phase {
                        nsh_core::TouchPhase::Start => "start",
                        nsh_core::TouchPhase::Move => "move",
                        nsh_core::TouchPhase::End => "end",
                        nsh_core::TouchPhase::Cancel => "cancel",
                    })?,
                ),
                ("timestamp", number(touch.timestamp)),
                ("activated", touch.activated.map_or(Value(0), number)),
                ("points", Value::array(points)?),
            ])?
        }
    })
}
