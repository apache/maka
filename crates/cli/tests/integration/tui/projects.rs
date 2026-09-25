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
use maka_protocol::{Operation, project::*, session::*};
use serde_json::json;
use std::os::unix::fs::PermissionsExt;

#[test]
fn project_catalog_notifications_and_creation_use_host_project_identity() {
    let directory = tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap();
    let project_path = directory.path().join("中文 project");
    std::fs::create_dir(&project_path).unwrap();
    let host = super::super::candidate::CandidateFixture::new(directory.path().join("root"));
    let browse_path = directory.path().join("browse");
    std::fs::create_dir(&browse_path).unwrap();
    for index in 0..130 {
        std::fs::create_dir(browse_path.join(format!("folder-{index:03}"))).unwrap();
    }
    let browse_target = browse_path.join("目录目标");
    std::fs::create_dir(&browse_target).unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    // Real Host with an explicitly published test directory. Its public API
    // avoids coupling a TUI scenario to deployment packaging/debug binary size.
    let cancellation = tokio_util::sync::CancellationToken::new();
    let _cancel_on_failure = cancellation.clone().drop_guard();
    let (server, registration) = runtime.block_on(async {
        use maka_event_log::root::{RootNamespaces, RootOwner};
        use maka_runtime_host::server::{
            DirectoryRootSpec, Host, HostOptions, local::LocalListener,
        };
        let owner =
            RootOwner::open(&host.root, &RootNamespaces::for_current_account().unwrap()).unwrap();
        let host = Host::open_with_options(
            owner,
            None,
            HostOptions {
                project_directory_roots: Some(vec![DirectoryRootSpec {
                    label: "Test folders".into(),
                    path: browse_path,
                }]),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let socket = directory.path().join("host.sock");
        let listener = LocalListener::bind(&socket).unwrap();
        let registration = host.publish_registration(&socket, None).unwrap();
        (
            tokio::spawn(listener.serve(host, cancellation.clone())),
            registration,
        )
    });
    let client = runtime.block_on(support::model_client(&host.root, "http://127.0.0.1:9/v1"));
    let mut tui = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    tui.wait_for("No sessions yet"); // Connection/catalog load has completed.
    tui.command("Projects");
    tui.wait_for("No registered projects.");
    tui.click_text("⊕");
    tui.wait_for("Existing absolute directory on the Host.");
    tui.send(format!("\x1b[200~{}/missing\x1b[201~\r", directory.path().display()).as_bytes());
    tui.wait_for("Could not register this directory.");
    tui.send(format!("\x01\x1b[200~{}\x1b[201~\r", project_path.display()).as_bytes());
    tui.wait_until(|text| text.contains("中文 project") && !text.contains("Cancel"));
    let id = runtime.block_on(async {
        let QueryResult::Page { items, .. } = client
            .project_catalog(Query::ListStart {
                view: View::Summary,
            })
            .await
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(items.len(), 1);
        let PageItem::Project { id, .. } = &items[0] else {
            panic!()
        };
        id.clone()
    });
    tui.wait_for("中文 project");
    tui.click_text("中文 project");
    runtime
        .block_on(client.request(
            Operation::ProjectCatalogMutate,
            json!({"kind":"archive","projectId":id}),
        ))
        .unwrap();
    tui.wait_for("中文 project · Archived");
    tui.send(b"\r");
    runtime.block_on(async {
        let QueryResult::Page { items, .. } = client
            .project_catalog(Query::ListStart {
                view: View::Summary,
            })
            .await
            .unwrap()
        else {
            panic!()
        };
        assert!(items.iter().any(|item| matches!(
            item,
            PageItem::Project {
                archived_at: Some(_),
                ..
            }
        )));
        client
            .request(
                Operation::ProjectCatalogMutate,
                json!({"kind":"restore","projectId":id}),
            )
            .await
            .unwrap();
        client
            .request(
                Operation::ProjectCatalogMutate,
                json!({"kind":"rename","projectId":id,"name":"Renamed project"}),
            )
            .await
            .unwrap();
    });
    tui.wait_until(|text| text.contains("Renamed project") && !text.contains("Archived"));
    tui.click_text("ⓘ");
    tui.wait_for("Preferred Host directory");
    runtime
        .block_on(client.request(
            Operation::ProjectCatalogMutate,
            json!({"kind":"rename","projectId":id,"name":"Observed project"}),
        ))
        .unwrap();
    tui.wait_until(|text| {
        text.contains("Observed project") && text.contains("Preferred Host directory")
    });
    runtime
        .block_on(client.request(
            Operation::ProjectCatalogMutate,
            json!({"kind":"rename","projectId":id,"name":"Renamed project"}),
        ))
        .unwrap();
    tui.wait_until(|text| {
        text.contains("Renamed project")
            && !text.contains("Observed project")
            && text.contains("Preferred Host directory")
    });
    tui.click_last_text("Close");
    tui.wait_until(|text| {
        !text.contains("Preferred Host directory") && text.contains("Renamed project")
    });
    tui.click_page_text("Renamed project"); // Closing restores the information button's focus.
    tui.send(b"\r");
    tui.wait_for("Message…");
    let session = runtime.block_on(async {
        let SessionCatalogQueryResult::Page { sessions, .. } = client
            .session_catalog(SessionCatalogQueryInput::ListStart)
            .await
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(
            sessions.len(),
            1,
            "archived project did not create a session"
        );
        sessions.into_iter().next().unwrap()
    });
    assert_eq!(
        session.workspace.target,
        WorkspaceTarget::Project {
            project_id: id.clone()
        }
    );
    assert_eq!(
        session.workspace.host_cwd,
        project_path.canonicalize().unwrap().to_str().unwrap()
    );
    tui.send(b"project draft");
    tui.send(b"\x1b[1;3D");
    // The sidebar names the project group too; wait for the page itself.
    let projects = |text: &str| {
        text.lines()
            .next()
            .is_some_and(|line| line.contains("Projects"))
            && text.contains("Renamed project")
    };
    tui.wait_until(projects);
    tui.close_terminal();
    tui.finish();
    let mut tui = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    tui.wait_until(projects); // Restored route re-queries after connection, not a false empty state.
    tui.click_page_text("Renamed project");
    tui.filter_command("Rename project");
    tui.click_text("Rename project");
    tui.wait_for("Cancel");
    tui.send("\x1b[200~TUI 项目\x1b[201~\r".as_bytes());
    tui.wait_until(|text| text.contains("TUI 项目") && !text.contains("Cancel"));
    tui.filter_command("Archive project");
    tui.click_text("Archive project");
    tui.wait_for("Archiving prevents");
    tui.send(b"\r"); // Default focus cancels instead of archiving.
    tui.wait_until(|text| !text.contains("Cancel") && text.contains("TUI 项目"));
    tui.filter_command("Archive project");
    tui.click_text("Archive project");
    tui.wait_for("Archiving prevents");
    tui.wait_until(|text| {
        text.lines()
            .any(|line| line.contains("Cancel") && line.contains("Archive project"))
    });
    tui.click_last_text("Archive project");
    tui.wait_until(|text| text.contains("TUI 项目 · Archived") && !text.contains("Cancel"));
    tui.filter_command("Restore project");
    tui.click_text("Restore project");
    tui.wait_for("Archiving prevents");
    tui.send(b"\t\r");
    tui.wait_until(|text| {
        text.contains("TUI 项目") && !text.contains("Archived") && !text.contains("Cancel")
    });
    runtime.block_on(async {
        let QueryResult::Page { items, .. } = client.project_catalog(Query::ListStart {view:View::Summary}).await.unwrap() else {panic!()};
        assert!(items.iter().any(|item| matches!(item, PageItem::Project {id:current,name,archived_at:None,..} if *current == id && name == "TUI 项目")));
        assert!(client.session(&session.id).await.unwrap().is_some());
    });
    assert!(
        project_path.is_dir(),
        "archiving never deletes project files"
    );
    tui.click_text("⊕");
    tui.wait_for("Browse…");
    tui.send(b"draft path\t\r");
    tui.wait_for("Test folders");
    tui.send(b"\x1b");
    tui.wait_for("draft path"); // Browsing never overwrites the manually typed path.
    tui.send(b"\r"); // Focus returned to Browse.
    tui.wait_for("Test folders");
    tui.click_text("Test folders");
    tui.wait_for("folder-000");
    tui.send(b"\x1b[6~"); // Host page, not merely scrolling the visible rows.
    tui.wait_for("目录目标");
    tui.click_text("目录目标");
    tui.wait_for("No subdirectories.");
    tui.send(b"\x7f"); // Parent returns to the directory's first page.
    tui.wait_for("folder-000");
    tui.send(b"\x1b[6~");
    tui.wait_for("目录目标");
    tui.send(b"\x1b[F\r"); // End selects the last row, Enter opens it (does not register).
    tui.wait_for("No subdirectories.");
    tui.resize(52, 22);
    tui.wait_until(|text| {
        text.lines()
            .enumerate()
            .any(|(row, line)| row < 22 && line.contains("Register here"))
            && text.contains("No subdirectories.")
    });
    tui.click_text("Register here");
    tui.wait_until(|text| {
        text.contains("目录目标")
            && text.contains("TUI 项目")
            && !text.contains("Host directories")
            && !text.contains("Cancel")
    });
    runtime.block_on(async {
        let QueryResult::Page { items, .. } = client.project_catalog(Query::ListStart {view:View::Locations}).await.unwrap() else {panic!()};
        assert_eq!(items.iter().filter(|item| matches!(item, PageItem::Project {..})).count(), 2);
        assert!(items.iter().any(|item| matches!(item, PageItem::Location {location,..} if location.path == browse_target.canonicalize().unwrap().to_str().unwrap())));
    });
    tui.resize(100, 30);
    tui.wait_until(|text| {
        text.lines()
            .nth(29)
            .is_some_and(|line| line.trim() == "New session in project")
    });
    let absorbed = runtime.block_on(async {
        let QueryResult::Page {items,..} = client.project_catalog(Query::ListStart {view:View::Summary}).await.unwrap() else {panic!()};
        let target = items.iter().find_map(|item| match item {
            PageItem::Project {id,name,..} if name == "目录目标" => Some(id.clone()), _=>None
        }).unwrap();
        client.create_session(decode_session_create_input(&json!({
            "sessionId":"absorbed-session", "name":"Absorbed project session", "workspace":{"kind":"project","projectId":target}, "modelTarget":{"kind":"default"}
        })).unwrap()).await.unwrap();
        target
    });
    tui.click_page_text("TUI 项目");
    tui.filter_command("Relink project");
    tui.click_text("Relink project");
    tui.wait_for("Replacement absolute directory");
    tui.send(format!("\x1b[200~{}/missing\x1b[201~\r", directory.path().display()).as_bytes());
    tui.wait_for("Relink this project?");
    tui.send(b"\r"); // Reviewing defaults to Cancel, without a write.
    tui.wait_until(|text| text.contains("TUI 项目") && !text.contains("Cancel"));
    tui.filter_command("Relink project");
    tui.click_text("Relink project");
    tui.wait_for("Replacement absolute directory");
    tui.send(format!("\x1b[200~{}/missing\x1b[201~\r", directory.path().display()).as_bytes());
    tui.wait_until(|text| {
        text.lines().any(|line| {
            line.contains("Cancel") && line.contains("Edit path") && line.contains("Relink")
        })
    });
    tui.click_last_text("Relink");
    tui.wait_for("Could not relink.");
    let before = runtime
        .block_on(client.session(&session.id))
        .unwrap()
        .unwrap();
    assert_eq!(
        before.workspace.host_cwd,
        project_path.canonicalize().unwrap().to_str().unwrap()
    );
    tui.click_text("Edit path");
    tui.wait_for("Review change");
    tui.send(format!("\x01\x1b[200~{}\x1b[201~\r", browse_target.display()).as_bytes());
    tui.wait_until(|text| {
        text.contains("Relink this project?") && text.contains("No files are moved.")
    });
    tui.send(b"\t\t\r");
    tui.wait_until(|text| {
        text.contains("TUI 项目") && !text.contains("目录目标") && !text.contains("Cancel")
    });
    runtime.block_on(async {
        let QueryResult::Page {items,project_count,..} = client.project_catalog(Query::ListStart {view:View::Locations}).await.unwrap() else {panic!()};
        assert_eq!(project_count, 1, "relink merged the already registered destination");
        assert!(items.iter().any(|item| matches!(item, PageItem::Alias {alias,..} if *alias == absorbed)));
        assert!(items.iter().any(|item| matches!(item, PageItem::Location {location,..} if location.path == browse_target.canonicalize().unwrap().to_str().unwrap())));
        for id_to_read in [&session.id, &"absorbed-session".to_owned()] {
            let current = client.session(id_to_read).await.unwrap().unwrap();
            assert_eq!(current.workspace.target, WorkspaceTarget::Project {project_id:id.clone()});
            assert_eq!(current.workspace.host_cwd, browse_target.canonicalize().unwrap().to_str().unwrap());
        }
        assert!(client.session(&session.id).await.unwrap().unwrap().revision > before.revision);
    });
    assert!(project_path.is_dir(), "relink changes metadata, not files");
    tui.filter_command("Project locations");
    tui.click_text("Project locations");
    tui.wait_for("Preferred Host directory");
    // The location dialog wraps long paths; canonical identity is checked above.
    tui.wait_for("目标");
    tui.send(b"\x1b");
    tui.wait_until(|text| !text.contains("Preferred Host directory") && text.contains("TUI 项目"));
    tui.send(b"\x1b[1;3C");
    tui.wait_for("project draft");
    tui.close_terminal();
    tui.finish();
    client.disconnect();
    cancellation.cancel();
    runtime
        .block_on(async { tokio::time::timeout(Duration::from_secs(10), server).await })
        .unwrap()
        .unwrap()
        .unwrap();
    registration.remove().unwrap();
}
