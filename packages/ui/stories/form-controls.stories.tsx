import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  FieldDescription,
  FieldRoot,
  Label,
} from '../src/ui.js';
import { Divider } from '../src/index.js';
import { Input } from '../src/primitives/input.js';
import { Textarea } from '../src/primitives/textarea.js';

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
  render: () => (
    <div style={{ display: 'grid', gap: 20, maxWidth: 440 }}>
      <Section title="默认">
        <Input placeholder="输入内容…" aria-label="默认输入" />
      </Section>
      <Section title="已填值">
        <Input defaultValue="已经填好的文本" aria-label="有值输入" />
      </Section>
      <Section title="禁用">
        <Input defaultValue="禁用态" disabled aria-label="禁用输入" />
      </Section>
      <Section title="错误态">
        <Input defaultValue="错误值" aria-invalid="true" aria-label="错误态输入" />
      </Section>
    </div>
  ),
};

export const TextareaStates: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 20, maxWidth: 440 }}>
      <Section title="默认">
        <Textarea placeholder="多行输入…" aria-label="默认多行" />
      </Section>
      <Section title="禁用">
        <Textarea defaultValue="禁用态多行文本" disabled aria-label="禁用多行" />
      </Section>
    </div>
  ),
};

export const Field: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 20, maxWidth: 440 }}>
      <Section title="完整 Field（Label + Input + Description）">
        <FieldRoot className="grid gap-1.5">
          <Label>项目名称</Label>
          <Input defaultValue="maka-agent" aria-label="项目名称" />
          <FieldDescription>显示在侧栏和会话标题里。</FieldDescription>
        </FieldRoot>
      </Section>
      <Section title="Field + Textarea 组合">
        <FieldRoot className="grid gap-1.5">
          <Label>项目说明</Label>
          <Textarea defaultValue="一个本地优先的 AI agent。" aria-label="项目说明" />
          <FieldDescription>支持 Markdown，最多 500 字。</FieldDescription>
        </FieldRoot>
      </Section>
    </div>
  ),
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