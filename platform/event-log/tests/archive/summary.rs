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
use sha2::{Digest, Sha256};

#[tokio::test]
async fn stale_after_opening_binds_summary_and_late_prune_rolls_back_checkpoint() {
    for late in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("summary.sqlite");
        let log = EventLog::open(&path).await.unwrap();
        open(&log, "old", false).await;
        let first = tool(&log, "old", "first", "a".repeat(12_000)).await;
        let second = tool(&log, "old", "second", "b".repeat(12_000)).await;
        end(&log, "old").await;
        open(&log, "compact", true).await;
        let stale = log
            .capture_compaction_context(
                "session",
                Some("compact"),
                &CheckpointMode::Standalone,
                100_000,
                64 * 1024 * 1024,
            )
            .await
            .unwrap();
        let archived = archive("compact", &first);
        let archive_sequence = log.append(&archived).await.unwrap();
        assert!(
            log.append(&request("compact", "stale-summary", Some(&stale)))
                .await
                .is_err()
        );
        let fresh = log
            .capture_compaction_context(
                "session",
                Some("compact"),
                &CheckpointMode::Standalone,
                100_000,
                64 * 1024 * 1024,
            )
            .await
            .unwrap();
        assert_eq!(fresh.source_evidence.digest, stale.source_evidence.digest);
        assert_ne!(fresh.effective_source_digest, stale.effective_source_digest);
        let Fact::ToolResultArchived { placeholder } = &archived.event().fact else {
            panic!()
        };
        let projected = fresh
            .tail
            .iter()
            .find_map(|entry| match entry {
                ContextEvent::Archived(result) if result.event_id == first.event().id => {
                    Some(result)
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(
            projected.replacement,
            placeholder.to_canonical_projection().unwrap()
        );
        let sequence = archive_sequence.to_be_bytes();
        let bytes = serde_json::to_vec(archived.event()).unwrap();
        let mut leaf = Sha256::new();
        leaf.update(b"maka.source.leaf.v1\0");
        leaf.update(8_u64.to_be_bytes());
        leaf.update(sequence);
        leaf.update((bytes.len() as u64).to_be_bytes());
        leaf.update(bytes);
        let mut hash = Sha256::new();
        hash.update(b"maka.effective-context.v1\0");
        hash.update(fresh.source_evidence.digest.as_bytes());
        hash.update(Sha256::digest(b"maka.archive.copy.v1\0"));
        hash.update(sequence);
        hash.update(leaf.finalize());
        assert_eq!(
            fresh.effective_source_digest,
            format!("sha256:{}", hex::encode(hash.finalize()))
        );
        let pair = summary_pair(&log, "compact", &fresh).await;
        if late {
            log.append(&archive("compact", &second)).await.unwrap();
            assert!(log.append_batch(&pair).await.is_err());
            assert!(
                log.capture_model_context("session", Some("compact"), 100_000, 64 * 1024 * 1024)
                    .await
                    .unwrap()
                    .baseline
                    .is_none()
            );
            assert!(
                log.append(&request("compact", "repair", Some(&fresh)))
                    .await
                    .is_err()
            );
        } else {
            log.append_batch(&pair).await.unwrap();
            let Fact::ToolResultArchived { placeholder } = &archived.event().fact else {
                panic!()
            };
            let expected = log
                .read_archive("session", &placeholder.identity)
                .await
                .unwrap()
                .unwrap();
            open(&log, "next-compact", true).await;
            assert!(log.append(&archive("next-compact", &second)).await.is_err());
            let source = log
                .capture_compaction_context(
                    "session",
                    Some("next-compact"),
                    &CheckpointMode::Standalone,
                    100_000,
                    64 * 1024 * 1024,
                )
                .await
                .unwrap();
            let pair = summary_pair(&log, "next-compact", &source).await;
            log.append_batch(&pair).await.unwrap();
            log.close().await.unwrap();
            let log = EventLog::open(&path).await.unwrap();
            log.append(&archived).await.unwrap();
            assert_eq!(
                log.read_archive("session", &placeholder.identity)
                    .await
                    .unwrap()
                    .unwrap(),
                expected
            );
            log.capture_model_context("session", None, 100_000, 64 * 1024 * 1024)
                .await
                .unwrap();
            // A new post-summary archive is still rejected at admission.
            assert!(log.append(&archive("next-compact", &second)).await.is_err());
            log.close().await.unwrap();
            continue;
        }
        log.close().await.unwrap();
    }
}

#[tokio::test]
async fn prune_scan_advances_past_small_results_and_freezes_target_fence() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("scan.sqlite"))
        .await
        .unwrap();
    open(&log, "active", false).await;
    for n in 0..129 {
        tool(&log, "active", &format!("small-{n}"), "small".into()).await;
    }
    let large = tool(&log, "active", "large", "x".repeat(12_000)).await;
    let first = log
        .prepare_prune_candidates("session", Some("active"), 128, 1024 * 1024, None)
        .await
        .unwrap();
    assert_eq!(first.candidates.len(), 128);
    let cursor = first.next.unwrap();
    let newer = tool(&log, "active", "after-fence", "y".repeat(12_000)).await;
    let next = log
        .prepare_prune_candidates("session", Some("active"), 128, 1024 * 1024, Some(&cursor))
        .await
        .unwrap();
    assert!(
        next.candidates
            .iter()
            .any(|c| c.event_id == large.event().id)
    );
    assert!(
        !next
            .candidates
            .iter()
            .any(|c| c.event_id == newer.event().id)
    );
    assert!(next.next.is_none());
    log.close().await.unwrap();
}
