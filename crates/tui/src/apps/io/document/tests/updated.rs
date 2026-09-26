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
use serde_json::json;

#[tokio::test]
async fn updated_submission_keeps_the_exact_remote_document_for_readback() {
    let (client, mut peer) = Peer::connect().await;
    let mut app = app();
    app.apps_action(save());
    let submit = next(&mut app).unwrap();
    assert!(submit.needs_checkpoint());
    assert!(app.apps_after_checkpoint(&submit, &Ok(())));
    assert!(
        !app.apps_after_checkpoint(&submit, &Ok(())),
        "one dispatch after checkpoint"
    );
    let (mut runtime, _changes) = Watches::new();
    let lease = runtime.document(&client, &submit).unwrap();
    let task_client = client.clone();
    let sent = submit.clone();
    let submitting =
        tokio::spawn(async move { io::execute(&task_client, &sent, Some(lease)).await });
    let allocation = peer.read().await;
    assert_eq!(allocation["input"]["kind"], "open_document");
    let document = Uuid::new_v4();
    peer.reply(&allocation, RemoteResult::Document { document })
        .await;
    let call = peer.read().await;
    assert_eq!(call["input"]["document"], document.to_string());
    peer.reply(
        &call,
        RemoteResult::Value {
            value: json!({"kind":"updated"}),
        },
    )
    .await;
    let owner = submit.execution;
    app.apps_complete(submit, submitting.await.unwrap());
    assert!(instance(&app).unresolved.is_none());
    assert!(
        !app.apps_enabled(&save()),
        "old form cannot submit before readback"
    );
    let read = next(&mut app).unwrap();
    assert_eq!(read.execution, owner);
    assert!(!read.needs_checkpoint());
    runtime.reconcile_documents(app.apps_executions());
    let lease = runtime.document(&client, &read).unwrap();
    let task_client = client.clone();
    let sent = read.clone();
    let reading = tokio::spawn(async move { io::execute(&task_client, &sent, Some(lease)).await });
    let call = peer.read().await;
    assert_eq!(
        call["input"]["kind"], "call",
        "no close/open between accepted action and readback"
    );
    assert_eq!(call["input"]["document"], document.to_string());
    peer.reply(
        &call,
        RemoteResult::Value {
            value: serde_json::to_value(Reply::View { view: form() }).unwrap(),
        },
    )
    .await;
    app.apps_complete(read, reading.await.unwrap());
    assert!(!instance(&app).updated);
    assert_eq!(instance(&app).execution, owner);
    assert!(app.apps_enabled(&save()));
    runtime.stop();
    let close = peer.read().await;
    assert_eq!(close["input"]["kind"], "close_document");
    assert_eq!(close["input"]["document"], document.to_string());
    peer.reply(&close, RemoteResult::Closed).await;
    runtime.shutdown().await.unwrap();
    client.disconnect();
}

#[test]
fn updated_settles_receipts_without_reviving_failed_or_replaced_owners() {
    for lost_before_receipt in [false, true] {
        let mut app = app();
        app.apps_action(save());
        let submit = next(&mut app).unwrap();
        let owner = submit.execution;
        if lost_before_receipt {
            app.apps_observation_failed(owner);
        }
        app.apps_complete(submit.clone(), Ok(Output::Reply(Reply::Updated {})));
        assert!(instance(&app).unresolved.is_none());
        assert_eq!(instance(&app).execution, owner);
        if lost_before_receipt {
            assert!(instance(&app).live.is_none());
            assert!(next(&mut app).is_none());
        } else {
            let read = next(&mut app).unwrap();
            app.apps_complete(read, Err(io::Failure { unknown: false }));
            assert!(instance(&app).live.is_none());
        }
        assert!(instance(&app).result.is_some());
        let saved = serde_json::to_value(app.apps.checkpoints("root").pop().unwrap()).unwrap();
        assert!(saved["pending"].is_null());
        assert!(!saved["result"].is_null());
        assert!(!app.apps_enabled(&command(Command::Retry)));
        assert!(!app.apps_executions().contains(&owner));
        assert!(app.apps_enabled(&Message::Result(key())));
        app.apps_action(Message::Result(key()));
        if app.apps_enabled(&command(Command::ResumeDraft)) {
            app.apps_action(command(Command::ResumeDraft));
        }
        let fresh = next(&mut app).unwrap();
        assert_ne!(fresh.execution, owner);
        let current = instance(&app).execution;
        app.apps_complete(submit, Ok(Output::Reply(Reply::Updated {})));
        assert_eq!(
            instance(&app).execution,
            current,
            "late receipt cannot affect a replacement"
        );
        assert!(instance(&app).unresolved.is_none());
    }
}

#[test]
fn updated_readback_preserves_drafts_edited_during_readback() {
    let mut app = app();
    instance_mut(&mut app).view.as_mut().unwrap().actions[0].fields = vec!["enabled".into()];
    app.apps_action(save());
    let submit = next(&mut app).unwrap();
    app.apps_complete(submit, Ok(Output::Reply(Reply::Updated {})));
    let read = next(&mut app).unwrap();
    assert!(app.admit_field(&key(), "name", &json!("Kept draft")));
    instance_mut(&mut app)
        .drafts
        .insert("name".into(), json!("Kept draft"));
    let saved = serde_json::to_value(app.apps.checkpoints("root").pop().unwrap()).unwrap();
    assert!(saved["pending"].is_null());
    assert_eq!(saved["drafts"]["name"], "Kept draft");
    let mut current = form();
    current.revision = "two".into();
    current.actions[0].fields = vec!["enabled".into()];
    app.apps_complete(read, Ok(Output::Reply(Reply::View { view: current })));
    assert_eq!(instance(&app).drafts["name"], "Kept draft");
    assert!(instance(&app).unresolved.is_none());
    assert!(!instance(&app).blocked);
    assert!(!instance(&app).updated);
}

#[tokio::test]
async fn leaving_updated_readback_retires_document_and_ignores_its_late_wire_reply() {
    use crate::{app::Action, apps::Work, navigation::Route};
    use maka_plugins::terminal_ui::view::Request as Input;
    for keep_draft in [false, true] {
        let (client, mut peer) = Peer::connect().await;
        let (mut runtime, _changes) = Watches::new();
        let mut app = app();
        app.apps_action(save());
        let submit = next(&mut app).unwrap();
        let owner = submit.execution;
        let lease = runtime.document(&client, &submit).unwrap();
        let task_client = client.clone();
        let sent = submit.clone();
        let writing =
            tokio::spawn(async move { io::execute(&task_client, &sent, Some(lease)).await });
        let allocation = peer.read().await;
        let old_document = Uuid::new_v4();
        peer.reply(
            &allocation,
            RemoteResult::Document {
                document: old_document,
            },
        )
        .await;
        let call = peer.read().await;
        peer.reply(
            &call,
            RemoteResult::Value {
                value: json!({"kind":"updated"}),
            },
        )
        .await;
        app.apps_complete(submit, writing.await.unwrap());
        let old_read = next(&mut app).unwrap();
        let lease = runtime.document(&client, &old_read).unwrap();
        let task_client = client.clone();
        let sent = old_read.clone();
        let late_read =
            tokio::spawn(async move { io::execute(&task_client, &sent, Some(lease)).await });
        let held_read = peer.read().await;
        assert_eq!(held_read["input"]["document"], old_document.to_string());
        if keep_draft {
            assert!(app.admit_field(&key(), "name", &json!("Kept after leaving")));
            instance_mut(&mut app)
                .drafts
                .insert("name".into(), json!("Kept after leaving"));
        }
        app.apply(Action::Visit(Route::Workspace));
        let owners = app.apps_executions();
        assert!(
            !owners.contains(&owner),
            "leaving must not pin the authentication owner"
        );
        runtime.reconcile_documents(owners);
        assert!(next(&mut app).is_none());
        let retired = &app.apps.instances[&key()];
        assert!(!retired.busy && !retired.reading);
        assert!(retired.execution.is_nil());
        assert!(retired.updated && retired.unresolved.is_none());
        assert_eq!(retired.result.is_some(), !keep_draft);
        let close = peer.read().await;
        assert_eq!(close["input"]["kind"], "close_document");
        assert_eq!(close["input"]["document"], old_document.to_string());
        peer.reply(&close, RemoteResult::Closed).await;
        app.apps_action(Message::Open(key()));
        runtime.reconcile_documents(app.apps_executions());
        let fresh = next(&mut app).expect("re-entry dispatches a read without replaying Submit");
        assert_ne!(fresh.execution, owner);
        assert!(!fresh.needs_checkpoint());
        assert!(matches!(
            &fresh.work,
            Work::Call {
                input: Input::Read { .. },
                ..
            }
        ));
        let lease = runtime.document(&client, &fresh).unwrap();
        let task_client = client.clone();
        let sent = fresh.clone();
        let reading =
            tokio::spawn(async move { io::execute(&task_client, &sent, Some(lease)).await });
        let allocation = peer.read().await;
        assert_eq!(allocation["input"]["kind"], "open_document");
        let new_document = Uuid::new_v4();
        peer.reply(
            &allocation,
            RemoteResult::Document {
                document: new_document,
            },
        )
        .await;
        let call = peer.read().await;
        assert_eq!(call["input"]["kind"], "call");
        assert_eq!(call["input"]["input"]["kind"], "read");
        assert_eq!(call["input"]["document"], new_document.to_string());
        let mut stale = form();
        stale.title = "Retired owner must not install".into();
        peer.reply(
            &held_read,
            RemoteResult::Value {
                value: serde_json::to_value(Reply::View { view: stale }).unwrap(),
            },
        )
        .await;
        app.apps_complete(old_read, late_read.await.unwrap());
        assert_eq!(
            app.apps.instances[&key()].view.as_ref().unwrap().title,
            "Notebook"
        );
        assert!(
            instance(&app).busy,
            "old response cannot clear the fresh read"
        );
        let mut current = form();
        current.revision = "two".into();
        peer.reply(
            &call,
            RemoteResult::Value {
                value: serde_json::to_value(Reply::View { view: current }).unwrap(),
            },
        )
        .await;
        app.apps_complete(fresh, reading.await.unwrap());
        assert!(!instance(&app).updated && !instance(&app).busy);
        assert!(instance(&app).unresolved.is_none());
        assert_eq!(
            instance(&app).drafts["name"],
            if keep_draft {
                "Kept after leaving"
            } else {
                "My notes"
            }
        );
        runtime.stop();
        let close = peer.read().await;
        assert_eq!(close["input"]["document"], new_document.to_string());
        peer.reply(&close, RemoteResult::Closed).await;
        runtime.shutdown().await.unwrap();
        client.disconnect();
    }
}
