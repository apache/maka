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

import { mount, View } from 'nsh';
import type {
  AgentHistorySourcePage,
  AgentHistorySourceRead,
  HistoryTool,
} from '../../../../../packages/plugin-sdk/src/index.js';
import { createToolSource, OriginalToolSource } from '../../app/ToolSource';
import type { Host } from '../../app/host';
import { installWorkbenchLocaleCatalog } from '../../app/localeCatalog';

const through = 20;
const position = {
  kind: 'live',
  sequence: 18,
  fact: '532f49ac-d198-470a-b046-c2e018bfa279',
  itemIndex: 0,
} as const;
const tool = {
  toolUseId: 'original-tool',
  call: {
    ancestorToolUseIds: [],
    origin: 'provider',
    presentation: 'maka.agent.Builtin@1/exec',
    position,
    name: 'exec',
    title: null,
    pending: false,
    dispatched: true,
  },
  result: null,
} satisfies HistoryTool;

const firstPage = "const word = '雪'; ";
const lastPage = 'text(word);';
function originalArguments(sessionId: string) {
  const query = async (
    endpoint: string,
    method: string,
    input: AgentHistorySourceRead,
  ): Promise<AgentHistorySourcePage> => {
    if (endpoint !== 'agent' || method !== 'source' || input.field !== 'arguments')
      throw new Error('Unexpected history query');
    if (input.position.kind !== 'start' && input.position.kind !== 'after')
      throw new Error('Unexpected history position');
    const offset = input.position.kind === 'start' ? 0 : input.position.offset;
    if (offset !== 0 && offset !== 20) throw new Error('Unexpected UTF-8 page offset');
    return {
      kind: 'ready',
      through,
      source: {
        position,
        timestamp: null,
        role: 'tool_call',
        fields: ['arguments'],
        field: 'arguments',
        format: 'text',
        offset,
        totalBytes: 31,
        text: offset === 0 ? firstPage : lastPage,
        tool: input.sessionId === 'mismatched' ? { ...tool, toolUseId: 'another-tool' } : tool,
      },
    };
  };
  return createToolSource(
    { query } as Host,
    {
      key: sessionId,
      field: 'arguments',
      position,
      toolUseId: tool.toolUseId,
      name: tool.call.name,
      presentation: tool.call.presentation,
      callPosition: position,
      resultPosition: null,
    },
    sessionId,
    through,
  );
}

mount(() => {
  installWorkbenchLocaleCatalog();
  return (
    <View>
      <OriginalToolSource source={originalArguments('session')} label="Original arguments" />
      <OriginalToolSource source={originalArguments('mismatched')} label="Mismatched tool" />
    </View>
  );
});
