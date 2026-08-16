import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import type { IPage } from '@jackwener/opencli/types';
import {
  BROWSER_WORKFLOW_MAX_ACTIONS,
  type BrowserWorkflow,
  type BrowserWorkflowProgress,
} from '@maka/core/browser-workflow';
import type { BrowserWorkflowStore } from '@maka/storage';
import { createBrowserWorkflowService } from '../browser/browser-workflow-service.js';
import {
  type BrowserRecorderEvent,
  createBrowserWorkflowRecorderInstallScript,
  flushBrowserWorkflowNavigation,
  notifyBrowserWorkflowNavigation,
  notifyBrowserWorkflowRecorderEvent,
  normalizeBrowserRecorderEvent,
  parseBrowserWorkflowRecorderConsoleMessage,
  setBrowserWorkflowNavigationRecorder,
  WORKFLOW_RECORDER_EVENT_PREFIX,
} from '../browser/workflow-recorder.js';
import { runBrowserWorkflowAction } from '../browser/workflow-runner.js';
import { getBrowserCopy } from '../../renderer/locales/browser-copy.js';
import { getBrowserWorkflowCopy } from '../../renderer/locales/browser-workflow-copy.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

class MemoryWorkflowStore implements BrowserWorkflowStore {
  readonly workflows = new Map<string, BrowserWorkflow>();

  async loadAll(): Promise<BrowserWorkflow[]> {
    return [...this.workflows.values()];
  }

  async get(id: string): Promise<BrowserWorkflow | undefined> {
    return this.workflows.get(id);
  }

  async save(workflow: BrowserWorkflow): Promise<void> {
    this.workflows.set(workflow.id, workflow);
  }

  async remove(id: string): Promise<void> {
    this.workflows.delete(id);
  }
}

afterEach(() => {
  setBrowserWorkflowNavigationRecorder(null);
});

describe('browser workflow recorder', () => {
  test('provides locale-specific default workflow names', () => {
    assert.equal(getBrowserCopy('zh').defaultWorkflowName, '操作流程');
    assert.equal(getBrowserCopy('en').defaultWorkflowName, 'Browser workflow');
  });

  test('describes URL-free navigation waits in workflow previews', () => {
    const copy = getBrowserWorkflowCopy('en') as unknown as Record<string, unknown>;
    assert.equal(copy.waitNavigationAction, 'Wait for page navigation');
  });

  test('rejects a page-forged recorder message without the active credential', () => {
    const forged = `${WORKFLOW_RECORDER_EVENT_PREFIX}${JSON.stringify({
      kind: 'type',
      locator: { kind: 'name', value: 'password' },
      value: 'must-not-persist',
      sensitive: false,
      timestamp: 1,
    })}`;

    assert.equal(
      (parseBrowserWorkflowRecorderConsoleMessage as (message: string, credential: string) => unknown | null)(
        forged,
        'active-recorder-credential',
      ),
      null,
    );
  });

  test('accepts a recorder message carrying the active credential', () => {
    const event = {
      kind: 'click',
      locator: { kind: 'test_id', value: 'submit' },
      timestamp: 1,
    };

    assert.deepEqual(
      parseBrowserWorkflowRecorderConsoleMessage(
        `${WORKFLOW_RECORDER_EVENT_PREFIX}active-recorder-credential:${JSON.stringify(event)}`,
        'active-recorder-credential',
      ),
      event,
    );
  });

  test('rejects recorder events with an unsupported locator kind', () => {
    assert.equal(
      normalizeBrowserRecorderEvent({
        kind: 'click',
        locator: { kind: 'css', value: '#submit' },
        timestamp: 1,
      }),
      null,
    );
  });

  test('rejects a checked-state event without an explicit boolean state', () => {
    assert.equal(
      normalizeBrowserRecorderEvent({
        kind: 'check',
        locator: { kind: 'test_id', value: 'billing-yearly' },
        checked: 'true',
        timestamp: 1,
      }),
      null,
    );
  });

  test('rejects temporary snapshot references', () => {
    assert.equal(
      normalizeBrowserRecorderEvent({
        kind: 'click',
        locator: { kind: 'text', value: ' [42] ' },
        timestamp: 1,
      }),
      null,
    );
  });

  test('drops a sensitive input value at the main-process boundary', () => {
    assert.deepEqual(
      normalizeBrowserRecorderEvent({
        kind: 'type',
        locator: { kind: 'name', value: 'password' },
        value: 'must-not-persist',
        sensitive: true,
        timestamp: 1,
      }),
      {
        kind: 'type',
        locator: { kind: 'name', value: 'password' },
        sensitive: true,
        submit: false,
        timestamp: 1,
      },
    );
  });

  test('marks a single-line form input as submitted when Enter triggers submission', () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const input = {
      tagName: 'INPUT',
      type: 'text',
      value: 'Alice',
      id: '',
      form: {},
      closest: () => input,
      getAttribute: (name: string) => (name === 'data-testid' ? 'name' : null),
    };
    const document = {
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) =>
        listeners.set(type, listener),
      removeEventListener: () => {},
      querySelectorAll: (selector: string) => (selector === '[data-testid]' ? [input] : []),
    };
    const window = {} as Record<string, unknown>;
    new Function('window', 'document', `return ${createBrowserWorkflowRecorderInstallScript('test-credential')};`)(
      window,
      document,
    );

    listeners.get('input')?.({ target: input });
    listeners.get('keydown')?.({
      target: input,
      key: 'Enter',
      isComposing: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    });

    const recorder = window.__makaBrowserWorkflowRecorderV1 as { drain(): BrowserRecorderEvent[] };
    assert.equal(recorder.drain().at(-1)?.submit, true);
  });

  test('records a keyboard-selected radio as a checked-state action', () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const radio = {
      tagName: 'INPUT',
      type: 'radio',
      checked: true,
      value: 'yearly',
      id: '',
      closest: () => radio,
      getAttribute: (name: string) => (name === 'data-testid' ? 'billing-yearly' : null),
    };
    const document = {
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) =>
        listeners.set(type, listener),
      removeEventListener: () => {},
      querySelectorAll: (selector: string) => (selector === '[data-testid]' ? [radio] : []),
    };
    const window = {} as Record<string, unknown>;
    new Function('window', 'document', `return ${createBrowserWorkflowRecorderInstallScript('test-credential')};`)(
      window,
      document,
    );

    listeners.get('input')?.({ target: radio });

    const recorder = window.__makaBrowserWorkflowRecorderV1 as { drain(): Array<Record<string, unknown>> };
    const { eventId, timestamp, ...event } = recorder.drain().at(-1) ?? {};
    assert.equal(typeof eventId, 'string');
    assert.equal(typeof timestamp, 'number');
    assert.deepEqual(event, {
      kind: 'check',
      locator: { kind: 'test_id', value: 'billing-yearly' },
      checked: true,
    });
  });

  test('records one checked-state action for a pointer-selected checkbox', () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const checkbox = {
      tagName: 'INPUT',
      type: 'checkbox',
      checked: true,
      value: 'on',
      id: '',
      closest: () => checkbox,
      getAttribute: (name: string) => (name === 'data-testid' ? 'remember-me' : null),
    };
    const document = {
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) =>
        listeners.set(type, listener),
      removeEventListener: () => {},
      querySelectorAll: (selector: string) => (selector === '[data-testid]' ? [checkbox] : []),
    };
    const window = {} as Record<string, unknown>;
    new Function('window', 'document', `return ${createBrowserWorkflowRecorderInstallScript('test-credential')};`)(
      window,
      document,
    );

    listeners.get('click')?.({ target: checkbox });
    listeners.get('input')?.({ target: checkbox });

    const recorder = window.__makaBrowserWorkflowRecorderV1 as { drain(): Array<Record<string, unknown>> };
    const events = recorder.drain();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, 'check');
    assert.equal(events[0]?.checked, true);
  });

  test('records one checked-state action when a checkbox label is clicked', () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const checkbox = {
      tagName: 'INPUT',
      type: 'checkbox',
      checked: true,
      value: 'on',
      id: 'remember-me',
      closest: () => checkbox,
      getAttribute: (name: string) => (name === 'data-testid' ? 'remember-me' : null),
    };
    const label = {
      tagName: 'LABEL',
      closest: () => label,
      getAttribute: (name: string) => (name === 'for' ? checkbox.id : null),
      querySelector: () => null,
    };
    const document = {
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) =>
        listeners.set(type, listener),
      removeEventListener: () => {},
      getElementById: (id: string) => (id === checkbox.id ? checkbox : null),
      querySelectorAll: (selector: string) => (selector === '[data-testid]' ? [checkbox] : []),
    };
    const window = {} as Record<string, unknown>;
    new Function('window', 'document', `return ${createBrowserWorkflowRecorderInstallScript('test-credential')};`)(
      window,
      document,
    );

    listeners.get('click')?.({ target: label });
    listeners.get('input')?.({ target: checkbox });

    const recorder = window.__makaBrowserWorkflowRecorderV1 as { drain(): Array<Record<string, unknown>> };
    const events = recorder.drain();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, 'check');
    assert.equal(events[0]?.checked, true);
  });

  test('redacts standard payment autocomplete fields inside the page recorder', () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const input = {
      tagName: 'INPUT',
      type: 'text',
      value: '4111111111111111',
      id: '',
      closest: () => input,
      getAttribute: (name: string) => {
        if (name === 'data-testid') return 'card-number';
        if (name === 'autocomplete') return 'cc-number';
        return null;
      },
    };
    const document = {
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) =>
        listeners.set(type, listener),
      removeEventListener: () => {},
      querySelectorAll: (selector: string) => (selector === '[data-testid]' ? [input] : []),
    };
    const window = {} as Record<string, unknown>;
    new Function('window', 'document', `return ${createBrowserWorkflowRecorderInstallScript('test-credential')};`)(
      window,
      document,
    );

    listeners.get('input')?.({ target: input });

    const recorder = window.__makaBrowserWorkflowRecorderV1 as { drain(): BrowserRecorderEvent[] };
    const event = recorder.drain().at(-1);
    assert.equal(event?.sensitive, true);
    assert.equal(event?.value, undefined);
  });

  test('redacts sensitive values identified by placeholder, test id, or associated label', () => {
    const cases = [
      { placeholder: 'Enter your API key' },
      { testId: 'auth-token-input' },
      { labelText: 'Client secret' },
    ];

    for (const metadata of cases) {
      const listeners = new Map<string, (event: Record<string, unknown>) => void>();
      const input = {
        tagName: 'INPUT',
        type: 'text',
        value: 'must-not-persist',
        id: '',
        labels: metadata.labelText
          ? [{ innerText: metadata.labelText, textContent: metadata.labelText }]
          : [],
        closest: () => input,
        getAttribute: (name: string) => {
          if (name === 'data-testid') return metadata.testId ?? null;
          if (name === 'placeholder') return metadata.placeholder ?? null;
          if (name === 'name') return 'value';
          return null;
        },
      };
      const document = {
        addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) =>
          listeners.set(type, listener),
        removeEventListener: () => {},
        querySelectorAll: (selector: string) =>
          selector === '[name]' || (selector === '[data-testid]' && metadata.testId) ? [input] : [],
      };
      const window = {} as Record<string, unknown>;
      new Function(
        'window',
        'document',
        `return ${createBrowserWorkflowRecorderInstallScript('test-credential')};`,
      )(window, document);

      listeners.get('input')?.({ target: input });

      const recorder = window.__makaBrowserWorkflowRecorderV1 as { drain(): BrowserRecorderEvent[] };
      const event = recorder.drain().at(-1);
      assert.equal(event?.sensitive, true, JSON.stringify(metadata));
      assert.equal(event?.value, undefined, JSON.stringify(metadata));
    }
  });

  test('does not use a sensitive value as fallback locator evidence', () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const input = {
      tagName: 'INPUT',
      type: 'password',
      value: 'fallback-secret',
      id: '',
      innerText: '',
      closest: () => input,
      getAttribute: () => null,
    };
    const document = {
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) =>
        listeners.set(type, listener),
      removeEventListener: () => {},
      querySelectorAll: (selector: string) => (selector === 'input' ? [input] : []),
    };
    const window = {} as Record<string, unknown>;
    new Function('window', 'document', `return ${createBrowserWorkflowRecorderInstallScript('test-credential')};`)(
      window,
      document,
    );

    listeners.get('input')?.({ target: input });

    const recorder = window.__makaBrowserWorkflowRecorderV1 as { drain(): BrowserRecorderEvent[] };
    assert.deepEqual(recorder.drain(), []);
    assert.doesNotMatch(JSON.stringify(recorder), /fallback-secret/);
  });

  test('does not use a mutable text input value as fallback locator evidence', () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const input = {
      tagName: 'INPUT',
      type: 'text',
      value: 'Alice',
      id: '',
      innerText: '',
      closest: () => input,
      getAttribute: () => null,
    };
    const document = {
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) =>
        listeners.set(type, listener),
      removeEventListener: () => {},
      querySelectorAll: (selector: string) => (selector === 'input' ? [input] : []),
    };
    const window = {} as Record<string, unknown>;
    new Function('window', 'document', `return ${createBrowserWorkflowRecorderInstallScript('test-credential')};`)(
      window,
      document,
    );

    listeners.get('input')?.({ target: input });

    const recorder = window.__makaBrowserWorkflowRecorderV1 as { drain(): BrowserRecorderEvent[] };
    assert.deepEqual(recorder.drain(), []);
  });

  test('does not record file input interactions', () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const input = {
      tagName: 'INPUT',
      type: 'file',
      value: 'C:\\fakepath\\document.pdf',
      id: 'attachment',
      closest: () => input,
      getAttribute: (name: string) => (name === 'data-testid' ? 'attachment' : null),
    };
    const document = {
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) =>
        listeners.set(type, listener),
      removeEventListener: () => {},
      querySelectorAll: (selector: string) => (selector === '[data-testid]' ? [input] : []),
    };
    const window = {} as Record<string, unknown>;
    new Function('window', 'document', `return ${createBrowserWorkflowRecorderInstallScript('test-credential')};`)(
      window,
      document,
    );

    listeners.get('click')?.({ target: input });
    listeners.get('input')?.({ target: input });

    const recorder = window.__makaBrowserWorkflowRecorderV1 as { drain(): BrowserRecorderEvent[] };
    assert.deepEqual(recorder.drain(), []);
  });

  test('records contenteditable text from its visible content', () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const editor = {
      tagName: 'DIV',
      innerText: 'Draft body',
      textContent: 'Draft body',
      id: '',
      closest: () => editor,
      getAttribute: (name: string) => {
        if (name === 'data-testid') return 'editor';
        if (name === 'role') return 'textbox';
        if (name === 'contenteditable') return 'true';
        return null;
      },
    };
    const document = {
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) =>
        listeners.set(type, listener),
      removeEventListener: () => {},
      querySelectorAll: (selector: string) => (selector === '[data-testid]' ? [editor] : []),
    };
    const window = {} as Record<string, unknown>;
    new Function('window', 'document', `return ${createBrowserWorkflowRecorderInstallScript('test-credential')};`)(
      window,
      document,
    );

    listeners.get('input')?.({ target: editor });

    const recorder = window.__makaBrowserWorkflowRecorderV1 as { drain(): BrowserRecorderEvent[] };
    assert.equal(recorder.drain().at(-1)?.value, 'Draft body');
  });

  test('records text-labeled button clicks without stable attributes', () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const button = {
      tagName: 'BUTTON',
      innerText: 'Submit',
      textContent: 'Submit',
      id: '',
      closest: () => button,
      getAttribute: () => null,
    };
    const document = {
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) =>
        listeners.set(type, listener),
      removeEventListener: () => {},
      querySelectorAll: (selector: string) => (selector === 'button' ? [button] : []),
    };
    const window = {} as Record<string, unknown>;
    new Function('window', 'document', `return ${createBrowserWorkflowRecorderInstallScript('test-credential')};`)(
      window,
      document,
    );

    listeners.get('click')?.({ target: button });

    const recorder = window.__makaBrowserWorkflowRecorderV1 as { drain(): BrowserRecorderEvent[] };
    assert.deepEqual(recorder.drain().at(-1)?.locator, {
      kind: 'role',
      value: 'Submit',
      tag: 'button',
      role: 'button',
    });
  });

  test('preserves values from custom textbox elements', () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const control = {
      tagName: 'MY-INPUT',
      value: 'Alice',
      innerText: '',
      textContent: '',
      id: '',
      closest: () => control,
      getAttribute: (name: string) => {
        if (name === 'data-testid') return 'custom-name';
        if (name === 'role') return 'textbox';
        return null;
      },
    };
    const document = {
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) =>
        listeners.set(type, listener),
      removeEventListener: () => {},
      querySelectorAll: (selector: string) => (selector === '[data-testid]' ? [control] : []),
    };
    const window = {} as Record<string, unknown>;
    new Function('window', 'document', `return ${createBrowserWorkflowRecorderInstallScript('test-credential')};`)(
      window,
      document,
    );

    listeners.get('input')?.({ target: control });

    const recorder = window.__makaBrowserWorkflowRecorderV1 as { drain(): BrowserRecorderEvent[] };
    assert.equal(recorder.drain().at(-1)?.value, 'Alice');
  });
});

describe('browser workflow runner', () => {
  test('converts persisted millisecond wait timeouts to the IPage seconds contract', async () => {
    const waits: unknown[] = [];
    const page = {
      wait: async (options: unknown) => {
        waits.push(options);
      },
    } as unknown as IPage;

    await runBrowserWorkflowAction(
      page,
      { id: 'wait-selector', kind: 'wait', selector: '#ready', timeoutMs: 15_000 },
      {},
    );
    await runBrowserWorkflowAction(
      page,
      { id: 'wait-text', kind: 'wait', text: 'Ready', timeoutMs: 30_000 },
      {},
    );

    assert.deepEqual(waits, [
      { selector: '#ready', timeout: 15 },
      { text: 'Ready', timeout: 30 },
    ]);
  });

  test('waits for an interaction-driven URL without navigating again', async () => {
    let currentUrl = 'https://example.test/form';
    let reads = 0;
    const page = {
      goto: async () => assert.fail('URL waits must not issue a second navigation'),
      getCurrentUrl: async () => 'https://example.test/form',
      evaluate: async () => {
        reads += 1;
        return currentUrl;
      },
      wait: async () => {
        currentUrl = 'https://example.test/submitted';
      },
    } as unknown as IPage;

    await runBrowserWorkflowAction(
      page,
      {
        id: 'wait-navigation',
        kind: 'wait',
        url: 'https://example.test/submitted',
        timeoutMs: 1_000,
      },
      {},
    );

    assert.equal(reads, 2);
  });

  test('waits for a dynamic interaction navigation to leave the pre-action URL', async () => {
    let currentUrl = 'https://example.test/form';
    let markerPresent = false;
    const navigationStarted = deferred<void>();
    const navigationRelease = deferred<void>();
    const page = {
      evaluate: async (script: string) => {
        if (script === 'window.location.href') return currentUrl;
        if (script.includes('__makaBrowserWorkflowNavigationMarkerV1') && script.includes('markerPresent')) {
          return { url: currentUrl, markerPresent };
        }
        if (script.includes('__makaBrowserWorkflowNavigationMarkerV1')) {
          markerPresent = true;
          return currentUrl;
        }
        return { ok: true, matched: 1 };
      },
      click: async () => {},
      wait: async () => {
        navigationStarted.resolve();
        await navigationRelease.promise;
      },
    } as unknown as IPage;
    const context = {};

    await runBrowserWorkflowAction(
      page,
      { id: 'click-submit', kind: 'click', locator: { kind: 'test_id', value: 'submit' } },
      {},
      context,
    );
    let settled = false;
    const waiting = runBrowserWorkflowAction(
      page,
      { id: 'wait-navigation', kind: 'wait', navigation: true, timeoutMs: 1_000 },
      {},
      context,
    ).then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    assert.equal(settled, false);
    await navigationStarted.promise;
    currentUrl = 'https://example.test/orders/67890?state=other';
    navigationRelease.resolve();
    await waiting;
  });

  test('waits for a dynamic full-document navigation that retains the same URL', async () => {
    const currentUrl = 'https://example.test/orders/12345?state=nonce';
    let documentGeneration = 1;
    let markerGeneration: number | null = null;
    const page = {
      evaluate: async (script: string) => {
        if (script === 'window.location.href') return currentUrl;
        if (script.includes('__makaBrowserWorkflowNavigationMarkerV1') && script.includes('markerPresent')) {
          return { url: currentUrl, markerPresent: markerGeneration === documentGeneration };
        }
        if (script.includes('__makaBrowserWorkflowNavigationMarkerV1')) {
          markerGeneration = documentGeneration;
          return currentUrl;
        }
        return { ok: true, matched: 1 };
      },
      click: async () => {
        documentGeneration += 1;
      },
      wait: async () => {},
    } as unknown as IPage;
    const context = {};

    await runBrowserWorkflowAction(
      page,
      { id: 'click-submit', kind: 'click', locator: { kind: 'test_id', value: 'submit' } },
      {},
      context,
    );

    await runBrowserWorkflowAction(
      page,
      { id: 'wait-navigation', kind: 'wait', navigation: true, timeoutMs: 10 },
      {},
      context,
    );
  });

  test('observes a same-URL history navigation without waiting for a document replacement', async () => {
    const currentUrl = 'https://example.test/orders/12345';
    const browserGlobal: Record<string, unknown> = {};
    const history = {
      pushState: () => {},
      replaceState: () => {},
    };
    const evaluateNavigationScript = (script: string): unknown =>
      new Function(
        'globalThis',
        'location',
        'history',
        'addEventListener',
        `return ${script};`,
      )(browserGlobal, { href: currentUrl }, history, () => {});
    const page = {
      evaluate: async (script: string) => {
        if (script.includes('const locator =')) return { ok: true, matched: 1 };
        if (script.includes('__makaBrowserWorkflowNavigationMarkerV1')) {
          return evaluateNavigationScript(script);
        }
        return undefined;
      },
      click: async () => {
        history.pushState();
      },
      wait: async () => {},
    } as unknown as IPage;
    const context = {};

    await runBrowserWorkflowAction(
      page,
      { id: 'click-same-url', kind: 'click', locator: { kind: 'test_id', value: 'same-url' } },
      {},
      context,
    );

    await runBrowserWorkflowAction(
      page,
      { id: 'wait-same-url', kind: 'wait', url: currentUrl, timeoutMs: 10 },
      {},
      context,
    );
  });

  test('treats an unavailable current URL as unknown when the page API returns null', async () => {
    const page = {
      evaluate: async () => {
        throw new Error('page is closing');
      },
      getCurrentUrl: async () => null,
      wait: async () => {},
    } as unknown as IPage;

    await assert.rejects(
      runBrowserWorkflowAction(
        page,
        { id: 'wait-navigation', kind: 'wait', url: 'https://example.test/submitted', timeoutMs: 1 },
        {},
      ),
      /current URL is unknown/,
    );
  });

  test('fails deterministically when a stable locator no longer matches', async () => {
    const page = {
      evaluate: async () => ({ ok: false, reason: 'not_found', matched: 0 }),
    } as unknown as IPage;

    await assert.rejects(
      runBrowserWorkflowAction(
        page,
        { id: 'click-submit', kind: 'click', locator: { kind: 'test_id', value: 'submit' } },
        {},
      ),
      /did not match an element.*Re-record this workflow/,
    );
  });

  test('replays clicks through the page native-input path', async () => {
    const evaluated: string[] = [];
    let clickedSelector = '';
    const page = {
      evaluate: async (script: string) => {
        evaluated.push(script);
        return { ok: true, matched: 1 };
      },
      click: async (selector: string) => {
        clickedSelector = selector;
        return { matches_n: 1, match_level: 'exact' as const };
      },
    } as unknown as IPage;

    await runBrowserWorkflowAction(
      page,
      { id: 'click-submit', kind: 'click', locator: { kind: 'test_id', value: 'submit' } },
      {},
    );

    assert.match(clickedSelector, /^\[data-maka-browser-workflow-target="[^"]+"\]$/);
    assert.equal(evaluated.some((script) => script.includes('element.click()')), false);
  });

  test('replays a checked-state action through the page native-input path', async () => {
    const attributes = new Map<string, string>();
    const radio = {
      tagName: 'INPUT',
      type: 'radio',
      checked: false,
      value: 'yearly',
      isContentEditable: false,
      getAttribute: (name: string) => (name === 'data-testid' ? 'billing-yearly' : attributes.get(name) ?? null),
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
    };
    const document = {
      querySelectorAll: (selector: string) => {
        if (selector === '[data-testid]') return [radio];
        if (selector.startsWith('[')) return attributes.size > 0 ? [radio] : [];
        return [];
      },
      getElementById: () => null,
    };
    let clicks = 0;
    const page = {
      evaluate: async (script: string) => new Function('document', `return ${script};`)(document),
      click: async () => {
        clicks += 1;
        radio.checked = true;
        return { matches_n: 1, match_level: 'exact' as const };
      },
    } as unknown as IPage;

    await runBrowserWorkflowAction(
      page,
      {
        id: 'check-yearly',
        kind: 'check',
        locator: { kind: 'test_id', value: 'billing-yearly' },
        checked: true,
      },
      {},
    );

    assert.equal(clicks, 1);
    assert.equal(radio.checked, true);
    assert.equal(attributes.size, 0);

    await runBrowserWorkflowAction(
      page,
      {
        id: 'check-yearly-again',
        kind: 'check',
        locator: { kind: 'test_id', value: 'billing-yearly' },
        checked: true,
      },
      {},
    );
    assert.equal(clicks, 1, 'replay must not toggle a control that is already in the recorded state');
  });

  test('rejects a checked-state action when the native click does not apply the recorded state', async () => {
    const attributes = new Map<string, string>();
    const checkbox = {
      tagName: 'INPUT',
      type: 'checkbox',
      checked: false,
      value: 'enabled',
      isContentEditable: false,
      getAttribute: (name: string) => (name === 'data-testid' ? 'feature-enabled' : attributes.get(name) ?? null),
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
    };
    const document = {
      querySelectorAll: (selector: string) => {
        if (selector === '[data-testid]') return [checkbox];
        if (selector.startsWith('[')) return attributes.size > 0 ? [checkbox] : [];
        return [];
      },
      getElementById: () => null,
    };
    const page = {
      evaluate: async (script: string) => new Function('document', `return ${script};`)(document),
      click: async () => ({ matches_n: 1, match_level: 'exact' as const }),
    } as unknown as IPage;

    await assert.rejects(
      runBrowserWorkflowAction(
        page,
        {
          id: 'check-feature-enabled',
          kind: 'check',
          locator: { kind: 'test_id', value: 'feature-enabled' },
          checked: true,
        },
        {},
      ),
      /did not reach the recorded checked state/,
    );
    assert.equal(attributes.size, 0);
  });

  test('replays a text-labeled button locator', async () => {
    const attributes = new Map<string, string>();
    const button = {
      tagName: 'BUTTON',
      innerText: 'Submit',
      textContent: 'Submit',
      value: '',
      isContentEditable: false,
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
      click: () => assert.fail('replay should use the native page click path'),
    };
    const document = {
      querySelectorAll: (selector: string) => {
        if (selector === 'button') return [button];
        if (selector.startsWith('[')) return attributes.size > 0 ? [button] : [];
        return [];
      },
      getElementById: () => null,
    };
    let clickedSelector = '';
    const page = {
      evaluate: async (script: string) => new Function('document', `return ${script};`)(document),
      click: async (selector: string) => {
        clickedSelector = selector;
        assert.equal(attributes.size, 1);
      },
    } as unknown as IPage;

    await runBrowserWorkflowAction(
      page,
      {
        id: 'click-submit',
        kind: 'click',
        locator: { kind: 'role', value: 'Submit', tag: 'button', role: 'button' },
      },
      {},
    );

    assert.match(clickedSelector, /^\[data-maka-browser-workflow-target="[^"]+"\]$/);
    assert.equal(attributes.size, 0);
  });

  test('requires a sensitive value only at replay time', async () => {
    let evaluated = false;
    const page = {
      evaluate: async () => {
        evaluated = true;
        return { ok: true, matched: 1 };
      },
    } as unknown as IPage;

    await assert.rejects(
      runBrowserWorkflowAction(
        page,
        {
          id: 'type-password',
          kind: 'type',
          locator: { kind: 'name', value: 'password' },
          sensitive: true,
          submit: false,
        },
        {},
      ),
      /Sensitive value required for workflow action type-password/,
    );
    assert.equal(evaluated, false);
  });

  test('types into a textarea through its native value setter', async () => {
    class FakeInput {
      set value(_next: string) {
        if (!(this instanceof FakeInput)) throw new TypeError('Illegal invocation');
      }
    }
    class FakeTextarea {
      value = '';
      getAttribute(name: string) {
        return name === 'name' ? 'notes' : null;
      }
      focus() {}
      dispatchEvent() {}
    }
    class FakeEvent {}
    const textarea = new FakeTextarea();
    const document = {
      querySelectorAll: (selector: string) => (selector === '[name]' ? [textarea] : []),
      getElementById: () => null,
    };
    const page = {
      evaluate: async (script: string) =>
        new Function('document', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event', `return ${script};`)(
          document,
          FakeInput,
          FakeTextarea,
          FakeEvent,
        ),
    } as unknown as IPage;

    await runBrowserWorkflowAction(
      page,
      {
        id: 'type-notes',
        kind: 'type',
        locator: { kind: 'name', value: 'notes' },
        value: 'remember this',
        sensitive: false,
        submit: false,
      },
      {},
    );
    assert.equal(textarea.value, 'remember this');
  });

  test('replays locators for native inputs with implicit textbox roles', async () => {
    class FakeInput {
      tagName = 'INPUT';
      type = 'text';
      value = 'before';
      innerText = '';
      focus() {}
      dispatchEvent() {}
      getAttribute() {
        return null;
      }
    }
    class FakeEvent {}
    const input = new FakeInput();
    const document = {
      querySelectorAll: (selector: string) => (selector === 'input' ? [input] : []),
      getElementById: () => null,
    };
    const page = {
      evaluate: async (script: string) =>
        new Function('document', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event', `return ${script};`)(
          document,
          FakeInput,
          class FakeTextarea {},
          FakeEvent,
        ),
    } as unknown as IPage;

    await runBrowserWorkflowAction(
      page,
      {
        id: 'type-native-input',
        kind: 'type',
        locator: { kind: 'role', value: 'before', tag: 'input', role: 'textbox' },
        value: 'after',
        sensitive: false,
        submit: false,
      },
      {},
    );
    assert.equal(input.value, 'after');
  });

  test('replays value-backed custom textboxes', async () => {
    class FakeCustomTextbox {
      tagName = 'MY-INPUT';
      value = 'before';
      innerText = '';
      textContent = '';
      focus() {}
      dispatchEvent() {}
      getAttribute(name: string) {
        return name === 'role' ? 'textbox' : null;
      }
    }
    class FakeEvent {}
    const control = new FakeCustomTextbox();
    const document = {
      querySelectorAll: (selector: string) => (selector === 'my-input' ? [control] : []),
      getElementById: () => null,
    };
    const page = {
      evaluate: async (script: string) =>
        new Function('document', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event', `return ${script};`)(
          document,
          class FakeInput {},
          class FakeTextarea {},
          FakeEvent,
        ),
    } as unknown as IPage;

    await runBrowserWorkflowAction(
      page,
      {
        id: 'type-custom',
        kind: 'type',
        locator: { kind: 'role', value: 'before', tag: 'my-input', role: 'textbox' },
        value: 'after',
        sensitive: false,
        submit: false,
      },
      {},
    );

    assert.equal(control.value, 'after');
  });

  test('types into a contenteditable textbox through its text content', async () => {
    class FakeContentEditable {
      textContent = 'before';
      tagName = 'DIV';
      get innerText() {
        return this.textContent;
      }
      get isContentEditable() {
        return true;
      }
      focus() {}
      dispatchEvent() {}
      getAttribute(name: string) {
        return name === 'role' ? 'textbox' : null;
      }
    }
    class FakeEvent {}
    const editor = new FakeContentEditable();
    const document = {
      querySelectorAll: (selector: string) => (selector === 'div' ? [editor] : []),
      getElementById: () => null,
    };
    const page = {
      evaluate: async (script: string) =>
        new Function('document', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event', `return ${script};`)(
          document,
          class FakeInput {},
          class FakeTextarea {},
          FakeEvent,
        ),
    } as unknown as IPage;

    await runBrowserWorkflowAction(
      page,
      {
        id: 'type-editor',
        kind: 'type',
        locator: { kind: 'role', value: 'before', tag: 'div', role: 'textbox' },
        value: 'after',
        sensitive: false,
        submit: false,
      },
      {},
    );
    assert.equal(editor.textContent, 'after');
  });
});

describe('browser workflow service', () => {
  test('rejects missing sensitive values before acquiring the browser page', async () => {
    const store = new MemoryWorkflowStore();
    store.workflows.set('workflow-sensitive', {
      schemaVersion: 1,
      id: 'workflow-sensitive',
      name: 'Sensitive workflow',
      createdAt: 1,
      updatedAt: 1,
      actions: [
        { id: 'navigate-1', kind: 'navigate', url: 'https://example.test/' },
        {
          id: 'secret-1',
          kind: 'type',
          locator: { kind: 'name', value: 'password' },
          sensitive: true,
          submit: false,
        },
      ],
    });
    let boundaryCalls = 0;
    const progress: BrowserWorkflowProgress[] = [];
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => ({}) } as never,
      sendToRenderer: (_channel, event) => progress.push(event),
      runWithPage: async <T>() => {
        boundaryCalls += 1;
        return undefined as T;
      },
    });

    await assert.rejects(service.run('workflow-sensitive', 'session-1'), /Sensitive value required.*secret-1/);
    assert.equal(boundaryCalls, 0);
    assert.deepEqual(progress, []);
  });

  test('rejects replay while the target browser page is being recorded', async () => {
    const store = new MemoryWorkflowStore();
    store.workflows.set('workflow-1', {
      schemaVersion: 1,
      id: 'workflow-1',
      name: 'Navigate',
      createdAt: 1,
      updatedAt: 1,
      actions: [{ id: 'navigate-1', kind: 'navigate', url: 'https://example.test/' }],
    });
    let boundaryCalls = 0;
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => [],
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/start' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view, get: () => view } as never,
      sendToRenderer: () => {},
      runWithPage: async <T>() => {
        boundaryCalls += 1;
        return undefined as T;
      },
    });

    await service.startRecording('session-1');
    try {
      await assert.rejects(service.run('workflow-1', 'session-1'), /recording is active/i);
      assert.equal(boundaryCalls, 0);
    } finally {
      await service.cancelRecording('session-1');
    }
  });

  test('rejects recording while the target browser page is replaying a workflow', async () => {
    const store = new MemoryWorkflowStore();
    store.workflows.set('workflow-1', {
      schemaVersion: 1,
      id: 'workflow-1',
      name: 'Navigate',
      createdAt: 1,
      updatedAt: 1,
      actions: [{ id: 'navigate-1', kind: 'navigate', url: 'https://example.test/' }],
    });
    const boundaryStarted = deferred<void>();
    const boundaryRelease = deferred<void>();
    let recorderStarts = 0;
    const view = {
      startWorkflowRecorder: async () => {
        recorderStarts += 1;
      },
      drainWorkflowRecorderEvents: async () => [],
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/start' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view, get: () => view } as never,
      sendToRenderer: () => {},
      runWithPage: async <T>() => {
        boundaryStarted.resolve();
        await boundaryRelease.promise;
        return undefined as T;
      },
    });

    const running = service.run('workflow-1', 'session-1');
    await boundaryStarted.promise;
    try {
      await assert.rejects(service.startRecording('session-1'), /workflow is running/i);
      assert.equal(recorderStarts, 0);
    } finally {
      await service.cancelRecording('session-1');
      boundaryRelease.resolve();
      await running;
    }
  });

  test('rejects replay while recorder startup is still in flight', async () => {
    const store = new MemoryWorkflowStore();
    store.workflows.set('workflow-1', {
      schemaVersion: 1,
      id: 'workflow-1',
      name: 'Navigate',
      createdAt: 1,
      updatedAt: 1,
      actions: [{ id: 'navigate-1', kind: 'navigate', url: 'https://example.test/' }],
    });
    const recorderStarting = deferred<void>();
    const recorderRelease = deferred<void>();
    let boundaryCalls = 0;
    const view = {
      startWorkflowRecorder: async () => {
        recorderStarting.resolve();
        await recorderRelease.promise;
      },
      drainWorkflowRecorderEvents: async () => [],
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/start' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view, get: () => view } as never,
      sendToRenderer: () => {},
      runWithPage: async <T>() => {
        boundaryCalls += 1;
        return undefined as T;
      },
    });

    const starting = service.startRecording('session-1');
    await recorderStarting.promise;
    try {
      await assert.rejects(service.run('workflow-1', 'session-1'), /recording is active/i);
      assert.equal(boundaryCalls, 0);
    } finally {
      recorderRelease.resolve();
      await starting;
      await service.cancelRecording('session-1');
    }
  });

  test('rejects replay when recording wins during workflow lookup', async () => {
    const store = new MemoryWorkflowStore();
    store.workflows.set('workflow-1', {
      schemaVersion: 1,
      id: 'workflow-1',
      name: 'Navigate',
      createdAt: 1,
      updatedAt: 1,
      actions: [{ id: 'navigate-1', kind: 'navigate', url: 'https://example.test/' }],
    });
    const workflowRequested = deferred<void>();
    const workflowRelease = deferred<void>();
    store.get = async (id: string) => {
      workflowRequested.resolve();
      await workflowRelease.promise;
      return store.workflows.get(id);
    };
    let boundaryCalls = 0;
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => [],
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/start' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view, get: () => view } as never,
      sendToRenderer: () => {},
      runWithPage: async <T>() => {
        boundaryCalls += 1;
        return undefined as T;
      },
    });

    const running = service.run('workflow-1', 'session-1');
    await workflowRequested.promise;
    await service.startRecording('session-1');
    workflowRelease.resolve();
    try {
      await assert.rejects(running, /recording is active/i);
      assert.equal(boundaryCalls, 0);
    } finally {
      await service.cancelRecording('session-1');
    }
  });

  test('rejects an over-limit recording instead of silently saving a truncated workflow', async () => {
    const store = new MemoryWorkflowStore();
    let drained = false;
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => {
        if (drained) return [];
        drained = true;
        return Array.from({ length: BROWSER_WORKFLOW_MAX_ACTIONS + 1 }, (_, index) => ({
          kind: 'click' as const,
          locator: { kind: 'test_id' as const, value: `button-${index}` },
          timestamp: index,
        }));
      },
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/form' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view, get: () => view } as never,
      sendToRenderer: () => {},
    });

    await service.startRecording('session-limit');
    await assert.rejects(
      service.stopRecording('session-limit'),
      new RegExp(`limited to ${BROWSER_WORKFLOW_MAX_ACTIONS} actions`),
    );
    assert.equal(store.workflows.size, 0);
  });

  test('rejects a recording that observes a URL with credentials or secret query data', async () => {
    const store = new MemoryWorkflowStore();
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => [],
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/callback?access_token=secret' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view, get: () => view } as never,
      sendToRenderer: () => {},
    });

    await service.startRecording('session-secret-url');
    await assert.rejects(service.stopRecording('session-secret-url'), /cannot save URLs containing credentials/i);
    assert.equal(store.workflows.size, 0);
  });

  test('preserves a sensitive URL failure when adding a wait condition', async () => {
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => [],
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/callback?access_token=secret' }),
    };
    const service = createBrowserWorkflowService({
      store: new MemoryWorkflowStore(),
      views: { getOrCreate: () => view, get: () => view } as never,
      sendToRenderer: () => {},
    });

    await service.startRecording('session-secret-url');
    await assert.rejects(
      service.addWaitCondition('session-secret-url', {
        kind: 'selector',
        value: '[data-testid="ready"]',
        timeoutMs: 10_000,
      }),
      /cannot save URLs containing credentials/i,
    );
    await service.cancelRecording('session-secret-url');
  });

  test('releases an unsaved draft as soon as a later recording starts for the same session', async () => {
    const store = new MemoryWorkflowStore();
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => [],
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/start' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view, get: () => view } as never,
      sendToRenderer: () => {},
    });

    await service.startRecording('session-drafts');
    const first = await service.stopRecording('session-drafts');
    await service.startRecording('session-drafts');

    await assert.rejects(service.saveRecording(first.draftId, 'Discarded'), /draft is no longer available/i);
    const second = await service.stopRecording('session-drafts');
    await service.saveRecording(second.draftId, 'Current');
    assert.equal(store.workflows.size, 1);
  });

  test('preserves Enter submission while coalescing type events for one input', async () => {
    const store = new MemoryWorkflowStore();
    let drained = false;
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => {
        if (drained) return [];
        drained = true;
        return [
          {
            kind: 'type',
            locator: { kind: 'test_id', value: 'name' },
            value: 'Alice',
            sensitive: false,
            submit: false,
            timestamp: 100,
          },
          {
            kind: 'type',
            locator: { kind: 'test_id', value: 'name' },
            value: 'Alice',
            sensitive: false,
            submit: true,
            timestamp: 101,
          },
        ];
      },
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/form' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view, get: () => view } as never,
      sendToRenderer: () => {},
    });

    await service.startRecording('session-1');
    const draft = await service.stopRecording('session-1');
    const workflow = await service.saveRecording(draft.draftId, 'Submit with Enter');

    const typeAction = workflow.actions.find((action) => action.kind === 'type');
    assert.equal(typeAction?.kind === 'type' && typeAction.submit, true);
  });

  test('serializes recorder startup and cancellation for the same session', async () => {
    const firstStart = deferred<void>();
    const secondStop = deferred<void>();
    let starts = 0;
    let stops = 0;
    const view = {
      startWorkflowRecorder: async () => {
        starts += 1;
        if (starts === 1) await firstStart.promise;
      },
      drainWorkflowRecorderEvents: async () => [],
      stopWorkflowRecorder: async () => {
        stops += 1;
        if (stops === 2) await secondStop.promise;
        return [];
      },
      state: () => ({ url: 'https://example.test/start' }),
    };
    const service = createBrowserWorkflowService({
      store: new MemoryWorkflowStore(),
      views: { getOrCreate: () => view, get: () => view } as never,
      sendToRenderer: () => {},
    });

    const starting = service.startRecording('session-1');
    const canceling = service.cancelRecording('session-1');
    firstStart.resolve();
    await Promise.all([starting, canceling]);

    assert.equal(stops, 1);
    await service.startRecording('session-1');
    assert.equal(starts, 2);
    const cancelingForRestart = service.cancelRecording('session-1');
    const restarting = service.startRecording('session-1');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(starts, 2);
    secondStop.resolve();
    await Promise.all([cancelingForRestart, restarting]);
    assert.equal(starts, 3);
    await service.cancelRecording('session-1');
  });

  test('cancels a recording without recreating a browser view that was already retired', async () => {
    let viewAvailable = true;
    let createCalls = 0;
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => [],
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/start' }),
    };
    const service = createBrowserWorkflowService({
      store: new MemoryWorkflowStore(),
      views: {
        getOrCreate: () => {
          createCalls += 1;
          if (!viewAvailable) assert.fail('recording cleanup must not recreate a retired browser view');
          return view;
        },
        get: () => (viewAvailable ? view : undefined),
      } as never,
      sendToRenderer: () => {},
    });

    await service.startRecording('session-1');
    viewAvailable = false;
    await service.cancelRecording('session-1');

    assert.equal(createCalls, 1);
  });

  test('settles a pending interaction navigation before session release completes', async () => {
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => [],
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/start' }),
    };
    const service = createBrowserWorkflowService({
      store: new MemoryWorkflowStore(),
      views: { getOrCreate: () => view, get: () => view } as never,
      sendToRenderer: () => {},
    });

    await service.startRecording('session-1');
    let navigationSettled = false;
    const navigation = notifyBrowserWorkflowNavigation(
      'session-1',
      'https://example.test/next',
      'interaction',
    ).then(() => {
      navigationSettled = true;
    });

    await service.releaseSession('session-1');

    assert.equal(navigationSettled, true);
    await navigation;
  });

  test('waits for queued recorder drains without recreating a retired view', async () => {
    const firstDrainStarted = deferred<void>();
    const firstDrain = deferred<unknown[]>();
    let drainCalls = 0;
    let createCalls = 0;
    let viewAvailable = true;
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => {
        drainCalls += 1;
        if (drainCalls === 1) {
          firstDrainStarted.resolve();
          return firstDrain.promise;
        }
        return [];
      },
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/start' }),
    };
    const service = createBrowserWorkflowService({
      store: new MemoryWorkflowStore(),
      views: {
        getOrCreate: () => {
          createCalls += 1;
          if (!viewAvailable) assert.fail('recording cleanup must not recreate a retired browser view');
          return view;
        },
        get: () => (viewAvailable ? view : undefined),
      } as never,
      sendToRenderer: () => {},
    });

    await service.startRecording('session-1');
    const draining = flushBrowserWorkflowNavigation('session-1');
    await firstDrainStarted.promise;
    const queuedDrain = flushBrowserWorkflowNavigation('session-1');
    let released = false;
    const releasing = service.releaseSession('session-1').then(() => {
      released = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const releasedBeforeDrain = released;

    viewAvailable = false;
    firstDrain.resolve([]);
    const results = await Promise.allSettled([draining, queuedDrain, releasing]);

    assert.equal(releasedBeforeDrain, false);
    assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'fulfilled', 'fulfilled']);
    assert.equal(createCalls, 1);
  });

  test('waits for an in-flight recorder drain before creating the draft', async () => {
    const firstDrain = deferred<unknown[]>();
    const firstDrainStarted = deferred<void>();
    let drainCalls = 0;
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => {
        drainCalls += 1;
        if (drainCalls === 1) {
          firstDrainStarted.resolve();
          return firstDrain.promise;
        }
        return [];
      },
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/start' }),
    };
    const service = createBrowserWorkflowService({
      store: new MemoryWorkflowStore(),
      views: { getOrCreate: () => view, get: () => view } as never,
      sendToRenderer: () => {},
    });

    await service.startRecording('session-1');
    await firstDrainStarted.promise;
    const stopping = service.stopRecording('session-1');
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const stoppedBeforeDrain = stopped;
    firstDrain.resolve([
      {
        kind: 'click',
        locator: { kind: 'test_id', value: 'continue' },
        timestamp: 2,
      },
    ]);

    assert.equal(stoppedBeforeDrain, false);
    assert.equal((await stopping).actionCount, 2);
  });

  test('releases a draft created by a stop that settles after session teardown begins', async () => {
    const drainStarted = deferred<void>();
    const drainRelease = deferred<unknown[]>();
    let drainCalls = 0;
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => {
        drainCalls += 1;
        if (drainCalls === 1) {
          drainStarted.resolve();
          return drainRelease.promise;
        }
        return [];
      },
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/start' }),
    };
    const service = createBrowserWorkflowService({
      store: new MemoryWorkflowStore(),
      views: { getOrCreate: () => view, get: () => view } as never,
      sendToRenderer: () => {},
    });

    await service.startRecording('session-1');
    const stopping = service.stopRecording('session-1');
    await drainStarted.promise;
    const releaseSession = (service as unknown as { releaseSession?: (sessionId: string) => Promise<void> })
      .releaseSession;
    if (!releaseSession) {
      drainRelease.resolve([]);
      await stopping;
      assert.fail('BrowserWorkflowService.releaseSession is required');
    }
    const releasing = releaseSession.call(service, 'session-1');
    drainRelease.resolve([]);
    const draft = await stopping;
    await releasing;

    await assert.rejects(service.saveRecording(draft.draftId, 'Orphaned'), /draft is no longer available/i);
  });

  test('deduplicates successive input events for the same locator', async () => {
    const store = new MemoryWorkflowStore();
    let drained = false;
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => {
        if (drained) return [];
        drained = true;
        return [
          { kind: 'type', locator: { kind: 'name', value: 'username' }, value: 'a', timestamp: 1 },
          { kind: 'type', locator: { kind: 'name', value: 'username' }, value: 'alice', timestamp: 2 },
        ];
      },
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/start' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view, get: () => view } as never,
      sendToRenderer: () => {},
    });

    await service.startRecording('session-1');
    const draft = await service.stopRecording('session-1');
    const workflow = await service.saveRecording(draft.draftId, 'Sign in');

    assert.deepEqual(workflow.actions.slice(1), [
      {
        id: workflow.actions[1]?.id,
        kind: 'type',
        locator: { kind: 'name', value: 'username' },
        value: 'alice',
        sensitive: false,
        submit: false,
      },
    ]);
  });

  test('never stores a sensitive value in a saved workflow', async () => {
    const store = new MemoryWorkflowStore();
    let drained = false;
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => {
        if (drained) return [];
        drained = true;
        return [
          {
            kind: 'type',
            locator: { kind: 'name', value: 'password' },
            value: 'must-not-persist',
            sensitive: true,
            timestamp: 1,
          },
        ];
      },
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/start' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view, get: () => view } as never,
      sendToRenderer: () => {},
    });

    await service.startRecording('session-1');
    const draft = await service.stopRecording('session-1');
    const workflow = await service.saveRecording(draft.draftId, 'Sign in');

    assert.doesNotMatch(JSON.stringify(workflow), /must-not-persist/);
    assert.equal(workflow.actions[1]?.kind, 'type');
    if (workflow.actions[1]?.kind === 'type') assert.equal(workflow.actions[1].value, undefined);
  });

  test('never downgrades a deduplicated sensitive input action', async () => {
    const store = new MemoryWorkflowStore();
    let drained = false;
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => {
        if (drained) return [];
        drained = true;
        return [
          {
            kind: 'type',
            locator: { kind: 'name', value: 'secret' },
            value: 'first-secret',
            sensitive: true,
            timestamp: 1,
          },
          {
            kind: 'type',
            locator: { kind: 'name', value: 'secret' },
            value: 'second-secret',
            sensitive: false,
            timestamp: 2,
          },
        ];
      },
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/start' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view, get: () => view } as never,
      sendToRenderer: () => {},
    });

    await service.startRecording('session-1');
    const draft = await service.stopRecording('session-1');
    const workflow = await service.saveRecording(draft.draftId, 'Secret');

    assert.equal(workflow.actions[1]?.kind, 'type');
    if (workflow.actions[1]?.kind === 'type') {
      assert.equal(workflow.actions[1].sensitive, true);
      assert.equal(workflow.actions[1].value, undefined);
    }
  });

  test('records each distinct main-frame navigation once', async () => {
    const store = new MemoryWorkflowStore();
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => [],
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/start' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view, get: () => view } as never,
      sendToRenderer: () => {},
    });

    await service.startRecording('session-1');
    notifyBrowserWorkflowNavigation('session-1', 'https://example.test/next');
    notifyBrowserWorkflowNavigation('session-1', 'https://example.test/next');
    const draft = await service.stopRecording('session-1');
    const workflow = await service.saveRecording(draft.draftId, 'Navigate');

    assert.deepEqual(
      workflow.actions.map((action) => (action.kind === 'navigate' ? action.url : action.kind)),
      ['https://example.test/start', 'https://example.test/next'],
    );
  });

  test('records interaction-driven navigation as an expected URL wait', async () => {
    const store = new MemoryWorkflowStore();
    let drained = false;
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => {
        if (drained) return [];
        drained = true;
        return [
          {
            eventId: 'click-submit',
            kind: 'click',
            locator: { kind: 'test_id', value: 'submit' },
            timestamp: 1,
          },
        ];
      },
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/form' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view, get: () => view } as never,
      sendToRenderer: () => {},
    });

    await service.startRecording('session-1');
    notifyBrowserWorkflowRecorderEvent('session-1', {
      eventId: 'click-submit',
      kind: 'click',
      locator: { kind: 'test_id', value: 'submit' },
      timestamp: 1,
    });
    await flushBrowserWorkflowNavigation('session-1');
    notifyBrowserWorkflowNavigation('session-1', 'https://example.test/submitted');
    const draft = await service.stopRecording('session-1');

    assert.deepEqual(
      draft.actions.map((action) =>
        action.kind === 'navigate'
          ? action.url
          : action.kind === 'wait' && 'url' in action
            ? action.url
            : action.kind,
      ),
      ['https://example.test/form', 'click', 'https://example.test/submitted'],
    );
    assert.equal(draft.actions.at(-1)?.kind, 'wait');
  });

  test('keeps a submit action before its navigation when WebContents reports navigation first', async () => {
    const store = new MemoryWorkflowStore();
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => [],
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/form' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view, get: () => view } as never,
      sendToRenderer: () => {},
    });

    await service.startRecording('session-navigation-first');
    const navigation = notifyBrowserWorkflowNavigation(
      'session-navigation-first',
      'https://example.test/submitted',
      'interaction',
    );
    notifyBrowserWorkflowRecorderEvent('session-navigation-first', {
      eventId: 'submit-after-navigation',
      kind: 'type',
      locator: { kind: 'test_id', value: 'name' },
      value: 'Alice',
      submit: true,
      timestamp: 1,
    });
    await navigation;
    const draft = await service.stopRecording('session-navigation-first');

    assert.deepEqual(
      draft.actions.map((action) =>
        action.kind === 'navigate' ? action.url : action.kind === 'wait' ? action.url : action.kind,
      ),
      ['https://example.test/form', 'type', 'https://example.test/submitted'],
    );
  });

  test('coalesces redirect-chain interaction navigations to the settled URL', async () => {
    const store = new MemoryWorkflowStore();
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => [],
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/form' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view, get: () => view } as never,
      sendToRenderer: () => {},
    });

    await service.startRecording('session-redirect');
    notifyBrowserWorkflowRecorderEvent('session-redirect', {
      eventId: 'submit',
      kind: 'click',
      locator: { kind: 'test_id', value: 'submit' },
      timestamp: 1,
    });
    notifyBrowserWorkflowNavigation('session-redirect', 'https://example.test/oauth/authorize', 'interaction');
    notifyBrowserWorkflowNavigation('session-redirect', 'https://example.test/callback', 'interaction');
    const draft = await service.stopRecording('session-redirect');

    assert.deepEqual(
      draft.actions.map((action) =>
        action.kind === 'navigate' ? action.url : action.kind === 'wait' ? action.url : action.kind,
      ),
      ['https://example.test/form', 'click', 'https://example.test/callback'],
    );
  });

  test('settles a pending navigation before recording the next page interaction', async () => {
    const store = new MemoryWorkflowStore();
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => [],
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/start' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view, get: () => view } as never,
      sendToRenderer: () => {},
    });

    await service.startRecording('session-fast-pages');
    const firstInteractionAt = Date.now();
    notifyBrowserWorkflowRecorderEvent('session-fast-pages', {
      eventId: 'open-form',
      kind: 'click',
      locator: { kind: 'test_id', value: 'open-form' },
      timestamp: firstInteractionAt,
    });
    notifyBrowserWorkflowNavigation('session-fast-pages', 'https://example.test/form', 'interaction');
    notifyBrowserWorkflowRecorderEvent('session-fast-pages', {
      eventId: 'submit-form',
      kind: 'click',
      locator: { kind: 'test_id', value: 'submit' },
      timestamp: Date.now() + 1,
    });
    notifyBrowserWorkflowNavigation('session-fast-pages', 'https://example.test/form/complete', 'interaction');

    const draft = await service.stopRecording('session-fast-pages');
    assert.deepEqual(
      draft.actions.map((action) =>
        action.kind === 'navigate' ? action.url : action.kind === 'wait' ? action.url : action.kind,
      ),
      [
        'https://example.test/start',
        'click',
        'https://example.test/form',
        'click',
        'https://example.test/form/complete',
      ],
    );
  });

  test('records dynamic interaction URLs as URL-free navigation waits', async () => {
    const store = new MemoryWorkflowStore();
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => [],
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/form' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view, get: () => view } as never,
      sendToRenderer: () => {},
    });
    await service.startRecording('session-dynamic');
    notifyBrowserWorkflowRecorderEvent('session-dynamic', { kind: 'click', locator: { kind: 'test_id', value: 'submit' }, timestamp: 1 });
    await notifyBrowserWorkflowNavigation('session-dynamic', 'https://example.test/orders/12345?state=nonce', 'interaction');
    const draft = await service.stopRecording('session-dynamic');
    assert.deepEqual(draft.actions.map((action) => action.kind), ['navigate', 'click', 'wait']);
    assert.deepEqual(draft.actions.at(-1), {
      id: draft.actions.at(-1)?.id,
      kind: 'wait',
      navigation: true,
      timeoutMs: 30_000,
    });
  });

  test('records sensitive interaction URLs as URL-free navigation waits', async () => {
    const store = new MemoryWorkflowStore();
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => [],
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/form' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view, get: () => view } as never,
      sendToRenderer: () => {},
    });
    await service.startRecording('session-sensitive-redirect');
    notifyBrowserWorkflowRecorderEvent('session-sensitive-redirect', {
      kind: 'click',
      locator: { kind: 'test_id', value: 'authorize' },
      timestamp: 1,
    });
    await notifyBrowserWorkflowNavigation(
      'session-sensitive-redirect',
      'https://example.test/callback?access_token=secret#account',
      'interaction',
    );

    const draft = await service.stopRecording('session-sensitive-redirect');
    assert.deepEqual(draft.actions.at(-1), {
      id: draft.actions.at(-1)?.id,
      kind: 'wait',
      navigation: true,
      timeoutMs: 30_000,
    });
    const serialized = JSON.stringify(draft);
    assert.doesNotMatch(serialized, /access_token|secret|account|callback/);
  });

  test('records toolbar navigation as an explicit navigation action', async () => {
    const store = new MemoryWorkflowStore();
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => [],
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/form' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view, get: () => view } as never,
      sendToRenderer: () => {},
    });

    await service.startRecording('session-1');
    notifyBrowserWorkflowRecorderEvent('session-1', {
      eventId: 'click-submit',
      kind: 'click',
      locator: { kind: 'test_id', value: 'submit' },
      timestamp: 1,
    });
    await notifyBrowserWorkflowNavigation('session-1', 'https://example.test/previous', 'explicit');
    const draft = await service.stopRecording('session-1');
    const workflow = await service.saveRecording(draft.draftId, 'Toolbar navigation');

    assert.deepEqual(
      workflow.actions.map((action) => (action.kind === 'navigate' ? action.url : action.kind)),
      ['https://example.test/form', 'click', 'https://example.test/previous'],
    );
  });

  test('records an observed wait condition in order and exposes the safe draft for review', async () => {
    const store = new MemoryWorkflowStore();
    const page = {
      evaluate: async (script: string) => {
        assert.match(script, /data-testid/);
        return { ok: true, matched: 1 };
      },
    } as unknown as IPage;
    let drained = false;
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => {
        if (drained) return [];
        drained = true;
        return [
          {
            kind: 'type',
            locator: { kind: 'name', value: 'password' },
            value: 'must-not-cross-ipc',
            sensitive: true,
            timestamp: 1,
          },
        ];
      },
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/start' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view, get: () => view } as never,
      sendToRenderer: () => {},
      runWithPage: <T>(
        _sessionId: string,
        _label: string,
        run: (page: IPage, info: { takeoverReloaded: boolean }) => Promise<T>,
      ) => run(page, { takeoverReloaded: false }),
    });

    await service.startRecording('session-1');
    await service.addWaitCondition('session-1', {
      kind: 'selector',
      value: '[data-testid="ready"]',
      timeoutMs: 10_000,
    });
    const draft = await service.stopRecording('session-1');

    assert.deepEqual(
      draft.actions.map((action) => action.kind),
      ['navigate', 'type', 'wait'],
    );
    assert.doesNotMatch(JSON.stringify(draft.actions), /must-not-cross-ipc/);
    assert.deepEqual(draft.actions.at(-1), {
      id: draft.actions.at(-1)?.id,
      kind: 'wait',
      selector: '[data-testid="ready"]',
      timeoutMs: 10_000,
    });
  });

  test('rejects wait conditions that are not observable on the recorded page', async () => {
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => [],
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/start' }),
    };
    const service = createBrowserWorkflowService({
      store: new MemoryWorkflowStore(),
      views: { getOrCreate: () => view, get: () => view } as never,
      sendToRenderer: () => {},
      runWithPage: async <T>(
        _sessionId: string,
        _label: string,
        run: (page: IPage, info: { takeoverReloaded: boolean }) => Promise<T>,
      ) =>
        run(
          { evaluate: async () => ({ ok: false, reason: 'not_found', matched: 0 }) } as unknown as IPage,
          { takeoverReloaded: false },
        ),
    });

    await service.startRecording('session-1');
    await assert.rejects(
      service.addWaitCondition('session-1', {
        kind: 'text',
        value: 'Ready to continue',
        timeoutMs: 10_000,
      }),
      /not currently observable/i,
    );
    await service.cancelRecording('session-1');
  });

  test('loads a workflow page before requiring a live viewport for later actions', async () => {
    const store = new MemoryWorkflowStore();
    store.workflows.set('workflow-1', {
      schemaVersion: 1,
      id: 'workflow-1',
      name: 'Cold session workflow',
      createdAt: 1,
      updatedAt: 1,
      actions: [
        { id: 'navigate-1', kind: 'navigate', url: 'https://example.test/form' },
        { id: 'click-1', kind: 'click', locator: { kind: 'test_id', value: 'submit' } },
      ],
    });
    const takeovers: Array<'observe' | 'mutate' | 'navigate'> = [];
    const page = {
      goto: async () => {},
      evaluate: async () => ({ ok: true, matched: 1 }),
      click: async () => ({ matches_n: 1, match_level: 'exact' as const }),
    } as unknown as IPage;
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => ({}) } as never,
      sendToRenderer: () => {},
      runWithPage: async <T>(
        _sessionId: string,
        _label: string,
        run: (page: IPage, info: { takeoverReloaded: boolean }) => Promise<T>,
        options?: { takeover?: 'observe' | 'mutate' | 'navigate' },
      ) => {
        takeovers.push(options?.takeover ?? 'observe');
        return run(page, { takeoverReloaded: false });
      },
    });

    await service.run('workflow-1', 'session-cold');

    assert.deepEqual(takeovers, ['navigate', 'mutate']);
  });

  test('reports cancellation when the page boundary settles after abort', async () => {
    const store = new MemoryWorkflowStore();
    store.workflows.set('workflow-1', {
      schemaVersion: 1,
      id: 'workflow-1',
      name: 'Navigate',
      createdAt: 1,
      updatedAt: 1,
      actions: [{ id: 'navigate-1', kind: 'navigate', url: 'https://example.test/' }],
    });
    const boundaryStarted = deferred<void>();
    const boundaryRelease = deferred<void>();
    const progress: BrowserWorkflowProgress[] = [];
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => ({}) } as never,
      sendToRenderer: (_channel, event) => progress.push(event),
      runWithPage: async <T>() => {
        boundaryStarted.resolve();
        await boundaryRelease.promise;
        return undefined as T;
      },
    });

    const running = service.run('workflow-1', 'session-1');
    await boundaryStarted.promise;
    const runId = progress.find((event) => event.status === 'running')?.runId;
    assert.ok(runId);
    service.cancel(runId);
    boundaryRelease.resolve();

    await assert.rejects(running, /canceled/i);
    assert.equal(progress.at(-1)?.status, 'canceled');
  });

  test('keeps the run slot until a canceled page boundary settles', async () => {
    const store = new MemoryWorkflowStore();
    store.workflows.set('workflow-1', {
      schemaVersion: 1,
      id: 'workflow-1',
      name: 'Navigate',
      createdAt: 1,
      updatedAt: 1,
      actions: [{ id: 'navigate-1', kind: 'navigate', url: 'https://example.test/' }],
    });
    const boundaryStarted = deferred<void>();
    const boundaryRelease = deferred<void>();
    const progress: BrowserWorkflowProgress[] = [];
    let boundaryCalls = 0;
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => ({}) } as never,
      sendToRenderer: (_channel, event) => progress.push(event),
      runWithPage: async <T>() => {
        boundaryCalls += 1;
        if (boundaryCalls === 1) {
          boundaryStarted.resolve();
          await boundaryRelease.promise;
        }
        return undefined as T;
      },
    });

    const firstRun = service.run('workflow-1', 'session-1');
    await boundaryStarted.promise;
    const runId = progress.find((event) => event.status === 'running')?.runId;
    assert.ok(runId);
    service.cancel(runId);
    let secondError: unknown;
    try {
      await service.run('workflow-1', 'session-1');
    } catch (error) {
      secondError = error;
    }
    boundaryRelease.resolve();
    await assert.rejects(firstRun, /canceled/i);

    assert.match(secondError instanceof Error ? secondError.message : '', /Another browser workflow is already running/);
    assert.equal(boundaryCalls, 1);
  });

  test('waits for an active workflow run to settle before releasing its session', async () => {
    const store = new MemoryWorkflowStore();
    store.workflows.set('workflow-1', {
      schemaVersion: 1,
      id: 'workflow-1',
      name: 'Navigate',
      createdAt: 1,
      updatedAt: 1,
      actions: [{ id: 'navigate-1', kind: 'navigate', url: 'https://example.test/' }],
    });
    const boundaryStarted = deferred<void>();
    const boundaryRelease = deferred<void>();
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => ({}) } as never,
      sendToRenderer: () => {},
      runWithPage: async <T>(
        _sessionId: string,
        _label: string,
        _run: (page: IPage, info: { takeoverReloaded: boolean }) => Promise<T>,
        opts?: { abort?: AbortSignal },
      ) => {
        boundaryStarted.resolve();
        await boundaryRelease.promise;
        opts?.abort?.throwIfAborted();
        return undefined as T;
      },
    });

    const running = service.run('workflow-1', 'session-1');
    await boundaryStarted.promise;
    let released = false;
    const releasing = service.releaseSession('session-1').then(() => {
      released = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    assert.equal(released, false);
    boundaryRelease.resolve();
    await assert.rejects(running);
    await releasing;
  });

  test('does not start a workflow run whose definition resolves during session release', async () => {
    const workflow = {
      schemaVersion: 1 as const,
      id: 'workflow-1',
      name: 'Navigate',
      createdAt: 1,
      updatedAt: 1,
      actions: [{ id: 'navigate-1', kind: 'navigate' as const, url: 'https://example.test/' }],
    };
    const workflowRequested = deferred<void>();
    const workflowRelease = deferred<typeof workflow>();
    let boundaryCalls = 0;
    const service = createBrowserWorkflowService({
      store: {
        get: async () => {
          workflowRequested.resolve();
          return workflowRelease.promise;
        },
      } as never,
      views: { getOrCreate: () => ({}) } as never,
      sendToRenderer: () => {},
      runWithPage: async <T>() => {
        boundaryCalls += 1;
        return undefined as T;
      },
    });

    const running = service.run('workflow-1', 'session-1');
    await workflowRequested.promise;
    let released = false;
    const releasing = service.releaseSession('session-1').then(() => {
      released = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    assert.equal(released, false);
    workflowRelease.resolve(workflow);

    await assert.rejects(running, /session is being released/i);
    await releasing;
    assert.equal(boundaryCalls, 0);
  });

  test('rejects a new workflow run while its session release is in progress', async () => {
    const workflow = {
      schemaVersion: 1 as const,
      id: 'workflow-1',
      name: 'Navigate',
      createdAt: 1,
      updatedAt: 1,
      actions: [{ id: 'navigate-1', kind: 'navigate' as const, url: 'https://example.test/' }],
    };
    const firstWorkflowRequested = deferred<void>();
    const firstWorkflowRelease = deferred<typeof workflow>();
    let getCalls = 0;
    let boundaryCalls = 0;
    const service = createBrowserWorkflowService({
      store: {
        get: async () => {
          getCalls += 1;
          if (getCalls === 1) {
            firstWorkflowRequested.resolve();
            return firstWorkflowRelease.promise;
          }
          return workflow;
        },
      } as never,
      views: { getOrCreate: () => ({}) } as never,
      sendToRenderer: () => {},
      runWithPage: async <T>() => {
        boundaryCalls += 1;
        return undefined as T;
      },
    });

    const firstRun = service.run('workflow-1', 'session-1');
    await firstWorkflowRequested.promise;
    const releasing = service.releaseSession('session-1');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    await assert.rejects(service.run('workflow-1', 'session-1'), /session is being released/i);
    firstWorkflowRelease.resolve(workflow);
    await assert.rejects(firstRun, /session is being released/i);
    await releasing;
    assert.equal(boundaryCalls, 0);
  });

  test('emits ordered progress for each replayed action', async () => {
    const store = new MemoryWorkflowStore();
    store.workflows.set('workflow-1', {
      schemaVersion: 1,
      id: 'workflow-1',
      name: 'Submit',
      createdAt: 1,
      updatedAt: 1,
      actions: [
        { id: 'navigate-1', kind: 'navigate', url: 'https://example.test/' },
        { id: 'click-1', kind: 'click', locator: { kind: 'test_id', value: 'submit' } },
      ],
    });
    const page = {
      goto: async () => {},
      evaluate: async () => ({ ok: true, matched: 1 }),
      click: async () => ({ matches_n: 1, match_level: 'exact' as const }),
    } as unknown as IPage;
    const progress: BrowserWorkflowProgress[] = [];
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => ({}) } as never,
      sendToRenderer: (_channel, event) => progress.push(event),
      runWithPage: <T>(_sessionId: string, _label: string, run: (page: IPage, info: { takeoverReloaded: boolean }) => Promise<T>) =>
        run(page, { takeoverReloaded: false }),
    });

    await service.run('workflow-1', 'session-1');

    assert.deepEqual(
      progress.map((event) => [event.status, event.current, event.total]),
      [
        ['running', 0, 2],
        ['running', 1, 2],
        ['running', 2, 2],
        ['completed', 2, 2],
      ],
    );
  });
});
