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

// Match split('\n').slice(offset, end).join('\n'), without creating entries
// for lines outside the requested window. Empty and trailing lines count too.
// A missing or zero limit is unbounded: end is the total line count.
export function readTextLineWindow(content: string, offset?: number, limit?: number): string {
  if (offset === undefined && limit === undefined) return content;
  let lineCount = 1;
  for (
    let cursor = content.indexOf('\n');
    cursor !== -1;
    cursor = content.indexOf('\n', cursor + 1)
  ) {
    lineCount++;
  }
  const start = offset ?? 0;
  const end = limit ? start + limit : lineCount;
  const from = sliceIndex(start, lineCount);
  const to = sliceIndex(end, lineCount);
  if (from >= to) return '';

  const selected: string[] = [];
  let cursor = 0;
  for (let line = 0; line < to; line++) {
    const newline = content.indexOf('\n', cursor);
    const lineEnd = newline === -1 ? content.length : newline;
    if (line >= from) selected.push(content.slice(cursor, lineEnd));
    cursor = lineEnd + 1;
  }
  return selected.join('\n');
}

function sliceIndex(value: number, length: number): number {
  const integer = Math.trunc(value) || 0;
  return integer < 0 ? Math.max(length + integer, 0) : Math.min(integer, length);
}
