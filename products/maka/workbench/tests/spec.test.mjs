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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  buildSpecCatalogPrompt,
  specCatalog,
  specComponentDefinitions,
} from '../app/spec/catalog.ts';
import { SPEC_COMPONENT_NAMES } from '../app/spec/names.ts';
import { specBuiltInActions } from '../app/spec/schema.ts';
import { SpecSession, splitSpecMarkdown } from '../app/spec/session.ts';
import { compareTableCells, parseSortableNumber } from '../app/spec/sort.ts';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const workbenchAppDir = resolve(import.meta.dirname, '../app');

const SHADCN_COMPONENTS = [
  'Card',
  'Stack',
  'Grid',
  'Separator',
  'Tabs',
  'Accordion',
  'Collapsible',
  'Dialog',
  'Drawer',
  'Carousel',
  'Table',
  'Heading',
  'Text',
  'Image',
  'Avatar',
  'Badge',
  'Alert',
  'Progress',
  'Skeleton',
  'Spinner',
  'Tooltip',
  'Popover',
  'Input',
  'Textarea',
  'Select',
  'Checkbox',
  'Radio',
  'Switch',
  'Slider',
  'Button',
  'Link',
  'DropdownMenu',
  'Toggle',
  'ToggleGroup',
  'ButtonGroup',
  'Pagination',
];

const INK_COMPONENTS = [
  'Box',
  'Text',
  'Newline',
  'Spacer',
  'Heading',
  'Divider',
  'Badge',
  'Spinner',
  'ProgressBar',
  'Sparkline',
  'BarChart',
  'Table',
  'List',
  'ListItem',
  'Card',
  'KeyValue',
  'Link',
  'StatusLine',
  'Metric',
  'Callout',
  'Timeline',
  'TextInput',
  'Select',
  'MultiSelect',
  'ConfirmInput',
  'Tabs',
  'Markdown',
];

const NATIVE_CHART_COMPONENTS = [
  'LineChart',
  'AreaChart',
  'BarChart',
  'PieChart',
  'ScatterChart',
  'Heatmap',
  'Sparkline',
];

test('native catalog, SPEC_COMPONENT_NAMES, and runtime registry stay in lockstep without bundling catalog/zod into App.js', () => {
  const registered = new Set(specCatalog.componentNames);
  for (const name of [...SHADCN_COMPONENTS, ...INK_COMPONENTS, ...NATIVE_CHART_COMPONENTS]) {
    assert.ok(registered.has(name), `missing component ${name}`);
  }
  assert.equal(registered.size, Object.keys(specComponentDefinitions).length);
  assert.deepEqual([...SPEC_COMPONENT_NAMES].sort(), [...registered].sort());

  const componentsSource = readFileSync(resolve(workbenchAppDir, 'spec/components.tsx'), 'utf8');
  const registryBlock = componentsSource.slice(
    componentsSource.indexOf('export const specComponentRegistry'),
  );
  const registryKeys = [...registryBlock.matchAll(/^\s{2}([A-Z][A-Za-z0-9]*)\s*:/gm)].map(
    (m) => m[1],
  );
  assert.deepEqual([...registryKeys].sort(), [...SPEC_COMPONENT_NAMES].sort());

  const runtimeFiles = [
    'SpecView.tsx',
    'MarkdownBody.tsx',
    'BotReply.tsx',
    'spec/names.ts',
    'spec/sort.ts',
    'spec/session.ts',
    'spec/runtime.tsx',
    'spec/components.tsx',
    'spec/charts.tsx',
  ];
  for (const rel of runtimeFiles) {
    const src = readFileSync(resolve(workbenchAppDir, rel), 'utf8');
    assert.doesNotMatch(
      src,
      /from\s+['"](?:\.\/|\.\.\/)*spec\/(?:catalog|schema)(?:\.ts)?['"]|from\s+['"]\.\/(?:catalog|schema)(?:\.ts)?['"]|from\s+['"]zod['"]/,
      `runtime module ${rel} must not import catalog.ts, schema.ts, or zod`,
    );
  }

  const actionNames = specBuiltInActions.map((a) => a.name);
  assert.deepEqual(actionNames, [
    'setState',
    'pushState',
    'removeState',
    'toggleState',
    'resetState',
    'validateForm',
    'copyText',
  ]);
});

test('bundled maka-generative-ui skill embeds the exact catalog prompt with intact directives and client-only actions', () => {
  const skillText = readFileSync(resolve(repoRoot, 'skills/maka-generative-ui/SKILL.md'), 'utf8');
  const prompt = buildSpecCatalogPrompt();
  assert.ok(
    skillText.endsWith(`\n\n${prompt}\n`),
    'skills/maka-generative-ui/SKILL.md must stay synchronized with buildSpecCatalogPrompt()',
  );
  for (const token of [
    '`$state`',
    '`$item`',
    '`$index`',
    '`$bindState`',
    '`$bindItem`',
    '`$cond`',
    '`$template`',
    '`$format`',
    '`$math`',
    '`$concat`',
    '`$count`',
    '`$truncate`',
    '`$pluralize`',
    '`$join`',
  ]) {
    assert.ok(skillText.includes(token), `SKILL.md missing ${token}`);
  }
  assert.doesNotMatch(skillText, /\(``|,\s*``\)/, 'SKILL.md must not contain shell-erased tokens');
  assert.doesNotMatch(skillText, /loadCities/, 'SKILL.md must not advertise non-existent actions');
  assert.match(prompt, /```spec/);
  assert.match(prompt, /CLIENT-ONLY BOUNDARY/);
});

test('splitSpecMarkdown assigns stable slot keys to prefix-overlapping sibling blocks and respects outer fences', () => {
  assert.deepEqual(splitSpecMarkdown('Plain reply without spec fences.'), [
    {
      kind: 'markdown',
      key: 'm:0',
      atStart: true,
      text: 'Plain reply without spec fences.',
    },
  ]);

  // Incomplete opening fence header without newline stays in markdown until newline arrives.
  assert.deepEqual(splitSpecMarkdown('Intro\n```spec'), [
    {
      kind: 'markdown',
      key: 'm:0',
      atStart: true,
      text: 'Intro\n```spec',
    },
  ]);

  // Open streaming fence preserves trailing newline so complete trailing patch lines are distinguishable.
  const openSegs = splitSpecMarkdown('Intro\n```spec\n{"op":"add","path":"/root","value":"a"}\n');
  assert.deepEqual(openSegs, [
    { kind: 'markdown', key: 'm:0', atStart: true, text: 'Intro\n' },
    {
      kind: 'spec',
      key: 's:0',
      slot: 0,
      source: '{"op":"add","path":"/root","value":"a"}\n',
      closed: false,
    },
  ]);

  // Two sibling spec blocks in the same message where Block 2's JSONL extends Block 1's prefix.
  const block1 = [
    '{"op":"add","path":"/root","value":"main"}',
    '{"op":"add","path":"/elements/main","value":{"type":"Card","props":{"title":"Alpha"},"children":[]}}',
  ].join('\n');
  const block2Extended = [
    block1,
    '{"op":"replace","path":"/elements/main/props/title","value":"Beta Extended"}',
  ].join('\n');
  const twoBlockMsg = `First panel:\n\`\`\`spec\n${block1}\n\`\`\`\n\nSecond panel:\n\`\`\`spec\n${block2Extended}`;
  const split = splitSpecMarkdown(twoBlockMsg);
  assert.equal(split.length, 4);
  assert.deepEqual(
    split.map((s) => ({ kind: s.kind, key: s.key })),
    [
      { kind: 'markdown', key: 'm:0' },
      { kind: 'spec', key: 's:0' },
      { kind: 'markdown', key: 'm:1' },
      { kind: 'spec', key: 's:1' },
    ],
  );
  assert.equal(split[0].kind === 'markdown' && split[0].atStart, true);
  assert.equal(split[2].kind === 'markdown' && split[2].atStart, false);
  assert.equal(split[1].kind === 'spec' && split[1].source, block1);
  assert.equal(split[3].kind === 'spec' && split[3].source, block2Extended);

  // ```spec nested inside a 4-backtick outer markdown example must NOT split as a live SpecView.
  const nestedExample = [
    'Example syntax:',
    '````markdown',
    '```spec',
    '{"op":"add","path":"/root","value":"example"}',
    '```',
    '````',
  ].join('\n');
  const nestedSegs = splitSpecMarkdown(nestedExample);
  assert.equal(nestedSegs.length, 1);
  assert.equal(nestedSegs[0].kind, 'markdown');
});

test('SpecSession compiles incremental patches idempotently without mutating committedDoc', () => {
  const session = new SpecSession();
  assert.deepEqual(session.ingest('', true), { kind: 'loading' });

  const line1 = '{"op":"add","path":"/root","value":"main"}';
  assert.deepEqual(session.ingest(line1, true), { kind: 'loading' });

  // Trailing complete patch line WITHOUT a trailing newline renders immediately while streaming,
  // and autoFixSpec normalizing element props/children on the tail line must NOT mutate committedDoc.
  const line2WithInlineVisible =
    '{"op":"add","path":"/elements/main","value":{"type":"Card","props":{"title":"Live","visible":true},"children":["note"]}}';
  const streamA = `${line1}\n${line2WithInlineVisible}`;
  const frameA = session.ingest(streamA, true);
  assert.equal(frameA.kind, 'ready');
  // Calling ingest again with identical (source, streaming) is a no-op returning the exact frame.
  assert.equal(session.ingest(streamA, true), frameA);

  // Now commit line2 with a newline and add note element; committedDoc stays clean across tail/commit boundary.
  const streamB = [
    line1,
    line2WithInlineVisible,
    '{"op":"add","path":"/elements/note","value":{"type":"Text","props":{"text":"Ready"},"children":[]}}',
  ].join('\n');
  const frameB = session.ingest(streamB, false);
  assert.equal(frameB.kind, 'ready');
  if (frameB.kind === 'ready') {
    assert.equal(frameB.spec.root, 'main');
    assert.equal(frameB.spec.elements.main?.visible, true);
    assert.equal(frameB.spec.elements.note?.type, 'Text');
  }

  // Whole nested JSON spec converts cleanly when emitted as a single JSON object.
  const nestedSession = new SpecSession();
  const nestedFrame = nestedSession.ingest(
    JSON.stringify({
      type: 'Card',
      props: { title: 'Nested' },
      children: [{ type: 'Text', props: { text: 'Body' }, children: [] }],
    }),
    false,
  );
  assert.equal(nestedFrame.kind, 'ready');
  if (nestedFrame.kind === 'ready') {
    assert.equal(Object.keys(nestedFrame.spec.elements).length, 2);
  }

  // Unknown component types fail explicitly instead of silently dropping UI.
  const unknownSession = new SpecSession();
  const unknownFrame = unknownSession.ingest(
    [
      '{"op":"add","path":"/root","value":"main"}',
      '{"op":"add","path":"/elements/main","value":{"type":"UnknownWidget","props":{},"children":[]}}',
    ].join('\n'),
    false,
  );
  assert.equal(unknownFrame.kind, 'error');
});

test('user-modified state survives streaming /state updates while deletions and shrunk arrays sync cleanly', () => {
  const session = new SpecSession();
  const initialStream = [
    '{"op":"add","path":"/root","value":"main"}',
    '{"op":"add","path":"/elements/main","value":{"type":"Card","props":{"title":"Ops"},"children":[]}}',
    '{"op":"add","path":"/state/latency","value":120}',
    '{"op":"add","path":"/state/obsolete","value":"drop-me"}',
    '{"op":"add","path":"/state/filters","value":{"query":"","staleTag":"old"}}',
    '{"op":"add","path":"/state/nums","value":[10,20,30]}',
    '{"op":"add","path":"/state/tasks","value":[{"id":"1","done":false}]}',
  ].join('\n');

  const first = session.ingest(initialStream, true);
  assert.equal(first.kind, 'ready');
  assert.equal(session.store.get('/latency'), 120);
  assert.equal(session.store.get('/obsolete'), 'drop-me');
  assert.deepEqual(session.store.get('/nums'), [10, 20, 30]);

  // User interacts locally while the model is still streaming.
  session.userSet('/latency', 42);
  session.userSet('/filters/query', 'gpu');
  session.userSet('/nums/0', 99);
  session.userSet('/tasks/0/done', true);

  // Later streaming patches update /latency, delete /obsolete and /filters/staleTag,
  // shrink /nums from 3 items to 2 items, and append /tasks/1.
  const grownStream = [
    initialStream,
    '{"op":"replace","path":"/state/latency","value":999}',
    '{"op":"remove","path":"/state/obsolete"}',
    '{"op":"remove","path":"/state/filters/staleTag"}',
    '{"op":"replace","path":"/state/nums","value":[10,25]}',
    '{"op":"add","path":"/state/tasks/1","value":{"id":"2","done":false}}',
    '{"op":"add","path":"/state/region","value":"ap-east"}',
  ].join('\n');

  const second = session.ingest(grownStream, false);
  assert.equal(second.kind, 'ready');
  assert.equal(session.store.get('/latency'), 42);
  assert.equal(session.store.get('/obsolete'), undefined);
  assert.equal('obsolete' in session.store.getSnapshot(), false);
  assert.deepEqual(session.store.get('/filters'), { query: 'gpu' });
  assert.deepEqual(session.store.get('/nums'), [99, 25]);
  assert.equal(session.store.get('/tasks/0/done'), true);
  assert.deepEqual(session.store.get('/tasks/1'), { id: '2', done: false });
  assert.equal(session.store.get('/region'), 'ap-east');

  // Targeted reset restores the latest spec initial state for that path.
  session.resetState('/latency');
  assert.equal(session.store.get('/latency'), 999);
  assert.equal(session.store.get('/tasks/0/done'), true);

  // Full reset restores the entire spec initial state cleanly.
  session.resetState();
  assert.equal(session.store.get('/tasks/0/done'), false);
  assert.deepEqual(session.store.get('/nums'), [10, 25]);
  assert.deepEqual(session.store.get('/filters'), { query: '' });
});

test('Table cell sorting converts matching duration/byte domains and rejects cross-domain or malformed units', () => {
  // Duration domain converts s/ms/us/ns to milliseconds.
  assert.deepEqual(
    ['1.5 s', '450 ms', '120 ms', '800 us'].sort((a, b) => compareTableCells(a, b, true)),
    ['800 us', '120 ms', '450 ms', '1.5 s'],
  );
  assert.deepEqual(
    ['120 ms', '1.5 s'].sort((a, b) => compareTableCells(a, b, false)),
    ['1.5 s', '120 ms'],
  );

  // Bytes domain scales B/KB/MB/GB/TB cleanly.
  assert.deepEqual(
    ['2 MB', '500 KB', '1.5 GB', '900 B', '1 TB'].sort((a, b) => compareTableCells(a, b, true)),
    ['900 B', '500 KB', '2 MB', '1.5 GB', '1 TB'],
  );

  // Same-currency values sort numerically, while malformed currency+unit strings are rejected.
  assert.deepEqual(
    ['$1,200', '-$5.50', '$9.99'].sort((a, b) => compareTableCells(a, b, true)),
    ['-$5.50', '$9.99', '$1,200'],
  );
  assert.equal(parseSortableNumber('$10 ms'), null);
  assert.equal(parseSortableNumber('$10 KB'), null);
  assert.equal(parseSortableNumber('$10%'), null);

  // Distinct domains must never compare as equal numeric values; they fall back to natural text.
  const crossDomain = ['$10', '€10', '10%', '10 ms', '10 B', '10'];
  for (let i = 0; i < crossDomain.length; i++) {
    for (let j = i + 1; j < crossDomain.length; j++) {
      assert.notEqual(
        compareTableCells(crossDomain[i], crossDomain[j], true),
        0,
        `${crossDomain[i]} vs ${crossDomain[j]} must not compare equal`,
      );
    }
  }

  // Natural text fallback orders embedded numbers numerically.
  assert.deepEqual(
    ['node-10', 'node-1', 'node-2'].sort((a, b) => compareTableCells(a, b, true)),
    ['node-1', 'node-2', 'node-10'],
  );
});
