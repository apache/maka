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

//! Bounded read-only presentation of the session's model-maintained checklist.
use super::*;
pub use maka_assistant::todo::{Item as TodoItem, Status as TodoStatus};

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentChecklistRead")]
pub struct ChecklistRead {
    pub session_id: String,
    #[serde(default)]
    pub offset: usize,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentChecklist")]
pub struct Checklist {
    pub enabled: bool,
    pub revision: Option<u64>,
    pub total: usize,
    pub completed: usize,
    pub current: Option<TodoItem>,
    pub offset: usize,
    #[schemars(length(max = 20))]
    pub items: Vec<TodoItem>,
    pub next_offset: Option<usize>,
}
