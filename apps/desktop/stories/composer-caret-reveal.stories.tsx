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
import { expect, userEvent, waitFor } from 'storybook/test';
import { Composer } from '@maka/ui';

/*
 * The composer's Shift/Alt+Enter, multi-line insert and plain-text paste
 * seams all edit through `document.execCommand`, and Chromium reveals the
 * caret for a native keypress but not for a scripted command (#5811). These
 * stories drive the real editable past its row cap and check, with the
 * caret's line computed from the DOM rather than from the composer's own
 * helper, that the caret's line box ends up inside the scroll viewport.
 */

const COMPOSER_INPUT = '.maka-composer-editor [contenteditable="true"]';

function RevealHarness(): React.ReactElement {
  return (
    // Full width, like the session composer: the line oracle below assumes
    // the short lines these stories type never wrap.
    <div style={{ display: 'grid', alignContent: 'end', height: 420, padding: 24 }}>
      <Composer
        draftKey="new-task:caret-reveal"
        draftPersistence={{ read: () => undefined, write: () => {} }}
        onSearchMentionFiles={async () => []}
        onSend={() => {}}
        onStop={() => {}}
      />
    </div>
  );
}

const meta = {
  title: 'Product/Composer Caret Reveal',
  component: RevealHarness,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof RevealHarness>;

export default meta;
type Story = StoryObj<typeof meta>;

function editor(canvasElement: HTMLElement): HTMLElement {
  return canvasElement.querySelector<HTMLElement>(COMPOSER_INPUT)!;
}

/** Text and <br> leaves of the editable in document order. */
function leaves(root: Node): Node[] {
  return Array.from(root.childNodes).flatMap((node) =>
    node.nodeType === Node.TEXT_NODE || node.nodeName === 'BR' ? [node] : leaves(node),
  );
}

function leafText(node: Node): string {
  return node.nodeType === Node.TEXT_NODE ? (node.textContent ?? '') : node.nodeName === 'BR' ? '\n' : '';
}

/** The draft text before the caret, as the browser sees it: every newline
 *  in it is a rendered line break under the editor's pre-wrap whitespace. */
function textBeforeCaret(editable: HTMLElement): string {
  const caret = document.getSelection()!.getRangeAt(0);
  expect(caret.collapsed).toBe(true);
  const range = document.createRange();
  range.setStart(editable, 0);
  range.setEnd(caret.startContainer, caret.startOffset);
  const fragment = range.cloneContents();
  for (const br of fragment.querySelectorAll('br')) br.replaceWith('\n');
  return fragment.textContent ?? '';
}

/** Fails unless the caret's whole line box is inside the scroll viewport. */
function expectCaretLineInView(editable: HTMLElement, label: string) {
  const style = getComputedStyle(editable);
  const lineHeight = Number.parseFloat(style.lineHeight);
  const paddingTop = Number.parseFloat(style.paddingTop);
  const line = textBeforeCaret(editable).split('\n').length - 1;
  const top = paddingTop + line * lineHeight;
  const bottom = top + lineHeight;
  const viewTop = editable.scrollTop;
  const viewBottom = viewTop + editable.clientHeight;
  const inView = top >= viewTop - 0.5 && bottom <= viewBottom + 0.5;
  const detail = JSON.stringify({ label, line, lineHeight, paddingTop, top, bottom, viewTop, viewBottom, scrollHeight: editable.scrollHeight, before: textBeforeCaret(editable).slice(-40) });
  expect(inView, detail).toBe(true);
}

function placeCaret(node: Node, offset: number) {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

/** The text leaf holding the given line's start, with the offset of that
 *  start inside it. */
function startOfLine(editable: HTMLElement, line: number): { node: Node; offset: number } {
  let remaining = line;
  for (const node of leaves(editable)) {
    const text = leafText(node);
    for (let i = 0; i < text.length; i += 1) {
      if (remaining === 0) return { node, offset: i };
      if (text[i] === '\n') remaining -= 1;
    }
  }
  throw new Error(`line ${line} not found`);
}

async function fillPastTheCap(canvasElement: HTMLElement): Promise<HTMLElement> {
  const composer = editor(canvasElement);
  await userEvent.click(composer);
  for (let line = 0; line < 12; line += 1) {
    await userEvent.keyboard(`${line === 0 ? '' : '{Shift>}{Enter}{/Shift}'}line${line}`);
  }
  await waitFor(() => expect(composer.scrollHeight).toBeGreaterThan(composer.clientHeight));
  return composer;
}

// Real path: a session composer draft past ten rows, Shift+Enter with the
// caret at the very end, then again with the caret in the middle of the
// bottom row, then at the end of an upper line while scrolled to the bottom.
export const ShiftEnterRevealsTheCaret: Story = {
  play: async ({ canvasElement }) => {
    const composer = await fillPastTheCap(canvasElement);

    // End of the draft, scrolled away from the caret first: Chromium parks the
    // caret before a placeholder newline that paints no rect.
    composer.scrollTop = 0;
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    expectCaretLineInView(composer, 'end of draft');
    expect(composer.scrollTop).toBeGreaterThan(0);

    // Middle of the bottom row: the rest of the line moves down one line and
    // the caret goes with it.
    const last = leaves(composer).filter((node) => leafText(node).includes('line11')).at(-1)!;
    placeCaret(last, leafText(last).indexOf('line11') + 4);
    composer.scrollTop = composer.scrollHeight;
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    expectCaretLineInView(composer, 'bottom-row mid-line');
    expect(textBeforeCaret(composer).endsWith('line\n')).toBe(true);

    // End of line 2 while scrolled to the bottom: the caret then sits before
    // a newline with content after it (no rect of its own) and above the
    // viewport, so the reveal scrolls up, not to the end.
    const lineThree = startOfLine(composer, 2);
    placeCaret(lineThree.node, lineThree.offset);
    composer.scrollTop = composer.scrollHeight;
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    expectCaretLineInView(composer, 'break before following content, above the viewport');
    expect(composer.scrollTop).toBeLessThan(composer.scrollHeight - composer.clientHeight);
  },
};

// Real path: a session composer draft past ten rows, Cmd+V of multi-line
// text with the caret at the end, then a dictation/IME commit of multi-line
// text (the `beforeinput` insert seam) at the end.
export const MultiLineInsertsRevealTheCaret: Story = {
  play: async ({ canvasElement }) => {
    const composer = await fillPastTheCap(canvasElement);

    composer.scrollTop = 0;
    await userEvent.paste('pasted one\npasted two\n');
    await waitFor(() => expect(composer.textContent).toContain('pasted two'));
    expectCaretLineInView(composer, 'multi-line paste at the end');

    composer.scrollTop = 0;
    composer.dispatchEvent(
      new InputEvent('beforeinput', { inputType: 'insertText', data: 'spoken one\nspoken two\n', bubbles: true, cancelable: true }),
    );
    await waitFor(() => expect(composer.textContent).toContain('spoken two'));
    expectCaretLineInView(composer, 'multi-line insert at the end');
  },
};
