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

import { useEffect, useMemo } from 'react';
import type { ContextCompactionOutcome } from '@maka/core/events';
import { ToastProvider, useToast, useUiLocale } from '@maka/ui';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { createContextCompactionPresentation } from '../src/renderer/app-shell-context-compaction.js';

type CompactionPhase = 'running' | ContextCompactionOutcome['kind'];

function ContextCompactionStory(props: { phase: CompactionPhase }) {
  const toastApi = useToast();
  const uiLocale = useUiLocale();
  const presentation = useMemo(
    () =>
      createContextCompactionPresentation({
        toastApi,
        presentTerminal(_sessionId, notice) {
          toastApi.toast({ ...notice, variant: notice.level, duration: 0 });
        },
      }),
    [toastApi],
  );

  useEffect(() => {
    if (props.phase === 'running') {
      presentation.started('storybook-session', 'storybook-turn', uiLocale);
      return;
    }
    const outcome: ContextCompactionOutcome =
      props.phase === 'compacted'
        ? { kind: 'compacted', checkpointId: 'storybook-checkpoint' }
        : props.phase === 'unchanged'
          ? { kind: 'unchanged', reason: 'already_compacted' }
          : { kind: 'failed', reason: 'summarizer_failed' };
    presentation.finished('storybook-session', 'storybook-turn', outcome, uiLocale);
  }, [presentation, props.phase, uiLocale]);

  return <div className="h-screen w-screen bg-background text-foreground" />;
}

const meta = {
  title: 'Product/Context Compaction',
  component: ContextCompactionStory,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <ToastProvider>
        <Story />
      </ToastProvider>
    ),
  ],
} satisfies Meta<typeof ContextCompactionStory>;

export default meta;

type Story = StoryObj<typeof meta>;

// Real path: task menu or `/compact` → Runtime Host accepts the compaction run.
export const Running: Story = {
  args: { phase: 'running' },
};

// Real path: an accepted compaction run writes a new checkpoint and completes.
export const Compacted: Story = {
  args: { phase: 'compacted' },
};

// Real path: an accepted compaction run finds the latest checkpoint already active.
export const Unchanged: Story = {
  args: { phase: 'unchanged' },
};

// Real path: an accepted compaction run cannot produce or persist a valid checkpoint.
export const Failed: Story = {
  args: { phase: 'failed' },
};
