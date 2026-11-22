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

use crate::schedule::Schedule;
use maka_agent_facts::configuration::Patch;
use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[serde(bound(deserialize = "E: Deserialize<'de>"))]
pub struct Update<E> {
    #[serde(default, deserialize_with = "present")]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub intent_body: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub schedule: Option<Schedule>,
    #[serde(default, deserialize_with = "present")]
    pub effect: Option<E>,
    #[serde(default)]
    pub max_fires: Patch<u32>,
    #[serde(default)]
    pub expires_at: Patch<i64>,
}
impl<E> Default for Update<E> {
    fn default() -> Self {
        Self {
            title: None,
            intent_body: None,
            schedule: None,
            effect: None,
            max_fires: Patch::Keep,
            expires_at: Patch::Keep,
        }
    }
}
fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}
