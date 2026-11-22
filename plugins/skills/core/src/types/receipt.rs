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

use super::{SkillFailureReason, SkillInvocationMode, SkillScope, SkillSource};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error, ser::SerializeMap};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkillInvocationReceipt {
    Loaded(SkillLoadedReceipt),
    Failed(SkillFailedReceipt),
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillLoadedReceipt {
    pub invocation: SkillInvocationMode,
    pub request: String,
    pub skill_ref: String,
    pub id: String,
    pub name: String,
    pub scope: SkillScope,
    pub source: SkillSource,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillFailedReceipt {
    pub invocation: SkillInvocationMode,
    pub request: String,
    pub reason: SkillFailureReason,
}

impl Serialize for SkillInvocationReceipt {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(match self {
            Self::Loaded(_) => 8,
            Self::Failed(_) => 4,
        }))?;
        match self {
            Self::Loaded(r) => {
                map.serialize_entry("invocation", &r.invocation)?;
                map.serialize_entry("request", &r.request)?;
                map.serialize_entry("success", &true)?;
                map.serialize_entry("ref", &r.skill_ref)?;
                map.serialize_entry("id", &r.id)?;
                map.serialize_entry("name", &r.name)?;
                map.serialize_entry("scope", &r.scope)?;
                map.serialize_entry("source", &r.source)?;
            }
            Self::Failed(r) => {
                map.serialize_entry("invocation", &r.invocation)?;
                map.serialize_entry("request", &r.request)?;
                map.serialize_entry("success", &false)?;
                map.serialize_entry("reason", &r.reason)?;
            }
        }
        map.end()
    }
}

/// Boolean wire discriminants are validated here, not retained as mutable
/// business fields beside a contradictory enum variant.
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(untagged, deny_unknown_fields)]
enum WireReceipt {
    Loaded {
        invocation: SkillInvocationMode,
        request: String,
        success: bool,
        #[serde(rename = "ref")]
        skill_ref: String,
        id: String,
        name: String,
        scope: SkillScope,
        source: SkillSource,
    },
    Failed {
        invocation: SkillInvocationMode,
        request: String,
        success: bool,
        reason: SkillFailureReason,
    },
}

impl schemars::JsonSchema for SkillInvocationReceipt {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "SkillInvocationReceipt".into()
    }
    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        let mut schema = <WireReceipt as schemars::JsonSchema>::json_schema(generator);
        let variants = schema
            .get_mut("anyOf")
            .and_then(serde_json::Value::as_array_mut)
            .expect("untagged skill receipt variants");
        for (index, variant) in variants.iter_mut().enumerate() {
            variant["properties"]["success"] = serde_json::json!({"const": index == 0});
        }
        schema
    }
}

impl<'de> Deserialize<'de> for SkillInvocationReceipt {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match WireReceipt::deserialize(deserializer)? {
            WireReceipt::Loaded {
                invocation,
                request,
                success: true,
                skill_ref,
                id,
                name,
                scope,
                source,
            } => Ok(Self::Loaded(SkillLoadedReceipt {
                invocation,
                request,
                skill_ref,
                id,
                name,
                scope,
                source,
            })),
            WireReceipt::Failed {
                invocation,
                request,
                success: false,
                reason,
            } => Ok(Self::Failed(SkillFailedReceipt {
                invocation,
                request,
                reason,
            })),
            _ => Err(D::Error::custom("contradictory skill receipt outcome")),
        }
    }
}
