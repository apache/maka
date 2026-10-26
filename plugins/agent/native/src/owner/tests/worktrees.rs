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
        let boundary = f.session(&session).await.latest_turn_boundary(&session).await.unwrap().unwrap().invocation;
        let execution = json!({"sessionId":session,"invocationId":boundary.invocation_id});
        assert_eq!(f.mutation(2,"snapshotPatch",execution.clone(),Uuid::new_v4()).await.unwrap()["kind"],"busy");
        assert_eq!(files::finish(&listener,&f).await["kind"], "completed");
        assert_eq!(std::fs::read_to_string(path.join("tracked.txt")).unwrap(), payload);
        assert_eq!(std::fs::read_to_string(f.workspace.join("tracked.txt")).unwrap(), "base\n");
        let borrowed=f.mutation(2,"create",json!({"title":"Borrowed","labels":[],"workspace":{"kind":"session","sessionId":session}}),Uuid::new_v4()).await.unwrap();
        assert_eq!(borrowed["session"]["workspace"]["path"],path.to_str().unwrap());
        assert_eq!(f.store.workspace_fence(path.to_str().unwrap()).await.unwrap().0.len(),2);
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
        let successor_receipt = f.session(&session).await.resolve_tool_result(&session, archive_address.event_id()).await.unwrap();
        let maka_agent_facts::tool_output::ToolOutput::Operation(reply) = &successor_receipt else { panic!("successor must retain the original service receipt") };
        assert_eq!(reply.reference.method, "write");
        assert_eq!(reply.receipt, Receipt::Recorded {
            outcome: OperationOutcome::Returned { value: json!({"kind":"completed","value":{
                "kind":"file_write","path":path.join("tracked.txt"),"bytes":"successor\n".len(),"previousContent":payload
            }}) },
            cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed,
        });
        assert!(f.session(borrowed["session"]["id"].as_str().unwrap()).await.resolve_tool_result(borrowed["session"]["id"].as_str().unwrap(), archive_address.event_id()).await.is_err());
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
        crate::owner::tests::provide_all(&mut native).unwrap();
        f.app=Application::start_from_store(f.store.clone(),deployment,native,f.issuer.clone(),Arc::new(Grant(f.issuer.clone(),None)),Some(maka_host_js::factory(Default::default()))).await.unwrap();
        f.app.ready().await.unwrap();
        assert_eq!(f.session(&session).await.resolve_tool_result(&session, archive_address.event_id()).await.unwrap(), successor_receipt);
        assert!(f.session(borrowed["session"]["id"].as_str().unwrap()).await.resolve_tool_result(borrowed["session"]["id"].as_str().unwrap(), archive_address.event_id()).await.is_err());
        assert_eq!(read_patch(&f,&execution).await,patch);
        assert_eq!(f.query("observe",json!({"sessionId":session})).await.unwrap()["session"]["workspace"]["path"],path.to_str().unwrap());
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}
#[tokio::test]
async fn large_completed_isolated_patch_is_complete_and_immutable_after_successor_and_restart() {
    use std::io::Write;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::configured(
        &format!("http://{}/v1", listener.local_addr().unwrap()),
        None,
        None,
        Some(service_tools::Setup::files("edit")),
        |settings| settings.isolated_workspaces = true,
    )
    .await;
    // A small real Edit changes a whole long line in the patch. Neither input
    // blob reaches 50 MiB, while their removed and added lines together do.
    let base = format!("before-{}\n", "x".repeat(25 * 1024 * 1024));
    let expected = base.replacen("before-", "after--", 1);
    let (session, path, _, _) = isolated(&f, &base).await;
    files::call(
        &listener,
        &f,
        &session,
        json!({"path":"tracked.txt","old_string":"before-","new_string":"after--"}),
    )
    .await;
    let boundary = f
        .session(&session)
        .await
        .latest_turn_boundary(&session)
        .await
        .unwrap()
        .unwrap()
        .invocation;
    let execution = json!({"sessionId":session,"invocationId":boundary.invocation_id});
    let oracle = tempfile::tempdir().unwrap();
    let patch_file = oracle.path().join("captured.patch");
    let mut preserved_paths = Vec::new();
    let mut indexes = Vec::new();
    for root in [&f.workspace, &path] {
        preserved_paths.push(root.join("tracked.txt"));
        for name in ["HEAD", "index"] {
            let file = PathBuf::from(git(
                root,
                &["rev-parse", "--path-format=absolute", "--git-path", name],
            ));
            if name == "index" {
                indexes.push(file.clone());
            }
            preserved_paths.push(file);
        }
        let reference = git(root, &["symbolic-ref", "HEAD"]);
        preserved_paths.push(PathBuf::from(git(
            root,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                &reference,
            ],
        )));
    }
    preserved_paths.sort();
    preserved_paths.dedup();
    let preserve = || {
        preserved_paths
            .iter()
            .map(|file| {
                (
                    file.clone(),
                    std::fs::read(file).unwrap(),
                    std::fs::metadata(file).unwrap().modified().unwrap(),
                )
            })
            .collect::<Vec<_>>()
    };
    let unchanged = |preserved: &[(PathBuf, Vec<u8>, std::time::SystemTime)]| {
        for (file, bytes, modified) in preserved {
            if std::fs::read(file)
                .map_err(|error| error.to_string())?
                .as_slice()
                != bytes.as_slice()
                || std::fs::metadata(file)
                    .and_then(|metadata| metadata.modified())
                    .map_err(|error| error.to_string())?
                    != *modified
            {
                return Err(format!("patch observation changed {}", file.display()));
            }
        }
        for index in &indexes {
            if index.with_file_name("index.lock").exists() {
                return Err(format!("patch observation left {}.lock", index.display()));
            }
        }
        Ok(())
    };
    // Every expected RED below becomes a retained Result so both actual owners
    // close even when the original capture rejects the accumulated patch size.
    let observed: Result<(), String> = async {
        let busy = f
            .mutation(2, "snapshotPatch", execution.clone(), Uuid::new_v4())
            .await?;
        if busy != json!({"kind":"busy"}) {
            return Err("live isolated execution must keep snapshotPatch busy".into());
        }
        if files::finish(&listener, &f).await["kind"] != "completed" {
            return Err("actual isolated Edit execution must complete".into());
        }
        if std::fs::read(path.join("tracked.txt")).unwrap() != expected.as_bytes() {
            return Err("actual isolated Edit must produce the complete expected file".into());
        }
        let preserved = preserve();
        let captured = f
            .mutation(2, "snapshotPatch", execution.clone(), Uuid::new_v4())
            .await;
        unchanged(&preserved)?;
        let original = captured?;
        if original["kind"] != "ready"
            || original["patch"]["bytes"].as_u64().unwrap_or(0) <= 50 * 1024 * 1024
        {
            return Err(
                "completed snapshotPatch must publish the complete patch above 50 MiB".into(),
            );
        }
        let first = f
            .query("readPatch", json!({"execution":execution,"offset":0}))
            .await?;
        if first["kind"] != "ready" || first["patch"] != original["patch"] {
            return Err("first readPatch page must identify the original immutable patch".into());
        }
        unchanged(&preserved)?;
        drop(preserved);
        let mut foreign = execution.clone();
        foreign["sessionId"] = json!("foreign-session");
        if f.query("readPatch", json!({"execution":foreign,"offset":0}))
            .await
            .err()
            .as_deref()
            != Some("agent_session_unavailable")
        {
            return Err("readPatch must retain the original Session authority".into());
        }
        files::call(
            &listener,
            &f,
            &session,
            json!({"path":"tracked.txt","old_string":"after--","new_string":"later--"}),
        )
        .await;
        if files::finish(&listener, &f).await["kind"] != "completed" {
            return Err("actual successor Edit execution must complete".into());
        }
        let preserved = preserve();
        if f.mutation(2, "snapshotPatch", execution.clone(), Uuid::new_v4())
            .await?
            != original
        {
            return Err("successor execution must preserve the original patch descriptor".into());
        }
        let deployment = f.app.source().unwrap().deployment;
        f.app.shutdown().await?;
        let mut native = NativeRegistry::default();
        maka_settings_native::provide(&mut native, crate::owner::tests::bundled_catalog()).unwrap();
        crate::owner::tests::provide_all(&mut native).unwrap();
        f.app = Application::start_from_store(
            f.store.clone(),
            deployment,
            native,
            f.issuer.clone(),
            Arc::new(Grant(f.issuer.clone(), None)),
            Some(maka_host_js::factory(Default::default())),
        )
        .await?;
        f.app.ready().await?;
        if f.mutation(2, "snapshotPatch", execution.clone(), Uuid::new_v4())
            .await?
            != original
        {
            return Err("restart must preserve the original patch descriptor".into());
        }
        // Real clients retain a binding for the activation. Rebinding every
        // page would repeatedly hash the entire contract instead of its data.
        let client = f.app.client();
        let binding = f.binding(2).await;
        let mut output = std::fs::File::create(&patch_file).map_err(|error| error.to_string())?;
        let mut offset = 0;
        loop {
            let page = client
                .start(
                    binding.clone(),
                    "readPatch".into(),
                    json!({"execution":execution,"offset":offset}),
                    scope(&f.issuer, true),
                    Attachments::new().into(),
                )
                .await?
                .result()
                .await?;
            if page["kind"] != "ready"
                || page["patch"] != original["patch"]
                || page["offset"] != offset
                || (offset == 0 && page != first)
            {
                return Err(format!(
                    "immutable readPatch page mismatch at offset {offset}"
                ));
            }
            let text = page["text"]
                .as_str()
                .ok_or("readPatch must return UTF-8 text")?;
            if text.is_empty() {
                return Err(format!("readPatch made no progress at offset {offset}"));
            }
            output
                .write_all(text.as_bytes())
                .map_err(|error| error.to_string())?;
            offset += text.len() as u64;
            match page["next"].as_u64() {
                Some(next) if next == offset => {}
                None if offset == original["patch"]["bytes"].as_u64().unwrap() => break,
                _ => {
                    return Err(format!(
                        "readPatch continuation mismatch at offset {offset}"
                    ));
                }
            }
        }
        unchanged(&preserved)?;
        Ok(())
    }
    .await;
    let app_shutdown = f.app.shutdown().await;
    let config_shutdown = f.config.shutdown().await;
    app_shutdown.unwrap();
    config_shutdown.unwrap();
    observed.expect("public Host must preserve a complete large completed-execution patch");
    // Real Git independently consumes every returned hunk, original byte and
    // destination byte. The live managed file already contains successor bytes.
    std::fs::write(oracle.path().join("tracked.txt"), &base).unwrap();
    git(
        oracle.path(),
        &["apply", "--binary", "--", patch_file.to_str().unwrap()],
    );
    assert!(
        std::fs::read(oracle.path().join("tracked.txt")).unwrap() == expected.as_bytes(),
        "complete public patch must apply to exactly the original execution's file bytes"
    );
    assert!(
        std::fs::read(f.workspace.join("tracked.txt")).unwrap() == base.as_bytes(),
        "patch capture and reads must preserve the complete source file"
    );
    assert!(
        std::fs::read(path.join("tracked.txt")).unwrap()
            == base.replacen("before-", "later--", 1).as_bytes(),
        "patch capture and reads must preserve the successor's managed file"
    );
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn isolated_native_shell_preserves_host_protections_and_requires_external_write_approval() {
    tokio::time::timeout(Duration::from_secs(45),async {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f=Fixture::configured(&format!("http://{}/v1",listener.local_addr().unwrap()),None,None,
            Some(service_tools::Setup::isolated_processes()), |settings| settings.isolated_workspaces=true).await;
        let (session,path,_,_)=isolated(&f, "base\n").await;
        std::fs::write(f.root.join("private-secret"),"host-secret").unwrap();
        let external = files::external_directory();
        let outside = external.path().canonicalize().unwrap().join("outside.txt");
        let command=format!("printf child > tracked.txt; cat tracked.txt; if cat '{}'; then exit 77; fi; if printf forbidden > '{}'; then exit 78; fi; if printf forbidden > '{}'; then exit 79; fi; printf isolated-ok",f.root.join("private-secret").display(),f.root.join("must-not-write").display(),outside.display());
        let result=processes::roundtrip(&listener,&f,&session,"Execute",json!({"command":command,"login":false,"timeout_ms":5000})).await;
        assert_eq!(result["kind"],"completed","{result}");
        assert!(result.to_string().contains("isolated-ok"),"{result}");
        assert!(!result.to_string().contains("host-secret"),"{result}");
        assert_eq!(std::fs::read_to_string(path.join("tracked.txt")).unwrap(),"child");
        assert_eq!(std::fs::read_to_string(f.workspace.join("tracked.txt")).unwrap(),"base\n");
        assert!(!f.root.join("must-not-write").exists());
        processes::close(&f).await;
    }).await.unwrap();
}
