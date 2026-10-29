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
    let metadata = append(
        log,
        inv,
        Fact::ModelObserved {
            step_id: id.into(),
            event: ModelObservation::Finished {
                reason: ModelFinishReason::Stop,
                usage: Default::default(),
                provider_options: None,
            },
        },
    )
    .await;
    assert!(view.push(&metadata).unwrap().is_empty());
    (metadata.sequence, uuid::Uuid::new_v4().to_string())
}

pub(super) async fn finish(
    log: &EventLog,
    view: &mut InvocationView,
    inv: &Invocation,
    id: &str,
    message_id: &str,
    text: &str,
) -> Vec<maka_presentation::Row> {
    let Fact::ModelCompleted { mut output, .. } = accepted(text) else {
        unreachable!()
    };
    let CompletionPart::Own(record) = &mut output.parts[0] else {
        unreachable!()
    };
    record.message_id = message_id.to_owned();
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
