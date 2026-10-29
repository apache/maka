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

pub(super) async fn step(
    log: &EventLog,
    view: &mut InvocationView,
    inv: &Invocation,
    id: &str,
    purpose: ModelPurpose,
    text: &str,
) -> (u64, String) {
    let source = log
        .capture_model_context(
            "session",
            Some(&inv.invocation_id),
            100_000,
            64 * 1024 * 1024,
        )
        .await
        .unwrap();
    let request = append(
        log,
        inv,
        Fact::ModelRequested {
            context_breakdown: None,
            item_acceptance: false,
            step_id: id.into(),
            model_id: "model".into(),
            source_scope: LogScope::Session {
                id: "session".into(),
            },
            source_high_water: source.source_evidence.high_water,
            source_digest: source.source_evidence.digest,
            effective_source_digest: (purpose == ModelPurpose::Summary)
                .then_some(source.effective_source_digest),
            input_digest: "input".into(),
            route_identity: "route".into(),
            checkpoint_event_id: None,
            purpose,
            context: None,
        },
    )
    .await;
    assert!(view.push(&request).unwrap().is_empty());
    if purpose == ModelPurpose::Summary {
        let metadata = append(
            log,
            inv,
            Fact::ModelObserved {
                step_id: id.into(),
                event: ModelEvent::ResponseMetadata {
                    id: Some("summary-response".into()),
                    model: None,
                    timestamp: None,
                },
            },
        )
        .await;
        assert!(view.push(&metadata).unwrap().is_empty());
        return (metadata.sequence, request.event.id);
    }
    let start = append(
        log,
        inv,
        Fact::ModelObserved {
            step_id: id.into(),
            event: ModelEvent::PartStarted {
                id: "part".into(),
                text_kind: TextKind::Text,
                provider_options: None,
            },
        },
    )
    .await;
    assert!(view.push(&start).unwrap().is_empty());
    let delta = append(
        log,
        inv,
        Fact::ModelObserved {
            step_id: id.into(),
            event: ModelEvent::PartDelta {
                id: "part".into(),
                text: text.into(),
                provider_options: None,
            },
        },
    )
    .await;
    assert!(view.push(&delta).unwrap().is_empty());
    (delta.sequence, start.event.id)
}

pub(super) async fn finish(
    log: &EventLog,
    view: &mut InvocationView,
    inv: &Invocation,
    id: &str,
    text: &str,
) -> Vec<maka_presentation::Row> {
    if id != "summary" {
        let event = append(
            log,
            inv,
            Fact::ModelObserved {
                step_id: id.into(),
                event: ModelEvent::PartFinished {
                    id: "part".into(),
                    provider_options: None,
                },
            },
        )
        .await;
        view.push(&event).unwrap();
    }
    let Fact::ModelCompleted { mut output, .. } = accepted(text) else {
        unreachable!()
    };
    if id == "summary" {
        output.usage.input_tokens = Some(500);
        output.usage.output_tokens = Some(100);
    }
    let completed = append(
        log,
        inv,
        Fact::ModelCompleted {
            step_id: id.into(),
            output,
        },
    )
    .await;
    view.push(&completed).unwrap()
}
