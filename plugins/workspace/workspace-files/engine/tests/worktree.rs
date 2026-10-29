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

use maka_fs_tools::worktree::Worktrees;
use std::{
    fs,
    path::Path,
    process::Command,
    sync::{Arc, atomic::AtomicBool},
};

fn git(path: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(path)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .args(args)
        .output()
        .expect("Git is the integration-test oracle only");
    assert!(
        out.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}
fn repository(root: &Path, hash: &str) {
    fs::create_dir(root).unwrap();
    git(
        root,
        &["init", "--quiet", &format!("--object-format={hash}")],
    );
    git(root, &["config", "user.name", "Maka tests"]);
    git(root, &["config", "user.email", "tests@maka.invalid"]);
    fs::write(root.join("source.txt"), "first\nsecond\n").unwrap();
    fs::write(root.join("binary"), [0, 255, 13, 10]).unwrap();
    fs::write(root.join("deleted.txt"), "removed by child\n").unwrap();
    fs::write(root.join(".gitattributes"), "*.crlf text eol=crlf\n").unwrap();
    fs::write(root.join("lines.crlf"), "first\r\nsecond\r\n").unwrap();
    fs::write(root.join("executable"), "echo hello\n").unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "--quiet", "-m", "base"]);
}

#[test]
fn linked_worktree_is_git_compatible_and_reopening_preserves_child_changes() {
    for hash in ["sha1", "sha256"] {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("repository");
        repository(&source, hash);
        let root = temp.path().join("host");
        let manager = Worktrees::open(&root).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let binding = manager
            .plan(&source, &"1".repeat(64), cancel.clone())
            .unwrap();
        assert!(
            !binding.directory().exists(),
            "planning has no Git side effect"
        );
        manager.ensure(&binding, &cancel).unwrap();
        assert_eq!(
            git(binding.directory(), &["rev-parse", "HEAD"]).trim(),
            binding.base_commit()
        );
        assert!(git(binding.directory(), &["status", "--porcelain"]).is_empty());
        assert!(
            git(&source, &["worktree", "list", "--porcelain"])
                .contains(binding.directory().to_str().unwrap())
        );
        assert_eq!(
            fs::read(binding.directory().join("binary")).unwrap(),
            [0, 255, 13, 10]
        );
        git(binding.directory(), &["switch", "-c", "child-owned"]);
        fs::write(
            binding.directory().join("source.txt"),
            "committed child change\n",
        )
        .unwrap();
        git(binding.directory(), &["commit", "-am", "child"]);
        fs::write(
            binding.directory().join("source.txt"),
            "staged child change\n",
        )
        .unwrap();
        git(binding.directory(), &["add", "."]);
        fs::write(
            binding.directory().join("source.txt"),
            "unstaged child change\n",
        )
        .unwrap();
        fs::write(
            binding.directory().join("new.txt"),
            "untracked child file\n",
        )
        .unwrap();
        fs::write(binding.directory().join("binary"), [0, 1, 254, 13, 10, 9]).unwrap();
        fs::write(binding.directory().join("空 文件.txt"), "no final newline").unwrap();
        fs::write(binding.directory().join("empty"), "").unwrap();
        fs::remove_file(binding.directory().join("deleted.txt")).unwrap();
        fs::write(
            binding.directory().join("lines.crlf"),
            "changed\r\nsecond\r\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::{PermissionsExt, symlink};
            fs::set_permissions(
                binding.directory().join("executable"),
                fs::Permissions::from_mode(0o755),
            )
            .unwrap();
            symlink("source.txt", binding.directory().join("link")).unwrap();
        }
        let before = git(binding.directory(), &["status", "--porcelain"]);
        let index = git(binding.directory(), &["diff", "--cached"]);
        let saved = serde_json::to_vec(&binding).unwrap();
        let restored = serde_json::from_slice(&saved).unwrap();
        Worktrees::open(&root)
            .unwrap()
            .ensure(&restored, &cancel)
            .unwrap();
        assert_eq!(git(binding.directory(), &["status", "--porcelain"]), before);
        assert_eq!(git(binding.directory(), &["diff", "--cached"]), index);
        assert_eq!(
            git(binding.directory(), &["branch", "--show-current"]).trim(),
            "child-owned"
        );
        assert_eq!(
            fs::read_to_string(source.join("source.txt")).unwrap(),
            "first\nsecond\n"
        );
        assert!(git(&source, &["status", "--porcelain"]).is_empty());
        let patch = manager.capture_patch(&binding, cancel.clone()).unwrap();
        assert_eq!(
            git(binding.directory(), &["diff", "--cached"]),
            index,
            "export must not stage child edits"
        );
        let patch_path = temp.path().join("result.patch");
        fs::write(&patch_path, &patch).unwrap();
        git(
            &source,
            &["apply", "--index", "--binary", patch_path.to_str().unwrap()],
        );
        for file in [
            "source.txt",
            "binary",
            "new.txt",
            "空 文件.txt",
            "empty",
            "lines.crlf",
            "executable",
        ] {
            assert_eq!(
                fs::read(source.join(file)).unwrap(),
                fs::read(binding.directory().join(file)).unwrap(),
                "{file}"
            );
        }
        assert!(!source.join("deleted.txt").exists());
        #[cfg(unix)]
        {
            assert_eq!(
                fs::read_link(source.join("link")).unwrap(),
                Path::new("source.txt")
            );
            assert!(git(&source, &["ls-files", "--stage", "executable"]).starts_with("100755"));
        }
        git(
            &source,
            &[
                "apply",
                "--reverse",
                "--index",
                "--binary",
                patch_path.to_str().unwrap(),
            ],
        );
        assert!(
            git(&source, &["status", "--porcelain"]).is_empty(),
            "export is reversible against its base"
        );
        let child_commit = git(&source, &["rev-parse", "child-owned"]);
        manager.remove(&binding).unwrap();
        Worktrees::open(&root).unwrap().remove(&binding).unwrap();
        assert!(!binding.directory().exists());
        assert!(manager.ensure(&binding, &cancel).is_err());
        assert_eq!(git(&source, &["rev-parse", "child-owned"]), child_commit);
        assert!(
            !git(&source, &["worktree", "list", "--porcelain"])
                .contains(binding.directory().to_str().unwrap())
        );
        assert!(git(&source, &["for-each-ref", "refs/maka/", "refs/heads/maka/"]).is_empty());
        assert!(git(&source, &["status", "--porcelain"]).is_empty());
    }
}

#[test]
fn worktree_recovery_rejects_dirty_sources_foreign_owners_and_missing_published_files() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("repository");
    repository(&source, "sha1");
    let root = temp.path().join("host");
    let manager = Worktrees::open(&root).unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    fs::write(source.join("untracked"), "not part of HEAD").unwrap();
    assert!(
        manager
            .plan(&source, &"2".repeat(64), cancel.clone())
            .is_err()
    );
    fs::remove_file(source.join("untracked")).unwrap();
    let binding = manager
        .plan(&source, &"2".repeat(64), cancel.clone())
        .unwrap();
    let stopped = AtomicBool::new(true);
    assert_eq!(
        manager.ensure(&binding, &stopped).unwrap_err().kind(),
        std::io::ErrorKind::Interrupted
    );
    manager.ensure(&binding, &cancel).unwrap();
    let allocation = binding.directory().parent().unwrap();
    // Interrupted final publication: ready staging must be reused, not checked out again.
    fs::write(
        binding.directory().join("source.txt"),
        "ready bytes preserved",
    )
    .unwrap();
    fs::rename(binding.directory(), allocation.join("checkout")).unwrap();
    manager.ensure(&binding, &cancel).unwrap();
    assert_eq!(
        fs::read_to_string(binding.directory().join("source.txt")).unwrap(),
        "ready bytes preserved"
    );
    let owner = allocation.join("maka-owner.json");
    let bytes = fs::read(&owner).unwrap();
    fs::write(&owner, "{}").unwrap();
    assert!(manager.ensure(&binding, &cancel).is_err());
    assert!(manager.capture_patch(&binding, cancel.clone()).is_err());
    assert!(manager.remove(&binding).is_err());
    assert!(binding.directory().exists());
    fs::write(&owner, bytes).unwrap();
    fs::rename(binding.directory(), allocation.join("user-recovered")).unwrap();
    assert!(
        manager.ensure(&binding, &cancel).is_err(),
        "never reset a published but missing directory"
    );
    assert!(!binding.directory().exists());
    manager.remove(&binding).unwrap();
    assert_eq!(
        fs::read_to_string(allocation.join("user-recovered/source.txt")).unwrap(),
        "ready bytes preserved",
        "cleanup only removes its known checkout paths"
    );
}

#[test]
fn interrupted_removal_preserves_advanced_branches_and_cannot_resurrect() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("repository");
    repository(&source, "sha1");
    let root = temp.path().join("host");
    let manager = Worktrees::open(&root).unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let id = "3".repeat(64);
    let binding = manager.plan(&source, &id, cancel.clone()).unwrap();
    manager.ensure(&binding, &cancel).unwrap();
    fs::write(binding.directory().join("source.txt"), "committed\n").unwrap();
    git(binding.directory(), &["commit", "-am", "keep this commit"]);
    let branch = format!("refs/heads/maka/{id}");
    let commit = git(&source, &["rev-parse", &branch]);
    let allocation = binding.directory().parent().unwrap();
    let admin = source.join(".git/worktrees").join(format!("maka-{id}"));
    let owner = admin.join("maka-owner.json");
    let proof = fs::read(&owner).unwrap();
    fs::write(&owner, "{}").unwrap();
    assert!(manager.remove(&binding).is_err());
    assert!(!allocation.join("retired").exists());
    assert!(binding.directory().exists());
    fs::write(&owner, proof).unwrap();
    // Crash after fencing and partially removing the checkout/admin payload.
    fs::write(allocation.join("retired"), "retired\n").unwrap();
    fs::remove_file(binding.directory().join("source.txt")).unwrap();
    fs::remove_file(admin.join("index")).unwrap();
    assert!(manager.ensure(&binding, &cancel).is_err());
    manager.remove(&binding).unwrap();
    assert_eq!(git(&source, &["rev-parse", &branch]), commit);
    // Crash in the owner-unlink/rmdir gap leaves an empty admin directory.
    fs::create_dir(&admin).unwrap();
    Worktrees::open(&root).unwrap().remove(&binding).unwrap();
    assert!(!admin.exists());
    assert!(manager.ensure(&binding, &cancel).is_err());
    assert_eq!(git(&source, &["rev-parse", &branch]), commit);
    assert!(git(&source, &["status", "--porcelain"]).is_empty());
}

// Exercise complete exports through public allocation and an independent Git checkout.
struct CaptureFixture {
    temp: tempfile::TempDir,
    source: std::path::PathBuf,
    manager: Worktrees,
    binding: maka_fs_tools::worktree::Binding,
    cancel: Arc<AtomicBool>,
    original: std::collections::BTreeMap<std::path::PathBuf, Vec<u8>>,
}
impl CaptureFixture {
    fn new(prepare: impl FnOnce(&Path)) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("repository");
        repository(&source, "sha1");
        prepare(&source);
        assert!(git(&source, &["status", "--porcelain"]).is_empty());
        let original = capture_files(&source);
        let manager = Worktrees::open(&temp.path().join("host")).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let binding = manager
            .plan(&source, &"4".repeat(64), cancel.clone())
            .unwrap();
        manager.ensure(&binding, &cancel).unwrap();
        Self {
            temp,
            source,
            manager,
            binding,
            cancel,
            original,
        }
    }
    fn export_and_apply(&self) -> (Vec<u8>, std::path::PathBuf) {
        let source = CaptureState::read(&self.source);
        let child = CaptureState::read(self.binding.directory());
        let expected = capture_files(self.binding.directory());
        let patch = self
            .manager
            .capture_patch(&self.binding, self.cancel.clone())
            .unwrap();
        source.assert_unchanged(&self.source);
        child.assert_unchanged(self.binding.directory());
        assert_capture_files(&self.source, &self.original);
        assert_capture_files(self.binding.directory(), &expected);
        let oracle = self.temp.path().join("oracle");
        git(
            self.temp.path(),
            &[
                "clone",
                "--quiet",
                "--local",
                self.source.to_str().unwrap(),
                oracle.to_str().unwrap(),
            ],
        );
        let patch_path = self.temp.path().join("result.patch");
        fs::write(&patch_path, &patch).unwrap();
        git(
            &oracle,
            &["apply", "--index", "--binary", patch_path.to_str().unwrap()],
        );
        assert_capture_files(&oracle, &expected);
        source.assert_unchanged(&self.source);
        (patch, oracle)
    }
}
struct CaptureState {
    index: Vec<u8>,
    index_modified: std::time::SystemTime,
    head: String,
}
impl CaptureState {
    fn read(root: &Path) -> Self {
        let index = root.join(git(root, &["rev-parse", "--git-path", "index"]).trim());
        Self {
            index: fs::read(&index).unwrap(),
            index_modified: fs::metadata(index).unwrap().modified().unwrap(),
            head: git(root, &["rev-parse", "HEAD"]),
        }
    }
    fn assert_unchanged(&self, root: &Path) {
        let current = Self::read(root);
        assert!(
            current.index == self.index,
            "capture changed the real index bytes"
        );
        assert_eq!(current.index_modified, self.index_modified);
        assert_eq!(current.head, self.head);
    }
}
fn capture_files(root: &Path) -> std::collections::BTreeMap<std::path::PathBuf, Vec<u8>> {
    fn visit(
        root: &Path,
        relative: &Path,
        files: &mut std::collections::BTreeMap<std::path::PathBuf, Vec<u8>>,
    ) {
        for entry in fs::read_dir(root.join(relative)).unwrap() {
            let entry = entry.unwrap();
            if relative.as_os_str().is_empty() && entry.file_name() == ".git" {
                continue;
            }
            let path = relative.join(entry.file_name());
            let kind = entry.file_type().unwrap();
            if kind.is_dir() {
                visit(root, &path, files);
            } else {
                assert!(
                    kind.is_file(),
                    "unexpected fixture file kind: {}",
                    path.display()
                );
                files.insert(path.clone(), fs::read(root.join(path)).unwrap());
            }
        }
    }
    let mut files = std::collections::BTreeMap::new();
    visit(root, Path::new(""), &mut files);
    files
}
fn assert_capture_files(
    root: &Path,
    expected: &std::collections::BTreeMap<std::path::PathBuf, Vec<u8>>,
) {
    let actual = capture_files(root);
    assert!(
        actual.keys().eq(expected.keys()),
        "export omitted or invented a file path"
    );
    for (path, bytes) in expected {
        assert!(
            actual.get(path) == Some(bytes),
            "export bytes differ: {}",
            path.display()
        );
    }
}
fn git_input(root: &Path, args: &[&str], input: &[u8]) -> Vec<u8> {
    use std::{io::Write, process::Stdio};
    let mut child = Command::new("git")
        .current_dir(root)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}
fn commit_capture_fixture(root: &Path) {
    git(root, &["add", "."]);
    git(root, &["commit", "--quiet", "-m", "capture fixture"]);
}

#[test]
fn capture_builtin_encoding_roundtrips_the_complete_canonical_blob() {
    let f = CaptureFixture::new(|root| {
        fs::write(
            root.join(".gitattributes"),
            "*.crlf text eol=crlf\nencoded.txt -text working-tree-encoding=UTF-16LE\n",
        )
        .unwrap();
        let original: Vec<_> = "original\0\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        fs::write(root.join("encoded.txt"), original).unwrap();
        commit_capture_fixture(root);
    });
    let canonical = "更新された設定\0\n末尾\n";
    let expected: Vec<_> = canonical
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    fs::write(f.binding.directory().join("encoded.txt"), &expected).unwrap();
    let (_, oracle) = f.export_and_apply();
    assert!(fs::read(oracle.join("encoded.txt")).unwrap() == expected);
    assert!(git_input(&oracle, &["show", ":encoded.txt"], b"") == canonical.as_bytes());
}

#[test]
fn capture_combines_base_and_actual_worktree_state_without_exporting_absent_index_entries() {
    let f = CaptureFixture::new(|root| {
        fs::write(root.join("removed.txt"), "removed from child\n").unwrap();
        commit_capture_fixture(root);
    });
    fs::remove_file(f.binding.directory().join("removed.txt")).unwrap();
    git(f.binding.directory(), &["add", "-u"]);
    let empty = String::from_utf8(git_input(
        f.binding.directory(),
        &["hash-object", "-w", "--stdin"],
        b"",
    ))
    .unwrap();
    git_input(
        f.binding.directory(),
        &["update-index", "--add", "--index-info"],
        format!(
            "100644 {}\tabsent-one\n100644 {}\tabsent-two\n",
            empty.trim(),
            empty.trim()
        )
        .as_bytes(),
    );
    fs::write(
        f.binding.directory().join("source.txt"),
        "selected child change\n",
    )
    .unwrap();
    let (_, oracle) = f.export_and_apply();
    for absent in ["removed.txt", "absent-one", "absent-two"] {
        assert!(!oracle.join(absent).exists());
    }
    assert_eq!(
        fs::read(oracle.join("source.txt")).unwrap(),
        b"selected child change\n"
    );
}

#[test]
fn capture_cancellation_and_external_filters_preserve_results_and_ownership() {
    let f = CaptureFixture::new(|_| {});
    fs::write(
        f.binding.directory().join("source.txt"),
        "selected child change\n",
    )
    .unwrap();
    let source = CaptureState::read(&f.source);
    let child = CaptureState::read(f.binding.directory());
    let expected = capture_files(f.binding.directory());
    assert!(
        f.manager
            .capture_patch(&f.binding, Arc::new(AtomicBool::new(true)))
            .is_err()
    );
    source.assert_unchanged(&f.source);
    child.assert_unchanged(f.binding.directory());
    assert_capture_files(f.binding.directory(), &expected);
    let config = f.source.join(".git/config");
    let original = fs::read(&config).unwrap();
    let marker = f.temp.path().join("external-filter-ran");
    git(
        &f.source,
        &[
            "config",
            "filter.unowned.clean",
            &format!("touch {}", marker.display()),
        ],
    );
    fs::write(
        f.binding.directory().join(".gitattributes"),
        "source.txt filter=unowned\n",
    )
    .unwrap();
    let error = f
        .manager
        .capture_patch(&f.binding, f.cancel.clone())
        .unwrap_err();
    assert!(error.to_string().contains("external filters"));
    assert!(!marker.exists());
    fs::write(config, original).unwrap();
    fs::write(
        f.binding.directory().join(".gitattributes"),
        expected.get(Path::new(".gitattributes")).unwrap(),
    )
    .unwrap();
    source.assert_unchanged(&f.source);
    child.assert_unchanged(f.binding.directory());
    assert_capture_files(f.binding.directory(), &expected);
    f.export_and_apply();
}

#[test]
fn capture_rejects_malformed_owner_suffix_and_recovers_after_restoration() {
    let f = CaptureFixture::new(|_| {});
    fs::write(
        f.binding.directory().join("source.txt"),
        "selected child change\n",
    )
    .unwrap();
    let source = CaptureState::read(&f.source);
    let child = CaptureState::read(f.binding.directory());
    let expected = capture_files(f.binding.directory());
    let owner = f
        .binding
        .directory()
        .parent()
        .unwrap()
        .join("maka-owner.json");
    let proof = fs::read(&owner).unwrap();
    let mut malformed = proof.clone();
    malformed.extend_from_slice(b"\n{}");
    fs::write(&owner, malformed).unwrap();
    assert!(
        f.manager.inspect(&f.binding).is_err(),
        "a second JSON value after whitespace is not an owner record"
    );
    assert!(
        f.manager
            .capture_patch(&f.binding, f.cancel.clone())
            .is_err()
    );
    source.assert_unchanged(&f.source);
    child.assert_unchanged(f.binding.directory());
    assert_capture_files(f.binding.directory(), &expected);
    fs::write(owner, proof).unwrap();
    Worktrees::open(&f.temp.path().join("host"))
        .unwrap()
        .inspect(&f.binding)
        .unwrap();
    f.export_and_apply();
}
