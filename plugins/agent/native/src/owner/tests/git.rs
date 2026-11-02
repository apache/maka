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
use base64::{Engine, engine::general_purpose::STANDARD};
use std::path::Path;

// Git authors fixtures and supplies an independent status oracle. Agent values
// come from the public ApplicationClient through the real Session scope.
fn git(workspace: &Path, arguments: &[&str]) {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(workspace)
        .args(arguments)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {arguments:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn repository(workspace: &Path) {
    git(workspace, &["init", "--quiet", "--initial-branch=main"]);
    git(
        workspace,
        &["config", "user.email", "git-fixture@example.invalid"],
    );
    git(workspace, &["config", "user.name", "Git fixture"]);
    git(workspace, &["config", "core.autocrlf", "false"]);
    // The workspace identity marker is fixture infrastructure, not a user edit.
    std::fs::write(
        workspace.join(".git/info/exclude"),
        format!("/{}\n", maka_fs_tools::workspace::MARKER_FILE),
    )
    .unwrap();
}

fn path(name: &str) -> Value {
    json!({"bytesBase64": STANDARD.encode(name.as_bytes())})
}

fn changed_lines(result: &Value) -> Vec<&str> {
    assert_eq!(result["kind"], "text", "{result}");
    result["patch"]
        .as_str()
        .unwrap()
        .lines()
        .filter(|line| {
            (line.starts_with('+') && !line.starts_with("+++"))
                || (line.starts_with('-') && !line.starts_with("---"))
        })
        .collect()
}

#[tokio::test]
async fn git_status_and_diff_read_current_workspace_without_mutating_index() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let f = Fixture::new("http://127.0.0.1:1/v1", None).await;
        let session = f.create("Git comparison").await;
        repository(&f.workspace);
        std::fs::write(f.workspace.join("tracked.txt"), "base\n").unwrap();
        git(&f.workspace, &["add", "tracked.txt"]);
        git(&f.workspace, &["commit", "--quiet", "-m", "base"]);
        std::fs::write(f.workspace.join("tracked.txt"), "staged\n").unwrap();
        git(&f.workspace, &["add", "tracked.txt"]);
        std::fs::write(f.workspace.join("tracked.txt"), "worktree\n").unwrap();
        std::fs::write(f.workspace.join("new.txt"), "new file\n").unwrap();
        let index = f.workspace.join(".git/index");
        let index_bytes = std::fs::read(&index).unwrap();
        let index_modified = std::fs::metadata(&index).unwrap().modified().unwrap();
        let observed = f.query("gitStatus", json!({"sessionId":session})).await;
        // A preimplementation missing-method RED still closes the real runtime.
        if observed.is_err() {
            f.app.shutdown().await.unwrap();
            f.config.shutdown().await.unwrap();
        }
        let status = observed.expect("Agent gitStatus must read the selected Session repository");
        let mut entries = status["entries"].as_array().unwrap().clone();
        entries.sort_by_key(|entry| {
            (
                entry["area"].as_str().unwrap().to_owned(),
                entry["path"].to_string(),
            )
        });
        let mut status = status;
        status["entries"] = json!(entries);
        let head = std::fs::read_to_string(f.workspace.join(".git/refs/heads/main")).unwrap();
        assert_eq!(
            status,
            json!({"head":head.trim(),"entries":[
                {"area":"staged","path":{"bytesBase64":"dHJhY2tlZC50eHQ="},"kind":"modified"},
                {"area":"untracked","path":{"bytesBase64":"bmV3LnR4dA=="},"kind":"added"},
                {"area":"worktree","path":{"bytesBase64":"dHJhY2tlZC50eHQ="},"kind":"modified"},
            ]})
        );
        for (area, name, expected) in [
            ("staged", "tracked.txt", vec!["-base", "+staged"]),
            ("worktree", "tracked.txt", vec!["-staged", "+worktree"]),
            ("untracked", "new.txt", vec!["+new file"]),
        ] {
            let diff = f
                .query(
                    "gitDiff",
                    json!({"sessionId":session,"area":area,"path":path(name)}),
                )
                .await
                .unwrap();
            assert_eq!(changed_lines(&diff), expected, "{area}");
        }
        std::fs::write(f.workspace.join("tracked.txt"), "later edit\n").unwrap();
        let fresh = f
            .query(
                "gitDiff",
                json!({"sessionId":session,"area":"worktree","path":path("tracked.txt")}),
            )
            .await
            .unwrap();
        assert_eq!(changed_lines(&fresh), vec!["-staged", "+later edit"]);
        std::fs::remove_file(f.workspace.join("new.txt")).unwrap();
        let fresh_status = f
            .query("gitStatus", json!({"sessionId":session}))
            .await
            .unwrap();
        let mut areas: Vec<_> = fresh_status["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["area"].as_str().unwrap())
            .collect();
        areas.sort();
        assert_eq!(areas, ["staged", "worktree"]);
        assert_eq!(std::fs::read(&index).unwrap(), index_bytes);
        assert_eq!(
            std::fs::metadata(&index).unwrap().modified().unwrap(),
            index_modified
        );
        assert!(!f.workspace.join(".git/index.lock").exists());
        assert_eq!(
            std::fs::read_to_string(f.workspace.join("tracked.txt")).unwrap(),
            "later edit\n"
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn git_queries_use_the_selected_managed_linked_worktree_not_its_source_repository() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let f = Fixture::configured("http://127.0.0.1:1/v1", None, None, None, |settings| {
            settings.isolated_workspaces = true
        })
        .await;
        let source_session = f.create("Source repository").await;
        repository(&f.workspace);
        std::fs::write(f.workspace.join("tracked.txt"), "source base\n").unwrap();
        git(&f.workspace, &["add", "tracked.txt"]);
        git(&f.workspace, &["commit", "--quiet", "-m", "source base"]);
        let mut input = f.create_input("Managed checkout").await;
        input["workspace"]["kind"] = json!("isolated_git");
        let created = f
            .mutation(2, "create", input, Uuid::new_v4())
            .await
            .unwrap();
        assert_eq!(created["kind"], "created", "{created}");
        let managed =
            std::path::PathBuf::from(created["session"]["workspace"]["path"].as_str().unwrap());
        assert!(
            managed.join(".git").is_file(),
            "exercise an actual linked worktree"
        );
        std::fs::write(managed.join("tracked.txt"), "managed current\n").unwrap();
        let session = &created["session"]["id"];
        let diff = f
            .query(
                "gitDiff",
                json!({"sessionId":session,"area":"worktree","path":path("tracked.txt")}),
            )
            .await
            .unwrap();
        assert_eq!(changed_lines(&diff), ["-source base", "+managed current"]);
        // Public browsing shares this exact managed-worktree exception, while
        // the private parent and administration directories remain unreachable.
        let files = f
            .query(
                "listFiles",
                json!({
                    "sessionId":session,"path":null,"after":null,
                }),
            )
            .await
            .unwrap();
        assert_eq!(
            files["entries"],
            json!([
                {"path":{"bytesBase64":"dHJhY2tlZC50eHQ="},"kind":"file"},
            ])
        );
        assert_eq!(files["next"], Value::Null);
        assert!(
            f.query(
                "listFiles",
                json!({
                    "sessionId":session,"path":path("../"),"after":null,
                })
            )
            .await
            .is_err()
        );
        let status = f
            .query("gitStatus", json!({"sessionId":session}))
            .await
            .unwrap();
        assert_eq!(
            status["entries"],
            json!([{"area":"worktree","path":{"bytesBase64":"dHJhY2tlZC50eHQ="},"kind":"modified"}])
        );
        assert_eq!(
            f.query("gitStatus", json!({"sessionId":source_session}))
                .await
                .unwrap()["entries"],
            json!([])
        );
        assert_eq!(
            std::fs::read_to_string(f.workspace.join("tracked.txt")).unwrap(),
            "source base\n"
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
