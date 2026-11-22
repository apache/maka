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

//! Fixed-Root raw stderr bytes. Readers never retain the Root writer lease.
//!
//! Writers append; replacement and observed shrink reset cursors. Copytruncate
//! followed by regrowth between reads and hostile file-ID reuse are not detected.
//! Cancellation settles any started blocking read; a stalled filesystem syscall
//! has no promised wall-clock cancellation deadline.

mod filesystem;
#[cfg(test)]
mod tests;

use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use maka_event_log::root::{RootNamespaces, RootOwner};
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use std::{
    fmt,
    fs::File,
    future::Future,
    io,
    path::{Path, PathBuf},
    str::FromStr,
    time::Duration,
};
use tokio_util::sync::CancellationToken;

const RAW_LIMIT: usize = 32 * 1024;
const CURSOR_LIMIT: usize = 512;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(transparent)]
pub struct HostLogCursor(#[schemars(length(max = 512))] String);

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CursorData {
    root: String,
    device: u64,
    file: u64,
    offset: u64,
}

impl HostLogCursor {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn decode(&self) -> io::Result<CursorData> {
        if self.0.len() > CURSOR_LIMIT {
            return Err(invalid("log cursor is too long"));
        }
        let raw = URL_SAFE_NO_PAD
            .decode(&self.0)
            .map_err(|_| invalid("invalid log cursor"))?;
        let data: CursorData =
            serde_json::from_slice(&raw).map_err(|_| invalid("invalid log cursor"))?;
        validate_root(&data.root)?;
        Ok(data)
    }

    fn encode(data: CursorData) -> io::Result<Self> {
        let bytes = serde_json::to_vec(&data).map_err(io::Error::other)?;
        Ok(Self(URL_SAFE_NO_PAD.encode(bytes)))
    }
}

impl fmt::Display for HostLogCursor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl FromStr for HostLogCursor {
    type Err = io::Error;
    fn from_str(value: &str) -> io::Result<Self> {
        Self::try_from(value.to_owned())
    }
}
impl TryFrom<String> for HostLogCursor {
    type Error = io::Error;
    fn try_from(value: String) -> io::Result<Self> {
        let cursor = Self(value);
        cursor.decode()?;
        Ok(cursor)
    }
}
impl<'de> Deserialize<'de> for HostLogCursor {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::try_from(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum HostLogPosition {
    Tail,
    After { cursor: HostLogCursor },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostLogRequest {
    pub position: HostLogPosition,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HostLogReset {
    Replaced,
    Truncated,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HostLogPage {
    Missing,
    Data {
        cursor: HostLogCursor,
        bytes: String,
        reset: Option<HostLogReset>,
        truncated: bool,
        has_more: bool,
    },
}

#[derive(Clone, Debug)]
pub struct Source {
    root_id: String,
    path: PathBuf,
}

impl Source {
    pub fn from_owner(owner: &RootOwner) -> io::Result<Self> {
        owner.validate_current()?;
        Ok(Self {
            root_id: owner.root_id().to_owned(),
            path: owner.control_directory().join("host.stderr.log"),
        })
    }

    /// Derive a source without opening, creating, or changing any filesystem entry.
    pub fn for_root(root_id: &str, namespaces: &RootNamespaces) -> io::Result<Self> {
        validate_root(root_id)?;
        Ok(Self {
            root_id: root_id.to_owned(),
            path: namespaces.control.join(root_id).join("host.stderr.log"),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Safely create/open the fixed private file for append-only process capture.
    pub fn open_capture(&self) -> io::Result<File> {
        filesystem::capture(&self.path)
    }

    pub async fn read(&self, request: HostLogRequest) -> io::Result<HostLogPage> {
        let source = self.clone();
        tokio::task::spawn_blocking(move || source.read_blocking(request))
            .await
            .map_err(io::Error::other)?
    }

    /// Serial delivery supplies backpressure without a queue or detached worker.
    pub async fn watch<F, Fut>(
        &self,
        request: HostLogRequest,
        cancel: CancellationToken,
        mut emit: F,
    ) -> io::Result<()>
    where
        F: FnMut(HostLogPage) -> Fut,
        Fut: Future<Output = io::Result<()>>,
    {
        let mut position = request.position;
        let mut previous = None;
        loop {
            if cancel.is_cancelled() {
                return Ok(());
            }
            // Do not abandon spawn_blocking on cancellation. Await this bounded
            // read before returning, then discard its result if cancelled.
            let result = self
                .read(HostLogRequest {
                    position: position.clone(),
                })
                .await;
            if cancel.is_cancelled() {
                return Ok(());
            }
            let page = result?;
            let mut has_more = false;
            if let HostLogPage::Data {
                cursor,
                has_more: more,
                ..
            } = &page
            {
                position = HostLogPosition::After {
                    cursor: cursor.clone(),
                };
                has_more = *more;
            }
            let changed = match (&page, &previous) {
                (
                    HostLogPage::Data {
                        cursor,
                        bytes,
                        reset: None,
                        ..
                    },
                    Some(HostLogPage::Data { cursor: prior, .. }),
                ) if bytes.is_empty() => cursor != prior,
                _ => previous.as_ref() != Some(&page),
            };
            if changed {
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Ok(()),
                    result = emit(page.clone()) => result?,
                }
            }
            previous = Some(page);
            if !has_more {
                tokio::select! {
                    _ = cancel.cancelled() => return Ok(()),
                    _ = tokio::time::sleep(Duration::from_millis(250)) => {},
                }
            }
        }
    }

    fn read_blocking(&self, request: HostLogRequest) -> io::Result<HostLogPage> {
        use std::io::{Read, Seek, SeekFrom};
        let tail = matches!(&request.position, HostLogPosition::Tail);
        let after = match request.position {
            HostLogPosition::Tail => None,
            HostLogPosition::After { cursor } => {
                let data = cursor.decode()?;
                if data.root != self.root_id {
                    return Err(invalid("log cursor belongs to another Root"));
                }
                Some(data)
            }
        };
        let Some(mut file) = filesystem::read(&self.path)? else {
            return Ok(HostLogPage::Missing);
        };
        let (device, identity) = filesystem::identity(&file)?;
        let end = file.metadata()?.len();
        let (start, reset) = match after {
            Some(cursor) if (cursor.device, cursor.file) != (device, identity) => (
                end.saturating_sub(RAW_LIMIT as u64),
                Some(HostLogReset::Replaced),
            ),
            Some(cursor) if cursor.offset > end => (
                end.saturating_sub(RAW_LIMIT as u64),
                Some(HostLogReset::Truncated),
            ),
            Some(cursor) => (cursor.offset, None),
            None => (end.saturating_sub(RAW_LIMIT as u64), None),
        };
        file.seek(SeekFrom::Start(start))?;
        let mut bytes = Vec::with_capacity(RAW_LIMIT);
        file.take((end - start).min(RAW_LIMIT as u64))
            .read_to_end(&mut bytes)?;
        let offset = start + bytes.len() as u64;
        let cursor = HostLogCursor::encode(CursorData {
            root: self.root_id.clone(),
            device,
            file: identity,
            offset,
        })?;
        Ok(HostLogPage::Data {
            cursor,
            bytes: STANDARD.encode(bytes),
            reset,
            truncated: start != 0 && (tail || reset.is_some()),
            has_more: offset < end,
        })
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}
fn validate_root(root: &str) -> io::Result<()> {
    if root.len() == 64
        && root
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        Ok(())
    } else {
        Err(invalid(
            "Root ID must contain 64 lowercase hexadecimal characters",
        ))
    }
}
