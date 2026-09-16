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

const resolveLocale = (globals: Record<string, unknown>) =>
  globals.locale === 'en' ? 'en' : globals.locale === 'zh-TW' ? 'zh-TW' : 'zh-CN';

function fallback(copyState: ErrorBoundaryCopyState) {
  return (_args: unknown, { globals }: { globals: Record<string, unknown> }) => (
    <ErrorBoundaryFallback
      copyState={copyState}
      locale={resolveLocale(globals)}
      onCopyReport={onCopyReport}
      onReset={onReset}
      onReload={onReload}
    />
  );
}

export const DefaultFallback: Story = {
  render: fallback('idle'),
};

// Visual snapshot of the fallback's pending state; it does not exercise the copy transition.
export const CopyPending: Story = {
  render: fallback('pending'),
};

// Visual snapshot of the fallback's copied state; it does not exercise the copy transition.
export const Copied: Story = {
  render: fallback('copied'),
};

// Visual snapshot of the fallback's failed state; it does not exercise the copy transition.
export const CopyFailed: Story = {
  render: fallback('failed'),
};
