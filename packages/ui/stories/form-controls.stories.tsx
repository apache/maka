import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { CheckboxInput, Divider, NumberInput, TextArea, TextInput } from '../src/index.js';

const meta = {
  title: 'Primitives/Form Controls',
  parameters: {
    layout: 'padded',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 8, maxWidth: 420 }}>
      <h3 style={{ color: 'var(--muted-foreground)', fontSize: 12, fontWeight: 600, margin: 0 }}>{title}</h3>
      {children}
    </div>
  );
}

export const InputStates: Story = {
  render: () => {
    const [empty, setEmpty] = useState('');
    const [filled, setFilled] = useState('已经填好的文本');
    const [invalid, setInvalid] = useState('错误值');
    return (
    <div style={{ display: 'grid', gap: 20, maxWidth: 440 }}>
      <Section title="默认">
        <TextInput label="默认输入" value={empty} onChange={setEmpty} placeholder="输入内容…" />
      </Section>
      <Section title="已填值">
        <TextInput label="有值输入" value={filled} onChange={setFilled} />
      </Section>
      <Section title="禁用">
        <TextInput label="禁用输入" value="禁用态" isDisabled />
      </Section>
      <Section title="错误态">
        <TextInput label="错误态输入" value={invalid} onChange={setInvalid} status={{ type: 'error' }} />
      </Section>
    </div>
    );
  },
};

export const TextareaStates: Story = {
  render: () => {
    const [value, setValue] = useState('');
    return (
    <div style={{ display: 'grid', gap: 20, maxWidth: 440 }}>
      <Section title="默认">
        <TextArea label="默认多行" value={value} onChange={setValue} placeholder="多行输入…" />
      </Section>
      <Section title="禁用">
        <TextArea label="禁用多行" value="禁用态多行文本" isDisabled />
      </Section>
    </div>
    );
  },
};

export const Field: Story = {
  render: () => {
    const [name, setName] = useState('maka-agent');
    const [description, setDescription] = useState('一个本地优先的 AI agent。');
    return (
    <div style={{ display: 'grid', gap: 20, maxWidth: 440 }}>
      <Section title="单行输入（标签与说明）">
        <TextInput
          label="项目名称"
          description="显示在侧栏和会话标题里。"
          value={name}
          onChange={setName}
        />
      </Section>
      <Section title="多行输入（标签与说明）">
        <TextArea
          label="项目说明"
          description="支持 Markdown，最多 500 字。"
          value={description}
          onChange={setDescription}
        />
      </Section>
    </div>
    );
  },
};

export const NumericAndBooleanStates: Story = {
  render: () => {
    const [port, setPort] = useState<number | null>(3939);
    const [enabled, setEnabled] = useState(true);
    return (
      <div style={{ display: 'grid', gap: 20, maxWidth: 440 }}>
        <Section title="数字输入">
          <NumberInput label="端口" value={port} onChange={setPort} isIntegerOnly hasClear />
        </Section>
        <Section title="复选框">
          <CheckboxInput
            label="自动启动"
            description="登录后启动本地服务。"
            value={enabled}
            onChange={setEnabled}
          />
        </Section>
      </div>
    );
  },
};

export const DividerStates: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 20, maxWidth: 440 }}>
      <Section title="横向排列">
        <div style={{ display: 'grid', gap: 8 }}>
          <span style={{ fontSize: 13 }}>上方</span>
          <Divider />
          <span style={{ fontSize: 13 }}>下方</span>
        </div>
      </Section>
      <Section title="纵向排列">
        <div style={{ alignItems: 'center', display: 'flex', gap: 12, height: 48 }}>
          <span style={{ fontSize: 13 }}>左</span>
          <Divider orientation="vertical" />
          <span style={{ fontSize: 13 }}>右</span>
        </div>
      </Section>
      <Section title="带标签">
        <Divider label="更多设置" />
      </Section>
    </div>
  ),
};
