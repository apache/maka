import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createSqliteArtifactStore } from '@maka/storage';
import { createAttachmentApprovalRegistry } from '../attachment-approval.js';
import { resolveSessionSend } from '../session-send-resolve.js';
import type { SessionHeader } from '@maka/core';

describe('resolveSessionSend', () => {
  test('readiness failure skips resolve and ingest — token stays valid, no artifact, no stat', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'send-ready-'));
    try {
      const approvals = createAttachmentApprovalRegistry();
      const file = join(dir, 'note.txt');
      await writeFile(file, 'hello');
      const issued = approvals.issueApprovals(1, [{ path: file, name: 'note.txt', size: 5 }]);
      const approvalId = issued[0].approvalId;

      let ensureCalls = 0;
      let consumeCalls = 0;
      let statCalls = 0;
      let artifactCreates = 0;
      const realConsume = approvals.consumeApproval.bind(approvals);
      approvals.consumeApproval = (senderId: number, id: string) => {
        consumeCalls += 1;
        return realConsume(senderId, id);
      };

      await assert.rejects(
        resolveSessionSend({
          sessionId: 's1',
          senderId: 1,
          command: { type: 'send', text: 'hi', attachmentItems: [{ approvalId, name: 'note.txt' }] },
          ensureCanSend: async () => {
            ensureCalls += 1;
            throw new Error('no connection');
          },
          readHeader: async () => ({ cwd: dir } as SessionHeader),
          approvals,
          stat: async () => {
            statCalls += 1;
            return { size: 5 };
          },
          artifactStore: {
            create: async () => {
              artifactCreates += 1;
              return { relativePath: 'a' };
            },
          } as never,
          resizeImage: async (b) => b,
        }),
        /no connection/,
      );

      assert.equal(ensureCalls, 1);
      assert.equal(consumeCalls, 0, 'approval token must not be consumed when readiness fails');
      assert.equal(statCalls, 0, 'no stat when readiness fails');
      assert.equal(artifactCreates, 0, 'no artifact when readiness fails');
      // token still valid for retry
      const retry = approvals.consumeApproval(1, approvalId);
      assert.notEqual(retry, null, 'approval token must remain consumable after a readiness failure');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('readiness ok with items resolves and ingests attachments, consuming the token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'send-ok-'));
    try {
      const store = createSqliteArtifactStore(dir);
      const approvals = createAttachmentApprovalRegistry();
      const file = join(dir, 'note.txt');
      await writeFile(file, 'hello');
      const [{ approvalId }] = approvals.issueApprovals(1, [{ path: file, name: 'note.txt', size: 5 }]);
      const result = await resolveSessionSend({
        sessionId: 's1',
        senderId: 1,
        command: { type: 'send', turnId: 't1', text: 'hi', attachmentItems: [{ approvalId, name: 'note.txt' }] },
        ensureCanSend: async () => {},
        readHeader: async () => ({ cwd: dir } as SessionHeader),
        approvals,
        stat: async () => ({ size: 5 }),
        artifactStore: store,
        resizeImage: async (b) => b,
      });
      assert.equal(result.turnId, 't1');
      assert.equal(result.attachments.length, 1);
      assert.equal(result.attachments[0].ref.kind, 'workspace_file');
      assert.equal(approvals.consumeApproval(1, approvalId), null, 'token is one-shot after a successful send');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('readiness ok without items returns empty attachments without touching approvals', async () => {
    let consumeCalls = 0;
    const approvals = createAttachmentApprovalRegistry();
    const realConsume = approvals.consumeApproval.bind(approvals);
    approvals.consumeApproval = (s: number, id: string) => {
      consumeCalls += 1;
      return realConsume(s, id);
    };
    const result = await resolveSessionSend({
      sessionId: 's1',
      senderId: 1,
      command: { type: 'send', turnId: 't2', text: 'hi' },
      ensureCanSend: async () => {},
      readHeader: async () => null,
      approvals,
      stat: async () => ({ size: 0 }),
      artifactStore: { create: async () => ({ relativePath: 'x' }) } as never,
      resizeImage: async (b) => b,
    });
    assert.equal(result.turnId, 't2');
    assert.deepEqual(result.attachments, []);
    assert.equal(consumeCalls, 0, 'no approval consumed when there are no items');
  });
});
