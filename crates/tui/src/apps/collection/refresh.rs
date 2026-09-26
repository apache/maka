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

use super::super::tests::{app, form, instance_mut, key};
use super::super::*;
use maka_plugins::terminal_ui::view::{self as wire, build::*};
use serde_json::json;

fn parent(revision: &str) -> wire::View {
    let mut view = form();
    view.revision = revision.into();
    view.fields.clear();
    view.actions = vec![action("move", "Move")];
    view.root = column(
        "root",
        ["detail", "draft", "unknown"]
            .into_iter()
            .map(|name| slot(name, name, json!({"card":"c2"})))
            .collect(),
    );
    view
}
fn detail(revision: &str, lane: &str) -> wire::View {
    let mut view = form();
    view.revision = revision.into();
    view.fields = vec![line("note", "", 128)];
    view.actions = vec![wire::Action {
        fields: vec!["note".into()],
        ..action("save", "Save")
    }];
    view.root = column(
        "root",
        vec![
            text("lane", lane, wire::Tone::Normal),
            input("note", "note", "Note"),
            button("save", "save", wire::Role::Primary),
        ],
    );
    view
}
fn edit(app: &mut App, key: &Key, note: &str) {
    let value = json!(note);
    assert!(app.admit_field(key, "note", &value));
    let instance = app.apps.instances.get_mut(key).unwrap();
    instance.editors.get_mut("note").unwrap().insert(note);
    instance.drafts.insert("note".into(), value);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Reading {
    Idle,
    Refresh,
    Initial,
}

#[test]
fn parent_applied_readback_refreshes_idle_clean_child() {
    exercise(Reading::Idle);
}
#[test]
fn parent_applied_readback_restarts_cancelled_child_refresh() {
    exercise(Reading::Refresh);
}
#[test]
fn parent_applied_readback_restarts_cancelled_initial_child_read() {
    exercise(Reading::Initial);
}

fn exercise(reading: Reading) {
    let mut app = app();
    instance_mut(&mut app).install(parent("one"));
    for name in ["detail", "draft", "unknown"] {
        let mut entry = app.apps.directory[0].clone();
        entry.method = name.into();
        entry.target.registration = uuid::Uuid::new_v4();
        entry.descriptor.placement = Placement::Slot { name: name.into() };
        entry.descriptor.changes = Some("changes".into());
        app.apps.directory.push(entry);
    }
    app.mount_app_views();
    let reads = app.apps_requests();
    assert_eq!(reads.len(), 3);
    let children: BTreeMap<_, _> = reads
        .iter()
        .map(|read| {
            let key = read.key.as_ref().unwrap();
            (key.method.clone(), key.clone())
        })
        .collect();
    let mut initial = None;
    for read in reads {
        if reading == Reading::Initial && read.key.as_ref().unwrap().method == "detail" {
            initial = Some(read);
        } else {
            app.apps_complete(
                read,
                Ok(Output::Reply(Reply::View {
                    view: detail("one", "Doing"),
                })),
            );
        }
    }
    let child = &children["detail"];
    let draft = &children["draft"];
    let unknown = &children["unknown"];
    edit(&mut app, draft, "independent draft");
    app.apps_action(Message::Instance(
        unknown.clone(),
        Command::View(Intent::Submit("save".into())),
    ));
    let writes = app.apps_requests();
    assert_eq!(writes.len(), 1);
    app.apps_complete(
        writes.into_iter().next().unwrap(),
        Err(io::Failure { unknown: true }),
    );
    let frozen = app.apps.instances[unknown]
        .unresolved
        .as_ref()
        .unwrap()
        .input
        .clone();
    assert!(!app.apps.instances[child].dirty());
    assert!(!app.apps.instances[child].keeps());
    let old_owner = app.apps.instances[child].execution;
    let old_watch = app
        .apps_watches()
        .into_iter()
        .find(|watch| watch.owner == old_owner)
        .unwrap();
    app.apps_action(Message::Instance(
        key(),
        Command::View(Intent::Submit("move".into())),
    ));
    let writes = app.apps_requests();
    assert_eq!(writes.len(), 1);
    let moving = writes.into_iter().next().unwrap();
    let old_read = if reading == Reading::Refresh {
        app.apps_changed(&old_watch);
        let reads = app.apps_requests();
        assert_eq!(reads.len(), 1);
        let read = reads.into_iter().next().unwrap();
        assert_eq!(read.key.as_ref(), Some(child));
        Some(read)
    } else {
        initial.take()
    };
    assert_eq!(app.apps.instances[child].reading, reading != Reading::Idle);
    assert_eq!(
        app.apps.instances[child].view.is_none(),
        reading == Reading::Initial
    );
    app.apps_complete(
        moving,
        Ok(Output::Reply(Reply::Applied { route: Value::Null })),
    );
    assert!(app.apps.instances[&key()].view.is_none());
    // The real driver reconciles execution/document ownership before polling
    // the parent's readback. Driving only apps_requests misses this boundary.
    assert!(!app.apps_executions().contains(&old_owner));
    assert!(app.apps.instances[child].execution.is_nil());
    app.apps_changed(&old_watch); // Late old-owner notification has no authority.
    let reads = app.apps_requests();
    assert_eq!(reads.len(), 1);
    let readback = reads.into_iter().next().unwrap();
    assert_eq!(readback.key.as_ref(), Some(&key()));
    if let Some(read) = old_read {
        app.apps_complete(
            read,
            Ok(Output::Reply(Reply::View {
                view: detail("old-late", "Stale"),
            })),
        );
        assert_eq!(
            app.apps.instances[child]
                .view
                .as_ref()
                .map(|view| view.revision.as_str()),
            if reading == Reading::Initial {
                None
            } else {
                Some("one")
            }
        );
    }
    app.apps_complete(
        readback,
        Ok(Output::Reply(Reply::View {
            view: parent("two"),
        })),
    );
    app.apps_executions();
    let reads = app.apps_requests();
    assert_eq!(
        reads.len(),
        1,
        "clean child must bootstrap its new execution after the observation gap; reading={reading:?}"
    );
    let refreshed = reads.into_iter().next().unwrap();
    assert_eq!(refreshed.key.as_ref(), Some(child));
    assert_ne!(refreshed.execution, old_owner);
    assert!(!refreshed.needs_checkpoint());
    app.apps_complete(
        refreshed,
        Ok(Output::Reply(Reply::View {
            view: detail("two", "Done"),
        })),
    );
    assert!(!app.apps.instances[child].dirty());
    assert!(
        app.apps_watches()
            .iter()
            .any(|watch| watch.owner == app.apps.instances[child].execution)
    );
    assert_eq!(
        app.apps.instances[draft].drafts["note"],
        "independent draft"
    );
    assert_eq!(
        app.apps.instances[unknown]
            .unresolved
            .as_ref()
            .unwrap()
            .input,
        frozen
    );
    edit(&mut app, child, "after move");
    app.apps_action(Message::Instance(
        child.clone(),
        Command::View(Intent::Submit("save".into())),
    ));
    let writes = app.apps_requests();
    assert_eq!(writes.len(), 1);
    assert!(
        matches!(&writes[0].work, Work::Call { input: Input::Submit { revision, fields, .. }, .. } if revision == "two" && fields["note"] == "after move")
    );
    assert_eq!(
        app.apps.instances[draft].drafts["note"],
        "independent draft"
    );
    assert_eq!(
        app.apps.instances[unknown]
            .unresolved
            .as_ref()
            .unwrap()
            .input,
        frozen
    );
}
