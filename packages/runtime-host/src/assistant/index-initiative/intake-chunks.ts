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

/** Prefer complete JSON records or lines. Oversized single records still use an explicit text fragment. */
export function intakeChunkEnd(text: string, start: number, capacityEnd: number): number {
  if (capacityEnd >= text.length) return text.length;
  let end = capacityEnd;
  if (end > start && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  let json = false;
  try {
    JSON.parse(text);
    json = true;
  } catch {
    /* Text and JSONL use line boundaries. */
  }
  if (!json) {
    const newline = text.lastIndexOf('\n', end - 1);
    return newline >= start ? newline + 1 : end;
  }
  let quoted = false,
    escaped = false,
    depth = 0,
    boundary = start;
  for (let i = 0; i < end; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') {
      depth--;
      if (depth <= 2 && i + 1 > start) boundary = i + 1;
    } else if (char === ',' && depth <= 2 && i + 1 > start) boundary = i + 1;
  }
  return boundary > start ? boundary : end;
}
