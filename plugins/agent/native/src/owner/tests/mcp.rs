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
use maka_agent_facts::durable::{Fact, RunId, ToolDecision, WaitReason};

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
    let interactions = fixture.owner.durable.interactions();
    let mut changes = interactions.subscribe().unwrap();
    loop {
        if let Some(record) = interactions
            .pending(session)
            .await
            .unwrap()
            .records
            .into_iter()
            .next()
        {
            return record;
        }
        changes.changed().await.unwrap();
    }
}

#[derive(Default)]
struct Scenario {
    enveloped: bool,
    code: bool,
    deny: bool,
    read_only: bool,
    preapproved: bool,
    trusted_readonly: bool,
    revoke: bool,
}

#[tokio::test]
async fn mcp_permission_approval_preserves_enveloped_arguments() {
    exercise_mcp_permissions(Scenario {
        enveloped: true,
        ..Default::default()
    })
    .await;
}

#[tokio::test]
async fn mcp_permission_denial_prevents_dispatch() {
    exercise_mcp_permissions(Scenario {
        deny: true,
        ..Default::default()
    })
    .await;
}

#[tokio::test]
async fn mcp_permission_code_mode_preserves_result_and_origin() {
    exercise_mcp_permissions(Scenario {
        code: true,
        preapproved: true,
        ..Default::default()
    })
    .await;
}

#[tokio::test]
async fn mcp_permission_preapproval_does_not_override_read_only_workspace() {
    exercise_mcp_permissions(Scenario {
        read_only: true,
        preapproved: true,
        ..Default::default()
    })
    .await;
}

#[tokio::test]
async fn mcp_permission_trusted_read_only_tool_does_not_bypass_isolation_floor() {
    exercise_mcp_permissions(Scenario {
        read_only: true,
        preapproved: true,
        trusted_readonly: true,
        ..Default::default()
    })
    .await;
}

#[tokio::test]
async fn mcp_permission_revocation_is_rechecked_after_approval() {
    exercise_mcp_permissions(Scenario {
        revoke: true,
        ..Default::default()
    })
    .await;
}

async fn exercise_mcp_permissions(scenario: Scenario) {
    let Scenario {
        enveloped,
        code,
        deny,
        read_only,
        preapproved,
        trusted_readonly,
        revoke,
    } = scenario;
    let decision = if deny { "deny" } else { "allow" };
    tokio::time::timeout(Duration::from_secs(60), async {
        let directory = tempfile::tempdir().unwrap();
        let record = directory.path().join("record");
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::configured(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            None,
            |settings| {
                settings.permissions.access = WorkspaceAccess::DangerFullAccess;
                let mut config = server(&record, preapproved);
                if enveloped {
                    let maka_mcp::TransportConfiguration::Stdio { args, .. } =
                        &mut config.transport
                    else {
                        unreachable!("the MCP fixture uses stdio");
                    };
                    args[1] = "object-union".into();
                }
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
            let tool = prompt["tools"]
                .as_array()
                .unwrap()
                .iter()
                .find(|tool| tool["function"]["name"] == "mcp__fixture__echo")
                .unwrap();
            if enveloped {
                let schema = &tool["function"]["parameters"];
                assert_eq!(schema["type"], "object");
                assert!(
                    ["oneOf", "anyOf", "allOf", "$ref"]
                        .iter()
                        .all(|key| schema.get(*key).is_none())
                );
            }
            service_tools::named_tool_response(
                &mut first,
                "mcp__fixture__echo",
                if enveloped {
                    json!({"request":{"marker":"MCP_RESULT"}})
                } else {
                    json!({"marker":"MCP_RESULT"})
                },
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
        let should_call = decision == "allow" && !read_only && !revoke;
        assert_eq!(calls(&record), usize::from(should_call));
        if enveloped {
            let observed = std::fs::read_to_string(&record)
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str::<Value>(line).unwrap())
                .find(|event| event["method"] == "tools/call")
                .unwrap();
            assert_eq!(
                observed["params"]["arguments"],
                json!({"marker":"MCP_RESULT"})
            );
        }
        if read_only {
            assert!(result["messages"].as_array().unwrap().iter().any(|message|
                message["role"] == "tool" && message.to_string().contains("IsolationUnavailable")
            ), "preapproval and read-only annotations cannot supply process isolation: {result}");
        }
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

        let facts = fixture.recorded_facts(&session).await;
        let run = fixture.latest_run(&session).await.run;
        let view = fixture.owner.durable.frontier(run).await.unwrap();
        if should_call {
            if code {
                assert!(facts.iter().any(|record| match &record.fact {
                    Fact::Cell { event: maka_agent_facts::cells::CellEvent::ChildAdmitted { cell, operation } } =>
                        view.cells.get(cell).is_some_and(|cell|
                            matches!(&cell.owner, maka_agent_facts::cells::CellOwner::Agent { link, .. } if link.run == run)
                            && cell.children.get(operation).is_some_and(|child| child.name == "mcp__fixture__echo" && child.admitted)),
                    _ => false,
                }), "MCP code-mode effects retain their original Agent Cell provenance");
            } else {
                assert!(facts.iter().any(|record| matches!(&record.fact,
                    Fact::ToolAdmitted { tool } if view.tools.get(&maka_agent_state::fold::tool_key(tool))
                        .is_some_and(|tool| tool.call.name == "mcp__fixture__echo"))));
            }
        }
        if read_only {
            assert!(facts.iter().any(|record| matches!(&record.fact,
                Fact::ToolDecided { tool, decision: ToolDecision::Rejected {
                    rejection: maka_agent_facts::tool_call::ToolRejection::PolicyDenied { message }, ..
                }} if message.contains("IsolationUnavailable")
                    && view.tools.get(&maka_agent_state::fold::tool_key(tool))
                        .is_some_and(|tool| tool.call.name == "mcp__fixture__echo" && !tool.admitted))));
        }
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .expect("MCP permission scenario completes");
}

fn portable(record: &std::path::Path) -> Value {
    json!({"mcpServers":{"fixture":{
        "command":"node", "args":[std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../mcp/tests/server.mjs"),"normal",record],
        "tools":["echo"], "preapproved":true,
        "env":{"MCP_TEST_SECRET":"do-not-display-this-value"}
    }}})
}
fn write_config(path: &std::path::Path, config: &Value) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
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
        &home.path().join(".agents/mcp.json"),
        &portable(&global_record),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let f = Fixture::configured(
        &format!("http://{}/v1", listener.local_addr().unwrap()),
        None,
        None,
        None,
        |settings| {
            settings.permissions.access = WorkspaceAccess::DangerFullAccess;
            settings.assistant = Some(crate::contract::AssistantConfiguration {
                home: Some(home.path().to_str().unwrap().into()),
            });
        },
    )
    .await;
    let names = f.query("tools", json!({})).await.unwrap();
    assert!(
        names["names"]
            .as_array()
            .unwrap()
            .iter()
            .any(|name| name == "mcp__fixture__echo")
    );
    assert!(
        global_record.exists(),
        "the current global catalog is opened when requested"
    );
    let a = f.create("project A").await;
    let roots = f
        .query("directories", json!({"kind":"roots"}))
        .await
        .unwrap();
    let b = f.mutation(2,"create",json!({"title":"project B","labels":[],"workspace":{"kind":"directory","path":roots["roots"][1]["path"]}}),Uuid::new_v4()).await.unwrap()["session"]["id"].as_str().unwrap().to_owned();
    let workspace_b = f.owner.session(&b).await.unwrap().configuration.workspace;
    let record_a = home.path().join("a-record");
    let record_b = home.path().join("b-record");
    let file_a = f.workspace.join(".maka/mcp.json");
    write_config(&file_a, &portable(&record_a));
    write_config(
        &std::path::Path::new(&workspace_b.path).join(".agents/mcp.json"),
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
        &f.workspace.join(".maka/mcp.json"),
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
                execution: maka_agent_facts::durable::ExecutionIdentity {
                    session_id: session.clone(),
                    turn_id: "t_test".into(),
                    run_id: RunId::new(),
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
        let f = Arc::new(Fixture::configured(&format!("http://{}/v1",listener.local_addr().unwrap()),None,None,None,|configuration| {
            configuration.permissions.access = WorkspaceAccess::DangerFullAccess;
        }).await);
        let a = f.create("slow MCP").await;
        let roots = f.query("directories",json!({"kind":"roots"})).await.unwrap();
        let b = f.mutation(2,"create",json!({"title":"other session","labels":[],"workspace":{"kind":"directory","path":roots["roots"][1]["path"]}}),Uuid::new_v4()).await.unwrap()["session"]["id"].as_str().unwrap().to_owned();
        f.send(&b).await.unwrap();
        let (mut socket,_) = listener.accept().await.unwrap();
        request(&mut socket).await;
        let running = f.latest_run(&b).await.execution();
        let record = f.workspace.join("slow-record");
        let mut config = portable(&record);
        config["mcpServers"]["fixture"]["args"][1] = json!("startup-hang");
        config["mcpServers"]["fixture"]["startupTimeoutMs"] = json!(300000);
        write_config(&f.workspace.join(".maka/mcp.json"),&config);
        trust_project(&f,&a).await;
        let sending = { let f=f.clone(); tokio::spawn(async move { f.send(&a).await }) };
        while !record.exists() { tokio::time::sleep(Duration::from_millis(10)).await; }
        let stopped = tokio::time::timeout(Duration::from_secs(3),f.mutation(2,"stop",json!({"sessionId":b,"runId":running.run_id}),Uuid::new_v4())).await.unwrap().unwrap();
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
            settings.permissions.access = WorkspaceAccess::DangerFullAccess;
            let mut legacy = server(&dir.path().join("legacy-record"),true);
            legacy.name = "legacy".into();
            settings.mcp_servers = vec![legacy];
        }).await;
        let session = f.create("MCP skills").await;
        let mut project = portable(&dir.path().join("project-record"));
        project["mcpServers"]["legacy"] = json!({"disabled":true});
        write_config(&f.workspace.join(".maka/mcp.json"),&project);
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

#[tokio::test]
async fn mcp_management_preserves_file_fields_and_targets_physical_instances_without_a_session() {
    let home = tempfile::tempdir().unwrap();
    let f = Fixture::configured("http://127.0.0.1:1/v1", None, None, None, |configuration| {
        configuration.assistant = Some(crate::contract::AssistantConfiguration {
            home: Some(home.path().to_str().unwrap().into()),
        });
    })
    .await;
    let roots = f
        .query("directories", json!({"kind":"roots"}))
        .await
        .unwrap();
    let workspace = f
        .mutation(
            2,
            "selectWorkspace",
            json!({"path":roots["roots"][0]["path"]}),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
    assert!(workspace["path"].is_string());
    let path = home.path().join(".agents/mcp.json");
    write_config(
        &path,
        &json!({"customRoot":{"preserve":true},"mcpServers":{
            "same":{"command":"node","args":["old"],"env":{"TOKEN":"secret"},"customServer":{"preserve":true}},
            "unrelated":{"url":"https://example.com/unrelated"}
        }}),
    );
    let initial = f
        .query("mcpConfigurations", json!({"workspace":workspace}))
        .await
        .unwrap();
    assert_eq!(initial["locations"].as_array().unwrap().len(), 4);
    let lower = initial["locations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|location| location["location"] == "user:agents")
        .unwrap();
    let save = json!({"workspace":workspace,"location":"user:agents","revision":lower["revision"],"name":"same","change":{"kind":"save","configuration":{"type":"http","url":"https://example.com/updated"}}});
    assert_eq!(
        f.mutation(2, "manageMcpServer", save.clone(), Uuid::new_v4())
            .await
            .unwrap()["kind"],
        "saved"
    );
    let edited: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(edited["customRoot"]["preserve"], true);
    assert_eq!(
        edited["mcpServers"]["same"]["customServer"]["preserve"],
        true
    );
    assert_eq!(
        edited["mcpServers"]["unrelated"],
        json!({"url":"https://example.com/unrelated"})
    );
    assert!(edited["mcpServers"]["same"].get("command").is_none());
    assert!(edited["mcpServers"]["same"].get("env").is_none());
    assert_eq!(
        f.mutation(2, "manageMcpServer", save, Uuid::new_v4())
            .await
            .unwrap()["kind"],
        "changed"
    );
    for target in ["user:maka", "project:agents", "project:maka"] {
        let inventory = f
            .query("mcpConfigurations", json!({"workspace":workspace}))
            .await
            .unwrap();
        let location = inventory["locations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|location| location["location"] == target)
            .unwrap();
        let result = f.mutation(2,"manageMcpServer",json!({"workspace":workspace,"location":target,"revision":location["revision"],"name":"same","change":{"kind":"save","configuration":{"url":format!("https://example.com/{target}")}}}),Uuid::new_v4()).await.unwrap();
        assert_eq!(result["kind"], "saved", "{result}");
    }
    let inventory = f
        .query("mcpConfigurations", json!({"workspace":workspace}))
        .await
        .unwrap();
    let highest = &inventory["locations"][0];
    assert!(highest["servers"][0]["shadowedBy"].is_null());
    assert_eq!(
        inventory["locations"][1]["servers"][0]["shadowedBy"],
        "project:maka"
    );
    assert_eq!(f.mutation(2,"manageMcpServer",json!({"workspace":workspace,"location":"project:maka","revision":highest["revision"],"name":"same","change":{"kind":"delete"}}),Uuid::new_v4()).await.unwrap()["kind"],"saved");
    let inventory = f
        .query("mcpConfigurations", json!({"workspace":workspace}))
        .await
        .unwrap();
    assert!(
        inventory["locations"][0]["servers"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(inventory["locations"][1]["servers"][0]["shadowedBy"].is_null());
    let selected: crate::contract::Workspace = serde_json::from_value(workspace.clone()).unwrap();
    let proposal = f.owner.mcp_projects.proposal(&selected).await.unwrap();
    assert!(
        !f.owner.mcp_projects.trusted(&proposal).await.unwrap(),
        "saving does not grant project trust"
    );
    assert!(
        f.query("list", json!({"filter":"all","position":{"kind":"start"}}))
            .await
            .unwrap()["sessions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let model_scope = f
        .issuer
        .issue_with(
            Identity::Agent {
                execution: maka_agent_facts::durable::ExecutionIdentity {
                    session_id: "uncreated".into(),
                    turn_id: "turn".into(),
                    run_id: RunId::new(),
                },
                operation_id: None,
            },
            true,
            CancellationToken::new(),
        )
        .unwrap();
    let denied = f
        .app
        .client()
        .start(
            f.binding(2).await,
            "mcpConfigurations".into(),
            json!({"workspace":workspace}),
            model_scope,
            Attachments::new().into(),
        )
        .await
        .unwrap()
        .result()
        .await
        .unwrap_err();
    assert_eq!(denied, "agent_mcp_user_action_required");
    f.app.shutdown().await.unwrap();
    f.config.shutdown().await.unwrap();
}

#[tokio::test]
async fn mcp_global_edits_apply_to_new_admissions_and_retire_unused_connections() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let home = tempfile::tempdir().unwrap();
        let first_record = home.path().join("first-record");
        let next_record = home.path().join("next-record");
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::configured(&format!("http://{}/v1",listener.local_addr().unwrap()),None,None,None,|configuration| {
            configuration.permissions.access = WorkspaceAccess::DangerFullAccess;
            configuration.assistant = Some(crate::contract::AssistantConfiguration { home: Some(home.path().to_str().unwrap().into()) });
        }).await;
        write_config(&home.path().join(".agents/mcp.json"),&portable(&first_record));
        let session = f.create("MCP live configuration").await;
        f.send(&session).await.unwrap();
        let (mut first,_) = listener.accept().await.unwrap();
        request(&mut first).await;
        assert_eq!(f.send(&session).await.unwrap()["kind"],"queued");
        let inventory = f.query("mcpConfigurations",json!({})).await.unwrap();
        let target = inventory["locations"].as_array().unwrap().iter().find(|target|target["location"] == "user:agents").unwrap();
        let result = f.mutation(2,"manageMcpServer",json!({"location":"user:agents","revision":target["revision"],"name":"fixture","change":{"kind":"save","configuration":portable(&next_record)["mcpServers"]["fixture"]}}),Uuid::new_v4()).await.unwrap();
        assert_eq!(result["kind"],"saved");
        assert_eq!(f.send(&session).await.unwrap()["kind"],"queued");
        let tools = f.query("tools",json!({})).await.unwrap();
        assert!(tools["names"].as_array().unwrap().iter().any(|name|name == "mcp__fixture__echo"));
        let pids = |record: &std::path::Path| std::fs::read_to_string(record).unwrap().lines().filter_map(|line|serde_json::from_str::<Value>(line).unwrap()["pid"].as_i64()).collect::<Vec<_>>();
        assert_eq!(pids(&next_record).len(),1,"repeated catalog reads reuse the connection");
        #[cfg(unix)] {
            // SAFETY: signal zero only checks existence of this fixture's numeric process ID.
            assert_eq!(unsafe { libc::kill(pids(&first_record)[0] as i32,0) },0);
        }
        echo_turn(&listener,first,"ORIGINAL_CONNECTION",false).await;
        let (mut queued,_) = listener.accept().await.unwrap();
        request(&mut queued).await;
        echo_turn(&listener,queued,"QUEUED_CONNECTION",false).await;
        let (mut latest,_) = listener.accept().await.unwrap();
        request(&mut latest).await;
        echo_turn(&listener,latest,"UPDATED_CONNECTION",false).await;
        f.drained().await;
        assert_eq!(calls(&first_record),2);
        assert_eq!(calls(&next_record),1);
        #[cfg(unix)] {
            // SAFETY: signal zero only probes the process; no signal is delivered.
            assert_eq!(unsafe { libc::kill(pids(&first_record)[0] as i32,0) },-1,"superseded connection is reaped after its accepted work finishes");
        }
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn mcp_edits_do_not_rebind_a_tool_waiting_for_approval() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let home = tempfile::tempdir().unwrap();
        let original = home.path().join("approval-original");
        let replacement = home.path().join("approval-replacement");
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::configured(&format!("http://{}/v1",listener.local_addr().unwrap()),None,None,None,|configuration| {
            configuration.permissions.access = WorkspaceAccess::DangerFullAccess;
            configuration.assistant = Some(crate::contract::AssistantConfiguration { home: Some(home.path().to_str().unwrap().into()) });
        }).await;
        let mut configuration = portable(&original);
        configuration["mcpServers"]["fixture"]["preapproved"] = json!(false);
        write_config(&home.path().join(".maka/mcp.json"),&configuration);
        let session = f.create("Approval keeps its MCP connection").await;
        f.send(&session).await.unwrap();
        let (mut first,_) = listener.accept().await.unwrap();
        request(&mut first).await;
        service_tools::named_tool_response(&mut first,"mcp__fixture__echo",json!({"marker":"PARKED_ORIGINAL"})).await;
        let pending = approval(&f,&session).await;
        assert_eq!(calls(&original),0);
        write_config(&home.path().join(".maka/mcp.json"),&portable(&replacement));
        f.query("tools",json!({})).await.unwrap();
        let result = f.mutation(2,"respond",json!({"sessionId":session,"requestId":pending.request_id,"answer":{"kind":"service_approval","decision":"allow"}}),Uuid::new_v4()).await.unwrap();
        assert_eq!(result["record"]["outcome"]["decision"],"allow");
        let (mut next,_) = listener.accept().await.unwrap();
        let request = request(&mut next).await;
        assert!(request["messages"].as_array().unwrap().iter().any(|message|message["role"] == "tool" && message.to_string().contains("PARKED_ORIGINAL")));
        response(&mut next).await;
        f.drained().await;
        assert_eq!(calls(&original),1);
        assert_eq!(calls(&replacement),0,"approval targets the original connection after the current files change");
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn mcp_connection_survives_same_run_retry() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let home = tempfile::tempdir().unwrap();
        let original = home.path().join("retry-original");
        let replacement = home.path().join("retry-replacement");
        let latest = home.path().join("retry-latest");
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::configured(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            None,
            |configuration| {
                configuration.permissions.access = WorkspaceAccess::DangerFullAccess;
                configuration.assistant = Some(crate::contract::AssistantConfiguration {
                    home: Some(home.path().to_str().unwrap().into()),
                });
            },
        ).await;
        let file = home.path().join(".agents/mcp.json");
        write_config(&file, &portable(&original));
        let session = f.create("Model retry retains its MCP connection").await;
        let sent = f.send(&session).await.unwrap();
        let (mut first, _) = listener.accept().await.unwrap();
        let original_request = request(&mut first).await;
        let execution = f.latest_run(&session).await.execution();
        let run = execution.run_id;
        let delivered = f.owner.durable.queue().resolve_message(
            session.clone(), sent["messageId"].as_str().unwrap().to_owned(),
        ).await.unwrap();
        assert!(matches!(delivered, maka_agent_state::queue::MessageResolution::Delivered {
            run: original_run, shared: false,
        } if original_run == run), "the retry belongs to this exact accepted message");
        let mut changes = f.owner.durable.subscribe().unwrap();
        let body = json!({"error":{"message":"Retry this request","type":"rate_limit_error","code":"rate_limit_exceeded"}}).to_string();
        first.write_all(format!("HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nContent-Length: {}\r\nRetry-After: 30\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        first.shutdown().await.unwrap();
        let (wait, pending) = loop {
            changes.borrow_and_update();
            let view = f.owner.durable.frontier(run).await.unwrap();
            assert!(view.terminal.is_none(), "a retryable provider response must not end the Run");
            if let Some((wait, pending)) = view.waits.iter().find(|(_, pending)|
                matches!(&pending.reason, WaitReason::Retry { .. })
                    && pending.satisfied.is_none() && pending.cancelled.is_none()) {
                break (*wait, pending.clone());
            }
            changes.changed().await.unwrap();
        };
        assert!(pending.due_at.is_some());
        assert_eq!(f.latest_run(&session).await.execution(), execution);
        write_config(&file, &portable(&replacement));
        f.query("tools", json!({})).await.unwrap();
        let waiting = f.owner.durable.frontier(run).await.unwrap();
        assert_eq!(waiting.waits.get(&wait), Some(&pending),
            "editing the MCP catalog preserves the original Run's canonical retry wait");
        assert_eq!(calls(&original), 0);
        let (mut retried, _) = listener.accept().await.unwrap();
        let retried_request = request(&mut retried).await;
        assert_eq!(retried_request["messages"], original_request["messages"],
            "the retry reuses its original frozen model input");
        assert_eq!(retried_request["tools"], original_request["tools"],
            "the retry keeps its original MCP catalog");
        assert_eq!(retried_request["model"], original_request["model"]);
        assert_eq!(f.latest_run(&session).await.execution(), execution);
        let retrying = f.owner.durable.frontier(run).await.unwrap();
        assert!(retrying.waits[&wait].satisfied.is_some());
        assert_eq!(retrying.retries, 1);
        write_config(&file, &portable(&latest));
        f.query("tools", json!({})).await.unwrap();
        echo_turn(&listener, retried, "RETRIED_ORIGINAL", false).await;
        f.drained().await;
        let finished = f.owner.durable.frontier(run).await.unwrap();
        assert_eq!(finished.terminal, Some(maka_agent_facts::durable::Terminal::Completed));
        assert_eq!(f.owner.durable.runs(session.clone(), None, 256).await.unwrap(), vec![run],
            "model retry never admits a successor Run");
        assert!(f.recorded_facts(&session).await.iter().any(|record|
            record.run == run && matches!(&record.fact, Fact::RetryCharged { .. })));
        assert_eq!(calls(&original), 1);
        assert_eq!(
            std::fs::read_to_string(&original).unwrap().lines()
                .filter(|line| serde_json::from_str::<Value>(line).unwrap()["method"] == "initialize").count(),
            1, "same-Run waiting and retry keep the original MCP process",
        );
        assert_eq!(calls(&replacement), 0);
        assert_eq!(calls(&latest), 0);
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn model_dispatch_keeps_actual_project_and_client_bindings_but_rejects_a_published_replacement()
 {
    use maka_agent_authority::permissions::Access;
    use maka_agent_engine::{ModelSource, RunError};
    tokio::time::timeout(Duration::from_secs(90), async {
        for selected in [false,true] {
        let home=tempfile::tempdir().unwrap();std::fs::create_dir(home.path().join(".agents")).unwrap();
        let global=home.path().join("global-binding");let global_file=home.path().join(".agents/mcp.json");
        let mut global_config=portable(&global);global_config["mcpServers"]["inherited"]=global_config["mcpServers"]["fixture"].clone();
        write_config(&global_file,&global_config);
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f=Fixture::configured(&format!("http://{}/v1",listener.local_addr().unwrap()),None,None,None,|settings| {
            settings.permissions.access=WorkspaceAccess::DangerFullAccess;
            settings.assistant=Some(crate::contract::AssistantConfiguration {home:Some(home.path().to_str().unwrap().into())});
        }).await;
        let mut creation=f.create_input("Actual model bindings").await;
        if !selected {creation["tools"]=json!([]);}
        let created=f.mutation(2,"create",creation,Uuid::new_v4()).await.unwrap();
        let session=created["session"]["id"].as_str().unwrap().to_owned();
        let project=home.path().join("project-binding");let file=f.workspace.join(".maka/mcp.json");let mut config=portable(&project);write_config(&file,&config);trust_project(&f,&session).await;
        let client_record=home.path().join("client-binding");let mut client_server=server(&client_record,true);client_server.name="client".into();
        let mut client=f.app.client().subscribe(f.binding(2).await,"sessionMcp".into(),json!({"sessionId":session,"servers":[client_server]}),scope(&f.issuer,true),Attachments::new().into()).await.unwrap();
        assert_eq!(client.recv().await.unwrap(),json!({"tools":["mcp__client__echo"]}));
        f.send(&session).await.unwrap();let (mut socket,_)=listener.accept().await.unwrap();let wire=request(&mut socket).await;
        for name in ["mcp__fixture__echo","mcp__client__echo","mcp__inherited__echo"] {assert_eq!(wire["tools"].to_string().contains(name),selected,"{wire}");}
        let access=f.live_access(&session).await;let run=access.execution().run_id;
        let view=f.owner.durable.frontier(run).await.unwrap();assert_eq!(view.steps.len(),1);
        let original=f.owner.durable.request(run,*view.steps.keys().next().unwrap()).await.unwrap();
        let bytes=f.owner.durable.content(run,original.request.clone()).await.unwrap();
        let frozen:crate::tools::SelectionSnapshot=f.owner.run_content(run,&view.spec.tool_selection).await.unwrap();
        let (basis,_)=f.owner.restored_data(&view).await.unwrap();let activation=basis.mcp_catalog.as_ref().unwrap();
        assert!(activation.client_mcp.is_some());assert_ne!(activation.bindings.get("mcp__fixture__echo"),f.owner.mcp_projects.base.bindings.get("mcp__fixture__echo"));
        for name in ["mcp__fixture__echo","mcp__client__echo","mcp__inherited__echo"] {if selected {assert_eq!(activation.bindings.get(name),frozen.internal_bindings.get(name));}}
        let source=crate::model::Source::restore(f.owner.configuration.clone(),f.owner.credentials.clone(),basis.model.as_ref().unwrap().clone(),session.clone(),f.owner.revision.clone()).unwrap();
        let model=source.capture().await.unwrap();
        access.authorize_model_request(&original,&model,&f.owner.stop).await.unwrap();
        let current=access.live_configuration().await.unwrap();let caller=scope(&f.issuer,true);
        assert!(f.owner.mcp_projects.current_activation(&current.workspace,&session,activation).is_ok(),"the actual client/project/global chain remains valid in its original workspace");
        let mut wrong_workspace=current.workspace.clone();
        wrong_workspace.identity=format!("workspace:v1:{}",Uuid::new_v4()).try_into().unwrap();
        assert!(f.owner.mcp_projects.current_activation(&wrong_workspace,&session,activation).is_err(),"a registered client layer cannot hide its actual parent's different workspace scope");
        let floor=f.owner.capture_sandbox(&current,caller.sandbox_floor()).await.unwrap();
        let mut restricted=current.clone();restricted.permissions.access=WorkspaceAccess::ReadOnly;
        let restricted_floor=f.owner.capture_sandbox(&restricted,caller.sandbox_floor()).await.unwrap();
        assert!(f.owner.mcp_projects.prepare(&current.workspace,&restricted_floor).await.is_err(),"a cached actual revision does not bypass a narrowed floor");
        access.authorize_model_request(&original,&model,&f.owner.stop).await.unwrap();
        config["mcpServers"]["fixture"]["env"]["VERSION"]=json!("replacement");write_config(&file,&config);
        assert!(f.owner.mcp_projects.prepare(&current.workspace,&floor).await.is_err(),"untrusted proposal must not publish an absent revision");
        access.authorize_model_request(&original,&model,&f.owner.stop).await.unwrap();
        trust_project(&f,&session).await;
        assert!(f.owner.mcp_projects.prepare(&current.workspace,&restricted_floor).await.is_err());
        access.authorize_model_request(&original,&model,&f.owner.stop).await.unwrap();
        let valid=config.clone();config["mcpServers"]["fixture"]["command"]=json!("maka-mcp-nonexistent-fixture-executable");write_config(&file,&config);trust_project(&f,&session).await;
        assert!(f.owner.mcp_projects.capture(&current.workspace,&floor).await.is_err(),"a trusted but unstarted proposal is not a current authority");
        access.authorize_model_request(&original,&model,&f.owner.stop).await.unwrap();
        config=valid;write_config(&file,&config);
        let old_global=global_config.clone();global_config["mcpServers"]["inherited"]["env"]["VERSION"]=json!("global-replacement");write_config(&global_file,&global_config);
        f.owner.mcp_projects.capture_global(&floor).await.unwrap();
        let (published,_)=access.current_model_tools(&current.workspace).unwrap();
        assert_eq!(published.bindings.get("mcp__fixture__echo"),activation.bindings.get("mcp__fixture__echo"),"project masks the changed global server, not the entire global layer");
        assert_ne!(published.bindings.get("mcp__inherited__echo"),activation.bindings.get("mcp__inherited__echo"));
        assert_eq!(published.bindings.get("mcp__client__echo"),activation.bindings.get("mcp__client__echo"));
        assert_eq!(access.authorize_model_request(&original,&model,&f.owner.stop).await.is_err(),selected,"only the original selected binding is invalidated, without refreshing the client composite");
        write_config(&global_file,&old_global);f.owner.mcp_projects.capture_global(&floor).await.unwrap();
        access.authorize_model_request(&original,&model,&f.owner.stop).await.unwrap();
        trust_project(&f,&session).await;
        f.owner.mcp_projects.capture(&current.workspace,&floor).await.unwrap();
        let (published,_)=access.current_model_tools(&current.workspace).unwrap();
        assert_ne!(published.bindings.get("mcp__fixture__echo"),activation.bindings.get("mcp__fixture__echo"));
        assert_eq!(published.bindings.get("mcp__client__echo"),activation.bindings.get("mcp__client__echo"));
        assert!(access.live_configuration().await.is_ok(),"the original claim and workspace remain live");
        let authorized=access.authorize_model_request(&original,&model,&f.owner.stop).await;
        if selected {let error=authorized.unwrap_err();assert!(matches!(error,RunError::Preparation(ref error) if error.kind()==std::io::ErrorKind::PermissionDenied));}
        else {authorized.unwrap();}
        let from_base=f.owner.mcp_projects.current_activation(&current.workspace,&session,&f.owner.mcp_projects.base).unwrap();
        assert_eq!(from_base.bindings,published.bindings,"an actual base activation follows a newly published project layer");
        std::fs::remove_file(&file).unwrap();let global=f.owner.mcp_projects.capture(&current.workspace,&floor).await.unwrap();
        let (after_removal,_)=access.current_model_tools(&current.workspace).unwrap();
        assert_eq!(after_removal.bindings.get("mcp__fixture__echo"),global.bindings.get("mcp__fixture__echo"));
        assert_ne!(after_removal.bindings.get("mcp__fixture__echo"),published.bindings.get("mcp__fixture__echo"));
        assert_eq!(after_removal.bindings.get("mcp__client__echo"),activation.bindings.get("mcp__client__echo"));
        assert_eq!(access.authorize_model_request(&original,&model,&f.owner.stop).await.is_err(),selected);
        assert_eq!(f.owner.durable.request(run,original.step).await.unwrap(),original);assert_eq!(f.owner.durable.content(run,original.request.clone()).await.unwrap(),bytes);
        let current=f.owner.durable.frontier(run).await.unwrap();assert_eq!(current.attempts.len(),1);assert!(current.tools.is_empty());
        response(&mut socket).await;f.drained().await;
        assert_eq!(f.owner.durable.frontier(run).await.unwrap().terminal,Some(maka_agent_facts::durable::Terminal::Completed),"new-dispatch denial must not obstruct this admitted source's result/cleanup");
        drop(model);drop(source);drop(basis);drop(access);
        client.completion().await.cleanup.unwrap();f.app.shutdown().await.unwrap();f.config.shutdown().await.unwrap();
        }
    }).await.expect("actual published MCP bindings, not startup/global metadata, decide new model dispatch");
}
