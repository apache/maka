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

import { useEffect, useReducer, type ReactElement } from 'react';
import {
  BreadcrumbItem,
  Breadcrumbs,
  ButtonGroup,
  Icon,
  IconButton,
  LayoutHeader,
  MoreMenu,
  OverflowList,
  StatusDot,
  Text,
  Token,
  type DropdownMenuOption,
} from '@astryxdesign/core';
import { getConversationCopy } from './conversation-copy.js';
import { ICON_SIZE, Pause, Play } from './icons.js';
import { useUiLocale } from './locale-context.js';
import { dotForStatus } from './status-vocabulary.js';

export interface SessionContextBranch {
  parentSessionId: string;
  parentSessionName: string;
  fromAbortedTurn?: boolean;
}

export interface SessionContextRevision {
  current: number;
  total: number;
  previousSessionId?: string;
  nextSessionId?: string;
}

interface SessionContextGoalBase {
  condition: string;
  iterations: number;
  maxIterations: number;
  /** Epoch ms when the goal was armed; the chip derives wall-clock elapsed. */
  setAt: number;
  tokensSpent?: number;
  /** When present (a budget exists), the chip shows spent / budget. */
  tokenBudget?: number;
  onClear(): void;
}

export type SessionContextGoal =
  | (SessionContextGoalBase & {
      status: 'active' | 'waiting';
      pausedAt?: never;
      /** Present when the goal can be paused (active/waiting). */
      onPause?(): void;
      onResume?: never;
    })
  | (SessionContextGoalBase & {
      status: 'paused';
      /** Epoch ms when the goal was paused; freezes the chip clock while paused. */
      pausedAt: number;
      onPause?: never;
      /** Present when the goal is paused and can be resumed. */
      onResume?(): void;
    });

interface ContextItem {
  key: string;
  element: ReactElement;
  overflowItems: DropdownMenuOption[];
}

export function SessionContextLayer(props: {
  sessionName: string;
  branch?: SessionContextBranch;
  onBranchNavigate?(sessionId: string): void;
  revision?: SessionContextRevision;
  onRevisionNavigate?(sessionId: string): void;
  memoryActive?: boolean;
  onOpenMemorySettings?(): void;
  deepResearchActive?: boolean;
  goal?: SessionContextGoal;
}) {
  const copy = getConversationCopy(useUiLocale()).chat;
  const contextItems: ContextItem[] = [];
  // A live elapsed label must keep moving: tick the chip every 30s so the
  // wall clock does not freeze between session events. Paused goals freeze
  // by design (pausedAt), so they skip the ticker.
  const [, tick] = useReducer((value: number) => value + 1, 0);
  const liveClock = props.goal !== undefined && props.goal.status !== 'paused';
  useEffect(() => {
    if (!liveClock) return;
    const interval = window.setInterval(tick, 30_000);
    return () => window.clearInterval(interval);
  }, [liveClock]);

  if (props.goal) {
    const goal = props.goal;
    // A paused goal burns nothing, while waiting remains live but is not
    // currently executing. Both must be visually still; only paused needs an
    // attention tone.
    const paused = goal.status === 'paused';
    const waiting = goal.status === 'waiting';
    const elapsedMs = paused
      ? Math.max(0, goal.pausedAt - goal.setAt)
      : Math.max(0, Date.now() - goal.setAt);
    const goalText = [
      copy.goalProgress(goal.iterations, goal.maxIterations),
      copy.goalElapsed(elapsedMs),
      goal.tokenBudget !== undefined && goal.tokensSpent !== undefined
        ? copy.goalTokens(goal.tokensSpent, goal.tokenBudget)
        : null,
    ]
      .filter((part) => part !== null)
      .join(' \u00b7 ');
    const overflowItems: DropdownMenuOption[] = [];
    if (goal.onPause) {
      overflowItems.push({
        label: copy.pauseGoalAriaLabel(goal.iterations, goal.maxIterations),
        icon: <Pause size={ICON_SIZE.control} aria-hidden />,
        onClick: goal.onPause,
      });
    }
    if (goal.onResume) {
      overflowItems.push({
        label: copy.resumeGoalAriaLabel(goal.iterations, goal.maxIterations),
        icon: <Play size={ICON_SIZE.control} aria-hidden />,
        onClick: goal.onResume,
      });
    }
    overflowItems.push({
      label: copy.clearGoalAriaLabel(goal.iterations, goal.maxIterations),
      icon: <Icon icon="stop" size="xsm" />,
      onClick: goal.onClear,
    });
    contextItems.push({
      key: 'goal',
      element: (
        <div className="maka-session-context__goal">
          <StatusDot
            variant={dotForStatus(paused ? 'attention' : 'active')}
            label={
              paused
                ? copy.goalPausedAriaLabel
                : waiting
                  ? copy.goalWaitingAriaLabel
                  : copy.goalRunningAriaLabel
            }
            isPulsing={!paused && !waiting}
          />
          <Text type="supporting" hasTabularNumbers>
            {goalText}
          </Text>
          {goal.onPause ? (
            <IconButton
              type="button"
              label={copy.pauseGoalAriaLabel(goal.iterations, goal.maxIterations)}
              icon={<Pause size={ICON_SIZE.control} aria-hidden />}
              variant="ghost"
              size="sm"
              onClick={goal.onPause}
              tooltip={copy.pauseGoal(
                goal.condition,
                goal.iterations,
                goal.maxIterations,
                goal.status,
              )}
            />
          ) : null}
          {goal.onResume ? (
            <IconButton
              type="button"
              label={copy.resumeGoalAriaLabel(goal.iterations, goal.maxIterations)}
              icon={<Play size={ICON_SIZE.control} aria-hidden />}
              variant="ghost"
              size="sm"
              onClick={goal.onResume}
              tooltip={copy.resumeGoal(goal.condition, goal.iterations, goal.maxIterations)}
            />
          ) : null}
          <IconButton
            type="button"
            label={copy.clearGoalAriaLabel(goal.iterations, goal.maxIterations)}
            icon={<Icon icon="stop" size="xsm" />}
            variant="ghost"
            size="sm"
            onClick={goal.onClear}
            tooltip={copy.clearGoal(
              goal.condition,
              goal.iterations,
              goal.maxIterations,
              goal.status,
            )}
          />
        </div>
      ),
      overflowItems,
    });
  }

  if (props.revision) {
    const revision = props.revision;
    const previousSessionId = props.onRevisionNavigate ? revision.previousSessionId : undefined;
    const nextSessionId = props.onRevisionNavigate ? revision.nextSessionId : undefined;
    contextItems.push({
      key: 'revision',
      element: (
        <div className="maka-session-context__revision">
          <Text type="supporting" hasTabularNumbers>
            {copy.revisionVersion(revision.current, revision.total)}
          </Text>
          <ButtonGroup label={copy.revisionVersionsAriaLabel} size="sm">
            <IconButton
              type="button"
              label={copy.previousRevision}
              icon={<Icon icon="chevronLeft" size="xsm" />}
              variant="ghost"
              size="sm"
              isDisabled={!previousSessionId}
              onClick={() => {
                if (previousSessionId) props.onRevisionNavigate?.(previousSessionId);
              }}
            />
            <IconButton
              type="button"
              label={copy.nextRevision}
              icon={<Icon icon="chevronRight" size="xsm" />}
              variant="ghost"
              size="sm"
              isDisabled={!nextSessionId}
              onClick={() => {
                if (nextSessionId) props.onRevisionNavigate?.(nextSessionId);
              }}
            />
          </ButtonGroup>
        </div>
      ),
      overflowItems: [{
        label: copy.revisionVersion(revision.current, revision.total),
        items: [
          {
            label: copy.previousRevision,
            isDisabled: !previousSessionId,
            onClick: previousSessionId
              ? () => props.onRevisionNavigate?.(previousSessionId)
              : undefined,
          },
          {
            label: copy.nextRevision,
            isDisabled: !nextSessionId,
            onClick: nextSessionId
              ? () => props.onRevisionNavigate?.(nextSessionId)
              : undefined,
          },
        ],
      }],
    });
  }

  if (props.deepResearchActive) {
    contextItems.push({
      key: 'deep-research',
      element: (
        <Token
          size="sm"
          color="blue"
          label={copy.deepResearchAriaLabel}
          isLabelHidden
          endContent={copy.deepResearch}
          description={copy.deepResearchTitle}
          icon={<Icon icon="search" size="xsm" />}
        />
      ),
      overflowItems: [{
        label: copy.deepResearchAriaLabel,
        icon: <Icon icon="search" size="xsm" />,
        isDisabled: true,
      }],
    });
  }

  if (props.memoryActive) {
    contextItems.push({
      key: 'memory',
      element: (
        <Token
          size="sm"
          color="default"
          label={copy.memoryAriaLabel}
          isLabelHidden
          endContent={copy.memory}
          description={copy.memoryTitle}
          icon={<Icon icon="check" size="xsm" />}
          onClick={props.onOpenMemorySettings}
        />
      ),
      overflowItems: [{
        label: copy.memoryAriaLabel,
        icon: <Icon icon="check" size="xsm" />,
        onClick: props.onOpenMemorySettings,
        isDisabled: !props.onOpenMemorySettings,
      }],
    });
  }

  if (props.branch?.fromAbortedTurn) {
    contextItems.push({
      key: 'interrupt-origin',
      element: (
        <Token
          size="sm"
          color="yellow"
          label={copy.branchBeforeInterrupt}
          icon={<Icon icon="warning" size="xsm" />}
        />
      ),
      overflowItems: [{
        label: copy.branchBeforeInterrupt,
        icon: <Icon icon="warning" size="xsm" />,
        isDisabled: true,
      }],
    });
  }

  if (!props.branch && contextItems.length === 0) return null;
  const parentSessionId = props.branch?.parentSessionId;

  return (
    <LayoutHeader
      hasDivider
      padding={0}
      role="region"
      label={copy.sessionContextAriaLabel}
      className="maka-session-context"
      data-session-context-layer="true"
    >
      <div className="maka-session-context__inner">
        {/* Lineage only. The session's own name moved to the window titlebar
            (TitlebarSessionIdentity), which shows it in every view and survives
            a collapsed sidebar; repeating it one row below was the same string
            twice. What stays is what the titlebar cannot answer: which session
            this one branched FROM. */}
        <div className="maka-session-context__lineage">
          {props.branch ? (
            <Breadcrumbs
              label={copy.sessionLineageAriaLabel}
              variant="supporting"
              className="maka-session-context__breadcrumbs"
              separator={<Icon icon="chevronRight" size="xsm" />}
            >
              <BreadcrumbItem
                onClick={props.onBranchNavigate
                  ? () => {
                    if (parentSessionId) props.onBranchNavigate?.(parentSessionId);
                  }
                  : undefined}
              >
                <span className="maka-session-context__breadcrumb-label">
                  {props.branch.parentSessionName}
                </span>
              </BreadcrumbItem>
              <BreadcrumbItem isCurrent>
                <span className="maka-session-context__breadcrumb-label">
                  {props.sessionName}
                </span>
              </BreadcrumbItem>
            </Breadcrumbs>
          ) : null}
        </div>
        {contextItems.length > 0 && (
          <div className="maka-session-context__cluster">
            <OverflowList
              gap={1}
              minVisibleItems={1}
              collapseFrom="end"
              overflowRenderer={(overflowItems) => {
                const items = overflowItems.flatMap(({ index }) => contextItems[index]?.overflowItems ?? []);
                return (
                  <MoreMenu
                    label={copy.sessionContextMore(items.length)}
                    size="sm"
                    items={items}
                  />
                );
              }}
            >
              {contextItems.map((item) => (
                <div key={item.key} className="maka-session-context__item">
                  {item.element}
                </div>
              ))}
            </OverflowList>
          </div>
        )}
      </div>
    </LayoutHeader>
  );
}
