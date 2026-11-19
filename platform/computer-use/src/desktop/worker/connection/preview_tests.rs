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

//! In-memory worker protocol fixture; no Windows API or native pixels involved.
use super::*;
use crate::desktop::{NativeEpochId, observe_retirement};
use crate::preview::{
    PreviewAuthority, PreviewKind, PreviewRegistry, PreviewSnapshot, PreviewSubject, PreviewTarget,
};
use base64::Engine;
use std::time::Duration;

struct Authority;
impl PreviewAuthority for Authority {
    fn authorize(&self, _: PreviewSubject, _: CancellationToken) -> crate::AuthorizationFuture {
        Box::pin(async { Ok(()) })
    }
    fn browser_effect_scope(&self) -> Option<Arc<dyn crate::BrowserEffectScope>> {
        None
    }
}

#[tokio::test]
async fn remote_mirror_uses_host_epoch_for_consumers_but_raw_worker_identity_for_reads() {
    let registry = PreviewRegistry::default();
    let host_epoch = NativeEpochId::new();
    let worker_epoch = NativeEpochId::new();
    assert_ne!(host_epoch, worker_epoch);
    registry.open_epoch(host_epoch);
    let raw = PreviewTarget {
        id: "worker-target".into(),
        binding_id: "worker-binding".into(),
        epoch: worker_epoch.to_string(),
        revision: 19,
        kind: PreviewKind::App,
        label: "retained window".into(),
    };
    let (connection, mut transport) = Connection::channel();
    let peer_stop = CancellationToken::new();
    let peer = {
        let raw = raw.clone();
        let stop = peer_stop.clone();
        tokio::spawn(async move {
            let mut waits = Vec::new();
            let mut reads = Vec::new();
            loop {
                let invocation = tokio::select! { _ = stop.cancelled() => break, request = transport.receive.recv() => request.unwrap() };
                let Invocation {
                    request,
                    capabilities,
                    cancellation,
                    reply,
                    ..
                } = invocation;
                let value = match request {
                    Request::PreviewWatch {
                        owner,
                        epoch,
                        session,
                        after,
                    } => {
                        assert_eq!(
                            (owner.as_str(), epoch.as_str(), session.as_str()),
                            ("owner", host_epoch.to_string().as_str(), "session")
                        );
                        assert!(capabilities.preview.is_none());
                        if let Some(revision) = after {
                            assert_eq!(revision, 7);
                            waits.push(tokio::spawn(async move {
                                cancellation.cancelled().await;
                                reply
                                    .send(Err(failed("fixture preview watch cancelled")))
                                    .unwrap();
                            }));
                            continue;
                        }
                        serde_json::to_value(PreviewSnapshot {
                            revision: 7,
                            active_target: Some(raw.id.clone()),
                            targets: vec![raw.clone()],
                        })
                        .unwrap()
                    }
                    Request::PreviewRead {
                        owner,
                        epoch,
                        session,
                        target,
                        pixels,
                    } => {
                        assert_eq!(
                            (owner.as_str(), epoch.as_str(), session.as_str()),
                            ("owner", host_epoch.to_string().as_str(), "session")
                        );
                        // This is the actual request emitted by RemoteCapture, not a
                        // separately reconstructed target copied out of the mirror.
                        assert_eq!(target.epoch, worker_epoch.to_string());
                        assert_ne!(target.epoch, host_epoch.to_string());
                        assert_eq!(target.id, raw.id);
                        assert_eq!(target.binding_id, raw.binding_id);
                        assert_eq!(target.revision, raw.revision);
                        assert!(capabilities.preview.is_some());
                        reads.push(pixels);
                        if pixels {
                            serde_json::json!({"target_id":raw.id,"binding_id":raw.binding_id,"revision":raw.revision,"width":2,"height":1,"jpeg":base64::engine::general_purpose::STANDARD.encode([3, 7])})
                        } else {
                            Value::Null
                        }
                    }
                    _ => panic!("preview bridge emitted a non-preview request"),
                };
                reply.send(Ok(Reply { value, audio: None })).unwrap();
            }
            for wait in waits {
                wait.await.unwrap();
            }
            reads
        })
    };
    let mut changed = registry.subscribe();
    let bridge = super::super::preview::Bridge::start(
        connection,
        "owner".into(),
        host_epoch,
        "session".into(),
        registry.clone(),
    )
    .unwrap();
    let snapshot = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let snapshot = registry.snapshot();
            if !snapshot.targets.is_empty() {
                break snapshot;
            }
            changed.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    let host_targets: Vec<_> = snapshot
        .targets
        .iter()
        .filter(|target| target.epoch == host_epoch.to_string())
        .collect();
    assert_eq!(
        host_targets.len(),
        1,
        "workspace stage/watchFrames must retain the mirrored target"
    );
    let target = host_targets[0];
    assert_eq!(
        (
            target.id.as_str(),
            target.binding_id.as_str(),
            target.revision
        ),
        (raw.id.as_str(), raw.binding_id.as_str(), raw.revision)
    );
    assert_eq!(snapshot.active_target.as_deref(), Some(target.id.as_str()));
    registry
        .authorize(&target.id, Arc::new(Authority), CancellationToken::new())
        .await
        .unwrap();
    let frame = registry
        .capture(&target.id, Arc::new(Authority), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(frame.target_id, target.id);
    assert_eq!(frame.binding_id, raw.binding_id);
    assert_eq!(frame.revision, raw.revision);
    assert_eq!(frame.bytes, [3, 7]);
    bridge.stop();
    tokio::time::timeout(
        Duration::from_secs(3),
        observe_retirement(bridge.cleanup.clone()),
    )
    .await
    .unwrap()
    .unwrap();
    peer_stop.cancel();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), peer)
            .await
            .unwrap()
            .unwrap(),
        [false, true]
    );
    registry.retire_epoch(host_epoch);
}
