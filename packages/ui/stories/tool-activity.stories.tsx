import { useEffect, useRef } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ToolActivity } from '../src/tool-activity.js';
import type { ToolActivityItem } from '../src/materialize.js';
import {
  denseMixedResultItems,
  errorsAndPermissionDeniedItems,
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

// Real path: a tool call fails, or the user denies it in the permission prompt → the
// failed and denied rows.
export const ErrorsAndPermissionDenied: Story = {
  args: { items: errorsAndPermissionDeniedItems },
  render: (args) => <ToolActivityBoard items={args.items} width={860} />,
};

// Real path: a turn that mixes many tool kinds — the density case reviewers compare
// spacing against.
export const DenseMixedResults: Story = {
  args: { items: denseMixedResultItems },
  render: (args) => <ToolActivityBoard items={args.items} expandAll />,
};
