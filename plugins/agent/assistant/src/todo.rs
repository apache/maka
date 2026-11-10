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

//! Session checklists are plugin data, not execution evidence or a work queue.
use maka_plugin_core::storage::Data;
use maka_plugin_core::storage::Mutation;
use maka_plugin_core::storage::Store;
use maka_plugin_core::storage::StoreError;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::watch;

pub const ID: &str = "maka.todo";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "AgentTodoItem")]
pub struct Item {
    #[schemars(length(min = 1))]
    pub content: String,
    pub status: Status,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentTodoStatus")]
pub enum Status {
    Pending,
    InProgress,
    Completed,
}
impl Status {
    fn label(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
        }
    }
}
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Document {
    pub items: Vec<Item>,
}
impl Document {
    pub fn normalize(mut items: Vec<Item>) -> Result<Self, String> {
        for item in &mut items {
            item.content = item
                .content
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            if item.content.is_empty() || item.content.chars().any(char::is_control) {
                return Err("Todo content must be nonempty and contain no control codes".into());
            }
        }
        Ok(Self { items })
    }
    pub fn render(&self) -> String {
        if self.items.is_empty() {
            return "Todo list is empty.".into();
        }
        self.items
            .iter()
            .enumerate()
            .map(|(index, item)| {
                // Quoted text stays data; no secret redaction or invented XML framing.
                format!(
                    "{}. [{}] {}",
                    index + 1,
                    item.status.label(),
                    serde_json::to_string(&item.content).unwrap()
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

pub struct Snapshot {
    pub revision: Option<u64>,
    pub document: Document,
}
pub struct Repository {
    pub store: Arc<dyn Store>,
    pub changed: watch::Sender<()>,
}
impl Repository {
    pub async fn read(&self, session: &str) -> Result<Snapshot, StoreError> {
        let record = self.store.read(format!("session/{session}")).await?;
        let revision = record.as_ref().map(|record| record.revision);
        let document = match record.and_then(|record| record.data.value().cloned()) {
            Some(value) => serde_json::from_value(value)
                .map_err(|error| StoreError::Unavailable(error.to_string()))?,
            None => Document::default(),
        };
        Ok(Snapshot { revision, document })
    }
    pub async fn replace(
        &self,
        session: &str,
        expected: Option<u64>,
        document: &Document,
    ) -> Result<(), StoreError> {
        self.store
            .batch(vec![Mutation {
                key: format!("session/{session}"),
                expected_revision: expected,
                data: Data::Present(
                    serde_json::to_value(document)
                        .map_err(|error| StoreError::Unavailable(error.to_string()))?,
                ),
            }])
            .await?;
        self.changed.send_replace(());
        Ok(())
    }
}
