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

use maka_event_log::{
    StoreError,
    bundle::{self, BundleError, StagedBundle},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub(super) async fn verify_original_proofs(
    bytes: &[u8],
    digest: &str,
    empty: &maka_event_log::context::ModelContextSource,
) {
    // Invalid history with a newly valid transport checksum must still fail.
    for (field, value) in [
        ("source_digest", json!(format!("sha256:{}", "0".repeat(64)))),
        (
            "source_scope",
            json!({"kind":"session","id":"other-session"}),
        ),
    ] {
        let changed = request(bytes, field, value);
        bundle::inspect(changed.as_slice()).await.unwrap();
        let mut staged = StagedBundle::read(changed.as_slice()).await.unwrap();
        assert!(
            staged.validate_history().await.is_err(),
            "accepted forged {field}"
        );
        staged.close().await.unwrap();
    }
    let mut changed = false;
    let mismatched_dispatch = super::frames::rewrite_events(bytes, |event| {
        if !changed && event["fact"]["kind"] == "tool_dispatched" {
            event["fact"]["input"] = json!({"path":"different-source"});
            changed = true;
        }
        true
    });
    assert!(changed);
    // The transport is correctly checksummed; the dispatch still cannot
    // authenticate different arguments from its original provider call.
    bundle::inspect(mismatched_dispatch.as_slice())
        .await
        .unwrap();
    let mut staged = StagedBundle::read(mismatched_dispatch.as_slice())
        .await
        .unwrap();
    assert!(staged.validate_history().await.is_err());
    staged.close().await.unwrap();
    let mut changed = false;
    let stale = super::frames::rewrite_events(bytes, |event| {
        if !changed && event["fact"]["kind"] == "model_requested" {
            event["fact"]["source_high_water"] = json!(0);
            event["fact"]["source_digest"] = json!(empty.source_evidence.digest);
            event["fact"]["effective_source_digest"] = json!(empty.effective_source_digest);
            event["fact"]["checkpoint_event_id"] = Value::Null;
            changed = true;
        }
        true
    });
    rejected(
        &stale,
        "invalid context checkpoint: model request source changed",
    )
    .await;
    let records = super::frames::records(bytes, digest);
    let events: Vec<(u64, Value)> = records
        .iter()
        .filter(|r| r["kind"] == "event")
        .map(|r| {
            (
                r["sequence"].as_u64().unwrap(),
                serde_json::from_str(r["json"].as_str().unwrap()).unwrap(),
            )
        })
        .collect();
    let tool = events
        .iter()
        .find(|(_, event)| event["fact"]["kind"] == "tool_settled")
        .unwrap()
        .0;
    let revision = append_record(
        bytes,
        json!({"kind":"revision_source","session":"branch","sequence":tool}),
    );
    rejected(&revision, "revision evidence requires a Revision copy").await;
    let mut imported = events[0].1.clone();
    imported["id"] = json!("foreign-observation");
    imported["invocation"]["invocation_id"] = json!("foreign-invocation");
    imported["fact"] = json!({"kind":"message_imported","source":{"adapter":"external","sessionId":"external-session"},
        "record":{"sourceMessageId":"external-message","sourceTurnId":"external-turn","timestamp":null,"content":{"kind":"note","text":"historical observation"}}});
    let mixed = append_record(
        bytes,
        json!({"kind":"event","sequence":events.last().unwrap().0+1,"json":serde_json::to_string(&imported).unwrap()}),
    );
    rejected(&mixed, "imported messages cannot admit an invocation").await;
    imported["invocation"]["session_id"] = json!("unrelated-session");
    imported["invocation"]["run_id"] = json!("unrelated-run");
    let unrelated = append_record(
        bytes,
        json!({"kind":"event","sequence":events.last().unwrap().0+1,"json":serde_json::to_string(&imported).unwrap()}),
    );
    rejected(
        &unrelated,
        "bundle contains history outside its selected closure",
    )
    .await;
    for (kind, field, value, expected) in [
        (
            "session",
            "id",
            json!("not-selected"),
            "bundle catalog differs from its inventory",
        ),
        (
            "session",
            "parent",
            json!("branch"),
            "bundle catalog is not the selected rooted subtree",
        ),
        (
            "accounting",
            "event_id",
            json!("not-a-request"),
            "unbound bundle model quote",
        ),
        (
            "accounting",
            "valuation",
            json!({"usage":{"input_tokens":1},"usd":0.0}),
            "bundle valuation differs from its selected usage evidence",
        ),
    ] {
        let mut changed = false;
        let tampered = super::frames::rewrite_records(bytes, |record| {
            if !changed && record["kind"] == kind {
                record[field] = value.clone();
                changed = true;
            }
            true
        });
        assert!(changed, "missing {kind} fixture");
        rejected(&tampered, expected).await;
    }
    let omitted = super::frames::rewrite_records(bytes, |record| record["kind"] != "session");
    rejected(&omitted, "bundle catalog differs from its inventory").await;
    for (omit, expected) in [
        (
            "history_artifact",
            "bundle copied reference lacks its retained Artifact",
        ),
        (
            "artifact",
            "bundle history mapping lacks its owned Artifact",
        ),
    ] {
        let omitted = super::frames::rewrite_records(bytes, |record| {
            !(record["kind"] == omit || (record["kind"] == "blob" && record["resource"] == omit))
        });
        rejected(&omitted, expected).await;
    }
    for (field, value, expected) in [
        (
            "sessionId",
            "not-selected",
            "bundle Artifact is outside its selected catalog",
        ),
        (
            "name",
            "wrong.txt",
            "Attachment metadata does not match its canonical Artifact",
        ),
    ] {
        let tampered = super::frames::rewrite_records(bytes, |record| {
            if record["kind"] == "blob" && record["resource"] == "artifact" {
                record["metadata"][field] = json!(value);
            }
            true
        });
        rejected(&tampered, expected).await;
    }
    // Reject attacker-declared allocation before waiting for the absent body.
    let mut oversized = b"MAKA-SESSION\0\x01".to_vec();
    oversized.extend(u32::MAX.to_be_bytes());
    assert!(matches!(
        bundle::inspect(oversized.as_slice()).await,
        Err(BundleError::Store(StoreError::PrefixTooLarge))
    ));
}

pub(super) async fn verify_deleted_upload(log: &maka_event_log::EventLog) {
    assert_eq!(
        log.delete_user_artifact("source", "input").await.unwrap(),
        maka_event_log::artifacts::ArtifactDeletion::Deleted
    );
    let inventory = log.preview_bundle("source").await.unwrap();
    let (bytes, _) = log
        .export_bundle("source", &inventory.subtree_digest, Vec::new())
        .await
        .unwrap();
    let mut staged = StagedBundle::read(bytes.as_slice()).await.unwrap();
    // The branch still owns its retained copy; the original reference now
    // reports a missing upload without making the entire bundle invalid.
    staged.validate_history().await.unwrap();
    staged.validate_history().await.unwrap();
    staged.close().await.unwrap();
}

async fn rejected(bytes: &[u8], expected: &str) {
    bundle::inspect(bytes).await.unwrap();
    let mut staged = StagedBundle::read(bytes).await.unwrap();
    let result = staged.validate_history().await;
    assert!(
        matches!(&result,
        Err(BundleError::Store(StoreError::InvalidTransition(message))) if message == expected),
        "expected {expected}, got {result:?}"
    );
    staged.close().await.unwrap();
}

fn request(bytes: &[u8], field: &str, value: Value) -> Vec<u8> {
    let mut changed = false;
    let output = super::frames::rewrite_events(bytes, |event| {
        if !changed && event["fact"]["kind"] == "model_requested" {
            event["fact"][field] = value.clone();
            changed = true;
        }
        true
    });
    assert!(changed);
    output
}

fn append_record(bytes: &[u8], extra: Value) -> Vec<u8> {
    let mut offset = b"MAKA-SESSION\0\x01".len();
    loop {
        let start = offset;
        let length = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        offset += 4;
        let mut record: Value = serde_json::from_slice(&bytes[offset..offset + length]).unwrap();
        offset += length;
        if record["kind"] == "end" {
            let mut output = bytes[..start].to_vec();
            let added = serde_json::to_vec(&extra).unwrap();
            output.extend((added.len() as u32).to_be_bytes());
            output.extend(added);
            record["frames"] = Value::from(record["frames"].as_u64().unwrap() + 1);
            record["digest"] = Value::String(format!("sha256:{:x}", Sha256::digest(&output)));
            let end = serde_json::to_vec(&record).unwrap();
            output.extend((end.len() as u32).to_be_bytes());
            output.extend(end);
            return output;
        }
        if record["kind"] == "blob" {
            offset += if record["resource"] == "artifact" {
                record["metadata"]["sizeBytes"].as_u64().unwrap()
            } else {
                record["bytes"].as_u64().unwrap()
            } as usize;
        }
    }
}
