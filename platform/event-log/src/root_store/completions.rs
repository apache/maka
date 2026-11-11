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
//! Native-dispatcher private records in the existing plugin_data namespace.
//! Keys are immutable task identities, never revision-addressed plugin objects.
//! Physical retirement is safe here and keeps polling independent of past tasks;
//! ordinary plugin KV clients retain their existing tombstone/CAS semantics.
use super::RootStore;
use crate::StoreError;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

const PACKAGE: &str = "maka.agent.completions";

#[derive(Serialize, Deserialize)]
pub struct Completion {
    #[serde(skip)]
    pub key: String,
    pub session_id: String,
    pub message_id: String,
    pub recipient: String,
    pub request: serde_json::Value,
    pub notification: Option<serde_json::Value>,
}
fn owner_prefix(owner: &str) -> String {
    format!("v1/{}/", hex::encode(owner))
}
fn recipient_prefix(owner: &str, session: &str, recipient: &str) -> String {
    format!(
        "{}{}/{}/",
        owner_prefix(owner),
        hex::encode(session),
        hex::encode(recipient)
    )
}
fn read(db: &Connection, key: &str) -> Result<Option<Completion>, StoreError> {
    let value: Option<String> = db.query_row(
        "SELECT value_json FROM plugin_data WHERE package_id=? AND scope_id='profile' AND key=?",
        rusqlite::params![PACKAGE, key], |r| r.get(0),
    ).optional()?;
    value
        .map(|value| {
            let mut entry: Completion = serde_json::from_str(&value)?;
            entry.key = key.to_owned();
            Ok(entry)
        })
        .transpose()
}
impl RootStore {
    /// Called after message admission. Failure must not resend or reject that task.
    pub async fn register_message_completion(
        &self,
        owner: &str,
        session: &str,
        message: &str,
        recipient: &str,
        request: serde_json::Value,
    ) -> Result<(), StoreError> {
        self.require_open()?;
        for id in [owner, session, message, recipient] {
            crate::sessions::validate_id(id)?;
        }
        let entry = Completion {
            key: format!(
                "{}{}",
                recipient_prefix(owner, session, recipient),
                hex::encode(message)
            ),
            session_id: session.into(),
            message_id: message.into(),
            recipient: recipient.into(),
            request,
            notification: None,
        };
        let commits = self.log.commits.notice();
        self.log.connection.run(move |db| {
            let tx = rusqlite::Transaction::new_unchecked(db, rusqlite::TransactionBehavior::Immediate)?;
            if let Some(existing) = read(&tx, &entry.key)? {
                if existing.request != entry.request {
                    return Err(StoreError::InvalidTransition("completion subscription identity changed".into()));
                }
                return Ok(());
            }
            tx.execute(
                "INSERT INTO plugin_data(package_id,scope_id,key,revision,value_json) VALUES (?,'profile',?,1,?)",
                rusqlite::params![PACKAGE, entry.key, serde_json::to_string(&entry)?],
            )?;
            tx.commit().map_err(StoreError::CommitUnknown)?;
            commits.metadata();
            Ok(())
        }).await
    }
    pub async fn has_message_completions(
        &self,
        owner: &str,
        session: &str,
        recipient: &str,
    ) -> Result<bool, StoreError> {
        self.require_open()?;
        let prefix = recipient_prefix(owner, session, recipient);
        let upper = format!("{prefix}g"); // Next component is hexadecimal.
        self.log.connection.read(move |db| Ok(db.query_row(
            "SELECT EXISTS(SELECT 1 FROM plugin_data WHERE package_id=? AND scope_id='profile' AND key>=? AND key<?)",
            rusqlite::params![PACKAGE, prefix, upper], |r| r.get(0),
        )?)).await
    }
    /// Range scans read only outstanding subscriptions, bounded by count and bytes.
    pub async fn message_completions(
        &self,
        owner: &str,
        after: Option<&str>,
    ) -> Result<Vec<Completion>, StoreError> {
        self.require_open()?;
        let prefix = owner_prefix(owner);
        if after.is_some_and(|key| !key.starts_with(&prefix)) {
            return Err(StoreError::InvalidTransition(
                "foreign completion cursor".into(),
            ));
        }
        let lower = after.unwrap_or(&prefix).to_owned();
        let upper = format!("{prefix}g");
        self.log
            .connection
            .read(move |db| {
                let rows = db
                    .prepare_cached(
                        "WITH candidates AS (
                SELECT key, length(CAST(value_json AS BLOB))+length(CAST(key AS BLOB))+128 AS bytes
                FROM plugin_data WHERE package_id=?1 AND scope_id='profile' AND key>?2 AND key<?3
                ORDER BY key LIMIT 64
            ), bounded AS (
                SELECT key, ROW_NUMBER() OVER (ORDER BY key) AS position,
                    SUM(bytes) OVER (ORDER BY key) AS total FROM candidates
            ) SELECT p.key,p.value_json FROM bounded b JOIN plugin_data p
              ON p.package_id=?1 AND p.scope_id='profile' AND p.key=b.key
              WHERE b.position=1 OR b.total<=?4 ORDER BY p.key",
                    )?
                    .query_map(
                        rusqlite::params![
                            PACKAGE,
                            lower,
                            upper,
                            maka_plugin_core::storage::MAX_PAGE_BYTES as i64
                        ],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                    )?
                    .collect::<Result<Vec<_>, _>>()?;
                rows.into_iter()
                    .map(|(key, value)| {
                        let mut entry: Completion = serde_json::from_str(&value)?;
                        entry.key = key;
                        Ok(entry)
                    })
                    .collect()
            })
            .await
    }
    pub async fn settle_message_completion(
        &self,
        owner: &str,
        key: &str,
        notification: Option<serde_json::Value>,
    ) -> Result<(), StoreError> {
        self.require_open()?;
        if !key.starts_with(&owner_prefix(owner)) {
            return Err(StoreError::InvalidTransition(
                "foreign completion key".into(),
            ));
        }
        let key = key.to_owned();
        let commits = self.log.commits.notice();
        self.log.connection.run(move |db| {
            let tx = rusqlite::Transaction::new_unchecked(db, rusqlite::TransactionBehavior::Immediate)?;
            let changed = if let Some(notification) = notification {
                let Some(mut entry) = read(&tx, &key)? else { return Ok(()); };
                match &entry.notification {
                    Some(previous) if *previous != notification => return Err(StoreError::InvalidTransition("completion notification identity changed".into())),
                    Some(_) => return Ok(()),
                    None => entry.notification = Some(notification),
                }
                tx.execute("UPDATE plugin_data SET value_json=?,revision=revision+1 WHERE package_id=? AND scope_id='profile' AND key=?",
                    rusqlite::params![serde_json::to_string(&entry)?, PACKAGE, key])?
            } else {
                tx.execute("DELETE FROM plugin_data WHERE package_id=? AND scope_id='profile' AND key=?",
                    rusqlite::params![PACKAGE, key])?
            };
            tx.commit().map_err(StoreError::CommitUnknown)?;
            if changed != 0 { commits.metadata(); }
            Ok(())
        }).await
    }
}

#[cfg(test)]
mod tests;

pub struct RegisterCompletion {
    pub owner: String,
    pub session: String,
    pub message: String,
    pub recipient: String,
    pub request: serde_json::Value,
}
impl crate::writeback::Statement for RegisterCompletion {
    type Value = ();
    type Output = ();
    fn execute(self, db: &Connection) -> Result<crate::writeback::Prepared<()>, StoreError> {
        for id in [&self.owner, &self.session, &self.message, &self.recipient] {
            crate::sessions::validate_id(id)?;
        }
        let entry = Completion {
            key: format!(
                "{}{}",
                recipient_prefix(&self.owner, &self.session, &self.recipient),
                hex::encode(&self.message)
            ),
            session_id: self.session,
            message_id: self.message,
            recipient: self.recipient,
            request: self.request,
            notification: None,
        };
        let changed = if let Some(existing) = read(db, &entry.key)? {
            if existing.request != entry.request {
                return Err(StoreError::InvalidTransition(
                    "completion subscription identity changed".into(),
                ));
            }
            false
        } else {
            db.execute("INSERT INTO plugin_data(package_id,scope_id,key,revision,value_json) VALUES (?,'profile',?,1,?)",
                rusqlite::params![PACKAGE, entry.key, serde_json::to_string(&entry)?])?;
            true
        };
        Ok(crate::writeback::Prepared {
            value: (),
            changed,
            notification: crate::writeback::Notification::METADATA,
        })
    }
    fn committed(_: ()) {}
    fn isolated_rejection(_: &StoreError) -> bool {
        false
    }
}
