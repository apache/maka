//! Location on Apple platforms (macOS, iOS): CoreLocation's
//! `CLLocationManager`, one for the process, made and messaged on the main
//! queue.
//!
//! The manager hears its fixes through a delegate; this module reads
//! `CLLocationManager.location` (the fix it took last) on the main queue
//! instead, every quarter of a second while a read runs, so no delegate
//! class is built at run time. Every read shares the manager: it runs at the
//! most precise accuracy one asks for, and stops once none runs. The
//! authorization is the system's own prompt
//! (`requestWhenInUseAuthorization`), read back from
//! `CLLocationManager.authorizationStatus` until the user answers; the
//! system shows it only for an app whose `Info.plist` explains why it asks
//! (`NSLocationWhenInUseUsageDescription`), so the platform is not
//! available without it.

use std::{
    cell::RefCell,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use dispatch2::{DispatchQueue, DispatchTime};
use objc2::rc::Retained;
use objc2_core_location::{CLAuthorizationStatus, CLLocation, CLLocationManager};
use objc2_foundation::{NSBundle, NSString};

use super::{Authorization, LocationAccuracy, LocationError, LocationRequest, Position, Sink};

/// How often a running read looks at the manager's fix.
const POLL: Duration = Duration::from_millis(250);

/// How old a fix `current` still takes: one the manager kept from a read a
/// moment ago is the device's position still.
const FRESH: Duration = Duration::from_secs(10);

thread_local! {
    /// The manager, made once on the main thread.
    static MANAGER: RefCell<Option<Retained<CLLocationManager>>> = const { RefCell::new(None) };
    /// The reads running, on the main thread.
    static READS: RefCell<Vec<Read>> = const { RefCell::new(Vec::new()) };
    /// Whether a poll is scheduled: one runs at a time.
    static POLLING: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// Authorization answers waiting for the user.
    static ASKING: RefCell<Vec<super::reply::Sender<Authorization>>> = const { RefCell::new(Vec::new()) };
}

/// A `current` or a watch running.
struct Read {
    id: u64,
    sink: Sink,
    accuracy: LocationAccuracy,
    once: bool,
    /// When a `current` gives up.
    deadline: Option<Instant>,
    /// The oldest fix it takes, in milliseconds since the Unix epoch.
    since: f64,
    /// The fix it reported last.
    reported: Option<f64>,
}

/// The manager, made once. On the main thread.
fn manager() -> Retained<CLLocationManager> {
    MANAGER.with(|slot| {
        slot.borrow_mut()
            // SAFETY: on the main thread (every caller runs on the main
            // queue), where a `CLLocationManager` is made and messaged.
            .get_or_insert_with(|| unsafe { CLLocationManager::new() })
            .clone()
    })
}

fn status() -> Authorization {
    // SAFETY: on the main thread, the manager made there.
    authorization_of(unsafe { manager().authorizationStatus() })
}

fn authorization_of(status: CLAuthorizationStatus) -> Authorization {
    match status {
        CLAuthorizationStatus::Restricted => Authorization::Restricted,
        CLAuthorizationStatus::Denied => Authorization::Denied,
        CLAuthorizationStatus::AuthorizedAlways => Authorization::Always,
        CLAuthorizationStatus::AuthorizedWhenInUse => Authorization::WhenInUse,
        _ => Authorization::NotDetermined,
    }
}

/// Whether the app's `Info.plist` explains why it asks: the system shows
/// no prompt (and reports no position) without it.
fn described() -> bool {
    let bundle = NSBundle::mainBundle();
    [
        "NSLocationWhenInUseUsageDescription",
        "NSLocationUsageDescription",
    ]
    .into_iter()
    .any(|key| {
        bundle
            .objectForInfoDictionaryKey(&NSString::from_str(key))
            .is_some()
    })
}

pub(super) fn available() -> bool {
    // The bundle is read on any thread; whether location services are on
    // (the class method may block, so not on the main thread) is a failure
    // of a read, `POSITION_UNAVAILABLE`.
    described()
}

pub(super) async fn authorization() -> Authorization {
    let (sender, answer) = super::reply::channel();
    DispatchQueue::main().exec_async(move || sender.send(status()));
    answer.await
}

pub(super) async fn request_authorization() -> Authorization {
    let (sender, answer) = super::reply::channel();
    DispatchQueue::main().exec_async(move || {
        let status = status();
        if status != Authorization::NotDetermined {
            sender.send(status);
            return;
        }
        ask();
        ASKING.with(|asking| asking.borrow_mut().push(sender));
        schedule();
    });
    answer.await
}

/// Shows the system's prompt (once: nothing after the user answered). On
/// the main thread.
fn ask() {
    // SAFETY: on the main thread, the manager made there.
    unsafe { manager().requestWhenInUseAuthorization() };
}

pub(super) fn start(id: u64, request: LocationRequest, once: bool, sink: Sink) {
    // Off the main thread: Apple warns the class method may block it.
    // SAFETY: a class method, callable on any thread.
    if !unsafe { CLLocationManager::locationServicesEnabled_class() } {
        sink.fail(LocationError::new(
            LocationError::POSITION_UNAVAILABLE,
            "location services are off in the system's settings",
        ));
        return;
    }
    let started = now()
        - if once {
            FRESH.as_secs_f64() * 1000.0
        } else {
            f64::INFINITY
        };
    DispatchQueue::main().exec_async(move || {
        if sink.is_ended() {
            return;
        }
        if status() == Authorization::NotDetermined {
            ask();
        }
        let first = READS.with(|reads| {
            let mut reads = reads.borrow_mut();
            reads.push(Read {
                id,
                sink,
                accuracy: request.accuracy,
                once,
                deadline: request.timeout.map(|timeout| Instant::now() + timeout),
                since: started,
                reported: None,
            });
            reads.len() == 1
        });
        configure();
        if first {
            // SAFETY: on the main thread, the manager made there.
            unsafe { manager().startUpdatingLocation() };
        }
        schedule();
    });
}

pub(super) fn stop(id: u64) {
    DispatchQueue::main().exec_async(move || {
        READS.with(|reads| reads.borrow_mut().retain(|read| read.id != id));
        configure();
    });
}

/// Sets the manager to the most precise accuracy a read asks for, and stops
/// it once none runs. On the main thread.
fn configure() {
    let accuracy = READS.with(|reads| {
        reads
            .borrow()
            .iter()
            .map(|read| desired_accuracy(read.accuracy))
            .reduce(f64::min)
    });
    let manager = manager();
    // SAFETY: on the main thread, the manager made there.
    unsafe {
        match accuracy {
            Some(accuracy) => manager.setDesiredAccuracy(accuracy),
            None => manager.stopUpdatingLocation(),
        }
    }
}

/// The manager's accuracy, in metres, for a request's.
fn desired_accuracy(accuracy: LocationAccuracy) -> f64 {
    match accuracy {
        // `kCLLocationAccuracyBest`.
        LocationAccuracy::Best => -1.0,
        // `kCLLocationAccuracyNearestTenMeters`.
        LocationAccuracy::High => 10.0,
        // `kCLLocationAccuracyHundredMeters`.
        LocationAccuracy::Balanced => 100.0,
        // `kCLLocationAccuracyKilometer`.
        LocationAccuracy::Low => 1000.0,
    }
}

/// Schedules the next poll, unless one is. On the main thread.
fn schedule() {
    if POLLING.with(|polling| polling.replace(true)) {
        return;
    }
    let nanos = POLL.as_nanos().min(i64::MAX as u128) as i64;
    if DispatchQueue::main()
        .after(DispatchTime::NOW.time(nanos), poll)
        .is_err()
    {
        POLLING.with(|polling| polling.set(false));
        log::warn!("location: the main queue took no timer");
    }
}

/// Looks at the authorization and the manager's fix, answering what waits.
/// On the main thread, while anything waits.
fn poll() {
    POLLING.with(|polling| polling.set(false));
    let status = status();
    if status != Authorization::NotDetermined {
        for sender in ASKING.with(|asking| std::mem::take(&mut *asking.borrow_mut())) {
            sender.send(status);
        }
    }
    let refused = matches!(status, Authorization::Denied | Authorization::Restricted);
    // SAFETY: on the main thread, the manager made there.
    let fix = (!refused)
        .then(|| unsafe { manager().location() })
        .flatten()
        // SAFETY: a fix of the manager, on the main thread.
        .map(|fix| unsafe { position(&fix) });
    let instant = Instant::now();
    let running = READS.with(|reads| {
        let mut reads = reads.borrow_mut();
        reads.retain_mut(|read| {
            if read.sink.is_ended() {
                return false;
            }
            if refused {
                read.sink.fail(LocationError::denied());
                return false;
            }
            if let Some(fix) = fix
                && fix.timestamp >= read.since
                && read.reported != Some(fix.timestamp)
            {
                read.reported = Some(fix.timestamp);
                read.sink.position(fix);
                if read.once {
                    return false;
                }
            }
            if read.deadline.is_some_and(|deadline| instant >= deadline) {
                read.sink.fail(LocationError::timed_out());
                return false;
            }
            true
        });
        !reads.is_empty()
    });
    configure();
    let asking = ASKING.with(|asking| !asking.borrow().is_empty());
    if running || asking {
        schedule();
    }
}

fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// What a fix says.
///
/// # Safety
///
/// `fix` must be a `CLLocation` of the manager, read on the main thread.
unsafe fn position(fix: &CLLocation) -> Position {
    // SAFETY: the caller's.
    unsafe {
        let coordinate = fix.coordinate();
        let timestamp = fix.timestamp().timeIntervalSince1970() * 1000.0;
        let mut position = Position::new(
            coordinate.latitude,
            coordinate.longitude,
            fix.horizontalAccuracy().max(0.0),
            timestamp,
        );
        let vertical = fix.verticalAccuracy();
        if vertical >= 0.0 {
            position.altitude = Some(fix.altitude());
            position.altitude_accuracy = Some(vertical);
        }
        let speed = fix.speed();
        if speed >= 0.0 {
            position.speed = Some(speed);
        }
        let course = fix.course();
        if course >= 0.0 {
            position.heading = Some(course);
        }
        position
    }
}
