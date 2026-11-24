//! What UIKit tells a standalone app's delegate, delivered to observers
//! that an app's crate or an nshm registers ([`on_application_event`]).
//!
//! The application delegate belongs to the backend ([`crate::run_app`]),
//! so code outside NSH has no other place to receive these callbacks. NSH
//! only passes them on: it never asks the system for remote notifications
//! itself (`registerForRemoteNotifications` stays the observer's call).
//!
//! Without observers, [`crate::run_app`] uses a delegate class that does
//! not implement these methods at all, so an app that does not use remote
//! notifications does not appear to the system to handle them.

use std::{
    cell::{Cell, RefCell},
    ffi::c_void,
    fmt,
    ptr::NonNull,
    rc::Rc,
    sync::{Arc, Mutex},
};

use block2::{DynBlock, RcBlock};
use dispatch2::{DispatchQueue, MainThreadBound};
use nsh_core::JsonValue;
use nsh_platform_apple::notifications::user_info_json;
use objc2::{
    ClassType, MainThreadMarker, MainThreadOnly, define_class,
    rc::Retained,
    runtime::{AnyClass, AnyObject},
};
use objc2_foundation::{NSData, NSDictionary, NSError, NSObject, NSString};
use objc2_ui_kit::{UIApplication, UIBackgroundFetchResult, UIResponder};

use crate::app::AppDelegate;

/// A callback of the application delegate ([`on_application_event`]).
///
/// Delivered on the main thread, in the order UIKit calls the delegate.
#[derive(Debug)]
#[non_exhaustive]
pub enum ApplicationEvent<'a> {
    /// Launching finished (`application:didFinishLaunchingWithOptions:`).
    #[non_exhaustive]
    Launched {
        /// Why the app was launched; `None` when the user launched it.
        options: Option<NativeDictionary<'a>>,
    },
    /// The system registered the device for remote notifications after
    /// the app asked it to (`registerForRemoteNotifications`).
    #[non_exhaustive]
    RegisteredForRemoteNotifications {
        /// The token a push service addresses this device with.
        device_token: &'a [u8],
    },
    /// The system could not register the device for remote notifications.
    #[non_exhaustive]
    FailedToRegisterForRemoteNotifications {
        /// The system's description of the failure.
        error: &'a str,
    },
    /// A remote notification for the app arrived, in the foreground or in
    /// the background (`application:didReceiveRemoteNotification:fetchCompletionHandler:`).
    #[non_exhaustive]
    RemoteNotification {
        /// The notification's payload.
        user_info: NativeDictionary<'a>,
        /// Tells the system when the work this notification started has
        /// finished.
        completion: &'a FetchCompletion,
    },
}

/// A dictionary UIKit passed to the application delegate, valid for the
/// duration of the [`ApplicationEvent`] that carries it.
#[derive(Clone, Copy)]
pub struct NativeDictionary<'a>(&'a NSDictionary);

impl NativeDictionary<'_> {
    /// The dictionary as JSON. Strings, numbers, booleans, arrays and
    /// dictionaries keep their values; entries whose keys are not strings
    /// are left out, and values JSON has no form for (a URL, a date) are
    /// `null`, so one of them does not lose the rest. A remote
    /// notification's payload, which came as JSON, reads back whole.
    pub fn to_json(&self) -> JsonValue {
        user_info_json(self.0)
    }

    /// The value at `key` as JSON ([`to_json`](Self::to_json)'s rules):
    /// `None` only when the key is absent.
    pub fn get(&self, key: &str) -> Option<JsonValue> {
        let key_object = NSString::from_str(key);
        let value = self.0.objectForKey(&key_object)?;
        // Converted as a dictionary of this one entry, by the same rules.
        let entry =
            NSDictionary::<NSString, AnyObject>::from_retained_objects(&[&*key_object], &[value]);
        // SAFETY: an `NSDictionary` of any keys and values is an
        // `NSDictionary`; only the generic parameters differ.
        let entry: Retained<NSDictionary> = unsafe { Retained::cast_unchecked(entry) };
        match user_info_json(&entry) {
            JsonValue::Object(mut entries) => entries.remove(key),
            _ => None,
        }
    }

    /// The `NSDictionary *` itself, for an SDK that takes it unchanged
    /// (such as launch options). It is valid while the event is being
    /// delivered; retain it to keep it longer.
    pub fn as_ptr(&self) -> NonNull<c_void> {
        NonNull::from(self.0).cast()
    }
}

impl fmt::Debug for NativeDictionary<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self.0, f)
    }
}

/// How the work a remote notification started turned out, for the system to
/// schedule the app's later background launches (`UIBackgroundFetchResult`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum FetchResult {
    /// New data was downloaded.
    NewData,
    /// There was nothing new.
    #[default]
    NoData,
    /// The work failed.
    Failed,
}

impl FetchResult {
    /// The result of two observers' work: new data over a failure, a
    /// failure over nothing new.
    fn merge(self, other: Self) -> Self {
        let rank = |result: Self| match result {
            Self::NoData => 0,
            Self::Failed => 1,
            Self::NewData => 2,
        };
        if rank(other) > rank(self) {
            other
        } else {
            self
        }
    }

    fn system(self) -> UIBackgroundFetchResult {
        match self {
            Self::NewData => UIBackgroundFetchResult::NewData,
            Self::NoData => UIBackgroundFetchResult::NoData,
            Self::Failed => UIBackgroundFetchResult::Failed,
        }
    }
}

/// The completion of a remote notification's background work
/// ([`ApplicationEvent::RemoteNotification`]).
///
/// Clone it to keep it across asynchronous work; it can move to any
/// thread. The system hears once, when the last clone is dropped, with the
/// most significant result reported ([`FetchCompletion::set_result`]), so
/// observers that do no work need not touch it. The system expects to hear
/// within about 30 seconds.
#[derive(Clone)]
pub struct FetchCompletion(Arc<Fetch>);

/// UIKit's fetch completion handler.
type FetchHandler = RcBlock<dyn Fn(UIBackgroundFetchResult)>;

struct Fetch {
    result: Mutex<FetchResult>,
    handler: Option<MainThreadBound<FetchHandler>>,
}

impl FetchCompletion {
    fn new(handler: &DynBlock<dyn Fn(UIBackgroundFetchResult)>, mtm: MainThreadMarker) -> Self {
        Self(Arc::new(Fetch {
            result: Mutex::new(FetchResult::default()),
            handler: Some(MainThreadBound::new(handler.copy(), mtm)),
        }))
    }

    /// Reports how this observer's work turned out. Results of several
    /// observers combine: new data wins over a failure, a failure over
    /// nothing new ([`FetchResult::NoData`], the result when nobody
    /// reports one).
    pub fn set_result(&self, result: FetchResult) {
        let mut current = self.0.result.lock().unwrap_or_else(|e| e.into_inner());
        *current = current.merge(result);
    }
}

impl fmt::Debug for FetchCompletion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let result = *self.0.result.lock().unwrap_or_else(|e| e.into_inner());
        f.debug_struct("FetchCompletion")
            .field("result", &result)
            .finish()
    }
}

impl Drop for Fetch {
    fn drop(&mut self) {
        let Some(handler) = self.handler.take() else {
            return;
        };
        let result = self
            .result
            .get_mut()
            .map(|result| *result)
            .unwrap_or_else(|e| *e.into_inner())
            .system();
        // UIKit's blocks are called on the main thread, where it called the
        // delegate.
        let finish = move |mtm| handler.into_inner(mtm).call((result,));
        match MainThreadMarker::new() {
            Some(mtm) => finish(mtm),
            None => DispatchQueue::main()
                .exec_async(move || finish(MainThreadMarker::new().expect("main queue"))),
        }
    }
}

type Observer = Rc<dyn Fn(&ApplicationEvent<'_>)>;

thread_local! {
    /// The observers, in the order they were added (main thread only).
    static OBSERVERS: RefCell<Vec<Observer>> = const { RefCell::new(Vec::new()) };
    /// Whether [`crate::run_app`] chose the delegate class, and which.
    static LAUNCHED: Cell<Option<bool>> = const { Cell::new(None) };
}

/// Adds an observer of the application delegate's callbacks
/// ([`ApplicationEvent`]) of a standalone app ([`crate::run_app`]).
///
/// Call it on the main thread before [`crate::run_app`], as the
/// `#[native_module]` entry of an app's crate or an nshm runs, once: every
/// call adds another observer, so running the entry again (its
/// `registry()`) delivers each event twice. Once the app runs, it decides
/// whether its delegate implements these methods: an observer added later
/// sees events only if one was added before. An app
/// that embeds NSH in its own UIKit app has its own delegate and does not
/// need this.
///
/// # Panics
///
/// Off the main thread.
pub fn on_application_event(observer: impl Fn(&ApplicationEvent<'_>) + 'static) {
    MainThreadMarker::new().expect("on_application_event must be called on the main thread");
    if LAUNCHED.get() == Some(false) {
        log::warn!(
            "application observer added after the app launched without one: it sees no events"
        );
    }
    OBSERVERS.with(|observers| observers.borrow_mut().push(Rc::new(observer)));
}

/// The application delegate class [`crate::run_app`] starts UIKit with:
/// one with the observed methods only when there are observers.
pub(crate) fn delegate_class() -> &'static AnyClass {
    let observed = OBSERVERS.with(|observers| !observers.borrow().is_empty());
    LAUNCHED.set(Some(observed));
    if observed {
        ObservedAppDelegate::class()
    } else {
        AppDelegate::class()
    }
}

/// Delivers `event` to every observer.
fn deliver(event: &ApplicationEvent<'_>) {
    // A copy of the list, so that an observer may add another.
    let observers = OBSERVERS.with(|observers| observers.borrow().clone());
    for observer in observers {
        observer(event);
    }
}

define_class!(
    /// [`AppDelegate`] with the callbacks observers receive.
    #[unsafe(super(AppDelegate, UIResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    struct ObservedAppDelegate;

    impl ObservedAppDelegate {
        #[unsafe(method(application:didFinishLaunchingWithOptions:))]
        fn did_finish_launching(
            &self,
            _application: &UIApplication,
            options: Option<&NSDictionary>,
        ) -> bool {
            deliver(&ApplicationEvent::Launched {
                options: options.map(NativeDictionary),
            });
            true
        }

        #[unsafe(method(application:didRegisterForRemoteNotificationsWithDeviceToken:))]
        fn did_register(&self, _application: &UIApplication, device_token: &NSData) {
            let device_token = device_token.to_vec();
            deliver(&ApplicationEvent::RegisteredForRemoteNotifications {
                device_token: &device_token,
            });
        }

        #[unsafe(method(application:didFailToRegisterForRemoteNotificationsWithError:))]
        fn did_fail_to_register(&self, _application: &UIApplication, error: &NSError) {
            let error = error.localizedDescription().to_string();
            deliver(&ApplicationEvent::FailedToRegisterForRemoteNotifications { error: &error });
        }

        #[unsafe(method(application:didReceiveRemoteNotification:fetchCompletionHandler:))]
        fn did_receive_remote_notification(
            &self,
            _application: &UIApplication,
            user_info: &NSDictionary,
            handler: &DynBlock<dyn Fn(UIBackgroundFetchResult)>,
        ) {
            // Dropped after delivery: the system hears now unless an
            // observer kept a clone.
            let completion = FetchCompletion::new(handler, self.mtm());
            deliver(&ApplicationEvent::RemoteNotification {
                user_info: NativeDictionary(user_info),
                completion: &completion,
            });
        }
    }
);

#[cfg(test)]
mod tests {
    use objc2::{Message, rc::Retained};
    use objc2_foundation::{NSNumber, NSURL};

    use super::*;

    fn object<T: Message>(object: Retained<T>) -> Retained<AnyObject> {
        // SAFETY: every Objective-C object is an `AnyObject`.
        unsafe { Retained::cast_unchecked(object) }
    }

    fn dictionary(entries: &[(&str, Retained<AnyObject>)]) -> Retained<NSDictionary> {
        let keys: Vec<_> = entries
            .iter()
            .map(|(key, _)| NSString::from_str(key))
            .collect();
        let keys: Vec<&NSString> = keys.iter().map(|key| &**key).collect();
        let values: Vec<_> = entries.iter().map(|(_, value)| value.clone()).collect();
        let dictionary = NSDictionary::<NSString, AnyObject>::from_retained_objects(&keys, &values);
        // SAFETY: an `NSDictionary` of any keys and values.
        unsafe { Retained::cast_unchecked(dictionary) }
    }

    /// Without observers the app's delegate does not implement the observed
    /// methods, so the system does not see it handle remote notifications.
    #[test]
    fn the_delegate_implements_the_callbacks_only_when_observed() {
        for sel in [
            objc2::sel!(application:didFinishLaunchingWithOptions:),
            objc2::sel!(application:didRegisterForRemoteNotificationsWithDeviceToken:),
            objc2::sel!(application:didFailToRegisterForRemoteNotificationsWithError:),
            objc2::sel!(application:didReceiveRemoteNotification:fetchCompletionHandler:),
        ] {
            assert!(
                AppDelegate::class().instance_method(sel).is_none(),
                "{sel:?}"
            );
            assert!(
                ObservedAppDelegate::class().instance_method(sel).is_some(),
                "{sel:?}"
            );
        }
        // No observer on this thread.
        assert!(std::ptr::eq(delegate_class(), AppDelegate::class()));
    }

    /// Several observers' results combine into the most significant one.
    #[test]
    fn fetch_results_combine_by_significance() {
        use FetchResult::*;
        assert_eq!(NoData.merge(NoData), NoData);
        assert_eq!(NoData.merge(Failed), Failed);
        assert_eq!(Failed.merge(NoData), Failed);
        assert_eq!(Failed.merge(NewData), NewData);
        assert_eq!(NewData.merge(Failed), NewData);
        assert_eq!(FetchResult::default(), NoData);
    }

    /// A payload reads as JSON, booleans included; a value JSON has no form
    /// for reads as `null`, keeping the rest, and only an absent key as
    /// `None`.
    #[test]
    fn a_dictionary_reads_as_json() {
        let aps = dictionary(&[("badge", object(NSNumber::new_i32(3)))]);
        let url = NSURL::URLWithString(&NSString::from_str("https://example.com/a")).unwrap();
        let payload = dictionary(&[
            ("aps", object(aps)),
            ("chat", object(NSString::from_str("42"))),
            ("silent", object(NSNumber::new_bool(true))),
        ]);
        let payload = NativeDictionary(&payload);
        assert_eq!(
            payload.to_json(),
            serde_json::json!({ "aps": { "badge": 3 }, "chat": "42", "silent": true })
        );
        assert_eq!(payload.get("aps"), Some(serde_json::json!({ "badge": 3 })));
        assert_eq!(payload.get("chat"), Some(serde_json::json!("42")));
        assert_eq!(payload.get("silent"), Some(serde_json::json!(true)));
        assert_eq!(payload.get("missing"), None);

        let options = dictionary(&[
            ("url", object(url)),
            ("source", object(NSString::from_str("com.example.other"))),
        ]);
        let options = NativeDictionary(&options);
        assert_eq!(options.get("url"), Some(JsonValue::Null));
        assert_eq!(options.get("missing"), None);
        assert_eq!(
            options.get("source"),
            Some(serde_json::json!("com.example.other"))
        );
        assert_eq!(
            options.to_json(),
            serde_json::json!({ "url": null, "source": "com.example.other" })
        );
        assert_eq!(
            options.as_ptr().as_ptr().cast_const(),
            (options.0 as *const NSDictionary).cast()
        );
    }
}
