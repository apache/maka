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
    RootStore,
    root::{RootNamespaces, RootOwner},
};
use serde_json::json;
use std::sync::Arc;

async fn fixture() -> (tempfile::TempDir, RootStore, DiscoveryStore) {
    let dir = tempfile::tempdir().unwrap();
    let root = RootOwner::create(
        &dir.path().join("root"),
        &RootNamespaces {
            ownership: dir.path().join("owners"),
            control: dir.path().join("control"),
        },
    )
    .unwrap();
    let migrations = maka_event_log::ROOT_MIGRATIONS
        .iter()
        .chain(crate::MIGRATIONS)
        .copied()
        .collect::<Vec<_>>();
    let root = RootStore::open(Arc::new(root), &migrations).await.unwrap();
    let store = DiscoveryStore::new(
        root.data_writer().unwrap(),
        &RunOwner {
            deployment: uuid::Uuid::new_v4(),
            namespace: maka_plugin_core::composition::InstanceId(vec![uuid::Uuid::new_v4()]),
        },
    )
    .unwrap();
    (dir, root, store)
}
fn dossier(topic: &str, signal: DossierSignal, weight: f64, expected: u64) -> DossierUpsert {
    DossierUpsert {
        topic_id: TopicId(topic.into()),
        title: topic.into(),
        summary_md: "evidence".into(),
        expected_revision: Some(expected),
        signal,
        priority_weight: weight,
        window_at: None,
        artifacts: vec![],
        linked_task_ids: None,
    }
}
#[tokio::test]
async fn reviews_preserve_material_order_and_stale_writers_cannot_overwrite() {
    use DossierSignal::*;
    let (_dir, _root, s) = fixture().await;
    for (at, (topic, signal, weight)) in [
        ("green", Green, 90.),
        ("red", Red, 1.),
        ("yellow", Yellow, 9.),
        ("done", Done, 99.),
        ("red-new", Red, 1.),
        ("red-heavy", Red, 2.),
    ]
    .into_iter()
    .enumerate()
    {
        s.upsert_dossier(dossier(topic, signal, weight, 0), UnixMillis(at as i64 + 1))
            .await
            .unwrap();
    }
    let topic = TopicId("red".into());
    let result = s
        .upsert_dossier(dossier("red", Red, 1., 1), UnixMillis(25))
        .await
        .unwrap();
    assert!(!result.material_change);
    s.touch_dossier_checked(topic.clone(), UnixMillis(28))
        .await
        .unwrap();
    let record = s.get_dossier(topic.clone()).await.unwrap().unwrap();
    assert_eq!(
        (
            record.last_checked_at.0,
            record.last_material_change_at.0,
            record.revision
        ),
        (28, 2, 1)
    );
    let sorted: Vec<_> = s
        .list_dossiers()
        .await
        .unwrap()
        .into_iter()
        .map(|r| r.title)
        .collect();
    assert_eq!(
        sorted,
        ["red-heavy", "red-new", "red", "yellow", "green", "done"]
    );
    let active = s.active_dossier_index(2).await.unwrap();
    assert_eq!(
        active
            .iter()
            .map(|r| r.topic_id.0.as_str())
            .collect::<Vec<_>>(),
        ["red-heavy", "red-new"]
    );
    assert_eq!(s.active_dossier_index(15).await.unwrap().len(), 5);
    let (a, b) = tokio::join!(
        s.upsert_dossier(dossier("red", Green, 1., 1), UnixMillis(40)),
        s.upsert_dossier(dossier("red", Yellow, 1., 1), UnixMillis(41))
    );
    assert_ne!(a.is_ok(), b.is_ok());
    let err = a.err().or(b.err()).unwrap();
    assert!(matches!(
        err.underlying(),
        StoreError::RevisionConflict { .. }
    ));
    for (name, expected) in [("red", 0), ("missing", 1)] {
        let e = s
            .upsert_dossier(dossier(name, Red, 0., expected), UnixMillis(42))
            .await
            .unwrap_err();
        assert!(matches!(
            e.underlying(),
            StoreError::RevisionConflict { .. }
        ));
    }
    assert_eq!(s.get_dossier(topic).await.unwrap().unwrap().revision, 2);
}
#[tokio::test]
async fn persisted_tracking_records_keep_their_cas_and_receipt() {
    let (_dir, root, s) = fixture().await;
    let at = UnixMillis(12);
    s.upsert_dossier(dossier("release", DossierSignal::Green, 0., 0), at)
        .await
        .unwrap();
    let topic = TopicId("release".into());
    let watch = WatchRecord {
        watch_id: WatchId("spec".into()),
        topic_id: topic.clone(),
        kind: WatchKind::FileHash,
        target: "spec.md".into(),
        predicate: json!({"changed":true}),
        on_trigger: WatchTrigger::InvalidateAction,
        last_state_hash: None,
        expires_at: None,
        created_at: at,
        updated_at: at,
    };
    assert!(s.save_watch(watch.clone(), None).await.unwrap());
    assert!(
        s.compare_and_set_watch_state(watch.watch_id.clone(), None, "v2".into(), at)
            .await
            .unwrap()
    );
    assert!(
        !s.compare_and_set_watch_state(watch.watch_id.clone(), None, "v1".into(), at)
            .await
            .unwrap()
    );
    let action = PendingActionRecord {
        action_id: ActionId("mail".into()),
        topic_id: topic.clone(),
        connector_tool: "mail".into(),
        params: json!({"draft":"review"}),
        input_hashes: [("spec.md".into(), "v2".into())].into(),
        idempotency_key: "draft-1".into(),
        status: PendingActionStatus::AwaitingConfirm,
        receipt: None,
        expires_at: UnixMillis(200),
        created_at: at,
        updated_at: at,
    };
    s.create_pending_action(action.clone()).await.unwrap();
    let mut edited = action.clone();
    edited.params = json!({"draft": "revised"});
    edited.updated_at = UnixMillis(13);
    assert!(s.update_pending_action(edited.clone(), at).await.unwrap());
    assert!(!s.update_pending_action(edited, at).await.unwrap());
    let mut duplicate = action.clone();
    duplicate.action_id = ActionId("another".into());
    assert!(s.create_pending_action(duplicate).await.is_err());
    use PendingActionStatus::*;
    let id = action.action_id.clone();
    assert!(
        s.transition_pending_action(id.clone(), AwaitingConfirm, Executing, None, at)
            .await
            .unwrap()
    );
    assert!(
        !s.transition_pending_action(id.clone(), AwaitingConfirm, Stale, None, at)
            .await
            .unwrap()
    );
    assert!(
        s.transition_pending_action(id.clone(), Executing, UnknownPendingReceipt, None, at)
            .await
            .unwrap()
    );
    assert!(!s.delete_pending_action(id.clone()).await.unwrap());
    assert!(
        s.transition_pending_action(
            id,
            UnknownPendingReceipt,
            Done,
            Some(json!({"id":"confirmed"})),
            at
        )
        .await
        .unwrap()
    );
    let detail = s.detail(topic).await.unwrap().unwrap();
    assert_eq!(detail.watches[0].last_state_hash.as_deref(), Some("v2"));
    assert_eq!(
        detail.pending_actions[0].receipt,
        Some(json!({"id":"confirmed"}))
    );
    let mut cursor = SourceCursorRecord {
        source_uri: SourceUri("spec.md".into()),
        last_mtime_ms: at,
        last_hash: None,
        write_burst_count: 0,
        cooldown_until: at,
        last_explored_at: at,
        updated_at: at,
    };
    assert!(s.save_source_cursor(cursor.clone(), None).await.unwrap());
    cursor.updated_at = UnixMillis(13);
    assert!(
        s.save_source_cursor(cursor.clone(), Some(at))
            .await
            .unwrap()
    );
    assert!(
        !s.save_source_cursor(cursor.clone(), Some(at))
            .await
            .unwrap()
    );
    assert_eq!(s.list_source_cursors(1).await.unwrap(), [cursor]);
    let other = DiscoveryStore::new(
        root.data_writer().unwrap(),
        &RunOwner {
            deployment: uuid::Uuid::new_v4(),
            namespace: maka_plugin_core::composition::InstanceId(vec![uuid::Uuid::nil()]),
        },
    )
    .unwrap();
    assert!(other.list_dossiers().await.unwrap().is_empty());
    assert!(other.get_watch(watch.watch_id).await.unwrap().is_none());
}

#[tokio::test]
async fn discovery_snapshot_retains_concurrent_topic_interrupts_after_quiet_revisions() {
    let (_dir, _root, s) = fixture().await;
    let mut stream = s.subscribe();
    let save = |name| {
        s.data.write(s.upsert_statement(
            dossier(name, DossierSignal::Red, 1., 0),
            Some(format!("Update {name}")),
            UnixMillis(10),
        ))
    };
    let (a, b) = tokio::join!(save("alpha"), save("beta"));
    assert!(a.unwrap().notified && b.unwrap().notified);
    let mut quiet = dossier("alpha", DossierSignal::Yellow, 1., 1);
    quiet.summary_md = "Checked".into();
    s.upsert_dossier(quiet, UnixMillis(11)).await.unwrap();
    stream.changed().await.unwrap();
    let snapshot = s.dossiers().await.unwrap();
    assert_eq!(snapshot.dossiers.len(), 2);
    for row in snapshot.dossiers {
        assert_eq!(row.last_notified_revision, 1);
        assert_eq!(row.last_interrupt_at, Some(UnixMillis(10)));
        assert_eq!(
            row.last_interrupt_reason,
            Some(format!("Update {}", row.title))
        );
        assert_eq!(row.revision, if row.title == "alpha" { 2 } else { 1 });
    }
}

#[tokio::test]
async fn discovery_cold_openings_preserve_other_cursor_fields_and_cycle_independently_of_followups()
{
    use changes::OpeningSources;
    let (_dir, _root, s) = fixture().await;
    let paths = ["a", "b", "c", "d", "e", "f"].map(str::to_owned);
    s.seed_cold_sources(paths.to_vec(), UnixMillis(10))
        .await
        .unwrap();
    let cold = |at| s.cold_sources(UnixMillis(at), 3, |_| true);
    let first = cold(11).await.unwrap();
    assert_eq!(first, paths[..3]);
    for n in 1..=3 {
        s.data
            .write(s.record_opening(OpeningSources::FollowUp(vec![]), true, UnixMillis(12)))
            .await
            .unwrap();
        assert_eq!(s.broad_cycle().await.unwrap(), n);
    }
    s.data
        .write(s.record_opening(OpeningSources::FollowUp(vec![]), false, UnixMillis(13)))
        .await
        .unwrap();
    assert_eq!(s.broad_cycle().await.unwrap(), 3);
    s.data
        .write(s.record_opening(OpeningSources::Wander(first), true, UnixMillis(14)))
        .await
        .unwrap();
    s.seed_cold_sources(paths.to_vec(), UnixMillis(15))
        .await
        .unwrap();
    assert_eq!(s.broad_cycle().await.unwrap(), 0);
    assert_eq!(cold(16).await.unwrap(), paths[3..]);
    assert_eq!(
        s.get_source_cursor(SourceUri("a".into()))
            .await
            .unwrap()
            .unwrap()
            .last_explored_at,
        UnixMillis(14)
    );
}
