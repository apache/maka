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

use super::super::Result;
use super::super::transport::{Catalogue, HostEndpoint, NativeGrant};
use maka_plugin_core::{composition::InstanceId, deployment::DeploymentRef};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

/// Persisted trusted-local Host publication and native invocation authority.
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Configuration {
    PublicHost {
        endpoints: BTreeMap<String, HostEndpoint>,
        native: Vec<NativeGrant>,
        /// Endpoint names whose method sets follow the product's service contracts.
        /// An absent/empty set leaves every endpoint explicitly caller-owned.
        #[serde(
            default,
            rename = "productMethods",
            skip_serializing_if = "BTreeSet::is_empty"
        )]
        product_methods: BTreeSet<String>,
    },
}
impl Configuration {
    pub fn validate(&self) -> Result<()> {
        let Self::PublicHost {
            endpoints,
            native,
            product_methods,
        } = self;
        if endpoints.is_empty() || endpoints.keys().any(|name| name.is_empty()) {
            return Err("invalid public Host endpoint configuration".into());
        }
        if product_methods
            .iter()
            .any(|name| !endpoints.contains_key(name))
        {
            return Err("product-managed Host endpoint is missing".into());
        }
        for endpoint in endpoints.values() {
            endpoint.validate()?;
        }
        for grant in native {
            grant.validate()?;
        }
        Ok(())
    }

    /// Product-owned snapshots must resolve the full current service contract.
    /// Explicit restrictions or rebinding must declare caller ownership.
    pub(super) fn validate_product_methods(
        &self,
        previous: &Self,
        catalogue: &Catalogue,
    ) -> Result<()> {
        use maka_plugin_core::contract::Interface;

        let Self::PublicHost {
            endpoints,
            product_methods,
            ..
        } = self;
        let Self::PublicHost {
            endpoints: previous,
            product_methods: previous_owned,
            ..
        } = previous;
        for name in product_methods {
            let after = endpoints
                .get(name)
                .ok_or("product-managed Host endpoint is missing")?;
            if previous_owned.contains(name)
                && previous.get(name).is_some_and(|before| {
                    before.consumer != after.consumer || before.import != after.import
                })
            {
                return Err("product-managed Host endpoint binding changed; clear its product method ownership before rebinding".into());
            }
            let binding = catalogue.describe(name)?;
            let Interface::Service { methods } = &binding.contract.interface else {
                return Err("product-managed Host endpoint requires a service".into());
            };
            // Ownership follows the current contract, not differences from an
            // older resolved snapshot: product contracts may remove methods too.
            if !after.grant.methods.iter().eq(methods.keys()) {
                return Err("product-managed Host endpoint methods differ from the current service contract; clear its product method ownership for an explicit grant".into());
            }
        }
        Ok(())
    }
}

pub const VERSION: u32 = 1;

/// Current live authority and the committed source witness for its next CAS.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Publication {
    /// The current committed head, not a claim that this incarnation adopted it.
    pub source: DeploymentRef,
    pub configuration: Configuration,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Opening {
    pub version: u32,
    pub epoch: Option<Uuid>,
    #[serde(default)]
    pub client_instance: Option<String>,
    pub request: Request,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Connect,
    ConnectUi {
        owner: Uuid,
        source: DeploymentRef,
        instance: InstanceId,
    },
    /// Trusted current-account launcher approval; remote principals cannot use it.
    ConnectPeer {
        source: DeploymentRef,
        consumers: BTreeSet<InstanceId>,
        endpoints: BTreeMap<String, HostEndpoint>,
    },
    Call {
        session: Uuid,
    },
    Status,
    /// Trusted current-account owner only; remote and external UI peers cannot read it.
    Publication,
    Quit {
        session: Uuid,
    },
    /// Current-account owner only. Source/packages remain a separate CAS operation.
    Configure {
        source: DeploymentRef,
        previous: Configuration,
        configuration: Configuration,
    },
    Retire {
        #[serde(default)]
        interrupt: bool,
        #[serde(default)]
        allow_idle_connections: bool,
    },
    PrepareAccess {
        principal: String,
    },
    RevokeAccess {
        credential: String,
    },
    FinalizeAccess,
}
#[derive(Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Response {
    Connected(Connected),
    Accepted,
    Epochs(Result<BTreeMap<String, Option<Uuid>>>),
    Captured(Result<Catalogue>),
    Refreshed(Result<Catalogue>),
    Approved {
        source: DeploymentRef,
        result: Result<()>,
    },
    Status(Status),
    Publication(Result<Publication>),
    Configured(Result<()>),
    Retired(Result<bool>),
    Closed,
    Pairing(Result<super::Pairing>),
    Revoked(Result<bool>),
    Finalized(Result<()>),
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SessionControl {
    Close,
    Epochs,
    Capture,
    Refresh,
    Approve {
        source: DeploymentRef,
        consumers: BTreeSet<InstanceId>,
        retain: BTreeSet<u64>,
        captured: Option<Catalogue>,
    },
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Connected {
    pub version: u32,
    pub epoch: Uuid,
    pub session: Uuid,
    pub source: DeploymentRef,
    pub consumers: BTreeMap<String, InstanceId>,
    pub catalogue: Catalogue,
    pub ui: Option<UiConnection>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiConnection {
    pub instance: InstanceId,
    pub imports: BTreeMap<String, Vec<String>>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Status {
    pub root_id: String,
    pub version: u32,
    pub pid: std::num::NonZeroU32,
    pub generation: Option<String>,
    pub lifecycle_mode: LifecycleMode,
    pub epoch: Uuid,
    pub source: DeploymentRef,
    pub closing: bool,
    pub closed: bool,
    pub cleanup_error: Option<String>,
    pub sessions: usize,
    /// Observation only; idle retirement also fences native background producers.
    pub active_calls: usize,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleMode {
    Service,
    Ephemeral,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn configuration() -> Configuration {
        serde_json::from_value(json!({
            "kind": "public_host",
            "endpoints": {
                "business": {
                    "consumer": [Uuid::from_u128(1)],
                    "import": "business",
                    "grant": { "methods": ["read", "write"], "recovery": true }
                },
                "other": {
                    "consumer": [Uuid::from_u128(2)],
                    "import": "other",
                    "grant": { "methods": ["read"], "recovery": false }
                }
            },
            "native": [],
            "productMethods": ["business", "other"]
        }))
        .unwrap()
    }

    fn catalogue(methods: &[&str]) -> Catalogue {
        use maka_plugin_core::contract::Interface;

        let mut contract = maka_plugin_core::operation::receipt_reader_contract();
        let Interface::Service { methods: declared } = &mut contract.interface else {
            unreachable!()
        };
        let read = declared["read"].clone();
        *declared = methods
            .iter()
            .map(|name| ((*name).into(), read.clone()))
            .collect();
        serde_json::from_value(json!({
            "endpoints": {
                "business": {
                    "provider": [Uuid::from_u128(3)],
                    "export": "Business",
                    "contract": contract,
                    "registration_epoch": null
                },
                "other": {
                    "provider": [Uuid::from_u128(4)],
                    "export": "Other",
                    "contract": maka_plugin_core::operation::receipt_reader_contract(),
                    "registration_epoch": null
                }
            }
        }))
        .unwrap()
    }

    #[test]
    fn product_method_ownership_is_optional_and_names_existing_endpoints() {
        let mut value = serde_json::to_value(configuration()).unwrap();
        value.as_object_mut().unwrap().remove("productMethods");
        let custom: Configuration = serde_json::from_value(value.clone()).unwrap();
        custom.validate().unwrap();
        assert_eq!(serde_json::to_value(custom).unwrap(), value);
        value["productMethods"] = json!([]);
        let empty: Configuration = serde_json::from_value(value.clone()).unwrap();
        empty.validate().unwrap();
        value["productMethods"] = json!(["missing"]);
        let missing: Configuration = serde_json::from_value(value).unwrap();
        assert!(missing.validate().is_err());
    }

    #[test]
    fn owned_snapshots_require_current_contracts_or_an_explicit_ownership_transfer() {
        let previous = configuration();
        let original = serde_json::to_value(&previous).unwrap();
        for (field, value) in [
            ("methods", json!(["read"])),
            ("methods", json!(["read", "replacement"])),
            ("consumer", json!([Uuid::from_u128(3)])),
            ("import", json!("custom")),
        ] {
            let mut expected = original.clone();
            let endpoint = &mut expected["endpoints"]["business"];
            if field == "methods" {
                endpoint["grant"][field] = value;
            } else {
                endpoint[field] = value;
            }
            let desired: Configuration = serde_json::from_value(expected.clone()).unwrap();
            assert!(
                desired
                    .validate_product_methods(&previous, &catalogue(&["read", "write"]))
                    .is_err()
            );
            assert_eq!(serde_json::to_value(desired).unwrap(), expected);
            expected["productMethods"] = json!(["other"]);
            let custom: Configuration = serde_json::from_value(expected.clone()).unwrap();
            custom
                .validate_product_methods(&previous, &catalogue(&["read", "write"]))
                .unwrap();
            assert_eq!(serde_json::to_value(custom).unwrap(), expected);
        }
        for methods in [
            vec!["read"],
            vec!["read", "write"],
            vec!["new", "read", "write"],
        ] {
            let mut expected = original.clone();
            expected["endpoints"]["business"]["grant"]["methods"] = json!(methods);
            let desired: Configuration = serde_json::from_value(expected.clone()).unwrap();
            desired
                .validate_product_methods(&previous, &catalogue(&methods))
                .unwrap();
            assert_eq!(serde_json::to_value(desired).unwrap(), expected);
        }
    }
}
