import type { ReactElement } from 'react';
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
import { useUiLocale } from './locale-context.js';

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

export interface SessionContextGoal {
  condition: string;
  status: string;
  iterations: number;
  maxIterations: number;
  onClear(): void;
}

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

  if (props.goal) {
    const goal = props.goal;
    contextItems.push({
      key: 'goal',
      element: (
        <div className="maka-session-context__goal">
          <StatusDot variant="accent" label={copy.goalRunningAriaLabel} isPulsing />
          <Text type="supporting" hasTabularNumbers>
            {copy.goalProgress(goal.iterations, goal.maxIterations)}
          </Text>
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
      overflowItems: [{
        label: copy.clearGoalAriaLabel(goal.iterations, goal.maxIterations),
        icon: <Icon icon="stop" size="xsm" />,
        onClick: goal.onClear,
      }],
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
          ) : (
            <Text type="supporting" maxLines={1}>{props.sessionName}</Text>
          )}
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
