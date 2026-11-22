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

use rusqlite::params;

use crate::{EventLog, StoreError};
use uuid::Uuid;

impl EventLog {
    /// The native owner holds Host admission through this commit and spawn.
    /// Incomplete records survive restart: a lost handle is not proof of exit.
    pub async fn admit_session_process(&self, session: &str, id: Uuid) -> Result<(), StoreError> {
        super::validate_id(session)?;
        let session = session.to_owned();
        self.connection
            .run(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Immediate,
                )?;
                super::retain(&tx, &session)?;
                tx.execute(
                    "INSERT INTO session_processes(id,session_id) VALUES (?,?)",
                    params![id.to_string(), session],
                )?;
                tx.commit().map_err(StoreError::CommitUnknown)
            })
            .await
    }

    /// Call only after the owned process group/Job and native resources drained.
    pub async fn clean_session_process(&self, id: Uuid) -> Result<(), StoreError> {
        let expected_session = self.expected_session.clone();
        self.connection
            .run(move |connection| {
                {
                    let tx = rusqlite::Transaction::new_unchecked(connection, rusqlite::TransactionBehavior::Immediate)?;
                    let changed = tx.execute("UPDATE session_processes SET cleaned=1 WHERE id=? AND (? IS NULL OR session_id=?)", params![id.to_string(), expected_session.as_deref(), expected_session.as_deref()])
                        ?
                        ;
                    if changed != 1 {
                        return Err(StoreError::EventConflict);
                    }
                    tx.commit().map_err(StoreError::CommitUnknown)
                }
            })
            .await
    }
}
