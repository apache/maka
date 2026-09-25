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

use super::support::client_probe::ClientFixture;
use maka_event_log::context::LatestMainContext;
use maka_runtime::{
    context::{CheckpointMode, ModelPurpose},
    event::{Fact, InvocationInput},
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn original_client_keeps_auto_summary_private_and_reopens_anchor_without_repeating_effects() {
    let fixture = ClientFixture::new("maka-auto-context-");
    let mut original = None;
    for reopened in [false, true] {
        fixture
            .run(
                "--auto-context-workspace",
                reopened,
                if reopened {
                    "auto-context-reopened"
                } else {
                    "auto-context-passed"
                },
            )
            .await;
        let log = fixture.log().await;
        let prefix = log.prefix(500, 4 * 1024 * 1024).await.unwrap();
        let anchor = prefix
            .events
            .iter()
            .find(|stored| {
                matches!(
                    stored.event.fact,
                    Fact::InvocationOpened {
                        input: InvocationInput::Message { .. },
                        ..
                    }
                )
            })
            .unwrap();
        assert!(!prefix.events.iter().any(|stored| matches!(
            stored.event.fact,
            Fact::InvocationOpened {
                input: InvocationInput::ContextCompact { .. },
                ..
            }
        )));
        let checkpoints: Vec<_> = prefix
            .events
            .iter()
            .filter_map(|stored| match &stored.event.fact {
                Fact::ContextCheckpointRecorded { checkpoint } => Some((stored, checkpoint)),
                _ => None,
            })
            .collect();
        assert_eq!(checkpoints.len(), 1);
        let (recorded, checkpoint) = checkpoints[0];
        assert_eq!(
            checkpoint.mode,
            CheckpointMode::MidTurn {
                anchor_event_id: anchor.event.id.clone()
            }
        );
        assert_eq!(recorded.event.invocation, anchor.event.invocation);
        assert_eq!(
            prefix
                .events
                .iter()
                .filter(|stored| matches!(
                    &stored.event.fact, Fact::ToolDispatched { name, .. } if name == "Read"
                ))
                .count(),
            1
        );
        assert_eq!(
            prefix
                .events
                .iter()
                .filter(|stored| matches!(
                    stored.event.fact,
                    Fact::ModelRequested {
                        purpose: ModelPurpose::Summary,
                        ..
                    }
                ))
                .count(),
            1
        );
        let source = log
            .read_model_context("auto-context", None, 500, 4 * 1024 * 1024)
            .await
            .unwrap();
        assert_eq!(source.baseline.unwrap().event_id, recorded.event.id);
        assert_eq!(source.anchor.unwrap().event.id, anchor.event.id);
        let LatestMainContext::Selected(main) =
            log.latest_main_context("auto-context").await.unwrap()
        else {
            panic!("accepted main request must retain its own diagnostics");
        };
        assert_eq!(
            main.usage.input_tokens,
            Some(if reopened { 14 } else { 12 })
        );
        let context = main.context.unwrap();
        assert_eq!(context.provider_id, "openai");
        assert_eq!(context.context_window, Some(1_000_000));
        assert_eq!(context.model_context_window, Some(1_000_000));
        assert_eq!(context.declared_window, Some(828_400));
        let facts = serde_json::to_value(&prefix.events).unwrap();
        if let Some(original) = &original {
            let original: &Vec<serde_json::Value> = original;
            assert_eq!(&facts.as_array().unwrap()[..original.len()], original);
        } else {
            original = Some(facts.as_array().unwrap().clone());
        }
    }
}
