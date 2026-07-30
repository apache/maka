import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ToastProvider, useToast, type ToastVariant } from '../src/toast.js';
import { Button } from '../src/index.js';

const meta = {
  title: 'Primitives/Toast',
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <ToastProvider>
        <Story />
      </ToastProvider>
    ),
  ],
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const VARIANTS: ToastVariant[] = ['info', 'success', 'warning', 'error'];

export const Interactive: Story = {
  render: () => {
    const toast = useToast();
    return (
      <div style={{ display: 'grid', gap: 8, padding: 24, width: 360 }}>
        {VARIANTS.map((variant) => (
          <Button
            key={variant}
            variant="secondary"
            onClick={() => toast.toast({ title: `${variant} 标题`, description: `${variant} 说明文字`, variant })}
            label={variant}
          />
        ))}
        <Button
          variant="secondary"
          onClick={() =>
            toast.toast({
              title: '已删除会话',
              description: '“本周周报”已移到回收站。',
              variant: 'info',
              action: { label: '撤销', onClick: () => undefined },
            })
          }
          label="with action"
        />
      </div>
    );
  },
};

export const Seeded: Story = {
  render: () => {
    const toast = useToast();
    useEffect(() => {
      for (const variant of VARIANTS) {
        toast.toast({ title: `${variant} 标题`, description: `${variant} 说明文字`, variant, duration: 0 });
      }
    }, [toast]);
    return <div style={{ minHeight: 360 }} />;
  },
};

export const WithActionSeeded: Story = {
  render: () => {
    const toast = useToast();
    useEffect(() => {
      toast.toast({
        title: '已删除会话',
        description: '“本周周报”已移到回收站。',
        variant: 'info',
        duration: 0,
        action: { label: '撤销', onClick: () => undefined },
      });
    }, [toast]);
    return <div style={{ minHeight: 120 }} />;
  },
};

export const ConfirmSeeded: Story = {
  render: () => {
    const toast = useToast();
    useEffect(() => {
      void toast.confirm({ title: '删除项目？', description: '此操作不可撤销。', confirmLabel: '删除', destructive: true });
    }, [toast]);
    return <div style={{ minHeight: 200 }} />;
  },
};

export const ConfirmPlain: Story = {
  render: () => {
    const toast = useToast();
    const [result, setResult] = useState<string>('（未触发）');
    return (
      <div style={{ display: 'grid', gap: 12, padding: 24, width: 360 }}>
        <span style={{ color: 'var(--muted-foreground)', fontSize: 12 }}>结果：{result}</span>
        <Button
          variant="secondary"
          onClick={async () => {
            const ok = await toast.confirm({ title: '保存修改？', confirmLabel: '保存' });
            setResult(ok ? '已确认' : '已取消');
          }}
          label="普通 confirm"
        />
      </div>
    );
  },
};
