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

fn git(path: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .current_dir(path)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .args([
            "-c",
            "user.name=Maka Tests",
            "-c",
            "user.email=tests@maka.invalid",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

struct Fixture {
    _temp: tempfile::TempDir,
    repo: Repository,
    state: PathBuf,
    parent: directory::Observation,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let (root, parent) = directory::capture(temp.path()).unwrap();
        let source = dunce::simplified(&root).join("repo");
        fs::create_dir(&source).unwrap();
        git(&source, &["init", "--quiet", "-b", "main"]);
        fs::write(source.join("file"), "first commit").unwrap();
        git(&source, &["add", "file"]);
        git(&source, &["commit", "--quiet", "-m", "First"]);
        let repo = Repository::discover(&source).unwrap().unwrap();
        let state = root.join("state");
        Self {
            _temp: temp,
            repo,
            state,
            parent,
        }
    }

    fn plan(&self, digit: &str, name: &str, branch: &str) -> Result<Allocation> {
        self.repo.plan(
            digit.repeat(64),
            name.into(),
            branch.into(),
            Base::Commit("refs/heads/main".into()),
        )
    }

    fn ensure(&self, allocation: &Allocation) -> Result<Option<String>> {
        allocation.ensure(&self.state, &self.parent, Arc::new(AtomicBool::new(false)))
    }
}

#[test]
fn local_files_starting_point_preserves_the_source_index_and_file_contents() {
    let fixture = Fixture::new();
    let root = &fixture.repo.root;
    fs::create_dir(&fixture.state).unwrap();
    fs::write(root.join("file"), "staged").unwrap();
    git(root, &["add", "file"]);
    fs::write(root.join("file"), "unstaged").unwrap();
    fs::write(root.join("new"), [0, 0xff, 1]).unwrap();
    fs::write(fixture.repo.common_dir.join("info/exclude"), "ignored\n").unwrap();
    fs::write(root.join("ignored"), "do not copy").unwrap();
    let cancel = AtomicBool::new(false);
    let (_, identity) = directory::capture(root).unwrap();
    let source_index = fs::read(fixture.repo.common_dir.join("index")).unwrap();
    let base = git(root, &["rev-parse", "HEAD"]);
    let plan = fixture
        .repo
        .plan(
            "c".repeat(64),
            "snapshot".into(),
            "maka-snapshot".into(),
            Base::LocalFiles {
                reference: "refs/heads/main".into(),
                source: root,
                identity: &identity,
                private_root: &fs::canonicalize(&fixture.state).unwrap(),
                cancel: &cancel,
            },
        )
        .unwrap();
    assert_eq!(
        fs::read(fixture.repo.common_dir.join("index")).unwrap(),
        source_index
    );
    assert_eq!(fs::read_dir(&fixture.state).unwrap().count(), 0);
    fs::write(root.join("file"), "changed after capture").unwrap();

    fixture.ensure(&plan).unwrap();
    assert_eq!(git(&plan.directory, &["rev-parse", "HEAD"]), base);
    assert_eq!(git(&plan.directory, &["show", ":file"]), "staged");
    assert_eq!(fs::read(plan.directory.join("file")).unwrap(), b"unstaged");
    assert_eq!(fs::read(plan.directory.join("new")).unwrap(), [0, 0xff, 1]);
    assert!(git(&plan.directory, &["ls-files", "--", "new"]).is_empty());
    assert!(!plan.directory.join("ignored").exists());
    assert_eq!(
        fs::read(root.join("file")).unwrap(),
        b"changed after capture"
    );

    fs::remove_file(
        fixture
            .state
            .join(OPERATIONS_DIR)
            .join(&plan.id)
            .join("ready"),
    )
    .unwrap();
    assert_eq!(
        fixture.ensure(&plan).unwrap().as_deref(),
        Some("maka-snapshot")
    );
    fs::write(plan.directory.join("file"), "user updated the new checkout").unwrap();
    fixture.ensure(&plan).unwrap();
    assert_eq!(
        fs::read(plan.directory.join("file")).unwrap(),
        b"user updated the new checkout"
    );
}

#[test]
fn local_branch_checkout_carries_safe_edits_and_refuses_to_overwrite_other_edits() {
    let fixture = Fixture::new();
    let root = &fixture.repo.root;
    git(root, &["switch", "-c", "release"]);
    fs::write(root.join("file"), "release commit").unwrap();
    git(root, &["commit", "-am", "Release"]);
    git(root, &["switch", "main"]);
    fs::write(root.join("file"), "local edit").unwrap();
    fs::write(root.join("draft"), "untracked draft").unwrap();
    let cancel = AtomicBool::new(false);
    let (_, identity) = directory::capture(root).unwrap();
    let checkout = |branch, create| {
        fixture
            .repo
            .checkout_branch(&identity, branch, create, &cancel)
    };
    assert!(matches!(
        checkout("release", false),
        Err(BranchError::OverwritesChanges)
    ));
    assert_eq!(git(root, &["branch", "--show-current"]), "main\n");
    checkout("maka-feature", true).unwrap();
    assert_eq!(git(root, &["branch", "--show-current"]), "maka-feature\n");
    assert!(matches!(
        checkout("release", true),
        Err(BranchError::AlreadyExists)
    ));
    assert_eq!(fs::read(root.join("file")).unwrap(), b"local edit");
    assert_eq!(fs::read(root.join("draft")).unwrap(), b"untracked draft");

    fs::write(root.join("file"), "first commit").unwrap();
    checkout("release", false).unwrap();
    assert_eq!(fs::read(root.join("file")).unwrap(), b"release commit");
    let linked = fixture.repo.root.with_file_name("occupied");
    git(root, &["worktree", "add", linked.to_str().unwrap(), "main"]);
    assert!(matches!(
        checkout("main", false),
        Err(BranchError::CheckedOutElsewhere)
    ));
    assert_eq!(git(root, &["branch", "--show-current"]), "release\n");
}

#[test]
fn creates_from_pinned_commit_and_recovers_the_same_checkout() {
    let fixture = Fixture::new();
    let planned = fixture.plan("a", "Task Folder", "feature/task").unwrap();
    let first = git(&fixture.repo.root, &["rev-parse", "HEAD"]);
    fs::write(fixture.repo.root.join("file"), "second commit").unwrap();
    git(&fixture.repo.root, &["commit", "--quiet", "-am", "Second"]);
    fs::write(fixture.repo.root.join("file"), "source edits").unwrap();
    git(
        &fixture.repo.root,
        &["config", "core.logAllRefUpdates", "false"],
    );
    // The branch write completed without a reply. Its operation marker allows
    // continuation even though the repository disables normal reflogs.
    planned
        .ensure_branch(
            &fixture.repo.open().unwrap(),
            branch_ref(&planned.branch).unwrap(),
            gix::hash::ObjectId::from_hex(first.trim().as_bytes()).unwrap(),
        )
        .unwrap();
    assert_eq!(
        fixture.ensure(&planned).unwrap().as_deref(),
        Some("feature/task")
    );
    assert_eq!(git(&planned.directory, &["rev-parse", "HEAD"]), first);
    assert_eq!(
        fs::read_to_string(planned.directory.join("file")).unwrap(),
        "first commit"
    );
    assert_eq!(
        fs::read_to_string(fixture.repo.root.join("file")).unwrap(),
        "source edits"
    );
    let (_, created) = directory::capture(&planned.directory).unwrap();

    // Discard publication only: the original Git command already finished.
    fs::remove_file(
        fixture
            .state
            .join(OPERATIONS_DIR)
            .join(&planned.id)
            .join("ready"),
    )
    .unwrap();
    assert!(planned.inspect(&fixture.state).unwrap().is_none());
    let resumed: Allocation =
        serde_json::from_value(serde_json::to_value(&planned).unwrap()).unwrap();
    assert_eq!(
        fixture.ensure(&resumed).unwrap().as_deref(),
        Some("feature/task")
    );
    directory::open(&planned.directory, &created).unwrap();

    git(&planned.directory, &["branch", "-m", "feature/renamed"]);
    fs::write(planned.directory.join("file"), "worktree edits").unwrap();
    assert_eq!(
        fixture.ensure(&resumed).unwrap().as_deref(),
        Some("feature/renamed")
    );
    assert_eq!(
        fs::read_to_string(planned.directory.join("file")).unwrap(),
        "worktree edits"
    );
    let registered = git(&fixture.repo.root, &["worktree", "list", "--porcelain"]);
    assert_eq!(
        registered
            .lines()
            .filter(|line| line.starts_with("worktree "))
            .count(),
        2
    );
    assert_eq!(
        Repository::discover(&planned.directory).unwrap().unwrap(),
        fixture.repo
    );
    assert_eq!(
        git(&fixture.repo.root, &["config", "core.logAllRefUpdates"]).trim(),
        "false"
    );
}

#[test]
fn resumes_a_git_registration_interrupted_before_recording_it() {
    let fixture = Fixture::new();
    let plan = fixture.plan("a", "Task", "feature/task").unwrap();
    let operation = fixture.state.join(OPERATIONS_DIR).join(&plan.id);
    fs::create_dir_all(&operation).unwrap();
    plan.reserve_destination(&fixture.parent).unwrap();
    let (_, observation) = directory::capture(&plan.directory).unwrap();
    save(&operation.join("directory.json"), &observation).unwrap();
    git(
        &fixture.repo.root,
        &[
            "update-ref",
            "--create-reflog",
            "-m",
            &plan.reflog_message(),
            &format!("refs/heads/{}", plan.branch),
            &plan.base_commit,
            "",
        ],
    );
    git(
        &fixture.repo.root,
        &[
            "worktree",
            "add",
            "--no-checkout",
            "--lock",
            "--reason",
            &plan.reflog_message(),
            plan.directory.to_str().unwrap(),
            &plan.branch,
        ],
    );
    let path = plan.directory.join("file");
    fs::write(&path, "user edits").unwrap();
    assert!(matches!(fixture.ensure(&plan), Err(Error::Unavailable)));
    assert_eq!(fs::read_to_string(&path).unwrap(), "user edits");
    fs::remove_file(&path).unwrap();
    assert_eq!(
        fixture.ensure(&plan).unwrap().as_deref(),
        Some("feature/task")
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "first commit");
    let worktrees = git(&fixture.repo.root, &["worktree", "list", "--porcelain"]);
    assert!(!worktrees.lines().any(|line| line.starts_with("locked")));
}

#[test]
fn rejects_branch_and_directory_conflicts_without_adopting_external_work() {
    let fixture = Fixture::new();
    let existing_branch = fixture.plan("a", "One", "topic").unwrap();
    git(&fixture.repo.root, &["branch", "topic"]);
    assert!(matches!(
        fixture.ensure(&existing_branch),
        Err(Error::BranchConflict)
    ));
    assert!(!existing_branch.directory.exists());
    assert!(matches!(
        fixture.plan("b", "Different", "topic/sub"),
        Err(Error::BranchConflict)
    ));
    git(&fixture.repo.root, &["branch", "other/sub"]);
    assert!(matches!(
        fixture.plan("c", "Different", "other"),
        Err(Error::BranchConflict)
    ));

    let taken_path = fixture.plan("d", "Occupied", "feature/new").unwrap();
    fs::create_dir_all(&taken_path.directory).unwrap();
    fs::write(taken_path.directory.join("sentinel"), "other files").unwrap();
    assert!(matches!(
        fixture.ensure(&taken_path),
        Err(Error::DirectoryConflict)
    ));
    assert_eq!(
        fs::read_to_string(taken_path.directory.join("sentinel")).unwrap(),
        "other files"
    );
    assert!(git(&fixture.repo.root, &["branch", "--list", "feature/new"]).is_empty());
}

#[test]
fn rejects_an_occupied_parent_without_creating_a_branch() {
    let fixture = Fixture::new();
    let plan = fixture.plan("a", "Task", "work/task").unwrap();
    let bucket = plan.directory.parent().unwrap();
    fs::write(bucket, "not a directory").unwrap();
    assert!(matches!(
        fixture.plan("b", "Other", "work/other"),
        Err(Error::DirectoryConflict)
    ));
    assert!(matches!(
        fixture.ensure(&plan),
        Err(Error::DirectoryConflict)
    ));
    assert_eq!(fs::read_to_string(bucket).unwrap(), "not a directory");
    assert!(git(&fixture.repo.root, &["branch", "--list", "work/task"]).is_empty());
}

#[test]
fn concurrent_claims_for_one_branch_publish_only_one_checkout() {
    let fixture = Fixture::new();
    let first = fixture.plan("a", "First", "feature/task").unwrap();
    let second = fixture.plan("b", "Second", "feature/task").unwrap();
    let start = std::sync::Barrier::new(2);
    let (one, two) = std::thread::scope(|threads| {
        let left = threads.spawn(|| {
            start.wait();
            fixture.ensure(&first)
        });
        let right = threads.spawn(|| {
            start.wait();
            fixture.ensure(&second)
        });
        (left.join().unwrap(), right.join().unwrap())
    });
    let loser = match (one, two) {
        (Ok(_), Err(_)) => second,
        (Err(_), Ok(_)) => first,
        other => panic!("exactly one checkout must succeed: {other:?}"),
    };
    assert!(matches!(fixture.ensure(&loser), Err(Error::BranchConflict)));
    assert!(!loser.directory.exists());
    assert_eq!(
        git(&fixture.repo.root, &["worktree", "list", "--porcelain"])
            .lines()
            .filter(|line| line.starts_with("worktree "))
            .count(),
        2
    );
}

#[test]
fn refuses_to_reuse_a_replaced_worktree_directory() {
    let fixture = Fixture::new();
    let planned = fixture.plan("a", "Task", "feature/task").unwrap();
    fixture.ensure(&planned).unwrap();
    let old = planned.directory.with_file_name("moved");
    fs::rename(&planned.directory, &old).unwrap();
    fs::create_dir(&planned.directory).unwrap();
    fs::copy(old.join(".git"), planned.directory.join(".git")).unwrap();
    assert!(planned.inspect(&fixture.state).is_err());
    assert!(fixture.ensure(&planned).is_err());
    assert!(!planned.directory.join("file").exists());
    assert!(old.join("file").exists());
}

#[test]
fn never_publishes_an_interrupted_checkout_without_an_index() {
    let fixture = Fixture::new();
    let planned = fixture.plan("a", "Task", "feature/task").unwrap();
    fixture.ensure(&planned).unwrap();
    let candidate = git::discover(&planned.directory).unwrap();
    fs::remove_file(
        fixture
            .state
            .join(OPERATIONS_DIR)
            .join(&planned.id)
            .join("ready"),
    )
    .unwrap();
    fs::remove_file(candidate.index_path()).unwrap();
    assert!(matches!(fixture.ensure(&planned), Err(Error::Unavailable)));
    assert!(planned.inspect(&fixture.state).unwrap().is_none());
    assert_eq!(
        fs::read_to_string(planned.directory.join("file")).unwrap(),
        "first commit"
    );
}
