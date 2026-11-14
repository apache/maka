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

//! Ephemeral read-only capabilities, independent of agent observation identities.

use crate::{
    AuthorizationFuture, BrowserAccess, BrowserEffectScope, ComputerAppTarget, NativeEpochId,
};
use maka_agent_facts::tools::ToolError;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

#[cfg(feature = "native-desktop")]
pub(crate) mod native;

pub const MAX_PREVIEW_TARGETS: usize = 5;
pub const MAX_PREVIEW_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_PREVIEW_DIMENSION: u32 = 1600;

#[derive(Clone, Serialize, Deserialize)]
pub enum PreviewSubject {
    Native {
        operation_id: String,
        target: ComputerAppTarget,
    },
    Browser {
        access: BrowserAccess,
    },
    NativeWindow {
        operation_id: String,
        binding: crate::ComputerAppBinding,
    },
}

/// Implemented by the Host using its retained, actually admitted call. A subject
/// describes the check; it is never itself a permission or a serialized grant.
pub trait PreviewAuthority: Send + Sync {
    fn authorize(
        &self,
        subject: PreviewSubject,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture;
    fn browser_effect_scope(&self) -> Option<Arc<dyn BrowserEffectScope>>;
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviewKind {
    App,
    Tab,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTarget {
    pub id: String,
    pub epoch: String,
    pub binding_id: String,
    pub revision: u64,
    pub kind: PreviewKind,
    pub label: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSnapshot {
    pub revision: u64,
    pub active_target: Option<String>,
    pub targets: Vec<PreviewTarget>,
}

pub struct PreviewFrame {
    pub target_id: String,
    pub binding_id: String,
    pub revision: u64,
    pub mime_type: &'static str,
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

pub(crate) enum CapturedImage {
    Encoded(Vec<u8>),
    Frame(PreviewFrame),
}
pub(crate) type CaptureFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<CapturedImage, ToolError>> + Send>>;
pub(crate) trait Capture: Send + Sync {
    fn as_any(&self) -> &dyn std::any::Any;
    fn same_source(&self, other: &dyn Capture) -> bool;
    fn authorize(
        &self,
        authority: Arc<dyn PreviewAuthority>,
        stop: CancellationToken,
    ) -> AuthorizationFuture;
    fn capture(
        &self,
        authority: Arc<dyn PreviewAuthority>,
        stop: CancellationToken,
    ) -> CaptureFuture;
}
struct Entry {
    target: PreviewTarget,
    epoch: NativeEpochId,
    key: String,
    capture: Arc<dyn Capture>,
    stop: CancellationToken,
    busy: Arc<tokio::sync::Mutex<()>>,
    source: Arc<()>,
}
struct State {
    revision: u64,
    closed: bool,
    entries: Vec<Entry>,
    epochs: std::collections::HashMap<NativeEpochId, CancellationToken>,
}
#[derive(Clone)]
pub struct PreviewRegistry {
    state: Arc<Mutex<State>>,
    changed: watch::Sender<u64>,
    captures: Arc<tokio::sync::Semaphore>,
}
impl Default for PreviewRegistry {
    fn default() -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                revision: 0,
                closed: false,
                entries: Vec::new(),
                epochs: Default::default(),
            })),
            changed: watch::channel(0).0,
            captures: Arc::new(tokio::sync::Semaphore::new(MAX_PREVIEW_TARGETS)),
        }
    }
}
impl PreviewRegistry {
    pub(crate) fn open_epoch(&self, epoch: NativeEpochId) {
        self.state
            .lock()
            .unwrap()
            .epochs
            .entry(epoch)
            .or_insert_with(CancellationToken::new);
    }
    pub fn snapshot(&self) -> PreviewSnapshot {
        let state = self.state.lock().unwrap();
        PreviewSnapshot {
            revision: state.revision,
            active_target: state.entries.last().map(|e| e.target.id.clone()),
            targets: state.entries.iter().map(|e| e.target.clone()).collect(),
        }
    }
    pub fn targets(&self) -> Vec<PreviewTarget> {
        self.snapshot().targets
    }
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.changed.subscribe()
    }
    fn publish(&self, state: &mut State) {
        state.revision += 1;
        self.changed.send_replace(state.revision);
    }
    pub(crate) fn register(
        &self,
        epoch: NativeEpochId,
        key: String,
        kind: PreviewKind,
        label: String,
        capture: Arc<dyn Capture>,
    ) {
        let mut state = self.state.lock().unwrap();
        if state.closed || !state.epochs.contains_key(&epoch) {
            return;
        }
        let previous = state
            .entries
            .iter()
            .position(|e| e.epoch == epoch && e.key == key)
            .map(|i| state.entries.remove(i));
        let (mut target, stop, busy, source) = match previous {
            Some(entry) => {
                let mut target = entry.target;
                if capture.same_source(entry.capture.as_ref()) {
                    (target, entry.stop, entry.busy, entry.source)
                } else {
                    entry.stop.cancel();
                    target.revision += 1;
                    (target, CancellationToken::new(), entry.busy, Arc::new(()))
                }
            }
            None => (
                PreviewTarget {
                    id: uuid::Uuid::new_v4().to_string(),
                    epoch: epoch.to_string(),
                    binding_id: uuid::Uuid::new_v4().to_string(),
                    revision: 1,
                    kind,
                    label: label.clone(),
                },
                CancellationToken::new(),
                Arc::new(tokio::sync::Mutex::new(())),
                Arc::new(()),
            ),
        };
        target.label = label;
        if state.entries.len() == MAX_PREVIEW_TARGETS {
            state.entries.remove(0).stop.cancel();
        }
        state.entries.push(Entry {
            target,
            epoch,
            key,
            capture,
            stop,
            busy,
            source,
        });
        self.publish(&mut state);
    }
    pub(crate) fn replace_remote(
        &self,
        epoch: NativeEpochId,
        stream: &CancellationToken,
        targets: Vec<(PreviewTarget, Arc<dyn Capture>)>,
    ) {
        let mut state = self.state.lock().unwrap();
        if state.closed || stream.is_cancelled() || !state.epochs.contains_key(&epoch) {
            return;
        }
        let mut previous = Vec::new();
        let mut i = 0;
        while i < state.entries.len() {
            if state.entries[i].epoch == epoch && state.entries[i].key.starts_with("remote:") {
                previous.push(state.entries.remove(i));
            } else {
                i += 1;
            }
        }
        for (mut target, capture) in targets {
            // The capture retains the worker identity; consumers see the Host epoch.
            target.epoch = epoch.to_string();
            let old = previous
                .iter()
                .position(|entry| entry.target.id == target.id)
                .map(|i| previous.remove(i));
            let (stop, busy, source) = match old {
                Some(old) if capture.same_source(old.capture.as_ref()) => {
                    (old.stop, old.busy, old.source)
                }
                Some(old) => {
                    old.stop.cancel();
                    (stream.child_token(), old.busy, Arc::new(()))
                }
                None => (
                    stream.child_token(),
                    Arc::new(tokio::sync::Mutex::new(())),
                    Arc::new(()),
                ),
            };
            if state.entries.len() == MAX_PREVIEW_TARGETS {
                state.entries.remove(0).stop.cancel();
            }
            state.entries.push(Entry {
                key: format!("remote:{}", target.id),
                target,
                epoch,
                capture,
                stop,
                busy,
                source,
            });
        }
        for old in previous {
            old.stop.cancel();
        }
        self.publish(&mut state);
    }
    pub(crate) fn remove(&self, epoch: NativeEpochId, key: &str) {
        let mut state = self.state.lock().unwrap();
        if let Some(index) = state
            .entries
            .iter()
            .position(|e| e.epoch == epoch && e.key == key)
        {
            state.entries.remove(index).stop.cancel();
            self.publish(&mut state);
        }
    }
    /// Seal the old epoch synchronously, before waiting for native retirement.
    pub fn retire_epoch(&self, epoch: NativeEpochId) {
        let mut state = self.state.lock().unwrap();
        if let Some(stop) = state.epochs.remove(&epoch) {
            stop.cancel();
        }
        state.entries.retain(|e| {
            if e.epoch == epoch {
                e.stop.cancel();
                false
            } else {
                true
            }
        });
        self.publish(&mut state);
    }
    pub fn clear(&self) {
        let mut state = self.state.lock().unwrap();
        for entry in state.entries.drain(..) {
            entry.stop.cancel();
        }
        self.publish(&mut state);
    }
    pub(crate) fn epoch_stop(&self, epoch: NativeEpochId) -> Result<CancellationToken, ToolError> {
        self.state
            .lock()
            .unwrap()
            .epochs
            .get(&epoch)
            .cloned()
            .ok_or_else(|| failed("preview epoch retired"))
    }
    pub(crate) fn snapshot_epoch(&self, epoch: NativeEpochId) -> PreviewSnapshot {
        let state = self.state.lock().unwrap();
        let targets: Vec<_> = state
            .entries
            .iter()
            .filter(|entry| entry.epoch == epoch)
            .map(|entry| entry.target.clone())
            .collect();
        PreviewSnapshot {
            revision: state.revision,
            active_target: targets.last().map(|target| target.id.clone()),
            targets,
        }
    }
    pub(crate) fn close(&self) {
        {
            let mut state = self.state.lock().unwrap();
            state.closed = true;
            for stop in state.epochs.values() {
                stop.cancel();
            }
            state.epochs.clear();
        }
        self.clear();
    }
    fn remove_source(&self, id: &str, source: &Arc<()>) {
        let mut state = self.state.lock().unwrap();
        if let Some(i) = state
            .entries
            .iter()
            .position(|e| e.target.id == id && Arc::ptr_eq(&e.source, source))
        {
            state.entries.remove(i).stop.cancel();
            self.publish(&mut state);
        }
    }
    pub async fn authorize(
        &self,
        id: &str,
        authority: Arc<dyn PreviewAuthority>,
        cancellation: CancellationToken,
    ) -> Result<(), ToolError> {
        let (producer, stop, source) = {
            let state = self.state.lock().unwrap();
            let entry = state
                .entries
                .iter()
                .find(|e| e.target.id == id)
                .ok_or_else(|| failed("preview target is unavailable"))?;
            (
                entry.capture.clone(),
                entry.stop.clone(),
                entry.source.clone(),
            )
        };
        if stop.is_cancelled() || cancellation.is_cancelled() {
            return Err(failed("preview target retired"));
        }
        if let Err(error) = producer.authorize(authority, cancellation.clone()).await {
            if !cancellation.is_cancelled() {
                self.remove_source(id, &source);
            }
            return Err(error);
        }
        let state = self.state.lock().unwrap();
        if stop.is_cancelled()
            || cancellation.is_cancelled()
            || !state
                .entries
                .iter()
                .any(|e| e.target.id == id && Arc::ptr_eq(&e.source, &source))
        {
            return Err(failed("preview target retired"));
        }
        Ok(())
    }
    pub async fn capture(
        &self,
        id: &str,
        authority: Arc<dyn PreviewAuthority>,
        cancellation: CancellationToken,
    ) -> Result<PreviewFrame, ToolError> {
        let (target, producer, stop, busy, source) = {
            let state = self.state.lock().unwrap();
            let entry = state
                .entries
                .iter()
                .find(|e| e.target.id == id)
                .ok_or_else(|| failed("preview target is unavailable"))?;
            (
                entry.target.clone(),
                entry.capture.clone(),
                entry.stop.clone(),
                entry.busy.clone(),
                entry.source.clone(),
            )
        };
        let busy = tokio::select! {
            guard = busy.lock_owned() => guard,
            () = cancellation.cancelled() => return Err(failed("preview capture cancelled")),
            () = stop.cancelled() => return Err(failed("preview target retired")),
        };
        if stop.is_cancelled() || cancellation.is_cancelled() {
            return Err(failed("preview capture cancelled"));
        }
        let capacity = tokio::select! {
            permit = self.captures.clone().acquire_owned() => permit.map_err(failed)?,
            () = cancellation.cancelled() => return Err(failed("preview capture cancelled")),
            () = stop.cancelled() => return Err(failed("preview target retired")),
        };
        let work_stop = stop.child_token();
        let work_cancel = cancellation.child_token();
        let _capture_lifetime = work_cancel.clone().drop_guard();
        let capture = producer.clone();
        let capture_authority = authority.clone();
        let result = tokio::spawn(async move {
            let _busy = busy;
            let _capacity = capacity;
            let future = capture.capture(capture_authority, work_stop.clone());
            tokio::pin!(future);
            let image = tokio::select! {
                result = &mut future => result,
                () = work_cancel.cancelled() => { work_stop.cancel(); future.await }
            }?;
            match image {
                CapturedImage::Encoded(bytes) => {
                    tokio::task::spawn_blocking(move || normalize(bytes))
                        .await
                        .map_err(failed)?
                }
                CapturedImage::Frame(frame) => Ok((frame.bytes, frame.width, frame.height)),
            }
        })
        .await
        .map_err(failed)?;
        let (bytes, width, height) = match result {
            Ok(frame) => frame,
            Err(error) => {
                if stop.is_cancelled() || cancellation.is_cancelled() {
                    return Err(error);
                }
                // A pixel read/normalization failure does not revoke the descriptor.
                // Recheck the actual producer and grant, without retrying capture.
                if let Err(retired) = producer.authorize(authority, cancellation.clone()).await {
                    if !cancellation.is_cancelled() {
                        self.remove_source(id, &source);
                    }
                    return Err(retired);
                }
                return Err(error);
            }
        };
        let state = self.state.lock().unwrap();
        if stop.is_cancelled()
            || cancellation.is_cancelled()
            || !state
                .entries
                .iter()
                .any(|e| e.target.id == id && Arc::ptr_eq(&e.source, &source))
        {
            return Err(failed("preview capture retired"));
        }
        Ok(PreviewFrame {
            target_id: target.id,
            binding_id: target.binding_id,
            revision: target.revision,
            mime_type: "image/jpeg",
            bytes,
            width,
            height,
        })
    }
}
pub(crate) fn failed(message: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(message.to_string())
}

#[cfg(feature = "native-desktop")]
fn normalize(bytes: Vec<u8>) -> Result<(Vec<u8>, u32, u32), ToolError> {
    if bytes.len() > 32 * 1024 * 1024 {
        return Err(failed("preview source image exceeds byte limit"));
    }
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(failed)?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode().map_err(failed)?;
    let image =
        if image.width() > MAX_PREVIEW_DIMENSION || image.height() > MAX_PREVIEW_DIMENSION {
            image.thumbnail(MAX_PREVIEW_DIMENSION, MAX_PREVIEW_DIMENSION)
        } else {
            image
        }
        .to_rgb8();
    let (width, height) = image.dimensions();
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 75)
        .encode_image(&image)
        .map_err(failed)?;
    if bytes.len() > MAX_PREVIEW_BYTES {
        return Err(failed("preview frame exceeds byte limit"));
    }
    Ok((bytes, width, height))
}

#[cfg(not(feature = "native-desktop"))]
fn normalize(_bytes: Vec<u8>) -> Result<(Vec<u8>, u32, u32), ToolError> {
    Err(failed("native preview is unavailable on this Host"))
}

#[cfg(test)]
mod tests;
