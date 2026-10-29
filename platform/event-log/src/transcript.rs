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

//! Disposable transcript/Recall read models; authority stays in the canonical ledger.
mod active;
mod compaction;
pub(crate) use active::interrupted_messages;
pub(crate) mod bodycache;
pub(crate) use bodycache::{initialize as initialize_cache, purge as purge_cache};
pub(crate) mod directory;
mod emit;
mod evidence;
mod final_output;
mod history;
mod image;
mod model;
pub mod navigation;
mod prompt;
mod read;
pub mod search;
mod source;
mod timing;
mod tool_metadata;
mod tools;
pub use read::*;

/// Budgets for one history window, including its serialized metadata.
#[derive(Clone, Copy, Debug)]
pub struct HistoryLimits {
    pub max_bytes: usize,
    pub max_chunks: Option<usize>,
    pub max_json_bytes: usize,
}

/// One canonical field within an immutable transcript row.
pub struct SourceSelection {
    pub locator: maka_agent_facts::history::RowPosition,
    pub field: maka_agent_ports::session::history::SourceField,
    pub path: Option<Vec<maka_agent_ports::session::history::SourceSegment>>,
}
