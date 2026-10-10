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

//! A side chat's face in the workbar: the fork's transcript at the
//! panel's width, its own turns only, over a composer of its own (Desktop's
//! `QuoteCompanionPanel`).

use gpui_kit::component::v_flex;
use gpui_kit::{
    AppContext as _, Context, Entity, InteractiveElement as _, IntoElement, ParentElement as _,
    Render, Styled as _, Subscription, TestSupportExt as _, Window, div,
};
use workspace::{ConnectionCatalog, ProjectSelection};

use super::SideChat;
use crate::composer::Composer;
use crate::view::ConversationView;

/// Key context of a side chat's face.
pub const SIDE_CHAT_CONTEXT: &str = "SideChat";

/// Presents a [`SideChat`]: the fork's conversation in a
/// [`ConversationView`] that hides the Turns the fork copied, and a
/// [`Composer`] that sends through the side chat. Until the side chat has
/// a conversation of its own the transcript's place is empty, as Desktop's
/// (its `emptyOverride` is a blank region): the composer is where to start.
///
/// Presentation owner only; the side chat owns the fork. Its entities live
/// as long as its workbar tab, shown or not, so a task shown again finds
/// its side chats as they were.
pub struct SideChatPanel {
    chat: Entity<SideChat>,
    conversation: Entity<ConversationView>,
    composer: Entity<Composer>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for SideChatPanel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SideChatPanel").finish_non_exhaustive()
    }
}

impl SideChatPanel {
    pub fn new(
        chat: Entity<SideChat>,
        connections: Entity<ConnectionCatalog>,
        projects: Entity<ProjectSelection>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let state = chat.read(cx).state().clone();
        let conversation = cx.new(|cx| ConversationView::new(state, cx));
        let composer =
            cx.new(|cx| Composer::for_side_chat(chat.clone(), connections, projects, window, cx));
        let subscriptions = vec![
            cx.observe(&chat, |this, _, cx| this.sync_boundary(cx)),
            cx.observe(&conversation, |_, _, cx| cx.notify()),
        ];
        let mut this = Self { chat, conversation, composer, _subscriptions: subscriptions };
        this.sync_boundary(cx);
        this
    }

    /// The side chat it presents.
    pub fn chat(&self) -> &Entity<SideChat> {
        &self.chat
    }

    /// The fork's transcript.
    pub fn conversation(&self) -> &Entity<ConversationView> {
        &self.conversation
    }

    /// Its composer.
    pub fn composer(&self) -> &Entity<Composer> {
        &self.composer
    }

    /// Moves keyboard focus into the draft.
    pub fn focus(&self, window: &mut Window, cx: &mut Context<Self>) {
        self.composer.update(cx, |composer, cx| composer.focus(window, cx));
    }

    /// The transcript hides the Turns the fork copied from its task.
    fn sync_boundary(&mut self, cx: &mut Context<Self>) {
        let boundary = self.chat.read(cx).boundary().map(str::to_owned);
        self.conversation.update(cx, |view, cx| view.set_hidden_through(boundary, cx));
        cx.notify();
    }

    /// Whether the transcript has anything of the side chat's own to show:
    /// a fork, and once its transcript is read, a row.
    fn shows_conversation(&self, cx: &gpui_kit::App) -> bool {
        let chat = self.chat.read(cx);
        chat.fork_id().is_some()
            && (chat.state().read(cx).transcript().is_none()
                || self.conversation.read(cx).has_rows())
    }
}

impl Render for SideChatPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let body = if self.shows_conversation(cx) {
            div().flex_1().min_h_0().w_full().child(self.conversation.clone()).into_any_element()
        } else {
            div()
                .id("side-chat-empty")
                .test_support()
                .flex_1()
                .min_h_0()
                .w_full()
                .into_any_element()
        };
        v_flex()
            .id(shared::domain_element_id("side-chat", self.chat.read(cx).id()))
            .test_support()
            .key_context(SIDE_CHAT_CONTEXT)
            .size_full()
            .min_w_0()
            .child(body)
            .child(self.composer.clone())
    }
}
