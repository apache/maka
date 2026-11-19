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
  RunId,
  StepId,
  ModelAttemptId,
  AgentObservation,
  AgentPreviewPage,
} from '../../../../packages/plugin-sdk/src/index.js';
import { modelPartRowId, stableRowId, type Row } from './history.ts';
import { updateToolActivity, type ToolActivity } from './toolActivity.ts';

type Cut = Extract<AgentPreviewPage, { kind: 'cut' }>;
type Body = { text: string; bytes: number };

export type LivePart = {
  runId: RunId;
  stepId: StepId;
  attemptId: ModelAttemptId;
  partId: string;
  messageId: string;
  field: 'thinking' | 'body';
  startSequence: number;
};
type LiveRow = Row & {
  messageId: string;
  runId: RunId;
  stepId: StepId;
  attemptId: ModelAttemptId;
  startSequence: number;
  closedAt: number | null;
};
type Seat = {
  runId: RunId;
  stepId: StepId;
  attemptId: ModelAttemptId;
  startSequence: number;
  closedAt: number | null;
};
type Overlay = {
  rows: LiveRow[];
  tools: ToolActivity[];
  parts: LivePart[];
  closedStarts: number[];
};

/** Byte assembly for one attempt; display lifetime belongs to TranscriptOverlay. */
class PreviewAssembly {
  private identity = '';
  private stepOrder = 0;
  private revision = -1;
  private bodies = new Map<string, Body>();
  private committed = new Set<string>();
  private retiredTools = new Set<string>();
  private closedSteps = new Set<string>();

  commit(runId: RunId, stepId: StepId, attemptId: ModelAttemptId, ordinal?: number) {
    const step = `${runId}/${stepId}/${attemptId}`;
    if (ordinal === undefined) {
      this.closedSteps.add(step);
      if (this.identity.endsWith(`/${step}`)) this.bodies.clear();
    } else {
      const key = modelPartRowId({ stepId, attemptId, ordinal });
      this.committed.add(key);
      if (this.identity.endsWith(`/${step}`)) this.bodies.delete(key);
    }
  }

  retireTool(runId: RunId, stepId: StepId, attemptId: ModelAttemptId, toolUseId: string) {
    this.retiredTools.add(`${runId}/${stepId}/${attemptId}/${toolUseId}`);
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
    const identity = `${page.hostEpoch}/${page.runId}/${page.stepId}/${page.attemptId}`;
    if (identity !== this.identity) {
      this.identity = identity;
      this.stepOrder += 1;
      this.revision = -1;
      this.bodies.clear();
      const step = `${page.runId}/${page.stepId}/${page.attemptId}/`;
      const model = `model/${page.stepId}/${page.attemptId}/`;
      this.committed = new Set([...this.committed].filter((key) => key.startsWith(model)));
      this.retiredTools = new Set([...this.retiredTools].filter((key) => key.startsWith(step)));
      this.closedSteps = new Set([...this.closedSteps].filter((key) => `${key}/` === step));
    }
    if (
      this.closedSteps.has(`${page.runId}/${page.stepId}/${page.attemptId}`) ||
      page.revision < this.revision
    )
      return { rows, tools };
    this.revision = page.revision;
    for (const part of page.parts) {
      const modelPart =
        part.field.kind === 'text' && part.ordinal != null
          ? { stepId: page.stepId, attemptId: page.attemptId, ordinal: part.ordinal }
          : undefined;
      const key = modelPart ? modelPartRowId(modelPart) : `${part.messageId}/tool_input`;
      if (modelPart && (this.committed.has(key) || canonical.has(key))) continue;
      if (
        part.field.kind === 'tool_input' &&
        this.retiredTools.has(
          `${page.runId}/${page.stepId}/${page.attemptId}/${part.field.toolUseId}`,
        )
      )
        continue;
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
      if (!modelPart) throw new Error('Text preview has no ordinal');
      const field = part.field.textKind === 'thinking' ? 'thinking' : 'body';
      const row: LiveRow = {
        key: `live/${key}`,
        messageId: part.messageId,
        field,
        role: field === 'thinking' ? 'thinking' : 'assistant',
        runId: page.runId,
        stepId: page.stepId,
        attemptId: page.attemptId,
        turnId: page.turnId,
        timestamp: part.startedAt,
        startSequence:
          rows.find((row) => row.key === `live/${key}`)?.startSequence ?? page.dependsOn,
        text: body.text,
        totalBytes: part.totalBytes,
        prefix: true,
        modelPart,
        finalAnswer: part.field.finalAnswer,
        preview: { stepOrder: this.stepOrder, ordinal: modelPart.ordinal, revision: page.revision },
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
      (tool) => tool.runId === page.runId && tool.toolUseId === field.toolUseId,
    );
    // A complete/dispatched canonical call owns its display after admission.
    if (previous?.inputReady || previous?.phase === 'running') return tools;
    const next: ToolActivity = {
      runId: page.runId,
      turnId: page.turnId,
      stepId: page.stepId,
      attemptId: page.attemptId,
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
  private seats = new Map<string, Seat>();
  private canonical: ReadonlyMap<string, Row> = new Map();
  private tailThrough: number | null = 0;
  private observedThrough = 0;
  private activeRun: RunId | null | undefined;

  snapshot(): Overlay {
    const starts = new Set<number>();
    for (const row of this.rows)
      if (!row.preview && row.closedAt !== null) starts.add(row.startSequence);
    for (const seat of this.seats.values())
      if (seat.closedAt !== null) starts.add(seat.startSequence);
    // The event cursor can reach a preview's dependency before history has rendered it.
    const through = this.tailThrough;
    const loaded = (sequence: number) => through !== null && sequence <= through;
    return {
      rows: this.rows.filter((row) => !row.preview || loaded(row.startSequence)),
      tools: this.tools.filter(
        (tool) => tool.previewOrder === undefined || loaded(tool.startSequence),
      ),
      parts: this.parts,
      closedStarts: [...starts],
    };
  }

  history(
    canonical: ReadonlyMap<string, Row>,
    tailThrough: number | null,
    coveredFrom?: number,
    windowStart?: number,
  ) {
    this.canonical = canonical;
    // Off-tail windows do not display overlays, so terminal rows need no retention there.
    this.tailThrough = tailThrough === null ? null : Math.max(this.tailThrough ?? 0, tailThrough);
    for (const row of this.rows)
      if (row.modelPart && canonical.has(stableRowId(row)))
        this.assembly.commit(row.runId, row.stepId, row.attemptId, row.modelPart.ordinal);
    this.retireCovered(coveredFrom, windowStart);
  }

  observe(observed: Pick<AgentObservation, 'through' | 'run' | 'parts'>) {
    if (observed.through < this.observedThrough) return;
    this.observedThrough = observed.through;
    const run = observed.run;
    this.activeRun = run?.runId ?? null;
    // Reconnect starts after this snapshot: terminal facts while offline are not replayed.
    const openMessages = new Set(observed.parts.map((part) => part.messageId));
    this.close(
      observed.through,
      (row) => row.runId !== this.activeRun || (!row.preview && !openMessages.has(row.messageId)),
    );
    for (const [messageId, seat] of this.seats)
      if (seat.closedAt === null && (seat.runId !== this.activeRun || !openMessages.has(messageId)))
        this.seats.set(messageId, { ...seat, closedAt: observed.through });
    if (run)
      for (const part of observed.parts)
        if (!this.seats.has(part.messageId))
          this.seats.set(part.messageId, {
            runId: run.runId,
            stepId: part.stepId,
            attemptId: part.attemptId,
            startSequence: part.startSequence,
            closedAt: null,
          });
    this.tools = this.tools.filter((tool) => tool.runId === this.activeRun);
    this.parts = run
      ? observed.parts.map((part) => ({
          ...part,
          runId: run.runId,
          field: part.textKind === 'thinking' ? 'thinking' : 'body',
        }))
      : [];
    this.retireCovered();
  }

  page(page: AgentPreviewPage) {
    if (page.kind === 'cut') {
      if (this.activeRun !== undefined && page.runId !== this.activeRun) return;
      this.close(
        page.dependsOn,
        (row) =>
          Boolean(row.preview) &&
          (row.runId !== page.runId ||
            row.stepId !== page.stepId ||
            row.attemptId !== page.attemptId),
      );
      this.tools = this.tools.filter(
        (tool) =>
          tool.previewOrder === undefined ||
          (tool.runId === page.runId &&
            tool.stepId === page.stepId &&
            tool.attemptId === page.attemptId),
      );
      this.retireCovered();
    }
    const next = this.assembly.page(page, this.rows, this.tools, this.canonical);
    this.rows = next.rows;
    this.tools = next.tools;
  }

  event(event: AgentDelivery) {
    const { fact, runId, sequence } = event;
    if (
      this.activeRun !== undefined &&
      runId !== this.activeRun &&
      (fact.kind !== 'opened' || sequence <= this.observedThrough)
    )
      return;
    this.tools = updateToolActivity(this.tools, event);
    switch (fact.kind) {
      case 'opened':
        if (sequence >= this.observedThrough) {
          this.activeRun = runId;
          this.close(sequence, (row) => row.runId !== runId);
          this.closeSeats(sequence, (_, seat) => seat.runId !== runId);
          this.tools = this.tools.filter((tool) => tool.runId === runId);
        }
        break;
      case 'executor_message_started':
        this.seats.set(fact.messageId, {
          runId,
          stepId: fact.stepId,
          attemptId: fact.attemptId,
          startSequence: sequence,
          closedAt: null,
        });
        this.parts = [
          ...this.parts.filter((part) => part.runId !== runId || part.messageId !== fact.messageId),
          ...(['body', 'thinking'] as const).map((field) => ({
            runId,
            stepId: fact.stepId,
            attemptId: fact.attemptId,
            partId: field === 'body' ? 'text' : 'thinking',
            messageId: fact.messageId,
            field,
            startSequence: sequence,
          })),
        ];
        break;
      case 'delta': {
        if (!fact.text) break;
        const part = this.parts.find(
          (part) =>
            part.runId === runId &&
            part.stepId === fact.stepId &&
            part.attemptId === fact.attemptId &&
            part.partId === fact.partId,
        );
        if (!part || this.canonical.has(stableRowId(part))) break;
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
        this.assembly.commit(runId, fact.stepId, fact.attemptId, fact.ordinal);
        this.parts = this.parts.filter(
          (part) =>
            part.runId !== runId ||
            part.stepId !== fact.stepId ||
            part.attemptId !== fact.attemptId ||
            part.messageId !== fact.messageId,
        );
        this.close(
          sequence,
          (row) =>
            row.runId === runId &&
            row.stepId === fact.stepId &&
            row.attemptId === fact.attemptId &&
            (row.modelPart
              ? row.modelPart.ordinal === fact.ordinal
              : row.messageId === fact.messageId),
        );
        this.closeSeats(
          sequence,
          (messageId, seat) =>
            seat.runId === runId &&
            seat.stepId === fact.stepId &&
            seat.attemptId === fact.attemptId &&
            messageId === fact.messageId,
        );
        break;
      case 'tool_input_ready':
        this.assembly.retireTool(runId, fact.stepId, fact.attemptId, fact.toolUseId);
        break;
      case 'step_ended':
        this.assembly.commit(runId, fact.stepId, fact.attemptId);
        this.close(
          sequence,
          (row) =>
            row.runId === runId && row.stepId === fact.stepId && row.attemptId === fact.attemptId,
        );
        this.closeSeats(
          sequence,
          (_, seat) =>
            seat.runId === runId &&
            seat.stepId === fact.stepId &&
            seat.attemptId === fact.attemptId,
        );
        this.parts = this.parts.filter(
          (part) =>
            part.runId !== runId ||
            part.stepId !== fact.stepId ||
            part.attemptId !== fact.attemptId,
        );
        break;
      case 'ended':
        if (sequence >= this.observedThrough) this.activeRun = null;
        this.close(sequence, (row) => row.runId === runId);
        this.closeSeats(sequence, (_, seat) => seat.runId === runId);
        this.parts = this.parts.filter((part) => part.runId !== runId);
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

  private closeSeats(sequence: number, matches: (messageId: string, seat: Seat) => boolean) {
    for (const [messageId, seat] of this.seats)
      if (seat.closedAt === null && matches(messageId, seat))
        this.seats.set(messageId, { ...seat, closedAt: sequence });
  }

  private retireCovered(coveredFrom?: number, windowStart?: number) {
    const windowCovered = (startSequence: number, closedAt: number) =>
      this.tailThrough === null ||
      (closedAt <= this.tailThrough &&
        ((coveredFrom !== undefined && coveredFrom <= startSequence) ||
          (windowStart !== undefined && startSequence < windowStart)));
    for (const [messageId, seat] of this.seats)
      if (
        this.canonical.has(`${messageId}/body`) ||
        this.canonical.has(`${messageId}/thinking`) ||
        (seat.closedAt !== null && windowCovered(seat.startSequence, seat.closedAt))
      )
        this.seats.delete(messageId);
    const rows = this.rows.filter(
      (row) =>
        !this.canonical.has(stableRowId(row)) &&
        (row.closedAt === null ||
          (this.tailThrough !== null &&
            (row.preview
              ? row.closedAt > this.tailThrough
              : !windowCovered(row.startSequence, row.closedAt)))),
    );
    if (rows.length !== this.rows.length) this.rows = rows;
  }
}
