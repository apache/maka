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

//! Growth tests count SQLite instructions, including nested ancestry UDF SQL.
use super::*;
use sqlx::Connection;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

async fn database() -> SqliteConnection {
    let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    sqlx::raw_sql("CREATE TABLE context_source_lineages(invocation_id TEXT PRIMARY KEY,parent_invocation_id TEXT);")
        .execute(&mut db).await.unwrap();
    sqlx::raw_sql(include_str!(
        "../../../migrations/0045_context_lineage_jumps.sql"
    ))
    .execute(&mut db)
    .await
    .unwrap();
    let schema = include_str!("../../../migrations/0041_context_semantic.sql");
    sqlx::raw_sql(schema.split("CREATE TRIGGER").next().unwrap())
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../migrations/0051_semantic_lookup_indexes.sql"
    ))
    .execute(&mut db)
    .await
    .unwrap();
    {
        let mut handle = db.lock_handle().await.unwrap();
        let borrowed =
            unsafe { rusqlite::Connection::from_handle(handle.as_raw_handle().as_ptr()) }.unwrap();
        crate::context::evidence::register(&borrowed).unwrap();
    }
    db
}

async fn append_rows(db: &mut SqliteConnection, first: i64, last: i64) {
    sqlx::query("WITH RECURSIVE numbers(n) AS (SELECT ?1 UNION ALL SELECT n+1 FROM numbers WHERE n<?2)
        INSERT INTO context_semantic_rows SELECT 'session',n,0,n,n,0,'lineage-0','lineage-0',CAST(n AS TEXT),
          'user',0,0,1,0,CAST(n AS TEXT) FROM numbers")
        .bind(first).bind(last).execute(db).await.unwrap();
}

async fn count_steps(db: &mut SqliteConnection) -> Arc<AtomicU64> {
    let steps = Arc::new(AtomicU64::new(0));
    let count = steps.clone();
    db.lock_handle()
        .await
        .unwrap()
        .set_progress_handler(1, move || {
            count.fetch_add(1, Ordering::Relaxed);
            true
        });
    steps
}

async fn page(
    db: &mut SqliteConnection,
    after: i64,
    through: i64,
    anchor: Option<i64>,
    lineage: Option<String>,
) -> (Vec<String>, u64) {
    let steps = count_steps(db).await;
    let result = sqlx::query_scalar(sqlx::AssertSqlSafe(rows_query(false)))
        .bind("session")
        .bind(after)
        .bind(through)
        .bind(through)
        .bind(i64::MAX)
        .bind(lineage)
        .bind(0_i64)
        .bind(0_i64)
        .bind(0_i64)
        .bind(0_i64)
        .bind(None::<i64>)
        .bind(65_i64)
        .bind(anchor)
        .bind(None::<String>)
        .bind(true)
        .fetch_all(&mut *db)
        .await
        .unwrap();
    db.lock_handle().await.unwrap().remove_progress_handler();
    (result, steps.load(Ordering::Relaxed))
}

#[tokio::test]
async fn fixed_source_window_does_not_scan_compacted_history() {
    let mut db = database().await;
    append_rows(&mut db, 1, 128).await;
    let (small, small_steps) = page(&mut db, 112, 128, Some(1), None).await;
    assert_eq!(
        small,
        std::iter::once("1".to_owned())
            .chain((113..=128).map(|n| n.to_string()))
            .collect::<Vec<_>>()
    );
    append_rows(&mut db, 129, 16_384).await;
    // A late source can sort before the cutoff. Never equate source and order.
    sqlx::query("UPDATE context_semantic_rows SET order_sequence=2 WHERE source_sequence=16384")
        .execute(&mut db)
        .await
        .unwrap();
    let (large, large_steps) = page(&mut db, 16_368, 16_384, Some(1), None).await;
    assert_eq!(
        large,
        [
            vec!["1".into(), "16384".into()],
            (16_369..16_384).map(|n| n.to_string()).collect()
        ]
        .concat()
    );
    eprintln!("source window VM steps: H=128 {small_steps}, H=16384 {large_steps}");
    assert!(
        large_steps <= small_steps * 2,
        "fixed window scanned history: {small_steps} -> {large_steps}"
    );
    let (overlap, _) = page(&mut db, 16_368, 16_384, Some(16_369), None).await;
    assert_eq!(
        overlap.len(),
        16,
        "anchor inside window must not duplicate a row"
    );
}

async fn append_lineage(db: &mut SqliteConnection, first: i64, last: i64) {
    sqlx::query("WITH RECURSIVE numbers(n) AS (SELECT ?1 UNION ALL SELECT n+1 FROM numbers WHERE n<?2)
      INSERT INTO context_source_lineages SELECT 'lineage-'||n, CASE WHEN n=0 THEN NULL ELSE 'lineage-'||(n-1) END FROM numbers ORDER BY n")
        .bind(first).bind(last).execute(db).await.unwrap();
}

#[tokio::test]
async fn lineage_membership_grows_logarithmically_and_excludes_sibling_branches() {
    let mut db = database().await;
    append_lineage(&mut db, 0, 63).await;
    append_rows(&mut db, 1, 16).await;
    let descriptor = |depth| Some(format!(r#"{{"base":0,"run":"lineage-{depth}"}}"#));
    let (small, small_steps) = page(&mut db, 0, 16, None, descriptor(63)).await;
    append_lineage(&mut db, 64, 4095).await;
    let (large, large_steps) = page(&mut db, 0, 16, None, descriptor(4095)).await;
    assert_eq!(small, (1..=16).map(|n| n.to_string()).collect::<Vec<_>>());
    assert_eq!(large, small);
    eprintln!("lineage VM steps: D=63 {small_steps}, D=4095 {large_steps}");
    assert!(
        large_steps <= small_steps * 3,
        "lineage query enumerated ancestors: {small_steps} -> {large_steps}"
    );
    let pointers: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM context_lineage_jumps")
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert!(
        pointers < 4096 * 12,
        "must not materialize transitive closure"
    );
    sqlx::query("INSERT INTO context_source_lineages VALUES('sibling','lineage-62')")
        .execute(&mut db)
        .await
        .unwrap();
    for (selected, candidate, expected) in [
        ("lineage-4095", "lineage-0", true),
        ("lineage-4095", "lineage-63", true),
        ("lineage-63", "lineage-63", true),
        ("lineage-63", "sibling", false),
        ("sibling", "lineage-63", false),
        ("lineage-0", "lineage-4095", false),
        ("lineage-4095", "unknown", false),
    ] {
        let actual: bool = sqlx::query_scalar("SELECT context_lineage_contains(?,?)")
            .bind(selected)
            .bind(candidate)
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(actual, expected, "{selected} contains {candidate}");
    }
}

#[tokio::test]
async fn lineage_index_backfills_existing_branches_before_accepting_new_openings() {
    let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    sqlx::raw_sql("CREATE TABLE context_source_lineages(invocation_id TEXT PRIMARY KEY,parent_invocation_id TEXT);")
        .execute(&mut db).await.unwrap();
    append_lineage(&mut db, 0, 63).await;
    sqlx::query("INSERT INTO context_source_lineages VALUES('sibling','lineage-31')")
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../migrations/0045_context_lineage_jumps.sql"
    ))
    .execute(&mut db)
    .await
    .unwrap();
    append_lineage(&mut db, 64, 127).await;
    {
        let mut handle = db.lock_handle().await.unwrap();
        let borrowed =
            unsafe { rusqlite::Connection::from_handle(handle.as_raw_handle().as_ptr()) }.unwrap();
        crate::context::evidence::register(&borrowed).unwrap();
    }
    let selected: (bool, bool, bool) = sqlx::query_as(
        "SELECT
        context_lineage_contains('lineage-127','lineage-0'),
        context_lineage_contains('lineage-127','sibling'),
        context_lineage_contains('sibling','lineage-31')",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(selected, (true, false, true));
}
