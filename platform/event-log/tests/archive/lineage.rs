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
use maka_agent_facts::continuation::ContinuationClaim;
use maka_agent_facts::continuation::REPLAY_VERSION;
use maka_agent_facts::continuation::ReplayEvidence;
use maka_agent_facts::continuation::SessionBase;
use maka_agent_facts::execution::BehaviorId;
use maka_agent_facts::execution::CollaborationMode;
use maka_agent_facts::execution::InvocationConfiguration;
use maka_agent_facts::execution::SandboxMode;
use maka_agent_facts::execution::ToolMode;
use maka_agent_facts::execution::WorkspaceIdentity;

#[path = "../continuation/fixtures.rs"]
mod continuation;
mod lineage_checkpoint;

mod bundle;

fn selected_ids(source: &ModelContextSource) -> Vec<String> {
    source
        .tail
        .iter()
        .map(|e| match e {
            ContextEvent::Canonical(e) => e.event.id.clone(),
            ContextEvent::Archived(e) => e.event_id.clone(),
            ContextEvent::ModelItems(e) => e.event_id.clone(),
        })
        .collect()
}

#[tokio::test]
async fn inherited_prune_and_checkpoint_exclude_later_branch_archives_history_and_diagnostics() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("lineage.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    open(&log, "prior", false).await;
    let prior_tool = tool(&log, "prior", "prior-tool", "p".repeat(12000)).await;
    end(&log, "prior").await;
    let source = continuation::opening("source", None);
    continuation::append(&log, &source).await;
    log.append(&archive("source", &prior_tool)).await.unwrap();
    let before = log
        .capture_compaction_context(
            "session",
            Some("source"),
            &CheckpointMode::PreTurn,
            100_000,
            64 * 1024 * 1024,
        )
        .await
        .unwrap();
    let mut pair = summary_pair(&log, "source", &before).await;
    let mut checkpoint = pair.remove(0).event().clone();
    if let Fact::ContextCheckpointRecorded { checkpoint } = &mut checkpoint.fact {
        checkpoint.mode = CheckpointMode::PreTurn;
    }
    continuation::append(&log, &checkpoint).await;
    let source_tool = tool(&log, "source", "source-tool", "s".repeat(12000)).await;
    continuation::close(&log, &source).await;
    let base = log
        .context_before_run(&source.invocation, 100, 65536)
        .await
        .unwrap()
        .source_evidence;
    let first_claim = continuation::claim(
        &log,
        "first-claim",
        &source,
        SessionBase {
            high_water: base.high_water,
            digest: base.digest,
        },
    )
    .await;
    let original = log
        .capture_lineage_context(&first_claim.source, 100, 65536)
        .await
        .unwrap();
    assert_eq!(original.baseline.as_ref().unwrap().event_id, checkpoint.id);
    assert!(
        original.tail.iter().any(
            |e| matches!(e, ContextEvent::Canonical(e) if e.event.id == source_tool.event().id)
        )
    );
    let LatestMainContext::Selected(original_main) = &original.latest_main else {
        panic!("expected source Main")
    };

    // A later branch archives a selected tool and replaces the Session's baseline.
    // Neither operation belongs to the selected source Run's inherited history.
    let mut unrelated = continuation::opening("unrelated", None);
    if let Fact::InvocationOpened {
        input: InvocationInput::Message { content, .. },
        ..
    } = &mut unrelated.fact
    {
        *content = "unrelated".repeat(12000).into();
    }
    continuation::append(&log, &unrelated).await;
    log.append(&archive("unrelated", &source_tool))
        .await
        .unwrap();
    tool(&log, "unrelated", "unrelated-tool", "later".into()).await;
    continuation::close(&log, &unrelated).await;
    open(&log, "later-compact", true).await;
    let later_source = log
        .capture_compaction_context(
            "session",
            Some("later-compact"),
            &CheckpointMode::Standalone,
            100_000,
            64 * 1024 * 1024,
        )
        .await
        .unwrap();
    let later = summary_pair(&log, "later-compact", &later_source).await;
    log.append_batch(&later).await.unwrap();

    let child = continuation::opening("child", Some(first_claim.clone()));
    continuation::append(&log, &child).await;
    let active = log
        .capture_model_context("session", Some("child"), 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    assert!(
        matches!(active.source_evidence.scope, LogScope::Lineage { ref run_id, .. } if run_id == "child")
    );
    assert_eq!(active.baseline.as_ref().unwrap().event_id, checkpoint.id);
    assert_ne!(
        active.baseline.as_ref().unwrap().event_id,
        later[0].event().id
    );
    let LatestMainContext::Selected(active_main) = &active.latest_main else {
        panic!("expected inherited Main")
    };
    assert_eq!(active_main.sequence, original_main.sequence);
    assert_eq!(
        active_main.projection_current,
        original_main.projection_current
    );
    assert!(
        active.tail.iter().any(
            |e| matches!(e, ContextEvent::Canonical(e) if e.event.id == source_tool.event().id)
        )
    );
    assert!(active.tail.iter().all(|e| match e {
        ContextEvent::Canonical(e) => e.event.invocation.run_id != "unrelated",
        ContextEvent::Archived(e) => e.invocation.run_id != "unrelated",
        ContextEvent::ModelItems(e) => e.invocation.run_id != "unrelated",
    }));
    continuation::close(&log, &child).await;
    let child_boundary =
        continuation::claim(&log, "second-claim", &child, first_claim.base.clone()).await;
    let child_context = log
        .capture_lineage_context(&child_boundary.source, 100, 65536)
        .await
        .unwrap();
    assert!(
        matches!(
            log.capture_lineage_context(&child_boundary.source, 100, 8192)
                .await,
            Err(StoreError::PrefixTooLarge)
        ),
        "a later excluded archive cannot shrink the inherited tool's explicit byte budget"
    );
    let raw = log
        .scoped_prefix(child_context.source_evidence.scope.clone(), 100, 65536)
        .await
        .unwrap();
    assert_eq!(raw.digest, child_context.source_evidence.digest);
    assert_eq!(raw.high_water, child_context.source_evidence.high_water);
    assert!(
        raw.events
            .iter()
            .all(|e| !["unrelated", "later-compact"].contains(&e.event.invocation.run_id.as_str()))
    );
    let grandchild = continuation::opening("grandchild", Some(child_boundary));
    continuation::append(&log, &grandchild).await;
    continuation::close(&log, &grandchild).await;
    let expected_ids = selected_ids(&child_context);
    let expected_effective = child_context.effective_source_digest.clone();
    log.close().await.unwrap();

    let log = EventLog::open(&path).await.unwrap();
    let frozen = log
        .read_frozen_model_context(&child_context.source_evidence, 100, 65536)
        .await
        .unwrap();
    assert_eq!(selected_ids(&frozen), expected_ids);
    assert_eq!(frozen.effective_source_digest, expected_effective);
    assert_eq!(
        log.capture_lineage_context(&first_claim.source, 100, 65536)
            .await
            .unwrap()
            .effective_source_digest,
        original.effective_source_digest
    );
    let mut forged = first_claim.source.clone();
    forged.digest = continuation::digest('e');
    assert!(
        log.capture_lineage_context(&forged, 100, 65536)
            .await
            .is_err()
    );
    log.close().await.unwrap();
}
