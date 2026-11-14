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
use std::{
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::Duration,
};
use tokio::sync::Semaphore;

struct Authority(AtomicBool);
impl PreviewAuthority for Authority {
    fn authorize(&self, _: PreviewSubject, _: CancellationToken) -> AuthorizationFuture {
        let allowed = self.0.load(Ordering::SeqCst);
        Box::pin(async move {
            if allowed {
                Ok(())
            } else {
                Err(failed("grant revoked"))
            }
        })
    }
    fn browser_effect_scope(&self) -> Option<Arc<dyn BrowserEffectScope>> {
        None
    }
}
fn authority() -> Arc<Authority> {
    Arc::new(Authority(AtomicBool::new(true)))
}

struct Producer {
    generation: u64,
    current: AtomicBool,
    started: Semaphore,
    release: Semaphore,
    finished: Semaphore,
    calls: AtomicUsize,
    capture_error: AtomicBool,
}
impl Producer {
    fn new(generation: u64) -> Arc<Self> {
        Arc::new(Self {
            generation,
            current: AtomicBool::new(true),
            started: Semaphore::new(0),
            release: Semaphore::new(0),
            finished: Semaphore::new(0),
            calls: AtomicUsize::new(0),
            capture_error: AtomicBool::new(false),
        })
    }
    fn check(
        &self,
        authority: Arc<dyn PreviewAuthority>,
        stop: CancellationToken,
    ) -> AuthorizationFuture {
        let current = self.current.load(Ordering::SeqCst) && !stop.is_cancelled();
        Box::pin(async move {
            if !current {
                return Err(failed("source no longer current"));
            }
            authority
                .authorize(
                    PreviewSubject::NativeWindow {
                        operation_id: "actual-operation".into(),
                        binding: crate::ComputerAppBinding {
                            pid: 7,
                            window_id: 9,
                            process_generation: "actual-process".into(),
                        },
                    },
                    stop,
                )
                .await
        })
    }
}
impl Capture for Arc<Producer> {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn same_source(&self, other: &dyn Capture) -> bool {
        other
            .as_any()
            .downcast_ref::<Self>()
            .is_some_and(|other| self.generation == other.generation)
    }
    fn authorize(
        &self,
        authority: Arc<dyn PreviewAuthority>,
        stop: CancellationToken,
    ) -> AuthorizationFuture {
        self.check(authority, stop)
    }
    fn capture(
        &self,
        authority: Arc<dyn PreviewAuthority>,
        stop: CancellationToken,
    ) -> CaptureFuture {
        let source = self.clone();
        Box::pin(async move {
            source.check(authority.clone(), stop.clone()).await?;
            source.calls.fetch_add(1, Ordering::SeqCst);
            source.started.add_permits(1);
            // Models a native read that must settle even after cancellation.
            source.release.acquire().await.unwrap().forget();
            source.finished.add_permits(1);
            source.check(authority, stop).await?;
            if source.capture_error.load(Ordering::SeqCst) {
                return Err(failed("actual screenshot failure"));
            }
            Ok(CapturedImage::Frame(PreviewFrame {
                target_id: "producer-owned".into(),
                binding_id: "producer-owned".into(),
                revision: source.generation,
                mime_type: "image/jpeg",
                bytes: vec![source.generation as u8],
                width: 1,
                height: 1,
            }))
        })
    }
}
async fn signal(signal: &Semaphore) {
    tokio::time::timeout(Duration::from_secs(3), signal.acquire())
        .await
        .expect("producer did not settle")
        .unwrap()
        .forget();
}
fn publish(
    registry: &PreviewRegistry,
    epoch: NativeEpochId,
    key: &str,
    producer: &Arc<Producer>,
) -> PreviewTarget {
    registry.register(
        epoch,
        key.into(),
        PreviewKind::Tab,
        key.into(),
        Arc::new(producer.clone()),
    );
    registry
        .targets()
        .into_iter()
        .find(|target| target.label == key)
        .unwrap()
}
fn capture(
    registry: &PreviewRegistry,
    target: &PreviewTarget,
    authority: Arc<dyn PreviewAuthority>,
    cancellation: CancellationToken,
) -> tokio::task::JoinHandle<Result<PreviewFrame, ToolError>> {
    let registry = registry.clone();
    let id = target.id.clone();
    tokio::spawn(async move { registry.capture(&id, authority, cancellation).await })
}

#[tokio::test]
async fn capture_error_preserves_retryable_descriptor_but_revocation_and_closed_source_retire_it() {
    for revoke in [false, true] {
        let registry = PreviewRegistry::default();
        let epoch = NativeEpochId::new();
        registry.open_epoch(epoch);
        let source = Producer::new(1);
        let auth = authority();
        let target = publish(&registry, epoch, "tab", &source);
        source.capture_error.store(true, Ordering::SeqCst);
        source.release.add_permits(1);
        let error = capture(&registry, &target, auth.clone(), CancellationToken::new())
            .await
            .unwrap()
            .err()
            .unwrap();
        signal(&source.started).await;
        assert!(
            matches!(error, ToolError::Failed(message) if message == "actual screenshot failure")
        );
        registry
            .authorize(&target.id, auth.clone(), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(registry.snapshot().targets[0].id, target.id);
        // Explicitly opening a new capture succeeds without republishing the target.
        source.capture_error.store(false, Ordering::SeqCst);
        source.release.add_permits(1);
        let recovered = capture(&registry, &target, auth.clone(), CancellationToken::new())
            .await
            .unwrap()
            .unwrap();
        signal(&source.started).await;
        assert_eq!(recovered.bytes, [1]);
        // A failed in-flight read cannot preserve a grant or identity that disappeared.
        let reading = capture(&registry, &target, auth.clone(), CancellationToken::new());
        signal(&source.started).await;
        if revoke {
            auth.0.store(false, Ordering::SeqCst);
        } else {
            source.current.store(false, Ordering::SeqCst);
        }
        source.release.add_permits(1);
        assert!(reading.await.unwrap().is_err());
        assert!(registry.targets().is_empty());
    }
}

#[tokio::test]
async fn same_source_activity_keeps_inflight_frame_and_source_generation() {
    let registry = PreviewRegistry::default();
    let epoch = NativeEpochId::new();
    registry.open_epoch(epoch);
    let source = Producer::new(1);
    let target = publish(&registry, epoch, "tab", &source);
    let pending = capture(&registry, &target, authority(), CancellationToken::new());
    signal(&source.started).await;
    let old_inventory_revision = registry.snapshot().revision;
    let updated = publish(&registry, epoch, "tab", &source);
    assert!(registry.snapshot().revision > old_inventory_revision);
    assert_eq!(updated.revision, target.revision);
    source.release.add_permits(1);
    let frame = pending.await.unwrap().unwrap();
    assert_eq!(frame.revision, updated.revision);
    assert_eq!(frame.target_id, target.id);
}

#[tokio::test]
async fn replaced_source_and_retired_epoch_reject_late_pixels_and_late_publication() {
    for close_owner in [false, true] {
        let registry = PreviewRegistry::default();
        let epoch = NativeEpochId::new();
        registry.open_epoch(epoch);
        let old = Producer::new(1);
        let target = publish(&registry, epoch, "tab", &old);
        let pending = capture(&registry, &target, authority(), CancellationToken::new());
        signal(&old.started).await;
        let replacement = Producer::new(2);
        let updated = publish(&registry, epoch, "tab", &replacement);
        assert!(updated.revision > target.revision);
        old.release.add_permits(1);
        assert!(pending.await.unwrap().is_err());
        replacement.release.add_permits(1);
        let frame = capture(&registry, &updated, authority(), CancellationToken::new())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(frame.bytes, [2]);
        let pending = capture(&registry, &updated, authority(), CancellationToken::new());
        signal(&replacement.started).await; // consume the completed read's start notice
        signal(&replacement.started).await;
        if close_owner {
            registry.close();
        } else {
            registry.retire_epoch(epoch);
        }
        replacement.release.add_permits(1);
        assert!(pending.await.unwrap().is_err());
        registry.register(
            epoch,
            "late".into(),
            PreviewKind::Tab,
            "late".into(),
            Arc::new(replacement),
        );
        assert!(registry.targets().is_empty());
    }
}

#[tokio::test]
async fn authorize_rechecks_both_actual_source_and_current_grant() {
    for revoke_grant in [false, true] {
        let registry = PreviewRegistry::default();
        let epoch = NativeEpochId::new();
        registry.open_epoch(epoch);
        let source = Producer::new(1);
        let target = publish(&registry, epoch, "tab", &source);
        let auth = authority();
        registry
            .authorize(&target.id, auth.clone(), CancellationToken::new())
            .await
            .unwrap();
        if revoke_grant {
            auth.0.store(false, Ordering::SeqCst);
        } else {
            source.current.store(false, Ordering::SeqCst);
        }
        assert!(
            registry
                .authorize(&target.id, auth, CancellationToken::new())
                .await
                .is_err()
        );
        assert!(registry.targets().is_empty());
        assert_eq!(source.calls.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn viewer_cancel_preserves_target_and_another_viewer_waits_for_native_settlement() {
    let registry = PreviewRegistry::default();
    let epoch = NativeEpochId::new();
    registry.open_epoch(epoch);
    let source = Producer::new(1);
    let target = publish(&registry, epoch, "tab", &source);
    let auth = authority();
    let cancellation = CancellationToken::new();
    let first = capture(&registry, &target, auth.clone(), cancellation.clone());
    signal(&source.started).await;
    let second_stop = CancellationToken::new();
    let mut second = Box::pin(registry.capture(&target.id, auth, second_stop));
    assert!(futures_util::poll!(second.as_mut()).is_pending());
    cancellation.cancel();
    assert_eq!(source.calls.load(Ordering::SeqCst), 1);
    assert!(
        !first.is_finished(),
        "cancellation must join the original pixel read"
    );
    source.release.add_permits(2);
    assert!(first.await.unwrap().is_err());
    assert_eq!(registry.targets().len(), 1);
    assert!(
        tokio::time::timeout(Duration::from_secs(3), second)
            .await
            .unwrap()
            .is_ok()
    );
    assert_eq!(source.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn dropping_viewer_keeps_capture_custody_and_does_not_cancel_shared_target() {
    let registry = PreviewRegistry::default();
    let epoch = NativeEpochId::new();
    registry.open_epoch(epoch);
    let source = Producer::new(1);
    let target = publish(&registry, epoch, "tab", &source);
    let first = capture(&registry, &target, authority(), CancellationToken::new());
    signal(&source.started).await;
    first.abort();
    assert!(first.await.err().is_some_and(|error| error.is_cancelled()));
    let second = capture(&registry, &target, authority(), CancellationToken::new());
    assert_eq!(source.calls.load(Ordering::SeqCst), 1);
    source.release.add_permits(1);
    signal(&source.finished).await;
    signal(&source.started).await; // second read enters only after original cleanup
    source.release.add_permits(1);
    assert!(second.await.unwrap().is_ok());
    assert_eq!(registry.targets().len(), 1);
}

#[tokio::test]
async fn inventory_and_inflight_pixels_stay_bounded_across_epoch_retirement() {
    let registry = PreviewRegistry::default();
    let mut pending = Vec::new();
    let mut sources = Vec::new();
    for i in 0..MAX_PREVIEW_TARGETS {
        let epoch = NativeEpochId::new();
        registry.open_epoch(epoch);
        let source = Producer::new(i as u64);
        let target = publish(&registry, epoch, "tab", &source);
        pending.push(capture(
            &registry,
            &target,
            authority(),
            CancellationToken::new(),
        ));
        signal(&source.started).await;
        registry.retire_epoch(epoch);
        sources.push(source);
    }
    let epoch = NativeEpochId::new();
    registry.open_epoch(epoch);
    let next = Producer::new(8);
    let target = publish(&registry, epoch, "next", &next);
    let auth = authority();
    let stop = CancellationToken::new();
    let mut sixth = Box::pin(registry.capture(&target.id, auth, stop));
    assert!(futures_util::poll!(sixth.as_mut()).is_pending());
    assert_eq!(next.calls.load(Ordering::SeqCst), 0);
    for source in sources {
        source.release.add_permits(1);
    }
    for job in pending {
        assert!(job.await.unwrap().is_err());
    }
    next.release.add_permits(1);
    assert!(sixth.await.is_ok());
    for i in 0..8 {
        publish(&registry, epoch, &format!("tab-{i}"), &Producer::new(i));
    }
    let snapshot = registry.snapshot();
    assert_eq!(snapshot.targets.len(), MAX_PREVIEW_TARGETS);
    assert_eq!(snapshot.targets.last().unwrap().label, "tab-7");
    assert_eq!(
        snapshot.active_target.as_ref(),
        Some(&snapshot.targets.last().unwrap().id)
    );
}

#[cfg(feature = "native-desktop")]
#[test]
fn encoded_pixels_are_decoded_resized_and_bounded() {
    let image = image::RgbImage::from_pixel(4000, 4, image::Rgb([12, 34, 56]));
    let mut png = std::io::Cursor::new(Vec::new());
    image.write_to(&mut png, image::ImageFormat::Png).unwrap();
    let (jpeg, width, height) = normalize(png.into_inner()).unwrap();
    assert_eq!(width, MAX_PREVIEW_DIMENSION);
    assert!(height > 0 && height <= MAX_PREVIEW_DIMENSION);
    assert!(jpeg.len() <= MAX_PREVIEW_BYTES);
    assert_eq!(
        image::guess_format(&jpeg).unwrap(),
        image::ImageFormat::Jpeg
    );
    for dimensions in [(2, 2), (320, 90)] {
        let image = image::RgbImage::new(dimensions.0, dimensions.1);
        let mut png = std::io::Cursor::new(Vec::new());
        image.write_to(&mut png, image::ImageFormat::Png).unwrap();
        let (jpeg, width, height) = normalize(png.into_inner()).unwrap();
        assert_eq!(
            (width, height),
            dimensions,
            "small sources must not be upscaled"
        );
        assert_eq!(
            image::load_from_memory(&jpeg)
                .unwrap()
                .to_rgb8()
                .dimensions(),
            dimensions
        );
    }
    assert!(normalize(vec![0; 32 * 1024 * 1024 + 1]).is_err());
    assert!(normalize(b"not pixels".to_vec()).is_err());
}
