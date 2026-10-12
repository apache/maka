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
import { ErrorBoundary } from '../../renderer/error-boundary.js';
import { getShellCopy } from '../../renderer/locales/shell-copy.js';
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
  type ManualDiagnosticTarget,
  type RendererCrashDiagnosticReport,
  type ToastDiagnosticReport,
} from '../../renderer/features/diagnostics/testing.js';
import { appShellCommandOptions, runPaletteCommand } from './app-shell-command-options.js';
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
  const shellCopy = getShellCopy('en');
  const labels = {
    label: shellCopy.errorBoundary.copyReport,
    failureTitle: shellCopy.commandActions.copyFailedTitle,
    failureDescription: shellCopy.commandActions.clipboardDenied,
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
      createElement(DiagnosticReportToastProvider, { children: createElement(ErrorProbe) }),
    )));

    await clickButton(container, labels.label);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.title, 'Host failed');
    assert.equal(reports[0]?.description, 'The Host stopped.');
    assert.equal(reports[0]?.diagnosticDetails, 'stack line');
    assert.deepEqual(reports[0]?.diagnosticTarget, target);
  });

  test('names the report action in the current locale', async () => {
    const { root, container } = installReactRenderer();
    const services = createFakeDiagnosticsServices();
    await act(async () => root.render(localized(
      'zh-CN',
      services,
      createElement(DiagnosticReportToastProvider, { children: createElement(ErrorProbe) }),
    )));

    const label = getShellCopy('zh-CN').errorBoundary.copyReport;
    assert.ok(elements(container, 'BUTTON').some((button) => button.textContent === label));
    assert.equal(occurrences(container, labels.label), 0);
  });

  test('reports a failed copy with the shell catalog\'s words', async () => {
    const { root, container } = installReactRenderer();
    const services = createFakeDiagnosticsServices({
      copyToastReport: async () => {
        throw new Error('denied');
      },
    });
    await act(async () => root.render(localized(
      'en',
      services,
      createElement(DiagnosticReportToastProvider, { children: createElement(ErrorProbe) }),
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

  test('sends a manual report with the target only when the caller had one', async () => {
    const { bridge, inputs } = recordingBridge();
    const services = createDesktopDiagnosticsServices(bridge);

    await services.copyManualReport();
    await services.copyManualReport({ sessionId: 'session-1' });
    await services.copyManualReport({ profileId: 'profile-1' });

    assert.deepEqual(inputs, [
      { surface: 'manual' },
      { surface: 'manual', target: { sessionId: 'session-1' } },
      { surface: 'manual', target: { profileId: 'profile-1' } },
    ]);
  });

  test('sends a renderer crash report with its title and details', async () => {
    const { bridge, inputs } = recordingBridge();
    const services = createDesktopDiagnosticsServices(bridge);

    await services.copyRendererCrashReport({ title: 'TypeError: boom', details: 'TypeError: boom\n\nStack:\nframe' });

    assert.deepEqual(inputs, [
      { surface: 'renderer_crash', title: 'TypeError: boom', details: 'TypeError: boom\n\nStack:\nframe' },
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

describe('ErrorBoundary crash report', () => {
  function Crash(): ReactNode {
    const error = new TypeError('boom');
    error.stack = 'TypeError: boom\n    at Crash';
    throw error;
  }

  const boundary = createElement(ErrorBoundary, { locale: 'en', children: createElement(Crash) });
  const copy = getShellCopy('en').errorBoundary;

  function hasButton(root: TreeNode, label: string): boolean {
    return elements(root, 'BUTTON').some((button) => button.textContent === label);
  }

  test('copies the crash through the diagnostics feature', async (t) => {
    t.mock.method(console, 'error', () => {});
    const { root, container } = installReactRenderer();
    const reports: RendererCrashDiagnosticReport[] = [];
    const services = createFakeDiagnosticsServices({
      copyRendererCrashReport: async (report) => {
        reports.push(report);
      },
    });
    await act(async () => root.render(localized('en', services, boundary)));
    assert.equal(occurrences(container, copy.title), 1);

    await clickButton(container, copy.copyReport);
    await act(async () => {});

    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.title, 'TypeError: boom');
    assert.match(reports[0]?.details ?? '', /^TypeError: boom\n\nStack:\nTypeError: boom\n {4}at Crash/);
    assert.ok(hasButton(container, copy.copied));
  });

  test('shows the failure when the diagnostics feature cannot copy', async (t) => {
    t.mock.method(console, 'error', () => {});
    const { root, container } = installReactRenderer();
    let attempts = 0;
    const services = createFakeDiagnosticsServices({
      copyRendererCrashReport: async () => {
        attempts += 1;
        throw new Error('denied');
      },
    });
    await act(async () => root.render(localized('en', services, boundary)));

    await clickButton(container, copy.copyReport);
    await act(async () => {});

    assert.equal(attempts, 1);
    assert.ok(hasButton(container, copy.copyFailed));
    assert.equal(occurrences(container, copy.clipboardFailure), 1);
  });

  test('without Desktop composition, still renders the fallback and copies the browser report', async (t) => {
    t.mock.method(console, 'error', () => {});
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          writes.push(text);
        },
      },
    });
    restoreAfterEach.push(() => {
      Reflect.deleteProperty(navigator, 'clipboard');
    });
    const { root, container } = installReactRenderer();
    await act(async () => root.render(createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(AstryxLocaleProvider, { children: boundary }),
    })));
    assert.equal(occurrences(container, copy.title), 1);

    await clickButton(container, copy.copyReport);
    await act(async () => {});

    assert.equal(writes.length, 1);
    assert.match(writes[0] ?? '', /^Maka renderer error report\n/);
    assert.match(writes[0] ?? '', /TypeError: boom/);
    assert.ok(hasButton(container, copy.copied));
  });
});

describe('Command palette manual report', () => {
  const copy = getShellCopy('en').commandActions;

  test('copies through the injected command with the current target, then confirms', async () => {
    const targets: Array<ManualDiagnosticTarget | undefined> = [];
    const toasts: string[] = [];
    await runPaletteCommand(appShellCommandOptions(toasts, {
      copyManualDiagnosticReport: async (target) => {
        targets.push(target);
      },
    }), 'diag:copy-diagnostics');

    assert.deepEqual(targets, [{ sessionId: 'session-1' }]);
    assert.deepEqual(toasts, [`success:${copy.diagnosticsCopiedTitle}`]);
  });

  test('reports a failed copy against the same target', async (t) => {
    t.mock.method(console, 'error', () => {});
    const toasts: string[] = [];
    let attempts = 0;
    await runPaletteCommand(appShellCommandOptions(toasts, {
      copyManualDiagnosticReport: async () => {
        attempts += 1;
        throw new Error('denied');
      },
    }), 'diag:copy-diagnostics');

    assert.equal(attempts, 1);
    assert.deepEqual(toasts, [
      `error:${copy.copyFailedTitle}:${copy.clipboardDenied}:${JSON.stringify({ sessionId: 'session-1' })}`,
    ]);
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
    assert.deepEqual(
      sourcesMatching(/<(?:Diagnostics\.)?ManualDiagnosticReportConsumer\b/),
      ['app-shell.tsx', 'settings/about-settings-page.tsx'],
    );
    assert.deepEqual(sourcesMatching(/<(?:Diagnostics\.)?RendererCrashReportConsumer\b/), ['error-boundary.tsx']);
    assert.deepEqual(sourcesMatching(/create-diagnostics-services/), ['composition/desktop-feature-services.tsx']);
    assert.deepEqual(sourcesMatching(/\.\s*copyReport\(/), ['platform/desktop/create-diagnostics-services.ts']);
    assert.deepEqual(sourcesMatching(/\bmaka\s*\??\.\s*diagnostics\b/), []);
    assert.deepEqual(
      sourcesMatching(/\.\s*(?:takePreviousMainProcessInterruption|copyPreviousMainProcessInterruption)\(/),
      ['features/diagnostics/ui/previous-main-process-interruption-notice.tsx', 'platform/desktop/create-diagnostics-services.ts'],
    );
    assert.doesNotMatch(readFileSync(join(rendererRoot, 'app-shell.tsx'), 'utf8'), /\bdiagnostics\s*\./);
  });
});
