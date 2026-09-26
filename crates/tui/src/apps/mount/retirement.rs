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

//! One immutable address: the view it last read, the
//! drafts over that view, and the write it may be waiting to settle.

use super::*;
use crate::app::Action;
use crate::apps::{
    Command, Input, Intent, Message, Output, Work,
    instance::Notice,
    io,
    tests::{app, form, instance_mut, key},
};
use maka_plugins::terminal_ui::view::{Reply, build::slot};
use serde_json::json;

#[test]
fn hidden_clean_children_reactivate_but_drafts_and_unknown_writes_keep_original_ownership() {
    for retained in 0..3 {
        let mut app = app();
        let parent = key();
        let mut parent_view = form();
        parent_view.root = slot("create", "create", json!({"form":"new"}));
        instance_mut(&mut app).install(parent_view.clone());
        let mut filler = app.apps.directory[0].clone();
        filler.method = "create".into();
        filler.target.registration = uuid::Uuid::new_v4();
        filler.descriptor.placement = Placement::Slot {
            name: "create".into(),
        };
        app.apps.directory.push(filler.clone());
        let mut replacement = app.apps.directory.clone();
        app.mount_app_views();
        let mut requests = app.apps_requests();
        assert_eq!(requests.len(), 1);
        let initial = requests.pop().unwrap();
        let child = initial.key.clone().unwrap();
        app.apps_complete(initial, Ok(Output::Reply(Reply::View { view: form() })));
        if retained > 0 {
            app.apps_action(Message::Instance(
                child.clone(),
                Command::View(Intent::Toggle("enabled".into())),
            ));
        }
        if retained == 2 {
            app.apps_action(Message::Instance(
                child.clone(),
                Command::View(Intent::Submit("save".into())),
            ));
            let write = app.apps_requests().pop().unwrap();
            assert!(write.needs_checkpoint());
            app.apps_complete(write, Err(io::Failure { unknown: true }));
        }
        let frozen = app.apps.instances[&child]
            .unresolved
            .as_ref()
            .map(|pending| pending.input.clone());
        app.apply(Action::Visit(Route::Workspace));
        app.apps.directory.clear();
        app.apps.bind();
        app.mount_app_views();
        assert!(app.apps_requests().is_empty());
        if retained == 0 {
            assert!(matches!(
                app.apps.instances[&child].message,
                Some(Notice::Local("extensions-unavailable"))
            ));
        }
        for entry in &mut replacement {
            entry.target.registration = uuid::Uuid::new_v4();
            entry.target.activation = uuid::Uuid::new_v4().to_string();
        }
        app.apps.directory = replacement.clone();
        app.apps.bind();
        // The new binding's initial read is intentionally deferred offscreen.
        assert!(app.apps_requests().is_empty());
        let hidden = &app.apps.instances[&child];
        if retained == 0 {
            assert!(hidden.view.is_none());
            assert!(hidden.stale && hidden.pending.is_none());
            assert!(
                hidden.message.is_none(),
                "a retired diagnostic cannot suppress the eventual mount read"
            );
        } else {
            assert!(hidden.blocked);
            assert_eq!(hidden.entry.as_ref().unwrap().target, filler.target);
            assert_eq!(hidden.drafts["enabled"], false);
            assert_eq!(
                hidden
                    .unresolved
                    .as_ref()
                    .map(|pending| pending.input.clone()),
                frozen
            );
        }
        app.apps_action(Message::Open(parent.clone()));
        let mut requests = app.apps_requests();
        assert_eq!(requests.len(), 1);
        let read = requests.pop().unwrap();
        assert_eq!(read.key.as_ref(), Some(&parent));
        app.apps_complete(read, Ok(Output::Reply(Reply::View { view: parent_view })));
        let mut requests = app.apps_requests();
        if retained == 0 {
            assert_eq!(
                requests.len(),
                1,
                "the visible clean child must reopen automatically"
            );
            let read = requests.pop().unwrap();
            assert_eq!(read.key.as_ref(), Some(&child));
            assert!(
                matches!(&read.work, Work::Call { entry, input: Input::Read { .. } } if entry.target == replacement[1].target)
            );
            app.apps_complete(read, Ok(Output::Reply(Reply::View { view: form() })));
            assert!(app.apps.instances[&child].message.is_none());
            assert!(app.apps_enabled(&Message::Instance(
                child.clone(),
                Command::View(Intent::Submit("save".into()))
            )));
        } else {
            assert!(
                requests.is_empty(),
                "retained children require explicit recovery, never automatic rebinding/replay"
            );
            assert!(!app.apps_enabled(&Message::Instance(
                child.clone(),
                Command::View(Intent::Submit("save".into()))
            )));
            assert_eq!(app.apps.instances[&child].drafts["enabled"], false);
            assert_eq!(
                app.apps.instances[&child]
                    .unresolved
                    .as_ref()
                    .map(|pending| pending.input.clone()),
                frozen
            );
        }
    }
}
