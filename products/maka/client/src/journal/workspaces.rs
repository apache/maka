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

use super::{Journal, error, write};
use crate::Result;
use serde::{Deserialize, Serialize};
use sqlx::SqliteConnection;

#[derive(Serialize, Deserialize)]
pub struct RecentWorkspace {
    pub path: String,
}

impl Journal {
    pub(crate) async fn recent_workspaces(&self, owner: &str) -> Result<Vec<RecentWorkspace>> {
        let value: Option<String> =
            sqlx::query_scalar("SELECT value FROM recent_workspaces WHERE owner=?")
                .bind(owner)
                .fetch_optional(&self.pool)
                .await
                .map_err(error)?;
        value
            .map(|value| serde_json::from_str(&value))
            .transpose()
            .map_err(error)
            .map(Option::unwrap_or_default)
    }

    pub(crate) async fn set_recent_workspace(
        &self,
        owner: String,
        path: String,
        remember: bool,
    ) -> Result<Vec<RecentWorkspace>> {
        let write::Output::RecentWorkspaces(recent) = self
            .write(write::Command::SetRecentWorkspace {
                owner,
                path,
                remember,
            })
            .await?
        else {
            unreachable!("recent workspace write returned a different result")
        };
        Ok(recent)
    }
}

pub(super) async fn set(
    connection: &mut SqliteConnection,
    owner: String,
    path: String,
    remember: bool,
) -> Result<Vec<RecentWorkspace>> {
    let value: Option<String> =
        sqlx::query_scalar("SELECT value FROM recent_workspaces WHERE owner=?")
            .bind(&owner)
            .fetch_optional(&mut *connection)
            .await
            .map_err(error)?;
    let mut recent: Vec<RecentWorkspace> = value
        .map(|value| serde_json::from_str(&value))
        .transpose()
        .map_err(error)?
        .unwrap_or_default();
    recent.retain(|item| item.path != path);
    if remember {
        recent.insert(0, RecentWorkspace { path });
    }
    sqlx::query("INSERT INTO recent_workspaces(owner,value) VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET value=excluded.value")
        .bind(owner).bind(serde_json::to_string(&recent).map_err(error)?)
        .execute(connection).await.map_err(error)?;
    Ok(recent)
}
