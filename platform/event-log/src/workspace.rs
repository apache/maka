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

impl EventLog {
    /// Ownership, not quiescence: another retained Session keeps a managed
    /// checkout alive regardless of how many past users shared that directory.
    pub async fn workspace_has_other_session(
        &self,
        cwd: &str,
        session: &str,
    ) -> Result<bool, StoreError> {
        crate::sessions::validate_id(session)?;
        let (cwd, session) = (cwd.to_owned(), session.to_owned());
        self.connection
            .read(move |connection| {
                {
                    Ok(connection.query_row(
                        "SELECT EXISTS(SELECT 1 FROM workspace_bindings binding
                         JOIN session_control session INDEXED BY session_workspace_binding
                         ON json_extract(session.configuration,'$.workspace.id')=binding.id
                         WHERE json_extract(binding.workspace_json,'$.path')=? AND session.id<>?
                         AND NOT EXISTS(SELECT 1 FROM session_retirements retirement
                             WHERE retirement.session_id=session.id AND retirement.remove_session=1
                                 AND retirement.completed=1))",
                        params![cwd, session],
                        |row| row.get(0),
                    )?)
                }
            })
            .await
    }
}
