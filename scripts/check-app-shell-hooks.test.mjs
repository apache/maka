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

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  ALLOWED,
  assertCountableReactImport,
  compareToInventory,
  countHooks,
  findComponentBody,
  stripNonCode,
} from './check-app-shell-hooks.mjs';

/** Counts hooks the way the gate does: blank first, then delimit, then match. */
function countIn(source, component) {
  const body = findComponentBody(stripNonCode(source), component);
  return body === null ? null : countHooks(body);
}

const SHELL = `
export function AppShell() {
  const [locale, setLocale] = useState<UiLocalePreference>('auto');
  useSystemUiLocale();
  return <AppShellContent />;
}

function AppShellContent({ prop }: Props) {
  const [value, setValue] = useState(0);
  const derived = useMemo(() => value, [value]);
  const chat = useShellChatModel({ value });
  return <div>{derived}</div>;
}

function AfterTheShell() {
  useSomethingElse();
}
`;

test('each shell component is delimited by its own braces', () => {
  assert.deepEqual(countIn(SHELL, 'AppShellContent'), {
    useState: 1,
    useShellChatModel: 1,
  });
  assert.deepEqual(countIn(SHELL, 'AppShell'), {
    useState: 1,
    useSystemUiLocale: 1,
  });
});

test('a destructured parameter is not mistaken for the body', () => {
  // `function C({ a, b }: Props) {` opens a brace before the body does.
  const source = 'function C({ a, b }: Props) {\n  useToast();\n}\n';
  assert.deepEqual(countIn(source, 'C'), { useToast: 1 });
});

test('an unknown component is reported rather than guessed at', () => {
  assert.equal(findComponentBody(stripNonCode(SHELL), 'NoSuchComponent'), null);
});

test('an arrow component is found too, so a refactor cannot silence the gate', () => {
  const source = 'const C = ({ a }: Props) => {\n  useToast();\n};\n';
  assert.deepEqual(countIn(source, 'C'), { useToast: 1 });
});

test('an exported declaration is found', () => {
  const source = 'export function C() {\n  useToast();\n}\n';
  assert.deepEqual(countIn(source, 'C'), { useToast: 1 });
});

test('a brace in column zero does not end the body early', () => {
  // Formatting can leave a closing brace at column zero inside a body; the old
  // `\n}\n` delimiter stopped there and silently dropped every later hook.
  const source = [
    'function C() {',
    '  const style = {',
    '  a: 1,',
    '};',
    '  useToast();',
    '}',
    '',
  ].join('\n');
  assert.deepEqual(countIn(source, 'C'), { useToast: 1 });
});

test('an explicit type argument is still a call site', () => {
  // The gate under-counted 12 real call sites in app-shell.tsx by requiring a
  // `(` directly after the name.
  const source = [
    'function C() {',
    '  const [a, setA] = useState<string | null>(null);',
    '  const b = useNewTaskChoice<ChatDefaultPermissionMode>(key);',
    '  const c = useSessionSettingIntent<Record<string, number>>({});',
    '}',
    '',
  ].join('\n');
  assert.deepEqual(countIn(source, 'C'), {
    useState: 1,
    useNewTaskChoice: 1,
    useSessionSettingIntent: 1,
  });
});

test('a member call on something other than React is not a hook', () => {
  const source = 'function C() {\n  copy.useSkillPrompt(name);\n  useToast();\n}\n';
  assert.deepEqual(countIn(source, 'C'), { useToast: 1 });
});

// The gate's whole value is that it fails closed. Every form React supports has
// to be counted, or a future subscription widens the shell's scope while this
// exact inventory stays green.
test('the React namespace form is the same call site as the bare name', () => {
  const source =
    'function C() {\n  React.useState(0);\n  useState(1);\n  React.useEffect(fn);\n}\n';
  assert.deepEqual(countIn(source, 'C'), { useState: 2, useEffect: 1 });
});

test("React 19's bare `use` is a hook, and identifiers merely starting with `use` are not", () => {
  const source =
    'function C() {\n  use(promise);\n  user(id);\n  usedBy(x);\n  router.use(mw);\n}\n';
  assert.deepEqual(countIn(source, 'C'), { use: 1 });
});

test('a namespace import of React is refused rather than under-counted', () => {
  assert.equal(assertCountableReactImport("import { useState } from 'react';"), null);
  assert.equal(assertCountableReactImport("import * as Lodash from 'lodash';"), null);
  assert.match(
    assertCountableReactImport("import * as R from 'react';") ?? '',
    /imports React as the namespace `R`/,
  );
});

test('a type position is not a call site', () => {
  const source =
    'function C() {\n  const x: ReturnType<typeof useShellSearch> = y;\n  useToast();\n}\n';
  assert.deepEqual(countIn(source, 'C'), { useToast: 1 });
});

test('a call split across lines is still a call site', () => {
  const source = 'function C() {\n  const x = useToast\n    ({});\n}\n';
  assert.deepEqual(countIn(source, 'C'), { useToast: 1 });
});

test('prose naming a hook is not a call site', () => {
  const source = [
    'function C() {',
    '  // The model lives in useShellChatModel (a pure derivation).',
    '  /* See useGoalController () for the other half. */',
    "  const label = 'useToast ()';",
    '  useSettingsModal({});',
    '}',
    '',
  ].join('\n');
  assert.deepEqual(countIn(source, 'C'), { useSettingsModal: 1 });
});

test('an apostrophe in JSX text does not swallow the rest of the body', () => {
  const source = "function C() {\n  const t = <span>don't</span>;\n  useToast();\n}\n";
  assert.deepEqual(countIn(source, 'C'), { useToast: 1 });
});

test('a regex literal containing a quote does not swallow the rest of the body', () => {
  const source = 'function C() {\n  const re = /[\'"]/g;\n  useToast();\n}\n';
  assert.deepEqual(countIn(source, 'C'), { useToast: 1 });
});

test('a JSX closing tag is not the start of a regex literal', () => {
  const source = 'function C() {\n  const t = <div></div>;\n  useToast();\n}\n';
  assert.deepEqual(countIn(source, 'C'), { useToast: 1 });
});

test('an escaped quote does not swallow the rest of the body', () => {
  const source = "function C() {\n  const label = 'it\\'s here';\n  useToast();\n}\n";
  assert.deepEqual(countIn(source, 'C'), { useToast: 1 });
});

test('a URL is not mistaken for a line comment', () => {
  assert.match(stripNonCode('const url = ok; // https://example.com\nuseToast();'), /useToast/);
});

test('blanking preserves offsets, so a body keeps its shape', () => {
  const source = "const a = 'xxxx'; // yyyy\nuseToast();\n";
  assert.equal(stripNonCode(source).length, source.length);
  assert.equal(stripNonCode(source).split('\n').length, source.split('\n').length);
});

test('purely derived hooks do not widen a scope, so they are not counted', () => {
  const source =
    'function C() {\n  useMemo(() => 1, []);\n  useCallback(() => {}, []);\n  useRef(null);\n  useId();\n  useToast();\n}\n';
  assert.deepEqual(countIn(source, 'C'), { useToast: 1 });
});

test('a new hook in the render body fails the gate', () => {
  const { added } = compareToInventory({ useState: 1, useBrandNew: 1 }, { useState: 1 });
  assert.deepEqual(added, ['useBrandNew']);
});

test('a second call site of an inventoried hook fails the gate', () => {
  const { grown } = compareToInventory({ useState: 2 }, { useState: 1 });
  assert.deepEqual(grown, [{ name: 'useState', budget: 1, count: 2 }]);
});

test('a migrated hook fails until its entry is deleted, so the gate converges', () => {
  const { stale } = compareToInventory({}, { useComposerMentions: 1 });
  assert.deepEqual(stale, [{ name: 'useComposerMentions', budget: 1, count: 0 }]);
});

test('the committed inventory matches the shell as it stands', async () => {
  const source = await readFile(
    new URL('../apps/desktop/src/renderer/app-shell.tsx', import.meta.url),
    'utf8',
  );
  const blanked = stripNonCode(source);
  for (const [component, allowed] of Object.entries(ALLOWED)) {
    const body = findComponentBody(blanked, component);
    assert.notEqual(body, null, `${component} must still be a top-level component`);
    assert.deepEqual(compareToInventory(countHooks(body), allowed), {
      added: [],
      grown: [],
      stale: [],
    });
  }
});

test('the shell body is delimited to something plausible, not to the whole file', async () => {
  // A delimiter that ran to end-of-file would still satisfy the inventory while
  // silently counting whatever follows the component.
  const source = await readFile(
    new URL('../apps/desktop/src/renderer/app-shell.tsx', import.meta.url),
    'utf8',
  );
  const blanked = stripNonCode(source);
  const outer = findComponentBody(blanked, 'AppShell');
  const inner = findComponentBody(blanked, 'AppShellContent');
  assert.ok(outer.length < inner.length, 'the wrapper is far smaller than the content');
  assert.ok(inner.length < blanked.length, 'the content body is not the entire file');
  assert.doesNotMatch(outer, /useShellChatModel/, 'the wrapper must not absorb the content');
});
