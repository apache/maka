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

const HREF_MAX_LENGTH = 4096;
const BARE_MARKDOWN_PATH = /(?:\.\/)?(?:[\p{L}\p{N}_@.+-]+\/)*[\p{L}\p{N}_@+-]+(?:\.[\p{L}\p{N}_@+-]+)*\.(?:markdown|mdx|md)/iyu;

export type WorkspaceFileDest = {
  readonly kind: 'workspace_file';
  readonly relativePath: string;
};

/**
 * Parse a workspace-relative file href from Markdown. Absolute paths, schemes,
 * traversal, and query/hash fragments stay inert so transcript text cannot
 * point outside the session workspace.
 */
export function parseWorkspaceFileHref(href: string): WorkspaceFileDest | null {
  if (typeof href !== 'string') return null;
  if (href.length === 0 || href.length > HREF_MAX_LENGTH) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    return null;
  }
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(decoded)) return null;
  if (decoded.startsWith('/') || decoded.startsWith('~') || decoded.startsWith('\\')) return null;
  if (decoded.includes('\\') || decoded.includes('?') || decoded.includes('#')) return null;
  const trimmed = decoded.replace(/^\.\//, '');
  const segments = trimmed.split('/');
  if (segments.length === 0 || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null;
  }
  const relativePath = segments.join('/');
  if (!isMarkdownWorkspaceFile(relativePath)) return null;
  return { kind: 'workspace_file', relativePath };
}

export function isMarkdownWorkspaceFile(relativePath: string): boolean {
  return /\.(?:md|markdown|mdx)$/i.test(relativePath);
}

/**
 * Make unambiguous bare Markdown paths clickable without rewriting code,
 * existing links, autolinks, or reference definitions. Paths containing
 * spaces remain supported through ordinary Markdown link destinations.
 */
export function linkifyBareWorkspaceMarkdownReferences(source: string): string {
  let fence: { character: string; length: number } | null = null;
  return source
    .split('\n')
    .map((line) => {
      const blockLine = markdownBlockContent(line.endsWith('\r') ? line.slice(0, -1) : line);
      if (fence) {
        const closing = new RegExp(
          `^ {0,3}${escapeRegExp(fence.character)}{${fence.length},}[ \\t]*$`,
        );
        if (closing.test(blockLine)) fence = null;
        return line;
      }

      const opening = /^ {0,3}(`{3,}|~{3,})/.exec(blockLine);
      if (opening?.[1]) {
        fence = { character: opening[1][0]!, length: opening[1].length };
        return line;
      }
      if (/^(?: {4}|\t)/.test(blockLine)) return line;
      if (/^ {0,3}\[[^\]]+\]:/.test(blockLine)) return line;
      return linkifyBareWorkspacePathsInLine(line);
    })
    .join('\n');
}

function linkifyBareWorkspacePathsInLine(line: string): string {
  let output = '';
  let cursor = 0;

  while (cursor < line.length) {
    if (line[cursor] === '`') {
      let delimiterLength = 1;
      while (line[cursor + delimiterLength] === '`') delimiterLength += 1;
      const delimiter = '`'.repeat(delimiterLength);
      const close = line.indexOf(delimiter, cursor + delimiterLength);
      if (close !== -1) {
        const end = close + delimiterLength;
        output += line.slice(cursor, end);
        cursor = end;
        continue;
      }
    }

    const labelStart = line[cursor] === '['
      ? cursor
      : line[cursor] === '!' && line[cursor + 1] === '['
        ? cursor + 1
        : -1;
    if (labelStart !== -1) {
      const labelClose = line.indexOf(']', labelStart + 1);
      if (labelClose !== -1) {
        const destinationStart = labelClose + 1;
        if (line[destinationStart] === '(') {
          const destinationClose = findClosingParen(line, destinationStart + 1);
          if (destinationClose !== -1) {
            output += line.slice(cursor, destinationClose + 1);
            cursor = destinationClose + 1;
            continue;
          }
        } else if (line[destinationStart] === '[') {
          const referenceClose = line.indexOf(']', destinationStart + 1);
          if (referenceClose !== -1) {
            output += line.slice(cursor, referenceClose + 1);
            cursor = referenceClose + 1;
            continue;
          }
        }
        output += line.slice(cursor, labelClose + 1);
        cursor = labelClose + 1;
        continue;
      }
    }

    if (line[cursor] === '<') {
      const close = line.indexOf('>', cursor + 1);
      if (close !== -1) {
        output += line.slice(cursor, close + 1);
        cursor = close + 1;
        continue;
      }
    }

    if (isBarePathStartBoundary(line, cursor)) {
      BARE_MARKDOWN_PATH.lastIndex = cursor;
      const match = BARE_MARKDOWN_PATH.exec(line);
      const candidate = match?.[0];
      if (
        candidate
        && !looksLikeExternalAutolink(candidate)
        && isBarePathEndBoundary(line, cursor + candidate.length)
        && parseWorkspaceFileHref(candidate)
      ) {
        output += `[${candidate}](${candidate})`;
        cursor += candidate.length;
        continue;
      }
    }

    output += line[cursor];
    cursor += 1;
  }
  return output;
}

function isBarePathStartBoundary(line: string, index: number): boolean {
  if (index === 0) return true;
  return /[\s([\]{}'"*_~>|]/u.test(line[index - 1]!);
}

function isBarePathEndBoundary(line: string, index: number): boolean {
  if (index === line.length) return true;
  const next = line[index]!;
  if (next === '.') {
    const afterPeriod = line[index + 1];
    return afterPeriod === undefined || /[\s,;:!()[\]{}'"*_~<>|]/u.test(afterPeriod);
  }
  return /[\s,;:!()[\]{}'"*_~<>|]/u.test(next);
}

function looksLikeExternalAutolink(candidate: string): boolean {
  return /^(?:www\.|[^/]+@)/iu.test(candidate);
}

function markdownBlockContent(line: string): string {
  let content = line;
  while (true) {
    const container = /^(?: {0,3}>[ \t]?| {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+)/.exec(content);
    if (!container) return content;
    content = content.slice(container[0].length);
  }
}

function findClosingParen(text: string, start: number): number {
  let depth = 1;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    if (text[index] === ')' && --depth === 0) return index;
  }
  return -1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
