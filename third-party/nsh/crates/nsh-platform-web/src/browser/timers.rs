//! Timers and animation frames of a realm on a manual clock (a test's).
//! The browser's own `setTimeout` and `requestAnimationFrame` would run on
//! the page's time, which the test cannot move: `testing.js` puts these
//! in their place, so the engine runs them as its clock comes to them, as
//! nsh-js' `timers.rs` does for QuickJS. On the system's clock nothing
//! here is used.
use std::{
    cell::{Cell, RefCell},
    cmp::Reverse,
    collections::{BinaryHeap, HashMap},
    time::Duration,
};

use nsh_core::{
    element::PropError,
    js::host::HostInput,
    time::{Clock, Instant},
};

use super::values::{Value, invoke};

struct Timer {
    callback: Value,
    interval: Option<Duration>,
}

/// Deadlines live in a min-heap; cancelled timers leave stale entries
/// that are skipped on pop.
#[derive(Default)]
pub(super) struct Timers {
    clock: RefCell<Clock>,
    /// `performance.now()`'s zero: the clock's time when the app started.
    origin: Cell<Option<Instant>>,
    next: Cell<u32>,
    heap: RefCell<BinaryHeap<Reverse<(Instant, u32)>>>,
    timers: RefCell<HashMap<u32, Timer>>,
    next_frame: Cell<u32>,
    frames: RefCell<Vec<(u32, Value)>>,
}

impl Timers {
    /// Runs on the engine's `clock` from now on.
    pub(super) fn set_clock(&self, clock: Clock) {
        self.origin.set(Some(clock.now()));
        *self.clock.borrow_mut() = clock;
    }

    pub(super) fn call(&self, op: u32, args: &Value) -> Result<Value, PropError> {
        let clock = self.clock.borrow().clone();
        match op {
            1000 => Ok(Value(if clock.is_manual() { 3 } else { 2 })),
            // `Date.now()`: whole milliseconds, as the intrinsic's.
            1001 => Ok(Value::number(clock.unix_ms().floor())),
            1002 => {
                let origin = self.origin.get().unwrap_or_else(|| clock.now());
                Ok(Value::number(
                    clock.now().saturating_duration_since(origin).as_secs_f64() * 1000.0,
                ))
            }
            1003 => {
                let callback = args.index(0)?;
                let ms = args.index(1)?.as_number().unwrap_or(0.0);
                let delay = Duration::from_secs_f64(if ms.is_finite() && ms > 0.0 {
                    ms / 1000.0
                } else {
                    0.0
                });
                let repeat = args.index(2)?.truthy();
                let id = self.next.get().wrapping_add(1).max(1);
                self.next.set(id);
                self.timers.borrow_mut().insert(
                    id,
                    Timer {
                        callback,
                        interval: repeat.then_some(delay),
                    },
                );
                self.heap
                    .borrow_mut()
                    .push(Reverse((clock.now() + delay, id)));
                Ok(Value::number(id.into()))
            }
            1004 => {
                let id = args.index(0)?.as_number().unwrap_or(0.0) as u32;
                self.timers.borrow_mut().remove(&id);
                Ok(Value(0))
            }
            1005 => {
                let callback = args.index(0)?;
                let id = self.next_frame.get().wrapping_add(1).max(1);
                self.next_frame.set(id);
                self.frames.borrow_mut().push((id, callback));
                Ok(Value::number(id.into()))
            }
            1006 => {
                let id = args.index(0)?.as_number().unwrap_or(0.0) as u32;
                self.frames.borrow_mut().retain(|(i, _)| *i != id);
                Ok(Value(0))
            }
            _ => Err(PropError("unknown timer operation".into())),
        }
    }

    /// The earliest pending deadline.
    pub(super) fn next_deadline(&self) -> Option<Instant> {
        let timers = self.timers.borrow();
        let mut heap = self.heap.borrow_mut();
        while let Some(&Reverse((at, id))) = heap.peek() {
            if timers.contains_key(&id) {
                return Some(at);
            }
            heap.pop();
        }
        None
    }

    /// Pops one timer due at `now` that was set by id `before` at the
    /// latest, rescheduling intervals.
    fn pop_due(&self, now: Instant, before: u32) -> Option<Value> {
        let mut heap = self.heap.borrow_mut();
        let mut timers = self.timers.borrow_mut();
        loop {
            let &Reverse((at, id)) = heap.peek()?;
            // Set during this run (ids grow; one past the wrap is older).
            if at > now || id.wrapping_sub(before) as i32 > 0 {
                return None;
            }
            heap.pop();
            let Some(timer) = timers.get(&id) else {
                continue;
            };
            let callback = timer.callback.clone();
            match timer.interval {
                // From `now`, so a slow callback cannot cause a burst.
                Some(interval) => {
                    heap.push(Reverse((now + interval.max(Duration::from_millis(1)), id)))
                }
                None => {
                    timers.remove(&id);
                }
            }
            return Some(callback);
        }
    }

    /// Runs the timers due at `now`, one at a time: no borrow is held
    /// while a callback runs, as it may add or clear timers. Those added
    /// meanwhile wait for the next run, as a browser runs `setTimeout(f, 0)`
    /// in a later task: one that keeps scheduling itself at once comes due
    /// in each of the clock's rounds, which give up after their limit,
    /// rather than here for good.
    pub(super) fn run(&self, now: Instant) {
        let before = self.next.get();
        while let Some(callback) = self.pop_due(now, before) {
            report(Value::array([]).and_then(|args| callback.call(&Value(0), &args)));
        }
    }

    pub(super) fn wants_frame(&self) -> bool {
        !self.frames.borrow().is_empty()
    }

    /// Runs the frame callbacks requested so far with `performance.now()`;
    /// those requested meanwhile wait for the next frame.
    pub(super) fn run_frame(&self) {
        let frames = std::mem::take(&mut *self.frames.borrow_mut());
        if frames.is_empty() {
            return;
        }
        let Ok(now) = self.call(1002, &Value(0)) else {
            return;
        };
        for (_, callback) in frames {
            report(Value::array([now.clone()]).and_then(|args| callback.call(&Value(0), &args)));
        }
    }

    /// Drops every callback (the app stops).
    pub(super) fn clear(&self) {
        self.timers.borrow_mut().clear();
        self.frames.borrow_mut().clear();
        self.heap.borrow_mut().clear();
    }
}

/// Reports what a callback threw, as an uncaught error of the app's.
pub(super) fn report(result: Result<Value, PropError>) {
    if let Err(error) = result {
        invoke(42, 0, error.0.as_ptr() as u32, error.0.len() as u32, 0.0);
    }
}
