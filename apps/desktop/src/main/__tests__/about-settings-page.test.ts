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
import { afterEach, test } from 'node:test';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
import {
  DiagnosticsServicesProvider,
  createFakeDiagnosticsServices,
  type DiagnosticsServices,
  type ManualDiagnosticTarget,
} from '../../renderer/features/diagnostics/testing.js';
import { getSettingsPreferencesCopy } from '../../renderer/locales/settings-preferences-copy.js';
import { AboutSettingsPage } from '../../renderer/settings/about-settings-page.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

type TreeNode = { readonly childNodes?: readonly TreeNode[]; readonly tagName?: string; readonly textContent: string };

afterEach(() => {
  cleanupFakeDom();
});

function aboutPage(services: DiagnosticsServices) {
  const page = createElement(AboutSettingsPage, {});
  const withToasts = createElement(ToastProvider, { children: page });
  const withDiagnostics = createElement(DiagnosticsServicesProvider, { services, children: withToasts });
  const withAstryxLocale = createElement(AstryxLocaleProvider, { children: withDiagnostics });
  return createElement(LocaleProvider, { locale: 'en', children: withAstryxLocale });
}

async function clickCopyDiagnostics(root: TreeNode, label: string): Promise<void> {
  const buttons: TreeNode[] = [];
  const visit = (node: TreeNode) => {
    if (node.tagName === 'BUTTON') buttons.push(node);
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(root);
  const key = (button: TreeNode) => Object.keys(button).find((candidate) => candidate.startsWith('__reactProps$'));
  const props = (button: TreeNode) =>
    (button as unknown as Record<string, { 'aria-label'?: string; onClick?(event: unknown): void }>)[key(button) ?? ''];
  const button = buttons.find((candidate) => props(candidate)?.['aria-label'] === label);
  assert.ok(button, `missing button ${label}`);
  await act(async () => props(button)?.onClick?.({ preventDefault() {}, stopPropagation() {} }));
  await act(async () => {});
}

function mountWithPendingInfo() {
  const mounted = installReactRenderer();
  // About's metadata never arrives here: the copy row must not depend on it.
  (globalThis.window as unknown as { maka: unknown }).maka = {
    runtimeHostProfiles: { getDefaultHost: () => new Promise(() => {}) },
  };
  return mounted;
}

test('keeps manual diagnostics available while About metadata is pending', () => {
  const markup = renderToStaticMarkup(aboutPage(createFakeDiagnosticsServices()));

  // The row LABEL also reads "Copy diagnostics", so match the control itself:
  // its accessible name is the aria-label, not the verb on its face.
  assert.match(markup, /<button[^>]*aria-label="Copy diagnostics"/);
  assert.match(markup, /role="status"[^>]*aria-busy="true"/);
});

test('copies the manual report through the diagnostics feature, without a target', async () => {
  const { root, container } = mountWithPendingInfo();
  const calls: Array<ManualDiagnosticTarget | undefined>[] = [];
  const services = createFakeDiagnosticsServices({
    copyManualReport: async (...args) => {
      calls.push(args);
    },
  });
  const copy = getSettingsPreferencesCopy('en').about;
  await act(async () => root.render(aboutPage(services)));

  await clickCopyDiagnostics(container, copy.copyDiagnostics);

  assert.deepEqual(calls, [[]]);
  assert.ok(container.textContent.includes(copy.copied));
});

test('reports a failed manual copy with About\'s own words', async () => {
  const { root, container } = mountWithPendingInfo();
  let attempts = 0;
  const services = createFakeDiagnosticsServices({
    copyManualReport: async () => {
      attempts += 1;
      throw new Error('denied');
    },
  });
  const copy = getSettingsPreferencesCopy('en').about;
  await act(async () => root.render(aboutPage(services)));

  await clickCopyDiagnostics(container, copy.copyDiagnostics);

  assert.equal(attempts, 1);
  assert.ok(container.textContent.includes(copy.copyFailed));
  assert.ok(container.textContent.includes(copy.clipboardUnavailable));
});
