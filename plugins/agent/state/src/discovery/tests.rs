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
use std::path::Path;
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
        entity_key: None,
        reopen: false,
        title: topic.into(),
        summary_md: "evidence".into(),
        fact_state: None,
        briefing: false,
        evidence_md: None,
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
async fn discovery_continuation_identity_survives_job_settlement_and_ignores_other_scheduled_children()
 {
    let (_dir, root, store) = fixture().await;
    let digest = "a".repeat(64);
    let worker = format!("owner-{}", &digest[..32]);
    for (id, fp, config) in [
        (
            worker.as_str(),
            digest.as_str(),
            json!({"parentSessionId":"bot","discoveryWorker":false}),
        ),
        ("new-worker", "new", json!({"discoveryWorker":true})),
        ("scheduled-child", "task", json!({"parentSessionId":"bot"})),
        (
            "thread",
            "thread",
            json!({"dossierSeed":"topic","dossierElevated":true}),
        ),
    ] {
        root.create_session(id, fp, &config, 1).await.unwrap();
    }
    assert!(store.is_worker_session("new-worker".into()).await.unwrap());
    for id in [&*worker, "scheduled-child", "thread"] {
        assert!(!store.is_worker_session(id.into()).await.unwrap());
    }
    for active in [true, false] {
        let worker = worker.clone();
        let id = worker.clone();
        let digest = digest.clone();
        root.data_writer().unwrap().write(store.mutation(false,move |c,_| {
            c.execute("DELETE FROM plugin_data WHERE package_id='maka.agent.scheduler'",[])?;
            let (key, value) = if active {("owner-discovery/active".to_owned(),json!({"worker":worker}))}
                else {(format!("owner-discovery/completed/{digest}"),json!({"run":{"sessionId":worker}}))};
            c.execute("INSERT INTO plugin_data(package_id,scope_id,key,revision,value_json) VALUES('maka.agent.scheduler','profile',?1,1,?2)",rusqlite::params![key,value.to_string()])?;
            Ok(())
        })).await.unwrap();
        assert!(store.is_worker_session(id).await.unwrap());
    }
    // Older workers whose scheduler completion receipt was pruned still carry discovery finish tools.
    root.data_writer()
        .unwrap()
        .write(store.mutation(false, |c, _| {
            c.execute(
                "DELETE FROM plugin_data WHERE package_id='maka.agent.scheduler'",
                [],
            )?;
            Ok(())
        }))
        .await
        .unwrap();
    let pruned_digest = "b".repeat(64);
    let pruned_worker = format!("owner-{}", &pruned_digest[..32]);
    root.create_session(
        &pruned_worker,
        &pruned_digest,
        &json!({"parentSessionId": "bot", "tools": ["Read", "FinishNoChange"]}),
        1,
    )
    .await
    .unwrap();
    root.create_session(
        "ordinary-bot-child",
        "c".repeat(64).as_str(),
        &json!({"parentSessionId": "bot", "tools": ["Read", "Shell"]}),
        1,
    )
    .await
    .unwrap();
    assert!(store.is_worker_session(pruned_worker).await.unwrap());
    assert!(
        !store
            .is_worker_session("ordinary-bot-child".into())
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn unfollow_statement_clears_tracking_and_evidence_md_persists_with_preview() {
    use maka_agent_facts::discovery::PendingActionStatus;
    let (_dir, root, store) = fixture().await;
    let mut input = dossier("topic-u", DossierSignal::Yellow, 2.0, 0);
    input.summary_md =
        "## 标题\n你的 [PR #3684](https://example.com) 已通过检查。\n| a | b |\n| - | - |".into();
    input.evidence_md = Some("Checks: 6/6 passed".into());
    let upserted = store.upsert_dossier(input, UnixMillis(100)).await.unwrap();
    assert_eq!(upserted.revision, 1);

    let summary = store
        .list_dossiers()
        .await
        .unwrap()
        .into_iter()
        .next()
        .unwrap();
    assert!(!summary.unfollowed);
    assert_eq!(summary.preview, "你的 PR #3684 已通过检查。");
    let detail = store
        .detail(TopicId("topic-u".into()))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        detail.revisions[0].evidence_md.as_deref(),
        Some("Checks: 6/6 passed")
    );

    root.data_writer()
        .unwrap()
        .write(store.mutation(false, |c, owner| {
            c.execute(
                "INSERT INTO discovery_watches(owner,watch_id,topic_id,kind,target,predicate_json,on_trigger,created_at,updated_at)
                 VALUES(?1,'w1','topic-u','deadline','due','{}','notify_direct',100,100)",
                [owner],
            )?;
            c.execute(
                "INSERT INTO discovery_pending_actions(owner,action_id,topic_id,connector_tool,params_json,input_hashes_json,idempotency_key,status,expires_at,created_at,updated_at)
                 VALUES(?1,'a1','topic-u','Send','{}','{}','k1',?2,999999,100,100)",
                rusqlite::params![owner, PendingActionStatus::AwaitingConfirm.as_str()],
            )?;
            Ok(())
        }))
        .await
        .unwrap();

    let title = root
        .data_writer()
        .unwrap()
        .write(store.unfollow_statement(TopicId("topic-u".into()), true, UnixMillis(200)))
        .await
        .unwrap();
    assert_eq!(title, "topic-u");
    assert!(
        store
            .is_unfollowed(TopicId("topic-u".into()))
            .await
            .unwrap()
    );
    let after = store
        .detail(TopicId("topic-u".into()))
        .await
        .unwrap()
        .unwrap();
    assert!(after.dossier.unfollowed);
    assert!(after.dossier.muted);
    assert_eq!(after.dossier.signal, DossierSignal::Done);
    assert!(after.watches.is_empty());
    assert!(after.pending_actions.is_empty());

    root.data_writer()
        .unwrap()
        .write(store.unfollow_statement(TopicId("topic-u".into()), false, UnixMillis(300)))
        .await
        .unwrap();
    assert!(
        !store
            .is_unfollowed(TopicId("topic-u".into()))
            .await
            .unwrap()
    );
    let restored = store
        .get_dossier(TopicId("topic-u".into()))
        .await
        .unwrap()
        .unwrap();
    assert!(!restored.unfollowed);
    assert!(!restored.muted);
    assert_eq!(restored.signal, DossierSignal::Yellow);
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
            ChangeQuery::opening(64, Path::new("/work")),
            |path, _| path.starts_with("/work"),
        )
        .await
        .unwrap();
    let deltas = snapshot.into_deltas();
    assert_eq!(deltas.len(), 2);
    assert_eq!(
        store.next_change_deadline(UnixMillis(11)).await.unwrap(),
        Some(12)
    );
    // A probe can become ready after the opening with an observation older than every frozen row.
    store
        .observe_writes(vec![write("/work/late/from-before", 5)], 8, 100, 100)
        .await
        .unwrap();
    publish(vec![write("/work/report", 13)], 13).await;
    root.data_writer()
        .unwrap()
        .write(store.record_opening(OpeningSources::FollowUp(deltas), UnixMillis(14)))
        .await
        .unwrap();
    let pending = store
        .change_snapshot(
            UnixMillis(14),
            ChangeQuery::opening(64, Path::new("/work")),
            |_, _| true,
        )
        .await
        .unwrap();
    assert_eq!(
        pending
            .into_deltas()
            .into_iter()
            .map(|d| (d.path, d.at.0))
            .collect::<Vec<_>>(),
        [
            ("/work/report".into(), 13),
            ("/work/later".into(), 12),
            ("/other/quote".into(), 10),
            ("/work/late/from-before".into(), 5)
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
async fn reworded_reviews_preserve_revision_and_evidence_until_a_fact_or_briefing_changes() {
    let (_dir, _root, s) = fixture().await;
    let topic = TopicId("release".into());
    let update = |rev| dossier("release", DossierSignal::Yellow, 1., rev);
    let mut first = update(0);
    first.fact_state = Some("Waiting for signoff".into());
    first.evidence_md = Some("Board minutes".into());
    first.change_note = Some("Signoff requested".into());
    s.upsert_dossier(first, UnixMillis(10)).await.unwrap();

    let mut paraphrase = update(1);
    paraphrase.title = "Review at noon".into();
    paraphrase.summary_md = "Still waiting as of 12:00".into();
    paraphrase.change_note = Some("Rechecked again".into());
    paraphrase.evidence_md = Some("Board minutes, retrieved at 12:00".into());
    paraphrase.fact_state = Some(" Waiting  for\nsignoff ".into());
    let quiet = s.upsert_dossier(paraphrase, UnixMillis(30)).await.unwrap();
    assert!(!quiet.material_change);
    assert_eq!(quiet.revision, 1);
    s.upsert_dossier(update(1), UnixMillis(20)).await.unwrap();
    let detail = s.detail(topic.clone()).await.unwrap().unwrap();
    assert_eq!(
        (
            detail.dossier.last_checked_at.0,
            detail.dossier.last_material_change_at.0
        ),
        (30, 10)
    );
    assert_eq!(detail.revisions.len(), 1);
    assert_eq!(detail.dossier.summary_md, "evidence");
    assert_eq!(
        detail.revisions[0].evidence_md.as_deref(),
        Some("Board minutes")
    );
    assert_eq!(
        detail.revisions[0].change_note.as_deref(),
        Some("Signoff requested")
    );

    let mut blocker = update(1);
    blocker.fact_state = Some("Waiting for legal review".into());
    blocker.summary_md = "The board requested legal review".into();
    blocker.evidence_md = Some("Decision 8".into());
    assert!(
        s.upsert_dossier(blocker, UnixMillis(40))
            .await
            .unwrap()
            .material_change
    );
    let changed = s.detail(topic.clone()).await.unwrap().unwrap();
    assert_eq!(
        changed.dossier.summary_md,
        "The board requested legal review"
    );
    assert_eq!(
        changed.revisions[1].evidence_md.as_deref(),
        Some("Decision 8")
    );
    let mut edition = update(2);
    edition.briefing = true;
    edition.summary_md = "Daily edition".into();
    let delivered = s.upsert_dossier(edition, UnixMillis(50)).await.unwrap();
    assert!(delivered.material_change);
    let latest = s
        .detail(topic)
        .await
        .unwrap()
        .unwrap()
        .revisions
        .pop()
        .unwrap();
    assert_eq!(latest.revision, 3);
    assert_eq!(
        latest.fact_state.as_deref(),
        Some("Waiting for legal review")
    );
}

#[tokio::test]
async fn closing_or_unfollowing_invalidates_stale_workers_and_repeated_requests_are_idempotent() {
    let (_dir, _root, s) = fixture().await;
    for (name, unfollow) in [("closed", false), ("unfollowed", true)] {
        let topic = TopicId(name.into());
        s.upsert_dossier(dossier(name, DossierSignal::Red, 1., 0), UnixMillis(1))
            .await
            .unwrap();
        for at in [10, 11] {
            if unfollow {
                s.data
                    .write(s.unfollow_statement(topic.clone(), true, UnixMillis(at)))
                    .await
                    .unwrap();
            } else {
                s.data
                    .write(s.resolve_statement(topic.clone(), true, UnixMillis(at)))
                    .await
                    .unwrap();
            }
        }
        let e = s
            .upsert_dossier(dossier(name, DossierSignal::Yellow, 1., 1), UnixMillis(12))
            .await
            .unwrap_err();
        assert!(
            matches!(e.underlying(), StoreError::RevisionConflict {expected, actual} if expected == "1" && actual == "2")
        );
        let closed = s.get_dossier(topic).await.unwrap().unwrap();
        assert_eq!(
            (
                closed.revision,
                closed.signal,
                closed.last_material_change_at.0
            ),
            (2, DossierSignal::Done, 10)
        );
    }
}

#[tokio::test]
async fn discovery_revision_and_notification_counts_follow_material_writes() {
    let (_dir, _root, store) = fixture().await;
    let plan = "reviews";
    let mut input = serde_json::json!({"topic_id":"annex","title":"Annex","expected_revision":0,
        "signal":"yellow","summary_md":"Awaiting review","priority_weight":1});
    let mut revision = 0;
    for (at, (patch, material)) in [
        (serde_json::json!({}), true),
        (serde_json::json!({"window_at":10000}), true),
        (serde_json::json!({"linked_task_ids":["b","a"]}), true),
        (serde_json::json!({"linked_task_ids":["a","b","a"]}), false),
        (serde_json::json!({"choices":[{"key":"a","label":"Approve","instruction":"Approve annex"}]}), true),
        (serde_json::json!({"choices":[{"key":"a","label":"Review","instruction":"Review annex"}]}), true),
        (serde_json::json!({"choices":[],"summary_md":"Still awaiting review"}), false),
    ].into_iter().enumerate() {
        input.as_object_mut().unwrap().extend(patch.as_object().unwrap().clone());
        input["expected_revision"] = revision.into();
        let outcome = store.data.write(store.plan_upsert_statement(Some(plan.into()),
            serde_json::from_value(input.clone()).unwrap(), (at == 1).then(|| "Deadline added".into()), UnixMillis(at as i64))).await.unwrap();
        assert_eq!(outcome.material_change, material);
        revision += u64::from(material);
        assert_eq!(outcome.revision, revision);
    }
    let activity = store.plan_activity(plan).await.unwrap();
    assert_eq!(
        (
            activity.revised,
            activity.notified,
            activity.model_runs,
            activity.skipped
        ),
        (5, 1, 0, 0)
    );
}

#[tokio::test]
async fn discovery_meter_tiers_pacing_keeps_full_run_limit_and_allows_bypass() {
    use activity::ModelCharge;
    const HOUR: i64 = 3_600_000;
    const DAY: i64 = 24 * HOUR;
    const LIMIT: u64 = 1_500_000;
    let (_dir, _root, store) = fixture().await;
    let plan = "digest";
    let start = DAY + HOUR;
    for (hour, charge, spent, next) in [
        (0, 1_999_999, 1_999_999, 0),
        (0, 1, 2_000_000, 2),
        (2, 1_199_999, 3_199_999, 4),
        (4, 1, 3_200_000, 8),
        (8, 799_999, 3_999_999, 12),
        (12, 1, 4_000_000, 23),
    ] {
        let at = UnixMillis(start + hour * HOUR);
        let activity = store.plan_activity(plan).await.unwrap();
        let allowance = activity.allowance(at, LIMIT, false).unwrap();
        assert_eq!((allowance.day, allowance.tokens), (1, LIMIT));
        store
            .data
            .write(store.charge_statement(
                plan.into(),
                Some(allowance),
                at,
                Some(ModelCharge::Admitted(charge)),
            ))
            .await
            .unwrap();
        let meter = store.plan_activity(plan).await.unwrap();
        assert_eq!((meter.tokens, meter.last_run_at), (spent, at.0));
        let due = UnixMillis(start + next * HOUR);
        if next > hour {
            assert_eq!(
                meter
                    .allowance(UnixMillis(due.0 - 1), LIMIT, false)
                    .unwrap_err(),
                due
            );
            assert_eq!(
                meter
                    .allowance(UnixMillis(DAY - 1), LIMIT, false)
                    .unwrap_err(),
                due
            );
        }
        assert_eq!(meter.allowance(due, LIMIT, false).unwrap().tokens, LIMIT);
        assert_eq!(meter.allowance(at, LIMIT, true).unwrap().tokens, LIMIT);
    }
    let at = UnixMillis(start + 13 * HOUR);
    let meter = store.plan_activity(plan).await.unwrap();
    let bypass = meter.allowance(at, LIMIT, true).unwrap();
    store
        .data
        .write(store.charge_statement(
            plan.into(),
            Some(bypass),
            at,
            Some(ModelCharge::Admitted(50_000)),
        ))
        .await
        .unwrap();
    let meter = store.plan_activity(plan).await.unwrap();
    assert_eq!(
        (meter.tokens, meter.last_run_at, meter.model_runs),
        (4_050_000, at.0, 7)
    );
    assert_eq!(
        meter.allowance(at, LIMIT, false).unwrap_err(),
        UnixMillis(2 * DAY)
    );
    assert_eq!(
        store
            .plan_activity("other")
            .await
            .unwrap()
            .allowance(at, LIMIT, false)
            .unwrap()
            .tokens,
        LIMIT
    );
}

#[tokio::test]
async fn discovery_pacing_resets_at_utc_midnight_and_charges_the_admission_day_under_clock_skew() {
    use activity::{DiscoveryActivity, ModelCharge};
    const HOUR: i64 = 3_600_000;
    const MIDNIGHT: i64 = 48 * HOUR;
    const LIMIT: u64 = 1_500_000;
    let (_dir, _root, store) = fixture().await;
    let plan = "rollover";
    let charge = |allowance, at, charge| {
        store.data.write(store.charge_statement(
            plan.into(),
            Some(allowance),
            UnixMillis(at),
            Some(charge),
        ))
    };
    let yesterday = DiscoveryActivity::default()
        .allowance(UnixMillis(MIDNIGHT - HOUR), LIMIT, false)
        .unwrap();
    charge(yesterday, MIDNIGHT - HOUR, ModelCharge::Admitted(2_000_000))
        .await
        .unwrap();
    let meter = store.plan_activity(plan).await.unwrap();
    assert_eq!(
        meter
            .allowance(UnixMillis(MIDNIGHT - 1), LIMIT, false)
            .unwrap_err(),
        UnixMillis(MIDNIGHT)
    );
    // A run finishing after midnight still belongs to the day that admitted it.
    charge(
        yesterday,
        MIDNIGHT + 2 * HOUR,
        ModelCharge::Admitted(1_200_000),
    )
    .await
    .unwrap();
    let meter = store.plan_activity(plan).await.unwrap();
    assert_eq!((meter.day, meter.tokens), (1, 3_200_000));
    assert_eq!(
        meter
            .allowance(UnixMillis(MIDNIGHT - 1), LIMIT, false)
            .unwrap_err(),
        UnixMillis(MIDNIGHT)
    );
    let today = meter.allowance(UnixMillis(MIDNIGHT), LIMIT, false).unwrap();
    assert_eq!((today.day, today.tokens), (2, LIMIT));
    charge(today, MIDNIGHT - 1, ModelCharge::Admitted(1_900_000))
        .await
        .unwrap();
    let meter = store.plan_activity(plan).await.unwrap();
    assert_eq!(
        (meter.day, meter.tokens, meter.last_run_at),
        (2, 1_900_000, MIDNIGHT)
    );
    let skewed = meter
        .allowance(UnixMillis(MIDNIGHT - HOUR), LIMIT, false)
        .unwrap();
    assert_eq!((skewed.day, skewed.tokens), (2, LIMIT));
    charge(skewed, MIDNIGHT + HOUR, ModelCharge::Unobserved(100_000))
        .await
        .unwrap();
    charge(today, MIDNIGHT - HOUR, ModelCharge::Admitted(1))
        .await
        .unwrap();
    charge(yesterday, MIDNIGHT + 2 * HOUR, ModelCharge::Admitted(456))
        .await
        .unwrap();
    let meter = store.plan_activity(plan).await.unwrap();
    assert_eq!(
        (meter.day, meter.tokens, meter.last_run_at, meter.model_runs),
        (2, 2_000_001, MIDNIGHT + HOUR, 5)
    );
    assert_eq!(
        meter
            .allowance(UnixMillis(MIDNIGHT - HOUR), LIMIT, false)
            .unwrap_err(),
        UnixMillis(MIDNIGHT + 3 * HOUR)
    );
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
    let late = PendingActionRecord {
        action_id: ActionId("file-recheck".into()),
        idempotency_key: "file-recheck".into(),
        ..action.clone()
    };
    stage(late.clone()).await.unwrap();
    assert!(
        s.claim_action(
            late.action_id.clone(),
            at,
            guards::InputCheck::Compared(vec![])
        )
        .await
        .unwrap()
    );
    s.finish_action(
        late.action_id.clone(),
        guards::ActionReceipt::Stale(vec!["spec.md".into()]),
        UnixMillis(13),
    )
    .await
    .unwrap();
    let stale = s.get_pending_action(late.action_id).await.unwrap().unwrap();
    assert_eq!(stale.status, PendingActionStatus::Stale);
    assert_eq!(stale.receipt.unwrap()["changedPaths"], json!(["spec.md"]));
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
async fn cancelled_watch_registration_does_not_persist_or_schedule() {
    let (_dir, root, store) = fixture().await;
    let at = UnixMillis(12);
    store
        .upsert_dossier(dossier("watchable", DossierSignal::Green, 0., 0), at)
        .await
        .unwrap();
    let id = WatchId("deadline".into());
    let watch = guards::ScheduledWatch {
        watch: WatchRecord {
            watch_id: id.clone(),
            topic_id: TopicId("watchable".into()),
            kind: WatchKind::Deadline,
            target: String::new(),
            predicate: json!({"trigger_at_ms":12}),
            on_trigger: WatchTrigger::NotifyDirect,
            last_state_hash: None,
            expires_at: None,
            created_at: at,
            updated_at: at,
        },
        authority: json!({}),
        interval_ms: 1,
        action_id: None,
    };
    let cancel = tokio_util::sync::CancellationToken::new();
    cancel.cancel();
    assert!(store.register_watch(watch, at, cancel).await.is_err());
    assert!(store.get_watch(id).await.unwrap().is_none());
    assert!(
        store
            .next_watch_due(WatchKind::Deadline)
            .await
            .unwrap()
            .is_none()
    );
    drop(store);
    root.close().await.unwrap();
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
async fn discovery_wander_opening_creates_or_advances_only_the_selected_cursor() {
    use changes::OpeningSources;
    let (_dir, _root, s) = fixture().await;
    let record = |at| {
        s.data.write(s.record_opening(
            OpeningSources::Wander(vec!["mapped".into()]),
            UnixMillis(at),
        ))
    };
    record(14).await.unwrap();
    record(10).await.unwrap();
    let candidates = |cutoff| {
        vec![
            ("mapped".into(), UnixMillis(cutoff)),
            ("next".into(), UnixMillis(cutoff)),
        ]
    };
    let available = s
        .available_wander_paths(candidates(13), UnixMillis(20))
        .await
        .unwrap();
    assert_eq!(available, [std::path::Path::new("next")]);
    assert_eq!(
        s.available_wander_paths(candidates(14), UnixMillis(20))
            .await
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        s.get_source_cursor(SourceUri("mapped".into()))
            .await
            .unwrap()
            .unwrap()
            .last_explored_at,
        UnixMillis(14)
    );
    assert!(
        s.get_source_cursor(SourceUri("next".into()))
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn discovery_entity_key_prevents_splits_and_requires_explicit_reopen() {
    let (_dir, _root, s) = fixture().await;
    let topic = TopicId("release".into());
    let keyed = |name: &str, revision, key: &str| {
        let mut input = dossier(name, DossierSignal::Yellow, 1., revision);
        input.entity_key = Some(key.into());
        input
    };
    let at = UnixMillis(100);
    let key = "github:apache/maka#3819";
    assert!(
        s.upsert_dossier(keyed("failed-claim", 1, key), at)
            .await
            .is_err()
    );
    s.upsert_dossier(dossier("release", DossierSignal::Yellow, 1., 0), at)
        .await
        .unwrap();
    let attached = s
        .upsert_dossier(keyed("release", 1, "  GitHub:Apache/Maka#3819 "), at)
        .await
        .unwrap();
    assert!(!attached.material_change);
    let duplicate = || keyed("completely-different-title", 0, key);
    let error = s
        .upsert_dossier(duplicate(), at)
        .await
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("update existing topic_id release at revision 1"),
        "{error}"
    );
    let error = s
        .upsert_dossier(keyed("release", 1, "github:apache/maka#999"), at)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("cannot change"));

    s.data
        .write(s.resolve_statement(topic.clone(), true, at))
        .await
        .unwrap();
    for input in [duplicate(), keyed("release", 2, key)] {
        let error = s.upsert_dossier(input, at).await.unwrap_err();
        assert!(
            error
                .to_string()
                .contains("topic already resolved under release")
        );
    }
    let mut reopen = keyed("release", 2, key);
    reopen.reopen = true;
    assert_eq!(s.upsert_dossier(reopen, at).await.unwrap().revision, 3);
    s.data
        .write(s.unfollow_statement(topic.clone(), true, at))
        .await
        .unwrap();
    for mut input in [
        duplicate(),
        keyed("release", 1, key),
        keyed("release", 4, key),
    ] {
        input.reopen = true;
        let error = s.upsert_dossier(input, at).await.unwrap_err();
        assert!(error.to_string().contains(UNFOLLOWED));
    }
    assert!(
        s.data
            .write(s.resolve_statement(topic.clone(), false, at))
            .await
            .is_err()
    );
    let rows = s.list_dossiers().await.unwrap();
    assert_eq!(rows.len(), 1);
    assert!(rows[0].unfollowed);
    assert_eq!(rows[0].entity_key.as_deref(), Some(key));
    assert_eq!(
        s.get_dossier(topic).await.unwrap().unwrap().entity_key,
        rows[0].entity_key
    );
}

#[tokio::test]
async fn discovery_fired_watches_respect_resolved_and_unfollowed_topics() {
    use guards::{ScheduledWatch, WatchCheck};
    let (_dir, _root, s) = fixture().await;
    let at = UnixMillis(1);
    let topic = TopicId("contract".into());
    s.upsert_dossier(dossier("contract", DossierSignal::Green, 1., 0), at)
        .await
        .unwrap();
    let watch = |id: &str| ScheduledWatch {
        watch: WatchRecord {
            watch_id: WatchId(id.into()),
            topic_id: topic.clone(),
            kind: WatchKind::Deadline,
            target: "deadline".into(),
            predicate: json!({"trigger_at_ms":5}),
            on_trigger: WatchTrigger::NotifyDirect,
            last_state_hash: None,
            expires_at: None,
            created_at: at,
            updated_at: at,
        },
        authority: json!({}),
        interval_ms: 1,
        action_id: None,
    };
    let check = || WatchCheck {
        state_hash: "due".into(),
        matched: true,
        observed_at: UnixMillis(5),
        reason: "deadline passed".into(),
    };
    for id in ["resolved", "unfollowed"] {
        s.register_watch(watch(id), at, Default::default())
            .await
            .unwrap();
    }
    s.data
        .write(s.resolve_statement(topic.clone(), true, UnixMillis(2)))
        .await
        .unwrap();
    s.observe_watch(watch("resolved"), check(), 6)
        .await
        .unwrap();
    let closed = s.get_dossier(topic.clone()).await.unwrap().unwrap();
    assert_eq!(
        (closed.signal, closed.revision, closed.last_checked_at),
        (DossierSignal::Done, 2, at)
    );

    s.data
        .write(s.resolve_statement(topic.clone(), false, UnixMillis(3)))
        .await
        .unwrap();
    // Historical callers could set a topic back to yellow while its unfollow marker remained.
    s.data
        .write(s.mutation(false, |c, owner| {
            c.execute(
                "INSERT INTO plugin_data(package_id,scope_id,key,revision,value_json)
            VALUES(?1,?2,'unfollowed:contract',1,'true')",
                params![REVISION_PACKAGE, owner],
            )?;
            Ok(())
        }))
        .await
        .unwrap();
    s.observe_watch(watch("unfollowed"), check(), 6)
        .await
        .unwrap();
    assert!(
        s.register_watch(watch("late"), at, Default::default())
            .await
            .is_err()
    );
    let ignored = s.get_dossier(topic).await.unwrap().unwrap();
    assert_eq!((ignored.revision, ignored.last_checked_at), (3, at));
    assert!(s.latest_interrupt().await.unwrap().is_none());
}

#[tokio::test]
async fn discovery_invalidated_action_stays_stale_without_reopening_its_closed_dossier() {
    let (_dir, _root, s) = fixture().await;
    let at = UnixMillis(1);
    let topic = TopicId("annex".into());
    s.upsert_dossier(dossier("annex", DossierSignal::Yellow, 1., 0), at)
        .await
        .unwrap();
    let action: PendingActionRecord = serde_json::from_value(json!({
        "actionId":"send","topicId":"annex","connectorTool":"mail","params":{},"inputHashes":{"annex.md":"v1"},
        "idempotencyKey":"draft","status":"awaiting_confirm","expiresAt":100,"createdAt":1,"updatedAt":1
    })).unwrap();
    s.data
        .write(s.stage_action_statement(action, json!({}), json!({})))
        .await
        .unwrap();
    let watch = s
        .due_watches(WatchKind::FileHash, at, 1)
        .await
        .unwrap()
        .pop()
        .unwrap();
    s.data
        .write(s.resolve_statement(topic.clone(), true, UnixMillis(2)))
        .await
        .unwrap();
    let closed = s.get_dossier(topic.clone()).await.unwrap().unwrap();
    s.observe_watch(
        watch,
        guards::WatchCheck {
            state_hash: "v2".into(),
            matched: true,
            observed_at: UnixMillis(3),
            reason: "annex changed".into(),
        },
        4,
    )
    .await
    .unwrap();
    let pending = s
        .get_pending_action(ActionId("send".into()))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(pending.status, PendingActionStatus::Stale);
    assert_eq!(s.get_dossier(topic).await.unwrap().unwrap(), closed);
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

    let mut v3 = dossier(
        "key-rot",
        DossierSignal::Red,
        3.0,
        reopened.dossier.revision,
    );
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
    let mut v3 = dossier("etf-check", DossierSignal::Yellow, 10.0, 1);
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
    let mut v4 = dossier("etf-check", DossierSignal::Done, 10.0, 2);
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
