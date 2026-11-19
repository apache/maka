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

use super::{Stage, open_source, rename};
use crate::{remote, sources};
use cap_std::fs::Dir;
use maka_sandbox::filesystem::{Access, Policy};
use maka_skills::LocationId;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

fn directory(path: &Path) -> Dir {
    Dir::open_ambient_dir(path, cap_std::ambient_authority()).unwrap()
}

fn home(path: &Path) -> sources::CapturedSource {
    fs::create_dir_all(path).unwrap();
    let path = fs::canonicalize(path).unwrap();
    let policy = Arc::new(Policy::uniform(Access::Read).compile().unwrap());
    sources::home(path.to_str().unwrap(), policy)
        .unwrap()
        .into_iter()
        .find(|source| source.location == Some(LocationId::UserMaka))
        .unwrap()
}

fn skill(path: &Path, name: &str, body: &str, resource: &str, bytes: &[u8]) {
    fs::create_dir_all(path.join("resources/nested")).unwrap();
    fs::create_dir_all(path.join(".git")).unwrap();
    fs::write(
        path.join("SKILL.md"),
        format!(
            "---\nname: {name}\ndescription: Native filesystem boundary regression.\n---\n{body}\n"
        ),
    )
    .unwrap();
    fs::write(path.join("resources/nested").join(resource), bytes).unwrap();
    fs::write(path.join(".git/ignored"), b"not a skill resource").unwrap();
}

fn no_stages(home: &Path) {
    assert!(fs::read_dir(home.join(".maka")).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".skills-")
    }));
}

#[test]
fn source_selection_stays_inside_repository_and_outside_private_data() {
    let temporary = tempfile::tempdir().unwrap();
    let repo = temporary.path().join("repo");
    fs::create_dir_all(repo.join("private")).unwrap();
    let repo = fs::canonicalize(repo).unwrap();
    let private = fs::canonicalize(repo.join("private")).unwrap();
    let target = home(&repo.join("home"));
    let selected = repo.join("nested/selected");
    skill(
        &selected,
        "selected-skill",
        "selected body",
        "original.bin",
        &[0, 17, 255],
    );
    fs::create_dir_all(temporary.path().join("outside")).unwrap();
    let root = directory(&repo);
    let relative = PathBuf::from("nested").join("selected");
    let opened = open_source(&root, &repo, relative.to_str().unwrap(), &private, &target).unwrap();
    let text = remote::read_manifest(&opened).unwrap();
    let parsed = maka_skills::parse(&text).unwrap();
    assert_eq!(parsed.manifest.name, "selected-skill");
    assert_eq!(parsed.body.trim(), "selected body");
    assert_eq!(
        opened.read("resources/nested/original.bin").unwrap(),
        [0, 17, 255]
    );
    assert!(open_source(&root, &repo, "../outside", &private, &target).is_err());
    assert!(open_source(&root, &repo, selected.to_str().unwrap(), &private, &target).is_err());
    #[cfg(windows)]
    for path in ["C:relative", "\\rooted", "..\\outside"] {
        assert!(
            open_source(&root, &repo, path, &private, &target).is_err(),
            "{path}"
        );
    }
    let private_error = open_source(&root, &repo, "private", &private, &target).unwrap_err();
    assert!(private_error.contains("overlaps private Host data"));
    let own_source_error = open_source(&root, &repo, "home", &private, &target).unwrap_err();
    assert!(own_source_error.contains("cannot be installed inside its source"));
    assert!(
        selected.join("SKILL.md").is_file(),
        "rejected selection cannot move source files"
    );
}

#[test]
fn staged_publication_closes_handles_and_restores_previous_skill_on_failure() {
    let temporary = tempfile::tempdir().unwrap();
    let home_path = temporary.path().join("home");
    let target = home(&home_path);
    let v1 = temporary.path().join("v1");
    let v2 = temporary.path().join("v2");
    skill(
        &v1,
        "native-skill",
        "first version",
        "old.bin",
        &[0, 1, 255],
    );
    skill(&v2, "native-skill", "second version", "new.bin", &[3, 4, 0]);
    let source1 = directory(&v1);
    let source2 = directory(&v2);
    let cancellation = CancellationToken::new();
    let installed = home_path.join(".maka/skills/native-skill");
    let mut initial = Stage::new(&target, "native-skill").unwrap();
    initial.prepare(&source1, &cancellation).unwrap();
    initial.publish(false).unwrap();
    initial.cleanup().unwrap();
    assert_eq!(
        fs::read(installed.join("SKILL.md")).unwrap(),
        fs::read(v1.join("SKILL.md")).unwrap()
    );
    assert_eq!(
        fs::read(installed.join("resources/nested/old.bin")).unwrap(),
        [0, 1, 255]
    );
    assert!(!installed.join(".git").exists());
    no_stages(&home_path);

    let mut replacement = Stage::new(&target, "native-skill").unwrap();
    replacement.prepare(&source2, &cancellation).unwrap();
    let error = replacement
        .publish_using(true, |root, from, to| {
            if from.ends_with("/next") {
                Err("injected publication failure".into())
            } else {
                rename(root, from, to)
            }
        })
        .unwrap_err();
    assert_eq!(error, "injected publication failure");
    assert_eq!(
        fs::read(installed.join("SKILL.md")).unwrap(),
        fs::read(v1.join("SKILL.md")).unwrap()
    );
    assert_eq!(
        fs::read(installed.join("resources/nested/old.bin")).unwrap(),
        [0, 1, 255]
    );
    assert!(!installed.join("resources/nested/new.bin").exists());
    replacement.cleanup().unwrap();
    no_stages(&home_path);

    let mut final_stage = Stage::new(&target, "native-skill").unwrap();
    final_stage.prepare(&source2, &cancellation).unwrap();
    final_stage.publish(true).unwrap();
    final_stage.cleanup().unwrap();
    assert_eq!(
        fs::read(installed.join("SKILL.md")).unwrap(),
        fs::read(v2.join("SKILL.md")).unwrap()
    );
    assert_eq!(
        fs::read(installed.join("resources/nested/new.bin")).unwrap(),
        [3, 4, 0]
    );
    assert!(!installed.join("resources/nested/old.bin").exists());
    assert!(!installed.join(".git").exists());
    no_stages(&home_path);
}
