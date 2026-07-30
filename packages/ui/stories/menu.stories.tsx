import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Plus, Trash2 } from '@maka/ui/icons';
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
} from '../src/primitives/menu.js';

const meta = {
  title: 'Primitives/Menu',
  parameters: {
    layout: 'padded',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function OpenMenuCell({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ minHeight: 220, minWidth: 180 }}>
      <Menu
        isMenuOpen
        button={{ label, variant: 'secondary', size: 'sm' }}
      >
        {children}
      </Menu>
    </div>
  );
}

export const Basic: Story = {
  render: () => (
    <Menu button={{ label: '打开菜单', variant: 'secondary' }}>
      <MenuItem label="新建文件" />
      <MenuItem label="打开…" />
      <MenuItem label="保存" endContent={<MenuShortcut>⌘S</MenuShortcut>} />
      <MenuSeparator />
      <MenuItem
        label="删除"
        icon={<Trash2 size={14} aria-hidden="true" />}
        style={{ color: 'var(--destructive-text)' }}
      />
    </Menu>
  ),
};

function SelectionExamples() {
  const [showLines, setShowLines] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [theme, setTheme] = useState('system');
  return (
    <>
      <OpenMenuCell label="checkbox">
        <MenuCheckboxItem
          label="显示行号"
          value={showLines}
          onChange={setShowLines}
        />
        <MenuCheckboxItem label="自动换行" value={wrap} onChange={setWrap} />
      </OpenMenuCell>
      <OpenMenuCell label="radio">
        <MenuRadioGroup
          value={theme}
          onChange={setTheme}
          aria-label="主题"
        >
          <MenuRadioItem value="light" label="浅色" />
          <MenuRadioItem value="dark" label="深色" />
          <MenuRadioItem value="system" label="跟随系统" />
        </MenuRadioGroup>
      </OpenMenuCell>
    </>
  );
}

export const OpenMatrix: Story = {
  render: () => (
    <div
      style={{
        display: 'grid',
        gap: 48,
        padding: 40,
        gridTemplateColumns: 'repeat(3, 200px)',
      }}
    >
      <OpenMenuCell label="basic">
        <MenuSeparator label="文件" />
        <MenuItem label="新建文件" />
        <MenuItem label="打开…" />
        <MenuSeparator />
        <MenuItem
          label="删除"
          style={{ color: 'var(--destructive-text)' }}
        />
      </OpenMenuCell>

      <OpenMenuCell label="shortcuts">
        <MenuItem label="新建" endContent={<MenuShortcut>⌘N</MenuShortcut>} />
        <MenuItem label="打开" endContent={<MenuShortcut>⌘O</MenuShortcut>} />
        <MenuItem label="保存" endContent={<MenuShortcut>⌘S</MenuShortcut>} />
      </OpenMenuCell>

      <SelectionExamples />

      <OpenMenuCell label="flat export actions">
        <MenuItem
          icon={<Plus size={14} aria-hidden="true" />}
          label="新建"
        />
        <MenuSeparator label="导出为" />
        <MenuItem label="PDF" />
        <MenuItem label="Markdown" />
        <MenuItem label="HTML" />
      </OpenMenuCell>

      <OpenMenuCell label="icons">
        <MenuItem
          icon={<Plus size={14} aria-hidden="true" />}
          label="新建"
        />
        <MenuItem
          icon={<Trash2 size={14} aria-hidden="true" />}
          label="删除"
          style={{ color: 'var(--destructive-text)' }}
        />
      </OpenMenuCell>
    </div>
  ),
};
