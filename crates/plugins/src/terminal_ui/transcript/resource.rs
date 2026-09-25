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

//! A mount owns one Remote document and one stream. The first item is Ready:
//! it captures a snapshot and subscribes atomically. Page reads use that fence;
//! later stream revisions are contiguous. Cancellation closes the document.

use super::{Block, Key, Timing};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Resource {
    pub id: String,
    /// Method and stream names resolve only in the containing View's package,
    /// exact entry/activation and captured Session scope.
    pub read: String,
    pub stream: String,
    #[serde(default)]
    pub route: Value,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Open {
    pub resource: String,
    pub route: Value,
    pub locale: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Tail,
    Older,
    Newer,
    Continue,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Read {
    pub resource: String,
    pub fence: u64,
    pub direction: Direction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// A complete record or ordered UTF-8 fragments of its JSON encoding. A
/// fragment's identity, revision and total remain fixed until assembly ends;
/// it is not visible before the full validated record has arrived.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Record {
    Block {
        block: Block,
    },
    Fragment {
        key: Key,
        revision: String,
        offset: usize,
        total: usize,
        json: String,
    },
}

/// Records are in presentation order. Continue assembles the same logical
/// page; only its final response supplies the adjacent page cursors.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Page {
    pub fence: u64,
    pub records: Vec<Record>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub timings: Vec<Timing>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub older: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub newer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuation: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Event {
    Ready {
        fence: u64,
    },
    /// Replace in place; a new key is appended. All fragments of one record
    /// repeat base/revision; the revision commits only on complete assembly.
    Replace {
        base: u64,
        revision: u64,
        append: bool,
        record: Record,
    },
    Append {
        base: u64,
        revision: u64,
        key: Key,
        block_base: String,
        block_revision: String,
        offset: usize,
        text: String,
    },
    Remove {
        base: u64,
        revision: u64,
        key: Key,
    },
    Timing {
        base: u64,
        revision: u64,
        timing: Timing,
    },
    /// The snapshot expired or the provider could not retain a contiguous
    /// update stream. The reader must close and open a fresh resource.
    Invalidated,
}
