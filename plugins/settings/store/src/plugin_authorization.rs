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

//! Host consent authority. Plugin data may refer to these records but cannot
//! create, edit or reactivate them through the namespaced data API.

use crate::{ConfigError, ConfigurationStore, Result, TransactionMode};
use maka_capabilities::authorization::Grant;
use maka_capabilities::authorization::Id;
use maka_capabilities::authorization::Request;
use maka_plugin_core::authorization::Boundary;
use maka_plugin_core::storage::Namespace;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Principal {
    LocalUser {
        client_instance_id: String,
    },
    Credential {
        credential_id: String,
        client_instance_id: String,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document {
    request: Request,
    principal: Principal,
    boundary: Boundary,
}
pub struct Record {
    pub grant: Grant,
    pub principal: Principal,
    pub boundary: Boundary,
}
pub enum Approval {
    Granted(Box<Record>),
    Conflict,
}

impl ConfigurationStore {
    /// Exact retry returns the original boundary, including its revocation.
    /// Re-approval requires a new operation identity and explicit consent.
    pub async fn approve_plugin_authorization(
        &self,
        namespace: Namespace,
        principal: Principal,
        request: Request,
        boundary: Boundary,
    ) -> Result<Approval> {
        request
            .validate()
            .map_err(|error| ConfigError::Invalid(error.to_string()))?;
        self.transaction(TransactionMode::Immediate, move |connection| {
            {
            let scope = String::from(namespace.scope().clone());
            let previous = connection.prepare_cached("SELECT id, document, revoked FROM plugin_authorizations WHERE package_id = ? AND scope_id = ? AND operation_id = ?")?.query_row(rusqlite::params![namespace.package(), &scope, request.operation_id.to_string()], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?,))).optional()?;
            if let Some(row) = previous {
                let record = decode(row)?;
                return Ok(if record.grant.request == request && record.principal == principal {
                    Approval::Granted(Box::new(record))
                } else {
                    Approval::Conflict
                });
            }
            maka_capabilities::authorization::validate_boundary(&boundary, &request)
                .map_err(|error| ConfigError::Invalid(error.to_string()))?;
            let id = Id(Uuid::new_v4());
            let document = Document {
                request,
                principal,
                boundary,
            };
            let bytes = serde_json::to_string(&document)?;
            connection.execute("INSERT INTO plugin_authorizations (id, package_id, scope_id, operation_id, document) VALUES (?, ?, ?, ?, ?)", rusqlite::params![id.0.to_string(), namespace.package(), scope, document.request.operation_id.to_string(), bytes])?;
            Ok(Approval::Granted(Box::new(Record {
                grant: Grant {
                    id,
                    request: document.request,
                    revoked: false,
                },
                principal: document.principal,
                boundary: document.boundary,
            })))
            }
        }).await
    }

    /// Read does not confer authority. Host must also check the current principal,
    /// workspace identity, Session boundary and live plugin ownership before use.
    pub async fn plugin_authorization(
        &self,
        namespace: Namespace,
        id: Id,
    ) -> Result<Option<Record>> {
        self.transaction(TransactionMode::Deferred, move |connection| {
            {
            connection.prepare_cached("SELECT id, document, revoked FROM plugin_authorizations WHERE id = ? AND package_id = ? AND scope_id = ?")?.query_row(rusqlite::params![id.0.to_string(), namespace.package(), String::from(namespace.scope().clone())], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?,))).optional()?.map(decode).transpose()
            }
        }).await
    }

    /// Recover an approval receipt without recapturing a potentially changed
    /// target. The caller must compare both proposal and issuing principal.
    pub async fn plugin_authorization_operation(
        &self,
        namespace: Namespace,
        operation_id: Uuid,
    ) -> Result<Option<Record>> {
        self.transaction(TransactionMode::Deferred, move |connection| {
            {
                connection.prepare_cached("SELECT id, document, revoked FROM plugin_authorizations WHERE package_id = ? AND scope_id = ? AND operation_id = ?")?.query_row(rusqlite::params![namespace.package(), String::from(namespace.scope().clone()), operation_id.to_string()], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?,))).optional()?.map(decode).transpose()
            }
        }).await
    }

    /// Idempotent and monotonic; never delete the idempotency tombstone.
    pub async fn revoke_plugin_authorization(&self, namespace: Namespace, id: Id) -> Result<()> {
        self.transaction(TransactionMode::Immediate, move |connection| {
            {
            connection.execute("UPDATE plugin_authorizations SET revoked = 1 WHERE id = ? AND package_id = ? AND scope_id = ?", rusqlite::params![id.0.to_string(), namespace.package(), String::from(namespace.scope().clone())])?;
            Ok(())
            }
        }).await
    }
}

fn decode((id, json, revoked): (String, String, i64)) -> Result<Record> {
    let document: Document = serde_json::from_str(&json)?;
    document
        .request
        .validate()
        .map_err(|error| ConfigError::Invalid(error.to_string()))?;
    maka_capabilities::authorization::validate_boundary(&document.boundary, &document.request)
        .map_err(|error| ConfigError::Invalid(error.to_string()))?;
    Ok(Record {
        grant: Grant {
            id: Id(Uuid::parse_str(&id).map_err(|error| ConfigError::Invalid(error.to_string()))?),
            request: document.request,
            revoked: revoked != 0,
        },
        principal: document.principal,
        boundary: document.boundary,
    })
}
