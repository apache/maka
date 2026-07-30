import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { buttonVariants, cn, DialogClose, DialogContent, DialogRoot, Label } from '../src/ui.js';
import { Button } from '../src/index.js';
import { Input } from '../src/primitives/input.js';
import { Textarea } from '../src/primitives/textarea.js';

const meta = {
  title: 'Primitives/Dialog',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function DialogShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 16, padding: 24, placeItems: 'center', minHeight: '100%' }}>
      <p style={{ color: 'var(--muted-foreground)', fontSize: 12 }}>{title}</p>
      {children}
    </div>
  );
}

function ControlledDialog({
  triggerLabel,
  showClose = true,
  children,
}: {
  triggerLabel: string;
  showClose?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)} label={triggerLabel} />
      <DialogRoot open={open} onOpenChange={setOpen}>
        <DialogContent showClose={showClose}>{children}</DialogContent>
      </DialogRoot>
    </>
  );
}

function Footer({ onClose }: { onClose: () => void }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
      <Button variant="ghost" onClick={onClose} label="取消" />
      <Button variant="primary" onClick={onClose} label="确认" />
    </div>
  );
}

export const Basic: Story = {
  render: () => (
    <DialogShell title="点击按钮打开 dialog">
      <ControlledDialog triggerLabel="打开 dialog">
        <div style={{ display: 'grid', gap: 12, padding: 24, width: 360 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600 }}>基础 Dialog</h2>
          <p style={{ color: 'var(--muted-foreground)', fontSize: 14 }}>
            点击遮罩或右上角关闭按钮可关闭。DialogContent 默认带 showClose。
          </p>
        </div>
      </ControlledDialog>
    </DialogShell>
  ),
};

export const WithFooter: Story = {
  render: () => (
    <DialogShell title="带底部操作按钮">
      <ControlledDialogTriggerFooter />
    </DialogShell>
  ),
};

function ControlledDialogTriggerFooter() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)} label="打开（带操作）" />
      <DialogRoot open={open} onOpenChange={setOpen}>
        <DialogContent>
          <div style={{ display: 'grid', gap: 12, padding: 24, width: 360 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600 }}>带操作按钮</h2>
            <p style={{ color: 'var(--muted-foreground)', fontSize: 14 }}>
              底部按钮通过 onOpenChange 关闭。
            </p>
            <Footer onClose={() => setOpen(false)} />
          </div>
        </DialogContent>
      </DialogRoot>
    </>
  );
}

export const WithoutCloseButton: Story = {
  render: () => (
    <DialogShell title="showClose={false}，只能用底部按钮或 Esc 关闭">
      <ControlledDialog triggerLabel="打开（无关闭按钮）" showClose={false}>
        <div style={{ display: 'grid', gap: 12, padding: 24, width: 360 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600 }}>无关闭按钮</h2>
          <p style={{ color: 'var(--muted-foreground)', fontSize: 14 }}>
            showClose=false 时右上角不显示 X。
          </p>
        </div>
      </ControlledDialog>
    </DialogShell>
  ),
};

export const WithDialogClose: Story = {
  render: () => (
    <DialogShell title="用 DialogClose 作为自定义关闭按钮">
      <ControlledDialogClose />
    </DialogShell>
  ),
};

function ControlledDialogClose() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)} label="打开（DialogClose 关闭）" />
      <DialogRoot open={open} onOpenChange={setOpen}>
        <DialogContent showClose={false}>
          <div style={{ display: 'grid', gap: 12, padding: 24, width: 360 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600 }}>DialogClose 示例</h2>
            <p style={{ color: 'var(--muted-foreground)', fontSize: 14 }}>
              DialogClose 包裹的按钮点击后会自动关闭 dialog。
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              {/* #1565 PR 3: render-prop composition stays on legacy buttonVariants until its owning slice retires it. */}
              <DialogClose render={<button type="button" className={cn(buttonVariants({ variant: 'ghost' }))} />}>关闭</DialogClose>
            </div>
          </div>
        </DialogContent>
      </DialogRoot>
    </>
  );
}

export const FormDialog: Story = {
  render: () => (
    <DialogShell title="表单 dialog，验证 Input/Label/Textarea 在 portal 内排版">
      <ControlledDialogTriggerForm />
    </DialogShell>
  ),
};

function ControlledDialogTriggerForm() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)} label="打开表单" />
      <DialogRoot open={open} onOpenChange={setOpen}>
        <DialogContent>
          <div style={{ display: 'grid', gap: 14, padding: 24, width: 'min(92vw, 480px)' }}>
            <h2 style={{ fontSize: 16, fontWeight: 600 }}>编辑说明</h2>
            <div style={{ display: 'grid', gap: 6 }}>
              <Label htmlFor="dialog-title">标题</Label>
              <Input id="dialog-title" defaultValue="项目周报" />
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              <Label htmlFor="dialog-desc">描述</Label>
              <Textarea id="dialog-desc" defaultValue="本周完成了 Storybook P0 组件覆盖。" />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button variant="ghost" onClick={() => setOpen(false)} label="取消" />
              <Button variant="primary" onClick={() => setOpen(false)} label="保存" />
            </div>
          </div>
        </DialogContent>
      </DialogRoot>
    </>
  );
}

export const AlwaysOpen: Story = {
  render: () => (
    <DialogShell title="默认 open，验证 dialog 渲染（视觉回归快照）">
      <DialogRoot open>
        <DialogContent>
          <div style={{ display: 'grid', gap: 12, padding: 24, width: 360 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600 }}>常驻 open</h2>
            <p style={{ color: 'var(--muted-foreground)', fontSize: 14 }}>
              DialogRoot open 固定为 true，用于视觉回归快照。
            </p>
          </div>
        </DialogContent>
      </DialogRoot>
    </DialogShell>
  ),
};