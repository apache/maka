import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ArtifactRecord } from '@maka/core';
import { ToastProvider } from '@maka/ui';
import { ArtifactPane } from '../src/renderer/artifact-pane';
import { withScopedMakaBridge } from './maka-bridge';

// Fidelity convention (#1433): every story below names the real app path
// that reaches it. See apps/desktop/stories/FIDELITY.md.

const NOW = Date.UTC(2026, 6, 31, 10, 30, 0);

const records: ArtifactRecord[] = [
  {
    id: 'artifact-patch',
    sessionId: 'session-artifacts',
    turnId: 'turn-review',
    createdAt: NOW,
    name: 'slice-9-conversation.diff',
    kind: 'diff',
    relativePath: 'session-artifacts/slice-9-conversation.diff',
    sizeBytes: 4_812,
    mimeType: 'text/x-diff',
    source: 'tool_result',
    status: 'live',
  },
  {
    id: 'artifact-notes',
    sessionId: 'session-artifacts',
    turnId: 'turn-review',
    createdAt: NOW - 60_000,
    name: 'conversation-review-notes-with-a-deliberately-long-name.md',
    kind: 'file',
    relativePath: 'session-artifacts/conversation-review-notes.md',
    sizeBytes: 1_284,
    mimeType: 'text/markdown',
    source: 'tool_result',
    status: 'live',
  },
];

const textById: Record<string, string> = {
  'artifact-patch': [
    'diff --git a/packages/ui/src/chat-turn.tsx b/packages/ui/src/chat-turn.tsx',
    '--- a/packages/ui/src/chat-turn.tsx',
    '+++ b/packages/ui/src/chat-turn.tsx',
    '@@ -1,3 +1,4 @@',
    '+import { ChatMessage, ChatMessageBubble } from "@astryxdesign/core";',
    '-<Bubble variant="assistant">',
    '+<ChatMessageBubble variant="ghost">',
  ].join('\n'),
  'artifact-notes': '# Conversation review\n\n- Long transcript\n- Expanded processing\n- Narrow viewport',
};

const withArtifactBridge = withScopedMakaBridge({
  artifacts: {
    list: async () => records,
    get: async (artifactId: string) => records.find((record) => record.id === artifactId) ?? null,
    readText: async (artifactId: string) => ({ ok: true, text: textById[artifactId] ?? '' }),
    readBinary: async () => ({ ok: false, reason: 'unsupported_mime' }),
    delete: async () => undefined,
    subscribeChanges: () => () => undefined,
  },
  app: {
    openArtifactPath: async () => ({ ok: true, opened: 'artifact-patch' }),
    saveArtifactAs: async () => ({ ok: true, saved: 'slice-9-conversation.diff' }),
  },
});

const meta = {
  title: 'Product/Artifact Pane',
  decorators: [withArtifactBridge],
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

// Real path: conversation workbar → Files. The latest artifact is selected,
// with the real listbox, preview, and action toolbar visible at workbar width.
export const Populated: Story = {
  render: () => (
    <div
      data-maka-e2e-fixture="true"
      style={{
        width: 440,
        height: 720,
        maxWidth: '100vw',
        background: 'var(--background)',
        borderInlineStart: '1px solid var(--border)',
      }}
    >
      <ToastProvider>
        <ArtifactPane sessionId="session-artifacts" />
      </ToastProvider>
    </div>
  ),
};
