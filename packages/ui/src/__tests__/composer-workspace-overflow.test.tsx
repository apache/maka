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
import { act, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { LocaleProvider } from '../locale-context.js';
import { useComposerWorkspaceOverflow } from '../use-composer-workspace-overflow.js';
import { WorkspacePicker, type WorkspacePickerModel } from '../workspace-picker.js';

const picker: WorkspacePickerModel = {
  label: 'Example project',
  selectedGroupId: 'host',
  groups: [{
    id: 'host', label: 'Remote Host', selectedProjectId: 'project',
    projects: [{ id: 'project', name: 'Example project', available: true, locations: [] }],
    projectWorktrees: {
      project: { value: 'new', options: [{ value: 'main', label: 'Main' }, { value: 'new', label: 'New' }], onSelect() {} },
    },
  }],
};

test('compact directory pickers retain accessible names while Astryx removes visible labels', () => {
  const render = (compact: boolean) => parseHTML(renderToStaticMarkup(
    <LocaleProvider locale="en"><WorkspacePicker workspacePicker={picker} compact={compact} /></LocaleProvider>,
  )).document;
  const expanded = render(false);
  const compact = render(true);
  for (const selector of ['.maka-workspace-picker', '.maka-worktree-picker']) {
    const expandedButton = expanded.querySelector(selector);
    const compactButton = compact.querySelector(selector);
    assert.ok(expandedButton && compactButton);
    assert.ok(expandedButton.textContent?.trim());
    assert.equal(compactButton.textContent?.trim(), '');
    assert.equal(compactButton.getAttribute('aria-label'), expandedButton.getAttribute('aria-label'));
    assert.equal(compactButton.getAttribute('aria-haspopup'), 'menu');
  }
  assert.ok(expanded.querySelector('.maka-workspace-picker-divider'));
  assert.equal(compact.querySelector('.maka-workspace-picker-divider'), null);
});

test('workspace overflow settles and remeasures on width and hidden label changes', async (t) => {
  const { document, window } = parseHTML('<div id="root"></div>');
  const previous = {
    document: globalThis.document, window: globalThis.window,
    ResizeObserver: globalThis.ResizeObserver, MutationObserver: globalThis.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };
  const observers = new Set<() => void>();
  Object.assign(globalThis, {
    document, window, MutationObserver: window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      constructor(private readonly notify: () => void) {}
      observe() { observers.add(this.notify); }
      disconnect() { observers.delete(this.notify); }
    },
  });
  const container = document.querySelector('#root')!;
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
  });
  let availableWidth = 200;
  let renders = 0;
  function Footer({ model }: { model: WorkspacePickerModel }) {
    const overflow = useComposerWorkspaceOverflow(model);
    renders++;
    // Layout is the browser's input to this hook. Keep the required expanded
    // width independent of the compact buttons, as it is in the real footer.
    const attach = useCallback((node: HTMLDivElement | null) => {
      overflow.ref.current = node;
      if (node) Object.defineProperties(node, {
        clientWidth: { configurable: true, get: () => availableWidth },
        scrollWidth: { configurable: true, get: () => Math.max(availableWidth,
          node.dataset.workspaceLayout === 'compact' ? 150 : 120 + (model.label?.length ?? 0) * 10) },
      });
    }, [overflow.ref, model]);
    return <div ref={attach} data-workspace-layout={overflow.layout}>
      <div className="maka-composer-workspace"><button type="button">{overflow.compact ? null : model.label}</button></div>
    </div>;
  }
  const render = async (model: WorkspacePickerModel) => {
    await act(async () => root.render(<LocaleProvider locale="en"><Footer model={model} /></LocaleProvider>));
  };
  const resize = async (width = availableWidth) => { await act(async () => {
    availableWidth = width;
    for (const notify of [...observers]) notify();
  }); };
  const layout = () => container.querySelector('[data-workspace-layout]')?.getAttribute('data-workspace-layout');
  await render(picker);
  assert.equal(layout(), 'compact');
  const settledRenders = renders;
  await resize();
  await resize();
  assert.equal(renders, settledRenders, 'initial observer delivery must not restart measurement');

  await resize(400);
  assert.equal(layout(), 'expanded');
  await resize(200);
  assert.equal(layout(), 'compact');
  await render({ ...picker, label: 'A' });
  assert.equal(layout(), 'expanded', 'a shorter hidden label can restore the expanded controls');
  await render({ ...picker, label: 'A much longer project name' });
  assert.equal(layout(), 'compact');
});
