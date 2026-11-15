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

import { cleanup, keymap, mount, signal, Text, View } from 'nsh';
import { currentLocale } from '../../app/locale';
import { HostProvider, type Host } from '../../app/host';
import { ModelSelect } from '../../app/ModelSelect';

import {
  sameRoute,
  type ModelBackend,
  type ModelChoice,
  type ModelDetails,
} from '../../app/modelSelection';
import { message } from '../../app/text';

const CHOICES: ModelChoice[] = [
  {
    label: 'Reasoning model',
    sourceName: 'OpenAI',
    selection: { kind: 'model', connectionId: 'openai', modelId: 'o4-mini', thinkingLevel: null },
    thinkingLevels: ['low', 'medium', 'high'],
    defaultThinkingLevel: 'medium',
  },
  {
    label: 'Plain model',
    sourceName: 'DeepSeek',
    selection: {
      kind: 'model',
      connectionId: 'deepseek',
      modelId: 'deepseek-chat',
      thinkingLevel: null,
    },
    thinkingLevels: [],
    defaultThinkingLevel: null,
  },
  {
    label: 'Claude Sonnet',
    sourceName: 'Claude Code',
    selection: {
      kind: 'executor',
      selection: {
        executor: 'external',
        settings: { runtime: 'claude-code', model: 'sonnet', thinkingLevel: null },
      },
    },
    thinkingLevels: ['low', 'high'],
    defaultThinkingLevel: null,
  },
];

mount(() => {
  currentLocale.set('en');
  const backend = signal<ModelBackend | null>(null);
  const instance = signal<number | null>(null);
  const managed = signal(0);
  let serial = 0;
  let holdSaves = false;
  let releaseSave: (() => void) | null = null;

  cleanup(
    keymap.bind(
      {
        f6: () => {
          holdSaves = true;
        },
        f7: () => {
          holdSaves = false;
          const finish = releaseSave;
          releaseSave = null;
          finish?.();
        },
      },
      { when: 'always' },
    ),
  );

  const details = (): ModelDetails => {
    const current = backend();
    if (!current) return { kind: 'unavailable', message: message('Choose model') };
    const found = CHOICES.find((item) => sameRoute(current, item.selection));
    return found
      ? { kind: 'ready', choice: found }
      : {
          kind: 'unavailable',
          message: message('The saved model policy is unavailable. Its selection is preserved.'),
        };
  };

  const host = {
    subscribe: async () => {
      let first = true;
      let closed: (() => void) | null = null;
      return {
        next: async () => {
          if (first) {
            first = false;
            return {
              kind: 'ready',
              revision: 'r1',
              choices: CHOICES,
              next: null,
              refreshing: false,
            };
          }
          await new Promise<void>((resolve) => {
            closed = resolve;
          });
          return null;
        },
        close: async () => {
          closed?.();
        },
      };
    },
    query: async (_endpoint: string, method: string, input: any) => {
      if (method === 'models') {
        const q = String(input?.query ?? '')
          .trim()
          .toLowerCase();
        const filtered = CHOICES.filter(
          (item) =>
            !q || item.label.toLowerCase().includes(q) || item.sourceName.toLowerCase().includes(q),
        );
        return { kind: 'ready', revision: 'r1', next: null, choices: filtered, refreshing: false };
      }
      throw new Error(method);
    },
  } as unknown as Host;

  return (
    <HostProvider value={host}>
      <View style={{ flex: 1, justifyContent: 'flex-end', padding: 16, gap: 8 }}>
        <Text>{managed() > 0 ? `Managed:${managed()}` : 'Idle'}</Text>
        <ModelSelect
          owner={{
            sessionId: 's1',
            backend,
            modelDetails: details,
            refreshModel: async () => {},
          }}
          instance={instance}
          current={() => true}
          toggle={() => instance.set(instance() === null ? ++serial : null)}
          close={(expected) => {
            if (instance() !== expected) return false;
            instance.set(null);
            return true;
          }}
          select={async (_expected, next) => {
            if (holdSaves) {
              await new Promise<void>((resolve) => {
                releaseSave = resolve;
              });
            }
            backend.set(next);
          }}
          manage={({ instance: expected }) => {
            if (instance() !== expected) return;
            instance.set(null);
            managed.set(managed() + 1);
          }}
        />
      </View>
    </HostProvider>
  );
});
