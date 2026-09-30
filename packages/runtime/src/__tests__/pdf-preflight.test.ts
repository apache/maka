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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { validatePdfBytes } from '../pdf-preflight.js';

describe('pdf-preflight', () => {
  test('rejects files without %PDF- magic bytes', () => {
    const bytes = Buffer.from('just a random string without magic bytes');
    const result = validatePdfBytes(bytes);
    assert.deepEqual(result, { ok: false, reason: 'not_a_pdf' });
  });

  test('accepts files with %PDF- magic bytes', () => {
    const bytes = Buffer.from('%PDF-1.4\n%EOF');
    const result = validatePdfBytes(bytes);
    assert.deepEqual(result, { ok: true, pages: undefined });
  });

  test('rejects encrypted PDFs with indirect object reference', () => {
    const bytes = Buffer.from('%PDF-1.4\n/Encrypt 1 0 R\n%EOF');
    const result = validatePdfBytes(bytes);
    assert.deepEqual(result, { ok: false, reason: 'encrypted' });
  });

  test('rejects encrypted PDFs with inline dictionary', () => {
    const bytes = Buffer.from('%PDF-1.4\n/Encrypt <<\n/Filter /Standard\n>>\n%EOF');
    const result = validatePdfBytes(bytes);
    assert.deepEqual(result, { ok: false, reason: 'encrypted' });
  });

  test('does not false-positive on a document that merely mentions /Encrypt in text', () => {
    const bytes = Buffer.from(
      '%PDF-1.4\nstream\nThis paper discusses /Encrypt ion in PDF files\nendstream\n%EOF',
    );
    const result = validatePdfBytes(bytes);
    assert.deepEqual(result, { ok: true, pages: undefined });
  });

  test('extracts page count as advisory hint (never rejects)', () => {
    const bytes = Buffer.from('%PDF-1.4\n<< /Type /Pages /Count 150 >>\n%EOF');
    const result = validatePdfBytes(bytes);
    // Page count is reported but never used for rejection — callers decide policy.
    assert.deepEqual(result, { ok: true, pages: 150 });
  });

  test('does not reject a valid one-page PDF with /Count mentioned in content stream', () => {
    // Counterexample from review: a valid 1-page PDF whose content stream has a
    // comment that contains /Type /Pages /Count 101 before the real page-tree object.
    // The validator must NOT reject this document.
    const bytes = Buffer.from(
      '%PDF-1.4\n' +
        'stream\n% /Type /Pages /Count 101\nendstream\n' +
        '<< /Type /Pages /Count 1 >>\n' +
        '%EOF',
    );
    const result = validatePdfBytes(bytes);
    // The regex may capture either 101 or 1 depending on match order, but
    // critically: the result must be ok:true — no rejection on page count.
    assert.equal(result.ok, true);
  });
});
