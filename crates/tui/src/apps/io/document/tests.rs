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
use crate::apps::{
    self, Command, Intent, Message, Output,
    io::{self, Watches},
    tests::*,
};
use io::transcript::test_peer::Peer;
use maka_plugins::terminal_ui::view::Reply;
use maka_protocol::plugin::RemoteResult;

fn read_request(app: &mut crate::app::App) -> apps::Request {
    app.apps_action(command(Command::Refresh));
    next(app).unwrap()
}

#[tokio::test]
async fn document_allocated_after_navigation_is_still_closed() {
    let (client, mut peer) = Peer::connect().await;
    let request = read_request(&mut app());
    let (mut runtime, _changes) = Watches::new();
    let _document = runtime.document(&client, &request).unwrap();
    let allocating = peer.read().await;
    assert_eq!(allocating["input"]["kind"], "open_document");
    runtime.stop();
    let document = Uuid::new_v4();
    peer.reply(&allocating, RemoteResult::Document { document })
        .await;
    let close = peer.read().await;
    assert_eq!(close["input"]["kind"], "close_document");
    assert_eq!(close["input"]["document"], document.to_string());
    let mut shutdown = Box::pin(runtime.shutdown());
    assert!(futures_util::poll!(&mut shutdown).is_pending());
    peer.reply(&close, RemoteResult::Closed).await;
    shutdown.await.unwrap();
    client.disconnect();
}

#[tokio::test]
async fn repeated_calls_share_document_and_observations_wait_for_initial_reply() {
    let (client, mut peer) = Peer::connect().await;
    let mut app = app();
    let first = read_request(&mut app);
    let (mut runtime, _changes) = Watches::new();
    let document = runtime.document(&client, &first).unwrap();
    let call_client = client.clone();
    let sent = first.clone();
    let first_call =
        tokio::spawn(async move { io::execute(&call_client, &sent, Some(document)).await });
    let allocating = peer.read().await;
    assert_eq!(allocating["input"]["kind"], "open_document");
    let document = Uuid::new_v4();
    peer.reply(&allocating, RemoteResult::Document { document })
        .await;
    let call = peer.read().await;
    assert_eq!(call["input"]["kind"], "call");
    assert_eq!(call["input"]["document"], document.to_string());
    assert!(runtime.document(&client, &first).unwrap().ready().is_none());
    peer.reply(
        &call,
        RemoteResult::Value {
            value: serde_json::to_value(Reply::View { view: form() }).unwrap(),
        },
    )
    .await;
    app.apps_complete(first.clone(), first_call.await.unwrap());
    assert_eq!(
        runtime.document(&client, &first).unwrap().ready(),
        Some(document)
    );
    let second = read_request(&mut app);
    assert_ne!(first.generation, second.generation);
    assert_eq!(first.execution, second.execution);
    let lease = runtime.document(&client, &second).unwrap();
    let call_client = client.clone();
    let sent = second.clone();
    let second_call =
        tokio::spawn(async move { io::execute(&call_client, &sent, Some(lease)).await });
    let call = peer.read().await;
    assert_eq!(call["input"]["kind"], "call");
    assert_eq!(call["input"]["document"], document.to_string());
    peer.reply(
        &call,
        RemoteResult::Value {
            value: serde_json::to_value(Reply::View { view: form() }).unwrap(),
        },
    )
    .await;
    assert!(second_call.await.unwrap().is_ok());
    runtime.stop();
    let close = peer.read().await;
    assert_eq!(close["input"]["kind"], "close_document");
    peer.reply(&close, RemoteResult::Closed).await;
    runtime.shutdown().await.unwrap();
    client.disconnect();
}

#[test]
fn background_write_pins_execution_until_receipt_but_drafts_do_not() {
    let mut app = app();
    let initial = instance(&app).execution;
    app.apps_action(command(Command::View(Intent::Toggle("enabled".into()))));
    app.apps_action(command(Command::View(Intent::Submit("save".into()))));
    let write = next(&mut app).unwrap();
    assert!(write.needs_checkpoint());
    app.apply(crate::app::Action::Visit(
        crate::navigation::Route::Workspace,
    ));
    assert!(app.apps_executions().contains(&initial));
    assert!(app.apps_watches().is_empty());
    app.apps_complete(
        write,
        Ok(Output::Reply(Reply::Applied {
            route: serde_json::Value::Null,
        })),
    );
    assert!(!app.apps_executions().contains(&initial));
    assert!(app.apps.instances[&key()].unresolved.is_none());
    assert!(app.apps.instances[&key()].result.is_some());
    app.apps_action(Message::Recover(key()));
    app.apps_executions();
    assert_ne!(instance(&app).execution, initial);
}

mod applied;
mod updated;

mod retained;
