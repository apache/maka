import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { RadioList, RadioListItem } from '../src/index.js';

const meta = {
  title: 'Primitives/RadioList',
  parameters: {
    layout: 'centered',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Vertical: Story = {
  render: () => {
    const [value, setValue] = useState('a');
    return (
      <RadioList label="纵向选项" value={value} onChange={setValue}>
        <RadioListItem value="a" label="选项 A" />
        <RadioListItem value="b" label="选项 B" />
        <RadioListItem value="c" label="选项 C" />
      </RadioList>
    );
  },
};

export const Horizontal: Story = {
  render: () => {
    const [value, setValue] = useState('a');
    return (
      <RadioList label="横向选项" value={value} onChange={setValue} orientation="horizontal">
        <RadioListItem value="a" label="A" />
        <RadioListItem value="b" label="B" />
        <RadioListItem value="c" label="C" />
      </RadioList>
    );
  },
};

export const Disabled: Story = {
  render: () => <RadioListExample initial="a" disabledValue="b" />,
};

export const DefaultUncontrolled: Story = {
  render: () => <RadioListExample initial="b" />,
};

function RadioListExample({ initial, disabledValue }: { initial: string; disabledValue?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <RadioList label="示例选项" value={value} onChange={setValue}>
      <RadioListItem value="a" label="选项 A" />
      <RadioListItem value="b" label="选项 B" isDisabled={disabledValue === 'b'} />
      <RadioListItem value="c" label="选项 C" />
    </RadioList>
  );
}
