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

/**
 * Sets the theme for the window's appearance and keeps it in step: there is
 * no appearance event, so the appearance is read once a second. Runs for as
 * long as the app; start it from a task (`set_theme` is refused in render).
 */
export async function followAppearance(cx) {
  let applied = null;
  for (;;) {
    const appearance = window.appearance();
    if (appearance !== applied) {
      set_theme({ appearance, tokens: tokensFor(appearance) });
      applied = appearance;
    }
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
 * How long ago `at` (ms) was, as the sidebar shows it: now, 11m, 3h, 4d, 2w,
 * then the date ("Sep 3", or with the year when it is not this year).
 */
export function compactAge(at, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 28) return `${Math.floor(days / 7)}w`;
  const date = new Date(at);
  const month = MONTHS[date.getMonth()];
  return date.getFullYear() === new Date(now).getFullYear()
    ? `${month} ${date.getDate()}`
    : `${month} ${date.getDate()}, ${date.getFullYear()}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
