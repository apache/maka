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

async fn tool(socket: &mut TcpStream, name: &str, input: Value) {
    let delta = json!({"id":"skills-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":Uuid::new_v4().to_string(),"type":"function","function":{"name":name,"arguments":input.to_string()}}]},"finish_reason":null}]});
    let body = format!(
        "data: {delta}\n\ndata: {{\"id\":\"skills-model\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}]}}\n\ndata: [DONE]\n\n"
    );
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
}
async fn next(listener: &TcpListener) -> (TcpStream, Value) {
    let (mut socket, _) = listener.accept().await.unwrap();
    let sent = request(&mut socket).await;
    let result = sent["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|m| m["role"] == "tool")
        .unwrap();
    let content = result["content"].as_str().unwrap();
    let result = serde_json::from_str(content).unwrap_or_else(|_| Value::String(content.into()));
    (socket, result)
}
#[tokio::test]
async fn selected_skill_tools_use_actual_agent_context_and_original_grants_over_http() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("selected");
        std::fs::create_dir_all(root.join("review/references")).unwrap();
        std::fs::create_dir_all(root.join("unavailable")).unwrap();
        let instructions = format!("Use [guide](references/guide.txt). Lower-priority instructions.{}", " Review guidance.".repeat(600));
        std::fs::write(root.join("review/SKILL.md"), format!("---\nname: review\ndescription: Review changes\nrequired-tools: SkillSearch Skill\nallowed-tools: Superuser\n---\n{instructions}")).unwrap();
        std::fs::write(root.join("unavailable/SKILL.md"), "---\nname: unavailable\ndescription: Review changes\nrequired-tools: Superuser\n---\nCannot run").unwrap();
        std::fs::write(root.join("review/references/guide.txt"), "资源 🦀 ".repeat(4000)).unwrap();
        for granted in [true, false] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let setup = service_tools::Setup::skills(root.clone());
            let setup = if granted { setup } else { setup.without_grant() };
            let f = Fixture::with_services(&format!("http://{}/v1", listener.local_addr().unwrap()), None, None, Some(setup)).await;
            let original = f.owner.settings.tools.clone();
            for (change, expected) in [
                ("json", "agent_skill_tool_projection_required"),
                ("method", "agent_skill_tool_method_invalid"),
                ("binding", "agent_tool_import_unavailable"),
            ] {
                let mut invalid = original.clone();
                match change {
                    "json" => invalid[0].input = contract::ToolInput::Json,
                    "method" => invalid[0].method = "list".into(),
                    "binding" => invalid[0].import = "absent".into(),
                    _ => unreachable!(),
                }
                assert_eq!(crate::tools::catalog(f.services.clone(), f.store.clone(), f.config.clone(), &invalid, vec![], Default::default()).err().as_deref(), Some(expected));
            }
            let session = f.create("Skill tools").await;
            f.send(&session).await.unwrap();
            let (mut socket, _) = listener.accept().await.unwrap();
            let sent = request(&mut socket).await;
            let schemas = sent["tools"].as_array().unwrap();
            assert_eq!(schemas.len(), 2);
            for tool in schemas {
                assert!(tool["function"]["parameters"]["properties"].get("tools").is_none());
                assert_eq!(tool["function"]["parameters"]["additionalProperties"], false);
            }
            tool(&mut socket, "SkillSearch", json!({"query":"Review"})).await;
            let (mut socket, result) = next(&listener).await;
            if granted {
                assert_eq!(result["totalEligible"], 1, "{result}");
                assert_eq!(result["matches"][0]["ref"], "source:fixture:review");
                let revision = result["revision"].clone();
                tool(&mut socket, "Skill", json!({"name":"source:fixture:review","revision":revision})).await;
                let (mut loaded_socket, loaded) = next(&listener).await;
                assert_eq!(loaded["kind"], "loaded", "{loaded}");
                assert!(loaded["instructions"].as_str().unwrap().contains("references/guide.txt"));
                assert_eq!(loaded["declaredTools"], json!(["Superuser"]));
                assert_eq!(loaded["receipt"]["success"], true);
                let mut complete = loaded["instructions"].as_str().unwrap().to_owned();
                let mut continuation = loaded["next"].clone();
                assert!(!continuation.is_null());
                while !continuation.is_null() {
                    tool(&mut loaded_socket, "Skill", continuation).await;
                    let (next_socket, page) = next(&listener).await;
                    assert_eq!(page["kind"], "loaded");
                    assert_eq!(page["truncated"], false);
                    assert_eq!(page["instructionOffset"], complete.len());
                    complete.push_str(page["instructions"].as_str().unwrap());
                    continuation = page["next"].clone();
                    loaded_socket = next_socket;
                }
                assert_eq!(complete, instructions);
                tool(&mut loaded_socket, "Skill", json!({"name":"source:fixture:review","revision":revision,"resource":{"path":"references/guide.txt"}})).await;
                let (mut resource_socket, resource) = next(&listener).await;
                assert_eq!(resource["kind"], "resource", "{resource}");
                assert!(!resource["next"].is_null());
                tool(&mut resource_socket, "Skill", resource["next"].clone()).await;
                let (mut continued_socket, continued) = next(&listener).await;
                assert_eq!(continued["kind"], "resource");
                assert_eq!(continued["revision"], revision);
                assert_ne!(continued["next"], resource["next"]);
                tool(&mut continued_socket, "SkillSearch", json!({"query":"Review","tools":["Superuser"]})).await;
                let (last_socket, rejected) = next(&listener).await;
                assert_ne!(rejected["totalEligible"], 2, "{rejected}");
                assert!(rejected.to_string().to_lowercase().contains("invalid"), "{rejected}");
                socket = last_socket;
            } else {
                assert_eq!(result, "native service invocation is not granted");
                assert!(result.get("revision").is_none());
            }
            response(&mut socket).await;
            f.drained().await;
            if granted {
                let prefix = f.store.prefix(1024, 4 * 1024 * 1024).await.unwrap();
                let titles: Vec<_> = prefix.events.iter().filter_map(|row| match &row.event.fact {
                    maka_agent_facts::event::Fact::ToolDispatched { title, .. } => title.as_ref(),
                    _ => None,
                }).collect();
                for (locale, expected) in [
                    ("en", ["Search skills · Review", "Read skill · source:fixture:review", "Read skill resource · source:fixture:review / references/guide.txt"]),
                    ("zh-CN", ["搜索技能 · Review", "读取技能 · source:fixture:review", "读取技能资源 · source:fixture:review / references/guide.txt"]),
                    ("zh-TW", ["搜尋技能 · Review", "讀取技能 · source:fixture:review", "讀取技能資源 · source:fixture:review / references/guide.txt"]),
                ] {
                    for expected in expected { assert!(titles.iter().any(|title| title.resolve(locale) == expected), "{titles:?}"); }
                }
            }
            f.app.shutdown().await.unwrap();
            f.config.shutdown().await.unwrap();
        }
        let f = Fixture::with_services("http://127.0.0.1:9/v1", None, None, Some(service_tools::Setup::forms())).await;
        let mut invalid = f.owner.settings.tools.clone();
        invalid[0].input = contract::ToolInput::Skill;
        assert_eq!(crate::tools::catalog(f.services.clone(), f.store.clone(), f.config.clone(), &invalid, vec![], Default::default()).err().as_deref(), Some("agent_skill_tool_contract_invalid"));
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn bundled_authoring_resources_reach_the_actual_model_without_added_authority() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let dir = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let setup = service_tools::Setup::skills(dir.path().to_owned()).with_bundled_skills();
        let f = Fixture::with_services(&format!("http://{}/v1", listener.local_addr().unwrap()), None, None, Some(setup)).await;
        let session = f.create("Built-in authoring").await;
        f.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert_eq!(sent["tools"].as_array().unwrap().len(), 2);
        tool(&mut socket, "SkillSearch", json!({"query":"plugin"})).await;
        let (mut socket, catalog) = next(&listener).await;
        assert_eq!(catalog["totalEligible"], 1, "{catalog}");
        assert_eq!(catalog["matches"][0]["ref"], "bundled:maka-plugin-authoring");
        tool(&mut socket, "Skill", json!({"name":"maka-plugin-authoring","revision":catalog["revision"],"resource":{"path":"references/sdk/ui.ts"}})).await;
        let (mut socket, mut resource) = next(&listener).await;
        let mut complete = String::new();
        loop {
            assert_eq!(resource["kind"], "resource", "{resource}");
            assert_eq!(resource["revision"], catalog["revision"]);
            assert_eq!(resource["reference"], "bundled:maka-plugin-authoring");
            assert_eq!(resource["path"], "references/sdk/ui.ts");
            assert_eq!(resource["receipt"]["success"], true);
            assert_eq!(resource["receipt"]["ref"], "bundled:maka-plugin-authoring");
            complete.push_str(resource["content"].as_str().unwrap());
            let continuation = resource["next"].clone();
            if continuation.is_null() { break; }
            let read: maka_agent_facts::read::ReadInput = serde_json::from_value(continuation["resource"].clone()).unwrap();
            let position: usize = read.path.split("?at=").nth(1).unwrap().split('&').next().unwrap().parse().unwrap();
            let current = complete.encode_utf16().count();
            // Read continuations account for the newline omitted at a line boundary.
            if position > current {
                assert_eq!(position, current + 1);
                complete.push('\n');
            } else { assert_eq!(position, current); }
            tool(&mut socket, "Skill", continuation).await;
            let (next_socket, page) = next(&listener).await;
            socket = next_socket;
            resource = page;
        }
        assert_eq!(complete, include_str!("../../../../../../packages/plugin-sdk/src/ui.ts"));
        tool(&mut socket, "Skill", json!({"name":"maka-cua","revision":catalog["revision"]})).await;
        let (mut socket, unavailable) = next(&listener).await;
        assert_eq!(unavailable["reason"], "host_incompatible");
        response(&mut socket).await;
        f.drained().await;
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn standard_skills_follow_each_actual_session_for_preparation_and_model_requests() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let write = |root:&std::path::Path, name:&str, body:&str| {
            std::fs::create_dir_all(root.join(name)).unwrap();
            std::fs::write(root.join(name).join("SKILL.md"),format!("---\nname: {name}\ndescription: Review project\n---\n{body}")).unwrap();
        };
        let home=tempfile::tempdir().unwrap();
        write(&home.path().join(".maka/skills"),"review","home instructions");
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let setup=service_tools::Setup::skill_preparation(home.path().to_owned(),true).with_standard_sources();
        let f=Fixture::with_services(&format!("http://{}/v1",listener.local_addr().unwrap()),None,None,Some(setup)).await;
        let roots=f.query("directories",json!({"kind":"roots"})).await.unwrap();
        let mut references=Vec::new();
        for (index,instructions) in [(0,"project A instructions"),(1,"project B instructions")] {
            let path=std::path::Path::new(roots["roots"][index]["path"].as_str().unwrap());
            write(&path.join(".agents/skills"),"review",instructions);
            let created=f.mutation(2,"create",json!({"title":"Project skill","labels":[],"workspace":{"kind":"directory","selection":roots["roots"][index]["selection"]}}),Uuid::new_v4()).await.unwrap();
            let session=created["session"]["id"].as_str().unwrap();
            let candidates=f.query("skillCandidates",json!({"sessionId":session,"backend":{"kind":"model","model":f.selection().await},"query":""})).await.unwrap();
            assert_eq!(candidates["skills"].as_array().unwrap().len(),1,"{candidates}");
            assert_eq!(candidates["skills"][0]["invocation"],"/skill:review");
            assert!(candidates["skills"][0]["reference"].as_str().unwrap().starts_with("project:"));
            let sent=f.mutation(2,"send",json!({"sessionId":session,"message":"/skill:review","model":f.selection().await}),Uuid::new_v4()).await.unwrap();
            assert_eq!(sent["kind"],"started","{sent}");
            let (mut socket,_)=listener.accept().await.unwrap();
            let request=request(&mut socket).await;
            assert!(request["messages"].to_string().contains(instructions));
            assert!(!request["messages"].to_string().contains("home instructions"));
            for tool in request["tools"].as_array().unwrap() {
                assert!(tool["function"]["parameters"]["properties"].get("workspace").is_none());
            }
            tool(&mut socket,"FindGuide",json!({"query":"review"})).await;
            let (mut socket,catalog)=next(&listener).await;
            assert_eq!(catalog["totalEligible"],1,"{catalog}");
            let reference=catalog["matches"][0]["ref"].as_str().unwrap().to_owned();
            assert_eq!(candidates["skills"][0]["reference"],reference);
            assert_eq!(candidates["revision"],catalog["revision"]);
            assert!(reference.starts_with("project:")); references.push(reference);
            tool(&mut socket,"LoadGuide",json!({"name":"review","revision":catalog["revision"]})).await;
            let (mut socket,loaded)=next(&listener).await;
            assert_eq!(loaded["instructions"],instructions,"{loaded}");
            response(&mut socket).await;
            f.drained().await;
        }
        assert_ne!(references[0],references[1]);
        f.app.shutdown().await.unwrap(); f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn skill_candidates_filter_actual_tools_and_reject_foreign_sessions() {
    let home = tempfile::tempdir().unwrap();
    for (name, required) in [("visible", "LoadGuide"), ("incompatible", "Superuser")] {
        let root = home.path().join(name);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("SKILL.md"), format!("---\nname: {name}\ndescription: Review changes\nrequired-tools: {required}\n---\nInstructions")).unwrap();
    }
    let setup = service_tools::Setup::skill_preparation(home.path().to_owned(), true);
    let f = Fixture::with_services("http://127.0.0.1:9/v1", None, None, Some(setup)).await;
    let session = f.create("Candidates").await;
    let mut input = json!({"sessionId":session,"backend":{"kind":"model","model":f.selection().await},"query":""});
    let page = f.query("skillCandidates", input.clone()).await.unwrap();
    assert_eq!(page["skills"].as_array().unwrap().len(), 1, "{page}");
    assert_eq!(page["skills"][0]["invocation"], "/skill:visible");
    let executor = f.query("skillCandidates",json!({"sessionId":session,"backend":{"kind":"executor","selection":{"executor":"external","settings":{}}},"query":""})).await.unwrap();
    assert_eq!(executor["skills"], json!([]));
    assert!(executor["revision"].is_null());
    let mut restricted = f.create_input("Restricted").await;
    restricted["tools"] = json!([]);
    let restricted = f
        .mutation(2, "create", restricted, Uuid::new_v4())
        .await
        .unwrap();
    let restricted = f
        .query(
            "skillCandidates",
            json!({"sessionId":restricted["session"]["id"],"backend":input["backend"],"query":""}),
        )
        .await
        .unwrap();
    assert_eq!(restricted["skills"], json!([]));
    input["query"] = json!("incompatible");
    assert_eq!(
        f.query("skillCandidates", input.clone()).await.unwrap()["skills"],
        json!([])
    );
    input["query"] = json!("visible ".repeat(600));
    let long_query = f.query("skillCandidates", input.clone()).await.unwrap();
    assert_eq!(long_query["skills"][0]["invocation"], "/skill:visible");
    assert_eq!(long_query["skills"].as_array().unwrap().len(), 1);
    input["query"] = json!("");
    input["backend"]["model"]["connectionId"] = json!("missing");
    assert_eq!(
        f.query("skillCandidates", input.clone()).await.unwrap()["skills"],
        json!([])
    );
    input["sessionId"] = json!("foreign_session");
    assert!(
        f.query("skillCandidates", input)
            .await
            .unwrap_err()
            .contains("agent_session_unavailable")
    );
    f.app.shutdown().await.unwrap();
    f.config.shutdown().await.unwrap();
}

#[tokio::test]
async fn skill_candidates_work_with_preparation_only_library() {
    let home = tempfile::tempdir().unwrap();
    let root = home.path().join("review");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join("SKILL.md"),
        "---\nname: Review changes\ndescription: Review\n---\nInstructions",
    )
    .unwrap();
    for index in 0..12 {
        let name = format!("z-extra-{index:02}");
        let root = home.path().join(&name);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: Selection candidate\n---\nInstructions"),
        )
        .unwrap();
    }
    let setup = service_tools::Setup::skill_preparation(home.path().to_owned(), false);
    let f = Fixture::with_services("http://127.0.0.1:9/v1", None, None, Some(setup)).await;
    let session = f.create("Candidates").await;
    let page = f.query("skillCandidates",json!({"sessionId":session,"backend":{"kind":"model","model":f.selection().await},"query":""})).await.unwrap();
    assert_eq!(page["skills"].as_array().unwrap().len(), 13, "{page}");
    assert_eq!(page["skills"][0]["name"], "Review changes");
    assert_eq!(page["skills"][0]["invocation"], "/skill:review");
    assert_eq!(page["skills"][12]["invocation"], "/skill:z-extra-11");
    f.app.shutdown().await.unwrap();
    f.config.shutdown().await.unwrap();
}
