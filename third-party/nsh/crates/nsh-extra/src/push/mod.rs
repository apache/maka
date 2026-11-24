//! `Push` (feature `push`): remote notifications. The app registers the
//! device ([`register`]) and gets the token a push service addresses it
//! with; the notifications that arrive while it is in front, the
//! background deliveries and the presses of notifications come as events,
//! in JS through `Push.on` and in Rust through [`on_event`]. The module is
//! generic: it works with any push service, and a push service's SDK
//! binding builds on its Rust API (the token's raw bytes, every event).
//!
//! From JS the module needs the `notifications` capability, as `nsh`'s
//! `Notifications` does: the device's token, the deliveries (their payloads
//! are the app's, whichever VM listens), how they show and the delivered
//! ones `closeThread` removes are process-wide, so every function of
//! `Push` but `available` checks the calling VM's grant first
//! ([`granted`]) and fails with `ERR_ACCESS_DENIED` without it. The
//! system's permission does not stand in for it: registering and
//! background deliveries ask the user nothing, and what the user allowed
//! is the whole app's. The Rust API is native code, which is not checked.
//!
//! Showing notifications needs the user's permission, which the app asks
//! with `Notifications.requestPermission` (`nsh`'s); background deliveries
//! need none. A notification the app removes by its id goes with
//! `Notifications.close`; [`close_thread`] removes those grouped in a
//! thread.
//!
//! On iOS (`ios.rs`) the module observes a standalone app's application
//! delegate (`nsh_platform_ios::on_application_event`), set up in the
//! crate's `#[native_module]` entry before the app launches, and once the
//! app launches it handles the notifications NSH did not show
//! (`nsh_platform_apple::notifications::set_foreign_handler`, which keeps
//! the press that launched the app until then).
//!
//! Android has no push of its own that every device has: an app receives
//! remote notifications through a push service's SDK, whose Rust binding
//! is the module's [`PushProvider`] ([`set_provider`]). The binding
//! registers the device with its service and reports what the service
//! delivers through the `provide_*` functions; the module does the rest,
//! the same as on iOS. Android (`android.rs`) closes a thread's
//! notifications itself, and hears the presses of the notifications NSH
//! did not show from `nsh_platform_android::notifications::set_foreign_handler`
//! (the core keeps the press that started the app until then).
//!
//! Elsewhere (the desktops, the web, headless runs, Mac Catalyst, an app
//! that embeds NSH in its own UIKit app and keeps its own delegate), and on
//! Android without a binding, [`available`] is false and the functions
//! that ask the system fail with [`UNAVAILABLE`].
//!
//! The packaged iOS app needs the `remote-notification` background mode,
//! which `nsh` adds from this crate's `[package.metadata.nsh.features.push]`.
//! The `aps-environment` entitlement comes from the provisioning profile
//! the app is signed with, which grants it with the environment the profile
//! is for. On Android the module needs nothing of the manifest: what a
//! push service needs (its service, its permissions) comes with its SDK.

#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "ios")]
mod ios;

use std::{
    cell::{Cell, RefCell},
    fmt,
    rc::{Rc, Weak},
    sync::{Arc, Mutex, MutexGuard, RwLock},
    task::Poll,
    time::Duration,
};

use nsh_core::{
    JsonValue,
    element::{Answer, CallbackRet, JsHost, JsIn, JsOwned, Local, PropError, TsTypes, codes},
    prelude::*,
    time::Instant,
};
use tokio::sync::{mpsc, oneshot};

#[cfg(target_os = "android")]
use self::android as platform;
#[cfg(target_os = "ios")]
use self::ios as platform;

/// The code of a request where there are no remote notifications.
pub const UNAVAILABLE: &str = codes::UNAVAILABLE;

/// How long after its arrival a background delivery waits for a JS
/// listener when none listens (the app was launched for it and its JS is
/// starting): after that the system hears it handled with nothing new.
pub(crate) const BACKGROUND_WAIT: Duration = Duration::from_secs(5);

/// How long after its arrival the JS listeners of a background delivery
/// have to settle: iOS gives the app about 30 seconds.
pub(crate) const BACKGROUND_LIMIT: Duration = Duration::from_secs(25);

/// How many presses wait for a JS listener; older ones are dropped.
const MAX_PENDING_PRESSES: usize = 16;

/// The token a push service addresses this device with. Opaque: the
/// string the push service takes ([`DeviceToken::as_str`]), and the bytes
/// the system gave ([`DeviceToken::as_bytes`]) for an SDK that takes those.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct DeviceToken {
    bytes: Vec<u8>,
    string: String,
}

impl DeviceToken {
    /// The token of `bytes` as iOS gives them; push services take them in
    /// lowercase hexadecimal.
    #[cfg_attr(not(any(target_os = "ios", test)), allow(dead_code))]
    pub(crate) fn from_bytes(bytes: impl Into<Vec<u8>>) -> Self {
        use fmt::Write;
        let bytes = bytes.into();
        let string = bytes.iter().fold(String::new(), |mut hex, byte| {
            let _ = write!(hex, "{byte:02x}");
            hex
        });
        Self { bytes, string }
    }

    /// The token a push service's SDK gave as `token`, a string (on
    /// Android), for [`provide_token`]. Its bytes are the string's.
    pub fn from_string(token: impl Into<String>) -> Self {
        let string = token.into();
        Self {
            bytes: string.as_bytes().to_vec(),
            string,
        }
    }

    /// The string the push service takes (hexadecimal on iOS).
    pub fn as_str(&self) -> &str {
        &self.string
    }

    /// The bytes the system gave, for an SDK that takes them as they are
    /// (a string's UTF-8 for a token made [`from_string`](Self::from_string)).
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }
}

impl fmt::Display for DeviceToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.string)
    }
}

/// A remote notification, or one that other native code of the app
/// scheduled: any notification `nsh`'s `Notifications` did not show.
#[derive(Debug, Clone, PartialEq, Default)]
#[non_exhaustive]
pub struct RemoteNotification {
    /// Its request's identifier, which `Notifications.close` removes it
    /// by; `""` for a background delivery, which has none.
    pub id: String,
    /// The thread it is grouped in, `""` for none: on iOS its thread
    /// identifier, on Android the group (`Notification.getGroup`) the
    /// push service's binding posts it in.
    pub thread_id: String,
    /// What the push service sent (on iOS the `aps` dictionary included,
    /// on Android the data its SDK gave) as JSON.
    pub payload: JsonValue,
}

impl RemoteNotification {
    /// A notification with the request identifier `id`, in `thread_id`.
    pub fn new(id: impl Into<String>, thread_id: impl Into<String>, payload: JsonValue) -> Self {
        Self {
            id: id.into(),
            thread_id: thread_id.into(),
            payload,
        }
    }

    /// A background delivery of `payload` from iOS: no request, its thread
    /// the one the payload names (`aps.thread-id`).
    #[cfg_attr(not(any(target_os = "ios", test)), allow(dead_code))]
    pub(crate) fn background(payload: JsonValue) -> Self {
        let thread_id = payload
            .get("aps")
            .and_then(|aps| aps.get("thread-id"))
            .and_then(JsonValue::as_str)
            .unwrap_or_default()
            .to_owned();
        Self {
            id: String::new(),
            thread_id,
            payload,
        }
    }
}

/// How a notification that arrives while the app is in front shows
/// ([`set_foreground_presentation`]). By default it shows as it does while
/// the app is behind, as the notifications `Notifications` shows do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, JsObject)]
#[non_exhaustive]
pub struct ForegroundPresentation {
    /// It shows as a banner.
    pub banner: bool,
    /// It stays in the notification list.
    pub list: bool,
    /// Its sound plays.
    pub sound: bool,
    /// Its badge applies to the app's icon.
    pub badge: bool,
}

impl ForegroundPresentation {
    /// Shown in every way: the default.
    pub(crate) const SHOWN: Self = Self {
        banner: true,
        list: true,
        sound: true,
        badge: true,
    };

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
}

impl Default for ForegroundPresentation {
    fn default() -> Self {
        Self::SHOWN
    }
}

/// How the work a background delivery started turned out, for the system
/// to schedule the app's later background launches.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
#[non_exhaustive]
pub enum BackgroundResult {
    /// New data was downloaded.
    NewData,
    /// There was nothing new.
    #[default]
    NoData,
    /// The work failed.
    Failed,
}

impl BackgroundResult {
    /// The result of two pieces of work: new data over a failure, a
    /// failure over nothing new.
    pub fn merge(self, other: Self) -> Self {
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
}

/// The completion of a background delivery ([`PushEvent::Background`]).
///
/// Clone it to keep it across asynchronous work; it can move to any
/// thread. The system hears once, when the last clone is dropped, with the
/// most significant result reported ([`BackgroundCompletion::set_result`]),
/// so code that does no work need not touch it.
#[derive(Clone)]
pub struct BackgroundCompletion(Arc<Completion>);

/// Tells the system how a background delivery's work turned out.
type Finish = Box<dyn FnOnce(BackgroundResult) + Send>;

struct Completion {
    result: Mutex<BackgroundResult>,
    finish: Mutex<Option<Finish>>,
}

impl BackgroundCompletion {
    /// A completion that calls `finish` with the result once the last
    /// clone is dropped: the platform's, or one a test of code that
    /// receives completions makes.
    pub fn new(finish: impl FnOnce(BackgroundResult) + Send + 'static) -> Self {
        Self(Arc::new(Completion {
            result: Mutex::new(BackgroundResult::default()),
            finish: Mutex::new(Some(Box::new(finish))),
        }))
    }

    /// Reports how this piece of work turned out. Results combine: new data
    /// wins over a failure, a failure over nothing new
    /// ([`BackgroundResult::NoData`], the result when nobody reports one).
    pub fn set_result(&self, result: BackgroundResult) {
        let mut current = self.0.result.lock().unwrap_or_else(|e| e.into_inner());
        *current = current.merge(result);
    }
}

impl fmt::Debug for BackgroundCompletion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let result = *self.0.result.lock().unwrap_or_else(|e| e.into_inner());
        f.debug_struct("BackgroundCompletion")
            .field("result", &result)
            .finish()
    }
}

impl Drop for Completion {
    fn drop(&mut self) {
        let result = *self.result.get_mut().unwrap_or_else(|e| e.into_inner());
        if let Some(finish) = self
            .finish
            .get_mut()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            finish(result);
        }
    }
}

/// Why a request of the module failed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct PushError {
    /// A stable code the app can branch on ([`UNAVAILABLE`]); `None` for
    /// other failures, such as the system's refusal to register.
    pub code: Option<String>,
    /// What went wrong, in words.
    pub message: String,
}

impl PushError {
    /// A failure with `message` and no code.
    pub(crate) fn failed(message: impl Into<String>) -> Self {
        Self {
            code: None,
            message: message.into(),
        }
    }

    /// There are no remote notifications here ([`UNAVAILABLE`]).
    pub(crate) fn unavailable(message: impl Into<String>) -> Self {
        Self {
            code: Some(UNAVAILABLE.into()),
            message: message.into(),
        }
    }

    /// How JS gets it: an `Error` with its `code`.
    fn to_js(&self) -> JsError {
        match &self.code {
            Some(code) => JsError::Error(self.message.clone()).with_code(code),
            None => JsError::Error(self.message.clone()),
        }
    }
}

impl fmt::Display for PushError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for PushError {}

/// What the module reports to Rust code ([`on_event`]), on the thread the
/// platform or the provider reports from (on iOS the main thread).
#[derive(Debug)]
#[non_exhaustive]
pub enum PushEvent<'a> {
    /// The device was registered. Every registration reports its token,
    /// the same one again included.
    Token(&'a DeviceToken),
    /// The device could not be registered.
    RegistrationFailed(&'a PushError),
    /// A notification arrived while the app is in front; it shows as the
    /// presentation settings say ([`thread_presentation`],
    /// [`set_foreground_presentation_decider`]).
    Notification(&'a RemoteNotification),
    /// A delivery woke the app or reached it in front (on iOS one with
    /// `content-available`; a visible one arriving in front is also a
    /// [`PushEvent::Notification`]): work that keeps the completion
    /// reports when it is done.
    Background {
        /// What was delivered.
        notification: &'a RemoteNotification,
        /// Tells the system when the work is done.
        completion: &'a BackgroundCompletion,
    },
    /// The user pressed a notification, which may have launched the app.
    Press(&'a RemoteNotification),
}

type Observer = Arc<dyn Fn(&PushEvent<'_>) + Send + Sync>;

/// The Rust observers ([`on_event`]).
static OBSERVERS: RwLock<Vec<Observer>> = RwLock::new(Vec::new());

/// Adds an observer of the module's events ([`PushEvent`]), for native
/// code such as a push service's SDK binding: it hands the token to the
/// SDK and the notifications to its handlers. The events come on the
/// thread they are reported from (on iOS the main thread), every one,
/// whether JS listens or not. Add it from a `#[native_module]` entry,
/// before the app launches, to hear the press that launches it. An SDK
/// that wants the launch options on iOS observes
/// `nsh_platform_ios::on_application_event` (`Launched { options }`).
pub fn on_event(observer: impl Fn(&PushEvent<'_>) + Send + Sync + 'static) {
    OBSERVERS
        .write()
        .unwrap_or_else(|e| e.into_inner())
        .push(Arc::new(observer));
}

/// Reports `event` to the Rust observers.
fn emit(event: &PushEvent<'_>) {
    // A copy of the list, so that an observer may add another.
    let observers = OBSERVERS.read().unwrap_or_else(|e| e.into_inner()).clone();
    for observer in observers {
        observer(event);
    }
}

/// Decides how one notification arriving in front shows, from what the
/// settings give it ([`set_foreground_presentation_decider`]).
pub type PresentationDecider = Arc<
    dyn Fn(&RemoteNotification, ForegroundPresentation) -> ForegroundPresentation + Send + Sync,
>;

/// The Rust decider of foreground presentations.
static DECIDER: RwLock<Option<PresentationDecider>> = RwLock::new(None);

/// A push service's binding, where the system has no push of its own
/// (Android): it registers the device with the service and reports what
/// the service delivers through [`provide_token`],
/// [`provide_registration_failure`], [`provide_notification`] and
/// [`provide_background`]. The presses of the notifications it posts
/// come from the system, as on iOS: they open the app with their payload.
pub trait PushProvider: Send + Sync {
    /// Asks the push service for this device's token. The answer comes
    /// later, from any thread, through [`provide_token`] or
    /// [`provide_registration_failure`].
    fn register(&self);
}

/// The push service's binding ([`set_provider`]).
static PROVIDER: RwLock<Option<Arc<dyn PushProvider>>> = RwLock::new(None);

/// Makes `provider` the push service the module registers with, from now
/// on (`None`: none). Where the system has push of its own (iOS), a
/// provider takes over registering from it. Set it from the binding's
/// `#[native_module]` entry, before the app launches. Process-wide; a
/// later one replaces the earlier.
pub fn set_provider(provider: Option<Arc<dyn PushProvider>>) {
    *PROVIDER.write().unwrap_or_else(|e| e.into_inner()) = provider;
}

fn provider() -> Option<Arc<dyn PushProvider>> {
    PROVIDER.read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Whether remote notifications work here: in a standalone iOS app
/// (`nsh_platform_ios::run_app`), whose application delegate the module
/// observes, and wherever a push service's binding is set
/// ([`set_provider`]; on Android the only way). In a task.
pub async fn available() -> bool {
    hub().launched || provider().is_some()
}

/// Registers the device for remote notifications and resolves with its
/// token, which the app hands to its push service: the system's push on
/// iOS, else the binding's ([`set_provider`]). The answer comes once the
/// service can be reached, so offline this waits: code that must not wait
/// hears the token through [`on_event`] instead. Registering does not ask
/// the user: showing notifications needs the permission `Notifications`
/// asks for, background deliveries do not. Register at every launch, as
/// the token can change ([`PushEvent::Token`] and `Push.on("token")` report
/// a new one). In a task.
pub async fn register() -> Result<DeviceToken, PushError> {
    let provider = provider();
    if provider.is_none() && !hub().launched {
        return Err(PushError::unavailable(platform::UNAVAILABLE));
    }
    let (answer, token) = oneshot::channel();
    hub().registering.push(answer);
    let asked = match provider {
        Some(provider) => {
            provider.register();
            Ok(())
        }
        None => platform::register().await,
    };
    if let Err(error) = asked {
        drop(token);
        hub().registering.retain(|answer| !answer.is_closed());
        return Err(error);
    }
    match token.await {
        Ok(token) => token,
        Err(_) => Err(PushError::failed("the registration went away unanswered")),
    }
}

/// The token of this device's last registration in this run, if any.
pub fn token() -> Option<DeviceToken> {
    hub().token.clone()
}

/// How a notification that arrives in front shows, unless its thread has
/// its own ([`set_thread_presentation`]).
pub fn foreground_presentation() -> ForegroundPresentation {
    hub().presentation
}

/// Shows the notifications that arrive while the app is in front as
/// `presentation` says, from now on, unless their thread has its own
/// ([`set_thread_presentation`]). The system asks at once, so it is decided
/// before they come. Process-wide: it holds for every surface of the app.
pub fn set_foreground_presentation(presentation: ForegroundPresentation) {
    hub().presentation = presentation;
}

/// How a notification of `thread_id` that arrives in front shows: its
/// thread's own presentation, else [`foreground_presentation`].
pub fn thread_presentation(thread_id: &str) -> ForegroundPresentation {
    hub().presentation_of(thread_id)
}

/// Shows the notifications of `thread_id` that arrive in front as
/// `presentation` says, whatever [`foreground_presentation`] is (no banner
/// for the conversation that is open); `None` gives the thread back to it.
/// Process-wide, as [`set_foreground_presentation`].
pub fn set_thread_presentation(
    thread_id: impl Into<String>,
    presentation: Option<ForegroundPresentation>,
) {
    hub().set_thread_presentation(thread_id.into(), presentation);
}

/// Decides how each notification arriving in front shows, from what the
/// presentation settings give it ([`thread_presentation`]): Rust code that
/// knows more, such as the screen that is open. It runs on the main thread
/// while the system waits, so it answers at once and never waits for JS.
/// `None` leaves it to the settings. Process-wide; a later one replaces
/// the earlier.
pub fn set_foreground_presentation_decider(decider: Option<PresentationDecider>) {
    *DECIDER.write().unwrap_or_else(|e| e.into_inner()) = decider;
}

/// Removes the delivered notifications grouped in `thread_id` (on Android
/// a notification group, with or without a push service's binding), but
/// those `Notifications` showed. On Android, once the app made its first
/// view. In a task.
pub async fn close_thread(thread_id: impl Into<String>) -> Result<(), PushError> {
    let thread_id = thread_id.into();
    if thread_id.is_empty() {
        return Err(PushError::failed("a thread is named by a non-empty id"));
    }
    platform::close_thread(thread_id).await
}

/// The keys of the notifications of `delivered` (`(key, thread, shown by
/// Notifications)`) grouped in `thread_id`, but those `Notifications`
/// showed. An empty `thread_id` names no thread.
#[cfg_attr(
    not(any(target_os = "ios", target_os = "android", test)),
    allow(dead_code)
)]
pub(crate) fn in_thread<'a, K>(
    delivered: impl IntoIterator<Item = (K, &'a str, bool)>,
    thread_id: &str,
) -> Vec<K> {
    if thread_id.is_empty() {
        return Vec::new();
    }
    delivered
        .into_iter()
        .filter(|(_, thread, own)| !own && *thread == thread_id)
        .map(|(key, _, _)| key)
        .collect()
}

/// Where NSH has no remote notifications: the desktops, the web, headless
/// runs.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
mod platform {
    use super::PushError;

    pub(super) const UNAVAILABLE: &str = "there are no remote notifications here";

    pub(super) fn install(_: &mut nsh_core::element::Registry) {}

    pub(super) async fn register() -> Result<(), PushError> {
        Err(PushError::unavailable(UNAVAILABLE))
    }

    pub(super) async fn close_thread(_: String) -> Result<(), PushError> {
        Err(PushError::unavailable(UNAVAILABLE))
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) use super::expire_later;

    /// The web has no thread to wait on (and no push service's binding):
    /// a delivery that waits is completed when a listener takes it.
    #[cfg(target_arch = "wasm32")]
    pub(super) fn expire_later() {}
}

/// Sets the module up with the platform: called by the crate's
/// `#[native_module]` entry for `registry`, the set it makes. On iOS that
/// is on the main thread before the app launches; on Android on the thread
/// that loads the app (the UI thread, another one on a development
/// reload).
pub(crate) fn install(registry: &mut Registry) {
    platform::install(registry);
}

// --- What a push service's binding reports ----------------------------------

/// The push service registered the device with `token` (the binding's
/// [`PushProvider::register`], or a token the service changed). Any thread.
pub fn provide_token(token: DeviceToken) {
    registered(token);
}

/// The push service could not register the device, for the reason
/// `message`. Any thread.
pub fn provide_registration_failure(message: &str) {
    registration_failed(message);
}

/// `notification` arrived while the app is in front: how it shows, which
/// the binding follows when it posts it (heard by `Push.on("notification")`
/// and [`on_event`] either way). Any thread.
pub fn provide_notification(notification: RemoteNotification) -> ForegroundPresentation {
    arrived(notification)
}

/// A background delivery of `notification` arrived now. `completion`
/// hears what the listeners made of it, when the last of them is done,
/// [`BACKGROUND_WAIT`] after its arrival when none listened, and at the
/// latest [`BACKGROUND_LIMIT`] after it. Any thread.
pub fn provide_background(notification: RemoteNotification, completion: BackgroundCompletion) {
    background(notification, completion);
    platform::expire_later();
}

/// Completes the deliveries that wait for a JS listener once their wait
/// is over, on a thread of its own: the wait counts from the arrival
/// however often a delivery waits, so one check covers it.
#[cfg(not(any(target_os = "ios", target_arch = "wasm32")))]
fn expire_later() {
    let spawned = std::thread::Builder::new()
        .name("nsh-push-expiry".into())
        .spawn(|| {
            std::thread::sleep(BACKGROUND_WAIT + Duration::from_millis(100));
            expire_pending();
        });
    if let Err(error) = spawned {
        log::error!("push: cannot wait for a background delivery's listener: {error}");
    }
}

// --- What the platform reports ----------------------------------------------

/// The app launched with the module observing its application delegate.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
fn launched() {
    hub().launched = true;
}

/// The device was registered with `token`.
fn registered(token: DeviceToken) {
    let answers = hub().registered(&token);
    for answer in answers {
        let _ = answer.send(Ok(token.clone()));
    }
    emit(&PushEvent::Token(&token));
}

/// The device could not be registered.
fn registration_failed(message: &str) {
    let error = PushError::failed(format!("the device was not registered: {message}"));
    log::warn!("push: {error}");
    let answers = std::mem::take(&mut hub().registering);
    for answer in answers {
        let _ = answer.send(Err(error.clone()));
    }
    emit(&PushEvent::RegistrationFailed(&error));
}

/// `notification` arrived while the app is in front: how it shows.
fn arrived(notification: RemoteNotification) -> ForegroundPresentation {
    emit(&PushEvent::Notification(&notification));
    let presentation = hub().presentation_of(&notification.thread_id);
    // Outside the hub's lock: the decider may read the settings.
    let decider = DECIDER.read().unwrap_or_else(|e| e.into_inner()).clone();
    let presentation = match decider {
        Some(decide) => decide(&notification, presentation),
        None => presentation,
    };
    let lost = hub().dispatch(Delivery::Notification(notification), now());
    drop(lost);
    presentation
}

/// A background delivery of `notification` that arrived now, which
/// `completion` reports.
fn background(notification: RemoteNotification, completion: BackgroundCompletion) {
    emit(&PushEvent::Background {
        notification: &notification,
        completion: &completion,
    });
    let at = now();
    let lost = hub().dispatch(Delivery::Background(notification, completion, at), at);
    // Outside the hub's lock: the completion may tell the system now.
    drop(lost);
}

/// The user pressed `notification`.
#[cfg_attr(
    not(any(target_os = "ios", target_os = "android", test)),
    allow(dead_code)
)]
fn pressed(notification: RemoteNotification) {
    emit(&PushEvent::Press(&notification));
    let lost = hub().dispatch(Delivery::Press(notification), now());
    drop(lost);
}

/// Completes the background deliveries that waited for a JS listener
/// [`BACKGROUND_WAIT`] since they arrived.
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
fn expire_pending() {
    let expired = hub().expire(now());
    if !expired.is_empty() {
        log::info!(
            "push: {} background deliveries had no listener",
            expired.len()
        );
    }
    drop(expired);
}

fn now() -> Instant {
    nsh_core::time::now()
}

// --- The hub: what the platform reported, on its way to JS ------------------

/// The events JS listens to, as bits of a subscriber's interests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Token = 1,
    Notification = 2,
    Background = 4,
    Press = 8,
}

/// An event on its way to a VM.
#[derive(Debug)]
enum Delivery {
    Token(DeviceToken),
    Notification(RemoteNotification),
    /// With the instant it arrived, which its waits count from.
    Background(RemoteNotification, BackgroundCompletion, Instant),
    Press(RemoteNotification),
}

impl Delivery {
    fn kind(&self) -> Kind {
        match self {
            Self::Token(_) => Kind::Token,
            Self::Notification(_) => Kind::Notification,
            Self::Background(..) => Kind::Background,
            Self::Press(_) => Kind::Press,
        }
    }

    /// A copy for one more VM: the completion of a background delivery is
    /// shared, so the system hears once every VM is done.
    fn copy(&self) -> Self {
        match self {
            Self::Token(token) => Self::Token(token.clone()),
            Self::Notification(n) => Self::Notification(n.clone()),
            Self::Background(n, completion, at) => {
                Self::Background(n.clone(), completion.clone(), *at)
            }
            Self::Press(n) => Self::Press(n.clone()),
        }
    }

    /// Whether it is a background delivery that waited for a listener as
    /// long as it may at `now`.
    fn expired(&self, now: Instant) -> bool {
        matches!(self, Self::Background(_, _, at) if now.saturating_duration_since(*at) >= BACKGROUND_WAIT)
    }
}

/// A VM listening to the module's events (`Push.on`).
struct Subscriber {
    id: u64,
    /// The [`Kind`]s it has listeners of.
    kinds: u8,
    sender: mpsc::UnboundedSender<Delivery>,
}

/// The module's state, process-wide: the platform reports on the main
/// thread and every VM's `Push` reads it. Nothing dropped under its lock
/// takes it again (a [`BackgroundCompletion`] tells the system without
/// it); what no VM will get is handed back to drop outside it all the
/// same, so the system hears without waiting for the lock.
struct Hub {
    /// The module observes a standalone app's delegate ([`available`]).
    launched: bool,
    /// The last token of this run.
    token: Option<DeviceToken>,
    /// The registrations waiting for the system's answer.
    registering: Vec<oneshot::Sender<Result<DeviceToken, PushError>>>,
    /// How notifications in front show ([`set_foreground_presentation`]).
    presentation: ForegroundPresentation,
    /// The threads that show their own way ([`set_thread_presentation`]).
    threads: Vec<(String, ForegroundPresentation)>,
    subscribers: Vec<Subscriber>,
    next_subscriber: u64,
    /// Presses and background deliveries no VM listened to yet, in order.
    pending: Vec<Delivery>,
}

static HUB: Mutex<Hub> = Mutex::new(Hub::new());

fn hub() -> MutexGuard<'static, Hub> {
    HUB.lock().unwrap_or_else(|e| e.into_inner())
}

impl Hub {
    const fn new() -> Self {
        Self {
            launched: false,
            token: None,
            registering: Vec::new(),
            presentation: ForegroundPresentation::SHOWN,
            threads: Vec::new(),
            subscribers: Vec::new(),
            next_subscriber: 0,
            pending: Vec::new(),
        }
    }

    /// How a notification of `thread_id` shows in front.
    fn presentation_of(&self, thread_id: &str) -> ForegroundPresentation {
        self.threads
            .iter()
            .find(|(thread, _)| !thread_id.is_empty() && thread == thread_id)
            .map_or(self.presentation, |(_, presentation)| *presentation)
    }

    fn set_thread_presentation(
        &mut self,
        thread_id: String,
        presentation: Option<ForegroundPresentation>,
    ) {
        self.threads.retain(|(thread, _)| *thread != thread_id);
        if let Some(presentation) = presentation {
            self.threads.push((thread_id, presentation));
        }
    }

    /// Records the token of a registration: the registrations waiting for
    /// it, to answer; the VMs hear it when it differs from the last one.
    fn registered(
        &mut self,
        token: &DeviceToken,
    ) -> Vec<oneshot::Sender<Result<DeviceToken, PushError>>> {
        if self.token.as_ref() != Some(token) {
            self.token = Some(token.clone());
            drop(self.dispatch(Delivery::Token(token.clone()), now()));
        }
        std::mem::take(&mut self.registering)
    }

    /// Hands `delivery` to the VMs listening to its kind. When none does,
    /// a press, and a background delivery still within its wait, wait for
    /// the first that will. Returns what no VM will get: the delivery when
    /// none took it and it does not wait (a token, a notification in
    /// front, a background delivery past its wait) and the oldest press
    /// when too many wait.
    #[must_use]
    fn dispatch(&mut self, delivery: Delivery, now: Instant) -> Vec<Delivery> {
        let kind = delivery.kind() as u8;
        let mut taken = false;
        // A VM that went is forgotten; the copy it did not take is one of
        // several, so dropping it tells the system nothing.
        self.subscribers.retain(|subscriber| {
            if subscriber.kinds & kind == 0 {
                return true;
            }
            let sent = subscriber.sender.send(delivery.copy()).is_ok();
            taken |= sent;
            sent
        });
        let mut lost = Vec::new();
        if taken {
            // The VMs hold copies.
            drop(delivery);
            return lost;
        }
        match delivery {
            delivery @ Delivery::Press(_) => {
                let presses = self
                    .pending
                    .iter()
                    .filter(|d| matches!(d, Delivery::Press(_)))
                    .count();
                if presses >= MAX_PENDING_PRESSES
                    && let Some(oldest) = self
                        .pending
                        .iter()
                        .position(|d| matches!(d, Delivery::Press(_)))
                {
                    lost.push(self.pending.remove(oldest));
                }
                self.pending.push(delivery);
            }
            delivery @ Delivery::Background(..) if !delivery.expired(now) => {
                self.pending.push(delivery);
            }
            delivery => lost.push(delivery),
        }
        lost
    }

    /// A new VM's subscription, which listens to nothing yet.
    fn subscribe(&mut self) -> (u64, mpsc::UnboundedReceiver<Delivery>) {
        let id = self.next_subscriber;
        self.next_subscriber += 1;
        let (sender, receiver) = mpsc::unbounded_channel();
        self.subscribers.push(Subscriber {
            id,
            kinds: 0,
            sender,
        });
        (id, receiver)
    }

    /// Subscriber `id` listens to `kind` now: it takes what waited for it.
    fn listen(&mut self, id: u64, kind: Kind) {
        let Some(subscriber) = self.subscribers.iter_mut().find(|s| s.id == id) else {
            return;
        };
        subscriber.kinds |= kind as u8;
        let (waited, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut self.pending)
            .into_iter()
            .partition(|d| d.kind() == kind);
        self.pending = rest;
        for delivery in waited {
            // The VM is the one listening now: it takes them.
            let _ = subscriber.sender.send(delivery);
        }
    }

    /// Subscriber `id` no longer listens to `kind`.
    fn unlisten(&mut self, id: u64, kind: Kind) {
        if let Some(subscriber) = self.subscribers.iter_mut().find(|s| s.id == id) {
            subscriber.kinds &= !(kind as u8);
        }
    }

    /// Subscriber `id`'s VM went.
    fn unsubscribe(&mut self, id: u64) {
        self.subscribers.retain(|s| s.id != id);
    }

    /// Takes the background deliveries that waited for a listener
    /// [`BACKGROUND_WAIT`] since they arrived, at `now`, to drop outside
    /// the lock.
    #[must_use]
    fn expire(&mut self, now: Instant) -> Vec<Delivery> {
        let (expired, rest) = std::mem::take(&mut self.pending)
            .into_iter()
            .partition(|d| d.expired(now));
        self.pending = rest;
        expired
    }
}

// --- JS ---------------------------------------------------------------------

/// Whether the calling VM may use remote notifications: why not when it
/// may not. The module's state is the process's (the token, the hub every
/// VM's listeners subscribe to, the presentation settings, the delivered
/// notifications), so this check in each call is all that keeps a VM
/// without the grant from it.
fn granted(sys: &System) -> Result<(), JsError> {
    if sys.access.allows_notifications() {
        return Ok(());
    }
    Err(JsError::access_denied(
        "remote notifications are not granted: add `\"notifications\": true` to capabilities in nsh.json",
        "notifications",
        "",
    ))
}

/// Remote notifications. Needs the `notifications` capability when the app
/// declares capabilities: without it every function but `available`
/// rejects or throws `ERR_ACCESS_DENIED` (checked here, in the call).
#[module]
pub(crate) struct Push;

#[module]
impl Push {
    /// Resolves with whether remote notifications work here: `true` in a
    /// standalone iOS app and wherever the app links a push service's
    /// binding (on Android the only way), `false` elsewhere (the desktops,
    /// the web, Mac Catalyst, an app that embeds NSH in its own iOS app),
    /// where `register` rejects with `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`.
    /// It tells the platform only, so it needs no capability.
    pub(crate) async fn available() -> bool {
        crate::push::available().await
    }

    /// Registers the device for remote notifications and resolves with its
    /// token: the string the push service takes (hexadecimal on iOS),
    /// which the app hands to it. The service answers once it can be
    /// reached, so offline the promise stays pending: listen to
    /// `on("token")` first and do not wait on the result. It does not ask
    /// the user: showing notifications needs
    /// `Notifications.requestPermission`, background deliveries do not.
    /// Register at every launch: the token can change, and `on("token")`
    /// reports a new one. Rejects with the service's reason when it refuses
    /// (an iOS app signed without the `aps-environment` entitlement), with
    /// `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` where `available()` is false,
    /// and with `ERR_ACCESS_DENIED` when the `notifications` capability is
    /// not granted.
    pub(crate) async fn register(sys: System) -> Result<PushToken, JsError> {
        granted(&sys)?;
        match crate::push::register().await {
            Ok(token) => Ok(PushToken::from(&token)),
            Err(error) => Err(error.to_js()),
        }
    }

    /// The token of the device's last registration in this run; `null`
    /// before one. Throws `ERR_ACCESS_DENIED` when the `notifications`
    /// capability is not granted.
    pub(crate) fn token(sys: System) -> Result<Option<PushToken>, JsError> {
        granted(&sys)?;
        Ok(crate::push::token().as_ref().map(PushToken::from))
    }

    /// How a notification that arrives while the app is in front shows:
    /// one of the thread `threadId` when given (its own presentation, else
    /// the app's). Throws `ERR_ACCESS_DENIED` when the `notifications`
    /// capability is not granted, and a `RangeError` for an empty
    /// `threadId`.
    pub(crate) fn foreground_presentation(
        thread: Option<ForegroundPresentationThread>,
        sys: System,
    ) -> Result<ForegroundPresentation, JsError> {
        granted(&sys)?;
        Ok(match thread {
            Some(thread) => crate::push::thread_presentation(&thread.id()?),
            None => crate::push::foreground_presentation(),
        })
    }

    /// Shows the notifications that arrive while the app is in front as
    /// `presentation` says, from now on; what it leaves out shows, and
    /// `null` shows them all again. With `{ threadId }` it is how the
    /// notifications of that thread show, whatever the app's is (no banner
    /// for the conversation that is open), and `null` gives the thread back
    /// to the app's. The system asks as they arrive, without waiting for
    /// JS, so it is set before. Process-wide: it holds for every surface of
    /// the app. They are reported to `on("notification")` either way.
    /// Throws `ERR_ACCESS_DENIED` when the `notifications` capability is
    /// not granted, and a `RangeError` for an empty `threadId`.
    pub(crate) fn set_foreground_presentation(
        presentation: Option<ForegroundPresentationOptions>,
        thread: Option<ForegroundPresentationThread>,
        sys: System,
    ) -> Result<(), JsError> {
        granted(&sys)?;
        let presentation = presentation.map(ForegroundPresentationOptions::presentation);
        match thread {
            Some(thread) => crate::push::set_thread_presentation(thread.id()?, presentation),
            None => crate::push::set_foreground_presentation(presentation.unwrap_or_default()),
        }
        Ok(())
    }

    /// Removes the delivered notifications grouped in the thread
    /// `threadId` (on iOS the `thread-id` the push service sent, on Android
    /// the group they were posted in), but those `Notifications.show`
    /// showed. `Notifications.close(id)` removes one by its `id`. Rejects
    /// with `ERR_ACCESS_DENIED` when the `notifications` capability is not
    /// granted, with a `RangeError` for an empty `threadId`, and with
    /// `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` where there are no remote
    /// notifications (Android, which has its notifications' groups, needs
    /// no push service's binding for this).
    pub(crate) async fn close_thread(thread_id: String, sys: System) -> Result<(), JsError> {
        granted(&sys)?;
        if thread_id.is_empty() {
            return Err(JsError::Range(
                "Push.closeThread: `threadId` must not be empty".into(),
            ));
        }
        crate::push::close_thread(thread_id)
            .await
            .map_err(|error| error.to_js())
    }

    /// Listens to `event`. `token`: a registration gave a token that
    /// differs from the last one of this run (the first included).
    /// `notification`: a notification arrived while the app is in front;
    /// it shows as `setForegroundPresentation` says. `press`: the user
    /// pressed a notification (the app comes to the front); presses that
    /// came while nothing listened, the one that launched the app
    /// included, go to the next listener (at most 16). `background`: a
    /// delivery woke the app or reached it in front (on iOS one with
    /// `content-available`; one that is also visible, arriving in front,
    /// is a `notification` too; on Android one its push service's binding
    /// hands over). The system waits for the listeners, so
    /// return a promise for the work and what it gave (`"newData"`,
    /// `"noData"` when nothing is returned, `"failed"`, as a thrown error
    /// is), within 25 seconds of the delivery. One that came while nothing
    /// listened waits for a listener until 5 seconds after it came. These
    /// are the notifications `Notifications` did not show: remote ones and
    /// those other native code scheduled. A payload is untrusted input.
    /// Returns a function that stops listening. Throws `ERR_ACCESS_DENIED`
    /// when the `notifications` capability is not granted.
    #[overload(fn(event: PushTokenEvent, #[args(token)] listener: Callback<PushToken>) -> Stop)]
    #[overload(fn(event: PushNotificationEvent, #[args(notification)] listener: Callback<PushNotification>) -> Stop)]
    #[overload(fn(event: PushPressEvent, #[args(press)] listener: Callback<PushNotification>) -> Stop)]
    #[overload(fn(event: PushBackgroundEvent, #[args(background)] listener: Callback<PushBackground, BackgroundReturn>) -> Stop)]
    pub(crate) fn on(
        event: PushEventName,
        #[args(payload)] listener: Callback<Payload, BackgroundReturn>,
        sys: System,
        cx: CallCx<'_>,
    ) -> Result<Stop, JsError> {
        // Before the VM subscribes to the hub: a subscriber gets every
        // delivery of the kinds it listens to, and takes those that waited.
        granted(&sys)?;
        let kind = event.kind();
        let listeners = sys.locals.get::<Listeners>();
        let id = listeners.next.get();
        listeners.next.set(id.wrapping_add(1));
        let first = listeners.of(kind).borrow().is_empty();
        listeners.of(kind).borrow_mut().push((id, listener));
        let subscriber = listeners.subscriber(&cx);
        if first {
            hub().listen(subscriber, kind);
        }
        let listeners = Rc::downgrade(&listeners);
        Ok(Stop::new(move || {
            let Some(listeners) = listeners.upgrade() else {
                return;
            };
            let mut list = listeners.of(kind).borrow_mut();
            list.retain(|(i, _)| *i != id);
            if list.is_empty()
                && let Some(subscriber) = listeners.subscriber.get()
            {
                hub().unlisten(subscriber, kind);
            }
        }))
    }
}

/// How notifications in front show (`setForegroundPresentation`); what is
/// left out shows.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub(crate) struct ForegroundPresentationOptions {
    /// It shows as a banner (true when not given).
    pub(crate) banner: Option<bool>,
    /// It stays in the notification list (true when not given).
    pub(crate) list: Option<bool>,
    /// Its sound plays (true when not given).
    pub(crate) sound: Option<bool>,
    /// Its badge applies to the app's icon (true when not given).
    pub(crate) badge: Option<bool>,
}

impl ForegroundPresentationOptions {
    fn presentation(self) -> ForegroundPresentation {
        ForegroundPresentation::SHOWN
            .banner(self.banner.unwrap_or(true))
            .list(self.list.unwrap_or(true))
            .sound(self.sound.unwrap_or(true))
            .badge(self.badge.unwrap_or(true))
    }
}

/// The thread a foreground presentation is for.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub(crate) struct ForegroundPresentationThread {
    /// The thread's id (the `thread-id` the push service sends).
    pub(crate) thread_id: String,
}

impl ForegroundPresentationThread {
    /// The thread's id, which names a thread only when not empty.
    fn id(self) -> Result<String, JsError> {
        if self.thread_id.is_empty() {
            return Err(JsError::Range("Push: `threadId` must not be empty".into()));
        }
        Ok(self.thread_id)
    }
}

/// `Push.on`'s events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub(crate) enum PushEventName {
    /// A registration gave a new token.
    #[default]
    Token,
    /// A notification arrived in front.
    Notification,
    /// The user pressed a notification.
    Press,
    /// A background delivery.
    Background,
}

impl PushEventName {
    fn kind(self) -> Kind {
        match self {
            Self::Token => Kind::Token,
            Self::Notification => Kind::Notification,
            Self::Press => Kind::Press,
            Self::Background => Kind::Background,
        }
    }
}

/// The event a token comes with (`on`'s first overload).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub(crate) enum PushTokenEvent {
    Token,
}

/// The event a notification in front comes with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub(crate) enum PushNotificationEvent {
    Notification,
}

/// The event a press comes with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub(crate) enum PushPressEvent {
    Press,
}

/// The event a background delivery comes with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub(crate) enum PushBackgroundEvent {
    Background,
}

/// A token (`register()`, `token()` and the `token` event).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub(crate) struct PushToken {
    /// The string the push service takes (hexadecimal on iOS).
    token: String,
}

impl From<&DeviceToken> for PushToken {
    fn from(token: &DeviceToken) -> Self {
        Self {
            token: token.as_str().to_owned(),
        }
    }
}

/// A notification that arrived in front or was pressed (the
/// `notification` and `press` events).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub(crate) struct PushNotification {
    /// Its request's identifier, which `Notifications.close` removes it
    /// by.
    id: String,
    /// The thread it is grouped in, `""` for none.
    thread_id: String,
    /// What the push service sent (on iOS the `aps` object included).
    payload: JsonValue,
}

impl From<RemoteNotification> for PushNotification {
    fn from(n: RemoteNotification) -> Self {
        Self {
            id: n.id,
            thread_id: n.thread_id,
            payload: n.payload,
        }
    }
}

/// A background delivery (the `background` event).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub(crate) struct PushBackground {
    /// The thread its payload names, `""` for none.
    thread_id: String,
    /// What the push service sent (on iOS the `aps` object included).
    payload: JsonValue,
}

impl From<RemoteNotification> for PushBackground {
    fn from(n: RemoteNotification) -> Self {
        Self {
            thread_id: n.thread_id,
            payload: n.payload,
        }
    }
}

/// What a listener gets.
#[derive(Debug, Clone)]
pub(crate) enum Payload {
    Token(PushToken),
    Notification(PushNotification),
    Background(PushBackground),
}

impl JsValue for Payload {
    fn ts_type(types: &mut TsTypes) -> String {
        format!(
            "{} | {} | {}",
            <PushToken as JsValue>::ts_type(types),
            <PushNotification as JsValue>::ts_type(types),
            <PushBackground as JsValue>::ts_type(types)
        )
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        Err(value.expected("no value (a payload goes to JS only)"))
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match self {
            Self::Token(token) => token.to_js(host),
            Self::Notification(notification) => notification.to_js(host),
            Self::Background(background) => background.to_js(host),
        }
    }
}

/// What a `background` listener returns: how its work turned out, or a
/// promise of it; nothing is `"noData"`.
pub(crate) struct BackgroundReturn(Option<BackgroundResult>);

impl CallbackRet for BackgroundReturn {
    fn ts_type(types: &mut TsTypes) -> String {
        let result = <BackgroundResult as JsValue>::ts_type(types);
        format!("void | {result} | Promise<void | {result}>")
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        if value.is_nullish() {
            return Ok(Self(None));
        }
        <BackgroundResult as JsValue>::from_js(value).map(|result| Self(Some(result)))
    }
}

type Listener = (u32, Callback<Payload, BackgroundReturn>);

/// The VM's `Push.on` listeners and its subscription to the hub.
#[derive(Default)]
struct Listeners {
    token: RefCell<Vec<Listener>>,
    notification: RefCell<Vec<Listener>>,
    background: RefCell<Vec<Listener>>,
    press: RefCell<Vec<Listener>>,
    next: Cell<u32>,
    subscriber: Cell<Option<u64>>,
    /// What the hub handed over, which the delivering task takes; kept
    /// here so that closing the VM gives what it did not post back.
    receiver: RefCell<Option<mpsc::UnboundedReceiver<Delivery>>>,
}

impl Listeners {
    fn of(&self, kind: Kind) -> &RefCell<Vec<Listener>> {
        match kind {
            Kind::Token => &self.token,
            Kind::Notification => &self.notification,
            Kind::Background => &self.background,
            Kind::Press => &self.press,
        }
    }

    /// The VM's subscription to the hub, made with the task that delivers
    /// what it hands over the first time.
    fn subscriber(self: &Rc<Self>, cx: &CallCx<'_>) -> u64 {
        if let Some(id) = self.subscriber.get() {
            return id;
        }
        let (id, receiver) = hub().subscribe();
        self.subscriber.set(Some(id));
        *self.receiver.borrow_mut() = Some(receiver);
        cx.start(deliver(Rc::downgrade(self)));
        id
    }
}

impl Local for Listeners {
    fn close(&self) {
        for kind in [
            Kind::Token,
            Kind::Notification,
            Kind::Background,
            Kind::Press,
        ] {
            self.of(kind).borrow_mut().clear();
        }
        if let Some(id) = self.subscriber.take() {
            hub().unsubscribe(id);
        }
        // What the VM did not post goes back to the hub: a press waits for
        // the next VM that listens (a reload), a background delivery too
        // while it may.
        let Some(mut receiver) = self.receiver.take() else {
            return;
        };
        receiver.close();
        while let Ok(delivery) = receiver.try_recv() {
            let lost = hub().dispatch(delivery, now());
            drop(lost);
        }
    }
}

/// The next delivery the hub handed `listeners`' VM; `None` once the VM
/// closed.
async fn next(listeners: &Weak<Listeners>) -> Option<Delivery> {
    std::future::poll_fn(|cx| {
        let Some(listeners) = listeners.upgrade() else {
            return Poll::Ready(None);
        };
        let mut receiver = listeners.receiver.borrow_mut();
        match receiver.as_mut() {
            Some(receiver) => receiver.poll_recv(cx),
            None => Poll::Ready(None),
        }
    })
    .await
}

/// Posts what the hub hands over to the VM's listeners, while the VM
/// lasts.
async fn deliver(listeners: Weak<Listeners>) {
    while let Some(delivery) = next(&listeners).await {
        let Some(vm) = listeners.upgrade() else {
            return;
        };
        let list = vm.of(delivery.kind()).borrow().clone();
        if list.is_empty() {
            // The last listener stopped while it was on its way: the next
            // one, here or in another VM, gets it if it waits.
            let lost = hub().dispatch(delivery, now());
            drop(lost);
            continue;
        }
        let callbacks = list.into_iter().map(|(_, listener)| listener);
        match delivery {
            Delivery::Token(token) => {
                let token = PushToken::from(&token);
                for listener in callbacks {
                    listener.post(Payload::Token(token.clone()));
                }
            }
            Delivery::Notification(n) | Delivery::Press(n) => {
                let notification = PushNotification::from(n);
                for listener in callbacks {
                    listener.post(Payload::Notification(notification.clone()));
                }
            }
            Delivery::Background(n, completion, at) => {
                let background = PushBackground::from(n);
                let answers: Vec<_> = callbacks
                    .map(|listener| listener.call_async(Payload::Background(background.clone())))
                    .collect();
                drop(spawn(settle(answers, completion, at + BACKGROUND_LIMIT)));
            }
        }
    }
}

/// Reports the background work of the listeners' `answers` to
/// `completion` once they settle, or at `deadline`.
async fn settle(
    answers: Vec<Answer<Result<BackgroundReturn, String>>>,
    completion: BackgroundCompletion,
    deadline: Instant,
) {
    for answer in answers {
        let result = match within(answer, deadline).await {
            Some(Ok(BackgroundReturn(result))) => result.unwrap_or_default(),
            Some(Err(error)) => {
                log::warn!("push: a background listener failed: {error}");
                BackgroundResult::Failed
            }
            None => {
                log::warn!("push: a background listener did not settle in time");
                BackgroundResult::Failed
            }
        };
        completion.set_result(result);
    }
}

/// `future`'s output, or `None` when `deadline` comes first.
async fn within<T>(future: impl std::future::Future<Output = T>, deadline: Instant) -> Option<T> {
    let mut future = std::pin::pin!(future);
    let mut timeout = std::pin::pin!(timer_until(deadline));
    std::future::poll_fn(|cx| {
        if let Poll::Ready(output) = future.as_mut().poll(cx) {
            return Poll::Ready(Some(output));
        }
        timeout.as_mut().poll(cx).map(|()| None)
    })
    .await
}

#[cfg(test)]
mod tests;
