import { useEffect, useRef, useState } from 'react';
import { TextInput } from '@astryxdesign/core/TextInput';

/**
 * Titlebar rename field: focus+select on mount, Enter commits, Escape cancels,
 * blur commits. Guards IME Enter and Escape-then-blur double-fire.
 */
export function InlineRenameInput(props: {
  defaultValue: string;
  ariaLabel: string;
  className: string;
  onCommit(name: string, via: 'keyboard' | 'blur'): void;
  onCancel(): void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const escapeCancelledRef = useRef(false);
  const [value, setValue] = useState(props.defaultValue);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <TextInput
      ref={inputRef}
      className={props.className}
      label={props.ariaLabel}
      isLabelHidden
      size="sm"
      value={value}
      onChange={(next) => setValue(next.slice(0, 80))}
      onBlur={() => {
        if (escapeCancelledRef.current) {
          escapeCancelledRef.current = false;
          return;
        }
        props.onCommit(value.trim(), 'blur');
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.key === 'Process') return;
        if (event.key === 'Enter') {
          event.preventDefault();
          props.onCommit(value.trim(), 'keyboard');
        } else if (event.key === 'Escape') {
          event.preventDefault();
          escapeCancelledRef.current = true;
          props.onCancel();
        }
      }}
    />
  );
}
