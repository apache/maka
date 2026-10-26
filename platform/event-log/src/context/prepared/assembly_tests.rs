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
use std::collections::BTreeMap;

async fn database() -> SqliteConnection {
    let mut db = SqliteConnection::connect(":memory:").await.unwrap();
    sqlx::query("ATTACH DATABASE ':memory:' AS prepared_cache")
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::raw_sql(include_str!("schema.sql"))
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::raw_sql("CREATE TEMP TABLE writes(nodes INTEGER,refs INTEGER); INSERT INTO writes VALUES(0,0);
        CREATE TEMP TRIGGER count_nodes AFTER INSERT ON prepared_cache.context_prepared_nodes BEGIN UPDATE writes SET nodes=nodes+1; END;
        CREATE TEMP TRIGGER count_refs_insert AFTER INSERT ON prepared_cache.context_prepared_refs BEGIN UPDATE writes SET refs=refs+1; END;
        CREATE TEMP TRIGGER count_refs_update AFTER UPDATE ON prepared_cache.context_prepared_refs BEGIN UPDATE writes SET refs=refs+1; END;
        CREATE TEMP TRIGGER count_refs_delete AFTER DELETE ON prepared_cache.context_prepared_refs BEGIN UPDATE writes SET refs=refs+1; END;")
        .execute(&mut db).await.unwrap();
    db
}
fn value(sequence: u64, variant: u64) -> Group {
    let messages = if variant == 99 {
        Vec::new()
    } else {
        vec![Message::user(format!("{sequence}:{variant}"))]
    };
    Group {
        wire_id: None,
        wire_bytes: 0,
        index_bytes: 0,
        dependencies: Vec::new(),
        members: vec![sequence],
        manifest: Default::default(),
        messages: messages
            .iter()
            .map(|m| MessageRef {
                id: hash(encoded(m).unwrap().as_bytes()),
                assistant: false,
                breakdown: measure::prompt_breakdown(std::slice::from_ref(m)),
            })
            .collect(),
        breakdown: measure::prompt_breakdown(&messages),
    }
}
async fn owner(db: &mut SqliteConnection, id: &str, root: Option<&str>) {
    sqlx::query("INSERT INTO context_prepared_builds(id,cache_key,selection_json,through_sequence,captured_revision,before_sequence,previous_revision,root,identity) VALUES(?,'test','{}',0,0,0,0,?,?)")
        .bind(id).bind(root).bind(id).execute(db).await.unwrap();
}
async fn stage(db: &mut SqliteConnection, id: &str, sequence: u64, variant: u64) {
    let content = tree::save_group(db, &value(sequence, variant))
        .await
        .unwrap();
    sqlx::query("INSERT INTO context_prepared_dirty(build_id,group_sequence) VALUES(?,?)")
        .bind(id)
        .bind(sequence as i64)
        .execute(&mut *db)
        .await
        .unwrap();
    assembly::stage(db, assembly::Kind::Logical, id, sequence, &content)
        .await
        .unwrap();
}
async fn finish(db: &mut SqliteConnection, id: &str) -> Option<String> {
    for _ in 0..100_000 {
        let mut tx = db.begin().await.unwrap();
        let ready = assembly::advance(&mut tx, assembly::Kind::Logical, id)
            .await
            .unwrap();
        // Deliberately collect between every chunk. Staging and unfinished
        // frame results must survive without pausing the normal collector.
        gc::collect_unreachable(&mut tx).await.unwrap();
        tx.commit().await.unwrap();
        if ready {
            return sqlx::query_scalar("SELECT root FROM context_prepared_builds WHERE id=?")
                .bind(id)
                .fetch_one(db)
                .await
                .unwrap();
        }
    }
    panic!("assembly did not finish")
}
async fn counts(db: &mut SqliteConnection) -> (i64, i64) {
    sqlx::query_as("SELECT nodes,refs FROM writes")
        .fetch_one(db)
        .await
        .unwrap()
}
async fn reset(db: &mut SqliteConnection) {
    sqlx::query("UPDATE writes SET nodes=0,refs=0")
        .execute(db)
        .await
        .unwrap();
}
async fn reference(values: &BTreeMap<u64, u64>) -> Option<String> {
    let mut db = database().await;
    let mut root = None;
    // The test-only sequential implementation is independent of assembly's
    // Cartesian links and interval clipping, including insertion rotations.
    for (&sequence, &variant) in values {
        let group = value(sequence, variant);
        let content = tree::save_group(&mut db, &group).await.unwrap();
        root = tree::insert(&mut db, root, sequence, content, group)
            .await
            .unwrap();
    }
    root
}
#[tokio::test]
async fn bulk_assembly_saves_only_final_nodes_and_reuses_sparse_warm_subtrees() {
    for n in [256u64, 2048] {
        let mut db = database().await;
        let mut values = (1..=n)
            .map(|i| (i * 4, if i % 31 == 0 { 99 } else { 0 }))
            .collect::<BTreeMap<_, _>>();
        owner(&mut db, "cold", None).await;
        for (&sequence, &variant) in &values {
            stage(&mut db, "cold", sequence, variant).await;
        }
        reset(&mut db).await;
        let cold = finish(&mut db, "cold").await;
        let (cold_nodes, cold_refs) = counts(&mut db).await;
        assert_eq!(
            cold_nodes, n as i64,
            "one actual INSERT per final cold node"
        );
        assert!(
            cold_refs <= 20 * n as i64,
            "cold refs must remain linear: {cold_refs}"
        );
        assert_eq!(cold, reference(&values).await);
        let old_totals = tree::totals(&mut db, cold.as_deref()).await.unwrap();
        owner(&mut db, "warm", cold.as_deref()).await;
        // Disjoint updates, insertion before/inside/after the base, tombstones.
        for (sequence, variant) in [(1, 0), (n * 2 + 1, 0), (n * 4 + 3, 0), (n, 7), (n * 3, 99)] {
            values.insert(sequence, variant);
            stage(&mut db, "warm", sequence, variant).await;
        }
        reset(&mut db).await;
        let warm = finish(&mut db, "warm").await;
        let (warm_nodes, warm_refs) = counts(&mut db).await;
        assert!(
            warm_nodes < 100,
            "sparse update rewrote {warm_nodes}/{n} nodes"
        );
        assert!(warm_refs < 2500, "sparse update rewrote {warm_refs} refs");
        assert_eq!(
            warm,
            reference(&values).await,
            "union must preserve canonical identity"
        );
        assert_eq!(
            tree::totals(&mut db, cold.as_deref()).await.unwrap(),
            old_totals,
            "pinned old root changed"
        );
        let mut sequences = Vec::new();
        let mut cursor = -1;
        loop {
            let page = tree::sequences(&mut db, warm.as_deref(), cursor, 64)
                .await
                .unwrap();
            if page.is_empty() {
                break;
            }
            cursor = *page.last().unwrap() as i64;
            sequences.extend(page);
        }
        assert_eq!(
            sequences,
            values.keys().copied().collect::<Vec<_>>(),
            "sequence pages must retain tombstones"
        );
        reset(&mut db).await;
        assert_eq!(finish(&mut db, "warm").await, warm);
        assert_eq!(
            counts(&mut db).await,
            (0, 0),
            "repeat finish must not touch tree refs"
        );
        owner(&mut db, "unchanged", warm.as_deref()).await;
        reset(&mut db).await;
        assert_eq!(finish(&mut db, "unchanged").await, warm);
        assert_eq!(
            counts(&mut db).await.0,
            0,
            "zero delta must reuse base root"
        );
        eprintln!(
            "assembly n={n}: cold inserts={cold_nodes} refs={cold_refs}; warm inserts={warm_nodes} refs={warm_refs}"
        );
    }
}

#[tokio::test]
async fn staging_is_write_once_and_discovery_blocks_freezing() {
    let mut db = database().await;
    owner(&mut db, "build", None).await;
    sqlx::query("UPDATE context_prepared_builds SET discovery_json='{}' WHERE id='build'")
        .execute(&mut db)
        .await
        .unwrap();
    assert!(
        assembly::advance(&mut db, assembly::Kind::Logical, "build")
            .await
            .is_err()
    );
    sqlx::query("UPDATE context_prepared_builds SET discovery_json=NULL WHERE id='build'")
        .execute(&mut db)
        .await
        .unwrap();
    stage(&mut db, "build", 4, 0).await;
    let original = tree::save_group(&mut db, &value(4, 0)).await.unwrap();
    assembly::stage(&mut db, assembly::Kind::Logical, "build", 4, &original)
        .await
        .unwrap();
    let different = tree::save_group(&mut db, &value(4, 1)).await.unwrap();
    assert!(
        assembly::stage(&mut db, assembly::Kind::Logical, "build", 4, &different)
            .await
            .is_err()
    );
    let root = finish(&mut db, "build").await;
    assert!(
        assembly::stage(&mut db, assembly::Kind::Logical, "build", 4, &different)
            .await
            .is_err()
    );
    assert_eq!(
        tree::content_id(&mut db, root.as_deref(), 4).await.unwrap(),
        original
    );
}
