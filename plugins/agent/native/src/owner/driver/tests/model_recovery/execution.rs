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
use maka_event_log::checkpoints::{
    Scope as CheckpointScope,
    execution::{Claim, ClaimResult, Execution, ExecutionAuthority, Permissions, Status},
    repository::{SessionRepository, Source, files::FileRepository},
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn execution_grant_gates_real_host_and_drains_before_handoff() {
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

async fn exercise(rig: &mut Rig) -> TestResult<()> {
    let base = rig.directory.path().to_path_buf();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let boot = bootstrap_with(
        &base,
        format!("http://{}/v1", listener.local_addr()?),
        |config| {
            config["todo"] = json!(true);
            config["permissions"]["access"] = json!("danger_full_access");
            config["permissions"]["requestPermissions"] = json!(true);
        },
    )
    .await?;
    let (requests, mut observed) = tokio::sync::mpsc::channel(1);
    let app = axum::Router::new().route(
        "/v1/chat/completions",
        axum::routing::post(move |request: axum::extract::Request| {
            let requests = requests.clone();
            async move {
                let bytes = axum::body::to_bytes(request.into_body(), 8 * 1024 * 1024)
                    .await
                    .unwrap();
                let request: Value = serde_json::from_slice(&bytes).unwrap();
                let (reply, response) = oneshot::channel::<String>();
                let _ = requests.send((request, reply)).await;
                (
                    [("content-type", "text/event-stream")],
                    response.await.unwrap_or_default(),
                )
            }
        }),
    );
    let provider = tokio::spawn(async move { axum::serve(listener, app).await });
    // Abort-on-drop owns the fixture server even on assertion failure.
    let _provider = AbortOnDrop(provider);
    attach(rig, &boot).await?;
    let client = rig.client.as_ref().unwrap();
    let catalog = call(client, "settings", "connections", json!({"kind":"start"})).await?;
    let connection = call(client, "settings", "create", json!({
        "expectedCatalogRevision":catalog["revision"],
        "connection":{"slug":"execution","name":"Execution fixture",
            "provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"ollama"},
            "configuration":{"baseUrl":boot.base_url},"enabled":true,"enabledModelIds":["llama3.2"],
            "modelOverrides":{"llama3.2":{"codeMode":false,"apiProtocol":"openai-chat-completions"}}}
    })).await?;
    assert_eq!(connection["kind"], "committed");
    let backend = json!({"kind":"model","connectionId":connection["connection"]["connectionId"],"modelId":"llama3.2"});
    let mut sessions = Vec::new();
    for title in ["Authorized", "Outside grant"] {
        let created = call(
            client,
            "agent",
            "create",
            json!({
                "title":title,"automaticTitle":false,"labels":[],
                "workspace":{"kind":"directory","path":base.join("workspace")}
            }),
        )
        .await?;
        sessions.push(
            created["session"]["id"]
                .as_str()
                .ok_or("Session missing")?
                .to_owned(),
        );
    }
    let source = {
        let owner = rig.captured.lock().unwrap().clone().unwrap();
        Source {
            root_id: owner.store.owned_root()?.root_id().into(),
            scope: CheckpointScope {
                state_domain: owner.data_source.state_domain.clone(),
                deployment: owner.data_source.deployment,
                namespace: owner.data_source.namespace.clone(),
            },
            session: sessions[0].clone(),
        }
    };
    assert!(rig.finish().await.is_empty());
    rig.client = None;
    rig.host = None;
    rig.store = None;
    rig.captured.lock().unwrap().take();
    rig.stop_serving = CancellationToken::new();

    let directory = tempfile::tempdir()?;
    let repository = Arc::new(FileRepository::open(directory.path())?);
    let binding = repository.bind(source, Uuid::new_v4()).await?;
    let request = Claim {
        activation: Uuid::new_v4(),
        binding: binding.clone(),
        start: None,
        permissions: Permissions {
            sandbox: maka_sandbox::Sandbox::Managed {
                filesystem: maka_sandbox::filesystem::Policy::uniform(
                    maka_sandbox::filesystem::Access::Read,
                ),
                network: maka_sandbox::Network::Denied,
            },
            tools: Some(vec!["todo_read".into()]),
        },
        lease_millis: 120_000,
    };
    let ClaimResult::Granted { grant, .. } = repository.claim(request.clone()).await? else {
        return Err("grant missing".into());
    };
    let grant = *grant;
    let execution = Execution::attach(repository.clone(), grant.clone()).await?;
    let storage = repository
        .storage(binding.identity.agent)?
        .with_execution(execution.clone())?;
    let root_base = base.clone();
    let root = tokio::task::spawn_blocking(move || {
        RootOwner::open(
            &root_base.join("root"),
            &RootNamespaces {
                ownership: root_base.join("owners"),
                control: root_base.join("control"),
            },
        )
    })
    .await??;
    let mut migrations = maka_event_log::ROOT_MIGRATIONS.to_vec();
    migrations.extend_from_slice(maka_agent_state::MIGRATIONS);
    migrations.sort_by_key(|m| m.version);
    let store = Arc::new(
        RootStore::open_with_checkpoint_storage(Arc::new(root), &migrations, Some(storage)).await?,
    );
    rig.attach_host(store, boot.deployment, boot.gateway, true, None)
        .await?;
    let client = rig.client.as_ref().unwrap();
    assert!(
        call(
            client,
            "agent",
            "send",
            json!({
                "sessionId":sessions[1],"message":"Not authorized.","backend":backend
            })
        )
        .await
        .is_err()
    );
    let sent = call(
        client,
        "agent",
        "send",
        json!({
            "sessionId":sessions[0],"message":"Read the todo list.","backend":backend
        }),
    )
    .await?;
    assert_eq!(sent["kind"], "queued", "{sent}");
    let (model_request, respond) = observed.recv().await.ok_or("model request missing")?;
    let owner = rig.captured.lock().unwrap().clone().unwrap();
    let access = owner
        .runs
        .state()
        .await
        .controls
        .get(&sessions[0])
        .and_then(|c| c.access.upgrade())
        .ok_or("Run access missing")?;
    assert_eq!(
        access.live_configuration().await?.tools,
        Some(vec!["todo_read".into()])
    );
    let captured = access.fresh().await?;
    let maka_sandbox::Sandbox::Managed { filesystem, .. } =
        &captured.spec.permission_ceiling.sandbox
    else {
        return Err("grant sandbox ceiling was removed".into());
    };
    assert_eq!(
        filesystem
            .compile()?
            .access(&base.join("workspace/new.txt")),
        maka_sandbox::filesystem::Access::Read
    );
    assert_eq!(
        captured.spec.network_approval_ceiling(),
        &maka_sandbox::Network::Denied
    );
    assert_eq!(
        access.network_approval_ceiling()?,
        maka_sandbox::Network::Denied
    );
    let maka_sandbox::Sandbox::Managed { filesystem, .. } = captured.spec.approval_ceiling() else {
        return Err("grant approval ceiling was removed".into());
    };
    assert_eq!(
        filesystem
            .compile()?
            .access(&base.join("workspace/new.txt")),
        maka_sandbox::filesystem::Access::Read
    );
    assert!(owner.restored_data(&captured).await.is_ok());
    // Captures made before execution-managed bootstrap cannot retain wider rights.
    let mut wider = captured.clone();
    wider.spec.permission_ceiling.sandbox = maka_sandbox::Sandbox::Disabled;
    assert!(owner.restored_data(&wider).await.is_err());
    let mut wider = captured.clone();
    wider.spec.filesystem_approval_ceiling = Some(maka_sandbox::filesystem::Policy::uniform(
        maka_sandbox::filesystem::Access::Write,
    ));
    assert!(owner.restored_data(&wider).await.is_err());
    assert!(
        !model_request["tools"].to_string().contains("todo_write"),
        "{model_request}"
    );
    respond
        .send(super::bot_tools::tool_response("todo_read", json!({})))
        .map_err(|_| "model stopped")?;
    let (after_tool, respond) = observed.recv().await.ok_or("tool result missing")?;
    assert!(
        after_tool["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["role"] == "tool"),
        "{after_tool}"
    );
    respond
        .send(super::bot_tools::completion(
            json!({"role":"assistant","content":"Done."}),
            "stop",
        ))
        .map_err(|_| "model stopped")?;
    quiescent_message(client, &sessions[0], &sent["messageId"]).await?;
    drop(access);
    // The real publisher uses the same generation-aware repository adapter.
    let preview = call(
        client,
        "agent",
        "previewHistoryCheckpoint",
        json!({"sessionId":sessions[0]}),
    )
    .await?;
    let published = call(
        client,
        "agent",
        "publishCheckpoint",
        json!({
            "sessionId":sessions[0],"expectedRevision":null,
            "confirmedSubtreeDigest":preview["subtreeDigest"],"workspaceConsistency":null
        }),
    )
    .await?;
    assert_eq!(published["state"]["kind"], "published", "{published}");
    let head = repository
        .read_head(binding.identity.clone())
        .await?
        .ok_or("Head missing")?;
    let next = Claim {
        activation: Uuid::new_v4(),
        start: Some(head.head.revision),
        ..request
    };

    call(
        client,
        "agent",
        "send",
        json!({
            "sessionId":sessions[0],"message":"Keep the model request pending.","backend":backend
        }),
    )
    .await?;
    let (_, held_response) = observed.recv().await.ok_or("held request missing")?;
    let access = owner
        .runs
        .state()
        .await
        .controls
        .get(&sessions[0])
        .and_then(|c| c.access.upgrade())
        .ok_or("Run access missing")?;
    assert_eq!(repository.revoke(grant.clone()).await?, Status::Draining);
    assert_eq!(repository.claim(next.clone()).await?, ClaimResult::Busy);
    assert!(
        access.live_configuration().await.is_err(),
        "old model/tool admission must close"
    );
    assert!(call(client, "agent", "send", json!({
        "sessionId":sessions[0],"message":"Old writer must not start again.","backend":backend
    })).await.is_err());
    drop(held_response);
    drop(access);
    rig.host.as_ref().unwrap().stop_execution().await?;
    assert_eq!(repository.observe(grant.clone()).await?, Status::Stopped);
    assert_eq!(
        repository.claim(next.clone()).await?,
        ClaimResult::Busy,
        "rejected activation retains original reply"
    );
    let successor = repository
        .claim(Claim {
            activation: Uuid::new_v4(),
            ..next
        })
        .await?;
    assert!(
        matches!(successor, ClaimResult::Granted { grant: g, .. } if g.generation == grant.generation + 1)
    );
    assert!(
        observed.try_recv().is_err(),
        "revoked Host issued another model request"
    );
    Ok(())
}

struct AbortOnDrop<T>(tokio::task::JoinHandle<T>);
impl<T> Drop for AbortOnDrop<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}
