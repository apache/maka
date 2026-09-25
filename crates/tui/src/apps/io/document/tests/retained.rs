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
use crate::apps::io::transcript::{Delivery, Output as SourceOutput};
use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers, MouseEvent, MouseEventKind};
use maka_plugins::terminal_ui::{transcript as wire, view::Node};
use serde_json::{Value, json};

const PATH: &str = "app/body/frame/content/reader-root/history";

fn records(screen: &str) -> Vec<usize> {
    (0..80)
        .filter(|index| screen.contains(&format!("Cached record {index:03}")))
        .collect()
}
fn wheel(app: &mut crate::app::App, token: Uuid) {
    let area = instance(app).surface.transcript_area(token).unwrap();
    assert!(
        app.app_page_input(
            &key(),
            &Event::Mouse(MouseEvent {
                kind: MouseEventKind::ScrollUp,
                column: area.x + 2,
                row: area.y + 2,
                modifiers: KeyModifiers::NONE,
            })
        )
        .is_some()
    );
}

#[tokio::test]
async fn invalid_and_oversized_reads_close_execution_but_keep_last_good_reader_local() {
    for oversized in [false, true] {
        let (client, mut peer) = Peer::connect().await;
        let (mut runtime, _changes) = Watches::new();
        let mut app = app();
        let mut view = form();
        view.root = Node::Column {
            key: "reader-root".into(),
            gap: 1,
            children: vec![
                view.root,
                Node::Transcript {
                    key: "history".into(),
                    resource: wire::Resource {
                        id: "history".into(),
                        read: "history.read".into(),
                        stream: "history.stream".into(),
                        route: Value::Null,
                    },
                },
            ],
        };
        view.validate().unwrap();
        instance_mut(&mut app).read("en");
        let initial = next(&mut app).unwrap();
        let lease = runtime.document(&client, &initial).unwrap();
        let task_client = client.clone();
        let sent = initial.clone();
        let loading =
            tokio::spawn(async move { io::execute(&task_client, &sent, Some(lease)).await });
        let opening = peer.read().await;
        assert_eq!(opening["input"]["kind"], "open_document");
        let document = Uuid::new_v4();
        peer.reply(&opening, RemoteResult::Document { document })
            .await;
        let call = peer.read().await;
        assert_eq!(call["input"]["input"]["kind"], "read");
        peer.reply(
            &call,
            RemoteResult::Value {
                value: serde_json::to_value(Reply::View { view: view.clone() }).unwrap(),
            },
        )
        .await;
        app.apps_complete(initial, loading.await.unwrap());
        let token = app.apps_transcript_mounts()[0].token;
        let text = (0..80)
            .map(|index| format!("Cached record {index:03} — 中文 🚀"))
            .collect::<Vec<_>>()
            .join("  \n");
        assert!(app.apps_transcript_delivery(Delivery {
            token,
            output: SourceOutput::Ready { fence: 1 }
        }));
        let page: wire::Page =
            serde_json::from_value(json!({"fence":1,"records":[{"kind":"block","block":{
                "key":{"turn":"retained","message":"history","part":"text"},"revision":"1",
                "kind":"assistant","content":{"text":text}
            }}]}))
            .unwrap();
        page.validate().unwrap();
        assert!(app.apps_transcript_delivery(Delivery {
            token,
            output: SourceOutput::Page {
                direction: wire::Direction::Tail,
                page
            }
        }));
        let _ = draw(&mut app, 110, 35);
        wheel(&mut app, token);
        let before = draw(&mut app, 110, 35);
        assert!(records(&before).len() > 4);
        // A normal background read retains the current source until it settles.
        instance_mut(&mut app).read("en");
        let request = next(&mut app).unwrap();
        let lease = runtime.document(&client, &request).unwrap();
        let task_client = client.clone();
        let sent = request.clone();
        let failing =
            tokio::spawn(async move { io::execute(&task_client, &sent, Some(lease)).await });
        let call = peer.read().await;
        assert_eq!(call["input"]["document"], document.to_string());
        if oversized {
            peer.reject(
                &call,
                maka_protocol::OperationError {
                    code: maka_protocol::OperationErrorCode::OperationUnavailable,
                    message: "Presenter response exceeds the payload limit".into(),
                },
            )
            .await;
        } else {
            let mut invalid = serde_json::to_value(Reply::View { view }).unwrap();
            invalid["view"]["root"] = json!({"kind":"not_a_node","key":"bad"});
            peer.reply(&call, RemoteResult::Value { value: invalid })
                .await;
        }
        let result = failing.await.unwrap();
        assert!(result.is_err());
        app.apps_complete(request, result);
        assert!(instance(&app).live.is_none());
        assert!(!app.apps_enabled(&save()));
        runtime.reconcile_documents(app.apps_executions());
        assert!(
            app.apps_transcript_mounts().is_empty(),
            "cached reader has no transport authority"
        );
        let close = peer.read().await;
        assert_eq!(close["input"]["kind"], "close_document");
        assert_eq!(close["input"]["document"], document.to_string());
        peer.reply(&close, RemoteResult::Closed).await;
        runtime.shutdown().await.unwrap();
        let retained = draw(&mut app, 110, 35);
        let before_scroll = records(&retained);
        assert!(before_scroll.len() > 4, "{retained}");
        wheel(&mut app, token);
        let after = draw(&mut app, 110, 35);
        assert_eq!(records(&after)[0], before_scroll[0] - 3, "{after}");
        instance_mut(&mut app).surface.focus(PATH.into());
        assert!(
            app.app_page_input(
                &key(),
                &Event::Key(KeyEvent::new(
                    KeyCode::Char('c'),
                    KeyModifiers::CONTROL | KeyModifiers::SHIFT
                ))
            )
            .is_some()
        );
        assert_eq!(app.apps_transcript_copy(), Some(text));
        // Neither late data nor local resource-refresh keys may restart a dead page.
        assert!(!app.apps_transcript_delivery(Delivery {
            token,
            output: SourceOutput::Event(wire::Event::Remove {
                base: 1,
                revision: 2,
                key: wire::Key {
                    turn: "retained".into(),
                    message: "history".into(),
                    part: wire::Part::Text
                },
            })
        }));
        app.app_page_input(
            &key(),
            &Event::Key(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::CONTROL)),
        );
        assert!(app.apps_transcript_mounts().is_empty());
        assert_eq!(records(&draw(&mut app, 110, 35)), records(&after));
        assert!(next(&mut app).is_none());
        client.disconnect();
    }
}
