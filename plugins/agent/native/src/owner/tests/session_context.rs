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

fn system_texts(request: &Value) -> impl Iterator<Item = &str> {
    request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "system")
        .map(|message| message["content"].as_str().unwrap())
}

fn context_payload<'a>(texts: impl IntoIterator<Item = &'a str>) -> Value {
    let mut contexts = Vec::new();
    for text in texts {
        for (offset, _) in text
            .char_indices()
            .filter(|(_, character)| *character == '{')
        {
            if let Some(Ok(value)) = serde_json::Deserializer::from_str(&text[offset..])
                .into_iter::<Value>()
                .next()
                && value.get("cwd").is_some()
                && value.get("sessionId").is_some()
            {
                contexts.push(value);
            }
        }
    }
    assert_eq!(
        contexts.len(),
        1,
        "one unambiguous session context payload: {contexts:?}"
    );
    contexts.pop().unwrap()
}

pub(super) fn assert_current_context(request: &Value, session: &Value) {
    let context = context_payload(system_texts(request));
    assert_eq!(context["cwd"], session["workspace"]["path"]);
    assert_eq!(context["sessionId"], session["id"]);
}

pub(super) async fn composition(
    fixture: &Fixture,
    session: &str,
) -> maka_agent_facts::composition::RequestComposition {
    let prefix = fixture
        .session(&(session))
        .await
        .scoped_prefix(
            maka_agent_facts::event::LogScope::Session { id: session.into() },
            128,
            1024 * 1024,
        )
        .await
        .unwrap();
    let requested = prefix
        .events
        .iter()
        .rev()
        .find(|row| {
            matches!(
                row.event.fact,
                maka_agent_facts::event::Fact::ModelRequested { .. }
            )
        })
        .expect("actual model dispatch must retain ModelRequested");
    fixture
        .session(session)
        .await
        .request_composition(session, &requested.event.id)
        .await
        .unwrap()
        .unwrap()
}

pub(super) fn assert_frozen_context(
    request: &Value,
    frozen: &maka_agent_facts::composition::RequestComposition,
) {
    assert_eq!(
        context_payload(system_texts(request)),
        context_payload(frozen.dynamic_context.iter().map(String::as_str)),
        "durable dynamic context must match the actual outgoing context payload",
    );
}

#[tokio::test]
async fn no_agents_file_still_exposes_each_selected_workspace_and_current_session() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::new(&format!("http://{}/v1", listener.local_addr().unwrap()), None).await;
        #[cfg(not(windows))]
        let child_name = "资料\"selected";
        #[cfg(windows)]
        let child_name = "资料 selected";
        let child_path = fixture.workspace.join(child_name);
        std::fs::create_dir(&child_path).unwrap();
        let roots = fixture.query("directories", json!({"kind":"roots"})).await.unwrap();
        let children = fixture.query("directories", json!({"kind":"children", "selection":roots["roots"][0]["selection"], "after":null})).await.unwrap();
        let child = children["children"].as_array().unwrap().iter().find(|entry| entry["path"] == child_path.to_str().unwrap()).unwrap();
        let mut captured = Vec::new();
        for (title, selection) in [
            ("Quoted Unicode workspace", child["selection"].clone()),
            ("Independent workspace", roots["roots"][1]["selection"].clone()),
        ] {
            let created = fixture.mutation(2, "create", json!({"title":title,"labels":[],"workspace":{"kind":"directory","selection":selection}}), Uuid::new_v4()).await.unwrap();
            let session = created["session"].clone();
            let id = session["id"].as_str().unwrap();
            fixture.send(id).await.unwrap();
            let (mut socket, _) = listener.accept().await.unwrap();
            let outgoing = request(&mut socket).await;
            response(&mut socket).await;
            fixture.drained().await;
            let frozen = composition(&fixture, id).await;
            captured.push((session, outgoing, frozen));
        }
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();

        assert!(!child_path.join("AGENTS.md").exists());
        assert_eq!(captured[0].0["workspace"]["path"], child_path.to_str().unwrap());
        assert_ne!(captured[0].0["id"], captured[1].0["id"]);
        assert_ne!(captured[0].0["workspace"]["path"], captured[1].0["workspace"]["path"]);
        for (session, outgoing, frozen) in captured {
            assert_current_context(&outgoing, &session);
            assert_frozen_context(&outgoing, &frozen);
        }
    }).await.unwrap();
}

#[tokio::test]
async fn fork_compaction_and_child_send_rebind_context_without_changing_parent_evidence() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::new(&format!("http://{}/v1", listener.local_addr().unwrap()), None).await;
        let created = fixture.mutation(2, "create", fixture.create_input("Parent context").await, Uuid::new_v4()).await.unwrap();
        let parent = created["session"].clone();
        let parent_id = parent["id"].as_str().unwrap();
        let sent = fixture.send(parent_id).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let parent_request = request(&mut socket).await;
        response_with_text(&mut socket, "Completed parent history for the child summary.").await;
        fixture.drained().await;
        let original = composition(&fixture, parent_id).await;
        let boundary = fixture.session(parent_id).await.invocation_boundary(parent_id, sent["invocationId"].as_str().unwrap()).await.unwrap().unwrap().0;
        let observed = fixture.query("observe", json!({"sessionId":parent_id})).await.unwrap();
        let forked = fixture.mutation(2, "fork", json!({"sessionId":parent_id,"expectedRevision":observed["session"]["revision"],"turnId":boundary.invocation.turn_id,"title":"Child context","labels":[]}), Uuid::new_v4()).await.unwrap();
        let child = forked["session"].clone();
        let child_id = child["id"].as_str().unwrap();
        let compacted = fixture.mutation(2, "compact", json!({"sessionId":child_id,"model":fixture.selection().await,"prompt":"Summarize the retained parent conversation."}), Uuid::new_v4()).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let summary_request = request(&mut socket).await;
        response_with_text(&mut socket, "The parent conversation completed before this independent child.").await;
        fixture.drained().await;
        let summary_composition = composition(&fixture, child_id).await;
        fixture.send(child_id).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let child_request = request(&mut socket).await;
        response(&mut socket).await;
        fixture.drained().await;
        let child_composition = composition(&fixture, child_id).await;
        let retained_parent = composition(&fixture, parent_id).await;
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();

        assert_eq!(forked["kind"], "forked");
        assert_eq!(compacted["kind"], "started");
        assert_ne!(parent["id"], child["id"]);
        assert_eq!(parent["workspace"], child["workspace"]);
        assert_current_context(&parent_request, &parent);
        assert_current_context(&summary_request, &child);
        assert_current_context(&child_request, &child);
        assert_frozen_context(&parent_request, &original);
        assert_frozen_context(&summary_request, &summary_composition);
        assert_frozen_context(&child_request, &child_composition);
        assert_eq!(retained_parent, original, "child summary must not rewrite inherited parent composition");
    }).await.unwrap();
}

#[tokio::test]
async fn resume_keeps_current_session_workspace_and_accepted_assistant_instructions() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join(".maka")).unwrap();
        std::fs::write(home.path().join(".maka/AGENTS.md"), "Retain the accepted instruction alpha-context-703.\n").unwrap();
        let fixture = Fixture::configured(&format!("http://{}/v1", listener.local_addr().unwrap()), None, None, None, |settings| {
            settings.assistant = Some(contract::AssistantConfiguration { home: Some(home.path().to_str().unwrap().into()) });
        }).await;
        let created = fixture.mutation(2, "create", fixture.create_input("Resumable context").await, Uuid::new_v4()).await.unwrap();
        let session = created["session"].clone();
        let id = session["id"].as_str().unwrap();
        let sent = fixture.send(id).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let original_request = request(&mut socket).await;
        fixture.mutation(2, "stop", json!({"sessionId":id,"invocationId":sent["invocationId"]}), Uuid::new_v4()).await.unwrap();
        drop(socket);
        fixture.drained().await;
        let original_composition = composition(&fixture, id).await;
        let source = fixture.query("execution", json!({"sessionId":id,"invocationId":sent["invocationId"]})).await.unwrap();
        std::fs::write(home.path().join(".maka/AGENTS.md"), "Later replacement beta-context-704.\n").unwrap();
        let resumed = fixture.mutation(2, "resume", json!({"sessionId":id,"sourceInvocationId":sent["invocationId"],"sourceHighWater":source["execution"]["highWater"],"model":fixture.selection().await}), Uuid::new_v4()).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let resumed_request = request(&mut socket).await;
        response(&mut socket).await;
        fixture.drained().await;
        let resumed_composition = composition(&fixture, id).await;
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();

        assert_eq!(source["execution"]["state"], "cancelled");
        assert_eq!(resumed["kind"], "started");
        assert_current_context(&original_request, &session);
        assert_current_context(&resumed_request, &session);
        assert_frozen_context(&original_request, &original_composition);
        assert_frozen_context(&resumed_request, &resumed_composition);
        let accepted = original_composition.system_prompt.as_deref().unwrap();
        assert!(accepted.starts_with("You are [Maka](https://github.com/apache/maka), an AI agent.\n\n<global_instruction>\nRetain the accepted instruction alpha-context-703.\n</global_instruction>"));
        assert!(system_texts(&resumed_request).any(|text| text.contains("alpha-context-703")));
        assert_eq!(resumed_composition.system_prompt, original_composition.system_prompt);
        assert!(!resumed_request["messages"].to_string().contains("beta-context-704"));
    }).await.unwrap();
}

#[tokio::test]
async fn isolated_workspace_context_names_the_actual_managed_directory() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::configured(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            None,
            |settings| settings.isolated_workspaces = true,
        )
        .await;
        worktrees::git(&fixture.workspace, &["init", "--quiet"]);
        worktrees::git(
            &fixture.workspace,
            &["config", "user.email", "test@example.invalid"],
        );
        worktrees::git(&fixture.workspace, &["config", "user.name", "Fixture"]);
        std::fs::write(fixture.workspace.join("tracked.txt"), "source workspace\n").unwrap();
        worktrees::git(&fixture.workspace, &["add", "tracked.txt"]);
        worktrees::git(&fixture.workspace, &["commit", "--quiet", "-m", "base"]);
        fixture.create("Source workspace").await;
        let mut input = fixture.create_input("Managed context").await;
        input["workspace"]["kind"] = json!("isolated_git");
        let created = fixture
            .mutation(2, "create", input, Uuid::new_v4())
            .await
            .unwrap();
        let session = created["session"].clone();
        let id = session["id"].as_str().unwrap();
        fixture.send(id).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let outgoing = request(&mut socket).await;
        response(&mut socket).await;
        fixture.drained().await;
        let frozen = composition(&fixture, id).await;
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();

        let actual = std::path::Path::new(session["workspace"]["path"].as_str().unwrap());
        assert_ne!(actual, fixture.workspace);
        assert_eq!(
            std::fs::read_to_string(actual.join("tracked.txt")).unwrap(),
            "source workspace\n"
        );
        assert_current_context(&outgoing, &session);
        assert_frozen_context(&outgoing, &frozen);
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn project_relocation_compaction_reuses_static_surface_with_current_workspace() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join(".maka")).unwrap();
        std::fs::write(home.path().join(".maka/AGENTS.md"), "Preserve relocation-static-context-706 in summaries.\n").unwrap();
        let fixture = Fixture::configured(&format!("http://{}/v1", listener.local_addr().unwrap()), None, None, None, |settings| {
            settings.assistant = Some(contract::AssistantConfiguration { home: Some(home.path().to_str().unwrap().into()) });
        }).await;
        let roots = fixture.query("directories", json!({"kind":"roots"})).await.unwrap();
        let registered = fixture.mutation(2, "project", json!({"kind":"register","selection":roots["roots"][0]["selection"],"expected":null}), Uuid::new_v4()).await.unwrap();
        let created = fixture.mutation(2, "create", json!({"title":"Relocated context","labels":[],"workspace":{"kind":"project","project":registered["project"]["reference"],"selection":roots["roots"][0]["selection"]}}), Uuid::new_v4()).await.unwrap();
        let initial_session = created["session"].clone();
        let id = initial_session["id"].as_str().unwrap();
        fixture.send(id).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let initial_request = request(&mut socket).await;
        response_with_text(&mut socket, "Completed main request before the project was relocated.").await;
        fixture.drained().await;
        let original = composition(&fixture, id).await;
        let projects = fixture.query("projects", json!({"kind":"list","cursor":null})).await.unwrap();
        let relocated = fixture.mutation(2, "project", json!({"kind":"relocate","project":projects["projects"][0]["reference"],"selection":roots["roots"][1]["selection"],"destination":null}), Uuid::new_v4()).await.unwrap();
        let current_session = fixture.query("observe", json!({"sessionId":id})).await.unwrap()["session"].clone();
        let prior_context = fixture.session(id).await.read_model_view(id, None).await.unwrap();
        let prior_composition = match prior_context.latest_main {
            maka_event_log::context::LatestMainContext::Selected(latest) =>
                fixture.session(id).await.completed_request_composition(id, latest.sequence).await.unwrap(),
            _ => None,
        };
        let compacted = fixture.mutation(2, "compact", json!({"sessionId":id,"model":fixture.selection().await,"prompt":"Summarize the conversation in its relocated workspace."}), Uuid::new_v4()).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let summary_request = request(&mut socket).await;
        response_with_text(&mut socket, "The conversation continues in the relocated project directory.").await;
        fixture.drained().await;
        let summary_composition = composition(&fixture, id).await;
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();

        assert_eq!(relocated["kind"], "committed");
        assert_eq!(compacted["kind"], "started");
        assert_eq!(current_session["id"], initial_session["id"]);
        assert_ne!(current_session["workspace"]["path"], initial_session["workspace"]["path"]);
        assert_eq!(current_session["workspace"]["path"], roots["roots"][1]["path"]);
        assert_eq!(prior_composition.as_ref(), Some(&original), "relocation retains the completed main surface with its old cwd");
        assert!(original.system_prompt.as_deref().unwrap().contains("relocation-static-context-706"));
        assert_eq!(summary_composition.system_prompt, original.system_prompt, "manual compaction must reuse the prior static surface");
        assert!(system_texts(&summary_request).any(|text| text.contains("relocation-static-context-706")));
        assert_ne!(summary_composition.dynamic_context, original.dynamic_context, "summary must replace the old cwd after relocation");
        assert_current_context(&initial_request, &initial_session);
        assert_current_context(&summary_request, &current_session);
        assert_frozen_context(&initial_request, &original);
        assert_frozen_context(&summary_request, &summary_composition);
    }).await.unwrap();
}
