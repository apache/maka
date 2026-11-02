//! A monotonic clock that also works in WebAssembly, and the clocks of
//! engines.
//!
//! `std::time::Instant::now` panics on `wasm32-unknown-unknown`, which has
//! no clock of its own. Off WebAssembly [`Instant`] is the standard one; in
//! WebAssembly it counts from the page's time origin (`performance.now()`,
//! the `nsh.now_ms` import the web runtime provides).
//!
//! An engine runs on a [`Clock`]: the system's, or a manual one that moves
//! only when told ([`Clock::advance_to`]), for tests that skip through
//! timers and animations. The engine makes its clock its thread's
//! ([`Clock::enter`]), so [`now`] and [`unix_ms`], which timers, tasks and
//! `Date` read, are its time there.

#[cfg(not(target_arch = "wasm32"))]
pub use std::time::Instant;
use std::{
    cell::RefCell,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};

#[cfg(target_arch = "wasm32")]
pub use self::wasm::Instant;

/// Now on the current thread's clock: its engine's ([`Clock::enter`]),
/// else the system's.
pub fn now() -> Instant {
    CURRENT.with(|current| match &*current.borrow() {
        Some(clock) => clock.now(),
        None => Instant::now(),
    })
}

/// Milliseconds since the Unix epoch on the current thread's clock (wall
/// clock: `Date.now()`).
pub fn unix_ms() -> f64 {
    CURRENT.with(|current| match &*current.borrow() {
        Some(clock) => clock.unix_ms(),
        None => system_unix_ms(),
    })
}

/// Whether the current thread's clock is manual: time moves only when it
/// is told to.
pub fn manual() -> bool {
    CURRENT.with(|current| current.borrow().as_ref().is_some_and(Clock::is_manual))
}

/// The current thread's clock ([`Clock::enter`]), else the system's: for
/// what keeps reading an engine's time outside its calls (a browser realm's
/// `Date` between pumps).
pub fn current() -> Clock {
    CURRENT.with(|current| current.borrow().clone().unwrap_or_default())
}

/// A display frame's time at 60 Hz: what a manual clock that moves with
/// the display's frames moves by each frame ([`Clock::with_frames`]).
pub const FRAME: Duration = Duration::from_nanos(16_666_667);

thread_local! {
    /// The clock of the engine on this thread.
    static CURRENT: RefCell<Option<Clock>> = const { RefCell::new(None) };
}

/// The time an engine runs on: the system's, or a manual clock that moves
/// only when told, shared by the threads that drive the engine (a test's).
#[derive(Clone, Default)]
pub struct Clock(Option<Arc<Mutex<Manual>>>);

/// A manual clock's state.
struct Manual {
    /// The system's time when it started: its instants are this plus
    /// `elapsed`.
    origin: Instant,
    /// How far it moved.
    elapsed: Duration,
    /// The wall clock at `origin`, in milliseconds since the Unix epoch.
    unix_origin: f64,
    /// What runs once it reaches a time ([`Clock::at`]), soonest first.
    alarms: Vec<(Instant, Box<dyn FnOnce() + Send>)>,
    /// It also moves with the display's frames ([`Clock::with_frames`]).
    frames: bool,
}

impl std::fmt::Debug for Clock {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(if self.is_manual() {
            "Clock::Manual"
        } else {
            "Clock::System"
        })
    }
}

impl Clock {
    /// The system's clock.
    pub fn system() -> Clock {
        Clock(None)
    }

    /// A manual clock standing at the wall time `start`, which moves only
    /// when told.
    pub fn manual(start: SystemTime) -> Clock {
        Clock(Some(Arc::new(Mutex::new(Manual {
            origin: Instant::now(),
            elapsed: Duration::ZERO,
            unix_origin: epoch_ms(start),
            alarms: Vec::new(),
            frames: false,
        }))))
    }

    /// A manual clock that also moves by a frame's time
    /// ([`FRAME`]) with each frame the display shows its engine, before
    /// the frame runs: a test's app on a real platform, whose time passes
    /// while it animates and stands still while it is idle, as a headless
    /// run's does. Nothing for the system's clock.
    pub fn with_frames(self) -> Clock {
        if let Some(mut m) = self.manual_state() {
            m.frames = true;
        }
        self
    }

    /// Whether it is a manual clock that moves with the display's frames
    /// ([`Clock::with_frames`]).
    pub fn moves_with_frames(&self) -> bool {
        self.manual_state().is_some_and(|m| m.frames)
    }

    /// Whether it is manual.
    pub fn is_manual(&self) -> bool {
        self.0.is_some()
    }

    fn manual_state(&self) -> Option<std::sync::MutexGuard<'_, Manual>> {
        self.0
            .as_ref()
            .map(|m| m.lock().unwrap_or_else(|e| e.into_inner()))
    }

    /// Now.
    pub fn now(&self) -> Instant {
        match self.manual_state() {
            Some(m) => m.origin + m.elapsed,
            None => Instant::now(),
        }
    }

    /// Milliseconds since the Unix epoch.
    pub fn unix_ms(&self) -> f64 {
        match self.manual_state() {
            Some(m) => m.unix_origin + m.elapsed.as_secs_f64() * 1000.0,
            None => system_unix_ms(),
        }
    }

    /// Sets a manual clock's wall time (`Date.now()`) to `at`, without
    /// moving its instants: no timer comes due. Nothing on the system's.
    pub fn set_system_time(&self, at: SystemTime) {
        if let Some(mut m) = self.manual_state() {
            m.unix_origin = epoch_ms(at) - m.elapsed.as_secs_f64() * 1000.0;
        }
    }

    /// Moves a manual clock forward to `at` (never back), and runs the
    /// alarms due by then, in order. Nothing on the system's.
    pub fn advance_to(&self, at: Instant) {
        let due = {
            let Some(mut m) = self.manual_state() else {
                return;
            };
            let elapsed = at.saturating_duration_since(m.origin);
            m.elapsed = m.elapsed.max(elapsed);
            let now = m.origin + m.elapsed;
            let split = m.alarms.partition_point(|(when, _)| *when <= now);
            m.alarms.drain(..split).collect::<Vec<_>>()
        };
        for (_, alarm) in due {
            alarm();
        }
    }

    /// Runs `alarm` once the clock reaches `at`: on a thread of its own
    /// for the system's clock, when it is moved past `at` for a manual
    /// one.
    pub fn at(&self, at: Instant, alarm: impl FnOnce() + Send + 'static) {
        match self.manual_state() {
            Some(mut m) => {
                let index = m.alarms.partition_point(|(when, _)| *when <= at);
                m.alarms.insert(index, (at, Box::new(alarm)));
            }
            None => {
                #[cfg(not(target_arch = "wasm32"))]
                std::thread::spawn(move || {
                    std::thread::sleep(at.saturating_duration_since(Instant::now()));
                    alarm();
                });
                // No threads to sleep on: at once.
                #[cfg(target_arch = "wasm32")]
                alarm();
            }
        }
    }

    /// When a manual clock's next alarm is due.
    pub fn next_alarm(&self) -> Option<Instant> {
        self.manual_state()?.alarms.first().map(|(at, _)| *at)
    }

    /// Makes it the current thread's clock until the guard drops: what
    /// [`now`], [`unix_ms`] and [`manual`] read.
    pub fn enter(&self) -> ClockGuard {
        let previous = CURRENT.with(|current| current.replace(Some(self.clone())));
        ClockGuard { previous }
    }
}

/// Puts the thread's previous clock back ([`Clock::enter`]).
#[must_use = "the clock is the thread's while the guard lives"]
pub struct ClockGuard {
    previous: Option<Clock>,
}

impl Drop for ClockGuard {
    fn drop(&mut self) {
        let previous = self.previous.take();
        CURRENT.with(|current| *current.borrow_mut() = previous);
    }
}

/// `at` in milliseconds since the Unix epoch (negative before it).
fn epoch_ms(at: SystemTime) -> f64 {
    match at.duration_since(SystemTime::UNIX_EPOCH) {
        Ok(since) => since.as_secs_f64() * 1000.0,
        Err(before) => -before.duration().as_secs_f64() * 1000.0,
    }
}

/// Milliseconds since the Unix epoch (the system's wall clock).
#[cfg(not(target_arch = "wasm32"))]
fn system_unix_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

/// Milliseconds since the Unix epoch (the system's wall clock).
#[cfg(target_arch = "wasm32")]
fn system_unix_ms() -> f64 {
    #[link(wasm_import_module = "nsh")]
    unsafe extern "C" {
        fn date_now_ms() -> f64;
    }
    // SAFETY: a pure host function without arguments.
    unsafe { date_now_ms() }
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use std::{
        ops::{Add, AddAssign, Sub, SubAssign},
        time::Duration,
    };

    #[link(wasm_import_module = "nsh")]
    unsafe extern "C" {
        /// Milliseconds since the page's time origin (`performance.now()`).
        fn now_ms() -> f64;
    }

    /// A point in time, from the page's time origin.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
    pub struct Instant(Duration);

    impl Instant {
        /// Now.
        pub fn now() -> Instant {
            // SAFETY: a pure host function without arguments.
            let ms = unsafe { now_ms() };
            Instant(Duration::from_secs_f64(ms.max(0.0) / 1000.0))
        }

        /// The time from `earlier` to `self` (zero if `earlier` is later).
        pub fn duration_since(&self, earlier: Instant) -> Duration {
            self.0.saturating_sub(earlier.0)
        }

        /// As [`Instant::duration_since`].
        pub fn saturating_duration_since(&self, earlier: Instant) -> Duration {
            self.duration_since(earlier)
        }

        /// The time since `self`.
        pub fn elapsed(&self) -> Duration {
            Instant::now().duration_since(*self)
        }

        /// `self + duration`, if representable.
        pub fn checked_add(&self, duration: Duration) -> Option<Instant> {
            self.0.checked_add(duration).map(Instant)
        }

        /// `self - duration`, if representable.
        pub fn checked_sub(&self, duration: Duration) -> Option<Instant> {
            self.0.checked_sub(duration).map(Instant)
        }
    }

    impl Add<Duration> for Instant {
        type Output = Instant;
        fn add(self, rhs: Duration) -> Instant {
            Instant(self.0 + rhs)
        }
    }

    impl AddAssign<Duration> for Instant {
        fn add_assign(&mut self, rhs: Duration) {
            self.0 += rhs;
        }
    }

    impl Sub<Duration> for Instant {
        type Output = Instant;
        fn sub(self, rhs: Duration) -> Instant {
            Instant(self.0.saturating_sub(rhs))
        }
    }

    impl SubAssign<Duration> for Instant {
        fn sub_assign(&mut self, rhs: Duration) {
            self.0 = self.0.saturating_sub(rhs);
        }
    }

    impl Sub<Instant> for Instant {
        type Output = Duration;
        fn sub(self, rhs: Instant) -> Duration {
            self.duration_since(rhs)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_manual_clock_moves_only_when_told_and_runs_its_alarms_in_order() {
        let clock = Clock::manual(SystemTime::UNIX_EPOCH + Duration::from_secs(1));
        let start = clock.now();
        std::thread::sleep(Duration::from_millis(5));
        assert_eq!(clock.now(), start);
        let rang = Arc::new(Mutex::new(Vec::new()));
        for (ms, name) in [(30, "b"), (10, "a"), (50, "c")] {
            let rang = rang.clone();
            clock.at(start + Duration::from_millis(ms), move || {
                rang.lock().unwrap().push(name)
            });
        }
        assert_eq!(clock.next_alarm(), Some(start + Duration::from_millis(10)));
        clock.advance_to(start + Duration::from_millis(30));
        assert_eq!(*rang.lock().unwrap(), ["a", "b"]);
        assert_eq!(clock.unix_ms(), 1_030.0);
        // Never back.
        clock.advance_to(start);
        assert_eq!(clock.now(), start + Duration::from_millis(30));
        clock.set_system_time(SystemTime::UNIX_EPOCH + Duration::from_secs(5));
        assert_eq!(
            (clock.unix_ms(), clock.now()),
            (5_000.0, start + Duration::from_millis(30))
        );
    }

    #[test]
    fn a_thread_reads_its_engine_s_clock_while_it_is_entered() {
        assert!(!manual());
        let clock = Clock::manual(SystemTime::UNIX_EPOCH + Duration::from_millis(42));
        {
            let _guard = clock.enter();
            assert!(manual());
            assert_eq!((now(), unix_ms()), (clock.now(), 42.0));
        }
        assert!(!manual());
        assert!(unix_ms() > 1.0e12);
    }
}
