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

// Real Roots initialize control and eight runtime partitions before behavior checks.
pub async fn setup<T>(future: impl std::future::Future<Output = T>) -> T {
    let started = std::time::Instant::now();
    tokio::time::timeout(std::time::Duration::from_secs(60), future)
        .await
        .unwrap_or_else(|_| {
            panic!(
                "fixture initialization timed out after {:?}",
                started.elapsed()
            )
        })
}

use maka_packages::Package;
use maka_plugin_core::{
    composition::{Input, InstanceId, Target},
    contract::{
        Availability, Cardinality, Contract, Export, Import, Interface, Method, MethodMode,
        Transport,
    },
    deployment::RemoteObservation,
    operation::receipt_reader_contract,
    package::{Declaration, EntryDeclaration, Implementation, Realm},
    plan::RemoteCapability,
};
use serde_json::json;
use std::collections::BTreeMap;
use uuid::Uuid;
pub mod counter {
    use super::*;

    pub fn package(name: &str, declaration: Declaration, source: Option<String>) -> Package {
        let mut files = BTreeMap::from([(
            maka_packages::MANIFEST_FILE.into(),
            serde_json::to_vec(&json!({"schemaVersion":1,"id":name,"application":declaration}))
                .unwrap(),
        )]);
        if let Some(source) = source {
            files.insert("index.mjs".into(), source.into_bytes());
        }
        Package::new(files).unwrap()
    }

    pub fn node(package: &Package, key: u128) -> maka_plugin_core::composition::Node {
        maka_plugin_core::composition::Node {
            key: Uuid::from_u128(key),
            package: package.application_ref().into(),
            use_package: maka_plugin_core::composition::PackageUse::Host,
            configuration: Default::default(),
            parameters: Default::default(),
            bindings: Default::default(),
            disabled: false,
            overrides: vec![],
        }
    }
}

pub fn identity(key: u128) -> InstanceId {
    InstanceId(vec![Uuid::from_u128(key)])
}
pub fn business() -> Contract {
    Contract {
        name: "example.LocalCounter".into(),
        version: 1,
        transport: Transport::Remote,
        interface: Interface::Service {
            methods: BTreeMap::from([
                (
                    "read".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Query,
                        input: json!({}).into(),
                        output: json!({}).into(),
                        resources: BTreeMap::new(),
                    },
                ),
                (
                    "write".into(),
                    Method {
                        progress: Some(
                            json!({"type":"object","properties":{"step":{"type":"integer"}},"required":["step"],"additionalProperties":false}).into(),
                        ),
                        mode: MethodMode::Mutation,
                        input: json!({}).into(),
                        output: json!({}).into(),
                        resources: BTreeMap::new(),
                    },
                ),
            ]),
        },
    }
}
fn import(contract: Contract) -> Import {
    Import {
        contract,
        cardinality: Cardinality::One,
    }
}
fn export(contract: Contract) -> Export {
    Export {
        contract,
        availability: Availability::Required,
    }
}
fn host_package(name: &str, entry: EntryDeclaration, source: Option<String>) -> Package {
    counter::package(
        name,
        Declaration {
            host: Some(entry),
            ui: None,
            composition: None,
        },
        source,
    )
}
pub fn host() -> (Input, Vec<Package>) {
    let service = host_package(
        "local.business",
        EntryDeclaration {
            implementation: Implementation::JavaScript {
                module: "index.mjs".into(),
                realm: Realm::Dedicated,
            },
            configuration: json!({"type":"object","additionalProperties":false}).into(),
            imports: BTreeMap::new(),
            exports: BTreeMap::from([("Counter".into(), export(business()))]),
        },
        Some(format!(
            r#"let effects=0; export function activate(){{ return {{Counter:{{contract:{},service:['service']}}}}; }} export const service={{ read(){{return {{effects}};}},write(){{return {{effects:++effects}};}} }};"#,
            serde_json::to_string(&business()).unwrap()
        )),
    );
    let reader = host_package(
        "local.receipts",
        EntryDeclaration {
            implementation: Implementation::Native {
                implementation: maka_host_runtime::application::operations::RECEIPT_READER.into(),
            },
            configuration: json!({"type":"object","additionalProperties":false}).into(),
            imports: BTreeMap::new(),
            exports: BTreeMap::from([("Receipts".into(), export(receipt_reader_contract()))]),
        },
        None,
    );
    let gateway = host_package(
        "local.gateway",
        EntryDeclaration {
            implementation: Implementation::Native {
                implementation: maka_transport::GATEWAY.into(),
            },
            configuration: json!({"type":"object","additionalProperties":false}).into(),
            imports: BTreeMap::from([
                ("business".into(), import(business())),
                ("receipts".into(), import(receipt_reader_contract())),
            ]),
            exports: BTreeMap::new(),
        },
        None,
    );
    let mut gateway_node = counter::node(&gateway, 13);
    gateway_node.bindings = BTreeMap::from([
        (
            "business".into(),
            vec![Target::Instance {
                path: vec!["business".into()],
                export: "Counter".into(),
            }],
        ),
        (
            "receipts".into(),
            vec![Target::Instance {
                path: vec!["reader".into()],
                export: "Receipts".into(),
            }],
        ),
    ]);
    (
        Input {
            ui: None,
            instances: BTreeMap::from([
                ("business".into(), counter::node(&service, 11)),
                ("reader".into(), counter::node(&reader, 12)),
                ("gateway".into(), gateway_node),
            ]),
        },
        vec![service, reader, gateway],
    )
}
pub fn caller() -> (Input, Vec<Package>, Vec<RemoteObservation>) {
    let package = host_package(
        "local.caller",
        EntryDeclaration {
            implementation: Implementation::Native {
                implementation: maka_transport::GATEWAY.into(),
            },
            configuration: json!({"type":"object","additionalProperties":false}).into(),
            imports: BTreeMap::from([
                ("business".into(), import(business())),
                ("receipts".into(), import(receipt_reader_contract())),
            ]),
            exports: BTreeMap::new(),
        },
        None,
    );
    let mut consumer = counter::node(&package, 2);
    let observations = [
        ("business", 11, "Counter", business()),
        ("receipts", 12, "Receipts", receipt_reader_contract()),
    ]
    .map(|(name, key, export_name, contract)| {
        let capability = RemoteCapability {
            deployment: "local".into(),
            instance: identity(key),
            export: export_name.into(),
        };
        consumer.bindings.insert(
            name.into(),
            vec![Target::Remote {
                deployment: capability.deployment.clone(),
                instance: capability.instance.clone(),
                export: capability.export.clone(),
            }],
        );
        RemoteObservation {
            capability,
            declaration: export(contract),
        }
    })
    .to_vec();
    (
        Input {
            ui: None,
            instances: BTreeMap::from([("app".into(), consumer)]),
        },
        vec![package],
        observations,
    )
}

pub fn native_host(implementation: &str) -> (Input, Vec<Package>) {
    let (mut input, mut packages) = host();
    let original = packages.remove(0);
    let mut declaration = original
        .manifest()
        .application
        .as_ref()
        .unwrap()
        .declaration()
        .clone();
    declaration.host.as_mut().unwrap().implementation = Implementation::Native {
        implementation: implementation.into(),
    };
    let package = counter::package("local.business", declaration, None);
    input.instances.get_mut("business").unwrap().package = package.application_ref().into();
    packages.push(package);
    (input, packages)
}
