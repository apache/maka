import type { ReactNode } from 'react';
import { Card, Item } from '@astryxdesign/core';

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
    <span className="settingsReadOnlyValue" data-mono={props.mono ? 'true' : undefined}>
      {props.value}
    </span>
  );
  return (
    <Item
      label={props.title}
      description={props.detail}
      align="start"
      endContent={props.action
        ? <span className="settingsReadOnlyValueGroup">{value}{props.action}</span>
        : value}
    />
  );
}
