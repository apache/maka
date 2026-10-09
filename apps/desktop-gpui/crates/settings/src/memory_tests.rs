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

//! UI integration tests of the Memory page against the scripted Host of
//! [`crate::tests`]: memory read at one revision with its entries page by
//! page, the filter, an entry added, archived, and restored through the
//! Host, MEMORY.md saved by upload, reset, a backup restored after the
//! question, the switches, the model-context preview, and incognito.
//! Answers follow `decodeMemoryQueryResult` and `decodeMemoryMutateResult`
//! (packages/runtime-host/src/protocol/memory.ts).

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;

use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{ElementId, Entity, TestAppContext};
use host_protocol::{MemoryMutateInput, memory_content_revision};
use serde_json::{Value, json};
use shared::copy::memory as copy;
use shared::domain_element_id;

use crate::tests::{Harness, ScriptedHost, policy};
use crate::{MemoryPage, SettingsSection};

const DOC: &str = "# Memory\n\n## Preference\n<!-- maka-memory: id=e1 origin=manual status=active tags=style -->\nUse concise answers.\n\n## Editor\n<!-- maka-memory: id=e2 status=active -->\nUses Zed.\n\n## Old\n<!-- maka-memory: id=e3 status=archived -->\nNo longer true.\n";

fn rev(fill: char) -> String {
    format!("sha256:{}", fill.to_string().repeat(64))
}

fn base64(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let chunk = MemoryMutateInput::replace_chunk("u", text.as_bytes(), 0).expect("a chunk");
    serde_json::to_value(chunk).expect("encode")["chunkBase64"].as_str().expect("b64").to_owned()
}

fn state(bundle: char, document: &str, active: u64, archived: u64) -> Value {
    json!({"kind": "state", "revision": rev(bundle), "memoryRevision": memory_content_revision(document.as_bytes()),
           "pendingRevision": null, "agentReadEnabled": false, "status": "ok",
           "entryCount": active + archived, "activeEntryCount": active,
           "archivedEntryCount": archived, "proposalCount": 0,
           "backups": [{"kind": "save", "revision": rev('b'), "updatedAt": 1_700_000_000_000u64,
                        "sizeBytes": 120, "entryCount": 1, "activeEntryCount": 1,
                        "archivedEntryCount": 0, "safeMode": false}]})
}

fn document(text: &str) -> Value {
    json!({"kind": "document_page", "document": "memory",
           "revision": memory_content_revision(text.as_bytes()), "totalBytes": text.len(),
           "offset": 0, "chunkBase64": base64(text), "nextCursor": null})
}

fn entry(id: &str, title: &str, status: &str, updated: u64, tags: &[&str]) -> Value {
    json!({"id": id, "source": "user_authored", "status": status, "title": title,
           "content": format!("{title} text"), "scope": "workspace", "updatedAt": updated,
           "tags": tags})
}

fn page(view: &str, bundle: char, items: Vec<Value>, next: Option<u64>) -> Value {
    json!({"kind": "entries_page", "view": view, "revision": rev(bundle), "items": items,
           "nextCursor": next})
}

/// A whole read of memory at bundle revision `bundle`: the state, MEMORY.md,
/// two active entries, and one archived.
fn snapshot(transport: &ScriptedHost, bundle: char, text: &str) {
    transport.reply("memory.query", Ok(state(bundle, text, 2, 1)));
    transport.reply("memory.query", Ok(document(text)));
    transport.reply(
        "memory.query",
        Ok(page(
            "active",
            bundle,
            vec![
                entry("e1", "Preference", "active", 10, &["style"]),
                entry("e2", "Editor", "active", 20, &[]),
            ],
            None,
        )),
    );
    transport.reply(
        "memory.query",
        Ok(page("archived", bundle, vec![entry("e3", "Old", "archived", 5, &[])], None)),
    );
}

/// Settings on Memory over `transport`, which answers the first policy
/// read with the Host's defaults (memory on, not readable by the model).
fn open(transport: Arc<ScriptedHost>, cx: &mut TestAppContext) -> Harness {
    transport.reply("runtime.policy.query", Ok(policy(3, "ask")));
    Harness::open_with_transport(SettingsSection::Memory, transport, cx)
}

fn opened(cx: &mut TestAppContext) -> Harness {
    let transport = Arc::new(ScriptedHost::default());
    snapshot(&transport, 'a', DOC);
    open(transport, cx)
}

fn mutations(harness: &Harness) -> Vec<Value> {
    harness.transport.requests("memory.mutate")
}

impl Harness {
    fn memory(&self, cx: &mut TestAppContext) -> Entity<MemoryPage> {
        self.view.read_with(cx, |view, _| view.memory().clone())
    }

    fn memory_label(&self, id: impl Into<ElementId>, cx: &mut TestAppContext) -> Option<String> {
        let id = id.into();
        self.with_window(cx, |window, _| {
            window.try_find(id).and_then(|e| e.label().map(str::to_owned))
        })
    }

    fn memory_line(&self, area: &str, cx: &mut TestAppContext) -> Option<String> {
        self.memory_label(domain_element_id("settings-status", area), cx)
    }

    fn entries_shown(&self, cx: &mut TestAppContext) -> Vec<String> {
        self.with_window(cx, |window, _| {
            let mut shown: Vec<(gpui_kit::Pixels, String)> = ["e1", "e2", "e3", "e9"]
                .into_iter()
                .filter_map(|id| {
                    let row = window.try_find(domain_element_id("memory-entry", id))?;
                    Some((row.bounds().top(), id.to_owned()))
                })
                .collect();
            shown.sort_by(|a, b| a.0.partial_cmp(&b.0).expect("ordered"));
            shown.into_iter().map(|(_, id)| id).collect()
        })
    }

    fn type_into_memory(&self, id: &'static str, text: &str, cx: &mut TestAppContext) {
        self.with_window(cx, |window, cx| {
            window.click(id, cx);
            window.press("cmd-a", cx);
            window.input(text, cx);
        });
    }
}

#[gpui_kit::test]
fn memory_is_read_at_one_revision_with_its_entries_page_by_page(cx: &mut TestAppContext) {
    let transport = Arc::new(ScriptedHost::default());
    transport.reply("memory.query", Ok(state('a', DOC, 2, 1)));
    transport.reply("memory.query", Ok(document(DOC)));
    transport.reply(
        "memory.query",
        Ok(page("active", 'a', vec![entry("e1", "Preference", "active", 10, &["style"])], Some(1))),
    );
    // The bundle moved between two pages: the list is read again.
    transport.reply(
        "memory.query",
        Ok(json!({"kind": "revision_changed", "expectedRevision": rev('a'),
                  "actualRevision": rev('a')})),
    );
    transport.reply(
        "memory.query",
        Ok(page("active", 'a', vec![entry("e1", "Preference", "active", 10, &["style"])], Some(1))),
    );
    transport.reply(
        "memory.query",
        Ok(page("active", 'a', vec![entry("e2", "Editor", "active", 20, &[])], None)),
    );
    transport.reply(
        "memory.query",
        Ok(page("archived", 'a', vec![entry("e3", "Old", "archived", 5, &[])], None)),
    );
    let harness = open(transport, cx);
    let continued = json!({"kind": "entries_continue", "view": "active", "revision": rev('a'),
                           "cursor": 1});
    assert_eq!(
        harness.transport.requests("memory.query"),
        [
            json!({"kind": "state"}),
            json!({"kind": "document_start", "document": "memory"}),
            json!({"kind": "entries_start", "view": "active"}),
            continued.clone(),
            json!({"kind": "entries_start", "view": "active"}),
            continued,
            json!({"kind": "entries_start", "view": "archived"}),
        ]
    );
    // Newest first in each list; the archived list after the active one.
    assert_eq!(harness.entries_shown(cx), ["e2", "e1", "e3"]);
    // The first group is named, as each group under it is.
    let sources =
        harness.memory_label(domain_element_id("settings-group-title", "memory-sources"), cx);
    assert_eq!(sources.as_deref(), Some(copy::SOURCES_TITLE.en()));
    let status = harness.memory_label(domain_element_id("settings-state", "memory"), cx);
    assert_eq!(status.as_deref(), Some(copy::STATUS_OK.en()));
    // The lists' sub-headers count their entries; the filter shows a
    // count only while it filters (review round 10).
    assert_eq!(harness.memory_label("memory-filter-count", cx), None);

    // The filter matches the title, the text, and the tags.
    harness.type_into_memory("memory-filter-field", "STYLE", cx);
    assert_eq!(harness.entries_shown(cx), ["e1"]);
    assert_eq!(harness.memory_label("memory-filter-count", cx).as_deref(), Some("1 / 3 matching"));
    harness.type_into_memory("memory-filter-field", "nothing like it", cx);
    assert!(harness.entries_shown(cx).is_empty());
    let empty = harness.memory_label(domain_element_id("settings-empty", "memory-filter"), cx);
    assert_eq!(empty.as_deref(), Some(copy::FILTER_EMPTY.en()));
    harness.click("memory-filter-empty-clear", cx);
    assert_eq!(harness.entries_shown(cx), ["e2", "e1", "e3"]);
    let editor = harness.memory(cx).read_with(cx, |page, cx| page.editor().read(cx).value());
    assert_eq!(editor, DOC, "the editor holds MEMORY.md as read");
}

#[gpui_kit::test]
fn an_entry_is_added_archived_and_restored_through_the_host(cx: &mut TestAppContext) {
    let harness = opened(cx);
    harness.click("memory-add", cx);
    harness.click("memory-add-submit", cx);
    assert!(mutations(&harness).is_empty(), "nothing sent without a title");
    assert_eq!(
        harness.memory_line("memory-entries", cx),
        Some(format!("{}. {}", copy::EMPTY_TITLE.en(), copy::EMPTY_TITLE_DETAIL.en()))
    );

    harness.type_into_memory("memory-add-title", "  Preference\n two ", cx);
    let page = harness.memory(cx);
    harness.with_window(cx, |window, cx| {
        let content = page.read(cx).content_input().clone();
        content.update(cx, |input, cx| input.set_value("  Use concise answers.  ", window, cx));
    });
    harness.transport.reply("memory.query", Ok(state('a', DOC, 2, 1)));
    harness.transport.reply(
        "memory.mutate",
        Ok(json!({"kind": "committed", "revision": rev('c'), "memoryRevision": rev('d'),
                  "pendingRevision": null})),
    );
    snapshot(&harness.transport, 'c', DOC);
    harness.click("memory-add-submit", cx);
    assert_eq!(
        mutations(&harness),
        [json!({"kind": "remember", "expectedRevision": rev('a'), "title": "Preference two",
                "content": "Use concise answers.", "scope": {"kind": "workspace"}})]
    );
    assert_eq!(
        harness.memory_line("memory-entries", cx).as_deref(),
        Some("Memory added: Preference two")
    );
    let title = page.read_with(cx, |page, cx| page.title_input().read(cx).value());
    assert_eq!(title, "", "the form empties once added");

    // Archive: a conflict reads the state again and retries.
    harness.transport.reply("memory.query", Ok(state('c', DOC, 2, 1)));
    harness.transport.reply(
        "memory.mutate",
        Ok(json!({"kind": "revision_conflict", "expectedRevision": rev('c'),
                  "actualRevision": rev('e')})),
    );
    harness.transport.reply("memory.query", Ok(state('e', DOC, 2, 1)));
    harness.transport.reply(
        "memory.mutate",
        Ok(json!({"kind": "unchanged", "revision": rev('e'), "memoryRevision": null,
                  "pendingRevision": null})),
    );
    snapshot(&harness.transport, 'e', DOC);
    harness.click(domain_element_id("memory-entry-status", "e1"), cx);
    let archive = |bundle: char| {
        json!({"kind": "set_status", "expectedRevision": rev(bundle), "entryId": "e1",
               "status": "archived"})
    };
    assert_eq!(mutations(&harness)[1..], [archive('c'), archive('e')]);
    assert_eq!(
        harness.memory_line("memory-entries", cx).as_deref(),
        Some("Memory archived: Preference")
    );

    // A rejection says why; the list is read again all the same.
    harness.transport.reply("memory.query", Ok(state('e', DOC, 2, 1)));
    harness
        .transport
        .reply("memory.mutate", Ok(json!({"kind": "rejected", "reason": "not_found"})));
    snapshot(&harness.transport, 'e', DOC);
    harness.click(domain_element_id("memory-entry-status", "e3"), cx);
    assert_eq!(
        mutations(&harness).last(),
        Some(&json!({"kind": "set_status", "expectedRevision": rev('e'), "entryId": "e3",
                     "status": "active"}))
    );
    assert_eq!(
        harness.memory_line("memory-entries", cx),
        Some(format!("{}. {}", copy::ENTRY_RESTORE_FAILED.en(), copy::RESULT_NOT_FOUND.en()))
    );
}

#[gpui_kit::test]
fn memory_md_is_saved_by_upload_and_a_backup_restored_after_the_question(cx: &mut TestAppContext) {
    let harness = opened(cx);
    harness.click("memory-details", cx);
    let page = harness.memory(cx);
    let draft = format!("{DOC}\n## New\nA new fact.\n");
    harness.with_window(cx, |window, cx| {
        let editor = page.read(cx).editor().clone();
        editor.update(cx, |editor, cx| editor.set_value(draft.clone(), window, cx));
    });
    assert_eq!(harness.memory_label("memory-dirty", cx).as_deref(), Some(copy::DIRTY.en()));

    harness.transport.reply("memory.query", Ok(state('a', DOC, 2, 1)));
    harness.transport.reply(
        "memory.mutate",
        Ok(json!({"kind": "upload_opened", "uploadId": "u1", "nextOffset": 0})),
    );
    harness.transport.reply(
        "memory.mutate",
        Ok(json!({"kind": "chunk_accepted", "uploadId": "u1", "nextOffset": draft.len()})),
    );
    harness.transport.reply(
        "memory.mutate",
        Ok(json!({"kind": "committed", "revision": rev('c'), "memoryRevision": rev('d'),
                  "pendingRevision": null})),
    );
    snapshot(&harness.transport, 'c', &draft);
    harness.click("memory-save", cx);
    assert_eq!(
        mutations(&harness),
        [
            json!({"kind": "replace_begin", "expectedRevision": rev('a'),
                   "totalBytes": draft.len(),
                   "contentSha256": memory_content_revision(draft.as_bytes())}),
            json!({"kind": "replace_chunk", "uploadId": "u1", "offset": 0,
                   "chunkBase64": base64(&draft)}),
            json!({"kind": "replace_commit", "uploadId": "u1"}),
        ]
    );
    assert_eq!(harness.memory_label("memory-dirty", cx).as_deref(), Some(copy::SAVED_DRAFT.en()));
    assert_eq!(
        harness.memory_line("memory-document", cx),
        Some(format!(
            "{}. 2 active entries / 1 archived entry; the previous version was backed up.",
            copy::SAVED_FILE.en()
        ))
    );

    // An upload that breaks on the way is aborted.
    let broken = format!("{draft}more\n");
    harness.with_window(cx, |window, cx| {
        let editor = page.read(cx).editor().clone();
        editor.update(cx, |editor, cx| editor.set_value(broken.clone(), window, cx));
    });
    harness.transport.reply("memory.query", Ok(state('c', &draft, 2, 1)));
    harness.transport.reply(
        "memory.mutate",
        Ok(json!({"kind": "upload_opened", "uploadId": "u2", "nextOffset": 0})),
    );
    harness
        .transport
        .reply("memory.mutate", Ok(json!({"kind": "rejected", "reason": "upload_conflict"})));
    harness
        .transport
        .reply("memory.mutate", Ok(json!({"kind": "upload_aborted", "uploadId": "u2"})));
    snapshot(&harness.transport, 'c', &draft);
    harness.click("memory-save", cx);
    assert_eq!(
        mutations(&harness).last(),
        Some(&json!({"kind": "replace_abort", "uploadId": "u2"}))
    );
    assert_eq!(
        harness.memory_line("memory-document", cx),
        Some(format!("{}. {}", copy::SAVE_FAILED.en(), copy::RESULT_UPLOAD_CONFLICT.en()))
    );
    let kept = page.read_with(cx, |page, cx| page.editor().read(cx).value());
    assert_eq!(kept, broken, "a refused save keeps the draft");

    // Restore asks first, then names the backup's revision.
    let sent = mutations(&harness).len();
    harness.click(domain_element_id("memory-backup-restore", "save"), cx);
    assert_eq!(mutations(&harness).len(), sent, "nothing before the answer");
    harness.transport.reply("memory.query", Ok(state('c', &draft, 2, 1)));
    harness.transport.reply(
        "memory.mutate",
        Ok(json!({"kind": "committed", "revision": rev('f'), "memoryRevision": rev('d'),
                  "pendingRevision": null})),
    );
    snapshot(&harness.transport, 'f', DOC);
    harness.with_window(cx, |window, cx| window.click("ok", cx));
    assert_eq!(
        mutations(&harness).last(),
        Some(&json!({"kind": "restore_backup", "expectedRevision": rev('c'), "backupKind": "save",
                     "expectedBackupRevision": rev('b')}))
    );
    let restored = page.read_with(cx, |page, cx| page.editor().read(cx).value());
    assert_eq!(restored, DOC, "the draft is the restored file");

    // Reset keeps a backup, so it does not ask.
    harness.transport.reply("memory.query", Ok(state('f', DOC, 2, 1)));
    harness.transport.reply(
        "memory.mutate",
        Ok(json!({"kind": "committed", "revision": rev('g'), "memoryRevision": rev('d'),
                  "pendingRevision": null})),
    );
    snapshot(&harness.transport, 'g', DOC);
    page.update(cx, |page, cx| page.reset(cx));
    cx.run_until_parked();
    assert_eq!(
        mutations(&harness).last(),
        Some(&json!({"kind": "reset", "expectedRevision": rev('f')}))
    );
    assert_eq!(
        harness.memory_line("memory-document", cx),
        Some(format!("{}. {}", copy::RESET_DONE.en(), copy::RESET_DONE_DETAIL.en()))
    );
}

#[gpui_kit::test]
fn open_hands_only_a_file_that_is_there_to_the_system(cx: &mut TestAppContext) {
    let harness = opened(cx);
    let opened: Rc<RefCell<Vec<PathBuf>>> = Rc::default();
    let seen = opened.clone();
    harness.memory(cx).update(cx, |page, _| {
        page.set_opener(move |path, _| seen.borrow_mut().push(path.to_owned()))
    });
    harness.click("memory-details", cx);
    // The harness's State Root has no memory directory.
    harness.click("memory-open-file", cx);
    assert!(opened.borrow().is_empty());
    assert_eq!(
        harness.memory_line("memory-document", cx),
        Some(format!("{}. {}", copy::OPEN_FAILED.en(), copy::RESULT_FILE_NOT_FOUND.en()))
    );
}

#[gpui_kit::test]
fn the_switches_write_the_memory_policy_and_the_preview_follows_the_draft(cx: &mut TestAppContext) {
    let harness = opened(cx);
    harness.click("memory-details", cx);
    let inject =
        |harness: &Harness, cx: &mut TestAppContext| harness.memory_label("memory-inject", cx);
    assert_eq!(
        inject(&harness, cx).as_deref(),
        Some(copy::WILL_NOT_INJECT.en()),
        "not readable yet"
    );
    let blocked =
        harness.with_window(cx, |window, _| window.try_find("memory-preview-blocked").is_some());
    assert!(blocked, "says why");
    let preview = harness.memory_label("memory-preview", cx);
    assert_eq!(
        preview.as_deref(),
        Some("## Preference\nTags: style\nUse concise answers.\n\n## Editor\nUses Zed."),
        "active entries only"
    );

    harness
        .transport
        .reply("runtime.policy.mutate", Ok(json!({"kind": "committed", "revision": 4})));
    snapshot(&harness.transport, 'a', DOC);
    harness.click(domain_element_id("settings-toggle", "memory-agent-read"), cx);
    let set_memory = |revision: u64, enabled: bool, read: bool| {
        json!({"expectedRevision": revision, "operation": {"kind": "set_memory",
               "value": {"enabled": enabled, "agentReadEnabled": read}}})
    };
    assert_eq!(harness.transport.requests("runtime.policy.mutate"), [set_memory(3, true, true)]);
    assert_eq!(inject(&harness, cx).as_deref(), Some(copy::WILL_INJECT.en()));

    // The preview is of the draft, as it is typed.
    let page = harness.memory(cx);
    harness.with_window(cx, |window, cx| {
        let editor = page.read(cx).editor().clone();
        editor.update(cx, |editor, cx| editor.set_value("## Only\nThis one.", window, cx));
    });
    assert_eq!(harness.memory_label("memory-preview", cx).as_deref(), Some("## Only\nThis one."));

    // Off: memory reads as blocked, and the entries' actions wait.
    harness
        .transport
        .reply("runtime.policy.mutate", Ok(json!({"kind": "committed", "revision": 5})));
    harness.transport.reply("memory.query", Ok(json!({"kind": "blocked", "reason": "disabled"})));
    harness.click(domain_element_id("settings-toggle", "memory-enabled"), cx);
    assert_eq!(harness.transport.requests("runtime.policy.mutate")[1], set_memory(4, false, true));
    let status = harness.memory_label(domain_element_id("settings-state", "memory"), cx);
    assert_eq!(status.as_deref(), Some(copy::STATUS_DISABLED.en()));
    harness.click("memory-add", cx);
    let form = harness.with_window(cx, |window, _| window.try_find("memory-add-title").is_some());
    assert!(!form, "adding waits for memory to be on");
}

#[gpui_kit::test]
fn incognito_withholds_memory(cx: &mut TestAppContext) {
    let transport = Arc::new(ScriptedHost::default());
    let mut incognito = policy(3, "ask");
    incognito["policy"]["privacy"]["incognitoActive"] = json!(true);
    transport.reply("runtime.policy.query", Ok(incognito));
    transport.reply("memory.query", Ok(json!({"kind": "blocked", "reason": "incognito_active"})));
    let harness = Harness::open_with_transport(SettingsSection::Memory, transport, cx);
    let status = harness.memory_label(domain_element_id("settings-state", "memory"), cx);
    assert_eq!(status.as_deref(), Some(copy::STATUS_INCOGNITO.en()));
    assert_eq!(harness.transport.requests("memory.query"), [json!({"kind": "state"})]);
    let empty = harness.memory_label(domain_element_id("settings-empty", "memory-entries"), cx);
    assert_eq!(empty.as_deref(), Some(copy::WAITING_ENTRY.en()));
}

#[gpui_kit::test]
fn the_memory_md_editor_wraps_a_long_line_inside_its_box(cx: &mut TestAppContext) {
    let harness = opened(cx);
    harness.click("memory-details", cx);
    let page = harness.memory(cx);
    let height = |text: String, cx: &mut TestAppContext| {
        harness.with_window(cx, |window, cx| {
            let editor = page.read(cx).editor().clone();
            editor.update(cx, |editor, cx| editor.set_value(text, window, cx));
        });
        harness.with_window(cx, |window, _| window.find("memory-editor-field").bounds())
    };
    let short = (0..12).map(|n| format!("line {n}")).collect::<Vec<_>>().join("\n");
    let rows = height(short.clone(), cx);
    // The same twelve lines, the last a front-matter line far wider than
    // the box: it wraps onto rows of its own instead of running past the
    // edge, so the box grows.
    let long = format!("{short} <!-- maka-memory: {} -->", "id=mem-f60dd2c4e178c850 ".repeat(12));
    let wrapped = height(long, cx);
    assert!(wrapped.size.height > rows.size.height, "{wrapped:?} {rows:?}");
    assert_eq!(wrapped.size.width, rows.size.width);
}

#[gpui_kit::test]
fn command_f_focuses_the_filter_once_entries_are_listed(cx: &mut TestAppContext) {
    let harness = opened(cx);
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("memory-filter-field").is_some());
    });
    let filter = harness.view.read_with(cx, |view, cx| view.memory().read(cx).search_field(cx));
    crate::tests::command_f_focuses(&harness, &filter.expect("the filter shows"), cx);
}
