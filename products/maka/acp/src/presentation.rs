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

use serde_json::{Map, Value};

pub(crate) type Meta = Map<String, Value>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum MessageKind {
    User,
    Text,
    Thinking,
}

#[derive(Clone, Debug)]
pub(crate) enum Text {
    Snapshot(String),
    Delta(String),
    Metadata,
}

#[derive(Clone, Debug)]
pub(crate) enum Update {
    Message {
        id: String,
        kind: MessageKind,
        text: Text,
        meta: Meta,
    },
    Tool(ToolCard),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ToolStatus {
    Running,
    Completed,
    Failed,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ToolCard {
    pub id: String,
    pub title: String,
    pub name: Option<String>,
    pub status: ToolStatus,
    pub input: Option<Value>,
    pub output: Option<String>,
    pub meta: Meta,
}

#[cfg(test)]
pub(crate) fn wire(update: &Update) -> Result<Value, serde_json::Error> {
    serde_json::to_value(crate::transport::v2::update(update.clone()))
}

#[derive(Clone, Copy)]
pub(crate) enum State {
    Running,
    RequiresAction,
}
#[derive(Clone, Copy)]
pub(crate) enum Completion {
    Completed,
    Cancelled,
    Failed,
}
