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
use super::support::{
    message_recovery::{Provider, configure},
    peer::Peer,
};
use maka_runtime_host::server::{Host, local::LocalListener};
use serde_json::json;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn source_client_pages_edits_and_recovers_native_pricing() {
    let fixture = ClientFixture::new("maka-pricing-client-");
    for reopened in [false, true] {
        fixture
            .run(
                "--pricing-workspace",
                reopened,
                if reopened {
                    "pricing-reopened"
                } else {
                    "pricing-passed"
                },
            )
            .await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn in_flight_model_quotes_are_frozen_and_next_admission_observes_rate_changes() {
    let fixture = ClientFixture::new("maka-pricing-flight-");
    let (provider, mut requests) = Provider::controlled_with_usage(100, 20).await;
    let model = configure(&fixture, &provider.base_url).await;
    let host = Host::open(fixture.owner()).await.unwrap();
    #[cfg(unix)]
    let endpoint = fixture.workspace.parent().unwrap().join("pricing.sock");
    #[cfg(windows)]
    let endpoint =
        std::path::PathBuf::from(format!(r"\\.\pipe\maka-pricing-{}", uuid::Uuid::new_v4()));
    let cancel = CancellationToken::new();
    let server = tokio::spawn(
        LocalListener::bind(&endpoint)
            .unwrap()
            .serve(host.clone(), cancel.clone()),
    );
    let mut peer = Peer::new(host, "pricing-flight").await;
    peer.wait_for_plugins().await;
    let created = peer
        .rpc(
            "session.create",
            json!({
                "sessionId":"priced", "workspace":{"kind":"host_path","path":fixture.workspace},
                "modelTarget":{"kind":"explicit","connectionId":model.connection_id,
                    "connectionSlug":model.connection_slug,"model":model.model}
            }),
        )
        .await;
    assert_eq!(created["ok"], true, "{created}");
    let mutation = |revision, rate| {
        json!({
            "expectedRevision":revision, "mutation":{"kind":"upsert", "pricing":{
                "modelKey":"openai-compatible:fixture-model", "inputUsdPer1M":rate, "outputUsdPer1M":rate
            }}
        })
    };
    let first = peer.rpc("pricing.mutate", mutation(0, 1.0)).await;
    assert_eq!(first["result"]["revision"], 1, "{first}");
    for turn in ["before-edit", "after-edit"] {
        let started = peer
            .rpc(
                "turn.start",
                json!({"sessionId":"priced","turnId":turn,
            "content":{"text":"hello"},"maxSteps":2}),
            )
            .await;
        assert_eq!(started["ok"], true, "{started}");
        let request = tokio::time::timeout(Duration::from_secs(10), requests.recv())
            .await
            .unwrap()
            .unwrap();
        if turn == "before-edit" {
            let edit = peer.rpc("pricing.mutate", mutation(1, 10.0)).await;
            assert_eq!(edit["result"]["revision"], 2, "{edit}");
        }
        let rejected = turn == "after-edit";
        request
            .reply
            .send(json!({"index":0,"delta":{"content":"done"},"finish_reason":if rejected {"length"} else {"stop"}}))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let result = peer
                    .rpc("turn.query", json!({"sessionId":"priced","turnId":turn}))
                    .await;
                assert_eq!(result["ok"], true, "{result}");
                if result["result"]["status"] == "completed"
                    || result["result"]["status"] == "failed"
                {
                    assert_eq!(
                        result["result"]["status"],
                        if rejected { "failed" } else { "completed" },
                        "{result}"
                    );
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
    peer.close().await;
    cancel.cancel();
    tokio::time::timeout(Duration::from_secs(10), server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let log = fixture.log().await;
    let records = log
        .model_attempts(
            maka_event_log::usage::Query {
                from: 0.0,
                to: f64::MAX,
                session_id: Some("priced".into()),
                through: None,
            },
            0,
            100,
        )
        .await
        .unwrap();
    assert_eq!(records.total, 2);
    assert_eq!(
        records.attempts[0].outcome,
        maka_event_log::usage::Outcome::Success
    );
    for (attempt, revision, expected) in [
        (&records.attempts[0], 2, 0.0012),
        (&records.attempts[1], 1, 0.00012),
    ] {
        let quote = attempt.quote.as_ref().unwrap();
        assert_eq!(quote.provider_id, "openai-compatible");
        assert_eq!(quote.revision, revision);
        assert!((attempt.cost_usd.unwrap() - expected).abs() < 1e-12);
    }
    log.close().await.unwrap();
}
