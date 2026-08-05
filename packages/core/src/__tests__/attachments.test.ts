import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  attachmentKindFromMimeType,
  formatAttachmentResourceRef,
  guessMimeFromName,
  parseAttachmentResourceRef,
} from '../index.js';

describe('attachment MIME routing', () => {
  test('routes representative MIME and filename decisions', () => {
    for (const [mime, name, kind] of [
      ['image/png', undefined, 'image'],
      ['application/pdf', undefined, 'pdf'],
      ['application/octet-stream', 'budget.xlsx', 'doc'],
      ['', 'slides.pptx', 'doc'],
    ] as const) {
      assert.equal(attachmentKindFromMimeType(mime, name), kind);
    }
    for (const [name, mime] of [
      ['photo.JPG', 'image/jpeg'],
      ['doc.pdf', 'application/pdf'],
      ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['unknown.xyz', 'application/octet-stream'],
      ['noext', 'application/octet-stream'],
    ]) {
      assert.equal(guessMimeFromName(name), mime);
    }
  });
});

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
