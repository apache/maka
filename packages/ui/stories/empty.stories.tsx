import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button, EmptyState, Spinner } from '@astryxdesign/core';
import { Archive, Search } from '../src/icons.js';

const meta = {
  title: 'Astryx/EmptyState',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const IconOnly: Story = {
  render: () => <EmptyState icon={<Archive />} title="暂无内容" />,
};

export const TitleAndDescription: Story = {
  render: () => (
    <EmptyState
      icon={<Search />}
      title="没有匹配的结果"
      description="试试调整筛选条件，或清空搜索词查看全部会话。"
    />
  ),
};

export const WithAction: Story = {
  render: () => (
    <EmptyState
      icon={<Archive />}
      title="还没有会话"
      description="开始第一次对话吧。"
      actions={<Button variant="primary" label="新建会话" onClick={() => {}} />}
    />
  ),
};

export const Loading: Story = {
  render: () => (
    <EmptyState
      icon={<Spinner aria-label="加载中" />}
      title="加载中"
      description="正在读取会话列表…"
    />
  ),
};
