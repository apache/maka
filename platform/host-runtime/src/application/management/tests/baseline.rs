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

fn package(id: &str, application: Value) -> Package {
    Package::new(BTreeMap::from([(
        MANIFEST_FILE.into(),
        serde_json::to_vec(&json!({
            "schemaVersion":1, "id":id, "application":application,
        }))
        .unwrap(),
    )]))
    .unwrap()
}
fn node(package: &Package, key: u128, values: Value) -> Value {
    json!({"key":Uuid::from_u128(key),"package":{"source":"pinned","package":package.application_ref()},
        "usePackage":"host","configuration":{"values":values}})
}
async fn revision(f: &Fixture) -> u64 {
    f.manager
        .metadata()
        .await
        .unwrap()
        .source
        .reference
        .revision
}
async fn loaded(f: &Fixture) -> maka_event_log::applications::LoadedDeployment {
    f.store
        .load_application(f.source.deployment)
        .await
        .unwrap()
        .unwrap()
}

async fn configure_batch_fixture() -> Fixture {
    let f = Fixture::new().await;
    let leaf = package(
        "example.batch",
        json!({"host":{
            "implementation":{"kind":"native","implementation":"example.unused"},
            "configuration":{"type":"object","properties":{
                "enabled":{"type":"boolean"},"label":{"type":"string"}
            },"required":["enabled","label"],"additionalProperties":false},
            "imports":{},"exports":{}
        }}),
    );
    let input = serde_json::from_value(json!({"instances":{
        "worker":node(&leaf, 1, json!({"enabled":true,"label":"worker"})),
        "coordinator":node(&leaf, 2, json!({"enabled":true,"label":"coordinator"}))
    }}))
    .unwrap();
    f.store
        .commit_application(f.source.deployment, 1, input, vec![], vec![leaf])
        .await
        .unwrap();
    f
}

#[tokio::test]
async fn configure_batch_commits_one_revision_and_rejects_stale_writes() {
    let f = configure_batch_fixture().await;
    let before = loaded(&f).await;
    let source = &before.source().reference;
    let request = json!({"expectedRevision":source.revision,"edits":[
        {"instance":InstanceId(vec![Uuid::from_u128(1)]),"changes":[
            {"path":["enabled"],"value":{"kind":"boolean","value":false}}
        ]},
        {"instance":InstanceId(vec![Uuid::from_u128(2)]),"changes":[
            {"path":["enabled"],"value":{"kind":"boolean","value":false}}
        ]}
    ]});
    let Interface::Service { methods } = deployment_manager_contract().interface else {
        unreachable!()
    };
    let method = &methods["configureBatch"];
    assert_eq!(method.mode, MethodMode::Mutation);
    jsonschema::validator_for(&method.input)
        .unwrap()
        .validate(&request)
        .unwrap();
    let result = f
        .manager
        .call(
            "configureBatch".into(),
            request.clone(),
            context(Attachments::new()),
        )
        .await
        .unwrap();
    let HandlerValue::Json(result) = result else {
        panic!("configureBatch must return JSON")
    };
    jsonschema::validator_for(&method.output)
        .unwrap()
        .validate(&result)
        .unwrap();
    let mut expected = source.clone();
    expected.revision += 1;
    assert_eq!(result, json!({"status":"committed","value":expected}));
    let committed = loaded(&f).await;
    assert_eq!(committed.source().reference, expected);
    for (key, label) in [(1, "worker"), (2, "coordinator")] {
        assert_eq!(
            committed.plan().instances()[&InstanceId(vec![Uuid::from_u128(key)])].configuration,
            json!({"enabled":false,"label":label})
        );
    }
    let mut stale = request;
    for edit in stale["edits"].as_array_mut().unwrap() {
        edit["changes"][0]["value"]["value"] = json!(true);
    }
    let conflict = f.manager.configure_batch(stale).await.unwrap();
    assert_eq!(
        conflict,
        json!({"status":"conflict","currentRevision":expected.revision})
    );
    let unchanged = loaded(&f).await;
    assert_eq!(unchanged.source().reference, committed.source().reference);
    assert_eq!(unchanged.source().input, committed.source().input);
    let frozen = f.store.load_application_at(source).await.unwrap().unwrap();
    for key in [1, 2] {
        assert_eq!(
            frozen.plan().instances()[&InstanceId(vec![Uuid::from_u128(key)])].configuration["enabled"],
            json!(true)
        );
    }
    f.store.drain().await;
}

#[tokio::test]
async fn configure_batch_rejects_invalid_edits_without_partial_commits() {
    let f = configure_batch_fixture().await;
    let before = loaded(&f).await;
    let first = json!({"instance":InstanceId(vec![Uuid::from_u128(1)]),"changes":[
        {"path":["enabled"],"value":{"kind":"boolean","value":false}}
    ]});
    let second =
        |changes: Value| json!({"instance":InstanceId(vec![Uuid::from_u128(2)]),"changes":changes});
    for (edits, reason) in [
        (json!([]), "invalid_source"),
        (json!([first, first]), "invalid_source"),
        (json!([first, second(json!([]))]), "invalid_source"),
        (
            json!([
                first,
                second(json!([
                    {"path":["enabled","nested"],"value":{"kind":"boolean","value":false}}
                ]))
            ]),
            "invalid_source",
        ),
        (
            json!([
                first,
                second(json!([
                    {"path":["enabled"],"value":{"kind":"text","text":"not boolean"}}
                ]))
            ]),
            "invalid_source",
        ),
        (
            json!([first, {"instance":InstanceId(vec![Uuid::from_u128(404)]),"changes":[
                {"path":["enabled"],"value":{"kind":"boolean","value":false}}
            ]}]),
            "instance_unavailable",
        ),
    ] {
        let result = f
            .manager
            .configure_batch(
                json!({"expectedRevision":before.source().reference.revision,"edits":edits}),
            )
            .await
            .unwrap();
        assert_eq!(result["status"], "rejected", "{edits}");
        assert_eq!(result["reason"], reason, "{edits}");
        let current = loaded(&f).await;
        assert_eq!(
            current.source().reference,
            before.source().reference,
            "{edits}"
        );
        assert_eq!(current.source().input, before.source().input, "{edits}");
        for key in [1, 2] {
            assert_eq!(
                current.plan().instances()[&InstanceId(vec![Uuid::from_u128(key)])].configuration["enabled"],
                json!(true),
                "{edits}"
            );
        }
    }
    f.store.drain().await;
}

#[tokio::test]
async fn configure_batch_records_exact_inherited_fields_and_survives_a_baseline_upgrade() {
    let f = Fixture::new().await;
    let leaf = package(
        "example.settings",
        json!({"host":{
            "implementation":{"kind":"native","implementation":"example.unused"},
            "configuration":{"type":"object","properties":{
                "agent":{"type":"object","properties":{
                    "goals":{"type":"boolean"},"tools":{"type":"array","items":{"type":"string"}},
                    "label":{"type":["string","null"]},"obsolete":{"type":"boolean"}
                },"required":["goals","tools"],"additionalProperties":false},
                "items":{"type":"array","items":{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}},
                "extra":{"type":"object"}
            },"required":["agent","items"],"additionalProperties":false},"imports":{},"exports":{}
        }}),
    );
    let baseline = |tools: Value| {
        let mut child = node(
            &leaf,
            99,
            json!({"items":[{"title":"first"},{"title":"second"}]}),
        );
        if tools == json!(["new-default"]) {
            child["configuration"]["values"]["extra"] = json!({"newDefault":true});
        }
        child["configuration"]["parameters"] = json!({"agent":"agent"});
        let mut coordinator = child.clone();
        coordinator["key"] = json!(Uuid::from_u128(100));
        package(
            "example.baseline",
            json!({"composition":{
                "parameters":{"agent":{"schema":{"type":"object"},"default":{
                    "goals":true,"tools":tools,"label":"default","obsolete":true
                }}},"children":{"settings":child,"coordinator":coordinator}
            }}),
        )
    };
    let first = baseline(json!(["old-default"]));
    let next = baseline(json!(["new-default"]));
    let source = f
        .store
        .commit_application(
            f.source.deployment,
            1,
            serde_json::from_value(json!({
                "base":{"package":first.application_ref()},"instances":{}
            }))
            .unwrap(),
            vec![],
            vec![leaf, first, next.clone()],
        )
        .await
        .unwrap();
    let id = InstanceId(vec![Uuid::from_u128(99)]);
    let coordinator = InstanceId(vec![Uuid::from_u128(100)]);
    let result = f
        .manager
        .configure_batch(
            json!({"expectedRevision":source.revision,"edits":[{"instance":id,"changes":[
                {"path":["agent","goals"],"value":{"kind":"boolean","value":false}},
                {"path":["agent","label"],"value":{"kind":"null"}},
                {"path":["agent","obsolete"]},
                {"path":["items","0","title"],"value":{"kind":"text","text":"selected"}},
                {"path":["extra","path"],"value":{"kind":"text","text":"created"}}
            ]},{"instance":coordinator,"changes":[
                {"path":["agent","goals"],"value":{"kind":"boolean","value":false}}
            ]}]}),
        )
        .await
        .unwrap();
    assert_eq!(result["status"], "committed");
    let current = loaded(&f).await;
    assert!(current.source().input.instances.is_empty());
    let base = current.source().input.base.as_ref().unwrap();
    assert!(base.parameters.is_empty());
    assert_eq!(base.overrides.len(), 2);
    assert_eq!(base.overrides[0].path, vec!["settings"]);
    assert_eq!(base.overrides[1].path, vec!["coordinator"]);
    assert!(base.overrides[0].configuration.is_empty());
    assert_eq!(
        base.overrides[1].configuration_fields,
        vec![maka_plugin_core::composition::ConfigurationField {
            path: vec!["agent".into(), "goals".into()],
            value: Some(json!(false)),
        }]
    );
    assert_eq!(current.source().reference.revision, source.revision + 1);
    assert_eq!(
        current.plan().instances()[&coordinator].configuration["agent"],
        json!({"goals":false,"tools":["old-default"],"label":"default","obsolete":true})
    );
    let fields = &base.overrides[0].configuration_fields;
    assert_eq!(
        fields
            .iter()
            .map(|field| field.path.clone())
            .collect::<Vec<_>>(),
        vec![
            vec!["agent".to_string(), "goals".into()],
            vec!["agent".into(), "label".into()],
            vec!["agent".into(), "obsolete".into()],
            vec!["extra".into(), "path".into()],
            vec!["items".into()],
        ]
    );
    assert_eq!(
        current.plan().instances()[&id].configuration,
        json!({
            "agent":{"goals":false,"tools":["old-default"],"label":null},
            "items":[{"title":"selected"},{"title":"second"}],"extra":{"path":"created"}
        })
    );
    let read = f
        .manager
        .read_settings(json!({"source":current.source().reference,"instance":id,"path":["agent"]}))
        .await
        .unwrap();
    assert_eq!(
        read["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|field| field["key"] == "goals")
            .unwrap()["value"],
        json!({"kind":"boolean","value":false})
    );
    let mut upgrade = current.source().input.clone();
    upgrade.base.as_mut().unwrap().package = next.application_ref();
    f.store
        .commit_application(
            f.source.deployment,
            current.source().reference.revision,
            upgrade,
            vec![],
            current.packages().to_vec(),
        )
        .await
        .unwrap();
    let upgraded = loaded(&f).await;
    assert_eq!(
        upgraded.plan().instances()[&id].configuration,
        json!({
            "agent":{"goals":false,"tools":["new-default"],"label":null},
            "items":[{"title":"selected"},{"title":"second"}],"extra":{"path":"created","newDefault":true}
        })
    );
    assert_eq!(
        upgraded.plan().instances()[&coordinator].configuration["agent"],
        json!({"goals":false,"tools":["new-default"],"label":"default","obsolete":true})
    );
    assert_eq!(upgraded.plan().instances()[&id].parent, None);
    let before = upgraded.source().reference.clone();
    let invalid = f
        .manager
        .configure(json!({"expectedRevision":before.revision,"instance":id,
        "changes":[{"path":["agent","goals"],"value":{"kind":"text","text":"not boolean"}}]}))
        .await
        .unwrap();
    assert_eq!(invalid["status"], "rejected");
    assert_eq!(loaded(&f).await.source().reference, before);
    let stale = f
        .manager
        .configure(json!({"expectedRevision":source.revision,"instance":id,
        "changes":[{"path":["agent","goals"],"value":{"kind":"boolean","value":true}}]}))
        .await
        .unwrap();
    assert_eq!(stale["status"], "conflict");
    let original = f
        .manager
        .read_settings(json!({"source":source,"instance":id,"path":["agent"]}))
        .await
        .unwrap();
    assert_eq!(
        original["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|field| field["key"] == "goals")
            .unwrap()["value"],
        json!({"kind":"boolean","value":true})
    );
    f.store.drain().await;
}

#[tokio::test]
async fn inherited_structure_enable_parameters_bindings_and_removals_write_only_user_intent() {
    let f = Fixture::new().await;
    let contract = json!({"name":"example.Content","version":1,"transport":"local",
        "interface":{"kind":"value","schema":{"type":"string"}}});
    let leaf = package(
        "example.component",
        json!({"host":{
            "implementation":{"kind":"native","implementation":"example.unused"},
            "configuration":{"type":"object","properties":{"label":{"type":"string","default":"default"}},"required":["label"]},
            "imports":{"content":{"contract":contract,"cardinality":{"kind":"optional"}}},
            "exports":{"Content":{"contract":contract,"availability":"required"}}
        }}),
    );
    let mut nested_child = node(&leaf, 102, json!({}));
    nested_child["configuration"]["parameters"] = json!({"label":"label"});
    let nested = package(
        "example.group",
        json!({"composition":{
            "parameters":{"label":{"schema":{"type":"string"},"default":"inherited"}},
            "children":{"child":nested_child}
        }}),
    );
    let mut consumer = node(&leaf, 101, json!({"label":"consumer"}));
    consumer["bindings"] =
        json!({"content":[{"kind":"instance","path":["provider"],"export":"Content"}]});
    let baseline = package(
        "example.graph",
        json!({"composition":{"children":{
            "provider":node(&leaf,100,json!({"label":"provider"})),"consumer":consumer,
            "group":{"key":Uuid::from_u128(103),"package":{"source":"pinned","package":nested.application_ref()},"usePackage":"composition"}
        }}}),
    );
    f.store
        .commit_application(
            f.source.deployment,
            1,
            serde_json::from_value(json!({
                "base":{"package":baseline.application_ref()},"instances":{}
            }))
            .unwrap(),
            vec![],
            vec![leaf.clone(), nested, baseline],
        )
        .await
        .unwrap();
    let candidates = f
        .manager
        .binding_candidates(
            &maka_sandbox::Sandbox::Disabled,
            json!({"consumer":{"kind":"root","name":"consumer"},
        "import":"content","includePackages":false}),
        )
        .await
        .unwrap();
    assert_eq!(
        candidates["current"],
        json!([{"kind":"instance","path":["provider"],"export":"Content"}])
    );
    assert_eq!(candidates["configuration"], json!({"label":"consumer"}));
    assert!(
        candidates["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .any(|candidate| candidate["target"]
                == json!({"kind":"instance","path":["provider"],"export":"Content"}))
    );
    let revision_before = revision(&f).await;
    let duplicate = f.manager.edit_composition(json!({"expectedRevision":revision_before,"edits":[{
        "kind":"insert","name":"provider","package":leaf.application_ref(),"usePackage":"host","settings":[],"bindings":{}
    }]})).await.unwrap();
    assert_eq!(duplicate["status"], "rejected");
    assert_eq!(revision(&f).await, revision_before);
    let group = InstanceId(vec![Uuid::from_u128(103)]);
    let child = InstanceId(vec![Uuid::from_u128(103), Uuid::from_u128(102)]);
    let disabled = f
        .manager
        .set_enabled(
            json!({"expectedRevision":revision(&f).await,"instance":group,"enabled":false}),
        )
        .await
        .unwrap();
    assert_eq!(disabled["status"], "committed");
    let blocked = f
        .manager
        .set_enabled(json!({"expectedRevision":revision(&f).await,"instance":child,"enabled":true}))
        .await
        .unwrap();
    assert_eq!(blocked["status"], "rejected");
    let enabled = f
        .manager
        .set_enabled(json!({"expectedRevision":revision(&f).await,"instance":group,"enabled":true}))
        .await
        .unwrap();
    assert_eq!(enabled["status"], "committed");
    let changed = f.manager.edit_composition(json!({"expectedRevision":revision(&f).await,"edits":[
        {"kind":"update","name":"group","configuration":{"label":"chosen"},"bindings":{}},
        {"kind":"update","name":"consumer","configuration":{"label":"chosen consumer"},"bindings":{}}
    ]})).await.unwrap();
    assert_eq!(changed["status"], "committed");
    let current = loaded(&f).await;
    assert!(current.source().input.instances.is_empty());
    assert_eq!(
        current.plan().instances()[&child].configuration,
        json!({"label":"chosen"})
    );
    assert_eq!(
        current.plan().instances()[&InstanceId(vec![Uuid::from_u128(101)])].configuration,
        json!({"label":"chosen consumer"})
    );
    let bad_remove = f
        .manager
        .edit_composition(json!({"expectedRevision":revision(&f).await,
        "edits":[{"kind":"remove","name":"provider"}]}))
        .await
        .unwrap();
    assert_eq!(bad_remove["status"], "rejected");
    assert_eq!(
        loaded(&f).await.source().reference,
        current.source().reference
    );
    let removed = f
        .manager
        .edit_composition(json!({"expectedRevision":revision(&f).await,"edits":[
            {"kind":"update","name":"consumer","configuration":{},"bindings":{"content":[]}},
            {"kind":"remove","name":"provider"}
        ]}))
        .await
        .unwrap();
    assert_eq!(removed["status"], "committed");
    let removed_state = loaded(&f).await;
    assert!(
        !removed_state
            .plan()
            .instances()
            .contains_key(&InstanceId(vec![Uuid::from_u128(100)]))
    );
    assert!(
        removed_state
            .source()
            .input
            .base
            .as_ref()
            .unwrap()
            .overrides
            .iter()
            .any(|patch| patch.path == ["provider"] && patch.remove)
    );
    let inserted = f.manager.edit_composition(json!({"expectedRevision":revision(&f).await,"edits":[{
        "kind":"insert","name":"provider","package":leaf.application_ref(),"usePackage":"host","settings":[],"bindings":{}
    }]})).await.unwrap();
    assert_eq!(inserted["status"], "committed");
    let independent = loaded(&f).await;
    let key = independent.source().input.instances["provider"].key;
    assert_ne!(key, Uuid::from_u128(100));
    assert_eq!(
        independent.plan().instances()[&InstanceId(vec![key])].configuration,
        json!({"label":"default"})
    );
    let removed = f
        .manager
        .edit_composition(json!({"expectedRevision":revision(&f).await,
        "edits":[{"kind":"remove","name":"provider"}]}))
        .await
        .unwrap();
    assert_eq!(removed["status"], "committed");
    let final_state = loaded(&f).await;
    assert!(
        !final_state
            .plan()
            .instances()
            .values()
            .any(|node| node.path == ["provider"])
    );
    assert!(final_state.source().input.instances.is_empty());
    let failed_batch = f.manager.edit_composition(json!({"expectedRevision":revision(&f).await,"edits":[
        {"kind":"insert","name":"temporary","package":leaf.application_ref(),"usePackage":"host","settings":[],"bindings":{}},
        {"kind":"update","name":"missing","configuration":{},"bindings":{}}
    ]})).await.unwrap();
    assert_eq!(failed_batch["status"], "rejected");
    assert_eq!(
        loaded(&f).await.source().reference,
        final_state.source().reference
    );
    f.store.drain().await;
}
