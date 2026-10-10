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

//! The workbar's Side chat in the window: opened from [+] and ⌥⌘S, kept
//! across task switches, closed with Desktop's confirmation, gone with its
//! deleted task (not an archived one), and fed quotes from a selection in
//! the task's conversation by ⌥⌘S and the transcript's context menu.

use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{ElementId, Entity, TestAppContext, point, px};
use serde_json::{Value, json};
use settings::AppPreferences;
use shared::copy::side_chat as copy;

use conversation::{SideChat, SideChatLedger};

use crate::chrome_tests::row;
use crate::search_tests::open_with_a_needle;
use crate::tests::{Harness, ScriptedHost, frame, session, settle};

/// A settled Turn of a task, as `session.turns.query` lists it.
fn completed(turn: &str, first: u64) -> Value {
    json!({
        "turnId": turn, "firstSequence": first,
        "latestState": {"sequence": first + 2, "message": {
            "type": "turn_state", "id": format!("{turn}-end"), "turnId": turn, "ts": first + 2,
            "status": "completed"
        }},
        "userPromptPreview": null
    })
}

/// Tasks s1 and s2; s1's reply holds a needle, and its Turn t1 completed.
fn bench(cx: &mut TestAppContext) -> Harness {
    let transport = ScriptedHost::new(vec![
        session("s1", "Alpha", "/work/demo", "active"),
        session("s2", "Beta", "/work/demo", "active"),
    ]);
    transport.answer_gets();
    transport.set_turns("s1", vec![completed("t1", 1)]);
    transport.reply("subscription.open", Ok(open_with_a_needle("s1")));
    let harness = Harness::with_transport(transport, cx);
    harness.with_window(cx, |window, cx| window.click(row("s1"), cx));
    harness
}

fn side_chats(harness: &Harness, cx: &mut TestAppContext) -> Vec<Entity<SideChat>> {
    harness.workbench.read_with(cx, |workbench, cx| workbench.side_chats(cx))
}

/// The strip's side chat tabs: key, name, showing. (The task's Changes
/// face is open too, as it is by default.)
fn tabs(harness: &Harness, cx: &mut TestAppContext) -> Vec<(String, String, bool)> {
    let tabs = harness.workbench.read_with(cx, |workbench, cx| workbench.strip_tabs(cx));
    tabs.into_iter().filter(|(key, _, _)| key.starts_with("side-chat:")).collect()
}

/// The draft of side chat `chat`'s composer.
fn side_draft(harness: &Harness, chat: &Entity<SideChat>, cx: &mut TestAppContext) -> ElementId {
    let id = chat.read_with(cx, |chat, _| chat.id().clone());
    harness.workbench.read_with(cx, |workbench, cx| {
        let panel = workbench.side_chat_panel(&id, cx).expect("a panel");
        let draft = panel.read(cx).composer().read(cx).draft().entity_id();
        ("input", draft).into()
    })
}

/// Opens a side chat from the workbar's [+] menu.
fn add_side_chat(harness: &Harness, cx: &mut TestAppContext) {
    if !harness.workbench.read_with(cx, |workbench, cx| workbench.workbar_shown(cx)) {
        harness.with_window(cx, |window, cx| window.press("cmd-alt-s", cx));
        return;
    }
    harness.with_window(cx, |window, cx| window.click("workbar-add", cx));
    harness.with_window(cx, |window, cx| window.click("menu-item:workbar-tool-side-chat", cx));
}

/// Types `text` in `chat`'s composer and presses Enter.
fn send_in(harness: &Harness, chat: &Entity<SideChat>, text: &str, cx: &mut TestAppContext) {
    let draft = side_draft(harness, chat, cx);
    harness.with_window(cx, |window, cx| {
        window.click(draft.clone(), cx);
        window.input(text, cx);
    });
    harness.with_window(cx, |window, cx| window.press("enter", cx));
    settle(cx);
}

fn fork_of(chat: &Entity<SideChat>, cx: &mut TestAppContext) -> Option<String> {
    chat.read_with(cx, |chat, _| chat.fork_id().map(ToString::to_string))
}

/// The catalog changed: the window reads it again.
fn catalog_changed(harness: &Harness, cx: &mut TestAppContext) {
    harness.push(
        frame(json!({"kind": "session.catalog.changed", "revision": 9, "sessionId": "s1"})),
        cx,
    );
    harness.with_window(cx, |_, _| {});
}

#[gpui_kit::test]
fn command_option_s_opens_a_side_chat_and_toggles_it(cx: &mut TestAppContext) {
    let harness = bench(cx);
    harness.with_window(cx, |window, cx| window.press("cmd-alt-s", cx));
    let chats = side_chats(&harness, cx);
    assert_eq!(chats.len(), 1);
    assert_eq!(
        tabs(&harness, cx),
        [(
            format!("side-chat:{}", chats[0].read_with(cx, |chat, _| chat.id().clone())),
            copy::SIDE_CHAT.en().to_owned(),
            true
        )]
    );
    let draft = side_draft(&harness, &chats[0], cx);
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find(draft.clone()).focused(), Some(true), "ready to write");
        assert!(window.find("side-chat-empty").visible(), "nothing of its own yet");
    });
    // Again: the panel hides; again: the same side chat shows.
    harness.with_window(cx, |window, cx| window.press("cmd-alt-s", cx));
    assert!(!harness.workbench.read_with(cx, |workbench, cx| workbench.workbar_shown(cx)));
    harness.with_window(cx, |window, cx| window.press("cmd-alt-s", cx));
    assert_eq!(side_chats(&harness, cx), chats, "the same side chat, not a new one");
    // [+] adds a second, numbered.
    add_side_chat(&harness, cx);
    let names: Vec<String> = tabs(&harness, cx).into_iter().map(|(_, name, _)| name).collect();
    assert_eq!(names, ["Side chat", "Side chat 2"]);
}

#[gpui_kit::test]
fn the_new_tasks_draft_has_no_side_chat(cx: &mut TestAppContext) {
    let harness = bench(cx);
    harness.with_window(cx, |window, cx| window.press("cmd-n", cx));
    assert!(harness.drafting(cx));
    harness.with_window(cx, |window, cx| window.press("cmd-alt-s", cx));
    assert!(side_chats(&harness, cx).is_empty());
    harness.with_window(cx, |window, _| {
        let note = window.find_all("notification");
        assert!(!note.is_empty(), "a note says why");
    });
}

#[gpui_kit::test]
fn switching_tasks_keeps_a_side_chat_and_coming_back_shows_it(cx: &mut TestAppContext) {
    let harness = bench(cx);
    add_side_chat(&harness, cx);
    let chat = side_chats(&harness, cx).remove(0);
    send_in(&harness, &chat, "What is the needle for?", cx);
    let fork = fork_of(&chat, cx).expect("the first send made the fork");
    // A draft left behind in it.
    let draft = side_draft(&harness, &chat, cx);
    harness.with_window(cx, |window, cx| {
        window.click(draft.clone(), cx);
        window.input("and then", cx);
    });

    harness.with_window(cx, |window, cx| window.click(row("s2"), cx));
    assert!(side_chats(&harness, cx).is_empty(), "s2 has none");
    assert!(tabs(&harness, cx).iter().all(|(key, _, _)| !key.starts_with("side-chat:")));
    // The fork lives on meanwhile, hidden from the list.
    harness.with_window(cx, |window, _| {
        assert!(window.try_find(row(&fork)).is_none());
    });
    assert!(harness.transport.requests("session.remove").is_empty());

    harness.with_window(cx, |window, cx| window.click(row("s1"), cx));
    let back = side_chats(&harness, cx);
    assert_eq!(back, std::slice::from_ref(&chat), "the same side chat");
    assert_eq!(fork_of(&chat, cx).as_deref(), Some(fork.as_str()));
    let shown: Vec<bool> = tabs(&harness, cx).into_iter().map(|(_, _, shown)| shown).collect();
    assert_eq!(shown, [true], "its face shows");
    let text = harness.workbench.read_with(cx, |workbench, cx| {
        let id = chat.read(cx).id().clone();
        let panel = workbench.side_chat_panel(&id, cx).expect("panel");
        panel.read(cx).composer().read(cx).draft().read(cx).value().to_string()
    });
    assert_eq!(text, "and then", "its draft kept");
}

#[gpui_kit::test]
fn closing_a_side_chat_with_a_conversation_asks_then_removes_its_fork(cx: &mut TestAppContext) {
    let harness = bench(cx);
    add_side_chat(&harness, cx);
    let chat = side_chats(&harness, cx).remove(0);
    send_in(&harness, &chat, "Explain", cx);
    let fork = fork_of(&chat, cx).expect("fork");
    let key = format!("side-chat:{}", chat.read_with(cx, |chat, _| chat.id().clone()));
    let close = shared::domain_element_id("workbar-tab-close", &key);

    harness.with_window(cx, |window, cx| window.click(close.clone(), cx));
    harness.with_window(cx, |window, _| {
        assert_eq!(
            window.find(shared::dialog::DIALOG_TITLE_ID).label(),
            Some(copy::CLOSE_TITLE.en())
        );
    });
    // Cancel keeps it.
    harness.with_window(cx, |window, cx| window.click("cancel", cx));
    assert_eq!(side_chats(&harness, cx).len(), 1);
    assert!(harness.transport.requests("session.remove").is_empty());

    harness.with_window(cx, |window, cx| window.click(close.clone(), cx));
    harness.with_window(cx, |window, cx| window.click("side-chat-dont-ask", cx));
    harness.with_window(cx, |window, cx| window.click("ok", cx));
    settle(cx);
    assert!(side_chats(&harness, cx).is_empty(), "its tab went");
    assert_eq!(
        harness.transport.requests("session.remove"),
        [json!({"sessionId": fork, "expectedRevision": 2})],
        "its fork removed"
    );
    let held = cx.update(|cx| SideChatLedger::global(cx).read(cx).holds(&fork));
    assert!(!held, "the ledger settled it");
    assert!(cx.update(|cx| AppPreferences::current(cx).side_chat_close_unconfirmed));

    // Not asked again.
    add_side_chat(&harness, cx);
    let second = side_chats(&harness, cx).remove(0);
    send_in(&harness, &second, "Again", cx);
    let key = format!("side-chat:{}", second.read_with(cx, |chat, _| chat.id().clone()));
    harness.with_window(cx, |window, cx| {
        window.click(shared::domain_element_id("workbar-tab-close", &key), cx)
    });
    settle(cx);
    assert!(side_chats(&harness, cx).is_empty());
    assert_eq!(harness.transport.requests("session.remove").len(), 2);
}

#[gpui_kit::test]
fn deleting_the_task_disposes_of_its_side_chats_and_archiving_does_not(cx: &mut TestAppContext) {
    let harness = bench(cx);
    add_side_chat(&harness, cx);
    let chat = side_chats(&harness, cx).remove(0);
    send_in(&harness, &chat, "Explain", cx);
    let fork = fork_of(&chat, cx).expect("fork");

    // Archived, the task is still listed: its side chat stays.
    let mut sessions = harness.transport.sessions();
    for session in &mut sessions {
        if session["id"] == "s1" {
            session["isArchived"] = json!(true);
        }
    }
    harness.transport.set_sessions(sessions.clone());
    catalog_changed(&harness, cx);
    assert!(harness.transport.requests("session.remove").is_empty());
    assert!(!chat.read_with(cx, |chat, _| chat.is_disposed()));

    // Deleted: it goes with its fork.
    sessions.retain(|session| session["id"] != "s1");
    harness.transport.set_sessions(sessions);
    catalog_changed(&harness, cx);
    settle(cx);
    assert!(chat.read_with(cx, |chat, _| chat.is_disposed()));
    assert_eq!(
        harness.transport.requests("session.remove"),
        [json!({"sessionId": fork, "expectedRevision": 2})]
    );
}

/// Drags across the needle reply of s1.
fn select_the_reply(harness: &Harness, cx: &mut TestAppContext) -> ElementId {
    let reply: ElementId =
        conversation::item_element_id("t1", &transcript_model::ItemKey::Text("t1-a".into()));
    harness.with_window(cx, |window, cx| {
        let bounds = window.find(reply.clone()).bounds();
        let y = bounds.top() + px(10.);
        window.drag(point(bounds.left() + px(2.), y), point(bounds.right() - px(2.), y), cx);
    });
    reply
}

#[gpui_kit::test]
fn command_option_s_with_a_selection_stages_a_quote_and_the_send_carries_it(
    cx: &mut TestAppContext,
) {
    let harness = bench(cx);
    settle(cx);
    select_the_reply(&harness, cx);
    harness.with_window(cx, |window, cx| window.press("cmd-alt-s", cx));
    let chats = side_chats(&harness, cx);
    assert_eq!(chats.len(), 1, "a side chat opened for the quote");
    let quotes: Vec<(String, Option<String>)> = chats[0].read_with(cx, |chat, _| {
        chat.quotes()
            .iter()
            .map(|staged| (staged.quote.text.clone(), staged.quote.source_turn_id.clone()))
            .collect()
    });
    assert_eq!(quotes.len(), 1);
    assert!(quotes[0].0.contains("needle"), "{quotes:?}");
    assert_eq!(quotes[0].1.as_deref(), Some("t1"), "the selection lies in t1's reply");
    harness.with_window(cx, |window, _| {
        assert!(window.find("composer-quotes").visible(), "a chip above its draft");
    });
    send_in(&harness, &chats[0], "Why?", cx);
    let submits = harness.transport.requests("turn.message.submit");
    let submit = submits.last().expect("a send");
    assert_eq!(submit["content"]["text"], "Why?");
    assert_eq!(submit["content"]["quotes"][0]["sourceTurnId"], "t1");
    assert!(
        submit["content"]["quotes"][0]["text"].as_str().is_some_and(|text| text.contains("needle"))
    );
    assert!(chats[0].read_with(cx, |chat, _| chat.quotes().is_empty()), "the Host took it");
}

#[gpui_kit::test]
fn the_transcripts_context_menu_asks_about_the_selection_in_the_side_chat(cx: &mut TestAppContext) {
    let harness = bench(cx);
    settle(cx);
    let reply = select_the_reply(&harness, cx);
    harness.with_window(cx, |window, cx| window.right_click(reply.clone(), cx));
    harness.with_window(cx, |window, cx| window.press("down", cx));
    harness.with_window(cx, |window, cx| window.press("enter", cx));
    let chats = side_chats(&harness, cx);
    assert_eq!(chats.len(), 1);
    let texts: Vec<String> = chats[0].read_with(cx, |chat, _| {
        chat.quotes().iter().map(|staged| staged.quote.text.clone()).collect()
    });
    assert!(texts.len() == 1 && texts[0].contains("needle"), "{texts:?}");
}
