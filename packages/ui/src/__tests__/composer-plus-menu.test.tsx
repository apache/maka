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
 * The ＋ menu's mode rows and the divider above them.
 *
 * Each row gets the control its field is. Plan is a Session field of its own
 * and an independent switch. Swarm and Graph are the two values of one other
 * field, so they are one group and picking one is picking away from the other
 * — announced as a set rather than left for a screen reader to miss. Neither
 * is chosen at rest, and no row stands for that; every prop that feeds them is
 * optional, so a host can wire the modes alone, and then there is nothing
 * above the divider to divide.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Composer } from '../composer.js';
import { LocaleProvider } from '../locale-context.js';

function render(props: Parameters<typeof Composer>[0]): string {
  return renderToStaticMarkup(
    <LocaleProvider locale="en">
      <Composer {...props} />
    </LocaleProvider>,
  );
}

function plusMenu(props: Parameters<typeof Composer>[0]): string {
  const parts = render(props).split('maka-composer-plus-menu');
  // Without the marker `split` returns the whole markup, and a menu that
  // stopped rendering would still satisfy an absence assertion.
  assert.ok(parts.length > 1, 'the composer rendered no ＋ menu');
  return parts[parts.length - 1] ?? '';
}

function count(markup: string, needle: string): number {
  return markup.split(needle).length - 1;
}

/** Opening tags carrying every one of these attributes, in any order. */
function tagsWith(markup: string, ...attributes: readonly string[]): readonly string[] {
  return (markup.match(/<[a-z]+[^>]*>/g) ?? []).filter(
    (tag) => attributes.every((attribute) => tag.includes(attribute)),
  );
}

const base = {
  onSend: () => undefined,
  onStop: () => undefined,
  planModeActive: false,
  onPlanModeChange: () => undefined,
  orchestrationMode: 'default' as const,
  onOrchestrationModeChange: () => undefined,
};

test('the mode controls alone open the menu on a row, not on a rule', () => {
  assert.equal(plusMenu(base).includes('astryx-dropdown-menu-divider'), false);
});

test('an action row above the mode controls keeps the divider', () => {
  const withAction = plusMenu({ ...base, onPickAttachments: () => undefined });
  assert.equal(withAction.includes('astryx-dropdown-menu-divider'), true);
});

test('each mode row is the control its field is, and none of them is on', () => {
  const menu = plusMenu(base);
  assert.equal(count(menu, 'role="menuitemcheckbox"'), 1, 'Plan alone is a switch');
  // Two rows, not three: the field's third value is this group holding none.
  assert.equal(count(menu, 'role="menuitemradio"'), 2, 'Swarm and Graph, no neutral row');
  assert.equal(
    tagsWith(menu, 'role="group"', 'aria-label="Orchestration mode"').length,
    1,
    'the exclusive pair is announced as one named set',
  );
  assert.equal(count(menu, 'aria-checked="true"'), 0, 'nothing on is nothing checked');
});

/** The Skills entry is the menu's only plain-menuitem row under these props. */
function skillsRow(menu: string): string {
  const rows = tagsWith(menu, 'role="menuitem"');
  assert.equal(rows.length, 1, 'expected the Skills row and nothing else');
  return rows[0] ?? '';
}

test('a refreshing skill catalog is not "no skills": the row stays put', () => {
  // The host clears `mentionSkills` while it re-fetches the projection (a
  // Plan toggle or model change does that with this menu open) but holds its
  // settled verdict steady. Painting the transient `[]` as "no skills
  // available" grows the row by a description line and grays it, then snaps
  // back — the menu visibly jumps.
  const menu = plusMenu({ ...base, mentionSkills: [], mentionSkillsUnavailable: false });
  assert.equal(count(menu, 'Choose skills'), 1, 'the Skills row is rendered');
  assert.equal(count(menu, 'No skills available'), 0, 'no transient empty-state line');
  assert.equal(
    skillsRow(menu).includes('aria-disabled="true"'),
    false,
    'the row does not gray out mid-refresh',
  );
});

test('a settled empty skill catalog still says why the row is unavailable', () => {
  for (const props of [
    // A host that never clears the list mid-flight wires no verdict; the row
    // falls back to the list itself.
    { ...base, mentionSkills: [] },
    { ...base, mentionSkills: [], mentionSkillsUnavailable: true },
  ]) {
    const menu = plusMenu(props);
    assert.ok(count(menu, 'No skills available') > 0, 'the empty state says why');
    assert.equal(skillsRow(menu).includes('aria-disabled="true"'), true);
  }
});

test('a populated skill catalog renders the row enabled with no caveat', () => {
  const menu = plusMenu({
    ...base,
    mentionSkills: [{ id: 'demo', name: 'Demo' }],
  });
  assert.equal(count(menu, 'Choose skills'), 1);
  assert.equal(count(menu, 'No skills available'), 0);
  assert.equal(skillsRow(menu).includes('aria-disabled="true"'), false);
  assert.equal(menu.includes('maka-composer-skills-loading'), false);
});

test('a loading catalog holds the row still and marks the held state', () => {
  // Mid-refresh the row keeps the previous catalog's look (here: populated).
  // `aria-busy` is what assistive technology gets instead of a geometry
  // change: activation is deferred, and a row that still announced plain
  // "available" would silently ignore it. The class is the same contract for
  // tests and styling.
  const menu = plusMenu({
    ...base,
    mentionSkills: [],
    mentionSkillsUnavailable: false,
    mentionSkillsLoading: true,
  });
  assert.equal(count(menu, 'No skills available'), 0, 'geometry does not grow mid-refresh');
  assert.equal(skillsRow(menu).includes('aria-disabled="true"'), false);
  assert.equal(
    skillsRow(menu).includes('aria-busy="true"'),
    true,
    'the deferred activation is announced',
  );
  assert.equal(
    skillsRow(menu).includes('maka-composer-skills-loading'),
    true,
    'the loading state is observable on the row',
  );
});

test('a settled catalog carries no busy announcement', () => {
  for (const props of [
    { ...base, mentionSkills: [{ id: 'demo', name: 'Demo' }], mentionSkillsLoading: false },
    { ...base, mentionSkills: [{ id: 'demo', name: 'Demo' }] },
  ]) {
    assert.equal(plusMenu(props).includes('aria-busy'), false);
  }
});

test('a loading refresh from a settled-empty catalog holds the empty look', () => {
  const menu = plusMenu({
    ...base,
    mentionSkills: [],
    mentionSkillsUnavailable: true,
    mentionSkillsLoading: true,
  });
  assert.ok(count(menu, 'No skills available') > 0, 'the settled caveat stays put');
  assert.equal(skillsRow(menu).includes('aria-disabled="true"'), true);
});

test('Plan and an orchestration mode are both on at once', () => {
  const markup = render({ ...base, planModeActive: true, orchestrationMode: 'swarm' });
  const menu = markup.split('maka-composer-plus-menu')[1] ?? '';
  assert.equal(
    tagsWith(menu, 'role="menuitemcheckbox"', 'aria-checked="true"').length,
    1,
    'Plan is not checked',
  );
  assert.equal(
    tagsWith(menu, 'role="menuitemradio"', 'aria-checked="true"').length,
    1,
    'Swarm is not checked, or Graph is checked with it',
  );
  // Each one keeps its own readout and its own way out, so neither hides the
  // other: a Plan excursion does not clear the orchestration default.
  assert.equal(count(markup, 'maka-composer-mode-button'), 2);
  assert.ok(markup.includes('data-mode="plan"'));
  assert.ok(markup.includes('data-mode="swarm"'));
});
