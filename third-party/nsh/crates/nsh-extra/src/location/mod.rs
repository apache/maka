//! `Location` (feature `location`): the device's position, and whether the
//! user lets the app read it.
//!
//! [`current`] reads one position (TS: `Location.current`), [`watch`]
//! reports each new one until it is dropped (TS: `Location.watch`, shaped
//! as the DOM's `navigator.geolocation.watchPosition`), [`authorization`]
//! tells what the user allows (TS: `Location.authorization`) and
//! [`request_authorization`] asks them (TS: `Location.requestAuthorization`).
//! A read asks the user itself when nobody has asked yet, so an app only
//! asks ahead when it wants to choose the moment.
//!
//! Turning the feature on is the app's declaration: no `nsh.json`
//! capability guards the module, and the packaged app carries the usage
//! description the system shows when it asks (see below). What the app may
//! read after that is the user's answer.
//!
//! # Platforms
//!
//! Each platform is one file of this directory: `apple.rs` (macOS and iOS:
//! CoreLocation's `CLLocationManager`) and `web.rs` (the browser's
//! `navigator.geolocation`, through wasm-bindgen). The file follows the
//! target OS, so GPUI on macOS reads CoreLocation too. Everywhere else
//! (Android, Windows, Linux, the terminal host on every OS, headless runs)
//! no platform reports a position yet: [`available`] is false and every
//! read fails with [`LocationError::UNAVAILABLE`]
//! (`ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`). A platform's file gives four
//! functions, which this module calls:
//!
//! ```ignore
//! /// Whether the platform reports a position here, without asking the
//! /// user anything.
//! pub(super) fn available() -> bool;
//!
//! /// What the user lets the app read now.
//! pub(super) async fn authorization() -> Authorization;
//!
//! /// Asks the user (once: later calls answer what they said), resolving
//! /// with the answer.
//! pub(super) async fn request_authorization() -> Authorization;
//!
//! /// Starts reading positions for `request` into `sink` (one when `once`),
//! /// as request `id`; `stop(id)` ends it. Never blocks the caller.
//! pub(super) fn start(id: u64, request: LocationRequest, once: bool, sink: Sink);
//! pub(super) fn stop(id: u64);
//! ```
//!
//! The packaged app needs the location's usage description on iOS and
//! macOS (and the location entitlement of a sandboxed macOS app): `nsh`
//! adds them from this crate's `[package.metadata.nsh.features.location]`
//! when the feature is on. An Apple app without the description (a bare
//! development binary) is not asked by the system, so [`available`] is
//! false there. On the web the browser asks the user itself, and only on a
//! secure page (`https:` or `localhost`).

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod apple;
// Its error mapping is tested on every target.
#[cfg(any(target_arch = "wasm32", test))]
mod web;

use std::{
    cell::{Cell, RefCell},
    collections::VecDeque,
    rc::Rc,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
    task::{Poll, Waker},
    time::Duration,
};

use nsh_core::{
    element::{Callback, JsError, Stop, codes},
    prelude::*,
};

#[cfg(any(target_os = "macos", target_os = "ios"))]
use self::apple as platform;
#[cfg(not(any(target_os = "macos", target_os = "ios", target_arch = "wasm32")))]
use self::none as platform;
#[cfg(target_arch = "wasm32")]
use self::web as platform;

/// What the user lets the app read (TS: `Location.authorization()`), in
/// CoreLocation's words.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
#[non_exhaustive]
pub enum Authorization {
    /// The user has not been asked yet: a read or
    /// [`request_authorization`] asks.
    #[default]
    NotDetermined,
    /// While the app is in use (the web's `granted`).
    WhenInUse,
    /// Also while it is not in front (an app that asked for it elsewhere).
    Always,
    /// The user said no, or took back a yes in the system's settings.
    Denied,
    /// The system forbids it (a parental control, a managed device): the
    /// user cannot change it.
    Restricted,
}

impl Authorization {
    /// Whether it lets the app read a position.
    pub fn allows_reading(self) -> bool {
        matches!(self, Self::WhenInUse | Self::Always)
    }
}

/// How precise a position to ask for (TS: `accuracy`). Precision costs
/// battery: ask for what the app shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
#[non_exhaustive]
pub enum LocationAccuracy {
    /// The most precise the device gives.
    Best,
    /// About ten metres.
    High,
    /// About a hundred metres, what the platforms choose by default.
    #[default]
    Balanced,
    /// About a kilometre.
    Low,
}

/// What a read asks for.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
#[non_exhaustive]
pub struct LocationRequest {
    /// How precise.
    pub accuracy: LocationAccuracy,
    /// [`watch`] only: report a new position only once the device moved
    /// this many metres from the one reported last. `None`: each one.
    pub distance_filter: Option<f64>,
    /// [`current`] only: fail with [`LocationError::TIMED_OUT`] when no
    /// position comes in this long. `None`: wait as long as it takes (the
    /// user may still be deciding).
    pub timeout: Option<Duration>,
}

impl LocationRequest {
    /// The request, or why it is not one (a `RangeError` in TS).
    pub fn checked(self) -> Result<Self, String> {
        if let Some(distance) = self.distance_filter
            && !(distance.is_finite() && distance >= 0.0)
        {
            return Err(format!(
                "`distanceFilter` must be a number of metres, not {distance}"
            ));
        }
        if self.timeout.is_some_and(|timeout| timeout.is_zero()) {
            return Err("`timeout` must be longer than zero".into());
        }
        Ok(self)
    }
}

/// A position the device reported.
///
/// What the device does not know is `None` (TS `null`, as the DOM's), never
/// zero: a device at rest knows no heading.
#[derive(Debug, Clone, Copy, PartialEq)]
#[non_exhaustive]
pub struct Position {
    /// Degrees north of the equator, -90 to 90.
    pub latitude: f64,
    /// Degrees east of Greenwich, -180 to 180.
    pub longitude: f64,
    /// How far the device may be from the position, in metres.
    pub accuracy: f64,
    /// Metres above sea level.
    pub altitude: Option<f64>,
    /// How far [`Self::altitude`] may be off, in metres.
    pub altitude_accuracy: Option<f64>,
    /// Degrees clockwise from true north the device moves towards, 0 to
    /// 360.
    pub heading: Option<f64>,
    /// Metres per second.
    pub speed: Option<f64>,
    /// When the device took the fix, in milliseconds since the Unix epoch
    /// (the DOM's `GeolocationPosition.timestamp`).
    pub timestamp: f64,
}

impl Position {
    /// A fix at `latitude`, `longitude`, `accuracy` metres precise, taken at
    /// `timestamp` (milliseconds since the Unix epoch).
    pub fn new(latitude: f64, longitude: f64, accuracy: f64, timestamp: f64) -> Self {
        Self {
            latitude,
            longitude,
            accuracy,
            altitude: None,
            altitude_accuracy: None,
            heading: None,
            speed: None,
            timestamp,
        }
    }

    /// Metres between this position and `other`, along the Earth's surface
    /// (the haversine distance).
    pub fn distance_to(&self, other: &Position) -> f64 {
        const EARTH_RADIUS: f64 = 6_371_008.8;
        let (lat1, lat2) = (self.latitude.to_radians(), other.latitude.to_radians());
        let dlat = lat2 - lat1;
        let dlon = (other.longitude - self.longitude).to_radians();
        let a = (dlat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (dlon / 2.0).sin().powi(2);
        2.0 * EARTH_RADIUS * a.sqrt().min(1.0).asin()
    }
}

/// Why no position came.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct LocationError {
    /// A stable code the app branches on ([`Self::DENIED`],
    /// [`Self::UNAVAILABLE`], [`Self::POSITION_UNAVAILABLE`],
    /// [`Self::TIMED_OUT`]).
    pub code: &'static str,
    /// What went wrong, in words.
    pub message: String,
}

impl LocationError {
    /// The user (or the system) does not let the app read the location;
    /// only the system's settings change that.
    pub const DENIED: &'static str = "EACCES";
    /// The platform reports no position: not implemented there, or the app
    /// lacks the usage description the system needs to ask.
    pub const UNAVAILABLE: &'static str = codes::UNAVAILABLE;
    /// The platform reports positions but could not find one now (no
    /// signal, location services off).
    pub const POSITION_UNAVAILABLE: &'static str = "ERR_POSITION_UNAVAILABLE";
    /// A [`current`] that found nothing within its timeout.
    pub const TIMED_OUT: &'static str = codes::TIMED_OUT;

    /// A failure with `code`.
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    // Only CoreLocation reports these itself; the browser gives its own.
    #[cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(dead_code))]
    fn denied() -> Self {
        Self::new(
            Self::DENIED,
            "the user does not let the app read the device's location",
        )
    }

    fn unavailable() -> Self {
        Self::new(
            Self::UNAVAILABLE,
            "this platform reports no location (macOS, iOS and the web do)",
        )
    }

    // Only CoreLocation reports these itself; the browser gives its own.
    #[cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(dead_code))]
    fn timed_out() -> Self {
        Self::new(Self::TIMED_OUT, "no position came in time")
    }

    fn to_js(&self) -> JsError {
        JsError::Error(self.message.clone()).with_code(self.code)
    }
}

impl std::fmt::Display for LocationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.message, self.code)
    }
}

impl std::error::Error for LocationError {}

// --- Reads --------------------------------------------------------------------

/// What a platform reports into a read, from any thread.
#[derive(Clone)]
pub(crate) struct Sink {
    channel: Arc<Mutex<Channel>>,
}

#[derive(Default)]
struct Channel {
    reports: VecDeque<Result<Position, LocationError>>,
    waker: Option<Waker>,
    /// A failure ended the read, or its owner stopped it.
    ended: bool,
}

impl Sink {
    fn channel(&self) -> MutexGuard<'_, Channel> {
        self.channel.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn push(&self, report: Result<Position, LocationError>) -> bool {
        let waker = {
            let mut channel = self.channel();
            if channel.ended {
                return false;
            }
            channel.ended = report.is_err();
            channel.reports.push_back(report);
            channel.waker.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
        true
    }

    /// Reports `position`; `false` once the read ended.
    #[cfg_attr(
        not(any(target_os = "macos", target_os = "ios", target_arch = "wasm32")),
        allow(dead_code)
    )]
    pub(crate) fn position(&self, position: Position) -> bool {
        self.push(Ok(position))
    }

    /// Ends the read with `error`; `false` once it ended.
    pub(crate) fn fail(&self, error: LocationError) -> bool {
        self.push(Err(error))
    }

    /// Whether the read ended: nothing more is taken.
    pub(crate) fn is_ended(&self) -> bool {
        self.channel().ended
    }

    fn end(&self) {
        let mut channel = self.channel();
        channel.ended = true;
        channel.reports.clear();
    }
}

fn next_id() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// Whether the calling engine draws in a terminal (the TUI host, on any
/// OS), whose run loop shows no system prompt.
fn in_terminal() -> bool {
    nsh_core::element::try_os().is_some()
        && nsh_core::element::idiom() == nsh_core::platform::Idiom::Terminal
}

/// Whether the device's position can be read here: macOS and iOS apps whose
/// `Info.plist` carries the location's usage description (a packaged app
/// with the feature on), and browsers with `navigator.geolocation`. Not
/// Android, Windows, Linux, the terminal host or headless runs. Whether the
/// user allows it is asked when the app reads it.
pub fn available() -> bool {
    !in_terminal() && platform::available()
}

/// What the user lets the app read now, without asking.
/// [`Authorization::NotDetermined`] where no platform reports a position.
pub async fn authorization() -> Authorization {
    if !available() {
        return Authorization::NotDetermined;
    }
    platform::authorization().await
}

/// Asks the user to let the app read the device's location while it is in
/// use, resolving with their answer; once they answered, the answer again
/// (only the system's settings change it). Fails with
/// [`LocationError::UNAVAILABLE`] where no platform reports a position.
pub async fn request_authorization() -> Result<Authorization, LocationError> {
    if !available() {
        return Err(LocationError::unavailable());
    }
    Ok(platform::request_authorization().await)
}

/// Reads the device's position once, asking the user first when nobody has.
/// Fails with [`LocationError::DENIED`] when the user does not allow it,
/// [`LocationError::TIMED_OUT`] after `request.timeout`,
/// [`LocationError::POSITION_UNAVAILABLE`] when the device finds none, and
/// [`LocationError::UNAVAILABLE`] where no platform reports one.
pub async fn current(request: LocationRequest) -> Result<Position, LocationError> {
    let mut read = Watch::start(request, true);
    match read.next().await {
        Some(report) => report,
        None => Err(LocationError::unavailable()),
    }
}

/// Reports the device's position each time it changes ([`Watch::next`]),
/// asking the user first when nobody has, until the watch is dropped. Its
/// failures are [`current`]'s but the timeout; a failure ends it.
pub fn watch(request: LocationRequest) -> Watch {
    Watch::start(request, false)
}

/// A running read of the device's position ([`watch`]). Dropping it stops
/// it.
#[must_use = "a dropped watch stops"]
pub struct Watch {
    id: u64,
    sink: Sink,
    distance_filter: Option<f64>,
    last: Option<Position>,
}

impl std::fmt::Debug for Watch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Watch")
            .field("id", &self.id)
            .field("ended", &self.sink.is_ended())
            .finish_non_exhaustive()
    }
}

impl Watch {
    fn start(request: LocationRequest, once: bool) -> Self {
        let id = next_id();
        let sink = Sink {
            channel: Arc::default(),
        };
        let watch = Self {
            id,
            sink: sink.clone(),
            distance_filter: request.distance_filter.filter(|_| !once),
            last: None,
        };
        if available() {
            platform::start(id, request, once, sink);
        } else {
            sink.fail(LocationError::unavailable());
        }
        watch
    }

    /// The next position, or the failure that ended the watch; `None` after
    /// that.
    pub async fn next(&mut self) -> Option<Result<Position, LocationError>> {
        std::future::poll_fn(|cx| self.poll_next(cx)).await
    }

    /// Polls for the next position ([`Self::next`]).
    pub fn poll_next(
        &mut self,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<Option<Result<Position, LocationError>>> {
        let mut channel = self.sink.channel();
        while let Some(report) = channel.reports.pop_front() {
            if let Ok(position) = &report {
                let near = match (self.distance_filter, &self.last) {
                    (Some(filter), Some(last)) => last.distance_to(position) < filter,
                    _ => false,
                };
                if near {
                    continue;
                }
                self.last = Some(*position);
            }
            return Poll::Ready(Some(report));
        }
        if channel.ended {
            return Poll::Ready(None);
        }
        channel.waker = Some(cx.waker().clone());
        Poll::Pending
    }

    /// Stops reading: nothing more comes.
    pub fn stop(&mut self) {
        if !self.sink.is_ended() {
            self.sink.end();
            platform::stop(self.id);
        }
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Where no platform reports a position: Android, Windows, Linux and
/// headless runs.
#[cfg(not(any(target_os = "macos", target_os = "ios", target_arch = "wasm32")))]
mod none {
    use super::{Authorization, LocationError, LocationRequest, Sink};

    pub(super) fn available() -> bool {
        false
    }

    pub(super) async fn authorization() -> Authorization {
        Authorization::NotDetermined
    }

    pub(super) async fn request_authorization() -> Authorization {
        Authorization::NotDetermined
    }

    pub(super) fn start(_: u64, _: LocationRequest, _: bool, sink: Sink) {
        sink.fail(LocationError::unavailable());
    }

    pub(super) fn stop(_: u64) {}
}

/// A value another thread answers once, awaited in a task.
#[cfg(any(target_os = "macos", target_os = "ios", target_arch = "wasm32"))]
pub(crate) mod reply {
    use std::{
        sync::{Arc, Mutex},
        task::{Poll, Waker},
    };

    type Slot<T> = Arc<Mutex<(Option<T>, Option<Waker>)>>;

    /// The answering end.
    pub(crate) struct Sender<T>(Slot<T>);

    impl<T> Sender<T> {
        pub(crate) fn send(self, value: T) {
            let waker = {
                let mut slot = self.0.lock().unwrap_or_else(|e| e.into_inner());
                slot.0 = Some(value);
                slot.1.take()
            };
            if let Some(waker) = waker {
                waker.wake();
            }
        }
    }

    /// A sender and the future of what it sends.
    pub(crate) fn channel<T>() -> (Sender<T>, impl Future<Output = T>) {
        let slot: Slot<T> = Arc::new(Mutex::new((None, None)));
        let receiver = slot.clone();
        let future = std::future::poll_fn(move |cx| {
            let mut slot = receiver.lock().unwrap_or_else(|e| e.into_inner());
            match slot.0.take() {
                Some(value) => Poll::Ready(value),
                None => {
                    slot.1 = Some(cx.waker().clone());
                    Poll::Pending
                }
            }
        });
        (Sender(slot), future)
    }
}

// --- JS ---------------------------------------------------------------------

pub(crate) use self::js::Location;

/// The module's JS face, with the DOM's shapes.
mod js {
    use super::*;

    /// The device's location.
    #[module]
    pub(crate) struct Location;

    #[module]
    impl Location {
        /// Resolves with whether the device's position can be read here: macOS
        /// and iOS apps packaged with the `location` feature (whose `Info.plist`
        /// explains why the app asks), and browsers with `navigator.geolocation`;
        /// `false` on Android, Windows, Linux and in a terminal, where reads
        /// reject with `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`. Whether the user
        /// allows it is asked when the app reads it.
        pub(crate) async fn available() -> bool {
            crate::location::available()
        }

        /// Resolves with what the user lets the app read now, without asking:
        /// `"notDetermined"`, `"whenInUse"`, `"always"`, `"denied"` or
        /// `"restricted"` (`"notDetermined"` where the position cannot be read).
        pub(crate) async fn authorization() -> Authorization {
            crate::location::authorization().await
        }

        /// Asks the user to let the app read the device's location while it is
        /// in use, resolving with their answer (once they answered, with it
        /// again: only the system's settings change it). Reading asks by
        /// itself; ask first only to choose the moment. Rejects with
        /// `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` where the position cannot be
        /// read.
        pub(crate) async fn request_authorization() -> Result<Authorization, JsError> {
            crate::location::request_authorization()
                .await
                .map_err(|error| error.to_js())
        }

        /// Reads the device's position once, as the DOM's
        /// `navigator.geolocation.getCurrentPosition`, asking the user first
        /// when nobody has. Rejects with `EACCES` when the user does not allow
        /// it, `ETIMEDOUT` when nothing came within `timeout`,
        /// `ERR_POSITION_UNAVAILABLE` when the device finds none,
        /// `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` where the position cannot be
        /// read, and a `RangeError` for options out of range.
        pub(crate) async fn current(options: Option<CurrentOptions>) -> Result<Position, JsError> {
            let request = options.unwrap_or_default().request()?;
            crate::location::current(request)
                .await
                .map(Position::from)
                .map_err(|error| error.to_js())
        }

        /// Calls `listener` with the device's position each time it changes, as
        /// the DOM's `navigator.geolocation.watchPosition`, asking the user
        /// first when nobody has. `onError` gets the failure that ends the watch
        /// (`code` as `current`'s). Returns a function that stops it; it also
        /// stops when what called `watch` goes (a component). Throws a
        /// `RangeError` for options out of range.
        pub(crate) fn watch(
            #[args(position)] listener: Callback<Position>,
            #[args(error)] on_error: Option<Callback<PositionError>>,
            options: Option<WatchOptions>,
            cx: CallCx<'_>,
        ) -> Result<Stop, JsError> {
            let request = options.unwrap_or_default().request()?;
            let stopper = Rc::new(Stopper::default());
            let cleanup = cx.on_cleanup({
                let stopper = Rc::downgrade(&stopper);
                move || {
                    if let Some(stopper) = stopper.upgrade() {
                        stopper.stop();
                    }
                }
            });
            cx.start({
                let stopper = stopper.clone();
                async move {
                    let mut watch = crate::location::watch(request);
                    loop {
                        let report = std::future::poll_fn(|cx| {
                            if stopper.stopped.get() {
                                return Poll::Ready(None);
                            }
                            *stopper.waker.borrow_mut() = Some(cx.waker().clone());
                            watch.poll_next(cx)
                        })
                        .await;
                        match report {
                            Some(Ok(position)) => listener.post(Position::from(position)),
                            Some(Err(error)) => {
                                if let Some(on_error) = &on_error {
                                    on_error.post(PositionError {
                                        code: error.code.to_owned(),
                                        message: error.message,
                                    });
                                }
                                break;
                            }
                            None => break,
                        }
                    }
                    watch.stop();
                    // An owner that lives long must not collect one cleanup per
                    // watch.
                    cleanup.release();
                }
            });
            Ok(Stop::new(move || stopper.stop()))
        }
    }

    /// How a JS watch's stop reaches its task.
    #[derive(Default)]
    struct Stopper {
        stopped: Cell<bool>,
        waker: RefCell<Option<Waker>>,
    }

    impl Stopper {
        fn stop(&self) {
            self.stopped.set(true);
            if let Some(waker) = self.waker.borrow_mut().take() {
                waker.wake();
            }
        }
    }

    /// The device's position, as `current` resolves and `watch` reports (the
    /// DOM's `GeolocationPosition`).
    #[derive(Debug, Clone, PartialEq, JsObject)]
    pub(crate) struct Position {
        /// Where the device is.
        coords: Coordinates,
        /// When the device took the fix, in milliseconds since the Unix epoch.
        timestamp: f64,
    }

    /// A position's coordinates (the DOM's `GeolocationCoordinates`): what the
    /// device does not know is `null`.
    #[derive(Debug, Clone, PartialEq, JsObject)]
    pub(crate) struct Coordinates {
        /// Degrees north of the equator.
        latitude: f64,
        /// Degrees east of Greenwich.
        longitude: f64,
        /// How far the device may be from the position, in metres.
        accuracy: f64,
        /// Metres above sea level.
        altitude: Option<f64>,
        /// How far `altitude` may be off, in metres.
        altitude_accuracy: Option<f64>,
        /// Degrees clockwise from true north the device moves towards.
        heading: Option<f64>,
        /// Metres per second.
        speed: Option<f64>,
    }

    impl From<crate::location::Position> for Position {
        fn from(position: crate::location::Position) -> Self {
            Self {
                coords: Coordinates {
                    latitude: position.latitude,
                    longitude: position.longitude,
                    accuracy: position.accuracy,
                    altitude: position.altitude,
                    altitude_accuracy: position.altitude_accuracy,
                    heading: position.heading,
                    speed: position.speed,
                },
                timestamp: position.timestamp,
            }
        }
    }

    /// Why a watch ended (`watch`'s `onError`).
    #[derive(Debug, Clone, PartialEq, JsObject)]
    pub(crate) struct PositionError {
        /// `EACCES`, `ERR_POSITION_UNAVAILABLE` or
        /// `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`.
        code: String,
        /// What went wrong, in words.
        message: String,
    }

    /// `Location.current`'s options.
    #[derive(Debug, Clone, Default, PartialEq, JsObject)]
    #[prop(exact)]
    pub(crate) struct CurrentOptions {
        /// `"best"`, `"high"`, `"balanced"` (the default) or `"low"`.
        pub(super) accuracy: Option<LocationAccuracy>,
        /// How long to wait for a position, in milliseconds; as long as it
        /// takes when not given.
        pub(super) timeout: Option<f64>,
    }

    impl CurrentOptions {
        pub(super) fn request(self) -> Result<LocationRequest, JsError> {
            LocationRequest {
                accuracy: self.accuracy.unwrap_or_default(),
                timeout: millis("timeout", self.timeout)?,
                ..LocationRequest::default()
            }
            .checked()
            .map_err(JsError::Range)
        }
    }

    /// `Location.watch`'s options.
    #[derive(Debug, Clone, Default, PartialEq, JsObject)]
    #[prop(exact)]
    pub(crate) struct WatchOptions {
        /// `"best"`, `"high"`, `"balanced"` (the default) or `"low"`.
        pub(super) accuracy: Option<LocationAccuracy>,
        /// Report a new position only once the device moved this many metres.
        pub(super) distance_filter: Option<f64>,
    }

    impl WatchOptions {
        pub(super) fn request(self) -> Result<LocationRequest, JsError> {
            LocationRequest {
                accuracy: self.accuracy.unwrap_or_default(),
                distance_filter: self.distance_filter,
                ..LocationRequest::default()
            }
            .checked()
            .map_err(JsError::Range)
        }
    }

    /// Milliseconds to a duration.
    fn millis(name: &str, value: Option<f64>) -> Result<Option<Duration>, JsError> {
        match value {
            None => Ok(None),
            Some(value) if value.is_finite() && value > 0.0 => {
                Ok(Some(Duration::from_secs_f64(value / 1000.0)))
            }
            Some(value) => Err(JsError::Range(format!(
                "`{name}` must be a positive number of milliseconds, not {value}"
            ))),
        }
    }
}

#[cfg(test)]
mod tests;
