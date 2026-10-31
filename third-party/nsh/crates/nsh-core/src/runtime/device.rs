//! `nsh/device`'s requests to the system: opening a URL outside the app
//! ([`crate::open_url`]). Needs the `openUrl` capability when the app
//! declares capabilities (else it rejects with `ERR_ACCESS_DENIED`).

use crate::element::{JsError, JsObject, Later, System, module};

/// What `openUrl` did.
#[derive(Debug, Clone, Copy, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub(crate) struct OpenUrlResult {
    /// Whether an app opened the URL (`false` when none handles it).
    pub(crate) opened: bool,
}

/// What the app asks of the system it runs on.
#[module]
pub(crate) struct Device;

#[module(flat)]
impl Device {
    /// Opens `url` outside the app: a web page in the browser, a `mailto:`
    /// link in the mail app, a `tel:` link in the phone app, any scheme
    /// another app registered. The embedding app may take it first and
    /// route it its own way. Resolves with `{ opened }`: whether it opened
    /// (`false` when no app handles it). Rejects with a `TypeError` for a
    /// URL it never opens (not absolute, `javascript:`, `data:`, `file:`,
    /// ...), and with `ERR_ACCESS_DENIED` when the `openUrl` capability
    /// does not grant its scheme.
    pub(crate) fn open_url(url: String, sys: System) -> Result<Later<OpenUrlResult>, JsError> {
        crate::open_url::check_url(&url).map_err(JsError::Type)?;
        if !sys.access.allows_open_url(&url) {
            return Err(crate::open_url::not_granted(&url));
        }
        Ok(Later::new(async move {
            Ok::<_, JsError>(OpenUrlResult {
                opened: crate::prelude::open_url(url).await,
            })
        }))
    }
}
