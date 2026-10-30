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

use maka_skills::SkillFailureReason;
use maka_skills::{
    Catalog, DiscoveryFailure, HostCapabilities, Preference, Preferences, ScanError, Source, scan,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};
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
async fn snapshot_precedence_preferences_and_capabilities_preserve_selected_identity() {
    let temporary = tempfile::tempdir().unwrap();
    let project = temporary.path().join("project");
    let home = temporary.path().join("home");
    for (path, name) in [
        (project.join(".agents/skills/REVIEW"), "Primary"),
        (home.join(".maka/skills/duplicate"), "Primary"),
    ] {
        skill(&path, name, "", "unused");
    }
    let original = skill(
        &project.join(".maka/skills/review"),
        "Primary",
        "required-tools: Read\r\nallowed-tools: UnregisteredHint\r\n",
        "frozen\r\n  instructions",
    );
    skill(
        &home.join(".agents/skills/alias"),
        "review",
        "",
        "wrong display-name match",
    );
    skill(
        &project.join(".maka/skills/network"),
        "project:agents:REVIEW",
        "required-capabilities: network\r\n",
        "network",
    );
    skill(
        &project.join(".maka/skills/large"),
        "Large",
        "",
        &"😀".repeat(24_001),
    );
    let large_path = project.join(".maka/skills/large/SKILL.md");
    let large_document = fs::read_to_string(&large_path).unwrap();
    fs::write(
        large_path,
        large_document.replace(
            "description: local instructions",
            &format!("description: {}", "Detailed ".repeat(80)),
        ),
    )
    .unwrap();
    skill(
        &project.join(".maka/skills/invalid"),
        "Invalid",
        "required-tools: 42\r\n",
        "invalid",
    );
    let owner = owner();
    let project_files = view(&owner, &project).await;
    let home_files = view(&owner, &home).await;
    let sources = sources(Some(&project_files), Some(&home_files));
    let snapshot = scan(&sources, &CancellationToken::new()).await.unwrap();
    assert!(snapshot.diagnostics.is_empty());
    assert_eq!(snapshot.inventory.len(), 6);
    assert_eq!(snapshot.rejected.len(), 1);
    let review = snapshot
        .inventory
        .iter()
        .find(|skill| skill.location.reference == "project:maka:review")
        .unwrap();
    assert_eq!(
        review.content_sha256,
        maka_agent_facts::artifact::content_digest(&original)
    );
    assert_eq!(
        snapshot
            .inventory
            .iter()
            .filter(|skill| skill.shadowed_by.as_deref() == Some("project:maka:review"))
            .count(),
        2
    );
    fs::write(
        project.join(".maka/skills/review/SKILL.md"),
        "replaced after scan",
    )
    .unwrap();
    let mut host = HostCapabilities::default();
    host.tools.insert("Read".into());
    let preferences = Preferences::Available(BTreeMap::new());
    let mut capable = HostCapabilities::default();
    capable.capabilities.insert("network".into());
    let capable_catalog = Catalog {
        discovery: &snapshot,
        preferences: &preferences,
        host: &capable,
    };
    assert_eq!(
        capable_catalog.load("project:agents:REVIEW").unwrap_err(),
        SkillFailureReason::NotFound
    );
    let catalog = Catalog {
        discovery: &snapshot,
        preferences: &preferences,
        host: &host,
    };
    let loaded = catalog.load(" PrImArY ").unwrap();
    assert_eq!(
        catalog.load("review").unwrap().skill.location.reference,
        "user:agents:alias"
    );
    let search = catalog.search(" \u{feff}rEvIeW\t", Some(1));
    assert_eq!(search.query, "review");
    assert_eq!(search.matches[0].skill.reference, "project:maka:review");
    assert_eq!(search.matched_count, 2);
    assert!(search.truncated);
    let pinned = Preferences::Available(BTreeMap::from([(
        "project:maka:large".into(),
        Preference {
            enabled: true,
            pinned: true,
        },
    )]));
    let pinned_catalog = Catalog {
        preferences: &pinned,
        ..catalog
    };
    assert_eq!(
        pinned_catalog
            .search("unrelated vocabulary", None)
            .matched_count,
        0,
        "pinning does not create a match"
    );
    let listing = pinned_catalog.search("", Some(1));
    assert_eq!(listing.matches[0].skill.reference, "project:maka:large");
    assert_eq!(listing.matched_count, pinned_catalog.available().count());
    assert!(listing.truncated);
    let disabled = Preferences::Available(BTreeMap::from([(
        "project:maka:review".into(),
        Preference {
            enabled: false,
            pinned: false,
        },
    )]));
    let disabled_catalog = Catalog {
        preferences: &disabled,
        ..catalog
    };
    let listing = disabled_catalog.search("", None);
    assert_eq!(listing.matches.len(), disabled_catalog.available().count());
    assert!(
        listing
            .matches
            .iter()
            .all(|entry| entry.skill.id != "review")
    );
    let long_query = catalog.search(&"😀".repeat(300), None);
    assert_eq!(long_query.query, "😀".repeat(300));
    for budget in [0, 100, 600, 18_000] {
        let prompt = catalog.prompt(budget, maka_agent_facts::language::Language::En);
        assert!(prompt.len() <= budget);
        assert!(!prompt.contains("frozen"));
        if budget == 600 {
            assert!(prompt.contains("additional enabled skill(s) omitted"));
        }
    }
    for (language, omitted) in [
        (
            maka_agent_facts::language::Language::En,
            "additional enabled skill(s) omitted",
        ),
        (
            maka_agent_facts::language::Language::ZhCn,
            "个已启用的技能未列出",
        ),
        (
            maka_agent_facts::language::Language::ZhTw,
            "個已啟用的技能未列出",
        ),
    ] {
        let prompt = catalog.prompt_with(
            600,
            "captured host introduction",
            "find remaining skills",
            language,
        );
        assert!(!prompt.is_empty());
        assert!(prompt.len() <= 600);
        assert!(prompt.contains(omitted));
        assert!(prompt.contains("captured host introduction"));
        assert!(prompt.contains("find remaining skills"));
        assert!(!prompt.contains("frozen"));
    }
    assert_eq!(loaded.skill.location.reference, "project:maka:review");
    assert_eq!(loaded.instructions, "frozen\n  instructions");
    assert_eq!(
        loaded.relative_path,
        Path::new(".maka/skills/review/SKILL.md")
    );
    assert_eq!(
        catalog.load("network").unwrap_err(),
        SkillFailureReason::HostIncompatible
    );
    assert_eq!(
        catalog.load("bad\0request").unwrap_err(),
        SkillFailureReason::InvalidName
    );
    let long = catalog.load("large").unwrap();
    assert_eq!(long.instructions, "😀".repeat(24_001));
    let disabled = Preferences::Available(BTreeMap::from([(
        "project:maka:review".into(),
        Preference {
            enabled: false,
            pinned: true,
        },
    )]));
    let catalog = Catalog {
        preferences: &disabled,
        ..catalog
    };
    assert_eq!(
        catalog.load("primary").unwrap_err(),
        SkillFailureReason::Disabled
    );
    assert_eq!(
        catalog.load("project:maka:review").unwrap_err(),
        SkillFailureReason::Disabled
    );
    assert_eq!(
        catalog.load("user:agents:alias").unwrap().instructions,
        "wrong display-name match"
    );
    let unavailable = Preferences::Unavailable;
    let catalog = Catalog {
        preferences: &unavailable,
        ..catalog
    };
    assert_eq!(catalog.available().count(), 0);
    assert_eq!(
        catalog.load("review").unwrap_err(),
        SkillFailureReason::ResolutionFailed
    );
    let cancellation = CancellationToken::new();
    cancellation.cancel();
    assert_eq!(
        scan(&sources, &cancellation).await.unwrap_err(),
        ScanError::Cancelled
    );
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

#[tokio::test]
async fn linked_resources_freeze_with_the_skill_and_preserve_paging_and_containment() {
    use maka_agent_facts::read::ReadInput;
    let temporary = tempfile::tempdir().unwrap();
    let project = temporary.path().join("project");
    let directory = project.join(".maka/skills/authoring");
    skill(&directory, "Authoring", "", "Read references/guide.md");
    fs::create_dir_all(directory.join("references")).unwrap();
    let text = "Original 中文🦀\n".repeat(1500);
    fs::write(directory.join("references/guide.md"), &text).unwrap();
    fs::write(
        directory.join("references/oversized.md"),
        vec![b'x'; 1024 * 1024 + 1],
    )
    .unwrap();
    fs::write(directory.join("references/binary.bin"), [0xff]).unwrap();
    fs::create_dir_all(directory.join(".maka")).unwrap();
    fs::write(directory.join(".maka/private.txt"), "private").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(temporary.path(), directory.join("references/escape")).unwrap();
    let owner = owner();
    let files = view(&owner, &project).await;
    let sources = sources(Some(&files), None);
    let old = scan(&sources, &CancellationToken::new()).await.unwrap();
    let preferences = Preferences::Available(Default::default());
    let host = HostCapabilities::default();
    let catalog = Catalog {
        discovery: &old,
        preferences: &preferences,
        host: &host,
    };
    let old_hash = catalog.fingerprint().unwrap();
    let loaded = catalog.load("authoring").unwrap();
    let reference = &loaded.skill.location.reference;
    let input = ReadInput {
        path: "references/guide.md".into(),
        offset: None,
        limit: None,
    };
    let (_, page) = loaded.skill.resources.page(reference, &input).unwrap();
    let next = page.next.unwrap();
    assert!(
        loaded
            .skill
            .resources
            .page("project:maka:other", &next)
            .is_err()
    );
    fs::write(directory.join("references/guide.md"), "Changed").unwrap();
    let (_, continued) = loaded.skill.resources.page(reference, &next).unwrap();
    assert!(continued.content.contains("Original"));
    for path in [
        "../outside",
        "/absolute",
        "references/../../outside",
        "references\\guide.md",
        ".maka/private.txt",
        "references/escape/file",
        "references/binary.bin",
    ] {
        let input = ReadInput {
            path: path.into(),
            offset: None,
            limit: None,
        };
        assert!(
            loaded.skill.resources.page(reference, &input).is_err(),
            "{path}"
        );
    }
    let (_, oversized) = loaded
        .skill
        .resources
        .page(
            reference,
            &ReadInput {
                path: "references/oversized.md".into(),
                offset: None,
                limit: None,
            },
        )
        .unwrap();
    assert!(oversized.content.starts_with("xxxx"));
    assert!(oversized.next.is_some());
    let current = scan(&sources, &CancellationToken::new()).await.unwrap();
    let current_catalog = Catalog {
        discovery: &current,
        preferences: &preferences,
        host: &host,
    };
    assert_ne!(old_hash, current_catalog.fingerprint().unwrap());
    let current = current_catalog.load("authoring").unwrap();
    assert_eq!(
        current
            .skill
            .resources
            .page(reference, &input)
            .unwrap()
            .1
            .content,
        "Changed"
    );
    assert!(
        current
            .skill
            .resources
            .page(reference, &next)
            .unwrap_err()
            .contains("changed")
    );
    let disabled = Preferences::Available(BTreeMap::from([(
        reference.clone(),
        Preference {
            enabled: false,
            pinned: false,
        },
    )]));
    assert!(
        Catalog {
            discovery: &old,
            preferences: &disabled,
            host: &host
        }
        .load("authoring")
        .is_err()
    );
    owner.finish().await.unwrap();
    assert!(
        loaded
            .skill
            .resources
            .page(reference, &input)
            .unwrap()
            .1
            .content
            .starts_with("Original")
    );
}

#[tokio::test]
async fn same_named_skills_select_whole_directories_and_fall_back_after_removal() {
    use maka_agent_facts::read::ReadInput;
    let temporary = tempfile::tempdir().unwrap();
    let project = temporary.path().join("project");
    let home = temporary.path().join("home");
    let editions = [
        (
            project.join(".maka/skills/project-maka"),
            "project maka",
            "project maka resource",
        ),
        (
            project.join(".agents/skills/project-agents"),
            "project agents",
            "project agents resource",
        ),
        (
            home.join(".maka/skills/user-maka"),
            "user maka",
            "user maka resource",
        ),
        (
            home.join(".agents/skills/user-agents"),
            "user agents",
            "user agents resource",
        ),
    ];
    for (path, body, resource) in &editions {
        skill(path, "shared-review", "", body);
        fs::create_dir_all(path.join("references")).unwrap();
        fs::write(path.join("references/guide.md"), resource).unwrap();
    }
    let owner = owner();
    let project_files = view(&owner, &project).await;
    let home_files = view(&owner, &home).await;
    let sources = sources(Some(&project_files), Some(&home_files));
    let preferences = Preferences::Available(BTreeMap::new());
    let host = HostCapabilities::default();
    for (index, (path, body, resource)) in editions.iter().enumerate() {
        let snapshot = scan(&sources, &CancellationToken::new()).await.unwrap();
        let catalog = Catalog {
            discovery: &snapshot,
            preferences: &preferences,
            host: &host,
        };
        assert_eq!(snapshot.inventory.len(), editions.len() - index);
        assert_eq!(catalog.available().count(), 1);
        let loaded = catalog.load("shared-review").unwrap();
        assert_eq!(loaded.instructions, *body);
        let (_, page) = loaded
            .skill
            .resources
            .page(
                &loaded.skill.location.reference,
                &ReadInput {
                    path: "references/guide.md".into(),
                    offset: None,
                    limit: None,
                },
            )
            .unwrap();
        assert_eq!(page.content, *resource);
        assert!(
            snapshot
                .inventory
                .iter()
                .filter(|entry| entry.location.path != *path)
                .all(|entry| entry.shadowed_by.as_deref()
                    == Some(loaded.skill.location.reference.as_str()))
        );
        fs::remove_dir_all(path).unwrap();
    }
}
