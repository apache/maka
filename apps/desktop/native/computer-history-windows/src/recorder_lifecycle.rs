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
    sync::{
        Mutex,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

pub const SOURCE_FRESHNESS: Duration = Duration::from_secs(5);
pub const CAPTURE_LIMIT: Duration = Duration::from_secs(2);
pub const RECORDER_POLL: Duration = Duration::from_millis(50);

pub fn finish_recording(
    outcome: Result<()>,
    stop_input: impl FnOnce() -> Result<()>,
    seal: impl FnOnce() -> Result<()>,
    publish: impl FnOnce(bool) -> Result<()>,
) -> Result<()> {
    // Each owner must finish even if an earlier owner fails. Preserve the
    // original capture error; report cleanup failure when capture succeeded.
    let stopped = stop_input();
    let sealed = seal();
    let published = publish(outcome.is_ok() && stopped.is_ok() && sealed.is_ok());
    outcome.and(stopped).and(sealed).and(published)
}

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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LeaseRevision {
    pub identity: u64,
    pub content: u64,
}

struct LeaseProgress {
    ended: Option<(LeaseEnd, Instant)>,
    revision: Option<LeaseRevision>,
    changes: LeaseRevision,
    retried: bool,
    verified: Option<(u64, Instant, u64)>,
    input_verified: bool,
}

impl LeaseProgress {
    fn deadline(&self, started: Instant) -> Instant {
        self.verified.map_or(started, |(_, at, _)| at) + SOURCE_FRESHNESS
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LeaseEnd {
    Completed,
    Eof,
    InvalidOutput,
    Revoked,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LeaseDisposition {
    Keep,
    Retire,
    Terminal,
}

pub struct InputLeaseState {
    pub started: Instant,
    progress: Mutex<LeaseProgress>,
}

impl InputLeaseState {
    pub fn new(started: Instant) -> Self {
        Self {
            started,
            progress: Mutex::new(LeaseProgress {
                ended: None,
                revision: None,
                changes: LeaseRevision::default(),
                retried: false,
                verified: None,
                input_verified: false,
            }),
        }
    }

    /// Only the owning recorder consumes changes into global epochs. A reader
    /// may outlive its child, but cannot invalidate a replacement source.
    pub fn observe(&self, revision: LeaseRevision, invalidated: bool, revoked: bool) -> bool {
        let Ok(mut progress) = self.progress.lock() else {
            return false;
        };
        if progress.ended.is_some() {
            return false;
        }
        let previous = progress.revision;
        if previous
            .is_some_and(|old| revision.identity < old.identity || revision.content < old.content)
        {
            progress.ended = Some((LeaseEnd::InvalidOutput, Instant::now()));
            return false;
        }
        // The initial successful frame establishes the subscription baseline.
        // An actual invalidation, even before that frame, is never a baseline.
        let invalidated = invalidated && !revoked;
        let identity_changed =
            previous.map_or(invalidated, |old| old.identity != revision.identity);
        let content_changed =
            invalidated || previous.is_some_and(|old| old.content != revision.content);
        progress.changes.identity += u64::from(identity_changed);
        progress.changes.content += u64::from(identity_changed || content_changed);
        progress.revision = Some(revision);
        if revoked {
            // Revocation also covers cleanup/counter exhaustion. Only actual
            // changed source stamps above invalidate the capture's authority.
            progress.ended = Some((LeaseEnd::Revoked, Instant::now()));
            return false;
        }
        true
    }

    pub fn close(&self) {
        self.end(LeaseEnd::Cancelled);
    }

    pub fn end(&self, reason: LeaseEnd) {
        self.end_at(reason, Instant::now());
    }

    pub fn ended(&self) -> bool {
        self.progress
            .lock()
            .map_or(true, |progress| progress.ended.is_some())
    }

    fn end_at(&self, reason: LeaseEnd, at: Instant) {
        if let Ok(mut progress) = self.progress.lock() {
            // Terminal state immediately closes admission, but does not invent
            // a source event that could disguise an unexpected worker failure.
            progress.ended.get_or_insert((reason, at));
        }
    }

    pub fn current(&self) -> Option<LeaseRevision> {
        self.current_at(Instant::now())
    }

    pub fn verified_at(&self) -> Option<Instant> {
        self.progress.lock().ok()?.verified.map(|(_, at, _)| at)
    }

    fn current_at(&self, now: Instant) -> Option<LeaseRevision> {
        let progress = self.progress.lock().ok()?;
        if progress.ended.is_some() || now >= progress.deadline(self.started) {
            return None;
        }
        progress.revision
    }

    /// Called only by the recorder after exact source and final authority checks.
    /// A response cannot renew its own age, a revoked source, or a terminal child.
    pub fn accept_verified(
        &self,
        request: u64,
        captured_at: Instant,
        revision: LeaseRevision,
        seen: LeaseRevision,
        now: impl FnOnce() -> Instant,
    ) -> bool {
        self.accept_capture(request, captured_at, revision, seen, now, true)
    }

    pub fn accept_observed(
        &self,
        request: u64,
        captured_at: Instant,
        revision: LeaseRevision,
        seen: LeaseRevision,
        now: impl FnOnce() -> Instant,
    ) -> bool {
        self.accept_capture(request, captured_at, revision, seen, now, false)
    }

    fn accept_capture(
        &self,
        request: u64,
        captured_at: Instant,
        revision: LeaseRevision,
        seen: LeaseRevision,
        now: impl FnOnce() -> Instant,
        input: bool,
    ) -> bool {
        let Ok(mut progress) = self.progress.lock() else {
            return false;
        };
        let now = now();
        if progress.ended.is_some()
            || now >= progress.deadline(self.started)
            || captured_at < self.started
            || captured_at > now
            || now.duration_since(captured_at) >= CAPTURE_LIMIT
            || progress.revision != Some(revision)
            || progress.changes != seen
            || progress
                .verified
                .is_some_and(|(old_request, old_start, identity)| {
                    request <= old_request
                        || captured_at <= old_start
                        || revision.identity != identity
                        || progress.input_verified != input
                })
        {
            return false;
        }
        progress.verified = Some((request, captured_at, revision.identity));
        progress.input_verified = input;
        progress.retried = false;
        true
    }

    pub fn admits(&self, identity: u64) -> bool {
        self.progress.lock().is_ok_and(|progress| {
            progress.ended.is_none()
                && progress.input_verified
                && Instant::now() < progress.deadline(self.started)
                && progress
                    .verified
                    .is_some_and(|(_, _, accepted)| accepted == identity)
                && progress
                    .revision
                    .is_some_and(|revision| revision.identity == identity)
        })
    }

    pub fn frame_current(&self, revision: LeaseRevision, seen: LeaseRevision) -> bool {
        self.progress.lock().is_ok_and(|progress| {
            progress.ended.is_none()
                && Instant::now() < progress.deadline(self.started)
                && progress.revision == Some(revision)
                && progress.changes == seen
        })
    }

    pub fn retain_completed(
        &self,
        frame: Option<(LeaseRevision, LeaseRevision)>,
        retained_identity: Option<u64>,
    ) -> LeaseDisposition {
        let Ok(mut progress) = self.progress.lock() else {
            return LeaseDisposition::Terminal;
        };
        if progress.ended.is_some() {
            return LeaseDisposition::Terminal;
        }
        let now = Instant::now();
        if now < progress.deadline(self.started)
            && (frame.is_some_and(|(revision, seen)| {
                progress.revision == Some(revision) && progress.changes == seen
            }) || retained_identity.is_some_and(|identity| {
                progress
                    .revision
                    .is_some_and(|revision| revision.identity == identity)
            }))
        {
            return LeaseDisposition::Keep;
        }
        // Decide retirement and revoke together. EOF either wins this mutex
        // and is classified, or arrives after an explicit owner cancellation.
        progress.ended = Some((LeaseEnd::Cancelled, now));
        LeaseDisposition::Retire
    }

    pub fn failure_outcome(
        &self,
        authority_current: bool,
        seen: LeaseRevision,
        now: Instant,
    ) -> CaptureOutcome {
        if !authority_current {
            return CaptureOutcome::Suppressed;
        }
        let Ok(progress) = self.progress.lock() else {
            return CaptureOutcome::Failed;
        };
        let (reason, at) = progress.ended.unwrap_or((LeaseEnd::Failed, now));
        if reason == LeaseEnd::Cancelled
            || at >= progress.deadline(self.started)
            || progress.changes != seen
        {
            return CaptureOutcome::Suppressed;
        }
        CaptureOutcome::Failed
    }

    pub fn observed_changes(&self) -> Option<LeaseRevision> {
        self.progress
            .lock()
            .ok()
            .filter(|progress| progress.ended.is_none())
            .map(|progress| progress.changes)
    }

    pub fn retry_cancelled(
        &self,
        cancelled: CaptureFence,
        current: CaptureFence,
        admit: impl FnOnce() -> Result<bool>,
        request: impl FnOnce() -> Result<()>,
    ) -> Result<bool> {
        if cancelled.target != current.target
            || cancelled.epochs.window != current.epochs.window
            || cancelled.epochs.content == current.epochs.content
            || self.current().is_none()
        {
            return Ok(false);
        }
        if !admit()? {
            return Ok(false);
        }
        {
            let mut progress = self
                .progress
                .lock()
                .map_err(|_| "uia_lease_state_poisoned")?;
            if progress.ended.is_some()
                || progress.retried
                || Instant::now() >= progress.deadline(self.started)
            {
                return Ok(false);
            }
            progress.retried = true;
        }
        request()?;
        Ok(true)
    }

    /// Called only for the current pending/idle worker, never by its reader.
    /// Returns whether capture scheduling must observe a content invalidation.
    pub fn synchronize(
        &self,
        seen: &mut LeaseRevision,
        input_epoch: &AtomicU64,
        events: &EventEpochs,
    ) -> bool {
        let Ok(progress) = self.progress.lock() else {
            return false;
        };
        let changed = progress.changes;
        if changed.identity != seen.identity {
            input_epoch.fetch_add(changed.identity - seen.identity, Ordering::SeqCst);
        }
        let content_changed = changed.content != seen.content;
        if content_changed {
            events.content_changed();
        }
        *seen = changed;
        content_changed
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

pub fn input_identity_changed(event: u32, object: i32, child: i32, at_target: bool) -> bool {
    // RichEdit recreates its caret after Return. Destroying that object does
    // not destroy the admitted HWND; still invalidate the content snapshot.
    if event == 0x8001 && object == -8 && child == 0 && at_target {
        return false;
    }
    !matches!(
        event,
        0x800e // EVENT_OBJECT_VALUECHANGE
            | 0x8006 // EVENT_OBJECT_SELECTION
            | 0x8009 // EVENT_OBJECT_SELECTIONWITHIN
            | 0x8014 // EVENT_OBJECT_TEXTSELECTIONCHANGED
            | 0x11e // IA2_TEXT_INSERTED
            | 0x120 // IA2_TEXT_UPDATED
    )
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
    input_retry_source: Option<Instant>,
    input_retry_deadline: Option<Instant>,
    renewal_source: Option<Instant>,
}

impl CaptureSchedule {
    /// Reserve operation time plus one recorder and one worker polling turn.
    /// Consume once per accepted source, including a subsequently rejected spawn.
    pub fn renewal_due(
        &mut self,
        now: Instant,
        verified_at: Instant,
        epochs: Epochs,
        failures: u32,
    ) -> bool {
        let deadline = verified_at + SOURCE_FRESHNESS;
        if failures != 0
            || self.renewal_source == Some(verified_at)
            || now >= deadline
            || now < deadline - CAPTURE_LIMIT - RECORDER_POLL * 2
        {
            return false;
        }
        self.renewal_source = Some(verified_at);
        self.started(now, epochs);
        true
    }

    /// A queued action needs a verifier before its existing UIA lease ends.
    /// This only advances work whose normal rate limit would miss that bound;
    /// it does not renew the source or bypass a provider-failure backoff.
    pub fn input_due(&self, now: Instant, deadline: Instant, failures: u32) -> bool {
        failures == 0
            && now < deadline
            && self
                .last_attempt
                .is_some_and(|last| now > last && last + Duration::from_secs(3) >= deadline)
    }

    pub fn due(&self, now: Instant, dirty: bool, epochs: Epochs, failures: u32) -> bool {
        let Some(last_attempt) = self.last_attempt else {
            return dirty;
        };
        let elapsed = now.duration_since(last_attempt);
        if failures == 0
            && self
                .input_retry_deadline
                .is_some_and(|deadline| now < deadline)
        {
            return true;
        }
        let backoff = Duration::from_secs(if failures > 2 { 15 } else { 3 });
        elapsed >= backoff
            && (dirty
                || self.unsettled.is_some_and(|attempt| attempt != epochs)
                || elapsed >= Duration::from_secs(15))
    }

    pub fn started(&mut self, now: Instant, epochs: Epochs) {
        self.input_retry_deadline = None;
        self.last_attempt = Some(now);
        self.unsettled = Some(epochs);
    }

    /// One extra verifier for an already admitted source after content-only
    /// cancellation. Never extend that source's lifetime or a queued fact's TTL.
    pub fn retry_input_before(&mut self, source_started: Instant, deadline: Instant) {
        if self.input_retry_source != Some(source_started) {
            self.input_retry_source = Some(source_started);
            self.input_retry_deadline = Some(deadline);
        }
    }

    pub fn cancel_input_retry(&mut self) {
        self.input_retry_deadline = None;
    }

    /// Completion settles only the captured generation. Admission may have
    /// invalidated it; retain that work for a rate-limited fresh attempt.
    pub fn completed(&mut self, epochs: Epochs) {
        if self.unsettled == Some(epochs) {
            self.unsettled = None;
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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

    #[test]
    fn accepted_same_source_verifier_crosses_worker_expiry_without_renewing_action_age() {
        use crate::{
            input::{InputBatch, InputFact, InputKind, InputMode, InputScope, Modifiers},
            input_actions::Actions,
        };
        let start = Instant::now();
        let state = InputLeaseState::new(start);
        let revision = LeaseRevision {
            identity: 1,
            content: 1,
        };
        assert!(state.observe(revision, false, false));
        let seen = state.observed_changes().unwrap();
        assert!(
            !state.admits(revision.identity),
            "reader baseline is not admission"
        );
        assert!(state.accept_verified(0, start, revision, seen, || start
            + Duration::from_millis(100)));
        assert!(state.admits(revision.identity));
        let scope = InputScope {
            hwnd: 10,
            pid: 20,
            epoch: 1,
            focus_hwnd: 10,
            mode: InputMode::ObservedUia,
            uia_lease_epoch: Some(1),
        };
        let mut actions = Actions::default();
        actions.ingest(
            InputBatch {
                facts: vec![InputFact {
                    scope,
                    kind: InputKind::Return,
                    modifiers: Modifiers::default(),
                    os_time_ms: 1,
                    observed_at: start,
                    received_at: std::time::SystemTime::UNIX_EPOCH,
                }],
                interrupted: false,
            },
            scope,
            start,
        );
        let verifier = start + Duration::from_millis(2900);
        assert!(
            state.accept_verified(1, verifier, revision, seen, || verifier
                + Duration::from_millis(100),)
        );
        assert_eq!(
            state.started, start,
            "renewal cannot replace the subscription owner"
        );
        let past_worker_expiry = start + SOURCE_FRESHNESS + Duration::from_nanos(1);
        assert_eq!(
            state.current_at(past_worker_expiry),
            Some(revision),
            "a fully accepted verifier must survive the old worker expiry"
        );
        assert!(
            !actions
                .persist_next(past_worker_expiry, verifier, |_| {
                    panic!("renewal extended an old Return's original TTL")
                })
                .unwrap()
        );
        let next = start + Duration::from_millis(5800);
        assert!(state.accept_verified(2, next, revision, seen, || next + RECORDER_POLL));
        assert_eq!(
            state.current_at(start + Duration::from_secs(9)),
            Some(revision)
        );
        assert!(state.current_at(next + SOURCE_FRESHNESS).is_none());
    }

    #[test]
    fn verified_renewal_rejects_exact_deadline_stale_frames_and_terminal_races() {
        let start = Instant::now();
        let revision = LeaseRevision {
            identity: 1,
            content: 1,
        };
        for elapsed in [
            SOURCE_FRESHNESS - Duration::from_nanos(1),
            SOURCE_FRESHNESS,
            SOURCE_FRESHNESS + Duration::from_nanos(1),
        ] {
            let state = InputLeaseState::new(start);
            assert!(state.observe(revision, false, false));
            let seen = state.observed_changes().unwrap();
            assert!(state.accept_verified(0, start, revision, seen, || start));
            let capture = start + Duration::from_secs(4);
            assert_eq!(
                state.accept_verified(1, capture, revision, seen, || start + elapsed),
                elapsed < SOURCE_FRESHNESS,
                "publication must finish before the old deadline"
            );
        }
        for rejected in [
            "duplicate",
            "old",
            "future",
            "operation",
            "content",
            "identity",
            "eof",
        ] {
            let state = InputLeaseState::new(start);
            assert!(state.observe(revision, false, false));
            let seen = state.observed_changes().unwrap();
            assert!(state.accept_verified(0, start, revision, seen, || start));
            let now = start + Duration::from_secs(3);
            let capture = now - RECORDER_POLL;
            let mut request = 1;
            let mut at = capture;
            match rejected {
                "duplicate" => request = 0,
                "old" => at = start,
                "future" => at = now + RECORDER_POLL,
                "operation" => at = now - CAPTURE_LIMIT,
                "content" => {
                    assert!(state.observe(
                        LeaseRevision {
                            content: 2,
                            ..revision
                        },
                        true,
                        false
                    ));
                }
                "identity" => {
                    assert!(state.observe(
                        LeaseRevision {
                            identity: 2,
                            content: 2
                        },
                        true,
                        false
                    ));
                }
                "eof" => state.end_at(LeaseEnd::Eof, capture),
                _ => unreachable!(),
            }
            assert!(
                !state.accept_verified(request, at, revision, seen, || now),
                "{rejected}"
            );
            assert_eq!(state.verified_at(), Some(start), "{rejected}");
            if rejected == "identity" {
                assert!(!state.accept_verified(
                    1,
                    capture,
                    LeaseRevision {
                        identity: 2,
                        content: 2
                    },
                    state.observed_changes().unwrap(),
                    || now,
                ));
            }
            if rejected == "content" {
                // A genuinely fresh content verifier may renew the same identity.
                let fresh = LeaseRevision {
                    content: 2,
                    ..revision
                };
                assert!(state.accept_verified(
                    2,
                    capture,
                    fresh,
                    state.observed_changes().unwrap(),
                    || now,
                ));
            }
        }
    }

    #[test]
    fn renewal_preserves_first_terminal_time_and_content_retry_does_not_extend_freshness() {
        let start = Instant::now();
        let state = InputLeaseState::new(start);
        let revision = LeaseRevision {
            identity: 1,
            content: 1,
        };
        assert!(state.observe(revision, false, false));
        let seen = state.observed_changes().unwrap();
        assert!(state.accept_verified(0, start, revision, seen, || start));
        let renewed = start + Duration::from_secs(3);
        assert!(state.accept_verified(1, renewed, revision, seen, || renewed));
        let failed = start + Duration::from_secs(6);
        state.end_at(LeaseEnd::Eof, failed);
        state.end_at(LeaseEnd::Cancelled, failed + RECORDER_POLL);
        assert!(!state.accept_verified(2, failed, revision, seen, || failed + RECORDER_POLL,));
        assert_eq!(
            state.failure_outcome(true, seen, start + Duration::from_secs(20)),
            CaptureOutcome::Failed
        );
        assert_eq!(
            state.failure_outcome(false, seen, failed),
            CaptureOutcome::Suppressed
        );
        assert_eq!(
            state.progress.lock().unwrap().ended,
            Some((LeaseEnd::Eof, failed))
        );

        let state = InputLeaseState::new(start);
        assert!(state.observe(revision, false, false));
        assert!(state.accept_verified(0, start, revision, seen, || start));
        let cancelled = CaptureFence {
            target: (10, 20),
            epochs: Epochs {
                window: 1,
                content: 1,
            },
        };
        let current = CaptureFence {
            epochs: Epochs {
                content: 2,
                ..cancelled.epochs
            },
            ..cancelled
        };
        assert!(
            state
                .retry_cancelled(cancelled, current, || Ok(true), || Ok(()))
                .unwrap()
        );
        assert_eq!(state.verified_at(), Some(start));
        assert!(
            !state
                .retry_cancelled(cancelled, current, || Ok(true), || panic!("retry spun"))
                .unwrap()
        );
        assert!(state.current_at(start + SOURCE_FRESHNESS).is_none());
    }

    #[test]
    fn adaptive_renewal_reserves_operation_and_poll_margin_once_without_bypassing_backoff() {
        let start = Instant::now();
        let epochs = Epochs {
            window: 1,
            content: 1,
        };
        let early = start + SOURCE_FRESHNESS - CAPTURE_LIMIT - RECORDER_POLL * 2;
        let mut schedule = CaptureSchedule::default();
        schedule.started(start, epochs);
        schedule.completed(epochs);
        assert!(!schedule.due(early, true, epochs, 0));
        assert!(!schedule.renewal_due(early - Duration::from_nanos(1), start, epochs, 0));
        assert!(schedule.renewal_due(early, start, epochs, 0));
        assert!(!schedule.renewal_due(early + RECORDER_POLL, start, epochs, 0));
        assert!(!schedule.due(early + RECORDER_POLL, true, epochs, 0));
        for failures in [1, 3] {
            assert!(!schedule.renewal_due(early, start, epochs, failures));
        }
        assert!(!schedule.renewal_due(start + SOURCE_FRESHNESS, start, epochs, 0));
        let fresh = early;
        let next = fresh + SOURCE_FRESHNESS - CAPTURE_LIMIT - RECORDER_POLL * 2;
        assert!(schedule.renewal_due(next, fresh, epochs, 0));
        assert!(!schedule.due(next + Duration::from_secs(3), true, epochs, 3));
        assert!(schedule.due(next + Duration::from_secs(15), true, epochs, 3));
    }

    #[test]
    fn eof_between_completion_check_and_disposition_counts_once_without_admission() {
        for eof_before_disposition in [true, false] {
            let started = Instant::now();
            let state = InputLeaseState::new(started);
            let frame = LeaseRevision {
                identity: 1,
                content: 1,
            };
            assert!(state.observe(frame, false, false));
            let seen = state.observed_changes().unwrap();
            let mut health = CaptureHealth::default();
            assert!(!state.ended());
            if eof_before_disposition {
                // The reader wins after the recorder's last pre-disposition check.
                state.end(LeaseEnd::Eof);
            }
            let disposition = state.retain_completed(Some((frame, seen)), Some(frame.identity));
            if eof_before_disposition {
                assert_eq!(disposition, LeaseDisposition::Terminal);
            } else {
                assert_eq!(disposition, LeaseDisposition::Keep);
                health.observe(CaptureOutcome::Observed);
                // EOF after Keep is still owned by the next idle retirement.
                state.end(LeaseEnd::Eof);
            }
            health.observe(state.failure_outcome(true, seen, started));
            state.close();
            assert!(!state.admits(frame.identity));
            assert_eq!(
                health.failures, 1,
                "terminal retirement must be classified exactly once"
            );
        }
        let state = InputLeaseState::new(Instant::now());
        let frame = LeaseRevision {
            identity: 1,
            content: 1,
        };
        assert!(state.observe(frame, false, false));
        let seen = state.observed_changes().unwrap();
        assert!(state.observe(
            LeaseRevision {
                identity: 2,
                content: 2
            },
            true,
            false
        ));
        assert_eq!(
            state.retain_completed(Some((frame, seen)), Some(frame.identity)),
            LeaseDisposition::Retire,
        );
        // Retire revokes atomically; a later pipe shutdown is owner cancellation.
        state.end(LeaseEnd::Eof);
        assert!(!state.admits(2));
        assert_eq!(
            state.failure_outcome(true, seen, Instant::now()),
            CaptureOutcome::Suppressed
        );
    }

    #[test]
    fn completed_content_race_keeps_same_child_and_original_action_deadlines() {
        use crate::{
            input::{InputBatch, InputFact, InputKind, InputMode, InputScope, Modifiers},
            input_actions::Actions,
        };
        use std::sync::Arc;
        let started = Instant::now();
        let state = Arc::new(InputLeaseState::new(started));
        let mut child = Some(state.clone());
        let original = LeaseRevision {
            identity: 1,
            content: 1,
        };
        assert!(state.observe(original, false, false));
        let frame_stamp = state.observed_changes().unwrap();
        assert!(state.accept_verified(0, started, original, frame_stamp, || started));
        let scope = InputScope {
            hwnd: 10,
            pid: 20,
            epoch: 1,
            focus_hwnd: 11,
            mode: InputMode::ObservedUia,
            uia_lease_epoch: Some(1),
        };
        let mut actions = Actions::default();
        actions.ingest(
            InputBatch {
                facts: vec![InputFact {
                    scope,
                    kind: InputKind::Return,
                    modifiers: Modifiers::default(),
                    os_time_ms: 1,
                    observed_at: started,
                    received_at: std::time::SystemTime::UNIX_EPOCH,
                }],
                interrupted: false,
            },
            scope,
            started,
        );
        let fresh = LeaseRevision {
            content: 2,
            ..original
        };
        assert!(state.observe(fresh, true, false));
        assert!(state.admits(original.identity));
        assert!(!state.frame_current(original, frame_stamp));
        // This is the completion decision used by Pending, including its
        // otherwise destructive close of the shared input-source lease.
        if state.retain_completed(Some((original, frame_stamp)), Some(original.identity))
            != LeaseDisposition::Keep
        {
            child.take().unwrap().close();
        }
        assert!(
            child
                .as_ref()
                .is_some_and(|child| Arc::ptr_eq(child, &state))
        );
        assert!(state.admits(original.identity));
        assert_eq!(state.started, started);
        assert!(state.observe(fresh, false, false));
        assert!(state.frame_current(fresh, state.observed_changes().unwrap()));
        let facts = actions.take(
            started + Duration::from_secs(1),
            started + Duration::from_secs(1),
        );
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].kind, "keyboard.submit");
        assert_eq!(facts[0].received_at, std::time::SystemTime::UNIX_EPOCH);
        assert!(
            actions
                .take(
                    started + Duration::from_secs(2),
                    started + Duration::from_secs(2)
                )
                .is_empty()
        );
        actions.ingest(
            InputBatch {
                facts: vec![InputFact {
                    scope,
                    kind: InputKind::Return,
                    modifiers: Modifiers::default(),
                    os_time_ms: 2,
                    observed_at: started,
                    received_at: std::time::SystemTime::UNIX_EPOCH,
                }],
                interrupted: false,
            },
            scope,
            started,
        );
        assert!(
            actions
                .take(
                    started + Duration::from_secs(5) + Duration::from_nanos(1),
                    started + Duration::from_secs(4),
                )
                .is_empty(),
            "same-child verification cannot renew the fact TTL"
        );
        assert_eq!(
            state.retain_completed(Some((original, frame_stamp)), Some(2)),
            LeaseDisposition::Retire
        );
        let expired = InputLeaseState::new(started - Duration::from_secs(5));
        assert!(expired.observe(fresh, false, false));
        assert_eq!(
            expired.retain_completed(Some((fresh, frame_stamp)), Some(1)),
            LeaseDisposition::Retire
        );
        state.close();
        assert_eq!(
            state.retain_completed(Some((fresh, frame_stamp)), Some(1)),
            LeaseDisposition::Terminal
        );
    }

    #[test]
    fn unexpected_closed_lease_accumulates_failures_and_enforces_backoff() {
        let now = Instant::now();
        let events = EventEpochs::new();
        let input_epoch = AtomicU64::new(0);
        let mut health = CaptureHealth::default();
        let mut schedule = CaptureSchedule::default();
        schedule.started(now, events.current());
        for baseline in [false, true, false] {
            let state = InputLeaseState::new(now);
            let mut seen = LeaseRevision::default();
            let fence = lease_fence(&events);
            if baseline {
                assert!(state.observe(
                    LeaseRevision {
                        identity: 1,
                        content: 1
                    },
                    false,
                    false
                ));
            }
            state.end(LeaseEnd::Eof);
            state.synchronize(&mut seen, &input_epoch, &events);
            health.observe(state.failure_outcome(fence.allows(live(&events)), seen, now));
            assert!(state.current().is_none());
        }
        assert_eq!(health.failures, 3);
        assert!(!schedule.due(
            now + Duration::from_secs(3),
            true,
            events.current(),
            health.failures
        ));
        assert!(schedule.due(
            now + Duration::from_secs(15),
            true,
            events.current(),
            health.failures
        ));
        assert!(health.due("running", now));
        health.published("running", now);
        health.observe(CaptureOutcome::Observed);
        assert_eq!(health.failures, 0);
        assert!(health.due("running", now));
    }

    #[test]
    fn terminal_reason_uses_original_deadline_and_external_cancellation_precedence() {
        let started = Instant::now();
        let revision = LeaseRevision {
            identity: 1,
            content: 1,
        };
        let before_expiry = started + Duration::from_secs(5) - Duration::from_nanos(1);
        let expiry = started + Duration::from_secs(5);
        for reason in [
            LeaseEnd::Completed,
            LeaseEnd::Eof,
            LeaseEnd::InvalidOutput,
            LeaseEnd::Revoked,
            LeaseEnd::Failed,
        ] {
            for (ended, expected) in [
                (before_expiry, CaptureOutcome::Failed),
                (expiry, CaptureOutcome::Suppressed),
            ] {
                let state = InputLeaseState::new(started);
                assert!(state.observe(revision, false, false));
                state.end_at(reason, ended);
                assert!(state.ended());
                assert!(state.current().is_none());
                // A delayed owner must not reinterpret an earlier crash as
                // graceful expiry. Later Drop/EOF cannot replace its reason.
                state.close();
                state.end_at(LeaseEnd::Eof, expiry + Duration::from_secs(1));
                assert_eq!(
                    state.failure_outcome(
                        true,
                        LeaseRevision::default(),
                        expiry + Duration::from_secs(2)
                    ),
                    expected,
                    "{reason:?}"
                );
                assert_eq!(
                    state.failure_outcome(false, LeaseRevision::default(), expiry),
                    CaptureOutcome::Suppressed
                );
            }
        }
        let state = InputLeaseState::new(started);
        state.close();
        assert_eq!(
            state.failure_outcome(true, LeaseRevision::default(), started),
            CaptureOutcome::Suppressed
        );
        let unended = InputLeaseState::new(started);
        assert_eq!(
            unended.failure_outcome(true, LeaseRevision::default(), before_expiry),
            CaptureOutcome::Failed
        );
        assert_eq!(
            unended.failure_outcome(true, LeaseRevision::default(), expiry),
            CaptureOutcome::Suppressed
        );

        for changed in [false, true] {
            let state = InputLeaseState::new(started);
            let events = EventEpochs::new();
            let input_epoch = AtomicU64::new(0);
            let fence = lease_fence(&events);
            let mut seen = LeaseRevision::default();
            assert!(state.observe(revision, false, false));
            // A revoked bit alone is also emitted by cleanup/exhaustion. A
            // genuine identity/content change must still win over termination.
            assert!(!state.observe(
                LeaseRevision {
                    identity: if changed { 2 } else { 1 },
                    ..revision
                },
                true,
                true,
            ));
            assert_eq!(
                state.failure_outcome(true, seen, started),
                if changed {
                    CaptureOutcome::Suppressed
                } else {
                    CaptureOutcome::Failed
                },
            );
            assert_eq!(state.synchronize(&mut seen, &input_epoch, &events), changed);
            assert_eq!(input_epoch.load(Ordering::SeqCst), u64::from(changed));
            assert_eq!(
                state.failure_outcome(fence.allows(live(&events)), seen, started),
                if changed {
                    CaptureOutcome::Suppressed
                } else {
                    CaptureOutcome::Failed
                },
            );
        }
    }

    #[test]
    fn raced_lease_requests_once_immediately_without_waiting_for_worker_timeout() {
        use std::cell::Cell;
        let state = InputLeaseState::new(Instant::now());
        let original_time = state.started;
        let events = EventEpochs::new();
        let input_epoch = AtomicU64::new(0);
        let mut seen = LeaseRevision::default();
        let cancelled = lease_fence(&events);
        let revision = LeaseRevision {
            identity: 1,
            content: 2,
        };
        assert!(state.observe(revision, true, false));
        assert!(state.synchronize(&mut seen, &input_epoch, &events));
        let current = lease_fence(&events);
        let requests = Cell::new(0);
        assert!(
            state
                .retry_cancelled(
                    cancelled,
                    current,
                    || {
                        current.after_preparation(
                            || Ok(true),
                            || LiveState {
                                queue_drained: true,
                                parent_alive: true,
                                stopping: false,
                                desktop_available: true,
                                foreground: Some(current.target),
                                epochs: events.current(),
                            },
                        )
                    },
                    || {
                        requests.set(requests.get() + 1);
                        Ok(())
                    }
                )
                .unwrap()
        );
        assert_eq!(requests.get(), 1);
        assert_eq!(state.started, original_time);
        assert!(state.started.elapsed() < Duration::from_secs(2));
        assert!(
            !state
                .retry_cancelled(
                    cancelled,
                    current,
                    || Ok(true),
                    || { panic!("same child cannot retry twice") }
                )
                .unwrap()
        );
        assert!(state.observe(revision, false, false));
        assert!(state.frame_current(revision, seen));

        for rejected in ["identity", "target", "policy", "expired", "closed"] {
            let state = InputLeaseState::new(if rejected == "expired" {
                Instant::now() - Duration::from_secs(5)
            } else {
                Instant::now()
            });
            assert!(state.observe(revision, true, false));
            if rejected == "closed" {
                state.close();
            }
            let mut current = current;
            if rejected == "identity" {
                current.epochs.window += 1;
            }
            if rejected == "target" {
                current.target.1 += 1;
            }
            assert!(
                !state
                    .retry_cancelled(
                        cancelled,
                        current,
                        || Ok(rejected != "policy"),
                        || panic!("rejected source cannot request"),
                    )
                    .unwrap(),
                "{rejected}"
            );
        }
    }

    #[test]
    fn late_lease_action_is_verified_before_expiry_without_widening_failure_backoff() {
        let started = Instant::now();
        let events = EventEpochs::new();
        let deadline = started + Duration::from_secs(5);
        let mut schedule = CaptureSchedule::default();
        schedule.started(started, events.current());
        assert!(!schedule.input_due(started + Duration::from_secs(1), deadline, 0));
        schedule.started(started + Duration::from_secs(3), events.current());
        let action_at = started + Duration::from_millis(3250);
        assert!(!schedule.due(action_at, true, events.current(), 0));
        assert!(schedule.input_due(action_at, deadline, 0));
        assert!(!schedule.input_due(action_at, deadline, 1));
        assert!(!schedule.input_due(action_at, deadline, 3));
        assert!(!schedule.input_due(deadline, deadline, 0));
        schedule.started(action_at, events.current());
        assert!(!schedule.input_due(action_at, deadline, 0));
    }

    fn lease_fence(events: &EventEpochs) -> CaptureFence {
        CaptureFence {
            target: (10, 20),
            epochs: events.current(),
        }
    }

    fn lease_admitted(
        state: &InputLeaseState,
        frame: LeaseRevision,
        seen: LeaseRevision,
        fence: CaptureFence,
        events: &EventEpochs,
    ) -> bool {
        fence
            .after_preparation(
                || Ok(true),
                || LiveState {
                    queue_drained: true,
                    parent_alive: true,
                    stopping: false,
                    desktop_available: true,
                    foreground: Some((10, 20)),
                    epochs: events.current(),
                },
            )
            .unwrap()
            && state.frame_current(frame, seen)
    }

    #[test]
    fn first_lease_snapshot_admits_and_actual_invalidation_rejects_then_recovers() {
        let state = InputLeaseState::new(Instant::now());
        let events = EventEpochs::new();
        let input_epoch = AtomicU64::new(0);
        let fence = lease_fence(&events);
        let mut seen = LeaseRevision::default();
        let first = LeaseRevision {
            identity: 1,
            content: 1,
        };
        assert!(!state.frame_current(first, seen));
        assert!(state.observe(first, false, false));
        assert_eq!(state.observed_changes(), Some(seen));
        assert!(!state.synchronize(&mut seen, &input_epoch, &events));
        assert_eq!(input_epoch.load(Ordering::SeqCst), 0);
        assert!(lease_admitted(&state, first, seen, fence, &events));

        let changed = LeaseRevision {
            identity: 2,
            content: 2,
        };
        assert!(state.observe(changed, true, false));
        assert_ne!(state.observed_changes(), Some(seen));
        assert!(!state.admits(first.identity));
        assert!(!lease_admitted(&state, first, seen, fence, &events));
        assert!(state.synchronize(&mut seen, &input_epoch, &events));
        assert_eq!(input_epoch.load(Ordering::SeqCst), 1);
        assert!(!lease_admitted(&state, changed, seen, fence, &events));

        let retry = lease_fence(&events);
        assert!(state.observe(changed, false, false));
        assert!(!state.synchronize(&mut seen, &input_epoch, &events));
        assert!(lease_admitted(&state, changed, seen, retry, &events));
    }

    #[test]
    fn invalidation_before_first_snapshot_and_after_preparation_cannot_be_a_baseline() {
        let state = InputLeaseState::new(Instant::now());
        let events = EventEpochs::new();
        let input_epoch = AtomicU64::new(0);
        let fence = lease_fence(&events);
        let mut seen = LeaseRevision::default();
        let first = LeaseRevision {
            identity: 1,
            content: 1,
        };
        assert!(state.observe(first, true, false));
        assert!(state.observe(first, false, false));
        assert!(state.synchronize(&mut seen, &input_epoch, &events));
        assert!(!lease_admitted(&state, first, seen, fence, &events));
        let retry = lease_fence(&events);
        assert!(lease_admitted(&state, first, seen, retry, &events));
        // Even unchanged revision numbers in an explicit invalidation must
        // reject a frame whose preparation preceded that notification.
        assert!(state.observe(first, true, false));
        assert!(!lease_admitted(&state, first, seen, retry, &events));
    }

    #[test]
    fn retired_reader_frames_and_eof_do_not_invalidate_replacement_owner() {
        let old = std::sync::Arc::new(InputLeaseState::new(Instant::now()));
        let reader = old.clone();
        let events = EventEpochs::new();
        let input_epoch = AtomicU64::new(0);
        let first = LeaseRevision {
            identity: 1,
            content: 1,
        };
        assert!(old.observe(first, false, false));
        old.close();
        drop(old);

        let current = InputLeaseState::new(Instant::now());
        let mut seen = LeaseRevision::default();
        let fence = lease_fence(&events);
        assert!(current.observe(first, false, false));
        assert!(!reader.observe(
            LeaseRevision {
                identity: 2,
                content: 3
            },
            true,
            false
        ));
        reader.close();
        assert!(!current.synchronize(&mut seen, &input_epoch, &events));
        assert_eq!(input_epoch.load(Ordering::SeqCst), 0);
        assert!(lease_admitted(&current, first, seen, fence, &events));
    }

    #[test]
    fn lease_regression_revocation_eof_and_absolute_expiry_fail_closed() {
        for operation in 0..4 {
            let state = InputLeaseState::new(Instant::now());
            let first = LeaseRevision {
                identity: 3,
                content: 5,
            };
            assert!(state.observe(first, false, false));
            match operation {
                0 => assert!(!state.observe(
                    LeaseRevision {
                        identity: 2,
                        ..first
                    },
                    false,
                    false
                )),
                1 => assert!(!state.observe(
                    LeaseRevision {
                        content: 4,
                        ..first
                    },
                    false,
                    false
                )),
                2 => assert!(!state.observe(first, true, true)),
                _ => state.close(),
            }
            assert!(!state.admits(first.identity));
            assert!(!state.observe(first, false, false));
        }
        let expired = InputLeaseState::new(Instant::now() - Duration::from_secs(5));
        let first = LeaseRevision {
            identity: 1,
            content: 1,
        };
        assert!(expired.observe(first, false, false));
        assert!(expired.current().is_none());
    }

    #[test]
    fn target_caret_destruction_invalidates_capture_without_erasing_received_return() {
        use crate::{
            input::{InputBatch, InputFact, InputKind, InputScope, Modifiers},
            input_actions::Actions,
        };
        let now = Instant::now();
        let scope = InputScope {
            hwnd: 10,
            pid: 20,
            epoch: 1,
            focus_hwnd: 11,
            mode: crate::input::InputMode::NativeChild,
            uia_lease_epoch: None,
        };
        let mut actions = Actions::default();
        actions.ingest(
            InputBatch {
                facts: vec![InputFact {
                    scope,
                    kind: InputKind::Return,
                    modifiers: Modifiers::default(),
                    os_time_ms: 100,
                    observed_at: now,
                    received_at: std::time::SystemTime::UNIX_EPOCH,
                }],
                interrupted: false,
            },
            scope,
            now,
        );
        let epochs = EventEpochs::new();
        let before = epochs.current();
        epochs.content_changed();
        if input_identity_changed(0x8001, -8, 0, true) {
            actions.clear();
        }
        assert_ne!(
            before,
            epochs.current(),
            "old snapshots must still be discarded"
        );
        let result = actions.take(now, now);
        assert_eq!(
            result.len(),
            1,
            "destroying the caret is not destroying its Edit"
        );
        assert_eq!(result[0].kind, "keyboard.submit");
        for (event, object, child, target) in [
            (0x8001, 0, 0, true),   // window destruction
            (0x8001, -4, 0, true),  // client destruction
            (0x8001, -8, 1, true),  // unknown child
            (0x8001, -8, 0, false), // unadmitted control
            (0x8005, -8, 0, true),  // focus
            (0x800c, -8, 0, true),  // name
            (0x800d, -8, 0, true),  // description
        ] {
            assert!(input_identity_changed(event, object, child, target));
        }
    }

    #[test]
    fn teardown_attempts_all_owners_and_preserves_the_first_error() {
        use std::cell::RefCell;
        for fail in [None, Some(0), Some(1), Some(2), Some(3)] {
            let calls = RefCell::new(Vec::new());
            let result = |phase| -> Result<()> {
                calls.borrow_mut().push(phase);
                if fail.is_some_and(|first| phase >= first) {
                    Err(format!("phase-{phase}").into())
                } else {
                    Ok(())
                }
            };
            let outcome = finish_recording(
                result(0),
                || result(1),
                || result(2),
                |clean| {
                    assert_eq!(clean, fail.is_none_or(|first| first == 3));
                    result(3)
                },
            );
            assert_eq!(*calls.borrow(), vec![0, 1, 2, 3]);
            assert_eq!(
                outcome.err().map(|error| error.to_string()),
                fail.map(|first| format!("phase-{first}")),
            );
        }
    }
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
#[test]
fn cancelled_input_verifier_retries_once_before_original_source_expires() {
    let start = Instant::now();
    let epochs = EventEpochs::new();
    let mut schedule = CaptureSchedule::default();
    schedule.started(start, epochs.current());
    schedule.completed(epochs.current());
    schedule.started(start + Duration::from_secs(3), epochs.current());
    epochs.content_changed();
    let retry = start + Duration::from_millis(3100);
    assert!(!schedule.due(retry, true, epochs.current(), 0));
    schedule.retry_input_before(start, start + Duration::from_secs(5));
    assert!(schedule.due(retry, true, epochs.current(), 0));
    assert!(!schedule.due(retry, true, epochs.current(), 1));
    assert!(!schedule.due(retry, true, epochs.current(), 3));
    assert!(!schedule.due(start + Duration::from_secs(5), true, epochs.current(), 0));
    schedule.started(retry, epochs.current());
    epochs.content_changed();
    schedule.retry_input_before(start, start + Duration::from_secs(5));
    assert!(!schedule.due(retry + Duration::from_millis(50), true, epochs.current(), 0));
    schedule.retry_input_before(retry, retry + Duration::from_secs(5));
    schedule.cancel_input_retry();
    assert!(!schedule.due(retry + Duration::from_millis(50), true, epochs.current(), 0));
    assert!(schedule.due(retry + Duration::from_secs(3), true, epochs.current(), 0));
}
