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

//! Bounded text pages. A continuation identifies content, never read authority.
mod page;
mod resource;
mod shell;
mod source;
mod tool_result;
pub use page::{ReadPage, TextPageScan};
pub use resource::{ResourceAddress, imported_tool_result_path, parse_imported_tool_result_path};
pub use shell::{ReadMetadata, read_shell_page};
pub use source::{Utf8Page, json_page, projection_page};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Deserializer, Serialize, de::Error as _};
use std::num::NonZeroUsize;

pub const MAX_PAGE_CHARS: usize = 7_500;
pub const DESCRIPTION: &str = "Read a file or a Maka resource using path. Resource shortcuts: task:<id>, attachment:<id>, archive:<event-id>. Prefer short prefixes: retain any fixed ID prefix (such as attachment-) and keep the next 12 ID characters, e.g. task:fd427bd7-8a6 or attachment:attachment-8ac3b2615d42. Prefixes must be unique within this Session; exact IDs take precedence and ambiguous prefixes require more characters. Files require their actual paths. PNG, JPEG, GIF and WebP files return images. Text returns one bounded page; offset is a zero-based starting line and limit is a positive line count. A large limit cannot bypass the response-size cap. If next is non-null, pass that complete object unchanged to Read to continue the requested range. partialLine means a line spans pages. Continuations reject changed content; restart with the original path.";
const PREFIX: &str = "maka://read/";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReadInput {
    #[schemars(length(min = 1))]
    #[serde(deserialize_with = "nonempty_path")]
    pub path: String,
    #[serde(
        default,
        deserialize_with = "present_offset",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "usize", range(max = MAX_SAFE_INTEGER))]
    pub offset: Option<usize>,
    #[serde(
        default,
        deserialize_with = "present_limit",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "NonZeroUsize", range(max = MAX_SAFE_INTEGER))]
    pub limit: Option<NonZeroUsize>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ReadError {
    #[error("Read requires a nonempty path and safe integer line range")]
    InvalidInput,
    #[error(
        "Invalid Read continuation. Copy the complete next object, or restart with the original path"
    )]
    InvalidContinuation,
    #[error("The content changed since the previous page. Read the original path again")]
    ContentChanged,
    #[error("Invalid Read continuation position. Copy the complete next object")]
    InvalidPosition,
}

#[derive(Clone, Debug)]
pub struct ReadRequest {
    path: String,
    start: Start,
    limit: Option<NonZeroUsize>,
}

#[derive(Clone, Debug)]
enum Start {
    Line(usize),
    Continuation { position: usize, digest: String },
}

impl ReadInput {
    /// Resolve only the address; the caller must authorize the decoded path.
    pub fn resolve(&self) -> Result<ReadRequest, ReadError> {
        if self.path.is_empty()
            || self.offset.is_some_and(|n| n as u64 > MAX_SAFE_INTEGER)
            || self
                .limit
                .is_some_and(|n| n.get() as u64 > MAX_SAFE_INTEGER)
        {
            return Err(ReadError::InvalidInput);
        }
        if !self.path.starts_with(PREFIX) {
            return Ok(ReadRequest {
                path: self.path.clone(),
                start: Start::Line(self.offset.unwrap_or(0)),
                limit: self.limit,
            });
        }
        let invalid = || ReadError::InvalidContinuation;
        let url = url::Url::parse(&self.path).map_err(|_| invalid())?;
        let path = String::from_utf8(
            URL_SAFE_NO_PAD
                .decode(&url.path()[1..])
                .map_err(|_| invalid())?,
        )
        .map_err(|_| invalid())?;
        let mut position = None;
        let mut digest = None;
        for (key, value) in url.query_pairs() {
            match key.as_ref() {
                "at" if position.is_none()
                    && !value.is_empty()
                    && value.bytes().all(|c| c.is_ascii_digit()) =>
                {
                    let number = value.parse::<u64>().map_err(|_| invalid())?;
                    if number > MAX_SAFE_INTEGER {
                        return Err(invalid());
                    }
                    position = Some(usize::try_from(number).map_err(|_| invalid())?);
                }
                "sha"
                    if digest.is_none()
                        && value.len() == 32
                        && value
                            .bytes()
                            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) =>
                {
                    digest = Some(value.into_owned())
                }
                _ => return Err(invalid()),
            }
        }
        if self.offset.is_some()
            || path.is_empty()
            || path.starts_with(PREFIX)
            || url.fragment().is_some()
        {
            return Err(invalid());
        }
        Ok(ReadRequest {
            path,
            start: Start::Continuation {
                position: position.ok_or_else(invalid)?,
                digest: digest.ok_or_else(invalid)?,
            },
            limit: self.limit,
        })
    }
}

impl ReadRequest {
    pub fn bind_imported_tool_result(
        &mut self,
        address: &crate::history::HistoryRowAddress,
    ) -> Result<(), ReadError> {
        if self.is_continuation() {
            return Err(ReadError::InvalidContinuation);
        }
        self.path = imported_tool_result_path(address).map_err(|_| ReadError::InvalidInput)?;
        Ok(())
    }

    pub fn is_continuation(&self) -> bool {
        matches!(self.start, Start::Continuation { .. })
    }

    /// Bind a first page to its resolved identity before issuing continuations.
    pub fn bind_resource(&mut self, address: &ResourceAddress) -> Result<(), ReadError> {
        if self.is_continuation() {
            return Err(ReadError::InvalidContinuation);
        }
        self.path = address
            .canonical_path()
            .map_err(|_| ReadError::InvalidInput)?;
        Ok(())
    }

    pub fn path(&self) -> &str {
        &self.path
    }
}

fn nonempty_path<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let path = String::deserialize(d)?;
    if path.is_empty() {
        return Err(D::Error::custom(ReadError::InvalidInput));
    }
    Ok(path)
}

fn present_offset<'de, D: Deserializer<'de>>(d: D) -> Result<Option<usize>, D::Error> {
    let value = u64::deserialize(d)?;
    if value > MAX_SAFE_INTEGER {
        return Err(D::Error::custom(ReadError::InvalidInput));
    }
    usize::try_from(value).map(Some).map_err(D::Error::custom)
}

fn present_limit<'de, D: Deserializer<'de>>(d: D) -> Result<Option<NonZeroUsize>, D::Error> {
    present_offset(d)?
        .and_then(NonZeroUsize::new)
        .map(Some)
        .ok_or_else(|| D::Error::custom("Read limit must be positive"))
}
