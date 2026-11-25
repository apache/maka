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

import { mount, Text, View, type JSX } from 'nsh';
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

const sessionId = 'number-formatting';
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

const readTool = makeTool('read-large', 'Read', 'maka.workspace.Files@1/read', 1, 2);
const editRangeTool = makeTool('edit-range', 'Edit', 'maka.workspace.Files@1/edit', 3, 4);
const editSingleTool = makeTool('edit-single', 'Edit', 'maka.workspace.Files@1/edit', 5, 6);

const sources: Record<
  string,
  {
    tool: HistoryTool;
    role: 'tool_call' | 'tool_result';
    text: string;
  }
> = {
  '1:arguments': {
    tool: readTool,
    role: 'tool_call',
    text: JSON.stringify({ path: 'src/large.ts' }),
  },
  '2:result': {
    tool: readTool,
    role: 'tool_result',
    text: JSON.stringify({
      kind: 'completed',
      value: {
        content: 'const first = 1234;\nconst second = 1235;\n',
        offset: 1233,
        returnedLines: 2,
        totalLines: 12345,
      },
    }),
  },
  '3:arguments': {
    tool: editRangeTool,
    role: 'tool_call',
    text: JSON.stringify({
      path: 'src/large.ts',
      old_string: 'old',
      new_string: 'new',
    }),
  },
  '4:result': {
    tool: editRangeTool,
    role: 'tool_result',
    text: JSON.stringify({
      kind: 'completed',
      value: {
        ok: true,
        path: 'src/large.ts',
        replacements: 1234,
        startLine: 1234,
        endLine: 1235,
      },
    }),
  },
  '5:arguments': {
    tool: editSingleTool,
    role: 'tool_call',
    text: JSON.stringify({
      path: 'src/large.ts',
      old_string: 'a',
      new_string: 'b',
    }),
  },
  '6:result': {
    tool: editSingleTool,
    role: 'tool_result',
    text: JSON.stringify({
      kind: 'completed',
      value: {
        ok: true,
        path: 'src/large.ts',
        replacements: 1,
        startLine: 1234,
        endLine: 1234,
      },
    }),
  },
};

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
    const entry = sources[key];
    if (!entry || !target) throw new Error(`Missing fixture source ${key}`);
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
        format: 'json',
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

mount(() => {
  installWorkbenchLocaleCatalog();
  return (
    <HostProvider value={host}>
      <ViewRuntime value={runtime}>
        <View style={{ width: '100%', height: '100%', padding: 16, gap: 16 }}>
          <Button accessibilityLabel="Switch to German" onPress={() => currentLocale.set('de')}>
            <Text>Switch to German</Text>
          </Button>
          {[readTool, editRangeTool, editSingleTool].map((tool) => (
            <ToolCard
              row={() => row(tool)}
              sessionId={sessionId}
              ownerKey={() => tool.toolUseId}
              through={() => through}
              expanded={() => true}
              original={() => false}
              maxHeight={() => 400}
              expand={() => {}}
              showOriginal={() => {}}
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
              pathLabel: 'src/large.ts',
              side: 'new',
              startLine: 1233,
              endLine: 1234,
              realStartLine: 1234,
              realEndLine: 1235,
              excerpt: '',
              comment: 'Check range',
            }}
            canPrompt={false}
            onEdit={() => {}}
            onRemove={() => {}}
            onSendNow={() => {}}
          />
          <InlineReviewNoteCard
            note={{
              id: 'note-single',
              sessionId,
              path: { bytesBase64: '' },
              pathLabel: 'src/large.ts',
              side: 'new',
              startLine: 1233,
              endLine: 1233,
              excerpt: '',
              comment: 'Check line',
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
