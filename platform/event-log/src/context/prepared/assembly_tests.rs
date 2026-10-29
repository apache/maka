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
    sqlx::raw_sql("CREATE TEMP TABLE ref_events(kind TEXT,id TEXT);
        CREATE TEMP TRIGGER count_refs_insert AFTER INSERT ON prepared_cache.context_prepared_refs BEGIN INSERT INTO ref_events VALUES(NEW.kind,NEW.id); END;
        CREATE TEMP TRIGGER count_refs_update AFTER UPDATE ON prepared_cache.context_prepared_refs BEGIN INSERT INTO ref_events VALUES(NEW.kind,NEW.id); END;
        CREATE TEMP TRIGGER count_refs_delete AFTER DELETE ON prepared_cache.context_prepared_refs BEGIN INSERT INTO ref_events VALUES(OLD.kind,OLD.id); END;")
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
    let mut tx = db.begin().await.unwrap();
    let mut refs = refs::RefBatch::default();
    sqlx::query("INSERT INTO context_prepared_builds(id,cache_key,selection_json,through_sequence,captured_revision,before_sequence,previous_revision,root,identity,discovered) VALUES(?,'test','{}',0,0,0,0,?,?,1)")
        .bind(id).bind(root).bind(id).execute(&mut *tx).await.unwrap();
    if let Some(root) = root {
        refs.change(&mut tx, refs::Kind::Node, root, 1)
            .await
            .unwrap();
    }
    refs.flush(&mut tx).await.unwrap();
    tx.commit().await.unwrap();
}
async fn save_group(db: &mut SqliteConnection, group: &Group) -> String {
    let mut tx = db.begin().await.unwrap();
    let mut refs = refs::RefBatch::default();
    let id = tree::save_group(&mut tx, &mut refs, group).await.unwrap();
    refs.flush(&mut tx).await.unwrap();
    tx.commit().await.unwrap();
    id
}
async fn stage(db: &mut SqliteConnection, id: &str, sequence: u64, variant: u64) -> String {
    let mut tx = db.begin().await.unwrap();
    let mut refs = refs::RefBatch::default();
    let content = tree::save_group(&mut tx, &mut refs, &value(sequence, variant))
        .await
        .unwrap();
    sqlx::query("INSERT INTO context_prepared_dirty(build_id,group_sequence) VALUES(?,?)")
        .bind(id)
        .bind(sequence as i64)
        .execute(&mut *tx)
        .await
        .unwrap();
    assembly::stage(
        &mut tx,
        &mut refs,
        &runtime::InFlight::default(),
        assembly::Kind::Logical,
        id,
        sequence,
        &content,
    )
    .await
    .unwrap();
    refs.flush(&mut tx).await.unwrap();
    tx.commit().await.unwrap();
    content
}
async fn stage_existing(
    db: &mut SqliteConnection,
    id: &str,
    sequence: u64,
    content: &str,
) -> Result<(), StoreError> {
    let mut tx = db.begin().await?;
    let mut refs = refs::RefBatch::default();
    let result = assembly::stage(
        &mut tx,
        &mut refs,
        &runtime::InFlight::default(),
        assembly::Kind::Logical,
        id,
        sequence,
        content,
    )
    .await;
    match result {
        Ok(()) => {
            refs.flush(&mut tx).await?;
            tx.commit().await?;
            Ok(())
        }
        Err(error) => {
            tx.rollback().await?;
            Err(error)
        }
    }
}
async fn collect(db: &mut SqliteConnection) -> Result<bool, StoreError> {
    let mut tx = db.begin().await?;
    match gc::collect_unreachable(&mut tx).await {
        Ok(changed) => {
            tx.commit().await?;
            Ok(changed)
        }
        Err(error) => {
            tx.rollback().await?;
            Err(error)
        }
    }
}
async fn finish(db: &mut SqliteConnection, id: &str) -> Option<String> {
    let mut in_flight = runtime::InFlight::default();
    in_flight.insert(assembly::Kind::Logical, id, runtime::Generation::Rendering);
    while !assembly::advance(db, &mut in_flight, assembly::Kind::Logical, id)
        .await
        .unwrap()
    {
        collect(db).await.unwrap();
    }
    sqlx::query("UPDATE context_prepared_builds SET complete=1 WHERE id=?")
        .bind(id)
        .execute(&mut *db)
        .await
        .unwrap();
    super::tests::assert_refs(db).await.unwrap();
    sqlx::query_scalar("SELECT root FROM context_prepared_builds WHERE id=?")
        .bind(id)
        .fetch_one(db)
        .await
        .unwrap()
}

async fn assert_contents(
    db: &mut SqliteConnection,
    root: Option<&str>,
    expected: &BTreeMap<u64, String>,
) {
    let mut sequences = Vec::new();
    let mut cursor = -1;
    loop {
        let page = tree::sequences(db, root, cursor, 32).await.unwrap();
        if page.is_empty() {
            break;
        }
        cursor = *page.last().unwrap() as i64;
        sequences.extend(page);
    }
    assert_eq!(sequences, expected.keys().copied().collect::<Vec<_>>());
    for (&sequence, content) in expected {
        assert_eq!(
            &tree::content_id(db, root, sequence).await.unwrap(),
            content,
            "group {sequence}"
        );
    }
}

#[tokio::test]
async fn assembly_preserves_ordered_updates_empty_groups_and_pinned_roots() {
    let mut db = database().await;
    owner(&mut db, "cold", None).await;
    let mut original = BTreeMap::new();
    for (sequence, variant) in [(4, 0), (8, 0), (12, 99), (16, 0)] {
        original.insert(sequence, stage(&mut db, "cold", sequence, variant).await);
    }
    collect(&mut db).await.unwrap();
    let cold = finish(&mut db, "cold").await;
    assert_contents(&mut db, cold.as_deref(), &original).await;
    let old_totals = tree::totals(&mut db, cold.as_deref()).await.unwrap();
    owner(&mut db, "warm", cold.as_deref()).await;
    let mut changed = original.clone();
    for (sequence, variant) in [(1, 1), (8, 7), (14, 3), (20, 0)] {
        changed.insert(sequence, stage(&mut db, "warm", sequence, variant).await);
    }
    let warm = finish(&mut db, "warm").await;
    assert_contents(&mut db, warm.as_deref(), &changed).await;
    let mut walk = tree::GroupWalk::at(&mut db, warm.as_deref(), 1)
        .await
        .unwrap();
    let mut visible = Vec::new();
    while let Some((sequence, _, group)) = walk.next(&mut db).await.unwrap() {
        assert_eq!(group.messages.len(), 1);
        visible.push(sequence);
    }
    assert_eq!(visible, [4, 8, 14, 16, 20]);

    assert_contents(&mut db, cold.as_deref(), &original).await;
    assert_eq!(
        tree::totals(&mut db, cold.as_deref()).await.unwrap(),
        old_totals
    );
    assert_eq!(finish(&mut db, "warm").await, warm);
    owner(&mut db, "unchanged", warm.as_deref()).await;
    assert_eq!(finish(&mut db, "unchanged").await, warm);
}

#[tokio::test]
async fn staging_is_write_once_and_discovery_blocks_freezing() {
    let mut db = database().await;
    owner(&mut db, "build", None).await;
    sqlx::query("UPDATE context_prepared_builds SET discovered=0 WHERE id='build'")
        .execute(&mut db)
        .await
        .unwrap();
    assert!(
        assembly::advance(
            &mut db,
            &mut runtime::InFlight::default(),
            assembly::Kind::Logical,
            "build"
        )
        .await
        .is_err()
    );
    sqlx::query("UPDATE context_prepared_builds SET discovered=1 WHERE id='build'")
        .execute(&mut db)
        .await
        .unwrap();
    stage(&mut db, "build", 4, 0).await;
    let original = save_group(&mut db, &value(4, 0)).await;
    stage_existing(&mut db, "build", 4, &original)
        .await
        .unwrap();
    let different = save_group(&mut db, &value(4, 1)).await;
    assert!(
        stage_existing(&mut db, "build", 4, &different)
            .await
            .is_err()
    );
    let root = finish(&mut db, "build").await;
    assert!(
        stage_existing(&mut db, "build", 4, &different)
            .await
            .is_err()
    );
    assert_eq!(
        tree::content_id(&mut db, root.as_deref(), 4).await.unwrap(),
        original
    );
}

#[tokio::test]
async fn confirmed_rollback_retries_the_same_frontier_without_skipping_work() {
    for failure in ["cartesian", "nodes", "refs_insert", "refs_update"] {
        let mut db = database().await;
        owner(&mut db, "rollback", None).await;
        let mut values = BTreeMap::new();
        for sequence in 1..=130 {
            values.insert(sequence, stage(&mut db, "rollback", sequence, 0).await);
        }
        let trigger = match failure {
            "nodes" => {
                "CREATE TEMP TRIGGER injected_failure BEFORE INSERT ON prepared_cache.context_prepared_nodes WHEN (SELECT COUNT(*) FROM context_prepared_nodes)>=3 BEGIN SELECT RAISE(ABORT,'injected assembly failure'); END"
            }
            "cartesian" => {
                "CREATE TEMP TRIGGER injected_failure BEFORE UPDATE OF cart_left,cart_right ON prepared_cache.context_prepared_dirty BEGIN SELECT RAISE(ABORT,'injected assembly failure'); END"
            }
            "refs_insert" => {
                "CREATE TEMP TRIGGER injected_failure BEFORE INSERT ON prepared_cache.context_prepared_refs WHEN EXISTS(SELECT 1 FROM ref_events) BEGIN SELECT RAISE(ABORT,'injected assembly failure after a ref write'); END"
            }
            "refs_update" => {
                "CREATE TEMP TRIGGER injected_failure BEFORE UPDATE ON prepared_cache.context_prepared_refs WHEN EXISTS(SELECT 1 FROM ref_events) BEGIN SELECT RAISE(ABORT,'injected assembly failure after a ref write'); END"
            }
            _ => unreachable!(),
        };
        sqlx::raw_sql(trigger).execute(&mut db).await.unwrap();
        let mut in_flight = runtime::InFlight::default();
        in_flight.insert(
            assembly::Kind::Logical,
            "rollback",
            runtime::Generation::Rendering,
        );
        loop {
            sqlx::query("DELETE FROM ref_events")
                .execute(&mut db)
                .await
                .unwrap();
            match assembly::advance(&mut db, &mut in_flight, assembly::Kind::Logical, "rollback")
                .await
            {
                Ok(ready) => assert!(!ready, "injected failure must precede publication"),
                Err(error) => {
                    assert!(
                        error.to_string().contains("injected assembly failure"),
                        "{error}"
                    );
                    super::tests::assert_refs(&mut db).await.unwrap();
                    break;
                }
            }
        }
        sqlx::query("DROP TRIGGER injected_failure")
            .execute(&mut db)
            .await
            .unwrap();
        while !assembly::advance(&mut db, &mut in_flight, assembly::Kind::Logical, "rollback")
            .await
            .unwrap()
        {
            collect(&mut db).await.unwrap();
        }
        let root: Option<String> =
            sqlx::query_scalar("SELECT root FROM context_prepared_builds WHERE id='rollback'")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_contents(&mut db, root.as_deref(), &values).await;
        super::tests::assert_refs(&mut db).await.unwrap();
    }
}

#[tokio::test]
async fn collection_cascades_until_all_unowned_descendants_are_removed() {
    let mut db = database().await;
    let mut tx = db.begin().await.unwrap();
    let mut refs = refs::RefBatch::default();
    let content = tree::save_group(&mut tx, &mut refs, &value(1, 0))
        .await
        .unwrap();
    let mut root = None;
    for sequence in 1..=3 {
        let node = tree::compose(&mut tx, sequence, content.clone(), root, None)
            .await
            .unwrap();
        root = Some(tree::save(&mut tx, &mut refs, &node).await.unwrap());
    }
    refs.flush(&mut tx).await.unwrap();
    tx.commit().await.unwrap();
    while collect(&mut db).await.unwrap() {}
    let remaining: (i64, i64, i64) = sqlx::query_as("SELECT (SELECT COUNT(*) FROM context_prepared_nodes),(SELECT COUNT(*) FROM context_prepared_groups),(SELECT COUNT(*) FROM context_prepared_refs)")
        .fetch_one(&mut db).await.unwrap();
    assert_eq!(remaining, (0, 0, 0));
    super::tests::assert_refs(&mut db).await.unwrap();
}

#[tokio::test]
async fn failed_ref_deletion_rolls_back_the_collected_graph_before_retry() {
    let mut db = database().await;
    let mut tx = db.begin().await.unwrap();
    let mut refs = refs::RefBatch::default();
    for sequence in 1..=3 {
        tree::save_group(&mut tx, &mut refs, &value(sequence, 0))
            .await
            .unwrap();
    }
    refs.flush(&mut tx).await.unwrap();
    tx.commit().await.unwrap();
    sqlx::query("DELETE FROM ref_events")
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::raw_sql("CREATE TEMP TRIGGER injected_delete_failure BEFORE DELETE ON prepared_cache.context_prepared_refs WHEN EXISTS(SELECT 1 FROM ref_events) BEGIN SELECT RAISE(ABORT,'injected ref deletion failure after a ref write'); END;").execute(&mut db).await.unwrap();
    let mut tx = db.begin().await.unwrap();
    let error = gc::collect_unreachable(&mut tx).await.unwrap_err();
    assert!(
        error
            .to_string()
            .contains("injected ref deletion failure after a ref write")
    );
    tx.rollback().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM context_prepared_groups")
            .fetch_one(&mut db)
            .await
            .unwrap(),
        3
    );
    super::tests::assert_refs(&mut db).await.unwrap();
    sqlx::query("DROP TRIGGER injected_delete_failure")
        .execute(&mut db)
        .await
        .unwrap();
    let mut tx = db.begin().await.unwrap();
    gc::collect_unreachable(&mut tx).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM context_prepared_refs")
            .fetch_one(&mut db)
            .await
            .unwrap(),
        0
    );
    super::tests::assert_refs(&mut db).await.unwrap();
}
