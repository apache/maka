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

import { tr } from './locale';
import { Text, View } from 'nsh';
import type { JSX, ViewRef } from 'nsh';
import { Button, Tooltip } from 'nsh/base';
import { colorScheme, keymap, platform, windowSize } from 'nsh';
import { Icon } from './Icon';
import { sessionStatusCaption } from './sessionStatus';
import {
  controlsLeft,
  controlsRight,
  ownTitleBar,
  PANEL_INSET,
  TITLE_BAR_HEIGHT,
  windowDrag,
} from './chrome';
import { appearance } from './appearance';
import { paletteTokens, type PaletteRecipe, type PaletteTokens } from './colorPalette';

export function textTooltip(text: () => string | undefined): JSX.Element {
  return (
    <Tooltip disabled={!text()} class="rounded-md border border-border bg-popover px-2 py-1">
      <Text class="text-xs text-popover-foreground">{text()}</Text>
    </Tooltip>
  );
}

const DARK = {
  background: '#161719',
  surface: '#202123',
  raised: '#2a2b2e',
  text: '#f0f1f3',
  secondary: '#c6c9ce',
  muted: '#969ba4',
  accent: '#8ab8f8',
  accentHover: '#b6d3ff',
  warning: '#e7b86b',
  danger: '#f48a8a',
  line: '#37393e',
  success: '#9bd5a5',
  added: '#203527',
  removed: '#382528',
  /** Behind a dialog. */
  scrim: '#00000099',
  /** Under what floats: menus and popovers. */
  shadow: '#00000073',
};
const LIGHT: typeof DARK = {
  background: '#ffffff',
  surface: '#f5f5f6',
  raised: '#ebebed',
  text: '#1c1d1f',
  secondary: '#45484e',
  muted: '#6c7079',
  accent: '#2f6bd8',
  accentHover: '#1f56b8',
  warning: '#9a5b00',
  danger: '#c43c3c',
  line: '#dcdde0',
  success: '#1f7a3a',
  added: '#e3f3e7',
  removed: '#fbe8e9',
  scrim: '#00000040',
  shadow: '#0000001f',
};
/** The default palette's colors in one appearance. */
export const defaultColors = (dark: boolean) => (dark ? DARK : LIGHT);
/** Whether the interface is dark: the window's appearance in effect (`setColorScheme`);
 * terminals keep the dark colors. */
export const isDark = () => platform.idiom === 'terminal' || colorScheme() !== 'light';
// The desktop palette's tokens, made once per recipe and appearance.
let made: { recipe: PaletteRecipe; dark: boolean; tokens: PaletteTokens } | null = null;
const paletteColor = (key: string, dark: boolean): string | undefined => {
  if (platform.idiom === 'terminal') return undefined;
  const recipe = appearance.recipe();
  if (!recipe) return undefined;
  if (made?.recipe !== recipe || made.dark !== dark)
    made = { recipe, dark, tokens: paletteTokens(recipe, dark) };
  return made.tokens[key as keyof PaletteTokens];
};
type Tone = keyof typeof DARK;
// The desktop window's regions, by fill: the sidebar (`chrome`) sits one step
// below the content `panel` in both appearances, and what rests on the panel
// (`card`, then `cardRaised`) steps up from it. What floats (`floating`, its
// rows' hover `floatingRaised`) sits one step above the panel. The dark panel is `surface`, so
// there each step is one token higher; terminals keep the light steps.
const REGIONS = {
  chrome: ['surface', 'background'],
  panel: ['background', 'surface'],
  card: ['surface', 'raised'],
  cardRaised: ['raised', 'line'],
  floating: ['background', 'raised'],
  floatingRaised: ['raised', 'line'],
} satisfies Record<string, [Tone, Tone]>;
/** The interface's colors, in the appearance and palette in effect: read them where they are drawn. */
export const C = Object.defineProperties({} as Record<Tone | keyof typeof REGIONS, string>, {
  ...Object.fromEntries(
    Object.keys(DARK).map((key) => [
      key,
      {
        enumerable: true,
        get: () => {
          const dark = isDark();
          return paletteColor(key, dark) ?? (dark ? DARK : LIGHT)[key as Tone];
        },
      },
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(REGIONS).map(([key, [light, dark]]) => [
      key,
      { enumerable: true, get: () => C[platform.idiom !== 'terminal' && isDark() ? dark : light] },
    ]),
  ),
});

// Cells have a fixed 16-point row; native pixels retain the prose leading.
export const bodyTextStyle = { fontSize: 14, lineHeight: platform.idiom === 'terminal' ? 16 : 24 };
export const secondaryTextStyle = {
  fontSize: 13,
  lineHeight: platform.idiom === 'terminal' ? 16 : 20,
};
export const inputTextStyle = { fontSize: 14, lineHeight: platform.idiom === 'terminal' ? 16 : 20 };
export const captionTextStyle = { fontSize: 13, lineHeight: 16 };
export const codeTextStyle = {
  fontFamily: 'monospace',
  fontSize: 13,
  lineHeight: platform.idiom === 'terminal' ? 16 : 20,
};
// Rounded Input clipping rasterizes the editor on a cell surface.
export const inputBorderRadius = platform.idiom === 'terminal' ? 0 : 8;
export const compact = () => windowSize().height < 480;
/** A control's name and its shortcut, in the keys of the platform the app runs on. */
export const shortcut = (label: string, keystroke: string) =>
  `${label} · ${keymap.label(keystroke)}`;
export const controlStyle = {
  minHeight: 32,
  paddingHorizontal: 12,
  paddingVertical: 8,
  borderRadius: 8,
  justifyContent: 'center',
} as const;
export const toolbarControlStyle = {
  ...controlStyle,
  paddingHorizontal: platform.idiom === 'terminal' ? 12 : 8,
} as const;
/**
 * Horizontal padding of the disclosure rows in a turn (status, process group,
 * thinking, tool). The desktop gives them one value so their chevrons and
 * trailing states line up; the terminal keeps its own cell layout.
 */
export const disclosureInset = (terminal: number) => (platform.idiom === 'terminal' ? terminal : 8);
/**
 * Where a disclosure row's text starts, past its 16-point glyph and gap: the
 * text lane its expanded content shares. The terminal keeps each row's own
 * cell layout.
 */
export const disclosureContentInset = (terminal: number) =>
  platform.idiom === 'terminal' ? terminal : 24;
/**
 * A switch or action row among labelled text fields. On the desktop it gets the
 * fields' box, so its inset text lines up with the text typed in them.
 */
export const fieldBoxStyle = () =>
  platform.idiom === 'terminal'
    ? {}
    : { borderWidth: 1, borderColor: C.line, backgroundColor: C.background };
export const controlHoverStyle = () => ({ backgroundColor: C.raised });
export const controlFocusStyle = () => ({ backgroundColor: C.raised, borderColor: C.accent });
/** Focus for a control that rests on a card: one step above the card. */
export const cardFocusStyle = () => ({ ...controlFocusStyle(), backgroundColor: C.cardRaised });
export const controlDisabledStyle =
  platform.idiom === 'terminal' ? { backgroundColor: C.background } : { opacity: 0.4 };
// Focus styles apply to keyboard focus only, so a ring keeps it apart from hover.
export const quietFocusStyle = () =>
  platform.idiom === 'terminal'
    ? { backgroundColor: C.raised }
    : {
        outlineStyle: 'solid' as const,
        outlineWidth: 2,
        outlineColor: C.accent,
        outlineOffset: -2,
      };
export const quietHoverStyle = () => ({ backgroundColor: C.card });
/** The surface every menu, select, context menu and popover shares. Its inset
 * keeps its rows' radius (8) concentric with its own (12). */
export const floatingStyle = () => ({
  padding: 4,
  minHeight: 0,
  maxWidth: Math.max(0, windowSize().width - 16),
  backgroundColor: C.floating,
  borderWidth: 1,
  borderColor: C.line,
  borderRadius: 12,
  ...(platform.idiom === 'terminal' ? {} : { boxShadow: `0 8px 24px ${C.shadow}` }),
});
/** A menu row: a 16-point icon lane at 12 points from the surface's edge, the
 * text lane at 36, and a trailing lane for the check, shortcut or chevron. */
export const menuRowStyle = () => ({
  minHeight: 32,
  paddingHorizontal: 8,
  paddingVertical: 8,
  borderRadius: 8,
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  justifyContent: 'flex-start' as const,
  gap: 8,
});
/** Hover and keyboard focus look alike in a menu: one row is current. */
export const menuRowHoverStyle = () => ({ backgroundColor: C.floatingRaised });
export const menuDetailTextStyle = { fontSize: 12, lineHeight: 16 };
export const menuLabelStyle = () => ({
  ...menuDetailTextStyle,
  fontWeight: '500' as const,
  color: C.muted,
  paddingHorizontal: 8,
  paddingTop: 8,
  paddingBottom: 4,
});
export const menuSeparatorStyle = () => ({
  height: 1,
  backgroundColor: C.line,
  marginVertical: 4,
  marginHorizontal: 8,
});
export const quietActiveStyle = () => ({ backgroundColor: C.cardRaised });

export function IconButton(props: {
  label: string;
  tooltip?: string;
  icon: Parameters<typeof Icon>[0]['name'];
  selected?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      accessibilityLabel={props.label}
      tooltip={textTooltip(() => props.tooltip ?? props.label)}
      selected={props.selected}
      disabled={props.disabled}
      onPress={props.onPress}
      style={{
        ...controlStyle,
        width: 32,
        paddingHorizontal: 8,
        alignItems: 'center',
        flexShrink: 0,
      }}
      hoverStyle={quietHoverStyle()}
      activeStyle={quietActiveStyle()}
      focusStyle={quietFocusStyle()}
      disabledStyle={controlDisabledStyle}
    >
      <Icon name={props.icon} color={props.selected ? C.accent : C.muted} />
    </Button>
  );
}

export const disclosureTitleStyle = { ...captionTextStyle, flex: 1, minWidth: 0 } as const;

export function Disclosure(props: {
  label: string;
  tooltip?: string;
  open: boolean;
  foldable?: boolean;
  /** On the desktop, what the row is, in place of the chevron. */
  icon?: Parameters<typeof Icon>[0]['name'];
  terminalInset?: number;
  onPress: () => void;
  children: JSX.Element;
  trailing?: JSX.Element;
}) {
  const icon = () => (platform.idiom === 'terminal' ? undefined : props.icon);
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        minWidth: 0,
        marginHorizontal: platform.idiom === 'terminal' ? 0 : -8,
      }}
    >
      <Button
        accessibilityLabel={props.label}
        tooltip={props.tooltip === undefined ? undefined : textTooltip(() => props.tooltip)}
        disabled={props.foldable === false}
        selected={props.open}
        onPress={props.onPress}
        style={{
          ...controlStyle,
          paddingHorizontal: disclosureInset(props.terminalInset ?? 0),
          flex: 1,
          minWidth: 0,
          flexDirection: 'row',
          // The row spans its container; the chevron and label start at its edge.
          justifyContent: 'flex-start',
          alignItems: 'center',
          gap: 8,
        }}
        hoverStyle={quietHoverStyle()}
        activeStyle={quietActiveStyle()}
        focusStyle={quietFocusStyle()}
      >
        <If
          when={icon()}
          else={
            <If
              when={props.foldable !== false}
              else={
                // The label stays on the text lane where there is nothing to fold.
                <If when={platform.idiom !== 'terminal'}>
                  <View style={{ width: 16, height: 16 }} />
                </If>
              }
            >
              <Icon name={props.open ? 'down' : 'right'} color={C.secondary} />
            </If>
          }
        >
          <Icon name={icon()!} color={C.muted} />
        </If>
        {props.children}
      </Button>
      {props.trailing}
    </View>
  );
}
export type BrowserHeader = {
  navigationDocked: boolean;
  previewDocked: boolean;
  expanded: boolean;
  hidden: boolean;
  toggle(): void;
  /** A pane beside another closes from its header instead of toggling the browser. */
  close?(): void;
};
/** Shows or hides the session browser; its icon previews the change on hover. */
export function SidebarToggle(props: { expanded: boolean; toggle(): void }) {
  const label = () =>
    props.expanded ? tr('Collapse session browser') : tr('Expand session browser');
  return (
    <Button
      class="group/sidebar-toggle"
      onPress={props.toggle}
      accessibilityLabel={label()}
      tooltip={textTooltip(label)}
      selected={props.expanded}
      style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
      hoverStyle={
        platform.idiom === 'terminal' ? { backgroundColor: C.surface } : controlHoverStyle()
      }
      focusStyle={platform.idiom === 'terminal' ? { backgroundColor: C.raised } : quietFocusStyle()}
    >
      <View
        accessibilityElementsHidden
        style={[{ width: 16, height: 16 }, { pointerEvents: 'none' }]}
      >
        <View class="group-hover/sidebar-toggle:opacity-0">
          <Icon name="sidebar" color={platform.idiom === 'terminal' ? C.secondary : C.muted} />
        </View>
        <View
          class="opacity-0 group-hover/sidebar-toggle:opacity-100"
          style={{ position: 'absolute', left: 0, top: 0 }}
        >
          <Icon
            name={props.expanded ? 'sidebarCollapse' : 'sidebarExpand'}
            color={platform.idiom === 'terminal' ? C.secondary : C.muted}
          />
        </View>
      </View>
    </Button>
  );
}

/** One segment of a pane's views in its header: a compact segmented control. */
export function ViewSegment(props: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Button
      role="tab"
      accessibilityLabel={props.label}
      selected={props.selected}
      onPress={props.onPress}
      style={{
        height: 28,
        paddingHorizontal: 8,
        borderRadius: 8,
        justifyContent: 'center',
        backgroundColor: props.selected ? C.card : 'transparent',
      }}
      hoverStyle={quietHoverStyle()}
      activeStyle={quietActiveStyle()}
      focusStyle={quietFocusStyle()}
    >
      <Text
        style={{
          ...captionTextStyle,
          color: props.selected ? C.text : C.secondary,
          fontWeight: props.selected ? '500' : undefined,
        }}
      >
        {props.label}
      </Text>
    </Button>
  );
}

/**
 * A pane's header. On the desktop it is the content panel's first row, 32
 * points high, so with the panel's top inset its center line is the window
 * controls' (`TITLE_BAR_HEIGHT`).
 */
export function Header(props: {
  title: string;
  workspace?: string;
  status?: 'loading' | 'stopping' | 'failed';
  /** The command palette, which the terminal's header opens; the desktop's is in the menu bar. */
  commands(): void;
  browser: BrowserHeader;
  files?(): void;
  filesOpener?(node: ViewRef): void;
  /** Extra controls for this conversation, after the files button. */
  actions?: JSX.Element;
  views?: JSX.Element;
}) {
  const desktop = platform.idiom !== 'terminal';
  const workspaceName = () => {
    const path = props.workspace;
    if (!path) return tr('Files');
    return (
      path
        .split(path.startsWith('/') ? '/' : /[\\/]/)
        .filter(Boolean)
        .at(-1) || path
    );
  };
  // The docked sidebar's title bar row holds the desktop's toggle.
  const toggle = () =>
    !props.browser.close && !(desktop && ownTitleBar && props.browser.navigationDocked);
  // The desktop's panel is inset from the window's edges, so window controls
  // over it need only what reaches past that inset.
  const paddingLeft = () =>
    !desktop
      ? 16 + controlsLeft(!props.browser.navigationDocked)
      : toggle()
        ? Math.max(8, controlsLeft(!props.browser.navigationDocked) - PANEL_INSET)
        : 16;
  const paddingRight = () =>
    desktop
      ? Math.max(8, controlsRight(!props.browser.previewDocked) - PANEL_INSET)
      : 16 + controlsRight(!props.browser.previewDocked);
  return (
    <View
      accessibilityElementsHidden={props.browser.hidden}
      desktop={windowDrag}
      style={{
        opacity: props.browser.hidden ? 0 : 1,
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: paddingLeft(),
        paddingRight: paddingRight(),
        height: desktop ? 32 : ownTitleBar ? TITLE_BAR_HEIGHT : compact() ? 32 : 48,
        gap: desktop ? 4 : 8,
        borderBottomWidth: desktop ? 0 : 1,
        borderBottomColor: C.line,
        pointerEvents: props.browser.hidden ? 'none' : 'auto',
      }}
    >
      <If when={toggle()}>
        <SidebarToggle expanded={props.browser.expanded} toggle={props.browser.toggle} />
      </If>
      <If when={!desktop}>
        <Button
          onPress={props.commands}
          accessibilityLabel={tr('Open commands')}
          tooltip={textTooltip(() => shortcut(tr('Commands'), 'mod+p'))}
          style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
          hoverStyle={{ backgroundColor: C.surface }}
          focusStyle={{ backgroundColor: C.raised }}
          activeStyle={{ backgroundColor: C.line }}
        >
          <Icon name="command" color={C.secondary} />
        </Button>
      </If>
      <Text
        style={[
          desktop
            ? { color: C.text, flexShrink: 1, minWidth: 0, fontWeight: '600' }
            : { color: C.text, flex: 1, minWidth: 0, fontWeight: '500' },
          { numberOfLines: 1 },
        ]}
      >
        {props.title}
      </Text>
      <If when={props.files}>
        <Button
          accessibilityLabel={tr('Browse workspace files')}
          tooltip={textTooltip(() => props.workspace || tr('Browse workspace files'))}
          ref={props.filesOpener}
          onPress={props.files}
          style={{
            ...toolbarControlStyle,
            ...(desktop ? { minHeight: 28, height: 28, paddingVertical: 0 } : {}),
            flexDirection: 'row',
            alignItems: 'center',
            gap: desktop ? 4 : 8,
            maxWidth: 240,
            minWidth: 0,
            flexShrink: desktop ? 2 : 1,
          }}
          hoverStyle={desktop ? quietHoverStyle() : { backgroundColor: C.surface }}
          activeStyle={desktop ? quietActiveStyle() : undefined}
          focusStyle={desktop ? quietFocusStyle() : { backgroundColor: C.raised }}
        >
          <Icon name="folder" color={desktop ? C.muted : C.secondary} size={desktop ? 14 : 16} />
          <Text
            style={[
              {
                ...captionTextStyle,
                color: desktop ? C.muted : C.secondary,
                minWidth: 0,
                flexShrink: 1,
              },
              { numberOfLines: 1 },
            ]}
          >
            {workspaceName()}
          </Text>
        </Button>
      </If>
      <If when={desktop}>
        <View style={{ flex: 1 }} />
      </If>
      {props.actions}
      <If when={props.status}>
        <Text
          style={{
            ...captionTextStyle,
            color:
              props.status === 'failed'
                ? C.danger
                : props.status === 'stopping'
                  ? C.accent
                  : C.muted,
          }}
        >
          {props.status ? sessionStatusCaption[props.status] : ''}
        </Text>
      </If>
      {props.views}
      <If when={props.browser.close}>
        <Button
          onPress={props.browser.close}
          accessibilityLabel={tr('Close side pane')}
          tooltip={textTooltip(() => tr('Close side pane'))}
          style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
          hoverStyle={desktop ? quietHoverStyle() : { backgroundColor: C.surface }}
          focusStyle={desktop ? quietFocusStyle() : { backgroundColor: C.raised }}
        >
          <Icon name="close" color={desktop ? C.muted : C.secondary} />
        </Button>
      </If>
    </View>
  );
}
