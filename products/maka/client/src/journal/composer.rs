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
use serde_json::Value;
use sqlx::{Row, SqliteConnection};

/// Local composer presentation, before a Host session exists.
pub struct ComposerState {
    pub revision: u64,
    pub value: Value,
    pub files: Vec<ComposerFile>,
}

pub struct ComposerFile {
    pub name: String,
    pub contents: Vec<u8>,
}

impl Journal {
    pub(crate) async fn load_composer(&self, owner: &str) -> Result<ComposerState> {
        let mut read = self.pool.begin().await.map_err(error)?;
        let row = sqlx::query("SELECT revision,value FROM composers WHERE owner=?")
            .bind(owner)
            .fetch_optional(&mut *read)
            .await
            .map_err(error)?;
        let files =
            sqlx::query("SELECT name,contents FROM composer_files WHERE owner=? ORDER BY position")
                .bind(owner)
                .fetch_all(&mut *read)
                .await
                .map_err(error)?
                .into_iter()
                .map(|row| ComposerFile {
                    name: row.get("name"),
                    contents: row.get("contents"),
                })
                .collect();
        read.commit().await.map_err(error)?;
        Ok(ComposerState {
            revision: row
                .as_ref()
                .map_or(0, |row| row.get::<i64, _>("revision") as u64),
            value: row
                .map(|row| serde_json::from_str(&row.get::<String, _>("value")))
                .transpose()
                .map_err(error)?
                .unwrap_or(Value::Null),
            files,
        })
    }

    pub(crate) async fn save_composer(
        &self,
        owner: String,
        expected: u64,
        value: Value,
        files: Option<Vec<ComposerFile>>,
    ) -> Result<u64> {
        let write::Output::Revision(revision) = self
            .write(write::Command::SaveComposer {
                owner,
                expected,
                value,
                files,
            })
            .await?
        else {
            unreachable!("composer write returns a revision")
        };
        Ok(revision)
    }
}

pub(super) async fn save(
    connection: &mut SqliteConnection,
    owner: String,
    expected: u64,
    value: Value,
    files: Option<Vec<ComposerFile>>,
) -> Result<u64> {
    if expected >= 9_007_199_254_740_991 {
        return Err("invalid composer revision".into());
    }
    let value = serde_json::to_string(&value).map_err(error)?;
    let revision: Option<i64> = if expected == 0 {
        sqlx::query_scalar("INSERT INTO composers(owner,revision,value) VALUES (?,1,?) ON CONFLICT DO NOTHING RETURNING revision")
            .bind(&owner).bind(value).fetch_optional(&mut *connection).await.map_err(error)?
    } else {
        sqlx::query_scalar("UPDATE composers SET revision=revision+1,value=? WHERE owner=? AND revision=? RETURNING revision")
            .bind(value).bind(&owner).bind(expected as i64).fetch_optional(&mut *connection).await.map_err(error)?
    };
    let revision = revision
        .ok_or("The new conversation changed in another window. Reopen it before editing.")?;
    // Ordinary typing only updates the small JSON value. File bytes change on intake/removal.
    if let Some(files) = files {
        sqlx::query("DELETE FROM composer_files WHERE owner=?")
            .bind(&owner)
            .execute(&mut *connection)
            .await
            .map_err(error)?;
        for (position, file) in files.into_iter().enumerate() {
            sqlx::query(
                "INSERT INTO composer_files(owner,position,name,contents) VALUES (?,?,?,?)",
            )
            .bind(&owner)
            .bind(position as i64)
            .bind(file.name)
            .bind(file.contents)
            .execute(&mut *connection)
            .await
            .map_err(error)?;
        }
    }
    Ok(revision as u64)
}
