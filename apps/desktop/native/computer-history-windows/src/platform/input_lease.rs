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

//! Metadata-only subscriptions owned by the existing snapshot worker's MTA.
//! Successful same-source reads renew worker liveness, not recorder admission.
//! Epoch equality is necessary, not sufficient, for source admission:
//! providers may omit events, so every capture still needs final privacy checks.

use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

const LEASE_LIFETIME: Duration = Duration::from_secs(5);
const OPERATION_LIMIT: Duration = Duration::from_secs(2);
const MAX_REQUEST_BYTES: usize = 128;
const MAX_REQUESTS: usize = 8;
const MAX_FRAME_BYTES: usize = 128 * 1024;
const EPOCH_BITS: u32 = 31;
const EPOCH_MASK: u64 = (1 << EPOCH_BITS) - 1;
const REVOKED: u64 = 1 << (EPOCH_BITS * 2);
const CALLBACK_ATTEMPTS: usize = 8;

/// Valid only within the caller's same source lease, never across worker restarts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LeaseEpochs {
    pub identity: u64,
    pub content: u64,
    pub revoked: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CompletionReason {
    Native,
    BodyOnly,
    SubscriptionFailure,
}

/// Private snapshot-child wire. The parent additionally binds every frame to
/// its held child/source and rejects late, unknown or nonmonotonic responses.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
// Frames are parsed individually; the bounded parent queue stores wire bytes.
// Boxing adds an allocation without reducing that queue's memory footprint.
#[allow(clippy::large_enum_variant)]
pub enum LeaseFrame {
    Snapshot {
        request: u64,
        identity: u64,
        content: u64,
        snapshot: Option<crate::model::Snapshot>,
    },
    Invalidated {
        identity: u64,
        content: u64,
        revoked: bool,
    },
    Completed {
        request: u64,
        reason: CompletionReason,
        snapshot: Option<crate::model::Snapshot>,
    },
}

/// Completion never carries external UIA authority. The parent must also
/// require clean EOF, successful child exit and its original final fence.
pub fn valid_completion(
    reason: CompletionReason,
    snapshot: Option<&crate::model::Snapshot>,
) -> bool {
    let target = snapshot.and_then(|snapshot| snapshot.input_target.as_ref());
    match reason {
        CompletionReason::Native => target.is_some_and(|target| target.uia.is_none()),
        CompletionReason::BodyOnly | CompletionReason::SubscriptionFailure => target.is_none(),
    }
}

fn initial_frame(
    epochs: Option<(LeaseEpochs, LeaseEpochs)>,
    mut snapshot: Option<crate::model::Snapshot>,
    subscription_failed: bool,
) -> crate::control::Result<LeaseFrame> {
    if subscription_failed {
        if epochs.is_some() {
            return Err("invalid_uia_lease_completion".into());
        }
        if let Some(snapshot) = &mut snapshot {
            snapshot.input_target = None;
        }
        return Ok(LeaseFrame::Completed {
            request: 0,
            reason: CompletionReason::SubscriptionFailure,
            snapshot,
        });
    }
    if let Some((before, after)) = epochs
        && (before != after || after.revoked)
    {
        return Ok(invalidation(after));
    }
    let target = snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.input_target.as_ref());
    if target.is_some_and(|target| target.uia.is_some())
        || (epochs.is_some() && snapshot.as_ref().is_some_and(observation_only))
    {
        let Some((before, after)) = epochs else {
            return Err("uia_input_without_subscription".into());
        };
        return Ok(capture_frame(0, before, after, snapshot));
    }
    Ok(LeaseFrame::Completed {
        request: 0,
        reason: if target.is_some() {
            CompletionReason::Native
        } else {
            CompletionReason::BodyOnly
        },
        snapshot,
    })
}

fn capture_frame(
    request: u64,
    before: LeaseEpochs,
    after: LeaseEpochs,
    snapshot: Option<crate::model::Snapshot>,
) -> LeaseFrame {
    if before != after || after.revoked {
        invalidation(after)
    } else {
        LeaseFrame::Snapshot {
            request,
            identity: after.identity,
            content: after.content,
            snapshot,
        }
    }
}

fn invalidation(epochs: LeaseEpochs) -> LeaseFrame {
    LeaseFrame::Invalidated {
        identity: epochs.identity,
        content: epochs.content,
        revoked: epochs.revoked,
    }
}

fn encode_frame(frame: &LeaseFrame) -> crate::control::Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec(frame).map_err(|_| "invalid_uia_lease_frame")?;
    // The parent bounds the whole line, including the newline.
    if bytes.len() >= MAX_FRAME_BYTES {
        return Err("uia_lease_frame_too_large".into());
    }
    bytes.push(b'\n');
    Ok(bytes)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    request: u64,
}

#[derive(Default)]
struct Requests {
    partial: Vec<u8>,
    ready: VecDeque<u64>,
    last: u64,
}

impl Requests {
    fn push(&mut self, bytes: &[u8]) -> crate::control::Result<()> {
        for byte in bytes {
            if *byte != b'\n' {
                if self.partial.len() >= MAX_REQUEST_BYTES {
                    return Err("uia_lease_request_too_large".into());
                }
                self.partial.push(*byte);
                continue;
            }
            let request: Request =
                serde_json::from_slice(&self.partial).map_err(|_| "invalid_uia_lease_request")?;
            if request.request <= self.last || self.ready.len() == MAX_REQUESTS {
                return Err("uia_lease_request_order_or_capacity".into());
            }
            self.partial.clear();
            self.last = request.request;
            self.ready.push_back(request.request);
        }
        Ok(())
    }
}

/// Only the MTA completes operations; the calling thread watches both deadlines.
/// Expiry is sticky so a late read or phase transition cannot revive the worker.
struct Deadlines {
    state: Mutex<DeadlineState>,
}

struct DeadlineState {
    live_until: Instant,
    operation: Option<Instant>,
    expired: bool,
}

impl DeadlineState {
    fn expired(&mut self, now: Instant) -> bool {
        self.expired |= now >= self.live_until
            || self
                .operation
                .is_some_and(|start| now.saturating_duration_since(start) >= OPERATION_LIMIT);
        self.expired
    }
}

impl Deadlines {
    fn new(started: Instant) -> Self {
        Self {
            state: Mutex::new(DeadlineState {
                live_until: started + LEASE_LIFETIME,
                operation: Some(started),
                expired: false,
            }),
        }
    }

    fn begin(&self, now: Instant) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        if state.expired(now) || state.operation.is_some() {
            return false;
        }
        state.operation = Some(now);
        true
    }

    fn finish(&self, now: Instant, renew: bool) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        if state.expired(now) {
            return false;
        }
        let Some(started) = state.operation.take() else {
            return false;
        };
        if renew {
            state.live_until = started + LEASE_LIFETIME;
        }
        true
    }

    fn expired(&self, now: Instant) -> bool {
        self.state
            .lock()
            .map_or(true, |mut state| state.expired(now))
    }
}

/// Item observation eligibility is independent of physical-input authority.
pub(crate) fn observation_only(snapshot: &crate::model::Snapshot) -> bool {
    snapshot.input_target.is_none()
        && snapshot.source_known
        && !snapshot.secure
        && !snapshot.private
        && snapshot
            .item_selection
            .as_ref()
            .is_some_and(|items| !items.owner_runtime_id.is_empty())
}

pub(crate) fn observation_source(snapshot: &crate::model::Snapshot) -> crate::model::Snapshot {
    let mut source = snapshot.without_content();
    source.item_selection =
        snapshot
            .item_selection
            .as_ref()
            .map(|selection| crate::model::ItemSelection {
                owner_runtime_id: selection.owner_runtime_id.clone(),
                document_runtime_id: selection.document_runtime_id.clone(),
                items: Vec::new(),
            });
    source
}

pub(crate) fn same_observation_source(
    original: &crate::model::Snapshot,
    fresh: &crate::model::Snapshot,
) -> bool {
    observation_only(original)
        && observation_only(fresh)
        && original.source_id == fresh.source_id
        && original.window_id == fresh.window_id
        && original.pid == fresh.pid
        && original.app_id == fresh.app_id
        && original.application_user_model_id == fresh.application_user_model_id
        && original.title == fresh.title
        && original.url == fresh.url
        && original.domains == fresh.domains
        && original
            .item_selection
            .as_ref()
            .zip(fresh.item_selection.as_ref())
            .is_some_and(|(a, b)| {
                a.owner_runtime_id == b.owner_runtime_id
                    && a.document_runtime_id == b.document_runtime_id
            })
}

fn renewable_snapshot(
    frame: &LeaseFrame,
    baseline: Option<&(u64, crate::model::Snapshot)>,
) -> bool {
    let LeaseFrame::Snapshot {
        identity,
        snapshot: Some(snapshot),
        ..
    } = frame
    else {
        return false;
    };
    let (original_identity, original) = baseline
        .map(|(identity, snapshot)| (*identity, snapshot))
        .unwrap_or((*identity, snapshot));
    *identity == original_identity
        && (crate::input_actions::same_input_source(original, snapshot)
            || same_observation_source(original, snapshot))
}

#[derive(Clone, Copy)]
enum Change {
    Identity,
    Content,
}

struct EpochState(AtomicU64);

impl EpochState {
    fn new() -> Self {
        Self(AtomicU64::new(1 | (1 << EPOCH_BITS)))
    }

    fn epochs(&self) -> LeaseEpochs {
        let value = self.0.load(Ordering::Acquire);
        LeaseEpochs {
            identity: value & EPOCH_MASK,
            content: (value >> EPOCH_BITS) & EPOCH_MASK,
            revoked: value & REVOKED != 0,
        }
    }

    fn revoke(&self) {
        self.0.fetch_or(REVOKED, Ordering::AcqRel);
    }

    fn changed(&self, change: Change) {
        // A single atomic prevents torn identity/content observations. The
        // callback never waits for the worker or makes provider calls.
        let mut value = self.0.load(Ordering::Acquire);
        for _ in 0..CALLBACK_ATTEMPTS {
            if value & REVOKED != 0 {
                return;
            }
            let identity_change = matches!(change, Change::Identity);
            if (value >> EPOCH_BITS) & EPOCH_MASK == EPOCH_MASK
                || (identity_change && value & EPOCH_MASK == EPOCH_MASK)
            {
                self.revoke();
                return;
            }
            let next = value + (1 << EPOCH_BITS) + u64::from(identity_change);
            match self
                .0
                .compare_exchange_weak(value, next, Ordering::AcqRel, Ordering::Acquire)
            {
                Ok(_) => return,
                Err(current) => value = current,
            }
        }
        // Contention cannot create an unbounded hook/provider callback backlog.
        self.revoke();
    }
}

struct EpochNotices {
    state: Arc<EpochState>,
    seen: LeaseEpochs,
}

impl EpochNotices {
    fn new() -> Self {
        let state = Arc::new(EpochState::new());
        let seen = state.epochs();
        Self { state, seen }
    }

    fn take(&mut self) -> Option<LeaseEpochs> {
        let latest = self.state.epochs();
        if self.seen == latest {
            return None;
        }
        self.seen = latest;
        Some(latest)
    }

    fn delivered(&mut self, epochs: LeaseEpochs) {
        // A callback can advance state while stdout is blocked. Acknowledge
        // only the frame's exact stamp so that later changes remain pending.
        self.seen = epochs;
    }

    fn revoke_current(&self, expected: LeaseEpochs) -> bool {
        let previous = self.state.0.fetch_or(REVOKED, Ordering::AcqRel);
        !expected.revoked && previous == (expected.identity | (expected.content << EPOCH_BITS))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
enum Subscription {
    Property,
    Structure,
    Focus,
    Text,
    Selection,
    ItemSelected,
    ItemAdded,
    ItemRemoved,
    SelectionInvalidated,
}

const SUBSCRIPTIONS: [Subscription; 9] = [
    Subscription::Property,
    Subscription::Structure,
    Subscription::Focus,
    Subscription::Text,
    Subscription::Selection,
    Subscription::ItemSelected,
    Subscription::ItemAdded,
    Subscription::ItemRemoved,
    Subscription::SelectionInvalidated,
];

/// Keep successful removals distinct so a failed cleanup retries only its
/// remaining registrations, without removing another caller's subscriptions.
#[derive(Default)]
struct Registrations(u16);

impl Registrations {
    fn install<E>(
        &mut self,
        mut add: impl FnMut(Subscription) -> std::result::Result<(), E>,
    ) -> std::result::Result<(), E> {
        for subscription in SUBSCRIPTIONS {
            add(subscription)?;
            self.0 |= 1 << subscription as u8;
        }
        Ok(())
    }

    fn close<E>(
        &mut self,
        mut remove: impl FnMut(Subscription) -> std::result::Result<(), E>,
    ) -> std::result::Result<(), E> {
        let mut error = None;
        for subscription in SUBSCRIPTIONS.into_iter().rev() {
            let mask = 1 << subscription as u8;
            if self.0 & mask == 0 {
                continue;
            }
            match remove(subscription) {
                Ok(()) => self.0 &= !mask,
                Err(current) if error.is_none() => error = Some(current),
                Err(_) => {}
            }
        }
        error.map_or(Ok(()), Err)
    }
}

#[cfg(windows)]
pub use native::LeaseSubscriptions;

#[cfg(windows)]
pub(super) use runner::run;

#[cfg(windows)]
mod runner {
    use super::*;
    use crate::{
        control::{Control, Result, State},
        model::{Policy, read_regular},
        platform::{self, ownership::Parent, snapshot},
    };
    use std::{
        fs::File,
        io::{Read, Write},
        os::windows::io::{AsHandle, AsRawHandle},
        path::{Path, PathBuf},
        sync::atomic::AtomicBool,
        thread,
    };
    use windows::{
        Win32::{
            System::{
                Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize},
                Pipes::PeekNamedPipe,
            },
            UI::Accessibility::IUIAutomation,
        },
        core::Interface,
    };

    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    fn admitted(home: &Path, control: &Control, config: &[u8], target: (usize, u32)) -> bool {
        platform::require_consent(home).is_ok()
            && Control::load(home).is_ok_and(|current| platform::same_control(control, &current))
            && read_regular(&home.join("config.json"), 256 * 1024)
                .is_ok_and(|current| current == config)
            && platform::interactive_desktop()
            && platform::foreground() == Some(target)
    }

    fn write_frame(frame: &LeaseFrame) -> Result<()> {
        let bytes = encode_frame(frame)?;
        let mut stdout = std::io::stdout().lock();
        stdout.write_all(&bytes)?;
        stdout.flush()?;
        Ok(())
    }

    fn worker(
        home: PathBuf,
        target: (usize, u32),
        source: String,
        stop: Arc<AtomicBool>,
        deadlines: Arc<Deadlines>,
    ) -> Result<()> {
        let control = Control::load(&home)?;
        let config = read_regular(&home.join("config.json"), 256 * 1024)?;
        Policy::load(&home)?;
        if stop.load(Ordering::Acquire) || !admitted(&home, &control, &config, target) {
            return Err("uia_lease_not_admitted".into());
        }
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .map_err(|_| "uia_initialization_failed")?;
        let _apartment = Apartment;
        let mut subscriptions: Option<LeaseSubscriptions> = None;
        let result = (|| -> Result<()> {
            let current = || {
                !stop.load(Ordering::Acquire)
                    && !deadlines.expired(Instant::now())
                    && admitted(&home, &control, &config, target)
            };
            let mut prepared = false;
            let mut subscription_failed = false;
            let mut before = None;
            // The snapshot owns the one automation setup and body traversal.
            // Preparation can install only metadata subscriptions on its root.
            let snapshot = snapshot::capture_prepared(
                &home,
                target.0,
                target.1,
                source.clone(),
                &mut |automation, root, needed| {
                    if prepared || !current() {
                        return Err("uia_lease_preparation_not_admitted".into());
                    }
                    prepared = true;
                    if !needed {
                        return Ok(false);
                    }
                    let automation: IUIAutomation = automation.cast()?;
                    subscriptions = LeaseSubscriptions::install(&automation, root)?;
                    subscription_failed = subscriptions.is_none();
                    if !current() {
                        return Err("uia_lease_preparation_not_admitted".into());
                    }
                    before = subscriptions.as_ref().map(LeaseSubscriptions::epochs);
                    if before.is_some_and(|epochs| epochs.revoked) {
                        return Err("uia_lease_revoked".into());
                    }
                    Ok(subscriptions.is_some())
                },
            )?;
            if !current() {
                return Err("uia_lease_not_admitted".into());
            }
            let after = subscriptions.as_ref().map(LeaseSubscriptions::epochs);
            let frame = initial_frame(before.zip(after), snapshot, subscription_failed)?;
            if let LeaseFrame::Completed {
                reason, snapshot, ..
            } = &frame
            {
                if !valid_completion(*reason, snapshot.as_ref()) {
                    return Err("invalid_uia_lease_completion".into());
                }
                if let Some(mut active) = subscriptions.take() {
                    active.close_current(after.ok_or("missing_input_lease_epochs")?)?;
                }
                if !current() {
                    return Err("uia_lease_not_admitted".into());
                }
                write_frame(&frame)?;
                if !current() || !deadlines.finish(Instant::now(), false) {
                    return Err("uia_lease_expired".into());
                }
                return Ok(());
            }
            let subscriptions = subscriptions.as_mut().ok_or("missing_input_lease")?;
            let after = after.ok_or("missing_input_lease_epochs")?;
            write_frame(&frame)?;
            let renew =
                renewable_snapshot(&frame, None) && current() && after == subscriptions.epochs();
            if !deadlines.finish(Instant::now(), renew) {
                return Err("uia_lease_expired".into());
            }
            let mut baseline = if renew
                && let LeaseFrame::Snapshot {
                    identity,
                    snapshot: Some(snapshot),
                    ..
                } = &frame
            {
                Some((*identity, observation_source(snapshot)))
            } else {
                None
            };
            subscriptions.delivered(after);
            // StdinLock buffers ahead of the requested bytes, which would make
            // PeekNamedPipe miss requests already consumed into its buffer.
            let mut stdin = File::from(std::io::stdin().as_handle().try_clone_to_owned()?);
            let input_handle = windows::Win32::Foundation::HANDLE(stdin.as_raw_handle());
            let mut requests = Requests::default();
            let mut request = None;
            loop {
                if stop.load(Ordering::Acquire)
                    || deadlines.expired(Instant::now())
                    || !admitted(&home, &control, &config, target)
                {
                    break;
                }
                if let Some(epochs) = subscriptions.take_notice() {
                    if !deadlines.begin(Instant::now()) {
                        return Err("uia_lease_expired".into());
                    }
                    write_frame(&invalidation(epochs))?;
                    if epochs.revoked {
                        return Err("uia_lease_revoked".into());
                    }
                    if !deadlines.finish(Instant::now(), false) {
                        return Err("uia_lease_expired".into());
                    }
                }
                if let Some(id) = request.take() {
                    if !deadlines.begin(Instant::now()) {
                        return Err("uia_lease_expired".into());
                    }
                    let before = subscriptions.epochs();
                    if before.revoked {
                        return Err("uia_lease_revoked".into());
                    }
                    let snapshot =
                        snapshot::capture_for_input(&home, target.0, target.1, source.clone())?;
                    if stop.load(Ordering::Acquire) || !admitted(&home, &control, &config, target) {
                        break;
                    }
                    let after = subscriptions.epochs();
                    let frame = capture_frame(id, before, after, snapshot);
                    if deadlines.expired(Instant::now()) {
                        return Err("uia_lease_expired".into());
                    }
                    write_frame(&frame)?;
                    let renew = renewable_snapshot(&frame, baseline.as_ref())
                        && !stop.load(Ordering::Acquire)
                        && admitted(&home, &control, &config, target)
                        && after == subscriptions.epochs();
                    if !deadlines.finish(Instant::now(), renew) {
                        return Err("uia_lease_expired".into());
                    }
                    if renew
                        && baseline.is_none()
                        && let LeaseFrame::Snapshot {
                            identity,
                            snapshot: Some(snapshot),
                            ..
                        } = &frame
                    {
                        baseline = Some((*identity, observation_source(snapshot)));
                    }
                    subscriptions.delivered(after);
                }
                let mut available = 0;
                if unsafe { PeekNamedPipe(input_handle, None, 0, None, Some(&mut available), None) }
                    .is_err()
                {
                    break;
                }
                if available as usize > MAX_REQUEST_BYTES * (MAX_REQUESTS + 1) {
                    return Err("uia_lease_request_backlog".into());
                }
                if available != 0 {
                    let mut bytes = [0; MAX_REQUEST_BYTES];
                    let length = bytes.len().min(available as usize);
                    let read = stdin.read(&mut bytes[..length])?;
                    if read == 0 {
                        break;
                    }
                    requests.push(&bytes[..read])?;
                }
                request = requests.ready.pop_front();
                if request.is_none() {
                    thread::sleep(Duration::from_millis(50));
                }
            }
            Ok(())
        })();
        let Some(subscriptions) = &mut subscriptions else {
            return result;
        };
        // On a failed operation keep its original bound during cleanup.
        // An idle close gets at most two seconds and cannot extend liveness.
        if !deadlines.expired(Instant::now()) {
            let _ = deadlines.begin(Instant::now());
        }
        let cleanup = subscriptions.close();
        // EOF terminates live leases. Explicit completion was already emitted
        // once; never append a revoked frame after successful terminal output.
        result?;
        cleanup?;
        Ok(())
    }

    pub(crate) fn run(
        home: &Path,
        hwnd: usize,
        pid: u32,
        source: String,
        parent: Parent,
    ) -> Result<()> {
        let deadlines = Arc::new(Deadlines::new(Instant::now()));
        if hwnd == 0
            || pid == 0
            || source.len() != 36
            || !uuid::Uuid::parse_str(&source).is_ok_and(|id| !id.is_nil())
        {
            return Err("invalid_snapshot_target".into());
        }
        let control = Control::load(home)?;
        let config = read_regular(&home.join("config.json"), 256 * 1024)?;
        Policy::load(home)?;
        if control.state == State::Stopped
            || !parent.alive()
            || !admitted(home, &control, &config, (hwnd, pid))
        {
            return Err("uia_lease_not_admitted".into());
        }
        let stop = Arc::new(AtomicBool::new(false));
        let handle = thread::Builder::new()
            .name("history-uia-lease".into())
            .spawn({
                let home = home.to_owned();
                let stop = stop.clone();
                let deadlines = deadlines.clone();
                move || worker(home, (hwnd, pid), source, stop, deadlines)
            })?;
        while !handle.is_finished() {
            if deadlines.expired(Instant::now()) {
                // This is the existing read-only disposable child. A blocked
                // COM call or pipe write cannot outlive its parent/source.
                std::process::exit(1);
            }
            if !parent.alive() || !admitted(home, &control, &config, (hwnd, pid)) {
                stop.store(true, Ordering::Release);
            }
            thread::sleep(Duration::from_millis(50));
        }
        handle.join().map_err(|_| "uia_worker_panicked")?
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::{marker::PhantomData, rc::Rc};
    use windows::{
        Win32::{
            System::{Com::SAFEARRAY, Variant::VARIANT},
            UI::Accessibility::*,
        },
        core::{Ref, Result, implement},
    };

    #[implement(
        IUIAutomationEventHandler,
        IUIAutomationPropertyChangedEventHandler,
        IUIAutomationStructureChangedEventHandler,
        IUIAutomationFocusChangedEventHandler
    )]
    struct Handler {
        state: Arc<EpochState>,
    }

    impl IUIAutomationEventHandler_Impl for Handler_Impl {
        fn HandleAutomationEvent(
            &self,
            _sender: Ref<IUIAutomationElement>,
            _eventid: UIA_EVENT_ID,
        ) -> Result<()> {
            self.state.changed(Change::Content);
            Ok(())
        }
    }

    impl IUIAutomationPropertyChangedEventHandler_Impl for Handler_Impl {
        fn HandlePropertyChangedEvent(
            &self,
            _sender: Ref<IUIAutomationElement>,
            propertyid: UIA_PROPERTY_ID,
            _newvalue: &VARIANT,
        ) -> Result<()> {
            self.state.changed(if propertyid == UIA_NamePropertyId {
                Change::Content
            } else {
                Change::Identity
            });
            Ok(())
        }
    }

    impl IUIAutomationStructureChangedEventHandler_Impl for Handler_Impl {
        fn HandleStructureChangedEvent(
            &self,
            _sender: Ref<IUIAutomationElement>,
            _changetype: StructureChangeType,
            _runtimeid: *const SAFEARRAY,
        ) -> Result<()> {
            self.state.changed(Change::Identity);
            Ok(())
        }
    }

    impl IUIAutomationFocusChangedEventHandler_Impl for Handler_Impl {
        fn HandleFocusChangedEvent(&self, _sender: Ref<IUIAutomationElement>) -> Result<()> {
            // Native focus subscriptions are global. Any focus event invalidates
            // this short-lived source; even an unrelated sender is never read.
            self.state.changed(Change::Identity);
            Ok(())
        }
    }

    struct Handlers {
        property: IUIAutomationPropertyChangedEventHandler,
        structure: IUIAutomationStructureChangedEventHandler,
        focus: IUIAutomationFocusChangedEventHandler,
        text: IUIAutomationEventHandler,
    }

    impl Handlers {
        fn new(state: &Arc<EpochState>) -> Self {
            Self {
                property: Handler {
                    state: state.clone(),
                }
                .into(),
                structure: Handler {
                    state: state.clone(),
                }
                .into(),
                focus: Handler {
                    state: state.clone(),
                }
                .into(),
                text: Handler {
                    state: state.clone(),
                }
                .into(),
            }
        }

        fn add(
            &self,
            automation: &IUIAutomation,
            root: &IUIAutomationElement,
            subscription: Subscription,
        ) -> Result<()> {
            unsafe {
                match subscription {
                    Subscription::Property => automation.AddPropertyChangedEventHandlerNativeArray(
                        root,
                        TreeScope_Subtree,
                        None,
                        &self.property,
                        &[
                            UIA_HasKeyboardFocusPropertyId,
                            UIA_IsPasswordPropertyId,
                            UIA_IsOffscreenPropertyId,
                            UIA_IsEnabledPropertyId,
                            UIA_ControlTypePropertyId,
                            UIA_NativeWindowHandlePropertyId,
                            UIA_ProcessIdPropertyId,
                            UIA_RuntimeIdPropertyId,
                            UIA_NamePropertyId,
                        ],
                    ),
                    Subscription::Structure => automation.AddStructureChangedEventHandler(
                        root,
                        TreeScope_Subtree,
                        None,
                        &self.structure,
                    ),
                    Subscription::Focus => {
                        automation.AddFocusChangedEventHandler(None, &self.focus)
                    }
                    subscription => automation.AddAutomationEventHandler(
                        Self::event_id(subscription),
                        root,
                        TreeScope_Subtree,
                        None,
                        &self.text,
                    ),
                }
            }
        }

        fn remove(
            &self,
            automation: &IUIAutomation,
            root: &IUIAutomationElement,
            subscription: Subscription,
        ) -> Result<()> {
            unsafe {
                match subscription {
                    Subscription::Property => {
                        automation.RemovePropertyChangedEventHandler(root, &self.property)
                    }
                    Subscription::Structure => {
                        automation.RemoveStructureChangedEventHandler(root, &self.structure)
                    }
                    Subscription::Focus => automation.RemoveFocusChangedEventHandler(&self.focus),
                    subscription => automation.RemoveAutomationEventHandler(
                        Self::event_id(subscription),
                        root,
                        &self.text,
                    ),
                }
            }
        }

        fn event_id(subscription: Subscription) -> UIA_EVENT_ID {
            match subscription {
                Subscription::Text => UIA_Text_TextChangedEventId,
                Subscription::Selection => UIA_Text_TextSelectionChangedEventId,
                Subscription::ItemSelected => UIA_SelectionItem_ElementSelectedEventId,
                Subscription::ItemAdded => UIA_SelectionItem_ElementAddedToSelectionEventId,
                Subscription::ItemRemoved => UIA_SelectionItem_ElementRemovedFromSelectionEventId,
                Subscription::SelectionInvalidated => UIA_Selection_InvalidatedEventId,
                _ => unreachable!("non-event subscription"),
            }
        }
    }

    /// Create, use and drop on the same existing non-UI MTA thread. The owner
    /// must keep COM initialized and bound every call with its child watchdog.
    pub struct LeaseSubscriptions {
        automation: IUIAutomation,
        root: IUIAutomationElement,
        handlers: Handlers,
        registrations: Registrations,
        notices: EpochNotices,
        _same_thread: PhantomData<Rc<()>>,
    }

    impl LeaseSubscriptions {
        /// `root` must already belong to the caller's admitted process/window.
        /// Capture and validate its tree again after installation, comparing the
        /// returned epochs before/after capture before publishing a source.
        pub fn install(
            automation: &IUIAutomation,
            root: &IUIAutomationElement,
        ) -> crate::control::Result<Option<Self>> {
            let notices = EpochNotices::new();
            let mut subscriptions = Self {
                automation: automation.clone(),
                root: root.clone(),
                handlers: Handlers::new(&notices.state),
                registrations: Registrations::default(),
                notices,
                _same_thread: PhantomData,
            };
            let installed = subscriptions.registrations.install(|subscription| {
                subscriptions.handlers.add(
                    &subscriptions.automation,
                    &subscriptions.root,
                    subscription,
                )
            });
            if installed.is_err() {
                // A body-only retry is permitted only after every partial
                // registration was removed under the original operation bound.
                subscriptions
                    .close()
                    .map_err(|_| "uia_subscription_cleanup_failed")?;
                return Ok(None);
            }
            Ok(Some(subscriptions))
        }

        pub fn epochs(&self) -> LeaseEpochs {
            self.notices.state.epochs()
        }

        /// Coalesces a burst into its latest stamp. Poll from the existing worker
        /// loop; callback threads never write to stdout or a blocking channel.
        pub fn take_notice(&mut self) -> Option<LeaseEpochs> {
            self.notices.take()
        }

        pub(super) fn delivered(&mut self, epochs: LeaseEpochs) {
            self.notices.delivered(epochs);
        }

        pub(super) fn close_current(
            &mut self,
            expected: LeaseEpochs,
        ) -> crate::control::Result<()> {
            let current = self.notices.revoke_current(expected);
            self.close()
                .map_err(|_| "uia_subscription_cleanup_failed")?;
            if !current {
                return Err("uia_lease_changed".into());
            }
            Ok(())
        }

        /// Revoke before removals; late/in-flight callbacks cannot rearm it.
        /// Attempt every matching removal, reporting the first failure. Failed
        /// removals are retried by Drop under the owner's existing watchdog.
        pub fn close(&mut self) -> Result<()> {
            self.notices.state.revoke();
            self.registrations.close(|subscription| {
                self.handlers
                    .remove(&self.automation, &self.root, subscription)
            })
        }
    }

    impl Drop for LeaseSubscriptions {
        fn drop(&mut self) {
            let _ = self.close();
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn callbacks_accept_absent_sender_and_never_read_payloads() {
            let state = Arc::new(EpochState::new());
            let handlers = Handlers::new(&state);
            unsafe {
                handlers
                    .text
                    .HandleAutomationEvent(None, UIA_Text_TextChangedEventId)
                    .unwrap();
                handlers
                    .text
                    .HandleAutomationEvent(None, UIA_Text_TextSelectionChangedEventId)
                    .unwrap();
                assert_eq!(state.epochs().identity, 1);
                handlers
                    .property
                    .HandlePropertyChangedEvent(None, UIA_IsPasswordPropertyId, &VARIANT::default())
                    .unwrap();
                handlers
                    .structure
                    .HandleStructureChangedEvent(
                        None,
                        StructureChangeType_ChildrenInvalidated,
                        std::ptr::null(),
                    )
                    .unwrap();
                handlers.focus.HandleFocusChangedEvent(None).unwrap();
            }
            assert_eq!(
                state.epochs(),
                LeaseEpochs {
                    identity: 4,
                    content: 6,
                    revoked: false,
                }
            );
            state.revoke();
            let closed = state.epochs();
            unsafe { handlers.focus.HandleFocusChangedEvent(None).unwrap() };
            assert_eq!(state.epochs(), closed);
        }

        #[test]
        fn item_and_name_callbacks_invalidate_content_without_input_identity() {
            let state = Arc::new(EpochState::new());
            let handlers = Handlers::new(&state);
            for subscription in [
                Subscription::ItemSelected,
                Subscription::ItemAdded,
                Subscription::ItemRemoved,
                Subscription::SelectionInvalidated,
            ] {
                let before = state.epochs();
                unsafe {
                    handlers
                        .text
                        .HandleAutomationEvent(None, Handlers::event_id(subscription))
                        .unwrap();
                }
                assert_eq!(state.epochs().identity, before.identity);
                assert_eq!(state.epochs().content, before.content + 1);
            }
            let before = state.epochs();
            unsafe {
                handlers
                    .property
                    .HandlePropertyChangedEvent(None, UIA_NamePropertyId, &VARIANT::default())
                    .unwrap();
            }
            assert_eq!(state.epochs().identity, before.identity);
            assert_eq!(state.epochs().content, before.content + 1);
            state.revoke();
            let closed = state.epochs();
            unsafe {
                handlers
                    .text
                    .HandleAutomationEvent(None, UIA_Selection_InvalidatedEventId)
                    .unwrap();
            }
            assert_eq!(state.epochs(), closed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observation_final_admission_follows_projection_in_actual_recorder() {
        // Execute the actual method and caller ordering on the host. Only the
        // native authority/child boundary is replaced by deterministic state.
        let source = include_str!("recorder.rs");
        let method_start = source.find("    fn accept_observation(").unwrap();
        let method_end = method_start + source[method_start..].find("\n    fn into_idle(").unwrap();
        let caller_end = source
            .find("                    if !observed && job.observation")
            .unwrap();
        let caller_start = source[..caller_end]
            .rfind("                    let observation_admitted")
            .or_else(|| source[..caller_end].rfind("                    let observed ="))
            .unwrap();
        let harness = format!(
            r#"
use std::{{cell::Cell, sync::Arc, time::Instant}};
type Result<T> = std::result::Result<T, &'static str>;
#[derive(Clone)] struct Snapshot {{ window_id: u64, pid: u32, source_id: String }}
struct CaptureFence {{ target: (usize, u32) }}
struct LeaseRevision {{ identity: u64, content: u64 }}
struct State(Cell<bool>);
impl State {{
    fn accept_observed(&self, _: u64, _: Instant, _: LeaseRevision, _: u64,
        _: impl FnOnce() -> Instant) -> bool {{ self.0.set(true); true }}
}}
struct Pending {{
    observation: Option<Snapshot>, fence: CaptureFence, source: String,
    lease: Option<Arc<State>>, frame_epochs: Option<(u64,u64)>,
    frame_changes: Option<u64>, request: u64, started: Instant,
}}
fn observation_only(_: &Snapshot) -> bool {{ true }}
fn observation_source(s: &Snapshot) -> Snapshot {{ s.clone() }}
fn same_observation_source(a: &Snapshot, b: &Snapshot) -> bool {{ a.source_id == b.source_id }}
struct Policy<'a>(&'a Cell<bool>);
impl Policy<'_> {{
    fn project(&self, _: &Snapshot, _: &str, _: u64, _: ()) -> Option<()> {{
        self.0.set(false); // Deterministic revocation during projection.
        Some(())
    }}
}}
struct Utc;
impl Utc {{ fn now() {{}} }}
impl Pending {{
    fn admitted(&self, home: &Cell<bool>, _: &(), _: &()) -> Result<bool> {{ Ok(home.get()) }}
{method}
}}
fn main() -> Result<()> {{
    let current = Cell::new(true);
    let home = &current;
    let parent = ();
    let stopping = ();
    let policy = Policy(home);
    let snapshot = Snapshot {{ window_id: 1, pid: 2, source_id: "owned".into() }};
    let state = Arc::new(State(Cell::new(false)));
    let mut job = Pending {{ observation: None, fence: CaptureFence {{ target: (1,2) }},
        source: "owned".into(), lease: Some(state.clone()), frame_epochs: Some((1,1)),
        frame_changes: Some(0), request: 0, started: Instant::now() }};
{caller}
    assert!(!observed, "projection-time revocation must reject observation renewal");
    assert!(!state.0.get(), "final denial must not reach lease acceptance");
    assert!(job.observation.is_none());
    job.source = "replaced".into();
    assert!(!job.accept_observation(&snapshot, |_| panic!("compare source first"))?);
    job.source = snapshot.source_id.clone();
    assert_eq!(job.accept_observation(&snapshot, |_| Err("policy read failed")),
        Err("policy read failed"));
    assert!(!state.0.get());
    assert!(job.observation.is_none());
    current.set(true);
    assert!(job.accept_observation(&snapshot, |job| job.admitted(home, &parent, &stopping))?);
    assert!(state.0.get());
    assert!(job.observation.is_some());
    Ok(())
}}
"#,
            method = &source[method_start..method_end],
            caller = &source[caller_start..caller_end],
        );
        let directory = std::env::temp_dir().join(format!(
            "observation-admission-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&directory).unwrap();
        let file = directory.join("replay.rs");
        let executable = directory.join(if cfg!(windows) {
            "replay.exe"
        } else {
            "replay"
        });
        std::fs::write(&file, harness).unwrap();
        let compilation = std::process::Command::new("rustc")
            .args(["--edition=2024", "-A", "dead_code"])
            .arg(&file)
            .arg("-o")
            .arg(&executable)
            .output()
            .unwrap();
        assert!(
            compilation.status.success(),
            "{}",
            String::from_utf8_lossy(&compilation.stderr)
        );
        let replay = std::process::Command::new(&executable).output().unwrap();
        std::fs::remove_dir_all(directory).unwrap();
        assert!(
            replay.status.success(),
            "{}",
            String::from_utf8_lossy(&replay.stderr)
        );
    }

    #[test]
    fn item_only_initial_capture_is_live_without_input_authority() {
        let mut snapshot = crate::model::tests::snapshot();
        snapshot.input_target = None;
        snapshot.item_selection = Some(crate::model::ItemSelection {
            owner_runtime_id: vec![7, 10],
            document_runtime_id: vec![],
            items: vec![],
        });
        let epochs = EpochState::new().epochs();
        let frame = initial_frame(Some((epochs, epochs)), Some(snapshot), false).unwrap();
        assert!(
            matches!(&frame, LeaseFrame::Snapshot { snapshot: Some(value), .. }
            if value.input_target.is_none() && value.item_selection.is_some())
        );
        assert!(renewable_snapshot(&frame, None));
    }

    #[test]
    fn item_observation_composes_clear_reselect_renewal_and_revocation_without_input() {
        use crate::recorder_lifecycle::{CaptureSchedule, InputLeaseState, LeaseRevision};
        for text in [false, true] {
            let home = crate::model::tests::Home::new();
            let policy = home.policy(text);
            let mut store = crate::store::Store::new(&home.0, crate::model::tests::now()).unwrap();
            let mut snapshot = crate::model::tests::snapshot();
            snapshot.input_target = None;
            snapshot.item_selection = Some(crate::model::ItemSelection {
                owner_runtime_id: vec![7, 42, 1],
                document_runtime_id: vec![7, 42, 2],
                items: vec![crate::model::SelectedItem {
                    runtime_id: vec![7, 42, 3],
                    role: "AXRow".into(),
                    value: Some("sample".into()),
                }],
            });
            let baseline = (1, observation_source(&snapshot));
            assert!(baseline.1.item_selection.as_ref().unwrap().items.is_empty());
            let start = Instant::now();
            let worker = Deadlines::new(start);
            let parent = InputLeaseState::new(start);
            let mut schedule = CaptureSchedule::default();
            let events = crate::recorder_lifecycle::EventEpochs::new();
            for (request, seconds) in [0, 3, 6, 9].into_iter().enumerate() {
                let at = start + Duration::from_secs(seconds);
                if request > 0 {
                    assert!(schedule.renewal_due(
                        at,
                        at - Duration::from_secs(3),
                        events.current(),
                        0
                    ));
                    assert!(worker.begin(at));
                }
                let mut fresh = snapshot.clone();
                if request == 1 {
                    fresh.item_selection.as_mut().unwrap().items.clear();
                }
                let epochs = LeaseEpochs {
                    identity: 1,
                    content: request as u64 + 1,
                    revoked: false,
                };
                let frame = if request == 0 {
                    initial_frame(Some((epochs, epochs)), Some(fresh.clone()), false).unwrap()
                } else {
                    capture_frame(request as u64, epochs, epochs, Some(fresh.clone()))
                };
                // Serialize through the real worker wire before parent acceptance.
                let wire = encode_frame(&frame).unwrap();
                let decoded: LeaseFrame = serde_json::from_slice(&wire).unwrap();
                assert!(renewable_snapshot(&decoded, Some(&baseline)));
                assert!(worker.finish(at + Duration::from_millis(100), true));
                let revision = LeaseRevision {
                    identity: epochs.identity,
                    content: epochs.content,
                };
                assert!(parent.observe(revision, request > 0, false));
                let seen = parent.observed_changes().unwrap();
                assert!(
                    parent.accept_observed(request as u64, at, revision, seen, || at
                        + Duration::from_millis(100))
                );
                assert!(
                    !parent.admits(1),
                    "observation freshness must never authorize input"
                );
                assert!(
                    !parent.accept_verified(
                        request as u64 + 100,
                        at + Duration::from_millis(150),
                        revision,
                        seen,
                        || at + Duration::from_millis(200)
                    ),
                    "a live observation-only lease cannot upgrade into input authority"
                );
                assert!(!crate::input_actions::same_input_source(&fresh, &fresh));
                assert!(fresh.input_target.is_none());
                assert!(
                    store
                        .append_if(
                            &fresh,
                            if request == 0 {
                                "window.changed"
                            } else {
                                "selection.changed"
                            },
                            &policy,
                            crate::model::tests::now(),
                            || Ok(parent.frame_current(revision, seen))
                        )
                        .unwrap()
                );
            }
            assert!(!worker.expired(start + Duration::from_secs(10)));
            for mutation in [
                "owner", "document", "source", "window", "title", "private", "missing",
            ] {
                let mut changed = snapshot.clone();
                match mutation {
                    "owner" => changed
                        .item_selection
                        .as_mut()
                        .unwrap()
                        .owner_runtime_id
                        .push(4),
                    "document" => changed
                        .item_selection
                        .as_mut()
                        .unwrap()
                        .document_runtime_id
                        .push(4),
                    "source" => changed.source_id.push('x'),
                    "window" => changed.window_id += 1,
                    "title" => changed.title.push('x'),
                    "private" => changed.private = true,
                    _ => changed.item_selection = None,
                }
                let epochs = LeaseEpochs {
                    identity: 1,
                    content: 5,
                    revoked: false,
                };
                assert!(
                    !renewable_snapshot(
                        &capture_frame(4, epochs, epochs, Some(changed.clone())),
                        Some(&baseline)
                    ),
                    "{mutation}"
                );
                if observation_only(&changed) {
                    let fresh = initial_frame(Some((epochs, epochs)), Some(changed.clone()), false)
                        .unwrap();
                    assert!(
                        renewable_snapshot(&fresh, None),
                        "replacement may establish a fresh worker baseline"
                    );
                    assert!(changed.input_target.is_none());
                }
            }
            let seen = parent.observed_changes().unwrap();
            parent.close(); // The recorder's pause/source-change/Drop path.
            let revision = LeaseRevision {
                identity: 1,
                content: 4,
            };
            assert!(!parent.accept_observed(
                4,
                start + Duration::from_secs(10),
                revision,
                seen,
                || start + Duration::from_secs(10)
            ));
            assert!(
                !store
                    .append_if(
                        &snapshot,
                        "selection.changed",
                        &policy,
                        crate::model::tests::now(),
                        || Ok(parent.current().is_some())
                    )
                    .unwrap()
            );
            store.finish(crate::model::tests::now()).unwrap();
            let segments = std::fs::read_dir(home.0.join("segments")).unwrap();
            let mut rows = Vec::new();
            for segment in segments {
                let data =
                    std::fs::read_to_string(segment.unwrap().path().join("events.jsonl")).unwrap();
                rows.extend(
                    data.lines()
                        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap()),
                );
            }
            assert_eq!(rows.len(), 4);
            assert_eq!(rows[1]["selection"]["selectedItems"], serde_json::json!([]));
            assert_eq!(
                rows[2]["selection"]["selectedItems"]
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
            assert_eq!(
                rows[2]["selection"]["selectedItems"][0]["value"].as_str(),
                text.then_some("sample")
            );
        }
    }

    #[test]
    fn adaptive_initial_native_and_body_only_complete_without_subscriptions() {
        let mut native = crate::model::tests::snapshot();
        native.input_target = Some(crate::model::InputTarget {
            hwnd: 99,
            role: "Edit".into(),
            uia: None,
        });
        let frame = initial_frame(None, Some(native), false).unwrap();
        assert!(matches!(
            &frame,
            LeaseFrame::Completed {
                request: 0,
                reason: CompletionReason::Native,
                snapshot: Some(snapshot),
            } if valid_completion(CompletionReason::Native, Some(snapshot))
        ));
        assert!(!renewable_snapshot(&frame, None));
        let mut body = crate::model::tests::snapshot();
        body.input_target = None;
        for snapshot in [Some(body), None] {
            let frame = initial_frame(None, snapshot.clone(), false).unwrap();
            assert!(matches!(
                &frame,
                LeaseFrame::Completed {
                    request: 0, reason: CompletionReason::BodyOnly, snapshot: retained,
                } if serde_json::to_value(retained).unwrap() == serde_json::to_value(&snapshot).unwrap()
            ));
            assert!(!renewable_snapshot(&frame, None));
        }
    }

    #[test]
    fn adaptive_initial_external_body_and_identity_share_one_ready_zero() {
        let mut snapshot = crate::model::tests::snapshot();
        snapshot.input_target = Some(crate::model::InputTarget {
            hwnd: 99,
            role: "TextBox".into(),
            uia: Some(crate::model::UiaTarget {
                runtime_id: vec![1, 2],
                document_runtime_id: vec![3, 4],
            }),
        });
        let mut notices = EpochNotices::new();
        notices.state.changed(Change::Identity);
        let before = notices.state.epochs();
        let frame = initial_frame(Some((before, before)), Some(snapshot.clone()), false).unwrap();
        assert!(matches!(
            &frame,
            LeaseFrame::Snapshot {
                request: 0, identity, content, snapshot: Some(retained),
            } if *identity == before.identity && *content == before.content
                && serde_json::to_value(retained).unwrap() == serde_json::to_value(&snapshot).unwrap()
        ));
        assert!(renewable_snapshot(&frame, None));
        notices.delivered(before);
        assert_eq!(notices.take(), None);
        notices.state.changed(Change::Content);
        let after = notices.state.epochs();
        assert!(matches!(
            initial_frame(Some((before, after)), Some(snapshot.clone()), false).unwrap(),
            LeaseFrame::Invalidated { revoked: false, .. }
        ));
        assert!(initial_frame(None, Some(snapshot), false).is_err());
        notices.state.revoke();
        let revoked = notices.state.epochs();
        assert!(matches!(
            initial_frame(Some((revoked, revoked)), None, false).unwrap(),
            LeaseFrame::Invalidated { revoked: true, .. }
        ));
    }

    #[test]
    fn adaptive_subscription_failure_preserves_body_but_never_input_or_renewal() {
        for uia in [
            None,
            Some(crate::model::UiaTarget {
                runtime_id: vec![1],
                document_runtime_id: vec![2],
            }),
        ] {
            let mut snapshot = crate::model::tests::snapshot();
            snapshot.input_target = Some(crate::model::InputTarget {
                hwnd: 99,
                role: "Edit".into(),
                uia,
            });
            let frame = initial_frame(None, Some(snapshot.clone()), true).unwrap();
            let LeaseFrame::Completed {
                request: 0,
                reason: CompletionReason::SubscriptionFailure,
                snapshot: Some(retained),
            } = &frame
            else {
                panic!("expected explicit degraded completion");
            };
            assert!(retained.input_target.is_none());
            assert_eq!(retained.text, snapshot.text);
            assert_eq!(retained.selection, snapshot.selection);
            assert_eq!(retained.source_id, snapshot.source_id);
            assert!(!renewable_snapshot(&frame, None));
        }
        let stamp = EpochNotices::new().state.epochs();
        assert!(initial_frame(Some((stamp, stamp)), None, true).is_err());
    }

    #[test]
    fn adaptive_terminal_contract_rejects_malformed_authority_and_wire() {
        let mut snapshot = crate::model::tests::snapshot();
        snapshot.input_target = None;
        assert!(!valid_completion(CompletionReason::Native, Some(&snapshot)));
        assert!(!valid_completion(CompletionReason::Native, None));
        for reason in [
            CompletionReason::BodyOnly,
            CompletionReason::SubscriptionFailure,
        ] {
            assert!(valid_completion(reason, None));
            assert!(valid_completion(reason, Some(&snapshot)));
        }
        snapshot.input_target = Some(crate::model::InputTarget {
            hwnd: 99,
            role: "Edit".into(),
            uia: None,
        });
        assert!(valid_completion(CompletionReason::Native, Some(&snapshot)));
        assert!(!valid_completion(
            CompletionReason::BodyOnly,
            Some(&snapshot)
        ));
        assert!(!valid_completion(
            CompletionReason::SubscriptionFailure,
            Some(&snapshot)
        ));
        snapshot.input_target.as_mut().unwrap().uia = Some(crate::model::UiaTarget {
            runtime_id: vec![1],
            document_runtime_id: vec![2],
        });
        for reason in [
            CompletionReason::Native,
            CompletionReason::BodyOnly,
            CompletionReason::SubscriptionFailure,
        ] {
            assert!(!valid_completion(reason, Some(&snapshot)));
        }
        let frame = initial_frame(None, None, false).unwrap();
        assert_eq!(
            serde_json::to_value(&frame).unwrap(),
            serde_json::json!({"type": "completed", "request": 0, "reason": "bodyOnly", "snapshot": null})
        );
        assert!(serde_json::from_slice::<LeaseFrame>(&encode_frame(&frame).unwrap()).is_ok());
        for malformed in [
            serde_json::json!({"type": "completed", "reason": "bodyOnly", "snapshot": null}),
            serde_json::json!({"type": "completed", "request": 0, "reason": "observed", "snapshot": null}),
            serde_json::json!({"type": "completed", "request": 0, "reason": "bodyOnly", "snapshot": null, "identity": 1}),
        ] {
            assert!(serde_json::from_value::<LeaseFrame>(malformed).is_err());
        }
    }

    #[test]
    fn adaptive_terminal_close_cannot_swallow_a_preclose_change() {
        for change in [Some(Change::Identity), Some(Change::Content), None] {
            let notices = EpochNotices::new();
            let expected = notices.state.epochs();
            match change {
                Some(change) => notices.state.changed(change),
                None => notices.state.revoke(),
            }
            assert!(!notices.revoke_current(expected));
            assert!(notices.state.epochs().revoked);
        }
        let notices = EpochNotices::new();
        let expected = notices.state.epochs();
        assert!(notices.revoke_current(expected));
        let closed = notices.state.epochs();
        notices.state.changed(Change::Identity);
        assert_eq!(notices.state.epochs(), closed);
        assert!(!notices.revoke_current(closed));
    }

    #[test]
    fn request_reader_handles_fragments_and_rejects_replay_or_unknown_fields() {
        let mut requests = Requests::default();
        requests.push(br#"{"requ"#).unwrap();
        assert!(requests.ready.is_empty());
        requests.push(b"est\":1}\n{\"request\":9}\r\n").unwrap();
        assert_eq!(requests.ready.drain(..).collect::<Vec<_>>(), [1, 9]);
        assert!(requests.partial.is_empty());
        for input in [
            b"{\"request\":9}\n".as_slice(),
            b"{\"request\":0}\n",
            b"{\"request\":8}\n",
            b"{\"request\":10,\"source\":\"other\"}\n",
            b"{\"request\":-1}\n",
            b"{\"request\":1.5}\n",
            b"{\"request\":18446744073709551616}\n",
            b"\n",
        ] {
            let mut denied = Requests {
                last: 9,
                ..Default::default()
            };
            assert!(denied.push(input).is_err(), "{input:?}");
            assert!(denied.ready.is_empty());
        }
    }

    #[test]
    fn requests_bound_partial_lines_and_unhandled_work() {
        let mut oversized = Requests::default();
        oversized.push(&[b' '; MAX_REQUEST_BYTES]).unwrap();
        assert!(oversized.push(b" ").is_err());
        assert_eq!(oversized.partial.len(), MAX_REQUEST_BYTES);
        let mut requests = Requests::default();
        for request in 1..=MAX_REQUESTS {
            requests
                .push(format!("{{\"request\":{request}}}\n").as_bytes())
                .unwrap();
        }
        assert_eq!(requests.ready.len(), MAX_REQUESTS);
        assert!(requests.push(b"{\"request\":9}\n").is_err());
        assert_eq!(requests.ready.len(), MAX_REQUESTS);
    }

    #[test]
    fn setup_and_operation_expiry_cannot_be_cleared_or_restarted() {
        let start = Instant::now();
        for worker_started in [true, false] {
            let deadlines = Deadlines::new(start);
            let operation = if worker_started {
                start
            } else {
                assert!(deadlines.finish(start + Duration::from_millis(50), false));
                let operation = start + Duration::from_secs(1);
                assert!(deadlines.begin(operation));
                operation
            };
            assert!(!deadlines.begin(operation + Duration::from_secs(1)));
            let expired = operation + OPERATION_LIMIT;
            assert!(!deadlines.expired(expired - Duration::from_nanos(1)));
            // Even before the watchdog polls, a late completion is rejected.
            assert!(!deadlines.finish(expired, true));
            assert!(deadlines.expired(expired));
            assert!(!deadlines.finish(expired, false));
            assert!(!deadlines.begin(expired));
        }
    }

    #[test]
    fn same_source_reads_extend_liveness_from_operation_start_not_completion() {
        let start = Instant::now();
        let deadlines = Deadlines::new(start);
        assert!(deadlines.finish(start + Duration::from_millis(100), false));
        assert!(deadlines.begin(start + Duration::from_secs(2)));
        assert!(deadlines.finish(start + Duration::from_millis(3900), true));
        assert!(!deadlines.expired(start + Duration::from_secs(5)));
        assert!(deadlines.begin(start + Duration::from_secs(5)));
        assert!(deadlines.finish(start + Duration::from_millis(6900), true));
        assert!(!deadlines.expired(start + Duration::from_millis(9999)));
        assert!(deadlines.expired(start + Duration::from_secs(10)));
    }

    #[test]
    fn polling_requests_notices_and_null_responses_never_renew_liveness() {
        let start = Instant::now();
        let deadlines = Deadlines::new(start);
        let stamp = LeaseEpochs {
            identity: 1,
            content: 1,
            revoked: false,
        };
        assert!(deadlines.finish(start + Duration::from_millis(100), false));
        let mut requests = Requests::default();
        for second in 1..5 {
            let now = start + Duration::from_secs(second);
            assert!(!deadlines.expired(now));
            requests
                .push(format!("{{\"request\":{second}}}\n").as_bytes())
                .unwrap();
            let request = requests.ready.pop_front().unwrap();
            for (index, frame) in [
                invalidation(stamp),
                capture_frame(request, stamp, stamp, None),
            ]
            .into_iter()
            .enumerate()
            {
                let now = now + Duration::from_millis(index as u64 * 20);
                assert!(deadlines.begin(now));
                assert!(!renewable_snapshot(&frame, None));
                assert!(deadlines.finish(
                    now + Duration::from_millis(10),
                    renewable_snapshot(&frame, None),
                ));
            }
        }
        assert!(deadlines.expired(start + LEASE_LIFETIME));
        assert!(!deadlines.finish(start + LEASE_LIFETIME, true));
        assert!(!deadlines.begin(start + LEASE_LIFETIME));
    }

    #[test]
    fn successful_read_cannot_cross_prior_expiry_or_revive_an_idle_worker() {
        let start = Instant::now();
        for watchdog_polled in [false, true] {
            let deadlines = Deadlines::new(start);
            assert!(deadlines.finish(start + Duration::from_millis(100), false));
            assert!(deadlines.begin(start + Duration::from_millis(4500)));
            if watchdog_polled {
                assert!(deadlines.expired(start + LEASE_LIFETIME));
            }
            assert!(!deadlines.finish(start + LEASE_LIFETIME, true));
            assert!(!deadlines.begin(start + LEASE_LIFETIME));
        }
        let idle = Deadlines::new(start);
        assert!(idle.finish(start + Duration::from_millis(100), false));
        assert!(!idle.finish(start + Duration::from_secs(4), true));
        assert!(!idle.begin(start + LEASE_LIFETIME));
    }

    #[test]
    fn publication_and_cleanup_keep_operation_bound_after_liveness_renewal() {
        let start = Instant::now();
        for renew in [false, true] {
            let deadlines = Deadlines::new(start);
            assert!(deadlines.finish(start + Duration::from_millis(100), false));
            assert!(deadlines.begin(start + Duration::from_secs(2)));
            assert!(deadlines.finish(start + Duration::from_secs(3), true));
            let operation = start + Duration::from_secs(4);
            assert!(deadlines.begin(operation));
            // A blocked publication or removal does not get the whole 5s TTL.
            assert!(!deadlines.expired(operation + OPERATION_LIMIT - Duration::from_nanos(1)));
            assert!(!deadlines.finish(operation + OPERATION_LIMIT, renew));
            assert!(!deadlines.begin(operation + OPERATION_LIMIT));
        }
    }

    #[test]
    fn renewal_requires_stable_nonnull_original_source_and_input_identity() {
        let mut snapshot = crate::model::tests::snapshot();
        snapshot.input_target = Some(crate::model::InputTarget {
            hwnd: 99,
            role: "TextBox".into(),
            uia: Some(crate::model::UiaTarget {
                runtime_id: vec![1, 2, 3],
                document_runtime_id: vec![4, 5],
            }),
        });
        let stamp = LeaseEpochs {
            identity: 1,
            content: 1,
            revoked: false,
        };
        let original = capture_frame(0, stamp, stamp, Some(snapshot.clone()));
        assert!(renewable_snapshot(&original, None));
        let baseline = Some((stamp.identity, snapshot.without_content()));
        let changed_content = LeaseEpochs {
            content: 2,
            ..stamp
        };
        let mut fresh = snapshot.clone();
        fresh.text = Some("Changed visible body".into());
        assert!(renewable_snapshot(
            &capture_frame(1, changed_content, changed_content, Some(fresh)),
            baseline.as_ref(),
        ));
        for change in 0..9 {
            let mut fresh = snapshot.clone();
            match change {
                0 => fresh.input_target = None,
                1 => fresh
                    .input_target
                    .as_mut()
                    .unwrap()
                    .uia
                    .as_mut()
                    .unwrap()
                    .runtime_id
                    .push(4),
                2 => fresh
                    .input_target
                    .as_mut()
                    .unwrap()
                    .uia
                    .as_mut()
                    .unwrap()
                    .document_runtime_id
                    .push(6),
                3 => fresh.source_id = uuid::Uuid::new_v4().to_string(),
                4 => fresh.title.push_str(" changed"),
                5 => fresh.url = Some("https://different.example/".into()),
                6 => fresh.secure = true,
                7 => fresh.private = true,
                _ => fresh.source_known = false,
            }
            assert!(
                !renewable_snapshot(
                    &capture_frame(2, stamp, stamp, Some(fresh)),
                    baseline.as_ref(),
                ),
                "changed source case {change}"
            );
        }
        for changed in [
            changed_content,
            LeaseEpochs {
                identity: 2,
                ..stamp
            },
            LeaseEpochs {
                revoked: true,
                ..stamp
            },
        ] {
            assert!(!renewable_snapshot(
                &capture_frame(3, stamp, changed, Some(snapshot.clone())),
                baseline.as_ref(),
            ));
        }
        let changed_identity = LeaseEpochs {
            identity: 2,
            ..stamp
        };
        let changed_frame = capture_frame(4, changed_identity, changed_identity, Some(snapshot));
        assert!(!renewable_snapshot(&changed_frame, baseline.as_ref()));
        let start = Instant::now();
        let deadlines = Deadlines::new(start);
        assert!(deadlines.finish(start + Duration::from_millis(100), false));
        for second in 1..5 {
            let now = start + Duration::from_secs(second);
            assert!(deadlines.begin(now));
            assert!(deadlines.finish(
                now + Duration::from_millis(50),
                renewable_snapshot(&changed_frame, baseline.as_ref()),
            ));
        }
        assert!(!deadlines.begin(start + LEASE_LIFETIME));
    }

    #[test]
    fn racing_capture_emits_only_invalidation_and_wire_is_exact() {
        let before = LeaseEpochs {
            identity: 3,
            content: 7,
            revoked: false,
        };
        for after in [
            LeaseEpochs {
                identity: 4,
                ..before
            },
            LeaseEpochs {
                content: 8,
                ..before
            },
            LeaseEpochs {
                revoked: true,
                ..before
            },
        ] {
            let frame = capture_frame(1, before, after, Some(crate::model::tests::snapshot()));
            assert!(matches!(frame, LeaseFrame::Invalidated { .. }));
            let json = serde_json::to_value(frame).unwrap();
            assert_eq!(
                json,
                serde_json::json!({
                    "type": "invalidated", "identity": after.identity,
                    "content": after.content, "revoked": after.revoked,
                })
            );
            assert!(!json.to_string().contains("Synthetic"));
        }
        let frame = capture_frame(0, before, before, None);
        let wire = serde_json::to_value(frame).unwrap();
        assert_eq!(
            wire,
            serde_json::json!({
                "type": "snapshot", "request": 0, "identity": 3,
                "content": 7, "snapshot": null,
            })
        );
        assert!(serde_json::from_value::<LeaseFrame>(wire).is_ok());
        assert!(
            serde_json::from_value::<LeaseFrame>(serde_json::json!({
                "type": "invalidated", "identity": 3, "content": 8,
                "revoked": false, "source": "different",
            }))
            .is_err()
        );
    }

    #[test]
    fn output_budget_includes_json_escaping_and_the_line_delimiter() {
        let mut snapshot = crate::model::tests::snapshot();
        snapshot.text = Some("\"".repeat(MAX_FRAME_BYTES / 2));
        let stamp = LeaseEpochs {
            identity: 1,
            content: 1,
            revoked: false,
        };
        let frame = capture_frame(0, stamp, stamp, Some(snapshot));
        assert!(encode_frame(&frame).is_err());
        let mut snapshot = crate::model::tests::snapshot();
        snapshot.text = Some("synthetic".into());
        let bytes = encode_frame(&capture_frame(0, stamp, stamp, Some(snapshot))).unwrap();
        assert_eq!(bytes.last(), Some(&b'\n'));
        assert!(bytes.len() <= MAX_FRAME_BYTES);
        assert!(serde_json::from_slice::<LeaseFrame>(&bytes).is_ok());
    }

    #[test]
    fn text_changes_preserve_identity_but_privacy_changes_invalidate_both() {
        let mut notices = EpochNotices::new();
        let initial = notices.state.epochs();
        assert_eq!(notices.take(), None);
        notices.state.changed(Change::Content);
        let content = notices.take().unwrap();
        assert_eq!(content.identity, initial.identity);
        assert_eq!(content.content, initial.content + 1);
        notices.state.changed(Change::Identity);
        let identity = notices.take().unwrap();
        assert_eq!(identity.identity, initial.identity + 1);
        assert_eq!(identity.content, initial.content + 2);
        assert!(!identity.revoked);
    }

    #[test]
    fn event_burst_coalesces_into_current_epochs_without_a_queue() {
        let mut notices = EpochNotices::new();
        for _ in 0..100_000 {
            notices.state.changed(Change::Content);
        }
        assert_eq!(notices.take().unwrap().content, 100_001);
        assert_eq!(notices.take(), None);
        notices.state.changed(Change::Identity);
        assert_eq!(notices.take().unwrap().identity, 2);
    }

    #[test]
    fn delivered_capture_does_not_repeat_invalidation_or_hide_newer_callbacks() {
        let mut notices = EpochNotices::new();
        let before = notices.state.epochs();
        notices.state.changed(Change::Content);
        let after = notices.state.epochs();
        assert!(matches!(
            capture_frame(0, before, after, Some(crate::model::tests::snapshot())),
            LeaseFrame::Invalidated { .. }
        ));
        notices.delivered(after);
        assert_eq!(
            notices.take(),
            None,
            "do not cancel the parent's fresh retry"
        );
        for change in [Change::Content, Change::Identity] {
            let sent = notices.state.epochs();
            // A callback can arrive while the previous frame blocks in stdout.
            notices.state.changed(change);
            let later = notices.state.epochs();
            notices.delivered(sent);
            assert_eq!(notices.take(), Some(later));
            assert_eq!(notices.take(), None);
        }
        let sent = notices.state.epochs();
        notices.state.revoke();
        notices.delivered(sent);
        assert!(notices.take().unwrap().revoked);
    }

    #[test]
    fn revocation_is_reported_once_and_late_callbacks_cannot_rearm() {
        let mut notices = EpochNotices::new();
        notices.state.revoke();
        let closed = notices.take().unwrap();
        assert!(closed.revoked);
        notices.state.changed(Change::Content);
        notices.state.changed(Change::Identity);
        notices.state.revoke();
        assert_eq!(notices.state.epochs(), closed);
        assert_eq!(notices.take(), None);
    }

    #[test]
    fn either_counter_exhaustion_revokes_without_wrapping() {
        for (value, change) in [
            (EPOCH_MASK | (1 << EPOCH_BITS), Change::Identity),
            (1 | (EPOCH_MASK << EPOCH_BITS), Change::Content),
            (1 | (EPOCH_MASK << EPOCH_BITS), Change::Identity),
        ] {
            let state = EpochState(AtomicU64::new(value));
            let before = state.epochs();
            state.changed(change);
            assert_eq!(
                state.epochs(),
                LeaseEpochs {
                    revoked: true,
                    ..before
                }
            );
        }
    }

    #[test]
    fn concurrent_callbacks_never_publish_a_torn_identity_stamp() {
        use std::{sync::Barrier, thread};
        let state = Arc::new(EpochState::new());
        let barrier = Arc::new(Barrier::new(3));
        thread::scope(|scope| {
            for _ in 0..2 {
                let state = state.clone();
                let barrier = barrier.clone();
                scope.spawn(move || {
                    barrier.wait();
                    for _ in 0..10_000 {
                        state.changed(Change::Identity);
                    }
                });
            }
            barrier.wait();
            for _ in 0..10_000 {
                let stamp = state.epochs();
                assert_eq!(stamp.identity, stamp.content);
            }
        });
        let final_stamp = state.epochs();
        assert_eq!(final_stamp.identity, final_stamp.content);
        assert!(final_stamp.revoked || final_stamp.identity == 20_001);
    }

    #[test]
    fn partial_install_removes_exact_successful_prefix_in_reverse_order() {
        for failed in SUBSCRIPTIONS {
            let mut registrations = Registrations::default();
            let mut added = Vec::new();
            let result = registrations.install(|subscription| {
                if subscription == failed {
                    Err("provider unavailable")
                } else {
                    added.push(subscription);
                    Ok(())
                }
            });
            assert_eq!(result, Err("provider unavailable"));
            let mut removed = Vec::new();
            registrations
                .close(|subscription| {
                    removed.push(subscription);
                    Ok::<_, ()>(())
                })
                .unwrap();
            assert_eq!(removed, added.into_iter().rev().collect::<Vec<_>>());
            assert_eq!(registrations.0, 0);
        }
    }

    #[test]
    fn removal_failure_still_cleans_others_and_retries_only_failed_handlers() {
        let mut registrations = Registrations::default();
        registrations.install(|_| Ok::<_, ()>(())).unwrap();
        let mut attempted = Vec::new();
        assert_eq!(
            registrations.close(|subscription| {
                attempted.push(subscription);
                if matches!(subscription, Subscription::Text | Subscription::Focus) {
                    Err(subscription)
                } else {
                    Ok(())
                }
            }),
            Err(Subscription::Text)
        );
        assert_eq!(
            attempted,
            SUBSCRIPTIONS.into_iter().rev().collect::<Vec<_>>()
        );
        let mut retried = Vec::new();
        registrations
            .close(|subscription| {
                retried.push(subscription);
                Ok::<_, ()>(())
            })
            .unwrap();
        assert_eq!(retried, [Subscription::Text, Subscription::Focus]);
        registrations
            .close(|_| panic!("already removed subscription"))
            .unwrap_or_else(|_: ()| unreachable!());
    }
}
