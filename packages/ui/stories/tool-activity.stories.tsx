import { useEffect, useRef } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent } from 'storybook/test';
import { ToolActivity } from '../src/tool-activity.js';
import type { ToolActivityItem } from '../src/materialize.js';
import {
  denseMixedResultItems,
  errorsAndPermissionDeniedItems,
  fileDiffAndWebSearchItems,
  statusOverviewItems,
  subagentAndExploreItems,
  terminalAndLiveOutputItems,
} from './tool-activity.fixtures.js';

// Fidelity convention (#1433): every story below names the real app path
// that reaches it. See apps/desktop/stories/FIDELITY.md.

const meta = {
  title: 'Product/Tool Activity',
  component: ToolActivity,
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof ToolActivity>;

export default meta;

type Story = StoryObj<typeof meta>;

function ToolActivityBoard(props: {
  items: ToolActivityItem[];
  width?: number;
  expandAll?: boolean;
  autoCopyLabel?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!props.autoCopyLabel) return;
    const root = rootRef.current;
    if (!root) return;
    const currentRoot = root;

    const originalClipboard = navigator.clipboard;
    let clipboardPatched = false;
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async () => undefined },
      });
      clipboardPatched = true;
    } catch {
      clipboardPatched = false;
    }

    function clickCopyButton() {
      const buttons = Array.from(currentRoot.querySelectorAll<HTMLButtonElement>('button'));
      const button = buttons.find((candidate) => {
        const label = candidate.getAttribute('aria-label') ?? '';
        const text = candidate.textContent ?? '';
        return label.includes(props.autoCopyLabel ?? '') || text.includes(props.autoCopyLabel ?? '');
      });
      button?.click();
    }

    clickCopyButton();
    const interval = window.setInterval(clickCopyButton, 900);
    return () => {
      window.clearInterval(interval);
      if (!clipboardPatched) return;
      try {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: originalClipboard,
        });
      } catch {
        // Story-only clipboard mocking is best effort.
      }
    };
  }, [props.autoCopyLabel, props.items]);

  return (
    <div
      ref={rootRef}
      style={{
        display: 'grid',
        gap: 16,
        margin: '0 auto',
        maxWidth: props.width ?? 960,
        width: '100%',
      }}
    >
      <ToolActivity items={props.items} open={props.expandAll ? true : undefined} />
    </div>
  );
}

// Real path: any turn where the agent calls tools — this is the row's status set
// (running / done / failed), collected side by side for review.
export const StatusOverview: Story = {
  args: { items: statusOverviewItems },
  render: (args) => <ToolActivityBoard items={args.items} width={860} />,
};

// Real path: keyboard users inspect a settled tool row. This interaction locks
// Astryx's trigger/content ownership, full-row hit target, and collapsed
// hit-testing without duplicating those mechanics in Maka.
export const DisclosureInteraction: Story = {
  args: { items: statusOverviewItems.slice(0, 1) },
  render: (args) => <ToolActivityBoard items={args.items} width={860} />,
  play: async ({ canvasElement }) => {
    const root = canvasElement.querySelector<HTMLElement>('.astryx-collapsible');
    const trigger = root?.querySelector<HTMLButtonElement>('button[aria-controls]');
    const content = trigger?.getAttribute('aria-controls')
      ? canvasElement.querySelector<HTMLElement>(`#${CSS.escape(trigger.getAttribute('aria-controls') ?? '')}`)
      : null;
    await expect(root).toBeTruthy();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(content ? getComputedStyle(content).display : null).toBe('none');
    await expect(Math.round(trigger?.getBoundingClientRect().width ?? 0)).toBe(Math.round(root?.getBoundingClientRect().width ?? -1));
    trigger?.focus();
    await userEvent.keyboard('{Enter}');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(content ? getComputedStyle(content).display : null).not.toBe('none');
    const label = trigger?.firstElementChild?.getBoundingClientRect();
    const chevron = trigger?.lastElementChild?.getBoundingClientRect();
    await expect(Math.abs(((label?.top ?? 0) + (label?.height ?? 0) / 2) - ((chevron?.top ?? 0) + (chevron?.height ?? 0) / 2))).toBeLessThan(2);
  },
};

// Real path: the agent runs a shell command → the terminal row streams its output live.
export const TerminalAndLiveOutput: Story = {
  args: { items: terminalAndLiveOutputItems },
  render: (args) => <ToolActivityBoard items={args.items} expandAll />,
};

// Real path: the agent edits a file or searches the web → the diff and search-result
// rows.
export const FileDiffAndWebSearch: Story = {
  args: { items: fileDiffAndWebSearchItems },
  render: (args) => <ToolActivityBoard items={args.items} expandAll />,
};

// Real path: the agent dispatches a subagent or an explore task → the nested activity
// rows.
export const SubagentAndExplore: Story = {
  args: { items: subagentAndExploreItems },
  render: (args) => <ToolActivityBoard items={args.items} expandAll />,
};

// Real path: a tool call fails, or the user denies it in the permission prompt → the
// failed and denied rows.
export const ErrorsAndPermissionDenied: Story = {
  args: { items: errorsAndPermissionDeniedItems },
  render: (args) => <ToolActivityBoard items={args.items} width={860} />,
};

// Real path: click copy on a tool row → the transient copied state.
export const CopyFeedback: Story = {
  args: { items: errorsAndPermissionDeniedItems },
  render: (args) => <ToolActivityBoard items={args.items} width={860} autoCopyLabel="复制" />,
};

// Real path: a turn that mixes many tool kinds — the density case reviewers compare
// spacing against.
export const DenseMixedResults: Story = {
  args: { items: denseMixedResultItems },
  render: (args) => <ToolActivityBoard items={args.items} expandAll />,
};
