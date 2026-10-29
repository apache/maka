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
async fn model_resolution_uses_original_eligibility_preferences_and_identity_before_names() {
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
            "disabled",
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
    assert_eq!(result["totalEligible"], 3);
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
    assert_eq!(loaded["relativePath"], "review/SKILL.md");
    assert_eq!(loaded["receipt"]["ref"], "source:a:review");
    let absent = search(&library, &call, json!([])).await;
    assert_eq!(absent["totalEligible"], 2);
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
    let mut page = load(
        &library,
        &call,
        tools.clone(),
        revision,
        "review",
        json!({"path":"references/guide.txt"}),
    )
    .await;
    let next = page["next"].clone();
    let mut all = String::new();
    loop {
        schema("load", &page);
        assert!(maka_workspace_support::fits(&page));
        assert_eq!(page["kind"], "resource");
        all.push_str(page["content"].as_str().unwrap());
        if page["next"].is_null() {
            break;
        }
        // Original Read continuations omit a newline when a page ends at a line boundary.
        let resource: maka_agent_facts::read::ReadInput =
            serde_json::from_value(page["next"]["resource"].clone()).unwrap();
        let next_position: usize = resource
            .path
            .split("?at=")
            .nth(1)
            .unwrap()
            .split('&')
            .next()
            .unwrap()
            .parse()
            .unwrap();
        if next_position > all.encode_utf16().count() {
            all.push('\n');
        }
        page = library
            .model("load", json!({"tools":tools,"input":page["next"]}), &call)
            .await
            .unwrap();
    }
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
#[tokio::test]
async fn instruction_pages_preserve_the_complete_body_and_original_receipt() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("selected");
    write(&root, "large", &"大段说明🦀\"\n".repeat(20_000));
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
    let page = search(&library, &call, json!([])).await;
    let result = load(
        &library,
        &call,
        json!([]),
        &page["revision"],
        "large",
        Value::Null,
    )
    .await;
    schema("load", &result);
    assert!(maka_workspace_support::fits(&result));
    assert_eq!(result["kind"], "loaded");
    assert!(!result["instructions"].as_str().unwrap().is_empty());
    let mut current = result.clone();
    let mut complete = String::new();
    loop {
        schema("load", &current);
        assert_eq!(current["instructionOffset"], complete.len());
        complete.push_str(current["instructions"].as_str().unwrap());
        if current["next"].is_null() {
            break;
        }
        current = library
            .model("load", json!({"tools":[],"input":current["next"]}), &call)
            .await
            .unwrap();
    }
    assert_eq!(complete, "大段说明🦀\"\n".repeat(20_000).trim_end());
    assert!(library.model("load", json!({"tools":[],"input":{"name":"large","revision":page["revision"],"instructionOffset":1}}), &call).await.is_err());
    let validator =
        jsonschema::validator_for(&schemars::schema_for!(SkillInvocationReceipt).into()).unwrap();
    assert!(validator.is_valid(&result["receipt"]));
    let mut contradictory = result["receipt"].clone();
    contradictory["success"] = json!(false);
    assert!(!validator.is_valid(&contradictory));
    assert!(serde_json::from_value::<SkillInvocationReceipt>(contradictory).is_err());
    call.finish().await.unwrap();
}

#[tokio::test]
async fn bundled_skills_share_model_eligibility_preparation_and_exact_resource_pages() {
    let dir = tempfile::tempdir().unwrap();
    let mut library = Library::open(
        Configuration {
            home: None,
            project_roots: vec![],
            bundled: true,
            manage: false,
            preferences: true,
            sources: vec![],
        },
        dir.path().join("private"),
        preferences(dir.path()).await,
    )
    .unwrap();
    let call = scope();
    let tools = json!(["Skill", "SkillSearch"]);
    let search_all = |tools: Value| json!({"tools":tools,"input":{"query":"","limit":8}});
    let result = library
        .model("search", search_all(tools.clone()), &call)
        .await
        .unwrap();
    schema("search", &result);
    assert_eq!(result["totalEligible"], 1);
    let revision = &result["revision"];
    assert_eq!(
        load(
            &library,
            &call,
            tools.clone(),
            revision,
            "maka-cua",
            Value::Null
        )
        .await["reason"],
        "host_incompatible"
    );
    let with_cua = library
        .model(
            "search",
            search_all(json!(["Skill", "SkillSearch", "cua_repl"])),
            &call,
        )
        .await
        .unwrap();
    assert_eq!(with_cua["totalEligible"], 2);
    let original_load = json!({"name":"maka-plugin-authoring","revision":revision,"resource":{"path":"references/sdk/workbench.ts"}});
    let mut page = library
        .model("load", json!({"tools":tools,"input":original_load}), &call)
        .await
        .unwrap();
    let mut all = String::new();
    loop {
        schema("load", &page);
        assert_eq!(page["kind"], "resource");
        all.push_str(page["content"].as_str().unwrap());
        if page["next"].is_null() {
            break;
        }
        let resource: maka_agent_facts::read::ReadInput =
            serde_json::from_value(page["next"]["resource"].clone()).unwrap();
        let position: usize = resource
            .path
            .split("?at=")
            .nth(1)
            .unwrap()
            .split('&')
            .next()
            .unwrap()
            .parse()
            .unwrap();
        if position > all.encode_utf16().count() {
            all.push('\n');
        }
        page = library
            .model("load", json!({"tools":tools,"input":page["next"]}), &call)
            .await
            .unwrap();
    }
    assert_eq!(
        all,
        include_str!("../../../../../packages/plugin-sdk/src/workbench.ts")
    );
    for path in ["../secret", "/secret", "references/../../secret"] {
        assert_eq!(
            load(
                &library,
                &call,
                tools.clone(),
                revision,
                "maka-plugin-authoring",
                json!({"path":path})
            )
            .await["kind"],
            "resource_unavailable"
        );
    }
    let prepared = library.model("prepare", json!({"tools":tools,"input":{"language":"en","message":"/skill:maka-plugin-authoring","loadTool":"Skill","searchTool":"SkillSearch"}}), &call).await.unwrap();
    schema("prepare", &prepared);
    assert_eq!(prepared["kind"], "ready");
    assert_eq!(prepared["record"]["revision"], *revision);
    assert!(matches!(
        library
            .preferences
            .set(
                SetPreference {
                    reference: "bundled:maka-plugin-authoring".into(),
                    revision: 0,
                    preference: maka_skills::Preference {
                        enabled: false,
                        pinned: true
                    }
                },
                &call
            )
            .await
            .unwrap(),
        PreferenceResult::Applied { .. }
    ));
    assert_eq!(
        library
            .model("load", json!({"tools":tools,"input":original_load}), &call)
            .await
            .unwrap()["kind"],
        "changed"
    );
    let fresh = library
        .model("search", search_all(tools.clone()), &call)
        .await
        .unwrap();
    assert_eq!(fresh["totalEligible"], 0);
    assert_eq!(
        load(
            &library,
            &call,
            tools.clone(),
            &fresh["revision"],
            "maka-plugin-authoring",
            Value::Null
        )
        .await["reason"],
        "disabled"
    );
    library.bundled = false;
    assert!(library.snapshot(&call).await.unwrap().entries.is_empty());
    call.finish().await.unwrap();
}

#[tokio::test]
async fn preparation_language_preserves_opaque_skills_metadata_and_protocol_identity() {
    let dir = tempfile::tempdir().unwrap();
    let source_path = dir.path().join("skills");
    let body = "Opaque instructions 中文 / 繁體 and OriginalProtocolName.";
    write(&source_path, "review", body);
    write(&source_path, "empty", "");
    let library = Library::open(
        Configuration {
            home: None,
            project_roots: vec![],
            bundled: false,
            manage: false,
            preferences: false,
            sources: vec![source("original", &source_path)],
        },
        dir.path().join("private"),
        preferences(dir.path()).await,
    )
    .unwrap();
    let call = scope();
    let user_text = "Keep MyExactUserText 中文 / 繁體";
    let mut original_receipts = None;
    let mut revision = None;
    for (language, safety_word, discovery_word, no_task) in [
        (
            "en",
            "permission",
            "Available local skills",
            "no additional task text",
        ),
        ("zh-CN", "权限", "可用的本地技能", "未提供额外的任务文本"),
        ("zh-TW", "權限", "可用的本機技能", "未提供額外的任務文字"),
    ] {
        let result = library
            .model(
                "prepare",
                json!({
                    "tools": ["OriginalLoadTool", "OriginalSearchTool"],
                    "input": {
                        "language": language,
                        "message": format!("/skill:review {user_text}"),
                        "loadTool": "OriginalLoadTool",
                        "searchTool": "OriginalSearchTool"
                    }
                }),
                &call,
            )
            .await
            .unwrap();
        schema("prepare", &result);
        assert_eq!(result["kind"], "ready");
        for message in ["/skill:review", "ordinary"] {
            let prepared = library.model(
                "prepare",
                json!({"tools":["OriginalLoadTool","OriginalSearchTool"],"input":{"language":language,"message":message,"loadTool":"OriginalLoadTool","searchTool":"OriginalSearchTool"}}),
                &call,
            ).await.unwrap();
            assert_eq!(prepared["kind"], "ready");
            if message == "/skill:review" {
                let text = prepared["text"].as_str().unwrap();
                assert!(text.contains(no_task));
                assert!(text.contains(body));
            } else {
                assert_eq!(prepared["text"], Value::Null);
                assert_eq!(prepared["record"]["invocation"]["loaded"], json!([]));
            }
        }
        let text = result["text"].as_str().unwrap();
        assert!(text.contains(safety_word));
        assert!(text.contains(body));
        assert!(text.contains(user_text));
        let record = &result["record"];
        let metadata = record["metadataPrompt"].as_str().unwrap();
        assert!(metadata.contains(discovery_word));
        assert!(metadata.contains("Reference for review"));
        assert!(metadata.contains("source:original:review"));
        assert!(metadata.contains("OriginalLoadTool"));
        assert!(metadata.contains("OriginalSearchTool"));
        assert!(metadata.contains(record["revision"].as_str().unwrap()));
        if let Some(original) = &original_receipts {
            assert_eq!(&record["invocation"], original);
            assert_eq!(&record["revision"], revision.as_ref().unwrap());
        } else {
            original_receipts = Some(record["invocation"].clone());
            revision = Some(record["revision"].clone());
        }
    }
    for (name, original_body) in [("review", body), ("empty", "")] {
        let loaded = load(
            &library,
            &call,
            json!(["OriginalLoadTool", "OriginalSearchTool"]),
            revision.as_ref().unwrap(),
            name,
            Value::Null,
        )
        .await;
        schema("load", &loaded);
        assert_eq!(loaded["kind"], "loaded");
        assert_eq!(loaded["metadata"]["id"], name);
        assert_eq!(loaded["instructions"], original_body);
        assert_eq!(loaded["relativePath"], format!("{name}/SKILL.md"));
    }
    assert!(
        library
            .model(
                "prepare",
                json!({"tools":[],"input":{"message":"ordinary"}}),
                &call
            )
            .await
            .is_err()
    );
}
