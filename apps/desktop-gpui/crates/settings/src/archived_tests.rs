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

//! UI integration tests of the Archived tasks page against the scripted
//! Host, whose answers follow `decodeSessionCatalogQueryResult`
//! (packages/runtime-host/src/protocol/session-catalog.ts) and the
//! retirement decoders (session-retirement.ts).

use std::sync::Arc;

use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{ElementId, TestAppContext};
use host_client::HostEvent;
use host_protocol::{ChangeNotice, PushFrame};
use serde_json::{Value, json};
use shared::copy::tasks as copy;
use shared::domain_element_id;
use workspace::HostRequestError;

use crate::SettingsSection;
use crate::tests::{Harness, ScriptedHost, policy};

const REVISION: &str = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

fn session(id: &str, name: &str, archived: bool) -> Value {
    json!({
        "id": id, "revision": 3,
        "workspace": {"target": {"kind": "host_path", "path": "/work/demo"},
                      "hostCwd": "/work/demo"},
        "createdAt": 1, "activityAt": 2, "name": name, "isFlagged": false,
        "isArchived": archived, "labels": [], "labelsTruncated": false, "hasUnread": false,
        "status": "active", "backend": "ai-sdk", "llmConnectionId": null,
        "llmConnectionSlug": "env", "connectionLocked": false, "model": "m",
        "permissionMode": "ask", "collaborationMode": "agent", "orchestrationMode": "default"
    })
}

fn page(sessions: Vec<Value>) -> Value {
    json!({"kind": "page", "revision": REVISION, "sessions": sessions, "nextCursor": null})
}

/// Two archived tasks, an active one, a subtask of the first (not a row of
/// its own), and a subtask whose parent was deleted.
fn catalog() -> Value {
    let mut child = session("s-child", "Child of plan", true);
    child["parentSessionId"] = json!("s-plan");
    let mut orphan = session("s-orphan", "Orphan", true);
    orphan["parentSessionId"] = json!("s-gone");
    page(vec![
        session("s-plan", "Plan the release", true),
        session("s-live", "Still active", false),
        child,
        session("s-notes", "Meeting notes", true),
        orphan,
    ])
}

fn open(catalog: Value, cx: &mut TestAppContext) -> Harness {
    let transport = Arc::new(ScriptedHost::default());
    transport.reply("runtime.policy.query", Ok(policy(3, "ask")));
    transport.reply("session.catalog.query", Ok(catalog));
    Harness::open_with_transport(SettingsSection::ArchivedTasks, transport, cx)
}

fn row(id: &str) -> ElementId {
    domain_element_id("archived-task", id)
}

impl Harness {
    fn archived_ids(&self, cx: &mut TestAppContext) -> Vec<String> {
        self.view.read_with(cx, |view, cx| {
            view.archived().read(cx).visible(cx).iter().map(|task| task.id.to_string()).collect()
        })
    }

    fn search_archived(&self, text: &str, cx: &mut TestAppContext) {
        self.with_window(cx, |window, cx| {
            window.click("archived-search", cx);
            window.press("cmd-a", cx);
            if text.is_empty() {
                window.press("backspace", cx);
            } else {
                window.input(text, cx);
            }
        });
    }
}

#[gpui_kit::test]
fn the_page_lists_archived_tasks_as_the_sidebar_counts_them(cx: &mut TestAppContext) {
    let harness = open(catalog(), cx);
    assert_eq!(
        harness.transport.requests("session.catalog.query"),
        [json!({"kind": "list_start"})]
    );
    assert_eq!(harness.archived_ids(cx), ["s-plan", "s-notes", "s-orphan"]);
    harness.with_window(cx, |window, _| {
        // The name, then what the row says under it: the project and a
        // time, the creation for a task with no message.
        let plan = window.find(row("s-plan")).label().expect("label").to_owned();
        assert!(plan.starts_with("Plan the release, No project · "), "{plan}");
        assert!(plan.len() > "Plan the release, No project · ".len(), "{plan}");
        let orphan = window.find(row("s-orphan")).label().expect("label").to_owned();
        assert!(orphan.starts_with("Orphan, Parent task deleted · No project · "), "{orphan}");
        // Restore and Delete, both on the row.
        let restore = window.find(domain_element_id("archived-restore", "s-plan"));
        assert!(restore.visible());
        assert_eq!(restore.label(), Some("Unarchive Plan the release"));
        assert!(window.find(domain_element_id("archived-delete", "s-plan")).visible());
        assert_eq!(window.find("archived-purge").label(), Some(copy::ARCHIVED_PURGE_ALL.en()));
    });

    // The search finds a task by name; the button then deletes what shows.
    harness.search_archived("NOTES", cx);
    assert_eq!(harness.archived_ids(cx), ["s-notes"]);
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("archived-purge").label(), Some("Delete this 1"));
        assert!(window.try_find(row("s-plan")).is_none());
    });
    harness.search_archived("zzz", cx);
    harness.with_window(cx, |window, _| {
        assert!(window.find("archived-no-match").visible());
    });
}

#[gpui_kit::test]
fn nothing_archived_says_so(cx: &mut TestAppContext) {
    let harness = open(page(vec![session("s-live", "Still active", false)]), cx);
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("archived-empty").label(), Some(copy::ARCHIVED_EMPTY.en()));
        assert!(window.try_find("archived-purge").is_none());
    });
}

#[gpui_kit::test]
fn restoring_a_task_unarchives_it_and_a_refusal_says_why(cx: &mut TestAppContext) {
    let harness = open(catalog(), cx);
    let restored = session("s-plan", "Plan the release", false);
    harness.transport.reply("session.lifecycle.set", Ok(restored));
    harness.click(domain_element_id("archived-restore", "s-plan"), cx);
    assert_eq!(
        harness.transport.requests("session.lifecycle.set"),
        [json!({"sessionId": "s-plan", "state": "active"})]
    );
    assert_eq!(harness.archived_ids(cx), ["s-notes", "s-orphan"]);

    harness.transport.reply(
        "session.lifecycle.set",
        Err(HostRequestError::Operation {
            operation: "session.lifecycle.set",
            code: host_protocol::HostOperationErrorCode::SessionBusy,
            message: "a turn is running".into(),
        }),
    );
    harness.click(domain_element_id("archived-restore", "s-notes"), cx);
    let line = harness.with_window(cx, |window, _| {
        window
            .find(domain_element_id("settings-status", "archived-tasks"))
            .label()
            .map(str::to_owned)
    });
    assert_eq!(line.as_deref(), Some("Couldn’t unarchive the task. A turn is running."));
    assert_eq!(harness.archived_ids(cx), ["s-notes", "s-orphan"], "kept");
}

#[gpui_kit::test]
fn deleting_a_task_asks_with_its_subtasks_and_removes_it_while_still_archived(
    cx: &mut TestAppContext,
) {
    let harness = open(catalog(), cx);
    let transport = harness.transport.clone();
    transport.reply("session.remove.preview", Ok(json!({"archivableSubtaskCount": 1})));
    harness.click(domain_element_id("archived-delete", "s-plan"), cx);
    assert_eq!(transport.requests("session.remove.preview"), [json!({"sessionId": "s-plan"})]);
    assert!(transport.requests("session.remove").is_empty(), "nothing before the answer");
    // The removal reads the task again and removes it at that revision.
    transport.reply(
        "session.catalog.query",
        Ok(json!({"kind": "session",
        "session": session("s-plan", "Plan the release", true)})),
    );
    transport.reply(
        "session.remove",
        Ok(json!({"kind": "removed", "sessionId": "s-plan", "archivedSubtaskCount": 1})),
    );
    harness.with_window(cx, |window, cx| window.click("ok", cx));
    assert_eq!(
        transport.requests("session.catalog.query").last(),
        Some(&json!({"kind": "get", "sessionId": "s-plan"}))
    );
    assert_eq!(
        transport.requests("session.remove"),
        [json!({"sessionId": "s-plan", "expectedRevision": 3})]
    );
    assert_eq!(harness.archived_ids(cx), ["s-notes", "s-orphan"]);

    // A task restored while the question was up is kept.
    transport.reply("session.remove.preview", Ok(json!({"archivableSubtaskCount": 0})));
    harness.click(domain_element_id("archived-delete", "s-notes"), cx);
    transport.reply(
        "session.catalog.query",
        Ok(json!({"kind": "session",
        "session": session("s-notes", "Meeting notes", false)})),
    );
    harness.with_window(cx, |window, cx| window.click("ok", cx));
    assert_eq!(transport.requests("session.remove").len(), 1, "not removed");
}

#[gpui_kit::test]
fn a_sweep_deletes_what_the_search_found_after_asking(cx: &mut TestAppContext) {
    let harness = open(catalog(), cx);
    let transport = harness.transport.clone();
    // Every row reads "No project", so the search finds a task by its name.
    harness.search_archived("orphan", cx);
    assert_eq!(harness.archived_ids(cx), ["s-orphan"]);
    harness.click("archived-purge", cx);
    assert!(transport.requests("session.remove").is_empty(), "it asks first");
    transport.reply(
        "session.catalog.query",
        Ok(json!({"kind": "session", "session": session("s-orphan", "Orphan", true)})),
    );
    transport.reply("session.remove", Ok(json!({"kind": "removed", "sessionId": "s-orphan"})));
    // The page reads the catalog again after the sweep.
    let rest = page(vec![session("s-plan", "Plan", true), session("s-notes", "Notes", true)]);
    transport.reply("session.catalog.query", Ok(rest));
    harness.with_window(cx, |window, cx| window.click("ok", cx));
    let removed: Vec<Value> =
        transport.requests("session.remove").iter().map(|r| r["sessionId"].clone()).collect();
    assert_eq!(removed, [json!("s-orphan")], "only what the search found");
    assert!(!harness.view.read_with(cx, |view, cx| view.is_busy(cx)));

    // With no search, Clear all takes every archived task.
    harness.search_archived("", cx);
    assert_eq!(harness.archived_ids(cx), ["s-plan", "s-notes"]);
    for (id, name) in [("s-plan", "Plan"), ("s-notes", "Notes")] {
        transport.reply(
            "session.catalog.query",
            Ok(json!({"kind": "session", "session": session(id, name, true)})),
        );
        transport.reply("session.remove", Ok(json!({"kind": "removed", "sessionId": id})));
    }
    transport.reply("session.catalog.query", Ok(page(vec![])));
    harness.click("archived-purge", cx);
    harness.with_window(cx, |window, cx| window.click("ok", cx));
    assert_eq!(transport.requests("session.remove").len(), 3);
    harness.with_window(cx, |window, _| {
        assert!(window.find("archived-empty").visible());
    });
}

#[gpui_kit::test]
fn the_list_follows_the_hosts_catalog_notices(cx: &mut TestAppContext) {
    let harness = open(catalog(), cx);
    harness.transport.reply("session.catalog.query", Ok(page(vec![])));
    harness.host.update(cx, |host, cx| {
        let notice = ChangeNotice::SessionCatalogChanged {
            revision: 2,
            session_id: "s-plan".into(),
            attention: None,
        };
        host.handle_host_event(HostEvent::Push(PushFrame::Change(notice)), cx)
    });
    cx.run_until_parked();
    assert!(harness.archived_ids(cx).is_empty(), "read again, as the sidebar is");
}

#[gpui_kit::test]
fn command_f_focuses_the_search_while_tasks_are_listed(cx: &mut TestAppContext) {
    let harness = open(catalog(), cx);
    harness.with_window(cx, |window, _| assert!(window.try_find("archived-search").is_some()));
    let search = harness.view.read_with(cx, |view, cx| view.archived().read(cx).search_field());
    crate::tests::command_f_focuses(&harness, &search.expect("the search shows"), cx);

    // With nothing archived there is no search: the section search.
    let harness = open(page(vec![session("s-live", "Still active", false)]), cx);
    let search = harness.view.read_with(cx, |view, cx| {
        assert!(view.archived().read(cx).search_field().is_none());
        view.section_search().clone()
    });
    crate::tests::command_f_focuses(&harness, &search, cx);
}
