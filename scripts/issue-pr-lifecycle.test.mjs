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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { planLifecycle, STALE_REOPEN_MARKER, STALE_WARNING_MARKER } from './issue-pr-lifecycle.mjs';

const NOW = '2026-09-01T12:00:00.000Z';

function daysAgo(days) {
  return new Date(Date.parse(NOW) - days * 24 * 60 * 60 * 1000).toISOString();
}

function humanComment(days, body = 'Still relevant') {
  return {
    createdAt: daysAgo(days),
    body,
    author: { __typename: 'User', login: 'contributor' },
  };
}

function botComment(days, body = 'Automated note') {
  return {
    createdAt: daysAgo(days),
    body,
    author: { __typename: 'Bot', login: 'github-actions[bot]' },
  };
}

function warning(days) {
  return botComment(days, STALE_WARNING_MARKER);
}

function issue(overrides = {}) {
  return {
    kind: 'issue',
    createdAt: daysAgo(60),
    labels: [],
    assigneeCount: 0,
    comments: [],
    ...overrides,
  };
}

function pullRequest(overrides = {}) {
  return {
    kind: 'pull_request',
    createdAt: daysAgo(60),
    lastCommitAt: daysAgo(60),
    labels: [],
    comments: [],
    ...overrides,
  };
}

describe('issue lifecycle', () => {
  it('warns at the 30-day inactivity boundary', () => {
    assert.equal(planLifecycle(issue({ createdAt: daysAgo(30) }), NOW).action, 'warn');
    assert.equal(planLifecycle(issue({ createdAt: daysAgo(29) }), NOW).action, 'none');
  });

  it('uses the latest human comment as activity', () => {
    const plan = planLifecycle(issue({ comments: [humanComment(10)] }), NOW);
    assert.deepEqual(plan, { action: 'none', reason: 'recent qualifying activity' });
  });

  it('ignores bot comments when measuring activity', () => {
    const plan = planLifecycle(issue({ comments: [botComment(1)] }), NOW);
    assert.equal(plan.action, 'warn');
  });

  it('treats a lifecycle reopen marker as a fresh activity timestamp', () => {
    const plan = planLifecycle(issue({ comments: [botComment(2, STALE_REOPEN_MARKER)] }), NOW);
    assert.deepEqual(plan, { action: 'none', reason: 'recent qualifying activity' });
  });

  it('closes only after the full 30-day grace period', () => {
    const pending = issue({ labels: ['stale'], comments: [warning(29)] });
    const expired = issue({ labels: ['stale'], comments: [warning(30)] });
    assert.deepEqual(planLifecycle(pending, NOW), {
      action: 'none',
      reason: 'within grace period',
    });
    assert.equal(planLifecycle(expired, NOW).action, 'close');
  });

  it('removes stale after a human response to the warning', () => {
    const plan = planLifecycle(
      issue({ labels: ['stale'], comments: [warning(20), humanComment(2)] }),
      NOW,
    );
    assert.deepEqual(plan, {
      action: 'unstale',
      reason: 'qualifying activity after warning',
    });
  });

  it('exempts assigned issues and removes an existing stale label', () => {
    assert.deepEqual(planLifecycle(issue({ assigneeCount: 1 }), NOW), {
      action: 'none',
      reason: 'assigned',
    });
    assert.deepEqual(planLifecycle(issue({ assigneeCount: 1, labels: ['stale'] }), NOW), {
      action: 'unstale',
      reason: 'assigned',
    });
  });
});

describe('pull request lifecycle', () => {
  it('warns based on the latest commit instead of creation or comments', () => {
    const active = pullRequest({ lastCommitAt: daysAgo(5) });
    const inactive = pullRequest({
      lastCommitAt: daysAgo(30),
      comments: [humanComment(1)],
    });
    assert.equal(planLifecycle(active, NOW).action, 'none');
    assert.equal(planLifecycle(inactive, NOW).action, 'warn');
  });

  it('closes after seven days without a new commit', () => {
    const plan = planLifecycle(
      pullRequest({ labels: ['stale'], comments: [warning(7), humanComment(1)] }),
      NOW,
    );
    assert.equal(plan.action, 'close');
  });

  it('removes stale after a commit newer than the warning', () => {
    const plan = planLifecycle(
      pullRequest({ labels: ['stale'], comments: [warning(7)], lastCommitAt: daysAgo(1) }),
      NOW,
    );
    assert.deepEqual(plan, {
      action: 'unstale',
      reason: 'qualifying activity after warning',
    });
  });

  it('ignores a lifecycle reopen marker for PR activity timing', () => {
    const plan = planLifecycle(
      pullRequest({ comments: [botComment(2, STALE_REOPEN_MARKER)] }),
      NOW,
    );
    assert.equal(plan.action, 'warn');
  });

  it('still finds human activity when more than 100 comments are present', () => {
    const comments = [
      humanComment(1),
      ...Array.from({ length: 100 }, (_, index) => botComment(index + 2)),
    ];
    assert.deepEqual(planLifecycle(issue({ comments }), NOW), {
      action: 'none',
      reason: 'recent qualifying activity',
    });
  });
});

describe('state repair and exemptions', () => {
  it('starts a fresh grace period when stale has no workflow warning', () => {
    const plan = planLifecycle(issue({ labels: ['stale'] }), NOW);
    assert.equal(plan.action, 'warn');
    assert.match(plan.message, new RegExp(STALE_WARNING_MARKER));
  });

  it('does not trust a human-authored warning marker', () => {
    const plan = planLifecycle(
      issue({ labels: ['stale'], comments: [humanComment(40, STALE_WARNING_MARKER)] }),
      NOW,
    );
    assert.equal(plan.action, 'warn');
  });

  it('exempts pinned issues and pull requests', () => {
    assert.deepEqual(planLifecycle(issue({ labels: ['pinned', 'stale'] }), NOW), {
      action: 'unstale',
      reason: 'pinned',
    });
    assert.deepEqual(planLifecycle(pullRequest({ labels: ['pinned'] }), NOW), {
      action: 'none',
      reason: 'pinned',
    });
  });
});
