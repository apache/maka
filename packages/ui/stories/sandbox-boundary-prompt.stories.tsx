import type { SandboxBoundaryRequestEvent } from '@maka/core';
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

// Real path: an Auto session requests the maximum 32 filesystem entries; every
// entry stays inspectable while the decision buttons remain in the composer slot.
export const MaximumFilesystemEntries: Story = {
  args: {
    request: {
      ...filesystemAndNetworkRequest,
      id: 'boundary-event-3',
      requestId: 'boundary-request-3',
      justification: '读取发布清单中列出的外部文件，以完成本次会话的校验。',
      expansion: {
        filesystem: {
          entries: Array.from({ length: 32 }, (_, index) => ({
            path: `/Users/maka/release/manifests/component-${String(index + 1).padStart(2, '0')}/artifact-with-a-long-name.json`,
            access: 'read' as const,
            scope: 'exact' as const,
          })),
        },
      },
    },
    onRespond: async () => {},
  },
};
