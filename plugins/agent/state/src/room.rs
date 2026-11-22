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

use crate::store::invalid;
use maka_agent_facts::{
    durable::{RunOwner, Terminal, UnixMillis},
    input::MessageInput,
    room::{
        RoomActor, RoomAuthor, RoomDelivery, RoomDeliveryState, RoomMember, RoomMessage, RoomPage,
        RoomParticipantActivity, RoomPosition, RoomReaction, RoomSearchMatch, RoomState,
    },
};
use maka_event_log::{
    StoreError,
    connection::Query,
    root_store::DataWriter,
    writeback::{Notification, Prepared, Statement},
};
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::{BTreeSet, HashMap, HashSet};

#[derive(Clone)]
pub struct RoomStore {
    data: DataWriter,
    owner: RunOwner,
}

#[derive(Clone, Debug)]
pub struct Post {
    pub session: String,
    pub id: String,
    pub at: UnixMillis,
    pub author: RoomAuthor,
    pub content: MessageInput,
    pub reply_to: Option<String>,
    pub mentions: Vec<String>,
    pub deliveries: Vec<RoomDelivery>,
}

/// Snapshot of recent Room context used to orient a mentioned Agent without extra round-trips.
#[derive(Clone, Debug)]
pub struct RoomContextSnapshot {
    pub topic: String,
    pub members: Vec<RoomMember>,
    pub pinned: Vec<RoomMessage>,
    pub recent: Vec<RoomMessage>,
    pub has_earlier: bool,
}

impl RoomStore {
    pub fn new(data: DataWriter, owner: RunOwner) -> Self {
        Self { data, owner }
    }

    pub fn create_statement(&self, session: String) -> CreateRoom {
        CreateRoom {
            owner: self.owner.clone(),
            session,
        }
    }

    pub fn post_statement(&self, post: Post) -> PostStatement {
        PostStatement {
            owner: self.owner.clone(),
            post,
        }
    }

    pub fn set_topic_statement(&self, session: String, topic: String) -> SetTopicStatement {
        SetTopicStatement {
            owner: self.owner.clone(),
            session,
            topic,
        }
    }

    pub fn add_members_statement(
        &self,
        session: String,
        member_sessions: Vec<String>,
        at: UnixMillis,
    ) -> AddMembersStatement {
        AddMembersStatement {
            owner: self.owner.clone(),
            session,
            member_sessions,
            at,
        }
    }

    pub fn remove_members_statement(
        &self,
        session: String,
        member_sessions: Vec<String>,
    ) -> RemoveMembersStatement {
        RemoveMembersStatement {
            owner: self.owner.clone(),
            session,
            member_sessions,
        }
    }

    pub fn react_statement(
        &self,
        session: String,
        message_id: String,
        actor: RoomActor,
        emoji: String,
        add: Option<bool>,
        at: UnixMillis,
    ) -> ReactStatement {
        ReactStatement {
            owner: self.owner.clone(),
            session,
            message_id,
            actor,
            emoji,
            add,
            at,
        }
    }

    pub fn pin_statement(
        &self,
        session: String,
        message_id: String,
        pinned: bool,
        at: UnixMillis,
    ) -> PinStatement {
        PinStatement {
            owner: self.owner.clone(),
            session,
            message_id,
            pinned,
            at,
        }
    }

    pub fn edit_message_statement(
        &self,
        session: String,
        message_id: String,
        actor: RoomActor,
        text: String,
        at: UnixMillis,
    ) -> EditMessageStatement {
        EditMessageStatement {
            owner: self.owner.clone(),
            session,
            message_id,
            actor,
            text,
            at,
        }
    }

    pub fn delete_message_statement(
        &self,
        session: String,
        message_id: String,
        actor: RoomActor,
        at: UnixMillis,
    ) -> DeleteMessageStatement {
        DeleteMessageStatement {
            owner: self.owner.clone(),
            session,
            message_id,
            actor,
            at,
        }
    }

    pub async fn exists(&self, session: &str) -> Result<bool, StoreError> {
        self.data
            .query(Exists(self.owner.clone(), session.to_owned()))
            .await
    }

    pub async fn get(
        &self,
        session: &str,
        message_id: &str,
    ) -> Result<Option<RoomMessage>, StoreError> {
        self.data
            .query(Get {
                owner: self.owner.clone(),
                session: session.to_owned(),
                message_id: message_id.to_owned(),
            })
            .await
    }

    pub async fn capture(&self, session: &str) -> Result<u64, StoreError> {
        self.data
            .query(Capture(self.owner.clone(), session.to_owned()))
            .await
    }

    /// Monotonic watermark that advances on Room messages, metadata/member/reaction/pin changes,
    /// and member run activity changes so watchers stay live without polling.
    pub async fn watch_watermark(&self, session: &str) -> Result<(u64, u64), StoreError> {
        self.data
            .query(WatchWatermark(self.owner.clone(), session.to_owned()))
            .await
    }

    pub async fn state(&self, session: &str) -> Result<RoomState, StoreError> {
        self.data
            .query(StateQuery {
                owner: self.owner.clone(),
                session: session.to_owned(),
            })
            .await
    }

    pub async fn context_snapshot(
        &self,
        session: &str,
        recent_limit: u32,
        extra_session_ids: Vec<String>,
    ) -> Result<RoomContextSnapshot, StoreError> {
        self.data
            .query(ContextSnapshotQuery {
                owner: self.owner.clone(),
                session: session.to_owned(),
                recent_limit,
                extra_session_ids,
            })
            .await
    }

    pub async fn search(
        &self,
        session: &str,
        query: String,
        limit: u32,
    ) -> Result<Vec<RoomSearchMatch>, StoreError> {
        self.data
            .query(SearchQuery {
                owner: self.owner.clone(),
                session: session.to_owned(),
                query,
                limit,
            })
            .await
    }

    pub async fn page(
        &self,
        session: String,
        through: Option<u64>,
        position: RoomPosition,
        limit: u32,
    ) -> Result<RoomPage, StoreError> {
        self.data
            .query(Page {
                owner: self.owner.clone(),
                session,
                through,
                position,
                limit,
            })
            .await
    }
}

pub struct CreateRoom {
    owner: RunOwner,
    session: String,
}

impl Statement for CreateRoom {
    type Value = ();
    type Output = ();

    fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
        let owner = serde_json::to_string(&self.owner)?;
        let changed = c.execute(
            "INSERT INTO agent_rooms(owner,session) VALUES(?,?) ON CONFLICT(owner,session) DO NOTHING",
            params![owner, self.session],
        )? > 0;
        Ok(Prepared {
            value: (),
            changed,
            notification: Notification::METADATA.with_sessions([self.session]),
        })
    }

    fn committed(_: ()) {}

    fn isolated_rejection(error: &StoreError) -> bool {
        isolated_rejection(error)
    }
}

pub struct PostStatement {
    owner: RunOwner,
    post: Post,
}

impl Statement for PostStatement {
    type Value = RoomMessage;
    type Output = RoomMessage;

    fn execute(self, c: &Connection) -> Result<Prepared<RoomMessage>, StoreError> {
        let owner = serde_json::to_string(&self.owner)?;
        let Post {
            session,
            id,
            at,
            author,
            content,
            reply_to,
            mentions,
            deliveries,
        } = self.post;
        let mut message = RoomMessage {
            id,
            sequence: 0,
            at: unsigned(at.0)?,
            author,
            content,
            reply_to,
            mentions,
            deliveries,
            edited_at: None,
            deleted_at: None,
            reactions: Vec::new(),
            pinned: false,
            delivery_states: Vec::new(),
        };
        if let Some(existing) = get_raw(c, &owner, &session, &message.id)? {
            message.sequence = existing.sequence;
            message.at = existing.at;
            if message != existing {
                return Err(StoreError::EventConflict);
            }
            return Ok(Prepared {
                value: existing,
                changed: false,
                notification: Notification::NONE,
            });
        }
        ensure_room_writable(c, &owner, &session)?;
        if let Some(reply) = &message.reply_to
            && message_sequence(c, &owner, &session, reply)?.is_none()
        {
            return Err(invalid("Room reply message is unavailable"));
        }
        message.sequence = tail(c, &owner, &session)? + 1;
        c.execute(
            "INSERT INTO agent_room_messages(owner,session,sequence,message,at,reply_to,body_json) VALUES(?,?,?,?,?,?,?)",
            params![
                owner,
                session,
                integer(message.sequence)?,
                message.id,
                at.0,
                message.reply_to,
                serde_json::to_string(&message)?,
            ],
        )?;
        c.execute(
            "INSERT INTO agent_catalog_sessions(owner,session,last_sequence) VALUES(?,?,?) ON CONFLICT(owner,session) DO UPDATE SET last_sequence=excluded.last_sequence",
            params![owner, session, integer(message.sequence)?],
        )?;
        // Auto-enroll active participants (agent author + accepted mention targets) into the Roster.
        let mut auto_members: Vec<&str> = Vec::new();
        if let RoomAuthor::Session { execution } = &message.author {
            auto_members.push(&execution.session_id);
        }
        for delivery in &message.deliveries {
            if let RoomDelivery::Accepted { session_id, .. } = delivery {
                auto_members.push(session_id);
            }
        }
        for member in auto_members {
            if member == session {
                continue;
            }
            c.execute(
                "INSERT OR IGNORE INTO agent_room_members(owner,session,member_session,added_at)
                 SELECT ?1,?2,?3,?4
                 WHERE EXISTS(SELECT 1 FROM session_control s WHERE s.id=?3 AND NOT EXISTS(SELECT 1 FROM session_retirements d WHERE d.session_id=s.id AND d.remove_session=1))
                   AND NOT EXISTS(SELECT 1 FROM agent_rooms r WHERE r.owner=?1 AND r.session=?3)",
                params![owner, session, member, at.0],
            )?;
        }
        Ok(Prepared {
            value: message,
            changed: true,
            notification: Notification::METADATA.with_sessions([session]),
        })
    }

    fn committed(value: RoomMessage) -> RoomMessage {
        value
    }

    fn isolated_rejection(error: &StoreError) -> bool {
        isolated_rejection(error)
    }
}

pub struct SetTopicStatement {
    owner: RunOwner,
    session: String,
    topic: String,
}

impl Statement for SetTopicStatement {
    type Value = String;
    type Output = String;

    fn execute(self, c: &Connection) -> Result<Prepared<String>, StoreError> {
        let owner = serde_json::to_string(&self.owner)?;
        ensure_room_writable(c, &owner, &self.session)?;
        let topic = self.topic.trim().to_owned();
        if topic.chars().count() > 2000 {
            return Err(invalid("Room topic exceeds maximum length"));
        }
        let changed = c.execute(
            "UPDATE agent_rooms SET topic=? WHERE owner=? AND session=? AND topic<>?",
            params![topic, owner, self.session, topic],
        )? > 0;
        Ok(Prepared {
            value: topic,
            changed,
            notification: if changed {
                Notification::METADATA.with_sessions([self.session])
            } else {
                Notification::NONE
            },
        })
    }

    fn committed(value: String) -> String {
        value
    }

    fn isolated_rejection(error: &StoreError) -> bool {
        isolated_rejection(error)
    }
}

pub struct AddMembersStatement {
    owner: RunOwner,
    session: String,
    member_sessions: Vec<String>,
    at: UnixMillis,
}

impl Statement for AddMembersStatement {
    type Value = Vec<String>;
    type Output = Vec<String>;

    fn execute(self, c: &Connection) -> Result<Prepared<Vec<String>>, StoreError> {
        let owner = serde_json::to_string(&self.owner)?;
        ensure_room_writable(c, &owner, &self.session)?;
        let mut added = Vec::new();
        let mut changed = false;
        for member in self.member_sessions {
            if member == self.session {
                return Err(invalid("Cannot add a Room to itself as a member"));
            }
            if exists(c, &owner, &member)? {
                return Err(invalid(
                    "Room members must be Agent conversations, not Rooms",
                ));
            }
            let valid_agent: bool = c.query_row(
                "SELECT EXISTS(SELECT 1 FROM session_control s WHERE s.id=? AND NOT EXISTS(SELECT 1 FROM session_retirements d WHERE d.session_id=s.id AND d.remove_session=1))",
                params![member],
                |row| row.get(0),
            )?;
            if !valid_agent {
                return Err(StoreError::SessionNotFound);
            }
            let n = c.execute(
                "INSERT OR IGNORE INTO agent_room_members(owner,session,member_session,added_at) VALUES(?,?,?,?)",
                params![owner, self.session, member, self.at.0],
            )?;
            if n > 0 {
                changed = true;
                added.push(member);
            }
        }
        Ok(Prepared {
            value: added,
            changed,
            notification: if changed {
                Notification::METADATA.with_sessions([self.session])
            } else {
                Notification::NONE
            },
        })
    }

    fn committed(value: Vec<String>) -> Vec<String> {
        value
    }

    fn isolated_rejection(error: &StoreError) -> bool {
        isolated_rejection(error)
    }
}

pub struct RemoveMembersStatement {
    owner: RunOwner,
    session: String,
    member_sessions: Vec<String>,
}

impl Statement for RemoveMembersStatement {
    type Value = Vec<String>;
    type Output = Vec<String>;

    fn execute(self, c: &Connection) -> Result<Prepared<Vec<String>>, StoreError> {
        let owner = serde_json::to_string(&self.owner)?;
        ensure_room_writable(c, &owner, &self.session)?;
        let mut removed = Vec::new();
        for member in self.member_sessions {
            if c.execute(
                "DELETE FROM agent_room_members WHERE owner=? AND session=? AND member_session=?",
                params![owner, self.session, member],
            )? > 0
            {
                removed.push(member);
            }
        }
        let changed = !removed.is_empty();
        Ok(Prepared {
            value: removed,
            changed,
            notification: if changed {
                Notification::METADATA.with_sessions([self.session])
            } else {
                Notification::NONE
            },
        })
    }

    fn committed(value: Vec<String>) -> Vec<String> {
        value
    }

    fn isolated_rejection(error: &StoreError) -> bool {
        isolated_rejection(error)
    }
}

pub struct ReactStatement {
    owner: RunOwner,
    session: String,
    message_id: String,
    actor: RoomActor,
    emoji: String,
    add: Option<bool>,
    at: UnixMillis,
}

impl Statement for ReactStatement {
    type Value = bool;
    type Output = bool;

    fn execute(self, c: &Connection) -> Result<Prepared<bool>, StoreError> {
        let owner = serde_json::to_string(&self.owner)?;
        ensure_room_writable(c, &owner, &self.session)?;
        let emoji = self.emoji.trim();
        if emoji.is_empty() || emoji.chars().count() > 16 || emoji.chars().any(char::is_control) {
            return Err(invalid("Room reaction emoji is invalid"));
        }
        let Some(existing) = get_raw(c, &owner, &self.session, &self.message_id)? else {
            return Err(invalid("Room message was not found"));
        };
        if existing.deleted_at.is_some() {
            return Err(invalid("Cannot react to a deleted Room message"));
        }
        let actor_key = self.actor.storage_key();
        let present: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_room_reactions WHERE owner=? AND session=? AND message=? AND actor=? AND emoji=?)",
            params![owner, self.session, self.message_id, actor_key, emoji],
            |row| row.get(0),
        )?;
        let should_add = self.add.unwrap_or(!present);
        let (changed, now_present) = if should_add {
            let n = c.execute(
                "INSERT OR IGNORE INTO agent_room_reactions(owner,session,message,actor,emoji,at) VALUES(?,?,?,?,?,?)",
                params![owner, self.session, self.message_id, actor_key, emoji, self.at.0],
            )?;
            (n > 0, true)
        } else {
            let n = c.execute(
                "DELETE FROM agent_room_reactions WHERE owner=? AND session=? AND message=? AND actor=? AND emoji=?",
                params![owner, self.session, self.message_id, actor_key, emoji],
            )?;
            (n > 0, false)
        };
        Ok(Prepared {
            value: now_present,
            changed,
            notification: if changed {
                Notification::METADATA.with_sessions([self.session])
            } else {
                Notification::NONE
            },
        })
    }

    fn committed(value: bool) -> bool {
        value
    }

    fn isolated_rejection(error: &StoreError) -> bool {
        isolated_rejection(error)
    }
}

pub struct PinStatement {
    owner: RunOwner,
    session: String,
    message_id: String,
    pinned: bool,
    at: UnixMillis,
}

impl Statement for PinStatement {
    type Value = bool;
    type Output = bool;

    fn execute(self, c: &Connection) -> Result<Prepared<bool>, StoreError> {
        let owner = serde_json::to_string(&self.owner)?;
        ensure_room_writable(c, &owner, &self.session)?;
        let Some(existing) = get_raw(c, &owner, &self.session, &self.message_id)? else {
            return Err(invalid("Room message was not found"));
        };
        if self.pinned && existing.deleted_at.is_some() {
            return Err(invalid("Cannot pin a deleted Room message"));
        }
        let changed = if self.pinned {
            c.execute(
                "INSERT OR IGNORE INTO agent_room_pins(owner,session,message,pinned_at) VALUES(?,?,?,?)",
                params![owner, self.session, self.message_id, self.at.0],
            )? > 0
        } else {
            c.execute(
                "DELETE FROM agent_room_pins WHERE owner=? AND session=? AND message=?",
                params![owner, self.session, self.message_id],
            )? > 0
        };
        Ok(Prepared {
            value: self.pinned,
            changed,
            notification: if changed {
                Notification::METADATA.with_sessions([self.session])
            } else {
                Notification::NONE
            },
        })
    }

    fn committed(value: bool) -> bool {
        value
    }

    fn isolated_rejection(error: &StoreError) -> bool {
        isolated_rejection(error)
    }
}

pub struct EditMessageStatement {
    owner: RunOwner,
    session: String,
    message_id: String,
    actor: RoomActor,
    text: String,
    at: UnixMillis,
}

impl Statement for EditMessageStatement {
    type Value = RoomMessage;
    type Output = RoomMessage;

    fn execute(self, c: &Connection) -> Result<Prepared<RoomMessage>, StoreError> {
        let owner = serde_json::to_string(&self.owner)?;
        ensure_room_writable(c, &owner, &self.session)?;
        let Some(mut existing) = get_raw(c, &owner, &self.session, &self.message_id)? else {
            return Err(invalid("Room message was not found"));
        };
        if existing.deleted_at.is_some() {
            return Err(invalid("Cannot edit a deleted Room message"));
        }
        if !can_mutate_message(&existing.author, &self.actor) {
            return Err(invalid(
                "Only the author or a human user may edit this Room message",
            ));
        }
        if self.text.trim().is_empty()
            && existing
                .content
                .attachments
                .as_ref()
                .is_none_or(Vec::is_empty)
        {
            return Err(invalid("Edited Room message cannot be empty"));
        }
        let edited_at = unsigned(self.at.0)?;
        existing.content.text = self.text;
        existing.content.display_text = None;
        existing.edited_at = Some(edited_at);
        c.execute(
            "UPDATE agent_room_messages SET body_json=?, edited_at=? WHERE owner=? AND session=? AND message=?",
            params![
                serde_json::to_string(&existing)?,
                self.at.0,
                owner,
                self.session,
                self.message_id,
            ],
        )?;
        enrich_messages(
            c,
            &owner,
            &self.session,
            std::slice::from_mut(&mut existing),
        )?;
        Ok(Prepared {
            value: existing,
            changed: true,
            notification: Notification::METADATA.with_sessions([self.session]),
        })
    }

    fn committed(value: RoomMessage) -> RoomMessage {
        value
    }

    fn isolated_rejection(error: &StoreError) -> bool {
        isolated_rejection(error)
    }
}

pub struct DeleteMessageStatement {
    owner: RunOwner,
    session: String,
    message_id: String,
    actor: RoomActor,
    at: UnixMillis,
}

impl Statement for DeleteMessageStatement {
    type Value = RoomMessage;
    type Output = RoomMessage;

    fn execute(self, c: &Connection) -> Result<Prepared<RoomMessage>, StoreError> {
        let owner = serde_json::to_string(&self.owner)?;
        ensure_room_writable(c, &owner, &self.session)?;
        let Some(mut existing) = get_raw(c, &owner, &self.session, &self.message_id)? else {
            return Err(invalid("Room message was not found"));
        };
        if !can_mutate_message(&existing.author, &self.actor) {
            return Err(invalid(
                "Only the author or a human user may delete this Room message",
            ));
        }
        if existing.deleted_at.is_some() {
            return Ok(Prepared {
                value: existing,
                changed: false,
                notification: Notification::NONE,
            });
        }
        let deleted_at = unsigned(self.at.0)?;
        existing.deleted_at = Some(deleted_at);
        existing.content.text.clear();
        existing.content.display_text = None;
        existing.content.attachments = None;
        c.execute(
            "UPDATE agent_room_messages SET body_json=?, deleted_at=? WHERE owner=? AND session=? AND message=?",
            params![
                serde_json::to_string(&existing)?,
                self.at.0,
                owner,
                self.session,
                self.message_id,
            ],
        )?;
        c.execute(
            "DELETE FROM agent_room_pins WHERE owner=? AND session=? AND message=?",
            params![owner, self.session, self.message_id],
        )?;
        c.execute(
            "DELETE FROM agent_room_reactions WHERE owner=? AND session=? AND message=?",
            params![owner, self.session, self.message_id],
        )?;
        enrich_messages(
            c,
            &owner,
            &self.session,
            std::slice::from_mut(&mut existing),
        )?;
        Ok(Prepared {
            value: existing,
            changed: true,
            notification: Notification::METADATA.with_sessions([self.session]),
        })
    }

    fn committed(value: RoomMessage) -> RoomMessage {
        value
    }

    fn isolated_rejection(error: &StoreError) -> bool {
        isolated_rejection(error)
    }
}

fn can_mutate_message(author: &RoomAuthor, actor: &RoomActor) -> bool {
    match (author, actor) {
        (_, RoomActor::Human) => true,
        (RoomAuthor::Session { execution }, RoomActor::Session { session_id }) => {
            execution.session_id == *session_id
        }
        (RoomAuthor::Human, RoomActor::Session { .. }) => false,
    }
}

fn ensure_room_writable(c: &Connection, owner: &str, session: &str) -> Result<(), StoreError> {
    let available: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_rooms r JOIN session_control s ON s.id=r.session WHERE r.owner=? AND r.session=? AND s.archived=0 AND NOT EXISTS(SELECT 1 FROM session_retirements d WHERE d.session_id=s.id AND d.remove_session=1))",
        params![owner, session],
        |row| row.get(0),
    )?;
    if !available {
        return Err(StoreError::SessionNotFound);
    }
    Ok(())
}

fn isolated_rejection(error: &StoreError) -> bool {
    matches!(
        error,
        StoreError::InvalidTransition(_) | StoreError::EventConflict | StoreError::SessionNotFound
    )
}

struct Exists(RunOwner, String);

impl Query for Exists {
    type Output = bool;

    fn execute(self, c: &Connection) -> Result<bool, StoreError> {
        exists(c, &serde_json::to_string(&self.0)?, &self.1)
    }
}

struct Get {
    owner: RunOwner,
    session: String,
    message_id: String,
}

struct Capture(RunOwner, String);

impl Query for Capture {
    type Output = u64;

    fn execute(self, c: &Connection) -> Result<u64, StoreError> {
        let owner = serde_json::to_string(&self.0)?;
        if !exists(c, &owner, &self.1)? {
            return Err(StoreError::SessionNotFound);
        }
        tail(c, &owner, &self.1)
    }
}

struct WatchWatermark(RunOwner, String);

fn watch_revision(c: &Connection, owner: &str, session: &str) -> Result<u64, StoreError> {
    let room_rev: Option<i64> = c
        .query_row(
            "SELECT revision FROM agent_rooms WHERE owner=? AND session=?",
            params![owner, session],
            |row| row.get(0),
        )
        .optional()?;
    let Some(room_rev) = room_rev else {
        return Err(StoreError::SessionNotFound);
    };
    // Fingerprint ONLY this Room's revision + its own members' live/blocked/pending/terminal/title
    // state so reactions or streaming in other Rooms never trigger cross-room refreshes.
    let mut hash: u64 = 0xcbf29ce484222325;
    let mix_u64 = |h: &mut u64, v: u64| {
        for b in v.to_le_bytes() {
            *h ^= u64::from(b);
            *h = h.wrapping_mul(0x100000001b3);
        }
    };
    let mix_bytes = |h: &mut u64, bytes: &[u8]| {
        for &b in bytes {
            *h ^= u64::from(b);
            *h = h.wrapping_mul(0x100000001b3);
        }
        *h ^= 0xff;
        *h = h.wrapping_mul(0x100000001b3);
    };
    mix_u64(&mut hash, unsigned(room_rev)?);
    let mut stmt = c.prepare_cached(
        "SELECT m.member_session,
                COALESCE(json_extract(s.configuration, '$.title'), s.id),
                COALESCE(s.archived, 0),
                EXISTS(SELECT 1 FROM agent_catalog_runs w WHERE w.owner=?1 AND w.session=m.member_session AND w.live=1),
                EXISTS(SELECT 1 FROM agent_catalog_runs w WHERE w.owner=?1 AND w.session=m.member_session AND w.live=1 AND w.blocked=1),
                (SELECT COUNT(*) FROM agent_interaction_pending p
                    JOIN agent_interaction_requests q ON q.request=p.request
                    JOIN agent_run_specs spec ON spec.run=q.run
                    JOIN agent_catalog_runs r ON r.run=q.run
                    WHERE p.session=m.member_session AND spec.owner=?1 AND r.live=1),
                COALESCE((SELECT r.admission_sequence FROM agent_catalog_runs r WHERE r.owner=?1 AND r.session=m.member_session ORDER BY r.admission_sequence DESC LIMIT 1), 0),
                COALESCE((SELECT r.stopped FROM agent_catalog_runs r WHERE r.owner=?1 AND r.session=m.member_session ORDER BY r.admission_sequence DESC LIMIT 1), 0),
                COALESCE((SELECT r.terminal FROM agent_catalog_runs r WHERE r.owner=?1 AND r.session=m.member_session ORDER BY r.admission_sequence DESC LIMIT 1), '')
         FROM agent_room_members m
         LEFT JOIN session_control s ON s.id=m.member_session
           AND NOT EXISTS(SELECT 1 FROM session_retirements d WHERE d.session_id=s.id AND d.remove_session=1)
         WHERE m.owner=?1 AND m.session=?2
         ORDER BY m.member_session ASC",
    )?;
    let rows = stmt.query_map(params![owner, session], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, i64>(5)?,
            r.get::<_, i64>(6)?,
            r.get::<_, i64>(7)?,
            r.get::<_, String>(8)?,
        ))
    })?;
    for row in rows {
        let (id, title, archived, live, blocked, pending, seq, stopped, terminal) = row?;
        mix_bytes(&mut hash, id.as_bytes());
        if let Some(t) = title {
            mix_bytes(&mut hash, t.as_bytes());
        }
        mix_u64(&mut hash, archived as u64);
        mix_u64(&mut hash, live as u64);
        mix_u64(&mut hash, blocked as u64);
        mix_u64(&mut hash, pending as u64);
        mix_u64(&mut hash, seq as u64);
        mix_u64(&mut hash, stopped as u64);
        mix_bytes(&mut hash, terminal.as_bytes());
    }
    // Mask to 53 bits so JSON -> JS number preserves exact equality.
    Ok(hash & ((1u64 << 53) - 1))
}

impl Query for WatchWatermark {
    type Output = (u64, u64);

    fn execute(self, c: &Connection) -> Result<(u64, u64), StoreError> {
        let owner = serde_json::to_string(&self.0)?;
        let revision = watch_revision(c, &owner, &self.1)?;
        let through = tail(c, &owner, &self.1)?;
        Ok((through, revision))
    }
}

impl Query for Get {
    type Output = Option<RoomMessage>;

    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let owner = serde_json::to_string(&self.owner)?;
        let Some(mut msg) = get_raw(c, &owner, &self.session, &self.message_id)? else {
            return Ok(None);
        };
        enrich_messages(c, &owner, &self.session, std::slice::from_mut(&mut msg))?;
        Ok(Some(msg))
    }
}

struct StateQuery {
    owner: RunOwner,
    session: String,
}

impl Query for StateQuery {
    type Output = RoomState;

    fn execute(self, c: &Connection) -> Result<RoomState, StoreError> {
        let owner = serde_json::to_string(&self.owner)?;
        if !exists(c, &owner, &self.session)? {
            return Err(StoreError::SessionNotFound);
        }
        let topic: String = c.query_row(
            "SELECT topic FROM agent_rooms WHERE owner=? AND session=?",
            params![owner, self.session],
            |row| row.get(0),
        )?;
        let members = load_members(c, &owner, &self.session)?;
        let mut pinned = load_pinned_messages(c, &owner, &self.session, None)?;
        enrich_messages(c, &owner, &self.session, &mut pinned)?;
        Ok(RoomState {
            session_id: self.session,
            topic,
            members,
            pinned,
        })
    }
}

struct ContextSnapshotQuery {
    owner: RunOwner,
    session: String,
    recent_limit: u32,
    extra_session_ids: Vec<String>,
}

impl Query for ContextSnapshotQuery {
    type Output = RoomContextSnapshot;

    fn execute(self, c: &Connection) -> Result<RoomContextSnapshot, StoreError> {
        let owner = serde_json::to_string(&self.owner)?;
        if !exists(c, &owner, &self.session)? {
            return Err(StoreError::SessionNotFound);
        }
        let topic: String = c.query_row(
            "SELECT topic FROM agent_rooms WHERE owner=? AND session=?",
            params![owner, self.session],
            |row| row.get(0),
        )?;
        let mut recent: Vec<RoomMessage> = c
            .prepare_cached(
                "SELECT body_json, edited_at, deleted_at FROM agent_room_messages WHERE owner=? AND session=? ORDER BY sequence DESC LIMIT ?",
            )?
            .query_map(params![owner, self.session, self.recent_limit], decode_row)?
            .collect::<Result<Vec<_>, _>>()?;
        recent.reverse();
        let has_earlier = recent.first().is_some_and(|m| m.sequence > 1);
        let pinned = load_pinned_messages(c, &owner, &self.session, Some(5))?;

        let mut member_ids = BTreeSet::new();
        for id in &self.extra_session_ids {
            member_ids.insert(id.clone());
        }
        for msg in recent.iter().chain(pinned.iter()) {
            collect_message_sessions(msg, &mut member_ids);
        }
        let roster = load_members(c, &owner, &self.session)?;
        let mut known_ids: HashSet<String> = roster.iter().map(|m| m.session_id.clone()).collect();
        let mut members = roster;
        let extra: Vec<String> = member_ids
            .into_iter()
            .filter(|id| known_ids.insert(id.clone()))
            .collect();
        if !extra.is_empty() {
            members.extend(resolve_participants(c, &owner, &extra, &HashMap::new())?);
        }
        Ok(RoomContextSnapshot {
            topic,
            members,
            pinned,
            recent,
            has_earlier,
        })
    }
}

struct SearchQuery {
    owner: RunOwner,
    session: String,
    query: String,
    limit: u32,
}

impl Query for SearchQuery {
    type Output = Vec<RoomSearchMatch>;

    fn execute(self, c: &Connection) -> Result<Vec<RoomSearchMatch>, StoreError> {
        let owner = serde_json::to_string(&self.owner)?;
        if !exists(c, &owner, &self.session)? {
            return Err(StoreError::SessionNotFound);
        }
        let needle = self.query.trim();
        if needle.is_empty() {
            return Ok(Vec::new());
        }
        let limit = self.limit.clamp(1, 100);
        let mut messages: Vec<RoomMessage> = if needle.chars().count() >= 3 {
            let escaped = format!(r#""{}""#, needle.replace('"', r#""""#));
            c.prepare_cached(
                "SELECT m.body_json, m.edited_at, m.deleted_at
                 FROM agent_room_search s
                 JOIN agent_room_search_docs d ON d.doc_id=s.rowid
                 JOIN agent_room_messages m ON m.owner=d.owner AND m.session=d.session AND m.message=d.message
                 WHERE d.owner=?1 AND d.session=?2 AND m.deleted_at IS NULL AND agent_room_search MATCH ?3
                 ORDER BY m.sequence DESC LIMIT ?4",
            )?
            .query_map(params![owner, self.session, escaped, limit], decode_row)?
            .collect::<Result<Vec<_>, _>>()?
        } else {
            c.prepare_cached(
                "SELECT body_json, edited_at, deleted_at
                 FROM agent_room_messages
                 WHERE owner=?1 AND session=?2 AND deleted_at IS NULL
                   AND instr(lower(COALESCE(json_extract(body_json, '$.content.text'), '')), lower(?3)) > 0
                 ORDER BY sequence DESC LIMIT ?4",
            )?
            .query_map(params![owner, self.session, needle, limit], decode_row)?
            .collect::<Result<Vec<_>, _>>()?
        };
        enrich_messages(c, &owner, &self.session, &mut messages)?;
        Ok(messages
            .into_iter()
            .map(|message| {
                let snippet = build_snippet(&message.content.text, needle);
                RoomSearchMatch { message, snippet }
            })
            .collect())
    }
}

struct Page {
    owner: RunOwner,
    session: String,
    through: Option<u64>,
    position: RoomPosition,
    limit: u32,
}

impl Query for Page {
    type Output = RoomPage;

    fn execute(self, c: &Connection) -> Result<RoomPage, StoreError> {
        let owner = serde_json::to_string(&self.owner)?;
        if self.limit == 0 {
            return Err(invalid("Room page limit must be positive"));
        }
        if !exists(c, &owner, &self.session)? {
            return Err(StoreError::SessionNotFound);
        }
        let latest = tail(c, &owner, &self.session)?;
        let through = self.through.unwrap_or(latest);
        if through > latest {
            return Err(invalid("Room history cut exceeds its message tail"));
        }
        let mut items = match self.position {
            RoomPosition::Around { message_id } => {
                let target = anchor(c, &owner, &self.session, &message_id, through)?;
                let half = u64::from(self.limit / 2);
                let before_limit = self.limit / 2;
                let mut before_items: Vec<RoomMessage> = if target > 1 && before_limit > 0 {
                    c.prepare_cached(
                        "SELECT body_json, edited_at, deleted_at FROM agent_room_messages WHERE owner=? AND session=? AND sequence>=1 AND sequence<? ORDER BY sequence DESC LIMIT ?",
                    )?
                    .query_map(
                        params![owner, self.session, integer(target)?, before_limit],
                        decode_row,
                    )?
                    .collect::<Result<Vec<_>, _>>()?
                } else {
                    Vec::new()
                };
                before_items.reverse();
                let remaining = self.limit.saturating_sub(before_items.len() as u32).max(1);
                let after_items: Vec<RoomMessage> = c
                    .prepare_cached(
                        "SELECT body_json, edited_at, deleted_at FROM agent_room_messages WHERE owner=? AND session=? AND sequence>=? AND sequence<=? ORDER BY sequence ASC LIMIT ?",
                    )?
                    .query_map(
                        params![
                            owner,
                            self.session,
                            integer(target)?,
                            integer(through)?,
                            remaining
                        ],
                        decode_row,
                    )?
                    .collect::<Result<Vec<_>, _>>()?;
                let _ = half;
                before_items.extend(after_items);
                before_items
            }
            position => {
                let mut from = 1;
                let mut until = through;
                let reverse = matches!(position, RoomPosition::Tail | RoomPosition::Before { .. });
                match position {
                    RoomPosition::Start | RoomPosition::Tail => {}
                    RoomPosition::Before { message_id } => {
                        until = anchor(c, &owner, &self.session, &message_id, through)? - 1;
                    }
                    RoomPosition::After { message_id } => {
                        from = anchor(c, &owner, &self.session, &message_id, through)? + 1;
                    }
                    RoomPosition::Message { message_id } => {
                        from = anchor(c, &owner, &self.session, &message_id, through)?;
                    }
                    RoomPosition::Around { .. } => unreachable!(),
                }
                let direction = if reverse { "DESC" } else { "ASC" };
                let sql = format!(
                    "SELECT body_json, edited_at, deleted_at FROM agent_room_messages WHERE owner=? AND session=? AND sequence>=? AND sequence<=? ORDER BY sequence {direction} LIMIT ?"
                );
                let mut rows = c
                    .prepare_cached(&sql)?
                    .query_map(
                        params![
                            owner,
                            self.session,
                            integer(from)?,
                            integer(until)?,
                            self.limit
                        ],
                        decode_row,
                    )?
                    .collect::<Result<Vec<_>, _>>()?;
                if reverse {
                    rows.reverse();
                }
                rows
            }
        };

        enrich_messages(c, &owner, &self.session, &mut items)?;

        let mut participant_ids = BTreeSet::new();
        for msg in &items {
            collect_message_sessions(msg, &mut participant_ids);
        }
        let roster_meta = load_roster_meta(c, &owner, &self.session)?;
        for id in roster_meta.keys() {
            participant_ids.insert(id.clone());
        }
        let ids: Vec<String> = participant_ids.into_iter().collect();
        let participants = resolve_participants(c, &owner, &ids, &roster_meta)?;

        let before = items
            .first()
            .filter(|m| m.sequence > 1)
            .map(|m| m.id.clone());
        let after = items
            .last()
            .filter(|m| m.sequence < through)
            .map(|m| m.id.clone());
        Ok(RoomPage {
            items,
            through,
            before,
            after,
            participants,
        })
    }
}

fn collect_message_sessions(msg: &RoomMessage, ids: &mut BTreeSet<String>) {
    if let RoomAuthor::Session { execution } = &msg.author {
        ids.insert(execution.session_id.clone());
    }
    for m in &msg.mentions {
        ids.insert(m.clone());
    }
    for d in &msg.deliveries {
        ids.insert(d.session_id().to_owned());
    }
    for r in &msg.reactions {
        for actor in &r.actors {
            if let RoomActor::Session { session_id } = actor {
                ids.insert(session_id.clone());
            }
        }
    }
}

fn decode_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RoomMessage> {
    let json: String = row.get(0)?;
    let edited_at: Option<i64> = row.get(1)?;
    let deleted_at: Option<i64> = row.get(2)?;
    let mut msg: RoomMessage = serde_json::from_str(&json).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;
    if let Some(ts) = edited_at.and_then(|v| u64::try_from(v).ok()) {
        msg.edited_at = Some(ts);
    }
    if let Some(ts) = deleted_at.and_then(|v| u64::try_from(v).ok()) {
        msg.deleted_at = Some(ts);
    }
    Ok(msg)
}

fn load_roster_meta(
    c: &Connection,
    owner: &str,
    session: &str,
) -> Result<HashMap<String, u64>, StoreError> {
    let mut map = HashMap::new();
    let mut stmt = c.prepare_cached(
        "SELECT member_session, added_at FROM agent_room_members WHERE owner=? AND session=? ORDER BY added_at ASC, member_session ASC",
    )?;
    let rows = stmt.query_map(params![owner, session], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    for row in rows {
        let (id, at) = row?;
        map.insert(id, unsigned(at)?);
    }
    Ok(map)
}

fn load_members(c: &Connection, owner: &str, session: &str) -> Result<Vec<RoomMember>, StoreError> {
    let mut ordered_ids = Vec::new();
    let mut roster_meta = HashMap::new();
    let mut stmt = c.prepare_cached(
        "SELECT member_session, added_at FROM agent_room_members WHERE owner=? AND session=? ORDER BY added_at ASC, member_session ASC",
    )?;
    let rows = stmt.query_map(params![owner, session], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    for row in rows {
        let (id, at) = row?;
        ordered_ids.push(id.clone());
        roster_meta.insert(id, unsigned(at)?);
    }
    resolve_participants(c, owner, &ordered_ids, &roster_meta)
}

fn resolve_participants(
    c: &Connection,
    owner: &str,
    ids: &[String],
    roster_meta: &HashMap<String, u64>,
) -> Result<Vec<RoomMember>, StoreError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut result = Vec::with_capacity(ids.len());
    let mut stmt = c.prepare_cached(
        "SELECT
            COALESCE(json_extract(s.configuration, '$.title'), s.id) AS title,
            json_extract(s.configuration, '$.appliedPreset.name') AS preset_name,
            COALESCE(json_extract(b.workspace_json, '$.path'), '') AS workspace_path,
            s.archived,
            EXISTS(SELECT 1 FROM agent_catalog_runs w WHERE w.owner=?1 AND w.session=s.id AND w.live=1) AS working,
            EXISTS(SELECT 1 FROM agent_catalog_runs w WHERE w.owner=?1 AND w.session=s.id AND w.live=1 AND w.blocked=1) AS blocked,
            (SELECT COUNT(*) FROM agent_interaction_pending p
                JOIN agent_interaction_requests q ON q.request=p.request
                JOIN agent_run_specs spec ON spec.run=q.run
                JOIN agent_catalog_runs r ON r.run=q.run
                WHERE p.session=s.id AND spec.owner=?1 AND r.live=1) AS pending_count
         FROM session_control s
         LEFT JOIN workspace_bindings b ON b.id=json_extract(s.configuration, '$.workspace.id')
         WHERE s.id=?2
           AND NOT EXISTS(SELECT 1 FROM session_retirements d WHERE d.session_id=s.id AND d.remove_session=1)",
    )?;
    for id in ids {
        let meta = roster_meta.get(id);
        let row = stmt
            .query_row(params![owner, id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, bool>(3)?,
                    r.get::<_, bool>(4)?,
                    r.get::<_, bool>(5)?,
                    r.get::<_, i64>(6)?,
                ))
            })
            .optional()?;
        if let Some((title, preset_name, workspace_path, archived, working, blocked, pending)) = row
        {
            let pending_interactions = u32::try_from(pending.max(0)).unwrap_or(u32::MAX);
            let activity = if blocked || pending_interactions > 0 {
                RoomParticipantActivity::Waiting
            } else if working {
                RoomParticipantActivity::Working
            } else {
                RoomParticipantActivity::Idle
            };
            result.push(RoomMember {
                session_id: id.clone(),
                title,
                preset_name,
                workspace_path,
                activity,
                pending_interactions,
                archived,
                unavailable: false,
                added_at: meta.copied(),
            });
        } else {
            result.push(RoomMember {
                session_id: id.clone(),
                title: short_session_label(id),
                preset_name: None,
                workspace_path: String::new(),
                activity: RoomParticipantActivity::Idle,
                pending_interactions: 0,
                archived: false,
                unavailable: true,
                added_at: meta.copied(),
            });
        }
    }
    Ok(result)
}

fn short_session_label(id: &str) -> String {
    if id.len() > 12 {
        format!("{}…", &id[..12])
    } else {
        id.to_owned()
    }
}

fn load_pinned_messages(
    c: &Connection,
    owner: &str,
    session: &str,
    limit: Option<u32>,
) -> Result<Vec<RoomMessage>, StoreError> {
    let items = if let Some(limit) = limit {
        let mut stmt = c.prepare_cached(
            "SELECT m.body_json, m.edited_at, m.deleted_at
             FROM agent_room_pins p
             JOIN agent_room_messages m ON m.owner=p.owner AND m.session=p.session AND m.message=p.message
             WHERE p.owner=? AND p.session=? AND m.deleted_at IS NULL
             ORDER BY p.pinned_at DESC, m.sequence DESC
             LIMIT ?",
        )?;
        stmt.query_map(params![owner, session, limit], decode_row)?
            .collect::<Result<Vec<_>, _>>()?
    } else {
        let mut stmt = c.prepare_cached(
            "SELECT m.body_json, m.edited_at, m.deleted_at
             FROM agent_room_pins p
             JOIN agent_room_messages m ON m.owner=p.owner AND m.session=p.session AND m.message=p.message
             WHERE p.owner=? AND p.session=? AND m.deleted_at IS NULL
             ORDER BY p.pinned_at DESC, m.sequence DESC",
        )?;
        stmt.query_map(params![owner, session], decode_row)?
            .collect::<Result<Vec<_>, _>>()?
    };
    Ok(items)
}

fn enrich_messages(
    c: &Connection,
    owner: &str,
    session: &str,
    messages: &mut [RoomMessage],
) -> Result<(), StoreError> {
    if messages.is_empty() {
        return Ok(());
    }
    // Load pins for this room.
    let mut pinned_set = HashSet::new();
    {
        let mut stmt =
            c.prepare_cached("SELECT message FROM agent_room_pins WHERE owner=? AND session=?")?;
        for row in stmt.query_map(params![owner, session], |r| r.get::<_, String>(0))? {
            pinned_set.insert(row?);
        }
    }
    // Load reactions for messages in this slice.
    let mut reaction_stmt = c.prepare_cached(
        "SELECT actor, emoji FROM agent_room_reactions WHERE owner=? AND session=? AND message=? ORDER BY at ASC, actor ASC",
    )?;
    // Claim only explicit reply_to responses so a reply to message m2 never cross-attributes to m1.
    let mut reply_stmt = c.prepare_cached(
        "SELECT message FROM agent_room_messages
         WHERE owner=?1 AND session=?2 AND sequence>?3 AND deleted_at IS NULL
           AND reply_to=?4
           AND json_extract(body_json, '$.author.execution.sessionId')=?5
         ORDER BY sequence ASC
         LIMIT 1",
    )?;
    let mut queue_stmt = c.prepare_cached(
        "SELECT q.state, r.live, r.blocked, r.stopped, r.terminal,
                (SELECT COUNT(*) FROM agent_interaction_pending p
                 JOIN agent_interaction_requests req ON req.request=p.request
                 WHERE p.session=q.session AND req.run=r.run) AS pending_count
         FROM agent_queue_items q
         LEFT JOIN agent_catalog_runs r ON r.run=COALESCE(q.accepted_run, q.target_run)
         WHERE q.session=?1 AND q.message=?2",
    )?;

    for msg in messages.iter_mut() {
        msg.pinned = pinned_set.contains(&msg.id);
        // Reactions grouped by emoji strictly preserving first-added insertion order.
        let mut reaction_index: HashMap<String, usize> = HashMap::new();
        let mut reactions: Vec<RoomReaction> = Vec::new();
        for row in reaction_stmt.query_map(params![owner, session, msg.id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })? {
            let (actor_key, emoji) = row?;
            let actor = RoomActor::from_storage_key(&actor_key);
            if let Some(&idx) = reaction_index.get(&emoji) {
                reactions[idx].actors.push(actor);
            } else {
                reaction_index.insert(emoji.clone(), reactions.len());
                reactions.push(RoomReaction {
                    emoji,
                    actors: vec![actor],
                });
            }
        }
        msg.reactions = reactions;

        // Derived delivery states from single-source-of-truth queue/run/room tables.
        let mut states = Vec::with_capacity(msg.deliveries.len());
        let seq = integer(msg.sequence)?;
        for delivery in &msg.deliveries {
            match delivery {
                RoomDelivery::Rejected { session_id, reason } => {
                    states.push(RoomDeliveryState::Rejected {
                        session_id: session_id.clone(),
                        reason: reason.clone(),
                    });
                }
                RoomDelivery::Accepted {
                    session_id: target_session,
                    message_id: delivered_message_id,
                } => {
                    if let Some(reply_id) = reply_stmt
                        .query_row(params![owner, session, seq, msg.id, target_session], |r| {
                            r.get::<_, String>(0)
                        })
                        .optional()?
                    {
                        states.push(RoomDeliveryState::Replied {
                            session_id: target_session.clone(),
                            message_id: delivered_message_id.clone(),
                            reply_message_id: reply_id,
                        });
                        continue;
                    }
                    let qrow = queue_stmt
                        .query_row(params![target_session, delivered_message_id], |r| {
                            Ok((
                                r.get::<_, String>(0)?,
                                r.get::<_, Option<bool>>(1)?,
                                r.get::<_, Option<bool>>(2)?,
                                r.get::<_, Option<bool>>(3)?,
                                r.get::<_, Option<String>>(4)?,
                                r.get::<_, Option<i64>>(5)?,
                            ))
                        })
                        .optional()?;
                    let state = match qrow {
                        Some((qstate, live, blocked, stopped, terminal_json, pending_count)) => {
                            match qstate.as_str() {
                                "pending" => RoomDeliveryState::Queued {
                                    session_id: target_session.clone(),
                                    message_id: delivered_message_id.clone(),
                                },
                                "cancelled" => RoomDeliveryState::Stopped {
                                    session_id: target_session.clone(),
                                    message_id: delivered_message_id.clone(),
                                },
                                _ => {
                                    let is_live = live.unwrap_or(false);
                                    let is_blocked = blocked.unwrap_or(false);
                                    let is_stopped = stopped.unwrap_or(false);
                                    let pending = u32::try_from(pending_count.unwrap_or(0).max(0))
                                        .unwrap_or(u32::MAX);
                                    let terminal = terminal_json
                                        .as_deref()
                                        .and_then(|s| serde_json::from_str::<Terminal>(s).ok());
                                    if is_live && (is_blocked || pending > 0) {
                                        RoomDeliveryState::Waiting {
                                            session_id: target_session.clone(),
                                            message_id: delivered_message_id.clone(),
                                            pending_count: pending.max(1),
                                        }
                                    } else if is_live {
                                        RoomDeliveryState::Working {
                                            session_id: target_session.clone(),
                                            message_id: delivered_message_id.clone(),
                                        }
                                    } else if matches!(terminal, Some(Terminal::Failed)) {
                                        RoomDeliveryState::Failed {
                                            session_id: target_session.clone(),
                                            message_id: delivered_message_id.clone(),
                                            reason: None,
                                        }
                                    } else if is_stopped
                                        || matches!(terminal, Some(Terminal::Cancelled))
                                    {
                                        RoomDeliveryState::Stopped {
                                            session_id: target_session.clone(),
                                            message_id: delivered_message_id.clone(),
                                        }
                                    } else if terminal.is_some() {
                                        if let Some(reacted_emoji) =
                                            msg.reactions.iter().find_map(|r| {
                                                r.actors
                                                    .iter()
                                                    .any(|a| {
                                                        matches!(
                                                            a,
                                                            RoomActor::Session { session_id }
                                                                if session_id == target_session
                                                        )
                                                    })
                                                    .then(|| r.emoji.clone())
                                            })
                                        {
                                            RoomDeliveryState::Reacted {
                                                session_id: target_session.clone(),
                                                message_id: delivered_message_id.clone(),
                                                emoji: reacted_emoji,
                                            }
                                        } else {
                                            RoomDeliveryState::Silent {
                                                session_id: target_session.clone(),
                                                message_id: delivered_message_id.clone(),
                                            }
                                        }
                                    } else {
                                        RoomDeliveryState::Queued {
                                            session_id: target_session.clone(),
                                            message_id: delivered_message_id.clone(),
                                        }
                                    }
                                }
                            }
                        }
                        None => RoomDeliveryState::Queued {
                            session_id: target_session.clone(),
                            message_id: delivered_message_id.clone(),
                        },
                    };
                    states.push(state);
                }
            }
        }
        msg.delivery_states = states;
    }
    Ok(())
}

fn build_snippet(text: &str, needle: &str) -> String {
    let single_line: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = single_line.to_lowercase();
    let needle_lower = needle.to_lowercase();
    if let Some(byte_pos) = lower.find(&needle_lower) {
        let char_pos = lower[..byte_pos].chars().count();
        let chars: Vec<char> = single_line.chars().collect();
        let start = char_pos.saturating_sub(36);
        let end = (char_pos + needle.chars().count() + 64).min(chars.len());
        let mut out = String::new();
        if start > 0 {
            out.push('…');
        }
        out.extend(&chars[start..end]);
        if end < chars.len() {
            out.push('…');
        }
        out
    } else {
        let mut out: String = single_line.chars().take(120).collect();
        if single_line.chars().count() > 120 {
            out.push('…');
        }
        out
    }
}

fn exists(c: &Connection, owner: &str, session: &str) -> Result<bool, StoreError> {
    Ok(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_rooms WHERE owner=? AND session=?)",
        params![owner, session],
        |row| row.get(0),
    )?)
}

fn get_raw(
    c: &Connection,
    owner: &str,
    session: &str,
    message_id: &str,
) -> Result<Option<RoomMessage>, StoreError> {
    c.query_row(
        "SELECT body_json, edited_at, deleted_at FROM agent_room_messages WHERE owner=? AND session=? AND message=?",
        params![owner, session, message_id],
        decode_row,
    )
    .optional()
    .map_err(StoreError::from)
}

fn anchor(
    c: &Connection,
    owner: &str,
    session: &str,
    message_id: &str,
    through: u64,
) -> Result<u64, StoreError> {
    message_sequence(c, owner, session, message_id)?
        .filter(|sequence| *sequence <= through)
        .ok_or_else(|| invalid("Room message is outside the history cut"))
}

fn message_sequence(
    c: &Connection,
    owner: &str,
    session: &str,
    message_id: &str,
) -> Result<Option<u64>, StoreError> {
    let sequence: Option<i64> = c
        .query_row(
            "SELECT sequence FROM agent_room_messages WHERE owner=? AND session=? AND message=?",
            params![owner, session, message_id],
            |row| row.get(0),
        )
        .optional()?;
    sequence.map(unsigned).transpose()
}

fn tail(c: &Connection, owner: &str, session: &str) -> Result<u64, StoreError> {
    let sequence: i64 = c.query_row(
        "SELECT COALESCE(MAX(sequence), 0) FROM agent_room_messages WHERE owner=? AND session=?",
        params![owner, session],
        |row| row.get(0),
    )?;
    unsigned(sequence)
}

fn integer(value: u64) -> Result<i64, StoreError> {
    i64::try_from(value).map_err(|_| invalid("Room sequence exceeds SQLite integer range"))
}

fn unsigned(value: i64) -> Result<u64, StoreError> {
    u64::try_from(value).map_err(|_| invalid("Room sequence cannot be negative"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::{
        durable::{ExecutionIdentity, RunId},
        input::MessageInput,
        room::RoomDelivery,
    };

    fn test_owner() -> RunOwner {
        RunOwner {
            deployment: uuid::Uuid::nil(),
            namespace: maka_plugin_core::composition::InstanceId(vec![uuid::Uuid::nil()]),
        }
    }

    fn open_db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.pragma_update(None, "foreign_keys", "ON").unwrap();
        let catalog: Vec<_> = maka_event_log::ROOT_MIGRATIONS
            .iter()
            .chain(crate::MIGRATIONS)
            .copied()
            .collect();
        maka_event_log::migration::run(&db, &catalog).unwrap();
        db
    }

    fn seed_session(db: &Connection, id: &str, title: &str) {
        let cfg = serde_json::json!({ "title": title }).to_string();
        db.execute(
            "INSERT INTO session_control(id, fingerprint, revision, created_at, updated_at, archived, configuration)
             VALUES(?1, 'fp', 1, 1, 1, 0, ?2)",
            params![id, cfg],
        )
        .unwrap();
    }

    fn exec_id(session_id: &str) -> ExecutionIdentity {
        ExecutionIdentity {
            session_id: session_id.to_owned(),
            run_id: RunId::new(),
            turn_id: "t1".into(),
        }
    }

    #[test]
    fn reactions_preserve_insertion_order_and_replies_do_not_cross_attribute() {
        let db = open_db();
        let owner = test_owner();
        seed_session(&db, "room_a", "Room A");
        seed_session(&db, "room_b", "Room B");
        seed_session(&db, "alice", "Alice");
        seed_session(&db, "bob", "Bob");

        CreateRoom {
            owner: owner.clone(),
            session: "room_a".into(),
        }
        .execute(&db)
        .unwrap();
        CreateRoom {
            owner: owner.clone(),
            session: "room_b".into(),
        }
        .execute(&db)
        .unwrap();

        // Post m1 & m2 both mentioning Alice; Alice replies explicitly to m2 only.
        PostStatement {
            owner: owner.clone(),
            post: Post {
                session: "room_a".into(),
                id: "m1".into(),
                at: UnixMillis(10),
                author: RoomAuthor::Human,
                content: MessageInput::from("first prompt".to_owned()),
                reply_to: None,
                mentions: vec!["alice".into()],
                deliveries: vec![RoomDelivery::Accepted {
                    session_id: "alice".into(),
                    message_id: "d1".into(),
                }],
            },
        }
        .execute(&db)
        .unwrap();
        PostStatement {
            owner: owner.clone(),
            post: Post {
                session: "room_a".into(),
                id: "m2".into(),
                at: UnixMillis(20),
                author: RoomAuthor::Human,
                content: MessageInput::from("second prompt".to_owned()),
                reply_to: None,
                mentions: vec!["alice".into()],
                deliveries: vec![RoomDelivery::Accepted {
                    session_id: "alice".into(),
                    message_id: "d2".into(),
                }],
            },
        }
        .execute(&db)
        .unwrap();
        PostStatement {
            owner: owner.clone(),
            post: Post {
                session: "room_a".into(),
                id: "m3".into(),
                at: UnixMillis(30),
                author: RoomAuthor::Session {
                    execution: exec_id("alice"),
                },
                content: MessageInput::from("reply to second".to_owned()),
                reply_to: Some("m2".into()),
                mentions: vec![],
                deliveries: vec![],
            },
        }
        .execute(&db)
        .unwrap();

        // Add multiple emojis from the same actor in reverse Unicode codepoint order: 🔥 then ✅ then 👍.
        for (i, emoji) in ["🔥", "✅", "👍"].into_iter().enumerate() {
            ReactStatement {
                owner: owner.clone(),
                session: "room_a".into(),
                message_id: "m1".into(),
                actor: RoomActor::Human,
                emoji: emoji.into(),
                add: Some(true),
                at: UnixMillis(100 + i as i64),
            }
            .execute(&db)
            .unwrap();
        }

        let page = Page {
            owner: owner.clone(),
            session: "room_a".into(),
            through: None,
            position: RoomPosition::Tail,
            limit: 10,
        }
        .execute(&db)
        .unwrap();
        let m1 = page.items.iter().find(|m| m.id == "m1").unwrap();
        let m2 = page.items.iter().find(|m| m.id == "m2").unwrap();
        let emojis: Vec<&str> = m1.reactions.iter().map(|r| r.emoji.as_str()).collect();
        assert_eq!(emojis, vec!["🔥", "✅", "👍"]);
        assert!(
            !matches!(
                m1.delivery_states.first(),
                Some(RoomDeliveryState::Replied { .. })
            ),
            "m3 replying to m2 must not cross-attribute to m1: {:?}",
            m1.delivery_states
        );
        assert!(
            matches!(
                m2.delivery_states.first(),
                Some(RoomDeliveryState::Replied { reply_message_id, .. }) if reply_message_id == "m3"
            ),
            "m2 should attribute explicit reply m3: {:?}",
            m2.delivery_states
        );

        // WatchWatermark isolation: reacting in Room B must not perturb Room A's watermark.
        PostStatement {
            owner: owner.clone(),
            post: Post {
                session: "room_b".into(),
                id: "mb1".into(),
                at: UnixMillis(40),
                author: RoomAuthor::Human,
                content: MessageInput::from("room b hello".to_owned()),
                reply_to: None,
                mentions: vec![],
                deliveries: vec![],
            },
        }
        .execute(&db)
        .unwrap();
        let wm_a_before = WatchWatermark(owner.clone(), "room_a".into())
            .execute(&db)
            .unwrap();
        ReactStatement {
            owner: owner.clone(),
            session: "room_b".into(),
            message_id: "mb1".into(),
            actor: RoomActor::Human,
            emoji: "🔥".into(),
            add: Some(true),
            at: UnixMillis(200),
        }
        .execute(&db)
        .unwrap();
        let wm_a_after = WatchWatermark(owner.clone(), "room_a".into())
            .execute(&db)
            .unwrap();
        assert_eq!(
            wm_a_before, wm_a_after,
            "Room B reaction must not churn Room A watch watermark"
        );

        // Multi-member add + remove deletes all requested IDs in one call.
        AddMembersStatement {
            owner: owner.clone(),
            session: "room_a".into(),
            member_sessions: vec!["alice".into(), "bob".into()],
            at: UnixMillis(300),
        }
        .execute(&db)
        .unwrap();
        let removed = RemoveMembersStatement {
            owner: owner.clone(),
            session: "room_a".into(),
            member_sessions: vec!["alice".into(), "bob".into()],
        }
        .execute(&db)
        .unwrap()
        .value;
        assert_eq!(removed, vec!["alice", "bob"]);
    }

    #[test]
    fn fts_uses_rowid_lookup_and_syncs_edits_and_deletes() {
        let db = open_db();
        let owner = test_owner();
        let owner_json = serde_json::to_string(&owner).unwrap();
        seed_session(&db, "room_search", "Search Room");
        CreateRoom {
            owner: owner.clone(),
            session: "room_search".into(),
        }
        .execute(&db)
        .unwrap();
        PostStatement {
            owner: owner.clone(),
            post: Post {
                session: "room_search".into(),
                id: "m1".into(),
                at: UnixMillis(1000),
                author: RoomAuthor::Human,
                content: MessageInput::from("alpha bravo charlie".to_owned()),
                reply_to: None,
                mentions: vec![],
                deliveries: vec![],
            },
        }
        .execute(&db)
        .unwrap();

        let hits = SearchQuery {
            owner: owner.clone(),
            session: "room_search".into(),
            query: "bravo".into(),
            limit: 10,
        }
        .execute(&db)
        .unwrap();
        assert_eq!(hits.len(), 1);

        EditMessageStatement {
            owner: owner.clone(),
            session: "room_search".into(),
            message_id: "m1".into(),
            actor: RoomActor::Human,
            text: "updated keyword zebra".into(),
            at: UnixMillis(2000),
        }
        .execute(&db)
        .unwrap();
        assert!(
            SearchQuery {
                owner: owner.clone(),
                session: "room_search".into(),
                query: "bravo".into(),
                limit: 10,
            }
            .execute(&db)
            .unwrap()
            .is_empty()
        );
        assert_eq!(
            SearchQuery {
                owner: owner.clone(),
                session: "room_search".into(),
                query: "zebra".into(),
                limit: 10,
            }
            .execute(&db)
            .unwrap()
            .len(),
            1
        );

        DeleteMessageStatement {
            owner: owner.clone(),
            session: "room_search".into(),
            message_id: "m1".into(),
            actor: RoomActor::Human,
            at: UnixMillis(3000),
        }
        .execute(&db)
        .unwrap();
        assert!(
            SearchQuery {
                owner: owner.clone(),
                session: "room_search".into(),
                query: "zebra".into(),
                limit: 10,
            }
            .execute(&db)
            .unwrap()
            .is_empty()
        );

        let plan: Vec<String> = db
            .prepare(
                "EXPLAIN QUERY PLAN DELETE FROM agent_room_search
                 WHERE rowid = (SELECT doc_id FROM agent_room_search_docs WHERE owner=?1 AND session=?2 AND message=?3)",
            )
            .unwrap()
            .query_map(params![owner_json, "room_search", "m1"], |r| r.get::<_, String>(3))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let plan_str = plan.join(" | ");
        assert!(
            plan_str.contains("VIRTUAL TABLE INDEX 0:="),
            "FTS rowid delete must seek by integer rowid (=), not full-scan: {plan_str}"
        );
    }

    #[test]
    fn plain_posts_keep_watch_revision_stable_while_retractions_and_agent_replies_advance_it() {
        let db = open_db();
        let owner = test_owner();
        seed_session(&db, "room_sync", "Sync Room");
        seed_session(&db, "alice", "Alice");
        CreateRoom {
            owner: owner.clone(),
            session: "room_sync".into(),
        }
        .execute(&db)
        .unwrap();
        AddMembersStatement {
            owner: owner.clone(),
            session: "room_sync".into(),
            member_sessions: vec!["alice".into()],
            at: UnixMillis(5),
        }
        .execute(&db)
        .unwrap();

        PostStatement {
            owner: owner.clone(),
            post: Post {
                session: "room_sync".into(),
                id: "m1".into(),
                at: UnixMillis(10),
                author: RoomAuthor::Human,
                content: MessageInput::from("first".to_owned()),
                reply_to: None,
                mentions: vec![],
                deliveries: vec![],
            },
        }
        .execute(&db)
        .unwrap();
        let wm1 = WatchWatermark(owner.clone(), "room_sync".into())
            .execute(&db)
            .unwrap();
        assert_eq!(wm1.0, 1);

        // Plain unthreaded post and human reply advance through without bumping revision so long timelines avoid full rescans.
        PostStatement {
            owner: owner.clone(),
            post: Post {
                session: "room_sync".into(),
                id: "m2".into(),
                at: UnixMillis(20),
                author: RoomAuthor::Human,
                content: MessageInput::from("second plain post".to_owned()),
                reply_to: None,
                mentions: vec![],
                deliveries: vec![],
            },
        }
        .execute(&db)
        .unwrap();
        let wm2 = WatchWatermark(owner.clone(), "room_sync".into())
            .execute(&db)
            .unwrap();
        assert_eq!(wm2, (2, wm1.1));

        PostStatement {
            owner: owner.clone(),
            post: Post {
                session: "room_sync".into(),
                id: "m3".into(),
                at: UnixMillis(25),
                author: RoomAuthor::Human,
                content: MessageInput::from("human reply".to_owned()),
                reply_to: Some("m2".into()),
                mentions: vec![],
                deliveries: vec![],
            },
        }
        .execute(&db)
        .unwrap();
        let wm3 = WatchWatermark(owner.clone(), "room_sync".into())
            .execute(&db)
            .unwrap();
        assert_eq!(wm3, (3, wm1.1));

        // Retracting m1 keeps through=3 while advancing revision so subscribers refresh visible rows.
        DeleteMessageStatement {
            owner: owner.clone(),
            session: "room_sync".into(),
            message_id: "m1".into(),
            actor: RoomActor::Human,
            at: UnixMillis(30),
        }
        .execute(&db)
        .unwrap();
        let wm4 = WatchWatermark(owner.clone(), "room_sync".into())
            .execute(&db)
            .unwrap();
        assert_eq!(wm4.0, 3);
        assert_ne!(wm4.1, wm3.1);

        // Agent threaded reply bumps revision so the parent message's delivery chip transitions to replied.
        PostStatement {
            owner: owner.clone(),
            post: Post {
                session: "room_sync".into(),
                id: "m4".into(),
                at: UnixMillis(40),
                author: RoomAuthor::Session {
                    execution: exec_id("alice"),
                },
                content: MessageInput::from("agent threaded reply".to_owned()),
                reply_to: Some("m2".into()),
                mentions: vec![],
                deliveries: vec![],
            },
        }
        .execute(&db)
        .unwrap();
        let wm5 = WatchWatermark(owner.clone(), "room_sync".into())
            .execute(&db)
            .unwrap();
        assert_eq!(wm5.0, 4);
        assert_ne!(wm5.1, wm4.1);
    }
}
