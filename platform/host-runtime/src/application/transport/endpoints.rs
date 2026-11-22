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

//! One captured endpoint set; declarations never become executable bindings.
use super::Grant;
use super::{Description, Endpoint};
use crate::application::Result;
use crate::application::{CapturedImport, Client};
use maka_plugin_core::composition::InstanceId;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
#[cfg(test)]
use uuid::Uuid;

/// One trusted exposure through an explicit Host consumer and declared import.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostEndpoint {
    pub consumer: InstanceId,
    pub import: String,
    pub grant: Grant,
}
impl HostEndpoint {
    pub fn validate(&self) -> Result<()> {
        if self.consumer.validate().is_err()
            || self.import.is_empty()
            || self.grant.methods.is_empty()
            || self.grant.methods.iter().any(|method| method.is_empty())
        {
            return Err("invalid Host endpoint selection or grant".into());
        }
        Ok(())
    }
}
#[derive(Clone)]
pub struct Endpoints {
    entries: BTreeMap<String, Entry>,
    pub(super) startup_error: Option<String>,
}
#[derive(Clone)]
enum Entry {
    Ready(Endpoint),
    Unavailable(Description),
}
impl From<BTreeMap<String, Endpoint>> for Endpoints {
    fn from(endpoints: BTreeMap<String, Endpoint>) -> Self {
        Self {
            entries: endpoints
                .into_iter()
                .map(|(name, endpoint)| (name, Entry::Ready(endpoint)))
                .collect(),
            startup_error: None,
        }
    }
}
impl Endpoints {
    pub async fn start(
        client: &Client,
        selections: &BTreeMap<String, HostEndpoint>,
    ) -> Result<Endpoints> {
        // Reject malformed selectors and grants before waiting for initialization.
        // These observations own no jobs; all initializers belong to Application.
        drop(Self::capture(client, selections).await?);
        for consumer in selections
            .values()
            .map(|endpoint| &endpoint.consumer)
            .collect::<BTreeSet<_>>()
        {
            // A failed consumer can yield only a declaration in the final capture.
            // Closing or invalid configuration still fails that exact owner request.
            let _ = client.ready_instance(consumer).await;
        }
        Self::capture(client, selections).await
    }
    pub async fn capture(
        client: &Client,
        selections: &BTreeMap<String, HostEndpoint>,
    ) -> Result<Endpoints> {
        if selections.is_empty() {
            return Err("invalid Host endpoint selections".into());
        }
        let mut endpoints = Endpoints::empty();
        for (name, selection) in selections {
            selection.validate()?;
            let captured = client
                .capture_import(selection.consumer.clone(), selection.import.clone())
                .await?;
            endpoints.insert(name.clone(), captured, selection.grant.clone())?;
        }
        endpoints.startup_error = client.snapshot().startup_error;
        endpoints.validate()?;
        Ok(endpoints)
    }

    fn empty() -> Self {
        Self {
            entries: BTreeMap::new(),
            startup_error: None,
        }
    }
    fn insert(&mut self, name: String, import: CapturedImport, grant: Grant) -> Result<()> {
        let entry = match import {
            CapturedImport::Ready(binding) => Entry::Ready(Endpoint::new(binding, grant)?),
            CapturedImport::Unavailable {
                provider,
                export,
                contract,
            } => {
                super::policy::check_grant(&contract, &grant)?;
                Entry::Unavailable(Description {
                    provider,
                    export,
                    contract,
                    registration_epoch: None,
                })
            }
        };
        if self.entries.insert(name, entry).is_some() {
            return Err("duplicate Application endpoint".into());
        }
        Ok(())
    }
    pub(super) fn validate(&self) -> Result<()> {
        if self.entries.keys().any(|name| name.is_empty()) {
            return Err("invalid Application endpoints".into());
        }
        Ok(())
    }
    pub(super) fn get(&self, name: &str) -> Option<&Endpoint> {
        match self.entries.get(name)? {
            Entry::Ready(endpoint) => Some(endpoint),
            Entry::Unavailable(_) => None,
        }
    }
    pub fn epochs(&self) -> BTreeMap<String, Option<uuid::Uuid>> {
        self.entries
            .iter()
            .map(|(name, entry)| {
                (
                    name.clone(),
                    match entry {
                        Entry::Ready(endpoint) => Some(endpoint.binding.registration_epoch()),
                        Entry::Unavailable(_) => None,
                    },
                )
            })
            .collect()
    }
    pub(super) fn descriptions(&self) -> BTreeMap<String, Description> {
        self.entries
            .iter()
            .map(|(name, entry)| {
                (
                    name.clone(),
                    match entry {
                        Entry::Ready(endpoint) => Description {
                            provider: endpoint.binding.provider().instance().clone(),
                            export: endpoint.binding.export().into(),
                            contract: endpoint.binding.contract().clone(),
                            registration_epoch: Some(endpoint.binding.registration_epoch()),
                        },
                        Entry::Unavailable(description) => description.clone(),
                    },
                )
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_method_grants_keep_all_known_methods_without_admitting_unknown_methods() {
        use super::super::{NativeGrant, policy::check_grant};
        use maka_plugin_core::contract::Interface;

        let mut contract = maka_plugin_core::operation::receipt_reader_contract();
        let Interface::Service { methods } = &mut contract.interface else {
            unreachable!()
        };
        let read = methods["read"].clone();
        *methods = (0..129)
            .map(|index| (format!("read{index:03}"), read.clone()))
            .collect();
        let selected: BTreeSet<_> = methods.keys().take(128).cloned().collect();
        let mut endpoint = HostEndpoint {
            consumer: InstanceId(vec![Uuid::new_v4()]),
            import: "reads".into(),
            grant: Grant {
                methods: selected.clone(),
                recovery: false,
            },
        };
        let mut native = NativeGrant {
            origin: endpoint.consumer.clone(),
            consumer: endpoint.consumer.clone(),
            provider: InstanceId(vec![Uuid::new_v4()]),
            export: "Reads".into(),
            methods: selected,
            recovery: false,
        };
        endpoint.validate().unwrap();
        native.validate().unwrap();
        check_grant(&contract, &endpoint.grant).unwrap();

        endpoint.grant.methods.remove("read000");
        endpoint.grant.methods.insert("unlisted".into());
        assert!(check_grant(&contract, &endpoint.grant).is_err());

        endpoint.grant.methods = (0..129).map(|index| format!("read{index:03}")).collect();
        native.methods = endpoint.grant.methods.clone();
        endpoint.validate().unwrap();
        native.validate().unwrap();
        check_grant(&contract, &endpoint.grant).unwrap();
    }

    #[test]
    fn unavailable_declarations_still_require_the_original_method_grant() {
        let captured = || CapturedImport::Unavailable {
            provider: maka_plugin_core::composition::InstanceId(vec![uuid::Uuid::new_v4()]),
            export: "Receipts".into(),
            contract: maka_plugin_core::operation::receipt_reader_contract(),
        };
        let mut endpoints = Endpoints::empty();
        assert!(
            endpoints
                .insert(
                    "receipts".into(),
                    captured(),
                    Grant {
                        methods: ["write".into()].into(),
                        recovery: true
                    }
                )
                .is_err()
        );
        endpoints
            .insert(
                "receipts".into(),
                captured(),
                Grant {
                    methods: ["read".into()].into(),
                    recovery: true,
                },
            )
            .unwrap();
        let catalogue = super::super::Catalogue::captured(&endpoints);
        assert!(
            catalogue
                .describe("receipts")
                .unwrap()
                .registration_epoch
                .is_none()
        );
        assert!(catalogue.select("receipts").is_err());
        assert!(endpoints.get("receipts").is_none());
        assert!(
            catalogue
                .check_names(["missing".to_owned()].iter())
                .is_err()
        );
    }
}
