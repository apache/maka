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

//! Semantic transcript records. Identities are scoped to one mounted resource;
//! a record never grants native Session, filesystem or mutation authority.

pub mod resource;
mod validate;
pub use resource::{Direction, Event, Open, Page, Read, Record, Resource};

use serde::{Deserialize, Serialize};
use std::ops::Range;

pub const MAX_RECORD_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_WINDOW_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_RECORDS: usize = 256;
pub const MAX_FRAGMENT_BYTES: usize = 8 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Key {
    pub turn: String,
    pub message: String,
    pub part: Part,
}

/// Group summary and timing keys belong to the reader, never to providers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Part {
    Text,
    Thinking,
    Tool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    User,
    Assistant,
    Thinking,
    Tool,
    Failure,
    Other,
    Meta,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolState {
    Pending,
    Waiting,
    Returned,
    Attention,
    Failed,
    TimedOut,
    Cancelled,
    Completed,
    Missing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Affinity {
    Read,
    Search,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Block {
    pub key: Key,
    /// Equality identity of this presentation, independent of a page fence.
    pub revision: String,
    pub kind: Kind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<ToolState>,
    pub content: Content,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub affinity: Option<Affinity>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Content {
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diff: Vec<DiffRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<Link>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emphasis: Option<Range<usize>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Link {
    pub source: Range<usize>,
    /// A copyable path, not permission to resolve or read a local file.
    pub path: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffKind {
    Removed,
    Added,
    Context,
    Content,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiffRow {
    pub source: Range<usize>,
    pub kind: DiffKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Completed,
    Failed,
    Aborted,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct End {
    pub at_ms: i64,
    pub outcome: Outcome,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Timing {
    pub turn: String,
    pub start_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<End>,
    #[serde(default, skip_serializing_if = "inactive")]
    pub active: bool,
}

fn inactive(value: &bool) -> bool {
    !*value
}
