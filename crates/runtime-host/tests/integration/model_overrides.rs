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
use maka_runtime::{context::ModelPurpose, event::Fact};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn client_declarations_freeze_each_model_step_and_reopen_without_rewriting_requests() {
    let fixture = ClientFixture::new("maka-model-overrides-");
    let mut original = None;
    for reopened in [false, true] {
        fixture
            .run(
                "--model-overrides-workspace",
                reopened,
                if reopened {
                    "model-overrides-reopened"
                } else {
                    "model-overrides-passed"
                },
            )
            .await;
        let log = fixture.log().await;
        let prefix = log.prefix(500, 4 * 1024 * 1024).await.unwrap();
        let mut requests = Vec::new();
        for stored in &prefix.events {
            if let Fact::ModelRequested {
                purpose, context, ..
            } = &stored.event.fact
            {
                assert_eq!(*purpose, ModelPurpose::Main);
                let context = context.as_ref().unwrap();
                requests.push((
                    stored.event.invocation.turn_id.as_str(),
                    context.context_window,
                    context.declared_window,
                    context.model_context_window,
                ));
            }
        }
        assert_eq!(requests.len(), if reopened { 6 } else { 5 });
        assert_eq!(
            &requests[..5],
            &[
                ("input-only-1", Some(200), Some(170), Some(1000)),
                ("input-only-2", Some(200), Some(170), Some(1000)),
                ("frozen", Some(32000), Some(64000), Some(64000)),
                ("frozen", Some(32000), Some(96000), Some(96000)),
                ("next", Some(32000), Some(96000), Some(96000)),
            ]
        );
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
        let facts = serde_json::to_value(&prefix.events).unwrap();
        if let Some(original) = &original {
            let original: &Vec<serde_json::Value> = original;
            assert_eq!(&facts.as_array().unwrap()[..original.len()], original);
        } else {
            original = Some(facts.as_array().unwrap().clone());
        }
        log.close().await.unwrap();
    }
}
