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

#[derive(Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub enum Scope {
    #[default]
    Profile,
    Session(String),
}

impl TryFrom<String> for Scope {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() {
            "profile" => Ok(Self::Profile),
            _ => {
                let session = value
                    .strip_prefix("session:")
                    .ok_or_else(|| "invalid root".to_string())?;
                if session.is_empty()
                    || session.chars().any(|c| c.is_control() || c.is_whitespace())
                {
                    return Err("invalid Session scope".into());
                }
                Ok(Self::Session(session.to_owned()))
            }
        }
    }
}

impl From<Scope> for String {
    fn from(scope: Scope) -> String {
        match scope {
            Scope::Profile => "profile".into(),
            Scope::Session(id) => format!("session:{id}"),
        }
    }
}
