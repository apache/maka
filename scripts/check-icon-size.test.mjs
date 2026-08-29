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
import { test } from 'node:test';
import { findRawIconSizes } from './check-icon-size.mjs';

const repoRoot = '/repo';

function expressions(source, file = `${repoRoot}/apps/desktop/src/example.tsx`) {
  return findRawIconSizes(source, file, { repoRoot }).map((hit) => hit.expression);
}

test('rejects numeric sizes on named, aliased, derived, and namespace icon imports', () => {
  assert.deepEqual(
    expressions(`
      import { ICON_SIZE, Search, Trash2 as DeleteIcon } from '@maka/ui/icons';
      import * as Icons from '@maka/ui/icons';
      const SelectedIcon = true ? Search : DeleteIcon;
      export const Example = () => <>
        <Search size={16} />
        <DeleteIcon size={15.5} />
        <SelectedIcon size={14 as const} />
        <Icons.Sparkles size={+28} />
      </>;
    `),
    ['size={16}', 'size={15.5}', 'size={14 as const}', 'size={+28}'],
  );
});

test('accepts ICON_SIZE and ignores unrelated size props, comments, and non-numeric strings', () => {
  assert.deepEqual(
    expressions(`
      import { ICON_SIZE, Search } from '@maka/ui/icons';
      /* <Search size={16} /> */
      const sample = '<Search size={15} />';
      export const Example = () => <>
        <Search size={ICON_SIZE.chrome} />
        <Search size="lg" />
        <Avatar size={16} />
      </>;
    `),
    [],
  );
});

test('rejects numeric string sizes on icon tags', () => {
  assert.deepEqual(
    expressions(`
      import { Search } from '@maka/ui/icons';
      export const Example = () => <Search size="16" />;
    `),
    ['size="16"'],
  );
});

test('rejects statically provable expressions, passthroughs, and props spreads', () => {
  assert.deepEqual(
    expressions(`
      import { Search } from '@maka/ui/icons';
      const raw = 8 + 8;
      const props = { size: '16' };
      export const Example = () => <>
        <Search size={'16'} />
        <Search size={\`16\`} />
        <Search size={8 + 8} />
        <Search size={raw} />
        <Search size={props.size} />
        <Search {...props} />
      </>;
    `),
    ["size={'16'}", 'size={`16`}', 'size={8 + 8}', 'size={raw}', 'size={props.size}', '{...props}'],
  );
});

test('tracks icon provenance through Object.entries, flatMap, and destructured map callbacks', () => {
  assert.deepEqual(
    expressions(`
      import * as Icons from '@maka/ui/icons';
      const ICONS = Object.entries(Icons)
        .flatMap(([name, value]) => value ? [{ name, Comp: value }] : [])
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      export const Example = () => ICONS.map(({ Comp }) => <Comp size={20} />);
    `),
    ['size={20}'],
  );
});

test('tracks computed lookups into statically closed icon records', () => {
  assert.deepEqual(
    expressions(`
      import { AlertCircle, CheckCircle2 } from '@maka/ui/icons';
      const STATUS_ICONS = {
        failed: AlertCircle,
        completed: CheckCircle2,
      } satisfies Record<TaskStatus, typeof AlertCircle>;
      export const Example = ({ status }) => {
        const StatusIcon = STATUS_ICONS[status];
        return <StatusIcon size={13} />;
      };
    `),
    ['size={13}'],
  );
});

test('does not infer dynamic lookups from mixed or open records as icons', () => {
  assert.deepEqual(
    expressions(`
      import { AlertCircle } from '@maka/ui/icons';
      const MIXED = { failed: AlertCircle, completed: Avatar };
      const OPEN = { failed: AlertCircle, ...extra };
      export const Example = ({ status }) => {
        const Mixed = MIXED[status];
        const Open = OPEN[status];
        return <><Mixed size={13} /><Open size={13} /></>;
      };
    `),
    [],
  );
});

test('does not treat shadowed or unrelated local tags as icons', () => {
  assert.deepEqual(
    expressions(`
      import { Search } from '@maka/ui/icons';
      function Shadow(Search) {
        return <Search size={16} />;
      }
      export const Example = () => {
        const Comp = Avatar;
        return <Comp size={20} />;
      };
    `),
    [],
  );
});

test('resolves the relative icon seam', () => {
  assert.deepEqual(
    expressions(
      `
        import { Search } from './icons.js';
        import * as Icons from './icons.js';
        export const Example = () => <><Search size={13} /><Icons.Info size={20} /></>;
      `,
      `${repoRoot}/packages/ui/src/example.tsx`,
    ),
    ['size={13}', 'size={20}'],
  );
});
