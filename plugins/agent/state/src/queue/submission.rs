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

use super::*;
use maka_agent_facts::message::WithdrawalResult;
use rusqlite::{OptionalExtension, params};

#[derive(Clone)]
pub struct SubmissionKey {
    pub session: String,
    pub digest: [u8; 32],
}
impl SubmissionKey {
    pub fn current(&self, c: &Connection) -> Result<Option<String>, StoreError> {
        // A missing queue projection for a recorded attempt is corruption, not
        // permission to enqueue a second time. The LEFT JOIN keeps that distinction.
        let row: Option<(String, String)> = c
            .prepare_cached(
                "SELECT s.message, q.state FROM agent_message_submissions s
             LEFT JOIN agent_queue_items q ON q.session=s.session AND q.message=s.message
             WHERE s.session=?1 AND s.key_digest=?2",
            )?
            .query_row(params![self.session, self.digest], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional()?;
        Ok(row.and_then(|(id, state)| (state != "cancelled").then_some(id)))
    }
    pub fn record(&self, c: &Connection, message: &str) -> Result<(), StoreError> {
        c.prepare_cached(
            "INSERT INTO agent_message_submissions(session,key_digest,message) VALUES(?1,?2,?3)
            ON CONFLICT(session,key_digest) DO UPDATE SET message=excluded.message",
        )?
        .execute(rusqlite::params![self.session, self.digest, message])?;
        Ok(())
    }
}
impl Query for SubmissionKey {
    type Output = Option<String>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        self.current(c)
    }
}

/// Resolve and retract the one attempt on the same Root writer as queue consumption.
pub struct WithdrawMessage {
    pub session: String,
    pub message: String,
    pub command: FactId,
    pub at: UnixMillis,
}

impl Statement for WithdrawMessage {
    type Value = WithdrawalResult;
    type Output = WithdrawalResult;
    fn execute(self, c: &Connection) -> Result<Prepared<Self::Value>, StoreError> {
        let row: Option<(String, String)> = c
            .prepare_cached(
                "SELECT state,request FROM agent_queue_items WHERE session=?1 AND message=?2",
            )?
            .query_row(params![self.session, self.message], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?;
        let (state, request) =
            row.ok_or_else(|| StoreError::InvalidTransition("agent_submission_not_found".into()))?;
        let result = match state.as_str() {
            "delivered" => WithdrawalResult::Delivered,
            "cancelled" => WithdrawalResult::Cancelled,
            "pending" => {
                let command = QueueCommand {
                    id: self.command,
                    expected_revision: sql::revision(c, &self.session)?,
                    edit: QueueEdit::Retract {
                        request: RequestId(request),
                    },
                    at: self.at,
                };
                let (_, changed) = sql::write(c, &self.session, command, Vec::new(), None)?;
                return Ok(Prepared {
                    value: WithdrawalResult::Cancelled,
                    changed,
                    notification: Notification::METADATA.with_sessions([self.session]),
                });
            }
            _ => {
                return Err(StoreError::InvalidTransition(
                    "invalid queue delivery state".into(),
                ));
            }
        };
        Ok(Prepared {
            value: result,
            changed: false,
            notification: Notification::NONE,
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        PreparedEnqueue::isolated_rejection(error)
    }
}
