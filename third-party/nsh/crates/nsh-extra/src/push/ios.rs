//! Remote notifications on iOS. The module observes the standalone app's
//! delegate (`nsh_platform_ios::on_application_event`), set up in the
//! crate's `#[native_module]` entry on the main thread before the app
//! launches: its launch, the registrations `registerForRemoteNotifications`
//! asks for and the background deliveries. Once the app launches it is the
//! handler of the notifications NSH did not show (`set_foreign_handler`),
//! which decides how they show in front and hears their presses; the core
//! keeps a press that came before (the one that launched the app) for it.
//! An app that embeds NSH in its own UIKit app never reports the launch,
//! so there the module takes nothing over. Mac Catalyst has none: NSH
//! packages no Catalyst apps, and its development host is not entitled to
//! them.

use std::{cell::Cell, sync::Mutex};

use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchTime};
use nsh_core::prelude::*;
use nsh_platform_apple::notifications::{
    ForeignNotification, ForeignNotificationHandler, Presentation, set_foreign_handler,
};
use nsh_platform_ios::{ApplicationEvent, FetchCompletion, FetchResult};
use objc2::{
    MainThreadMarker, msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject},
};
use objc2_foundation::{NSArray, NSBundle, NSDictionary, NSString};
use objc2_ui_kit::UIApplication;
use tokio::sync::oneshot;

use super::{
    BACKGROUND_WAIT, BackgroundCompletion, BackgroundResult, DeviceToken, PushError,
    RemoteNotification,
};

// The notification center (`UNUserNotificationCenter`).
#[link(name = "UserNotifications", kind = "framework")]
unsafe extern "C" {}

/// The key of `userInfo` NSH marks the notifications `Notifications`
/// shows with (`nsh-platform-apple`'s `notifications.rs`): `closeThread`
/// leaves those to `Notifications`.
const NSH_MARKER: &str = "nsh";

/// Why [`super::register`] fails without a push service's binding where
/// the module does not observe the app.
pub(super) const UNAVAILABLE: &str = "remote notifications need a standalone iOS app";

thread_local! {
    /// The module observes the app ([`install`]).
    static INSTALLED: Cell<bool> = const { Cell::new(false) };
}

/// Observes the app's delegate, once. On the main thread, before the app
/// launches: the crate's `#[native_module]` entry, which may run again
/// later (its `registry()`), maybe off the main thread.
pub(super) fn install(_: &mut Registry) {
    if cfg!(target_abi = "macabi") || MainThreadMarker::new().is_none() {
        return;
    }
    if INSTALLED.replace(true) {
        return;
    }
    nsh_platform_ios::on_application_event(observe);
}

/// What the app's delegate heard. Main thread.
fn observe(event: &ApplicationEvent<'_>) {
    match event {
        ApplicationEvent::Launched { .. } => {
            super::launched();
            set_foreign_handler(Foreign);
        }
        ApplicationEvent::RegisteredForRemoteNotifications { device_token, .. } => {
            super::registered(DeviceToken::from_bytes(*device_token));
        }
        ApplicationEvent::FailedToRegisterForRemoteNotifications { error, .. } => {
            super::registration_failed(error);
        }
        ApplicationEvent::RemoteNotification {
            user_info,
            completion,
            ..
        } => {
            let fetch = FetchCompletion::clone(completion);
            let completion = BackgroundCompletion::new(move |result| {
                fetch.set_result(match result {
                    BackgroundResult::NewData => FetchResult::NewData,
                    BackgroundResult::Failed => FetchResult::Failed,
                    _ => FetchResult::NoData,
                });
            });
            super::background(
                RemoteNotification::background(user_info.to_json()),
                completion,
            );
            expire_later();
        }
        _ => {}
    }
}

/// Completes the deliveries that wait for a JS listener once their wait
/// is over, on the main thread. The wait counts from the arrival however
/// often a delivery waits, so one check covers it.
pub(super) fn expire_later() {
    let wait = BACKGROUND_WAIT + std::time::Duration::from_millis(100);
    let at = DispatchTime::NOW.time(i64::try_from(wait.as_nanos()).unwrap_or(i64::MAX));
    let _ = DispatchQueue::main().after(at, super::expire_pending);
}

/// The handler of the notifications NSH did not show.
struct Foreign;

impl ForeignNotificationHandler for Foreign {
    fn presentation(&self, notification: &ForeignNotification) -> Presentation {
        let shown = super::arrived(remote(notification));
        Presentation::default()
            .banner(shown.banner)
            .list(shown.list)
            .sound(shown.sound)
            .badge(shown.badge)
    }

    fn pressed(&self, notification: &ForeignNotification) {
        super::pressed(remote(notification));
    }
}

fn remote(notification: &ForeignNotification) -> RemoteNotification {
    RemoteNotification::new(
        notification.id.clone(),
        notification.thread_id.clone(),
        notification.user_info.clone(),
    )
}

/// Asks the system to register the device: the delegate hears the answer.
pub(super) async fn register() -> Result<(), PushError> {
    run_on_main_thread(|| {
        let mtm = MainThreadMarker::new().expect("main-thread work runs on the main thread");
        let app = UIApplication::sharedApplication(mtm);
        // SAFETY: UIKit's documented method, on the main thread.
        let () = unsafe { msg_send![&*app, registerForRemoteNotifications] };
    })
    .await
    .map_err(|error| PushError::failed(format!("cannot register the device: {error}")))
}

/// The current notification center, where the app may touch it: the
/// framework ends a process without a bundle identifier that does.
fn center() -> Option<Retained<AnyObject>> {
    NSBundle::mainBundle().bundleIdentifier()?;
    let class = AnyClass::get(c"UNUserNotificationCenter")?;
    // SAFETY: the documented way to the center, with a bundle identifier.
    Some(unsafe { msg_send![class, currentNotificationCenter] })
}

/// Removes the delivered notifications of `thread_id`, but NSH's own. The
/// center answers on a queue of its own, and it is thread-safe.
pub(super) async fn close_thread(thread_id: String) -> Result<(), PushError> {
    if !super::hub().launched {
        return Err(PushError::unavailable(UNAVAILABLE));
    }
    let (answer, removed) = oneshot::channel();
    {
        let Some(center) = center() else {
            return Err(PushError::unavailable("there is no notification center"));
        };
        let again = center.clone();
        let answer = Mutex::new(Some(answer));
        let delivered = RcBlock::new(move |notifications: *mut NSArray<AnyObject>| {
            // SAFETY: the array the framework passes, or nil.
            let ids: Vec<String> = match unsafe { notifications.as_ref() } {
                Some(notifications) => {
                    let delivered: Vec<(String, String, bool)> =
                        notifications.iter().map(|n| identify(&n)).collect();
                    super::in_thread(
                        delivered
                            .iter()
                            .map(|(id, thread, own)| (&**id, &**thread, *own)),
                        &thread_id,
                    )
                    .into_iter()
                    .map(str::to_owned)
                    .collect()
                }
                None => Vec::new(),
            };
            if !ids.is_empty() {
                let ids: Vec<Retained<NSString>> =
                    ids.iter().map(|id| NSString::from_str(id)).collect();
                let ids = NSArray::from_retained_slice(&ids);
                // SAFETY: a documented method taking an array of identifiers.
                let () = unsafe {
                    msg_send![&*again, removeDeliveredNotificationsWithIdentifiers: &*ids]
                };
            }
            if let Some(answer) = answer.lock().unwrap_or_else(|e| e.into_inner()).take() {
                let _ = answer.send(());
            }
        });
        // SAFETY: a documented method and its block's signature.
        let () = unsafe {
            msg_send![&*center, getDeliveredNotificationsWithCompletionHandler: &*delivered]
        };
    }
    removed
        .await
        .map_err(|_| PushError::failed("the notification center did not answer"))
}

/// A delivered notification's (a `UNNotification`'s) identifier, thread
/// and whether `Notifications` showed it.
fn identify(notification: &AnyObject) -> (String, String, bool) {
    // SAFETY: documented properties of a notification, its request and the
    // request's content, and a dictionary's lookup by a string key.
    unsafe {
        let request: Retained<AnyObject> = msg_send![notification, request];
        let id: Retained<NSString> = msg_send![&*request, identifier];
        let content: Retained<AnyObject> = msg_send![&*request, content];
        let thread: Retained<NSString> = msg_send![&*content, threadIdentifier];
        let info: Option<Retained<NSDictionary>> = msg_send![&*content, userInfo];
        let marker = NSString::from_str(NSH_MARKER);
        let own = info.is_some_and(|info| {
            let value: Option<Retained<AnyObject>> = msg_send![&*info, objectForKey: &*marker];
            value.is_some()
        });
        (id.to_string(), thread.to_string(), own)
    }
}
