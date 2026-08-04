import type { Meta, StoryObj } from '@storybook/react-vite';

// The autoplay contract the smoke harness depends on (#1981): Storybook's
// preview runtime executes `play` by default, and FIDELITY.md documents that
// a throwing play fails the smoke run. Both claims silently stop being true
// if a Storybook upgrade turns autoplay off — nothing else in CI would
// notice, because plays that no longer run can no longer fail.
//
// This story is the positive proof: its play flips a DOM marker, and the
// smoke manifest's `play-executed` check fails the run when the marker never
// flips. The surface is listed in REQUIRED_PRODUCT_SURFACES, so it cannot be
// switched off by deleting its manifest entry either.
const meta = {
  title: 'Design System/Harness Contracts',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const PlayExecutes: Story = {
  render: () => (
    <p data-play-proof="pending" style={{ font: 'var(--maka-text-body)' }}>
      play 未执行 — smoke 的 play-executed 检查应当失败
    </p>
  ),
  play: async ({ canvasElement }) => {
    const proof = canvasElement.querySelector('[data-play-proof]');
    if (!(proof instanceof HTMLElement)) {
      throw new Error('play contract story rendered without its proof node');
    }
    proof.dataset.playProof = 'executed';
    proof.textContent = 'play 已执行 — autoplay 契约成立';
  },
};
