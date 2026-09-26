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
import { LocaleProvider } from '@maka/ui';
import { terminalFeedback, isValidPrivateTerminalInput, TerminalHandoffPanel, createFakeWorkbarServices, WorkbarServicesProvider } from '../../renderer/features/workbar/testing.js';
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
  assert.equal(descendants(container).some((node) => node.tagName === 'BUTTON' && node.textContent === 'Let the agent continue'), false);
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
  for (const label of ['Submit', 'Let the agent continue']) {
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
    if (node.tagName === 'INPUT' || (node.tagName === 'BUTTON' && ['Submit', 'Let the agent continue'].includes(node.textContent))) {
      assert.notEqual(node.getAttribute('disabled'), null);
    }
  }
});

test('even a ready-looking generic terminal requires explicit user confirmation before Resume', async () => {
  const { root, container } = installReactRenderer();
  const services = createFakeWorkbarServices({ terminal: { ...createFakeWorkbarServices().terminal,
    handoff: async () => ({ status: 'ready', phase: 'human', nextSequence: 1, display: { sequence: 1, text: '$ ', inputOpen: true } }),
  } });
  await act(async () => root.render(createElement(LocaleProvider, { locale: 'en', children:
    createElement(WorkbarServicesProvider, { services }, createElement(TerminalHandoffPanel, {
      sessionId: desktopSessionKey({ hostId: 'host-1', sessionId: 'session-1' }), active: true,
      request: { requestId: 'request-1', ref: 'terminal-1', message: 'Authenticate', command: 'sh' },
    })),
  })));
  const button = descendants(container).find((node) => node.tagName === 'BUTTON' && node.textContent === 'Let the agent continue');
  assert.ok(button);
  assert.notEqual(button.getAttribute('disabled'), null);
  assert.match(container.textContent, /I checked the terminal/);
});
