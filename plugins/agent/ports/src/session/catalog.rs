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

/// A continuation binds to one catalog revision. A conflict requires a fresh first page.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct List {
    pub revision: Option<String>,
    pub cursor: Option<String>,
    #[serde(default)]
    pub include_archived: bool,
}
impl List {
    pub fn validate(&self) -> Result<(), maka_capabilities::authorization::CommandError> {
        if self.revision.as_ref().is_some_and(|value| value.is_empty())
            || self.cursor.as_ref().is_some_and(|value| value.is_empty())
            || (self.cursor.is_some() && self.revision.is_none())
        {
            return Err(maka_capabilities::authorization::CommandError::Invalid(
                "invalid Session catalog continuation".into(),
            ));
        }
        Ok(())
    }
}
