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
 * What a plain-text paste owes the composer (#3787).
 *
 * The composer inserts pasted text with `execCommand('insertHTML')` — the one
 * primitive left that opens a browser undo transaction — instead of writing the
 * controlled draft. So the browser's own undo stack is the subject here, and
 * these stories drive it with the browser's own primitives: `insertText` for a
 * keystroke's transaction, `undo` for the shortcut. A DOM shim has no undo
 * stack at all, and a synthetic `Meta+z` is not trusted input, so neither the
 * unit tier nor `userEvent` can reach this.
 *
 * Fidelity convention (#1433): chat-composer-region.tsx renders this Composer
 * with a `draftPersistence` that writes the new-task reload draft; the spy
 * below stands exactly where that writer stands. See FIDELITY.md.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { slashCommandsForSurface } from '@maka/core/slash-command-catalog';
import { Composer } from '@maka/ui';
import { desktopSlashCommandAvailability } from '../src/renderer/desktop-slash-command';
import { getShellCopy } from '../src/renderer/locales/shell-copy';

const COMPOSER_INPUT = '.maka-composer-editor [contenteditable="true"]';
const TYPED = 'x';
const PASTED = '中文 <tag>& "quoted"\r\nhttps://example.test/path?x=1&y=2\n第二行 <>&';
const PASTED_AS_PLAIN_TEXT = PASTED.replace(/\r\n/g, '\n');

// The new-task composer's command list, from the catalog, the availability
// predicate and the shell's copy — the same three app-shell.tsx reads.
const slashCommands = slashCommandsForSurface('desktop')
  .filter(desktopSlashCommandAvailability({ hasSession: false, streaming: false }))
  .map(({ id }) => ({ id, ...getShellCopy('zh-CN').app.slashCommands[id] }));

/** Records what the host would have persisted, one call per controlled change. */
const draftWrites = fn();
const sent = fn();

function PasteHarness(): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', height: 420, padding: 24 }}>
      <Composer
        draftKey="new-task:story"
        draftPersistence={{ read: () => undefined, write: (_key, value) => draftWrites(value) }}
        slashCommands={slashCommands}
        onSearchMentionFiles={async () => []}
        onSend={(text) => {
          sent(text);
        }}
        onStop={() => {}}
      />
    </div>
  );
}

const meta = {
  title: 'Product/Composer Paste',
  component: PasteHarness,
  parameters: { layout: 'fullscreen' },
  beforeEach: () => {
    draftWrites.mockClear();
    sent.mockClear();
  },
} satisfies Meta<typeof PasteHarness>;

export default meta;

type Story = StoryObj<typeof meta>;

function editor(canvasElement: HTMLElement): HTMLElement {
  const element = canvasElement.querySelector<HTMLElement>(COMPOSER_INPUT);
  if (!element) throw new Error('composer editor is missing');
  return element;
}

/** The `/` and `@` popups render in a layer outside the story canvas. */
function overlay(): ReturnType<typeof within> {
  return within(document.body);
}

function pastePlainText(composer: HTMLElement, text: string): void {
  const transfer = new DataTransfer();
  transfer.setData('text/plain', text);
  composer.dispatchEvent(
    new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }),
  );
}

function draftText(composer: HTMLElement): string {
  return composer.innerText.replace(/\r\n/g, '\n');
}

// Real path: 在 composer 里打了字，再从别处粘贴一段文本，然后按 ⌘Z。
// One paste is one undo. Before #3787 the paste wrote the controlled draft
// instead of inserting, which left the browser with no transaction to reverse:
// the first undo took the whole draft, typing included.
export const PasteIsItsOwnUndoStep: Story = {
  play: async ({ canvasElement }) => {
    const composer = editor(canvasElement);
    await userEvent.click(composer);
    // The browser's own text insertion, so the keystroke opens the same kind
    // of transaction a trusted key press would.
    document.execCommand('insertText', false, TYPED);
    await waitFor(() => expect(draftText(composer)).toBe(TYPED));

    pastePlainText(composer, PASTED);
    await waitFor(() => expect(draftText(composer)).toBe(`${TYPED}${PASTED_AS_PLAIN_TEXT}`));

    document.execCommand('undo');
    await waitFor(() => expect(draftText(composer)).toBe(TYPED));
    document.execCommand('undo');
    await waitFor(() => expect(draftText(composer)).toBe(''));
    // An empty stack stays empty rather than reaching past the composer.
    document.execCommand('undo');
    await expect(draftText(composer)).toBe('');
  },
};

// Real path: 从 Finder 或终端复制一个绝对路径，粘进 composer，直接回车。
// A pasted absolute path is text, and Enter sends it. The slash it starts with
// must not arm the command menu, or the first Enter would be swallowed
// accepting a suggestion.
export const PastedPathSendsOnTheFirstEnter: Story = {
  play: async ({ canvasElement }) => {
    const composer = editor(canvasElement);
    const pasted = '/Users/me/notes.txt';
    await userEvent.click(composer);
    pastePlainText(composer, pasted);

    await waitFor(() => expect(draftText(composer)).toBe(pasted));
    await expect(composer).toHaveAttribute('aria-expanded', 'false');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(sent).toHaveBeenCalledWith(pasted));
  },
};

// Real path: 粘贴一段带 `@名字` 的文本（评论、聊天记录）。
// The same rule for `@`: a pasted mention is text, not a file lookup.
export const PastedMentionDoesNotOpenTheFileMenu: Story = {
  play: async ({ canvasElement }) => {
    const composer = editor(canvasElement);
    await userEvent.click(composer);
    pastePlainText(composer, 'review @name');

    await waitFor(() => expect(draftText(composer)).toBe('review @name'));
    await expect(composer).toHaveAttribute('aria-expanded', 'false');
    await expect(overlay().queryByRole('listbox')).not.toBeInTheDocument();
  },
};

// Real path: `/` 菜单已经打开时粘贴，再回车。
// A menu that was already open closes on paste. It is answering a query the
// paste has just invalidated, and leaving it open costs the next Enter.
export const PasteClosesAnOpenTriggerMenu: Story = {
  play: async ({ canvasElement }) => {
    const composer = editor(canvasElement);
    const pasted = 'Users/me/notes.txt';
    await userEvent.click(composer);
    await userEvent.keyboard('/');
    await waitFor(() => expect(composer).toHaveAttribute('aria-expanded', 'true'));

    pastePlainText(composer, pasted);

    await waitFor(() => expect(composer).toHaveAttribute('aria-expanded', 'false'));
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(sent).toHaveBeenCalledWith(`/${pasted}`));
  },
};

// Real path: 在新任务 composer 里粘贴一次；宿主随即写一次重载草稿。
// One paste, one controlled change. The insertion and the sync used to both
// reach the host, which wrote the reload draft twice for a single edit.
export const PasteSynchronizesTheDraftOnce: Story = {
  play: async ({ canvasElement }) => {
    const composer = editor(canvasElement);
    await userEvent.click(composer);
    pastePlainText(composer, 'one controlled change');

    await waitFor(() => expect(draftText(composer)).toBe('one controlled change'));
    await expect(draftWrites).toHaveBeenCalledTimes(1);
    await expect(draftWrites).toHaveBeenCalledWith('one controlled change');
  },
};
