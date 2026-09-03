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

import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import type { ArtifactDescriptor } from '@maka/core/artifacts';
import { ToastProvider } from '@maka/ui';
import {
  createFakeWorkbarServices,
  createSessionWorkbarPanelsState,
  createSessionWorkbarTabsState,
  openStaticSessionWorkbarTab,
  terminalSessionWorkbarTabId,
  WorkbarServicesProvider,
  type WorkbarServices,
} from '../src/renderer/features/workbar/testing';
import { WorkbarSurface } from '../src/renderer/features/workbar/stories';
import { RemoteProjectDirectoryDialog } from '../src/renderer/remote-project-directory-dialog';
import { RuntimeHostSshTerminalDialog } from '../src/renderer/settings/runtime-host-ssh-terminal-dialog';
import { withScopedMakaBridge } from './maka-bridge';

const meta = {
  title: 'Product/Accessibility Runtime Surfaces',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const unsubscribe = () => () => undefined;
const noop = () => undefined;
const terminalWrite = fn(async () => null);
const sshWrite = fn(async () => undefined);
const browserNavigate = fn(async () => undefined);
const registerDirectory = fn(async () => ({
  id: 'project-storybook',
  name: 'maka-agent',
  locations: [{ path: '/workspace/maka-agent', isWorktree: false }],
  available: true,
}));

function withWorkbarServices(overrides: Partial<WorkbarServices>): Decorator {
  const services = createFakeWorkbarServices(overrides);
  return (Story) => (
    <WorkbarServicesProvider services={services}>
      <Story />
    </WorkbarServicesProvider>
  );
}

function WorkbarToolSurface(props: { kind: 'terminal' | 'browser' | 'files' }) {
  const terminalRef = 'pty:storybook';
  const right = props.kind === 'terminal'
    ? createSessionWorkbarTabsState(
        [{
          id: terminalSessionWorkbarTabId(terminalRef),
          kind: 'terminal',
          resourceRef: terminalRef,
          ownerSessionId: 'runtime-surface',
        }],
        terminalSessionWorkbarTabId(terminalRef),
      )
    : openStaticSessionWorkbarTab(createSessionWorkbarTabsState(), props.kind);
  return (
    <ToastProvider>
      <div
        className="maka-detail-with-artifacts"
        style={{ height: 520, width: 720 }}
      >
        <div className="mainColumn" />
        <WorkbarSurface
          sessionId="runtime-surface"
          hidden={false}
          onDismissPanel={noop}
          panelsState={createSessionWorkbarPanelsState(right)}
          rightCollapsed={false}
          bottomOpen={false}
          onActivateTab={noop}
          onCloseTab={noop}
          onCloseTabs={noop}
          onReorderTab={noop}
          onMoveTab={noop}
          onMoveTabToPanel={noop}
          onPinTab={noop}
          onOpenLauncher={noop}
          onRequestOpenTab={noop}
          confirmBypass={async () => true}
        />
      </div>
    </ToastProvider>
  );
}

export const ActiveTerminal: Story = {
  decorators: [
    withWorkbarServices({
      terminal: {
        start: async () => {
          throw new Error('not used by this story');
        },
        stop: async () => null,
        attach: async () => ({
          sessionId: 'runtime-surface',
          ref: 'pty:storybook',
          sequence: 1,
          buffer: '$ npm test\nPASS 42 tests\n',
          size: { cols: 80, rows: 24 },
        }),
        detach: async () => undefined,
        write: terminalWrite,
        subscribePtyData: unsubscribe,
        subscribeResync: unsubscribe,
      },
    }),
  ],
  render: () => (
    <WorkbarToolSurface kind="terminal" />
  ),
  play: async ({ canvasElement }) => {
    await waitFor(
      () => {
        expect(canvasElement.querySelector('.xterm-accessibility-tree')).not.toBeNull();
      },
      { timeout: 10_000 },
    );
    terminalWrite.mockClear();
    const input = canvasElement.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
    expect(input).not.toBeNull();
    input?.focus();
    await userEvent.keyboard('echo ready');
    await waitFor(() => expect(terminalWrite).toHaveBeenCalled());
  },
};

export const RuntimeHostSshTerminal: Story = {
  decorators: [
    withScopedMakaBridge({
      runtimeHostSshTerminal: {
        getSnapshot: async () => ({
          kind: 'connecting',
          revision: 1,
          sessionId: 'ssh-storybook',
          output: 'Connecting to build-host...\n',
        }),
        write: sshWrite,
        resize: async () => undefined,
        cancel: async () => undefined,
        subscribe: unsubscribe,
      },
    }),
  ],
  render: () => <RuntimeHostSshTerminalDialog />,
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement.ownerDocument.body).findByRole('dialog', {
        name: '连接远程 Runtime Host',
      }),
    ).resolves.toBeTruthy();
    await waitFor(
      () => {
        expect(canvasElement.ownerDocument.querySelector('.xterm-accessibility-tree')).not.toBeNull();
      },
      { timeout: 10_000 },
    );
    sshWrite.mockClear();
    const input = canvasElement.ownerDocument.querySelector<HTMLTextAreaElement>(
      '.settingsRuntimeHostSshTerminalDialog .xterm-helper-textarea',
    );
    expect(input).not.toBeNull();
    input?.focus();
    await userEvent.keyboard('yes');
    await waitFor(() => expect(sshWrite).toHaveBeenCalledWith('ssh-storybook', expect.any(String)));
  },
};

export const BrowserLoaded: Story = {
  decorators: [
    withWorkbarServices({
      browser: {
        setActiveSession: () => undefined,
        getState: async () => ({
          url: 'https://example.com/dashboard',
          title: 'Example Dashboard',
          canGoBack: true,
          canGoForward: false,
          loading: false,
          favicon: null,
          secure: true,
          hasPage: true,
        }),
        subscribeState: unsubscribe,
        subscribeLive: unsubscribe,
        setViewport: () => undefined,
        back: async () => undefined,
        forward: async () => undefined,
        stop: async () => undefined,
        reload: async () => undefined,
        close: async () => undefined,
        navigate: browserNavigate,
      },
    }),
  ],
  render: () => <WorkbarToolSurface kind="browser" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const address = await canvas.findByRole('textbox', { name: '浏览器地址' });
    await waitFor(
      () => {
        expect(address).toHaveValue('https://example.com/dashboard');
      },
      { timeout: 10_000 },
    );
    await expect(canvas.findByRole('button', { name: '浏览器后退' })).resolves.toBeEnabled();
    browserNavigate.mockClear();
    await userEvent.clear(address);
    await userEvent.type(address, 'openai.com{enter}');
    await waitFor(() =>
      expect(browserNavigate).toHaveBeenCalledWith(
        'runtime-surface',
        'https://openai.com/',
      ));
  },
};

const htmlArtifact: ArtifactDescriptor = {
  id: 'html-storybook',
  sessionId: 'runtime-surface',
  turnId: 'turn-html',
  createdAt: Date.UTC(2026, 7, 18),
  name: 'agent-report.html',
  kind: 'html',
  sizeBytes: 256,
  mimeType: 'text/html',
  source: 'fixture',
  status: 'live',
};

function RemoteProjectDirectoryStory() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
        选择远程项目目录
      </button>
      <RemoteProjectDirectoryDialog
        host={open
          ? { profileId: 'remote', hostId: 'build-host', name: 'Build Host' }
          : undefined}
        returnFocusTo={triggerRef.current}
        onClose={() => setOpen(false)}
        onRegistered={() => setOpen(false)}
      />
    </>
  );
}

export const HtmlArtifact: Story = {
  decorators: [
    withWorkbarServices({
      artifacts: {
        list: async () => [htmlArtifact],
        readText: async () => ({
          ok: true,
          text: [
            '<!doctype html><html><body>',
            '<label for="query">Report query</label>',
            '<input id="query" value="accessibility">',
            '<button type="button">Run report</button>',
            '</body></html>',
          ].join(''),
        }),
        readBinary: async () => ({ ok: false, reason: 'unsupported_mime' }),
        delete: async () => undefined,
        subscribeChanges: unsubscribe,
        openPath: async () => ({ ok: false, reason: 'missing' }),
        saveAs: async () => ({ ok: false, reason: 'canceled' }),
      },
    }),
  ],
  render: () => <WorkbarToolSurface kind="files" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('option', { name: /agent-report\.html/ }),
    );
    const frame = await canvas.findByTitle('生成文件预览 · agent-report.html');
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(frame).toHaveAttribute('srcdoc', expect.stringContaining('Run report'));
  },
};

export const RemoteProjectDirectory: Story = {
  decorators: [
    withScopedMakaBridge({
      projects: {
        getDirectoryRoots: async () => [{ id: 'workspace', label: 'Workspace' }],
        listDirectory: async ({ segments }: { segments: readonly string[] }) =>
          segments.length === 0
            ? [{ name: 'maka-agent' }, { name: '.cache' }]
            : [{ name: 'apps' }, { name: 'packages' }],
        registerDirectory,
      },
    }),
  ],
  render: () => <RemoteProjectDirectoryStory />,
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const trigger = body.getByRole('button', { name: '选择远程项目目录' });
    trigger.focus();
    await expect(trigger).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    const dialog = await body.findByRole('dialog', { name: /Build Host/ });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'maka-agent' }));
    await expect(within(dialog).findByRole('button', { name: 'apps' })).resolves.toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: /显示隐藏/ }));
    await expect(within(dialog).getByRole('button', { name: '不显示隐藏目录' })).toBeTruthy();
    registerDirectory.mockClear();
    await userEvent.click(within(dialog).getByRole('button', { name: '添加此文件夹' }));
    await waitFor(() =>
      expect(registerDirectory).toHaveBeenCalledWith(
        { rootId: 'workspace', segments: ['maka-agent'] },
        expect.objectContaining({ profileId: 'remote', hostId: 'build-host' }),
      ));
    await waitFor(() =>
      expect(body.queryByRole('dialog', { name: /Build Host/ })).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    await userEvent.click(trigger);
    await expect(body.findByRole('dialog', { name: /Build Host/ })).resolves.toBeTruthy();
  },
};
