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

use super::*;
use std::{collections::BTreeSet, io::Read, path::PathBuf};

/// Neither variant asserts an OS-enforced point-in-time filesystem snapshot.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceConsistency {
    CallerConfirmedQuiescent,
    Unverified,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceCapture {
    pub root: PathBuf,
    pub consistency: WorkspaceConsistency,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceSnapshot {
    pub consistency: WorkspaceConsistency,
    /// Path inventory; file bodies are separately verified immutable objects.
    pub inventory: ObjectRef,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkspaceEntry {
    Directory {
        path: String,
    },
    File {
        path: String,
        object: ObjectRef,
        executable: bool,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Inventory {
    pub(crate) entries: Vec<WorkspaceEntry>,
}

pub(crate) fn relative(path: &str) -> Result<(), StoreError> {
    if path.is_empty()
        || path.len() > 4096
        || path.contains('\\')
        || path.contains(':')
        || path.chars().any(char::is_control)
        || path
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == ".." || p.ends_with(['.', ' ']))
    {
        return Err(invalid("nonportable checkpoint workspace path"));
    }
    Ok(())
}

pub(crate) fn read_inventory(source: impl Read) -> Result<Vec<WorkspaceEntry>, StoreError> {
    let inventory: Inventory = serde_json::from_reader(source)?;
    let mut paths = BTreeSet::new();
    let mut directories = BTreeSet::new();
    let mut total = 0u64;
    for entry in &inventory.entries {
        let path = match entry {
            WorkspaceEntry::Directory { path } | WorkspaceEntry::File { path, .. } => path,
        };
        relative(path)?;
        // Reject case aliases even when the publishing filesystem happens to allow them.
        if !paths.insert(path.to_lowercase()) {
            return Err(invalid("checkpoint workspace path collision"));
        }
        if let Some((parent, _)) = path.rsplit_once('/')
            && !directories.contains(parent)
        {
            return Err(invalid("checkpoint workspace parent missing"));
        }
        match entry {
            WorkspaceEntry::Directory { path } => {
                directories.insert(path.as_str());
            }
            WorkspaceEntry::File { object, .. } => {
                total = total
                    .checked_add(object.bytes)
                    .ok_or_else(|| invalid("checkpoint workspace size overflow"))?;
            }
        }
    }
    Ok(inventory.entries)
}
