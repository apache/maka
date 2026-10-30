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
use crate::tests::{scope, write};

fn git(path: &Path, args: &[&str]) {
    let output = std::process::Command::new("git")
        .current_dir(path)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn git_snapshot_install_and_whole_directory_update_use_physical_locations() {
    use maka_event_log::{RootStore, root::RootNamespaces};
    let temporary = tempfile::tempdir().unwrap();
    let base = temporary.path();
    let home = base.join("home");
    let projects = base.join("projects");
    let repository = base.join("repository");
    for path in [&home, &projects, &repository] {
        std::fs::create_dir(path).unwrap();
    }
    git(&repository, &["init", "--initial-branch=trunk"]);
    git(&repository, &["config", "user.name", "Skill test"]);
    git(
        &repository,
        &["config", "user.email", "skills@example.invalid"],
    );
    write(&repository, "rust-guide", "first instructions");
    write(&repository, "second-guide", "second instructions");
    std::fs::write(
        repository.join("rust-guide/obsolete.txt"),
        "removed upstream",
    )
    .unwrap();
    std::fs::write(repository.join("rust-guide/run.sh"), "first script").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            repository.join("rust-guide/run.sh"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
    }
    for index in 0..180 {
        let example = repository
            .join("rust-guide/examples")
            .join(index.to_string());
        std::fs::create_dir_all(&example).unwrap();
        std::fs::write(example.join("input.rs"), "fn main() {}\n").unwrap();
    }
    git(&repository, &["add", "."]);
    git(&repository, &["commit", "-m", "first"]);
    let root = Arc::new(
        RootOwner::create(
            &base.join("private"),
            &RootNamespaces {
                ownership: base.join("owners"),
                control: base.join("control"),
            },
        )
        .unwrap(),
    );
    let store = Arc::new(RootStore::open(root.clone()).await.unwrap());
    let mut library = Library::open(
        Configuration {
            home: Some(home.to_str().unwrap().into()),
            project_roots: vec![maka_host_runtime::DirectoryRootSpec {
                label: "Projects".into(),
                path: projects.clone(),
            }],
            bundled: false,
            manage: true,
            preferences: false,
            sources: vec![],
        },
        root.canonical_path().to_owned(),
        preferences::Store::new(store.clone(), "test".into()),
    )
    .unwrap();
    library.managed = Some(Managed::open(root, store.clone()));
    let workspace = sources::tests::workspace(&projects.join("selected")).await;
    let call = scope();
    let library = library
        .for_workspace(Some(workspace.clone()), &call)
        .await
        .unwrap();
    let discovered = library
        .discover_source(
            DiscoverSource {
                workspace: Some(workspace.clone()),
                source: url::Url::from_directory_path(&repository)
                    .unwrap()
                    .to_string(),
            },
            &call,
        )
        .await
        .unwrap();
    assert_eq!(
        discovered
            .skills
            .iter()
            .map(|skill| skill.name.as_str())
            .collect::<Vec<_>>(),
        ["rust-guide", "second-guide"]
    );
    std::fs::remove_file(repository.join("rust-guide/obsolete.txt")).unwrap();
    std::fs::write(repository.join("rust-guide/run.sh"), "latest script").unwrap();
    write(&repository, "rust-guide", "latest instructions");
    git(&repository, &["add", "."]);
    git(&repository, &["commit", "-m", "second"]);
    write(
        &projects,
        "selected",
        "a skill authored at the project root",
    );
    let overlapping = library
        .install(
            Install {
                workspace: Some(workspace.clone()),
                location: LocationId::ProjectMaka,
                source: SourceSnapshot::Directory {
                    path: workspace.path.clone(),
                },
                skills: vec![String::new()],
            },
            &call,
        )
        .await
        .unwrap();
    assert!(
        matches!(&overlapping.results[0], InstallOutcome::Rejected { reason, .. } if reason.contains("inside its source directory"))
    );
    for location in LocationId::ALL {
        let result = library
            .install(
                Install {
                    workspace: Some(workspace.clone()),
                    location,
                    source: discovered.source.clone(),
                    skills: discovered
                        .skills
                        .iter()
                        .map(|skill| skill.directory.clone())
                        .collect(),
                },
                &call,
            )
            .await
            .unwrap();
        assert!(
            result
                .results
                .iter()
                .all(|result| matches!(result, InstallOutcome::Installed { .. })),
            "{}",
            serde_json::to_string(&result).unwrap()
        );
    }
    let path = Path::new(&workspace.path).join(".maka/skills/rust-guide");
    assert_eq!(
        std::fs::read_to_string(path.join("run.sh")).unwrap(),
        "first script",
        "installation pins the discovered revision"
    );
    assert_eq!(
        std::fs::read_to_string(path.join("examples/179/input.rs")).unwrap(),
        "fn main() {}\n"
    );
    std::fs::write(path.join("run.sh"), "local edits").unwrap();
    std::fs::write(path.join("local-only.txt"), "local addition").unwrap();
    let snapshot = library.snapshot(&call).await.unwrap();
    let (selected, _, _) = snapshot
        .entries
        .iter()
        .find(|(entry, _, _)| entry.name == "rust-guide" && entry.shadowed_by.is_none())
        .unwrap();
    assert_eq!(selected.location, Some(LocationId::ProjectMaka));
    assert!(selected.installation.is_some());
    let reference = selected.reference.clone();
    assert!(matches!(
        library
            .manage_skill(
                ManageSkill {
                    workspace: Some(workspace.clone()),
                    reference: reference.clone()
                },
                true,
                &call
            )
            .await
            .unwrap(),
        ChangeResult::Applied { .. }
    ));
    assert_eq!(
        std::fs::read_to_string(path.join("run.sh")).unwrap(),
        "latest script"
    );
    assert!(!path.join("obsolete.txt").exists());
    assert!(!path.join("local-only.txt").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(path.join("run.sh"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
    }
    assert!(matches!(
        library
            .manage_skill(
                ManageSkill {
                    workspace: Some(workspace.clone()),
                    reference
                },
                false,
                &call
            )
            .await
            .unwrap(),
        ChangeResult::Applied { .. }
    ));
    let snapshot = library.snapshot(&call).await.unwrap();
    let (selected, _, text) = snapshot
        .entries
        .iter()
        .find(|(entry, _, _)| entry.name == "rust-guide" && entry.shadowed_by.is_none())
        .unwrap();
    assert_eq!(selected.location, Some(LocationId::ProjectAgents));
    assert_eq!(text, "first instructions");
    assert_eq!(
        library
            .managed
            .as_ref()
            .unwrap()
            .registrations
            .list()
            .await
            .unwrap()
            .len(),
        7
    );
    write(
        &home.join(".agents/skills"),
        "external",
        "manually installed",
    );
    let external = "user:agents:external".to_owned();
    let snapshot = library.snapshot(&call).await.unwrap();
    assert!(
        snapshot
            .entries
            .iter()
            .find(|(entry, _, _)| entry.reference == external)
            .unwrap()
            .0
            .installation
            .is_none()
    );
    assert!(matches!(
        library
            .manage_skill(
                ManageSkill {
                    workspace: None,
                    reference: external.clone()
                },
                true,
                &call
            )
            .await
            .unwrap(),
        ChangeResult::Rejected { .. }
    ));
    assert!(matches!(
        library
            .manage_skill(
                ManageSkill {
                    workspace: None,
                    reference: external
                },
                false,
                &call
            )
            .await
            .unwrap(),
        ChangeResult::Applied { .. }
    ));
    assert!(!home.join(".agents/skills/external").exists());
    assert!(home.join(".agents/skills/second-guide/SKILL.md").exists());
    #[cfg(unix)]
    {
        write(base, "linked-skill", "unsafe resource");
        std::os::unix::fs::symlink("/etc/passwd", base.join("linked-skill/escape")).unwrap();
        let result = library
            .install(
                Install {
                    workspace: None,
                    location: LocationId::UserAgents,
                    source: SourceSnapshot::Directory {
                        path: base.join("linked-skill").to_str().unwrap().into(),
                    },
                    skills: vec![String::new()],
                },
                &call,
            )
            .await
            .unwrap();
        assert!(matches!(
            &result.results[0],
            InstallOutcome::Rejected { .. }
        ));
        assert!(!home.join(".agents/skills/linked-skill").exists());
        assert!(home.join(".agents/skills/second-guide/SKILL.md").exists());
    }
    call.finish().await.unwrap();
    store.shutdown().await.unwrap();
}
