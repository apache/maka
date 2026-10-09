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

//! What the context strip over the composer says of the selected task's
//! repository: its current branch, and the lines all its changes add and
//! delete, the comparison the changes panel shows as All changes.
//!
//! [`ChangeSummary`] reads it with [`read_review`] on the background
//! executor, exactly as the panel lists All changes, so the two agree: Git's
//! `--numstat` counts and the untracked files' lines, never a patch. The
//! owner (the window) refreshes it when the panel would read (the task
//! changing, a turn ending, the window coming back to the front) and, while
//! the panel shows All changes itself, hands it the panel's own reads
//! instead ([`ChangeSummary::accept`]) rather than read twice. The last
//! values stay while a read runs. Until it is given a [`GitRunner`] it reads
//! nothing (previews and tests, whose executor takes no real I/O).

use std::sync::Arc;

use gpui_kit::{AppContext as _, Context, SharedString, Task};

use crate::git::{FailureReason, GitRunner, ReviewRead, ReviewScope, read_review};
use crate::panel::ReviewTarget;

/// The strip's facts about a repository.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct ChangeTotals {
    /// The checked-out branch; none when detached.
    pub current_branch: Option<String>,
    /// The changes were read: the counts below are real. A read that
    /// failed past listing the branches knows the branch only.
    pub counted: bool,
    pub files: usize,
    pub additions: u32,
    pub deletions: u32,
}

impl ChangeTotals {
    /// What a read of all changes says, or `None` when it found no
    /// repository to speak of (no folder here, not a repository, no
    /// `git`).
    pub fn of(read: &ReviewRead) -> Option<Self> {
        match read {
            Ok(snapshot) => Some(Self {
                current_branch: snapshot.branches.current_branch.clone(),
                counted: true,
                files: snapshot.files.len(),
                additions: snapshot.additions,
                deletions: snapshot.deletions,
            }),
            Err(failure) => failure.branches.as_ref().map(|branches| Self {
                current_branch: branches.current_branch.clone(),
                ..Self::default()
            }),
        }
    }

    /// Whether there are changes to open.
    pub fn has_changes(&self) -> bool {
        self.counted && self.files > 0
    }
}

/// The selected task's [`ChangeTotals`], kept by the window.
pub struct ChangeSummary {
    git: Option<Arc<dyn GitRunner>>,
    target: Option<ReviewTarget>,
    base_branch: Option<String>,
    totals: Option<ChangeTotals>,
    loading: bool,
    generation: u64,
    _load: Option<Task<()>>,
}

impl std::fmt::Debug for ChangeSummary {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChangeSummary")
            .field("target", &self.target)
            .field("totals", &self.totals)
            .finish_non_exhaustive()
    }
}

impl Default for ChangeSummary {
    fn default() -> Self {
        Self::new()
    }
}

impl ChangeSummary {
    /// A summary that reads nothing until it has a [`GitRunner`].
    pub fn new() -> Self {
        Self {
            git: None,
            target: None,
            base_branch: None,
            totals: None,
            loading: false,
            generation: 0,
            _load: None,
        }
    }

    /// Reads with `git` from now on: the system's `git` in the app, a
    /// fake in tests.
    pub fn set_git_runner(&mut self, git: Arc<dyn GitRunner>) {
        self.git = Some(git);
    }

    /// The task to sum up, with the base branch remembered for it. Another
    /// task starts with nothing; a read in flight for the one before is
    /// dropped. Reading is the owner's call ([`Self::refresh`]).
    pub fn set_target(
        &mut self,
        target: Option<ReviewTarget>,
        base_branch: Option<String>,
        cx: &mut Context<Self>,
    ) {
        if self.target != target {
            self.target = target;
            self.totals = None;
            self.loading = false;
            self.generation += 1;
            self._load = None;
            cx.notify();
        }
        self.base_branch = base_branch;
    }

    /// Compares against `base_branch` from the next read on.
    pub fn set_base_branch(&mut self, base_branch: Option<String>) {
        self.base_branch = base_branch;
    }

    pub fn target(&self) -> Option<&ReviewTarget> {
        self.target.as_ref()
    }

    /// The last values read for the task, kept while the next read runs.
    pub fn totals(&self) -> Option<&ChangeTotals> {
        self.totals.as_ref()
    }

    pub fn is_loading(&self) -> bool {
        self.loading
    }

    /// Reads the task's changes again; on a Host elsewhere there is
    /// nothing to read. Without a [`GitRunner`] it does nothing.
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        let (Some(target), Some(git)) = (&self.target, self.git.clone()) else { return };
        self.generation += 1;
        let Some(workspace) = target.workspace().map(ToOwned::to_owned) else {
            self.totals = None;
            self.loading = false;
            self._load = None;
            cx.notify();
            return;
        };
        let generation = self.generation;
        self.loading = true;
        let base = self.base_branch.clone();
        let read = cx.background_spawn(async move {
            read_review(&workspace, base.as_deref(), &ReviewScope::All, git).await
        });
        self._load = Some(cx.spawn(async move |this, cx| {
            let result = read.await;
            this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                // A remembered base branch that is gone: count against the
                // one Desktop resolves, as the panel does (which also
                // forgets it, once it reads).
                if let Err(failure) = &result
                    && failure.reason == FailureReason::InvalidBaseBranch
                    && this.base_branch.take().is_some()
                {
                    this.refresh(cx);
                    return;
                }
                this.totals = ChangeTotals::of(&result);
                this.loading = false;
                cx.notify();
            })
            .ok();
        }));
    }

    /// The changes panel read all changes of task `session_id`: its
    /// values stand, and a read of this model's own is dropped.
    pub fn accept(
        &mut self,
        session_id: &SharedString,
        totals: Option<ChangeTotals>,
        cx: &mut Context<Self>,
    ) {
        if self.target.as_ref().is_none_or(|target| target.session_id() != session_id) {
            return;
        }
        self.generation += 1;
        self._load = None;
        self.loading = false;
        if self.totals != totals {
            self.totals = totals;
            cx.notify();
        }
    }
}
