import type { Meta, StoryObj } from '@storybook/react-vite';
import { ClickableCard, Divider, IconButton, Stack, Text } from '../src/index.js';
import { Check, X } from '../src/icons.js';

// #1565 PR 3: net-new Astryx atoms render under the Maka theme before later
// surface slices start composing them.
const meta = {
  title: 'Primitives/Astryx Atoms',
  parameters: {
    layout: 'centered',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const TextTypes: Story = {
  render: () => (
    <Stack direction="vertical" gap={2}>
      <Text type="large">大号文本</Text>
      <Text>正文文本，跟随主题的 body 字体与字号。</Text>
      <Text color="secondary" size="sm">
        次级说明文本
      </Text>
      <Text maxLines={1} style={{ maxWidth: 160 }}>
        超长内容会按 maxLines 截断并显示省略号
      </Text>
    </Stack>
  ),
};

export const StackLayouts: Story = {
  render: () => (
    <Stack direction="vertical" gap={3}>
      <Stack direction="horizontal" gap={2} vAlign="center">
        <Text>横向</Text>
        <Text color="secondary">gap=2</Text>
      </Stack>
      <Stack direction="vertical" gap={1}>
        <Text>纵向</Text>
        <Text color="secondary">gap=1</Text>
      </Stack>
    </Stack>
  ),
};

export const IconButtons: Story = {
  render: () => (
    <Stack direction="horizontal" gap={2}>
      <IconButton label="确认" icon={<Check />} />
      <IconButton label="关闭" variant="ghost" icon={<X />} />
      <IconButton label="禁用" isDisabled icon={<X />} />
    </Stack>
  ),
};

export const ClickableCards: Story = {
  render: () => (
    <Stack direction="vertical" gap={2} width={280}>
      <ClickableCard label="打开会话" onClick={() => {}}>
        <Text>卡片内容</Text>
      </ClickableCard>
      <ClickableCard label="禁用卡片" isDisabled onClick={() => {}}>
        <Text color="secondary">不可点击</Text>
      </ClickableCard>
    </Stack>
  ),
};

export const Dividers: Story = {
  render: () => (
    <Stack direction="vertical" gap={3} width={280}>
      <Text>上方</Text>
      <Divider />
      <Text>下方</Text>
      <Stack direction="horizontal" gap={2} vAlign="center">
        <Text>左侧</Text>
        <Divider orientation="vertical" />
        <Text>右侧</Text>
      </Stack>
      <Divider label="更多设置" />
    </Stack>
  ),
};
