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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagedPrincipalKind {
    RemoteOwner,
    CapabilityProvider,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityOwnerIdentity {
    pub principal_id: String,
    pub client_instance_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessCredentialIssueInput {
    pub principal_kind: ManagedPrincipalKind,
    pub principal_id: String,
    // The source wire decoder accepts unknown operation strings; issuance authorizes them.
    pub operation_grants: Vec<String>,
    pub can_publish_client_capabilities: bool,
    pub can_use_host_paths: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capability_owner_credential_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessCredentialPrepareInput {
    pub principal_kind: ManagedPrincipalKind,
    pub principal_id: String,
    pub operation_grants: Vec<String>,
    pub can_publish_client_capabilities: bool,
    pub can_use_host_paths: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bind_client_instance: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessCredentialFinalizeResult {
    pub reconnect_required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessCredentialIssueResult {
    pub credential_id: String,
    pub delivery_id: String,
    pub principal_kind: ManagedPrincipalKind,
    pub principal_id: String,
    pub operation_grants: Vec<String>,
    pub can_publish_client_capabilities: bool,
    pub can_use_host_paths: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capability_owner: Option<CapabilityOwnerIdentity>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessCredentialRevokeInput {
    pub credential_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessCredentialRevokeResult {
    pub credential_id: String,
    pub revoked: bool,
}
