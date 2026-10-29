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
    recall::{SearchHit, SearchQuery},
    root::{RootNamespaces, RootOwner},
    root_store::{RootStore, partition_for},
    sessions::{PluginSession, RemovalAuthority, RemoveFamilyResult, SessionRetirement},
};
use maka_agent_facts::import::{Content, Record, Source};
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc};
use tokio_util::sync::CancellationToken;

const PREFIX: &str = "recall-owner-";

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

fn record(id: &str, turn: &str, text: &str, timestamp: u64) -> Record {
    Record {
        source_message_id: id.into(),
        source_turn_id: turn.into(),
        timestamp: Some(timestamp),
        content: Content::User { text: text.into() },
    }
}

async fn import(root: &RootStore, id: &str, records: Vec<Record>) {
    root.import_session(
        &PluginSession {
            session_id: id.into(),
            creator: maka_capabilities::storage::Namespace::new(
                "recall-index-test",
                maka_plugin_core::scope::Scope::Profile,
            )
            .unwrap(),
            fingerprint: format!("import-{id}"),
            managed: false,
            authority_session_id: None,
        },
        &Source {
            adapter: "fixture".into(),
            session_id: format!("source-{id}"),
        },
        &json!({}),
        records,
        100,
    )
    .await
    .unwrap();
}

struct Fixture {
    _directory: tempfile::TempDir,
    owner: Arc<RootOwner>,
    root: RootStore,
    a: String,
    b: String,
}

impl Fixture {
    async fn new(a: Vec<Record>, b: Vec<Record>) -> Self {
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
        let id = |partition| {
            (0..)
                .map(|n| format!("{PREFIX}{n}"))
                .find(|id| partition_for(b"session", id) == partition)
                .unwrap()
        };
        let left = id(0);
        let right = id(7);
        import(&root, &left, a).await;
        import(&root, &right, b).await;
        import(
            &root,
            "foreign-owner",
            vec![record(
                "foreign",
                "foreign-turn",
                "forbidden sharedneedle",
                20,
            )],
        )
        .await;
        assert_ne!(
            root.route_partition(&left).await.unwrap(),
            root.route_partition(&right).await.unwrap()
        );
        Self {
            _directory: directory,
            owner,
            root,
            a: left,
            b: right,
        }
    }

    async fn search(&self, input: SearchQuery) -> Vec<SearchHit> {
        let result = self
            .root
            .search_history(PREFIX, input, CancellationToken::new())
            .await
            .unwrap();
        assert!(result.gaps.is_empty(), "{:?}", result.gaps);
        result.hits
    }

    async fn reopen(&mut self) {
        self.root.close().await.unwrap();
        self.root = RootStore::open(self.owner.clone()).await.unwrap();
    }
}

#[tokio::test]
async fn recall_preserves_literal_unicode_and_ranks_one_hit_per_turn() {
    let mut rows = vec![
        record("unicode", "unicode", "Ω qx 汉字 🙂🚀", 1),
        record("accent", "accent", "Cafe\u{301} 锚点 🦀", 2),
        record("false-grams", "false-grams", "abc bcd", 3),
        record("exact", "exact", "abcd", 4),
        record(
            "punctuation",
            "punctuation",
            "within.word, spaced words\tinside",
            5,
        ),
        record("nul", "nul", "prenul\0postnul", 6),
        record("maximum", "maximum", "\u{10ffff}\u{10ffff}\u{10ffff}", 7),
        record("repeated", "repeated", "aaaaaa", 8),
        record("sparse", "density-turn", "densitymark ...........", 10),
        record("dense", "density-turn", "densitymark densitymark", 9),
        record("weighted-user", "weighted-user", "weightmark......", 11),
    ];
    rows.push(Record {
        source_message_id: "weighted-tool".into(),
        source_turn_id: "weighted-tool".into(),
        timestamp: Some(12),
        content: Content::ToolResult {
            call_id: "weighted-call".into(),
            output: json!("weightmark"),
            is_error: false,
        },
    });
    let f = Fixture::new(rows, vec![record("other", "other", "sharedneedle", 1)]).await;
    for (term, expected) in [
        ("Ω", "Ω qx 汉字 🙂🚀"),
        ("qx", "Ω qx 汉字 🙂🚀"),
        ("汉字", "Ω qx 汉字 🙂🚀"),
        ("🙂🚀", "Ω qx 汉字 🙂🚀"),
        ("CAFÉ", "Cafe\u{301} 锚点 🦀"),
        ("Cafe\u{301}", "Cafe\u{301} 锚点 🦀"),
        ("锚", "Cafe\u{301} 锚点 🦀"),
        ("abcd", "abcd"),
        ("within.word", "within.word, spaced words\tinside"),
        ("words\tinside", "within.word, spaced words\tinside"),
        ("prenul", "prenul\0postnul"),
        ("postnul", "prenul\0postnul"),
        ("\u{10ffff}", "\u{10ffff}\u{10ffff}\u{10ffff}"),
        (
            "\u{10ffff}\u{10ffff}\u{10ffff}",
            "\u{10ffff}\u{10ffff}\u{10ffff}",
        ),
        ("densitymark", "densitymark densitymark"),
    ] {
        let hits = f.search(query(term)).await;
        assert_eq!(hits.len(), 1, "{term}");
        assert_eq!(hits[0].body, expected, "{term}");
        assert_eq!(hits[0].session_id, f.a);
    }
    let mut disjunction = query("abcd");
    disjunction
        .terms
        .extend(["锚点".into(), "notpresentmarker".into()]);
    let hits = f.search(disjunction).await;
    assert_eq!(hits.len(), 2);
    for (body, term) in [("abcd", "abcd"), ("Cafe\u{301} 锚点 🦀", "锚点")] {
        let hit = hits.iter().find(|hit| hit.body == body).unwrap();
        assert_eq!(hit.matched_terms, [term]);
    }
    let mut normalized = query(" CAFÉ ");
    normalized.terms.extend([
        "Cafe\u{301}".into(),
        "café".into(),
        "notpresentmarker".into(),
    ]);
    let normalized = f.search(normalized).await;
    assert_eq!(normalized.len(), 1);
    assert_eq!(normalized[0].body, "Cafe\u{301} 锚点 🦀");
    assert_eq!(normalized[0].matched_terms, ["café"]);
    let weighted = f.search(query("weightmark")).await;
    assert_eq!(
        weighted
            .iter()
            .map(|hit| hit.body.as_str())
            .collect::<Vec<_>>(),
        ["weightmark......", "weightmark"]
    );
    assert!(weighted[0].score > weighted[1].score);
    let mut overlap = query("aaa");
    overlap.terms.push("aa".into());
    let overlap = f.search(overlap).await;
    assert_eq!(overlap.len(), 1);
    assert_eq!(overlap[0].body, "aaaaaa");
    assert_eq!(overlap[0].matched_terms, ["aaa", "aa"]);
    assert!(overlap[0].score > 1.0);
    for term in ["\0", "post\0nul"] {
        assert!(
            f.root
                .search_history(PREFIX, query(term), CancellationToken::new())
                .await
                .is_err()
        );
    }
    f.root.close().await.unwrap();
}

#[tokio::test]
async fn recall_merges_partitions_before_limits_and_applies_scope_time_and_exclusion() {
    let f = Fixture::new(
        vec![
            record("a-first", "a-first", "tiebreakword sharedneedle", 10),
            record("a-new", "a-new", "tiebreakword sharedneedle", 11),
        ],
        vec![
            record("b-first", "b-first", "tiebreakword sharedneedle", 10),
            record("b-second", "b-second", "tiebreakword sharedneedle", 10),
        ],
    )
    .await;
    let all = f.search(query("tiebreakword")).await;
    assert_eq!(all.len(), 4);
    assert_eq!(all[0].timestamp, 11);
    assert_eq!(
        all.iter()
            .map(|hit| hit.session_id.as_str())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([f.a.as_str(), f.b.as_str()])
    );
    for limit in [1, 3] {
        let mut input = query("tiebreakword");
        input.limit = Some(limit);
        let hits = f.search(input).await;
        assert_eq!(
            hits.iter().map(|hit| &hit.message_id).collect::<Vec<_>>(),
            all.iter()
                .take(limit)
                .map(|hit| &hit.message_id)
                .collect::<Vec<_>>()
        );
    }
    let mut scoped = query("tiebreakword");
    scoped.session_id = Some(f.a.clone());
    let scoped = f.search(scoped).await;
    assert_eq!(scoped.len(), 2);
    assert!(scoped.iter().all(|hit| hit.session_id == f.a));
    let mut timed = query("tiebreakword");
    timed.since = Some(10);
    timed.until = Some(10);
    let timed = f.search(timed).await;
    assert_eq!(timed.len(), 3);
    assert!(timed.iter().all(|hit| hit.timestamp == 10));
    let mut excluded = query("tiebreakword");
    excluded.exclude = Some((all[0].session_id.clone(), all[0].turn_id.clone()));
    let excluded = f.search(excluded).await;
    assert_eq!(excluded.len(), 3);
    assert!(
        excluded
            .iter()
            .all(|hit| hit.message_id != all[0].message_id)
    );
    assert!(f.search(query("forbidden")).await.is_empty());
    assert_eq!(f.search(query("sharedneedle")).await.len(), 4);
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(
        f.root
            .search_history(PREFIX, query("tiebreakword"), cancelled)
            .await
            .is_err()
    );
    f.root.close().await.unwrap();
}

#[tokio::test]
async fn recall_context_and_index_retirement_survive_reopen() {
    let original = format!("{}锚点 🦀", "Unabridged original source. ".repeat(512));
    let mut f = Fixture::new(
        vec![
            record("before", "before", "preceding message", 1),
            record("anchor", "anchor", &original, 2),
            record("after", "after", "following message", 3),
            record("shared", "shared", "sharedneedle", 4),
        ],
        vec![record("shared", "shared", "sharedneedle", 4)],
    )
    .await;
    f.reopen().await;
    let anchor = f.search(query("锚点")).await.pop().unwrap();
    assert_eq!(anchor.body, original);
    let exact = f
        .root
        .history_context(
            PREFIX,
            &f.a,
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
    let context = f
        .root
        .history_context(
            PREFIX,
            &f.a,
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
    assert_eq!(
        context
            .messages
            .iter()
            .map(|message| message.body.as_str())
            .collect::<Vec<_>>(),
        ["preceding message", "following message"]
    );
    let partition = f.root.route_partition(&f.a).await.unwrap();
    let counts = || {
        f.root.partitions[partition].connection.read(|db| {
            Box::pin(async move {
                Ok((
                    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM recall_documents")
                        .fetch_one(&mut *db)
                        .await?,
                    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM recall_terms")
                        .fetch_one(db)
                        .await?,
                ))
            })
        })
    };
    let before = counts().await.unwrap();
    let revision = f
        .root
        .get_session::<Value>(&f.a)
        .await
        .unwrap()
        .unwrap()
        .revision;
    assert!(matches!(
        f.root
            .remove_session_family(&f.a, revision, RemovalAuthority::Unmanaged)
            .await
            .unwrap(),
        RemoveFamilyResult::Accepted(_)
    ));
    assert_eq!(
        f.root.finish_session_retirement(&f.a).await.unwrap(),
        SessionRetirement::Removed
    );
    assert!(f.search(query("锚点")).await.is_empty());
    let after = counts().await.unwrap();
    assert_eq!(after, (before.0 - 4, before.1 - 4));
    f.reopen().await;
    let surviving = f.search(query("sharedneedle")).await;
    assert_eq!(surviving.len(), 1);
    assert_eq!(surviving[0].session_id, f.b);
    f.root.close().await.unwrap();
}
