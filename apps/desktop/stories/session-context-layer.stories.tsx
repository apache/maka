import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState, type ReactElement } from 'react';
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
} from '@astryxdesign/core';

import './session-context-layer.css';

type RevisionContext = {
  current: number;
  total: number;
};

type GoalContext = {
  current: number;
  total: number;
};

type SessionContext = {
  currentSession: string;
  parentSession?: string;
  branchedBeforeInterrupt?: boolean;
  revision?: RevisionContext;
  memory?: boolean;
  deepResearch?: boolean;
  goal?: GoalContext;
};

type ContextItem = {
  key: string;
  overflowLabel: string;
  element: ReactElement;
};

const noop = () => undefined;

function RevisionControl({ revision }: { revision: RevisionContext }) {
  const [current, setCurrent] = useState(revision.current);
  return (
    <div className="maka-session-context-prototype__revision">
      <Text type="supporting" hasTabularNumbers>
        版本 {current} / {revision.total}
      </Text>
      <ButtonGroup label="切换会话版本" size="sm">
        <IconButton
          label="上一版本"
          icon={<Icon icon="chevronLeft" size="xsm" />}
          variant="ghost"
          size="sm"
          isDisabled={current <= 1}
          onClick={() => setCurrent((value) => Math.max(1, value - 1))}
        />
        <IconButton
          label="下一版本"
          icon={<Icon icon="chevronRight" size="xsm" />}
          variant="ghost"
          size="sm"
          isDisabled={current >= revision.total}
          onClick={() => setCurrent((value) => Math.min(revision.total, value + 1))}
        />
      </ButtonGroup>
    </div>
  );
}

function GoalControl({ goal }: { goal: GoalContext }) {
  const [active, setActive] = useState(true);
  if (!active) {
    return <Token size="sm" color="gray" label="目标已停止" icon={<Icon icon="stop" size="xsm" />} />;
  }
  return (
    <div className="maka-session-context-prototype__goal">
      <StatusDot variant="accent" label="自主目标正在运行" isPulsing />
      <Text type="supporting" hasTabularNumbers>
        目标 {goal.current} / {goal.total}
      </Text>
      <IconButton
        label="停止自主目标"
        icon={<Icon icon="stop" size="xsm" />}
        variant="ghost"
        size="sm"
        onClick={() => setActive(false)}
      />
    </div>
  );
}

function SessionContextLayer({ context }: { context: SessionContext }) {
  const contextItems = useMemo<ContextItem[]>(() => {
    const items: ContextItem[] = [];
    if (context.goal) {
      items.push({
        key: 'goal',
        overflowLabel: `目标 ${context.goal.current} / ${context.goal.total}`,
        element: <GoalControl goal={context.goal} />,
      });
    }
    if (context.revision) {
      items.push({
        key: 'revision',
        overflowLabel: `版本 ${context.revision.current} / ${context.revision.total}`,
        element: <RevisionControl revision={context.revision} />,
      });
    }
    if (context.deepResearch) {
      items.push({
        key: 'deep-research',
        overflowLabel: '深度研究已启用',
        element: <Token size="sm" color="blue" label="深度研究" icon={<Icon icon="search" size="xsm" />} />,
      });
    }
    if (context.memory) {
      items.push({
        key: 'memory',
        overflowLabel: '本地记忆已启用',
        element: <Token size="sm" color="default" label="本地记忆" icon={<Icon icon="check" size="xsm" />} />,
      });
    }
    if (context.branchedBeforeInterrupt) {
      items.push({
        key: 'interrupt-origin',
        overflowLabel: '从中断前分支',
        element: <Token size="sm" color="yellow" label="从中断前分支" icon={<Icon icon="warning" size="xsm" />} />,
      });
    }
    return items;
  }, [context]);

  const hasContext = Boolean(context.parentSession || contextItems.length > 0);
  if (!hasContext) return null;

  return (
    <LayoutHeader
      hasDivider
      padding={0}
      role="region"
      label="会话上下文"
      className="maka-session-context-prototype"
    >
      <div className="maka-session-context-prototype__inner">
        <div className="maka-session-context-prototype__lineage">
          {context.parentSession ? (
            <Breadcrumbs
              label="会话来源"
              variant="supporting"
              separator={<Icon icon="chevronRight" size="xsm" />}
            >
              <BreadcrumbItem onClick={noop}>{context.parentSession}</BreadcrumbItem>
              <BreadcrumbItem isCurrent>{context.currentSession}</BreadcrumbItem>
            </Breadcrumbs>
          ) : (
            <Text type="supporting" maxLines={1}>
              {context.currentSession}
            </Text>
          )}
        </div>
        <div className="maka-session-context-prototype__cluster">
          <OverflowList
            gap={1}
            minVisibleItems={1}
            collapseFrom="end"
            overflowRenderer={(overflowItems) => (
              <MoreMenu
                label={`更多会话上下文（${overflowItems.length}）`}
                size="sm"
                items={overflowItems.map(({ index }) => ({
                  label: contextItems[index]?.overflowLabel ?? '会话上下文',
                  onClick: noop,
                }))}
              />
            )}
          >
            {contextItems.map((item) => (
              <div key={item.key} className="maka-session-context-prototype__item">
                {item.element}
              </div>
            ))}
          </OverflowList>
        </div>
      </div>
    </LayoutHeader>
  );
}

function ConversationPreview({ context }: { context: SessionContext }) {
  return (
    <div className="maka-session-context-preview">
      <SessionContextLayer context={context} />
      <div className="maka-session-context-preview__transcript" aria-hidden="true">
        <div className="maka-session-context-preview__user">把这轮改动整理成可以 review 的状态。</div>
        <div className="maka-session-context-preview__assistant">
          当前会话上下文会固定在 transcript 上方，来源、版本和运行中的目标不再散落成互不相关的浮动 pill。
        </div>
      </div>
    </div>
  );
}

function ReviewCase({
  title,
  note,
  width,
  context,
}: {
  title: string;
  note: string;
  width?: number;
  context: SessionContext;
}) {
  return (
    <section className="maka-session-context-review-case" style={{ width }}>
      <div className="maka-session-context-review-case__label">
        <Text type="label">{title}</Text>
        <Text type="supporting">{note}</Text>
      </div>
      <ConversationPreview context={context} />
    </section>
  );
}

const branchContext: SessionContext = {
  currentSession: 'Chat Surface 收敛',
  parentSession: 'UI polish 主线评审',
};

const combinedContext: SessionContext = {
  currentSession: 'Chat Surface 收敛',
  parentSession: 'UI polish 主线评审',
  revision: { current: 2, total: 3 },
  memory: true,
  deepResearch: true,
  goal: { current: 4, total: 12 },
};

const meta = {
  title: 'Product/Chat Surface/Session Context Layer Prototype',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const StateGallery: Story = {
  render: () => (
    <main className="maka-session-context-review-board">
      <ReviewCase
        title="无额外上下文"
        note="没有 branch、revision、mode 或 goal 时整层不渲染。"
        context={{ currentSession: '普通会话' }}
      />
      <ReviewCase
        title="Branch lineage"
        note="Breadcrumb 负责来源和返回上级会话。"
        context={branchContext}
      />
      <ReviewCase
        title="Revision"
        note="版本是兄弟状态，用 ButtonGroup 切换，不伪装成 breadcrumb。"
        context={{ currentSession: '编辑后的回答', revision: { current: 2, total: 3 } }}
      />
      <ReviewCase
        title="会话模式"
        note="Memory 与 Deep Research 是被动 metadata，使用 Token。"
        context={{ currentSession: '研究会话', memory: true, deepResearch: true }}
      />
      <ReviewCase
        title="Active goal"
        note="运行状态始终带文字，停止是独立且明确的 action。"
        context={{ currentSession: '自主执行', goal: { current: 4, total: 12 } }}
      />
      <ReviewCase
        title="中断前分支"
        note="中断是 lineage qualifier，不升级成持久警告 Banner。"
        context={{ ...branchContext, branchedBeforeInterrupt: true }}
      />
      <ReviewCase
        title="完整叠加"
        note="所有状态同时存在时仍只占一层，并按 goal → revision → modes 排优先级。"
        context={combinedContext}
      />
    </main>
  ),
};

export const ResponsiveCombined: Story = {
  render: () => (
    <main className="maka-session-context-responsive-board">
      <ReviewCase
        title="宽 · 860px"
        note="lineage 与完整上下文簇同排。"
        width={860}
        context={combinedContext}
      />
      <div className="maka-session-context-responsive-board__compact">
        <ReviewCase
          title="中 · 520px"
          note="lineage 独占第一行；空间足够时保留完整状态簇。"
          width={520}
          context={combinedContext}
        />
        <ReviewCase
          title="窄 · 360px"
          note="active goal 始终可见，其余状态按空间进入更多菜单。"
          width={360}
          context={combinedContext}
        />
      </div>
    </main>
  ),
};
