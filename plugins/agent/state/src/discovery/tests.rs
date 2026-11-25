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
        choices: vec![],
        expected_revision: Some(expected),
        signal,
        priority_weight: weight,
        window_at: None,
        artifacts: vec![],
        replace_artifacts: false,
        linked_task_ids: None,
    }
}

#[tokio::test]
async fn opening_acknowledges_its_snapshot_and_preserves_concurrent_and_out_of_scope_deltas() {
    use changes::{ChangeQuery, FileWrite, Fingerprint, OpeningSources, ProbeResult, WriteKind};
    let (_dir, root, store) = fixture().await;
    let write = |path: &str, at| FileWrite {
        path: path.into(),
        kind: WriteKind::Created,
        at: UnixMillis(at),
    };
    let publish = |writes, at| {
        let store = &store;
        async move {
            store.observe_writes(writes, 0, 100, 100).await.unwrap();
            let probes = store.due_probes(UnixMillis(at), 100).await.unwrap();
            store
                .finish_probes(
                    probes
                        .into_iter()
                        .map(|p| {
                            let fp = Fingerprint {
                                mtime: p.observed,
                                hash: format!("hash-{}", p.observed.0),
                            };
                            (p, ProbeResult::Stable(fp))
                        })
                        .collect(),
                )
                .await
                .unwrap();
        }
    };
    publish(
        vec![
            write("/work/report", 10),
            write("/work/terms", 10),
            write("/other/quote", 10),
            write("/work/later", 12),
        ],
        12,
    )
    .await;
    let snapshot = store
        .change_snapshot(
            UnixMillis(11),
            ChangeQuery::Opening { limit: 64 },
            |path, _| path.starts_with("/work"),
        )
        .await
        .unwrap();
    assert_eq!(snapshot.deltas.len(), 2);
    assert_eq!(
        store.next_change_deadline(UnixMillis(11)).await.unwrap(),
        Some(12)
    );
    publish(vec![write("/work/report", 13)], 13).await;
    root.data_writer()
        .unwrap()
        .write(store.record_opening(
            OpeningSources::FollowUp(snapshot.deltas),
            false,
            UnixMillis(14),
        ))
        .await
        .unwrap();
    let pending = store
        .change_snapshot(
            UnixMillis(14),
            ChangeQuery::Opening { limit: 64 },
            |_, _| true,
        )
        .await
        .unwrap();
    assert_eq!(
        pending
            .deltas
            .into_iter()
            .map(|d| (d.path, d.at.0))
            .collect::<Vec<_>>(),
        [
            ("/work/report".into(), 13),
            ("/work/later".into(), 12),
            ("/other/quote".into(), 10)
        ]
    );
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
    let action = PendingActionRecord {
        action_id: ActionId("mail".into()),
        topic_id: topic.clone(),
        connector_tool: "mail".into(),
        params: json!({"draft":"review"}),
        input_hashes: [("spec.md".into(), "v2".into())].into(),
        idempotency_key: "draft-1".into(),
        status: PendingActionStatus::AwaitingConfirm,
        receipt: None,
        expires_at: UnixMillis(i64::MAX),
        created_at: at,
        updated_at: at,
    };
    let stage = |r| {
        s.data
            .write(s.stage_action_statement(r, json!({}), json!({})))
    };
    stage(action.clone()).await.unwrap();
    let detail = s.detail(topic.clone()).await.unwrap().unwrap();
    let watch = detail.watches.into_iter().next().unwrap();
    assert_eq!(watch.last_state_hash.as_deref(), Some("v2"));
    let mut duplicate = action.clone();
    duplicate.action_id = ActionId("another".into());
    assert!(stage(duplicate).await.is_err());
    let id = action.action_id;
    assert!(
        s.claim_action(id.clone(), at, guards::InputCheck::Compared(vec![]))
            .await
            .unwrap()
    );
    s.recover_executing_actions(UnixMillis(14)).await.unwrap();
    let original = s.get_pending_action(id.clone()).await.unwrap().unwrap();
    assert_eq!(original.status, PendingActionStatus::UnknownPendingReceipt);
    assert!(original.receipt.unwrap()["error"].is_string());
    assert!(
        !s.claim_action(id.clone(), at, guards::InputCheck::Compared(vec![]))
            .await
            .unwrap()
    );
    assert!(
        s.data
            .write(s.dismiss_action_statement(id, at))
            .await
            .is_err()
    );
    assert!(s.list_watches(topic).await.unwrap().is_empty());
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

#[tokio::test]
async fn dossier_revisions_choices_and_resolution_persist_in_plugin_data() {
    let (_dir, _root, s) = fixture().await;
    let topic = TopicId("key-rot".into());
    let mut v1 = dossier("key-rot", DossierSignal::Yellow, 1.0, 0);
    v1.summary_md = "15 occurrences found".into();
    s.upsert_dossier(v1, UnixMillis(100)).await.unwrap();

    let mut v2 = dossier("key-rot", DossierSignal::Yellow, 2.0, 1);
    v2.summary_md = "28 occurrences found".into();
    v2.change_note = Some("Full scan found 13 more occurrences".into());
    v2.choices = vec![
        DossierChoice {
            key: "A".into(),
            label: "Close dossier".into(),
            detail: "Mark as resolved".into(),
            recommended: true,
            resolves: true,
            instruction: "Close it".into(),
        },
        DossierChoice {
            key: "B".into(),
            label: "Run v2 script".into(),
            detail: "Dry run first".into(),
            recommended: false,
            resolves: false,
            instruction: "Run dry-run".into(),
        },
    ];
    s.upsert_dossier(v2, UnixMillis(200)).await.unwrap();

    let detail = s.detail(topic.clone()).await.unwrap().unwrap();
    assert_eq!(detail.revisions.len(), 2);
    assert_eq!(detail.revisions[0].revision, 1);
    assert_eq!(detail.revisions[0].summary_md, "15 occurrences found");
    assert_eq!(detail.revisions[1].revision, 2);
    assert_eq!(
        detail.revisions[1].change_note.as_deref(),
        Some("Full scan found 13 more occurrences")
    );
    assert_eq!(detail.revisions[1].choices.len(), 2);

    s.data
        .write(s.choose_statement(topic.clone(), 2, "A".into(), true, UnixMillis(250)))
        .await
        .unwrap();
    let chosen = s.detail(topic.clone()).await.unwrap().unwrap();
    assert_eq!(chosen.dossier.signal, DossierSignal::Done);
    assert_eq!(chosen.revisions[1].chosen_key.as_deref(), Some("A"));

    s.data
        .write(s.resolve_statement(topic.clone(), false, UnixMillis(260)))
        .await
        .unwrap();
    let reopened = s.detail(topic.clone()).await.unwrap().unwrap();
    assert_eq!(reopened.dossier.signal, DossierSignal::Yellow);

    let mut v3 = dossier("key-rot", DossierSignal::Red, 3.0, 2);
    v3.summary_md = "New leaked key in staging".into();
    s.upsert_dossier(v3, UnixMillis(300)).await.unwrap();
    let updated = s.detail(topic).await.unwrap().unwrap();
    assert_eq!(updated.dossier.signal, DossierSignal::Red);
    assert_eq!(updated.revisions.len(), 3);
    assert_eq!(updated.revisions[1].chosen_key.as_deref(), Some("A"));
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

    // Update omitting title and artifacts must preserve both.
    let mut v2 = dossier("etf-check", DossierSignal::Yellow, 10.0, 1);
    v2.title = String::new();
    v2.summary_md = "Checked again; still missing CSV data".into();
    v2.artifacts = vec![];
    s.upsert_dossier(v2, UnixMillis(200)).await.unwrap();

    let after_v2 = s.detail(topic.clone()).await.unwrap().unwrap();
    assert_eq!(after_v2.dossier.title, "ETF 轮动明早开跑：缺 4 只 CSV 数据");
    assert_eq!(after_v2.dossier.artifacts.len(), 1);
    assert_eq!(
        after_v2.dossier.artifacts[0].path,
        "staging/etf-check/etf_signal_check.py"
    );

    // Updating same path replaces sha256 in place; new path appends.
    let mut v3 = dossier("etf-check", DossierSignal::Yellow, 10.0, 2);
    v3.title = String::new();
    v3.summary_md = "Updated script and added checklist".into();
    v3.artifacts = vec![
        StagedArtifact {
            path: "staging/etf-check/etf_signal_check.py".into(),
            sha256: "b".repeat(64),
            purpose: "v2 checker".into(),
            input_hashes: Default::default(),
        },
        StagedArtifact {
            path: "staging/etf-check/checklist.md".into(),
            sha256: "c".repeat(64),
            purpose: "Export steps".into(),
            input_hashes: Default::default(),
        },
    ];
    s.upsert_dossier(v3, UnixMillis(300)).await.unwrap();
    let after_v3 = s.detail(topic.clone()).await.unwrap().unwrap();
    assert_eq!(after_v3.dossier.artifacts.len(), 2);
    assert_eq!(
        after_v3.dossier.artifacts[0].sha256.as_deref(),
        Some("b".repeat(64).as_str())
    );

    // Explicit replace_artifacts clears prior attachments.
    let mut v4 = dossier("etf-check", DossierSignal::Done, 10.0, 3);
    v4.title = String::new();
    v4.summary_md = "Done".into();
    v4.replace_artifacts = true;
    s.upsert_dossier(v4, UnixMillis(400)).await.unwrap();
    let after_v4 = s.detail(topic).await.unwrap().unwrap();
    assert!(after_v4.dossier.artifacts.is_empty());
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

    // A failed cell child must NOT satisfy the prerequisite.
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

    // A returned, non-error cell child MUST satisfy the prerequisite (Code Mode exec).
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
