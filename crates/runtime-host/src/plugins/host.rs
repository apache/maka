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

use crate::execution::Executions;
use futures_util::future::BoxFuture;
use maka_plugins::{
    composition::Scope,
    execution::{Access, CommandError, Commands},
    fiber::Context,
    host::{Provider, Services},
};
use std::sync::{Arc, Weak};

pub(crate) struct Issuer {
    inputs: maka_plugins::filesystem::ReadRoots,
    executions: Weak<Executions>,
    configuration: Arc<maka_config::ConfigurationStore>,
    pricing: Arc<crate::server::pricing::Catalog>,
    root: String,
    data: maka_plugins::storage::Directories,
}
impl Issuer {
    pub(crate) fn new(
        executions: &Arc<Executions>,
        configuration: Arc<maka_config::ConfigurationStore>,
        root: String,
        inputs: maka_plugins::filesystem::ReadRoots,
        pricing: Arc<crate::server::pricing::Catalog>,
        data: maka_plugins::storage::Directories,
    ) -> Arc<Self> {
        Arc::new(Self {
            inputs,
            executions: Arc::downgrade(executions),
            configuration,
            pricing,
            root,
            data,
        })
    }
}
impl Provider for Issuer {
    fn bind(&self, owner: Context) -> BoxFuture<'_, Result<Option<Services>, String>> {
        Box::pin(async move {
            let host = self.executions.upgrade().ok_or("Host closed")?;
            if owner.identity().map_err(error)?.scope == Scope::DesktopUi {
                return Ok(None);
            }
            let private_data = self
                .data
                .bind(owner.clone())
                .map_err(error)?
                .read_only()
                .await
                .map_err(error)?
                .location();
            let executions = Arc::new(ExecutionAccess {
                host: self.executions.clone(),
                owner: owner.clone(),
                root: self.root.clone(),
            });
            let storage = host.plugin_store(owner.clone()).map_err(error)?;
            let effects = Arc::new(super::effects::Effects::new(
                self.executions.clone(),
                owner.clone(),
            ));
            Ok(Some(Services {
                inputs: self.inputs.bind(owner.clone()),
                preferences: Arc::new(Preferences {
                    configuration: self.configuration.clone(),
                    owner: owner.clone(),
                }),
                storage: storage.clone(),
                credentials: storage,
                executions: executions.clone(),
                authorizations: executions,
                permissions: effects.clone(),
                files: effects.clone(),
                models: effects.clone(),
                executors: effects.clone(),
                clients: effects.clone(),
                sessions: effects.clone(),
                history: effects.clone(),
                usage: effects.clone(),
                pricing: Arc::new(super::pricing::Prices::new(
                    self.pricing.clone(),
                    effects.clone(),
                )),
                http: Arc::new(super::http::Http::new(
                    self.executions.clone(),
                    owner.clone(),
                    effects,
                )),
                processes: Arc::new(super::process::Processes::new(
                    self.executions.clone(),
                    owner.clone(),
                    private_data.clone(),
                )),
                terminals: Arc::new(super::terminal::Terminals::new(
                    self.executions.clone(),
                    owner,
                    private_data,
                )),
            }))
        })
    }
}
struct ExecutionAccess {
    host: Weak<Executions>,
    owner: Context,
    root: String,
}
struct Preferences {
    configuration: Arc<maka_config::ConfigurationStore>,
    owner: Context,
}
impl maka_plugins::preferences::Preferences for Preferences {
    fn read(
        &self,
    ) -> BoxFuture<'_, Result<maka_plugins::preferences::Snapshot, maka_plugins::Error>> {
        Box::pin(async move {
            let _lease = self.owner.resource_call()?;
            let snapshot = self
                .configuration
                .runtime_policy()
                .await
                .map_err(|error| maka_plugins::Error::Invalid(error.to_string()))?;
            Ok(maka_plugins::preferences::Snapshot {
                revision: snapshot.revision,
                privacy: snapshot.policy.privacy,
                personalization: snapshot.policy.personalization,
                workspace_instructions: snapshot.policy.workspace_instructions.enabled,
            })
        })
    }
}
impl maka_plugins::authorization::Access for ExecutionAccess {
    fn open(
        &self,
        id: maka_plugins::authorization::Id,
    ) -> BoxFuture<'_, Result<maka_plugins::authorization::Authorized, CommandError>> {
        Box::pin(async move {
            self.host
                .upgrade()
                .ok_or(CommandError::Draining)?
                .open_plugin_consent(self.owner.clone(), id)
                .await
        })
    }
}
impl Access for ExecutionAccess {
    fn restore(
        &self,
        id: maka_plugins::authorization::Id,
    ) -> BoxFuture<'_, Result<Arc<dyn Commands>, CommandError>> {
        Box::pin(async move {
            let _lease = self.owner.admit().map_err(|_| CommandError::Revoked)?;
            let host = self.host.upgrade().ok_or(CommandError::Draining)?;
            host.restore_plugin_consent(self.owner.clone(), id, &self.root)
                .await
        })
    }
    fn acquire(
        &self,
        call: maka_plugins::call::Scope,
    ) -> BoxFuture<'_, Result<Arc<dyn Commands>, CommandError>> {
        Box::pin(async move {
            let host = self.host.upgrade().ok_or(CommandError::Draining)?;
            host.acquire_plugin_execution(self.owner.clone(), call, &self.root)
                .await
        })
    }
}
fn error(error: impl ToString) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_event_log::root::{RootNamespaces, RootOwner};
    use maka_plugins::{fiber::Fiber, preferences::Preferences as _};
    use maka_runtime::configuration::policy::{Personalization, RuntimePolicyMutationResult};
    use std::time::Duration;

    #[tokio::test]
    async fn preference_snapshots_are_readable_during_activation_and_retire_with_the_owner() {
        let temp = tempfile::tempdir().unwrap();
        let root = Arc::new(
            RootOwner::create(
                &temp.path().join("root"),
                &RootNamespaces {
                    ownership: temp.path().join("owners"),
                    control: temp.path().join("control"),
                },
            )
            .unwrap(),
        );
        let configuration = Arc::new(
            maka_config::ConfigurationStore::for_root(root)
                .await
                .unwrap(),
        );
        let fiber = Fiber::new("example.preferences", "reader", Scope::Profile).unwrap();
        fiber.begin_loading().unwrap();
        let preferences = Preferences {
            configuration: configuration.clone(),
            owner: fiber.context(),
        };
        let initial = preferences.read().await.unwrap();
        fiber.ready().unwrap();
        fiber.publish().unwrap();
        assert!(matches!(
            configuration
                .set_personalization(
                    initial.revision,
                    Personalization {
                        display_name: "Reader".into(),
                        assistant_tone: "Concise".into(),
                    }
                )
                .await
                .unwrap(),
            RuntimePolicyMutationResult::Committed { .. }
        ));
        let current = preferences.read().await.unwrap();
        assert_eq!(current.personalization.display_name, "Reader");
        assert_eq!(current.revision, initial.revision + 1);
        assert!(initial.personalization.display_name.is_empty());
        fiber
            .shutdown(tokio::time::Instant::now() + Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(preferences.read().await, Err(maka_plugins::Error::Retired));
        drop(preferences);
        Arc::try_unwrap(configuration)
            .ok()
            .unwrap()
            .close()
            .await
            .unwrap();
    }
}
