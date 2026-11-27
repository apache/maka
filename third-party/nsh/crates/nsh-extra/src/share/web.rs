//! The share sheet on the web: the browser's `navigator.share`, reached
//! through wasm-bindgen. A page has no local files to share, and a browser
//! that cannot share this content says so: both fail as unavailable, never
//! as shared. The user closing the sheet rejects with an `AbortError`:
//! dismissed. The browser shows one sheet at a time and keeps it until the
//! user closes it, so a share while one shows fails as unavailable.
//!
//! The part that needs no browser (what its errors mean) builds on every
//! target, for the module's tests.

use super::{ShareError, ShareOutcome};

/// What a rejection of `navigator.share` named `name` (a `DOMException`'s
/// name) with `message` means to the app.
pub(super) fn rejected(name: &str, message: &str) -> Result<ShareOutcome, ShareError> {
    match name {
        "AbortError" => Ok(ShareOutcome::dismissed()),
        // The browser refuses the sheet here: the page's permissions policy
        // (a frame without `web-share`) or a share without a user gesture.
        "NotAllowedError" => Err(ShareError::unavailable(format!(
            "share: the browser does not allow sharing here ({message})"
        ))),
        // An earlier share's sheet is still open.
        "InvalidStateError" => Err(ShareError::unavailable(format!(
            "share: the browser still shows an earlier share ({message})"
        ))),
        _ => Err(ShareError::failed(format!("share: {message}"))),
    }
}

#[cfg(target_arch = "wasm32")]
pub(super) use self::browser::{available, show};

#[cfg(target_arch = "wasm32")]
mod browser {
    use wasm_bindgen::{JsCast, JsValue, closure::Closure};

    use super::{
        super::{Reply, ShareError, ShareOutcome, ShareSheet},
        rejected,
    };

    fn get(target: &JsValue, key: &str) -> JsValue {
        js_sys::Reflect::get(target, &JsValue::from_str(key)).unwrap_or(JsValue::UNDEFINED)
    }

    /// The global's `navigator`, a window's or a worker's.
    fn navigator() -> Option<JsValue> {
        Some(get(&js_sys::global(), "navigator")).filter(JsValue::is_object)
    }

    /// `target.name(args...)`, when it is a function.
    fn call(target: &JsValue, name: &str, args: &[&JsValue]) -> Option<Result<JsValue, JsValue>> {
        let function = get(target, name).dyn_into::<js_sys::Function>().ok()?;
        let args: js_sys::Array = args.iter().copied().collect();
        Some(function.apply(target, &args))
    }

    /// `{ title, text, url }` with what is given.
    fn data(title: Option<&str>, text: Option<&str>, url: Option<&str>) -> JsValue {
        let data = js_sys::Object::new();
        for (key, value) in [("title", title), ("text", text), ("url", url)] {
            if let Some(value) = value {
                let _ =
                    js_sys::Reflect::set(&data, &JsValue::from_str(key), &JsValue::from_str(value));
            }
        }
        data.into()
    }

    /// Whether the page can show the browser's share sheet: it has
    /// `navigator.share` and the document may use `web-share` (a frame of
    /// another origin needs `allow="web-share"`, and
    /// `Permissions-Policy: web-share=()` turns it off).
    ///
    /// Web Share makes `navigator.canShare(data)` return `false` when the
    /// document may not use `web-share`, so that is the probe: it never
    /// names the policy, so browsers whose Permissions Policy has no
    /// `web-share` entry log nothing. `canShare` is newer than `share`;
    /// browsers with only `share` fall back to the Permissions Policy API,
    /// asking `features()` before `allowsFeature()` (which logs for a name
    /// the browser does not list, where it does not gate sharing either).
    fn allowed(navigator: &JsValue) -> bool {
        if !get(navigator, "share").is_function() {
            return false;
        }
        if let Some(can) = call(navigator, "canShare", &[&data(None, Some("share"), None)]) {
            return can.is_ok_and(|can| can.is_truthy());
        }
        let document = get(&js_sys::global(), "document");
        if !document.is_object() {
            return true;
        }
        let mut policy = get(&document, "permissionsPolicy");
        if !policy.is_object() {
            policy = get(&document, "featurePolicy");
        }
        if !get(&policy, "allowsFeature").is_function() {
            return true;
        }
        let web_share = JsValue::from_str("web-share");
        if let Some(Ok(features)) = call(&policy, "features", &[])
            && let Ok(features) = features.dyn_into::<js_sys::Array>()
            && !features.includes(&web_share, 0)
        {
            return true;
        }
        call(&policy, "allowsFeature", &[&web_share])
            .is_some_and(|allowed| allowed.is_ok_and(|allowed| allowed.is_truthy()))
    }

    pub(in super::super) async fn available() -> bool {
        navigator().is_some_and(|navigator| allowed(&navigator))
    }

    pub(in super::super) async fn show(sheet: ShareSheet, reply: Reply) {
        let unavailable = |message: &str| {
            reply.send(Err(ShareError::unavailable(message)));
        };
        if !sheet.files.is_empty() {
            return unavailable("share: a page shares no local files");
        }
        let Some(navigator) = navigator().filter(allowed) else {
            return unavailable("share: this browser has no share sheet for this page");
        };
        let data = data(
            sheet.title.as_deref(),
            sheet.text.as_deref(),
            sheet.url.as_deref(),
        );
        if let Some(can) = call(&navigator, "canShare", &[&data])
            && !can.is_ok_and(|can| can.is_truthy())
        {
            return unavailable("share: this browser cannot share this content");
        }
        let promise = match call(&navigator, "share", &[&data]) {
            Some(Ok(promise)) => promise,
            Some(Err(error)) => return answer_error(&reply, &error),
            None => return unavailable("share: this browser has no share sheet for this page"),
        };
        let Ok(promise) = promise.dyn_into::<js_sys::Promise>() else {
            reply.send(Ok(ShareOutcome::shared(None)));
            return;
        };
        // The callbacks live until the browser settles the share.
        let (settled, done) = tokio::sync::oneshot::channel::<()>();
        let settled = std::rc::Rc::new(std::cell::RefCell::new(Some(settled)));
        let shared = {
            let (reply, settled) = (reply.clone(), settled.clone());
            Closure::once(move |_: JsValue| {
                reply.send(Ok(ShareOutcome::shared(None)));
                if let Some(settled) = settled.borrow_mut().take() {
                    let _ = settled.send(());
                }
            })
        };
        let failed = {
            let reply = reply.clone();
            Closure::once(move |error: JsValue| {
                answer_error(&reply, &error);
                if let Some(settled) = settled.borrow_mut().take() {
                    let _ = settled.send(());
                }
            })
        };
        let _ = promise.then2(&shared, &failed);
        let _ = done.await;
        drop((shared, failed));
    }

    /// Answers `reply` with what the browser's `error` means.
    fn answer_error(reply: &Reply, error: &JsValue) {
        let name = get(error, "name").as_string().unwrap_or_default();
        let message = get(error, "message")
            .as_string()
            .or_else(|| error.as_string())
            .unwrap_or_else(|| format!("{error:?}"));
        reply.send(rejected(&name, &message));
    }
}
