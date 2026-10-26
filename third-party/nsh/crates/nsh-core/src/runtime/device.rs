//! `nsh/device`'s requests to the system: opening a URL outside the app
//! ([`crate::open_url`]). Needs the `openUrl` capability when the app
//! declares capabilities.

use crate::ui::{JsError, Later, System, module};

/// What the app asks of the system it runs on.
#[module]
pub(crate) struct Device;

#[module(flat)]
impl Device {
    /// Opens `url` outside the app: a web page in the browser, a `mailto:`
    /// link in the mail app, a `tel:` link in the phone app, any scheme
    /// another app registered. The embedding app may take it first and
    /// route it its own way. Resolves to whether it opened (`false` when no
    /// app handles it). Throws a `TypeError` for a URL it never opens (not
    /// absolute, `javascript:`, `data:`, `file:`, ...) and when the
    /// `openUrl` capability does not grant its scheme.
    pub(crate) fn open_url(url: String, sys: System) -> Result<Later<bool>, JsError> {
        crate::open_url::check_url(&url).map_err(JsError::Type)?;
        if !sys.access.allows_open_url(&url) {
            return Err(JsError::Type(crate::open_url::not_granted(&url)));
        }
        Ok(Later::new(async move {
            Ok::<bool, JsError>(crate::ui::prelude::open_url(url).await)
        }))
    }
}
