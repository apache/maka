import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Search } from '@maka/ui/icons';
import {
  Selector,
  type SelectorOptionData,
  type SelectorOptionType,
} from '../src/index.js';

const meta = {
  title: 'Primitives/Selector',
  parameters: {
    layout: 'padded',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;
const FRUITS: SelectorOptionData[] = [
  { value: 'apple', label: '苹果' },
  { value: 'banana', label: '香蕉' },
  { value: 'cherry', label: '樱桃' },
  { value: 'durian', label: '榴莲' },
];

const GROUPS: SelectorOptionType[] = [
  {
    type: 'section',
    title: '柑橘类',
    options: [
      { value: 'orange', label: '橙子' },
      { value: 'lemon', label: '柠檬' },
      { value: 'grapefruit', label: '柚子' },
    ],
  },
  {
    type: 'section',
    title: '浆果类',
    options: [
      { value: 'strawberry', label: '草莓' },
      { value: 'blueberry', label: '蓝莓' },
      { value: 'raspberry', label: '树莓' },
    ],
  },
];

export const Basic: Story = {
  render: () => {
    const [value, setValue] = useState('apple');
    return (
      <Selector
        value={value}
        options={FRUITS}
        onChange={setValue}
        label="选择水果"
        width={140}
      />
    );
  },
};

export const Grouped: Story = {
  render: () => {
    const [value, setValue] = useState('orange');
    return (
      <Selector
        value={value}
        options={GROUPS}
        onChange={setValue}
        label="选择水果（分组）"
        width={140}
      />
    );
  },
};

export const Disabled: Story = {
  render: () => (
    <Selector
      value="apple"
      options={FRUITS}
      onChange={() => {}}
      label="禁用选择器"
      isDisabled
      width={140}
    />
  ),
};

export const WithLeadingIcon: Story = {
  render: () => {
    const [value, setValue] = useState('apple');
    const options: SelectorOptionData[] = FRUITS.map((option) => ({
      ...option,
      icon: <Search key={option.value} size={14} strokeWidth={1.75} aria-hidden="true" />,
    }));
    return (
      <Selector
        value={value}
        options={options}
        onChange={setValue}
        label="带前缀图标的选择器"
        width={320}
      />
    );
  },
};
