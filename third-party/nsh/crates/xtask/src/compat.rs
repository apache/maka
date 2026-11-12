//! `cargo xtask compat`: holds this checkout to what NSH's releases froze.
//! The record and its checks live in their own repository,
//! `longbridge/nsh-compat`, so no change here can rewrite them
//! (docs/dev/compatibility.md). It is checked out into `target/nsh-compat/`
//! next to a link to this checkout (`target/nsh-compat/nsh`), the `../nsh`
//! its crates depend on, and run with this checkout's `nsh` and Cargo
//! cache: the apps of `tests/compat/` built and run, and every recorded
//! release still offered and its apps still running.
//!
//! `record <version>` records this checkout as a release in that checkout
//! of `nsh-compat`, to commit there.

use std::{
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::Context as _;

use crate::{android::root, term};

/// Where the repository is cloned from.
const REPOSITORY: &str = "https://github.com/longbridge/nsh-compat.git";

pub(crate) fn compat(record: Option<&str>) -> anyhow::Result<()> {
    let root = root();
    let repo = checkout(&root)?;
    term::cargo(
        Command::new("cargo")
            .current_dir(&root)
            .args(["build", "-p", "nsh-cli"]),
        "nsh",
    )?;
    // The versions this checkout builds with, so the Cargo cache serves
    // both.
    std::fs::copy(root.join("Cargo.lock"), repo.join("Cargo.lock"))
        .context("copy Cargo.lock to nsh-compat")?;
    let mut cargo = Command::new("cargo");
    cargo.current_dir(&repo);
    cargo.arg(if record.is_some() { "run" } else { "test" });
    // Cargo's own option, so before `run`'s `--`.
    cargo.arg("--target-dir").arg(root.join("target"));
    // The cases use shaders and EmojiPicker, both opt-in runtime features.
    cargo.args(["--features", "nsh-core/shader,nsh-base/emoji-picker"]);
    if let Some(version) = record {
        cargo.args(["--", "record", version]);
    }
    term::run(&mut cargo)?;
    match record {
        None => term::done("compatible with every recorded release"),
        Some(version) => term::done(format!(
            "recorded v{} in {}: commit it there and open a pull request",
            version.trim_start_matches('v'),
            repo.display()
        )),
    }
    Ok(())
}

/// `target/nsh-compat/nsh-compat`, cloned or brought up to date (left as
/// it is when it has changes of its own, being worked on), with
/// `target/nsh-compat/nsh` linked to `root`.
fn checkout(root: &Path) -> anyhow::Result<PathBuf> {
    let dir = root.join("target/nsh-compat");
    std::fs::create_dir_all(&dir)?;
    let repo = dir.join("nsh-compat");
    if repo.join(".git").exists() {
        let status = Command::new("git")
            .current_dir(&repo)
            .args(["status", "--porcelain"])
            .output()
            .context("git status")?;
        if status.stdout.is_empty() {
            term::run(Command::new("git").current_dir(&repo).args([
                "pull",
                "--ff-only",
                "--quiet",
            ]))?;
        } else {
            term::warn(format!("{} has changes: used as it is", repo.display()));
        }
    } else {
        term::run(
            Command::new("git")
                .args(["clone", "--quiet", REPOSITORY])
                .arg(&repo),
        )?;
    }
    let link = dir.join("nsh");
    let _ = std::fs::remove_file(&link);
    let _ = std::fs::remove_dir(&link);
    let root = std::fs::canonicalize(root)?;
    #[cfg(unix)]
    std::os::unix::fs::symlink(&root, &link)?;
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(&root, &link).context(
        "link target/nsh-compat/nsh to this checkout (Windows needs Developer Mode for links)",
    )?;
    Ok(repo)
}
