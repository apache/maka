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
use rusqlite::{Connection, OptionalExtension};

#[derive(Clone, Debug, PartialEq)]
pub struct LoginReceipt {
    pub target: Target,
    pub method: String,
    request_fingerprint: String,
    pub connection: ConnectionIdentity,
    pub phase: Phase,
}

impl LoginReceipt {
    pub fn matches(&self, input: &LoginStart) -> bool {
        self.target == input.target
            && self.method == input.authentication.method
            && input
                .fingerprint()
                .is_ok_and(|digest| digest == self.request_fingerprint)
    }

    pub(super) fn new(input: LoginStart, connection: ConnectionIdentity) -> Result<Self> {
        let request_fingerprint = input.fingerprint().map_err(ConfigError::Invalid)?;
        Ok(Self {
            target: input.target,
            method: input.authentication.method,
            request_fingerprint,
            connection,
            phase: Phase::Authenticated,
        })
    }
}

pub(super) fn validate_attempt(value: &str) -> Result<()> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
    {
        return Err(ConfigError::Invalid("invalid OAuth attempt ID".into()));
    }
    Ok(())
}

pub(super) fn read(tx: &Connection, attempt: &str) -> Result<Option<LoginReceipt>> {
    let saved: Option<(String, String, String, String, String)> =
        tx.prepare_cached("SELECT target, method, request_fingerprint, connection, phase FROM oauth_login_receipts WHERE attempt_id = ?")?.query_row(rusqlite::params![attempt], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?,))).optional()?;
    let Some((target, method, request_fingerprint, connection, phase)) = saved else {
        return Ok(None);
    };
    let saved = LoginReceipt {
        target: serde_json::from_str(&target)?,
        method,
        request_fingerprint,
        connection: serde_json::from_str(&connection)?,
        phase: serde_json::from_str(&phase)?,
    };
    if !saved.target.matches(&saved.connection)
        || matches!(
            saved.phase,
            Phase::AwaitingAuthorization | Phase::Committing
        )
    {
        return Err(ConfigError::Invalid(
            "inconsistent OAuth receipt identity".into(),
        ));
    }
    Ok(Some(saved))
}

pub(super) fn write(tx: &Connection, attempt: &str, saved: &LoginReceipt) -> Result<()> {
    tx.execute("INSERT INTO oauth_login_receipts(attempt_id, target, method, request_fingerprint, connection, phase) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(attempt_id) DO UPDATE SET phase = excluded.phase", rusqlite::params![attempt, serde_json::to_string(&saved.target)?, &saved.method, &saved.request_fingerprint, serde_json::to_string(&saved.connection)?, serde_json::to_string(&saved.phase)?])?;
    Ok(())
}
