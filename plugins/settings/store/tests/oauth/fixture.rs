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
use maka_agent_facts::oauth::LoginStart;
use maka_agent_facts::oauth::Target;
use maka_agent_facts::provider::AuthenticationInput;
use maka_agent_facts::provider::Credential;
use maka_agent_facts::provider::Identity;
use maka_config::oauth::enrollment::{LoginCompletion, LoginPreparation};
use maka_plugin_core::scope::Scope;

pub(super) fn credential(secret: &str) -> Credential {
    Credential {
        secret: secret.into(),
        refresh_at: Some(50_000),
    }
}

pub(super) struct Fixture {
    pub(super) _temp: tempfile::TempDir,
    pub(super) store: Arc<ConfigurationStore>,
    pub(super) target: ConnectionCredentialTarget,
}
impl Fixture {
    pub(super) async fn new(name: &str) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let owner = Arc::new(
            RootOwner::create(&temp.path().join("root"), &namespaces(temp.path())).unwrap(),
        );
        let store = Arc::new(ConfigurationStore::for_root(owner).await.unwrap());
        let provider = Identity {
            package_id: "external.provider".into(),
            entry_id: "external-entry".into(),
            scope: Scope::Profile,
            name: name.into(),
        };
        let created = store
            .create_connection(CreateCatalogConnectionInput {
                expected_catalog_revision: 0,
                connection: ConnectionCatalogEntryDraft {
                    slug: "subscription".into(),
                    name: "Subscription".into(),
                    provider: provider.clone(),
                    configuration: json!({"endpoint":"https://provider.test/v1"}),
                    enabled: true,
                    enabled_model_ids: vec![],
                    model_overrides: None,
                    request_body_overlay: None,
                },
            })
            .await
            .unwrap();
        let CatalogMutationResult::Committed {
            connection: Some(basis),
            ..
        } = created
        else {
            panic!("created connection");
        };
        let target = ConnectionCredentialTarget {
            connection_id: basis.connection_id,
            revision: basis.revision,
            slug: "subscription".into(),
            provider,
            configuration: json!({"endpoint":"https://provider.test/v1"}),
        };
        Self {
            _temp: temp,
            store,
            target,
        }
    }

    pub(super) async fn login(&mut self, secret: &str) {
        let input = LoginStart {
            expected_credential: match self
                .store
                .credential_status(
                    maka_agent_facts::configuration::CredentialLocator::Connection {
                        connection_id: self.target.connection_id.clone(),
                        kind: maka_agent_facts::configuration::ConnectionCredentialKind::Provider,
                    },
                )
                .await
                .unwrap()
            {
                maka_agent_facts::configuration::CredentialVaultQueryResult::Status { status } => {
                    status.basis()
                }
                _ => panic!("connection status"),
            },
            attempt_id: uuid::Uuid::new_v4().to_string(),
            target: Target::Existing {
                expected: self.target.clone(),
                configuration: self.target.configuration.clone(),
            },
            authentication: AuthenticationInput {
                method: "account".into(),
                input: json!({}),
            },
        };
        let LoginPreparation::Ready(ticket) = self.store.prepare_oauth_login(input).await.unwrap()
        else {
            panic!("prepared authentication");
        };
        assert!(matches!(
            ticket.complete(credential(secret), 10).await.unwrap(),
            LoginCompletion::Committed(_)
        ));
        self.target.revision = ticket.connection().revision;
    }
    pub(super) async fn snapshot(&self) -> ProviderCredential {
        self.store
            .provider_credential(self.target.clone())
            .await
            .unwrap()
            .unwrap()
    }
    pub(super) async fn update(&mut self, enabled: bool) {
        let row = self.store.catalog().await.unwrap().connections.remove(0);
        let result = self
            .store
            .update_connection(UpdateCatalogConnectionInput {
                expected: ConnectionVersionBasis {
                    connection_id: row.connection_id,
                    revision: row.revision,
                },
                changes: ConnectionCatalogEntryUpdate {
                    name: Some(format!("Edited during refresh {}", row.revision)),
                    configuration: Some(row.configuration),
                    enabled: Some(enabled),
                    enabled_model_ids: Some(row.enabled_model_ids),
                    model_overrides: Patch::Keep,
                    request_body_overlay: Patch::Keep,
                },
            })
            .await
            .unwrap();
        let CatalogMutationResult::Committed {
            connection: Some(basis),
            ..
        } = result
        else {
            panic!("updated connection");
        };
        self.target.revision = basis.revision;
    }
    pub(super) async fn remove(&self) {
        let result = self
            .store
            .remove_connection(RemoveCatalogConnectionInput {
                expected: ConnectionVersionBasis {
                    connection_id: self.target.connection_id.clone(),
                    revision: self.target.revision,
                },
            })
            .await
            .unwrap();
        assert!(matches!(result, CatalogMutationResult::Committed { .. }));
    }
}
pub(super) fn namespaces(path: &std::path::Path) -> RootNamespaces {
    RootNamespaces {
        ownership: path.join("owners"),
        control: path.join("control"),
    }
}
