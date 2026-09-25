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
use maka_runtime::tool_call::ToolOrigin;

async fn dispatch(log: &EventLog, id: &str, origin: ToolOrigin) {
    log.append(&event(
        "child",
        Fact::ToolDispatched {
            operation_id: id.into(),
            call: ToolCallIdentity {
                tool_call_id: id.into(),
                origin,
            },
            name: "fixture".into(),
            input: json!({}),
        },
    ))
    .await
    .unwrap();
}

async fn settle(log: &EventLog, id: &str) {
    let e = completion("child", "unused", "").event().clone();
    let (write, _) = EventWrite::tool_success(
        e.id,
        e.recorded_at,
        e.invocation,
        id.into(),
        json!(null).into(),
    )
    .unwrap();
    log.append(&write).await.unwrap();
}

#[tokio::test]
async fn lineage_model_cut_allows_only_independent_cell_progress_not_compaction_or_stale_steps() {
    let temp = tempfile::tempdir().unwrap();
    let log = EventLog::open(&temp.path().join("cells.sqlite"))
        .await
        .unwrap();
    let source = continuation::opening("source", None);
    continuation::append(&log, &source).await;
    continuation::close(&log, &source).await;
    let base = log
        .context_before_run(&source.invocation, 100, 65536)
        .await
        .unwrap()
        .source_evidence;
    let claim = continuation::claim(
        &log,
        "claim",
        &source,
        SessionBase {
            high_water: base.high_water,
            digest: base.digest,
        },
    )
    .await;
    let child = continuation::opening("child", Some(claim));
    continuation::append(&log, &child).await;
    dispatch(&log, "exec", ToolOrigin::Standalone).await;
    dispatch(
        &log,
        "cell",
        ToolOrigin::CodeCell {
            parent_operation_id: "exec".into(),
            parent_tool_call_id: "exec".into(),
        },
    )
    .await;
    settle(&log, "exec").await;
    let frozen = log
        .read_model_context("session", Some("child"), 100, 65536)
        .await
        .unwrap();
    dispatch(
        &log,
        "nested",
        ToolOrigin::CodeMode {
            parent_operation_id: "cell".into(),
            parent_tool_call_id: "cell".into(),
        },
    )
    .await;
    log.append(&event(
        "child",
        Fact::ToolRejected {
            operation_id: "rejected".into(),
            call: ToolCallIdentity {
                tool_call_id: "rejected".into(),
                origin: ToolOrigin::CodeMode {
                    parent_operation_id: "cell".into(),
                    parent_tool_call_id: "cell".into(),
                },
            },
            name: "unavailable".into(),
            input: json!({}),
            reason: maka_runtime::tool_call::ToolRejection::Unavailable,
        },
    ))
    .await
    .unwrap();
    // No unfinished model request here: the independent effects alone block maintenance.
    assert!(
        log.prepare_context_compaction(
            "session",
            Some("child"),
            100,
            65536,
            &CheckpointMode::MidTurn {
                anchor_event_id: child.id
            }
        )
        .await
        .is_err()
    );
    log.append(&event(
        "child",
        Fact::ToolNotified {
            operation_id: "cell".into(),
            text: "before request".into(),
            model_text: "before request".into(),
        },
    ))
    .await
    .unwrap();
    log.append(&lineage_request("attempt", ModelPurpose::Main, &frozen))
        .await
        .unwrap();
    log.append(&event(
        "child",
        Fact::ModelInterrupted {
            step_id: "attempt".into(),
            status: maka_runtime::event::ModelInterruption::RetryableFailure,
        },
    ))
    .await
    .unwrap();
    log.append(&event(
        "child",
        Fact::ToolNotified {
            operation_id: "cell".into(),
            text: "during backoff".into(),
            model_text: "during backoff".into(),
        },
    ))
    .await
    .unwrap();
    let mut changed = lineage_request("changed", ModelPurpose::Main, &frozen)
        .event()
        .clone();
    if let Fact::ModelRequested { input_digest, .. } = &mut changed.fact {
        *input_digest = "different input".into();
    }
    assert!(
        log.append(&EventWrite::plain(changed).unwrap())
            .await
            .is_err()
    );
    let changed = maka_runtime::composition::RequestComposition {
        system_prompt: Some("changed".into()),
        dynamic_context: vec![],
        tool_catalog_digest: maka_runtime::artifact::content_digest(b"[]"),
        tools: vec![],
        provider_options: None,
        max_output_tokens: None,
        sources: vec![],
    }
    .freeze()
    .unwrap();
    assert!(
        log.append(
            &lineage_request("changed-surface", ModelPurpose::Main, &frozen)
                .with_composition(std::sync::Arc::new(changed))
                .unwrap()
        )
        .await
        .is_err()
    );
    log.append(&lineage_request("observe", ModelPurpose::Main, &frozen))
        .await
        .unwrap();
    let pending = log
        .read_model_context("session", Some("child"), 100, 65536)
        .await
        .unwrap();
    assert!(
        log.append(&lineage_request("overlap", ModelPurpose::Main, &pending))
            .await
            .is_err()
    );
    log.append(&completion("child", "observe", "wait for cell"))
        .await
        .unwrap();
    let before_settlement = log
        .read_model_context("session", Some("child"), 100, 65536)
        .await
        .unwrap();
    settle(&log, "nested").await;
    settle(&log, "cell").await;
    log.append(&lineage_request(
        "done",
        ModelPurpose::Main,
        &before_settlement,
    ))
    .await
    .unwrap();
    log.append(&completion("child", "done", "observed"))
        .await
        .unwrap();
    assert!(
        log.append(&lineage_request("stale", ModelPurpose::Main, &frozen))
            .await
            .is_err()
    );
    let before_direct = log
        .read_model_context("session", Some("child"), 100, 65536)
        .await
        .unwrap();
    dispatch(&log, "direct", ToolOrigin::Standalone).await;
    let request = lineage_request("next", ModelPurpose::Main, &before_direct);
    assert!(log.append(&request).await.is_err());
    settle(&log, "direct").await;
    assert!(
        log.append(&request).await.is_err(),
        "a settled direct result cannot be omitted either"
    );
    let fresh = log
        .read_model_context("session", Some("child"), 100, 65536)
        .await
        .unwrap();
    log.append(&lineage_request("next", ModelPurpose::Main, &fresh))
        .await
        .unwrap();
}
