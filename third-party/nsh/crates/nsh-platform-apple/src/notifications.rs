//! Notifications and the badge on Apple platforms
//! (`Command::Notification`, `nsh`'s `Notifications`): the UserNotifications
//! framework. Shared by macOS and iOS through `nsh-platform-apple`: the
//! framework is loaded and messaged dynamically, as `speech.rs` does.
//!
//! The framework ends an executable without a bundle identifier that
//! touches it (the macOS development host run from a terminal), so there
//! the permission is `unavailable` and nothing shows; the Dock's badge still
//! works. When asking errs, the permission is the one the settings hold.
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
//!
//! NSH marks the content of the notifications it shows ([`MARKER`]), and
//! closing them all removes only the marked ones: on iOS the center is the
//! embedding app's too, and its own notifications stay.
//!
//! The notifications NSH did not show (remote ones, or ones other code of
//! the app scheduled, such as a third-party push SDK) are not the app's
//! `press` events: they go to the handler native code registers with
//! [`set_foreign_handler`], which decides how they show while the app is in
//! front and hears their presses, those that start the app included. The
//! delegate belongs to the platform backend, so this is how an app crate or
//! an nshm takes part in it without replacing it.

use std::{
    cell::{Cell, RefCell},
    ffi::CStr,
    rc::Rc,
    sync::OnceLock,
};

use block2::{DynBlock, RcBlock};
use dispatch2::DispatchQueue;
use nsh_core::{
    EventKind, EventPayload, JsonValue, PayloadValue, ROOT_ID,
    notifications::{Notification, NotificationCommand, NotificationEvent, NotificationPermission},
};
use nsh_engine::EngineControl;
use objc2::{
    AnyThread, MainThreadMarker, define_class,
    encode::Encoding,
    msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, Bool, NSObject, NSObjectProtocol},
};
use objc2_core_foundation::{CFBoolean, CFType};
use objc2_foundation::{NSArray, NSBundle, NSDictionary, NSError, NSNumber, NSString};

/// `UNAuthorizationOptionBadge | Sound | Alert`.
const AUTHORIZATION: usize = 1 | 2 | 4;
/// The key in `userInfo` of the notifications NSH shows: what closing them
/// all removes, so an embedding app's own stay. It lives in the content,
/// so the notifications of an earlier run carry it too.
const MARKER: &str = "nsh";
/// `UNNotificationDefaultActionIdentifier`: the user pressed the
/// notification itself, not one of its actions or its dismissal.
const DEFAULT_ACTION: &str = "com.apple.UNNotificationDefaultActionIdentifier";

thread_local! {
    /// The engine that listens to presses, once the app does.
    static LISTENER: RefCell<Option<EngineControl>> = const { RefCell::new(None) };
    /// Presses before the app listens.
    static PRESSES: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    /// The handler of the notifications NSH did not show
    /// ([`set_foreign_handler`]).
    static FOREIGN: RefCell<Option<Rc<dyn ForeignNotificationHandler>>> =
        const { RefCell::new(None) };
    /// Presses of notifications NSH did not show before a handler is set.
    static FOREIGN_PRESSES: RefCell<Vec<ForeignNotification>> = const { RefCell::new(Vec::new()) };
    /// The delegate; the center does not retain it.
    static DELEGATE: RefCell<Option<Retained<Delegate>>> = const { RefCell::new(None) };
    /// The process's notifications are the app's ([`enable`]).
    static ENABLED: Cell<bool> = const { Cell::new(cfg!(target_os = "ios")) };
}

/// A notification NSH did not show: a remote one, or one that other code of
/// the app scheduled. [`ForeignNotificationHandler`] receives it.
#[derive(Debug, Clone, PartialEq, Default)]
#[non_exhaustive]
pub struct ForeignNotification {
    /// Its request's identifier.
    pub id: String,
    /// The thread it is grouped in (`threadIdentifier`), `""` for none.
    pub thread_id: String,
    /// Its `userInfo`: a remote notification's payload, the `aps`
    /// dictionary included ([`user_info_json`]).
    pub user_info: JsonValue,
}

/// How a notification shows while the app is in front
/// ([`ForeignNotificationHandler::presentation`]). The default shows it as
/// it shows while the app is behind, as NSH's own notifications do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub struct Presentation {
    /// It shows as a banner.
    pub banner: bool,
    /// It stays in the notification list.
    pub list: bool,
    /// Its sound plays.
    pub sound: bool,
    /// Its badge applies to the app's icon.
    pub badge: bool,
}

impl Default for Presentation {
    fn default() -> Self {
        Self {
            banner: true,
            list: true,
            sound: true,
            badge: true,
        }
    }
}

impl Presentation {
    /// Shows it as a banner ([`Self::banner`]).
    pub fn banner(mut self, banner: bool) -> Self {
        self.banner = banner;
        self
    }

    /// Keeps it in the notification list ([`Self::list`]).
    pub fn list(mut self, list: bool) -> Self {
        self.list = list;
        self
    }

    /// Plays its sound ([`Self::sound`]).
    pub fn sound(mut self, sound: bool) -> Self {
        self.sound = sound;
        self
    }

    /// Applies its badge ([`Self::badge`]).
    pub fn badge(mut self, badge: bool) -> Self {
        self.badge = badge;
        self
    }

    /// `UNNotificationPresentationOptions`: `Badge` (1), `Sound` (2),
    /// `List` (8) and `Banner` (16).
    fn options(self) -> usize {
        usize::from(self.badge)
            | usize::from(self.sound) << 1
            | usize::from(self.list) << 3
            | usize::from(self.banner) << 4
    }
}

/// Handles the notifications NSH did not show ([`set_foreign_handler`]).
/// Its methods run on the main thread.
pub trait ForeignNotificationHandler {
    /// How `notification`, arriving while the app is in front, shows. The
    /// system waits for the answer, so it is decided without waiting for
    /// anything else. By default it shows as it does behind.
    fn presentation(&self, notification: &ForeignNotification) -> Presentation {
        let _ = notification;
        Presentation::default()
    }

    /// The user pressed `notification`, which may have started the app.
    fn pressed(&self, notification: &ForeignNotification);
}

/// Hands the notifications NSH did not show to `handler`. Until a handler
/// is set they show as NSH's own do, and their presses wait for it, so one
/// set before the app runs (the `#[native_module]` entry of the app's crate
/// or of an nshm) hears the press that starts the app. Their presses never
/// reach the app's `press` listeners. Setting a handler also makes NSH the
/// notification center's delegate where it may be ([`install`]), so an app
/// that embeds NSH hears them too.
///
/// There is one handler: a later one replaces the earlier (with a
/// warning), so the app's crate should own it and pass notifications on to
/// the modules it uses. An embedding app that has a notification center
/// delegate of its own keeps them all, and the handler hears nothing.
///
/// # Panics
///
/// Panics off the main thread.
pub fn set_foreign_handler(handler: impl ForeignNotificationHandler + 'static) {
    assert!(
        MainThreadMarker::new().is_some(),
        "set_foreign_handler is called on the main thread"
    );
    if replace_handler(Rc::new(handler)) {
        log::warn!("notifications: a foreign notification handler replaced the one set before");
    }
    install();
}

/// Sets the handler and hands it the presses that waited for one; whether
/// it replaced another.
fn replace_handler(handler: Rc<dyn ForeignNotificationHandler>) -> bool {
    let replaced = FOREIGN.with(|f| f.borrow_mut().replace(handler).is_some());
    for notification in FOREIGN_PRESSES.with(|p| std::mem::take(&mut *p.borrow_mut())) {
        foreign_pressed(notification);
    }
    replaced
}

/// `info`, a notification's `userInfo` or another dictionary UIKit passes,
/// as JSON. Strings, numbers, booleans, arrays and dictionaries keep their
/// values; entries with keys other than strings are left out, and other
/// values (dates, data) are `null`, so one such value does not lose the rest.
/// Shared by the hooks of the macOS and iOS backends, no API of apps'.
#[doc(hidden)]
pub fn user_info_json(info: &NSDictionary) -> JsonValue {
    to_json(info)
}

/// A notification the delegate heard of: NSH's own by its id, or another.
#[derive(Debug, PartialEq)]
enum Received {
    Own(String),
    Foreign(ForeignNotification),
}

impl Received {
    /// What a notification with the request identifier `id`, the thread
    /// `thread_id` and `info` as its `userInfo` is.
    fn new(id: String, thread_id: String, info: Option<&NSDictionary>) -> Self {
        if info.is_some_and(is_marked) {
            return Self::Own(id);
        }
        Self::Foreign(ForeignNotification {
            id,
            thread_id,
            user_info: info.map_or_else(|| JsonValue::Object(Default::default()), user_info_json),
        })
    }

    /// What the user's response `action` to it reports: NSH's own
    /// notifications report every response, as before; another's only a press
    /// of the notification itself, not its category's actions or dismissal.
    fn respond(self, action: &str) -> Option<Self> {
        match self {
            Self::Foreign(_) if action != DEFAULT_ACTION => None,
            received => Some(received),
        }
    }

    /// Reports a press of it: NSH's own to the app's `press` listeners,
    /// another to the handler. On the main thread.
    fn press(self) {
        match self {
            Self::Own(id) => pressed(id),
            Self::Foreign(notification) => foreign_pressed(notification),
        }
    }

    /// What `notification` (a `UNNotification`) is.
    fn of(notification: &AnyObject) -> Self {
        // SAFETY: documented properties of a notification, its request and
        // the request's content.
        let (id, content) = unsafe {
            let request: Retained<AnyObject> = msg_send![notification, request];
            let id: Retained<NSString> = msg_send![&*request, identifier];
            let content: Retained<AnyObject> = msg_send![&*request, content];
            (id.to_string(), content)
        };
        // SAFETY: documented properties of a notification's content.
        let (info, thread): (Option<Retained<NSDictionary>>, Retained<NSString>) = unsafe {
            (
                msg_send![&*content, userInfo],
                msg_send![&*content, threadIdentifier],
            )
        };
        Self::new(id, thread.to_string(), info.as_deref())
    }
}

/// Whether `info`, a notification's `userInfo`, is one NSH showed.
fn is_marked(info: &NSDictionary) -> bool {
    let marker = NSString::from_str(MARKER);
    // SAFETY: a dictionary's documented lookup, by a string key.
    let value: Option<Retained<AnyObject>> = unsafe { msg_send![info, objectForKey: &*marker] };
    value.is_some()
}

/// `value`, an object of a property list, as JSON ([`user_info_json`]).
fn to_json(value: &AnyObject) -> JsonValue {
    if let Some(string) = value.downcast_ref::<NSString>() {
        return JsonValue::String(string.to_string());
    }
    if let Some(number) = value.downcast_ref::<NSNumber>() {
        // SAFETY: `NSNumber` is toll-free bridged to `CFNumber` and
        // `CFBoolean`, both `CFType`s.
        let cf = unsafe { &*(number as *const NSNumber).cast::<CFType>() };
        if let Some(boolean) = cf.downcast_ref::<CFBoolean>() {
            return JsonValue::Bool(boolean.as_bool());
        }
        return match number.encoding() {
            Encoding::Float | Encoding::Double => serde_json::Number::from_f64(number.as_f64())
                .map_or(JsonValue::Null, JsonValue::Number),
            Encoding::UChar
            | Encoding::UShort
            | Encoding::UInt
            | Encoding::ULong
            | Encoding::ULongLong => JsonValue::from(number.as_u64()),
            _ => JsonValue::from(number.as_i64()),
        };
    }
    if let Some(array) = value.downcast_ref::<NSArray>() {
        return JsonValue::Array(array.iter().map(|value| to_json(&value)).collect());
    }
    if let Some(dictionary) = value.downcast_ref::<NSDictionary>() {
        let (keys, values) = dictionary.to_vecs();
        return JsonValue::Object(
            keys.iter()
                .zip(&values)
                .filter_map(|(key, value)| {
                    Some((key.downcast_ref::<NSString>()?.to_string(), to_json(value)))
                })
                .collect(),
        );
    }
    JsonValue::Null
}

/// How `notification`, which NSH did not show, shows while the app is in
/// front: the handler's answer, on the main thread.
fn foreign_presentation(notification: ForeignNotification) -> Presentation {
    let ask = move || present(handler().as_deref(), &notification);
    if MainThreadMarker::new().is_some() {
        return ask();
    }
    // The system waits for the answer: wait for the main thread, which never
    // waits for this one.
    let mut answer = None;
    DispatchQueue::main().exec_sync(|| answer = Some(ask()));
    answer.unwrap_or_default()
}

/// How `notification` shows in front: `handler`'s answer, or as NSH's own
/// without one.
fn present(
    handler: Option<&dyn ForeignNotificationHandler>,
    notification: &ForeignNotification,
) -> Presentation {
    handler.map_or_else(Presentation::default, |h| h.presentation(notification))
}

/// Reports a press of a notification NSH did not show to the handler, or
/// keeps it until one is set.
fn foreign_pressed(notification: ForeignNotification) {
    match handler() {
        Some(handler) => handler.pressed(&notification),
        None => FOREIGN_PRESSES.with(|p| p.borrow_mut().push(notification)),
    }
}

/// The handler of the notifications NSH did not show, out of `FOREIGN`, so
/// that it may set another while it runs.
fn handler() -> Option<Rc<dyn ForeignNotificationHandler>> {
    FOREIGN.with(|f| f.borrow().clone())
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
            notification: &AnyObject,
            done: &DynBlock<dyn Fn(usize)>,
        ) {
            let presentation = match Received::of(notification) {
                Received::Own(_) => Presentation::default(),
                Received::Foreign(notification) => foreign_presentation(notification),
            };
            done.call((presentation.options(),));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &AnyObject,
            response: &AnyObject,
            done: &DynBlock<dyn Fn()>,
        ) {
            // SAFETY: documented properties of a notification response.
            let (notification, action) = unsafe {
                let notification: Retained<AnyObject> = msg_send![response, notification];
                let action: Retained<NSString> = msg_send![response, actionIdentifier];
                (notification, action)
            };
            if let Some(press) = Received::of(&notification).respond(&action.to_string()) {
                main(move || press.press());
            }
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
        NotificationCommand::CloseAll => {
            let Some(center) = center() else { return };
            close_all(&center);
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
        // The framework errs for a permission the user turned off as well:
        // the settings hold the answer.
        // SAFETY: an error of the call or nil.
        if let Some(error) = unsafe { error.as_ref() } {
            log::info!(
                "notifications: asking for the permission: {}",
                error.localizedDescription()
            );
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
        let marker = NSString::from_str(MARKER);
        let yes = NSNumber::new_bool(true);
        let info = NSDictionary::<NSString, AnyObject>::from_slices(&[&*marker], &[yes.as_ref()]);
        let () = msg_send![&*content, setUserInfo: &*info];
        // A content without a sound plays none (nor vibrates an iPhone),
        // though the presentation in front (`Presentation::default`) lets
        // sounds play.
        // The app's sound by its file name, which the system finds in the
        // bundle's `Library/Sounds` (`nsh package` copies it there) or plays
        // the default for when it finds none.
        if let Some(path) = notification.sound_path() {
            let name = NSString::from_str(Notification::sound_file_name(path));
            let sound: Retained<AnyObject> = msg_send![sound, soundNamed: &*name];
            let () = msg_send![&*content, setSound: &*sound];
        } else if !notification.silent {
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

/// Removes the notifications NSH showed ([`MARKER`]), pending and
/// delivered, whichever run showed them. The handlers run on a background
/// queue, which the center allows: it is thread-safe.
fn close_all(center: &Retained<AnyObject>) {
    let again = center.clone();
    let pending = RcBlock::new(move |requests: *mut NSArray<AnyObject>| {
        // SAFETY: the array the framework passes, or nil.
        let Some(requests) = (unsafe { requests.as_ref() }) else {
            return;
        };
        if let Some(ids) = marked(requests.iter()) {
            // SAFETY: a documented method taking an array of identifiers.
            let () = unsafe {
                msg_send![&*again, removePendingNotificationRequestsWithIdentifiers: &*ids]
            };
        }
    });
    let again = center.clone();
    let delivered = RcBlock::new(move |notifications: *mut NSArray<AnyObject>| {
        // SAFETY: the array the framework passes, or nil.
        let Some(notifications) = (unsafe { notifications.as_ref() }) else {
            return;
        };
        // SAFETY: a delivered notification's documented request.
        let requests = notifications
            .iter()
            .map(|n| -> Retained<AnyObject> { unsafe { msg_send![&*n, request] } });
        if let Some(ids) = marked(requests) {
            // SAFETY: a documented method taking an array of identifiers.
            let () =
                unsafe { msg_send![&*again, removeDeliveredNotificationsWithIdentifiers: &*ids] };
        }
    });
    // SAFETY: documented methods and their blocks' signatures.
    unsafe {
        let () =
            msg_send![&**center, getPendingNotificationRequestsWithCompletionHandler: &*pending];
        let () = msg_send![&**center, getDeliveredNotificationsWithCompletionHandler: &*delivered];
    }
}

/// The identifiers of the requests NSH made ([`MARKER`]), if any.
fn marked(
    requests: impl Iterator<Item = Retained<AnyObject>>,
) -> Option<Retained<NSArray<NSString>>> {
    let ids: Vec<Retained<NSString>> = requests
        .filter_map(|request| {
            // SAFETY: documented properties: a request's content and
            // identifier, the content's `userInfo`.
            unsafe {
                let content: Retained<AnyObject> = msg_send![&*request, content];
                let info: Option<Retained<NSDictionary>> = msg_send![&*content, userInfo];
                if !is_marked(&*info?) {
                    return None;
                }
                Some(msg_send![&*request, identifier])
            }
        })
        .collect();
    (!ids.is_empty()).then(|| NSArray::from_retained_slice(&ids))
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

#[cfg(test)]
mod tests {
    use objc2_foundation::NSDate;
    use serde_json::json;

    use super::*;

    fn dictionary(keys: &[&str], values: &[&AnyObject]) -> Retained<NSDictionary> {
        let keys: Vec<_> = keys.iter().map(|k| NSString::from_str(k)).collect();
        let keys: Vec<&NSString> = keys.iter().map(|k| &**k).collect();
        let dictionary = NSDictionary::<NSString, AnyObject>::from_slices(&keys, values);
        // SAFETY: a dictionary of string keys is a dictionary of objects.
        unsafe { Retained::cast_unchecked(dictionary) }
    }

    #[test]
    fn the_presentation_in_front_is_the_options_it_names() {
        assert_eq!(Presentation::default().options(), 1 | 2 | 8 | 16);
        let hidden = Presentation::default()
            .banner(false)
            .list(false)
            .sound(false)
            .badge(false);
        assert_eq!(hidden.options(), 0);
        assert_eq!(
            Presentation::default().banner(false).sound(false).options(),
            1 | 8
        );
    }

    #[test]
    fn only_the_notifications_nsh_showed_are_marked() {
        let yes = NSNumber::new_bool(true);
        assert!(is_marked(&dictionary(&[MARKER], &[yes.as_ref()])));
        let aps = dictionary(&["alert"], &[NSString::from_str("Hi").as_ref()]);
        assert!(!is_marked(&dictionary(&["aps"], &[aps.as_ref()])));
        assert!(!is_marked(&dictionary(&[], &[])));
    }

    #[test]
    fn a_payload_keeps_its_values_as_json() {
        let alert = dictionary(
            &["title", "badge"],
            &[
                NSString::from_str("Ada").as_ref(),
                NSNumber::new_i32(3).as_ref(),
            ],
        );
        let aps = dictionary(&["alert"], &[alert.as_ref()]);
        let ids =
            NSArray::from_retained_slice(&[NSNumber::new_u64(u64::MAX), NSNumber::new_i64(-7)]);
        let numbers = NSDictionary::<NSNumber, AnyObject>::from_slices(
            &[&*NSNumber::new_i32(1)],
            &[NSString::from_str("not a string key").as_ref()],
        );
        let info = dictionary(
            &[
                "aps", "chat", "ids", "ratio", "unread", "read", "sent", "numbers",
            ],
            &[
                aps.as_ref(),
                NSString::from_str("42").as_ref(),
                ids.as_ref(),
                NSNumber::new_f64(0.5).as_ref(),
                NSNumber::new_bool(true).as_ref(),
                NSNumber::new_bool(false).as_ref(),
                NSDate::now().as_ref(),
                numbers.as_ref(),
            ],
        );
        assert_eq!(
            user_info_json(&info),
            json!({
                "aps": { "alert": { "title": "Ada", "badge": 3 } },
                "chat": "42",
                "ids": [u64::MAX, -7],
                "ratio": 0.5,
                "unread": true,
                "read": false,
                "sent": null,
                "numbers": {},
            })
        );
    }

    struct Recorder(Rc<RefCell<Vec<String>>>);

    impl ForeignNotificationHandler for Recorder {
        fn pressed(&self, notification: &ForeignNotification) {
            self.0.borrow_mut().push(notification.id.clone());
        }
    }

    /// Sets a handler that records the presses it hears.
    fn record() -> Rc<RefCell<Vec<String>>> {
        let pressed = Rc::new(RefCell::new(Vec::new()));
        replace_handler(Rc::new(Recorder(pressed.clone())));
        pressed
    }

    /// The presses that reached the app's `press` listeners (none listen in
    /// a test, so they wait).
    fn app_presses() -> Vec<String> {
        PRESSES.with(|p| p.borrow().clone())
    }

    /// A remote notification's `userInfo`.
    fn remote() -> Retained<NSDictionary> {
        let aps = dictionary(&["alert"], &[NSString::from_str("Hi").as_ref()]);
        dictionary(
            &["aps", "chat"],
            &[aps.as_ref(), NSString::from_str("42").as_ref()],
        )
    }

    fn foreign(id: &str) -> ForeignNotification {
        ForeignNotification {
            id: id.into(),
            thread_id: "chat:42".into(),
            user_info: json!({ "chat": "42" }),
        }
    }

    #[test]
    fn a_press_of_nshs_own_notification_reaches_press() {
        let pressed = record();
        let yes = NSNumber::new_bool(true);
        let own = dictionary(&[MARKER], &[yes.as_ref()]);
        let received = Received::new("chat:42".into(), String::new(), Some(&own));
        assert_eq!(received, Received::Own("chat:42".into()));
        received.respond(DEFAULT_ACTION).unwrap().press();
        assert_eq!(app_presses(), ["chat:42"]);
        assert!(pressed.borrow().is_empty());
    }

    #[test]
    fn a_press_of_another_notification_reaches_the_handler_not_press() {
        let pressed = record();
        let received = Received::new("4F1C".into(), "chat:42".into(), Some(&remote()));
        assert_eq!(
            received,
            Received::Foreign(ForeignNotification {
                id: "4F1C".into(),
                thread_id: "chat:42".into(),
                user_info: json!({ "aps": { "alert": "Hi" }, "chat": "42" }),
            })
        );
        received.respond(DEFAULT_ACTION).unwrap().press();
        assert_eq!(*pressed.borrow(), ["4F1C"]);
        assert!(app_presses().is_empty());
    }

    #[test]
    fn dismissing_another_notification_reaches_no_one() {
        let pressed = record();
        let received = Received::new("4F1C".into(), String::new(), Some(&remote()));
        let dismiss = "com.apple.UNNotificationDismissActionIdentifier";
        assert_eq!(received.respond(dismiss), None);
        let received = Received::new("4F1C".into(), String::new(), Some(&remote()));
        assert_eq!(received.respond("reply"), None);
        assert!(pressed.borrow().is_empty());
        assert!(app_presses().is_empty());
    }

    #[test]
    fn a_notification_without_user_info_is_another() {
        assert_eq!(
            Received::new("x".into(), String::new(), None),
            Received::Foreign(ForeignNotification {
                id: "x".into(),
                thread_id: String::new(),
                user_info: json!({}),
            })
        );
    }

    #[test]
    fn a_press_before_the_handler_waits_for_it() {
        // The press that starts the app comes before a late handler.
        foreign_pressed(foreign("first"));
        let pressed = Rc::new(RefCell::new(Vec::new()));
        assert!(!replace_handler(Rc::new(Recorder(pressed.clone()))));
        assert_eq!(*pressed.borrow(), ["first"]);
        foreign_pressed(foreign("second"));
        assert_eq!(*pressed.borrow(), ["first", "second"]);
        assert!(app_presses().is_empty());
        // Another handler replaces it.
        assert!(replace_handler(Rc::new(Recorder(Rc::default()))));
    }

    struct Quiet;

    impl ForeignNotificationHandler for Quiet {
        fn presentation(&self, _: &ForeignNotification) -> Presentation {
            Presentation::default().banner(false).sound(false)
        }

        fn pressed(&self, _: &ForeignNotification) {}
    }

    #[test]
    fn the_handler_decides_how_another_notification_shows_in_front() {
        let notification = foreign("any");
        assert_eq!(present(None, &notification), Presentation::default());
        let recorder: &dyn ForeignNotificationHandler = &Recorder(Rc::default());
        assert_eq!(
            present(Some(recorder), &notification),
            Presentation::default()
        );
        assert_eq!(
            present(
                Some(&Quiet as &dyn ForeignNotificationHandler),
                &notification
            ),
            Presentation::default().banner(false).sound(false)
        );
    }

    struct Replacing(Rc<RefCell<Vec<String>>>);

    impl ForeignNotificationHandler for Replacing {
        fn pressed(&self, notification: &ForeignNotification) {
            self.0.borrow_mut().push(notification.id.clone());
            replace_handler(Rc::new(Recorder(self.0.clone())));
        }
    }

    #[test]
    fn a_handler_may_set_another_while_it_runs() {
        let pressed = Rc::new(RefCell::new(Vec::new()));
        replace_handler(Rc::new(Replacing(pressed.clone())));
        foreign_pressed(foreign("first"));
        foreign_pressed(foreign("second"));
        assert_eq!(*pressed.borrow(), ["first", "second"]);
    }

    #[test]
    #[should_panic(expected = "main thread")]
    fn setting_a_handler_off_the_main_thread_panics() {
        set_foreign_handler(Recorder(Rc::default()));
    }
}
