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

//! Project MCP consent belongs to the configuration authority, never plugin data.
use crate::{ConfigError, ConfigurationStore, Result, TransactionMode};
use rusqlite::OptionalExtension;
impl ConfigurationStore {
    pub async fn project_mcp_trusted(
        &self,
        owner: String,
        workspace: String,
        revision: String,
    ) -> Result<bool> {
        self.transaction(TransactionMode::Deferred, move |connection| {
            {
                Ok(connection
                    .prepare_cached(
                        "SELECT revision FROM project_mcp_trust WHERE owner = ? AND workspace = ?",
                    )?
                    .query_row(rusqlite::params![owner, workspace], |row| row.get(0))
                    .optional()?
                    .as_ref()
                    == Some(&revision))
            }
        })
        .await
    }
    pub async fn trust_project_mcp(
        &self,
        owner: String,
        workspace: String,
        revision: String,
    ) -> Result<()> {
        if owner.is_empty()
            || ![&workspace, &revision].iter().all(|value| {
                value.strip_prefix("sha256:").is_some_and(|digest| {
                    digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit())
                })
            })
        {
            return Err(ConfigError::Invalid(
                "invalid project MCP consent identity".into(),
            ));
        }
        self.transaction(TransactionMode::Immediate, move |connection| {
            connection.execute("INSERT INTO project_mcp_trust(owner, workspace, revision) VALUES (?, ?, ?) ON CONFLICT(owner, workspace) DO UPDATE SET revision = excluded.revision", rusqlite::params![owner, workspace, revision])?;
            Ok(())
        }).await
    }
}
