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

use crate::{EventLog, StoreError};
use rusqlite::params;

/// Shares the accepted work's transaction: a retiring Session cannot accept new
/// work, and an accepted use makes a preparing revision no longer disposable.
pub(crate) fn retain(connection: &rusqlite::Connection, session: &str) -> Result<(), StoreError> {
    super::removal::require_accepting(connection, session)?;
    let importing: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM session_imports WHERE session_id=? AND state!='published')",
        params![session],
        |row| row.get(0),
    )?;
    if importing {
        return Err(StoreError::InvalidTransition(
            "Session import is not published".into(),
        ));
    }
    super::copy::retain(connection, session)
}

impl EventLog {
    /// Native process acceptance has no canonical invocation. The Host pins its
    /// admission gate through this commit and actual launch.
    pub async fn retain_session(&self, session: &str) -> Result<(), StoreError> {
        super::validate_id(session)?;
        let session = session.to_owned();
        self.connection
            .run(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Immediate,
                )?;
                retain(&tx, &session)?;
                tx.commit().map_err(StoreError::CommitUnknown)
            })
            .await
    }
}
