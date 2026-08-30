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

import type { InlineReference } from '@maka/core/events';
import { ChatTokenizedText, type ChatComposerToken } from '@astryxdesign/core';
import { useContext, type ReactNode } from 'react';
import { ICON_SIZE, Sparkles } from './icons.js';
import { MakaUriContext } from './markdown.js';
import { parseWorkspaceFileHref } from './workspace-file-href.js';

type InlineReferenceVisual = Pick<InlineReference, 'kind' | 'value' | 'label'>;

export type WorkspaceFileReferencePosition = Pick<InlineReference, 'value' | 'start'>;

/** Last path segment of a POSIX-style relative path. */
export function inlineReferenceFileBasename(relativePath: string): string {
  const segments = relativePath.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? relativePath;
}

export function workspaceFileInlineReference(relativePath: string): InlineReferenceVisual {
  return {
    kind: 'workspace_file',
    value: `@${relativePath}`,
    label: inlineReferenceFileBasename(relativePath),
  };
}

/** Mirror Astryx serialization while recording the exact surviving file-token ranges. */
export function workspaceFileReferencePositions(root: Node): WorkspaceFileReferencePosition[] {
  let serialized = '';
  const positions: WorkspaceFileReferencePosition[] = [];
  const visit = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        serialized += child.textContent ?? '';
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const element = child as HTMLElement;
      if (element.hasAttribute('data-astryx-token')) {
        const value = element.getAttribute('data-astryx-token-value') ?? '';
        if (value.startsWith('@') && value.length > 1) {
          positions.push({ value, start: serialized.length });
        }
        serialized += value;
      } else if (element.tagName === 'BR') {
        serialized += '\n';
      } else {
        visit(element);
      }
    }
  };
  visit(root);
  const normalized = serialized.replace(/ /g, ' ');
  const leadingTrim = normalized.length - normalized.trimStart().length;
  const trailingBoundary = normalized.trimEnd().length;
  return positions
    .filter(
      (reference) =>
        reference.start >= leadingTrim &&
        reference.start + reference.value.length <= trailingBoundary,
    )
    .map((reference) => ({ ...reference, start: reference.start - leadingTrim }));
}

/** The single visual projection shared by the Composer and sent transcript. */
export function inlineReferenceToken(reference: InlineReferenceVisual): ChatComposerToken {
  return {
    value: reference.value,
    label: reference.label,
    ...(reference.kind === 'skill'
      ? { icon: <Sparkles size={ICON_SIZE.meta} aria-hidden="true" /> }
      : {}),
  };
}

export function InlineReferenceText(props: {
  text: string;
  references: readonly InlineReference[];
}) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const reference of props.references) {
    if (
      !reference.value ||
      !Number.isSafeInteger(reference.start) ||
      reference.start < cursor ||
      props.text.slice(reference.start, reference.start + reference.value.length) !==
        reference.value
    ) {
      continue;
    }
    if (reference.start > cursor) parts.push(props.text.slice(cursor, reference.start));
    parts.push(
      reference.kind === 'workspace_file' ? (
        <WorkspaceFileInlineReference
          key={`${reference.start}:${reference.value}`}
          reference={reference}
        />
      ) : (
        <ChatTokenizedText
          key={`${reference.start}:${reference.value}`}
          tokens={[inlineReferenceToken(reference)]}
        >
          {reference.value}
        </ChatTokenizedText>
      ),
    );
    cursor = reference.start + reference.value.length;
  }
  if (cursor < props.text.length) parts.push(props.text.slice(cursor));
  return <span>{parts}</span>;
}

/** Keep ordinary messages outside the navigation context subscription. */
function WorkspaceFileInlineReference(props: { reference: InlineReference }) {
  const dispatch = useContext(MakaUriContext);
  const workspaceFile = props.reference.value.startsWith('@')
    ? parseWorkspaceFileHref(props.reference.value.slice(1))
    : null;
  const tokenizedText = (
    <ChatTokenizedText tokens={[inlineReferenceToken(props.reference)]}>
      {props.reference.value}
    </ChatTokenizedText>
  );
  if (!workspaceFile || !dispatch) return tokenizedText;
  const openWorkspaceFile = () => dispatch(workspaceFile);
  return (
    <ChatTokenizedText
      tokens={[inlineReferenceToken(props.reference)]}
      role="button"
      tabIndex={0}
      data-maka-uri-kind={workspaceFile.kind}
      data-workspace-file={workspaceFile.relativePath}
      onClick={openWorkspaceFile}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openWorkspaceFile();
      }}
    >
      {props.reference.value}
    </ChatTokenizedText>
  );
}
