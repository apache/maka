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
use crate::{
    app::{Action, ConnectionState},
    apps::{Command, Message, Output, tests::next},
    navigation::Route,
};
use maka_plugins::terminal_ui::view::Reply;

fn stopped() -> (App, Uuid) {
    let mut app = readers();
    let mount = app.apps_transcript_mounts()[0].clone();
    page(&mut app, mount.token, "Retained reader snapshot");
    assert!(draw(&mut app, 100, 35).contains("Retained reader snapshot"));
    app.apps_observation_failed(mount.owner);
    app.apps_executions();
    assert!(app.apps_transcript_mounts().is_empty());
    assert!(draw(&mut app, 100, 35).contains("Retained reader snapshot"));
    (app, mount.token)
}
fn late(app: &mut App, token: Uuid) -> bool {
    app.apps_transcript_delivery(transport::Delivery {
        token,
        output: transport::Output::Event(wire::Event::Remove {
            base: 1,
            revision: 2,
            key: wire::Key {
                turn: "shared-turn".into(),
                message: "same-entry".into(),
                part: wire::Part::Text,
            },
        }),
    })
}

#[test]
fn retained_reader_keeps_scope_fences_and_disconnect_erases_it_before_another_reconcile() {
    for change in [
        "disconnect",
        "root",
        "epoch",
        "hidden",
        "route",
        "target",
        "resource",
        "node",
    ] {
        let (mut app, token) = stopped();
        match change {
            "disconnect" => {
                app.apps.disconnect();
                assert!(
                    app.apps.readers.mounts.is_empty(),
                    "no disconnected snapshot exposure"
                );
            }
            "root" | "epoch" => {
                let ConnectionState::Connected { root_id, epoch } = &mut app.connection else {
                    unreachable!()
                };
                if change == "root" {
                    *root_id = "another-root".into();
                } else {
                    *epoch = "another-epoch".into();
                }
            }
            "hidden" => {
                app.apply(Action::Visit(Route::Workspace));
            }
            "route" => {
                app.apps_action(Message::Open(key().at(serde_json::json!({"other":true}))));
            }
            "target" => {
                instance_mut(&mut app)
                    .entry
                    .as_mut()
                    .unwrap()
                    .target
                    .registration = Uuid::new_v4();
            }
            "resource" | "node" => {
                let Node::Column { children, .. } =
                    &mut instance_mut(&mut app).view.as_mut().unwrap().root
                else {
                    unreachable!()
                };
                let Node::Transcript { resource, key, .. } = &mut children[0] else {
                    unreachable!()
                };
                if change == "resource" {
                    resource.route = serde_json::json!({"other":true});
                } else {
                    *key = "replacement".into();
                }
            }
            _ => unreachable!(),
        }
        app.apps_transcript_mounts();
        assert!(
            !app.apps
                .readers
                .mounts
                .values()
                .any(|mount| mount.binding.token == token),
            "{change}"
        );
        assert!(!late(&mut app, token), "{change}");
        assert!(
            !draw(&mut app, 100, 35).contains("Retained reader snapshot"),
            "{change}"
        );
    }
}

#[test]
fn stopped_reader_only_reopens_after_explicit_parent_rebind_installs_a_fresh_view() {
    let (mut app, token) = stopped();
    let identity = (key(), "root/first".into());
    for effect in [
        ReaderEffect::Refresh,
        ReaderEffect::Older,
        ReaderEffect::Newer,
        ReaderEffect::Latest,
    ] {
        app.apps.readers.effect(token, effect);
        assert!(app.apps_transcript_mounts().is_empty());
        let mount = &app.apps.readers.mounts[&identity];
        assert_eq!(mount.binding.token, token);
        assert_eq!(mount.failure, Some(transport::Failure::Stopped));
        assert!(mount.pending.is_none());
        assert_eq!(mount.source.blocks().len(), 1);
        assert!(!late(&mut app, token));
        assert!(next(&mut app).is_none());
    }
    let view = instance_mut(&mut app).view.clone().unwrap();
    let old_owner = app.apps.readers.mounts[&identity].binding.owner;
    app.apps_action(Message::Instance(key(), Command::Refresh));
    let request = next(&mut app).expect("explicit parent read");
    assert!(!request.needs_checkpoint());
    let entry = instance_mut(&mut app).entry.clone().unwrap();
    app.apps_complete(
        request,
        Ok(Output::Rebound {
            entry: Box::new(entry),
            reply: Reply::View { view },
        }),
    );
    let mounts = app.apps_transcript_mounts();
    let fresh = &mounts[0];
    assert_ne!(fresh.token, token);
    assert_ne!(fresh.owner, old_owner);
    assert!(!app.apps.readers.mounts[&identity].failed);
    assert!(!late(&mut app, token));
    page(&mut app, fresh.token, "Fresh reader snapshot");
    let screen = draw(&mut app, 100, 35);
    assert!(screen.contains("Fresh reader snapshot"), "{screen}");
    assert!(!screen.contains("Retained reader snapshot"));
}
