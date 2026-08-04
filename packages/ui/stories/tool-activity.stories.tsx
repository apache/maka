import { useEffect, useRef } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ToolCallDetail, ToolTrow } from '../src/tool-activity.js';
import type { ToolActivityItem } from '../src/materialize.js';
import {
  denseMixedResultItems,
  errorsAndPermissionDeniedItems,
} from './tool-activity.fixtures.js';

// Fidelity convention (#1433): every story below names the real app path
// that reaches it. See apps/desktop/stories/FIDELITY.md.

const meta = {
  title: 'Product/Tool Activity',
  component: ToolTrow,
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof ToolTrow>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * One row per item. The product groups a contiguous run into a single
 * `ToolTrow`, which collapses to its latest row; rendering one trow per item
 * is how a state board shows every row at once.
 */
function ToolRowBoard(props: { items: ToolActivityItem[]; width?: number }) {
  return (
    <Board width={props.width}>
      {props.items.map((item) => (
        <ToolTrow key={item.toolUseId} items={[item]} />
      ))}
    </Board>
  );
}

/** The expanded panels, which Astryx reveals per row on click. */
function ToolDetailBoard(props: { items: ToolActivityItem[]; width?: number; autoCopyLabel?: string }) {
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
    <div ref={rootRef}>
      <Board width={props.width}>
        {props.items.map((item) => (
          <ToolCallDetail key={item.toolUseId} item={item} />
        ))}
      </Board>
    </div>
  );
}

function Board(props: { children: React.ReactNode; width?: number }) {
  return (
    <div
      style={{
        display: 'grid',
        gap: 16,
        margin: '0 auto',
        maxWidth: props.width ?? 960,
        width: '100%',
      }}
    >
      {props.children}
    </div>
  );
}

// Real path: a tool call fails, or the user denies it in the permission prompt → the
// failed and denied rows.
export const ErrorsAndPermissionDenied: Story = {
  args: { items: errorsAndPermissionDeniedItems },
  render: (args) => <ToolRowBoard items={args.items} width={860} />,
};

// Real path: a turn that mixes many tool kinds — the density case reviewers compare
// spacing against.
export const DenseMixedResults: Story = {
  args: { items: denseMixedResultItems },
  render: (args) => <ToolDetailBoard items={args.items} />,
};

// Real path: a contiguous run of tool calls in one turn — the grouped surface the
// state boards above never show, since they render one row per trow. Astryx's
// collapsed header projects the last call alone, so this is where to look at what a
// mixed-outcome group costs in density.
export const ContiguousGroup: Story = {
  args: { items: errorsAndPermissionDeniedItems },
  render: (args) => (
    <Board width={860}>
      <ToolTrow items={args.items} />
    </Board>
  ),
};
