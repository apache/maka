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

import { PDF_HEADER_SCAN_BYTES } from '@maka/core/attachments';

export type PdfPreflightResult =
  | { ok: true; pages?: number }
  | { ok: false; reason: 'encrypted' | 'not_a_pdf' | 'page_limit_exceeded' | 'malformed' };

/**
 * Deterministic, bounded, best-effort PDF preflight validator.
 *
 * Designed to filter out incompatible documents before LLM provider dispatch
 * without the CPU, memory, and security overhead of full PDF object-graph
 * evaluation, rendering, or OCR.
 *
 * **Fast-path heuristics**:
 *
 * - **Header**: Verifies presence of `%PDF-` within the canonical
 *   {@link PDF_HEADER_SCAN_BYTES} window defined in `@maka/core/attachments`.
 *
 * - **Encryption**: Searches for an active `/Encrypt` dictionary definition
 *   (`/Encrypt <<` or `/Encrypt N N R`). A document that merely *mentions*
 *   the word `/Encrypt` outside a dictionary context will not trigger a
 *   false positive.
 *
 * - **Page count**: Best-effort bounded regex scan for
 *   `/Type /Pages ... /Count N`. On complex nested page trees the captured
 *   count represents the root node's value, which is the total page count
 *   in a conforming producer. The value is a hint; callers should treat
 *   `pages` as an upper-bound estimate rather than an exact gate.
 *
 * **Non-goals**: Does not parse fonts, decompress streams, render raster
 * content, or extract text.
 */
export function validatePdfBytes(
  bytes: Uint8Array,
  limits?: { maxPages?: number },
): PdfPreflightResult {
  // 1. Structural check — reuse the canonical scan window from @maka/core.
  const scanWindow = Math.min(bytes.length, PDF_HEADER_SCAN_BYTES);
  const prefix = bytes.subarray(0, scanWindow);
  const prefixStr = Buffer.from(prefix).toString('ascii');
  if (!prefixStr.includes('%PDF-')) {
    return { ok: false, reason: 'not_a_pdf' };
  }

  // 2. Build a bounded ASCII view for dictionary scanning.
  // For files ≤ 5 MB convert the whole buffer; for larger files inspect only
  // the first and last 1 MB where PDF trailers and catalog roots reside.
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let scanStr = '';
  if (buffer.length <= 5 * 1024 * 1024) {
    scanStr = buffer.toString('ascii');
  } else {
    const head = buffer.subarray(0, 1024 * 1024).toString('ascii');
    const tail = buffer.subarray(buffer.length - 1024 * 1024).toString('ascii');
    scanStr = head + tail;
  }

  // 3. Encryption check — match an active /Encrypt dictionary definition
  // rather than a bare substring, to avoid false positives on documents that
  // merely discuss PDF encryption in their text content.
  const encryptRegex = /\/Encrypt\s*(?:<<|\d+\s+\d+\s+R)/;
  if (encryptRegex.test(scanStr)) {
    return { ok: false, reason: 'encrypted' };
  }

  // 4. Page count extraction (best effort).
  const pagesMatch = scanStr.match(/\/Type\s*\/Pages[\s\S]{0,100}?\/Count\s+(\d+)/);
  let pages: number | undefined = undefined;

  if (pagesMatch && pagesMatch[1]) {
    pages = parseInt(pagesMatch[1], 10);
    if (!isNaN(pages) && limits?.maxPages && pages > limits.maxPages) {
      return { ok: false, reason: 'page_limit_exceeded' };
    }
  } else {
    // Alternate layout: /Count before /Type /Pages in the same dictionary.
    const alternateMatch = scanStr.match(/\/Count\s+(\d+)[\s\S]{0,100}?\/Type\s*\/Pages/);
    if (alternateMatch && alternateMatch[1]) {
      pages = parseInt(alternateMatch[1], 10);
      if (!isNaN(pages) && limits?.maxPages && pages > limits.maxPages) {
        return { ok: false, reason: 'page_limit_exceeded' };
      }
    }
  }

  return { ok: true, pages };
}
