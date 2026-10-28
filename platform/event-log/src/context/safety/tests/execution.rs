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

// Independent historical oracle: the former canonical-fact query.
// Keep this in tests to compare every cut, including before later settlements.
use super::*;

// Parameters 1/2/4 are invocation, upper cut, and whether independent work is allowed.
const INDEPENDENT_TOOLS: &str = "WITH RECURSIVE independent(operation_id) AS (
  SELECT operation_id FROM runtime_events WHERE ?4 AND invocation_id=?1 AND sequence<=?2
    AND kind='tool_dispatched' AND (
      json_extract(event_json,'$.fact.call.origin.kind')='code_cell'
      OR (json_extract(event_json,'$.fact.call.origin.kind')='host_sdk'
        AND json_extract(event_json,'$.fact.call.origin.parent_relationship.kind')='evaluation_observer'))
  UNION ALL
  SELECT child.operation_id FROM runtime_events child JOIN independent parent
    ON json_extract(child.event_json,'$.fact.call.origin.parent_operation_id')=parent.operation_id
    WHERE child.invocation_id=?1 AND child.sequence<=?2
      AND child.kind IN ('tool_dispatched','tool_rejected')
)";

// Only admitted Summary requests without tool observations are private work.
// Recovery still sees them; foreground readiness may ignore them. Parameters
// 1 and 2 are invocation identity and the historical upper cut.
pub(crate) const PRIVATE_SUMMARIES: &str = "private_summaries(operation_id) AS (
  SELECT r.operation_id FROM runtime_events r WHERE r.invocation_id=?1 AND r.sequence<=?2
    AND r.kind='model_requested' AND json_extract(r.event_json,'$.fact.purpose')='summary'
    AND NOT EXISTS(SELECT 1 FROM runtime_events o WHERE o.invocation_id=r.invocation_id
      AND json_extract(o.event_json,'$.fact.step_id')=r.operation_id AND o.kind='model_observed' AND o.sequence<=?2
      AND json_extract(o.event_json,'$.fact.event.kind') IN ('tool_call','provider_tool_result'))
)";

async fn canonical_execution_boundary(
    connection: &mut SqliteConnection,
    invocation: &str,
    through: u64,
    boundary: Boundary,
) -> Result<(), StoreError> {
    let accepted_calls = crate::model_items::accepted_calls!();
    let pending: bool = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "{INDEPENDENT_TOOLS}, {PRIVATE_SUMMARIES}, {accepted_calls}
        SELECT EXISTS(SELECT 1 FROM runtime_events e WHERE e.invocation_id = ?1 AND e.sequence <= ?2 AND (
          (e.kind = 'tool_dispatched' AND NOT EXISTS(SELECT 1 FROM runtime_events t
             WHERE t.invocation_id = e.invocation_id AND t.operation_id = e.operation_id AND t.kind = 'tool_settled' AND t.sequence <= ?2)
             AND e.operation_id NOT IN (SELECT operation_id FROM independent))
          OR (e.kind = 'model_requested'
             AND NOT (?4 AND e.operation_id IN (SELECT operation_id FROM private_summaries))
             AND NOT EXISTS(SELECT 1 FROM runtime_events t
             WHERE t.invocation_id = e.invocation_id AND t.operation_id = e.operation_id AND t.kind IN ('model_completed','model_interrupted') AND t.sequence <= ?2))
          OR (e.kind = 'model_requested' AND EXISTS(SELECT 1 FROM accepted_calls p
             WHERE p.invocation_id=e.invocation_id AND p.step_id=e.operation_id AND p.sequence <= ?2
             AND json_extract(p.call, '$.provider_executed') = 0
             AND NOT EXISTS(SELECT 1 FROM runtime_events d WHERE d.invocation_id = e.invocation_id
               AND d.operation_id = e.operation_id || ':' || json_extract(p.call, '$.id')
               AND d.kind IN ('tool_dispatched','tool_rejected') AND d.sequence <= ?2)))
          OR (e.kind = 'model_interrupted'
             AND (json_extract(e.event_json, '$.fact.status') != 'retryable_failure'
               OR (NOT EXISTS(SELECT 1 FROM runtime_events request WHERE request.invocation_id=e.invocation_id
                   AND request.operation_id=e.operation_id AND request.kind='model_requested'
                   AND json_extract(request.event_json,'$.fact.item_acceptance')=1)
                 AND EXISTS(SELECT 1 FROM runtime_events barrier WHERE barrier.invocation_id=e.invocation_id
                 AND json_extract(barrier.event_json, '$.fact.step_id')=e.operation_id
                 AND barrier.kind='model_observed' AND barrier.sequence <= ?2
                 AND (json_extract(barrier.event_json, '$.fact.event.kind') IN ('provider_tool_result','finished')
                   OR (json_extract(barrier.event_json, '$.fact.event.kind')='tool_call'
                     AND json_extract(barrier.event_json, '$.fact.event.data.provider_executed')=1)
                   OR (json_extract(barrier.event_json, '$.fact.event.data.provider_options') IS NOT NULL
                     AND json_extract(barrier.event_json, '$.fact.event.data.provider_options') != '{{}}')))))
             AND NOT ((?3 OR ?4) AND e.operation_id IN (SELECT operation_id FROM private_summaries))
             AND EXISTS(SELECT 1 FROM runtime_events o
             WHERE o.invocation_id = e.invocation_id AND json_extract(o.event_json, '$.fact.step_id') = e.operation_id
             AND o.kind = 'model_observed' AND o.sequence <= ?2))
          OR (e.kind='model_requested' AND json_extract(e.event_json,'$.fact.item_acceptance')=1
             AND EXISTS(SELECT 1 FROM accepted_calls p WHERE p.invocation_id=e.invocation_id AND p.step_id=e.operation_id
               AND p.sequence <= ?2 AND json_extract(p.call,'$.provider_executed')=1
               AND NOT EXISTS(SELECT 1 FROM runtime_events result WHERE result.invocation_id=e.invocation_id
                 AND result.kind='model_observed' AND result.sequence <= ?2
                 AND json_extract(result.event_json,'$.fact.step_id')=e.operation_id
                 AND json_extract(result.event_json,'$.fact.event.kind')='provider_tool_result'
                 AND json_extract(result.event_json,'$.fact.event.data.id')=json_extract(p.call,'$.id')
                 AND json_extract(result.event_json,'$.fact.event.data.name')=json_extract(p.call,'$.name'))))
          OR (e.kind = 'model_completed' AND EXISTS(SELECT 1 FROM json_each(e.event_json, '$.fact.output.parts') p
             WHERE json_extract(p.value, '$.kind') = 'tool_call' AND json_extract(p.value, '$.call.provider_executed') = 1
             AND NOT EXISTS(SELECT 1 FROM json_each(e.event_json, '$.fact.output.parts') result
               WHERE json_extract(result.value, '$.kind') = 'tool_result'
                 AND json_extract(result.value, '$.id') = json_extract(p.value, '$.call.id')
                 AND json_extract(result.value, '$.name') = json_extract(p.value, '$.call.name'))))))",
    ))).bind(invocation).bind(through as i64).bind(matches!(boundary,Boundary::Settled))
        .bind(matches!(boundary,Boundary::Model)).fetch_one(connection).await?;
    if pending {
        return Err(invalid(
            "active source contains unresolved model or tool work",
        ));
    }
    Ok(())
}

async fn compare_cuts(db: &mut SqliteConnection) {
    let high: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(sequence),0) FROM event_log")
        .fetch_one(&mut *db)
        .await
        .unwrap();
    for cut in (0..=high as u64).chain([i64::MAX as u64]) {
        for model in [false, true] {
            let boundary = || {
                if model {
                    Boundary::Model
                } else {
                    Boundary::Settled
                }
            };
            let expected = canonical_execution_boundary(db, "invocation", cut, boundary()).await;
            let actual = execution_boundary(db, "invocation", cut, boundary()).await;
            assert_eq!(
                actual.is_ok(),
                expected.is_ok(),
                "cut={cut}, high={high}, model={model}: {actual:?} vs {expected:?}"
            );
        }
    }
}

async fn checked(db: &mut SqliteConnection, kind: &str, op: Option<&str>, fact: Value) -> u64 {
    let at = append(db, kind, op, fact).await;
    compare_cuts(db).await;
    at
}

#[tokio::test]
async fn earlier_terminals_keep_late_openings_closed_without_rewriting_old_cuts() {
    for (terminal, terminal_fact, opening, opening_fact, operation) in [
        (
            "invocation_ended",
            json!({"outcome":{"class":"outcome_unknown"}}),
            "invocation_opened",
            json!({}),
            None,
        ),
        (
            "tool_settled",
            json!({}),
            "tool_dispatched",
            json!({}),
            Some("same"),
        ),
        (
            "model_completed",
            json!({"step_id":"same","output":{"parts":[]}}),
            "model_requested",
            json!({"step_id":"same"}),
            Some("same"),
        ),
        (
            "model_interrupted",
            json!({"step_id":"same","status":"cancelled"}),
            "model_requested",
            json!({"step_id":"same"}),
            Some("same"),
        ),
    ] {
        let mut db = database().await;
        checked(&mut db, terminal, operation, terminal_fact).await;
        checked(&mut db, opening, operation, opening_fact).await;
        let live: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM context_obligations")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(live, 0, "{terminal} must suppress a later {opening}");
    }
    let mut db = database().await;
    let terminal = ended(&mut db, "outcome_unknown").await;
    checked(&mut db, "tool_dispatched", Some("late"), json!({})).await;
    assert!(
        require_manual_message_safe(&mut db, "session", None)
            .await
            .unwrap()
    );
    assert!(matches!(
        require_safe(&mut db, "session", None).await,
        Err(StoreError::HistoryUnsettled)
    ));
    require_safe_through(&mut db, "session", None, terminal)
        .await
        .unwrap();
}

#[tokio::test]
async fn settlement_closes_only_its_obligation_kind_when_operations_share_an_id() {
    let mut db = database().await;
    append(
        &mut db,
        "model_requested",
        Some("shared"),
        json!({"step_id":"shared"}),
    )
    .await;
    append(&mut db, "tool_dispatched", Some("shared"), json!({})).await;
    append(&mut db, "tool_settled", Some("shared"), json!({})).await;
    let kinds: Vec<String> =
        sqlx::query_scalar("SELECT kind FROM context_obligations ORDER BY kind")
            .fetch_all(&mut db)
            .await
            .unwrap();
    assert_eq!(kinds, ["model"]);
    append(
        &mut db,
        "model_completed",
        Some("shared"),
        json!({"step_id":"shared","output":{"parts":[]}}),
    )
    .await;
    let live: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM context_obligations")
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(live, 0);
}

async fn request(db: &mut SqliteConnection, purpose: &str, acceptance: bool) {
    checked(
        db,
        "model_requested",
        Some("step"),
        json!({
            "step_id":"step", "purpose":purpose, "item_acceptance":acceptance
        }),
    )
    .await;
}

async fn observe(db: &mut SqliteConnection, kind: &str, data: Value) -> u64 {
    checked(
        db,
        "model_observed",
        None,
        json!({
            "step_id":"step", "event":{"kind":kind,"data":data}
        }),
    )
    .await
}

#[tokio::test]
async fn intervals_preserve_tool_call_and_independent_descendant_cuts() {
    let mut db = database().await;
    request(&mut db, "main", false).await;
    checked(
        &mut db,
        "model_completed",
        Some("step"),
        json!({"step_id":"step","output":{"parts":[
            {"kind":"tool_call","call":{"id":"local","name":"tool","provider_executed":false}},
            {"kind":"tool_call","call":{"id":"rejected","name":"tool","provider_executed":false}}
        ]}}),
    )
    .await;
    checked(
        &mut db,
        "tool_rejected",
        Some("step:rejected"),
        json!({"call":{"origin":{"kind":"standalone"}}}),
    )
    .await;
    checked(
        &mut db,
        "tool_dispatched",
        Some("step:local"),
        json!({"call":{"origin":{"kind":"provider","step_id":"step"}}}),
    )
    .await;
    checked(
        &mut db,
        "tool_dispatched",
        Some("cell"),
        json!({"call":{"origin":{"kind":"code_cell","parent_operation_id":"step:local"}}}),
    )
    .await;
    let before = checked(
        &mut db,
        "tool_dispatched",
        Some("child"),
        json!({"call":{"origin":{"kind":"host_sdk","parent_operation_id":"cell"}}}),
    )
    .await;
    checked(
        &mut db,
        "tool_rejected",
        Some("grandchild"),
        json!({"call":{"origin":{"kind":"code_mode","parent_operation_id":"child"}}}),
    )
    .await;
    checked(
        &mut db,
        "tool_dispatched",
        Some("nested-cell"),
        json!({"call":{"origin":{"kind":"code_cell","parent_operation_id":"child"}}}),
    )
    .await;
    checked(
        &mut db,
        "tool_dispatched",
        Some("leaf"),
        json!({"call":{"origin":{"kind":"host_sdk","parent_operation_id":"nested-cell"}}}),
    )
    .await;
    checked(&mut db, "tool_settled", Some("step:local"), json!({})).await;
    model_boundary(&mut db, "invocation", i64::MAX as u64)
        .await
        .unwrap();
    assert!(
        settled_boundary(&mut db, "invocation", i64::MAX as u64)
            .await
            .is_err()
    );
    checked(&mut db, "tool_settled", Some("child"), json!({})).await;
    checked(&mut db, "tool_settled", Some("leaf"), json!({})).await;
    checked(&mut db, "tool_settled", Some("nested-cell"), json!({})).await;
    checked(&mut db, "tool_settled", Some("cell"), json!({})).await;
    settled_boundary(&mut db, "invocation", i64::MAX as u64)
        .await
        .unwrap();
    assert!(model_boundary(&mut db, "invocation", before).await.is_err());
}

#[tokio::test]
async fn intervals_keep_observer_effects_pending_after_outer_settlement() {
    let mut db = database().await;
    checked(
        &mut db,
        "tool_dispatched",
        Some("outer"),
        json!({"call":{"origin":{"kind":"standalone"}}}),
    )
    .await;
    checked(
        &mut db,
        "tool_dispatched",
        Some("observer"),
        json!({"call":{"origin":{"kind":"host_sdk","parent_operation_id":"outer","parent_relationship":{"kind":"evaluation_observer","epoch":"00000000-0000-0000-0000-000000000017"}}}}),
    )
    .await;
    checked(
        &mut db,
        "tool_rejected",
        Some("rejected"),
        json!({"call":{"origin":{"kind":"host_sdk","parent_operation_id":"observer"}}}),
    )
    .await;
    checked(
        &mut db,
        "tool_dispatched",
        Some("effect"),
        json!({"call":{"origin":{"kind":"host_sdk","parent_operation_id":"observer"}}}),
    )
    .await;
    let outer_settled = checked(&mut db, "tool_settled", Some("outer"), json!({})).await;
    model_boundary(&mut db, "invocation", outer_settled)
        .await
        .unwrap();
    assert!(
        settled_boundary(&mut db, "invocation", outer_settled)
            .await
            .is_err()
    );
    checked(&mut db, "tool_settled", Some("effect"), json!({})).await;
    assert!(
        settled_boundary(&mut db, "invocation", i64::MAX as u64)
            .await
            .is_err()
    );
    checked(&mut db, "tool_settled", Some("observer"), json!({})).await;
    settled_boundary(&mut db, "invocation", i64::MAX as u64)
        .await
        .unwrap();
    assert!(
        settled_boundary(&mut db, "invocation", outer_settled)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn intervals_keep_nested_effects_blocking_model_progress() {
    let mut db = database().await;
    checked(
        &mut db,
        "tool_dispatched",
        Some("outer"),
        json!({"call":{"origin":{"kind":"standalone"}}}),
    )
    .await;
    let effect_opened = checked(
        &mut db,
        "tool_dispatched",
        Some("effect"),
        json!({"call":{"origin":{"kind":"host_sdk","parent_operation_id":"outer"}}}),
    )
    .await;
    checked(
        &mut db,
        "tool_rejected",
        Some("rejected"),
        json!({"call":{"origin":{"kind":"host_sdk","parent_operation_id":"effect","parent_relationship":{"kind":"evaluation_observer","epoch":"00000000-0000-0000-0000-000000000018"}}}}),
    )
    .await;
    let outer_settled = checked(&mut db, "tool_settled", Some("outer"), json!({})).await;
    assert!(
        model_boundary(&mut db, "invocation", outer_settled)
            .await
            .is_err()
    );
    checked(&mut db, "tool_settled", Some("effect"), json!({})).await;
    model_boundary(&mut db, "invocation", i64::MAX as u64)
        .await
        .unwrap();
    assert!(
        model_boundary(&mut db, "invocation", effect_opened)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn intervals_preserve_interrupted_observation_and_summary_privacy_cuts() {
    for purpose in ["main", "summary"] {
        for acceptance in [false, true] {
            for status in ["retryable_failure", "failed", "cancelled"] {
                for observation in [
                    None,
                    Some("part_delta"),
                    Some("finished"),
                    Some("tool_call"),
                ] {
                    let mut db = database().await;
                    request(&mut db, purpose, acceptance).await;
                    if let Some(kind) = observation {
                        let data = if kind == "tool_call" {
                            json!({"id":"call","name":"provider","provider_executed":true})
                        } else {
                            json!({})
                        };
                        observe(&mut db, kind, data).await;
                    }
                    checked(
                        &mut db,
                        "model_interrupted",
                        Some("step"),
                        json!({"step_id":"step","status":status}),
                    )
                    .await;
                    if purpose == "summary" && observation != Some("tool_call") {
                        settled_boundary(&mut db, "invocation", i64::MAX as u64)
                            .await
                            .unwrap();
                    }
                }
            }
        }
    }
}

#[tokio::test]
async fn intervals_require_exact_provider_results_and_preserve_accepted_call_cuts() {
    for acceptance in [false, true] {
        for name in ["wrong", "provider"] {
            let mut db = database().await;
            request(&mut db, "main", acceptance).await;
            let call = json!({"id":"call","name":"provider","provider_executed":true});
            observe(&mut db, "tool_call", call.clone()).await;
            observe(
                &mut db,
                "provider_tool_result",
                json!({"id":"call","name":name}),
            )
            .await;
            checked(
                &mut db,
                "model_completed",
                Some("step"),
                json!({"step_id":"step","output":{"parts":[
                    {"kind":"tool_call","call":call}, {"kind":"tool_result","id":"call","name":name}
                ]}}),
            )
            .await;
            assert_eq!(
                settled_boundary(&mut db, "invocation", i64::MAX as u64)
                    .await
                    .is_ok(),
                name == "provider"
            );
        }
    }
    let mut db = database().await;
    request(&mut db, "main", true).await;
    observe(
        &mut db,
        "tool_call",
        json!({"id":"local","name":"tool","provider_executed":false}),
    )
    .await;
    checked(&mut db, "tool_rejected", Some("step:local"), json!({})).await;
    checked(
        &mut db,
        "model_interrupted",
        Some("step"),
        json!({"step_id":"step","status":"retryable_failure"}),
    )
    .await;
    settled_boundary(&mut db, "invocation", i64::MAX as u64)
        .await
        .unwrap();
}

#[tokio::test]
async fn summary_tool_observations_remain_nonprivate_after_settlement() {
    let mut db = database().await;
    request(&mut db, "summary", false).await;
    let private_cut = observe(&mut db, "part_delta", json!({})).await;
    model_boundary(&mut db, "invocation", private_cut)
        .await
        .unwrap();
    summary_boundary(&mut db, "invocation").await.unwrap();
    observe(
        &mut db,
        "provider_tool_result",
        json!({"id":"call","name":"provider"}),
    )
    .await;
    assert!(summary_boundary(&mut db, "invocation").await.is_err());
    checked(
        &mut db,
        "model_completed",
        Some("step"),
        json!({"step_id":"step","output":{"parts":[]}}),
    )
    .await;
    settled_boundary(&mut db, "invocation", i64::MAX as u64)
        .await
        .unwrap();
    assert!(summary_boundary(&mut db, "invocation").await.is_err());
    model_boundary(&mut db, "invocation", private_cut)
        .await
        .unwrap();
}

#[tokio::test]
async fn execution_rollback_and_reopen_preserve_historical_answers() {
    let directory = tempfile::tempdir().unwrap();
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(directory.path().join("execution.db"))
        .create_if_missing(true);
    let mut db = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::raw_sql(LEDGER).execute(&mut db).await.unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(obligation_schema()))
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(execution_schema()))
        .execute(&mut db)
        .await
        .unwrap();

    append(
        &mut db,
        "model_requested",
        Some("step"),
        json!({"step_id":"step","purpose":"main","item_acceptance":true}),
    )
    .await;
    append(&mut db,"model_observed",None,json!({"step_id":"step","event":{"kind":"tool_call","data":{"id":"call","name":"provider","provider_executed":true}}})).await;
    let old_cut = append(
        &mut db,
        "model_interrupted",
        Some("step"),
        json!({"step_id":"step","status":"retryable_failure"}),
    )
    .await;
    append(
        &mut db,
        "tool_dispatched",
        Some("tool"),
        json!({"call":{"origin":{"kind":"code_cell"}}}),
    )
    .await;
    compare_cuts(&mut db).await;
    {
        let mut tx = db.begin().await.unwrap();
        checked(&mut tx, "tool_settled", Some("tool"), json!({})).await;
        tx.rollback().await.unwrap();
    }
    db.close().await.unwrap();
    let mut db = SqliteConnection::connect_with(&options).await.unwrap();
    compare_cuts(&mut db).await;
    assert!(
        settled_boundary(&mut db, "invocation", old_cut)
            .await
            .is_err()
    );
    let live: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM context_execution_work WHERE kind='tool' AND closed_at IS NULL",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(live, 1);
}

#[tokio::test]
async fn fixed_work_does_not_scan_completed_steps_or_failed_private_summaries() {
    use rusqlite::{StatementStatus, params};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let mut db = database().await;
    let mut samples = Vec::new();
    let mut completed = 0;
    for age in [100, 1_000, 10_000] {
        let steps = Arc::new(AtomicUsize::new(0));
        let observed = steps.clone();
        db.lock_handle()
            .await
            .unwrap()
            .set_progress_handler(1, move || {
                observed.fetch_add(1, Ordering::Relaxed);
                true
            });
        let mut tx = db.begin().await.unwrap();
        let seeded = crate::connection::worker_query(&mut tx, move |worker| {
            Box::pin(async move {
                let mut append_cost = Vec::new();
                let mut sequence = 0;
                for step in completed..age {
                    let main = format!("main-{step}");
                    let summary = format!("summary-{step}");
                    let tool = format!("tool-{step}");
                    for (kind, op, fact) in [
                        (
                            "model_requested",
                            Some(main.as_str()),
                            json!({"step_id":main,"purpose":"main"}),
                        ),
                        (
                            "model_completed",
                            Some(main.as_str()),
                            json!({"step_id":main,"output":{"parts":[]}}),
                        ),
                        (
                            "tool_dispatched",
                            Some(tool.as_str()),
                            json!({"call":{"tool_call_id":tool,"origin":{"kind":"standalone"}}}),
                        ),
                        ("tool_settled", Some(tool.as_str()), json!({})),
                        (
                            "model_requested",
                            Some(summary.as_str()),
                            json!({"step_id":summary,"purpose":"summary"}),
                        ),
                        (
                            "model_observed",
                            None,
                            json!({"step_id":summary,"event":{"kind":"part_delta","data":{}}}),
                        ),
                        (
                            "model_interrupted",
                            Some(summary.as_str()),
                            json!({"step_id":summary,"status":"cancelled"}),
                        ),
                    ] {
                        let fact = fixture_fact(kind, op, fact);
                        steps.store(0, Ordering::Relaxed);
                        sequence = append_worker(worker, fact).await?;
                        if step == age - 1 {
                            append_cost.push(i32::try_from(steps.load(Ordering::Relaxed)).unwrap());
                        }
                    }
                }
                Ok((sequence, append_cost))
            })
        })
        .await;
        tx.lock_handle().await.unwrap().remove_progress_handler();
        let (sequence, append_cost) = seeded.unwrap();
        tx.commit().await.unwrap();
        completed = age;
        let read = crate::connection::worker_query(&mut db, move |worker| {
            Box::pin(async move {
                // SAFETY: the callback exclusively borrows this worker. All raw queries
                // and the non-owning wrapper are dropped before returning to SQLx.
                let db =
                    unsafe { rusqlite::Connection::from_handle(worker.as_raw_handle().as_ptr()) }?;
                let mut costs = Vec::new();
                for cut in [sequence as i64, sequence as i64 - 1, i64::MAX] {
                    for model in [false, true] {
                        let mut query = db.prepare(EXECUTION_BOUNDARY)?;
                        let pending: bool =
                            query.query_row(params!["invocation", cut, model], |row| row.get(0))?;
                        assert_eq!(pending, cut == sequence as i64 - 1 && !model);
                        costs.push(query.get_status(StatementStatus::VmStep));
                    }
                }
                let live: i64 = db.query_row(
                    "SELECT COUNT(*) FROM context_execution_work WHERE closed_at IS NULL",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(
                    live, 0,
                    "private failed summaries must not accumulate live blockers"
                );
                Ok(costs)
            })
        })
        .await
        .unwrap();
        samples.push((age, read, append_cost));
    }
    eprintln!(
        "SQLite {} execution/append VM steps: {samples:?}",
        rusqlite::version()
    );
    // A hundred-fold larger completed prefix should not multiply fixed work.
    // Allow a factor of two for planner/runtime variation, not an elapsed-time cap.
    for (_, read, write) in &samples[1..] {
        for (actual, baseline) in read
            .iter()
            .zip(&samples[0].1)
            .chain(write.iter().zip(&samples[0].2))
        {
            assert!(
                *actual <= baseline * 2,
                "age-dependent VM work: {samples:?}"
            );
        }
    }
}

#[tokio::test]
async fn late_repairs_keep_cross_round_budget_and_monotone_main_progress_fence() {
    use crate::context::boundary::{admit_summary, summary_start};
    use maka_agent_facts::event::LogScope;
    let mut db = database().await;
    let scope = LogScope::Session {
        id: "session".into(),
    };
    for (step, purpose, high) in [
        ("main-a", "main", 0),
        ("summary-a", "summary", 2),
        ("main-b", "main", 0),
        ("summary-b", "summary", 6),
    ] {
        scoped_request(&mut db, step, purpose, high, &scope).await;
        append(
            &mut db,
            "model_completed",
            Some(step),
            json!({"step_id":step,"output":{"parts":[]}}),
        )
        .await;
    }
    let first = summary_start(&mut db, "invocation", &scope, 2, 9)
        .await
        .unwrap();
    assert_eq!(first, Some(3));
    assert_eq!(
        summary_start(&mut db, "invocation", &scope, 2, 3)
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        summary_start(&mut db, "invocation", &scope, 6, 9)
            .await
            .unwrap(),
        Some(7)
    );
    admit_summary(&mut db, "invocation", first, 2)
        .await
        .unwrap();
    scoped_request(&mut db, "repair-a", "summary", 2, &scope).await;
    assert!(
        admit_summary(&mut db, "invocation", Some(7), 6)
            .await
            .is_err(),
        "a private pending summary still blocks another summary"
    );
    append(
        &mut db,
        "model_completed",
        Some("repair-a"),
        json!({"step_id":"repair-a","output":{"parts":[]}}),
    )
    .await;
    assert!(
        admit_summary(&mut db, "invocation", first, 2)
            .await
            .is_err(),
        "round B counts toward old round A's three attempts"
    );
    admit_summary(&mut db, "invocation", Some(7), 6)
        .await
        .unwrap();
    assert!(
        admit_summary(&mut db, "invocation", None, 10)
            .await
            .is_err(),
        "late A repair cannot lower B's covered-main fence"
    );
    append(
        &mut db,
        "model_requested",
        Some("main-c"),
        json!({"step_id":"main-c","purpose":"main"}),
    )
    .await;
    append(
        &mut db,
        "model_completed",
        Some("main-c"),
        json!({"step_id":"main-c","output":{"parts":[]}}),
    )
    .await;
    assert!(
        admit_summary(&mut db, "invocation", None, 10)
            .await
            .is_err(),
        "later Main completion is outside the proposed source"
    );
    admit_summary(&mut db, "invocation", None, 12)
        .await
        .unwrap();
}

async fn scoped_request(
    db: &mut SqliteConnection,
    step: &str,
    purpose: &str,
    high: u64,
    scope: &maka_agent_facts::event::LogScope,
) {
    append(
        db,
        "model_requested",
        Some(step),
        json!({
            "step_id":step,"purpose":purpose,"source_high_water":high,"source_scope":scope
        }),
    )
    .await;
}

#[tokio::test]
async fn sparse_summary_repair_does_not_walk_intervening_main_requests() {
    use crate::context::boundary::SUMMARY_ADMISSION;
    use rusqlite::{StatementStatus, params};
    let mut db = database().await;
    sqlx::raw_sql("CREATE INDEX catalog_model_boundaries ON event_log(invocation_id,kind,sequence)
        WHERE kind='model_requested' OR kind='model_completed' OR kind='model_interrupted' OR kind='executor_started' OR kind='executor_completed';").execute(&mut db).await.unwrap();
    append(
        &mut db,
        "model_requested",
        Some("summary"),
        json!({"step_id":"summary","purpose":"summary","source_high_water":0}),
    )
    .await;
    append(
        &mut db,
        "model_completed",
        Some("summary"),
        json!({"step_id":"summary","output":{"parts":[]}}),
    )
    .await;
    let mut count = 0;
    let mut samples = Vec::new();
    for age in [100, 1_000, 10_000] {
        let mut tx = db.begin().await.unwrap();
        crate::connection::worker_query(&mut tx, move |worker| {
            Box::pin(async move {
                for i in count..age {
                    let step = format!("main-{i}");
                    for (kind, fact) in [
                        ("model_requested", json!({"step_id":step,"purpose":"main"})),
                        (
                            "model_completed",
                            json!({"step_id":step,"output":{"parts":[]}}),
                        ),
                    ] {
                        append_worker(worker, fixture_fact(kind, Some(&step), fact)).await?;
                    }
                }
                Ok(())
            })
        })
        .await
        .unwrap();
        tx.commit().await.unwrap();
        count = age;
        samples.push(
            crate::connection::worker_query(&mut db, move |worker| {
                Box::pin(async move {
                    // SAFETY: all queries and this non-owning wrapper stay inside the
                    // exclusive worker callback; SQLx retains the underlying connection.
                    let db = unsafe {
                        rusqlite::Connection::from_handle(worker.as_raw_handle().as_ptr())
                    }?;
                    let mut stmt = db.prepare(SUMMARY_ADMISSION)?;
                    let result: (bool, i64, bool) = stmt
                        .query_row(params!["invocation", 1, 2], |r| {
                            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                        })?;
                    assert_eq!(result, (false, 1, false));
                    Ok(stmt.get_status(StatementStatus::VmStep))
                })
            })
            .await
            .unwrap(),
        );
    }
    eprintln!(
        "SQLite {} sparse summary VM: {samples:?}",
        rusqlite::version()
    );
    assert!(
        samples.iter().all(|cost| *cost <= samples[0] * 2),
        "sparse summary ages: {samples:?}"
    );
}
