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

import { basename, extname, isAbsolute, resolve } from 'node:path';
import type { ArtifactKind, ArtifactRecord, ArtifactSource } from '@maka/core/artifacts';
import { generalizedErrorMessage } from '@maka/core/redaction';

export interface ToolArtifactCandidate {
  kind: ArtifactKind;
  name: string;
  mimeType?: string;
  source?: ArtifactSource;
  summary?: string;
  sourcePath?: string;
  content?: string | Uint8Array;
}

export interface ToolArtifactDerivationInput {
  toolName: string;
  args: unknown;
  result: unknown;
  cwd: string;
}

export interface ToolArtifactRecorderInput extends ToolArtifactDerivationInput {
  sessionId: string;
  turnId: string;
  toolUseId: string;
  candidates: ToolArtifactCandidate[];
}

export type ToolArtifactRecorder = (
  input: ToolArtifactRecorderInput,
) => Promise<ArtifactRecord[] | void> | ArtifactRecord[] | void;

export function deriveToolArtifactCandidates(
  input: ToolArtifactDerivationInput,
): ToolArtifactCandidate[] {
  const args = objectRecord(input.args);
  const result = objectRecord(input.result);
  switch (input.toolName) {
    case 'Write':
      return deriveWriteArtifacts(args, result, input.cwd);
    case 'Edit':
      return deriveEditArtifacts(args);
    case 'Bash':
      return deriveBashArtifacts(args, input.cwd);
    default:
      return [];
  }
}

export async function recordToolArtifactsSafely(
  input: Omit<ToolArtifactRecorderInput, 'candidates'>,
  recorder: ToolArtifactRecorder | undefined,
  onWarning: (message: string) => void,
): Promise<void> {
  if (!recorder) return;
  const candidates = deriveToolArtifactCandidates(input);
  if (candidates.length === 0) return;
  try {
    await recorder({ ...input, candidates });
  } catch (error) {
    onWarning(`Artifact recorder skipped: ${generalizedErrorMessage(error)}`);
  }
}

function deriveWriteArtifacts(
  args: Record<string, unknown> | null,
  result: Record<string, unknown> | null,
  cwd: string,
): ToolArtifactCandidate[] {
  const resultPath = typeof result?.path === 'string' ? result.path : undefined;
  const argPath = typeof args?.path === 'string' ? args.path : undefined;
  const path = resultPath ?? (argPath ? resolve(cwd, argPath) : undefined);
  if (!path) return [];
  return [
    {
      kind: kindForPath(path),
      name: basename(path),
      mimeType: mimeForPath(path),
      source: 'tool_result',
      summary: 'Write tool output',
      sourcePath: path,
    },
  ];
}

function deriveEditArtifacts(args: Record<string, unknown> | null): ToolArtifactCandidate[] {
  const path = typeof args?.path === 'string' ? args.path : null;
  const oldString = typeof args?.old_string === 'string' ? args.old_string : null;
  const newString = typeof args?.new_string === 'string' ? args.new_string : null;
  if (!path || oldString === null || newString === null) return [];
  return [
    {
      kind: 'diff',
      name: `${basename(path)}.diff`,
      mimeType: 'text/x-diff',
      source: 'tool_result',
      summary: 'Edit tool diff',
      content: editDiff(path, oldString, newString),
    },
  ];
}

function deriveBashArtifacts(
  args: Record<string, unknown> | null,
  cwd: string,
): ToolArtifactCandidate[] {
  const command = typeof args?.command === 'string' ? args.command : null;
  if (!command) return [];
  const redirectedPath = extractStdoutRedirectPath(command);
  if (!redirectedPath) return [];
  const path = isAbsolute(redirectedPath) ? redirectedPath : resolve(cwd, redirectedPath);
  return [
    {
      kind: kindForPath(path),
      name: basename(path),
      mimeType: mimeForPath(path),
      source: 'tool_result',
      summary: 'Bash redirect output',
      sourcePath: path,
    },
  ];
}

export function extractStdoutRedirectPath(command: string): string | null {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = null;
      if (char === '\\' && quote === '"' && index + 1 < command.length) index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char !== '>') continue;
    const previous = previousNonWhitespace(command, index - 1);
    if (previous && /\d/.test(previous)) continue;
    let cursor = index + 1;
    if (command[cursor] === '>') cursor += 1;
    while (/\s/.test(command[cursor] ?? '')) cursor += 1;
    if (command[cursor] === '&') continue;
    const token = readShellToken(command, cursor);
    if (!token || token === '-') continue;
    return token;
  }
  return null;
}

function readShellToken(command: string, start: number): string | null {
  const first = command[start];
  if (!first) return null;
  if (first === '"' || first === "'") {
    let value = '';
    for (let index = start + 1; index < command.length; index += 1) {
      const char = command[index];
      if (char === first) return value;
      if (char === '\\' && first === '"' && index + 1 < command.length) {
        index += 1;
        value += command[index];
      } else {
        value += char;
      }
    }
    return null;
  }
  let value = '';
  for (let index = start; index < command.length; index += 1) {
    const char = command[index]!;
    if (/\s/.test(char) || char === ';' || char === '|' || char === '&') break;
    value += char;
  }
  return value || null;
}

function previousNonWhitespace(command: string, start: number): string | null {
  for (let index = start; index >= 0; index -= 1) {
    const char = command[index]!;
    if (!/\s/.test(char)) return char;
  }
  return null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function kindForPath(path: string): ArtifactKind {
  switch (extname(path).toLowerCase()) {
    case '.html':
    case '.htm':
      return 'html';
    case '.diff':
    case '.patch':
      return 'diff';
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.gif':
    case '.webp':
    case '.svg':
      return 'image';
    case '.pdf':
      return 'pdf';
    default:
      return 'file';
  }
}

function mimeForPath(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case '.html':
    case '.htm':
      return 'text/html';
    case '.md':
    case '.markdown':
      return 'text/markdown';
    case '.txt':
      return 'text/plain';
    case '.diff':
    case '.patch':
      return 'text/x-diff';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.pdf':
      return 'application/pdf';
    default:
      return undefined;
  }
}

function editDiff(path: string, oldString: string, newString: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@',
    ...oldString.split('\n').map((line) => `-${line}`),
    ...newString.split('\n').map((line) => `+${line}`),
  ].join('\n');
}
