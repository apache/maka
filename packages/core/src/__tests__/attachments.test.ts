import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatAttachmentResourceRef, parseAttachmentResourceRef } from '../attachments.js';

describe('attachment resource refs', () => {
  test('round-trips one canonical Session Artifact without embedding Session authority', () => {
    const value = formatAttachmentResourceRef({
      kind: 'session_file',
      sessionId: 'session-secret',
      relativePath: 'attachment-123',
    });

    assert.equal(value, 'maka://runtime/attachments/attachment-123');
    assert.deepEqual(parseAttachmentResourceRef(value!), { artifactId: 'attachment-123' });
    assert.doesNotMatch(value!, /session-secret/);
  });

  test('rejects file paths and non-canonical resource spellings', () => {
    assert.equal(
      formatAttachmentResourceRef({ kind: 'workspace_file', relativePath: 'notes.txt' }),
      null,
    );
    assert.equal(
      formatAttachmentResourceRef({
        kind: 'session_file',
        sessionId: 'session-1',
        relativePath: '../secret',
      }),
      null,
    );
    assert.equal(parseAttachmentResourceRef('maka://runtime/attachments/a?session=other'), null);
    assert.equal(parseAttachmentResourceRef('maka://runtime/attachments/a/b'), null);
  });
});
