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

import { useId, useLayoutEffect, useMemo, useRef } from 'react';
import type {
  AgentGraphClientEdge,
  AgentGraphClientOperator,
  AgentGraphClientScheduledWork,
  AgentGraphClientSnapshot,
} from '@maka/runtime/stream-graph-read-model';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { dotForStatus, type StatusSemantic } from '@maka/ui';

const NODE_WIDTH = 208;
const NODE_HEIGHT = 104;
const COLUMN_GAP = 72;
const ROW_GAP = 24;
const CANVAS_PADDING = 20;

function compareIdentity(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

export interface AgentGraphNodePosition {
  readonly operatorId: string;
  readonly x: number;
  readonly y: number;
}

export interface AgentGraphLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly AgentGraphNodePosition[];
}

export function revealAgentGraphNode(
  viewport: Pick<HTMLElement, 'clientHeight' | 'clientWidth' | 'scrollLeft' | 'scrollTop'>,
  position: AgentGraphNodePosition,
): void {
  if (position.x < viewport.scrollLeft) viewport.scrollLeft = position.x;
  if (position.x + NODE_WIDTH > viewport.scrollLeft + viewport.clientWidth) {
    viewport.scrollLeft = position.x + NODE_WIDTH - viewport.clientWidth;
  }
  if (position.y < viewport.scrollTop) viewport.scrollTop = position.y;
  if (position.y + NODE_HEIGHT > viewport.scrollTop + viewport.clientHeight) {
    viewport.scrollTop = position.y + NODE_HEIGHT - viewport.clientHeight;
  }
}

export function firstScheduledWorkPreview(
  operator: AgentGraphClientOperator,
  work: readonly AgentGraphClientScheduledWork[],
): string | undefined {
  return work
    .filter((candidate) => operator.scheduledWorkIds.includes(candidate.workId))
    .sort(
      (left, right) =>
        Number(right.status === 'requested') - Number(left.status === 'requested') ||
        right.revision - left.revision ||
        right.committedAt - left.committedAt ||
        compareIdentity(right.workId, left.workId),
    )[0]?.instructionPreview;
}

export function scheduledWorkPresentation(
  operator: AgentGraphClientOperator,
  work: readonly AgentGraphClientScheduledWork[],
): { preview: string | undefined; omitted: number } {
  const visibleWorkIds = new Set(work.map((entry) => entry.workId));
  const omittedVisibleReferences = operator.scheduledWorkIds.filter(
    (workId) => !visibleWorkIds.has(workId),
  ).length;
  return {
    preview: firstScheduledWorkPreview(operator, work),
    omitted: operator.omitted.scheduledWorkIds + omittedVisibleReferences,
  };
}

const OPERATOR_STATUS_SEMANTICS = {
  not_started: 'neutral',
  waiting: 'neutral',
  runnable: 'active',
  running: 'active',
  blocked: 'attention',
  completed: 'success',
  failed: 'error',
  aborted: 'error',
  cancelled: 'neutral',
} satisfies Record<AgentGraphClientOperator['status'], StatusSemantic>;

export function agentGraphStatusSemantic(
  status: AgentGraphClientOperator['status'],
): StatusSemantic {
  return OPERATOR_STATUS_SEMANTICS[status];
}

export function AgentGraphStatusDot(props: {
  status: AgentGraphClientOperator['status'];
  label: string;
}) {
  return (
    <StatusDot
      className="maka-agent-graph-status-dot"
      data-status={props.status}
      variant={dotForStatus(agentGraphStatusSemantic(props.status))}
      label={props.label}
      aria-hidden="true"
    />
  );
}

function compareOperatorOrder(
  left: AgentGraphClientOperator,
  right: AgentGraphClientOperator,
): number {
  return left.provisionedAt - right.provisionedAt || compareIdentity(left.operatorId, right.operatorId);
}

export function layoutAgentGraph(
  operators: readonly AgentGraphClientOperator[],
  edges: readonly AgentGraphClientEdge[],
): AgentGraphLayout {
  const stableOperators = [...operators].sort(compareOperatorOrder);
  const operatorIds = new Set(operators.map((operator) => operator.operatorId));
  const incoming = new Map(operators.map((operator) => [operator.operatorId, 0]));
  const outgoing = new Map(operators.map((operator) => [operator.operatorId, [] as string[]]));
  for (const edge of edges) {
    if (!operatorIds.has(edge.fromOperatorId) || !operatorIds.has(edge.toOperatorId)) continue;
    incoming.set(edge.toOperatorId, (incoming.get(edge.toOperatorId) ?? 0) + 1);
    outgoing.get(edge.fromOperatorId)?.push(edge.toOperatorId);
  }

  const order = new Map(stableOperators.map((operator, index) => [operator.operatorId, index]));
  const ready = stableOperators
    .filter((operator) => incoming.get(operator.operatorId) === 0)
    .map((operator) => operator.operatorId);
  const depth = new Map<string, number>();
  const visited = new Set<string>();
  while (ready.length > 0) {
    ready.sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
    const operatorId = ready.shift();
    if (!operatorId || visited.has(operatorId)) continue;
    visited.add(operatorId);
    const sourceDepth = depth.get(operatorId) ?? 0;
    for (const targetId of outgoing.get(operatorId) ?? []) {
      depth.set(targetId, Math.max(depth.get(targetId) ?? 0, sourceDepth + 1));
      const remaining = (incoming.get(targetId) ?? 1) - 1;
      incoming.set(targetId, remaining);
      if (remaining === 0) ready.push(targetId);
    }
  }

  // Cycle members are never visited; keep any depth already propagated from
  // visited ancestors so their edges still flow left-to-right.
  for (const operator of stableOperators) {
    if (!depth.has(operator.operatorId)) depth.set(operator.operatorId, 0);
  }

  const rowsByDepth = new Map<number, AgentGraphClientOperator[]>();
  for (const operator of stableOperators) {
    const column = depth.get(operator.operatorId) ?? 0;
    const rows = rowsByDepth.get(column) ?? [];
    rows.push(operator);
    rowsByDepth.set(column, rows);
  }

  const nodes = [...rowsByDepth.entries()].flatMap(([column, rows]) =>
    rows.map((operator, row) => ({
      operatorId: operator.operatorId,
      x: CANVAS_PADDING + column * (NODE_WIDTH + COLUMN_GAP),
      y: CANVAS_PADDING + row * (NODE_HEIGHT + ROW_GAP),
    })),
  );
  const maxColumn = Math.max(0, ...rowsByDepth.keys());
  const maxRows = Math.max(1, ...[...rowsByDepth.values()].map((rows) => rows.length));
  return {
    width: CANVAS_PADDING * 2 + NODE_WIDTH + maxColumn * (NODE_WIDTH + COLUMN_GAP),
    height: CANVAS_PADDING * 2 + NODE_HEIGHT + (maxRows - 1) * (NODE_HEIGHT + ROW_GAP),
    nodes,
  };
}

export function agentGraphEdgePath(
  source: AgentGraphNodePosition,
  target: AgentGraphNodePosition,
): string {
  const startX = source.x + NODE_WIDTH;
  const startY = source.y + NODE_HEIGHT / 2;
  const endX = target.x;
  const endY = target.y + NODE_HEIGHT / 2;
  const adjacentColumnDistance = NODE_WIDTH + COLUMN_GAP;
  if (endX - source.x <= adjacentColumnDistance) {
    const curve = Math.max(36, Math.abs(endX - startX) / 2);
    return `M ${startX} ${startY} C ${startX + curve} ${startY}, ${endX - curve} ${endY}, ${endX} ${endY}`;
  }

  const laneY = Math.min(source.y, target.y) - ROW_GAP / 2;
  const sourceLaneX = startX + COLUMN_GAP / 2;
  const targetLaneX = endX - COLUMN_GAP / 2;
  return `M ${startX} ${startY} L ${sourceLaneX} ${startY} L ${sourceLaneX} ${laneY} L ${targetLaneX} ${laneY} L ${targetLaneX} ${endY} L ${endX} ${endY}`;
}

export function AgentGraphTopology(props: {
  snapshot: AgentGraphClientSnapshot;
  selectedOperatorId?: string;
  statusLabel(status: AgentGraphClientOperator['status']): string;
  waitLabel(operator: AgentGraphClientOperator): string | undefined;
  hiddenWorkLabel(count: number): string;
  onSelect(operatorId: string): void;
}) {
  const arrowMarkerId = `maka-agent-graph-arrow-${useId().replace(/\W/g, '')}`;
  const viewportRef = useRef<HTMLDivElement>(null);
  const { snapshot } = props;
  const { layout, positionById, workByOperator, operatorById, orderedNodes } = useMemo(() => {
    const layout = layoutAgentGraph(snapshot.operators, snapshot.edges);
    return {
      layout,
      positionById: new Map(layout.nodes.map((node) => [node.operatorId, node])),
      operatorById: new Map(snapshot.operators.map((operator) => [operator.operatorId, operator])),
      orderedNodes: [...layout.nodes].sort((left, right) => left.x - right.x || left.y - right.y),
      workByOperator: new Map(
        snapshot.operators.map((operator) => [
          operator.operatorId,
          scheduledWorkPresentation(operator, snapshot.work),
        ]),
      ),
    };
  }, [snapshot]);
  const selectedPosition = props.selectedOperatorId
    ? positionById.get(props.selectedOperatorId)
    : undefined;

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && selectedPosition) {
      revealAgentGraphNode(viewport, selectedPosition);
    }
  }, [selectedPosition?.x, selectedPosition?.y, snapshot.graphId]);

  return (
    <div
      ref={viewportRef}
      className="maka-agent-graph-topology-viewport"
      data-testid="agent-graph-topology"
    >
      <div
        className="maka-agent-graph-topology-canvas"
        style={{ width: layout.width, height: layout.height }}
      >
        <svg
          className="maka-agent-graph-topology-edges"
          width={layout.width}
          height={layout.height}
          aria-hidden="true"
        >
          <defs>
            <marker id={arrowMarkerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" />
            </marker>
          </defs>
          {snapshot.edges.map((edge) => {
            const source = positionById.get(edge.fromOperatorId);
            const target = positionById.get(edge.toOperatorId);
            if (!source || !target) return null;
            return (
              <path
                key={edge.edgeId}
                className="maka-agent-graph-edge"
                d={agentGraphEdgePath(source, target)}
                markerEnd={`url(#${arrowMarkerId})`}
              />
            );
          })}
        </svg>
        {orderedNodes.map((position) => {
          const operator = operatorById.get(position.operatorId);
          if (!operator) return null;
          const wait = props.waitLabel(operator);
          const status = props.statusLabel(operator.status);
          const workPresentation = workByOperator.get(operator.operatorId);
          const preview = workPresentation?.preview;
          const omittedWork = workPresentation?.omitted ?? 0;
          const work = preview
            ? [preview, omittedWork > 0 ? props.hiddenWorkLabel(omittedWork) : undefined]
                .filter(Boolean)
                .join(' · ')
            : omittedWork > 0
              ? props.hiddenWorkLabel(omittedWork)
              : undefined;
          const selected = props.selectedOperatorId === operator.operatorId;
          return (
            <button
              key={operator.operatorId}
              type="button"
              className="maka-agent-graph-node"
              data-selected={selected ? 'true' : 'false'}
              style={{ left: position.x, top: position.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
              aria-label={[operator.agentId, status, work, wait].filter(Boolean).join('. ')}
              aria-pressed={selected}
              onClick={() => props.onSelect(operator.operatorId)}
            >
              <span className="maka-agent-graph-node-heading">
                <AgentGraphStatusDot status={operator.status} label={status} />
                <strong>{operator.agentId}</strong>
                <span>{status}</span>
              </span>
              {work ? <span className="maka-agent-graph-node-work">{work}</span> : null}
              {wait ? <span className="maka-agent-graph-wait">{wait}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
