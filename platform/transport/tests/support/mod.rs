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
    composition::{Environment, ExecutionLocation, Input, InstanceId, PresentationTarget, Target},
    contract::{
        Availability, Cardinality, Contract, Export, Import, Interface, Method, MethodMode,
        Transport,
    },
    deployment::RemoteObservation,
    operation::receipt_reader_contract,
    package::{Declaration, EntryDeclaration, EntryTarget, Implementation, Realm},
    plan::RemoteCapability,
};
use serde_json::json;
use std::collections::BTreeMap;
use uuid::Uuid;
#[allow(dead_code)]
#[path = "../../../ui-js/examples/counter/support.rs"]
pub mod counter;

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
            entries: BTreeMap::from([(EntryTarget::Host, entry)]),
            composition: None,
        },
        source,
    )
}
pub fn host_with_startup_failure() -> (Input, Vec<Package>) {
    let (mut input, mut packages) = host();
    let declaration = packages
        .iter()
        .find(|p| p.manifest().id == "local.business")
        .unwrap()
        .manifest()
        .application
        .as_ref()
        .unwrap()
        .declaration()
        .clone();
    let failing = counter::package(
        "local.failing",
        declaration,
        Some(
            "export function activate() { throw Error('unrelated initializer rejected'); }".into(),
        ),
    );
    input
        .instances
        .insert("failing".into(), counter::node(&failing, 99));
    packages.push(failing);
    (input, packages)
}
pub fn host_with_unavailable_business() -> (Input, Vec<Package>) {
    let (mut input, mut packages) = host();
    let old = packages
        .iter_mut()
        .find(|p| p.manifest().id == "local.business")
        .unwrap();
    *old = counter::package(
        "local.business",
        old.manifest()
            .application
            .as_ref()
            .unwrap()
            .declaration()
            .clone(),
        Some("export function activate() { throw Error('business initializer rejected'); }".into()),
    );
    input.instances.get_mut("business").unwrap().package = old.application_ref().into();
    let recovery = host_package(
        "local.recovery",
        EntryDeclaration {
            scene: None,
            implementation: Implementation::Native {
                implementation: maka_transport::GATEWAY.into(),
            },
            configuration: json!({"type":"object","additionalProperties":false}).into(),
            imports: BTreeMap::from([("receipts".into(), import(receipt_reader_contract()))]),
            exports: BTreeMap::new(),
        },
        None,
    );
    let mut node = counter::node(&recovery, 14);
    node.bindings.insert(
        "receipts".into(),
        vec![Target::Instance {
            path: vec!["reader".into()],
            export: "Receipts".into(),
        }],
    );
    input.instances.insert("recovery".into(), node);
    packages.push(recovery);
    (input, packages)
}
pub fn host() -> (Input, Vec<Package>) {
    let service = host_package(
        "local.business",
        EntryDeclaration {
            scene: None,
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
            scene: None,
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
            scene: None,
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
            environment: Environment {
                location: ExecutionLocation::Host,
                presentation: None,
            },
            instances: BTreeMap::from([
                ("business".into(), counter::node(&service, 11)),
                ("reader".into(), counter::node(&reader, 12)),
                ("gateway".into(), gateway_node),
            ]),
            recovery: None,
            launch: None,
        },
        vec![service, reader, gateway],
    )
}
pub fn ui(target: PresentationTarget) -> (Input, Vec<Package>, Vec<RemoteObservation>) {
    let (mut input, mut packages) = counter::fixture("");
    input.environment.presentation = Some(target);
    let original = packages.pop().unwrap();
    let mut declaration = original
        .manifest()
        .application
        .as_ref()
        .unwrap()
        .declaration()
        .clone();
    for entry in declaration.entries.values_mut() {
        entry.imports.insert("business".into(), import(business()));
        entry
            .imports
            .insert("receipts".into(), import(receipt_reader_contract()));
    }
    let mut files = BTreeMap::from([(
        maka_packages::MANIFEST_FILE.into(),
        serde_json::to_vec(&json!({"schemaVersion":1,"id":"local.ui","application":declaration}))
            .unwrap(),
    )]);
    let contract = &declaration.entries[&EntryTarget::Tui].exports["App"].contract;
    let surface = "{kind:'terminal',binding:'surface'}";
    files.insert("index.mjs".into(),format!(r#"
            const contract={}; export function activate(){{return {{App:{{contract,kind:'component',component:['app']}}}};}}
            function frame(state,actions=[]){{return {{actions,events:[],frame:{{revision:state.revision,state,surface:{surface},view:{{kind:'stack',key:'root',direction:'column',padding:1,gap:1,background:1513239,children:[{{kind:'text',key:'value',text:state.outcome?.value?.receipt?'Original receipt '+state.outcome.value.receipt.kind:JSON.stringify(state.outcome?.reply?.receipt??state.outcome??'Ready'),color:16777215}},{{kind:'button',key:'read',label:'Read Host'}},{{kind:'button',key:'write',label:'Write Host'}},{{kind:'button',key:'recover',label:'Read original receipt'}},{{kind:'button',key:'cancel',label:'Cancel operation'}}]}}}}}};}}
            export const app={{mount(){{return frame({{revision:0,outcome:null,reference:null}});}},event(state,input){{
                if(input.kind==='raw' && input.key==='cancel'){{const out=frame({{...state,revision:state.revision+1}});out.cancel=['result'];return out;}}
                if(input.kind==='action'){{ const outcome=input.event;return frame({{...state,revision:state.revision+1,outcome,reference:outcome.status==='operation'?outcome.reply.reference:state.reference}}); }}
                const key=input.key;const recovery=key==='recover';
                return frame({{...state,revision:state.revision+1,outcome:null}},[{{key:'result',binding:recovery?'receipts':'business',member:0,method:recovery?'read':key,input:recovery?state.reference:null,resources:{{}}}}]);
            }},update(state){{return frame(state);}}}};
        "#,serde_json::to_string(contract).unwrap()).into_bytes());
    let package = Package::new(files).unwrap();
    let app = input.instances.get_mut("app").unwrap();
    app.package = package.application_ref().into();
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
        app.bindings.insert(
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
    packages.push(package);
    (input, packages, observations)
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
    declaration
        .entries
        .get_mut(&EntryTarget::Host)
        .unwrap()
        .implementation = Implementation::Native {
        implementation: implementation.into(),
    };
    let package = counter::package("local.business", declaration, None);
    input.instances.get_mut("business").unwrap().package = package.application_ref().into();
    packages.push(package);
    (input, packages)
}
