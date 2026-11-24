//! `nsh/host`: functions of the app embedding NSH, called by name with a
//! JSON argument. JS's calls and posts go through Rust's
//! ([`crate::element::host_call_with`], [`crate::element::host_post`]):
//! the core checks them and the engine hands them to the embedding app's
//! channel where it is configured, else to the platform
//! ([`crate::Command::HostCall`], [`crate::EventKind::Host`]
//! `{ type: "reply" }`). A call needs a valid
//! name (`crate::access::valid_host_name`; else a `TypeError`), granted by
//! the `host` capability, also when the app declares no capabilities
//! (else `ERR_ACCESS_DENIED`); both are checked before where the call goes,
//! so where nothing hosts the app (no configured channel, and no host in
//! the platform's environment, [`crate::platform::Environment::host`]) only
//! a granted call rejects with `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`. A
//! refused call is logged as a denial. A call the host does not answer
//! in time rejects (`ETIMEDOUT`,
//! [`crate::host_channel::DEFAULT_CALL_TIMEOUT`]); its answer, when it
//! comes, is dropped. The host's own error rejects with its message
//! (`ERR_NSH_HOST_ERROR`); every side builds these errors with
//! [`crate::host_channel`]'s functions. A post
//! ([`crate::Command::HostPost`]) has no answer: a wrong or refused name
//! throws at once, and without a host it is dropped (`nsh-js` and the
//! browser's `host.js` call it only where the environment has one, and
//! only without a native SDK channel). The host's events and
//! `available()` are `nsh-js`'s (`platform_modules.rs`): its listeners are
//! JS functions.

use std::time::Duration;

use crate::{
    JsonValue,
    element::{CallCx, JsError, JsObject, System, module},
};

/// `host.call`'s options.
#[derive(Debug, Clone, Default, JsObject)]
pub(crate) struct HostCallOptions {
    /// How long the call waits for the host's answer, in milliseconds,
    /// before it rejects (`ETIMEDOUT`): 30000 unless set; 0, or one so
    /// large the clock never gets there, waits as long as the host takes; a
    /// negative or non-finite one rejects the call (a `RangeError`).
    timeout: Option<f64>,
}

/// The app embedding NSH: `host.call(name, args)` calls one of its
/// functions and `host.post(name, args)` hands it data (granted by
/// `capabilities.host` in nsh.json).
#[module]
pub(crate) struct Host;

#[module(name = "host")]
impl Host {
    /// Calls the host's function `name` with `args`: what it returns, or a
    /// rejection with its error (`code` `ERR_NSH_HOST_ERROR`), or once
    /// `options.timeout` passed (`ETIMEDOUT`). A name that is not valid
    /// rejects with a `TypeError`, then one `capabilities.host` does not
    /// grant with `ERR_ACCESS_DENIED`, then a call where nothing hosts the
    /// app with `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`.
    pub(crate) async fn call(
        name: String,
        args: Option<JsonValue>,
        options: Option<HostCallOptions>,
    ) -> Result<JsonValue, JsError> {
        // A timeout past what a `Duration` or the clock holds waits as 0.
        let timeout = match options.and_then(|o| o.timeout) {
            Some(ms) if !ms.is_finite() || ms < 0.0 => {
                return Err(JsError::Range(format!("nsh/host: invalid timeout {ms}")));
            }
            Some(ms) => Duration::try_from_secs_f64(ms / 1000.0).unwrap_or(Duration::ZERO),
            None => crate::host_channel::DEFAULT_CALL_TIMEOUT,
        };
        let options = crate::host_channel::HostCallOptions::default().timeout(timeout);
        crate::element::host_call_with(name, args.unwrap_or_default(), options)
            .await
            .map_err(JsError::from)
    }

    /// Hands `args` to the host's function `name`, without an answer, where
    /// the platform has a host (elsewhere the post is dropped): a wrong name
    /// throws a `TypeError`, one `capabilities.host` does not grant
    /// `ERR_ACCESS_DENIED`.
    pub(crate) fn post(
        name: String,
        args: Option<JsonValue>,
        sys: System,
        cx: CallCx,
    ) -> Result<(), JsError> {
        crate::host_channel::check_call(&sys.access, &name)?;
        let args = args.unwrap_or_default();
        cx.start(async move { crate::element::host_post(name, args) });
        Ok(())
    }
}
