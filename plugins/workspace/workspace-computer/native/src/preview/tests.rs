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
use maka_event_log::{
    ROOT_MIGRATIONS, RootStore,
    root::{RootNamespaces, RootOwner},
};

#[tokio::test]
async fn stopped_captures_keep_first_error_readable_until_viewer_closes() {
    use maka_computer_use::preview::{PreviewKind, PreviewSnapshot, PreviewTarget};
    for host_stops in [false, true] {
        let mut metadata = PreviewSnapshot {
            revision: 1,
            active_target: Some("target".into()),
            targets: vec![PreviewTarget {
                id: "target".into(),
                epoch: "epoch".into(),
                binding_id: "binding".into(),
                revision: 7,
                kind: PreviewKind::App,
                label: "Window".into(),
            }],
        };
        let mut slot = Slot::new(metadata.targets[0].revision);
        slot.sequence += 1;
        slot.value = Some(Err("actual screenshot failure".into()));
        let stop = CancellationToken::new();
        let stopping = CancellationToken::new();
        let workers = capture_workers(tokio::task::JoinSet::new(), &stop, &stopping);
        tokio::pin!(workers);
        assert!(
            futures_util::poll!(&mut workers).is_pending(),
            "stopped capture workers must not close the subscription"
        );
        assert!(
            matches!(slot.read("target", 0, &metadata), FrameResult::Unavailable { message } if message == "actual screenshot failure")
        );
        // Retired identities cannot expose either old pixels or their error slot.
        metadata.targets.clear();
        assert!(matches!(
            slot.read("target", 0, &metadata),
            FrameResult::Pending
        ));
        if host_stops {
            stopping.cancel();
        } else {
            stop.cancel();
        }
        workers.await.unwrap();
    }
}

#[tokio::test]
async fn retired_execution_keeps_stage_binding_without_an_error() {
    let directory = tempfile::tempdir().unwrap();
    let root = RootOwner::create(
        &directory.path().join("root"),
        &RootNamespaces {
            ownership: directory.path().join("owners"),
            control: directory.path().join("control"),
        },
    )
    .unwrap();
    let store = Arc::new(
        RootStore::open(Arc::new(root), ROOT_MIGRATIONS)
            .await
            .unwrap(),
    );
    let owner = Arc::new(Computer {
        store: store.clone(),
        configuration: Default::default(),
        sessions: Default::default(),
        resources: Arc::default(),
        stopping: CancellationToken::new(),
        tasks: tokio_util::task::TaskTracker::new(),
        popup_provenance: None,
        previews: Default::default(),
    });
    let stop = CancellationToken::new();
    let fresh = stage(&owner, "session", &stop).await.unwrap();
    assert_eq!(
        serde_json::to_value(fresh).unwrap(),
        serde_json::json!({
            "sessionId": "session", "bindingId": null, "revision": 0,
            "targets": [], "activeTargetId": null
        })
    );
    let entry = owner.sessions.get("session").unwrap();
    let kernel = entry.fresh_kernel().unwrap();
    // A Run may retire while its Session VM binding remains available.
    kernel.epoch.preview_authority.lock().unwrap().take();
    let retired = stage(&owner, "session", &stop).await.unwrap();
    assert_eq!(
        retired.binding_id.as_deref(),
        Some(kernel.epoch.id.as_str())
    );
    assert_eq!(retired.session_id, "session");
    assert!(retired.targets.is_empty());
    assert_eq!(retired.active_target_id, None);
    assert!(matches!(
        current_epoch(&owner, "session", "another-binding"),
        Err(ToolError::Failed(_))
    ));
    *entry.kernel.lock().await = Some(kernel);
    owner.sessions.close().await.unwrap();
    let closed = stage(&owner, "session", &stop).await.unwrap();
    assert_eq!(closed.binding_id, None);
    assert!(matches!(
        current_epoch(&owner, "session", retired.binding_id.as_ref().unwrap()),
        Err(ToolError::Failed(_))
    ));
    drop(entry);
    drop(owner);
    Arc::try_unwrap(store).ok().unwrap().close().await.unwrap();
}
