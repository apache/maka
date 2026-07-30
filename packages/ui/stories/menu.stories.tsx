import type { Meta, StoryObj } from '@storybook/react-vite';
import { Plus, Trash2 } from '@maka/ui/icons';
import {
  Menu,
  MenuCheckboxItem,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from '../src/primitives/menu.js';
import { buttonVariants, cn } from '../src/ui.js';

const meta = {
  title: 'Primitives/Menu',
  parameters: {
    layout: 'padded',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function OpenMenuCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ minHeight: 220, minWidth: 180 }}>
      <Menu open>
        {/* #1565 PR 3: render-prop composition stays on legacy buttonVariants until its owning slice retires it. */}
        <MenuTrigger render={<button type="button" className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))} />}>{label}</MenuTrigger>
        <MenuPopup>{children}</MenuPopup>
      </Menu>
    </div>
  );
}

export const Basic: Story = {
  render: () => (
    <Menu>
      {/* #1565 PR 3: render-prop composition stays on legacy buttonVariants until its owning slice retires it. */}
      <MenuTrigger render={<button type="button" className={cn(buttonVariants({ variant: 'secondary' }))} />}>打开菜单</MenuTrigger>
      <MenuPopup>
        <MenuItem>新建文件</MenuItem>
        <MenuItem>打开…</MenuItem>
        <MenuItem>
          保存
          <MenuShortcut>⌘S</MenuShortcut>
        </MenuItem>
        <MenuSeparator />
        <MenuItem variant="destructive">删除</MenuItem>
      </MenuPopup>
    </Menu>
  ),
};

export const OpenMatrix: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 48, padding: 40, gridTemplateColumns: 'repeat(3, 200px)' }}>
      <OpenMenuCell label="basic">
        <MenuGroupLabel>文件</MenuGroupLabel>
        <MenuItem>新建文件</MenuItem>
        <MenuItem>打开…</MenuItem>
        <MenuSeparator />
        <MenuItem variant="destructive">删除</MenuItem>
      </OpenMenuCell>

      <OpenMenuCell label="shortcuts">
        <MenuItem>
          新建
          <MenuShortcut>⌘N</MenuShortcut>
        </MenuItem>
        <MenuItem>
          打开
          <MenuShortcut>⌘O</MenuShortcut>
        </MenuItem>
        <MenuItem>
          保存
          <MenuShortcut>⌘S</MenuShortcut>
        </MenuItem>
      </OpenMenuCell>

      <OpenMenuCell label="checkbox">
        <MenuCheckboxItem checked>显示行号</MenuCheckboxItem>
        <MenuCheckboxItem checked={false}>自动换行</MenuCheckboxItem>
      </OpenMenuCell>

      <OpenMenuCell label="radio">
        <MenuGroupLabel>主题</MenuGroupLabel>
        <MenuRadioGroup defaultValue="system">
          <MenuRadioItem value="light">浅色</MenuRadioItem>
          <MenuRadioItem value="dark">深色</MenuRadioItem>
          <MenuRadioItem value="system">跟随系统</MenuRadioItem>
        </MenuRadioGroup>
      </OpenMenuCell>

      <OpenMenuCell label="submenu">
        <MenuItem>新建</MenuItem>
        <MenuSub open>
          <MenuSubTrigger>导出为…</MenuSubTrigger>
          <MenuSubPopup>
            <MenuItem>PDF</MenuItem>
            <MenuItem>Markdown</MenuItem>
            <MenuItem>HTML</MenuItem>
          </MenuSubPopup>
        </MenuSub>
      </OpenMenuCell>

      <OpenMenuCell label="icons">
        <MenuItem>
          <Plus size={14} aria-hidden="true" />
          新建
        </MenuItem>
        <MenuItem variant="destructive">
          <Trash2 size={14} aria-hidden="true" />
          删除
        </MenuItem>
      </OpenMenuCell>
    </div>
  ),
};
