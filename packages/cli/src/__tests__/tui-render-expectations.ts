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

import { CURSOR_MARKER, visibleWidth } from '@earendil-works/pi-tui';
import { ansi } from '../tui-ansi.js';

const REVERSE_ON = '\x1b[7m';
const RESET = '\x1b[0m';

// Encode a multiline expectation as full-width ANSI rows.
// <cursor> requires both the visible cursor and the IME marker at this position.
// These tests place the cursor on an ASCII character, or a space at row end.
// <selected>...</selected> highlights the entire padded row.
export function encodeExpectedRows(expectedScene: string, width: number): string[] {
  // Remove only the template literal's framing newlines, preserving indentation.
  const rows = expectedScene.split('\n').slice(1, -1);
  return rows.map((row) => {
    const isSelected = row.startsWith('<selected>');
    const text = row.replace('<selected>', '').replace('</selected>', '');
    const withCursor = text.replace(
      /<cursor>(.)?/gu,
      (_, character = ' ') => `${CURSOR_MARKER}${REVERSE_ON}${character}${RESET}`,
    );
    const paddedRow = withCursor + ' '.repeat(width - visibleWidth(withCursor));
    return isSelected ? ansi.reverse(paddedRow) : paddedRow;
  });
}
