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
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { act, createElement, useEffect, type ReactNode } from 'react';
import type { UiLocale } from '@maka/core/ui-locale';
import {
  AstryxLocaleProvider,
  LocaleProvider,
  ToastProvider,
  useToast,
  type ToastDiagnosticTarget,
} from '@maka/ui';
import type { DesktopDiagnosticInput } from '../../preload/diagnostics-contract.js';
import {
  createDesktopDiagnosticsServices,
  type DesktopDiagnosticsBridge,
} from '../../renderer/platform/desktop/create-diagnostics-services.js';
import {
  DiagnosticReportToastProvider,
  DiagnosticsServicesProvider,
  PreviousMainProcessInterruptionNotice,
  createFakeDiagnosticsServices,
  getDiagnosticsCopy,
  type DiagnosticsServices,
  type ToastDiagnosticReport,
} from '../../renderer/features/diagnostics/testing.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

type TreeNode = { readonly childNodes?: readonly TreeNode[]; readonly tagName?: string; readonly textContent: string };

const restoreAfterEach: Array<() => void> = [];

afterEach(() => {
  cleanupFakeDom();
  while (restoreAfterEach.length > 0) restoreAfterEach.pop()?.();
});

/**
 * Astryx looks the dismissed toast up in its viewport to hand focus on. The
 * fake DOM has no selector engine; nothing here holds focus, so "not found" is
 * the true answer. Scoped to one test so the shared harness stays minimal.
 */
function answerToastLookups(container: object): void {
  const prototype = Object.getPrototypeOf(container) as { querySelector?: unknown };
  if ('querySelector' in prototype) return;
  prototype.querySelector = () => null;
  restoreAfterEach.push(() => {
    delete prototype.querySelector;
  });
}

function elements(root: TreeNode, tagName: string): TreeNode[] {
  const found: TreeNode[] = [];
  const visit = (node: TreeNode) => {
    if (node.tagName === tagName) found.push(node);
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(root);
  return found;
}

function occurrences(root: TreeNode, text: string): number {
  return root.textContent.split(text).length - 1;
}

async function clickButton(root: TreeNode, label: string): Promise<void> {
  const button = elements(root, 'BUTTON').find((candidate) => candidate.textContent === label);
  assert.ok(button, `missing button ${label}`);
  const key = Object.keys(button).find((candidate) => candidate.startsWith('__reactProps$'));
  assert.ok(key, 'missing React button props');
  const props = (button as unknown as Record<string, { onClick(event: unknown): void }>)[key];
  await act(async () => props.onClick({ preventDefault() {}, stopPropagation() {} }));
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolvePromise = resolveValue;
  });
  return { promise, resolve: resolvePromise };
}

function localized(locale: UiLocale, services: DiagnosticsServices, children: ReactNode) {
  return createElement(LocaleProvider, {
    locale,
    children: createElement(AstryxLocaleProvider, {
      children: createElement(DiagnosticsServicesProvider, { services, children }),
    }),
  });
}

function noticeTree(locale: UiLocale, services: DiagnosticsServices, ready: boolean) {
  return localized(
    locale,
    services,
    createElement(ToastProvider, {
      children: createElement(PreviousMainProcessInterruptionNotice, { ready }),
    }),
  );
}

describe('PreviousMainProcessInterruptionNotice', () => {
  test('reads nothing until ready, then shows the notice once and copies its report', async () => {
    const { root, container } = installReactRenderer();
    answerToastLookups(container);
    let reads = 0;
    let copies = 0;
    const services = createFakeDiagnosticsServices({
      takePreviousMainProcessInterruption: async () => {
        reads += 1;
        return true;
      },
      copyPreviousMainProcessInterruption: async () => {
        copies += 1;
      },
    });
    const copy = getDiagnosticsCopy('en').previousMainProcessInterruption;

    await act(async () => root.render(noticeTree('en', services, false)));
    assert.equal(reads, 0);
    assert.equal(occurrences(container, copy.title), 0);

    await act(async () => root.render(noticeTree('en', services, true)));
    assert.equal(reads, 1);
    assert.equal(occurrences(container, copy.title), 1);
    assert.equal(occurrences(container, copy.description), 1);

    await act(async () => root.render(noticeTree('en', services, true)));
    assert.equal(reads, 1, 'an unrelated render does not read again');

    await clickButton(container, copy.copyDiagnostics);
    assert.equal(copies, 1);
  });

  test('shows nothing when the previous run shut down cleanly', async () => {
    const { root, container } = installReactRenderer();
    const services = createFakeDiagnosticsServices({
      takePreviousMainProcessInterruption: async () => false,
    });
    await act(async () => root.render(noticeTree('en', services, true)));
    assert.equal(
      occurrences(container, getDiagnosticsCopy('en').previousMainProcessInterruption.title),
      0,
    );
  });

  test('a locale change during the read shows one notice, in the current locale', async () => {
    const { root, container } = installReactRenderer();
    // Desktop answers every read in one renderer with the same promise.
    const read = deferred<boolean>();
    let reads = 0;
    const services = createFakeDiagnosticsServices({
      takePreviousMainProcessInterruption: () => {
        reads += 1;
        return read.promise;
      },
    });

    await act(async () => root.render(noticeTree('en', services, true)));
    await act(async () => root.render(noticeTree('zh-CN', services, true)));
    await act(async () => read.resolve(true));

    assert.equal(reads, 2);
    assert.equal(
      occurrences(container, getDiagnosticsCopy('en').previousMainProcessInterruption.title),
      0,
    );
    assert.equal(
      occurrences(container, getDiagnosticsCopy('zh-CN').previousMainProcessInterruption.title),
      1,
    );

    await act(async () => root.render(noticeTree('en', services, true)));
    assert.equal(reads, 3);
    assert.equal(
      occurrences(container, getDiagnosticsCopy('en').previousMainProcessInterruption.title),
      0,
      'a later read never shows the notice a second time',
    );
  });
});

describe('DiagnosticReportToastProvider', () => {
  const labels = {
    label: 'Copy report',
    failureTitle: 'Copy failed',
    failureDescription: 'Clipboard unavailable',
  };
  const target: ToastDiagnosticTarget = { sessionId: 'session-1', turnId: 'turn-1', eventId: 'event-1' };

  function ErrorProbe() {
    const toast = useToast();
    useEffect(() => {
      toast.error('Host failed', 'The Host stopped.', 'stack line', target);
    }, [toast]);
    return null;
  }

  test('offers the report on error toasts and copies it through the injected service', async () => {
    const { root, container } = installReactRenderer();
    answerToastLookups(container);
    const reports: ToastDiagnosticReport[] = [];
    const services = createFakeDiagnosticsServices({
      copyToastReport: async (report) => {
        reports.push(report);
      },
    });
    await act(async () => root.render(localized(
      'en',
      services,
      createElement(DiagnosticReportToastProvider, { labels, children: createElement(ErrorProbe) }),
    )));

    await clickButton(container, labels.label);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.title, 'Host failed');
    assert.equal(reports[0]?.description, 'The Host stopped.');
    assert.equal(reports[0]?.diagnosticDetails, 'stack line');
    assert.deepEqual(reports[0]?.diagnosticTarget, target);
  });

  test('reports a failed copy with the supplied labels', async () => {
    const { root, container } = installReactRenderer();
    const services = createFakeDiagnosticsServices({
      copyToastReport: async () => {
        throw new Error('denied');
      },
    });
    await act(async () => root.render(localized(
      'en',
      services,
      createElement(DiagnosticReportToastProvider, { labels, children: createElement(ErrorProbe) }),
    )));

    await clickButton(container, labels.label);
    assert.equal(occurrences(container, labels.failureTitle), 1);
    assert.equal(occurrences(container, labels.failureDescription), 1);
  });
});

describe('Desktop diagnostics adapter', () => {
  function recordingBridge() {
    const inputs: DesktopDiagnosticInput[] = [];
    const calls: string[] = [];
    const bridge = {
      diagnostics: {
        copyReport: async (input: DesktopDiagnosticInput) => {
          inputs.push(input);
        },
        takePreviousMainProcessInterruption: async () => {
          calls.push('take');
          return true;
        },
        copyPreviousMainProcessInterruption: async () => {
          calls.push('copy');
        },
      },
    } as DesktopDiagnosticsBridge;
    return { bridge, inputs, calls };
  }

  test('sends a toast report with only the fields the toast carried', async () => {
    const { bridge, inputs } = recordingBridge();
    const services = createDesktopDiagnosticsServices(bridge);
    const target: ToastDiagnosticTarget = { profileId: 'profile-1' };

    await services.copyToastReport({
      title: 'Host failed',
      description: 'The Host stopped.',
      diagnosticDetails: 'stack line',
      diagnosticTarget: target,
    });
    await services.copyToastReport({ title: 'Host failed', description: '', diagnosticDetails: '' });

    assert.deepEqual(inputs, [
      {
        surface: 'toast',
        title: 'Host failed',
        description: 'The Host stopped.',
        details: 'stack line',
        target,
      },
      { surface: 'toast', title: 'Host failed' },
    ]);
  });

  test('delegates the previous-run read and report', async () => {
    const { bridge, calls } = recordingBridge();
    const services = createDesktopDiagnosticsServices(bridge);
    assert.equal(await services.takePreviousMainProcessInterruption(), true);
    await services.copyPreviousMainProcessInterruption();
    assert.deepEqual(calls, ['take', 'copy']);
  });
});

describe('Diagnostics ownership', () => {
  const rendererRoot = resolve(fileURLToPath(new URL('../../../src/renderer/', import.meta.url)));

  function productionSources(root: string): string[] {
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === 'stories' ? [] : productionSources(path);
      return /\.tsx?$/.test(entry.name) && entry.name !== 'testing.ts' ? [path] : [];
    });
  }

  function sourcesMatching(pattern: RegExp): string[] {
    return productionSources(rendererRoot)
      .filter((path) => pattern.test(readFileSync(path, 'utf8')))
      .map((path) => relative(rendererRoot, path).replace(/\\/g, '/'))
      .sort();
  }

  test('mounts each owner once and reaches Desktop diagnostics through one adapter', () => {
    assert.deepEqual(sourcesMatching(/<(?:Diagnostics\.)?PreviousMainProcessInterruptionNotice\b/), ['app-shell.tsx']);
    assert.deepEqual(sourcesMatching(/<(?:Diagnostics\.)?DiagnosticReportToastProvider\b/), ['app-shell.tsx']);
    assert.deepEqual(sourcesMatching(/create-diagnostics-services/), ['composition/desktop-feature-services.tsx']);
    assert.deepEqual(
      sourcesMatching(/\.\s*(?:takePreviousMainProcessInterruption|copyPreviousMainProcessInterruption)\(/),
      ['features/diagnostics/ui/previous-main-process-interruption-notice.tsx', 'platform/desktop/create-diagnostics-services.ts'],
    );
    assert.doesNotMatch(readFileSync(join(rendererRoot, 'app-shell.tsx'), 'utf8'), /\bdiagnostics\s*\./);
  });
});
