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

use crate::support::{self, imported::Tape};
use maka_agent_facts::{
    durable::{Fact, ModelAttemptId, UnixMillis},
    history_snapshot::{
        Entry, HistoricalRole, ImportedArtifactScope, ImportedMessage, ImportedPart,
        ImportedTurnOrdinal, SnapshotId,
    },
    model::{ModelPart, TextKind},
};
use maka_agent_state::session_history::{
    navigation::SourceFind, snapshot::ImportedCaptureRequest, source_tree::SourceTree,
};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn a_case_sensitive_no_match_page_keeps_one_budget_and_real_continuation_across_leaves() {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "base").await;
    support::create(&root, "session").await;
    let state = support::state(&root);
    let base = state.session_history(support::owner(), "base".into());
    let history = state.session_history(support::owner(), "session".into());
    let mut tape = Tape::new();
    let raw = tape.push_blob(b"immutable imported lower-case source");
    let thinking = tape.push_json(&ImportedPart::Model {
        part: ModelPart::Text {
            text_kind: TextKind::Thinking,
            text: "NEEDLE privateSnapshotOnly".into(),
            provider_options: None,
        },
    });
    let part = tape.push_json(&ImportedPart::Model {
        part: ModelPart::Text {
            text_kind: TextKind::Text,
            text: "NEE needle lowercase candidate".into(),
            provider_options: None,
        },
    });
    for ordinal in 0..40 {
        let message = ImportedMessage {
            turn_ordinal: ImportedTurnOrdinal(ordinal),
            original_ordinal: 0,
            media: vec![],
            source_message_id: Some(format!("message-{ordinal}")),
            source_turn_id: None,
            timestamp: Some(1),
            role: HistoricalRole::Assistant,
            artifact_scope: ImportedArtifactScope {
                owner: support::owner(),
                session: "base".into(),
            },
            parts: if ordinal == 0 {
                let mut parts = vec![thinking.clone(); 100];
                parts.push(part.clone());
                parts
            } else {
                vec![part.clone()]
            },
            provider_metadata: None,
            original: raw.clone(),
        };
        let body = tape.push_json(&message);
        tape.push_entry(&Entry::Imported {
            ordinal,
            message: body,
        });
    }
    let fingerprint = tape.original_source(
        vec![raw],
        maka_agent_facts::artifact::content_digest(b"immutable imported lower-case source"),
    );
    let snapshot = tape
        .capture(
            &base,
            ImportedCaptureRequest {
                id: SnapshotId::try_from(uuid::Uuid::new_v4()).unwrap(),
                source: maka_agent_facts::import::Source {
                    adapter: "fixture".into(),
                    session_id: "foreign".into(),
                },
                fingerprint,
            },
            CancellationToken::new(),
        )
        .await;
    let (spec, contents) = support::adoption_spec(&snapshot, "session", "baseline");
    let adoption = snapshot
        .adopt(
            &history,
            uuid::Uuid::new_v4(),
            spec,
            UnixMillis(2),
            contents,
        )
        .unwrap();
    let adopted = root.data_writer().unwrap().write(adoption).await.unwrap();
    for ordinal in 0..40 {
        let text = if ordinal == 39 {
            "NEEDLE final match"
        } else {
            "NEE needle lowercase candidate"
        };
        let run = support::admit(&state, "session", &format!("tail-{ordinal}"), text).await;
        if ordinal == 0 {
            let (step, request, contents) = support::request(vec![]);
            let attempt = ModelAttemptId::new();
            let mut facts = vec![
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
            ];
            for index in 0..100 {
                facts.push(Fact::ModelObserved {
                    attempt,
                    index,
                    part: ModelPart::Text {
                        text_kind: TextKind::Thinking,
                        text: "NEEDLE privateLiveOnly".into(),
                        provider_options: None,
                    },
                    continuation: None,
                });
            }
            facts.extend([
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
            ]);
            support::append(&state, run, facts, contents).await;
        }
        support::complete(&state, run).await;
    }
    let tree = SourceTree::live(&history, &history.capture().await.unwrap())
        .await
        .unwrap();
    let frozen = history
        .capture_snapshot(
            maka_agent_state::session_history::snapshot::CaptureRequest {
                id: SnapshotId::try_from(uuid::Uuid::new_v4()).unwrap(),
                cut: history.capture().await.unwrap(),
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let frozen_tree = SourceTree::snapshot(&frozen).await.unwrap();
    for view in [&tree, &frozen_tree] {
        let landmarks = view.landmarks(64, CancellationToken::new()).await.unwrap();
        let first_visible = view
            .positions(None, false, false, 1)
            .await
            .unwrap()
            .remove(0);
        assert_eq!(landmarks[0].position, first_visible.address);
        assert_eq!(landmarks[0].last_position, landmarks[0].position);
        assert!(!landmarks[0].label.contains("privateSnapshotOnly"));
        let tail = view.after_run(adopted.run).await.unwrap();
        let landmarks = tail.landmarks(64, CancellationToken::new()).await.unwrap();
        let first_local = landmarks
            .iter()
            .find(|item| item.turn_id.as_deref() == Some("tail-0"))
            .unwrap();
        assert_eq!(first_local.position, first_local.last_position);
        assert!(!first_local.label.contains("privateLiveOnly"));
        let private_cursor = view
            .positions(None, false, true, 1)
            .await
            .unwrap()
            .remove(0)
            .address;
        let from_private = view
            .find_page(
                SourceFind {
                    after: Some(private_cursor),
                    query: "absent phrase".into(),
                    case_sensitive: true,
                    whole_word: false,
                    include_internal: false,
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(from_private.matches.is_empty());
        for marker in ["privateSnapshotOnly", "privateLiveOnly"] {
            let query = |include_internal| SourceFind {
                after: None,
                query: marker.into(),
                case_sensitive: true,
                whole_word: false,
                include_internal,
            };
            let hidden = view
                .find_page(query(false), CancellationToken::new())
                .await
                .unwrap();
            assert!(hidden.matches.is_empty());
            assert!(hidden.next_after.is_none());
            let mut after = None;
            let mut cursors = Vec::new();
            let mut positions = Vec::new();
            loop {
                let mut input = query(true);
                input.after = after.clone();
                let page = view
                    .find_page(input, CancellationToken::new())
                    .await
                    .unwrap();
                if marker == "privateLiveOnly" && after.is_none() {
                    assert!(
                        page.matches.is_empty(),
                        "earlier snapshot candidates spend this request's budget"
                    );
                    assert!(page.next_after.is_some(), "empty page is not end of source");
                }
                for found in page.matches {
                    assert!(found.preview.contains(marker));
                    assert!(
                        !positions.contains(&found.position),
                        "a qualified match must not repeat across pages"
                    );
                    positions.push(found.position);
                }
                let Some(next) = page.next_after else { break };
                assert_ne!(after.as_ref(), Some(&next), "continuation must advance");
                assert!(!cursors.contains(&next), "continuation must not loop");
                cursors.push(next.clone());
                after = Some(next);
            }
            assert_eq!(
                positions.len(),
                100,
                "every original private source row remains searchable when included"
            );
        }
    }
    let query = |after| SourceFind {
        after,
        query: "NEEDLE".into(),
        case_sensitive: true,
        whole_word: false,
        include_internal: false,
    };
    let first = tree
        .find_page(query(None), CancellationToken::new())
        .await
        .unwrap();
    assert!(first.matches.is_empty());
    let after = first
        .next_after
        .expect("filtered candidates spent the shared request budget, not end of history");
    let second = tree
        .find_page(query(Some(after)), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(second.matches.len(), 1);
    assert!(second.matches[0].preview.contains("NEEDLE"));
    assert!(second.next_after.is_none());
    root.close().await.unwrap();
}
