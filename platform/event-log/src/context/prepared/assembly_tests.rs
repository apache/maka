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
use maka_agent_facts::model::prompt_source::WireFormat;
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
    sqlx::raw_sql("CREATE TEMP TABLE writes(nodes INTEGER,refs INTEGER); INSERT INTO writes VALUES(0,0); CREATE TEMP TABLE ref_events(kind TEXT,id TEXT);
        CREATE TEMP TRIGGER count_nodes AFTER INSERT ON prepared_cache.context_prepared_nodes BEGIN UPDATE writes SET nodes=nodes+1; END;
        CREATE TEMP TRIGGER count_refs_insert AFTER INSERT ON prepared_cache.context_prepared_refs BEGIN UPDATE writes SET refs=refs+1; INSERT INTO ref_events VALUES(NEW.kind,NEW.id); END;
        CREATE TEMP TRIGGER count_refs_update AFTER UPDATE ON prepared_cache.context_prepared_refs BEGIN UPDATE writes SET refs=refs+1; INSERT INTO ref_events VALUES(NEW.kind,NEW.id); END;
        CREATE TEMP TRIGGER count_refs_delete AFTER DELETE ON prepared_cache.context_prepared_refs BEGIN UPDATE writes SET refs=refs+1; INSERT INTO ref_events VALUES(OLD.kind,OLD.id); END;")
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
async fn stage(db: &mut SqliteConnection, id: &str, sequence: u64, variant: u64) {
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
    for _ in 0..100_000 {
        sqlx::query("DELETE FROM ref_events")
            .execute(&mut *db)
            .await
            .unwrap();
        let ready = assembly::advance(db, &mut in_flight, assembly::Kind::Logical, id)
            .await
            .unwrap();
        assert!(
            !sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM ref_events GROUP BY kind,id HAVING COUNT(*)>1)"
            )
            .fetch_one(&mut *db)
            .await
            .unwrap(),
            "a natural assembly transaction must write each ref key at most once"
        );
        super::tests::assert_refs(db).await.unwrap();
        // Deliberately collect between every chunk. Staging and unfinished
        // frame results must survive without pausing the normal collector.
        collect(db).await.unwrap();
        super::tests::assert_refs(db).await.unwrap();
        if ready {
            sqlx::query("UPDATE context_prepared_builds SET complete=1 WHERE id=?")
                .bind(id)
                .execute(&mut *db)
                .await
                .unwrap();
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
        let content = save_group(&mut db, &group).await;
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
        let values = (1..=130)
            .map(|sequence| (sequence, 0))
            .collect::<BTreeMap<_, _>>();
        owner(&mut db, "rollback", None).await;
        for &sequence in values.keys() {
            stage(&mut db, "rollback", sequence, 0).await;
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
        assert_eq!(
            root,
            reference(&values).await,
            "rollback must restore every Cartesian and merge step ({failure})"
        );
        super::tests::assert_refs(&mut db).await.unwrap();
    }
}

#[tokio::test]
async fn immutable_duplicates_and_net_zero_owner_changes_do_not_repeat_ref_writes() {
    let mut db = database().await;
    let mut tx = db.begin().await.unwrap();
    let mut refs = refs::RefBatch::default();
    sqlx::query("INSERT INTO context_prepared_payloads VALUES('wire','wire')")
        .execute(&mut *tx)
        .await
        .unwrap();
    let mut group = value(1, 0);
    group.wire_id = Some("wire".into());
    let content = tree::save_group(&mut tx, &mut refs, &group).await.unwrap();
    assert_eq!(
        tree::save_group(&mut tx, &mut refs, &group).await.unwrap(),
        content
    );
    let node = tree::compose(&mut tx, 1, content.clone(), None, None)
        .await
        .unwrap();
    let root = tree::save(&mut tx, &mut refs, &node).await.unwrap();
    assert_eq!(tree::save(&mut tx, &mut refs, &node).await.unwrap(), root);
    sqlx::query("INSERT INTO context_prepared_builds(id,cache_key,selection_json,through_sequence,captured_revision,before_sequence,previous_revision,root,identity,discovered) VALUES('dedup','fixture','{}',0,0,1,0,?,'dedup',1)").bind(&root).execute(&mut *tx).await.unwrap();
    refs.change(&mut tx, refs::Kind::Node, &root, 1)
        .await
        .unwrap();
    sqlx::query("INSERT INTO context_prepared_wire_views(id,build_id,codec,format_json,root,discovery_root) VALUES('wire-owner','dedup','fixture',?,?,?)").bind(encoded(&WireFormat::Responses).unwrap()).bind(&root).bind(&root).execute(&mut *tx).await.unwrap();
    refs.change(&mut tx, refs::Kind::Node, &root, 2)
        .await
        .unwrap();
    sqlx::query("INSERT INTO context_prepared_dirty(build_id,group_sequence) VALUES('dedup',1)")
        .execute(&mut *tx)
        .await
        .unwrap();
    for _ in 0..2 {
        assembly::stage(
            &mut tx,
            &mut refs,
            &runtime::InFlight::default(),
            assembly::Kind::Logical,
            "dedup",
            1,
            &content,
        )
        .await
        .unwrap();
    }
    refs.flush(&mut tx).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM ref_events")
            .fetch_one(&mut *tx)
            .await
            .unwrap(),
        3
    );
    super::tests::assert_refs(&mut tx).await.unwrap();
    tx.commit().await.unwrap();

    sqlx::query("DELETE FROM ref_events")
        .execute(&mut db)
        .await
        .unwrap();
    let mut tx = db.begin().await.unwrap();
    let mut refs = refs::RefBatch::default();
    assert_eq!(
        tree::save_group(&mut tx, &mut refs, &group).await.unwrap(),
        content
    );
    assert_eq!(tree::save(&mut tx, &mut refs, &node).await.unwrap(), root);
    assembly::stage(
        &mut tx,
        &mut refs,
        &runtime::InFlight::default(),
        assembly::Kind::Logical,
        "dedup",
        1,
        &content,
    )
    .await
    .unwrap();
    sqlx::query("UPDATE context_prepared_builds SET root=NULL WHERE id='dedup'")
        .execute(&mut *tx)
        .await
        .unwrap();
    refs.change(&mut tx, refs::Kind::Node, &root, -1)
        .await
        .unwrap();
    sqlx::query("UPDATE context_prepared_builds SET root=? WHERE id='dedup'")
        .bind(&root)
        .execute(&mut *tx)
        .await
        .unwrap();
    assert_eq!(
        refs.change(&mut tx, refs::Kind::Node, &root, 1)
            .await
            .unwrap(),
        3
    );
    assert!(
        refs.remove(&mut tx, refs::Kind::Node, &root).await.is_err(),
        "a pending owner must protect the node"
    );
    let transient = tree::compose(&mut tx, 2, content.clone(), None, None)
        .await
        .unwrap();
    let deleted = tree::save(&mut tx, &mut refs, &transient).await.unwrap();
    refs.remove(&mut tx, refs::Kind::Node, &deleted)
        .await
        .unwrap();
    sqlx::query("DELETE FROM context_prepared_nodes WHERE id=?")
        .bind(&deleted)
        .execute(&mut *tx)
        .await
        .unwrap();
    refs.change(&mut tx, refs::Kind::Group, &content, -1)
        .await
        .unwrap();
    refs.flush(&mut tx).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM ref_events")
            .fetch_one(&mut *tx)
            .await
            .unwrap(),
        0
    );
    assert!(
        !sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM context_prepared_refs WHERE kind='node' AND id=?)"
        )
        .bind(&deleted)
        .fetch_one(&mut *tx)
        .await
        .unwrap(),
        "a created-and-deleted object must not leave a zero ref or resurrect"
    );
    super::tests::assert_refs(&mut tx).await.unwrap();
    tx.commit().await.unwrap();
    collect(&mut db).await.unwrap();
    assert_eq!(
        tree::content_id(&mut db, Some(&root), 1).await.unwrap(),
        content
    );
    super::tests::assert_refs(&mut db).await.unwrap();
    let mut tx = db.begin().await.unwrap();
    let mut refs = refs::RefBatch::default();
    sqlx::query("UPDATE context_prepared_builds SET root=NULL WHERE id='dedup'")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE context_prepared_wire_views SET root=NULL WHERE id='wire-owner'")
        .execute(&mut *tx)
        .await
        .unwrap();
    refs.change(&mut tx, refs::Kind::Node, &root, -2)
        .await
        .unwrap();
    refs.flush(&mut tx).await.unwrap();
    tx.commit().await.unwrap();
    collect(&mut db).await.unwrap();
    assert_eq!(
        tree::content_id(&mut db, Some(&root), 1).await.unwrap(),
        content,
        "discovery ownership alone must retain the old logical tree"
    );
    super::tests::assert_refs(&mut db).await.unwrap();
    let mut tx = db.begin().await.unwrap();
    let mut refs = refs::RefBatch::default();
    sqlx::query("UPDATE context_prepared_wire_views SET discovery_root=NULL WHERE id='wire-owner'")
        .execute(&mut *tx)
        .await
        .unwrap();
    refs.change(&mut tx, refs::Kind::Node, &root, -1)
        .await
        .unwrap();
    refs.flush(&mut tx).await.unwrap();
    tx.commit().await.unwrap();
    collect(&mut db).await.unwrap();
    assert!(
        !sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM context_prepared_nodes WHERE id=?)"
        )
        .bind(&root)
        .fetch_one(&mut db)
        .await
        .unwrap()
    );
    assert_eq!(
        tree::group(&mut db, &content).await.unwrap().members,
        [1],
        "staging must keep the group after its last tree owner disappears"
    );
    super::tests::assert_refs(&mut db).await.unwrap();
}

#[tokio::test]
async fn collection_follows_pending_child_releases_without_exceeding_its_metadata_budget() {
    let mut db = database().await;
    let mut tx = db.begin().await.unwrap();
    let mut refs = refs::RefBatch::default();
    let content = tree::save_group(&mut tx, &mut refs, &value(1, 0))
        .await
        .unwrap();
    let mut root = None;
    for sequence in 1..=200 {
        let node = tree::compose(&mut tx, sequence, content.clone(), root, None)
            .await
            .unwrap();
        root = Some(tree::save(&mut tx, &mut refs, &node).await.unwrap());
    }
    refs.flush(&mut tx).await.unwrap();
    tx.commit().await.unwrap();
    super::tests::assert_refs(&mut db).await.unwrap();
    assert!(collect(&mut db).await.unwrap());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM context_prepared_nodes")
            .fetch_one(&mut db)
            .await
            .unwrap(),
        72,
        "one phase must cascade through exactly its existing 128-row budget"
    );
    super::tests::assert_refs(&mut db).await.unwrap();
    assert!(collect(&mut db).await.unwrap());
    let remaining:(i64,i64,i64)=sqlx::query_as("SELECT (SELECT COUNT(*) FROM context_prepared_nodes),(SELECT COUNT(*) FROM context_prepared_groups),(SELECT COUNT(*) FROM context_prepared_refs)").fetch_one(&mut db).await.unwrap();
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
