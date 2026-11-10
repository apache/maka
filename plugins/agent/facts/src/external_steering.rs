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

//! Local adoption of an exact queue cut by an external task, not a provider ACK.
use crate::durable::{ContentRef, ExternalTaskId};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Hash,
    Serialize,
    Deserialize,
    schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalSteeringKey {
    pub task: ExternalTaskId,
    pub steering: Uuid,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ExternalSteeringEvent {
    Prepared {
        key: ExternalSteeringKey,
        descriptor: ContentRef,
    },
    Admitted {
        key: ExternalSteeringKey,
    },
}
impl ExternalSteeringEvent {
    pub fn key(&self) -> ExternalSteeringKey {
        match self {
            Self::Prepared { key, .. } | Self::Admitted { key } => *key,
        }
    }
    pub fn content_refs(&self) -> Vec<&ContentRef> {
        match self {
            Self::Prepared { descriptor, .. } => vec![descriptor],
            Self::Admitted { .. } => vec![],
        }
    }
    pub fn is_admission(&self) -> bool {
        true
    }
    pub fn is_late(&self) -> bool {
        false
    }
}
