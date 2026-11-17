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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn memory_management_cas_sources_deletion_and_restart() {
    let mut rig = Rig::new().unwrap();
    let result = AssertUnwindSafe(tokio::time::timeout(
        Duration::from_secs(120),
        exercise(&mut rig),
    ))
    .catch_unwind()
    .await;
    let cleanup = rig.finish().await;
    assert!(matches!(result, Ok(Ok(Ok(())))), "{result:?}");
    assert!(cleanup.is_empty(), "{cleanup:?}");
}
async fn exact_matching_acceptance(client: &HostClient) -> TestResult<()> {
    let scope = json!({"kind":"personal"});
    let create = json!({"scope":scope,"edit":{"kind":"create","body":"Exact matching acceptance"}});
    let (a, b) = tokio::join!(
        call(client, "agent", "changeMemory", create.clone()),
        call(client, "agent", "changeMemory", create.clone()),
    );
    let (a, b) = (a?, b?);
    let (first, duplicate) = if a["kind"] == "saved" { (a, b) } else { (b, a) };
    assert_eq!(first["kind"], "saved");
    assert_eq!(duplicate["kind"], "evidence_added");
    assert_eq!(duplicate["id"], first["id"]);
    assert_eq!(duplicate["revision"], 2);
    let deleted = call(client, "agent", "changeMemory", json!({"scope":scope,"edit":{"kind":"delete","id":first["id"],"expectedRevision":duplicate["revision"]}})).await?;
    assert_eq!(deleted["kind"], "deleted");
    let blocked = call(client, "agent", "changeMemory", create).await?;
    assert_eq!(blocked, json!({"kind":"suppressed"}));
    assert_eq!(
        call(
            client,
            "agent",
            "memory",
            json!({"scope":scope,"id":first["id"]})
        )
        .await?,
        Value::Null
    );
    Ok(())
}

async fn exercise(rig: &mut Rig) -> TestResult<()> {
    let base = rig.directory.path().to_path_buf();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let url = format!("http://{}/v1", listener.local_addr()?);
    let (requests, mut observed) = tokio::sync::mpsc::channel(1);
    let app = axum::Router::new().route(
        "/v1/chat/completions",
        axum::routing::post(move || {
            let requests = requests.clone();
            async move {
                let (respond, response) = oneshot::channel::<()>();
                let _ = requests.send(respond).await;
                let _ = response.await;
                (
                    [("content-type", "text/event-stream")],
                    super::bot_tools::completion(
                        json!({"role":"assistant","content":"Recorded in the conversation."}),
                        "stop",
                    ),
                )
            }
        }),
    );
    let provider = tokio::spawn(async move { axum::serve(listener, app).await });
    let boot = bootstrap_with(&base, url, |config| config["memoryTestPeer"] = json!(true)).await?;
    attach(rig, &boot).await?;
    let client = rig.client.as_ref().unwrap();
    git_scope_acceptance(client, &base).await?;
    exact_matching_acceptance(client).await?;
    let preferences = call(client, "settings", "assistantPreferences", json!({})).await?;
    assert_eq!(
        preferences["memory"],
        json!({"enabled":true,"agentReadEnabled":false})
    );
    let disabled=call(client,"settings","updateAssistantPreferences",json!({"expectedRevision":preferences["revision"],"mutation":{"kind":"memory","value":{"enabled":false,"agentReadEnabled":false}}})).await?;
    assert_eq!(disabled["kind"], "committed");
    let conflict=call(client,"settings","updateAssistantPreferences",json!({"expectedRevision":preferences["revision"],"mutation":{"kind":"memory","value":{"enabled":true,"agentReadEnabled":true}}})).await?;
    assert_eq!(conflict["kind"], "revision_conflict");

    let catalog = call(client, "settings", "connections", json!({"kind":"start"})).await?;
    let connection = call(client, "settings", "create", json!({"expectedCatalogRevision":catalog["revision"],"connection":{"slug":"memory","name":"Memory fixture","provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"ollama"},"configuration":{"baseUrl":boot.base_url},"enabled":true,"enabledModelIds":["llama3.2"],"modelOverrides":{"llama3.2":{"codeMode":false,"apiProtocol":"openai-chat-completions"}}}})).await?;
    let backend = json!({"kind":"model","connectionId":connection["connection"]["connectionId"],"modelId":"llama3.2"});
    let private = call(client,"agent","create",json!({"title":"Private","incognito":true,"labels":[],"workspace":{"kind":"directory","path":base.join("workspace")}})).await?;
    assert_eq!(private["session"]["incognito"], true);
    let mut sessions = Vec::new();
    for title in ["Memory A", "Memory B"] {
        let created=call(client,"agent","create",json!({"title":title,"automaticTitle":false,"labels":[],"workspace":{"kind":"directory","path":base.join("workspace")}})).await?;
        assert_eq!(created["kind"], "created", "{created}");
        sessions.push(created["session"]["id"].clone());
    }
    let project_scope = json!({"kind":"project","sessionId":sessions[0]});
    let project_memory = call(
        client,
        "agent",
        "changeMemory",
        json!({"scope":project_scope,"edit":{"kind":"create","body":"Project only"}}),
    )
    .await?;
    assert_eq!(project_memory["kind"], "saved");
    assert_eq!(
        call(
            client,
            "agent",
            "memory",
            json!({"scope":{"kind":"project","sessionId":sessions[1]},"id":project_memory["id"]})
        )
        .await?["body"],
        "Project only"
    );
    assert_eq!(
        call(
            client,
            "agent",
            "memory",
            json!({"scope":{"kind":"personal"},"id":project_memory["id"]})
        )
        .await?,
        Value::Null
    );
    std::fs::create_dir_all(base.join("workspace/sub"))?;
    let child=call(client,"agent","create",json!({"title":"Subdirectory","automaticTitle":false,"labels":[],"workspace":{"kind":"directory","path":base.join("workspace/sub")}})).await?;
    assert_eq!(call(client,"agent","memory",json!({"scope":{"kind":"project","sessionId":child["session"]["id"]},"id":project_memory["id"]})).await?,Value::Null);
    let sent = call(client,"agent","send",json!({"sessionId":sessions[0],"message":"Prefer Chinese for project discussions.","backend":backend})).await?;
    assert_eq!(sent["kind"], "queued", "{sent}");
    let respond = observed.recv().await.ok_or("model request missing")?;
    let owner = rig
        .captured
        .lock()
        .unwrap()
        .clone()
        .ok_or("owner missing")?;
    for (enabled, read_enabled) in [(false, true), (true, false), (true, true)] {
        let current = call(client, "settings", "assistantPreferences", json!({})).await?;
        call(client,"settings","updateAssistantPreferences",json!({"expectedRevision":current["revision"],"mutation":{"kind":"memory","value":{"enabled":enabled,"agentReadEnabled":read_enabled}}})).await?;
        let result = model_read(
            &owner,
            sessions[0].as_str().unwrap(),
            json!({"scope":project_scope,"id":project_memory["id"]}),
        )
        .await;
        if enabled && read_enabled {
            assert_eq!(result?["body"], "Project only");
        } else {
            let error = result.unwrap_err();
            assert!(error.contains("agent_memory_read_disabled"), "{error}");
        }
    }
    assert!(
        model_read(
            &owner,
            sessions[0].as_str().unwrap(),
            json!({"scope":{"kind":"project","sessionId":sessions[1]},"id":project_memory["id"]})
        )
        .await
        .unwrap_err()
        .contains("agent_memory_scope_denied")
    );
    assert!(
        model_write(
            &owner,
            sessions[0].as_str().unwrap(),
            json!({"scope":{"kind":"personal"},"edit":{"kind":"create","body":"Impersonated user"}})
        )
        .await?
    );
    respond.send(()).map_err(|_| "provider stopped")?;
    quiescent_message(client, sessions[0].as_str().unwrap(), &sent["messageId"]).await?;
    let private_sent = call(client,"agent","send",json!({"sessionId":private["session"]["id"],"message":"Private conversation","backend":backend})).await?;
    let respond = observed
        .recv()
        .await
        .ok_or("private model request missing")?;
    assert!(
        model_read(
            &owner,
            private["session"]["id"].as_str().unwrap(),
            json!({"scope":{"kind":"personal"},"id":project_memory["id"]})
        )
        .await
        .unwrap_err()
        .contains("agent_memory_incognito")
    );
    respond.send(()).map_err(|_| "provider stopped")?;
    quiescent_message(
        client,
        private["session"]["id"].as_str().unwrap(),
        &private_sent["messageId"],
    )
    .await?;

    let reference = conversation_reference(client, sessions[0].as_str().unwrap()).await?;
    assert!(
        conversation_reference(client, private["session"]["id"].as_str().unwrap())
            .await
            .unwrap_err()
            .to_string()
            .contains("incognito")
    );
    let private_id = private["session"]["id"].as_str().unwrap();
    let forked = call(
        client,
        "agent",
        "fork",
        json!({
            "sessionId": private_id,
            "expectedRevision": owner.session(private_id).await?.revision,
            "position": {"kind":"end"},
            "title":"Private fork",
            "labels":[]
        }),
    )
    .await?;
    assert_eq!(forked["kind"], "forked", "{forked}");
    assert_eq!(forked["session"]["incognito"], true);
    let mut forged = reference.clone();
    forged.quote = "Forged evidence".into();
    assert!(call(client,"agent","changeMemory",json!({"scope":project_scope,"edit":{"kind":"add_evidence","id":project_memory["id"],"expectedRevision":1,"assertion":1,"reference":forged}})).await.is_err());
    let evidence_input = json!({"scope":project_scope,"edit":{"kind":"add_evidence","id":project_memory["id"],"expectedRevision":1,"assertion":1,"reference":reference}});
    assert_eq!(
        call(client, "agent", "changeMemory", evidence_input).await?["revision"],
        2
    );
    let first = call(
        client,
        "agent",
        "memoryEvidence",
        json!({"scope":project_scope,"id":project_memory["id"],"assertion":1,"limit":1}),
    )
    .await?;
    assert_eq!(first["evidence"][0]["source"]["kind"], "user_operation");
    let second = call(client,"agent","memoryEvidence",json!({"scope":project_scope,"id":project_memory["id"],"assertion":1,"limit":1,"after":first["next"]})).await?;
    assert_eq!(second["evidence"][0]["source"]["kind"], "conversation");
    assert!(second["next"].is_null());
    let before = owner.session(sessions[0].as_str().unwrap()).await?;
    let project =
        maka_fs_tools::workspace::project::resolve_selected(&base.join("workspace")).await?;
    let captured = maka_agent_state::memory::Scope {
        namespace: serde_json::to_string(&owner.run_owner())?,
        location: project.identity()?,
        binding: Some((
            sessions[0].as_str().unwrap().into(),
            before.configuration.permission_basis(),
        )),
    };
    let changed = call(client,"agent","metadata",json!({"sessionId":sessions[0],"expectedRevision":before.revision,"title":before.configuration.title,"labels":[],"permissions":{"settings":{"access":"read_only","requestPermissions":false},"revokeGrants":true}})).await?;
    assert_eq!(changed["kind"], "committed", "{changed}");
    let stale = rig
        .store
        .as_ref()
        .unwrap()
        .data_writer()?
        .write(maka_agent_state::memory::UserChange {
            source_scope: None,
            scope: captured,
            operation: Uuid::new_v4(),
            at: 1,
            edit: maka_agent_facts::memory::MemoryEdit::Correct {
                id: serde_json::from_value(project_memory["id"].clone())?,
                expected_revision: maka_agent_facts::memory::MemoryRevision(2),
                body: "Stale permission write".into(),
                metadata: Default::default(),
            },
        })
        .await;
    assert!(stale.unwrap_err().to_string().contains("binding changed"));

    let scope = json!({"kind":"personal"});
    let mut pending = client
        .call(
            "agent",
            "changeMemory".into(),
            json!({"scope":scope,"edit":{"kind":"create","body":"Prefer Chinese"}}),
            Attachments::new(),
        )
        .await?;
    pending.start().await?;
    assert!(matches!(pending.receive().await?, Reply::Prepared { .. }));
    let _ = pending.confirm(json!({"test":"memory-lost-reply"})).await?;
    let reference = pending.reference().unwrap().clone();
    pending.close().await?;
    let observation = rig
        .store
        .as_ref()
        .unwrap()
        .operation(&reference)?
        .operation_observation()
        .await?
        .unwrap();
    let OperationOutcome::Returned {
        result: OperationResult::Success { value: created },
    } = observation.outcome
    else {
        return Err("memory commit failed".into());
    };
    assert_eq!(created["kind"], "saved");
    assert!(created.get("body").is_none());
    let id = created["id"].clone();
    let read = json!({"scope":scope,"id":id});
    assert!(
        call(
            client,
            "memory_peer",
            "memory",
            json!({"scope":scope,"id":id})
        )
        .await?
        .is_null()
    );
    assert_eq!(call(client,"memory_peer","changeMemory",json!({"scope":scope,"edit":{"kind":"correct","id":id,"expectedRevision":1,"body":"Cross-agent overwrite"}})).await?["kind"],"not_found");

    assert_eq!(
        call(client, "agent", "memory", read.clone()).await?["body"],
        "Prefer Chinese"
    );
    let (a, b) = tokio::join!(
        call(
            client,
            "agent",
            "changeMemory",
            json!({"scope":scope,"edit":{"kind":"correct","id":id,"expectedRevision":1,"body":"Prefer English"}})
        ),
        call(
            client,
            "agent",
            "changeMemory",
            json!({"scope":scope,"edit":{"kind":"correct","id":id,"expectedRevision":1,"body":"Prefer French"}})
        )
    );
    let (a, b) = (a?, b?);
    assert!(matches!(
        (a["kind"].as_str(), b["kind"].as_str()),
        (Some("saved"), Some("conflict")) | (Some("conflict"), Some("saved"))
    ));
    let history = call(
        client,
        "agent",
        "memoryHistory",
        json!({"scope":scope,"id":id,"limit":10}),
    )
    .await?;
    assert_eq!(history["versions"].as_array().unwrap().len(), 2);
    assert_eq!(history["versions"][0]["body"], "Prefer Chinese");
    assert_eq!(
        history["versions"][0]["source"]["operationId"],
        serde_json::to_value(reference.operation)?
    );
    assert_eq!(history["versions"][1]["corrects"], 1);
    let first = call(
        client,
        "agent",
        "memoryHistory",
        json!({"scope":scope,"id":id,"limit":1}),
    )
    .await?;
    let second = call(
        client,
        "agent",
        "memoryHistory",
        json!({"scope":scope,"id":id,"limit":1,"after":first["next"]}),
    )
    .await?;
    assert_eq!(second["versions"][0]["revision"], 2);
    assert!(second["next"].is_null());
    for (revision, always) in [(2, true), (3, false)] {
        assert_eq!(call(client,"agent","changeMemory",json!({"scope":scope,"edit":{"kind":"set_always","id":id,"expectedRevision":revision,"always":always}})).await?["kind"],"saved");
        assert_eq!(
            call(client, "agent", "memory", read.clone()).await?["mode"],
            if always { "user_always" } else { "user_recall" }
        );
    }
    assert_eq!(
        call(client, "agent", "memory", read.clone()).await?["mode"],
        "user_recall"
    );
    assert_eq!(
        call(
            client,
            "agent",
            "changeMemory",
            json!({"scope":scope,"edit":{"kind":"delete","id":id,"expectedRevision":4}})
        )
        .await?["kind"],
        "deleted"
    );
    assert_eq!(
        call(client, "agent", "memory", read.clone()).await?,
        Value::Null
    );
    assert!(
        call(
            client,
            "agent",
            "memories",
            json!({"scope":scope,"limit":1})
        )
        .await?["records"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        call(
            client,
            "agent",
            "memoryHistory",
            json!({"scope":scope,"id":id,"limit":10})
        )
        .await?["versions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(call(client,"agent","changeMemory",json!({"scope":scope,"edit":{"kind":"correct","id":id,"expectedRevision":5,"body":"silent resurrection"}})).await?["kind"],"invalid_state");
    drop(owner);
    assert!(rig.finish().await.is_empty());
    rig.client = None;
    rig.host = None;
    rig.store = None;
    rig.captured.lock().unwrap().take();
    rig.stop_serving = CancellationToken::new();
    attach(rig, &boot).await?;
    let client = rig.client.as_ref().unwrap();
    assert_eq!(
        call(client, "agent", "memory", read.clone()).await?,
        Value::Null
    );
    assert_eq!(call(client, "agent", "changeMemory", json!({"scope":{"kind":"personal"},"edit":{"kind":"create","body":"Exact matching acceptance"}})).await?, json!({"kind":"suppressed"}));
    let persisted = call(
        client,
        "agent",
        "memory",
        json!({"scope":project_scope,"id":project_memory["id"]}),
    )
    .await?;
    assert_eq!(persisted["body"], "Project only");
    assert_eq!(persisted["revision"], 2);
    for _ in 0..2 {
        let reply = call(
            client,
            "receipts",
            "read",
            serde_json::to_value(&reference)?,
        )
        .await?;
        let reply: maka_plugin_core::operation::OperationReply = serde_json::from_value(reply)?;
        assert_eq!(reply.reference, reference);
        assert!(
            matches!(reply.receipt, Receipt::Recorded { outcome: OperationOutcome::Returned { result: OperationResult::Success { ref value } }, .. } if value == &created)
        );
    }
    assert_eq!(
        call(client, "agent", "memory", read.clone()).await?,
        Value::Null
    );
    let observed = rig
        .store
        .as_ref()
        .unwrap()
        .operation(&reference)?
        .operation_observation()
        .await?
        .unwrap();
    assert_eq!(
        observed.outcome,
        OperationOutcome::Returned {
            result: OperationResult::Success { value: created }
        }
    );
    assert_eq!(call(client,"agent","changeMemory",json!({"scope":scope,"edit":{"kind":"restore","id":id,"expectedRevision":5,"body":"Explicitly restored"}})).await?["revision"],6);
    assert_eq!(
        call(client, "agent", "memory", read).await?["body"],
        "Explicitly restored"
    );
    let restored_history = call(
        client,
        "agent",
        "memoryHistory",
        json!({"scope":scope,"id":id,"limit":10}),
    )
    .await?;
    assert_eq!(restored_history["versions"].as_array().unwrap().len(), 1);
    call(client,"agent","changeMemory",json!({"scope":scope,"edit":{"kind":"set_always","id":id,"expectedRevision":6,"always":true}})).await?;
    call(client,"agent","changeMemory",json!({"scope":scope,"edit":{"kind":"correct","id":id,"expectedRevision":7,"body":"Always after editing","metadata":{"kind":"preference","statement":"preference","temporal":{"kind":"interval","start":10,"end":20}}}})).await?;
    let pinned = call(client, "agent", "memory", json!({"scope":scope,"id":id})).await?;
    assert_eq!(pinned["mode"], "user_always");
    assert_eq!(pinned["metadata"]["temporal"]["end"], 20);
    for body in ["Second project record", "Third project record"] {
        call(
            client,
            "agent",
            "changeMemory",
            json!({"scope":project_scope,"edit":{"kind":"create","body":body}}),
        )
        .await?;
    }
    let mut cursor = Value::Null;
    let mut seen = std::collections::BTreeSet::new();
    loop {
        let page = call(
            client,
            "agent",
            "memories",
            json!({"scope":project_scope,"limit":1,"after":cursor}),
        )
        .await?;
        for record in page["records"].as_array().unwrap() {
            assert!(seen.insert(record["id"].as_str().unwrap().to_owned()));
        }
        cursor = page["next"].clone();
        if cursor.is_null() {
            break;
        }
    }
    assert_eq!(seen.len(), 3);
    provider.abort();
    let _ = provider.await;
    Ok(())
}

async fn conversation_reference(
    client: &HostClient,
    session: &str,
) -> TestResult<maka_agent_facts::memory::MemoryEvidenceReference> {
    let page = call(
        client,
        "agent",
        "history",
        json!({"sessionId":session,"position":{"kind":"start"},"view":"text"}),
    )
    .await?;
    let chunk = page["chunks"]
        .as_array()
        .ok_or("history chunks missing")?
        .iter()
        .find(|chunk| {
            chunk["role"] == "user" && chunk["text"].as_str().is_some_and(|s| !s.is_empty())
        })
        .ok_or("user history missing")?;
    assert_eq!(chunk["position"]["kind"], "live");
    let quote = chunk["text"].as_str().unwrap();
    let reference = call(client,"agent","memorySource",json!({"sessionId":session,"sequence":chunk["position"]["sequence"],"itemIndex":chunk["position"]["itemIndex"],"start":0,"end":quote.len(),"quote":quote})).await?;
    Ok(serde_json::from_value(reference)?)
}

async fn model_read(owner: &Owner, session: &str, input: Value) -> Result<Value, String> {
    use maka_plugin_core::contract::ServiceTarget;
    let access = owner
        .runs
        .state()
        .await
        .controls
        .get(session)
        .and_then(|control| control.access.upgrade())
        .ok_or("execution unavailable")?;
    let target = ServiceTarget::Export {
        name: "agent".into(),
    };
    let services = owner.services.select_method(&target, "memory")?;
    let request = services.request_with_work(
        maka_capabilities::call::Identity::Agent {
            execution: access.execution().clone(),
            operation_id: None,
        },
        CancellationToken::new(),
        access.custody().clone(),
    )?;
    let result = request
        .call_target(&target, "memory".into(), input, Attachments::new())?
        .await;
    request.finish().await?;
    result
}

async fn model_write(owner: &Owner, session: &str, input: Value) -> TestResult<bool> {
    use maka_plugin_core::contract::ServiceTarget;
    let access = owner
        .runs
        .state()
        .await
        .controls
        .get(session)
        .and_then(|control| control.access.upgrade())
        .ok_or("execution unavailable")?;
    let target = ServiceTarget::Export {
        name: "agent".into(),
    };
    let services = owner.services.select_method(&target, "changeMemory")?;
    let request = services.request_with_work(
        maka_capabilities::call::Identity::Agent {
            execution: access.execution().clone(),
            operation_id: None,
        },
        CancellationToken::new(),
        access.custody().clone(),
    )?;
    let result = request
        .begin_mutation_target(
            &target,
            "changeMemory".into(),
            input,
            Uuid::new_v4(),
            json!({"test":"memory-denied-write"}),
            Attachments::new(),
        )?
        .await?
        .completion()
        .await;
    result.cleanup?;
    request.finish().await?;
    Ok(!matches!(
        result.reply.receipt,
        Receipt::Recorded {
            outcome: OperationOutcome::Returned {
                result: OperationResult::Success { .. }
            },
            ..
        }
    ))
}

async fn git_scope_acceptance(client: &HostClient, base: &Path) -> TestResult<()> {
    let repo = base.join("workspace/repository");
    let worktree = base.join("workspace/linked-worktree");
    let paths = (repo.clone(), worktree.clone());
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let (repo, worktree) = paths;
        std::fs::create_dir_all(repo.join("selected")).map_err(|e| e.to_string())?;
        for args in [
            vec!["init"],
            vec![
                "-c",
                "user.name=Memory test",
                "-c",
                "user.email=memory@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "fixture",
            ],
            vec!["worktree", "add", "--detach", worktree.to_str().unwrap()],
        ] {
            let output = std::process::Command::new("git")
                .current_dir(&repo)
                .args(args)
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).into_owned());
            }
        }
        Ok(())
    })
    .await??;
    let mut ids = Vec::new();
    for path in [&repo, &worktree, &repo.join("selected")] {
        let created = call(client,"agent","create",json!({"title":"Git memory scope","labels":[],"workspace":{"kind":"directory","path":path}})).await?;
        assert_eq!(created["kind"], "created", "{created}");
        ids.push(created["session"]["id"].clone());
    }
    let saved = call(client,"agent","changeMemory",json!({"scope":{"kind":"project","sessionId":ids[0]},"edit":{"kind":"create","body":"Shared by worktrees"}})).await?;
    assert_eq!(
        call(
            client,
            "agent",
            "memory",
            json!({"scope":{"kind":"project","sessionId":ids[1]},"id":saved["id"]})
        )
        .await?["body"],
        "Shared by worktrees"
    );
    assert!(
        call(
            client,
            "agent",
            "memory",
            json!({"scope":{"kind":"project","sessionId":ids[2]},"id":saved["id"]})
        )
        .await?
        .is_null()
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn memory_host_isolation_uses_real_deployments() {
    let mut first = Rig::new().unwrap();
    let mut second = Rig::new().unwrap();
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(120), async {
        let one = bootstrap(first.directory.path(), "http://127.0.0.1:1/v1".into(), false).await?;
        let two = bootstrap(second.directory.path(), "http://127.0.0.1:1/v1".into(), false).await?;
        attach(&mut first, &one).await?;
        attach(&mut second, &two).await?;
        let saved = call(first.client.as_ref().unwrap(),"agent","changeMemory",json!({"scope":{"kind":"personal"},"edit":{"kind":"create","body":"First Host only"}})).await?;
        let other = second.client.as_ref().unwrap();
        assert!(call(other,"agent","memory",json!({"scope":{"kind":"personal"},"id":saved["id"]})).await?.is_null());
        assert_eq!(call(other,"agent","changeMemory",json!({"scope":{"kind":"personal"},"edit":{"kind":"delete","id":saved["id"],"expectedRevision":1}})).await?["kind"],"not_found");
        assert_eq!(call(first.client.as_ref().unwrap(),"agent","memory",json!({"scope":{"kind":"personal"},"id":saved["id"]})).await?["body"],"First Host only");
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>(())
    })).catch_unwind().await;
    let a = first.finish().await;
    let b = second.finish().await;
    assert!(matches!(outcome, Ok(Ok(Ok(())))), "{outcome:?}");
    assert!(a.is_empty() && b.is_empty(), "{a:?} {b:?}");
}
