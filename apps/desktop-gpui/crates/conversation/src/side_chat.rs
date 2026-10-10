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

//! A side chat: a side conversation about a task, in the workbar, that
//! can read the task's history but does not change the task (Maka
//! Desktop's Side chat, `features/workbar/tools/side-chat`).
//!
//! On its first send it forks the task with `session.branch.create` and
//! the side-conversation intent: through the task's latest completed Turn,
//! or empty when none has completed ([`fork::read_boundary`]). The fork
//! inherits the task's model, permission mode and workspace; its copied
//! Turns are the model's context and show no rows ([`SideChatPanel`] hides
//! them in its transcript). Every fork is written in the app's
//! [`SideChatLedger`] before it is asked for, and removed (its runs
//! stopped first) when its side chat is disposed of.

mod fork;
mod ledger;
mod panel;

use gpui_kit::{App, AppContext as _, Context, Entity, SharedString, Subscription, Task};
use host_protocol::{
    ChangeNotice, MessageContent, MessagePlacement, PermissionMode, PushFrame,
    QUOTE_LABEL_MAX_LENGTH, QUOTE_MAX_COUNT, QUOTE_TEXT_MAX_LENGTH, QuoteRef,
    SessionConfigurationPatch, SessionConfigurationUpdate, SessionConfigurationUpdateInput,
    SessionConversationCopyInput, SessionUpdateResult,
};
use shared::copy::Locale;
use shared::copy::side_chat as copy;
use workspace::{ConnectionList, HostSession, HostSessionEvent};

use crate::attachments::PickedFile;
use crate::state::{ConversationState, SendOutcome, SessionSettings, new_session_id};

pub use ledger::{
    ForkEntry, ForkPhase, LEDGER_FILE, LedgerEdit, LedgerFile, LedgerStore, LedgerWrite,
    OWNER_LOCKS_DIRECTORY, SideChatLedger,
};
pub use panel::{SIDE_CHAT_CONTEXT, SideChatPanel};

use fork::{CreateFailure, ForkError};

/// A quote waiting for the next message, with the id its chip and its
/// remove button go by.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct StagedQuote {
    pub id: u64,
    pub quote: QuoteRef,
}

/// The fork a side chat talks to.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Fork {
    session_id: SharedString,
    /// The Turn of the task it was copied through.
    boundary: Option<String>,
}

/// Where a send that opens the fork starts.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ForkStart {
    /// A new fork, made after `replaced` is removed.
    New { replaced: Option<SharedString> },
    /// The fork an earlier send made, which failed before the fork opened
    /// (the picked mode was not set).
    Made(SharedString),
}

/// A create whose outcome is unknown: the next send sends the same one.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingFork {
    target: String,
    boundary: Option<String>,
}

/// A side chat about task `source`: its fork, its conversation state, the
/// quotes staged for its next message, and the permission mode picked
/// before the fork exists.
///
/// Behavior owner of the fork's life. It lives as long as its workbar tab:
/// across task switches (only the selected task's side chats show), until
/// its tab closes or its task is deleted, when [`Self::dispose`] stops the
/// fork's runs and removes it. Dropped without that (its window closed),
/// it leaves the fork to the ledger, which removes it then or at the next
/// connection to its root.
pub struct SideChat {
    id: SharedString,
    source: SharedString,
    host: Entity<HostSession>,
    state: Entity<ConversationState>,
    ledger: Entity<SideChatLedger>,
    /// The task's settings, from its catalog item: the model the composer
    /// shows before the fork exists, and the mode the fork starts with.
    source_settings: Option<SessionSettings>,
    fork: Option<Fork>,
    pending: Option<PendingFork>,
    /// A fork is being made for a send.
    creating: bool,
    quotes: Vec<StagedQuote>,
    next_quote: u64,
    /// The permission mode picked before the fork opens; set on the fork
    /// before its first message goes (fail closed, as Desktop's), and
    /// again on the next send when that failed.
    staged_mode: Option<PermissionMode>,
    /// The Host took a message of this side chat.
    has_content: bool,
    disposed: bool,
    _source: Option<Task<()>>,
    _create: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for SideChat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SideChat")
            .field("id", &self.id)
            .field("source", &self.source)
            .field("fork", &self.fork)
            .finish_non_exhaustive()
    }
}

impl SideChat {
    /// A side chat about task `source`, with no fork yet.
    pub fn new(source: SharedString, host: Entity<HostSession>, cx: &mut Context<Self>) -> Self {
        let state = cx.new(|cx| ConversationState::new(host.clone(), cx));
        let ledger = SideChatLedger::global(cx);
        let subscriptions = vec![
            cx.subscribe(&host, |this, _, event: &HostSessionEvent, cx| match event {
                HostSessionEvent::Connected { .. } => this.read_source(cx),
                HostSessionEvent::Push(frame) => {
                    if let PushFrame::Change(ChangeNotice::SessionCatalogChanged {
                        session_id, ..
                    }) = frame.as_ref()
                        && session_id.as_str() == this.source.as_ref()
                    {
                        this.read_source(cx);
                    }
                }
                _ => {}
            }),
            cx.observe(&state, |_, _, cx| cx.notify()),
            // Its window closed with the fork alive: the ledger removes it.
            cx.on_release(|this, cx| this.release(cx)),
        ];
        let mut this = Self {
            id: uuid::Uuid::new_v4().simple().to_string().into(),
            source,
            host,
            state,
            ledger,
            source_settings: None,
            fork: None,
            pending: None,
            creating: false,
            quotes: Vec::new(),
            next_quote: 1,
            staged_mode: None,
            has_content: false,
            disposed: false,
            _source: None,
            _create: None,
            _subscriptions: subscriptions,
        };
        this.read_source(cx);
        this
    }

    /// Stable for the life of the side chat: its tab and elements go by it.
    pub fn id(&self) -> &SharedString {
        &self.id
    }

    /// The task it talks about.
    pub fn source(&self) -> &SharedString {
        &self.source
    }

    /// The fork's conversation.
    pub fn state(&self) -> &Entity<ConversationState> {
        &self.state
    }

    /// The fork, once made.
    pub fn fork_id(&self) -> Option<&SharedString> {
        self.fork.as_ref().map(|fork| &fork.session_id)
    }

    /// The Turn of the task the fork was copied through; its rows and those
    /// before it are the fork's context, not its conversation.
    pub fn boundary(&self) -> Option<&str> {
        self.fork.as_ref().and_then(|fork| fork.boundary.as_deref())
    }

    /// Whether the Host took a message of this side chat: closing it then
    /// asks first.
    pub fn has_content(&self) -> bool {
        self.has_content
    }

    /// Whether a fork is being made for a send.
    pub fn is_creating(&self) -> bool {
        self.creating
    }

    /// Whether it was disposed of.
    pub fn is_disposed(&self) -> bool {
        self.disposed
    }

    /// The quotes staged for the next message, oldest first.
    pub fn quotes(&self) -> &[StagedQuote] {
        &self.quotes
    }

    /// The settings the composer shows: the fork's once read, else the
    /// task's.
    pub fn settings<'a>(&'a self, cx: &'a App) -> Option<&'a SessionSettings> {
        self.state.read(cx).settings().or(self.source_settings.as_ref())
    }

    /// The permission mode the next turn runs in: the fork's, else the one
    /// picked before it, else the task's.
    pub fn permission_mode(&self, cx: &App) -> Option<PermissionMode> {
        if let Some(settings) = self.state.read(cx).settings() {
            return Some(settings.permission_mode.clone());
        }
        self.staged_mode.clone().or_else(|| {
            self.source_settings.as_ref().map(|settings| settings.permission_mode.clone())
        })
    }

    /// Picks the permission mode before the fork opens with its first
    /// message; `false` once it has (the fork's own setting changes then).
    pub fn stage_permission_mode(&mut self, mode: PermissionMode, cx: &mut Context<Self>) -> bool {
        if self.state.read(cx).session_id().is_some() {
            return false;
        }
        self.staged_mode = Some(mode);
        cx.notify();
        true
    }

    /// Stages `quote` for the next message: its text cut to the Host's
    /// caps, at most [`QUOTE_MAX_COUNT`] (a quote past them is refused).
    pub fn stage_quote(&mut self, quote: QuoteRef, cx: &mut Context<Self>) -> bool {
        if self.disposed || self.quotes.len() >= QUOTE_MAX_COUNT {
            return false;
        }
        let mut quote = quote;
        quote.text = cut_utf16(quote.text.trim(), QUOTE_TEXT_MAX_LENGTH);
        quote.label = quote.label.map(|label| cut_utf16(label.trim(), QUOTE_LABEL_MAX_LENGTH));
        if quote.text.is_empty() {
            return false;
        }
        let id = self.next_quote;
        self.next_quote += 1;
        self.quotes.push(StagedQuote { id, quote });
        cx.notify();
        true
    }

    /// Takes staged quote `id` off the next message.
    pub fn remove_quote(&mut self, id: u64, cx: &mut Context<Self>) {
        self.quotes.retain(|quote| quote.id != id);
        cx.notify();
    }

    /// Whether the fork's model (or, before it, the task's) is one the
    /// catalog `list` offers.
    fn runs_offered_model(settings: &SessionSettings, list: &ConnectionList) -> bool {
        settings.connection_in(list).is_some_and(|connection| {
            connection.enabled && connection.models.iter().any(|model| model.id == settings.model)
        })
    }

    /// Reads the task's catalog item for its settings.
    fn read_source(&mut self, cx: &mut Context<Self>) {
        if !self.host.read(cx).is_connected() {
            return;
        }
        let requester = self.host.read(cx).requester();
        let source = self.source.to_string();
        self._source = Some(cx.spawn(async move |this, cx| {
            let Ok(Some(projection)) = fork::catalog_get(&requester, &source).await else { return };
            this.update(cx, |this, cx| {
                this.source_settings = Some(SessionSettings::from_projection(&projection));
                cx.notify();
            })
            .ok();
        }));
    }

    /// Sends `text` with `files` (and the staged quotes, unless it waits
    /// as a follow-up after a running turn: the Host's queue keeps text
    /// only) to the fork, making the fork first when there is none. A
    /// fork that never took a message and whose model the catalog `list`
    /// no longer offers is replaced by a new one from the task, as
    /// Desktop's `ensureFork` does; one made by a send that failed before
    /// it opened (the picked mode was not set) gets the mode, then opens
    /// with this message. The quotes the message carried leave the staged
    /// ones once the Host takes it; a failed send keeps them.
    pub fn send(
        &mut self,
        text: String,
        files: Vec<PickedFile>,
        placement: MessagePlacement,
        list: Option<&ConnectionList>,
        cx: &mut Context<Self>,
    ) -> Task<Result<SendOutcome, SharedString>> {
        let locale = Locale::current(cx);
        if self.disposed || self.creating {
            return Task::ready(Err(copy::FORK_SETUP_FAILED.in_locale(locale).into()));
        }
        let queues = self.fork.is_some() && self.state.read(cx).turn_activity().queues();
        let carries_quotes = placement == MessagePlacement::CurrentTurn || !queues;
        let (snapshot, quotes): (Vec<u64>, Vec<QuoteRef>) = if carries_quotes {
            self.quotes.iter().map(|staged| (staged.id, staged.quote.clone())).unzip()
        } else {
            (Vec::new(), Vec::new())
        };
        let content = MessageContent::text(text).with_quotes(quotes);
        let stale = self.fork.as_ref().is_some_and(|_| {
            !self.has_content
                && list.is_some_and(|list| {
                    self.state.read(cx).settings().is_some_and(|fork| {
                        !Self::runs_offered_model(fork, list)
                            && self
                                .source_settings
                                .as_ref()
                                .is_some_and(|source| Self::runs_offered_model(source, list))
                    })
                })
        });
        let opened = self.state.read(cx).session_id().is_some();
        let sent = match (&self.fork, stale) {
            (Some(fork), false) if opened => {
                let fork = fork.session_id.clone();
                self.state.update(cx, |state, cx| {
                    state.send_content(&fork, content, files, placement, cx)
                })
            }
            (Some(fork), false) => {
                let fork = ForkStart::Made(fork.session_id.clone());
                self.make_fork_and_send(fork, content, files, cx)
            }
            (replaced, _) => {
                let replaced = replaced.clone().map(|fork| fork.session_id);
                self.make_fork_and_send(ForkStart::New { replaced }, content, files, cx)
            }
        };
        cx.spawn(async move |this, cx| {
            let result = sent.await;
            this.update(cx, |this, cx| {
                if result.is_ok() {
                    this.has_content = true;
                    this.quotes.retain(|quote| !snapshot.contains(&quote.id));
                }
                cx.notify();
            })
            .ok();
            result
        })
    }

    /// Makes the fork (as `start` says), sets the picked mode on it, then
    /// sends `content` with `files` as its first message.
    fn make_fork_and_send(
        &mut self,
        start: ForkStart,
        content: MessageContent,
        files: Vec<PickedFile>,
        cx: &mut Context<Self>,
    ) -> Task<Result<SendOutcome, SharedString>> {
        let locale = Locale::current(cx);
        let host = self.host.read(cx);
        let (Some(accepted), true) = (host.accepted(), host.is_connected()) else {
            return Task::ready(Err(copy::FORK_SETUP_FAILED.in_locale(locale).into()));
        };
        let root_id = accepted.root_id.clone();
        let requester = host.requester();
        let source = self.source.to_string();
        let pending = self.pending.clone();
        let staged = self.staged_mode.clone();
        self.creating = true;
        cx.notify();
        let (reply, answer) = async_channel::bounded(1);
        self._create = Some(cx.spawn(async move |this, cx| {
            let made = async {
                let created = match start {
                    ForkStart::Made(fork) => fork::catalog_get(&requester, &fork)
                        .await
                        .ok()
                        .flatten()
                        .ok_or(ForkError::SetupFailed)?,
                    ForkStart::New { replaced } => {
                        if let Some(old) = replaced {
                            log::info!("side chat: replacing fork {old}, whose model went away");
                            let disposed = this.update(cx, |this, cx| {
                                this.fork = None;
                                this.state.update(cx, |state, cx| state.select_session(None, cx));
                                let requester = this.host.read(cx).requester();
                                this.ledger
                                    .update(cx, |ledger, cx| ledger.dispose(&old, requester, cx))
                            });
                            if !disposed.map_err(|_| ForkError::SetupFailed)?.await {
                                return Err(ForkError::SetupFailed);
                            }
                        }
                        // The boundary is read once and kept with the target: a
                        // create sent again names the same Turn, or the Host
                        // would take it for another copy.
                        let (target, boundary) = match pending {
                            Some(pending) => (pending.target, pending.boundary),
                            None => {
                                let boundary = fork::read_boundary(&requester, &source)
                                    .await
                                    .map_err(|_| ForkError::SetupFailed)?;
                                (new_session_id(), boundary)
                            }
                        };
                        let projection = fork::catalog_get(&requester, &source)
                            .await
                            .ok()
                            .flatten()
                            .ok_or(ForkError::SetupFailed)?;
                        let written = this
                            .update(cx, |this, cx| {
                                this.pending = Some(PendingFork {
                                    target: target.clone(),
                                    boundary: boundary.clone(),
                                });
                                this.ledger.update(cx, |ledger, cx| {
                                    ledger.begin(
                                        root_id,
                                        target.clone(),
                                        source.clone(),
                                        boundary.clone(),
                                        cx,
                                    )
                                })
                            })
                            .map_err(|_| ForkError::SetupFailed)?;
                        if let Err(error) = written.await {
                            // Nothing was asked for: the entry and the target go.
                            log::warn!("side chat: the ledger could not be written: {error}");
                            this.update(cx, |this, cx| {
                                this.pending = None;
                                this.ledger
                                    .update(cx, |ledger, cx| ledger.forget(&target, cx))
                                    .detach();
                            })
                            .ok();
                            return Err(ForkError::SetupFailed);
                        }
                        let input = SessionConversationCopyInput::side_conversation(
                            source.clone(),
                            target.clone(),
                            boundary.clone(),
                            projection.revision,
                        );
                        let created = match fork::create(&requester, input).await {
                            Ok(created) => created,
                            Err(CreateFailure::Unknown(error)) => return Err(error),
                            Err(refused) => {
                                // Nothing was made: the entry and the target go, and
                                // the next send names a new one.
                                this.update(cx, |this, cx| {
                                    this.pending = None;
                                    this.ledger
                                        .update(cx, |ledger, cx| ledger.forget(&target, cx))
                                        .detach();
                                })
                                .ok();
                                return Err(refused.error());
                            }
                        };
                        this.update(cx, |this, cx| {
                            this.pending = None;
                            this.fork =
                                Some(Fork { session_id: created.id.clone().into(), boundary });
                            this.ledger
                                .update(cx, |ledger, cx| ledger.mark_live(&target, cx))
                                .detach();
                            cx.notify();
                        })
                        .ok();
                        created
                    }
                };
                // The mode picked before the fork opens goes on it before
                // anything runs; if it cannot, nothing is sent (Desktop fails
                // closed), and the next send sets it first again.
                if let Some(mode) = staged.filter(|mode| *mode != created.permission_mode) {
                    let input = SessionConfigurationUpdateInput::new(
                        created.id.clone(),
                        created.revision,
                        SessionConfigurationPatch::permission_mode(mode),
                    );
                    match requester.request::<SessionConfigurationUpdate>(&input).await {
                        Ok(SessionUpdateResult::Committed { .. }) => {}
                        other => {
                            log::warn!("side chat: the picked mode was not set: {other:?}");
                            return Err(ForkError::Respond);
                        }
                    }
                }
                this.update(cx, |this, _| this.staged_mode = None).ok();
                Ok(created.id)
            }
            .await;
            let sent = this.update(cx, |this, cx| {
                this.creating = false;
                cx.notify();
                match made {
                    Ok(fork) => Ok(this.state.update(cx, |state, cx| {
                        state.open_with_message(fork.into(), content, files, cx)
                    })),
                    Err(error) => Err(error.message(Locale::current(cx))),
                }
            });
            let result = match sent {
                Ok(Ok(task)) => task.await,
                Ok(Err(message)) => Err(message),
                Err(_) => Err(copy::FORK_SETUP_FAILED.in_locale(locale).into()),
            };
            reply.try_send(result).ok();
        }));
        cx.foreground_executor().spawn(async move {
            answer
                .recv()
                .await
                .unwrap_or_else(|_| Err(copy::FORK_SETUP_FAILED.in_locale(locale).into()))
        })
    }

    /// Disposes of the side chat: its tab closed, or its task deleted.
    /// Stops the fork's runs and removes it, a create in flight included
    /// (the ledger sends it again first); answers whether the fork is gone.
    /// Its conversation closes at once.
    pub fn dispose(&mut self, cx: &mut Context<Self>) -> Task<bool> {
        if self.disposed {
            return Task::ready(true);
        }
        self.disposed = true;
        self._create = None;
        self.creating = false;
        self.quotes.clear();
        self.state.update(cx, |state, cx| state.select_session(None, cx));
        let target = self
            .fork
            .take()
            .map(|fork| fork.session_id.to_string())
            .or_else(|| self.pending.take().map(|pending| pending.target));
        cx.notify();
        let Some(target) = target else { return Task::ready(true) };
        let requester = self.host.read(cx).requester();
        self.ledger.update(cx, |ledger, cx| ledger.dispose(&target, requester, cx))
    }

    /// Dropped without [`Self::dispose`]: the ledger removes the fork.
    fn release(&mut self, cx: &mut App) {
        if self.disposed {
            return;
        }
        let target = self
            .fork
            .as_ref()
            .map(|fork| fork.session_id.to_string())
            .or_else(|| self.pending.as_ref().map(|pending| pending.target.clone()));
        if let Some(target) = target {
            let requester = self.host.read(cx).requester();
            self.ledger.update(cx, |ledger, cx| ledger.dispose(&target, requester, cx)).detach();
        }
    }
}

impl ForkError {
    /// What the side chat says (Desktop's `quoteCompanion.errors`).
    fn message(self, locale: Locale) -> SharedString {
        match self {
            Self::SetupFailed => copy::FORK_SETUP_FAILED,
            Self::SourceBusy => copy::FORK_SOURCE_BUSY,
            Self::Unsupported => copy::FORK_UNSUPPORTED,
            Self::Respond => copy::RESPOND_FAILED,
        }
        .in_locale(locale)
        .into()
    }
}

/// `text` cut to at most `max` UTF-16 code units (a JavaScript string's
/// length, which the Host's caps count), at a character boundary.
fn cut_utf16(text: &str, max: usize) -> String {
    let mut units = 0;
    let mut end = 0;
    for (ix, ch) in text.char_indices() {
        units += ch.len_utf16();
        if units > max {
            break;
        }
        end = ix + ch.len_utf8();
    }
    text[..end].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cut_counts_utf16_units_and_keeps_characters_whole() {
        assert_eq!(cut_utf16("abc", 2), "ab");
        assert_eq!(cut_utf16("ab😀c", 3), "ab");
        assert_eq!(cut_utf16("ab😀c", 4), "ab😀");
        assert_eq!(cut_utf16("短", 1), "短");
    }
}
