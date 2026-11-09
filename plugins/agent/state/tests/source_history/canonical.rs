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

use crate::support;
use maka_agent_facts::{
    durable::*,
    history::HistoryRowAddress,
    history_snapshot::{Origin, SnapshotId},
};
use maka_agent_state::session_history::{
    snapshot::CaptureRequest,
    source_tree::{SourceItem, SourceTree},
};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn published_source_damage_stays_cut_local_and_cannot_publish_or_repair_original_bytes() {
    use maka_agent_facts::model::{ModelPart, TextKind};
    use maka_event_log::{
        StoreError,
        connection::Query,
        writeback::{Notification, Prepared, Statement},
    };
    use rusqlite::{Connection, OptionalExtension, params};
    struct Damage {
        run: RunId,
        fact: FactId,
        alias: Option<StepId>,
    }
    impl Statement for Damage {
        type Value = Vec<u8>;
        type Output = Vec<u8>;
        fn execute(self, c: &Connection) -> Result<Prepared<Vec<u8>>, StoreError> {
            let (content,mut bytes):(i64,Vec<u8>)=c.query_row("SELECT f.body_content_id,b.payload FROM agent_facts f JOIN contents b ON b.id=f.body_content_id WHERE f.run=? AND f.id=?",params![self.run.to_string(),self.fact.to_string()],|row|Ok((row.get(0)?,row.get(1)?)))?;
            if let Some(alias) = self.alias {
                let exists: bool = c.query_row(
                    "SELECT EXISTS(SELECT 1 FROM agent_request_specs WHERE run=? AND step=?)",
                    params![self.run.to_string(), alias.to_string()],
                    |row| row.get(0),
                )?;
                assert!(
                    exists,
                    "the alias must be another actually registered Step, not an unknown id"
                );
                assert_eq!(
                    c.execute(
                        "UPDATE agent_session_history SET step=? WHERE run=? AND fact_id=?",
                        params![
                            alias.to_string(),
                            self.run.to_string(),
                            self.fact.to_string()
                        ]
                    )?,
                    1
                );
            } else {
                let needle = b"selected-original";
                let at = bytes
                    .windows(needle.len())
                    .position(|window| window == needle)
                    .expect("actual selected ModelObserved body");
                bytes[at] = b'X';
                let changed: RecordedFact = serde_json::from_slice(&bytes)?;
                assert_eq!(
                    (changed.run, changed.id, changed.schema_version),
                    (self.run, self.fact, SCHEMA_VERSION)
                );
                let trigger:Option<String>=c.query_row("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='content_immutable'",[],|row|row.get(0)).optional()?;
                if trigger.is_some() {
                    c.execute_batch("DROP TRIGGER content_immutable")?;
                }
                assert_eq!(
                    c.execute(
                        "UPDATE contents SET payload=? WHERE id=?",
                        params![bytes, content]
                    )?,
                    1
                );
                if let Some(trigger) = trigger {
                    c.execute_batch(&trigger)?;
                }
            }
            Ok(Prepared {
                value: bytes,
                changed: true,
                notification: Notification::NONE,
            })
        }
        fn committed(value: Vec<u8>) -> Vec<u8> {
            value
        }
        fn isolated_rejection(_: &StoreError) -> bool {
            false
        }
    }
    struct Inspect {
        run: RunId,
        fact: FactId,
        snapshot: SnapshotId,
    }
    struct DamageLabel {
        fact: FactId,
        column: &'static str,
        value: String,
    }
    impl Statement for DamageLabel {
        type Value = ();
        type Output = ();
        fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
            assert!(matches!(
                self.column,
                "kind" | "tool_use_id" | "owner" | "session"
            ));
            assert_eq!(
                c.execute(
                    &format!(
                        "UPDATE agent_session_history SET {}=? WHERE fact_id=?",
                        self.column
                    ),
                    params![self.value, self.fact.to_string()]
                )?,
                1
            );
            Ok(Prepared {
                value: (),
                changed: true,
                notification: Notification::NONE,
            })
        }
        fn committed(_: ()) {}
        fn isolated_rejection(_: &StoreError) -> bool {
            false
        }
    }
    impl Query for Inspect {
        type Output = (Vec<u8>, String, Option<String>, String, bool);
        fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
            let (bytes,digest,step,prefix)=c.query_row("SELECT b.payload,b.content_sha256,h.step,h.prefix_digest FROM agent_facts f JOIN contents b ON b.id=f.body_content_id JOIN agent_session_history h ON h.sequence=f.sequence WHERE f.run=? AND f.id=?",params![self.run.to_string(),self.fact.to_string()],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)))?;
            let published:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_history_snapshots WHERE snapshot=?1) OR EXISTS(SELECT 1 FROM agent_history_snapshot_entries WHERE snapshot=?1) OR EXISTS(SELECT 1 FROM agent_history_snapshot_pins WHERE snapshot=?1)",[self.snapshot.to_string()],|row|row.get(0))?;
            Ok((bytes, digest, step, prefix, published))
        }
    }
    fn source_error(error: StoreError, expected: &str) {
        assert!(
            matches!(error.underlying(),StoreError::InvalidTransition(reason) if reason.contains(expected))
                || matches!(error.underlying(),StoreError::Io(reason) if reason.kind()==std::io::ErrorKind::InvalidData && ["hash","digest","corrupt"].iter().any(|word|reason.to_string().contains(word))),
            "expected selected source failure {expected}, got {error}"
        );
    }
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "session").await;
    let store = support::state(&root);
    let data = root.data_writer().unwrap();
    let run = support::admit(&store, "session", "damaged-source", "healthy prefix").await;
    let history = store.session_history(support::owner(), "session".into());
    let (step, request, contents) = support::request(vec![]);
    let attempt = ModelAttemptId::new();
    support::append(
        &store,
        run,
        vec![
            Fact::StepPrepared {
                step,
                request: request.reference().clone(),
                adjudications: vec![],
            },
            Fact::ModelAttemptPrepared { attempt, step },
            Fact::ModelAttemptAdmitted {
                attempt,
                upstream: serde_json::json!({"fixture":"admitted"}),
            },
        ],
        contents,
    )
    .await;
    let before = history.capture().await.unwrap();
    let prefix = history.page(&before, 0, 128).await.unwrap();
    let frozen_prefix = history
        .capture_snapshot(
            CaptureRequest {
                id: SnapshotId::try_from(uuid::Uuid::new_v4()).unwrap(),
                cut: before.clone(),
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
    support::append(
        &store,
        run,
        vec![
            Fact::ModelObserved {
                attempt,
                index: 0,
                part: ModelPart::Text {
                    text_kind: TextKind::Text,
                    text: "selected-original中\0🙂".into(),
                    provider_options: None,
                },
                continuation: None,
            },
            Fact::ModelClosed {
                attempt,
                outcome: maka_agent_facts::accounting::Outcome::Success,
                diagnostic: None,
                usage: Default::default(),
                protocol: serde_json::json!({}),
            },
            Fact::ModelCleanupObserved {
                attempt,
                cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed,
            },
        ],
        vec![],
    )
    .await;
    let (alias, request, contents) = support::request(vec![]);
    support::append(
        &store,
        run,
        vec![Fact::StepPrepared {
            step: alias,
            request: request.reference().clone(),
            adjudications: vec![],
        }],
        contents,
    )
    .await;
    let after = history.capture().await.unwrap();
    let accepted = history.page(&after, 0, 128).await.unwrap();
    assert_eq!(
        history
            .previous_page(&after, None, 128)
            .await
            .unwrap()
            .items,
        accepted.items,
        "None includes the actual tail, in canonical order"
    );
    let mut before_sequence = None;
    let mut backwards = Vec::new();
    loop {
        let page = history
            .previous_page(&after, before_sequence, 2)
            .await
            .unwrap();
        let mut current = page.items;
        current.extend(backwards);
        backwards = current;
        let Some(next) = page.next else {
            break;
        };
        assert!(before_sequence.is_none_or(|prior| next < prior));
        before_sequence = Some(next);
    }
    assert_eq!(backwards, accepted.items);
    let selected=accepted.items.iter().find(|item|matches!(&item.recorded.fact,Fact::ModelObserved {attempt:actual,..} if *actual==attempt)).unwrap().clone();
    assert_eq!(selected.scope.step, Some(step));
    assert_ne!(step, alias);
    assert!(accepted.items.iter().any(
        |item| matches!(&item.recorded.fact,Fact::StepPrepared {step:actual,..} if *actual==alias)
            && item.scope.step == Some(alias)
    ));
    let saved = history
        .capture_snapshot(
            CaptureRequest {
                id: SnapshotId::try_from(uuid::Uuid::new_v4()).unwrap(),
                cut: after.clone(),
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        saved.item(selected.sequence).await.unwrap().unwrap(),
        selected
    );
    let id = selected.recorded.id;
    let original_head = store.frontier(run).await.unwrap();
    let failed = SnapshotId::try_from(uuid::Uuid::new_v4()).unwrap();
    let original = data
        .query(Inspect {
            run,
            fact: id,
            snapshot: failed,
        })
        .await
        .unwrap();
    assert!(!original.4);
    data.write(Damage {
        run,
        fact: id,
        alias: Some(alias),
    })
    .await
    .unwrap();
    source_error(
        history.page(&after, 0, 128).await.unwrap_err(),
        "header scope differs",
    );
    source_error(
        history.previous_page(&after, None, 128).await.unwrap_err(),
        "header scope differs",
    );
    let Err(error) = history
        .capture_snapshot(
            CaptureRequest {
                id: failed,
                cut: after.clone(),
            },
            CancellationToken::new(),
        )
        .await
    else {
        panic!("capture must not repair the wrong cached source identity");
    };
    source_error(error, "header scope differs");
    let wrong = data
        .query(Inspect {
            run,
            fact: id,
            snapshot: failed,
        })
        .await
        .unwrap();
    assert_eq!(
        (&wrong.0, &wrong.1, &wrong.3),
        (&original.0, &original.1, &original.3)
    );
    assert_eq!(wrong.2, Some(alias.to_string()));
    assert!(!wrong.4);
    assert_eq!(history.page(&before, 0, 128).await.unwrap(), prefix);
    assert_eq!(
        history.rebuild().await.unwrap(),
        after,
        "explicit derived-index repair uses the unchanged canonical source"
    );
    assert_eq!(
        history
            .item(&after, selected.sequence)
            .await
            .unwrap()
            .unwrap(),
        selected
    );
    support::create(&root, "other").await;
    let (mut other_spec, other_contents) =
        support::spec("other", "other-owner", "registered namespace");
    other_spec.owner.deployment = uuid::Uuid::from_u128(99);
    let other_owner = serde_json::to_string(&other_spec.owner).unwrap();
    store
        .admit(maka_agent_state::Admission::new(
            other_spec,
            UnixMillis(50),
            other_contents,
        ))
        .await
        .unwrap();
    let tail = accepted.items.last().unwrap().recorded.id;
    for target in [id, tail] {
        for (column, value) in [
            ("kind", "model_closed".to_owned()),
            ("tool_use_id", "unexpected-source-tool".to_owned()),
            ("owner", other_owner.clone()),
            ("session", "other".to_owned()),
        ] {
            assert_eq!(
                history.page(&after, 0, 128).await.unwrap().items,
                accepted.items,
                "positive baseline before each actual cached-label fault"
            );
            data.write(DamageLabel {
                fact: target,
                column,
                value,
            })
            .await
            .unwrap();
            for error in [
                history.page(&after, 0, 128).await.unwrap_err(),
                history.previous_page(&after, None, 128).await.unwrap_err(),
            ] {
                assert!(
                    matches!(error.underlying(),StoreError::InvalidTransition(reason) if ["history","source","cut","projection"].iter().any(|word|reason.contains(word))),
                    "wrong cached {column} must be a projection failure, not missing Root/id or JSON: {error}"
                );
            }
            let failed_label = SnapshotId::try_from(uuid::Uuid::new_v4()).unwrap();
            let Err(error) = history
                .capture_snapshot(
                    CaptureRequest {
                        id: failed_label,
                        cut: after.clone(),
                    },
                    CancellationToken::new(),
                )
                .await
            else {
                panic!("wrong cached label must not publish a snapshot");
            };
            assert!(
                matches!(error.underlying(), StoreError::InvalidTransition(_)),
                "typed projection failure for {column}: {error}"
            );
            let unchanged = data
                .query(Inspect {
                    run,
                    fact: target,
                    snapshot: failed_label,
                })
                .await
                .unwrap();
            assert!(!unchanged.4);
            assert_eq!(history.page(&before, 0, 128).await.unwrap(), prefix);
            assert_eq!(
                history.rebuild().await.unwrap(),
                after,
                "only explicit canonical rebuild may restore derived labels"
            );
            assert_eq!(
                history.page(&after, 0, 128).await.unwrap().items,
                accepted.items
            );
            let restored = data
                .query(Inspect {
                    run,
                    fact: id,
                    snapshot: failed_label,
                })
                .await
                .unwrap();
            assert_eq!(
                (&restored.0, &restored.1, &restored.3),
                (&original.0, &original.1, &original.3)
            );
        }
    }
    let damaged = data
        .write(Damage {
            run,
            fact: id,
            alias: None,
        })
        .await
        .unwrap();
    assert_eq!(damaged.len(), original.0.len());
    assert_ne!(damaged, original.0);
    let failed_body = SnapshotId::try_from(uuid::Uuid::new_v4()).unwrap();
    source_error(
        history.page(&after, 0, 128).await.unwrap_err(),
        "canonical history bytes corrupt",
    );
    source_error(
        history.previous_page(&after, None, 128).await.unwrap_err(),
        "canonical history bytes corrupt",
    );
    let Err(error) = history
        .capture_snapshot(
            CaptureRequest {
                id: failed_body,
                cut: after.clone(),
            },
            CancellationToken::new(),
        )
        .await
    else {
        panic!("damaged selected source must not publish a complete Snapshot");
    };
    source_error(error, "original content hash differs");
    source_error(
        history.rebuild().await.unwrap_err(),
        "canonical history bytes corrupt",
    );
    source_error(
        saved.page(0, 128).await.unwrap_err(),
        "original content hash differs",
    );
    source_error(
        saved.item(selected.sequence).await.unwrap_err(),
        "original content hash differs",
    );
    let retained = data
        .query(Inspect {
            run,
            fact: id,
            snapshot: failed_body,
        })
        .await
        .unwrap();
    assert_eq!(retained.0, damaged);
    assert_eq!(retained.1, original.1);
    assert_eq!(retained.2, Some(step.to_string()));
    assert_eq!(retained.3, original.3);
    assert!(!retained.4);
    assert_eq!(history.capture().await.unwrap(), after);
    assert_eq!(store.frontier(run).await.unwrap(), original_head);
    assert_eq!(history.page(&before, 0, 128).await.unwrap(), prefix);
    assert_eq!(
        frozen_prefix.page(0, 128).await.unwrap().items,
        prefix.items
    );
    root.close().await.unwrap();
}

#[tokio::test]
async fn exact_cuts_bind_namespace_identity_and_original_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "session").await;
    support::create(&root, "other").await;
    let state = support::state(&root);
    let history = state.session_history(support::owner(), "session".into());
    let run = support::admit(&state, "session", "first", "中文\0 source🙂").await;
    let before = history.capture().await.unwrap();
    let original = history.run_source(run).await.unwrap();
    let item = history
        .item(&before, original.admission_sequence)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(item.recorded.run, run);
    assert_eq!(item.recorded.revision, 1);
    let request = CaptureRequest {
        id: SnapshotId::try_from(uuid::Uuid::new_v4()).unwrap(),
        cut: before.clone(),
    };
    let frozen = history
        .capture_snapshot(request.clone(), CancellationToken::new())
        .await
        .unwrap();
    let foreign = support::admit(&state, "other", "other", "unrelated").await;
    assert_eq!(history.capture().await.unwrap(), before);
    assert!(history.run_source(foreign).await.is_err());
    support::complete(&state, run).await;
    support::admit(&state, "session", "future", "must not enter the old cut").await;
    assert_eq!(frozen.page(0, 256).await.unwrap().items.len(), 1);
    assert_eq!(frozen.view_at(run).await.unwrap().revision, 1);
    assert!(frozen.view_at(run).await.unwrap().terminal.is_none());
    assert_eq!(
        frozen
            .item(original.admission_sequence)
            .await
            .unwrap()
            .unwrap(),
        item
    );
    let replay = history
        .capture_snapshot(request.clone(), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(replay.reference(), frozen.reference());
    assert!(
        matches!(frozen.manifest().await.unwrap().origin,Origin::Canonical{cut} if cut==before)
    );
    let mut forged = before.clone();
    forged.digest = "f".repeat(64);
    assert!(
        history
            .item(&forged, original.admission_sequence)
            .await
            .is_err()
    );
    let other = state.session_history(support::owner(), "other".into());
    assert!(
        other
            .item(&before, original.admission_sequence)
            .await
            .is_err()
    );
    let mut conflicting = request;
    conflicting.cut = history.capture().await.unwrap();
    assert!(
        history
            .capture_snapshot(conflicting, CancellationToken::new())
            .await
            .is_err()
    );
    root.close().await.unwrap();
}

#[tokio::test]
async fn qualified_source_rows_keep_inclusive_reverse_windows_and_reject_forged_facts() {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "session").await;
    let state = support::state(&root);
    let history = state.session_history(support::owner(), "session".into());
    for index in 0..4 {
        let run = support::admit(
            &state,
            "session",
            &format!("turn-{index}"),
            &format!("text-{index}"),
        )
        .await;
        support::complete(&state, run).await;
    }
    let cut = history.capture().await.unwrap();
    let source = history
        .capture_snapshot(
            CaptureRequest {
                id: SnapshotId::try_from(uuid::Uuid::new_v4()).unwrap(),
                cut: cut.clone(),
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let tree = SourceTree::snapshot(&source).await.unwrap();
    let rows = tree.positions(None, false, false, 256).await.unwrap();
    assert_eq!(rows.len(), 4);
    let reverse = tree.positions(None, true, false, 256).await.unwrap();
    assert_eq!(
        reverse.iter().map(|r| &r.address).collect::<Vec<_>>(),
        rows.iter().rev().map(|r| &r.address).collect::<Vec<_>>()
    );
    assert_eq!(
        tree.positions(Some(rows[1].address.clone()), false, false, 2)
            .await
            .unwrap()
            .iter()
            .map(|r| &r.address)
            .collect::<Vec<_>>(),
        rows[1..3].iter().map(|r| &r.address).collect::<Vec<_>>()
    );
    let SourceItem::Canonical(original) = tree.item(&rows[0].address).await.unwrap() else {
        panic!("canonical source")
    };
    assert_eq!(
        tree.event_position(original.sequence, false)
            .await
            .unwrap()
            .unwrap()
            .address,
        rows[0].address
    );
    let mut forged = rows[0].address.clone();
    let HistoryRowAddress::Snapshot { fact, .. } = &mut forged else {
        panic!("snapshot row")
    };
    *fact = FactId::new();
    assert!(tree.item(&forged).await.is_err());
    assert!(tree.positions(Some(forged), false, false, 1).await.is_err());
    assert!(
        tree.source_for_path(
            &[],
            Some(SnapshotId::try_from(uuid::Uuid::new_v4()).unwrap())
        )
        .await
        .is_err()
    );
    let live = SourceTree::live(&history, &cut).await.unwrap();
    assert!(live.is_live_only());
    let clipped = live.after_run(original.recorded.run).await.unwrap();
    assert!(!clipped.is_live_only());
    assert_eq!(
        clipped
            .positions(None, false, false, 256)
            .await
            .unwrap()
            .len(),
        rows.len() - 1
    );
    assert_eq!(
        live.positions(None, false, false, 256).await.unwrap().len(),
        rows.len()
    );
    root.close().await.unwrap();
}
