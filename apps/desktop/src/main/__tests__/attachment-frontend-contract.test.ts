import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AttachmentRef, SessionSummary, StoredMessage } from '@maka/core';
import { ChatView, LocaleProvider } from '@maka/ui';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

const REPO_ROOT = process.cwd().endsWith('apps/desktop')
  ? resolve(process.cwd(), '..', '..')
  : process.cwd();

function renderWithLocale(child: ReactNode): string {
  return renderToStaticMarkup(
    createElement(LocaleProvider, { locale: 'zh', children: child }),
  );
}

async function readRepo(relativePath: string): Promise<string> {
  return readFile(resolve(REPO_ROOT, relativePath), 'utf8');
}

describe('attachment frontend contract', () => {
  it('global file-drop navigation guard lets explicit renderer import targets handle drag/drop', async () => {
    const mainWindow = await readRepo('apps/desktop/src/main/main-window.ts');
    const composer = await readRepo('packages/ui/src/composer.tsx');

    assert.match(
      mainWindow,
      /closest\('\[data-maka-file-drop-target="true"\]'\)/,
      'BrowserWindow capture guard must skip declared file-drop targets so React drop handlers can ingest files',
    );
    assert.match(
      composer,
      /data-maka-file-drop-target=\{canAcceptDroppedFiles\(\) \? 'true' : undefined\}/,
      'Composer must declare itself as a file-drop target only while attachment import is available',
    );
  });

  it('dragged/pasted blobs are sent as bytes and never round-trip a renderer path', async () => {
    const preload = await readRepo('apps/desktop/src/preload/preload.ts');
    const globals = await readRepo('apps/desktop/src/global.d.ts');
    const bridge = await readRepo('apps/desktop/src/preload/bridge-contract.d.ts');
    const chatActions = await readRepo('apps/desktop/src/renderer/app-shell-chat-actions.ts');

    // No webUtils.getPathForFile: a renderer-supplied path is untrustworthy.
    assert.doesNotMatch(preload, /webUtils/);
    // preload encodes File blobs to bytes via the shared encoder before IPC.
    assert.match(preload, /encodeIngestItems/);
    // sessions.send carries attachmentItems (File or approvalId), not pre-ingested refs.
    assert.match(globals, /maka: MakaBridge/);
    assert.match(bridge, /attachmentItems\?: RendererIngestInput\[\]/);
    // renderer maps pending attachments to ingest items at send time.
    assert.match(chatActions, /toIngestItems\(pending\)/);
    assert.match(chatActions, /sessions\.send[\s\S]*attachmentItems/);
  });

  it('new-chat composer stages attachments via opaque approval tokens and ingests at send time', async () => {
    const preload = await readRepo('apps/desktop/src/preload/preload.ts');
    const globals = await readRepo('apps/desktop/src/preload/bridge-contract.d.ts');
    const appShell = await readRepo('apps/desktop/src/renderer/app-shell.tsx');
    const chatActions = await readRepo('apps/desktop/src/renderer/app-shell-chat-actions.ts');

    // pickFiles returns opaque approval tokens, never a path.
    assert.match(preload, /pickFiles\(\): Promise<[\s\S]*files: \{ approvalId: string; name: string/);
    assert.match(globals, /pickFiles\(\): Promise<[\s\S]*files: \{ approvalId: string; name: string/);
    // No pre-send session creation.
    assert.doesNotMatch(appShell, /ensureAttachmentSession/);
    // pending attachments are carried as items in sessions.send, ingested main-side at send time.
    assert.match(chatActions, /toIngestItems\(pending\)/);
    assert.match(chatActions, /sessions\.send[\s\S]*attachmentItems/);
    assert.match(
      appShell,
      /onPickAttachments=\{[\s\S]*revisionDraft && activeId === revisionDraft\.draftSessionId[\s\S]*\? undefined[\s\S]*: pickAttachments/,
      'ordinary composers keep the picker, while a revision owner cannot silently add unsupported attachments',
    );
    assert.match(
      appShell,
      /onAttachFilePaths=\{[\s\S]*revisionDraft && activeId === revisionDraft\.draftSessionId[\s\S]*\? undefined[\s\S]*: attachFilePaths/,
      'ordinary composers keep drop/paste import, while a revision owner stays text-only',
    );
  });

  it('passes selected model vision capability to the runtime attachment renderer', async () => {
    // modelSupportsVision + the ai-sdk backend wiring moved into session-stream.ts
    // (arch R5); scan the combined main-process source so the pins follow the split.
    const main = await readMainProcessCombinedSource();

    assert.match(
      main,
      /function modelSupportsVision\(connection: LlmConnection, model: string\): boolean/,
      'main must derive image-input support from the selected model before wiring AiSdkBackend',
    );
    assert.match(
      main,
      /resolveModelVisionSupport\(connection\.providerType, connection\.models, model\)/,
      'vision support must consult stored capabilities, then fall back to in-repo metadata for bare-id models (provider /models responses do not return image capability)',
    );
    assert.match(
      main,
      /const supportsVision = modelSupportsVision\(connection, model\)/,
      'main must evaluate the selected model vision capability in the ai-sdk backend path',
    );
    assert.match(
      main,
      /\bsupportsVision,\s*\n/,
      'AiSdkBackend must always receive the resolved vision support (true = send image parts, false = fallback notice)',
    );
  });

  it('snapshots Read images and notifies the existing artifact preview flow', async () => {
    // Read image snapshotting moved into tool-artifact-persistence.ts and the
    // builtin-tool wiring into tool-assembly.ts (arch R4); `storeReadImage`
    // stays in main.ts. The combined main-process source spans all three.
    const main = await readMainProcessCombinedSource();
    const artifactAttachments = await readRepo('packages/storage/src/artifact-attachments.ts');

    assert.match(main, /snapshotImage: snapshotReadImage/);
    assert.match(main, /const storeReadImage = createReadImageSnapshotter\(artifactStore\)/);
    assert.match(artifactAttachments, /kind: 'image'[\s\S]*source: 'tool_result'/);
    assert.match(main, /async function snapshotReadImage[\s\S]*safeSendToRenderer\('artifacts:changed'/);
  });

  it('renders user image attachments inside the chat turn stream', () => {
    const attachment: AttachmentRef = {
      kind: 'image',
      name: 'clipboard.png',
      mimeType: 'image/png',
      bytes: 4,
      ref: { kind: 'session_file', sessionId: 's1', relativePath: 'artifact-1' },
    };
    const messages: StoredMessage[] = [
      { type: 'user', id: 'u1', turnId: 't1', ts: 1, text: '看这张图', attachments: [attachment] },
    ];
    const activeSession: SessionSummary = {
      id: 's1',
      name: 'Attachment check',
      isFlagged: false,
      isArchived: false,
      labels: [],
      hasUnread: false,
      status: 'active',
      backend: 'ai-sdk',
      llmConnectionSlug: 'fixture',
      connectionLocked: false,
      model: 'fixture-model',
      permissionMode: 'ask',
    };

    const markup = renderWithLocale(createElement(ChatView, {
      messages,
      activeSession,
      onNew: () => {},
    } satisfies Parameters<typeof ChatView>[0]));

    assert.match(markup, /maka-user-attachments/);
    assert.match(markup, /maka-user-attachment-thumb-pending/);
  });
});

// #546 Phase B — attachment visual token/radius convergence.
// The attachment thumbnail (chat-view) and file card (composer + sent turn)
// used raw shadcn semantic classes (`bg-muted`, `border-border`,
// `text-muted-foreground/60`) and the deprecated `rounded-lg` alias, off the
// maka surface-alpha + radius-token system every other chat surface uses.
// These assertions pin the converged form so the surfaces cannot drift back.
describe('attachment visual token governance (#546)', () => {
  it('image thumbnail placeholder uses maka surface-alpha + radius tokens, not shadcn aliases', async () => {
    const chatTurn = await readRepo('packages/ui/src/chat-turn.tsx');
    const m = chatTurn.match(/maka-user-attachment-thumb-pending[^"]*/);
    assert.ok(m, 'pending thumbnail className not found — component renamed?');
    const cls = m[0];
    // No raw shadcn surface aliases — the card next to it uses --foreground-alpha-*.
    assert.doesNotMatch(cls, /\bbg-muted\b/, 'use bg-[var(--foreground-alpha-6)], not bg-muted');
    assert.doesNotMatch(cls, /\bborder-border\b/, 'use border-[var(--border)], not border-border');
    // No magic alpha stacked on the 50%-ink muted token (dips below the contrast floor).
    assert.doesNotMatch(cls, /muted-foreground\/\d+/, 'drop the /NN alpha; use a clean --muted-foreground');
    // No deprecated rounded-lg alias.
    assert.doesNotMatch(cls, /\brounded-lg\b/, 'rounded-lg is the deprecated surface alias; use rounded-md');
    assert.match(cls, /bg-\[var\(--foreground-alpha-6\)\]/, 'surface fill must be the shared --foreground-alpha-6 token');
    assert.match(cls, /\brounded-md\b/, 'thumbnail is a surface — rounded-md (8px)');
  });

  it('file card nests radius tiers concentrically and stays off deprecated aliases', async () => {
    const card = await readRepo('packages/ui/src/attachment-file-card.tsx');
    // Whole file is the attachment card, so file-wide assertions are safe.
    assert.doesNotMatch(card, /\brounded-lg\b/, 'rounded-lg is the deprecated surface alias; use rounded-md');
    assert.doesNotMatch(card, /\bbg-muted\b/, 'surface fills use --foreground-alpha-*, not bg-muted');
    // Outer card = surface (8px); inner icon tile + remove button = control (6px),
    // so the nested corners read concentric instead of matching the outer radius.
    assert.match(card, /\brounded-md\b/, 'outer card surface must be rounded-md (8px)');
    assert.match(card, /\brounded-sm\b/, 'inner tile + control button must be rounded-sm (6px), tighter than the card');
  });
});
