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
use crate::turns::TurnBoundary;
use maka_agent_facts::event::Invocation;
use sqlx::Connection;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

async fn counted_op<T>(
    db: &mut SqliteConnection,
    op: impl AsyncFnOnce(&mut SqliteConnection) -> T,
) -> (T, usize) {
    let steps = Arc::new(AtomicUsize::new(0));
    let observed = steps.clone();
    db.lock_handle()
        .await
        .unwrap()
        .set_progress_handler(1, move || {
            observed.fetch_add(1, Ordering::Relaxed);
            true
        });
    let result = op(db).await;
    db.lock_handle().await.unwrap().remove_progress_handler();
    (result, steps.load(Ordering::Relaxed))
}

async fn check_after_deltas(deltas: usize) -> [usize; 6] {
    let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    // This isolates boundary validation against the real ledger indexes. Other
    // admission reducers do not participate in the executor-state lookup.
    sqlx::raw_sql(sqlx::AssertSqlSafe(crate::schema::fixture(|kind, _| {
        kind != "trigger"
    })))
    .execute(&mut db)
    .await
    .unwrap();
    let invocation = Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    let ended_event = RuntimeEvent::new(
        invocation.clone(),
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    );
    let (native, native_steps) =
        counted_op(&mut db, async |db| validate(db, &ended_event).await).await;
    native.unwrap();

    sqlx::query(
        "INSERT INTO event_log(event_id,invocation_id,kind,event_header) VALUES
         ('opened','invocation','invocation_opened',
          '{\"invocation\":{\"session_id\":\"session\",\"turn_id\":\"turn\",\"run_id\":\"run\",\"invocation_id\":\"invocation\"},\"fact\":{\"kind\":\"invocation_opened\",\"input\":{\"kind\":\"message\",\"content\":\"hi\"}}}'),
         ('started','invocation','executor_started','{}'),
         ('m1-start','invocation','executor_observed',
          '{\"fact\":{\"output\":{\"type\":\"message_start\",\"messageId\":\"m1\"}}}'),
         ('m2-start','invocation','executor_observed',
          '{\"fact\":{\"output\":{\"type\":\"message_start\",\"messageId\":\"m2\"}}}')",
    )
    .execute(&mut db)
    .await
    .unwrap();
    sqlx::query(
        "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<?1)
        INSERT INTO event_log(event_id,invocation_id,kind,event_header)
        SELECT printf('m1-delta-%08d',x),'invocation','executor_observed',
            json_object('invocation',json_object('session_id','session'),
                'fact',json_object('output',json_object('type','output_delta','messageId','m1','text','chunk')))
        FROM n
        UNION ALL
        SELECT printf('m2-think-%08d',x),'invocation','executor_observed',
            json_object('invocation',json_object('session_id','session'),
                'fact',json_object('output',json_object('type','thinking_delta','messageId','m2','text','thought')))
        FROM n",
    )
    .bind(deltas as i64)
    .execute(&mut db)
    .await
    .unwrap();

    let delta_event = RuntimeEvent::new(
        invocation.clone(),
        Fact::ExecutorObserved {
            output: Output::OutputDelta {
                message_id: "m1".into(),
                text: "more".into(),
            },
        },
    );
    let (open_delta, open_delta_steps) =
        counted_op(&mut db, async |db| validate(db, &delta_event).await).await;
    open_delta.unwrap();

    let root = TurnBoundary::for_test(invocation.clone());
    let (streams, streams_steps) = counted_op(&mut db, async |db| {
        crate::observation::streams::read(db, Some(&root)).await
    })
    .await;
    assert_eq!(streams.unwrap().len(), 4);

    let (unfinished, unfinished_steps) =
        counted_op(&mut db, async |db| validate(db, &ended_event).await).await;
    assert!(
        matches!(unfinished, Err(StoreError::InvalidTransition(ref reason))
        if reason == "executor completion requires a durable final result")
    );

    sqlx::query(
        "INSERT INTO event_log(event_id,invocation_id,kind,event_header) VALUES
         ('m1-end','invocation','executor_observed',
          '{\"fact\":{\"output\":{\"type\":\"message_end\",\"messageId\":\"m1\"}}}'),
         ('m2-end','invocation','executor_observed',
          '{\"fact\":{\"output\":{\"type\":\"message_end\",\"messageId\":\"m2\"}}}')",
    )
    .execute(&mut db)
    .await
    .unwrap();

    let completed_event = RuntimeEvent::new(
        invocation,
        Fact::ExecutorCompleted {
            message_id: Some("m1".into()),
        },
    );
    let (completed, completed_steps) =
        counted_op(&mut db, async |db| validate(db, &completed_event).await).await;
    completed.unwrap();

    sqlx::query(
        "INSERT INTO event_log(event_id,invocation_id,kind,event_header)
        VALUES('completed','invocation','executor_completed','{}')",
    )
    .execute(&mut db)
    .await
    .unwrap();
    let (finished, finished_steps) =
        counted_op(&mut db, async |db| validate(db, &ended_event).await).await;
    finished.unwrap();

    [
        native_steps,
        open_delta_steps,
        streams_steps,
        unfinished_steps,
        completed_steps,
        finished_steps,
    ]
}

#[tokio::test]
async fn executor_boundary_checks_do_not_scan_prior_output() {
    let small = check_after_deltas(256).await;
    let large = check_after_deltas(16_384).await;
    eprintln!("executor boundary VM steps: deltas256={small:?}, deltas16384={large:?}");
    for (small, large) in small.into_iter().zip(large) {
        assert!(
            small > 0 && large < small * 2,
            "64 times more prior output must not cause a boundary sweep: {small} -> {large}"
        );
    }
}
