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

use super::support::{
    client_probe::ClientFixture,
    message_recovery::{Provider, configure},
    peer::Peer,
};
use maka_plugins::{client::Bundle, kernel::Definition};
use maka_runtime_host::{
    plugins::Setup,
    server::{Host, HostOptions, local::LocalListener},
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn renamed_workhub_uses_public_consent_and_recovers_exact_receipts() {
    tokio::time::timeout(Duration::from_secs(30), scenario())
        .await
        .unwrap();
}
async fn scenario() {
    let fixture = ClientFixture::new("maka-workhub-public-");
    let database_path = fixture
        .owner()
        .canonical_path()
        .join(maka_event_log::root::ROOT_DATABASE);
    let (provider, mut requests) = Provider::controlled().await;
    let tool = Arc::new(std::sync::Mutex::new(None::<Value>));
    let pending = tool.clone();
    let hold = Arc::new(std::sync::Mutex::new(
        None::<tokio::sync::oneshot::Sender<super::support::message_recovery::ModelRequest>>,
    ));
    let holding = hold.clone();
    let replies = tokio::spawn(async move {
        let mut long_answer_sent = false;
        while let Some(request) = requests.recv().await {
            if result_notification(&request.body).is_some() {
                let _ = request.reply.send(
                    json!({"index":0,"delta":{"content":"Result received"},"finish_reason":"stop"}),
                );
                continue;
            }
            if !long_answer_sent
                && request.body["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .rev()
                    .find(|message| message["role"] == "user")
                    .is_some_and(|message| {
                        message["content"].to_string().contains("Delegated work")
                    })
            {
                long_answer_sent = true;
                let _ = request.reply.send(json!({"index":0,"delta":{"content":"阅读🦀\0\n".repeat(6000)},"finish_reason":"stop"}));
                continue;
            }
            if let Some(send) = holding.lock().unwrap().take() {
                assert!(send.send(request).is_ok());
                continue;
            }
            let choice = match pending.lock().unwrap().take() {
                Some(input) => json!({"index":0,"delta":{"tool_calls":[{
                    "index":0,"id":"route-from-model","type":"function",
                    "function":{"name":"workhub_tasks","arguments":input.to_string()}
                }]},"finish_reason":"tool_calls"}),
                None => json!({"index":0,"delta":{"content":"finished"},"finish_reason":"stop"}),
            };
            let _ = request.reply.send(choice);
        }
    });
    let model = configure(&fixture, &provider.base_url).await;
    let configuration = maka_config::ConfigurationStore::for_root(Arc::new(fixture.owner()))
        .await
        .unwrap();
    {
        use sha2::{Digest, Sha256};
        configuration
            .create_access_credential(
                maka_config::access::AccessCredential {
                    credential_id: "workhub-viewer".into(),
                    credential_hash: format!("{:x}", Sha256::digest(b"synthetic-workhub-viewer")),
                    principal_id: "workhub-viewer".into(),
                    principal_kind: maka_runtime::access::ManagedPrincipalKind::RemoteOwner,
                    grants: vec!["plugin.remote".into()],
                    can_publish_client_capabilities: false,
                    can_use_host_paths: false,
                    created_at: "2026-09-22T00:00:00Z".into(),
                    state: maka_config::access::CredentialState::Active {
                        client_instance_id: None,
                    },
                    capability_owner: None,
                },
                maka_config::access::AccessCreateMode::Issue,
                None,
            )
            .await
            .unwrap();
    }
    configuration.close().await.unwrap();
    let mut original = Value::Null;
    let mut intent = Value::Null;
    let mut coordinator = String::new();
    let mut controls = Vec::<Value>::new();
    let mut repair_intent = Value::Null;
    let mut repaired = Value::Null;
    let mut returned = Value::Null;
    for reopened in [false, true] {
        let host = Host::open_with_options(
            fixture.owner(),
            None,
            HostOptions {
                plugins: setup(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        #[cfg(unix)]
        let endpoint = fixture
            .workspace
            .parent()
            .unwrap()
            .join("public-workhub.sock");
        #[cfg(windows)]
        let endpoint = std::path::PathBuf::from(format!(
            r"\\.\pipe\maka-workhub-public-{}",
            uuid::Uuid::new_v4()
        ));
        let stop = CancellationToken::new();
        let cleanup = stop.clone().drop_guard();
        let websocket = maka_runtime_host::server::websocket::WebSocketListener::bind(
            "127.0.0.1:0".parse().unwrap(),
            vec![],
        )
        .await
        .unwrap();
        let address = websocket.local_addr().unwrap();
        let server = tokio::spawn(
            LocalListener::bind(&endpoint)
                .unwrap()
                .serve_with_websocket(websocket, host.clone(), stop.clone()),
        );
        let mut peer = Peer::new(host.clone(), "public-workhub-client").await;
        super::javascript_plugins::ready(&mut peer).await;
        let page = success(
            peer.rpc("plugin.client.query", json!({"kind":"snapshot"}))
                .await,
        );
        let entry = page["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["entryId"] == "public-workhub-ui")
            .unwrap();
        let client = json!({"entryId":entry["entryId"],"extensionId":entry["extensionId"],"activation":entry["activation"],
            "contentDigest":entry["contentDigest"],"clientDigest":entry["clientDigest"]});
        let document = success(
            peer.rpc("plugin.remote", json!({"kind":"open_document"}))
                .await,
        )["document"]
            .clone();
        if !reopened {
            let workspace = approve(
                &mut peer,
                &client,
                json!({"kind":"plugin_workspace","sandboxMode":"workspace-write"}),
            )
            .await;
            remote(
                &mut peer,
                &client,
                &document,
                None,
                "authorize",
                json!({"id":workspace["id"]}),
            )
            .await;
            let missing =
                remote_result(&mut peer, &client, &document, None, "resolve", Value::Null).await;
            assert_eq!(
                missing["ok"], false,
                "an unconfigured default must require a choice"
            );
            let choices = remote(
                &mut peer,
                &client,
                &document,
                None,
                "models",
                json!({"query":"fixture-model"}),
            )
            .await;
            assert_eq!(choices["complete"], true);
            assert_eq!(choices["models"][0]["model"], json!(model));
            // A valid binding with unsupported thinking leaves a durable, failed
            // creation intent. A later user choice must repair it at the same ID.
            let rejected = remote_result(
                &mut peer,
                &client,
                &document,
                None,
                "select-coordinator-model",
                json!({"kind":"model","model":model,"thinkingLevel":"max"}),
            )
            .await;
            assert_eq!(rejected["ok"], false);
            let view = remote(
                &mut peer,
                &client,
                &document,
                None,
                "select-coordinator-model",
                json!({"kind":"model","model":model,"thinkingLevel":null}),
            )
            .await;
            coordinator = view["sessionId"].as_str().unwrap().to_owned();
            assert_ne!(coordinator, "maka_workhub_coordination");
            assert_eq!(view["behavior"], "z.workhub.coordinator");
            assert_eq!(view["sandboxMode"], "workspace-write");
            assert_eq!(view["approvalPolicy"], json!({"kind":"on-request"}));
            restricted_selection(
                address,
                &client,
                "select-coordinator-model",
                json!({"kind":"model","model":model,"thinkingLevel":null}),
            )
            .await;
            success(peer.rpc("session.create", json!({
                "sessionId":"workhub-target", "workspace":{"kind":"host_path","path":fixture.workspace},
                "modelTarget":{"kind":"explicit","connectionId":model.connection_id,"connectionSlug":model.connection_slug,"model":model.model}
            })).await);
            let target = approve(
                &mut peer,
                &client,
                json!({"kind":"session","sessionId":"workhub-target"}),
            )
            .await;
            let attachment = upload(&mut peer, &coordinator).await;
            let answer = json!({"operationId":"user-answer","text":"Do the approved work","attachments":[attachment]});
            let source = remote(
                &mut peer,
                &client,
                &document,
                Some(&coordinator),
                "answer",
                answer.clone(),
            )
            .await;
            loop {
                let observed = remote(
                    &mut peer,
                    &client,
                    &document,
                    Some(&coordinator),
                    "answer-receipt",
                    answer.clone(),
                )
                .await;
                if observed["progress"]["state"] == "ended" {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            intent = json!({
                "operationId":"route-once", "source":source["invocation"], "authorization":{"kind":"session","sessionId":"workhub-target"},
                "target":{"kind":"existing","sessionId":"workhub-target"},
                "content":{"text":"Delegated work","attachments":[attachment]}
            });
            // Plugin intent is durable, but absent consent must not admit Host work.
            let denied = remote_result(
                &mut peer,
                &client,
                &document,
                Some(&coordinator),
                "route",
                intent.clone(),
            )
            .await;
            assert_eq!(denied["ok"], false, "{denied}");
            assert_eq!(provider.requests.lock().unwrap().len(), 1);
            remote(
                &mut peer,
                &client,
                &document,
                None,
                "authorize",
                json!({"id":target["id"]}),
            )
            .await;
            // A fresh grant wakes recovery without asking the caller to reconstruct the route.
            loop {
                let view = remote(
                    &mut peer,
                    &client,
                    &document,
                    None,
                    "inspect",
                    json!({"assignmentId":"route-once"}),
                )
                .await;
                if !view["delivery"].is_null() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            original = remote(
                &mut peer,
                &client,
                &document,
                Some(&coordinator),
                "route",
                intent.clone(),
            )
            .await;
            assert_eq!(original["kind"], "submitted");
            wait_assignment(&mut peer, &client, &document, "route-once").await;
            let first = remote(
                &mut peer,
                &client,
                &document,
                None,
                "inspect",
                json!({"assignmentId":"route-once"}),
            )
            .await;
            let mut answer = first["observation"]["state"]["answer"].clone();
            assert_eq!(answer["complete"], false);
            let mut text = answer["text"].as_str().unwrap().to_owned();
            let cursor = answer["next"].clone();
            while !answer["next"].is_null() {
                let view = remote(
                    &mut peer,
                    &client,
                    &document,
                    None,
                    "inspect",
                    json!({"assignmentId":"route-once", "cursor":answer["next"]}),
                )
                .await;
                answer = view["observation"]["state"]["answer"].clone();
                text.push_str(answer["text"].as_str().unwrap());
            }
            assert_eq!(answer["complete"], true);
            assert_eq!(text, "阅读🦀\0\n".repeat(6000));
            let mut foreign = cursor;
            foreign["invocationId"] = json!("another-execution");
            let rejected = remote(
                &mut peer,
                &client,
                &document,
                None,
                "inspect",
                json!({"assignmentId":"route-once", "cursor":foreign}),
            )
            .await;
            assert_eq!(rejected["observation"]["kind"], "unavailable");
            let discovery = success(peer.rpc("plugin.authorization", json!({"client":client,"scope":"profile","command":{"kind":"approve","request":{
                "operationId":uuid::Uuid::new_v4(),"title":"Discover work","target":{"kind":"profile"},"capabilities":["read_sessions"]
            }}})).await)["grant"].clone();
            remote(
                &mut peer,
                &client,
                &document,
                None,
                "authorize",
                json!({"id":discovery["id"]}),
            )
            .await;
            let candidates = remote(
                &mut peer,
                &client,
                &document,
                None,
                "candidates",
                Value::Null,
            )
            .await;
            let candidate = candidates["entries"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["summary"]["session"]["sessionId"] == "workhub-target")
                .unwrap();
            *tool.lock().unwrap() = Some(json!({
                "operation":"route","target":{"kind":"existing","revision":candidates["revision"],"candidate":candidate["reference"]},
                "text":"Execute the user's approved instruction"
            }));
            let answer =
                json!({"operationId":"tool-answer","text":"Route this through the WorkHub tool"});
            remote(
                &mut peer,
                &client,
                &document,
                Some(&coordinator),
                "answer",
                answer.clone(),
            )
            .await;
            loop {
                let observed = remote(
                    &mut peer,
                    &client,
                    &document,
                    Some(&coordinator),
                    "answer-receipt",
                    answer.clone(),
                )
                .await;
                if observed["progress"]["state"] == "ended" {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let history = remote(
                &mut peer,
                &client,
                &document,
                None,
                "assignments",
                json!({}),
            )
            .await;
            let assignments = history["entries"].as_array().unwrap();
            assert_eq!(assignments.len(), 2, "{history}");
            let routed = assignments
                .iter()
                .find(|entry| entry["operationId"] != "route-once")
                .unwrap();
            let assignment = routed["operationId"].as_str().unwrap();
            wait_assignment(&mut peer, &client, &document, assignment).await;
            let resume = json!({"operationId":"resume-tool-route","assignmentId":assignment,"action":{"kind":"resume"}});
            let resumed = remote(
                &mut peer,
                &client,
                &document,
                None,
                "control",
                resume.clone(),
            )
            .await;
            assert_eq!(resumed["kind"], "resumed");
            wait_assignment(&mut peer, &client, &document, assignment).await;
            controls.push(resume);
            let mut replacement = intent.clone();
            replacement["operationId"] = json!("replacement-route");
            let correction = json!({"operationId":"correct-tool-route","assignmentId":assignment,"action":{"kind":"correct","replacement":replacement}});
            let corrected = remote(
                &mut peer,
                &client,
                &document,
                None,
                "control",
                correction.clone(),
            )
            .await;
            assert_eq!(corrected["kind"], "corrected");
            wait_assignment(&mut peer, &client, &document, "replacement-route").await;
            controls.push(correction);
            // Two assignments can share one Run. Retracting one pending input or
            // stopping consumed shared input must not stop the other owner's work.
            let (send, receive) = tokio::sync::oneshot::channel();
            *hold.lock().unwrap() = Some(send);
            let mut owner = intent.clone();
            owner["operationId"] = json!("shared-owner");
            remote(
                &mut peer,
                &client,
                &document,
                Some(&coordinator),
                "route",
                owner,
            )
            .await;
            let active = receive.await.unwrap();
            for id in ["pending-input", "shared-input"] {
                let mut input = intent.clone();
                input["operationId"] = json!(id);
                let queued = remote(
                    &mut peer,
                    &client,
                    &document,
                    Some(&coordinator),
                    "route",
                    input,
                )
                .await;
                assert_eq!(queued["kind"], "queued");
            }
            let cancelled = remote(&mut peer, &client, &document, None, "control", json!({
                "operationId":"withdraw-pending","assignmentId":"pending-input","action":{"kind":"stop"}
            })).await;
            assert_eq!(cancelled["disposition"], "cancelled");
            assert!(
                !active.reply.is_closed(),
                "withdrawing input stopped its shared Run"
            );
            success(peer.rpc("plugin.composition.apply", json!({"operations":[{"type":"update","entryId":"public-workhub","patch":{"disabled":true}}]})).await);
            super::javascript_plugins::ready(&mut peer).await;
            let (send, receive) = tokio::sync::oneshot::channel();
            *hold.lock().unwrap() = Some(send);
            active
                .reply
                .send(json!({"index":0,"delta":{"content":"first step"},"finish_reason":"stop"}))
                .unwrap();
            // Already accepted Host work continues after its submitting plugin retires.
            let continued = receive.await.unwrap();
            success(peer.rpc("plugin.composition.apply", json!({"operations":[{"type":"update","entryId":"public-workhub","patch":{"disabled":false}}]})).await);
            super::javascript_plugins::ready(&mut peer).await;
            let shared = remote(&mut peer, &client, &document, None, "control", json!({
                "operationId":"stop-shared","assignmentId":"shared-input","action":{"kind":"stop"}
            })).await;
            assert_eq!(shared["disposition"], "shared");
            assert!(
                !continued.reply.is_closed(),
                "plugin cancelled a Run it did not exclusively own"
            );
            continued.reply.send(json!({"index":0,"delta":{"content":"shared work completed"},"finish_reason":"stop"})).unwrap();
            wait_assignment(&mut peer, &client, &document, "shared-owner").await;
            success(peer.rpc("session.create", json!({
                "sessionId":"alternative-target", "workspace":{"kind":"host_path","path":fixture.workspace},
                "modelTarget":{"kind":"explicit","connectionId":model.connection_id,"connectionSlug":model.connection_slug,"model":model.model}
            })).await);
            let candidates = remote(
                &mut peer,
                &client,
                &document,
                None,
                "candidates",
                Value::Null,
            )
            .await;
            let entries = candidates["entries"].as_array().unwrap();
            let choice = entries
                .iter()
                .find(|entry| entry["summary"]["session"]["sessionId"] == "workhub-target")
                .unwrap()["reference"]
                .clone();
            *tool.lock().unwrap() = Some(json!({
                "operation":"select","revision":candidates["revision"],
                "candidates":entries.iter().map(|entry| entry["reference"].clone()).collect::<Vec<_>>(),
                "text":"Continue the chosen work"
            }));
            let answer =
                json!({"operationId":"selection-answer","text":"Let me select existing work"});
            remote(
                &mut peer,
                &client,
                &document,
                Some(&coordinator),
                "answer",
                answer.clone(),
            )
            .await;
            use sqlx::Connection;
            let mut database = sqlx::SqliteConnection::connect_with(
                &sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(&database_path)
                    .read_only(true),
            )
            .await
            .unwrap();
            let interaction: String = loop {
                let id = sqlx::query_scalar("SELECT request_id FROM interaction_requests WHERE session_id = ? AND request_id NOT IN (SELECT request_id FROM interaction_outcomes)")
                    .bind(&coordinator).fetch_optional(&mut database).await.unwrap();
                if let Some(id) = id {
                    break id;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            };
            database.close().await.unwrap();
            let query = json!({"sessionId":coordinator,"interactionId":interaction});
            let frozen = success(peer.rpc("interaction.query", query.clone()).await);
            // A new catalog and changed compact references cannot reinterpret an
            // already displayed choice.
            success(peer.rpc("session.create", json!({
                "sessionId":"later-target", "workspace":{"kind":"host_path","path":fixture.workspace},
                "modelTarget":{"kind":"explicit","connectionId":model.connection_id,"connectionSlug":model.connection_slug,"model":model.model}
            })).await);
            let changed = remote(
                &mut peer,
                &client,
                &document,
                None,
                "candidates",
                Value::Null,
            )
            .await;
            assert_ne!(changed["revision"], candidates["revision"]);
            assert_eq!(success(peer.rpc("interaction.query", query).await), frozen);
            success(
                peer.rpc(
                    "interaction.answer",
                    json!({
                        "sessionId":coordinator,"interactionId":interaction,
                        "answer":{"kind":"form","action":"accept","values":{"target":choice}}
                    }),
                )
                .await,
            );
            loop {
                let observed = remote(
                    &mut peer,
                    &client,
                    &document,
                    Some(&coordinator),
                    "answer-receipt",
                    answer.clone(),
                )
                .await;
                if observed["progress"]["state"] == "ended" {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let history = remote(
                &mut peer,
                &client,
                &document,
                None,
                "assignments",
                json!({}),
            )
            .await;
            let selected = history["entries"]
                .as_array()
                .unwrap()
                .iter()
                .find(|assignment| assignment["source"]["turn_id"] == frozen["turnId"])
                .expect("selection produced no durable assignment");
            assert_eq!(
                selected["delivery"]["receipt"]["invocation"]["session_id"],
                "workhub-target"
            );
            wait_assignment(
                &mut peer,
                &client,
                &document,
                selected["operationId"].as_str().unwrap(),
            )
            .await;
        } else {
            let view = remote(&mut peer, &client, &document, None, "resolve", Value::Null).await;
            assert_eq!(view["sessionId"], coordinator);
        }
        for control in &controls {
            let result = remote(
                &mut peer,
                &client,
                &document,
                None,
                "control",
                control.clone(),
            )
            .await;
            assert!(
                matches!(result["kind"].as_str(), Some("resumed" | "corrected")),
                "{result}"
            );
        }
        let replay = remote(
            &mut peer,
            &client,
            &document,
            Some(&coordinator),
            "route",
            intent.clone(),
        )
        .await;
        assert_eq!(replay, original);
        let stopped = remote(
            &mut peer,
            &client,
            &document,
            None,
            "control",
            json!({
                "operationId":"stop-once", "assignmentId":"route-once", "action":{"kind":"stop"}
            }),
        )
        .await;
        assert_eq!(stopped["kind"], "stopped");
        if !reopened {
            repair_intent = json!({
                "operationId":"repair-root", "source":intent["source"],
                "authorization":{"kind":"plugin_workspace","sandboxMode":"workspace-write"},
                "target":{"kind":"create","request":{
                    "operationId":"repairable-root", "managed":false, "name":"Repairable delegated work",
                    "settings":{
                        "target":{"kind":"model","model":model,"thinkingLevel":"max"},
                        "sandboxMode":"read-only", "approvalPolicy":{"kind":"on-request"},
                        "collaborationMode":"agent", "behavior":"default"
                    }
                }},
                "content":{"text":"Only execute the repaired model"}
            });
            let failed = remote_result(
                &mut peer,
                &client,
                &document,
                Some(&coordinator),
                "route",
                repair_intent.clone(),
            )
            .await;
            assert_eq!(
                failed["ok"], false,
                "unsupported thinking must not admit work"
            );
            let before = remote(
                &mut peer,
                &client,
                &document,
                None,
                "delegation-model",
                json!({"assignmentId":"repair-root"}),
            )
            .await;
            assert_eq!(before["revision"], Value::Null);
            let choice = json!({"assignmentId":"repair-root", "expectedRevision":before["revision"],
                "target":{"kind":"model","model":model,"thinkingLevel":null}});
            restricted_selection(address, &client, "select-delegation-model", choice.clone()).await;
            let repaired_session = remote(
                &mut peer,
                &client,
                &document,
                None,
                "select-delegation-model",
                choice.clone(),
            )
            .await;
            assert_eq!(repaired_session["target"]["thinkingLevel"], Value::Null);
            let stale = remote_result(
                &mut peer,
                &client,
                &document,
                None,
                "select-delegation-model",
                choice,
            )
            .await;
            assert_eq!(
                stale["ok"], false,
                "stale model choices must not overwrite the repair"
            );
            repaired = remote(
                &mut peer,
                &client,
                &document,
                Some(&coordinator),
                "route",
                repair_intent.clone(),
            )
            .await;
            wait_assignment(&mut peer, &client, &document, "repair-root").await;
            returned = wait_result(&mut peer, &client, &document, "repair-root").await;
        } else {
            assert_eq!(
                remote(
                    &mut peer,
                    &client,
                    &document,
                    Some(&coordinator),
                    "route",
                    repair_intent.clone()
                )
                .await,
                repaired
            );
            assert_eq!(
                wait_result(&mut peer, &client, &document, "repair-root").await,
                returned
            );
        }
        peer.close().await;
        stop.cancel();
        server.await.unwrap().unwrap();
        cleanup.disarm();
        drop(host);
        if !reopened {
            // Crash cut: Host accepted the notification, but the plugin did
            // not record its receipt. Restore only the pre-receipt outbox;
            // leave Host facts intact, then reopen through normal activation.
            use sqlx::Connection;
            let mut db = sqlx::SqliteConnection::connect_with(
                &sqlx::sqlite::SqliteConnectOptions::new().filename(&database_path),
            )
            .await
            .unwrap();
            let (scope, key): (String, String) = sqlx::query_as(
                "SELECT scope_id,key FROM plugin_data WHERE package_id='z.workhub'
                 AND key LIKE 'assignments/%' AND json_extract(value_json,'$.request.operationId')='repair-root'",
            ).fetch_one(&mut db).await.unwrap();
            sqlx::query("UPDATE plugin_data SET value_json=json_set(value_json,'$.result.receipt',json('null'))
                WHERE package_id='z.workhub' AND scope_id=? AND key=?")
                .bind(&scope).bind(key).execute(&mut db).await.unwrap();
            let raw: String = sqlx::query_scalar("SELECT value_json FROM plugin_data WHERE package_id='z.workhub' AND scope_id=? AND key='pending'")
                .bind(&scope).fetch_one(&mut db).await.unwrap();
            let mut pending: Vec<Value> = serde_json::from_str(&raw).unwrap();
            let recovery = json!({"kind":"route","operationId":"repair-root"});
            assert!(!pending.contains(&recovery));
            pending.push(recovery);
            sqlx::query("UPDATE plugin_data SET value_json=? WHERE package_id='z.workhub' AND scope_id=? AND key='pending'")
                .bind(serde_json::to_string(&pending).unwrap()).bind(scope).execute(&mut db).await.unwrap();
            db.close().await.unwrap();
        }
    }
    // Original, shared/selected and repaired work; no replayed admission after restart.
    let all_requests = provider.requests.lock().unwrap();
    let notifications: Vec<_> = all_requests
        .iter()
        .filter_map(result_notification)
        .collect();
    assert!(
        !notifications.is_empty(),
        "delegated work never returned to its coordinator"
    );
    let mut unique = std::collections::HashSet::new();
    for notification in &notifications {
        assert!(
            unique.insert(notification.to_string()),
            "notification was delivered twice across recovery"
        );
    }
    let requests: Vec<_> = all_requests
        .iter()
        .filter(|request| result_notification(request).is_none())
        .collect();
    assert_eq!(requests.len(), 13);
    let advertised = |request: &Value| {
        request["tools"].as_array().is_some_and(|tools| {
            tools
                .iter()
                .any(|tool| tool["function"]["name"] == "workhub_tasks")
        })
    };
    assert!(advertised(requests[0]));
    assert!(
        !advertised(requests[1]),
        "WorkHub tools leaked into an ordinary Session"
    );
    replies.abort();
}
fn result_notification(request: &Value) -> Option<&Value> {
    request["messages"]
        .as_array()?
        .iter()
        .rev()
        .find(|message| message["role"] == "user")
        .map(|message| &message["content"])
        .filter(|content| {
            content
                .to_string()
                .contains("WorkHub notification: delegated work")
        })
}

async fn wait_result(peer: &mut Peer, client: &Value, document: &Value, id: &str) -> Value {
    loop {
        let view = remote(
            peer,
            client,
            document,
            None,
            "inspect",
            json!({"assignmentId":id}),
        )
        .await;
        if !view["result"]["receipt"].is_null() {
            return view["result"].clone();
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
fn setup() -> Setup {
    let id = "z.workhub";
    Setup {
        builtins: [(id.into(), Arc::new(Definition {
            id:id.into(), revision:"binary".into(), dependencies:vec![], inject:vec![],
            plugin: Arc::new(maka_workhub::Builtin {
                bundle: Bundle::builtin(id, "binary", "export default function() {}").unwrap(),
            }),
        }))].into(),
        layers:[(id.into(), vec![
            serde_json::from_value(json!({"type":"insert","rootId":"profile","entry":{"id":"public-workhub","packageId":id}})).unwrap(),
            serde_json::from_value(json!({"type":"insert","rootId":"desktop-ui","entry":{"id":"public-workhub-ui","packageId":id}})).unwrap(),
            serde_json::from_value(json!({"type":"update","entryId":"maka.workhub","patch":{"disabled":true}})).unwrap(),
        ])].into(),
        ..Default::default()
    }
}
async fn approve(peer: &mut Peer, client: &Value, target: Value) -> Value {
    success(peer.rpc("plugin.authorization", json!({"client":client,"scope":"profile","command":{"kind":"approve","request":{
        "operationId":uuid::Uuid::new_v4(), "title":"Approve WorkHub work", "target":target, "capabilities":["executions"]
    }}})).await)["grant"].clone()
}
async fn remote(
    peer: &mut Peer,
    client: &Value,
    document: &Value,
    session: Option<&str>,
    method: &str,
    input: Value,
) -> Value {
    loop {
        let reply = remote_result(peer, client, document, session, method, input.clone()).await;
        // Background notifications are real coordinator Turns. A concurrent
        // user submission retries the same operation, never invents another ID.
        if method == "answer"
            && reply["error"]["message"] == "remote provider failed: Session is busy"
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
            continue;
        }
        assert_eq!(reply["ok"], true, "{method} {input}: {reply}");
        return reply["result"]["value"].clone();
    }
}
async fn remote_result(
    peer: &mut Peer,
    client: &Value,
    document: &Value,
    session: Option<&str>,
    method: &str,
    input: Value,
) -> Value {
    let binding = json!({"client":client,"method":method,"sessionId":session});
    let target = success(
        peer.rpc("plugin.remote", json!({"kind":"bind","binding":binding}))
            .await,
    )["target"]
        .clone();
    peer.rpc(
        "plugin.remote",
        json!({"kind":"call","binding":binding,"target":target,"document":document,"input":input}),
    )
    .await
}
fn success(value: Value) -> Value {
    assert_eq!(value["ok"], true, "{value}");
    value["result"].clone()
}

async fn upload(peer: &mut Peer, session: &str) -> Value {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let bytes = b"delegation evidence";
    success(
        peer.rpc(
            "artifact.ingest",
            json!({
                "kind":"begin","sessionId":session,"uploadId":"original-attachment",
                "name":"evidence.txt","mimeType":"text/plain","totalBytes":bytes.len(),
                "contentSha256":maka_runtime::artifact::content_digest(bytes)
            }),
        )
        .await,
    );
    success(peer.rpc("artifact.ingest", json!({
        "kind":"chunk","sessionId":session,"uploadId":"original-attachment","offset":0,"chunkBase64":STANDARD.encode(bytes)
    })).await);
    success(
        peer.rpc(
            "artifact.ingest",
            json!({"kind":"commit","sessionId":session,"uploadId":"original-attachment"}),
        )
        .await,
    )["attachment"]
        .clone()
}

async fn restricted_selection(
    address: std::net::SocketAddr,
    client: &Value,
    method: &str,
    selection: Value,
) {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
    let mut request = format!("ws://{address}/runtime-host")
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "Authorization",
        "Bearer synthetic-workhub-viewer".parse().unwrap(),
    );
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    socket
        .send(Message::text(
            json!({"kind":"hello", "clientInstanceId":"workhub-viewer",
        "protocolMin":0,"protocolMax":0,"compatibilityEpoch":maka_protocol::COMPATIBILITY_EPOCH,
        "compositionId":"maka.interactive"})
            .to_string(),
        ))
        .await
        .unwrap();
    let hello: Value =
        serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(hello["state"], "ready");
    let mut document = Value::Null;
    let mut target = Value::Null;
    let binding = json!({"client":client,"method":method,"sessionId":null});
    for step in ["document", "bind", "call"] {
        let input = match step {
            "document" => json!({"kind":"open_document"}),
            "bind" => json!({"kind":"bind","binding":binding}),
            _ => json!({"kind":"call","binding":binding,"document":document,"target":target,
                "input":selection}),
        };
        socket
            .send(Message::text(
                json!({"requestId":step,"operation":"plugin.remote","input":input}).to_string(),
            ))
            .await
            .unwrap();
        let response = loop {
            let frame: Value =
                serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            if frame["requestId"] == step {
                break frame;
            }
        };
        match step {
            "document" => document = success(response)["document"].clone(),
            "bind" => target = success(response)["target"].clone(),
            _ => {
                assert_eq!(
                    response["ok"], false,
                    "a Remote-only principal borrowed another owner's consent"
                );
                assert!(
                    response["error"]["message"]
                        .as_str()
                        .unwrap()
                        .contains("plugin execution authority is retired or revoked"),
                    "{response}"
                );
            }
        }
    }
    socket.close(None).await.unwrap();
}

async fn wait_assignment(peer: &mut Peer, client: &Value, document: &Value, id: &str) {
    loop {
        let view = remote(
            peer,
            client,
            document,
            None,
            "inspect",
            json!({"assignmentId":id}),
        )
        .await;
        if view["observation"]["state"]["progress"]["state"] == "ended" {
            assert_eq!(
                view["observation"]["state"]["progress"]["outcome"]["kind"], "completed",
                "{view}"
            );
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
