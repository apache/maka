import type { ReactNode } from 'react';
import { Card } from '@maka/ui';

export function SettingsRows({ className, children }: { className?: string; children: ReactNode }) {
  // Astryx Card owns the card face (background, border, radius); rows.css
  // keeps only the row grid, container query, and overflow clipping.
  // padding={0} because the rows meet the card edge and carry their own
  // insets.
  return (
    <Card padding={0} className={className ? `settingsRows ${className}` : 'settingsRows'} data-maka-contract="settings-rows">
      {children}
    </Card>
  );
}

export function SettingRow(props: { title: string; detail: string; value: string; mono?: boolean; action?: ReactNode }) {
  const value = (
    <span data-mono={props.mono ? 'true' : undefined}>{props.value}</span>
  );
  return (
    <div className="settingsRow">
      <div>
        <strong>{props.title}</strong>
        <small>{props.detail}</small>
      </div>
      {/* mono: filesystem paths / identifiers — right-aligned proportional
          text wraps into a ragged multi-line block for long values.
          action: an optional per-row control (e.g. copy-curl on gateway
          endpoint rows) so row-scoped actions live ON the row instead of
          piling into a page-level button wall. */}
      {props.action ? (
        <span className="settingsRowValueGroup">
          {value}
          {props.action}
        </span>
      ) : (
        value
      )}
    </div>
  );
}
