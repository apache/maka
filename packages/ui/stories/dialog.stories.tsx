import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button, TextArea, TextInput } from '../src/index.js';
import {
  Dialog,
  DialogHeader,
} from '@astryxdesign/core/Dialog';
import {
  Layout,
  LayoutContent,
  LayoutFooter,
} from '@astryxdesign/core/Layout';

const meta = {
  title: 'Primitives/Dialog',
  parameters: {
    layout: 'padded',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function DialogExample(props: {
  title: string;
  subtitle?: string;
  withHeader?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const withHeader = props.withHeader ?? true;

  return (
    <>
      <Button
        variant="primary"
        label={`打开：${props.title}`}
        onClick={() => setIsOpen(true)}
      />
      <Dialog
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        aria-label={withHeader ? undefined : props.title}
        width={480}
        padding={0}
        purpose="form"
      >
        <Layout
          height="auto"
          header={
            withHeader ? (
              <DialogHeader
                title={props.title}
                subtitle={props.subtitle}
                onOpenChange={setIsOpen}
              />
            ) : undefined
          }
          content={
            <LayoutContent>
              <p>Dialog、焦点、Esc 和关闭恢复均由 Astryx 直接管理。</p>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <Button
                variant="primary"
                label="完成"
                onClick={() => setIsOpen(false)}
              />
            </LayoutFooter>
          }
        />
      </Dialog>
    </>
  );
}

export const Basic: Story = {
  render: () => <DialogExample title="基础对话框" />,
};

export const WithSubtitle: Story = {
  render: () => (
    <DialogExample
      title="连接模型"
      subtitle="配置连接后即可在会话中使用。"
    />
  ),
};

export const WithoutHeader: Story = {
  render: () => (
    <DialogExample title="无标题栏对话框" withHeader={false} />
  ),
};

function FormDialog() {
  const [isOpen, setIsOpen] = useState(false);
  const [title, setTitle] = useState('项目周报');
  const [description, setDescription] = useState('本周完成了 Storybook P0 组件覆盖。');

  return (
    <>
      <Button
        variant="primary"
        label="打开表单"
        onClick={() => setIsOpen(true)}
      />
      <Dialog
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        width={520}
        padding={0}
        purpose="form"
      >
        <Layout
          height="auto"
          header={
            <DialogHeader
              title="编辑说明"
              onOpenChange={setIsOpen}
            />
          }
          content={
            <LayoutContent>
              <div style={{ display: 'grid', gap: 14 }}>
                <TextInput hasAutoFocus label="标题" value={title} onChange={setTitle} />
                <TextArea label="描述" value={description} onChange={setDescription} />
              </div>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <Button
                  variant="ghost"
                  label="取消"
                  onClick={() => setIsOpen(false)}
                />
                <Button
                  variant="primary"
                  label="保存"
                  onClick={() => setIsOpen(false)}
                />
              </div>
            </LayoutFooter>
          }
        />
      </Dialog>
    </>
  );
}

export const Form: Story = {
  render: () => <FormDialog />,
};

export const OpenMatrix: Story = {
  render: () => (
    <div style={{ minHeight: 520 }}>
      <Dialog
        isOpen
        onOpenChange={() => undefined}
        width={480}
        padding={0}
        purpose="info"
        aria-label="常驻打开的对话框"
      >
        <Layout
          height="auto"
          content={
            <LayoutContent>
              <p>常驻 open，用于检查 Astryx Dialog 的视觉与命中区域。</p>
            </LayoutContent>
          }
        />
      </Dialog>
    </div>
  ),
};
