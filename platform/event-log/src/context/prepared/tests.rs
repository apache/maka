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
use maka_agent_facts::{
    event::Invocation,
    history::{
        RowPosition,
        media::{MediaBinding, MediaManifest},
        semantic::{SemanticKind, SemanticRow},
    },
    model::{
        prompt::{AssistantPart, ToolOutput},
        prompt_source::{WireChunk, WireFormat, WireGroup},
    },
};
use std::collections::BTreeMap;

fn selection(through: u64) -> SemanticSelection {
    SemanticSelection {
        session: "prepared-test".into(),
        lineage: None,
        after: 0,
        through,
        before: through + 1,
        captured_through: through,
        replay: None,
        prior_unknown: false,
    }
}

pub(crate) async fn assert_refs(db: &mut SqliteConnection) -> Result<(), StoreError> {
    let expected: Vec<(String,String,i64)> = sqlx::query_as(r#"
        WITH edges(kind,id) AS (
            SELECT 'node',root FROM context_prepared_builds WHERE root IS NOT NULL
            UNION ALL SELECT 'node',root FROM context_prepared_wire_views WHERE root IS NOT NULL
            UNION ALL SELECT 'node',discovery_root FROM context_prepared_wire_views WHERE discovery_root IS NOT NULL
            UNION ALL SELECT 'node',json_extract(node_json,'$.left') FROM context_prepared_nodes WHERE json_extract(node_json,'$.left') IS NOT NULL
            UNION ALL SELECT 'node',json_extract(node_json,'$.right') FROM context_prepared_nodes WHERE json_extract(node_json,'$.right') IS NOT NULL
            UNION ALL SELECT 'group',json_extract(node_json,'$.content') FROM context_prepared_nodes WHERE json_extract(node_json,'$.content') IS NOT NULL
            UNION ALL SELECT 'group',json_extract(group_json,'$.logical_content_id') FROM context_prepared_groups WHERE json_extract(group_json,'$.logical_content_id') IS NOT NULL
            UNION ALL SELECT 'wire',json_extract(group_json,'$.wire_id') FROM context_prepared_groups WHERE json_extract(group_json,'$.wire_id') IS NOT NULL
            UNION ALL SELECT 'node',node_id FROM context_prepared_generation_nodes
            UNION ALL SELECT 'group',content FROM context_prepared_dirty WHERE content IS NOT NULL
            UNION ALL SELECT 'group',content FROM context_prepared_wire_dirty WHERE content IS NOT NULL
        ), objects(kind,id) AS (
            SELECT 'node',id FROM context_prepared_nodes
            UNION SELECT 'group',id FROM context_prepared_groups
            UNION SELECT kind,id FROM context_prepared_refs WHERE refs=0
            UNION SELECT kind,id FROM edges
        )
        SELECT objects.kind,objects.id,COUNT(edges.id) FROM objects
        LEFT JOIN edges ON edges.kind=objects.kind AND edges.id=objects.id
        GROUP BY objects.kind,objects.id ORDER BY objects.kind,objects.id
    "#).fetch_all(&mut *db).await?;
    let actual: Vec<(String, String, i64)> =
        sqlx::query_as("SELECT kind,id,refs FROM context_prepared_refs ORDER BY kind,id")
            .fetch_all(db)
            .await?;
    assert_eq!(
        actual, expected,
        "stored refs must equal actual strong incoming edges, including zero-reference objects and queued empty targets"
    );
    Ok(())
}

async fn assert_log_refs(log: &EventLog) {
    log.prepared_store()
        .unwrap()
        .read_interruptible(|db| Box::pin(async move { assert_refs(db).await }))
        .await
        .unwrap();
}

async fn store_group_fixture(db: &mut SqliteConnection, group: &Group) -> String {
    let mut tx = db.begin().await.unwrap();
    let mut refs = refs::RefBatch::default();
    let content = tree::save_group(&mut tx, &mut refs, group).await.unwrap();
    refs.flush(&mut tx).await.unwrap();
    tx.commit().await.unwrap();
    content
}

pub(crate) async fn seed_shared_wire_gc_fixture(
    db: &mut SqliteConnection,
) -> Result<(), StoreError> {
    let mut tx = db.begin().await?;
    let mut refs = refs::RefBatch::default();
    sqlx::query("INSERT INTO context_prepared_payloads VALUES('wire','wire')")
        .execute(&mut *tx)
        .await?;
    let group = Group {
        index_bytes: 0,
        dependencies: vec![],
        members: vec![1],
        manifest: Default::default(),
        messages: vec![],
        breakdown: Default::default(),
    };
    let content = tree::save_group(&mut tx, &mut refs, &group).await?;
    let (logical_id, _) = tree::logical_group(&mut tx, &content).await?;
    let wire_content = tree::save_wire_group(
        &mut tx,
        &mut refs,
        tree::WireGroup::new(logical_id, "wire".into(), 260),
    )
    .await?;
    let node = tree::compose(&mut tx, 1, content, None, None).await?;
    let root = tree::save(&mut tx, &mut refs, &node).await?;
    let wire_node = tree::compose(&mut tx, 1, wire_content, None, None).await?;
    let wire_root = tree::save(&mut tx, &mut refs, &wire_node).await?;
    for (id, session) in [("parent", "session"), ("child", "child")] {
        sqlx::query("INSERT INTO context_prepared_builds(id,identity,cache_key,selection_json,through_sequence,captured_revision,before_sequence,previous_revision,root,complete) VALUES(?1,?1,?1,?2,1,1,2,0,?3,1)")
            .bind(id).bind(serde_json::json!({"session":session}).to_string()).bind(&root).execute(&mut *tx).await?;
        refs.change(&mut tx, refs::Kind::Node, &root, 1).await?;
        let wire_id = format!("{id}-wire");
        sqlx::query("INSERT INTO context_prepared_wire_views(id,build_id,codec,format_json,root,complete,discovered) VALUES(?,?,'fixture',?,?,1,1)")
            .bind(&wire_id).bind(id).bind(encoded(&WireFormat::Responses)?).bind(&wire_root).execute(&mut *tx).await?;
        refs.change(&mut tx, refs::Kind::Node, &wire_root, 1)
            .await?;
        sqlx::query("INSERT INTO context_prepared_heads(session_id,build_id,wire_view_id,touched) VALUES(?,?,?,0)")
            .bind(session).bind(id).bind(wire_id).execute(&mut *tx).await?;
    }
    for index in 0..260 {
        sqlx::query("INSERT INTO context_prepared_chunks VALUES('wire',?,0,0,1,NULL,?)")
            .bind(index)
            .bind(vec![42u8])
            .execute(&mut *tx)
            .await?;
    }
    refs.flush(&mut tx).await?;
    assert_refs(&mut tx).await?;
    tx.commit().await?;
    Ok(())
}
/// Feed extracted semantic metadata directly: the semantic reducer has its own
/// trigger tests. These tests isolate real prepared APIs and durable storage.
async fn seed(log: &EventLog, source: u64, revision: u64, assistant: bool) {
    log.connection.run(move |connection|Box::pin(async move {
        let point=RowPosition{source_sequence:source,item_index:0};
        let kind=if assistant{SemanticKind::ImportedAssistant{payload:point}}else{SemanticKind::ImportedUser{payload:point}};
        let row=SemanticRow{id:point,revision,invocation:Invocation{session_id:"prepared-test".into(),turn_id:"turn".into(),run_id:"run".into(),invocation_id:"invocation".into()},order:point,kind};
        sqlx::query("INSERT INTO context_semantic_rows(owner_session_id,source_sequence,source_index,revision,order_sequence,order_index,invocation_id,revision_invocation,event_id,kind,archived,inherited,visible,unknown_only,row_json) VALUES('prepared-test',?,0,?,?,0,'invocation','invocation','event',?,0,0,1,0,?)")
            .bind(source as i64).bind(revision as i64).bind(source as i64).bind(if assistant{"imported_assistant"}else{"imported_user"}).bind(encoded(&row)?).execute(&mut *connection).await?;
        sqlx::query("INSERT INTO context_semantic_changes(owner_session_id,revision,source_sequence,source_index,order_sequence,order_index,invocation_id,revision_invocation,archived,inherited,deleted) VALUES('prepared-test',?,?,0,?,0,'invocation','invocation',0,0,0)")
            .bind(revision as i64).bind(source as i64).bind(source as i64).execute(connection).await?;
        Ok(())
    })).await.unwrap();
}
fn manifest() -> MediaManifest {
    MediaManifest {
        aliases: Vec::new(),
        media: vec![MediaBinding::Unavailable {
            reason: "frozen failure".into(),
        }],
    }
}

#[tokio::test]
async fn semantic_group_reads_rows_and_frozen_manifest_with_one_tree_seek() {
    use maka_agent_facts::history::semantic::Payload;

    fn row(source: u64, revision: u64) -> ResolvedRow {
        let point = RowPosition {
            source_sequence: source,
            item_index: 0,
        };
        ResolvedRow {
            row: SemanticRow {
                id: point,
                revision,
                invocation: Invocation {
                    session_id: "prepared-test".into(),
                    turn_id: "turn".into(),
                    run_id: "run".into(),
                    invocation_id: "invocation".into(),
                },
                order: point,
                kind: if source <= 3 {
                    SemanticKind::Notification {
                        call_id: format!("call-{source}"),
                        custom: false,
                        payload: point,
                    }
                } else {
                    SemanticKind::ImportedUser { payload: point }
                },
            },
            payload: Some(Payload::Text(format!("original payload {source}"))),
        }
    }
    async fn store(log: &EventLog, rows: Vec<ResolvedRow>) {
        log.connection.run(move |connection| Box::pin(async move {
            let mut tx = connection.begin().await?;
            crate::connection::worker_query(&mut tx, move |worker| Box::pin(async move {
                for resolved in rows {
                    let row = resolved.row;
                    let source = row.id.source_sequence as i64;
                    let kind = if matches!(&row.kind, SemanticKind::Notification { .. }) {
                        "notification"
                    } else {
                        "imported_user"
                    };
                    sqlx::query("INSERT INTO context_semantic_rows(owner_session_id,source_sequence,source_index,revision,order_sequence,order_index,invocation_id,revision_invocation,event_id,kind,archived,inherited,visible,unknown_only,row_json) VALUES('prepared-test',?,0,?,?,0,'invocation','invocation',?,?,0,0,1,0,?)")
                        .bind(source).bind(row.revision as i64).bind(source)
                        .bind(format!("event-{source}")).bind(kind).bind(encoded(&row)?)
                        .execute(&mut *worker).await?;
                    sqlx::query("INSERT INTO context_semantic_changes(owner_session_id,revision,source_sequence,source_index,order_sequence,order_index,invocation_id,revision_invocation,archived,inherited,deleted) VALUES('prepared-test',?,?,0,?,0,'invocation','invocation',0,0,0)")
                        .bind(row.revision as i64).bind(source).bind(source)
                        .execute(&mut *worker).await?;
                    sqlx::query("INSERT OR IGNORE INTO context_semantic_fragments VALUES(?,0,?,0)")
                        .bind(source).bind(source).execute(&mut *worker).await?;
                    sqlx::query("INSERT OR IGNORE INTO context_semantic_fragment_pieces VALUES(?,0,0,?)")
                        .bind(source).bind(serde_json::to_vec(&resolved.payload.unwrap())?)
                        .execute(&mut *worker).await?;
                }
                Ok(())
            })).await?;
            tx.commit().await?;
            Ok(())
        })).await.unwrap();
    }
    fn frozen_manifest(generation: &str, group: &str) -> MediaManifest {
        MediaManifest {
            aliases: Vec::new(),
            media: vec![MediaBinding::Unavailable {
                reason: format!("{generation} capture for group {group}"),
            }],
        }
    }
    async fn publish(log: &EventLog, through: u64, generation: &str) -> PreparedView {
        let build = log
            .prepare_model_view(selection(through), "single-semantic-read", None)
            .await
            .unwrap();
        loop {
            let groups = log.prepared_dirty_groups(&build, None, 64).await.unwrap();
            if groups.is_empty() {
                break;
            }
            for group in groups {
                // Joined followers remain dirty so they can replace an old
                // group with a zero-width tombstone. Render their actual rows.
                let messages: Vec<_> = log
                    .prepared_group_rows(&build, &group)
                    .await
                    .unwrap()
                    .into_iter()
                    .map(|resolved| {
                        let Some(Payload::Text(text)) = resolved.payload else {
                            panic!("fixture row has no text payload");
                        };
                        match resolved.row.kind {
                            SemanticKind::Notification { call_id, .. } => {
                                Message::notification(call_id, text)
                            }
                            SemanticKind::ImportedUser { .. } => Message::user(text),
                            _ => panic!("fixture row has an unexpected semantic kind"),
                        }
                    })
                    .collect();
                if matches!(group.id.as_str(), "2" | "3") {
                    assert!(
                        messages.is_empty(),
                        "joined follower {} must publish a zero-width tombstone",
                        group.id
                    );
                }
                let measured = measure::prompt_breakdown(&messages);
                log.put_prepared_group(
                    &build,
                    &group,
                    messages,
                    measured,
                    frozen_manifest(generation, &group.id),
                )
                .await
                .unwrap();
            }
        }
        log.finish_prepared(&build).await.unwrap()
    }
    fn runs(
        stats: &crate::connection::ConnectionResourceStats,
        sql: &str,
    ) -> BTreeMap<(usize, usize), i32> {
        std::iter::once(&stats.writer)
            .chain(stats.readers.iter().flatten())
            .flat_map(|connection| {
                connection.statements.iter().filter_map(move |statement| {
                    (statement.sql.as_deref() == Some(sql)).then_some((
                        (connection.connection_id, statement.statement_id),
                        statement.runs,
                    ))
                })
            })
            .collect()
    }
    fn run_delta(
        before: &crate::connection::ConnectionResourceStats,
        after: &crate::connection::ConnectionResourceStats,
        sql: &str,
    ) -> i64 {
        let before = runs(before, sql);
        let after = runs(after, sql);
        assert_eq!(
            before.keys().collect::<Vec<_>>(),
            after.keys().collect::<Vec<_>>(),
            "observe the same warmed original statements: {sql}"
        );
        after
            .into_iter()
            .map(|(key, value)| {
                let delta = value.checked_sub(before[&key]).unwrap();
                assert!(delta >= 0, "SQLite run counters must remain monotonic");
                i64::from(delta)
            })
            .sum()
    }

    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("semantic-group.sqlite"))
        .await
        .unwrap();
    // Cross the old 256-message page boundary with 257 distinct groups. The
    // three joined notifications are real semantic rows and three messages.
    let expected: Vec<_> = (1..=259).map(|source| row(source, source)).collect();
    store(&log, expected.clone()).await;
    let view = publish(&log, 259, "old").await;
    assert_eq!(view.message_count, 259);
    let mut cursor = 0;
    let mut actual = Vec::new();
    let mut groups = 0;
    while let Some(group) = log.prepared_semantic_group(&view, cursor).await.unwrap() {
        assert_eq!(group.skip, 0);
        assert_eq!(
            group.manifest,
            frozen_manifest("old", &(cursor + 1).to_string())
        );
        cursor += group.rows.len();
        actual.extend(group.rows);
        groups += 1;
    }
    assert_eq!(groups, 257);
    assert_eq!(actual, expected);
    let middle = log
        .prepared_semantic_group(&view, 1)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(middle.skip, 1);
    assert_eq!(middle.rows, expected[..3]);
    assert_eq!(middle.manifest, frozen_manifest("old", "1"));
    assert!(
        log.prepared_semantic_group(&view, 259)
            .await
            .unwrap()
            .is_none()
    );
    assert!(matches!(
        log.prepared_semantic_group(&view, 260).await,
        Err(StoreError::InvalidTransition(reason)) if reason == "invalid prepared semantic cursor"
    ));

    for (sequence, rows) in [
        (1, &expected[..3]),
        (2, &expected[..0]),
        (3, &expected[..0]),
        (259, &expected[258..]),
    ] {
        let group = PreparedGroup {
            id: sequence.to_string(),
        };
        let read = log.prepared_view_group(&view, &group).await.unwrap();
        assert_eq!(read.rows, rows, "group sequence {sequence}");
        assert_eq!(read.manifest, frozen_manifest("old", &group.id));
        assert_eq!(read.skip, 0);
    }

    // Compare actual SQLite statement runs with one standalone root seek on
    // this same frozen tree; two additional searches cannot hide in a page size.
    const NODE_SQL: &str = "SELECT node_json FROM context_prepared_nodes WHERE id=?";
    const GROUP_SQL: &str = "SELECT group_json FROM context_prepared_groups WHERE id=?";
    let root = view.root.clone();
    log.prepared_store()
        .unwrap()
        .run(move |connection, _in_flight| {
            Box::pin(async move {
                tree::seek(connection, root.as_deref(), 1).await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    let (first, second) = tokio::join!(
        log.prepared_semantic_group(&view, 1),
        log.prepared_semantic_group(&view, 1),
    );
    first.unwrap().unwrap();
    second.unwrap().unwrap();
    let before = log
        .prepared_store()
        .unwrap()
        .resource_stats()
        .await
        .unwrap();
    let root = view.root.clone();
    log.prepared_store()
        .unwrap()
        .run(move |connection, _in_flight| {
            Box::pin(async move {
                tree::seek(connection, root.as_deref(), 1).await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    let sought = log
        .prepared_store()
        .unwrap()
        .resource_stats()
        .await
        .unwrap();
    let node_reads = run_delta(&before, &sought, NODE_SQL);
    assert!(node_reads > 0);
    assert_eq!(run_delta(&before, &sought, GROUP_SQL), 1);
    let read = log
        .prepared_semantic_group(&view, 1)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(read.rows, middle.rows);
    assert_eq!(read.manifest, middle.manifest);
    let after = log
        .prepared_store()
        .unwrap()
        .resource_stats()
        .await
        .unwrap();
    let actual_node_reads = run_delta(&sought, &after, NODE_SQL);
    let actual_group_reads = run_delta(&sought, &after, GROUP_SQL);
    assert!(actual_node_reads <= node_reads);
    assert!(actual_group_reads <= 1);
    eprintln!(
        "semantic group node reads={actual_node_reads}, group reads={actual_group_reads}, one-seek baseline={node_reads}"
    );

    store(&log, vec![row(1, 260), row(260, 260)]).await;
    let next = publish(&log, 260, "new").await;
    let changed = log
        .prepared_semantic_group(&next, 1)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(changed.rows[0].row.revision, 260);
    assert_eq!(changed.manifest, frozen_manifest("new", "1"));
    let registry = log.prepared.clone();
    log.prepared_store()
        .unwrap()
        .run(move |connection, in_flight| {
            Box::pin(async move {
                while gc::maintain(connection, &registry, in_flight).await? {}
                Ok(())
            })
        })
        .await
        .unwrap();
    let original = log
        .prepared_semantic_group(&view, 1)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(original.rows, middle.rows);
    assert_eq!(original.manifest, middle.manifest);
    assert_eq!(original.skip, 1);
    let retained = log
        .prepared_view_group(&view, &PreparedGroup { id: "1".into() })
        .await
        .unwrap();
    assert_eq!(retained.rows, middle.rows);
    assert_eq!(retained.manifest, middle.manifest);
    assert_eq!(retained.skip, 0);

    store(&log, vec![row(1000, 1000)]).await;
    let sparse = publish(&log, 1000, "sparse").await;
    assert!(sparse.message_count < 1000);
    let group = PreparedGroup { id: "1000".into() };
    let sparse_read = log.prepared_view_group(&sparse, &group).await.unwrap();
    assert_eq!(sparse_read.rows, vec![row(1000, 1000)]);
    assert_eq!(sparse_read.manifest, frozen_manifest("sparse", "1000"));
    assert_eq!(sparse_read.skip, 0);
    for (id, reason) in [
        ("999", "prepared group is outside its root"),
        ("not-a-sequence", "invalid prepared group"),
    ] {
        assert!(matches!(
            log.prepared_view_group(&sparse, &PreparedGroup { id: id.into() }).await,
            Err(StoreError::InvalidTransition(actual)) if actual == reason
        ));
    }

    let root = sparse.root.clone();
    log.prepared_store()
        .unwrap()
        .run(move |connection, _in_flight| {
            Box::pin(async move {
                tree::find(connection, root.as_deref(), 1000).await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    let (first, second) = tokio::join!(
        log.prepared_view_group(&sparse, &group),
        log.prepared_view_group(&sparse, &group),
    );
    first.unwrap();
    second.unwrap();
    let before = log
        .prepared_store()
        .unwrap()
        .resource_stats()
        .await
        .unwrap();
    let root = sparse.root.clone();
    log.prepared_store()
        .unwrap()
        .run(move |connection, _in_flight| {
            Box::pin(async move {
                tree::find(connection, root.as_deref(), 1000).await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    let found = log
        .prepared_store()
        .unwrap()
        .resource_stats()
        .await
        .unwrap();
    let node_reads = run_delta(&before, &found, NODE_SQL);
    assert!(node_reads > 0);
    assert_eq!(run_delta(&before, &found, GROUP_SQL), 1);
    let read = log.prepared_view_group(&sparse, &group).await.unwrap();
    assert_eq!(read.rows, sparse_read.rows);
    assert_eq!(read.manifest, sparse_read.manifest);
    let after = log
        .prepared_store()
        .unwrap()
        .resource_stats()
        .await
        .unwrap();
    let actual_node_reads = run_delta(&found, &after, NODE_SQL);
    let actual_group_reads = run_delta(&found, &after, GROUP_SQL);
    assert!(actual_node_reads <= node_reads);
    assert_eq!(actual_group_reads, 1);
    eprintln!(
        "sequence group node reads={actual_node_reads}, group reads={actual_group_reads}, one-find baseline={node_reads}"
    );
    log.close().await.unwrap();
}
async fn render(
    log: &EventLog,
    build: &PreparedBuild,
    values: &BTreeMap<String, Vec<Message>>,
) -> usize {
    let mut rendered = 0;
    loop {
        let groups = log.prepared_dirty_groups(build, None, 3).await.unwrap();
        if groups.is_empty() {
            break;
        }
        for group in groups {
            let messages = values
                .get(&group.id)
                .cloned()
                .unwrap_or_else(|| vec![Message::user(&group.id)]);
            let measured = measure::prompt_breakdown(&messages);
            log.put_prepared_group(build, &group, messages, measured, manifest())
                .await
                .unwrap();
            rendered += 1;
        }
    }
    rendered
}
fn encoded_wire(messages: &[Message], format: WireFormat, marker: &str) -> WireGroup {
    let mut pieces = Vec::new();
    for (message_index, message) in messages.iter().enumerate() {
        let bytes = serde_json::to_vec(&(marker, message)).unwrap();
        let count = bytes.len().div_ceil(1024);
        for (index, bytes) in bytes.chunks(1024).enumerate() {
            pieces.push(Ok(WireChunk {
                bytes: bytes.to_vec(),
                item_start: index == 0,
                item_end: index + 1 == count,
                message_index,
                metadata: (index == 0).then(|| serde_json::json!({"fixture":marker})),
            }));
        }
    }
    WireGroup {
        format,
        codec: "fixture-v1".into(),
        message_count: messages.len(),
        chunks: Box::new(pieces.into_iter()),
    }
}
async fn encode(
    log: &EventLog,
    view: &PreparedView,
    format: WireFormat,
    values: &BTreeMap<String, Vec<Message>>,
) -> (PreparedWireView, usize) {
    let build = log
        .prepare_wire_view(view, format, "fixture-v1", None)
        .await
        .unwrap();
    let mut encoded = 0;
    loop {
        let groups = log
            .prepared_wire_dirty_groups(&build, None, 3)
            .await
            .unwrap();
        if groups.is_empty() {
            break;
        }
        for group in groups {
            let messages = values
                .get(&group.id)
                .cloned()
                .unwrap_or_else(|| vec![Message::user(&group.id)]);
            let wanted = dependencies::needed(&messages);
            let seed = log
                .prepared_prior_mcp_ids(view, &group, &wanted)
                .await
                .unwrap();
            let marker = if seed.is_empty() { "ordinary" } else { "mcp" };
            log.put_prepared_wire_group(&build, &group, encoded_wire(&messages, format, marker))
                .await
                .unwrap();
            encoded += 1;
        }
    }
    (log.finish_prepared_wire(&build).await.unwrap(), encoded)
}
async fn bytes(log: &EventLog, view: &PreparedWireView) -> Vec<u8> {
    let mut cursor = PreparedWireCursor::default();
    let mut all = Vec::new();
    loop {
        let page = log.prepared_wire_page(view, cursor, 2).await.unwrap();
        for chunk in page.chunks {
            all.extend(chunk.bytes);
        }
        match page.next_cursor {
            Some(next) => cursor = next,
            None => break,
        }
    }
    all
}

#[tokio::test]
async fn stable_preparation_is_delta_only_and_reopen_rebuilds_private_views() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("prepared.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    seed(&log, 1, 1, false).await;
    seed(&log, 3, 3, false).await;
    let values = BTreeMap::from([
        ("1".into(), vec![Message::user("漢字\n\"".repeat(12_000))]),
        ("3".into(), vec![Message::user("bc")]),
    ]);
    let build = log
        .prepare_model_view(selection(3), "stable-render", None)
        .await
        .unwrap();
    let concurrent = log
        .prepare_model_view(selection(3), "stable-render", None)
        .await
        .unwrap();
    let captured_groups = log
        .prepared_dirty_groups(&concurrent, None, 8)
        .await
        .unwrap();
    assert_eq!(render(&log, &build, &values).await, 2);
    let view = log.finish_prepared(&build).await.unwrap();
    // A slow concurrent renderer arriving after publication is idempotent.
    for group in captured_groups {
        let messages = values[&group.id].clone();
        let meter = measure::prompt_breakdown(&messages);
        log.put_prepared_group(&concurrent, &group, messages, meter, manifest())
            .await
            .unwrap();
    }
    assert_eq!(
        log.finish_prepared(&concurrent).await.unwrap().identity,
        view.identity
    );
    assert_eq!(
        view.breakdown,
        measure::prompt_breakdown(&values.values().flatten().cloned().collect::<Vec<_>>())
    );
    let slow_wire = log
        .prepare_wire_view(&view, WireFormat::Responses, "fixture-v1", None)
        .await
        .unwrap();
    let slow_wire_groups = log
        .prepared_wire_dirty_groups(&slow_wire, None, 8)
        .await
        .unwrap();
    let (wire, encoded) = encode(&log, &view, WireFormat::Responses, &values).await;
    assert_eq!(encoded, 2);
    for group in slow_wire_groups {
        log.put_prepared_wire_group(
            &slow_wire,
            &group,
            encoded_wire(&values[&group.id], WireFormat::Responses, "ordinary"),
        )
        .await
        .unwrap();
    }
    assert_eq!(
        log.finish_prepared_wire(&slow_wire).await.unwrap().identity,
        wire.identity
    );
    let old_bytes = bytes(&log, &wire).await;
    let retry = log
        .prepare_model_view(selection(3), "stable-render", None)
        .await
        .unwrap();
    assert_eq!(render(&log, &retry, &values).await, 0);
    let (_, encoded) = encode(&log, &view, WireFormat::Responses, &values).await;
    assert_eq!(encoded, 0);
    seed(&log, 4, 4, false).await;
    let next = log
        .prepare_model_view(selection(4), "stable-render", None)
        .await
        .unwrap();
    assert_eq!(render(&log, &next, &values).await, 1);
    let next = log.finish_prepared(&next).await.unwrap();
    assert_eq!(next.message_count, 3);
    let (next_wire, encoded) = encode(&log, &next, WireFormat::Responses, &values).await;
    assert_eq!(encoded, 1);
    assert_eq!(
        log.prepared_wire_prefix_identity(&wire, 2).await.unwrap(),
        log.prepared_wire_prefix_identity(&next_wire, 2)
            .await
            .unwrap()
    );
    assert_eq!(bytes(&log, &wire).await, old_bytes);
    let metadata = log
        .prepared_wire_metadata_page(&wire, PreparedWireCursor::default(), 1)
        .await
        .unwrap();
    let position = metadata.items[0].position;
    let seek = log
        .prepared_wire_page(
            &wire,
            PreparedWireCursor {
                message_offset: position.message_index,
                piece_index: position.piece_index,
            },
            1,
        )
        .await
        .unwrap();
    assert!(seek.chunks[0].item_start);
    let maximum: i64 = log
        .prepared_store()
        .unwrap()
        .read_interruptible(|connection| {
            Box::pin(async move {
                Ok(
                    sqlx::query_scalar("SELECT MAX(length(bytes)) FROM context_prepared_chunks")
                        .fetch_one(connection)
                        .await?,
                )
            })
        })
        .await
        .unwrap();
    assert!(maximum <= 32 * 1024);
    log.close().await.unwrap();
    let group = PreparedGroup { id: "1".into() };
    let reopened = EventLog::open(&path).await.unwrap();
    assert!(matches!(
        reopened.prepared_view_group(&view, &group).await,
        Err(StoreError::InvalidTransition(reason)) if reason == "prepared view belongs to another database owner"
    ));
    assert!(
        reopened
            .prepared_wire_page(&wire, PreparedWireCursor::default(), 1)
            .await
            .is_err()
    );
    assert!(reopened.prepared_prefix_identity(&view, 1).await.is_err());
    let retry = reopened
        .prepare_model_view(selection(3), "stable-render", None)
        .await
        .unwrap();
    assert_eq!(render(&reopened, &retry, &values).await, 2);
    let rebuilt = reopened.finish_prepared(&retry).await.unwrap();
    let (rebuilt_wire, encoded) = encode(&reopened, &rebuilt, WireFormat::Responses, &values).await;
    assert_eq!(encoded, 2);
    assert_eq!(bytes(&reopened, &rebuilt_wire).await, old_bytes);
    reopened.close().await.unwrap();
}

fn call() -> Message {
    Message::Assistant {
        content: vec![AssistantPart::ToolCall {
            tool_call_id: "mcp-id".into(),
            tool_name: "remote".into(),
            input: serde_json::json!({}).into(),
            provider_executed: Some(true),
            provider_options: Some(serde_json::json!({"anthropic":{"type":"mcp-tool-use"}})),
        }],
        provider_options: None,
    }
}
fn result() -> Message {
    Message::Assistant {
        content: vec![AssistantPart::ToolResult {
            tool_call_id: "mcp-id".into(),
            tool_name: "remote".into(),
            output: ToolOutput::Text("result".into()),
            provider_options: None,
        }],
        provider_options: None,
    }
}
#[tokio::test]
async fn changed_mcp_presence_reencodes_only_referenced_group_and_keeps_old_root() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("mcp.sqlite"))
        .await
        .unwrap();
    seed(&log, 1, 1, true).await;
    seed(&log, 3, 3, true).await;
    let mut values = BTreeMap::from([("1".into(), vec![call()]), ("3".into(), vec![result()])]);
    let build = log
        .prepare_model_view(selection(3), "anthropic-render", None)
        .await
        .unwrap();
    assert_eq!(render(&log, &build, &values).await, 2);
    let view = log.finish_prepared(&build).await.unwrap();
    assert_eq!(
        log.prepared_prior_mcp_ids(&view, &PreparedGroup { id: "3".into() }, &["mcp-id".into()])
            .await
            .unwrap(),
        vec!["mcp-id"]
    );
    let (old, encoded) = encode(&log, &view, WireFormat::Anthropic, &values).await;
    assert_eq!(encoded, 2);
    let old_bytes = bytes(&log, &old).await;
    // Change only the producer. The result's logical group stays identical,
    // but its indexed dependency presence must invalidate its wire encoding.
    seed(&log, 1, 4, true).await;
    values.insert(
        "1".into(),
        vec![Message::Assistant {
            content: vec![AssistantPart::Text {
                text: "no call".into(),
                provider_options: None,
            }],
            provider_options: None,
        }],
    );
    let next = log
        .prepare_model_view(selection(4), "anthropic-render", None)
        .await
        .unwrap();
    assert_eq!(render(&log, &next, &values).await, 1);
    let next = log.finish_prepared(&next).await.unwrap();
    let (new, encoded) = encode(&log, &next, WireFormat::Anthropic, &values).await;
    assert_eq!(encoded, 2);
    assert_ne!(new.identity, old.identity);
    assert_eq!(bytes(&log, &old).await, old_bytes);
    assert!(
        log.prepared_prior_mcp_ids(&next, &PreparedGroup { id: "3".into() }, &["mcp-id".into()])
            .await
            .unwrap()
            .is_empty()
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn out_of_order_cut_completion_never_rolls_back_the_reusable_head() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("cuts.sqlite"))
        .await
        .unwrap();
    for sequence in [1, 6, 8, 9] {
        seed(&log, sequence, sequence, false).await;
    }
    let values = BTreeMap::new();
    let base = log
        .prepare_model_view(selection(1), "policy", None)
        .await
        .unwrap();
    render(&log, &base, &values).await;
    log.finish_prepared(&base).await.unwrap();
    let low = log
        .prepare_model_view(selection(6), "policy", None)
        .await
        .unwrap();
    let high = log
        .prepare_model_view(selection(8), "policy", None)
        .await
        .unwrap();
    render(&log, &high, &values).await;
    let high_view = log.finish_prepared(&high).await.unwrap();
    render(&log, &low, &values).await;
    let low_view = log.finish_prepared(&low).await.unwrap();
    assert_eq!(low_view.message_count, 2);
    assert_eq!(high_view.message_count, 3);
    let next = log
        .prepare_model_view(selection(9), "policy", None)
        .await
        .unwrap();
    assert_eq!(next.previous_revision, 8);
    assert_eq!(render(&log, &next, &values).await, 1);
    assert_eq!(log.finish_prepared(&next).await.unwrap().message_count, 4);
    log.close().await.unwrap();
}

#[tokio::test]
async fn mcp_role_boundary_and_selection_changes_bind_cached_wire_context() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("boundary.sqlite"))
        .await
        .unwrap();
    seed(&log, 1, 1, true).await;
    seed(&log, 2, 2, false).await;
    seed(&log, 3, 3, true).await;
    let mut values = BTreeMap::from([
        ("1".into(), vec![call()]),
        ("2".into(), vec![Message::user("boundary")]),
        ("3".into(), vec![result()]),
    ]);
    let build = log
        .prepare_model_view(selection(3), "anthropic", None)
        .await
        .unwrap();
    render(&log, &build, &values).await;
    let original = log.finish_prepared(&build).await.unwrap();
    let (original_wire, _) = encode(&log, &original, WireFormat::Anthropic, &values).await;
    let original_bytes = bytes(&log, &original_wire).await;
    seed(&log, 2, 4, true).await;
    values.insert(
        "2".into(),
        vec![Message::Assistant {
            content: vec![AssistantPart::Text {
                text: "assistant continuation".into(),
                provider_options: None,
            }],
            provider_options: None,
        }],
    );
    let build = log
        .prepare_model_view(selection(4), "anthropic", None)
        .await
        .unwrap();
    assert_eq!(render(&log, &build, &values).await, 1);
    let joined = log.finish_prepared(&build).await.unwrap();
    let (_, encoded) = encode(&log, &joined, WireFormat::Anthropic, &values).await;
    assert_eq!(encoded, 2);
    assert_eq!(
        log.prepared_prior_mcp_ids(
            &joined,
            &PreparedGroup { id: "3".into() },
            &["mcp-id".into()]
        )
        .await
        .unwrap(),
        vec!["mcp-id"]
    );
    // A checkpoint drops the producer but reuses the identical result group.
    // The cached result must be selected by empty prior-presence context.
    let mut cut = selection(4);
    cut.after = 1;
    let build = log
        .prepare_model_view(cut, "anthropic", None)
        .await
        .unwrap();
    assert_eq!(render(&log, &build, &values).await, 2);
    let cut = log.finish_prepared(&build).await.unwrap();
    assert!(
        log.prepared_prior_mcp_ids(&cut, &PreparedGroup { id: "3".into() }, &["mcp-id".into()])
            .await
            .unwrap()
            .is_empty()
    );
    let (cut_wire, encoded) = encode(&log, &cut, WireFormat::Anthropic, &values).await;
    assert_eq!(encoded, 2);
    assert!(
        !String::from_utf8(bytes(&log, &cut_wire).await)
            .unwrap()
            .contains("[\"mcp\",")
    );
    assert_eq!(bytes(&log, &original_wire).await, original_bytes);
    log.close().await.unwrap();
}

#[tokio::test]
async fn selected_group_members_seek_the_cluster_in_a_large_build() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    sqlx::query("ATTACH ':memory:' AS prepared_cache")
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::raw_sql(include_str!("schema.sql"))
        .execute(&mut db)
        .await
        .unwrap();
    let steps = Arc::new(AtomicUsize::new(0));
    let mut baseline = None;
    for (start, end) in [(1_i64, 1000_i64), (1001, 10_000)] {
        sqlx::query("WITH RECURSIVE rows(n) AS (VALUES(?1) UNION ALL SELECT n+1 FROM rows WHERE n<?2) INSERT INTO context_prepared_dirty(build_id,group_sequence,done,leader_sequence) SELECT 'large',n,0,CASE WHEN n=78 THEN 77 ELSE NULL END FROM rows")
            .bind(start).bind(end).execute(&mut db).await.unwrap();
        // Statement preparation must not enter only the first measurement.
        let _warm = members(&mut db, "large", 77).await.unwrap();
        let counter = steps.clone();
        db.lock_handle()
            .await
            .unwrap()
            .set_progress_handler(1, move || {
                counter.fetch_add(1, Ordering::Relaxed);
                true
            });
        steps.store(0, Ordering::Relaxed);
        let selected = members(&mut db, "large", 77).await.unwrap();
        db.lock_handle().await.unwrap().remove_progress_handler();
        let current = steps.load(Ordering::Relaxed);
        assert_eq!(selected, vec![77, 78]);
        if let Some(previous) = baseline {
            assert_eq!(current, previous, "cluster lookup scanned unrelated groups");
        } else {
            baseline = Some(current);
        }
        let last = u64::try_from(end).unwrap();
        assert_eq!(members(&mut db, "large", last).await.unwrap(), vec![last]);
    }
}

#[tokio::test]
async fn bounded_worker_wire_pages_preserve_midgroup_pieces_and_metadata_only_items() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("worker-pages.sqlite"))
        .await
        .unwrap();
    for sequence in 1..=3 {
        seed(&log, sequence, sequence, false).await;
    }
    let values = BTreeMap::from([
        (
            "1".into(),
            vec![
                Message::user("first"),
                Message::user("second"),
                Message::user("third"),
            ],
        ),
        ("2".into(), Vec::new()),
        ("3".into(), vec![Message::user("last")]),
    ]);
    let build = log
        .prepare_model_view(selection(3), "worker-pages", None)
        .await
        .unwrap();
    assert_eq!(render(&log, &build, &values).await, 3);
    let view = log.finish_prepared(&build).await.unwrap();
    let build = log
        .prepare_wire_view(&view, WireFormat::Responses, "worker-pages", None)
        .await
        .unwrap();
    let records = vec![
        (
            b"zero".to_vec(),
            true,
            true,
            0,
            Some(serde_json::json!({"item":"a"})),
        ),
        (
            b"ab".to_vec(),
            true,
            false,
            1,
            Some(serde_json::json!({"item":"b"})),
        ),
        (b"cd".to_vec(), false, false, 1, None),
        (Vec::new(), false, true, 1, None),
        (
            Vec::new(),
            true,
            true,
            2,
            Some(serde_json::json!({"item":"c"})),
        ),
        (
            b"ef".to_vec(),
            true,
            true,
            2,
            Some(serde_json::json!({"item":"d"})),
        ),
    ];
    for group in log
        .prepared_wire_dirty_groups(&build, None, 8)
        .await
        .unwrap()
    {
        let records = if group.id == "1" {
            records.clone()
        } else {
            vec![(
                b"tail".to_vec(),
                true,
                true,
                0,
                Some(serde_json::json!({"item":"e"})),
            )]
        };
        let message_count = values[&group.id].len();
        let chunks =
            records
                .into_iter()
                .map(|(bytes, item_start, item_end, message_index, metadata)| {
                    Ok(WireChunk {
                        bytes,
                        item_start,
                        item_end,
                        message_index,
                        metadata,
                    })
                });
        log.put_prepared_wire_group(
            &build,
            &group,
            WireGroup {
                format: WireFormat::Responses,
                codec: "worker-pages".into(),
                message_count,
                chunks: Box::new(chunks),
            },
        )
        .await
        .unwrap();
    }
    let wire = log.finish_prepared_wire(&build).await.unwrap();
    let mut expected = records;
    expected.push((
        b"tail".to_vec(),
        true,
        true,
        3,
        Some(serde_json::json!({"item":"e"})),
    ));
    for limit in [1, 2, 3, 128] {
        for (message_offset, piece_index, skip) in [
            (0, 0, 0),
            (1, 0, 1),
            (1, 2, 2),
            (2, 0, 4),
            (3, 0, 6),
            (4, 0, 7),
        ] {
            let mut position = Some(PreparedWireCursor {
                message_offset,
                piece_index,
            });
            let mut actual = Vec::new();
            while let Some(cursor) = position {
                let page = log.prepared_wire_page(&wire, cursor, limit).await.unwrap();
                assert!(page.chunks.len() <= limit);
                assert!(
                    page.chunks
                        .iter()
                        .map(|chunk| chunk.bytes.len())
                        .sum::<usize>()
                        <= limit * 32 * 1024
                );
                actual.extend(page.chunks.into_iter().map(|chunk| {
                    (
                        chunk.bytes,
                        chunk.item_start,
                        chunk.item_end,
                        chunk.message_index,
                        chunk.metadata,
                    )
                }));
                position = page.next_cursor;
            }
            assert_eq!(
                actual,
                expected[skip..],
                "limit {limit}, offset {message_offset}, piece {piece_index}"
            );
        }
    }
    let mut cursor = Some(PreparedWireCursor::default());
    let mut metadata = Vec::new();
    while let Some(position) = cursor {
        let page = log
            .prepared_wire_metadata_page(&wire, position, 1)
            .await
            .unwrap();
        assert!(page.items.len() <= 1);
        for item in page.items {
            let body = log
                .prepared_wire_page(
                    &wire,
                    PreparedWireCursor {
                        message_offset: item.position.message_index,
                        piece_index: item.position.piece_index,
                    },
                    1,
                )
                .await
                .unwrap();
            assert!(body.chunks[0].item_start);
            assert_eq!(body.chunks[0].metadata.as_ref(), Some(&item.metadata));
            metadata.push((item.message_index, item.metadata));
        }
        cursor = page.next_cursor;
    }
    assert_eq!(
        metadata,
        expected
            .iter()
            .filter_map(|entry| entry.4.clone().map(|metadata| (entry.3, metadata)))
            .collect::<Vec<_>>()
    );
    log.close().await.unwrap();
}

#[path = "lifetime_tests.rs"]
mod lifetimes;

#[tokio::test]
async fn entirely_empty_wire_finishes_without_encoding_and_releases_its_envelopes() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("empty-wire.sqlite"))
        .await
        .unwrap();
    for source in 1..=3 {
        seed(&log, source, source, false).await;
    }
    let values = (1..=3)
        .map(|source| (source.to_string(), Vec::<Message>::new()))
        .collect::<BTreeMap<_, _>>();
    let logical = log
        .prepare_model_view(selection(3), "empty-wire", None)
        .await
        .unwrap();
    assert_eq!(render(&log, &logical, &values).await, 3);
    let view = log.finish_prepared(&logical).await.unwrap();
    assert_eq!(view.message_count, 0);
    let build = log
        .prepare_wire_view(&view, WireFormat::Responses, "fixture-v1", None)
        .await
        .unwrap();
    assert!(
        log.prepared_wire_dirty_groups(&build, None, 8)
            .await
            .unwrap()
            .is_empty(),
        "empty groups must not require an encoder invocation"
    );
    let wire = log.finish_prepared_wire(&build).await.unwrap();
    assert_eq!(wire.message_count, 0);
    let page = log
        .prepared_wire_page(&wire, PreparedWireCursor::default(), 1)
        .await
        .unwrap();
    assert!(page.chunks.is_empty() && page.next_cursor.is_none());
    let metadata = log
        .prepared_wire_metadata_page(&wire, PreparedWireCursor::default(), 1)
        .await
        .unwrap();
    assert!(metadata.items.is_empty() && metadata.next_cursor.is_none());
    let prefix = log.prepared_wire_prefix_identity(&wire, 0).await.unwrap();
    assert_eq!(
        log.finish_prepared_wire(&build).await.unwrap().identity,
        wire.identity
    );
    assert_eq!(
        log.prepared_wire_prefix_identity(&wire, 0).await.unwrap(),
        prefix
    );
    log.prepared_store()
        .unwrap()
        .run(|db, _| Box::pin(async move { gc::retire_owner(db, "prepared-test").await }))
        .await
        .unwrap();
    assert!(
        log.prepared_wire_page(&wire, PreparedWireCursor::default(), 1)
            .await
            .unwrap()
            .chunks
            .is_empty()
    );
    assert_log_refs(&log).await;
    drop((wire, build, view, logical));
    lifetimes::drain(&log).await;
    log.prepared_store().unwrap().read_interruptible(|db|Box::pin(async move {
        let remaining:(i64,i64,i64,i64,i64)=sqlx::query_as("SELECT (SELECT COUNT(*) FROM context_prepared_builds),(SELECT COUNT(*) FROM context_prepared_wire_views),(SELECT COUNT(*) FROM context_prepared_nodes),(SELECT COUNT(*) FROM context_prepared_groups),(SELECT COUNT(*) FROM context_prepared_refs)").fetch_one(db).await?;
        assert_eq!(remaining,(0,0,0,0,0));
        Ok(())
    })).await.unwrap();
    log.close().await.unwrap();
}

#[tokio::test]
async fn paged_discovery_and_concurrent_finish_share_one_frozen_generation() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("events.sqlite"))
        .await
        .unwrap();
    for sequence in 1..=130 {
        seed(&log, sequence, sequence, false).await;
    }
    let (a, b) = tokio::join!(
        log.prepare_model_view(selection(130), "paged", None),
        log.prepare_model_view(selection(130), "paged", None)
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_eq!(a.id, b.id);
    assert_log_refs(&log).await;
    let values = BTreeMap::from([("7".into(), Vec::new()), ("65".into(), Vec::new())]);
    assert_eq!(render(&log, &a, &values).await, 130);
    let (first, second) = tokio::join!(log.finish_prepared(&a), log.finish_prepared(&b));
    let first = first.unwrap();
    let second = second.unwrap();
    assert_eq!(first.identity, second.identity);
    assert_eq!(first.message_count, 128);
    let (a, b) = tokio::join!(
        log.prepare_wire_view(&first, WireFormat::Responses, "fixture-v1", None),
        log.prepare_wire_view(&second, WireFormat::Responses, "fixture-v1", None)
    );
    let a = a.unwrap();
    let b = b.unwrap();
    let (wire, count) = encode(&log, &first, WireFormat::Responses, &values).await;
    assert_log_refs(&log).await;
    assert_eq!(count, 128, "empty groups are staged during discovery");
    let (one, two) = tokio::join!(log.finish_prepared_wire(&a), log.finish_prepared_wire(&b));
    let one = one.unwrap();
    let two = two.unwrap();
    assert_eq!(one.identity, wire.identity);
    assert_eq!(two.identity, wire.identity);
    assert_eq!(bytes(&log, &one).await, bytes(&log, &two).await);
    // Cold wire discovery must include both zero-width nodes, even though they
    // are absent from message-offset pages and require no encoder invocation.
    let id = a.id.clone();
    let staged:i64=log.prepared_store().unwrap().run(move |db, _in_flight|Box::pin(async move {Ok(sqlx::query_scalar("SELECT COUNT(*) FROM context_prepared_wire_dirty WHERE view_id=? AND content IS NOT NULL").bind(id).fetch_one(db).await?)})).await.unwrap();
    assert_eq!(staged, 130);
    assert_log_refs(&log).await;
    log.close().await.unwrap();
}

#[tokio::test]
async fn discovery_source_keysets_do_linear_work_and_skip_old_history() {
    use std::sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    };
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("events.sqlite"))
        .await
        .unwrap();
    let measured=log.connection.run(|db|Box::pin(async move {
        // Only metadata queries run here; payload/rendering is deliberately not
        // part of the VM budget. Many old rows precede the narrow window.
        sqlx::query("WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<40000)
            INSERT INTO context_semantic_rows SELECT 'prepared-test',n,0,n,n,0,'invocation','invocation',CAST(n AS TEXT),'assistant_part',0,0,1,0,'{}' FROM numbers")
            .execute(&mut *db).await?;
        let mut measured=Vec::new();
        for (after,through) in [(0u64,1024u64),(0,8192),(30000,31024)] {
            let mut next=selection(through);next.after=after;
            let steps=Arc::new(AtomicU64::new(0));let observed=steps.clone();
            db.lock_handle().await?.set_progress_handler(1,move ||{observed.fetch_add(1,Ordering::Relaxed);true});
            let mut cursor=None;let mut seen=0;
            loop {let page=semantic::initial_groups(db,&next,cursor,64).await?;seen+=page.groups.len();cursor=page.next;if cursor.is_none(){break;}}
            db.lock_handle().await?.remove_progress_handler();
            assert_eq!(seen,(through-after) as usize);
            measured.push(steps.load(Ordering::Relaxed));
            let mut previous=next.clone();previous.replay=None;
            next.replay=Some(semantic::SemanticReplay{base:0,current:"invocation".into(),route:"route".into(),model:"model".into()});
            let steps=Arc::new(AtomicU64::new(0));let observed=steps.clone();
            db.lock_handle().await?.set_progress_handler(1,move ||{observed.fetch_add(1,Ordering::Relaxed);true});
            let mut cursor=None;let mut seen=0;
            loop {let page=semantic::selection_dirty_groups(db,&previous,&next,0,cursor,64).await?;seen+=page.groups.len();cursor=page.next;if cursor.is_none(){break;}}
            db.lock_handle().await?.remove_progress_handler();
            assert_eq!(seen,(through-after) as usize);measured.push(steps.load(Ordering::Relaxed));
        }
        Ok(measured)
    })).await.unwrap();
    assert!(
        measured[2] < measured[0] * 10,
        "initial discovery must grow linearly: {measured:?}"
    );
    assert!(
        measured[3] < measured[1] * 10,
        "selector discovery must grow linearly: {measured:?}"
    );
    assert!(
        measured[4] < measured[0] * 2,
        "initial discovery scanned old prefix: {measured:?}"
    );
    assert!(
        measured[5] < measured[1] * 2,
        "selector discovery scanned old prefix: {measured:?}"
    );
    eprintln!(
        "discovery bundled VM [initial,selector] 1024 / 8192 / old-prefix+1024: {measured:?}"
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn discovery_seeks_dense_source_tuples_and_sparse_selector_indexes() {
    use std::sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    };
    async fn statement_sorts(db: &mut SqliteConnection, reset: bool) -> Result<i64, StoreError> {
        let mut handle = db.lock_handle().await?;
        let mut statement = std::ptr::null_mut();
        let mut sorts = 0;
        // SAFETY: the locked connection excludes every other SQLite operation.
        // Only counters are read/reset; no statement or raw pointer escapes.
        unsafe {
            loop {
                statement =
                    rusqlite::ffi::sqlite3_next_stmt(handle.as_raw_handle().as_ptr(), statement);
                if statement.is_null() {
                    break;
                }
                sorts += i64::from(rusqlite::ffi::sqlite3_stmt_status(
                    statement,
                    rusqlite::ffi::SQLITE_STMTSTATUS_SORT,
                    i32::from(reset),
                ));
            }
        }
        Ok(sorts)
    }
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("events.sqlite"))
        .await
        .unwrap();
    let measured=log.connection.run(|db|Box::pin(async move {
        let mut measured=Vec::new();
        for n in [1024i64,8192] {
            let session=format!("dense-{n}");
            sqlx::query("WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<?2)
                INSERT INTO context_semantic_rows SELECT ?1,1,(n-1)%3,(n-1)/3+1,((n-1)/3)%7+1,0,'target','target',CAST(n AS TEXT),'assistant_part',0,0,1,1,'{}' FROM numbers")
                .bind(&session).bind(n).execute(&mut *db).await?;
            let mut next=selection(n as u64);next.session=session;
            next.replay=Some(semantic::SemanticReplay{base:0,current:"target".into(),route:"route".into(),model:"model".into()});next.prior_unknown=true;
            let mut previous=next.clone();previous.replay.as_mut().unwrap().current="absent".into();previous.prior_unknown=false;
            for kind in 0..3 {
                if kind==2 { statement_sorts(db,true).await?; }
                let steps=Arc::new(AtomicU64::new(0));let observed=steps.clone();
                db.lock_handle().await?.set_progress_handler(1,move ||{observed.fetch_add(1,Ordering::Relaxed);true});
                let cursor=Some((1,1,n/6,4));
                let page=match kind {
                    0=>semantic::initial_groups(db,&next,cursor,64).await?,
                    1=>semantic::selection_dirty_groups(db,&previous,&next,2,cursor,64).await?,
                    _=>semantic::selection_dirty_groups(db,&previous,&next,4,cursor,64).await?,
                };
                db.lock_handle().await?.remove_progress_handler();assert_eq!(page.groups.len(),64);assert!(page.next.is_some());
                if kind==2 { assert_eq!(statement_sorts(db,false).await?,0,"the forced unknown keyset must not sort"); }
                measured.push(steps.load(Ordering::Relaxed));
            }
            // Full source/unknown pagination must not drop duplicate semantic
            // groups when the storage cursor crosses revision/order boundaries.
            for unknown in [false,true] {
                let mut expected=(1..=n).map(|r|(1,(r-1)%3,(r-1)/3+1,((r-1)/3)%7+1)).collect::<Vec<_>>();
                expected.sort_by_key(|point| if unknown {(point.0,point.3,point.1,point.2)}else{(point.0,point.1,point.2,point.3)});
                let mut cursor=None;
                let mut offset=0;
                if unknown { statement_sorts(db,true).await?; }
                loop {
                    let page=if unknown {semantic::selection_dirty_groups(db,&previous,&next,4,cursor,64).await?}else{semantic::initial_groups(db,&next,cursor,64).await?};
                    let end=offset+page.groups.len();
                    assert!(end<=expected.len());
                    assert_eq!(page.groups,expected[offset..end].iter().map(|point|point.3 as u64).collect::<Vec<_>>(),"source/item/revision ties must preserve exact page order");
                    assert_eq!(page.next,if end<expected.len(){Some(expected[end-1])}else{None},"the physical cursor must retain all four business-key components");
                    offset=end;cursor=page.next;if cursor.is_none(){break;}
                }
                assert_eq!(offset,expected.len(),"pagination must neither omit nor duplicate tied rows");
                if unknown { assert_eq!(statement_sorts(db,false).await?,0,"full unknown pagination must stay in index order"); }
            }
            let session=format!("sparse-{n}");
            sqlx::query("WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<?2)
                INSERT INTO context_semantic_rows SELECT ?1,n,0,n,n,0,CASE WHEN n>?2-3 THEN 'target' ELSE 'unrelated' END,'target',CAST(n AS TEXT),'assistant_part',0,0,1,n>?2-3,'{}' FROM numbers")
                .bind(&session).bind(n).execute(&mut *db).await?;
            next.session=session;previous.session=next.session.clone();
            for branch in [2,4] {
                let steps=Arc::new(AtomicU64::new(0));let observed=steps.clone();
                db.lock_handle().await?.set_progress_handler(1,move ||{observed.fetch_add(1,Ordering::Relaxed);true});
                let page=semantic::selection_dirty_groups(db,&previous,&next,branch,None,64).await?;
                db.lock_handle().await?.remove_progress_handler();assert_eq!(page.groups,vec![(n-2) as u64,(n-1) as u64,n as u64]);assert!(page.next.is_none());
                measured.push(steps.load(Ordering::Relaxed));
            }
        }
        Ok(measured)
    })).await.unwrap();
    for index in 0..5 {
        assert!(
            measured[index + 5] < measured[index] * 2,
            "fixed page scanned earlier revisions/unrelated sources: {measured:?}"
        );
    }
    eprintln!(
        "discovery bundled dense [normal,invocation,unknown], sparse [invocation,unknown], 1024 / 8192: {measured:?}"
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn prior_mcp_lookup_seeks_current_content_without_materializing_old_versions() {
    use std::sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    };
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("events.sqlite"))
        .await
        .unwrap();
    for sequence in [1, 2, 4] {
        seed(&log, sequence, sequence, true).await;
    }
    let mut values = BTreeMap::from([
        (
            "1".into(),
            vec![call(), Message::user("role boundary"), call()],
        ),
        ("2".into(), Vec::new()),
        ("4".into(), vec![result()]),
    ]);
    let build = log
        .prepare_model_view(selection(4), "prior-bounded", None)
        .await
        .unwrap();
    render(&log, &build, &values).await;
    let original = log.finish_prepared(&build).await.unwrap();
    let measured_view = original.clone();
    let counts=log.prepared_store().unwrap().run(move |db, _in_flight|Box::pin(async move {
        let view=measured_view;
        let content=tree::content_id(db,view.root.as_deref(),1).await?;
        // Same current content has two real producers, one before the role
        // floor and one exactly at it. Before is exclusive, including a sparse
        // candidate which claims that offset in this group.
        for (call_id,index) in [("old-role-only",0i64),("at-before",3)] {
            sqlx::query("INSERT INTO context_prepared_mcp_ids VALUES(?,?,?,1)").bind(&content).bind(call_id).bind(index).execute(&mut *db).await?;
        }
        // A missing group and a zero-width group precede the valid producer.
        // Neither may cause a premature role-floor stop or unsigned underflow.
        for sequence in [2i64,3] {
            sqlx::query("INSERT INTO context_prepared_mcp_ids VALUES(?,'mcp-id',0,?)").bind(format!("!missing-{sequence}")).bind(sequence).execute(&mut *db).await?;
        }
        let mut counts=Vec::new();let mut first=1;
        for n in [1024i64,8192] {
            sqlx::query("WITH RECURSIVE numbers(n) AS (SELECT ?1 UNION ALL SELECT n+1 FROM numbers WHERE n<?2)
                INSERT INTO context_prepared_mcp_ids SELECT '!old-'||printf('%08d',n),'mcp-id',0,1 FROM numbers")
                .bind(first).bind(n).execute(&mut *db).await?;
            first=n+1;
            let steps=Arc::new(AtomicU64::new(0));let observed=steps.clone();
            db.lock_handle().await?.set_progress_handler(1,move ||{observed.fetch_add(1,Ordering::Relaxed);true});
            let ids=dependencies::prior(db,&view,4,&["mcp-id".into()]).await?;
            db.lock_handle().await?.remove_progress_handler();
            assert_eq!(ids,vec!["mcp-id"]);counts.push(steps.load(Ordering::Relaxed));
        }
        assert!(dependencies::prior(db,&view,4,&["old-role-only".into(),"at-before".into(),"never".into()]).await?.is_empty());
        Ok(counts)
    })).await.unwrap();
    assert!(
        counts[1] < counts[0] * 2,
        "lookup scanned stale versions: {counts:?}"
    );
    eprintln!("prior bundled VM 1024 / 8192 stale same-group contents: {counts:?}");
    // The new root has only a producer before its role floor; the retained old
    // view still has the producer at the floor. Old index entries cannot lend
    // their presence to the new content even when they share the same sequence.
    seed(&log, 1, 5, true).await;
    values.insert(
        "1".into(),
        vec![
            call(),
            Message::user("role boundary"),
            Message::Assistant {
                content: vec![AssistantPart::Text {
                    text: "continuation".into(),
                    provider_options: None,
                }],
                provider_options: None,
            },
        ],
    );
    let build = log
        .prepare_model_view(selection(5), "prior-bounded", None)
        .await
        .unwrap();
    render(&log, &build, &values).await;
    let updated = log.finish_prepared(&build).await.unwrap();
    let group = PreparedGroup { id: "4".into() };
    assert!(
        log.prepared_prior_mcp_ids(&updated, &group, &["mcp-id".into()])
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        log.prepared_prior_mcp_ids(&original, &group, &["mcp-id".into()])
            .await
            .unwrap(),
        vec!["mcp-id"]
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn full_logical_discovery_scales_with_cold_and_checkpoint_windows() {
    use std::sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    };

    async fn prepare(after: u64, width: u64) -> (u64, u64) {
        let directory = tempfile::tempdir().unwrap();
        let log = EventLog::open(&directory.path().join("events.sqlite"))
            .await
            .unwrap();
        seed(&log, 1, 1, false).await;
        let through = after + width;
        log.connection.run(move |db| Box::pin(async move {
            let template: String = sqlx::query_scalar(
                "SELECT row_json FROM context_semantic_rows WHERE owner_session_id='prepared-test' AND source_sequence=1")
                .fetch_one(&mut *db).await?;
            sqlx::query("WITH RECURSIVE numbers(n) AS (SELECT 2 UNION ALL SELECT n+1 FROM numbers WHERE n<?1)
                INSERT INTO context_semantic_rows
                SELECT 'prepared-test',n,0,n,n,0,'invocation','invocation','discovery-fixture','imported_user',0,0,1,0,
                    json_set(?2,'$.id.sourceSequence',n,'$.order.sourceSequence',n,'$.revision',n)
                FROM numbers")
                .bind(through as i64).bind(template).execute(db).await?;
            Ok(())
        })).await.unwrap();
        let counter = Arc::new(AtomicU64::new(0));
        let observed = counter.clone();
        log.prepared_store()
            .unwrap()
            .run(move |db, _in_flight| {
                Box::pin(async move {
                    db.lock_handle().await?.set_progress_handler(1, move || {
                        observed.fetch_add(1, Ordering::Relaxed);
                        true
                    });
                    Ok(())
                })
            })
            .await
            .unwrap();
        let selected = SemanticSelection {
            after,
            ..selection(through)
        };
        // Count the complete production discovery, including every resumable
        // transaction and neighbor call, before rendering any payload.
        let build = log
            .prepare_model_view(selected, "window-growth", None)
            .await
            .unwrap();
        log.prepared_store()
            .unwrap()
            .run(|db, _in_flight| {
                Box::pin(async move {
                    db.lock_handle().await?.remove_progress_handler();
                    Ok(())
                })
            })
            .await
            .unwrap();
        let mut count = 0;
        let mut cursor: Option<String> = None;
        loop {
            let groups = log
                .prepared_dirty_groups(&build, cursor.as_deref(), 256)
                .await
                .unwrap();
            if groups.is_empty() {
                break;
            }
            count += groups.len();
            cursor = groups.last().map(|group| group.id.clone());
        }
        assert_eq!(count, width as usize);
        let measured = counter.load(Ordering::Relaxed);
        let cleanup = Arc::new(AtomicU64::new(0));
        let observed = cleanup.clone();
        log.prepared_store()
            .unwrap()
            .run(move |db, _in_flight| {
                Box::pin(async move {
                    db.lock_handle().await?.set_progress_handler(1, move || {
                        observed.fetch_add(1, Ordering::Relaxed);
                        true
                    });
                    Ok(())
                })
            })
            .await
            .unwrap();
        drop(build);
        let registry = log.prepared.clone();
        log.prepared_store()
            .unwrap()
            .run(move |db, in_flight| {
                Box::pin(async move {
                    while gc::maintain(db, &registry, in_flight).await? {}
                    db.lock_handle().await?.remove_progress_handler();
                    let remaining: i64 =
                        sqlx::query_scalar("SELECT COUNT(*) FROM context_prepared_dirty")
                            .fetch_one(db)
                            .await?;
                    assert_eq!(
                        remaining, 0,
                        "retirement must delete the indexed working rows"
                    );
                    Ok(())
                })
            })
            .await
            .unwrap();
        let cleanup = cleanup.load(Ordering::Relaxed);
        log.close().await.unwrap();
        (measured, cleanup)
    }

    for after in [0, 4096] {
        let small = prepare(after, 256).await;
        let large = prepare(after, 1024).await;
        assert!(
            large.0 < small.0 * 10,
            "full discovery became quadratic: after={after}, W=256 {small:?} -> W=1024 {large:?}"
        );
        assert!(
            large.1 < small.1 * 10,
            "indexed working-row retirement became quadratic: after={after}, W=256 {small:?} -> W=1024 {large:?}"
        );
    }
}

#[path = "active_head_eviction_tests.rs"]
mod active_head_eviction_tests;

#[path = "wire_storage_tests.rs"]
mod wire_storage_tests;

#[path = "newspace_reuse_tests.rs"]
mod newspace_reuse_tests;
