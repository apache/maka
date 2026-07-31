import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TabsList, TabsPanel, TabsRoot, TabsTrigger } from '../src/ui.js';

const meta = {
  title: 'Primitives/Tabs',
  parameters: {
    layout: 'padded',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 16 }}>
      {children}
    </div>
  );
}

export const ThreeTabs: Story = {
  render: () => {
    const [value, setValue] = useState('overview');
    return (
      <div style={{ maxWidth: 480 }}>
        <TabsRoot value={value} onValueChange={setValue}>
          <TabsList aria-label="概览标签">
            <TabsTrigger value="overview">概览</TabsTrigger>
            <TabsTrigger value="activity">活动</TabsTrigger>
            <TabsTrigger value="settings">设置</TabsTrigger>
          </TabsList>
          <TabsPanel value="overview">
            <Panel>概览内容：这里是会话的整体摘要。</Panel>
          </TabsPanel>
          <TabsPanel value="activity">
            <Panel>活动内容：最近的事件流。</Panel>
          </TabsPanel>
          <TabsPanel value="settings">
            <Panel>设置内容：配置项。</Panel>
          </TabsPanel>
        </TabsRoot>
      </div>
    );
  },
};

export const DisabledTab: Story = {
  render: () => {
    const [value, setValue] = useState('general');
    return (
      <div style={{ maxWidth: 480 }}>
        <TabsRoot value={value} onValueChange={setValue}>
          <TabsList aria-label="带禁用项">
            <TabsTrigger value="general">通用</TabsTrigger>
            <TabsTrigger value="advanced" disabled>高级</TabsTrigger>
            <TabsTrigger value="about">关于</TabsTrigger>
          </TabsList>
          <TabsPanel value="general">
            <Panel>通用设置。</Panel>
          </TabsPanel>
          <TabsPanel value="advanced">
            <Panel>高级设置（禁用，不可切到此页）。</Panel>
          </TabsPanel>
          <TabsPanel value="about">
            <Panel>关于信息。</Panel>
          </TabsPanel>
        </TabsRoot>
      </div>
    );
  },
};

export const OverflowTabs: Story = {
  render: () => {
    const [value, setValue] = useState('tab-1');
    const labels = Array.from({ length: 12 }, (_, i) => `标签 ${i + 1}`);
    return (
      <div style={{ maxWidth: 480 }}>
        <TabsRoot value={value} onValueChange={setValue}>
          <TabsList aria-label="溢出标签" style={{ overflowX: 'auto' }}>
            {labels.map((label, i) => (
              <TabsTrigger key={i} value={`tab-${i + 1}`}>{label}</TabsTrigger>
            ))}
          </TabsList>
          {labels.map((_, i) => (
            <TabsPanel key={i} value={`tab-${i + 1}`}>
              <Panel>{labels[i]} 的内容。</Panel>
            </TabsPanel>
          ))}
        </TabsRoot>
      </div>
    );
  },
};