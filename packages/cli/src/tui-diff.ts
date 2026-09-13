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

import { parseUnifiedDiffRows, type UnifiedDiffRow } from '@maka/core/unified-diff';
import { ansi } from './tui-ansi.js';

/**
 * Diff coloring for the transcript, over the shared structural parse in
 * `@maka/core`. The parse drives classification with the declared hunk
 * counts, so a deleted `-- `-prefixed line colors red instead of dimming as
 * a false file header, and file headers (`---`/`+++`/`index`) never reach
 * the transcript at all. Hunk headers stay: they are the only line-number
 * anchor in the terminal rendering.
 */
function colorDiffRow(row: UnifiedDiffRow): string {
  switch (row.kind) {
    case 'add':
      return ansi.green(row.text);
    case 'del':
      return ansi.red(row.text);
    case 'hunk':
      return ansi.accent(row.text);
    case 'meta':
      return ansi.dim(row.text);
    case 'ctx':
      return row.text;
  }
}

/** Color a whole diff body, preserving line breaks. */
export function colorDiff(diff: string): string {
  return parseUnifiedDiffRows(diff).map(colorDiffRow).join('\n');
}
