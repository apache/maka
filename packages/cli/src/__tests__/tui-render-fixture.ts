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

// These fixtures use ASCII input. The cursor covers the next character,
// or a space at the end of a row, with the IME marker at the same position.
export function renderFixture(fixture: string, width: number): string[] {
  return fixture
    .split('\n')
    .slice(1, -1)
    .map((row) => {
      const selected = row.startsWith('<selected>');
      const line = row
        .replace('<selected>', '')
        .replace('</selected>', '')
        .replace(
          /<cursor>(.)?/gu,
          (_, character = ' ') => `${CURSOR_MARKER}${REVERSE_ON}${character}${RESET}`,
        );
      const padded = line + ' '.repeat(width - visibleWidth(line));
      return selected ? ansi.reverse(padded) : padded;
    });
}
