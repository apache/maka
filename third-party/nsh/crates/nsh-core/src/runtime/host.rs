//! `nsh/host`: functions of the app embedding NSH, called by name with a
//! JSON argument and answered by the platform ([`crate::Command::HostCall`],
//! [`crate::EventKind::Host`] `{ type: "reply" }`). A call needs a valid
//! name (`crate::access::valid_host_name`; else a `TypeError`), granted by
//! the `host` capability, also when the app declares no capabilities
//! (else `ERR_ACCESS_DENIED`); platforms whose environment has no host
//! ([`crate::platform::Environment::host`]) reject every call
//! (`ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`). A call the host does not answer
//! in time rejects (`ETIMEDOUT`, [`DEFAULT_TIMEOUT`]); its answer, when it
//! comes, is dropped. The host's own error rejects with its message
//! (`ERR_NSH_HOST_ERROR`); every side builds these errors with
//! [`crate::host_channel`]'s functions. The host's events and
//! `available()` are `nsh-js`'s (`platform_modules.rs`): its listeners are
//! JS functions.

use std::{future::Future, task::Poll, time::Duration};

use crate::{
    JsonValue,
    element::{JsError, JsObject, module},
    host_channel::timed_out,
};

/// How long a call waits for the host's answer unless its options say.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

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
/// functions (granted by `capabilities.host` in nsh.json).
#[module]
pub(crate) struct Host;

#[module(name = "host")]
impl Host {
    /// Calls the host's function `name` with `args`: what it returns, or a
    /// rejection with its error (`code` `ERR_NSH_HOST_ERROR`), or once
    /// `options.timeout` passed (`ETIMEDOUT`). A name `capabilities.host`
    /// does not grant rejects with `ERR_ACCESS_DENIED`, any call on a
    /// platform without a host with `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`.
    pub(crate) async fn call(
        name: String,
        args: Option<JsonValue>,
        options: Option<HostCallOptions>,
    ) -> Result<JsonValue, JsError> {
        // A timeout past what a `Duration` or the clock holds waits as 0.
        let deadline = match options.and_then(|o| o.timeout) {
            Some(ms) if !ms.is_finite() || ms < 0.0 => {
                return Err(JsError::Range(format!("nsh/host: invalid timeout {ms}")));
            }
            Some(0.0) => None,
            Some(ms) => Duration::try_from_secs_f64(ms / 1000.0)
                .ok()
                .and_then(|t| Some((t, crate::time::now().checked_add(t)?))),
            None => Some((DEFAULT_TIMEOUT, crate::time::now() + DEFAULT_TIMEOUT)),
        };
        let answer = crate::element::host_call(name.clone(), args.unwrap_or_default());
        let Some((timeout, at)) = deadline else {
            return answer.await;
        };
        // On the app's clock, as its timers: a manual clock moves it.
        let answered = {
            let mut answer = std::pin::pin!(answer);
            let mut delay = std::pin::pin!(crate::element::timer_until(at));
            std::future::poll_fn(|cx| {
                if let Poll::Ready(result) = answer.as_mut().poll(cx) {
                    return Poll::Ready(Some(result));
                }
                if delay.as_mut().poll(cx).is_ready() {
                    return Poll::Ready(None);
                }
                Poll::Pending
            })
            .await
        };
        answered.unwrap_or_else(|| {
            // The answer went with the block: the core drops its slot now,
            // and a late reply finds none (`Core::answer_host`).
            crate::element::forget_host_calls();
            Err(timed_out(&name, timeout))
        })
    }
}
