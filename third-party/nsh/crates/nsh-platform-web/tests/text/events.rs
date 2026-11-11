//! The payloads of the page's events (`event::payload`): every field
//! `web/nsh.js` sends reaches the core.

use nsh_core::{EventKind, EventPayload, PayloadValue};
use serde_json::json;

use crate::event::payload;

/// The fields of `name`'s payload `value` as the core gets them.
fn fields(name: &str, value: serde_json::Value) -> Vec<(&'static str, PayloadValue)> {
    let kind = EventKind::from_prop(name).unwrap_or_else(|| panic!("{name} is no event"));
    match payload(kind, value).unwrap_or_else(|| panic!("{name}: no payload")) {
        EventPayload::Map(fields) => fields,
        other => panic!("{name}: {other:?}"),
    }
}

fn get(fields: &[(&'static str, PayloadValue)], key: &str) -> Option<PayloadValue> {
    fields
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, v)| v.clone())
}

#[test]
fn open_url_reports_whether_the_browser_opened_it() {
    for opened in [true, false] {
        let fields = fields("onOpenUrl", json!({ "id": 3, "opened": opened }));
        assert_eq!(get(&fields, "id"), Some(PayloadValue::Number(3.0)));
        assert_eq!(get(&fields, "opened"), Some(PayloadValue::Bool(opened)));
    }
}

#[test]
fn every_field_the_page_sends_reaches_the_core() {
    // The object payloads `nsh.js` sends, one per event.
    let sent = [
        ("onOpenUrl", json!({ "id": 1, "opened": true })),
        ("onRequestClose", json!({ "reason": "cancel" })),
        (
            "onClipboard",
            json!({ "id": 1, "has": true, "text": "a", "uri": "data:", "width": 2, "height": 3, "files": "" }),
        ),
        (
            "onImageInfo",
            json!({ "id": 1, "width": 2, "height": 3, "error": "failed" }),
        ),
        ("onScreenColor", json!({ "id": 1, "color": "#ff0000" })),
        ("onDialog", json!({ "id": 1, "index": 0 })),
        ("onKeyPress", json!({ "key": "Enter" })),
        ("onSelectionChange", json!({ "start": 1, "end": 2 })),
        (
            "onCompositionChange",
            json!({ "composing": true, "text": "a" }),
        ),
        ("onMessage", json!({ "data": "hi" })),
        (
            "onNavigationStateChange",
            json!({ "url": "https://example.com/", "title": "", "loading": false, "canGoBack": false, "canGoForward": false }),
        ),
        ("onProgress", json!({ "currentTime": 1.5, "duration": 3 })),
        ("onBuffer", json!({ "isBuffering": true })),
        (
            "onLoad",
            json!({ "duration": 3, "width": 640, "height": 360 }),
        ),
    ];
    for (name, value) in sent {
        let got = fields(name, value.clone());
        for key in value.as_object().unwrap().keys() {
            assert!(get(&got, key).is_some(), "{name}'s `{key}` was dropped");
        }
    }
}

#[test]
fn a_field_no_event_sent_before_reaches_the_core_too() {
    // A key added to `nsh.js` needs nothing here.
    let fields = fields("onOpenUrl", json!({ "id": 1, "someFutureKey": "x" }));
    assert_eq!(
        get(&fields, "someFutureKey"),
        Some(PayloadValue::Str("x".into()))
    );
}

#[test]
fn keys_are_kept_once() {
    let first = fields("onOpenUrl", json!({ "opened": true }));
    let second = fields("onOpenUrl", json!({ "opened": false }));
    // The same static key, not one allocated per event.
    assert!(std::ptr::eq(first[0].0, second[0].0));
}

#[test]
fn nested_values_are_left_out() {
    let fields = fields(
        "onOpenUrl",
        json!({ "id": 1, "nested": { "a": 1 }, "list": [1] }),
    );
    assert_eq!(fields.len(), 1);
}

#[test]
fn wheels_reach_the_core_with_their_unit() {
    let sent = |mode: &str| {
        payload(
            EventKind::Wheel,
            json!({
                "position": { "x": 1, "y": 2 },
                "pagePosition": { "x": 11, "y": 12 },
                "delta": { "x": 0, "y": -3 },
                "deltaMode": mode,
                "modifiers": { "control": true, "alt": false, "shift": false, "platform": false },
            }),
        )
    };
    let Some(EventPayload::Wheel(lines)) = sent("lines") else {
        panic!("onWheel carries a wheel");
    };
    assert_eq!(
        lines.delta,
        nsh_core::WheelDelta::Lines(nsh_core::geometry::point(0.0, -3.0))
    );
    assert!(lines.modifiers.ctrl);
    assert_eq!(lines.page_position.x.0, 11.0);
    let Some(EventPayload::Wheel(points)) = sent("points") else {
        panic!("onWheel carries a wheel");
    };
    assert!(points.delta.precise());
    assert_eq!(points.delta.xy(), (0.0, -3.0));
}

#[test]
fn a_release_reports_its_button_but_not_one_it_cannot_name() {
    use nsh_core::MouseButton;

    let button = |value: serde_json::Value| match payload(EventKind::MouseUp, value) {
        Some(EventPayload::Mouse(event)) => event.button.unwrap(),
        other => panic!("{other:?}"),
    };
    // A keyboard or scripted release names no button: it is the primary one,
    // which `onPressUp` pairs with.
    assert_eq!(button(json!({})), MouseButton::Left);
    assert_eq!(button(json!({ "button": "right" })), MouseButton::Right);
    // A name this build does not know is no release at all; it must not read
    // as the primary button.
    assert!(payload(EventKind::MouseUp, json!({ "button": "side" })).is_none());
}
