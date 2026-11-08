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

import { Canvas, platform, Scroll, signal, Text, View, windowSize, type JSX } from 'nsh';
import type { InputRef, ScrollRef } from 'nsh';
import { Button, Input, Select } from 'nsh/base';
import { ChoiceIndicator } from './ChoiceIndicator';
import { Icon } from './Icon';
import { tr } from './locale';
import {
  C,
  captionTextStyle,
  controlDisabledStyle,
  controlFocusStyle,
  controlHoverStyle,
  controlStyle,
  inputBorderRadius,
  inputTextStyle,
} from './ui';

const terminal = platform.idiom === 'terminal';
/** The page's side margin; groups start here. */
export const settingsGutter = terminal ? 0 : 24;
/** Where text starts inside a group; the title, section names and notes align to it. */
export const settingsInset = terminal ? 0 : 12;
const inset = settingsInset;
const rowStyle = {
  minHeight: terminal ? 16 : 44,
  paddingHorizontal: inset,
  paddingVertical: terminal ? 0 : 8,
  flexDirection: 'row',
  alignItems: 'center',
  gap: 12,
} as const;
const labelStyle = { fontSize: 14, lineHeight: terminal ? 16 : 20 };
const textGap = terminal ? 0 : 2;

function SettingsFooter(props: { render: () => JSX.Element | undefined }) {
  const content = props.render();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        flexWrap: 'wrap',
        gap: 8,
        paddingHorizontal: terminal ? 0 : 16,
        paddingVertical: terminal ? 0 : 12,
        borderTopWidth: 1,
        borderTopColor: C.line,
      }}
    >
      {content}
    </View>
  );
}

/**
 * A settings page below the panel's title row: its sections scroll, its footer
 * (Save, Cancel) stays in view.
 */
export function SettingsBody(props: {
  children: JSX.Element;
  footer?: JSX.Element;
  footerShown?: boolean;
  ref?: (node: ScrollRef) => void;
  accessibilityLabel?: string;
}) {
  const hasFooter = 'footer' in props;
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <Scroll
        ref={props.ref}
        accessibilityLabel={props.accessibilityLabel}
        style={{ flex: 1, minHeight: 0 }}
      >
        <View
          style={{
            paddingHorizontal: settingsGutter,
            paddingTop: terminal ? 0 : 4,
            paddingBottom: terminal ? 0 : 24,
            gap: terminal ? 16 : 24,
          }}
        >
          {props.children}
        </View>
      </Scroll>
      <If when={'footerShown' in props ? props.footerShown : hasFooter}>
        <SettingsFooter render={() => props.footer} />
      </If>
    </View>
  );
}

/** Text under the title that explains the whole page. */
export function SettingsLede(props: { children: string }) {
  return (
    <Text
      style={{
        ...captionTextStyle,
        lineHeight: terminal ? 16 : 20,
        color: C.muted,
        paddingHorizontal: inset,
      }}
    >
      {props.children}
    </Text>
  );
}

/** A group of rows on `surface`, optionally named, with an optional note below. */
export function SettingsSection(props: {
  title?: string;
  trailing?: JSX.Element;
  note?: string;
  children: JSX.Element;
}) {
  return (
    <View style={{ gap: terminal ? 0 : 8 }}>
      <If when={props.title || props.trailing}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            minHeight: terminal ? 16 : 28,
            paddingLeft: inset,
          }}
        >
          <Text
            style={{
              ...captionTextStyle,
              lineHeight: terminal ? 16 : 20,
              fontWeight: '600',
              color: C.secondary,
              flex: 1,
              minWidth: 0,
            }}
          >
            {props.title ?? ''}
          </Text>
          {props.trailing}
        </View>
      </If>
      <View
        style={{
          backgroundColor: terminal ? undefined : C.surface,
          borderRadius: terminal ? 0 : 12,
          overflow: 'hidden',
        }}
      >
        {/* Every row draws the line above it; the first row's line falls outside the clip. */}
        <View style={{ marginTop: terminal ? 0 : -1 }}>{props.children}</View>
      </View>
      <If when={props.note}>
        <Text style={{ ...captionTextStyle, color: C.muted, paddingHorizontal: inset }}>
          {props.note}
        </Text>
      </If>
    </View>
  );
}

function RowLine() {
  return (
    <If when={!terminal}>
      <View
        style={[
          {
            position: 'absolute',
            top: 0,
            left: inset,
            right: 0,
            height: 1,
            backgroundColor: C.line,
          },
          { pointerEvents: 'none' },
        ]}
      />
    </If>
  );
}

export type SettingsRowProps = {
  label: string;
  description?: string;
  /** Something that needs action, in `warning`. */
  status?: string;
  leading?: JSX.Element;
  trailing?: JSX.Element;
  tone?: 'muted' | 'danger';
  /** A page below: draws the chevron. */
  opens?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
  disabled?: boolean;
  selected?: boolean;
};

export function SettingsRow(props: SettingsRowProps) {
  const content = () => (
    <>
      {props.leading}
      <View style={[{ flex: 1, minWidth: 0, gap: textGap }, { pointerEvents: 'none' }]}>
        <Text
          style={[
            {
              ...labelStyle,
              color: props.tone === 'danger' ? C.danger : props.tone === 'muted' ? C.muted : C.text,
            },
            { numberOfLines: 1, textOverflow: 'ellipsis' },
          ]}
        >
          {props.label}
        </Text>
        <If when={props.description}>
          <Text style={{ ...captionTextStyle, color: C.muted }}>{props.description}</Text>
        </If>
      </View>
      <If when={props.status}>
        <Text style={[{ ...captionTextStyle, color: C.warning }, { pointerEvents: 'none' }]}>
          {props.status}
        </Text>
      </If>
      {props.trailing}
      <If when={props.opens}>
        <Icon name="right" color={C.muted} />
      </If>
    </>
  );
  return props.onPress ? (
    <Button
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      disabled={props.disabled}
      selected={props.selected}
      onPress={props.onPress}
      style={{ ...rowStyle, justifyContent: 'flex-start' }}
      hoverStyle={{ backgroundColor: C.raised }}
      activeStyle={{ backgroundColor: C.line }}
      focusStyle={{ backgroundColor: C.raised }}
      disabledStyle={controlDisabledStyle}
    >
      <RowLine />
      {content()}
    </Button>
  ) : (
    <View style={rowStyle}>
      <RowLine />
      {content()}
    </View>
  );
}

/** An immediate on/off setting: the whole row toggles it. */
export function SettingsSwitch(props: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onPress(): void;
  trailing?: JSX.Element;
  status?: string;
  /** Names the action instead of the state, such as "Enable Codex". */
  accessibilityLabel?: string;
}) {
  return (
    <SettingsRow
      label={props.label}
      description={props.description}
      status={props.status}
      accessibilityLabel={
        props.accessibilityLabel ??
        tr('{label}: {state}', {
          label: props.label,
          state: props.checked ? tr('On') : tr('Off'),
        })
      }
      selected={props.checked}
      disabled={props.disabled}
      onPress={props.onPress}
      trailing={
        <>
          {props.trailing}
          <ChoiceIndicator kind="switch" checked={props.checked} disabled={props.disabled} />
        </>
      }
    />
  );
}

export type SettingsChoice = {
  value: string;
  title: string;
  disabled?: boolean;
  group?: string;
  detail?: string;
};

/** One of several values, chosen from a menu at the row's end. */
export function SettingsSelect(props: {
  label: string;
  description?: string;
  value: string | null;
  choices: SettingsChoice[];
  disabled?: boolean;
  placeholder?: string;
  /** Drawn before the current value, such as a palette swatch. */
  preview?: JSX.Element;
  change(value: string): void;
}) {
  const current = () => props.choices.find((choice) => choice.value === props.value);
  return (
    <View style={rowStyle}>
      <RowLine />
      <View style={[{ flex: 1, minWidth: 0, gap: textGap }, { pointerEvents: 'none' }]}>
        <Text style={{ ...labelStyle, color: C.text }}>{props.label}</Text>
        <If when={props.description}>
          <Text style={{ ...captionTextStyle, color: C.muted }}>{props.description}</Text>
        </If>
      </View>
      <Select
        items={props.choices}
        value={props.value}
        onChange={({ value }) => {
          if (value !== null && value !== props.value) props.change(value);
        }}
        accessibilityLabel={props.label}
        disabled={props.disabled}
        offset={4}
        margin={8}
        align="end"
        popupStyle={{
          minWidth: 200,
          maxWidth: Math.max(0, windowSize().width - 16),
          maxHeight: Math.min(360, Math.max(0, windowSize().height - 16)),
          minHeight: 0,
          padding: 4,
          backgroundColor: C.surface,
          borderWidth: 1,
          borderColor: C.line,
          borderRadius: 12,
        }}
        groupStyle={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 }}
        style={{ flexShrink: 1, minWidth: 0, maxWidth: '60%' }}
        trigger={
          <View
            style={{
              minHeight: terminal ? 16 : 28,
              paddingLeft: terminal ? 0 : 10,
              paddingRight: terminal ? 0 : 6,
              borderRadius: 8,
              backgroundColor: terminal ? undefined : C.raised,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              minWidth: 0,
            }}
            hoverStyle={{ backgroundColor: C.line }}
            focusStyle={controlFocusStyle()}
            disabledStyle={controlDisabledStyle}
          >
            {props.preview}
            <Text
              style={[
                { ...captionTextStyle, lineHeight: terminal ? 16 : 20, color: C.text, minWidth: 0 },
                { numberOfLines: 1, textOverflow: 'ellipsis' },
              ]}
            >
              {current()?.title ?? props.placeholder ?? ''}
            </Text>
            <If when={current()?.detail}>
              <Text
                style={[
                  {
                    ...captionTextStyle,
                    lineHeight: 20,
                    color: C.muted,
                    flexShrink: 1,
                    minWidth: 0,
                  },
                  { numberOfLines: 1, textOverflow: 'ellipsis' },
                ]}
              >
                {`· ${current()?.detail}`}
              </Text>
            </If>
            <Icon name="down" color={C.muted} size={14} />
          </View>
        }
        itemClass={`rounded-lg focus:bg-[${C.raised}]`}
        renderItem={(item) => (
          <View
            style={{
              ...controlStyle,
              minHeight: 32,
              paddingVertical: 6,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ ...captionTextStyle, color: item.disabled ? C.muted : C.text }}>
                {item.title}
              </Text>
              <If when={(item as SettingsChoice).detail}>
                <Text style={{ ...captionTextStyle, color: C.muted }}>
                  {(item as SettingsChoice).detail}
                </Text>
              </If>
            </View>
            <If when={item.value === props.value}>
              <Icon name="check" color={C.accent} size={14} />
            </If>
          </View>
        )}
      />
    </View>
  );
}

const fieldStyle = (disabled?: boolean, error?: boolean) => ({
  ...inputTextStyle,
  color: disabled ? C.muted : C.text,
  placeholderColor: C.muted,
  backgroundColor: C.background,
  borderWidth: 1,
  borderColor: error ? C.danger : C.line,
  borderRadius: inputBorderRadius,
  paddingHorizontal: terminal ? 0 : 10,
  paddingVertical: terminal ? 0 : 4,
});

/** Two or three short choices shown side by side; each is a button named by its title. */
export function SettingsSegmented(props: {
  label: string;
  description?: string;
  value: string | null;
  choices: SettingsChoice[];
  disabled?: boolean;
  change(value: string): void;
}) {
  return (
    <SettingsRow
      label={props.label}
      description={props.description}
      trailing={
        <View style={{ flexDirection: 'row', gap: 4, flexShrink: 1 }}>
          <Each of={props.choices} key={(choice) => choice.value}>
            {(choice) => (
              <SettingsButton
                label={choice().title}
                selected={choice().value === props.value}
                tone={choice().value === props.value ? undefined : 'quiet'}
                disabled={props.disabled || choice().disabled}
                onPress={() => props.change(choice().value)}
              />
            )}
          </Each>
        </View>
      }
    />
  );
}

/** Several fields that belong together in one row, such as a name and its value. */
export function SettingsFields(props: { children: JSX.Element }) {
  return (
    <View style={rowStyle}>
      <RowLine />
      {props.children}
    </View>
  );
}

/** A field inside `SettingsFields`, named only for assistive technology and its placeholder. */
export function SettingsInlineInput(props: {
  label: string;
  value: string;
  change(value: string): void;
  placeholder?: string;
  masked?: boolean;
  disabled?: boolean;
  grow?: number;
}) {
  return (
    <Input
      accessibilityLabel={props.label}
      value={props.value}
      placeholder={props.placeholder ?? props.label}
      onChange={({ value }) => props.change(value)}
      masked={props.masked}
      readonly={props.disabled}
      autoCapitalize="none"
      autoCorrect={false}
      style={{
        ...fieldStyle(props.disabled),
        flex: props.grow ?? 1,
        minWidth: 0,
        height: terminal ? 16 : 28,
      }}
      focusStyle={{ borderColor: C.accent }}
    />
  );
}

/** Filters the groups below it; shown only once a list is too long to scan. */
export function SettingsSearch(props: {
  label: string;
  value: string;
  change(value: string): void;
  autoFocus?: boolean;
  ref?: (node: InputRef) => void;
  onSubmit?(): void;
}) {
  return (
    <Input
      ref={props.ref}
      accessibilityLabel={props.label}
      autoFocus={props.autoFocus}
      placeholder={`${props.label}…`}
      value={props.value}
      onChange={({ value }) => props.change(value)}
      onSubmit={props.onSubmit}
      submitBehavior="submit"
      autoCapitalize="none"
      autoCorrect={false}
      style={{ ...fieldStyle(), height: terminal ? 16 : 32, paddingHorizontal: inset }}
      focusStyle={{ borderColor: C.accent }}
    />
  );
}

/** A typed value in a row: label on the left, the field filling the right. */
export function SettingsInput(props: {
  label: string;
  description?: string;
  value: string;
  change(value: string): void;
  placeholder?: string;
  masked?: boolean;
  readonly?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  error?: string;
}) {
  return (
    <View style={{ ...rowStyle, alignItems: props.error ? 'flex-start' : 'center' }}>
      <RowLine />
      <View style={[{ width: '36%', minWidth: 0, gap: textGap }, { pointerEvents: 'none' }]}>
        <Text style={{ ...labelStyle, color: C.text }}>{props.label}</Text>
        <If when={props.description}>
          <Text style={{ ...captionTextStyle, color: C.muted }}>{props.description}</Text>
        </If>
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <Input
          accessibilityLabel={props.label}
          autoFocus={props.autoFocus}
          value={props.value}
          placeholder={props.placeholder}
          onChange={({ value }) => props.change(value)}
          masked={props.masked}
          readonly={props.readonly || props.disabled}
          autoCapitalize="none"
          autoCorrect={false}
          style={{ ...fieldStyle(props.disabled, !!props.error), height: terminal ? 16 : 28 }}
          focusStyle={{ borderColor: C.accent }}
        />
        <If when={props.error}>
          <Text style={{ ...captionTextStyle, color: C.danger }}>{props.error}</Text>
        </If>
      </View>
    </View>
  );
}

/**
 * Multi-line text sized in whole lines. While it is not being edited and holds
 * more than it shows, its last line fades into the background.
 */
export function SettingsTextArea(props: {
  label: string;
  value: string;
  change(value: string): void;
  lines?: number;
  placeholder?: string;
  readonly?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  monospace?: boolean;
  error?: string;
}) {
  const lineHeight = terminal ? 16 : 20;
  const padding = terminal ? 0 : 8;
  const visible = () => (props.lines ?? 8) * lineHeight;
  const focused = signal(false);
  const measured = signal(0);
  const text = () => ({
    ...inputTextStyle,
    lineHeight,
    ...(props.monospace ? { fontFamily: 'monospace', fontSize: 13 } : {}),
  });
  return (
    <View style={{ gap: 4, padding: inset }}>
      <RowLine />
      <View style={{ height: visible() + 2 * padding + 2, minHeight: 0 }}>
        <Input
          accessibilityLabel={props.label}
          autoFocus={props.autoFocus}
          value={props.value}
          placeholder={props.placeholder}
          onChange={({ value }) => props.change(value)}
          onFocus={() => focused.set(true)}
          onBlur={() => focused.set(false)}
          multiline
          submitBehavior="newline"
          readonly={props.readonly || props.disabled}
          autoCapitalize="none"
          autoCorrect={false}
          style={{
            ...fieldStyle(props.disabled, !!props.error),
            ...text(),
            paddingVertical: padding,
            paddingHorizontal: terminal ? 0 : 12,
            borderRadius: terminal ? 0 : 12,
            flex: 1,
          }}
          focusStyle={{ borderColor: C.accent }}
        />
        <If when={!terminal}>
          {/* Lays the text out at the editor's width to learn whether it overflows. */}
          <Text
            accessibilityElementsHidden
            onLayout={(event) => measured.set(event.bounds.size.height)}
            style={[
              {
                ...text(),
                position: 'absolute',
                left: 13,
                right: 13,
                top: 0,
                opacity: 0,
              },
              { pointerEvents: 'none' },
            ]}
          >
            {props.value}
          </Text>
          <If when={!focused() && measured() > visible()}>
            <Canvas
              accessibilityElementsHidden
              style={[
                { position: 'absolute', left: 1, right: 1, bottom: 1, height: 2 * lineHeight },
                { pointerEvents: 'none' },
              ]}
              draw={(cx, size) => {
                const fade = cx.createLinearGradient(0, 0, 0, size.height);
                fade.addColorStop(0, `${C.background}00`);
                fade.addColorStop(1, C.background);
                cx.fillStyle = fade;
                cx.beginPath();
                cx.roundRect(0, 0, size.width, size.height, [0, 0, 11, 11]);
                cx.fill();
              }}
            />
          </If>
        </If>
      </View>
      <If when={props.error}>
        <Text style={{ ...captionTextStyle, color: C.danger }}>{props.error}</Text>
      </If>
    </View>
  );
}

/** A command in a section header, a row or the footer. */
export function SettingsButton(props: {
  label: string;
  accessibilityLabel?: string;
  onPress(): void;
  disabled?: boolean;
  selected?: boolean;
  tone?: 'primary' | 'quiet' | 'danger';
  icon?: 'plus' | 'refresh' | 'trash';
  /** Shows only the icon; the label still names the button. */
  iconOnly?: boolean;
}) {
  const primary = () => props.tone === 'primary';
  const quiet = () => props.tone === 'quiet';
  return (
    <Button
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      disabled={props.disabled}
      selected={props.selected}
      onPress={props.onPress}
      style={{
        ...controlStyle,
        minHeight: terminal ? controlStyle.minHeight : 28,
        paddingVertical: terminal ? controlStyle.paddingVertical : 4,
        paddingHorizontal: quiet() ? 8 : 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        flexShrink: 0,
        backgroundColor: primary() ? C.accent : quiet() ? undefined : C.raised,
      }}
      hoverStyle={primary() ? { backgroundColor: C.accentHover } : controlHoverStyle()}
      activeStyle={primary() ? { backgroundColor: C.accentHover } : { backgroundColor: C.line }}
      focusStyle={primary() ? { backgroundColor: C.accentHover } : controlFocusStyle()}
      disabledStyle={controlDisabledStyle}
    >
      <If when={props.icon}>
        <Icon name={props.icon!} color={primary() ? C.background : C.secondary} size={14} />
      </If>
      <If when={!props.iconOnly}>
        <Text
          style={{
            ...captionTextStyle,
            lineHeight: terminal ? 16 : 20,
            fontWeight: primary() ? '500' : undefined,
            color: primary()
              ? C.background
              : props.tone === 'danger'
                ? C.danger
                : quiet()
                  ? C.secondary
                  : C.text,
          }}
        >
          {props.label}
        </Text>
      </If>
    </Button>
  );
}

/** Cancel and Save for a page whose values apply together, after any page-specific command. */
export function SettingsFormFooter(props: {
  saveLabel: string;
  canSave: boolean;
  busy: boolean;
  save(): void;
  cancel(): void;
  extra?: JSX.Element;
}) {
  return (
    <>
      {props.extra}
      <SettingsButton
        label={tr('Cancel')}
        tone="quiet"
        disabled={props.busy}
        onPress={props.cancel}
      />
      <SettingsButton
        label={tr('Save')}
        accessibilityLabel={props.saveLabel}
        tone="primary"
        disabled={!props.canSave}
        onPress={props.save}
      />
    </>
  );
}

/**
 * A failed read, where its data would be, with the way back. The reason already
 * shows under the title when the settings dialog reported it.
 */
export function SettingsProblem(props: { message?: string; retry?: () => void }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: inset,
        minHeight: terminal ? 16 : 28,
      }}
    >
      <If when={props.message}>
        <Text style={[{ ...captionTextStyle, color: C.danger, flex: 1 }, { userSelect: 'text' }]}>
          {props.message}
        </Text>
      </If>
      <If when={props.retry}>
        <SettingsButton label={tr('Retry')} onPress={props.retry!} />
      </If>
    </View>
  );
}

/** Asks before a destructive or discarding action; it replaces the page body. */
export function SettingsConfirm(props: {
  title: string;
  body?: string;
  confirm: string;
  cancel?: string;
  destructive?: boolean;
  disabled?: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <SettingsBody
      footer={
        <>
          <SettingsButton
            label={props.cancel ?? tr('Cancel')}
            tone="quiet"
            disabled={props.disabled}
            onPress={props.onCancel}
          />
          <SettingsButton
            label={props.confirm}
            tone={props.destructive ? 'danger' : 'primary'}
            disabled={props.disabled}
            onPress={props.onConfirm}
          />
        </>
      }
    >
      <View style={{ gap: 8, paddingHorizontal: inset }}>
        <Text style={{ fontSize: 14, lineHeight: 20, fontWeight: '600', color: C.text }}>
          {props.title}
        </Text>
        <If when={props.body}>
          <Text style={{ ...captionTextStyle, lineHeight: 20, color: C.secondary }}>
            {props.body}
          </Text>
        </If>
      </View>
    </SettingsBody>
  );
}
