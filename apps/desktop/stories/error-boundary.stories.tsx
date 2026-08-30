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

// Explicitly synthetic diagnostics used only to exercise the fallback layout.
// The generic fixture names do not represent a Maka product call chain.
function buildRendererError(name: string, message: string, frames: string[]): Error {
  const error = new Error(message);
  error.name = name;
  error.stack = [`${name}: ${message}`, ...frames.map((frame) => `    at ${frame}`)].join('\n');
  return error;
}

const syntheticError = buildRendererError(
  'TypeError',
  "Cannot read properties of undefined (reading 'messages')",
  [
    'SyntheticCrashFixture (<synthetic-storybook-fixture>:42:7)',
    'renderWithHooks (react-dom.development.js:15486:18)',
    'mountIndeterminateComponent (react-dom.development.js:20103:13)',
    'beginWork (react-dom.development.js:21626:16)',
  ],
);

const syntheticComponentStack: ErrorInfo = {
  componentStack: [
    '',
    '    at SyntheticCrashFixture (<synthetic-storybook-fixture>:42:7)',
    '    at SyntheticParentFixture (<synthetic-storybook-fixture>:18:3)',
    '    at ErrorBoundary',
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

// Visual snapshot of the fallback's idle state. In production, ErrorBoundary supplies
// this Error/ErrorInfo shape after catching a renderer crash.
export const DefaultFallback: Story = {
  render: fallback('idle', syntheticError, syntheticComponentStack),
};

// Visual snapshot of the fallback's pending state; it does not exercise the copy transition.
export const CopyPending: Story = {
  render: fallback('pending', syntheticError, syntheticComponentStack),
};

// Visual snapshot of the fallback's copied state; it does not exercise the copy transition.
export const Copied: Story = {
  render: fallback('copied', syntheticError, syntheticComponentStack),
};

// Visual snapshot of the fallback's failed state; it does not exercise the copy transition.
export const CopyFailed: Story = {
  render: fallback('failed', syntheticError, syntheticComponentStack),
};
