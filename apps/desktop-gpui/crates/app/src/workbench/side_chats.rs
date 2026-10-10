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

//! The workbar's Side chat faces: each task's side chats
//! ([`conversation::SideChat`]), how they open, show, close and go with
//! their task (Desktop's `side-chat` tool, `use-workbar-controller.ts`).
//!
//! A side chat belongs to the task it talks about and lives while the app
//! runs: switching tasks keeps it (only the selected task's side chats
//! have tabs), and coming back shows it as it was. It goes when its tab
//! closes (asking first when it has a conversation, unless the person said
//! not to ask again) and when its task is deleted, not archived: its fork's
//! runs are stopped and the fork removed. Tabs are numbered as Desktop's:
//! "Side chat", "Side chat 2", one past the highest the task's open side
//! chats carry.
//!
//! ⌥⌘S shows the task's side chat (the one last shown, or a new one when
//! the task has none) or hides the panel while it shows one; with text
//! selected in the task's conversation it stages the text as a quote in
//! that side chat instead, as the transcript's "Ask in side chat" does.
//! A task with no message yet (the new task's draft) has nothing to fork:
//! it says so (Desktop's `sideChatUnavailable`).

use std::cell::Cell;
use std::collections::{BTreeSet, HashMap};
use std::rc::Rc;

use conversation::{SideChat, SideChatLedger, SideChatPanel};
use gpui_kit::base::TextSelection;
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::notification::Notification;
use gpui_kit::component::{WindowExt as _, v_flex};
use gpui_kit::{
    App, AppContext as _, Context, Entity, ParentElement as _, SharedString, Styled as _, Window,
};
use host_protocol::QuoteRef;
use session::LoadState;
use settings::AppPreferences;
use shared::copy::{self as shell_copy, side_chat as copy};
use shared::dialog::{DialogHeader, DialogHeaderExt as _};
use workspace::HostSessionEvent;
use workspace::actions::ToggleSideChat;

use super::Workbench;
use super::workbar::ToolKind;

/// A side chat's tab: its id and its number among its task's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SideChatTab {
    pub(crate) id: SharedString,
    pub(crate) ordinal: usize,
}

struct Entry {
    chat: Entity<SideChat>,
    panel: Entity<SideChatPanel>,
    ordinal: usize,
}

/// Every task's side chats, in the order they opened, and the one each
/// task's panel shows on its Side chat face.
#[derive(Default)]
pub(crate) struct SideChats {
    entries: Vec<Entry>,
    shown: HashMap<SharedString, SharedString>,
}

impl SideChats {
    fn of<'a>(&'a self, task: &str, cx: &App) -> Vec<&'a Entry> {
        self.entries.iter().filter(|entry| entry.chat.read(cx).source().as_ref() == task).collect()
    }

    fn get<'a>(&'a self, id: &str, cx: &App) -> Option<&'a Entry> {
        self.entries.iter().find(|entry| entry.chat.read(cx).id().as_ref() == id)
    }

    /// Task `task`'s tabs, in the order they opened.
    pub(crate) fn tabs_of(&self, task: &str, cx: &App) -> Vec<SideChatTab> {
        self.of(task, cx)
            .into_iter()
            .map(|entry| SideChatTab {
                id: entry.chat.read(cx).id().clone(),
                ordinal: entry.ordinal,
            })
            .collect()
    }

    /// The side chat task `task`'s panel shows: the one last shown, else its
    /// newest.
    fn shown_of<'a>(&'a self, task: &str, cx: &App) -> Option<&'a Entry> {
        let shown = self.shown.get(task);
        let of = self.of(task, cx);
        of.iter()
            .find(|entry| Some(entry.chat.read(cx).id()) == shown)
            .or_else(|| of.last())
            .copied()
    }
}

impl Workbench {
    /// The selected task's side chats, in the order they opened.
    pub fn side_chats(&self, cx: &App) -> Vec<Entity<SideChat>> {
        let Some(task) = self.selected_task(cx) else { return Vec::new() };
        self.workbar.side_chats.of(&task, cx).into_iter().map(|entry| entry.chat.clone()).collect()
    }

    /// The panel of side chat `id`.
    pub fn side_chat_panel(&self, id: &str, cx: &App) -> Option<Entity<SideChatPanel>> {
        self.workbar.side_chats.get(id, cx).map(|entry| entry.panel.clone())
    }

    /// Whether the selected task has a side chat.
    pub(super) fn side_chat_face_open(&self, cx: &App) -> bool {
        self.selected_task(cx).is_some_and(|task| !self.workbar.side_chats.of(&task, cx).is_empty())
    }

    /// The id of the side chat the selected task's panel shows on its Side
    /// chat face.
    pub(super) fn shown_side_chat_id(&self, cx: &App) -> Option<SharedString> {
        let task = self.selected_task(cx)?;
        self.workbar.side_chats.shown_of(&task, cx).map(|entry| entry.chat.read(cx).id().clone())
    }

    /// Its panel.
    pub(super) fn shown_side_chat_panel(&self, cx: &App) -> Option<Entity<SideChatPanel>> {
        let task = self.selected_task(cx)?;
        self.workbar.side_chats.shown_of(&task, cx).map(|entry| entry.panel.clone())
    }

    /// Gives the shown side chat's composer the focus.
    pub(super) fn focus_side_chat(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(panel) = self.shown_side_chat_panel(cx) {
            panel.update(cx, |panel, cx| panel.focus(window, cx));
        }
    }

    /// Opens a new side chat about the selected task and shows it, its
    /// composer focused. Nothing without a task.
    pub(super) fn new_side_chat(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Entity<SideChat>> {
        let task = self.selected_task(cx)?;
        let host = self.host.clone();
        let chat = cx.new(|cx| SideChat::new(task.clone(), host, cx));
        let (connections, projects) = (self.connections.clone(), self.projects.clone());
        let panel =
            cx.new(|cx| SideChatPanel::new(chat.clone(), connections, projects, window, cx));
        // Desktop's `reserveOrdinal`: one past the highest the task's open
        // side chats carry.
        let ordinal = self
            .workbar
            .side_chats
            .of(&task, cx)
            .iter()
            .map(|entry| entry.ordinal)
            .max()
            .unwrap_or(0)
            + 1;
        self._subscriptions.push(cx.observe(&chat, |_, _, cx| cx.notify()));
        let id = chat.read(cx).id().clone();
        self.workbar.side_chats.entries.push(Entry { chat: chat.clone(), panel, ordinal });
        self.show_side_chat(&id, window, cx);
        Some(chat)
    }

    /// Shows side chat `id` of the selected task, the panel open and its
    /// composer focused.
    pub(super) fn show_side_chat(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(task) = self.selected_task(cx) else { return };
        if self.workbar.side_chats.get(id, cx).is_none() {
            return;
        }
        if self.page.is_some() {
            self.leave_page(Some(task.clone()), window, cx);
        }
        self.workbar.side_chats.shown.insert(task, id.to_owned().into());
        self.set_workbar_face(ToolKind::SideChat, cx);
        if !self.workbar_open(cx) {
            self.set_workbar_open(true, window, cx);
        }
        self.focus_side_chat(window, cx);
        cx.notify();
    }

    /// ⌥⌘S (Desktop's `toggleTool('side-chat')`): with text selected in
    /// the task's conversation, stages it as a quote in the task's side
    /// chat; otherwise shows the task's side chat (a new one when it has
    /// none), or hides the panel while it shows one. Behind settings,
    /// nothing; for the new task's draft, a note that a side chat needs a
    /// task first.
    pub(crate) fn toggle_side_chat(
        &mut self,
        _: &ToggleSideChat,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.settings.is_some() {
            return;
        }
        if self.selected_task(cx).is_none() {
            window.push_notification(
                Notification::info(copy::UNAVAILABLE_BODY.get(cx)).title(copy::UNAVAILABLE.get(cx)),
                cx,
            );
            return;
        }
        if self.page.is_none()
            && let Some((text, turn)) = self.conversation_selection(window, cx)
        {
            TextSelection::clear(window, cx);
            self.stage_side_quote(text, turn, window, cx);
            return;
        }
        if self.workbar_shown(cx) && self.shown_face(cx) == ToolKind::SideChat {
            self.set_workbar_open(false, window, cx);
            self.composer.update(cx, |composer, cx| composer.focus(window, cx));
            return;
        }
        match self.shown_side_chat_id(cx) {
            Some(id) => self.show_side_chat(&id, window, cx),
            None => {
                self.new_side_chat(window, cx);
            }
        }
    }

    /// The text selected in the task's conversation, its whitespace folded
    /// (Desktop's `normalizeQuoteText`), and the Turn whose replies hold
    /// all of it; `None` unless the conversation's replies hold the
    /// window's selection (text selected in a side chat, the Files face or
    /// anywhere else is not a quote of the task).
    fn conversation_selection(
        &self,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<(String, Option<SharedString>)> {
        if !self.conversation.read(cx).holds_selection(cx) {
            return None;
        }
        let selected = TextSelection::selected_text(window, cx);
        let folded = selected.split_whitespace().collect::<Vec<_>>().join(" ");
        if folded.is_empty() {
            return None;
        }
        let turn = self.conversation.read(cx).selection_turn(&selected, cx);
        Some((folded, turn))
    }

    /// Stages `text` (from Turn `turn`, when one Turn's replies hold it) as
    /// a quote in the selected task's side chat (the one shown, else a new
    /// one), and shows it with its composer focused (Desktop's
    /// `openSideChatWithQuote`).
    pub(super) fn stage_side_quote(
        &mut self,
        text: String,
        turn: Option<SharedString>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(task) = self.selected_task(cx) else { return };
        let chat = match self.workbar.side_chats.shown_of(&task, cx) {
            Some(entry) => entry.chat.clone(),
            None => match self.new_side_chat(window, cx) {
                Some(chat) => chat,
                None => return,
            },
        };
        let quote = QuoteRef::new(text).with_source_turn_id(turn.map(|turn| turn.to_string()));
        chat.update(cx, |chat, cx| chat.stage_quote(quote, cx));
        let id = chat.read(cx).id().clone();
        self.show_side_chat(&id, window, cx);
    }

    /// A side chat's ×: one with a conversation asks first (Desktop's
    /// close confirmation, with its "Don't ask again"), unless asked not
    /// to; then it goes.
    pub(super) fn close_side_chat(
        &mut self,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(entry) = self.workbar.side_chats.get(id, cx) else { return };
        let asks = entry.chat.read(cx).has_content()
            && !AppPreferences::global(cx).read(cx).is_side_chat_close_unconfirmed();
        if !asks {
            self.dispose_side_chat(id, window, cx);
            return;
        }
        let locale = shell_copy::Locale::current(cx);
        let workbench = cx.entity().downgrade();
        let id: SharedString = id.to_owned().into();
        let skip = Rc::new(Cell::new(false));
        window.open_alert_dialog(cx, move |alert, _, cx| {
            let (workbench, id, skip) = (workbench.clone(), id.clone(), skip.clone());
            let checked = skip.get();
            let toggle = skip.clone();
            shared::theme::floating_surface(alert, cx)
                .with_header(DialogHeader::new(copy::CLOSE_TITLE.in_locale(locale)))
                .description(
                    v_flex()
                        .gap_3()
                        .child(shared::dialog::confirmation_text(
                            copy::CLOSE_BODY.in_locale(locale),
                        ))
                        .child(
                            Checkbox::new("side-chat-dont-ask")
                                .label(copy::DONT_ASK_AGAIN.in_locale(locale))
                                .checked(checked)
                                .on_click(move |checked, window, _| {
                                    toggle.set(*checked);
                                    window.refresh();
                                }),
                        ),
                )
                .footer(shared::dialog::confirmation_answers(
                    shell_copy::CANCEL.in_locale(locale),
                    copy::CLOSE_CONFIRM.in_locale(locale),
                    true,
                    cx,
                ))
                .on_ok(move |_, window, cx| {
                    if skip.get() {
                        AppPreferences::global(cx).update(cx, |preferences, cx| {
                            preferences.set_side_chat_close_unconfirmed(true, cx)
                        });
                    }
                    workbench
                        .update(cx, |workbench, cx| workbench.dispose_side_chat(&id, window, cx))
                        .ok();
                    true
                })
        });
    }

    /// Side chat `id` goes: its tab, and its fork (stopped, then removed).
    /// The last face gone hides the panel.
    pub(super) fn dispose_side_chat(
        &mut self,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.drop_side_chat(id, cx);
        self.hide_empty_workbar(window, cx);
        cx.notify();
    }

    fn drop_side_chat(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(ix) = self
            .workbar
            .side_chats
            .entries
            .iter()
            .position(|entry| entry.chat.read(cx).id().as_ref() == id)
        else {
            return;
        };
        let entry = self.workbar.side_chats.entries.remove(ix);
        let task = entry.chat.read(cx).source().clone();
        if self.workbar.side_chats.shown.get(&task).is_some_and(|shown| shown.as_ref() == id) {
            self.workbar.side_chats.shown.remove(&task);
        }
        entry.chat.update(cx, |chat, cx| chat.dispose(cx)).detach();
    }

    /// Tells the app's ledger of side chats' forks about each connection of
    /// this window's Host, so it settles what an ended run left on that
    /// State Root.
    pub(super) fn watch_side_chat_ledger(&mut self, cx: &mut Context<Self>) {
        let subscription = cx.subscribe(&self.host, |this, _, event: &HostSessionEvent, cx| {
            if matches!(event, HostSessionEvent::Connected { .. }) {
                this.connect_side_chat_ledger(cx);
            }
        });
        self._subscriptions.push(subscription);
        // The Search page leaves out the forks the ledger holds.
        let ledger = SideChatLedger::global(cx);
        self._subscriptions.push(cx.observe(&ledger, |this, _, cx| this.sync_search_tasks(cx)));
        self.connect_side_chat_ledger(cx);
    }

    fn connect_side_chat_ledger(&self, cx: &mut Context<Self>) {
        let host = self.host.read(cx);
        let Some(root) = host
            .accepted()
            .filter(|_| host.is_connected())
            .map(|accepted| accepted.root_id.clone())
        else {
            return;
        };
        let requester = host.requester();
        SideChatLedger::global(cx).update(cx, |ledger, cx| ledger.connected(&root, requester, cx));
    }

    /// Once the catalog is read, the side chats of tasks it no longer lists
    /// (deleted; an archived task is still listed) go with their forks
    /// (Desktop's `retireDeletedSessionSideChats`).
    pub(super) fn retire_side_chats_of_deleted_tasks(&mut self, cx: &mut Context<Self>) {
        let catalog = self.catalog.read(cx);
        if *catalog.load_state() != LoadState::Loaded {
            return;
        }
        let listed: BTreeSet<&SharedString> = catalog.rows().iter().map(|row| &row.id).collect();
        let gone: Vec<SharedString> = self
            .workbar
            .side_chats
            .entries
            .iter()
            .filter(|entry| !listed.contains(entry.chat.read(cx).source()))
            .map(|entry| entry.chat.read(cx).id().clone())
            .collect();
        for id in gone {
            log::info!("side chat {id}: its task is gone");
            self.drop_side_chat(&id, cx);
        }
    }
}
