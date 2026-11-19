//! The platforms' part of a WebView's `evaluate` (TS `ref.evaluate`,
//! [`crate::element::ElementRef::evaluate`]): the page script that runs an
//! app's script and reports its result as a JSON envelope
//! (`{ status: "ok", value }`, `{ status: "error", code, message }` or
//! `{ status: "pending" }` while a returned Promise settles), and the
//! scripts that read and release a pending one. The page's result is
//! untrusted JSON, separate from its message channel; the core decodes
//! it again ([`crate::Command::Evaluate`]).

use crate::{
    JsonValue,
    element::{Evaluation, JsError, codes, task::AnswerSlot},
};

/// Maximum UTF-8 bytes in a serialized evaluation result (1 MiB); the
/// platforms check a reply's size against it before decoding it.
pub const MAX_RESULT_BYTES: usize = 1_048_576;
/// Maximum evaluations waiting in one engine.
pub(crate) const MAX_PENDING: usize = 64;

pub(crate) fn error(code: &str, message: &str) -> JsError {
    JsError::Error(message.into()).with_code(code)
}

pub(crate) type Slot = AnswerSlot<Result<Evaluation, JsError>>;

/// Decodes a final native reply. Size checks are repeated in Rust: a page
/// can replace its own globals and every result from it remains untrusted.
pub(crate) fn decode(data: &str) -> Result<Evaluation, JsError> {
    let invalid = || {
        error(
            codes::WEBVIEW_SCRIPT,
            "the WebView returned an invalid result",
        )
    };
    if data.len() > MAX_RESULT_BYTES + 1024 {
        return Err(error(
            codes::QUOTA_EXCEEDED,
            "the WebView result exceeds 1 MiB",
        ));
    }
    let envelope: JsonValue = serde_json::from_str(data).map_err(|_| invalid())?;
    match envelope["status"].as_str() {
        Some("ok") => {
            let value = envelope.get("value").ok_or_else(invalid)?;
            fn bounded(value: &JsonValue, depth: usize) -> bool {
                depth <= 64
                    && match value {
                        JsonValue::Array(values) => values.iter().all(|v| bounded(v, depth + 1)),
                        JsonValue::Object(values) => values.values().all(|v| bounded(v, depth + 1)),
                        _ => true,
                    }
            }
            if !bounded(value, 0) {
                return Err(invalid());
            }
            Ok(Evaluation {
                value: value.clone(),
            })
        }
        Some("error") => {
            let code = envelope["code"].as_str().ok_or_else(invalid)?;
            if !matches!(
                code,
                codes::WEBVIEW_SCRIPT
                    | codes::WEBVIEW_ABORTED
                    | codes::QUOTA_EXCEEDED
                    | codes::TIMED_OUT
            ) {
                return Err(invalid());
            }
            Err(error(
                code,
                envelope["message"]
                    .as_str()
                    .unwrap_or("WebView evaluation failed"),
            ))
        }
        _ => Err(invalid()),
    }
}

/// The page script that evaluates `script` and returns its JSON envelope
/// (a string). A returned Promise answers `pending` and keeps its envelope
/// in the page under `key`, unique per request, for [`poll_script`].
pub fn start_script(script: &str, key: &str) -> String {
    include_str!("web_evaluation.js")
        .replace("__NSH_KEY__", &serde_json::to_string(key).expect("string"))
        .replace(
            "__NSH_SOURCE__",
            &serde_json::to_string(script).expect("string"),
        )
}

/// The page script that returns the envelope kept under `key`: `pending`
/// until the Promise settles, then its result, released from the page.
pub fn poll_script(key: &str) -> String {
    let key = serde_json::to_string(key).expect("string");
    format!(
        r#"(() => {{ const key = {key}; const cell = globalThis[key]; if (!cell) return JSON.stringify({{status:"error",code:"ERR_NSH_WEBVIEW_SCRIPT",message:"evaluation context was lost"}}); if (cell.result === null) return '{{"status":"pending"}}'; delete globalThis[key]; return cell.result; }})()"#
    )
}

/// The page script that releases what `key` keeps, for a cancelled request.
pub fn cleanup_script(key: &str) -> String {
    format!(
        "delete globalThis[{}]",
        serde_json::to_string(key).expect("string")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replies_preserve_json_and_distinguish_null_from_failure() {
        for value in [
            serde_json::json!(null),
            serde_json::json!([1, true, {"x":"\n日本語"}]),
            serde_json::json!(42),
        ] {
            let reply = serde_json::json!({"status":"ok", "value":value});
            assert_eq!(decode(&reply.to_string()).unwrap().value, value);
        }
        assert_eq!(
            decode(r#"{"status":"error","code":"ERR_NSH_WEBVIEW_SCRIPT","message":"boom"}"#)
                .unwrap_err()
                .code(),
            Some("ERR_NSH_WEBVIEW_SCRIPT")
        );
        for bad in [
            "null",
            "{}",
            r#"{"status":"ok"}"#,
            r#"{"status":"pending"}"#,
        ] {
            assert_eq!(
                decode(bad).unwrap_err().code(),
                Some("ERR_NSH_WEBVIEW_SCRIPT")
            );
        }
    }
    #[test]
    fn oversized_native_replies_are_rejected() {
        assert_eq!(
            decode(&"x".repeat(MAX_RESULT_BYTES + 1025))
                .unwrap_err()
                .code(),
            Some("ERR_NSH_QUOTA_EXCEEDED")
        );
    }
    #[test]
    fn page_supplied_replies_cannot_bypass_the_nesting_limit() {
        let nested = format!("{}0{}", "[".repeat(65), "]".repeat(65));
        let reply = format!(r#"{{"status":"ok","value":{nested}}}"#);
        assert_eq!(
            decode(&reply).unwrap_err().code(),
            Some("ERR_NSH_WEBVIEW_SCRIPT")
        );
    }
}
