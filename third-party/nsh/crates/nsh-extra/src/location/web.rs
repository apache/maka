//! Location on the web: the browser's `navigator.geolocation`, reached
//! through wasm-bindgen, and `navigator.permissions` for what the user
//! allows. The browser asks the user itself when a page reads the position
//! (only on a secure page: `https:` or `localhost`), and has no "always":
//! the authorization is `granted` (`whenInUse`), `denied` or `prompt`
//! (`notDetermined`).
//!
//! The part that needs no browser (what the browser's error codes and
//! permission states mean) builds on every target, for the module's tests.

use super::{Authorization, LocationError};

/// What the browser's `GeolocationPositionError.code` means to the app.
pub(super) fn location_error(code: u16, message: String) -> LocationError {
    match code {
        // `PERMISSION_DENIED`.
        1 => LocationError::new(LocationError::DENIED, message),
        // `TIMEOUT`.
        3 => LocationError::new(LocationError::TIMED_OUT, message),
        // `POSITION_UNAVAILABLE`, and codes browsers add.
        _ => LocationError::new(LocationError::POSITION_UNAVAILABLE, message),
    }
}

/// What a `PermissionStatus.state` says the user allows.
pub(super) fn authorization_of(state: &str) -> Authorization {
    match state {
        "granted" => Authorization::WhenInUse,
        "denied" => Authorization::Denied,
        _ => Authorization::NotDetermined,
    }
}

#[cfg(target_arch = "wasm32")]
pub(super) use self::browser::{authorization, available, request_authorization, start, stop};

#[cfg(target_arch = "wasm32")]
mod browser {
    use std::{cell::RefCell, collections::HashMap};

    use wasm_bindgen::{JsCast, JsValue, closure::Closure};
    use web_sys::{
        Geolocation, PermissionDescriptor, PermissionName, PermissionStatus, PositionOptions,
    };

    use super::{
        super::{
            Authorization, LocationAccuracy, LocationError, LocationRequest, Position, Sink, reply,
        },
        authorization_of, location_error,
    };

    thread_local! {
        /// The reads running, by id. The page has one thread: the module's
        /// calls and the browser's callbacks all come on it.
        static READS: RefCell<HashMap<u64, Read>> = RefCell::new(HashMap::new());
    }

    /// A read running: its sink, its `watchPosition` id, and the callbacks
    /// the browser calls, alive as long as it.
    struct Read {
        sink: Sink,
        watch: Option<i32>,
        _callbacks: [Closure<dyn FnMut(JsValue)>; 2],
    }

    /// The global's `navigator`, a window's or a worker's.
    fn navigator() -> Option<JsValue> {
        js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("navigator"))
            .ok()
            .filter(|navigator| navigator.is_object())
    }

    fn geolocation() -> Option<Geolocation> {
        let geolocation =
            js_sys::Reflect::get(&navigator()?, &JsValue::from_str("geolocation")).ok()?;
        geolocation
            .is_object()
            .then(|| geolocation.unchecked_into::<Geolocation>())
    }

    pub(in crate::location) fn available() -> bool {
        geolocation().is_some()
    }

    pub(in crate::location) async fn authorization() -> Authorization {
        let Some(navigator) = navigator() else {
            return Authorization::NotDetermined;
        };
        let Ok(permissions) = js_sys::Reflect::get(&navigator, &JsValue::from_str("permissions"))
        else {
            return Authorization::NotDetermined;
        };
        if !permissions.is_object() {
            // Without the Permissions API the browser tells nothing before
            // it asks.
            return Authorization::NotDetermined;
        }
        let permissions: web_sys::Permissions = permissions.unchecked_into();
        let descriptor = PermissionDescriptor::new(PermissionName::Geolocation);
        let Ok(promise) = permissions.query(&descriptor) else {
            return Authorization::NotDetermined;
        };
        let (sender, answer) = reply::channel();
        let sender = std::rc::Rc::new(RefCell::new(Some(sender)));
        let answered = {
            let sender = sender.clone();
            Closure::once(move |status: JsValue| {
                let status: PermissionStatus = status.unchecked_into();
                let state = match status.state() {
                    web_sys::PermissionState::Granted => "granted",
                    web_sys::PermissionState::Denied => "denied",
                    _ => "prompt",
                };
                if let Some(sender) = sender.borrow_mut().take() {
                    sender.send(authorization_of(state));
                }
            })
        };
        let failed = Closure::once(move |_: JsValue| {
            if let Some(sender) = sender.borrow_mut().take() {
                sender.send(Authorization::NotDetermined);
            }
        });
        let _ = promise.then2(&answered, &failed);
        let authorization = answer.await;
        drop((answered, failed));
        authorization
    }

    pub(in crate::location) async fn request_authorization() -> Authorization {
        // The browser asks when the page reads the position: one read, whose
        // outcome is the answer.
        let sink = Sink {
            channel: Default::default(),
        };
        let id = super::super::next_id();
        start(id, LocationRequest::default(), true, sink.clone());
        let mut read = super::super::Watch {
            id,
            sink,
            distance_filter: None,
            last: None,
        };
        match read.next().await {
            Some(Ok(_)) => Authorization::WhenInUse,
            Some(Err(error)) if error.code == LocationError::DENIED => Authorization::Denied,
            // No position, but no refusal: what the browser says now.
            _ => authorization().await,
        }
    }

    pub(in crate::location) fn start(id: u64, request: LocationRequest, once: bool, sink: Sink) {
        let Some(geolocation) = geolocation() else {
            sink.fail(LocationError::unavailable());
            return;
        };
        let options = PositionOptions::new();
        options.set_enable_high_accuracy(matches!(
            request.accuracy,
            LocationAccuracy::Best | LocationAccuracy::High
        ));
        if let Some(timeout) = request.timeout {
            options.set_timeout(timeout.as_millis().min(u32::MAX as u128) as u32);
        }
        let success = Closure::new(move |position: JsValue| {
            let sink = READS.with(|reads| reads.borrow().get(&id).map(|read| read.sink.clone()));
            if let Some(sink) = sink {
                sink.position(position_of(&position));
            }
            if once {
                finish(id);
            }
        });
        let failure = Closure::new(move |error: JsValue| {
            let code = number(&error, "code").unwrap_or(0.0) as u16;
            let message = js_sys::Reflect::get(&error, &JsValue::from_str("message"))
                .ok()
                .and_then(|message| message.as_string())
                .unwrap_or_default();
            let error = location_error(code, message);
            // A watch keeps watching through a moment without a fix; a
            // refusal ends it.
            if !once && error.code != LocationError::DENIED {
                log::debug!("location: {error}");
                return;
            }
            let sink = READS.with(|reads| reads.borrow().get(&id).map(|read| read.sink.clone()));
            if let Some(sink) = sink {
                sink.fail(error);
            }
            finish(id);
        });
        let success_fn = success.as_ref().unchecked_ref::<js_sys::Function>().clone();
        let failure_fn = failure.as_ref().unchecked_ref::<js_sys::Function>().clone();
        READS.with(|reads| {
            reads.borrow_mut().insert(
                id,
                Read {
                    sink: sink.clone(),
                    watch: None,
                    _callbacks: [success, failure],
                },
            )
        });
        let watch = if once {
            geolocation
                .get_current_position_with_error_callback_and_options(
                    &success_fn,
                    Some(&failure_fn),
                    &options,
                )
                .map(|()| None)
        } else {
            geolocation
                .watch_position_with_error_callback_and_options(
                    &success_fn,
                    Some(&failure_fn),
                    &options,
                )
                .map(Some)
        };
        match watch {
            Ok(watch) => READS.with(|reads| {
                if let Some(read) = reads.borrow_mut().get_mut(&id) {
                    read.watch = watch;
                }
            }),
            Err(error) => {
                log::warn!("location: the browser refused the read: {error:?}");
                sink.fail(LocationError::new(
                    LocationError::POSITION_UNAVAILABLE,
                    "the browser could not read the position",
                ));
                finish(id);
            }
        }
    }

    pub(in crate::location) fn stop(id: u64) {
        finish(id);
    }

    /// Forgets read `id`, clearing its watch. Its callbacks go once the one
    /// running (if any) returns.
    fn finish(id: u64) {
        let read = READS.with(|reads| reads.borrow_mut().remove(&id));
        if let Some(read) = read {
            if let (Some(watch), Some(geolocation)) = (read.watch, geolocation()) {
                geolocation.clear_watch(watch);
            }
            // Dropped in a later turn: the callback that may be running now
            // is one of these.
            free_later(read);
        }
    }

    /// Drops `read` once the current callback returned.
    fn free_later(read: Read) {
        let later = Closure::once_into_js(move || drop(read));
        let promise = js_sys::Promise::resolve(&JsValue::UNDEFINED);
        if let Ok(then) = js_sys::Reflect::get(&promise, &JsValue::from_str("then")) {
            let _ = then
                .unchecked_into::<js_sys::Function>()
                .call1(&promise, &later);
        }
    }

    /// `object[key]` when it is a finite number (the DOM's `null`s are not).
    fn number(object: &JsValue, key: &str) -> Option<f64> {
        js_sys::Reflect::get(object, &JsValue::from_str(key))
            .ok()?
            .as_f64()
            .filter(|value| value.is_finite())
    }

    /// A `GeolocationPosition`'s fields. Read by name: web-sys gives its
    /// type only under its unstable APIs.
    fn position_of(position: &JsValue) -> Position {
        let coords = js_sys::Reflect::get(position, &JsValue::from_str("coords"))
            .unwrap_or(JsValue::UNDEFINED);
        let mut result = Position::new(
            number(&coords, "latitude").unwrap_or(0.0),
            number(&coords, "longitude").unwrap_or(0.0),
            number(&coords, "accuracy").unwrap_or(0.0),
            number(position, "timestamp").unwrap_or(0.0),
        );
        result.altitude = number(&coords, "altitude");
        result.altitude_accuracy = number(&coords, "altitudeAccuracy");
        result.heading = number(&coords, "heading");
        result.speed = number(&coords, "speed");
        result
    }
}
