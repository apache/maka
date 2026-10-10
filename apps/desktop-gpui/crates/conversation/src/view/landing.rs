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

//! Opening a task at a passage a search of every task found
//! ([`ConversationView::open_at_passage`]).
//!
//! The passage names its message by id and by its 0-based index in the
//! task's transcript. The transcript keys its rows by the Host's event
//! sequences, which are not indexes, so the index names a row only once the
//! transcript holds the task's first row; the id can be looked up after
//! every page. So: read older pages, as scrolling up reads them, until the
//! message's row is held; with the whole history held and still no such
//! row, take the row at the index, then the passage's Turn. Then scroll to
//! the row and open the find bar on the passage's term, its active match
//! inside that row.

use gpui_kit::{Context, Subscription, Window};
use search::PassageTarget;

use super::ConversationView;
use crate::rows::RowKey;
use crate::state::{ConversationEvent, ConversationPhase, OlderHistory};

/// A passage waiting for its task's transcript to hold its message.
pub(crate) struct Landing {
    target: PassageTarget,
    /// Follows the state while the passage waits; dropped with it.
    _changes: Subscription,
}

impl std::fmt::Debug for Landing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Landing").field("target", &self.target).finish_non_exhaustive()
    }
}

/// What a waiting passage needs next.
#[derive(Debug, PartialEq)]
enum Step {
    /// The task is not shown yet, or a page is on its way.
    Wait,
    /// The message is older than what is held.
    ReadOlder,
    /// Show this row, or, with `None`, the task where it is; then find.
    Land(Option<RowKey>),
    /// Another task took its place, or this one cannot be shown.
    Abandon,
}

impl ConversationView {
    /// Shows `target`'s message once the transcript of its task holds it,
    /// reading older history until it does, and opens the find bar on the
    /// target's term with the active match in that message. The caller
    /// selects the task; until the state shows it, the passage waits, and a
    /// different task shown first abandons it.
    pub fn open_at_passage(
        &mut self,
        target: PassageTarget,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let changes = cx.subscribe_in(
            &self.state,
            window,
            |this, _, event: &ConversationEvent, window, cx| {
                let ConversationEvent::Changed { session_changed, .. } = event;
                this.advance_landing(*session_changed, window, cx);
            },
        );
        self.landing = Some(Landing { target, _changes: changes });
        self.advance_landing(false, window, cx);
    }

    /// Whether a passage waits for its message to be held.
    pub fn is_landing(&self) -> bool {
        self.landing.is_some()
    }

    /// Forgets the passage waiting to be shown: the plate shows something
    /// else now, and the find bar must not take focus from it.
    pub fn cancel_landing(&mut self) {
        self.landing = None;
    }

    fn advance_landing(
        &mut self,
        session_changed: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(landing) = &self.landing else { return };
        match self.landing_step(&landing.target, session_changed, cx) {
            Step::Wait => {}
            Step::ReadOlder => self.state.update(cx, |state, cx| state.load_older_history(cx)),
            Step::Abandon => self.landing = None,
            Step::Land(row) => {
                if let Some(landing) = self.landing.take() {
                    self.land(&landing.target, row, window, cx);
                }
            }
        }
    }

    fn landing_step(
        &self,
        target: &PassageTarget,
        session_changed: bool,
        cx: &Context<Self>,
    ) -> Step {
        let state = self.state.read(cx);
        if state.session_id() != Some(target.session_id()) {
            return if session_changed { Step::Abandon } else { Step::Wait };
        }
        match state.phase() {
            ConversationPhase::Live => {}
            ConversationPhase::WaitingForHost | ConversationPhase::Opening => return Step::Wait,
            _ => return Step::Abandon,
        }
        let Some(transcript) = state.transcript() else { return Step::Wait };
        // The row of the item that shows `message_id`, or, when the item
        // shows no row (a hidden Tool call), its Turn's first.
        let row_of = |message_id: &str| {
            let (turn_id, key) = transcript.item_of_message(message_id)?;
            let item = RowKey::Item { turn_id: turn_id.clone(), key };
            self.held(&item).or_else(|| self.first_row_of(&turn_id))
        };
        if let Some(row) = row_of(target.anchor_message_id()) {
            return Step::Land(Some(row));
        }
        match state.older_history() {
            OlderHistory::Available => return Step::ReadOlder,
            OlderHistory::Loading => return Step::Wait,
            // The first row is held, or no more can be read.
            OlderHistory::None | OlderHistory::Reached | OlderHistory::Failed(_) => {}
        }
        let by_index = usize::try_from(target.sequence())
            .ok()
            .and_then(|index| transcript.message_id_at(index))
            .and_then(row_of);
        let by_turn = || target.turn_id().and_then(|turn_id| self.first_row_of(turn_id));
        Step::Land(by_index.or_else(by_turn))
    }

    /// `row` when the transcript shows it.
    fn held(&self, row: &RowKey) -> Option<RowKey> {
        self.rows.iter().any(|shown| shown.key == *row).then(|| row.clone())
    }

    fn first_row_of(&self, turn_id: &str) -> Option<RowKey> {
        self.rows.iter().find(|row| row.key.is_of_turn(turn_id)).map(|row| row.key.clone())
    }

    /// Scrolls `row` to the top and finds the target's term with its active
    /// match in `row`.
    fn land(
        &mut self,
        target: &PassageTarget,
        row: Option<RowKey>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(ix) = row.as_ref().and_then(|row| self.rows.iter().position(|r| r.key == *row))
        {
            self.paging.cancel();
            self.scroller.update(cx, |scroller, cx| scroller.scroll_to_item(ix, cx));
        }
        if let Some(term) = target.term() {
            self.open_find_with(term.clone(), row, window, cx);
        }
        cx.notify();
    }
}
