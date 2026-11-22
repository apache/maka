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

use super::{Entry, Page, Query, matches_query, page, prepare};
use crate::{
    Error,
    transcript::{identity, source_cwd, title},
};
use maka_capabilities::filesystem::database::Cell;
use maka_capabilities::filesystem::database::Query as Statement;
use maka_capabilities::filesystem::database::Read;
use maka_capabilities::filesystem::database::Table;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const BATCH: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Key {
    updated_at: u64,
    id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    query: String,
    key: Key,
}

/// Lists root sessions in an explicitly authorized OpenCode database. Keysets
/// bind the source and query; they do not freeze a live source between pages.
pub async fn opencode(
    views: &(impl crate::access::ReadSource + ?Sized),
    path: String,
    query: Query,
) -> Result<Page, Error> {
    let query = prepare(query)?;
    let hash = hex::encode(Sha256::digest(
        serde_json::to_vec(&(
            "opencode",
            &path,
            &query.cwd,
            &query.text,
            query.include_archived,
        ))
        .map_err(|_| Error::Invalid("invalid catalog query"))?,
    ));
    let mut after = query
        .cursor
        .as_ref()
        .map(|cursor| {
            let cursor: Cursor = serde_json::from_str(cursor)
                .map_err(|_| Error::Invalid("invalid catalog cursor"))?;
            if cursor.query != hash || cursor.key.updated_at > 9_007_199_254_740_991 {
                return Err(Error::Invalid("catalog cursor belongs to another query"));
            }
            identity(&cursor.key.id)?;
            Ok(cursor.key)
        })
        .transpose()?;
    let mut candidates = Vec::new();
    loop {
        let mut parameters = Vec::new();
        let archive = if query.include_archived {
            ""
        } else {
            "AND time_archived IS NULL"
        };
        let continuation = if let Some(key) = &after {
            parameters.extend([
                Cell::Integer(key.updated_at as i64),
                Cell::Text(key.id.clone()),
            ]);
            "WHERE sort_key < ?1 OR (sort_key = ?1 AND id < ?2)"
        } else {
            ""
        };
        // Select the exact ordering key once, also used by the cursor. Matching
        // cwd in Rust preserves Unicode and cross-platform path normalization.
        let tables = views
            .query_database(Read {
                path: path.clone(),
                queries: vec![Statement {
                    sql: format!(
                        "WITH roots AS (
                    SELECT id,title,directory,time_archived,
                           coalesce(time_updated,time_created) AS updated_at,
                           coalesce(time_updated,time_created,0) AS sort_key
                    FROM session WHERE (parent_id IS NULL OR parent_id='') {archive}
                ) SELECT id,title,directory,time_archived,updated_at,sort_key FROM roots
                  {continuation} ORDER BY sort_key DESC,id DESC LIMIT {BATCH}"
                    ),
                    parameters,
                }],
            })
            .await?;
        let [table]: [Table; 1] = tables
            .try_into()
            .map_err(|_| Error::Invalid("incomplete catalog snapshot"))?;
        if table.columns
            != [
                "id",
                "title",
                "directory",
                "time_archived",
                "updated_at",
                "sort_key",
            ]
        {
            return Err(Error::Invalid("unexpected OpenCode catalog columns"));
        }
        let count = table.rows.len();
        for row in table.rows {
            let [id, name, cwd, archived, observed_at, updated_at]: [Cell; 6] = row
                .try_into()
                .map_err(|_| Error::Invalid("invalid OpenCode catalog row"))?;
            let id = text(id)?;
            identity(&id)?;
            let updated_at = timestamp(updated_at)?;
            let key = Key {
                updated_at,
                id: id.clone(),
            };
            if after.as_ref().is_some_and(|previous| &key >= previous) {
                return Err(Error::Invalid(
                    "OpenCode catalog keys are not strictly ordered",
                ));
            }
            after = Some(key.clone());
            let archived = match archived {
                Cell::Null => false,
                cell => {
                    timestamp(cell)?;
                    true
                }
            };
            let name = optional_text(name)?
                .map(|name| title(&name))
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| id.clone());
            let entry = Entry {
                id,
                path: path.clone(),
                title: name,
                cwd: source_cwd(optional_text(cwd)?),
                updated_at: match observed_at {
                    Cell::Null => None,
                    cell => Some(timestamp(cell)?),
                },
                archived,
            };
            if matches_query(&entry, &query) {
                let cursor = serde_json::to_string(&Cursor {
                    query: hash.clone(),
                    key,
                })
                .map_err(|_| Error::Invalid("invalid catalog cursor"))?;
                candidates.push(Ok((cursor, entry)));
                if candidates.len() > query.limit {
                    return page(query.limit, candidates);
                }
            }
        }
        if count < BATCH {
            return page(query.limit, candidates);
        }
    }
}

fn text(cell: Cell) -> Result<String, Error> {
    match cell {
        Cell::Text(value) => Ok(value),
        _ => Err(Error::Invalid("catalog field is not text")),
    }
}
fn optional_text(cell: Cell) -> Result<Option<String>, Error> {
    match cell {
        Cell::Null => Ok(None),
        cell => text(cell).map(Some),
    }
}
fn timestamp(cell: Cell) -> Result<u64, Error> {
    match cell {
        Cell::Integer(value) if (0..=9_007_199_254_740_991).contains(&value) => Ok(value as u64),
        _ => Err(Error::Invalid("invalid catalog timestamp")),
    }
}
