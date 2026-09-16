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

const DAY_MS = 24 * 60 * 60 * 1000;

export const STALE_WARNING_MARKER = '<!-- maka-lifecycle:stale-warning -->';
export const STALE_CLOSE_MARKER = '<!-- maka-lifecycle:stale-close -->';
export const STALE_REOPEN_MARKER = '<!-- maka-lifecycle:reopened -->';

export const LIFECYCLE_LABELS = [
  {
    name: 'stale',
    color: 'ededed',
    description: 'No qualifying activity within the lifecycle policy window',
  },
  {
    name: 'pinned',
    color: '0e8a16',
    description: 'Exempt from automated lifecycle management',
  },
];

const POLICY = {
  issue: { inactiveDays: 30, graceDays: 30 },
  pull_request: { inactiveDays: 30, graceDays: 7 },
};

const ISSUE_WARNING = `${STALE_WARNING_MARKER}
This issue has had no human activity for 30 days and has been marked stale. It will be closed in 30 days unless someone comments.

If the issue is still current, please confirm it against the latest \`main\` and add any information that would help move it forward. Assigned issues and issues labelled \`pinned\` are exempt from this policy.`;

const ISSUE_CLOSE = `${STALE_CLOSE_MARKER}
This issue has been closed because it received no human response during the 30-day grace period. This is not a judgement on the value of the report.

If the issue still applies to the latest \`main\`, please comment with updated evidence so a maintainer can reopen it, or open a follow-up issue with the missing information.`;

const PR_WARNING = `${STALE_WARNING_MARKER}
This pull request has had no new commits for 30 days and has been marked stale. It will be closed in 7 days unless a new commit is pushed.

Comments do not reset this timer: only a new commit does. If the pull request is intentionally long-lived, a maintainer can apply the \`pinned\` label.`;

const PR_CLOSE = `${STALE_CLOSE_MARKER}
This pull request has been closed because it received no new commits during the 7-day grace period. This is not a judgement on the merit of the change; it only keeps the review queue aligned with work that is actively in flight.

The branch and review history are preserved. Push a new commit and reopen the pull request whenever the work is ready to continue.`;

function time(value, field) {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new TypeError(`${field} must be an ISO timestamp`);
  return result;
}

function isBot(comment) {
  return (
    comment.author?.__typename === 'Bot' ||
    String(comment.author?.login ?? '') === 'github-actions[bot]'
  );
}

function latestTimestamp(values, fallback, field) {
  return values.reduce((latest, value) => Math.max(latest, time(value, field)), fallback);
}

function issueActivityAt(item) {
  const createdAt = time(item.createdAt, 'createdAt');
  const qualifyingComments = (item.comments ?? [])
    .filter(
      (comment) => !isBot(comment) || String(comment.body ?? '').includes(STALE_REOPEN_MARKER),
    )
    .map((comment) => comment.createdAt);
  return latestTimestamp(qualifyingComments, createdAt, 'comment.createdAt');
}

function pullRequestActivityAt(item) {
  return time(item.lastCommitAt ?? item.createdAt, 'lastCommitAt');
}

function latestWarningAt(item) {
  const warnings = (item.comments ?? [])
    .filter(
      (comment) => isBot(comment) && String(comment.body ?? '').includes(STALE_WARNING_MARKER),
    )
    .map((comment) => comment.createdAt);
  return warnings.length === 0
    ? undefined
    : latestTimestamp(warnings, Number.NEGATIVE_INFINITY, 'comment.createdAt');
}

function atLeastDaysBetween(later, earlier, days) {
  return later - earlier >= days * DAY_MS;
}

/**
 * Decide one lifecycle transition without performing GitHub API writes.
 *
 * Issues use their creation or latest non-bot comment as activity and are
 * exempt while assigned. Pull requests use only their latest commit. Both are
 * exempt when pinned, and grace starts at this workflow's latest warning.
 *
 * @param {{
 *   kind: 'issue' | 'pull_request',
 *   createdAt: string,
 *   lastCommitAt?: string,
 *   labels?: string[],
 *   assigneeCount?: number,
 *   comments?: Array<{createdAt: string, body?: string, author?: {__typename?: string, login?: string}}>,
 * }} item
 * @param {string | Date} [now]
 */
export function planLifecycle(item, now = new Date()) {
  const policy = POLICY[item.kind];
  if (!policy) throw new TypeError(`unsupported lifecycle item kind: ${item.kind}`);

  const nowAt = now instanceof Date ? now.getTime() : time(now, 'now');
  if (!Number.isFinite(nowAt)) throw new TypeError('now must be a valid date');

  const labels = new Set(item.labels ?? []);
  const isStale = labels.has('stale');
  const exempt = labels.has('pinned') || (item.kind === 'issue' && (item.assigneeCount ?? 0) > 0);

  if (exempt) {
    return {
      action: isStale ? 'unstale' : 'none',
      reason: labels.has('pinned') ? 'pinned' : 'assigned',
    };
  }

  const activityAt = item.kind === 'issue' ? issueActivityAt(item) : pullRequestActivityAt(item);
  const warningAt = latestWarningAt(item);

  if (isStale) {
    if (warningAt === undefined) {
      return { action: 'warn', message: item.kind === 'issue' ? ISSUE_WARNING : PR_WARNING };
    }

    if (activityAt > warningAt) {
      return { action: 'unstale', reason: 'qualifying activity after warning' };
    }

    if (atLeastDaysBetween(nowAt, warningAt, policy.graceDays)) {
      return { action: 'close', message: item.kind === 'issue' ? ISSUE_CLOSE : PR_CLOSE };
    }

    return { action: 'none', reason: 'within grace period' };
  }

  if (atLeastDaysBetween(nowAt, activityAt, policy.inactiveDays)) {
    return { action: 'warn', message: item.kind === 'issue' ? ISSUE_WARNING : PR_WARNING };
  }

  return { action: 'none', reason: 'recent qualifying activity' };
}
