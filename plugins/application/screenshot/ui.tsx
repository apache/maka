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
  host,
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
import { Button, Input } from 'nsh/base';
import { Icon } from '../../../products/maka/workbench/app/Icon';
import { C, textTooltip } from '../../../products/maka/workbench/app/ui';
import { currentWindow, displays, Window, type WindowRef } from 'nsh/desktop';
import type { UiEmbeddedViewProps, UiModule } from '../../../packages/plugin-sdk/src/workbench.js';
import {
  quickToolView,
  type QuickToolInput,
} from '../../../packages/plugin-sdk/src/workbench-views.js';
import { localizedKeywords, tr } from '../../../products/maka/workbench/app/locale';
import {
  COLORS,
  createSettings,
  ScreenshotSettingsPage,
  SIZES,
  type InkSize,
  type Preferences,
  type ScreenshotSettings,
} from './settings';

const terms = () =>
  localizedKeywords(
    ['screenshot', 'capture', 'snip', 'jietu', 'jt'],
    'launcher.keywords.screenshot',
  );

type Failure = { message: string; permission: boolean };
type Rect = { x: number; y: number; width: number; height: number };
type Size = { width: number; height: number };

const SCREEN_RECORDING_SETTINGS =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

/** The desktop shell's frozen display: it selects a region, takes marks on it, and copies, saves or pins it. */
const Stage = nativeComponent<
  {
    folder: string | null;
    pictureBoxes: boolean;
    viewport?: { id: string; bounds: Rect; scale: number; pictureBoxes: boolean } | null;
  },
  {
    ready: { elements: boolean };
    selection: Rect | null;
    done: null;
    cancel: null;
    saveCancelled: null;
    failed: Failure;
    text: { x: number; y: number };
  }
>('maka.screenshot', {
  props: ['folder', 'pictureBoxes', 'viewport'],
  events: ['ready', 'selection', 'done', 'cancel', 'saveCancelled', 'failed', 'text'],
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
  command(name: string, args?: Record<string, unknown>): void;
  focusCanvas(): void;
  selection: Rect;
  screen: Size;
  ink: Ink;
}) {
  const { tool, color, size } = props.ink;
  const command = props.command;
  const inked = () => tool() !== null && tool() !== 'mosaic';
  const at = () => place(props.selection, props.screen, BAR + (inked() ? GAP + INK_BAR : 0));
  return (
    <View
      onMouseUp={(event) => {
        if (event.button === 'left') props.focusCanvas();
      }}
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

function Overlay(props: {
  screen: Size;
  preferences: Preferences;
  freeze?: string;
  initialFailure?: Failure;
  scale: number;
  finish(): void;
  setVisible(visible: boolean): void;
}) {
  let stage: NativeComponentRef | undefined;
  let canvas: import('nsh').ViewRef | undefined;
  // The stage takes the keys without activating Maka, which would bring its main window forward.
  currentWindow().focus();
  const failure = signal<Failure | null>(props.initialFailure ?? null);
  const selection = signal<Rect | null>(null);
  const elements = signal(true);
  const textAt = signal<{ x: number; y: number } | null>(null);
  let draft = '';
  const settleText = (value?: string) => {
    if (textAt() === null) return;
    textAt.set(null);
    draft = '';
    if (value?.trim()) stage?.command('text', { value });
    else if (platform.os === 'windows') stage?.command('discardText');
  };
  const window = currentWindow();
  let saving = false;
  const resume = () => {
    if (!saving) return;
    saving = false;
    if (!props.preferences.folder) {
      props.setVisible(true);
      window.focus();
      canvas?.focus();
    }
  };
  const command = (name: string, args: Record<string, unknown> = {}) => {
    if (platform.os === 'windows') {
      if (saving) return;
      if (name === 'pin')
        args = {
          title: tr('Pin to screen'),
          copy: tr('Copy'),
          save: tr('Save'),
          close: tr('Close'),
        };
      settleText(draft);
      if (name === 'save') {
        saving = true;
        if (!props.preferences.folder) props.setVisible(false);
      }
    }
    stage?.command(name, args);
  };
  const viewport = () => {
    const bounds = window.state()?.nativeContentBounds;
    return props.freeze && bounds
      ? {
          id: props.freeze,
          bounds,
          scale: props.scale,
          pictureBoxes: props.preferences.pictureBoxes,
        }
      : null;
  };
  // The stage keeps the tool while the toolbar hides during a drag, so the choice lives here too.
  const ink: Ink = {
    tool: signal<Tool | null>(null),
    color: signal(props.preferences.color),
    size: signal(props.preferences.size),
  };
  return (
    <View
      style={{ flex: 1 }}
      captureKeys={platform.os === 'windows' ? (failure() ? 'all' : ['escape']) : 'none'}
      onKeyDown={(event) => {
        if (platform.os !== 'windows' || (!failure() && event.key !== 'Escape')) return;
        if (textAt() === null) props.finish();
        else {
          settleText();
          canvas?.focus();
        }
      }}
    >
      <Stage
        ref={(node) => (stage = node)}
        style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
        folder={props.preferences.folder}
        pictureBoxes={props.preferences.pictureBoxes}
        viewport={viewport()}
        onReady={(ready) => {
          elements.set(ready.elements);
          stage?.command('ink', { color: ink.color(), size: ink.size() });
        }}
        onSelection={(rect) => selection.set(rect)}
        onDone={props.finish}
        onCancel={props.finish}
        onSaveCancelled={resume}
        onFailed={(failed) => {
          resume();
          failure.set(failed);
        }}
        onText={(point) => textAt.set(point)}
      />
      <If when={platform.os === 'windows'}>
        <View
          style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
          focusable
          ref={(node) => {
            canvas = node;
            node?.focus();
          }}
          captureKeys={failure() ? 'all' : ['enter']}
          onKeyDown={(event) => {
            if (!failure() && event.key === 'Enter') command('copy');
          }}
          onStartShouldSetResponder={() => true}
          onResponderGrant={(event) => {
            settleText(draft);
            stage?.command('begin', { x: event.pageX, y: event.pageY });
          }}
          onResponderMove={(event) => stage?.command('move', { x: event.pageX, y: event.pageY })}
          onResponderRelease={(event) => stage?.command('end', { x: event.pageX, y: event.pageY })}
          onResponderTerminate={() => stage?.command('interrupt')}
          onMouseMove={(event) => {
            if (event.pressedButton === null && !selection())
              stage?.command('hover', event.pagePosition);
          }}
        />
      </If>
      <If when={textAt() !== null}>
        <Input
          autoFocus
          multiline
          submitBehavior="submit"
          onChange={({ value }) => {
            draft = value;
          }}
          onKeyPress={({ key }) => {
            if (platform.os === 'windows' && key === 'Escape') {
              settleText();
              canvas?.focus();
            }
          }}
          onSubmit={({ text }) => {
            settleText(text);
            canvas?.focus();
          }}
          style={{
            position: 'absolute',
            left: Math.max(0, Math.min(textAt()!.x, props.screen.width - 220)),
            top: Math.max(0, Math.min(textAt()!.y, props.screen.height - 52)),
            width: 220,
            height: 52,
            backgroundColor: C.floating,
            color: C.text,
          }}
        />
      </If>
      <If when={selection() !== null && failure() === null}>
        <Toolbar
          command={command}
          focusCanvas={() => canvas?.focus()}
          selection={selection()!}
          screen={props.screen}
          ink={ink}
        />
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
let capturing = false;

function capture(preferences: Preferences, freeze?: string, initialFailure?: Failure) {
  const windows: WindowRef[] = [];
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    windows.splice(0).forEach((window) => window.close());
    if (freeze) void host.call('screenshot.release', { id: freeze });
    capturing = false;
  };
  try {
    for (const display of displays()) {
      const window = Window.open(
        () => (
          <Overlay
            screen={display.bounds.size}
            preferences={preferences}
            freeze={freeze}
            initialFailure={initialFailure}
            scale={display.scaleFactor}
            finish={finish}
            setVisible={(visible) => {
              for (const window of windows) {
                if (visible) window.show();
                else window.hide();
              }
            }}
          />
        ),
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
      );
      windows.push(window);
      window.on('close', finish);
    }
    if (!windows.length) finish();
  } catch (error) {
    finish();
    throw error;
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
        keywords: [tr('screenshot keyword'), ...terms()],
        run: async () => {
          // The launcher floats above everything, so it has to be gone before the screen freezes.
          input.close();
          if (capturing) return;
          capturing = true;
          const preferences = settings.current();
          if (platform.os !== 'windows') {
            capture(preferences);
            return;
          }
          let id: unknown;
          try {
            id = await host.call('screenshot.capture', {});
            if (typeof id !== 'string') throw new Error('Missing screenshot identifier');
          } catch (error) {
            capture(preferences, undefined, { message: String(error), permission: false });
            return;
          }
          capture(preferences, id);
        },
      },
    ],
  });
  return null;
}

export const activate: UiModule<JSX.Element>['activate'] = () => {
  const settings = createSettings();
  return {
    exports: {
      tool: {
        kind: 'view',
        contract: quickToolView.id,
        render: ({ input }: UiEmbeddedViewProps<QuickToolInput, JSX.Element>) =>
          platform.os === 'macos' || platform.os === 'windows' ? (
            <Screenshot input={input} settings={settings} />
          ) : null,
      },
      preferences: {
        kind: 'settings',
        render: () => <ScreenshotSettingsPage settings={settings} />,
      },
    },
  };
};
