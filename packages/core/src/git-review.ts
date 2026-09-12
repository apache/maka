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

export type GitReviewSource = 'branch' | 'unstaged' | 'staged';

export type GitReviewFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'unknown';

export interface GitReviewFile {
  path: string;
  previousPath?: string;
  status: GitReviewFileStatus;
  diff: string;
  additions: number;
  deletions: number;
}

export interface GitReviewBaseBranchOption {
  label: string;
  /** Fully qualified branch ref, never a tag or an ambiguous revision. */
  value: string;
}

export interface GitReviewBranchContext {
  currentBranch: string | null;
  baseBranchOptions: GitReviewBaseBranchOption[];
}

export interface GitReviewSnapshot extends GitReviewBranchContext {
  source: GitReviewSource;
  repositoryRoot: string;
  baseBranch: string | null;
  revision: string;
  files: GitReviewFile[];
  additions: number;
  deletions: number;
  truncated: boolean;
}

export type GitReviewReadResult =
  | { ok: true; snapshot: GitReviewSnapshot }
  | {
      ok: false;
      /** Available even when computing the selected branch diff fails. */
      branches?: GitReviewBranchContext;
      reason:
        | 'workspace_unavailable'
        | 'not_git_repository'
        | 'unborn_repository'
        | 'invalid_base_branch'
        | 'git_failed';
    };
