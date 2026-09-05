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

/**
 * The composer's `/` menu, on the real Composer with the real Desktop command
 * derivation behind it.
 *
 * Fidelity convention (#1433): app-shell.tsx renders this Composer with
 * `slashCommands` derived from the catalog and `mentionSkills` from Runtime's
 * invocable projection through `ComposerMentionsProvider`. The projection is
 * the real one here, over a bridge that answers the way IPC does; the command
 * list is assembled from the same authorities (see below). See FIDELITY.md.
 *
 * A browser, not a DOM shim: what these assert is where the caret is, which
 * text node it sits in, and whether Astryx's patched `useTriggerMenu` reads a
 * boundary in front of it (`patches/@astryxdesign+core+0.5.2.patch`). None of
 * that exists without a real Selection.
 */

import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { slashCommandsForSurface } from '@maka/core/slash-command-catalog';
import { Composer } from '@maka/ui';
import {
  ComposerMentionsProvider,
  useComposerMentionsContext,
} from '../src/renderer/composer-mentions';
import { desktopSlashCommandAvailability } from '../src/renderer/desktop-slash-command';
import { getShellCopy } from '../src/renderer/locales/shell-copy';
import { withScopedMakaBridge } from './maka-bridge';

const COMPOSER_INPUT = '.maka-composer-editor [contenteditable="true"]';
const MENU_LABEL = '命令和技能';
const SESSION_ID = 'session-slash-menu';

/**
 * What app-shell.tsx builds for `slashCommands`, from the same three
 * authorities: the catalog, the availability predicate, and the shell's copy.
 * The keywords and the icon it also attaches are pure presentation and nothing
 * below reads them.
 *
 * Assembled here rather than lifted into `desktop-slash-command.ts`, for the
 * reason #4762 gave for leaving the catalog query in app-shell: the debt
 * ratchet counts dependencies per file, so moving the catalog import into the
 * smaller module books a new dependency there instead of retiring one.
 */
function slashCommandOptions(state: { hasSession: boolean; streaming: boolean }) {
  const copy = getShellCopy('zh-CN').app.slashCommands;
  return slashCommandsForSurface('desktop')
    .filter(desktopSlashCommandAvailability(state))
    .map(({ id }) => ({ id, ...copy[id] }));
}

/** What Runtime's invocable projection answers for this Session. */
const invocableSkills = [
  { ref: 'project/project-only', id: 'project-only', name: 'Project Only', description: 'Project-scoped suggestion.' },
  { ref: 'workspace/workspace-only', id: 'workspace-only', name: 'Workspace Only', description: 'Maka workspace suggestion.' },
];

/** Publish a Session 'updated' event, the way a thinking-level change does. */
let publishSessionUpdate: (() => void) | undefined;
/** Projection loads served so far, so a story can wait for one to land. */
let projectionLoads = 0;

/**
 * The bridge `useComposerMentions` reads. A fresh array per call on purpose:
 * a real IPC round trip never hands back the object it handed back last time,
 * so holding the projection's identity steady is work the renderer has to do.
 */
const loadProjection = async () => {
  projectionLoads += 1;
  return invocableSkills.map((skill) => ({ ...skill }));
};

const makaBridge = {
  skills: { listInvocable: loadProjection },
  newTasks: {
    listInvocableSkills: loadProjection,
    searchFiles: async () => ({ ok: true, files: [] }),
    subscribeChanges: () => () => {},
  },
  sessions: {
    subscribeChanges(listener: (event: { sessionId: string; reason: string }) => void) {
      publishSessionUpdate = () => listener({ sessionId: SESSION_ID, reason: 'updated' });
      return () => {
        publishSessionUpdate = undefined;
      };
    },
  },
  mcp: { subscribeChanges: () => () => {} },
  workspace: { searchFiles: async () => ({ ok: true, files: [] }) },
};

function SlashMenuComposer({
  hasSession,
  streaming,
}: {
  hasSession: boolean;
  streaming: boolean;
}): React.ReactElement {
  const mentions = useComposerMentionsContext();
  // Memoized exactly as app-shell.tsx memoizes it: the composer rebuilds its
  // trigger — and with it an open menu — whenever this array's identity moves.
  const slashCommands = useMemo(
    () => slashCommandOptions({ hasSession, streaming }),
    [hasSession, streaming],
  );
  return (
    <Composer
      draftKey="story-slash-menu"
      mentionSkills={mentions?.mentionSkills}
      mentionSkillsUnavailable={mentions?.mentionSkillsUnavailable}
      mentionSkillsLoading={mentions?.mentionSkillsLoading}
      onSearchMentionFiles={mentions?.searchMentionFiles}
      slashCommands={slashCommands}
      onSend={() => {}}
      onStop={() => {}}
    />
  );
}

function SlashMenuHarness({
  hasSession = true,
  streaming = false,
}: {
  hasSession?: boolean;
  streaming?: boolean;
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', height: 520, padding: 24 }}>
      <ComposerMentionsProvider
        skillCatalogRevision={0}
        sessionId={hasSession ? SESSION_ID : undefined}
        projectPath="/workspace/maka-agent"
        newTaskTarget={
          hasSession
            ? undefined
            : { profileId: 'profile-local', hostId: 'host-local', projectId: 'project-maka' }
        }
      >
        <SlashMenuComposer hasSession={hasSession} streaming={streaming} />
      </ComposerMentionsProvider>
    </div>
  );
}

const meta = {
  title: 'Product/Composer Slash Menu',
  component: SlashMenuHarness,
  decorators: [withScopedMakaBridge(makaBridge)],
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof SlashMenuHarness>;

export default meta;

type Story = StoryObj<typeof meta>;

function editor(canvasElement: HTMLElement): HTMLElement {
  const element = canvasElement.querySelector<HTMLElement>(COMPOSER_INPUT);
  if (!element) throw new Error('composer editor is missing');
  return element;
}

/** The popup renders in a layer outside the story canvas. */
function overlay(): ReturnType<typeof within> {
  return within(document.body);
}

async function openMenu(canvasElement: HTMLElement): Promise<HTMLElement> {
  const composer = editor(canvasElement);
  await userEvent.click(composer);
  await userEvent.keyboard('/');
  return overlay().findByRole('listbox', { name: MENU_LABEL });
}

/**
 * Type a `/` into a text node the harness placed itself. Chromium can put the
 * next typed character in a text node of its own, and reproducing that shape is
 * the whole point — `pressSequentially` would let the browser normalize it away.
 */
function typeSlashAtEnd(composer: HTMLElement): void {
  const node = composer.appendChild(document.createTextNode('/'));
  const range = document.createRange();
  range.setStart(node, 1);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  composer.dispatchEvent(
    new InputEvent('input', { bubbles: true, data: '/', inputType: 'insertText' }),
  );
}

/** Characters between the start of the editor and the caret. */
function caretOffset(composer: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection?.focusNode || !composer.contains(selection.focusNode)) return -1;
  const range = document.createRange();
  range.selectNodeContents(composer);
  range.setEnd(selection.focusNode, selection.focusOffset);
  return range.toString().length;
}

// Real path: 主窗口的新任务 composer（还没有 Session）→ 在空草稿开头输入 `/`。
// Only the commands that need no Session are offered; the Skill projection is
// still the second group.
export const BeforeAnySessionExists: Story = {
  args: { hasSession: false },
  play: async ({ canvasElement }) => {
    const menu = await openMenu(canvasElement);
    const commands = within(menu).getByRole('group', { name: '命令' });
    const options = within(commands).getAllByRole('option');
    await expect(options).toHaveLength(2);
    await expect(options.map((option) => option.getAttribute('aria-label') ?? option.textContent))
      .toEqual([expect.stringContaining('/graph'), expect.stringContaining('/swarm')]);
    await expect(within(options[0]!).getByText('使用 Graph')).toBeVisible();
  },
};

// Real path: 打开一个已有 Session → 在 composer 的空草稿开头输入 `/`。
// Commands first, Skills second, and each command row carries the token a user
// would otherwise have to know how to type.
export const InAnActiveSession: Story = {
  play: async ({ canvasElement }) => {
    const menu = await openMenu(canvasElement);
    const groups = within(menu).getAllByRole('group');
    await expect(groups).toHaveLength(2);
    await expect(groups[0]).toHaveAttribute('aria-label', '命令');
    await expect(groups[1]).toHaveAttribute('aria-label', 'Skills');
    await expect(within(groups[0]!).getAllByRole('option')).toHaveLength(4);
    await expect(within(groups[0]!).getByText('/compact')).toBeVisible();
    await expect(within(groups[1]!).getByText('Workspace Only')).toBeVisible();
  },
};

// Real path: 同上，然后点菜单里的「压缩上下文」。
// Picking a command writes its invocation into the draft and closes the menu —
// the user still presses Enter. Nothing here auto-sends.
export const PickingACommandWritesItsInvocation: Story = {
  play: async ({ canvasElement }) => {
    const menu = await openMenu(canvasElement);
    await userEvent.click(within(menu).getByRole('option', { name: /压缩上下文.*\/compact/ }));
    const composer = editor(canvasElement);
    await waitFor(() => expect(composer.textContent).toBe('/compact '));
    await waitFor(() =>
      expect(overlay().queryByRole('listbox', { name: MENU_LABEL })).not.toBeInTheDocument(),
    );
  },
};

// Real path: 在 composer 里写一个路径，例如「帮我整理到/Users/」。
// #3849: a `/` that separates path segments is text. The positive control runs
// first — the same editor, the same synthetic input shape, opening the menu
// from an empty draft — so a menu that stopped opening at all cannot pass this.
export const PathSeparatorsAreNotTriggers: Story = {
  play: async ({ canvasElement }) => {
    const composer = editor(canvasElement);
    await userEvent.click(composer);

    typeSlashAtEnd(composer);
    await overlay().findByRole('listbox', { name: MENU_LABEL });
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(overlay().queryByRole('listbox', { name: MENU_LABEL })).not.toBeInTheDocument(),
    );

    for (const prefix of ['帮我整理到/Users', 'path/to/file']) {
      await userEvent.clear(composer);
      await userEvent.type(composer, prefix);
      typeSlashAtEnd(composer);

      await waitFor(() => expect(composer.textContent).toBe(`${prefix}/`));
      await expect(overlay().queryByRole('listbox', { name: MENU_LABEL })).not.toBeInTheDocument();
      // The caret stays after the slash the user just typed: a controlled
      // rewrite that reset it would put the next character at the front.
      await expect(caretOffset(composer)).toBe(`${prefix}/`.length);
    }
  },
};

// Real path: 在 composer 里换行，然后在新行开头输入 `/`。
// #3849, the other half: a block element is a line boundary, so a `/` opening a
// new visual line is a trigger even though the character before it in the DOM
// belongs to a different node.
export const ABlockBreakIsALineBoundary: Story = {
  play: async ({ canvasElement }) => {
    const composer = editor(canvasElement);
    await userEvent.click(composer);
    await userEvent.type(composer, 'first line');

    const block = document.createElement('div');
    const slash = block.appendChild(document.createTextNode('/'));
    composer.appendChild(block);
    const range = document.createRange();
    range.setStart(slash, 1);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    composer.dispatchEvent(
      new InputEvent('input', { bubbles: true, data: '/', inputType: 'insertText' }),
    );

    await waitFor(() => expect(composer.innerText).toBe('first line\n/'));
    const menu = await overlay().findByRole('listbox', { name: MENU_LABEL });
    // Skills only: the slash does not open the draft, so it addresses no
    // command — `slashCommandQuery` owns that rule and is tested on its own.
    await expect(within(menu).getByRole('group', { name: 'Skills' })).toBeVisible();
    await expect(within(menu).queryByRole('group', { name: '命令' })).not.toBeInTheDocument();
  },
};

// Real path: `/` 菜单开着时 Session 发出 'updated'（改 thinking level、MCP 变更），
// Skill 投影随之重载。
// #2667: republishing the projection with the same content used to alternate
// the popup. The menu element and its Skills group must survive as the same
// nodes — a menu torn down and rebuilt loses the highlighted item and the
// keyboard position under the user's hands.
export const SurvivesASameContentProjectionRefresh: Story = {
  play: async ({ canvasElement }) => {
    const menu = await openMenu(canvasElement);
    const skillsGroup = within(menu).getByRole('group', { name: 'Skills' });
    const container = menu.parentElement;
    if (!container) throw new Error('slash menu container is missing');

    const removals = { menu: 0, skillsGroup: 0 };
    const record = (mutations: MutationRecord[], watched: Node, key: 'menu' | 'skillsGroup') => {
      for (const mutation of mutations) {
        for (const node of mutation.removedNodes) if (node === watched) removals[key] += 1;
      }
    };
    // Armed on this popover only, immediately before the refreshes: the
    // document body carries unrelated overlays whose teardown says nothing
    // about this menu's identity.
    const menuObserver = new MutationObserver((mutations) => record(mutations, menu, 'menu'));
    const groupObserver = new MutationObserver((mutations) =>
      record(mutations, skillsGroup, 'skillsGroup'),
    );
    menuObserver.observe(container, { childList: true });
    groupObserver.observe(menu, { childList: true });
    try {
      for (let round = 0; round < 3; round += 1) {
        const before = projectionLoads;
        publishSessionUpdate?.();
        await waitFor(() => expect(projectionLoads).toBeGreaterThan(before));
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
      }
    } finally {
      // Drain the last queued batch before closing the window this story is
      // about; polling a monotonic counter cannot turn a failure into a pass.
      record(menuObserver.takeRecords(), menu, 'menu');
      record(groupObserver.takeRecords(), skillsGroup, 'skillsGroup');
      menuObserver.disconnect();
      groupObserver.disconnect();
    }

    await expect(removals).toEqual({ menu: 0, skillsGroup: 0 });
    await expect(menu.isConnected).toBe(true);
    await expect(skillsGroup.isConnected).toBe(true);
  },
};
