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

use super::connection::pair_with;
use maka_client::{ClientError, RequestFailure};
use maka_protocol::plugin::{ClientQuery, RemoteRequest};
use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn consent_receipt_for_a_different_proposal_closes_without_approving_again() {
    let (client, _notices, mut reader, mut writer) = pair_with(maka_client::Operations).await;
    let proposal = json!({"operationId":uuid::Uuid::new_v4(),"title":"Notifications",
        "target":{"kind":"profile"},"capabilities":["notifications"]});
    let input = json!({
        "binding":{"packageId":"maka.scheduler","method":"terminal","sessionId":null},
        "target":{"entryId":"maka.scheduler","activation":uuid::Uuid::new_v4(),"registration":uuid::Uuid::new_v4()},
        "command":{"kind":"approve","request":proposal}
    });
    let request = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .plugin_authorization(serde_json::from_value(input).unwrap())
                .await
        }
    });
    let frame = reader.read().await.unwrap().unwrap();
    assert_eq!(frame["operation"], "plugin.authorization");
    let mut wrong = proposal;
    wrong["title"] = json!("A different grant");
    writer.write(&json!({
        "requestId":frame["requestId"],"operation":frame["operation"],"ok":true,
        "result":{"kind":"grant","grant":{"id":uuid::Uuid::new_v4(),"request":wrong,"revoked":false}}
    })).await.unwrap();
    assert!(matches!(
        request.await.unwrap(),
        Err(RequestFailure::Unknown(ClientError::Protocol(_)))
    ));
    tokio::time::timeout(Duration::from_secs(1), client.closed())
        .await
        .unwrap();
    assert!(reader.read().await.unwrap().is_none());
}

#[tokio::test]
async fn remote_calls_validate_variants_without_rebinding_or_replaying_unknown_results() {
    let document = uuid::Uuid::new_v4();
    let stream = uuid::Uuid::new_v4();
    let binding = json!({"packageId":"maka.skills","method":"request","sessionId":"chosen"});
    let target = json!({"entryId":"skills","activation":uuid::Uuid::new_v4(),"registration":uuid::Uuid::new_v4()});
    let cases = [
        (
            json!({"kind":"open_document"}),
            json!({"kind":"document","document":document}),
        ),
        (
            json!({"kind":"bind","binding":binding}),
            json!({"kind":"bound","target":target,"handler":"method"}),
        ),
        (
            json!({"kind":"call","binding":binding,"target":target,"document":document,"input":{"kind":"invocable"}}),
            json!({"kind":"value","value":{"kind":"page","items":[]}}),
        ),
        (
            json!({"kind":"open","binding":binding,"target":target,"document":document,"input":null}),
            json!({"kind":"opened","stream":stream}),
        ),
        (
            json!({"kind":"next","document":document,"stream":stream}),
            json!({"kind":"item","item":null}),
        ),
        (
            json!({"kind":"next","document":document,"stream":stream}),
            json!({"kind":"pending"}),
        ),
        (
            json!({"kind":"next","document":document,"stream":stream}),
            json!({"kind":"end"}),
        ),
        (
            json!({"kind":"close","document":document,"stream":stream}),
            json!({"kind":"closed"}),
        ),
        (
            json!({"kind":"close_document","document":document}),
            json!({"kind":"closed"}),
        ),
    ];
    for (input, output) in cases {
        for valid in [true, false] {
            let (client, _notices, mut reader, mut writer) =
                pair_with(maka_client::Operations).await;
            let request = tokio::spawn({
                let client = client.clone();
                let input: RemoteRequest = serde_json::from_value(input.clone()).unwrap();
                async move { client.plugin_remote(input).await }
            });
            let frame = reader.read().await.unwrap().unwrap();
            assert_eq!(frame["input"], input);
            let reply = if valid {
                output.clone()
            } else if output["kind"] == "value" {
                json!({"kind":"closed"})
            } else {
                json!({"kind":"value","value":null})
            };
            writer
                .write(
                    &json!({"requestId":frame["requestId"],"operation":frame["operation"],
                "ok":true,"result":reply}),
                )
                .await
                .unwrap();
            if valid {
                assert_eq!(
                    serde_json::to_value(request.await.unwrap().unwrap()).unwrap(),
                    output
                );
                client.disconnect();
            } else {
                assert!(matches!(
                    request.await.unwrap(),
                    Err(RequestFailure::Unknown(ClientError::Protocol(_)))
                ));
            }
            tokio::time::timeout(Duration::from_secs(1), client.closed())
                .await
                .unwrap();
            // No retry, bind, or cleanup command is invented after a corrupt response.
            assert!(reader.read().await.unwrap().is_none());
        }
    }
}

#[tokio::test]
async fn plugin_catalog_binds_page_progress_and_bundle_identity_to_the_request() {
    let revision = format!("sha256-{}", "a".repeat(64));
    let other = format!("sha256-{}", "b".repeat(64));
    let activation = uuid::Uuid::new_v4().to_string();
    let descriptor = json!({"entryId":"next","extensionId":"maka.skills","activation":activation,
        "contentDigest":revision,"clientDigest":revision,"sdkVersion":1,"totalBytes":1,
        "dependencies":[],"config":{}});
    let start = json!({"kind":"snapshot","cursor":null});
    let page =
        json!({"kind":"snapshot","revision":revision,"entries":[descriptor],"nextCursor":null});
    let continuation =
        json!({"kind":"snapshot","cursor":{"revision":revision,"afterEntry":"before"}});
    let bundle = json!({"kind":"bundle","entryId":"chosen","activation":activation,"clientDigest":revision,"offset":0});
    let chunk = json!({"kind":"bundle","entryId":"chosen","activation":activation,
        "clientDigest":revision,"offset":0,"totalBytes":1,"content":"x","nextOffset":null});
    let mut cases = vec![
        (start.clone(), page.clone(), true),
        (continuation.clone(), page.clone(), true),
        (bundle.clone(), chunk.clone(), true),
        (start, chunk.clone(), false),
        (bundle.clone(), page.clone(), false),
    ];
    let mut changed = page.clone();
    changed["revision"] = json!(other);
    cases.push((continuation.clone(), changed, false));
    let mut repeated = page.clone();
    repeated["entries"][0]["entryId"] = json!("before");
    cases.push((continuation, repeated, false));
    for (key, value) in [
        ("entryId", json!("wrong")),
        ("activation", json!(uuid::Uuid::new_v4())),
        ("clientDigest", json!(other)),
        ("offset", json!(1)),
    ] {
        let mut changed = chunk.clone();
        changed[key] = value;
        if key == "offset" {
            changed["totalBytes"] = json!(2);
        }
        cases.push((bundle.clone(), changed, false));
    }
    for (input, output, valid) in cases {
        let (client, _notices, mut reader, mut writer) = pair_with(maka_client::Operations).await;
        let request = tokio::spawn({
            let client = client.clone();
            let input: ClientQuery = serde_json::from_value(input).unwrap();
            async move { client.plugin_clients(input).await }
        });
        let frame = reader.read().await.unwrap().unwrap();
        writer
            .write(
                &json!({"requestId":frame["requestId"],"operation":frame["operation"],
            "ok":true,"result":output}),
            )
            .await
            .unwrap();
        if valid {
            assert_eq!(
                serde_json::to_value(request.await.unwrap().unwrap()).unwrap(),
                output
            );
            client.disconnect();
        } else {
            assert!(matches!(
                request.await.unwrap(),
                Err(RequestFailure::Unknown(ClientError::Protocol(_)))
            ));
        }
        tokio::time::timeout(Duration::from_secs(1), client.closed())
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn terminal_directory_rejects_a_different_valid_view_without_retrying() {
    for valid in [true, false] {
        let (client, _notices, mut reader, mut writer) = pair_with(maka_client::Operations).await;
        let request = tokio::spawn({
            let client = client.clone();
            async move {
                client
                    .plugin_query(
                        serde_json::from_value(
                            json!({"view":"terminal_views","rootId":"profile","limit":16}),
                        )
                        .unwrap(),
                    )
                    .await
            }
        });
        let frame = reader.read().await.unwrap().unwrap();
        assert_eq!(frame["operation"], "plugin.platform.query");
        let result = json!({"view":if valid { "terminal_views" } else { "tools" }, "items":[], "nextCursor":null});
        writer.write(&json!({"requestId":frame["requestId"],"operation":frame["operation"],"ok":true,"result":result})).await.unwrap();
        if valid {
            request.await.unwrap().unwrap();
            client.disconnect();
        } else {
            assert!(matches!(
                request.await.unwrap(),
                Err(RequestFailure::Unknown(ClientError::Protocol(_)))
            ));
        }
        tokio::time::timeout(Duration::from_secs(1), client.closed())
            .await
            .unwrap();
        assert!(
            reader.read().await.unwrap().is_none(),
            "directory failure cannot trigger a replacement request"
        );
    }
}

#[tokio::test]
async fn management_requests_cross_the_client_registry_with_review_preconditions_intact() {
    use maka_protocol::Operation;
    let digest = format!("sha256-{}", "a".repeat(64));
    let expected = json!({"baseGeneration":7,"contentDigest":null});
    let receipt = json!({"authorityEpoch":8,"durability":"committed","convergence":"converged","cleanup":"complete","failures":[]});
    let preview = json!({"sourcePath":"/reviewed/source","package":{
        "baseGeneration":7,"extensionId":"example.notes","contentDigest":digest,"displayName":"Notes",
        "dependencies":[],"structuralDependencies":[],"requiredBy":[],
        "hasRuntime":true,"hasClient":false,"hasComposition":false},"expected":expected});
    let cases = [
        (
            Operation::PluginPackagePreview,
            json!({"sourcePath":"/reviewed/source"}),
            preview,
        ),
        (
            Operation::PluginPackageInstall,
            json!({"sourcePath":"/reviewed/source","sourceDigest":digest,"expected":expected}),
            {
                let mut installed = receipt.clone();
                installed["extensionId"] = json!("example.notes");
                installed
            },
        ),
        (
            Operation::PluginPackageReload,
            json!({"extensionId":"example.notes","expected":{"baseGeneration":8,"contentDigest":digest}}),
            receipt.clone(),
        ),
        (
            Operation::PluginCompositionApply,
            json!({"baseGeneration":8,"operations":[{"type":"remove","entryId":"notes"}]}),
            receipt.clone(),
        ),
        (
            Operation::PluginPackageUninstall,
            json!({"extensionId":"example.notes","expected":{"baseGeneration":8,"contentDigest":digest}}),
            receipt,
        ),
    ];
    let (client, _notices, mut reader, mut writer) = pair_with(maka_client::Operations).await;
    for (operation, input, output) in cases {
        let request = tokio::spawn({
            let client = client.clone();
            let input = input.clone();
            async move { client.request(operation, input).await }
        });
        let frame = tokio::time::timeout(Duration::from_secs(5), reader.read())
            .await
            .expect("management request must reach the wire")
            .unwrap()
            .unwrap();
        assert_eq!(frame["operation"], operation.as_str());
        assert_eq!(frame["input"], input);
        writer.write(&json!({"requestId":frame["requestId"],"operation":frame["operation"],"ok":true,"result":output})).await.unwrap();
        assert_eq!(request.await.unwrap().unwrap(), output);
    }
    let request = tokio::spawn({
        let client = client.clone();
        async move {
            client.request(Operation::PluginPackageReload, json!({"extensionId":"example.notes","expected":{"baseGeneration":1,"contentDigest":digest}})).await
        }
    });
    let frame = reader.read().await.unwrap().unwrap();
    writer
        .write(
            &json!({"requestId":frame["requestId"],"operation":frame["operation"],"ok":false,
        "error":{"code":"operation_conflict","message":"Reviewed generation changed"}}),
        )
        .await
        .unwrap();
    assert!(
        matches!(request.await.unwrap(), Err(RequestFailure::Rejected(ClientError::Rejected(error))) if error.code == maka_protocol::OperationErrorCode::OperationConflict)
    );
    client.disconnect();
}

#[tokio::test]
async fn idle_remote_waits_leave_finite_calls_and_control_close_admissible() {
    tokio::time::timeout(Duration::from_secs(3), async {
        let (client, _notices, mut reader, mut writer) = pair_with(maka_client::Operations).await;
        let document = uuid::Uuid::new_v4();
        let mut waiting = Vec::new();
        let mut frames = Vec::new();
        for _ in 0..96 {
            let client = client.clone();
            waiting.push(tokio::spawn(async move {
                client.plugin_remote(RemoteRequest::Next { document, stream: uuid::Uuid::new_v4() }).await
            }));
        }
        for _ in 0..96 {
            let frame = reader.read().await.unwrap().unwrap();
            assert_eq!(frame["input"]["kind"], "next");
            frames.push(frame);
        }
        // Saturate only the unchanged ordinary budget. Close still owns a
        // reserved control permit, regardless of the idle observation count.
        let mut calls = Vec::new();
        for _ in 0..60 {
            let client = client.clone();
            calls.push(tokio::spawn(async move {
                client.request(maka_protocol::Operation::HostWake, json!({})).await
            }));
        }
        let mut call_frames = Vec::new();
        for _ in 0..60 { call_frames.push(reader.read().await.unwrap().unwrap()); }
        let close = tokio::spawn({
            let client = client.clone();
            async move { client.plugin_remote(RemoteRequest::CloseDocument { document }).await }
        });
        let frame = reader.read().await.unwrap().unwrap();
        assert_eq!(frame["input"]["kind"], "close_document");
        writer.write(&json!({"requestId":frame["requestId"],"operation":"plugin.remote","ok":true,"result":{"kind":"closed"}})).await.unwrap();
        assert!(close.await.unwrap().is_ok());
        for frame in call_frames {
            writer.write(&json!({"requestId":frame["requestId"],"operation":frame["operation"],"ok":true,"result":{}})).await.unwrap();
        }
        for call in calls { assert!(call.await.unwrap().is_ok()); }
        for frame in frames {
            writer.write(&json!({"requestId":frame["requestId"],"operation":"plugin.remote","ok":true,"result":{"kind":"end"}})).await.unwrap();
        }
        for wait in waiting { assert!(wait.await.unwrap().is_ok()); }
        client.disconnect();
    }).await.expect("idle observations blocked finite/control requests");
}
