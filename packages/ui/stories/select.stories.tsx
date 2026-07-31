import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Search } from '@maka/ui/icons';
import {
  SettingsSelect,
  type SettingsSelectOption,
  type SettingsSelectOptionGroup,
} from '../src/primitives/settings-select.js';

const meta = {
  title: 'Primitives/Select',
  parameters: {
    layout: 'padded',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;
type Fruit = 'apple' | 'banana' | 'cherry' | 'durian';
type GroupedFruit =
  | 'orange'
  | 'lemon'
  | 'grapefruit'
  | 'strawberry'
  | 'blueberry'
  | 'raspberry';

const FRUITS: readonly SettingsSelectOption<Fruit>[] = [
  ['apple', '苹果'],
  ['banana', '香蕉'],
  ['cherry', '樱桃'],
  ['durian', '榴莲'],
] as const;

const GROUPS: readonly SettingsSelectOptionGroup<GroupedFruit>[] = [
  {
    label: '柑橘类',
    options: [
      ['orange', '橙子'],
      ['lemon', '柠檬'],
      ['grapefruit', '柚子'],
    ],
  },
  {
    label: '浆果类',
    options: [
      ['strawberry', '草莓'],
      ['blueberry', '蓝莓'],
      ['raspberry', '树莓'],
    ],
  },
] as const;

export const Basic: Story = {
  render: () => {
    const [value, setValue] = useState<Fruit>('apple');
    return (
      <SettingsSelect
        value={value}
        options={FRUITS}
        onChange={(next) => setValue(next as Fruit)}
        ariaLabel="选择水果"
        width="compact"
      />
    );
  },
};

export const Grouped: Story = {
  render: () => {
    const [value, setValue] = useState<GroupedFruit>('orange');
    return (
      <SettingsSelect
        value={value}
        options={GROUPS.flatMap((group) => group.options)}
        optionGroups={GROUPS}
        onChange={(next) => setValue(next as GroupedFruit)}
        ariaLabel="选择水果（分组）"
        width="compact"
      />
    );
  },
};

export const Disabled: Story = {
  render: () => (
    <SettingsSelect
      value="apple"
      options={FRUITS}
      onChange={() => {}}
      ariaLabel="禁用选择器"
      disabled
      width="compact"
    />
  ),
};

export const WithLeadingIcon: Story = {
  render: () => {
    const [value, setValue] = useState<Fruit>('apple');
    const options: readonly SettingsSelectOption<Fruit>[] = FRUITS.map(
      ([optionValue, label]) =>
        [
          optionValue,
          label,
          <Search key={optionValue} size={14} strokeWidth={1.75} aria-hidden="true" />,
        ] as const,
    );
    return (
      <SettingsSelect
        value={value}
        options={options}
        onChange={(next) => setValue(next as Fruit)}
        ariaLabel="带前缀图标的选择器"
        width="select"
      />
    );
  },
};
