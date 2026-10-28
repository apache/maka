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

use std::{cell::Cell, rc::Rc};

use serde_json::json;

use super::*;
use crate::{
    composition::{Configuration, Input, Node, PackageUse, Target, Template},
    contract::{Availability, Cardinality, Export, Import, Interface, Transport},
    package::{Declaration, EntryDeclaration, Implementation, PackageRef, Packages},
    plan::{RemoteCapability, RemoteExports},
};

fn contract() -> Contract {
    Contract {
        name: "example.Action".into(),
        version: 1,
        transport: Transport::Local,
        interface: Interface::Value {
            schema: json!({"type":"string"}).into(),
        },
    }
}

fn entry(provider: bool) -> EntryDeclaration {
    EntryDeclaration {
        implementation: Implementation::Native {
            implementation: "example.native".into(),
        },
        configuration: json!({"type":"object"}).into(),
        imports: if provider {
            BTreeMap::new()
        } else {
            BTreeMap::from([(
                "action".into(),
                Import {
                    contract: contract(),
                    cardinality: Cardinality::One,
                },
            )])
        },
        exports: if provider {
            BTreeMap::from([(
                "action".into(),
                Export {
                    contract: contract(),
                    availability: Availability::Required,
                },
            )])
        } else {
            BTreeMap::new()
        },
    }
}

fn reference(name: &str) -> PackageRef {
    PackageRef {
        id: name.into(),
        revision: format!("sha256-{:064x}", 1),
    }
}

fn target(name: &str) -> Target {
    Target::Instance {
        path: vec![name.into()],
        export: "action".into(),
    }
}

fn node(name: &str, key: u128, provider: bool) -> Node {
    Node {
        key: Uuid::from_u128(key),
        package: reference(name).into(),
        use_package: PackageUse::Host,
        configuration: Configuration::default(),
        parameters: Configuration::default(),
        bindings: if provider {
            BTreeMap::new()
        } else {
            BTreeMap::from([("action".into(), vec![target("p")])])
        },
        disabled: false,
        overrides: Vec::new(),
    }
}

struct Fixture {
    input: Input,
    packages: Packages,
}

impl Fixture {
    fn new() -> Self {
        let mut packages = Packages::default();
        for (name, provider) in [("provider", true), ("consumer", false)] {
            packages
                .insert(
                    reference(name),
                    Declaration {
                        host: Some(entry(provider)),
                        ui: None,
                        composition: None,
                    },
                )
                .unwrap();
        }
        Self {
            packages,
            input: Input {
                ui: None,
                instances: BTreeMap::from([
                    ("p".into(), node("provider", 1, true)),
                    ("a".into(), node("consumer", 2, false)),
                    ("b".into(), node("consumer", 3, false)),
                ]),
            },
        }
    }

    fn plan(&self) -> Plan {
        Plan::prepare(&self.input, &self.packages, &RemoteExports::new()).unwrap()
    }
    fn id(&self, name: &str) -> InstanceId {
        self.plan()
            .instances()
            .values()
            .find(|instance| instance.path.last().unwrap() == name)
            .unwrap()
            .identity
            .clone()
    }

    fn activate<T>(
        &self,
        runtime: &mut Runtime<T>,
        name: &str,
        batch: BTreeMap<String, Published<T>>,
    ) -> Activation {
        let activation = runtime.begin(&self.id(name)).unwrap();
        runtime.publish(&activation, batch).unwrap();
        activation
    }
}

fn published<T>(value: T) -> BTreeMap<String, Published<T>> {
    BTreeMap::from([(
        "action".into(),
        Published {
            contract: contract(),
            value,
        },
    )])
}

// Rc and Cell deliberately model foreground-only native objects.
struct Action {
    effects: Rc<Cell<usize>>,
    drops: Rc<Cell<usize>>,
}
impl Action {
    fn invoke(&self) {
        self.effects.set(self.effects.get() + 1);
    }
}
impl Drop for Action {
    fn drop(&mut self) {
        self.drops.set(self.drops.get() + 1);
    }
}

#[test]
fn actual_export_batch_is_atomic_and_rejected_values_return_to_creator() {
    let fixture = Fixture::new();
    let mut runtime = Runtime::new(fixture.plan());
    let provider = runtime.begin(&fixture.id("p")).unwrap();
    let consumer = runtime.begin(&fixture.id("a")).unwrap();
    let drops = Rc::new(Cell::new(0));
    let mut batch = published(Action {
        effects: Rc::new(Cell::new(0)),
        drops: drops.clone(),
    });
    batch.get_mut("action").unwrap().contract.version = 2;
    let rejected = runtime.publish(&provider, batch).unwrap_err();
    assert!(matches!(rejected.error, Error::Contract(_)));
    assert_eq!(drops.get(), 0);
    assert_eq!(runtime.status(&provider).unwrap().phase, Phase::Loading);
    assert!(matches!(
        runtime.bind(&consumer, "action"),
        Err(Error::NotReady(_))
    ));
    drop(rejected.batch);
    assert_eq!(drops.get(), 1);
    assert!(runtime.publish(&provider, BTreeMap::new()).is_err());
    runtime
        .publish(
            &provider,
            published(Action {
                effects: Rc::new(Cell::new(0)),
                drops,
            }),
        )
        .unwrap();
    assert_eq!(runtime.bind(&consumer, "action").unwrap().len(), 1);
}

#[test]
fn consumer_retirement_closes_queued_admission_but_keeps_accepted_native_work() {
    let fixture = Fixture::new();
    let mut runtime = Runtime::new(fixture.plan());
    let effects = Rc::new(Cell::new(0));
    let provider = fixture.activate(
        &mut runtime,
        "p",
        published(Action {
            effects: effects.clone(),
            drops: Rc::new(Cell::new(0)),
        }),
    );
    let a = fixture.activate(&mut runtime, "a", BTreeMap::new());
    let b = fixture.activate(&mut runtime, "b", BTreeMap::new());
    let from_a = runtime.bind(&a, "action").unwrap().pop().unwrap();
    let from_b = runtime.bind(&b, "action").unwrap().pop().unwrap();
    assert!(runtime.inspect(&from_a).is_ok());
    assert_eq!(runtime.status(&provider).unwrap().calls, 0);
    let accepted = runtime.admit(&from_a).unwrap();
    assert_eq!(runtime.retire(&a).unwrap(), vec![a.clone()]);
    assert!(matches!(runtime.inspect(&from_a), Err(Error::Retired)));
    assert!(matches!(runtime.admit(&from_a), Err(Error::Retired)));
    runtime.finish_cleanup(&a).unwrap();
    accepted.value().invoke();
    let other = runtime.admit(&from_b).unwrap();
    other.value().invoke();
    assert_eq!(effects.get(), 2);
    assert_eq!(runtime.status(&provider).unwrap().calls, 2);
    runtime.settle(&accepted, Ok(())).unwrap();
    runtime.settle(&other, Ok(())).unwrap();
    assert_eq!(runtime.status(&provider).unwrap().calls, 0);
}

#[test]
fn replacement_waits_for_resource_close_and_call_settlement_and_never_retargets_old_handles() {
    let fixture = Fixture::new();
    let mut runtime = Runtime::new(fixture.plan());
    let provider = fixture.activate(&mut runtime, "p", published("old"));
    let consumer = fixture.activate(&mut runtime, "a", BTreeMap::new());
    let capability = runtime.bind(&consumer, "action").unwrap().pop().unwrap();
    let execution = runtime.admit(&capability).unwrap();
    let resource = runtime.own_resource(&provider, "subscription").unwrap();
    let retired = runtime.retire(&provider).unwrap();
    assert!(retired.contains(&consumer));
    assert!(matches!(runtime.admit(&capability), Err(Error::Retired)));
    assert!(matches!(
        runtime.finish_cleanup(&provider),
        Err(Error::CleanupPending)
    ));
    assert!(runtime.begin(&fixture.id("p")).is_err());
    runtime.settle(&execution, Ok(())).unwrap();
    assert!(matches!(
        runtime.finish_cleanup(&provider),
        Err(Error::CleanupPending)
    ));
    runtime.complete_resource(&resource, Ok(())).unwrap();
    runtime.finish_cleanup(&provider).unwrap();
    runtime.finish_cleanup(&consumer).unwrap();
    let replacement = fixture.activate(&mut runtime, "p", published("new"));
    let replacement_consumer = fixture.activate(&mut runtime, "a", BTreeMap::new());
    let current = runtime
        .bind(&replacement_consumer, "action")
        .unwrap()
        .pop()
        .unwrap();
    assert_ne!(provider.epoch(), replacement.epoch());
    assert_ne!(
        capability.registration_epoch(),
        current.registration_epoch()
    );
    assert!(matches!(runtime.admit(&capability), Err(Error::Retired)));
    assert!(matches!(runtime.status(&provider), Err(Error::Retired)));
    let current_work = runtime.admit(&current).unwrap();
    assert_eq!(*current_work.value(), "new");
    runtime.settle(&current_work, Ok(())).unwrap();
}

#[test]
fn dropping_executor_token_does_not_pretend_settlement_or_release_owner() {
    let fixture = Fixture::new();
    let mut runtime = Runtime::new(fixture.plan());
    let drops = Rc::new(Cell::new(0));
    let provider = fixture.activate(
        &mut runtime,
        "p",
        published(Action {
            effects: Rc::new(Cell::new(0)),
            drops: drops.clone(),
        }),
    );
    let consumer = fixture.activate(&mut runtime, "a", BTreeMap::new());
    let capability = runtime.bind(&consumer, "action").unwrap().pop().unwrap();
    let execution = runtime.admit(&capability).unwrap();
    let _observer_id = execution.id();
    drop(execution);
    drop(capability);
    runtime.retire(&provider).unwrap();
    runtime.finish_cleanup(&consumer).unwrap();
    assert_eq!(runtime.status(&provider).unwrap().calls, 1);
    assert!(matches!(
        runtime.finish_cleanup(&provider),
        Err(Error::CleanupPending)
    ));
    assert_eq!(drops.get(), 0);
}

#[test]
fn failed_cleanup_fences_replacement_until_executor_confirms_recovery() {
    let fixture = Fixture::new();
    let mut runtime = Runtime::new(fixture.plan());
    let provider = fixture.activate(&mut runtime, "p", published(1));
    let consumer = fixture.activate(&mut runtime, "a", BTreeMap::new());
    let capability = runtime.bind(&consumer, "action").unwrap().pop().unwrap();
    let execution = runtime.admit(&capability).unwrap();
    let resource = runtime.own_resource(&provider, "database writer").unwrap();
    let stopped = runtime
        .settle(&execution, Err("unknown work outcome".into()))
        .unwrap();
    assert!(stopped.contains(&provider));
    assert!(stopped.contains(&consumer));
    runtime
        .complete_resource(&resource, Err("writer close failed".into()))
        .unwrap();
    assert_eq!(runtime.status(&consumer).unwrap().phase, Phase::Retiring);
    assert_eq!(runtime.status(&provider).unwrap().failures.len(), 2);
    assert!(matches!(
        runtime.finish_cleanup(&provider),
        Err(Error::CleanupFailed(_))
    ));
    assert!(runtime.begin(&fixture.id("p")).is_err());
    runtime.settle(&execution, Ok(())).unwrap();
    assert!(matches!(
        runtime.finish_cleanup(&provider),
        Err(Error::CleanupFailed(_))
    ));
    runtime.complete_resource(&resource, Ok(())).unwrap();
    runtime.finish_cleanup(&provider).unwrap();
    assert!(runtime.complete_resource(&resource, Ok(())).is_err());
    fixture.activate(&mut runtime, "p", published(2));
    assert!(runtime.settle(&execution, Ok(())).is_err());
}

#[test]
fn structural_owner_waits_for_children_without_requiring_native_exports() {
    let mut fixture = Fixture::new();
    fixture
        .packages
        .insert(
            reference("product"),
            Declaration {
                host: None,
                ui: None,
                composition: Some(Template {
                    parameters: BTreeMap::new(),
                    imports: BTreeMap::new(),
                    exports: BTreeMap::new(),
                    children: std::mem::take(&mut fixture.input.instances),
                }),
            },
        )
        .unwrap();
    let mut product = node("product", 100, true);
    product.use_package = PackageUse::Composition;
    fixture.input.instances.insert("product".into(), product);
    let mut runtime = Runtime::new(fixture.plan());
    assert!(matches!(
        runtime.begin(&fixture.id("p")),
        Err(Error::NotReady(_))
    ));
    let parent = fixture.activate(&mut runtime, "product", BTreeMap::new());
    let provider = fixture.activate(&mut runtime, "p", published(1));
    let consumer = fixture.activate(&mut runtime, "a", BTreeMap::new());
    assert_eq!(runtime.retire(&parent).unwrap().len(), 3);
    assert!(matches!(
        runtime.finish_cleanup(&parent),
        Err(Error::CleanupPending)
    ));
    runtime.finish_cleanup(&consumer).unwrap();
    runtime.finish_cleanup(&provider).unwrap();
    runtime.finish_cleanup(&parent).unwrap();
}

#[test]
fn structural_routing_does_not_turn_a_child_dependency_into_whole_product_retirement() {
    let mut fixture = Fixture::new();
    let mut child = node("consumer", 2, false);
    child.bindings.insert(
        "action".into(),
        vec![Target::Import {
            name: "action".into(),
        }],
    );
    fixture
        .packages
        .insert(
            reference("product"),
            Declaration {
                host: None,
                ui: None,
                composition: Some(Template {
                    parameters: BTreeMap::new(),
                    imports: BTreeMap::from([(
                        "action".into(),
                        Import {
                            contract: contract(),
                            cardinality: Cardinality::One,
                        },
                    )]),
                    exports: BTreeMap::new(),
                    children: BTreeMap::from([
                        ("a".into(), child),
                        ("b".into(), node("provider", 3, true)),
                    ]),
                }),
            },
        )
        .unwrap();
    let mut product = node("product", 100, false);
    product.use_package = PackageUse::Composition;
    fixture.input.instances.retain(|name, _| name == "p");
    fixture.input.instances.insert("product".into(), product);
    let mut runtime = Runtime::new(fixture.plan());
    let parent = fixture.activate(&mut runtime, "product", BTreeMap::new());
    let provider = fixture.activate(&mut runtime, "p", published(1));
    let consumer = fixture.activate(&mut runtime, "a", BTreeMap::new());
    let independent = fixture.activate(&mut runtime, "b", published(2));
    let stopped = runtime.retire(&provider).unwrap();
    assert_eq!(stopped.len(), 2);
    assert!(stopped.contains(&consumer));
    assert_eq!(runtime.status(&parent).unwrap().phase, Phase::Active);
    assert_eq!(runtime.status(&independent).unwrap().phase, Phase::Active);
}

#[test]
fn ui_root_switch_and_ui_only_upgrade_preserve_host_work_but_host_upgrade_retires_it() {
    use crate::composition::{Override, UiTarget};
    use crate::package::{UiContribution, UiEntry, UiText};

    let mut fixture = Fixture::new();
    let ui_v1 = reference("ui");
    let ui_v2 = PackageRef {
        revision: format!("sha256-{:064x}", 2),
        ..ui_v1.clone()
    };
    for (package, module) in [(&ui_v1, "first.js"), (&ui_v2, "second.js")] {
        fixture
            .packages
            .insert(
                package.clone(),
                Declaration {
                    host: None,
                    ui: Some(UiEntry {
                        module: module.into(),
                        configuration: json!({"type":"object"}).into(),
                        imports: BTreeMap::new(),
                        contributions: BTreeMap::from([
                            ("app".into(), UiContribution::Root),
                            (
                                "details".into(),
                                UiContribution::Panel {
                                    title: UiText {
                                        fallback: "Details".into(),
                                        translations: BTreeMap::new(),
                                    },
                                },
                            ),
                        ]),
                    }),
                    composition: None,
                },
            )
            .unwrap();
    }
    let host_children = std::mem::take(&mut fixture.input.instances);
    let product = |ui_package: &PackageRef| {
        let mut children = host_children.clone();
        let mut ui = node("ui", 200, true);
        ui.package = ui_package.clone().into();
        ui.use_package = PackageUse::Ui;
        children.insert("details".into(), ui);
        let mut steady = node("ui", 201, true);
        steady.use_package = PackageUse::Ui;
        children.insert("steady".into(), steady);
        Declaration {
            host: None,
            ui: None,
            composition: Some(Template {
                parameters: BTreeMap::new(),
                imports: BTreeMap::new(),
                exports: BTreeMap::new(),
                children,
            }),
        }
    };
    let product_v1 = reference("product");
    let product_v2 = PackageRef {
        revision: format!("sha256-{:064x}", 2),
        ..product_v1.clone()
    };
    fixture
        .packages
        .insert(product_v1.clone(), product(&ui_v1))
        .unwrap();
    fixture
        .packages
        .insert(product_v2.clone(), product(&ui_v2))
        .unwrap();
    let mut root = node("product", 100, true);
    root.use_package = PackageUse::Composition;
    fixture.input.instances.insert("product".into(), root);
    fixture.input.ui = Some(UiTarget {
        path: vec!["product".into(), "details".into()],
        id: "app".into(),
    });
    let steady = fixture.id("steady");
    let plan = fixture.plan();
    let steady_basis = plan.binding_basis(&steady).unwrap();
    let mut runtime = Runtime::new(plan);
    let parent = fixture.activate(&mut runtime, "product", BTreeMap::new());
    let provider = fixture.activate(&mut runtime, "p", published("retained host state"));
    let consumer = fixture.activate(&mut runtime, "a", BTreeMap::new());
    let capability = runtime.bind(&consumer, "action").unwrap().pop().unwrap();
    let running = runtime.admit(&capability).unwrap();
    let resource = runtime
        .own_resource(&provider, "live provider resource")
        .unwrap();

    fixture.input.ui = Some(UiTarget {
        path: vec!["product".into(), "steady".into()],
        id: "app".into(),
    });
    let next = fixture.plan();
    assert_eq!(next.binding_basis(&steady).unwrap(), steady_basis);
    assert!(runtime.install(next).is_empty());
    assert_eq!(runtime.desired().ui().unwrap().instance, steady);
    assert_eq!(runtime.status(&provider).unwrap().calls, 1);
    assert_eq!(runtime.status(&provider).unwrap().resources, 1);
    assert_eq!(*running.value(), "retained host state");

    fixture.input.instances.get_mut("product").unwrap().package = product_v2.into();
    let next = fixture.plan();
    assert_eq!(next.binding_basis(&steady).unwrap(), steady_basis);
    assert!(runtime.install(next).is_empty());
    assert_eq!(runtime.status(&parent).unwrap().phase, Phase::Active);
    assert_eq!(runtime.status(&provider).unwrap().phase, Phase::Active);
    assert_eq!(runtime.status(&provider).unwrap().calls, 1);
    assert_eq!(runtime.status(&provider).unwrap().resources, 1);
    let continued = runtime.admit(&capability).unwrap();
    assert_eq!(*continued.value(), "retained host state");
    runtime.settle(&continued, Ok(())).unwrap();
    runtime.settle(&running, Ok(())).unwrap();
    assert!(
        runtime
            .complete_resource(&resource, Ok(()))
            .unwrap()
            .is_empty()
    );

    let host_v2 = PackageRef {
        revision: format!("sha256-{:064x}", 2),
        ..reference("provider")
    };
    fixture
        .packages
        .insert(
            host_v2.clone(),
            Declaration {
                host: Some(entry(true)),
                ui: None,
                composition: None,
            },
        )
        .unwrap();
    fixture
        .input
        .instances
        .get_mut("product")
        .unwrap()
        .overrides
        .push(Override {
            path: vec!["p".into()],
            package: Some(host_v2),
            ..Default::default()
        });
    let retired = runtime.install(fixture.plan());
    assert_eq!(retired.len(), 2);
    assert!(retired.contains(&provider));
    assert!(retired.contains(&consumer));
    assert_eq!(runtime.status(&parent).unwrap().phase, Phase::Active);
    assert!(runtime.admit(&capability).is_err());
}

#[test]
fn initialization_can_invoke_live_dependencies_without_publishing_partial_exports() {
    let fixture = Fixture::new();
    let mut runtime = Runtime::new(fixture.plan());
    let provider = fixture.activate(&mut runtime, "p", published("initialized state"));
    let consumer = runtime.begin(&fixture.id("a")).unwrap();
    let capability = runtime.bind(&consumer, "action").unwrap().pop().unwrap();
    let initialization = runtime.admit(&capability).unwrap();
    assert_eq!(*initialization.value(), "initialized state");
    assert_eq!(runtime.status(&consumer).unwrap().phase, Phase::Loading);
    runtime.retire(&consumer).unwrap();
    assert!(matches!(runtime.admit(&capability), Err(Error::Retired)));
    runtime.finish_cleanup(&consumer).unwrap();
    assert_eq!(runtime.status(&provider).unwrap().calls, 1);
    runtime.settle(&initialization, Ok(())).unwrap();
}

#[test]
fn resource_failure_delivers_the_full_stop_set_to_adapter() {
    let fixture = Fixture::new();
    let mut runtime = Runtime::new(fixture.plan());
    let provider = fixture.activate(&mut runtime, "p", published(1));
    let consumer = fixture.activate(&mut runtime, "a", BTreeMap::new());
    let resource = runtime
        .own_resource(&provider, "foreground subscription")
        .unwrap();
    let stopped = runtime
        .complete_resource(&resource, Err("close acknowledgement missing".into()))
        .unwrap();
    assert_eq!(stopped.len(), 2);
    assert!(stopped.contains(&provider));
    assert!(stopped.contains(&consumer));
    assert!(runtime.retire(&provider).unwrap().is_empty());
    assert!(matches!(
        runtime.finish_cleanup(&provider),
        Err(Error::CleanupFailed(_))
    ));
}

#[test]
fn alias_changes_keep_activations_but_effective_configuration_changes_retire_dependents() {
    let mut fixture = Fixture::new();
    let mut runtime = Runtime::new(fixture.plan());
    let provider = fixture.activate(&mut runtime, "p", published(1));
    let consumer = fixture.activate(&mut runtime, "a", BTreeMap::new());
    let p = fixture.input.instances.remove("p").unwrap();
    fixture.input.instances.insert("renamed".into(), p);
    for name in ["a", "b"] {
        fixture
            .input
            .instances
            .get_mut(name)
            .unwrap()
            .bindings
            .insert("action".into(), vec![target("renamed")]);
    }
    assert!(runtime.install(fixture.plan()).is_empty());
    assert_eq!(runtime.instance(&provider).unwrap().path, vec!["renamed"]);
    assert_eq!(runtime.status(&provider).unwrap().phase, Phase::Active);
    fixture
        .input
        .instances
        .get_mut("renamed")
        .unwrap()
        .configuration
        .values
        .insert("setting".into(), json!(2));
    let retired = runtime.install(fixture.plan());
    assert_eq!(retired.len(), 2);
    assert!(retired.contains(&provider));
    assert!(retired.contains(&consumer));
    assert_eq!(
        runtime.instance(&provider).unwrap().configuration,
        json!({})
    );
}

#[test]
fn consumer_configuration_changes_do_not_retire_shared_provider() {
    let mut fixture = Fixture::new();
    let mut runtime = Runtime::new(fixture.plan());
    let provider = fixture.activate(&mut runtime, "p", published(1));
    let consumer = fixture.activate(&mut runtime, "a", BTreeMap::new());
    let sibling = fixture.activate(&mut runtime, "b", BTreeMap::new());
    fixture
        .input
        .instances
        .get_mut("a")
        .unwrap()
        .configuration
        .values
        .insert("setting".into(), json!(2));
    assert_eq!(runtime.install(fixture.plan()), vec![consumer]);
    assert_eq!(runtime.status(&provider).unwrap().phase, Phase::Active);
    assert_eq!(runtime.status(&sibling).unwrap().phase, Phase::Active);
}

#[test]
fn ui_consumers_track_effective_provider_changes_and_keep_original_work_through_retirement() {
    use crate::package::UiEntry;

    let mut fixture = Fixture::new();
    let mut relay = entry(false);
    relay.exports = entry(true).exports;
    fixture
        .packages
        .insert(
            reference("relay"),
            Declaration {
                host: Some(relay),
                ui: None,
                composition: None,
            },
        )
        .unwrap();
    fixture
        .input
        .instances
        .insert("relay".into(), node("relay", 5, false));
    fixture
        .packages
        .insert(
            reference("ui"),
            Declaration {
                host: None,
                ui: Some(UiEntry {
                    module: "ui.js".into(),
                    configuration: json!({"type":"object"}).into(),
                    imports: BTreeMap::from([(
                        "action".into(),
                        Import {
                            contract: contract(),
                            cardinality: Cardinality::One,
                        },
                    )]),
                    contributions: BTreeMap::new(),
                }),
                composition: None,
            },
        )
        .unwrap();
    let mut ui = node("ui", 4, false);
    ui.use_package = PackageUse::Ui;
    ui.bindings.insert("action".into(), vec![target("relay")]);
    fixture.input.instances.insert("ui".into(), ui);
    let ui_id = fixture.id("ui");
    let plan = fixture.plan();
    let definition = plan.definition_basis(&ui_id).unwrap();
    let basis = plan.binding_basis(&ui_id).unwrap();
    let mut runtime = Runtime::new(plan);
    let ui = runtime.begin_ui_consumer(&ui_id).unwrap();
    assert!(matches!(
        runtime.publish(&ui, BTreeMap::new()).unwrap_err().error,
        Error::NotReady(_)
    ));
    assert_eq!(runtime.status(&ui).unwrap().phase, Phase::Loading);
    let provider = fixture.activate(&mut runtime, "p", published("base service"));
    let relay = fixture.activate(&mut runtime, "relay", published("bound plugin service"));
    runtime.publish(&ui, BTreeMap::new()).unwrap();
    let capability = runtime.bind(&ui, "action").unwrap().pop().unwrap();
    let accepted = runtime.admit(&capability).unwrap();
    assert_eq!(*accepted.value(), "bound plugin service");

    fixture
        .input
        .instances
        .get_mut("b")
        .unwrap()
        .configuration
        .values
        .insert("unrelated".into(), json!(true));
    let unrelated = fixture.plan();
    assert_eq!(unrelated.definition_basis(&ui_id).unwrap(), definition);
    assert_eq!(unrelated.binding_basis(&ui_id).unwrap(), basis);
    assert!(runtime.install(unrelated).is_empty());

    let original_package = reference("provider");
    let upgraded_package = PackageRef {
        revision: format!("sha256-{:064x}", 2),
        ..original_package.clone()
    };
    fixture
        .packages
        .insert(
            upgraded_package.clone(),
            Declaration {
                host: Some(entry(true)),
                ui: None,
                composition: None,
            },
        )
        .unwrap();
    fixture.input.instances.get_mut("p").unwrap().package = upgraded_package.into();
    let upgraded = fixture.plan();
    assert_eq!(upgraded.definition_basis(&ui_id).unwrap(), definition);
    assert_ne!(upgraded.binding_basis(&ui_id).unwrap(), basis);
    fixture.input.instances.get_mut("p").unwrap().package = original_package.into();
    fixture
        .input
        .instances
        .get_mut("p")
        .unwrap()
        .configuration
        .values
        .insert("changed".into(), json!(true));
    let changed = fixture.plan();
    assert_eq!(changed.definition_basis(&ui_id).unwrap(), definition);
    assert_ne!(changed.binding_basis(&ui_id).unwrap(), basis);
    let mut redefined = fixture.input.clone();
    redefined
        .instances
        .get_mut("ui")
        .unwrap()
        .configuration
        .values
        .insert("own".into(), json!(true));
    let own_configuration =
        Plan::prepare(&redefined, &fixture.packages, &RemoteExports::new()).unwrap();
    assert_ne!(
        own_configuration.definition_basis(&ui_id).unwrap(),
        definition
    );
    redefined
        .instances
        .get_mut("ui")
        .unwrap()
        .configuration
        .values
        .remove("own");
    redefined
        .instances
        .get_mut("ui")
        .unwrap()
        .bindings
        .insert("action".into(), vec![target("p")]);
    let own_binding = Plan::prepare(&redefined, &fixture.packages, &RemoteExports::new()).unwrap();
    assert_ne!(own_binding.definition_basis(&ui_id).unwrap(), definition);
    let retired = runtime.install(changed);
    assert_eq!(retired.len(), 3);
    assert!(retired.contains(&provider));
    assert!(retired.contains(&relay));
    assert!(retired.contains(&ui));
    assert!(matches!(runtime.admit(&capability), Err(Error::Retired)));
    assert_eq!(*accepted.value(), "bound plugin service");
    runtime.settle(&accepted, Ok(())).unwrap();
    runtime.finish_cleanup(&ui).unwrap();
    runtime.finish_cleanup(&relay).unwrap();
    runtime.finish_cleanup(&provider).unwrap();
}

#[test]
fn required_imports_must_be_live_before_atomic_publication() {
    let fixture = Fixture::new();
    let mut runtime = Runtime::<usize>::new(fixture.plan());
    let consumer = runtime.begin(&fixture.id("a")).unwrap();
    assert!(matches!(
        runtime
            .publish(&consumer, BTreeMap::new())
            .unwrap_err()
            .error,
        Error::NotReady(_)
    ));
    fixture.activate(&mut runtime, "p", published(1));
    runtime.publish(&consumer, BTreeMap::new()).unwrap();
    assert_eq!(runtime.status(&consumer).unwrap().phase, Phase::Active);
}

#[test]
fn authority_tokens_cannot_cross_runtime_domains() {
    let fixture = Fixture::new();
    let mut first = Runtime::new(fixture.plan());
    let mut second = Runtime::new(fixture.plan());
    let provider = fixture.activate(&mut first, "p", published(1));
    let consumer = fixture.activate(&mut first, "a", BTreeMap::new());
    let capability = first.bind(&consumer, "action").unwrap().pop().unwrap();
    let execution = first.admit(&capability).unwrap();
    let resource = first.own_resource(&provider, "task").unwrap();
    fixture.activate(&mut second, "p", published(2));
    fixture.activate(&mut second, "a", BTreeMap::new());
    assert!(matches!(second.retire(&provider), Err(Error::Retired)));
    assert!(matches!(second.admit(&capability), Err(Error::Retired)));
    assert!(matches!(
        second.settle(&execution, Ok(())),
        Err(Error::Retired)
    ));
    assert!(matches!(
        second.complete_resource(&resource, Ok(())),
        Err(Error::Retired)
    ));
    assert_eq!(first.status(&provider).unwrap().calls, 1);
    assert_eq!(first.status(&provider).unwrap().resources, 1);
}

#[test]
fn remote_metadata_does_not_count_as_an_actual_registration() {
    let mut fixture = Fixture::new();
    let mut remote_contract = contract();
    remote_contract.transport = Transport::Remote;
    let mut remote_entry = entry(false);
    remote_entry.imports.get_mut("action").unwrap().contract = remote_contract.clone();
    remote_entry.imports.get_mut("action").unwrap().cardinality = Cardinality::One;
    fixture
        .packages
        .insert(
            reference("remote-consumer"),
            Declaration {
                host: Some(remote_entry),
                ui: None,
                composition: None,
            },
        )
        .unwrap();
    let remote = RemoteCapability {
        deployment: "another-host".into(),
        instance: InstanceId(vec![Uuid::from_u128(99)]),
        export: "action".into(),
    };
    let mut consumer = node("remote-consumer", 4, false);
    consumer.bindings.insert(
        "action".into(),
        vec![Target::Remote {
            deployment: remote.deployment.clone(),
            instance: remote.instance.clone(),
            export: remote.export.clone(),
        }],
    );
    fixture.input.instances = BTreeMap::from([("remote".into(), consumer)]);
    let plan = Plan::prepare(
        &fixture.input,
        &fixture.packages,
        &BTreeMap::from([(
            remote,
            Export {
                contract: remote_contract,
                availability: Availability::Required,
            },
        )]),
    )
    .unwrap();
    let id = plan.instances().values().next().unwrap().identity.clone();
    let mut runtime = Runtime::<usize>::new(plan);
    let activation = runtime.begin(&id).unwrap();
    assert!(matches!(
        runtime
            .publish(&activation, BTreeMap::new())
            .unwrap_err()
            .error,
        Error::NotReady(_)
    ));
}

fn remote_plan(optional: bool) -> (Fixture, RemoteCapability, Contract, Plan) {
    let mut fixture = Fixture::new();
    let mut declared = contract();
    declared.transport = Transport::Remote;
    let mut declaration = entry(false);
    declaration.imports.get_mut("action").unwrap().contract = declared.clone();
    declaration.imports.get_mut("action").unwrap().cardinality = if optional {
        Cardinality::Optional
    } else {
        Cardinality::One
    };
    fixture
        .packages
        .insert(
            reference("remote-consumer"),
            Declaration {
                host: Some(declaration),
                ui: None,
                composition: None,
            },
        )
        .unwrap();
    // Deliberately share the local provider's stable ID; origin must distinguish it.
    let target = RemoteCapability {
        deployment: "host-a".into(),
        instance: InstanceId(vec![Uuid::from_u128(1)]),
        export: "action".into(),
    };
    for (alias, key) in [("a", 2), ("b", 3)] {
        let mut consumer = node("remote-consumer", key, false);
        consumer.bindings.insert(
            "action".into(),
            vec![Target::Remote {
                deployment: target.deployment.clone(),
                instance: target.instance.clone(),
                export: target.export.clone(),
            }],
        );
        fixture.input.instances.insert(alias.into(), consumer);
    }
    let observations = BTreeMap::from([(
        target.clone(),
        Export {
            contract: declared.clone(),
            availability: Availability::Required,
        },
    )]);
    let plan = Plan::prepare(&fixture.input, &fixture.packages, &observations).unwrap();
    (fixture, target, declared, plan)
}

#[test]
fn actual_remote_attachment_distinguishes_local_identity_and_fences_reconnect_and_old_handles() {
    let (_, target, declared, plan) = remote_plan(false);
    let mut runtime = Runtime::<usize>::new(plan);
    let local = runtime.begin(&target.instance).unwrap();
    runtime
        .publish(
            &local,
            BTreeMap::from([(
                "action".into(),
                Published {
                    contract: contract(),
                    value: 1,
                },
            )]),
        )
        .unwrap();
    let wire_epoch = Uuid::new_v4();
    let remote = runtime
        .attach_remote(
            target.clone(),
            wire_epoch,
            Published {
                contract: declared.clone(),
                value: 7,
            },
        )
        .unwrap();
    assert_ne!(local, remote);
    assert_eq!(local.instance(), remote.instance());
    assert!(local.remote_target().is_none());
    assert_eq!(remote.remote_target(), Some(&target));
    assert!(runtime.instance(&remote).is_err());
    let consumer = runtime
        .begin(&InstanceId(vec![Uuid::from_u128(2)]))
        .unwrap();
    runtime.publish(&consumer, BTreeMap::new()).unwrap();
    let capability = runtime.bind(&consumer, "action").unwrap().remove(0);
    assert_eq!(capability.provider(), &remote);
    assert_eq!(capability.registration_epoch(), wire_epoch);
    let work = runtime.admit(&capability).unwrap();
    assert_eq!(*work.value(), 7);
    let resource = runtime.own_resource(&remote, "actual connection").unwrap();
    let retired = runtime.retire(&remote).unwrap();
    assert!(retired.contains(&remote));
    assert!(retired.contains(&consumer));
    assert_eq!(runtime.status(&local).unwrap().phase, Phase::Active);
    assert!(runtime.admit(&capability).is_err());
    assert!(matches!(
        runtime.finish_cleanup(&remote),
        Err(Error::CleanupPending)
    ));
    assert!(
        runtime
            .attach_remote(
                target.clone(),
                wire_epoch,
                Published {
                    contract: declared.clone(),
                    value: 8
                }
            )
            .is_err()
    );
    runtime
        .settle(&work, Err("transport cleanup unknown".into()))
        .unwrap();
    assert!(matches!(
        runtime.finish_cleanup(&remote),
        Err(Error::CleanupFailed(_))
    ));
    runtime.complete_resource(&resource, Ok(())).unwrap();
    assert!(
        runtime
            .attach_remote(
                target.clone(),
                wire_epoch,
                Published {
                    contract: declared.clone(),
                    value: 8
                }
            )
            .is_err()
    );
    assert_eq!(*work.value(), 7);
    runtime.settle(&work, Ok(())).unwrap();
    runtime.finish_cleanup(&remote).unwrap();
    let replacement = runtime
        .attach_remote(
            target,
            wire_epoch,
            Published {
                contract: declared,
                value: 8,
            },
        )
        .unwrap();
    assert_ne!(replacement, remote);
    assert!(runtime.admit(&capability).is_err());
    runtime.finish_cleanup(&consumer).unwrap();
    let consumer2 = runtime.begin(consumer.instance()).unwrap();
    runtime.publish(&consumer2, BTreeMap::new()).unwrap();
    let new = runtime.bind(&consumer2, "action").unwrap().remove(0);
    assert_eq!(new.provider(), &replacement);
    let next = runtime.admit(&new).unwrap();
    assert_eq!(*next.value(), 8);
    runtime.settle(&next, Ok(())).unwrap();
    // Tokens belong to exactly one runtime, even if target and wire epoch agree.
    let (_, _, _, other_plan) = remote_plan(false);
    let mut other = Runtime::<usize>::new(other_plan);
    assert!(other.admit(&new).is_err());
    assert!(other.settle(&work, Ok(())).is_err());
}

#[test]
fn optional_remote_metadata_is_empty_and_actual_mismatch_does_not_become_ready() {
    let (_, target, declared, plan) = remote_plan(true);
    let mut runtime = Runtime::<usize>::new(plan);
    let consumer = runtime
        .begin(&InstanceId(vec![Uuid::from_u128(2)]))
        .unwrap();
    runtime.publish(&consumer, BTreeMap::new()).unwrap();
    assert!(runtime.bind(&consumer, "action").unwrap().is_empty());
    let mut incompatible = declared.clone();
    incompatible.version += 1;
    let rejected = runtime
        .attach_remote(
            target.clone(),
            Uuid::new_v4(),
            Published {
                contract: incompatible,
                value: 9,
            },
        )
        .unwrap_err();
    assert_eq!(rejected.batch["action"].value, 9);
    assert!(runtime.bind(&consumer, "action").unwrap().is_empty());
    assert!(
        runtime
            .attach_remote(
                target.clone(),
                Uuid::nil(),
                Published {
                    contract: declared.clone(),
                    value: 9
                }
            )
            .is_err()
    );
    assert!(
        runtime
            .attach_remote(
                target.clone(),
                Uuid::new_v4(),
                Published {
                    contract: contract(),
                    value: 9
                }
            )
            .is_err()
    );
    runtime
        .attach_remote(
            target,
            Uuid::new_v4(),
            Published {
                contract: declared,
                value: 9,
            },
        )
        .unwrap();
    let capability = runtime.bind(&consumer, "action").unwrap().remove(0);
    assert_eq!(*runtime.inspect(&capability).unwrap(), 9);
}

#[test]
fn installing_unreferenced_input_retires_remote_without_rewriting_original_work() {
    let (mut fixture, target, declared, plan) = remote_plan(false);
    let mut runtime = Runtime::<usize>::new(plan);
    let remote = runtime
        .attach_remote(
            target,
            Uuid::new_v4(),
            Published {
                contract: declared,
                value: 41,
            },
        )
        .unwrap();
    let consumer = runtime
        .begin(&InstanceId(vec![Uuid::from_u128(2)]))
        .unwrap();
    runtime.publish(&consumer, BTreeMap::new()).unwrap();
    let capability = runtime.bind(&consumer, "action").unwrap().remove(0);
    let work = runtime.admit(&capability).unwrap();
    fixture.input.instances.remove("a");
    fixture.input.instances.remove("b");
    let next = fixture.plan();
    let retired = runtime.install(next);
    assert!(retired.contains(&remote));
    assert_eq!(*work.value(), 41);
    assert!(runtime.admit(&capability).is_err());
    assert!(matches!(
        runtime.finish_cleanup(&remote),
        Err(Error::CleanupPending)
    ));
    runtime.settle(&work, Ok(())).unwrap();
    runtime.finish_cleanup(&remote).unwrap();
}

#[test]
fn bound_tokens_do_not_own_values_but_accepted_execution_survives_retirement_and_handle_drop() {
    let fixture = Fixture::new();
    let mut runtime = Runtime::new(fixture.plan());
    let value = Arc::new(());
    let weak = Arc::downgrade(&value);
    let provider = fixture.activate(
        &mut runtime,
        "p",
        BTreeMap::from([(
            "action".into(),
            Published {
                contract: contract(),
                value,
            },
        )]),
    );
    let consumer = fixture.activate(&mut runtime, "a", BTreeMap::new());
    let token = runtime.bind(&consumer, "action").unwrap().remove(0);
    let old = token.clone();
    let execution = runtime.admit(&token).unwrap();
    drop(token);
    runtime.retire(&provider).unwrap();
    runtime.finish_cleanup(&consumer).unwrap();
    assert!(runtime.finish_cleanup(&provider).is_err());
    assert!(weak.upgrade().is_some());
    runtime.settle(&execution, Ok(())).unwrap();
    drop(execution);
    runtime.finish_cleanup(&provider).unwrap();
    assert!(
        weak.upgrade().is_none(),
        "old bound token is not a second value owner"
    );
    assert!(runtime.inspect(&old).is_err());
}
