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

//! UI integration tests of the Import/export tasks page against the
//! scripted Host, whose answers follow the TS decoders
//! (packages/runtime-host/src/protocol/external-session.ts,
//! session-bundle.ts, session-catalog.ts).

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{ElementId, TestAppContext};
use serde_json::{Value, json};
use shared::copy::tasks as copy;
use shared::domain_element_id;
use workspace::HostRequestError;

use crate::tests::{Harness, ScriptedHost, policy};
use crate::{BUNDLE_SOURCE, OpenTask, SettingsSection, TransferMode};

fn conversation(id: &str, name: &str, imported: u64) -> Value {
    let ids: Vec<String> = (0..imported).map(|ix| format!("task-{id}-{ix}")).collect();
    json!({"id": id, "name": name, "hostCwd": "/work/parser",
           "importState": {"importedCount": imported, "importedSessionIds": ids,
                           "isImporting": false},
           "updatedAt": 1_790_000_000_000_u64})
}

fn page(sessions: Vec<Value>, next: Option<&str>) -> Value {
    json!({"sessions": sessions, "nextCursor": next})
}

fn projection(id: &str, name: &str, parent: Option<&str>) -> Value {
    let mut value = json!({
        "id": id, "revision": 1,
        "workspace": {"target": {"kind": "host_path", "path": "/w"}, "hostCwd": "/w"},
        "createdAt": 1, "activityAt": 2, "name": name, "isFlagged": false, "isArchived": false,
        "labels": [], "labelsTruncated": false, "hasUnread": false, "status": "active",
        "backend": "ai-sdk", "llmConnectionId": null, "llmConnectionSlug": "env",
        "connectionLocked": false, "model": "m", "permissionMode": "ask",
        "collaborationMode": "agent", "orchestrationMode": "default"
    });
    if let Some(parent) = parent {
        value["subagent"] = json!({"parentSessionId": parent, "agentName": "Explorer"});
    }
    value
}

/// Codex and Claude Code installed; Codex's first page has two
/// conversations, one imported before.
fn open(cx: &mut TestAppContext) -> Harness {
    let transport = Arc::new(ScriptedHost::default());
    transport.reply("runtime.policy.query", Ok(policy(3, "ask")));
    transport.reply(
        "external-session.source.query",
        Ok(json!({"adapterIds": ["codex", "claude-code"]})),
    );
    transport.reply(
        "external-session.catalog.query",
        Ok(page(
            vec![conversation("r1", "Fix the parser", 0), conversation("r2", "Write docs", 1)],
            Some("c:2"),
        )),
    );
    Harness::open_with_transport(SettingsSection::ImportTasks, transport, cx)
}

fn row(id: &str) -> ElementId {
    domain_element_id("transfer-row", id)
}

fn status(key: &str) -> ElementId {
    domain_element_id("settings-status", key)
}

impl Harness {
    fn transfer_line(&self, key: &str, cx: &mut TestAppContext) -> Option<String> {
        self.with_window(cx, |window, _| {
            window.try_find(status(key)).and_then(|line| line.label().map(str::to_owned))
        })
    }

    fn opened_tasks(&self, cx: &mut TestAppContext) -> Rc<RefCell<Vec<String>>> {
        let opened = Rc::new(RefCell::new(Vec::new()));
        let recorded = opened.clone();
        cx.update(|cx| {
            cx.subscribe(&self.view, move |_, event: &OpenTask, _| {
                recorded.borrow_mut().push(event.session_id.to_string());
            })
            .detach();
        });
        opened
    }
}

#[gpui_kit::test]
fn the_page_lists_the_first_sources_conversations(cx: &mut TestAppContext) {
    let harness = open(cx);
    let transport = harness.transport.clone();
    assert_eq!(transport.requests("external-session.source.query"), [json!({})]);
    assert_eq!(
        transport.requests("external-session.catalog.query"),
        [json!({"adapterId": "codex", "includeArchived": false})]
    );
    harness.with_window(cx, |window, _| {
        for source in ["codex", "claude-code", BUNDLE_SOURCE] {
            assert!(window.find(domain_element_id("transfer-source", source)).visible());
        }
        let label = window.find(row("r2")).label().map(str::to_owned).expect("label");
        assert!(label.starts_with("Write docs, /work/parser · "), "{label}");
        assert!(label.ends_with(" · Imported once"), "{label}");
        assert_eq!(
            window.find(domain_element_id("transfer-import", "r2")).label(),
            Some("Import Write docs again")
        );
        assert!(window.find(domain_element_id("transfer-open", "r2")).visible());
        assert!(window.try_find(domain_element_id("transfer-open", "r1")).is_none());
    });

    // Load more asks for the page after; the archived filter and the search
    // read the first page again.
    transport.reply(
        "external-session.catalog.query",
        Ok(page(vec![conversation("r3", "Refactor", 0)], None)),
    );
    harness.click("transfer-load-more", cx);
    assert_eq!(
        transport.requests("external-session.catalog.query")[1],
        json!({"adapterId": "codex", "includeArchived": false, "cursor": "c:2"})
    );
    harness.with_window(cx, |window, _| {
        assert!(window.try_find(row("r3")).is_some());
        assert!(window.try_find("transfer-load-more").is_none());
    });
    transport.reply("external-session.catalog.query", Ok(page(vec![], None)));
    harness.click("transfer-include-archived", cx);
    assert_eq!(
        transport.requests("external-session.catalog.query")[2],
        json!({"adapterId": "codex", "includeArchived": true})
    );
    transport.reply("external-session.catalog.query", Ok(page(vec![], None)));
    harness.with_window(cx, |window, cx| {
        window.click("transfer-search", cx);
        window.input(" parser ", cx);
    });
    assert_eq!(transport.requests("external-session.catalog.query").len(), 3, "not yet");
    cx.executor().advance_clock(Duration::from_millis(300));
    cx.run_until_parked();
    assert_eq!(
        transport.requests("external-session.catalog.query")[3],
        json!({"adapterId": "codex", "includeArchived": true, "text": "parser"})
    );
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("transfer-empty").label(), Some(copy::IMPORT_SEARCH.en()));
    });
}

#[gpui_kit::test]
fn importing_one_conversation_opens_its_task_and_a_refusal_says_why(cx: &mut TestAppContext) {
    let harness = open(cx);
    let transport = harness.transport.clone();
    let opened = harness.opened_tasks(cx);
    transport.reply(
        "external-session.import",
        Err(HostRequestError::Operation {
            operation: "external-session.import",
            code: host_protocol::HostOperationErrorCode::ModelUnavailable,
            message: "no model".into(),
        }),
    );
    harness.click(domain_element_id("transfer-import", "r1"), cx);
    assert_eq!(
        transport.requests("external-session.import"),
        [json!({"adapterId": "codex", "sourceSessionId": "r1"})]
    );
    let line = harness.transfer_line("transfer-import", cx).expect("says why");
    assert!(line.ends_with(copy::IMPORT_NO_MODEL.en()), "{line}");
    assert!(opened.borrow().is_empty());

    transport.reply(
        "external-session.import",
        Ok(json!({"kind": "imported", "session": projection("s-new", "Fix the parser", None)})),
    );
    harness.click(domain_element_id("transfer-import", "r1"), cx);
    assert_eq!(*opened.borrow(), ["s-new"], "the task opens");

    // A source over a limit says which.
    transport.reply(
        "external-session.import",
        Ok(json!({"kind": "source_limit_exceeded",
                  "limit": {"kind": "transcript_bytes", "max": 67_108_864}})),
    );
    harness.click(domain_element_id("transfer-import", "r1"), cx);
    let line = harness.transfer_line("transfer-import", cx).expect("says why");
    assert!(line.contains("source file size allows at most 67,108,864 bytes"), "{line}");

    // The latest task a conversation became opens from its row.
    harness.click(domain_element_id("transfer-open", "r2"), cx);
    assert_eq!(*opened.borrow(), ["s-new", "task-r2-0"]);
}

#[gpui_kit::test]
fn a_batch_imports_the_marked_rows_and_reports_on_the_page(cx: &mut TestAppContext) {
    let harness = open(cx);
    let transport = harness.transport.clone();
    let opened = harness.opened_tasks(cx);
    harness.click("transfer-select-all", cx);
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("transfer-selected-count").label(), Some("2 / 2 selected"));
    });
    for id in ["s1", "s2"] {
        transport.reply(
            "external-session.import",
            Ok(json!({"kind": "imported", "session": projection(id, id, None)})),
        );
    }
    let after = vec![conversation("r1", "Fix the parser", 1), conversation("r2", "Write docs", 2)];
    transport.reply("external-session.catalog.query", Ok(page(after, None)));
    harness.click("transfer-import-selected", cx);
    let imported: Vec<Value> = transport
        .requests("external-session.import")
        .iter()
        .map(|request| request["sourceSessionId"].clone())
        .collect();
    assert_eq!(imported, [json!("r1"), json!("r2")], "one after another, in the list's order");
    assert!(opened.borrow().is_empty(), "a batch stays on the page");
    let line = harness.transfer_line("transfer-summary", cx).expect("reports");
    assert_eq!(
        line,
        "Imported 2 conversations 1 of them had been imported before and now exist twice."
    );
    assert_eq!(transport.requests("external-session.catalog.query").len(), 2, "read again");
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("transfer-selected-count").label(), Some("0 / 2 selected"));
    });
}

#[gpui_kit::test]
fn a_maka_session_file_imports_from_the_file_dialog(cx: &mut TestAppContext) {
    let harness = open(cx);
    let transport = harness.transport.clone();
    harness.click(domain_element_id("transfer-source", BUNDLE_SOURCE), cx);
    let source =
        harness.view.read_with(cx, |view, cx| view.transfer().read(cx).source().map(str::to_owned));
    assert_eq!(source.as_deref(), Some(BUNDLE_SOURCE));
    transport.reply("session-bundle.import", Ok(json!({"sessionCount": 2, "artifactFiles": 3})));
    harness.click("transfer-bundle-import", cx);
    assert!(cx.did_prompt_for_paths());
    cx.simulate_path_prompt_response(|_| Some(vec![PathBuf::from("/tmp/Plan.maka-session")]));
    cx.run_until_parked();
    assert_eq!(
        transport.requests("session-bundle.import"),
        [json!({"source": "/tmp/Plan.maka-session"})]
    );
    assert_eq!(harness.transfer_line("transfer-note", cx).as_deref(), Some("Imported 2 tasks"));

    // A refusal the person can act on says so.
    transport.reply(
        "session-bundle.import",
        Err(HostRequestError::Operation {
            operation: "session-bundle.import",
            code: host_protocol::HostOperationErrorCode::SourceUnreadable,
            message: "bad file".into(),
        }),
    );
    harness.click("transfer-bundle-import", cx);
    cx.simulate_path_prompt_response(|_| Some(vec![PathBuf::from("/tmp/Other.maka-session")]));
    cx.run_until_parked();
    assert_eq!(
        harness.transfer_line("transfer-note", cx).as_deref(),
        Some(copy::BUNDLE_UNREADABLE.en())
    );
}

#[gpui_kit::test]
fn exporting_a_task_with_subagents_asks_then_writes_the_confirmed_subtree(cx: &mut TestAppContext) {
    let harness = open(cx);
    let transport = harness.transport.clone();
    transport.reply(
        "session.catalog.query",
        Ok(json!({"kind": "page", "revision": "sha256:00", "nextCursor": null, "sessions": [
            projection("root", "Plan: v2", None),
            projection("child", "Explore", Some("root")),
            projection("lone", "Lone task", None),
        ]})),
    );
    // The mode control is Desktop's `layout="fill" size="sm"`: 28 tall,
    // the content column's width (inside its 24 margins), two equal halves.
    harness.with_window(cx, |window, _| {
        let track = window.find("transfer-mode").bounds();
        let column = window.find(domain_element_id("settings-section", "import-tasks")).bounds();
        assert_eq!(track.size.height, gpui_kit::px(28.));
        assert_eq!(track.size.width, column.size.width - gpui_kit::px(48.), "{track:?}");
        let import = window.find(domain_element_id("transfer-mode", "import")).bounds();
        let export = window.find(domain_element_id("transfer-mode", "export")).bounds();
        assert_eq!(import.size.width, export.size.width);
    });
    harness.click(domain_element_id("transfer-mode", "export"), cx);
    let mode = harness.view.read_with(cx, |view, cx| view.transfer().read(cx).mode());
    assert_eq!(mode, TransferMode::Export);
    harness.with_window(cx, |window, _| {
        assert!(window.find(domain_element_id("transfer-export-row", "child")).visible());
        assert_eq!(
            window.find(domain_element_id("transfer-export", "root")).label(),
            Some("Export Plan: v2")
        );
    });
    transport
        .reply("session-bundle.export", Ok(json!({"sessionCount": 2, "compressedBytes": 900})));
    harness.click(domain_element_id("transfer-export", "root"), cx);
    assert!(!cx.did_prompt_for_new_path(), "it asks first");
    harness.with_window(cx, |window, cx| window.click("ok", cx));
    assert!(cx.did_prompt_for_new_path());
    cx.simulate_new_path_selection(|_| Some(PathBuf::from("/tmp/Plan v2.maka-session")));
    cx.run_until_parked();
    let request = transport.requests("session-bundle.export").pop().expect("exported");
    assert_eq!(
        request,
        json!({"sessionId": "root", "destination": "/tmp/Plan v2.maka-session",
               // sha256 of "child\nroot", as Desktop's main computes it.
               "expectedSubtreeDigest":
                   "8599bed148a519ce04b6573fbf67812546d3f8a2b03d52f6f63e6b58e16c9e42"})
    );
    assert_eq!(harness.transfer_line("transfer-note", cx).as_deref(), Some("Exported 2 tasks"));

    // A task with nothing under it goes straight to the save dialog.
    harness.click(domain_element_id("transfer-export", "lone"), cx);
    assert!(cx.did_prompt_for_new_path());
    cx.simulate_new_path_selection(|_| None);
    cx.run_until_parked();
    assert_eq!(transport.requests("session-bundle.export").len(), 1, "cancelled: nothing sent");
}

#[gpui_kit::test]
fn command_f_focuses_the_imports_search_while_a_source_lists_tasks(cx: &mut TestAppContext) {
    let harness = open(cx);
    harness.with_window(cx, |window, _| assert!(window.try_find("transfer-search").is_some()));
    let search = harness.view.read_with(cx, |view, cx| view.transfer().read(cx).search_field());
    crate::tests::command_f_focuses(&harness, &search.expect("the search shows"), cx);
    // A bundle lists nothing to search: the section search.
    harness.click(domain_element_id("transfer-source", BUNDLE_SOURCE), cx);
    let search = harness.view.read_with(cx, |view, cx| {
        assert!(view.transfer().read(cx).search_field().is_none());
        view.section_search().clone()
    });
    crate::tests::command_f_focuses(&harness, &search, cx);
}
