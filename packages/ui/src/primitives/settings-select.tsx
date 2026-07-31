'use client';

import {
  Selector,
  SelectorOption,
  type SelectorOptionType,
} from '@astryxdesign/core/Selector';
import type { ReactElement, ReactNode } from 'react';

/**
 * Stable Maka select contract backed by Astryx Selector.
 *
 * Callers keep the tuple API while Astryx owns the trigger, native-popover
 * layer, listbox semantics, keyboard navigation, selected state, and styling.
 */
export type SettingsSelectOption<T extends string> =
  | readonly [T, string]
  | readonly [T, string, ReactNode];

export interface SettingsSelectOptionGroup<T extends string> {
  label: string;
  icon?: ReactNode;
  options: ReadonlyArray<SettingsSelectOption<T>>;
}

export interface SettingsSelectProps<T extends string> {
  value: T;
  options: ReadonlyArray<SettingsSelectOption<T>>;
  optionGroups?: ReadonlyArray<SettingsSelectOptionGroup<T>>;
  onChange(value: T): void;
  ariaLabel: string;
  disabled?: boolean;
  /** Visual width bucket for the field. Defaults to `'select'`. */
  width?: 'compact' | 'select' | 'full';
  /** Surface-owned layout hook applied to the Astryx field root. */
  className?: string;
}

const WIDTH: Record<
  NonNullable<SettingsSelectProps<string>['width']>,
  number | string
> = {
  compact: 140,
  select: 320,
  full: '100%',
};

function toOption<T extends string>(
  option: SettingsSelectOption<T>,
): { value: T; label: string; icon?: ReactNode } {
  const [value, label] = option;
  return {
    value,
    label,
    ...(option.length === 3 ? { icon: option[2] } : {}),
  };
}

export function SettingsSelect<T extends string>(
  props: SettingsSelectProps<T>,
): ReactElement {
  const groupedValues = new Set(
    props.optionGroups?.flatMap((group) =>
      group.options.map(([value]) => value),
    ),
  );
  const options: SelectorOptionType[] = [
    ...props.options
      .filter(([value]) => !groupedValues.has(value))
      .map(toOption),
    ...(props.optionGroups ?? []).map((group) => ({
      type: 'section' as const,
      title: group.label,
      options: group.options.map(toOption),
    })),
  ];
  const selected = props.options.find(([value]) => value === props.value);

  return (
    <Selector
      label={props.ariaLabel}
      isLabelHidden
      value={props.value}
      options={options}
      onChange={(value) => props.onChange(value as T)}
      isDisabled={props.disabled}
      width={WIDTH[props.width ?? 'select']}
      className={props.className}
      startIcon={selected?.length === 3 ? selected[2] : undefined}
      renderOption={(option) => (
        <SelectorOption
          icon={option.icon}
          label={option.label ?? option.value}
        />
      )}
    />
  );
}
