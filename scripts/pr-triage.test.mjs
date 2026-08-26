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

import {
  classifyChecks,
  classifyEffort,
  classifyStatus,
  countReadableLines,
  summarizeReviews,
  planLabels,
} from './pr-triage.mjs';

const HEAD = 'abc123';

function pull(overrides = {}) {
  return {
    isDraft: false,
    headSha: HEAD,
    authorLogin: 'contributor',
    checks: [{ status: 'completed', conclusion: 'success' }],
    reviews: [],
    files: [{ filename: 'packages/core/src/index.ts', additions: 5, deletions: 1 }],
    ...overrides,
  };
}

function approval(overrides = {}) {
  return {
    user: { login: 'committer' },
    state: 'APPROVED',
    commit_id: HEAD,
    author_association: 'MEMBER',
    ...overrides,
  };
}

describe('classifyChecks', () => {
  it('reads a fork PR awaiting workflow approval as infrastructure, not author fault', () => {
    assert.equal(classifyChecks([{ status: 'completed', conclusion: 'action_required' }]), 'infra');
  });

  it('reads no checks at all as infrastructure', () => {
    assert.equal(classifyChecks([]), 'infra');
  });

  it('reports red only for a conclusive failure', () => {
    assert.equal(classifyChecks([{ conclusion: 'success' }, { conclusion: 'failure' }]), 'red');
    assert.equal(classifyChecks([{ conclusion: 'timed_out' }]), 'red');
  });

  it('does not treat a superseded run as a verdict', () => {
    assert.equal(classifyChecks([{ conclusion: 'cancelled' }, { conclusion: 'success' }]), 'green');
    assert.equal(classifyChecks([{ conclusion: 'cancelled' }]), 'pending');
  });

  it('holds while any run is still going', () => {
    assert.equal(classifyChecks([{ conclusion: 'success' }, { status: 'in_progress' }]), 'pending');
  });

  it('prefers the fork gate over a sibling failure, since the author cannot act either way', () => {
    assert.equal(
      classifyChecks([{ conclusion: 'failure' }, { conclusion: 'action_required' }]),
      'infra',
    );
  });
});

describe('countReadableLines', () => {
  it('excludes lockfiles, generated artifacts and binaries', () => {
    const files = [
      { filename: 'packages/cli/src/main.ts', additions: 20, deletions: 4 },
      { filename: 'pnpm-lock.yaml', additions: 9000, deletions: 8000 },
      { filename: 'packages/core/src/model-metadata.generated.ts', additions: 5000, deletions: 0 },
      {
        filename: 'scripts/model-metadata/models-dev-api.snapshot.json',
        additions: 4000,
        deletions: 0,
      },
      { filename: 'apps/desktop/build/background@2x.png', additions: 1, deletions: 0 },
      {
        filename: 'apps/desktop/resources/licenses/npm/THIRD_PARTY_NOTICES.txt',
        additions: 900,
        deletions: 0,
      },
    ];
    assert.equal(countReadableLines(files), 24);
  });

  it('does not discount test code, which still has to be reviewed', () => {
    const files = [
      { filename: 'packages/core/test/session.test.ts', additions: 300, deletions: 0 },
    ];
    assert.equal(countReadableLines(files), 300);
  });
});

describe('classifyEffort', () => {
  it('places each tier on its boundary', () => {
    assert.equal(
      classifyEffort([{ filename: 'a.ts', additions: 100, deletions: 0 }]).label,
      'effort/S',
    );
    assert.equal(
      classifyEffort([{ filename: 'a.ts', additions: 101, deletions: 0 }]).label,
      'effort/M',
    );
    assert.equal(
      classifyEffort([{ filename: 'a.ts', additions: 1000, deletions: 0 }]).label,
      'effort/M',
    );
    assert.equal(
      classifyEffort([{ filename: 'a.ts', additions: 1001, deletions: 0 }]).label,
      'effort/XL',
    );
  });

  it('keeps a lockfile-only change small', () => {
    assert.equal(
      classifyEffort([{ filename: 'pnpm-lock.yaml', additions: 5000, deletions: 4000 }]).label,
      'effort/S',
    );
  });
});

describe('summarizeReviews', () => {
  it('accepts a committer approval on the current head', () => {
    assert.equal(summarizeReviews([approval()], HEAD, 'contributor').committerApprovalOnHead, true);
  });

  it('rejects an approval left on a superseded commit', () => {
    assert.equal(
      summarizeReviews([approval({ commit_id: 'stale' })], HEAD, 'contributor')
        .committerApprovalOnHead,
      false,
    );
  });

  it('rejects an approval from someone without write access', () => {
    assert.equal(
      summarizeReviews([approval({ author_association: 'CONTRIBUTOR' })], HEAD, 'contributor')
        .committerApprovalOnHead,
      false,
    );
  });

  it('rejects the author approving their own pull request', () => {
    assert.equal(
      summarizeReviews([approval({ user: { login: 'contributor' } })], HEAD, 'contributor')
        .committerApprovalOnHead,
      false,
    );
  });

  it("counts only each reviewer's latest position", () => {
    const reviews = [approval(), approval({ state: 'CHANGES_REQUESTED' })];
    assert.equal(summarizeReviews(reviews, HEAD, 'contributor').committerApprovalOnHead, false);

    const reconsidered = [approval({ state: 'CHANGES_REQUESTED' }), approval()];
    assert.equal(summarizeReviews(reconsidered, HEAD, 'contributor').committerApprovalOnHead, true);
  });

  it('still finds an approval when another reviewer is undecided', () => {
    const reviews = [approval({ user: { login: 'other' }, state: 'COMMENTED' }), approval()];
    assert.equal(summarizeReviews(reviews, HEAD, 'contributor').committerApprovalOnHead, true);
  });
});

describe('classifyStatus', () => {
  it("leaves a draft unlabelled rather than overriding the author's own statement", () => {
    assert.equal(
      classifyStatus(pull({ isDraft: true, checks: [{ conclusion: 'failure' }] })),
      null,
    );
  });

  it('moves a requested change back to the author', () => {
    const reviews = [approval({ state: 'CHANGES_REQUESTED' })];
    assert.equal(classifyStatus(pull({ reviews })), 'status/needs-author');
  });

  it('keeps a requested change in force across a later push', () => {
    const reviews = [approval({ state: 'CHANGES_REQUESTED', commit_id: 'older' })];
    assert.equal(classifyStatus(pull({ reviews })), 'status/needs-author');
  });

  it('blames the author only for a conclusive failure', () => {
    assert.equal(
      classifyStatus(pull({ checks: [{ conclusion: 'failure' }] })),
      'status/needs-author',
    );
  });

  it('surfaces a stalled fork run as waiting on infrastructure', () => {
    assert.equal(
      classifyStatus(pull({ checks: [{ conclusion: 'action_required' }] })),
      'status/waiting-infra',
    );
  });

  it('holds off entirely while checks are still running', () => {
    assert.equal(classifyStatus(pull({ checks: [{ status: 'in_progress' }] })), null);
  });

  it('queues a green pull request for review', () => {
    assert.equal(classifyStatus(pull()), 'status/review-ready');
  });

  it('marks a green pull request with a current committer approval as mergeable', () => {
    assert.equal(classifyStatus(pull({ reviews: [approval()] })), 'status/merge-ready');
  });

  it('drops back to review-ready once a new push invalidates the approval', () => {
    const pushed = pull({ headSha: 'def456', reviews: [approval()] });
    assert.equal(classifyStatus(pushed), 'status/review-ready');
  });
});

describe('planLabels', () => {
  it('adds the projected pair and removes nothing it does not own', () => {
    const plan = planLabels(pull(), ['bug']);
    assert.deepEqual(plan.addLabels.sort(), ['effort/S', 'status/review-ready']);
    assert.deepEqual(plan.removeLabels, []);
  });

  it('replaces a superseded status without touching the effort label', () => {
    const plan = planLabels(pull({ reviews: [approval()] }), ['status/review-ready', 'effort/S']);
    assert.deepEqual(plan.addLabels, ['status/merge-ready']);
    assert.deepEqual(plan.removeLabels, ['status/review-ready']);
  });

  it('clears its own labels from a pull request that went back to draft', () => {
    const plan = planLabels(pull({ isDraft: true }), ['status/review-ready', 'effort/M', 'bug']);
    assert.deepEqual(plan.addLabels, []);
    assert.deepEqual(plan.removeLabels.sort(), ['effort/M', 'status/review-ready']);
  });

  it('is idempotent once the labels already match', () => {
    const plan = planLabels(pull(), ['status/review-ready', 'effort/S']);
    assert.deepEqual(plan.addLabels, []);
    assert.deepEqual(plan.removeLabels, []);
  });
});
