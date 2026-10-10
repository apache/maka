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

//! The conversation of the selected session: transcript, streaming output,
//! Tool calls, the prompts a turn raises, and the composer.
//!
//! - [`ConversationState`] owns the session's subscription and its
//!   [`transcript_model::Transcript`], the message and turn commands
//!   (`turn.message.submit`, the `queue.*` commands, `turn.stop`), older
//!   history (`session.transcript.page` `older`), and answers to prompts
//!   (`interaction.answer`). The shell hands it the selected session.
//! - [`ConversationView`] renders the transcript as a virtualized list with
//!   inline Tool cards and prompt cards, plus the empty, loading, and failure
//!   states of the pane. The transcript is a Tab stop that PageUp, PageDown,
//!   Home, and End scroll; [`init`] binds those keys. It is also the item
//!   of its find bar ([`ConversationView::open_find`], the `search` crate's
//!   `Searchable`), which searches every held row, read from the model.
//!   It also carries the task's terminal output for the `terminal` crate:
//!   [`ConversationState::set_pty_interest`] and [`SessionPtyEvent`].
//! - [`Composer`] edits the draft and sends it, or stops the running turn,
//!   through the same state; its [`QueuePlate`] lists the queued messages.
//!
//! - [`SideChat`] is a side conversation about a task in a fork of it, made
//!   on its first send and removed when it is disposed of; [`SideChatPanel`]
//!   shows it with a view and a composer of its own, and [`SideChatLedger`]
//!   keeps every fork on disk until it is gone.
//!
//! The shell only places the view and the composer in its window and routes
//! its window-wide Send and Stop commands to the composer.

mod attachments;
mod composer;
mod corpus;
mod edits_card;
mod paging;
mod queue;
mod quiet_json;
mod quotes;
mod rows;
mod side_chat;
mod state;
mod style;
mod thinking_face;
mod turn_status;
mod view;

pub use attachments::PickedFile;
pub use composer::{
    Composer, ComposerAction, ModelChoice, PERMISSION_MODES, permission_mode_hint,
    permission_mode_label, thinking_level_label,
};
pub use queue::{CancelQueueEdit, QueuePlate, queue_entry_element_id};
pub use rows::{edits_element_id, footer_element_id, item_element_id};
pub use side_chat::{
    ForkEntry, ForkPhase, LEDGER_FILE, LedgerEdit, LedgerFile, LedgerStore, LedgerWrite,
    OWNER_LOCKS_DIRECTORY, SIDE_CHAT_CONTEXT, SideChat, SideChatLedger, SideChatPanel, StagedQuote,
};
pub use state::{
    AnswerState, BACKGROUND_PAGE_BYTES, COMMIT_INTERVAL, ConversationEvent, ConversationPhase,
    ConversationState, NewSessionEvent, OLDER_PAGE_BYTES, OlderHistory, SendOutcome,
    SessionPtyEvent, SessionSettings, TURN_START_PAGE_CAP, TurnActivity,
};
#[doc(hidden)]
pub use view::assistant_text;
pub use view::{
    ConversationView, ConversationViewEvent, ScrollPageDown, ScrollPageUp, ScrollToBottom,
    ScrollToTop, TRANSCRIPT_CONTEXT, init,
};

#[cfg(test)]
mod tests;
