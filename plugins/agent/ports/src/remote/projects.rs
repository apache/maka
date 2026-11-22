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

//! Read-only project labels. Selection never grants workspace access.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Query {
    Start,
    Continue { revision: String, cursor: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub available: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Output {
    Page {
        revision: String,
        projects: Vec<Project>,
        next_cursor: Option<String>,
    },
    Changed {
        revision: String,
    },
}

impl Query {
    pub fn validate(&self) -> Result<(), super::Error> {
        if let Self::Continue { revision, cursor } = self
            && (!maka_agent_facts::archive::valid_projection_digest(revision)
                || cursor.is_empty()
                || cursor.len() > 128
                || !cursor
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte)))
        {
            return Err(super::Error::Invalid(
                "Invalid project page continuation".into(),
            ));
        }
        Ok(())
    }
}
