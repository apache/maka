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

use super::status;
use crate::{Result, catalog};
use maka_agent_facts::configuration::CredentialLocator;
use maka_agent_facts::configuration::CredentialState;
use rusqlite::Connection;
use uuid::Uuid;

/// New enrollment is a new authority even when the token bytes are identical.
/// The caller's transaction rolls back both deletion and insertion on failure.
pub(crate) fn replace_secret(
    tx: &Connection,
    locator: &CredentialLocator,
    secret: &str,
    now: u64,
) -> Result<()> {
    tx.execute(
        "DELETE FROM credentials WHERE locator = ?",
        rusqlite::params![serde_json::to_string(locator)?],
    )?;
    write_secret(tx, locator, secret, now)
}

pub(crate) fn write_secret(
    tx: &Connection,
    locator: &CredentialLocator,
    secret: &str,
    now: u64,
) -> Result<()> {
    let previous = status(tx, locator)?;
    let (credential_id, previous_revision) = match previous.state {
        CredentialState::Absent => (Uuid::new_v4().to_string(), 0),
        CredentialState::Configured {
            credential_id,
            revision,
            ..
        } => (credential_id, revision),
    };
    let revision = catalog::next_revision(previous_revision)?;
    let locator = serde_json::to_string(locator)?;
    tx.execute("INSERT INTO credentials VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(locator) DO UPDATE SET revision = excluded.revision, secret = excluded.secret, updated_at = excluded.updated_at", rusqlite::params![locator, credential_id, revision as i64, secret, now as i64])?;
    Ok(())
}
