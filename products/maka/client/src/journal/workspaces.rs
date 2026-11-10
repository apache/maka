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

/// The menu lists this many; older folders drop out instead of being removed by hand.
const RECENT_WORKSPACES: usize = 10;

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
        let mut recent: Vec<RecentWorkspace> = value
            .map(|value| serde_json::from_str(&value))
            .transpose()
            .map_err(error)?
            .unwrap_or_default();
        recent.truncate(RECENT_WORKSPACES);
        Ok(recent)
    }

    pub(crate) async fn set_recent_workspace(
        &self,
        owner: String,
        path: String,
    ) -> Result<Vec<RecentWorkspace>> {
        let write::Output::RecentWorkspaces(recent) = self
            .write(write::Command::SetRecentWorkspace { owner, path })
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
    recent.insert(0, RecentWorkspace { path });
    recent.truncate(RECENT_WORKSPACES);
    sqlx::query("INSERT INTO recent_workspaces(owner,value) VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET value=excluded.value")
        .bind(owner).bind(serde_json::to_string(&recent).map_err(error)?)
        .execute(connection).await.map_err(error)?;
    Ok(recent)
}

#[cfg(test)]
mod tests {
    use sqlx::Connection;

    use super::*;

    #[tokio::test]
    async fn recent_workspaces_keep_the_latest_ten_without_duplicates() {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE recent_workspaces (owner TEXT PRIMARY KEY, value TEXT NOT NULL)")
            .execute(&mut connection)
            .await
            .unwrap();
        for number in 0..12 {
            set(
                &mut connection,
                "owner".into(),
                format!("/project/{number}"),
            )
            .await
            .unwrap();
        }
        let recent = set(&mut connection, "owner".into(), "/project/5".into())
            .await
            .unwrap();
        let paths: Vec<_> = recent.iter().map(|item| item.path.as_str()).collect();
        assert_eq!(
            paths,
            [5, 11, 10, 9, 8, 7, 6, 4, 3, 2]
                .map(|number| format!("/project/{number}"))
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
        );
    }
}
