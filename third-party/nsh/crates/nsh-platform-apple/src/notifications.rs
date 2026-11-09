//! Notifications and the badge on Apple platforms
//! (`Command::Notification`, `nsh`'s `Notifications`): the UserNotifications
//! framework. Shared by macOS and iOS through `nsh-platform-apple`: the
//! framework is loaded and messaged dynamically, as `speech.rs` does.
//!
//! The framework ends an executable without a bundle identifier that
//! touches it (the macOS development host run from a terminal), so there
//! the permission is `unavailable` and nothing shows; the Dock's badge still
//! works. A bundle that macOS does not trust (no signature) gets an error
//! from the framework, reported as `unavailable` too.
//!
//! On macOS the process's notifications are the app's only when it owns
//! them ([`enable`]: `AppOptions::notifications`, which `run_app` sets): an
//! embedding app that did not hand them over keeps them, and the permission
//! is `unavailable`, nothing shows and the badge stays the embedding app's.
//! On iOS they are always the app's.
//!
//! [`install`] makes this file the notification center's delegate before
//! the app finishes launching, so a press that starts the app is not lost
//! (it waits in `PRESSES` until the app listens), and banners show while
//! the app is in front. An embedding app that has a delegate of its own keeps
//! it: its notifications and their presses stay its own, and presses of the
//! ones NSH showed go to that delegate.

use std::{
    cell::{Cell, RefCell},
    ffi::CStr,
    sync::OnceLock,
};

use block2::{DynBlock, RcBlock};
use dispatch2::DispatchQueue;
use nsh_core::{
    EventKind, EventPayload, PayloadValue, ROOT_ID,
    notifications::{Notification, NotificationCommand, NotificationEvent, NotificationPermission},
};
use nsh_engine::EngineControl;
use objc2::{
    AnyThread, define_class, msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, Bool, NSObject, NSObjectProtocol},
};
use objc2_foundation::{NSArray, NSBundle, NSError, NSString};

/// `UNAuthorizationOptionBadge | Sound | Alert`.
const AUTHORIZATION: usize = 1 | 2 | 4;
/// `UNNotificationPresentationOptionBadge | Sound | List | Banner`: a
/// notification shown while the app is in front shows as it does behind.
const PRESENTATION: usize = 1 | (1 << 1) | (1 << 3) | (1 << 4);

thread_local! {
    /// The engine that listens to presses, once the app does.
    static LISTENER: RefCell<Option<EngineControl>> = const { RefCell::new(None) };
    /// Presses before the app listens.
    static PRESSES: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    /// The delegate; the center does not retain it.
    static DELEGATE: RefCell<Option<Retained<Delegate>>> = const { RefCell::new(None) };
    /// The process's notifications are the app's ([`enable`]).
    static ENABLED: Cell<bool> = const { Cell::new(cfg!(target_os = "ios")) };
}

/// Makes the process's notifications the app's and becomes the notification
/// center's delegate ([`install`]). On the main thread.
#[cfg_attr(target_os = "ios", allow(dead_code))]
pub fn enable() {
    ENABLED.set(true);
    install();
}

define_class!(
    /// The notification center's delegate.
    #[unsafe(super(NSObject))]
    #[name = "NshNotificationDelegate"]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    impl Delegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &AnyObject,
            _notification: &AnyObject,
            done: &DynBlock<dyn Fn(usize)>,
        ) {
            done.call((PRESENTATION,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &AnyObject,
            response: &AnyObject,
            done: &DynBlock<dyn Fn()>,
        ) {
            // SAFETY: the documented chain of a notification response.
            let id: Retained<NSString> = unsafe {
                let notification: Retained<AnyObject> = msg_send![response, notification];
                let request: Retained<AnyObject> = msg_send![&*notification, request];
                msg_send![&*request, identifier]
            };
            let id = id.to_string();
            main(move || pressed(id));
            done.call(());
        }
    }
);

/// Applies `command`, reporting through `control`. On the main thread.
pub fn command(control: &EngineControl, command: &NotificationCommand) {
    if !ENABLED.get() {
        match command {
            NotificationCommand::Permission { id, .. } => {
                answer_permission(control, *id, NotificationPermission::Unavailable)
            }
            NotificationCommand::Show { id, .. } => answer_shown(control, *id, false),
            _ => {}
        }
        return;
    }
    match command {
        NotificationCommand::SetBadge(count) => set_badge(*count),
        NotificationCommand::Permission { id, ask } => match center() {
            Some(center) if *ask => ask_permission(&center, control.clone(), *id),
            Some(center) => report_permission(&center, control.clone(), *id),
            None => answer_permission(control, *id, NotificationPermission::Unavailable),
        },
        NotificationCommand::Show { id, notification } => match center() {
            Some(center) => show(&center, control.clone(), *id, notification),
            None => answer_shown(control, *id, false),
        },
        NotificationCommand::Close(id) => {
            let Some(center) = center() else { return };
            let ids = NSArray::from_retained_slice(&[NSString::from_str(id)]);
            // SAFETY: documented methods taking an array of identifiers.
            let () = unsafe {
                msg_send![&*center, removePendingNotificationRequestsWithIdentifiers: &*ids]
            };
            let () =
                unsafe { msg_send![&*center, removeDeliveredNotificationsWithIdentifiers: &*ids] };
        }
        NotificationCommand::Listen => {
            install();
            LISTENER.with(|l| *l.borrow_mut() = Some(control.clone()));
            for id in PRESSES.with(|p| std::mem::take(&mut *p.borrow_mut())) {
                pressed(id);
            }
        }
        _ => {}
    }
}

/// Becomes the notification center's delegate unless the app has one (or
/// this already is). On the main thread, before the app finishes launching,
/// where a press can start it.
pub fn install() {
    if !ENABLED.get() {
        return;
    }
    let Some(center) = center() else { return };
    // SAFETY: a documented property.
    let current: Option<Retained<AnyObject>> = unsafe { msg_send![&*center, delegate] };
    if current.is_some() {
        return;
    }
    let delegate: Retained<Delegate> = unsafe { msg_send![Delegate::alloc(), init] };
    // SAFETY: the delegate answers the protocol's optional methods, and
    // `DELEGATE` keeps it (the property is weak).
    let () = unsafe { msg_send![&*center, setDelegate: &*delegate] };
    DELEGATE.with(|d| *d.borrow_mut() = Some(delegate));
}

/// The current notification center, where the app may touch it.
fn center() -> Option<Retained<AnyObject>> {
    if !framework() || NSBundle::mainBundle().bundleIdentifier().is_none() {
        return None;
    }
    let class = AnyClass::get(c"UNUserNotificationCenter")?;
    // SAFETY: the documented way to the center, with a bundle identifier.
    Some(unsafe { msg_send![class, currentNotificationCenter] })
}

fn ask_permission(center: &Retained<AnyObject>, control: EngineControl, id: u32) {
    install();
    let (center_again, control_again) = (center.clone(), control);
    let done = RcBlock::new(move |_granted: Bool, error: *mut NSError| {
        // SAFETY: an error of the call or nil.
        if let Some(error) = unsafe { error.as_ref() } {
            log::warn!(
                "notifications: cannot ask for the permission: {}",
                error.localizedDescription()
            );
            answer_permission(&control_again, id, NotificationPermission::Unavailable);
            return;
        }
        report_permission(&center_again, control_again.clone(), id);
    });
    // SAFETY: a documented method and its block's signature.
    let () = unsafe {
        msg_send![&**center, requestAuthorizationWithOptions: AUTHORIZATION, completionHandler: &*done]
    };
}

fn report_permission(center: &AnyObject, control: EngineControl, id: u32) {
    let done = RcBlock::new(move |settings: *mut AnyObject| {
        // SAFETY: the settings the framework passes, never nil here.
        let status: isize = match unsafe { settings.as_ref() } {
            Some(settings) => unsafe { msg_send![settings, authorizationStatus] },
            None => 0,
        };
        let permission = match status {
            0 => NotificationPermission::Default,
            1 => NotificationPermission::Denied,
            // Authorized, provisional, ephemeral.
            _ => NotificationPermission::Granted,
        };
        answer_permission(&control, id, permission);
    });
    // SAFETY: a documented method and its block's signature.
    let () = unsafe { msg_send![center, getNotificationSettingsWithCompletionHandler: &*done] };
}

fn show(center: &AnyObject, control: EngineControl, id: u32, notification: &Notification) {
    install();
    let (Some(content), Some(request), Some(sound)) = (
        AnyClass::get(c"UNMutableNotificationContent"),
        AnyClass::get(c"UNNotificationRequest"),
        AnyClass::get(c"UNNotificationSound"),
    ) else {
        answer_shown(&control, id, false);
        return;
    };
    // SAFETY: documented classes, properties and factory methods; a nil
    // trigger shows the notification now.
    unsafe {
        let content: Retained<AnyObject> = msg_send![content, new];
        let () = msg_send![&*content, setTitle: &*NSString::from_str(&notification.title)];
        let () = msg_send![&*content, setBody: &*NSString::from_str(&notification.body)];
        // A content without a sound plays none (nor vibrates an iPhone),
        // though `PRESENTATION` lets sounds play.
        if !notification.silent {
            let sound: Retained<AnyObject> = msg_send![sound, defaultSound];
            let () = msg_send![&*content, setSound: &*sound];
        }
        let trigger: Option<&AnyObject> = None;
        let request: Retained<AnyObject> = msg_send![
            request,
            requestWithIdentifier: &*NSString::from_str(&notification.id),
            content: &*content,
            trigger: trigger
        ];
        let done = RcBlock::new(move |error: *mut NSError| {
            // SAFETY: an error of the call or nil.
            let error = error.as_ref();
            if let Some(error) = error {
                log::warn!("notifications: not shown: {}", error.localizedDescription());
            }
            answer_shown(&control, id, error.is_none());
        });
        let () = msg_send![
            center,
            addNotificationRequest: &*request,
            withCompletionHandler: &*done
        ];
    }
}

#[cfg(target_os = "macos")]
fn set_badge(count: u32) {
    use objc2_app_kit::NSApplication;
    let Some(mtm) = objc2::MainThreadMarker::new() else {
        return;
    };
    let label = (count > 0).then(|| NSString::from_str(&count.to_string()));
    let app = NSApplication::sharedApplication(mtm);
    // SAFETY: `NSDockTile`'s documented property; nil clears the badge.
    unsafe {
        let tile: Retained<AnyObject> = msg_send![&*app, dockTile];
        let () = msg_send![&*tile, setBadgeLabel: label.as_deref()];
    }
}

#[cfg(not(target_os = "macos"))]
fn set_badge(count: u32) {
    let Some(center) = center() else { return };
    let done = RcBlock::new(move |error: *mut NSError| {
        // SAFETY: an error of the call or nil.
        if let Some(error) = unsafe { error.as_ref() } {
            log::warn!(
                "notifications: cannot set the badge: {}",
                error.localizedDescription()
            );
        }
    });
    // SAFETY: documented selectors: `setBadgeCount:` from iOS 16, the
    // application's property (deprecated by it) before; on the main thread.
    unsafe {
        let responds: bool = msg_send![
            &*center,
            respondsToSelector: objc2::sel!(setBadgeCount:withCompletionHandler:)
        ];
        if responds {
            let () = msg_send![
                &*center,
                setBadgeCount: count as isize,
                withCompletionHandler: &*done
            ];
        } else if let Some(mtm) = objc2::MainThreadMarker::new() {
            let app = objc2_ui_kit::UIApplication::sharedApplication(mtm);
            let () = msg_send![&*app, setApplicationIconBadgeNumber: count as isize];
        }
    }
}

/// Reports a press to the app, or keeps it until the app listens.
fn pressed(id: String) {
    let listener = LISTENER.with(|l| l.borrow().clone());
    match listener {
        Some(control) => control.dispatch_event(
            ROOT_ID,
            EventKind::Notification,
            EventPayload::Map(vec![(NotificationEvent::PRESSED, PayloadValue::Str(id))]),
        ),
        None => PRESSES.with(|p| p.borrow_mut().push(id)),
    }
}

fn answer_permission(control: &EngineControl, id: u32, permission: NotificationPermission) {
    control.dispatch_event(
        ROOT_ID,
        EventKind::Notification,
        EventPayload::Map(vec![
            (NotificationEvent::ID, PayloadValue::Number(f64::from(id))),
            (
                NotificationEvent::PERMISSION,
                PayloadValue::Str(permission.as_str().to_owned()),
            ),
        ]),
    );
}

fn answer_shown(control: &EngineControl, id: u32, shown: bool) {
    control.dispatch_event(
        ROOT_ID,
        EventKind::Notification,
        EventPayload::Map(vec![
            (NotificationEvent::ID, PayloadValue::Number(f64::from(id))),
            (NotificationEvent::SHOWN, PayloadValue::Bool(shown)),
        ]),
    );
}

fn main(f: impl FnOnce() + Send + 'static) {
    DispatchQueue::main().exec_async(f);
}

/// Whether UserNotifications is loaded (it is not linked).
fn framework() -> bool {
    static LOADED: OnceLock<bool> = OnceLock::new();
    *LOADED.get_or_init(|| {
        load(c"/System/Library/Frameworks/UserNotifications.framework/UserNotifications")
    })
}

fn load(framework: &CStr) -> bool {
    // SAFETY: loads a system framework; the handle is never closed.
    let loaded = !unsafe { libc::dlopen(framework.as_ptr(), libc::RTLD_LAZY) }.is_null();
    if !loaded {
        log::error!("cannot load {}", framework.to_string_lossy());
    }
    loaded
}
