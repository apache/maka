/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Platform-specific raw argument boundaries, after trusted RPC decoding.

#[cfg(any(target_os = "windows", target_os = "macos", test))]
use crate::protocol::NativeComputerMethod as Method;
#[cfg(any(target_os = "windows", target_os = "macos", test))]
use maka_agent_facts::tools::ToolError;
use serde_json::Value;
#[cfg(any(target_os = "windows", target_os = "macos", test))]
use serde_json::{Map, json};

#[cfg(any(target_os = "windows", target_os = "macos", test))]
fn failed(message: impl Into<String>) -> ToolError {
    ToolError::Failed(message.into())
}

pub(super) fn first(args: &[Value]) -> &Value {
    args.first().unwrap_or(&Value::Null)
}

#[cfg(any(target_os = "windows", target_os = "macos", test))]
pub(super) fn object(value: &Value) -> Result<&Map<String, Value>, ToolError> {
    value
        .as_object()
        .ok_or_else(|| failed("native input must be an object"))
}

#[cfg(any(target_os = "windows", target_os = "macos", test))]
fn trim_js(value: &str) -> &str {
    value.trim_matches(|ch| {
        matches!(ch, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}'
        | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}'
        | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
    })
}

#[cfg(any(target_os = "windows", target_os = "macos", test))]
pub(super) fn nonempty(value: Option<&Value>, message: &str) -> Result<String, ToolError> {
    value
        .and_then(Value::as_str)
        .filter(|value| !trim_js(value).is_empty())
        .map(str::to_owned)
        .ok_or_else(|| failed(message))
}

#[cfg(any(target_os = "windows", test))]
fn js_number(value: &Value) -> Option<f64> {
    if let Some(number) = value.as_f64() {
        return Some(number);
    }
    let value = trim_js(value.as_str()?);
    if value.is_empty() {
        return None;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = value.strip_prefix(prefix) {
            return u64::from_str_radix(digits, radix)
                .ok()
                .map(|number| number as f64);
        }
    }
    value.parse::<f64>().ok()
}

#[cfg(any(target_os = "windows", test))]
pub(super) fn index(value: &Value, message: &str) -> Result<u64, ToolError> {
    let number = js_number(value)
        .filter(|n| n.is_finite() && *n >= 0.0 && n.fract() == 0.0)
        .ok_or_else(|| failed(message))?;
    // Native window/token lookup is u64. Values outside its actual identity
    // domain must not saturate to an unrelated live native object.
    if number >= 18_446_744_073_709_551_616.0 {
        return Err(failed(message));
    }
    Ok(number as u64)
}

#[cfg(any(target_os = "windows", target_os = "macos", test))]
pub(super) fn finite(value: Option<&Value>, field: &str) -> Result<f64, ToolError> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .ok_or_else(|| failed(format!("{field} must be a finite number")))
}

/// Math.round, including values immediately below a half. Adding 0.5 before
/// floor would incorrectly round 0.49999999999999994 to 1 by double rounding.
#[cfg(any(target_os = "windows", test))]
fn js_round(value: f64) -> f64 {
    let floor = value.floor();
    let rounded = if value - floor < 0.5 {
        floor
    } else {
        floor + 1.0
    };
    if rounded == 0.0 { 0.0 } else { rounded }
}

#[cfg(any(target_os = "windows", test))]
fn rounded(value: Option<&Value>, field: &str) -> Result<Value, ToolError> {
    Ok(json!(js_round(finite(value, field)?)))
}

#[cfg(any(target_os = "windows", test))]
fn optional(output: &mut Map<String, Value>, input: &Map<String, Value>, name: &str) {
    if let Some(value) = input.get(name).filter(|value| !value.is_null()) {
        output.insert(name.into(), value.clone());
    }
}

#[cfg(any(target_os = "windows", test))]
pub(super) fn window(value: &Value) -> Result<Value, ToolError> {
    let message = "window.app must be a non-empty string and window.id must be an integer >= 0";
    let input = value.as_object().ok_or_else(|| failed(message))?;
    let app = nonempty(input.get("app"), message)?;
    let id = index(input.get("id").unwrap_or(&Value::Null), message)?;
    let mut output = json!({"app":app,"id":id});
    if let Some(title) = input.get("title").and_then(Value::as_str) {
        output["title"] = title.into();
    }
    Ok(output)
}

#[cfg(any(target_os = "windows", test))]
pub(super) fn windows(method: Method, value: &Value) -> Result<Value, ToolError> {
    use Method::*;
    if matches!(method, ListApps | ListWindows) {
        return Ok(json!({}));
    }
    let input = object(value)?;
    if matches!(method, LaunchApp) {
        return Ok(json!({"app":nonempty(input.get("app"), "app is required")?}));
    }
    if matches!(method, GetWindow) {
        let id = index(
            input.get("id").unwrap_or(&Value::Null),
            "id must be an integer >= 0",
        )?;
        let mut result = json!({"id":id});
        if let Ok(app) = nonempty(input.get("app"), "app is required") {
            result["app"] = app.into();
        }
        return Ok(result);
    }
    let target = || window(input.get("window").unwrap_or(&Value::Null));
    let mut output = Map::new();
    match method {
        ActivateWindow => {
            output.insert("window".into(), target()?);
        }
        GetWindowState => {
            let screenshot = input
                .get("include_screenshot")
                .cloned()
                .unwrap_or(json!(true));
            let text = input.get("include_text").cloned().unwrap_or(json!(false));
            if !truthy(&screenshot) && !truthy(&text) {
                return Err(failed(
                    "get_window_state must request include_text, include_screenshot, or both",
                ));
            }
            output.insert("window".into(), target()?);
            output.insert("include_screenshot".into(), screenshot);
            output.insert("include_text".into(), text);
        }
        Click => {
            output.insert("window".into(), target()?);
            let element = ["element_index", "elementIndex", "element"]
                .into_iter()
                .find_map(|name| input.get(name).filter(|value| !value.is_null()));
            if let Some(element) = element {
                output.insert(
                    "element_index".into(),
                    index(element, "element_index must be an integer >= 0")?.into(),
                );
            } else {
                if input.get("x").is_none_or(Value::is_null)
                    || input.get("y").is_none_or(Value::is_null)
                {
                    return Err(failed(
                        "click requires either element_index or finite x and y coordinates",
                    ));
                }
                output.insert("x".into(), rounded(input.get("x"), "point.x")?);
                output.insert("y".into(), rounded(input.get("y"), "point.y")?);
                optional(&mut output, input, "screenshotId");
            }
            let count = input.get("click_count").cloned().unwrap_or(json!(1));
            let count = js_round(finite(Some(&count), "click_count")?);
            if count < 1.0 {
                return Err(failed("click_count must be >= 1"));
            }
            output.insert("click_count".into(), json!(count));
            output.insert(
                "mouse_button".into(),
                input.get("mouse_button").cloned().unwrap_or(json!("left")),
            );
        }
        Scroll => {
            output.insert("window".into(), target()?);
            for (name, field) in [
                ("x", "scroll.x"),
                ("y", "scroll.y"),
                ("scrollX", "scroll.scrollX"),
                ("scrollY", "scroll.scrollY"),
            ] {
                output.insert(name.into(), rounded(input.get(name), field)?);
            }
            optional(&mut output, input, "screenshotId");
        }
        Drag => {
            output.insert("window".into(), target()?);
            for (name, field) in [
                ("from_x", "from.x"),
                ("from_y", "from.y"),
                ("to_x", "to.x"),
                ("to_y", "to.y"),
            ] {
                output.insert(name.into(), rounded(input.get(name), field)?);
            }
            optional(&mut output, input, "screenshotId");
        }
        PressKey => {
            let value = input.get("key").unwrap_or(&Value::Null);
            if !truthy(value) {
                return Err(failed("key is required"));
            }
            output.insert("window".into(), target()?);
            let key = value
                .as_str()
                .ok_or_else(|| failed("key must be a string"))?;
            let key = key
                .split('+')
                .map(trim_js)
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join("+");
            if key.is_empty() {
                return Err(failed("key is required"));
            }
            output.insert("key".into(), key.into());
        }
        TypeText | SetValue => {
            let name = if matches!(method, TypeText) {
                "text"
            } else {
                "value"
            };
            let value = input
                .get(name)
                .and_then(Value::as_str)
                .ok_or_else(|| failed(format!("{name} is required")))?;
            output.insert("window".into(), target()?);
            output.insert(name.into(), value.into());
            if matches!(method, SetValue) {
                output.insert(
                    "element_index".into(),
                    index(
                        input.get("element_index").unwrap_or(&Value::Null),
                        "element_index must be an integer >= 0",
                    )?
                    .into(),
                );
            }
        }
        PerformSecondaryAction => {
            let action = nonempty(input.get("action"), "action is required")?;
            output.insert("window".into(), target()?);
            output.insert("action".into(), action.into());
            output.insert(
                "element_index".into(),
                index(
                    input.get("element_index").unwrap_or(&Value::Null),
                    "element_index must be an integer >= 0",
                )?
                .into(),
            );
        }
        _ => return Err(failed("native method is not installed for Windows")),
    }
    Ok(Value::Object(output))
}

#[cfg(any(target_os = "windows", target_os = "macos", test))]
pub(super) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

#[cfg(target_os = "macos")]
pub(super) fn mac_mouse_button(value: &Value) -> Result<crate::protocol::MouseButton, ToolError> {
    use crate::protocol::MouseButton;
    if let Some(number) = value.as_f64() {
        return match number {
            0.0 => Ok(MouseButton::Left),
            1.0 => Ok(MouseButton::Right),
            2.0 => Ok(MouseButton::Middle),
            _ => Err(failed("mouseButton number must be 0, 1, or 2")),
        };
    }
    match value
        .as_str()
        .map(trim_js)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("l" | "left") => Ok(MouseButton::Left),
        Some("r" | "right") => Ok(MouseButton::Right),
        Some("m" | "middle") => Ok(MouseButton::Middle),
        _ => Err(failed(
            "mouseButton must be left, right, middle, l, r, m, 0, 1, or 2",
        )),
    }
}

#[cfg(any(target_os = "macos", test))]
pub(super) fn mac_direction(value: &Value) -> Result<crate::protocol::Direction, ToolError> {
    use crate::protocol::Direction;
    match value
        .as_str()
        .map(trim_js)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("u" | "up") => Ok(Direction::Up),
        Some("d" | "down") => Ok(Direction::Down),
        Some("l" | "left") => Ok(Direction::Left),
        Some("r" | "right") => Ok(Direction::Right),
        _ => Err(failed("direction must be up, down, left, or right")),
    }
}

/// Call only after the canonical Mac app subject has been approved and frozen.
#[cfg(any(target_os = "macos", test))]
pub(super) fn mac(method: Method, value: &Value) -> Result<Value, ToolError> {
    use Method::*;
    if matches!(method, ListApps) {
        return Ok(json!({}));
    }
    let mut result = object(value)?.clone();
    nonempty(
        result.get("app"),
        "Computer Use app approval requires a non-empty app",
    )?;
    match method {
        Click => {
            if !result.contains_key("click_count") {
                result.insert("click_count".into(), json!(1));
            }
            if !result.contains_key("mouse_button") {
                result.insert("mouse_button".into(), json!("left"));
            }
            if result.get("element_index").is_none_or(Value::is_null) {
                for axis in ["x", "y"] {
                    if result
                        .get(axis)
                        .and_then(Value::as_f64)
                        .is_none_or(|number| !number.is_finite())
                    {
                        return Err(failed("coordinate must include finite x and y coordinates"));
                    }
                }
            }
        }
        Drag => {
            for (prefix, fields) in [("from", ["from_x", "from_y"]), ("to", ["to_x", "to_y"])] {
                if fields.into_iter().any(|name| {
                    result
                        .get(name)
                        .and_then(Value::as_f64)
                        .is_none_or(|number| !number.is_finite())
                }) {
                    return Err(failed(format!(
                        "{prefix} must include finite x and y coordinates"
                    )));
                }
            }
        }
        Scroll => {
            let pages = result.get("pages").cloned().unwrap_or(json!(1));
            let pages = pages
                .as_f64()
                .filter(|number| number.is_finite() && *number > 0.0)
                .ok_or_else(|| failed("pages must be a finite number > 0"))?;
            result.insert("pages".into(), json!(pages));
            // The source validates direction after its coordinate/element
            // selector. Keep that ordering in raw_macos's typed Action build.
        }
        SelectText => {
            if !result.contains_key("selection_type") {
                result.insert("selection_type".into(), json!("text"));
            }
        }
        PressKey => {
            nonempty(result.get("key"), "key is required")?;
        }
        GetAppState | Paste | PerformSecondaryAction | SetValue | TypeText => {}
        _ => return Err(failed("native method is not installed for macOS")),
    }
    Ok(Value::Object(result))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_click_uses_nullish_element_precedence_and_point_before_count_errors() {
        let window = json!({"id":"0x10","app":" fixture ","title":"title","ignored":true});
        let value = windows(Method::Click, &json!({"window":window,"element_index":null,"elementIndex":"3","x":1.4,"click_count":1.5,"screenshotId":"discard-on-element"})).unwrap();
        assert_eq!(
            value,
            json!({"window":{"id":16,"app":" fixture ","title":"title"},"element_index":3,"click_count":2.0,"mouse_button":"left"})
        );
        let error = windows(
            Method::Click,
            &json!({"window":window,"x":1,"click_count":0}),
        )
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("requires either element_index or finite x and y")
        );
    }

    #[test]
    fn windows_rounding_keeps_the_below_half_case_and_negative_half() {
        let value = windows(Method::Scroll, &json!({"window":{"id":1,"app":"fixture"},"x":0.49999999999999994,"y":-0.5,"scrollX":-1.5,"scrollY":1.5})).unwrap();
        assert_eq!(value["x"], json!(0.0));
        assert_eq!(value["y"], json!(0.0));
        assert_eq!(value["scrollX"], json!(-1.0));
        assert_eq!(value["scrollY"], json!(2.0));
    }

    #[test]
    fn mac_pages_retain_double_bits_and_do_not_inherit_windows_rounding() {
        let value = mac(Method::Scroll, &json!({"app":"fixture","direction":" d ","pages":0.12345678901234569,"x":17.123456789012344,"y":5.123456789012345})).unwrap();
        assert_eq!(
            value["pages"].as_f64().unwrap().to_bits(),
            0x3fbf9add3746f660
        );
        assert_eq!(value["x"].as_f64().unwrap().to_bits(), 0x40311f9add3746f6);
        assert_eq!(value["y"].as_f64().unwrap().to_bits(), 0x40147e6b74dd1bd9);
        assert!(matches!(
            mac_direction(&value["direction"]).unwrap(),
            crate::protocol::Direction::Down
        ));
        assert!(
            mac(
                Method::Scroll,
                &json!({"app":"fixture","direction":"down","pages":null})
            )
            .is_err()
        );
    }
}
