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
use std::{fs, io::Write, path::PathBuf, process::Command, time::SystemTime};

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    private: PathBuf,
    identity: DirectoryIdentity,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repository");
        let private = temp.path().join("private");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&private).unwrap();
        git(&root, &["init", "--quiet"]);
        git(&root, &["config", "user.name", "Maka tests"]);
        git(&root, &["config", "user.email", "tests@maka.invalid"]);
        let (root, identity) = crate::directory::capture(&root).unwrap();
        Self {
            _temp: temp,
            root,
            private,
            identity,
        }
    }
    fn commit(&self) {
        git(&self.root, &["add", "."]);
        git(&self.root, &["commit", "--quiet", "-m", "base"]);
    }
    fn status(&self) -> GitStatus {
        status(&self.root, &self.identity, &self.private, None, cancel())
            .unwrap()
            .unwrap()
    }
    fn diff(&self, area: GitArea, name: &[u8]) -> GitDiff {
        diff(
            &self.root,
            &self.identity,
            &self.private,
            None,
            area,
            &WorkspacePath::from_bytes(name).unwrap(),
            cancel(),
        )
        .unwrap()
        .unwrap()
    }
}
fn cancel() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(false))
}
fn git(root: &Path, args: &[&str]) {
    git_stdout(root, args);
}
fn git_command(root: &Path, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command
        .current_dir(root)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .args(args);
    command
}
fn git_stdout(root: &Path, args: &[&str]) -> Vec<u8> {
    let output = git_command(root, args).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}
fn entries(status: GitStatus) -> Vec<(GitArea, Vec<u8>, GitChangeKind)> {
    status
        .entries
        .into_iter()
        .map(|e| (e.area, e.path.bytes().unwrap(), e.kind))
        .collect()
}

#[test]
fn staged_worktree_and_untracked_are_distinct_and_diff_literal_images() {
    let f = Fixture::new();
    fs::write(f.root.join("file.txt"), "original\n").unwrap();
    fs::write(f.root.join("deleted.txt"), "delete me\n").unwrap();
    f.commit();
    fs::write(f.root.join("file.txt"), "staged\n").unwrap();
    git(&f.root, &["add", "file.txt"]);
    fs::write(f.root.join("file.txt"), "working\n").unwrap();
    fs::remove_file(f.root.join("deleted.txt")).unwrap();
    fs::write(f.root.join("untracked.txt"), "new content\n").unwrap();
    assert_eq!(
        entries(f.status()),
        vec![
            (
                GitArea::Staged,
                b"file.txt".to_vec(),
                GitChangeKind::Modified
            ),
            (
                GitArea::Worktree,
                b"deleted.txt".to_vec(),
                GitChangeKind::Deleted
            ),
            (
                GitArea::Worktree,
                b"file.txt".to_vec(),
                GitChangeKind::Modified
            ),
            (
                GitArea::Untracked,
                b"untracked.txt".to_vec(),
                GitChangeKind::Added
            ),
        ]
    );
    let GitDiff::Text { patch } = f.diff(GitArea::Staged, b"file.txt") else {
        panic!("expected staged text")
    };
    assert!(
        patch.contains("@@ -1,1 +1,1 @@\n-original\n+staged\n"),
        "{patch}"
    );
    assert!(!patch.contains("working"));
    let GitDiff::Text { patch } = f.diff(GitArea::Worktree, b"file.txt") else {
        panic!("expected working text")
    };
    assert!(
        patch.contains("@@ -1,1 +1,1 @@\n-staged\n+working\n"),
        "{patch}"
    );
    assert_eq!(f.diff(GitArea::Untracked, b"file.txt"), GitDiff::Unchanged);
    let GitDiff::Text { patch } = f.diff(GitArea::Untracked, b"untracked.txt") else {
        panic!("expected untracked text")
    };
    assert!(
        patch.contains("--- /dev/null\n+++ \"b/untracked.txt\"\n@@ -1,0 +1,1 @@\n+new content\n"),
        "{patch}"
    );
}

#[test]
fn unborn_repository_uses_empty_head_and_prunes_ignored_dependency_tree() {
    let f = Fixture::new();
    fs::write(f.root.join(".gitignore"), "node_modules/\n").unwrap();
    fs::create_dir(f.root.join("node_modules")).unwrap();
    // If the preflight enters this ignored tree, this invalid control file fails it.
    fs::create_dir(f.root.join("node_modules/.gitignore")).unwrap();
    fs::write(f.root.join("new.txt"), "before commit\n").unwrap();
    git(&f.root, &["add", "new.txt"]);
    let result = f.status();
    assert_eq!(result.head, None);
    assert_eq!(
        entries(result),
        vec![
            (GitArea::Staged, b"new.txt".to_vec(), GitChangeKind::Added),
            (
                GitArea::Untracked,
                b".gitignore".to_vec(),
                GitChangeKind::Added
            ),
        ]
    );
    let GitDiff::Text { patch } = f.diff(GitArea::Staged, b"new.txt") else {
        panic!("expected unborn staged text")
    };
    assert!(patch.contains("+before commit\n"));
    // Ignoring a directory does not hide a file already tracked inside it.
    fs::remove_dir(f.root.join("node_modules/.gitignore")).unwrap();
    fs::write(f.root.join("node_modules/tracked"), "tracked before\n").unwrap();
    git(&f.root, &["add", "-f", "node_modules/tracked"]);
    f.commit();
    fs::write(f.root.join("node_modules/tracked"), "tracked after\n").unwrap();
    assert_eq!(
        entries(f.status()),
        vec![(
            GitArea::Worktree,
            b"node_modules/tracked".to_vec(),
            GitChangeKind::Modified
        )]
    );
}

struct ReadOnlySnapshot {
    index: Vec<u8>,
    index_modified: SystemTime,
    head: Vec<u8>,
    files: Vec<(String, Vec<u8>, SystemTime)>,
}
impl ReadOnlySnapshot {
    fn capture(f: &Fixture, names: &[&str]) -> Self {
        let index = f.root.join(".git/index");
        Self {
            index: fs::read(&index).unwrap(),
            index_modified: fs::metadata(&index).unwrap().modified().unwrap(),
            head: git_stdout(&f.root, &["rev-parse", "HEAD"]),
            files: names
                .iter()
                .map(|name| {
                    let path = f.root.join(name);
                    (
                        (*name).to_owned(),
                        fs::read(&path).unwrap(),
                        fs::metadata(&path).unwrap().modified().unwrap(),
                    )
                })
                .collect(),
        }
    }
    fn assert_unchanged(&self, f: &Fixture) {
        let index = f.root.join(".git/index");
        assert!(
            fs::read(&index).unwrap() == self.index,
            "index bytes changed"
        );
        assert_eq!(
            fs::metadata(&index).unwrap().modified().unwrap(),
            self.index_modified
        );
        assert_eq!(git_stdout(&f.root, &["rev-parse", "HEAD"]), self.head);
        for (name, bytes, modified) in &self.files {
            let path = f.root.join(name);
            assert!(
                fs::read(&path).unwrap() == *bytes,
                "worktree bytes changed: {name}"
            );
            assert_eq!(
                fs::metadata(&path).unwrap().modified().unwrap(),
                *modified,
                "worktree mtime changed: {name}"
            );
        }
    }
}

#[test]
fn binary_previews_do_not_return_partial_text() {
    let f = Fixture::new();
    fs::write(f.root.join("binary"), [0, 255, 10]).unwrap();
    assert_eq!(f.diff(GitArea::Untracked, b"binary"), GitDiff::Binary);
    let mut large_binary = vec![b'x'; 1_100_000];
    large_binary[0] = 0;
    large_binary[1_099_999] = 255;
    fs::write(f.root.join("large-binary"), &large_binary).unwrap();
    assert_eq!(f.diff(GitArea::Untracked, b"large-binary"), GitDiff::Binary);
    assert_eq!(fs::read(f.root.join("large-binary")).unwrap(), large_binary);
}

#[test]
fn linked_and_managed_worktrees_use_original_metadata_without_private_root_escape() {
    let f = Fixture::new();
    fs::write(f.root.join("source.txt"), "source\n").unwrap();
    f.commit();
    let linked = f._temp.path().join("linked");
    git(
        &f.root,
        &[
            "worktree",
            "add",
            "--quiet",
            "--detach",
            linked.to_str().unwrap(),
        ],
    );
    let (linked, identity) = crate::directory::capture(&linked).unwrap();
    fs::write(linked.join("source.txt"), "linked edit\n").unwrap();
    assert_eq!(
        entries(
            status(&linked, &identity, &f.private, None, cancel())
                .unwrap()
                .unwrap()
        ),
        vec![(
            GitArea::Worktree,
            b"source.txt".to_vec(),
            GitChangeKind::Modified
        )]
    );
    let manager = crate::worktree::Worktrees::open(&f.private.join("subagent-worktrees")).unwrap();
    let binding = manager.plan(&f.root, &"1".repeat(64), cancel()).unwrap();
    manager.ensure(&binding, &AtomicBool::new(false)).unwrap();
    let (root, identity) = crate::directory::capture(binding.directory()).unwrap();
    fs::write(root.join("source.txt"), "managed edit\n").unwrap();
    assert_eq!(
        entries(
            status(&root, &identity, &f.private, Some(&binding), cancel())
                .unwrap()
                .unwrap()
        ),
        vec![(
            GitArea::Worktree,
            b"source.txt".to_vec(),
            GitChangeKind::Modified
        )]
    );
    assert_eq!(
        status(&root, &identity, &f.private, None, cancel())
            .unwrap_err()
            .to_string(),
        "git_private"
    );
}

#[test]
fn filters_subdirectories_private_overlap_and_cancellation_fail_with_static_codes() {
    let f = Fixture::new();
    fs::write(f.root.join("tracked"), "safe\n").unwrap();
    f.commit();
    fs::create_dir(f.root.join("subdirectory")).unwrap();
    let (sub, identity) = crate::directory::capture(&f.root.join("subdirectory")).unwrap();
    assert_eq!(
        status(&sub, &identity, &f.private, None, cancel())
            .unwrap_err()
            .to_string(),
        "git_unsupported"
    );
    let nested_private = f.root.join("state");
    fs::create_dir(&nested_private).unwrap();
    assert_eq!(
        status(&f.root, &f.identity, &nested_private, None, cancel())
            .unwrap_err()
            .to_string(),
        "git_private"
    );
    let cancelled = Arc::new(AtomicBool::new(true));
    assert_eq!(
        status(&f.root, &f.identity, &f.private, None, cancelled)
            .unwrap_err()
            .to_string(),
        "git_cancelled"
    );
    let sentinel = f._temp.path().join("executed");
    git(
        &f.root,
        &[
            "config",
            "filter.malicious.clean",
            &format!("touch {}", sentinel.display()),
        ],
    );
    fs::write(f.root.join(".gitattributes"), "tracked filter=malicious\n").unwrap();
    assert_eq!(
        status(&f.root, &f.identity, &f.private, None, cancel())
            .unwrap_err()
            .to_string(),
        "git_unsupported"
    );
    assert!(!sentinel.exists());
}

#[cfg(unix)]
#[test]
fn raw_names_and_link_content_roundtrip_without_following_control_file_escapes() {
    use std::os::unix::{ffi::OsStringExt, fs::symlink};
    let f = Fixture::new();
    // APFS rejects ill-formed UTF-8 names before any Git/backend operation.
    #[cfg(target_os = "macos")]
    let name = b"raw-\\name";
    #[cfg(not(target_os = "macos"))]
    let name = b"raw-\xff\\name";
    fs::write(
        f.root.join(std::ffi::OsString::from_vec(name.to_vec())),
        "raw name\n",
    )
    .unwrap();
    assert_eq!(
        entries(f.status()),
        vec![(GitArea::Untracked, name.to_vec(), GitChangeKind::Added)]
    );
    assert!(matches!(
        f.diff(GitArea::Untracked, name),
        GitDiff::Text { .. }
    ));
    fs::write(f.private.join("secret"), "private sentinel").unwrap();
    symlink(f.private.join("secret"), f.root.join("link")).unwrap();
    let GitDiff::Text { patch } = f.diff(GitArea::Untracked, b"link") else {
        panic!("expected link literal")
    };
    assert!(!patch.contains("private sentinel"));
    symlink(f.private.join("secret"), f.root.join(".gitignore")).unwrap();
    assert_eq!(
        status(&f.root, &f.identity, &f.private, None, cancel())
            .unwrap_err()
            .to_string(),
        "git_unsupported"
    );
    fs::remove_file(f.root.join(".gitignore")).unwrap();
    fs::create_dir_all(f.root.join(".git/objects/info")).unwrap();
    fs::write(
        f.root.join(".git/objects/info/alternates"),
        f.private.to_string_lossy().as_bytes(),
    )
    .unwrap();
    assert_eq!(
        status(&f.root, &f.identity, &f.private, None, cancel())
            .unwrap_err()
            .to_string(),
        "git_unsupported"
    );
}

#[test]
fn conflicted_index_is_visible_but_has_no_fabricated_two_way_diff() {
    let f = Fixture::new();
    fs::write(f.root.join("conflict"), "base\n").unwrap();
    f.commit();
    git(&f.root, &["checkout", "--quiet", "-b", "ours"]);
    fs::write(f.root.join("conflict"), "ours\n").unwrap();
    f.commit();
    git(&f.root, &["checkout", "--quiet", "-b", "theirs", "HEAD~1"]);
    fs::write(f.root.join("conflict"), "theirs\n").unwrap();
    f.commit();
    let output = Command::new("git")
        .current_dir(&f.root)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .args(["merge", "--no-edit", "ours"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(
        entries(f.status()),
        vec![(
            GitArea::Worktree,
            b"conflict".to_vec(),
            GitChangeKind::Conflicted
        ),]
    );
    assert_eq!(f.diff(GitArea::Staged, b"conflict"), GitDiff::Unsupported);
    assert_eq!(f.diff(GitArea::Worktree, b"conflict"), GitDiff::Unsupported);
}

#[cfg(unix)]
#[test]
fn split_index_reads_regular_shared_indexes_and_rejects_links_and_corruption() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    fs::write(f.root.join("tracked"), "safe\n").unwrap();
    f.commit();
    git(&f.root, &["update-index", "--split-index"]);
    assert_eq!(entries(f.status()), vec![]);
    let shared = fs::read_dir(f.root.join(".git"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| {
            p.file_name()
                .unwrap()
                .as_encoded_bytes()
                .starts_with(b"sharedindex.")
        })
        .unwrap();
    let bytes = fs::read(&shared).unwrap();
    let private_copy = f.private.join("sharedindex");
    fs::write(&private_copy, &bytes).unwrap();
    fs::remove_file(&shared).unwrap();
    symlink(&private_copy, &shared).unwrap();
    let result = status(&f.root, &f.identity, &f.private, None, cancel());
    fs::remove_file(&shared).unwrap();
    fs::write(&shared, &bytes).unwrap();
    #[cfg(target_os = "macos")]
    let uppercase_result = {
        let suffix = shared
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .strip_prefix("sharedindex.")
            .unwrap();
        let uppercase = shared.with_file_name(format!("SHAREDINDEX.{suffix}"));
        fs::rename(&shared, &uppercase).unwrap();
        assert_eq!(entries(f.status()), vec![]);
        fs::remove_file(&uppercase).unwrap();
        symlink(&private_copy, &uppercase).unwrap();
        let result = status(&f.root, &f.identity, &f.private, None, cancel());
        fs::remove_file(&uppercase).unwrap();
        fs::write(&shared, &bytes).unwrap();
        result
    };
    let mut corrupt = fs::OpenOptions::new().write(true).open(&shared).unwrap();
    corrupt.write_all(b"BAD!").unwrap();
    drop(corrupt);
    let invalid = status(&f.root, &f.identity, &f.private, None, cancel());
    drop(f);
    assert_eq!(result.unwrap_err().to_string(), "git_unsupported");
    assert_eq!(invalid.unwrap_err().to_string(), "git_unavailable");
    #[cfg(target_os = "macos")]
    assert_eq!(uppercase_result.unwrap_err().to_string(), "git_unsupported");
}

fn observe_diff(f: &Fixture, area: GitArea, name: &[u8]) -> io::Result<Option<GitDiff>> {
    diff(
        &f.root,
        &f.identity,
        &f.private,
        None,
        area,
        &WorkspacePath::from_bytes(name).unwrap(),
        cancel(),
    )
}

#[test]
fn disk_and_index_attributes_and_ignore_rules_are_read_without_mutation() {
    let f = Fixture::new();
    fs::write(f.root.join("text.txt"), "same\r\nsame\n").unwrap();
    fs::write(f.root.join(".gitattributes"), b"text.txt text eol=lf\n").unwrap();
    f.commit();
    // Different raw bytes with equal size require normalization without Git's
    // size-mismatch status shortcut; an old mtime forces a content comparison.
    fs::write(f.root.join("text.txt"), "same\nsame\r\n").unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(f.root.join("text.txt"))
        .unwrap()
        .set_modified(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1))
        .unwrap();
    fs::write(f.root.join(".gitignore"), b"ignored-by-worktree/\n").unwrap();
    fs::write(f.root.join(".git/info/exclude"), b"ignored-by-exclude/\n").unwrap();
    for name in ["ignored-by-worktree", "ignored-by-exclude"] {
        // Traversing either ignored directory would reject its non-file control.
        fs::create_dir_all(f.root.join(name).join(".gitignore")).unwrap();
        fs::write(f.root.join(name).join("hidden"), "hidden\n").unwrap();
    }
    let snapshot = ReadOnlySnapshot::capture(
        &f,
        &[
            "text.txt",
            ".gitattributes",
            ".gitignore",
            ".git/info/exclude",
        ],
    );
    let disk_status = status(&f.root, &f.identity, &f.private, None, cancel());
    let disk_diff = observe_diff(&f, GitArea::Worktree, b"text.txt");
    snapshot.assert_unchanged(&f);
    assert_eq!(
        git_stdout(&f.root, &["status", "--porcelain=v1"]),
        b"?? .gitignore\n"
    );
    fs::remove_file(f.root.join(".gitattributes")).unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(f.root.join("text.txt"))
        .unwrap()
        .set_modified(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(2))
        .unwrap();
    let snapshot = ReadOnlySnapshot::capture(&f, &["text.txt", ".gitignore", ".git/info/exclude"]);
    let indexed_status = status(&f.root, &f.identity, &f.private, None, cancel());
    let indexed_diff = observe_diff(&f, GitArea::Worktree, b"text.txt");
    snapshot.assert_unchanged(&f);
    assert_eq!(
        git_stdout(&f.root, &["status", "--porcelain=v1"]),
        b" D .gitattributes\n?? .gitignore\n"
    );
    assert_eq!(
        entries(disk_status.unwrap().unwrap()),
        vec![(
            GitArea::Untracked,
            b".gitignore".to_vec(),
            GitChangeKind::Added
        )]
    );
    assert_eq!(disk_diff.unwrap().unwrap(), GitDiff::Unchanged);
    assert_eq!(
        entries(indexed_status.unwrap().unwrap()),
        vec![
            (
                GitArea::Worktree,
                b".gitattributes".to_vec(),
                GitChangeKind::Deleted
            ),
            (
                GitArea::Untracked,
                b".gitignore".to_vec(),
                GitChangeKind::Added
            ),
        ]
    );
    assert_eq!(indexed_diff.unwrap().unwrap(), GitDiff::Unchanged);
}
