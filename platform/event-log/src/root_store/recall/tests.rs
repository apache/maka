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
    recall::{ExcludedTurnTail, SearchHit, SearchQuery},
    root::{RootNamespaces, RootOwner},
    root_store::RootStore,
    sessions::{PluginSession, RemoveFamilyResult, SessionRetirement},
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

fn record(
    id: impl Into<String>,
    turn: impl Into<String>,
    text: impl Into<String>,
    timestamp: u64,
) -> Record {
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
        let left = format!("{PREFIX}a");
        let right = format!("{PREFIX}b");
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

    async fn reopen(mut self) -> Self {
        self.root.close().await.unwrap();
        self.root = RootStore::open(self.owner.clone()).await.unwrap();
        self
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
async fn recall_orders_results_before_limits_and_applies_scope_time_and_exclusion() {
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
    excluded.exclude = Some(ExcludedTurnTail {
        session_id: all[0].session_id.clone(),
        turn_id: all[0].turn_id.clone(),
        covered_through: 0,
    });
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
    f = f.reopen().await;
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
    let counts = || {
        let session = f.a.clone();
        crate::test_store::inspect_cache(&f.root.log, move |db| {
            (
                db.query_row(
                    "SELECT count(*) FROM temp.transcript_directory WHERE owner_key=?1",
                    [session],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
                db.query_row("SELECT count(*) FROM temp.recall_terms", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            )
        })
    };
    let before = counts().await;
    let revision = f
        .root
        .get_session::<Value>(&f.a)
        .await
        .unwrap()
        .unwrap()
        .revision;
    assert!(matches!(
        f.root.remove_session_family(&f.a, revision).await.unwrap(),
        RemoveFamilyResult::Accepted(_)
    ));
    assert_eq!(
        f.root.finish_session_retirement(&f.a).await.unwrap(),
        SessionRetirement::Removed
    );
    assert!(f.search(query("锚点")).await.is_empty());
    let after = counts().await;
    assert_eq!(after, (before.0 - 4, before.1 - 4));
    f = f.reopen().await;
    let surviving = f.search(query("sharedneedle")).await;
    assert_eq!(surviving.len(), 1);
    assert_eq!(surviving[0].session_id, f.b);
    f.root.close().await.unwrap();
}

fn demand_owner(path: &std::path::Path) -> Arc<RootOwner> {
    Arc::new(
        RootOwner::create(
            &path.join("root"),
            &RootNamespaces {
                ownership: path.join("ownership"),
                control: path.join("control"),
            },
        )
        .unwrap(),
    )
}

#[tokio::test]
async fn recall_fault_does_not_reject_sources_or_direct_context_and_search_recovers() {
    let directory = tempfile::tempdir().unwrap();
    let owner = demand_owner(directory.path());
    let root = RootStore::open(owner.clone()).await.unwrap();
    let session = "demand-source";
    crate::test_store::inspect_cache(&root.log, |db| {
        db.execute_batch("CREATE TEMP TRIGGER fail_recall BEFORE INSERT ON temp.recall_progress BEGIN SELECT RAISE(ABORT,'Recall index fault'); END;").unwrap();
    }).await;
    import(
        &root,
        session,
        vec![
            record("older", "older", "older", 1),
            record("before", "before", "before", 2),
            record("empty", "empty", String::new(), 3),
            record("anchor", "anchor", "needle anchor", 4),
            record("after", "after", "after", 5),
        ],
    )
    .await;
    let anchor: String = crate::test_store::inspect_cache(&root.log, |db| {
        let through: i64 = db
            .query_row(
                "SELECT COALESCE(MAX(sequence),0) FROM event_log",
                [],
                |row| row.get(0),
            )
            .unwrap();
        crate::transcript::directory::ensure_on_handle(db, "demand-source", through as u64)
            .unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM recall_terms", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        db.query_row(
            "SELECT message_id FROM transcript_directory WHERE timestamp=4",
            [],
            |r| r.get(0),
        )
        .unwrap()
    })
    .await;
    let context = root
        .history_context(
            "demand-",
            session,
            &anchor,
            1,
            1,
            None,
            None,
            None,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(context.anchor.body, "needle anchor");
    assert_eq!(
        context
            .messages
            .iter()
            .map(|hit| hit.body.as_str())
            .collect::<Vec<_>>(),
        ["before", "after"]
    );
    let empty: String = crate::test_store::inspect_cache(&root.log, |db| {
        db.query_row(
            "SELECT message_id FROM transcript_directory WHERE timestamp=3",
            [],
            |r| r.get(0),
        )
        .unwrap()
    })
    .await;
    let empty_anchor = root
        .history_context(
            "demand-",
            session,
            &empty,
            1,
            1,
            None,
            None,
            None,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(empty_anchor.anchor.body.is_empty());
    assert_eq!(
        empty_anchor
            .messages
            .iter()
            .map(|hit| hit.body.as_str())
            .collect::<Vec<_>>(),
        ["before", "needle anchor"]
    );
    assert!(context.has_more_before);
    assert!(!context.has_more_after);
    assert!(
        root.search_history("demand-", query("needle"), CancellationToken::new())
            .await
            .is_err()
    );
    crate::test_store::inspect_cache(&root.log, |db| {
        assert_eq!(
            db.query_row("SELECT count(*) FROM recall_progress", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM recall_terms", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0,
        );
        db.execute_batch("DROP TRIGGER fail_recall").unwrap();
    })
    .await;
    let found = root
        .search_history("demand-", query("needle"), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(found.hits.len(), 1);
    assert_eq!(found.hits[0].body, "needle anchor");
    crate::test_store::inspect_cache(&root.log, |db| {
        db.execute_batch("CREATE TEMP TRIGGER fail_recall BEFORE INSERT ON temp.recall_progress BEGIN SELECT RAISE(ABORT,'clean query replayed sources'); END;").unwrap();
    }).await;
    let warm = root
        .search_history("demand-", query("needle"), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(warm.hits[0].message_id, found.hits[0].message_id);
    root.close().await.unwrap();
    let root = RootStore::open(owner).await.unwrap();
    crate::test_store::inspect_cache(&root.log, |db| {
        assert_eq!(
            db.query_row("SELECT count(*) FROM transcript_directory", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            0
        );
    })
    .await;
    let repeated = root
        .search_history("demand-", query("needle"), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(repeated.hits[0].message_id, found.hits[0].message_id);
    root.close().await.unwrap();
}

#[tokio::test]
async fn demand_indexes_new_copy_with_old_sources_without_inheriting_progress() {
    use crate::sessions::{SessionCopy, SessionCopyResult};
    use maka_agent_facts::session::{CopyPurpose, ForkPosition};
    let directory = tempfile::tempdir().unwrap();
    let root = RootStore::open(demand_owner(directory.path()))
        .await
        .unwrap();
    import(
        &root,
        "demand-source",
        vec![record("source", "turn", "oldneedle", 1)],
    )
    .await;
    let first = root
        .search_history("demand-", query("oldneedle"), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(first.hits.len(), 1);
    let late = "demand-late".to_owned();
    import(
        &root,
        &late,
        vec![record("late", "late", "oldneedle late", 2)],
    )
    .await;
    let revision = root
        .get_session::<Value>("demand-source")
        .await
        .unwrap()
        .unwrap()
        .revision;
    assert!(matches!(
        root.copy_session(
            SessionCopy {
                source_session_id: "demand-source".into(),
                target_session_id: "demand-copy".into(),
                expected_source_revision: revision,
                purpose: CopyPurpose::Branch {
                    position: ForkPosition::End,
                    side_conversation: false
                },
            },
            &json!({}),
            1_700_002_000_000
        )
        .await
        .unwrap(),
        SessionCopyResult::Committed(_)
    ));
    crate::test_store::inspect_cache(&root.log, |db| {
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM transcript_directory WHERE owner_key='demand-copy'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    })
    .await;
    let frozen = root
        .log
        .search_published_through(
            "demand-".into(),
            query("oldneedle"),
            first.hits[0].through,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        frozen
            .hits
            .iter()
            .map(|hit| hit.session_id.as_str())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["demand-source", "demand-copy"])
    );
    assert!(
        frozen
            .hits
            .iter()
            .all(|hit| hit.through == first.hits[0].through)
    );
    let current = root
        .search_history("demand-", query("oldneedle"), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(current.hits.len(), 3);
    root.close().await.unwrap();
}

#[tokio::test]
async fn cancelled_source_catchup_rolls_back_its_scope_and_resumes_after_reopen() {
    use rusqlite::functions::FunctionFlags;
    let directory = tempfile::tempdir().unwrap();
    let owner = demand_owner(directory.path());
    let root = RootStore::open(owner.clone()).await.unwrap();
    import(
        &root,
        "demand-cancel",
        vec![
            record("first", "first", "needle first", 1),
            record("second", "second", "needle second", 2),
        ],
    )
    .await;
    let cancellation = CancellationToken::new();
    let stop = cancellation.clone();
    crate::test_store::inspect_cache(&root.log, move |db| {
        db.create_scalar_function("cancel_recall", 0, FunctionFlags::SQLITE_UTF8, move |_| {
            stop.cancel(); Ok(0_i64)
        }).unwrap();
        db.execute_batch("CREATE TEMP TRIGGER cancel_recall_source BEFORE INSERT ON temp.recall_progress WHEN NEW.owner_key='demand-cancel' BEGIN SELECT cancel_recall(); END;").unwrap();
    }).await;
    assert!(
        root.search_history("demand-", query("needle"), cancellation)
            .await
            .is_err()
    );
    crate::test_store::inspect_cache(&root.log, |db| {
        assert_eq!(
            db.query_row("SELECT count(*) FROM transcript_directory", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        for table in [
            "recall_terms",
            "recall_progress",
            "transcript_directory",
            "transcript_directory_progress",
        ] {
            assert_eq!(
                db.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
        db.execute_batch("DROP TRIGGER cancel_recall_source")
            .unwrap();
    })
    .await;
    root.close().await.unwrap();
    let root = RootStore::open(owner).await.unwrap();
    let found = root
        .search_history("demand-", query("needle"), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(found.hits.len(), 2);
    root.close().await.unwrap();
}

#[tokio::test]
async fn unindexed_copy_retains_source_material_and_last_owner_removal_clears_recall() {
    use crate::sessions::{MaterialCollection, SessionCopy, SessionCopyResult};
    use maka_agent_facts::session::{CopyPurpose, ForkPosition};
    let directory = tempfile::tempdir().unwrap();
    let root = RootStore::open(demand_owner(directory.path()))
        .await
        .unwrap();
    import(
        &root,
        "demand-source",
        vec![record("original", "original", "retainedneedle", 1)],
    )
    .await;
    let revision = root
        .get_session::<Value>("demand-source")
        .await
        .unwrap()
        .unwrap()
        .revision;
    assert!(matches!(
        root.copy_session(
            SessionCopy {
                source_session_id: "demand-source".into(),
                target_session_id: "demand-copy".into(),
                expected_source_revision: revision,
                purpose: CopyPurpose::Branch {
                    position: ForkPosition::End,
                    side_conversation: false
                },
            },
            &json!({}),
            1_700_002_000_000
        )
        .await
        .unwrap(),
        SessionCopyResult::Committed(_)
    ));
    assert!(matches!(
        root.remove_session_family("demand-source", revision)
            .await
            .unwrap(),
        RemoveFamilyResult::Accepted(_)
    ));
    assert_eq!(
        root.finish_session_retirement("demand-source")
            .await
            .unwrap(),
        SessionRetirement::Removed
    );
    assert_eq!(
        root.log.collect_session_material(None).await.unwrap(),
        MaterialCollection::Retained("demand-source".into())
    );
    let found = root
        .search_history("demand-", query("retainedneedle"), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(found.hits.len(), 1);
    assert_eq!(found.hits[0].session_id, "demand-copy");
    let revision = root
        .get_session::<Value>("demand-copy")
        .await
        .unwrap()
        .unwrap()
        .revision;
    assert!(matches!(
        root.remove_session_family("demand-copy", revision)
            .await
            .unwrap(),
        RemoveFamilyResult::Accepted(_)
    ));
    assert_eq!(
        root.finish_session_retirement("demand-copy").await.unwrap(),
        SessionRetirement::Removed
    );
    crate::test_store::inspect_cache(&root.log, |db| {
        for table in ["transcript_directory", "recall_terms", "recall_progress"] {
            assert_eq!(
                db.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
    })
    .await;
    root.close().await.unwrap();
}

#[tokio::test]
async fn cached_namespace_failure_stays_explicit_without_replaying_sources() {
    let directory = tempfile::tempdir().unwrap();
    let root = RootStore::open(demand_owner(directory.path()))
        .await
        .unwrap();
    let session = "demand-namespace";
    import(
        &root,
        session,
        vec![
            record("first", "first", "needle first", 1),
            record("second", "second", "needle second", 2),
        ],
    )
    .await;
    import(
        &root,
        "demand-healthy",
        vec![record("healthy", "healthy", "needle healthy", 3)],
    )
    .await;
    let conflicting_message = crate::test_store::inspect_cache(&root.log, |db| {
        let mut statement = db.prepare(
            "SELECT sequence FROM runtime_events WHERE event_session='demand-namespace' ORDER BY sequence",
        ).unwrap();
        let sources = statement.query_map([], |row| row.get::<_, i64>(0)).unwrap()
            .collect::<Result<Vec<_>, _>>().unwrap();
        let rows = sources.into_iter().flat_map(|source| {
            crate::transcript::directory::source_on_handle(db, "demand-namespace", source).unwrap()
        }).collect::<Vec<_>>();
        assert_eq!(rows.len(), 2);
        crate::transcript::directory::ensure_recall_on_handle(
            db, "demand-namespace", rows[0].position.source_sequence, &CancellationToken::new(),
        ).unwrap();
        db.execute(
            "UPDATE temp.transcript_directory SET message_id=?1 WHERE owner_key='demand-namespace'",
            [&rows[1].message.id],
        ).unwrap();
        rows[1].message.id.clone()
    }).await;
    let first = root
        .search_history("demand-", query("needle"), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(first.hits.len(), 1);
    assert_eq!(first.hits[0].session_id, "demand-healthy");
    assert_eq!(first.gaps.len(), 1);
    assert!(first.gaps[0].contains("demand-namespace"));
    assert!(first.gaps[0].contains("namespace: message identity is already claimed"));
    crate::test_store::inspect_cache(&root.log, |db| {
        assert_eq!(db.query_row(
            "SELECT count(*) FROM temp.transcript_failures WHERE owner_key='demand-namespace' AND category='namespace'",
            [], |row| row.get::<_, i64>(0),
        ).unwrap(), 1);
        let progress: i64 = db.query_row(
            "SELECT through_sequence FROM temp.transcript_directory_progress WHERE owner_key='demand-namespace'",
            [], |row| row.get(0),
        ).unwrap();
        let through: i64 = db.query_row(
            "SELECT MAX(sequence) FROM event_log", [], |row| row.get(0),
        ).unwrap();
        assert_eq!(progress, through);
        assert_eq!(db.query_row("SELECT count(*) FROM temp.transcript_directory WHERE owner_key='demand-namespace'", [], |row| row.get::<_, i64>(0)).unwrap(), 1, "failed source must not publish partial metadata");
        assert_eq!(db.query_row("SELECT through_source_sequence FROM temp.recall_progress WHERE owner_key='demand-namespace'", [], |row| row.get::<_, i64>(0)).unwrap(), through);
        db.execute_batch("CREATE TEMP TRIGGER fail_namespace_replay BEFORE INSERT ON temp.transcript_directory WHEN NEW.owner_key='demand-namespace' BEGIN SELECT RAISE(ABORT,'namespace source replayed'); END;").unwrap();
    }).await;
    let warm = root
        .search_history("demand-", query("needle"), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(warm.hits.len(), 1);
    assert_eq!(warm.hits[0].session_id, "demand-healthy");
    assert_eq!(warm.gaps, first.gaps);
    assert!(matches!(
        root.history_context(
            "demand-",
            session,
            &conflicting_message,
            0,
            0,
            None,
            None,
            None,
            CancellationToken::new()
        )
        .await,
        Err(crate::StoreError::TranscriptConflict),
    ));
    assert!(root.get_session::<Value>(session).await.unwrap().is_some());
    root.close().await.unwrap();
}

#[tokio::test]
async fn recall_reused_directory_rowid_has_only_new_terms_and_failed_build_is_atomic() {
    let directory = tempfile::tempdir().unwrap();
    let root = RootStore::open(demand_owner(directory.path()))
        .await
        .unwrap();
    let old_session = "demand-reuse-old";
    import(
        &root,
        old_session,
        vec![record("old", "old", "oldcacheword", 1)],
    )
    .await;
    let old = root
        .search_history("demand-", query("oldcacheword"), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(old.hits.len(), 1);
    let old_rowid: i64 = crate::test_store::inspect_cache(&root.log, |db| {
        let rowid = db.query_row("SELECT rowid FROM temp.transcript_directory WHERE owner_key='demand-reuse-old'", [], |row| row.get(0)).unwrap();
        db.execute_batch("DELETE FROM temp.transcript_directory WHERE owner_key='demand-reuse-old';
            DELETE FROM temp.transcript_directory_progress WHERE owner_key='demand-reuse-old';
            DELETE FROM temp.recall_progress WHERE owner_key='demand-reuse-old';").unwrap();
        assert_eq!(db.query_row("SELECT count(*) FROM temp.recall_terms", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        db.execute_batch("CREATE TEMP TRIGGER fail_recall_rebuild BEFORE INSERT ON temp.recall_progress BEGIN SELECT RAISE(ABORT,'Recall rebuild failed'); END;").unwrap();
        rowid
    }).await;
    let new_session = "demand-reuse-new".to_owned();
    import(
        &root,
        &new_session,
        vec![record("new", "new", "newcacheword", 2)],
    )
    .await;
    let mut current = query("newcacheword");
    current.session_id = Some(new_session.clone());
    assert!(
        root.search_history("demand-", current.clone(), CancellationToken::new())
            .await
            .is_err()
    );
    crate::test_store::inspect_cache(&root.log, |db| {
        for table in [
            "transcript_directory",
            "transcript_directory_progress",
            "recall_terms",
            "recall_progress",
        ] {
            assert_eq!(
                db.query_row(&format!("SELECT count(*) FROM temp.{table}"), [], |row| row
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
        db.execute_batch("DROP TRIGGER fail_recall_rebuild")
            .unwrap();
    })
    .await;
    let new = root
        .search_history("demand-", current, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(new.hits.len(), 1);
    assert_eq!(new.hits[0].body, "newcacheword");
    let selected = new_session.clone();
    crate::test_store::inspect_cache(&root.log, move |db| {
        let rowid: i64 = db
            .query_row(
                "SELECT rowid FROM temp.transcript_directory WHERE owner_key=?1",
                [selected],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rowid, old_rowid, "fixture must exercise rowid reuse");
        let mut count = db
            .prepare("SELECT count(*) FROM recall_terms WHERE recall_terms MATCH ?1")
            .unwrap();
        assert_eq!(
            count
                .query_row([crate::recall::grams("oldcacheword")], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            count
                .query_row([crate::recall::grams("newcacheword")], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    })
    .await;
    let mut obsolete = query("oldcacheword");
    obsolete.session_id = Some(new_session);
    assert!(
        root.search_history("demand-", obsolete, CancellationToken::new())
            .await
            .unwrap()
            .hits
            .is_empty()
    );
    root.close().await.unwrap();
}

#[tokio::test]
async fn recall_indexes_tool_calls_ranks_multi_term_matches_and_exposes_compacted_turn_prefix() {
    let directory = tempfile::tempdir().unwrap();
    let root = RootStore::open(demand_owner(directory.path()))
        .await
        .unwrap();
    let session = "demand-midturn";
    root.import_session(
        &PluginSession {
            session_id: session.into(),
            creator: maka_capabilities::storage::Namespace::new(
                "recall-index-test",
                maka_plugin_core::scope::Scope::Profile,
            )
            .unwrap(),
            fingerprint: "import-midturn".into(),
            authority_session_id: None,
        },
        &Source {
            adapter: "fixture".into(),
            session_id: "source-midturn".into(),
        },
        &json!({}),
        vec![
            Record {
                source_message_id: "stub-one-term".into(),
                source_turn_id: "turn-old-stub".into(),
                timestamp: Some(100),
                content: Content::User {
                    text: "checkpointmark stub?".into(),
                },
            },
            Record {
                source_message_id: "detailed-multi-term".into(),
                source_turn_id: "turn-old-detailed".into(),
                timestamp: Some(50),
                content: Content::Assistant {
                    text: format!(
                        "Architectural rationale for checkpointmark and tailfence with replayguard: {}",
                        "detailed verification steps and invariants ".repeat(20)
                    ),
                    model: None,
                    thinking: None,
                },
            },
            Record {
                source_message_id: "single-hit-short".into(),
                source_turn_id: "turn-single-short".into(),
                timestamp: Some(90),
                content: Content::Assistant {
                    text: "check sublinearneedle maybe later...".into(),
                    model: None,
                    thinking: None,
                },
            },
            Record {
                source_message_id: "repeated-hit-detailed".into(),
                source_turn_id: "turn-repeated-detailed".into(),
                timestamp: Some(40),
                content: Content::Assistant {
                    text: format!(
                        "sublinearneedle invariants: sublinearneedle handles boundary A, sublinearneedle handles boundary B, sublinearneedle handles boundary C, sublinearneedle handles boundary D, sublinearneedle handles boundary E. {}",
                        "context ".repeat(40)
                    ),
                    model: None,
                    thinking: None,
                },
            },
            Record {
                source_message_id: "midturn-user".into(),
                source_turn_id: "active-turn".into(),
                timestamp: Some(200),
                content: Content::User {
                    text: "Early compacted user constraint midturnalpha".into(),
                },
            },
            Record {
                source_message_id: "midturn-tool-call".into(),
                source_turn_id: "active-turn".into(),
                timestamp: Some(201),
                content: Content::ToolCall {
                    call_id: "call-edit-1".into(),
                    name: "Edit".into(),
                    input: Some(json!({
                        "file_path": "plugins/agent/engine/src/compact.rs",
                        "old_string": "let threshold = \"legacy_limit\";",
                        "new_string": "let threshold = usable_budget;",
                    })),
                },
            },
            Record {
                source_message_id: "live-tail-msg".into(),
                source_turn_id: "active-turn".into(),
                timestamp: Some(202),
                content: Content::Assistant {
                    text: "Uncompacted live tail mentions midturnalpha and livetailonly".into(),
                    model: None,
                    thinking: None,
                },
            },
        ],
        1,
    )
    .await
    .unwrap();

    // 1. Multi-term coordination: 3 matched terms in a long message outranks 1 matched term in a tiny stub.
    let mut multi = query("checkpointmark");
    multi
        .terms
        .extend(["tailfence".into(), "replayguard".into()]);
    let multi_hits = root
        .search_history("demand-", multi, CancellationToken::new())
        .await
        .unwrap()
        .hits;
    assert_eq!(multi_hits.len(), 2);
    assert!(multi_hits[0].body.starts_with("Architectural rationale"));
    assert_eq!(multi_hits[0].matched_terms.len(), 3);
    assert_eq!(multi_hits[1].body, "checkpointmark stub?");
    assert_eq!(multi_hits[1].matched_terms.len(), 1);

    // 2. Sublinear sqrt length normalization: repeated occurrences in a detailed explanation beat a casual 1-hit stub.
    let sublinear_hits = root
        .search_history(
            "demand-",
            query("sublinearneedle"),
            CancellationToken::new(),
        )
        .await
        .unwrap()
        .hits;
    assert_eq!(sublinear_hits.len(), 2);
    assert!(
        sublinear_hits[0]
            .body
            .starts_with("sublinearneedle invariants:")
    );
    assert_eq!(
        sublinear_hits[1].body,
        "check sublinearneedle maybe later..."
    );

    // 3. ToolCall name and unescaped arguments (file paths, quoted code) are indexed and rendered cleanly.
    let mut tool_search = query("plugins/agent/engine/src/compact.rs");
    tool_search
        .terms
        .push("let threshold = \"legacy_limit\"".into());
    let tool_hits = root
        .search_history("demand-", tool_search, CancellationToken::new())
        .await
        .unwrap()
        .hits;
    assert_eq!(tool_hits.len(), 1);
    assert_eq!(
        tool_hits[0].role,
        maka_agent_ports::session::history::Role::ToolCall
    );
    assert!(
        tool_hits[0].body.starts_with("Edit\n"),
        "{}",
        tool_hits[0].body
    );
    assert!(
        tool_hits[0]
            .body
            .contains("file_path: plugins/agent/engine/src/compact.rs"),
        "{}",
        tool_hits[0].body
    );
    assert!(
        tool_hits[0]
            .body
            .contains("old_string: let threshold = \"legacy_limit\";"),
        "{}",
        tool_hits[0].body
    );
    let compacted_cutoff = tool_hits[0].position.source_sequence;
    let active_turn_id = tool_hits[0].turn_id.clone();

    // 4. ExcludedTurnTail with covered_through = 0 excludes the entire active turn,
    //    whereas covered_through = compacted_cutoff exposes the compacted prefix and still excludes the live tail.
    let mut uncompacted_query = query("midturnalpha");
    uncompacted_query.exclude = Some(ExcludedTurnTail {
        session_id: session.into(),
        turn_id: active_turn_id.clone(),
        covered_through: 0,
    });
    assert!(
        root.search_history("demand-", uncompacted_query, CancellationToken::new())
            .await
            .unwrap()
            .hits
            .is_empty()
    );

    let mut midturn_query = query("midturnalpha");
    let exclusion = ExcludedTurnTail {
        session_id: session.into(),
        turn_id: active_turn_id,
        covered_through: compacted_cutoff,
    };
    midturn_query.exclude = Some(exclusion.clone());
    let midturn_hits = root
        .search_history("demand-", midturn_query, CancellationToken::new())
        .await
        .unwrap()
        .hits;
    assert_eq!(midturn_hits.len(), 1);
    assert_eq!(
        midturn_hits[0].body,
        "Early compacted user constraint midturnalpha"
    );

    let mut tail_only = query("livetailonly");
    tail_only.exclude = Some(exclusion.clone());
    assert!(
        root.search_history("demand-", tail_only, CancellationToken::new())
            .await
            .unwrap()
            .hits
            .is_empty(),
        "uncompacted live tail after covered_through must remain excluded"
    );

    // 5. history_context allows compacted prefix anchors & ToolCall neighbors, stopping at covered_through.
    let context = root
        .history_context(
            "demand-",
            session,
            &midturn_hits[0].message_id,
            0,
            5,
            None,
            Some(exclusion.clone()),
            None,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        context.anchor.body,
        "Early compacted user constraint midturnalpha"
    );
    assert_eq!(context.messages.len(), 1);
    assert_eq!(
        context.messages[0].role,
        maka_agent_ports::session::history::Role::ToolCall
    );
    assert!(
        context.messages[0]
            .body
            .contains("plugins/agent/engine/src/compact.rs")
    );
    assert!(
        !context.has_more_after,
        "live tail must not leak into after lookahead"
    );

    root.close().await.unwrap();
}

#[tokio::test]
async fn history_context_orders_neighbors_by_display_seat_across_interleaved_executor_tools() {
    use maka_agent_facts::{
        event::{EventWrite, Fact, Invocation, InvocationInput, InvocationOutcome, RuntimeEvent},
        executor::{Binding, Output},
    };
    let directory = tempfile::tempdir().unwrap();
    let root = RootStore::open(demand_owner(directory.path()))
        .await
        .unwrap();
    let session = "demand-executor-order";
    root.create_session(session, "create-executor-order", &json!({}), 1)
        .await
        .unwrap();
    let log = root.session(session).await.unwrap();
    let invocation = Invocation {
        session_id: session.into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "inv".into(),
    };
    let event = |fact| EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap();
    log.append(&event(Fact::InvocationOpened {
        input: InvocationInput::Message {
            content: "Check workspace layout".into(),
            source_messages: vec![],
            request_fingerprint: None,
        },
        configuration: Some(Box::new(
            maka_agent_facts::execution::InvocationConfiguration {
                language: maka_agent_facts::language::Language::En,
                compaction_prompt: None,
                workspace_origin: maka_agent_facts::execution::WorkspaceOrigin::Selected,
                approval_policy: maka_agent_facts::execution::ApprovalPolicy::OnRequest,
                boundary_revision: 0,
                cwd: directory.path().to_string_lossy().into_owned(),
                workspace_binding: None,
                workspace_identity: None,
                model: None,
                editing_tools: None,
                tool_discovery: false,
                tool_composition: None,
                system_prompt: None,
                thinking_level: None,
                sandbox_mode: maka_agent_facts::execution::SandboxMode::WorkspaceWrite,
                collaboration_mode: maka_agent_facts::execution::CollaborationMode::Agent,
                tool_mode: maka_agent_facts::execution::ToolMode::Direct,
                code_language: Default::default(),
            },
        )),
    }))
    .await
    .unwrap();
    log.append(&event(Fact::ExecutorStarted {
        settings: Default::default(),
        binding: Binding {
            executor_id: "claude".to_owned().try_into().unwrap(),
            package_id: "pkg".into(),
            entry_id: "entry".into(),
            activation: "act".into(),
        },
    }))
    .await
    .unwrap();
    for output in [
        Output::MessageStart {
            message_id: "m1".into(),
        },
        Output::OutputDelta {
            message_id: "m1".into(),
            text: "Inspecting cargomanifestneedle".into(),
        },
        Output::ToolStart {
            tool_call_id: "c1".into(),
            name: "Read".into(),
            input: json!({"file_path":"Cargo.toml"}),
        },
        Output::ToolResult {
            tool_call_id: "c1".into(),
            text: "[workspace]".into(),
            is_error: false,
        },
        Output::MessageEnd {
            message_id: "m1".into(),
        },
    ] {
        log.append(&event(Fact::ExecutorObserved { output }))
            .await
            .unwrap();
    }
    log.append(&event(Fact::ExecutorCompleted {
        message_id: Some("m1".into()),
    }))
    .await
    .unwrap();
    log.append(&event(Fact::InvocationEnded {
        outcome: InvocationOutcome::Completed,
    }))
    .await
    .unwrap();

    let hits = root
        .search_history(
            "demand-",
            query("cargomanifestneedle"),
            CancellationToken::new(),
        )
        .await
        .unwrap()
        .hits;
    assert_eq!(hits.len(), 1);
    let context = root
        .history_context(
            "demand-",
            session,
            &hits[0].message_id,
            1,
            1,
            None,
            None,
            None,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(context.anchor.body, "Inspecting cargomanifestneedle");
    let roles: Vec<_> = context
        .messages
        .iter()
        .map(|hit| (hit.role, hit.body.as_str()))
        .collect();
    assert_eq!(roles.len(), 2);
    assert_eq!(
        roles[0],
        (
            maka_agent_ports::session::history::Role::User,
            "Check workspace layout"
        )
    );
    assert_eq!(
        roles[1].0,
        maka_agent_ports::session::history::Role::ToolCall
    );
    assert!(roles[1].1.contains("Cargo.toml"));
    root.close().await.unwrap();
}
