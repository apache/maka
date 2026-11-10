//! The payloads of the page's events (`nsh_event`): the JSON object
//! `web/nsh.js` sends with an event, as the core's [`EventPayload`].
//!
//! Depends on nothing of the browser: `tests/text` builds it on the host.

use std::{cell::RefCell, collections::HashSet};

use nsh_core::{
    EventKind, EventPayload, PayloadValue, Points,
    geometry::{DevicePixels, point, size},
};

/// `value`, the JSON payload of a `kind` event, as the core takes it.
pub(crate) fn payload(kind: EventKind, value: serde_json::Value) -> EventPayload {
    let num = |k: &str| value.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
    let text = |k: &str| {
        value
            .get(k)
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_owned()
    };
    match kind {
        EventKind::ScrollEnd
        | EventKind::ScrollDragStart
        | EventKind::ScrollDragEnd
        | EventKind::MomentumStart
        | EventKind::MomentumEnd => EventPayload::Scroll(point(Points(num("x")), Points(num("y")))),
        // A video's and a web view's loads carry more than an image's.
        EventKind::Load if value.get("duration").is_none() && value.get("url").is_none() => {
            // `naturalWidth` / `naturalHeight`: whole pixels.
            EventPayload::Image(size(
                DevicePixels(num("width") as i32),
                DevicePixels(num("height") as i32),
            ))
        }
        EventKind::Error => EventPayload::Error {
            message: text("message"),
        },
        // `{ position, pagePosition, modifiers, pressedButton }`, as handlers
        // get it.
        EventKind::MouseEnter | EventKind::MouseLeave | EventKind::MouseMove => {
            let (position, page_position, modifiers) = pointer_at(&value);
            let pressed_button = value
                .get("pressedButton")
                .and_then(|v| v.as_str())
                .and_then(mouse_button);
            EventPayload::Mouse(nsh_core::MouseEvent::new(
                position,
                page_position,
                modifiers,
                pressed_button,
            ))
        }
        EventKind::ContextMenu
        | EventKind::Press
        | EventKind::LongPress
        | EventKind::PressDown
        | EventKind::PressUp
            if kind == EventKind::ContextMenu || value.get("pagePosition").is_some() =>
        {
            // `{ position, pagePosition, modifiers }` (presses: and
            // `clicks`; a context menu: and `pointerType`), as handlers get
            // it.
            let (position, page_position, modifiers) = pointer_at(&value);
            if kind != EventKind::ContextMenu {
                EventPayload::Press(nsh_core::PressEvent {
                    position,
                    page_position,
                    modifiers,
                    clicks: (num("clicks") as u32).max(1),
                })
            } else {
                EventPayload::ContextMenu(nsh_core::ContextMenuEvent::new(
                    position,
                    page_position,
                    modifiers,
                    // `null`: the keyboard or an assistive technology.
                    value
                        .get("pointerType")
                        .and_then(|v| v.as_str())
                        .and_then(nsh_core::PointerType::from_name),
                ))
            }
        }
        EventKind::ChangeText | EventKind::SubmitEditing => EventPayload::Text {
            text: text("text"),
            count: num("count") as u32,
        },
        // `{ bounds: { origin, size } }`, as handlers get it.
        EventKind::CaretMove => {
            let caret = value.get("bounds");
            let n = |part: &str, c: &str| {
                caret
                    .and_then(|v| v.get(part))
                    .and_then(|v| v.get(c))
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0) as f32
            };
            EventPayload::caret(nsh_core::Bounds {
                origin: point(Points(n("origin", "x")), Points(n("origin", "y"))),
                size: size(Points(n("size", "width")), Points(n("size", "height"))),
            })
        }
        // `{ id, event, ... }`: what a sound or a player reported
        // (`nsh.js`'s `audioEvent`; durations and positions in seconds).
        EventKind::Audio => audio_payload(&value),
        EventKind::Host => EventPayload::Json(value),
        _ => match &value {
            // Every field goes through: a key the page sends is one the
            // event declares (`onOpenUrl`'s `opened`, `onRequestClose`'s
            // `reason`, ...), and a list of known keys here would drop
            // the next one added to `nsh.js`.
            serde_json::Value::Object(map) => EventPayload::Map(
                map.iter()
                    .filter_map(|(k, v)| {
                        let v = match v {
                            serde_json::Value::Number(n) => {
                                PayloadValue::Number(n.as_f64().unwrap_or(0.0))
                            }
                            serde_json::Value::Bool(b) => PayloadValue::Bool(*b),
                            serde_json::Value::String(s) => PayloadValue::Str(s.clone()),
                            _ => return None,
                        };
                        Some((key(k), v))
                    })
                    .collect(),
            ),
            _ => EventPayload::None,
        },
    }
}

/// `name` as the static payload key the core takes: each distinct key is
/// allocated once and kept, a handful of names `nsh.js` uses.
fn key(name: &str) -> &'static str {
    thread_local! {
        static KEYS: RefCell<HashSet<&'static str>> = RefCell::new(HashSet::new());
    }
    KEYS.with(|keys| {
        let mut keys = keys.borrow_mut();
        if let Some(key) = keys.get(name) {
            return *key;
        }
        let key: &'static str = Box::leak(name.into());
        keys.insert(key);
        key
    })
}

/// The pointer of a mouse or press payload: its `position`, `pagePosition`
/// and `modifiers`.
fn pointer_at(
    value: &serde_json::Value,
) -> (
    nsh_core::Point<Points>,
    nsh_core::Point<Points>,
    nsh_core::keymap::Modifiers,
) {
    let at = |k: &str| {
        let p = value.get(k);
        let n = |c: &str| {
            p.and_then(|p| p.get(c))
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0) as f32
        };
        point(Points(n("x")), Points(n("y")))
    };
    let flag = |k: &str| {
        value
            .get("modifiers")
            .and_then(|m| m.get(k))
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    };
    let modifiers = nsh_core::keymap::Modifiers {
        ctrl: flag("control"),
        alt: flag("alt"),
        shift: flag("shift"),
        cmd: flag("platform"),
    };
    (at("position"), at("pagePosition"), modifiers)
}

/// The button a mouse payload's `pressedButton` names (`nsh.js` names the
/// first of the DOM's `buttons` bits held).
fn mouse_button(name: &str) -> Option<nsh_core::MouseButton> {
    Some(match name {
        "left" => nsh_core::MouseButton::Left,
        "right" => nsh_core::MouseButton::Right,
        "middle" => nsh_core::MouseButton::Middle,
        "back" => nsh_core::MouseButton::Back,
        "forward" => nsh_core::MouseButton::Forward,
        _ => return None,
    })
}

/// The payload of an `onAudio` event: `{ id, event, duration?, position?,
/// bytes?, truncated?, buffering?, error?, message? }`.
fn audio_payload(value: &serde_json::Value) -> EventPayload {
    use std::time::Duration;

    use nsh_core::audio::{AudioError, AudioEvent as E};
    let seconds = |k: &str| {
        value
            .get(k)
            .and_then(|v| v.as_f64())
            // `try_`: a time too large for a `Duration` is no time, not a
            // panic.
            .and_then(|s| Duration::try_from_secs_f64(s).ok())
    };
    let id = value.get("id").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let name = value.get("event").and_then(|v| v.as_str()).unwrap_or("");
    let event = match name {
        "loaded" => E::Loaded {
            duration: seconds("duration").unwrap_or_default(),
            bytes: value.get("bytes").and_then(|v| v.as_u64()).unwrap_or(0),
            truncated: value
                .get("truncated")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        },
        // `duration` is absent for a live stream (Infinity).
        "load" => E::Load {
            duration: seconds("duration"),
        },
        "playing" => E::Playing,
        "paused" => E::Paused,
        "progress" => E::Progress {
            position: seconds("position").unwrap_or_default(),
            duration: seconds("duration"),
        },
        "buffer" => E::Buffer {
            buffering: value
                .get("buffering")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        },
        "ended" => E::Ended,
        "failed" => E::Failed {
            error: value
                .get("error")
                .and_then(|v| v.as_str())
                .and_then(AudioError::from_name)
                .unwrap_or(AudioError::Failed),
            message: value
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_owned(),
        },
        _ => return EventPayload::None,
    };
    EventPayload::Audio { id, event }
}
