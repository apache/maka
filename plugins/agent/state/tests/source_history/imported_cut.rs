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
    artifact::{Artifact, ArtifactKind, ArtifactSource, PublishedArtifact},
    durable::UnixMillis,
    history_snapshot::{
        Entry, HistoricalRole, ImportedArtifactScope, ImportedMessage, ImportedPart,
        ImportedTurnOrdinal, SnapshotId,
    },
    input::MessageInput,
    session::ForkPosition,
};
use maka_agent_state::session_history::{
    snapshot::{ForkSnapshotSource, ImportedCaptureRequest},
    source_tree::SourceTree,
};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn imported_turn_subset_keeps_selected_raw_prefix_and_excludes_future_media_and_metadata() {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "base").await;
    support::create(&root, "branch").await;
    let state = support::state(&root);
    let base = state.session_history(support::owner(), "base".into());
    let branch = state.session_history(support::owner(), "branch".into());
    let mut tape = Tape::new();
    let first_raw = tape.push_blob(b"{\"text\":\"first raw record\"}\r\n");
    let future_raw = tape.push_blob(b"{\"private\":\"future source record\"}\r\n");
    let first = tape.push_json(&ImportedPart::Input {
        content: MessageInput::from("selected input"),
    });
    let future = tape.push_json(&ImportedPart::Input {
        content: MessageInput::from("future input"),
    });
    let media_payload = tape.push_blob(b"future secret media");
    let artifact = PublishedArtifact {
        artifact: Artifact {
            id: "future-image".into(),
            session_id: "base".into(),
            turn_id: "import".into(),
            created_at: 2,
            name: "future.png".into(),
            kind: ArtifactKind::Image,
            size_bytes: media_payload.bytes,
            mime_type: Some("image/png".into()),
            source: ArtifactSource::ToolResult,
            summary: None,
        },
        payload: media_payload.clone(),
    };
    tape.push_entry(&Entry::Artifact {
        owner: support::owner(),
        session: "base".into(),
        run: None,
        through_sequence: None,
        record: artifact,
    });
    for (ordinal, part, original, media) in [
        (0, first, first_raw.clone(), vec![]),
        (
            1,
            future.clone(),
            future_raw.clone(),
            vec!["future-image".into()],
        ),
    ] {
        let header = ImportedMessage {
            turn_ordinal: ImportedTurnOrdinal(ordinal),
            original_ordinal: ordinal,
            media,
            source_message_id: None,
            source_turn_id: None,
            timestamp: Some(ordinal + 1),
            role: HistoricalRole::User,
            artifact_scope: ImportedArtifactScope {
                owner: support::owner(),
                session: "base".into(),
            },
            parts: vec![part],
            provider_metadata: None,
            original,
        };
        let reference = tape.push_json(&header);
        tape.push_entry(&Entry::Imported {
            ordinal,
            message: reference,
        });
    }
    let fingerprint = tape.original_source(
        vec![first_raw.clone(), future_raw.clone()],
        maka_agent_facts::artifact::content_digest(b"original full source"),
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
                fingerprint: fingerprint.clone(),
            },
            CancellationToken::new(),
        )
        .await;
    let (spec, contents) = support::adoption_spec(&snapshot, "branch", "history-source");
    let adoption = snapshot
        .adopt(&branch, uuid::Uuid::new_v4(), spec, UnixMillis(3), contents)
        .unwrap();
    let writer = root.data_writer().unwrap();
    writer.write(adoption).await.unwrap();
    let tree = SourceTree::live(&branch, &branch.capture().await.unwrap())
        .await
        .unwrap();
    let rows = tree.positions(None, false, false, 16).await.unwrap();
    assert_eq!(rows.len(), 2);
    let metadata = root
        .get_session::<serde_json::Value>("branch")
        .await
        .unwrap()
        .unwrap();
    let session = root.session("branch").await.unwrap();
    let selected = branch
        .capture_fork_snapshot(
            SnapshotId::try_from(uuid::Uuid::new_v4()).unwrap(),
            ForkPosition::ThroughSourceTurn {
                position: rows[0].address.clone(),
            },
            session.revision_guard(&writer, metadata.revision).unwrap(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(matches!(selected.source(), ForkSnapshotSource::Imported));
    let subset = selected.snapshot();
    let messages = subset.imported(None, 16).await.unwrap().items;
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].1.original, first_raw);
    assert!(messages[0].1.source_message_id.is_none());
    for reference in [future_raw, future, media_payload, fingerprint] {
        assert!(
            subset.with_payload(&reference, |_| Ok(())).await.is_err(),
            "future content or full source metadata must not enter the child's capability closure"
        );
    }
    assert!(
        subset
            .artifact(support::owner(), "base".into(), None, "future-image".into())
            .await
            .unwrap()
            .is_none()
    );
    let selected_rows = SourceTree::snapshot(subset)
        .await
        .unwrap()
        .positions(None, false, false, 16)
        .await
        .unwrap();
    assert_eq!(selected_rows.len(), 1);
    root.close().await.unwrap();
}
