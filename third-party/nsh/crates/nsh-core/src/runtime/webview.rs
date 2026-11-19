//! The functions of `nsh`'s `WebView` (`nsh-js` makes it the web view
//! element's component, as `Image`'s).

use crate::element::{JsError, Later, module};

/// A web page.
#[module]
pub(crate) struct WebView;

#[module]
impl WebView {
    /// Resolves with whether a web view's ref gives its page trusted input
    /// here (`sendInput`): the platform delivers it (macOS) and the app's
    /// capabilities grant `webview.input` (`"webview": { "input": true }`
    /// in nsh.json, also when it declares none). Where it resolves
    /// `false`, `sendInput` does nothing.
    pub(crate) fn input_available() -> Later<bool> {
        Later::new(async { Ok::<_, JsError>(crate::prelude::web_input_available().await) })
    }

    /// Resolves with whether a web view's ref runs scripts and resolves
    /// with their results here (`evaluate`): the platform has it and the
    /// app's capabilities grant `webview`. Where it resolves `false`,
    /// `evaluate` rejects with `code` `"ERR_FEATURE_UNAVAILABLE_ON_PLATFORM"`.
    pub(crate) fn evaluate_available() -> Later<bool> {
        Later::new(async { Ok::<_, JsError>(crate::prelude::web_evaluate_available().await) })
    }

    /// Resolves with whether a web view shows a page here: the platform
    /// shows web views and the app's capabilities grant `webview`. Where
    /// it resolves `false`, a web view shows no page and reports `onError`
    /// (`code` `"ERR_FEATURE_UNAVAILABLE_ON_PLATFORM"` where the platform
    /// shows none, `"ERR_ACCESS_DENIED"` where `webview` is not granted).
    /// A web engine that can fail only once a web view starts (Windows
    /// without the WebView2 runtime) resolves `true` here and reports the
    /// same `onError` on the web view.
    pub(crate) fn available() -> Later<bool> {
        Later::new(async { Ok::<_, JsError>(crate::prelude::web_view_available().await) })
    }
}
