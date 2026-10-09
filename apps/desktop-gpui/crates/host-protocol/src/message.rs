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

//! User-authored message content and the Session message queue.
//!
//! Sources: `MessageContent` and `decodeMessageContent` in
//! `packages/core/src/events.ts`; the Host wire rules in `decodeMessageContent`
//! and `decodeMessageAdmissionContent` in
//! `packages/runtime-host/src/protocol/turn.ts`; the queue projection and
//! `turn.message.submit` in `packages/runtime-host/src/protocol/message.ts`;
//! the per-entry queue commands in
//! `packages/runtime-host/src/protocol/queue-mutation.ts`; the limits in
//! `packages/runtime-host/src/protocol/message-queue-limits.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{AttachmentRef, Operation, TurnOrchestration};

/// `MESSAGE_QUEUE_MAX_ENTRIES` (`message-queue-limits.ts`): steering and
/// follow-up entries together.
pub const MESSAGE_QUEUE_MAX_ENTRIES: usize = 64;

/// `MessageContent`: what a user sent.
///
/// The MVP reads `text` and `displayText`, and the attachments through
/// [`Self::attachment_refs`]. Attachments, directory references, quotes, and
/// inline references are kept verbatim so re-encoding loses nothing; they
/// are modeled when a feature needs them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct MessageContent {
    /// Authoritative model-facing input. The Host caps it at 48 KiB of UTF-8
    /// (`TURN_MESSAGE_TEXT_MAX_BYTES`).
    pub text: String,
    /// Human-facing text when it differs from `text`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_text: Option<String>,
    /// `AttachmentRef[]`; omitted when empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<Value>>,
    /// `DirectoryReference[]`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory_references: Option<Vec<Value>>,
    /// `QuoteRef[]`; omitted when empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quotes: Option<Vec<Value>>,
    /// `InlineReference[]`; an empty array marks a current-format plain message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inline_references: Option<Vec<Value>>,
}

impl MessageContent {
    /// Plain text content.
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            display_text: None,
            attachments: None,
            directory_references: None,
            quotes: None,
            inline_references: None,
        }
    }

    /// The text a person should see (`userFacingText` in
    /// `packages/core/src/session.ts`).
    pub fn user_facing_text(&self) -> &str {
        self.display_text.as_deref().unwrap_or(&self.text)
    }

    /// The attachments, in order, as `AttachmentRef`s (`isAttachmentRef` in
    /// `packages/core/src/events.ts`). One this client cannot read is left
    /// out rather than failing the message.
    pub fn attachment_refs(&self) -> Vec<AttachmentRef> {
        self.attachments
            .iter()
            .flatten()
            .filter_map(|value| AttachmentRef::deserialize(value).ok())
            .collect()
    }
}

wire_enum! {
    /// `MessagePlacement` (`protocol/message.ts`).
    pub enum MessagePlacement {
        CurrentTurn = "current_turn",
        NextTurn = "next_turn",
    }
}

wire_enum! {
    /// `MessageQueueEntrySnapshot.state` (`decodeMessageQueueEntrySnapshot`).
    pub enum MessageQueueEntryState {
        Queued = "queued",
        InFlight = "in_flight",
        Retracted = "retracted",
    }
}

/// `MessageQueueEntrySnapshot` (`decodeMessageQueueEntrySnapshot` in
/// `protocol/message.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct MessageQueueEntrySnapshot {
    pub entry_id: String,
    pub message_id: String,
    pub content: MessageContent,
    pub placement: MessagePlacement,
    pub state: MessageQueueEntryState,
}

/// `SessionMessageQueueProjection` (`decodeSessionMessageQueueProjection`):
/// the authoritative queue the continuity snapshot carries. Entries hold the
/// canonical content; the mutation results carry only `queueRevision`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionMessageQueueProjection {
    /// Always the subscription's Host epoch (`assertQueueEpoch`).
    pub host_epoch: String,
    /// Not monotonic across projections in practice: a real Host was seen
    /// going 1 → 0 after a stopped Turn.
    pub queue_revision: u64,
    /// Steering entries: `queued` or `in_flight`, placement `current_turn`.
    pub steering: Vec<MessageQueueEntrySnapshot>,
    /// Follow-up entries: `queued`, placement `next_turn`.
    pub followup: Vec<MessageQueueEntrySnapshot>,
}

impl SessionMessageQueueProjection {
    /// Every entry still waiting or in flight: steering first, then the
    /// follow-ups, each in queue order.
    pub fn entries(&self) -> impl Iterator<Item = &MessageQueueEntrySnapshot> {
        self.steering.iter().chain(&self.followup)
    }
}

/// `TurnMessageSubmitInput` (`decodeTurnMessageSubmitInput`): the one way a
/// client submits a user message. The Host decides what happens: an idle
/// Session starts a Turn with it; a running one queues it as steering
/// (`current_turn`) or as a follow-up Turn (`next_turn`). The Desktop sends
/// a plain message with `next_turn` (`app-shell-chat-actions.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct TurnMessageSubmitInput {
    /// The Host epoch the client observed the Session under.
    pub origin_host_epoch: String,
    pub session_id: String,
    /// Client-chosen idempotency id; the durable user row takes it as its id.
    pub message_id: String,
    pub content: MessageContent,
    pub placement: MessagePlacement,
    /// Exact-Turn intent: only with `current_turn`; omitted when empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_orchestration: Option<TurnOrchestration>,
}

impl TurnMessageSubmitInput {
    /// A message without Skills or orchestration.
    pub fn new(
        origin_host_epoch: impl Into<String>,
        session_id: impl Into<String>,
        message_id: impl Into<String>,
        content: MessageContent,
        placement: MessagePlacement,
    ) -> Self {
        Self {
            origin_host_epoch: origin_host_epoch.into(),
            session_id: session_id.into(),
            message_id: message_id.into(),
            content,
            placement,
            skill_ids: None,
            turn_orchestration: None,
        }
    }
}

/// `TurnMessageSubmitResult` (`decodeTurnMessageSubmitResult`), by
/// `disposition`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "disposition", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum TurnMessageSubmitResult {
    /// The Session was idle: the message opened this Turn.
    #[serde(rename_all = "camelCase")]
    TurnStarted { turn_id: String, skill_invocation: Value },
    /// Queued for the running Turn's next provider boundary.
    #[serde(rename_all = "camelCase")]
    Steering {
        /// Absent when an older Host Epoch can prove admission but not its
        /// transient revision.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        queue_revision: Option<u64>,
        skill_invocation: Value,
    },
    /// Queued to open its own Turn after the running one.
    #[serde(rename_all = "camelCase")]
    Followup {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        queue_revision: Option<u64>,
        skill_invocation: Value,
    },
    /// Every requested Skill failed to load; nothing was admitted.
    #[serde(rename_all = "camelCase")]
    Blocked { skill_invocation: Value },
    /// A disposition this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `queue.entry.promote` input (`decodeQueueEntryPromoteInput`): move a
/// follow-up into the running Turn as steering.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct QueueEntryPromoteInput {
    pub origin_host_epoch: String,
    pub session_id: String,
    pub entry_id: String,
    /// Client-chosen idempotency id.
    pub promote_id: String,
}

impl QueueEntryPromoteInput {
    pub fn new(
        origin_host_epoch: impl Into<String>,
        session_id: impl Into<String>,
        entry_id: impl Into<String>,
        promote_id: impl Into<String>,
    ) -> Self {
        Self {
            origin_host_epoch: origin_host_epoch.into(),
            session_id: session_id.into(),
            entry_id: entry_id.into(),
            promote_id: promote_id.into(),
        }
    }
}

/// `queue.entry.retract` input (`decodeQueueEntryRetractInput`): take one
/// queued entry back before it is sent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct QueueEntryRetractInput {
    pub origin_host_epoch: String,
    pub session_id: String,
    pub entry_id: String,
    pub retract_id: String,
}

impl QueueEntryRetractInput {
    pub fn new(
        origin_host_epoch: impl Into<String>,
        session_id: impl Into<String>,
        entry_id: impl Into<String>,
        retract_id: impl Into<String>,
    ) -> Self {
        Self {
            origin_host_epoch: origin_host_epoch.into(),
            session_id: session_id.into(),
            entry_id: entry_id.into(),
            retract_id: retract_id.into(),
        }
    }
}

/// `queue.entry.update` input (`decodeQueueEntryUpdateInput`): replace a
/// queued entry's text, at the queue revision it was read at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct QueueEntryUpdateInput {
    pub origin_host_epoch: String,
    pub session_id: String,
    pub entry_id: String,
    pub update_id: String,
    pub expected_queue_revision: u64,
    /// Not blank, at most 48 KiB of UTF-8 (`TURN_MESSAGE_TEXT_MAX_BYTES`).
    pub text: String,
}

impl QueueEntryUpdateInput {
    pub fn new(
        origin_host_epoch: impl Into<String>,
        session_id: impl Into<String>,
        entry_id: impl Into<String>,
        update_id: impl Into<String>,
        expected_queue_revision: u64,
        text: impl Into<String>,
    ) -> Self {
        Self {
            origin_host_epoch: origin_host_epoch.into(),
            session_id: session_id.into(),
            entry_id: entry_id.into(),
            update_id: update_id.into(),
            expected_queue_revision,
            text: text.into(),
        }
    }
}

/// `queue.entries.reorder` input (`decodeQueueEntriesReorderInput`): the
/// entries of one placement in their new order, at the queue revision they
/// were read at. Since epoch 197 the revision is required: the Host refuses
/// the reorder with `operation_conflict` once the queue has moved on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct QueueEntriesReorderInput {
    pub origin_host_epoch: String,
    pub session_id: String,
    pub reorder_id: String,
    pub expected_queue_revision: u64,
    /// Unique, at most [`MESSAGE_QUEUE_MAX_ENTRIES`].
    pub entry_ids: Vec<String>,
}

impl QueueEntriesReorderInput {
    pub fn new(
        origin_host_epoch: impl Into<String>,
        session_id: impl Into<String>,
        reorder_id: impl Into<String>,
        expected_queue_revision: u64,
        entry_ids: Vec<String>,
    ) -> Self {
        Self {
            origin_host_epoch: origin_host_epoch.into(),
            session_id: session_id.into(),
            reorder_id: reorder_id.into(),
            expected_queue_revision,
            entry_ids,
        }
    }
}

/// `queue.retract` input (`decodeQueueRetractInput`): take back every
/// queued entry of the Session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct QueueRetractInput {
    pub origin_host_epoch: String,
    pub session_id: String,
    pub retract_id: String,
}

/// `QueueMutationResult` (`decodeQueueMutationResult`): the queue revision
/// after a promote, retract, update, or reorder. The next projection shows
/// the entries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct QueueMutationResult {
    pub queue_revision: u64,
}

/// `QueueRetractResult` (`decodeQueueRetractResult`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct QueueRetractResult {
    pub queue_revision: u64,
    /// Entries in state `retracted`.
    pub retracted: Vec<MessageQueueEntrySnapshot>,
}

macro_rules! message_operation {
    ($(#[$meta:meta])* $name:ident = $wire:literal, $input:ty => $output:ty) => {
        $(#[$meta])*
        #[derive(Debug)]
        pub enum $name {}

        impl Operation for $name {
            const NAME: &'static str = $wire;
            type Input = $input;
            type Output = $output;
        }
    };
}

message_operation!(
    /// `turn.message.submit` (mode `command`, `MESSAGE_OPERATION_SPECS`).
    TurnMessageSubmit = "turn.message.submit", TurnMessageSubmitInput => TurnMessageSubmitResult
);
message_operation!(
    /// `queue.entry.promote` (mode `command`).
    QueueEntryPromote = "queue.entry.promote", QueueEntryPromoteInput => QueueMutationResult
);
message_operation!(
    /// `queue.entry.retract` (mode `command`).
    QueueEntryRetract = "queue.entry.retract", QueueEntryRetractInput => QueueMutationResult
);
message_operation!(
    /// `queue.entry.update` (mode `command`).
    QueueEntryUpdate = "queue.entry.update", QueueEntryUpdateInput => QueueMutationResult
);
message_operation!(
    /// `queue.entries.reorder` (mode `command`).
    QueueEntriesReorder = "queue.entries.reorder", QueueEntriesReorderInput => QueueMutationResult
);
message_operation!(
    /// `queue.retract` (mode `command`).
    QueueRetract = "queue.retract", QueueRetractInput => QueueRetractResult
);

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn attachment_refs_skip_what_does_not_decode() {
        let image = json!({"kind": "image", "name": "shot.png", "mimeType": "image/png",
                           "bytes": 2048, "ref": {"kind": "session_file", "sessionId": "s",
                                                  "relativePath": "a1"}});
        let unknown_storage = json!({"kind": "other", "name": "x", "mimeType": "text/plain",
                                     "bytes": 1, "ref": {"kind": "cloud_file", "id": "z"}});
        let mut content = MessageContent::text("look");
        assert!(content.attachment_refs().is_empty());
        content.attachments = Some(vec![image, unknown_storage, json!("not a ref")]);
        let refs = content.attachment_refs();
        assert_eq!(refs.len(), 1);
        assert_eq!((refs[0].name.as_str(), refs[0].bytes), ("shot.png", 2048));
        assert_eq!(refs[0].kind, crate::AttachmentKind::Image);
    }

    #[test]
    fn submit_input_encodes_the_desktop_shape() {
        let input = TurnMessageSubmitInput::new(
            "e",
            "s",
            "m",
            MessageContent::text("hi"),
            MessagePlacement::NextTurn,
        );
        assert_eq!(
            serde_json::to_value(input).expect("encode"),
            json!({"originHostEpoch": "e", "sessionId": "s", "messageId": "m",
                   "content": {"text": "hi"}, "placement": "next_turn"})
        );
    }

    #[test]
    fn submit_results_decode_by_disposition() {
        let skills = json!({"loaded": [], "failed": [], "receipts": []});
        let started: TurnMessageSubmitResult = serde_json::from_value(
            json!({"disposition": "turn_started", "turnId": "t", "skillInvocation": skills}),
        )
        .expect("decode");
        assert!(
            matches!(started, TurnMessageSubmitResult::TurnStarted { ref turn_id, .. } if turn_id == "t")
        );
        let steering: TurnMessageSubmitResult =
            serde_json::from_value(json!({"disposition": "steering", "skillInvocation": skills}))
                .expect("decode");
        assert!(matches!(steering, TurnMessageSubmitResult::Steering { queue_revision: None, .. }));
        let future: TurnMessageSubmitResult =
            serde_json::from_value(json!({"disposition": "parked"})).expect("decode");
        assert_eq!(future, TurnMessageSubmitResult::Unknown);
    }

    #[test]
    fn reorder_input_names_the_queue_revision() {
        let input = QueueEntriesReorderInput::new("e", "s", "r", 3, vec!["q2".into(), "q1".into()]);
        assert_eq!(
            serde_json::to_value(input).expect("encode"),
            json!({"originHostEpoch": "e", "sessionId": "s", "reorderId": "r",
                   "expectedQueueRevision": 3, "entryIds": ["q2", "q1"]})
        );
    }

    #[test]
    fn plain_text_content_encodes_only_text() {
        assert_eq!(
            serde_json::to_value(MessageContent::text("hi")).expect("encode"),
            json!({"text": "hi"})
        );
    }

    #[test]
    fn display_text_wins_for_people() {
        let content: MessageContent =
            serde_json::from_value(json!({"text": "model", "displayText": "person"}))
                .expect("decode");
        assert_eq!(content.user_facing_text(), "person");
        assert_eq!(MessageContent::text("x").user_facing_text(), "x");
    }

    #[test]
    fn queue_entries_decode() {
        let queue: SessionMessageQueueProjection = serde_json::from_value(json!({
            "hostEpoch": "e",
            "queueRevision": 2,
            "steering": [{
                "entryId": "q1", "messageId": "m1", "content": {"text": "wait"},
                "placement": "current_turn", "state": "in_flight"
            }],
            "followup": []
        }))
        .expect("decode");
        assert_eq!(queue.steering[0].state, MessageQueueEntryState::InFlight);
        assert_eq!(queue.steering[0].placement, MessagePlacement::CurrentTurn);
    }
}
