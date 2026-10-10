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

//! The task's Git changes, read on this machine as Maka Desktop reads them:
//! `readGitReview` with source `branch` in
//! `apps/desktop/src/main/git-review-main.ts`, behind the `git-review:read`
//! IPC of `runtime-host-workspace-ipc-main.ts`. Types mirror
//! `packages/core/src/git-review.ts`. Unlike Desktop, a read has no
//! review-wide cap: it lists every file of its scope and every commit.
//!
//! A read shows one [`ReviewScope`] of the branch, and lists every commit
//! of the branch since its merge base with the base branch (`git log -z
//! <merge-base>..HEAD`, newest first, 50,000 a command):
//!
//! - all changes: `git diff <merge-base>` (the working tree against the
//!   merge base; against `HEAD` without a base branch), untracked files
//!   included;
//! - uncommitted changes: `git diff HEAD`, untracked files included;
//! - one of those commits: `git diff <commit>^ <commit>`, its own changes
//!   against its first parent.
//!
//! A read comes in two steps. [`read_review`] lists the scope's files with
//! their exact line counts from Git (`diff --name-status -z
//! --find-renames` beside `diff --numstat -z --find-renames`, binary files
//! as binary with no counts) and its untracked files (`ls-files -z --others
//! --exclude-standard`, each read from the disk to count its lines). It
//! reads no patch: the context strip's counts are this alone. Then
//! [`read_patches`] reads the files' patches in the batches
//! [`ReviewSnapshot::patch_batches`] makes (the rule is there), each one
//! `git diff --no-ext-diff --no-color --full-index --src-prefix=a/
//! --dst-prefix=b/ --unified=20 <comparison> -- <paths>`, with
//! `--find-renames` for renamed files (both their paths in the batch) and
//! `--no-renames` for the rest; no `--binary`, so a binary file's patch is
//! Git's "Binary files … differ" line, never its bytes. A file's whole text
//! around its changes ([`read_whole_file`]) is the same comparison with
//! `--unified=1000000` and the file's paths.
//!
//! Every command reads. None changes the index, a ref or a file: each runs
//! as `git -C <root> --no-optional-locks …` with `GIT_OPTIONAL_LOCKS=0` (so
//! not even an optional index refresh takes a lock), `GIT_LITERAL_PATHSPECS=1`
//! (a path is a path, never a pattern) and `LC_ALL=C`, under a 10 s timeout
//! and a 32 MB output cap. Nothing here touches GPUI; the panel runs the
//! reads on the background executor.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures_lite::future::Boxed;
use futures_lite::{AsyncRead, AsyncReadExt as _, FutureExt as _};

/// How long one Git command may run (Desktop's `GIT_TIMEOUT_MS`). A patch
/// batch that runs past it is read again in halves; a single file past it
/// shows as [`FilePatch::TooLarge`].
pub const GIT_TIMEOUT: Duration = Duration::from_secs(10);
/// The most output one Git command may write (Desktop's
/// `GIT_MAX_BUFFER_BYTES`); a patch batch past it is read again in halves,
/// any other output past it is a failure.
pub const GIT_MAX_OUTPUT_BYTES: usize = 32 * 1024 * 1024;
/// The most patch text one file may have and still be shown: one command's
/// output. A tracked file whose patch is longer, or an untracked file
/// larger, shows its header and counts (an untracked one its size) with a
/// notice in place of its lines.
pub const FILE_MAX_PATCH_BYTES: usize = GIT_MAX_OUTPUT_BYTES;
/// The unchanged lines a diff carries around each change: Git's three
/// (Desktop's) would leave the panel's Diff nothing to fold, so twenty, of
/// which the Diff shows three and folds the rest for the reader to unfold.
pub const DIFF_CONTEXT_LINES: usize = 20;
const DIFF_CONTEXT: &str = "--unified=20";
/// Context past any file's length: a file's whole text around its changes.
const WHOLE_FILE_CONTEXT: &str = "--unified=1000000";
/// A patch batch holds at most this many files,
const BATCH_MAX_FILES: usize = 256;
/// this many bytes of their paths on the command line,
const BATCH_MAX_PATH_BYTES: usize = 64 * 1024;
/// and this many changed lines by their counts (untracked files: this many
/// bytes of their contents, [`BATCH_MAX_UNTRACKED_BYTES`]); a file past it
/// alone is a batch of its own.
const BATCH_MAX_LINES: u64 = 40_000;
const BATCH_MAX_UNTRACKED_BYTES: u64 = FILE_MAX_PATCH_BYTES as u64;
/// The fields of a listed commit, unit-separated: its hash, its short hash,
/// its author, its author time (Unix seconds) and its subject.
const COMMIT_FORMAT: &str = "--format=%H%x1f%h%x1f%an%x1f%at%x1f%s";
/// The commits one `git log` lists (about 7 MB of output): a base far
/// behind, in a large repository, is read a page at a time rather than
/// fail one command at the output cap.
pub(crate) const COMMITS_PAGE: usize = 50_000;

/// What a Git command wrote to its standard output.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct GitOutput {
    pub stdout: String,
    /// The output passed [`GIT_MAX_OUTPUT_BYTES`]: `stdout` is its start.
    pub truncated: bool,
}

impl GitOutput {
    pub fn new(stdout: impl Into<String>) -> Self {
        Self { stdout: stdout.into(), truncated: false }
    }

    pub fn truncated(stdout: impl Into<String>) -> Self {
        Self { stdout: stdout.into(), truncated: true }
    }
}

/// Why a Git command gave no output.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum GitError {
    /// No `git` to run.
    Missing,
    /// It ran past [`GIT_TIMEOUT`].
    TimedOut,
    /// It exited unsuccessfully, saying this on its standard error.
    Failed(String),
}

/// Runs a Git command in a repository: the seam tests replace with a fake.
pub trait GitRunner: Send + Sync + 'static {
    /// `git <args>` in `root`.
    fn run(&self, root: &Path, args: &[String]) -> Boxed<Result<GitOutput, GitError>>;
}

/// The system's `git`, run as the module's header says.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemGit;

impl GitRunner for SystemGit {
    fn run(&self, root: &Path, args: &[String]) -> Boxed<Result<GitOutput, GitError>> {
        let (root, args) = (root.to_owned(), args.to_vec());
        let run = async move { run_git(&root, &args).await };
        let timeout = async {
            async_io::Timer::after(GIT_TIMEOUT).await;
            Err(GitError::TimedOut)
        };
        // Dropping the losing command kills its process (`kill_on_drop`).
        run.or(timeout).boxed()
    }
}

/// The whole argument list of `git <args>` in `root`: the repository, then
/// no optional locks, then the command.
pub(crate) fn git_arguments(root: &Path, args: &[String]) -> Vec<std::ffi::OsString> {
    let mut all: Vec<std::ffi::OsString> =
        vec!["-C".into(), root.as_os_str().to_owned(), "--no-optional-locks".into()];
    all.extend(args.iter().map(Into::into));
    all
}

async fn run_git(root: &Path, args: &[String]) -> Result<GitOutput, GitError> {
    use async_process::{Command, Stdio};
    let mut child = Command::new("git")
        .args(git_arguments(root, args))
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("LC_ALL", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => GitError::Missing,
            _ => GitError::Failed(error.to_string()),
        })?;
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        return Err(GitError::Failed("no pipes".to_owned()));
    };
    let read_stdout = async {
        let read = read_capped(stdout, GIT_MAX_OUTPUT_BYTES).await;
        if read.as_ref().is_ok_and(|bytes| bytes.len() > GIT_MAX_OUTPUT_BYTES) {
            // Past the cap: stop the command rather than wait on a pipe no
            // one reads.
            child.kill().ok();
        }
        read
    };
    let read_stderr = read_capped(stderr, 64 * 1024);
    let (stdout, stderr) = futures_lite::future::zip(read_stdout, read_stderr).await;
    let stdout = stdout.map_err(|error| GitError::Failed(error.to_string()))?;
    if stdout.len() > GIT_MAX_OUTPUT_BYTES {
        return Ok(GitOutput::truncated(String::from_utf8_lossy(&stdout[..GIT_MAX_OUTPUT_BYTES])));
    }
    let status = child.status().await.map_err(|error| GitError::Failed(error.to_string()))?;
    if !status.success() {
        let stderr = stderr.unwrap_or_default();
        return Err(GitError::Failed(String::from_utf8_lossy(&stderr).trim().to_owned()));
    }
    Ok(GitOutput::new(String::from_utf8_lossy(&stdout)))
}

/// Reads `reader` to its end, or until it has more than `cap` bytes, a
/// chunk at a time. Not `read_to_end`: it zero-fills its whole spare
/// capacity again after every read that has to wait, which made reading
/// 32 MB from a pipe Git keeps filling take seconds.
pub(crate) async fn read_capped(
    mut reader: impl AsyncRead + Unpin,
    cap: usize,
) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut chunk = vec![0; 64 * 1024];
    while bytes.len() <= cap {
        let read = reader.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
    Ok(bytes)
}

/// A file's change (`GitReviewFileStatus`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    Untracked,
    Unknown,
}

/// One changed file (`GitReviewFile`), without its patch: its counts are
/// Git's (`--numstat`), or an untracked file's lines.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ReviewFile {
    /// Relative to the repository's root.
    pub path: String,
    pub previous_path: Option<String>,
    pub status: FileStatus,
    pub additions: u32,
    pub deletions: u32,
    /// Git counts no lines of it: its contents are binary.
    pub binary: bool,
    /// An untracked file past [`FILE_MAX_PATCH_BYTES`] is not read: its size
    /// in bytes, which stands for its line counts (both zero).
    pub unread_size: Option<u64>,
    /// Where its patch comes from: the comparisons that list it, by their
    /// place in the snapshot's, or the disk (an untracked file, with its
    /// size).
    pub(crate) origin: Origin,
}

/// Where a listed file's patch is read from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Origin {
    /// `git diff` of these comparisons (two only without a commit yet,
    /// for a file both staged and changed again).
    Compared(Vec<usize>),
    /// The working tree, as an untracked file of this many bytes.
    Untracked(u64),
}

impl ReviewFile {
    /// A tracked file `path` of one comparison, for tests that build files.
    #[cfg(test)]
    pub(crate) fn listed(path: &str, status: FileStatus, additions: u32, deletions: u32) -> Self {
        Self {
            path: path.to_owned(),
            previous_path: None,
            status,
            additions,
            deletions,
            binary: false,
            unread_size: None,
            origin: Origin::Compared(vec![0]),
        }
    }
}

/// A branch to compare against (`GitReviewBaseBranchOption`).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct BaseBranch {
    /// The name a reader knows it by: `main`, `origin/main`.
    pub label: String,
    /// Its fully qualified ref, never a tag or an ambiguous name.
    pub value: String,
}

/// The current branch and the branches to compare it against
/// (`GitReviewBranchContext`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct BranchContext {
    pub current_branch: Option<String>,
    pub base_branch_options: Vec<BaseBranch>,
}

/// Which of the branch's changes a read shows.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default)]
#[non_exhaustive]
pub enum ReviewScope {
    /// The working tree against the merge base with the base branch
    /// (against `HEAD` without one), untracked files included: every
    /// change the branch makes.
    #[default]
    All,
    /// The working tree against `HEAD`, untracked files included.
    Uncommitted,
    /// One commit of the branch since the merge base, by its full hash:
    /// its own changes against its first parent.
    Commit(String),
}

/// A commit of the branch since the merge base, as the panel lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct BranchCommit {
    /// The full hash: the commit's identity.
    pub sha: String,
    pub short_sha: String,
    pub author: String,
    /// When it was authored, in milliseconds since the Unix epoch.
    pub timestamp_ms: u64,
    /// The first line of its message.
    pub subject: String,
}

/// The changes of a repository against its base branch
/// (`GitReviewSnapshot`, source `branch`): every file of the scope with its
/// counts, without patches ([`read_patches`] reads those).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ReviewSnapshot {
    pub repository_root: PathBuf,
    pub branches: BranchContext,
    /// The ref compared against, as chosen or resolved; `None` without one
    /// (the working tree against `HEAD`).
    pub base_branch: Option<String>,
    /// The merge base of `base_branch` and `HEAD`.
    pub merge_base: Option<String>,
    /// The scope read: the one asked for, or all changes when the commit
    /// asked for is no longer on the branch.
    pub scope: ReviewScope,
    /// Every commit of the branch since the merge base, newest first.
    pub commits: Vec<BranchCommit>,
    pub files: Vec<ReviewFile>,
    pub additions: u32,
    pub deletions: u32,
    /// The comparisons the tracked files were listed from: the arguments
    /// after `git diff`.
    comparisons: Arc<[Vec<String>]>,
}

/// A file's patch, as [`read_patches`] reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum FilePatch {
    /// Its unified diff, `diff --git` header first; empty when Git no
    /// longer gives one (the file changed back since it was listed).
    Text(Arc<str>),
    /// Its patch is past [`FILE_MAX_PATCH_BYTES`] (or Git took longer than
    /// [`GIT_TIMEOUT`] over the file alone): not held.
    TooLarge,
}

/// One listed file in a [`PatchBatch`].
#[derive(Debug, Clone, PartialEq, Eq)]
struct BatchFile {
    path: String,
    previous_path: Option<String>,
    /// Untracked: the size it was listed with.
    size: u64,
}

/// Files whose patches one command reads (untracked files: one pass over
/// the disk), as [`ReviewSnapshot::patch_batches`] makes them.
#[derive(Debug, Clone)]
pub struct PatchBatch {
    root: PathBuf,
    /// The arguments after `git diff`; none for untracked files.
    comparison: Option<Vec<String>>,
    /// Renamed or copied files, read with rename detection.
    renames: bool,
    files: Vec<BatchFile>,
}

impl PatchBatch {
    /// How many files it holds.
    pub fn len(&self) -> usize {
        self.files.len()
    }

    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }
}

/// Why there is no snapshot (the `reason` of a failed `GitReviewReadResult`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum FailureReason {
    /// The task's folder is gone, or the Host is not on this machine.
    WorkspaceUnavailable,
    NotGitRepository,
    /// No commit to compare with.
    UnbornRepository,
    /// The chosen base branch no longer exists.
    InvalidBaseBranch,
    /// No `git` to run.
    GitMissing,
    GitFailed,
}

/// A read that found no snapshot, with the branches when they were read
/// before it failed, so the picker stays usable.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ReviewFailure {
    pub reason: FailureReason,
    pub branches: Option<BranchContext>,
}

impl ReviewFailure {
    pub fn new(reason: FailureReason) -> Self {
        Self { reason, branches: None }
    }
}

/// What a read found (`GitReviewReadResult`).
pub type ReviewRead = Result<ReviewSnapshot, ReviewFailure>;

/// The branches a review compares against first, in the order a reader
/// expects them (`BASE_BRANCH_PRIORITY`).
const BASE_BRANCH_PRIORITY: [&str; 5] = [
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
    "refs/remotes/origin/master",
    "refs/heads/main",
    "refs/heads/master",
];

/// Lists `scope` of the changes of the repository holding `cwd` against
/// `base` (a fully qualified ref), or against the branch Desktop resolves
/// when it is `None`: every file with its counts, and every commit. Reads
/// no patch.
pub async fn read_review(
    cwd: &Path,
    base: Option<&str>,
    scope: &ReviewScope,
    git: Arc<dyn GitRunner>,
) -> ReviewRead {
    let is_dir = async_fs::metadata(cwd).await.is_ok_and(|metadata| metadata.is_dir());
    if !is_dir {
        return Err(ReviewFailure::new(FailureReason::WorkspaceUnavailable));
    }
    let Some(root) = repository_root(cwd).await else {
        return Err(ReviewFailure::new(FailureReason::NotGitRepository));
    };
    let reader = Reader { root, git };
    let mut branches = None;
    match reader.read(base, scope, &mut branches).await {
        Ok(snapshot) => Ok(snapshot),
        Err(ReadError::InvalidBaseBranch) => {
            Err(ReviewFailure { reason: FailureReason::InvalidBaseBranch, branches })
        }
        Err(ReadError::Git(error)) => {
            let reason = if error == GitError::Missing {
                FailureReason::GitMissing
            } else if is_unborn(&error) {
                FailureReason::UnbornRepository
            } else {
                FailureReason::GitFailed
            };
            Err(ReviewFailure { reason, branches })
        }
    }
}

/// Desktop's `isUnbornRepositoryError`.
fn is_unborn(error: &GitError) -> bool {
    let GitError::Failed(message) = error else { return false };
    let message = message.to_lowercase();
    ["unknown revision", "bad revision", "ambiguous argument", "does not have any commits"]
        .iter()
        .any(|needle| message.contains(needle))
}

/// The nearest folder at or above `cwd` holding a `.git` directory or a
/// `.git` file that names one (Desktop's `resolveProjectRoot` and
/// `resolveGitDir`).
async fn repository_root(cwd: &Path) -> Option<PathBuf> {
    for dir in cwd.ancestors() {
        let marker = dir.join(".git");
        let Ok(metadata) = async_fs::metadata(&marker).await else { continue };
        if metadata.is_dir() {
            return Some(dir.to_owned());
        }
        if metadata.is_file() {
            let names_git_dir = async_fs::read_to_string(&marker).await.is_ok_and(|text| {
                text.lines().any(|line| {
                    line.strip_prefix("gitdir:").is_some_and(|dir| !dir.trim().is_empty())
                })
            });
            if names_git_dir {
                return Some(dir.to_owned());
            }
        }
    }
    None
}

#[derive(Debug)]
enum ReadError {
    InvalidBaseBranch,
    Git(GitError),
}

impl From<GitError> for ReadError {
    fn from(error: GitError) -> Self {
        Self::Git(error)
    }
}

struct Reader {
    root: PathBuf,
    git: Arc<dyn GitRunner>,
}

impl Reader {
    async fn git(&self, args: &[&str]) -> Result<GitOutput, GitError> {
        let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
        self.git.run(&self.root, &args).await
    }

    /// A command whose whole output matters: one cut at the cap fails.
    async fn output(&self, args: &[&str]) -> Result<String, GitError> {
        let output = self.git(args).await?;
        if output.truncated {
            return Err(GitError::Failed("output past the cap".to_owned()));
        }
        Ok(output.stdout)
    }

    async fn ref_exists(&self, name: &str) -> bool {
        self.output(&["rev-parse", "--verify", "--quiet", name]).await.is_ok()
    }

    async fn read(
        &self,
        requested: Option<&str>,
        scope: &ReviewScope,
        branches: &mut Option<BranchContext>,
    ) -> Result<ReviewSnapshot, ReadError> {
        let current_branch = clean_line(&self.output(&["branch", "--show-current"]).await?);
        let has_head = self.ref_exists("HEAD").await;
        let options = if has_head { self.base_branches().await? } else { Vec::new() };
        *branches = Some(BranchContext { current_branch, base_branch_options: options.clone() });
        let chosen = match requested {
            Some(requested) => Some(
                options
                    .iter()
                    .find(|option| option.value == requested)
                    .ok_or(ReadError::InvalidBaseBranch)?
                    .value
                    .clone(),
            ),
            None => None,
        };
        let base_branch = match chosen {
            Some(chosen) if has_head => Some(chosen),
            None if has_head => self.resolve_base_branch(&options).await,
            _ => None,
        };
        let merge_base = match &base_branch {
            Some(base) => clean_line(&self.output(&["merge-base", base, "HEAD"]).await?),
            None => None,
        };
        let commits = match &merge_base {
            Some(merge_base) => self.commits(merge_base).await?,
            None => Vec::new(),
        };
        // A commit no longer on the branch (rebased, or the base changed)
        // reads as all changes.
        let scope = match scope {
            ReviewScope::Commit(sha) if !commits.iter().any(|commit| &commit.sha == sha) => {
                ReviewScope::All
            }
            scope => scope.clone(),
        };
        let comparisons = comparisons(&scope, merge_base.as_deref(), has_head);
        let mut files = Vec::new();
        for (ix, comparison) in comparisons.iter().enumerate() {
            let comparison: Vec<&str> = comparison.iter().map(String::as_str).collect();
            files.extend(self.list_tracked(ix, &comparison).await?);
        }
        // A commit's changes have no untracked files.
        if !matches!(scope, ReviewScope::Commit(_)) {
            files.extend(self.list_untracked().await?);
        }
        let files = dedupe(files);
        let additions = files.iter().map(|file| file.additions).sum();
        let deletions = files.iter().map(|file| file.deletions).sum();
        Ok(ReviewSnapshot {
            repository_root: self.root.clone(),
            branches: branches.clone().unwrap_or_default(),
            base_branch,
            merge_base,
            scope,
            commits,
            files,
            additions,
            deletions,
            comparisons: comparisons.into(),
        })
    }

    /// Desktop's `listBaseBranches`: local branches and remote ones (a
    /// remote's `HEAD` only for `origin`), the likely bases first.
    async fn base_branches(&self) -> Result<Vec<BaseBranch>, GitError> {
        let output = self
            .output(&["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"])
            .await?;
        let mut seen = std::collections::HashSet::new();
        let mut branches = Vec::new();
        for value in output.lines().map(str::trim) {
            if !seen.insert(value) {
                continue;
            }
            let label = if let Some(name) = value.strip_prefix("refs/heads/") {
                name
            } else if let Some(name) = value.strip_prefix("refs/remotes/")
                && (value == "refs/remotes/origin/HEAD" || !value.ends_with("/HEAD"))
            {
                name
            } else {
                continue;
            };
            branches.push(BaseBranch { label: label.to_owned(), value: value.to_owned() });
        }
        let rank = |value: &str| BASE_BRANCH_PRIORITY.iter().position(|known| *known == value);
        branches.sort_by(|left, right| match (rank(&left.value), rank(&right.value)) {
            (Some(left), Some(right)) => left.cmp(&right),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => left.label.cmp(&right.label),
        });
        Ok(branches)
    }

    /// Desktop's `resolveBaseBranch`: the remote's default, then the
    /// shared priority order, whichever is listed and exists first.
    async fn resolve_base_branch(&self, options: &[BaseBranch]) -> Option<String> {
        let remote_head = self
            .output(&["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])
            .await
            .ok()
            .and_then(|output| clean_line(&output));
        let mut candidates: Vec<String> = remote_head.into_iter().collect();
        for known in BASE_BRANCH_PRIORITY {
            if !candidates.iter().any(|candidate| candidate == known) {
                candidates.push(known.to_owned());
            }
        }
        for candidate in candidates {
            if options.iter().any(|option| option.value == candidate)
                && self.ref_exists(&candidate).await
            {
                return Some(candidate);
            }
        }
        None
    }

    /// Every commit of the branch since `merge_base`, newest first, in
    /// pages of [`COMMITS_PAGE`].
    async fn commits(&self, merge_base: &str) -> Result<Vec<BranchCommit>, GitError> {
        let range = format!("{merge_base}..HEAD");
        let page = format!("--max-count={COMMITS_PAGE}");
        let mut commits = Vec::new();
        loop {
            let skip = format!("--skip={}", commits.len());
            let output = self.output(&["log", "-z", &page, &skip, COMMIT_FORMAT, &range]).await?;
            let page: Vec<BranchCommit> = output.split('\0').filter_map(parse_commit).collect();
            let read = page.len();
            commits.extend(page);
            if read < COMMITS_PAGE {
                return Ok(commits);
            }
        }
    }

    /// Desktop's `readTrackedChanges` for comparison `ix`, without the
    /// patches: each file's status, and its counts from `--numstat`.
    async fn list_tracked(
        &self,
        ix: usize,
        comparison: &[&str],
    ) -> Result<Vec<ReviewFile>, GitError> {
        let mut name_status = vec!["diff", "--name-status", "-z", "--find-renames"];
        name_status.extend(comparison);
        let mut numstat = vec!["diff", "--numstat", "-z", "--find-renames"];
        numstat.extend(comparison);
        let (names, counts) =
            futures_lite::future::zip(self.output(&name_status), self.output(&numstat)).await;
        let counts = parse_numstat(&counts?);
        Ok(parse_name_status(&names?)
            .into_iter()
            .map(|(path, previous_path, status)| {
                let counts = counts.get(&path).copied().unwrap_or(Some((0, 0)));
                let (additions, deletions) = counts.unwrap_or_default();
                ReviewFile {
                    path,
                    previous_path,
                    status,
                    additions,
                    deletions,
                    binary: counts.is_none(),
                    unread_size: None,
                    origin: Origin::Compared(vec![ix]),
                }
            })
            .collect())
    }

    /// Desktop's `readUntrackedChanges`: each untracked, unignored file as
    /// an addition, its lines counted as it is read (a file past
    /// [`FILE_MAX_PATCH_BYTES`] is not read: its size stands for them). A
    /// folder Git lists (a repository inside this one) is not a file, and
    /// a file gone since it was listed is no change.
    async fn list_untracked(&self) -> Result<Vec<ReviewFile>, GitError> {
        let output = self.output(&["ls-files", "-z", "--others", "--exclude-standard"]).await?;
        let mut files = Vec::new();
        for path in output.split('\0').filter(|path| !path.is_empty() && stays_inside(path)) {
            let Some(read) = read_untracked(&self.root, path).await? else { continue };
            let (additions, binary, unread_size) = match &read.content {
                UntrackedContent::Text(text) => (text_lines(text), false, None),
                UntrackedContent::Link(_) => (1, false, None),
                UntrackedContent::Binary => (0, true, None),
                UntrackedContent::TooLarge => (0, false, Some(read.size)),
            };
            files.push(ReviewFile {
                path: path.to_owned(),
                previous_path: None,
                status: FileStatus::Untracked,
                additions,
                deletions: 0,
                binary,
                unread_size,
                origin: Origin::Untracked(read.size),
            });
        }
        Ok(files)
    }
}

/// An untracked file as read from the disk.
struct UntrackedRead {
    size: u64,
    content: UntrackedContent,
}

enum UntrackedContent {
    /// Its text, line ends made `\n`.
    Text(String),
    /// A symbolic link: its target.
    Link(String),
    /// Bytes that are not text (Desktop's test: a NUL, invalid UTF-8, or
    /// U+FFFD).
    Binary,
    /// Past [`FILE_MAX_PATCH_BYTES`]: not read.
    TooLarge,
}

/// Reads the untracked file at `path` in `root`; `None` for a folder or a
/// file gone since it was listed.
async fn read_untracked(root: &Path, path: &str) -> Result<Option<UntrackedRead>, GitError> {
    let failed = |error: std::io::Error| GitError::Failed(error.to_string());
    let target = root.join(path);
    let metadata = match async_fs::symlink_metadata(&target).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(failed(error)),
    };
    if metadata.file_type().is_symlink() {
        let link = async_fs::read_link(&target).await.map_err(failed)?;
        let link = link.to_string_lossy().into_owned();
        return Ok(Some(UntrackedRead {
            size: link.len() as u64,
            content: UntrackedContent::Link(link),
        }));
    }
    if !metadata.is_file() {
        return Ok(None);
    }
    let size = metadata.len();
    if size > FILE_MAX_PATCH_BYTES as u64 {
        return Ok(Some(UntrackedRead { size, content: UntrackedContent::TooLarge }));
    }
    let bytes = match async_fs::read(&target).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(failed(error)),
    };
    let content = match untracked_text(&bytes) {
        Some(text) => UntrackedContent::Text(text),
        None => UntrackedContent::Binary,
    };
    Ok(Some(UntrackedRead { size, content }))
}

/// An untracked file's bytes as text, or `None` for bytes shown as binary.
fn untracked_text(bytes: &[u8]) -> Option<String> {
    if bytes.contains(&0) {
        return None;
    }
    let text = std::str::from_utf8(bytes).ok()?;
    if text.contains('\u{FFFD}') {
        return None;
    }
    Some(text.replace("\r\n", "\n"))
}

/// The lines of a text: its line ends, and a last line without one.
fn text_lines(text: &str) -> u32 {
    let ends = text.bytes().filter(|byte| *byte == b'\n').count();
    let open = usize::from(!text.is_empty() && !text.ends_with('\n'));
    u32::try_from(ends + open).unwrap_or(u32::MAX)
}

/// The comparisons a scope's tracked changes are read in: the arguments
/// after `git diff`. Without a commit yet, Desktop's two: the index against
/// the empty tree and the working tree against the index.
fn comparisons(scope: &ReviewScope, merge_base: Option<&str>, has_head: bool) -> Vec<Vec<String>> {
    let one = |args: &[&str]| vec![args.iter().map(|arg| (*arg).to_owned()).collect()];
    match scope {
        ReviewScope::Commit(sha) => one(&[&format!("{sha}^"), sha]),
        ReviewScope::All if let Some(base) = merge_base => one(&[base]),
        _ if has_head => one(&["HEAD"]),
        _ => vec![vec!["--cached".to_owned(), "--root".to_owned()], Vec::new()],
    }
}

/// `git diff` with a unified patch's options and `context`: Git's own
/// diff, no colour, full blob names, the `a/` and `b/` prefixes whatever
/// the configuration says, and no binary bodies.
fn unified_diff(context: &str, renames: bool) -> Vec<String> {
    let renames = if renames { "--find-renames" } else { "--no-renames" };
    ["diff", "--no-ext-diff", "--no-color", renames, "--full-index"]
        .into_iter()
        .chain(["--src-prefix=a/", "--dst-prefix=b/", context])
        .map(str::to_owned)
        .collect()
}

impl ReviewSnapshot {
    /// The batches its files' patches are read in. The rule: tracked files
    /// by comparison, renamed and copied ones apart from the rest (their
    /// old paths with them, read with rename detection, the rest without);
    /// in the snapshot's order, a batch takes files while it holds at most
    /// 256 files, 64 KB of paths and 40,000 changed lines by their counts,
    /// so a file past that is a batch of its own. Untracked files are
    /// batched the same way by their sizes, at most 32 MB a batch. A batch
    /// whose output passes the cap or the timeout anyway is read again in
    /// halves ([`read_patches`]).
    pub fn patch_batches(&self) -> Vec<PatchBatch> {
        let mut batches = Vec::new();
        let batch =
            |comparison: Option<&Vec<String>>, renames: bool, files: Vec<BatchFile>| PatchBatch {
                root: self.repository_root.clone(),
                comparison: comparison.cloned(),
                renames,
                files,
            };
        for (ix, comparison) in self.comparisons.iter().enumerate() {
            for renames in [false, true] {
                let files = self.files.iter().filter(|file| {
                    matches!(&file.origin, Origin::Compared(sources) if sources.contains(&ix))
                        && file.previous_path.is_some() == renames
                });
                let weigh =
                    |file: &ReviewFile| u64::from(file.additions) + u64::from(file.deletions);
                for files in pack(files, BATCH_MAX_LINES, weigh) {
                    batches.push(batch(Some(comparison), renames, files));
                }
            }
        }
        let untracked =
            self.files.iter().filter(|file| matches!(file.origin, Origin::Untracked(_)));
        let size = |file: &ReviewFile| match file.origin {
            Origin::Untracked(size) => size,
            Origin::Compared(_) => 0,
        };
        for files in pack(untracked, BATCH_MAX_UNTRACKED_BYTES, size) {
            batches.push(batch(None, false, files));
        }
        batches
    }
}

/// `files` in batches of at most [`BATCH_MAX_FILES`], [`BATCH_MAX_PATH_BYTES`]
/// of paths, and `budget` of `weigh`; a file past the budget alone is a
/// batch of its own.
fn pack<'a>(
    files: impl Iterator<Item = &'a ReviewFile>,
    budget: u64,
    weigh: impl Fn(&ReviewFile) -> u64,
) -> Vec<Vec<BatchFile>> {
    let mut batches = Vec::new();
    let (mut current, mut path_bytes, mut weight) = (Vec::new(), 0, 0);
    for file in files {
        let bytes = file.path.len() + file.previous_path.as_ref().map_or(0, String::len);
        let heavy = weigh(file);
        if !current.is_empty()
            && (current.len() >= BATCH_MAX_FILES
                || path_bytes + bytes > BATCH_MAX_PATH_BYTES
                || weight + heavy > budget)
        {
            batches.push(std::mem::take(&mut current));
            (path_bytes, weight) = (0, 0);
        }
        let size = match file.origin {
            Origin::Untracked(size) => size,
            Origin::Compared(_) => 0,
        };
        current.push(BatchFile {
            path: file.path.clone(),
            previous_path: file.previous_path.clone(),
            size,
        });
        path_bytes += bytes;
        weight += heavy;
    }
    if !current.is_empty() {
        batches.push(current);
    }
    batches
}

/// Reads `batch`'s patches: one for each of its files, by path. A command
/// whose output passes [`GIT_MAX_OUTPUT_BYTES`] or that runs past
/// [`GIT_TIMEOUT`] is run again on each half of its files, down to one file,
/// which is then [`FilePatch::TooLarge`]; any other failure fails the batch.
pub async fn read_patches(
    batch: PatchBatch,
    git: Arc<dyn GitRunner>,
) -> Result<Vec<(String, FilePatch)>, GitError> {
    let Some(comparison) = &batch.comparison else {
        return read_untracked_patches(&batch).await;
    };
    let mut patches = Vec::with_capacity(batch.files.len());
    // The ranges of `batch.files` left to read, the next one last.
    let mut pending = Vec::new();
    pending.push(0..batch.files.len());
    while let Some(range) = pending.pop() {
        let files = &batch.files[range.clone()];
        let mut args = unified_diff(DIFF_CONTEXT, batch.renames);
        args.extend(comparison.iter().cloned());
        args.push("--".to_owned());
        for file in files {
            args.extend(file.previous_path.iter().cloned());
            args.push(file.path.clone());
        }
        let output = match git.run(&batch.root, &args).await {
            Ok(output) if !output.truncated => output,
            Ok(_) | Err(GitError::TimedOut) if files.len() > 1 => {
                let middle = range.start + files.len() / 2;
                pending.push(middle..range.end);
                pending.push(range.start..middle);
                continue;
            }
            Ok(_) | Err(GitError::TimedOut) => {
                patches.push((files[0].path.clone(), FilePatch::TooLarge));
                continue;
            }
            Err(error) => return Err(error),
        };
        let mut texts: HashMap<&str, String> =
            files.iter().map(|file| (file.path.as_str(), String::new())).collect();
        for chunk in split_unified_diff(&output.stdout) {
            if let Some(text) = chunk_path(chunk).and_then(|path| texts.get_mut(path.as_str())) {
                text.push_str(chunk);
            }
        }
        for file in files {
            let text = texts.remove(file.path.as_str()).unwrap_or_default();
            patches.push((file.path.clone(), FilePatch::Text(text.into())));
        }
    }
    Ok(patches)
}

/// The patches of a batch of untracked files, read from the disk: each a
/// new file's whole text as one added hunk, a link's target, a binary note,
/// or too large to read.
async fn read_untracked_patches(batch: &PatchBatch) -> Result<Vec<(String, FilePatch)>, GitError> {
    let mut patches = Vec::with_capacity(batch.files.len());
    for file in &batch.files {
        let path = file.path.as_str();
        let patch = match read_untracked(&batch.root, path).await? {
            None => FilePatch::Text(Arc::from("")),
            Some(UntrackedRead { content: UntrackedContent::TooLarge, .. }) => FilePatch::TooLarge,
            Some(UntrackedRead { content, .. }) => {
                FilePatch::Text(untracked_file_diff(path, &content).into())
            }
        };
        patches.push((file.path.clone(), patch));
    }
    Ok(patches)
}

/// One record of `git log -z` in [`COMMIT_FORMAT`].
fn parse_commit(record: &str) -> Option<BranchCommit> {
    let mut fields = record.trim_start_matches('\n').split('\u{1f}');
    let sha = fields.next().filter(|sha| !sha.is_empty())?.to_owned();
    let short_sha = fields.next()?.to_owned();
    let author = fields.next()?.to_owned();
    let seconds: u64 = fields.next()?.trim().parse().ok()?;
    let subject = fields.next().unwrap_or_default().trim_end().to_owned();
    Some(BranchCommit { sha, short_sha, author, timestamp_ms: seconds * 1000, subject })
}

/// The diff of the file at `path` (once `previous_path`) in `scope`, with
/// the file's whole text around its changes: the panel's "Show more lines".
/// `merge_base` is the snapshot's. `None` when Git gives no diff for it.
pub async fn read_whole_file(
    root: &Path,
    scope: &ReviewScope,
    merge_base: Option<&str>,
    path: &str,
    previous_path: Option<&str>,
    git: Arc<dyn GitRunner>,
) -> Result<Option<String>, GitError> {
    let mut comparison = comparisons(scope, merge_base, true);
    let comparison = comparison.swap_remove(0);
    let mut args = unified_diff(WHOLE_FILE_CONTEXT, previous_path.is_some());
    args.extend(comparison);
    args.push("--".to_owned());
    args.extend(previous_path.map(str::to_owned));
    args.push(path.to_owned());
    let output = git.run(root, &args).await?;
    if output.truncated {
        return Err(GitError::Failed("output past the cap".to_owned()));
    }
    // A rename's two paths give one file; should Git not pair them, the
    // chunk of `path`.
    let chunks = split_unified_diff(&output.stdout);
    let chunk =
        chunks.iter().find(|chunk| chunk_path(chunk).as_deref() == Some(path)).or(chunks.last());
    Ok(chunk.map(|chunk| (*chunk).to_owned()))
}

/// A relative path that stays under the root once resolved.
fn stays_inside(path: &str) -> bool {
    let path = Path::new(path);
    !path.is_absolute()
        && path.components().all(|component| matches!(component, Component::Normal(_)))
}

/// Desktop's `untrackedFileDiff`: a new file's whole text as one added
/// hunk, a link's target as Git shows a new link, or a binary note for
/// bytes that are not text.
fn untracked_file_diff(path: &str, content: &UntrackedContent) -> String {
    let (mode, text) = match content {
        UntrackedContent::Text(text) => ("100644", text.as_str()),
        UntrackedContent::Link(target) => ("120000", target.as_str()),
        UntrackedContent::Binary | UntrackedContent::TooLarge => {
            return format!(
                "diff --git a/{path} b/{path}\nnew file mode 100644\nBinary files /dev/null and b/{path} differ\n"
            );
        }
    };
    let header = format!("diff --git a/{path} b/{path}\nnew file mode {mode}\n");
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    if lines.is_empty() {
        return format!("{header}--- /dev/null\n+++ b/{path}\n");
    }
    let mut diff = format!("{header}--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{} @@\n", lines.len());
    for line in &lines {
        diff.push('+');
        diff.push_str(line);
        diff.push('\n');
    }
    if !text.ends_with('\n') {
        diff.push_str("\\ No newline at end of file\n");
    }
    diff
}

/// Desktop's `parseNameStatus` of `diff --name-status -z`: the path, the
/// path before a rename or copy, and the status.
fn parse_name_status(output: &str) -> Vec<(String, Option<String>, FileStatus)> {
    let mut fields: Vec<&str> = output.split('\0').collect();
    if fields.last() == Some(&"") {
        fields.pop();
    }
    let mut fields = fields.into_iter();
    let mut entries = Vec::new();
    while let Some(code) = fields.next() {
        let kind = code.chars().next();
        if matches!(kind, Some('R' | 'C')) {
            let (Some(previous), Some(path)) = (fields.next(), fields.next()) else { break };
            if previous.is_empty() || path.is_empty() {
                break;
            }
            let status = if kind == Some('R') { FileStatus::Renamed } else { FileStatus::Copied };
            entries.push((path.to_owned(), Some(previous.to_owned()), status));
            continue;
        }
        let Some(path) = fields.next().filter(|path| !path.is_empty()) else { break };
        let status = match kind {
            Some('A') => FileStatus::Added,
            Some('M' | 'T') => FileStatus::Modified,
            Some('D') => FileStatus::Deleted,
            _ => FileStatus::Unknown,
        };
        entries.push((path.to_owned(), None, status));
    }
    entries
}

/// `diff --numstat -z`: each file's added and deleted lines by its path
/// (the path after a rename), `None` for a binary file, which Git counts
/// as `-` and `-`.
pub(crate) fn parse_numstat(output: &str) -> HashMap<String, Option<(u32, u32)>> {
    let mut fields = output.split('\0');
    let mut counts = HashMap::new();
    while let Some(record) = fields.next() {
        let mut parts = record.trim_start_matches('\n').splitn(3, '\t');
        let (Some(added), Some(deleted), Some(path)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        // A rename's record ends at its counts; its two paths follow.
        let path = if path.is_empty() {
            let (Some(_), Some(path)) = (fields.next(), fields.next()) else { break };
            path
        } else {
            path
        };
        let count = |field: &str| field.parse::<u32>().ok();
        let lines = count(added).zip(count(deleted));
        counts.insert(path.to_owned(), lines);
    }
    counts
}

/// Desktop's `splitUnifiedDiff`: one chunk per `diff --git` header.
fn split_unified_diff(diff: &str) -> Vec<&str> {
    if diff.trim().is_empty() {
        return Vec::new();
    }
    let mut starts = Vec::new();
    let mut offset = 0;
    for line in diff.split_inclusive('\n') {
        if line.starts_with("diff --git ") {
            starts.push(offset);
        }
        offset += line.len();
    }
    if starts.is_empty() {
        return vec![diff];
    }
    starts
        .iter()
        .enumerate()
        .map(|(ix, start)| &diff[*start..starts.get(ix + 1).copied().unwrap_or(diff.len())])
        .collect()
}

/// The path a patch chunk is for, as `diff --name-status` names the file:
/// the path after a rename or copy, else the one its `diff --git a/P b/P`
/// header names (unquoted, as Git quotes a path with unusual bytes).
pub(crate) fn chunk_path(chunk: &str) -> Option<String> {
    let mut lines = chunk.split('\n');
    let header = lines.next()?.strip_prefix("diff --git ")?;
    for line in lines {
        if line.starts_with("--- ") || line.starts_with("@@") || line.starts_with("Binary files") {
            break;
        }
        if let Some(path) =
            line.strip_prefix("rename to ").or_else(|| line.strip_prefix("copy to "))
        {
            return unquote(path);
        }
    }
    if header.starts_with('"') {
        let (_, rest) = quoted(header)?;
        let rest = rest.strip_prefix(' ')?;
        let path = if rest.starts_with('"') { quoted(rest)?.0 } else { rest.to_owned() };
        return path.strip_prefix("b/").map(str::to_owned);
    }
    // `a/P b/P`: the same path twice, so the split is in the middle.
    let length = header.len().checked_sub(5).filter(|length| length % 2 == 0)? / 2;
    let path = header.get(2..2 + length)?;
    (header.strip_prefix("a/")?.strip_suffix(path)? == format!("{path} b/"))
        .then(|| path.to_owned())
}

/// A path Git may have quoted, as it is.
fn unquote(path: &str) -> Option<String> {
    if path.starts_with('"') { quoted(path).map(|(path, _)| path) } else { Some(path.to_owned()) }
}

/// The C-style quoted string `text` starts with, and the rest after it.
fn quoted(text: &str) -> Option<(String, &str)> {
    let body = text.strip_prefix('"')?;
    let mut bytes = Vec::new();
    let mut chars = body.char_indices();
    while let Some((at, c)) = chars.next() {
        match c {
            '"' => return Some((String::from_utf8_lossy(&bytes).into_owned(), &body[at + 1..])),
            '\\' => {
                let (_, escaped) = chars.next()?;
                let byte = match escaped {
                    'a' => 7,
                    'b' => 8,
                    't' => b'\t',
                    'n' => b'\n',
                    'v' => 11,
                    'f' => 12,
                    'r' => b'\r',
                    '0'..='7' => {
                        let mut value = escaped.to_digit(8)?;
                        for _ in 0..2 {
                            value = value * 8 + chars.next()?.1.to_digit(8)?;
                        }
                        u8::try_from(value).ok()?
                    }
                    other => {
                        let mut buffer = [0; 4];
                        bytes.extend_from_slice(other.encode_utf8(&mut buffer).as_bytes());
                        continue;
                    }
                };
                bytes.push(byte);
            }
            other => {
                let mut buffer = [0; 4];
                bytes.extend_from_slice(other.encode_utf8(&mut buffer).as_bytes());
            }
        }
    }
    None
}

/// Desktop's `dedupeReviewFiles`: a path listed twice (staged and then
/// changed again) is one file, its counts summed, its patch both
/// comparisons'.
fn dedupe(files: Vec<ReviewFile>) -> Vec<ReviewFile> {
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut merged: Vec<ReviewFile> = Vec::new();
    for file in files {
        match index.get(&file.path) {
            None => {
                index.insert(file.path.clone(), merged.len());
                merged.push(file);
            }
            Some(&ix) => {
                let existing = &mut merged[ix];
                existing.additions += file.additions;
                existing.deletions += file.deletions;
                existing.binary |= file.binary;
                existing.status = file.status;
                if file.previous_path.is_some() {
                    existing.previous_path = file.previous_path;
                }
                if let (Origin::Compared(sources), Origin::Compared(more)) =
                    (&mut existing.origin, file.origin)
                {
                    sources.extend(more);
                }
            }
        }
    }
    merged
}

fn clean_line(value: &str) -> Option<String> {
    let line = value.trim();
    (!line.is_empty()).then(|| line.to_owned())
}
