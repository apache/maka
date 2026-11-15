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
    durable::{RunOwner, UnixMillis},
    input::MessageInput,
    room::{RoomAuthor, RoomDelivery, RoomMessage, RoomPage, RoomPosition},
};
use maka_event_log::{
    StoreError,
    connection::Query,
    root_store::DataWriter,
    writeback::{Notification, Prepared, Statement},
};
use rusqlite::{Connection, OptionalExtension, params};

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
        };
        if let Some(existing) = get(c, &owner, &session, &message.id)? {
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
        let available: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_rooms r JOIN session_control s ON s.id=r.session WHERE r.owner=? AND r.session=? AND s.archived=0 AND NOT EXISTS(SELECT 1 FROM session_retirements d WHERE d.session_id=s.id AND d.remove_session=1))",
            params![owner, session],
            |row| row.get(0),
        )?;
        if !available {
            return Err(StoreError::SessionNotFound);
        }
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

impl Query for Get {
    type Output = Option<RoomMessage>;

    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        get(
            c,
            &serde_json::to_string(&self.owner)?,
            &self.session,
            &self.message_id,
        )
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
        let mut from = 1;
        let mut until = through;
        let reverse = matches!(
            self.position,
            RoomPosition::Tail | RoomPosition::Before { .. }
        );
        match self.position {
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
        }
        let direction = if reverse { "DESC" } else { "ASC" };
        let sql = format!(
            "SELECT body_json FROM agent_room_messages WHERE owner=? AND session=? AND sequence>=? AND sequence<=? ORDER BY sequence {direction} LIMIT ?"
        );
        let records = c
            .prepare_cached(&sql)?
            .query_map(
                params![
                    owner,
                    self.session,
                    integer(from)?,
                    integer(until)?,
                    self.limit
                ],
                |row| row.get::<_, String>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let mut items = records
            .iter()
            .map(|json| serde_json::from_str::<RoomMessage>(json))
            .collect::<Result<Vec<_>, _>>()?;
        if reverse {
            items.reverse();
        }
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
        })
    }
}

fn exists(c: &Connection, owner: &str, session: &str) -> Result<bool, StoreError> {
    Ok(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_rooms WHERE owner=? AND session=?)",
        params![owner, session],
        |row| row.get(0),
    )?)
}

fn get(
    c: &Connection,
    owner: &str,
    session: &str,
    message_id: &str,
) -> Result<Option<RoomMessage>, StoreError> {
    let json: Option<String> = c
        .query_row(
            "SELECT body_json FROM agent_room_messages WHERE owner=? AND session=? AND message=?",
            params![owner, session, message_id],
            |row| row.get(0),
        )
        .optional()?;
    json.map(|json| serde_json::from_str(&json).map_err(StoreError::from))
        .transpose()
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
    unsigned(c.query_row(
        "SELECT COALESCE(MAX(sequence),0) FROM agent_room_messages WHERE owner=? AND session=?",
        params![owner, session],
        |row| row.get(0),
    )?)
}

fn integer(value: u64) -> Result<i64, StoreError> {
    i64::try_from(value).map_err(|_| invalid("Room position exceeds SQLite range"))
}

fn unsigned(value: i64) -> Result<u64, StoreError> {
    u64::try_from(value).map_err(|_| invalid("negative Room position or timestamp"))
}
