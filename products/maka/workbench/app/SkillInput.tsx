/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { ComposerInput, type ComposerInputRef, type ComposerInputState } from 'maka/host';
import { cleanup, effect, keymap, signal, untracked, View } from 'nsh';
import type { CaretEvent, StyleProp, TextStyle } from 'nsh';
import type { ComposerEditor, EditorKeyOptions } from './ComposerEditor';
import { lucide } from './lucide';
import { C, bodyTextStyle } from './ui';

type Selection = { start: number; end: number };
type Props = {
  ref?(node: ComposerEditor): void;
  testID?: string;
  accessibilityLabel: string;
  value: string;
  readonly: boolean;
  fieldText?: typeof bodyTextStyle;
  onContentHeight?(height: number): void;
  sourceId?: string;
  sourceOffset?: number;
  placeholder: string;
  autoFocus: boolean;
  style?: StyleProp<TextStyle>;
  onChange?(event: { value: string }): void;
  onSelectionChange?(event: Selection): void;
  onCaretMove?(event: CaretEvent): void;
  onSubmit?(event: { text: string }): void;
  onPaste?(event: { text: string; uris: string[]; files: unknown[] }): void;
  onFocus?(): void;
  onBlur?(): void;
  onEscape?(): void;
  onFileDrop?(event: { uris: string[] }): void;
  onFileDragEnter?(): void;
  onFileDragLeave?(): void;
};
type Binding = { key: string; action: () => void; options?: EditorKeyOptions };

/** Product-owned plain-text composer; skills are inline atoms in the existing rich editor. */
export function SkillInput(props: Props) {
  const native = signal<ComposerInputRef | null>(null);
  const status = signal<ComposerInputState | null>(null);
  const composition = signal(false);
  const valueCount = signal(0);
  const fieldText = () => props.fieldText ?? bodyTextStyle;
  const height = signal(fieldText().lineHeight);
  let alive = true;
  let frame: ReturnType<typeof requestAnimationFrame> | undefined;
  const captureKeys = signal<{ key: string; fallback: boolean }[]>([]);
  const bindings = new Map<object, Binding>();
  const refreshKeys = () => {
    const current = new Map<string, Binding>();
    for (const binding of bindings.values()) current.set(binding.key, binding);
    captureKeys.set([
      ...(!props.readonly && !current.has('escape') ? [{ key: 'escape', fallback: false }] : []),
      ...Array.from(current.values(), (binding) => ({
        key: binding.key,
        fallback: binding.options?.fallback ?? false,
      })),
    ]);
  };
  cleanup(() => {
    alive = false;
    bindings.clear();
    if (frame !== undefined) cancelAnimationFrame(frame);
  });
  effect(() => {
    props.readonly;
    untracked(refreshKeys);
  });
  const bindKey = (key: string, action: () => void, options?: EditorKeyOptions) => {
    const target = native()?.node;
    // These keystrokes reach the native input instead of RichEditor's key table.
    if (key === 'mod+v' || key === 'alt+v' || key === 'tab')
      return target
        ? keymap.bind(key, action, { when: 'always', within: target, ...options })
        : () => {};
    const ticket = {};
    bindings.set(ticket, { key, action, options });
    untracked(refreshKeys);
    return () => {
      if (!alive) return;
      bindings.delete(ticket);
      untracked(refreshKeys);
    };
  };
  effect(() => {
    const node = native();
    if (!node) return;
    let current = true;
    void node.status().then(
      (state) => {
        if (current && alive) {
          status.set(state);
          caretMoved();
        }
      },
      (error) => {
        if (current && alive) throw error;
      },
    );
    return () => {
      current = false;
    };
  });
  effect(() => {
    const node = native();
    const state = status();
    if (!node || !state) return;
    untracked(() => {
      props.ref?.({
        anchor: node.node,
        focus: () => node.focus(),
        blur: () => node.blur(),
        composing: () => {
          if (!alive) return false;
          // Subscribe to transitions while reading the native state for action guards.
          composition();
          return state.composing;
        },
        replaceRange: (request) => node.replaceRange(request),
        bindKey,
      });
      props.onSelectionChange?.(state.selection);
    });
  });
  effect(() => {
    const node = native();
    if (node && status() && props.autoFocus) node.focus();
  });
  const caretMoved = () => {
    if (frame !== undefined || !alive) return;
    frame = requestAnimationFrame(async () => {
      frame = undefined;
      if (!alive) return;
      const node = native();
      if (!node) return;
      try {
        const [measured, pageBounds] = await Promise.all([
          node.contentHeight(),
          node.caretBounds(),
        ]);
        if (!alive || native() !== node) return;
        if (measured !== null && measured > 0) {
          height.set(measured);
          props.onContentHeight?.(measured);
        }
        if (pageBounds) props.onCaretMove?.({ bounds: pageBounds, pageBounds });
      } catch (error) {
        if (alive) throw error;
      }
    });
  };
  const key = ({ key }: { key: string }) => {
    if (status()?.composing) return;
    const binding = Array.from(bindings.values())
      .reverse()
      .find((binding) => binding.key === key);
    if (binding) binding.action();
    else if (key === 'escape') props.onEscape?.();
  };
  return (
    <View
      style={[
        props.style,
        props.onContentHeight ? {} : { height: height(), minHeight: fieldText().lineHeight },
      ]}
      onFileDrop={props.onFileDrop}
      onFileDragEnter={props.onFileDragEnter}
      onFileDragLeave={props.onFileDragLeave}
      onLayout={caretMoved}
    >
      <ComposerInput
        ref={(node) => native.set(node)}
        testID={props.testID}
        accessibilityLabel={props.accessibilityLabel}
        value={props.value}
        sourceId={props.sourceId}
        sourceOffset={props.sourceOffset ?? 0}
        valueCount={valueCount()}
        readOnly={props.readonly}
        placeholder={props.placeholder}
        tokenColor={C.accent}
        tokenBackgroundColor={`${C.accent}20`}
        tokenIcon={lucide.book[0].d}
        captureKeys={captureKeys()}
        styles={{
          root: { ...fieldText(), color: C.text },
          content: { padding: 0 },
          caret: { backgroundColor: C.text },
          placeholder: { color: C.muted },
          nodes: { paragraph: fieldText() },
        }}
        style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}
        onChange={(event) => {
          valueCount.set(event.count);
          props.onChange?.({ value: event.value });
          caretMoved();
        }}
        onSelectionChange={(event) => {
          props.onSelectionChange?.(event);
          caretMoved();
        }}
        onCompositionChange={({ composing }) => composition.set(composing)}
        onSubmit={props.onSubmit}
        onKey={key}
        onPasteFiles={(event) =>
          props.onPaste?.({ text: '', uris: event.uris, files: event.files })
        }
        onFocus={props.onFocus}
        onBlur={props.onBlur}
      />
    </View>
  );
}
