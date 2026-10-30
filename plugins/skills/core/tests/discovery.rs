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

use maka_skills::{DiscoveryFailure, Source, scan};
use std::{collections::BTreeSet, fs, path::Path};
use tokio_util::sync::CancellationToken;

fn owner() -> maka_capabilities::call::Scope {
    maka_capabilities::call::Issuer::default()
        .issue(
            maka_capabilities::call::Identity::Remote {
                request_id: uuid::Uuid::new_v4(),
            },
            CancellationToken::new(),
        )
        .unwrap()
}
async fn view(
    owner: &maka_capabilities::call::Scope,
    path: &Path,
) -> maka_capabilities::filesystem::ReadDirectory {
    maka_capabilities::filesystem::ReadRoot::open(path)
        .await
        .unwrap()
        .bind_scope(owner)
}

fn sources(
    project: Option<&maka_capabilities::filesystem::ReadDirectory>,
    home: Option<&maka_capabilities::filesystem::ReadDirectory>,
) -> Vec<Source> {
    use maka_skills::LocationId::{ProjectAgents, ProjectMaka, UserAgents, UserMaka};
    [
        (project, ProjectMaka),
        (project, ProjectAgents),
        (home, UserMaka),
        (home, UserAgents),
    ]
    .into_iter()
    .filter_map(|(root, id)| {
        let access = root?;
        Some(Source {
            root: access.location(),
            access: access.clone(),
            directory: id.directory().into(),
            scope: id.scope(),
            source: id.source(),
            reference_prefix: id.reference().into(),
        })
    })
    .collect()
}

fn skill(path: &Path, name: &str, requirements: &str, body: &str) -> Vec<u8> {
    fs::create_dir_all(path).unwrap();
    let bytes = format!(
        "---\r\nname: {name}\r\ndescription: local instructions\r\n{requirements}---\r\n{body}"
    )
    .into_bytes();
    fs::write(path.join("SKILL.md"), &bytes).unwrap();
    bytes
}

#[tokio::test]
async fn discovery_reads_only_contained_regular_files_and_reports_source_failures() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("root");
    let outside = temporary.path().join("outside");
    skill(&root.join(".maka/skills/normal"), "Normal", "", "local");
    skill(&root.join("store/linked"), "Linked", "", "inside");
    skill(&outside.join("skills/leak"), "Leak", "", "outside");
    directory_link(
        &root.join("store/linked"),
        &root.join(".maka/skills/inside"),
    );
    directory_link(
        &root.join(".maka/skills/inside"),
        &root.join(".maka/skills/chain"),
    );
    directory_link(
        &outside.join("skills/leak"),
        &root.join(".maka/skills/escape"),
    );
    directory_link(&outside, &root.join(".agents"));
    let owner = owner();
    let root_files = view(&owner, &root).await;
    fs::create_dir_all(root.join(".maka/skills/large")).unwrap();
    fs::File::create(root.join(".maka/skills/large/SKILL.md"))
        .unwrap()
        .set_len(1024 * 1024 + 1)
        .unwrap();
    #[cfg(unix)]
    {
        let linked_file = root.join(".maka/skills/linked-file");
        fs::create_dir_all(&linked_file).unwrap();
        std::os::unix::fs::symlink(
            root.join(".maka/skills/normal/SKILL.md"),
            linked_file.join("SKILL.md"),
        )
        .unwrap();
        let pipe = root.join(".maka/skills/pipe");
        fs::create_dir_all(&pipe).unwrap();
        let status = std::process::Command::new("mkfifo")
            .arg(pipe.join("SKILL.md"))
            .status()
            .unwrap();
        assert!(status.success());
    }
    let snapshot = scan(&sources(Some(&root_files), None), &CancellationToken::new())
        .await
        .unwrap();
    let ids: BTreeSet<_> = snapshot
        .inventory
        .iter()
        .map(|skill| skill.location.id.as_str())
        .collect();
    assert_eq!(ids, BTreeSet::from(["chain", "inside", "normal"]));
    let rejected = snapshot
        .rejected
        .iter()
        .find(|skill| skill.location.id == "large")
        .unwrap();
    assert_eq!(
        rejected.content_sha256,
        maka_agent_facts::artifact::content_digest(&vec![0; 1024 * 1024 + 1])
    );
    for (relative, reason) in [
        (".maka/skills/escape", DiscoveryFailure::BlockedPath),
        (".agents/skills", DiscoveryFailure::BlockedPath),
    ] {
        assert!(
            snapshot
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.path == root.join(relative)
                    && diagnostic.reason == reason),
            "{relative}: {:?}",
            snapshot.diagnostics
        );
    }
    #[cfg(unix)]
    for relative in [".maka/skills/linked-file", ".maka/skills/pipe"] {
        assert!(
            snapshot
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.path == root.join(relative)
                    && diagnostic.reason == DiscoveryFailure::BlockedPath)
        );
    }
}

#[cfg(unix)]
fn directory_link(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).unwrap();
}
#[cfg(windows)]
fn directory_link(target: &Path, link: &Path) {
    // Junctions exercise Windows directory reparse boundaries without requiring
    // Developer Mode or changing the machine's symlink privilege policy.
    // mklink treats forward slashes as switches, unlike Rust filesystem APIs.
    let link: std::path::PathBuf = link.components().collect();
    let target: std::path::PathBuf = target.components().collect();
    let output = std::process::Command::new("cmd")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
