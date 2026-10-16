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

// The Maka look: the native client's palette and type scale (maka-gpui
// crates/shared/src/theme.rs), mapped onto gpui-base's semantic tokens, and
// the controls every pane builds from.
//
// gpui-base has eighteen color roles. Each token is chosen for what reads it:
// `accent` fills TextView code blocks, so it holds Maka's code fill;
// `background` is behind scroll masks on the plate. Maka roles with no token
// (canvas, hover, success, …) live in `M` and are read through `palette(cx)`.

import { div, svg } from 'gpui-kit';
import { set_theme, h_flex, v_flex, Button, Input } from 'gpui-base';
import { t, tn, language } from './locale.js';

/** @typedef {Record<string, import('gpui-kit').Color>} Palette */

/**
 * Maka's palette, light and dark. Alpha is the last byte.
 * @type {{ light: Palette, dark: Palette }}
 */
export const M = {
  light: {
    canvas: '#F7F7F7',
    plate: '#FFFFFF',
    overlay: '#FFFFFF',
    sunken: '#EDEDED',
    bubble: '#F2F2F3',
    code: '#F1F1F1',
    ink: '#0F0F12',
    inkMuted: '#525252',
    inkDisabled: '#A3A3A3',
    border: '#0F0F121A',
    borderSoft: '#0F0F120F',
    borderStrong: '#0F0F1229',
    hover: '#0F0F120A',
    selected: '#0F0F120F',
    activeRow: '#0F0F1214',
    wash: '#0F0F120F',
    chip: '#EDEDED',
    badge: '#0F0F1214',
    primary: '#0260A6',
    primaryHover: '#035B9D',
    onPrimary: '#FFFFFF',
    accent: '#57A3EF',
    brand: '#71A8FD',
    success: '#007A11',
    warning: '#AB3900',
    warningTint: '#AB39003D',
    destructive: '#C90000',
    scrim: '#00000033',
    dockRing: '#0F0F1214',
  },
  dark: {
    canvas: '#111113',
    plate: '#171719',
    overlay: '#1B1B1E',
    sunken: '#09090B',
    bubble: '#242427',
    code: '#111113',
    ink: '#EEEEF1',
    inkMuted: '#A3A3A3',
    inkDisabled: '#525252',
    border: '#EEEEF11A',
    borderSoft: '#EEEEF10F',
    borderStrong: '#EEEEF129',
    hover: '#EEEEF10F',
    selected: '#EEEEF117',
    activeRow: '#EEEEF117',
    wash: '#EEEEF10F',
    chip: '#242427',
    badge: '#EEEEF117',
    primary: '#5FB6FF',
    primaryHover: '#6ABAFE',
    onPrimary: '#171717',
    accent: '#58B0FF',
    brand: '#71A8FD',
    success: '#279936',
    warning: '#E26C00',
    warningTint: '#E26C003D',
    destructive: '#FF6367',
    scrim: '#00000080',
    dockRing: '#EEEEF11A',
  },
};

/**
 * The gpui-base tokens for one appearance.
 * @param {'light' | 'dark'} appearance
 * @returns {Parameters<typeof set_theme>[0]['tokens']}
 */
export function tokensFor(appearance) {
  const m = appearance === 'dark' ? M.dark : M.light;
  return {
    colors: {
      background: m.plate,
      foreground: m.ink,
      surface: m.plate,
      surface_foreground: m.ink,
      primary: m.primary,
      primary_foreground: m.onPrimary,
      secondary: m.bubble,
      secondary_foreground: m.ink,
      muted: m.sunken,
      muted_foreground: m.inkMuted,
      accent: m.code,
      accent_foreground: m.ink,
      destructive: m.destructive,
      destructive_foreground: m.onPrimary,
      border: m.border,
      input: m.borderStrong,
      ring: m.accent,
      selection: appearance === 'dark' ? '#58B0FF4D' : '#57A3EF4D',
    },
    spacing: { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
    radius: { none: 0, sm: 6, md: 10, lg: 12, xl: 28, full: 9999 },
    typography: {
      sans: '.SystemUIFont',
      mono: 'Menlo',
      xs: { size: 12, line_height: 20, weight: 400 },
      sm: { size: 14, line_height: 20, weight: 400 },
      md: { size: 14, line_height: 20, weight: 400 },
      lg: { size: 16, line_height: 24, weight: 600 },
      xl: { size: 22, line_height: 32, weight: 400 },
      mono_md: { size: 14, line_height: 20, weight: 400 },
    },
  };
}

/**
 * The Maka roles for the theme now in effect.
 * @returns {Palette}
 */
export function palette(cx) {
  return cx.theme().is_dark ? M.dark : M.light;
}

const APPEARANCE_KEY = 'maka.appearance';
/** The appearances Settings offers: the system's, or always light or dark. */
export const APPEARANCES = ['system', 'light', 'dark'];

function storedAppearance() {
  try {
    const value = localStorage.getItem(APPEARANCE_KEY);
    return APPEARANCES.includes(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

let preferred = storedAppearance();
let applied = null;

/** The appearance chosen in Settings: 'system', 'light' or 'dark'. */
export function appearancePreference() {
  return preferred;
}

/** Applies the window's theme for the preference, when it differs from the one drawn. */
function applyAppearance() {
  const appearance = preferred === 'system' ? window.appearance() : preferred;
  if (appearance !== applied) {
    set_theme({ appearance, tokens: tokensFor(appearance) });
    applied = appearance;
  }
}

/**
 * Keeps the choice and applies it at once. Legal where `set_theme` is: an
 * event handler or a task.
 */
export function setAppearancePreference(next) {
  if (!APPEARANCES.includes(next)) return;
  preferred = next;
  localStorage.setItem(APPEARANCE_KEY, next);
  applyAppearance();
}

/**
 * Applies the chosen appearance and, while the choice is to follow the
 * system, reads the system's once a second: there is no appearance event.
 * Runs as a task for the window's life.
 */
export async function followAppearance(cx) {
  for (;;) {
    applyAppearance();
    await cx.sleep(1000);
  }
}

/** Size, line height and weight of each text style. */
const TYPE = {
  display: [22, 32, 400],
  heading: [16, 24, 600],
  body: [14, 20, 400],
  reading: [14, 22, 400],
  label: [14, 20, 500],
  strong: [14, 20, 600],
  small: [12, 20, 400],
  smallLabel: [12, 20, 500],
};

/** Sets `el`'s text to one of the styles in TYPE. */
export function typeset(el, style) {
  const [size, line, weight] = TYPE[style];
  return el.text_size(size).line_height(`${line}px`).font_weight(weight);
}

/** A line of text in a style and color. */
export function text(content, style, color) {
  return typeset(div(), style).text_color(color).child(content);
}

/** One turn of the running glyph, in ms. The native client's spinner turns 0.033 of a turn every 33 ms. */
const SPIN_MS = 1000;

/** One of the icons in `icons/`, tinted. The running glyph turns, as the native client's does. */
export function icon(name, size, color) {
  const glyph = svg(`icons/${name}.svg`).flex_none().size(size).text_color(color);
  return name === 'status-running' ? glyph.spin(SPIN_MS) : glyph;
}

/**
 * How a markdown reply is drawn: the native client's `message_text_style`
 * (maka-gpui crates/conversation/src/view.rs): headings 18, 16 and 14 at
 * 600, 16 between blocks, code blocks on the code fill at 14/20, inline code
 * on the wash, links in the primary color, table heads 14/600 and cells
 * padded 12 by 8.5.
 */
export function markdownStyle(cx) {
  const m = palette(cx);
  return {
    headings: { default: { text_size: 14, font_weight: 600 }, 1: { text_size: 18 }, 2: { text_size: 16 } },
    paragraph_gap: 16,
    foreground: m.ink,
    muted_foreground: m.inkMuted,
    link: m.primary,
    border: m.border,
    code_background: m.code,
    inline_code_background: m.wash,
    code_font_family: 'Menlo',
    code_font_size: 14,
    code_block: { bg: m.code, rounded: 10, px: 14, text_size: 14, line_height: '20px' },
    table_head: { bg: '#00000000', text_color: m.ink, text_size: 14, font_weight: 600 },
    table_cell: { px: 12, py: 8.5 },
  };
}

/**
 * An icon that names itself on hover. An svg has no hover listeners of its
 * own, so the tooltip sits on a div around it.
 */
export function tippedIcon(name, size, color, tip) {
  return div().flex_none().child(icon(name, size, color)).tooltip(tip);
}

/** A size in bytes as people read it: "50 bytes", "25 KB", "1.5 MB". */
export function byteSize(bytes) {
  if (bytes < 1024) return tn(bytes, 'bytesOne', 'bytesOther');
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A file attached to a message, as the composer and the transcript show it:
 * a 32px tile with the file icon, the name, and the size below it in small
 * muted text. While the file is `uploading` the tile shows the running glyph;
 * when it `failed`, the failed one, and the tile names `error` on hover. The
 * composer adds a remove button after it.
 * @param {{ name: string, bytes: number, state?: string, error?: string | null }} file
 */
export function fileChip(file, cx) {
  const m = palette(cx);
  const failed = file.state === 'failed';
  const glyph =
    file.state === 'uploading'
      ? icon('status-running', 14, m.primary)
      : failed
        ? icon('status-failed', 16, m.destructive)
        : icon('tool-read', 16, m.inkMuted);
  return h_flex()
    .flex_none()
    .max_w(240)
    .p(5)
    .pr(10)
    .gap(8)
    .items_center()
    .rounded(12)
    .border_1()
    .border_color(m.border)
    .bg(m.plate)
    .child(
      h_flex()
        .flex_none()
        .size(32)
        .items_center()
        .justify_center()
        .rounded(8)
        .bg(m.wash)
        .when(failed, (el) => el.tooltip(file.error ?? ''))
        .child(glyph),
    )
    .child(
      v_flex()
        .min_w_0()
        .child(typeset(div(), 'body').line_height('18px').text_color(m.ink).truncate().child(file.name))
        .child(text(byteSize(file.bytes), 'small', m.inkMuted).line_height('16px')),
    );
}

/** A colored dot in a 16px lane. */
export function dot(color) {
  return h_flex()
    .flex_none()
    .size(16)
    .items_center()
    .justify_center()
    .child(div().size(8).rounded(9999).bg(color));
}

/** A small pill, such as "Default". */
export function pill(label, cx) {
  const m = palette(cx);
  return typeset(div(), 'smallLabel')
    .flex_none()
    .h(20)
    .px(8)
    .rounded(9999)
    .bg(m.badge)
    .text_color(m.inkMuted)
    .line_height('20px')
    .child(label);
}

/**
 * A 32px control button: `primary` (filled), `outline` (plate with a ring) or
 * `quiet` (wash). Disabled ones are drawn at half strength.
 */
export function controlButton(id, label, kind, disabled, cx) {
  const m = palette(cx);
  const el = typeset(Button.new(id), 'label')
    .flex_none()
    .h(32)
    .px(12)
    .gap(6)
    .items_center()
    .justify_center()
    .rounded(10)
    .disabled(disabled)
    .when(disabled, (el) => el.opacity(0.5));
  switch (kind) {
    case 'primary':
      return el
        .bg(m.primary)
        .text_color(m.onPrimary)
        .when(!disabled, (el) => el.hover((style) => style.bg(m.primaryHover)))
        .child(label);
    case 'quiet':
      return el
        .bg(m.wash)
        .text_color(m.ink)
        .when(!disabled, (el) => el.hover((style) => style.bg(m.activeRow)))
        .child(label);
    default:
      return el
        .bg(m.plate)
        .border_1()
        .border_color(m.border)
        .text_color(m.ink)
        .when(!disabled, (el) => el.hover((style) => style.bg(m.hover)))
        .child(label);
  }
}

/** A 32px text field: plate fill, the strong border, the accent ring when focused. */
export function textField(state, cx) {
  const m = palette(cx);
  return typeset(Input.new(state), 'body')
    .w_full()
    .h(32)
    .px(12)
    .rounded(10)
    .border_1()
    .border_color(m.borderStrong)
    .bg(m.plate)
    .focus((style) => style.border_color(m.accent));
}

/**
 * Moves the keyboard into a text field. An input's focus belongs to its
 * state, which has no focus call, so the keyboard goes to `wrapper`, the
 * focus handle of an element around the field, and then to the next tab
 * stop, the field. That needs a frame with the field drawn: an attempt that
 * lands elsewhere (the field was not drawn yet) is made again, after waiting
 * for the field's focus event (`focused`). GPUI reports no focus path for an
 * inactive window, so there the event only comes once the window is active
 * again and one attempt is all there is. It stops when `current` no longer
 * holds, and resolves with whether it still does.
 * @param {() => boolean} focused whether the field's focus event has come
 * @param {() => boolean} current whether the field still wants the keyboard
 */
export async function focusInput(wrapper, focused, current, cx) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await cx.sleep(50);
    if (!current() || focused()) break;
    wrapper.focus();
    window.focus_next();
    if (!window.is_window_active()) break;
    for (let waited = 0; waited < 10 && current() && !focused(); waited += 1) {
      await cx.sleep(50);
    }
    if (!current() || focused()) break;
  }
  return current();
}

/** A transparent button that shows the hover fill; the caller adds content and size. */
export function ghostButton(id, cx) {
  const m = palette(cx);
  return Button.new(id)
    .flex_none()
    .items_center()
    .rounded(10)
    .text_color(m.ink)
    .hover((style) => style.bg(m.hover));
}

/** A square ghost button holding one icon. */
export function iconButton(id, name, cx, size = 28, glyph = 16) {
  const m = palette(cx);
  return ghostButton(id, cx)
    .size(size)
    .justify_center()
    .rounded(size >= 28 ? 8 : 6)
    .child(icon(name, glyph, m.inkMuted));
}

/**
 * Two or more choices side by side, one of them current, as the sidebar's
 * grouping control draws them: 28 high on the sunken fill, the current
 * segment raised on the plate (in the dark, on the active row fill with a
 * ring). `choices` are `[value, label]` pairs; a segment's id is
 * `${id}-${value}`. The segments share the control's width.
 */
export function segmentedControl(id, choices, current, choose, cx) {
  const m = palette(cx);
  const dark = cx.theme().is_dark;
  const segment = ([value, label]) => {
    const selected = value === current;
    return typeset(Button.new(`${id}-${value}`), 'smallLabel')
      .flex_1()
      .h(24)
      .items_center()
      .justify_center()
      .rounded(8)
      .text_color(selected ? m.ink : m.inkMuted)
      .when(selected, (el) =>
        dark
          ? el.bg(m.activeRow).border_1().border_color(m.border)
          : el.bg(m.plate).shadow_xs(),
      )
      .when(!selected, (el) => el.hover((style) => style.text_color(m.ink)))
      .on_click(() => choose(value))
      .child(label);
  };
  return h_flex()
    .h(28)
    .p(2)
    .gap(2)
    .rounded(10)
    .bg(dark ? m.wash : m.sunken)
    .children(choices.map(segment));
}

/** The surface a menu or popover draws on. */
export function menuSurface(cx) {
  const m = palette(cx);
  return v_flex()
    .min_w(160)
    .p(4)
    .rounded(12)
    .bg(m.overlay)
    .border_1()
    .border_color(m.borderSoft)
    .shadow_md()
    .text_color(m.ink);
}

/**
 * One menu row: optional icon, label, and a trailing check or detail.
 * @param {{ icon?: string, checked?: boolean, detail?: string, disabled?: boolean }} options
 */
export function menuRow(id, label, options, cx) {
  const m = palette(cx);
  return typeset(Button.new(id), 'body')
    .w_full()
    .h(32)
    .px(8)
    .gap(8)
    .items_center()
    .rounded(6)
    .disabled(options.disabled === true)
    .when(options.disabled === true, (el) => el.text_color(m.inkDisabled))
    .when(options.disabled !== true, (el) => el.hover((style) => style.bg(m.activeRow)))
    .when(options.icon !== undefined, (el) => el.child(icon(options.icon, 16, m.inkMuted)))
    .child(div().flex_1().min_w_0().truncate().child(label))
    .when(options.detail !== undefined, (el) =>
      el.child(text(options.detail, 'small', m.inkMuted).flex_none()),
    )
    .when(options.checked === true, (el) => el.child(icon('check', 16, m.ink)));
}

/** A label above a group of menu rows. */
export function menuLabel(label, cx) {
  return text(label, 'smallLabel', palette(cx).inkMuted).px(8).pt(6).pb(2);
}

/** The thin rule between menu groups. */
export function menuSeparator(cx) {
  return div().h(1).my(4).mx(-4).bg(palette(cx).borderSoft);
}

/**
 * How long ago `at` (ms) was, as the sidebar shows it: now (刚刚, 剛剛), 11m,
 * 3h, 4d, 2w in every language, then the date: "Sep 3" ("9/3" in Chinese),
 * or the year alone when it is not this year, as the native client's
 * `compact_age` (maka-gpui crates/shared/src/time.rs) writes it.
 */
export function compactAge(at, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return t('ageNow');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 28) return `${Math.floor(days / 7)}w`;
  const date = new Date(at);
  if (date.getFullYear() !== new Date(now).getFullYear()) return String(date.getFullYear());
  return language() === 'en'
    ? `${MONTHS[date.getMonth()]} ${date.getDate()}`
    : `${date.getMonth() + 1}/${date.getDate()}`;
}

/** The months as an English date names them; a Chinese one writes the number. */
export const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
