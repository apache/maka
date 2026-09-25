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

use crate::{Client, ClientError, RequestFailure};
use maka_protocol::{Operation, plugin::*};

impl Client {
    /// Reads Host-accessible source bytes without installing or activating them.
    pub async fn plugin_package_preview(
        &self,
        source_path: String,
    ) -> Result<PackagePreview, RequestFailure> {
        let value = self
            .request(
                Operation::PluginPackagePreview,
                serde_json::json!({"sourcePath": source_path}),
            )
            .await?;
        let result: PackagePreview = serde_json::from_value(value)
            .map_err(|error| self.invalid_plugin_result(error.to_string()))?;
        if result.source_path != source_path {
            return Err(self.invalid_plugin_result("Package preview does not match its source"));
        }
        Ok(result)
    }

    pub async fn plugin_package_install(
        &self,
        input: PackageInstall,
    ) -> Result<Installed, RequestFailure> {
        let value = self
            .request(
                Operation::PluginPackageInstall,
                serde_json::to_value(input).expect("wire input"),
            )
            .await?;
        serde_json::from_value(value).map_err(|error| self.invalid_plugin_result(error.to_string()))
    }

    /// Restarts stored bytes; this does not read or update the original source.
    pub async fn plugin_package_restart(
        &self,
        input: PackageTarget,
    ) -> Result<Receipt, RequestFailure> {
        self.plugin_receipt(Operation::PluginPackageReload, &input)
            .await
    }

    pub async fn plugin_package_uninstall(
        &self,
        input: PackageTarget,
    ) -> Result<Receipt, RequestFailure> {
        self.plugin_receipt(Operation::PluginPackageUninstall, &input)
            .await
    }

    pub async fn plugin_composition_apply(&self, input: Apply) -> Result<Receipt, RequestFailure> {
        self.plugin_receipt(Operation::PluginCompositionApply, &input)
            .await
    }

    async fn plugin_receipt(
        &self,
        operation: Operation,
        input: &impl serde::Serialize,
    ) -> Result<Receipt, RequestFailure> {
        let value = self
            .request(operation, serde_json::to_value(input).expect("wire input"))
            .await?;
        serde_json::from_value(value).map_err(|error| self.invalid_plugin_result(error.to_string()))
    }

    pub async fn plugin_authorization(
        &self,
        input: AuthorizationInput,
    ) -> Result<AuthorizationResult, RequestFailure> {
        let value = self
            .request(
                Operation::PluginAuthorization,
                serde_json::to_value(&input).expect("wire input"),
            )
            .await?;
        let result: AuthorizationResult = serde_json::from_value(value)
            .map_err(|error| self.invalid_plugin_result(error.to_string()))?;
        let valid = match (input.command(), &result) {
            (
                AuthorizationCommand::Approve { request },
                AuthorizationResult::Grant { grant: Some(grant) },
            ) => grant.request == *request,
            (AuthorizationCommand::Query { id }, AuthorizationResult::Grant { grant }) => {
                grant.as_ref().is_none_or(|grant| grant.id == *id)
            }
            (AuthorizationCommand::Revoke { .. }, AuthorizationResult::Revoked) => true,
            _ => false,
        };
        if !valid {
            return Err(
                self.invalid_plugin_result("Plugin authorization does not match the request")
            );
        }
        Ok(result)
    }
    pub async fn plugin_query(&self, input: Query) -> Result<QueryResult, RequestFailure> {
        let value = self
            .request(
                Operation::PluginPlatformQuery,
                serde_json::to_value(&input).expect("wire input"),
            )
            .await?;
        let result: QueryResult = serde_json::from_value(value)
            .map_err(|error| self.invalid_plugin_result(error.to_string()))?;
        let actual = match &result {
            QueryResult::Status(_) => View::Status,
            QueryResult::Packages(_) => View::Packages,
            QueryResult::Entries(_) => View::Entries,
            QueryResult::Tools(_) => View::Tools,
            QueryResult::Commands(_) => View::Commands,
            QueryResult::Executors(_) => View::Executors,
            QueryResult::TerminalViews(_) => View::TerminalViews,
            QueryResult::Failures(_) => View::Failures,
        };
        if actual != input.view {
            return Err(self.invalid_plugin_result(
                "Plugin directory response does not match the requested view",
            ));
        }
        Ok(result)
    }

    /// Calls one operation on the current connection. Never binds a replacement or
    /// replays an unknown call; the caller owns document and stream lifetimes.
    pub async fn plugin_remote(
        &self,
        input: RemoteRequest,
    ) -> Result<RemoteResult, RequestFailure> {
        let value = self
            .request(
                Operation::PluginRemote,
                serde_json::to_value(&input).expect("wire input"),
            )
            .await?;
        let result: RemoteResult = serde_json::from_value(value)
            .map_err(|error| self.invalid_plugin_result(error.to_string()))?;
        let valid = matches!(
            (&input, &result),
            (RemoteRequest::OpenDocument, RemoteResult::Document { .. })
                | (RemoteRequest::Bind { .. }, RemoteResult::Bound { .. })
                | (RemoteRequest::Call { .. }, RemoteResult::Value { .. })
                | (RemoteRequest::Open { .. }, RemoteResult::Opened { .. })
                | (
                    RemoteRequest::Next { .. },
                    RemoteResult::Item { .. } | RemoteResult::Pending | RemoteResult::End
                )
                | (
                    RemoteRequest::Close { .. } | RemoteRequest::CloseDocument { .. },
                    RemoteResult::Closed
                )
        );
        if !valid {
            return Err(self.invalid_plugin_result("Remote response does not match the request"));
        }
        Ok(result)
    }

    pub async fn plugin_clients(&self, input: ClientQuery) -> Result<ClientResult, RequestFailure> {
        let value = self
            .request(
                Operation::PluginClientQuery,
                serde_json::to_value(&input).expect("wire input"),
            )
            .await?;
        let result: ClientResult = serde_json::from_value(value)
            .map_err(|error| self.invalid_plugin_result(error.to_string()))?;
        let valid = match (&input, &result) {
            (
                ClientQuery::Snapshot { cursor },
                ClientResult::Snapshot {
                    revision, entries, ..
                },
            ) => cursor.as_ref().is_none_or(|cursor| {
                &cursor.revision == revision
                    && entries
                        .first()
                        .is_none_or(|entry| entry.entry_id > cursor.after_entry)
            }),
            (
                ClientQuery::Bundle {
                    entry_id,
                    activation,
                    client_digest,
                    offset,
                },
                ClientResult::Bundle {
                    entry_id: actual,
                    activation: active,
                    client_digest: digest,
                    offset: start,
                    ..
                },
            ) => {
                entry_id == actual
                    && activation == active
                    && client_digest == digest
                    && offset == start
            }
            _ => false,
        };
        if !valid {
            return Err(
                self.invalid_plugin_result("Plugin client response does not match the request")
            );
        }
        Ok(result)
    }

    fn invalid_plugin_result(&self, message: impl Into<String>) -> RequestFailure {
        self.disconnect();
        RequestFailure::Unknown(ClientError::Protocol(message.into()))
    }
}
