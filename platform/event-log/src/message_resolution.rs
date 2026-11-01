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

//! Exact message resolution from one SQL snapshot; absence proves neither cancellation nor delivery.
use crate::{EventLog, StoreError};
use maka_agent_facts::event::Invocation;
use sqlx::Connection;
use std::collections::HashSet;

pub(crate) mod owner;
pub use owner::MessageExecution;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MessageResolution {
    /// No durable message evidence in this existing Session's SQL snapshot.
    /// Host must also exclude in-flight preparation before asserting non-admission.
    Absent {
        message_id: String,
    },
    Pending {
        message_id: String,
    },
    Cancelled {
        message_id: String,
    },
    Owned {
        message_id: String,
        invocation: Invocation,
    },
}

impl EventLog {
    pub async fn message_resolutions(
        &self,
        session: &str,
        messages: &[String],
    ) -> Result<Vec<MessageResolution>, StoreError> {
        self.validate_root()?;
        crate::sessions::validate_id(session)?;
        if messages.iter().collect::<HashSet<_>>().len() != messages.len() {
            return Err(StoreError::InvalidTransition(
                "invalid message query identities".into(),
            ));
        }
        for message in messages {
            crate::sessions::validate_id(message)?;
        }
        let session = session.to_owned();
        let messages = messages.to_vec();
        self.connection.run(move |connection| Box::pin(async move {
            let mut tx = connection.begin().await?;
            let mut resolutions = Vec::new();
            let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM session_control WHERE id = ?)")
                .bind(&session).fetch_one(&mut *tx).await?;
            if !exists { return Ok(resolutions); }
            for message_id in messages {
                let owner: Option<String> = sqlx::query_scalar(
                    "SELECT json_extract(e.event_header, '$.invocation')
                     FROM message_sources s JOIN runtime_events e ON e.event_id = s.event_id
                     WHERE s.session_id = ? AND s.message_id = ?"
                ).bind(&session).bind(&message_id).fetch_optional(&mut *tx).await?;
                let resolution = if let Some(owner) = owner {
                    let owner: Invocation = serde_json::from_str(&owner)?;
                    if owner.session_id != session {
                        return Err(StoreError::InvalidTransition("message owner Session changed".into()));
                    }
                    let latest = crate::turns::read(&mut tx, &session, Some(&owner.turn_id)).await?
                        .ok_or_else(|| StoreError::InvalidTransition("message owner has no Turn".into()))?;
                    MessageResolution::Owned { message_id, invocation: latest.root_invocation().clone() }
                } else if crate::message_queue::cancelled(&mut tx, &session, &message_id).await? {
                    MessageResolution::Cancelled { message_id }
                } else {
                    let pending: bool = sqlx::query_scalar(
                        "SELECT EXISTS(SELECT 1 FROM message_admissions WHERE session_id = ? AND message_id = ?)"
                    ).bind(&session).bind(&message_id).fetch_one(&mut *tx).await?;
                    if pending { MessageResolution::Pending { message_id } }
                    else { MessageResolution::Absent { message_id } }
                };
                resolutions.push(resolution);
            }
            Ok(resolutions)
        })).await
    }
}
