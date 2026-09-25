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

use serde::{Deserialize, Serialize};

/// Identity of a published behavior, not a closed list of business workflows.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct BehaviorId(String);

impl BehaviorId {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// A collaboration-specific registration is required; never silently fall
    /// back to an unconstrained behavior for another collaboration mode.
    pub fn for_collaboration(&self, mode: super::CollaborationMode) -> Result<Self, &'static str> {
        match mode {
            super::CollaborationMode::Agent => Ok(self.clone()),
            super::CollaborationMode::Plan => format!("{}:plan", self.0).try_into(),
        }
    }
}
impl Default for BehaviorId {
    fn default() -> Self {
        Self("default".into())
    }
}
impl TryFrom<String> for BehaviorId {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.len() > 128
            || !value
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphabetic)
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        {
            return Err("invalid behavior ID");
        }
        Ok(Self(value))
    }
}
impl From<BehaviorId> for String {
    fn from(id: BehaviorId) -> Self {
        id.0
    }
}
