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
use std::path::{Path, PathBuf};
pub(super) fn git(path: &Path, args: &[&str]) -> String {
    let result = std::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap().trim().to_owned()
}
async fn isolated(f: &Fixture, contents: &str) -> (String, PathBuf, Value, Uuid) {
    git(&f.workspace, &["init", "--quiet"]);
    git(
        &f.workspace,
        &["config", "user.email", "test@example.invalid"],
    );
    git(&f.workspace, &["config", "user.name", "Fixture"]);
    std::fs::write(f.workspace.join("tracked.txt"), contents).unwrap();
    git(&f.workspace, &["add", "tracked.txt"]);
    git(&f.workspace, &["commit", "--quiet", "-m", "base"]);
    // This ordinary native Session has already initialized an untracked marker.
    f.create("Source workspace").await;
    let mut input = f.create_input("Isolated worker").await;
    input["workspace"]["kind"] = json!("isolated_git");
    let operation = Uuid::new_v4();
    let created = f
        .mutation(2, "create", input.clone(), operation)
        .await
        .unwrap();
    assert_eq!(created["kind"], "created", "{created}");
    let session = created["session"]["id"].as_str().unwrap().to_owned();
    let path = PathBuf::from(created["session"]["workspace"]["path"].as_str().unwrap());
    assert!(path.starts_with(f.root.canonicalize().unwrap().join("subagent-worktrees")));
    assert!(
        std::fs::read(path.join("tracked.txt")).unwrap() == contents.as_bytes(),
        "isolated checkout must contain the complete committed base file"
    );
    assert_eq!(git(&f.workspace, &["status", "--porcelain"]), "");
    (session, path, input, operation)
}
async fn read_patch(f: &Fixture, execution: &Value) -> String {
    let mut offset = 0;
    let mut text = String::new();
    loop {
        let page = f
            .query("readPatch", json!({"execution":execution,"offset":offset}))
            .await
            .unwrap();
        assert_eq!(page["kind"], "ready", "{page}");
        assert_eq!(page["offset"], offset);
        text.push_str(page["text"].as_str().unwrap());
        let Some(next) = page["next"].as_u64() else {
            assert_eq!(text.len() as u64, page["patch"]["bytes"].as_u64().unwrap());
            return text;
        };
        assert!(next > offset);
        offset = next;
    }
}
#[tokio::test]
async fn isolated_native_files_and_immutable_patch_survive_successor_and_restart() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut f = Fixture::configured(&format!("http://{}/v1",listener.local_addr().unwrap()), None, None,
            Some(service_tools::Setup::files("write")), |settings| settings.isolated_workspaces = true).await;
        let (session, path, input, operation) = isolated(&f, "base\n").await;
        std::fs::write(f.workspace.join("unsaved.txt"), "source draft").unwrap();
        assert_eq!(f.mutation(2,"create",input.clone(),Uuid::new_v4()).await.unwrap(),json!({"kind":"rejected","reason":"workspace_unavailable"}));
        assert_eq!(std::fs::read_to_string(f.workspace.join("unsaved.txt")).unwrap(),"source draft");
        std::fs::remove_file(f.workspace.join("unsaved.txt")).unwrap();
        let payload = "完整原文\n".repeat(2600);
        files::call(&listener, &f, &session, json!({"path":"tracked.txt","content":payload})).await;
        let original_run=f.latest_run(&session).await.run;
        let execution = json!({"sessionId":session,"runId":original_run});
        assert_eq!(f.mutation(2,"snapshotPatch",execution.clone(),Uuid::new_v4()).await.unwrap()["kind"],"busy");
        assert_eq!(files::finish(&listener,&f).await["kind"], "completed");
        assert_eq!(std::fs::read_to_string(path.join("tracked.txt")).unwrap(), payload);
        assert_eq!(std::fs::read_to_string(f.workspace.join("tracked.txt")).unwrap(), "base\n");
        let borrowed=f.mutation(2,"create",json!({"title":"Borrowed","labels":[],"workspace":{"kind":"session","sessionId":session}}),Uuid::new_v4()).await.unwrap();
        assert_eq!(borrowed["session"]["workspace"]["path"],path.to_str().unwrap());
        let members=f.store.scoped_sessions::<Value>(
            maka_event_log::sessions::CatalogScope::Workspace(path.to_str().unwrap().into()),None,
            maka_event_log::sessions::SessionPosition::Start,
            maka_event_log::sessions::CatalogFilter {roots_only:false,archived_only:false,include_archived:true},
        ).await.unwrap();
        assert_eq!(members.sessions.len(),2);
        assert!(members.next_cursor.is_none());
        assert!(members.sessions.iter().any(|member|member.id==session));
        assert!(members.sessions.iter().any(|member|Some(member.id.as_str())==borrowed["session"]["id"].as_str()));
        let original=f.mutation(2,"snapshotPatch",execution.clone(),Uuid::new_v4()).await.unwrap();
        assert_eq!(original["kind"],"ready", "{original}");
        let patch=read_patch(&f,&execution).await;
        assert!(patch.contains("-base\n+完整原文\n"));
        assert_eq!(patch.matches("+完整原文\n").count(),2600);
        assert!(!patch.contains("maka-workspace"));
        // Neither a later source commit nor a later worker turn reinterprets allocation/results.
        std::fs::write(f.workspace.join("tracked.txt"), "new source\n").unwrap();
        git(&f.workspace,&["commit","-am","new source","--quiet"]);
        let replay=f.mutation(2,"create",input,operation).await.unwrap();
        assert_eq!(replay["session"]["id"],session);
        files::call(&listener,&f,&session,json!({"path":"tracked.txt","content":"successor\n"})).await;
        let archived = files::finish(&listener,&f).await;
        assert_eq!(archived["kind"], "maka.archived_tool_result");
        assert_eq!(archived["toolName"], "WorkspaceFile");
        assert!(archived["page"]["next"].is_object());
        let archive_address = maka_agent_facts::archive::ToolResultAddress::parse(archived["resourceRef"].as_str().unwrap()).unwrap();
        let history=f.history(&session);
        let cut=history.capture().await.unwrap();
        let source=history.resolve_tool_result(&cut,archive_address.event_id()).await.unwrap().expect("actual original tool-result source");
        let successor_receipt=service_tools::tool_return(&f,&session,&source.item).await.body.output;
        let maka_agent_facts::tool_output::ToolOutput::Operation(reply) = &successor_receipt else { panic!("successor must retain the original service receipt") };
        assert_eq!(reply.reference.method, "write");
        assert_eq!(reply.receipt, Receipt::Recorded {
            outcome: OperationOutcome::Returned { result: OperationResult::Success { value: json!({"kind":"completed","value":{
                "kind":"file_write","path":path.join("tracked.txt"),"bytes":"successor\n".len(),"previousContent":payload
            }}) } },
            cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed,
        });
        let foreign=f.history(borrowed["session"]["id"].as_str().unwrap());
        let foreign_cut=foreign.capture().await.unwrap();
        assert!(foreign.resolve_tool_result(&foreign_cut,archive_address.event_id()).await.unwrap().is_none());
        assert_eq!(std::fs::read_to_string(path.join("tracked.txt")).unwrap(), "successor\n");
        assert_eq!(f.mutation(2,"snapshotPatch",execution.clone(),Uuid::new_v4()).await.unwrap(),original);
        assert_eq!(read_patch(&f,&execution).await,patch);
        // A selected path inside Root is not enough to confer the native owned-worktree exception.
        files::call(&listener,&f,&session,json!({"path":f.root.join("must-not-write"),"content":"denied"})).await;
        assert_eq!(files::finish(&listener,&f).await["kind"],"failed");
        assert!(!f.root.join("must-not-write").exists());
        let deployment=f.app.source().unwrap().deployment;
        f.app.shutdown().await.unwrap();
        let mut native=NativeRegistry::default();
        maka_settings_native::provide(&mut native, crate::owner::tests::bundled_catalog()).unwrap();
        crate::owner::tests::provide_all(&mut native, f.owner.durable.clone()).unwrap();
        f.app=Application::start_from_store(f.store.clone(),deployment,native,f.issuer.clone(),Arc::new(Grant(f.issuer.clone(),None)),Some(maka_host_js::factory(Default::default()))).await.unwrap();
        f.app.ready().await.unwrap();
        let reopened_cut=history.capture().await.unwrap();
        let reopened=history.resolve_tool_result(&reopened_cut,archive_address.event_id()).await.unwrap().expect("original source survives restart");
        assert_eq!(service_tools::tool_return(&f,&session,&reopened.item).await.body.output, successor_receipt);
        let foreign=f.history(borrowed["session"]["id"].as_str().unwrap());
        let foreign_cut=foreign.capture().await.unwrap();
        assert!(foreign.resolve_tool_result(&foreign_cut,archive_address.event_id()).await.unwrap().is_none());
        assert_eq!(read_patch(&f,&execution).await,patch);
        assert_eq!(f.query("observe",json!({"sessionId":session})).await.unwrap()["session"]["workspace"]["path"],path.to_str().unwrap());
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}
