//! The payloads of the page's events (`event::payload`): every field
//! `web/nsh.js` sends reaches the core.

use nsh_core::{EventKind, EventPayload, PayloadValue};
use serde_json::json;

use crate::event::payload;

/// The fields of `name`'s payload `value` as the core gets them.
fn fields(name: &str, value: serde_json::Value) -> Vec<(&'static str, PayloadValue)> {
    let kind = EventKind::from_prop(name).unwrap_or_else(|| panic!("{name} is no event"));
    match payload(kind, value) {
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
