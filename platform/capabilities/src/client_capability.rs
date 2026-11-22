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
use serde_json::{Map, Value};

/// Durable input evidence for an admitted client tool effect.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Call {
    pub name: String,
    pub input: Map<String, Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Notification {
    pub id: String,
    pub title: String,
    pub body: String,
    pub destination: Destination,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Destination {
    Local,
    Channel { channel: String, recipient: String },
}
impl Notification {
    pub fn validate(&self) -> Result<(), crate::Error> {
        crate::name(&self.id)?;
        if self.title.trim().is_empty() || self.title.len() > 512 || self.body.len() > 32 * 1024 {
            return Err(crate::Error::Invalid(
                "notification exceeds content limits".into(),
            ));
        }
        if let Destination::Channel { channel, recipient } = &self.destination {
            maka_plugin_core::identifier(channel)
                .map_err(|e| crate::Error::Invalid(e.to_string()))?;
            if recipient.trim().is_empty() || recipient.len() > 512 || recipient.contains('\0') {
                return Err(crate::Error::Invalid(
                    "invalid notification recipient".into(),
                ));
            }
        }
        Ok(())
    }
}
