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
use crate::apps::tests::{app, command, form, instance, key, next, save};
use maka_plugins::terminal_ui::view::{View, build::*};
use serde_json::json;

fn parent(context: u64) -> View {
    let mut view = form();
    view.revision = format!("context{context}");
    view.root = column(
        "root",
        vec![
            input("enabled", "enabled", "Enabled"),
            input("name", "name", "Name"),
            slot("detail", "capacity.detail", json!({"context": context})),
        ],
    );
    view
}

#[test]
fn applying_reviewed_context_mounts_new_children_only_after_acceptance() {
    for refuse in [false, true] {
        let mut app = app();
        let entry = instance(&app).entry.clone().unwrap();
        let mut filler = entry.clone();
        filler.package_id = "example.capacity-child".into();
        filler.method = "detail".into();
        filler.descriptor.placement = Placement::Slot {
            name: "capacity.detail".into(),
        };
        app.apps.directory.push(filler);
        app.apps_action(command(Command::Refresh));
        let read = next(&mut app).unwrap();
        app.apps_complete(read, Ok(Output::Reply(Reply::View { view: parent(1) })));
        let child_read = next(&mut app).unwrap();
        let previous = child_read.key.clone().unwrap();
        app.apps_complete(child_read, Ok(Output::Reply(Reply::View { view: form() })));
        app.apps_action(command(Command::View(Intent::Toggle("enabled".into()))));
        app.apps_action(save());
        let submit = next(&mut app).unwrap();
        app.apps_complete(submit, Ok(Output::Reply(Reply::Conflict)));
        app.apps_action(command(Command::ResumeDraft));
        let rebind = next(&mut app).unwrap();
        assert!(matches!(rebind.work, Work::Rebind { .. }));
        app.apps_complete(
            rebind,
            Ok(Output::Rebound {
                entry: Box::new(entry),
                reply: Reply::View { view: parent(2) },
            }),
        );
        assert!(instance(&app).review.is_some());
        assert!(next(&mut app).is_none(), "reviewed context is not live yet");
        let location = app.navigation.location().clone();
        if refuse {
            // Fault-inject only the local checkpoint envelope; no Host identity
            // or external account is involved in this failed-admission case.
            assert!(app.bind_root(&"x".repeat(CHECKPOINT_MAX_BYTES)));
        }
        assert!(app.apps_enabled(&command(Command::ApplyDraft)));
        app.apps_action(command(Command::ApplyDraft));
        if refuse {
            assert_eq!(app.navigation.location(), &location);
            assert!(instance(&app).review.is_some());
            assert_eq!(instance(&app).view.as_ref().unwrap().revision, "context1");
            assert!(next(&mut app).is_none());
        } else {
            assert!(instance(&app).review.is_none());
            assert!(!app.navigation.location().contains(&previous));
            let read =
                next(&mut app).expect("new child context reads immediately after ApplyDraft");
            let child = read.key.as_ref().unwrap();
            assert_eq!(child.within.as_ref().unwrap().0, key());
            assert_eq!(child.origin, json!({"context": 2}));
            assert!(
                matches!(read.work, Work::Call { input: Input::Read { route, .. }, .. } if route == json!({"context": 2}))
            );
        }
    }
}
