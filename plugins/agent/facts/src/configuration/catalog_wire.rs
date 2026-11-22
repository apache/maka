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
use super::*;
/// A confirmed rejection contains no provider diagnostics or user input.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ConfigurationRejection {
    InvalidInput,
    InvalidConfiguration,
    ProviderUnavailable,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CatalogMutationResult {
    Rejected {
        reason: ConfigurationRejection,
    },
    Committed {
        catalog_revision: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        connection: Option<ConnectionVersionBasis>,
    },
    RevisionConflict {
        expected_revision: u64,
        actual_revision: u64,
    },
    ConnectionExists {
        slug: String,
    },
    ConnectionStale {
        expected: ConnectionVersionBasis,
        #[schemars(
            with = "maka_plugin_core::wire_schema::RequiredNullable<ConnectionVersionBasis>"
        )]
        actual: Option<ConnectionVersionBasis>,
    },
    InvalidDefaultTarget {
        target: ConnectionTarget,
    },
}
pub type CreateCatalogConnectionResult = CatalogMutationResult;
pub type UpdateCatalogConnectionResult = CatalogMutationResult;
pub type RemoveCatalogConnectionResult = CatalogMutationResult;
pub type SetDefaultConnectionTargetResult = CatalogMutationResult;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ConnectionCatalogQueryInput {
    Start,
    Continue {
        revision: u64,
        cursor: ConnectionCatalogCursor,
    },
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "part",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ConnectionCatalogCursor {
    Connection {
        connection_index: usize,
    },
    EnabledModelId {
        connection_index: usize,
        item_index: usize,
    },
    Model {
        connection_index: usize,
        item_index: usize,
    },
    CatalogEntry {
        connection_index: usize,
        item_index: usize,
    },
}
