import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Tab, TabList } from '@astryxdesign/core';

const meta = {
  title: 'Astryx/TabList',
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
        <TabList value={value} onChange={setValue} hasDivider aria-label="概览标签">
          <Tab value="overview" label="概览" />
          <Tab value="activity" label="活动" />
          <Tab value="settings" label="设置" />
        </TabList>
        {value === 'overview' ? <Panel>概览内容：这里是会话的整体摘要。</Panel> : null}
        {value === 'activity' ? <Panel>活动内容：最近的事件流。</Panel> : null}
        {value === 'settings' ? <Panel>设置内容：配置项。</Panel> : null}
      </div>
    );
  },
};

export const DisabledTab: Story = {
  render: () => {
    const [value, setValue] = useState('general');
    return (
      <div style={{ maxWidth: 480 }}>
        <TabList value={value} onChange={setValue} hasDivider aria-label="带禁用项">
          <Tab value="general" label="通用" />
          <Tab value="advanced" label="高级" aria-disabled="true" onClick={(event) => event.preventDefault()} />
          <Tab value="about" label="关于" />
        </TabList>
        {value === 'general' ? <Panel>通用设置。</Panel> : null}
        {value === 'about' ? <Panel>关于信息。</Panel> : null}
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
        <TabList value={value} onChange={setValue} aria-label="溢出标签" style={{ overflowX: 'auto' }}>
            {labels.map((label, i) => (
              <Tab key={label} value={`tab-${i + 1}`} label={label} />
            ))}
        </TabList>
        <Panel>{labels[Number(value.slice(4)) - 1]} 的内容。</Panel>
      </div>
    );
  },
};
