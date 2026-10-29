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

//! Complete canonical model bodies, references and non-authorizing partial evidence.

use super::{ModelFinishReason, ModelPart, ModelUsage, body::TextBody};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{sync::Arc, time::SystemTime};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelPartRecord {
    pub ordinal: u64,
    pub message_id: String,
    pub started_at: SystemTime,
    pub provider_part_id: Option<String>,
    pub part: Arc<ModelPart>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordedPartRef {
    pub event_id: String,
    pub ordinal: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum CompletionPart {
    Own(ModelPartRecord),
    Ref(RecordedPartRef),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelCompletion {
    pub parts: Vec<CompletionPart>,
    pub finish_reason: ModelFinishReason,
    pub usage: ModelUsage,
    pub provider_options: Option<Arc<Value>>,
    pub response_id: Option<String>,
    pub model: Option<String>,
    pub timestamp: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum ModelObservation {
    Part(ModelPartRecord),
    ResponseMetadata {
        id: Option<String>,
        model: Option<String>,
        timestamp: Option<String>,
    },
    ProviderOptions {
        provider_part_id: Option<String>,
        options: Arc<Value>,
    },
    Finished {
        reason: ModelFinishReason,
        usage: ModelUsage,
        provider_options: Option<Arc<Value>>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolInputPhase {
    Open,
    Finished,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolInputView {
    pub id: String,
    pub message_id: String,
    pub started_at: SystemTime,
    pub name: String,
    pub provider_executed: bool,
    pub text: TextBody,
    pub phase: ToolInputPhase,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelPartial {
    pub parts: Vec<CompletionPart>,
    pub tool_inputs: Vec<ToolInputView>,
    pub response_id: Option<String>,
    pub model: Option<String>,
    pub timestamp: Option<String>,
}
