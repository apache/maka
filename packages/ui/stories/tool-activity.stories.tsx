import { useEffect, useRef } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ToolActivity } from '../src/tool-activity.js';
import type { ToolActivityItem } from '../src/materialize.js';
import {
  denseMixedResultItems,
  errorsAndPermissionDeniedItems,
  fileDiffAndWebSearchItems,
  officeDocumentItems,
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
    if (!props.expandAll) return;
    const root = rootRef.current;
    if (!root) return;
    for (const item of root.querySelectorAll<HTMLDetailsElement>('details[data-slot="tool"]')) {
      item.open = true;
    }
  }, [props.expandAll, props.items]);

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
      <ToolActivity items={props.items} />
    </div>
  );
}

// Real path: any turn where the agent calls tools — this is the row's status set
// (running / done / failed), collected side by side for review.
export const StatusOverview: Story = {
  args: { items: statusOverviewItems },
  render: (args) => <ToolActivityBoard items={args.items} width={860} />,
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

// Real path: the agent reads an office document → the document preview row.
export const OfficeDocument: Story = {
  args: { items: officeDocumentItems },
  render: (args) => <ToolActivityBoard items={args.items} width={860} expandAll />,
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
