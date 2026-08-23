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

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  LOCAL_MEMORY_MAX_BYTES,
  LOCAL_MEMORY_PROMPT_TRUNCATION_MARKER,
  appendApprovedLocalMemoryEntryDraft,
  appendLocalMemoryProposalDraft,
  appendManualLocalMemoryEntryDraft,
  approveLocalMemoryProposalDraft,
  buildLocalMemoryPromptBody,
  defaultLocalMemoryMarkdown,
  defaultLocalMemorySettings,
  findLocalMemoryEntryDraft,
  normalizeLocalMemorySettings,
  parseLocalMemoryMarkdown,
  rejectLocalMemoryProposalDraft,
  setLocalMemoryEntryStatusDraft,
  stableLocalMemoryEntryId,
  stableLocalMemoryIdMaterial,
  stableLocalMemoryProposalId,
  type Sha256Digest,
} from '../local-memory.js';

const nodeSha256: Sha256Digest = {
  digest(input: string): Uint8Array {
    return new Uint8Array(createHash('sha256').update(input, 'utf8').digest());
  },
};

describe('local MEMORY.md contract', () => {
  it('defaults file enabled but agent read disabled', () => {
    const settings = defaultLocalMemorySettings();
    assert.equal(settings.enabled, true);
    assert.equal(settings.agentReadEnabled, false);
  });

  it('normalizes malformed settings fail-closed for agent reads', () => {
    assert.deepEqual(normalizeLocalMemorySettings(null), {
      enabled: true,
      agentReadEnabled: false,
    });
    assert.deepEqual(normalizeLocalMemorySettings({ enabled: false, agentReadEnabled: 'yes' }), {
      enabled: false,
      agentReadEnabled: false,
    });
  });

  it('treats only the first metadata comment in a section as authoritative', () => {
    const parsed = parseLocalMemoryMarkdown(
      [
        '# Maka Memory',
        '',
        '## Canonical preference',
        '<!-- maka-memory: id=canonical status=active scope=workspace -->',
        'Keep this entry active.',
        '<!-- maka-memory: id=shadow status=archived scope=session sessionId=other-session -->',
        'Keep parsing content after the ignored metadata comment.',
      ].join('\n'),
    );

    assert.equal(parsed.entries.length, 1);
    assert.equal(parsed.entries[0]?.id, 'canonical');
    assert.equal(parsed.entries[0]?.status, 'active');
    assert.equal(parsed.entries[0]?.scope, 'workspace');
    assert.equal(parsed.entries[0]?.sessionId, undefined);
    assert.match(parsed.entries[0]?.content ?? '', /Keep this entry active/);
    assert.match(parsed.entries[0]?.content ?? '', /Keep parsing content/);
    assert.doesNotMatch(parsed.entries[0]?.content ?? '', /maka-memory|shadow/);
  });

  it('builds prompt body from active entries only and omits metadata comments', () => {
    const body = buildLocalMemoryPromptBody(
      [
        '# Maka Memory',
        '',
        '## Keep',
        '<!-- maka-memory: id=keep origin=manual status=active tags=style -->',
        'Prefer direct answers.',
        '',
        '## Archived',
        '<!-- maka-memory: id=old origin=manual status=archived -->',
        'This should not enter the model context.',
      ].join('\n'),
    );

    assert.ok(body);
    assert.match(body, /## Keep/);
    assert.match(body, /Tags: style/);
    assert.match(body, /Prefer direct answers/);
    assert.doesNotMatch(body, /maka-memory|Archived|should not enter/);
  });

  it('projects session-scoped entries only into their owning session', () => {
    const source = [
      '# Maka Memory',
      '',
      '## Workspace preference',
      '<!-- maka-memory: id=workspace status=active scope=workspace -->',
      'Visible in every session.',
      '',
      '## Session A preference',
      '<!-- maka-memory: id=session-a status=active scope=session sessionId=session-a -->',
      'Visible only in session A.',
      '',
      '## Session B preference',
      '<!-- maka-memory: id=session-b status=active scope=session sessionId=session-b -->',
      'Visible only in session B.',
      '',
      '## Legacy unowned session preference',
      '<!-- maka-memory: id=session-legacy status=active scope=session -->',
      'Must fail closed.',
    ].join('\n');

    const withoutSession = buildLocalMemoryPromptBody(source);
    assert.match(withoutSession ?? '', /Visible in every session/);
    assert.doesNotMatch(withoutSession ?? '', /Visible only|fail closed/);

    const sessionA = buildLocalMemoryPromptBody(source, { sessionId: 'session-a' });
    assert.match(sessionA ?? '', /Visible in every session/);
    assert.match(sessionA ?? '', /Visible only in session A/);
    assert.doesNotMatch(sessionA ?? '', /session B|fail closed/);

    const sessionB = buildLocalMemoryPromptBody(source, { sessionId: 'session-b' });
    assert.match(sessionB ?? '', /Visible in every session/);
    assert.match(sessionB ?? '', /Visible only in session B/);
    assert.doesNotMatch(sessionB ?? '', /session A|fail closed/);
  });

  it('excludes pending, rejected, and unknown statuses from prompt injection', () => {
    const source = [
      '# Maka Memory',
      '',
      '## Active',
      '<!-- maka-memory: id=active origin=manual status=active -->',
      'Use this.',
      '',
      '## Pending',
      '<!-- maka-memory: id=pending proposalId=proposal-abc source=chat_extracted status=review_required -->',
      'Do not inject pending.',
      '',
      '## Rejected',
      '<!-- maka-memory: id=rejected proposalId=proposal-def source=chat_extracted status=rejected -->',
      'Do not inject rejected.',
      '',
      '## Future',
      '<!-- maka-memory: id=future status=future_status -->',
      'Do not inject unknown future status.',
    ].join('\n');

    const parsed = parseLocalMemoryMarkdown(source);
    const body = buildLocalMemoryPromptBody(source);

    assert.equal(parsed.entries.length, 4);
    assert.equal(parsed.activeEntries.length, 1);
    assert.equal(parsed.entries.find((entry) => entry.id === 'future')?.status, 'unknown');
    assert.match(body ?? '', /Use this/);
    assert.doesNotMatch(body ?? '', /pending|rejected|unknown future/i);
  });

  it('does not split a Unicode scalar at the prompt budget boundary', () => {
    const boundaryPrefix = 'word '.repeat(2_400).slice(0, 11_987);
    const body = buildLocalMemoryPromptBody(
      [
        '# Maka Memory',
        '',
        '## Boundary',
        '<!-- maka-memory: id=boundary origin=manual status=active -->',
        `${boundaryPrefix}\u{1f600}tail`,
      ].join('\n'),
    );

    assert.ok(body);
    assert.equal(
      Array.from(body).some(
        (character) =>
          character.length === 1 &&
          character.charCodeAt(0) >= 0xd800 &&
          character.charCodeAt(0) <= 0xdfff,
      ),
      false,
    );
    assert.equal(body.endsWith(LOCAL_MEMORY_PROMPT_TRUNCATION_MARKER), true);
  });

  it('creates pending proposals and keeps approval explicit', () => {
    const proposalId = stableLocalMemoryProposalId(
      'Remember dark mode preference.',
      1700000000000,
      nodeSha256,
    );
    const pending = appendLocalMemoryProposalDraft('# Maka Pending Memory\n', {
      proposalId,
      title: 'Theme preference',
      content: 'Remember dark mode preference.',
      proposedAt: 1700000000000,
      sourceTurnId: 'turn-1',
    });

    assert.equal(pending.ok, true);
    if (!pending.ok) return;
    assert.equal(buildLocalMemoryPromptBody(pending.draft), undefined);
    const proposal = findLocalMemoryEntryDraft(pending.draft, proposalId);
    assert.equal(proposal?.status, 'review_required');
    assert.equal(proposal?.content, 'Remember dark mode preference.');

    const approved = approveLocalMemoryProposalDraft('# Maka Memory\n', pending.draft, {
      proposalId,
      entryId: 'mem-approved123',
      confirmedAt: 1700000001000,
      approvalSurface: 'settings_review_queue',
    });

    assert.equal(approved.ok, true);
    if (!approved.ok) return;
    assert.match(approved.memoryDraft, /id=mem-approved123/);
    assert.match(approved.memoryDraft, /source=chat_extracted/);
    assert.match(approved.memoryDraft, /confirmedAt=1700000001000/);
    assert.doesNotMatch(approved.pendingDraft, /proposal-approved123|Theme preference|dark mode/);
    assert.match(
      buildLocalMemoryPromptBody(approved.memoryDraft) ?? '',
      /Remember dark mode preference/,
    );
  });

  it('preserves the owning session when approving a session-scoped proposal', () => {
    const pending = appendLocalMemoryProposalDraft('# Maka Pending Memory\n', {
      proposalId: 'proposal-session123',
      title: 'Session preference',
      content: 'Use the session-specific toolchain.',
      scope: 'session',
      sessionId: 'session-123',
      proposedAt: 1700000000000,
    });

    assert.equal(pending.ok, true);
    if (!pending.ok) return;
    const proposal = findLocalMemoryEntryDraft(pending.draft, 'proposal-session123');
    assert.equal(proposal?.sessionId, 'session-123');

    const approved = approveLocalMemoryProposalDraft('# Maka Memory\n', pending.draft, {
      proposalId: 'proposal-session123',
      entryId: 'mem-session123',
      confirmedAt: 1700000001000,
    });

    assert.equal(approved.ok, true);
    if (!approved.ok) return;
    assert.equal(approved.entry.sessionId, 'session-123');
    assert.equal(buildLocalMemoryPromptBody(approved.memoryDraft), undefined);
    assert.match(
      buildLocalMemoryPromptBody(approved.memoryDraft, { sessionId: 'session-123' }) ?? '',
      /session-specific toolchain/,
    );
  });

  it('rejects new session-scoped entries without a canonical session identity', () => {
    const approved = appendApprovedLocalMemoryEntryDraft('# Maka Memory\n', {
      id: 'mem-unowned123',
      title: 'Unowned memory',
      content: 'Do not create an unowned session entry.',
      source: 'user_authored',
      scope: 'session',
      confirmedAt: 1700000000000,
    });
    const proposal = appendLocalMemoryProposalDraft('# Maka Pending Memory\n', {
      proposalId: 'proposal-unowned123',
      title: 'Unowned proposal',
      content: 'Do not create an unowned session proposal.',
      scope: 'session',
      proposedAt: 1700000000000,
    });

    assert.deepEqual(approved, { ok: false, reason: 'invalid_session_id' });
    assert.deepEqual(proposal, { ok: false, reason: 'invalid_session_id' });
  });

  it('rejects pending proposals without creating active memory', () => {
    const pending = appendLocalMemoryProposalDraft('# Maka Pending Memory\n', {
      proposalId: 'proposal-reject123',
      title: 'Rejected proposal',
      content: 'Do not save this.',
      proposedAt: 1700000000000,
    });
    assert.equal(pending.ok, true);
    if (!pending.ok) return;

    const rejected = rejectLocalMemoryProposalDraft(pending.draft, {
      proposalId: 'proposal-reject123',
      rejectedAt: 1700000001000,
    });

    assert.equal(rejected.ok, true);
    if (!rejected.ok) return;
    const parsed = parseLocalMemoryMarkdown(rejected.draft);
    assert.equal(parsed.entries[0]?.status, 'rejected');
    assert.equal(parsed.entries[0]?.rejectedAt, 1700000001000);
    assert.equal(buildLocalMemoryPromptBody(rejected.draft), undefined);
  });

  it('rejects entry status updates for invalid or missing ids', () => {
    assert.deepEqual(setLocalMemoryEntryStatusDraft('', { id: ' ', status: 'active', now: 1 }), {
      ok: false,
      reason: 'invalid_id',
    });
    assert.deepEqual(
      setLocalMemoryEntryStatusDraft('## One\nBody', { id: 'missing', status: 'archived', now: 1 }),
      {
        ok: false,
        reason: 'not_found',
      },
    );
  });

  it('rejects blank manual draft entries and oversized resulting drafts', () => {
    assert.deepEqual(
      appendManualLocalMemoryEntryDraft('', {
        title: ' ',
        content: 'body',
        now: 1,
        sha256: nodeSha256,
      }),
      {
        ok: false,
        reason: 'empty_title',
      },
    );
    assert.deepEqual(
      appendManualLocalMemoryEntryDraft('', {
        title: 'title',
        content: ' ',
        now: 1,
        sha256: nodeSha256,
      }),
      {
        ok: false,
        reason: 'empty_content',
      },
    );
    const oversized = appendManualLocalMemoryEntryDraft('x'.repeat(LOCAL_MEMORY_MAX_BYTES), {
      title: 'title',
      content: 'body',
      now: 1,
      sha256: nodeSha256,
    });
    assert.deepEqual(oversized, { ok: false, reason: 'oversize' });
  });

  it('pins persisted memory ids to the injected Node digest', () => {
    const content = 'Remember dark mode preference.';
    const createdAt = 1_700_000_000_000;
    const { material } = stableLocalMemoryIdMaterial(content, createdAt);
    assert.equal(material, `${content}\n${createdAt}`);
    assert.equal(stableLocalMemoryEntryId(content, createdAt, nodeSha256), 'mem-e6ab8f36e9096a9f');
    assert.equal(
      stableLocalMemoryProposalId(content, createdAt, nodeSha256),
      'proposal-e6ab8f36e9096a9f',
    );
    assert.equal(
      stableLocalMemoryEntryId(content, createdAt, nodeSha256),
      stableLocalMemoryEntryId(content, createdAt, nodeSha256),
    );

    const markdown = defaultLocalMemoryMarkdown(nodeSha256, createdAt);
    assert.match(markdown, /id=mem-e060c48e23fe4573/);
    assert.match(markdown, /createdAt=1700000000000/);

    const exampleContent =
      '这里写你希望 Maka 记住的长期偏好。默认不会提供给模型；需要在设置里单独开启“模型上下文可读取”。';
    const fractional = defaultLocalMemoryMarkdown(nodeSha256, -1.7);
    const { timestamp } = stableLocalMemoryIdMaterial(exampleContent, -1.7);
    assert.equal(timestamp, 0);
    assert.match(
      fractional,
      new RegExp(`id=${stableLocalMemoryEntryId(exampleContent, timestamp, nodeSha256)}`),
    );
    assert.match(fractional, /createdAt=0/);
    const added = appendManualLocalMemoryEntryDraft('# Maka Memory\n', {
      title: 'Theme',
      content,
      now: createdAt,
      sha256: nodeSha256,
    });
    assert.equal(added.ok, true);
    if (!added.ok) return;
    assert.match(added.draft, /id=mem-e6ab8f36e9096a9f/);
  });

  it('returns safe mode instead of parsing oversized content', () => {
    const parsed = parseLocalMemoryMarkdown('x'.repeat(LOCAL_MEMORY_MAX_BYTES + 1));
    assert.equal(parsed.safeMode, true);
    assert.equal(parsed.reason, 'oversize');
    assert.equal(parsed.entries.length, 0);
  });
});
