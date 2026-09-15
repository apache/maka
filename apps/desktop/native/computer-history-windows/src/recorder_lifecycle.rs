/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

use crate::control::Result;
use std::{
    sync::atomic::{AtomicU64, AtomicUsize, Ordering},
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Epochs {
    pub window: u64,
    pub content: u64,
}

pub struct EventEpochs {
    window: AtomicU64,
    content: AtomicU64,
    tracked_window: AtomicUsize,
}

impl EventEpochs {
    pub const fn new() -> Self {
        Self {
            window: AtomicU64::new(0),
            content: AtomicU64::new(0),
            tracked_window: AtomicUsize::new(0),
        }
    }

    /// Retain the capture HWND before preparation; a destroy callback cannot
    /// reliably recover the old window's ancestry after its handle is reused.
    pub fn track_window(&self, hwnd: usize) {
        self.tracked_window.store(hwnd, Ordering::SeqCst);
    }

    pub fn window_destroyed(&self, hwnd: usize) {
        if hwnd != 0 && hwnd == self.tracked_window.load(Ordering::SeqCst) {
            self.window_changed();
        } else {
            // An already-destroyed child may have no queryable parent. Preserve
            // capture invalidation without inventing a new foreground source.
            self.content_changed();
        }
    }

    pub fn window_changed(&self) {
        self.window.fetch_add(1, Ordering::SeqCst);
    }

    pub fn content_changed(&self) {
        self.content.fetch_add(1, Ordering::SeqCst);
    }

    pub fn current(&self) -> Epochs {
        Epochs {
            window: self.window.load(Ordering::SeqCst),
            content: self.content.load(Ordering::SeqCst),
        }
    }
}

/// False means the budget ended before an empty queue was observed.
pub fn drain_events(mut dispatch_one: impl FnMut() -> bool, budget: usize) -> bool {
    for _ in 0..budget {
        if !dispatch_one() {
            return true;
        }
    }
    false
}

#[derive(Clone, Copy)]
pub struct CaptureFence {
    pub target: (usize, u32),
    pub epochs: Epochs,
}

pub struct LiveState {
    pub queue_drained: bool,
    pub parent_alive: bool,
    pub stopping: bool,
    pub desktop_available: bool,
    pub foreground: Option<(usize, u32)>,
    pub epochs: Epochs,
}

impl CaptureFence {
    pub fn allows(&self, live: LiveState) -> bool {
        live.queue_drained
            && live.parent_alive
            && !live.stopping
            && live.desktop_available
            && live.foreground == Some(self.target)
            && live.epochs == self.epochs
    }

    /// All disk/control preparation precedes the final live sample. Callers
    /// perform no further preparation between this result and write/spawn.
    pub fn after_preparation(
        &self,
        prepare: impl FnOnce() -> Result<bool>,
        sample: impl FnOnce() -> LiveState,
    ) -> Result<bool> {
        Ok(prepare()? && self.allows(sample()))
    }
}

#[derive(Default)]
pub struct CaptureSchedule {
    last_attempt: Option<Instant>,
    unsettled: Option<Epochs>,
}

impl CaptureSchedule {
    pub fn due(&self, now: Instant, dirty: bool, epochs: Epochs, failures: u32) -> bool {
        let Some(last_attempt) = self.last_attempt else {
            return dirty;
        };
        let elapsed = now.duration_since(last_attempt);
        let backoff = Duration::from_secs(if failures > 2 { 15 } else { 3 });
        elapsed >= backoff
            && (dirty
                || self.unsettled.is_some_and(|attempt| attempt != epochs)
                || elapsed >= Duration::from_secs(15))
    }

    pub fn started(&mut self, now: Instant, epochs: Epochs) {
        self.last_attempt = Some(now);
        self.unsettled = Some(epochs);
    }

    /// Completion settles only the captured generation. Admission may have
    /// invalidated it; retain that work for a rate-limited fresh attempt.
    pub fn completed(&mut self, epochs: Epochs) {
        if self.unsettled == Some(epochs) {
            self.unsettled = None;
        }
    }
}

#[derive(Clone, Copy)]
pub enum CaptureOutcome {
    Failed,
    Suppressed,
    Observed,
}

#[derive(Default)]
pub struct CaptureHealth {
    pub failures: u32,
    published: Option<(&'static str, u32, Instant)>,
}

impl CaptureHealth {
    pub fn observe(&mut self, outcome: CaptureOutcome) {
        self.failures = match outcome {
            CaptureOutcome::Failed => self.failures.saturating_add(1),
            CaptureOutcome::Suppressed | CaptureOutcome::Observed => 0,
        };
    }

    pub fn due(&self, state: &'static str, now: Instant) -> bool {
        self.published.is_none_or(|(last_state, failures, last)| {
            state != last_state
                || failures != self.failures
                || now.duration_since(last) >= Duration::from_secs(5)
        })
    }

    pub fn published(&mut self, state: &'static str, now: Instant) {
        self.published = Some((state, self.failures, now));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn live(epochs: &EventEpochs) -> LiveState {
        LiveState {
            queue_drained: true,
            parent_alive: true,
            stopping: false,
            desktop_available: true,
            foreground: Some((10, 20)),
            epochs: epochs.current(),
        }
    }

    #[test]
    fn cancelled_capture_retries_without_another_dirty_event() {
        let now = Instant::now();
        let mut schedule = CaptureSchedule::default();
        let epochs = EventEpochs::new();
        epochs.track_window(10);
        let fence = CaptureFence {
            target: (10, 20),
            epochs: epochs.current(),
        };
        assert!(schedule.due(now, true, epochs.current(), 0));
        schedule.started(now, epochs.current());
        epochs.window_destroyed(99);
        assert!(!fence.allows(live(&epochs)));
        assert_eq!(epochs.current().window, fence.epochs.window);
        assert!(!schedule.due(
            now + Duration::from_millis(2999),
            false,
            epochs.current(),
            0
        ));
        assert!(schedule.due(now + Duration::from_secs(3), false, epochs.current(), 0));
        // Includes a completed worker invalidated during result/write admission.
        schedule.completed(epochs.current());
        assert!(schedule.due(now + Duration::from_secs(3), false, epochs.current(), 0));

        let fresh = CaptureFence {
            epochs: epochs.current(),
            ..fence
        };
        assert!(fresh.allows(live(&epochs)));
        schedule.started(now + Duration::from_secs(3), epochs.current());
        schedule.completed(epochs.current());
        assert!(!schedule.due(now + Duration::from_secs(6), false, epochs.current(), 0));
        assert!(schedule.due(now + Duration::from_secs(18), false, epochs.current(), 0));
    }

    #[test]
    fn cancellation_keeps_the_rate_limit_and_failure_backoff() {
        let now = Instant::now();
        let mut schedule = CaptureSchedule::default();
        let epochs = EventEpochs::new();
        schedule.started(now, epochs.current());
        epochs.content_changed();
        for dirty in [false, true] {
            assert!(!schedule.due(
                now + Duration::from_millis(2999),
                dirty,
                epochs.current(),
                2
            ));
            assert!(schedule.due(now + Duration::from_secs(3), dirty, epochs.current(), 2));
            assert!(!schedule.due(
                now + Duration::from_millis(14999),
                dirty,
                epochs.current(),
                3
            ));
            assert!(schedule.due(now + Duration::from_secs(15), dirty, epochs.current(), 3));
        }
        // Repeated cancellation must not reset the sampling clock.
        epochs.content_changed();
        assert!(schedule.due(now + Duration::from_secs(3), false, epochs.current(), 0));
    }

    #[test]
    fn idle_destruction_does_not_schedule_work_or_bypass_fresh_admission() {
        let now = Instant::now();
        let mut schedule = CaptureSchedule::default();
        let epochs = EventEpochs::new();
        epochs.track_window(10);
        assert!(!schedule.due(now, false, epochs.current(), 0));
        schedule.started(now, epochs.current());
        schedule.completed(epochs.current());
        epochs.window_destroyed(99);
        assert!(!schedule.due(now + Duration::from_secs(3), false, epochs.current(), 0));
        assert!(schedule.due(now + Duration::from_secs(15), false, epochs.current(), 0));
        schedule.started(now + Duration::from_secs(15), epochs.current());
        epochs.content_changed();
        let fence = CaptureFence {
            target: (10, 20),
            epochs: epochs.current(),
        };
        assert!(schedule.due(now + Duration::from_secs(18), false, epochs.current(), 0));
        for state in [
            LiveState {
                parent_alive: false,
                ..live(&epochs)
            },
            LiveState {
                stopping: true,
                ..live(&epochs)
            },
            LiveState {
                desktop_available: false,
                ..live(&epochs)
            },
            LiveState {
                queue_drained: false,
                ..live(&epochs)
            },
        ] {
            assert!(!fence.allows(state));
        }
        assert!(
            !fence
                .after_preparation(|| Ok(false), || live(&epochs))
                .unwrap()
        );
        epochs.window_destroyed(10);
        assert!(!fence.allows(live(&epochs)));
    }

    #[test]
    fn non_target_window_destruction_invalidates_capture_not_source_identity() {
        // A child or an already-gone foreign HWND must not split this source.
        // Keep conservative content invalidation when ancestry is unavailable.
        for destroyed in [11, 99, 0] {
            let epochs = EventEpochs::new();
            epochs.track_window(10);
            let fence = CaptureFence {
                target: (10, 20),
                epochs: epochs.current(),
            };
            assert!(
                !fence
                    .after_preparation(
                        || {
                            epochs.window_destroyed(destroyed);
                            Ok(true)
                        },
                        || live(&epochs),
                    )
                    .unwrap()
            );
            assert_eq!(epochs.current().window, fence.epochs.window);
            let fresh = CaptureFence {
                epochs: epochs.current(),
                ..fence
            };
            assert!(fresh.allows(live(&epochs)));
        }
    }

    #[test]
    fn tracked_window_destruction_rejects_same_hwnd_and_pid_reuse() {
        let epochs = EventEpochs::new();
        epochs.track_window(10);
        let fence = CaptureFence {
            target: (10, 20),
            epochs: epochs.current(),
        };
        assert!(
            !fence
                .after_preparation(
                    || {
                        epochs.window_destroyed(10);
                        // The replacement may reuse both numbers. Tracking it
                        // again must not erase the queued destruction evidence.
                        epochs.track_window(10);
                        Ok(true)
                    },
                    || live(&epochs),
                )
                .unwrap()
        );
        assert_ne!(epochs.current().window, fence.epochs.window);
        let fresh = CaptureFence {
            epochs: epochs.current(),
            ..fence
        };
        assert!(fresh.allows(live(&epochs)));
    }

    #[test]
    fn old_source_destruction_does_not_rotate_the_new_source() {
        let epochs = EventEpochs::new();
        epochs.track_window(9);
        epochs.window_changed();
        epochs.track_window(10);
        let fence = CaptureFence {
            target: (10, 20),
            epochs: epochs.current(),
        };
        epochs.window_destroyed(9);
        assert_eq!(epochs.current().window, fence.epochs.window);
        assert!(!fence.allows(live(&epochs)));
        epochs.window_destroyed(10);
        assert_ne!(epochs.current().window, fence.epochs.window);
    }

    #[test]
    fn preparation_aba_invalidates_content_without_changing_window_identity() {
        let epochs = EventEpochs::new();
        let fence = CaptureFence {
            target: (10, 20),
            epochs: epochs.current(),
        };
        assert!(
            !fence
                .after_preparation(
                    || {
                        epochs.content_changed();
                        epochs.content_changed();
                        Ok(true)
                    },
                    || live(&epochs),
                )
                .unwrap()
        );
        assert_eq!(epochs.current().window, fence.epochs.window);
        let fresh = CaptureFence {
            epochs: epochs.current(),
            ..fence
        };
        assert!(
            fresh
                .after_preparation(|| Ok(true), || live(&epochs))
                .unwrap()
        );
        assert!(
            !fresh
                .after_preparation(
                    || {
                        epochs.window_changed();
                        epochs.window_changed();
                        Ok(true)
                    },
                    || live(&epochs),
                )
                .unwrap()
        );
    }

    #[test]
    fn queued_aba_is_processed_after_preparation_not_before_it() {
        let epochs = EventEpochs::new();
        let queued = Cell::new(0);
        let fence = CaptureFence {
            target: (10, 20),
            epochs: epochs.current(),
        };
        assert!(
            !fence
                .after_preparation(
                    || {
                        queued.set(2);
                        Ok(true)
                    },
                    || {
                        let drained = drain_events(
                            || {
                                if queued.get() == 0 {
                                    return false;
                                }
                                queued.set(queued.get() - 1);
                                epochs.window_changed();
                                true
                            },
                            256,
                        );
                        LiveState {
                            queue_drained: drained,
                            ..live(&epochs)
                        }
                    },
                )
                .unwrap()
        );
        assert_eq!(queued.get(), 0);
    }

    #[test]
    fn eof_parent_loss_pause_and_preparation_errors_never_admit_an_effect() {
        let epochs = EventEpochs::new();
        let fence = CaptureFence {
            target: (10, 20),
            epochs: epochs.current(),
        };
        for parent_exit in [false, true] {
            let changed = Cell::new(false);
            assert!(
                !fence
                    .after_preparation(
                        || {
                            changed.set(true);
                            Ok(true)
                        },
                        || LiveState {
                            parent_alive: !(parent_exit && changed.get()),
                            stopping: !parent_exit && changed.get(),
                            ..live(&epochs)
                        },
                    )
                    .unwrap()
            );
        }
        assert!(
            !fence
                .after_preparation(
                    || Ok(false),
                    || panic!("revoked control must short-circuit admission"),
                )
                .unwrap()
        );
        assert!(
            fence
                .after_preparation(
                    || Err("unreadable_consent".into()),
                    || panic!("unreadable consent must short-circuit admission"),
                )
                .is_err()
        );
    }

    #[test]
    fn exhausted_event_budget_defers_even_with_unchanged_foreground() {
        let epochs = EventEpochs::new();
        let fence = CaptureFence {
            target: (10, 20),
            epochs: epochs.current(),
        };
        let queued = Cell::new(257);
        let pump = || {
            drain_events(
                || {
                    if queued.get() == 0 {
                        return false;
                    }
                    queued.set(queued.get() - 1);
                    true
                },
                256,
            )
        };
        assert!(!fence.allows(LiveState {
            queue_drained: pump(),
            ..live(&epochs)
        }));
        assert_eq!(queued.get(), 1);
        assert!(fence.allows(LiveState {
            queue_drained: pump(),
            ..live(&epochs)
        }));
    }

    #[test]
    fn repeated_failures_publish_immediately_and_suppression_or_success_recovers() {
        let now = Instant::now();
        let mut health = CaptureHealth::default();
        assert!(health.due("running", now));
        health.published("running", now);
        assert!(!health.due("running", now));
        for count in 1..=3 {
            health.observe(CaptureOutcome::Failed);
            assert_eq!(health.failures, count);
            assert!(health.due("running", now));
            health.published("running", now);
        }
        for outcome in [CaptureOutcome::Suppressed, CaptureOutcome::Observed] {
            health.observe(outcome);
            assert_eq!(health.failures, 0);
            assert!(health.due("running", now));
            health.published("running", now);
            health.observe(CaptureOutcome::Failed);
            health.published("running", now);
        }
        assert!(health.due("paused", now));
        health.published("paused", now);
        assert!(!health.due("paused", now + Duration::from_millis(4999)));
        assert!(health.due("paused", now + Duration::from_secs(5)));
    }
}
