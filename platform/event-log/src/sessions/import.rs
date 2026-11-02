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

//! Complete imports and Session publication share one atomic transaction.
//! Only publication creates the Session; imports never rewrite an old log fence.
use super::{PluginSession, origin, validate_id, validate_time};
use crate::{EventLog, StoreError};
use maka_agent_facts::artifact::content_digest;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::import::Record;
use maka_agent_facts::import::Source;
use serde::{Serialize, de::DeserializeOwned};
use sqlx::{Connection, SqliteConnection};
use std::time::{Duration, UNIX_EPOCH};

impl EventLog {
    /// Published imports in one embedding-owned Session namespace. No foreign
    /// Session configuration is decoded, and the cursor never broadens the scope.
    pub async fn imported_sessions<T: DeserializeOwned + Send + 'static>(
        &self,
        prefix: &str,
        after: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<super::SessionRecord<T>>, Option<String>), StoreError> {
        self.validate_root()?;
        if prefix.is_empty() || !(1..=16).contains(&limit) {
            return Err(invalid("invalid import history query"));
        }
        if let Some(after) = after {
            validate_id(after)?;
            if !after.starts_with(prefix) {
                return Err(invalid("foreign import cursor"));
            }
        }
        let prefix = prefix.to_owned();
        let after = after.map(str::to_owned);
        self.connection.run(move |connection| Box::pin(async move {
            let mut tx = connection.begin().await?;
            let anchor: Option<i64> = if let Some(after) = &after {
                Some(sqlx::query_scalar("SELECT created_at FROM session_imports WHERE session_id=? AND state='published'")
                    .bind(after).fetch_optional(&mut *tx).await?.ok_or(StoreError::SessionNotFound)?)
            } else { None };
            let ids: Vec<String> = sqlx::query_scalar(
                "SELECT i.session_id FROM session_imports i JOIN session_control s ON s.id=i.session_id
                 WHERE instr(i.session_id,?1)=1 AND i.state='published'
                 AND (?2 IS NULL OR i.created_at<?2 OR (i.created_at=?2 AND i.session_id<?3))
                 AND NOT EXISTS (SELECT 1 FROM session_retirements r WHERE r.session_id=i.session_id AND r.remove_session=1)
                 ORDER BY i.created_at DESC,i.session_id DESC LIMIT ?4"
            ).bind(prefix).bind(anchor).bind(after).bind((limit+1) as i64).fetch_all(&mut *tx).await?;
            let next = (ids.len()>limit).then(|| ids[limit-1].clone());
            let mut records = Vec::with_capacity(limit);
            for id in ids.into_iter().take(limit) {
                records.push(super::read(&mut tx, &id).await?.ok_or(StoreError::SessionNotFound)?);
            }
            Ok((records, next))
        })).await
    }

    /// The complete conversion and Session publication share one writer
    /// transaction. A failed record leaves neither a partial log nor a Session.
    /// The same bound origin validates an exact retry against canonical records.
    pub async fn import_session<T: Serialize + DeserializeOwned + Send + 'static>(
        &self,
        owner: &PluginSession,
        source: &Source,
        configuration: &T,
        records: Vec<Record>,
        now: u64,
    ) -> Result<super::SessionRecord<T>, StoreError> {
        self.validate_root()?;
        owner.validate()?;
        if owner.fingerprint.is_empty() {
            return Err(invalid("invalid import fingerprint"));
        }
        source.validate().map_err(invalid)?;
        validate_time(now)?;
        if records.is_empty() || !records.iter().any(Record::is_conversation) {
            return Err(invalid("invalid complete import"));
        }
        for record in &records {
            record.validate().map_err(invalid)?;
        }
        let configuration = serde_json::to_string(configuration)?;
        let source = serde_json::to_string(source)?;
        let owner = owner.clone();
        let commits = self.commits.session(&owner.session_id);
        self.connection.run(move |connection| Box::pin(async move {
            let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
            let previous: Option<(String, String, String, i64)> = sqlx::query_as(
                "SELECT source_json, configuration, state, records FROM session_imports WHERE session_id=?"
            ).bind(&owner.session_id).fetch_optional(&mut *tx).await?;
            if let Some((previous_source, previous_configuration, state, count)) = previous {
                origin::check(&mut tx, &owner.session_id, Some(&owner)).await?;
                if (previous_source, previous_configuration) != (source, configuration) || state != "published"
                    || crate::sequence_number(count)? != records.len() as u64
                {
                    return Err(StoreError::SessionConflict);
                }
                // append's exact-retry path also verifies original event digests.
                append(&mut tx, &owner.session_id, records, true).await?;
                return super::read(&mut tx, &owner.session_id).await?.ok_or(StoreError::SessionNotFound);
            }
            let occupied: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM session_control WHERE id=?1
                    UNION ALL SELECT 1 FROM session_retirements WHERE session_id=?1
                    UNION ALL SELECT 1 FROM session_history_copies WHERE session_id=?1
                    UNION ALL SELECT 1 FROM context_source_prefixes WHERE kind='session' AND owner=?1)"
            ).bind(&owner.session_id).fetch_one(&mut *tx).await?;
            if occupied { return Err(StoreError::SessionConflict); }
            // Published retries above verify the original records before any new
            // cross-record admission rule. Only a new complete import is checked.
            {
                let mut calls = std::collections::HashSet::new();
                for record in &records {
                    if let maka_agent_facts::import::Content::ToolCall { call_id, .. } = &record.content
                        && !calls.insert(call_id.as_str())
                    {
                        return Err(invalid("duplicate imported tool call identity"));
                    }
                }
            }
            origin::insert(&mut tx, &owner).await?;
            sqlx::query("INSERT INTO session_imports(session_id,source_json,configuration,created_at,state,records,bytes,conversation)
                VALUES(?,?,?,?,'collecting',0,0,0)")
                .bind(&owner.session_id).bind(source).bind(&configuration).bind(now as i64)
                .execute(&mut *tx).await?;
            let through = append(&mut tx, &owner.session_id, records, false).await?;
            sqlx::query("UPDATE session_imports SET state='published' WHERE session_id=?")
                .bind(&owner.session_id).execute(&mut *tx).await?;
            super::insert(&mut tx, &owner.session_id, &owner.fingerprint, &configuration, now).await?;
            let record = super::read(&mut tx, &owner.session_id).await?.ok_or(StoreError::SessionNotFound)?;
            tx.commit().await.map_err(StoreError::CommitUnknown)?;
            if let Some(sequence) = through { commits.publish(sequence); }
            Ok(record)
        })).await
    }
}

async fn append(
    connection: &mut SqliteConnection,
    session: &str,
    records: Vec<Record>,
    replay: bool,
) -> Result<Option<u64>, StoreError> {
    let (source, now): (String, i64) =
        sqlx::query_as("SELECT source_json,created_at FROM session_imports WHERE session_id=?")
            .bind(session)
            .fetch_one(&mut *connection)
            .await?;
    let source: Source = serde_json::from_str(&source)?;
    let mut last = None;
    let mut bytes = 0;
    for (index, record) in records.into_iter().enumerate() {
        let event_id = identity(session, "message", &index.to_string());
        let conversation = record.is_conversation();
        let event = RuntimeEvent {
            id: event_id.clone(),
            invocation: Invocation {
                session_id: session.to_owned(),
                turn_id: identity(session, "turn", &record.source_turn_id),
                run_id: identity(session, "run", &index.to_string()),
                invocation_id: identity(session, "record", &index.to_string()),
            },
            recorded_at: UNIX_EPOCH + Duration::from_millis(now as u64),
            fact: Fact::MessageImported {
                source: source.clone(),
                record: Box::new(record),
            },
        };
        let json = serde_json::to_string(&event)?;
        if replay {
            let prior: (Option<String>, Option<String>) =
                sqlx::query_as("SELECT event_header,body_digest FROM event_log WHERE event_id=?")
                    .bind(event_id)
                    .fetch_one(&mut *connection)
                    .await?;
            let digest = prior
                .0
                .map(|body| content_digest(body.as_bytes()))
                .or(prior.1);
            if digest.as_deref() != Some(content_digest(json.as_bytes()).as_str()) {
                return Err(StoreError::EventConflict);
            }
            continue;
        }
        bytes += json.len() as u64;
        let sequence = crate::append::ingress::insert(
            connection,
            &event,
            json,
            crate::append::ingress::Position::Imported(None),
        )
        .await?;
        last = Some(sequence);
        super::project_execution(connection, sequence).await?;
        sqlx::query("UPDATE session_imports SET records=records+1,bytes=?,conversation=conversation+? WHERE session_id=?")
                    .bind(bytes as i64).bind(i64::from(conversation)).bind(session).execute(&mut *connection).await?;
    }
    Ok(last)
}

fn identity(session: &str, kind: &str, key: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    for part in ["maka.import.v1", session, kind, key] {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part.as_bytes());
    }
    format!("import-{}", hex::encode(hash.finalize()))
}

fn invalid(message: &'static str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}
