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

import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import type { ErrorInfo } from 'react';
import {
  ErrorBoundaryFallback,
  type ErrorBoundaryCopyState,
} from '../src/renderer/error-boundary';

const meta = {
  title: 'Product/Shell/Error Boundary',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

// The class owns the copy/reset/reload side effects; the fallback only paints,
// so these mocks stand in for the wired handlers without touching state.
const onCopyReport = fn();
const onReset = fn();
const onReload = fn();

// A representative renderer crash: a real Error carrying a synthetic renderer
// stack + React component stack, the same shape componentDidCatch hands render().
function buildRendererError(name: string, message: string, frames: string[]): Error {
  const error = new Error(message);
  error.name = name;
  error.stack = [`${name}: ${message}`, ...frames.map((frame) => `    at ${frame}`)].join('\n');
  return error;
}

const transcriptError = buildRendererError(
  'TypeError',
  "Cannot read properties of undefined (reading 'messages')",
  [
    'SessionTranscript (src/renderer/features/workbar/session-transcript.tsx:142:31)',
    'renderWithHooks (react-dom.development.js:15486:18)',
    'mountIndeterminateComponent (react-dom.development.js:20103:13)',
    'beginWork (react-dom.development.js:21626:16)',
  ],
);

const transcriptComponentStack: ErrorInfo = {
  componentStack: [
    '',
    '    at SessionTranscript (src/renderer/features/workbar/session-transcript.tsx:142:31)',
    '    at WorkbarPanel',
    '    at AppShell',
    '    at ErrorBoundary (src/renderer/error-boundary.tsx:73:1)',
  ].join('\n'),
};

// A second, different error — what the boundary catches when the still-broken
// subtree throws again after 重试.
const retryError = buildRendererError('RangeError', 'Maximum call stack size exceeded', [
  'toTreeNode (src/renderer/features/workbar/plan-tree.tsx:88:12)',
  'toTreeNode (src/renderer/features/workbar/plan-tree.tsx:91:20)',
  'toTreeNode (src/renderer/features/workbar/plan-tree.tsx:91:20)',
]);

const retryComponentStack: ErrorInfo = {
  componentStack: [
    '',
    '    at PlanTree (src/renderer/features/workbar/plan-tree.tsx:88:12)',
    '    at WorkbarPanel',
    '    at AppShell',
    '    at ErrorBoundary (src/renderer/error-boundary.tsx:73:1)',
  ].join('\n'),
};

const resolveLocale = (globals: Record<string, unknown>) => (globals.locale === 'en' ? 'en' : 'zh');

function fallback(copyState: ErrorBoundaryCopyState, error: Error, errorInfo: ErrorInfo) {
  return (_args: unknown, { globals }: { globals: Record<string, unknown> }) => (
    <ErrorBoundaryFallback
      error={error}
      errorInfo={errorInfo}
      copyState={copyState}
      locale={resolveLocale(globals)}
      onCopyReport={onCopyReport}
      onReset={onReset}
      onReload={onReload}
    />
  );
}

// Real path: the renderer throws during render; ErrorBoundary.getDerivedStateFromError
// + componentDidCatch capture the error and React component stack, and render() paints
// this fallback with copyState 'idle'.
export const DefaultFallback: Story = {
  render: fallback('idle', transcriptError, transcriptComponentStack),
};

// Real path: on the crash screen the user clicks 复制诊断信息; handleCopyReport sets
// copyState 'pending' while window.maka.diagnostics.copyReport is in flight, disabling
// the button (isDisabled + aria-busy).
export const CopyPending: Story = {
  render: fallback('pending', transcriptError, transcriptComponentStack),
};

// Real path: continues from copy pending — diagnostics.copyReport resolves, handleCopyReport
// sets copyState 'copied' and the copy button swaps to the check glyph.
export const Copied: Story = {
  render: fallback('copied', transcriptError, transcriptComponentStack),
};

// Real path: continues from copy pending — the clipboard bridge (diagnostics.copyReport, or
// the navigator.clipboard fallback) rejects, handleCopyReport sets copyState 'failed', and the
// manual-select hint appears below the actions.
export const CopyFailed: Story = {
  render: fallback('failed', transcriptError, transcriptComponentStack),
};

// Real path: after 重试 (handleReset clears the error) the still-broken subtree throws a
// second, different error; the boundary re-catches and render() shows the new report — proving
// the fallback reflects the current error, not the first one.
export const RepeatError: Story = {
  render: fallback('idle', retryError, retryComponentStack),
};
