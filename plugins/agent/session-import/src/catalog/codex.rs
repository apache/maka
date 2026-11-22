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

use super::{Entry, Format, Page, Query, matches_query, page, prepare, query_hash, summary};
use crate::{
    Error,
    transcript::{source_cwd, title},
};
use maka_capabilities::filesystem::OpenFile;
use maka_capabilities::filesystem::ReadDirectory;
use maka_capabilities::filesystem::ReadError;
use maka_capabilities::filesystem::Symlinks;
use maka_capabilities::filesystem::database::Cell;
use maka_capabilities::filesystem::database::Error as DatabaseError;
use maka_capabilities::filesystem::database::Query as Statement;
use maka_capabilities::filesystem::database::Read;
use maka_capabilities::filesystem::database::Table;
use maka_capabilities::filesystem::entries::Kind;
use serde::{Deserialize, Serialize};
use std::{
    cmp::Reverse,
    collections::{BTreeMap, BTreeSet},
    io,
    path::{Component, Path},
};

const COLUMNS: [&str; 13] = [
    "id",
    "rollout_path",
    "cwd",
    "name",
    "title",
    "preview",
    "first_user_message",
    "created_at_ms",
    "created_at",
    "updated_at_ms",
    "updated_at",
    "archived",
    "source",
];

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Key {
    updated_at: u64,
    id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Cursor {
    Filesystem {
        position: super::Cursor,
    },
    Database {
        query: String,
        database: String,
        key: Key,
    },
}

/// Chooses the newest source database once. A continuation stays on that
/// generation, or on the filesystem selected by its first page.
pub async fn list(
    views: &(impl crate::access::ReadSource + ?Sized),
    root: String,
    query: Query,
) -> Result<Page, Error> {
    let mut query = prepare(query)?;
    let view = views.directory(root.clone()).await?;
    let hash = query_hash(&view, Format::Codex, &query)?;
    let cursor = query
        .cursor
        .as_ref()
        .map(|cursor| {
            serde_json::from_str::<Cursor>(cursor)
                .map_err(|_| Error::Invalid("invalid Codex catalog cursor"))
        })
        .transpose()?;
    match cursor {
        Some(Cursor::Filesystem { position }) => {
            query.cursor = Some(
                serde_json::to_string(&position)
                    .map_err(|_| Error::Invalid("invalid Codex catalog cursor"))?,
            );
            filesystem(&view, query).await
        }
        Some(Cursor::Database {
            query: binding,
            database,
            key,
        }) => {
            if binding != hash
                || generation(&database).is_none()
                || !summary::safe_id(&key.id, false)
                || key.updated_at > 9_007_199_254_740_991
            {
                return Err(Error::Invalid(
                    "Codex catalog cursor belongs to another query",
                ));
            }
            database_page(views, &view, &root, database, query, hash, Some(key)).await
        }
        None => {
            let latest = view
                .with_reader(|reader| {
                    let mut latest: Option<(u64, String)> = None;
                    reader.visit_directory("", Symlinks::Reject, |entry| {
                        if matches!(entry.kind, Kind::File)
                            && let Some(number) = generation(&entry.name)
                        {
                            let candidate = (number, entry.name);
                            if latest.as_ref().is_none_or(|old| &candidate > old) {
                                latest = Some(candidate);
                            }
                        }
                        Ok::<_, Error>(())
                    })?;
                    Ok::<_, Error>(latest.map(|(_, name)| name))
                })
                .await??;
            if let Some(database) = latest {
                match database_page(views, &view, &root, database, query.clone(), hash, None).await
                {
                    Ok(page) => return Ok(page),
                    // Source failure may choose a complete rollout scan, never
                    // a stale lower generation. Revocation is not source failure.
                    Err(
                        error @ (Error::Database(DatabaseError::Denied | DatabaseError::Cancelled)
                        | Error::Read(ReadError::Retired)
                        | Error::Remote(_)),
                    ) => return Err(error),
                    Err(_) => {}
                }
            }
            filesystem(&view, query).await
        }
    }
}

async fn filesystem(view: &ReadDirectory, query: Query) -> Result<Page, Error> {
    let mut result = super::list(view, Format::Codex, query).await?;
    result.next = result
        .next
        .map(|next| {
            let position = serde_json::from_str(&next)
                .map_err(|_| Error::Invalid("invalid filesystem catalog cursor"))?;
            serde_json::to_string(&Cursor::Filesystem { position })
                .map_err(|_| Error::Invalid("invalid Codex catalog cursor"))
        })
        .transpose()?;
    Ok(result)
}

async fn database_page(
    views: &(impl crate::access::ReadSource + ?Sized),
    view: &ReadDirectory,
    root: &str,
    database: String,
    query: Query,
    hash: String,
    after: Option<Key>,
) -> Result<Page, Error> {
    view.file_info(OpenFile {
        path: database.clone(),
        symlinks: Symlinks::Reject,
    })
    .await?;
    // This path derives from the explicit request, not ReadDirectory::location.
    let path = Path::new(root)
        .join(&database)
        .to_str()
        .ok_or(Error::Invalid("source path is not UTF-8"))?
        .to_owned();
    let schema = one(views
        .query_database(Read {
            path: path.clone(),
            queries: vec![Statement {
                sql: "PRAGMA table_info(threads)".into(),
                parameters: vec![],
            }],
        })
        .await?)?;
    let index = schema
        .columns
        .iter()
        .position(|column| column == "name")
        .ok_or(Error::Invalid("invalid Codex schema"))?;
    let columns = schema
        .rows
        .into_iter()
        .filter_map(|row| match row.into_iter().nth(index) {
            Some(Cell::Text(name)) => Some(name),
            _ => None,
        })
        .collect::<BTreeSet<_>>();
    if !columns.contains("id") || !columns.contains("rollout_path") {
        return Err(Error::Invalid(
            "Codex threads lack identity or rollout path",
        ));
    }
    let selected = COLUMNS
        .iter()
        .map(|column| {
            if columns.contains(*column) {
                (*column).to_owned()
            } else {
                format!("NULL AS {column}")
            }
        })
        .collect::<Vec<_>>()
        .join(",");
    // Read only bounded index metadata, not messages or a copy of the database.
    // Rust owns timestamp normalization and key ordering together, including
    // numeric strings and ISO timestamps in dynamically typed source columns.
    let table = one(views
        .query_database(Read {
            path,
            queries: vec![Statement {
                sql: format!("SELECT {selected} FROM threads"),
                parameters: vec![],
            }],
        })
        .await?)?;
    if table.columns != COLUMNS {
        return Err(Error::Invalid("unexpected Codex catalog columns"));
    }
    let location = view.location();
    let selected_root = Path::new(root).to_owned();
    view.with_reader(move |reader| {
        let mut candidates = BTreeMap::new();
        let mut seen = BTreeSet::new();
        for row in table.rows {
            let Some((key, entry)) = entry(row, &location, &selected_root)? else {
                continue;
            };
            if !seen.insert(key.id.clone()) {
                return Err(Error::Invalid("duplicate Codex catalog identity"));
            }
            if after.as_ref().is_some_and(|after| &key >= after)
                || (!query.include_archived && entry.archived)
                || !matches_query(&entry, &query)
            {
                continue;
            }
            let key = Reverse(key);
            if candidates.len() > query.limit
                && candidates
                    .last_key_value()
                    .is_some_and(|(last, _)| &key >= last)
            {
                continue;
            }
            match reader.file_info(OpenFile {
                path: entry.path.clone(),
                symlinks: Symlinks::Reject,
            }) {
                Ok(_) => {}
                Err(ReadError::Io(error))
                    if matches!(
                        error.kind(),
                        io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied
                    ) =>
                {
                    continue;
                }
                Err(error) => return Err(error.into()),
            }
            candidates.insert(key, entry);
            if candidates.len() > query.limit + 1 {
                candidates.pop_last();
            }
        }
        page(
            query.limit,
            candidates.into_iter().map(|(Reverse(key), entry)| {
                let cursor = serde_json::to_string(&Cursor::Database {
                    query: hash.clone(),
                    database: database.clone(),
                    key,
                })
                .map_err(|_| Error::Invalid("invalid Codex catalog cursor"))?;
                Ok((cursor, entry))
            }),
        )
    })
    .await?
}

fn one(tables: Vec<Table>) -> Result<Table, Error> {
    let [table] = tables
        .try_into()
        .map_err(|_| Error::Invalid("incomplete catalog snapshot"))?;
    Ok(table)
}
fn generation(name: &str) -> Option<u64> {
    let number = name.strip_prefix("state_")?.strip_suffix(".sqlite")?;
    if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    number.parse().ok()
}

fn entry(row: Vec<Cell>, root: &Path, selected_root: &Path) -> Result<Option<(Key, Entry)>, Error> {
    let [
        id,
        path,
        cwd,
        name,
        label,
        preview,
        first,
        created_ms,
        created,
        updated_ms,
        updated,
        archived,
        source,
    ]: [Cell; 13] = row
        .try_into()
        .map_err(|_| Error::Invalid("invalid Codex catalog row"))?;
    let (Cell::Text(id), Cell::Text(path)) = (id, path) else {
        return Ok(None);
    };
    if !summary::safe_id(&id, false) {
        return Ok(None);
    }
    match source {
        Cell::Null => {}
        Cell::Text(value) => {
            if !summary::Origin::Text(value).supported() {
                return Ok(None);
            }
        }
        _ => return Ok(None),
    }
    let Some(path) =
        relative_path(root, &path, &id).or_else(|| relative_path(selected_root, &path, &id))
    else {
        return Ok(None);
    };
    let title = [name, label, preview, first]
        .into_iter()
        .filter_map(|cell| {
            if let Cell::Text(text) = cell {
                Some(title(&text))
            } else {
                None
            }
        })
        .find(|text| !text.is_empty())
        .unwrap_or_else(|| id.clone());
    let observed = epoch(&updated_ms).or_else(|| epoch(&updated));
    let key = Key {
        updated_at: observed
            .or_else(|| epoch(&created_ms))
            .or_else(|| epoch(&created))
            .unwrap_or(0),
        id: id.clone(),
    };
    let entry = Entry {
        id,
        path,
        title,
        cwd: source_cwd(if let Cell::Text(cwd) = cwd {
            Some(cwd)
        } else {
            None
        }),
        updated_at: observed,
        archived: matches!(archived, Cell::Integer(1)),
    };
    Ok(Some((key, entry)))
}

fn relative_path(root: &Path, path: &str, id: &str) -> Option<String> {
    if path.chars().any(char::is_control) {
        return None;
    }
    let path = dunce::simplified(Path::new(path));
    let mut parts = path.components();
    if path.is_absolute() {
        for expected in dunce::simplified(root).components() {
            let actual = parts.next()?;
            let same = if cfg!(windows) {
                actual
                    .as_os_str()
                    .to_str()?
                    .eq_ignore_ascii_case(expected.as_os_str().to_str()?)
            } else {
                actual == expected
            };
            if !same {
                return None;
            }
        }
    }
    let relative = parts.as_path();
    if !relative
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
    {
        return None;
    }
    let filename = relative.file_name()?.to_str()?;
    if !filename.starts_with("rollout-") || !filename.ends_with(&format!("-{id}.jsonl")) {
        return None;
    }
    Some(relative.to_str()?.replace(std::path::MAIN_SEPARATOR, "/"))
}

fn epoch(cell: &Cell) -> Option<u64> {
    let value = match cell {
        Cell::Integer(value) => *value as f64,
        Cell::Real(value) => *value,
        Cell::Text(value) => {
            let value = value.trim();
            if value.is_empty() {
                return None;
            }
            match value.parse::<f64>() {
                Ok(number) => number,
                Err(_) => {
                    let timestamp = value.parse::<jiff::Timestamp>().ok()?.as_millisecond();
                    return u64::try_from(timestamp).ok();
                }
            }
        }
        _ => return None,
    };
    let milliseconds = if value >= 1_000_000_000_000.0 {
        value
    } else {
        value * 1000.0
    };
    (milliseconds.is_finite() && (0.0..=9_007_199_254_740_991.0).contains(&milliseconds))
        .then_some(milliseconds as u64)
}
