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
 * A staged Skill is text in the draft, drawn as a chip.
 *
 * That is the whole point of the design: there is one draft, `/skill:<id>` is
 * the invocation grammar Runtime already parses, and everything that carries a
 * draft carries the Skill for free. The cost is that a controlled write flattens
 * the chips back to their text — Astryx rebuilds the editor from the string —
 * so `redrawSkillTokens` has to put them back. Leaving a Session and returning
 * is the path that write is on.
 *
 * Fidelity convention (#1433): the composer's `draftKey` is what app-shell
 * changes when the active Session changes; switching it here is the same event.
 * See FIDELITY.md.
 *
 * A browser, not a DOM shim: the redraw drives `insertToken` through a live
 * document Selection over the editor's text node offsets.
 */

import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { Composer } from '@maka/ui';

const COMPOSER_INPUT = '.maka-composer-editor [contenteditable="true"]';
const SESSION_DRAFT_KEY = 'session:skill-draft';
const NEW_TASK_DRAFT_KEY = 'new-task:story';

const skills: ReadonlyArray<{ id: string; name: string; description: string }> = [
  { id: 'project-only', name: 'Project Only', description: 'Project-scoped suggestion.' },
  { id: 'workspace-only', name: 'Workspace Only', description: 'Maka workspace suggestion.' },
];

/** Move the composer to another draft scope, the way a Session switch does. */
let selectDraftKey: ((key: string) => void) | undefined;
const sent = fn();

function SkillDraftHarness(): React.ReactElement {
  const [draftKey, setDraftKey] = useState(SESSION_DRAFT_KEY);
  useEffect(() => {
    selectDraftKey = setDraftKey;
    return () => {
      selectDraftKey = undefined;
    };
  }, []);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', height: 460, padding: 24 }}>
      <Composer
        draftKey={draftKey}
        mentionSkills={skills}
        onSend={(text) => {
          sent(text);
        }}
        onStop={() => {}}
      />
    </div>
  );
}

const meta = {
  title: 'Product/Composer Skill Draft',
  component: SkillDraftHarness,
  parameters: { layout: 'fullscreen' },
  beforeEach: () => {
    sent.mockClear();
  },
} satisfies Meta<typeof SkillDraftHarness>;

export default meta;

type Story = StoryObj<typeof meta>;

function editor(canvasElement: HTMLElement): HTMLElement {
  const element = canvasElement.querySelector<HTMLElement>(COMPOSER_INPUT);
  if (!element) throw new Error('composer editor is missing');
  return element;
}

function chip(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-astryx-token-value="/skill:${id}"]`);
}

async function pickSkill(composer: HTMLElement, query: string, name: RegExp): Promise<void> {
  await userEvent.click(composer);
  await userEvent.keyboard(` /${query}`);
  const option = await within(document.body)
    .findByRole('listbox', { name: /技能/ })
    .then((menu) => within(menu).findByRole('option', { name }));
  // The exact option, not the popover's transient highlight: what this story
  // owns is draft restoration, and keyboard selection is covered on its own.
  await userEvent.click(option);
}

// Real path: 在某个 Session 的 composer 里用 `/` 选两个 Skill 并夹一句话 → 侧边栏
// 「新任务」→ 再点回原来那个 Session。
// #2137: both chips come back after the draft has been away and returned, and
// the token text they were drawn from is gone — a chip standing beside the text
// it renders would mean the draft carries that Skill twice.
export const StagedSkillsSurviveADraftScopeSwitch: Story = {
  play: async ({ canvasElement }) => {
    const composer = editor(canvasElement);

    await pickSkill(composer, 'project', /Project Only/);
    await userEvent.keyboard('run it');
    await pickSkill(composer, 'workspace', /Workspace Only/);
    // Both tokens must have committed before the draft moves: leaving while the
    // second is still landing races the snapshot and loses the chip.
    await waitFor(() => expect(chip('project-only')).toHaveTextContent('Project Only'));
    await waitFor(() => expect(chip('workspace-only')).toHaveTextContent('Workspace Only'));

    // Away: a new task is a different draft scope and starts empty.
    selectDraftKey?.(NEW_TASK_DRAFT_KEY);
    await waitFor(() => expect(composer.textContent).toBe(''));
    await expect(chip('project-only')).toBeNull();

    // Back: the draft returns as a flat string and the chips are redrawn from it.
    selectDraftKey?.(SESSION_DRAFT_KEY);
    await waitFor(() => expect(composer.textContent).toContain('run it'));
    await waitFor(() => expect(chip('project-only')).toHaveTextContent('Project Only'));
    await expect(chip('workspace-only')).toHaveTextContent('Workspace Only');
    await expect(composer.textContent).not.toContain('/skill:');

    // The restored draft is still the invocation Runtime parses.
    await userEvent.click(composer);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
    const [wire] = sent.mock.calls[0] as [string];
    await expect(wire).toContain('/skill:project-only');
    await expect(wire).toContain('/skill:workspace-only');
    await expect(wire).toContain('run it');
  },
};
