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
const INDEPENDENT_CELLS: &str = "WITH RECURSIVE independent(operation_id) AS (
  SELECT operation_id FROM runtime_events WHERE ?4 AND invocation_id=?1 AND sequence<=?2
    AND kind='tool_dispatched' AND json_extract(event_json,'$.fact.call.origin.kind')='code_cell'
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

async fn legacy_execution_boundary(
    connection: &mut SqliteConnection,
    invocation: &str,
    through: u64,
    boundary: Boundary,
) -> Result<(), StoreError> {
    let accepted_calls = crate::model_items::accepted_calls!();
    let pending: bool = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "{INDEPENDENT_CELLS}, {PRIVATE_SUMMARIES}, {accepted_calls}
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
            let expected = legacy_execution_boundary(db, "invocation", cut, boundary()).await;
            let actual = execution_boundary(db, "invocation", cut, boundary()).await;
            assert_eq!(
                actual.is_ok(),
                expected.is_ok(),
                "cut={cut}, high={high}, model={model}: {actual:?} vs {expected:?}"
            );
        }
    }
}

async fn compare_backfill(db: &mut SqliteConnection) {
    let mut rebuilt = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    sqlx::raw_sql(LEDGER).execute(&mut rebuilt).await.unwrap();
    let events: Vec<(i64, String, String, Option<String>, String)> = sqlx::query_as(
        "SELECT sequence,event_id,kind,operation_id,event_json FROM event_log ORDER BY sequence",
    )
    .fetch_all(&mut *db)
    .await
    .unwrap();
    for (sequence, id, kind, op, json) in events {
        sqlx::query("INSERT INTO event_log(sequence,event_id,invocation_id,kind,operation_id,event_json) VALUES(?,?,'invocation',?,?,?)")
            .bind(sequence).bind(id).bind(kind).bind(op).bind(json).execute(&mut rebuilt).await.unwrap();
    }
    sqlx::raw_sql(MIGRATION)
        .execute(&mut rebuilt)
        .await
        .unwrap();
    sqlx::raw_sql(EXECUTION_MIGRATION)
        .execute(&mut rebuilt)
        .await
        .unwrap();
    compare_cuts(&mut rebuilt).await;
    for query in [
        "SELECT json_array(invocation_id,kind,operation_id,call_id,call_name,opened_at,closed_at) FROM context_execution_work ORDER BY 1",
        "SELECT json_array(invocation_id,operation_id,requested_at,purpose,item_acceptance,observed_at,tool_observed_at,barrier_at,accepted_at,terminal_at,terminal_kind,terminal_status) FROM context_execution_steps ORDER BY 1",
        "SELECT json_array(invocation_id,operation_id,opened_at) FROM context_independent_tools ORDER BY 1",
    ] {
        let expected: Vec<String> = sqlx::query_scalar(query).fetch_all(&mut *db).await.unwrap();
        let actual: Vec<String> = sqlx::query_scalar(query)
            .fetch_all(&mut rebuilt)
            .await
            .unwrap();
        assert_eq!(
            actual, expected,
            "backfill differs from incremental append: {query}"
        );
    }
}

async fn checked(db: &mut SqliteConnection, kind: &str, op: Option<&str>, fact: Value) -> u64 {
    let at = append(db, kind, op, fact).await;
    compare_cuts(db).await;
    at
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
    compare_backfill(&mut db).await;
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
                    compare_backfill(&mut db).await;
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
            compare_backfill(&mut db).await;
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
async fn execution_backfill_rollback_and_reopen_preserve_historical_answers() {
    let directory = tempfile::tempdir().unwrap();
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(directory.path().join("execution.db"))
        .create_if_missing(true);
    let mut db = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::raw_sql(LEDGER).execute(&mut db).await.unwrap();
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
    sqlx::raw_sql(MIGRATION).execute(&mut db).await.unwrap();
    sqlx::raw_sql(EXECUTION_MIGRATION)
        .execute(&mut db)
        .await
        .unwrap();
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

#[test]
fn fixed_work_does_not_scan_completed_steps_or_failed_private_summaries() {
    use rusqlite::{Connection, StatementStatus, params};
    let mut db = Connection::open_in_memory().unwrap();
    db.execute_batch(LEDGER).unwrap();
    db.execute_batch(MIGRATION).unwrap();
    db.execute_batch(EXECUTION_MIGRATION).unwrap();
    let mut samples = Vec::new();
    let mut sequence = 0_i64;
    let mut completed = 0;
    for age in [100, 1_000, 10_000] {
        let tx = db.transaction().unwrap();
        let mut append = tx
            .prepare(
                "INSERT INTO event_log(event_id,invocation_id,kind,operation_id,event_json)
            VALUES(?1,'invocation',?2,?3,?4)",
            )
            .unwrap();
        let mut append_cost = Vec::new();
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
                sequence += 1;
                append.reset_status(StatementStatus::VmStep);
                append
                    .execute(params![
                        format!("e{sequence}"),
                        kind,
                        op,
                        json!({"invocation":{"session_id":"session"},"fact":fact}).to_string()
                    ])
                    .unwrap();
                if step == age - 1 {
                    append_cost.push(append.get_status(StatementStatus::VmStep));
                }
            }
        }
        drop(append);
        tx.commit().unwrap();
        completed = age;
        let mut costs = Vec::new();
        for cut in [sequence, sequence - 1, i64::MAX] {
            for model in [false, true] {
                let mut query = db.prepare(EXECUTION_BOUNDARY).unwrap();
                let pending: bool = query
                    .query_row(params!["invocation", cut, model], |row| row.get(0))
                    .unwrap();
                assert_eq!(pending, cut == sequence - 1 && !model);
                costs.push(query.get_status(StatementStatus::VmStep));
            }
        }
        let live: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM context_execution_work WHERE closed_at IS NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            live, 0,
            "private failed summaries must not accumulate live blockers"
        );
        samples.push((age, costs, append_cost));
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
    // Preserve the typed scope's serialized representation, as canonical append does.
    sqlx::query(
        "INSERT INTO event_log(event_id,invocation_id,kind,operation_id,event_json)
        VALUES(?,'invocation','model_requested',?,json_set(?,'$.fact.source_scope',json(?)))",
    )
    .bind(format!("request-{step}"))
    .bind(step)
    .bind(
        json!({"invocation":{"session_id":"session"},"fact":{
            "step_id":step,"purpose":purpose,"source_high_water":high}})
        .to_string(),
    )
    .bind(serde_json::to_string(scope).unwrap())
    .execute(db)
    .await
    .unwrap();
}

#[test]
fn sparse_summary_repair_does_not_walk_intervening_main_requests() {
    use crate::context::boundary::SUMMARY_ADMISSION;
    use rusqlite::{Connection, StatementStatus, params};
    let mut db = Connection::open_in_memory().unwrap();
    db.execute_batch(LEDGER).unwrap();
    // Competing production index previously won over the summary-only index.
    db.execute_batch("CREATE INDEX catalog_model_boundaries ON event_log(invocation_id,kind,sequence)
        WHERE kind='model_requested' OR kind='model_completed' OR kind='model_interrupted' OR kind='executor_started';").unwrap();
    db.execute_batch(MIGRATION).unwrap();
    db.execute_batch(EXECUTION_MIGRATION).unwrap();
    db.execute("INSERT INTO event_log(event_id,invocation_id,kind,operation_id,event_json)
        VALUES('summary','invocation','model_requested','summary',?)",[json!({"invocation":{"session_id":"session"},"fact":{"step_id":"summary","purpose":"summary","source_high_water":0}}).to_string()]).unwrap();
    db.execute("INSERT INTO event_log(event_id,invocation_id,kind,operation_id,event_json)
        VALUES('summary-done','invocation','model_completed','summary',?)",[json!({"invocation":{"session_id":"session"},"fact":{"step_id":"summary","output":{"parts":[]}}}).to_string()]).unwrap();
    let mut count = 0;
    let mut samples = Vec::new();
    for age in [100, 1_000, 10_000] {
        let tx = db.transaction().unwrap();
        let mut insert=tx.prepare("INSERT INTO event_log(event_id,invocation_id,kind,operation_id,event_json) VALUES(?,'invocation',?,?,?)").unwrap();
        for i in count..age {
            let step = format!("main-{i}");
            for (kind, fact) in [
                ("model_requested", json!({"step_id":step,"purpose":"main"})),
                (
                    "model_completed",
                    json!({"step_id":step,"output":{"parts":[]}}),
                ),
            ] {
                insert
                    .execute(params![
                        format!("{step}-{kind}"),
                        kind,
                        step,
                        json!({"invocation":{"session_id":"session"},"fact":fact}).to_string()
                    ])
                    .unwrap();
            }
        }
        drop(insert);
        tx.commit().unwrap();
        count = age;
        let mut stmt = db.prepare(SUMMARY_ADMISSION).unwrap();
        let result: (bool, i64, bool) = stmt
            .query_row(params!["invocation", 1, 2], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!(result, (false, 1, false));
        samples.push(stmt.get_status(StatementStatus::VmStep));
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
