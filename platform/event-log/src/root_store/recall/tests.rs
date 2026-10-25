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

use crate::{
    recall::SearchQuery,
    root::{RootNamespaces, RootOwner},
    root_store::{RootStore, partition_for},
    sessions::{PluginSession, RemovalAuthority, RemoveFamilyResult, SessionRetirement},
};
use maka_agent_facts::import::{Content, Record, Source};
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc, time::Instant};
use tokio_util::sync::CancellationToken;

fn query(term: &str) -> SearchQuery {
    SearchQuery {
        terms: vec![term.into()],
        session_id: None,
        since: None,
        until: None,
        exclude: None,
        limit: None,
    }
}

fn record(id: impl Into<String>, turn: impl Into<String>, text: String, timestamp: u64) -> Record {
    Record {
        source_message_id: id.into(),
        source_turn_id: turn.into(),
        timestamp: Some(timestamp),
        content: Content::User { text },
    }
}

fn background() -> Vec<Record> {
    (0..5_000)
        .map(|n| {
            record(
                format!("background-{n}"),
                format!("background-turn-{n}"),
                format!("Background entry {n:05}: routine local processing completed with ordinary notes and no search hits."),
                1_700_000_000_000 + n,
            )
        })
        .collect()
}

async fn import(root: &RootStore, id: &str, records: Vec<Record>) {
    let owner = PluginSession {
        session_id: id.into(),
        creator: maka_capabilities::storage::Namespace::new(
            "recall-index-test",
            maka_plugin_core::scope::Scope::try_from("profile".to_owned()).unwrap(),
        )
        .unwrap(),
        fingerprint: format!("import-{id}"),
        managed: false,
        authority_session_id: None,
    };
    root.import_session(
        &owner,
        &Source {
            adapter: "recall-index-test".into(),
            session_id: format!("source-{id}"),
        },
        &json!({}),
        records,
        1_700_001_000_000,
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn indexed_recall_preserves_sources_scope_and_context_across_ten_thousand_messages() {
    const PREFIX: &str = "recall-owner-";
    let directory = tempfile::tempdir().unwrap();
    let owner = Arc::new(
        RootOwner::create(
            &directory.path().join("root"),
            &RootNamespaces {
                ownership: directory.path().join("ownership"),
                control: directory.path().join("control"),
            },
        )
        .unwrap(),
    );
    let root = RootStore::open(owner.clone()).await.unwrap();
    let a = (0..)
        .map(|n| format!("{PREFIX}{n}"))
        .find(|id| partition_for(b"session", id) == 0)
        .unwrap();
    let b = (0..)
        .map(|n| format!("{PREFIX}{n}"))
        .find(|id| partition_for(b"session", id) == 7)
        .unwrap();
    let original = format!(
        "{} late source 锚点 Cafe\u{301} 🦀",
        "Unabridged original source material. ".repeat(768)
    );
    let before = "The immediately preceding source message remains readable.";
    let after = "The immediately following source message remains readable.";
    let mut records = background();
    for (id, turn, text) in [
        ("before", "before-turn", before.to_owned()),
        ("anchor", "anchor-turn", original.clone()),
        ("after", "after-turn", after.to_owned()),
        (
            "weaker",
            "same-turn",
            format!("{} dedupword", "Ordinary surrounding material. ".repeat(8)),
        ),
        ("best", "same-turn", "dedupword dedupword dedupword".into()),
        ("false-grams", "false-grams-turn", "abc bcd ".repeat(8)),
        ("shared-a", "shared-a-turn", "sharedneedle".into()),
    ] {
        let timestamp = 1_700_000_000_000 + records.len() as u64;
        records.push(record(id, turn, text, timestamp));
    }
    let mut total_messages = records.len();
    import(&root, &a, records).await;
    let mut records = background();
    records.push(record(
        "exact",
        "exact-turn",
        "abcd".into(),
        1_700_000_008_000,
    ));
    records.push(record(
        "shared-b",
        "shared-b-turn",
        "sharedneedle".into(),
        1_700_000_008_001,
    ));
    total_messages += records.len();
    import(&root, &b, records).await;
    import(
        &root,
        "foreign-owner",
        vec![record(
            "foreign",
            "foreign-turn",
            "forbiddenmarker sharedneedle".into(),
            1_700_000_009_000,
        )],
    )
    .await;
    total_messages += 1;
    let partition = root.route_partition(&a).await.unwrap();
    assert_ne!(partition, root.route_partition(&b).await.unwrap());
    root.close().await.unwrap();
    let root = RootStore::open(owner).await.unwrap();

    let started = Instant::now();
    let first = root
        .search_history(PREFIX, query("锚点"), CancellationToken::new())
        .await
        .unwrap();
    let first_search = started.elapsed();
    assert!(first.gaps.is_empty());
    assert_eq!(first.hits.len(), 1);
    assert_eq!(first.hits[0].body, original);
    let started = Instant::now();
    for _ in 0..8 {
        let found = root
            .search_history(PREFIX, query("锚点"), CancellationToken::new())
            .await
            .unwrap();
        assert!(found.gaps.is_empty());
        assert_eq!(found.hits.len(), 1);
        assert_eq!(found.hits[0].message_id, first.hits[0].message_id);
    }
    let repeated_searches = started.elapsed();
    for term in ["锚", "CAFÉ", "🦀"] {
        let found = root
            .search_history(PREFIX, query(term), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(found.hits.len(), 1);
        assert_eq!(found.hits[0].body, original);
    }
    let mut literal = query("abcd");
    literal.limit = Some(1);
    let found = root
        .search_history(PREFIX, literal, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(found.hits.len(), 1);
    assert_eq!(found.hits[0].body, "abcd");
    let found = root
        .search_history(PREFIX, query("dedupword"), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(found.hits.len(), 1);
    assert_eq!(found.hits[0].body, "dedupword dedupword dedupword");
    let shared = root
        .search_history(PREFIX, query("sharedneedle"), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(shared.hits.len(), 2);
    assert_eq!(
        shared
            .hits
            .iter()
            .map(|hit| hit.session_id.as_str())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([a.as_str(), b.as_str()])
    );
    let mut limited = query("sharedneedle");
    limited.limit = Some(1);
    let found = root
        .search_history(PREFIX, limited, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(found.hits.len(), 1);
    assert_eq!(found.hits[0].message_id, shared.hits[0].message_id);
    assert!(
        root.search_history(PREFIX, query("forbiddenmarker"), CancellationToken::new())
            .await
            .unwrap()
            .hits
            .is_empty()
    );

    let anchor = &first.hits[0];
    let exact = root
        .history_context(
            PREFIX,
            &a,
            &anchor.message_id,
            0,
            0,
            Some(anchor.through),
            None,
            None,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(exact.anchor.body, original);
    assert!(exact.messages.is_empty());
    assert!(exact.has_more_before && exact.has_more_after);
    let context = root
        .history_context(
            PREFIX,
            &a,
            &anchor.message_id,
            1,
            1,
            Some(anchor.through),
            None,
            None,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(context.anchor.message_id, anchor.message_id);
    assert_eq!(
        context
            .messages
            .iter()
            .map(|message| message.body.as_str())
            .collect::<Vec<_>>(),
        [before, after]
    );
    assert!(
        context
            .messages
            .iter()
            .all(|message| message.message_id != anchor.message_id)
    );

    let mut total_bytes = 0i64;
    let mut fts_bytes = 0i64;
    let logs = std::iter::once(("control".to_owned(), &root.control)).chain(
        root.partitions
            .iter()
            .enumerate()
            .map(|(index, log)| (format!("partition-{index}"), log)),
    );
    for (name, log) in logs {
        let (pages, page_size, fts): (i64, i64, i64) = log.connection.read(|db| Box::pin(async move {
            let pages = sqlx::query_scalar("PRAGMA page_count").fetch_one(&mut *db).await?;
            let page_size = sqlx::query_scalar("PRAGMA page_size").fetch_one(&mut *db).await?;
            let fts = sqlx::query_scalar("SELECT COALESCE(SUM(pgsize),0) FROM dbstat WHERE name GLOB 'recall_terms*'").fetch_one(db).await?;
            Ok((pages, page_size, fts))
        })).await.unwrap();
        total_bytes += pages * page_size;
        fts_bytes += fts;
        eprintln!(
            "recall database={name} sqlite_pages={pages} page_size={page_size} fts_bytes={fts}"
        );
    }
    eprintln!(
        "recall workload messages={total_messages} first_search={first_search:?} repeated_8_searches={repeated_searches:?} sqlite_bytes={total_bytes} fts_bytes={fts_bytes}"
    );

    let target = a.clone();
    let (fts_before, removed_documents): (i64, i64) = root.partitions[partition]
        .connection
        .read(move |db| {
            Box::pin(async move {
                let fts = sqlx::query_scalar("SELECT count(*) FROM recall_terms")
                    .fetch_one(&mut *db)
                    .await?;
                let docs = sqlx::query_scalar(
                    "SELECT count(*) FROM recall_documents WHERE session_id=? AND folded<>''",
                )
                .bind(target)
                .fetch_one(db)
                .await?;
                Ok((fts, docs))
            })
        })
        .await
        .unwrap();
    let revision = root
        .get_session::<Value>(&a)
        .await
        .unwrap()
        .unwrap()
        .revision;
    assert!(matches!(
        root.remove_session_family(&a, revision, RemovalAuthority::Unmanaged)
            .await
            .unwrap(),
        RemoveFamilyResult::Accepted(_)
    ));
    assert_eq!(
        root.finish_session_retirement(&a).await.unwrap(),
        SessionRetirement::Removed
    );
    assert!(
        root.search_history(PREFIX, query("锚"), CancellationToken::new())
            .await
            .unwrap()
            .hits
            .is_empty()
    );
    let fts_after: i64 = root.partitions[partition]
        .connection
        .read(|db| {
            Box::pin(async move {
                Ok(sqlx::query_scalar("SELECT count(*) FROM recall_terms")
                    .fetch_one(db)
                    .await?)
            })
        })
        .await
        .unwrap();
    assert_eq!(fts_after, fts_before - removed_documents);
    let surviving = root
        .search_history(PREFIX, query("sharedneedle"), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(surviving.hits.len(), 1);
    assert_eq!(surviving.hits[0].session_id, b);
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(
        root.search_history(PREFIX, query("abcd"), cancelled)
            .await
            .is_err()
    );
    root.close().await.unwrap();
}
