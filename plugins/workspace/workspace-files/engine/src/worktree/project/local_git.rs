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

use super::{Error, Repository, Result, branch_occupied, branch_ref, interrupted};
use crate::directory;
use std::{
    env, io,
    path::PathBuf,
    process::{Command, Output},
    sync::atomic::AtomicBool,
};

#[derive(Debug)]
pub enum BranchError {
    Project(Error),
    AlreadyExists,
    CheckedOutElsewhere,
    OverwritesChanges,
}

impl From<Error> for BranchError {
    fn from(error: Error) -> Self {
        Self::Project(error)
    }
}

impl Repository {
    pub fn checkout_branch(
        &self,
        identity: &directory::Observation,
        branch: &str,
        create: bool,
        cancel: &AtomicBool,
    ) -> std::result::Result<(), BranchError> {
        interrupted(cancel).map_err(Error::from)?;
        let reference = branch_ref(branch)?;
        let repo = self.open_source(&self.root, identity)?;
        if create {
            if branch_occupied(&repo, &reference)? {
                return Err(BranchError::AlreadyExists);
            }
        } else if repo
            .try_find_reference(reference.as_ref())
            .map_err(io::Error::other)
            .map_err(Error::from)?
            .is_none()
        {
            return Err(Error::BaseUnavailable.into());
        }

        let mut git = command(&repo)?;
        git.args([
            "switch",
            "--quiet",
            "--no-guess",
            "--no-overwrite-ignore",
            "--no-recurse-submodules",
        ]);
        if create {
            git.args(["--create", branch]);
        } else {
            git.args(["--", branch]);
        }
        interrupted(cancel).map_err(Error::from)?;
        let output = run(&mut git)?;
        if output.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("would be overwritten") {
            Err(BranchError::OverwritesChanges)
        } else if stderr.contains("already checked out")
            || stderr.contains("already used by worktree")
        {
            Err(BranchError::CheckedOutElsewhere)
        } else if create && branch_occupied(&repo, &reference)? {
            Err(BranchError::AlreadyExists)
        } else {
            Err(Error::Io(git_error(&output)).into())
        }
    }
}

pub(super) fn command(repo: &gix::Repository) -> Result<Command> {
    let config = repo.config_snapshot();
    let config = config.plumbing();
    // Isolated gix discovery does not load includes. Git's write path must not
    // discover extra filters, hooks or helpers through those includes.
    if ["filter", "include", "includeIf"]
        .into_iter()
        .any(|section| config.sections_by_name(section).is_some())
    {
        return Err(Error::Unsupported);
    }
    let root = dunce::simplified(repo.workdir().ok_or(Error::Unavailable)?);
    let search_path = env::var_os("PATH").unwrap_or_default();
    let executable = env::split_paths(&search_path)
        .filter(|path| path.is_absolute())
        .map(|dir| dir.join(if cfg!(windows) { "git.exe" } else { "git" }))
        .find(|path| path.is_file())
        .or_else(|| {
            let system = PathBuf::from("/usr/bin/git");
            (cfg!(target_os = "macos") && system.is_file()).then_some(system)
        })
        .ok_or(Error::GitRequired)?;
    let device = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let mut git = Command::new(executable);
    git.current_dir(root)
        .env_clear()
        .env("LC_ALL", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", device)
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env("GIT_ALLOW_PROTOCOL", "")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .arg("--git-dir")
        .arg(dunce::simplified(repo.git_dir()))
        .arg("--work-tree")
        .arg(root)
        .args([
            "-c",
            &format!("core.hooksPath={device}"),
            "-c",
            &format!("core.attributesFile={device}"),
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.splitIndex=false",
            "-c",
            "submodule.recurse=false",
            "-c",
            "maintenance.auto=false",
            "-c",
            "gc.auto=0",
            "-c",
            "user.name=Maka",
            "-c",
            "user.email=host@maka.invalid",
        ]);
    Ok(git)
}

pub(super) fn run(git: &mut Command) -> Result<Output> {
    git.output().map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            Error::GitRequired
        } else {
            Error::Io(error)
        }
    })
}

pub(super) fn checked(git: &mut Command) -> Result<()> {
    let output = run(git)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(git_error(&output).into())
    }
}

pub(super) fn git_error(output: &Output) -> io::Error {
    io::Error::other(format!(
        "git {}: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr).trim(),
    ))
}
