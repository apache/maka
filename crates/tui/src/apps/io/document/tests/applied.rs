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
use crate::apps::Work;
use maka_plugins::terminal_ui::view::Request as Input;
use maka_protocol::plugin::{RemoteBinding, RemoteKind, RemoteRequest};
use serde_json::json;

#[tokio::test]
async fn applied_replaces_execution_only_after_old_document_close_is_confirmed() {
    for confirmed in [true, false] {
        let (client, mut peer) = Peer::connect().await;
        let mut app = app();
        app.apps_action(command(Command::View(Intent::Submit("save".into()))));
        let submit = next(&mut app).unwrap();
        let (mut runtime, _changes) = Watches::new();
        let original = runtime.document(&client, &submit).unwrap();
        let task_client = client.clone();
        let sent = submit.clone();
        let submitted =
            tokio::spawn(async move { io::execute(&task_client, &sent, Some(original)).await });
        let allocating = peer.read().await;
        assert_eq!(allocating["input"]["kind"], "open_document");
        let old = Uuid::new_v4();
        peer.reply(&allocating, RemoteResult::Document { document: old })
            .await;
        let call = peer.read().await;
        assert_eq!(call["input"]["input"]["kind"], "submit");
        peer.reply(
            &call,
            RemoteResult::Value {
                value: json!({"kind":"applied", "route":null}),
            },
        )
        .await;
        let execution = submit.execution;
        app.apps_observation_failed(execution);
        assert!(instance(&app).live.is_none());
        app.apps_complete(submit, submitted.await.unwrap());
        assert!(instance(&app).unresolved.is_none());
        assert_eq!(instance(&app).applied.as_deref(), Some("save"));
        let read = next(&mut app).unwrap();
        assert_ne!(read.execution, execution);
        assert!(
            matches!(&read.work, Work::Call { input: Input::Read { route, .. }, .. } if route.is_null())
        );
        assert!(!read.needs_checkpoint());
        runtime.reconcile_documents(app.apps_executions());
        let lease = runtime.document(&client, &read).unwrap();
        let task_client = client.clone();
        let sent = read.clone();
        let reading =
            tokio::spawn(async move { io::execute(&task_client, &sent, Some(lease)).await });
        let close = peer.read().await;
        assert_eq!(close["input"]["kind"], "close_document");
        assert_eq!(close["input"]["document"], old.to_string());
        // An unrelated exchange proves the transport is running while the old
        // close is held. A new allocation would consume an unfreed capacity slot.
        let task_client = client.clone();
        let probe = tokio::spawn(async move {
            task_client
                .plugin_remote(RemoteRequest::Bind {
                    binding: RemoteBinding::Package {
                        package_id: "other".into(),
                        method: "ping".into(),
                        session_id: None,
                    },
                })
                .await
        });
        let binding = peer.read().await;
        assert_eq!(
            binding["input"]["kind"], "bind",
            "no new document before close confirmation"
        );
        peer.reply(
            &binding,
            RemoteResult::Bound {
                target: instance(&app).entry.as_ref().unwrap().target.clone(),
                handler: RemoteKind::Method,
            },
        )
        .await;
        assert!(probe.await.unwrap().is_ok());
        assert!(!reading.is_finished());
        // Late observation failures belong to the settled old form only.
        app.apps_observation_failed(execution);
        assert!(instance(&app).live.is_some());
        if confirmed {
            peer.reply(&close, RemoteResult::Closed).await;
        } else {
            // Match Host CleanupUnconfirmed, not an invalid success variant
            // that deliberately disconnects the protocol client.
            peer.reject(
                &close,
                maka_protocol::OperationError {
                    code: maka_protocol::OperationErrorCode::OperationUnavailable,
                    message: "Remote cleanup is unconfirmed".into(),
                },
            )
            .await;
        }
        if confirmed {
            let opening = peer.read().await;
            assert_eq!(opening["input"]["kind"], "open_document");
            let fresh = Uuid::new_v4();
            peer.reply(&opening, RemoteResult::Document { document: fresh })
                .await;
            let call = peer.read().await;
            assert_eq!(call["input"]["kind"], "call");
            assert_eq!(call["input"]["document"], fresh.to_string());
            assert_eq!(call["input"]["input"]["kind"], "read");
            peer.reply(
                &call,
                RemoteResult::Value {
                    value: serde_json::to_value(Reply::View { view: form() }).unwrap(),
                },
            )
            .await;
            app.apps_complete(read, reading.await.unwrap());
            assert!(instance(&app).view.is_some());
            assert!(instance(&app).result.is_none());
            runtime.stop();
            let close = peer.read().await;
            assert_eq!(close["input"]["document"], fresh.to_string());
            peer.reply(&close, RemoteResult::Closed).await;
            runtime.shutdown().await.unwrap();
        } else {
            let result = tokio::select! {
                result = reading => result.unwrap(),
                unexpected = peer.read() => panic!("unconfirmed close must not allocate: {unexpected}"),
            };
            assert!(matches!(result, Err(io::Failure { unknown: false })));
            let mut disconnected = Box::pin(client.closed());
            assert!(futures_util::poll!(&mut disconnected).is_pending());
            let mut another = read.clone();
            app.apps_complete(read, result);
            assert!(instance(&app).unresolved.is_none());
            assert_eq!(instance(&app).applied.as_deref(), Some("save"));
            assert!(
                instance(&app).result.is_some(),
                "known result remains checkpointable"
            );
            let saved = app.apps.checkpoints("root").pop().unwrap();
            saved.validate("root").unwrap();
            let saved = serde_json::to_value(saved).unwrap();
            assert!(saved["pending"].is_null());
            assert!(!saved["result"].is_null());
            // A fresh explicit execution is still fenced by the unconfirmed old owner.
            another.execution = Uuid::new_v4();
            runtime.reconcile_documents(app.apps_executions());
            let lease = runtime.document(&client, &another).unwrap();
            tokio::select! {
                result = lease.id() => assert!(result.is_err()),
                unexpected = peer.read() => panic!("cleanup failure was forgotten: {unexpected}"),
            }
            assert!(runtime.shutdown().await.is_err());
        }
        client.disconnect();
    }
}

#[test]
fn non_applied_write_receipts_keep_observation_revocation_and_never_replay() {
    use maka_plugins::authorization::{Capability, Request as Proposal, Target};
    let proposal = Proposal {
        operation_id: Uuid::new_v4(),
        title: "Original consent".into(),
        target: Target::Profile,
        capabilities: [Capability::Notifications].into(),
    };
    for reply in [
        Reply::Rejected {
            message: "Original refusal".into(),
        },
        Reply::Consent {
            request: proposal.clone(),
        },
    ] {
        let consent = matches!(&reply, Reply::Consent { .. });
        let mut app = app();
        app.apps_action(command(Command::View(Intent::Submit("save".into()))));
        let write = next(&mut app).unwrap();
        let owner = write.execution;
        app.apps_observation_failed(owner);
        assert!(instance(&app).live.is_none());
        assert!(
            app.apps_executions().contains(&owner),
            "write remains pinned"
        );
        app.apps_complete(write, Ok(Output::Reply(reply)));
        assert_eq!(instance(&app).execution, owner);
        assert!(instance(&app).live.is_none());
        assert!(instance(&app).unresolved.is_none());
        assert!(next(&mut app).is_none(), "no automatic Read or Submit");
        if consent {
            let (_, original) = app.apps.consent.as_ref().unwrap();
            assert_eq!(original.proposal.operation_id, proposal.operation_id);
            app.consent_presented(true);
            assert!(!app.apps_enabled(&command(Command::ApproveConsent)));
        } else {
            assert!(matches!(instance(&app).message.as_ref(),
                Some(crate::apps::instance::Notice::Remote(message)) if message == "Original refusal"));
            assert!(!app.apps_enabled(&save()));
        }
        assert!(!app.apps_executions().contains(&owner));
    }
}
