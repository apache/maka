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

#[tokio::test]
async fn automatic_modes_apply_archived_sources_without_sealing_the_message() {
    for mid in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let log = EventLog::open(&directory.path().join("auto.sqlite"))
            .await
            .unwrap();
        let target = if mid {
            open(&log, "writer", false).await;
            tool(&log, "writer", "active-result", "x".repeat(12_000)).await
        } else {
            open(&log, "old", false).await;
            let target = tool(&log, "old", "old-result", "x".repeat(12_000)).await;
            end(&log, "old").await;
            open(&log, "writer", false).await;
            target
        };
        let archived = archive("writer", &target);
        log.append(&archived).await.unwrap();
        let source = log
            .capture_model_context("session", Some("writer"), 100_000, 64 * 1024 * 1024)
            .await
            .unwrap();
        let anchor = source
            .tail
            .iter()
            .find_map(|e| match e {
                ContextEvent::Canonical(e)
                    if e.event.invocation.invocation_id == "writer"
                        && matches!(e.event.fact, Fact::InvocationOpened { .. }) =>
                {
                    Some(e.event.id.clone())
                }
                _ => None,
            })
            .unwrap();
        let mode = if mid {
            CheckpointMode::MidTurn {
                anchor_event_id: anchor,
            }
        } else {
            CheckpointMode::PreTurn
        };
        let source = log
            .capture_compaction_context("session", Some("writer"), &mode, 100_000, 64 * 1024 * 1024)
            .await
            .unwrap();
        assert!(
            source
                .tail
                .iter()
                .any(|e| matches!(e, ContextEvent::Archived(_)))
        );
        let pair = summary_pair(&log, "writer", &source).await;
        let mut checkpoint = pair[0].event().clone();
        if let Fact::ContextCheckpointRecorded { checkpoint } = &mut checkpoint.fact {
            checkpoint.mode = mode;
        }
        log.append(&EventWrite::plain(checkpoint).unwrap())
            .await
            .unwrap();
        assert_eq!(
            log.unfinished_invocations(0, 10)
                .await
                .unwrap()
                .invocations
                .len(),
            1
        );
        log.capture_model_context("session", Some("writer"), 100_000, 64 * 1024 * 1024)
            .await
            .unwrap();
        let Fact::ToolResultArchived { placeholder } = &archived.event().fact else {
            panic!()
        };
        assert!(
            log.read_archive("session", &placeholder.identity)
                .await
                .unwrap()
                .is_some()
        );
        end(&log, "writer").await;
        log.close().await.unwrap();
    }
}
