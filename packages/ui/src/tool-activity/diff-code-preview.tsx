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

import { useInsertionEffect, useMemo, type ReactNode } from 'react';
import { parseUnifiedDiffRows } from '@maka/core/unified-diff';
import { ensureHighlightStyles, type TokenLine } from '@astryxdesign/core';
import { previewVariants } from '../primitives/chat.js';
import { diffSyntaxTokens } from './diff-syntax.js';

type DiffPreviewRow = {
  kind: 'add' | 'del' | 'ctx' | 'meta';
  marker: string;
  code: string;
  lineNumber?: number;
};

/**
 * Shared structural unified-diff body. Callers own trust boundaries and
 * display budgets; this component owns parsing, gutters, line numbers, and
 * syntax presentation so transcript results and generated files cannot drift.
 */
export function DiffCodePreview(props: {
  diff: string;
  paths: readonly string[];
  className?: string;
}) {
  useInsertionEffect(() => {
    ensureHighlightStyles();
  }, []);

  const rows = useMemo(() => {
    const lines = props.diff.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return diffPreviewRows(lines);
  }, [props.diff]);
  const tokenLines = useMemo(
    () => diffSyntaxTokens(props.paths, rows.map((row) => row.code)),
    [props.paths, rows],
  );
  const numbered = rows.some((row) => row.lineNumber !== undefined);
  const digits = numbered
    ? String(rows.reduce((max, row) => Math.max(max, row.lineNumber ?? 0), 0)).length
    : 0;

  return (
    <pre className={`${previewVariants({ part: 'diff-body' })}${props.className ? ` ${props.className}` : ''}`}>
      {rows.map((row, index) => (
        <span
          key={index}
          className={previewVariants({ part: 'diff-line' })}
          data-line={row.kind}
        >
          {numbered && (
            <span className="maka-tool-diff-gutter" style={{ minWidth: `${digits}ch` }}>
              {row.lineNumber ?? ''}
            </span>
          )}
          <span className="maka-tool-diff-marker">{row.marker}</span>
          <span className="maka-tool-diff-code">
            {row.kind === 'meta' ? row.code : highlightedCode(row.code, tokenLines[index])}
          </span>
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

function diffPreviewRows(lines: string[]): DiffPreviewRow[] {
  return parseUnifiedDiffRows(lines.join('\n')).flatMap((row): DiffPreviewRow[] => {
    if (row.kind === 'hunk') return [];
    if (row.kind === 'meta') return [{ kind: 'meta', marker: '', code: row.text }];
    const lineNumber = row.kind === 'del' ? row.oldLine : row.newLine;
    const marker = row.kind === 'ctx' ? '' : row.text.slice(0, 1);
    const code = row.kind === 'ctx' ? row.text.replace(/^ /, '') : row.text.slice(1);
    return [{
      kind: row.kind,
      marker,
      code,
      ...(lineNumber !== undefined ? { lineNumber } : {}),
    }];
  });
}

function highlightedCode(code: string, tokens: TokenLine | undefined): ReactNode {
  if (!tokens || tokens.length === 0) return code;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const token of tokens) {
    const end = Math.min(token.end, code.length);
    if (token.start < cursor || end <= token.start) continue;
    if (token.start > cursor) parts.push(code.slice(cursor, token.start));
    parts.push(
      <span key={token.start} className={`astryx-token-${token.type}`}>
        {code.slice(token.start, end)}
      </span>,
    );
    cursor = end;
  }
  if (cursor < code.length) parts.push(code.slice(cursor));
  return parts;
}
