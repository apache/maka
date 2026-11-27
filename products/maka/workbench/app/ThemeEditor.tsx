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

// Settings › General › Theme: a preset to start from, then each color, the shape and the
// font, seen on a sample of a conversation while a value is dragged, then on the whole window.
import { batch, colorScheme, computed, platform, signal, Text, View } from 'nsh';
import { Button, ColorArea, ColorField, ColorPicker, ColorSlider, Popover, Slider } from 'nsh/base';
import { tr } from './locale';
import { appearance, colorThemes } from './appearance';
import {
  contrast,
  darkBackground,
  derivedColors,
  fontChoice,
  fontChoices,
  fontFamilies,
  lookIds,
  lookShadow,
  lookTokens,
  minimumContrast,
  mix,
  pickedColors,
  presetLooks,
  readable,
  sameLook,
  scaledRadius,
  shadowPresets,
  shapeLimits,
  shapeValue,
  unchanged,
  type FontChoice,
  type Look,
  type LookColor,
  type LookId,
  type LookShape,
  type ShapeKey,
} from './look';
import {
  SettingsBody,
  SettingsButton,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  settingsGutter,
} from './SettingsPage';
import {
  C,
  captionTextStyle,
  codeTextStyle,
  defaultColors,
  floatingStyle,
  lookColors,
  lookShape,
  lineWidth,
  radius,
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
    bauhaus: tr('Bauhaus'),
    brutalist: tr('Neo-brutalism'),
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

type ThemeValues = Look['cssVars']['theme'];
/** The shown look with `values` set in its theme; one undefined goes back to the default's. */
function withTheme(values: ThemeValues): Look {
  const look = appearance.shown();
  const theme: Record<string, unknown> = { ...look.cssVars.theme };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete theme[key];
    else theme[key] = value;
  }
  return { ...look, cssVars: { ...look.cssVars, theme: theme as ThemeValues } };
}
const withFont = (family: string | undefined) => withTheme({ 'font-sans': family });

/** The color a key has in `look` for the appearance edited, picked or derived. */
function effective(look: Look, key: LookColor): string {
  const colors = look.cssVars[mode()];
  const picked = colors[key];
  if (picked !== undefined) return picked;
  const tokens = lookTokens(colors);
  return key === 'card' ? tokens.sidebar : key === 'border' ? tokens.line : tokens.muted;
}

/** A color picker's drag: the preview follows it at once, and the whole window takes the
 * look when it ends, so a drag does not restyle every view at each step. */
type Picking = {
  /** The look being dragged through, else the one shown. */
  look(): Look;
  /** Follows a drag through `look`; with `save`, the drag ends and the window takes it. */
  pick(look: Look, save: boolean): void;
};

export function ThemeEditor() {
  const dragged = signal<Look | null>(null);
  const picking: Picking = {
    look: () => dragged() ?? appearance.shown(),
    pick: (look, save) => {
      if (!save) return dragged.set(look);
      batch(() => {
        // A drag that ends where it began leaves the window's look as it is.
        if (!sameLook(look, appearance.shown())) appearance.changeLook(look, true);
        dragged.set(null);
      });
    },
  };
  const terminal = platform.idiom === 'terminal';
  const page = signal<PageSize | null>(null);
  const layout = computed<PreviewLayout>(
    () => (terminal ? { kind: 'inline' } : previewLayout(page())),
    { equals: samePreviewLayout },
  );
  const beside = () => {
    const current = layout();
    return current.kind === 'beside' ? current : null;
  };
  const previewLook = () => dragged() ?? appearance.look();
  const controls = (
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
      <If when={layout().kind === 'inline'}>
        <SettingsSection title={tr('Preview')}>
          <Specimen look={previewLook} />
        </SettingsSection>
      </If>
      <SettingsSection title={tr('Colors')}>
        <Each of={[...pickedColors, ...derivedColors]} key={(key) => key}>
          {(key) => <ColorRow color={key()} picking={picking} />}
        </Each>
      </SettingsSection>
      <SettingsSection title={tr('Shape')}>
        <ShapeRows picking={picking} />
      </SettingsSection>
      <SettingsSection title={tr('Shadow')}>
        <ShadowRows picking={picking} />
      </SettingsSection>
      <SettingsSection title={tr('Font')}>
        <FontRows picking={picking} />
      </SettingsSection>
    </SettingsBody>
  );
  if (terminal) return controls;
  return (
    <View
      style={{ flex: 1, minHeight: 0 }}
      onLayout={({ bounds: { size } }) => {
        const prev = page();
        if (!prev || prev.width !== size.width || prev.height !== size.height) {
          page.set({ width: size.width, height: size.height });
        }
      }}
    >
      <If when={layout().kind === 'above'}>
        <View
          style={{
            paddingHorizontal: settingsGutter,
            paddingTop: 4,
            paddingBottom: 12,
            borderBottomWidth: 1,
            borderBottomColor: C.line,
          }}
        >
          <View style={{ borderRadius: radius(12), overflow: 'hidden' }}>
            <Specimen look={previewLook} compact />
          </View>
        </View>
      </If>
      <View style={{ flex: 1, minHeight: 0, flexDirection: 'row' }}>
        {controls}
        <If when={beside()}>
          {(column) => (
            <View
              style={{
                width: column().width,
                // SettingsBody already pads its right edge by settingsGutter.
                marginLeft: besideGap - settingsGutter,
                paddingTop: 4,
                paddingRight: settingsGutter,
              }}
            >
              <SettingsSection title={tr('Preview')}>
                <Specimen look={previewLook} compact={column().compact} />
              </SettingsSection>
            </View>
          )}
        </If>
      </View>
    </View>
  );
}

type PageSize = { width: number; height: number };

/** Where the preview stays in view while the controls scroll: beside them on a wide page,
 * above them on a narrow one tall enough for the compact preview, and among them otherwise. */
type PreviewLayout =
  | { kind: 'unmeasured' }
  | { kind: 'inline' }
  | { kind: 'above' }
  | { kind: 'beside'; width: number; compact: boolean };

const besideFrom = 840;
const besideMinWidth = 360;
const besideMaxWidth = 480;
const besideShare = 0.44;
const besideGap = 32;
const besideMinHeight = 300;
const besideCompactBelow = 500;
// Compact preview plus its padding and divider is ~217 pt (~237 pt when the reply wraps);
// require enough height that it fits unclipped while leaving the controls most of the page.
const aboveFrom = 560;

function previewLayout(size: PageSize | null): PreviewLayout {
  if (!size) return { kind: 'unmeasured' };
  if (size.width >= besideFrom && size.height >= besideMinHeight) {
    return {
      kind: 'beside',
      width: Math.min(Math.max(size.width * besideShare, besideMinWidth), besideMaxWidth),
      compact: size.height < besideCompactBelow,
    };
  }
  return { kind: size.height >= aboveFrom ? 'above' : 'inline' };
}

function samePreviewLayout(a: PreviewLayout, b: PreviewLayout): boolean {
  if (a.kind !== b.kind) return false;
  return (
    a.kind !== 'beside' || (b.kind === 'beside' && a.width === b.width && a.compact === b.compact)
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
  const preset = presetLooks[props.id];
  const colors = () => preset.cssVars[mode()];
  const tokens = () => lookTokens(colors());
  const corner = (n: number) => scaledRadius(n, shapeValue(preset, 'radius'));
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
          borderRadius: radius(8),
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
          <View style={{ flexDirection: 'row', gap: 4 }}>
            <View
              style={{
                height: 12,
                width: 32,
                borderRadius: corner(4),
                backgroundColor: tokens().accent,
                ...(() => {
                  const shadow = lookShadow(preset, mode() === 'dark', 0.5);
                  return shadow ? { boxShadow: shadow } : {};
                })(),
              }}
            />
            <View
              style={{
                height: 12,
                width: 20,
                borderRadius: corner(4),
                borderWidth: shapeValue(preset, 'border-width'),
                borderColor: tokens().line,
              }}
            />
          </View>
        </View>
      </View>
      <Text style={{ ...captionTextStyle, color: selected() ? C.text : C.secondary }}>
        {lookLabel(props.id)}
      </Text>
    </Button>
  );
}

/** A piece of a conversation in the colors in effect: what the settings page has none of.
 * `compact` keeps a bubble, a reply, code and the field: every color but the warning, and
 * every part of the shape. */
function Specimen(props: { look(): Look | null; compact?: boolean }) {
  const C = lookColors(props.look);
  const { radius, lineWidth, letterSpacing, raisedShadow } = lookShape(props.look);
  const line = (text: string, color: string, extra: object = {}) => (
    <Text style={{ ...secondaryTextStyle, color, letterSpacing: letterSpacing(), ...extra }}>
      {text}
    </Text>
  );
  return (
    <View style={{ padding: 12, gap: 10, backgroundColor: C.panel }}>
      <View
        style={{
          alignSelf: 'flex-end',
          maxWidth: '80%',
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderRadius: radius(12),
          backgroundColor: C.card,
          ...raisedShadow(),
        }}
      >
        {line(tr('Can you check this function?'), C.text)}
      </View>
      <Text style={{ ...secondaryTextStyle, color: C.text, letterSpacing: letterSpacing() }}>
        {tr('It returns early when the list is empty.')}{' '}
        <Text style={{ color: C.accentText, textDecorationLine: 'underline' }}>
          {tr('See the notes.')}
        </Text>
      </Text>
      <If when={!props.compact}>{line(tr('Ran the tests · 12 passed'), C.muted)}</If>
      <View style={{ borderRadius: radius(6), padding: 8, backgroundColor: C.card, gap: 2 }}>
        <Text style={{ ...codeTextStyle, color: C.text, backgroundColor: C.removed }}>
          {'- if (items.length == 0) return;'}
        </Text>
        <Text style={{ ...codeTextStyle, color: C.text, backgroundColor: C.added }}>
          {'+ if (!items.length) return [];'}
        </Text>
      </View>
      <If when={!props.compact}>{line(tr('Something needs your attention.'), C.warning)}</If>
      <View
        style={{ flexDirection: props.compact ? 'row' : 'column', gap: props.compact ? 8 : 10 }}
      >
        <View
          style={{
            flexGrow: props.compact ? 1 : 0,
            minHeight: 32,
            paddingHorizontal: 10,
            justifyContent: 'center',
            borderRadius: radius(8),
            borderWidth: lineWidth(),
            borderColor: C.line,
            backgroundColor: C.background,
            ...raisedShadow(),
          }}
        >
          {line(tr('Write a reply…'), C.muted)}
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View
            style={{
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: radius(8),
              backgroundColor: C.accent,
              ...raisedShadow(),
            }}
          >
            {line(tr('Send'), C.onAccent, { fontWeight: '600' })}
          </View>
          <If when={!props.compact}>
            <View
              style={{
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: radius(8),
                borderWidth: lineWidth(),
                borderColor: C.line,
              }}
            >
              {line(tr('Cancel'), C.text)}
            </View>
          </If>
        </View>
      </View>
    </View>
  );
}

function ColorRow(props: { color: LookColor; picking: Picking }) {
  const key = props.color;
  const { look, pick } = props.picking;
  const derived = derivedColors.includes(key);
  // Each is made once a step, and what reads it runs again only when it changes.
  const value = computed(() => effective(look(), key));
  const automatic = computed(() => derived && !look().cssVars[mode()][key]);
  const minimum = minimumContrast[key];
  const ratio = () => contrast(value(), look().cssVars[mode()].background);
  // Derived colors are made readable; only a picked one can be too faint.
  const low = computed(() => minimum !== undefined && !automatic() && ratio() < minimum);
  const change = (color: string, save: boolean) => {
    const shown = appearance.shown();
    // Let go on the color it derives, an automatic color stays automatic.
    const kept = save && derived && !shown.cssVars[mode()][key] && color === effective(shown, key);
    pick(kept ? shown : withColor(key, color), save);
  };
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
            <ColorWell name={colorLabel(key)} value={value()} change={change} />
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
        onOpenChange={({ open: next }) => open.set(next)}
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
              borderRadius: radius(6),
              borderWidth: lineWidth(),
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
                borderRadius: radius(4),
                borderWidth: lineWidth(),
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
          panelStyle={{ borderRadius: radius(6) }}
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
            borderRadius: radius(6),
            borderWidth: lineWidth(),
            borderColor: C.line,
          }}
        />
      </Popover>
    </ColorPicker>
  );
}

function FontRows(props: { picking: Picking }) {
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
      <ShapeSlider
        label={tr('Letter spacing')}
        shape="letter-spacing"
        step={0.1}
        picking={props.picking}
      />
    </>
  );
}

const lineWidths = [1, 1.5, 2, 3];
const points = (value: number) => tr('{value} pt', { value: String(value) });

/** A shape value on a slider, shown as it changes and saved when let go. */
function ShapeSlider(props: {
  label: string;
  shape: ShapeKey;
  step: number;
  percent?: boolean;
  picking: Picking;
}) {
  const [min, max] = shapeLimits[props.shape];
  const value = () => shapeValue(props.picking.look(), props.shape);
  // Steps of a tenth are kept as tenths, not as their sums' binary fractions.
  const change = (next: number, save: boolean) =>
    props.picking.pick(withTheme({ [props.shape]: Math.round(next * 100) / 100 }), save);
  const number = (raw: number | [number, number]) => (Array.isArray(raw) ? raw[0] : raw);
  return (
    <SettingsRow
      label={props.label}
      trailing={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Slider
            accessibilityLabel={props.label}
            value={value()}
            min={min}
            max={max}
            step={props.step}
            onChange={({ value: next }) => change(number(next), false)}
            onChangeEnd={({ value: next }) => change(number(next), true)}
            style={{ width: 160 }}
            trackStyle={{ height: 22, justifyContent: 'center' }}
            indicatorStyle={{ height: 6, borderRadius: 3, backgroundColor: C.cardRaised }}
            rangeStyle={{ borderRadius: 3, backgroundColor: C.accentText }}
            thumbStyle={{
              width: 16,
              height: 16,
              borderRadius: 8,
              backgroundColor: C.accentText,
              borderWidth: 2,
              borderColor: C.background,
            }}
          />
          <Text
            style={{
              ...captionTextStyle,
              width: 44,
              textAlign: 'right',
              color: C.secondary,
              fontVariant: ['tabular-nums'],
            }}
          >
            {props.percent ? `${Math.round(value() * 100)}%` : points(value())}
          </Text>
        </View>
      }
    />
  );
}

function ShapeRows(props: { picking: Picking }) {
  return (
    <>
      <ShapeSlider label={tr('Corners')} shape="radius" step={1} picking={props.picking} />
      <SettingsSelect
        label={tr('Line width')}
        value={String(shapeValue(appearance.shown(), 'border-width'))}
        choices={lineWidths.map((width) => ({ value: String(width), title: points(width) }))}
        change={(value) =>
          appearance.changeLook(withTheme({ 'border-width': Number(value) }), true)
        }
      />
    </>
  );
}

type ShadowChoice = 'none' | 'soft' | 'hard' | 'custom';
const shadowKeys: ShapeKey[] = [
  'shadow-x',
  'shadow-y',
  'shadow-blur',
  'shadow-spread',
  'shadow-opacity',
];
const shadowLabel = (choice: ShadowChoice) =>
  ({ none: tr('None'), soft: tr('Soft'), hard: tr('Hard'), custom: tr('Custom') })[choice];
/** The starting point a look's shadow is, or custom once changed from one. */
function shadowChoice(look: Look): ShadowChoice {
  if (shapeValue(look, 'shadow-opacity') <= 0) return 'none';
  const matches = (start: LookShape) =>
    shadowKeys.every((key) => shapeValue(look, key) === (start[key] ?? 0));
  return matches(shadowPresets.soft) ? 'soft' : matches(shadowPresets.hard) ? 'hard' : 'custom';
}
/** The shown look with its shadow started over: none, a soft one, or a hard one in the text's
 * color (a dark gray on a dark background). */
function withShadow(choice: Exclude<ShadowChoice, 'custom'>): Look {
  const cleared = Object.fromEntries(shadowKeys.map((key) => [key, undefined]));
  const look = withTheme({ ...cleared, ...(choice === 'none' ? {} : shadowPresets[choice]) });
  const color = (colors: Look['cssVars']['light']) => {
    const { 'shadow-color': _, ...rest } = colors;
    if (choice !== 'hard') return rest;
    // A light shadow on a dark background reads as a glow, so there it is a dark gray.
    const shadow = darkBackground(colors.background)
      ? mix(colors.background, colors.foreground, 0.28)
      : colors.foreground;
    return { ...rest, 'shadow-color': shadow };
  };
  return {
    ...look,
    cssVars: { ...look.cssVars, light: color(look.cssVars.light), dark: color(look.cssVars.dark) },
  };
}
function withShadowColor(value: string): Look {
  const look = appearance.shown();
  return {
    ...look,
    cssVars: { ...look.cssVars, [mode()]: { ...look.cssVars[mode()], 'shadow-color': value } },
  };
}

function ShadowRows(props: { picking: Picking }) {
  const choice = () => shadowChoice(appearance.shown());
  const choices = (): ShadowChoice[] =>
    choice() === 'custom' ? ['none', 'soft', 'hard', 'custom'] : ['none', 'soft', 'hard'];
  return (
    <>
      <SettingsSelect
        label={tr('Shadow')}
        value={choice()}
        choices={choices().map((value) => ({ value, title: shadowLabel(value) }))}
        change={(value) => {
          if (value !== 'custom')
            appearance.changeLook(withShadow(value as Exclude<ShadowChoice, 'custom'>), true);
        }}
      />
      <If when={choice() !== 'none'}>
        <ShapeSlider
          label={tr('Horizontal offset')}
          shape="shadow-x"
          step={1}
          picking={props.picking}
        />
        <ShapeSlider
          label={tr('Vertical offset')}
          shape="shadow-y"
          step={1}
          picking={props.picking}
        />
        <ShapeSlider label={tr('Blur')} shape="shadow-blur" step={1} picking={props.picking} />
        <ShapeSlider label={tr('Spread')} shape="shadow-spread" step={1} picking={props.picking} />
        <ShapeSlider
          label={tr('Opacity')}
          shape="shadow-opacity"
          step={0.01}
          percent
          picking={props.picking}
        />
        <SettingsRow
          label={tr('Shadow color')}
          trailing={
            <ColorWell
              name={tr('Shadow color')}
              value={props.picking.look().cssVars[mode()]['shadow-color'] ?? '#000000'}
              change={(color, save) => props.picking.pick(withShadowColor(color), save)}
            />
          }
        />
      </If>
    </>
  );
}
