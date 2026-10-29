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

use maka_agent_facts::accounting::Tokens;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::model::ModelFinishReason;
use maka_agent_facts::model::ModelUsage;
use maka_agent_facts::model::recorded::ModelCompletion;
use maka_agent_facts::pricing::Quote;
use maka_event_log::EventLog;
use serde_json::json;
#[path = "usage/fixture.rs"]
mod fixture;
use fixture::{event, query, request};

#[tokio::test]
async fn summary_keeps_missing_and_free_distinct_and_reuses_the_activity_fence() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("summary.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let empty = log.usage_summary(query()).await.unwrap().summary;
    assert_eq!(empty.models.calls, 0);
    assert_eq!(
        empty.models.input,
        Tokens {
            known: 0,
            missing: 0
        }
    );
    assert_eq!(empty.tools.mean_latency_ms, None);
    log.append(&event(
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content: "fixture".into(),
                source_messages: vec![],
                request_fingerprint: None,
            },
        },
        0,
    ))
    .await
    .unwrap();
    let priced: Quote = serde_json::from_value(json!({
        "providerId":"fixture", "revision":1,
        "pricing":{"modelKey":"fixture:model","inputUsdPer1M":1,"outputUsdPer1M":2}
    }))
    .unwrap();
    let free: Quote = serde_json::from_value(json!({
        "providerId":"fixture", "revision":2,
        "pricing":{"modelKey":"fixture:model","inputUsdPer1M":0,"outputUsdPer1M":0}
    }))
    .unwrap();
    for (id, quote, input, output) in [
        ("free", Some(free), 1, Some(0)),
        ("unpriced", None, 2, None),
        ("partial", Some(priced.clone()), 3, None),
    ] {
        let mut admitted = request(id, 1000);
        if let Some(quote) = quote {
            admitted = admitted.with_quote(quote).unwrap();
        }
        log.append_batch(&[admitted, completed(id, input, output, 1250)])
            .await
            .unwrap();
    }
    log.append(&request("paid", 2000).with_quote(priced).unwrap())
        .await
        .unwrap();
    let first = log.model_attempts(query(), 0, 100).await.unwrap();
    let mut fixed = query();
    fixed.through = Some(first.through);
    log.append(&completed("paid", 1_000_000, Some(2_000_000), 2250))
        .await
        .unwrap();
    let captured = log.usage_summary(fixed.clone()).await.unwrap();
    assert_eq!(captured.through, first.through);
    assert_eq!(captured.summary.models.calls, 3);
    assert_eq!(captured.summary.pending.models, 1);
    let current = log.usage_summary(query()).await.unwrap();
    let models = &current.summary.models;
    assert_eq!(current.summary.pending.models, 0);
    assert_eq!(models.calls, 4);
    assert_eq!(models.duration_ms, 1.0, "four 250-microsecond calls");
    assert_eq!(models.success, 4);
    assert_eq!(
        models.input,
        Tokens {
            known: 1_000_006,
            missing: 0
        }
    );
    assert_eq!(
        models.output,
        Tokens {
            known: 2_000_000,
            missing: 2
        }
    );
    assert_eq!(
        models.cache_read,
        Tokens {
            known: 0,
            missing: 4
        }
    );
    assert_eq!(models.cost.known_usd, 5.0);
    assert_eq!(
        models.cost.unvalued, 2,
        "free is valued; incomplete usage is not"
    );
    assert_eq!(
        models.cost.unpriced, 1,
        "missing usage does not imply missing rates"
    );
    assert_eq!(current.summary.by_model.len(), 1);
    assert_eq!(current.summary.by_model[0].totals, *models);
    assert_eq!(current.summary.by_provider.len(), 2);
    assert_eq!(
        current.summary.by_provider[0].provider_id.as_deref(),
        Some("fixture")
    );
    assert_eq!(current.summary.by_provider[0].totals.calls, 3);
    assert_eq!(current.summary.by_provider[1].provider_id, None);
    assert_eq!(current.summary.by_provider[1].totals.cost.unpriced, 1);
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        log.usage_summary(query()).await.unwrap().summary,
        current.summary
    );
    assert_eq!(
        log.usage_summary(fixed.clone()).await.unwrap().summary,
        captured.summary
    );

    log.append_batch(&[
        request("overflow", 20000),
        completed("overflow", u64::MAX, Some(0), 21000),
    ])
    .await
    .unwrap();
    assert!(matches!(log.usage_summary(query()).await,
        Err(maka_event_log::StoreError::InvalidTransition(message))
            if message.contains("exact integer capacity")));
    assert_eq!(
        log.usage_summary(fixed).await.unwrap().summary,
        captured.summary,
        "out-of-snapshot records cannot overflow this snapshot"
    );
    log.close().await.unwrap();
}

fn completed(
    id: &str,
    input: u64,
    output: Option<u64>,
    micros: u64,
) -> maka_agent_facts::event::EventWrite {
    event(
        Fact::ModelCompleted {
            step_id: id.into(),
            output: ModelCompletion {
                parts: vec![],
                finish_reason: ModelFinishReason::Stop,
                usage: ModelUsage {
                    input_tokens: Some(input),
                    output_tokens: output,
                    ..Default::default()
                },
                provider_options: None,
                response_id: None,
                model: None,
                timestamp: None,
            },
        },
        micros,
    )
}
