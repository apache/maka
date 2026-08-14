import type { ComponentPropsWithoutRef } from 'react';

type AppShellDetailPanelProps = Omit<
  ComponentPropsWithoutRef<'div'>,
  'className' | 'data-agents-view'
> & {
  agentsView: 'skills' | 'mcp' | 'ui' | 'cron' | 'daily-review' | 'im_hub';
};

export function AppShellDetailPanel({
  agentsView,
  children,
  ...props
}: AppShellDetailPanelProps) {
  return (
    <div
      {...props}
      // No surface class: this frames the plates, it is not one. The content
      // surface is `.mainColumn` inside it — see shell-layout.css.
      className="maka-panel maka-panel-detail"
      data-agents-view={agentsView}
    >
      {children}
    </div>
  );
}
