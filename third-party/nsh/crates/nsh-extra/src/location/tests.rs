use std::time::Duration;

use super::{
    Authorization, LocationAccuracy, LocationError, LocationRequest, Position,
    js::{CurrentOptions, WatchOptions},
    web,
};

#[test]
fn a_request_out_of_range_is_refused() {
    let negative = LocationRequest {
        distance_filter: Some(-1.0),
        ..LocationRequest::default()
    };
    assert!(negative.checked().is_err());
    let infinite = LocationRequest {
        distance_filter: Some(f64::INFINITY),
        ..LocationRequest::default()
    };
    assert!(infinite.checked().is_err());
    let zero = LocationRequest {
        timeout: Some(Duration::ZERO),
        ..LocationRequest::default()
    };
    assert!(zero.checked().is_err());
    assert!(LocationRequest::default().checked().is_ok());
}

#[test]
fn options_become_the_request() {
    let current = CurrentOptions {
        accuracy: Some(LocationAccuracy::High),
        timeout: Some(1500.0),
    }
    .request()
    .unwrap();
    assert_eq!(current.accuracy, LocationAccuracy::High);
    assert_eq!(current.timeout, Some(Duration::from_millis(1500)));
    assert!(
        CurrentOptions {
            timeout: Some(-1.0),
            ..CurrentOptions::default()
        }
        .request()
        .is_err()
    );
    let watch = WatchOptions {
        distance_filter: Some(5.0),
        ..WatchOptions::default()
    }
    .request()
    .unwrap();
    assert_eq!(watch.accuracy, LocationAccuracy::Balanced);
    assert_eq!(watch.distance_filter, Some(5.0));
}

#[test]
fn the_distance_between_positions_is_along_the_surface() {
    let paris = Position::new(48.8566, 2.3522, 10.0, 0.0);
    let london = Position::new(51.5074, -0.1278, 10.0, 0.0);
    let metres = paris.distance_to(&london);
    assert!((340_000.0..345_000.0).contains(&metres), "{metres}");
    assert_eq!(paris.distance_to(&paris), 0.0);
}

#[test]
fn the_browsers_codes_mean_the_modules() {
    assert_eq!(
        web::location_error(1, "no".into()).code,
        LocationError::DENIED
    );
    assert_eq!(
        web::location_error(2, "none".into()).code,
        LocationError::POSITION_UNAVAILABLE
    );
    assert_eq!(
        web::location_error(3, "late".into()).code,
        LocationError::TIMED_OUT
    );
    assert_eq!(web::authorization_of("granted"), Authorization::WhenInUse);
    assert_eq!(web::authorization_of("denied"), Authorization::Denied);
    assert_eq!(
        web::authorization_of("prompt"),
        Authorization::NotDetermined
    );
}

/// Where no platform reports a position (the tests' host, but on macOS,
/// where the test binary has no usage description), every read fails with
/// `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` at once.
#[test]
fn without_a_platform_a_read_fails_at_once() {
    assert!(!super::available());
    let error = block_on(super::current(LocationRequest::default())).unwrap_err();
    assert_eq!(error.code, LocationError::UNAVAILABLE);
    let mut watch = super::watch(LocationRequest::default());
    let first = block_on(watch.next());
    assert_eq!(first.unwrap().unwrap_err().code, LocationError::UNAVAILABLE);
    assert!(block_on(watch.next()).is_none());
    assert_eq!(
        block_on(super::authorization()),
        Authorization::NotDetermined
    );
}

/// Polls `future` to its end on this thread (it must not wait on another).
fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    match future.as_mut().poll(&mut cx) {
        std::task::Poll::Ready(output) => output,
        std::task::Poll::Pending => panic!("the future waits"),
    }
}

#[test]
fn the_set_declares_the_location() {
    let ts = nsh_core::element::declarations(&crate::registry(), &[]);
    for declared in [
        "Location",
        "available(",
        "authorization(",
        "requestAuthorization(",
        "current(",
        "watch(",
        "CurrentOptions",
        "WatchOptions",
        "Coordinates",
        "\"notDetermined\"",
        "\"whenInUse\"",
    ] {
        assert!(ts.contains(declared), "{declared} is not declared:\n{ts}");
    }
}
