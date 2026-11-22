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

//! Live, bounded source catalogs. Cursors bind the query and root, not a
//! snapshot of a source application that may keep appending between requests.
mod codex;
mod database;
mod summary;
use crate::{Error, transcript::source_cwd};
pub use codex::list as codex;
pub use database::opencode;
use maka_capabilities::filesystem::OpenFile;
use maka_capabilities::filesystem::ReadDirectory;
use maka_capabilities::filesystem::ReadError;
use maka_capabilities::filesystem::Reader;
use maka_capabilities::filesystem::Symlinks;
use maka_capabilities::filesystem::entries::Kind;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{cmp::Ordering, collections::BTreeMap, io};

const PAGE_BYTES: usize = 48 * 1024;

/// Domain formats, not Host identities or a restriction on third-party plugins.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Format {
    Codex,
    ClaudeCode,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Query {
    pub cwd: Option<String>,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub include_archived: bool,
    #[serde(default = "page_size")]
    pub limit: usize,
    pub cursor: Option<String>,
}
fn page_size() -> usize {
    20
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    /// Source artifact, not permission to open it. Filesystem catalogs return a
    /// relative path; database catalogs return the explicitly selected database.
    pub path: String,
    pub title: String,
    pub cwd: Option<String>,
    pub updated_at: Option<u64>,
    pub archived: bool,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub entries: Vec<Entry>,
    pub next: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Key {
    mtime: u64,
    path: String,
}
impl Ord for Key {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .mtime
            .cmp(&self.mtime)
            .then_with(|| self.path.cmp(&other.path))
    }
}
impl PartialOrd for Key {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    query: String,
    key: Key,
}

fn prepare(mut query: Query) -> Result<Query, Error> {
    if query.limit == 0 || query.limit > 100 || query.text.chars().any(char::is_control) {
        return Err(Error::Invalid("invalid catalog query"));
    }
    if let Some(cwd) = &query.cwd
        && source_cwd(Some(cwd.clone())).is_none()
    {
        return Err(Error::Invalid("invalid catalog workspace"));
    }
    query.text = normalize_text(&query.text);
    query.cwd = query.cwd.map(|cwd| normalize_path(&cwd));
    Ok(query)
}

pub async fn list(view: &ReadDirectory, format: Format, query: Query) -> Result<Page, Error> {
    let query = prepare(query)?;
    let hash = query_hash(view, format, &query)?;
    let after = query
        .cursor
        .as_ref()
        .map(|cursor| {
            let cursor: Cursor = serde_json::from_str(cursor)
                .map_err(|_| Error::Invalid("invalid catalog cursor"))?;
            if cursor.query != hash {
                return Err(Error::Invalid("catalog cursor belongs to another query"));
            }
            Ok(cursor.key)
        })
        .transpose()?;
    view.with_reader(move |reader| scan(reader, format, query, hash, after))
        .await?
}

fn query_hash(view: &ReadDirectory, format: Format, query: &Query) -> Result<String, Error> {
    let encoded = serde_json::to_vec(&(
        format,
        view.location(),
        &query.cwd,
        &query.text,
        query.include_archived,
    ))
    .map_err(|_| Error::Invalid("invalid catalog query"))?;
    Ok(hex::encode(Sha256::digest(encoded)))
}

fn scan(
    reader: Reader<'_>,
    format: Format,
    query: Query,
    hash: String,
    after: Option<Key>,
) -> Result<Page, Error> {
    let mut roots = match format {
        Format::Codex => vec![("sessions".to_owned(), false)],
        Format::ClaudeCode => vec![("projects".to_owned(), false)],
    };
    if format == Format::Codex && query.include_archived {
        roots.push(("archived_sessions".into(), true));
    }
    let mut candidates = BTreeMap::new();
    for (root, archived) in roots {
        let mut directories = vec![(root, 0)];
        while let Some((directory, depth)) = directories.pop() {
            let result = reader.visit_directory(&directory, Symlinks::Reject, |item| {
                let path = format!("{directory}/{}", item.name);
                match item.kind {
                    Kind::Directory
                        if format == Format::ClaudeCode && depth == 0
                            || format == Format::Codex =>
                    {
                        directories.push((path, depth + 1))
                    }
                    Kind::File if item.name.ends_with(".jsonl") => {
                        let info = match reader.file_info(OpenFile {
                            path: path.clone(),
                            symlinks: Symlinks::Reject,
                        }) {
                            Ok(info) => info,
                            Err(maka_capabilities::filesystem::ReadError::Io(error))
                                if matches!(
                                    error.kind(),
                                    io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied
                                ) =>
                            {
                                return Ok(());
                            }
                            Err(error) => return Err(error.into()),
                        };
                        let key = Key {
                            mtime: info.modified_at.unwrap_or(0),
                            path: path.clone(),
                        };
                        if after.as_ref().is_some_and(|after| &key <= after)
                            || (candidates.len() > query.limit
                                && candidates
                                    .last_key_value()
                                    .is_some_and(|(last, _)| &key >= last))
                        {
                            return Ok(());
                        }
                        let entry = match summary::read(&reader, format, path, archived, info) {
                            Ok(Some(entry)) => entry,
                            Ok(None) => return Ok(()),
                            Err(Error::Read(ReadError::Io(error)))
                                if matches!(
                                    error.kind(),
                                    io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied
                                ) =>
                            {
                                return Ok(());
                            }
                            Err(error) => return Err(error),
                        };
                        if matches_query(&entry, &query) {
                            candidates.insert(key, entry);
                            if candidates.len() > query.limit + 1 {
                                candidates.pop_last();
                            }
                        }
                    }
                    _ => {}
                }
                Ok::<_, Error>(())
            });
            match result {
                Ok(()) => {}
                Err(Error::Read(ReadError::Io(error)))
                    if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
    }
    page(
        query.limit,
        candidates.into_iter().map(|(key, entry)| {
            let cursor = serde_json::to_string(&Cursor {
                query: hash.clone(),
                key,
            })
            .map_err(|_| Error::Invalid("invalid catalog cursor"))?;
            Ok((cursor, entry))
        }),
    )
}

fn page(
    limit: usize,
    candidates: impl IntoIterator<Item = Result<(String, Entry), Error>>,
) -> Result<Page, Error> {
    let mut entries = Vec::new();
    let mut bytes = 256;
    let mut last = None;
    let mut more = false;
    for candidate in candidates {
        let (continuation, entry) = candidate?;
        let encoded =
            serde_json::to_vec(&entry).map_err(|_| Error::Invalid("invalid catalog entry"))?;
        let cursor_bytes = serde_json::to_vec(&continuation)
            .map_err(|_| Error::Invalid("invalid catalog cursor"))?
            .len();
        if entries.len() == limit
            || (!entries.is_empty() && bytes + encoded.len() + cursor_bytes > PAGE_BYTES)
        {
            more = true;
            break;
        }
        bytes += encoded.len() + 1;
        last = Some(continuation);
        entries.push(entry);
    }
    let next = if more {
        Some(last.ok_or(Error::Invalid("catalog entry exceeds page budget"))?)
    } else {
        None
    };
    Ok(Page { entries, next })
}
fn matches_query(entry: &Entry, query: &Query) -> bool {
    if query.cwd.as_ref().is_some_and(|cwd| {
        entry
            .cwd
            .as_ref()
            .is_none_or(|path| &normalize_path(path) != cwd)
    }) {
        return false;
    }
    query.text.is_empty()
        || normalize_text(&entry.title).contains(&query.text)
        || entry.cwd.as_ref().is_some_and(|cwd| {
            normalize_text(cwd)
                .replace('\\', "/")
                .contains(&query.text.replace('\\', "/"))
        })
}
fn normalize_text(value: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    value.nfc().collect::<String>().trim().to_lowercase()
}
fn normalize_path(value: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let folded = value.nfc().collect::<String>().replace('\\', "/");
    let path = folded.trim_end_matches('/');
    let path = if path.is_empty() && !folded.is_empty() {
        "/"
    } else {
        path
    };
    if folded.as_bytes().get(1..3) == Some(b":/") && folded.as_bytes()[0].is_ascii_alphabetic() {
        if path.len() == 2 {
            format!("{}/", path.to_lowercase())
        } else {
            path.to_lowercase()
        }
    } else {
        path.into()
    }
}
