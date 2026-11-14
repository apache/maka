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

/** The passages a message quotes at its start (lines that begin with `>`), and what follows them. */
export function splitQuotes(text: string): { quotes: string[]; body: string } {
  const lines = text.split('\n');
  const quotes: string[] = [];
  let passage: string[] = [];
  let at = 0;
  for (; at < lines.length; at += 1) {
    const line = lines[at]!;
    if (line.startsWith('>')) passage.push(line.replace(/^> ?/, ''));
    else if (line.trim() === '') {
      if (passage.length > 0) quotes.push(passage.join('\n'));
      passage = [];
    } else break;
  }
  if (passage.length > 0) quotes.push(passage.join('\n'));
  return quotes.length === 0
    ? { quotes, body: text }
    : { quotes, body: lines.slice(at).join('\n') };
}
