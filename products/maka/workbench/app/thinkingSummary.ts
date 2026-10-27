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

/** Display the last nonempty paragraph without splitting the earlier source. */
export function thinkingSummary(text: string): string {
  const whitespace = /\s/;
  let end = text.length;
  while (end > 0 && whitespace.test(text[end - 1])) end -= 1;
  if (end === 0) return '';
  let start = 0;
  let newline = text.lastIndexOf('\n', end - 1);
  while (newline > 0) {
    let before = newline - 1;
    if (text[before] === '\r') before -= 1;
    while (text[before] === ' ' || text[before] === '\t') before -= 1;
    if (text[before] === '\n') {
      start = newline + 1;
      break;
    }
    newline = text.lastIndexOf('\n', newline - 1);
  }
  return text.slice(start, end).replaceAll('**', '').replace(/\s+/g, ' ').trim();
}
