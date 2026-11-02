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
use crate::tests::{preferences, scope, source, write};
use serde_json::json;

async fn search(library: &Library, scope: &Scope, tools: Value) -> Value {
    library
        .model(
            "search",
            json!({"tools":tools,"input":{"query":"Reference","limit":8}}),
            scope,
        )
        .await
        .unwrap()
}
async fn load(
    library: &Library,
    scope: &Scope,
    tools: Value,
    revision: &Value,
    name: &str,
    resource: Value,
) -> Value {
    library
        .model(
            "load",
            json!({"tools":tools,"input":{"name":name,"revision":revision,"resource":resource}}),
            scope,
        )
        .await
        .unwrap()
}
async fn resource_text(library: &Library, call: &Scope, tools: Value, mut page: Value) -> String {
    schema("load", &page);
    let mut text = String::new();
    loop {
        assert_eq!(page["kind"], "resource");
        assert!(maka_workspace_support::fits(&page));
        text.push_str(page["content"].as_str().unwrap());
        if page["next"].is_null() {
            return text;
        }
        let resource: maka_agent_facts::read::ReadInput =
            serde_json::from_value(page["next"]["resource"].clone()).unwrap();
        let next: usize = resource
            .path
            .split("?at=")
            .nth(1)
            .unwrap()
            .split('&')
            .next()
            .unwrap()
            .parse()
            .unwrap();
        if next > text.encode_utf16().count() {
            text.push('\n');
        }
        page = library
            .model("load", json!({"tools":tools,"input":page["next"]}), call)
            .await
            .unwrap();
    }
}

fn schema(method: &str, value: &Value) {
    let projection = maka_agent_facts::tool_output::DurableToolProjection::Json {
        value: value.clone(),
    };
    assert!(
        maka_agent_facts::archive::ArchivedPlaceholder::prepare(
            "event".into(),
            "call".into(),
            "Skill".into(),
            &projection
        )
        .unwrap()
        .is_none(),
        "skill result must remain directly visible to the model"
    );
    let maka_plugin_core::contract::Interface::Service { methods } = contract().interface else {
        panic!()
    };
    assert!(
        jsonschema::validator_for(&methods[method].output)
            .unwrap()
            .is_valid(value),
        "invalid {method} response {value}"
    );
}
#[tokio::test]
async fn model_eligibility_and_preferences_apply_to_the_effective_named_skill() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a");
    let b = dir.path().join("b");
    for name in [
        "disabled", "review", "pinned", "alias", "network", "invalid",
    ] {
        write(&a, name, "instructions");
    }
    write(&b, "review", "shadowed instructions");
    std::fs::write(a.join("review/SKILL.md"), "---\nname: review\ndescription: Reference for review\nrequired-tools: Read\nallowed-tools: Superuser\n---\noriginal review").unwrap();
    std::fs::write(
        a.join("alias/SKILL.md"),
        "---\nname: disabled\ndescription: Reference for alias\n---\nwrong identity",
    )
    .unwrap();
    std::fs::write(
        a.join("network/SKILL.md"),
        "---\nname: network\ndescription: network\nrequired-capabilities: network\n---\nnetwork",
    )
    .unwrap();
    std::fs::write(a.join("invalid/SKILL.md"), "invalid").unwrap();
    let library = Library::open(
        Configuration {
            home: None,
            project_roots: vec![],
            bundled: false,
            manage: false,
            preferences: true,
            sources: vec![source("a", &a), source("b", &b)],
        },
        dir.path().join("private"),
        preferences(dir.path()).await,
    )
    .unwrap();
    let call = scope();
    for (revision, name, preference) in [
        (
            0,
            "alias",
            maka_skills::Preference {
                enabled: false,
                pinned: false,
            },
        ),
        (
            1,
            "pinned",
            maka_skills::Preference {
                enabled: true,
                pinned: true,
            },
        ),
    ] {
        assert!(matches!(
            library
                .preferences
                .set(
                    SetPreference {
                        reference: format!("source:a:{name}"),
                        revision,
                        preference
                    },
                    &call
                )
                .await
                .unwrap(),
            PreferenceResult::Applied { .. }
        ));
    }
    let result = search(&library, &call, json!(["Read"])).await;
    schema("search", &result);
    assert_eq!(result["totalEligible"], 2);
    assert_eq!(result["matches"][0]["ref"], "source:a:pinned");
    let revision = &result["revision"];
    let prepared = library
        .model(
            "prepare",
            json!({"tools":["Read"], "input": {
                "language":"en","message":"/skill:review /skill:disabled /skill:network", "loadTool":"Read"
            }}),
            &call,
        )
        .await
        .unwrap();
    schema("prepare", &prepared);
    assert_eq!(prepared["kind"], "ready");
    assert_eq!(prepared["record"]["revision"], *revision);
    assert!(
        prepared["text"]
            .as_str()
            .unwrap()
            .contains("original review")
    );
    assert_eq!(prepared["requiredTools"], json!(["Read"]));
    assert_eq!(
        prepared["record"]["invocation"]["loaded"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        prepared["record"]["invocation"]["failed"][0]["reason"],
        "disabled"
    );
    assert_eq!(
        prepared["record"]["invocation"]["failed"][1]["reason"],
        "host_incompatible"
    );
    let prompt = prepared["record"]["metadataPrompt"].as_str().unwrap();
    assert!(prompt.contains("source:a:pinned"));
    assert!(!prompt.contains("source:a:disabled"));
    assert!(!prompt.contains("source:a:alias"));
    assert!(!prompt.contains("source:a:network"));
    assert!(!prompt.contains("fresh search"));
    let ordinary = library
        .model(
            "prepare",
            json!({"tools":["Read"], "input":{
                "language":"en","message":"review this change", "loadTool":"Read"
            }}),
            &call,
        )
        .await
        .unwrap();
    assert!(
        ordinary["text"].is_null(),
        "ordinary input is preserved exactly"
    );
    assert_eq!(ordinary["record"]["metadataPrompt"], prompt);
    assert_eq!(ordinary["record"]["invocation"]["receipts"], json!([]));
    assert!(
        library
            .model(
                "prepare",
                json!({"tools":[], "input": {"language":"en","message":"hello", "loadTool":"Read"}}),
                &call
            )
            .await
            .is_err()
    );
    let blocked = library
        .model(
            "prepare",
            json!({"tools":[], "input":{"language":"en","message":"/skill:review"}}),
            &call,
        )
        .await
        .unwrap();
    assert_eq!(blocked["kind"], "blocked");
    assert_eq!(
        blocked["invocation"]["failed"][0]["reason"],
        "host_incompatible"
    );
    for (name, reason) in [
        ("disabled", "disabled"),
        ("source:b:review", "not_found"),
        ("invalid", "not_found"),
        ("network", "host_incompatible"),
    ] {
        let value = load(
            &library,
            &call,
            json!(["Read"]),
            revision,
            name,
            Value::Null,
        )
        .await;
        assert_eq!(value["kind"], "unavailable");
        assert_eq!(value["reason"], reason);
        schema("load", &value);
    }
    let loaded = load(
        &library,
        &call,
        json!(["Read"]),
        revision,
        "review",
        Value::Null,
    )
    .await;
    schema("load", &loaded);
    assert_eq!(loaded["instructions"], "original review");
    assert_eq!(loaded["declaredTools"], json!(["Superuser"]));
    assert_eq!(
        loaded["relativePath"],
        json!(std::path::Path::new("review").join("SKILL.md"))
    );
    assert_eq!(loaded["receipt"]["ref"], "source:a:review");
    let absent = search(&library, &call, json!([])).await;
    assert_eq!(absent["totalEligible"], 1);
    assert_eq!(
        load(
            &library,
            &call,
            json!([]),
            &absent["revision"],
            "review",
            Value::Null
        )
        .await["reason"],
        "host_incompatible"
    );
    assert_eq!(
        load(&library, &call, json!([]), revision, "review", Value::Null).await["kind"],
        "changed"
    );
    assert!(matches!(
        library
            .preferences
            .set(
                SetPreference {
                    reference: "source:a:review".into(),
                    revision: 2,
                    preference: maka_skills::Preference {
                        enabled: false,
                        pinned: false
                    },
                },
                &call
            )
            .await
            .unwrap(),
        PreferenceResult::Applied { .. }
    ));
    assert_eq!(
        load(
            &library,
            &call,
            json!(["Read"]),
            revision,
            "review",
            Value::Null
        )
        .await["kind"],
        "changed"
    );
    let fresh = search(&library, &call, json!(["Read"])).await;
    assert_eq!(
        load(
            &library,
            &call,
            json!(["Read"]),
            &fresh["revision"],
            "review",
            Value::Null
        )
        .await["reason"],
        "disabled"
    );
    call.finish().await.unwrap();
}
#[tokio::test]
async fn model_resources_keep_original_root_and_revision_and_do_not_mix_changed_captures() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("selected");
    write(&root, "review", "instructions");
    write(&root, "other", "other");
    std::fs::create_dir_all(root.join("review/references")).unwrap();
    let text = "Unicode 资源 🦀 and a line\n".repeat(1000);
    let path = root.join("review/references/guide.txt");
    std::fs::write(&path, &text).unwrap();
    let outside = dir.path().join("secret");
    std::fs::write(&outside, "never accessible").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, root.join("review/escape")).unwrap();
    let library = Library::open(
        Configuration {
            home: None,
            project_roots: vec![],
            bundled: false,
            manage: false,
            preferences: false,
            sources: vec![source("local", &root)],
        },
        dir.path().join("private"),
        preferences(dir.path()).await,
    )
    .unwrap();
    let call = scope();
    let tools = json!(["SkillSearch", "Skill"]);
    let catalog = search(&library, &call, tools.clone()).await;
    let revision = &catalog["revision"];
    let page = load(
        &library,
        &call,
        tools.clone(),
        revision,
        "review",
        json!({"path":"references/guide.txt"}),
    )
    .await;
    let next = page["next"].clone();
    let all = resource_text(&library, &call, tools.clone(), page).await;
    assert_eq!(all, text);
    for path in ["../secret", "/secret", "escape"] {
        assert_eq!(
            load(
                &library,
                &call,
                tools.clone(),
                revision,
                "review",
                json!({"path":path})
            )
            .await["kind"],
            "resource_unavailable"
        );
    }
    assert_eq!(
        load(
            &library,
            &call,
            tools.clone(),
            revision,
            "other",
            next["resource"].clone()
        )
        .await["kind"],
        "resource_unavailable"
    );
    std::fs::write(&path, "replacement").unwrap();
    assert_eq!(
        library
            .model("load", json!({"tools":tools,"input":next}), &call)
            .await
            .unwrap()["kind"],
        "changed"
    );
    let fresh = search(&library, &call, tools.clone()).await;
    assert_ne!(fresh["revision"], *revision);
    assert_eq!(
        load(
            &library,
            &call,
            tools,
            &fresh["revision"],
            "review",
            json!({"path":"references/guide.txt"})
        )
        .await["content"],
        "replacement"
    );
    call.finish().await.unwrap();
}
