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

mod scope;

use super::{ClientFixture, Host, LocalListener, Peer, ready, success};
use maka_client::{Client, Operations};
use maka_plugins::authorization::{Capability, Request, Target};
use maka_protocol::plugin::{
    AuthorizationCommand, AuthorizationInput, AuthorizationResult, RemoteBinding, RemoteRequest,
    RemoteResult,
};
use serde_json::{Value, json};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_consent_uses_exact_backend_without_frontend_and_preserves_durable_revocation() {
    tokio::time::timeout(Duration::from_secs(30), scenario())
        .await
        .unwrap();
}
async fn scenario() {
    let fixture = ClientFixture::new("maka-native-consent-");
    let mut saved = None;
    let mut old_target = None;
    for reopened in [false, true] {
        let host = Host::open(fixture.owner()).await.unwrap();
        #[cfg(unix)]
        let endpoint = fixture
            .workspace
            .parent()
            .unwrap()
            .join("native-consent.sock");
        #[cfg(windows)]
        let endpoint = std::path::PathBuf::from(format!(
            r"\\.\pipe\maka-native-consent-{}",
            uuid::Uuid::new_v4()
        ));
        let stop = CancellationToken::new();
        let cleanup = stop.clone().drop_guard();
        let server = tokio::spawn(
            LocalListener::bind(&endpoint)
                .unwrap()
                .serve(host.clone(), stop.clone()),
        );
        let (mut peer, hello) = Peer::handshake(host.clone(), "native-consent-admin").await;
        ready(&mut peer).await;
        if !reopened {
            success(
                peer.rpc(
                    "plugin.composition.apply",
                    json!({"operations":[
                        {"type":"update","entryId":"maka.scheduler.ui","patch":{"disabled":true}}
                    ]}),
                )
                .await,
            );
            ready(&mut peer).await;
        }
        let directory = success(
            peer.rpc("plugin.client.query", json!({"kind":"snapshot"}))
                .await,
        );
        assert!(
            !directory["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["entryId"] == "maka.scheduler.ui")
        );
        let (client, mut notices) = Client::connect(
            maka_client::local::open_stream(&endpoint).await.unwrap(),
            host.root_id(),
            hello["hostEpoch"].as_str().unwrap(),
            Operations,
        )
        .await
        .unwrap();
        let notifications = tokio::spawn(async move { while notices.recv().await.is_some() {} });
        let binding = RemoteBinding::Package {
            package_id: "maka.scheduler".into(),
            method: "terminal".into(),
            session_id: None,
        };
        let RemoteResult::Bound { target, .. } = client
            .plugin_remote(RemoteRequest::Bind {
                binding: binding.clone(),
            })
            .await
            .unwrap()
        else {
            panic!("bound")
        };
        let input = |command| AuthorizationInput::Remote {
            binding: binding.clone(),
            target: target.clone(),
            command,
        };
        if let Some(old) = old_target.take() {
            assert!(
                client
                    .plugin_authorization(AuthorizationInput::Remote {
                        binding: binding.clone(),
                        target: old,
                        command: AuthorizationCommand::Query { id: saved.unwrap() },
                    })
                    .await
                    .is_err(),
                "reopen never authorizes through a retired registration"
            );
        }
        if !reopened {
            let proposal = Request {
                operation_id: uuid::Uuid::new_v4(),
                title: "Allow scheduled reminders".into(),
                target: Target::Profile,
                capabilities: [Capability::Notifications].into(),
            };
            let approve = input(AuthorizationCommand::Approve {
                request: proposal.clone(),
            });
            let AuthorizationResult::Grant { grant: Some(grant) } =
                client.plugin_authorization(approve.clone()).await.unwrap()
            else {
                panic!("grant")
            };
            saved = Some(grant.id);
            let AuthorizationResult::Grant {
                grant: Some(recovered),
            } = client.plugin_authorization(approve).await.unwrap()
            else {
                panic!("recovered receipt")
            };
            assert_eq!(grant, recovered);
            let mut different = proposal.clone();
            different.title = "A different proposal".into();
            assert!(
                client
                    .plugin_authorization(input(AuthorizationCommand::Approve {
                        request: different
                    }))
                    .await
                    .is_err()
            );
            let mut forged = target.clone();
            forged.registration = uuid::Uuid::new_v4();
            assert!(
                client
                    .plugin_authorization(AuthorizationInput::Remote {
                        binding: binding.clone(),
                        target: forged,
                        command: AuthorizationCommand::Approve {
                            request: Request {
                                operation_id: uuid::Uuid::new_v4(),
                                ..proposal
                            }
                        },
                    })
                    .await
                    .is_err()
            );
            let created = scheduler(&client, json!({"kind":"mutate","grant":grant.id,"mutation":{
                "kind":"create","input":{"title":"Native reminder","intentBody":"Check the result",
                    "schedule":{"kind":"once","runAt":jiff::Timestamp::now().as_millisecond()+3_600_000},
                    "effect":{"kind":"notify","channel":"local"}}
            }})).await.unwrap();
            scheduler(&client, json!({"kind":"mutate","mutation":{"kind":"delete","taskId":created["task"]["id"]}})).await.unwrap();
            client
                .plugin_authorization(input(AuthorizationCommand::Revoke { id: grant.id }))
                .await
                .unwrap();
        }
        let id = saved.unwrap();
        let AuthorizationResult::Grant {
            grant: Some(revoked),
        } = client
            .plugin_authorization(input(AuthorizationCommand::Query { id }))
            .await
            .unwrap()
        else {
            panic!("persisted receipt")
        };
        assert!(revoked.revoked);
        assert!(scheduler(&client, json!({"kind":"mutate","grant":id,"mutation":{
            "kind":"create","input":{"title":"Must not run","intentBody":"Denied",
                "schedule":{"kind":"once","runAt":jiff::Timestamp::now().as_millisecond()+3_600_000},
                "effect":{"kind":"notify","channel":"local"}}
        }})).await.is_err(), "original scheduler rechecks revoked authority");
        old_target = Some(target);
        client.disconnect();
        notifications.await.unwrap();
        success(
            peer.rpc(
                "host.upgrade.prepare",
                json!({"expectedHostEpoch":hello["hostEpoch"],"allowInterruptActiveTasks":false}),
            )
            .await,
        );
        peer.close().await;
        stop.cancel();
        server.await.unwrap().unwrap();
        cleanup.disarm();
        drop(host);
    }
}
async fn scheduler(client: &Client, input: Value) -> Result<Value, maka_client::RequestFailure> {
    let binding = RemoteBinding::Package {
        package_id: "maka.scheduler".into(),
        method: "request".into(),
        session_id: None,
    };
    let RemoteResult::Bound { target, .. } = client
        .plugin_remote(RemoteRequest::Bind {
            binding: binding.clone(),
        })
        .await?
    else {
        panic!("bound")
    };
    let RemoteResult::Document { document } =
        client.plugin_remote(RemoteRequest::OpenDocument).await?
    else {
        panic!("document")
    };
    let result = client
        .plugin_remote(RemoteRequest::Call {
            binding,
            target,
            document,
            input,
        })
        .await;
    client
        .plugin_remote(RemoteRequest::CloseDocument { document })
        .await
        .unwrap();
    let RemoteResult::Value { value } = result? else {
        panic!("value")
    };
    Ok(value)
}
