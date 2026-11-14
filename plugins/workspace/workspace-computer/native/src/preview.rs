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

use super::*;
use api::{
    FrameNotice, FrameResult, ReadFrame, StageFrame, StageSnapshot, StageTarget, StageTargetKind,
    WatchFrames, WatchStage,
};
use base64::Engine as _;
use maka_agent_authority::computer::ComputerPreviewAccess;
use maka_computer_use::{
    AuthorizationFuture, BrowserEffectScope, BrowserPreparationBinding,
    preview::{PreviewAuthority, PreviewKind, PreviewSubject},
};
use maka_plugin_core::runtime::Activation;
use maka_sandbox::workspace::PermissionBasis;
use std::sync::{Mutex, Weak};
use std::time::Duration;
use tokio::sync::watch;

const MAX_FEEDS: usize = 16;
const FRAME_INTERVAL: Duration = Duration::from_millis(125);
const THUMBNAIL_INTERVAL: Duration = Duration::from_millis(750);

#[derive(Clone)]
pub(super) struct Authority {
    owner: Weak<Computer>,
    access: Arc<dyn ComputerPreviewAccess>,
    // Only the admitted preview worker can install its actual request lifetime.
    effect: Option<CancellationToken>,
}
impl Authority {
    pub(super) async fn new(
        owner: &Arc<Computer>,
        call: &Call,
        basis: PermissionBasis,
    ) -> Result<Self, ToolError> {
        access::resource_boundary(call.scope.sandbox_floor())?;
        let access = call.authority.retain_preview(&basis).await?;
        access.granted(&api::target()).await?;
        Ok(Self {
            owner: Arc::downgrade(owner),
            access,
            effect: None,
        })
    }
    pub(super) fn execution(&self) -> &maka_agent_facts::durable::ExecutionIdentity {
        self.access.execution()
    }
    async fn current(&self, cancellation: &CancellationToken) -> Result<Arc<Computer>, ToolError> {
        if cancellation.is_cancelled()
            || self
                .effect
                .as_ref()
                .is_some_and(CancellationToken::is_cancelled)
        {
            return Err(failed("Computer preview closed"));
        }
        let owner = self
            .owner
            .upgrade()
            .ok_or_else(|| failed("Computer preview owner closed"))?;
        if owner.stopping.is_cancelled() {
            return Err(failed("Computer preview owner closed"));
        }
        self.access.granted(&api::target()).await?;
        Ok(owner)
    }
}
impl PreviewAuthority for Authority {
    fn authorize(
        &self,
        subject: PreviewSubject,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        let this = self.clone();
        Box::pin(async move {
            this.current(&cancellation).await?;
            match subject {
                PreviewSubject::Native {
                    operation_id,
                    target,
                } => {
                    this.access.native_current().await?;
                    let status = this.access.app_status(&operation_id, &target).await?;
                    if !status.granted || status.stopped {
                        return Err(failed("Computer preview app stopped or revoked"));
                    }
                }
                PreviewSubject::NativeWindow { .. } => {
                    this.access.native_current().await?;
                }
                PreviewSubject::Browser { access: browser } => {
                    let origin = browser
                        .origin()?
                        .ok_or_else(|| failed("Computer preview requires a document origin"))?;
                    let configuration = this.access.current().await?;
                    super::browser_access::network_allowed(&configuration, &origin).await?;
                    this.access
                        .granted(&super::browser_access::target(origin))
                        .await?;
                }
            }
            this.current(&cancellation).await?;
            Ok(())
        })
    }
    fn browser_effect_scope(&self) -> Option<Arc<dyn BrowserEffectScope>> {
        self.effect
            .as_ref()
            .map(|_| Arc::new(self.clone()) as Arc<dyn BrowserEffectScope>)
    }
}
impl BrowserEffectScope for Authority {
    fn check_session_preparation(
        &self,
        binding: BrowserPreparationBinding,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        let this = self.clone();
        Box::pin(async move {
            if this.effect.is_none() {
                return Err(failed("Browser preview has no admitted effect"));
            }
            let invocation = this.access.execution();
            binding.check_scope(
                &invocation.turn_id,
                &maka_computer_use::ExecutionCorrelation::new(invocation.run_id.to_string())
                    .map_err(failed)?,
            )?;
            this.current(&cancellation).await?;
            let configuration = this.access.current().await?;
            if super::browser_access::workspace_network(&configuration).await?
                != maka_sandbox::Network::Allowed
            {
                return Err(failed(
                    "Browser preview preparation exceeds the workspace network ceiling",
                ));
            }
            this.current(&cancellation).await?;
            Ok(())
        })
    }
}

#[derive(Default, Clone)]
pub(super) struct Feeds(Arc<Mutex<BTreeMap<String, Weak<Feed>>>>);
struct Feed {
    id: String,
    session: String,
    binding: String,
    requester: Activation,
    caller: Option<maka_host_runtime::application::Caller>,
    stop: CancellationToken,
    epoch: Arc<sessions::Epoch>,
    slots: Mutex<BTreeMap<String, Slot>>,
    changed: watch::Sender<u64>,
}
struct Slot {
    sequence: u64,
    revision: u64,
    value: Option<Result<Arc<StageFrame>, String>>,
}
impl Slot {
    fn new(revision: u64) -> Self {
        Self {
            sequence: 0,
            revision,
            value: None,
        }
    }
    fn read(
        &self,
        target_id: &str,
        after: u64,
        snapshot: &maka_computer_use::preview::PreviewSnapshot,
    ) -> FrameResult {
        if self.sequence <= after {
            return FrameResult::Pending;
        }
        if !snapshot
            .targets
            .iter()
            .any(|target| target.id == target_id && target.revision == self.revision)
        {
            return FrameResult::Pending;
        }
        match &self.value {
            Some(Ok(frame)) => FrameResult::Frame {
                frame: frame.as_ref().clone(),
            },
            Some(Err(message)) => FrameResult::Unavailable {
                message: message.clone(),
            },
            None => FrameResult::Pending,
        }
    }
}
struct Lease {
    feeds: Feeds,
    feed: Arc<Feed>,
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.feed.stop.cancel();
        self.feed.slots.lock().unwrap().clear();
        self.feeds.0.lock().unwrap().remove(&self.feed.id);
    }
}

pub(super) async fn call(
    owner: &Arc<Computer>,
    name: &str,
    input: Value,
    context: &Context,
) -> Result<HandlerValue, ToolError> {
    // A viewer cannot acquire the original native input capability. Trusted UI
    // observes only a resource this Computer owner already owns in this Root.
    if context.scope().identity.agent().is_some() {
        return Err(failed(
            "Computer Stage is a client observation, not an Agent tool",
        ));
    }
    let value = match name {
        "watchStage" => {
            let input: WatchStage = serde_json::from_value(input).map_err(failed)?;
            check_session(owner, &input.session_id).await?;
            watch_stage(owner, &input.session_id, context).await?
        }
        "watchFrames" => {
            let input: WatchFrames = serde_json::from_value(input).map_err(failed)?;
            check_session(owner, &input.session_id).await?;
            watch_frames(owner, input, context).await?
        }
        "readFrame" => {
            let input: ReadFrame = serde_json::from_value(input).map_err(failed)?;
            serde_json::to_value(read_frame(owner, input, context).await?).map_err(failed)?
        }
        _ => return Err(failed("Unknown Computer Stage method")),
    };
    Ok(HandlerValue::Json(value))
}

async fn check_session(owner: &Computer, session: &str) -> Result<(), ToolError> {
    owner.store.session(session).await.map_err(failed)?;
    Ok(())
}
fn epoch_authority(epoch: &sessions::Epoch, stop: &CancellationToken) -> Option<Arc<Authority>> {
    let mut authority = epoch
        .preview_authority
        .lock()
        .unwrap()
        .as_ref()?
        .as_ref()
        .clone();
    authority.effect = Some(stop.clone());
    Some(Arc::new(authority))
}
fn current_epoch(
    owner: &Computer,
    session: &str,
    binding: &str,
) -> Result<Arc<sessions::Epoch>, ToolError> {
    owner
        .sessions
        .preview_epoch(session)
        .filter(|epoch| epoch.id == binding)
        .ok_or_else(|| failed("Computer preview binding retired"))
}

async fn stage(
    owner: &Arc<Computer>,
    session: &str,
    stop: &CancellationToken,
) -> Result<StageSnapshot, ToolError> {
    let mut value = StageSnapshot {
        session_id: session.into(),
        binding_id: None,
        revision: 0,
        targets: vec![],
        active_target_id: None,
    };
    let Some(epoch) = owner.sessions.preview_epoch(session) else {
        return Ok(value);
    };
    let snapshot = epoch.preview.snapshot();
    value.binding_id = Some(epoch.id.clone());
    value.revision = snapshot.revision;
    // Authorization failures retire the target at its registry, including when
    // no frame subscription is open. Viewing metadata never asks for a grant.
    let Some(authority) = epoch_authority(&epoch, stop) else {
        return Ok(value);
    };
    for target in snapshot
        .targets
        .into_iter()
        .filter(|target| target.epoch == epoch.id)
    {
        match epoch
            .preview
            .authorize(&target.id, authority.clone(), stop.clone())
            .await
        {
            Ok(()) => value.targets.push(StageTarget {
                revision: target.revision,
                id: target.id,
                title: target.label,
                kind: match target.kind {
                    PreviewKind::App => StageTargetKind::App,
                    PreviewKind::Tab => StageTargetKind::Browser,
                },
            }),
            Err(ToolError::Failed(_)) => {} // Ordinary retirement/revocation removes presentation authority.
            Err(error) => return Err(error),
        }
    }
    value.active_target_id = snapshot
        .active_target
        .filter(|id| value.targets.iter().any(|target| &target.id == id));
    Ok(value)
}
async fn watch_stage(
    owner: &Arc<Computer>,
    session: &str,
    context: &Context,
) -> Result<Value, ToolError> {
    let mut last = None;
    let mut pulse = tokio::time::interval(Duration::from_millis(200));
    pulse.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! { biased;
            () = context.scope().cancellation.cancelled() => break,
            () = owner.stopping.cancelled() => break,
            _ = pulse.tick() => {},
        }
        let value = stage(owner, session, &context.scope().cancellation).await?;
        if last.as_ref() != Some(&value) {
            tokio::select! { biased;
                () = context.scope().cancellation.cancelled() => break,
                () = owner.stopping.cancelled() => break,
                result = context.emit(serde_json::to_value(&value).map_err(failed)?) => result.map_err(failed)?,
            }
            last = Some(value);
        }
    }
    serde_json::to_value(last.unwrap_or(StageSnapshot {
        session_id: session.into(),
        binding_id: None,
        revision: 0,
        targets: vec![],
        active_target_id: None,
    }))
    .map_err(failed)
}

async fn watch_frames(
    owner: &Arc<Computer>,
    input: WatchFrames,
    context: &Context,
) -> Result<Value, ToolError> {
    if input.target_ids.is_empty()
        || input.target_ids.len() > maka_computer_use::preview::MAX_PREVIEW_TARGETS
        || input
            .target_ids
            .iter()
            .enumerate()
            .any(|(index, id)| input.target_ids[..index].contains(id))
        || input
            .selected_target_id
            .as_ref()
            .is_some_and(|id| !input.target_ids.contains(id))
    {
        return Err(failed(
            "Computer preview requires one to five distinct owned targets",
        ));
    }
    let epoch = current_epoch(owner, &input.session_id, &input.binding_id)?;
    let snapshot = epoch.preview.snapshot();
    if input.target_ids.iter().any(|id| {
        !snapshot
            .targets
            .iter()
            .any(|target| &target.id == id && target.epoch == epoch.id)
    }) {
        return Err(failed(
            "Computer preview target does not belong to this binding",
        ));
    }
    let stop = context.scope().cancellation.child_token();
    let feed = Arc::new(Feed {
        id: uuid::Uuid::new_v4().to_string(),
        session: input.session_id,
        binding: input.binding_id,
        requester: context.requester().clone(),
        caller: context.caller().cloned(),
        stop: stop.clone(),
        epoch,
        slots: Mutex::new(
            input
                .target_ids
                .iter()
                .map(|id| {
                    (
                        id.clone(),
                        Slot::new(
                            snapshot
                                .targets
                                .iter()
                                .find(|target| &target.id == id)
                                .expect("validated preview target")
                                .revision,
                        ),
                    )
                })
                .collect(),
        ),
        changed: watch::channel(0).0,
    });
    {
        let mut feeds = owner.previews.0.lock().unwrap();
        feeds.retain(|_, feed| feed.strong_count() > 0);
        if feeds.len() >= MAX_FEEDS {
            return Err(failed("Too many Computer preview subscriptions"));
        }
        feeds.insert(feed.id.clone(), Arc::downgrade(&feed));
    }
    let lease = Lease {
        feeds: owner.previews.clone(),
        feed: feed.clone(),
    };
    let mut tasks = tokio::task::JoinSet::new();
    for id in input.target_ids {
        let interval = if input.selected_target_id.as_ref() == Some(&id) {
            FRAME_INTERVAL
        } else {
            THUMBNAIL_INTERVAL
        };
        let feed = feed.clone();
        let owner = owner.clone();
        tasks.spawn(async move { capture_target(owner, feed, id, interval).await });
    }
    let mut changed = feed.changed.subscribe();
    let delivery = async {
        let mut emitted = BTreeMap::new();
        let mut last = None;
        loop {
            changed.borrow_and_update();
            let notices: Vec<_> = feed
                .slots
                .lock()
                .unwrap()
                .iter()
                .filter(|(id, slot)| slot.sequence > *emitted.get(*id).unwrap_or(&0))
                .map(|(id, slot)| FrameNotice {
                    session_id: feed.session.clone(),
                    binding_id: feed.binding.clone(),
                    feed_id: feed.id.clone(),
                    target_id: id.clone(),
                    sequence: slot.sequence,
                })
                .collect();
            for notice in notices {
                tokio::select! { biased;
                    () = stop.cancelled() => return Ok(last),
                    () = owner.stopping.cancelled() => return Ok(last),
                    result = context.emit(serde_json::to_value(&notice).map_err(failed)?) => result.map_err(failed)?,
                }
                emitted.insert(notice.target_id.clone(), notice.sequence);
                last = Some(notice);
            }
            tokio::select! { biased;
                () = stop.cancelled() => return Ok::<_, ToolError>(last),
                () = owner.stopping.cancelled() => return Ok(last),
                result = changed.changed() => result.map_err(failed)?,
            }
        }
    };
    tokio::pin!(delivery);
    let producers = capture_workers(tasks, &stop, &owner.stopping);
    tokio::pin!(producers);
    let (delivered, captured) = tokio::select! {
        result = &mut delivery => {
            // Revoke bytes/read handles before joining capture cleanup.
            drop(lease);
            (result, producers.await)
        }
        result = &mut producers => {
            drop(lease);
            (delivery.await, result)
        }
    };
    captured?;
    let last = delivered?;
    serde_json::to_value(last.unwrap_or(FrameNotice {
        session_id: feed.session.clone(),
        binding_id: feed.binding.clone(),
        feed_id: feed.id.clone(),
        target_id: String::new(),
        sequence: 0,
    }))
    .map_err(failed)
}

async fn capture_workers(
    mut tasks: tokio::task::JoinSet<Result<(), ToolError>>,
    stop: &CancellationToken,
    stopping: &CancellationToken,
) -> Result<(), ToolError> {
    let mut failure = None;
    while let Some(result) = tasks.join_next().await {
        let error = match result {
            Ok(Ok(())) => continue,
            Ok(Err(error)) => error,
            Err(error) => failed(error),
        };
        stop.cancel();
        failure.get_or_insert(error);
    }
    if failure.is_none() {
        // Error slots outlive the stopped capture workers, until the viewer
        // closes/retries. Capture is never restarted by this subscription.
        tokio::select! {
            () = stop.cancelled() => {},
            () = stopping.cancelled() => {},
        }
    }
    failure.map_or(Ok(()), Err)
}

async fn capture_target(
    owner: Arc<Computer>,
    feed: Arc<Feed>,
    id: String,
    interval: Duration,
) -> Result<(), ToolError> {
    let mut pulse = tokio::time::interval(interval);
    pulse.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! { biased;
            () = feed.stop.cancelled() => return Ok(()),
            () = owner.stopping.cancelled() => return Ok(()),
            _ = pulse.tick() => {},
        }
        let result = async {
            current_epoch(&owner, &feed.session, &feed.binding)?;
            let authority = epoch_authority(&feed.epoch, &feed.stop)
                .ok_or_else(|| failed("Computer preview has no admitted execution"))?;
            let frame = feed
                .epoch
                .preview
                .capture(&id, authority, feed.stop.clone())
                .await?;
            current_epoch(&owner, &feed.session, &feed.binding)?;
            Ok::<_, ToolError>(frame)
        }
        .await;
        if feed.stop.is_cancelled() || owner.stopping.is_cancelled() {
            return Ok(());
        }
        let result = match result {
            Ok(frame) => Ok(frame),
            Err(ToolError::Failed(message)) => Err(message),
            Err(error) => return Err(error),
        };
        let terminal = result.is_err();
        let sequence = {
            let slots = feed.slots.lock().unwrap();
            let Some(slot) = slots.get(&id) else {
                return Ok(());
            };
            slot.sequence + 1
        };
        let result = result.map(|frame| {
            Arc::new(StageFrame {
                revision: frame.revision,
                session_id: feed.session.clone(),
                binding_id: feed.binding.clone(),
                target_id: id.clone(),
                sequence,
                mime_type: frame.mime_type.into(),
                data_base64: base64::engine::general_purpose::STANDARD.encode(&frame.bytes),
                width: frame.width,
                height: frame.height,
            })
        });
        {
            let mut slots = feed.slots.lock().unwrap();
            let Some(slot) = slots.get_mut(&id) else {
                return Ok(());
            };
            slot.sequence = sequence;
            if let Ok(frame) = &result {
                slot.revision = frame.revision;
            }
            slot.value = Some(result);
        }
        feed.changed.send_modify(|revision| *revision += 1);
        if terminal {
            return Ok(());
        }
    }
}

async fn read_frame(
    owner: &Arc<Computer>,
    input: ReadFrame,
    context: &Context,
) -> Result<FrameResult, ToolError> {
    let feed = owner
        .previews
        .0
        .lock()
        .unwrap()
        .get(&input.feed_id)
        .and_then(Weak::upgrade)
        .ok_or_else(|| failed("Computer preview subscription is closed"))?;
    if feed.session != input.session_id
        || feed.binding != input.binding_id
        || feed.requester != *context.requester()
        || feed.caller.as_ref() != context.caller()
        || feed.stop.is_cancelled()
    {
        return Err(failed(
            "Computer preview belongs to another viewer, Session or binding",
        ));
    }
    current_epoch(owner, &input.session_id, &input.binding_id)?;
    let authority = epoch_authority(&feed.epoch, &feed.stop)
        .ok_or_else(|| failed("Computer preview has no admitted execution"))?;
    if let Err(error) = feed
        .epoch
        .preview
        .authorize(&input.target_id, authority, feed.stop.clone())
        .await
    {
        if let Some(slot) = feed.slots.lock().unwrap().get_mut(&input.target_id) {
            slot.value = None;
        }
        return match error {
            ToolError::Failed(message) => Ok(FrameResult::Unavailable { message }),
            error => Err(error),
        };
    }
    if feed.stop.is_cancelled()
        || context.scope().cancellation.is_cancelled()
        || owner.stopping.is_cancelled()
    {
        return Err(failed("Computer preview closed"));
    }
    let slots = feed.slots.lock().unwrap();
    let slot = slots
        .get(&input.target_id)
        .ok_or_else(|| failed("Computer preview target was not subscribed"))?;
    Ok(slot.read(
        &input.target_id,
        input.after,
        &feed.epoch.preview.snapshot(),
    ))
}

#[cfg(test)]
mod tests;
