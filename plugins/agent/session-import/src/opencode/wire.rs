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

use crate::transcript::Timestamp;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
pub(super) struct Message {
    pub role: Role,
    #[serde(rename = "modelID")]
    pub model: Option<String>,
    pub time: Option<Time>,
    pub finish: Option<String>,
    pub error: Option<Failure>,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Role {
    User,
    Assistant,
}
#[derive(Deserialize)]
pub(super) struct Time {
    pub created: Option<Timestamp>,
}
#[derive(Deserialize)]
pub(super) struct Failure {
    pub name: String,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum Part {
    Text {
        text: String,
        #[serde(default)]
        synthetic: bool,
    },
    Reasoning {
        text: String,
    },
    Tool {
        #[serde(rename = "callID")]
        call_id: String,
        tool: String,
        state: State,
    },
    File {
        filename: Option<String>,
        mime: Option<String>,
    },
    Compaction,
    #[serde(other)]
    Other,
}
#[derive(Deserialize)]
pub(super) struct State {
    pub status: Status,
    pub input: Option<Value>,
    pub output: Option<String>,
    pub error: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Status {
    Pending,
    Running,
    Completed,
    Error,
}
