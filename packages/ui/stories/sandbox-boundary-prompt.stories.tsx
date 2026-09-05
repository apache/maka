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

import type { SandboxBoundaryRequestEvent } from '@maka/core/events';
import type { Meta, StoryObj } from '@storybook/react-vite';

import { SandboxBoundaryPrompt } from '../src/sandbox-boundary-prompt.js';

// Product-level stories document the real shipped path that reaches each state.
// See apps/desktop/stories/FIDELITY.md.

const meta = {
  title: 'Product/Sandbox Boundary Prompt',
  component: SandboxBoundaryPrompt,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <div style={{ minHeight: '100vh', padding: '48px 24px', background: 'var(--surface-canvas)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SandboxBoundaryPrompt>;

export default meta;

type Story = StoryObj<typeof meta>;

const filesystemAndNetworkRequest = {
  id: 'boundary-event-1',
  turnId: 'turn-1',
  ts: Date.now(),
  type: 'sandbox_boundary_request',
  requestId: 'boundary-request-1',
  toolUseId: 'tool-1',
  justification: '下载构建依赖，并把产物写入工作区外的发布目录。',
  expansion: {
    filesystem: {
      entries: [
        { path: '/Users/maka/release', access: 'write', scope: 'subtree' },
        { path: '/Users/maka/.config/signing.json', access: 'read', scope: 'exact' },
      ],
    },
    network: { enabled: true },
  },
} satisfies SandboxBoundaryRequestEvent;

// Real path: an Auto session calls request_sandbox_boundary after a tool reports
// sandbox_boundary_required; the prompt takes over the composer slot.
export const FilesystemAndNetwork: Story = {
  args: {
    request: filesystemAndNetworkRequest,
    onRespond: async () => {},
  },
};

// Real path: the same Auto-session prompt when the requested expansion enables
// network access without adding filesystem entries.
export const NetworkOnly: Story = {
  args: {
    request: {
      ...filesystemAndNetworkRequest,
      id: 'boundary-event-2',
      requestId: 'boundary-request-2',
      justification: '访问远程 API 以完成当前会话。',
      expansion: {
        network: { enabled: true },
      },
    },
    onRespond: async () => {},
  },
};

