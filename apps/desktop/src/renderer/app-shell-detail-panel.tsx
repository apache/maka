import type { ComponentPropsWithoutRef } from 'react';

type AppShellDetailPanelProps = Omit<
  ComponentPropsWithoutRef<'div'>,
  'className' | 'data-agents-view'
> & {
  agentsView: 'skills' | 'mcp' | 'cron' | 'daily-review' | 'im_hub';
};

export function AppShellDetailPanel({
  agentsView,
  children,
  ...props
}: AppShellDetailPanelProps) {
  return (
    <div
      {...props}
      className="maka-panel maka-panel-detail maka-floating-panel agents-content-area agents-parchment-paper-surface"
      data-agents-view={agentsView}
    >
      {children}
    </div>
  );
}
