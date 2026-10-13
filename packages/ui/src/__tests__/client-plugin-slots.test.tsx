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
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MakaClientSessionScope,
  MakaClientSlotCore,
  MakaClientSlotOutlet,
  MakaClientSlotProvider,
  type MakaClientRenderSlots,
  type MakaClientSlotRuntimeProps,
} from '../client-plugin-slots.js';
import type { MakaClientPluginContext } from '../client-plugin-runtime.js';

declare module '../client-plugin-slots.js' {
  interface MakaClientSlotMap {
    'test.single': {
      kind: 'single';
      scope: 'root';
      owner: { readonly label: string };
    };
    'test.list': { kind: 'list'; scope: 'root' };
    'test.keyed': {
      kind: 'keyed';
      scope: 'session';
      owner: { readonly common: string };
      keyProps: {
        bash: { readonly command: string };
        read: { readonly path: string };
      };
    };
    'test.chain': {
      kind: 'chain';
      scope: 'session-maybe';
      owner: { readonly mode: 'plain' | 'plan' };
    };
    'test.child': { kind: 'single'; scope: 'root' };
  }
}

const TEST_SPECS = {
  'test.single': { kind: 'single', scope: 'root' },
  'test.list': { kind: 'list', scope: 'root' },
  'test.keyed': { kind: 'keyed', scope: 'session' },
  'test.chain': { kind: 'chain', scope: 'session-maybe' },
} as const;

function compilePluginContextTypes(ctx: MakaClientPluginContext): void {
  ctx.slots.register(
    {
      name: 'test.single',
      children: { 'test.child': { kind: 'single', scope: 'root' } },
    },
    ({ label, renderSlot }) => (
      <section aria-label={label}>{renderSlot('test.child', {})}</section>
    ),
  );
  ctx.slots.register({ name: 'test.child' }, () => null);
}

void compilePluginContextTypes;

describe('Maka Client Slot core', () => {
  it('supports single/list/keyed shadowing and stable list order', () => {
    const core = new MakaClientSlotCore(TEST_SPECS);
    const Single = ({ label }: MakaClientSlotRuntimeProps<'test.single'>) => <b>{label}</b>;
    core.register({ name: 'test.single', priority: 10 }, Single);
    core.register({ name: 'test.single', priority: 0 }, Single);
    assert.equal(core.activeEntries('test.single')[0]?.options.priority, 0);
    assert.throws(
      () => core.register({ name: 'test.single' }, Single),
      /already has a registration/u,
    );

    core.register({ name: 'test.list', id: 'late', order: 20 }, () => null);
    core.register({ name: 'test.list', id: 'early', order: 10 }, () => null);
    core.register(
      { name: 'test.list', id: 'early', order: 99, priority: 5 },
      () => null,
    );
    assert.deepEqual(
      core.activeEntries('test.list').map((entry) => entry.options.id),
      ['early', 'late'],
    );

    core.register(
      { name: 'test.keyed', key: 'bash' },
      ({ command }: MakaClientSlotRuntimeProps<'test.keyed', 'bash'>) => <i>{command}</i>,
    );
    assert.equal(core.activeEntries('test.keyed')[0]?.options.key, 'bash');
  });

  it('removes a recursively declared subtree with its parent', () => {
    const core = new MakaClientSlotCore(TEST_SPECS);
    const disposeParent = core.register(
      {
        name: 'test.single',
        children: { 'test.child': { kind: 'single', scope: 'root' } },
      },
      (
        _props: MakaClientSlotRuntimeProps<'test.single'> &
          MakaClientRenderSlots<'test.child'>,
      ) => null,
    );
    const disposeChild = core.register({ name: 'test.child' }, () => null);
    assert.equal(core.spec('test.child')?.kind, 'single');
    assert.equal(core.entries('test.child').length, 1);

    disposeParent();
    assert.equal(core.spec('test.child'), undefined);
    assert.equal(core.entries('test.child').length, 0);
    disposeChild();
  });
});

describe('Maka Client Slot outlets', () => {
  it('renders typed keyed props only inside a strict Session scope', () => {
    const core = new MakaClientSlotCore(TEST_SPECS);
    core.register(
      { name: 'test.keyed', key: 'bash' },
      ({ common, command, sessionId }: MakaClientSlotRuntimeProps<'test.keyed', 'bash'>) => (
        <p>{common}:{command}:{sessionId}</p>
      ),
    );
    const absent = renderToStaticMarkup(
      <MakaClientSlotProvider core={core}>
        <MakaClientSlotOutlet
          name="test.keyed"
          owner={{ common: 'tool', command: 'pwd' }}
          options={{ entryKey: 'bash', fallback: <em>empty</em> }}
        />
      </MakaClientSlotProvider>,
    );
    assert.match(absent, /empty/u);

    const present = renderToStaticMarkup(
      <MakaClientSlotProvider core={core}>
        <MakaClientSessionScope sessionId="session-1">
          <MakaClientSlotOutlet
            name="test.keyed"
            owner={{ common: 'tool', command: 'pwd' }}
            options={{ entryKey: 'bash' }}
          />
        </MakaClientSessionScope>
      </MakaClientSlotProvider>,
    );
    assert.match(present, /tool:pwd:session-1/u);
  });

  it('elects the first matching chain and keeps an overlay fallback mounted', () => {
    const core = new MakaClientSlotCore(TEST_SPECS);
    core.register(
      {
        name: 'test.chain',
        select: ({ mode }) => (mode === 'plan' ? { label: 'planner' } : null),
      },
      ({ matched, sessionId }: MakaClientSlotRuntimeProps<'test.chain'> & {
        readonly matched: { readonly label: string };
      }) => <strong>{matched.label}:{sessionId ?? 'none'}</strong>,
    );
    const markup = renderToStaticMarkup(
      <MakaClientSlotProvider core={core}>
        <MakaClientSlotOutlet
          name="test.chain"
          owner={{ mode: 'plan' }}
          options={{ fallback: <span>composer</span>, overlay: true }}
        />
      </MakaClientSlotProvider>,
    );
    assert.match(markup, /display:none/u);
    assert.match(markup, /composer/u);
    assert.match(markup, /planner:none/u);
  });
});
