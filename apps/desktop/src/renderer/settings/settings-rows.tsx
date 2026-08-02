import type { ReactNode } from 'react';
import { Item } from '@astryxdesign/core';

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
