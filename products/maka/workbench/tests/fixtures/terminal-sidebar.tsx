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

import { keymap, mount, signal, Text, View, type JSX } from 'nsh';
import { createResources } from '../../../../../plugins/workspace/workspace-files/ui/resources';
import { ResourcePane } from '../../../../../plugins/workspace/workspace-files/ui/ResourcePane';
import { HostProvider, type Host } from '../../app/host';
import { ToolCard } from '../../app/ToolCard';
import { viewRuntimeContext } from '../../app/plugins/viewContext';
import type { UiRuntime } from '../../../../../packages/plugin-sdk/src/workbench';
import type { Row } from '../../app/history';
import type {
  ResourceUpdate,
  AgentHistorySourceRead,
  HistoryTool,
  TerminalOutputEvent,
} from '../../../../../packages/plugin-sdk/src/index.js';

const sessionId = 'workspace-session';
const cwd = '/work/maka';
const size = { cols: 80, rows: 24 };
const makeShell = (
  cmd: string,
  initiator: ResourceUpdate['initiator'],
  status: ResourceUpdate['result']['status'],
  startedAt: number,
): ResourceUpdate => ({
  sessionId,
  ownership: { kind: 'local' },
  correlation: {},
  visibility: 'model',
  initiator,
  result: {
    ref: cmd,
    kind: 'shell_run',
    mode: 'pty',
    status,
    cwd,
    cmd,
    startedAt,
    updatedAt: startedAt,
    revision: 1,
  },
});
const running = makeShell('cargo test', 'agent', 'running', 1);
const finished = makeShell('cargo fmt', 'agent', 'completed', 2);
const shells = [running, finished];
const position = {
  kind: 'live',
  sequence: 1,
  fact: '532f49ac-d198-470a-b046-c2e018bfa279',
  itemIndex: 0,
} as const;
const command: HistoryTool = {
  toolUseId: 'command',
  call: {
    name: 'Shell',
    title: null,
    origin: 'provider',
    ancestorToolUseIds: [],
    presentation: 'maka.workspace.Processes@1/execute',
    position,
    dispatched: true,
    pending: false,
  },
  result: {
    position: { ...position, sequence: 2 },
    settlement: 'returned',
    isError: false,
    image: false,
    images: 0,
  },
};
const toolRow: Row = {
  key: 'command',
  field: 'result',
  role: 'tool_result',
  text: '',
  tool: command,
};
const completed = <T,>(value: T) => ({ kind: 'completed' as const, value });
const recorded = JSON.stringify(completed(finished.result));
const ViewRuntime = viewRuntimeContext.Provider;
const runtime = { renderer: () => null } as unknown as UiRuntime<JSX.Element>;

const stream = (value: unknown) => {
  let sent = false;
  let end: ((value: null) => void) | undefined;
  return {
    next() {
      if (sent)
        return new Promise((resolve) => {
          end = resolve;
        });
      sent = true;
      return Promise.resolve(completed(value));
    },
    async close() {
      end?.(null);
    },
  };
};
const received = signal('');
let keyboardEvents = 0;
const error = signal('');
const host = {
  async query(
    service: string,
    method: string,
    input: AgentHistorySourceRead | { sessionId: string; ref: string },
  ) {
    if (
      service === 'agent' &&
      method === 'source' &&
      'field' in input &&
      input.sessionId === sessionId
    ) {
      const text = input.path
        ? JSON.stringify(input.path.at(-1) === 'status' ? 'completed' : 0)
        : recorded;
      return {
        kind: 'ready',
        through: 2,
        source: {
          position: command.result!.position,
          timestamp: null,
          role: 'tool_result',
          fields: ['result'],
          field: 'result',
          path: input.path,
          format: 'json',
          offset: 0,
          totalBytes: text.length,
          text,
          tool: command,
        },
      };
    }
    if (
      service === 'terminal' &&
      method === 'read' &&
      input.sessionId === sessionId &&
      'ref' in input &&
      input.ref === finished.result.ref
    )
      return completed(finished);
    throw new Error(`Unexpected query ${service}.${method}`);
  },
  async subscribe(service: string, method: string, input: any) {
    if (service !== 'terminal') throw new Error(`Unexpected subscription: ${service}.${method}`);
    if (method === 'watchList') return stream({ resources: [...shells] });
    if (method === 'acquire') {
      if (shells.some((shell) => shell.result.ref === input.ref && shell.initiator === 'agent'))
        throw new Error('Agent terminal must remain read-only');
      return stream({ held: true, controllerId: 'controller', nextSequence: 1 });
    }
    if (method === 'watchOutput') {
      const event: TerminalOutputEvent = {
        kind: input.target.ref === finished.result.ref ? 'closed' : 'pending',
        after: input.after,
        size,
        initialSize: size,
      };
      return stream(event);
    }
    throw new Error(`Unexpected subscription: ${service}.${method}`);
  },
  session() {
    return {
      sessionId,
      pendingTerminals: async () => [],
      async terminal(method: string, input: any) {
        let value;
        switch (method) {
          case 'start': {
            const shell = makeShell(
              `shell-${shells.length - 1}`,
              'user',
              'running',
              shells.length + 1,
            );
            shells.push(shell);
            value = shell;
            break;
          }
          case 'stop': {
            if (input.sessionId !== sessionId || input.ref !== running.result.ref)
              throw new Error('Unexpected stop target');
            value = {
              applied: true,
              resource: { ...running, result: { ...running.result, status: 'cancelled' } },
            };
            break;
          }
          case 'control': {
            const ref = input.controller.target.ref;
            for (const action of input.actions) {
              if (action.type === 'key' && action.key === 'enter')
                received.set(`${++keyboardEvents}: Enter reached ${ref}`);
              if (action.type === 'key' && action.key === 'c' && action.modifiers?.includes('ctrl'))
                received.set(`Interrupt reached ${ref}`);
              if (action.type === 'paste') received.set(`Pasted into ${ref}: ${action.text}`);
            }
            value = { sequence: input.sequence };
            break;
          }
          case 'release':
            value = {};
            break;
          default:
            throw new Error(`Unexpected mutation: ${method}`);
        }
        return {
          reply: {
            receipt: {
              kind: 'recorded',
              outcome: { kind: 'returned', result: { value: completed(value) } },
            },
          },
        };
      },
    };
  },
} as unknown as Host;

function Fixture() {
  keymap.bind('ctrl+c', () => received.set('Workbench interrupt'), { when: 'always' });
  const resources = createResources(host, {
    sessions: () => [sessionId],
    blocked: () => false,
    directory: () => cwd,
    report: (reason) => error.set(String(reason)),
  });
  return (
    <HostProvider value={host}>
      <View style={{ width: '100%', height: '100%', gap: 4 }}>
        <If when={!resources.shown()}>
          <ViewRuntime value={runtime}>
            <ToolCard
              row={() => toolRow}
              sessionId={sessionId}
              ownerKey={() => toolRow.key}
              through={() => 2}
              expanded={() => true}
              original={() => false}
              maxHeight={() => 240}
              expand={() => {}}
              showOriginal={() => {}}
              openLink={async () => {}}
              previewImage={() => {}}
              previewTerminal={(ref, restoreFocus) =>
                void resources.openAgentTerminal({ sessionId, ref }, restoreFocus)
              }
              userScroll={() => {}}
            />
          </ViewRuntime>
        </If>
        <If when={error() || received()}>
          <Text>{error() || received()}</Text>
        </If>
        <Each of={resources.shown() ? [resources.instance()] : []} key={(value) => value}>
          {() => <ResourcePane resources={resources} docked={false} />}
        </Each>
      </View>
    </HostProvider>
  );
}

mount(Fixture);
