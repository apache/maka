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

//! What the custom pet is told about the window (Maka Desktop's app-shell.tsx
//! around `derivePetActivityState` and `onTurnCompleted`): the library of
//! the window's State Root and the pet the preferences choose; whether a
//! task is shown, waits on a question or a permission, is blocked in the
//! catalog, or runs a turn; and, for the task shown, each turn that
//! finished.
//!
//! Desktop's pulse is the session event `complete` with the stop reason
//! `end_turn` or `max_tokens`; the Host marks the same moment on
//! `session.catalog.changed` as a `completed` attention (the root Turn
//! completed), which is what this client receives, so that is the pulse.

use conversation::{ConversationEvent, ConversationState, TurnActivity};
use gpui_kit::{App, AppContext as _, Context, Entity, SharedString, Subscription};
use host_protocol::{ChangeNotice, PushFrame, SessionAttentionKind};
use pet::{PetActivityInput, PetCompanion};
use session::SessionCatalog;
use settings::AppPreferences;
use workspace::{HostSession, HostSessionEvent};

/// Behavior owner of what the window's companion shows; the companion is
/// the presentation. It lives as long as the window's workbench.
pub struct PetWatch {
    companion: Entity<PetCompanion>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for PetWatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PetWatch").finish_non_exhaustive()
    }
}

impl PetWatch {
    pub(crate) fn new(
        host: &Entity<HostSession>,
        catalog: &Entity<SessionCatalog>,
        state: &Entity<ConversationState>,
        cx: &mut Context<Self>,
    ) -> Self {
        let companion = cx.new(|_| PetCompanion::new());
        let subscriptions = vec![
            cx.observe(&AppPreferences::global(cx), {
                let host = host.clone();
                move |this, _, cx| this.sync_selection(&host, cx)
            }),
            cx.observe(catalog, {
                let state = state.clone();
                move |this, catalog, cx| this.sync_activity(&catalog, &state, cx)
            }),
            cx.subscribe(state, {
                let catalog = catalog.clone();
                move |this, state, _: &ConversationEvent, cx| {
                    this.sync_activity(&catalog, &state, cx)
                }
            }),
            cx.subscribe(host, {
                let state = state.clone();
                move |this, _, event: &HostSessionEvent, cx| {
                    let HostSessionEvent::Push(frame) = event else {
                        return;
                    };
                    let PushFrame::Change(ChangeNotice::SessionCatalogChanged {
                        session_id,
                        attention: Some(attention),
                        ..
                    }) = frame.as_ref()
                    else {
                        return;
                    };
                    let shown = state.read(cx).session_id().is_some_and(|id| id == session_id);
                    if shown && attention.kind == SessionAttentionKind::Completed {
                        this.companion.update(cx, |companion, cx| companion.turn_completed(cx));
                    }
                }
            }),
        ];
        let mut this = Self { companion, _subscriptions: subscriptions };
        this.sync_selection(host, cx);
        this.sync_activity(catalog, state, cx);
        this
    }

    pub fn companion(&self) -> &Entity<PetCompanion> {
        &self.companion
    }

    fn sync_selection(&mut self, host: &Entity<HostSession>, cx: &mut Context<Self>) {
        let root = host.read(cx).root().to_owned();
        let selected = AppPreferences::current(cx).selected_pet;
        self.companion.update(cx, |companion, cx| companion.set_selection(root, selected, cx));
    }

    fn sync_activity(
        &mut self,
        catalog: &Entity<SessionCatalog>,
        state: &Entity<ConversationState>,
        cx: &mut Context<Self>,
    ) {
        let (input, task) = activity(catalog, state, cx);
        self.companion.update(cx, |companion, cx| companion.set_activity(&input, task, cx));
    }
}

/// The shell's signals for the task shown (`PetRuntimeActivityInput`): a
/// turn is active while one runs or is being stopped (Desktop reads the
/// Host's active turn), and a pending question or permission prompt is an
/// active interaction.
fn activity(
    catalog: &Entity<SessionCatalog>,
    state: &Entity<ConversationState>,
    cx: &App,
) -> (PetActivityInput, Option<SharedString>) {
    let state = state.read(cx);
    let task = state.session_id().cloned();
    let status =
        task.as_ref().and_then(|id| catalog.read(cx).row(id)).map(|row| row.status.clone());
    let waiting =
        state.transcript().is_some_and(|transcript| !transcript.pending_interactions().is_empty());
    let running = matches!(state.turn_activity(), TurnActivity::Running | TurnActivity::Stopping);
    (PetActivityInput::new(task.is_some(), waiting, running, status), task)
}
