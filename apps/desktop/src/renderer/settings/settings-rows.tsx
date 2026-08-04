import type { ReactNode } from 'react';
import { SettingsRow } from './settings-section';

/**
 * `value` is optional: a row may exist for what it explains and what it lets
 * you do, with nothing to read out. 输入历史 is one — naming its storage
 * mechanism told the user nothing they could act on, and the action beside it
 * is the whole point of the row.
 */
export function SettingRow(props: { title: string; detail: string; value?: string; mono?: boolean; action?: ReactNode }) {
  // `mono` means the value is machine text — a path, an id, a key. That is a
  // markup fact, and since the role table composes the code family for the
  // code element group, saying it in the markup is also what makes it render
  // monospaced. The layout rule (break-all, start) selects the same element,
  // so there is no second name for it: `code.settingsReadOnlyValue`.
  //
  // Layout differs by kind: a short human value rides the row's end slot,
  // but machine text (an absolute workspace path) squeezed into a
  // right-anchored 320px box wrapped into a ragged four-line block — the
  // audit's least readable row. Mono values render as a full-width line
  // under the description instead, where break-all reads as intended.
  if (props.mono) {
    return (
      <SettingsRow
        label={props.title}
        align="start"
        description={(
          <>
            {props.detail ? <span>{props.detail}</span> : null}
            <code className="settingsReadOnlyValue" data-mono="true">{props.value}</code>
          </>
        )}
        end={props.action ?? undefined}
      />
    );
  }
  const value = props.value ? <span className="settingsReadOnlyValue">{props.value}</span> : null;
  const end = props.action ? <>{value}{props.action}</> : value;
  return (
    <SettingsRow
      label={props.title}
      description={props.detail || undefined}
      align="start"
      end={end ?? undefined}
    />
  );
}
