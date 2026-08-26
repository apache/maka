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

// Projects a pull request's own facts onto two independent label axes so the
// list view answers "whose move is it" and "how much reading is this" without
// opening anything. The labels are a projection: branch protection stays the
// only merge authority, and nothing here grants or withholds it.

export const STATUS_LABELS = [
  'status/waiting-infra',
  'status/needs-author',
  'status/review-ready',
  'status/merge-ready',
];

export const EFFORT_LABELS = ['effort/S', 'effort/M', 'effort/XL'];

// Reviewing carries write access on this repository, and GitHub reports the
// association per review, so committer standing needs no separate roster that
// could drift out of date.
const COMMITTER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

// Counted changes should track what a human actually reads. Lockfiles,
// regenerated artifacts and binaries are verified by their own contracts, so
// letting their line counts reach the effort tiers would inflate every pull
// request that happens to touch one.
const UNREAD_PATTERNS = [
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/,
  /(^|\/)THIRD_PARTY_NOTICES[^/]*$/,
  /\.generated\.[cm]?[jt]sx?$/,
  /\.snapshot\.json$/,
  /\.min\.(js|css)$/,
  /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|sqlite|zip|gz|pdf)$/,
];

// Only two decisions need a boundary: whether a reviewer can clear this
// between other work, and whether it is too large to read as one unit at all.
const EFFORT_TIERS = [
  { label: 'effort/S', maxLines: 100 },
  { label: 'effort/M', maxLines: 1000 },
  { label: 'effort/XL', maxLines: Number.POSITIVE_INFINITY },
];

export function isUnreadPath(path) {
  const normalized = String(path).replace(/\\/g, '/');
  return UNREAD_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * @param {Array<{filename: string, additions?: number, deletions?: number}>} files
 */
export function countReadableLines(files = []) {
  return files.reduce((total, file) => {
    if (isUnreadPath(file.filename)) return total;
    return total + (file.additions ?? 0) + (file.deletions ?? 0);
  }, 0);
}

export function classifyEffort(files = []) {
  const lines = countReadableLines(files);
  const tier = EFFORT_TIERS.find((candidate) => lines <= candidate.maxLines);
  return { label: tier.label, lines };
}

/**
 * Collapses check runs into the one fact that changes what happens next.
 *
 * `action_required` is the fork approval gate: the run exists but no maintainer
 * has released it, so the contributor cannot act and the stall is not theirs.
 * `cancelled` is concurrency superseding a run rather than a verdict, so it
 * never counts as red on its own.
 *
 * @param {Array<{status?: string, conclusion?: string, state?: string}>} checks
 */
export function classifyChecks(checks = []) {
  if (checks.length === 0) return 'infra';

  let sawGate = false;
  let sawFailure = false;
  let sawPending = false;
  let sawConclusive = false;

  for (const check of checks) {
    const conclusion = String(check.conclusion ?? check.state ?? '').toLowerCase();
    const status = String(check.status ?? '').toLowerCase();

    if (conclusion === 'action_required') {
      sawGate = true;
      continue;
    }
    if (conclusion === 'failure' || conclusion === 'timed_out') {
      sawFailure = true;
      continue;
    }
    if (conclusion === 'cancelled') continue;

    if (!conclusion || status === 'queued' || status === 'in_progress' || status === 'pending') {
      sawPending = true;
      continue;
    }

    sawConclusive = true;
  }

  // The gate outranks a sibling failure. While any run is still held, the
  // author cannot obtain a complete verdict however much they fix, so the
  // outstanding move is the maintainer's and the label should say so.
  if (sawGate) return 'infra';
  if (sawFailure) return 'red';
  if (sawPending) return 'pending';

  // Every run was cancelled: nothing was verified and nothing failed, so this
  // is the same "no verdict yet" as pending rather than a reason to move the
  // pull request onto either queue.
  return sawConclusive ? 'green' : 'pending';
}

/**
 * Reduces the review history to the two facts that move a pull request between
 * queues, so both are read off one pass and cannot disagree.
 *
 * The two are deliberately asymmetric. An approval speaks only for the tree it
 * was given on, so a new push retires it even where the repository has not
 * enabled stale-review dismissal. A request for changes is not retired by a
 * push — otherwise pushing anything at all would clear the block — and stands
 * until that reviewer says something else.
 *
 * @param {Array<{user?: {login?: string}, state?: string, commit_id?: string,
 *   author_association?: string}>} reviews
 */
export function summarizeReviews(reviews = [], headSha, authorLogin) {
  const latestByReviewer = new Map();

  for (const review of reviews) {
    const state = String(review.state ?? '').toUpperCase();
    // COMMENTED and PENDING state no position, so they neither establish nor
    // withdraw one.
    if (state !== 'APPROVED' && state !== 'CHANGES_REQUESTED' && state !== 'DISMISSED') continue;

    const login = review.user?.login;
    if (!login || login === authorLogin) continue;

    // Reviews arrive in submission order, so a later entry is this reviewer's
    // current position and replaces whatever they said before.
    latestByReviewer.set(login, review);
  }

  let changesRequested = false;
  let committerApprovalOnHead = false;

  for (const review of latestByReviewer.values()) {
    const state = String(review.state).toUpperCase();

    if (state === 'CHANGES_REQUESTED') {
      changesRequested = true;
      continue;
    }

    if (state !== 'APPROVED') continue;
    if (review.commit_id !== headSha) continue;
    if (!COMMITTER_ASSOCIATIONS.has(String(review.author_association ?? '').toUpperCase()))
      continue;

    committerApprovalOnHead = true;
  }

  return { changesRequested, committerApprovalOnHead };
}

/**
 * @param {{isDraft?: boolean, headSha?: string, authorLogin?: string,
 *   checks?: Array<object>, reviews?: Array<object>}} pull
 */
export function classifyStatus(pull) {
  // Draft is the author's own statement that this is not up for review yet. A
  // check result is a different fact and must not overwrite that statement.
  if (pull.isDraft) return null;

  const { changesRequested, committerApprovalOnHead } = summarizeReviews(
    pull.reviews,
    pull.headSha,
    pull.authorLogin,
  );

  if (changesRequested) return 'status/needs-author';

  const checks = classifyChecks(pull.checks);
  if (checks === 'infra') return 'status/waiting-infra';
  if (checks === 'red') return 'status/needs-author';
  if (checks === 'pending') return null;

  return committerApprovalOnHead ? 'status/merge-ready' : 'status/review-ready';
}

/**
 * @param {object} pull
 * @param {string[]} currentLabels
 */
export function planLabels(pull, currentLabels = []) {
  const status = classifyStatus(pull);
  const effort = pull.isDraft ? null : classifyEffort(pull.files).label;
  const desired = new Set([status, effort].filter(Boolean));
  const current = new Set(currentLabels);
  const managed = [...STATUS_LABELS, ...EFFORT_LABELS];

  return {
    status,
    effort,
    addLabels: [...desired].filter((label) => !current.has(label)),
    removeLabels: managed.filter((label) => current.has(label) && !desired.has(label)),
  };
}
