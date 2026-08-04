import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { attachmentKindFromMimeType, guessMimeFromName } from '../index.js';

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
