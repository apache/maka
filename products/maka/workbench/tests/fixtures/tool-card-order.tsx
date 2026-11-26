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

import { mount, signal, Text, View, type JSX } from 'nsh';
import { Button } from 'nsh/base';
import type {
  AgentHistorySourcePage,
  AgentHistorySourceRead,
  HistoryTool,
} from '../../../../../packages/plugin-sdk/src/index.js';
import type { UiRuntime } from '../../../../../packages/plugin-sdk/src/workbench';
import type { Row } from '../../app/history';
import { HostProvider, type Host } from '../../app/host';
import { currentLocale } from '../../app/locale';
import { installWorkbenchLocaleCatalog } from '../../app/localeCatalog';
import { viewRuntimeContext } from '../../app/plugins/viewContext';
import { InlineReviewNoteCard } from '../../app/ReviewComposer';
import { ToolCard } from '../../app/ToolCard';

const sessionId = 'tool-card-order';
const through = 10;
const pos = (sequence: number) => ({
  kind: 'live' as const,
  sequence,
  fact: `fact-${sequence}`,
  itemIndex: 0,
});

const makeTool = (
  id: string,
  name: string,
  presentation: string,
  callSeq: number,
  resSeq: number,
): HistoryTool => ({
  toolUseId: id,
  call: {
    ancestorToolUseIds: [],
    origin: 'provider',
    presentation,
    position: pos(callSeq),
    name,
    title: null,
    pending: false,
    dispatched: true,
  },
  result: {
    position: pos(resSeq),
    settlement: 'returned',
    isError: false,
    image: false,
    images: 0,
  },
});

const scriptTool = makeTool('script', 'exec', 'maka.agent.Builtin@1/exec', 1, 2);
const readTool = makeTool('read', 'Read', 'maka.workspace.Files@1/read', 3, 4);
const editTool = makeTool('edit', 'Edit', 'maka.workspace.Files@1/edit', 5, 6);
const failingReadTool = makeTool('read-fail', 'Read', 'maka.workspace.Files@1/read', 7, 8);

const scriptCode = Array.from({ length: 10 }, (_, i) => `const line${i + 1} = ${i + 1};`).join(
  '\n',
);
const longTail = `${'a'.repeat(730)}TAIL`;
const scriptResult =
  JSON.stringify({ state: 'completed', cell_id: 'cell-1', result: { ok: true, value: null } }) +
  `\n{"kind":"changed","long":"${longTail}"}`;

const sources: Record<
  string,
  {
    tool: HistoryTool;
    format: 'json' | 'text';
    text: string;
    role: 'tool_call' | 'tool_result';
    fail?: string;
  }
> = {
  '1:arguments': {
    tool: scriptTool,
    format: 'json',
    text: JSON.stringify({ code: scriptCode }),
    role: 'tool_call',
  },
  '2:result': {
    tool: scriptTool,
    format: 'text',
    text: scriptResult,
    role: 'tool_result',
  },
  '3:arguments': {
    tool: readTool,
    format: 'json',
    text: JSON.stringify({ path: 'src/ToolCard.tsx' }),
    role: 'tool_call',
  },
  '4:result': {
    tool: readTool,
    format: 'json',
    text: JSON.stringify({
      kind: 'completed',
      value: {
        content: 'const a = 1;\nconst b = 2;\n',
        offset: 1233,
        returnedLines: 2,
        totalLines: 12345,
      },
    }),
    role: 'tool_result',
  },
  '5:arguments': {
    tool: editTool,
    format: 'json',
    text: JSON.stringify({
      path: 'src/ToolCard.tsx',
      old_string: 'result',
      new_string: 'arguments',
    }),
    role: 'tool_call',
  },
  '6:result': {
    tool: editTool,
    format: 'json',
    text: JSON.stringify({
      kind: 'completed',
      value: {
        ok: true,
        path: 'src/ToolCard.tsx',
        replacements: 1234,
        startLine: 1234,
        endLine: 1234,
      },
    }),
    role: 'tool_result',
  },
  '7:arguments': {
    tool: failingReadTool,
    format: 'json',
    text: '',
    role: 'tool_call',
    fail: 'read arguments timed out',
  },
  '8:result': {
    tool: failingReadTool,
    format: 'json',
    text: JSON.stringify({
      kind: 'completed',
      value: { content: 'fallback body\n', offset: 0, returnedLines: 1, totalLines: 1 },
    }),
    role: 'tool_result',
  },
};

const readResultFetches = signal(0);

const host = {
  async query(
    endpoint: string,
    method: string,
    input: AgentHistorySourceRead,
  ): Promise<AgentHistorySourcePage> {
    if (endpoint !== 'agent' || method !== 'source') throw new Error('Unexpected query');
    const target = input.source.kind === 'row' ? input.source.position : null;
    const seq = target?.kind === 'live' ? target.sequence : -1;
    const key = `${seq}:${input.field}`;
    if (key === '4:result') readResultFetches.set(readResultFetches() + 1);
    const entry = sources[key];
    if (!entry || !target) throw new Error(`Missing fixture source ${key}`);
    if (entry.fail) throw new Error(entry.fail);
    const bytes = new TextEncoder().encode(entry.text).byteLength;
    return {
      kind: 'ready',
      through,
      source: {
        position: target,
        timestamp: null,
        role: entry.role,
        fields: [input.field],
        field: input.field,
        format: entry.format,
        offset: 0,
        totalBytes: bytes,
        text: entry.text,
        tool: entry.tool,
      },
    };
  },
} as unknown as Host;

const row = (tool: HistoryTool): Row => ({
  key: tool.toolUseId,
  field: 'result',
  role: 'tool_result',
  text: '',
  tool,
});

const ViewRuntime = viewRuntimeContext.Provider;
const runtime = { renderer: () => null } as unknown as UiRuntime<JSX.Element>;
const readOriginal = signal(false);

mount(() => {
  installWorkbenchLocaleCatalog();
  return (
    <HostProvider value={host}>
      <ViewRuntime value={runtime}>
        <View style={{ width: '100%', height: '100%', padding: 16, gap: 16 }}>
          <Text>{`read-result-fetches:${readResultFetches()}`}</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button
              accessibilityLabel="Toggle read original"
              onPress={() => readOriginal.set(!readOriginal())}
            >
              <Text>Toggle read original</Text>
            </Button>
            <Button accessibilityLabel="Switch to German" onPress={() => currentLocale.set('de')}>
              <Text>Switch to German</Text>
            </Button>
          </View>
          {[scriptTool, readTool, editTool, failingReadTool].map((tool) => (
            <ToolCard
              row={() => row(tool)}
              sessionId={sessionId}
              ownerKey={() => tool.toolUseId}
              through={() => through}
              expanded={() => true}
              original={() => (tool.toolUseId === 'read' ? readOriginal() : false)}
              maxHeight={() => 400}
              expand={() => {}}
              showOriginal={() => {
                if (tool.toolUseId === 'read') readOriginal.set(!readOriginal());
              }}
              openLink={async () => {}}
              previewImage={() => {}}
              userScroll={() => {}}
            />
          ))}
          <InlineReviewNoteCard
            note={{
              id: 'note-range',
              sessionId,
              path: { bytesBase64: '' },
              pathLabel: 'src/ToolCard.tsx',
              side: 'new',
              startLine: 1233,
              endLine: 1234,
              realStartLine: 1234,
              realEndLine: 1235,
              excerpt: '',
              comment: 'Review note',
            }}
            canPrompt={false}
            onEdit={() => {}}
            onRemove={() => {}}
            onSendNow={() => {}}
          />
        </View>
      </ViewRuntime>
    </HostProvider>
  );
});
