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
        change_note: None,
        expected_revision: Some(expected),
        signal,
        priority_weight: weight,
        window_at: None,
        artifacts: vec![],
        replace_artifacts: false,
        choices: vec![],
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
async fn dossier_update_preserves_stable_title_and_merges_artifacts_by_default() {
    let (_d, _r, s) = fixture().await;
    let topic = TopicId("etf-check".into());

    let mut v1 = dossier("etf-check", DossierSignal::Yellow, 10.0, 0);
    v1.title = "ETF 轮动明早开跑：缺 4 只 CSV 数据".into();
    v1.artifacts = vec![StagedArtifact {
        path: "staging/etf-check/etf_signal_check.py".into(),
        sha256: "a".repeat(64),
        purpose: "Pure-stdlib signal checker".into(),
        input_hashes: Default::default(),
    }];
    s.upsert_dossier(v1, UnixMillis(100)).await.unwrap();

    let mut v2 = dossier("etf-check", DossierSignal::Yellow, 10.0, 1);
    v2.title = String::new();
    v2.summary_md = "Checked again; still missing CSV data".into();
    v2.artifacts = vec![];
    s.upsert_dossier(v2, UnixMillis(200)).await.unwrap();

    let after_v2 = s.detail(topic.clone()).await.unwrap().unwrap();
    assert_eq!(after_v2.dossier.title, "ETF 轮动明早开跑：缺 4 只 CSV 数据");
    assert_eq!(after_v2.dossier.artifacts.len(), 1);

    let mut v3 = dossier("etf-check", DossierSignal::Done, 10.0, 2);
    v3.title = String::new();
    v3.summary_md = "Done".into();
    v3.replace_artifacts = true;
    s.upsert_dossier(v3, UnixMillis(300)).await.unwrap();
    let after_v3 = s.detail(topic).await.unwrap().unwrap();
    assert!(after_v3.dossier.artifacts.is_empty());
}

#[tokio::test]
async fn completed_local_tool_recognizes_code_mode_cell_children() {
    let (dir, _root, _s) = fixture().await;
    let run_id = maka_agent_facts::durable::RunId::new();
    let fence = crate::CallerFence {
        execution: maka_agent_facts::durable::ExecutionIdentity {
            session_id: "sess-1".into(),
            turn_id: "turn-1".into(),
            run_id,
        },
        expected_basis: None,
    };
    let conn =
        rusqlite::Connection::open(dir.path().join("root").join("runtime-rust.sqlite")).unwrap();
    assert!(!fence.completed_local_tool(&conn, "ListDossiers").unwrap());

    conn.execute(
        "INSERT INTO agent_cells(cell, session, run, pending, body) VALUES (?1, ?2, ?3, 0, ?4)",
        rusqlite::params![
            "cell-err",
            "sess-1",
            run_id.to_string(),
            json!({
                "children": {
                    "op-1": {
                        "name": "ListDossiers",
                        "localResult": { "settlement": "failed", "isError": true }
                    }
                }
            })
            .to_string()
        ],
    )
    .unwrap();
    assert!(!fence.completed_local_tool(&conn, "ListDossiers").unwrap());

    conn.execute(
        "INSERT INTO agent_cells(cell, session, run, pending, body) VALUES (?1, ?2, ?3, 0, ?4)",
        rusqlite::params![
            "cell-ok",
            "sess-1",
            run_id.to_string(),
            json!({
                "children": {
                    "op-2": {
                        "name": "ListDossiers",
                        "localResult": { "settlement": "returned", "isError": false }
                    }
                }
            })
            .to_string()
        ],
    )
    .unwrap();
    assert!(fence.completed_local_tool(&conn, "ListDossiers").unwrap());
    assert!(!fence.completed_local_tool(&conn, "OtherTool").unwrap());
}

#[tokio::test]
async fn choose_statement_rejects_unknown_revision_and_invalid_choice_key() {
    let (_d, _r, s) = fixture().await;
    let topic = TopicId("choice-guard".into());
    let mut input = dossier("choice-guard", DossierSignal::Yellow, 5.0, 0);
    input.choices = vec![maka_agent_facts::discovery::DossierChoice {
        key: "fix".into(),
        label: "Apply fix".into(),
        detail: "Update config".into(),
        recommended: true,
        resolves: false,
        instruction: "Run fix".into(),
    }];
    s.upsert_dossier(input, UnixMillis(100)).await.unwrap();

    let wrong_rev = s
        .data
        .write(s.choose_statement(topic.clone(), 99, "fix".into(), false, UnixMillis(101)))
        .await;
    assert!(wrong_rev.is_err(), "unknown revision must be rejected");

    let wrong_key = s
        .data
        .write(s.choose_statement(topic.clone(), 1, "bogus".into(), false, UnixMillis(102)))
        .await;
    assert!(wrong_key.is_err(), "unknown choice key must be rejected");

    s.data
        .write(s.choose_statement(topic.clone(), 1, "fix".into(), false, UnixMillis(103)))
        .await
        .unwrap();
    let detail = s.detail(topic).await.unwrap().unwrap();
    assert_eq!(detail.revisions[0].chosen_key.as_deref(), Some("fix"));
}
