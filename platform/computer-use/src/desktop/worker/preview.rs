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

use super::{Connection, Request, failed};
use crate::desktop::{NativeCleanup, NativeEpochId};
use crate::preview::{
    Capture, CaptureFuture, CapturedImage, MAX_PREVIEW_BYTES, MAX_PREVIEW_DIMENSION,
    MAX_PREVIEW_TARGETS, PreviewAuthority, PreviewFrame, PreviewRegistry, PreviewSnapshot,
    PreviewSubject, PreviewTarget,
};
use crate::{AuthorizationFuture, BrowserPreparationBinding};
use base64::Engine;
use maka_agent_facts::tools::ToolError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(Serialize, Deserialize)]
pub(super) enum AuthorizationRequest {
    Subject(PreviewSubject),
    Preparation(BrowserPreparationBinding),
}
pub(super) fn decide(
    authority: Option<Arc<dyn PreviewAuthority>>,
    request: AuthorizationRequest,
    cancellation: CancellationToken,
) -> AuthorizationFuture {
    Box::pin(async move {
        let authority =
            authority.ok_or_else(|| failed("preview requires its actual Host authority"))?;
        if cancellation.is_cancelled() {
            return Err(failed("preview authorization cancelled"));
        }
        match request {
            AuthorizationRequest::Subject(subject) => {
                authority.authorize(subject, cancellation).await
            }
            AuthorizationRequest::Preparation(binding) => {
                authority
                    .browser_effect_scope()
                    .ok_or_else(|| {
                        failed("preview requires its current read-only preparation scope")
                    })?
                    .check_session_preparation(binding, cancellation)
                    .await
            }
        }
    })
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Frame {
    target_id: String,
    binding_id: String,
    revision: u64,
    width: u32,
    height: u32,
    jpeg: String,
}
#[cfg(feature = "native-desktop")]
pub(super) fn encode_frame(frame: PreviewFrame) -> Result<Value, ToolError> {
    serde_json::to_value(Frame {
        target_id: frame.target_id,
        binding_id: frame.binding_id,
        revision: frame.revision,
        width: frame.width,
        height: frame.height,
        jpeg: base64::engine::general_purpose::STANDARD.encode(frame.bytes),
    })
    .map_err(failed)
}
fn decode_frame(value: Value, target: &PreviewTarget) -> Result<PreviewFrame, ToolError> {
    let frame: Frame = serde_json::from_value(value).map_err(failed)?;
    if frame.target_id != target.id
        || frame.binding_id != target.binding_id
        || frame.revision != target.revision
        || frame.width == 0
        || frame.height == 0
        || frame.width > MAX_PREVIEW_DIMENSION
        || frame.height > MAX_PREVIEW_DIMENSION
        || frame.jpeg.len() > MAX_PREVIEW_BYTES.div_ceil(3) * 4
    {
        return Err(failed("invalid preview worker frame identity or limits"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(frame.jpeg)
        .map_err(failed)?;
    if bytes.len() > MAX_PREVIEW_BYTES {
        return Err(failed("preview worker frame exceeds byte limit"));
    }
    Ok(PreviewFrame {
        target_id: frame.target_id,
        binding_id: frame.binding_id,
        revision: frame.revision,
        width: frame.width,
        height: frame.height,
        bytes,
        mime_type: "image/jpeg",
    })
}

#[derive(Clone)]
struct RemoteCapture {
    connection: Connection,
    owner: String,
    epoch: String,
    session: String,
    target: PreviewTarget,
}
impl RemoteCapture {
    async fn read(
        &self,
        pixels: bool,
        authority: Arc<dyn PreviewAuthority>,
        cancellation: CancellationToken,
    ) -> Result<Value, ToolError> {
        self.connection
            .invoke_preview(
                Request::PreviewRead {
                    owner: self.owner.clone(),
                    epoch: self.epoch.clone(),
                    session: self.session.clone(),
                    target: self.target.clone(),
                    pixels,
                },
                Some(authority),
                cancellation,
            )
            .await
            .map(|reply| reply.value)
    }
}
impl Capture for RemoteCapture {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn same_source(&self, other: &dyn Capture) -> bool {
        other.as_any().downcast_ref::<Self>().is_some_and(|other| {
            self.connection.same_connection(&other.connection)
                && self.owner == other.owner
                && self.epoch == other.epoch
                && self.session == other.session
                && self.target.id == other.target.id
                && self.target.revision == other.target.revision
                && self.target.binding_id == other.target.binding_id
                && self.target.epoch == other.target.epoch
        })
    }
    fn authorize(
        &self,
        authority: Arc<dyn PreviewAuthority>,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        let source = self.clone();
        Box::pin(async move {
            source
                .read(false, authority, cancellation)
                .await
                .map(|_| ())
        })
    }
    fn capture(
        &self,
        authority: Arc<dyn PreviewAuthority>,
        cancellation: CancellationToken,
    ) -> CaptureFuture {
        let source = self.clone();
        Box::pin(async move {
            let value = source.read(true, authority, cancellation).await?;
            Ok(CapturedImage::Frame(decode_frame(value, &source.target)?))
        })
    }
}

pub(in crate::desktop) struct Bridge {
    connection: Connection,
    stop: CancellationToken,
    pub(in crate::desktop) cleanup: NativeCleanup,
}
impl Bridge {
    pub(in crate::desktop) fn matches(&self, connection: &Connection) -> bool {
        self.connection.same_connection(connection) && !self.stop.is_cancelled()
    }
    pub(in crate::desktop) fn stop(&self) {
        self.stop.cancel();
    }
    pub(in crate::desktop) fn start(
        connection: Connection,
        owner: String,
        epoch: NativeEpochId,
        session: String,
        registry: PreviewRegistry,
    ) -> Result<Self, ToolError> {
        let stop = registry.epoch_stop(epoch)?.child_token();
        let stream = stop.clone();
        let worker = connection.clone();
        let (finished, cleanup) = tokio::sync::watch::channel(None);
        tokio::spawn(async move {
            let result = async {
                let mut after = None;
                loop {
                    if stream.is_cancelled() {
                        return Ok(());
                    }
                    let reply = worker
                        .invoke_preview(
                            Request::PreviewWatch {
                                owner: owner.clone(),
                                epoch: epoch.to_string(),
                                session: session.clone(),
                                after,
                            },
                            None,
                            stream.clone(),
                        )
                        .await;
                    let reply = match reply {
                        Ok(reply) => reply,
                        Err(_) if stream.is_cancelled() => return Ok(()),
                        Err(error) => return Err(error),
                    };
                    let snapshot: PreviewSnapshot =
                        serde_json::from_value(reply.value).map_err(failed)?;
                    if snapshot.targets.len() > MAX_PREVIEW_TARGETS
                        || after.is_some_and(|revision| snapshot.revision <= revision)
                    {
                        return Err(failed("invalid preview worker inventory revision or limit"));
                    }
                    after = Some(snapshot.revision);
                    let targets = snapshot
                        .targets
                        .into_iter()
                        .map(|target| {
                            let capture: Arc<dyn Capture> = Arc::new(RemoteCapture {
                                connection: worker.clone(),
                                owner: owner.clone(),
                                epoch: epoch.to_string(),
                                session: session.clone(),
                                target: target.clone(),
                            });
                            (target, capture)
                        })
                        .collect();
                    registry.replace_remote(epoch, &stream, targets);
                }
            }
            .await;
            registry.replace_remote(epoch, &stream, Vec::new());
            stream.cancel();
            finished.send_replace(Some(result));
        });
        Ok(Self {
            connection,
            stop,
            cleanup,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn target() -> PreviewTarget {
        PreviewTarget {
            id: "opaque-target".into(),
            binding_id: "opaque-binding".into(),
            epoch: "worker-epoch".into(),
            revision: 4,
            kind: crate::preview::PreviewKind::Tab,
            label: "tab".into(),
        }
    }
    fn wire(target: &PreviewTarget, bytes: usize) -> Value {
        serde_json::to_value(Frame {
            target_id: target.id.clone(),
            binding_id: target.binding_id.clone(),
            revision: target.revision,
            width: 1,
            height: 1,
            jpeg: base64::engine::general_purpose::STANDARD.encode(vec![7; bytes]),
        })
        .unwrap()
    }
    #[test]
    fn worker_frame_checks_identity_generation_dimensions_and_bytes_before_delivery() {
        let target = target();
        assert_eq!(
            decode_frame(wire(&target, 3), &target).unwrap().bytes,
            [7, 7, 7]
        );
        let mut old = target.clone();
        old.revision -= 1;
        assert!(decode_frame(wire(&old, 3), &target).is_err());
        let mut other = target.clone();
        other.binding_id = "another-binding".into();
        assert!(decode_frame(wire(&other, 3), &target).is_err());
        assert!(decode_frame(wire(&target, MAX_PREVIEW_BYTES + 1), &target).is_err());
        let mut oversize = wire(&target, 3);
        oversize["width"] = serde_json::json!(MAX_PREVIEW_DIMENSION + 1);
        assert!(decode_frame(oversize, &target).is_err());
    }
}
