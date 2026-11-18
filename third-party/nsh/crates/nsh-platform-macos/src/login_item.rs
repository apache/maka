//! The app's login item on macOS (`Application.loginItem()`,
//! [`nsh_core::desktop::LoginItemBackend`]): `SMAppService.mainApp`, the
//! app bundle's login item, which System Settings lists under Login Items.
//! The system keeps it for the bundle's id: every copy of the app reads and
//! changes the same one. Only [`crate::run_app`] with
//! [`crate::AppOptions::login_item`] gives the core this backend.
//!
//! ServiceManagement is loaded when first used, not linked, as the
//! UserNotifications framework is. Its calls run on the core's login item
//! thread: they work off the main thread. What macOS 27 answers (checked
//! with an ad hoc signed bundle): a bundle never registered is `notFound`,
//! read as disabled (registering it works), and registering what is
//! registered and unregistering what is not are no errors.
//! `requiresApproval` is a registration that waits for the user in System
//! Settings' Login Items (`SMAppService.h`: also once the user revokes their
//! consent).
//!
//! A call that fails is judged by the status it leaves, as a code alone
//! does not say which error it is (ServiceManagement declares four error
//! domains, and an `NSError` may come from another still). A registration
//! that leaves the item registered, also waiting for the user's approval,
//! is done: that covers the errors `SMAppService.h` names for it,
//! `kSMErrorAlreadyRegistered` and `kSMErrorLaunchDeniedByUser` (a service
//! the user has not approved). A removal is done when it leaves the item
//! `notRegistered`, or `notFound`, an error status, with the error the
//! header names for a service unregistered already, `kSMErrorJobNotFound`
//! in `SMAppServiceErrorDomain`: reporting a removal that did not happen
//! would show the setting off while the app still opens at login. The rest
//! fail, `SMAppServiceErrorDomain`'s refusals as `PermissionDenied`: of the
//! signature, of authorization, of the user, and its "Operation not
//! permitted", code 1, which `SMErrors.h` does not list. The error's message
//! names its domain and code, and a refused call is logged as a warning with
//! the status after it.

use std::{io, sync::OnceLock};

use nsh_core::desktop::{LoginItemBackend, LoginItemStatus};
use objc2::{
    msg_send,
    rc::{Retained, autoreleasepool},
    runtime::{AnyClass, AnyObject},
};
use objc2_foundation::NSError;

/// `SMAppServiceStatus`'s values (`SMAppService.h`).
const NOT_REGISTERED: isize = 0;
const ENABLED: isize = 1;
const REQUIRES_APPROVAL: isize = 2;
const NOT_FOUND: isize = 3;

/// The domain of `SMAppService`'s errors, `SMAppServiceErrorDomain`
/// (exported from macOS 15, so compared by its value).
const APP_SERVICE_ERRORS: &str = "SMAppServiceErrorDomain";

/// `SMAppServiceErrorDomain`'s "Operation not permitted", as POSIX's
/// `EPERM`, which `SMErrors.h` does not list: what macOS 14.2.1 answers
/// when Background Task Management refuses a registration
/// (<https://developer.apple.com/forums/thread/743395>).
const NOT_PERMITTED: isize = 1;

/// ServiceManagement's error codes (`SMErrors.h`): what the system or the
/// user does not permit, and a service unregistered already.
const INVALID_SIGNATURE: isize = 3;
const AUTHORIZATION_FAILURE: isize = 4;
const JOB_NOT_FOUND: isize = 6;
const LAUNCH_DENIED_BY_USER: isize = 11;

/// The app bundle's login item.
pub(crate) struct LoginItem;

// Each call drains what it autoreleased (the errors, their descriptions):
// the core's login item thread lives as long as the app and has no run
// loop to drain a pool.
impl LoginItemBackend for LoginItem {
    fn status(&self) -> io::Result<LoginItemStatus> {
        autoreleasepool(|_| {
            let service = main_app()?;
            // SAFETY: `SMAppService`'s documented `status` property.
            let status: isize = unsafe { msg_send![&*service, status] };
            Ok(status_of(status))
        })
    }

    fn set(&self, enabled: bool) -> io::Result<LoginItemStatus> {
        autoreleasepool(|_| {
            let service = main_app()?;
            // SAFETY: `SMAppService`'s documented methods (macOS 13), which
            // return `NO` and set the error when they fail.
            let done: Result<(), Retained<NSError>> = unsafe {
                if enabled {
                    msg_send![&*service, registerAndReturnError: _]
                } else {
                    msg_send![&*service, unregisterAndReturnError: _]
                }
            };
            // SAFETY: `SMAppService`'s documented `status` property.
            let status: isize = unsafe { msg_send![&*service, status] };
            let Err(error) = done else {
                return Ok(status_of(status));
            };
            let (domain, code) = (error.domain().to_string(), error.code());
            let message = error.localizedDescription().to_string();
            let settled = settled(enabled, status, &domain, code, &message);
            let call = if enabled { "register" } else { "unregister" };
            match &settled {
                Ok(_) => log::info!(
                    "SMAppService {call} failed ({domain} {code}) with the item {} after it: done",
                    status_name(status)
                ),
                Err(_) => log::warn!(
                    "SMAppService {call} failed ({domain} {code}) with the item {} after it: \
                     {message}",
                    status_name(status)
                ),
            }
            settled
        })
    }
}

/// The app's status for `SMAppServiceStatus` `status`: `notRegistered`,
/// `notFound` (a bundle never registered) and values a newer macOS adds are
/// disabled.
fn status_of(status: isize) -> LoginItemStatus {
    match status {
        ENABLED => LoginItemStatus::Enabled,
        REQUIRES_APPROVAL => LoginItemStatus::RequiresApproval,
        _ => LoginItemStatus::Disabled,
    }
}

/// `SMAppServiceStatus` `status` as the header names it, for the log.
fn status_name(status: isize) -> &'static str {
    match status {
        NOT_REGISTERED => "notRegistered",
        ENABLED => "enabled",
        REQUIRES_APPROVAL => "requiresApproval",
        NOT_FOUND => "notFound",
        _ => "of a status not known",
    }
}

/// What a registration (`enabled`) or its removal that failed with the
/// error `code` of `domain` comes to, by the `SMAppServiceStatus` `status`
/// it left: done when that is what was asked (registered, also while it
/// waits for the user's approval; or not registered, `notFound` only with
/// the error of a service unregistered already). Else the error: what
/// ServiceManagement does not permit is `PermissionDenied` (`EACCES`).
fn settled(
    enabled: bool,
    status: isize,
    domain: &str,
    code: isize,
    message: &str,
) -> io::Result<LoginItemStatus> {
    let app_service = domain == APP_SERVICE_ERRORS;
    let done = if enabled {
        matches!(status, ENABLED | REQUIRES_APPROVAL)
    } else {
        status == NOT_REGISTERED || (status == NOT_FOUND && app_service && code == JOB_NOT_FOUND)
    };
    if done {
        return Ok(status_of(status));
    }
    let kind = match code {
        NOT_PERMITTED | INVALID_SIGNATURE | AUTHORIZATION_FAILURE | LAUNCH_DENIED_BY_USER
            if app_service =>
        {
            io::ErrorKind::PermissionDenied
        }
        _ => io::ErrorKind::Other,
    };
    Err(io::Error::new(
        kind,
        format!("{message} ({domain} error {code})"),
    ))
}

/// `SMAppService.mainApp`, ServiceManagement loaded first.
fn main_app() -> io::Result<Retained<AnyObject>> {
    let unsupported = || io::Error::new(io::ErrorKind::Unsupported, "no SMAppService");
    if !framework() {
        return Err(unsupported());
    }
    let class = AnyClass::get(c"SMAppService").ok_or_else(unsupported)?;
    // SAFETY: the documented class property (macOS 13), never nil.
    let service: Option<Retained<AnyObject>> = unsafe { msg_send![class, mainAppService] };
    service.ok_or_else(unsupported)
}

/// Whether ServiceManagement is loaded (it is not linked).
fn framework() -> bool {
    static LOADED: OnceLock<bool> = OnceLock::new();
    *LOADED.get_or_init(|| {
        let path = c"/System/Library/Frameworks/ServiceManagement.framework/ServiceManagement";
        // SAFETY: loads a system framework; the handle is never closed.
        let loaded = !unsafe { libc::dlopen(path.as_ptr(), libc::RTLD_LAZY) }.is_null();
        if !loaded {
            log::error!("cannot load {}", path.to_string_lossy());
        }
        loaded
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_map_and_a_bundle_never_registered_is_disabled() {
        assert_eq!(status_of(0), LoginItemStatus::Disabled);
        assert_eq!(status_of(ENABLED), LoginItemStatus::Enabled);
        assert_eq!(
            status_of(REQUIRES_APPROVAL),
            LoginItemStatus::RequiresApproval
        );
        // `notFound`, and what a newer macOS may add.
        assert_eq!(status_of(3), LoginItemStatus::Disabled);
        assert_eq!(status_of(9), LoginItemStatus::Disabled);
    }

    /// `SMErrors.h`'s `kSMErrorInternalFailure` and `kSMErrorAlreadyRegistered`.
    const INTERNAL_FAILURE: isize = 2;
    const ALREADY_REGISTERED: isize = 12;

    #[test]
    fn a_failed_call_is_done_when_the_status_is_what_it_asked() {
        use LoginItemStatus::{Disabled, Enabled, RequiresApproval};
        use io::ErrorKind::{Other, PermissionDenied};
        const SM: &str = APP_SERVICE_ERRORS;
        const POSIX: &str = "NSPOSIXErrorDomain";
        let kind = |result: io::Result<LoginItemStatus>| result.unwrap_err().kind();
        // Already so.
        assert_eq!(
            settled(true, ENABLED, SM, ALREADY_REGISTERED, "").unwrap(),
            Enabled
        );
        assert_eq!(
            settled(false, NOT_REGISTERED, SM, JOB_NOT_FOUND, "").unwrap(),
            Disabled
        );
        assert_eq!(
            settled(false, NOT_FOUND, SM, JOB_NOT_FOUND, "").unwrap(),
            Disabled
        );
        // `notFound` is an error status: another error, or the code in
        // another domain, is no removal.
        assert_eq!(
            kind(settled(false, NOT_FOUND, SM, INTERNAL_FAILURE, "")),
            Other
        );
        assert_eq!(
            kind(settled(false, NOT_FOUND, POSIX, JOB_NOT_FOUND, "")),
            Other
        );
        // A status not known is no removal either, while `notRegistered`
        // is, whatever the error.
        assert_eq!(kind(settled(false, 9, SM, JOB_NOT_FOUND, "")), Other);
        assert_eq!(
            settled(false, NOT_REGISTERED, POSIX, 1, "").unwrap(),
            Disabled
        );
        // The user turned the item off in System Settings: it waits for
        // them, as the Windows backend answers.
        assert_eq!(
            settled(true, REQUIRES_APPROVAL, SM, LAUNCH_DENIED_BY_USER, "").unwrap(),
            RequiresApproval
        );
        // The rest fail: what ServiceManagement does not permit as such,
        // its domain and code in the message.
        let error = settled(true, NOT_REGISTERED, SM, INVALID_SIGNATURE, "not signed").unwrap_err();
        assert_eq!(error.kind(), PermissionDenied);
        assert!(
            error
                .to_string()
                .contains("not signed (SMAppServiceErrorDomain error 3)"),
            "{error}"
        );
        assert_eq!(
            kind(settled(true, NOT_FOUND, SM, LAUNCH_DENIED_BY_USER, "")),
            PermissionDenied
        );
        assert_eq!(
            kind(settled(true, NOT_REGISTERED, SM, NOT_PERMITTED, "")),
            PermissionDenied
        );
        // Only in `SMAppService`'s domain: the codes mean other things in
        // others.
        assert_eq!(
            kind(settled(
                true,
                NOT_REGISTERED,
                POSIX,
                AUTHORIZATION_FAILURE,
                ""
            )),
            Other
        );
        assert_eq!(
            kind(settled(true, NOT_REGISTERED, POSIX, NOT_PERMITTED, "")),
            Other
        );
        assert_eq!(
            kind(settled(false, ENABLED, SM, ALREADY_REGISTERED, "")),
            Other
        );
        assert_eq!(
            kind(settled(false, REQUIRES_APPROVAL, SM, INTERNAL_FAILURE, "")),
            Other
        );
    }
}
