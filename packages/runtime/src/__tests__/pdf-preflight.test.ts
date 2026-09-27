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
    // A PDF whose stream content discusses encryption but is not itself encrypted.
    const bytes = Buffer.from(
      '%PDF-1.4\nstream\nThis paper discusses /Encrypt ion in PDF files\nendstream\n%EOF',
    );
    const result = validatePdfBytes(bytes);
    assert.deepEqual(result, { ok: true, pages: undefined });
  });

  test('extracts page count and enforces limits', () => {
    const bytes = Buffer.from('%PDF-1.4\n<< /Type /Pages /Count 15 >>\n%EOF');
    const result = validatePdfBytes(bytes, { maxPages: 10 });
    assert.deepEqual(result, { ok: false, reason: 'page_limit_exceeded' });

    const result2 = validatePdfBytes(bytes, { maxPages: 20 });
    assert.deepEqual(result2, { ok: true, pages: 15 });
  });

  test('passes when page count is within limits', () => {
    const bytes = Buffer.from('%PDF-1.4\n<< /Type /Pages /Count 5 >>\n%EOF');
    const result = validatePdfBytes(bytes, { maxPages: 100 });
    assert.deepEqual(result, { ok: true, pages: 5 });
  });
});
