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

use maka_agent_facts::{
    durable::RunOwner,
    history_snapshot::{
        Entry, HistoricalRole, ImportedArtifactScope, ImportedMessage, ImportedPart,
        ImportedTurnOrdinal, OriginalRecordsPage, OriginalSource, SnapshotId,
    },
};
use maka_agent_state::{
    ContentBlob, DriverDomain, Store,
    session_history::snapshot::{IMPORT_TAPE_MAGIC, ImportedCaptureRequest, Snapshot},
};
use maka_event_log::{
    RootStore,
    root::{RootNamespaces, RootOwner},
};
use serde_json::json;
use std::{fs::File, io::Write, sync::Arc};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

fn content(file: &mut File, value: impl serde::Serialize) -> maka_agent_facts::durable::ContentRef {
    let blob = ContentBlob::json(&value).unwrap();
    let raw = serde_json::to_vec(&value).unwrap();
    let reference = blob.reference().clone();
    file.write_all(&[0]).unwrap();
    file.write_all(&hex::decode(&reference.digest[7..]).unwrap())
        .unwrap();
    file.write_all(&(raw.len() as u64).to_be_bytes()).unwrap();
    file.write_all(&raw).unwrap();
    reference
}
fn entry(file: &mut File, entry: &Entry) {
    let raw = serde_json::to_vec(entry).unwrap();
    file.write_all(&[1]).unwrap();
    file.write_all(&(raw.len() as u64).to_be_bytes()).unwrap();
    file.write_all(&raw).unwrap();
}
async fn store(base: &std::path::Path) -> (Arc<RootStore>, Store) {
    let ns = RootNamespaces {
        ownership: base.join("owners"),
        control: base.join("control"),
    };
    let owner = Arc::new(RootOwner::create(&base.join("root"), &ns).unwrap());
    let catalog: Vec<_> = maka_event_log::ROOT_MIGRATIONS
        .iter()
        .chain(maka_agent_state::MIGRATIONS)
        .copied()
        .collect();
    let root = Arc::new(RootStore::open(owner, &catalog).await.unwrap());
    let data = root.data_writer().unwrap();
    let store = Store::new(data.clone(), DriverDomain::new(data).unwrap()).unwrap();
    (root, store)
}
async fn assert_context(snapshot: &Snapshot) {
    let full = snapshot.imported(None, 20).await.unwrap();
    assert_eq!(full.items.len(), 3, "browsing retains pre-summary history");
    let model = snapshot.model_messages(None, 1).await.unwrap();
    assert_eq!(model.items[0].0, 1, "model starts with the summary itself");
    assert_eq!(model.items[0].1.role, HistoricalRole::Context);
    assert_eq!(model.next, Some(1));
    let tail = snapshot.model_messages(model.next, 20).await.unwrap();
    assert_eq!(
        tail.items.iter().map(|(i, _)| *i).collect::<Vec<_>>(),
        vec![2]
    );
    let visible = snapshot.positions(None, false, false, 0, 20).await.unwrap();
    assert_eq!(
        visible.len(),
        2,
        "summary is internal, genuine messages remain visible"
    );
    let part: ImportedPart = snapshot
        .with_imported_content(1, &model.items[0].1.parts[0], |reader| {
            Ok(serde_json::from_reader(reader).unwrap())
        })
        .await
        .unwrap();
    assert!(
        matches!(part, ImportedPart::Input {content} if content.text == "Work already completed; continue the outstanding task.")
    );
}

#[tokio::test]
async fn imported_context_boundary_keeps_history_and_survives_export() {
    let temp = tempfile::tempdir().unwrap();
    let (root, db) = store(&temp.path().join("source")).await;
    let owner: RunOwner =
        serde_json::from_value(json!({"deployment":Uuid::new_v4(),"namespace":[]})).unwrap();
    let history = db.session_history(owner.clone(), "conversation".into());
    let mut tape = tempfile::tempfile().unwrap();
    tape.write_all(IMPORT_TAPE_MAGIC).unwrap();
    let mut originals = Vec::new();
    for (i, (role, text)) in [
        (HistoricalRole::User, "Original long task"),
        (
            HistoricalRole::Context,
            "Work already completed; continue the outstanding task.",
        ),
        (HistoricalRole::User, "Continue with the remaining work"),
    ]
    .into_iter()
    .enumerate()
    {
        let original = content(&mut tape, json!({"id":i,"text":text}));
        originals.push(original.clone());
        let part = content(&mut tape, json!({"kind":"input","content":{"text":text}}));
        let message = ImportedMessage {
            turn_ordinal: ImportedTurnOrdinal(i as u64),
            original_ordinal: i as u64,
            media: vec![],
            source_message_id: Some(format!("m{i}")),
            source_turn_id: Some(format!("t{i}")),
            timestamp: Some(i as u64),
            role,
            artifact_scope: ImportedArtifactScope {
                owner: owner.clone(),
                session: "conversation".into(),
            },
            parts: vec![part],
            provider_metadata: None,
            original,
        };
        let message = content(&mut tape, message);
        entry(
            &mut tape,
            &Entry::Imported {
                ordinal: i as u64,
                message,
            },
        );
    }
    let records = content(
        &mut tape,
        OriginalRecordsPage {
            previous: None,
            records: originals,
        },
    );
    let fingerprint = content(
        &mut tape,
        OriginalSource {
            version: 1,
            fingerprint: "fixture".into(),
            records: Some(records),
        },
    );
    let request = ImportedCaptureRequest {
        id: SnapshotId::new(),
        source: maka_agent_facts::import::Source {
            adapter: "fixture".into(),
            session_id: "source".into(),
        },
        fingerprint,
        model_start: Some(1),
    };
    let snapshot = history
        .capture_imported(
            request.clone(),
            tape.try_clone().unwrap(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_context(&snapshot).await;
    let archive = snapshot
        .export(tempfile::tempfile().unwrap())
        .await
        .unwrap();
    let other = tempfile::tempdir().unwrap();
    let (other_root, other_db) = store(other.path()).await;
    let imported = other_db
        .session_history(owner, "destination".into())
        .import_snapshot(
            Uuid::new_v4(),
            archive.history,
            archive.file,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_context(&imported).await;
    let ordinary = history
        .capture_imported(
            ImportedCaptureRequest {
                id: SnapshotId::new(),
                model_start: None,
                ..request.clone()
            },
            tape.try_clone().unwrap(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        ordinary.model_messages(None, 20).await.unwrap().items.len(),
        3,
        "ordinary Context messages do not reset history"
    );
    let invalid = history
        .capture_imported(
            ImportedCaptureRequest {
                id: SnapshotId::new(),
                model_start: Some(2),
                ..request
            },
            tape,
            CancellationToken::new(),
        )
        .await;
    assert!(
        invalid.is_err(),
        "a user message cannot silently become the context boundary"
    );
    other_root.shutdown().await.unwrap();
    root.shutdown().await.unwrap();
}
