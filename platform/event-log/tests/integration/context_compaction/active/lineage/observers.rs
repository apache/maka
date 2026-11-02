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
use maka_agent_facts::handoff::{
    CompactionBudget, HandoffExecution, HandoffIntent, HandoffPause, HandoffTools,
};
use maka_agent_facts::tool_call::{HostSdkParent, ToolOrigin};

fn dispatch(id: &str, origin: ToolOrigin) -> EventWrite {
    event(
        "child",
        Fact::ToolDispatched {
            operation_id: id.into(),
            call: ToolCallIdentity {
                tool_call_id: id.into(),
                origin,
            },
            name: "fixture".into(),
            input: json!({}),
            title: None,
            presentation: None,
        },
    )
}

fn settled(id: &str) -> EventWrite {
    event(
        "child",
        Fact::ToolSettled {
            operation_id: id.into(),
            outcome: maka_agent_facts::event::ToolOutcome::Failed {
                message: "TIMEOUT".into(),
            },
        },
    )
}

#[tokio::test]
async fn observer_progress_allows_model_work_but_preserves_physical_barriers_after_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("observers.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let source = continuation::opening("source", None);
    continuation::append(&log, &source).await;
    continuation::close(&log, &source).await;
    let base = log
        .context_before_run(&source.invocation, 100, 65536)
        .await
        .unwrap()
        .source_evidence;
    let base_high = base.high_water;
    let claim = continuation::claim(
        &log,
        "claim",
        &source,
        SessionBase {
            high_water: base_high,
            digest: base.digest,
        },
    )
    .await;
    let child = continuation::opening("child", Some(claim));
    continuation::append(&log, &child).await;
    log.append(&dispatch("evaluation", ToolOrigin::Standalone))
        .await
        .unwrap();
    log.append(&dispatch(
        "native",
        ToolOrigin::HostSdk {
            package_id: "workspace.computer".into(),
            entry_id: "computer".into(),
            activation: "activation".into(),
            parent: Some(HostSdkParent::EvaluationObserver {
                operation_id: "evaluation".into(),
                epoch: "eb6a8d42-32e5-46d4-a1f7-bd11767a8c3f".into(),
            }),
        },
    ))
    .await
    .unwrap();
    log.append(&settled("evaluation")).await.unwrap();
    let frozen = log
        .capture_model_context("session", Some("child"), 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        log.prefix(100, 65536)
            .await
            .unwrap()
            .project_invocation("child")
            .uncertain_operations,
        vec!["native"]
    );
    log.append(&lineage_request("observe", ModelPurpose::Main, &frozen))
        .await
        .unwrap();
    log.append(&completion(
        "child",
        "observe",
        "native work remains pending",
    ))
    .await
    .unwrap();
    let pending = log
        .capture_model_context("session", Some("child"), 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    assert!(
        log.append(&lineage_request("summary", ModelPurpose::Summary, &pending))
            .await
            .is_err()
    );
    let mode = CheckpointMode::MidTurn {
        anchor_event_id: child.id.clone(),
    };
    assert!(
        log.capture_compaction_context("session", Some("child"), &mode, 100_000, 64 * 1024 * 1024)
            .await
            .is_err()
    );
    assert!(
        log.prepare_prune_candidates("session", Some("child"), 0, 0, None)
            .await
            .is_err()
    );
    let pause = HandoffPause {
        intent: HandoffIntent {
            handoff_id: "handoff".into(),
            host_epoch: "host".into(),
            root_run_id: "child".into(),
            successor_run_id: "successor-run".into(),
            successor_invocation_id: "successor-invocation".into(),
            claim_id: "successor-claim".into(),
        },
        execution: Box::new(HandoffExecution {
            replay: ReplayEvidence {
                version: REPLAY_VERSION,
                digest: continuation::digest('a'),
                route_identity: continuation::digest('b'),
            },
            context: None,
            provider_options: json!({}),
            main_output_limit: None,
            supports_vision: false,
            tools: HandoffTools {
                catalog_digest: continuation::digest('c'),
                loaded: Default::default(),
            },
            compaction: CompactionBudget::Available,
            replay_base: Some(base_high),
        }),
    };
    assert!(log.check_handoff(&child.invocation, &pause).await.is_err());
    let terminal = event(
        "child",
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    );
    assert!(log.append(&terminal).await.is_err());
    log.append(&settled("native")).await.unwrap();
    log.prepare_prune_candidates("session", Some("child"), 0, 0, None)
        .await
        .unwrap();
    log.check_handoff(&child.invocation, &pause).await.unwrap();
    let compaction = log
        .capture_compaction_context("session", Some("child"), &mode, 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    log.append(&lineage_request(
        "summary",
        ModelPurpose::Summary,
        &compaction,
    ))
    .await
    .unwrap();
    log.append(&completion("child", "summary", SUMMARY))
        .await
        .unwrap();
    log.append(&terminal).await.unwrap();
}
