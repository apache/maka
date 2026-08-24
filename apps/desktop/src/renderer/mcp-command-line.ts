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

// apps/desktop/src/renderer/mcp-command-line.ts
//
// The editor's single 命令 field holds a whole command line; mcp.json keeps
// the protocol shape (`command` + `args[]`). These two functions are the
// bridge, and they are inverses: parse(format(command, args)) always yields
// the same tokens back.
//
// Tokenization is deliberately not a shell: no expansion, no globbing, no
// operators. Whitespace separates tokens; single or double quotes group
// spans containing whitespace; inside double quotes, `\"` and `\\` escape.

export type ParsedCommandLine =
  | { ok: true; command: string; args: string[] }
  | { ok: false; error: 'unbalanced-quote' };

export function parseCommandLine(input: string): ParsedCommandLine {
  const tokens: string[] = [];
  let current = '';
  let hasToken = false;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote === '"' && char === '\\' && (input[index + 1] === '"' || input[index + 1] === '\\')) {
      current += input[index + 1];
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
      continue;
    }
    if (/\s/u.test(char)) {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }
    current += char;
    hasToken = true;
  }
  if (quote) return { ok: false, error: 'unbalanced-quote' };
  if (hasToken) tokens.push(current);
  const [command = '', ...args] = tokens;
  return { ok: true, command, args };
}

export function formatCommandLine(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteToken).join(' ');
}

function quoteToken(token: string): string {
  if (token !== '' && !/[\s"']/u.test(token)) return token;
  return `"${token.replace(/[\\"]/gu, (char) => `\\${char}`)}"`;
}
