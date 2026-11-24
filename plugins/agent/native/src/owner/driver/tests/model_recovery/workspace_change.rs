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
async fn missing_workspace_can_be_replaced_without_moving_peer_sessions() {
    use futures_util::FutureExt;
    use std::panic::AssertUnwindSafe;

    let mut rig = Rig::new().expect("workspace recovery fixture");
    let base = rig.directory.path().to_owned();
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let boot = bootstrap(
        &base,
        format!("http://{}/v1", listener.local_addr().unwrap()),
        false,
    )
    .await
    .unwrap();
    let (mut requests, provider) = bot_tools::observed_provider(listener);
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(60), async {
        let root = rig.directory.path().join("workspace");
        let old = root.join("old");
        let new = root.join("new");
        std::fs::create_dir_all(&old)?;
        std::fs::create_dir_all(&new)?;
        std::fs::write(new.join("replacement.txt"), "new workspace")?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().ok_or("client missing")?;
        let catalog = call(client, "settings", "connections", json!({"kind":"start"})).await?;
        let connection = call(client, "settings", "create", json!({
            "expectedCatalogRevision": catalog["revision"],
            "connection": {
                "slug": "workspace-recovery", "name": "Workspace recovery",
                "provider": {"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"ollama"},
                "configuration": {"baseUrl":boot.base_url},
                "enabled":true, "enabledModelIds":["llama3.2"],
                "modelOverrides":{"llama3.2":{"apiProtocol":"openai-chat-completions","codeMode":false}}
            }
        })).await?;
        let backend = json!({
            "kind":"model", "connectionId":connection["connection"]["connectionId"], "modelId":"llama3.2"
        });
        let call = |method, input| call(client, "agent", method, input);
        let create = |title| {
            call(
                "create",
                json!({
                    "title": title, "labels": [], "backend": backend,
                    "workspace": {"kind": "directory", "path": &old},
                }),
            )
        };
        let first = create("First conversation").await?;
        let peer = create("Peer conversation").await?;
        let id = &first["session"]["id"];
        let peer_id = &peer["session"]["id"];
        let available =
            |id: &serde_json::Value| call("sessionWorkspaceAvailable", json!({"sessionId": id}));
        assert_eq!(available(id).await?, true);
        let session = id.as_str().ok_or("session ID missing")?;
        let sent = call("send", json!({"sessionId": id, "message": "remember the original task"})).await?;
        let (_, reply) = requests.recv().await.ok_or("initial model request missing")?;
        reply.send(bot_tools::completion(json!({"role":"assistant","content":"original answer"}), "stop"))
            .map_err(|_| "initial model request closed")?;
        quiescent_message(client, session, &sent["messageId"]).await?;
        let observed = call("observe", json!({"sessionId": id})).await?;
        let revision = observed["session"]["revision"].as_u64().ok_or("session revision missing")?;
        std::fs::remove_dir(&old)?;
        assert_eq!(available(id).await?, false);
        let preflight = call("projectMcp", json!({"sessionId": id})).await
            .expect_err("desktop MCP preflight must reject the missing workspace");
        assert_eq!(preflight.to_string(), "agent_workspace_unavailable");
        let send = call("send", json!({"sessionId": id, "message": "hello"})).await?;
        assert_eq!(send["kind"], "rejected");
        assert_eq!(send["reason"], "workspace_unavailable");

        let change = |revision, path: &std::path::Path| {
            call(
                "changeSessionWorkspace",
                json!({
                    "sessionId": id, "expectedRevision": revision, "path": path,
                }),
            )
        };
        let missing = change(revision, &old).await?;
        assert_eq!(missing["reason"], "workspace_unavailable");
        let changed = change(revision, &new).await?;
        assert_eq!(changed["kind"], "changed");
        assert_eq!(change(revision, &new).await?["kind"], "revision_conflict");
        assert_eq!(available(id).await?, true);
        call("projectMcp", json!({"sessionId": id})).await?;
        assert_eq!(available(peer_id).await?, false);
        let observed = call("observe", json!({"sessionId": id})).await?;
        assert_eq!(&observed["session"]["id"], id);
        assert_ne!(
            observed["session"]["workspace"]["projectId"],
            first["session"]["workspace"]["projectId"]
        );
        let files = call(
            "listFiles",
            json!({"sessionId": id, "path": null, "after": null}),
        )
        .await?;
        let page: maka_fs_tools::files::FilePage = serde_json::from_value(files)?;
        assert_eq!(
            page.entries,
            vec![maka_fs_tools::files::FileEntry {
                path: maka_fs_tools::path::WorkspacePath::from_bytes(b"replacement.txt")?,
                kind: maka_fs_tools::files::FileKind::File,
            }]
        );
        let sent = call("send", json!({"sessionId": id, "message": "continue in the new folder"})).await?;
        assert_eq!(sent["kind"], "queued");
        let (request, reply) = requests.recv().await.ok_or("replacement model request missing")?;
        assert!(request["messages"].to_string().contains("remember the original task"));
        reply.send(bot_tools::completion(json!({"role":"assistant","content":"replacement answer"}), "stop"))
            .map_err(|_| "replacement model request closed")?;
        quiescent_message(client, session, &sent["messageId"]).await?;

        std::fs::create_dir(&old)?;
        let paused = rig.completion_gate.arm("send");
        let (late_send, rebind) = tokio::join!(
            call("send", json!({"sessionId": id, "message": "prepared against the old boundary"})),
            async {
                let release = paused.await?;
                for path in [&old, &new] {
                    let observed = call("observe", json!({"sessionId": id})).await?;
                    let revision = observed["session"]["revision"].as_u64().ok_or("session revision missing")?;
                    let changed = change(revision, path).await?;
                    assert_eq!(changed["kind"], "changed", "{changed}");
                }
                release.send(()).map_err(|_| "send completion gate closed")?;
                Ok::<_, Box<dyn Error + Send + Sync>>(())
            },
        );
        rebind?;
        let failure = late_send.expect_err("reusing the binding must not restore old send authority");
        assert!(failure.to_string().contains("agent_session_workspace_changed"), "{failure}");

        let paused_send = rig.completion_gate.arm("send");
        let (send_returned, wait_for_send) = oneshot::channel();
        let (sent, rejected) = tokio::join!(
            async {
                let result = call("send", json!({"sessionId": id, "message": "queued before the rebind"})).await;
                let _ = send_returned.send(());
                result
            },
            async {
                let release_send = paused_send.await?;
                let observed = call("observe", json!({"sessionId": id})).await?;
                let paused_rebind = rig.completion_gate.arm("changeSessionWorkspace");
                let mut rebind = client.call(
                    "agent",
                    "changeSessionWorkspace".into(),
                    json!({"sessionId":id, "expectedRevision":observed["session"]["revision"], "path":old}),
                    Attachments::new(),
                ).await?;
                rebind.start().await?;
                assert!(matches!(rebind.receive().await?, Reply::Prepared { .. }));
                let (reply, release) = tokio::join!(
                    rebind.confirm(json!({"test":"workspace-rebind-busy"})),
                    async {
                        let release_rebind = paused_rebind.await?;
                        release_send.send(()).map_err(|_| "send completion gate closed")?;
                        wait_for_send.await?;
                        release_rebind.send(()).map_err(|_| "rebind completion gate closed")?;
                        Ok::<_, Box<dyn Error + Send + Sync>>(())
                    }
                );
                release?;
                let Reply::Mutation { reply, cleanup } = reply? else {
                    return Err("missing rebind receipt".into());
                };
                cleanup?;
                rebind.close().await?;
                Ok::<_, Box<dyn Error + Send + Sync>>(reply.receipt)
            },
        );
        let rejected = rejected?;
        assert!(matches!(rejected,
            Receipt::Recorded {
                outcome: OperationOutcome::Returned {
                    result: OperationResult::Success { value },
                },
                cleanup: OperationCleanup::Confirmed,
            } if value == json!({"kind":"rejected", "reason":"busy"})
        ));
        let sent = sent?;
        assert_eq!(sent["kind"], "queued");
        let (_, reply) = requests.recv().await.ok_or("queued model request missing")?;
        reply.send(bot_tools::completion(json!({"role":"assistant","content":"queued answer"}), "stop"))
            .map_err(|_| "queued model request closed")?;
        quiescent_message(client, session, &sent["messageId"]).await?;
        let observed = call("observe", json!({"sessionId": id})).await?;
        let revision = observed["session"]["revision"].as_u64().ok_or("session revision missing")?;
        assert_eq!(change(revision, &old).await?["kind"], "changed");
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    provider.abort();
    let cleanup = rig.finish().await;
    assert!(matches!(&outcome, Ok(Ok(Ok(())))), "{outcome:?}");
    assert!(cleanup.is_empty(), "{cleanup:?}");
}
