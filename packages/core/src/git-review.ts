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

export interface GitReviewSnapshot {
  source: GitReviewSource;
  repositoryRoot: string;
  currentBranch: string | null;
  baseBranch: string | null;
  baseBranchOptions: string[];
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
      reason:
        | 'workspace_unavailable'
        | 'not_git_repository'
        | 'unborn_repository'
        | 'invalid_base_branch'
        | 'git_failed';
    };

export type GitReviewMutationAction = 'stage' | 'unstage' | 'revert';

export type GitReviewMutationResult =
  | { ok: true; review: GitReviewReadResult }
  | {
      ok: false;
      reason: 'stale_snapshot' | 'path_not_found' | 'git_failed';
    };
