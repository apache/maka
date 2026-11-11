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
use crate::checkpoints::{HistorySnapshot, WorkspaceConsistency, WorkspaceSnapshot};
use maka_plugin_core::composition::InstanceId;
use tempfile::{TempDir, tempfile};
use uuid::Uuid;

fn reference(bytes: &[u8]) -> ObjectRef {
    ObjectRef {
        digest: hex::encode(Sha256::digest(bytes)),
        bytes: bytes.len() as u64,
    }
}
fn archive(files: Vec<(&str, Vec<u8>)>) -> File {
    let mut tar = Builder::new(GzEncoder::new(tempfile().unwrap(), Compression::fast()));
    for (name, bytes) in files {
        append(&mut tar, name, bytes.len() as u64, &bytes[..]).unwrap();
    }
    let mut file = tar.into_inner().unwrap().finish().unwrap();
    file.rewind().unwrap();
    file
}
fn members(workspace: Option<&[u8]>) -> Vec<(&'static str, Vec<u8>)> {
    let history = b"opaque history";
    let identity = Uuid::new_v4();
    let m = Manifest {
        root_id: "b".repeat(64),
        scope: Scope {
            state_domain: "d".repeat(64),
            deployment: identity,
            namespace: InstanceId(vec![identity]),
        },
        session_id: "session".into(),
        history: HistorySnapshot {
            object: reference(history),
            inventory: vec![],
            cut: vec![],
        },
        workspace: workspace.map(|bytes| WorkspaceSnapshot {
            inventory: reference(bytes),
            identity: "capture".into(),
            consistency: WorkspaceConsistency::Unverified,
        }),
    };
    let manifest = serde_json::to_vec(&m).unwrap();
    let head = serde_json::to_vec(&Head {
        revision: Revision(identity),
        manifest: reference(&manifest),
    })
    .unwrap();
    let mut files = vec![
        (HEAD, head),
        (MANIFEST, manifest),
        (HISTORY, history.to_vec()),
    ];
    if let Some(data) = workspace {
        files.push((INVENTORY, data.to_vec()));
    }
    files
}

fn inspect(file: File, budget: u64) -> Result<(TempDir, Inspection), StoreError> {
    let stage = TempDir::new().unwrap();
    let scratch = TempDir::new().unwrap();
    let inspection = open(file, stage.path(), scratch.path(), budget)?;
    Ok((stage, inspection))
}
#[test]
fn history_only_archive_checks_budget_digest_and_exact_members() {
    let (stage, mut checked) = inspect(archive(members(None)), 14).unwrap();
    let mut history = String::new();
    checked.history.read_to_string(&mut history).unwrap();
    assert_eq!(history, "opaque history");
    assert!(!stage.path().join("workspace").exists());
    assert!(inspect(archive(members(None)), 13).is_err());
    let mut files = members(None);
    files[2].1[0] ^= 1;
    assert!(inspect(archive(files), 14).is_err());
    let mut files = members(None);
    files.push(("extra", vec![]));
    assert!(inspect(archive(files), 14).is_err());
}
#[test]
fn workspace_objects_must_be_complete_and_match_even_inside_a_valid_gzip() {
    let data = b"body";
    let object = reference(data);
    let entry = |path: &str| WorkspaceEntry::File {
        path: path.into(),
        object: object.clone(),
        executable: false,
    };
    let inventory =
        serde_json::to_vec(&serde_json::json!({"entries":[entry("a"),entry("b")]})).unwrap();
    let files = || members(Some(&inventory));
    assert!(inspect(archive(files()), 22).is_err());
    let name = format!("objects/{}", object.digest);
    let packed = |bytes: &[u8]| {
        let mut content: Vec<(&str, Vec<u8>)> = files();
        content.push((&name, bytes.to_vec()));
        archive(content)
    };
    assert!(inspect(packed(b"oops"), 22).is_err());
    assert!(inspect(packed(data), 21).is_err());
    let truncated = packed(data);
    truncated
        .set_len(truncated.metadata().unwrap().len() - 4)
        .unwrap();
    let stage = TempDir::new().unwrap();
    let scratch = TempDir::new().unwrap();
    assert!(open(truncated, stage.path(), scratch.path(), 22).is_err());
    assert!(!stage.path().join("workspace").exists());
    let (stage, _) = inspect(packed(data), 22).unwrap();
    for name in ["a", "b"] {
        assert_eq!(
            std::fs::read(stage.path().join("workspace").join(name)).unwrap(),
            data
        );
    }
}

#[test]
fn workspace_metadata_size_is_independent_of_the_inspection_output_budget() {
    let data = b"body";
    let object = reference(data);
    let mut inventory = serde_json::to_vec(&serde_json::json!({"entries":[
        WorkspaceEntry::File {
            path: "file".into(),
            object: object.clone(),
            executable: false,
        }
    ]}))
    .unwrap();
    // Valid JSON whitespace exercises a large inventory without creating thousands of files.
    inventory.resize(33 << 20, b' ');
    let mut files = members(Some(&inventory));
    let name = format!("objects/{}", object.digest);
    files.push((&name, data.to_vec()));
    let (stage, inspection) = inspect(archive(files), 18).unwrap();
    assert_eq!(inspection.remaining_bytes, 0);
    assert_eq!(
        std::fs::read(stage.path().join("workspace/file")).unwrap(),
        data
    );
    assert_eq!(
        std::fs::read(stage.path().join(HISTORY)).unwrap(),
        b"opaque history"
    );
}
