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
}
