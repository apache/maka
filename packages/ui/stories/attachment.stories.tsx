import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import type { AttachmentRef } from '@maka/core/events';
import type { SessionSummary, StoredMessage } from '@maka/core/session';
import { ChatSurfaceLayout, ChatView, Composer } from '../src/components.js';
import type { ChatModelChoice } from '../src/chat-model-helpers.js';

const NOW = Date.UTC(2026, 6, 1, 9, 30, 0);

// 64x64 solid-color PNGs so the thumbnail/lightbox actually show an image
// (the story feeds them through the injected `onReadAttachmentBytes` reader below).
const RED_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAACv0lEQVR4nO3TMQ0AMAzAsELcPcSDNRg9YskA8mTeuZA16wWwyACkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSPvHHhWvMw1VrQAAAABJRU5ErkJggg==';
const BLUE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAACwElEQVR4nO3TMQ0AMAzAsEIckuEcrMHoEUsGkCdz7oOsWS+ARQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQNoHahEW2x9npg0AAAAASUVORK5CYII=';

// @maka/ui is host-agnostic: image thumbnails read bytes through the injected
// `onReadAttachmentBytes` prop, not a host global. The story supplies a fake
// reader that echoes the two solid-color PNGs above.
const mockReadBytes = async (_sessionId: string, relativePath: string) => ({
  ok: true as const,
  base64: relativePath.includes('metrics') ? BLUE_PNG : RED_PNG,
  mimeType: 'image/png',
});

// Fidelity convention (#1433): every story below names the real app path
// that reaches it. See apps/desktop/stories/FIDELITY.md.

const meta = {
  title: 'Product/Attachments',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;
type ComposerProps = ComponentProps<typeof Composer>;
type ChatViewProps = ComponentProps<typeof ChatView>;

const modelChoices: ChatModelChoice[] = [
  { connectionSlug: 'anthropic-main', providerType: 'anthropic', providerLabel: 'Anthropic', model: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', isDefault: true, thinkingLevels: [] },
];

function noop() {
  return undefined;
}

function session(o: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's',
    name: '附件展示',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    lastMessageAt: NOW,
    lastMessagePreview: '帮我看下这几个文件。',
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'anthropic-main',
    connectionLocked: false,
    model: 'claude-sonnet-4-5',
    permissionMode: 'ask',
    ...o,
  };
}

function attachment(kind: AttachmentRef['kind'], name: string, mimeType: string, bytes = 1024): AttachmentRef {
  return { kind, name, mimeType, bytes, ref: { kind: 'session_file', sessionId: 's', relativePath: name } };
}

const imageAttachment = attachment('image', 'dashboard.png', 'image/png', 480_000);
const metricsAttachment = attachment('image', 'metrics.png', 'image/png', 920_000);
const pdfAttachment = attachment('pdf', 'design-spec.pdf', 'application/pdf', 512_000);
const docAttachment = attachment('doc', '周报.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 128_000);
const codeAttachment = attachment('code', 'handler.ts', 'text/typescript', 4_096);
const otherAttachment = attachment('other', 'archive.zip', 'application/zip', 88_000);

const baseComposer: ComposerProps = {
  draftKey: 'storybook-attachments',
  onSend: noop,
  onStop: noop,
  modelLabel: 'Claude Sonnet 4.5',
  activeSession: session(),
  activeConnectionLabel: 'Anthropic',
  activeModel: 'claude-sonnet-4-5',
  activeModelLabel: 'Claude Sonnet 4.5',
  modelChoices,
  permissionMode: 'ask',
  onPermissionModeChange: noop,
  onPickAttachments: noop,
  onAttachFilePaths: noop,
};

const baseChat: ChatViewProps = {
  messages: [],
  scrollBehavior: 'smooth',
  activeSession: session(),
  activeConnectionLabel: 'Anthropic',
  activeModel: 'claude-sonnet-4-5',
  activeModelLabel: 'Claude Sonnet 4.5',
  modelChoices,
  userLabel: '你',
  onReadAttachmentBytes: mockReadBytes,
  onNew: noop,
  onPromptSuggestion: noop,
};

function user(id: string, turnId: string, text: string, attachments: AttachmentRef[]): StoredMessage {
  return { type: 'user', id, turnId, ts: NOW, text, attachments };
}

function Frame({ children, width = 960 }: { children: React.ReactNode; width?: number }) {
  return (
    <div
      style={{
        width,
        maxWidth: 'calc(100vw - 48px)',
        margin: '0 auto',
        background: 'var(--background)',
        display: 'flex',
        minHeight: 360,
      }}
    >
      {children}
    </div>
  );
}

function AttachmentChat(props: ComponentProps<typeof ChatView>) {
  return (
    <ChatSurfaceLayout composer={null}>
      <ChatView {...props} />
    </ChatSurfaceLayout>
  );
}

// Real path: composer → ＋ → attach files → the pending chips before the message is sent.
export const ComposerPendingChips: Story = {
  render: () => (
    <Frame>
      <div style={{ padding: '0 24px 24px', width: '100%' }}>
      <Composer
        {...baseComposer}
        draftKey="composer-pending-chips"
        pendingAttachments={[
          { displayName: 'chart.png', kind: 'image', mimeType: 'image/png', size: 480_000 },
          { displayName: 'design-spec.pdf', kind: 'pdf', mimeType: 'application/pdf', size: 512_000 },
          { displayName: 'handler.ts', kind: 'code', mimeType: 'text/typescript', size: 4_096 },
          { displayName: 'archive.zip', kind: 'other', mimeType: 'application/zip', size: 88_000 },
        ]}
        onRemoveAttachment={noop}
      />
      </div>
    </Frame>
  ),
};

// Real path: send a message with attachments → the chips as they render inside the sent
// turn.
export const ChatAttachmentChips: Story = {
  render: () => (
    <Frame>
      <AttachmentChat
        {...baseChat}
        messages={[user('u1', 't1', '帮我看下这几个文件，哪些要改。', [pdfAttachment, docAttachment, codeAttachment, otherAttachment])]}
      />
    </Frame>
  ),
};

// Real path: attach images → their thumbnails in the sent turn.
export const ImageThumbnails: Story = {
  render: () => (
    <Frame>
      <AttachmentChat
        {...baseChat}
        messages={[user('u2', 't2', '这两张截图帮我对比一下。', [imageAttachment, metricsAttachment])]}
      />
    </Frame>
  ),
};

// Real path: send one prompt with every durable reference kind → file tokens sit
// above the bubble, while inline Skill/file tokens, quote and image keep their own hierarchy.
// The narrow frame verifies wrapping without inventing a second product layout.
export const SentReferenceHierarchy: Story = {
  render: () => (
    <Frame width={420}>
      <AttachmentChat
        {...baseChat}
        messages={[{
          type: 'user',
          id: 'u3',
          turnId: 't3',
          ts: NOW,
          text: '请用 /skill:writer 对照 @packages/ui/src/chat-turn.tsx 检查这些材料。',
          inlineReferences: [
            { kind: 'skill', value: '/skill:writer', label: 'writer', start: 3 },
            {
              kind: 'workspace_file',
              value: '@packages/ui/src/chat-turn.tsx',
              label: 'chat-turn.tsx',
              start: 20,
            },
          ],
          attachments: [pdfAttachment, codeAttachment, imageAttachment],
          quotes: [{
            text: 'Inline references preserve the exact Composer token after send and reload.',
            label: 'Architecture note',
            sourceTurnId: 't2',
          }],
        }]}
      />
    </Frame>
  ),
};
