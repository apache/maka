use std::{cmp::Reverse, collections::BinaryHeap, time::Duration};

use nsh_core::time::Instant;
use rquickjs::{Function, Persistent};
use rustc_hash::FxHashMap;

struct Timer {
    callback: Persistent<Function<'static>>,
    interval: Option<Duration>,
}

/// `setTimeout` / `setInterval` state. Deadlines live in a min-heap;
/// cancelled timers leave stale heap entries that are skipped on pop.
#[derive(Default)]
pub(crate) struct Timers {
    next_id: u32,
    heap: BinaryHeap<Reverse<(Instant, u32)>>,
    timers: FxHashMap<u32, Timer>,
}

impl Timers {
    pub(crate) fn add(
        &mut self,
        callback: Persistent<Function<'static>>,
        delay: Duration,
        repeat: bool,
    ) -> u32 {
        self.next_id = self.next_id.wrapping_add(1).max(1);
        let id = self.next_id;
        self.timers.insert(
            id,
            Timer {
                callback,
                interval: repeat.then_some(delay),
            },
        );
        self.heap.push(Reverse((nsh_core::time::now() + delay, id)));
        id
    }

    pub(crate) fn cancel(&mut self, id: u32) {
        self.timers.remove(&id);
    }

    /// Earliest pending deadline.
    pub(crate) fn next_deadline(&mut self) -> Option<Instant> {
        while let Some(&Reverse((at, id))) = self.heap.peek() {
            if self.timers.contains_key(&id) {
                return Some(at);
            }
            self.heap.pop();
        }
        None
    }

    /// Pops one due timer, rescheduling intervals. Returns its callback.
    pub(crate) fn pop_due(&mut self, now: Instant) -> Option<Persistent<Function<'static>>> {
        loop {
            let &Reverse((at, id)) = self.heap.peek()?;
            if at > now {
                return None;
            }
            self.heap.pop();
            let Some(timer) = self.timers.get(&id) else {
                continue;
            };
            let callback = timer.callback.clone();
            match timer.interval {
                // Schedule from `now` so a slow callback cannot cause a burst.
                Some(interval) => self
                    .heap
                    .push(Reverse((now + interval.max(Duration::from_millis(1)), id))),
                None => {
                    self.timers.remove(&id);
                }
            }
            return Some(callback);
        }
    }

    /// Drops all callbacks. Must run before the JS runtime is freed.
    pub(crate) fn clear(&mut self) {
        self.timers.clear();
        self.heap.clear();
    }
}
