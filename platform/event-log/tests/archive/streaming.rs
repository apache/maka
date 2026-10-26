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
use maka_agent_facts::model::{ModelEvent, ModelFinishReason, ModelPart, ModelToolCall};
use maka_agent_facts::tool_output::DurableToolProjection;

#[tokio::test]
async fn prune_preserves_streaming_accepted_call() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("streaming.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    open(&log, "stream", false).await;
    let mut requested = request("stream", "step", None).event().clone();
    let Fact::ModelRequested {
        item_acceptance, ..
    } = &mut requested.fact
    else {
        panic!("request fixture");
    };
    *item_acceptance = true;
    log.append(&EventWrite::plain(requested).unwrap())
        .await
        .unwrap();
    let call = ModelToolCall {
        id: "call".into(),
        name: "Read".into(),
        input: json!({"path":"file"}).into(),
        provider_options: None,
        provider_executed: false,
    };
    let accepted = event(
        "stream",
        Fact::ModelObserved {
            step_id: "step".into(),
            event: ModelEvent::ToolCall(call.clone()),
        },
    );
    log.append(&accepted).await.unwrap();
    log.append(&event(
        "stream",
        Fact::ModelObserved {
            step_id: "step".into(),
            event: ModelEvent::Finished {
                reason: ModelFinishReason::ToolCalls,
                usage: Default::default(),
                provider_options: None,
            },
        },
    ))
    .await
    .unwrap();
    log.append(&event(
        "stream",
        Fact::ModelCompleted {
            step_id: "step".into(),
            output: ModelStep {
                parts: vec![ModelPart::ToolCall { call }],
                finish_reason: ModelFinishReason::ToolCalls,
                usage: Default::default(),
                provider_options: None,
                response_id: None,
                model: None,
                timestamp: None,
            },
        },
    ))
    .await
    .unwrap();
    log.append(&event(
        "stream",
        Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: "step:call".into(),
            call: ToolCallIdentity::provider("step".into(), "call".into()),
            name: "Read".into(),
            input: json!({"path":"file"}),
        },
    ))
    .await
    .unwrap();
    let (settled, _) = EventWrite::tool_success(
        "streaming-result".into(),
        std::time::SystemTime::now(),
        accepted.event().invocation.clone(),
        "step:call".into(),
        ToolSuccess::from(json!("streamed result")),
    )
    .unwrap();
    log.append(&settled).await.unwrap();
    let batch = log
        .prepare_prune_candidates("session", Some("stream"), 16, 65536, None)
        .await
        .unwrap();
    assert_eq!(batch.candidates.len(), 1);
    assert_eq!(batch.candidates[0].event_id, "streaming-result");
    assert_eq!(batch.candidates[0].tool_call_id, "call");
    assert_eq!(batch.candidates[0].tool_name, "Read");
    assert_eq!(
        batch.candidates[0].projection,
        DurableToolProjection::Text {
            text: "streamed result".into()
        }
    );

    log.close().await.unwrap();
}
