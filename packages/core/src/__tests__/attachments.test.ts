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
import { describe, test } from 'node:test';
import {
  ATTACHMENT_MIME_SNIFF_BYTES,
  formatAttachmentResourceRef,
  parseAttachmentResourceRef,
  PDF_HEADER_SCAN_BYTES,
  resolveAttachmentMimeType,
  sniffAttachmentMimeType,
} from '../attachments.js';

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

describe('attachment content sniffing', () => {
  test('recognises supported image and PDF signatures', () => {
    const fixtures: Array<[Uint8Array, string]> = [
      [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png'],
      [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'],
      [Buffer.from('GIF89a', 'ascii'), 'image/gif'],
      [Buffer.from('RIFF0000WEBP', 'ascii'), 'image/webp'],
      [Buffer.from('%PDF-1.7', 'ascii'), 'application/pdf'],
    ];

    for (const [bytes, expected] of fixtures) {
      assert.equal(sniffAttachmentMimeType(bytes), expected);
    }
  });

  test('does not sniff BMP: unsupported downstream, and its 2-byte marker is too weak', () => {
    // No reader (send path or Read) accepts BMP, and `BM` matches arbitrary
    // files, so treating those bytes as an image would route them to a decoder
    // that later fails with unsupported_mime.
    assert.equal(sniffAttachmentMimeType(Buffer.from('BM harmless text')), undefined);
  });

  test('finds a PDF header behind a preamble, but keeps image sniffing at offset 0', () => {
    // PDF readers tolerate junk before %PDF- and scan the first ~1 KiB, so a
    // header past the sniffing prefix must still resolve as a PDF.
    assert.equal(
      sniffAttachmentMimeType(
        Buffer.concat([Buffer.alloc(ATTACHMENT_MIME_SNIFF_BYTES), Buffer.from('%PDF-1.7')]),
      ),
      'application/pdf',
    );
    // Image signatures are only valid at their fixed offset: a PNG header behind
    // a preamble is not a decodable image stream, so it is not sniffed.
    assert.equal(
      sniffAttachmentMimeType(
        Buffer.concat([
          Buffer.alloc(4),
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        ]),
      ),
      undefined,
    );
    // Still bounded: a PDF header past the scan window is not a match, so
    // sniffing never becomes an unbounded read.
    assert.equal(
      sniffAttachmentMimeType(
        Buffer.concat([Buffer.alloc(PDF_HEADER_SCAN_BYTES), Buffer.from('%PDF-1.7')]),
      ),
      undefined,
    );
    // An extension-like payload is not a signature.
    assert.equal(sniffAttachmentMimeType(Buffer.from('report.png')), undefined);
  });
});

describe('resolveAttachmentMimeType (content-first precedence)', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const PDF = Buffer.from('%PDF-1.7', 'ascii');

  test('sniffed content wins over a conflicting name or supplied MIME', () => {
    assert.equal(resolveAttachmentMimeType(PNG, 'application/pdf', 'report.pdf'), 'image/png');
    assert.equal(resolveAttachmentMimeType(PDF, 'image/png', 'photo.png'), 'application/pdf');
  });

  test('downgrades an unverified image/PDF claim to octet-stream', () => {
    const notAnImage = Buffer.from('not an image');
    assert.equal(
      resolveAttachmentMimeType(notAnImage, 'image/png', 'payload.png'),
      'application/octet-stream',
    );
    assert.equal(
      resolveAttachmentMimeType(notAnImage, undefined, 'payload.png'),
      'application/octet-stream',
    );
  });

  test('keeps a non-image document claim so real document kinds still resolve', () => {
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    assert.equal(resolveAttachmentMimeType(Buffer.from('PK'), docx, 'notes.docx'), docx);
    assert.equal(resolveAttachmentMimeType(Buffer.from('PK'), undefined, 'notes.docx'), docx);
  });
});
