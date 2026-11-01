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
import { MessageRow } from '../../../workbench/app/MessageRow';
import { HostProvider, type Host } from '../../../workbench/app/host';
import type { Row } from '../../../workbench/app/history';
import { C } from '../../../workbench/app/ui';

const examples = [
  {
    title: 'Read project instructions',
    settlement: 'returned',
    dispatched: true,
    presentation: 'maka.workspace.Files@1/readText',
  },
  { title: 'Locate relevant files', settlement: 'returned', dispatched: true },
  { title: 'Open the browser tab', settlement: 'unknown', dispatched: true },
  { title: 'Run the type checks', settlement: 'failed', dispatched: true },
  { title: 'Write the protected file', settlement: 'rejected', dispatched: true },
  { title: 'Inspect the worker progress', settlement: null, dispatched: true },
  { title: 'Prepare the patch', settlement: null, dispatched: false },
  { title: 'Run the focused tests', settlement: null, dispatched: true, progress: 'running' },
] as const;

const tools: Row[] = examples.map((item, index) => ({
  key: `tool-${index}`,
  messageId: `tool-${index}`,
  field: 'body',
  role: 'tool_call',
  text: '',
  tool: {
    toolUseId: `tool-${index}`,
    call: {
      position: { sourceSequence: index, itemIndex: 0 },
      name: `tool-${index}`,
      title: { fallback: item.title },
      presentation: 'presentation' in item ? item.presentation : null,
      ancestorToolUseIds: [],
      pending: item.settlement === null,
      dispatched: item.dispatched,
    },
    result:
      item.settlement === null
        ? null
        : {
            settlement: item.settlement,
            position: { sourceSequence: index, itemIndex: 1 },
            isError: item.settlement !== 'returned',
            image: false,
          },
  },
}));

// The immutable result boundary is controlled; all rendering and status resolution are production UI.
const host = {
  async query(_endpoint: string, method: string, input: any) {
    if (method !== 'source') throw new Error(`Unexpected fixture query: ${method}`);
    const row = tools[input.source.position.sourceSequence]!;
    return {
      kind: 'ready',
      through: 10,
      source: {
        field: input.field,
        path: input.path,
        position: input.source.position,
        role: 'tool_result',
        format: 'text',
        offset: 0,
        totalBytes: 9,
        text: 'completed',
        tool: row.tool,
      },
    };
  },
} as Host;

mount(() => (
  <HostProvider value={host}>
    <View style={{ flex: 1, backgroundColor: C.background, padding: 48, alignItems: 'center' }}>
      <View style={{ width: '100%', maxWidth: 900, gap: 12 }}>
        <MessageRow
          item={() => ({
            key: 'user',
            messageId: 'user',
            field: 'body',
            role: 'user',
            text: 'Check the browser connection and verify the fix.',
            prefix: true,
          })}
          sessionId="activity-preview"
          through={() => 10}
          previewImage={() => {}}
          openLink={async () => {}}
          userScroll={() => {}}
          toolMaxHeight={() => 300}
        />
        <MessageRow
          item={() => ({
            key: 'thinking',
            messageId: 'thinking',
            field: 'thinking',
            role: 'assistant',
            text: '**Check browser connection**\n\n**Inspect worker progress**\n\n**Verify the fix**',
            prefix: true,
          })}
          sessionId="activity-preview"
          through={() => 10}
          previewImage={() => {}}
          openLink={async () => {}}
          userScroll={() => {}}
          toolMaxHeight={() => 300}
        />
        <Each of={tools}>
          {(row, index) => (
            <MessageRow
              item={row}
              toolProgress={() => ('progress' in examples[index()]! ? 'running' : null)}
              sessionId="activity-preview"
              through={() => 10}
              previewImage={() => {}}
              openLink={async () => {}}
              userScroll={() => {}}
              toolMaxHeight={() => 300}
            />
          )}
        </Each>
      </View>
    </View>
  </HostProvider>
));
