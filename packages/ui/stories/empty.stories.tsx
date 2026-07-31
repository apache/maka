import type { Meta, StoryObj } from '@storybook/react-vite';
import { Search } from '@maka/ui/icons';
import { Button } from '../src/index.js';
import { Spinner } from '../src/primitives/spinner.js';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '../src/primitives/empty.js';

const meta = {
  title: 'Primitives/Empty',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--background)',
        border: '1px dashed var(--border)',
        borderRadius: 'var(--radius-xl)',
        minHeight: 280,
      }}
    >
      {children}
    </div>
  );
}

export const IconOnly: Story = {
  render: () => (
    <Frame>
      <Empty>
        <EmptyMedia variant="icon">
          <Search size={18} aria-hidden="true" />
        </EmptyMedia>
      </Empty>
    </Frame>
  ),
};

export const Title: Story = {
  render: () => (
    <Frame>
      <Empty>
        <EmptyHeader>
          <EmptyTitle>暂无会话</EmptyTitle>
        </EmptyHeader>
      </Empty>
    </Frame>
  ),
};

export const TitleAndDescription: Story = {
  render: () => (
    <Frame>
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Search size={18} aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>没有匹配的结果</EmptyTitle>
          <EmptyDescription>试试调整筛选条件，或清空搜索词查看全部会话。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </Frame>
  ),
};

export const WithAction: Story = {
  render: () => (
    <Frame>
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Search size={18} aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>还没有会话</EmptyTitle>
          <EmptyDescription>开始第一次对话吧。</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="secondary" size="sm" label="新建会话" />
        </EmptyContent>
      </Empty>
    </Frame>
  ),
};

export const Loading: Story = {
  render: () => (
    <Frame>
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Spinner style={{ height: 16, width: 16 }} />
          </EmptyMedia>
          <EmptyTitle>加载中</EmptyTitle>
          <EmptyDescription>正在读取会话列表…</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </Frame>
  ),
};
