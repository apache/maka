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
import { registerHooks } from 'node:module';
import { afterEach, test } from 'node:test';
import { act, createElement } from 'react';
import { LocaleProvider } from '@maka/ui';
import { terminalFeedback, isValidPrivateTerminalInput, TerminalHandoffPanel, loadSessionTerminalPanelForTest, createFakeWorkbarServices, WorkbarServicesProvider } from '../../renderer/features/workbar/testing.js';
import type { SessionEvent } from '@maka/core/events';
import { installReactRenderer, cleanupFakeDom, FakeElement } from './fake-dom.js';
import { desktopSessionKey } from '../../shared/runtime-host-identity.js';

afterEach(cleanupFakeDom);

test('OpenSSH adapter recognizes a current retry but never infers success from output', () => {
  const command = '/usr/bin/ssh -tt fixture@localhost';
  assert.equal(terminalFeedback(command, "fixture@localhost's password: "), 'password');
  const retry = "fixture@localhost's password: \nPermission denied, please try again.\nfixture@localhost's password: \n\n";
  assert.equal(terminalFeedback(command, retry), 'authentication_retry');
  assert.equal(terminalFeedback(command, `${retry}Verification code: `), undefined);
  assert.equal(terminalFeedback(command, `${retry}AUTHENTICATED\n$ `), undefined);
  assert.equal(terminalFeedback(command, 'The password was wrong'), undefined);
});

test('unknown programs, compound commands and unsupported prompts use raw private output', () => {
  const retry = "Permission denied, please try again.\nfixture@localhost's password: ";
  for (const command of ['my-ssh-wrapper host', 'sudo ssh host', 'echo ssh host', 'ssh host; other-command']) {
    assert.equal(terminalFeedback(command, retry), undefined);
  }
  assert.equal(terminalFeedback('ssh host', '输入密码：'), undefined);
  assert.equal(terminalFeedback('ssh host', 'Verification code incorrect'), undefined);
});

test('private input validation uses bytes and rejects embedded terminal controls before submission', () => {
  assert.equal(isValidPrivateTerminalInput('密码 with spaces'), true);
  assert.equal(isValidPrivateTerminalInput('a'.repeat(32 * 1024)), true);
  for (const value of ['', 'a\nb', 'a\rb', 'a\tb', '\x1b[A', 'a\x7fb', '\ud800', '密'.repeat(11_000)]) {
    assert.equal(isValidPrivateTerminalInput(value), false);
  }
});

function descendants(element: FakeElement): FakeElement[] {
  return [element, ...element.childNodes.flatMap((child) => child instanceof FakeElement ? descendants(child) : [])];
}

test('a disconnected private card explains recovery and cannot offer an enabled Resume', async () => {
  const { root, container } = installReactRenderer();
  const services = createFakeWorkbarServices({ terminal: { ...createFakeWorkbarServices().terminal, handoff: async () => { throw new Error('transport lost'); } } });
  await act(async () => root.render(createElement(LocaleProvider, { locale: 'en', children:
    createElement(WorkbarServicesProvider, { services }, createElement(TerminalHandoffPanel, {
      sessionId: desktopSessionKey({ hostId: 'host-1', sessionId: 'session-1' }), active: true,
      request: { requestId: 'request-1', ref: 'terminal-1', message: 'Authenticate', command: 'ssh host' },
    })),
  })));
  assert.match(container.textContent, /Connection to this terminal was lost/);
  assert.match(container.textContent, /Reconnect to original terminal/);
  assert.equal(descendants(container).some((node) => node.tagName === 'BUTTON' && node.textContent === 'Done, continue task'), false);
});

test('a closed card shows the process outcome without retaining a private input or success claim', async () => {
  const { root, container } = installReactRenderer();
  const services = createFakeWorkbarServices({ terminal: { ...createFakeWorkbarServices().terminal, handoff: async () => ({ status: 'closed', phase: 'closed', closure: 'exited', nextSequence: 2 }) } });
  await act(async () => root.render(createElement(LocaleProvider, { locale: 'en', children:
    createElement(WorkbarServicesProvider, { services }, createElement(TerminalHandoffPanel, {
      sessionId: desktopSessionKey({ hostId: 'host-1', sessionId: 'session-1' }), active: true,
      request: { requestId: 'request-1', ref: 'terminal-1', message: 'Authenticate', command: 'ssh host' },
    })),
  })));
  assert.match(container.textContent, /original terminal process exited/);
  assert.equal(descendants(container).some((node) => node.tagName === 'INPUT'), false);
  assert.doesNotMatch(container.textContent, /Control returned to the agent/);
});

test('recovering an uncertain receipt keeps Submit and Resume disabled', async () => {
  const { root, container } = installReactRenderer();
  const operations: string[] = [];
  const services = createFakeWorkbarServices({ terminal: { ...createFakeWorkbarServices().terminal,
    handoff: async (operation) => {
      operations.push(operation.action);
      return { status: 'outcome_unknown', phase: 'human', nextSequence: 2, display: { sequence: 1, text: 'private', inputOpen: true } };
    },
  } });
  await act(async () => root.render(createElement(LocaleProvider, { locale: 'en', children:
    createElement(WorkbarServicesProvider, { services }, createElement(TerminalHandoffPanel, {
      sessionId: desktopSessionKey({ hostId: 'host-1', sessionId: 'session-1' }), active: true,
      request: { requestId: 'request-1', ref: 'terminal-1', message: 'Authenticate', command: 'sh' },
    })),
  })));
  assert.match(container.textContent, /Delivery could not be confirmed/);
  const buttons = descendants(container).filter((node) => node.tagName === 'BUTTON');
  for (const label of ['Submit', 'Done, continue task']) {
    const button = buttons.find((node) => node.textContent === label);
    assert.ok(button, label);
    assert.notEqual(button.getAttribute('disabled'), null, label);
  }
  assert.equal(operations.includes('input'), false);
});

test('losing observation while human input is open clears private display and disables input', async () => {
  const { root, container } = installReactRenderer();
  const services = createFakeWorkbarServices({ terminal: { ...createFakeWorkbarServices().terminal,
    handoff: async (operation) => {
      if (operation.action === 'observe') throw new Error('disconnected');
      return { status: 'ready', phase: 'human', nextSequence: 1, display: { sequence: 1, text: 'private-sentinel', inputOpen: true } };
    },
  } });
  await act(async () => root.render(createElement(LocaleProvider, { locale: 'en', children:
    createElement(WorkbarServicesProvider, { services }, createElement(TerminalHandoffPanel, {
      sessionId: desktopSessionKey({ hostId: 'host-1', sessionId: 'session-1' }), active: true,
      request: { requestId: 'request-1', ref: 'terminal-1', message: 'Authenticate', command: 'sh' },
    })),
  })));
  assert.match(container.textContent, /Connection to this terminal was lost/);
  assert.doesNotMatch(container.textContent, /private-sentinel/);
  for (const node of descendants(container)) {
    if (node.tagName === 'INPUT' || (node.tagName === 'BUTTON' && ['Submit', 'Done, continue task'].includes(node.textContent))) {
      assert.notEqual(node.getAttribute('disabled'), null);
    }
  }
});

test('one explicit completion click resumes the original handoff; prompt rendering never resumes it', async () => {
  const { root, container } = installReactRenderer();
  const answers: unknown[] = [];
  const services = createFakeWorkbarServices({ terminal: { ...createFakeWorkbarServices().terminal,
    handoff: async () => ({ status: 'ready', phase: 'human', nextSequence: 1, display: { sequence: 1, text: '$ ', inputOpen: true } }),
    answerHandoff: async (answer) => { answers.push(answer); },
  } });
  await act(async () => root.render(createElement(LocaleProvider, { locale: 'en', children:
    createElement(WorkbarServicesProvider, { services }, createElement(TerminalHandoffPanel, {
      sessionId: desktopSessionKey({ hostId: 'host-1', sessionId: 'session-1' }), active: true,
      request: { requestId: 'request-1', ref: 'terminal-1', message: 'Authenticate', command: 'sh' },
    })),
  })));
  const button = descendants(container).find((node) => node.tagName === 'BUTTON' && node.textContent === 'Done, continue task');
  assert.ok(button);
  assert.equal(button.getAttribute('disabled'), null);
  assert.deepEqual(answers, []);
  assert.doesNotMatch(container.textContent, /I checked the terminal/);
  const propsKey = Object.keys(button).find((key) => key.startsWith('__reactProps$'));
  assert.ok(propsKey);
  const props = (button as unknown as Record<string, { onClick(): void }>)[propsKey]!;
  await act(async () => props.onClick());
  assert.equal(answers.length, 1);
  assert.deepEqual(answers[0], {
    sessionId: desktopSessionKey({ hostId: 'host-1', sessionId: 'session-1' }),
    requestId: 'request-1', controllerId: (answers[0] as { controllerId: string }).controllerId, action: 'resume',
  });
});

test('revealing a private draft never sends it and submission or hiding resets visibility', async () => {
  const { root, container } = installReactRenderer();
  const submitted: string[] = [];
  const services = createFakeWorkbarServices({ terminal: { ...createFakeWorkbarServices().terminal,
    handoff: async (operation) => {
      if (operation.action === 'input') submitted.push(operation.input);
      return { status: operation.action === 'input' ? 'written' : 'observed', phase: 'human', nextSequence: 1, display: { sequence: 1, text: '$ ', inputOpen: true } };
    },
  } });
  const render = async (active: boolean) => act(async () => root.render(createElement(LocaleProvider, { locale: 'en', children:
    createElement(WorkbarServicesProvider, { services }, createElement(TerminalHandoffPanel, {
      sessionId: desktopSessionKey({ hostId: 'host-1', sessionId: 'session-1' }), active,
      request: { requestId: 'request-1', ref: 'terminal-1', message: 'Authenticate', command: 'sh' },
    })),
  })));
  const propsOf = (node: FakeElement) => {
    const key = Object.keys(node).find((candidate) => candidate.startsWith('__reactProps$'));
    assert.ok(key);
    return (node as unknown as Record<string, { type?: string; value?: string; onClick(): void; onChange(event: { target: { value: string } }): void }>)[key]!;
  };
  const field = () => descendants(container).find((node) => node.tagName === 'INPUT')!;
  const click = async (label: string) => {
    const button = descendants(container).find((node) => node.tagName === 'BUTTON' && (node.textContent === label || node.getAttribute('aria-label') === label));
    assert.ok(button, label);
    await act(async () => propsOf(button).onClick());
  };
  const edit = async () => act(async () => {
    (field() as FakeElement & { value: string }).value = 'private-draft';
    propsOf(field()).onChange({ target: { value: 'private-draft' } });
  });
  await render(true);
  assert.equal(propsOf(field()).type, 'password');
  await edit();
  const resume = descendants(container).find((node) => node.tagName === 'BUTTON' && node.textContent === 'Done, continue task')!;
  assert.notEqual(resume.getAttribute('disabled'), null, 'a draft still blocks completion');
  await click('Show input');
  assert.equal(propsOf(field()).type, 'text');
  assert.deepEqual(submitted, []);
  assert.ok(descendants(container).some((node) => node.getAttribute('data-maka-assistant-exclude') !== null));
  await click('Submit');
  assert.deepEqual(submitted, ['private-draft']);
  assert.equal(propsOf(field()).type, 'password');
  assert.equal(propsOf(field()).value, '');
  await edit();
  await click('Show input');
  await render(false);
  await render(true);
  assert.equal(propsOf(field()).type, 'password');
  assert.equal(propsOf(field()).value, '');
});

test('an existing terminal tab refreshes a new handoff request from its canonical event', async () => {
  const { root, container } = installReactRenderer();
  // The handoff path never instantiates xterm. Stub its browser-only UMD imports
  // while rendering the real wrapper/card and exercising their subscriptions.
  const browserOnly = new Map([['@xterm/xterm', 'Terminal'], ['@xterm/addon-fit', 'FitAddon'], ['@xterm/addon-web-links', 'WebLinksAddon']]);
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === './browser-storage' && context.parentURL?.endsWith('/theme.js')) return next('./browser-storage.js', context);
    const name = browserOnly.get(specifier);
    return name ? { url: `data:text/javascript,export class ${name} {}`, shortCircuit: true } : next(specifier, context);
  } });
  let SessionTerminalPanel;
  try { ({ SessionTerminalPanel } = await loadSessionTerminalPanelForTest()); }
  finally { hooks.deregister(); }
  let receive: ((event: SessionEvent) => void) | undefined;
  let requestId = 'first-request';
  const base = createFakeWorkbarServices();
  const services = createFakeWorkbarServices({
    review: { ...base.review, subscribeSessionEvents: (_id, handler) => { receive = handler; return () => { receive = undefined; }; } },
    terminal: { ...base.terminal, handoff: async () => ({ status: 'available', phase: 'waiting', nextSequence: 1,
      request: { requestId, ref: 'terminal-1', command: 'sh', message: requestId } }) },
  });
  await act(async () => root.render(createElement(LocaleProvider, { locale: 'en', children:
    createElement(WorkbarServicesProvider, { services }, createElement(SessionTerminalPanel, {
      sessionId: desktopSessionKey({ hostId: 'host-1', sessionId: 'session-1' }), active: false, terminalRef: 'terminal-1',
    })),
  })));
  assert.match(container.textContent, /first-request/);
  requestId = 'second-request';
  assert.ok(receive);
  await act(async () => receive?.({ type: 'terminal_handoff_request', id: 'event-2', turnId: 'turn-1', ts: 2,
    requestId, toolUseId: 'tool-2', ref: 'terminal-1', message: requestId }));
  assert.match(container.textContent, /second-request/);
  assert.doesNotMatch(container.textContent, /first-request/);
});

test('a resumed card clears hidden output and reclaims the review surface on return', async () => {
  const { root, container } = installReactRenderer();
  const operations: string[] = [];
  const services = createFakeWorkbarServices({ terminal: { ...createFakeWorkbarServices().terminal,
    handoff: async (operation) => {
      operations.push(operation.action);
      return { status: 'observed', phase: 'resumed', nextSequence: 2,
        ...(operation.action === 'observe' ? { display: { sequence: 3, text: 'private-result', inputOpen: false } } : {}) };
    },
  } });
  const render = async (active: boolean) => act(async () => root.render(createElement(LocaleProvider, { locale: 'en', children:
    createElement(WorkbarServicesProvider, { services }, createElement(TerminalHandoffPanel, {
      sessionId: desktopSessionKey({ hostId: 'host-1', sessionId: 'session-1' }), active,
      request: { requestId: 'request-1', ref: 'terminal-1', message: 'Authenticate', command: 'sh' },
    })),
  })));
  await render(true);
  assert.match(container.textContent, /private-result/);
  await render(false);
  assert.doesNotMatch(container.textContent, /private-result/);
  await render(true);
  assert.match(container.textContent, /private-result/);
  const share = descendants(container).find((node) => node.tagName === 'BUTTON' && node.textContent === 'Share selected text with the agent');
  assert.ok(share);
  assert.equal(share.getAttribute('disabled'), null);
  assert.deepEqual(operations, ['surface', 'ready', 'observe', 'release', 'surface', 'ready', 'observe']);
});
