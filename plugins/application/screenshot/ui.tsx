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

import {
  effect,
  nativeComponent,
  openUrl,
  type NativeComponentRef,
  platform,
  signal,
  Text,
  View,
  type JSX,
  type Signal,
} from 'nsh';
import { Button } from 'nsh/base';
import { Icon } from '../../../products/maka/workbench/app/Icon';
import { C, textTooltip } from '../../../products/maka/workbench/app/ui';
import { currentWindow, displays, Window, type WindowRef } from 'nsh/desktop';
import type { UiEmbeddedViewProps, UiModule } from '../../../packages/plugin-sdk/src/workbench.js';
import {
  quickToolView,
  type QuickToolInput,
} from '../../../packages/plugin-sdk/src/workbench-views.js';
import { currentLocale, tr } from '../../../products/maka/workbench/app/locale';
import {
  COLORS,
  createSettings,
  ScreenshotSettingsPage,
  SIZES,
  type InkSize,
  type Preferences,
  type ScreenshotSettings,
} from './settings';

const TERMS = ['screenshot', 'capture', 'snip', 'jietu', 'jt', '截图', '截圖', '截屏'];

type Failure = { message: string; permission: boolean };
type Rect = { x: number; y: number; width: number; height: number };
type Size = { width: number; height: number };

const SCREEN_RECORDING_SETTINGS =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

/** The desktop shell's frozen display: it selects a region, takes marks on it, and copies, saves or pins it. */
const Stage = nativeComponent<
  { folder: string | null; pictureBoxes: boolean },
  {
    ready: { elements: boolean };
    selection: Rect | null;
    done: null;
    cancel: null;
    failed: Failure;
  }
>('maka.screenshot', {
  props: ['folder', 'pictureBoxes'],
  events: ['ready', 'selection', 'done', 'cancel', 'failed'],
});

const TOOLS = [
  ['rectangle', 'Rectangle'],
  ['ellipse', 'Ellipse'],
  ['arrow', 'Arrow'],
  ['pen', 'Pen'],
  ['marker', 'Highlighter'],
  ['text', 'Text'],
  ['mosaic', 'Mosaic'],
  ['number', 'Numbered marker'],
] as const;
type Tool = (typeof TOOLS)[number][0];

const BAR = 38;
const INK_BAR = 34;
const GAP = 6;
const EDGE = 4;
const plate = () =>
  ({
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    padding: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.line,
    backgroundColor: C.floating,
  }) as const;
const hint = () => ({ fontSize: 12, lineHeight: 18, color: C.muted });

function CardButton(props: { label: string; primary?: boolean; onPress(): void }) {
  return (
    <Button
      accessibilityLabel={props.label}
      onPress={props.onPress}
      style={{
        paddingVertical: 5,
        paddingHorizontal: 12,
        borderRadius: 6,
        backgroundColor: props.primary ? C.accent : C.floatingRaised,
      }}
      hoverStyle={{ backgroundColor: props.primary ? C.accentHover : C.line }}
    >
      <Text
        style={{
          fontSize: 13,
          lineHeight: 18,
          fontWeight: '500',
          color: props.primary ? C.background : C.text,
        }}
      >
        {props.label}
      </Text>
    </Button>
  );
}

function ToolButton(props: {
  label: string;
  icon: Parameters<typeof Icon>[0]['name'];
  selected?: boolean;
  accent?: boolean;
  onPress(): void;
}) {
  return (
    <Button
      accessibilityLabel={props.label}
      tooltip={textTooltip(() => props.label)}
      selected={props.selected}
      onPress={props.onPress}
      style={{
        width: 30,
        height: 30,
        borderRadius: 6,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: props.selected ? C.floatingRaised : 'transparent',
      }}
      hoverStyle={{ backgroundColor: C.floatingRaised }}
    >
      <Icon
        name={props.icon}
        size={17}
        color={props.selected || props.accent ? C.accent : C.secondary}
      />
    </Button>
  );
}

function Divider() {
  return (
    <View
      style={{
        width: 1,
        height: 18,
        marginHorizontal: 3,
        backgroundColor: C.line,
      }}
    />
  );
}

/** Below the selection, or above it when the screen ends, or inside it when neither fits. */
function place(selection: Rect, screen: Size, height: number) {
  const below = selection.y + selection.height + GAP;
  const above = selection.y - GAP - height;
  const top =
    below + height <= screen.height - EDGE
      ? below
      : above >= EDGE
        ? above
        : selection.y + selection.height - GAP - height;
  const right = Math.max(EDGE, screen.width - selection.x - selection.width);
  return { top, right };
}

type Ink = {
  tool: Signal<Tool | null>;
  color: Signal<string>;
  size: Signal<InkSize>;
};

function Toolbar(props: {
  stage: () => NativeComponentRef | undefined;
  selection: Rect;
  screen: Size;
  ink: Ink;
}) {
  const { tool, color, size } = props.ink;
  const command = (name: string, args: Record<string, unknown> = {}) =>
    props.stage()?.command(name, args);
  const inked = () => tool() !== null && tool() !== 'mosaic';
  const at = () => place(props.selection, props.screen, BAR + (inked() ? GAP + INK_BAR : 0));
  return (
    <View
      style={{
        position: 'absolute',
        top: at().top,
        right: at().right,
        alignItems: 'flex-end',
        gap: GAP,
      }}
    >
      <View style={plate()}>
        <Each of={TOOLS} key={(entry: (typeof TOOLS)[number]) => entry[0]}>
          {(entry) => {
            const [name, label] = entry();
            return (
              <ToolButton
                label={tr(label)}
                icon={name}
                selected={tool() === name}
                onPress={() => {
                  const next = tool() === name ? null : name;
                  tool.set(next);
                  command('tool', { tool: next });
                }}
              />
            );
          }}
        </Each>
        <Divider />
        <ToolButton label={tr('Undo')} icon="undo" onPress={() => command('undo')} />
        <ToolButton label={tr('Redo')} icon="redo" onPress={() => command('redo')} />
        <Divider />
        <ToolButton label={tr('Pin to screen')} icon="pin" onPress={() => command('pin')} />
        <ToolButton label={tr('Save')} icon="download" onPress={() => command('save')} />
        <ToolButton label={tr('Cancel')} icon="close" onPress={() => command('cancel')} />
        <ToolButton label={tr('Copy')} icon="check" accent onPress={() => command('copy')} />
      </View>
      <If when={inked()}>
        <View style={[plate(), { height: INK_BAR, gap: 6, paddingHorizontal: 8 }]}>
          <Each of={SIZES} key={(entry: (typeof SIZES)[number]) => entry[0]}>
            {(entry) => {
              const [name, label, dot] = entry();
              return (
                <Button
                  accessibilityLabel={tr(label)}
                  tooltip={textTooltip(() => tr(label))}
                  selected={size() === name}
                  onPress={() => {
                    size.set(name);
                    command('ink', { size: name });
                  }}
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 4,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: size() === name ? C.floatingRaised : 'transparent',
                  }}
                >
                  <View
                    style={{
                      width: dot,
                      height: dot,
                      borderRadius: dot / 2,
                      backgroundColor: color(),
                    }}
                  />
                </Button>
              );
            }}
          </Each>
          <Divider />
          <Each of={COLORS} key={(hex: string) => hex}>
            {(entry) => {
              const hex = entry();
              return (
                <Button
                  accessibilityLabel={hex}
                  selected={color() === hex}
                  onPress={() => {
                    color.set(hex);
                    command('ink', { color: hex });
                  }}
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 9,
                    borderWidth: 2,
                    borderColor: color() === hex ? C.text : C.line,
                    backgroundColor: hex,
                  }}
                />
              );
            }}
          </Each>
        </View>
      </If>
    </View>
  );
}

function Overlay(props: { screen: Size; preferences: Preferences; finish(): void }) {
  let stage: NativeComponentRef | undefined;
  // The stage takes the keys without activating Maka, which would bring its main window forward.
  currentWindow().focus();
  const failure = signal<Failure | null>(null);
  const selection = signal<Rect | null>(null);
  const elements = signal(true);
  // The stage keeps the tool while the toolbar hides during a drag, so the choice lives here too.
  const ink: Ink = {
    tool: signal<Tool | null>(null),
    color: signal(props.preferences.color),
    size: signal(props.preferences.size),
  };
  return (
    <View style={{ flex: 1 }}>
      <Stage
        ref={(node) => (stage = node)}
        style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
        folder={props.preferences.folder}
        pictureBoxes={props.preferences.pictureBoxes}
        onReady={(ready) => {
          elements.set(ready.elements);
          stage?.command('ink', { color: ink.color(), size: ink.size() });
        }}
        onSelection={(rect) => selection.set(rect)}
        onDone={props.finish}
        onCancel={props.finish}
        onFailed={(failed) => failure.set(failed)}
      />
      <If when={selection() !== null && failure() === null}>
        <Toolbar stage={() => stage} selection={selection()!} screen={props.screen} ink={ink} />
      </If>
      <If when={!elements() && selection() === null && failure() === null}>
        <View
          style={[
            { position: 'absolute', top: 12, left: 0, right: 0, alignItems: 'center' },
            { pointerEvents: 'box-none' },
          ]}
        >
          <View style={[plate(), { gap: 10, paddingVertical: 6, paddingHorizontal: 12 }]}>
            <Text style={hint()}>
              {tr('Allow Accessibility to snap to the controls inside windows.')}
            </Text>
            <CardButton
              label={tr('Allow')}
              onPress={() => stage?.command('requestAccessibility')}
            />
          </View>
        </View>
      </If>
      <If when={failure() !== null}>
        <View
          style={[
            { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
            { alignItems: 'center', justifyContent: 'center', pointerEvents: 'box-none' },
          ]}
        >
          <View
            style={{
              maxWidth: 420,
              gap: 6,
              paddingVertical: 14,
              paddingHorizontal: 18,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: C.line,
              backgroundColor: C.floating,
            }}
          >
            <Text style={{ fontSize: 14, lineHeight: 20, color: C.text }}>
              {failure()!.permission
                ? tr(
                    'Allow Maka under Screen & System Audio Recording in System Settings, then take the screenshot again.',
                  )
                : tr('The screenshot failed: {reason}', { reason: failure()!.message })}
            </Text>
            <If when={failure()!.permission}>
              <Text style={hint()}>{tr('permissionSetup.helpBody')}</Text>
              <View style={{ flexDirection: 'row', gap: 8, marginVertical: 4 }}>
                <CardButton
                  label={tr('Open System Settings')}
                  primary
                  onPress={() => {
                    // The stage floats above System Settings, so it closes first.
                    props.finish();
                    void openUrl(SCREEN_RECORDING_SETTINGS);
                  }}
                />
                <CardButton
                  label={tr('permissionSetup.finder')}
                  onPress={() => {
                    // The stage closes itself once Finder shows Maka.
                    stage?.command('revealApplication');
                    void openUrl(SCREEN_RECORDING_SETTINGS);
                  }}
                />
              </View>
            </If>
            <Text style={hint()}>{tr('Press any key to close')}</Text>
          </View>
        </View>
      </If>
    </View>
  );
}

/** One frozen stage per display; finishing on any of them closes them all. */
function capture(preferences: Preferences) {
  const windows: WindowRef[] = [];
  const finish = () => windows.splice(0).forEach((window) => window.close());
  for (const display of displays()) {
    windows.push(
      Window.open(
        () => <Overlay screen={display.bounds.size} preferences={preferences} finish={finish} />,
        {
          id: `maka.screenshot.${display.id}`,
          kind: 'popup',
          title: tr('Capture a screen region'),
          display: display.id,
          defaultPosition: { x: display.bounds.origin.x, y: display.bounds.origin.y },
          defaultSize: { width: display.bounds.size.width, height: display.bounds.size.height },
          activate: false,
          level: 'aboveDock',
          transparent: true,
          shadow: false,
          closeOnBlur: false,
          closeOnEscape: false,
        },
      ),
    );
  }
}

function Screenshot(props: { input: QuickToolInput; settings: ScreenshotSettings }) {
  const { input, settings } = props;
  input.attach({
    items: () => [],
    entries: () => [
      {
        id: 'capture',
        title: tr('Capture a screen region'),
        icon: 'camera',
        keywords: [tr('screenshot keyword'), ...TERMS],
        run: () => {
          // The launcher floats above everything, so it has to be gone before the screen freezes.
          input.close();
          capture(settings.current());
        },
      },
    ],
  });
  return null;
}

export const activate: UiModule<JSX.Element>['activate'] = (context) => {
  effect(() => currentLocale.set(context.locale()));
  const settings = createSettings();
  return {
    exports: {
      tool: {
        kind: 'view',
        contract: quickToolView.id,
        render: ({ input }: UiEmbeddedViewProps<QuickToolInput, JSX.Element>) =>
          platform.os === 'macos' ? <Screenshot input={input} settings={settings} /> : null,
      },
      preferences: {
        kind: 'settings',
        render: () => <ScreenshotSettingsPage settings={settings} />,
      },
    },
  };
};
