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

#[tokio::test]
async fn fork_completed_turn_excludes_active_tail_and_continues_without_replaying_effects() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::with_services(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            Some(service_tools::Setup::files("write")),
        )
        .await;
        let source = f.create("Source conversation").await;
        let uploaded = attachments::upload(
            &f,
            &source,
            "fork-notes.md",
            b"retained Turn A attachment\n",
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        assert_eq!(uploaded["kind"], "uploaded");
        let attachment = uploaded["attachment"]["id"].as_str().unwrap();
        let first = f
            .mutation(
                2,
                "send",
                json!({"sessionId":source,"message":"Turn A: retain this conversation","attachments":[attachment],"model":f.selection().await}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(first["kind"], "started");
        let (mut socket, _) = listener.accept().await.unwrap();
        let initial = request(&mut socket).await;
        assert!(initial["messages"].to_string().contains("Turn A: retain this conversation"));
        assert!(initial["messages"].to_string().contains(attachment));
        files::tool_response(
            &mut socket,
            json!({"path":"fork-effect.txt","content":"original tool effect\n"}),
        )
        .await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let continued = request(&mut socket).await;
        let result: Value = serde_json::from_str(
            continued["messages"]
                .as_array()
                .unwrap()
                .iter()
                .rev()
                .find(|message| message["role"] == "tool")
                .unwrap()["content"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(result["kind"], "completed");
        assert_eq!(std::fs::read_to_string(f.workspace.join("fork-effect.txt")).unwrap(), "original tool effect\n");
        response_with_text(&mut socket, "Turn A completed answer").await;
        f.drained().await;
        let turn_a = f.session(&source).await.invocation_boundary(&source, first["invocationId"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap()
            .0
            .invocation
            .turn_id;

        // A repeated original write would overwrite this independent later edit.
        std::fs::write(f.workspace.join("fork-effect.txt"), "later external edit\n").unwrap();
        let second = f
            .mutation(
                2,
                "send",
                json!({"sessionId":source,"message":"Turn B: active tail must stay out","model":f.selection().await}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(second["kind"], "started");
        let (mut held_b, _) = listener.accept().await.unwrap();
        let active = request(&mut held_b).await;
        assert!(active["messages"].to_string().contains("Turn B: active tail must stay out"));
        let revision = f.owner.session(&source).await.unwrap().revision;
        let input = json!({"sessionId":source,"expectedRevision":revision,"position":{"kind":"through_turn","turnId":turn_a},"title":"Independent branch","labels":["branch"]});
        let mut stale = input.clone();
        stale["expectedRevision"] = json!(revision - 1);
        assert_eq!(f.mutation(2, "fork", stale, Uuid::new_v4()).await.unwrap(), json!({"kind":"revision_conflict","expected":revision-1,"actual":revision}));
        let mut end = input.clone();
        end["position"] = json!({"kind":"end"});
        assert_eq!(f.mutation(2, "fork", end, Uuid::new_v4()).await.unwrap(), json!({"kind":"rejected","reason":"history_unavailable"}));
        let forked = f.mutation(2, "fork", input, Uuid::new_v4()).await.unwrap();
        assert_eq!(forked["kind"], "forked");
        let target = forked["session"]["id"].as_str().unwrap();
        assert_ne!(target, source);
        assert_eq!(forked["session"]["branch"], json!({"sessionId":source,"position":{"kind":"through_turn","turnId":turn_a}}));
        assert_eq!(forked["session"]["title"], "Independent branch");
        assert_eq!(forked["session"]["labels"], json!(["branch"]));
        assert_eq!(forked["session"]["collaborationMode"], "agent");
        assert_eq!(forked["session"]["boundaryRevision"], 0);
        assert_eq!(forked["session"]["activity"], "idle");
        assert_eq!(f.query("observe", json!({"sessionId":target})).await.unwrap()["run"], Value::Null);
        assert_eq!(std::fs::read_to_string(f.workspace.join("fork-effect.txt")).unwrap(), "later external edit\n");

        assert_eq!(f.mutation(2, "send", json!({"sessionId":target,"message":"New target input","model":f.selection().await}), Uuid::new_v4()).await.unwrap()["kind"], "started");
        let (mut socket, _) = listener.accept().await.unwrap();
        let prompt = request(&mut socket).await;
        let messages = prompt["messages"].to_string();
        for retained in ["Turn A: retain this conversation", "Turn A completed answer", "New target input"] {
            assert!(messages.contains(retained), "actual target model prompt must retain {retained}: {messages}");
        }
        let first_user = prompt["messages"].as_array().unwrap().iter()
            .find(|message| message["role"] == "user").unwrap()["content"].as_str().unwrap();
        assert!(first_user.contains("name: \"fork-notes.md\""), "{first_user}");
        assert!(first_user.contains("mime_type: \"text/markdown\""), "{first_user}");
        let read_argument: Value = serde_json::from_str(first_user.lines()
            .find_map(|line| line.strip_prefix("Read argument: "))
            .expect("inherited attachment must expose an actual Read argument")).unwrap();
        let retained_id = read_argument["path"].as_str().unwrap()
            .strip_prefix("maka://runtime/attachments/")
            .expect("inherited attachment must name a Session resource");
        assert_eq!(f.session(target).await.read_artifact_chunk(target, retained_id, 0, 1024).await.unwrap().unwrap().bytes,
            b"retained Turn A attachment\n");
        assert!(!messages.contains("Turn B: active tail must stay out"), "{messages}");
        let historical_tool: Value = serde_json::from_str(
            prompt["messages"].as_array().unwrap().iter().find(|message| message["role"] == "tool").unwrap()["content"].as_str().unwrap(),
        ).unwrap();
        assert_eq!(historical_tool["kind"], "completed");
        response_with_text(&mut socket, "Independent target answer").await;
        response_with_text(&mut held_b, "Turn B source answer").await;
        f.drained().await;
        assert_eq!(std::fs::read_to_string(f.workspace.join("fork-effect.txt")).unwrap(), "later external edit\n", "inherited tool facts must not redispatch their original write");
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn fork_archived_source_narrows_current_authority_and_refuses_managed_sessions() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let f = Fixture::configured(
            "http://127.0.0.1:9/v1",
            None,
            None,
            Some(service_tools::Setup::files("readText")),
            |configuration| {
                configuration.permissions = WorkspacePermissions {
                    access: WorkspaceAccess::ReadOnly,
                    request_permissions: false,
                };
            },
        )
        .await;
        let source = f.create("Archived history").await;
        let original = f.owner.session(&source).await.unwrap();
        // Persist a source accepted under a formerly broader installation.
        let changed = f.session(&source).await.update_session_metadata(
            &source,
            original.revision,
            |configuration: &mut StoredSessionConfiguration| {
                configuration.permissions = WorkspacePermissions {
                    access: WorkspaceAccess::DangerFullAccess,
                    request_permissions: true,
                };
                configuration.tools = Some(vec!["WorkspaceFile".into(), "RetiredTool".into()]);
                configuration.collaboration_mode = CollaborationMode::Plan;
                configuration.boundary_revision = 17;
                Ok(())
            },
        ).await.unwrap();
        assert!(matches!(changed, maka_event_log::sessions::SessionMutation::Committed(_)));
        let archived = f.store.set_session_archived::<StoredSessionConfiguration>(&source, true, now()).await.unwrap();
        let forked = f.mutation(2, "fork", json!({"sessionId":source,"expectedRevision":archived.revision,"position":{"kind":"end"},"title":"Fresh authority","labels":[]}), Uuid::new_v4()).await.unwrap();
        assert_eq!(forked["kind"], "forked");
        assert_eq!(forked["session"]["archived"], false);
        assert_eq!(forked["session"]["permissions"], json!({"access":"read_only","requestPermissions":false}));
        assert_eq!(forked["session"]["tools"], json!(["WorkspaceFile"]));
        assert_eq!(forked["session"]["collaborationMode"], "agent");
        assert_eq!(forked["session"]["boundaryRevision"], 0);
        assert_eq!(forked["session"]["branch"], json!({"sessionId":source,"position":{"kind":"end"}}));
        let target = forked["session"]["id"].as_str().unwrap();
        let fresh = f.owner.session(target).await.unwrap().configuration;
        assert!(fresh.title_is_manual);
        assert_eq!(serde_json::to_value(fresh.workspace).unwrap(), serde_json::to_value(resolve_session(archived.clone()).unwrap().configuration.workspace).unwrap());

        let narrowed = f.session(&source).await.update_session_metadata(
            &source,
            archived.revision,
            |configuration: &mut StoredSessionConfiguration| {
                configuration.tools = Some(vec![]);
                Ok(())
            },
        ).await.unwrap();
        let maka_event_log::sessions::SessionMutation::Committed(narrowed) = narrowed else {
            panic!("source tool restriction commit");
        };
        let no_tools = f.mutation(2, "fork", json!({"sessionId":source,"expectedRevision":narrowed.revision,"position":{"kind":"end"},"title":"No model tools","labels":[]}), Uuid::new_v4()).await.unwrap();
        assert_eq!(no_tools["kind"], "forked");
        assert_eq!(no_tools["session"]["tools"], json!([]));

        let managed = format!("{}{}", f.owner.prefix, Uuid::new_v4().simple());
        f.store.create_plugin_session(
            &maka_event_log::sessions::PluginSession {
                session_id: managed.clone(),
                creator: maka_capabilities::storage::Namespace::new("fork.fixture", maka_plugin_core::scope::Scope::Profile).unwrap(),
                fingerprint: "managed-fork".into(),
                managed: true,
                authority_session_id: None,
            },
            &f.session(&source).await.get_session::<StoredSessionConfiguration>(&source).await.unwrap().unwrap().configuration,
            now(),
        ).await.unwrap();
        let revision = f.owner.session(&managed).await.unwrap().revision;
        assert_eq!(f.mutation(2, "fork", json!({"sessionId":managed,"expectedRevision":revision,"position":{"kind":"end"},"title":"Refused managed fork","labels":[]}), Uuid::new_v4()).await.unwrap(), json!({"kind":"rejected","reason":"managed_session"}));
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn fork_before_turn_copies_only_preceding_history_and_keeps_source_unchanged() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::new(&format!("http://{}/v1", listener.local_addr().unwrap()), None).await;
        let source = f.create("Editable source").await;
        let mut turns = Vec::new();
        for (message, answer) in [("first input", "first answer"), ("second input", "second answer")] {
            let sent = f.mutation(2, "send", json!({"sessionId":source,"message":message,"model":f.selection().await}), Uuid::new_v4()).await.unwrap();
            assert_eq!(sent["kind"], "started");
            let (mut socket, _) = listener.accept().await.unwrap();
            request(&mut socket).await;
            response_with_text(&mut socket, answer).await;
            f.drained().await;
            turns.push(f.session(&source).await.invocation_boundary(&source, sent["invocationId"].as_str().unwrap()).await.unwrap().unwrap().0.invocation.turn_id);
        }
        let original = f.query("history", json!({"sessionId":source,"position":{"kind":"start"}})).await.unwrap();
        let original_facts = f.session(&source).await.scoped_prefix(maka_agent_facts::event::LogScope::Session { id: source.clone() }, 100, 65536).await.unwrap().digest;
        let revision = f.owner.session(&source).await.unwrap().revision;
        for (turn, expected) in [(&turns[0], Vec::<&str>::new()), (&turns[1], vec!["first input", "first answer"])] {
            let input = json!({"sessionId":source,"expectedRevision":revision,"position":{"kind":"before_turn","turnId":turn},"title":"Edited branch","labels":[]});
            let operation = Uuid::new_v4();
            let forked = f.mutation(2, "fork", input.clone(), operation).await.unwrap();
            assert_eq!(forked["kind"], "forked");
            assert_eq!(forked["session"]["branch"], json!({"sessionId":source,"position":{"kind":"before_turn","turnId":turn}}));
            let target = forked["session"]["id"].as_str().unwrap();
            let history = f.query("history", json!({"sessionId":target,"position":{"kind":"start"}})).await.unwrap();
            assert_eq!(history["kind"], "ready");
            let bodies = history["chunks"].as_array().unwrap().iter().filter(|row| row["role"] == "user" || row["role"] == "assistant").map(|row| row["text"].as_str().unwrap()).collect::<Vec<_>>();
            assert_eq!(bodies, expected);
            assert_eq!(f.mutation(2, "fork", input, operation).await.unwrap(), forked, "original operation recovers the same exclusive fork");
            // The actual next model request must inherit exactly the selected prefix.
            assert_eq!(f.mutation(2, "send", json!({"sessionId":target,"message":"edited input","model":f.selection().await}), Uuid::new_v4()).await.unwrap()["kind"], "started");
            let (mut socket, _) = listener.accept().await.unwrap();
            let prompt = request(&mut socket).await;
            let messages = prompt["messages"].as_array().unwrap().iter().filter(|row| row["role"] == "user" || row["role"] == "assistant").map(|row| row["content"].as_str().unwrap()).collect::<Vec<_>>();
            let mut expected_prompt = expected;
            expected_prompt.push("edited input");
            assert_eq!(messages, expected_prompt);
            response_with_text(&mut socket, "edited answer").await;
            f.drained().await;
        }
        let other = f.create("Other conversation").await;
        let other_revision = f.owner.session(&other).await.unwrap().revision;
        for (session, revision, turn) in [(&source, revision, "missing-turn"), (&other, other_revision, turns[0].as_str())] {
            assert_eq!(f.mutation(2, "fork", json!({"sessionId":session,"expectedRevision":revision,"position":{"kind":"before_turn","turnId":turn},"title":"Invalid branch","labels":[]}), Uuid::new_v4()).await.unwrap(), json!({"kind":"rejected","reason":"history_unavailable"}));
        }
        assert_eq!(f.owner.session(&source).await.unwrap().revision, revision);
        assert_eq!(f.query("history", json!({"sessionId":source,"position":{"kind":"start"}})).await.unwrap()["chunks"], original["chunks"]);
        assert_eq!(f.session(&source).await.scoped_prefix(maka_agent_facts::event::LogScope::Session { id: source.clone() }, 100, 65536).await.unwrap().digest, original_facts);
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}
