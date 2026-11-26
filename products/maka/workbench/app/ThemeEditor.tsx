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

// Settings › General › Theme: a preset to start from, then each color and the
// font, seen on a sample of a conversation while a color is dragged, then on the whole window.
import { batch, cleanup, colorScheme, computed, signal, Text, View } from 'nsh';
import { Button, ColorArea, ColorField, ColorPicker, ColorSlider, Popover } from 'nsh/base';
import { tr } from './locale';
import { appearance, colorThemes } from './appearance';
import {
  contrast,
  derivedColors,
  fontChoice,
  fontChoices,
  fontFamilies,
  lookIds,
  lookTokens,
  minimumContrast,
  pickedColors,
  presetLooks,
  readable,
  sameLook,
  unchanged,
  type FontChoice,
  type Look,
  type LookColor,
  type LookId,
} from './look';
import {
  SettingsBody,
  SettingsButton,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from './SettingsPage';
import {
  C,
  captionTextStyle,
  codeTextStyle,
  defaultColors,
  floatingStyle,
  inputBorderRadius,
  lookColors,
  secondaryTextStyle,
} from './ui';

export const lookLabel = (id: LookId) =>
  ({
    default: tr('Default'),
    mono: tr('Monochrome'),
    paper: tr('Rice paper'),
    morandi: tr('Morandi'),
    terminal: tr('Retro terminal'),
    blueprint: tr('Blueprint'),
  })[id];

const colorLabel = (key: LookColor) =>
  ({
    background: tr('Background'),
    foreground: tr('Text'),
    primary: tr('Accent'),
    card: tr('Sidebar'),
    border: tr('Lines'),
    'muted-foreground': tr('Secondary text'),
  })[key];

const fontLabel = (choice: FontChoice | 'other') =>
  ({
    system: tr('System'),
    serif: tr('Serif'),
    mono: tr('Monospace'),
    geometric: tr('Geometric sans'),
    other: tr('Other font…'),
  })[choice];

export const themeLabel = (theme: (typeof colorThemes)[number]) =>
  ({ system: tr('Match system'), light: tr('Light'), dark: tr('Dark') })[theme];

/** The appearance whose colors are edited: the one the window shows. */
const mode = () => (colorScheme() === 'light' ? 'light' : 'dark');

/** The shown look with `key` set to `value`, or derived again when `value` is undefined. */
function withColor(key: LookColor, value: string | undefined): Look {
  const look = appearance.shown();
  const colors = { ...look.cssVars[mode()] };
  if (value === undefined) delete colors[key];
  else colors[key] = value;
  return { ...look, cssVars: { ...look.cssVars, [mode()]: colors } };
}

const withFont = (family: string | undefined): Look => {
  const look = appearance.shown();
  return {
    ...look,
    cssVars: { ...look.cssVars, theme: family ? { 'font-sans': family } : {} },
  };
};

/** The look a color picker is dragging through: the preview shows it at once, and the whole
 * window takes it when the drag ends, so a drag does not restyle every view at each step. */
const dragged = signal<Look | null>(null);
const pickedLook = () => dragged() ?? appearance.shown();
/** Follows a drag through `look`; when it ends, `save` gives the whole window the look. */
const pick = (look: Look, save: boolean) => {
  if (!save) return dragged.set(look);
  batch(() => {
    // A drag that ends where it began leaves the window's look as it is.
    if (!sameLook(look, appearance.shown())) appearance.changeLook(look, true);
    dragged.set(null);
  });
};
// Derived once for each step of a drag, for every row that shows a derived color.
const pickedTokens = computed(() => lookTokens(pickedLook().cssVars[mode()]));

/** The color a key has in effect for the appearance edited, picked or derived. */
function effective(key: LookColor): string {
  const picked = pickedLook().cssVars[mode()][key];
  if (picked !== undefined) return picked;
  const tokens = pickedTokens();
  return key === 'card' ? tokens.sidebar : key === 'border' ? tokens.line : tokens.muted;
}

export function ThemeEditor() {
  cleanup(() => dragged.set(null));
  return (
    <SettingsBody>
      <ThemeStatus />
      <SettingsSection>
        <SettingsSelect
          label={tr('Appearance')}
          value={appearance.theme()}
          choices={colorThemes.map((theme) => ({ value: theme, title: themeLabel(theme) }))}
          change={(value) => appearance.chooseTheme(value as (typeof colorThemes)[number])}
        />
      </SettingsSection>
      <SettingsSection title={tr('Presets')}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, padding: 12 }}>
          <Each of={lookIds} key={(id) => id}>
            {(id) => <PresetCard id={id()} />}
          </Each>
        </View>
      </SettingsSection>
      <SettingsSection title={tr('Preview')}>
        <Specimen />
      </SettingsSection>
      <SettingsSection title={tr('Colors')}>
        <Each of={[...pickedColors, ...derivedColors]} key={(key) => key}>
          {(key) => <ColorRow color={key()} />}
        </Each>
      </SettingsSection>
      <SettingsSection title={tr('Font')}>
        <FontRows />
      </SettingsSection>
    </SettingsBody>
  );
}

/** The look's name, undo and the way back to its preset, in the default colors: a look
 * whose text cannot be read still shows them. */
function ThemeStatus() {
  const fixed = () => defaultColors(colorScheme() !== 'light');
  const look = () => appearance.shown();
  const modified = () => !unchanged(look());
  const action = (label: string, onPress: () => void, disabled: () => boolean) => (
    <Button
      accessibilityLabel={label}
      disabled={disabled()}
      onPress={onPress}
      style={{
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: fixed().line,
        backgroundColor: fixed().background,
        opacity: disabled() ? 0.5 : 1,
      }}
      hoverStyle={{ backgroundColor: fixed().raised }}
    >
      <Text style={{ ...captionTextStyle, color: fixed().text }}>{label}</Text>
    </Button>
  );
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: fixed().surface,
        borderWidth: 1,
        borderColor: fixed().line,
      }}
    >
      <Text style={{ ...secondaryTextStyle, flex: 1, color: fixed().text }}>
        {modified()
          ? tr('Based on {preset} · Modified', { preset: lookLabel(look().base) })
          : lookLabel(look().base)}
      </Text>
      {action(tr('Undo'), appearance.undo, () => !appearance.canUndo())}
      {action(
        tr('Restore preset'),
        () => appearance.choosePreset(look().base),
        () => !modified(),
      )}
    </View>
  );
}

function PresetCard(props: { id: LookId }) {
  const colors = () => presetLooks[props.id].cssVars[mode()];
  const tokens = () => lookTokens(colors());
  const selected = () => appearance.shown().base === props.id;
  return (
    <Button
      accessibilityLabel={lookLabel(props.id)}
      selected={selected()}
      onPress={() => appearance.choosePreset(props.id)}
      style={{ width: 112, gap: 6, alignItems: 'center' }}
    >
      <View
        style={{
          width: 112,
          height: 72,
          flexDirection: 'row',
          borderRadius: 8,
          overflow: 'hidden',
          borderWidth: 2,
          borderColor: selected() ? C.accent : C.line,
          backgroundColor: colors().background,
        }}
      >
        <View style={{ width: 28, backgroundColor: tokens().sidebar }} />
        <View style={{ flex: 1, padding: 8, gap: 5, backgroundColor: colors().background }}>
          <View
            style={{ height: 5, width: '80%', borderRadius: 2, backgroundColor: tokens().text }}
          />
          <View
            style={{ height: 5, width: '60%', borderRadius: 2, backgroundColor: tokens().muted }}
          />
          <View
            style={{ height: 12, width: 32, borderRadius: 4, backgroundColor: tokens().accent }}
          />
        </View>
      </View>
      <Text style={{ ...captionTextStyle, color: selected() ? C.text : C.secondary }}>
        {lookLabel(props.id)}
      </Text>
    </Button>
  );
}

/** A piece of a conversation in the colors in effect: what the settings page has none of. */
function Specimen() {
  const C = lookColors(() => dragged() ?? appearance.look());
  const line = (text: string, color: string, extra: object = {}) => (
    <Text style={{ ...secondaryTextStyle, color, ...extra }}>{text}</Text>
  );
  return (
    <View style={{ padding: 12, gap: 10, backgroundColor: C.panel }}>
      <View
        style={{
          alignSelf: 'flex-end',
          maxWidth: '80%',
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderRadius: 12,
          backgroundColor: C.card,
        }}
      >
        {line(tr('Can you check this function?'), C.text)}
      </View>
      <Text style={{ ...secondaryTextStyle, color: C.text }}>
        {tr('It returns early when the list is empty.')}{' '}
        <Text style={{ color: C.accentText, textDecorationLine: 'underline' }}>
          {tr('See the notes.')}
        </Text>
      </Text>
      {line(tr('Ran the tests · 12 passed'), C.muted)}
      <View style={{ borderRadius: 6, padding: 8, backgroundColor: C.card, gap: 2 }}>
        <Text style={{ ...codeTextStyle, color: C.text, backgroundColor: C.removed }}>
          {'- if (items.length == 0) return;'}
        </Text>
        <Text style={{ ...codeTextStyle, color: C.text, backgroundColor: C.added }}>
          {'+ if (!items.length) return [];'}
        </Text>
      </View>
      {line(tr('Something needs your attention.'), C.warning)}
      <View
        style={{
          minHeight: 32,
          paddingHorizontal: 10,
          justifyContent: 'center',
          borderRadius: inputBorderRadius,
          borderWidth: 1,
          borderColor: C.line,
          backgroundColor: C.background,
        }}
      >
        {line(tr('Write a reply…'), C.muted)}
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View
          style={{
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: 8,
            backgroundColor: C.accent,
          }}
        >
          {line(tr('Send'), C.onAccent, { fontWeight: '600' })}
        </View>
        <View
          style={{
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: C.line,
          }}
        >
          {line(tr('Cancel'), C.text)}
        </View>
      </View>
    </View>
  );
}

function ColorRow(props: { color: LookColor }) {
  const key = props.color;
  const derived = derivedColors.includes(key);
  // Each is made once a step, and what reads it runs again only when it changes.
  const value = computed(() => effective(key));
  const automatic = computed(() => derived && !pickedLook().cssVars[mode()][key]);
  const minimum = minimumContrast[key];
  const ratio = computed(() => contrast(value(), pickedLook().cssVars[mode()].background));
  // Derived colors are made readable; only a picked one can be too faint.
  const low = computed(() => minimum !== undefined && !automatic() && ratio() < minimum);
  return (
    <>
      <SettingsRow
        label={colorLabel(key)}
        description={automatic() ? tr('Automatic') : undefined}
        trailing={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <If when={derived && !automatic()}>
              <SettingsButton
                label={tr('Automatic')}
                tone="quiet"
                onPress={() => appearance.changeLook(withColor(key, undefined), true)}
              />
            </If>
            <ColorWell
              name={colorLabel(key)}
              value={value()}
              change={(color, save) => pick(withColor(key, color), save)}
            />
          </View>
        }
      />
      <If when={low()}>
        <SettingsRow
          label={tr('Contrast {ratio}:1, hard to read', { ratio: ratio().toFixed(1) })}
          tone="danger"
          trailing={
            <SettingsButton
              label={tr('Fix')}
              onPress={() =>
                appearance.changeLook(
                  withColor(
                    key,
                    readable(value(), appearance.shown().cssVars[mode()].background, minimum!),
                  ),
                  true,
                )
              }
            />
          }
        />
      </If>
    </>
  );
}

/** A color's swatch and value; pressed, a picker for it. */
function ColorWell(props: {
  name: string;
  value: string;
  change(color: string, save: boolean): void;
}) {
  const open = signal(false);
  const color = (value: string) => value.slice(0, 7).toLowerCase();
  const thumb = {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#ffffff',
  };
  return (
    <ColorPicker
      value={props.value}
      format="hex"
      onChange={({ formatted }) => {
        // Steps finer than a hex digit report the color already shown.
        const next = color(formatted);
        if (next !== props.value) props.change(next, false);
      }}
      onChangeEnd={({ formatted }) => props.change(color(formatted), true)}
    >
      <Popover
        open={open()}
        onOpenChange={({ open: next }) => {
          open.set(next);
          // A color typed and not entered is let go with the picker.
          if (!next) dragged.set(null);
        }}
        placement="bottom"
        align="end"
        offset={4}
        margin={8}
        popupStyle={{ ...floatingStyle(), width: 248, padding: 12, gap: 10 }}
        trigger={
          <Button
            accessibilityLabel={tr('Pick {name}', { name: props.name })}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              paddingHorizontal: 8,
              paddingVertical: 4,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: C.line,
            }}
            hoverStyle={{ backgroundColor: C.cardRaised }}
          >
            <Text style={{ ...captionTextStyle, ...codeTextStyle, color: C.secondary }}>
              {props.value}
            </Text>
            <View
              style={{
                width: 18,
                height: 18,
                borderRadius: 4,
                borderWidth: 1,
                borderColor: C.line,
                backgroundColor: props.value,
              }}
            />
          </Button>
        }
      >
        <ColorArea
          accessibilityLabel={tr('{name} saturation and brightness', { name: props.name })}
          style={{ height: 140 }}
          panelStyle={{ borderRadius: 6 }}
          thumbStyle={thumb}
          fillThumb
        />
        <ColorSlider
          colorSpace="hsb"
          channel="hue"
          accessibilityLabel={tr('{name} hue', { name: props.name })}
          style={{ height: 16, justifyContent: 'center', paddingHorizontal: 8 }}
          trackStyle={{ height: 8, borderRadius: 4 }}
          thumbStyle={thumb}
          fillThumb
        />
        <ColorField
          format="hex"
          accessibilityLabel={tr('{name} hex value', { name: props.name })}
          class={`font-mono text-[13px] text-[${C.text}]`}
          style={{
            minHeight: 28,
            paddingHorizontal: 8,
            borderRadius: 6,
            borderWidth: 1,
            borderColor: C.line,
          }}
        />
      </Popover>
    </ColorPicker>
  );
}

function FontRows() {
  const family = () => appearance.shown().cssVars.theme['font-sans'];
  const choice = (): FontChoice | 'other' => fontChoice(family()) ?? 'other';
  // The look Other was chosen on with no name typed yet; any other look shows its own font.
  const naming = signal<Look | null>(null);
  const shownChoice = () => (naming() === appearance.shown() ? 'other' : choice());
  // A name is shown as it is typed and saved once it is submitted or left, unless
  // the look changed under it meanwhile (an undo, a preset). An empty name clears it.
  let draft: { name: string; on: Look } | null = null;
  return (
    <>
      <SettingsSelect
        label={tr('Font')}
        value={shownChoice()}
        choices={[...fontChoices, 'other' as const].map((value) => ({
          value,
          title: fontLabel(value),
        }))}
        change={(value) => {
          if (value === 'other') return naming.set(appearance.shown());
          naming.set(null);
          const picked = value as FontChoice;
          appearance.changeLook(
            withFont(picked === 'system' ? undefined : fontFamilies[picked]),
            true,
          );
        }}
      />
      <If when={shownChoice() === 'other'}>
        <SettingsInput
          label={tr('Font name')}
          value={choice() === 'other' ? (family() ?? '') : ''}
          placeholder="Avenir Next"
          change={(value) => {
            const name = value.trim();
            // Update look and naming together so clearing does not unmount and blur the input.
            batch(() => {
              appearance.changeLook(withFont(name || undefined), false);
              naming.set(name ? null : appearance.shown());
            });
            draft = { name, on: appearance.shown() };
          }}
          commit={() => {
            const pending = draft;
            draft = null;
            if (pending?.on !== appearance.shown()) return;
            batch(() => {
              if (!pending.name) naming.set(null);
              appearance.changeLook(withFont(pending.name || undefined), true);
            });
          }}
        />
      </If>
    </>
  );
}
