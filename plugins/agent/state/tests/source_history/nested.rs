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
use maka_agent_facts::{durable::*, history_snapshot::SnapshotId, session::ForkPosition};
use maka_agent_state::session_history::{
    snapshot::{CaptureRequest, Snapshot},
    source_tree::{SourceItem, SourceTree},
};
use tokio_util::sync::CancellationToken;
async fn capture(history: &maka_agent_state::session_history::SessionHistory) -> Snapshot {
    history
        .capture_snapshot(
            CaptureRequest {
                id: SnapshotId::try_from(uuid::Uuid::new_v4()).unwrap(),
                cut: history.capture().await.unwrap(),
            },
            CancellationToken::new(),
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn nested_source_keeps_original_cut_and_earlier_turn_subset_without_parent_future() {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "source").await;
    support::create(&root, "branch").await;
    let state = support::state(&root);
    let source = state.session_history(support::owner(), "source".into());
    let branch = state.session_history(support::owner(), "branch".into());
    let first = support::admit(&state, "source", "original-turn", "original frozen text").await;
    support::complete(&state, first).await;
    let frozen = capture(&source).await;
    let (spec, contents) = support::adoption_spec(&frozen, "branch", "historical-marker");
    let marker = frozen
        .adopt(&branch, uuid::Uuid::new_v4(), spec, UnixMillis(3), contents)
        .unwrap();
    let marker_run = marker.adoption().unwrap().run;
    root.data_writer().unwrap().write(marker).await.unwrap();
    let tail = support::admit(&state, "branch", "tail", "branch-only text").await;
    support::complete(&state, tail).await;
    let future = support::admit(&state, "source", "future", "private parent future").await;
    let future_ref = state.frontier(future).await.unwrap().spec.input;
    let branch_snapshot = capture(&branch).await;
    let tree = SourceTree::snapshot(&branch_snapshot).await.unwrap();
    let rows = tree.positions(None, false, false, 32).await.unwrap();
    assert_eq!(rows.len(), 2);
    let SourceItem::Canonical(original) = tree.item(&rows[0].address).await.unwrap() else {
        panic!("original canonical")
    };
    assert_eq!(original.recorded.run, first);
    assert!(!rows[0].address.path().is_empty());
    assert!(rows[1].address.path().is_empty());
    assert!(
        branch_snapshot
            .with_payload(&future_ref, |_| Ok(()))
            .await
            .is_err()
    );
    assert_eq!(
        tree.after_run(marker_run)
            .await
            .unwrap()
            .positions(None, false, false, 32)
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(
        tree.after_run(tail)
            .await
            .unwrap()
            .positions(None, false, false, 32)
            .await
            .unwrap()
            .is_empty()
    );
    let revision = root
        .get_session::<serde_json::Value>("branch")
        .await
        .unwrap()
        .unwrap()
        .revision;
    let writer = root.data_writer().unwrap();
    let session = root.session("branch").await.unwrap();
    let id = SnapshotId::try_from(uuid::Uuid::new_v4()).unwrap();
    let position = ForkPosition::ThroughSourceTurn {
        position: rows[0].address.clone(),
    };
    let selected = branch
        .capture_fork_snapshot(
            id,
            position.clone(),
            session.revision_guard(&writer, revision).unwrap(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let selected_tree = SourceTree::snapshot(selected.snapshot()).await.unwrap();
    let selected_rows = selected_tree
        .positions(None, false, false, 32)
        .await
        .unwrap();
    assert_eq!(selected_rows.len(), 1);
    let SourceItem::Canonical(selected_item) =
        selected_tree.item(&selected_rows[0].address).await.unwrap()
    else {
        panic!("original canonical")
    };
    assert_eq!(selected_item.recorded, original.recorded);
    let later = support::admit(&state, "branch", "later", "excluded branch later").await;
    let replay = branch
        .capture_fork_snapshot(
            id,
            position,
            session.revision_guard(&writer, revision).unwrap(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        replay.snapshot().reference(),
        selected.snapshot().reference()
    );
    let later_ref = state.frontier(later).await.unwrap().spec.input;
    assert!(
        selected
            .snapshot()
            .with_payload(&later_ref, |_| Ok(()))
            .await
            .is_err()
    );
    root.close().await.unwrap();
}

#[tokio::test]
async fn source_descriptor_and_matching_ids_are_not_cross_root_adoption_authority() {
    let first = tempfile::tempdir().unwrap();
    let first_root = support::open(first.path(), false).await;
    support::create(&first_root, "source").await;
    let state = support::state(&first_root);
    let history = state.session_history(support::owner(), "source".into());
    let run = support::admit(&state, "source", "turn", "actual bytes").await;
    support::complete(&state, run).await;
    let snapshot = capture(&history).await;
    let second = tempfile::tempdir().unwrap();
    let second_root = support::open(second.path(), false).await;
    support::create(&second_root, "target").await;
    let other = support::state(&second_root);
    let target = other.session_history(support::owner(), "target".into());
    let (spec, contents) = support::adoption_spec(&snapshot, "target", "inert-target");
    assert!(
        snapshot
            .adopt(&target, uuid::Uuid::new_v4(), spec, UnixMillis(3), contents)
            .is_err()
    );
    assert!(target.capture().await.unwrap().through_sequence == 0);
    first_root.close().await.unwrap();
    second_root.close().await.unwrap();
}
