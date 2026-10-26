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
        anchor_sequence: None,
        through,
        before: through + 1,
        captured_through: through,
        replay: None,
        prior_unknown: false,
    }
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
        .prepare_wire_view(view, format, "fixture-v1")
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
        .prepare_model_view(selection(3), "stable-render")
        .await
        .unwrap();
    let concurrent = log
        .prepare_model_view(selection(3), "stable-render")
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
        .prepare_wire_view(&view, WireFormat::Responses, "fixture-v1")
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
        .prepare_model_view(selection(3), "stable-render")
        .await
        .unwrap();
    assert_eq!(render(&log, &retry, &values).await, 0);
    let (_, encoded) = encode(&log, &view, WireFormat::Responses, &values).await;
    assert_eq!(encoded, 0);
    seed(&log, 4, 4, false).await;
    let next = log
        .prepare_model_view(selection(4), "stable-render")
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
    assert_eq!(
        log.prepared_group_snapshot(&view, &PreparedGroup { id: "1".into() })
            .await
            .unwrap(),
        manifest()
    );
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
        .connection
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
    let reopened = EventLog::open(&path).await.unwrap();
    assert!(
        reopened
            .prepared_wire_page(&wire, PreparedWireCursor::default(), 1)
            .await
            .is_err()
    );
    assert!(reopened.prepared_prefix_identity(&view, 1).await.is_err());
    let retry = reopened
        .prepare_model_view(selection(3), "stable-render")
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
        .prepare_model_view(selection(3), "anthropic-render")
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
        .prepare_model_view(selection(4), "anthropic-render")
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
        .prepare_model_view(selection(1), "policy")
        .await
        .unwrap();
    render(&log, &base, &values).await;
    log.finish_prepared(&base).await.unwrap();
    let low = log
        .prepare_model_view(selection(6), "policy")
        .await
        .unwrap();
    let high = log
        .prepare_model_view(selection(8), "policy")
        .await
        .unwrap();
    render(&log, &high, &values).await;
    let high_view = log.finish_prepared(&high).await.unwrap();
    render(&log, &low, &values).await;
    let low_view = log.finish_prepared(&low).await.unwrap();
    assert_eq!(low_view.message_count, 2);
    assert_eq!(high_view.message_count, 3);
    let next = log
        .prepare_model_view(selection(9), "policy")
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
        .prepare_model_view(selection(3), "anthropic")
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
        .prepare_model_view(selection(4), "anthropic")
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
    let build = log.prepare_model_view(cut, "anthropic").await.unwrap();
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
    let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    sqlx::query("ATTACH ':memory:' AS prepared_cache")
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::raw_sql(include_str!("schema.sql"))
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query("WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<7601) INSERT INTO context_prepared_dirty(build_id,group_sequence,done,leader_sequence) SELECT 'large',n,0,CASE WHEN n=78 THEN 77 ELSE NULL END FROM rows")
        .execute(&mut db).await.unwrap();
    // Re-prepare EXPLAIN across the schema change below; a cached statement
    // can report its original plan even after the index has been dropped.
    let plan = sqlx::query(sqlx::AssertSqlSafe(format!(
        "EXPLAIN QUERY PLAN {GROUP_MEMBERS_SQL}"
    )))
    .persistent(false)
    .bind("large")
    .bind(77i64)
    .fetch_all(&mut db)
    .await
    .unwrap();
    let details = plan
        .iter()
        .map(|row| row.get::<String, _>("detail"))
        .collect::<Vec<_>>();
    assert!(
        details
            .iter()
            .any(|detail| detail.contains("context_prepared_group_members")),
        "cluster lookup must use its expression index: {details:?}"
    );
    assert_eq!(members(&mut db, "large", 77).await.unwrap(), vec![77, 78]);
    assert_eq!(members(&mut db, "large", 7601).await.unwrap(), vec![7601]);
    sqlx::query("DROP INDEX context_prepared_group_members")
        .execute(&mut db)
        .await
        .unwrap();
    let unindexed = sqlx::query(sqlx::AssertSqlSafe(format!(
        "EXPLAIN QUERY PLAN {GROUP_MEMBERS_SQL}"
    )))
    .persistent(false)
    .bind("large")
    .bind(77i64)
    .fetch_all(&mut db)
    .await
    .unwrap();
    assert!(unindexed.iter().all(|row| {
        !row.get::<String, _>("detail")
            .contains("context_prepared_group_members")
    }));
}

#[tokio::test]
async fn inorder_page_frontier_visits_each_node_once_and_skips_zero_width_groups() {
    let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    sqlx::query("ATTACH ':memory:' AS prepared_cache")
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::raw_sql(include_str!("schema.sql"))
        .execute(&mut db)
        .await
        .unwrap();
    let mut root = None;
    let mut expected = Vec::new();
    let mut offset = 0usize;
    for sequence in 1..=129u64 {
        let count = if sequence % 7 == 0 {
            0
        } else {
            (sequence % 3 + 1) as usize
        };
        let messages = (0..count)
            .map(|index| Message::user(format!("{sequence}:{index}")))
            .collect::<Vec<_>>();
        let refs = messages
            .iter()
            .map(|message| MessageRef {
                id: hash(serde_json::to_string(message).unwrap().as_bytes()),
                assistant: false,
                breakdown: measure::prompt_breakdown(std::slice::from_ref(message)),
            })
            .collect();
        let group = Group {
            wire_id: None,
            wire_bytes: 0,
            index_bytes: 0,
            dependencies: Vec::new(),
            members: vec![sequence],
            manifest: MediaManifest::default(),
            messages: refs,
            breakdown: measure::prompt_breakdown(&messages),
        };
        let content = tree::save_group(&mut db, &group).await.unwrap();
        root = tree::insert(&mut db, root, sequence, content, group)
            .await
            .unwrap();
        if count > 0 {
            expected.push((sequence, offset, count));
        }
        offset += count;
    }
    for start in [0, 1, offset / 2, offset - 1, offset] {
        let mut walk = tree::GroupWalk::at(&mut db, root.as_deref(), start)
            .await
            .unwrap();
        let mut actual = Vec::new();
        while let Some((sequence, base, group)) = walk.next(&mut db).await.unwrap() {
            actual.push((sequence, base, group.messages.len()));
        }
        let selected = expected
            .iter()
            .copied()
            .filter(|(_, base, count)| base + count > start)
            .collect::<Vec<_>>();
        assert_eq!(actual, selected, "offset {start}");
        let fixed_root = root.clone();
        let (worker_selected, worker_reads) =
            crate::connection::worker_query(&mut db, move |worker| {
                Box::pin(async move {
                    let mut walk =
                        tree::GroupWalk::at(worker, fixed_root.as_deref(), start).await?;
                    let mut selected = Vec::new();
                    while let Some((sequence, base, _, count)) =
                        walk.next_descriptor(worker).await?
                    {
                        selected.push((sequence, base, count));
                    }
                    Ok((selected, walk.nodes_read))
                })
            })
            .await
            .unwrap();
        assert_eq!(worker_selected, selected, "worker offset {start}");
        assert!(
            worker_reads <= 129,
            "worker traversal re-read {worker_reads} nodes"
        );

        // The counter increments at the actual SQL node-read boundary. A
        // root seek per result would exceed this even on this modest fixture.
        assert!(
            walk.nodes_read <= 129,
            "{} node reads for one ordered traversal",
            walk.nodes_read
        );
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
        .prepare_model_view(selection(3), "worker-pages")
        .await
        .unwrap();
    assert_eq!(render(&log, &build, &values).await, 3);
    let view = log.finish_prepared(&build).await.unwrap();
    let build = log
        .prepare_wire_view(&view, WireFormat::Responses, "worker-pages")
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
async fn paged_discovery_and_concurrent_finish_share_one_frozen_generation() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("events.sqlite"))
        .await
        .unwrap();
    for sequence in 1..=130 {
        seed(&log, sequence, sequence, false).await;
    }
    let (a, b) = tokio::join!(
        log.prepare_model_view(selection(130), "paged"),
        log.prepare_model_view(selection(130), "paged")
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_eq!(a.id, b.id);
    let values = BTreeMap::from([("7".into(), Vec::new()), ("65".into(), Vec::new())]);
    assert_eq!(render(&log, &a, &values).await, 130);
    let (first, second) = tokio::join!(log.finish_prepared(&a), log.finish_prepared(&b));
    let first = first.unwrap();
    let second = second.unwrap();
    assert_eq!(first.identity, second.identity);
    assert_eq!(first.message_count, 128);
    let (a, b) = tokio::join!(
        log.prepare_wire_view(&first, WireFormat::Responses, "fixture-v1"),
        log.prepare_wire_view(&second, WireFormat::Responses, "fixture-v1")
    );
    let a = a.unwrap();
    let b = b.unwrap();
    let (wire, count) = encode(&log, &first, WireFormat::Responses, &values).await;
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
    let staged:i64=log.connection.run(move |db|Box::pin(async move {Ok(sqlx::query_scalar("SELECT COUNT(*) FROM context_prepared_wire_dirty WHERE view_id=? AND content IS NOT NULL").bind(id).fetch_one(db).await?)})).await.unwrap();
    assert_eq!(staged, 130);
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
            loop {let page=semantic::initial_groups(db,&next,cursor,false,64).await?;seen+=page.groups.len();cursor=page.next;if cursor.is_none(){break;}}
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
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("events.sqlite"))
        .await
        .unwrap();
    let measured=log.connection.run(|db|Box::pin(async move {
        let mut measured=Vec::new();
        for n in [1024i64,8192] {
            let session=format!("dense-{n}");
            sqlx::query("WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<?2)
                INSERT INTO context_semantic_rows SELECT ?1,1,0,n,(n%7)+1,0,'target','target',CAST(n AS TEXT),'assistant_part',0,0,1,1,'{}' FROM numbers")
                .bind(&session).bind(n).execute(&mut *db).await?;
            let mut next=selection(n as u64);next.session=session;next.anchor_sequence=Some(1);
            next.replay=Some(semantic::SemanticReplay{base:0,current:"target".into(),route:"route".into(),model:"model".into()});next.prior_unknown=true;
            let mut previous=next.clone();previous.replay.as_mut().unwrap().current="absent".into();previous.prior_unknown=false;
            for kind in 0..4 {
                let steps=Arc::new(AtomicU64::new(0));let observed=steps.clone();
                db.lock_handle().await?.set_progress_handler(1,move ||{observed.fetch_add(1,Ordering::Relaxed);true});
                let cursor=Some((1,0,n/2,4));
                let page=match kind {
                    0=>semantic::initial_groups(db,&next,cursor,false,64).await?,
                    1=>semantic::initial_groups(db,&next,cursor,true,64).await?,
                    2=>semantic::selection_dirty_groups(db,&previous,&next,2,cursor,64).await?,
                    _=>semantic::selection_dirty_groups(db,&previous,&next,4,cursor,64).await?,
                };
                db.lock_handle().await?.remove_progress_handler();assert_eq!(page.groups.len(),64);assert!(page.next.is_some());
                measured.push(steps.load(Ordering::Relaxed));
            }
            // Full anchor/unknown pagination must not drop duplicate semantic
            // groups when the storage cursor crosses revision/order boundaries.
            for unknown in [false,true] {
                let mut cursor=None;let mut groups=Vec::new();
                loop {
                    let page=if unknown {semantic::selection_dirty_groups(db,&previous,&next,4,cursor,64).await?}else{semantic::initial_groups(db,&next,cursor,true,64).await?};
                    groups.extend(page.groups);cursor=page.next;if cursor.is_none(){break;}
                }
                groups.sort_unstable();let mut expected=(1..=n).map(|r|(r%7+1) as u64).collect::<Vec<_>>();expected.sort_unstable();assert_eq!(groups,expected);
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
    for index in 0..6 {
        assert!(
            measured[index + 6] < measured[index] * 2,
            "fixed page scanned earlier revisions/unrelated sources: {measured:?}"
        );
    }
    eprintln!(
        "discovery bundled dense [normal,anchor,invocation,unknown], sparse [invocation,unknown], 1024 / 8192: {measured:?}"
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
        .prepare_model_view(selection(4), "prior-bounded")
        .await
        .unwrap();
    render(&log, &build, &values).await;
    let original = log.finish_prepared(&build).await.unwrap();
    let measured_view = original.clone();
    let counts=log.connection.run(move |db|Box::pin(async move {
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
        .prepare_model_view(selection(5), "prior-bounded")
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
