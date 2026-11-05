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

import type {
  AgentDelivery,
  AgentObservation,
  AgentPreviewPage,
} from '../../../../packages/plugin-sdk/src/index.js';
import type { Row } from './history';
import { updateToolActivity, type ToolActivity } from './toolActivity.ts';

type Cut = Extract<AgentPreviewPage, { kind: 'cut' }>;
type Body = { text: string; bytes: number };

export type LivePart = {
  invocationId: string;
  stepId: string;
  partId: string;
  messageId: string;
  field: 'thinking' | 'body';
  startSequence: number;
};
type LiveRow = Row & { invocationId: string; stepId: string; closedAt: number | null };
type Overlay = { rows: LiveRow[]; tools: ToolActivity[]; parts: LivePart[] };

/** Byte assembly for one attempt; display lifetime belongs to TranscriptOverlay. */
class PreviewAssembly {
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
    rows: LiveRow[],
    tools: ToolActivity[],
    canonical: ReadonlyMap<string, Row>,
  ) {
    if (page.kind === 'empty') {
      // Producer retirement is not the history handoff of its displayed fragments.
      this.identity = '';
      this.bodies.clear();
      this.committed.clear();
      this.closedSteps.clear();
      this.retiredTools.clear();
      return {
        rows,
        tools,
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
        tools = this.tool(page, part.field, body.text, tools);
        continue;
      }
      if (part.ordinal == null) throw new Error('Text preview has no ordinal');
      const row: LiveRow = {
        key: `live/${key}`,
        messageId: part.messageId,
        field,
        role: field === 'thinking' ? 'thinking' : 'assistant',
        invocationId: page.invocationId,
        stepId: page.stepId,
        turnId: page.turnId,
        timestamp: part.startedAt,
        startSequence:
          rows.find((row) => row.key === `live/${key}`)?.startSequence ?? page.dependsOn,
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
      startSequence: previous?.startSequence ?? page.dependsOn,
      inputReady: false,
      detail: text,
      previewOrder: this.stepOrder,
    };
    return previous ? tools.map((tool) => (tool === previous ? next : tool)) : [...tools, next];
  }
}

/** A committed fragment stays visible until the history window has taken it over. */
export class TranscriptOverlay {
  private assembly = new PreviewAssembly();
  private rows: LiveRow[] = [];
  private tools: ToolActivity[] = [];
  private parts: LivePart[] = [];
  private canonical: ReadonlyMap<string, Row> = new Map();
  private tailThrough: number | null = 0;
  private observedThrough = 0;
  private activeInvocation: string | null | undefined;

  snapshot(): Overlay {
    return { rows: this.rows, tools: this.tools, parts: this.parts };
  }

  history(canonical: ReadonlyMap<string, Row>, tailThrough: number | null) {
    this.canonical = canonical;
    // Off-tail windows do not display overlays, so terminal rows need no retention there.
    this.tailThrough = tailThrough === null ? null : Math.max(this.tailThrough ?? 0, tailThrough);
    for (const row of this.rows)
      if (canonical.has(`${row.messageId}/${row.field}`))
        this.assembly.commit(row.invocationId, row.stepId, row.messageId);
    this.retireCovered();
  }

  observe(observed: Pick<AgentObservation, 'through' | 'run' | 'parts'>) {
    if (observed.through < this.observedThrough) return;
    this.observedThrough = observed.through;
    const run = observed.run;
    this.activeInvocation = run?.invocationId ?? null;
    // Reconnect starts after this snapshot: terminal facts while offline are not replayed.
    const openMessages = new Set(observed.parts.map((part) => part.messageId));
    this.close(
      observed.through,
      (row) =>
        row.invocationId !== this.activeInvocation ||
        (!row.preview && !openMessages.has(row.messageId)),
    );
    this.tools = this.tools.filter((tool) => tool.invocationId === this.activeInvocation);
    this.parts = run
      ? observed.parts.map((part) => ({
          ...part,
          invocationId: run.invocationId,
          field: part.textKind === 'thinking' ? 'thinking' : 'body',
        }))
      : [];
    this.retireCovered();
  }

  page(page: AgentPreviewPage) {
    if (page.kind === 'cut') {
      if (this.activeInvocation !== undefined && page.invocationId !== this.activeInvocation)
        return;
      this.close(
        page.dependsOn,
        (row) =>
          Boolean(row.preview) &&
          (row.invocationId !== page.invocationId || row.stepId !== page.stepId),
      );
      this.tools = this.tools.filter(
        (tool) =>
          tool.previewOrder === undefined ||
          (tool.invocationId === page.invocationId && tool.stepId === page.stepId),
      );
      this.retireCovered();
    }
    const next = this.assembly.page(page, this.rows, this.tools, this.canonical);
    this.rows = next.rows;
    this.tools = next.tools;
  }

  event(event: AgentDelivery) {
    const { fact, invocationId, sequence } = event;
    if (
      this.activeInvocation !== undefined &&
      invocationId !== this.activeInvocation &&
      (fact.kind !== 'opened' || sequence <= this.observedThrough)
    )
      return;
    this.tools = updateToolActivity(this.tools, event);
    switch (fact.kind) {
      case 'opened':
        if (sequence >= this.observedThrough) {
          this.activeInvocation = invocationId;
          this.close(sequence, (row) => row.invocationId !== invocationId);
          this.tools = this.tools.filter((tool) => tool.invocationId === invocationId);
        }
        break;
      case 'executor_message_started':
        this.parts = [
          ...this.parts.filter(
            (part) => part.invocationId !== invocationId || part.messageId !== fact.messageId,
          ),
          ...(['body', 'thinking'] as const).map((field) => ({
            invocationId,
            stepId: fact.messageId,
            partId: field === 'body' ? 'text' : 'thinking',
            messageId: fact.messageId,
            field,
            startSequence: sequence,
          })),
        ];
        break;
      case 'delta': {
        const part = this.parts.find(
          (part) =>
            part.invocationId === invocationId &&
            part.stepId === fact.stepId &&
            part.partId === fact.partId,
        );
        if (!part || this.canonical.has(`${part.messageId}/${part.field}`)) break;
        const key = `live/${part.messageId}/${part.field}`;
        const previous = this.rows.find((row) => row.key === key);
        if (previous?.sequence !== undefined && sequence <= previous.sequence) break;
        const row: LiveRow = {
          ...part,
          key,
          role: part.field === 'thinking' ? 'thinking' : 'assistant',
          turnId: event.turnId,
          text: (previous?.text ?? '') + fact.text,
          prefix: true,
          sequence,
          closedAt: null,
        };
        this.rows = previous
          ? this.rows.map((old) => (old === previous ? row : old))
          : [...this.rows, row];
        break;
      }
      case 'part_committed':
        this.assembly.commit(invocationId, fact.stepId, fact.messageId);
        this.parts = this.parts.filter(
          (part) =>
            part.invocationId !== invocationId ||
            part.stepId !== fact.stepId ||
            part.messageId !== fact.messageId,
        );
        this.close(
          sequence,
          (row) =>
            row.invocationId === invocationId &&
            row.stepId === fact.stepId &&
            row.messageId === fact.messageId,
        );
        break;
      case 'tool_input_ready':
        this.assembly.retireTool(invocationId, fact.stepId, fact.toolUseId);
        break;
      case 'step_ended':
        this.assembly.commit(invocationId, fact.stepId);
        this.close(
          sequence,
          (row) => row.invocationId === invocationId && row.stepId === fact.stepId,
        );
        this.parts = this.parts.filter(
          (part) => part.invocationId !== invocationId || part.stepId !== fact.stepId,
        );
        break;
      case 'ended':
        if (sequence >= this.observedThrough) this.activeInvocation = null;
        this.close(sequence, (row) => row.invocationId === invocationId);
        this.parts = this.parts.filter((part) => part.invocationId !== invocationId);
        break;
    }
    this.observedThrough = Math.max(this.observedThrough, sequence);
    this.retireCovered();
  }

  disconnect() {
    this.tools = [];
  }

  private close(sequence: number, matches: (row: LiveRow) => boolean) {
    this.rows = this.rows.map((row) =>
      row.closedAt === null && matches(row) ? { ...row, closedAt: sequence } : row,
    );
  }

  private retireCovered() {
    const rows = this.rows.filter(
      (row) =>
        !this.canonical.has(`${row.messageId}/${row.field}`) &&
        (row.closedAt === null ||
          (this.tailThrough !== null && (!row.preview || row.closedAt > this.tailThrough))),
    );
    if (rows.length !== this.rows.length) this.rows = rows;
  }
}
