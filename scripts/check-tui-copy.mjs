#!/usr/bin/env node
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

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';

const root = fileURLToPath(new URL('..', import.meta.url));

export const COVERED_FILES = [
  'packages/cli/src/pi-tui-transcript-viewer.ts',
  'packages/cli/src/pi-tui-turn.ts',
  'packages/cli/src/pi-tui-runner.ts',
  'packages/cli/src/pi-tui-mcp-status.ts',
  'packages/cli/src/pi-transcript.ts',
  'packages/cli/src/pi-tui-pickers.ts',
  'packages/cli/src/tui-primary-guidance.ts',
  'packages/cli/src/tui-session-status.ts',
  'packages/cli/src/runtime-host-onboarding.ts',
  'packages/cli/src/runtime-host-tui-command.ts',
  'packages/cli/src/tui-attention.ts',
  'packages/cli/src/tui-copy-command.ts',
  'packages/cli/src/tui-shortcut-copy.ts',
  'packages/cli/src/pi-tui-layout.ts',
];

export const EXCLUDED_TUI_FILES = [
  'packages/cli/src/pi-tui-contracts.ts',
  'packages/cli/src/runtime-host-tui-context.ts',
  'packages/cli/src/tui-ansi.ts',
  'packages/cli/src/tui-autocomplete-layout.ts',
  'packages/cli/src/tui-clipboard.ts',
  'packages/cli/src/tui-context-refresh.ts',
  'packages/cli/src/tui-copy-catalog.ts',
  'packages/cli/src/tui-diff.ts',
  'packages/cli/src/tui-mcp-control.ts',
  'packages/cli/src/tui-mcp-remote-publication.ts',
];

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const VISIBLE_PROPERTIES = new Set(['title', 'hint', 'placeholder', 'notice', 'label']);
const VISIBLE_CALLS = new Set([
  'notice',
  'addNotice',
  'setNotice',
  'setStatus',
  'setMessage',
  'question',
  'write',
  'Text',
]);

export const ALLOWED_VISIBLE_LITERALS = {
  'packages/cli/src/pi-tui-runner.ts': [
    'Usage: !<command>',
    'Cannot run a user command while a turn is running.',
    'Cannot change or start Swarm Mode while a turn is running.',
    'Cannot change or start Graph Mode while a turn is running.',
    'Cannot run /${…} while a turn is running — interrupt it (Esc) or wait for it to finish.',
    'Model changed: ${…} → ${…}',
    'Model changed: ${…} → ${…}',
    'Model changed: ${…} (${…}) → ${…} (${…})',
    'Thinking: ${…}',
    'Thinking: default',
    'Session moved to "${…}".${…}',
    'Resumed session "${…}"',
    'Resumed session "${…}"',
    'Detached from the running Turn — it keeps running. /session back to reattach.',
    'Side conversation closed; cleanup will be retried on the next launch.',
    'Close the current side conversation before opening another.',
    'Side conversations are unavailable on this runtime.',
    'Side conversation opened.',
    'Side conversation closed; cleanup will be retried on the next launch.',
    '↑↓ move · type to answer · Enter select · Esc unanswered · Ctrl+C stop',
    'Other: type your answer…',
    'Recap is not available in this environment.',
    'Recap already running.',
    'Nothing to recap yet.',
    'Recap failed: ${…}',
    'Recap: ${…}',
    'Compacting context…',
    'Resuming from the latest safe boundary…',
    'Resume Session',
    'Tab scope · ↑↓ move · Enter select · Esc close',
    'Permissions: ${…}',
    'Keep Auto',
    'Turn on full access',
    'Using Swarm Mode for this turn only.',
    'Swarm Mode is on for this session.',
    'Swarm Mode is off for this session.',
    'Swarm Mode enabled for this session.',
    'Swarm Mode disabled.',
    'Run #${…}${…}',
    'This session has no Agent Graph runs.',
    '↑↓ move · Enter inspect · Esc close',
    'Using Graph Mode for this turn only.',
    'Graph Mode is on for this session.',
    'Graph Mode is off.',
    'Graph Mode enabled for this session.',
    'Graph Mode disabled.',
    ' · Current',
    'Moving sessions is not available in this environment.',
    'Session is already at "${…}".',
    'Session moved to "${…}".${…}',
    'Moving sessions is not available in this environment.',
    'Goal status is unavailable on this runtime.',
    'No goal set.',
    'No goal set.',
    'Goal control is unavailable on this runtime.',
    'Cannot pause: the goal is ${…}.',
    'Cannot resume: the goal is ${…}.',
    'Cannot clear: the goal is ${…}.',
    'Goal paused. /goal resume continues it, /goal clear stops it.',
    'Goal resumed.',
    'Goal cleared.',
    'Goal cleared.',
    'The goal no longer exists.',
    'Usage: /context',
    'Usage: /thinking ${…}',
    'default',
    'Usage: /compact',
    'Usage: /goal [pause|resume|clear]',
    'Cannot control the goal while a turn or another action is running — interrupt it (Esc) or wait for it to finish.',
    'Usage: /mcp',
    'Usage: /setup',
    'Usage: /model <model-id>',
    'Usage: /transcript',
    'Usage: /permissions auto|bypass',
    'Usage: /rename <new name>',
    'Session renamed to "${…}"',
    'Usage: /resume',
    'Usage: /session <session-id>',
    'Press Ctrl+C again to exit.',
    'Could not resume session ${…}: ${…}.${…} Starting fresh.',
  ],
  'packages/cli/src/pi-transcript.ts': [
    'User command',
    '${…} ${…} above the view stayed expanded in scrollback — press ${…} again within ${…}s to collapse them too (this redraws the screen and clears pre-session scrollback). New ${…} starts collapsed.',
    'Access ${…}',
    'Plan submitted: ${…}',
    'Stopped: ${…}',
    'Stopped: max tokens',
    'Background task ${…}: ${…}${…}${…}',
    'Context compacted.',
    'Nothing to compact.',
    'Context compaction failed: ${…}.',
    'expanded',
    'unchanged',
  ],
  'packages/cli/src/pi-tui-pickers.ts': ['/skill:${…}', '/skill:${…}', 'Auto', 'Full access'],
  'packages/cli/src/runtime-host-tui-command.ts': [
    'Maka',
    'Maka — ${…}',
    'Maka',
    'Restart this local Host if it is idle, wait for it to exit, or cancel? [r/w/C] ',
    'Wait only if the existing Host is expected to exit, or cancel? [w/C] ',
    'The existing Runtime Host still owns active or durable work and was not interrupted.\n',
  ],
};

function staticText(node) {
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'JSXText') return node.value.trim() || undefined;
  if (node?.type !== 'TemplateLiteral') return undefined;
  return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('${…}');
}

function propertyName(node) {
  if (!node || node.computed) return undefined;
  if (node.key.type === 'Identifier') return node.key.name;
  return staticText(node.key);
}

function calleeName(node) {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression') {
    if (!node.computed && node.property.type === 'Identifier') return node.property.name;
    return staticText(node.property);
  }
  return undefined;
}

function containsLocaleReference(node) {
  let found = false;
  walk(node, (candidate) => {
    if (candidate.type === 'Identifier' && /locale/i.test(candidate.name)) {
      found = true;
    }
  });
  return found;
}

function containsLiteralCopy(node) {
  let found = false;
  walk(node, (candidate) => {
    const value = staticText(candidate);
    if (value !== undefined && containsCopyCharacters(value)) found = true;
  });
  return found;
}

function containsCopyCharacters(value) {
  return /[\p{L}\p{N}]/u.test(value);
}

function noticeTextProperty(node) {
  if (node.type !== 'ObjectProperty' || propertyName(node) !== 'text') return false;
  const object = node.__parent;
  if (object?.type !== 'ObjectExpression') return false;
  return object.properties.some(
    (property) =>
      property.type === 'ObjectProperty' &&
      propertyName(property) === 'kind' &&
      staticText(property.value) === 'notice',
  );
}

function visibleLiteral(node) {
  if (node.type === 'JSXText') return true;
  let child = node;
  for (let parent = node.__parent; parent; child = parent, parent = parent.__parent) {
    if (parent.type === 'JSXAttribute') {
      return parent.name.type === 'JSXIdentifier' && VISIBLE_PROPERTIES.has(parent.name.name);
    }
    if (parent.type === 'JSXElement' || parent.type === 'JSXFragment') return true;
    if (parent.type === 'ConditionalExpression' && parent.test === child) return false;
    if (parent.type === 'ObjectProperty' && parent.value === child) {
      const name = propertyName(parent);
      return VISIBLE_PROPERTIES.has(name) || noticeTextProperty(parent);
    }
    if (
      (parent.type === 'CallExpression' ||
        parent.type === 'OptionalCallExpression' ||
        parent.type === 'NewExpression') &&
      VISIBLE_CALLS.has(calleeName(parent.callee)) &&
      parent.arguments.includes(child)
    ) {
      return true;
    }
  }
  return false;
}

function walk(node, visit, parent) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') {
    Object.defineProperty(node, '__parent', { value: parent, configurable: true });
    visit(node);
    parent = node;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === '__parent' || key === 'loc' || key === 'start' || key === 'end') continue;
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit, parent);
    } else if (value && typeof value === 'object') {
      walk(value, visit, parent);
    }
  }
}

function failure(file, node, rule, text) {
  return { file, line: node.loc?.start.line ?? 1, rule, text };
}

export function checkSource(source, file = '<source>') {
  const ast = parse(source, {
    sourceType: 'module',
    plugins: ['typescript', 'jsx', 'importAttributes'],
    errorRecovery: false,
  });
  const failures = [];
  walk(ast, (node) => {
    const text = staticText(node);
    if (text !== undefined && CJK.test(text)) {
      failures.push(failure(file, node, 'cjk-literal', text));
    }
    if (
      (node.type === 'ConditionalExpression' || node.type === 'IfStatement') &&
      containsLocaleReference(node.test) &&
      (containsLiteralCopy(node.consequent) || containsLiteralCopy(node.alternate))
    ) {
      failures.push(failure(file, node, 'locale-branch', source.slice(node.start, node.end)));
    }
    if (
      node.type === 'SwitchStatement' &&
      containsLocaleReference(node.discriminant) &&
      node.cases.some((item) => item.consequent.some(containsLiteralCopy))
    ) {
      failures.push(failure(file, node, 'locale-branch', source.slice(node.start, node.end)));
    }
    if (text !== undefined && containsCopyCharacters(text) && visibleLiteral(node)) {
      failures.push(failure(file, node, 'visible-literal', text));
    }
  });
  return failures;
}

export function unexpectedFailures(failures, allowed = ALLOWED_VISIBLE_LITERALS) {
  const remaining = [];
  const inventory = new Map();
  for (const [file, entries] of Object.entries(allowed)) {
    for (const entry of entries) {
      const key = `${file}\u0000visible-literal\u0000${entry}`;
      inventory.set(key, (inventory.get(key) ?? 0) + 1);
    }
  }
  for (const failure of failures) {
    const key = `${failure.file}\u0000${failure.rule}\u0000${failure.text}`;
    const count = inventory.get(key) ?? 0;
    if (count === 0) remaining.push(failure);
    else inventory.set(key, count - 1);
  }
  for (const [key, count] of inventory) {
    if (count === 0) continue;
    const [file, rule, text] = key.split('\u0000');
    remaining.push({ file, line: 1, rule: 'stale-allowance', text: `${rule}: ${text}` });
  }
  return remaining;
}

export function checkFiles(files = COVERED_FILES) {
  const failures = files.flatMap((file) =>
    checkSource(readFileSync(join(root, file), 'utf8'), file),
  );
  return unexpectedFailures(failures);
}

export function unclassifiedTuiFiles() {
  const classified = new Set([...COVERED_FILES, ...EXCLUDED_TUI_FILES]);
  return readdirSync(join(root, 'packages/cli/src'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).replaceAll(sep, '/'))
    .filter(
      (file) =>
        !file.includes('/__tests__/') &&
        /(?:^|[-/])tui(?:-|\.)/u.test(file) &&
        !classified.has(file),
    );
}

function main() {
  const failures = [
    ...unclassifiedTuiFiles().map((file) => ({
      file,
      line: 1,
      rule: 'unclassified-tui-file',
      text: 'Add this file to COVERED_FILES or EXCLUDED_TUI_FILES.',
    })),
    ...checkFiles(),
  ];
  if (failures.length === 0) {
    console.log(`TUI copy boundaries: ok (${COVERED_FILES.length} files)`);
    return;
  }
  for (const item of failures) {
    console.error(`${item.file}:${item.line}: ${item.rule}: ${JSON.stringify(item.text)}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
