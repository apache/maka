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

#[derive(Clone, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "WebQuery")]
pub struct Query {
    #[schemars(length(min = 1))]
    pub query: String,
    #[serde(default = "default_limit")]
    // Tavily Search API supports max_results from 0 through 20.
    #[schemars(range(min = 1, max = 20))]
    pub limit: usize,
}
fn default_limit() -> usize {
    5
}
impl Query {
    pub fn is_valid(&self) -> bool {
        !self.query.trim().is_empty() && (1..=20).contains(&self.limit)
    }
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[schemars(rename = "WebResults")]
#[serde(rename_all = "camelCase")]
pub struct Results {
    pub query: String,
    pub rows: Vec<Row>,
    pub truncated: bool,
    pub omitted_results: usize,
}
#[derive(Debug, Serialize, schemars::JsonSchema)]
#[schemars(rename = "WebRow")]
pub struct Row {
    pub title: String,
    pub url: String,
    pub snippet: String,
}
