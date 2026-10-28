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
use unicode_normalization::UnicodeNormalization;

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

#[derive(Clone, Debug)]
struct LiteralDocument {
    session_id: String,
    message_id: String,
    turn_id: String,
    timestamp: u64,
    role: String,
    body: String,
}

#[derive(Debug)]
struct LiteralHit {
    document: LiteralDocument,
    matched_terms: Vec<String>,
    score: f64,
}

async fn literal_documents(root: &RootStore) -> Vec<LiteralDocument> {
    let mut documents = Vec::new();
    for log in &root.partitions {
        let rows:Vec<(String,String,String,i64,String,String)>=log.connection.read(|db|Box::pin(async move {
            Ok(sqlx::query_as("SELECT session_id,message_id,turn_id,timestamp,role,body FROM recall_documents").fetch_all(db).await?)
        })).await.unwrap();
        documents.extend(rows.into_iter().map(
            |(session_id, message_id, turn_id, timestamp, role, body)| LiteralDocument {
                session_id,
                message_id,
                turn_id,
                timestamp: u64::try_from(timestamp).unwrap(),
                role,
                body,
            },
        ));
    }
    documents
}

fn literal_hits(
    documents: &[LiteralDocument],
    prefix: &str,
    input: &SearchQuery,
) -> Vec<LiteralHit> {
    let mut terms = Vec::new();
    for term in &input.terms {
        let normalized = term.trim().nfc().collect::<String>().to_lowercase();
        if !terms.contains(&normalized) {
            terms.push(normalized);
        }
    }
    let mut hits = Vec::new();
    for document in documents {
        if !document.session_id.starts_with(prefix)
            || input
                .session_id
                .as_ref()
                .is_some_and(|id| id != &document.session_id)
            || input.since.is_some_and(|since| document.timestamp < since)
            || input.until.is_some_and(|until| document.timestamp > until)
            || input.exclude.as_ref().is_some_and(|(session, turn)| {
                session == &document.session_id && turn == &document.turn_id
            })
        {
            continue;
        }
        let text = document
            .body
            .nfc()
            .collect::<String>()
            .to_lowercase()
            .chars()
            .collect::<Vec<_>>();
        let mut matched_terms = Vec::new();
        let mut covered = 0;
        for term in &terms {
            let needle = term.chars().collect::<Vec<_>>();
            let mut offset = 0;
            let mut count = 0;
            while offset + needle.len() <= text.len() {
                if text[offset..offset + needle.len()] == needle {
                    count += 1;
                    offset += needle.len();
                } else {
                    offset += 1;
                }
            }
            if count > 0 {
                matched_terms.push(term.clone());
                covered += count * needle.len();
            }
        }
        if matched_terms.is_empty() {
            continue;
        }
        let score = covered as f64 / text.len() as f64
            * if document.role == "tool_result" {
                0.5
            } else {
                1.0
            };
        hits.push(LiteralHit {
            document: document.clone(),
            matched_terms,
            score,
        });
    }
    hits.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| b.document.timestamp.cmp(&a.document.timestamp))
            .then_with(|| a.document.message_id.cmp(&b.document.message_id))
            .then_with(|| a.document.session_id.cmp(&b.document.session_id))
            .then_with(|| a.document.turn_id.cmp(&b.document.turn_id))
    });
    let mut turns = BTreeSet::new();
    hits.retain(|hit| {
        turns.insert((
            hit.document.session_id.clone(),
            hit.document.turn_id.clone(),
        ))
    });
    if let Some(limit) = input.limit {
        hits.truncate(limit);
    }
    hits
}

async fn assert_literal_search(
    root: &RootStore,
    prefix: &str,
    documents: &[LiteralDocument],
    input: SearchQuery,
) -> Vec<crate::recall::SearchHit> {
    let expected = literal_hits(documents, prefix, &input);
    let description = format!(
        "terms={:?}, session={:?}, since={:?}, until={:?}, exclude={:?}, limit={:?}",
        input.terms, input.session_id, input.since, input.until, input.exclude, input.limit
    );
    let found = root
        .search_history(prefix, input, CancellationToken::new())
        .await
        .unwrap();
    assert!(found.gaps.is_empty(), "{description}: {:?}", found.gaps);
    assert_eq!(found.hits.len(), expected.len(), "{description}");
    for (actual, expected) in found.hits.iter().zip(expected) {
        assert_eq!(
            (
                &actual.session_id,
                &actual.message_id,
                &actual.turn_id,
                actual.timestamp,
                &actual.body
            ),
            (
                &expected.document.session_id,
                &expected.document.message_id,
                &expected.document.turn_id,
                expected.document.timestamp,
                &expected.document.body
            ),
            "{description}"
        );
        assert_eq!(
            actual.matched_terms, expected.matched_terms,
            "{description}"
        );
        assert!(
            (actual.score - expected.score).abs()
                <= f64::EPSILON * 8.0 * expected.score.abs().max(1.0),
            "{description}: density {} vs {}",
            actual.score,
            expected.score
        );
    }
    found.hits
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
        ("unicode", "unicode-turn", "Ω qx 汉字 🙂🚀".into()),
        ("repeated", "repeated-turn", "aaaaaa".into()),
        (
            "punctuation",
            "punctuation-turn",
            "prefix within.word, spaced words\tinside suffix".into(),
        ),
        ("nul-text", "nul-turn", "prenul\0postnul".into()),
        (
            "maximum",
            "maximum-turn",
            "\u{10ffff}\u{10ffff}\u{10ffff}".into(),
        ),
    ] {
        let timestamp = 1_700_000_000_000 + records.len() as u64;
        records.push(record(id, turn, text, timestamp));
    }
    let dense = "densitymark densitymark";
    let sparse = "densitymark ...........";
    assert_eq!(dense.chars().count(), sparse.chars().count());
    records.push(record(
        "density-high",
        "equal-density-turn",
        dense.into(),
        1_700_000_007_000,
    ));
    records.push(record(
        "density-low",
        "equal-density-turn",
        sparse.into(),
        1_700_000_007_001,
    ));
    records.push(record(
        "weight-user",
        "weight-user-turn",
        "weightmark......".into(),
        1_700_000_007_500,
    ));
    records.push(Record {
        source_message_id: "weight-tool".into(),
        source_turn_id: "weight-tool-turn".into(),
        timestamp: Some(1_700_000_007_600),
        content: Content::ToolResult {
            call_id: "weighted-call".into(),
            output: json!("weightmark"),
            is_error: false,
        },
    });
    let tie_time = 1_700_000_008_500;
    for id in ["tie-a-first", "tie-a-second"] {
        records.push(record(id, "tie-a-turn", "tiebreakword".into(), tie_time));
    }
    records.push(record(
        "tie-newest",
        "tie-newest-turn",
        "tiebreakword".into(),
        tie_time + 1,
    ));
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
    for id in ["tie-b-first", "tie-b-second"] {
        records.push(record(id, id, "tiebreakword".into(), tie_time));
    }
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
    let documents = literal_documents(&root).await;
    assert_eq!(
        documents.len(),
        total_messages,
        "the scan oracle must contain every imported source, including foreign-prefix sources"
    );
    for terms in [
        vec!["锚"],
        vec!["锚点"],
        vec!["x"],
        vec!["Ω"],
        vec!["qx"],
        vec!["汉字"],
        vec!["🙂"],
        vec!["🙂🚀"],
        vec!["CAFÉ"],
        vec!["Cafe\u{301}"],
        vec!["within.word"],
        vec!["spaced words"],
        vec!["words\tinside"],
        vec!["aaaa"],
        vec!["abc"],
        vec!["abcd"],
        vec!["prenul"],
        vec!["postnul"],
        vec!["\u{10ffff}"],
        vec!["\u{10ffff}\u{10ffff}"],
        vec!["\u{10ffff}\u{10ffff}\u{10ffff}"],
        vec!["abcd", "锚点", "notpresentmarker"],
        vec![" CAFÉ ", "Cafe\u{301}", "café", "notpresentmarker"],
    ] {
        let mut input = query(terms[0]);
        input.terms = terms.into_iter().map(str::to_owned).collect();
        assert_literal_search(&root, PREFIX, &documents, input).await;
    }
    let mut overlap = query("aaa");
    overlap.terms.push("aa".into());
    let overlap = assert_literal_search(&root, PREFIX, &documents, overlap).await;
    assert_eq!(overlap.len(), 1);
    assert!(
        overlap[0].score > 1.0,
        "separate terms may cover the same scalars"
    );
    let density = assert_literal_search(&root, PREFIX, &documents, query("densitymark")).await;
    assert_eq!(density.len(), 1);
    assert_eq!(
        density[0].body, dense,
        "density must choose the older equal-length message within the Turn"
    );
    let weighted = assert_literal_search(&root, PREFIX, &documents, query("weightmark")).await;
    assert_eq!(weighted.len(), 2);
    assert_eq!(
        weighted[0].role,
        maka_agent_ports::session::history::Role::User
    );
    assert_eq!(
        weighted[1].role,
        maka_agent_ports::session::history::Role::ToolResult
    );
    assert!(
        weighted[0].score > weighted[1].score,
        "tool-result downweight must beat its otherwise denser, newer text"
    );
    let ties = assert_literal_search(&root, PREFIX, &documents, query("tiebreakword")).await;
    assert_eq!(ties.len(), 4);
    assert_eq!(ties[0].timestamp, tie_time + 1);
    assert_eq!(
        ties.iter()
            .map(|hit| hit.session_id.as_str())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([a.as_str(), b.as_str()])
    );
    for limit in [1, 2, 3, 8] {
        let mut input = query("tiebreakword");
        input.limit = Some(limit);
        let limited = assert_literal_search(&root, PREFIX, &documents, input).await;
        assert_eq!(
            limited
                .iter()
                .map(|hit| &hit.message_id)
                .collect::<Vec<_>>(),
            ties.iter()
                .take(limit)
                .map(|hit| &hit.message_id)
                .collect::<Vec<_>>(),
            "partition-local pruning and global merge must preserve the complete ordered prefix"
        );
    }
    let mut scoped = query("tiebreakword");
    scoped.session_id = Some(a.clone());
    assert_literal_search(&root, PREFIX, &documents, scoped).await;
    let mut timed = query("tiebreakword");
    timed.since = Some(tie_time);
    timed.until = Some(tie_time);
    assert_literal_search(&root, PREFIX, &documents, timed).await;
    let mut excluded = query("tiebreakword");
    excluded.exclude = Some((ties[0].session_id.clone(), ties[0].turn_id.clone()));
    assert_literal_search(&root, PREFIX, &documents, excluded).await;
    for invalid in ["\0", "post\0nul"] {
        assert!(
            root.search_history(PREFIX, query(invalid), CancellationToken::new())
                .await
                .is_err(),
            "NUL queries remain rejected even though indexed bodies may contain NUL"
        );
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
