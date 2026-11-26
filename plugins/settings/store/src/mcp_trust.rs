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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProjectMcpDecision {
    Trusted,
    Declined,
}

impl ProjectMcpDecision {
    fn as_str(self) -> &'static str {
        match self {
            Self::Trusted => "trusted",
            Self::Declined => "declined",
        }
    }

    fn parse(raw: &str) -> Result<Self> {
        match raw {
            "trusted" => Ok(Self::Trusted),
            "declined" => Ok(Self::Declined),
            _ => Err(ConfigError::Invalid(
                "invalid project MCP consent decision".into(),
            )),
        }
    }
}

fn validate_consent_identity(owner: &str, workspace: &str, revision: &str) -> Result<()> {
    if owner.is_empty()
        || ![workspace, revision].iter().all(|value| {
            value.strip_prefix("sha256:").is_some_and(|digest| {
                digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit())
            })
        })
    {
        return Err(ConfigError::Invalid(
            "invalid project MCP consent identity".into(),
        ));
    }
    Ok(())
}

impl ConfigurationStore {
    pub async fn project_mcp_decision(
        &self,
        owner: String,
        workspace: String,
        revision: String,
    ) -> Result<Option<ProjectMcpDecision>> {
        self.transaction(TransactionMode::Deferred, move |connection| {
            let row: Option<(String, String)> = connection
                .prepare_cached(
                    "SELECT revision, decision FROM project_mcp_trust WHERE owner = ? AND workspace = ?",
                )?
                .query_row(rusqlite::params![owner, workspace], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })
                .optional()?;
            match row {
                Some((stored_revision, decision)) if stored_revision == revision => {
                    Ok(Some(ProjectMcpDecision::parse(&decision)?))
                }
                _ => Ok(None),
            }
        })
        .await
    }

    pub async fn project_mcp_trusted(
        &self,
        owner: String,
        workspace: String,
        revision: String,
    ) -> Result<bool> {
        Ok(self
            .project_mcp_decision(owner, workspace, revision)
            .await?
            == Some(ProjectMcpDecision::Trusted))
    }

    pub async fn set_project_mcp_decision(
        &self,
        owner: String,
        workspace: String,
        revision: String,
        decision: ProjectMcpDecision,
    ) -> Result<()> {
        validate_consent_identity(&owner, &workspace, &revision)?;
        self.transaction(TransactionMode::Immediate, move |connection| {
            connection.execute(
                "INSERT INTO project_mcp_trust(owner, workspace, revision, decision) VALUES (?, ?, ?, ?) ON CONFLICT(owner, workspace) DO UPDATE SET revision = excluded.revision, decision = excluded.decision",
                rusqlite::params![owner, workspace, revision, decision.as_str()],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn trust_project_mcp(
        &self,
        owner: String,
        workspace: String,
        revision: String,
    ) -> Result<()> {
        self.set_project_mcp_decision(owner, workspace, revision, ProjectMcpDecision::Trusted)
            .await
    }

    pub async fn decline_project_mcp(
        &self,
        owner: String,
        workspace: String,
        revision: String,
    ) -> Result<()> {
        self.set_project_mcp_decision(owner, workspace, revision, ProjectMcpDecision::Declined)
            .await
    }
}
