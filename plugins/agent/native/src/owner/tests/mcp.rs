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
use maka_agent_facts::event::Fact;

fn server(
    record: &std::path::Path,
    preapproved: bool,
) -> maka_agent_facts::configuration::mcp::ServerConfiguration {
    serde_json::from_value(json!({"name":"fixture","transport":{"type":"stdio","command":"node","args":[std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../mcp/tests/server.mjs"),"normal",record],"cwd":record.parent().unwrap()},"tools":["echo"],"preapproved":preapproved})).unwrap()
}
fn calls(record: &std::path::Path) -> usize {
    std::fs::read_to_string(record)
        .unwrap()
        .lines()
        .filter(|line| serde_json::from_str::<Value>(line).unwrap()["method"] == "tools/call")
        .count()
}
async fn approval(
    fixture: &Fixture,
    session: &str,
) -> maka_agent_facts::interaction::InteractionRecord {
    let mut changes = fixture.session(session).await.subscribe_commits().unwrap();
    loop {
        if let Some(record) = fixture
            .session(session)
            .await
            .pending_interactions(session)
            .await
            .unwrap()
            .into_iter()
            .next()
        {
            return record;
        }
        changes.changed().await.unwrap();
    }
}
#[tokio::test]
async fn mcp_native_direct_and_code_mode_calls_share_approval_permissions_and_journal() {
    tokio::time::timeout(Duration::from_secs(60), exercise_mcp_permissions())
        .await
        .unwrap();
}
async fn exercise_mcp_permissions() {
    for (code, decision, read_only, preapproved, trusted_readonly, revoke) in [
        (false, "allow", false, false, false, false),
        (false, "deny", false, false, false, false),
        (true, "allow", false, true, false, false),
        (false, "allow", true, true, false, false),
        (false, "allow", true, true, true, false),
        (false, "allow", false, false, false, true),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let record = directory.path().join("record");
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::configured(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            None,
            |settings| {
                let mut config = server(&record, preapproved);
                if trusted_readonly {
                    config.read_only_tools = vec!["echo".into()];
                }
                settings.mcp_servers = vec![config];
            },
        )
        .await;
        selection::edit(&fixture, |changes| {
            changes.model_overrides = Patch::Set(BTreeMap::from([(
                "fixture-model".into(),
                ModelOverride {
                    code_mode: Some(code),
                    ..Default::default()
                },
            )]))
        })
        .await;
        let session = fixture.create("MCP permissions").await;
        if read_only {
            files::change(&fixture, &session, "read_only", false, true).await;
        }
        fixture.send(&session).await.unwrap();

        let (mut first, _) = listener.accept().await.unwrap();
        let prompt = request(&mut first).await;

        if code {
            assert!(
                prompt["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|tool| tool["function"]["name"] == "exec")
            );
            service_tools::named_tool_response(&mut first,"exec",json!({"code":"const r = await tools.mcp__fixture__echo({marker:'MCP_RESULT'}); if (r.isError || r.structuredContent.marker !== 'MCP_RESULT') throw Error('MCP result lost'); text(r.structuredContent);"})).await;
        } else {
            assert!(
                prompt["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|tool| tool["function"]["name"] == "mcp__fixture__echo")
            );
            service_tools::named_tool_response(
                &mut first,
                "mcp__fixture__echo",
                json!({"marker":"MCP_RESULT"}),
            )
            .await;
        }
        if !preapproved {
            let pending = approval(&fixture, &session).await;

            assert_eq!(calls(&record), 0, "confirmation must precede MCP effect");
            assert!(
                matches!(pending.request,maka_agent_facts::interaction::InteractionRequest::ServiceApproval{ref tool_name,..} if tool_name=="mcp__fixture__echo")
            );
            if revoke {
                files::change(&fixture, &session, "read_only", false, true).await;
            }
            let result=fixture.mutation(2,"respond",json!({"sessionId":session,"requestId":pending.request_id,"answer":{"kind":"service_approval","decision":decision}}),Uuid::new_v4()).await.unwrap();
            assert_eq!(result["record"]["outcome"]["decision"], decision);
        }
        let (mut next, _) = listener.accept().await.unwrap();
        let result = request(&mut next).await;
        let should_call = decision == "allow" && (!read_only || trusted_readonly) && !revoke;
        assert_eq!(calls(&record), usize::from(should_call));
        if should_call {
            assert!(
                result["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|message| message["role"] == "tool"
                        && message.to_string().contains("MCP_RESULT"))
            );
        }
        response(&mut next).await;
        fixture.drained().await;

        let facts = service_tools::facts(&fixture, &session).await;
        if should_call {
            assert!(facts.iter().any(|fact|matches!(fact,Fact::ToolDispatched{name,call,..} if name=="mcp__fixture__echo" && (!code || matches!(call.origin,maka_agent_facts::tool_call::ToolOrigin::CodeMode{..})))));
        }
        if read_only && !trusted_readonly {
            assert!(facts.iter().any(
                |fact| matches!(fact,Fact::ToolRejected{name,..} if name=="mcp__fixture__echo")
            ));
        }
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }
}

fn portable(record: &std::path::Path) -> Value {
    json!({"mcpServers":{"fixture":{
        "command":"node", "args":[std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../mcp/tests/server.mjs"),"normal",record],
        "tools":["echo"], "preapproved":true,
        "env":{"MCP_TEST_SECRET":"do-not-display-this-value"}
    }}})
}
fn write_config(path: &std::path::Path, config: &Value) {
    std::fs::write(path, serde_json::to_vec(config).unwrap()).unwrap();
}
async fn trust_project(f: &Fixture, session: &str) -> Value {
    let view = f
        .query("projectMcp", json!({"sessionId":session}))
        .await
        .unwrap();
    assert_eq!(view["kind"], "configuration");
    let result = f
        .mutation(
            2,
            "trustProjectMcp",
            json!({"sessionId":session,"revision":view["revision"]}),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
    assert_eq!(result["kind"], "trusted");
    view
}
async fn echo_turn(listener: &TcpListener, mut first: TcpStream, marker: &str, code: bool) {
    if code {
        service_tools::named_tool_response(&mut first,"exec",json!({"code":format!("const r = await tools.mcp__fixture__echo({{marker:{}}}); text(r.structuredContent);",serde_json::to_string(marker).unwrap())})).await;
    } else {
        service_tools::named_tool_response(
            &mut first,
            "mcp__fixture__echo",
            json!({"marker":marker}),
        )
        .await;
    }
    let (mut next, _) = listener.accept().await.unwrap();
    let result = request(&mut next).await;
    assert!(
        result["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| message["role"] == "tool" && message.to_string().contains(marker))
    );
    response(&mut next).await;
}
#[tokio::test]
async fn mcp_files_require_exact_project_consent_and_freeze_workspace_connections() {
    tokio::time::timeout(Duration::from_secs(90), exercise_file_consent())
        .await
        .unwrap();
}
async fn exercise_file_consent() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir(home.path().join(".agents")).unwrap();
    let global_record = home.path().join("global-record");
    write_config(
        &home.path().join(".agents/.mcp.json"),
        &portable(&global_record),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let f = Fixture::configured(
        &format!("http://{}/v1", listener.local_addr().unwrap()),
        None,
        None,
        None,
        |settings| {
            settings.assistant = Some(crate::contract::AssistantConfiguration {
                home: Some(home.path().to_str().unwrap().into()),
            });
        },
    )
    .await;
    assert!(
        global_record.exists(),
        "user MCP fallback is loaded at activation"
    );
    let a = f.create("project A").await;
    let roots = f
        .query("directories", json!({"kind":"roots"}))
        .await
        .unwrap();
    let b = f.mutation(2,"create",json!({"title":"project B","labels":[],"workspace":{"kind":"directory","selection":roots["roots"][1]["selection"]}}),Uuid::new_v4()).await.unwrap()["session"]["id"].as_str().unwrap().to_owned();
    let workspace_b = f.owner.session(&b).await.unwrap().configuration.workspace;
    let record_a = home.path().join("a-record");
    let record_b = home.path().join("b-record");
    let file_a = f.workspace.join("mcp.json");
    write_config(&file_a, &portable(&record_a));
    write_config(
        &std::path::Path::new(&workspace_b.path).join(".mcp.json"),
        &portable(&record_b),
    );
    let before = f.query("projectMcp", json!({"sessionId":a})).await.unwrap();
    assert_eq!(before["trusted"], false);
    assert!(!before.to_string().contains("do-not-display-this-value"));
    assert_eq!(before["servers"][0]["preapproved"], true);
    assert!(
        !record_a.exists() && !record_b.exists(),
        "reading configuration must not spawn"
    );
    assert_eq!(f.send(&a).await.unwrap_err(), "agent_mcp_trust_required");
    assert!(!record_a.exists());
    let mut changed = portable(&record_a);
    changed["mcpServers"]["fixture"]["env"]["VERSION"] = json!("two");
    write_config(&file_a, &changed);
    let stale = f
        .mutation(
            2,
            "trustProjectMcp",
            json!({"sessionId":a,"revision":before["revision"]}),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
    assert_eq!(stale["kind"], "changed");
    let approved = trust_project(&f, &a).await;
    assert!(
        !record_a.exists(),
        "confirmation records consent without spawning"
    );
    assert_eq!(
        f.query("projectMcp", json!({"sessionId":b})).await.unwrap()["trusted"],
        false
    );
    trust_project(&f, &b).await;
    f.send(&a).await.unwrap();
    let (mut first, _) = listener.accept().await.unwrap();
    let prompt = request(&mut first).await;
    assert!(
        prompt["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["function"]["name"] == "mcp__fixture__echo")
    );
    assert_eq!(f.send(&a).await.unwrap()["kind"], "queued");
    changed["mcpServers"]["fixture"]["env"]["VERSION"] = json!("three");
    write_config(&file_a, &changed);
    assert_eq!(f.send(&a).await.unwrap_err(), "agent_mcp_trust_required");
    echo_turn(&listener, first, "A_ORIGINAL", false).await;
    let (mut queued, _) = listener.accept().await.unwrap();
    request(&mut queued).await;
    echo_turn(&listener, queued, "A_FROZEN_QUEUE", false).await;
    f.drained().await;
    assert_eq!(calls(&record_a), 2);
    assert_eq!(
        calls(&global_record),
        0,
        "project override must not call the user-level server"
    );
    selection::edit(&f, |changes| {
        changes.model_overrides = Patch::Set(BTreeMap::from([(
            "fixture-model".into(),
            ModelOverride {
                code_mode: Some(true),
                ..Default::default()
            },
        )]));
    })
    .await;
    f.send(&b).await.unwrap();
    let (mut first, _) = listener.accept().await.unwrap();
    request(&mut first).await;
    echo_turn(&listener, first, "B_CODE_MODE", true).await;
    f.drained().await;
    assert_eq!(calls(&record_b), 1);
    assert_eq!(
        calls(&record_a),
        2,
        "same-name servers remain workspace-local"
    );
    assert_eq!(calls(&global_record), 0);
    assert_ne!(
        approved["revision"],
        f.query("projectMcp", json!({"sessionId":a})).await.unwrap()["revision"]
    );
    trust_project(&f, &a).await;
    let workspace = f.owner.session(&a).await.unwrap().configuration.workspace;
    let proposal = f.owner.mcp_projects.proposal(&workspace).await.unwrap();
    let owner = f.owner.prefix.clone();
    f.app.shutdown().await.unwrap();
    f.config.shutdown().await.unwrap();
    let reopened = ConfigurationStore::for_root(f.store.owned_root().unwrap())
        .await
        .unwrap();
    assert!(
        reopened
            .project_mcp_trusted(owner, proposal.workspace, proposal.revision)
            .await
            .unwrap()
    );
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn mcp_project_trust_rejects_model_identity() {
    let f = Fixture::new("http://127.0.0.1:1/v1", None).await;
    let session = f.create("Untrusted").await;
    write_config(
        &f.workspace.join("mcp.json"),
        &portable(&f.workspace.join("record")),
    );
    let view = f
        .query("projectMcp", json!({"sessionId":session}))
        .await
        .unwrap();
    let scope = f
        .issuer
        .issue_with(
            Identity::Agent {
                invocation: Invocation {
                    session_id: session.clone(),
                    turn_id: "t_test".into(),
                    run_id: "r_test".into(),
                    invocation_id: "i_test".into(),
                },
                operation_id: Some("model-attempt".into()),
            },
            true,
            CancellationToken::new(),
        )
        .unwrap();
    let result = f
        .owner
        .trust_project_mcp(
            crate::contract::McpTrust {
                session_id: session.clone(),
                revision: view["revision"].as_str().unwrap().into(),
            },
            &scope,
        )
        .await;
    assert_eq!(
        result.err().as_deref(),
        Some("agent_mcp_user_approval_required")
    );
    assert_eq!(
        f.query("projectMcp", json!({"sessionId":session}))
            .await
            .unwrap()["trusted"],
        false
    );
    f.app.shutdown().await.unwrap();
    f.config.shutdown().await.unwrap();
}

#[tokio::test]
async fn mcp_slow_startup_does_not_block_other_session_stop_or_owner_shutdown() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Arc::new(Fixture::new(&format!("http://{}/v1",listener.local_addr().unwrap()),None).await);
        let a = f.create("slow MCP").await;
        let roots = f.query("directories",json!({"kind":"roots"})).await.unwrap();
        let b = f.mutation(2,"create",json!({"title":"other session","labels":[],"workspace":{"kind":"directory","selection":roots["roots"][1]["selection"]}}),Uuid::new_v4()).await.unwrap()["session"]["id"].as_str().unwrap().to_owned();
        let running = f.send(&b).await.unwrap();
        let (mut socket,_) = listener.accept().await.unwrap();
        request(&mut socket).await;
        let record = f.workspace.join("slow-record");
        let mut config = portable(&record);
        config["mcpServers"]["fixture"]["args"][1] = json!("startup-hang");
        config["mcpServers"]["fixture"]["startupTimeoutMs"] = json!(300000);
        write_config(&f.workspace.join("mcp.json"),&config);
        trust_project(&f,&a).await;
        let sending = { let f=f.clone(); tokio::spawn(async move { f.send(&a).await }) };
        while !record.exists() { tokio::time::sleep(Duration::from_millis(10)).await; }
        let stopped = tokio::time::timeout(Duration::from_secs(3),f.mutation(2,"stop",json!({"sessionId":b,"invocationId":running["invocationId"]}),Uuid::new_v4())).await.unwrap().unwrap();
        assert_eq!(stopped["requested"],true);
        tokio::time::timeout(Duration::from_secs(8),f.app.shutdown()).await.unwrap().unwrap();
        assert!(sending.await.unwrap().is_err());
        let pid = std::fs::read_to_string(&record).unwrap().lines().map(|line|serde_json::from_str::<Value>(line).unwrap()).find_map(|value|value["pid"].as_i64()).unwrap();
        #[cfg(unix)] assert_eq!(unsafe { libc::kill(pid as i32, 0) },-1,"startup child must be reaped before shutdown returns");
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn mcp_project_catalog_is_used_by_model_skill_search_and_load() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("skills");
        for (name,required) in [("project","mcp__fixture__echo"),("legacy","mcp__legacy__echo")] {
            std::fs::create_dir_all(root.join(name)).unwrap();
            std::fs::write(root.join(name).join("SKILL.md"),format!("---\nname: {name}\ndescription: MCP integration\nrequired-tools: {required}\n---\nMCP skill instructions")).unwrap();
        }
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::configured(&format!("http://{}/v1",listener.local_addr().unwrap()),None,None,Some(service_tools::Setup::skills(root)),|settings| {
            let mut legacy = server(&dir.path().join("legacy-record"),true);
            legacy.name = "legacy".into();
            settings.mcp_servers = vec![legacy];
        }).await;
        let session = f.create("MCP skills").await;
        let mut project = portable(&dir.path().join("project-record"));
        project["mcpServers"]["legacy"] = json!({"disabled":true});
        write_config(&f.workspace.join("mcp.json"),&project);
        trust_project(&f,&session).await;
        f.send(&session).await.unwrap();
        let (mut socket,_) = listener.accept().await.unwrap();
        request(&mut socket).await;
        service_tools::named_tool_response(&mut socket,"SkillSearch",json!({"query":"MCP"})).await;
        let (mut socket,_) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        let result: Value = serde_json::from_str(sent["messages"].as_array().unwrap().iter().rev().find(|m|m["role"]=="tool").unwrap()["content"].as_str().unwrap()).unwrap();
        assert_eq!(result["totalEligible"],1,"{result}");
        assert_eq!(result["matches"][0]["ref"],"source:fixture:project","{result}");
        service_tools::named_tool_response(&mut socket,"Skill",json!({"name":"source:fixture:project","revision":result["revision"]})).await;
        let (mut socket,_) = listener.accept().await.unwrap();
        let loaded = request(&mut socket).await;
        assert!(loaded["messages"].as_array().unwrap().iter().rev().find(|m|m["role"]=="tool").unwrap().to_string().contains("MCP skill instructions"));
        response(&mut socket).await;
        f.drained().await;
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}
