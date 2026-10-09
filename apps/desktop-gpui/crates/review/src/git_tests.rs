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

//! The Git read: the commands it runs and its caps against a fake runner,
//! and a real repository the test makes under `target/tmp`.

// Test setup writes files and runs `git` to build its own repository.
#![allow(clippy::disallowed_methods)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use futures_lite::FutureExt as _;
use futures_lite::future::Boxed;

use crate::git::{
    COMMITS_PAGE, FailureReason, FilePatch, FileStatus, GitError, GitOutput, GitRunner, ReviewRead,
    ReviewScope, ReviewSnapshot, SystemGit, chunk_path, git_arguments, parse_numstat, read_capped,
    read_patches, read_review, read_whole_file,
};

/// Answers scripted commands and records every command asked for. A patch
/// command not scripted is answered with the patches set for its paths
/// ([`FakeGit::patches`]), so a test need not know how the paths batch.
#[derive(Default)]
pub(crate) struct FakeGit {
    answers: Mutex<HashMap<String, Result<GitOutput, GitError>>>,
    patches: Mutex<HashMap<String, String>>,
    commands: Mutex<Vec<String>>,
}

impl FakeGit {
    pub(crate) fn answer(&self, command: &str, stdout: &str) -> &Self {
        self.reply(command, Ok(GitOutput::new(stdout)))
    }

    pub(crate) fn fail(&self, command: &str, stderr: &str) -> &Self {
        self.reply(command, Err(GitError::Failed(stderr.to_owned())))
    }

    pub(crate) fn reply(&self, command: &str, reply: Result<GitOutput, GitError>) -> &Self {
        self.answers.lock().expect("answers").insert(command.to_owned(), reply);
        self
    }

    /// The patch of each `(path, patch)`, for any patch command naming the
    /// path.
    pub(crate) fn patches<'a>(&self, patches: impl IntoIterator<Item = (&'a str, &'a str)>) {
        let mut known = self.patches.lock().expect("patches");
        for (path, patch) in patches {
            known.insert(path.to_owned(), patch.to_owned());
        }
    }

    pub(crate) fn commands(&self) -> Vec<String> {
        self.commands.lock().expect("commands").clone()
    }

    /// The patch commands asked for.
    pub(crate) fn patch_commands(&self) -> Vec<String> {
        self.commands().into_iter().filter(|command| command.starts_with(PATCH)).collect()
    }
}

impl GitRunner for FakeGit {
    fn run(&self, _: &Path, args: &[String]) -> Boxed<Result<GitOutput, GitError>> {
        let command = args.join(" ");
        self.commands.lock().expect("commands").push(command.clone());
        let scripted = self.answers.lock().expect("answers").get(&command).cloned();
        let answer = scripted.unwrap_or_else(|| {
            let paths = command.strip_prefix(PATCH).and_then(|rest| rest.split_once(" -- "));
            let Some((_, paths)) = paths else {
                return Err(GitError::Failed(format!("unexpected: {command}")));
            };
            let known = self.patches.lock().expect("patches");
            let patches: String =
                paths.split(' ').filter_map(|path| known.get(path)).map(String::as_str).collect();
            Ok(GitOutput::new(patches))
        });
        async move { answer }.boxed()
    }
}

/// A fresh folder for test `name` under the workspace's `target/tmp`.
pub(crate) fn scratch(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/tmp")
        .join(format!("review-{name}-{}", std::process::id()));
    std::fs::remove_dir_all(&dir).ok();
    std::fs::create_dir_all(&dir).expect("scratch folder");
    dir
}

/// A folder that looks like a repository's root to the read (a `.git`
/// folder), for a fake runner.
pub(crate) fn fake_repository(name: &str) -> PathBuf {
    let dir = scratch(name);
    std::fs::create_dir_all(dir.join(".git")).expect(".git");
    dir
}

/// The branch answers of a repository on `feature` with an `origin`.
pub(crate) fn branch_answers(git: &FakeGit) {
    git.answer("branch --show-current", "feature\n")
        .answer("rev-parse --verify --quiet HEAD", "c0ffee\n")
        .answer(
            "for-each-ref --format=%(refname) refs/heads refs/remotes",
            "refs/heads/feature\nrefs/heads/main\nrefs/remotes/origin/HEAD\n\
             refs/remotes/origin/main\nrefs/remotes/upstream/HEAD\n",
        )
        .answer("symbolic-ref --quiet refs/remotes/origin/HEAD", "refs/remotes/origin/main\n")
        .answer("rev-parse --verify --quiet refs/remotes/origin/main", "c0ffee\n")
        .answer("merge-base refs/remotes/origin/main HEAD", "base\n")
        .answer(LOG, "");
}

pub(crate) const LOG: &str =
    "log -z --max-count=50000 --skip=0 --format=%H%x1f%h%x1f%an%x1f%at%x1f%s base..HEAD";

pub(crate) const NAME_STATUS: &str = "diff --name-status -z --find-renames base";
pub(crate) const NUMSTAT: &str = "diff --numstat -z --find-renames base";
pub(crate) const UNTRACKED: &str = "ls-files -z --others --exclude-standard";
/// A patch command up to its comparison, for files not renamed.
pub(crate) const PATCH: &str = "diff --no-ext-diff --no-color --no-renames --full-index \
     --src-prefix=a/ --dst-prefix=b/ --unified=20";

/// The patch command of `paths` against `base`.
pub(crate) fn patch_command(paths: &[&str]) -> String {
    format!("{PATCH} base -- {}", paths.join(" "))
}

/// A modified file's name status and diff.
pub(crate) fn modified(path: &str) -> (String, String) {
    (
        format!("M\0{path}\0"),
        format!("diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -1 +1 @@\n-a\n+b\n"),
    )
}

/// The `--numstat -z` record of the file `path` whose patch is `diff`.
pub(crate) fn numstat(path: &str, diff: &str) -> String {
    let (added, deleted) = shared::diff::line_counts(diff);
    format!("{added}\t{deleted}\t{path}\0")
}

/// Answers the listing of `files` (each a name status entry and its
/// patch) against `base`, and their patches.
pub(crate) fn listed(git: &FakeGit, files: &[(String, String)]) {
    let path = |entry: &str| entry.trim_end_matches('\0').rsplit('\0').next().map(str::to_owned);
    let names: String = files.iter().map(|(name, _)| name.as_str()).collect();
    let mut counts = String::new();
    let mut patches = Vec::new();
    for (name, diff) in files {
        let path = path(name).expect("a path");
        counts.push_str(&numstat(&path, diff));
        patches.push((path, diff.clone()));
    }
    git.answer(NAME_STATUS, &names).answer(NUMSTAT, &counts).answer(UNTRACKED, "");
    git.patches(patches.iter().map(|(path, diff)| (path.as_str(), diff.as_str())));
}

fn read(cwd: &Path, base: Option<&str>, git: Arc<dyn GitRunner>) -> ReviewRead {
    read_scope(cwd, base, &ReviewScope::All, git)
}

fn read_scope(
    cwd: &Path,
    base: Option<&str>,
    scope: &ReviewScope,
    git: Arc<dyn GitRunner>,
) -> ReviewRead {
    async_io::block_on(read_review(cwd, base, scope, git))
}

/// Every patch of `snapshot`, by path, read as the panel reads them.
pub(crate) fn patches_of(
    snapshot: &ReviewSnapshot,
    git: Arc<dyn GitRunner>,
) -> HashMap<String, FilePatch> {
    let mut patches = HashMap::new();
    for batch in snapshot.patch_batches() {
        let read = async_io::block_on(read_patches(batch, git.clone())).expect("patches");
        patches.extend(read);
    }
    patches
}

/// The text of a patch read whole.
fn text(patch: Option<&FilePatch>) -> &str {
    match patch {
        Some(FilePatch::Text(text)) => text,
        other => panic!("not a patch's text: {other:?}"),
    }
}

#[test]
fn every_command_runs_in_the_root_without_optional_locks() {
    let args = git_arguments(Path::new("/w"), &["diff".to_owned(), "--cached".to_owned()]);
    assert_eq!(args, ["-C", "/w", "--no-optional-locks", "diff", "--cached"]);
}

/// A listing of 450 files runs Desktop's commands with `--numstat` beside
/// `--name-status`, keeps every file with Git's counts and reads no patch;
/// the patches then come in batches of at most 256 files, each file's its
/// own.
#[test]
fn a_listing_keeps_every_file_with_gits_counts_and_reads_no_patch() {
    let root = fake_repository("commands");
    let git = Arc::new(FakeGit::default());
    branch_answers(&git);
    let files: Vec<(String, String)> = (0..450).map(|ix| modified(&format!("f{ix:03}"))).collect();
    listed(&git, &files);
    let snapshot = read(&root, None, git.clone()).expect("a snapshot");
    assert_eq!(
        git.commands(),
        [
            "branch --show-current",
            "rev-parse --verify --quiet HEAD",
            "for-each-ref --format=%(refname) refs/heads refs/remotes",
            "symbolic-ref --quiet refs/remotes/origin/HEAD",
            "rev-parse --verify --quiet refs/remotes/origin/main",
            "merge-base refs/remotes/origin/main HEAD",
            LOG,
            NAME_STATUS,
            NUMSTAT,
            UNTRACKED,
        ]
    );
    assert_eq!(snapshot.files.len(), 450, "every file");
    assert_eq!((snapshot.additions, snapshot.deletions), (450, 450));
    assert_eq!(snapshot.base_branch.as_deref(), Some("refs/remotes/origin/main"));
    assert_eq!(snapshot.branches.current_branch.as_deref(), Some("feature"));
    let options: Vec<&str> =
        snapshot.branches.base_branch_options.iter().map(|option| option.label.as_str()).collect();
    assert_eq!(
        options,
        ["origin/HEAD", "origin/main", "main", "feature"],
        "the likely bases first; a remote's HEAD only for origin"
    );

    let batches = snapshot.patch_batches();
    let sizes: Vec<usize> = batches.iter().map(|batch| batch.len()).collect();
    assert_eq!(sizes, [256, 194], "at most 256 files a batch");
    let patches = patches_of(&snapshot, git.clone());
    assert_eq!(patches.len(), 450);
    assert_eq!(text(patches.get("f449")), modified("f449").1, "each file its own patch");
    let commands = git.patch_commands();
    assert_eq!(commands.len(), 2);
    let first: Vec<String> = (0..256).map(|ix| format!("f{ix:03}")).collect();
    let first: Vec<&str> = first.iter().map(String::as_str).collect();
    assert_eq!(commands[0], patch_command(&first), "no --binary, the paths after --");
    std::fs::remove_dir_all(&root).ok();
}

/// A batch whose output passes the cap is read again in halves, down to
/// the one file whose patch alone passes it, which is too large; a file
/// whose counts alone pass a batch's lines is a batch of its own.
#[test]
fn a_batch_past_the_cap_is_read_in_halves_down_to_one_file() {
    let root = fake_repository("halves");
    let git = Arc::new(FakeGit::default());
    branch_answers(&git);
    let files: Vec<(String, String)> = ["a", "big", "c"].into_iter().map(modified).collect();
    listed(&git, &files);
    let cut = || Ok(GitOutput::truncated(modified("big").1));
    git.reply(&patch_command(&["a", "big", "c"]), cut())
        .reply(&patch_command(&["big", "c"]), cut())
        .reply(&patch_command(&["big"]), cut());
    let snapshot = read(&root, None, git.clone()).expect("a snapshot");
    let patches = patches_of(&snapshot, git.clone());
    assert_eq!(patches.get("big"), Some(&FilePatch::TooLarge));
    assert_eq!(text(patches.get("a")), modified("a").1);
    assert_eq!(text(patches.get("c")), modified("c").1);
    assert_eq!(
        git.patch_commands(),
        [
            patch_command(&["a", "big", "c"]),
            patch_command(&["a"]),
            patch_command(&["big", "c"]),
            patch_command(&["big"]),
            patch_command(&["c"]),
        ]
    );
    let big = snapshot.files.iter().find(|file| file.path == "big").expect("big");
    assert_eq!((big.additions, big.deletions), (1, 1), "its counts stand");

    let git = Arc::new(FakeGit::default());
    branch_answers(&git);
    listed(&git, &files);
    git.answer(NUMSTAT, "1\t1\ta\x0050000\t0\tbig\x001\t1\tc\x00");
    let snapshot = read(&root, None, git.clone()).expect("a snapshot");
    let sizes: Vec<usize> = snapshot.patch_batches().iter().map(|batch| batch.len()).collect();
    assert_eq!(sizes, [1, 1, 1], "50,000 changed lines: a batch of its own");
    std::fs::remove_dir_all(&root).ok();
}

/// Every commit since the merge base is listed, not the first 200, a page
/// of 50,000 a command.
#[test]
fn every_commit_since_the_merge_base_is_listed() {
    let root = fake_repository("commits");
    let git = Arc::new(FakeGit::default());
    branch_answers(&git);
    listed(&git, &[]);
    let log = |commits: std::ops::Range<usize>| -> String {
        commits
            .map(|n| format!("{n:040x}\u{1f}{n:07x}\u{1f}Ann\u{1f}1700000000\u{1f}Commit {n}\0"))
            .collect()
    };
    git.answer(LOG, &log(0..250));
    let snapshot = read(&root, None, git).expect("a snapshot");
    assert_eq!(snapshot.commits.len(), 250);
    assert_eq!(snapshot.commits[249].subject, "Commit 249");

    let git = Arc::new(FakeGit::default());
    branch_answers(&git);
    listed(&git, &[]);
    let second = LOG.replace("--skip=0", &format!("--skip={COMMITS_PAGE}"));
    git.answer(LOG, &log(0..COMMITS_PAGE)).answer(&second, &log(COMMITS_PAGE..COMMITS_PAGE + 7));
    let snapshot = read(&root, None, git.clone()).expect("a snapshot");
    assert_eq!(snapshot.commits.len(), COMMITS_PAGE + 7, "the next page");
    let logs = git.commands().iter().filter(|command| command.starts_with("log ")).count();
    assert_eq!(logs, 2);
    std::fs::remove_dir_all(&root).ok();
}

/// `--numstat -z` records, a rename's and a binary file's among them, and
/// the path each patch chunk is for, quoted or not.
#[test]
fn counts_and_chunks_are_read_by_path() {
    let counts =
        parse_numstat("3\t1\ta.txt\x00-\t-\tlogo.png\x002\t0\t\x00old name.rs\x00new name.rs\x00");
    assert_eq!(counts.get("a.txt"), Some(&Some((3, 1))));
    assert_eq!(counts.get("logo.png"), Some(&None), "binary: no counts");
    assert_eq!(counts.get("new name.rs"), Some(&Some((2, 0))), "a rename by its new path");

    let chunk = |header: &str| chunk_path(&format!("{header}\n--- a/x\n"));
    assert_eq!(chunk("diff --git a/x b/x").as_deref(), Some("x"));
    assert_eq!(chunk("diff --git a/a b/c b/a b/c").as_deref(), Some("a b/c"));
    assert_eq!(
        chunk("diff --git \"a/\\303\\274.txt\" \"b/\\303\\274.txt\"").as_deref(),
        Some("\u{fc}.txt"),
        "octal bytes"
    );
    assert_eq!(chunk("diff --git \"a/q\\\"d\" \"b/q\\\"d\"").as_deref(), Some("q\"d"));
    let renamed = "diff --git a/old b/new\nsimilarity index 90%\nrename from old\nrename to new\n";
    assert_eq!(chunk_path(renamed).as_deref(), Some("new"));
}
/// A base branch that no longer exists fails the read, with the branches,
/// so the panel can drop it.
#[test]
fn a_gone_base_branch_is_invalid() {
    let root = fake_repository("invalid-base");
    let git = Arc::new(FakeGit::default());
    branch_answers(&git);
    let failure = read(&root, Some("refs/heads/gone"), git).expect_err("invalid");
    assert_eq!(failure.reason, FailureReason::InvalidBaseBranch);
    assert_eq!(failure.branches.expect("branches").base_branch_options.len(), 4);
    std::fs::remove_dir_all(&root).ok();
}

/// A failed command is Desktop's `git_failed`, or `unborn_repository` when
/// Git says there is no commit; `git` missing is a failure too.
#[test]
fn failures_read_as_desktop_reads_them() {
    let root = fake_repository("failures");
    let git = Arc::new(FakeGit::default());
    branch_answers(&git);
    git.fail("merge-base refs/remotes/origin/main HEAD", "fatal: no merge base");
    let failure = read(&root, None, git).expect_err("failed");
    assert_eq!(failure.reason, FailureReason::GitFailed);
    assert!(failure.branches.is_some(), "the picker stays usable");

    let git = Arc::new(FakeGit::default());
    branch_answers(&git);
    git.fail(
        "merge-base refs/remotes/origin/main HEAD",
        "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.",
    );
    let failure = read(&root, None, git).expect_err("unborn");
    assert_eq!(failure.reason, FailureReason::UnbornRepository);

    let missing = Arc::new(FakeGit::default());
    missing.reply("branch --show-current", Err(GitError::Missing));
    let failure = read(&root, None, missing).expect_err("no git");
    assert_eq!(failure.reason, FailureReason::GitFailed);
    std::fs::remove_dir_all(&root).ok();
}

/// A folder in no repository, and one that is gone, run no Git at all.
#[test]
fn a_folder_outside_a_repository_is_not_one() {
    // The system's temporary folder: this checkout is a repository, so any
    // folder under its `target` is inside one.
    let outside = std::env::temp_dir().join(format!("review-outside-{}", std::process::id()));
    std::fs::create_dir_all(&outside).expect("folder");
    let git = Arc::new(FakeGit::default());
    let failure = read(&outside, None, git.clone()).expect_err("not a repository");
    assert_eq!(failure.reason, FailureReason::NotGitRepository);
    std::fs::remove_dir_all(&outside).ok();
    let failure = read(&outside, None, git.clone()).expect_err("gone");
    assert_eq!(failure.reason, FailureReason::WorkspaceUnavailable);
    assert!(git.commands().is_empty());
}

/// Runs `git` in the test's own repository.
pub(crate) fn run(dir: &Path, args: &[&str]) {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.name=Review Test", "-c", "user.email=review@example.invalid"])
        .args(["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"])
        .args(args)
        .env("LC_ALL", "C")
        .output()
        .expect("git");
    assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
}

/// A real repository with a modified, a deleted and an untracked file
/// gives three entries with their statuses and counts, and the read leaves
/// the repository's index as it was.
#[test]
fn a_repository_lists_modified_deleted_and_untracked_files() {
    let repo = scratch("repository");
    run(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("kept.txt"), "one\ntwo\n").expect("write");
    std::fs::write(repo.join("gone.txt"), "bye\n").expect("write");
    run(&repo, &["add", "."]);
    run(&repo, &["commit", "-q", "-m", "start"]);
    std::fs::write(repo.join("kept.txt"), "one\n2\n").expect("write");
    std::fs::remove_file(repo.join("gone.txt")).expect("remove");
    std::fs::write(repo.join("new.txt"), "hello\nworld\n").expect("write");
    let index = repo.join(".git/index");
    let stamp = |index: &Path| {
        let modified = std::fs::metadata(index).and_then(|meta| meta.modified()).ok();
        (std::fs::read(index).expect("index"), modified)
    };
    let before = stamp(&index);

    let git: Arc<dyn GitRunner> = Arc::new(SystemGit);
    let snapshot = read(&repo, None, git.clone()).expect("a snapshot");
    let files: Vec<(&str, FileStatus, u32, u32)> = snapshot
        .files
        .iter()
        .map(|file| (file.path.as_str(), file.status, file.additions, file.deletions))
        .collect();
    assert_eq!(
        files,
        [
            ("gone.txt", FileStatus::Deleted, 0, 1),
            ("kept.txt", FileStatus::Modified, 1, 1),
            ("new.txt", FileStatus::Untracked, 2, 0),
        ]
    );
    assert_eq!(snapshot.base_branch.as_deref(), Some("refs/heads/main"));
    assert_eq!(snapshot.branches.current_branch.as_deref(), Some("main"));
    assert_eq!((snapshot.additions, snapshot.deletions), (3, 2));
    let patches = patches_of(&snapshot, git);
    assert!(text(patches.get("gone.txt")).contains("deleted file mode"));
    assert!(text(patches.get("new.txt")).contains("+world\n"));
    assert!(stamp(&index) == before, "the index is untouched");
    std::fs::remove_dir_all(&repo).ok();
}

/// A change carries twenty unchanged lines on each side, for the panel's
/// Diff to fold and unfold, not Git's three.
#[test]
fn a_diff_carries_twenty_lines_of_context() {
    let repo = scratch("context");
    run(&repo, &["init", "-q", "-b", "main"]);
    let lines: Vec<String> = (1..=40).map(|n| format!("line {n}")).collect();
    std::fs::write(repo.join("long.txt"), lines.join("\n") + "\n").expect("write");
    run(&repo, &["add", "."]);
    run(&repo, &["commit", "-q", "-m", "start"]);
    let mut changed = lines.clone();
    changed[24] = "line twenty-five".to_owned();
    std::fs::write(repo.join("long.txt"), changed.join("\n") + "\n").expect("write");

    let git: Arc<dyn GitRunner> = Arc::new(SystemGit);
    let snapshot = read(&repo, None, git.clone()).expect("a snapshot");
    let patches = patches_of(&snapshot, git);
    let diff = text(patches.get("long.txt"));
    assert!(diff.contains("\n line 5\n"), "twenty lines above the change: {diff}");
    assert!(!diff.contains("\n line 4\n"), "and no more");
    assert!(diff.contains("\n line 40\n"), "to the end below it");
    std::fs::remove_dir_all(&repo).ok();
}

/// Each scope's comparison: uncommitted changes against `HEAD` and with
/// the untracked files; a listed commit against its first parent, without
/// them; a commit no longer listed reads as all changes.
#[test]
fn each_scope_runs_its_own_comparison() {
    let root = fake_repository("scope-commands");
    let sha = "1111111111111111111111111111111111111111";
    let tail = |git: &FakeGit| {
        let commands = git.commands();
        commands[commands.iter().position(|command| command == LOG).expect("log") + 1..].to_vec()
    };
    let git = Arc::new(FakeGit::default());
    branch_answers(&git);
    git.answer(LOG, &format!("{sha}\u{1f}1111111\u{1f}Ann\u{1f}1700000000\u{1f}Fix it\n"))
        .answer("diff --name-status -z --find-renames HEAD", "M\0a\0")
        .answer("diff --numstat -z --find-renames HEAD", "1\t1\ta\0")
        .answer(UNTRACKED, "");
    let snapshot = read_scope(&root, None, &ReviewScope::Uncommitted, git.clone()).expect("read");
    assert_eq!(snapshot.scope, ReviewScope::Uncommitted);
    assert_eq!(
        tail(&git),
        [
            "diff --name-status -z --find-renames HEAD",
            "diff --numstat -z --find-renames HEAD",
            UNTRACKED,
        ]
    );
    patches_of(&snapshot, git.clone());
    assert_eq!(git.patch_commands(), [format!("{PATCH} HEAD -- a")], "against HEAD");
    let commit = &snapshot.commits[0];
    assert_eq!(
        (commit.short_sha.as_str(), commit.author.as_str(), commit.subject.as_str()),
        ("1111111", "Ann", "Fix it")
    );
    assert_eq!(commit.timestamp_ms, 1_700_000_000_000);

    let git = Arc::new(FakeGit::default());
    branch_answers(&git);
    let parent = format!("{sha}^ {sha}");
    git.answer(LOG, &format!("{sha}\u{1f}1111111\u{1f}Ann\u{1f}1700000000\u{1f}Fix it"))
        .answer(&format!("diff --name-status -z --find-renames {parent}"), "M\0a\0")
        .answer(&format!("diff --numstat -z --find-renames {parent}"), "1\t1\ta\0");
    let scope = ReviewScope::Commit(sha.to_owned());
    let snapshot = read_scope(&root, None, &scope, git.clone()).expect("read");
    assert_eq!(snapshot.scope, scope);
    assert_eq!(tail(&git).len(), 2, "no untracked files in a commit: {:?}", tail(&git));

    let git = Arc::new(FakeGit::default());
    branch_answers(&git);
    listed(&git, &[]);
    let gone = ReviewScope::Commit("2222222222222222222222222222222222222222".to_owned());
    let snapshot = read_scope(&root, None, &gone, git.clone()).expect("read");
    assert_eq!(snapshot.scope, ReviewScope::All, "a commit not on the branch is all changes");
    assert_eq!(tail(&git), [NAME_STATUS, NUMSTAT, UNTRACKED]);
    std::fs::remove_dir_all(&root).ok();
}

/// The files and line counts of `snapshot`, by path.
fn counted(snapshot: &ReviewSnapshot) -> Vec<(&str, FileStatus, u32, u32)> {
    snapshot
        .files
        .iter()
        .map(|file| (file.path.as_str(), file.status, file.additions, file.deletions))
        .collect()
}

/// A real branch two commits past `main`, with an uncommitted edit and an
/// untracked file: all changes, the uncommitted ones, and each commit give
/// their own files and counts, the commits are listed newest first, and no
/// read touches the index.
#[test]
fn a_branch_reads_all_uncommitted_and_each_commit() {
    let repo = scratch("scopes");
    run(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("a.txt"), "one\n").expect("write");
    run(&repo, &["add", "."]);
    run(&repo, &["commit", "-q", "-m", "start"]);
    run(&repo, &["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.join("a.txt"), "one\ntwo\n").expect("write");
    run(&repo, &["commit", "-q", "-am", "Add a second line"]);
    std::fs::create_dir_all(repo.join("src/deep")).expect("folder");
    std::fs::write(repo.join("src/deep/b.txt"), "b\nb\n").expect("write");
    run(&repo, &["add", "."]);
    run(&repo, &["commit", "-q", "-m", "Add b\n\nWith a body."]);
    std::fs::write(repo.join("a.txt"), "one\ntwo\nthree\n").expect("write");
    std::fs::write(repo.join("new.txt"), "fresh\n").expect("write");
    let index = std::fs::read(repo.join(".git/index")).expect("index");
    let git: Arc<dyn GitRunner> = Arc::new(SystemGit);

    let all = read_scope(&repo, None, &ReviewScope::All, git.clone()).expect("all");
    assert_eq!(all.base_branch.as_deref(), Some("refs/heads/main"));
    assert_eq!(
        counted(&all),
        [
            ("a.txt", FileStatus::Modified, 2, 0),
            ("src/deep/b.txt", FileStatus::Added, 2, 0),
            ("new.txt", FileStatus::Untracked, 1, 0),
        ]
    );
    let subjects: Vec<&str> = all.commits.iter().map(|commit| commit.subject.as_str()).collect();
    assert_eq!(subjects, ["Add b", "Add a second line"], "newest first, first lines");
    assert_eq!(all.commits[0].author, "Review Test");
    assert_eq!(all.commits[0].short_sha.len(), 7);

    let uncommitted = read_scope(&repo, None, &ReviewScope::Uncommitted, git.clone()).expect("ok");
    assert_eq!(
        counted(&uncommitted),
        [("a.txt", FileStatus::Modified, 1, 0), ("new.txt", FileStatus::Untracked, 1, 0)]
    );

    let newest = ReviewScope::Commit(all.commits[0].sha.clone());
    let commit = read_scope(&repo, None, &newest, git.clone()).expect("newest");
    assert_eq!(counted(&commit), [("src/deep/b.txt", FileStatus::Added, 2, 0)]);
    let oldest = ReviewScope::Commit(all.commits[1].sha.clone());
    let commit = read_scope(&repo, None, &oldest, git.clone()).expect("oldest");
    assert_eq!(counted(&commit), [("a.txt", FileStatus::Modified, 1, 0)]);
    assert_eq!((commit.additions, commit.deletions), (1, 0));
    assert!(std::fs::read(repo.join(".git/index")).expect("index") == index, "index untouched");
    std::fs::remove_dir_all(&repo).ok();
}

/// "Show more lines": a file's diff again with its whole text around the
/// change, in the scope it was read in.
#[test]
fn a_file_reads_again_with_its_whole_text() {
    let repo = scratch("whole-file");
    run(&repo, &["init", "-q", "-b", "main"]);
    let lines: Vec<String> = (1..=60).map(|n| format!("line {n}")).collect();
    std::fs::write(repo.join("long.txt"), lines.join("\n") + "\n").expect("write");
    run(&repo, &["add", "."]);
    run(&repo, &["commit", "-q", "-m", "start"]);
    let mut changed = lines.clone();
    changed[29] = "line thirty".to_owned();
    std::fs::write(repo.join("long.txt"), changed.join("\n") + "\n").expect("write");
    let git: Arc<dyn GitRunner> = Arc::new(SystemGit);
    let snapshot = read_scope(&repo, None, &ReviewScope::Uncommitted, git.clone()).expect("read");
    let patches = patches_of(&snapshot, git.clone());
    assert!(!text(patches.get("long.txt")).contains("\n line 1\n"), "twenty lines of context");
    let whole = async_io::block_on(read_whole_file(
        &repo,
        &ReviewScope::Uncommitted,
        None,
        "long.txt",
        None,
        git,
    ))
    .expect("git")
    .expect("a diff");
    assert!(whole.contains("\n line 1\n") && whole.contains("\n line 60\n"), "{whole}");
    assert_eq!(shared::diff::line_counts(&whole), (1, 1));
    std::fs::remove_dir_all(&repo).ok();
}

/// A binary file is binary: Git gives it no counts, and its patch is Git's
/// note that it differs, never its bytes (the panel's Diff shows it as a
/// binary file).
#[test]
fn a_binary_file_is_binary_and_its_bytes_are_not_in_its_patch() {
    let repo = scratch("binary");
    run(&repo, &["init", "-q", "-b", "main"]);
    let bytes = |seed: u8| -> Vec<u8> { (0..4096u32).map(|n| (n as u8) ^ seed).collect() };
    std::fs::write(repo.join("logo.png"), bytes(0)).expect("write");
    run(&repo, &["add", "."]);
    run(&repo, &["commit", "-q", "-m", "start"]);
    std::fs::write(repo.join("logo.png"), bytes(7)).expect("write");
    std::fs::write(repo.join("fresh.bin"), [0u8, 1, 2, 3]).expect("write");
    let git: Arc<dyn GitRunner> = Arc::new(SystemGit);
    let snapshot = read(&repo, None, git.clone()).expect("a snapshot");
    let logo = snapshot.files.iter().find(|file| file.path == "logo.png").expect("logo");
    assert!(logo.binary && (logo.additions, logo.deletions) == (0, 0), "{logo:?}");
    let fresh = snapshot.files.iter().find(|file| file.path == "fresh.bin").expect("fresh");
    assert!(fresh.binary, "an untracked binary file too");
    let patches = patches_of(&snapshot, git);
    let patch = text(patches.get("logo.png"));
    assert!(patch.contains("Binary files a/logo.png and b/logo.png differ"), "{patch}");
    assert!(!patch.contains("GIT binary patch") && !patch.contains("literal "), "{patch}");
    assert!(patch.len() < 400, "a note, not the bytes: {} bytes", patch.len());
    assert!(text(patches.get("fresh.bin")).contains("Binary files /dev/null and b/fresh.bin"));
    std::fs::remove_dir_all(&repo).ok();
}

/// An untracked file past the per-file limit is listed by its size and not
/// read; its patch is too large, the other files' are read.
#[test]
fn an_untracked_file_past_the_limit_is_listed_by_its_size() {
    let repo = scratch("untracked-large");
    run(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("a.txt"), "a\n").expect("write");
    run(&repo, &["add", "."]);
    run(&repo, &["commit", "-q", "-m", "start"]);
    std::fs::write(repo.join("small.txt"), "one\ntwo").expect("write");
    // A sparse file: past the limit without writing it.
    let size = crate::git::FILE_MAX_PATCH_BYTES as u64 + 1;
    std::fs::File::create(repo.join("dump.log")).and_then(|file| file.set_len(size)).expect("dump");
    let git: Arc<dyn GitRunner> = Arc::new(SystemGit);
    let snapshot = read(&repo, None, git.clone()).expect("a snapshot");
    let dump = snapshot.files.iter().find(|file| file.path == "dump.log").expect("listed");
    assert_eq!(dump.unread_size, Some(size));
    assert_eq!((dump.additions, dump.deletions), (0, 0));
    let small = snapshot.files.iter().find(|file| file.path == "small.txt").expect("listed");
    assert_eq!((small.additions, small.unread_size), (2, None), "a last line without its end");
    let patches = patches_of(&snapshot, git);
    assert_eq!(patches.get("dump.log"), Some(&FilePatch::TooLarge));
    assert!(text(patches.get("small.txt")).ends_with("+two\n\\ No newline at end of file\n"));
    std::fs::remove_dir_all(&repo).ok();
}

/// Paths Git quotes or that look like patterns, and a rename, each read
/// with its own patch: pathspecs are literal, quoted headers unquoted.
#[test]
fn unusual_paths_and_a_rename_read_their_own_patches() {
    let repo = scratch("paths");
    run(&repo, &["init", "-q", "-b", "main"]);
    let names = ["odd [1] *.txt", "quote\"d.txt", "\u{fc}ber.txt", "plain.txt", "*"];
    for name in names {
        std::fs::write(repo.join(name), format!("{name}\n")).expect("write");
    }
    let body: String = (1..=30).map(|n| format!("moved line {n}\n")).collect();
    std::fs::write(repo.join("old.rs"), &body).expect("write");
    run(&repo, &["add", "."]);
    run(&repo, &["commit", "-q", "-m", "start"]);
    for name in names {
        std::fs::write(repo.join(name), format!("{name}\nmore\n")).expect("write");
    }
    run(&repo, &["mv", "old.rs", "new.rs"]);
    std::fs::write(repo.join("new.rs"), format!("{body}one more\n")).expect("write");
    let git: Arc<dyn GitRunner> = Arc::new(SystemGit);
    let snapshot = read(&repo, None, git.clone()).expect("a snapshot");
    let renamed = snapshot.files.iter().find(|file| file.path == "new.rs").expect("renamed");
    assert_eq!(renamed.status, FileStatus::Renamed);
    assert_eq!((renamed.additions, renamed.deletions), (1, 0));
    let patches = patches_of(&snapshot, git);
    for name in names {
        let patch = text(patches.get(name));
        let own = patch.contains("+more\n") && patch.contains(&format!(" {name}\n"));
        assert!(own, "{name}: {patch}");
    }
    let patch = text(patches.get("new.rs"));
    assert!(patch.contains("rename from old.rs") && patch.contains("+one more\n"), "{patch}");
    std::fs::remove_dir_all(&repo).ok();
}

/// A pipe that runs dry before each kilobyte, as Git's does when the panel
/// reads it faster than Git writes.
struct Trickle {
    left: usize,
    ready: bool,
}

impl futures_lite::AsyncRead for Trickle {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut [u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        if self.left > 0 && !self.ready {
            self.ready = true;
            cx.waker().wake_by_ref();
            return std::task::Poll::Pending;
        }
        self.ready = false;
        let read = buf.len().min(1024).min(self.left);
        buf[..read].fill(b'x');
        self.left -= read;
        std::task::Poll::Ready(Ok(read))
    }
}

/// Output is read in time linear in its length however often the pipe
/// runs dry, and no further than past its cap.
#[test]
fn output_is_read_in_linear_time_up_to_its_cap() {
    let started = std::time::Instant::now();
    let read = async_io::block_on(read_capped(Trickle { left: 8 << 20, ready: false }, 32 << 20));
    assert_eq!(read.expect("read").len(), 8 << 20);
    assert!(started.elapsed() < std::time::Duration::from_secs(5), "{:?}", started.elapsed());
    let read = async_io::block_on(read_capped(Trickle { left: 1 << 20, ready: false }, 100_000));
    let read = read.expect("read").len();
    assert!(read > 100_000 && read < 110_000, "stops past the cap: {read}");
}
