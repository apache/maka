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

import type { AgentPreviewPage } from '../../../../packages/plugin-sdk/src/index.js';
import type { Row } from './history';
import type { ToolActivity } from './toolActivity';

type Cut = Extract<AgentPreviewPage, { kind: 'cut' }>;
type Body = { text: string; bytes: number };

/** One current attempt; page offsets are UTF-8 bytes, never event cursors. */
export class Preview {
  private identity = '';
  private stepOrder = 0;
  private revision = -1;
  private bodies = new Map<string, Body>();
  private committed = new Set<string>();
  private retiredTools = new Set<string>();
  private closedSteps = new Set<string>();

  commit(invocationId: string, stepId: string, messageId?: string) {
    const step = `${invocationId}/${stepId}`;
    if (messageId === undefined) {
      this.closedSteps.add(step);
      if (this.identity.endsWith(`/${step}`)) this.bodies.clear();
    } else {
      this.committed.add(`${step}/${messageId}`);
      if (this.identity.endsWith(`/${step}`))
        for (const key of this.bodies.keys())
          if (key.startsWith(`${messageId}/`)) this.bodies.delete(key);
    }
  }

  retireTool(invocationId: string, stepId: string, toolUseId: string) {
    this.retiredTools.add(`${invocationId}/${stepId}/${toolUseId}`);
  }

  page(
    page: AgentPreviewPage,
    rows: Row[],
    tools: ToolActivity[],
    canonical: ReadonlyMap<string, Row>,
  ) {
    if (page.kind === 'empty') {
      this.identity = '';
      this.bodies.clear();
      this.committed.clear();
      this.closedSteps.clear();
      this.retiredTools.clear();
      return {
        rows: rows.filter((row) => !row.preview),
        tools: tools.filter((tool) => tool.previewOrder === undefined),
      };
    }
    const identity = `${page.hostEpoch}/${page.invocationId}/${page.stepId}`;
    if (identity !== this.identity) {
      this.identity = identity;
      this.stepOrder += 1;
      this.revision = -1;
      this.bodies.clear();
      const step = `${page.invocationId}/${page.stepId}/`;
      this.committed = new Set([...this.committed].filter((key) => key.startsWith(step)));
      this.retiredTools = new Set([...this.retiredTools].filter((key) => key.startsWith(step)));
      this.closedSteps = new Set([...this.closedSteps].filter((key) => `${key}/` === step));
    }
    if (
      this.closedSteps.has(`${page.invocationId}/${page.stepId}`) ||
      page.revision < this.revision
    )
      return { rows, tools };
    this.revision = page.revision;
    for (const part of page.parts) {
      if (this.committed.has(`${page.invocationId}/${page.stepId}/${part.messageId}`)) continue;
      const field =
        part.field.kind === 'text'
          ? part.field.textKind === 'thinking'
            ? 'thinking'
            : 'body'
          : 'tool_input';
      if (canonical.has(`${part.messageId}/${field}`)) continue;
      if (
        part.field.kind === 'tool_input' &&
        this.retiredTools.has(`${page.invocationId}/${page.stepId}/${part.field.toolUseId}`)
      )
        continue;
      const key = `${part.messageId}/${field}`;
      const previous = this.bodies.get(key);
      if (part.offset !== 0 && previous?.bytes !== part.offset)
        throw new Error('Preview body fragments are discontinuous');
      const body = {
        text: (part.offset === 0 ? '' : previous!.text) + part.text,
        bytes: part.offset + new TextEncoder().encode(part.text).byteLength,
      };
      if (body.bytes > part.totalBytes) throw new Error('Preview body exceeds its declared size');
      this.bodies.set(key, body);
      if (part.field.kind === 'tool_input') {
        body.text = Array.from(body.text).slice(-2048).join('');
        tools = this.tool(page, part.field, body.text, tools);
        continue;
      }
      if (part.ordinal == null) throw new Error('Text preview has no ordinal');
      const row: Row = {
        key: `live/${key}`,
        messageId: part.messageId,
        field,
        role: field === 'thinking' ? 'thinking' : 'assistant',
        invocationId: page.invocationId,
        stepId: page.stepId,
        turnId: page.turnId,
        timestamp: part.startedAt,
        text: body.text,
        totalBytes: part.totalBytes,
        prefix: true,
        modelPart: { stepId: page.stepId, ordinal: part.ordinal },
        preview: { stepOrder: this.stepOrder, ordinal: part.ordinal, revision: page.revision },
        closedAt: null,
      };
      const index = rows.findIndex((previous) => previous.key === row.key);
      rows = index < 0 ? [...rows, row] : rows.map((previous, i) => (i === index ? row : previous));
    }
    return { rows, tools };
  }

  private tool(
    page: Cut,
    field: Extract<Cut['parts'][number]['field'], { kind: 'tool_input' }>,
    text: string,
    tools: ToolActivity[],
  ) {
    const previous = tools.find(
      (tool) => tool.invocationId === page.invocationId && tool.toolUseId === field.toolUseId,
    );
    // A complete/dispatched canonical call owns its display after admission.
    if (previous?.inputReady || previous?.phase === 'running') return tools;
    const next: ToolActivity = {
      invocationId: page.invocationId,
      turnId: page.turnId,
      stepId: page.stepId,
      toolUseId: field.toolUseId,
      name: field.name,
      source: field.providerExecuted ? 'provider' : 'native',
      phase: 'preparing',
      inputReady: false,
      detail: Array.from(text).slice(-2048).join(''),
      previewOrder: this.stepOrder,
    };
    return previous ? tools.map((tool) => (tool === previous ? next : tool)) : [...tools, next];
  }
}
