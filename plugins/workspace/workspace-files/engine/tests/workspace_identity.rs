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

use maka_fs_tools::workspace::{MARKER_FILE, read_identity};
use std::{io, path::Path, process::Command};

async fn prepare(path: &Path) -> io::Result<maka_agent_facts::execution::WorkspaceIdentity> {
    let (path, observed) = maka_fs_tools::directory::capture(path)?;
    let opened = maka_fs_tools::directory::open(&path, &observed)?;
    prepare_opened(path, opened).await
}

async fn prepare_opened(
    path: std::path::PathBuf,
    opened: cap_std::fs::Dir,
) -> io::Result<maka_agent_facts::execution::WorkspaceIdentity> {
    let private = tempfile::tempdir()?;
    let control = tempfile::tempdir()?;
    maka_fs_tools::workspace::ensure_directory_identity(
        path,
        opened,
        private.path().to_owned(),
        control.path().to_owned(),
        None,
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn workspace_identity_is_intrinsic_atomic_and_never_repairs_invalid_evidence() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("workspace");
    std::fs::create_dir(&root).unwrap();
    assert_eq!(
        read_identity(&root).unwrap_err().kind(),
        io::ErrorKind::NotFound
    );
    assert!(std::fs::read_dir(&root).unwrap().next().is_none());
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..8 {
        let root = root.clone();
        tasks.spawn(async move { prepare(&root).await.unwrap() });
    }
    let mut identities = Vec::new();
    while let Some(result) = tasks.join_next().await {
        identities.push(result.unwrap());
    }
    assert!(identities.iter().all(|id| *id == identities[0]));
    assert_eq!(
        std::fs::read_dir(&root).unwrap().count(),
        1,
        "no candidate files remain"
    );
    let original = std::fs::read(root.join(MARKER_FILE)).unwrap();
    assert_eq!(prepare(&root).await.unwrap(), identities[0]);
    assert_eq!(std::fs::read(root.join(MARKER_FILE)).unwrap(), original);

    let moved = temp.path().join("moved");
    std::fs::rename(&root, &moved).unwrap();
    assert_eq!(read_identity(&moved).unwrap(), identities[0]);
    assert_eq!(prepare(&moved).await.unwrap(), identities[0]);
    let marker = moved.join(MARKER_FILE);
    // Node preserves existing UUID spelling and accepts integral numeric spellings.
    let uppercase = identities[0].marker_id().to_uppercase();
    let compatible = format!(r#"{{"schemaVersion":1e0,"workspaceId":"{uppercase}"}}"#);
    std::fs::write(&marker, &compatible).unwrap();
    let identity = prepare(&moved).await.unwrap();
    assert_eq!(identity.marker_id(), uppercase);
    assert_eq!(
        serde_json::to_value(&identity).unwrap(),
        format!("workspace:v1:{uppercase}")
    );
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), compatible);

    for invalid in [
        "{}".to_owned(),
        "{broken".into(),
        format!(r#"{{"schemaVersion":2,"workspaceId":"{uppercase}"}}"#),
        format!(r#"{{"schemaVersion":1,"workspaceId":"{uppercase}","other":1}}"#),
        r#"{"schemaVersion":1,"workspaceId":"00000000-0000-4000-0000-000000000000"}"#.into(),
        " ".repeat(4097),
    ] {
        std::fs::write(&marker, &invalid).unwrap();
        assert!(read_identity(&moved).is_err());
        assert!(prepare(&moved).await.is_err());
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), invalid);
        assert_eq!(std::fs::read_dir(&moved).unwrap().count(), 1);
    }
    std::fs::remove_file(&marker).unwrap();
    std::fs::create_dir(&marker).unwrap();
    assert!(prepare(&moved).await.is_err());
    assert!(marker.is_dir());

    #[cfg(unix)]
    {
        std::fs::remove_dir(&marker).unwrap();
        let outside = temp.path().join("outside.json");
        std::fs::write(&outside, &compatible).unwrap();
        std::os::unix::fs::symlink(&outside, &marker).unwrap();
        assert!(read_identity(&moved).is_err());
        assert!(prepare(&moved).await.is_err());
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), compatible);
        std::fs::remove_file(&outside).unwrap();
        assert!(
            prepare(&moved).await.is_err(),
            "dangling marker must not be rebound"
        );
        assert!(!outside.exists());
    }
}

fn git(path: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(["-c", "core.fsmonitor=false", "-c"])
        .arg(format!(
            "core.hooksPath={}",
            path.join("unused-fixture-hooks").display()
        ))
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}

#[tokio::test]
async fn linked_worktree_marker_uses_git_owned_exclusion_without_overwriting_it() {
    use maka_fs_tools::workspace::project::{ProjectKind, resolve_selected};
    if let Some(root) = std::env::var_os("MAKA_TEST_GIT_FREE_ROOT") {
        let root = Path::new(&root);
        assert!(Command::new("git").arg("--version").output().is_err());
        let main = resolve_selected(&root.join("project.git")).await.unwrap();
        let linked = resolve_selected(&root.join("linked")).await.unwrap();
        assert_eq!(main.identity().unwrap(), linked.identity().unwrap());
        assert!(matches!(
            linked.kind,
            ProjectKind::Git {
                is_worktree: true,
                ..
            }
        ));
        prepare(&linked.path).await.unwrap();
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project.git");
    let linked = temp.path().join("linked");
    std::fs::create_dir(&project).unwrap();
    git(&project, &["init", "-q"]);
    git(
        &project,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "-qm",
            "fixture",
        ],
    );
    git(
        &project,
        &[
            "worktree",
            "add",
            "-q",
            "--detach",
            linked.to_str().unwrap(),
            "HEAD",
        ],
    );
    let selected = resolve_selected(&project).await.unwrap();
    let worktree = resolve_selected(&linked).await.unwrap();
    assert_eq!(selected.name, "project.git");
    assert_eq!(worktree.name, selected.name);
    assert_eq!(selected.identity().unwrap(), worktree.identity().unwrap());
    assert!(matches!(
        selected.kind,
        ProjectKind::Git {
            is_worktree: false,
            ..
        }
    ));
    assert!(matches!(
        worktree.kind,
        ProjectKind::Git {
            is_worktree: true,
            ..
        }
    ));
    let child = project.join("child");
    std::fs::create_dir(&child).unwrap();
    let child_project = resolve_selected(&child).await.unwrap();
    assert_eq!(child_project.path, child.canonicalize().unwrap());
    assert_eq!(child_project.kind, ProjectKind::Folder);
    assert_ne!(
        selected.identity().unwrap(),
        child_project.identity().unwrap()
    );
    git(&project, &["config", "core.worktree", "../child"]);
    assert_eq!(
        resolve_selected(&project).await.unwrap().kind,
        ProjectKind::Folder
    );
    assert_eq!(
        resolve_selected(&child).await.unwrap().identity().unwrap(),
        selected.identity().unwrap()
    );
    git(&project, &["config", "--unset", "core.worktree"]);
    std::fs::write(child.join(".git"), "invalid nested repository").unwrap();
    assert!(resolve_selected(&child).await.is_err());
    std::fs::remove_file(child.join(".git")).unwrap();
    std::fs::create_dir(child.join(".git")).unwrap();
    assert_eq!(
        maka_fs_tools::workspace::git_metadata(&child).unwrap(),
        vec![dunce::canonicalize(child.join(".git")).unwrap()],
        "empty mount target stays protected without selecting the enclosing repository"
    );
    // An empty target is not permission to ignore real, invalid indirection.
    std::fs::write(child.join(".git/commondir"), "../elsewhere").unwrap();
    assert!(maka_fs_tools::workspace::git_metadata(&child).is_err());
    std::fs::remove_file(child.join(".git/commondir")).unwrap();
    std::fs::remove_dir(child.join(".git")).unwrap();
    assert!(
        !project.join(MARKER_FILE).exists(),
        "selection cannot create workspace markers"
    );
    #[cfg(unix)]
    for name in ["trailing space ", "embedded\nnewline", "ending\r"] {
        let special = temp.path().join(name);
        std::fs::create_dir(&special).unwrap();
        git(&special, &["init", "-q"]);
        let resolved = resolve_selected(&special).await.unwrap();
        assert_eq!(resolved.path, special.canonicalize().unwrap());
        assert_eq!(resolved.name, name);
        assert!(matches!(
            resolved.kind,
            ProjectKind::Git {
                is_worktree: false,
                ..
            }
        ));
    }
    let exclude = project.join(".git/info/exclude");
    std::fs::write(&exclude, "# preserve\r\nuser.txt").unwrap();
    let child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "workspace_identity::linked_worktree_marker_uses_git_owned_exclusion_without_overwriting_it",
            "--nocapture",
        ])
        .env("MAKA_TEST_GIT_FREE_ROOT", temp.path())
        .env("PATH", temp.path().join("no-executables"))
        .env("GIT_DIR", temp.path().join("wrong-repository"))
        .env("GIT_WORK_TREE", temp.path().join("wrong-worktree"))
        .env("GIT_COMMON_DIR", temp.path().join("wrong-common"))
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "core.bare")
        .env("GIT_CONFIG_VALUE_0", "true")
        .output()
        .unwrap();
    assert!(
        child.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&child.stdout),
        String::from_utf8_lossy(&child.stderr)
    );
    let identity = prepare(&linked).await.unwrap();
    let expected = format!("# preserve\r\nuser.txt\n{MARKER_FILE}\n");
    assert_eq!(std::fs::read_to_string(&exclude).unwrap(), expected);
    assert_eq!(prepare(&linked).await.unwrap(), identity);
    assert_eq!(std::fs::read_to_string(&exclude).unwrap(), expected);
    assert_eq!(git(&linked, &["check-ignore", MARKER_FILE]), MARKER_FILE);
    assert_eq!(git(&linked, &["status", "--porcelain"]), "");
    assert!(linked.join(".git").is_file());

    #[cfg(unix)]
    {
        let outside = temp.path().join("outside-exclude");
        std::fs::write(&outside, "preserve").unwrap();
        std::fs::remove_file(&exclude).unwrap();
        std::os::unix::fs::symlink(&outside, &exclude).unwrap();
        let reported = git(
            &linked,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "info/exclude",
            ],
        );
        assert_eq!(
            Path::new(&reported),
            outside.canonicalize().unwrap(),
            "Git resolves a final link before open; use its parent directory instead"
        );
        assert!(prepare(&linked).await.is_err());
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "preserve");
        assert_eq!(
            read_identity(&linked).unwrap(),
            identity,
            "read-only observation does not touch Git"
        );
    }
}

#[tokio::test]
async fn opened_directory_identity_rejects_replacement_without_marker_effects() {
    use maka_fs_tools::directory;
    let temp = tempfile::tempdir().unwrap();
    let selected = temp.path().join("published");
    let retired = temp.path().join("retired");
    std::fs::create_dir(&selected).unwrap();
    let (path, observed) = directory::capture(&selected).unwrap();
    let opened = directory::open(&path, &observed).unwrap();
    std::fs::rename(&selected, &retired).unwrap();
    std::fs::create_dir(&selected).unwrap();
    git(&selected, &["init", "-q"]);
    let exclude = selected.join(".git/info/exclude");
    let original = std::fs::read(&exclude).unwrap();
    assert!(prepare_opened(path, opened).await.is_err());
    assert!(!selected.join(MARKER_FILE).exists());
    assert!(!retired.join(MARKER_FILE).exists());
    assert_eq!(std::fs::read(&exclude).unwrap(), original);
}

#[tokio::test]
async fn marker_exclusion_refuses_private_and_control_git_indirection() {
    let temp = tempfile::tempdir().unwrap();
    let private = temp.path().join("private");
    let control = temp.path().join("control");
    std::fs::create_dir(&private).unwrap();
    std::fs::create_dir(&control).unwrap();
    for protected in [&private, &control] {
        let repository = protected.join("repository");
        std::fs::create_dir(&repository).unwrap();
        git(&repository, &["init", "-q"]);
        let common = repository.join(".git");
        let original = std::fs::read(common.join("info/exclude")).unwrap();
        for indirection in ["gitdir", "commondir"] {
            let selected = tempfile::tempdir().unwrap();
            let admin = if indirection == "commondir" {
                let admin = selected.path().join("admin");
                std::fs::create_dir(&admin).unwrap();
                std::fs::write(admin.join("HEAD"), "ref: refs/heads/main\n").unwrap();
                std::fs::write(admin.join("commondir"), format!("{}\n", common.display())).unwrap();
                admin
            } else {
                common.clone()
            };
            std::fs::write(
                selected.path().join(".git"),
                format!("gitdir: {}\n", admin.display()),
            )
            .unwrap();
            let (path, observed) = maka_fs_tools::directory::capture(selected.path()).unwrap();
            let opened = maka_fs_tools::directory::open(&path, &observed).unwrap();
            assert!(
                maka_fs_tools::workspace::ensure_directory_identity(
                    path,
                    opened,
                    private.clone(),
                    control.clone(),
                    None
                )
                .await
                .is_err(),
                "{protected:?}/{indirection}"
            );
            assert!(!selected.path().join(MARKER_FILE).exists());
            assert_eq!(
                std::fs::read(common.join("info/exclude")).unwrap(),
                original
            );
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn marker_exclusion_rejects_info_links_and_special_excludes() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    git(temp.path(), &["init", "-q"]);
    let info = temp.path().join(".git/info");
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("exclude"), "untouched\n").unwrap();
    std::fs::remove_dir_all(&info).unwrap();
    symlink(outside.path(), &info).unwrap();
    assert!(prepare(temp.path()).await.is_err());
    assert!(!temp.path().join(MARKER_FILE).exists());
    assert_eq!(
        std::fs::read_to_string(outside.path().join("exclude")).unwrap(),
        "untouched\n"
    );
    std::fs::remove_file(&info).unwrap();
    std::fs::create_dir(&info).unwrap();
    std::fs::create_dir(info.join("exclude")).unwrap();
    assert!(prepare(temp.path()).await.is_err());
    assert!(!temp.path().join(MARKER_FILE).exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_selected_directories_keep_shared_exclusion_lines_complete() {
    use std::sync::Arc;
    let temp = tempfile::tempdir().unwrap();
    git(temp.path(), &["init", "-q"]);
    std::fs::write(temp.path().join(".git/info/exclude"), b"").unwrap();
    let start = Arc::new(tokio::sync::Barrier::new(8));
    let mut tasks = tokio::task::JoinSet::new();
    let mut selected = Vec::new();
    for index in 0..8 {
        let path = temp.path().join(format!("selected-{index}"));
        std::fs::create_dir(&path).unwrap();
        selected.push(path.clone());
        let start = start.clone();
        tasks.spawn(async move {
            start.wait().await;
            prepare(&path).await
        });
    }
    let mut prepared = 0;
    while let Some(result) = tasks.join_next().await {
        match result.unwrap() {
            Ok(_) => prepared += 1,
            // The existing same-fd observation rejects concurrent file changes.
            Err(error) => assert_eq!(error.kind(), io::ErrorKind::InvalidData, "{error}"),
        }
    }
    assert!(prepared > 0);
    let exclusion = std::fs::read(temp.path().join(".git/info/exclude")).unwrap();
    for line in exclusion
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        assert_eq!(line, MARKER_FILE.as_bytes());
    }
    // No retry can repair a malformed interleaved append before this oracle.
    for path in selected {
        assert_eq!(git(&path, &["check-ignore", MARKER_FILE]), MARKER_FILE);
    }
}
