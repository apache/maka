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
use crate::{
    composition::{Environment, ExecutionLocation, Parameter, PresentationTarget, Template},
    contract::{Cardinality, Contract},
    package::{Declaration, Implementation, Realm},
};
use serde_json::json;
use uuid::Uuid;

fn package(id: &str, revision: u8) -> PackageRef {
    PackageRef {
        id: id.into(),
        revision: format!("sha256-{revision:064x}"),
    }
}

fn contract() -> Contract {
    Contract {
        name: "example.Content".into(),
        version: 1,
        transport: Transport::Local,
        interface: Interface::Component {
            props: json!({"type":"object"}).into(),
            events: BTreeMap::new(),
            captures: BTreeMap::new(),
        },
    }
}

fn entry() -> EntryDeclaration {
    EntryDeclaration {
        scene: Some(crate::package::SceneLanguage {
            name: "test.scene".into(),
            version: 1,
        }),
        implementation: Implementation::JavaScript {
            module: "index.mjs".into(),
            realm: Realm::Dedicated,
        },
        configuration: json!({"type":"object","properties":{"title":{"type":"string"}},"required":["title"],"additionalProperties":false}).into(),
        imports: BTreeMap::new(),
        exports: BTreeMap::from([(
            "Content".into(),
            Export {
                contract: contract(),
                availability: Availability::Required,
            },
        )]),
    }
}

fn node(key: u128, package: PackageRef, use_package: PackageUse) -> Node {
    Node {
        key: Uuid::from_u128(key),
        package: package.into(),
        use_package,
        configuration: Configuration::default(),
        parameters: Configuration::default(),
        bindings: BTreeMap::new(),
        disabled: false,
        overrides: Vec::new(),
    }
}

fn local(path: &[&str], export: &str) -> Target {
    Target::Instance {
        path: path.iter().map(|part| (*part).into()).collect(),
        export: export.into(),
    }
}

fn template(default: &str) -> Template {
    let mut content = node(10, package("content", 1), PackageUse::Entry);
    content
        .configuration
        .parameters
        .insert("title".into(), "title".into());
    Template {
        parameters: BTreeMap::from([(
            "title".into(),
            Parameter {
                schema: json!({"type":"string"}).into(),
                default: Some(json!(default)),
            },
        )]),
        imports: BTreeMap::new(),
        exports: BTreeMap::from([("App".into(), local(&["content"], "Content"))]),
        children: BTreeMap::from([("content".into(), content)]),
    }
}

fn fixture() -> (Input, Packages) {
    let mut packages = Packages::default();
    packages
        .insert(
            package("content", 1),
            Declaration {
                entries: BTreeMap::from([(EntryTarget::Tui, entry())]),
                composition: None,
            },
        )
        .unwrap();
    packages
        .insert(
            package("product", 1),
            Declaration {
                entries: BTreeMap::new(),
                composition: Some(template("default")),
            },
        )
        .unwrap();
    let input = Input {
        environment: Environment {
            location: ExecutionLocation::Ui,
            presentation: Some(PresentationTarget::Tui),
        },
        instances: BTreeMap::from([
            (
                "a".into(),
                node(1, package("product", 1), PackageUse::Composition),
            ),
            (
                "b".into(),
                node(2, package("product", 1), PackageUse::Composition),
            ),
        ]),
        recovery: None,
        launch: Some(local(&["a"], "App")),
    };
    (input, packages)
}

fn instance<'a>(plan: &'a Plan, path: &[&str]) -> &'a Instance {
    plan.instances()
        .values()
        .find(|instance| {
            instance
                .path
                .iter()
                .map(String::as_str)
                .eq(path.iter().copied())
        })
        .unwrap()
}

#[test]
fn package_replacements_validate_nested_providers_and_consumers_atomically() {
    let (mut input, mut packages) = fixture();
    let mut next_contract = contract();
    next_contract.name = "example.UpdatedContent".into();
    let mut next_content = entry();
    next_content.exports.get_mut("Content").unwrap().contract = next_contract.clone();
    packages
        .insert(
            package("content", 2),
            Declaration {
                entries: BTreeMap::from([(EntryTarget::Tui, next_content)]),
                composition: None,
            },
        )
        .unwrap();
    for revision in [1, 2] {
        let mut consumer = entry();
        consumer.imports.insert(
            "content".into(),
            Import {
                contract: if revision == 1 {
                    contract()
                } else {
                    next_contract.clone()
                },
                cardinality: Cardinality::One,
            },
        );
        packages
            .insert(
                package("consumer", revision),
                Declaration {
                    entries: BTreeMap::from([(EntryTarget::Tui, consumer)]),
                    composition: None,
                },
            )
            .unwrap();
    }
    let mut consumer = node(3, package("consumer", 1), PackageUse::Entry);
    consumer
        .configuration
        .values
        .insert("title".into(), json!("Keep this title"));
    consumer
        .bindings
        .insert("content".into(), vec![local(&["a"], "App")]);
    input.instances.insert("consumer".into(), consumer);
    let original = Plan::prepare(&input, &packages, &RemoteExports::new()).unwrap();
    let (updated, changes) =
        Plan::prepare_replacing(&input, &packages, &RemoteExports::new(), |selected| {
            matches!(selected.id.as_str(), "content" | "consumer").then(|| package(&selected.id, 2))
        })
        .unwrap();
    assert_eq!(changes.len(), 3);
    assert_eq!(
        instance(&updated, &["a", "content"]).package,
        package("content", 2)
    );
    assert_eq!(
        instance(&updated, &["consumer"]).bindings["content"][0]
            .declaration
            .contract,
        next_contract
    );
    assert_eq!(
        Plan::prepare(&input, &packages, &RemoteExports::new()).unwrap(),
        original
    );
    for PackageChange { path, package } in changes {
        let node = input.instances.get_mut(&path[0]).unwrap();
        if path.len() == 1 {
            node.package = package.into();
        } else {
            node.overrides.push(Override {
                path: path[1..].to_vec(),
                package: Some(package),
                ..Default::default()
            });
        }
    }
    assert_eq!(
        Plan::prepare(&input, &packages, &RemoteExports::new()).unwrap(),
        updated
    );
}

#[test]
fn forwarded_exports_and_plan_snapshots_share_frozen_declarations() {
    let (input, packages) = fixture();
    let plan = Plan::prepare(&input, &packages, &RemoteExports::new()).unwrap();
    let content = instance(&plan, &["a", "content"]);
    let original = &content.exports["Content"].declaration;
    assert!(Arc::ptr_eq(
        original,
        &instance(&plan, &["a"]).exports["App"].declaration
    ));
    assert!(Arc::ptr_eq(original, &plan.launch().unwrap().declaration));
    let snapshot = plan.clone();
    let retained = instance(&snapshot, &["a", "content"]);
    assert!(Arc::ptr_eq(
        original,
        &retained.exports["Content"].declaration
    ));
    assert!(Arc::ptr_eq(
        content.entry.as_ref().unwrap(),
        retained.entry.as_ref().unwrap()
    ));
    assert_eq!(
        serde_json::to_value(original).unwrap(),
        json!({
            "contract": contract(), "availability": "required"
        })
    );
}

#[test]
fn template_instances_keep_overrides_and_identity_through_upgrade_and_alias_change() {
    let (mut input, mut packages) = fixture();
    input
        .instances
        .get_mut("a")
        .unwrap()
        .overrides
        .push(Override {
            path: vec!["content".into()],
            configuration: BTreeMap::from([("title".into(), json!("A override"))]),
            bindings: BTreeMap::new(),
            disabled: None,
            ..Override::default()
        });
    let initial = Plan::prepare(&input, &packages, &RemoteExports::new()).unwrap();
    let identity = instance(&initial, &["a", "content"]).identity.clone();
    assert_ne!(identity, instance(&initial, &["b", "content"]).identity);
    assert_eq!(
        instance(&initial, &["a", "content"]).configuration["title"],
        "A override"
    );
    assert_eq!(
        instance(&initial, &["b", "content"]).configuration["title"],
        "default"
    );

    packages
        .insert(
            package("product", 2),
            Declaration {
                entries: BTreeMap::new(),
                composition: Some(template("new default")),
            },
        )
        .unwrap();
    for root in input.instances.values_mut() {
        root.package = package("product", 2).into();
    }
    let upgraded = Plan::prepare(&input, &packages, &RemoteExports::new()).unwrap();
    assert_eq!(instance(&upgraded, &["a", "content"]).identity, identity);
    assert_eq!(
        instance(&upgraded, &["a", "content"]).configuration["title"],
        "A override"
    );
    assert_eq!(
        instance(&upgraded, &["b", "content"]).configuration["title"],
        "new default"
    );
    input.instances.remove("b");
    let a = input.instances.remove("a").unwrap();
    input.instances.insert("renamed".into(), a);
    input.launch = Some(local(&["renamed"], "App"));
    let renamed = Plan::prepare(&input, &packages, &RemoteExports::new()).unwrap();
    assert_eq!(
        instance(&renamed, &["renamed", "content"]).identity,
        identity
    );
    assert_eq!(renamed.instances().len(), 2);
    let recovered: Input = serde_json::from_slice(&serde_json::to_vec(&input).unwrap()).unwrap();
    assert_eq!(
        Plan::prepare(&recovered, &packages, &RemoteExports::new()).unwrap(),
        renamed
    );
}

#[test]
fn removed_source_or_template_child_cannot_silently_discard_other_intent() {
    let (mut input, mut packages) = fixture();
    let mut consumer = node(3, package("consumer", 1), PackageUse::Entry);
    consumer
        .configuration
        .values
        .insert("title".into(), json!("consumer"));
    consumer
        .bindings
        .insert("content".into(), vec![local(&["b"], "App")]);
    let mut consumer_entry = entry();
    consumer_entry.imports.insert(
        "content".into(),
        Import {
            contract: contract(),
            cardinality: Cardinality::One,
        },
    );
    packages
        .insert(
            package("consumer", 1),
            Declaration {
                entries: BTreeMap::from([(EntryTarget::Tui, consumer_entry)]),
                composition: None,
            },
        )
        .unwrap();
    input.instances.insert("consumer".into(), consumer);
    let prior = Plan::prepare(&input, &packages, &RemoteExports::new()).unwrap();
    let mut candidate = input.clone();
    candidate.instances.remove("b");
    assert!(Plan::prepare(&candidate, &packages, &RemoteExports::new()).is_err());
    assert_eq!(
        Plan::prepare(&input, &packages, &RemoteExports::new()).unwrap(),
        prior
    );

    input
        .instances
        .get_mut("a")
        .unwrap()
        .overrides
        .push(Override {
            path: vec!["removed".into()],
            configuration: BTreeMap::new(),
            bindings: BTreeMap::new(),
            disabled: Some(false),
            ..Override::default()
        });
    assert!(
        Plan::prepare(&input, &packages, &RemoteExports::new())
            .unwrap_err()
            .to_string()
            .contains("override target disappeared")
    );
}

#[test]
fn structural_imports_forward_exact_capabilities_and_detect_dependency_cycles() {
    let (mut input, mut packages) = fixture();
    let mut content = entry();
    content.imports.insert(
        "base".into(),
        Import {
            contract: contract(),
            cardinality: Cardinality::One,
        },
    );
    packages
        .insert(
            package("dependent", 1),
            Declaration {
                entries: BTreeMap::from([(EntryTarget::Tui, content)]),
                composition: None,
            },
        )
        .unwrap();
    let mut wrapper = template("dependent");
    wrapper.imports.insert(
        "base".into(),
        Import {
            contract: contract(),
            cardinality: Cardinality::One,
        },
    );
    let child = wrapper.children.get_mut("content").unwrap();
    child.package = package("dependent", 1).into();
    child.bindings.insert(
        "base".into(),
        vec![Target::Import {
            name: "base".into(),
        }],
    );
    packages
        .insert(
            package("wrapper", 1),
            Declaration {
                entries: BTreeMap::new(),
                composition: Some(wrapper),
            },
        )
        .unwrap();
    input.instances.get_mut("a").unwrap().package = package("wrapper", 1).into();
    input
        .instances
        .get_mut("a")
        .unwrap()
        .bindings
        .insert("base".into(), vec![local(&["b"], "App")]);
    let plan = Plan::prepare(&input, &packages, &RemoteExports::new()).unwrap();
    assert_eq!(
        instance(&plan, &["a", "content"]).bindings["base"][0].provider,
        Provider::Local {
            instance: instance(&plan, &["b", "content"]).identity.clone(),
            export: "Content".into()
        }
    );
    input
        .instances
        .get_mut("a")
        .unwrap()
        .bindings
        .insert("base".into(), vec![local(&["a"], "App")]);
    assert!(
        Plan::prepare(&input, &packages, &RemoteExports::new())
            .unwrap_err()
            .to_string()
            .contains("cyclic capability dependency")
    );
}

#[test]
fn actual_export_checks_use_the_full_public_contract() {
    let entry = entry();
    assert!(
        entry
            .check_exports(&BTreeMap::new(), |contract: &Contract| contract)
            .is_err()
    );
    let mut actual = BTreeMap::from([("Content".into(), contract())]);
    entry.check_exports(&actual, |contract| contract).unwrap();
    actual.get_mut("Content").unwrap().interface = Interface::Value {
        schema: json!({"type":"object"}).into(),
    };
    assert!(entry.check_exports(&actual, |contract| contract).is_err());
    actual.insert("undeclared".into(), contract());
    assert!(entry.check_exports(&actual, |contract| contract).is_err());
}

#[test]
fn scene_declarations_are_required_only_for_javascript_component_entries() {
    let valid = entry();
    valid.validate().unwrap();
    let mut optional = valid.clone();
    optional.exports.get_mut("Content").unwrap().availability = Availability::Optional;
    optional.validate().unwrap();
    optional.scene = None;
    assert!(
        optional
            .validate()
            .unwrap_err()
            .to_string()
            .contains("require a scene language")
    );
    for language in [
        crate::package::SceneLanguage {
            name: String::new(),
            version: 1,
        },
        crate::package::SceneLanguage {
            name: "bad/name".into(),
            version: 1,
        },
        crate::package::SceneLanguage {
            name: "valid.scene".into(),
            version: 0,
        },
    ] {
        let mut invalid = valid.clone();
        invalid.scene = Some(language);
        assert!(invalid.validate().is_err());
    }
    let mut complete = valid.clone();
    complete.scene.as_mut().unwrap().name = "x".repeat(129);
    complete.validate().unwrap();
    assert_eq!(
        serde_json::to_value(&complete).unwrap()["scene"]["name"],
        json!("x".repeat(129))
    );
    let host = Declaration {
        entries: BTreeMap::from([(EntryTarget::Host, valid.clone())]),
        composition: None,
    };
    assert!(
        host.validate()
            .unwrap_err()
            .to_string()
            .contains("Host entry")
    );
    let mut native = valid.clone();
    native.implementation = Implementation::Native {
        implementation: "compiled.component".into(),
    };
    assert!(native.validate().is_err());
    native.scene = None;
    native.validate().unwrap();
    let mut value = valid.clone();
    value.exports.get_mut("Content").unwrap().contract.interface = Interface::Value {
        schema: json!(true).into(),
    };
    assert!(value.validate().is_err());
    value.scene = None;
    value.validate().unwrap();
    let mut empty = valid;
    empty.exports.clear();
    assert!(empty.validate().is_err());
    empty.scene = None;
    empty.validate().unwrap();
}

#[test]
fn incompatible_binding_missing_variant_and_optional_provider_fail_before_activation() {
    let (mut input, mut packages) = fixture();
    let mut consumer = node(3, package("consumer", 1), PackageUse::Entry);
    consumer
        .configuration
        .values
        .insert("title".into(), json!("consumer"));
    consumer
        .bindings
        .insert("content".into(), vec![local(&["a"], "App")]);
    let mut entry = entry();
    let mut expected = contract();
    expected.version = 2;
    entry.imports.insert(
        "content".into(),
        Import {
            contract: expected,
            cardinality: Cardinality::One,
        },
    );
    packages
        .insert(
            package("consumer", 1),
            Declaration {
                entries: BTreeMap::from([(EntryTarget::Tui, entry.clone())]),
                composition: None,
            },
        )
        .unwrap();
    input.instances.insert("consumer".into(), consumer);
    assert!(matches!(
        Plan::prepare(&input, &packages, &RemoteExports::new()),
        Err(Error::Contract(_))
    ));
    entry.imports.get_mut("content").unwrap().contract = contract();
    packages
        .insert(
            package("consumer", 2),
            Declaration {
                entries: BTreeMap::from([(EntryTarget::Tui, entry)]),
                composition: None,
            },
        )
        .unwrap();
    input.instances.get_mut("consumer").unwrap().package = package("consumer", 2).into();
    Plan::prepare(&input, &packages, &RemoteExports::new()).unwrap();
    let mut provider = self::entry();
    provider.exports.get_mut("Content").unwrap().availability = Availability::Optional;
    packages
        .insert(
            package("content", 2),
            Declaration {
                entries: BTreeMap::from([(EntryTarget::Tui, provider)]),
                composition: None,
            },
        )
        .unwrap();
    let mut updated = template("optional");
    updated.children.get_mut("content").unwrap().package = package("content", 2).into();
    packages
        .insert(
            package("product", 2),
            Declaration {
                entries: BTreeMap::new(),
                composition: Some(updated),
            },
        )
        .unwrap();
    input.instances.get_mut("a").unwrap().package = package("product", 2).into();
    input.launch = Some(local(&["b"], "App"));
    assert!(matches!(
        Plan::prepare(&input, &packages, &RemoteExports::new()),
        Err(Error::Contract(_))
    ));
}

#[test]
fn remote_binding_requires_a_remotable_observed_contract() {
    let (mut input, mut packages) = fixture();
    let capability = RemoteCapability {
        deployment: "primary".into(),
        instance: InstanceId(vec![Uuid::from_u128(20)]),
        export: "Content".into(),
    };
    let mut consumer = node(3, package("consumer", 1), PackageUse::Entry);
    consumer
        .configuration
        .values
        .insert("title".into(), json!("remote"));
    consumer.bindings.insert(
        "content".into(),
        vec![Target::Remote {
            deployment: capability.deployment.clone(),
            instance: capability.instance.clone(),
            export: capability.export.clone(),
        }],
    );
    let mut entry = entry();
    let mut remote_contract = contract();
    remote_contract.transport = Transport::Remote;
    entry.imports.insert(
        "content".into(),
        Import {
            contract: remote_contract.clone(),
            cardinality: Cardinality::One,
        },
    );
    packages
        .insert(
            package("consumer", 1),
            Declaration {
                entries: BTreeMap::from([(EntryTarget::Tui, entry)]),
                composition: None,
            },
        )
        .unwrap();
    input.instances.insert("consumer".into(), consumer);
    let mut remote = RemoteExports::new();
    assert!(Plan::prepare(&input, &packages, &remote).is_err());
    remote.insert(
        capability.clone(),
        Export {
            contract: contract(),
            availability: Availability::Required,
        },
    );
    assert!(Plan::prepare(&input, &packages, &remote).is_err());
    remote.insert(
        capability,
        Export {
            contract: remote_contract,
            availability: Availability::Required,
        },
    );
    let plan = Plan::prepare(&input, &packages, &remote).unwrap();
    assert!(matches!(
        instance(&plan, &["consumer"]).bindings["content"][0].provider,
        Provider::Remote { .. }
    ));
}

#[test]
fn nested_override_precedence_preserves_unrelated_template_defaults() {
    let (mut input, mut packages) = fixture();
    let mut nested = node(30, package("product", 1), PackageUse::Composition);
    nested.overrides.push(Override {
        path: vec!["content".into()],
        configuration: BTreeMap::from([("title".into(), json!("inner"))]),
        bindings: BTreeMap::new(),
        disabled: None,
        ..Override::default()
    });
    packages
        .insert(
            package("outer", 1),
            Declaration {
                entries: BTreeMap::new(),
                composition: Some(Template {
                    parameters: BTreeMap::new(),
                    imports: BTreeMap::new(),
                    exports: BTreeMap::from([("App".into(), local(&["nested"], "App"))]),
                    children: BTreeMap::from([("nested".into(), nested)]),
                }),
            },
        )
        .unwrap();
    let root = input.instances.get_mut("a").unwrap();
    root.package = package("outer", 1).into();
    let mut replacement = self::entry();
    replacement.scene = None;
    replacement.implementation = Implementation::Native {
        implementation: "replacement.Content".into(),
    };
    packages
        .insert(
            package("replacement", 1),
            Declaration {
                entries: BTreeMap::from([(EntryTarget::Tui, replacement)]),
                composition: None,
            },
        )
        .unwrap();
    root.overrides.push(Override {
        path: vec!["nested".into(), "content".into()],
        package: Some(package("replacement", 1)),
        configuration: BTreeMap::from([("title".into(), json!("outer user"))]),
        bindings: BTreeMap::new(),
        disabled: None,
        ..Override::default()
    });
    let plan = Plan::prepare(&input, &packages, &RemoteExports::new()).unwrap();
    assert_eq!(
        instance(&plan, &["a", "nested", "content"]).configuration["title"],
        "outer user"
    );
    assert_eq!(
        instance(&plan, &["a", "nested", "content"]).package,
        package("replacement", 1)
    );
    assert_eq!(
        instance(&plan, &["b", "content"]).configuration["title"],
        "default"
    );
}

#[test]
fn recursive_template_expansion_rejects_cycles_and_duplicate_source_keys() {
    let (mut input, mut packages) = fixture();
    input.instances.get_mut("b").unwrap().key = input.instances["a"].key;
    assert!(Plan::prepare(&input, &packages, &RemoteExports::new()).is_err());
    input.instances.remove("b");
    packages
        .insert(
            package("recursive", 1),
            Declaration {
                entries: BTreeMap::new(),
                composition: Some(Template {
                    parameters: BTreeMap::new(),
                    imports: BTreeMap::new(),
                    exports: BTreeMap::new(),
                    children: BTreeMap::from([(
                        "child".into(),
                        node(42, package("recursive", 1), PackageUse::Composition),
                    )]),
                }),
            },
        )
        .unwrap();
    input.instances.get_mut("a").unwrap().package = package("recursive", 1).into();
    input.launch = None;
    assert!(
        Plan::prepare(&input, &packages, &RemoteExports::new())
            .unwrap_err()
            .to_string()
            .contains("cyclic composition expansion")
    );
}

#[test]
fn template_can_use_its_own_package_without_a_self_referential_revision() {
    let (mut input, mut packages) = fixture();
    let reference = package("integrated", 1);
    let mut own = template("integrated");
    own.children.get_mut("content").unwrap().package = PackageSelection::Current;
    packages
        .insert(
            reference.clone(),
            Declaration {
                entries: BTreeMap::from([(EntryTarget::Tui, entry())]),
                composition: Some(own),
            },
        )
        .unwrap();
    input.instances.get_mut("a").unwrap().package = reference.clone().into();
    let plan = Plan::prepare(&input, &packages, &RemoteExports::new()).unwrap();
    assert_eq!(instance(&plan, &["a", "content"]).package, reference);
    input.instances.get_mut("a").unwrap().package = PackageSelection::Current;
    assert!(
        Plan::prepare(&input, &packages, &RemoteExports::new())
            .unwrap_err()
            .to_string()
            .contains("roots require a pinned")
    );
}

#[test]
fn explicit_null_parameter_default_survives_package_metadata_roundtrip() {
    let (mut input, mut packages) = fixture();
    let mut declaration = template("unused");
    let parameter = declaration.parameters.get_mut("title").unwrap();
    parameter.schema = json!({"type":["string","null"]}).into();
    parameter.default = Some(Value::Null);
    declaration.children.get_mut("content").unwrap().package = package("nullable", 1).into();
    let recovered: Template =
        serde_json::from_value(serde_json::to_value(declaration).unwrap()).unwrap();
    let mut nullable = entry();
    let mut configuration = nullable.configuration.as_ref().clone();
    configuration["properties"]["title"] = json!({"type":["string","null"]});
    nullable.configuration = configuration.into();
    packages
        .insert(
            package("nullable", 1),
            Declaration {
                entries: BTreeMap::from([(EntryTarget::Tui, nullable)]),
                composition: None,
            },
        )
        .unwrap();
    packages
        .insert(
            package("nullable-product", 1),
            Declaration {
                entries: BTreeMap::new(),
                composition: Some(recovered),
            },
        )
        .unwrap();
    input.instances.get_mut("a").unwrap().package = package("nullable-product", 1).into();
    let plan = Plan::prepare(&input, &packages, &RemoteExports::new()).unwrap();
    assert!(instance(&plan, &["a", "content"]).configuration["title"].is_null());
}

#[test]
fn k64_finite_current_compositions_keep_shortening_overrides_and_sibling_identity() {
    let (mut input, mut packages) = fixture();
    let reference = package("finite-current", 1);
    let mut executable = entry();
    executable.configuration = json!({"type":"object","additionalProperties":false}).into();
    executable.exports = BTreeMap::from([(
        "App".into(),
        Export {
            contract: contract(),
            availability: Availability::Required,
        },
    )]);
    executable.imports.insert(
        "base".into(),
        Import {
            contract: contract(),
            cardinality: Cardinality::Optional,
        },
    );
    let mut child = node(10, reference.clone(), PackageUse::Composition);
    child.bindings.insert(
        "base".into(),
        vec![Target::Import {
            name: "base".into(),
        }],
    );
    child.package = PackageSelection::Current;
    packages
        .insert(
            reference.clone(),
            Declaration {
                entries: BTreeMap::from([(EntryTarget::Tui, executable)]),
                composition: Some(Template {
                    parameters: BTreeMap::new(),
                    imports: BTreeMap::from([(
                        "base".into(),
                        Import {
                            contract: contract(),
                            cardinality: Cardinality::Optional,
                        },
                    )]),
                    exports: BTreeMap::from([("App".into(), local(&["next"], "App"))]),
                    children: BTreeMap::from([("next".into(), child)]),
                }),
            },
        )
        .unwrap();
    for root in input.instances.values_mut() {
        root.package = reference.clone().into();
        root.overrides = vec![Override {
            path: vec!["next".into(); 140],
            use_package: Some(PackageUse::Entry),
            ..Override::default()
        }];
    }
    input
        .instances
        .get_mut("a")
        .unwrap()
        .bindings
        .insert("base".into(), vec![local(&["b"], "App")]);
    let plan = Plan::prepare(&input, &packages, &RemoteExports::new()).unwrap();
    assert_eq!(plan.instances().len(), 282);
    for (alias, source) in [("a", 1), ("b", 2)] {
        let mut path = vec![alias];
        path.extend(std::iter::repeat_n("next", 140));
        let terminal = instance(&plan, &path);
        let mut identity = vec![Uuid::from_u128(source)];
        identity.extend(std::iter::repeat_n(Uuid::from_u128(10), 140));
        assert_eq!(terminal.identity, InstanceId(identity));
        assert_eq!(terminal.package, reference);
        assert_eq!(terminal.configuration, json!({}));
        assert!(terminal.entry.is_some());
        if alias == "a" {
            let mut provider = vec![Uuid::from_u128(2)];
            provider.extend(std::iter::repeat_n(Uuid::from_u128(10), 140));
            assert_eq!(
                terminal.bindings["base"][0].provider,
                Provider::Local {
                    instance: InstanceId(provider),
                    export: "App".into(),
                }
            );
        } else {
            assert_eq!(terminal.bindings["base"].len(), 0);
        }
    }
    let mut selected = vec![Uuid::from_u128(1)];
    selected.extend(std::iter::repeat_n(Uuid::from_u128(10), 140));
    assert_eq!(
        plan.launch().unwrap().provider,
        Provider::Local {
            instance: InstanceId(selected),
            export: "App".into(),
        }
    );
    input.instances.get_mut("a").unwrap().overrides.clear();
    assert!(
        Plan::prepare(&input, &packages, &RemoteExports::new())
            .unwrap_err()
            .to_string()
            .contains("cyclic composition expansion")
    );
}

#[test]
fn k64_large_declared_bindings_expand_from_overrides_without_platform_cardinality() {
    let (mut input, mut packages) = fixture();
    let mut consumer = entry();
    consumer.configuration = json!({"type":"object","additionalProperties":false}).into();
    consumer.imports.insert(
        "all".into(),
        Import {
            contract: contract(),
            cardinality: Cardinality::Many {
                min: 4097,
                max: 4097,
            },
        },
    );
    packages
        .insert(
            package("collector", 1),
            Declaration {
                entries: BTreeMap::from([(EntryTarget::Tui, consumer.clone())]),
                composition: None,
            },
        )
        .unwrap();
    consumer.imports.clear();
    let provider_export = "Content_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_";
    let exported = consumer.exports.remove("Content").unwrap();
    consumer.exports.insert(provider_export.into(), exported);
    packages
        .insert(
            package("provider", 1),
            Declaration {
                entries: BTreeMap::from([(EntryTarget::Tui, consumer)]),
                composition: None,
            },
        )
        .unwrap();
    let mut children = BTreeMap::from([(
        "collector".into(),
        node(1, package("collector", 1), PackageUse::Entry),
    )]);
    let mut targets = Vec::new();
    for index in 0..4097 {
        let alias = format!("provider-{index:04}");
        children.insert(
            alias.clone(),
            node(index + 2, package("provider", 1), PackageUse::Entry),
        );
        targets.push(Target::Instance { path: vec![alias], export: "Content_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_".into() });
    }
    packages
        .insert(
            package("large-composition", 1),
            Declaration {
                entries: BTreeMap::new(),
                composition: Some(Template {
                    parameters: BTreeMap::new(),
                    imports: BTreeMap::new(),
                    exports: BTreeMap::new(),
                    children,
                }),
            },
        )
        .unwrap();
    let mut root = node(1, package("large-composition", 1), PackageUse::Composition);
    root.overrides.push(Override {
        path: vec!["collector".into()],
        bindings: BTreeMap::from([("all".into(), targets)]),
        ..Override::default()
    });
    input.instances = BTreeMap::from([("root".into(), root)]);
    input.launch = None;
    let plan = Plan::prepare(&input, &packages, &RemoteExports::new()).unwrap();
    assert_eq!(plan.instances().len(), 4099);
    let bindings = &instance(&plan, &["root", "collector"]).bindings["all"];
    assert_eq!(bindings.len(), 4097);
    assert_eq!(bindings[0].provider, Provider::Local {
        instance: InstanceId(vec![Uuid::from_u128(1), Uuid::from_u128(2)]), export: "Content_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_".into(),
    });
    assert_eq!(bindings[4096].provider, Provider::Local {
        instance: InstanceId(vec![Uuid::from_u128(1), Uuid::from_u128(4098)]), export: "Content_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_catalogue_".into(),
    });
}

#[test]
fn k64_deep_dependency_graph_accepts_acyclic_edges_and_rejects_a_back_edge() {
    let declaration = Arc::new(Export {
        contract: contract(),
        availability: Availability::Required,
    });
    let mut instances = BTreeMap::new();
    for source in 1..=4097 {
        let identity = InstanceId(vec![Uuid::from_u128(source)]);
        let bindings = if source < 4097 {
            BTreeMap::from([(
                "next".into(),
                vec![Binding {
                    provider: Provider::Local {
                        instance: InstanceId(vec![Uuid::from_u128(source + 1)]),
                        export: "Content".into(),
                    },
                    declaration: declaration.clone(),
                }],
            )])
        } else {
            BTreeMap::new()
        };
        instances.insert(
            identity.clone(),
            Instance {
                identity,
                path: vec![format!("node-{source}")],
                parent: None,
                package: package("provider", 1),
                disabled: false,
                configuration: json!({}),
                entry: None,
                bindings,
                exports: BTreeMap::new(),
            },
        );
    }
    validate_dependencies(&instances).unwrap();
    let terminal = instances
        .get_mut(&InstanceId(vec![Uuid::from_u128(4097)]))
        .unwrap();
    terminal.bindings.insert(
        "back".into(),
        vec![Binding {
            provider: Provider::Local {
                instance: InstanceId(vec![Uuid::from_u128(1)]),
                export: "Content".into(),
            },
            declaration,
        }],
    );
    assert!(
        validate_dependencies(&instances)
            .unwrap_err()
            .to_string()
            .contains("cyclic capability dependency")
    );
}

#[test]
fn k64_recovery_namespace_preserves_deep_identity_and_rejects_invalid_uuid_sources() {
    use crate::operation::{RecoveryContract, RecoveryProtocol, RecoveryRef};
    let mut reference = RecoveryRef {
        source: crate::deployment::DeploymentRef {
            state_domain: "a".repeat(64),
            deployment: Uuid::from_u128(1),
            revision: 1,
        },
        namespace: InstanceId((1..=65).map(Uuid::from_u128).collect()),
        export: "service".into(),
        method: "change".into(),
        operation: Uuid::from_u128(2),
        fingerprint: format!("sha256-{}", "a".repeat(64)),
        contract: RecoveryContract {
            name: "example.Change".into(),
            version: 1,
            transport: Transport::Local,
            digest: format!("sha256-{}", "b".repeat(64)),
        },
        recovery: RecoveryProtocol::JournalV1,
    };
    reference.validate().unwrap();
    let encoded = serde_json::to_value(&reference).unwrap();
    assert_eq!(encoded["namespace"].as_array().unwrap().len(), 65);
    assert_eq!(
        serde_json::from_value::<RecoveryRef>(encoded).unwrap(),
        reference
    );
    reference.namespace.0[64] = Uuid::nil();
    assert!(reference.validate().is_err());
    reference.namespace.0.clear();
    assert!(reference.validate().is_err());
    reference.namespace.0.push(Uuid::from_u128(1));
    reference.operation = Uuid::nil();
    assert!(reference.validate().is_err());
}

#[test]
fn forwarding_rejects_a_real_import_export_cycle() {
    let (mut input, mut packages) = fixture();
    packages
        .insert(
            package("forwarding-cycle", 1),
            Declaration {
                entries: BTreeMap::new(),
                composition: Some(Template {
                    parameters: BTreeMap::new(),
                    imports: BTreeMap::from([(
                        "base".into(),
                        Import {
                            contract: contract(),
                            cardinality: Cardinality::One,
                        },
                    )]),
                    exports: BTreeMap::from([(
                        "App".into(),
                        Target::Import {
                            name: "base".into(),
                        },
                    )]),
                    children: BTreeMap::new(),
                }),
            },
        )
        .unwrap();
    input.instances.remove("b");
    let root = input.instances.get_mut("a").unwrap();
    root.package = package("forwarding-cycle", 1).into();
    root.bindings
        .insert("base".into(), vec![local(&["a"], "App")]);
    assert!(
        Plan::prepare(&input, &packages, &RemoteExports::new())
            .unwrap_err()
            .to_string()
            .contains("cyclic import forwarding")
    );
}
